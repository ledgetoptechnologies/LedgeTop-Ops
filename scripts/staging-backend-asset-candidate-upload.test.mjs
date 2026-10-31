import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { canonical, hash } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID } from './staging-requirements.mjs';
import { compileStagingBackendReleasePlan } from './staging-backend-release-plan.mjs';
import { createStagingBackendAssetCandidateUploader, validateStagingBackendAssetCoverageEvidence,
  validateStagingBackendAssetMaterialization } from './staging-backend-asset-candidate-upload.mjs';

const OPS = '1ffe4525-7e29-4ea2-a407-726abf7f10c6';
const CLIENT = '3ba4c8c9-70b4-4696-810f-0503f512e728';
const CLIENT_LATEST = '4f124119-c34b-4608-ba90-ad438c47a90b';
const SYNC = '470134b4-ef95-4702-98f3-110e4f4cbbb0';
const SOURCE = 'c2ce0b6feaa3f410dd6284bd5ce5763818958ec8';
const CANDIDATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUNTIME_PROOF = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../release-records/unification-20261024/record-v7-assets-proof-20261031.json');
const BLAKE3_PATH = 'C:/Users/fstor/.codex/artifacts/client-viewer-startup-build-c36a635a-20261027/apps/client/node_modules/blake3-wasm';
const blake3 = createRequire(import.meta.url)(BLAKE3_PATH).hash;
const disabled = Object.freeze({ CLIENT_PORTAL_REQUEST_V2_ENABLED: null, CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: 'false',
  CLIENT_PORTAL_OPS_INQUIRIES_ENABLED: null, CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED: 'false',
  CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED: null, OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: null,
  NATIVE_STAFF_MASTER_ENABLED: null, NATIVE_STAFF_MANAGEMENT_ENABLED: 'false' });
const clone = value => structuredClone(value);

