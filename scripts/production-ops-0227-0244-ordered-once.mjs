// Ordered once-operator for the Operations D1 migrations 0227..0244.
//
// It advances a D1 database whose ledger is exactly the 226-row production
// ledger ending at 0226_staff_login_bindings.sql through the ten pinned files,
// one at a time, in lexical order. Each file is applied the same way as the
// 0226 precedent: one D1 REST batch holding the pinned Wrangler wire statements
// plus `INSERT INTO d1_migrations(name) VALUES (?)`. A read-only preflight runs
// before each file and an exact post-check after it. The first mismatch or
// failure stops the run; nothing is retried or replayed. The batch is NOT
// assumed to be atomic: an ambiguous or failed apply may leave some of a file's
// objects without its ledger row, so a later run must pass the read-only
// reconcile (which refuses partial objects) and may continue only with
// --resume-from the reconciled next step.
//
// The default mode is a read-only dry run. Writes need `--execute`, an unused
// receipt path and the typed confirmation. See
// docs/operations/production-ops-0227-0244-ordered-apply.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OPS_0227_0244_CONTRACT = 'production-ops-0227-0244-ordered-once-v1';
export const OPS_0227_0244_FIXTURE_RELATIVE = 'scripts/fixtures/production-ops-0227-0244-wrangler-wire-statements.json';
export const OPS_0227_0244_FIXTURE_SHA256 = 'd14544f8d41633873bab9deb15c0fd52e0be655cf7f396747d59b998ecb651cf';

/** Exact ordered plan: names and SHA-256 of the exact bytes on main (e191147d). */
export const OPS_0227_0244_FILES = Object.freeze([
  ['0227_owner_intel_reads.sql', '7e0d5efb1fdd99020b9f49292aa3fc06231c2ebabc99828c58a8959f8b06ece9'],
  ['0228_competitor_intel_ingest.sql', '8aec846b8a170ff36fcd6bd6036a3c725ced3e1c0e9b0677bdc9a9661e360b8d'],
  ['0229_owner_intel_source_feed.sql', '50e6dbd1899a2e601e8218feb4d7af4ca60717551c768b8d904f56cad4ac4c5d'],
  ['0230_app_release_pilot.sql', '824bdd58e12a2db1821131aadec48982ff324219cd15c257d7ccc897eaabe45b'],
  ['0231_owner_google_ads_summary.sql', 'd1c778d0e10a21b25663f89783ceb7ace664e4d70eb2b5e121375e6ef1f80481'],
  ['0240_flight_logs_permissions.sql', '7dae537a441d929cb8d33390dc88abe2ba766886a5b4d6bf2b0861575e41eb3a'],
  ['0241_staff_usernames.sql', '44a707432e16ea06c8ea161d4181582baa6fa2b916b654cae92165d5989e53c5'],
  ['0242_native_staff_onboarding_approval_actor_authority.sql', '045db046a21b80e42aec764cb693615cca8737a2a0a4686676d60baf15664cee'],
  ['0243_staff_logs_device_eligibility.sql', '60dee9a1e92fc881d52f2f7d21b0307f6afe1571d07421c929c3e0defea179b5'],
  ['0244_staff_operations_access_writer.sql', 'e291acac31395ae7bd22c5b43ed44331ee9f989f074869a92dd26dd69547f815'],
].map(([name, sha256]) => Object.freeze({ name, sha256 })));

/** Expected prior ledger: the actual production observation (226 rows, ids 1..226). */
export const OPS_0227_0244_PRIOR_LEDGER = Object.freeze({
  count: 226, lastMigration: '0226_staff_login_bindings.sql',
  namesSha256: 'cfbd55059a5e08b52809561c0b466eb59e1e90adeb56f7421627fcf4a57e01e2',
});
export const OPS_0227_0244_FINAL_LEDGER = Object.freeze({
  count: 236, lastMigration: '0244_staff_operations_access_writer.sql',
  namesSha256: 'f06a64313acf8c1efc046133e59d9dde5a15a7c5a40bd0eba80fb73c679db422',
});
/** The fixed production database the 0226 precedent already pins. Used only to refuse rehearsal mistakes. */
export const OPS_PRODUCTION_DATABASE = Object.freeze({
  accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', databaseName: 'ltds-ops', databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd',
});
/**
 * The approved production schema outside the ten files: every object none of them creates, by the digest of
 * ops0227To0244ExistingSchema. It includes seven production-only receipt and ledger objects that are kept as they
 * are. Production reads, writes, reconciles and resumes are refused on any other value.
 */
export const OPS_PRODUCTION_EXISTING_SCHEMA = Object.freeze({
  objectCount: 2472, sha256: 'b05eb4958761549c7112518856970c010fe408dfb355d40d262595e012ab4e9b',
});
export const OPS_0227_0244_AUTHORITY_NOTE = 'recapture the post-0226 authority snapshot (role_permissions changed)';
export const OPS_0244_AUTHORITY_NOTE = 'recapture the post-0226 authority snapshot (0244 added the staff_permission_overrides guards and the 15-row catalog seed)';
/** Other production D1 ids already pinned in the repo; never a rehearsal target. */
export const OPS_0227_0244_REFUSED_DATABASE_IDS = Object.freeze(['7f40a7b7-c3ec-470e-a626-e798867f71f8']);
/** D1 caps a single string value near 2 MB; a larger snapshot is flagged in the receipt. */
export const OPS_0227_0244_SNAPSHOT_WARN_BYTES = 1_500_000;
export const OPS_0227_0244_CONFIRMATION = databaseName => `APPLY 0227-0244 TO ${databaseName}`;
export const OPS_0244_CATALOG_PERMISSION_KEYS = Object.freeze(['operations.view_all', 'sops.assign', 'delivery.browse',
  'delivery.share.create', 'delivery.share.revoke', 'delivery.share.audit', 'team.view', 'administration.view',
  'viewer.view', 'viewer.datasets.manage', 'viewer.processing.manage', 'viewer.publish', 'viewer.share.create',
  'viewer.share.revoke', 'viewer.manage']);
export const LEDGER_INSERT_SQL = 'INSERT INTO d1_migrations(name) VALUES (?)';

const SHA = /^[a-f0-9]{64}$/u;
const IDENT = /^[a-z][a-z0-9_]{0,62}$/u;
const MAX_ROWS = 20_000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`ops_0227_0244:${code}`); };
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => isPlain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
export const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('json_value_invalid');
};
const schemaRowsSha256 = rows => hash(JSON.stringify(rows.map(row => [row.type, row.name, row.tbl_name, row.sql])));
const namesSha256 = rows => hash(rows.map(row => row.name).join('\n'));
const sqlList = values => values.map(value => `'${value}'`).join(',');

// ---------------------------------------------------------------------------
// Local verification (no remote access)

