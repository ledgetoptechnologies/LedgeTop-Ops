import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { openStagingBackup, sealStagingBackup, STAGING_BACKUP_MAX_PLAINTEXT_BYTES, StagingBackupEnvelopeError } from './staging-backup-envelope.mjs';

const binding = Object.freeze({
  role: 'operations', runId: 'e6e219dd-ec24-4b45-8515-60db51307aee',
  sourceAccountId: '846c924bf17bf4f3dd15c97a4c5d1d51', targetAccountId: 'df3f376bae6ee621f50cf972ebcc9484',
  sourceDatabaseId: '78b34173-b168-4e3d-9832-bb9d245cc6b8', targetDatabaseId: 'a58ea102-f04d-417a-bfd1-b0654cfeb503',
  migrationChainSha256: 'a'.repeat(64), sourceSnapshotSha256: 'b'.repeat(64),
});
const otherBinding = Object.freeze({ ...binding, runId: 'ad71c1dc-d664-4cc5-948a-2ce12e431b77' });
const encoder = new TextEncoder();
const raw = encoder.encode('synthetic staging backup bytes');

async function key(usages = ['encrypt', 'decrypt'], extractable = false) {
  return webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, usages);
}
async function sealed(overrides = {}) {
  const k = await key();
  return { k, e: { ...await sealStagingBackup(raw, k, binding, 'backup-key-v1'), ...overrides } };
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code);
    assert.equal(err.message, code);
    assert.equal(err.message.includes('synthetic'), false);
    return true;
  });
}

test('round trips authenticated bytes, hides plaintext, and creates a fresh IV', async () => {
  const k = await key();
  const a = await sealStagingBackup(raw, k, binding, 'backup-key-v1');
  const b = await sealStagingBackup(raw, k, binding, 'backup-key-v1');
  assert.notEqual(a.iv, b.iv);
  assert.deepEqual(await openStagingBackup(a, k, binding, 'backup-key-v1'), raw);
  assert.equal(JSON.stringify(a).includes('synthetic staging backup bytes'), false);
  assert.equal(a.byteLength, raw.byteLength);
});

test('snapshots bytes and metadata synchronously before asynchronous crypto', async () => {
  const k = await key();
  const mutableBytes = new Uint8Array(raw);
  const mutableBinding = { ...binding };
  const pending = sealStagingBackup(mutableBytes, k, mutableBinding, 'backup-key-v1');
  mutableBytes.fill(0);
  mutableBinding.runId = otherBinding.runId;
  const envelope = await pending;
  assert.deepEqual(await openStagingBackup(envelope, k, binding, 'backup-key-v1'), raw);
});

test('rejects wrong key, binding, key id, and role crossing', async () => {
  const { k, e } = await sealed();
  await rejectsCode(openStagingBackup(e, await key(), binding, 'backup-key-v1'), 'AUTHENTICATION_FAILED');
  await rejectsCode(openStagingBackup(e, k, otherBinding, 'backup-key-v1'), 'BINDING_MISMATCH');
  await rejectsCode(openStagingBackup(e, k, binding, 'backup-key-v2'), 'BINDING_MISMATCH');
  const portal = { ...binding, role: 'portal', sourceDatabaseId: 'b6f653ab-9acd-4421-9ad0-207754b59aeb', targetDatabaseId: '15d02028-8c52-40b2-9979-d67abf7d5bbf' };
  await rejectsCode(openStagingBackup(e, k, portal, 'backup-key-v1'), 'BINDING_MISMATCH');
});

test('rejects authenticated field tampering and truncation', async () => {
  const { k, e } = await sealed();
  await rejectsCode(openStagingBackup({ ...e, plaintextSha256: 'c'.repeat(64) }, k, binding, 'backup-key-v1'), 'AUTHENTICATION_FAILED');
  await rejectsCode(openStagingBackup({ ...e, ciphertext: Buffer.from(Buffer.from(e.ciphertext, 'base64').subarray(0, -1)).toString('base64') }, k, binding, 'backup-key-v1'), 'INVALID_CIPHERTEXT');
  await rejectsCode(openStagingBackup({ ...e, iv: Buffer.from(Buffer.from(e.iv, 'base64').subarray(0, -1)).toString('base64') }, k, binding, 'backup-key-v1'), 'INVALID_IV');
});

test('rejects malformed, noncanonical base64 and unknown or accessor fields', async () => {
  const { k, e } = await sealed();
  await rejectsCode(openStagingBackup({ ...e, iv: `${e.iv}\n` }, k, binding, 'backup-key-v1'), 'INVALID_IV');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = e.ciphertext.length - 2;
  const index = alphabet.indexOf(e.ciphertext[last]);
  const noncanonical = `${e.ciphertext.slice(0, last)}${alphabet[(index + 1) % 64]}=`;
  await rejectsCode(openStagingBackup({ ...e, ciphertext: noncanonical }, k, binding, 'backup-key-v1'), 'INVALID_CIPHERTEXT');
  await rejectsCode(openStagingBackup({ ...e, surprise: true }, k, binding, 'backup-key-v1'), 'INVALID_ENVELOPE');
  const accessor = { ...e };
  Object.defineProperty(accessor, 'keyId', { enumerable: true, get() { throw new Error('secret input'); } });
  await rejectsCode(openStagingBackup(accessor, k, binding, 'backup-key-v1'), 'INVALID_ENVELOPE');
});

