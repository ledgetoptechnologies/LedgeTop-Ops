'use strict';

const crypto = require('crypto');
const { config } = require('./config');
const { sha256Hex } = require('./serviceAuth');

const RETENTION_MS = 24 * 60 * 60 * 1000;

function encryptionKey() {
  return crypto.createHash('sha256').update(config.sessionSecret).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decrypt(value) {
  const [ivText, tagText, encryptedText] = String(value || '').split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('invalid idempotency response');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8'));
}

function idempotent(repository) {
  return (req, res, next) => {
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey)
      return res.status(428).json({ error: 'Idempotency-Key is required for service mutations' });
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
      return res.status(400).json({ error: 'invalid Idempotency-Key' });

    const keyId = req.servicePrincipal && req.servicePrincipal.keyId;
    const requestHash = sha256Hex(Buffer.concat([
      Buffer.from(`${req.method}\n${req.originalUrl}\n`),
      req.rawBody || Buffer.alloc(0),
    ]));
    const reservation = repository.reserveIdempotency({
      keyId,
      idempotencyKey,
      method: req.method,
      path: req.originalUrl,
      requestHash,
      expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(),
    });
    if (!reservation.created) {
      const record = reservation.record;
      if (!record || record.method !== req.method || record.path !== req.originalUrl || record.request_hash !== requestHash)
        return res.status(409).json({ error: 'Idempotency-Key was already used for a different request' });
      if (record.response_status === null || !record.response_ciphertext) {
        res.setHeader('Retry-After', '1');
        return res.status(409).json({ error: 'idempotent request is still processing' });
      }
      res.setHeader('Idempotency-Replayed', 'true');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(record.response_status).json(decrypt(record.response_ciphertext));
    }

    let completed = false;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (!completed && res.statusCode < 500) {
        repository.completeIdempotency(keyId, idempotencyKey, res.statusCode, encrypt(body));
        completed = true;
      }
      return originalJson(body);
    };
    res.once('finish', () => {
      if (!completed) repository.releaseIdempotency(keyId, idempotencyKey);
    });
    return next();
  };
}

module.exports = { RETENTION_MS, decrypt, encrypt, idempotent };
