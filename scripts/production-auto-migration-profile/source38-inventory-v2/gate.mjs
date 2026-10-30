import { createHash } from 'node:crypto';

export const SOURCE_COMMIT = '38ad7ebcfc09e4334de846d5307e7dac5a0ff327';
export const SOURCE_TREE = '47baeb281c5b370b935b86e6586c3d74d720681f';
export const MANIFEST_SHA256 = '20722fd99f78dbb5052a4914fd5ba308afb6b0213be61aa4a04c9321e012ede6';
export const APPEND_PLAN_SHA256 = 'ecdd9d0673a075e94b3dd3005103a8d898bd85fd5ba5af988cbbae612ecbeaa1';

const DB_IDS = Object.freeze({
  operations: '6ebf7514-d306-4615-ae56-ad869c874dbd',
  client: '7f40a7b7-c3ec-470e-a626-e798867f71f8',
});
const EXPECTED = Object.freeze({
  operations: { base: 225, append: 6, source: 231, path: 'apps/operations/migrations' },
  client: { base: 158, append: 5, source: 161, path: 'apps/client/migrations' },
});
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function gitBlobOid(bytes) {
  return createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`, 'ascii')).update(bytes).digest('hex');
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function pinnedJson(bytes, digest, error) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 512 * 1024 || sha256(bytes) !== digest) fail(error);
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(error); }
}
function validateProfile(manifestBytes, planBytes, app) {
  if (!Object.hasOwn(EXPECTED, app)) fail('inventory_app_unknown');
  const manifest = pinnedJson(manifestBytes, MANIFEST_SHA256, 'inventory_manifest_unpinned');
  const plan = pinnedJson(planBytes, APPEND_PLAN_SHA256, 'inventory_append_plan_unpinned');
  if (manifest.schemaVersion !== 1 || manifest.status !== 'review-candidate-not-release-authority'
    || manifest.source?.repository !== 'ltds-ops-monorepo' || manifest.source?.commit !== SOURCE_COMMIT
    || manifest.source?.worktreeVerifiedAgainstCommit !== true
    || plan.schemaVersion !== 1 || plan.status !== 'review-candidate-not-executable'
    || plan.sourceCommit !== SOURCE_COMMIT || plan.appliesNoProductionDDL !== true) fail('inventory_profile_invalid');

  const expected = EXPECTED[app], db = manifest.databases?.[app], appPlan = plan.apps?.[app];
  if (!db || !appPlan || db.databaseId !== DB_IDS[app] || db.rowCount !== expected.base
    || db.orderedRows?.length !== expected.base || db.sourceMigrationCount !== expected.source
    || db.sourceMigrations?.length !== expected.source || appPlan.observedBase?.rowCount !== expected.base
    || appPlan.appendInExactSourceOrder?.length !== expected.append) fail('inventory_profile_app_invalid');

  const base = db.orderedRows;
  for (let i = 0; i < base.length; i++) {
    const row = base[i];
    if (!exactKeys(row, ['name', 'id']) || typeof row.name !== 'string' || row.id !== i + 1) fail('inventory_base_invalid');
  }
  if (sha256(Buffer.from(JSON.stringify(base))) !== db.orderedRowsSha256
    || db.orderedRowsSha256 !== appPlan.observedBase.orderedRowsSha256
    || sha256(Buffer.from(base.map(row => row.name).join('\n'))) !== db.orderedNamesSha256
    || db.orderedNamesSha256 !== appPlan.observedBase.orderedNamesSha256
    || appPlan.observedBase.firstId !== 1 || appPlan.observedBase.lastId !== expected.base
    || !sameJson(appPlan.preserveExactly, base)) fail('inventory_base_digest_invalid');

  const source = db.sourceMigrations, sourceNames = new Set(), baseNames = new Set(base.map(row => row.name));
  for (let i = 0; i < source.length; i++) {
    const row = source[i];
    if (!exactKeys(row, ['name', 'gitBlobOid', 'sha256']) || !/^\d{4}_[a-z0-9_]+\.sql$/u.test(row.name)
      || !GIT_OID.test(row.gitBlobOid) || !SHA256.test(row.sha256) || sourceNames.has(row.name)
      || (i > 0 && source[i - 1].name >= row.name)) fail('inventory_source_manifest_invalid');
    sourceNames.add(row.name);
  }
  const pending = source.filter(row => !baseNames.has(row.name));
  if (pending.length !== expected.append || !Array.isArray(db.sourceOnlyPending)
    || !sameJson(db.sourceOnlyPending, pending)) fail('inventory_pending_set_invalid');
  const planned = pending.map((row, i) => ({ ledgerId: expected.base + i + 1, ...row }));
  if (!sameJson(appPlan.appendInExactSourceOrder, planned)) fail('inventory_append_plan_invalid');

  const historical = db.actualOnlyHistorical;
  if (!Array.isArray(historical) || !Array.isArray(appPlan.historicalRowsWithoutCurrentSource)
    || !sameJson(historical, appPlan.historicalRowsWithoutCurrentSource)
    || historical.some(row => !exactKeys(row, ['name', 'id']) || sourceNames.has(row.name)
      || !Number.isSafeInteger(row.id) || row.id < 1 || row.id > base.length || base[row.id - 1]?.name !== row.name)) {
    fail('inventory_historical_rows_invalid');
  }
  const exactClientHistory = [
    { name: '0112_thumbnail_renderer_coordination.sql', id: 31 },
    { name: '0113_thumbnail_backfill_controls.sql', id: 32 },
  ];
  if (app === 'client' ? !sameJson(historical, exactClientHistory) : historical.length !== 0) {
    fail('inventory_historical_exception_invalid');
  }
  return { app, expected, databaseId: DB_IDS[app], base, source, pending, historical };
}

function validateSource({ sourceRows, sourceFiles, localMigrationNames }, profile) {
  if (!Array.isArray(sourceRows) || !sameJson(sourceRows, profile.source)
    || !Array.isArray(localMigrationNames) || !sameJson(localMigrationNames, profile.source.map(row => row.name))) {
    fail('inventory_current_source_mismatch');
  }
  if (!Array.isArray(sourceFiles) || sourceFiles.length !== profile.source.length) fail('inventory_source_file_count_mismatch');
  const files = new Map();
  for (const file of sourceFiles) {
    if (!exactKeys(file, ['name', 'bytes']) || typeof file.name !== 'string' || !Buffer.isBuffer(file.bytes)
      || file.bytes.length < 1 || file.bytes.length > 8 * 1024 * 1024 || files.has(file.name)) fail('inventory_source_file_shape_invalid');
    files.set(file.name, file.bytes);
  }
  let aggregate = 0;
  for (const row of profile.source) {
    const bytes = files.get(row.name);
    if (!bytes) fail('inventory_source_file_missing');
    aggregate += bytes.length;
    if (aggregate > 32 * 1024 * 1024) fail('inventory_source_too_large');
    if (sha256(bytes) !== row.sha256 || gitBlobOid(bytes) !== row.gitBlobOid) fail('inventory_source_bytes_mismatch');
  }
}

function validateReadMetadata(meta) {
  if (!isRecord(meta)) fail('inventory_read_metadata_missing');
  const evidenceKeys = ['changes', 'rows_written', 'rowsWritten', 'changed_db'];
  if (!evidenceKeys.some(key => Object.hasOwn(meta, key))) fail('inventory_read_metadata_insufficient');
  for (const key of ['changes', 'rows_written', 'rowsWritten']) {
    if (Object.hasOwn(meta, key) && (!Number.isSafeInteger(meta[key]) || meta[key] !== 0)) fail('inventory_write_metadata_detected');
  }
  if (meta.changed_db === true || (Object.hasOwn(meta, 'changed_db') && typeof meta.changed_db !== 'boolean')) {
    fail('inventory_write_metadata_detected');
  }
}

function exactLedgerRows(rows, expected, code) {
  if (!Array.isArray(rows) || rows.length !== expected.length) fail(code);
  for (let i = 0; i < expected.length; i++) {
    if (!exactKeys(rows[i], ['name', 'id']) || rows[i].name !== expected[i].name || rows[i].id !== expected[i].id) fail(code);
  }
  return rows.map(({ name, id }) => ({ name, id }));
}

/**
 * Classifies read-only ledger evidence against source38-inventory-v2.
 * This is deliberately held evidence: it never authorizes or performs DDL,
 * migration execution, application readiness, or feature activation.
 */
export function classifySource38Inventory({ manifestBytes, appendPlanBytes, sourceCommit, app, databaseId,
  sourceRows, sourceFiles, localMigrationNames, ledgerRows, statementMeta } = {}) {
  if (sourceCommit !== SOURCE_COMMIT) fail('inventory_source_commit_mismatch');
  const profile = validateProfile(manifestBytes, appendPlanBytes, app);
  if (databaseId !== profile.databaseId) fail('inventory_database_target_mismatch');
  validateSource({ sourceRows, sourceFiles, localMigrationNames }, profile);
  validateReadMetadata(statementMeta);

  const appended = profile.pending.map(row => ({ name: row.name, id: profile.expected.base + profile.pending.indexOf(row) + 1 }));
  const fullExpected = [...profile.base, ...appended];
  let status, exactRows;
  if (Array.isArray(ledgerRows) && ledgerRows.length === profile.base.length) {
    exactRows = exactLedgerRows(ledgerRows, profile.base, 'inventory_base_ledger_mismatch');
    status = 'held-preserved-base-awaiting-reviewed-successor';
  } else if (Array.isArray(ledgerRows) && ledgerRows.length === fullExpected.length) {
    exactRows = exactLedgerRows(ledgerRows, fullExpected, 'inventory_full_ledger_mismatch');
    status = 'held-complete-source-inventory-awaiting-reviewed-successor';
  } else {
    fail('inventory_unknown_or_partial_ledger');
  }

  return Object.freeze({
    schemaVersion: 1,
    profile: 'source38-inventory-v2',
    profileSourceCommit: SOURCE_COMMIT,
    pinnedProfileSourceTree: SOURCE_TREE,
    app,
    databaseId,
    classification: status,
    held: true,
    inventoryOnly: true,
    applicationReady: false,
    executesDdl: false,
    authorizesMigration: false,
    authorizesFeatureActivation: false,
    sourceMigrationCount: profile.source.length,
    sourceInventorySha256: sha256(Buffer.from(JSON.stringify(profile.source))),
    ledgerRowCount: exactRows.length,
    ledgerRowsSha256: sha256(Buffer.from(JSON.stringify(exactRows))),
    statementMetadataReviewed: true,
    historicalRowsPreserved: profile.historical.map(({ id, name }) => Object.freeze({ id, name })),
    appendEnvelope: Object.freeze(status === 'held-preserved-base-awaiting-reviewed-successor'
      ? profile.pending.map(({ name, gitBlobOid, sha256: fileSha256 }, i) => Object.freeze({
        ledgerId: profile.expected.base + i + 1, name, gitBlobOid, sha256: fileSha256,
      })) : []),
  });
}
