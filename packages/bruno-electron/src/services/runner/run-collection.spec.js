const { Readable } = require('stream');

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  app: {
    on: jest.fn(),
    getPath: jest.fn(() => require('node:os').tmpdir()),
    getVersion: jest.fn(() => '1.0.0')
  }
}));

jest.mock('../../ipc/network/prepare-request', () => ({
  prepareRequest: jest.fn(async (item) => ({
    method: item.request.method,
    url: item.request.url,
    headers: {},
    data: undefined
  }))
}));
jest.mock('../../ipc/network/cert-utils', () => ({ buildCertsAndProxyConfig: jest.fn(async () => ({})) }));
jest.mock('../../ipc/network/axios-instance', () => ({ completeOpenHop: jest.fn() }));
jest.mock('../../store/bruno-config', () => ({ getBrunoConfig: jest.fn(() => ({})) }));
jest.mock('../../store/process-env', () => ({ getProcessEnvVars: jest.fn(() => ({})) }));
jest.mock('../../store/preferences', () => ({ preferencesUtil: { shouldStoreCookies: () => false } }));
jest.mock('../../utils/cookies', () => ({ getDomainsWithCookies: jest.fn(async () => []) }));

const { cancelTokens } = require('../../utils/cancel-token');
const { runCollection } = require('./run-collection');

const httpItem = (uid, name, seq) => ({
  uid,
  name,
  seq,
  type: 'http-request',
  request: { method: 'GET', url: `http://localhost/${name}` }
});

const okResponse = () => ({
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  data: Readable.from([Buffer.from('{"ok":true}')]),
  config: { metadata: {} }
});

const makeDeps = (overrides = {}) => {
  const sentUrls = [];
  const deps = {
    emitRunFolderEvent: jest.fn(),
    emit: jest.fn(),
    onConsoleLog: jest.fn(),
    notifyScriptExecution: jest.fn(),
    sendVariableUpdates: jest.fn(),
    resetOauth2Credentials: jest.fn(),
    sendRunnerRequestSent: jest.fn(async ({ requestSent }) => sentUrls.push(requestSent.url)),
    sendRunnerResponseReceived: jest.fn(async () => {}),
    extractPromptVariablesForRequest: jest.fn(async () => []),
    runPreRequest: jest.fn(async () => undefined),
    runPostResponse: jest.fn(async () => undefined),
    runRequest: jest.fn(),
    configureRequest: jest.fn(async () => async () => okResponse()),
    executeRequestOnFailHandler: jest.fn(async () => {}),
    ...overrides
  };
  return { deps, sentUrls };
};

const events = (deps) => deps.emitRunFolderEvent.mock.calls.map(([e]) => e);
const eventTypes = (deps) => events(deps).map((e) => e.type);
const findEvent = (deps, type) => events(deps).find((e) => e.type === type);

const collectionWith = (items) => ({ uid: 'col-1', name: 'Col', pathname: '/tmp/col', items });

