import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { addTab, updateTabMeta } from 'providers/ReduxStore/slices/tabs';

export const MAX_HISTORY_ROWS = 200;

const initialState = {
  byCollection: {}
};

export const collectionKey = (collectionPath) => (collectionPath || '').replace(/\\/g, '/');

const getCollectionState = (state, collectionPath) => {
  const key = collectionKey(collectionPath);
  if (!state.byCollection[key]) {
    state.byCollection[key] = { schedules: [], runs: {}, runRequests: {}, live: {} };
  }
  return state.byCollection[key];
};

const replaceSchedule = (state, { collectionPath, schedule }) => {
  const collection = getCollectionState(state, collectionPath);
  const index = collection.schedules.findIndex((s) => s.id === schedule.id);
  if (index >= 0) {
    collection.schedules[index] = schedule;
  }
};

// Collection and folder entry points share one tab; a folder scopes it by pathname.
export const openSchedulesTab = ({ collectionUid, folderPathname = null }) => (dispatch, getState) => {
  dispatch(addTab({ uid: `${collectionUid}-collection-schedules`, collectionUid, type: 'collection-schedules' }));
  dispatch(updateTabMeta({ uid: getState().tabs.activeTabUid, pathname: folderPathname }));
};

export const loadSchedules = createAsyncThunk('schedules/load', async ({ collectionPath }) => {
  const schedules = await window.ipcRenderer.invoke('renderer:schedule-list', collectionPath);
  return { collectionPath, schedules };
});

export const createSchedule = createAsyncThunk('schedules/create', async ({ collectionPath, schedule }) => {
  const created = await window.ipcRenderer.invoke('renderer:schedule-create', { ...schedule, collectionPath });
  return { collectionPath, schedule: created };
});

export const updateSchedule = createAsyncThunk('schedules/update', async ({ collectionPath, scheduleId, updates }) => {
  const updated = await window.ipcRenderer.invoke('renderer:schedule-update', scheduleId, updates);
  return { collectionPath, schedule: updated };
});

export const toggleSchedule = createAsyncThunk('schedules/toggle', async ({ collectionPath, scheduleId, enabled }) => {
  const updated = await window.ipcRenderer.invoke('renderer:schedule-toggle', scheduleId, enabled);
  return { collectionPath, schedule: updated };
});

export const deleteSchedule = createAsyncThunk('schedules/delete', async ({ collectionPath, scheduleId }) => {
  await window.ipcRenderer.invoke('renderer:schedule-delete', scheduleId);
  return { collectionPath, scheduleId };
});

export const runScheduleNow = createAsyncThunk('schedules/runNow', async ({ scheduleId }) => {
  const result = await window.ipcRenderer.invoke('renderer:schedule-run-now', scheduleId);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result;
});

export const previewNextRuns = (cron) => window.ipcRenderer.invoke('renderer:schedule-next-runs', cron, 3);

export const testWebhook = (webhookUrl, webhookHeaders) => {
  return window.ipcRenderer.invoke('renderer:schedule-test-webhook', webhookUrl, webhookHeaders);
};

export const loadScheduleRuns = createAsyncThunk('schedules/loadRuns', async ({ collectionPath, scheduleId }) => {
  const runs = await window.ipcRenderer.invoke('datastore:scheduled_runs:list_scheduled_runs_for_schedule', {
    schedule_id: scheduleId,
    limit: MAX_HISTORY_ROWS
  });
  return { collectionPath, scheduleId, runs };
});

export const loadScheduleRunRequests = createAsyncThunk('schedules/loadRunRequests', async ({ collectionPath, runId }) => {
  const requests = await window.ipcRenderer.invoke('datastore:scheduled_runs:list_scheduled_run_requests', { run_id: runId });
  return { collectionPath, runId, requests };
});

const schedulesSlice = createSlice({
  name: 'schedules',
  initialState,
  reducers: {
    scheduleEventReceived: (state, action) => {
      const { type, scheduleId, collectionPath } = action.payload;
      const collection = getCollectionState(state, collectionPath);

      if (type === 'run-started') {
        collection.live[scheduleId] = { running: true, runId: action.payload.runId, trigger: action.payload.trigger, request: null };
      } else if (type === 'run-progress') {
        if (collection.live[scheduleId]) {
          collection.live[scheduleId].request = action.payload.request;
        }
      } else if (type === 'run-finished') {
        delete collection.live[scheduleId];
        const { runId, trigger, startedAt, finishedAt, duration, status, counts, message } = action.payload;
        if (runId) {
          collection.runs[scheduleId] = [
            {
              id: runId,
              schedule_id: scheduleId,
              trigger_type: trigger,
              started_at: startedAt,
              finished_at: finishedAt,
              duration,
              status,
              total_requests: counts.total,
              passed_requests: counts.passed,
              failed_requests: counts.failed,
              error_requests: counts.error,
              skipped_requests: counts.skipped,
              message
            },
            ...(collection.runs[scheduleId] || [])
          ].slice(0, MAX_HISTORY_ROWS);
        }
      }
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadSchedules.fulfilled, (state, action) => {
        getCollectionState(state, action.payload.collectionPath).schedules = action.payload.schedules;
      })
      .addCase(createSchedule.fulfilled, (state, action) => {
        getCollectionState(state, action.payload.collectionPath).schedules.push(action.payload.schedule);
      })
      .addCase(updateSchedule.fulfilled, (state, action) => replaceSchedule(state, action.payload))
      .addCase(toggleSchedule.fulfilled, (state, action) => replaceSchedule(state, action.payload))
      .addCase(deleteSchedule.fulfilled, (state, action) => {
        const { collectionPath, scheduleId } = action.payload;
        const collection = getCollectionState(state, collectionPath);
        collection.schedules = collection.schedules.filter((s) => s.id !== scheduleId);
        delete collection.runs[scheduleId];
        delete collection.live[scheduleId];
      })
      .addCase(loadScheduleRuns.fulfilled, (state, action) => {
        const { collectionPath, scheduleId, runs } = action.payload;
        getCollectionState(state, collectionPath).runs[scheduleId] = runs;
      })
      .addCase(loadScheduleRunRequests.fulfilled, (state, action) => {
        const { collectionPath, runId, requests } = action.payload;
        getCollectionState(state, collectionPath).runRequests[runId] = requests;
      });
  }
});

export const { scheduleEventReceived } = schedulesSlice.actions;

export default schedulesSlice.reducer;