/** Verifies the exact local bytes and the pinned wire fixture, then returns the ordered plan. */
export function loadVerifiedOps0227To0244Plan({ root = ROOT } = {}) {
  const sources = OPS_0227_0244_FILES.map(({ name, sha256 }) => {
    let bytes;
    try { bytes = fs.readFileSync(path.join(root, 'apps', 'operations', 'migrations', name)); }
    catch { fail(`local_migration_missing:${name}`); }
    if (hash(bytes) !== sha256) fail(`local_migration_hash_mismatch:${name}`);
    return { name, sha256 };
  });
  let bytes, fixture;
  try { bytes = fs.readFileSync(path.join(root, ...OPS_0227_0244_FIXTURE_RELATIVE.split('/'))); }
  catch { fail('wire_fixture_missing'); }
  if (hash(bytes) !== OPS_0227_0244_FIXTURE_SHA256) fail('wire_fixture_hash_mismatch');
  try { fixture = JSON.parse(bytes.toString('utf8')); } catch { fail('wire_fixture_invalid'); }
  if (!isPlain(fixture) || fixture.schemaVersion !== 1 || fixture.contract !== 'production-ops-0227-0244-wrangler-wire-v1'
    || canonical(fixture.priorLedger) !== canonical(OPS_0227_0244_PRIOR_LEDGER)
    || canonical(fixture.finalLedger) !== canonical(OPS_0227_0244_FINAL_LEDGER)
    || !Array.isArray(fixture.files) || fixture.files.length !== sources.length) fail('wire_fixture_invalid');
  const files = sources.map((source, index) => {
    const row = fixture.files[index];
    if (!isPlain(row) || row.order !== index + 1 || row.name !== source.name || row.sourceSha256 !== source.sha256
      || row.ledgerId !== OPS_0227_0244_PRIOR_LEDGER.count + index + 1
      || !Array.isArray(row.statements) || row.statements.length !== row.statementCount || row.statementCount < 1
      || row.statements.some(statement => typeof statement !== 'string' || statement.trim() === '' || /^\s*PRAGMA\s+foreign_keys/iu.test(statement))
      || hash(JSON.stringify(row.statements)) !== row.statementsSha256
      || !Array.isArray(row.expectedAddedObjects) || row.expectedAddedObjects.length !== row.expectedAddedObjectCount
      || row.expectedAddedObjects.some(object => !exactKeys(object, ['type', 'name', 'tbl_name'])
        || !['table', 'index', 'view', 'trigger'].includes(object.type) || !IDENT.test(object.name) || !IDENT.test(object.tbl_name))
      || !SHA.test(row.expectedAddedSchemaSha256 ?? '') || !isPlain(row.expectedNewTableRows)
      || Object.entries(row.expectedNewTableRows).some(([table, count]) => !IDENT.test(table) || !Number.isSafeInteger(count) || count < 0
        || !row.expectedAddedObjects.some(object => object.type === 'table' && object.name === table))) fail('wire_fixture_invalid');
    return Object.freeze({
      order: row.order, name: row.name, ledgerId: row.ledgerId, sha256: row.sourceSha256,
      statementCount: row.statementCount, statementsSha256: row.statementsSha256,
      statements: Object.freeze([...row.statements]),
      expectedAddedObjects: Object.freeze(row.expectedAddedObjects.map(object => Object.freeze({ ...object }))),
      expectedAddedObjectCount: row.expectedAddedObjectCount, expectedAddedSchemaSha256: row.expectedAddedSchemaSha256,
      expectedNewTableRows: Object.freeze({ ...row.expectedNewTableRows }),
    });
  });
  const summary = { schemaVersion: 1, contract: OPS_0227_0244_CONTRACT, fixtureSha256: OPS_0227_0244_FIXTURE_SHA256,
    priorLedger: OPS_0227_0244_PRIOR_LEDGER, finalLedger: OPS_0227_0244_FINAL_LEDGER,
    files: files.map(({ statements, expectedAddedObjects, ...rest }) => rest) };
  return Object.freeze({ ...summary, planSha256: hash(canonical(summary)), files: Object.freeze(files) });
}

// ---------------------------------------------------------------------------
// Read-only queries

const PROBES_SQL = `json_object(
    'ownerAdminRoles',(SELECT count(*) FROM roles WHERE id IN ('role-owner','role-admin')),
    'flightLogsPermissions',(SELECT count(*) FROM permissions WHERE substr(key,1,12)='flight_logs.'),
    'flightLogsRolePermissions',(SELECT count(*) FROM role_permissions WHERE permission_key IN ('flight_logs.view','flight_logs.import')),
    'claimedOnboarding',(SELECT count(*) FROM native_staff_pending_onboarding WHERE state='claimed'),
    'onboardingApprovers',(SELECT count(*) FROM native_staff_management_delegations WHERE capability='staff.onboarding.approve'
      AND effect='allow' AND scope_kind='global' AND active=1 AND contract_version=1),
    'staffLoginPrerequisiteTables',(SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN
      ('staff_login_generations','staff_login_bindings','staff_login_binding_intents')),
    'catalogPermissionKeys',(SELECT count(*) FROM permissions WHERE key IN (${sqlList(OPS_0244_CATALOG_PERMISSION_KEYS)})),
    'nativeHireOverrides',(SELECT count(*) FROM staff_permission_overrides o WHERE o.staff_id IN (
      SELECT onboarding.proposed_staff_id FROM native_staff_pending_onboarding onboarding
      JOIN native_staff_management_commands receipt ON receipt.command_id=onboarding.approval_command_id
      WHERE onboarding.state='approved' AND receipt.capability='staff.onboarding.approve'
        AND receipt.target_kind='onboarding' AND receipt.target_onboarding_id=onboarding.onboarding_id
        AND receipt.target_proposed_staff_id=onboarding.proposed_staff_id)),
    'nativeHires',(SELECT count(*) FROM native_staff_pending_onboarding onboarding
      JOIN native_staff_management_commands receipt ON receipt.command_id=onboarding.approval_command_id
      WHERE onboarding.state='approved' AND receipt.capability='staff.onboarding.approve'
        AND receipt.target_kind='onboarding' AND receipt.target_onboarding_id=onboarding.onboarding_id
        AND receipt.target_proposed_staff_id=onboarding.proposed_staff_id),
    'nativeStaffReconciliationRows',(SELECT count(*) FROM native_staff_access_reconciliation),
    'nativeStaffReconciliationEnabled',(SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1),
    'staffUsersViewColumns',(SELECT count(*) FROM pragma_table_info('staff_users') WHERE name IN
      ('provisioning_source','sync_protected','project_alpha_user_id','access_subject','status')),
    'ledgerSequence',(SELECT seq FROM sqlite_sequence WHERE name='d1_migrations'),
    'rolesRows',(SELECT count(*) FROM roles),
    'permissionsRows',(SELECT count(*) FROM permissions),
    'rolePermissionsRows',(SELECT count(*) FROM role_permissions),
    'staffUsersRows',(SELECT count(*) FROM staff_users),
    'staffPermissionOverridesRows',(SELECT count(*) FROM staff_permission_overrides))`;
const PROBE_KEYS = Object.freeze(['ownerAdminRoles', 'flightLogsPermissions', 'flightLogsRolePermissions', 'claimedOnboarding',
  'onboardingApprovers', 'staffLoginPrerequisiteTables', 'catalogPermissionKeys', 'nativeHireOverrides', 'nativeHires',
  'nativeStaffReconciliationRows', 'nativeStaffReconciliationEnabled', 'staffUsersViewColumns', 'ledgerSequence',
  'rolesRows', 'permissionsRows', 'rolePermissionsRows', 'staffUsersRows', 'staffPermissionOverridesRows']);
const NULLABLE_PROBES = new Set(['nativeStaffReconciliationEnabled', 'ledgerSequence']);
/** Existing tables whose row counts are tracked across the run (counts only). */
const TRACKED_ROWS = Object.freeze(['rolesRows', 'permissionsRows', 'rolePermissionsRows', 'staffUsersRows', 'staffPermissionOverridesRows']);

/**
 * Schema objects are read as ordinary rows, not folded into one JSON value: the full Ops schema SQL is
 * about 2.7 MB, above D1's ~2 MB per-value limit. Each snapshot is one read-only batch of two SELECTs.
 */
export const OPS_0227_0244_SCHEMA_ROWS_SQL = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL "
  + "AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name";

/** One read-only SELECT. `tables` adds row counts for tables a step created (post-check only). */
export function ops0227To0244SnapshotQuery(tables = []) {
  if (!Array.isArray(tables) || tables.some(table => !IDENT.test(table))) fail('read_query_tables_invalid');
  const tableRows = tables.length === 0 ? 'json_object()'
    : `json_object(${tables.map(table => `'${table}',(SELECT count(*) FROM "${table}")`).join(',')})`;
  return `SELECT json_object(
  'ledger',json((SELECT json_group_array(json_object('id',id,'name',name)) FROM (SELECT id,name FROM d1_migrations ORDER BY id))),
  'probes',${PROBES_SQL},
  'tableRows',${tableRows}) AS ops_0227_0244_snapshot`;
}
export const OPS_0227_0244_PRE_READ_QUERY = ops0227To0244SnapshotQuery();
const WRITE_WORD = /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA\s+\w+\s*=|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT)\b/iu;
export function isOps0227To0244ReadQuery(query) {
  return typeof query === 'string' && query.startsWith('SELECT json_object(\n  \'ledger\'')
    && query.endsWith(' AS ops_0227_0244_snapshot') && !WRITE_WORD.test(query.replace(/'[^']*'/gu, "''")) && !query.includes(';');
}

/**
 * Parses the D1 `/query` batch result [snapshot, schema rows]; both must be zero-write primary reads.
 * `snapshotBytes` is the largest single value returned, the figure that D1's per-value limit applies to.
 */
export function parseOps0227To0244SnapshotResult(value, { observedAt } = {}) {
  let payload; try { payload = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail('read_result_invalid'); }
  if (!Array.isArray(payload) || payload.length !== 2 || payload.some(item => item?.success !== true || !Array.isArray(item.results)
    || item.meta?.rows_written !== 0 || item.meta?.changed_db !== false || item.meta?.served_by_primary !== true)
    || payload[0].results.length !== 1 || typeof payload[0].results[0]?.ops_0227_0244_snapshot !== 'string'
    || Buffer.byteLength(payload[0].results[0].ops_0227_0244_snapshot) > 24 * 1024 * 1024
    || payload[1].results.length > MAX_ROWS) fail('read_result_invalid');
  let snapshot; try { snapshot = JSON.parse(payload[0].results[0].ops_0227_0244_snapshot); } catch { fail('read_result_invalid'); }
  if (!isPlain(snapshot) || Object.hasOwn(snapshot, 'schema')) fail('read_result_invalid');
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) fail('read_result_invalid');
  const schema = payload[1].results.map(row => ({ type: row?.type, name: row?.name, tbl_name: row?.tbl_name, sql: row?.sql }));
  const snapshotBytes = Math.max(Buffer.byteLength(payload[0].results[0].ops_0227_0244_snapshot),
    ...schema.map(row => (typeof row.sql === 'string' ? Buffer.byteLength(row.sql) : 0)));
  return validateSnapshot({ ...snapshot, schema, observedAt, snapshotBytes });
}

