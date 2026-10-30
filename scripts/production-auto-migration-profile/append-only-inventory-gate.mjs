import { createHash } from 'node:crypto';

export const APPROVED_SOURCE_COMMIT = '1e09732cf4c8f863800cde3cc0ebbedd5a72a2ca';
export const RECONCILIATION_MANIFEST_SHA256 = '33f661636025c8432aa862b158703df9053f79ca7532813cea0e23cc3c181faa';
export const APPEND_PLAN_SHA256 = '142ccefd193341dafb0796fa046ecd7f559d9ab6af6f70217f9a52043a16685d';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const SOURCE_NAMES = Object.freeze(['operations', 'client']);
const DATABASE_IDS = Object.freeze({
  operations: '6ebf7514-d306-4615-ae56-ad869c874dbd',
  client: '7f40a7b7-c3ec-470e-a626-e798867f71f8',
});
const EXPECTED_COUNTS = Object.freeze({ operations: { base: 221, append: 10, source: 231 }, client: { base: 158, append: 4, source: 160 } });

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
function parsePinnedJson(bytes, expectedSha, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 512 * 1024 || sha256(bytes) !== expectedSha) fail(code);
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(code); }
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function validateStatementMeta(meta) {
  if (meta === undefined || meta === null) return;
  if (!isRecord(meta)) fail('migration_statement_metadata_invalid');
  for (const key of ['changes', 'rows_written', 'rowsWritten']) {
    if (Object.hasOwn(meta, key) && (!Number.isSafeInteger(meta[key]) || meta[key] !== 0)) fail('migration_write_metadata_detected');
  }
  if (meta.changed_db === true) fail('migration_write_metadata_detected');
  if (Object.hasOwn(meta, 'changed_db') && typeof meta.changed_db !== 'boolean') fail('migration_statement_metadata_invalid');
}
function assertRows(rows, expected, label) {
  if (!Array.isArray(rows) || rows.length !== expected.length) fail(`${label}_count_mismatch`);
  for (let index = 0; index < expected.length; index++) {
    const row = rows[index], want = expected[index];
    if (!exactKeys(row, ['name', 'id']) || typeof row.name !== 'string'
      || !Number.isSafeInteger(row.id) || row.id !== index + 1
      || row.name !== want.name || row.id !== want.id) fail(`${label}_rows_mismatch`);
  }
  return rows.map(({ name, id }) => ({ name, id }));
}
function validateSourceRows(rows, expected, app) {
  if (!Array.isArray(rows) || rows.length !== expected.length) fail('source_inventory_count_mismatch');
  const actualNames = new Set();
  for (let index = 0; index < expected.length; index++) {
    const row = rows[index], want = expected[index];
    if (!exactKeys(row, ['name', 'gitBlobOid', 'sha256']) || row.name !== want.name
      || row.gitBlobOid !== want.gitBlobOid || row.sha256 !== want.sha256
      || !GIT_OID.test(row.gitBlobOid) || !SHA256.test(row.sha256) || actualNames.has(row.name)) {
      fail(`source_inventory_${app}_mismatch`);
    }
    actualNames.add(row.name);
  }
  return rows;
}
function validateSourceBytes(sourceRows, sourceFiles) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length !== sourceRows.length) fail('source_file_count_mismatch');
  const files = new Map();
  for (const row of sourceFiles) {
    if (!exactKeys(row, ['name', 'bytes']) || typeof row.name !== 'string' || !Buffer.isBuffer(row.bytes)
      || row.bytes.length < 1 || row.bytes.length > 8 * 1024 * 1024 || files.has(row.name)) fail('source_file_shape_invalid');
    files.set(row.name, row.bytes);
  }
  let aggregate = 0;
  for (const expected of sourceRows) {
    const bytes = files.get(expected.name);
    if (!bytes) fail('source_file_missing');
    aggregate += bytes.length;
    if (aggregate > 32 * 1024 * 1024) fail('source_inventory_too_large');
    if (sha256(bytes) !== expected.sha256 || gitBlobOid(bytes) !== expected.gitBlobOid) fail('source_file_hash_mismatch');
  }
}
function validateProfile(manifestBytes, appendPlanBytes, sourceCommit, app) {
  if (!SOURCE_NAMES.includes(app)) fail('migration_app_unknown');
  if (!GIT_OID.test(sourceCommit)) fail('source_commit_invalid');
  const manifest = parsePinnedJson(manifestBytes, RECONCILIATION_MANIFEST_SHA256, 'reconciliation_manifest_unpinned');
  const plan = parsePinnedJson(appendPlanBytes, APPEND_PLAN_SHA256, 'append_plan_unpinned');
  if (manifest.schemaVersion !== 1 || manifest.status !== 'review-candidate-not-release-authority'
    || manifest.source?.repository !== 'ltds-ops-monorepo' || manifest.source?.commit !== APPROVED_SOURCE_COMMIT
    || manifest.source?.worktreeVerifiedAgainstCommit !== true
    || plan.schemaVersion !== 1 || plan.status !== 'review-candidate-not-executable'
    || plan.sourceCommit !== APPROVED_SOURCE_COMMIT || plan.appliesNoProductionDDL !== true) fail('append_profile_invalid');
  const db = manifest.databases?.[app], appPlan = plan.apps?.[app];
  const expected = EXPECTED_COUNTS[app];
  if (!db || !appPlan || db.databaseId !== DATABASE_IDS[app] || db.rowCount !== expected.base
    || db.orderedRows?.length !== expected.base || db.sourceMigrationCount !== db.sourceMigrations?.length
    || db.sourceMigrationCount !== expected.source || appPlan.observedBase?.rowCount !== expected.base
    || appPlan.appendInExactSourceOrder?.length !== expected.append) fail('append_profile_app_invalid');
  const base = db.orderedRows;
  if (!exactKeys(base[0], ['name', 'id']) || base[0].id !== 1) fail('append_profile_base_invalid');
  for (let i = 0; i < base.length; i++) {
    const row = base[i];
    if (!exactKeys(row, ['name', 'id']) || typeof row.name !== 'string' || row.id !== i + 1) fail('append_profile_base_invalid');
  }
  if (sha256(Buffer.from(JSON.stringify(base))) !== db.orderedRowsSha256
    || db.orderedRowsSha256 !== appPlan.observedBase.orderedRowsSha256
    || sha256(Buffer.from(base.map(row => row.name).join('\n'))) !== db.orderedNamesSha256
    || db.orderedNamesSha256 !== appPlan.observedBase.orderedNamesSha256
    || appPlan.observedBase.firstId !== 1 || appPlan.observedBase.lastId !== expected.base) fail('append_profile_base_digest_invalid');

  const sourceRows = db.sourceMigrations;
  const baseNames = new Set(base.map(row => row.name));
  const sourceNames = new Set();
  for (let i = 0; i < sourceRows.length; i++) {
    const row = sourceRows[i];
    if (!exactKeys(row, ['name', 'gitBlobOid', 'sha256']) || !/^\d{4}_.+\.sql$/u.test(row.name)
      || !GIT_OID.test(row.gitBlobOid) || !SHA256.test(row.sha256) || sourceNames.has(row.name)
      || (i > 0 && sourceRows[i - 1].name >= row.name)) fail('append_profile_source_inventory_invalid');
    sourceNames.add(row.name);
  }
  const expectedAppendNames = sourceRows.filter(row => !baseNames.has(row.name));
  const plannedAppend = appPlan.appendInExactSourceOrder;
  const pending = db.sourceOnlyPending;
  if (expectedAppendNames.length !== expected.append || !Array.isArray(pending) || pending.length !== expected.append
    || !Array.isArray(appPlan.preserveExactly)
    || !sameJson(appPlan.preserveExactly.map(({ id, name }) => ({ name, id })), base)) {
    fail('append_profile_pending_set_invalid');
  }
  for (let i = 0; i < expected.append; i++) {
    const src = expectedAppendNames[i], planRow = plannedAppend[i], pendingRow = pending[i];
    if (!src || !planRow || planRow.ledgerId !== expected.base + i + 1 || planRow.name !== src.name
      || planRow.gitBlobOid !== src.gitBlobOid || planRow.sha256 !== src.sha256
      || !exactKeys(pendingRow, ['name', 'gitBlobOid', 'sha256'])
      || pendingRow.name !== src.name || pendingRow.gitBlobOid !== src.gitBlobOid || pendingRow.sha256 !== src.sha256) {
      fail('append_profile_envelope_invalid');
    }
  }
  const historical = db.actualOnlyHistorical;
  const historyPlan = appPlan.historicalRowsWithoutCurrentSource;
  if (!Array.isArray(historical) || !Array.isArray(historyPlan)
    || !sameJson(historical.map(({ id, name }) => ({ id, name })), historyPlan.map(({ id, name }) => ({ id, name })))
    || historical.some(row => sourceNames.has(row.name))) fail('append_profile_historical_rows_invalid');
  if (app === 'client') {
    if (!sameJson(historical.map(({ id, name }) => ({ id, name })), [
      { id: 31, name: '0112_thumbnail_renderer_coordination.sql' },
      { id: 32, name: '0113_thumbnail_backfill_controls.sql' },
    ]) || base[30]?.name !== '0112_thumbnail_renderer_coordination.sql'
      || base[31]?.name !== '0113_thumbnail_backfill_controls.sql') fail('client_historical_rows_not_exact');
  } else if (historical.length !== 0) fail('operations_historical_rows_unexpected');
  return { app, databaseId: db.databaseId, baseRows: base, sourceRows, appendRows: plannedAppend,
    historicalRows: historical, expectedSourceRows: sourceRows.length };
}

