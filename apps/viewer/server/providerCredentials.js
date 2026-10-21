'use strict';

const crypto = require('node:crypto');
const { NO_AUTH_MARKER } = require('./providerAuth');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;
const IDEMPOTENCY_CONTEXT = Buffer.from('ltds-viewer-provider-idempotency:v1', 'utf8');

function credentialError(code = 'provider_credential_unavailable') {
  return Object.assign(new Error('processing provider credential is unavailable'), { code });
}

function decodeKey(value) {
  const text = String(value || '');
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return null;
  try {
    const key = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function validToken(value) {
  if (typeof value !== 'string') return false;
  const encoded = Buffer.from(value, 'utf8');
  return encoded.length >= 1
    && encoded.length <= 4096
    && encoded.toString('utf8') === value
    && !/[\0\r\n]/.test(value);
}

function associatedData(providerId, keyId) {
  return Buffer.from(`ltds-viewer-provider-credential:v${VERSION}:${providerId}:${keyId}`, 'utf8');
}

class ProviderCredentials {
  constructor({ processing, activeKeyId, keys = {}, legacyTokens = {} }) {
    this.processing = processing;
    this.activeKeyId = String(activeKeyId || 'provider-v1');
    this.keys = new Map();
    for (const [keyId, value] of Object.entries(keys || {})) {
      const decoded = decodeKey(value);
      if (decoded) this.keys.set(String(keyId), decoded);
    }
    this.legacyTokens = { ...(legacyTokens || {}) };
  }

  activeKey() {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw credentialError();
    return key;
  }

  idempotencyFingerprint(method, requestPath, rawBody = Buffer.alloc(0)) {
    // Domain-separate the database-visible fingerprint from the AES key. A
    // database-only attacker cannot use it as an oracle for weak token bodies.
    const key = crypto.hkdfSync('sha256', this.activeKey(), Buffer.alloc(0), IDEMPOTENCY_CONTEXT, 32);
    return crypto.createHmac('sha256', key)
      .update(`${method}\n${requestPath}\n`, 'utf8')
      .update(rawBody)
      .digest('hex');
  }

  seal(providerId, token) {
    if (!validToken(token)) throw credentialError('invalid_provider_credential');
    const keyId = this.activeKeyId;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.activeKey(), iv);
    cipher.setAAD(associatedData(providerId, keyId));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return {
      keyId,
      ciphertext: JSON.stringify({
        v: VERSION,
        alg: 'A256GCM',
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        data: ciphertext.toString('base64url'),
      }),
    };
  }

  open(providerId, record) {
    try {
      const envelope = JSON.parse(record.credentialCiphertext);
      if (envelope?.v !== VERSION || envelope?.alg !== 'A256GCM') throw new Error('unsupported envelope');
      const keyId = String(record.credentialKeyId || '');
      const key = this.keys.get(keyId);
      if (!key) throw new Error('missing key');
      const iv = Buffer.from(String(envelope.iv || ''), 'base64url');
      const tag = Buffer.from(String(envelope.tag || ''), 'base64url');
      const ciphertext = Buffer.from(String(envelope.data || ''), 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid envelope');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAAD(associatedData(providerId, keyId));
      decipher.setAuthTag(tag);
      const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      if (!validToken(token)) throw new Error('invalid plaintext');
      return token;
    } catch {
      throw credentialError();
    }
  }

  configured(providerId) {
    const record = this.processing.getProviderCredential(providerId);
    if (!record) return false;
    if (record.credentialCiphertext) return true;
    return !record.credentialCleared && validToken(this.legacyTokens[providerId]);
  }

  view(provider) {
    if (!provider) return provider;
    const record = this.processing.getProviderCredential(provider.id);
    return {
      ...provider,
      credential: {
        configured: this.configured(provider.id),
        updatedAt: record?.credentialUpdatedAt || null,
        ...(record?.authEnvKey === NO_AUTH_MARKER ? { mode:'none' } : {}),
      },
    };
  }

  resolveWithRevision(providerId) {
    const record = this.processing.getProviderCredential(providerId);
    if (!record) throw credentialError();
    if (record.authEnvKey === NO_AUTH_MARKER) return { token:'', revision:record.credentialRevision };
    if (record.credentialCiphertext) return { token: this.open(providerId, record), revision: record.credentialRevision };
    if (!record.credentialCleared && validToken(this.legacyTokens[providerId])) return { token: this.legacyTokens[providerId], revision: record.credentialRevision };
    throw credentialError();
  }

  resolve(providerId) {
    return this.resolveWithRevision(providerId).token;
  }

  migrateLegacy() {
    let migrated = 0;
    for (const [providerId, token] of Object.entries(this.legacyTokens)) {
      const record = this.processing.getProviderCredential(providerId);
      if (!record || record.credentialCiphertext || record.credentialCleared || !validToken(token)) continue;
      const sealed = this.seal(providerId, token);
      if (this.processing.migrateProviderCredential(providerId, sealed)) migrated += 1;
    }
    return migrated;
  }
}

module.exports = { ProviderCredentials, credentialError, decodeKey, validToken, NO_AUTH_MARKER };
