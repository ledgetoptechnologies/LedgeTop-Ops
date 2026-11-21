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

async function fixture(t, { providerFetch, permissions = ['viewer.providers.read', 'viewer.providers.write'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-provider-credentials-'));
  const databasePath = path.join(root, 'viewer.sqlite');
  const database = openDatabase(databasePath);
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const credentials = new ProviderCredentials({ processing, activeKeyId: 'provider-v1', keys: { 'provider-v1': KEY } });
  const accessToken = crypto.randomBytes(32).toString('base64url');
  processing.createAdminSession({ tokenHash: auth.hashToken(accessToken), subject: 'ops:admin', permissions, displayUnits: 'imperial', expiresAt: new Date(Date.now() + 60_000).toISOString() });
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

test('separate provider records at the same endpoint retain credentials by provider id',async t=>{
 const odm=await odmServer(t),c=await fixture(t,{providerFetch:odm.fetchImpl});
 const oldCidrs=[...config.processingProviderAllowedCidrs];config.processingProviderAllowedCidrs.splice(0,config.processingProviderAllowedCidrs.length,...parseProviderCidrs('192.168.50.0/24'));t.after(()=>config.processingProviderAllowedCidrs.splice(0,config.processingProviderAllowedCidrs.length,...oldCidrs));
 const create=async(displayName,token,key)=>{const response=await request(c,'/api/v1/processing/providers',{method:'POST',key,body:{displayName,endpoint:odm.origin,credential:{token}}});assert.equal(response.status,201);return(await response.json()).provider;};
 const production=await create('Production','synthetic-production-token','provider-production-fixture'),staging=await create('Staging','synthetic-staging-token','provider-staging-fixture');
 assert.notEqual(production.id,staging.id);assert.equal(production.endpoint,staging.endpoint);assert.equal(c.credentials.resolve(production.id),'synthetic-production-token');assert.equal(c.credentials.resolve(staging.id),'synthetic-staging-token');
 assert.equal(adapterFor(production,{processingProviderTransferTimeoutMs:30_000},c.credentials).token,'synthetic-production-token');assert.equal(adapterFor(staging,{processingProviderTransferTimeoutMs:30_000},c.credentials).token,'synthetic-staging-token');
 assert.ok(odm.seen.some(entry=>entry.token==='synthetic-production-token'));assert.ok(odm.seen.some(entry=>entry.token==='synthetic-staging-token'));
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


test('delete requires write access, blocks queued and running work, and preserves run history', async t => {
  const c = await fixture(t, { permissions: ['viewer.providers.read', 'viewer.providers.write', 'viewer.processing.read'] });
  const oldOrigins = [...config.processingProviderOrigins];
  config.processingProviderOrigins.splice(0, config.processingProviderOrigins.length, 'https://cluster.example');
  t.after(() => config.processingProviderOrigins.splice(0, config.processingProviderOrigins.length, ...oldOrigins));
  const readToken = crypto.randomBytes(32).toString('base64url');
  c.processing.createAdminSession({ tokenHash: auth.hashToken(readToken), subject: 'reader', permissions: ['viewer.providers.read'], expiresAt: new Date(Date.now() + 60_000).toISOString() });

  const credential = c.credentials.seal('cluster', TOKEN);
  const provider = c.processing.upsertProvider({ id: 'cluster', type: 'clusterodm', displayName: 'Cluster', endpoint: 'https://cluster.example', enabled: true, credentialCiphertext: credential.ciphertext, credentialKeyId: credential.keyId });
  const keeper = c.processing.upsertProvider({ type: 'nodeodm', displayName: 'Orchestrator', endpoint: 'https://orchestrator.example', enabled: true });
  const unused = c.processing.upsertProvider({ type: 'nodeodm', displayName: 'Staging', endpoint: 'https://staging.example', enabled: false });
  const route = `/api/v1/processing/providers/${provider.id}`;
  const remove = (key, accessToken = c.accessToken) => request({ ...c, accessToken }, route, { method: 'DELETE', key, body: {} });

  assert.equal((await remove('delete-reader-0001', readToken)).status, 403);
  const project = c.processing.createProject({ displayName: 'Existing project' });
  const dataset = c.processing.createDataset({ projectId: project.id, displayName: 'Inputs', storageMode: 'managed', rootKey: 'datasets', relativePath: 'existing-inputs' });
  const sha = 'a'.repeat(64);
  c.processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: sha }], sha);
  const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Existing task' });
  const attempt = c.processing.createAttempt({ taskId: task.id, providerId: provider.id });

  for (const status of ['pending', 'queued_upstream', 'running']) {
    c.processing.transitionAttempt(attempt.id, status);
    const result = await remove(`delete-active-${status}`);
    assert.equal(result.status, 409);
    assert.equal((await result.json()).code, 'provider_in_use');
    assert.ok(c.processing.getProvider(provider.id));
  }

  c.processing.appendLog(attempt.id, 'info', 'Preserved log');
  c.processing.transitionAttempt(attempt.id, 'ready_for_review');
  const time = new Date().toISOString();
  c.database.prepare(`INSERT INTO viewer_acceptance_ack_outbox(event_id,attempt_id,task_id,provider_id,provider_endpoint,provider_task_id,payload_json,status,available_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'{}','pending',?,?,?)`).run('receipt', attempt.id, task.id, provider.id, provider.endpoint, attempt.providerTaskId, time, time, time);
  assert.equal((await remove('delete-with-pending-ack')).status, 409);
  const ack = c.processing.claimViewerAcceptanceAck('test-worker');
  assert.equal((await remove('delete-with-leased-ack')).status, 409);
  assert.equal(c.processing.completeViewerAcceptanceAck(ack.event_id, 'test-worker'), true);

  const listed = await request(c, '/api/v1/processing/providers?limit=1');
  const firstPage = await listed.json();
  assert.ok(firstPage.nextCursor);
  const enabledDelete = await remove('delete-enabled-0001');
  assert.equal(enabledDelete.status, 409);
  assert.equal((await enabledDelete.json()).code, 'provider_enabled');
  assert.equal(c.processing.getProvider(provider.id).enabled, true);
  assert.equal((await request(c, route, { method: 'PATCH', body: { enabled: false }, key: 'disable-idle-0001' })).status, 200);
  assert.equal((await remove('delete-enabled-0001')).status, 409);
  const deleted = await remove('delete-idle-0001');
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });
  assert.equal((await remove('delete-idle-0001')).status, 200);
  assert.equal((await remove('delete-idle-0002')).status, 404);
  assert.equal((await request(c, `/api/v1/processing/providers/${unused.id}`, { method: 'DELETE', body: {}, key: 'delete-unused-0001' })).status, 200);

  const providers = await request(c, '/api/v1/processing/providers');
  assert.deepEqual((await providers.json()).providers.map(item => item.id), [keeper.id]);
  const nextPage = await request(c, `/api/v1/processing/providers?limit=100&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
  assert.deepEqual((await nextPage.json()).providers.map(item => item.id), firstPage.providers[0].id === keeper.id ? [] : [keeper.id]);
  assert.equal((await request(c, `${route}/capabilities`)).status, 404);
  assert.equal(c.processing.getProviderCredential(provider.id), null);
  assert.equal(c.database.prepare('SELECT credential_ciphertext FROM processing_providers WHERE id=?').get(provider.id).credential_ciphertext, null);
  assert.equal(c.processing.upsertProvider({ ...provider, enabled: true }), undefined);
  assert.equal(c.processing.updateProviderCapabilities(provider.id, { health: 'healthy' }), null);
  assert.throws(() => c.processing.createAttempt({ taskId: task.id, providerId: provider.id }), { code: 'provider_unavailable' });

  const history = await request(c, `/api/v1/attempts/${attempt.id}`);
  assert.equal(history.status, 200);
  const record = await history.json();
  assert.equal(record.attempt.providerId, provider.id);
  assert.equal(record.attempt.status, 'ready_for_review');
  assert.equal(record.logs[0].message, 'Preserved log');
  assert.equal(c.processing.getAttemptProvenance(attempt.id).submission.providerId, provider.id);
  assert.equal(c.database.prepare('SELECT status FROM viewer_acceptance_ack_outbox WHERE event_id=?').get('receipt').status, 'delivered');
  assert.equal(c.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='provider.deleted' AND entity_id=?").get(provider.id).n, 1);
  assert.deepEqual(c.database.prepare('PRAGMA foreign_key_check').all(), []);
});


test('node deletion rolls back its receipt, audit, and provider together when receipt completion fails', async t => {
  const c = await fixture(t);
  const provider = c.processing.upsertProvider({ type: 'nodeodm', displayName: 'Idle node', endpoint: 'https://idle.example' });
  const route = `/api/v1/processing/providers/${provider.id}`;
  const key = 'atomic-node-delete';
  const options = { method: 'DELETE', key, body: {} };
  c.database.exec(`CREATE TRIGGER interrupt_node_delete_receipt BEFORE UPDATE OF response_status ON admin_idempotency
    WHEN NEW.idempotency_key='atomic-node-delete' BEGIN SELECT RAISE(ABORT,'test receipt interruption'); END`);
  assert.equal((await request(c, route, options)).status, 500);
  assert.ok(c.processing.getProvider(provider.id));
  assert.equal(c.database.prepare('SELECT COUNT(*) n FROM admin_idempotency WHERE idempotency_key=?').get(key).n, 0);
  assert.equal(c.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='provider.deleted' AND entity_id=?").get(provider.id).n, 0);
  c.database.exec('DROP TRIGGER interrupt_node_delete_receipt');

  const completed = await request(c, route, options);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { deleted: true });
  const repeated = await request(c, route, options);
  assert.equal(repeated.headers.get('Idempotency-Replayed'), 'true');
  assert.deepEqual(await repeated.json(), { deleted: true });
  assert.equal((await request(c, route, { ...options, body: { changed: true } })).status, 409);
});

test('node deletion waits for durable remote cancellation evidence, including legacy cancellations', async t => {
  let cancelCalled, releaseCancel, remoteStatus = 20;
  const cancelStarted = new Promise(resolve => { cancelCalled = resolve; });
  const cancelReleased = new Promise(resolve => { releaseCancel = resolve; });
  t.after(releaseCancel);
  const c = await fixture(t, {
    permissions: ['viewer.providers.write', 'viewer.processing.write'],
    providerFetch: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === '/task/cancel') {
        cancelCalled();
        await cancelReleased;
        return Response.json({ error: 'Provider did not acknowledge cancellation' });
      }
      return Response.json({ uuid: pathname.split('/')[2], status: { code: remoteStatus } });
    },
  });
  const provider = c.processing.upsertProvider({ type: 'nodeodm', displayName: 'Running node', endpoint: 'https://running.example', enabled: true });
  const sealed = c.credentials.seal(provider.id, TOKEN);
  c.processing.setProviderCredential(provider.id, sealed);
  c.database.prepare('UPDATE processing_providers SET enabled=1 WHERE id=?').run(provider.id);
  const project = c.processing.createProject({ displayName: 'Cancelled processing' });
  const dataset = c.processing.createDataset({ projectId: project.id, displayName: 'Inputs', storageMode: 'managed', rootKey: 'datasets', relativePath: 'cancellation-inputs' });
  const hash = 'a'.repeat(64);
  c.processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: hash }], hash);
  const run = (label, node = provider) => {
    const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: label });
    return c.processing.createAttempt({ taskId: task.id, providerId: node.id });
  };
  const legacy = run('Legacy committed');
  const unknownOriginProvider = c.processing.upsertProvider({ type: 'nodeodm', displayName: 'Legacy node', endpoint: 'https://legacy.example', enabled: true });
  c.processing.setProviderCredential(unknownOriginProvider.id, c.credentials.seal(unknownOriginProvider.id, TOKEN));
  c.database.prepare('UPDATE processing_providers SET enabled=1 WHERE id=?').run(unknownOriginProvider.id);
  const unknownOrigin = run('Legacy committed with unknown origin', unknownOriginProvider);
  c.database.prepare('DELETE FROM processing_attempt_provenance WHERE attempt_id=?').run(unknownOrigin.id);
  c.database.prepare("UPDATE processing_attempts SET submission_phase='committed' WHERE id=?").run(unknownOrigin.id);
  c.processing.cancelAttempt(unknownOrigin.id, 'legacy-staff');
  assert.equal(c.processing.providerCancellationTargetMatches(unknownOrigin, unknownOriginProvider), false);
  const neverStarted = run('Never sent');
  const active = run('Cancellation in flight');
  c.database.prepare("UPDATE processing_attempts SET submission_phase='committed' WHERE id=?").run(legacy.id);
  c.processing.cancelAttempt(legacy.id, 'legacy-staff');
  c.database.prepare("UPDATE audit_events SET details_json='{}' WHERE entity_id=? AND action='processing_attempt.cancelled'").run(legacy.id);
  c.processing.cancelAttempt(neverStarted.id, 'staff');
  assert.equal(c.processing.providerCancellationUnsettled(provider.id, neverStarted.id), false);
  assert.equal(c.processing.providerCancellationUnsettled(provider.id, legacy.id), true);
  c.processing.transitionAttempt(active.id, 'running');
  const cancel = (attempt, key) => request(c, `/api/v1/attempts/${attempt.id}/cancel`, { method: 'POST', key, body: {} });
  const remove = key => request(c, `/api/v1/processing/providers/${provider.id}`, { method: 'DELETE', key, body: {} });
  const cancelling = cancel(active, 'upstream-cancel-0001');
  try {
    await Promise.race([cancelStarted, cancelling.then(() => assert.fail('Cancellation did not reach the provider'))]);
    assert.equal(c.processing.getAttempt(active.id).status, 'cancelled');
    assert.equal((await (await remove('during-cancel-0001')).json()).code, 'provider_cancellation_unconfirmed');
    assert.ok(c.processing.getProviderCredential(provider.id));
  } finally {
    releaseCancel();
  }
  assert.equal((await cancelling).status, 200);
  assert.equal((await (await remove('after-failure-0001')).json()).code, 'provider_cancellation_unconfirmed');
  assert.equal((await cancel(active, 'check-running-0001')).status, 200);
  assert.equal(c.processing.providerCancellationUnsettled(provider.id, active.id), true);

  remoteStatus = 50;
  assert.equal((await cancel(active, 'check-cancelled-0001')).status, 200);
  assert.equal(c.processing.providerCancellationUnsettled(provider.id, active.id), false);
  assert.equal((await (await remove('legacy-still-held')).json()).code, 'provider_cancellation_unconfirmed');
  assert.equal((await cancel(legacy, 'check-legacy-0001')).status, 200);
  c.database.prepare('UPDATE processing_providers SET enabled=0 WHERE id=?').run(provider.id);
  assert.equal((await remove('settled-delete-0001')).status, 200);
  assert.equal((await cancel(unknownOrigin, 'check-unknown-0001')).status, 200);
  const unknownDelete = await request(c, `/api/v1/processing/providers/${unknownOriginProvider.id}`, { method: 'DELETE', key: 'unknown-delete-0001', body: {} });
  assert.equal((await unknownDelete.json()).code, 'provider_cancellation_unconfirmed');
  assert.ok(c.processing.getProviderCredential(unknownOriginProvider.id));
  assert.equal(c.database.prepare("SELECT COUNT(*) n FROM processing_events WHERE event_type='provider.cancellation_settled'").get().n, 2);
});


test('node deletion distinguishes local submission and poll failures from proven terminal runs', async t => {
  const c = await fixture(t);
  const project = c.processing.createProject({ displayName: 'Failed processing' });
  const dataset = c.processing.createDataset({ projectId: project.id, displayName: 'Inputs', storageMode: 'managed', rootKey: 'datasets', relativePath: 'failure-inputs' });
  const hash = 'a'.repeat(64);
  c.processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: hash }], hash);
  for (const scenario of [
    { label: 'preflight', phase: 'new', terminal: true },
    { label: 'commit', phase: 'committing', terminal: false },
    { label: 'initialization', phase: 'new', initialization: true, terminal: false },
    { label: 'poll', phase: 'new', poll: 'provider_observation_unavailable', terminal: false },
    { label: 'provider failure', phase: 'committed', poll: 'provider_failed', terminal: true },
    { label: 'provider cancellation', phase: 'committed', poll: 'provider_cancelled', terminal: true },
    { label: 'downstream failure', phase: 'committed', knownComplete: true, terminal: true },
  ]) {
    const provider = c.processing.upsertProvider({ type: 'nodeodm', displayName: scenario.label, endpoint: 'https://failed-node.example', enabled: true });
    const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: scenario.label });
    const attempt = c.processing.createAttempt({ taskId: task.id, providerId: provider.id });
    const job = c.processing.claimJob('failure-worker');
    assert.equal(job.attempt_id, attempt.id);
    if (scenario.initialization) assert.ok(c.processing.beginAttemptInitialization(job.id, 'failure-worker', { freshTaskMissing: true }));
    if (scenario.phase !== 'new') assert.ok(c.processing.setSubmissionStateForJob(job.id, 'failure-worker', scenario.phase, 0));
    const now = new Date().toISOString();
    const code = scenario.poll || 'processing_failed';
    const completed = scenario.knownComplete ? now : null;
    c.processing.transitionAttempt(attempt.id, 'failed', { errorCode: code, upstreamCompletedAt: completed });
    c.processing.failJob(job.id, 'failure-worker', code, 'Synthetic failure fixture');
    if (scenario.poll) {
      c.database.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,error_code,available_at,created_at,updated_at) VALUES (?,?,'reconcile','failed',?,?,?,?)")
        .run(crypto.randomUUID(), attempt.id, code, now, now, now);
    }
    c.database.prepare('UPDATE processing_providers SET enabled=0 WHERE id=?').run(provider.id);
    const result = await request(c, `/api/v1/processing/providers/${provider.id}`, { method: 'DELETE', key: crypto.randomUUID(), body: {} });
    assert.equal(result.status, scenario.terminal ? 200 : 409, scenario.label);
    if (!scenario.terminal) assert.equal((await result.json()).code, 'provider_failure_unconfirmed', scenario.label);
    assert.equal(Boolean(c.processing.getProvider(provider.id)), !scenario.terminal, scenario.label);
  }
});
