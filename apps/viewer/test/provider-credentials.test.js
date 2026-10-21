'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { ProviderCredentials, validToken } = require('../server/providerCredentials');
const { parseProviderCidrs } = require('../server/providerAdmission');
const { createProcessingApi } = require('../server/processingApi');
const { adapterFor } = require('../server/processingWorker');
const { resolveEnabledProviderCredentials } = require('../server/processingReadiness');

const KEY = '91'.repeat(32);
const TOKEN = '  node-token-☃-with-spaces  ';

async function odmServer(t, { beforeInfo, info = { version: '2.2.3', engine: 'odm', engineVersion: '3', taskQueueCount: 0, maxImages: null } } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push({ path: url.pathname, token: url.searchParams.get('token') });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/info') { if (beforeInfo) await beforeInfo();return res.end(JSON.stringify(info)); }
    if (url.pathname === '/options') return res.end(JSON.stringify([{ name: 'pc-ept', type: 'bool', value: true }]));
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const origin = `http://192.168.50.80:${server.address().port}`;
  return { origin, seen, fetchImpl: (input, init) => fetch(String(input).replace(origin, localOrigin), init) };
}

async function fixture(t, { providerFetch } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-provider-credentials-'));
  const databasePath = path.join(root, 'viewer.sqlite');
  const database = openDatabase(databasePath);
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const credentials = new ProviderCredentials({ processing, activeKeyId: 'provider-v1', keys: { 'provider-v1': KEY } });
  const accessToken = crypto.randomBytes(32).toString('base64url');
  processing.createAdminSession({ tokenHash: auth.hashToken(accessToken), subject: 'ops:admin', permissions: ['viewer.providers.read', 'viewer.providers.write'], displayUnits: 'imperial', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const storage = {};
  const app = express();
  app.use(express.json({ verify(req, _res, body) { req.rawBody = Buffer.from(body); } }));
  app.use(createProcessingApi({ repository, processing, storage, providerCredentials: credentials, providerFetch }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, databasePath, database, repository, processing, credentials, accessToken, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(context, route, { method = 'GET', body, key } = {}) {
  return fetch(`${context.base}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${context.accessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('read-only capability refresh observes an existing node without permitting configuration changes',async t=>{
 const odm=await odmServer(t),c=await fixture(t,{providerFetch:odm.fetchImpl});
 const oldCidrs=[...config.processingProviderAllowedCidrs];config.processingProviderAllowedCidrs.splice(0,config.processingProviderAllowedCidrs.length,...parseProviderCidrs('192.168.50.0/24'));t.after(()=>config.processingProviderAllowedCidrs.splice(0,config.processingProviderAllowedCidrs.length,...oldCidrs));
 const created=await request(c,'/api/v1/processing/providers',{method:'POST',key:'refresh-create-0001',body:{displayName:'Read-only refresh',endpoint:odm.origin,credential:{token:TOKEN}}});assert.equal(created.status,201);
 const provider=(await created.json()).provider,readToken=crypto.randomBytes(32).toString('base64url');
 c.processing.createAdminSession({tokenHash:auth.hashToken(readToken),subject:'reader',permissions:['viewer.providers.read'],expiresAt:new Date(Date.now()+60_000).toISOString()});
 const reader={...c,accessToken:readToken},route=`/api/v1/processing/providers/${provider.id}`;
 const refreshed=await request(reader,`${route}/capabilities/refresh`,{method:'POST',body:{}});assert.equal(refreshed.status,200);assert.equal(refreshed.headers.get('cache-control'),'no-store');
 const body=await refreshed.json();assert.equal(body.capabilities.engine,'odm');assert.doesNotMatch(JSON.stringify(body),/node-token|ciphertext/);
 assert.equal(c.processing.getProvider(provider.id).enabled,false);
 assert.equal((await request(reader,route,{method:'PATCH',key:'reader-change-0001',body:{enabled:true}})).status,403);
 assert.equal((await request(reader,`${route}/capabilities/refresh`,{method:'POST',body:{endpoint:'http://different'}})).status,400);
});

test('capability refresh rechecks reader authorization after provider I/O',async t=>{
 let release,entered,armed=false;
 const arrived=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
 const odm=await odmServer(t,{beforeInfo:async()=>{if(armed){entered();await blocked;}}}),c=await fixture(t,{providerFetch:odm.fetchImpl});
 const oldCidrs=[...config.processingProviderAllowedCidrs];config.processingProviderAllowedCidrs.splice(0,config.processingProviderAllowedCidrs.length,...parseProviderCidrs('192.168.50.0/24'));t.after(()=>config.processingProviderAllowedCidrs.splice(0,config.processingProviderAllowedCidrs.length,...oldCidrs));
 const created=await request(c,'/api/v1/processing/providers',{method:'POST',key:'refresh-revoke-0001',body:{displayName:'Refresh revocation',endpoint:odm.origin}});assert.equal(created.status,201);
 const provider=(await created.json()).provider;
 armed=true;const pending=request(c,`/api/v1/processing/providers/${provider.id}/capabilities/refresh`,{method:'POST',body:{}});
 await arrived;c.processing.revokeAdminSession(c.processing.getAdminSessionByHash(auth.hashToken(c.accessToken)).id);release();
 const response=await pending;assert.equal(response.status,401);assert.equal((await response.json()).code,'authentication_required');
 assert.equal(c.processing.getProvider(provider.id).enabled,false);
});

test('provider tokens are encrypted, private, restart-safe, auto-detected before storage, rotatable and clearable', async (t) => {
  const odm = await odmServer(t);
  const c = await fixture(t, { providerFetch: odm.fetchImpl });
  const oldCidrs = [...config.processingProviderAllowedCidrs];
  config.processingProviderAllowedCidrs.splice(0, config.processingProviderAllowedCidrs.length, ...parseProviderCidrs('192.168.50.0/24'));
  t.after(() => config.processingProviderAllowedCidrs.splice(0, config.processingProviderAllowedCidrs.length, ...oldCidrs));

  const createBody = { displayName: 'Primary ODM', endpoint: odm.origin, credential: { token: TOKEN } };
  const created = await request(c, '/api/v1/processing/providers', { method: 'POST', key: 'provider-create-0002', body: createBody });
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.provider.enabled, false);
  assert.equal(payload.provider.type, 'nodeodm');
  assert.equal(payload.provider.capabilities.apiVersion, '2.2.3');
  assert.equal(payload.provider.lastHealth, 'healthy');
  assert.equal(payload.detection.providerType, 'nodeodm');
  assert.deepEqual(payload.provider.credential, { configured: true, updatedAt: payload.provider.credential.updatedAt });
  assert.equal(typeof payload.provider.credential.updatedAt, 'string');
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /node-token|ciphertext|credentialKey/i);

  const row = c.database.prepare('SELECT * FROM processing_providers WHERE id=?').get(payload.provider.id);
  assert.equal(row.credential_key_id, 'provider-v1');
  assert.notEqual(row.credential_ciphertext, TOKEN);
  assert.doesNotMatch(row.credential_ciphertext, /node-token/);
  assert.equal(c.credentials.resolve(payload.provider.id), TOKEN, 'token bytes survive encryption exactly');
  const storedIdempotency = c.database.prepare("SELECT request_hash,response_json FROM admin_idempotency WHERE idempotency_key='provider-create-0002'").get();
  assert.match(storedIdempotency.request_hash, /^[a-f0-9]{64}$/);
  const rawBody = Buffer.from(JSON.stringify(createBody));
  const unkeyed = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('POST\n/api/v1/processing/providers\n'), rawBody])).digest('hex');
  assert.notEqual(storedIdempotency.request_hash, unkeyed, 'database fingerprint is not a token-enumerable raw SHA-256');
  assert.equal(storedIdempotency.request_hash, c.credentials.idempotencyFingerprint('POST', '/api/v1/processing/providers', rawBody));
  const unrelatedKey = new ProviderCredentials({ processing: c.processing, activeKeyId: 'provider-v1', keys: { 'provider-v1': 'ab'.repeat(32) } });
  assert.notEqual(storedIdempotency.request_hash, unrelatedKey.idempotencyFingerprint('POST', '/api/v1/processing/providers', rawBody));
  assert.doesNotMatch(storedIdempotency.response_json, /node-token|ciphertext/i);
  assert.doesNotMatch(JSON.stringify(c.database.prepare('SELECT details_json FROM audit_events WHERE entity_id=?').all(payload.provider.id)), /node-token/i);
  const replay = await request(c, '/api/v1/processing/providers', { method: 'POST', key: 'provider-create-0002', body: createBody });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.equal((await replay.json()).provider.id, payload.provider.id);
  const conflict = await request(c, '/api/v1/processing/providers', { method: 'POST', key: 'provider-create-0002', body: { ...createBody, credential: { token: 'x' } } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'idempotency_conflict');

  const suppliedType = await request(c, '/api/v1/processing/providers', { method: 'POST', key: 'provider-create-type', body: { ...createBody, type: 'clusterodm' } });
  assert.equal(suppliedType.status, 400);
  assert.equal((await suppliedType.json()).code, 'invalid_request');
  const probe = await request(c, `/api/v1/processing/providers/${payload.provider.id}/capabilities/probe`, { method: 'POST', key: 'provider-probe-0001', body: {} });
  assert.equal(probe.status, 200);
  assert.ok(odm.seen.length >= 2);
  assert.ok(odm.seen.every((entry) => entry.token === TOKEN));
  const enabled = await request(c, `/api/v1/processing/providers/${payload.provider.id}`, { method: 'PATCH', key: 'provider-enable-0002', body: { enabled: true } });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).provider.enabled, true);
  const typeConfusion = await request(c, `/api/v1/processing/providers/${payload.provider.id}`, { method: 'PATCH', key: 'provider-enable-type', body: { enabled: 'true' } });
  assert.equal(typeConfusion.status, 400);
  assert.equal((await typeConfusion.json()).code, 'invalid_provider_enabled');
  const endpointChanged = await request(c, `/api/v1/processing/providers/${payload.provider.id}`, { method: 'PATCH', key: 'provider-endpoint-change', body: { endpoint: `${odm.origin}/nodeodm` } });
  assert.equal(endpointChanged.status, 400);
  assert.equal((await endpointChanged.json()).code, 'invalid_provider_endpoint');

  const restarted = new ProviderCredentials({ processing: c.processing, activeKeyId: 'provider-v2', keys: { 'provider-v1': KEY, 'provider-v2': 'a3'.repeat(32) } });
  assert.equal(restarted.resolve(payload.provider.id), TOKEN, 'key overlap decrypts credentials created before restart/rotation');
  const replacement = 'replacement-token';
  const rotated = await request(c, `/api/v1/processing/providers/${payload.provider.id}/credential`, { method: 'PUT', key: 'provider-rotate-0001', body: { token: replacement } });
  assert.equal(rotated.status, 200);
  const rotatedProvider = (await rotated.json()).provider;
  assert.equal(rotatedProvider.enabled, false);
  assert.deepEqual(rotatedProvider.capabilities, {});
  assert.equal(rotatedProvider.lastHealth, null);
  assert.equal(c.credentials.resolve(payload.provider.id), replacement);
  assert.equal(adapterFor(rotatedProvider, { processingProviderTransferTimeoutMs: 30_000 }, c.credentials).token, replacement, 'worker adapters resolve the current database token without restart');
  const staleEnable = await request(c, `/api/v1/processing/providers/${payload.provider.id}`, { method: 'PATCH', key: 'provider-enable-0003', body: { enabled: true } });
  assert.equal(staleEnable.status, 409);
  assert.equal((await staleEnable.json()).code, 'provider_probe_required');

  const cleared = await request(c, `/api/v1/processing/providers/${payload.provider.id}/credential`, { method: 'DELETE', key: 'provider-clear-0001' });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).provider.credential, { configured: false, updatedAt: null });
  assert.throws(() => c.credentials.resolve(payload.provider.id), { code: 'provider_credential_unavailable' });
  const enableAfterClear = await request(c, `/api/v1/processing/providers/${payload.provider.id}`, { method: 'PATCH', key: 'provider-enable-cleared', body: { enabled: true } });
  assert.equal(enableAfterClear.status, 409);
  assert.equal((await enableAfterClear.json()).code, 'provider_credential_required');
});

test('a successfully probed unauthenticated node has an explicit no-auth mode and can be enabled', async (t) => {
  const odm = await odmServer(t);
  const c = await fixture(t, { providerFetch: odm.fetchImpl });
  const oldOrigins = [...config.processingProviderOrigins];
  config.processingProviderOrigins.splice(0, config.processingProviderOrigins.length, odm.origin);
  t.after(() => config.processingProviderOrigins.splice(0, config.processingProviderOrigins.length, ...oldOrigins));

  const created = await request(c, '/api/v1/processing/providers', { method: 'POST', key: 'provider-no-auth-create', body: { displayName: 'Open ODM', endpoint: odm.origin } });
  assert.equal(created.status, 201);
  const provider = (await created.json()).provider;
  assert.deepEqual(provider.credential, { configured:false,updatedAt:null,mode:'none' });
  assert.equal(c.credentials.resolve(provider.id), '');
  assert.ok(odm.seen.every((entry) => entry.token === null));
  const enabled = await request(c, `/api/v1/processing/providers/${provider.id}`, { method: 'PATCH', key: 'provider-no-auth-enable', body: { enabled: true } });
  assert.equal(enabled.status, 200);
  const enabledProvider = (await enabled.json()).provider;
  assert.equal(enabledProvider.enabled, true);
  assert.equal(adapterFor(enabledProvider, { processingProviderTransferTimeoutMs:30_000 }, c.credentials).token, '');
});

test('provider creation detects ClusterODM and stores nothing for an ambiguous compatible endpoint', async (t) => {
  const cluster = await odmServer(t, { info: { version: '1.5.3', engine: 'odm', engineVersion: '3.5', taskQueueCount: 0, maxImages: null, totalMemory: 99999999999, availableMemory: 99999999999, cpuCores: 99999999999, maxParallelTasks: 99999999999 } });
  const ambiguous = await odmServer(t, { info: { version: '1.5.3', engine: 'odm', engineVersion: '3.5', taskQueueCount: 0, maxImages: null } });
  const clusterContext = await fixture(t, { providerFetch: cluster.fetchImpl });
  const ambiguousContext = await fixture(t, { providerFetch: ambiguous.fetchImpl });
  const oldOrigins = [...config.processingProviderOrigins];
  config.processingProviderOrigins.splice(0, config.processingProviderOrigins.length, cluster.origin, ambiguous.origin);
  t.after(() => config.processingProviderOrigins.splice(0, config.processingProviderOrigins.length, ...oldOrigins));

  const detected = await request(clusterContext, '/api/v1/processing/providers', { method: 'POST', key: 'provider-cluster-detect', body: { displayName: 'Cluster', endpoint: cluster.origin, credential: { token: 'cluster-secret-token' } } });
  assert.equal(detected.status, 201);
  const detectedBody = await detected.json();
  assert.equal(detectedBody.provider.type, 'clusterodm');
  assert.equal(detectedBody.provider.admissionLimit, 4);
  assert.equal(detectedBody.provider.capabilities.providerType, 'clusterodm');
  assert.equal(detectedBody.detection.apiVersion, '1.5.3');
  assert.doesNotMatch(JSON.stringify(detectedBody), /cluster-secret-token/);

  const rejected = await request(ambiguousContext, '/api/v1/processing/providers', { method: 'POST', key: 'provider-ambiguous-detect', body: { displayName: 'Ambiguous', endpoint: ambiguous.origin, credential: { token: 'ambiguous-secret-token' } } });
  assert.equal(rejected.status, 422);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.code, 'provider_probe_ambiguous');
  assert.doesNotMatch(JSON.stringify(rejectedBody), /ambiguous-secret-token/);
  assert.equal(ambiguousContext.processing.listProviders().length, 0);
});

test('credential mutation blocks every nonterminal attempt and tampering fails closed', async (t) => {
  const c = await fixture(t);
  const provider = c.processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true, credentialCiphertext: c.credentials.seal('provider-temp', TOKEN).ciphertext });
  // Bind an envelope to the actual provider ID before exercising the worker-facing resolver.
  c.processing.setProviderCredential(provider.id, c.credentials.seal(provider.id, TOKEN));
  c.processing.updateProviderCapabilities(provider.id, { capabilities: {}, fingerprint: 'credential-test', health: 'healthy' });
  c.processing.updateProviderMetadata(provider.id, { enabled: true });
  const project = c.processing.createProject({ displayName: 'Project' });
  const dataset = c.processing.createDataset({ projectId: project.id, displayName: 'Dataset', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  c.processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 0, sha256: crypto.createHash('sha256').digest('hex') }], crypto.createHash('sha256').digest('hex'));
  const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Task' });
  c.processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {} });
  const blocked = await request(c, `/api/v1/processing/providers/${provider.id}/credential`, { method: 'PUT', key: 'provider-active-0001', body: { token: 'new-token' } });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, 'provider_in_use');
  c.database.prepare("UPDATE processing_attempts SET status='failed' WHERE provider_id=?").run(provider.id);
  c.database.prepare("UPDATE processing_providers SET credential_ciphertext=substr(credential_ciphertext,1,length(credential_ciphertext)-2)||'xx' WHERE id=?").run(provider.id);
  assert.throws(() => c.credentials.resolve(provider.id), { code: 'provider_credential_unavailable' });
});

test('a concurrent credential rotation cannot certify a stale probe', async (t) => {
  let releaseInfo;
  const blocked = new Promise((resolve) => { releaseInfo = resolve; });
  let infoStarted;
  const started = new Promise((resolve) => { infoStarted = resolve; });
  let infoCalls = 0;
  const odm = await odmServer(t, { beforeInfo: async () => { infoCalls += 1;if (infoCalls === 2) { infoStarted();await blocked; } } });
  const c = await fixture(t, { providerFetch: odm.fetchImpl });
  const oldOrigins = [...config.processingProviderOrigins];
  config.processingProviderOrigins.splice(0, config.processingProviderOrigins.length, odm.origin);
  t.after(() => config.processingProviderOrigins.splice(0, config.processingProviderOrigins.length, ...oldOrigins));
  const created = await request(c, '/api/v1/processing/providers', { method: 'POST', key: 'provider-race-create', body: { displayName: 'Race ODM', endpoint: odm.origin, credential: { token: 'old-token' } } });
  const provider = (await created.json()).provider;
  const probing = request(c, `/api/v1/processing/providers/${provider.id}/capabilities/probe`, { method: 'POST', key: 'provider-race-probe', body: {} });
  await infoStarted;
  const rotated = await request(c, `/api/v1/processing/providers/${provider.id}/credential`, { method: 'PUT', key: 'provider-race-rotate', body: { token: 'new-token' } });
  assert.equal(rotated.status, 200);
  releaseInfo();
  const probe = await probing;
  assert.equal(probe.status, 409);
  assert.equal((await probe.json()).code, 'provider_probe_stale');
  assert.equal(c.processing.providerProbeCurrent(provider.id), false);
});

test('legacy environment tokens migrate once, database wins, and clear is a durable tombstone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-provider-legacy-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  t.after(() => { database.close();fs.rmSync(root,{recursive:true,force:true}); });
  const provider = processing.upsertProvider({ id: 'legacy-provider', type: 'nodeodm', displayName: 'Legacy', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const credentials = new ProviderCredentials({ processing, activeKeyId: 'provider-v1', keys: { 'provider-v1': KEY }, legacyTokens: { [provider.id]: 'legacy-token' } });
  assert.equal(credentials.resolve(provider.id), 'legacy-token');
  assert.equal(credentials.migrateLegacy(), 1);
  credentials.legacyTokens[provider.id] = 'changed-env-token';
  assert.equal(credentials.resolve(provider.id), 'legacy-token', 'encrypted database credential takes precedence over the legacy environment fallback');
  processing.clearProviderCredential(provider.id);
  assert.equal(credentials.configured(provider.id), false);
  assert.throws(() => credentials.resolve(provider.id), { code: 'provider_credential_unavailable' });
  assert.equal(credentials.migrateLegacy(), 0, 'clear tombstone prevents the legacy environment value from returning');
});

test('provider credential validation preserves exact safe UTF-8 while bounding storage', () => {
  assert.equal(validToken(' x '), true);
  assert.equal(validToken(''), false);
  assert.equal(validToken('line\nbreak'), false);
  assert.equal(validToken('nul\0byte'), false);
  assert.equal(validToken('\ud800'), false);
  assert.equal(validToken('é'.repeat(2048)), true);
  assert.equal(validToken('é'.repeat(2049)), false);
});

test('processing readiness decrypts enabled credentials with overlap and fails closed generically', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-provider-readiness-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  t.after(() => { database.close();fs.rmSync(root,{recursive:true,force:true}); });
  const providerId = 'readiness-provider';
  const old = new ProviderCredentials({ processing, activeKeyId: 'provider-v1', keys: { 'provider-v1': KEY } });
  const sealed = old.seal(providerId, 'readiness-secret-token');
  processing.upsertProvider({ id: providerId, type: 'nodeodm', displayName: 'Ready ODM', endpoint: 'http://192.168.50.80:30048', enabled: true, credentialCiphertext: sealed.ciphertext, credentialKeyId: sealed.keyId, credentialUpdatedAt: new Date().toISOString() });
  const overlap = { processingLogMaxBytes: 1024, providerCredentialsKeyId: 'provider-v2', providerCredentialsKeys: { 'provider-v1': KEY, 'provider-v2': 'a3'.repeat(32) }, processingProviderTokens: {} };
  assert.deepEqual(resolveEnabledProviderCredentials(database, overlap), [providerId]);
  const missing = { ...overlap, providerCredentialsKeys: { 'provider-v2': 'a3'.repeat(32) } };
  assert.throws(() => resolveEnabledProviderCredentials(database, missing), (error) => {
    assert.equal(error.message, `provider ${providerId} credential is unavailable`);
    assert.doesNotMatch(error.message, /readiness-secret|ciphertext|provider-v1/);
    return true;
  });
  database.prepare("UPDATE processing_providers SET credential_ciphertext=substr(credential_ciphertext,1,length(credential_ciphertext)-2)||'xx' WHERE id=?").run(providerId);
  assert.throws(() => resolveEnabledProviderCredentials(database, overlap), { message: `provider ${providerId} credential is unavailable` });
});
