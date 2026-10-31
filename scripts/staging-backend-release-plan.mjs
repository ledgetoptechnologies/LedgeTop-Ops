/** Fixed-target, offline compiler for the current staging backend profile.
 * It emits a held modern Workers VersionCreateParams shape. It never uploads,
 * deploys, changes schedules, or authorizes release execution. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, need, verifySourceMap } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from './staging-requirements.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const CONTRACT = 'staging-backend-only-v2';
const PLAN_SCHEMA_VERSION = 2;
const CAPSULE_PURPOSE = 'staging-v4-current-controls-and-full-schema-readonly-v1';
const dbPins = inventory => Object.freeze(Object.fromEntries(inventory.d1_databases.map(row => [row.binding, row.database_id])));
const TARGETS = Object.freeze({
  operations: Object.freeze({ workerName: STAGING_INVENTORY.operations.name, activeVersionId: '1ffe4525-7e29-4ea2-a407-726abf7f10c6',
    latestVersionId: '1ffe4525-7e29-4ea2-a407-726abf7f10c6',
    databases: dbPins(STAGING_INVENTORY.operations) }),
  client: Object.freeze({ workerName: STAGING_INVENTORY.delivery.name, activeVersionId: '3ba4c8c9-70b4-4696-810f-0503f512e728',
    latestVersionId: '4f124119-c34b-4608-ba90-ad438c47a90b',
    databases: dbPins(STAGING_INVENTORY.delivery) }),
  sync: Object.freeze({ workerName: STAGING_INVENTORY['ops-sync'].name, activeVersionId: '470134b4-ef95-4702-98f3-110e4f4cbbb0',
    latestVersionId: '470134b4-ef95-4702-98f3-110e4f4cbbb0',
    databases: dbPins(STAGING_INVENTORY['ops-sync']) }),
});
const APPS = Object.freeze(['operations', 'client', 'sync']);
const SAFE_CONTROL_KEYS = new Set(['schemaVersion','purpose','environment','accountId','observedAt','workers','schema',
  'secretValuesPersisted','applicationRowsRead','resourceWrites']);
const SAFE_WORKER_KEYS = new Set(['workerName','activeVersionId','latestVersionId','deployment','version','settings','modern',
  'schedules','selectedFlags','rawBindingsSHA256','rawControlSHA256']);
const RAW_VALUE_KEYS = new Set(['text','textvalue','value','plainvalue','json','jsonvalue','secret','secretvalue','secrettext',
  'secrettextvalue','password','token','tokenvalue','plaintext','plaintextvalue','content','contentbase64','contentvalue',
  'body','raw','rawresponse','authorization','credential','credentials']);
const SAFE_SCHEMA_METADATA_KEYS = new Set(['dfltvalue']);
const NO_ENABLE_FLAGS = Object.freeze(['CLIENT_PORTAL_REQUEST_V2_ENABLED','CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED',
  'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED','CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED',
  'CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED','OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED',
  'NATIVE_STAFF_MASTER_ENABLED','NATIVE_STAFF_MANAGEMENT_ENABLED']);
const OPS_NATIVE_PRINCIPAL_BINDING = Object.freeze({ name: 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES',
  service: 'ledgetop-ops-staging', entrypoint: 'OperationsNativePrincipalInquiryIngress' });
const OPS_NAMED_WORKER_EXPORTS = Object.freeze({
  OperationsPortalNativeDeliveryAuthorizationReader: Object.freeze({ type: 'worker' }),
  ClientPortalNativeFinancialReader: Object.freeze({ type: 'worker' }),
  OperationsNativePrincipalInquiryIngress: Object.freeze({ type: 'worker' }),
});
const SOURCE_COMMIT = '9bf5def4f14226f257ffc1ca4d89a659b51aac1a';
const MAIN_MODULE_NAMES = Object.freeze({ operations: 'staging-native-authority-entrypoint.js', client: 'index.js' });

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

function readPinnedJson(pin, label, { maxBytes = 16 * 1024 * 1024, outside = true } = {}) {
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

function checkedControls(controls, { allowOpsSuccessor = false } = {}) {
  rejectRawValues(controls);
  need(ownKeysAre(controls, [...SAFE_CONTROL_KEYS]) && controls.schemaVersion === 1
    && controls.purpose === CAPSULE_PURPOSE && controls.environment === 'staging'
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
    const opsSuccessorIdentity = app === 'operations' && allowOpsSuccessor
      && UUID.test(row.activeVersionId ?? '') && row.activeVersionId === row.latestVersionId;
    need(ownKeysAre(row, [...SAFE_WORKER_KEYS]) && row.workerName === TARGETS[app].workerName
      && UUID.test(row.activeVersionId ?? '') && UUID.test(row.latestVersionId ?? '')
      && (opsSuccessorIdentity || (row.activeVersionId === TARGETS[app].activeVersionId
        && row.latestVersionId === TARGETS[app].latestVersionId))
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
    if (app !== 'sync') {
      const runtime = row.version.resources.script_runtime;
      need(equal(row.modern.exports, runtime.exports ?? {})
        && equal(row.modern.containers ?? null, runtime.containers ?? null)
        && equal(row.modern.limits ?? null, runtime.limits ?? null)
        && row.modern.usage_model === runtime.usage_model
        && row.modern.usage_model === row.settings.usage_model,
      `${app} modern and native runtime exports, containers, limits or usage model differ`);
      if (runtime.cache_options !== undefined || row.modern.cache_options !== undefined) {
        need(equal(row.modern.cache_options ?? null, runtime.cache_options ?? null),
          `${app} modern and native cache options differ`);
      }
    }
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

function verifyArtifact(artifact, sourceCommit, application) {
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
  const expectedMain = MAIN_MODULE_NAMES[application];
  need(path.basename(artifact.main.path) === expectedMain && path.basename(artifact.sourceMap.path) === `${expectedMain}.map`
    && path.resolve(artifact.sourceMap.path) === path.resolve(`${artifact.main.path}.map`),
    'Genuine sibling source map must be pinned beside the native main module');
  const sourceMap = JSON.parse(contents.get('source map').toString('utf8'));
  verifySourceMap(sourceMap, sourceMap);
  need(sourceCommit === SOURCE_COMMIT, 'Only the reviewed current backend source commit is accepted');
  return { sourceCommit, main: clone(artifact.main), sourceMap: clone(artifact.sourceMap),
    modules: [
      { name: expectedMain, content_type: 'application/javascript+module', content_base64: contents.get('main').toString('base64') },
      { name: `${expectedMain}.map`, content_type: 'application/source-map', content_base64: contents.get('source map').toString('base64') },
    ] };
}

function bindingRows(worker, app) {
  const bindings = worker.version.resources.bindings;
  const pins = TARGETS[app].databases;
  for (const [name, id] of Object.entries(pins)) {
    const rows = bindings.filter(binding => binding.name === name && binding.type === 'd1');
    need(rows.length === 1 && rows[0].id === id, `${app} D1 binding ${name} differs from fixed staging target`);
  }
  const rows = bindings.map(({ name }) => ({ name, type: 'inherit', version_id: worker.activeVersionId }));
  if (app === 'client') rows.push({ ...OPS_NATIVE_PRINCIPAL_BINDING, type: 'service' });
  need(new Set(rows.map(row => row.name)).size === rows.length, `${app} generated binding names must remain unique`);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function compileModernVersionParams(worker, app, artifact) {
  if (app === 'operations') need(Object.keys(OPS_NAMED_WORKER_EXPORTS).every(name => !Object.hasOwn(worker.modern.exports ?? {}, name)),
    'Current Ops profile already contains a staged authority entrypoint; recapture and review the staging profile');
  const params = {
    account_id: STAGING_ACCOUNT_ID,
    deploy: false,
    annotations: Object.fromEntries(Object.entries(worker.settings.annotations ?? {})
      .filter(([key]) => ['workers/message','workers/tag'].includes(key))),
    bindings: bindingRows(worker, app),
    compatibility_date: worker.modern.compatibility_date,
    compatibility_flags: clone(worker.modern.compatibility_flags),
    exports: { ...clone(worker.modern.exports), ...(app === 'operations' ? clone(OPS_NAMED_WORKER_EXPORTS) : {}) },
    main_module: artifact.modules[0].name,
    modules: clone(artifact.modules),
    usage_model: worker.modern.usage_model,
  };
  if (worker.modern.assets?.config) params.assets = { config: clone(worker.modern.assets.config) };
  if (worker.modern.cache_options !== undefined) params.cache_options = clone(worker.modern.cache_options);
  if (worker.modern.containers !== undefined) params.containers = clone(worker.modern.containers);
  if (worker.modern.limits !== undefined) params.limits = clone(worker.modern.limits);
  if (worker.settings.placement && Object.keys(worker.settings.placement).length > 0) {
    need(typeof worker.settings.placement.mode === 'string', 'Nondefault placement must include its native mode');
    params.placement = clone(worker.settings.placement);
  }
  for (const key of ['cache_options','containers','limits']) {
    if (worker.modern[key] !== undefined) need(equal(params[key], worker.modern[key]), `Modern ${key} must be inherited exactly`);
  }
  const expectedExports = { ...clone(worker.modern.exports), ...(app === 'operations' ? clone(OPS_NAMED_WORKER_EXPORTS) : {}) };
  need(Object.entries(worker.modern.exports ?? {}).every(([name, value]) => equal(params.exports[name], value))
    && equal(params.exports, expectedExports),
  'Captured Durable Object exports must remain and only the reviewed Ops entrypoint may be added');
  need(equal(worker.modern.assets?.config ?? null, params.assets?.config ?? null), 'Modern ASSETS config must be inherited exactly');
  need(!Object.hasOwn(params.assets ?? {}, 'jwt'), 'Version create must not carry an asset JWT');
  need(!Object.hasOwn(params, 'migrations'), 'Version create must not include migration instructions');
  return params;
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
  need(ownKeysAre(receipt, keys) && receipt.schemaVersion === PLAN_SCHEMA_VERSION
    && receipt.contract === 'staging-backend-ops-successor-observation-v2'
    && receipt.accountId === STAGING_ACCOUNT_ID && receipt.workerName === TARGETS.operations.workerName
    && receipt.baselineVersionId === TARGETS.operations.activeVersionId
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
  const controls = checkedControls(pinnedControls.value,
    { allowOpsSuccessor: application === 'client' && operationsSuccessorReceipt !== undefined });
  const nowMs = now();
  need(Number.isFinite(nowMs) && Date.parse(controls.observedAt) <= nowMs && nowMs - Date.parse(controls.observedAt) <= 30 * 60_000,
    'Staging controls capsule is stale; capture again before planning');
  const sync = controls.workers.sync;
  need(sync.activeVersionId === TARGETS.sync.activeVersionId && sync.latestVersionId === TARGETS.sync.latestVersionId,
    'Ops Sync staging version changed; this release cannot update or absorb Sync');
  const selected = controls.workers[application], target = TARGETS[application];
  need(selected.activeVersionId === target.activeVersionId && selected.latestVersionId === target.latestVersionId,
    `${application} selected active/latest staging profile differs`);
  if (application === 'operations') {
    need(controls.workers.client.activeVersionId === TARGETS.client.activeVersionId
      && controls.workers.client.latestVersionId === TARGETS.client.latestVersionId,
    'Ops staging release must precede the still-pinned Client active/inactive-latest profile');
    need(operationsSuccessorReceipt === undefined, 'Ops baseline plan does not accept a successor receipt');
  }
  let opsSuccessor;
  if (application === 'client') {
    const ops = controls.workers.operations;
    if (ops.activeVersionId === TARGETS.operations.activeVersionId) {
      need(operationsSuccessorReceipt === undefined, 'Unneeded Ops successor receipt is not accepted at the baseline');
    } else {
      need(operationsSuccessorReceipt, 'Client staging release after Ops requires the reviewed Ops successor receipt');
      const pinnedReceipt = readPinnedJson(operationsSuccessorReceipt, 'Ops successor receipt', { maxBytes: 64 * 1024 });
      opsSuccessor = validateOperationsSuccessor(pinnedReceipt.value, pinnedReceipt.sha256, controls, sourceCommit);
    }
  }
  const nativeArtifact = verifyArtifact(artifact, sourceCommit, application);
  const versionCreateParams = compileModernVersionParams(selected, application, nativeArtifact);
  const observations = Object.fromEntries(APPS.map(app => [app, {
    workerName: controls.workers[app].workerName, activeVersionId: controls.workers[app].activeVersionId,
    latestVersionId: controls.workers[app].latestVersionId, ...controlHashes(controls.workers[app]),
  }]));
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION, contract: CONTRACT, application, accountId: STAGING_ACCOUNT_ID,
    selectedWorker: target.workerName, selectedActiveVersionId: selected.activeVersionId,
    selectedLatestVersionId: selected.latestVersionId,
    ...(selected.latestVersionId !== selected.activeVersionId ? { inactiveLatestCandidate: {
      versionId: selected.latestVersionId, active: false, deployed: false, adoptedForAssets: false,
    } } : {}),
    sourceCommit: nativeArtifact.sourceCommit,
    controlsCapture: { sha256: pinnedControls.sha256, bytes: pinnedControls.bytes, observedAt: controls.observedAt },
    databaseSchemaSHA256: hash(canonical(controls.schema)), releaseSequence: ['operations','client'],
    ...(opsSuccessor ? { operationsSuccessor: opsSuccessor } : {}),
    artifact: { sourceCommit: nativeArtifact.sourceCommit, main: nativeArtifact.main, sourceMap: nativeArtifact.sourceMap },
    offlineOnly: true, deploymentEnabled: false, executionAllowed: false, held: true,
    holdReasons: ['modern-version-api-runtime-qualification-required','asset-inheritance-runtime-proof-required'],
    nativeExecutionQualification: { ready: false, reason: 'current-profile-offline-only-until-modern-api-and-asset-inheritance-qualification' },
    assetsUpload: false, assetJwtIncluded: false, liveNamespaceVerified: false,
    assetInheritance: { bindingName: 'ASSETS', versionId: selected.activeVersionId, explicitVersionId: true },
    assetInheritanceRuntimeProofRequired: true, automaticPruning: false,
    workerControlPreservation: { settingsSHA256: controlHashes(selected).settingsSHA256,
      schedulesSHA256: controlHashes(selected).schedulesSHA256 },
    baselineMainModule: clone(selected.modern.modules[0]),
    selectedControlPins: controlHashes(selected), observations,
    expectedUnchangedSchedules: clone(selected.schedules.schedules),
    expectedUnchangedResources: clone(selected.version.resources),
    expectedUnchangedSettings: clone(selected.settings),
    expectedUnchangedModernAssets: clone(selected.modern.assets),
    noMigrationConfig: true, noOpsSyncUpdate: true, versionCreateParams,
  };
  need(versionCreateParams.deploy === false && versionCreateParams.bindings.some(row => row.name === 'ASSETS'
    && row.type === 'inherit' && row.version_id === selected.activeVersionId)
    && !Object.hasOwn(versionCreateParams.assets ?? {}, 'jwt'),
  'Held modern version-create plan must pin existing assets with no asset upload or deployment');
  const expectedBindingCount = selected.version.resources.bindings.length + (application === 'client' ? 1 : 0);
  need(versionCreateParams.bindings.length === expectedBindingCount
    && versionCreateParams.bindings.filter(row => row.type === 'inherit').length === selected.version.resources.bindings.length,
  'Every existing binding must inherit the explicit active version; only Client adds its reviewed Ops service');
  need(plan.selectedControlPins.settingsSHA256 === hash(canonical(selected.settings))
    && plan.selectedControlPins.schedulesSHA256 === hash(canonical(selected.schedules.schedules)),
  'Worker-level settings and schedules must remain exactly pinned');
  return freeze(plan);
}

export function validateStagingBackendReleasePlan(options, plan) {
  need(equal(plan, compileStagingBackendReleasePlan(options)), 'Staging backend-only release plan changed');
  return plan;
}

export const STAGING_BACKEND_RELEASE_TARGETS = TARGETS;
