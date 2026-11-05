'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auth = require('../server/auth');
const ReferenceProtocol = require('../server/referenceProtocol');
const { ReferenceCoordinatorProvider, boundedJson } = require('../server/referenceCoordinatorProvider');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { ProviderCredentials } = require('../server/providerCredentials');
const { createProcessingApi } = require('../server/processingApi');
const { refreshOneProviderHealth } = require('../server/providerHealth');
const { providerSubmissionState } = require('../server/providerSelection.mjs');

const source = { enabled: true, environment: 'staging', origin: 'https://processing.example.test',
  providerId: 'processing-coordinator-staging', bearerToken: 'pinned-reference-coordinator-bearer-token-0123456789' };
const cap = ReferenceProtocol.createCapabilities('staging');
const options = [...['pc-ept', 'gltf', '3d-tiles'].map(name => ({ name, type: 'bool', value: true })),
  { name: 'feature-quality', type: 'enum', domain: ['medium', 'high', 'ultra'], value: 'high' }];
const optionsBody = { schemaVersion: 1, environment: 'staging', capabilityFingerprint: cap.capabilityFingerprint,
  optionsFingerprint: cap.engines.odm.optionsFingerprint, options };
const capabilitiesBody = { ...cap, sourceIntake: { enabled: true }, viewerAcceptance: { enabled: true } };

function response(url, body, init) {
  const path = new URL(url).pathname;
  if (init.headers.Authorization !== `Bearer ${source.bearerToken}`) throw new Error('wrong bearer');
  return new Response(JSON.stringify(path === '/ltds/v2/capabilities' ? capabilitiesBody
    : path === '/ltds/v1/options' ? optionsBody : { error: 'wrong route' }),
  { status: 200, headers: { 'content-type': 'application/json' } });
}

test('reference coordinator maps its pinned capabilities/options without NodeODM routes', async () => {
  const calls = [];
  const provider = new ReferenceCoordinatorProvider({ source, fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return response(url, null, init); } });
  const result = await provider.capabilities();
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/ltds/v2/capabilities', '/ltds/v1/options']);
  assert.ok(calls.every(call => call.init.redirect === 'error' && call.init.credentials === 'omit'));
  assert.equal(result.capabilities.engine, 'LedgeTop Reference Coordinator');
  assert.equal(result.capabilities.engineVersion, 'unknown');
  assert.equal(result.capabilities.taskQueueCount, null);
  assert.equal(result.capabilities.providerType, 'nodeodm', 'legacy database type stores ODM engine compatibility');
  assert.equal(result.capabilities.detectionMethod, 'pinned-reference-coordinator');
  assert.equal(result.capabilities.options.length, 4);
  assert.equal(result.capabilities.options[3].type, 'string', 'enum options use the Viewer string-plus-domain contract');
  assert.deepEqual(result.capabilities.options[3].domain, ['medium', 'high', 'ultra']);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('reference coordinator rejects mismatched environment/fingerprints and fails closed on redirects or transport errors', async t => {
  const cases = [
    ['environment', async (url, init) => response(url, null, init), { ...source, environment: 'production' }, 'reference_provider_environment_mismatch'],
    ['fingerprint', async (url, init) => new URL(url).pathname.endsWith('/options')
      ? new Response(JSON.stringify({ ...optionsBody, capabilityFingerprint: 'a'.repeat(64) }), { status: 200, headers: { 'content-type': 'application/json' } })
      : response(url, null, init), source, 'reference_provider_options_invalid'],
    ['redirect', async () => ({ redirected: true, url: 'https://other.example.test/ltds/v2/capabilities', ok: true, headers: new Headers(), body: null }) , source, null],
    ['token rejection', async () => { throw new Error('token=must-not-be-returned'); }, source, 'reference_provider_transport_uncertain'],
  ];
  for (const [name, fetchImpl, selectedSource, code] of cases) await t.test(name, async () => {
    const provider = new ReferenceCoordinatorProvider({ source: selectedSource, fetchImpl });
    if (code) await assert.rejects(provider.capabilities(), error => error.code === code);
    else await assert.rejects(provider.capabilities(), error => error.code === 'reference_provider_redirect_rejected');
  });
});

test('coordinator JSON reader cancels an oversized chunked response before buffering the full body', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(200 * 1024)); controller.enqueue(new Uint8Array(100 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedJson({ headers: new Headers(), body }), { code: 'reference_provider_response_too_large' });
  assert.equal(cancelled, true);
});

