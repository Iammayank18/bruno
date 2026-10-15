import React, { useMemo, useState } from 'react';
import { IconCheck, IconCopy, IconTerminal2, IconX } from '@tabler/icons';
import get from 'lodash/get';
import { useSelector } from 'react-redux';
import CodeEditor from 'components/CodeEditor';
import Portal from 'components/Portal';
import Modal from 'components/Modal';
import useCopyToClipboard from 'hooks/useCopyToClipboard';
import { useTheme } from 'providers/Theme';
import ActionIcon from 'ui/ActionIcon';
import Button from 'ui/Button';
import CountBadge from 'ui/CountBadge';
import MethodBadge from 'ui/MethodBadge';
import SegmentedControl from 'ui/SegmentedControl';
import StatusBadge from 'ui/StatusBadge';
import { formatDuration } from 'utils/common';
import { STATUS_BADGE, buildCurlCommand, getBodyMode, parseJson, stringifyBody } from '../utils';
import StyledWrapper from './StyledWrapper';

const formatBody = (stored) => {
  const value = parseJson(stored);
  const text = stringifyBody(value ?? stored);
  const parsed = typeof value === 'string' ? parseJson(value) : null;
  return parsed && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : text;
};

const hasEntries = (value) => Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0;

const CopyButton = ({ text, label }) => {
  const { copied, copyToClipboard } = useCopyToClipboard(1500);

  return (
    <ActionIcon label={label} size="sm" disabled={!text} onClick={() => copyToClipboard(text)}>
      {copied ? <IconCheck size={14} strokeWidth={1.5} /> : <IconCopy size={14} strokeWidth={1.5} />}
    </ActionIcon>
  );
};