describe('runCollection', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs every request in seq order and reports progress only through the injected sinks', async () => {
    const collection = collectionWith([httpItem('b', 'B', 2), httpItem('a', 'A', 1), httpItem('c', 'C', 3)]);
    const { deps, sentUrls } = makeDeps();

    await runCollection({ collection, recursive: true, deps });

    expect(sentUrls).toEqual(['http://localhost/A', 'http://localhost/B', 'http://localhost/C']);
    expect(deps.sendRunnerResponseReceived).toHaveBeenCalledTimes(3);
    expect(eventTypes(deps)[0]).toBe('testrun-started');
    expect(eventTypes(deps).at(-1)).toBe('testrun-ended');
    expect(eventTypes(deps).filter((t) => t === 'request-queued')).toHaveLength(3);
    expect(deps.emit).toHaveBeenCalledWith('main:cookies-update', []);
    expect(findEvent(deps, 'testrun-ended').error).toBeUndefined();
    // the cancel token is cleaned up once the run ends
    expect(cancelTokens[findEvent(deps, 'testrun-started').cancelTokenUid]).toBeUndefined();
  });

  it('runs only the selected requests, in the selected order', async () => {
    const collection = collectionWith([httpItem('a', 'A', 1), httpItem('b', 'B', 2), httpItem('c', 'C', 3)]);
    const { deps, sentUrls } = makeDeps();

    await runCollection({ collection, recursive: true, selectedRequestUids: ['c', 'a'], deps });

    expect(sentUrls).toEqual(['http://localhost/C', 'http://localhost/A']);
  });

  it('skips gRPC requests and keeps going', async () => {
    const grpc = { ...httpItem('g', 'G', 1), type: 'grpc-request' };
    const collection = collectionWith([grpc, httpItem('a', 'A', 2)]);
    const { deps, sentUrls } = makeDeps();

    await runCollection({ collection, recursive: true, deps });

    const skipped = findEvent(deps, 'runner-request-skipped');
    expect(skipped).toMatchObject({ itemUid: 'g', error: 'gRPC requests are skipped in folder/collection runs' });
    expect(sentUrls).toEqual(['http://localhost/A']);
  });

  it('skips requests that contain prompt variables', async () => {
    const collection = collectionWith([httpItem('a', 'A', 1)]);
    const { deps, sentUrls } = makeDeps({ extractPromptVariablesForRequest: jest.fn(async () => ['token']) });

    await runCollection({ collection, recursive: true, deps });

    expect(sentUrls).toEqual([]);
    expect(eventTypes(deps)).toContain('runner-request-skipped');
  });

  it('follows setNextRequest jumps from the pre-request script', async () => {
    const collection = collectionWith([httpItem('a', 'A', 1), httpItem('b', 'B', 2), httpItem('c', 'C', 3)]);
    const runPreRequest = jest.fn(async (request) => (request.url.endsWith('/A') ? { nextRequestName: 'C' } : undefined));
    const { deps, sentUrls } = makeDeps({ runPreRequest });

    await runCollection({ collection, recursive: true, deps });

    expect(sentUrls).toEqual(['http://localhost/A', 'http://localhost/C']);
  });

  it('stops the run when a script calls stopExecution', async () => {
    const collection = collectionWith([httpItem('a', 'A', 1), httpItem('b', 'B', 2)]);
    const runPostResponse = jest.fn(async () => ({ stopExecution: true }));
    const { deps, sentUrls } = makeDeps({ runPostResponse });

    await runCollection({ collection, recursive: true, deps });

    expect(sentUrls).toEqual(['http://localhost/A']);
    expect(findEvent(deps, 'testrun-ended').statusText).toBe('collection run was terminated!');
  });

  it('reports a request that failed without a response and continues with the next one', async () => {
    const collection = collectionWith([httpItem('a', 'A', 1), httpItem('b', 'B', 2)]);
    let call = 0;
    const configureRequest = jest.fn(async () => async () => {
      call += 1;
      if (call === 1) throw new Error('connect ECONNREFUSED');
      return okResponse();
    });
    const { deps, sentUrls } = makeDeps({ configureRequest });

    await runCollection({ collection, recursive: true, deps });

    expect(deps.executeRequestOnFailHandler).toHaveBeenCalledTimes(1);
    expect(findEvent(deps, 'error')).toMatchObject({ itemUid: 'a', error: 'connect ECONNREFUSED' });
    expect(sentUrls).toEqual(['http://localhost/A', 'http://localhost/B']);
    expect(findEvent(deps, 'testrun-ended').error).toBeUndefined();
  });

  it('stops before the next request when the run is aborted through its cancel token', async () => {
    const collection = collectionWith([httpItem('a', 'A', 1), httpItem('b', 'B', 2)]);
    const emitRunFolderEvent = jest.fn();
    const configureRequest = jest.fn(async () => async () => {
      const started = emitRunFolderEvent.mock.calls.find(([e]) => e.type === 'testrun-started')[0];
      cancelTokens[started.cancelTokenUid].abort();
      return okResponse();
    });
    const { deps, sentUrls } = makeDeps({ emitRunFolderEvent, configureRequest });

    await runCollection({ collection, recursive: true, deps });

    expect(sentUrls).toEqual(['http://localhost/A']);
    // a cancelled run ends without reporting an error
    const ended = findEvent(deps, 'testrun-ended');
    expect(ended).toBeDefined();
    expect(ended.error).toBeNull();
  });

  it('runs a non-recursive folder over its direct requests only, skipping transient ones', async () => {
    const nested = { uid: 'f2', name: 'Nested', type: 'folder', items: [httpItem('n', 'N', 1)] };
    const folder = {
      uid: 'f1',
      name: 'Folder',
      type: 'folder',
      items: [httpItem('a', 'A', 1), { ...httpItem('t', 'T', 2), isTransient: true }, nested]
    };
    const collection = collectionWith([folder]);
    const { deps, sentUrls } = makeDeps();

    await runCollection({ folder, collection, recursive: false, deps });

    expect(sentUrls).toEqual(['http://localhost/A']);
    expect(deps.emitRunFolderEvent.mock.calls[0][0]).toMatchObject({ type: 'testrun-started', folderUid: 'f1' });
  });
});
