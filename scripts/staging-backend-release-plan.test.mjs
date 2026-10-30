import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical, hash } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID } from './staging-requirements.mjs';
import { compileStagingBackendReleasePlan, validateStagingBackendReleasePlan } from './staging-backend-release-plan.mjs';

const OPS = 'b1023692-2ef2-4004-9187-4cb8b9bb9b65';
const CLIENT = '92276e12-c10d-494f-9378-6553f3cfebf3';
const SYNC = '470134b4-ef95-4702-98f3-110e4f4cbbb0';
const CANDIDATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = '0eafb72c49e1d869262fdc5fbb173ddae0f0ea5f';
const DB = { ops: '78b34173-b168-4e3d-9832-bb9d245cc6b8', delivery: 'b6f653ab-9acd-4421-9ad0-207754b59aeb' };
const disabled = Object.freeze({ CLIENT_PORTAL_REQUEST_V2_ENABLED: null, CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: 'false',
  CLIENT_PORTAL_OPS_INQUIRIES_ENABLED: null, NATIVE_STAFF_MASTER_ENABLED: null, NATIVE_STAFF_MANAGEMENT_ENABLED: 'false' });
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

function controlWorker(app, versionId) {
  const workerName = app === 'operations' ? 'ledgetop-ops-staging' : app === 'client' ? 'ledgetop-clients-staging' : 'ledgetop-ops-sync-staging';
  const runtime = { exports: {}, assets: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application',
    static_routing: { user_worker: ['/api/*'] }, serve_directly: true, raw_run_worker_first: ['/api/*'], base_path: '/' },
    compatibility_date: '2026-07-22', compatibility_flags: ['nodejs_compat'], usage_model: 'standard' };
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
  return { workerName, activeVersionId: versionId, latestVersionId: versionId,
    deployment: { versions: [{ version_id: versionId, percentage: 100 }] },
    version: { id: versionId, number: 1, metadata: {}, annotations: {}, resources: {
      script: { handlers: ['fetch'], named_handlers: [], last_deployed_from: 'wrangler' }, script_runtime: runtime, bindings: clone(rows) } },
    settings, modern: { id: versionId, number: 1, ...(app === 'sync' ? {} : { assets: { config: assetsConfig } }), modules: [{ name: 'index.js', contentType: 'application/javascript+module', bytes: 8192, sha256: hash(`${app}-baseline`)}],
      bindings: clone(rows), env: Object.fromEntries(rows.map(row => [row.name, clone(row)])) },
    schedules: { schedules: app === 'operations' ? [{ cron: '*/15 * * * *' }, { cron: '*/5 * * * *' }] : app === 'client' ? [{ cron: '15 * * * *' }] : [] },
    selectedFlags: app === 'sync' ? {} : { ...disabled }, rawBindingsSHA256: hash(canonical(rows)), rawControlSHA256: hash(`${app}-control`) };
}

function controls({ opsVersion = OPS } = {}) {
  return { schemaVersion: 1, purpose: 'fixed-staging-inquiry-backend-control-capture-v1', environment: 'staging',
    accountId: STAGING_ACCOUNT_ID, observedAt: new Date(Date.now() - 60_000).toISOString(),
    workers: { operations: controlWorker('operations', opsVersion), client: controlWorker('client', CLIENT), sync: controlWorker('sync', SYNC) },
    schema: { OPS_DB: { id: DB.ops }, DELIVERY_DB: { id: DB.delivery } }, secretValuesPersisted: false,
    applicationRowsRead: 0, resourceWrites: 0, captureSanitizationVersion: 2, bindingValueContentsPersisted: false };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-backend-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function writeJson(name, value) {
    const file = path.join(root, name), bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(file, bytes); return { path: file, sha256: hash(bytes) };
  }
  function artifact(commit = SOURCE) {
    const main = path.join(root, 'index.js'), map = `${main}.map`;
    fs.writeFileSync(main, 'export default { fetch(){ return new Response("staging") } };');
    fs.writeFileSync(map, JSON.stringify({ version: 3, file: 'index.js', sources: ['worker.ts'], sourcesContent: ['source'], names: [], mappings: '' }));
    const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
    return { sourceCommit: commit, main: pin(main), sourceMap: pin(map) };
  }
  return { root, writeJson, artifact };
}