/**
 * Validates one fixed, reviewed append-only profile. This is an inventory gate
 * only: it never executes SQL or enables an application feature.
 */
export function evaluateApprovedAppendOnlyLedger({ reconciliationManifestBytes, appendPlanBytes, sourceCommit,
  app, databaseId, sourceRows, sourceFiles, localMigrationNames, ledgerRows, statementMeta } = {}) {
  const profile = validateProfile(reconciliationManifestBytes, appendPlanBytes, sourceCommit, app);
  if (databaseId !== profile.databaseId) fail('migration_database_target_mismatch');
  const checkedSourceRows = validateApprovedAppendOnlySourceInventory({
    reconciliationManifestBytes, appendPlanBytes, sourceCommit, app, sourceRows, sourceFiles, localMigrationNames,
  });
  validateStatementMeta(statementMeta);
  const rows = Array.isArray(ledgerRows) ? ledgerRows : null;
  const expectedFull = [...profile.baseRows, ...profile.appendRows.map(row => ({ name: row.name, id: row.ledgerId }))];
  let status, exactRows;
  if (rows?.length === profile.baseRows.length) {
    exactRows = assertRows(rows, profile.baseRows, 'preserved_base');
    status = 'preserved-base-awaiting-entire-approved-append';
  } else if (rows?.length === expectedFull.length) {
    exactRows = assertRows(rows, expectedFull, 'fully_appended');
    status = 'fully-appended-source-inventory';
  } else {
    fail('partial_or_unapproved_migration_ledger');
  }
  const orderedRowsSha256 = sha256(Buffer.from(JSON.stringify(exactRows)));
  const sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(checkedSourceRows)));
  const appendEnvelope = status === 'preserved-base-awaiting-entire-approved-append'
    ? profile.appendRows.map(({ ledgerId, name, gitBlobOid, sha256: fileSha256 }) => Object.freeze({
      ledgerId, name, gitBlobOid, sha256: fileSha256,
    })) : [];
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'append-only-migration-inventory-gate-candidate',
    sourceCommit,
    app,
    databaseId,
    status,
    sourceMigrationCount: profile.expectedSourceRows,
    sourceInventorySha256,
    installedRowCount: exactRows.length,
    installedRowsSha256: orderedRowsSha256,
    historicalRowsPreserved: profile.historicalRows.map(({ id, name }) => Object.freeze({ id, name })),
    appendEnvelope: Object.freeze(appendEnvelope),
    applicationSchemaReady: false,
    executesDdl: false,
    authorizesFeatureActivation: false,
  });
}