const HeadersTable = ({ title, headers }) => {
  const entries = hasEntries(headers) ? Object.entries(headers) : [];

  return (
    <div className="headers-section">
      <div className="section-title flex items-center gap-2">
        {title}
        <CountBadge>{entries.length}</CountBadge>
        <CopyButton label={`Copy ${title.toLowerCase()}`} text={entries.map(([name, value]) => `${name}: ${value}`).join('\n')} />
      </div>
      {entries.length === 0 ? (
        <div className="text-muted">No headers.</div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <td>Name</td>
                <td>Value</td>
              </tr>
            </thead>
            <tbody>
              {entries.map(([name, value]) => (
                <tr key={name}>
                  <td className="key">{name}</td>
                  <td className="value">{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const BodyViewer = ({ collection, body, headers, docKey, emptyText, testId }) => {
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);

  if (!body) {
    return (
      <div className="text-muted" data-testid={testId}>
        {emptyText}
      </div>
    );
  }

  return (
    <div className="body-viewer" data-testid={testId}>
      <div className="body-toolbar">
        <span className="text-muted">{new Blob([body]).size.toLocaleString()} bytes</span>
        <CopyButton label="Copy body" text={body} />
      </div>
      <div className="body-editor">
        <CodeEditor
          collection={collection}
          docKey={docKey}
          font={get(preferences, 'font.codeFont', 'default')}
          fontSize={get(preferences, 'font.codeFontSize')}
          theme={displayedTheme}
          value={body}
          mode={getBodyMode(headers, body)}
          readOnly
        />
      </div>
    </div>
  );
};

const CheckResult = ({ result }) => {
  const passed = result.status === 'pass' && !result.isScriptError;
  const label = result.description || [result.lhsExpr, result.rhsExpr].filter(Boolean).join(': ');

  return (
    <li className="py-0.5">
      <span className={`flex items-center ${passed ? 'test-success' : 'test-failure'}`}>
        {passed ? <IconCheck size={16} strokeWidth={2} className="mr-2" /> : <IconX size={16} strokeWidth={2} className="mr-2" />}
        {label}
      </span>
      {!passed && result.error ? <span className="error-message pl-6">{result.error}</span> : null}
    </li>
  );
};

const isPassed = (result) => result.status === 'pass' && !result.isScriptError;

const RunDetailsModal = ({ collection, request, onClose }) => {
  const checks = useMemo(
    () => [...(parseJson(request.test_results) || []), ...(parseJson(request.assertion_results) || [])],
    [request.test_results, request.assertion_results]
  );
  const requestHeaders = useMemo(() => parseJson(request.request_headers), [request.request_headers]);
  const responseHeaders = useMemo(() => parseJson(request.response_headers), [request.response_headers]);
  const requestBody = useMemo(() => formatBody(request.request_body), [request.request_body]);
  const responseBody = useMemo(() => formatBody(request.response_body), [request.response_body]);

  const failedChecks = checks.filter((result) => !isPassed(result)).length;
  const [tab, setTab] = useState(failedChecks > 0 ? 'tests' : 'response');

  const curlCommand = useMemo(
    () => buildCurlCommand({ method: request.request_method, url: request.request_url, headers: requestHeaders, body: requestBody }),
    [request.request_method, request.request_url, requestHeaders, requestBody]
  );
  const { copied: curlCopied, copyToClipboard } = useCopyToClipboard(1500);

  const tabs = [
    { value: 'response', label: 'Response' },
    { value: 'headers', label: `Headers (${Object.keys(requestHeaders || {}).length + Object.keys(responseHeaders || {}).length})` },
    { value: 'request', label: 'Request' },
    { value: 'tests', label: failedChecks > 0 ? `Tests (${failedChecks}/${checks.length} failed)` : `Tests (${checks.length})` }
  ];

  return (
    <Portal>
      <Modal size="lg" title={request.request_name || 'Request'} hideFooter handleCancel={onClose} dataTestId="schedule-run-details">
        <StyledWrapper>
          <div className="flex items-center gap-2 min-w-0">
            {request.request_method ? <MethodBadge method={request.request_method} /> : null}
            <span className="font-mono truncate">{request.request_url || request.request_path}</span>
            <CopyButton label="Copy URL" text={request.request_url} />
          </div>
          <div className="flex items-center gap-3 mt-2">
            <StatusBadge status={STATUS_BADGE[request.status] || 'muted'}>{request.status}</StatusBadge>
            {request.status_code ? <span>{request.status_code}</span> : null}
            <span className="text-muted">{formatDuration(request.duration || 0)}</span>
            <Button
              variant="ghost"
              color="secondary"
              size="sm"
              className="ml-auto"
              icon={curlCopied ? <IconCheck size={14} strokeWidth={1.5} /> : <IconTerminal2 size={14} strokeWidth={1.5} />}
              disabled={!request.request_url}
              onClick={() => copyToClipboard(curlCommand)}
              data-testid="schedule-run-copy-curl"
            >
              Copy as cURL
            </Button>
          </div>

          {request.error_message ? <pre className="error-block mt-4">{request.error_message}</pre> : null}

          <div className="mt-4">
            <SegmentedControl value={tab} onChange={setTab} items={tabs} ariaLabel="Request details" />
          </div>

          <div className="tab-panel mt-4">
            {tab === 'response' ? (
              <BodyViewer
                collection={collection}
                body={responseBody}
                headers={responseHeaders}
                docKey={`schedule-run:${request.id}:response`}
                emptyText="No response body."
                testId="schedule-run-response-body"
              />
            ) : null}
            {tab === 'headers' ? (
              <>
                <HeadersTable title="Request headers" headers={requestHeaders} />
                <HeadersTable title="Response headers" headers={responseHeaders} />
              </>
            ) : null}
            {tab === 'request' ? (
              <BodyViewer
                collection={collection}
                body={requestBody}
                headers={requestHeaders}
                docKey={`schedule-run:${request.id}:request`}
                emptyText="This request has no body."
                testId="schedule-run-request-body"
              />
            ) : null}
            {tab === 'tests' ? (
              <div data-testid="schedule-run-checks">
                {checks.length === 0 ? (
                  <div className="text-muted">No tests or assertions ran.</div>
                ) : (
                  <ul>
                    {checks.map((result, index) => <CheckResult key={result.uid || index} result={result} />)}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </StyledWrapper>
      </Modal>
    </Portal>
  );
};

export default RunDetailsModal;
