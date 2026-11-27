/** Installed schema preservation v2 for the canonical installed profile v5 automatic lanes.
 *
 * base.json pins the installed state read (read-only) at its observedAt: each production database's
 * full ordered migration ledger (names and ids, including Client's historical rows and its
 * out-of-order rows) and its application-schema digest. v2 drops v1's exact source inventory,
 * pendingSourceNames and allSourceMigrationsInstalled === false. Instead, every source migration
 * that is not installed must sort after the highest installed name; until automatic migration
 * apply exists, any such pending file still holds the release (`migration_required_pending`), and
 * an out-of-order one holds as `migration_out_of_order_pending`.
 *
 * The session reads only Worker metadata (GET) and the two v1 metadata SELECTs. It never writes
 * D1, authorizes a migration or activates a feature. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical, hash as sha256Hex, resourcesShape, varsOf, validateInstallation, CloudflareReader, capture,
  ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE, CANONICAL_INSTALLED_PROFILE_V5_SHA256 } from '../../production-deploy.mjs';
import { isNativeProductionCloudflareTransport } from '../../production-auto-cloudflare-pacer.mjs';
import { ACCOUNT_ID, PRODUCTION_DATABASES, readInstalledSchemaPreservationMetadata, summarizeInstalledSchema }
  from '../installed-schema-preservation-v1/installed-schema-preservation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BASE_PATH = new URL('./base.json', import.meta.url);
const APP_NAMES = Object.freeze(['operations', 'client']);
const SHA256 = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u;
const MAX_RELEASE_EVIDENCE_AGE_MS = 60_000;
const MAX_SAME_RUN_BASELINE_AGE_MS = 45 * 60_000;
/** The reviewed base. base.json must match these exactly (and its bytes are pinned below). */
export const INSTALLED_SCHEMA_PRESERVATION_V2_BASE_PINS = Object.freeze({
  observedAt: '2026-11-27T20:09:53.090Z',
  operations: Object.freeze({ databaseId: PRODUCTION_DATABASES.operations, ledgerCount: 238,
    highestInstalledName: '0248_client_onboarding_invite_mail_outbox.sql',
    orderedLedgerSha256: 'bddff2b1eb5ad46da2ae449e4b07ce899e1082668a5e78a5716112d5f5489b91',
    objectCount: 2616, objectsSha256: '701c5294031095d53daf0a90608a46ee82eeb25877c729b6c564906ef6ccf56f' }),
  client: Object.freeze({ databaseId: PRODUCTION_DATABASES.client, ledgerCount: 164,
    highestInstalledName: '0243_viewer_direct_grant_model_report.sql',
    orderedLedgerSha256: '5dbcf86ded8599cfb6e5199b8673c42e21dd84681a1464fceed0518f63f68d7e',
    objectCount: 1210, objectsSha256: 'ebfa0d346537eb9452410ea0f02a3e4bb61a1dbcf3ac02cd5448ea0a933895ce' }),
});
const PINNED_BASE_BYTES_SHA256 = 'e8e5b65e96909935739c280f66d88b3593337f7374988833a6b455e84b965ef4';
const PRODUCTION_SESSIONS = new WeakSet(), TEST_SESSIONS = new WeakSet();
const PRODUCTION_ADMISSIONS = new WeakSet(), TEST_ADMISSIONS = new WeakSet();
const PRODUCTION_ADMISSION_BASELINES = new WeakMap();

