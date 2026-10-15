import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch } from 'react-redux';
import { useFormik } from 'formik';
import * as Yup from 'yup';
import toast from 'react-hot-toast';
import { IconPlus, IconTrash } from '@tabler/icons';
import Portal from 'components/Portal';
import Modal from 'components/Modal';
import ActionIcon from 'ui/ActionIcon';
import Button from 'ui/Button';
import MethodBadge from 'ui/MethodBadge';
import SegmentedControl from 'ui/SegmentedControl';
import { createSchedule, previewNextRuns, testWebhook, updateSchedule } from 'providers/ReduxStore/slices/schedules';
import { collectRequests, isInFolder } from '../utils';
import StyledWrapper from './StyledWrapper';

const FREQUENCY_PRESETS = [
  { value: '*/5 * * * *', label: 'Every 5 min' },
  { value: '*/15 * * * *', label: 'Every 15 min' },
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 9 * * *', label: 'Daily at 9:00' },
  { value: 'custom', label: 'Custom' }
];

const TARGET_OPTIONS = [
  { value: 'all', label: 'All requests' },
  { value: 'selected', label: 'Selected requests' }
];

const parseHeaders = (value) => {
  try {
    const headers = JSON.parse(value);
    return headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : null;
  } catch (err) {
    return null;
  }
};

