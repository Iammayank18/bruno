const path = require('node:path');
const axios = require('axios');
const { cloneDeep } = require('lodash');
const { Cron } = require('croner');
const { Notification } = require('electron');
const { getRunnerSummary } = require('@usebruno/common/runner');
const { getSchedulesStore } = require('../../store/schedules');
const { decryptStringSafe } = require('../../utils/encryption');
const { posixifyPath } = require('../../utils/filesystem');
const { findItemInCollection } = require('../../utils/collection');
const { getStatements, transaction } = require('../sqlite');
const snapshotManager = require('../snapshot');
const { runCollection } = require('../runner/run-collection');
const { createRunnerHooks } = require('../../ipc/network/runner-hooks');
const { createRunnerStateSync } = require('../../ipc/network/runner-state-sync');
const { extractPromptVariablesForRequest } = require('../../ipc/network/prompt-variables');
const { configureRequest, executeRequestOnFailHandler } = require('../../ipc/network');
const { loadCollectionFromDisk, prepareRunContext, cleanupRunContext } = require('./collection-loader');

const WEBHOOK_TIMEOUT_MS = 10000;
const DEFAULT_RETENTION = 100;
// setTimeout overflows above 2^31-1 ms (~24.8 days) and fires immediately.
const MAX_TIMER_DELAY_MS = 2147483647;
const MAX_STORED_BODY_LENGTH = 256 * 1024;

const EMPTY_SUMMARY = {
  totalRequests: 0,
  passedRequests: 0,
  failedRequests: 0,
  errorRequests: 0,
  skippedRequests: 0
};

const errorResult = (message) => ({ status: 'error', summary: { ...EMPTY_SUMMARY }, requests: [], message });

const intOrNull = (value) => (Number.isFinite(value) ? value : null);

const jsonOrNull = (value, maxLength) => {
  if (value === null || value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return maxLength && json.length > maxLength ? json.slice(0, maxLength) : json;
  } catch (err) {
    return null;
  }
};

const relativeRequestPath = (collection, pathname) => posixifyPath(path.relative(collection.pathname, pathname));

/**
 * Runs schedules while the app is open. Scheduled runs load the collection from disk and
 * report on `main:schedule-event` and into SQLite history, never on the renderer's
 * `main:run-folder-event` stream, so they can't disturb a manual run in progress.
 */
class SchedulerService {
  constructor() {
    this.timers = new Map();
    this.running = new Set();
    this.mainWindow = null;
    this.started = false;
  }

  get store() {
    return getSchedulesStore();
  }

  start(mainWindow) {
    if (this.started) return;
    this.started = true;
    this.mainWindow = mainWindow;

    this.recoverInterruptedRuns();
    for (const schedule of this.store.getAll()) {
      if (schedule.enabled) {
        this.arm(schedule.id);
      }
    }
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.started = false;
  }

