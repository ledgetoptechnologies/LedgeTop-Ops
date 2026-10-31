import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical, hash } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID } from './staging-requirements.mjs';
import { compileStagingBackendReleasePlan, validateStagingBackendReleasePlan } from './staging-backend-release-plan.mjs';

const OPS = '1ffe4525-7e29-4ea2-a407-726abf7f10c6';
const CLIENT = '3ba4c8c9-70b4-4696-810f-0503f512e728';
const CLIENT_LATEST = '4f124119-c34b-4608-ba90-ad438c47a90b';
const SYNC = '470134b4-ef95-4702-98f3-110e4f4cbbb0';
const CANDIDATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'c2ce0b6feaa3f410dd6284bd5ce5763818958ec8';
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
