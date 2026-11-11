import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical, hash } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID } from './staging-requirements.mjs';
import { compileCurrentStagingBackendReleasePlan, compileStagingBackendReleasePlan,
  compileOwnerReviewStagingBackendReleasePlan, validateCurrentStagingBackendReleasePlan,
  validateOwnerReviewStagingBackendControlsSnapshot, validateOwnerReviewStagingBackendReleasePlan,
  validateStagingBackendReleasePlan } from './staging-backend-release-plan.mjs';

const OPS = '1ffe4525-7e29-4ea2-a407-726abf7f10c6';
const CLIENT = '3ba4c8c9-70b4-4696-810f-0503f512e728';
const CLIENT_LATEST = '4f124119-c34b-4608-ba90-ad438c47a90b';
const SYNC = '470134b4-ef95-4702-98f3-110e4f4cbbb0';
const CANDIDATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'c2ce0b6feaa3f410dd6284bd5ce5763818958ec8';
const CURRENT_OPS = '1d79a7ad-d077-49ec-bb3c-7e73d8799773';
const CURRENT_CLIENT = 'b1f9053b-e1b9-4435-8bc0-49d03b393fab';
const CURRENT_SOURCE = 'b22abeccd1889ed2f745db98c6123bafa5820b97';
const PREVIOUS_SOURCE = '9bf5def4f14226f257ffc1ca4d89a659b51aac1a';
const DB = { ops: '78b34173-b168-4e3d-9832-bb9d245cc6b8', delivery: 'b6f653ab-9acd-4421-9ad0-207754b59aeb' };
const disabled = Object.freeze({ CLIENT_PORTAL_REQUEST_V2_ENABLED: null, CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: 'false',
  CLIENT_PORTAL_OPS_INQUIRIES_ENABLED: null, CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED: 'false',
  CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED: null, OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: null,
  NATIVE_STAFF_MASTER_ENABLED: null, NATIVE_STAFF_MANAGEMENT_ENABLED: 'false' });
const clone = value => structuredClone(value);

function bindings(app) {
  const result = [
    { name: 'ASSETS', type: 'assets' },
    { name: 'DELIVERY_DB', type: 'd1', id: DB.delivery, database_id: DB.delivery, database_name: 'client-data-staging' },
    { name: 'DATA_BUCKET', type: 'r2_bucket', bucket_name: 'client-data-staging' },
    { name: 'SESSION_SECRET', type: 'secret_text' },
    { name: 'PLAIN_FLAG', type: 'plain_text', textSHA256: hash('false') },
  ];
  if (app === 'operations') result.push({ name: 'OPS_DB', type: 'd1', id: DB.ops, database_id: DB.ops, database_name: 'ltds-ops-staging' });
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function controlWorker(app, versionId, latestVersionId = versionId) {
  const workerName = app === 'operations' ? 'ledgetop-ops-staging' : app === 'client' ? 'ledgetop-clients-staging' : 'ledgetop-ops-sync-staging';
  const runtime = { exports: app === 'operations' ? { InquiryIngress: { type: 'durable_object_namespace', class_name: 'OperationsNativePrincipalInquiryIngress' } } : {},
    assets: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application',
    static_routing: { user_worker: ['/api/*'] }, serve_directly: true, raw_run_worker_first: ['/api/*'], base_path: '/' },
    compatibility_date: '2026-07-22', compatibility_flags: ['nodejs_compat'], usage_model: 'standard', cache_options: { enabled: true } };
  if (app === 'operations') runtime.containers = [{ class_name: 'ThumbnailRendererContainer' }];
  if (app === 'client') runtime.limits = { cpu_ms: 300000, subrequests: 25000 };
  if (app === 'sync') delete runtime.assets;
  const rows = app === 'sync' ? [
    { name: 'OPS_DB', type: 'd1', id: DB.ops, database_id: DB.ops, database_name: 'ltds-ops-staging' },
    { name: 'DELIVERY_DB', type: 'd1', id: DB.delivery, database_id: DB.delivery, database_name: 'client-data-staging' },
  ] : bindings(app);
  const settings = { placement: {}, compatibility_date: runtime.compatibility_date, compatibility_flags: runtime.compatibility_flags,
    usage_model: 'standard', tags: [], tail_consumers: [], logpush: false, observability: { enabled: true }, annotations: {
      'workers/message': `synthetic ${app}`, 'workers/tag': 'staging', 'workers/triggered_by': 'api' }, bindings: clone(rows) };
  if (app === 'client') { settings.limits = clone(runtime.limits); }
  const assetsConfig = { base_path: '/', html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] };
  return { workerName, activeVersionId: versionId, latestVersionId,
    deployment: { versions: [{ version_id: versionId, percentage: 100 }] },
    version: { id: versionId, number: 1, metadata: {}, annotations: {}, resources: {
      script: { handlers: ['fetch'], named_handlers: [], last_deployed_from: 'wrangler' }, script_runtime: runtime, bindings: clone(rows) } },
    settings, modern: { id: versionId, number: 1, compatibility_date: runtime.compatibility_date,
      compatibility_flags: clone(runtime.compatibility_flags), usage_model: runtime.usage_model,
    exports: clone(runtime.exports), ...(runtime.cache_options ? { cache_options: clone(runtime.cache_options) } : {}),
      ...(runtime.containers ? { containers: clone(runtime.containers) } : {}), ...(runtime.limits ? { limits: clone(runtime.limits) } : {}),
      ...(app === 'sync' ? {} : { assets: { config: assetsConfig } }), modules: [{ name: 'index.js',
        contentType: 'application/javascript+module', bytes: 8192, sha256: hash(`${app}-baseline`)}],
      bindings: clone(rows), env: Object.fromEntries(rows.map(row => [row.name, clone(row)])) },
    schedules: { schedules: app === 'operations' ? [{ cron: '*/15 * * * *' }, { cron: '*/5 * * * *' }] : app === 'client' ? [{ cron: '15 * * * *' }] : [] },
    selectedFlags: app === 'sync' ? {} : { ...disabled }, rawBindingsSHA256: hash(canonical(rows)), rawControlSHA256: hash(`${app}-control`) };
}

