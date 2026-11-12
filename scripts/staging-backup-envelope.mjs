import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const VERSION = 1;
const SOURCE_ACCOUNT = '846c924bf17bf4f3dd15c97a4c5d1d51';
const TARGET_ACCOUNT = 'df3f376bae6ee621f50cf972ebcc9484';
const DATABASES = Object.freeze({
  operations: Object.freeze({ source: '78b34173-b168-4e3d-9832-bb9d245cc6b8', target: 'a58ea102-f04d-417a-bfd1-b0654cfeb503' }),
  portal: Object.freeze({ source: 'b6f653ab-9acd-4421-9ad0-207754b59aeb', target: '15d02028-8c52-40b2-9979-d67abf7d5bbf' }),
});
const BINDING_KEYS = Object.freeze(['role', 'runId', 'sourceAccountId', 'targetAccountId', 'sourceDatabaseId', 'targetDatabaseId', 'migrationChainSha256', 'sourceSnapshotSha256']);
const ENVELOPE_KEYS = Object.freeze(['version', ...BINDING_KEYS, 'keyId', 'plaintextSha256', 'byteLength', 'iv', 'ciphertext']);
const ERROR_CODES = new Set(['INVALID_BINDING', 'INVALID_KEY', 'INVALID_KEY_ID', 'INVALID_PLAINTEXT', 'ENCRYPTION_FAILED', 'INVALID_ENVELOPE', 'BINDING_MISMATCH', 'INVALID_IV', 'INVALID_CIPHERTEXT', 'AUTHENTICATION_FAILED', 'PLAINTEXT_INTEGRITY_FAILED']);

export class StagingBackupEnvelopeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StagingBackupEnvelopeError';
    this.code = code;
  }
}

function fail(code) { throw new StagingBackupEnvelopeError(code); }

// Rebuild public errors rather than returning caller-controlled Error objects,
// even when one happens to carry a known code or a modified message/cause.
function sanitizedFailure(error, fallback) {
  let code = fallback;
  try {
    if (error instanceof StagingBackupEnvelopeError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (descriptor && Object.hasOwn(descriptor, 'value') && ERROR_CODES.has(descriptor.value)) code = descriptor.value;
    }
  } catch { /* Hostile reflection must not escape the fixed-code boundary. */ }
  fail(code);
}

function dataRecord(value, keys, code) {
  try {
    if (value === null || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(code);
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((k) => typeof k !== 'string' || !keys.includes(k))) fail(code);
    const out = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(code);
      out[key] = descriptor.value;
    }
    return out;
  } catch (error) {
    if (error instanceof StagingBackupEnvelopeError) throw error;
    fail(code);
  }
}

function validateBinding(value) {
  const b = dataRecord(value, BINDING_KEYS, 'INVALID_BINDING');
  if (b.role !== 'operations' && b.role !== 'portal') fail('INVALID_BINDING');
  const db = Object.hasOwn(DATABASES, b.role) ? DATABASES[b.role] : undefined;
  if (!db || typeof b.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.runId) ||
      b.sourceAccountId !== SOURCE_ACCOUNT || b.targetAccountId !== TARGET_ACCOUNT || b.sourceDatabaseId !== db.source || b.targetDatabaseId !== db.target ||
      typeof b.migrationChainSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.migrationChainSha256) ||
      typeof b.sourceSnapshotSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sourceSnapshotSha256)) fail('INVALID_BINDING');
  return b;
}

function validateKey(key, usage) {
  try {
    if (!(key instanceof CryptoKey) || key.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'AES-GCM' || key.algorithm?.length !== 256 || !key.usages?.includes(usage)) fail('INVALID_KEY');
  } catch (error) {
    if (error instanceof StagingBackupEnvelopeError) throw error;
    fail('INVALID_KEY');
  }
}

function validateKeyId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail('INVALID_KEY_ID');
  return id;
}

function canonicalAad(binding, keyId, plaintextSha256, byteLength) {
  return new TextEncoder().encode(JSON.stringify({ version: VERSION, ...binding, keyId, plaintextSha256, byteLength }));
}

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }

function decodeB64(value, expectedBytes, code) {
  if (typeof value !== 'string' || value.length !== Math.ceil(expectedBytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value)) fail(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== value) fail(code);
  return new Uint8Array(bytes);
}

async function sha256(bytes) {
  const digest = await subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}

export async function sealStagingBackup(raw, key, binding, keyId) {
  let bytes;
  try {
    if (!(raw instanceof Uint8Array) || raw.byteLength < 1 || raw.byteLength > MAX_PLAINTEXT_BYTES) fail('INVALID_PLAINTEXT');
    validateKey(key, 'encrypt');
    const bound = validateBinding(binding);
    const kid = validateKeyId(keyId);
    bytes = new Uint8Array(raw);
    const plaintextSha256 = await sha256(bytes);
    const byteLength = bytes.byteLength;
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    let ciphertext;
    try {
      ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: canonicalAad(bound, kid, plaintextSha256, byteLength), tagLength: 128 }, key, bytes));
    } catch {
      fail('ENCRYPTION_FAILED');
    }
    return Object.freeze({ version: VERSION, ...bound, keyId: kid, plaintextSha256, byteLength, iv: b64(iv), ciphertext: b64(ciphertext) });
  } catch (error) {
    sanitizedFailure(error, 'ENCRYPTION_FAILED');
  } finally {
    bytes?.fill(0);
  }
}

export async function openStagingBackup(envelope, key, expectedBinding, expectedKeyId) {
  let opened;
  try {
    const e = dataRecord(envelope, ENVELOPE_KEYS, 'INVALID_ENVELOPE');
    if (e.version !== VERSION || !Number.isSafeInteger(e.byteLength) || e.byteLength < 1 || e.byteLength > MAX_PLAINTEXT_BYTES || typeof e.plaintextSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.plaintextSha256)) fail('INVALID_ENVELOPE');
    const bound = validateBinding(Object.fromEntries(BINDING_KEYS.map((k) => [k, e[k]])));
    const expected = validateBinding(expectedBinding);
    const kid = validateKeyId(e.keyId);
    if (kid !== validateKeyId(expectedKeyId) || BINDING_KEYS.some((k) => bound[k] !== expected[k])) fail('BINDING_MISMATCH');
    validateKey(key, 'decrypt');
    const iv = decodeB64(e.iv, 12, 'INVALID_IV');
    const ciphertext = decodeB64(e.ciphertext, e.byteLength + 16, 'INVALID_CIPHERTEXT');
    try {
      opened = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: canonicalAad(bound, kid, e.plaintextSha256, e.byteLength), tagLength: 128 }, key, ciphertext));
    } catch {
      fail('AUTHENTICATION_FAILED');
    }
    if (opened.byteLength !== e.byteLength || await sha256(opened) !== e.plaintextSha256) fail('PLAINTEXT_INTEGRITY_FAILED');
    const plaintext = opened;
    opened = undefined;
    return plaintext;
  } catch (error) {
    opened?.fill(0);
    sanitizedFailure(error, 'AUTHENTICATION_FAILED');
  }
}

export const STAGING_BACKUP_MAX_PLAINTEXT_BYTES = MAX_PLAINTEXT_BYTES;
