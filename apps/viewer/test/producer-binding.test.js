'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { NodeOdmProvider } = require('../server/nodeOdmProvider');
const { stable } = require('../lod-converter-policy.cjs');
const taskId = '11111111-1111-4111-8111-111111111111';
function binding(change = {}) {
  const body = { schemaVersion: 1, providerTaskId: taskId, producerGeneration: 7, environment: 'STAGING',
    jobId: '22222222-2222-4222-8222-222222222222', nativeTaskId: '33333333-3333-4333-8333-333333333333',
    nodeId: 'main', archiveSha256: 'a'.repeat(64), archiveEvidence: 'producer-record-not-fresh-byte-verification', ...change };
  return { ...body, bindingSha256: crypto.createHash('sha256').update('ltds-producer-binding-v1\0').update(stable(body)).digest('hex') };
}
function provider(value, calls = []) {
  return new NodeOdmProvider({ endpoint: 'https://processing.example', token: 'synthetic-test-token', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  } });
}

test('producer binding uses existing scoped TLS query-token read and preserves producer evidence limits', async () => {
  const value = binding(), calls = [], result = await provider(value, calls).producerBinding(taskId, { environment: 'STAGING' });
  assert.deepEqual(result, value); assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, `/task/${taskId}/producer-binding`);
  assert.equal(calls[0].url.searchParams.get('token'), 'synthetic-test-token');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.method, undefined);
  assert.equal(result.archiveEvidence, 'producer-record-not-fresh-byte-verification');
});

for (const [name, change] of [
  ['cross task', { providerTaskId: '44444444-4444-4444-8444-444444444444' }],
  ['cross environment', { environment: 'PRODUCTION' }], ['bad generation', { producerGeneration: '7' }],
  ['unsafe native id', { nativeTaskId: '../other' }], ['false fresh-byte evidence', { archiveEvidence: 'verified' }],
  ['unknown fields', { filePath: '/private' }],
]) test(`producer binding rejects ${name} even with self-consistent digest`, async () => {
  await assert.rejects(provider(binding(change)).producerBinding(taskId, { environment: 'STAGING' }), { code: 'producer_binding_invalid' });
});

test('digest corruption and TLS/environment/path omission reject', async () => {
  await assert.rejects(provider({ ...binding(), bindingSha256: 'f'.repeat(64) }).producerBinding(taskId, { environment: 'STAGING' }), { code: 'producer_binding_invalid' });
  let calls = 0;
  const p = new NodeOdmProvider({ endpoint: 'http://processing.example', fetchImpl: async () => { calls++; } });
  await assert.rejects(p.producerBinding(taskId, { environment: 'STAGING' }), { code: 'producer_binding_unavailable' });
  await assert.rejects(provider(binding()).producerBinding(taskId), { code: 'producer_binding_unavailable' });
  await assert.rejects(provider(binding()).producerBinding('../task', { environment: 'STAGING' }), { code: 'producer_binding_unavailable' });
  assert.equal(calls, 0);
});

test('oversized producer response fails before parsing or returning private fields', async () => {
  const p = new NodeOdmProvider({ endpoint: 'https://processing.example', fetchImpl: async () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(p.producerBinding(taskId, { environment: 'STAGING' }), { code: 'producer_binding_invalid' });
});

test('capability advertises only exact TLS producer-binding descriptor and fingerprints it', async () => {
  const marker = { version: 1, transport: 'https', pathTemplate: '/task/{taskId}/producer-binding' };
  const probe = async (endpoint, descriptor) => new NodeOdmProvider({ endpoint, fetchImpl: async url => new Response(JSON.stringify(
    url.pathname === '/options' ? [] : { version: '2.2.3', engine: 'ODM', engineVersion: '3.5.6', maxImages: null,
      taskQueueCount: 0, ...(descriptor ? { producerBinding: descriptor } : {}) }), { headers: { 'content-type': 'application/json' } }) }).capabilities();
  const supported = await probe('https://processing.example', marker);
  assert.deepEqual(supported.capabilities.producerBinding, marker);
  const absent = await probe('https://processing.example');
  assert.equal(absent.capabilities.producerBinding, undefined);
  assert.notEqual(supported.fingerprint, absent.fingerprint);
  assert.equal((await probe('http://processing.example', marker)).capabilities.producerBinding, undefined);
  assert.equal((await probe('https://processing.example', { ...marker, pathTemplate: '/other' })).capabilities.producerBinding, undefined);
});
