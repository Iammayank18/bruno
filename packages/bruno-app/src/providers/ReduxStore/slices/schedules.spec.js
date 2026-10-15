import { configureStore } from '@reduxjs/toolkit';
import schedulesReducer, {
  MAX_HISTORY_ROWS,
  scheduleEventReceived,
  loadSchedules,
  createSchedule,
  toggleSchedule,
  deleteSchedule,
  runScheduleNow,
  loadScheduleRuns,
  loadScheduleRunRequests
} from 'providers/ReduxStore/slices/schedules';

const COLLECTION_PATH = '/users/dev/demo-collection';

const makeStore = () => configureStore({ reducer: { schedules: schedulesReducer } });

const collectionState = (store, key = COLLECTION_PATH) => store.getState().schedules.byCollection[key];

const runFinished = (runId, overrides = {}) =>
  scheduleEventReceived({
    type: 'run-finished',
    scheduleId: 'schedule_1',
    collectionPath: COLLECTION_PATH,
    runId,
    trigger: 'schedule',
    status: 'pass',
    startedAt: 1000,
    finishedAt: 2000,
    duration: 1000,
    counts: { total: 1, passed: 1, failed: 0, error: 0, skipped: 0 },
    message: null,
    ...overrides
  });

describe('schedules slice', () => {
  beforeEach(() => {
    window.ipcRenderer = { invoke: jest.fn() };
  });

  it('stores loaded schedules under the posixified collection path', async () => {
    window.ipcRenderer.invoke.mockResolvedValueOnce([{ id: 'schedule_1', name: 'Nightly' }]);
    const store = makeStore();

    await store.dispatch(loadSchedules({ collectionPath: 'C:\\Users\\dev\\demo' }));

    expect(window.ipcRenderer.invoke).toHaveBeenCalledWith('renderer:schedule-list', 'C:\\Users\\dev\\demo');
    expect(collectionState(store, 'C:/Users/dev/demo').schedules).toEqual([{ id: 'schedule_1', name: 'Nightly' }]);
  });

  it('creates a schedule for the collection and replaces it when toggled', async () => {
    window.ipcRenderer.invoke
      .mockResolvedValueOnce({ id: 'schedule_1', enabled: true })
      .mockResolvedValueOnce({ id: 'schedule_1', enabled: false });
    const store = makeStore();

    await store.dispatch(createSchedule({ collectionPath: COLLECTION_PATH, schedule: { name: 'Nightly' } }));
    expect(window.ipcRenderer.invoke).toHaveBeenCalledWith('renderer:schedule-create', { name: 'Nightly', collectionPath: COLLECTION_PATH });

    await store.dispatch(toggleSchedule({ collectionPath: COLLECTION_PATH, scheduleId: 'schedule_1', enabled: false }));
    expect(collectionState(store).schedules).toEqual([{ id: 'schedule_1', enabled: false }]);
  });

  it('tracks a run from start to finish', () => {
    const store = makeStore();

    store.dispatch(scheduleEventReceived({ type: 'run-started', scheduleId: 'schedule_1', collectionPath: COLLECTION_PATH, runId: 11, trigger: 'schedule' }));
    expect(collectionState(store).live.schedule_1).toMatchObject({ running: true, runId: 11 });

    store.dispatch(scheduleEventReceived({ type: 'run-progress', scheduleId: 'schedule_1', collectionPath: COLLECTION_PATH, request: { status: 'completed' } }));
    expect(collectionState(store).live.schedule_1.request).toEqual({ status: 'completed' });

    store.dispatch(runFinished(11, { status: 'fail', counts: { total: 3, passed: 2, failed: 1, error: 0, skipped: 0 } }));
    expect(collectionState(store).live.schedule_1).toBeUndefined();
    expect(collectionState(store).runs.schedule_1).toEqual([
      expect.objectContaining({ id: 11, status: 'fail', total_requests: 3, failed_requests: 1, trigger_type: 'schedule' })
    ]);
  });

  it('does not add a history row for a run the database could not record', () => {
    const store = makeStore();
    store.dispatch(runFinished(null));
    expect(collectionState(store).runs.schedule_1).toBeUndefined();
  });

  it('keeps at most MAX_HISTORY_ROWS runs, newest first', () => {
    const store = makeStore();
    for (let runId = 1; runId <= MAX_HISTORY_ROWS + 10; runId++) {
      store.dispatch(runFinished(runId));
    }

    const runs = collectionState(store).runs.schedule_1;
    expect(runs).toHaveLength(MAX_HISTORY_ROWS);
    expect(runs[0].id).toBe(MAX_HISTORY_ROWS + 10);
  });

  it('removes a deleted schedule with its history and live state', async () => {
    window.ipcRenderer.invoke.mockResolvedValueOnce([{ id: 'schedule_1' }]).mockResolvedValueOnce(undefined);
    const store = makeStore();
    await store.dispatch(loadSchedules({ collectionPath: COLLECTION_PATH }));
    store.dispatch(runFinished(1));
    store.dispatch(scheduleEventReceived({ type: 'run-started', scheduleId: 'schedule_1', collectionPath: COLLECTION_PATH, runId: 2 }));

    await store.dispatch(deleteSchedule({ collectionPath: COLLECTION_PATH, scheduleId: 'schedule_1' }));

    expect(collectionState(store)).toMatchObject({ schedules: [], runs: {}, live: {} });
  });

  it('loads run history and request rows through their datastore channels', async () => {
    window.ipcRenderer.invoke
      .mockResolvedValueOnce([{ id: 11, status: 'pass' }])
      .mockResolvedValueOnce([{ id: 1, run_id: 11, request_name: 'Health' }]);
    const store = makeStore();

    await store.dispatch(loadScheduleRuns({ collectionPath: COLLECTION_PATH, scheduleId: 'schedule_1' }));
    await store.dispatch(loadScheduleRunRequests({ collectionPath: COLLECTION_PATH, runId: 11 }));

    expect(window.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, 'datastore:scheduled_runs:list_scheduled_runs_for_schedule', {
      schedule_id: 'schedule_1',
      limit: MAX_HISTORY_ROWS
    });
    expect(window.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, 'datastore:scheduled_runs:list_scheduled_run_requests', { run_id: 11 });
    expect(collectionState(store).runs.schedule_1).toEqual([{ id: 11, status: 'pass' }]);
    expect(collectionState(store).runRequests[11]).toEqual([{ id: 1, run_id: 11, request_name: 'Health' }]);
  });

  it('rejects run-now when the main process refuses it', async () => {
    window.ipcRenderer.invoke.mockResolvedValueOnce({ success: false, error: 'This schedule is already running' });
    const store = makeStore();

    const result = await store.dispatch(runScheduleNow({ scheduleId: 'schedule_1' }));

    expect(result.error.message).toBe('This schedule is already running');
  });
});