function validateSnapshot(snapshot) {
  if (!exactKeys(snapshot, ['ledger', 'schema', 'probes', 'tableRows', 'observedAt', 'snapshotBytes'])
    || !Number.isSafeInteger(snapshot.snapshotBytes)) fail('snapshot_invalid');
  const { ledger, schema, probes, tableRows } = snapshot;
  if (!Array.isArray(ledger) || ledger.length > MAX_ROWS || ledger.some((row, index) => !exactKeys(row, ['id', 'name'])
    || !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.name !== 'string' || row.name.length === 0
    || (index > 0 && ledger[index - 1].id >= row.id)) || new Set(ledger.map(row => row.name)).size !== ledger.length) fail('ledger_invalid');
  if (!Array.isArray(schema) || schema.length > MAX_ROWS || schema.some(row => !exactKeys(row, ['type', 'name', 'tbl_name', 'sql'])
    || !['table', 'index', 'view', 'trigger'].includes(row.type) || typeof row.name !== 'string'
    || typeof row.tbl_name !== 'string' || typeof row.sql !== 'string')) fail('schema_invalid');
  if (!exactKeys(probes, PROBE_KEYS) || PROBE_KEYS.some(key => !(NULLABLE_PROBES.has(key) && probes[key] === null)
    && (!Number.isSafeInteger(probes[key]) || probes[key] < 0))) fail('probes_invalid');
  if (!isPlain(tableRows) || Object.values(tableRows).some(count => !Number.isSafeInteger(count) || count < 0)) fail('table_rows_invalid');
  return snapshot;
}

// ---------------------------------------------------------------------------
// Checks

const objectKey = row => `${row.type}\0${row.name}`;
const check = (name, expected, observed) => ({ name, expected, observed, ok: canonical(expected) === canonical(observed) });

function ledgerChecks(snapshot, initialLedger, plan, index) {
  const expectedCount = OPS_0227_0244_PRIOR_LEDGER.count + index;
  const tail = index === 0 ? OPS_0227_0244_PRIOR_LEDGER.lastMigration : plan.files[index - 1].name;
  const expectedRows = [...initialLedger, ...plan.files.slice(0, index).map((file, offset) => ({
    id: initialLedger.at(-1).id + offset + 1, name: file.name }))];
  return [
    check('ledger_count', expectedCount, snapshot.ledger.length),
    check('ledger_tail', tail, snapshot.ledger.at(-1)?.name ?? null),
    check('ledger_history_unchanged', true, canonical(snapshot.ledger) === canonical(expectedRows)),
  ];
}

function initialLedgerChecks(snapshot, plan) {
  const ledger = snapshot.ledger;
  const planned = new Set(plan.files.map(file => file.name));
  return [
    check('ledger_count', OPS_0227_0244_PRIOR_LEDGER.count, ledger.length),
    check('ledger_tail', OPS_0227_0244_PRIOR_LEDGER.lastMigration, ledger.at(-1)?.name ?? null),
    check('ledger_names_sha256', OPS_0227_0244_PRIOR_LEDGER.namesSha256, namesSha256(ledger)),
    check('ledger_ids_contiguous', true, ledger.every((row, index) => row.id === index + 1)),
    check('planned_files_already_in_ledger', 0, ledger.filter(row => planned.has(row.name)).length),
  ];
}

function fileObjectsRows(snapshot, file) {
  const names = new Set(file.expectedAddedObjects.map(object => object.name));
  return snapshot.schema.filter(row => names.has(row.name));
}

/**
 * Read-only reconciliation of a snapshot against the ordered plan. It proves the
 * ledger is the exact pinned 226-row prior ledger followed by an exact ordered
 * prefix of the ten files (ids contiguous from 227), every recorded file's objects
 * exist exactly as pinned, and no object of any unrecorded file exists.
 */
export function ops0227To0244LedgerPosition(snapshot, plan) {
  const prior = OPS_0227_0244_PRIOR_LEDGER.count, ledger = snapshot.ledger;
  let exact = 0;
  while (exact < plan.files.length && ledger[prior + exact]?.name === plan.files[exact].name && ledger[prior + exact]?.id === prior + exact + 1) exact++;
  const expectedNextFile = ledger.length < prior ? OPS_0227_0244_FILES[0].name : plan.files[exact]?.name ?? null;
  return { ledgerCount: ledger.length, ledgerTail: ledger.at(-1)?.name ?? null, expectedNextFile, exactPrefixCount: exact,
    message: `ledger has ${ledger.length} rows ending ${ledger.at(-1)?.name ?? 'nothing'}; expected next file ${expectedNextFile ?? 'none (all ten recorded)'}` };
}

/**
 * Loads the start row counts from an earlier receipt of this tool (the first run's receipt, or a resumed
 * run's receipt, which carries the same start counts forward). Counts only; no identities.
 */
export function loadOps0227To0244BaselineReceipt(filename, { plan, target } = {}) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('baseline_receipt_path_invalid');
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('baseline_receipt_unreadable'); }
  const start = value?.rowCounts?.start;
  if (!isPlain(value) || value.contract !== OPS_0227_0244_CONTRACT || value.planSha256 !== plan.planSha256
    || value.target?.databaseId !== target.databaseId || value.target?.accountId !== target.accountId
    || !exactKeys(start, TRACKED_ROWS) || TRACKED_ROWS.some(key => !Number.isSafeInteger(start[key]) || start[key] < 0)
    || !Number.isSafeInteger(value.finalLedger?.count) || typeof value.finalLedger?.lastMigration !== 'string'
    || !exactKeys(value.existingSchema, ['objectCount', 'sha256']) || !Number.isSafeInteger(value.existingSchema.objectCount)
    || !SHA.test(value.existingSchema.sha256 ?? ''))
    fail('baseline_receipt_invalid');
  // The approved fingerprint is a source constant; a receipt can never introduce another production baseline.
  if (isProductionTarget(target) && canonical(value.existingSchema) !== canonical(OPS_PRODUCTION_EXISTING_SCHEMA))
    fail('baseline_receipt_existing_schema_not_approved');
  return Object.freeze({ startCounts: Object.freeze({ ...start }), stopPhase: value.stop?.phase ?? null,
    stopCode: value.stop?.code ?? null, stopStep: value.stop?.step ?? null,
    existingSchema: Object.freeze({ ...value.existingSchema }),
    finalLedger: Object.freeze({ count: value.finalLedger.count, lastMigration: value.finalLedger.lastMigration }) });
}

/** Digest (type, name, tbl_name, sql) of every schema object that none of the ten files creates. */
export function ops0227To0244ExistingSchema(snapshot, plan) {
  const planNames = new Set(plan.files.flatMap(file => file.expectedAddedObjects.map(object => object.name)));
  const rows = snapshot.schema.filter(row => !planNames.has(row.name));
  return { objectCount: rows.length, sha256: schemaRowsSha256(rows) };
}

/** Production is identified by its database id alone, never by a caller-supplied environment label. */
const isProductionTarget = target => target?.databaseId === OPS_PRODUCTION_DATABASE.databaseId;

