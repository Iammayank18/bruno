import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { IconChevronDown, IconChevronRight, IconPencil, IconPlayerPlay, IconTrash } from '@tabler/icons';
import { collectionKey, loadScheduleRuns, runScheduleNow, toggleSchedule } from 'providers/ReduxStore/slices/schedules';
import ActionIcon from 'ui/ActionIcon';
import StatusBadge from 'ui/StatusBadge';
import ToggleSwitch from 'components/ToggleSwitch';
import RunHistory from '../RunHistory';
import { STATUS_BADGE, humanizeCron } from '../utils';
import StyledWrapper from './StyledWrapper';

const targetLabel = (schedule) => {
  const count = schedule.requestPaths?.length;
  if (!count) return 'All requests';
  return `${count} ${count === 1 ? 'request' : 'requests'}`;
};

const ScheduleCard = ({ collection, schedule, onEdit, onDelete }) => {
  const dispatch = useDispatch();
  const [showHistory, setShowHistory] = useState(false);
  const collectionPath = collection.pathname;
  const runs = useSelector((state) => state.schedules.byCollection[collectionKey(collectionPath)]?.runs[schedule.id]);
  const live = useSelector((state) => state.schedules.byCollection[collectionKey(collectionPath)]?.live[schedule.id]);
  const status = live?.running ? 'running' : runs?.[0]?.status;

  useEffect(() => {
    if (!runs) {
      dispatch(loadScheduleRuns({ collectionPath, scheduleId: schedule.id }));
    }
  }, [runs, collectionPath, schedule.id, dispatch]);

  const handleRunNow = () => {
    dispatch(runScheduleNow({ scheduleId: schedule.id }))
      .unwrap()
      .catch((err) => toast.error(err.message || 'Failed to run schedule'));
  };

  const handleToggle = () => {
    dispatch(toggleSchedule({ collectionPath, scheduleId: schedule.id, enabled: !schedule.enabled }))
      .unwrap()
      .catch((err) => toast.error(err.message || 'Failed to update schedule'));
  };

  return (
    <StyledWrapper className="schedule-card" data-testid="schedule-card">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate" data-testid="schedule-name">{schedule.name}</span>
            <StatusBadge status={STATUS_BADGE[status] || 'muted'}>
              {status || 'not run yet'}
            </StatusBadge>
          </div>
          <div className="schedule-meta mt-1">
            <span>{humanizeCron(schedule.cron)}</span>
            <span>{targetLabel(schedule)}</span>
            <span>{schedule.environment || 'No environment'}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <ActionIcon label="Run now" onClick={handleRunNow} disabled={Boolean(live?.running)} data-testid="schedule-run-now">
            <IconPlayerPlay size={16} strokeWidth={1.5} />
          </ActionIcon>
          <ActionIcon label="Edit" onClick={onEdit} data-testid="schedule-edit">
            <IconPencil size={16} strokeWidth={1.5} />
          </ActionIcon>
          <ActionIcon label="Delete" onClick={onDelete} data-testid="schedule-delete">
            <IconTrash size={16} strokeWidth={1.5} />
          </ActionIcon>
          <div className="ml-2" title={schedule.enabled ? 'Enabled' : 'Disabled'} data-testid="schedule-enabled">
            <ToggleSwitch size="xs" isOn={schedule.enabled} handleToggle={handleToggle} />
          </div>
        </div>
      </div>

      {runs?.length ? (
        <>
          <button type="button" className="history-toggle mt-3" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? <IconChevronDown size={14} strokeWidth={1.5} /> : <IconChevronRight size={14} strokeWidth={1.5} />}
            <span>Run history ({runs.length})</span>
          </button>
          {showHistory ? <RunHistory collection={collection} runs={runs} /> : null}
        </>
      ) : null}
    </StyledWrapper>
  );
};

export default ScheduleCard;
