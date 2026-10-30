/** Fixed-target, offline compiler for the inquiry release's staging backend.
 * It emits native Wrangler version-upload configuration only. It does not
 * upload, deploy, change schedules, or authorize release execution. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, need, verifySourceMap } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from './staging-requirements.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const CONTRACT = 'staging-backend-only-v1';
const CAPSULE_PURPOSE = 'fixed-staging-inquiry-backend-control-capture-v1';
const dbPins = inventory => Object.freeze(Object.fromEntries(inventory.d1_databases.map(row => [row.binding, row.database_id])));
const TARGETS = Object.freeze({
  operations: Object.freeze({ workerName: STAGING_INVENTORY.operations.name, baselineVersionId: 'b1023692-2ef2-4004-9187-4cb8b9bb9b65',
    databases: dbPins(STAGING_INVENTORY.operations) }),
  client: Object.freeze({ workerName: STAGING_INVENTORY.delivery.name, baselineVersionId: '92276e12-c10d-494f-9378-6553f3cfebf3',
    databases: dbPins(STAGING_INVENTORY.delivery) }),
  sync: Object.freeze({ workerName: STAGING_INVENTORY['ops-sync'].name, baselineVersionId: '470134b4-ef95-4702-98f3-110e4f4cbbb0',
    databases: dbPins(STAGING_INVENTORY['ops-sync']) }),
});
const APPS = Object.freeze(['operations', 'client', 'sync']);
const SAFE_CONTROL_KEYS = new Set(['schemaVersion','purpose','environment','accountId','observedAt','workers','schema',
  'secretValuesPersisted','applicationRowsRead','resourceWrites','captureSanitizationVersion','bindingValueContentsPersisted']);
const SAFE_WORKER_KEYS = new Set(['workerName','activeVersionId','latestVersionId','deployment','version','settings','modern',
  'schedules','selectedFlags','rawBindingsSHA256','rawControlSHA256']);
const RAW_VALUE_KEYS = new Set(['text','textvalue','value','plainvalue','json','jsonvalue','secret','secretvalue','secrettext',
  'secrettextvalue','password','token','tokenvalue','plaintext','plaintextvalue','content','contentbase64','contentvalue',
  'body','raw','rawresponse','authorization','credential','credentials']);
const SAFE_SCHEMA_METADATA_KEYS = new Set(['dfltvalue']);
const NO_ENABLE_FLAGS = Object.freeze(['CLIENT_PORTAL_REQUEST_V2_ENABLED','CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED',
  'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED','NATIVE_STAFF_MASTER_ENABLED','NATIVE_STAFF_MANAGEMENT_ENABLED']);

const clone = value => structuredClone(value);
const equal = (a, b) => canonical(a) === canonical(b);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const ownKeysAre = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && equal(Object.keys(value).sort(), [...keys].sort());

function outsideRepository(file) {
  const relative = path.relative(ROOT, file);
  need(relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
    'Private control/receipt files must remain outside the source worktree');
}

function readPinnedJson(pin, label, { maxBytes = 1024 * 1024, outside = true } = {}) {
  need(ownKeysAre(pin, ['path', 'sha256']) && path.isAbsolute(pin.path) && SHA.test(pin.sha256 ?? ''), `${label} path and SHA-256 pin required`);
  if (outside) outsideRepository(pin.path);
  let handle;
  try {
    const pathStat = fs.lstatSync(pin.path);
    need(pathStat.isFile() && !pathStat.isSymbolicLink() && pathStat.nlink === 1,
      `${label} must not be a link or shared file`);
    handle = fs.openSync(pin.path, 'r');
    const before = fs.fstatSync(handle);
    need(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= maxBytes,
      `${label} must be a bounded single-link regular file`);
    need(pathStat.dev === before.dev && pathStat.ino === before.ino, `${label} identity changed while opening`);
    const bytes = fs.readFileSync(handle);
    const after = fs.fstatSync(handle);
    need(before.size === bytes.length && before.size === after.size && before.mtimeMs === after.mtimeMs
      && before.ino === after.ino && before.dev === after.dev && hash(bytes) === pin.sha256,
    `${label} changed or differs from its exact file-byte pin`);
    return { value: JSON.parse(bytes.toString('utf8')), bytes: bytes.length, sha256: pin.sha256 };
  } catch { throw new Error(`${label} missing, malformed or changed; plan held`); }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}

function rejectRawValues(value, location = 'controls') {
  if (Array.isArray(value)) { value.forEach((item, index) => rejectRawValues(item, `${location}[${index}]`)); return; }
  if (!value || typeof value !== 'object') return;
  if (location.endsWith('.modern.env')) {
    for (const [bindingName, entry] of Object.entries(value)) rejectRawValues(entry, `${location}.${bindingName}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[_-]/gu, '');
    need(SAFE_SCHEMA_METADATA_KEYS.has(normalized) || (!RAW_VALUE_KEYS.has(normalized)
      && !/(?:text|value|secret|password|token|credential|content|body)$/u.test(normalized)),
      `${location} contains a raw secret/plain value field`);
    rejectRawValues(child, `${location}.${key}`);
  }
}

function checkedControls(controls) {
  rejectRawValues(controls);
  need(ownKeysAre(controls, [...SAFE_CONTROL_KEYS]) && controls.schemaVersion === 1
    && controls.purpose === CAPSULE_PURPOSE && controls.environment === 'staging'
    && controls.captureSanitizationVersion === 2 && controls.bindingValueContentsPersisted === false
    && controls.accountId === STAGING_ACCOUNT_ID && controls.secretValuesPersisted === false
    && controls.applicationRowsRead === 0 && controls.resourceWrites === 0,
  'A genuine hash-only fixed staging controls capsule is required');
  need(Number.isFinite(Date.parse(controls.observedAt)) && Date.parse(controls.observedAt) <= Date.now(),
    'Staging controls observation time is invalid');
  need(ownKeysAre(controls.schema, ['OPS_DB','DELIVERY_DB'])
    && controls.schema.OPS_DB?.id === TARGETS.operations.databases.OPS_DB
    && controls.schema.DELIVERY_DB?.id === TARGETS.client.databases.DELIVERY_DB,
  'Hash-only D1 schema metadata must remain on the exact staging databases');
  need(ownKeysAre(controls.workers, APPS), 'Exact Operations, Client and Sync controls are required');
  for (const app of APPS) {
    const row = controls.workers[app];
    need(ownKeysAre(row, [...SAFE_WORKER_KEYS]) && row.workerName === TARGETS[app].workerName
      && UUID.test(row.activeVersionId ?? '') && row.activeVersionId === row.latestVersionId
      && SHA.test(row.rawBindingsSHA256 ?? '') && SHA.test(row.rawControlSHA256 ?? ''),
    `${app} staging control identity or hashes are invalid`);
    need(Array.isArray(row.deployment?.versions) && row.deployment.versions.length === 1
      && row.deployment.versions[0].version_id === row.activeVersionId && row.deployment.versions[0].percentage === 100,
    `${app} must have one exact active 100% staging version`);
    need(row.version?.id === row.activeVersionId && row.modern?.id === row.activeVersionId
      && typeof row.version.resources?.script?.last_deployed_from === 'string'
      && Array.isArray(row.modern.modules) && row.modern.modules.length === 1
      && ownKeysAre(row.modern.modules[0], ['name','contentType','bytes','sha256'])
      && row.modern.modules[0].name === 'index.js' && typeof row.modern.modules[0].contentType === 'string'
      && Number.isSafeInteger(row.modern.modules[0].bytes) && row.modern.modules[0].bytes > 0
      && SHA.test(row.modern.modules[0].sha256 ?? '')
      && Array.isArray(row.version.resources.bindings) && row.settings?.bindings && Array.isArray(row.settings.bindings)
      && Array.isArray(row.schedules?.schedules) && row.selectedFlags && typeof row.selectedFlags === 'object',
    `${app} complete installed version/settings/bindings/schedules capture required`);
    const bindings = row.version.resources.bindings;
    const names = bindings.map(binding => binding.name);
    need(names.every(name => typeof name === 'string' && name.length > 0) && new Set(names).size === names.length,
      `${app} bindings must have unique exact names`);
    const byName = rows => [...rows].sort((a, b) => a.name.localeCompare(b.name));
    need(equal(byName(row.settings.bindings), byName(bindings)), `${app} settings and version binding inventories differ`);
    need(Array.isArray(row.modern.bindings) && equal(row.modern.bindings.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name)),
      bindings.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name))),
    `${app} modern and version binding identities differ`);
    need(row.modern.env && Object.getPrototypeOf(row.modern.env) === Object.prototype
      && equal(Object.keys(row.modern.env).sort(), names.slice().sort()), `${app} duplicate modern environment binding inventory is incomplete`);
    for (const binding of bindings) {
      const duplicate = row.modern.env[binding.name];
      need(duplicate && typeof duplicate === 'object' && duplicate.type === binding.type,
        `${app} duplicate modern environment binding type differs`);
      if (binding.type === 'plain_text') need(SHA.test(duplicate.textSHA256 ?? '')
        && duplicate.textSHA256 === binding.textSHA256, `${app} duplicate plain value must be SHA-256 only`);
      if (binding.type === 'json') need([duplicate.jsonSHA256, duplicate.valueSHA256, duplicate.sha256].some(value => SHA.test(value ?? '')),
        `${app} duplicate JSON value must be SHA-256 only`);
    }
    const sensitive = bindings.filter(binding => ['plain_text','json','secret_text','secret_key'].includes(binding.type));
    need(sensitive.length <= 128 && sensitive.every(binding => !Object.hasOwn(binding, 'text')
      && !Object.hasOwn(binding, 'value') && !Object.hasOwn(binding, 'secret')),
    `${app} binding values must be represented only by the capsule hashes`);
    const assetRows = bindings.filter(binding => binding.name === 'ASSETS' && binding.type === 'assets');
    if (app === 'sync') need(assetRows.length === 0 && row.modern.assets === undefined
      && row.version.resources.script_runtime?.assets === undefined, 'Sync must remain outside the frontend asset release target');
    else {
      const config = row.modern.assets?.config, runtimeAssets = row.version.resources.script_runtime?.assets;
      need(assetRows.length === 1 && config && runtimeAssets
        && Object.keys(config).every(key => ['base_path','html_handling','not_found_handling','run_worker_first'].includes(key))
        && config.base_path === '/' && Array.isArray(config.run_worker_first)
        && equal(config.run_worker_first, runtimeAssets.raw_run_worker_first)
        && equal(config.run_worker_first, runtimeAssets.static_routing?.user_worker)
        && config.html_handling === runtimeAssets.html_handling
        && config.not_found_handling === runtimeAssets.not_found_handling
        && runtimeAssets.serve_directly === true,
      `${app} captured ASSETS config/runtime routing must agree and remain native`);
    }
    need(row.version.resources.script_runtime.compatibility_date === row.settings.compatibility_date
      && equal(row.version.resources.script_runtime.compatibility_flags, row.settings.compatibility_flags),
    `${app} compatibility runtime and control settings differ`);
    const databaseBindings = bindings.filter(binding => binding.type === 'd1');
    const databasePins = TARGETS[app].databases ?? {};
    need(equal(Object.fromEntries(databaseBindings.map(binding => [binding.name, binding.id])), databasePins),
      `${app} exact staging D1 binding IDs differ`);
    const cronRows = row.schedules.schedules;
    need(cronRows.every(item => typeof item.cron === 'string' && item.cron.length > 0)
      && new Set(cronRows.map(item => item.cron)).size === cronRows.length,
    `${app} exact installed schedules are invalid`);
  }
  for (const app of ['operations', 'client']) {
    const selectedFlags = controls.workers[app].selectedFlags;
    for (const name of NO_ENABLE_FLAGS) need(Object.hasOwn(selectedFlags, name)
      && (selectedFlags[name] === null || selectedFlags[name] === 'false'),
    `${app} protected inquiry/request/native-staff flags must remain absent or false`);
  }
  return controls;
}

function verifyArtifact(artifact, sourceCommit) {
  need(ownKeysAre(artifact, ['sourceCommit','main','sourceMap']) && COMMIT.test(sourceCommit ?? '')
    && artifact.sourceCommit === sourceCommit, 'Exact build source commit and module pins required');
  const contents = new Map();
  for (const [label, pin] of [['main', artifact.main], ['source map', artifact.sourceMap]]) {
    need(ownKeysAre(pin, ['path','size','sha256']) && path.isAbsolute(pin.path) && Number.isSafeInteger(pin.size)
      && pin.size > 0 && pin.size <= 64 * 1024 * 1024 && SHA.test(pin.sha256 ?? ''), `Pinned ${label} file required`);
    let handle;
    try {
      const pathStat = fs.lstatSync(pin.path);
      need(pathStat.isFile() && !pathStat.isSymbolicLink() && pathStat.nlink === 1 && pathStat.size === pin.size,
        `Pinned ${label} must be a bounded single-link regular file`);
      handle = fs.openSync(pin.path, 'r');
      const before = fs.fstatSync(handle);
      need(before.isFile() && before.nlink === 1 && before.size === pin.size
        && before.dev === pathStat.dev && before.ino === pathStat.ino, `Pinned ${label} changed while opening`);
      const bytes = fs.readFileSync(handle), after = fs.fstatSync(handle);
      need(bytes.length === pin.size && after.size === before.size && after.mtimeMs === before.mtimeMs
        && after.ino === before.ino && after.dev === before.dev && hash(bytes) === pin.sha256,
      `Pinned ${label} bytes changed`);
      contents.set(label, bytes);
    } finally { if (handle !== undefined) fs.closeSync(handle); }
  }
  need(path.basename(artifact.main.path) === 'index.js' && path.basename(artifact.sourceMap.path) === 'index.js.map'
    && path.resolve(artifact.sourceMap.path) === path.resolve(`${artifact.main.path}.map`),
    'Genuine sibling source map must be pinned beside the native main module');
  const sourceMap = JSON.parse(contents.get('source map').toString('utf8'));
  verifySourceMap(sourceMap, sourceMap);
  return { sourceCommit, main: clone(artifact.main), sourceMap: clone(artifact.sourceMap) };
}

function bindingRows(worker, app) {
  const bindings = worker.version.resources.bindings;
  const pins = TARGETS[app].databases;
  for (const [name, id] of Object.entries(pins)) {
    const rows = bindings.filter(binding => binding.name === name && binding.type === 'd1');
    need(rows.length === 1 && rows[0].id === id, `${app} D1 binding ${name} differs from fixed staging target`);
  }
  return bindings.map(({ name }) => ({ name, type: 'inherit' })).sort((a, b) => a.name.localeCompare(b.name));
}

function capturedMetadata(worker) {
  const settings = worker.settings, runtime = worker.version.resources.script_runtime;
  const metadata = {};
  for (const key of ['placement','usage_model','tags','tail_consumers','logpush','observability','limits'])
    if (Object.hasOwn(settings, key)) metadata[key] = clone(settings[key]);
  for (const key of ['exports','migration_tag','containers','assets'])
    if (Object.hasOwn(runtime, key)) metadata[key] = clone(runtime[key]);
  metadata.annotations = Object.fromEntries(Object.entries(settings.annotations ?? {})
    .filter(([key]) => key !== 'workers/triggered_by'));
  metadata.keep_assets = true;
  return metadata;
}

function compileNativeConfig(worker, app, artifact) {
  const config = {
    account_id: STAGING_ACCOUNT_ID,
    name: worker.workerName,
    main: artifact.main.path,
    no_bundle: true,
    upload_source_maps: true,
    find_additional_modules: false,
    keep_vars: true,
    vars: {},
    compatibility_date: worker.settings.compatibility_date,
    compatibility_flags: clone(worker.settings.compatibility_flags),
  };
  for (const key of ['placement','usage_model','limits'])
    if (Object.hasOwn(worker.settings, key)) config[key] = clone(worker.settings[key]);
  config.unsafe = { bindings: bindingRows(worker, app), metadata: capturedMetadata(worker) };
  return config;
}

const controlHashes = worker => ({ rawControlSHA256: worker.rawControlSHA256,
  rawBindingsSHA256: worker.rawBindingsSHA256, settingsSHA256: hash(canonical(worker.settings)),
  runtimeSHA256: hash(canonical(worker.version.resources.script_runtime)),
  assetsConfigSHA256: hash(canonical(worker.modern.assets ?? null)),
  schedulesSHA256: hash(canonical(worker.schedules.schedules)) });

function validateOperationsSuccessor(receipt, receiptSHA256, controls, sourceCommit) {
  const keys = ['schemaVersion','contract','accountId','workerName','baselineVersionId','candidateVersionId','sourceCommit',
    'planSHA256','mainSHA256','sourceMapSHA256','rawControlSHA256','rawBindingsSHA256','settingsSHA256','runtimeSHA256',
    'assetsConfigSHA256','schedulesSHA256','observedAt'];
  const ops = controls.workers.operations;
  need(ownKeysAre(receipt, keys) && receipt.schemaVersion === 1
    && receipt.contract === 'staging-backend-ops-successor-observation-v1'
    && receipt.accountId === STAGING_ACCOUNT_ID && receipt.workerName === TARGETS.operations.workerName
    && receipt.baselineVersionId === TARGETS.operations.baselineVersionId
    && receipt.candidateVersionId === ops.activeVersionId && receipt.candidateVersionId !== receipt.baselineVersionId
    && receipt.sourceCommit === sourceCommit && COMMIT.test(receipt.sourceCommit)
    && [receipt.planSHA256,receipt.mainSHA256,receipt.sourceMapSHA256].every(value => SHA.test(value ?? '')),
  'Client sequencing requires an exact reviewed Ops successor receipt matching the fresh active deployment');
  const actual = controlHashes(ops);
  for (const key of Object.keys(actual)) need(receipt[key] === actual[key], `Ops successor receipt ${key} differs from current controls`);
  need(Number.isFinite(Date.parse(receipt.observedAt)) && Date.parse(receipt.observedAt) <= Date.parse(controls.observedAt),
    'Ops successor receipt must precede the fresh controls capture');
  return { receiptSHA256, candidateVersionId: receipt.candidateVersionId, sourceCommit: receipt.sourceCommit,
    planSHA256: receipt.planSHA256, observedAt: receipt.observedAt };
}

/** Compile one fixed-target application. Client planning after an Ops release
 * requires a separately hash-pinned observation receipt; no ready flag is read. */