function controls({ opsVersion = OPS, opsLatest = opsVersion, clientVersion = CLIENT, clientLatest = CLIENT_LATEST } = {}) {
  const operations = controlWorker('operations', opsVersion, opsLatest);
  if (opsVersion !== OPS) {
    operations.modern.main_module = 'staging-native-authority-entrypoint.js';
    operations.modern.modules[0].name = 'staging-native-authority-entrypoint.js';
  }
  return { schemaVersion: 1, purpose: 'staging-v4-current-controls-and-full-schema-readonly-v1', environment: 'staging',
    accountId: STAGING_ACCOUNT_ID, observedAt: new Date(Date.now() - 60_000).toISOString(),
    workers: { operations, client: controlWorker('client', clientVersion, clientLatest), sync: controlWorker('sync', SYNC) },
    schema: { OPS_DB: { id: DB.ops }, DELIVERY_DB: { id: DB.delivery } }, secretValuesPersisted: false,
    applicationRowsRead: 0, resourceWrites: 0 };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-backend-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function writeJson(name, value) {
    const file = path.join(root, name), bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(file, bytes); return { path: file, sha256: hash(bytes) };
  }
  function artifact(application = 'client', commit = SOURCE) {
    const name = application === 'operations' ? 'staging-native-authority-entrypoint.js' : 'index.js';
    const main = path.join(root, name), map = `${main}.map`;
    fs.writeFileSync(main, 'export default { fetch(){ return new Response("staging") } };');
    fs.writeFileSync(map, JSON.stringify({ version: 3, file: name, sources: ['worker.ts'], sourcesContent: ['source'], names: [], mappings: '' }));
    const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
    return { sourceCommit: commit, main: pin(main), sourceMap: pin(map) };
  }
  function retainedAssets(capture, application = 'operations', files = {
    'index.html': Buffer.from('<html>retained</html>'), 'assets/app.js': Buffer.from('export const retained = true;'),
  }) {
    const filesRoot = path.join(root, `assets-${application}`);
    fs.mkdirSync(filesRoot, { recursive: true });
    const rows = [];
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(filesRoot, ...relative.split('/'));
      fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content);
      const bytes = fs.readFileSync(absolute);
      rows.push({ path: `/${relative}`, size: bytes.length, sha256: hash(bytes) });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    const localOnlyPath = path.join(filesRoot, '.assetsignore');
    fs.writeFileSync(localOnlyPath, 'synthetic materialization metadata\n');
    const localOnlyBytes = fs.readFileSync(localOnlyPath);
    const worker = capture.workers[application];
    const manifest = { schemaVersion: 1, purpose: 'staging-retained-assets-materialization-v1', environment: 'staging',
      accountId: STAGING_ACCOUNT_ID, workerName: worker.workerName, sourceVersionId: worker.activeVersionId,
      observedAt: capture.observedAt, scope: 'local-file-materialization-only',
      assetsConfig: clone(worker.modern.assets.config), files: rows,
      excludedFiles: [{ path: '/.assetsignore', size: localOnlyBytes.length, sha256: hash(localOnlyBytes) }] };
    const manifestFile = writeJson(`assets-${application}-${Math.random()}.json`, manifest);
    return { manifestFile, filesRoot };
  }
  return { root, writeJson, artifact, retainedAssets };
}

test('Ops creates a held version-create template pinned to non-asset active bindings', t => {
  const f = fixture(t), capture = controls(), options = { controlsFile: f.writeJson('controls.json', capture),
    application: 'operations', artifact: f.artifact('operations'), sourceCommit: SOURCE,
    retainedAssets: f.retainedAssets(capture, 'operations') };
  const plan = compileStagingBackendReleasePlan(options), params = plan.versionCreateTemplate;
  assert.equal(plan.schemaVersion, 3); assert.equal(plan.contract, 'staging-backend-only-v3');
  assert.equal(plan.selectedWorker, 'ledgetop-ops-staging'); assert.equal(plan.selectedActiveVersionId, OPS);
  assert.equal(plan.selectedLatestVersionId, OPS); assert.equal(plan.accountId, STAGING_ACCOUNT_ID);
  assert.equal(params.account_id, STAGING_ACCOUNT_ID); assert.equal(params.deploy, false);
  assert.equal(params.main_module, 'staging-native-authority-entrypoint.js');
  assert.equal(params.modules[0].name, params.main_module); assert.equal(params.modules[1].name, `${params.main_module}.map`);
  assert.equal(params.modules[0].content_type, 'application/javascript+module');
  assert.equal(params.modules[1].content_type, 'application/source-map');
  assert.deepEqual(Buffer.from(params.modules[0].content_base64, 'base64'), fs.readFileSync(options.artifact.main.path));
  assert.deepEqual(Buffer.from(params.modules[1].content_base64, 'base64'), fs.readFileSync(options.artifact.sourceMap.path));
  assert.equal(Object.hasOwn(params, 'assets'), false); assert.equal(Object.hasOwn(params, 'migrations'), false);
  assert.equal(Object.hasOwn(params, 'keep_assets'), false);
  assert.equal(plan.assetsUploadRequired, true); assert.equal(plan.assetJwtIncluded, false);
  assert.equal(plan.assetReconstitution.sourceVersionId, OPS); assert.equal(plan.assetReconstitution.namespaceInherited, false);
  assert.equal(plan.assetReconstitution.localFileInventoryMatched, true);
  assert.equal(plan.assetReconstitution.remoteNamespaceCompleteness, 'unproven');
  assert.equal(plan.assetReconstitution.retainedReleaseCoverage, 'unqualified');
  assert.equal(plan.assetReconstitution.requiredRetainedCoverageHours, 48);
  assert.equal(plan.assetReconstitution.reconstitutionPermitted, false);
  assert.deepEqual(plan.assetReconstitution.localOnlyFiles.map(row => row.path), ['/.assetsignore']);
  assert.equal(plan.assetUploadRecipe.uploadAssetSetAllowed, false);
  assert.ok(plan.holdReasons.includes('retained-asset-48-hour-release-coverage-not-qualified'));
  assert.equal(plan.assetReconstitution.totalFiles, 2); assert.equal(plan.assetReconstitution.totalBytes,
    Buffer.byteLength('<html>retained</html>') + Buffer.byteLength('export const retained = true;'));
  assert.deepEqual(plan.assetUploadRecipe.assetsConfig, capture.workers.operations.modern.assets.config);
  assert.equal(plan.assetUploadRecipe.completionJwtMemoryOnly, true); assert.equal(plan.assetUploadRecipe.completionJwtPersisted, false);
  assert.equal(params.usage_model, capture.workers.operations.modern.usage_model);
  assert.deepEqual(params.containers, capture.workers.operations.modern.containers);
  assert.deepEqual(params.exports, { ...capture.workers.operations.modern.exports,
    OperationsPortalNativeDeliveryAuthorizationReader: { type: 'worker' },
    ClientPortalNativeFinancialReader: { type: 'worker' },
    OperationsNativePrincipalInquiryIngress: { type: 'worker' } });
  assert.deepEqual(params.cache_options, capture.workers.operations.modern.cache_options);
  assert.deepEqual(params.bindings, capture.workers.operations.version.resources.bindings
    .filter(binding => binding.name !== 'ASSETS')
    .map(({ name }) => ({ name, type: 'inherit', version_id: OPS })).sort((a, b) => a.name.localeCompare(b.name)));
  assert.deepEqual(plan.workerControlPreservation, { settingsSHA256: hash(canonical(capture.workers.operations.settings)),
    schedulesSHA256: hash(canonical(capture.workers.operations.schedules.schedules)) });
  assert.equal(plan.executionAllowed, false); assert.equal(plan.held, true); assert.equal(plan.assetReconstitution.runtimeProofRequired, true);
  assert.equal(plan.noMigrationConfig, true); assert.equal(plan.noOpsSyncUpdate, true);
  assert.equal(JSON.stringify(plan).includes('synthetic-secret'), false);
  assert.equal(validateStagingBackendReleasePlan(options, plan), plan);
});

