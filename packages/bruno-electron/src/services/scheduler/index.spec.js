const mockNotificationShow = jest.fn();
const mockStatements = { execute: jest.fn() };
const mockSchedules = new Map();

jest.mock('electron', () => ({
  Notification: Object.assign(jest.fn(() => ({ show: mockNotificationShow })), { isSupported: () => true })
}));
jest.mock('axios', () => ({ post: jest.fn(() => Promise.resolve()) }));
jest.mock('../sqlite', () => ({
  getStatements: () => mockStatements,
  transaction: (fn) => fn()
}));
jest.mock('../snapshot', () => ({ getCollection: jest.fn(() => null) }));
jest.mock('../../ipc/network', () => ({ configureRequest: jest.fn(), executeRequestOnFailHandler: jest.fn() }));
jest.mock('../../utils/encryption', () => ({ decryptStringSafe: (value) => ({ value }) }));
jest.mock('../../store/schedules', () => ({
  getSchedulesStore: () => ({
    getAll: () => [...mockSchedules.values()],
    get: (id) => mockSchedules.get(id),
    decryptVariables: (variables) => variables
  })
}));
jest.mock('./collection-loader', () => ({
  loadCollectionFromDisk: jest.fn(),
  prepareRunContext: jest.fn(async () => ({ environment: null })),
  cleanupRunContext: jest.fn()
}));
jest.mock('../runner/run-collection', () => ({ runCollection: jest.fn() }));

const axios = require('axios');
const { runCollection } = require('../runner/run-collection');
const { loadCollectionFromDisk, cleanupRunContext } = require('./collection-loader');
const { SchedulerService } = require('./index');

const collection = {
  uid: 'col-1',
  pathname: '/collections/api',
  items: [
    { uid: 'r1', name: 'List users', type: 'http-request', pathname: '/collections/api/users/list.bru' },
    { uid: 'r2', name: 'Create user', type: 'http-request', pathname: '/collections/api/users/create.bru' }
  ]
};

const addSchedule = (overrides = {}) => {
  const schedule = {
    id: 's1',
    name: 'Nightly',
    collectionPath: '/collections/api',
    cron: '*/5 * * * *',
    enabled: true,
    retention: 10,
    variables: [],
    notify: { os: true, webhookUrl: null },
    ...overrides
  };
  mockSchedules.set(schedule.id, schedule);
  return schedule;
};

// Replays what the runner emits for one request.
const emitRequest = (emit, deps, itemUid, { status = 200, tests = [], networkError } = {}) => {
  emit({ type: 'request-queued', itemUid });
  deps.sendRunnerRequestSent({ requestSent: { url: 'http://x', method: 'GET', headers: { a: '1' }, data: null }, eventData: { itemUid } });
  if (networkError) {
    emit({ type: 'error', itemUid, error: networkError });
    return;
  }
  deps.sendRunnerResponseReceived({ responseReceived: { status, responseTime: 5, headers: {}, data: { ok: true } }, eventData: { itemUid } });
  if (tests.length) emit({ type: 'test-results', itemUid, testResults: tests });
};

