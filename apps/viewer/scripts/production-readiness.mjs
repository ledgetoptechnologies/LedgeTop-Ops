#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { config, validate } = require('../server/config');
const { signServiceRequest } = require('../server/serviceAuth');
const { HEADER_NAME: PROXY_HEADER_NAME } = require('../server/proxyGate');
const { resolveEnabledProviderCredentials } = require('../server/processingReadiness');
const { REVISION_HEADER, SCHEMA_HEADER, readRuntimeRevision } = require('../server/runtimeIdentity');
const { MIGRATIONS } = require('../server/database');
const { validateRuntimeProbeHeaders } = await import('./runtime-probe-identity.mjs');

const EXPECTED_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));

const sensitiveValues = new Set();

function sensitive(value) {
  if (typeof value === 'string' && value.length >= 8) sensitiveValues.add(value);
  return value;
}

function redact(value) {
  let result = String(value || 'unknown error');
  for (const secret of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

function fail(message) {
  throw new Error(message);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function has(name) {
  return process.argv.includes(name);
}

function access(target, mode, label) {
  try {
    fs.accessSync(target, mode);
  } catch {
    fail(`${label} is not accessible at ${target}`);
  }
}

function decodedMountPath(value) {
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\');
}

function mountedReadOnly(target) {
  if (!fs.existsSync('/proc/self/mountinfo')) return null;
  const resolved = path.resolve(target);
  const entries = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n');
  let best = null;
  for (const entry of entries) {
    const halves = entry.split(' - ');
    if (halves.length !== 2) continue;
    const left = halves[0].split(' ');
    const mountPoint = decodedMountPath(left[4] || '');
    if (resolved !== mountPoint && !resolved.startsWith(`${mountPoint}/`)) continue;
    if (!best || mountPoint.length > best.mountPoint.length) {
      best = {
        mountPoint,
        options: new Set([...(left[5] || '').split(','), ...(halves[1].split(' ')[2] || '').split(',')]),
      };
    }
  }
  return best ? best.options.has('ro') : null;
}

async function request(baseUrl, requestPath, init = {}) {
  const target = new URL(requestPath, baseUrl);
  const transport = target.protocol === 'https:' ? https : http;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(target.hostname);
  return new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method: init.method || 'GET',
      headers: {
        Host: init.host || config.expectedHost,
        ...(loopback ? { [PROXY_HEADER_NAME]: config.proxySharedSecret } : {}),
        ...(init.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(new Error('response exceeded 2 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: new Headers(res.headers),
        async text() { return Buffer.concat(chunks).toString('utf8'); },
        async bytes() { return Buffer.concat(chunks); },
      }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function signedRequest(baseUrl, authSecret, requestPath, init = {}) {
  const method = init.method || 'GET';
  const body = init.body || '';
  return request(baseUrl, requestPath, {
    ...init,
    method,
    headers: {
      ...signServiceRequest({
        secret: authSecret,
        keyId: config.serviceAuthKeyId,
        method,
        path: requestPath,
        body,
      }),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

async function json(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

function assetSummary(models) {
  const totals = { models: models.length, ready: 0, pointCloud: 0, ept: 0, lod: 0, verifiedLod: 0, fullMesh: 0 };
  for (const model of models) {
    if (model?.available) totals.ready += 1;
    if (model?.assets?.pointCloud || model?.assets?.ept) totals.pointCloud += 1;
    if (model?.assets?.ept) totals.ept += 1;
    if (model?.assets?.tiles) totals.lod += 1;
    if (model?.assets?.glb || model?.assets?.obj) totals.fullMesh += 1;
    if (model?.assets?.tiles && model?.assets?.glb && model?.lodProvenance) totals.verifiedLod += 1;
  }
  return totals;
}

function capabilityParts(assetUrl, expectedModelId) {
  const parsed = new URL(assetUrl, config.publicBaseUrl);
  const parts = parsed.pathname.split('/');
  if (parts[1] !== 'session-assets' || !parts[2] || parts[3] !== expectedModelId || !parts[4]) {
    fail('browser session returned an invalid protected asset URL');
  }
  return { parsed, parts, prefix: `/${parts.slice(1, 5).join('/')}/` };
}

function nestedCapabilityUrl(parentUrl, relativeUrl, expectedModelId) {
  if (typeof relativeUrl !== 'string' || !relativeUrl || relativeUrl.startsWith('data:')) return null;
  const parent = new URL(parentUrl);
  const nested = new URL(relativeUrl, parent);
  const { prefix } = capabilityParts(parent, expectedModelId);
  if (nested.origin !== parent.origin || !nested.pathname.startsWith(prefix)) return null;
  return nested.toString();
}

function tileContentUris(tile, result = []) {
  if (!tile || typeof tile !== 'object') return result;
  for (const content of [tile.content, ...(Array.isArray(tile.contents) ? tile.contents : [])]) {
    const uri = content && (content.uri || content.url);
    if (typeof uri === 'string') result.push(uri);
  }
  for (const child of Array.isArray(tile.children) ? tile.children : []) tileContentUris(child, result);
  return result;
}

async function requirePrivateResponse(response, label, expectedStatus) {
  if (response.status !== expectedStatus) fail(`${label} returned HTTP ${response.status}, expected ${expectedStatus}`);
  if (response.headers.get('cache-control') !== 'private, no-store') {
    fail(`${label} did not return Cache-Control: private, no-store`);
  }
}

async function rangeFetch(baseUrl, assetUrl, label) {
  const response = await request(baseUrl, assetUrl, { headers: { Range: 'bytes=0-0' } });
  await requirePrivateResponse(response, label, 206);
  if (!/^bytes 0-0\/\d+$/.test(response.headers.get('content-range') || '')) {
    fail(`${label} returned an invalid Content-Range`);
  }
  if ((await response.bytes()).length !== 1) fail(`${label} did not return exactly one requested byte`);
}

async function jsonAsset(baseUrl, assetUrl, label) {
  const response = await request(baseUrl, assetUrl);
  await requirePrivateResponse(response, label, 200);
  return json(response, label);
}

async function verifyLiveCapability({ baseUrl, authSecret, model }) {
  if (!model?.activeVersion?.id) fail('the selected model has no active version for capability verification');
  if (!model.available) fail('the selected model is not ready for capability verification');

  const sessionPath = `/api/v1/models/${encodeURIComponent(model.id)}/sessions`;
  const ttlText = option('--capability-ttl-seconds')
    || process.env.VIEWER_READINESS_CAPABILITY_TTL_SECONDS
    || '120';
  const ttlSeconds = Number(ttlText);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) {
    fail('--capability-ttl-seconds must be an integer from 30 through 600');
  }
  const requestedExpiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const subject = `production-readiness:${crypto.randomUUID()}`;
  const idempotencyKey = `readiness-session-${crypto.randomUUID()}`;
  const sessionBody = JSON.stringify({
    subject,
    audience: 'ops',
    modelVersionId: model.activeVersion.id,
    authorizationExpiresAt: requestedExpiry,
    permissions: { view: true, measure: true, cameras: true, download: false },
  });

  // Fail closed before making the one authorized mutation.
  const unsigned = await request(baseUrl, sessionPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: sessionBody,
  });
  if (unsigned.status !== 401) fail(`unsigned session creation returned HTTP ${unsigned.status}, expected 401`);
  const missingCurrent = await request(baseUrl, '/api/v1/sessions/current');
  if (missingCurrent.status !== 401) fail(`unauthorized current-session probe returned HTTP ${missingCurrent.status}, expected 401`);

  const create = () => signedRequest(baseUrl, authSecret, sessionPath, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: sessionBody,
  });
  const grantResponse = await create();
  if (grantResponse.status !== 201) fail(`signed session creation returned HTTP ${grantResponse.status}`);
  if (grantResponse.headers.get('cache-control') !== 'no-store') fail('session grant was cacheable');
  const grant = await json(grantResponse, 'session grant');
  sensitive(grant.grant);
  if (!grant.grant || grant.modelVersionId !== model.activeVersion.id) fail('session grant was not pinned to the requested active version');
  const authorizationExpiry = Date.parse(grant.authorizationExpiresAt || '');
  if (!Number.isFinite(authorizationExpiry) || authorizationExpiry <= Date.now() || authorizationExpiry > Date.parse(requestedExpiry)) {
    fail('session grant returned an invalid authorization expiry');
  }

  const replayResponse = await create();
  if (replayResponse.status !== 201 || replayResponse.headers.get('idempotency-replayed') !== 'true') {
    fail('session creation did not replay idempotently');
  }
  const replay = await json(replayResponse, 'idempotent session replay');
  if (JSON.stringify(replay) !== JSON.stringify(grant)) fail('idempotent session replay changed the grant response');

  const redemption = await request(baseUrl, '/api/v1/sessions/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: grant.grant }),
  });
  if (redemption.status !== 200) fail(`session redemption returned HTTP ${redemption.status}`);
  if (redemption.headers.get('cache-control') !== 'no-store') fail('redeemed browser session was cacheable');
  const browserSession = await json(redemption, 'browser session');
  sensitive(browserSession.accessToken);
  if (!browserSession.accessToken || browserSession.model?.id !== model.id) fail('browser capability was not scoped to the selected model');
  if (browserSession.model?.activeVersion?.id !== model.activeVersion.id) fail('browser capability was not scoped to the selected model version');
  if (browserSession.audience !== 'ops' || browserSession.subject !== subject) fail('browser capability identity did not match the Ops request');
  const browserExpiry = Date.parse(browserSession.expiresAt || '');
  // The redemption handler derives TTL and expiry with two adjacent wall-clock
  // reads, so allow only sub-second scheduling skew beyond the serialized
  // authorization timestamp.
  if (!Number.isFinite(browserExpiry) || browserExpiry <= Date.now() || browserExpiry > authorizationExpiry + 1000) {
    fail('browser capability returned an invalid expiry');
  }

  const replayRedemption = await request(baseUrl, '/api/v1/sessions/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: grant.grant }),
  });
  if (replayRedemption.status !== 410) fail(`replayed grant redemption returned HTTP ${replayRedemption.status}, expected 410`);

  const current = await request(baseUrl, '/api/v1/sessions/current', {
    headers: { Authorization: `Bearer ${browserSession.accessToken}` },
  });
  if (current.status !== 200) fail(`authorized current-session probe returned HTTP ${current.status}`);
  if (current.headers.get('cache-control') !== 'no-store') fail('current browser session was cacheable');
  const currentSession = await json(current, 'current browser session');
  sensitive(currentSession.accessToken);
  if (currentSession.sessionId !== browserSession.sessionId || currentSession.model?.id !== model.id) {
    fail('current browser session did not match the redeemed capability');
  }

  const assets = browserSession.model.assets || {};
  const assetKinds = [];
  let rangeChecks = 0;
  const genericKind = ['glb', 'pointCloud', 'obj', 'ortho', 'dsm', 'dtm', 'shots']
    .find((kind) => typeof assets[kind] === 'string' && assets[kind]);
  if (genericKind) {
    capabilityParts(assets[genericKind], model.id);
    await rangeFetch(baseUrl, assets[genericKind], `${genericKind} asset range`);
    assetKinds.push(genericKind);
    rangeChecks += 1;
  }

  if (assets.tiles) {
    capabilityParts(assets.tiles, model.id);
    const tileset = await jsonAsset(baseUrl, assets.tiles, '3D Tiles manifest');
    assetKinds.push('tiles');
    const nested = tileContentUris(tileset.root)
      .map((uri) => nestedCapabilityUrl(new URL(assets.tiles, baseUrl), uri, model.id))
      .find(Boolean);
    if (nested) {
      await rangeFetch(baseUrl, nested, 'nested 3D Tiles content range');
      assetKinds.push('tiles-child');
      rangeChecks += 1;
    }
  }

  if (assets.ept) {
    capabilityParts(assets.ept, model.id);
    const ept = await jsonAsset(baseUrl, assets.ept, 'EPT manifest');
    assetKinds.push('ept');
    if (ept.hierarchyType === 'json') {
      const hierarchy = nestedCapabilityUrl(new URL(assets.ept, baseUrl), 'ept-hierarchy/0-0-0-0.json', model.id);
      if (!hierarchy) fail('EPT hierarchy did not retain the protected capability scope');
      await jsonAsset(baseUrl, hierarchy, 'nested EPT hierarchy');
      assetKinds.push('ept-hierarchy');
    }
    const extension = { laszip: 'laz', binary: 'bin', zstandard: 'zst' }[ept.dataType];
    if (extension) {
      const nested = nestedCapabilityUrl(new URL(assets.ept, baseUrl), `ept-data/0-0-0-0.${extension}`, model.id);
      if (!nested) fail('EPT root node did not retain the protected capability scope');
      await rangeFetch(baseUrl, nested, 'nested EPT root-node range');
      assetKinds.push('ept-node');
      rangeChecks += 1;
    }
  }
  if (rangeChecks === 0) fail('the selected model exposed no representative byte-range asset');

  const representative = Object.values(assets).find((value) => typeof value === 'string' && value.startsWith('/session-assets/'));
  if (!representative) fail('browser session exposed no protected model asset');
  const { parts } = capabilityParts(representative, model.id);
  const parsed = new URL(representative, baseUrl);
  const unscoped = new URL(parsed);
  unscoped.pathname = `/${['assets', ...parts.slice(3)].join('/')}`;
  if ((await request(baseUrl, unscoped.toString())).status !== 403) fail('asset route without a capability did not fail closed');
  const wrongModel = new URL(parsed);
  wrongModel.pathname = `/${[...parts.slice(1, 3), '00000000-0000-4000-8000-000000000000', ...parts.slice(4)].join('/')}`;
  if ((await request(baseUrl, wrongModel.toString())).status !== 403) fail('cross-model capability use did not fail closed');
  const badToken = new URL(parsed);
  badToken.pathname = `/${[parts[1], 'A'.repeat(43), ...parts.slice(3)].join('/')}`;
  if ((await request(baseUrl, badToken.toString())).status !== 403) fail('tampered capability did not fail closed');

  return {
    ok: true,
    audience: 'ops',
    assetKinds,
    rangeChecks,
    failClosedChecks: 6,
  };
}

async function main() {
  const problems = validate();
  if (problems.length) fail(`invalid production configuration: ${problems.join('; ')}`);
  if (!config.production) fail('NODE_ENV must be production');
  if (config.emergencyAdminEnabled) fail('EMERGENCY_ADMIN_ENABLED must remain false');
  const authSecret = sensitive(config.serviceAuthKeys?.[config.serviceAuthKeyId] || config.serviceAuthSecret);
  sensitive(config.sessionSecret);
  sensitive(config.proxySharedSecret);
  if (!authSecret) fail(`no service authentication secret is configured for ${config.serviceAuthKeyId}`);
  if (Object.values(config.serviceAuthKeys || { [config.serviceAuthKeyId]: authSecret }).includes(config.sessionSecret))
    fail('SESSION_SECRET and service authentication secrets must be independent');

  access(config.dataDir, fs.constants.R_OK | fs.constants.W_OK, 'Viewer data directory');
  if (config.webodmEnabled) access(config.webodmMediaMount, fs.constants.R_OK, 'WebODM media mount');
  if (config.derivativesMount) access(config.derivativesMount, fs.constants.R_OK, 'derivatives mount');

  if (has('--verify-mount-options')) {
    const webodmReadOnly = mountedReadOnly(config.webodmMediaMount);
    const derivativesReadOnly = config.derivativesMount ? mountedReadOnly(config.derivativesMount) : null;
    const dataReadOnly = mountedReadOnly(config.dataDir);
    if (webodmReadOnly !== true) fail('WebODM media mount is not read-only');
    if (config.derivativesMount && derivativesReadOnly !== true) fail('derivatives mount is not read-only');
    if (dataReadOnly !== false) fail('Viewer data mount is not writable');
  }

  let processingReadiness = null;
  if (has('--require-processing')) {
    if (!config.processingPlatformEnabled) fail('PROCESSING_PLATFORM_ENABLED must be true for --require-processing');
    for (const [label,target] of [['datasets',config.datasetsMount],['models',config.modelsMount],['cache',config.cacheMount],['trash',config.trashMount]]) access(target,fs.constants.R_OK|fs.constants.W_OK,`${label} mount`);
    for (const [label,target] of [['dataset import',config.datasetImportMount],['Terra import',config.terraImportMount],['WebODM import',config.webodmMediaMount]]) if(target)access(target,fs.constants.R_OK,`${label} mount`);
    if (fs.statSync(config.datasetsMount).dev !== fs.statSync(config.trashMount).dev) fail('datasets and trash mounts must share a filesystem for atomic recovery');
    const spaces={};for(const [label,target] of [['datasets',config.datasetsMount],['models',config.modelsMount],['cache',config.cacheMount],['trash',config.trashMount]]){const stat=fs.statfsSync(target),available=Number(stat.bavail)*Number(stat.bsize),total=Number(stat.blocks)*Number(stat.bsize),reserve=Math.max(config.storageReserveBytes,Math.ceil(total*config.storageReservePercent/100));if(available<=reserve)fail(`${label} mount is below the configured storage reserve`);spaces[label]={available,total,reserve};}
    const database=new DatabaseSync(config.databasePath,{readOnly:true});try{const heartbeatRow=database.prepare("SELECT value FROM app_state WHERE key='processing_worker_heartbeat'").get(),heartbeat=heartbeatRow&&JSON.parse(heartbeatRow.value);if(!heartbeat||Date.parse(heartbeat.at)<=Date.now()-30000)fail('processing worker heartbeat is missing or stale');const providers=database.prepare('SELECT id,capabilities_json,capability_fingerprint FROM processing_providers WHERE enabled=1').all();if(!providers.length)fail('no processing provider is enabled');resolveEnabledProviderCredentials(database,config);const required=['pc-ept','3d-tiles','gltf'];for(const provider of providers){const capabilities=JSON.parse(provider.capabilities_json||'{}'),names=new Set((capabilities.options||[]).map((item)=>item.name));if(!provider.capability_fingerprint||required.some((name)=>!names.has(name)))fail(`provider ${provider.id} lacks a fingerprint or required Viewer outputs`);}const operationCounts=database.prepare("SELECT status,COUNT(*) AS count FROM dataset_operations WHERE status IN ('queued','leased','failed') GROUP BY status").all();const stale=database.prepare("SELECT COUNT(*) AS count FROM dataset_operations WHERE status='leased' AND lease_expires_at<=?").get(new Date().toISOString()).count;if(stale)fail(`${stale} dataset operation leases are stale and awaiting reconciliation`);const lifecycleCounts=database.prepare("SELECT status,COUNT(*) AS count FROM storage_mutations WHERE status IN ('intent','fs_applied','failed') GROUP BY status").all();if(lifecycleCounts.some((row)=>row.status==='failed'&&row.count>0))fail('one or more storage lifecycle mutations require operator repair');processingReadiness={workerAt:heartbeat.at,enabledProviders:providers.length,operationCounts,lifecycleCounts,spaces};}finally{database.close();}
  }

  const baseUrl = option('--base-url') || process.env.VIEWER_READINESS_BASE_URL || `http://127.0.0.1:${config.port}`;
  const healthResponse = await request(baseUrl, '/api/v1/health');
  if (healthResponse.status !== 200 || (await json(healthResponse, 'health probe')).ok !== true)
    fail(`health probe returned HTTP ${healthResponse.status}`);

  const readyResponse = await request(baseUrl, '/api/v1/ready');
  const ready = await json(readyResponse, 'readiness probe');
  if (readyResponse.status !== 200 || ready.ok !== true || ready.missing?.length)
    fail(`readiness probe returned HTTP ${readyResponse.status}: ${(ready.missing || []).join(', ')}`);

  const bakedRevision = readRuntimeRevision();
  const identityError = validateRuntimeProbeHeaders({
    healthHeaders: healthResponse.headers,
    readyHeaders: readyResponse.headers,
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    bakedRevision,
  });
  if (identityError) fail(identityError);
  const healthRevision = healthResponse.headers.get(REVISION_HEADER);
  const healthSchema = healthResponse.headers.get(SCHEMA_HEADER);

  const root = await request(baseUrl, '/');
  const rootLocation = root.headers.get('location');
  let canonicalOpsRedirect = false;
  try {
    const parsed = new URL(rootLocation);
    canonicalOpsRedirect = parsed.origin === config.opsBaseUrl && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch { /* invalid or missing Location */ }
  if (root.status !== 302 || !canonicalOpsRedirect)
    fail(`bare Viewer origin returned HTTP ${root.status} with Location ${rootLocation || '(missing)'}`);
  const admin = await request(baseUrl, '/api/admin/session');
  if (admin.status !== 404) fail(`legacy admin API returned HTTP ${admin.status}, expected 404`);
  const wrongHost = await request(baseUrl, '/', { host: 'invalid.example' });
  if (wrongHost.status !== 421) fail(`unexpected host returned HTTP ${wrongHost.status}, expected 421`);

  const catalogPath = '/api/v1/models';
  const authHeaders = signServiceRequest({
    secret: authSecret,
    keyId: config.serviceAuthKeyId,
    method: 'GET',
    path: catalogPath,
  });
  const catalogResponse = await request(baseUrl, catalogPath, { headers: authHeaders });
  if (catalogResponse.status !== 200) fail(`signed model catalog returned HTTP ${catalogResponse.status}`);
  const catalog = await json(catalogResponse, 'model catalog');
  if (!Array.isArray(catalog.models)) fail('model catalog did not return a models array');

  const selectedId = option('--model');
  let selected = selectedId ? catalog.models.find((model) => model.id === selectedId) : null;
  if (selectedId && !selected) {
    const modelPath = `/api/v1/models/${encodeURIComponent(selectedId)}`;
    const modelResponse = await signedRequest(baseUrl, authSecret, modelPath);
    if (modelResponse.status === 200) selected = (await json(modelResponse, 'exact model lookup')).model;
  }
  if (selectedId && !selected) fail(`required model ${selectedId} was not discovered`);
  const candidates = selected ? [selected] : catalog.models;
  const summary = assetSummary(candidates);
  if (has('--require-models') && summary.ready === 0) fail('no ready Viewer models were discovered');
  if (has('--require-point-cloud') && summary.pointCloud === 0) fail('no EPT/LAS/LAZ/PLY point cloud was discovered');
  if (has('--require-ept') && summary.ept === 0) fail('no browser-scalable EPT point cloud was discovered');
  if (has('--require-lod') && summary.verifiedLod === 0)
    fail('no LOD model with a full mesh and verified lod-provenance.json was discovered');

  let protectedCapability = null;
  if (has('--live-capability')) {
    if (!selectedId) fail('--live-capability requires an exact --model id or alias');
    protectedCapability = await verifyLiveCapability({ baseUrl, authSecret, model: selected });
  }

  const output = {
    ok: true,
    host: config.expectedHost,
    build: { revision: healthRevision, schemaVersion: Number(healthSchema) },
    webodmMount: config.webodmMediaMount,
    derivativesMount: config.derivativesMount || null,
    ...(processingReadiness ? { processing: processingReadiness } : {}),
    ...summary,
    ...(protectedCapability ? { protectedCapability } : {}),
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Viewer readiness failed: ${redact(error.message)}\n`);
  process.exitCode = 1;
});
