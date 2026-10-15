const { ipcMain } = require('electron');
const { getStatements } = require('../services/sqlite');
const { readRunnerExchange, clearRunnerResponses } = require('../services/runner-exchange');

const MAX_SCHEDULED_RUNS = 1000;

const requireUid = (value, name) => {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
};

const registerSqliteIpc = () => {
  ipcMain.handle('datastore:file-index:file_index_size', () => {
    return getStatements().execute('file_index_size');
  });

  ipcMain.handle('datastore:file-index:file_index_clear', () => {
    return getStatements().execute('file_index_clear');
  });

  ipcMain.handle('datastore:runner_responses:get_runner_response', (_event, params) => {
    const request_uid = requireUid(params?.request_uid, 'request_uid');
    return readRunnerExchange(request_uid);
  });

  ipcMain.handle('datastore:runner_responses:delete_runner_responses_for_collection', (_event, params) => {
    const collection_uid = requireUid(params?.collection_uid, 'collection_uid');
    return clearRunnerResponses(collection_uid);
  });

  ipcMain.handle('datastore:scheduled_runs:list_scheduled_runs_for_schedule', (_event, params) => {
    const schedule_id = requireUid(params?.schedule_id, 'schedule_id');
    const limit = Math.min(Math.max(Number(params?.limit) || MAX_SCHEDULED_RUNS, 1), MAX_SCHEDULED_RUNS);
    return getStatements().execute('list_scheduled_runs_for_schedule', { schedule_id, limit });
  });

  ipcMain.handle('datastore:scheduled_runs:list_scheduled_run_requests', (_event, params) => {
    const run_id = params?.run_id;
    if (!Number.isInteger(run_id)) {
      throw new Error('run_id must be an integer');
    }
    return getStatements().execute('list_scheduled_run_requests', { run_id });
  });
};

module.exports = { registerSqliteIpc };