test('Ops plan is fixed-target, inherits every binding, and keeps opaque assets without asset upload', t => {
  const f = fixture(t), capture = controls(), options = { controlsFile: f.writeJson('controls.json', capture),
    application: 'operations', artifact: f.artifact(), sourceCommit: SOURCE };
  const plan = compileStagingBackendReleasePlan(options);
  assert.equal(plan.selectedWorker, 'ledgetop-ops-staging'); assert.equal(plan.selectedBaselineVersionId, OPS);
  assert.equal(plan.accountId, STAGING_ACCOUNT_ID); assert.equal(plan.config.name, 'ledgetop-ops-staging');
  assert.equal(plan.config.account_id, STAGING_ACCOUNT_ID); assert.equal(plan.config.no_bundle, true);
  assert.equal(plan.config.upload_source_maps, true); assert.equal(plan.config.find_additional_modules, false);
  assert.equal(plan.config.keep_vars, true); assert.deepEqual(plan.config.vars, {});
  assert.equal(plan.config.unsafe.metadata.keep_assets, true);
  assert.deepEqual(plan.config.unsafe.metadata.annotations, { 'workers/message': 'synthetic operations', 'workers/tag': 'staging' });
  assert.deepEqual(plan.config.unsafe.metadata.assets, capture.workers.operations.version.resources.script_runtime.assets);
  assert.equal(plan.databaseSchemaSHA256, hash(canonical(capture.schema)));
  assert.equal(plan.config.assets, undefined); assert.equal(plan.config.unsafe.metadata.assets.jwt, undefined);
  assert.equal(plan.assetsUpload, false); assert.equal(plan.liveNamespaceVerified, false);
  assert.equal(plan.offlineOnly, true); assert.equal(plan.deploymentEnabled, false); assert.equal(plan.nativeExecutionQualification.ready, false);
  assert.equal(plan.noMigrationConfig, true); assert.equal(plan.noOpsSyncUpdate, true);
  assert.deepEqual(plan.config.unsafe.bindings, capture.workers.operations.version.resources.bindings
    .map(({ name }) => ({ name, type: 'inherit' })).sort((a, b) => a.name.localeCompare(b.name)));
  assert.deepEqual(plan.expectedUnchangedSchedules, capture.workers.operations.schedules.schedules);
  assert.equal(Object.hasOwn(plan.config, 'triggers'), false); assert.equal(Object.hasOwn(plan.config, 'routes'), false);
  assert.equal(Object.hasOwn(plan.config, 'workers_dev'), false); assert.equal(Object.hasOwn(plan.config, 'preview_urls'), false);
  assert.equal(JSON.stringify(plan).includes('synthetic-secret'), false);
  assert.equal(validateStagingBackendReleasePlan(options, plan), plan);
});

test('Client baseline plan is allowed after Ops baseline; Sync and all default-off flags remain fixed', t => {
  const f = fixture(t), capture = controls(), options = { controlsFile: f.writeJson('controls.json', capture),
    application: 'client', artifact: f.artifact(), sourceCommit: SOURCE };
  const plan = compileStagingBackendReleasePlan(options);
  assert.equal(plan.selectedBaselineVersionId, CLIENT);
  assert.equal(plan.observations.sync.activeVersionId, SYNC);
  assert.equal(plan.observations.operations.activeVersionId, OPS);
  assert.deepEqual(plan.config.unsafe.bindings.map(row => row.type), Array(plan.config.unsafe.bindings.length).fill('inherit'));
  assert.equal(plan.expectedUnchangedSettings.bindings.length, capture.workers.client.settings.bindings.length);
});

