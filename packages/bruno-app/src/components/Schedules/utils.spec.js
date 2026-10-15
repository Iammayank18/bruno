import { buildCurlCommand, collectRequests, getBodyMode, humanizeCron, scheduleTargetsFolder, stringifyBody } from './utils';

describe('Schedules utils', () => {
  describe('humanizeCron', () => {
    it.each([
      ['* * * * *', 'Every minute'],
      ['*/15 * * * *', 'Every 15 minutes'],
      ['5 * * * *', 'Hourly at :05'],
      ['0 */6 * * *', 'Every 6 hours'],
      ['30 9 * * *', 'Daily at 09:30'],
      ['0 18 * * 1-5', 'Weekdays at 18:00'],
      ['0 0 1 * *', '0 0 1 * *']
    ])('describes %s as %s', (cron, expected) => {
      expect(humanizeCron(cron)).toBe(expected);
    });
  });

  describe('collectRequests', () => {
    const collection = {
      pathname: '/collections/api',
      items: [
        { uid: 'r2', name: 'Health', type: 'http-request', seq: 2, pathname: '/collections/api/health.bru', request: { method: 'GET' } },
        { uid: 'ws', name: 'Socket', type: 'ws-request', seq: 3, pathname: '/collections/api/socket.bru' },
        {
          uid: 'f1',
          name: 'Users folder',
          type: 'folder',
          pathname: '/collections/api/users',
          items: [
            { uid: 'r1', name: 'Create', type: 'graphql-request', seq: 1, pathname: '/collections/api/users/create.bru', request: { method: 'POST' } }
          ]
        }
      ]
    };

    it('lists runnable requests in sidebar order with collection-relative paths', () => {
      expect(collectRequests(collection)).toEqual([
        { uid: 'r1', name: 'Create', method: 'POST', requestPath: 'users/create.bru', folderPath: 'users' },
        { uid: 'r2', name: 'Health', method: 'GET', requestPath: 'health.bru', folderPath: '' }
      ]);
    });
  });

  describe('scheduleTargetsFolder', () => {
    it('matches schedules that run every request or a request inside the folder', () => {
      expect(scheduleTargetsFolder({ requestPaths: null }, 'users')).toBe(true);
      expect(scheduleTargetsFolder({ requestPaths: ['users/admin/get.bru'] }, 'users')).toBe(true);
      expect(scheduleTargetsFolder({ requestPaths: ['users-v2/get.bru', 'health.bru'] }, 'users')).toBe(false);
    });
  });

  describe('buildCurlCommand', () => {
    it('includes method, headers and body and escapes single quotes', () => {
      expect(
        buildCurlCommand({
          method: 'POST',
          url: 'https://example.com/users',
          headers: { 'content-type': 'application/json' },
          body: `{"name":"O'Brien"}`
        })
      ).toBe(`curl -X POST 'https://example.com/users' -H 'content-type: application/json' --data-raw '{"name":"O'\\''Brien"}'`);
    });

    it('omits headers and body when absent', () => {
      expect(buildCurlCommand({ method: 'GET', url: 'https://example.com' })).toBe(`curl -X GET 'https://example.com'`);
    });
  });

  describe('stringifyBody', () => {
    it('keeps strings, pretty prints objects and ignores empty values', () => {
      expect(stringifyBody('pong')).toBe('pong');
      expect(stringifyBody({ a: 1 })).toBe('{\n  "a": 1\n}');
      expect(stringifyBody('')).toBeNull();
      expect(stringifyBody(null)).toBeNull();
    });
  });

  describe('getBodyMode', () => {
    it('detects json, xml and plain text bodies', () => {
      expect(getBodyMode({}, '{"a":1}')).toBe('application/ld+json');
      expect(getBodyMode({ 'Content-Type': 'text/html; charset=utf-8' }, '<p>hi</p>')).toBe('xml');
      expect(getBodyMode({}, 'pong')).toBe('text/plain');
    });
  });
});