test('rejects invalid metadata, plaintext sizes, and unsuitable keys', async () => {
  const k = await key();
  await rejectsCode(sealStagingBackup(new Uint8Array(), k, binding, 'backup-key-v1'), 'INVALID_PLAINTEXT');
  await rejectsCode(sealStagingBackup(new Uint8Array(STAGING_BACKUP_MAX_PLAINTEXT_BYTES + 1), k, binding, 'backup-key-v1'), 'INVALID_PLAINTEXT');
  await rejectsCode(sealStagingBackup(raw, await key(['encrypt', 'decrypt'], true), binding, 'backup-key-v1'), 'INVALID_KEY');
  await rejectsCode(sealStagingBackup(raw, await key(['decrypt']), binding, 'backup-key-v1'), 'INVALID_KEY');
  const encryptOnly = await key(['encrypt']);
  const encryptOnlyEnvelope = await sealStagingBackup(raw, encryptOnly, binding, 'backup-key-v1');
  await rejectsCode(openStagingBackup(encryptOnlyEnvelope, encryptOnly, binding, 'backup-key-v1'), 'INVALID_KEY');
  const decryptOnly = await key(['decrypt']);
  await rejectsCode(sealStagingBackup(raw, decryptOnly, binding, 'backup-key-v1'), 'INVALID_KEY');
  const accessorBinding = { ...binding };
  Object.defineProperty(accessorBinding, 'runId', { enumerable: true, get() { throw new Error('private'); } });
  await rejectsCode(sealStagingBackup(raw, k, accessorBinding, 'backup-key-v1'), 'INVALID_BINDING');
  await rejectsCode(sealStagingBackup(raw, k, { ...binding, targetDatabaseId: binding.sourceDatabaseId }, 'backup-key-v1'), 'INVALID_BINDING');
  for (const role of ['toString', '__proto__', 'constructor']) {
    await rejectsCode(sealStagingBackup(raw, k, { ...binding, role, sourceDatabaseId: undefined, targetDatabaseId: undefined }, 'backup-key-v1'), 'INVALID_BINDING');
  }
  await rejectsCode(sealStagingBackup(raw, { get type() { throw new Error('private key-shaped object'); } }, binding, 'backup-key-v1'), 'INVALID_KEY');
  const reflectionProxy = new Proxy({ ...binding }, { ownKeys() { throw new Error('private proxy detail'); } });
  await rejectsCode(sealStagingBackup(raw, k, reflectionProxy, 'backup-key-v1'), 'INVALID_BINDING');
});

test('rejects declared size over limit before decoding ciphertext', async () => {
  const { k, e } = await sealed();
  await rejectsCode(openStagingBackup({ ...e, byteLength: STAGING_BACKUP_MAX_PLAINTEXT_BYTES + 1, ciphertext: '' }, k, binding, 'backup-key-v1'), 'INVALID_ENVELOPE');
});

test('changing both the envelope context and expected context cannot relabel authenticated bytes', async () => {
  const { k, e } = await sealed();
  for (const changed of [{ ...binding, runId: otherBinding.runId },
    { ...binding, sourceSnapshotSha256: 'c'.repeat(64) }, { ...binding, migrationChainSha256: 'd'.repeat(64) }]) {
    await rejectsCode(openStagingBackup({ ...e, ...changed }, k, changed, 'backup-key-v1'), 'AUTHENTICATION_FAILED');
  }
  await rejectsCode(openStagingBackup({ ...e, keyId: 'backup-key-v2' }, k, binding, 'backup-key-v2'), 'AUTHENTICATION_FAILED');
});

test('public failures rebuild known-code errors and never return injected message or cause', async () => {
  const k = await key();
  const injected = new StagingBackupEnvelopeError('INVALID_BINDING');
  injected.message = 'synthetic private payload';
  injected.cause = 'synthetic private cause';
  const proxy = new Proxy({ ...binding }, { ownKeys() { throw injected; } });
  await assert.rejects(sealStagingBackup(raw, k, proxy, 'backup-key-v1'), error => {
    assert.equal(error.message, 'INVALID_BINDING');
    assert.equal(error.cause, undefined);
    assert.notEqual(error, injected);
    return true;
  });
});

test('authenticated bytes still require their declared plaintext digest before release', async () => {
  const k = await key();
  const plaintextSha256 = '0'.repeat(64);
  const keyId = 'backup-key-v1';
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(JSON.stringify({ version: 1, ...binding, keyId, plaintextSha256, byteLength: raw.byteLength }));
  // Deliberately malformed producer data: valid GCM tag, wrong declared digest.
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, raw);
  await rejectsCode(openStagingBackup({ version: 1, ...binding, keyId, plaintextSha256, byteLength: raw.byteLength,
    iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') },
    k, binding, keyId), 'PLAINTEXT_INTEGRITY_FAILED');
});

test('accepts a full maximum-size envelope through encryption, base64 decode, and integrity check', async () => {
  const k = await key();
  const maximum = new Uint8Array(STAGING_BACKUP_MAX_PLAINTEXT_BYTES);
  maximum[0] = 17;
  maximum[maximum.length - 1] = 29;
  const envelope = await sealStagingBackup(maximum, k, binding, 'backup-key-v1');
  const opened = await openStagingBackup(envelope, k, binding, 'backup-key-v1');
  assert.equal(opened.byteLength, STAGING_BACKUP_MAX_PLAINTEXT_BYTES);
  assert.equal(opened[0], 17);
  assert.equal(opened[opened.length - 1], 29);
  maximum.fill(0);
  opened.fill(0);
});