function bindings(app) {
  const rows = [
    { name: 'ASSETS', type: 'assets' },
    { name: 'DELIVERY_DB', type: 'd1', id: 'b6f653ab-9acd-4421-9ad0-207754b59aeb', database_id: 'b6f653ab-9acd-4421-9ad0-207754b59aeb', database_name: 'client-data-staging' },
    { name: 'DATA_BUCKET', type: 'r2_bucket', bucket_name: 'client-data-staging' },
    { name: 'SESSION_SECRET', type: 'secret_text' },
    { name: 'PLAIN_FLAG', type: 'plain_text', textSHA256: hash('false') },
  ];
  if (app === 'operations') rows.push({ name: 'OPS_DB', type: 'd1', id: '78b34173-b168-4e3d-9832-bb9d245cc6b8', database_id: '78b34173-b168-4e3d-9832-bb9d245cc6b8', database_name: 'ltds-ops-staging' });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function controlWorker(app, versionId, latestVersionId = versionId) {
  const workerName = app === 'operations' ? 'ledgetop-ops-staging' : app === 'client' ? 'ledgetop-clients-staging' : 'ledgetop-ops-sync-staging';
  const runtime = { exports: app === 'operations' ? { InquiryIngress: { type: 'durable_object_namespace', class_name: 'OperationsNativePrincipalInquiryIngress' } } : {},
    assets: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', static_routing: { user_worker: ['/api/*'] }, serve_directly: true, raw_run_worker_first: ['/api/*'], base_path: '/' },
    compatibility_date: '2026-07-22', compatibility_flags: ['nodejs_compat'], usage_model: 'standard', cache_options: { enabled: true } };
  if (app === 'operations') runtime.containers = [{ class_name: 'ThumbnailRendererContainer' }];
  if (app === 'client') runtime.limits = { cpu_ms: 300000, subrequests: 25000 };
  if (app === 'sync') delete runtime.assets;
  const rows = app === 'sync' ? [
    { name: 'OPS_DB', type: 'd1', id: '78b34173-b168-4e3d-9832-bb9d245cc6b8', database_id: '78b34173-b168-4e3d-9832-bb9d245cc6b8', database_name: 'ltds-ops-staging' },
    { name: 'DELIVERY_DB', type: 'd1', id: 'b6f653ab-9acd-4421-9ad0-207754b59aeb', database_id: 'b6f653ab-9acd-4421-9ad0-207754b59aeb', database_name: 'client-data-staging' },
  ] : bindings(app);
  const settings = { placement: {}, compatibility_date: runtime.compatibility_date, compatibility_flags: runtime.compatibility_flags,
    usage_model: 'standard', tags: [], tail_consumers: [], logpush: false, observability: { enabled: true },
    annotations: { 'workers/message': `synthetic ${app}`, 'workers/tag': 'staging', 'workers/triggered_by': 'api' }, bindings: clone(rows) };
  if (app === 'client') settings.limits = clone(runtime.limits);
  const assetsConfig = { base_path: '/', html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] };
  return { workerName, activeVersionId: versionId, latestVersionId,
    deployment: { versions: [{ version_id: versionId, percentage: 100 }] },
    version: { id: versionId, number: 1, metadata: {}, annotations: {}, resources: { script: { handlers: ['fetch'], named_handlers: [], last_deployed_from: 'wrangler' }, script_runtime: runtime, bindings: clone(rows) } },
    settings, modern: { id: versionId, number: 1, compatibility_date: runtime.compatibility_date, compatibility_flags: clone(runtime.compatibility_flags),
      usage_model: runtime.usage_model, exports: clone(runtime.exports), ...(runtime.cache_options ? { cache_options: clone(runtime.cache_options) } : {}),
      ...(runtime.containers ? { containers: clone(runtime.containers) } : {}), ...(runtime.limits ? { limits: clone(runtime.limits) } : {}),
      ...(app === 'sync' ? {} : { assets: { config: assetsConfig } }), modules: [{ name: 'index.js', contentType: 'application/javascript+module', bytes: 8_192, sha256: hash(`${app}-baseline`) }],
      bindings: clone(rows), env: Object.fromEntries(rows.map(row => [row.name, clone(row)])) },
    schedules: { schedules: app === 'operations' ? [{ cron: '*/15 * * * *' }] : app === 'client' ? [{ cron: '15 * * * *' }] : [] },
    selectedFlags: app === 'sync' ? {} : { ...disabled }, rawBindingsSHA256: hash(canonical(rows)), rawControlSHA256: hash(`${app}-control`) };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-backend-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixedNow = Date.now();
  const workers = { operations: controlWorker('operations', OPS), client: controlWorker('client', CLIENT, CLIENT_LATEST), sync: controlWorker('sync', SYNC) };
  const capture = { schemaVersion: 1, purpose: 'staging-v4-current-controls-and-full-schema-readonly-v1', environment: 'staging',
    accountId: STAGING_ACCOUNT_ID, observedAt: new Date(fixedNow - 20_000).toISOString(), workers,
    schema: { OPS_DB: { id: '78b34173-b168-4e3d-9832-bb9d245cc6b8', tables: [] }, DELIVERY_DB: { id: 'b6f653ab-9acd-4421-9ad0-207754b59aeb', tables: [] } },
    secretValuesPersisted: false, applicationRowsRead: 0, resourceWrites: 0 };
  const writeBytes = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; };
  const writeJson = (name, value) => { const bytes = Buffer.from(JSON.stringify(value)); const file = writeBytes(name, bytes); return { path: file, sha256: hash(bytes) }; };
  const controlsFile = writeJson('controls.json', capture);
  const app = 'operations';
  const main = writeBytes('staging-native-authority-entrypoint.js', Buffer.from('export default { fetch(){ return new Response("candidate") } };'));
  const map = writeBytes('staging-native-authority-entrypoint.js.map', Buffer.from(JSON.stringify({ version: 3, file: 'staging-native-authority-entrypoint.js', sources: ['worker.ts'], sourcesContent: ['synthetic'], names: [], mappings: '' })));
  const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
  const artifact = { sourceCommit: SOURCE, main: pin(main), sourceMap: pin(map) };
  const filesRoot = path.join(root, 'assets'); fs.mkdirSync(filesRoot);
  const rawAssets = { 'index.html': Buffer.from('<html>retained</html>'), 'assets/app.js': Buffer.from('export const retained = true;') };
  const assetRows = Object.entries(rawAssets).map(([relative, bytes]) => {
    const abs = path.join(filesRoot, relative); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, bytes);
    return { path: `/${relative}`, size: bytes.length, sha256: hash(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const archivedIndex = `/_ui/operations/${hash(rawAssets['index.html']).slice(0, 40)}/index.html`;
  const archivedRelative = archivedIndex.slice(1), archivedAbsolute = path.join(filesRoot, ...archivedRelative.split('/'));
  fs.mkdirSync(path.dirname(archivedAbsolute), { recursive: true }); fs.writeFileSync(archivedAbsolute, rawAssets['index.html']);
  rawAssets[archivedRelative] = rawAssets['index.html'];
  assetRows.push({ path: archivedIndex, size: rawAssets['index.html'].length, sha256: hash(rawAssets['index.html']) });
  assetRows.sort((a, b) => a.path.localeCompare(b.path));
  const ignore = Buffer.from('synthetic inventory marker\n'); fs.writeFileSync(path.join(filesRoot, '.assetsignore'), ignore);
  const assetsManifest = { schemaVersion: 1, purpose: 'staging-retained-assets-materialization-v1', environment: 'staging',
    accountId: STAGING_ACCOUNT_ID, workerName: workers.operations.workerName, sourceVersionId: OPS,
    observedAt: capture.observedAt, scope: 'local-file-materialization-only', assetsConfig: clone(workers.operations.modern.assets.config),
    files: assetRows, excludedFiles: [{ path: '/.assetsignore', size: ignore.length, sha256: hash(ignore) }] };
  const assetsFile = writeJson('assets.json', assetsManifest);
  const planOptions = { controlsFile, application: app, artifact, sourceCommit: SOURCE,
    retainedAssets: { manifestFile: assetsFile, filesRoot } };
  const heldPlan = compileStagingBackendReleasePlan({ ...planOptions, now: () => fixedNow });
  const sourceReceipts = [];
  for (const kind of ['deployment-history','asset-upload-lineage','current-materialization','served-path-byte-closures']) {
    const receipt = writeJson(`${kind}.json`, { synthetic: true, kind });
    sourceReceipts.push({ kind, ...receipt });
  }
  sourceReceipts.find(row => row.kind === 'current-materialization').sha256 = heldPlan.assetReconstitution.manifestSHA256;
  // The materialization manifest itself is the current-materialization receipt.
  sourceReceipts.find(row => row.kind === 'current-materialization').path = assetsFile.path;
  const lineage = sourceReceipts.find(row => row.kind === 'asset-upload-lineage').sha256;
  const closurePin = sourceReceipts.find(row => row.kind === 'served-path-byte-closures').sha256;
  const releases = [{ deploymentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    from: new Date(fixedNow - 48 * 60 * 60_000 - 2_000).toISOString(), to: new Date(fixedNow - 2_000).toISOString(),
    versionId: OPS, percentage: 100, assetLineageEvidenceSHA256: lineage, closureEvidenceSHA256: closurePin,
    servedAssetClosure: assetRows }];
  const coverageBody = { schemaVersion: 1, purpose: 'staging-served-release-coverage-v1', environment: 'staging', accountId: STAGING_ACCOUNT_ID,
    application: app, workerName: workers.operations.workerName, baselineVersionId: OPS,
    observedAt: new Date(fixedNow - 2_000).toISOString(), window: { from: new Date(fixedNow - 48 * 60 * 60_000 - 2_000).toISOString(), to: new Date(fixedNow - 2_000).toISOString() },
    sourceReceipts, releases };
  const coverageFile = writeJson('coverage.json', coverageBody);
  return { root, fixedNow, capture, controlsFile, planOptions, heldPlan, assetsFile, coverageFile, coverageBody, assetRows, rawAssets, archivedIndex,
    runtimeProofFile: { path: RUNTIME_PROOF, sha256: '0d4c66619a4393594008be2261c865a4b631ad0204de4d5f3e5b21d579b18d84' },
    hashBlake3: bytes => blake3(bytes).toString('hex'), writeJson };
}

function harness(f, { session, bucketResponses = [], createVersion = async () => ({ id: CANDIDATE }), readback = undefined,
  mutateControlsAt = undefined } = {}) {
  const calls = [], journal = new Set(); let call = 0, createdRequest;
  const sdk = {
    async createAssetUploadSession(worker, request, options) { calls.push({ type: 'session', worker, request, options }); return session; },
    async createVersion(worker, request, options) { calls.push({ type: 'version', worker, request, options }); createdRequest = clone(request); return createVersion(worker, request, options); },
  };
  const uploadBucket = async request => { calls.push({ type: 'bucket', request }); return bucketResponses[call++]; };
  const adapter = createStagingBackendAssetCandidateUploader({ sdk, uploadBucket,
    async readFreshControls() {
      if (mutateControlsAt !== undefined && calls.filter(row => row.type === 'session' || row.type === 'bucket').length >= mutateControlsAt) {
        const drifted = clone(f.capture); drifted.workers.operations.latestVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        return f.writeJson('drifted-controls.json', drifted);
      }
      return f.controlsFile;
    }, async readCandidateState(worker, candidateVersionId) { calls.push({ type: 'readback', worker, candidateVersionId }); return typeof readback === 'function' ? readback(createdRequest, candidateVersionId) : readback; },
    journal: { async reserve(key) { if (journal.has(key)) return false; journal.add(key); return true; }, async complete(key) { assert.ok(journal.has(key)); } },
    hashBlake3: f.hashBlake3, now: () => f.fixedNow });
  return { calls, adapter, journal };
}

test('empty asset bucket uses session completion token and creates only an inactive verified candidate', async t => {
  const f = fixture(t), coverage = validateStagingBackendAssetCoverageEvidence({ coverageEvidenceFile: f.coverageFile,
    heldPlan: f.heldPlan, now: () => f.fixedNow });
  assert.equal(coverage.requiredAssetCount, f.assetRows.length);
  assert.equal(Object.hasOwn(coverage, 'requiredAssets'), false);
  assert.deepEqual(validateStagingBackendAssetMaterialization({ heldPlan: f.heldPlan, hashBlake3: f.hashBlake3 }),
    { application: 'operations', fileCount: 3, uniqueUploadCount: 2, duplicateContentPathCount: 1,
      totalBytes: f.assetRows.reduce((sum, row) => sum + row.size, 0) });
  const state = harness(f, { session: { buckets: [], jwt: 'x'.repeat(24) }, readback: request => ({
    latestVersionId: CANDIDATE, deployment: [{ versionId: OPS, percentage: 100 }], candidate: {
      id: CANDIDATE, mainModule: request.main_module,
      modules: request.modules.map(module => { const pin = module.name === f.heldPlan.artifact.main.path.split(/[\\/]/u).at(-1) ? f.heldPlan.artifact.main : f.heldPlan.artifact.sourceMap;
        return { name: module.name, bytes: pin.size, sha256: pin.sha256 }; }),
      bindings: request.bindings, assetsConfig: request.assets.config, compatibilityDate: request.compatibility_date,
      compatibilityFlags: request.compatibility_flags, exports: request.exports,
    },
  }) });
  const originalCreate = state.calls;
  const resultPromise = state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan,
    runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile });
  const result = await resultPromise;
  assert.deepEqual(result, { candidateVersionId: CANDIDATE, readbackVerified: true });
  assert.deepEqual(state.calls.map(row => row.type), ['session','version','readback']);
  const create = state.calls.find(row => row.type === 'version');
  assert.equal(create.request.deploy, false); assert.equal(create.options.maxRetries, 0);
  assert.equal(create.request.assets.jwt, 'x'.repeat(24));
  assert.ok(create.request.bindings.some(row => row.name === 'ASSETS' && row.type === 'assets'));
  assert.ok(create.request.bindings.filter(row => row.name !== 'ASSETS').every(row => row.type === 'inherit' && row.version_id === OPS));
  assert.equal(originalCreate, state.calls);
});

test('two upload buckets require 200 then final 201 completion JWT and all reviewed asset hashes', async t => {
  const f = fixture(t), assetFiles = f.heldPlan.assetReconstitution.files;
  const uniqueHashes = [...new Set(assetFiles.map(row => {
    const bytes = f.rawAssets[row.path.slice(1)], extension = path.posix.extname(row.path).slice(1);
    return f.hashBlake3(Buffer.from(`${bytes.toString('base64')}${extension}`, 'utf8')).slice(0, 32);
  }))];
  const session = { buckets: [uniqueHashes.slice(0, 1), uniqueHashes.slice(1)], jwt: 'u'.repeat(24) };
  const state = harness(f, { session, bucketResponses: [{ status: 200 }, { status: 201, completionJwt: 'c'.repeat(24) }] });
  const result = await state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile });
  assert.deepEqual(result, { candidateVersionId: CANDIDATE, readbackVerified: false });
  assert.deepEqual(state.calls.map(row => row.type), ['session','bucket','bucket','version','readback']);
  const manifest = state.calls.find(row => row.type === 'session').request.manifest;
  assert.equal(manifest['/index.html'].hash, manifest[f.archivedIndex].hash);
  assert.equal(new Set(Object.values(manifest).map(row => row.hash)).size, 2);
  assert.deepEqual(state.calls.filter(row => row.type === 'bucket').map(row => row.request.maxRetries), [0, 0]);
  assert.equal(state.calls.find(row => row.type === 'version').request.assets.jwt, 'c'.repeat(24));
});

