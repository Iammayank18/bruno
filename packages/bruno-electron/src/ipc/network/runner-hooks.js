const get = require('lodash/get');
const extend = require('lodash/extend');
const qs = require('qs');
const decomment = require('decomment');
const { ScriptRuntime, VarsRuntime } = require('@usebruno/js');
const { encodeUrl, hasExplicitScheme, buildFormUrlEncodedPayload, isFormData, getMediaType, extractBoundaryFromContentType } = require('@usebruno/common').utils;
const { applySentHeadersToRequest } = require('@usebruno/requests');
const interpolateVars = require('./interpolate-vars');
const { safeStringifyJSON, safeParseJSON, isBinaryRequestBody } = require('../../utils/common');
const { getDomainsWithCookies } = require('../../utils/cookies');
const { createFormData } = require('../../utils/form-data');

/**
 * The per-request script/interpolation stages of the run pipeline (pre-request
 * script, interpolation and body shaping; post-response vars and script). Pushes
 * to the renderer (cookie and variable updates) go through the injected `emit` and
 * state-sync callbacks, so the stages don't depend on a BrowserWindow.
 */

const createRunnerHooks = ({ onConsoleLog, sendVariableUpdates, resetOauth2Credentials, emit }) => {
  const runPreRequest = async (
    request,
    requestUid,
    envVars,
    collectionPath,
    collection,
    collectionUid,
    runtimeVariables,
    processEnvVars,
    scriptingConfig,
    runRequestByItemPathname
  ) => {
    // run pre-request script
    let scriptResult;
    const { promptVariables = {}, name: collectionName } = collection;

    const requestScript = get(request, 'script.req');
    if (requestScript?.length) {
      const scriptRuntime = new ScriptRuntime({ runtime: scriptingConfig?.runtime });
      scriptResult = await scriptRuntime.runRequestScript(
        decomment(requestScript, { space: true }),
        request,
        envVars,
        runtimeVariables,
        collectionPath,
        onConsoleLog,
        processEnvVars,
        scriptingConfig,
        runRequestByItemPathname,
        collectionName
      );

      sendVariableUpdates(scriptResult, { collectionUid, requestUid, collection });
      resetOauth2Credentials({ oauth2CredentialsToReset: scriptResult.oauth2CredentialsToReset, request, collectionUid });

      const domainsWithCookies = await getDomainsWithCookies();
      emit('main:cookies-update', safeParseJSON(safeStringifyJSON(domainsWithCookies)));
    }

    // interpolate variables inside request
    interpolateVars(request, envVars, runtimeVariables, processEnvVars, promptVariables);

    if (!hasExplicitScheme(request.url)) {
      // The scheme must be present before encoding. Without a `://`, encodeUrl
      // treats a `host:port` authority as a path segment and percent-encodes the
      // port colon (localhost:6000 → localhost%3A6000), which then resolves to a
      // bogus host once configureRequest prepends http://.
      request.url = `http://${request.url}`;
    }

    if (request.settings?.encodeUrl) {
      request.url = encodeUrl(request.url);
    }

    // if this is a graphql request, parse the variables, only after interpolation
    // https://github.com/usebruno/bruno/issues/884
    if (request.mode === 'graphql' && typeof request.data?.variables === 'string') {
      try {
        request.data.variables = JSON.parse(request.data.variables);
      } catch (err) {
        throw new Error(`Failed to parse GraphQL variables: ${err.message}`);
      }
    }

    // stringify the request url encoded params
    const contentTypeHeader = Object.keys(request.headers).find((name) => name.toLowerCase() === 'content-type');

    const contentType = contentTypeHeader ? request.headers[contentTypeHeader] : '';
    const mediaType = getMediaType(contentType);

    if (mediaType === 'application/x-www-form-urlencoded') {
      if (Array.isArray(request.data)) {
        request.data = buildFormUrlEncodedPayload(request.data);
      } else if (typeof request.data !== 'string' && !isBinaryRequestBody(request.data)) {
        request.data = qs.stringify(request.data, { arrayFormat: 'repeat' });
      }
      // string and file (Buffer/stream) bodies are sent as-is (assumed already encoded)
    }

    if (mediaType.startsWith('multipart/')) {
      if (typeof request.data !== 'string' && !isFormData(request.data) && !isBinaryRequestBody(request.data)) {
        request._originalMultipartData = request.data;
        request.collectionPath = collectionPath;
        const existingBoundary = extractBoundaryFromContentType(contentType);
        let form = createFormData(request.data, collectionPath, existingBoundary);
        request.data = form;
        if (contentType !== 'multipart/form-data') {
          // Patch: Axios leverages getHeaders method to get the headers so FormData should be monkey patched
          const formHeaders = form.getHeaders();
          if (existingBoundary) {
            formHeaders['content-type'] = contentType;
          } else {
            formHeaders['content-type'] = `${contentType}; boundary=${form.getBoundary()}`;
          }
          form.getHeaders = function () {
            return formHeaders;
          };
        }

        extend(request.headers, form.getHeaders());
      }
    }
    return scriptResult;
  };

  const runPostResponse = async (
    request,
    response,
    requestUid,
    envVars,
    collectionPath,
    collection,
    collectionUid,
    runtimeVariables,
    processEnvVars,
    scriptingConfig,
    runRequestByItemPathname
  ) => {
    applySentHeadersToRequest(request, response);
    // run post-response vars
    const postResponseVars = get(request, 'vars.res', []);
    if (postResponseVars?.length) {
      const varsRuntime = new VarsRuntime({ runtime: scriptingConfig?.runtime });
      const result = varsRuntime.runPostResponseVars(
        postResponseVars,
        request,
        response,
        envVars,
        runtimeVariables,
        collectionPath,
        processEnvVars
      );

      if (result) {
        sendVariableUpdates(result, { collectionUid, requestUid, collection });
      }

      if (result?.error) {
        emit('main:display-error', result.error);
      }
    }

    // run post-response script
    const responseScript = get(request, 'script.res');
    let scriptResult;
    const collectionName = collection?.name;
    if (responseScript?.length) {
      const scriptRuntime = new ScriptRuntime({ runtime: scriptingConfig?.runtime });
      scriptResult = await scriptRuntime.runResponseScript(
        decomment(responseScript, { space: true }),
        request,
        response,
        envVars,
        runtimeVariables,
        collectionPath,
        onConsoleLog,
        processEnvVars,
        scriptingConfig,
        runRequestByItemPathname,
        collectionName
      );

      sendVariableUpdates(scriptResult, { collectionUid, requestUid, collection });
      resetOauth2Credentials({ oauth2CredentialsToReset: scriptResult.oauth2CredentialsToReset, request, collectionUid });

      const domainsWithCookiesPost = await getDomainsWithCookies();
      emit('main:cookies-update', safeParseJSON(safeStringifyJSON(domainsWithCookiesPost)));
    }
    return scriptResult;
  };
  return { runPreRequest, runPostResponse };
};

module.exports = { createRunnerHooks };
