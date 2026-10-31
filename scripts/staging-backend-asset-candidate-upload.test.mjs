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
  validateStagingBackendAssetMaterialization, validateStagingBackendAssetCandidateReadback,
  createCurrentStagingBackendAssetCandidateUploader, validateCurrentStagingBackendAssetCandidateReadback,
  validateCurrentStagingBackendAssetCoverageEvidence, validateCurrentStagingBackendAssetMaterialization }
  from './staging-backend-asset-candidate-upload.mjs';

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

function fixture(t, application = 'operations') {
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
  const app = application, baselineVersionId = app === 'operations' ? OPS : CLIENT;
  const mainName = app === 'operations' ? 'staging-native-authority-entrypoint.js' : 'index.js';
  const main = writeBytes(mainName, Buffer.from('export default { fetch(){ return new Response("candidate") } };'));
  const map = writeBytes(`${mainName}.map`, Buffer.from(JSON.stringify({ version: 3, file: mainName, sources: ['worker.ts'], sourcesContent: ['synthetic'], names: [], mappings: '' })));
  const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
  const artifact = { sourceCommit: SOURCE, main: pin(main), sourceMap: pin(map) };
  const filesRoot = path.join(root, 'assets'); fs.mkdirSync(filesRoot);
  const rawAssets = { 'index.html': Buffer.from('<html>retained</html>'), 'assets/app.js': Buffer.from('export const retained = true;') };
  const assetRows = Object.entries(rawAssets).map(([relative, bytes]) => {
    const abs = path.join(filesRoot, relative); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, bytes);
    return { path: `/${relative}`, size: bytes.length, sha256: hash(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const archivedIndex = `/_ui/${app}/${hash(rawAssets['index.html']).slice(0, 40)}/index.html`;
  const archivedRelative = archivedIndex.slice(1), archivedAbsolute = path.join(filesRoot, ...archivedRelative.split('/'));
  fs.mkdirSync(path.dirname(archivedAbsolute), { recursive: true }); fs.writeFileSync(archivedAbsolute, rawAssets['index.html']);
  rawAssets[archivedRelative] = rawAssets['index.html'];
  assetRows.push({ path: archivedIndex, size: rawAssets['index.html'].length, sha256: hash(rawAssets['index.html']) });
  assetRows.sort((a, b) => a.path.localeCompare(b.path));
  const ignore = Buffer.from('synthetic inventory marker\n'); fs.writeFileSync(path.join(filesRoot, '.assetsignore'), ignore);
  const assetsManifest = { schemaVersion: 1, purpose: 'staging-retained-assets-materialization-v1', environment: 'staging',
    accountId: STAGING_ACCOUNT_ID, workerName: workers[app].workerName, sourceVersionId: baselineVersionId,
    observedAt: capture.observedAt, scope: 'local-file-materialization-only', assetsConfig: clone(workers[app].modern.assets.config),
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
    versionId: baselineVersionId, percentage: 100, assetLineageEvidenceSHA256: lineage, closureEvidenceSHA256: closurePin,
    servedAssetClosure: assetRows }];
  const coverageBody = { schemaVersion: 1, purpose: 'staging-served-release-coverage-v1', environment: 'staging', accountId: STAGING_ACCOUNT_ID,
    application: app, workerName: workers[app].workerName, baselineVersionId,
    observedAt: new Date(fixedNow - 2_000).toISOString(), window: { from: new Date(fixedNow - 48 * 60 * 60_000 - 2_000).toISOString(), to: new Date(fixedNow - 2_000).toISOString() },
    sourceReceipts, releases };
  const coverageFile = writeJson('coverage.json', coverageBody);
  return { root, fixedNow, capture, controlsFile, planOptions, heldPlan, assetsFile, coverageFile, coverageBody, assetRows, rawAssets, archivedIndex, baselineVersionId,
    runtimeProofFile: { path: RUNTIME_PROOF, sha256: '0d4c66619a4393594008be2261c865a4b631ad0204de4d5f3e5b21d579b18d84' },
    hashBlake3: bytes => blake3(bytes).toString('hex'), writeJson };
}

function readbackFor(f, request, candidateVersionId = CANDIDATE) {
  const serviceBindings = request.bindings.filter(row => row.type === 'service').map(row =>
    row.name === 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES' && row.service === 'ledgetop-ops-staging'
      && row.entrypoint === 'OperationsNativePrincipalInquiryIngress' && !Object.hasOwn(row, 'environment')
      ? { ...row, environment: 'production' } : row);
  const resolvedBindings = [...f.heldPlan.expectedUnchangedResources.bindings
    .filter(row => row.name !== 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES'), ...serviceBindings]
    .sort((a, b) => a.name.localeCompare(b.name));
  return { latestVersionId: candidateVersionId, deployment: [{ versionId: f.baselineVersionId, percentage: 100 }], candidate: {
    id: candidateVersionId, mainModule: request.main_module,
    modules: request.modules.map(module => { const pin = module.name === f.heldPlan.artifact.main.path.split(/[\\/]/u).at(-1) ? f.heldPlan.artifact.main : f.heldPlan.artifact.sourceMap;
      return { name: module.name, bytes: pin.size, sha256: pin.sha256, content_type: module.content_type }; }),
    resolvedBindings, assetsConfig: request.assets.config, compatibilityDate: request.compatibility_date,
    compatibilityFlags: request.compatibility_flags, exports: request.exports,
  } };
}

function candidateParamsFor(f, jwt = 'synthetic-completion-token-0001') {
  const request = clone(f.heldPlan.versionCreateTemplate);
  request.bindings = [...request.bindings, { name: 'ASSETS', type: 'assets' }].sort((a, b) => a.name.localeCompare(b.name));
  request.assets = { config: clone(f.heldPlan.assetUploadRecipe.assetsConfig), jwt };
  request.deploy = false; request.bindings_inherit = 'strict';
  return request;
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
    }, async readCandidateState(worker, candidateVersionId) {
      const result = typeof readback === 'function' ? readback(createdRequest, candidateVersionId) : readback;
      calls.push({ type: 'readback', worker, candidateVersionId, result }); return result;
    },
    journal: { async reserve(key) { if (journal.has(key)) return false; journal.add(key); return true; }, async complete(key) { assert.ok(journal.has(key)); } },
    hashBlake3: f.hashBlake3, now: () => f.fixedNow });
  return { calls, adapter, journal };
}

test('Ops empty asset bucket uses session completion token and verifies the inactive candidate', async t => {
  const f = fixture(t), coverage = validateStagingBackendAssetCoverageEvidence({ coverageEvidenceFile: f.coverageFile,
    heldPlan: f.heldPlan, now: () => f.fixedNow });
  assert.equal(coverage.requiredAssetCount, f.assetRows.length);
  assert.equal(Object.hasOwn(coverage, 'requiredAssets'), false);
  assert.deepEqual(validateStagingBackendAssetMaterialization({ heldPlan: f.heldPlan, hashBlake3: f.hashBlake3 }),
    { application: 'operations', fileCount: 3, uniqueUploadCount: 2, duplicateContentPathCount: 1,
      totalBytes: f.assetRows.reduce((sum, row) => sum + row.size, 0) });
  const state = harness(f, { session: { buckets: [], jwt: 'x'.repeat(24) }, readback: request => readbackFor(f, request) });
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
  assert.ok(create.request.bindings.filter(row => row.name !== 'ASSETS').every(row => row.type === 'inherit' || row.type === 'service'));
  assert.equal(originalCreate, state.calls);
});

test('Client candidate retains its exact reviewed Ops service binding and resolves inherited rows', async t => {
  const f = fixture(t, 'client'), state = harness(f, { session: { buckets: [], jwt: 'x'.repeat(24) }, readback: request => readbackFor(f, request) });
  const result = await state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan,
    runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile });
  assert.deepEqual(result, { candidateVersionId: CANDIDATE, readbackVerified: true });
  const request = state.calls.find(row => row.type === 'version').request;
  assert.deepEqual(request.bindings.filter(row => row.type === 'service'), [{ name: 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES',
    type: 'service', service: 'ledgetop-ops-staging', entrypoint: 'OperationsNativePrincipalInquiryIngress' }]);
  assert.ok(request.bindings.filter(row => row.type === 'inherit').every(row => row.version_id === CLIENT));
  assert.equal(state.calls.find(row => row.type === 'readback').result.candidate.resolvedBindings
    .find(row => row.name === 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES').environment, 'production');
});

test('readback requires native ASSETS and the exact production-defaulted Client service', t => {
  const f = fixture(t, 'client'), candidateParams = candidateParamsFor(f);
  const valid = readbackFor(f, candidateParams);
  assert.equal(validateStagingBackendAssetCandidateReadback({ readback: valid, candidateVersionId: CANDIDATE,
    heldPlan: f.heldPlan, candidateParams }), true);
  for (const mutate of [
    row => { row.candidate.resolvedBindings = row.candidate.resolvedBindings.filter(binding => binding.name !== 'ASSETS'); },
    row => { row.candidate.resolvedBindings = row.candidate.resolvedBindings.map(binding => binding.name === 'ASSETS' ? { name: 'ASSETS', type: 'plain_text' } : binding); },
    row => { row.candidate.resolvedBindings = row.candidate.resolvedBindings.map(binding => binding.name === 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES' ? { ...binding, environment: 'staging' } : binding); },
  ]) {
    const changed = clone(valid); mutate(changed);
    assert.throws(() => validateStagingBackendAssetCandidateReadback({ readback: changed,
      candidateVersionId: CANDIDATE, heldPlan: f.heldPlan, candidateParams }));
  }
});

test('readback accepts only the exact zero-percent candidate smoke phase', t => {
  const f = fixture(t), candidateParams = candidateParamsFor(f), valid = readbackFor(f, candidateParams);
  const smoke = clone(valid);
  smoke.deployment = [
    { versionId: f.baselineVersionId, percentage: 100 },
    { versionId: CANDIDATE, percentage: 0 },
  ];
  assert.equal(validateStagingBackendAssetCandidateReadback({ readback: smoke, candidateVersionId: CANDIDATE,
    heldPlan: f.heldPlan, candidateParams }), true);

  for (const deployment of [
    [{ versionId: f.baselineVersionId, percentage: 100 }, { versionId: CANDIDATE, percentage: 1 }],
    [{ versionId: f.baselineVersionId, percentage: 100 }, { versionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', percentage: 0 }],
    [{ versionId: f.baselineVersionId, percentage: 100 }, { versionId: f.baselineVersionId, percentage: 0 }],
    [{ versionId: f.baselineVersionId, percentage: 100 }, { versionId: CANDIDATE, percentage: 0 },
      { versionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', percentage: 0 }],
    [{ versionId: f.baselineVersionId, percentage: 0 }, { versionId: CANDIDATE, percentage: 100 }],
  ]) {
    const changed = clone(smoke);
    changed.deployment = deployment;
    assert.throws(() => validateStagingBackendAssetCandidateReadback({ readback: changed,
      candidateVersionId: CANDIDATE, heldPlan: f.heldPlan, candidateParams }));
  }
});

test('runtime module readback permits an omitted diagnostic source map but never omits the main module', t => {
  const f = fixture(t), candidateParams = candidateParamsFor(f), complete = readbackFor(f, candidateParams);
  const withoutMap = clone(complete);
  withoutMap.candidate.modules = withoutMap.candidate.modules.filter(row => row.content_type !== 'application/source-map');
  assert.equal(validateStagingBackendAssetCandidateReadback({ readback: withoutMap, candidateVersionId: CANDIDATE,
    heldPlan: f.heldPlan, candidateParams }), true);
  const withoutMain = clone(complete);
  withoutMain.candidate.modules = withoutMain.candidate.modules.filter(row => row.name !== candidateParams.main_module);
  assert.throws(() => validateStagingBackendAssetCandidateReadback({ readback: withoutMain, candidateVersionId: CANDIDATE,
    heldPlan: f.heldPlan, candidateParams }));
});

test('runtime module readback rejects unknown modules and a wrong returned source map', t => {
  const f = fixture(t), candidateParams = candidateParamsFor(f), valid = readbackFor(f, candidateParams);
  const unknown = clone(valid);
  unknown.candidate.modules.push({ name: 'extra.js', bytes: 1, sha256: 'a'.repeat(64), content_type: 'application/javascript+module' });
  assert.throws(() => validateStagingBackendAssetCandidateReadback({ readback: unknown, candidateVersionId: CANDIDATE,
    heldPlan: f.heldPlan, candidateParams }));
  const wrongMap = clone(valid);
  wrongMap.candidate.modules.find(row => row.content_type === 'application/source-map').sha256 = 'b'.repeat(64);
  assert.throws(() => validateStagingBackendAssetCandidateReadback({ readback: wrongMap, candidateVersionId: CANDIDATE,
    heldPlan: f.heldPlan, candidateParams }));
});

test('module readback order is irrelevant only when names are unique and every row is valid', t => {
  const f = fixture(t), candidateParams = candidateParamsFor(f), valid = readbackFor(f, candidateParams);
  const reordered = clone(valid);
  reordered.candidate.modules.reverse();
  assert.equal(validateStagingBackendAssetCandidateReadback({ readback: reordered, candidateVersionId: CANDIDATE,
    heldPlan: f.heldPlan, candidateParams }), true);
  const duplicate = clone(valid);
  duplicate.candidate.modules.push(clone(duplicate.candidate.modules[0]));
  assert.throws(() => validateStagingBackendAssetCandidateReadback({ readback: duplicate, candidateVersionId: CANDIDATE,
    heldPlan: f.heldPlan, candidateParams }));
});

test('readback cannot pass by echoing inherit instructions as if they were resolved bindings', async t => {
  const f = fixture(t), state = harness(f, { session: { buckets: [], jwt: 'x'.repeat(24) },
    readback: request => ({ ...readbackFor(f, request), candidate: {
      ...readbackFor(f, request).candidate, resolvedBindings: request.bindings.filter(row => row.name !== 'ASSETS'),
    } }) });
  const result = await state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan,
    runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile });
  assert.deepEqual(result, { candidateVersionId: CANDIDATE, readbackVerified: false });
});

test('actual sanitized Ops capsule binding inventory validates a hash-only resolved readback', {
  skip: !process.env.LEDGETOP_STAGING_BACKEND_HELD_PLAN_FIXTURE,
}, () => {
  const heldPlan = JSON.parse(fs.readFileSync(process.env.LEDGETOP_STAGING_BACKEND_HELD_PLAN_FIXTURE, 'utf8'));
  assert.equal(heldPlan.application, 'operations');
  const baselineBindings = heldPlan.expectedUnchangedResources.bindings;
  assert.equal(baselineBindings.length, 152);
  assert.deepEqual([...new Set(baselineBindings.map(row => row.type))].sort(),
    ['assets','d1','durable_object_namespace','plain_text','queue','r2_bucket','secret_text','send_email','service','stream','workflow']);
  const candidateParams = clone(heldPlan.versionCreateTemplate);
  candidateParams.bindings = [...candidateParams.bindings, { name: 'ASSETS', type: 'assets' }].sort((a, b) => a.name.localeCompare(b.name));
  candidateParams.assets = { config: clone(heldPlan.assetUploadRecipe.assetsConfig), jwt: 'synthetic-completion-token-0001' };
  const resolvedBindings = baselineBindings.slice().sort((a, b) => a.name.localeCompare(b.name));
  const readback = { latestVersionId: CANDIDATE, deployment: [{ versionId: heldPlan.selectedActiveVersionId, percentage: 100 }], candidate: {
    id: CANDIDATE, mainModule: candidateParams.main_module,
    modules: candidateParams.modules.map((row, index) => {
      const pin = index === 0 ? heldPlan.artifact.main : heldPlan.artifact.sourceMap;
      return { name: row.name, bytes: pin.size, sha256: pin.sha256, content_type: row.content_type };
    }), resolvedBindings, assetsConfig: candidateParams.assets.config,
    compatibilityDate: candidateParams.compatibility_date, compatibilityFlags: candidateParams.compatibility_flags,
    exports: candidateParams.exports,
  } };
  assert.equal(validateStagingBackendAssetCandidateReadback({ readback, candidateVersionId: CANDIDATE, heldPlan, candidateParams }), true);
  const echoedRequest = structuredClone(readback);
  echoedRequest.candidate.resolvedBindings = candidateParams.bindings.filter(row => row.name !== 'ASSETS');
  assert.throws(() => validateStagingBackendAssetCandidateReadback({ readback: echoedRequest,
    candidateVersionId: CANDIDATE, heldPlan, candidateParams }));
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

test('a bucket may upload only the missing cached hashes and must use its final completion JWT', async t => {
  const f = fixture(t), assetFiles = f.heldPlan.assetReconstitution.files;
  const uniqueHashes = [...new Set(assetFiles.map(row => {
    const bytes = f.rawAssets[row.path.slice(1)], extension = path.posix.extname(row.path).slice(1);
    return f.hashBlake3(Buffer.from(`${bytes.toString('base64')}${extension}`, 'utf8')).slice(0, 32);
  }))];
  const state = harness(f, { session: { buckets: [[uniqueHashes[0]]], jwt: 'initial-session-token-0001' },
    bucketResponses: [{ status: 201, completionJwt: 'final-completion-token-0001' }], readback: request => readbackFor(f, request) });
  const result = await state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan, runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile });
  assert.deepEqual(result, { candidateVersionId: CANDIDATE, readbackVerified: true });
  assert.equal(state.calls.filter(row => row.type === 'bucket').length, 1);
  assert.equal(state.calls.find(row => row.type === 'bucket').request.files.length, 1);
  assert.equal(state.calls.find(row => row.type === 'version').request.assets.jwt, 'final-completion-token-0001');
});

test('v3 intermediate bucket contract still rejects a 202 response before version creation', async t => {
  const f = fixture(t), hashes = [...new Set(f.heldPlan.assetReconstitution.files.map(row => {
    const bytes = f.rawAssets[row.path.slice(1)], extension = path.posix.extname(row.path).slice(1);
    return f.hashBlake3(Buffer.from(`${bytes.toString('base64')}${extension}`, 'utf8')).slice(0, 32);
  }))];
  assert.ok(hashes.length >= 2);
  const state = harness(f, { session: { buckets: [[hashes[0]], [hashes[1]]], jwt: 'initial-session-token-0001' },
    bucketResponses: [{ status: 202 }, { status: 201, completionJwt: 'final-completion-token-0001' }] });
  await assert.rejects(state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan,
    runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile }), /bucket response/);
  assert.deepEqual(state.calls.map(row => row.type), ['session', 'bucket']);
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
  for (const buckets of [[['0'.repeat(32)]], [[knownHash, knownHash]]]) {
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

test('legacy consumed journal keys remain consumed after adding the v4 contract', async t => {
  const f = fixture(t), state = harness(f, { session: { buckets: [], jwt: 'u'.repeat(24) } });
  state.journal.add(`${f.heldPlan.application}/${f.heldPlan.selectedWorker}/${f.heldPlan.selectedActiveVersionId}/${SOURCE}/asset-upload-session`);
  await assert.rejects(state.adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan,
    runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile }), /refusing replay/);
  assert.deepEqual(state.calls, []);
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

const currentPlanRoot = process.env.LEDGETOP_STAGING_CURRENT_PROFILE_PLAN_ROOT;
test('v4 readback preserves the exact current Client binding inventory and old v3 API refuses it', t => {
  if (!currentPlanRoot) return t.skip('current-profile held plans are not configured');
  const planOptions = JSON.parse(fs.readFileSync(path.join(currentPlanRoot, 'client', 'plan-options.private.json'), 'utf8'));
  const heldPlan = JSON.parse(fs.readFileSync(path.join(currentPlanRoot, 'client', 'successor.held.json'), 'utf8'));
  assert.equal(heldPlan.schemaVersion, 4);
  assert.equal(heldPlan.sourceCommit, 'b22abeccd1889ed2f745db98c6123bafa5820b97');
  assert.equal(heldPlan.expectedUnchangedResources.bindings.length, 125);
  assert.equal(heldPlan.versionCreateTemplate.bindings.length, 124);
  assert.ok(heldPlan.versionCreateTemplate.bindings.some(row => row.name === 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES'
    && row.type === 'inherit' && row.version_id === heldPlan.selectedActiveVersionId));
  const candidateParams = clone(heldPlan.versionCreateTemplate);
  candidateParams.bindings = [...candidateParams.bindings, { name: 'ASSETS', type: 'assets' }].sort((a, b) => a.name.localeCompare(b.name));
  candidateParams.assets = { config: clone(heldPlan.assetUploadRecipe.assetsConfig), jwt: 'synthetic-in-memory-token' };
  candidateParams.deploy = false; candidateParams.bindings_inherit = 'strict';
  const resolvedBindings = clone(heldPlan.expectedUnchangedResources.bindings)
    .sort((a, b) => a.name.localeCompare(b.name));
  const readback = { latestVersionId: CANDIDATE, deployment: [{ versionId: heldPlan.selectedActiveVersionId, percentage: 100 }], candidate: {
    id: CANDIDATE, mainModule: candidateParams.main_module,
    modules: candidateParams.modules.map((module, index) => ({ name: module.name,
      bytes: index === 0 ? heldPlan.artifact.main.size : heldPlan.artifact.sourceMap.size,
      sha256: index === 0 ? heldPlan.artifact.main.sha256 : heldPlan.artifact.sourceMap.sha256,
      content_type: module.content_type })), resolvedBindings,
    assetsConfig: candidateParams.assets.config, compatibilityDate: candidateParams.compatibility_date,
    compatibilityFlags: candidateParams.compatibility_flags, exports: candidateParams.exports,
  } };
  assert.equal(validateCurrentStagingBackendAssetCandidateReadback({ readback, candidateVersionId: CANDIDATE, heldPlan, candidateParams }), true);
  const missingExisting = clone(readback);
  missingExisting.candidate.resolvedBindings = missingExisting.candidate.resolvedBindings
    .filter(row => row.name !== 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES');
  assert.throws(() => validateCurrentStagingBackendAssetCandidateReadback({ readback: missingExisting,
    candidateVersionId: CANDIDATE, heldPlan, candidateParams }));
  assert.throws(() => validateStagingBackendAssetCandidateReadback({ readback, candidateVersionId: CANDIDATE, heldPlan, candidateParams }));
  const coverageFile = { path: path.join(currentPlanRoot, 'client', 'successor.coverage.json'),
    sha256: hash(fs.readFileSync(path.join(currentPlanRoot, 'client', 'successor.coverage.json'))) };
  const coverageObservedAt = Date.parse(JSON.parse(fs.readFileSync(coverageFile.path, 'utf8')).observedAt);
  const coverage = validateCurrentStagingBackendAssetCoverageEvidence({ coverageEvidenceFile: coverageFile,
    heldPlan, now: () => coverageObservedAt + 1_000 });
  assert.ok(coverage.requiredAssetCount > 0);
  const wrongSource = clone(heldPlan); wrongSource.sourceCommit = SOURCE;
  assert.throws(() => validateCurrentStagingBackendAssetMaterialization({ heldPlan: wrongSource,
    hashBlake3: () => assert.fail('wrong source must stop before reading assets') }));
  assert.equal(typeof createCurrentStagingBackendAssetCandidateUploader, 'function');
});

test('current v4 two-bucket upload accepts 202 only between buckets and requires final 201 JWT', {
  skip: !currentPlanRoot && 'current-profile held plans are not configured',
}, async t => {
  const planRoot = path.resolve(currentPlanRoot);
  const planOptions = JSON.parse(fs.readFileSync(path.join(planRoot, 'client', 'plan-options.private.json'), 'utf8'));
  const heldPlan = JSON.parse(fs.readFileSync(path.join(planRoot, 'client', 'successor.held.json'), 'utf8'));
  const coverageEvidenceFile = { path: path.join(planRoot, 'client', 'successor.coverage.json'),
    sha256: hash(fs.readFileSync(path.join(planRoot, 'client', 'successor.coverage.json'))) };
  const coverageTime = Date.parse(JSON.parse(fs.readFileSync(coverageEvidenceFile.path, 'utf8')).observedAt);
  const now = () => Math.max(Date.parse(heldPlan.controlsCapture.observedAt), coverageTime) + 2_000;
  async function run(statuses, omitFinalJwt = false) {
    const calls = [], used = new Set(); let bucketIndex = 0, requestForReadback, validationError, validationDiagnostics;
    const adapter = createCurrentStagingBackendAssetCandidateUploader({
      sdk: {
        async createAssetUploadSession(worker, request, options) {
          calls.push({ type: 'session', worker, options });
          const hashes = [...new Set(Object.values(request.manifest).map(row => row.hash))];
          assert.ok(hashes.length >= 2);
          return { buckets: [[hashes[0]], [hashes[1]]], jwt: 'initial-memory-only-jwt-0001' };
        },
        async createVersion(worker, request, options) {
          calls.push({ type: 'version', worker, options, jwt: request.assets.jwt });
          requestForReadback = clone(request);
          return { id: CANDIDATE };
        },
      },
      async uploadBucket(request) {
        calls.push({ type: 'bucket', index: bucketIndex, retryCount: request.maxRetries });
        used.add(request.uploadJwt);
        const status = statuses[bucketIndex++];
        return { status, ...(status === 201 && !omitFinalJwt ? { completionJwt: 'final-memory-only-jwt-0002' } : {}) };
      },
      async readFreshControls() { return planOptions.controlsFile; },
      async readCandidateState() {
        calls.push({ type: 'readback' });
        const value = { latestVersionId: CANDIDATE,
          deployment: [{ versionId: heldPlan.selectedActiveVersionId, percentage: 100 }], candidate: {
            id: CANDIDATE, mainModule: requestForReadback.main_module,
            modules: requestForReadback.modules.map((module, index) => ({ name: module.name,
              bytes: index === 0 ? heldPlan.artifact.main.size : heldPlan.artifact.sourceMap.size,
              sha256: index === 0 ? heldPlan.artifact.main.sha256 : heldPlan.artifact.sourceMap.sha256,
              content_type: module.content_type })),
            resolvedBindings: clone(heldPlan.expectedUnchangedResources.bindings).sort((a, b) => a.name.localeCompare(b.name)),
            assetsConfig: requestForReadback.assets.config, compatibilityDate: requestForReadback.compatibility_date,
            compatibilityFlags: requestForReadback.compatibility_flags, exports: requestForReadback.exports,
          } };
        validationDiagnostics = {
          bindings: canonical(value.candidate.resolvedBindings) === canonical(heldPlan.expectedUnchangedResources.bindings.slice().sort((a,b)=>a.name.localeCompare(b.name))),
          inheritCounts: [value.candidate.resolvedBindings.filter(row=>row.type==='inherit').length,
            heldPlan.expectedUnchangedResources.bindings.filter(row=>row.type==='inherit').length],
          nameCounts: [value.candidate.resolvedBindings.length, new Set(value.candidate.resolvedBindings.map(row=>row.name)).size],
          asset: canonical(value.candidate.assetsConfig) === canonical(requestForReadback.assets.config),
          date: value.candidate.compatibilityDate === requestForReadback.compatibility_date,
          flags: canonical(value.candidate.compatibilityFlags) === canonical(requestForReadback.compatibility_flags),
          exports: canonical(value.candidate.exports) === canonical(requestForReadback.exports),
        };
        try { validateCurrentStagingBackendAssetCandidateReadback({ readback: value, candidateVersionId: CANDIDATE,
          heldPlan, candidateParams: requestForReadback }); } catch (error) { validationError = error; }
        return value;
      },
      journal: { async reserve(key) { if (used.has(key)) return false; used.add(key); return true; }, async complete() {} },
      hashBlake3: bytes => blake3(bytes).toString('hex'), now,
    });
    try {
      const result = await adapter({ planOptions, heldPlan, runtimeProofFile: { path: RUNTIME_PROOF,
        sha256: '0d4c66619a4393594008be2261c865a4b631ad0204de4d5f3e5b21d579b18d84' }, coverageEvidenceFile });
      return { result, calls, validationError, validationDiagnostics };
    } catch (error) { return { error, calls, validationError, validationDiagnostics }; }
  }
  const accepted = await run([202, 201]);
  assert.deepEqual(accepted.result, { candidateVersionId: CANDIDATE, readbackVerified: true },
    `${String(accepted.validationError)} ${JSON.stringify(accepted.validationDiagnostics)}`);
  assert.deepEqual(accepted.calls.filter(row => row.type === 'bucket').map(row => row.index), [0, 1]);
  assert.equal(accepted.calls.filter(row => row.type === 'version').length, 1);
  assert.equal(accepted.calls.find(row => row.type === 'version').jwt, 'final-memory-only-jwt-0002');
  const final202 = await run([202, 202]);
  assert.match(String(final202.error), /bucket response/);
  assert.equal(final202.calls.filter(row => row.type === 'version').length, 0);
  const missingCompletionJwt = await run([202, 201], true);
  assert.match(String(missingCompletionJwt.error), /bucket response/);
  assert.equal(missingCompletionJwt.calls.filter(row => row.type === 'version').length, 0);
});

test('the v4 uploader rejects a v3 plan before any mocked mutation', async t => {
  const f = fixture(t), calls = [];
  const adapter = createCurrentStagingBackendAssetCandidateUploader({ sdk: {
    async createAssetUploadSession() { calls.push('session'); assert.fail('wrong-schema plan must stop before SDK'); },
    async createVersion() { calls.push('version'); assert.fail('wrong-schema plan must stop before SDK'); },
  }, uploadBucket: async () => { calls.push('bucket'); assert.fail('wrong-schema plan must stop before upload'); },
  async readFreshControls() { calls.push('controls'); return f.controlsFile; },
  async readCandidateState() { calls.push('readback'); return undefined; },
  journal: { async reserve() { calls.push('journal'); return true; }, async complete() {} },
  hashBlake3: f.hashBlake3, now: () => f.fixedNow });
  await assert.rejects(adapter({ planOptions: f.planOptions, heldPlan: f.heldPlan,
    runtimeProofFile: f.runtimeProofFile, coverageEvidenceFile: f.coverageFile }));
  assert.deepEqual(calls, []);
});

test('actual current Client assets traverse the v4 mock uploader without adding services or weakening the v3 entry point', async t => {
  if (!currentPlanRoot) return t.skip('current-profile held plans are not configured');
  const f = fixture(t), planOptions = JSON.parse(fs.readFileSync(path.join(currentPlanRoot, 'client', 'plan-options.private.json')));
  const heldPlan = JSON.parse(fs.readFileSync(path.join(currentPlanRoot, 'client', 'successor.held.json')));
  const coveragePath = path.join(currentPlanRoot, 'client', 'successor.coverage.json');
  const coverageEvidenceFile = { path: coveragePath, sha256: hash(fs.readFileSync(coveragePath)) };
  const observed = Date.parse(JSON.parse(fs.readFileSync(coveragePath)).observedAt);
  const mutations = [], reservations = new Set(); let request;
  const options = {
    sdk: {
      async createAssetUploadSession(worker, body, policy) {
        mutations.push('session'); assert.equal(worker, heldPlan.selectedWorker);
        assert.equal(policy.maxRetries, 0); assert.equal(Object.keys(body.manifest).length, 217);
        return { buckets: [], jwt: 'synthetic-completion-token-0001' };
      },
      async createVersion(worker, body, policy) {
        mutations.push('version'); assert.equal(worker, heldPlan.selectedWorker); assert.equal(policy.maxRetries, 0);
        assert.equal(body.deploy, false); assert.equal(body.bindings_inherit, 'strict');
        assert.equal(body.bindings.filter(row => row.type === 'service').length, 0);
        assert.equal(body.bindings.length, 125); request = body; return { id: CANDIDATE };
      },
    },
    uploadBucket: async () => assert.fail('cache-hit mock has no upload bucket'),
    async readFreshControls() { return planOptions.controlsFile; },
    async readCandidateState() {
      return { latestVersionId: CANDIDATE, deployment: [{ versionId: heldPlan.selectedActiveVersionId, percentage: 100 }],
        candidate: { id: CANDIDATE, mainModule: request.main_module,
          modules: [{ name: request.main_module, bytes: heldPlan.artifact.main.size, sha256: heldPlan.artifact.main.sha256,
            content_type: 'application/javascript+module' }],
          resolvedBindings: clone(heldPlan.expectedUnchangedResources.bindings).sort((a, b) => a.name.localeCompare(b.name)),
          assetsConfig: request.assets.config, compatibilityDate: request.compatibility_date,
          compatibilityFlags: request.compatibility_flags, exports: request.exports } };
    },
    journal: { async reserve(key) { assert.match(key, /^v4\//); if (reservations.has(key)) return false; reservations.add(key); return true; },
      async complete(key) { assert.ok(reservations.has(key)); } },
    hashBlake3: f.hashBlake3, now: () => observed + 1_000,
  };
  // The legacy export must not accept a caller-supplied strategy switch.
  const legacy = createStagingBackendAssetCandidateUploader({ ...options, currentProfile: true });
  await assert.rejects(legacy({ planOptions, heldPlan, coverageEvidenceFile, runtimeProofFile: f.runtimeProofFile }), /held v3/);
  assert.deepEqual(mutations, []);
  const upload = createCurrentStagingBackendAssetCandidateUploader(options);
  assert.deepEqual(await upload({ planOptions, heldPlan, coverageEvidenceFile, runtimeProofFile: f.runtimeProofFile }),
    { candidateVersionId: CANDIDATE, readbackVerified: true });
  assert.deepEqual(mutations, ['session', 'version']);
  await assert.rejects(upload({ planOptions, heldPlan, coverageEvidenceFile, runtimeProofFile: f.runtimeProofFile }), /refusing replay/);
  assert.deepEqual(mutations, ['session', 'version']);
});
