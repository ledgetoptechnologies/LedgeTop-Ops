'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { signServiceRequest, verifyServiceRequest } = require('../server/serviceAuth');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-auth-test-'));
  const database = openDatabase(path.join(directory, 'viewer.sqlite'));
  t.after(() => {
    database.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return new ViewerRepository(database);
}

function lower(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

test('accepts one correctly signed request and rejects its replay', (t) => {
  const repository = fixture(t);
  const secret = 's'.repeat(48);
  const nowMs = 1_800_000_000_000;
  const body = JSON.stringify({ modelId: 'model-1' });
  const headers = lower(signServiceRequest({
    secret,
    keyId: 'ops-v1',
    method: 'POST',
    path: '/api/v1/models/model-1/sessions',
    body,
    timestamp: Math.floor(nowMs / 1000),
    nonce: 'nonce_1234567890abcdef',
  }));
  const request = {
    headers,
    method: 'POST',
    path: '/api/v1/models/model-1/sessions',
    rawBody: Buffer.from(body),
    repository,
    nowMs,
    expectedKeyId: 'ops-v1',
    secret,
    skewSeconds: 300,
  };
  assert.deepEqual(verifyServiceRequest(request), { ok: true, keyId: 'ops-v1' });
  assert.deepEqual(verifyServiceRequest(request), { ok: false, code: 'replayed_service_auth' });
});

test('binds signature to path, body, method, key, and timestamp window', (t) => {
  const repository = fixture(t);
  const secret = 'k'.repeat(48);
  const nowMs = 1_800_000_000_000;
  const headers = lower(signServiceRequest({
    secret,
    keyId: 'ops-v1',
    method: 'GET',
    path: '/api/v1/models?limit=20',
    timestamp: Math.floor(nowMs / 1000),
    nonce: 'nonce_abcdefghijklmnop',
  }));
  const base = {
    headers,
    method: 'GET',
    path: '/api/v1/models?limit=20',
    rawBody: Buffer.alloc(0),
    repository,
    nowMs,
    expectedKeyId: 'ops-v1',
    secret,
    skewSeconds: 300,
  };
  assert.equal(verifyServiceRequest({ ...base, path: '/api/v1/imports' }).ok, false);
  assert.equal(verifyServiceRequest({ ...base, method: 'POST' }).ok, false);
  assert.equal(verifyServiceRequest({ ...base, rawBody: Buffer.from('{}') }).ok, false);
  assert.equal(verifyServiceRequest({ ...base, expectedKeyId: 'other-v1' }).ok, false);
  assert.deepEqual(
    verifyServiceRequest({ ...base, nowMs: nowMs + 301_000 }),
    { ok: false, code: 'expired_service_auth' },
  );
});

test('accepts explicitly configured previous and current keys during rotation', (t) => {
  const repository = fixture(t);
  const nowMs = 1_800_000_000_000;
  const keys = { 'ops-v1': 'a'.repeat(48), 'ops-v2': 'b'.repeat(48) };
  for (const keyId of Object.keys(keys)) {
    const headers = lower(signServiceRequest({
      secret: keys[keyId], keyId, method: 'GET', path: '/api/v1/models',
      timestamp: Math.floor(nowMs / 1000), nonce: `nonce_${keyId}_1234567890`,
    }));
    assert.deepEqual(verifyServiceRequest({
      headers, method: 'GET', path: '/api/v1/models', rawBody: Buffer.alloc(0),
      repository, nowMs, keys, skewSeconds: 300,
    }), { ok: true, keyId });
  }
});