test('Client explicitly inherits active non-asset 3ba bindings, preserves inactive 4f, and adds only the reviewed Ops service', t => {
  const f = fixture(t), capture = controls(), options = { controlsFile: f.writeJson('controls.json', capture),
    application: 'client', artifact: f.artifact('client'), sourceCommit: SOURCE,
    retainedAssets: f.retainedAssets(capture, 'client') };
  const plan = compileStagingBackendReleasePlan(options), params = plan.versionCreateTemplate;
  assert.equal(plan.selectedActiveVersionId, CLIENT); assert.equal(plan.selectedLatestVersionId, CLIENT_LATEST);
  assert.deepEqual(plan.inactiveLatestCandidate, { versionId: CLIENT_LATEST, active: false, deployed: false, adoptedForAssets: false });
  assert.equal(plan.observations.sync.activeVersionId, SYNC); assert.equal(plan.observations.operations.activeVersionId, OPS);
  assert.equal(plan.assetReconstitution.sourceVersionId, CLIENT); assert.equal(plan.assetReconstitution.namespaceInherited, false);
  assert.equal(Object.hasOwn(params, 'keep_assets'), false);
  const inherited = params.bindings.filter(row => row.type === 'inherit');
  assert.equal(inherited.length, capture.workers.client.version.resources.bindings.length - 1);
  assert.ok(inherited.every(row => row.version_id === CLIENT));
  assert.equal(inherited.some(row => row.name === 'ASSETS'), false);
  const rpc = params.bindings.filter(row => row.name === 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES');
  assert.deepEqual(rpc, [{ name: 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES', service: 'ledgetop-ops-staging',
    entrypoint: 'OperationsNativePrincipalInquiryIngress', type: 'service' }]);
  assert.equal(Object.hasOwn(params, 'assets'), false); assert.equal(Object.hasOwn(params, 'migrations'), false);
  assert.equal(plan.executionAllowed, false); assert.equal(plan.liveNamespaceVerified, false);
  assert.equal(plan.expectedUnchangedSettings.bindings.length, capture.workers.client.settings.bindings.length);
  assert.equal(validateStagingBackendReleasePlan(options, plan), plan);
});

test('default placement is omitted from the request while usage model and other modern metadata are retained', t => {
  const f = fixture(t), capture = controls();
  capture.workers.operations.settings.placement = {};
  capture.workers.operations.settings.usage_model = 'bundled';
  capture.workers.operations.modern.usage_model = 'bundled';
  capture.workers.operations.version.resources.script_runtime.usage_model = 'bundled';
  const plan = compileStagingBackendReleasePlan({ controlsFile: f.writeJson('default-placement.json', capture),
    application: 'operations', artifact: f.artifact('operations'), sourceCommit: SOURCE,
    retainedAssets: f.retainedAssets(capture, 'operations') });
  assert.equal(Object.hasOwn(plan.versionCreateTemplate, 'placement'), false);
  assert.equal(plan.versionCreateTemplate.usage_model, 'bundled');
  assert.deepEqual(plan.expectedUnchangedSettings.placement, {});
});

test('Client planning after Ops successor requires a v3 hash-pinned active/latest readback receipt', t => {
  const f = fixture(t), before = controls(), opsPlan = compileStagingBackendReleasePlan({ controlsFile: f.writeJson('before.json', before),
    application: 'operations', artifact: f.artifact('operations'), sourceCommit: SOURCE,
    retainedAssets: f.retainedAssets(before, 'operations') });
  const successor = controls({ opsVersion: CANDIDATE }), ops = successor.workers.operations;
  ops.rawControlSHA256 = hash('successor-control');
  ops.modern.modules[0].sha256 = opsPlan.artifact.main.sha256;
  const receipt = { schemaVersion: 3, contract: 'staging-backend-ops-successor-observation-v3', accountId: STAGING_ACCOUNT_ID,
    workerName: ops.workerName, baselineVersionId: OPS, candidateVersionId: CANDIDATE, sourceCommit: SOURCE,
    planSHA256: hash(canonical(opsPlan)), mainSHA256: ops.modern.modules[0].sha256, sourceMapSHA256: opsPlan.artifact.sourceMap.sha256,
    rawControlSHA256: ops.rawControlSHA256, rawBindingsSHA256: ops.rawBindingsSHA256,
    settingsSHA256: hash(canonical(ops.settings)), runtimeSHA256: hash(canonical(ops.version.resources.script_runtime)),
    assetsConfigSHA256: hash(canonical(ops.modern.assets)), schedulesSHA256: hash(canonical(ops.schedules.schedules)),
    observedAt: new Date(Date.now() - 90_000).toISOString() };
  const options = { controlsFile: f.writeJson('after-ops.json', successor), application: 'client', artifact: f.artifact('client'),
    sourceCommit: SOURCE, operationsSuccessorReceipt: f.writeJson('ops-successor.json', receipt),
    retainedAssets: f.retainedAssets(successor, 'client') };
  assert.throws(() => compileStagingBackendReleasePlan({ ...options, operationsSuccessorReceipt: undefined }), /control identity or hashes/);
  const plan = compileStagingBackendReleasePlan(options);
  assert.equal(plan.selectedActiveVersionId, CLIENT); assert.equal(plan.operationsSuccessor.candidateVersionId, CANDIDATE);
  const changed = clone(receipt); changed.rawBindingsSHA256 = 'f'.repeat(64);
  const tampered = { ...options, operationsSuccessorReceipt: f.writeJson('tampered.json', changed) };
  assert.throws(() => compileStagingBackendReleasePlan(tampered), /rawBindingsSHA256 differs/);

  const wrongName = clone(successor); wrongName.workers.operations.modern.modules[0].name = 'index.js';
  assert.throws(() => compileStagingBackendReleasePlan({ ...options, controlsFile: f.writeJson('wrong-main-name.json', wrongName) }),
    /complete installed version\/settings\/bindings\/schedules capture required/);
  const wrongMainModule = clone(successor); wrongMainModule.workers.operations.modern.main_module = 'index.js';
  assert.throws(() => compileStagingBackendReleasePlan({ ...options, controlsFile: f.writeJson('wrong-main-module.json', wrongMainModule) }),
    /complete installed version\/settings\/bindings\/schedules capture required/);
  const wrongMainHash = clone(receipt); wrongMainHash.mainSHA256 = hash('not-the-installed-main');
  assert.throws(() => compileStagingBackendReleasePlan({ ...options, operationsSuccessorReceipt: f.writeJson('wrong-main-hash.json', wrongMainHash) }),
    /main identity or hash differs from the installed executable module/);
});

test('local asset materialization pins exact config, files, bytes, and baseline without claiming completeness', t => {
  const f = fixture(t), capture = controls(), assetPin = f.retainedAssets(capture, 'operations');
  const baseOptions = { controlsFile: f.writeJson('manifest-controls.json', capture), application: 'operations',
    artifact: f.artifact('operations'), sourceCommit: SOURCE, retainedAssets: assetPin };
  const valid = compileStagingBackendReleasePlan(baseOptions);
  assert.equal(valid.assetReconstitution.namespaceInherited, false);
  assert.equal(valid.assetReconstitution.namespaceReconstituted, false);
  assert.equal(valid.assetReconstitution.localFileInventoryMatched, true);
  assert.equal(valid.assetReconstitution.remoteNamespaceCompleteness, 'unproven');
  assert.equal(valid.assetUploadRecipe.uploadAssetSetAllowed, false);
  assert.equal(valid.assetUploadRecipe.providerContentHash,
    'BLAKE3(base64(asset bytes) + extension without dot), lowercase hex first 32 chars');
  assert.deepEqual(valid.assetReconstitution.localOnlyFiles.map(row => row.path), ['/.assetsignore']);
  assert.ok(valid.assetReconstitution.files.every(row => !Object.hasOwn(row, 'contentBase64')));
  assert.equal(JSON.stringify(valid).includes('completionJwt":"'), false);

  const readManifest = () => JSON.parse(fs.readFileSync(assetPin.manifestFile.path, 'utf8'));
  const changedConfig = readManifest(); changedConfig.assetsConfig = { ...changedConfig.assetsConfig, base_path: '/wrong/' };
  const changedConfigPin = f.writeJson('wrong-assets-config.json', changedConfig);
  assert.throws(() => compileStagingBackendReleasePlan({ ...baseOptions,
    retainedAssets: { manifestFile: changedConfigPin, filesRoot: assetPin.filesRoot } }), /configuration differs/);

  const wrongInventory = readManifest(); wrongInventory.files[0].path = '/assets/z.js';
  const wrongInventoryPin = f.writeJson('wrong-assets-inventory.json', wrongInventory);
  assert.throws(() => compileStagingBackendReleasePlan({ ...baseOptions,
    retainedAssets: { manifestFile: wrongInventoryPin, filesRoot: assetPin.filesRoot } }), /whole-file inventory/);

  const wrongVersion = readManifest(); wrongVersion.sourceVersionId = CANDIDATE;
  const wrongVersionPin = f.writeJson('wrong-assets-version.json', wrongVersion);
  assert.throws(() => compileStagingBackendReleasePlan({ ...baseOptions,
    retainedAssets: { manifestFile: wrongVersionPin, filesRoot: assetPin.filesRoot } }), /local asset materialization/);
  const completenessClaim = readManifest(); completenessClaim.namespaceCompletenessEstablished = true;
  const completenessPin = f.writeJson('unsupported-namespace-completeness.json', completenessClaim);
  assert.throws(() => compileStagingBackendReleasePlan({ ...baseOptions,
    retainedAssets: { manifestFile: completenessPin, filesRoot: assetPin.filesRoot } }), /local asset materialization/);

  fs.writeFileSync(path.join(assetPin.filesRoot, 'extra-unlisted.bin'), 'unlisted');
  assert.throws(() => compileStagingBackendReleasePlan(baseOptions), /whole-file inventory/);
  fs.unlinkSync(path.join(assetPin.filesRoot, 'extra-unlisted.bin'));
  fs.appendFileSync(path.join(assetPin.filesRoot, 'index.html'), 'changed');
  assert.throws(() => compileStagingBackendReleasePlan(baseOptions), /whole-file inventory/);
  const oversized = path.join(assetPin.filesRoot, 'oversized-sparse.bin'), sparseFd = fs.openSync(oversized, 'w');
  try { fs.ftruncateSync(sparseFd, 16 * 1024 * 1024 + 1); } finally { fs.closeSync(sparseFd); }
  assert.throws(() => compileStagingBackendReleasePlan(baseOptions), /16 MiB per-file bound/);
  fs.unlinkSync(oversized);
  assert.throws(() => compileStagingBackendReleasePlan({ ...baseOptions, retainedAssets: undefined }), /pinned complete retained-asset manifest/);
});

test('compiler rejects profile, implicit latest inheritance, gate, binding, source, and capsule drift', t => {
  const f = fixture(t), base = controls();
  const makeOptions = (capture, application = 'operations', overrides = {}) => ({ controlsFile: f.writeJson(`case-${Math.random()}.json`, capture),
    application, artifact: f.artifact(application), sourceCommit: SOURCE,
    ...(application === 'sync' ? {} : { retainedAssets: f.retainedAssets(capture, application) }), ...overrides });
  const wrongAccount = clone(base); wrongAccount.accountId = 'f'.repeat(32);
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(wrongAccount)), /controls capsule/);
  const candidateDrift = clone(base); candidateDrift.workers.client.latestVersionId = CANDIDATE;
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(candidateDrift, 'client')), /control identity or hashes/);
  const activeDrift = clone(base); activeDrift.workers.operations.activeVersionId = CANDIDATE;
  activeDrift.workers.operations.latestVersionId = CANDIDATE;
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(activeDrift)), /control identity or hashes/);
  const syncDrift = clone(base); syncDrift.workers.sync.activeVersionId = CANDIDATE; syncDrift.workers.sync.latestVersionId = CANDIDATE;
  syncDrift.workers.sync.version.id = CANDIDATE; syncDrift.workers.sync.modern.id = CANDIDATE;
  syncDrift.workers.sync.deployment.versions[0].version_id = CANDIDATE;
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(syncDrift)), /control identity or hashes/);
  for (const [app, flag] of [['operations','OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED'],
    ['operations','CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED'],
    ['client','CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED'], ['client','CLIENT_PORTAL_OPS_INQUIRIES_ENABLED']]) {
    const changed = clone(base); changed.workers[app].selectedFlags[flag] = 'true';
    assert.throws(() => compileStagingBackendReleasePlan(makeOptions(changed, app)), /flags must remain/);
    const missing = clone(base); delete missing.workers[app].selectedFlags[flag];
    assert.throws(() => compileStagingBackendReleasePlan(makeOptions(missing, app)), /flags must remain/);
  }
  const assetDrift = clone(base); assetDrift.workers.client.version.resources.script_runtime.assets.raw_run_worker_first.push('/changed');
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(assetDrift, 'client')), /ASSETS config\/runtime routing/);
  const wrongD1 = clone(base); wrongD1.workers.client.version.resources.bindings.find(b => b.name === 'DELIVERY_DB').id = 'f'.repeat(36);
  wrongD1.workers.client.settings.bindings = clone(wrongD1.workers.client.version.resources.bindings);
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(wrongD1, 'client')), /D1 binding/);
  const rawPlain = clone(base); rawPlain.workers.operations.modern.env.PLAIN_FLAG.text = 'sensitive';
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(rawPlain)), /raw secret\/plain value/);
  const rawJson = clone(base); rawJson.workers.operations.modern.env.RAW_JSON = { type: 'json', json: { secret: 'sensitive' } };
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(rawJson)), /raw secret\/plain value/);
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(base, 'sync')), /Only the fixed/);
  const opts = makeOptions(base, 'client');
  const plan = compileStagingBackendReleasePlan(opts);
  const brokenBindingPlan = clone(plan); brokenBindingPlan.versionCreateTemplate.bindings = brokenBindingPlan.versionCreateTemplate.bindings
    .filter(row => row.name !== 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES');
  assert.throws(() => validateStagingBackendReleasePlan(opts, brokenBindingPlan), /plan changed/);
  const implicitLatestPlan = clone(plan);
  implicitLatestPlan.versionCreateTemplate.bindings = implicitLatestPlan.versionCreateTemplate.bindings.map(row => row.type === 'inherit'
    ? { ...row, version_id: CLIENT_LATEST } : row);
  assert.throws(() => validateStagingBackendReleasePlan(opts, implicitLatestPlan), /plan changed/);
  const heldV2 = { ...plan, schemaVersion: 2, contract: 'staging-backend-only-v2' };
  assert.throws(() => validateStagingBackendReleasePlan(opts, heldV2), /plan changed/);
  assert.throws(() => compileStagingBackendReleasePlan({ ...opts, sourceCommit: 'f'.repeat(40) }), /build source commit/);
  assert.throws(() => compileStagingBackendReleasePlan({ ...opts, sourceCommit: PREVIOUS_SOURCE,
    artifact: f.artifact('client', PREVIOUS_SOURCE) }), /Only the reviewed current backend source commit is accepted/);
  const stale = clone(base); stale.observedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(stale, 'client')), /controls capsule is stale/);
  fs.appendFileSync(opts.artifact.sourceMap.path, ' ');
  assert.throws(() => compileStagingBackendReleasePlan(opts), /source map/);
  assert.throws(() => compileStagingBackendReleasePlan({ ...makeOptions(base, 'client'), controlsFile: { ...opts.controlsFile, sha256: 'f'.repeat(64) } }), /Staging controls capsule missing/);
  const shared = path.join(f.root, 'shared-controls.json'); fs.linkSync(opts.controlsFile.path, shared);
  t.after(() => { if (fs.existsSync(shared)) fs.unlinkSync(shared); });
  assert.throws(() => compileStagingBackendReleasePlan({ ...opts, controlsFile: { path: shared, sha256: opts.controlsFile.sha256 } }), /Staging controls capsule missing/);
});