function fail(code) { throw Object.assign(new Error(code), { code }); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function iso(value) {
  const date = Date.parse(value);
  return typeof value === 'string' && Number.isFinite(date) && new Date(date).toISOString() === value;
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const BASE_TEXT = readFileSync(BASE_PATH, 'utf8').replace(/\r\n/gu, '\n');
if (hash(Buffer.from(BASE_TEXT)) !== PINNED_BASE_BYTES_SHA256) fail('preservation_v2_base_unpinned');
export const BASE = deepFreeze(JSON.parse(BASE_TEXT));
export const BASE_SHA256 = PINNED_BASE_BYTES_SHA256;
function checkBase(base) {
  if (!exactKeys(base, ['schemaVersion', 'purpose', 'status', 'observedAt', 'accountId', 'provenance', 'controls', 'databases',
    'applicationSchemaReady', 'executesDdl', 'authorizesMigration', 'authorizesFeatureActivation'])
    || base.schemaVersion !== 2 || base.purpose !== 'installed-schema-preservation-base'
    || base.status !== 'review-candidate-not-release-authority' || base.accountId !== ACCOUNT_ID
    || base.observedAt !== INSTALLED_SCHEMA_PRESERVATION_V2_BASE_PINS.observedAt
    || !exactKeys(base.controls, ['canonicalInstalledProfileV5Sha256'])
    || base.controls.canonicalInstalledProfileV5Sha256 !== CANONICAL_INSTALLED_PROFILE_V5_SHA256
    || base.applicationSchemaReady !== false || base.executesDdl !== false || base.authorizesMigration !== false
    || base.authorizesFeatureActivation !== false || !exactKeys(base.databases, APP_NAMES)) fail('preservation_v2_base_unpinned');
  for (const app of APP_NAMES) {
    const db = base.databases[app], pin = INSTALLED_SCHEMA_PRESERVATION_V2_BASE_PINS[app];
    if (!exactKeys(db, ['databaseId', 'ledgerCount', 'highestInstalledName', 'orderedLedgerSha256', 'schema', 'orderedLedger'])
      || db.databaseId !== pin.databaseId || !Array.isArray(db.orderedLedger) || db.ledgerCount !== pin.ledgerCount
      || db.orderedLedger.length !== pin.ledgerCount
      || hash(Buffer.from(JSON.stringify(db.orderedLedger))) !== pin.orderedLedgerSha256
      || db.orderedLedgerSha256 !== pin.orderedLedgerSha256
      || db.highestInstalledName !== pin.highestInstalledName
      || db.orderedLedger.map(row => row.name).sort().at(-1) !== pin.highestInstalledName
      || !exactKeys(db.schema, ['objectCount', 'objectsSha256']) || db.schema.objectCount !== pin.objectCount
      || db.schema.objectsSha256 !== pin.objectsSha256) fail('preservation_v2_base_unpinned');
  }
  return base;
}
checkBase(BASE);

/** Migration file names (not bytes) in the exact source commit, per production database. */
export function readSourceMigrationNames(sourceCommit) {
  if (!COMMIT.test(sourceCommit ?? '')) fail('preservation_source_commit_invalid');
  let tree;
  try {
    tree = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', sourceCommit, '--',
      'apps/operations/migrations', 'apps/client/migrations'], { cwd: ROOT, encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true });
  } catch { fail('preservation_git_source_unavailable'); }
  const names = { operations: [], client: [] };
  for (const line of tree.split('\0').filter(Boolean)) {
    const match = /^100644 blob [a-f0-9]{40}\t(apps\/(operations|client)\/migrations\/([^/]+))$/u.exec(line);
    if (!match || !match[3].endsWith('.sql')) fail('preservation_source_tree_invalid');
    names[match[2]].push(match[3]);
  }
  for (const app of APP_NAMES) {
    names[app].sort();
    if (new Set(names[app]).size !== names[app].length) fail('preservation_source_tree_invalid');
  }
  return Object.freeze({ operations: Object.freeze(names.operations), client: Object.freeze(names.client) });
}