test('provider default placement and usage model remain metadata without invalid native config fields', t => {
  const f = fixture(t), capture = controls();
  capture.workers.operations.settings.placement = {};
  capture.workers.operations.settings.usage_model = 'bundled';
  const plan = compileStagingBackendReleasePlan({ controlsFile: f.writeJson('default-placement.json', capture),
    application: 'operations', artifact: f.artifact(), sourceCommit: SOURCE });
  assert.equal(Object.hasOwn(plan.config, 'placement'), false);
  assert.equal(Object.hasOwn(plan.config, 'usage_model'), false);
  assert.deepEqual(plan.config.unsafe.metadata.placement, {});
  assert.equal(plan.config.unsafe.metadata.usage_model, 'bundled');
});

test('Client planning after Ops successor requires an exact hash-pinned readback observation', t => {
  const f = fixture(t), opsPlan = compileStagingBackendReleasePlan({ controlsFile: f.writeJson('before.json', controls()),
    application: 'operations', artifact: f.artifact(), sourceCommit: SOURCE });
  const successor = controls({ opsVersion: CANDIDATE }), ops = successor.workers.operations;
  ops.rawControlSHA256 = hash('successor-control');
  const receipt = { schemaVersion: 1, contract: 'staging-backend-ops-successor-observation-v1', accountId: STAGING_ACCOUNT_ID,
    workerName: ops.workerName, baselineVersionId: OPS, candidateVersionId: CANDIDATE, sourceCommit: SOURCE,
    planSHA256: hash(canonical(opsPlan)), mainSHA256: opsPlan.artifact.main.sha256, sourceMapSHA256: opsPlan.artifact.sourceMap.sha256,
    rawControlSHA256: ops.rawControlSHA256, rawBindingsSHA256: ops.rawBindingsSHA256,
    settingsSHA256: hash(canonical(ops.settings)), runtimeSHA256: hash(canonical(ops.version.resources.script_runtime)),
    assetsConfigSHA256: hash(canonical(ops.modern.assets)), schedulesSHA256: hash(canonical(ops.schedules.schedules)),
    observedAt: new Date(Date.now() - 90_000).toISOString() };
  const options = { controlsFile: f.writeJson('after-ops.json', successor), application: 'client', artifact: f.artifact(),
    sourceCommit: SOURCE, operationsSuccessorReceipt: f.writeJson('ops-successor.json', receipt) };
  assert.throws(() => compileStagingBackendReleasePlan({ ...options, operationsSuccessorReceipt: undefined }), /successor receipt/);
  const plan = compileStagingBackendReleasePlan(options);
  assert.equal(plan.selectedBaselineVersionId, CLIENT); assert.equal(plan.operationsSuccessor.candidateVersionId, CANDIDATE);
  const changed = clone(receipt); changed.rawBindingsSHA256 = 'f'.repeat(64);
  const tampered = { ...options, operationsSuccessorReceipt: f.writeJson('tampered.json', changed) };
  assert.throws(() => compileStagingBackendReleasePlan(tampered), /rawBindingsSHA256 differs/);
});