const approvedSchemaCheck = (snapshot, plan, approved) =>
  check('approved_existing_schema', approved, ops0227To0244ExistingSchema(snapshot, plan));
const approvedSchemaMessage = item => `objects outside the plan are not the approved schema: expected ${item.expected.objectCount} `
  + `(${item.expected.sha256}), observed ${item.observed.objectCount} (${item.observed.sha256})`;

export function reconcileOps0227To0244Snapshot(snapshot, plan, baseline = null, approvedSchema = null) {
  const prior = OPS_0227_0244_PRIOR_LEDGER.count, ledger = snapshot.ledger;
  const position = ops0227To0244LedgerPosition(snapshot, plan);
  const base = ledger.slice(0, prior), suffix = ledger.slice(prior);
  const checks = [
    check('prior_ledger_present', true, ledger.length >= prior && ledger.length <= prior + plan.files.length),
    check('prior_ledger_names_sha256', OPS_0227_0244_PRIOR_LEDGER.namesSha256, namesSha256(base)),
    check('prior_ledger_ids_contiguous', true, base.every((row, index) => row.id === index + 1)),
    check('recorded_rows_exact_ordered_prefix', true, suffix.every((row, index) => plan.files[index] !== undefined
      && row.name === plan.files[index].name && row.id === prior + index + 1)),
  ];
  const bad = failed(checks);
  if (bad) return { ok: false, code: `reconciliation_required:${bad.name}`, appliedCount: null, nextStep: null, ...position, checks };
  const applied = suffix.length, p = snapshot.probes;
  plan.files.forEach((file, index) => {
    const rows = fileObjectsRows(snapshot, file);
    if (index < applied) {
      checks.push(check(`recorded_objects_exact:${file.name}`, { objects: file.expectedAddedObjects, sha256: file.expectedAddedSchemaSha256 },
        { objects: rows.map(({ type, name, tbl_name }) => ({ type, name, tbl_name })), sha256: schemaRowsSha256(rows) }));
      // Seeded rows of the file's own new tables (controls, 0244 catalog) must still be exactly the pinned seed.
      for (const [table, count] of Object.entries(file.expectedNewTableRows)) {
        if (count > 0) checks.push(check(`recorded_seed_rows:${table}`, count, snapshot.tableRows[table] ?? null));
      }
      if (file.name.startsWith('0240')) checks.push(check(`recorded_grants:${file.name}`, { permissions: 2, rolePermissions: 2 * p.ownerAdminRoles },
        { permissions: p.flightLogsPermissions, rolePermissions: p.flightLogsRolePermissions }));
    } else {
      checks.push(check(`unrecorded_objects_absent:${file.name}`, 0, rows.length));
      if (file.name.startsWith('0240')) checks.push(check(`unrecorded_grants_absent:${file.name}`, 0, p.flightLogsPermissions));
    }
  });
  const badObject = failed(checks);
  if (badObject) return { ok: false, code: `reconciliation_required:${badObject.name}`, appliedCount: applied, nextStep: null, ...position, checks };
  // Independent of any receipt: the schema outside the plan must be the approved one before anything continues.
  if (approvedSchema) {
    const approved = approvedSchemaCheck(snapshot, plan, approvedSchema);
    checks.push(approved);
    if (!approved.ok) return { ok: false, code: 'reconciliation_required:approved_existing_schema_mismatch', appliedCount: applied, nextStep: null,
      ...position, message: `${position.message}; ${approvedSchemaMessage(approved)}`, checks };
  }
  if (applied > 0) {
    // Row-count invariants (M3) need the start counts of the run that wrote the recorded prefix.
    if (!baseline) return { ok: false, code: 'reconciliation_required:baseline_receipt_required', appliedCount: applied, nextStep: null,
      ...position, message: `${position.message}; pass --baseline-receipt with the earlier receipt`, checks };
    if (baseline.stopPhase === 'post-check' || /postcheck_failed|post_check_failed/u.test(baseline.stopCode ?? ''))
      return { ok: false, code: 'reconciliation_required:baseline_receipt_postcheck_failed', appliedCount: applied, nextStep: null,
        ...position, message: `${position.message}; the earlier run stopped on a failed post-check (${baseline.stopCode})`, checks };
    // The baseline must be the latest receipt: its final ledger equals the current ledger. After an ambiguous
    // apply or a failed post-apply read, the ledger may also hold that one file's row.
    const accepted = [{ count: baseline.finalLedger.count, lastMigration: baseline.finalLedger.lastMigration }];
    if (/apply_ambiguous|post_read_failed/u.test(baseline.stopCode ?? '') && baseline.stopStep)
      accepted.push({ count: baseline.finalLedger.count + 1, lastMigration: baseline.stopStep });
    const latest = check('baseline_receipt_is_latest', true, accepted.some(row => row.count === ledger.length
      && row.lastMigration === (ledger.at(-1)?.name ?? null)));
    checks.push(latest);
    if (!latest.ok) return { ok: false, code: 'reconciliation_required:baseline_receipt_not_latest', appliedCount: applied, nextStep: null,
      ...position, message: `${position.message}; the baseline receipt recorded ${baseline.finalLedger.count} rows ending `
        + `${baseline.finalLedger.lastMigration}. Use the latest receipt`, checks };
    // Every schema object outside the plan must be exactly as it was at the 226 start (N7).
    const existing = ops0227To0244ExistingSchema(snapshot, plan);
    const existingCheck = check('existing_schema_unchanged_since_start', baseline.existingSchema, existing);
    checks.push(existingCheck);
    if (!existingCheck.ok) return { ok: false, code: 'reconciliation_required:existing_schema_changed', appliedCount: applied, nextStep: null,
      ...position, message: `${position.message}; objects outside the plan changed: expected ${baseline.existingSchema.objectCount} `
        + `(${baseline.existingSchema.sha256}), observed ${existing.objectCount} (${existing.sha256})`, checks };
    const has0240 = plan.files.slice(0, applied).some(file => file.name.startsWith('0240'));
    const expected = { ...baseline.startCounts,
      permissionsRows: baseline.startCounts.permissionsRows + (has0240 ? 2 : 0),
      rolePermissionsRows: baseline.startCounts.rolePermissionsRows + (has0240 ? 2 * p.ownerAdminRoles : 0) };
    const countChecks = TRACKED_ROWS.map(key => check(`row_count:${key}`, expected[key], p[key]));
    checks.push(...countChecks);
    const differ = countChecks.filter(item => !item.ok);
    if (differ.length > 0) return { ok: false, code: 'reconciliation_required:row_counts_differ', appliedCount: applied, nextStep: null,
      ...position, message: `${position.message}; counts differ: ${differ.map(item => `${item.name.slice(10)} (expected ${item.expected}, observed ${item.observed})`).join(', ')}`,
      checks };
  }
  return { ok: true, code: null, appliedCount: applied, ...position,
    nextStep: applied < plan.files.length ? plan.files[applied].name : null, checks };
}

function stepPreflightChecks(snapshot, file, plan, approvedSchema) {
  const p = snapshot.probes, checks = [
    check('ledger_sequence', snapshot.ledger.at(-1)?.id ?? null, p.ledgerSequence),
    check('file_objects_absent', 0, fileObjectsRows(snapshot, file).length),
  ];
  if (approvedSchema) checks.push(approvedSchemaCheck(snapshot, plan, approvedSchema));
  const short = file.name.slice(0, 4);
  if (short === '0240') checks.push(check('owner_admin_roles', 2, p.ownerAdminRoles), check('flight_logs_permissions_absent', 0, p.flightLogsPermissions));
  if (short === '0242') checks.push(check('claimed_onboarding', 0, p.claimedOnboarding));
  if (short === '0243') checks.push(check('staff_login_prerequisite_tables', 3, p.staffLoginPrerequisiteTables));
  if (short === '0244') checks.push(check('catalog_permission_keys', 15, p.catalogPermissionKeys),
    check('native_hire_overrides', 0, p.nativeHireOverrides),
    check('native_staff_reconciliation_rows', 1, p.nativeStaffReconciliationRows),
    check('native_staff_reconciliation_enabled', 0, p.nativeStaffReconciliationEnabled),
    check('staff_users_view_columns', 5, p.staffUsersViewColumns));
  return checks;
}

