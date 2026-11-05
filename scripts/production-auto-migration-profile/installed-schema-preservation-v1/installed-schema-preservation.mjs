import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, hash as sha256Hex, resourcesShape, varsOf, validateInstallation,
  CloudflareReader, capture, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, CANONICAL_INSTALLED_PROFILE_V4_SHA256 }
  from '../../production-deploy.mjs';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_PATH = new URL('./profile.json', import.meta.url);
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export const PROFILE = deepFreeze(JSON.parse(readFileSync(PROFILE_PATH, 'utf8')));
export const ACCOUNT_ID = '846c924bf17bf4f3dd15c97a4c5d1d51';
export const SOURCE_COMMIT = '2686c535658398baf746b78a41e8af6b79f04538';
export const PRODUCTION_DATABASES = Object.freeze({
  operations: '6ebf7514-d306-4615-ae56-ad869c874dbd',
  client: '7f40a7b7-c3ec-470e-a626-e798867f71f8',
});
export const LEDGER_SQL = 'SELECT name,id FROM d1_migrations ORDER BY id LIMIT 1025';
export const SCHEMA_SQL = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 5001";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const APP_NAMES = Object.freeze(['operations', 'client']);
const MAX_QUERY_BYTES = 12 * 1024 * 1024;
const MAX_QUERY_ROWS = 5_001;
const MAX_RELEASE_EVIDENCE_AGE_MS = 60_000;
const MAX_SAME_RUN_BASELINE_AGE_MS = 45 * 60_000;
const PRODUCTION_SESSIONS = new WeakSet();
const TEST_SESSIONS = new WeakSet();
const PRODUCTION_ADMISSIONS = new WeakSet();
const TEST_ADMISSIONS = new WeakSet();

