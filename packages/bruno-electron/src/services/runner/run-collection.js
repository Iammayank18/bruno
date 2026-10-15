const path = require('path');
const axios = require('axios');
const decomment = require('decomment');
const { each, get, cloneDeep } = require('lodash');
const { AssertRuntime, TestRuntime } = require('@usebruno/js');
const { refreshExplicitHeaderNames, isRequestTagsIncluded } = require('@usebruno/common');
const { buildScriptedEntry } = require('@usebruno/requests').scripting;
const { measureResponseTime } = require('@usebruno/requests');
const { buildCertsAndProxyConfig } = require('../../ipc/network/cert-utils');
const { appendScriptErrorResult } = require('../../ipc/network/script-result');
const { prepareRequest } = require('../../ipc/network/prepare-request');
const { completeOpenHop } = require('../../ipc/network/axios-instance');
const { saveCookies, promisifyStream } = require('../../ipc/network/response-utils');
const {
  sortFolder,
  getAllRequestsInFolderRecursively,
  getEnvVars,
  getEffectiveTagsByUid,
  sortByNameThenSequence,
  findItemInCollectionByPathname,
  getJsSandboxRuntime
} = require('../../utils/collection');
const { saveCancelToken, deleteCancelToken } = require('../../utils/cancel-token');
const { uuid, safeStringifyJSON, safeParseJSON, parseDataFromResponse, parseDataFromRequest } = require('../../utils/common');
const { getCollectionFormat, hasRequestExtension } = require('../../utils/filesystem');
const { getDomainsWithCookies } = require('../../utils/cookies');
const { getProcessEnvVars } = require('../../store/process-env');
const { getBrunoConfig } = require('../../store/bruno-config');
const { preferencesUtil } = require('../../store/preferences');
const { updateCollectionOauth2Credentials } = require('../../utils/oauth2');

/**
 * Runs a collection or folder: request selection (recursion, tags, selected uids),
 * scripts, tests, assertions, setNextRequest jumps and cancellation. Run progress is
 * reported through `deps.emitRunFolderEvent` and other renderer pushes through
 * `deps.emit`, so the pipeline doesn't depend on a BrowserWindow; the request and
 * script stages it needs from registerNetworkIpc arrive via `deps`.
 */
