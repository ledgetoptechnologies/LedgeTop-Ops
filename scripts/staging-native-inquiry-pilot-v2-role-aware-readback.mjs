/**
 * Read-only, role-aware candidate inspector for the two-step inquiry pilot.
 * It uses injected authenticated GET/query ports and never loads credentials.
 * A selected worker's /settings view belongs to its latest candidate; its
 * active runtime is read from the active version and checked independently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from './staging-requirements.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_ROOT = 'C:/Users/fstor/.codex/artifacts/production-ops-retained-resume-execution-20261031';
const RO = `${ARTIFACT_ROOT}/staging-ops-c2ce0b6f-candidate-uploader-20261031/readonly-reconciliation-module.mjs`;
const RO_SHA256 = '904458809ba38cff4a1a59f647c8dd68752ddeb58ea2bed338b731a8521e5d0e';
const PLAN_SOURCE = path.join(ROOT, 'scripts', 'staging-native-inquiry-pilot-v2-plan.mjs');
const PLAN_SOURCE_SHA256 = 'a5e42bc17600e0a2699838fb30db05a89cd8b9f1c4aa954268361c5da03e6b5b';
const UPLOADER_SOURCE = path.join(ROOT, 'scripts', 'staging-native-inquiry-pilot-v2-upload.mjs');
const UPLOADER_SOURCE_SHA256 = '18bcb8a56b17acc560d78b18153a40d79708eb4bc5e4a939a15ac651cf952fd9';
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_AGE_MS = 30 * 60_000;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const WORKERS = Object.freeze({ operations: STAGING_INVENTORY.operations.name,
  client: STAGING_INVENTORY.delivery.name, sync: STAGING_INVENTORY['ops-sync'].name });
const DATABASES = Object.freeze({ OPS_DB: STAGING_INVENTORY.operations.d1_databases[0].database_id,
  DELIVERY_DB: STAGING_INVENTORY.delivery.d1_databases[0].database_id });
const FLAG_NAMES = Object.freeze(['ENVIRONMENT','CLIENT_PORTAL_REQUEST_V2_ENABLED','CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED',
  'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED','CLIENT_PORTAL_HIERARCHY_V2_ENABLED','NATIVE_STAFF_MASTER_ENABLED',
  'NATIVE_STAFF_MANAGEMENT_ENABLED','SMTP_NOTIFICATIONS_ENABLED','OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED',
  'CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED','CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED']);
const GATES = Object.freeze({
  client: Object.freeze(['CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED','CLIENT_PORTAL_OPS_INQUIRIES_ENABLED']),
  operations: Object.freeze(['OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED','CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED']),
});
const FIXED_VERSION_IDS = Object.freeze({
  operations: '49d03b5c-b104-4f00-974c-334f2ea576f1',
  clientBeforePilot: '2e8dd07c-3ccc-47ea-91ce-6e896b42313d',
  clientAfterPilot: '650c0cec-63fb-407f-8bf3-5a19a0e95aa6',
  sync: '470134b4-ef95-4702-98f3-110e4f4cbbb0',
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const equal = (left, right) => canonical(left) === canonical(right);
const need = (condition, message) => { if (!condition) throw new Error(`Role-aware candidate readback: ${message}`); };
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
need(STAGING_ACCOUNT_ID === '846c924bf17bf4f3dd15c97a4c5d1d51'
  && WORKERS.operations === 'ledgetop-ops-staging' && WORKERS.client === 'ledgetop-clients-staging'
  && WORKERS.sync === 'ledgetop-ops-sync-staging'
  && DATABASES.OPS_DB === '78b34173-b168-4e3d-9832-bb9d245cc6b8'
  && DATABASES.DELIVERY_DB === 'b6f653ab-9acd-4421-9ad0-207754b59aeb', 'staging resource inventory changed');

function readPinnedJson(pin, maxBytes, label) {
  need(pin && path.isAbsolute(pin.path) && SHA.test(pin.sha256 ?? ''), `${label} pin malformed`);
  const stat = fs.lstatSync(pin.path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0
    && stat.size <= maxBytes && fs.realpathSync(pin.path) === path.resolve(pin.path), `${label} is not a bounded single-link file`);
  const fd = fs.openSync(pin.path, 'r');
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    need(before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size
      && bytes.length === before.size && after.dev === before.dev && after.ino === before.ino
      && after.nlink === 1 && after.size === before.size && after.mtimeMs === before.mtimeMs
      && sha(bytes) === pin.sha256, `${label} bytes or file identity changed`);
    return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: pin.sha256 };
  } finally { fs.closeSync(fd); }
}

async function loadPinnedTooling() {
  need(sha(fs.readFileSync(RO)) === RO_SHA256, 'read-only route/sanitizer helper changed');
  need(sha(fs.readFileSync(PLAN_SOURCE)) === PLAN_SOURCE_SHA256, 'pinned plan compiler changed');
  need(sha(fs.readFileSync(UPLOADER_SOURCE)) === UPLOADER_SOURCE_SHA256, 'pinned candidate validator changed');
  const [ro, planner, uploader] = await Promise.all([
    import(pathToFileURL(RO)), import(pathToFileURL(PLAN_SOURCE)), import(pathToFileURL(UPLOADER_SOURCE)),
  ]);
  need(typeof ro.isSafeSdkRoute === 'function' && typeof ro.sanitizeBindings === 'function'
    && typeof ro.resolveCandidateBindings === 'function' && typeof ro.assertNoRawSensitive === 'function',
  'pinned read-only helper API missing');
  need(typeof planner.hashStagingNativeInquiryPilotV2PlanFile === 'function'
    && typeof uploader.validateStagingNativeInquiryPilotV2CandidateReadback === 'function',
  'pinned plan/readback validator API missing');
  return { ro, planner, uploader };
}

function validatePlan(plan, planSHA256, application, candidateVersionId) {
  const expectedBaseline = application === 'operations' ? FIXED_VERSION_IDS.operations : FIXED_VERSION_IDS.clientBeforePilot;
  const expectedSource = application === 'operations'
    ? '4ee6cbe84265d07e2998b795f2a130763e95d4db' : 'b22abeccd1889ed2f745db98c6123bafa5820b97';
  const gateNames = GATES[application] ?? [];
  need(plan && plan.schemaVersion === 2 && plan.contract === 'staging-native-inquiry-pilot-config-only-v2'
    && plan.purpose === 'staging-native-inquiry-pilot-configuration-only-v2'
    && plan.application === application && ['client','operations'].includes(application)
    && plan.accountId === STAGING_ACCOUNT_ID && plan.workerName === WORKERS[application]
    && plan.sourceCommit === expectedSource && plan.baselineVersionId === expectedBaseline
    && plan.currentActiveVersionId === expectedBaseline && plan.currentLatestVersionId === expectedBaseline
    && plan.held === true && plan.offlineOnly === true && plan.executionAllowed === false
    && plan.deploymentEnabled === false && plan.currentActiveVersionId === plan.baselineVersionId
    && UUID.test(plan.currentActiveVersionId ?? '') && UUID.test(candidateVersionId ?? '')
    && candidateVersionId !== plan.currentActiveVersionId && SHA.test(planSHA256 ?? ''),
  'held plan or candidate identity differs from the fixed profile');
  need(Array.isArray(plan.configurationDelta) && plan.configurationDelta.length === gateNames.length
    && plan.configurationDelta.every(row => row && Object.keys(row).sort().join(',') === 'name,text,type'
      && gateNames.includes(row.name) && row.type === 'plain_text' && row.text === 'true')
    && gateNames.every(name => plan.configurationDelta.filter(row => row.name === name).length === 1),
  'plan is not the exact two-gate configuration-only delta');
  return true;
}

function validatePreControls(controls, controlsSHA256, plan, now) {
  need(controls && controls.schemaVersion === 1
    && controls.purpose === 'staging-v4-current-controls-and-full-schema-readonly-v1'
    && controls.environment === 'staging' && controls.accountId === STAGING_ACCOUNT_ID
    && controls.resourceWrites === 0 && controls.applicationRowsRead === 0 && controls.secretValuesPersisted === false
    && SHA.test(controlsSHA256 ?? ''), 'pre-candidate controls are outside the pinned read-only profile');
  const at = Date.parse(controls.observedAt);
  need(Number.isFinite(at) && at <= now && now - at <= MAX_AGE_MS, 'pre-candidate controls are stale or from the future');
  need(controls.workers && Object.keys(controls.workers).sort().join(',') === 'client,operations,sync'
    && controls.schema && controls.schema.OPS_DB?.id === DATABASES.OPS_DB
    && controls.schema.DELIVERY_DB?.id === DATABASES.DELIVERY_DB, 'pre-candidate worker or schema inventory differs');
  const expectedActiveIds = {operations: FIXED_VERSION_IDS.operations,
    client: plan.application === 'operations' ? FIXED_VERSION_IDS.clientAfterPilot : FIXED_VERSION_IDS.clientBeforePilot,
    sync: FIXED_VERSION_IDS.sync};
  for (const app of ['operations','client','sync']) {
    const view = controls.workers[app];
    need(view.workerName === WORKERS[app] && UUID.test(view.activeVersionId ?? '')
      && view.activeVersionId === expectedActiveIds[app]
      && view.latestVersionId === view.activeVersionId && Array.isArray(view.deployment?.versions)
      && view.deployment.versions.length === 1 && view.deployment.versions[0].version_id === view.activeVersionId
      && view.deployment.versions[0].percentage === 100, `${app} pre-candidate state is not a single active 100% version`);
  }
  const selected = controls.workers[plan.application];
  need(selected.activeVersionId === plan.currentActiveVersionId
    && selected.latestVersionId === plan.currentLatestVersionId, 'pre-candidate selected worker differs from held plan');
  need(sha(Buffer.from(canonical(controls.schema))) === plan.databaseSchemaSHA256,
    'pre-candidate schema differs from held plan');
  return at;
}

function moduleProjection(modules) {
  need(Array.isArray(modules) && modules.length > 0, 'module array missing');
  return modules.map(module => {
    need(typeof module.content_base64 === 'string', 'module body malformed');
    const bytes = Buffer.from(module.content_base64, 'base64');
    need(bytes.length > 0 && bytes.toString('base64') === module.content_base64, 'module base64 is not canonical');
    return { name: module.name, bytes: bytes.length, sha256: sha(bytes), content_type: module.content_type };
  });
}

/** Active role views use the read-only control capture's camel-case metadata schema. */
export function projectActiveRoleModules(modules) {
  need(Array.isArray(modules) && modules.length > 0, 'active role module array missing');
  return modules.map(module => {
    need(typeof module.content_base64 === 'string', 'active role module body malformed');
    const bytes = Buffer.from(module.content_base64, 'base64');
    need(bytes.length > 0 && bytes.toString('base64') === module.content_base64,
      'active role module base64 is not canonical');
    return {name: module.name, contentType: module.content_type, bytes: bytes.length, sha256: sha(bytes)};
  });
}