function fail(code) { throw Object.assign(new Error(code), { code }); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function gitBlobOid(bytes) {
  return createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`, 'ascii')).update(bytes).digest('hex');
}
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

function protectedControlsFingerprint(snapshot, { assetAssociationOverrides = {} } = {}) {
  const apps = Object.keys(snapshot).sort();
  const projection = {};
  for (const app of apps) {
    const state = snapshot[app];
    const settings = Object.fromEntries(Object.entries(state.settings).filter(([key]) => !['bindings', 'annotations'].includes(key)));
    const vars = varsOf(state);
    projection[app] = {
      settings,
      resources: resourcesShape(state.version.resources),
      varsSha256: sha256Hex(canonical(vars)),
      crons: state.schedules.schedules.map(row => row.cron).sort(),
      assetsSha256: sha256Hex(canonical(Object.hasOwn(assetAssociationOverrides, app)
        ? assetAssociationOverrides[app] : state.modern.assets ?? null)),
    };
  }
  return sha256Hex(canonical(projection));
}
export function installedSchemaProtectedControlsFingerprint(snapshot, options = {}) {
  if (!exactKeys(options, ['selectedApp', 'baselineAssets'])
    || !['operations', 'client'].includes(options.selectedApp) || !isRecord(options.baselineAssets)) {
    fail('preservation_fingerprint_override_invalid');
  }
  return protectedControlsFingerprint(snapshot, { assetAssociationOverrides: {
    [options.selectedApp]: options.baselineAssets,
  } });
}
function profileIsPinned(profile) {
  if (!sameJson(profile, PROFILE) || profile.schemaVersion !== 1
    || profile.purpose !== 'installed-schema-preservation-with-pending-source-migrations'
    || profile.status !== 'review-candidate-not-release-authority'
    || profile.accountId !== ACCOUNT_ID || profile.source?.commit !== SOURCE_COMMIT
    || profile.controls?.canonicalInstalledProfileV4Sha256 !== CANONICAL_INSTALLED_PROFILE_V4_SHA256
    || profile.applicationSchemaReady !== false || profile.executesDdl !== false
    || profile.authorizesMigration !== false || profile.authorizesFeatureActivation !== false) fail('preservation_profile_unpinned');
  for (const app of APP_NAMES) {
    const db = profile.databases?.[app], exception = profile.preservedExceptions?.[app];
    if (!db || !Array.isArray(db.orderedLedger) || !Array.isArray(db.sourceInventory)
      || !Array.isArray(db.pendingSourceNames) || db.allSourceMigrationsInstalled !== false
      || hash(Buffer.from(JSON.stringify(db.orderedLedger))) !== db.orderedLedgerSha256
      || hash(Buffer.from(JSON.stringify(db.sourceInventory))) !== db.sourceInventorySha256
      || !exception || db.orderedLedger[exception.ledgerId - 1]?.name !== exception.migration
      || db.orderedLedger[exception.ledgerId - 1]?.id !== exception.ledgerId) fail('preservation_profile_unpinned');
    const target = db.sourceInventory.find(row => row.name === exception.migration);
    const ledgerNames = new Set(db.orderedLedger.map(row => row.name));
    const pending = db.sourceInventory.filter(row => !ledgerNames.has(row.name)).map(row => row.name);
    if (!target || target.sha256 !== exception.knownTargetSha256 || !sameJson(pending, db.pendingSourceNames)
      || !sameJson(pending, exception.sourcePending)) fail('preservation_profile_exception_unpinned');
  }
  return profile;
}

function checkedSourceRows(sourceRows, sourceFiles, profile, sourceCommit) {
  if (!COMMIT.test(sourceCommit ?? '') || !isRecord(sourceRows) || !isRecord(sourceFiles)) fail('preservation_source_invalid');
  for (const app of APP_NAMES) {
    const expected = profile.databases[app].sourceInventory;
    const rows = sourceRows[app], files = sourceFiles[app];
    if (!Array.isArray(rows) || !sameJson(rows, expected) || !Array.isArray(files) || files.length !== expected.length) {
      fail(`preservation_${app}_source_inventory_mismatch`);
    }
    const fileMap = new Map();
    for (const file of files) {
      if (!exactKeys(file, ['name', 'bytes']) || typeof file.name !== 'string' || !Buffer.isBuffer(file.bytes)
        || file.bytes.length < 1 || fileMap.has(file.name)) fail('preservation_source_file_invalid');
      fileMap.set(file.name, file.bytes);
    }
    for (const row of expected) {
      const bytes = fileMap.get(row.name);
      if (!bytes || hash(bytes) !== row.sha256 || gitBlobOid(bytes) !== row.gitBlobOid) {
        fail(`preservation_${app}_source_bytes_mismatch`);
      }
    }
  }
  if (!sameJson(Object.keys(sourceRows).sort(), APP_NAMES.slice().sort())
    || !sameJson(Object.keys(sourceFiles).sort(), APP_NAMES.slice().sort())) fail('preservation_source_apps_mismatch');
  return Object.freeze(Object.fromEntries(APP_NAMES.map(app => [app, Object.freeze({
    sourceInventoryCount: sourceRows[app].length,
    sourceInventorySha256: hash(Buffer.from(JSON.stringify(sourceRows[app]))),
  })])));
}

export function summarizeInstalledSchema(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_QUERY_ROWS) fail('preservation_schema_rows_invalid');
  const names = new Set();
  const applicationRows = [];
  let cloudflareInternalRows = 0;
  for (const row of rows) {
    if (!exactKeys(row, ['type', 'name', 'tbl_name', 'sql']) || !['table', 'index', 'trigger', 'view'].includes(row.type)
      || typeof row.name !== 'string' || !row.name || typeof row.tbl_name !== 'string' || !row.tbl_name
      || typeof row.sql !== 'string' || row.name.startsWith('sqlite_') || names.has(row.name)) fail('preservation_schema_row_invalid');
    names.add(row.name);
    if (row.name.startsWith('_cf_')) cloudflareInternalRows++;
    else applicationRows.push({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql });
  }
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1], current = rows[index];
    if (previous.type > current.type || (previous.type === current.type && previous.name > current.name)) {
      fail('preservation_schema_order_invalid');
    }
  }
  return Object.freeze({ objectCount: applicationRows.length,
    objectsSha256: hash(Buffer.from(JSON.stringify(applicationRows))), cloudflareInternalRows });
}

function validateEvidence(evidence, { profile = PROFILE, sourceCommit, sourceRows, sourceFiles, now = Date.now(), maxAgeMs = 60_000 } = {}) {
  profileIsPinned(profile);
  if (!exactKeys(evidence, ['schemaVersion', 'purpose', 'accountId', 'observedAt', 'readOnly', 'executesDdl', 'databases'])
    || evidence.schemaVersion !== 1 || evidence.purpose !== 'installed-schema-preservation-metadata-evidence'
    || evidence.accountId !== ACCOUNT_ID || !iso(evidence.observedAt) || !Number.isFinite(now)
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || Date.parse(evidence.observedAt) > now
    || now - Date.parse(evidence.observedAt) > maxAgeMs || evidence.readOnly !== true || evidence.executesDdl !== false
    || !COMMIT.test(sourceCommit ?? '') || !exactKeys(evidence.databases, APP_NAMES)) fail('preservation_evidence_invalid');
  const sourceEvidence = checkedSourceRows(sourceRows, sourceFiles, profile, sourceCommit);
  const results = {};
  for (const app of APP_NAMES) {
    const row = evidence.databases[app], pinned = profile.databases[app];
    if (!exactKeys(row, ['databaseId', 'ledger', 'schema']) || row.databaseId !== PRODUCTION_DATABASES[app]
      || !Array.isArray(row.ledger) || !isRecord(row.schema)) fail(`preservation_${app}_evidence_invalid`);
    const ledger = row.ledger.map(item => {
      if (!exactKeys(item, ['name', 'id']) || typeof item.name !== 'string' || !Number.isSafeInteger(item.id) || item.id < 1) {
        fail('preservation_ledger_row_invalid');
      }
      return { name: item.name, id: item.id };
    });
    const schema = Array.isArray(row.schema.rows) ? summarizeInstalledSchema(row.schema.rows) : row.schema;
    if (!exactKeys(schema, ['objectCount', 'objectsSha256', 'cloudflareInternalRows'])
      || !Number.isSafeInteger(schema.objectCount) || !SHA256.test(schema.objectsSha256 ?? '')
      || !Number.isSafeInteger(schema.cloudflareInternalRows) || schema.cloudflareInternalRows < 0) {
      fail(`preservation_${app}_schema_evidence_invalid`);
    }
    if (!sameJson(ledger, pinned.orderedLedger) || hash(Buffer.from(JSON.stringify(ledger))) !== pinned.orderedLedgerSha256) {
      fail(`preservation_${app}_ledger_drift`);
    }
    if (schema.objectCount !== pinned.schema.objectCount || schema.objectsSha256 !== pinned.schema.objectsSha256) {
      fail(`preservation_${app}_schema_drift`);
    }
    const ledgerNames = new Set(ledger.map(item => item.name));
    const pending = sourceRows[app].filter(item => !ledgerNames.has(item.name)).map(item => item.name);
    if (sourceEvidence[app].sourceInventoryCount !== pinned.sourceInventoryCount) fail(`preservation_${app}_source_count_drift`);
    if (!sameJson(pending, pinned.pendingSourceNames)) fail(`preservation_${app}_pending_migration_drift`);
    results[app] = Object.freeze({ databaseId: row.databaseId, ledgerCount: ledger.length,
      orderedLedgerSha256: pinned.orderedLedgerSha256, sourceInventoryCount: sourceEvidence[app].sourceInventoryCount,
      sourceInventorySha256: sourceEvidence[app].sourceInventorySha256,
      pendingSourceNames: Object.freeze([...pending]), schemaObjectCount: schema.objectCount,
      schemaObjectsSha256: schema.objectsSha256, cloudflareInternalRowsObserved: schema.cloudflareInternalRows,
      allSourceMigrationsInstalled: false });
  }
  return Object.freeze({ schemaVersion: 1, purpose: 'installed-schema-preservation-with-pending-source-migrations',
    status: 'installed-schema-preserved-with-pending-source-migrations', accountId: ACCOUNT_ID,
    sourceCommit, profileSourceCommit: SOURCE_COMMIT,
    observedAt: evidence.observedAt, profileSha256: PROFILE_SHA256, databases: Object.freeze(results),
    allSourceMigrationsInstalled: false, applicationSchemaReady: false, executesDdl: false,
    authorizesMigration: false, authorizesFeatureActivation: false });
}

export function validateInstalledSchemaPreservation({ evidence, profile = PROFILE, sourceCommit,
  sourceRows, sourceFiles, now = Date.now(), maxAgeMs = 60_000 } = {}) {
  return validateEvidence(evidence, { profile, sourceCommit, sourceRows, sourceFiles, now, maxAgeMs });
}

function gitOutput(args, input) {
  try { return execFileSync('git', args, { cwd: ROOT, input, encoding: null, maxBuffer: 100 * 1024 * 1024,
    timeout: 30_000, windowsHide: true }); }
  catch { fail('preservation_git_source_unavailable'); }
}

export function readSourceMigrationInventory(sourceCommit) {
  profileIsPinned(PROFILE);
  if (!COMMIT.test(sourceCommit ?? '')) fail('preservation_source_commit_invalid');
  const tree = gitOutput(['ls-tree', '-r', '-z', '--full-tree', sourceCommit, '--',
    'apps/operations/migrations', 'apps/client/migrations']).toString('utf8');
  const entries = tree.split('\0').filter(Boolean).map(line => {
    const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) fail('preservation_source_tree_invalid');
    const app = match[2].startsWith('apps/operations/migrations/') ? 'operations'
      : match[2].startsWith('apps/client/migrations/') ? 'client' : null;
    const name = path.posix.basename(match[2]);
    if (!app || !name.endsWith('.sql')) fail('preservation_source_tree_invalid');
    return { app, name, gitBlobOid: match[1] };
  }).sort((a, b) => a.app < b.app ? -1 : a.app > b.app ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const bytes = gitOutput(['cat-file', '--batch'], Buffer.from(entries.map(row => row.gitBlobOid).join('\n') + '\n'));
  let offset = 0;
  const rows = { operations: [], client: [] }, files = { operations: [], client: [] };
  for (const entry of entries) {
    const headerEnd = bytes.indexOf(10, offset);
    if (headerEnd < 0) fail('preservation_source_object_invalid');
    const [oid, kind, sizeText] = bytes.subarray(offset, headerEnd).toString('ascii').split(' ');
    const size = Number(sizeText), start = headerEnd + 1, end = start + size;
    if (oid !== entry.gitBlobOid || kind !== 'blob' || !Number.isSafeInteger(size) || size < 1
      || end >= bytes.length || bytes[end] !== 10) fail('preservation_source_object_invalid');
    const body = Buffer.from(bytes.subarray(start, end));
    rows[entry.app].push(Object.freeze({ name: entry.name, gitBlobOid: entry.gitBlobOid, sha256: hash(body) }));
    files[entry.app].push(Object.freeze({ name: entry.name, bytes: body }));
    offset = end + 1;
  }
  if (offset !== bytes.length) fail('preservation_source_object_trailing_bytes');
  return Object.freeze({ sourceCommit, rows: Object.freeze(rows), files: Object.freeze(files) });
}

async function boundedJson(response) {
  const encoding = response.headers?.get?.('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') fail('preservation_provider_encoding_invalid');
  const length = response.headers?.get?.('content-length');
  if (length !== null && length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_QUERY_BYTES)) {
    fail('preservation_provider_body_too_large');
  }
  if (!response.body?.getReader) fail('preservation_provider_body_missing');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_QUERY_BYTES) { void reader.cancel().catch(() => {}); fail('preservation_provider_body_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) { if (error?.code) throw error; fail('preservation_provider_body_read_failed'); }
  finally { try { reader.releaseLock(); } catch {} }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { fail('preservation_provider_json_invalid'); }
}

function queryResponseRows(payload, databaseId) {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.result) || payload.result.length !== 1) {
    fail('preservation_provider_envelope_invalid');
  }
  const result = payload.result[0];
  if (!isRecord(result) || result.success !== true || !Array.isArray(result.results) || !isRecord(result.meta)) {
    fail('preservation_provider_statement_invalid');
  }
  const meta = result.meta;
  const writeKeys = ['changes', 'rows_written', 'rowsWritten'];
  if (!writeKeys.some(key => Object.hasOwn(meta, key) || Object.hasOwn(meta, 'changed_db'))
    || writeKeys.some(key => Object.hasOwn(meta, key) && (!Number.isSafeInteger(meta[key]) || meta[key] !== 0))
    || meta.changed_db === true || (Object.hasOwn(meta, 'changed_db') && typeof meta.changed_db !== 'boolean')) {
    fail('preservation_provider_write_metadata_invalid');
  }
  const ids = [result.database_id, result.databaseId, result.uuid,
    meta.database_id, meta.databaseId, meta.uuid].filter(value => value !== undefined);
  if (ids.some(value => typeof value !== 'string' || value.toLowerCase() !== databaseId)) fail('preservation_provider_database_mismatch');
  return result.results;
}

async function readQuery({ token, fetchImpl, databaseId, sql }) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{16,16384}$/u.test(token)
    || typeof fetchImpl !== 'function' || !Object.values(PRODUCTION_DATABASES).includes(databaseId)) fail('preservation_provider_input_invalid');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${databaseId}/query`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params: [] }),
    });
    if (!response?.ok || response.redirected || (response.status >= 300 && response.status < 400)) fail('preservation_provider_http_failure');
    const payload = await boundedJson(response);
    return queryResponseRows(payload, databaseId);
  } catch (error) { if (error?.code) throw error; fail('preservation_provider_request_failed'); }
  finally { clearTimeout(timer); }
}

