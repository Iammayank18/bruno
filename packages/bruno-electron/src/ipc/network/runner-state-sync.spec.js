jest.mock('../../utils/oauth2', () => ({ clearOauth2CredentialsByCredentialsId: jest.fn() }));
jest.mock('./apply-collection-vars', () => ({ applyCollectionVarsToCollectionRoot: jest.fn() }));

const { clearOauth2CredentialsByCredentialsId } = require('../../utils/oauth2');
const { applyCollectionVarsToCollectionRoot } = require('./apply-collection-vars');
const { createRunnerStateSync } = require('./runner-state-sync');

describe('createRunnerStateSync', () => {
  let emit;
  let sync;

  beforeEach(() => {
    jest.clearAllMocks();
    emit = jest.fn();
    sync = createRunnerStateSync({ emit });
  });

  describe('sendVariableUpdates', () => {
    const ctx = () => ({ collectionUid: 'col-1', requestUid: 'req-1', collection: { uid: 'col-1' } });

    it('pushes nothing when the script changed no variables', () => {
      sync.sendVariableUpdates({}, ctx());
      expect(emit).not.toHaveBeenCalled();
    });

    it('pushes each variable scope on its channel', () => {
      const result = {
        runtimeVariables: { a: 1 },
        envVariables: { b: 2 },
        globalEnvironmentVariables: { c: 3 },
        collectionVariables: { d: 4 }
      };
      sync.sendVariableUpdates(result, ctx());

      expect(emit.mock.calls.map(([channel]) => channel)).toEqual([
        'main:runtime-variables-update',
        'main:script-environment-update',
        'main:global-environment-variables-update',
        'main:collection-variables-update'
      ]);
      expect(emit).toHaveBeenCalledWith('main:runtime-variables-update', {
        runtimeVariables: { a: 1 },
        requestUid: 'req-1',
        collectionUid: 'col-1'
      });
    });

    it('applies global and collection variables to the in-memory collection even with a no-op emit', () => {
      const noop = createRunnerStateSync({ emit: () => {} });
      const c = ctx();
      noop.sendVariableUpdates({ globalEnvironmentVariables: { g: 1 }, collectionVariables: { v: 2 } }, c);

      expect(c.collection.globalEnvironmentVariables).toEqual({ g: 1 });
      expect(applyCollectionVarsToCollectionRoot).toHaveBeenCalledWith(c.collection, { v: 2 });
    });
  });

  describe('resetOauth2Credentials', () => {
    it('does nothing when there is nothing to reset', () => {
      sync.resetOauth2Credentials({ oauth2CredentialsToReset: [], request: {}, collectionUid: 'col-1' });
      expect(clearOauth2CredentialsByCredentialsId).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('clears the cache, the request copy and the derived variables for each credential', () => {
      const request = {
        oauth2Credentials: { credentialsId: 'cred-a' },
        oauth2CredentialVariables: {
          '$oauth2.cred-a.access_token': 'x',
          '$oauth2.cred-b.access_token': 'y'
        }
      };

      sync.resetOauth2Credentials({ oauth2CredentialsToReset: ['cred-a'], request, collectionUid: 'col-1' });

      expect(clearOauth2CredentialsByCredentialsId).toHaveBeenCalledWith({ collectionUid: 'col-1', credentialsId: 'cred-a' });
      expect(request.oauth2Credentials).toBeNull();
      expect(request.oauth2CredentialVariables).toEqual({ '$oauth2.cred-b.access_token': 'y' });
      expect(emit).toHaveBeenCalledWith('main:credentials-clear', { collectionUid: 'col-1', credentialsId: 'cred-a' });
    });
  });
});