function makeRoleView({ app, workerName, activeId, latestId, deployment, version, settings, modern, schedules, ro }) {
  need(version.id === activeId && modern.id === activeId && Array.isArray(version.resources?.bindings),
    `${app} active version response differs`);
  const safeVersion = structuredClone(version);
  safeVersion.resources.bindings = ro.sanitizeBindings(version.resources.bindings);
  const safeSettings = { ...settings, bindings: ro.sanitizeBindings(settings.bindings) };
  const safeModern = { ...modern, modules: projectActiveRoleModules(modern.modules),
    bindings: ro.sanitizeBindings(modern.bindings),
    env: Object.fromEntries(ro.resolveCandidateBindings(modern).map(({ name, ...row }) => [name, row])) };
  const vars = Object.fromEntries(version.resources.bindings.filter(row => row.type === 'plain_text').map(row => [row.name, row.text]));
  const selectedFlags = Object.fromEntries(FLAG_NAMES.map(name => [name, vars[name] ?? null]));
  const rawControl = { version, settings, modern: { ...modern, modules: modern.modules }, schedules, deployment };
  return { workerName, activeVersionId: activeId, latestVersionId: latestId, deployment, version: safeVersion,
    settings: safeSettings, modern: safeModern, schedules, selectedFlags,
    rawBindingsSHA256: sha(Buffer.from(canonical(version.resources.bindings))),
    rawControlSHA256: sha(Buffer.from(canonical(rawControl))) };
}