export async function readInstalledSchemaPreservationMetadata({ token, fetchImpl = fetch, now = () => new Date() } = {}) {
  const databases = {};
  for (const app of APP_NAMES) {
    const databaseId = PRODUCTION_DATABASES[app];
    const ledger = await readQuery({ token, fetchImpl, databaseId, sql: LEDGER_SQL });
    const schemaRows = await readQuery({ token, fetchImpl, databaseId, sql: SCHEMA_SQL });
    const checkedLedger = ledger.map(row => {
      if (!exactKeys(row, ['name', 'id']) || typeof row.name !== 'string' || !Number.isSafeInteger(row.id) || row.id < 1) fail('preservation_provider_ledger_invalid');
      return { name: row.name, id: row.id };
    });
    const schema = summarizeInstalledSchema(schemaRows);
    databases[app] = Object.freeze({ databaseId, ledger: Object.freeze(checkedLedger), schema });
  }
  const observedAt = now().toISOString();
  return Object.freeze({ schemaVersion: 1, purpose: 'installed-schema-preservation-metadata-evidence', accountId: ACCOUNT_ID,
    observedAt, readOnly: true, executesDdl: false, databases: Object.freeze(databases) });
}

function checkCanonicalV4Profile(profile) {
  if (!isRecord(profile) || sha256Hex(canonical(profile)) !== CANONICAL_INSTALLED_PROFILE_V4_SHA256) {
    fail('preservation_v4_profile_unpinned');
  }
}

