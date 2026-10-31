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
const CONTRACT = 'staging-backend-only-v3';
const PLAN_SCHEMA_VERSION = 3;
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
const CURRENT_PROFILE_SOURCE_COMMIT = 'b22abeccd1889ed2f745db98c6123bafa5820b97';
const CURRENT_PROFILE_TARGETS = Object.freeze({
  operations: Object.freeze({ workerName: STAGING_INVENTORY.operations.name,
    activeVersionId: '1d79a7ad-d077-49ec-bb3c-7e73d8799773', latestVersionId: '1d79a7ad-d077-49ec-bb3c-7e73d8799773',
    mainModuleName: 'staging-native-authority-entrypoint.js', databases: dbPins(STAGING_INVENTORY.operations) }),
  client: Object.freeze({ workerName: STAGING_INVENTORY.delivery.name,
    activeVersionId: 'b1f9053b-e1b9-4435-8bc0-49d03b393fab', latestVersionId: 'b1f9053b-e1b9-4435-8bc0-49d03b393fab',
    mainModuleName: 'index.js', databases: dbPins(STAGING_INVENTORY.delivery) }),
  sync: Object.freeze({ workerName: STAGING_INVENTORY['ops-sync'].name,
    activeVersionId: '470134b4-ef95-4702-98f3-110e4f4cbbb0', latestVersionId: '470134b4-ef95-4702-98f3-110e4f4cbbb0',
    databases: dbPins(STAGING_INVENTORY['ops-sync']) }),
});
const CURRENT_PROFILE_PINS = Object.freeze({
  schemaSHA256: 'bd7531ad0a2900a82d237d922194a8b2b736f642ba6a3dabb2fe99551c797d7a',
  operations: Object.freeze({ rawControlSHA256: '9365ca8688739498ac7b148a159e531b7d4a2957aed7843d5af527d7f6f96326',
    rawBindingsSHA256: 'c74ab2e01d78ca70baaa974c4a58e2fbb4ec47fc70a1a532e5f827916fc60c84',
    bindingIdentitySHA256: '7ecefefe509d398b91df0ecacb7ec020ddee0cad55a6bd1ad970537bb7744e19',
    serviceBindingsSHA256: 'd361793f289cd5546016afd94f51d8fd284009453566ce2c178829d6945a5154',
    settingsSHA256: '9de7539c47fdd0a8b6b5662a49336d30f42815309717f36b273524e3ee74ec6b',
    runtimeSHA256: '9166b35d6905c5916fc515cac614d9db43806358d01d77e3a9f666f5d11a65ce',
    assetsConfigSHA256: '0ef07e7023dabbef7f8c6d6bc51e72cf669fc203335fa9d1f5c7e8d306cbde88',
    schedulesSHA256: '16c7f2cd36bf3274194240d9dca27e3d1c41f38a1a78b6918d1d5c4346ff5011',
    flagsSHA256: '7c8e20772b90df207ba2a9bb22f8c20cde53880ae19d11fd0dbec357c6cfd96e',
    exportsSHA256: 'eb9bd3ea973af496a98c0a8eaf02ac596d6e891fea2d338ac1cd058a98a2075a' }),
  client: Object.freeze({ rawControlSHA256: 'c392eda9c76a12184201a697a31a60c48c63ecab7ba02b92489f040f1badab32',
    rawBindingsSHA256: '7a538de1590b3a8575ad708b51cff8aeffd7360380da5155fe66957529b471dd',
    bindingIdentitySHA256: 'ebed92836d35bbcead5d7379b3667ea9afcf3611d0cfc5081e07b75ce20f0bb0',
    serviceBindingsSHA256: '2911f91c32c3f7c407f21f5a9573413dd5434d80e8ee9d4b46b6f506556adef5',
    settingsSHA256: 'c0e34207712844d7d71c152c241736bdd7893ac4ad4025143a54914c18ba2511',
    runtimeSHA256: '432733e3d1c4b53a0f3e5744572414f47a11904131ef49d33ddcf63b2b6f130e',
    assetsConfigSHA256: 'b1c41485893a0ed4b1a9933fbbe880e3da77e6c0b90d12866c105f1e478bf1f3',
    schedulesSHA256: '9af169f5a55d6393a02f894c4c52b5a97e115de6a505a51b8ef883c347c8549a',
    flagsSHA256: '2784fc23f3c87688c72285f1f9f43638891ada3753281c5d5811a53574bbe18b',
    exportsSHA256: '9151e2ed7fc023457e7a71556e867cd770af52b1a840f7db8165ed9bbee22e17' }),
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
const SOURCE_COMMIT = 'c2ce0b6feaa3f410dd6284bd5ce5763818958ec8';
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

const ASSET_MANIFEST_PURPOSE = 'staging-retained-assets-materialization-v1';
const MAX_ASSET_FILES = 1_024;
const MAX_ASSET_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const MATERIALIZATION_ONLY_PATHS = new Set(['/.assetsignore']);

function checkedAssetPath(value) {
  need(typeof value === 'string' && value.startsWith('/') && value.length > 1
    && !/[\\\\%?#\u0000-\u001f\u007f]/u.test(value), 'Asset manifest paths must be canonical absolute URL paths');
  const segments = value.slice(1).split('/');
  need(segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..'),
    'Asset manifest paths cannot contain empty or traversal segments');
  return value;
}

function inspectAssetTree(root) {
  need(path.isAbsolute(root), 'Retained asset files root must be absolute');
  outsideRepository(root);
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(root); } catch { throw new Error('Retained asset files root is missing or changed'); }
  need(path.resolve(canonicalRoot) === path.resolve(root), 'Retained asset files root cannot traverse a link');
  const rootStat = fs.lstatSync(root);
  need(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Retained asset files root must be a real directory');
  const found = [];
  let totalBytes = 0;
  function visit(directory, prefix = '', depth = 0) {
    need(depth <= 64, 'Retained asset directory nesting exceeds the bounded inventory depth');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      need(!stat.isSymbolicLink() && !entry.isSymbolicLink(), 'Retained asset tree cannot contain links');
      if (stat.isDirectory()) { visit(absolute, relative, depth + 1); continue; }
      need(stat.isFile() && stat.nlink === 1, 'Retained asset files must be single-link regular files');
      need(stat.size <= MAX_ASSET_FILE_BYTES, 'Retained asset file exceeds the 16 MiB per-file bound');
      need(found.length < MAX_ASSET_FILES && totalBytes + stat.size <= MAX_ASSET_BYTES,
        'Retained asset inventory exceeds the bounded file-count or total-byte limits');
      const urlPath = checkedAssetPath(`/${relative.replaceAll('\\', '/')}`);
      const descriptor = fs.openSync(absolute, 'r');
      let bytes;
      try {
        const before = fs.fstatSync(descriptor);
        need(before.isFile() && before.nlink === 1 && before.size === stat.size
          && before.size <= MAX_ASSET_FILE_BYTES && totalBytes + before.size <= MAX_ASSET_BYTES
          && before.dev === stat.dev && before.ino === stat.ino, 'Retained asset changed while opening');
        bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor), current = fs.lstatSync(absolute);
        need(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
          && after.ino === before.ino && after.dev === before.dev && current.ino === before.ino
          && current.dev === before.dev && current.nlink === 1,
        'Retained asset changed while being hashed');
      } finally { fs.closeSync(descriptor); }
      totalBytes += bytes.length;
      found.push({ path: urlPath, size: bytes.length, sha256: hash(bytes) });
    }
  }
  visit(root);
  found.sort((a, b) => a.path.localeCompare(b.path));
  const secondRead = [];
  const firstRead = clone(found);
  found.length = 0;
  totalBytes = 0;
  visit(root);
  found.sort((a, b) => a.path.localeCompare(b.path));
  secondRead.push(...found);
  need(equal(firstRead, secondRead), 'Retained asset tree changed while the complete inventory was verified');
  return secondRead;
}

function checkedRetainedAssets(input, controls, application) {
  need(ownKeysAre(input, ['manifestFile','filesRoot']), 'A pinned complete retained-asset manifest and files root are required');
  const { manifestFile, filesRoot } = input;
  const pinned = readPinnedJson(manifestFile, 'Retained asset manifest', { maxBytes: 16 * 1024 * 1024 });
  const manifest = pinned.value;
  const keys = ['schemaVersion','purpose','environment','accountId','workerName','sourceVersionId','observedAt',
    'scope','assetsConfig','files','excludedFiles'];
  const selected = controls.workers[application];
  need(ownKeysAre(manifest, keys) && manifest.schemaVersion === 1 && manifest.purpose === ASSET_MANIFEST_PURPOSE
    && manifest.environment === 'staging' && manifest.accountId === STAGING_ACCOUNT_ID
    && manifest.workerName === selected.workerName && manifest.sourceVersionId === selected.activeVersionId
    && manifest.scope === 'local-file-materialization-only',
  'A hash-pinned local asset materialization for the selected active staging version is required');
  const observed = Date.parse(manifest.observedAt), controlsObserved = Date.parse(controls.observedAt);
  need(Number.isFinite(observed) && observed <= controlsObserved && controlsObserved - observed <= 30 * 60_000,
    'Retained asset manifest must be fresh and precede its controls capture');
  need(equal(manifest.assetsConfig, selected.modern.assets?.config),
    'Retained asset manifest ASSETS configuration differs from the active profile');
  need(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_ASSET_FILES,
    'Retained asset manifest must include the bounded nonempty local upload-file inventory');
  const expected = manifest.files.map(row => {
    need(ownKeysAre(row, ['path','size','sha256']), 'Retained asset file descriptors must have exact fields');
    return { path: checkedAssetPath(row.path), size: row.size, sha256: row.sha256 };
  });
  need(expected.every(row => Number.isSafeInteger(row.size) && row.size >= 0 && SHA.test(row.sha256 ?? ''))
    && new Set(expected.map(row => row.path)).size === expected.length
    && equal(expected, expected.slice().sort((a, b) => a.path.localeCompare(b.path))),
  'Retained asset manifest paths must be unique, sorted, and pinned by size and SHA-256');
  need(Array.isArray(manifest.excludedFiles) && manifest.excludedFiles.length <= MATERIALIZATION_ONLY_PATHS.size,
    'Local-only materialization file inventory is invalid');
  const excludedFiles = manifest.excludedFiles.map(row => {
    need(ownKeysAre(row, ['path','size','sha256']), 'Local-only file descriptors must have exact fields');
    return { path: checkedAssetPath(row.path), size: row.size, sha256: row.sha256 };
  });
  need(excludedFiles.every(row => MATERIALIZATION_ONLY_PATHS.has(row.path) && Number.isSafeInteger(row.size)
    && row.size >= 0 && SHA.test(row.sha256 ?? ''))
    && new Set(excludedFiles.map(row => row.path)).size === excludedFiles.length
    && equal(excludedFiles, excludedFiles.slice().sort((a, b) => a.path.localeCompare(b.path)))
    && excludedFiles.every(row => !expected.some(asset => asset.path === row.path)),
  'Only exact known local-only support files may be excluded from the uploaded asset manifest');
  need(path.isAbsolute(filesRoot), 'Retained asset files root must be absolute');
  const actual = inspectAssetTree(filesRoot);
  const completeLocalInventory = [...expected, ...excludedFiles].sort((a, b) => a.path.localeCompare(b.path));
  need(equal(actual, completeLocalInventory), 'Retained asset file bytes or whole-file inventory differ from the pinned materialization');
  return { manifestSHA256: pinned.sha256, manifestBytes: pinned.bytes, observedAt: manifest.observedAt,
    sourceVersionId: manifest.sourceVersionId, filesRoot: path.resolve(filesRoot), assetsConfig: clone(manifest.assetsConfig),
    files: expected, excludedFiles, totalBytes: expected.reduce((sum, row) => sum + row.size, 0) };
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

function checkedControls(controls, { allowOpsSuccessor = false, targets = TARGETS } = {}) {
  rejectRawValues(controls);
  need(ownKeysAre(controls, [...SAFE_CONTROL_KEYS]) && controls.schemaVersion === 1
    && controls.purpose === CAPSULE_PURPOSE && controls.environment === 'staging'
    && controls.accountId === STAGING_ACCOUNT_ID && controls.secretValuesPersisted === false
    && controls.applicationRowsRead === 0 && controls.resourceWrites === 0,
  'A genuine hash-only fixed staging controls capsule is required');
  need(Number.isFinite(Date.parse(controls.observedAt)) && Date.parse(controls.observedAt) <= Date.now(),
    'Staging controls observation time is invalid');
  need(ownKeysAre(controls.schema, ['OPS_DB','DELIVERY_DB'])
    && controls.schema.OPS_DB?.id === targets.operations.databases.OPS_DB
    && controls.schema.DELIVERY_DB?.id === targets.client.databases.DELIVERY_DB,
  'Hash-only D1 schema metadata must remain on the exact staging databases');
  need(ownKeysAre(controls.workers, APPS), 'Exact Operations, Client and Sync controls are required');
  for (const app of APPS) {
    const row = controls.workers[app];
    const opsSuccessorIdentity = app === 'operations' && allowOpsSuccessor
      && UUID.test(row.activeVersionId ?? '') && row.activeVersionId !== targets.operations.activeVersionId
      && row.activeVersionId === row.latestVersionId;
    const expectedMainModule = opsSuccessorIdentity ? MAIN_MODULE_NAMES.operations : (targets[app].mainModuleName ?? 'index.js');
    need(ownKeysAre(row, [...SAFE_WORKER_KEYS]) && row.workerName === targets[app].workerName
      && UUID.test(row.activeVersionId ?? '') && UUID.test(row.latestVersionId ?? '')
      && (opsSuccessorIdentity || (row.activeVersionId === targets[app].activeVersionId
        && row.latestVersionId === targets[app].latestVersionId))
      && SHA.test(row.rawBindingsSHA256 ?? '') && SHA.test(row.rawControlSHA256 ?? ''),
    `${app} staging control identity or hashes are invalid`);
    need(Array.isArray(row.deployment?.versions) && row.deployment.versions.length === 1
      && row.deployment.versions[0].version_id === row.activeVersionId && row.deployment.versions[0].percentage === 100,
    `${app} must have one exact active 100% staging version`);
    need(row.version?.id === row.activeVersionId && row.modern?.id === row.activeVersionId
      && typeof row.version.resources?.script?.last_deployed_from === 'string'
      && Array.isArray(row.modern.modules) && row.modern.modules.length === 1
      && ownKeysAre(row.modern.modules[0], ['name','contentType','bytes','sha256'])
      && row.modern.modules[0].name === expectedMainModule
      && (!(opsSuccessorIdentity || targets[app].mainModuleName) || row.modern.main_module === expectedMainModule)
      && typeof row.modern.modules[0].contentType === 'string'
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
    const databasePins = targets[app].databases ?? {};
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

function verifyArtifact(artifact, sourceCommit, application, expectedSourceCommit = SOURCE_COMMIT) {
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
  need(sourceCommit === expectedSourceCommit, 'Only the reviewed current backend source commit is accepted');
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
  const rows = bindings.filter(binding => !(binding.name === 'ASSETS' && binding.type === 'assets'))
    .map(({ name }) => ({ name, type: 'inherit', version_id: worker.activeVersionId }));
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

const bindingIdentityHash = worker => hash(canonical(worker.modern.bindings
  .map(({ name, type }) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name))));
const serviceBindingsHash = worker => hash(canonical(worker.version.resources.bindings
  .filter(binding => binding.type === 'service')
  .map(({ name, type, service, entrypoint, environment }) => ({ name, type, service, entrypoint, environment: environment ?? null }))
  .sort((a, b) => a.name.localeCompare(b.name))));

function checkedCurrentProfilePins(controls, { opsSuccessor = false } = {}) {
  need(hash(canonical(controls.schema)) === CURRENT_PROFILE_PINS.schemaSHA256,
    'Current profile D1 schema differs from the reviewed baseline');
  for (const app of ['operations','client']) {
    const worker = controls.workers[app], pins = CURRENT_PROFILE_PINS[app];
    need(worker.version.resources.bindings.length === (app === 'operations' ? 152 : 125)
      && bindingIdentityHash(worker) === pins.bindingIdentitySHA256
      && serviceBindingsHash(worker) === pins.serviceBindingsSHA256,
    `${app} binding names, types, or service targets differ from the reviewed current profile`);
    const actual = controlHashes(worker);
    const keys = opsSuccessor && app === 'operations'
      ? ['settingsSHA256','runtimeSHA256','assetsConfigSHA256','schedulesSHA256']
      : ['rawControlSHA256','rawBindingsSHA256','settingsSHA256','runtimeSHA256','assetsConfigSHA256','schedulesSHA256'];
    need(keys.every(key => actual[key] === pins[key])
      && hash(canonical(worker.selectedFlags)) === pins.flagsSHA256
      && hash(canonical(worker.modern.exports)) === pins.exportsSHA256,
    `${app} settings, runtime, schedules, gates, exports, or captured controls differ from the reviewed current profile`);
  }
  return controls;
}

function validateCurrentOpsSuccessor(receipt, receiptSHA256, controls, sourceCommit) {
  const keys = ['schemaVersion','contract','accountId','workerName','baselineVersionId','candidateVersionId','sourceCommit',
    'planSHA256','mainSHA256','sourceMapSHA256','rawControlSHA256','rawBindingsSHA256','settingsSHA256','runtimeSHA256',
    'assetsConfigSHA256','schedulesSHA256','observedAt'];
  const ops = controls.workers.operations;
  need(ownKeysAre(receipt, keys) && receipt.schemaVersion === 4
    && receipt.contract === 'staging-backend-ops-successor-observation-v4'
    && receipt.accountId === STAGING_ACCOUNT_ID && receipt.workerName === CURRENT_PROFILE_TARGETS.operations.workerName
    && receipt.baselineVersionId === CURRENT_PROFILE_TARGETS.operations.activeVersionId
    && receipt.candidateVersionId === ops.activeVersionId && receipt.candidateVersionId !== receipt.baselineVersionId
    && receipt.sourceCommit === sourceCommit && COMMIT.test(receipt.sourceCommit)
    && [receipt.planSHA256,receipt.mainSHA256,receipt.sourceMapSHA256].every(value => SHA.test(value ?? '')),
  'Current Client planning requires the exact reviewed Ops successor receipt');
  need(ops.modern.main_module === CURRENT_PROFILE_TARGETS.operations.mainModuleName
    && ops.modern.modules[0]?.name === CURRENT_PROFILE_TARGETS.operations.mainModuleName
    && receipt.mainSHA256 === ops.modern.modules[0].sha256,
  'Ops successor receipt main identity or hash differs from the installed executable module');
  const actual = controlHashes(ops);
  for (const key of Object.keys(actual)) need(receipt[key] === actual[key], `Ops successor receipt ${key} differs from current controls`);
  need(Number.isFinite(Date.parse(receipt.observedAt)) && Date.parse(receipt.observedAt) <= Date.parse(controls.observedAt),
    'Ops successor receipt must precede the fresh controls capture');
  return { receiptSHA256, candidateVersionId: receipt.candidateVersionId, sourceCommit: receipt.sourceCommit,
    planSHA256: receipt.planSHA256, observedAt: receipt.observedAt };
}

function validateOperationsSuccessor(receipt, receiptSHA256, controls, sourceCommit) {
  const keys = ['schemaVersion','contract','accountId','workerName','baselineVersionId','candidateVersionId','sourceCommit',
    'planSHA256','mainSHA256','sourceMapSHA256','rawControlSHA256','rawBindingsSHA256','settingsSHA256','runtimeSHA256',
    'assetsConfigSHA256','schedulesSHA256','observedAt'];
  const ops = controls.workers.operations;
  const expectedMainModule = MAIN_MODULE_NAMES.operations;
  need(ownKeysAre(receipt, keys) && receipt.schemaVersion === PLAN_SCHEMA_VERSION
    && receipt.contract === 'staging-backend-ops-successor-observation-v3'
    && receipt.accountId === STAGING_ACCOUNT_ID && receipt.workerName === TARGETS.operations.workerName
    && receipt.baselineVersionId === TARGETS.operations.activeVersionId
    && receipt.candidateVersionId === ops.activeVersionId && receipt.candidateVersionId !== receipt.baselineVersionId
    && receipt.sourceCommit === sourceCommit && COMMIT.test(receipt.sourceCommit)
    && [receipt.planSHA256,receipt.mainSHA256,receipt.sourceMapSHA256].every(value => SHA.test(value ?? '')),
  'Client sequencing requires an exact reviewed Ops successor receipt matching the fresh active deployment');
  need(ops.modern.main_module === expectedMainModule && ops.modern.modules[0]?.name === expectedMainModule
    && receipt.mainSHA256 === ops.modern.modules[0].sha256,
  'Ops successor receipt main identity or hash differs from the installed executable module');
  // Modern controls attest only the installed executable main; sourceMapSHA256 remains a local build/plan pin, not remote readback.
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
  operationsSuccessorReceipt, retainedAssets, now = () => Date.now() } = {}) {
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
  const checkedAssets = checkedRetainedAssets(retainedAssets, controls, application);
  const versionCreateParams = compileModernVersionParams(selected, application, nativeArtifact);
  const assetsConfig = clone(versionCreateParams.assets.config);
  delete versionCreateParams.assets;
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
    holdReasons: ['modern-version-api-runtime-qualification-required','retained-asset-48-hour-release-coverage-not-qualified'],
    nativeExecutionQualification: { ready: false, reason: 'offline-held-until-modern-api-reconstitution-and-48-hour-coverage-qualification' },
    assetsUploadRequired: true, assetJwtIncluded: false, liveNamespaceVerified: false,
    assetReconstitution: { bindingName: 'ASSETS', sourceVersionId: selected.activeVersionId,
      manifestSHA256: checkedAssets.manifestSHA256, manifestBytes: checkedAssets.manifestBytes,
      observedAt: checkedAssets.observedAt, filesRoot: checkedAssets.filesRoot, totalFiles: checkedAssets.files.length,
      totalBytes: checkedAssets.totalBytes, files: checkedAssets.files, assetsConfig: checkedAssets.assetsConfig,
      localOnlyFiles: checkedAssets.excludedFiles,
      localFileInventoryMatched: true, remoteNamespaceCompleteness: 'unproven', retainedReleaseCoverage: 'unqualified',
      requiredRetainedCoverageHours: 48,
      reconstitutionPermitted: false, namespaceReconstituted: false, namespaceInherited: false,
      runtimeProofRequired: true, automaticPruning: false },
    assetUploadRecipe: { protocol: 'workers-static-assets-upload-v1', manifestInput: 'validated-local-file-materialization',
      uploadAssetSetAllowed: false, requiresReviewedRetainedReleaseCoverageEvidence: true,
      providerContentHash: 'BLAKE3(base64(asset bytes) + extension without dot), lowercase hex first 32 chars',
      providerManifestBytesPersisted: false,
      completionJwtRequired: true, completionJwtSource: 'successful asset upload-session completion',
      completionJwtMemoryOnly: true, completionJwtPersisted: false, assetsConfig,
      attachToVersionCreateAs: 'assets.jwt', neverPersistAssetBytesBase64: true },
    automaticPruning: false,
    workerControlPreservation: { settingsSHA256: controlHashes(selected).settingsSHA256,
      schedulesSHA256: controlHashes(selected).schedulesSHA256 },
    baselineMainModule: clone(selected.modern.modules[0]),
    selectedControlPins: controlHashes(selected), observations,
    expectedUnchangedSchedules: clone(selected.schedules.schedules),
    expectedUnchangedResources: clone(selected.version.resources),
    expectedUnchangedSettings: clone(selected.settings),
    expectedUnchangedModernAssets: clone(selected.modern.assets),
    noMigrationConfig: true, noOpsSyncUpdate: true, versionCreateTemplate: versionCreateParams,
  };
  need(versionCreateParams.deploy === false && !versionCreateParams.bindings.some(row => row.name === 'ASSETS')
    && !Object.hasOwn(versionCreateParams, 'assets') && plan.assetUploadRecipe.completionJwtRequired
    && plan.assetUploadRecipe.completionJwtMemoryOnly && plan.assetUploadRecipe.completionJwtPersisted === false,
  'Held version-create template must exclude assets until a complete-manifest upload yields an in-memory JWT');
  const expectedBindingCount = selected.version.resources.bindings.filter(binding => !(binding.name === 'ASSETS' && binding.type === 'assets')).length
    + (application === 'client' ? 1 : 0);
  need(versionCreateParams.bindings.length === expectedBindingCount
    && versionCreateParams.bindings.filter(row => row.type === 'inherit').length
      === selected.version.resources.bindings.filter(binding => !(binding.name === 'ASSETS' && binding.type === 'assets')).length,
  'Every non-asset binding must inherit the explicit active version; Client adds only its reviewed Ops service');
  need(plan.selectedControlPins.settingsSHA256 === hash(canonical(selected.settings))
    && plan.selectedControlPins.schedulesSHA256 === hash(canonical(selected.schedules.schedules)),
  'Worker-level settings and schedules must remain exactly pinned');
  return freeze(plan);
}

function currentProfileBindingRows(worker, application) {
  const bindings = worker.version.resources.bindings;
  need(bindings.filter(binding => binding.name === 'ASSETS' && binding.type === 'assets').length === 1,
    `${application} must retain its one captured native ASSETS binding`);
  const rows = bindings.filter(binding => !(binding.name === 'ASSETS' && binding.type === 'assets'))
    .map(({ name }) => ({ name, type: 'inherit', version_id: worker.activeVersionId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  need(rows.length === (application === 'operations' ? 151 : 124)
    && new Set(rows.map(row => row.name)).size === rows.length,
  `${application} non-asset binding inventory differs from the pinned active baseline`);
  return rows;
}

function compileCurrentProfileVersionParams(worker, application, artifact) {
  const params = {
    account_id: STAGING_ACCOUNT_ID,
    deploy: false,
    annotations: Object.fromEntries(Object.entries(worker.settings.annotations ?? {})
      .filter(([key]) => ['workers/message','workers/tag'].includes(key))),
    bindings: currentProfileBindingRows(worker, application),
    compatibility_date: worker.modern.compatibility_date,
    compatibility_flags: clone(worker.modern.compatibility_flags),
    exports: clone(worker.modern.exports),
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
  need(equal(params.exports, worker.modern.exports)
    && equal(worker.modern.exports, worker.version.resources.script_runtime.exports ?? {})
    && equal(worker.modern.assets?.config ?? null, params.assets?.config ?? null)
    && !Object.hasOwn(params.assets ?? {}, 'jwt') && !Object.hasOwn(params, 'migrations'),
  'Current profile must preserve exports and native asset configuration without migration or JWT fields');
  for (const key of ['cache_options','containers','limits']) {
    if (worker.modern[key] !== undefined) need(equal(params[key], worker.modern[key]), `Modern ${key} must be inherited exactly`);
  }
  return params;
}

/** Fixed successor compiler for the reviewed post-recipient staging profile.
 * This schema is separate from v3: it pins the new active Ops/Client versions,
 * preserves their existing export/binding sets, and never adds a service. */
export function compileCurrentStagingBackendReleasePlan({ controlsFile, application, artifact, sourceCommit,
  operationsSuccessorReceipt, retainedAssets, now = () => Date.now() } = {}) {
  need(['operations','client'].includes(application) && typeof now === 'function',
    'Only the fixed current Operations or Client staging target is supported');
  need(sourceCommit === CURRENT_PROFILE_SOURCE_COMMIT, 'Only the exact reviewed current source commit is accepted');
  const pinnedControls = readPinnedJson(controlsFile, 'Current staging controls capsule');
  const parsed = pinnedControls.value;
  const opsSuccessorCapture = application === 'client' && operationsSuccessorReceipt !== undefined
    && parsed?.workers?.operations?.activeVersionId !== CURRENT_PROFILE_TARGETS.operations.activeVersionId;
  const controls = checkedControls(parsed, { allowOpsSuccessor: opsSuccessorCapture, targets: CURRENT_PROFILE_TARGETS });
  const nowMs = now(), observed = Date.parse(controls.observedAt);
  need(Number.isFinite(nowMs) && Number.isFinite(observed) && observed <= nowMs && nowMs - observed <= 30 * 60_000,
    'Current staging controls capsule is stale; capture again before planning');
  need(controls.workers.sync.activeVersionId === CURRENT_PROFILE_TARGETS.sync.activeVersionId
    && controls.workers.sync.latestVersionId === CURRENT_PROFILE_TARGETS.sync.latestVersionId,
  'Ops Sync staging version changed; this release cannot update or absorb Sync');
  let opsSuccessor;
  if (application === 'operations') {
    need(controls.workers.client.activeVersionId === CURRENT_PROFILE_TARGETS.client.activeVersionId
      && controls.workers.client.latestVersionId === CURRENT_PROFILE_TARGETS.client.latestVersionId,
    'Current Ops release must precede the still-pinned Client version');
    need(operationsSuccessorReceipt === undefined, 'Ops baseline plan does not accept a successor receipt');
    checkedCurrentProfilePins(controls);
  } else {
    const opsIsBaseline = controls.workers.operations.activeVersionId === CURRENT_PROFILE_TARGETS.operations.activeVersionId;
    if (opsIsBaseline) {
      need(operationsSuccessorReceipt === undefined, 'Unneeded Ops successor receipt is not accepted at the current baseline');
      checkedCurrentProfilePins(controls);
    } else {
      need(opsSuccessorCapture && operationsSuccessorReceipt,
        'Current Client plan after an Ops successor requires its reviewed readback receipt');
      checkedCurrentProfilePins(controls, { opsSuccessor: true });
      const pinnedReceipt = readPinnedJson(operationsSuccessorReceipt, 'Current Ops successor receipt', { maxBytes: 64 * 1024 });
      opsSuccessor = validateCurrentOpsSuccessor(pinnedReceipt.value, pinnedReceipt.sha256, controls, sourceCommit);
    }
  }
  const selected = controls.workers[application], target = CURRENT_PROFILE_TARGETS[application];
  need(selected.activeVersionId === target.activeVersionId && selected.latestVersionId === target.latestVersionId,
    `${application} selected active/latest version differs from the reviewed current profile`);
  const nativeArtifact = verifyArtifact(artifact, sourceCommit, application, CURRENT_PROFILE_SOURCE_COMMIT);
  const checkedAssets = checkedRetainedAssets(retainedAssets, controls, application);
  const versionCreateParams = compileCurrentProfileVersionParams(selected, application, nativeArtifact);
  const assetsConfig = clone(versionCreateParams.assets.config);
  delete versionCreateParams.assets;
  const observations = Object.fromEntries(APPS.map(app => [app, {
    workerName: controls.workers[app].workerName, activeVersionId: controls.workers[app].activeVersionId,
    latestVersionId: controls.workers[app].latestVersionId, ...controlHashes(controls.workers[app]),
  }]));
  const plan = {
    schemaVersion: 4, contract: 'staging-backend-only-current-profile-v4', application, accountId: STAGING_ACCOUNT_ID,
    selectedWorker: target.workerName, selectedActiveVersionId: selected.activeVersionId,
    selectedLatestVersionId: selected.latestVersionId, sourceCommit: nativeArtifact.sourceCommit,
    controlsCapture: { sha256: pinnedControls.sha256, bytes: pinnedControls.bytes, observedAt: controls.observedAt },
    databaseSchemaSHA256: hash(canonical(controls.schema)), releaseSequence: ['operations','client'],
    ...(opsSuccessor ? { operationsSuccessor: opsSuccessor } : {}),
    artifact: { sourceCommit: nativeArtifact.sourceCommit, main: nativeArtifact.main, sourceMap: nativeArtifact.sourceMap },
    offlineOnly: true, deploymentEnabled: false, executionAllowed: false, held: true,
    holdReasons: ['current-profile-native-runtime-and-asset-inheritance-qualification-required',
      'retained-asset-48-hour-release-coverage-not-qualified'],
    nativeExecutionQualification: { ready: false,
      reason: 'offline-held-until-current-profile-native-runtime-and-retained-asset-coverage-qualification' },
    assetsUploadRequired: true, assetJwtIncluded: false, liveNamespaceVerified: false,
    assetReconstitution: { bindingName: 'ASSETS', sourceVersionId: selected.activeVersionId,
      manifestSHA256: checkedAssets.manifestSHA256, manifestBytes: checkedAssets.manifestBytes,
      observedAt: checkedAssets.observedAt, filesRoot: checkedAssets.filesRoot, totalFiles: checkedAssets.files.length,
      totalBytes: checkedAssets.totalBytes, files: checkedAssets.files, assetsConfig: checkedAssets.assetsConfig,
      localOnlyFiles: checkedAssets.excludedFiles, localFileInventoryMatched: true,
      remoteNamespaceCompleteness: 'unproven', retainedReleaseCoverage: 'unqualified', requiredRetainedCoverageHours: 48,
      reconstitutionPermitted: false, namespaceReconstituted: false, namespaceInherited: false,
      runtimeProofRequired: true, automaticPruning: false },
    assetUploadRecipe: { protocol: 'workers-static-assets-upload-v1', manifestInput: 'validated-local-file-materialization',
      uploadAssetSetAllowed: false, requiresReviewedRetainedReleaseCoverageEvidence: true,
      providerContentHash: 'BLAKE3(base64(asset bytes) + extension without dot), lowercase hex first 32 chars',
      providerManifestBytesPersisted: false, completionJwtRequired: true,
      completionJwtSource: 'successful asset upload-session completion', completionJwtMemoryOnly: true,
      completionJwtPersisted: false, assetsConfig, attachToVersionCreateAs: 'assets.jwt', neverPersistAssetBytesBase64: true },
    automaticPruning: false,
    workerControlPreservation: { settingsSHA256: controlHashes(selected).settingsSHA256,
      schedulesSHA256: controlHashes(selected).schedulesSHA256,
      selectedFlagsSHA256: hash(canonical(selected.selectedFlags)), exportsSHA256: hash(canonical(selected.modern.exports)) },
    baselineMainModule: clone(selected.modern.modules[0]), selectedControlPins: controlHashes(selected), observations,
    expectedUnchangedSchedules: clone(selected.schedules.schedules),
    expectedUnchangedResources: clone(selected.version.resources),
    expectedUnchangedSettings: clone(selected.settings), expectedUnchangedModernAssets: clone(selected.modern.assets),
    expectedUnchangedExports: clone(selected.modern.exports), expectedUnchangedSelectedFlags: clone(selected.selectedFlags),
    noMigrationConfig: true, noOpsSyncUpdate: true, versionCreateTemplate: versionCreateParams,
  };
  need(versionCreateParams.deploy === false && !versionCreateParams.bindings.some(row => row.name === 'ASSETS')
    && !Object.hasOwn(versionCreateParams, 'assets') && plan.assetUploadRecipe.completionJwtRequired
    && plan.assetUploadRecipe.completionJwtMemoryOnly && plan.assetUploadRecipe.completionJwtPersisted === false,
  'Current profile held template must exclude ASSETS and JWT until separately qualified');
  need(versionCreateParams.bindings.length === (application === 'operations' ? 151 : 124)
    && versionCreateParams.bindings.every(row => row.type === 'inherit' && row.version_id === selected.activeVersionId)
    && equal(versionCreateParams.exports, selected.modern.exports),
  'Current profile must inherit exactly all active non-asset bindings and preserve the exact exports');
  return freeze(plan);
}

export function validateCurrentStagingBackendReleasePlan(options, plan) {
  need(equal(plan, compileCurrentStagingBackendReleasePlan(options)), 'Current staging backend-only plan changed');
  return plan;
}

export function validateStagingBackendReleasePlan(options, plan) {
  need(equal(plan, compileStagingBackendReleasePlan(options)), 'Staging backend-only release plan changed');
  return plan;
}

export const STAGING_BACKEND_RELEASE_TARGETS = TARGETS;