test('conflicting local files that collide to one provider hash are rejected before upload', async t => {
  const f = fixture(t), state = harness(f, { session: { buckets: [], jwt: 'u'.repeat(24) } });
  const collisionHasher = bytes => bytes.toString('utf8') === 'QQ==txt'
    ? '42f8fed80a10e56fb584724a8ea0e156e928a529e86ab234a8d5b79057256bab' : '1'.repeat(64);
  const adapter = createStagingBackendAssetCandidateUploader({ sdk: {
    async createAssetUploadSession() { assert.fail('conflicting collision must be rejected before session'); },
    async createVersion() { assert.fail('must not create a version'); },
  }, uploadBucket: async () => assert.fail('must not upload'),
  async readFreshControls() { return f.controlsFile; }, async readCandidateState() { return undefined; },
  journal: { async reserve() { return true; }, async complete() {} }, hashBlake3: collisionHasher, now: () => f.fixedNow });
  await assert.rejects(adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile }));
  assert.deepEqual(state.calls, []);
});

test('duplicate or unknown upload hashes fail closed before a bucket or version request', async t => {
  const f = fixture(t), first = f.heldPlan.assetReconstitution.files[0];
  const firstBytes = f.rawAssets[first.path.slice(1)], extension = path.posix.extname(first.path).slice(1);
  const knownHash = f.hashBlake3(Buffer.from(`${firstBytes.toString('base64')}${extension}`, 'utf8')).slice(0, 32);
  for (const buckets of [[['0'.repeat(32)]], [[knownHash, knownHash]], [[knownHash]]]) {
    const state = harness(f, { session: { buckets, jwt: 'u'.repeat(24) } });
    await assert.rejects(state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile }));
    assert.deepEqual(state.calls.map(row => row.type), ['session']);
  }
});