async function readResponse(response, label) {
  need(response && Number.isInteger(response.status), `${label} response missing`);
  const bytes = Buffer.from(await response.arrayBuffer());
  need(response.status === 200 && bytes.length > 0 && bytes.length <= MAX_READ_BYTES, `${label} bounded GET failed`);
  const value = JSON.parse(bytes.toString('utf8'));
  need(value.success === true, `${label} provider GET unsuccessful`);
  return value.result;
}

async function getResult(get, ro, url) {
  need(typeof get === 'function' && ro.isSafeSdkRoute('GET', url), 'GET route is outside the pinned read-only allowlist');
  return readResponse(await get(url, { method: 'GET', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(25_000) }), 'worker state');
}

async function captureWorker({ get, ro, app, workerName }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT_ID}`;
  const route = `/workers/scripts/${workerName}`;
  const deployment = (await getResult(get, ro, `${base}${route}/deployments?per_page=1`)).deployments?.[0];
  const latestId = (await getResult(get, ro, `${base}${route}/versions?per_page=1`)).items?.[0]?.id;
  need(deployment && Array.isArray(deployment.versions) && UUID.test(latestId ?? ''), `${app} deployment/latest missing`);
  const activeRows = deployment.versions.filter(row => row.percentage === 100);
  need(activeRows.length === 1 && UUID.test(activeRows[0].version_id), `${app} active distribution is not singular 100%`);
  const activeId = activeRows[0].version_id;
  const [version, settings, modern, schedules] = await Promise.all([
    getResult(get, ro, `${base}${route}/versions/${activeId}`),
    getResult(get, ro, `${base}${route}/settings`),
    getResult(get, ro, `${base}/workers/workers/${workerName}/versions/${activeId}?include=modules`),
    getResult(get, ro, `${base}${route}/schedules`),
  ]);
  return makeRoleView({ app, workerName, activeId, latestId, deployment, version, settings, modern, schedules, ro });
}

/**
 * `query(databaseId, batch)` must return the complete bounded D1 result rows,
 * including each `meta` object. It may not return only `.results`; the inspector
 * verifies primary-readonly `rows_written` and `changed_db` metadata itself.
 */
async function readSchema(query) {
  need(typeof query === 'function', 'read-only D1 query port required');
  const schema = {};
  for (const [name, databaseId] of Object.entries(DATABASES)) {
    const batch = [{ sql: 'SELECT id,name FROM d1_migrations ORDER BY id', params: [] },
      { sql: "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name", params: [] },
      { sql: name === 'OPS_DB' ? "PRAGMA table_info('operations_portal_native_recipient_intents')"
        : "PRAGMA table_info('operations_portal_native_recipient_authority_heads')", params: [] }];
    const rows = await query(databaseId, batch);
    need(Array.isArray(rows) && rows.length === 3 && rows.every(row => row?.success === true
      && row.meta?.rows_written === 0 && row.meta?.changed_db === false && row.meta?.served_by_primary === true),
    `${name} schema query was not a primary read-only batch`);
    schema[name] = { id: databaseId, results: rows.map(row => row.results) };
  }
  return schema;
}

function stableRuntime(worker) {
  return { activeVersionId: worker.activeVersionId, version: worker.version,
    modern: without(worker.modern, ['startup_time_ms']), schedules: worker.schedules,
    selectedFlags: worker.selectedFlags, rawBindingsSHA256: worker.rawBindingsSHA256 };
}

function candidateParamsFor(plan) {
  const params = structuredClone(plan.versionCreateTemplate);
  params.bindings = [...params.bindings, { name: 'ASSETS', type: 'assets' }].sort((a, b) => a.name.localeCompare(b.name));
  params.assets = { config: structuredClone(plan.assetUploadRecipe.assetsConfig), jwt: 'readback-only-synthetic-validation-token' };
  params.deploy = false;
  params.bindings_inherit = 'strict';
  return params;
}

/**
 * Purely validate a captured role set. `views.settings` is the latest-settings
 * resource: selected settings are checked against the candidate, while the
 * active version/runtime remains checked against hash-pinned pre-candidate data.
 */
export async function validateRoleAwareCandidateSnapshot({ application, plan, planSHA256, preControls,
  preControlsSHA256, candidateVersionId, views, schema, candidate, candidateAnnotations, candidateVersionBindings,
  phase, now = Date.now() } = {}) {
  const { ro, uploader } = await loadPinnedTooling();
  validatePlan(plan, planSHA256, application, candidateVersionId);
  const preAt = validatePreControls(preControls, preControlsSHA256, plan, now);
  need(views && Object.keys(views).sort().join(',') === 'client,operations,sync'
    && equal(schema, preControls.schema), 'fresh role views or D1 schema differ from pinned pre-candidate controls');
  for (const app of ['operations','client','sync']) {
    const before = preControls.workers[app], after = views[app];
    need(after?.workerName === WORKERS[app] && UUID.test(after.activeVersionId ?? '')
      && Array.isArray(after.deployment?.versions), `${app} live role capture malformed`);
    if (app !== application) {
      need(equal(stableRuntime(after), stableRuntime(before)) && equal(after.settings, before.settings)
        && equal(after.deployment, before.deployment) && after.latestVersionId === before.latestVersionId,
      `${app} non-selected role changed`);
    }
  }
  const selectedBefore = preControls.workers[application], selected = views[application];
  need(selected.activeVersionId === selectedBefore.activeVersionId
    && selected.activeVersionId === plan.currentActiveVersionId
    && selected.latestVersionId === candidateVersionId
    && equal(stableRuntime(selected), stableRuntime(selectedBefore)),
  'selected active runtime changed or latest candidate is not the created version');
  const activeRows = selected.deployment.versions.filter(row => row.version_id === selectedBefore.activeVersionId && row.percentage === 100);
  const candidateRows = selected.deployment.versions.filter(row => row.version_id === candidateVersionId);
  need(activeRows.length === 1 && selected.deployment.versions.length === (candidateRows.length ? 2 : 1)
    && (candidateRows.length === 0 || (candidateRows.length === 1 && candidateRows[0].percentage === 0)),
  'selected worker traffic is not baseline 100% with only an optional candidate zero row');
  need(equal(without(selected.settings, ['bindings','annotations']),
    without(selectedBefore.settings, ['bindings','annotations']))
    && equal(selected.selectedFlags, selectedBefore.selectedFlags),
  'selected non-candidate settings or active flags changed');
  need(SHA.test(preControlsSHA256) && preAt <= now && now - preAt <= MAX_AGE_MS,
    'pre-candidate evidence expired during reconciliation');

  const params = candidateParamsFor(plan);
  need(candidate && Object.keys(candidate).sort().join(',') ===
    'assetsConfig,compatibilityDate,compatibilityFlags,exports,id,mainModule,modules,resolvedBindings',
  'candidate DTO includes unreviewed fields');
  const byName = rows => ro.sanitizeBindings(rows).slice().sort((a, b) => a.name.localeCompare(b.name));
  const normalizedBindings = byName(candidate.resolvedBindings);
  need(equal(byName(selected.settings.bindings), normalizedBindings),
    'selected latest settings bindings do not equal the candidate resolved bindings');
  const expectedAnnotations = plan.versionCreateTemplate.annotations ?? {};
  const annotations = candidateAnnotations ?? {};
  need(Object.entries(expectedAnnotations).every(([key, value]) => annotations[key] === value)
    && Object.keys(annotations).length === Object.keys(expectedAnnotations).length + 1
    && Object.hasOwn(annotations, 'workers/triggered_by')
    && typeof annotations['workers/triggered_by'] === 'string'
    && annotations['workers/triggered_by'].length > 0 && annotations['workers/triggered_by'].length <= 128
    && equal(annotations, selected.settings.annotations),
  'selected latest settings annotations differ from the exact candidate request plus server trigger');
  need(equal(byName(candidateVersionBindings), normalizedBindings),
    'candidate version binding resources differ from resolved candidate settings');

  const readback = { latestVersionId: selected.latestVersionId,
    deployment: selected.deployment.versions.map(row => ({ versionId: row.version_id, percentage: row.percentage })), candidate };
  uploader.validateStagingNativeInquiryPilotV2CandidateReadback({ readback, candidateVersionId,
    plan, candidateParams: params });
  const derivedPhase = candidateRows.length ? 'zero' : 'inactive';
  need(phase === undefined || phase === derivedPhase, 'phase label differs from observed deployment rows');
  const controls = { schemaVersion: 1, purpose: 'staging-v4-current-controls-and-full-schema-readonly-v1',
    environment: 'staging', accountId: STAGING_ACCOUNT_ID, observedAt: new Date(now).toISOString(), workers: views,
    schema, secretValuesPersisted: false, applicationRowsRead: 0, resourceWrites: 0 };
  const verification = { schemaVersion: 1, purpose: 'staging-native-inquiry-pilot-v2-role-aware-candidate-readback-v1',
    at: controls.observedAt, phase: derivedPhase, application, accountId: STAGING_ACCOUNT_ID,
    workerName: WORKERS[application], baselineVersionId: selectedBefore.activeVersionId,
    candidateVersionId, planSHA256, preControlsSHA256, readbackVerified: true,
    activeRuntimeUnchanged: true, otherControlsUnchanged: true, schemaUnchanged: true,
    resourceWrites: 0, applicationRowsRead: 0 };
  ro.assertNoRawSensitive({ workers: views, schema, candidate, candidateAnnotations });
  ro.assertNoRawSensitive(without(verification, []));
  return {readback, controls, verification};
}

/**
 * Read live state through injected GET and schema-only D1 query ports.
 * The query port must preserve raw D1 result envelopes with `meta`; adapting a
 * results-only helper would remove the evidence required for readonly checks.
 */
export async function inspectRoleAwareCandidate({ get, query, planFile, planSHA256,
  preControlsFile, preControlsSHA256, candidateVersionId } = {}) {
  const planPin = readPinnedJson({ path: planFile, sha256: planSHA256 }, 128 * 1024 * 1024, 'held plan');
  const prePin = readPinnedJson({ path: preControlsFile, sha256: preControlsSHA256 }, 16 * 1024 * 1024, 'pre-candidate controls');
  const { ro, planner } = await loadPinnedTooling();
  need(planner.hashStagingNativeInquiryPilotV2PlanFile(planPin.value) === planPin.sha256,
    'held plan serialization differs from pinned bytes');
  validatePlan(planPin.value, planPin.sha256, planPin.value.application, candidateVersionId);
  validatePreControls(prePin.value, prePin.sha256, planPin.value, Date.now());
  const views = {};
  for (const app of ['operations','client','sync']) {
    views[app] = await captureWorker({ get, ro, app, workerName: WORKERS[app] });
  }
  const schema = await readSchema(query);
  const app = planPin.value.application, workerName = WORKERS[app];
  const base = `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT_ID}`;
  const candidateId = candidateVersionId;
  const [candidateModern, candidateVersion] = await Promise.all([
    getResult(get, ro, `${base}/workers/workers/${workerName}/versions/${candidateId}?include=modules`),
    getResult(get, ro, `${base}/workers/scripts/${workerName}/versions/${candidateId}`),
  ]);
  need(candidateModern.id === candidateId && candidateVersion.id === candidateId
    && (!candidateModern.assets || Object.keys(candidateModern.assets).every(key => key === 'config')),
  'candidate metadata differs or contains unreviewed asset fields');
  const resolvedBindings = ro.resolveCandidateBindings(candidateModern);
  const candidate = { id: candidateModern.id, mainModule: candidateModern.main_module,
    modules: moduleProjection(candidateModern.modules), resolvedBindings,
    assetsConfig: candidateModern.assets?.config, compatibilityDate: candidateModern.compatibility_date,
    compatibilityFlags: candidateModern.compatibility_flags, exports: candidateModern.exports ?? {} };
  const candidateAnnotations = candidateModern.annotations ?? {};
  const versionBindings = ro.sanitizeBindings(candidateVersion.resources?.bindings ?? [])
    .slice().sort((a, b) => a.name.localeCompare(b.name));
  const rows = views[app].deployment.versions;
  const phase = rows.some(row => row.version_id === candidateId && row.percentage === 0) ? 'zero' : 'inactive';
  const result = await validateRoleAwareCandidateSnapshot({ application: app, plan: planPin.value,
    planSHA256: planPin.sha256, preControls: prePin.value, preControlsSHA256: prePin.sha256,
    candidateVersionId, views, schema, candidate, candidateAnnotations, candidateVersionBindings: versionBindings, phase });
  // Keep an explicit safety check at the provider boundary too; no raw response body is returned.
  need(candidateModern.id === candidateVersion.id && result.verification.readbackVerified, 'candidate independent inspection failed');
  return result;
}
