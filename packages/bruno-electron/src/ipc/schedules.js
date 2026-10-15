const { ipcMain } = require('electron');
const { getSchedulesStore } = require('../store/schedules');
const { schedulerService } = require('../services/scheduler');
const { getStatements } = require('../services/sqlite');

const requireNonEmptyString = (value, name) => {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
};

const requireObject = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
};

const syncTimer = (schedule) => {
  if (schedule.enabled) {
    schedulerService.arm(schedule.id);
  } else {
    schedulerService.disarm(schedule.id);
  }
  return schedule;
};

const registerSchedulesIpc = () => {
  const store = getSchedulesStore();

  ipcMain.handle('renderer:schedule-list', (_event, collectionPath) => {
    return store.getByCollectionPath(requireNonEmptyString(collectionPath, 'collectionPath'));
  });

  ipcMain.handle('renderer:schedule-create', (_event, schedule) => {
    return syncTimer(store.create(requireObject(schedule, 'schedule')));
  });

  ipcMain.handle('renderer:schedule-update', (_event, scheduleId, updates) => {
    return syncTimer(store.update(requireNonEmptyString(scheduleId, 'scheduleId'), requireObject(updates, 'updates')));
  });

  ipcMain.handle('renderer:schedule-toggle', (_event, scheduleId, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }
    return syncTimer(store.update(requireNonEmptyString(scheduleId, 'scheduleId'), { enabled }));
  });

  ipcMain.handle('renderer:schedule-delete', (_event, scheduleId) => {
    requireNonEmptyString(scheduleId, 'scheduleId');
    schedulerService.disarm(scheduleId);
    store.delete(scheduleId);
    try {
      getStatements().execute('delete_scheduled_runs_for_schedule', { schedule_id: scheduleId });
    } catch (err) {
      console.warn('[scheduler] failed to delete run history', err.message);
    }
  });

  ipcMain.handle('renderer:schedule-run-now', async (_event, scheduleId) => {
    try {
      return await schedulerService.runNow(requireNonEmptyString(scheduleId, 'scheduleId'));
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('renderer:schedule-next-runs', (_event, cron, count) => {
    return schedulerService.nextRuns(requireNonEmptyString(cron, 'cron'), count);
  });

  ipcMain.handle('renderer:schedule-test-webhook', (_event, webhookUrl, webhookHeaders) => {
    if (typeof webhookUrl !== 'string' || !/^https?:\/\//i.test(webhookUrl)) {
      throw new Error('webhookUrl must be an http(s) URL');
    }
    return schedulerService.testWebhook(webhookUrl, webhookHeaders);
  });
};

module.exports = { registerSchedulesIpc };
