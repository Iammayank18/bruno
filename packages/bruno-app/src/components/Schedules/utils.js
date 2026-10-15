import { getRelativePathWithinBasePath } from 'utils/common/path';
import { sortItemsBySidebarOrder } from 'utils/collections';

const RUNNABLE_REQUEST_TYPES = ['http-request', 'graphql-request'];

export const STATUS_BADGE = {
  pass: 'success',
  fail: 'danger',
  error: 'danger',
  running: 'warning',
  skipped: 'info'
};

export const toCollectionRelativePath = (collection, pathname) => getRelativePathWithinBasePath(collection.pathname, pathname, true);

const parentPath = (relativePath) => relativePath.split('/').slice(0, -1).join('/');

// Schedules target requests by path relative to the collection.
export const collectRequests = (collection) => {
  const requests = [];
  const visit = (items) => {
    for (const item of items) {
      if (item.type === 'folder') {
        visit(item.items || []);
      } else if (RUNNABLE_REQUEST_TYPES.includes(item.type) && item.pathname) {
        const requestPath = toCollectionRelativePath(collection, item.pathname);
        requests.push({
          uid: item.uid,
          name: item.name,
          method: item.request?.method,
          requestPath,
          folderPath: parentPath(requestPath)
        });
      }
    }
  };
  visit(sortItemsBySidebarOrder(collection.items || []));
  return requests;
};

export const isInFolder = (requestPath, folderPath) => requestPath.startsWith(`${folderPath}/`);

export const scheduleTargetsFolder = (schedule, folderPath) => {
  return !schedule.requestPaths?.length || schedule.requestPaths.some((requestPath) => isInFolder(requestPath, folderPath));
};

const pad = (value) => value.padStart(2, '0');
const isNumber = (value) => /^\d+$/.test(value);

export const humanizeCron = (cron) => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const everyDay = dayOfMonth === '*' && month === '*';

  if (everyDay && dayOfWeek === '*' && hour === '*') {
    if (minute === '*') return 'Every minute';
    if (minute.startsWith('*/')) return `Every ${minute.slice(2)} minutes`;
    if (isNumber(minute)) return `Hourly at :${pad(minute)}`;
  }
  if (everyDay && dayOfWeek === '*' && minute === '0' && hour.startsWith('*/')) {
    return `Every ${hour.slice(2)} hours`;
  }
  if (everyDay && isNumber(minute) && isNumber(hour)) {
    const time = `${pad(hour)}:${pad(minute)}`;
    if (dayOfWeek === '*') return `Daily at ${time}`;
    if (dayOfWeek === '1-5') return `Weekdays at ${time}`;
  }
  return cron;
};

export const formatDateTime = (timestamp) => {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

export const parseJson = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
};

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export const stringifyBody = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

export const buildCurlCommand = ({ method, url, headers, body }) => {
  const parts = ['curl', '-X', method || 'GET', shellQuote(url || '')];
  Object.entries(headers || {}).forEach(([name, value]) => {
    parts.push('-H', shellQuote(`${name}: ${value}`));
  });
  if (body) {
    parts.push('--data-raw', shellQuote(body));
  }
  return parts.join(' ');
};

export const getBodyMode = (headers, body) => {
  if (parseJson(body) !== null) return 'application/ld+json';
  const contentType = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
  if (/xml|html/i.test(contentType)) return 'xml';
  return 'text/plain';
};