function validateCanonicalCapture(snapshot, { profile, selectedApp, allowLatest = {}, expectedDeploymentVersions = {},
  assetAssociationOverrides = {}, opsSuccessorReaderContract, opsSuccessorReaderReleaseCandidateId }) {
  if (!['operations', 'client', 'ops-sync'].includes(selectedApp)) fail('preservation_selected_app_invalid');
  return validateInstallation(snapshot, { profile, selectedApp, allowLatest, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
    ordinaryFrontendApp: selectedApp, assetAssociationOverrides,
    opsSuccessorReaderContract, opsSuccessorReaderReleaseCandidateId });
}

function checkClassificationFresh(classification, sourceCommit, profile, now) {
  if (!exactKeys(classification, ['schemaVersion', 'purpose', 'status', 'sourceCommit', 'profileSourceCommit', 'observedAt',
    'accountId', 'profileSha256', 'databases', 'allSourceMigrationsInstalled', 'applicationSchemaReady', 'executesDdl',
    'authorizesMigration', 'authorizesFeatureActivation'])
    || classification.schemaVersion !== 1 || classification.purpose !== 'installed-schema-preservation-with-pending-source-migrations'
    || classification.status !== 'installed-schema-preserved-with-pending-source-migrations'
    || classification.sourceCommit !== sourceCommit || !COMMIT.test(sourceCommit ?? '')
    || classification.accountId !== ACCOUNT_ID || !iso(classification.observedAt) || !Number.isFinite(now)
    || Date.parse(classification.observedAt) > now || now - Date.parse(classification.observedAt) > MAX_RELEASE_EVIDENCE_AGE_MS
    || classification.profileSourceCommit !== SOURCE_COMMIT || classification.profileSha256 !== PROFILE_SHA256
    || classification.allSourceMigrationsInstalled !== false || classification.applicationSchemaReady !== false
    || classification.executesDdl !== false || classification.authorizesMigration !== false
    || classification.authorizesFeatureActivation !== false || !exactKeys(classification.databases, APP_NAMES)) {
    fail('preservation_current_evidence_stale_or_invalid');
  }
  for (const app of APP_NAMES) {
    const db = classification.databases[app], expected = PROFILE.databases[app];
    if (!exactKeys(db, ['databaseId', 'ledgerCount', 'orderedLedgerSha256', 'sourceInventoryCount',
      'sourceInventorySha256', 'pendingSourceNames', 'schemaObjectCount', 'schemaObjectsSha256',
      'cloudflareInternalRowsObserved', 'allSourceMigrationsInstalled'])
      || db.databaseId !== expected.databaseId || db.ledgerCount !== expected.ledgerCount
      || db.orderedLedgerSha256 !== expected.orderedLedgerSha256 || db.sourceInventoryCount !== expected.sourceInventoryCount
      || db.sourceInventorySha256 !== expected.sourceInventorySha256 || !sameJson(db.pendingSourceNames, expected.pendingSourceNames)
      || db.schemaObjectCount !== expected.schema.objectCount || db.schemaObjectsSha256 !== expected.schema.objectsSha256
      || !Number.isSafeInteger(db.cloudflareInternalRowsObserved) || db.cloudflareInternalRowsObserved < 0
      || db.allSourceMigrationsInstalled !== false) fail('preservation_current_evidence_invalid');
  }
}

