jest.mock('electron-store', () =>
  jest.fn().mockImplementation(() => {
    const data = {};
    return {
      get: (key) => data[key],
      set: (key, value) => {
        data[key] = JSON.parse(JSON.stringify(value));
      }
    };
  })
);

jest.mock('../../utils/encryption', () => ({
  encryptStringSafe: (value) => ({ value: `enc(${value})` }),
  decryptStringSafe: (value) => ({ value: value.replace(/^enc\((.*)\)$/, '$1') })
}));

const { SchedulesStore } = require('../schedules');

const baseSchedule = {
  name: 'Nightly',
  collectionPath: '/collections/api',
  cron: '0 2 * * *'
};

describe('SchedulesStore', () => {
  let store;

  beforeEach(() => {
    store = new SchedulesStore();
  });

  it('creates a schedule with defaults and normalized request paths', () => {
    const created = store.create({ ...baseSchedule, requestPaths: ['b\\get.bru', 'a/list.bru', 'a/list.bru', ' '] });

    expect(created).toMatchObject({
      name: 'Nightly',
      folderPath: null,
      recursive: true,
      environment: null,
      retention: 100,
      enabled: true,
      requestPaths: ['a/list.bru', 'b/get.bru'],
      notify: { os: true, webhookUrl: null, webhookHeaders: {} }
    });
    expect(created.id).toMatch(/^schedule_/);
  });

  it('treats an empty request selection as the whole target', () => {
    expect(store.create({ ...baseSchedule, requestPaths: [] }).requestPaths).toBeNull();
  });

  it.each([
    [{ name: ' ' }, 'Schedule name is required'],
    [{ collectionPath: '' }, 'Schedule collection path is required'],
    [{ cron: '' }, 'Schedule cron expression is required'],
    [{ retention: 0 }, 'Schedule retention must be an integer between 1 and 1000'],
    [{ variables: 'x' }, 'Schedule variables must be an array']
  ])('rejects invalid input %j', (override, message) => {
    expect(() => store.create({ ...baseSchedule, ...override })).toThrow(message);
  });

  it('encrypts secret variables and never returns their values', () => {
    const created = store.create({
      ...baseSchedule,
      variables: [
        { name: 'host', value: 'api.local', enabled: true },
        { name: 'token', value: 's3cret', secret: true, enabled: true }
      ]
    });

    expect(created.variables).toEqual([
      { name: 'host', value: 'api.local', secret: false, enabled: true },
      { name: 'token', value: undefined, secret: true, enabled: true, hasValue: true }
    ]);
    expect(store.getByCollectionPath('/collections/api')[0].variables[1].value).toBeUndefined();
    expect(store.get(created.id).variables[1].value).toBe('enc(s3cret)');
    expect(store.decryptVariables(store.get(created.id).variables)[1].value).toBe('s3cret');
  });

  it('keeps a stored secret when an update sends it blank', () => {
    const created = store.create({ ...baseSchedule, variables: [{ name: 'token', value: 's3cret', secret: true }] });

    store.update(created.id, { variables: [{ name: 'token', value: '', secret: true }] });
    expect(store.get(created.id).variables[0].value).toBe('enc(s3cret)');

    store.update(created.id, { variables: [{ name: 'token', value: 'rotated', secret: true }] });
    expect(store.get(created.id).variables[0].value).toBe('enc(rotated)');
  });

  it('encrypts webhook headers at rest and returns them decrypted for editing', () => {
    const created = store.create({ ...baseSchedule, notify: { webhookUrl: 'https://hooks.example.com', webhookHeaders: '{"X-Key":"abc"}' } });

    expect(store.get(created.id).notify.webhookHeaders).toBe('enc({"X-Key":"abc"})');
    expect(created.notify).toEqual({ os: true, webhookUrl: 'https://hooks.example.com', webhookHeaders: { 'X-Key': 'abc' } });
    expect(() => store.update(created.id, { notify: { webhookHeaders: 'not json' } })).toThrow('Webhook headers must be a JSON object');
  });

  it('updates only the allowed fields', () => {
    const created = store.create(baseSchedule);
    const updated = store.update(created.id, { cron: '*/5 * * * *', enabled: false, collectionPath: '/elsewhere', id: 'hijack' });

    expect(updated).toMatchObject({ id: created.id, cron: '*/5 * * * *', enabled: false, collectionPath: '/collections/api' });
  });

  it('lists schedules by collection path regardless of separators', () => {
    store.create({ ...baseSchedule, collectionPath: 'C:\\collections\\api' });
    store.create({ ...baseSchedule, collectionPath: '/other' });

    expect(store.getByCollectionPath('C:/collections/api')).toHaveLength(1);
  });

  it('deletes a schedule and rejects unknown ids', () => {
    const created = store.create(baseSchedule);
    store.delete(created.id);

    expect(store.getAll()).toEqual([]);
    expect(() => store.delete(created.id)).toThrow('Schedule not found');
    expect(() => store.update('missing', {})).toThrow('Schedule not found');
  });
});