/** Pure check of one fresh metadata read and the exact source names against the pinned base. */
export function validateInstalledSchemaPreservationV2({ evidence, sourceCommit, sourceNames, now = Date.now(),
  maxAgeMs = MAX_RELEASE_EVIDENCE_AGE_MS } = {}) {
  checkBase(BASE);
  if (!exactKeys(evidence, ['schemaVersion', 'purpose', 'accountId', 'observedAt', 'readOnly', 'executesDdl', 'databases'])
    || evidence.schemaVersion !== 1 || evidence.purpose !== 'installed-schema-preservation-metadata-evidence'
    || evidence.accountId !== ACCOUNT_ID || !iso(evidence.observedAt) || !Number.isFinite(now)
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || Date.parse(evidence.observedAt) > now
    || now - Date.parse(evidence.observedAt) > maxAgeMs || evidence.readOnly !== true || evidence.executesDdl !== false
    || !COMMIT.test(sourceCommit ?? '') || !exactKeys(evidence.databases, APP_NAMES)
    || !exactKeys(sourceNames, APP_NAMES)) fail('preservation_evidence_invalid');
  const results = {};
  for (const app of APP_NAMES) {
    const row = evidence.databases[app], base = BASE.databases[app], names = sourceNames[app];
    if (!exactKeys(row, ['databaseId', 'ledger', 'schema']) || row.databaseId !== base.databaseId
      || !Array.isArray(row.ledger) || !isRecord(row.schema) || !Array.isArray(names)
      || names.some(name => typeof name !== 'string' || !name.endsWith('.sql'))
      || new Set(names).size !== names.length) fail('preservation_evidence_invalid');
    const ledger = row.ledger.map(item => {
      if (!exactKeys(item, ['name', 'id']) || typeof item.name !== 'string' || !Number.isSafeInteger(item.id) || item.id < 1)
        fail('preservation_ledger_row_invalid');
      return { name: item.name, id: item.id };
    });
    if (!sameJson(ledger, base.orderedLedger) || hash(Buffer.from(JSON.stringify(ledger))) !== base.orderedLedgerSha256)
      fail('preservation_v2_ledger_drift');
    const schema = Array.isArray(row.schema.rows) ? summarizeInstalledSchema(row.schema.rows) : row.schema;
    if (!exactKeys(schema, ['objectCount', 'objectsSha256', 'cloudflareInternalRows'])
      || !Number.isSafeInteger(schema.objectCount) || !SHA256.test(schema.objectsSha256 ?? '')
      || !Number.isSafeInteger(schema.cloudflareInternalRows) || schema.cloudflareInternalRows < 0)
      fail('preservation_evidence_invalid');
    if (schema.objectCount !== base.schema.objectCount || schema.objectsSha256 !== base.schema.objectsSha256)
      fail('preservation_v2_schema_drift');
    const installed = new Set(ledger.map(item => item.name));
    const pending = [...names].sort().filter(name => !installed.has(name));
    results[app] = { pending, outOfOrder: pending.filter(name => name <= base.highestInstalledName) };
  }
  if (APP_NAMES.some(app => results[app].outOfOrder.length)) fail('migration_out_of_order_pending');
  if (APP_NAMES.some(app => results[app].pending.length)) fail('migration_required_pending');
  return Object.freeze({ schemaVersion: 2, purpose: 'installed-schema-preservation-v2', status: 'installed-schema-preserved-v2',
    accountId: ACCOUNT_ID, sourceCommit, observedAt: evidence.observedAt, baseSha256: BASE_SHA256,
    databases: Object.freeze(Object.fromEntries(APP_NAMES.map(app => [app, Object.freeze({
      databaseId: BASE.databases[app].databaseId, ledgerCount: BASE.databases[app].ledgerCount,
      orderedLedgerSha256: BASE.databases[app].orderedLedgerSha256,
      schemaObjectCount: BASE.databases[app].schema.objectCount,
      schemaObjectsSha256: BASE.databases[app].schema.objectsSha256, pendingSourceNames: Object.freeze([]) })]))),
    applicationSchemaReady: false, executesDdl: false, authorizesMigration: false, authorizesFeatureActivation: false });
}

function protectedControlsFingerprint(snapshot, { assetAssociationOverrides = {} } = {}) {
  const projection = {};
  for (const app of Object.keys(snapshot).sort()) {
    const state = snapshot[app];
    projection[app] = {
      settings: Object.fromEntries(Object.entries(state.settings).filter(([key]) => !['bindings', 'annotations'].includes(key))),
      resources: resourcesShape(state.version.resources),
      varsSha256: sha256Hex(canonical(varsOf(state))),
      crons: state.schedules.schedules.map(row => row.cron).sort(),
      assetsSha256: sha256Hex(canonical(Object.hasOwn(assetAssociationOverrides, app)
        ? assetAssociationOverrides[app] : state.modern.assets ?? null)),
    };
  }
  return sha256Hex(canonical(projection));
}
function checkCanonicalV5Profile(profile) {
  if (!isRecord(profile) || sha256Hex(canonical(profile)) !== CANONICAL_INSTALLED_PROFILE_V5_SHA256) fail('preservation_v5_profile_unpinned');
}
function validateCanonicalCapture(snapshot, { profile, selectedApp, allowLatest = {}, expectedDeploymentVersions = {},
  assetAssociationOverrides = {} }) {
  if (!['operations', 'client', 'ops-sync'].includes(selectedApp)) fail('preservation_selected_app_invalid');
  return validateInstallation(snapshot, { profile, selectedApp, allowLatest, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE, ordinaryFrontendApp: selectedApp,
    assetAssociationOverrides });
}
function checkFreshOperation(startMono, finishMono, captureWall, metadata, finishWall) {
  if (finishMono < startMono || finishMono - startMono > MAX_RELEASE_EVIDENCE_AGE_MS
    || !Number.isFinite(captureWall) || captureWall > finishWall || finishWall - captureWall > MAX_RELEASE_EVIDENCE_AGE_MS
    || !iso(metadata.observedAt) || Date.parse(metadata.observedAt) > finishWall
    || finishWall - Date.parse(metadata.observedAt) > MAX_RELEASE_EVIDENCE_AGE_MS) fail('preservation_capture_or_metadata_stale');
}
function ensureOptions(options, allowedKeys) {
  if (!isRecord(options) || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !allowedKeys.includes(key)))
    fail('preservation_session_options_invalid');
}

