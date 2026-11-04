'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { signServiceRequest, verifyServiceRequest, verifyServiceRequestDigest } = require('../server/serviceAuth');

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

test('matches Processing sender auth for the Viewer object-chunk route', (t) => {
  const repository = fixture(t);
  const secret = 'synthetic-viewer-service-key-material';
  const body = Buffer.from('synthetic chunk bytes');
  const path = '/api/v1/reference/v1/acceptances/receipt-test/objects/result-test?offset=7';
  const nowMs = 1_793_620_800_000;
  const bodySha256 = 'cb20255c9267446562175b1bd8518aeaa4aa6538e85371dc6725eef474f0dd3d';
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), bodySha256);
  const headers = {
    'x-ltds-key-id': 'synthetic-service',
    'x-ltds-timestamp': '1793620800',
    'x-ltds-nonce': 'nonce_20261102_0000000000000000',
    'x-ltds-content-sha256': bodySha256,
    'x-ltds-signature': 'U71Kj7RkLd3IwyLLuWiJo-eGRrDJnsohjtJl-4FveNA',
  };
  assert.deepEqual(verifyServiceRequestDigest({
    headers,
    method: 'PUT',
    path,
    bodySha256,
    repository,
    nowMs,
    expectedKeyId: 'synthetic-service',
    secret,
    skewSeconds: 300,
  }), { ok: true, keyId: 'synthetic-service' });
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