test('control drift before version creation prevents candidate creation', async t => {
  const f = fixture(t), state = harness(f, { session: { buckets: [], jwt: 'u'.repeat(24) }, mutateControlsAt: 1 });
  await assert.rejects(state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile }));
  assert.deepEqual(state.calls.map(row => row.type), ['session']);
});

test('an uncertain upload-session POST is journaled and never retried', async t => {
  const f = fixture(t), state = harness(f, { session: undefined });
  state.calls.length = 0;
  // Replace with a transport uncertainty after the one durable reservation.
  const sdk = { async createAssetUploadSession() { state.calls.push({ type: 'session' }); throw new Error('private raw SDK error'); }, async createVersion() { assert.fail('must not create a version'); } };
  let reserves = 0, completions = 0;
  const adapter = createStagingBackendAssetCandidateUploader({ sdk, uploadBucket: async () => assert.fail('no bucket'),
    async readFreshControls() { return f.controlsFile; }, async readCandidateState() { return undefined; },
    journal: { async reserve() { reserves++; return true; }, async complete(_key, value) { completions++; assert.equal(value.outcome, 'uncertain'); } },
    hashBlake3: f.hashBlake3, now: () => f.fixedNow });
  await assert.rejects(adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile }), /outcome is uncertain/);
  assert.equal(reserves, 1); assert.equal(completions, 1); assert.equal(state.calls.length, 1);
});

