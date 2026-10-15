const { extractPromptVariables } = require('@usebruno/common').utils;
const { getCertsAndProxyConfig } = require('./cert-utils');

/**
 * Extracts prompt variables from a prepared request. Tries to respect the
 * hierarchy of the variables and avoid unnecessary prompts as much as possible.
 * Note: TO BE CALLED ONLY AFTER THE PREPARE REQUEST.
 *
 * @param {*} request - request object built by prepareRequest
 * @returns {string[]} An array of extracted prompt variables
 */
const extractPromptVariablesForRequest = async ({ request, collection, envVars: collectionEnvironmentVars, runtimeVariables, processEnvVars }) => {
  const { globalEnvironmentVariables, collectionVariables, folderVariables, requestVariables, ...requestObj } = request;

  const allVariables = {
    ...globalEnvironmentVariables,
    ...collectionEnvironmentVars,
    ...collectionVariables,
    ...folderVariables,
    ...requestVariables,
    ...runtimeVariables,
    process: {
      env: {
        ...processEnvVars
      }
    }
  };

  const { interpolationOptions, ...certsAndProxyConfig } = await getCertsAndProxyConfig({
    collectionUid: collection.uid,
    collection,
    request,
    envVars: collectionEnvironmentVars,
    runtimeVariables,
    processEnvVars,
    collectionPath: collection.pathname,
    globalEnvironmentVariables
  });

  const prompts = extractPromptVariables(requestObj);
  prompts.push(...extractPromptVariables(allVariables));
  prompts.push(...extractPromptVariables(certsAndProxyConfig));

  // return unique prompt variables
  return Array.from(new Set(prompts));
};

module.exports = { extractPromptVariablesForRequest };
