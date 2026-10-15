const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mockWatchedCollections = new Set();

jest.mock('../../app/dotenv-watcher', () => ({
  hasCollectionWatcher: (pathname) => mockWatchedCollections.has(pathname),
  hasWorkspaceWatcher: () => false
}));
jest.mock('../../store/global-environments', () => ({
  globalEnvironmentsStore: { getGlobalEnvironments: () => [], getActiveGlobalEnvironmentUid: () => null }
}));
jest.mock('../../store/workspace-environments', () => ({ globalEnvironmentsManager: {} }));
jest.mock('../../app/collections', () => ({}));
jest.mock('../pool', () => ({}));
jest.mock('../../store/collection-security', () => jest.fn());

const { getBrunoConfig, setBrunoConfig, clearBrunoConfig } = require('../../store/bruno-config');
const { getProcessEnvVars, setDotEnvVars, clearDotEnvVars } = require('../../store/process-env');
const { prepareRunContext, cleanupRunContext } = require('./collection-loader');

describe('scheduled run context', () => {
  let collectionPath;
  let collection;

  beforeEach(() => {
    collectionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-scheduler-'));
    fs.writeFileSync(path.join(collectionPath, '.env'), 'API_KEY=from-disk\n');
    collection = {
      uid: 'col-1',
      pathname: collectionPath,
      brunoConfig: { name: 'api' },
      environments: [
        { name: 'base', variables: [{ name: 'host', value: 'base.local', enabled: true }] },
        { name: 'dev', extends: 'base', variables: [{ name: 'user', value: 'dev', enabled: true }] }
      ]
    };
  });

  afterEach(() => {
    mockWatchedCollections.clear();
    clearBrunoConfig('col-1');
    clearDotEnvVars('col-1');
    fs.rmSync(collectionPath, { recursive: true, force: true });
  });

  it('resolves the selected environment with its inherited variables', async () => {
    const { environment } = await prepareRunContext({ collection, environmentName: 'dev' });
    cleanupRunContext(collection);

    expect(environment.variables).toEqual([{ name: 'user', value: 'dev', enabled: true }]);
    expect(environment.inheritedVariables).toEqual([expect.objectContaining({ name: 'host', value: 'base.local' })]);
  });

  it('runs without an environment when the selected one no longer exists', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { environment } = await prepareRunContext({ collection, environmentName: 'gone' });
    cleanupRunContext(collection);

    expect(environment).toBeNull();
  });

  it('seeds config and .env for a collection the app has not opened, and removes them afterwards', async () => {
    await prepareRunContext({ collection });

    expect(getBrunoConfig('col-1')).toEqual({ name: 'api' });
    expect(getProcessEnvVars('col-1').API_KEY).toBe('from-disk');

    cleanupRunContext(collection);

    expect(getBrunoConfig('col-1')).toEqual({});
    expect(getProcessEnvVars('col-1').API_KEY).toBeUndefined();
  });

  it('leaves the state of a collection open in the app untouched', async () => {
    const appConfig = { name: 'api', scripts: { flow: 'sequential' } };
    setBrunoConfig('col-1', appConfig);
    setDotEnvVars('col-1', { API_KEY: 'from-app' });
    mockWatchedCollections.add(collectionPath);

    await prepareRunContext({ collection });
    cleanupRunContext(collection);

    expect(getBrunoConfig('col-1')).toBe(appConfig);
    expect(getProcessEnvVars('col-1').API_KEY).toBe('from-app');
  });

  it('keeps seeded state until the last concurrent run of a collection ends', async () => {
    await prepareRunContext({ collection });
    await prepareRunContext({ collection });

    cleanupRunContext(collection);
    expect(getProcessEnvVars('col-1').API_KEY).toBe('from-disk');

    cleanupRunContext(collection);
    expect(getProcessEnvVars('col-1').API_KEY).toBeUndefined();
  });
});