const validationSchema = Yup.object({
  name: Yup.string().trim().required('Name is required'),
  cron: Yup.string().trim().required('Cron expression is required'),
  requestPaths: Yup.array().when('target', {
    is: 'selected',
    then: Yup.array().min(1, 'Select at least one request')
  }),
  webhookUrl: Yup.string().trim().matches(/^https?:\/\//i, 'Webhook URL must start with http:// or https://'),
  webhookHeaders: Yup.string().test('json-object', 'Headers must be a JSON object', (value) => !value?.trim() || Boolean(parseHeaders(value))),
  retention: Yup.number().typeError('Enter a number').integer('Enter a whole number').min(1, 'Keep at least 1 run').max(1000, 'Keep at most 1000 runs')
});

const toFormValues = (schedule, folderRequests) => ({
  name: schedule?.name || '',
  target: schedule?.requestPaths?.length || folderRequests.length ? 'selected' : 'all',
  requestPaths: schedule?.requestPaths || folderRequests.map((request) => request.requestPath),
  environment: schedule?.environment || '',
  cron: schedule?.cron || '*/15 * * * *',
  variables: (schedule?.variables || []).map((variable) => ({
    name: variable.name,
    value: variable.secret ? '' : variable.value,
    secret: variable.secret,
    enabled: variable.enabled,
    hasValue: Boolean(variable.hasValue)
  })),
  notifyOs: schedule?.notify?.os !== false,
  webhookUrl: schedule?.notify?.webhookUrl || '',
  webhookHeaders: Object.keys(schedule?.notify?.webhookHeaders || {}).length ? JSON.stringify(schedule.notify.webhookHeaders) : '',
  retention: schedule?.retention ?? 100
});

const EditScheduleModal = ({ collection, schedule, folderPath, onClose }) => {
  const dispatch = useDispatch();
  const requests = useMemo(() => collectRequests(collection), [collection]);
  const folderRequests = schedule || !folderPath ? [] : requests.filter((request) => isInFolder(request.requestPath, folderPath));
  const [requestSearch, setRequestSearch] = useState('');
  const [nextRuns, setNextRuns] = useState([]);
  const [cronError, setCronError] = useState(null);

  const formik = useFormik({
    initialValues: toFormValues(schedule, folderRequests),
    validationSchema,
    onSubmit: async (values) => {
      if (cronError) return;

      const payload = {
        name: values.name.trim(),
        cron: values.cron.trim(),
        requestPaths: values.target === 'selected' ? values.requestPaths : null,
        environment: values.environment || null,
        variables: values.variables
          .filter((variable) => variable.name.trim())
          .map(({ name, value, secret, enabled }) => ({ name: name.trim(), value, secret, enabled })),
        notify: {
          os: values.notifyOs,
          webhookUrl: values.webhookUrl.trim() || null,
          webhookHeaders: parseHeaders(values.webhookHeaders) || {}
        },
        retention: Number(values.retention)
      };

      try {
        if (schedule) {
          await dispatch(updateSchedule({ collectionPath: collection.pathname, scheduleId: schedule.id, updates: payload })).unwrap();
          toast.success('Schedule updated');
        } else {
          await dispatch(createSchedule({ collectionPath: collection.pathname, schedule: payload })).unwrap();
          toast.success('Schedule created');
        }
        onClose();
      } catch (err) {
        toast.error(err.message || 'Failed to save schedule');
      }
    }
  });

  const { values, errors, touched, setFieldValue } = formik;

  useEffect(() => {
    const cron = values.cron.trim();
    if (!cron) {
      setNextRuns([]);
      setCronError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      previewNextRuns(cron).then((runs) => {
        if (cancelled) return;
        setNextRuns(runs);
        setCronError(runs.length ? null : 'Invalid cron expression');
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [values.cron]);

  const visibleRequests = useMemo(() => {
    const term = requestSearch.trim().toLowerCase();
    if (!term) return requests;
    return requests.filter((request) => request.name.toLowerCase().includes(term) || request.requestPath.toLowerCase().includes(term));
  }, [requests, requestSearch]);

  const toggleRequest = (requestPath, checked) => {
    setFieldValue('requestPaths', checked ? [...values.requestPaths, requestPath] : values.requestPaths.filter((p) => p !== requestPath));
  };

  const updateVariable = (index, field, value) => setFieldValue(`variables.${index}.${field}`, value);

  const handleTestWebhook = () => {
    testWebhook(values.webhookUrl.trim(), parseHeaders(values.webhookHeaders) || {})
      .then(() => toast.success('Test notification sent'))
      .catch((err) => toast.error(err.message || 'Failed to send test notification'));
  };

  const fieldError = (name) => (touched[name] && errors[name] ? <div className="text-red-500 mt-1">{errors[name]}</div> : null);
  const presetValue = FREQUENCY_PRESETS.some((preset) => preset.value === values.cron.trim()) ? values.cron.trim() : 'custom';

  return (
    <Portal>
      <Modal
        size="lg"
        title={schedule ? 'Edit Schedule' : 'New Schedule'}
        confirmText={schedule ? 'Save' : 'Create'}
        handleConfirm={formik.handleSubmit}
        handleCancel={onClose}
        dataTestId="edit-schedule-modal"
      >
        <StyledWrapper>
          <form className="bruno-form" onSubmit={(e) => e.preventDefault()}>
            <div>
              <label htmlFor="schedule-name" className="block font-medium">Name</label>
              <input
                id="schedule-name"
                type="text"
                name="name"
                className="block textbox w-full mt-2"
                autoComplete="off"
                autoFocus
                value={values.name}
                onChange={formik.handleChange}
                data-testid="schedule-name-input"
              />
              {fieldError('name')}
            </div>

            <div className="mt-4">
              <label className="block font-medium mb-2">Requests</label>
              <SegmentedControl
                ariaLabel="Requests to run"
                size="sm"
                value={values.target}
                onChange={(value) => setFieldValue('target', value)}
                items={TARGET_OPTIONS}
                data-testid="schedule-target"
              />
              {values.target === 'selected' ? (
                <div className="request-picker mt-2" data-testid="schedule-request-picker">
                  <div className="picker-toolbar">
                    <input
                      type="text"
                      className="textbox flex-1"
                      placeholder="Search requests"
                      value={requestSearch}
                      onChange={(e) => setRequestSearch(e.target.value)}
                    />
                    <button type="button" className="text-link" onClick={() => setFieldValue('requestPaths', [...new Set([...values.requestPaths, ...visibleRequests.map((r) => r.requestPath)])])}>
                      Select all
                    </button>
                    <button type="button" className="text-link" onClick={() => setFieldValue('requestPaths', [])}>
                      Clear
                    </button>
                  </div>
                  <div className="picker-list">
                    {visibleRequests.length === 0 ? (
                      <div className="text-muted p-3 text-center">{requests.length ? 'No matching requests' : 'This collection has no requests'}</div>
                    ) : (
                      visibleRequests.map((request) => (
                        <label key={request.uid} className="picker-row" title={request.requestPath}>
                          <input
                            type="checkbox"
                            checked={values.requestPaths.includes(request.requestPath)}
                            onChange={(e) => toggleRequest(request.requestPath, e.target.checked)}
                          />
                          <MethodBadge method={request.method} size="sm" />
                          <span className="truncate">{request.name}</span>
                          {request.folderPath ? <span className="text-muted truncate ml-auto">{request.folderPath}</span> : null}
                        </label>
                      ))
                    )}
                  </div>
                  <div className="text-muted mt-1">{values.requestPaths.length} of {requests.length} selected</div>
                </div>
              ) : null}
              {fieldError('requestPaths')}
            </div>

            <div className="mt-4">
              <label htmlFor="schedule-environment" className="block font-medium">Environment</label>
              <select
                id="schedule-environment"
                name="environment"
                className="textbox w-full mt-2"
                value={values.environment}
                onChange={formik.handleChange}
                data-testid="schedule-environment-select"
              >
                <option value="">No environment</option>
                {(collection.environments || []).map((environment) => (
                  <option key={environment.uid} value={environment.name}>{environment.name}</option>
                ))}
              </select>
            </div>

            <div className="mt-4">
              <label htmlFor="schedule-cron" className="block font-medium mb-2">Frequency</label>
              <SegmentedControl
                ariaLabel="Frequency"
                size="sm"
                value={presetValue}
                onChange={(value) => value !== 'custom' && setFieldValue('cron', value)}
                items={FREQUENCY_PRESETS}
              />
              <input
                id="schedule-cron"
                type="text"
                name="cron"
                className="block textbox w-full mt-2 font-mono"
                placeholder="*/15 * * * *"
                autoComplete="off"
                value={values.cron}
                onChange={formik.handleChange}
                data-testid="schedule-cron-input"
              />
              {cronError ? <div className="text-red-500 mt-1">{cronError}</div> : fieldError('cron')}
              {!cronError && nextRuns.length ? (
                <div className="text-muted mt-1" data-testid="schedule-next-runs">
                  Next runs: {nextRuns.map((run) => new Date(run).toLocaleString()).join(', ')}
                </div>
              ) : null}
            </div>

            <div className="mt-4">
              <label className="block font-medium">Variables</label>
              <div className="text-muted mt-1">Runtime variables set before each run.</div>
              {values.variables.map((variable, index) => (
                <div key={index} className="variable-row mt-2">
                  <input
                    type="text"
                    className="textbox"
                    placeholder="Name"
                    value={variable.name}
                    onChange={(e) => updateVariable(index, 'name', e.target.value)}
                  />
                  <input
                    type={variable.secret ? 'password' : 'text'}
                    className="textbox"
                    placeholder={variable.secret && variable.hasValue ? 'Unchanged' : 'Value'}
                    value={variable.value}
                    onChange={(e) => updateVariable(index, 'value', e.target.value)}
                  />
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="checkbox" checked={variable.secret} onChange={(e) => updateVariable(index, 'secret', e.target.checked)} />
                    Secret
                  </label>
                  <ActionIcon label="Remove variable" onClick={() => setFieldValue('variables', values.variables.filter((_, i) => i !== index))}>
                    <IconTrash size={15} strokeWidth={1.5} />
                  </ActionIcon>
                </div>
              ))}
              <button
                type="button"
                className="text-link flex items-center gap-1 mt-2"
                onClick={() => setFieldValue('variables', [...values.variables, { name: '', value: '', secret: false, enabled: true }])}
              >
                <IconPlus size={14} strokeWidth={1.5} />
                Add variable
              </button>
            </div>

            <div className="mt-4">
              <label className="block font-medium">When a run fails</label>
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" name="notifyOs" checked={values.notifyOs} onChange={formik.handleChange} />
                Show a desktop notification while Bruno is in the background
              </label>
              <input
                type="text"
                name="webhookUrl"
                className="block textbox w-full mt-2"
                placeholder="Webhook URL (optional)"
                autoComplete="off"
                value={values.webhookUrl}
                onChange={formik.handleChange}
                data-testid="schedule-webhook-input"
              />
              {fieldError('webhookUrl')}
              <input
                type="text"
                name="webhookHeaders"
                className="block textbox w-full mt-2 font-mono"
                placeholder='Webhook headers, e.g. {"Authorization": "Bearer ..."}'
                autoComplete="off"
                value={values.webhookHeaders}
                onChange={formik.handleChange}
              />
              {fieldError('webhookHeaders')}
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                color="secondary"
                disabled={!/^https?:\/\//i.test(values.webhookUrl.trim())}
                onClick={handleTestWebhook}
              >
                Send test notification
              </Button>
            </div>

            <div className="mt-4">
              <label htmlFor="schedule-retention" className="block font-medium">Run history to keep</label>
              <input
                id="schedule-retention"
                type="number"
                name="retention"
                min="1"
                max="1000"
                className="block textbox mt-2 w-32"
                value={values.retention}
                onChange={formik.handleChange}
              />
              {fieldError('retention')}
            </div>
          </form>
        </StyledWrapper>
      </Modal>
    </Portal>
  );
};

export default EditScheduleModal;