test('HTTP provider setup, probe, enable, refresh, selection and background health use the pinned coordinator API', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-reference-provider-'));
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(db), processing = new ProcessingRepository(db);
  const adminToken = 'reference-provider-admin-token-000000000000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(adminToken), subject: 'ops:test',
    permissions: ['viewer.providers.read', 'viewer.providers.write', 'viewer.processing.write'], displayUnits: 'imperial',
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const project = processing.createProject({ displayName: 'Coordinator admission test' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Photo set',
    storageMode: 'managed', rootKey: 'datasets', relativePath: 'coordinator-test' });
  const emptySha = require('node:crypto').createHash('sha256').digest('hex');
  processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 0, sha256: emptySha }], emptySha);
  const credentials = new ProviderCredentials({ processing, activeKeyId: 'test', keys: { test: 'a'.repeat(64) } });
  const runtimeConfig = { referenceSourceIntake: { ...source }, processingProviderOrigins: [], processingProviderAllowedCidrs: [], processingProviderTimeoutMs: 1000,
    defaultUnits: 'imperial', meshDerivativesEnabled: false, storageUsageMaxEntries: 10 };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(String(url)); return response(url, null, init); };
  const app = express();
  app.use(express.json({ verify(req, _res, body) { req.rawBody = Buffer.from(body); } }));
  app.use(createProcessingApi({ repository, processing, storage: { roots: {} }, providerCredentials: credentials,
    providerFetch: fetchImpl, config: runtimeConfig }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  const call = (url, method, key, body = {}) => fetch(`${base}${url}`, { method, headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  let result = await call('/api/v1/processing/providers', 'POST', 'provider-create-01', { displayName: 'Reference coordinator', endpoint: source.origin });
  assert.equal(result.status, 201, JSON.stringify({ response: await result.clone().json(), calls })); let payload = await result.json();
  assert.equal(payload.provider.id, source.providerId);
  assert.equal(payload.provider.capabilities.engine, 'LedgeTop Reference Coordinator');
  assert.equal(payload.provider.credential.configured, true);
  result = await call('/api/v1/processing/providers', 'POST', 'provider-reuse-01', { displayName: 'Do not overwrite', endpoint: source.origin });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).provider.displayName, 'Reference coordinator', 'the exact configured provider is reused without metadata replacement');
  result = await call('/api/v1/processing/providers', 'POST', 'provider-create-bad', { displayName: 'Wrong origin', endpoint: 'https://attacker.example.test', credential: { token: source.bearerToken } });
  assert.equal(result.status, 400, 'configured coordinator secrets cannot be paired with an arbitrary endpoint');
  result = await call(`/api/v1/processing/providers/${source.providerId}/credential`, 'PUT', 'provider-rotate-bad', { token: 'attacker-controlled-token' });
  assert.equal(result.status, 409, 'coordinator credentials remain configuration managed');
  result = await call(`/api/v1/processing/providers/${source.providerId}`, 'PATCH', 'provider-endpoint-bad', { endpoint: 'https://attacker.example.test' });
  assert.equal(result.status, 409, 'the exact configured provider ID cannot be moved to a different origin');
  result = await call(`/api/v1/processing/providers/${source.providerId}/capabilities/probe`, 'POST', 'provider-probe-01');
  assert.equal(result.status, 200);
  result = await call(`/api/v1/processing/providers/${source.providerId}`, 'PATCH', 'provider-enable-01', { enabled: true });
  assert.equal(result.status, 200);
  result = await call(`/api/v1/processing/providers/${source.providerId}/capabilities/refresh`, 'POST', null);
  assert.equal(result.status, 200);
  const enabled = processing.getProvider(source.providerId);
  assert.equal(providerSubmissionState(enabled).eligible, true);
  result = await call('/api/v1/task-submissions', 'POST', 'coordinator-submit-01', {
    submissionId: require('node:crypto').randomUUID(), projectId: project.id, datasetId: dataset.id,
    taskDisplayName: 'Coordinator task', providerId: source.providerId, options: {},
  });
  assert.equal(result.status, 201, await result.clone().text());
  const submitted = await result.json();
  assert.equal(submitted.attempt.providerId, source.providerId);
  assert.equal(submitted.attempt.options['pc-ept'], true);
  assert.equal(submitted.attempt.options.gltf, true);
  assert.equal(submitted.attempt.options['3d-tiles'], true);
  assert.equal(await refreshOneProviderHealth({ processing, providerCredentials: credentials, config: runtimeConfig,
    owner: 'coordinator-health-test', fetchImpl }), true);
  assert.equal(processing.getProvider(source.providerId).runtimeHealth, 'healthy');
  runtimeConfig.referenceSourceIntake.enabled = false;
  result = await call(`/api/v1/processing/providers/${source.providerId}/capabilities/refresh`, 'POST', null);
  assert.equal(result.status, 409, 'a disabled coordinator remains fail-closed and does not fall through to NodeODM');
  assert.ok(calls.every(url => ['/ltds/v2/capabilities', '/ltds/v1/options'].includes(new URL(url).pathname)));
});
