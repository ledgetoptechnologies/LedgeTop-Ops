'use strict';

// Archive-only native HTTP transport. It never uses fetch/Undici's HTTP parser,
// changes process-wide TLS settings, follows redirects, or buffers the body.
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');

function timeoutError() {
  return Object.assign(new Error('Provider archive transfer timed out'), { code: 'ETIMEDOUT' });
}

function downloadProviderArchive(input, { signal = null, timeoutMs = 6 * 3600_000, headersTimeoutMs = 30_000 } = {}) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('Invalid provider archive endpoint');
  }
  for (const value of [timeoutMs, headersTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1) throw new TypeError('Invalid provider archive timeout');
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let request, response, answered = false, finished = false;
    let totalTimer, headersTimer;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(totalTimer); clearTimeout(headersTimer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = error => {
      if (!answered) { answered = true; reject(error); }
      response?.destroy(error);
      request?.destroy(error);
      cleanup();
    };
    const abort = () => fail(signal.reason);
    totalTimer = setTimeout(() => fail(timeoutError()), timeoutMs);
    headersTimer = setTimeout(() => fail(timeoutError()), headersTimeoutMs);
    totalTimer.unref(); headersTimer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const transport = url.protocol === 'https:' ? https : http;
      // Default HTTPS trust/hostname verification includes NODE_EXTRA_CA_CERTS.
      // agent:false gives this transfer an owned socket; no global agent mutation.
      request = transport.request(url, { method: 'GET', agent: false, highWaterMark: 64 * 1024,
        headers: { accept: 'application/zip', 'accept-encoding': 'identity' } }, incoming => {
        response = incoming;
        try {
          clearTimeout(headersTimer);
          incoming.once('close', cleanup);
          // Observe errors before the Web reader exists; once attached,
          // Readable.toWeb independently propagates the same body error.
          incoming.on('error', error => {
            if (!answered) { answered = true; reject(error); }
          });
          if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
            const error = Object.assign(new Error(`ODM request failed with HTTP ${incoming.statusCode}`), {
              code: incoming.statusCode === 404 ? 'provider_task_not_found' : 'provider_request_failed',
              status: incoming.statusCode,
            });
            fail(error); return;
          }
          if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'].toLowerCase() !== 'identity') {
            fail(Object.assign(new Error('Provider archive encoding is unsupported'), { code: 'provider_archive_encoding_unsupported' })); return;
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const part of value) headers.append(name, part);
            else if (value !== undefined) headers.set(name, value);
          }
          // State the byte budget explicitly across supported Node runtimes;
          // never interpret a byte high-water mark as a count of chunks.
          const body = [204, 205].includes(incoming.statusCode) ? null : Readable.toWeb(incoming, {
            strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
          });
          const result = new Response(body, { status: incoming.statusCode, statusText: incoming.statusMessage, headers });
          answered = true; resolve(result);
          if (!body) incoming.resume();
        } catch (error) { fail(error); }
      });
      request.on('error', error => {
        if (!answered) { answered = true; reject(error); }
        response?.destroy(error); cleanup();
      });
      // After headers, request.close is not a body-completion signal. Its body
      // deadline and abort listener stay live until IncomingMessage closes.
      request.once('close', () => { if (!response) cleanup(); });
      request.end();
    } catch (error) { fail(error); }
  });
}

module.exports = { downloadProviderArchive };