async function createSessionCore({ sourceCommit, canonicalV5Profile, selectedApp, token, baselineAllowLatest = {},
  baselineExpectedDeploymentVersions = {}, allowAssetAssociationRotation = false, allowUnselectedRecapture = true,
  fetchImpl = fetch, testOnly = false, clock, sourceNamesReader = readSourceMigrationNames } = {}) {
  checkBase(BASE);
  checkCanonicalV5Profile(canonicalV5Profile);
  if (!COMMIT.test(sourceCommit ?? '') || !['operations', 'client', 'ops-sync'].includes(selectedApp)
    || typeof token !== 'string' || !/^[\x21-\x7e]{20,16384}$/u.test(token)
    || typeof fetchImpl !== 'function' || typeof allowAssetAssociationRotation !== 'boolean'
    || typeof allowUnselectedRecapture !== 'boolean' || !isRecord(baselineAllowLatest)
    || (allowAssetAssociationRotation && !['operations', 'client'].includes(selectedApp))) fail('preservation_session_target_invalid');
  if (testOnly && (!clock || typeof clock.wallNow !== 'function' || typeof clock.monotonicNow !== 'function'))
    fail('preservation_test_clock_invalid');
  const wallNow = testOnly ? clock.wallNow : () => Date.now();
  const monoNow = testOnly ? clock.monotonicNow : () => performance.now();
  const sourceNames = sourceNamesReader(sourceCommit);
  const reader = new CloudflareReader(ACCOUNT_ID, token, fetchImpl);
  const startMono = monoNow();
  const baselineSnapshot = await capture(reader, { selectedApp, expectedDeploymentVersions: baselineExpectedDeploymentVersions,
    allowUnselectedRecapture });
  const baselineCaptureWall = wallNow();
  const baselineEvidence = await readInstalledSchemaPreservationMetadata({ token, fetchImpl, now: () => new Date(wallNow()) });
  const baselineFinishMono = monoNow(), baselineFinishWall = wallNow();
  checkFreshOperation(startMono, baselineFinishMono, baselineCaptureWall, baselineEvidence, baselineFinishWall);
  validateInstalledSchemaPreservationV2({ evidence: baselineEvidence, sourceCommit, sourceNames, now: baselineFinishWall });
  const checkedBaseline = validateCanonicalCapture(baselineSnapshot, { profile: canonicalV5Profile, selectedApp,
    allowLatest: baselineAllowLatest, expectedDeploymentVersions: baselineExpectedDeploymentVersions });
  const baselineControlsSha256 = protectedControlsFingerprint(checkedBaseline);
  const baselineMonotonic = startMono;
  let busy = false, closed = false;
  const session = Object.freeze({
    accountId: ACCOUNT_ID, sourceCommit, selectedApp,
    async observe(observeOptions = {}) {
      ensureOptions(observeOptions, ['allowLatest', 'expectedDeploymentVersions']);
      const { allowLatest = {}, expectedDeploymentVersions = {} } = observeOptions;
      if (closed || busy) fail('preservation_session_closed_or_busy');
      if (monoNow() - baselineMonotonic > MAX_SAME_RUN_BASELINE_AGE_MS) {
        closed = true; reader.token = ''; fail('preservation_same_run_baseline_expired');
      }
      busy = true;
      try {
        const observeStartMono = monoNow();
        const currentSnapshot = await capture(reader, { selectedApp, expectedDeploymentVersions, allowUnselectedRecapture });
        const currentCaptureWall = wallNow();
        const currentEvidence = await readInstalledSchemaPreservationMetadata({ token: reader.token, fetchImpl,
          now: () => new Date(wallNow()) });
        const finishMono = monoNow(), finishWall = wallNow();
        checkFreshOperation(observeStartMono, finishMono, currentCaptureWall, currentEvidence, finishWall);
        const classification = validateInstalledSchemaPreservationV2({ evidence: currentEvidence, sourceCommit, sourceNames,
          now: finishWall });
        const rotation = allowAssetAssociationRotation ? { [selectedApp]: baselineSnapshot[selectedApp].modern.assets } : null;
        const checkedCurrent = validateCanonicalCapture(currentSnapshot, { profile: canonicalV5Profile, selectedApp,
          allowLatest, expectedDeploymentVersions,
          ...(rotation ? { assetAssociationOverrides: { [selectedApp]: { baselineAssets: rotation[selectedApp] } } } : {}) });
        const currentControlsSha256 = protectedControlsFingerprint(checkedCurrent,
          rotation ? { assetAssociationOverrides: rotation } : {});
        if (currentControlsSha256 !== baselineControlsSha256) fail('preservation_protected_controls_changed');
        const receipt = Object.freeze({ schemaVersion: 2, purpose: 'installed-schema-preservation-v2-same-run-observation',
          status: 'preserved-installed-schema-v2', accountId: ACCOUNT_ID, sourceCommit, selectedApp, baseSha256: BASE_SHA256,
          canonicalV5ProfileSha256: CANONICAL_INSTALLED_PROFILE_V5_SHA256,
          baselineObservedAt: baselineEvidence.observedAt, currentCaptureObservedAt: new Date(currentCaptureWall).toISOString(),
          observedAt: classification.observedAt, baselineAgeMs: Math.floor(finishMono - baselineMonotonic),
          baselineProtectedControlsSha256: baselineControlsSha256, currentProtectedControlsSha256: currentControlsSha256,
          applicationSchemaReady: false, executesDdl: false, authorizesMigration: false, authorizesFeatureActivation: false,
          ...(testOnly ? { testOnly: true } : { offlineOnly: false }) });
        (testOnly ? TEST_ADMISSIONS : PRODUCTION_ADMISSIONS).add(receipt);
        if (!testOnly) PRODUCTION_ADMISSION_BASELINES.set(receipt, baselineMonotonic);
        return receipt;
      } catch (error) {
        closed = true; reader.token = '';
        throw error;
      } finally { busy = false; }
    },
    close() { if (!closed) { closed = true; reader.token = ''; } },
  });
  (testOnly ? TEST_SESSIONS : PRODUCTION_SESSIONS).add(session);
  return session;
}