function checkFreshOperation(startMono, finishMono, captureWall, metadata, finishWall) {
  if (finishMono < startMono || finishMono - startMono > MAX_RELEASE_EVIDENCE_AGE_MS
    || !Number.isFinite(captureWall) || captureWall > finishWall || finishWall - captureWall > MAX_RELEASE_EVIDENCE_AGE_MS
    || !iso(metadata.observedAt) || Date.parse(metadata.observedAt) > finishWall
    || finishWall - Date.parse(metadata.observedAt) > MAX_RELEASE_EVIDENCE_AGE_MS) {
    fail('preservation_capture_or_metadata_stale');
  }
}

function ensureFactoryOptions(options, allowedKeys) {
  if (!isRecord(options) || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !allowedKeys.includes(key))) {
    fail('preservation_session_options_invalid');
  }
}

async function createSessionCore({ sourceCommit, canonicalV4Profile, selectedApp, token,
  baselineAllowLatest = {}, baselineExpectedDeploymentVersions = {}, opsSuccessorReaderContract,
  opsSuccessorReaderReleaseCandidateId, allowAssetAssociationRotation = false,
  fetchImpl = fetch, testOnly = false, clock,
  testHooks = {} } = {}) {
  profileIsPinned(PROFILE);
  checkCanonicalV4Profile(canonicalV4Profile);
  if (!COMMIT.test(sourceCommit ?? '') || !['operations', 'client', 'ops-sync'].includes(selectedApp)
    || typeof token !== 'string' || !/^[\x21-\x7e]{20,16384}$/u.test(token)
    || typeof fetchImpl !== 'function' || typeof allowAssetAssociationRotation !== 'boolean'
    || (allowAssetAssociationRotation && !['operations', 'client'].includes(selectedApp))) fail('preservation_session_target_invalid');
  const wallNow = testOnly ? clock.wallNow : () => Date.now();
  const monoNow = testOnly ? clock.monotonicNow : () => performance.now();
  if (testOnly && (!clock || typeof clock.wallNow !== 'function' || typeof clock.monotonicNow !== 'function')) {
    fail('preservation_test_clock_invalid');
  }
  const source = readSourceMigrationInventory(sourceCommit);
  const reader = new CloudflareReader(ACCOUNT_ID, token, fetchImpl);
  const startMono = monoNow();
  const baselineSnapshot = await capture(reader, { selectedApp, expectedDeploymentVersions: baselineExpectedDeploymentVersions });
  const baselineCaptureWall = wallNow();
  const baselineEvidence = await readInstalledSchemaPreservationMetadata({ token, fetchImpl,
    now: () => new Date(wallNow()) });
  const baselineEvidenceAfterHook = testOnly && typeof testHooks.afterMetadata === 'function'
    ? await testHooks.afterMetadata('baseline', baselineEvidence) ?? baselineEvidence : baselineEvidence;
  const baselineFinishMono = monoNow(), baselineFinishWall = wallNow();
  checkFreshOperation(startMono, baselineFinishMono, baselineCaptureWall, baselineEvidenceAfterHook, baselineFinishWall);
  const baselineClassification = validateInstalledSchemaPreservation({ evidence: baselineEvidenceAfterHook,
    sourceCommit, sourceRows: source.rows, sourceFiles: source.files, now: baselineFinishWall,
    maxAgeMs: MAX_RELEASE_EVIDENCE_AGE_MS });
  const checkedBaseline = validateCanonicalCapture(baselineSnapshot, { profile: canonicalV4Profile, selectedApp,
    allowLatest: baselineAllowLatest, expectedDeploymentVersions: baselineExpectedDeploymentVersions,
    opsSuccessorReaderContract, opsSuccessorReaderReleaseCandidateId });
  const baselineControlsSha256 = protectedControlsFingerprint(checkedBaseline);
  // Start the 45-minute session lifetime before the baseline GETs, so validation
  // or slow metadata reads cannot silently extend the original baseline age.
  const baselineMonotonic = startMono;
  let busy = false, closed = false;
  const session = Object.freeze({
    accountId: ACCOUNT_ID, sourceCommit, selectedApp,
    async observe(observeOptions = {}) {
      ensureFactoryOptions(observeOptions, ['allowLatest', 'expectedDeploymentVersions']);
      const { allowLatest = {}, expectedDeploymentVersions = {} } = observeOptions;
      if (closed || busy) fail('preservation_session_closed_or_busy');
      if (monoNow() - baselineMonotonic > MAX_SAME_RUN_BASELINE_AGE_MS) {
        closed = true; reader.token = ''; fail('preservation_same_run_baseline_expired');
      }
      busy = true;
      try {
        const observeStartMono = monoNow();
        const currentSnapshot = await capture(reader, { selectedApp, expectedDeploymentVersions });
        const currentCaptureWall = wallNow();
        const currentEvidence = await readInstalledSchemaPreservationMetadata({ token: reader.token, fetchImpl,
          now: () => new Date(wallNow()) });
        const evidenceAfterHook = testOnly && typeof testHooks.afterMetadata === 'function'
          ? await testHooks.afterMetadata('current', currentEvidence) ?? currentEvidence : currentEvidence;
        const finishMono = monoNow(), finishWall = wallNow();
        checkFreshOperation(observeStartMono, finishMono, currentCaptureWall, evidenceAfterHook, finishWall);
        const classification = validateInstalledSchemaPreservation({ evidence: evidenceAfterHook,
          sourceCommit, sourceRows: source.rows, sourceFiles: source.files, now: finishWall,
          maxAgeMs: MAX_RELEASE_EVIDENCE_AGE_MS });
        checkClassificationFresh(classification, sourceCommit, canonicalV4Profile, finishWall);
        const checkedCurrent = validateCanonicalCapture(currentSnapshot, { profile: canonicalV4Profile, selectedApp,
          allowLatest, expectedDeploymentVersions,
          ...(allowAssetAssociationRotation ? { assetAssociationOverrides: { [selectedApp]: {
            baselineAssets: baselineSnapshot[selectedApp].modern.assets } } } : {}),
          opsSuccessorReaderContract, opsSuccessorReaderReleaseCandidateId });
        const currentControlsSha256 = protectedControlsFingerprint(checkedCurrent, allowAssetAssociationRotation
          ? { assetAssociationOverrides: { [selectedApp]: baselineSnapshot[selectedApp].modern.assets } } : {});
        if (currentControlsSha256 !== baselineControlsSha256) fail('preservation_protected_controls_changed');
        const receipt = Object.freeze({ schemaVersion: 1, purpose: 'installed-schema-preservation-same-run-observation',
          status: 'preserved-installed-schema-with-pending-source-migrations', accountId: ACCOUNT_ID,
          sourceCommit, selectedApp, profileSha256: PROFILE_SHA256,
          canonicalV4ProfileSha256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
          baselineObservedAt: baselineEvidence.observedAt, currentCaptureObservedAt: new Date(currentCaptureWall).toISOString(),
          observedAt: classification.observedAt, baselineAgeMs: Math.floor(finishMono - baselineMonotonic),
          baselineProtectedControlsSha256: baselineControlsSha256,
          currentProtectedControlsSha256: currentControlsSha256,
          allSourceMigrationsInstalled: false, applicationSchemaReady: false, executesDdl: false,
          authorizesMigration: false, authorizesFeatureActivation: false,
          ...(testOnly ? { testOnly: true } : { offlineOnly: false }) });
        (testOnly ? TEST_ADMISSIONS : PRODUCTION_ADMISSIONS).add(receipt);
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

const PRODUCTION_FACTORY_KEYS = Object.freeze(['sourceCommit', 'canonicalV4Profile', 'selectedApp', 'token',
  'baselineAllowLatest', 'baselineExpectedDeploymentVersions', 'allowAssetAssociationRotation',
  'opsSuccessorReaderContract', 'opsSuccessorReaderReleaseCandidateId']);

export async function createInstalledSchemaPreservationSession(options = {}) {
  ensureFactoryOptions(options, PRODUCTION_FACTORY_KEYS);
  return createSessionCore(options);
}

/** Explicit fake-HTTP boundary for tests; its session and receipts cannot create production admission evidence. */
export async function createInstalledSchemaPreservationTestSession(options = {}) {
  ensureFactoryOptions(options, [...PRODUCTION_FACTORY_KEYS, 'fetchImpl', 'clock', 'testHooks']);
  if (typeof options.fetchImpl !== 'function') fail('preservation_test_fetch_required');
  return createSessionCore({ ...options, testOnly: true });
}

export function isProductionInstalledSchemaPreservationSession(value) { return PRODUCTION_SESSIONS.has(value); }
export function isProductionInstalledSchemaPreservationAdmission(value) {
  return PRODUCTION_ADMISSIONS.has(value) && value.accountId === ACCOUNT_ID
    && iso(value.observedAt) && Date.now() >= Date.parse(value.observedAt)
    && Date.now() - Date.parse(value.observedAt) <= MAX_RELEASE_EVIDENCE_AGE_MS
    && Number.isSafeInteger(value.baselineAgeMs) && value.baselineAgeMs >= 0
    && value.baselineAgeMs <= MAX_SAME_RUN_BASELINE_AGE_MS;
}
export function isTestInstalledSchemaPreservationAdmission(value) { return TEST_ADMISSIONS.has(value); }

/** Raw saved captures can be checked for offline review only; this never brands production evidence. */
export function validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, options = {}) {
  ensureFactoryOptions(options, ['sourceCommit', 'canonicalV4Profile', 'selectedApp', 'baselineCapture',
    'currentCapture', 'baselineAllowLatest', 'currentAllowLatest', 'baselineExpectedDeploymentVersions',
    'currentExpectedDeploymentVersions', 'opsSuccessorReaderContract', 'opsSuccessorReaderReleaseCandidateId', 'now']);
  const { sourceCommit, canonicalV4Profile, selectedApp, baselineCapture, currentCapture,
    baselineAllowLatest = {}, currentAllowLatest = {}, baselineExpectedDeploymentVersions = {},
    currentExpectedDeploymentVersions = {}, opsSuccessorReaderContract, opsSuccessorReaderReleaseCandidateId, now } = options;
  checkCanonicalV4Profile(canonicalV4Profile);
  checkClassificationFresh(classification, sourceCommit, canonicalV4Profile, now);
  const baseline = validateCanonicalCapture(baselineCapture, { profile: canonicalV4Profile, selectedApp,
    allowLatest: baselineAllowLatest, expectedDeploymentVersions: baselineExpectedDeploymentVersions,
    opsSuccessorReaderContract, opsSuccessorReaderReleaseCandidateId });
  const current = validateCanonicalCapture(currentCapture, { profile: canonicalV4Profile, selectedApp,
    allowLatest: currentAllowLatest, expectedDeploymentVersions: currentExpectedDeploymentVersions,
    opsSuccessorReaderContract, opsSuccessorReaderReleaseCandidateId });
  const before = protectedControlsFingerprint(baseline), after = protectedControlsFingerprint(current);
  if (before !== after) fail('preservation_protected_controls_changed');
  return Object.freeze({ schemaVersion: 1, purpose: 'installed-schema-preservation-offline-check',
    status: 'preserved-installed-schema-with-pending-source-migrations', accountId: ACCOUNT_ID,
    sourceCommit, selectedApp, observedAt: classification.observedAt, offlineOnly: true,
    profileSha256: PROFILE_SHA256, canonicalV4ProfileSha256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    baselineProtectedControlsSha256: before, currentProtectedControlsSha256: after,
    allSourceMigrationsInstalled: false, applicationSchemaReady: false, executesDdl: false,
    authorizesMigration: false, authorizesFeatureActivation: false });
}

const PINNED_PROFILE_BYTES_SHA256 = '4267e120dd08ef7eb7a405e1e75e8f700b5147cbde4169f27268cc4f09ad821f';
const PROFILE_BYTES_SHA256 = hash(Buffer.from(readFileSync(PROFILE_PATH, 'utf8').replace(/\r\n/gu, '\n')));
if (PROFILE_BYTES_SHA256 !== PINNED_PROFILE_BYTES_SHA256) fail('preservation_profile_bytes_unpinned');
export const PROFILE_SHA256 = PROFILE_BYTES_SHA256;
