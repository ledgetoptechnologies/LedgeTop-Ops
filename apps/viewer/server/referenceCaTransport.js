'use strict';

// Owner-configuration only: no file reads, environment changes, trust-store
// mutations, caller-selected dispatchers or certificate-validation bypasses.
// This deliberately implements only ReferenceProvider's GET/POST fetch subset.
// Node 24 documents that explicit ca replaces defaults, hence the scoped union:
// https://nodejs.org/download/release/v24.20.0/docs/api/tls.html#tlsgetcacertificatestype
const https = require('node:https');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const { LIMITS } = require('./referenceProtocol');
class ReferenceTransportError extends Error {
  constructor(code) { super(code); this.name = 'ReferenceTransportError'; this.code = code; }
}
const error = code => new ReferenceTransportError(code);
function originUrl(value) {
  let url; try { url = new URL(value); } catch { throw error('INVALID_TLS_CONFIGURATION'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^https:\/\/[^/?#\s\\]+\/?$/.test(value)) throw error('INVALID_TLS_CONFIGURATION');
  return url.origin;
}
function createEndpointCaFetch({ origin, caPem, timeoutMs = 300000 } = {}) {
  const allowedOrigin = originUrl(origin);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 || typeof caPem !== 'string' || Buffer.byteLength(caPem) > 256 * 1024) throw error('INVALID_TLS_CONFIGURATION');
  // Accept certificates, never keys or arbitrary OpenSSL configuration text.
  const certificates = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certificates?.length || caPem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw error('INVALID_TLS_CONFIGURATION');
  try { for (const certificate of certificates) if (!new X509Certificate(certificate).ca) throw error('INVALID_TLS_CONFIGURATION'); }
  catch { throw error('INVALID_TLS_CONFIGURATION'); }

  return async function endpointCaFetch(input, init = {}) {
    let url; try { url = new URL(input); } catch { throw error('INVALID_TLS_REQUEST'); }
    // Check before constructing a request, so credentials cannot leave the
    // selected origin (including changes of port, scheme or user information).
    if (url.origin !== allowedOrigin || url.protocol !== 'https:' || url.username || url.password || url.hash) throw error('TLS_ORIGIN_REJECTED');
    if (!init || Object.keys(init).some(key => !['method', 'headers', 'body', 'redirect', 'signal'].includes(key)) || !['GET', 'POST'].includes(init.method ?? 'GET') || init.redirect !== 'error') throw error('INVALID_TLS_REQUEST');
    const method = init.method ?? 'GET', body = init.body;
    if ((body !== undefined && (typeof body !== 'string' || method !== 'POST' || Buffer.byteLength(body) > LIMITS.metadataBytes)) || (init.signal !== undefined && !(init.signal instanceof AbortSignal))) throw error('INVALID_TLS_REQUEST');
    let headers;
    try {
      headers = new Headers(init.headers);
      for (const key of headers.keys()) if (!['authorization', 'accept', 'content-type'].includes(key)) throw error('INVALID_TLS_REQUEST');
    } catch { throw error('INVALID_TLS_REQUEST'); }
    const signal = init.signal;
    if (signal?.aborted) throw error('TLS_ABORTED');
    // A ca option REPLACES Node defaults. Retain the actual defaults, which may
    // include system/extra roots, rather than only tls.rootCertificates.
    let roots;
    try { roots = [...tls.getCACertificates('default'), ...certificates]; }
    catch { throw error('INVALID_TLS_CONFIGURATION'); }
    return new Promise((resolve, reject) => {
      let request, incoming, controller, settled = false, finished = false, timer;
      function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
      function terminate(code) {
        if (finished) return;
        finished = true; cleanup();
        const failure = error(code);
        if (!settled) { settled = true; reject(failure); }
        else controller?.error(failure);
        incoming?.destroy(); request?.destroy();
      }
      function aborted() { terminate('TLS_ABORTED'); }
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => terminate('TLS_TIMEOUT'), timeoutMs);
      try {
        request = https.request(url, { method, headers: Object.fromEntries(headers), ca: roots, agent: false, rejectUnauthorized: true, maxHeaderSize: 16384 }, response => {
          incoming = response;
          // Never follow redirects, even back to the same origin. In particular
          // an Authorization header is never copied onto a Location target.
          if (response.statusCode >= 300 && response.statusCode < 400) { terminate('TLS_REDIRECT_REJECTED'); return; }
          try {
            const responseHeaders = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
            const stream = new ReadableStream({
              start(value) { controller = value; response.pause(); },
              pull() { response.resume(); },
              cancel() {
                if (finished) return;
                finished = true; cleanup(); response.destroy(); request.destroy();
              }
            }, { highWaterMark: 65536, size: chunk => chunk.byteLength });
            response.on('data', chunk => {
              if (finished) return;
              controller.enqueue(new Uint8Array(chunk));
              if (controller.desiredSize <= 0) response.pause();
            });
            response.on('end', () => { if (!finished) { finished = true; cleanup(); controller.close(); } });
            response.on('aborted', () => terminate('TLS_TRANSPORT_ERROR'));
            response.on('error', () => terminate('TLS_TRANSPORT_ERROR'));
            response.on('close', () => { if (!response.complete) terminate('TLS_TRANSPORT_ERROR'); });
            const result = new Response(stream, { status: response.statusCode, headers: responseHeaders });
            settled = true; resolve(result);
          } catch { terminate('TLS_TRANSPORT_ERROR'); }
        });
        request.on('error', () => terminate('TLS_TRANSPORT_ERROR'));
        if (signal?.aborted) { aborted(); return; }
        request.end(body);
      } catch { terminate('TLS_TRANSPORT_ERROR'); }
    });
  };
}

module.exports = { createEndpointCaFetch, ReferenceTransportError };
