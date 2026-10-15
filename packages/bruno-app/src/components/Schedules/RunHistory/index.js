import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { IconChevronLeft, IconChevronRight, IconCircleCheck, IconCircleOff, IconCircleX } from '@tabler/icons';
import { collectionKey, loadScheduleRunRequests } from 'providers/ReduxStore/slices/schedules';
import ActionIcon from 'ui/ActionIcon';
import MethodBadge from 'ui/MethodBadge';
import StatusBadge from 'ui/StatusBadge';
import { formatDuration } from 'utils/common';
import RunDetailsModal from '../RunDetailsModal';
import { STATUS_BADGE, formatDateTime } from '../utils';
import StyledWrapper from './StyledWrapper';

const PAGE_SIZE = 20;

const RequestStatusIcon = ({ status }) => {
  if (status === 'pass') return <IconCircleCheck className="test-success" size={16} strokeWidth={1.5} />;
  if (status === 'skipped') return <IconCircleOff className="text-muted" size={16} strokeWidth={1.5} />;
  return <IconCircleX className="test-failure" size={16} strokeWidth={1.5} />;
};

const RunRequests = ({ requests, onSelect }) => {
  if (!requests) {
    return <div className="run-requests text-muted">Loading...</div>;
  }
  if (requests.length === 0) {
    return <div className="run-requests text-muted">No requests ran.</div>;
  }

  return (
    <div className="run-requests" data-testid="schedule-run-requests">
      {requests.map((request) => (
        <button key={request.id} type="button" className="run-request" onClick={() => onSelect(request)}>
          <RequestStatusIcon status={request.status} />
          {request.request_method ? <MethodBadge method={request.request_method} size="sm" /> : null}
          <span className="truncate">{request.request_name || request.request_path}</span>
          {request.status_code ? <span className="text-muted">{request.status_code}</span> : null}
          {request.error_message ? <span className="test-failure truncate">{request.error_message}</span> : null}
          <span className="text-muted ml-auto flex-shrink-0">{formatDuration(request.duration || 0)}</span>
        </button>
      ))}
    </div>
  );
};

const RunHistory = ({ collection, runs }) => {
  const dispatch = useDispatch();
  const [page, setPage] = useState(0);
  const [openRunId, setOpenRunId] = useState(null);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const runRequests = useSelector((state) => state.schedules.byCollection[collectionKey(collection.pathname)]?.runRequests);

  const totalPages = Math.ceil(runs.length / PAGE_SIZE);
  const currentPage = Math.min(page, totalPages - 1);
  const visibleRuns = runs.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const toggleRun = (runId) => {
    if (openRunId === runId) {
      setOpenRunId(null);
      return;
    }
    setOpenRunId(runId);
    if (!runRequests?.[runId]) {
      dispatch(loadScheduleRunRequests({ collectionPath: collection.pathname, runId }));
    }
  };

  return (
    <StyledWrapper className="mt-2">
      <table data-testid="schedule-runs">
        <thead>
          <tr>
            <td>Started</td>
            <td>Trigger</td>
            <td>Status</td>
            <td>Requests</td>
            <td>Duration</td>
          </tr>
        </thead>
        <tbody>
          {visibleRuns.map((run) => (
            <React.Fragment key={run.id}>
              <tr className={openRunId === run.id ? 'run-row active' : 'run-row'} onClick={() => toggleRun(run.id)}>
                <td>{formatDateTime(run.started_at)}</td>
                <td className="capitalize">{run.trigger_type}</td>
                <td>
                  <StatusBadge status={STATUS_BADGE[run.status] || 'muted'}>{run.status}</StatusBadge>
                </td>
                <td>
                  <span className="test-success">{run.passed_requests} passed</span>
                  {run.failed_requests + run.error_requests > 0 ? (
                    <span className="test-failure ml-2">{run.failed_requests + run.error_requests} failed</span>
                  ) : null}
                  {run.skipped_requests > 0 ? <span className="text-muted ml-2">{run.skipped_requests} skipped</span> : null}
                </td>
                <td>{run.duration === null ? '-' : formatDuration(run.duration)}</td>
              </tr>
              {openRunId === run.id ? (
                <tr>
                  <td colSpan={5}>
                    {run.message ? <div className="test-failure pb-1">{run.message}</div> : null}
                    <RunRequests requests={runRequests?.[run.id]} onSelect={setSelectedRequest} />
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          ))}
        </tbody>
      </table>

      {totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2 mt-2 text-muted" data-testid="schedule-runs-pager">
          <ActionIcon label="Previous page" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            <IconChevronLeft size={14} strokeWidth={1.5} />
          </ActionIcon>
          <span>
            Page {currentPage + 1} of {totalPages}
          </span>
          <ActionIcon label="Next page" size="sm" disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}>
            <IconChevronRight size={14} strokeWidth={1.5} />
          </ActionIcon>
        </div>
      ) : null}

      {selectedRequest ? <RunDetailsModal collection={collection} request={selectedRequest} onClose={() => setSelectedRequest(null)} /> : null}
    </StyledWrapper>
  );
};

export default RunHistory;