test('coverage path conflicts and expired observations are refused before SDK calls', async t => {
  const f = fixture(t), state = harness(f, { session: { buckets: [], jwt: 'u'.repeat(24) } });
  const conflict = clone(f.coverageBody);
  conflict.releases[0].servedAssetClosure[0].retainedPath = '/_ui/operations/' + 'd'.repeat(40) + '/index.html';
  const conflictFile = f.writeJson('conflict.json', conflict);
  await assert.rejects(state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: conflictFile }));
  assert.deepEqual(state.calls, []);
  const expired = clone(f.coverageBody); expired.observedAt = new Date(f.fixedNow - 31 * 60_000).toISOString();
  expired.window.to = expired.observedAt;
  const expiredFile = f.writeJson('expired.json', expired);
  await assert.rejects(state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: expiredFile }));
  assert.deepEqual(state.calls, []);
});

test('the v2/offline plan cannot be promoted into a candidate upload', async t => {
  const f = fixture(t), state = harness(f, { session: { buckets: [], jwt: 'u'.repeat(24) } });
  const v2 = clone(f.heldPlan); v2.schemaVersion = 2;
  await assert.rejects(state.adapter({ planOptions: f.planOptions, heldPlan: v2, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile }));
  assert.deepEqual(state.calls, []);
});