const privateControlsPath = process.env.LEDGETOP_STAGING_BACKEND_CONTROLS_FILE;
const privateControlsSha = process.env.LEDGETOP_STAGING_BACKEND_CONTROLS_SHA256;
test('private actual controls capsule with synthetic module and asset pins composes only held plans', {
  skip: !(privateControlsPath && privateControlsSha),
}, t => {
  const f = fixture(t), capturePin = { path: privateControlsPath, sha256: privateControlsSha };
  const actualObservedAt = Date.parse(JSON.parse(fs.readFileSync(privateControlsPath, 'utf8')).observedAt);
  for (const application of ['operations','client']) {
    const capture = JSON.parse(fs.readFileSync(privateControlsPath, 'utf8'));
    const plan = compileStagingBackendReleasePlan({ controlsFile: capturePin, application, artifact: f.artifact(application),
      sourceCommit: SOURCE, retainedAssets: f.retainedAssets(capture, application), now: () => actualObservedAt + 1_000 });
    assert.equal(plan.schemaVersion, 3); assert.equal(plan.offlineOnly, true);
    assert.equal(plan.nativeExecutionQualification.ready, false); assert.equal(plan.executionAllowed, false);
    assert.equal(plan.versionCreateTemplate.deploy, false); assert.equal(plan.assetReconstitution.runtimeProofRequired, true);
    assert.equal(plan.assetsUploadRequired, true); assert.equal(plan.noOpsSyncUpdate, true);
    if (application === 'operations') assert.equal(plan.selectedActiveVersionId, OPS);
    else {
      assert.equal(plan.selectedActiveVersionId, CLIENT); assert.equal(plan.selectedLatestVersionId, CLIENT_LATEST);
      assert.equal(plan.inactiveLatestCandidate.active, false);
      assert.ok(plan.versionCreateTemplate.bindings.filter(row => row.type === 'inherit').every(row => row.version_id === CLIENT));
      assert.equal(plan.versionCreateTemplate.bindings.some(row => row.name === 'ASSETS'), false);
      assert.equal(plan.versionCreateTemplate.bindings.filter(row => row.name === 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES').length, 1);
    }
  }
});

const currentProfileControlsPath = process.env.LEDGETOP_STAGING_CURRENT_PROFILE_CONTROLS_FILE;
const currentProfileControlsSha = process.env.LEDGETOP_STAGING_CURRENT_PROFILE_CONTROLS_SHA256;
const currentProfileDryrunRoot = process.env.LEDGETOP_STAGING_CURRENT_PROFILE_DRYRUN_ROOT;
test('current profile v4 accepts the actual 152/125 baseline and rejects baseline, source, binding, export, and freshness drift', {
  skip: !(currentProfileControlsPath && currentProfileControlsSha),
}, t => {
  const f = fixture(t), capture = JSON.parse(fs.readFileSync(currentProfileControlsPath, 'utf8'));
  const observedAt = Date.parse(capture.observedAt), controlsFile = { path: currentProfileControlsPath, sha256: currentProfileControlsSha };
  const dryrunArtifact = application => {
    if (!currentProfileDryrunRoot) return f.artifact(application, CURRENT_SOURCE);
    const isOps = application === 'operations';
    const mainName = isOps ? 'staging-native-authority-entrypoint.js' : 'index.js';
    const directory = path.join(currentProfileDryrunRoot, isOps ? 'operations' : 'client', 'bundle');
    const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
    const main = pin(path.join(directory, mainName)), sourceMap = pin(`${main.path}.map`);
    const expected = isOps
      ? { main: ['99cd0aec4ef22b3bc424d3cb100cfbcb6feb163bd78a827fe8442390ba61f318', 8_657_644],
        sourceMap: ['fe36c25c59e3cc3dcfe3f672931092859fe02cbb25f7b46b6608a35407397f28', 15_026_211] }
      : { main: ['3a5bfec73c59cb066f0797a499f1227f28bd8b233c8b383d92d4729f86015679', 2_854_236],
        sourceMap: ['f47427d47666c676f0d31c8572ff041da74f9372f857197bf68119b536e309a1', 5_023_896] };
    assert.deepEqual([main.sha256, main.size], expected.main);
    assert.deepEqual([sourceMap.sha256, sourceMap.size], expected.sourceMap);
    return { sourceCommit: CURRENT_SOURCE, main, sourceMap };
  };
  assert.equal(capture.workers.operations.activeVersionId, CURRENT_OPS);
  assert.equal(capture.workers.operations.version.resources.bindings.length, 152);
  assert.equal(capture.workers.client.activeVersionId, CURRENT_CLIENT);
  assert.equal(capture.workers.client.version.resources.bindings.length, 125);
  assert.equal(capture.workers.sync.activeVersionId, SYNC);
  const optionsFor = application => ({ controlsFile, application, artifact: dryrunArtifact(application),
    sourceCommit: CURRENT_SOURCE, retainedAssets: f.retainedAssets(capture, application), now: () => observedAt + 1_000 });
  const plans = {};
  for (const application of ['operations','client']) {
    const options = optionsFor(application), plan = compileCurrentStagingBackendReleasePlan(options);
    plans[application] = { options, plan };
    assert.equal(plan.schemaVersion, 4);
    assert.equal(plan.contract, 'staging-backend-only-current-profile-v4');
    assert.equal(plan.selectedActiveVersionId, application === 'operations' ? CURRENT_OPS : CURRENT_CLIENT);
    assert.equal(plan.sourceCommit, CURRENT_SOURCE);
    assert.equal(plan.executionAllowed, false); assert.equal(plan.held, true);
    assert.equal(plan.versionCreateTemplate.deploy, false);
    assert.equal(Object.hasOwn(plan.versionCreateTemplate, 'assets'), false);
    assert.equal(Object.hasOwn(plan.versionCreateTemplate, 'migrations'), false);
    assert.equal(plan.versionCreateTemplate.bindings.length, application === 'operations' ? 151 : 124);
    assert.ok(plan.versionCreateTemplate.bindings.every(row => row.type === 'inherit'
      && row.version_id === plan.selectedActiveVersionId));
    assert.equal(plan.versionCreateTemplate.bindings.some(row => row.name === 'ASSETS'), false);
    assert.deepEqual(plan.versionCreateTemplate.exports, capture.workers[application].modern.exports);
    assert.equal(plan.workerControlPreservation.selectedFlagsSHA256, hash(canonical(capture.workers[application].selectedFlags)));
    assert.equal(plan.workerControlPreservation.exportsSHA256, hash(canonical(capture.workers[application].modern.exports)));
    assert.equal(plan.assetReconstitution.totalFiles, 2);
    assert.equal(validateCurrentStagingBackendReleasePlan(options, plan), plan);
  }
  assert.equal(plans.client.plan.versionCreateTemplate.bindings.some(row => row.name === 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES'
    && row.type === 'service'), false, 'no Client service is added to the already-installed baseline');

  const wrongBaseline = clone(capture), ops = wrongBaseline.workers.operations;
  ops.activeVersionId = CANDIDATE; ops.latestVersionId = CANDIDATE;
  ops.version.id = CANDIDATE; ops.modern.id = CANDIDATE; ops.deployment.versions[0].version_id = CANDIDATE;
  const wrongBaselinePin = f.writeJson('current-wrong-baseline.json', wrongBaseline);
  assert.throws(() => compileCurrentStagingBackendReleasePlan({ ...plans.operations.options, controlsFile: wrongBaselinePin }), /identity or hashes|exact active/i);

  assert.throws(() => compileCurrentStagingBackendReleasePlan({ ...plans.operations.options,
    sourceCommit: PREVIOUS_SOURCE, artifact: f.artifact('operations', PREVIOUS_SOURCE) }), /exact reviewed current source commit/);

  const addedBinding = clone(plans.operations.plan);
  addedBinding.versionCreateTemplate.bindings.push({ name: 'UNREVIEWED_SERVICE', type: 'service', service: 'other-worker',
    entrypoint: 'Unreviewed', version_id: CURRENT_OPS });
  assert.throws(() => validateCurrentStagingBackendReleasePlan(plans.operations.options, addedBinding), /plan changed/);
  const addedExport = clone(plans.client.plan);
  addedExport.versionCreateTemplate.exports.UnreviewedExport = { type: 'worker' };
  assert.throws(() => validateCurrentStagingBackendReleasePlan(plans.client.options, addedExport), /plan changed/);

  const staleCapture = clone(capture); staleCapture.observedAt = new Date(observedAt - 60 * 60_000).toISOString();
  const stalePin = f.writeJson('current-stale-controls.json', staleCapture);
  const staleOptions = { ...plans.operations.options, controlsFile: stalePin, now: () => observedAt + 1_000 };
  assert.throws(() => compileCurrentStagingBackendReleasePlan(staleOptions), /controls capsule is stale/);

  // Model the separately activated Ops successor without relabeling the old
  // capture. Client remains on its exact current version and control snapshot.
  const successor = clone(capture), nextOps = successor.workers.operations;
  successor.observedAt = new Date(observedAt + 1_000).toISOString();
  nextOps.activeVersionId = CANDIDATE; nextOps.latestVersionId = CANDIDATE;
  nextOps.version.id = CANDIDATE; nextOps.modern.id = CANDIDATE;
  nextOps.version.number += 1; nextOps.modern.number += 1;
  nextOps.deployment.versions = [{ version_id: CANDIDATE, percentage: 100 }];
  nextOps.rawControlSHA256 = hash('synthetic current-profile Ops successor observation');
  nextOps.modern.modules[0] = { ...nextOps.modern.modules[0],
    bytes: plans.operations.plan.artifact.main.size, sha256: plans.operations.plan.artifact.main.sha256 };
  const successorControls = f.writeJson('current-ops-successor-controls.json', successor);
  const receipt = { schemaVersion: 4, contract: 'staging-backend-ops-successor-observation-v4',
    accountId: STAGING_ACCOUNT_ID, workerName: nextOps.workerName, baselineVersionId: CURRENT_OPS,
    candidateVersionId: CANDIDATE, sourceCommit: CURRENT_SOURCE,
    planSHA256: hash(canonical(plans.operations.plan)), mainSHA256: nextOps.modern.modules[0].sha256,
    sourceMapSHA256: plans.operations.plan.artifact.sourceMap.sha256,
    rawControlSHA256: nextOps.rawControlSHA256, rawBindingsSHA256: nextOps.rawBindingsSHA256,
    settingsSHA256: hash(canonical(nextOps.settings)), runtimeSHA256: hash(canonical(nextOps.version.resources.script_runtime)),
    assetsConfigSHA256: hash(canonical(nextOps.modern.assets)), schedulesSHA256: hash(canonical(nextOps.schedules.schedules)),
    observedAt: new Date(observedAt + 500).toISOString() };
  const successorOptions = { ...plans.client.options, controlsFile: successorControls,
    operationsSuccessorReceipt: f.writeJson('current-ops-successor-receipt.json', receipt), now: () => observedAt + 2_000 };
  const nextClient = compileCurrentStagingBackendReleasePlan(successorOptions);
  assert.equal(nextClient.operationsSuccessor.candidateVersionId, CANDIDATE);
  assert.equal(nextClient.selectedActiveVersionId, CURRENT_CLIENT);
  assert.ok(nextClient.versionCreateTemplate.bindings.every(row => row.type === 'inherit' && row.version_id === CURRENT_CLIENT));
  assert.throws(() => compileCurrentStagingBackendReleasePlan({ ...successorOptions, operationsSuccessorReceipt: undefined }));
  for (const change of [{ mainSHA256: 'e'.repeat(64) }, { sourceCommit: PREVIOUS_SOURCE },
    { candidateVersionId: CURRENT_OPS }, { rawBindingsSHA256: 'f'.repeat(64) },
    { observedAt: new Date(observedAt + 3_000).toISOString() }]) {
    assert.throws(() => compileCurrentStagingBackendReleasePlan({ ...successorOptions,
      operationsSuccessorReceipt: f.writeJson('current-bad-successor-receipt.json', { ...receipt, ...change }) }));
  }
  const driftedSuccessor = clone(successor);
  driftedSuccessor.workers.operations.settings.tags = ['unexpected'];
  assert.throws(() => compileCurrentStagingBackendReleasePlan({ ...successorOptions,
    controlsFile: f.writeJson('current-drifted-successor-controls.json', driftedSuccessor) }));
});

const ownerReviewControlsPath = process.env.LEDGETOP_OWNER_REVIEW_CONTROLS_FILE
  ?? 'C:/Users/fstor/.codex/artifacts/production-ops-retained-resume-execution-20261031/recipient-owner-review-qualification-controls-20261031/controls.private.json';
const ownerReviewControlsSHA256 = process.env.LEDGETOP_OWNER_REVIEW_CONTROLS_SHA256
  ?? '6e472445026d4f8159e80d85ae4d90ea53dd8938581d46df35276f516096c4fd';
const ownerReviewDryrunRoot = 'C:/Users/fstor/.codex/artifacts/production-ops-retained-resume-execution-20261031/recipient-integrated-owner-review-worker-dryrun-v4-20261031/operations/bundle';
const ownerReviewAssetsRoot = 'C:/Users/fstor/.codex/artifacts/production-ops-retained-resume-execution-20261031/recipient-owner-review-retained-assets-20261031';
const ownerReviewAssetManifestSHA256 = 'db4d4f9f256f852a9296d150e35aa08301c4d7e3684334ccca201117ca66ee29';
const ownerReviewSourceCommit = '4ee6cbe84265d07e2998b795f2a130763e95d4db';
const ownerReviewBaseInputsExist = [
  ownerReviewControlsPath,
  path.join(ownerReviewDryrunRoot, 'staging-native-authority-entrypoint.js'),
  path.join(ownerReviewDryrunRoot, 'staging-native-authority-entrypoint.js.map'),
  path.join(ownerReviewAssetsRoot, 'manifest.json'), path.join(ownerReviewAssetsRoot, 'assets'),
].every(file => fs.existsSync(file));
const ownerReviewCapture = ownerReviewBaseInputsExist ? JSON.parse(fs.readFileSync(ownerReviewControlsPath, 'utf8')) : null;
const ownerReviewAssetsManifest = ownerReviewBaseInputsExist
  ? JSON.parse(fs.readFileSync(path.join(ownerReviewAssetsRoot, 'manifest.json'), 'utf8')) : null;
const ownerReviewInputsExist = ownerReviewBaseInputsExist
  && Date.parse(ownerReviewAssetsManifest.observedAt) <= Date.parse(ownerReviewCapture.observedAt)
  && Date.parse(ownerReviewCapture.observedAt) - Date.parse(ownerReviewAssetsManifest.observedAt) <= 30 * 60_000;

test('owner-review v5 rejects unsupported application and source before reading controls', () => {
  const unusable = { controlsFile: { path: 'Z:/missing.json', sha256: '0'.repeat(64) },
    artifact: {}, retainedAssets: {} };
  assert.throws(() => compileOwnerReviewStagingBackendReleasePlan({ ...unusable, application: 'client',
    sourceCommit: ownerReviewSourceCommit }), /Only the fixed Operations owner-review staging target/);
  assert.throws(() => compileOwnerReviewStagingBackendReleasePlan({ ...unusable, application: 'operations',
    sourceCommit: CURRENT_SOURCE }), /exact reviewed owner-review source commit/);
});

test('owner-review v5 snapshot accepts the exact three-worker profile and rejects schema, settings, target, and freshness drift', {
  skip: !ownerReviewBaseInputsExist,
}, t => {
  const f = fixture(t), capture = clone(ownerReviewCapture), observedAt = Date.parse(capture.observedAt);
  const controlsFile = { path: ownerReviewControlsPath, sha256: ownerReviewControlsSHA256 }, now = () => observedAt + 1_000;
  const profile = validateOwnerReviewStagingBackendControlsSnapshot(controlsFile, { now });
  assert.deepEqual([profile.schemaVersion, profile.contract, profile.accountId],
    [5, 'staging-backend-only-owner-review-profile-v5', STAGING_ACCOUNT_ID]);
  assert.equal(profile.databaseSchemaSHA256, 'bd7531ad0a2900a82d237d922194a8b2b736f642ba6a3dabb2fe99551c797d7a');
  assert.deepEqual([profile.selectedWorker, profile.selectedActiveVersionId, profile.selectedLatestVersionId],
    ['ledgetop-ops-staging', 'e299b7af-f9ed-424b-ae8f-3fdff4f0614e', 'e299b7af-f9ed-424b-ae8f-3fdff4f0614e']);
  assert.deepEqual(Object.keys(profile.observations).sort(), ['client','operations','sync']);
  for (const [application, activeVersionId] of Object.entries({ operations: 'e299b7af-f9ed-424b-ae8f-3fdff4f0614e',
    client: '2e8dd07c-3ccc-47ea-91ce-6e896b42313d', sync: SYNC })) {
    assert.equal(profile.observations[application].activeVersionId, activeVersionId);
    assert.deepEqual(profile.observations[application].deployment, [{ version_id: activeVersionId, percentage: 100 }]);
  }
  assert.throws(() => validateOwnerReviewStagingBackendControlsSnapshot({ ...controlsFile, sha256: 'f'.repeat(64) },
    { now }), /missing, malformed or changed/);
  const schemaDrift = clone(capture); schemaDrift.schema.OPS_DB.results.push({ unexpected: 'schema drift' });
  assert.throws(() => validateOwnerReviewStagingBackendControlsSnapshot(f.writeJson('owner-review-schema-drift.json', schemaDrift),
    { now }), /D1 schema differs/);
  const settingsDrift = clone(capture); settingsDrift.workers.client.settings.tags.push('unexpected');
  assert.throws(() => validateOwnerReviewStagingBackendControlsSnapshot(f.writeJson('owner-review-settings-drift.json', settingsDrift),
    { now }), /controls, settings, runtime, schedules, flags, or exports differ/);
  const staleCapture = clone(capture); staleCapture.observedAt = new Date(observedAt - 60 * 60_000).toISOString();
  assert.throws(() => validateOwnerReviewStagingBackendControlsSnapshot(f.writeJson('owner-review-stale-controls.json', staleCapture),
    { now }), /controls capsule is stale/);
  const wrongOpsTarget = clone(capture); wrongOpsTarget.workers.operations.latestVersionId = '1d79a7ad-d077-49ec-bb3c-7e73d8799773';
  assert.throws(() => validateOwnerReviewStagingBackendControlsSnapshot(f.writeJson('owner-review-wrong-ops-target.json', wrongOpsTarget),
    { now }), /control identity or hashes are invalid/);
});

test('owner-review v5 compiles only the corrected Operations source over exact all-worker controls and retained assets', {
  skip: !ownerReviewInputsExist,
}, t => {
  const f = fixture(t), capture = JSON.parse(fs.readFileSync(ownerReviewControlsPath, 'utf8'));
  const observedAt = Date.parse(capture.observedAt);
  const controlsFile = { path: ownerReviewControlsPath, sha256: ownerReviewControlsSHA256 };
  const artifact = {
    sourceCommit: ownerReviewSourceCommit,
    main: { path: path.join(ownerReviewDryrunRoot, 'staging-native-authority-entrypoint.js'), size: 8_660_985,
      sha256: '2ab14ee0ff246f5849c657dff48cc8f47555f99779b9753f19c5188979141992' },
    sourceMap: { path: path.join(ownerReviewDryrunRoot, 'staging-native-authority-entrypoint.js.map'), size: 15_030_187,
      sha256: '44f1b074e94d86393b31177c3afe33b5b869444fcd604ae8a0a270418a380cb6' },
  };
  const retainedAssets = { manifestFile: { path: path.join(ownerReviewAssetsRoot, 'manifest.json'),
    sha256: ownerReviewAssetManifestSHA256 }, filesRoot: path.join(ownerReviewAssetsRoot, 'assets') };
  const options = { controlsFile, application: 'operations', artifact, sourceCommit: ownerReviewSourceCommit,
    retainedAssets, now: () => observedAt + 1_000 };
  const plan = compileOwnerReviewStagingBackendReleasePlan(options);
  assert.equal(plan.schemaVersion, 5); assert.equal(plan.contract, 'staging-backend-only-owner-review-profile-v5');
  assert.equal(plan.application, 'operations'); assert.equal(plan.sourceCommit, ownerReviewSourceCommit);
  assert.equal(plan.controlsCapture.sha256, controlsFile.sha256);
  assert.deepEqual(plan.artifact, artifact);
  assert.equal(plan.selectedActiveVersionId, 'e299b7af-f9ed-424b-ae8f-3fdff4f0614e');
  assert.deepEqual(plan.releaseSequence, ['operations']);
  assert.equal(plan.offlineOnly, true); assert.equal(plan.deploymentEnabled, false);
  assert.equal(plan.executionAllowed, false); assert.equal(plan.held, true);
  assert.equal(plan.noMigrationConfig, true); assert.equal(plan.noOpsSyncUpdate, true);
  assert.equal(plan.assetReconstitution.totalFiles, 282); assert.equal(plan.assetReconstitution.totalBytes, 44_449_189);
  assert.equal(plan.assetReconstitution.sourceVersionId, plan.selectedActiveVersionId);
  assert.equal(plan.assetReconstitution.remoteNamespaceCompleteness, 'unproven');
  const params = plan.versionCreateTemplate;
  assert.equal(params.deploy, false); assert.equal(params.main_module, 'staging-native-authority-entrypoint.js');
  assert.equal(params.bindings.length, 151);
  assert.ok(params.bindings.every(row => row.type === 'inherit' && row.version_id === plan.selectedActiveVersionId));
  assert.equal(params.bindings.some(row => row.name === 'ASSETS'), false);
  assert.equal(Object.hasOwn(params, 'assets'), false); assert.equal(Object.hasOwn(params, 'migrations'), false);
  assert.deepEqual(params.exports, capture.workers.operations.modern.exports);
  assert.deepEqual(params.compatibility_flags, capture.workers.operations.modern.compatibility_flags);
  assert.deepEqual(plan.expectedUnchangedSchedules, capture.workers.operations.schedules.schedules);
  assert.deepEqual(plan.expectedUnchangedSelectedFlags, capture.workers.operations.selectedFlags);
  assert.deepEqual(plan.observations, validateOwnerReviewStagingBackendControlsSnapshot(controlsFile, { now: options.now }).observations);
  assert.equal(validateOwnerReviewStagingBackendReleasePlan(options, plan), plan);

  const wrongSource = { ...options, sourceCommit: CURRENT_SOURCE, artifact: f.artifact('operations', CURRENT_SOURCE) };
  assert.throws(() => compileOwnerReviewStagingBackendReleasePlan(wrongSource), /exact reviewed owner-review source commit/);
  const wrongArtifact = { ...options, artifact: { ...artifact, main: { ...artifact.main, sha256: 'f'.repeat(64) } } };
  assert.throws(() => compileOwnerReviewStagingBackendReleasePlan(wrongArtifact), /exact reviewed Operations dry-run/);

});