  emitScheduleEvent(payload) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('main:schedule-event', payload);
    }
  }

  nextRuns(cron, count = 3) {
    try {
      const runs = new Cron(cron).nextRuns(Math.min(Math.max(Number(count) || 3, 1), 10)) || [];
      return runs.map((date) => date.toISOString());
    } catch (err) {
      return [];
    }
  }

  disarm(scheduleId) {
    clearTimeout(this.timers.get(scheduleId));
    this.timers.delete(scheduleId);
  }

  arm(scheduleId) {
    this.disarm(scheduleId);

    const schedule = this.store.get(scheduleId);
    if (!this.started || !schedule || !schedule.enabled) {
      return;
    }

    let nextRun;
    try {
      nextRun = new Cron(schedule.cron).nextRun();
    } catch (err) {
      console.error(`[scheduler] invalid cron for schedule ${scheduleId}: ${schedule.cron}`, err.message);
      return;
    }
    if (!nextRun) {
      return;
    }

    const delay = Math.max(0, nextRun.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(scheduleId);
      if (delay <= MAX_TIMER_DELAY_MS) {
        this.executeSchedule(scheduleId, 'schedule');
      }
      this.arm(scheduleId);
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timer.unref?.();

    this.timers.set(scheduleId, timer);
  }

  async runNow(scheduleId) {
    if (!this.store.get(scheduleId)) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    if (this.running.has(scheduleId)) {
      throw new Error('This schedule is already running');
    }
    return this.executeSchedule(scheduleId, 'manual');
  }

  async testWebhook(webhookUrl, webhookHeaders) {
    let headers = webhookHeaders || {};
    if (typeof headers === 'string') {
      try {
        headers = JSON.parse(headers);
      } catch (err) {
        throw new Error('Webhook headers must be a JSON object');
      }
    }
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new Error('Webhook headers must be a JSON object');
    }

    await axios.post(
      webhookUrl,
      { text: 'Bruno scheduler test notification', source: 'bruno-scheduler', kind: 'test' },
      { headers, timeout: WEBHOOK_TIMEOUT_MS }
    );
    return { success: true };
  }

  async executeSchedule(scheduleId, trigger) {
    const schedule = this.store.get(scheduleId);
    if (!schedule || this.running.has(scheduleId)) {
      return { success: false, error: schedule ? 'This schedule is already running' : 'Schedule not found' };
    }
    this.running.add(scheduleId);

    try {
      const startedAt = Date.now();
      const runId = this.insertRunRow(schedule, trigger, startedAt);
      const eventBase = { scheduleId, collectionPath: schedule.collectionPath, runId, trigger, startedAt };

      this.emitScheduleEvent({ type: 'run-started', ...eventBase });

      let result;
      try {
        result = await this.runCollectionForSchedule(schedule, trigger);
      } catch (error) {
        console.error(`[scheduler] run failed for schedule ${scheduleId}:`, error);
        result = errorResult(error.message || 'Scheduled run failed');
      }

      const finishedAt = Date.now();
      const duration = finishedAt - startedAt;

      if (runId) {
        this.finishRunRow(runId, { ...result, duration, finishedAt });
        this.pruneRetention(schedule);
      }

      if (result.status !== 'pass') {
        this.notifyFailure(schedule, { ...result, runId, duration });
      }

      this.emitScheduleEvent({
        type: 'run-finished',
        ...eventBase,
        status: result.status,
        counts: {
          total: result.summary.totalRequests,
          passed: result.summary.passedRequests,
          failed: result.summary.failedRequests,
          error: result.summary.errorRequests,
          skipped: result.summary.skippedRequests
        },
        duration,
        finishedAt,
        message: result.message || null
      });

      return { success: true, runId, status: result.status };
    } finally {
      this.running.delete(scheduleId);
    }
  }

  async runCollectionForSchedule(schedule, trigger) {
    const collection = await loadCollectionFromDisk(schedule.collectionPath);
    const workspacePathname = snapshotManager.getCollection(schedule.collectionPath)?.workspacePathname || null;
    const { environment } = await prepareRunContext({ collection, environmentName: schedule.environment, workspacePathname });

    try {
      return await this.runTarget(schedule, trigger, collection, environment);
    } finally {
      cleanupRunContext(collection);
    }
  }

  findFolder(collection, folderPath) {
    const wanted = path.posix.normalize(posixifyPath(folderPath));
    const search = (items) => {
      for (const item of items || []) {
        if (item.type !== 'folder') continue;
        if (relativeRequestPath(collection, item.pathname) === wanted) return item;
        const nested = search(item.items);
        if (nested) return nested;
      }
      return null;
    };
    return search(collection.items);
  }

  // The renderer and this disk-loaded tree assign different uids to the same request,
  // so schedules target requests by path relative to the collection.
  resolveRequestUids(collection, requestPaths) {
    const wanted = new Set(requestPaths.map((p) => path.posix.normalize(posixifyPath(p))));
    const uids = [];
    const visit = (items) => {
      for (const item of items || []) {
        if (item.type === 'folder') {
          visit(item.items);
        } else if (wanted.has(relativeRequestPath(collection, item.pathname))) {
          uids.push(item.uid);
        }
      }
    };
    visit(collection.items);

    if (uids.length > 0 && uids.length < wanted.size) {
      console.warn(`[scheduler] ${wanted.size - uids.length} scheduled request(s) not found in ${collection.pathname}; running the ${uids.length} that matched`);
    }
    return uids;
  }

  async runTarget(schedule, trigger, collection, environment) {
    let folder = null;
    if (schedule.folderPath) {
      folder = this.findFolder(collection, schedule.folderPath);
      if (!folder) {
        return errorResult(`Folder not found: ${schedule.folderPath}`);
      }
    }

    let selectedRequestUids = null;
    if (schedule.requestPaths?.length > 0) {
      selectedRequestUids = this.resolveRequestUids(collection, schedule.requestPaths);
      if (selectedRequestUids.length === 0) {
        return errorResult('None of the scheduled requests were found in the collection (renamed or deleted?)');
      }
    }

    const runtimeVariables = {};
    for (const variable of this.store.decryptVariables(schedule.variables || [])) {
      if (variable.enabled && variable.name) {
        runtimeVariables[variable.name] = variable.value;
      }
    }

    // Run-folder events carry only the itemUid after `request-queued`, so, like the
    // renderer's runner reducer, track the current request and finalize its row when
    // the next one is queued or the run ends.
    const requests = [];
    let current = null;

    const flushCurrent = () => {
      if (!current) return;
      const item = findItemInCollection(collection, current.itemUid);
      const anyFailed = [current.testResults, current.preRequestTestResults, current.postResponseTestResults]
        .flat()
        .some((r) => r && (r.isScriptError || r.status !== 'pass'))
        || (current.assertionResults || []).some((r) => r.status !== 'pass');

      requests.push({
        name: item?.name || null,
        path: item?.pathname ? relativeRequestPath(collection, item.pathname) : null,
        status: current.status === 'completed' ? (anyFailed ? 'fail' : 'pass') : current.status,
        statusCode: current.statusCode ?? null,
        duration: current.duration ?? 0,
        errorMessage: current.errorMessage || null,
        requestSent: current.requestSent || null,
        responseReceived: current.responseReceived || null,
        testResults: current.testResults || [],
        preRequestTestResults: current.preRequestTestResults || [],
        postResponseTestResults: current.postResponseTestResults || [],
        assertionResults: current.assertionResults || []
      });
      current = null;
    };

    const resultFields = {
      'test-results': 'testResults',
      'test-results-pre-request': 'preRequestTestResults',
      'test-results-post-response': 'postResponseTestResults',
      'assertion-results': 'assertionResults'
    };

    const emitRunFolderEvent = (payload) => {
      const { type, itemUid } = payload;

      if (type === 'request-queued') {
        flushCurrent();
        current = { itemUid, status: 'queued' };
        return;
      }
      if (type === 'testrun-ended') {
        flushCurrent();
        return;
      }
      if (!current || current.itemUid !== itemUid) {
        return;
      }

      if (type === 'request-sent') {
        current.status = 'running';
        current.requestSent = payload.requestSent;
      } else if (type === 'response-received') {
        current.status = 'completed';
        current.responseReceived = payload.responseReceived;
        current.statusCode = payload.responseReceived?.status ?? null;
        current.duration = payload.responseReceived?.responseTime ?? 0;
      } else if (type === 'runner-request-skipped') {
        current.status = 'skipped';
        current.errorMessage = payload.error || null;
      } else if (type === 'error') {
        current.status = 'error';
        current.errorMessage = payload.error || 'An error occurred while running the request';
      } else if (resultFields[type]) {
        current[resultFields[type]] = payload[resultFields[type]];
      }

      if (type === 'response-received' || type === 'runner-request-skipped' || type === 'error') {
        this.emitScheduleEvent({
          type: 'run-progress',
          scheduleId: schedule.id,
          collectionPath: schedule.collectionPath,
          trigger,
          request: {
            status: current.status,
            statusCode: current.statusCode ?? null,
            errorMessage: current.errorMessage || null
          }
        });
      }
    };

    // Cookie, credential and variable pushes are renderer UI state; scheduled runs keep
    // only the in-process effects (collection variables, oauth2 cache resets).
    const noopEmit = () => {};
    const onConsoleLog = (type, args) => console[type]?.(...args);
    const { sendVariableUpdates, resetOauth2Credentials } = createRunnerStateSync({ emit: noopEmit });
    const { runPreRequest, runPostResponse } = createRunnerHooks({ onConsoleLog, sendVariableUpdates, resetOauth2Credentials, emit: noopEmit });

    await runCollection({
      folder,
      collection: cloneDeep(collection),
      environment,
      runtimeVariables,
      recursive: schedule.recursive !== false,
      delay: 0,
      tags: null,
      selectedRequestUids,
      deps: {
        emitRunFolderEvent,
        emit: noopEmit,
        onConsoleLog,
        notifyScriptExecution: () => {},
        sendVariableUpdates,
        resetOauth2Credentials,
        sendRunnerRequestSent: async ({ requestSent, eventData }) => {
          const { url, method, headers, data } = requestSent;
          emitRunFolderEvent({ type: 'request-sent', requestSent: { url, method, headers, data }, ...eventData });
        },
        sendRunnerResponseReceived: async ({ responseReceived, eventData }) => {
          const { status, statusText, responseTime, headers, data } = responseReceived;
          emitRunFolderEvent({ type: 'response-received', responseReceived: { status, statusText, responseTime, headers, data }, ...eventData });
        },
        extractPromptVariablesForRequest,
        runRequest: async () => {
          throw new Error('bru.runRequest is not supported in scheduled runs');
        },
        configureRequest,
        executeRequestOnFailHandler,
        runPreRequest,
        runPostResponse
      }
    });

    const summary = getRunnerSummary(requests);
    return {
      status: summary.failedRequests + summary.errorRequests > 0 ? 'fail' : 'pass',
      summary,
      requests,
      message: null
    };
  }

  insertRunRow(schedule, trigger, startedAt) {
    try {
      const result = getStatements().execute('insert_scheduled_run', {
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        collection_path: schedule.collectionPath,
        trigger_type: trigger,
        started_at: startedAt
      });
      return Number(result.lastInsertRowid);
    } catch (err) {
      console.warn('[scheduler] failed to record run start', err.message);
      return null;
    }
  }

  finishRunRow(runId, { status, summary, requests, duration, finishedAt, message }) {
    try {
      transaction(() => {
        getStatements().execute('finish_scheduled_run', {
          id: runId,
          finished_at: finishedAt,
          duration: intOrNull(duration),
          status,
          total_requests: summary.totalRequests,
          passed_requests: summary.passedRequests,
          failed_requests: summary.failedRequests,
          error_requests: summary.errorRequests,
          skipped_requests: summary.skippedRequests,
          message: message ?? null
        });

        for (const request of requests) {
          const { requestSent, responseReceived } = request;
          getStatements().execute('insert_scheduled_run_request', {
            run_id: runId,
            request_name: request.name,
            request_path: request.path,
            status: request.status ?? null,
            status_code: intOrNull(request.statusCode),
            duration: intOrNull(request.duration),
            error_message: request.errorMessage,
            request_method: requestSent?.method ?? null,
            request_url: requestSent?.url ?? null,
            request_headers: jsonOrNull(requestSent?.headers),
            request_body: jsonOrNull(requestSent?.data, MAX_STORED_BODY_LENGTH),
            response_headers: jsonOrNull(responseReceived?.headers),
            response_body: jsonOrNull(responseReceived?.data, MAX_STORED_BODY_LENGTH),
            test_results: jsonOrNull([...request.preRequestTestResults, ...request.postResponseTestResults, ...request.testResults]),
            assertion_results: jsonOrNull(request.assertionResults)
          });
        }
      });
    } catch (err) {
      console.warn('[scheduler] failed to record run completion', err.message);
    }
  }

  pruneRetention(schedule) {
    try {
      getStatements().execute('prune_scheduled_runs_keep', {
        schedule_id: schedule.id,
        keep: schedule.retention || DEFAULT_RETENTION
      });
    } catch (err) {
      console.warn('[scheduler] failed to prune run history', err.message);
    }
  }

  // Runs still marked `running` at startup were cut short by a quit or crash.
  recoverInterruptedRuns() {
    try {
      const rows = getStatements().execute('list_running_scheduled_runs');
      for (const row of rows) {
        getStatements().execute('finish_scheduled_run', {
          id: row.id,
          finished_at: Date.now(),
          duration: null,
          status: 'error',
          total_requests: 0,
          passed_requests: 0,
          failed_requests: 0,
          error_requests: 0,
          skipped_requests: 0,
          message: 'Interrupted by app restart'
        });
      }
    } catch (err) {
      console.warn('[scheduler] failed to recover interrupted runs', err.message);
    }
  }

  notifyFailure(schedule, run) {
    const failedCount = run.summary.failedRequests + run.summary.errorRequests;

    if (schedule.notify?.os !== false && Notification.isSupported() && this.mainWindow && !this.mainWindow.isDestroyed() && !this.mainWindow.isFocused()) {
      new Notification({
        title: `Scheduled run failed: ${schedule.name}`,
        body: run.message || `${failedCount} request(s) failed`
      }).show();
    }

    const webhookUrl = schedule.notify?.webhookUrl;
    if (!webhookUrl) return;

    let headers = {};
    if (schedule.notify.webhookHeaders) {
      try {
        headers = JSON.parse(decryptStringSafe(schedule.notify.webhookHeaders).value || '{}');
      } catch (err) {
        console.warn('[scheduler] failed to decrypt webhook headers', err.message);
      }
    }

    // Only names and outcomes leave the machine; request and response payloads can hold credentials.
    const failedRequests = run.requests
      .filter((request) => request.status === 'fail' || request.status === 'error')
      .map(({ name, path: requestPath, status, statusCode, errorMessage }) => ({ name, path: requestPath, status, statusCode, errorMessage }));

    axios
      .post(
        webhookUrl,
        {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          runId: run.runId,
          status: run.status,
          counts: {
            total: run.summary.totalRequests,
            passed: run.summary.passedRequests,
            failed: run.summary.failedRequests,
            error: run.summary.errorRequests,
            skipped: run.summary.skippedRequests
          },
          duration: run.duration,
          message: run.message || null,
          failedRequests
        },
        { headers, timeout: WEBHOOK_TIMEOUT_MS }
      )
      .catch((err) => {
        console.warn('[scheduler] webhook notification failed', err.message);
      });
  }
}

const schedulerService = new SchedulerService();

module.exports = { schedulerService, SchedulerService };
