import { createHash } from 'node:crypto';
import { classifySource38Inventory, APPEND_PLAN_SHA256, MANIFEST_SHA256,
  SOURCE_COMMIT, SOURCE_TREE } from '../source38-inventory-v2/gate.mjs';

export const PROFILE = 'client-0242-targeted-v1';
export const ACCOUNT_ID = '846c924bf17bf4f3dd15c97a4c5d1d51';
export const DATABASE_ID = '7f40a7b7-c3ec-470e-a626-e798867f71f8';
export const MIGRATION_NAME = '0242_client_ops_triage_inquiries.sql';
export const MIGRATION_BLOB_OID = '4f2b0bcf77a7a5cf6b67e4730ae79254b909e356';
export const MIGRATION_SHA256 = '8f25db33d95c77425a52031d0e4255b133e2a2b91025d427c0d118ee305a4b66';
export const BASE_LEDGER_COUNT = 158;
export const TARGET_LEDGER_ID = 159;
export const SOURCE_PENDING = Object.freeze([
  '0235_windows_portal_successor_candidates.sql',
  '0236_windows_portal_successor_content_start_audit.sql',
  '0239_native_project_assignment_proof_v3.sql',
  '0241_app_release_pilot.sql',
  MIGRATION_NAME,
]);
export const REMAINING_PENDING = Object.freeze(SOURCE_PENDING.slice(0, -1));

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TARGET_OBJECTS = new Set([
  'client_ops_triage_inquiries',
  'idx_client_ops_triage_inquiries_queue',
  'idx_client_ops_triage_inquiries_identity',
  'client_ops_triage_notification_outbox',
  'idx_client_ops_triage_outbox_ready',
]);
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 12 * 1024 * 1024;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function gitBlobOid(bytes) {
  return createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`, 'ascii')).update(bytes).digest('hex');
}
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateSchemaSnapshot(snapshot, baseLedger) {
  if (!exactKeys(snapshot, ['schemaVersion', 'observedAt', 'accountId', 'databaseId', 'metadataOnly', 'ledger', 'schema', 'parent'])
    || snapshot.schemaVersion !== 1 || snapshot.accountId !== ACCOUNT_ID || snapshot.databaseId !== DATABASE_ID
    || snapshot.metadataOnly !== true || typeof snapshot.observedAt !== 'string'
    || !Number.isFinite(Date.parse(snapshot.observedAt)) || new Date(snapshot.observedAt).toISOString() !== snapshot.observedAt) {
    fail('targeted_schema_snapshot_invalid');
  }
  if (!Array.isArray(snapshot.ledger) || snapshot.ledger.length !== BASE_LEDGER_COUNT) fail('targeted_schema_ledger_mismatch');
  const schemaLedger = snapshot.ledger.map(row => {
    if (!exactKeys(row, ['id', 'name']) || !Number.isSafeInteger(row.id) || typeof row.name !== 'string') {
      fail('targeted_schema_ledger_mismatch');
    }
    return { name: row.name, id: row.id };
  });
  if (!sameJson(schemaLedger, baseLedger)) fail('targeted_schema_ledger_mismatch');
  if (!Array.isArray(snapshot.schema) || snapshot.schema.length < 2 || snapshot.schema.length > 5_000) {
    fail('targeted_schema_objects_invalid');
  }
  const seen = new Set();
  for (const row of snapshot.schema) {
    if (!exactKeys(row, ['type', 'name', 'tbl_name', 'sql'])
      || !['table', 'index', 'trigger', 'view'].includes(row.type)
      || typeof row.name !== 'string' || !row.name || row.name.startsWith('sqlite_') || row.name.startsWith('_cf_')
      || typeof row.tbl_name !== 'string' || !row.tbl_name
      || typeof row.sql !== 'string') fail('targeted_schema_object_invalid');
    if (seen.has(row.name)) fail('targeted_schema_object_duplicate');
    seen.add(row.name);
    if (TARGET_OBJECTS.has(row.name)) fail('targeted_target_object_already_exists');
  }
  const parent = snapshot.schema.find(row => row.type === 'table' && row.name === 'portal_v2_identities'
    && row.tbl_name === 'portal_v2_identities' && typeof row.sql === 'string');
  const migrationLedger = snapshot.schema.find(row => row.type === 'table' && row.name === 'd1_migrations'
    && row.tbl_name === 'd1_migrations' && typeof row.sql === 'string');
  if (!parent || !migrationLedger) fail('targeted_schema_prerequisite_missing');
  if (!Array.isArray(snapshot.parent) || snapshot.parent.length < 1
    || !snapshot.parent.some(row => exactKeys(row, ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'])
      && row.name === 'id' && typeof row.type === 'string' && row.type.toUpperCase() === 'TEXT' && row.pk === 1)) {
    fail('targeted_parent_identity_key_missing');
  }
  const schemaBytes = Buffer.from(JSON.stringify(snapshot.schema), 'utf8');
  if (schemaBytes.length > MAX_SCHEMA_BYTES) fail('targeted_schema_snapshot_too_large');
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
  return Object.freeze({
    schemaSha256: sha256(snapshotBytes),
    schemaObjectsSha256: sha256(schemaBytes),
    schemaObjectCount: snapshot.schema.length,
    schemaJson: schemaBytes.toString('utf8'),
  });
}

function splitPinnedSql(sql) {
  const statements = [];
  let current = '', mode = 'normal';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (mode === 'line-comment') {
      if (ch === '\n' || ch === '\r') { current += '\n'; mode = 'normal'; }
      continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { i++; current += ' '; mode = 'normal'; }
      continue;
    }
    if (mode === 'single' || mode === 'double' || mode === 'backtick') {
      const quote = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      current += ch;
      if (ch === quote && next === quote) { current += next; i++; }
      else if (ch === quote) mode = 'normal';
      continue;
    }
    if (mode === 'bracket') {
      current += ch;
      if (ch === ']') mode = 'normal';
      continue;
    }
    if (ch === '-' && next === '-') { i++; current += ' '; mode = 'line-comment'; continue; }
    if (ch === '/' && next === '*') { i++; current += ' '; mode = 'block-comment'; continue; }
    if (ch === "'") { current += ch; mode = 'single'; continue; }
    if (ch === '"') { current += ch; mode = 'double'; continue; }
    if (ch === '`') { current += ch; mode = 'backtick'; continue; }
    if (ch === '[') { current += ch; mode = 'bracket'; continue; }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (mode === 'single' || mode === 'double' || mode === 'backtick' || mode === 'bracket' || mode === 'block-comment') {
    fail('targeted_migration_sql_unterminated');
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function migrationStatements(bytes) {
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== MIGRATION_SHA256 || gitBlobOid(bytes) !== MIGRATION_BLOB_OID) {
    fail('targeted_migration_bytes_unpinned');
  }
  const sql = bytes.toString('utf8');
  if (Buffer.from(sql, 'utf8').compare(bytes) !== 0) fail('targeted_migration_utf8_invalid');
  const statements = splitPinnedSql(sql.replace(/\r\n/g, '\n'))
    .filter(statement => statement && !/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/iu.test(statement));
  if (statements.length !== 5 || statements.some(statement => !/^CREATE\s+(?:TABLE|INDEX)\b/iu.test(statement))) {
    fail('targeted_migration_statement_set_invalid');
  }
  return Object.freeze(statements);
}

function buildBatch({ baselineRows, schemaSnapshot, migrationSql, runId }) {
  if (!UUID.test(runId ?? '')) fail('targeted_run_id_invalid');
  const guardName = `__codex_client0242_guard_${runId.replaceAll('-', '')}`;
  const qGuard = `"${guardName}"`;
  const schemaEvidence = validateSchemaSnapshot(schemaSnapshot, baselineRows);
  if (schemaSnapshot.schema.some(row => row.name === guardName)) fail('targeted_guard_name_collision');
  const migration = migrationStatements(migrationSql);
  const guardSql = `INSERT INTO ${qGuard}(ok)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM d1_migrations)=CAST(? AS INTEGER)
  AND NOT EXISTS (
    SELECT 1 FROM json_each(?) expected
    LEFT JOIN d1_migrations actual ON actual.id=CAST(expected.key AS INTEGER)+1
    WHERE actual.id IS NULL
      OR actual.name IS NOT json_extract(expected.value,'$.name')
      OR actual.id IS NOT CAST(json_extract(expected.value,'$.id') AS INTEGER)
  )
  AND (SELECT COUNT(*) FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*')=CAST(? AS INTEGER)
  AND NOT EXISTS (
    SELECT 1 FROM json_each(?) expected
    LEFT JOIN sqlite_schema actual
      ON actual.type=json_extract(expected.value,'$.type')
      AND actual.name=json_extract(expected.value,'$.name')
    WHERE actual.name IS NULL
      OR actual.tbl_name IS NOT json_extract(expected.value,'$.tbl_name')
      OR actual.sql IS NOT json_extract(expected.value,'$.sql')
  )
  AND EXISTS (
    SELECT 1 FROM pragma_table_info('portal_v2_identities')
    WHERE name='id' AND upper(type)='TEXT' AND pk=1
  )
  AND (SELECT foreign_keys FROM pragma_foreign_keys)=1
THEN 1 ELSE 0 END`;
  const batch = [
    { sql: `CREATE TABLE ${qGuard}(ok INTEGER NOT NULL CHECK(ok=1))`, params: [] },
    { sql: guardSql, params: [String(BASE_LEDGER_COUNT), JSON.stringify(baselineRows),
      String(schemaEvidence.schemaObjectCount + 1), schemaEvidence.schemaJson] },
    { sql: `DROP TABLE ${qGuard}`, params: [] },
    ...migration.map(sql => ({ sql, params: [] })),
    { sql: 'INSERT INTO d1_migrations(id,name) VALUES(?,?)', params: [String(TARGET_LEDGER_ID), MIGRATION_NAME] },
  ];
  if (Buffer.byteLength(JSON.stringify({ batch }), 'utf8') > MAX_BATCH_BYTES) fail('targeted_batch_too_large');
  return Object.freeze({ guardName, schemaEvidence, batch: deepFreeze(batch) });
}

/**
 * Compiles held evidence for one targeted append. It has no I/O, provider,
 * credential, executor, or release-authority behavior. A supplied schema
 * snapshot is evidence input, not an attestation that the snapshot is genuine.
 */
export function compileClient0242Packet({ manifestBytes, appendPlanBytes, sourceCommit, databaseId,
  sourceRows, sourceFiles, localMigrationNames, ledgerRows, statementMeta, schemaSnapshot,
  migrationSql, runId } = {}) {
  if (databaseId !== DATABASE_ID) fail('targeted_database_mismatch');
  if (!schemaSnapshot) {
    return deepFreeze({ schemaVersion: 1, profile: PROFILE, status: 'held-required-schema-snapshot-missing',
      held: true, requestBody: null, executesDdl: false, authorizesMigration: false,
      authorizesFeatureActivation: false, applicationReady: false, reasons: ['targeted_schema_snapshot_missing'] });
  }
  const inventory = classifySource38Inventory({ manifestBytes, appendPlanBytes, sourceCommit, app: 'client',
    databaseId, sourceRows, sourceFiles, localMigrationNames, ledgerRows, statementMeta });
  if (inventory.classification !== 'held-preserved-base-awaiting-reviewed-successor'
    || inventory.ledgerRowCount !== BASE_LEDGER_COUNT
    || !sameJson(inventory.historicalRowsPreserved, [
      { id: 31, name: '0112_thumbnail_renderer_coordination.sql' },
      { id: 32, name: '0113_thumbnail_backfill_controls.sql' },
    ])) fail('targeted_base_classification_invalid');
  if (!sameJson(inventory.appendEnvelope.map(row => row.name), SOURCE_PENDING)) fail('targeted_pending_set_invalid');
  const target = inventory.appendEnvelope.find(row => row.name === MIGRATION_NAME);
  if (!target || target.gitBlobOid !== MIGRATION_BLOB_OID
    || target.sha256 !== MIGRATION_SHA256) fail('targeted_source_pin_mismatch');
  const sourceFile = sourceFiles.find(file => file.name === MIGRATION_NAME);
  if (!sourceFile || !Buffer.isBuffer(migrationSql) || !migrationSql.equals(sourceFile.bytes)) {
    fail('targeted_migration_source_disagreement');
  }
  const transaction = buildBatch({ baselineRows: ledgerRows, schemaSnapshot, migrationSql, runId });
  return deepFreeze({
    schemaVersion: 1,
    profile: PROFILE,
    status: 'review-candidate-not-executable',
    held: true,
    target: Object.freeze({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, app: 'client' }),
    source: Object.freeze({ commit: SOURCE_COMMIT, profileTree: SOURCE_TREE,
      manifestSha256: MANIFEST_SHA256, appendPlanSha256: APPEND_PLAN_SHA256,
      migration: Object.freeze({ name: MIGRATION_NAME, ledgerId: TARGET_LEDGER_ID,
        gitBlobOid: MIGRATION_BLOB_OID, sha256: MIGRATION_SHA256 }) }),
    baseline: Object.freeze({ rowCount: BASE_LEDGER_COUNT,
      orderedRowsSha256: inventory.ledgerRowsSha256,
      preservedHistoricalRows: inventory.historicalRowsPreserved }),
    sourcePending: SOURCE_PENDING,
    sourceMigrationCount: inventory.sourceMigrationCount,
    selected: MIGRATION_NAME,
    remainsPending: REMAINING_PENDING,
    futureInventoryConstraint: 'Record this observed exceptional order explicitly: 0242 is ledger ID 159 while 0235, 0236, 0239, and 0241 remain pending. Do not infer a source-ordered full append; review any later normal Wrangler migration apply separately.',
    schemaEvidence: Object.freeze({ supplied: true, independentlyVerified: false,
      schemaObjectCount: transaction.schemaEvidence.schemaObjectCount,
      schemaSha256: transaction.schemaEvidence.schemaSha256,
      schemaObjectsSha256: transaction.schemaEvidence.schemaObjectsSha256 }),
    requestBody: Object.freeze({ batch: transaction.batch }),
    requestBodySha256: sha256(Buffer.from(JSON.stringify({ batch: transaction.batch }), 'utf8')),
    batchStatementCount: transaction.batch.length,
    guardName: transaction.guardName,
    executesDdl: false,
    providerAccessed: false,
    providerWrites: 0,
    authorizesMigration: false,
    authorizesFeatureActivation: false,
    applicationReady: false,
    receiptProvenanceLimit: 'The source38 candidate receipt is producer-supplied metadata; this compiler does not verify its provider-side no-write claim.',
  });
}