export function compileStagingBackendReleasePlan({ controlsFile, application, artifact, sourceCommit,
  operationsSuccessorReceipt, now = () => Date.now() } = {}) {
  need(['operations','client'].includes(application) && typeof now === 'function',
    'Only the fixed Operations or Client staging backend target is supported');
  const pinnedControls = readPinnedJson(controlsFile, 'Staging controls capsule');
  const controls = checkedControls(pinnedControls.value);
  const nowMs = now();
  need(Number.isFinite(nowMs) && Date.parse(controls.observedAt) <= nowMs && nowMs - Date.parse(controls.observedAt) <= 30 * 60_000,
    'Staging controls capsule is stale; capture again before planning');
  const sync = controls.workers.sync;
  need(sync.activeVersionId === TARGETS.sync.baselineVersionId, 'Ops Sync staging version changed; this release cannot update or absorb Sync');
  const selected = controls.workers[application], target = TARGETS[application];
  need(selected.activeVersionId === target.baselineVersionId, `${application} selected staging baseline version differs`);
  if (application === 'operations') {
    need(controls.workers.client.activeVersionId === TARGETS.client.baselineVersionId,
      'Ops staging release must precede the still-pinned Client baseline');
    need(operationsSuccessorReceipt === undefined, 'Ops baseline plan does not accept a successor receipt');
  }
  let opsSuccessor;
  if (application === 'client') {
    const ops = controls.workers.operations;
    if (ops.activeVersionId === TARGETS.operations.baselineVersionId) {
      need(operationsSuccessorReceipt === undefined, 'Unneeded Ops successor receipt is not accepted at the baseline');
    } else {
      need(operationsSuccessorReceipt, 'Client staging release after Ops requires the reviewed Ops successor receipt');
      const pinnedReceipt = readPinnedJson(operationsSuccessorReceipt, 'Ops successor receipt', { maxBytes: 64 * 1024 });
      opsSuccessor = validateOperationsSuccessor(pinnedReceipt.value, pinnedReceipt.sha256, controls, sourceCommit);
    }
  }
  const nativeArtifact = verifyArtifact(artifact, sourceCommit);
  const config = compileNativeConfig(selected, application, nativeArtifact);
  const observations = Object.fromEntries(APPS.map(app => [app, {
    workerName: controls.workers[app].workerName, activeVersionId: controls.workers[app].activeVersionId,
    latestVersionId: controls.workers[app].latestVersionId, ...controlHashes(controls.workers[app]),
  }]));
  const plan = {
    schemaVersion: 1, contract: CONTRACT, application, accountId: STAGING_ACCOUNT_ID,
    selectedWorker: target.workerName, selectedBaselineVersionId: selected.activeVersionId,
    sourceCommit: nativeArtifact.sourceCommit,
    controlsCapture: { sha256: pinnedControls.sha256, bytes: pinnedControls.bytes, observedAt: controls.observedAt },
    databaseSchemaSHA256: hash(canonical(controls.schema)), releaseSequence: ['operations','client'],
    ...(opsSuccessor ? { operationsSuccessor: opsSuccessor } : {}),
    artifact: nativeArtifact,
    offlineOnly: true, deploymentEnabled: false, nativeExecutionQualification: { ready: false,
      reason: 'staging-native-cli-and-operator-execution-review-required' },
    assetsUpload: false, assetJwtIncluded: false, liveNamespaceVerified: false,
    assetPreservationDirective: 'native-keep-assets', automaticPruning: false,
    baselineMainModule: clone(selected.modern.modules[0]),
    selectedControlPins: controlHashes(selected), observations,
    expectedUnchangedSchedules: clone(selected.schedules.schedules),
    expectedUnchangedResources: clone(selected.version.resources),
    expectedUnchangedSettings: clone(selected.settings),
    expectedUnchangedModernAssets: clone(selected.modern.assets),
    noMigrationConfig: true, noOpsSyncUpdate: true, config,
  };
  need(config.unsafe.metadata.keep_assets === true && config.unsafe.bindings.some(row => row.name === 'ASSETS')
    && !Object.hasOwn(config, 'assets') && !Object.hasOwn(config, 'routes') && !Object.hasOwn(config, 'triggers')
    && !Object.hasOwn(config, 'workers_dev') && !Object.hasOwn(config, 'preview_urls'),
  'Staging backend plan must retain ASSETS without publishing routes, triggers or preview configuration');
  need(config.unsafe.bindings.length === selected.version.resources.bindings.length
    && config.unsafe.bindings.every(row => row.type === 'inherit'), 'Every installed staging binding must remain inherited');
  return freeze(plan);
}

export function validateStagingBackendReleasePlan(options, plan) {
  need(equal(plan, compileStagingBackendReleasePlan(options)), 'Staging backend-only release plan changed');
  return plan;
}

export const STAGING_BACKEND_RELEASE_TARGETS = TARGETS;