function recordedCounts(snapshot, file) {
  const short = file.name.slice(0, 4), p = snapshot.probes;
  if (short === '0242') return { onboardingApprovers: p.onboardingApprovers };
  if (short === '0244') return { nativeHires: p.nativeHires };
  return {};
}

const trackedCounts = snapshot => Object.fromEntries(TRACKED_ROWS.map(key => [key, snapshot.probes[key]]));

function postChecks(before, after, file, runInitial) {
  const expectedLedger = [...before.ledger, { id: before.ledger.at(-1).id + 1, name: file.name }];
  const beforeKeys = new Set(before.schema.map(objectKey));
  const kept = after.schema.filter(row => beforeKeys.has(objectKey(row)));
  const added = after.schema.filter(row => !beforeKeys.has(objectKey(row)));
  const present = fileObjectsRows(after, file);
  const readback = { ledgerCount: after.ledger.length, ledgerTail: after.ledger.at(-1) ?? null,
    expectedObjects: file.expectedAddedObjectCount, objectsPresent: present.length };
  const checks = [
    check('readback_ledger_tail', { id: before.ledger.at(-1).id + 1, name: file.name }, readback.ledgerTail),
    check('readback_objects_present', file.expectedAddedObjectCount, present.length),
    check('ledger_row_appended', true, canonical(after.ledger) === canonical(expectedLedger)),
    check('existing_schema_unchanged', true, canonical(kept) === canonical(before.schema)),
    check('added_objects', file.expectedAddedObjects, added.map(({ type, name, tbl_name }) => ({ type, name, tbl_name }))),
    check('added_schema_sha256', file.expectedAddedSchemaSha256, schemaRowsSha256(added)),
    check('new_table_rows', file.expectedNewTableRows, after.tableRows),
  ];
  if (file.name.startsWith('0240')) checks.push(check('flight_logs_permissions', 2, after.probes.flightLogsPermissions),
    check('flight_logs_role_permissions', 2 * before.probes.ownerAdminRoles, after.probes.flightLogsRolePermissions));
  const rowDeltas = Object.fromEntries(TRACKED_ROWS.map(key => [key, after.probes[key] - before.probes[key]]));
  const is0240 = file.name.startsWith('0240');
  const roleGrantDelta = after.probes.flightLogsRolePermissions - before.probes.flightLogsRolePermissions;
  checks.push(
    check('roles_rows_unchanged', 0, rowDeltas.rolesRows),
    check('permissions_rows_delta', is0240 ? 2 : 0, rowDeltas.permissionsRows),
    check('role_permissions_rows_delta', is0240 ? (roleGrantDelta > 0 && roleGrantDelta <= 4 ? roleGrantDelta : 'between 1 and 4') : 0,
      rowDeltas.rolePermissionsRows),
    check('staff_users_rows_unchanged_since_start', runInitial.staffUsersRows, after.probes.staffUsersRows),
    check('staff_permission_overrides_rows_unchanged_since_start', runInitial.staffPermissionOverridesRows,
      after.probes.staffPermissionOverridesRows));
  if (file.name.startsWith('0244')) checks.push(check('catalog_rows', 15, after.tableRows.staff_operations_access_catalog ?? null));
  return { checks, addedObjectCount: added.length, readback, rowDeltas };
}

const failed = checks => checks.find(item => !item.ok);
const ledgerSummary = ledger => ({ count: ledger.length, lastMigration: ledger.at(-1)?.name ?? null, namesSha256: namesSha256(ledger) });

// ---------------------------------------------------------------------------
// Receipt

const RECEIPT_WRITE_FAILED = 'ops_0227_0244:receipt_write_failed';
const REFUSAL_RECEIPT_WRITE_FAILED = 'ops_0227_0244:refusal_receipt_write_failed';
const RECEIPT_CLOSE_FAILED = 'ops_0227_0244:receipt_close_failed';
/** Raised inside the ordered run only; it carries the run state that could not be saved. */
class ReceiptWriteFailure extends Error {
  constructor(state, cause) { super(RECEIPT_WRITE_FAILED, { cause }); this.state = state; }
}

/**
 * Windows refuses to replace, and sometimes to read, a file that another process holds open, such as a virus scanner.
 * No request is in flight while this waits, for at most 15 seconds. Only local file operations are tried again.
 */
