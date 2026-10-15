const { addCookieToJar } = require('../../utils/cookies');
const { preferencesUtil } = require('../../store/preferences');

/**
 * Response helpers shared by the single-request path (ipc/network/index.js) and
 * the collection runner (services/runner/run-collection.js).
 */

const saveCookies = (url, headers) => {
  if (preferencesUtil.shouldStoreCookies()) {
    let setCookieHeaders = [];
    if (headers['set-cookie']) {
      setCookieHeaders = Array.isArray(headers['set-cookie'])
        ? headers['set-cookie']
        : [headers['set-cookie']];
      for (let setCookieHeader of setCookieHeaders) {
        if (typeof setCookieHeader === 'string' && setCookieHeader.length) {
          addCookieToJar(setCookieHeader, url);
        }
      }
    }
  }
};

const promisifyStream = async (stream, abortController, closeOnFirst) => {
  const chunks = [];

  return new Promise((resolve, reject) => {
    const doResolve = () => {
      const fullBuffer = Buffer.concat(chunks);
      resolve(fullBuffer.buffer.slice(fullBuffer.byteOffset, fullBuffer.byteOffset + fullBuffer.byteLength));
    };

    stream.on('data', (chunk) => {
      chunks.push(chunk);

      if (closeOnFirst) {
        doResolve();

        if (abortController) {
          abortController.abort();
        }
      }
    });

    stream.on('close', doResolve);
    stream.on('error', (err) => reject(err));
  });
};

module.exports = { saveCookies, promisifyStream };
