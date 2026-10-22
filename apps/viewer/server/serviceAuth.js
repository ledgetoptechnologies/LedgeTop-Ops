'use strict';

const crypto = require('crypto');
const { config } = require('./config');

const EMPTY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalRequest({ method, path, timestamp, nonce, bodySha256 }) {
  return ['ltds-viewer-service-v1', method.toUpperCase(), path, String(timestamp), nonce, bodySha256].join('\n');
}

function signature(secret, fields) {
  return crypto.createHmac('sha256', secret).update(canonicalRequest(fields)).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signServiceRequest({ secret, keyId, method, path, body = '', timestamp, nonce }) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const fields = {
    method,
    path,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    nonce: nonce || crypto.randomBytes(24).toString('base64url'),
    bodySha256: sha256Hex(bodyBuffer),
  };
  return {
    'X-LTDS-Key-Id': keyId,
    'X-LTDS-Timestamp': String(fields.timestamp),
    'X-LTDS-Nonce': fields.nonce,
    'X-LTDS-Content-SHA256': fields.bodySha256,
    'X-LTDS-Signature': signature(secret, fields),
  };
}

function verifyServiceRequest({
  headers,
  method,
  path,
  rawBody = Buffer.alloc(0),
  repository,
  nowMs = Date.now(),
  expectedKeyId = config.serviceAuthKeyId,
  secret = config.serviceAuthSecret,
  keys = config.serviceAuthKeys,
  skewSeconds = config.serviceAuthSkewSeconds,
}) {
  const read = (name) => headers.get ? headers.get(name) : headers[name.toLowerCase()] || headers[name];
  const keyId = read('x-ltds-key-id');
  const timestampText = read('x-ltds-timestamp');
  const nonce = read('x-ltds-nonce');
  const suppliedBodyHash = read('x-ltds-content-sha256');
  const suppliedSignature = read('x-ltds-signature');
  const selectedSecret = keys ? keys[keyId] : (keyId === expectedKeyId ? secret : null);
  if (!selectedSecret) return { ok: false, code: 'invalid_service_auth' };
  if (!/^[A-Za-z0-9._-]{16,128}$/.test(nonce || '')) return { ok: false, code: 'invalid_service_auth' };
  if (!/^\d{10}$/.test(timestampText || '')) return { ok: false, code: 'invalid_service_auth' };
  const timestamp = Number(timestampText);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestamp) > skewSeconds) return { ok: false, code: 'expired_service_auth' };
  const bodyHash = sha256Hex(rawBody);
  if (!safeEqual(suppliedBodyHash, bodyHash)) return { ok: false, code: 'invalid_service_auth' };
  const expectedSignature = signature(selectedSecret, { method, path, timestamp, nonce, bodySha256: bodyHash });
  if (!safeEqual(suppliedSignature, expectedSignature)) return { ok: false, code: 'invalid_service_auth' };
  const cutoff = new Date(nowMs - skewSeconds * 2000).toISOString();
  if (!repository.consumeServiceNonce(keyId, nonce, cutoff, new Date(nowMs).toISOString()))
    return { ok: false, code: 'replayed_service_auth' };
  return { ok: true, keyId };
}

function requireService(repository) {
  return (req, res, next) => {
    const verified = verifyServiceRequest({
      headers: req.headers,
      method: req.method,
      path: req.originalUrl,
      rawBody: req.rawBody || Buffer.alloc(0),
      repository,
    });
    if (!verified.ok) return res.status(401).json({ error: 'service authentication failed' });
    repository.pruneAuthState();
    req.servicePrincipal = { keyId: verified.keyId };
    return next();
  };
}

module.exports = {
  EMPTY_SHA256,
  canonicalRequest,
  requireService,
  sha256Hex,
  signServiceRequest,
  signature,
  verifyServiceRequest,
};