function whileHeldByOthers(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); } catch (error) {
      if (process.platform !== 'win32' || attempt >= 150 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * Exclusive receipt file. Every write replaces the whole file atomically: the new content goes to `<file>.next`, every
 * byte is written and flushed, the closed file is read back and compared, and only then does it replace the receipt,
 * which is read back once more. The last complete receipt therefore stays in place until a newer one is proven. Any
 * failure is `receipt_write_failed`; the file is then never written again by this process, and `<file>.next` is left
 * as it is. `keep` saves one value, once, as `<file>.pre-apply.json`.
 */
export function openOps0227To0244Receipt(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('receipt_path_invalid');
  try { fs.closeSync(fs.openSync(filename, 'wx', 0o600)); } catch (error) {
    if (error?.code === 'EEXIST') fail('receipt_exists_no_replay');
    fail('receipt_create_failed');
  }
  const next = `${filename}.next`;
  let current = Buffer.alloc(0), broken = false;
  const same = (file, bytes) => { if (!whileHeldByOthers(() => fs.readFileSync(file)).equals(bytes)) throw new Error(`${path.basename(file)} differs`); };
  return {
    write(receipt) {
      if (broken) fail('receipt_write_failed');
      broken = true;
      try {
        const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        JSON.parse(bytes.toString('utf8'));
        const fd = fs.openSync(next, 'wx', 0o600);
        try {
          for (let offset = 0; offset < bytes.length;) {
            const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!Number.isSafeInteger(written) || written < 1 || written > bytes.length - offset) throw new Error('short write');
            offset += written;
          }
          fs.fsyncSync(fd);
        } catch (error) {
          try { fs.closeSync(fd); } catch {}
          throw error;
        }
        fs.closeSync(fd);
        same(next, bytes);
        // Only this process's own last receipt is replaced.
        same(filename, current);
        whileHeldByOthers(() => fs.renameSync(next, filename));
        same(filename, bytes);
        current = bytes;
      } catch (cause) { throw new Error(RECEIPT_WRITE_FAILED, { cause }); }
      broken = false;
    },
    keep(receipt) { openOps0227To0244Receipt(`${filename}.pre-apply.json`).write(receipt); },
    close() {},
  };
}

// ---------------------------------------------------------------------------
// Ordered run

const errorCode = error => (error instanceof Error && /^ops_0227_0244[a-z_]*:/u.test(error.message)) ? error.message
  : (error instanceof Error && /^production_ops_0226_runner_[a-z_]+$/u.test(error.message)) ? `ops_0227_0244:source_check_failed:${error.message}`
    : 'unexpected_error';
// Provider refusals raised before any request is sent. Every other apply error is ambiguous.
const NOT_SENT = /^ops_0227_0244_provider:(?:writes_disabled|target_not_verified|migration_pin_mismatch|migration_already_sent_no_retry|auth_unavailable|configuration_invalid)$/u;
const RECONCILE_NOTE = 'Do not retry. Run --reconcile (read-only); continue only with --execute --resume-from <reported next step>.';

/**
 * Runs the ordered plan against an injected provider:
 *   provider.readSnapshot({ query }) -> parsed snapshot (read-only)
 *   provider.applyMigration({ name, sha256, statements, statementsSha256 }) -> one batch, never retried
 * mode 'dry-run' performs one read and never calls applyMigration; mode 'reconcile' performs one read and
 * only classifies the state. `startIndex` > 0 resumes after a reconciled prefix; the run re-proves it first.
 * On the production database the approved existing schema is always required, in every mode.
 * `approvedExistingSchema` exists only for offline tests on other targets and is refused on production.
 */
export async function runOps0227To0244Ordered(options = {}) {
  try { return await runOrdered(options); }
  catch (error) {
    if (!(error instanceof ReceiptWriteFailure)) throw error;
    // The run ends here: nothing more is read or sent. An earlier stop keeps its own code. 'sending' is saved before
    // the request, so a step that could not save it was never sent.
    const { state } = error;
    const sent = state.steps.some(step => ['acknowledged', 'ambiguous'].includes(step.apply?.outcome));
    if (!state.stop) {
      const code = sent ? 'reconciliation_required:receipt_write_failed' : 'receipt_write_failed';
      state.status = sent ? 'reconciliation-required' : 'stopped';
      state.stop = { step: state.steps.at(-1)?.name ?? null, phase: 'receipt', code };
      options.log?.(`STOP at ${state.stop.step ?? 'start'} (receipt): ${code}`);
    }
    state.receiptFailure = RECEIPT_WRITE_FAILED;
    return state;
  }
}

async function runOrdered({ plan, provider, mode = 'dry-run', target, receipt = null, startIndex = 0,
  approvalRef = null, baseline = null, now = () => new Date(), log = () => {}, approvedExistingSchema = null } = {}) {
  if (!['dry-run', 'execute', 'reconcile'].includes(mode)) fail('mode_invalid');
  if (!plan || plan.contract !== OPS_0227_0244_CONTRACT || !Array.isArray(plan.files) || plan.files.length !== 10) fail('plan_invalid');
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= plan.files.length) fail('start_index_invalid');
  if (!provider || typeof provider.readSnapshot !== 'function' || (mode === 'execute' && typeof provider.applyMigration !== 'function'))
    fail('provider_contract_invalid');
  if (mode === 'execute' && !receipt) fail('receipt_required');
  if (mode === 'execute' && typeof target?.databaseId !== 'string') fail('target_required');
  const production = isProductionTarget(target);
  if (approvedExistingSchema !== null && (production || !exactKeys(approvedExistingSchema, ['objectCount', 'sha256'])
    || !Number.isSafeInteger(approvedExistingSchema.objectCount) || !SHA.test(approvedExistingSchema.sha256 ?? '')))
    fail('approved_existing_schema_override_refused');
  const approvedSchema = production ? OPS_PRODUCTION_EXISTING_SCHEMA : approvedExistingSchema;
  if (production && baseline && canonical(baseline.existingSchema) !== canonical(approvedSchema)) fail('baseline_receipt_existing_schema_not_approved');
  const stamp = () => now().toISOString();
  const state = {
    schemaVersion: 2, contract: OPS_0227_0244_CONTRACT, mode, planSha256: plan.planSha256, fixtureSha256: plan.fixtureSha256,
    target: target ?? null, approvalRef, resumeFrom: startIndex > 0 ? plan.files[startIndex].name : null,
    startedAt: stamp(), finishedAt: null, status: 'running', stop: null,
    files: plan.files.map(({ order, name, ledgerId, sha256, statementCount, statementsSha256, expectedAddedObjectCount }) =>
      ({ order, name, ledgerId, sha256, statementCount, statementsSha256, expectedAddedObjectCount })),
    initial: null, reconcile: null, steps: [], notes: [], rowCounts: null, existingSchema: null,
    approvedExistingSchema: approvedSchema ? { expected: { ...approvedSchema }, observed: null, ok: false } : null,
    finalLedger: null, writesPerformed: 0,
  };
  const noteSize = (where, snapshot) => {
    if (snapshot.snapshotBytes > OPS_0227_0244_SNAPSHOT_WARN_BYTES)
      state.notes.push(`Snapshot at ${where} is ${snapshot.snapshotBytes} bytes, near the D1 per-value limit.`);
  };
  const persist = () => { if (receipt) try { receipt.write(state); } catch (cause) { throw new ReceiptWriteFailure(state, cause); } };
  // Saved once, before the first file is sent: the proven starting point of this run, whatever happens later.
  let kept = false;
  const keepPreApply = ledger => {
    if (kept || !receipt?.keep) return;
    try { receipt.keep({ ...state, status: 'pre-apply', finalLedger: ledgerSummary(ledger) }); } catch (cause) { throw new ReceiptWriteFailure(state, cause); }
    kept = true;
  };
  const stop = (step, phase, code, detail = null) => {
    state.status = code.startsWith('reconciliation_required') ? 'reconciliation-required' : 'stopped';
    state.stop = { step, phase, code, ...(detail ? { detail } : {}) };
    if (state.status === 'reconciliation-required' && !state.notes.includes(RECONCILE_NOTE)) state.notes.push(RECONCILE_NOTE);
    log(`STOP at ${step ?? 'start'} (${phase}): ${code}`);
  };
  const read = async query => provider.readSnapshot({ query });
  persist();
  let current;
  try { current = await read(OPS_0227_0244_PRE_READ_QUERY); }
  catch (error) { stop(null, 'initial-read', errorCode(error)); }
  if (current) {
    const recordedPrefix = ops0227To0244LedgerPosition(current, plan).exactPrefixCount;
    const existingTables = new Set(current.schema.filter(row => row.type === 'table').map(row => row.name));
    const seedTables = plan.files.slice(0, recordedPrefix).flatMap(file => Object.entries(file.expectedNewTableRows)
      .filter(([table, count]) => count > 0 && existingTables.has(table)).map(([table]) => table)).sort();
    if (seedTables.length > 0) {
      try { current = await read(ops0227To0244SnapshotQuery(seedTables)); }
      catch (error) { stop(null, 'initial-read', errorCode(error)); current = null; }
    }
  }
  if (current) {
    const rec = reconcileOps0227To0244Snapshot(current, plan, baseline, approvedSchema);
    const approved = approvedSchema ? approvedSchemaCheck(current, plan, approvedSchema) : null;
    if (approved) state.approvedExistingSchema = { expected: approved.expected, observed: approved.observed, ok: approved.ok };
    state.reconcile = { ok: rec.ok, code: rec.code, appliedCount: rec.appliedCount, nextStep: rec.nextStep, ledgerCount: rec.ledgerCount,
      expectedNextFile: rec.expectedNextFile, message: rec.message, checks: rec.checks };
    state.initial = { observedAt: current.observedAt, snapshotBytes: current.snapshotBytes, ledger: ledgerSummary(current.ledger),
      schemaObjectCount: current.schema.length, checks: startIndex === 0 && mode !== 'reconcile' ? initialLedgerChecks(current, plan) : [] };
    // `start` is the count set at the 226 start of the whole apply; a resumed run carries it forward.
    state.rowCounts = { start: rec.appliedCount > 0 && baseline ? { ...baseline.startCounts } : trackedCounts(current),
      thisRunInitial: trackedCounts(current), final: null };
    // The digest of objects outside the plan at the 226 start; a resumed run carries it forward.
    state.existingSchema = rec.appliedCount > 0 && baseline ? { ...baseline.existingSchema } : ops0227To0244ExistingSchema(current, plan);
    noteSize('start', current);
    if (mode === 'reconcile') {
      if (!rec.ok) stop(null, 'reconcile', rec.code, rec.message);
      else {
        state.status = 'reconciled';
        log(rec.nextStep ? `reconciled: ${rec.appliedCount} of 10 recorded; next step ${rec.nextStep}` : 'reconciled: all ten recorded (236)');
      }
    } else if (startIndex === 0) {
      const bad = failed(state.initial.checks);
      if (bad && current.ledger.length > OPS_0227_0244_PRIOR_LEDGER.count) stop(null, 'initial-ledger', `reconciliation_required:${rec.code ?? 'ledger_beyond_0226'}`, rec.message);
      else if (bad) stop(null, 'initial-ledger', `prior_ledger_mismatch:${bad.name}`, rec.message);
      else if (approved && !approved.ok) stop(null, 'approved-schema', 'approved_existing_schema_mismatch', approvedSchemaMessage(approved));
    } else if (!rec.ok) stop(null, 'reconcile', rec.code, rec.message);
    else if (rec.appliedCount !== startIndex) stop(null, 'reconcile', 'reconciliation_required:resume_from_is_not_next_step', rec.message);
  }
  persist();
  const baseLedger = current?.ledger.slice(0, OPS_0227_0244_PRIOR_LEDGER.count) ?? [];
  const runInitial = state.rowCounts?.start ?? null;
  for (let index = startIndex; mode !== 'reconcile' && state.status === 'running' && index < plan.files.length; index++) {
    const file = plan.files[index];
    const step = { order: file.order, name: file.name, preflight: null, apply: null, post: null, readback: null };
    state.steps.push(step);
    if (mode === 'execute' && index > startIndex) {
      try { current = await read(OPS_0227_0244_PRE_READ_QUERY); }
      catch (error) { stop(file.name, 'preflight-read', errorCode(error)); persist(); break; }
    }
    const checks = [...(mode === 'execute' || index === startIndex ? ledgerChecks(current, baseLedger, plan, index) : []),
      ...stepPreflightChecks(current, file, plan, approvedSchema)];
    step.preflight = { observedAt: current.observedAt, snapshotBytes: current.snapshotBytes, ledgerCount: current.ledger.length,
      ledgerDeferred: mode === 'dry-run' && index > startIndex, checks, recorded: recordedCounts(current, file) };
    const bad = failed(checks);
    if (bad) { stop(file.name, 'preflight', `preflight_failed:${bad.name}`); persist(); break; }
    log(`${mode === 'execute' ? 'preflight ok' : 'dry-run ok'}: ${file.name}`);
    if (mode === 'dry-run') { persist(); continue; }
    keepPreApply(current.ledger);
    step.apply = { startedAt: stamp(), finishedAt: null, statements: file.statementCount + 1, outcome: 'sending' };
    persist();
    try {
      await provider.applyMigration({ name: file.name, sha256: file.sha256, statements: file.statements,
        statementsSha256: file.statementsSha256 });
    } catch (error) {
      const code = errorCode(error);
      step.apply.finishedAt = stamp();
      if (NOT_SENT.test(code)) {
        step.apply.outcome = 'not-sent';
        stop(file.name, 'apply', 'apply_refused_before_send', code);
      } else {
        // The request may have reached D1: the outcome is unknown. Never retry; a later run must reconcile.
        step.apply.outcome = 'ambiguous';
        stop(file.name, 'apply', 'reconciliation_required:apply_ambiguous_no_retry', code);
      }
      persist(); break;
    }
    state.writesPerformed++;
    step.apply.finishedAt = stamp();
    step.apply.outcome = 'acknowledged';
    persist();
    let after;
    try { after = await read(ops0227To0244SnapshotQuery(Object.keys(file.expectedNewTableRows).sort())); }
    catch (error) { stop(file.name, 'post-read', `reconciliation_required:post_read_failed`, errorCode(error)); persist(); break; }
    const post = postChecks(current, after, file, runInitial);
    noteSize(`after ${file.name}`, after);
    step.readback = post.readback;
    step.post = { observedAt: after.observedAt, snapshotBytes: after.snapshotBytes, ledgerCount: after.ledger.length,
      ledgerTail: after.ledger.at(-1)?.name ?? null, addedObjectCount: post.addedObjectCount, tableRows: after.tableRows,
      rowDeltas: post.rowDeltas, checks: post.checks };
    const badPost = failed(post.checks);
    if (badPost) {
      // The write was acknowledged but the state is not as pinned: never reconciled or resumed automatically.
      stop(file.name, 'post-check', 'reconciliation_required:postcheck_failed',
        post.checks.filter(item => !item.ok).map(item => item.name).join(','));
      current = after;
      persist(); break;
    }
    log(`applied and verified: ${file.name} (ledger ${after.ledger.length}, tail ${after.ledger.at(-1).name})`);
    if (file.name.startsWith('0240')) { state.notes.push(`After 0240: ${OPS_0227_0244_AUTHORITY_NOTE}`); log(`NOTE: ${OPS_0227_0244_AUTHORITY_NOTE}`); }
    if (file.name.startsWith('0244')) { state.notes.push(`After 0244: ${OPS_0244_AUTHORITY_NOTE}`); log(`NOTE: ${OPS_0244_AUTHORITY_NOTE}`); }
    current = after;
  }
  if (state.status === 'running') {
    state.status = mode === 'execute' ? 'complete' : 'dry-run-passed';
    if (mode === 'dry-run') state.notes.push(`0240 will change role_permissions: ${OPS_0227_0244_AUTHORITY_NOTE} after the apply.`,
      `0244 will add override guards and the catalog seed: ${OPS_0244_AUTHORITY_NOTE} after the apply.`);
  }
  if (current) { state.finalLedger = ledgerSummary(current.ledger); if (state.rowCounts) state.rowCounts.final = trackedCounts(current); }
  if (state.status === 'complete' && canonical(state.finalLedger) !== canonical(OPS_0227_0244_FINAL_LEDGER)) {
    stop(null, 'final', 'final_ledger_mismatch');
  }
  state.finishedAt = stamp();
  persist();
  return state;
}

