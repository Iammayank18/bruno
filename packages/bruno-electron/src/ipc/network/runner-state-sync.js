const { applyCollectionVarsToCollectionRoot } = require('./apply-collection-vars');
const { clearOauth2CredentialsByCredentialsId } = require('../../utils/oauth2');

/**
 * Post-script state sync for the run pipelines: variables that scripts set at
 * runtime are pushed to the renderer and applied to the in-memory collection
 * object, and oauth2 credentials a script asks to reset are cleared from the
 * cache. Window pushes go through the injected `emit`; the in-process
 * mutations always run, whatever `emit` does.
 */
const createRunnerStateSync = ({ emit }) => {
  const sendVariableUpdates = (result, { collectionUid, requestUid, collection }) => {
    if (result.runtimeVariables) {
      emit('main:runtime-variables-update', {
        runtimeVariables: result.runtimeVariables,
        requestUid,
        collectionUid
      });
    }

    if (result.envVariables) {
      emit('main:script-environment-update', {
        envVariables: result.envVariables,
        requestUid,
        collectionUid
      });
    }

    if (result.globalEnvironmentVariables) {
      emit('main:global-environment-variables-update', {
        globalEnvironmentVariables: result.globalEnvironmentVariables,
        requestUid,
        collectionUid
      });
      collection.globalEnvironmentVariables = result.globalEnvironmentVariables;
    }

    if (result.collectionVariables) {
      emit('main:collection-variables-update', {
        collectionVariables: result.collectionVariables,
        requestUid,
        collectionUid
      });
      applyCollectionVarsToCollectionRoot(collection, result.collectionVariables);
    }
  };

  const resetOauth2Credentials = ({ oauth2CredentialsToReset, request, collectionUid }) => {
    if (!oauth2CredentialsToReset?.length) return;
    for (const credentialId of oauth2CredentialsToReset) {
      clearOauth2CredentialsByCredentialsId({ collectionUid, credentialsId: credentialId });
      if (request?.oauth2Credentials?.credentialsId === credentialId) {
        request.oauth2Credentials = null;
      }
      const prefix = `$oauth2.${credentialId}.`;
      if (request.oauth2CredentialVariables) {
        for (const key of Object.keys(request.oauth2CredentialVariables)) {
          if (key.startsWith(prefix)) {
            delete request.oauth2CredentialVariables[key];
          }
        }
      }
      emit('main:credentials-clear', { collectionUid, credentialsId: credentialId });
    }
  };

  return { sendVariableUpdates, resetOauth2Credentials };
};

module.exports = { createRunnerStateSync };
