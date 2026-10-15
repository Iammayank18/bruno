const handlers = {};

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((channel, fn) => {
      handlers[channel] = fn;
    }),
    on: jest.fn()
  },
  app: {
    on: jest.fn(),
    getPath: jest.fn(() => require('node:os').tmpdir()),
    getVersion: jest.fn(() => '1.0.0')
  }
}));

jest.mock('../../services/runner/run-collection', () => ({
  runCollection: jest.fn(async () => {})
}));
jest.mock('./grpc-event-handlers', () => jest.fn());
jest.mock('./ws-event-handlers', () => ({ registerWsEventHandlers: jest.fn() }));

const { runCollection } = require('../../services/runner/run-collection');
const registerAllNetworkIpc = require('./index');
const { configureRequest, executeRequestOnFailHandler } = require('./index');

describe('renderer:run-collection-folder', () => {
  let mainWindow;

  beforeEach(() => {
    mainWindow = { webContents: { send: jest.fn() } };
    registerAllNetworkIpc(mainWindow);
  });

  it('delegates to runCollection with the renderer arguments', async () => {
    const folder = { uid: 'f1' };
    const collection = { uid: 'col-1' };
    const environment = { name: 'dev' };
    const tags = { include: ['smoke'], exclude: [] };

    await handlers['renderer:run-collection-folder']({}, folder, collection, environment, { r: 1 }, true, 50, tags, ['a']);

    expect(runCollection).toHaveBeenCalledTimes(1);
    const args = runCollection.mock.calls[0][0];
    expect(args).toMatchObject({
      folder,
      collection,
      environment,
      runtimeVariables: { r: 1 },
      recursive: true,
      delay: 50,
      tags,
      selectedRequestUids: ['a']
    });
    expect(args.deps.configureRequest).toBe(configureRequest);
    expect(args.deps.executeRequestOnFailHandler).toBe(executeRequestOnFailHandler);
    for (const dep of ['runPreRequest', 'runPostResponse', 'runRequest', 'sendVariableUpdates', 'resetOauth2Credentials', 'extractPromptVariablesForRequest', 'notifyScriptExecution', 'onConsoleLog']) {
      expect(typeof args.deps[dep]).toBe('function');
    }
  });

  it('routes run progress to main:run-folder-event and side-channel pushes to their own channels', async () => {
    await handlers['renderer:run-collection-folder']({}, null, { uid: 'col-1' }, null, {}, true, 0, null, []);
    const { deps } = runCollection.mock.calls.at(-1)[0];

    deps.emitRunFolderEvent({ type: 'testrun-started' });
    deps.emit('main:cookies-update', []);

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('main:run-folder-event', { type: 'testrun-started' });
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('main:cookies-update', []);
  });
});