const PRODUCTION_FACTORY_KEYS = Object.freeze(['sourceCommit', 'canonicalV5Profile', 'selectedApp', 'token',
  'baselineAllowLatest', 'baselineExpectedDeploymentVersions', 'allowAssetAssociationRotation', 'allowUnselectedRecapture', 'fetchImpl']);

export async function createInstalledSchemaPreservationV2Session(options = {}) {
  ensureOptions(options, PRODUCTION_FACTORY_KEYS);
  if (Object.hasOwn(options, 'fetchImpl') && options.fetchImpl !== globalThis.fetch
    && !isNativeProductionCloudflareTransport(options.fetchImpl, ACCOUNT_ID)) fail('preservation_production_transport_untrusted');
  return createSessionCore(options);
}
/** Explicit fake-HTTP boundary for tests; its sessions and receipts never count as production admission. */
export async function createInstalledSchemaPreservationV2TestSession(options = {}) {
  ensureOptions(options, [...PRODUCTION_FACTORY_KEYS, 'clock', 'sourceNamesReader']);
  if (typeof options.fetchImpl !== 'function') fail('preservation_test_fetch_required');
  return createSessionCore({ ...options, testOnly: true });
}
export function isProductionInstalledSchemaPreservationV2Session(value) { return PRODUCTION_SESSIONS.has(value); }
export function isProductionInstalledSchemaPreservationV2Admission(value) {
  const baselineAge = performance.now() - PRODUCTION_ADMISSION_BASELINES.get(value);
  return PRODUCTION_ADMISSIONS.has(value) && value.accountId === ACCOUNT_ID && value.baseSha256 === BASE_SHA256
    && iso(value.observedAt) && Date.now() >= Date.parse(value.observedAt)
    && Date.now() - Date.parse(value.observedAt) <= MAX_RELEASE_EVIDENCE_AGE_MS
    && Number.isSafeInteger(value.baselineAgeMs) && value.baselineAgeMs >= 0 && value.baselineAgeMs <= MAX_SAME_RUN_BASELINE_AGE_MS
    && Number.isFinite(baselineAge) && baselineAge >= 0 && baselineAge <= MAX_SAME_RUN_BASELINE_AGE_MS;
}
export function isTestInstalledSchemaPreservationV2Admission(value) { return TEST_ADMISSIONS.has(value); }