describe('SchedulerService', () => {
  let service;
  let mainWindow;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSchedules.clear();
    mockStatements.execute.mockImplementation((name) => {
      if (name === 'insert_scheduled_run') return { lastInsertRowid: 7 };
      if (name === 'list_running_scheduled_runs') return [];
      return undefined;
    });
    loadCollectionFromDisk.mockResolvedValue(collection);
    mainWindow = { isDestroyed: () => false, isFocused: () => false, webContents: { send: jest.fn() } };
    service = new SchedulerService();
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const sentEvents = () => mainWindow.webContents.send.mock.calls.filter(([channel]) => channel === 'main:schedule-event').map(([, e]) => e);
  const executedWith = (name) => mockStatements.execute.mock.calls.filter(([n]) => n === name).map(([, params]) => params);

  describe('timers', () => {
    it('arms enabled schedules on start and marks interrupted runs once', () => {
      mockStatements.execute.mockImplementation((name) => (name === 'list_running_scheduled_runs' ? [{ id: 3 }] : undefined));
      addSchedule();
      addSchedule({ id: 's2', enabled: false });

      service.start(mainWindow);
      service.arm('s1');

      expect([...service.timers.keys()]).toEqual(['s1']);
      expect(executedWith('finish_scheduled_run')).toEqual([expect.objectContaining({ id: 3, status: 'error', message: 'Interrupted by app restart' })]);
    });

    it('does not arm before the service starts', () => {
      addSchedule();
      service.arm('s1');
      expect(service.timers.size).toBe(0);
    });

    it('waits out schedules further away than the maximum timer delay without running them', () => {
      jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00') });
      addSchedule({ cron: '0 0 1 6 *' });
      const execute = jest.spyOn(service, 'executeSchedule').mockResolvedValue();

      service.start(mainWindow);
      jest.advanceTimersByTime(2147483647);

      expect(execute).not.toHaveBeenCalled();
      expect(service.timers.has('s1')).toBe(true);
    });

    it('runs a due schedule and re-arms it', () => {
      jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00') });
      addSchedule();
      const execute = jest.spyOn(service, 'executeSchedule').mockResolvedValue();

      service.start(mainWindow);
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(execute).toHaveBeenCalledWith('s1', 'schedule');
      expect(service.timers.has('s1')).toBe(true);
    });

    it('previews the next runs and returns nothing for an invalid pattern', () => {
      expect(service.nextRuns('*/5 * * * *', 2)).toHaveLength(2);
      expect(service.nextRuns('not a cron')).toEqual([]);
    });
  });

  describe('runs', () => {
    it('folds runner events into request rows, records them and reports the outcome', async () => {
      addSchedule({ variables: [{ name: 'token', value: 'abc', enabled: true }, { name: 'off', value: 'x', enabled: false }] });
      runCollection.mockImplementation(async ({ deps, runtimeVariables }) => {
        expect(runtimeVariables).toEqual({ token: 'abc' });
        const emit = deps.emitRunFolderEvent;
        emitRequest(emit, deps, 'r1');
        emitRequest(emit, deps, 'r2', { status: 500, tests: [{ status: 'fail', description: 'is 201' }] });
        emit({ type: 'testrun-ended' });
      });

      service.start(mainWindow);
      const result = await service.runNow('s1');

      expect(result).toEqual({ success: true, runId: 7, status: 'fail' });
      expect(executedWith('finish_scheduled_run')[0]).toMatchObject({ id: 7, status: 'fail', total_requests: 2, passed_requests: 1, failed_requests: 1 });
      expect(executedWith('insert_scheduled_run_request')).toEqual([
        expect.objectContaining({ request_name: 'List users', request_path: 'users/list.bru', status: 'pass', status_code: 200, request_method: 'GET' }),
        expect.objectContaining({ request_name: 'Create user', status: 'fail', status_code: 500, test_results: JSON.stringify([{ status: 'fail', description: 'is 201' }]) })
      ]);
      expect(executedWith('prune_scheduled_runs_keep')).toEqual([{ schedule_id: 's1', keep: 10 }]);
      expect(sentEvents().map((e) => e.type)).toEqual(['run-started', 'run-progress', 'run-progress', 'run-finished']);
      expect(sentEvents().at(-1)).toMatchObject({ status: 'fail', trigger: 'manual', counts: { total: 2, passed: 1, failed: 1 } });
      expect(mockNotificationShow).toHaveBeenCalled();
      expect(cleanupRunContext).toHaveBeenCalledWith(collection);
    });

    it('targets saved request paths and fails when none of them exist', async () => {
      addSchedule({ requestPaths: ['users/create.bru'] });
      runCollection.mockResolvedValue();
      service.start(mainWindow);

      await service.runNow('s1');
      expect(runCollection.mock.calls[0][0].selectedRequestUids).toEqual(['r2']);

      addSchedule({ requestPaths: ['gone.bru'] });
      const result = await service.runNow('s1');
      expect(result.status).toBe('error');
      expect(executedWith('finish_scheduled_run').at(-1).message).toMatch(/renamed or deleted/);
      expect(cleanupRunContext).toHaveBeenCalledTimes(2);
    });

    it('records a run that throws as an error and frees the schedule', async () => {
      addSchedule();
      loadCollectionFromDisk.mockRejectedValue(new Error('bruno.json not found'));
      service.start(mainWindow);

      const result = await service.runNow('s1');

      expect(result.status).toBe('error');
      expect(executedWith('finish_scheduled_run')[0]).toMatchObject({ status: 'error', message: 'bruno.json not found' });
      expect(service.running.size).toBe(0);
    });

    it('rejects a run while the same schedule is running', async () => {
      addSchedule();
      let finish;
      runCollection.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
      service.start(mainWindow);

      const first = service.runNow('s1');
      await new Promise((resolve) => setImmediate(resolve));
      await expect(service.runNow('s1')).rejects.toThrow('This schedule is already running');

      finish();
      await first;
    });

    it('still runs and reports when the database is unavailable', async () => {
      addSchedule();
      mockStatements.execute.mockImplementation(() => {
        throw new Error('database unavailable');
      });
      runCollection.mockResolvedValue();
      service.start(mainWindow);

      const result = await service.runNow('s1');

      expect(result).toEqual({ success: true, runId: null, status: 'pass' });
      expect(sentEvents().at(-1)).toMatchObject({ type: 'run-finished', status: 'pass' });
    });

    it('posts failures to the webhook without request or response payloads', async () => {
      addSchedule({ notify: { os: false, webhookUrl: 'https://hooks.example.com', webhookHeaders: '{"X-Key":"k"}' } });
      runCollection.mockImplementation(async ({ deps }) => {
        emitRequest(deps.emitRunFolderEvent, deps, 'r1', { networkError: 'ECONNREFUSED' });
        deps.emitRunFolderEvent({ type: 'testrun-ended' });
      });
      service.start(mainWindow);

      await service.runNow('s1');

      expect(mockNotificationShow).not.toHaveBeenCalled();
      const [url, body, options] = axios.post.mock.calls[0];
      expect(url).toBe('https://hooks.example.com');
      expect(options.headers).toEqual({ 'X-Key': 'k' });
      expect(body).toMatchObject({ scheduleId: 's1', status: 'fail', counts: { error: 1 } });
      expect(body.failedRequests).toEqual([
        { name: 'List users', path: 'users/list.bru', status: 'error', statusCode: null, errorMessage: 'ECONNREFUSED' }
      ]);
    });
  });
});