/** Human-readable ordered plan for dry-run output. */
export function describeOps0227To0244Plan(plan) {
  return plan.files.map(file => `${String(file.order).padStart(2, ' ')}. ${file.name} -> ledger id ${file.ledgerId}; sha256 ${file.sha256}; `
    + `${file.statementCount} statements + ledger row; ${file.expectedAddedObjectCount} new objects`).join('\n');
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = 'usage: node scripts/production-ops-0227-0244-ordered-once.mjs '
  + '[--dry-run | --reconcile [--baseline-receipt <earlier receipt>] | --execute --receipt <absolute path> '
  + '[--resume-from <file> --baseline-receipt <earlier receipt>] [--approval-ref <id>] [--rehearsal]] '
  + '--account-id <id> --database-id <uuid> --database-name <name> [--receipt <absolute path>]';
const APPROVAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{2,127}$/u;

export function parseOps0227To0244Args(args, env = {}) {
  const options = { mode: 'dry-run', accountId: env.CLOUDFLARE_ACCOUNT_ID ?? null, databaseId: null, databaseName: null,
    receiptPath: null, rehearsal: false, resumeFrom: null, approvalRef: null, baselineReceipt: null };
  const seen = new Set();
  const valueFlags = { '--account-id': 'accountId', '--database-id': 'databaseId', '--database-name': 'databaseName',
    '--receipt': 'receiptPath', '--resume-from': 'resumeFrom', '--approval-ref': 'approvalRef', '--baseline-receipt': 'baselineReceipt' };
  let modes = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail('usage');
    seen.add(arg);
    if (['--dry-run', '--execute', '--reconcile'].includes(arg)) { modes++; options.mode = arg.slice(2); }
    else if (arg === '--rehearsal') options.rehearsal = true;
    else if (Object.hasOwn(valueFlags, arg)) {
      const value = args[++i];
      if (typeof value !== 'string' || value.startsWith('--') || value.length === 0) fail('usage');
      options[valueFlags[arg]] = value;
    } else fail('usage');
  }
  if (modes > 1) fail('usage');
  if (!/^[a-f0-9]{32}$/u.test(options.accountId ?? '')) fail('account_id_required');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(options.databaseId ?? '')) fail('database_id_required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(options.databaseName ?? '')) fail('database_name_required');
  if (options.receiptPath !== null && !path.isAbsolute(options.receiptPath)) fail('receipt_path_invalid');
  if (options.resumeFrom !== null && (options.mode !== 'execute' || !OPS_0227_0244_FILES.some(file => file.name === options.resumeFrom)))
    fail('resume_from_invalid');
  if (options.approvalRef !== null && (options.mode !== 'execute' || !APPROVAL_REF.test(options.approvalRef))) fail('approval_ref_invalid');
  if (options.baselineReceipt !== null && (!path.isAbsolute(options.baselineReceipt)
    || !(options.mode === 'reconcile' || (options.mode === 'execute' && options.resumeFrom !== null))
    || path.resolve(options.baselineReceipt) === path.resolve(options.receiptPath ?? ''))) fail('baseline_receipt_invalid');
  if (OPS_0227_0244_REFUSED_DATABASE_IDS.includes(options.databaseId)) fail('client_production_database_refused');
  const isProduction = options.databaseId === OPS_PRODUCTION_DATABASE.databaseId;
  if (isProduction && (options.accountId !== OPS_PRODUCTION_DATABASE.accountId || options.databaseName !== OPS_PRODUCTION_DATABASE.databaseName))
    fail('production_target_mismatch');
  if (options.mode === 'execute') {
    if (!options.receiptPath) fail('receipt_required');
    if (isProduction && options.rehearsal) fail('rehearsal_refuses_production_database');
    if (!isProduction && !options.rehearsal) fail('rehearsal_flag_required_for_non_production_database');
    if (isProduction && options.approvalRef === null) fail('approval_ref_required_for_production');
  }
  return Object.freeze({ ...options, environment: isProduction ? 'production' : 'non-production' });
}

async function promptConfirmation(phrase) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('interactive_confirmation_required');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(`Type ${phrase} to apply the remaining migrations in order: `)) === phrase; }
  finally { terminal.close(); }
}