const runCollection = async ({ folder, collection, environment, runtimeVariables, recursive, delay, tags, selectedRequestUids, deps }) => {
  const {
    emitRunFolderEvent,
    emit, // (channel, payload) — side-channel pushes that don't ride the run-folder stream (cookies, credentials)
    onConsoleLog,
    notifyScriptExecution,
    sendVariableUpdates,
    resetOauth2Credentials,
    sendRunnerRequestSent,
    sendRunnerResponseReceived,
    extractPromptVariablesForRequest,
    runPreRequest,
    runPostResponse,
    runRequest,
    configureRequest,
    executeRequestOnFailHandler
  } = deps;

  const collectionUid = collection.uid;
  const collectionPath = collection.pathname;
  const folderUid = folder ? folder.uid : null;
  const cancelTokenUid = uuid();
  const brunoConfig = getBrunoConfig(collectionUid, collection);
  const scriptingConfig = get(brunoConfig, 'scripts', {});
  scriptingConfig.runtime = getJsSandboxRuntime(collection);
  scriptingConfig.cacheModules = false;
  const envVars = getEnvVars(environment);
  const processEnvVars = getProcessEnvVars(collectionUid);
  let stopRunnerExecution = false;
  let currentAbortController;

  const abortController = new AbortController();
  saveCancelToken(cancelTokenUid, abortController);

  abortController.signal.addEventListener('abort', () => {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  });

  // Tracks the outer runner item currently executing so a nested bru.runRequest
  // can route its oauth2 timeline entry back to this item.
  let currentRunnerEventData = null;

  const runRequestByItemPathname = async (relativeItemPathname, callerBru) => {
    return new Promise(async (resolve, reject) => {
      const format = getCollectionFormat(collection.pathname);
      let itemPathname = path.join(collection.pathname, relativeItemPathname);
      if (itemPathname && !hasRequestExtension(itemPathname, format)) {
        itemPathname = `${itemPathname}.${format}`;
      }
      const _item = cloneDeep(findItemInCollectionByPathname(collection, itemPathname));
      if (_item) {
        // WS/gRPC items live on separate IPC channels and can't be driven via
        // the HTTP runRequest. Record a Skipped row so the user sees feedback.
        if (_item.type === 'ws-request' || _item.type === 'grpc-request') {
          const protocolLabel = _item.type === 'ws-request' ? 'WebSocket' : 'gRPC';
          const startedAt = Date.now();
          callerBru?._recordScriptedRequest?.({
            source: 'runRequest',
            request: {
              method: (_item.request?.method || 'GET').toString().toUpperCase(),
              url: _item.request?.url,
              headers: {},
              data: null
            },
            response: {
              statusCode: null,
              statusText: 'Skipped',
              headers: {},
              data: null,
              dataBuffer: '',
              size: 0,
              duration: 0
            },
            error: null,
            startedAt,
            completedAt: startedAt
          });
          resolve({
            status: 'skipped',
            statusText: `bru.runRequest does not support ${protocolLabel} requests`,
            headers: {},
            data: null,
            duration: 0,
            size: 0
          });
          return;
        }

        const startedAt = Date.now();
        let res, err;
        try {
          res = await runRequest({
            item: _item,
            collection,
            envVars,
            processEnvVars,
            runtimeVariables,
            runInBackground: true,
            parentExecutionMode: 'runner',
            parentRunnerEventData: currentRunnerEventData
          });
        } catch (e) {
          err = e;
        }
        const completedAt = Date.now();
        const sent = res?.requestSent || {};
        callerBru?._recordScriptedRequest?.({
          source: 'runRequest',
          ...buildScriptedEntry({
            request: {
              method: sent.method,
              url: sent.url || res?.url,
              headers: sent.headers,
              data: sent.data
            },
            response: res
              ? {
                  status: res.status,
                  statusText: res.statusText,
                  headers: res.headers,
                  data: res.data,
                  dataBuffer: res.dataBuffer,
                  size: res.size,
                  duration: res.duration,
                  timeline: res.timeline
                }
              : null,
            error: err || (res?.error ? { message: res.error } : null),
            startedAt,
            completedAt
          })
        });
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
        return;
      }
      reject(`bru.runRequest: invalid request path - ${itemPathname}`);
    });
  };

  if (!folder) {
    folder = collection;
  }

  emitRunFolderEvent({
    type: 'testrun-started',
    isRecursive: recursive,
    collectionUid,
    folderUid,
    cancelTokenUid
  });

  try {
    let folderRequests = [];

    if (recursive) {
      let sortedFolder = sortFolder(folder);
      folderRequests = getAllRequestsInFolderRecursively(sortedFolder);
    } else {
      each(folder.items, (item) => {
        // Skip transient requests
        if (item.request && !item.isTransient) {
          folderRequests.push(item);
        }
      });

      // sort requests by seq property
      folderRequests = sortByNameThenSequence(folderRequests);
    }

    // Filter requests based on tags
    const includeTags = tags?.include || [];
    const excludeTags = tags?.exclude || [];
    if (includeTags.length || excludeTags.length) {
      const effectiveTagsByUid = getEffectiveTagsByUid(collection);
      folderRequests = folderRequests.filter((request) =>
        isRequestTagsIncluded(effectiveTagsByUid.get(request.uid) || [], includeTags, excludeTags)
      );
    }

    // Filter requests based on selectedRequestUids (for "Configure requests to run")
    if (selectedRequestUids && selectedRequestUids.length > 0) {
      const uidIndexMap = new Map();
      selectedRequestUids.forEach((uid, index) => {
        uidIndexMap.set(uid, index);
      });

      folderRequests = folderRequests
        .filter((request) => uidIndexMap.has(request.uid))
        .sort((a, b) => {
          const indexA = uidIndexMap.get(a.uid);
          const indexB = uidIndexMap.get(b.uid);
          return indexA - indexB;
        });
    }

    let currentRequestIndex = 0;
    let nJumps = 0; // count the number of jumps to avoid infinite loops
    while (currentRequestIndex < folderRequests.length) {
      // user requested to cancel runner
      if (abortController.signal.aborted) {
        let error = new Error('Runner execution cancelled');
        error.isCancel = true;
        throw error;
      }

      stopRunnerExecution = false;

      const item = cloneDeep(folderRequests[currentRequestIndex]);
      let nextRequestName;
      const itemUid = item.uid;
      const eventData = {
        collectionUid,
        folderUid,
        itemUid
      };
      currentRunnerEventData = eventData;

      const emitRunnerScriptedRequestEvents = (phase, scriptResult) => {
        const entries = scriptResult?.scriptedRequestEntries || [];
        entries.forEach((entry) => {
          emitRunFolderEvent({
            type: 'scripted-request',
            ...eventData,
            phase,
            source: entry.source,
            scope: entry.scope || null,
            timestamp: entry.startedAt,
            data: { request: entry.request, response: entry.response, error: entry.error }
          });
        });
      };

      const requestUid = uuid();

      emitRunFolderEvent({
        type: 'request-queued',
        requestUid,
        ...eventData
      });

      // Skip gRPC requests
      if (item.type === 'grpc-request') {
        emitRunFolderEvent({
          type: 'runner-request-skipped',
          error: 'gRPC requests are skipped in folder/collection runs',
          responseReceived: {
            status: 'skipped',
            statusText: 'gRPC request skipped',
            data: null,
            responseTime: 0,
            headers: null
          },
          ...eventData
        });
        currentRequestIndex++;
        continue;
      }

      const request = await prepareRequest(item, collection, abortController);
      request.__bruno__executionMode = 'runner';

      const promptVars = await extractPromptVariablesForRequest({ request, collection, envVars, runtimeVariables, processEnvVars });

      if (promptVars.length > 0) {
        emitRunFolderEvent({
          type: 'runner-request-skipped',
          error: 'Request has been skipped due to containing prompt variables',
          responseReceived: {
            status: 'skipped',
            statusText: `Prompt variables detected in request. Runner execution is not supported for requests with prompt variables. \n Promps: ${promptVars.join(', ')}`,
            data: null,
            responseTime: 0,
            headers: null
          },
          ...eventData
        });

        currentRequestIndex++;

        continue;
      }

      try {
        // Build certsAndProxyConfig for bru.sendRequest
        const certsAndProxyConfig = await buildCertsAndProxyConfig({
          collectionUid,
          collection,
          collectionPath,
          envVars,
          runtimeVariables,
          processEnvVars,
          request
        });

        // Add certsAndProxyConfig to request object for bru.sendRequest
        request.certsAndProxyConfig = certsAndProxyConfig;

        let preRequestScriptResult;
        let preRequestError = null;
        try {
          preRequestScriptResult = await runPreRequest(
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
          );
        } catch (error) {
          console.error('Pre-request script error:', error);
          preRequestError = error;
        }

        if (preRequestError?.partialResults) {
          preRequestScriptResult = preRequestError.partialResults;
          sendVariableUpdates(preRequestScriptResult, { collectionUid, requestUid, collection });
        }

        preRequestScriptResult = appendScriptErrorResult('pre-request', preRequestScriptResult, preRequestError);
        emitRunnerScriptedRequestEvents('pre-request', preRequestScriptResult);

        if (preRequestScriptResult?.results) {
          emitRunFolderEvent({
            type: 'test-results-pre-request',
            preRequestTestResults: preRequestScriptResult.results,
            ...eventData
          });
        }

        notifyScriptExecution({
          channel: 'main:run-folder-event',
          basePayload: eventData,
          scriptType: 'pre-request',
          error: preRequestError,
          itemPathname: item.pathname,
          collectionPath,
          scriptMetadata: request.script?.reqMetadata
        });

        const domainsWithCookiesPreRequest = await getDomainsWithCookies();
        emit('main:cookies-update', safeParseJSON(safeStringifyJSON(domainsWithCookiesPreRequest)));

        if (preRequestError) {
          throw preRequestError;
        }

        if (preRequestScriptResult?.nextRequestName !== undefined) {
          nextRequestName = preRequestScriptResult.nextRequestName;
        }

        if (preRequestScriptResult?.stopExecution) {
          stopRunnerExecution = true;
        }

        if (preRequestScriptResult?.skipRequest) {
          emitRunFolderEvent({
            type: 'runner-request-skipped',
            error: 'Request has been skipped from pre-request script',
            responseReceived: {
              status: 'skipped',
              statusText: 'request skipped via pre-request script',
              data: null,
              responseTime: 0,
              headers: null
            },
            ...eventData
          });
          currentRequestIndex++;
          continue;
        }

        const { data: requestData, dataBuffer: requestDataBuffer } = parseDataFromRequest(request);

        // Remove false Content-Type header (used to stop axios from auto-setting it); no Content-Type was actually set or sent.
        const headersSent = { ...request.headers };
        Object.keys(headersSent).forEach((key) => {
          if (key.toLowerCase() === 'content-type' && headersSent[key] === false) {
            delete headersSent[key];
          }
        });

        let requestSent = {
          url: request.url,
          method: request.method,
          headers: headersSent,
          data: requestData,
          dataBuffer: requestDataBuffer,
          timestamp: Date.now()
        };

        // todo:
        // i have no clue why electron can't send the request object
        // without safeParseJSON(safeStringifyJSON(request.data))
        await sendRunnerRequestSent({ requestUid, requestSent, eventData });

        currentAbortController = new AbortController();
        request.signal = currentAbortController.signal;
        request.responseType = 'stream';
        const axiosInstance = await configureRequest(
          collectionUid,
          collection,
          request,
          envVars,
          runtimeVariables,
          processEnvVars,
          collectionPath,
          collection.globalEnvironmentVariables
        );

        if (request.oauth2Credentials?.credentials && request.oauth2Credentials?.credentialsId) {
          emit('main:credentials-update', {
            credentials: request?.oauth2Credentials?.credentials,
            url: request?.oauth2Credentials?.url,
            collectionUid,
            credentialsId: request?.oauth2Credentials?.credentialsId,
            ...(request?.oauth2Credentials?.folderUid ? { folderUid: request.oauth2Credentials.folderUid } : { itemUid: item.uid }),
            debugInfo: request?.oauth2Credentials?.debugInfo,
            // Reducer updates the cache but skips the timeline push for 'runner'.
            executionMode: 'runner'
          });

          // RunnerTimeline reads oauth from the runner item, not collection.timeline.
          if (request.oauth2Credentials.debugInfo) {
            emitRunFolderEvent({
              type: 'oauth2-debug',
              ...eventData,
              url: request.oauth2Credentials.url,
              credentialsId: request.oauth2Credentials.credentialsId,
              debugInfo: request.oauth2Credentials.debugInfo
            });
          }

          const { credentialsId, credentials } = request.oauth2Credentials;
          request.oauth2CredentialVariables = request.oauth2CredentialVariables || {};
          Object.entries(credentials).forEach(([key, value]) => {
            request.oauth2CredentialVariables[`$oauth2.${credentialsId}.${key}`] = value;
          });

          collection.oauth2Credentials = updateCollectionOauth2Credentials({
            itemUid: item.uid,
            collectionUid,
            collectionOauth2Credentials: collection.oauth2Credentials,
            requestOauth2Credentials: request.oauth2Credentials
          });
        }

        let response, responseTime;
        try {
          if (delay && !Number.isNaN(delay) && delay > 0) {
            const delayPromise = new Promise((resolve) => setTimeout(resolve, delay));

            const cancellationPromise = new Promise((_, reject) => {
              abortController.signal.addEventListener('abort', () => {
                reject(new Error('Cancelled'));
              });
            });

            await Promise.race([delayPromise, cancellationPromise]);
          }

          /** @type {import('axios').AxiosResponse} */
          response = await axiosInstance(refreshExplicitHeaderNames(request));
          response.data = await promisifyStream(response.data, currentAbortController, false);
          completeOpenHop(response.config);
          response.responseTime = measureResponseTime(response.config.metadata);

          const { data, dataBuffer } = parseDataFromResponse(response, request.__brunoDisableParsingResponseJson);
          response.data = data;
          response.dataBuffer = dataBuffer;

          // save cookies
          if (preferencesUtil.shouldStoreCookies()) {
            saveCookies(request.url, response.headers);
          }

          // send domain cookies to renderer
          const domainsWithCookies = await getDomainsWithCookies();

          emit('main:cookies-update', safeParseJSON(safeStringifyJSON(domainsWithCookies)));

          await sendRunnerResponseReceived({
            requestUid,
            responseReceived: {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              duration: response.responseTime,
              dataBuffer: dataBuffer.toString('base64'),
              size: Buffer.byteLength(dataBuffer),
              data: response.data,
              responseTime: response.responseTime,
              timeline: response.timeline,
              url: response.request ? response.request.protocol + '//' + response.request.host + response.request.path : null
            },
            disableParsingResponseJson: Boolean(request.__brunoDisableParsingResponseJson),
            eventData
          });
        } catch (error) {
          // Skip further processing if request was cancelled
          if (axios.isCancel(error)) {
            throw error;
          }

          if (error?.response) {
            error.response.data = await promisifyStream(error.response.data, currentAbortController, false);
            completeOpenHop(error.response.config);
            error.response.responseTime = measureResponseTime(error.response.config.metadata);
            const { data, dataBuffer } = parseDataFromResponse(error.response, request.__brunoDisableParsingResponseJson);
            error.response.data = data;
            error.response.dataBuffer = dataBuffer;

            // save cookies (4XX/5XX responses can also set cookies)
            if (preferencesUtil.shouldStoreCookies()) {
              saveCookies(request.url, error.response.headers);
            }

            response = {
              status: error.response.status,
              statusText: error.response.statusText,
              headers: error.response.headers,
              duration: error.response.responseTime,
              dataBuffer: dataBuffer.toString('base64'),
              size: Buffer.byteLength(dataBuffer),
              data: error.response.data,
              responseTime: error.response.responseTime,
              timeline: error.response.timeline
            };

            // if we get a response from the server, we consider it as a success
            await sendRunnerResponseReceived({
              requestUid,
              error: error ? error.message : 'An error occurred while running the request',
              responseReceived: response,
              eventData,
              disableParsingResponseJson: Boolean(request.__brunoDisableParsingResponseJson)
            });
          } else {
            await executeRequestOnFailHandler(request, error, (onFailScriptResult) => {
              sendVariableUpdates(onFailScriptResult, { collectionUid, requestUid, collection });
            });

            // if it's not a network error, don't continue
            throw error;
          }
        }

        let postResponseScriptResult;
        let postResponseError = null;
        try {
          postResponseScriptResult = await runPostResponse(
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
          );
        } catch (error) {
          console.error('Post-response script error:', error);
          postResponseError = error;
        }

        // Extract partial results from error if available
        // (e.g., if 2 tests pass then script throws, we still want to show those 2 passing tests)
        if (postResponseError?.partialResults) {
          postResponseScriptResult = postResponseError.partialResults;
          sendVariableUpdates(postResponseScriptResult, { collectionUid, requestUid, collection });
        }

        postResponseScriptResult = appendScriptErrorResult('post-response', postResponseScriptResult, postResponseError);
        emitRunnerScriptedRequestEvents('post-response', postResponseScriptResult);

        notifyScriptExecution({
          channel: 'main:run-folder-event',
          basePayload: eventData,
          scriptType: 'post-response',
          error: postResponseError,
          itemPathname: item.pathname,
          collectionPath,
          scriptMetadata: request.script?.resMetadata
        });

        const domainsWithCookiesPostResponse = await getDomainsWithCookies();
        emit('main:cookies-update', safeParseJSON(safeStringifyJSON(domainsWithCookiesPostResponse)));

        if (postResponseScriptResult?.nextRequestName !== undefined) {
          nextRequestName = postResponseScriptResult.nextRequestName;
        }

        if (postResponseScriptResult?.stopExecution) {
          stopRunnerExecution = true;
        }

        // Send post-response test results if available
        if (postResponseScriptResult?.results) {
          emitRunFolderEvent({
            type: 'test-results-post-response',
            postResponseTestResults: postResponseScriptResult.results,
            ...eventData
          });
        }

        // run assertions
        const assertions = get(item, 'request.assertions');
        if (assertions) {
          const assertRuntime = new AssertRuntime({ runtime: scriptingConfig?.runtime });
          const results = assertRuntime.runAssertions(
            assertions,
            request,
            response,
            envVars,
            runtimeVariables,
            processEnvVars
          );

          emitRunFolderEvent({
            type: 'assertion-results',
            assertionResults: results,
            itemUid: item.uid,
            collectionUid
          });
        }

        const testFile = get(request, 'tests');
        const collectionName = collection?.name;
        if (typeof testFile === 'string') {
          let testResults = null;
          let testError = null;

          try {
            const testRuntime = new TestRuntime({ runtime: scriptingConfig?.runtime });
            testResults = await testRuntime.runTests(
              decomment(testFile, { space: true }),
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
          } catch (error) {
            testError = error;

            if (error.partialResults) {
              testResults = error.partialResults;
            } else {
              testResults = {
                request,
                envVariables: envVars,
                runtimeVariables,
                globalEnvironmentVariables: request?.globalEnvironmentVariables || {},
                results: [],
                nextRequestName: null
              };
            }
          }

          testResults = appendScriptErrorResult('test', testResults, testError);
          emitRunnerScriptedRequestEvents('tests', testResults);

          if (testResults?.nextRequestName !== undefined) {
            nextRequestName = testResults.nextRequestName;
          }

          if (testResults?.stopExecution) {
            stopRunnerExecution = true;
          }

          emitRunFolderEvent({
            type: 'test-results',
            testResults: testResults.results,
            ...eventData
          });

          sendVariableUpdates(testResults, { collectionUid, requestUid, collection });
          resetOauth2Credentials({ oauth2CredentialsToReset: testResults.oauth2CredentialsToReset, request, collectionUid });

          notifyScriptExecution({
            channel: 'main:run-folder-event',
            basePayload: eventData,
            scriptType: 'test',
            error: testError,
            itemPathname: item.pathname,
            collectionPath,
            scriptMetadata: request.testsMetadata
          });

          const domainsWithCookiesTest = await getDomainsWithCookies();
          emit('main:cookies-update', safeParseJSON(safeStringifyJSON(domainsWithCookiesTest)));
        }
      } catch (error) {
        emitRunFolderEvent({
          type: 'error',
          error: error ? error.message : 'An error occurred while running the request',
          responseReceived: {},
          ...eventData
        });
      }

      if (stopRunnerExecution) {
        deleteCancelToken(cancelTokenUid);
        emitRunFolderEvent({
          type: 'testrun-ended',
          collectionUid,
          folderUid,
          statusText: 'collection run was terminated!',
          runCompletionTime: new Date().toISOString()
        });
        break;
      }

      if (nextRequestName !== undefined) {
        nJumps++;
        if (nJumps > 10000) {
          throw new Error('Too many jumps, possible infinite loop');
        }
        if (nextRequestName === null) {
          break;
        }
        const nextRequestIdx = folderRequests.findIndex((request) => request.name === nextRequestName);
        if (nextRequestIdx >= 0) {
          currentRequestIndex = nextRequestIdx;
        } else {
          console.error('Could not find request with name \'' + nextRequestName + '\'');
          currentRequestIndex++;
        }
      } else {
        currentRequestIndex++;
      }
    }

    deleteCancelToken(cancelTokenUid);
    if (!stopRunnerExecution) {
      emitRunFolderEvent({
        type: 'testrun-ended',
        collectionUid,
        folderUid,
        runCompletionTime: new Date().toISOString()
      });
    }
  } catch (error) {
    console.log('error', error);
    deleteCancelToken(cancelTokenUid);
    emitRunFolderEvent({
      type: 'testrun-ended',
      collectionUid,
      folderUid,
      runCompletionTime: new Date().toISOString(),
      error: error && !error.isCancel ? error : null
    });
  }
};

module.exports = { runCollection };
