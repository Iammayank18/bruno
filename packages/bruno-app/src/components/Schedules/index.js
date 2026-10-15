import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { IconClock, IconPlus } from '@tabler/icons';
import { collectionKey, loadSchedules } from 'providers/ReduxStore/slices/schedules';
import Button from 'ui/Button';
import ScheduleCard from './ScheduleCard';
import EditScheduleModal from './EditScheduleModal';
import DeleteScheduleModal from './DeleteScheduleModal';
import { scheduleTargetsFolder, toCollectionRelativePath } from './utils';
import StyledWrapper from './StyledWrapper';

const EMPTY = [];

const Schedules = ({ collection, folderPathname }) => {
  const dispatch = useDispatch();
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [deletingSchedule, setDeletingSchedule] = useState(null);
  const allSchedules = useSelector((state) => state.schedules.byCollection[collectionKey(collection.pathname)]?.schedules) || EMPTY;
  const folderPath = folderPathname ? toCollectionRelativePath(collection, folderPathname) : null;

  const schedules = useMemo(
    () => (folderPath ? allSchedules.filter((schedule) => scheduleTargetsFolder(schedule, folderPath)) : allSchedules),
    [allSchedules, folderPath]
  );

  useEffect(() => {
    dispatch(loadSchedules({ collectionPath: collection.pathname }));
  }, [collection.pathname, dispatch]);

  return (
    <StyledWrapper className="px-4 pb-6 flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="flex items-start justify-between gap-4 mt-6">
        <div className="min-w-0">
          <div className="title font-medium flex items-center">
            <IconClock size={20} strokeWidth={1.5} className="mr-2 flex-shrink-0" />
            <span>Schedules</span>
            {folderPath ? <span className="text-muted font-normal ml-2 truncate">{folderPath}</span> : null}
          </div>
          <div className="mt-2 text-muted">
            Run requests on a cron schedule while Bruno is open. Scheduled runs use the saved files on disk.
          </div>
        </div>
        <Button
          size="sm"
          icon={<IconPlus size={14} strokeWidth={1.5} />}
          onClick={() => setEditingSchedule('new')}
          data-testid="new-schedule"
        >
          New Schedule
        </Button>
      </div>

      <div className="flex flex-col gap-3 mt-6" data-testid="schedules-list">
        {schedules.length === 0 ? (
          <div className="empty-state flex flex-col items-center text-center text-muted">
            <IconClock size={32} strokeWidth={1} />
            <div className="mt-3">
              {folderPath ? 'No schedules run requests in this folder yet.' : 'No schedules yet.'}
            </div>
          </div>
        ) : (
          schedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              collection={collection}
              schedule={schedule}
              onEdit={() => setEditingSchedule(schedule)}
              onDelete={() => setDeletingSchedule(schedule)}
            />
          ))
        )}
      </div>

      {editingSchedule ? (
        <EditScheduleModal
          collection={collection}
          schedule={editingSchedule === 'new' ? null : editingSchedule}
          folderPath={folderPath}
          onClose={() => setEditingSchedule(null)}
        />
      ) : null}
      {deletingSchedule ? (
        <DeleteScheduleModal collection={collection} schedule={deletingSchedule} onClose={() => setDeletingSchedule(null)} />
      ) : null}
    </StyledWrapper>
  );
};

export default Schedules;