/** Validates local source files against the frozen candidate profile without reading or classifying a ledger. */
export function validateApprovedAppendOnlySourceInventory({ reconciliationManifestBytes, appendPlanBytes,
  sourceCommit, app, sourceRows, sourceFiles, localMigrationNames } = {}) {
  const profile = validateProfile(reconciliationManifestBytes, appendPlanBytes, sourceCommit, app);
  const checkedSourceRows = validateSourceRows(sourceRows, profile.sourceRows, app);
  if (!Array.isArray(localMigrationNames) || localMigrationNames.length !== checkedSourceRows.length
    || localMigrationNames.some((name, index) => name !== checkedSourceRows[index].name)) fail('local_source_inventory_changed');
  validateSourceBytes(checkedSourceRows, sourceFiles);
  return checkedSourceRows;
}

/** Recompute a serialized classification from the exact approved profile. */
export function expectedApprovedAppendOnlyClassification({ reconciliationManifestBytes, appendPlanBytes,
  sourceCommit, app, status } = {}) {
  const profile = validateProfile(reconciliationManifestBytes, appendPlanBytes, sourceCommit, app);
  const allowed = ['preserved-base-awaiting-entire-approved-append', 'fully-appended-source-inventory'];
  if (!allowed.includes(status)) fail('migration_classification_status_invalid');
  const isBase = status === allowed[0];
  const expectedRows = isBase ? profile.baseRows : [
    ...profile.baseRows,
    ...profile.appendRows.map(({ ledgerId, name }) => ({ name, id: ledgerId })),
  ];
  const sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(profile.sourceRows)));
  const installedRowsSha256 = sha256(Buffer.from(JSON.stringify(expectedRows)));
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'append-only-migration-inventory-gate-candidate',
    sourceCommit,
    app,
    databaseId: profile.databaseId,
    status,
    sourceMigrationCount: profile.expectedSourceRows,
    sourceInventorySha256,
    installedRowCount: expectedRows.length,
    installedRowsSha256,
    historicalRowsPreserved: profile.historicalRows.map(({ id, name }) => Object.freeze({ id, name })),
    appendEnvelope: Object.freeze(isBase ? profile.appendRows.map(({ ledgerId, name, gitBlobOid, sha256: fileSha256 }) =>
      Object.freeze({ ledgerId, name, gitBlobOid, sha256: fileSha256 })) : []),
    applicationSchemaReady: false,
    executesDdl: false,
    authorizesFeatureActivation: false,
  });
}

/** Independently reusable source-byte check for callers that read files from a pinned Git tree. */
export function validatePinnedMigrationFile({ name, bytes, expected } = {}) {
  if (!exactKeys(expected, ['name', 'gitBlobOid', 'sha256']) || expected.name !== name
    || !GIT_OID.test(expected.gitBlobOid ?? '') || !SHA256.test(expected.sha256 ?? '')
    || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 8 * 1024 * 1024
    || sha256(bytes) !== expected.sha256 || gitBlobOid(bytes) !== expected.gitBlobOid) fail('source_file_hash_mismatch');
  return true;
}