test('Compiler refuses source, account, selected baseline, Sync, flag, binding, raw-value and file-pin drift', t => {
  const f = fixture(t), base = controls();
  const makeOptions = (capture, application = 'operations', overrides = {}) => ({ controlsFile: f.writeJson(`case-${Math.random()}.json`, capture),
    application, artifact: f.artifact(), sourceCommit: SOURCE, ...overrides });
  for (const [name, mutate, app, pattern] of [
    ['wrong account', x => { x.accountId = 'f'.repeat(32); }, 'operations', /controls capsule/],
    ['wrong Ops baseline', x => { x.workers.operations.activeVersionId = CANDIDATE; x.workers.operations.latestVersionId = CANDIDATE;
      x.workers.operations.version.id = CANDIDATE; x.workers.operations.modern.id = CANDIDATE; x.workers.operations.deployment.versions[0].version_id = CANDIDATE; }, 'operations', /baseline version differs/],
    ['changed Sync', x => { const w = x.workers.sync; w.activeVersionId = CANDIDATE; w.latestVersionId = CANDIDATE;
      w.version.id = CANDIDATE; w.modern.id = CANDIDATE; w.deployment.versions[0].version_id = CANDIDATE; }, 'operations', /Ops Sync staging version changed/],
    ['enabled inquiry', x => { x.workers.operations.selectedFlags.CLIENT_PORTAL_OPS_INQUIRIES_ENABLED = 'true'; }, 'operations', /flags must remain/],
    ['asset runtime routing drift', x => { x.workers.operations.version.resources.script_runtime.assets.raw_run_worker_first.push('/changed'); }, 'operations', /ASSETS config\/runtime routing/],
    ['wrong D1', x => { x.workers.client.version.resources.bindings.find(b => b.name === 'DELIVERY_DB').id = 'f'.repeat(36);
      x.workers.client.settings.bindings = clone(x.workers.client.version.resources.bindings); }, 'client', /D1 binding/],
    ['unselected Client moved before Ops', x => { const w = x.workers.client; w.activeVersionId = CANDIDATE; w.latestVersionId = CANDIDATE;
      w.version.id = CANDIDATE; w.modern.id = CANDIDATE; w.deployment.versions[0].version_id = CANDIDATE; }, 'operations', /still-pinned Client baseline/],
    ['attempt Sync selection', x => x, 'sync', /Only the fixed/],
    ['raw duplicate plaintext', x => { x.workers.operations.modern.env.PLAIN_FLAG.text = 'sensitive'; }, 'operations', /raw secret\/plain value/],
    ['raw duplicate JSON', x => { x.workers.operations.modern.env.RAW_JSON = { type: 'json', json: { secret: 'sensitive' } }; }, 'operations', /raw secret\/plain value/],
  ]) {
    const changed = clone(base); mutate(changed);
    assert.throws(() => compileStagingBackendReleasePlan(makeOptions(changed, app)), pattern, name);
  }
  const opts = makeOptions(base);
  assert.throws(() => compileStagingBackendReleasePlan({ ...opts, sourceCommit: 'f'.repeat(40) }), /build source commit/);
  const stale = clone(base); stale.observedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  assert.throws(() => compileStagingBackendReleasePlan(makeOptions(stale)), /controls capsule is stale/);
  fs.appendFileSync(opts.artifact.sourceMap.path, ' ');
  assert.throws(() => compileStagingBackendReleasePlan(opts), /source map/);
  assert.throws(() => compileStagingBackendReleasePlan({ ...makeOptions(base), controlsFile: { ...opts.controlsFile, sha256: 'f'.repeat(64) } }), /Staging controls capsule missing/);
  const shared = path.join(f.root, 'shared-controls.json'); fs.linkSync(opts.controlsFile.path, shared);
  t.after(() => { if (fs.existsSync(shared)) fs.unlinkSync(shared); });
  assert.throws(() => compileStagingBackendReleasePlan({ ...opts, controlsFile: { path: shared, sha256: opts.controlsFile.sha256 } }), /Staging controls capsule missing/);
});

const privateControlsPath = process.env.LEDGETOP_STAGING_BACKEND_CONTROLS_FILE;
const privateControlsSha = process.env.LEDGETOP_STAGING_BACKEND_CONTROLS_SHA256;
test('private actual controls capsule with synthetic module pins: both targets compose as held plans', {
  skip: !(privateControlsPath && privateControlsSha),
}, t => {
  const f = fixture(t), capturePin = { path: privateControlsPath, sha256: privateControlsSha };
  const artifact = f.artifact();
  for (const application of ['operations','client']) {
    const plan = compileStagingBackendReleasePlan({ controlsFile: capturePin, application, artifact, sourceCommit: SOURCE });
    assert.equal(plan.offlineOnly, true); assert.equal(plan.nativeExecutionQualification.ready, false);
    assert.equal(plan.config.unsafe.metadata.keep_assets, true); assert.equal(plan.config.assets, undefined);
    assert.equal(plan.assetsUpload, false); assert.equal(plan.noOpsSyncUpdate, true);
  }
});