/** CLI entry with injectable dependencies for offline tests. */
export async function mainOps0227To0244(args, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const out = dependencies.out ?? (line => process.stdout.write(`${line}\n`));
  const options = parseOps0227To0244Args(args, env);
  const target = { environment: options.environment, accountId: options.accountId, databaseId: options.databaseId,
    databaseName: options.databaseName };
  let receipt = null, receiptTouched = false;
  if (options.receiptPath) {
    const opened = (dependencies.openReceipt ?? openOps0227To0244Receipt)(options.receiptPath);
    receipt = { write(value) { receiptTouched = true; opened.write(value); }, close() { opened.close(); },
      ...(opened.keep ? { keep(value) { opened.keep(value); } } : {}) };
  }
  // A settled result keeps its own code when its receipt cannot be written; the receipt failure is reported beside it.
  const record = result => {
    try { receipt?.write(result); } catch { result.receiptFailure = REFUSAL_RECEIPT_WRITE_FAILED; }
    return result;
  };
  const settle = async () => {
    let plan;
    try { plan = loadVerifiedOps0227To0244Plan({ root: dependencies.root ?? ROOT }); }
    catch (error) {
      const refusal = { schemaVersion: 2, contract: OPS_0227_0244_CONTRACT, mode: options.mode, target, approvalRef: options.approvalRef,
        status: 'refused', stop: { step: null, phase: 'local-verification', code: errorCode(error) }, writesPerformed: 0, at: new Date().toISOString() };
      return record(refusal);
    }
    out(`Ordered plan ${plan.planSha256} (prior ledger ${plan.priorLedger.count} -> ${plan.finalLedger.count}):\n${describeOps0227To0244Plan(plan)}`);
    if (options.mode === 'execute' && options.environment === 'production') {
      try { await (dependencies.sourceCheck ?? defaultSourceCheck)(); }
      catch (error) {
        const code = errorCode(error);
        const refusal = { schemaVersion: 2, contract: OPS_0227_0244_CONTRACT, mode: options.mode, target, approvalRef: options.approvalRef,
          status: 'refused', stop: { step: null, phase: 'source-check', code: code === 'unexpected_error' ? 'ops_0227_0244:source_check_failed' : code },
          writesPerformed: 0, at: new Date().toISOString() };
        return record(refusal);
      }
    }
    const token = env.CLOUDFLARE_API_TOKEN;
    if (typeof token !== 'string' || token.length < 20 || token.length > 16_384) fail('cloudflare_token_missing');
    const providerFactory = dependencies.providerFactory ?? (await import('./production-ops-0227-0244-cloudflare-provider.mjs')).createOps0227To0244CloudflareProvider;
    const provider = providerFactory({ getBearerToken: () => token, accountId: options.accountId, databaseId: options.databaseId,
      databaseName: options.databaseName, allowWrites: options.mode === 'execute' });
    await provider.assertTarget();
    const readOnly = { readSnapshot: query => provider.readSnapshot(query) };
    let baseline = null;
    if (options.baselineReceipt) {
      try { baseline = loadOps0227To0244BaselineReceipt(options.baselineReceipt, { plan, target }); }
      catch (error) {
        const refusal = { schemaVersion: 2, contract: OPS_0227_0244_CONTRACT, mode: options.mode, target, approvalRef: options.approvalRef,
          status: 'reconciliation-required', stop: { step: null, phase: 'baseline-receipt', code: errorCode(error) },
          writesPerformed: 0, at: new Date().toISOString() };
        return record(refusal);
      }
    }
    const common = { plan, target, log: out, approvalRef: options.approvalRef, baseline,
      approvedExistingSchema: dependencies.approvedExistingSchema ?? null };
    if (options.mode === 'reconcile') return await runOps0227To0244Ordered({ ...common, provider: readOnly, mode: 'reconcile', receipt });
    let startIndex = 0;
    if (options.mode === 'execute' && options.resumeFrom !== null) {
      // Same-run reconciliation must prove the recorded prefix and name the requested file as the next step.
      const rec = await runOps0227To0244Ordered({ ...common, provider: readOnly, mode: 'reconcile' });
      if (rec.status !== 'reconciled' || rec.reconcile.nextStep !== options.resumeFrom) {
        const refused = { ...rec, mode: 'execute', resumeFrom: options.resumeFrom, status: 'reconciliation-required',
          stop: rec.stop ?? { step: null, phase: 'reconcile', code: 'reconciliation_required:resume_from_is_not_next_step',
            detail: `${rec.reconcile.message}; --resume-from was ${options.resumeFrom}` } };
        return record(refused);
      }
      startIndex = rec.reconcile.appliedCount;
    }
    const rehearsal = await runOps0227To0244Ordered({ ...common, provider: readOnly, mode: 'dry-run', startIndex,
      receipt: options.mode === 'dry-run' ? receipt : null });
    if (options.mode === 'dry-run' || rehearsal.status !== 'dry-run-passed') {
      if (options.mode === 'execute') {
        const status = rehearsal.status === 'reconciliation-required' ? rehearsal.status : 'refused';
        const refused = { ...rehearsal, mode: 'execute', status };
        return record(refused);
      }
      return rehearsal;
    }
    const phrase = OPS_0227_0244_CONFIRMATION(options.databaseName);
    if (!await (dependencies.confirm ?? promptConfirmation)(phrase)) {
      const cancelled = { ...rehearsal, mode: 'execute', status: 'cancelled', writesPerformed: 0 };
      return record(cancelled);
    }
    return await runOps0227To0244Ordered({ ...common, provider, mode: 'execute', receipt, startIndex });
  };
  let result;
  try { result = await settle(); } catch (error) {
    // The ordered run writes the receipt before its first request. An untouched receipt therefore means that no
    // write was attempted, so the refusal can be recorded instead of leaving an empty file.
    // A receipt failure here never replaces the error that stopped the run. Both are reported, and nothing is retried.
    let receiptFailure = null;
    if (receipt && !receiptTouched) {
      try {
        receipt.write({ schemaVersion: 2, contract: OPS_0227_0244_CONTRACT, mode: options.mode, target, approvalRef: options.approvalRef,
          status: 'refused', stop: { step: null, phase: 'command-line', code: errorCode(error) }, writesPerformed: 0, at: new Date().toISOString() });
      } catch { receiptFailure = REFUSAL_RECEIPT_WRITE_FAILED; }
    }
    try { receipt?.close(); } catch { receiptFailure ??= RECEIPT_CLOSE_FAILED; }
    if (receiptFailure === null) throw error;
    const failure = error instanceof Error && Object.isExtensible(error) ? error : new Error(errorCode(error), { cause: error });
    failure.receiptFailure = receiptFailure;
    throw failure;
  }
  try { receipt?.close(); } catch { result.receiptFailure ??= RECEIPT_CLOSE_FAILED; }
  return result;
}

async function defaultSourceCheck() {
  const { currentMainSource } = await import('./production-ops-staff-login-0226-run.mjs');
  return currentMainSource();
}

async function runCommandLine(args) {
  try {
    const result = await mainOps0227To0244(args);
    process.stdout.write(`${JSON.stringify({ status: result.status, mode: result.mode, stop: result.stop ?? null,
      nextStep: result.reconcile?.nextStep ?? null, finalLedger: result.finalLedger ?? null, writesPerformed: result.writesPerformed ?? 0 })}\n`);
    // A receipt that could not be saved or closed is never a success, whatever the run itself reached.
    if (result.receiptFailure) process.stderr.write(`${result.receiptFailure}\n`);
    process.exitCode = result.receiptFailure ? 1
      : ['complete', 'dry-run-passed', 'reconciled'].includes(result.status) ? 0 : result.status === 'cancelled' ? 2 : 1;
  } catch (error) {
    const code = errorCode(error);
    process.stderr.write(`${code === 'unexpected_error' ? 'ops_0227_0244:unexpected_error' : code}\n${code === 'ops_0227_0244:usage' ? `${USAGE}\n` : ''}`
      + (error?.receiptFailure ? `${error.receiptFailure}\n` : ''));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Never a top-level await here. The provider imports this module, so it cannot load until this module has finished
  // evaluating: awaiting the run at the top level deadlocks (exit 13) before the first request.
  // The exit code is 1 until the run settles, so a run that never settles is not reported as a success.
  process.exitCode = 1;
  let settled = false;
  process.once('exit', () => { if (!settled) try { fs.writeSync(2, 'ops_0227_0244:command_line_unsettled\n'); } catch {} });
  runCommandLine(process.argv.slice(2)).then(() => { settled = true; });
}
