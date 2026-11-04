'use strict';

const https = require('node:https');
const { MAX_BODY_BYTES, PATH, validateOrigin } = require('./preparedSubmissionOutbox');

const MAX_PEM_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBMISSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ALLOWED_PATH = new RegExp(`^${PATH}(?:/${SUBMISSION_ID}(?:/activation)?)?$`);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function pemBytes(value, label, markers) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail(`prepared_submission_${label}_invalid`);
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > MAX_PEM_BYTES) fail(`prepared_submission_${label}_invalid`);
  const text = bytes.toString('ascii');
  if (!markers.some(marker => text.includes(marker))) fail(`prepared_submission_${label}_invalid`);
  return bytes;
}

function requestUrl(input, origin) {
  let url;
  try { url = new URL(input instanceof URL ? input.href : String(input)); }
  catch { fail('prepared_submission_request_url_invalid'); }
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password
      || url.search || url.hash || !ALLOWED_PATH.test(url.pathname)) {
    fail('prepared_submission_request_target_rejected');
  }
  return url;
}

function requestHeaders(value, authorityId, bearerToken) {
  let headers;
  try { headers = new Headers(value || {}); }
  catch { fail('prepared_submission_request_headers_invalid'); }
  const output = Object.create(null);
  headers.forEach((headerValue, name) => {
    const normalized = name.toLowerCase();
    if (['cookie', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection',
      'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(normalized)) {
      fail('prepared_submission_request_header_rejected');
    }
    output[normalized] = headerValue;
  });
  const authorization = output.authorization;
  if (authorization !== `Bearer ${bearerToken}`
      || output['x-ltds-expected-coordinator-authority'] !== authorityId) {
    fail('prepared_submission_request_identity_required');
  }
  return output;
}

function responseFrom(res, body) {
  const status = Number(res.statusCode);
  if (!Number.isInteger(status) || status < 200 || status > 599) fail('prepared_submission_response_invalid');
  if (status >= 300 && status < 400) fail('prepared_submission_redirect_rejected');
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers || {})) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, String(entry));
    else if (value !== undefined) headers.set(name, String(value));
  }
  return new Response(status === 204 || status === 205 || status === 304 ? null : body, { status, headers });
}

function createPreparedSubmissionMtlsTransport({ origin, authorityId, bearerToken, serverCa, clientCertificate, clientPrivateKey,
  timeoutMs = 15000, maxResponseBytes = MAX_RESPONSE_BYTES }) {
  const targetOrigin = validateOrigin(origin);
  if (typeof authorityId !== 'string' || !UUID.test(authorityId)) fail('prepared_submission_authority_invalid');
  if (typeof bearerToken !== 'string' || bearerToken.length < 16 || bearerToken.length > 4096
      || /[^\x21-\x7e]/.test(bearerToken)) fail('prepared_submission_credential_invalid');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) fail('prepared_submission_timeout_invalid');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    fail('prepared_submission_response_limit_invalid');
  }
  const ca = pemBytes(serverCa, 'server_ca', ['-----BEGIN CERTIFICATE-----']);
  const cert = pemBytes(clientCertificate, 'client_certificate', ['-----BEGIN CERTIFICATE-----']);
  const key = pemBytes(clientPrivateKey, 'client_key', [
    '-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----',
  ]);
  const agent = new https.Agent({ ca, cert, key, rejectUnauthorized: true, keepAlive: false, maxSockets: 4, maxFreeSockets: 0 });
  let closed = false;

  async function fetchImpl(input, init = {}) {
    if (closed) fail('prepared_submission_transport_closed');
    const url = requestUrl(input, targetOrigin);
    const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET';
    if (!['GET', 'POST'].includes(method) || method === 'GET' && init.body != null
        || method === 'POST' && init.body == null) fail('prepared_submission_request_method_rejected');
    const pathIsCollection = url.pathname === PATH;
    const pathIsSubmission = new RegExp(`^${PATH}/${SUBMISSION_ID}$`).test(url.pathname);
    const pathIsActivation = new RegExp(`^${PATH}/${SUBMISSION_ID}/activation$`).test(url.pathname);
    if (!(pathIsCollection && method === 'POST' || pathIsSubmission && method === 'GET'
        || pathIsActivation && method === 'POST')) fail('prepared_submission_request_method_rejected');
    if (init.redirect !== 'error' || init.credentials !== 'omit' || init.cache !== 'no-store') {
      fail('prepared_submission_request_policy_rejected');
    }
    const headers = requestHeaders(init.headers, authorityId, bearerToken);
    let body;
    if (init.body != null) {
      if (typeof init.body === 'string') body = Buffer.from(init.body, 'utf8');
      else if (Buffer.isBuffer(init.body) || init.body instanceof Uint8Array) body = Buffer.from(init.body);
      else fail('prepared_submission_request_body_invalid');
      if (!body.length || body.length > MAX_BODY_BYTES) fail('prepared_submission_request_body_invalid');
      if (headers['content-type']?.toLowerCase() !== 'application/json') fail('prepared_submission_request_content_type_invalid');
      headers['content-length'] = String(body.length);
    }
    const signal = init.signal;
    if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      fail('prepared_submission_abort_signal_invalid');
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      let settled = false;
      let received = 0;
      const chunks = [];
      let timer;
      const settleError = error => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      };
      const req = https.request(url, {
        method, headers, agent, rejectUnauthorized: true, signal,
      }, res => {
        if (Number(res.statusCode) >= 300 && Number(res.statusCode) < 400) {
          res.resume();
          settleError(Object.assign(new Error('redirect'), { code: 'prepared_submission_redirect_rejected' }));
          return;
        }
        res.on('data', chunk => {
          received += chunk.length;
          if (received > maxResponseBytes) {
            res.destroy();
            settleError(Object.assign(new Error('response limit'), { code: 'prepared_submission_response_too_large' }));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on('end', () => {
          if (settled) return;
          try {
            const response = responseFrom(res, Buffer.concat(chunks, received));
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(response);
          } catch { settleError(Object.assign(new Error('response invalid'), { code: 'prepared_submission_response_invalid' })); }
        });
        res.on('error', () => settleError(Object.assign(new Error('response failed'), { code: 'prepared_submission_transport_uncertain' })));
      });
      timer = setTimeout(() => {
        const error = Object.assign(new Error('timeout'), { code: 'prepared_submission_transport_uncertain' });
        req.destroy(error);
        settleError(error);
      }, timeoutMs);
      timer.unref?.();
      req.on('error', error => settleError(error?.name === 'AbortError' ? error
        : Object.assign(new Error('transport failed'), { code: 'prepared_submission_transport_uncertain' })));
      req.on('close', () => { if (timer) clearTimeout(timer); });
      if (body) req.end(body);
      else req.end();
    });
  }

  return {
    fetchImpl,
    close() {
      if (closed) return;
      closed = true;
      agent.destroy();
    },
  };
}

module.exports = { createPreparedSubmissionMtlsTransport };
