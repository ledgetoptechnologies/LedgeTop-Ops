import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_NAME = '0226_staff_login_bindings.sql';
const MIGRATION_SHA256 = 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5';
const WIRE_FIXTURE_PATH = path.join(ROOT, 'scripts','fixtures','production-ops-0226-wrangler-wire-statements.json');
const WIRE_FIXTURE_SHA256 = 'fd02f7220e2afaeb1105a19da0dc14b3c9329c084ac6500b8d0b5e32b440edb3';
const WIRE_STATEMENTS_SHA256 = '29c324b1daa438c532ae050cb4f0d0e1db10b24eb4e876cef7682a9c98e03474';
const WIRE_SCHEMA_SHA256 = '2ec57a1391b2f63a042ff0e85b358e3666b74f4cc366eff7651c7cd4fbe4c729';
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const MAX_ROWS = 20_000;
const MAX_CAPTURE_AGE_MS = 60_000;
const PLAN_TTL_MS = 5 * 60_000;

export const PRODUCTION_OPS_0226_TARGET = Object.freeze({
  environment: 'production', accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
  workerName: 'ledgetop-ops', binding: 'OPS_DB',
  databaseName: 'ltds-ops', databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd',
});

/** Full legacy staff/role/profile/admission state. Rows are transient in memory;
 * only their counts and digests enter plans and journals. */
export const PRODUCTION_OPS_0226_PROTECTED_TABLES = Object.freeze(Object.fromEntries(Object.entries({
  staff_users: ['id','email','display_name','access_subject','project_alpha_user_id','status','created_at','updated_at','last_seen_at',
    'provisioning_source','sync_protected'],
  staff_role_assignments: ['id','staff_id','role_id','scope','division_id','scope_key','created_by','created_at'],
  local_staff_role_assignments: ['id','staff_id','role_id','scope','division_id','created_by','created_at'],
  staff_permission_overrides: ['id','staff_id','permission_key','effect','scope','division_id','scope_key','created_by','created_at'],
  staff_divisions: ['staff_id','division_id','is_primary','created_at'],
  roles: ['id','name','description','immutable','created_at','updated_at'],
  permissions: ['key','description'],
  role_permissions: ['role_id','permission_key'],
  divisions: ['id','name','code','project_alpha_business_unit_id','active','created_at','updated_at'],
  native_staff_admissions: ['staff_id','bound_access_subject','active','admitted_by','created_at','updated_at','version'],
  native_staff_profiles: ['staff_id','login_email','display_name','version','created_at','updated_at'],
  native_staff_admin_delegations: ['id','actor_staff_id','action','effect','scope_kind','business_area_id','division_id',
    'target_staff_id','active','version','granted_by','created_at','updated_at'],
  native_staff_management_delegations: ['id','actor_staff_id','contract_version','authority_domain','capability','effect','scope_kind',
    'business_area_id','division_id','target_staff_id','active','version','granted_by','created_at','updated_at'],
  native_staff_access_reconciliation: ['singleton','enabled','generation','applied_generation','lease_id','lease_until',
    'attempt_generation','attempts','last_attempt_at','last_success_at','last_error'],
}).map(([name, columns]) => [name, Object.freeze(columns)])));

const REQUIRED_TABLE_COLUMNS = Object.freeze({ ...PRODUCTION_OPS_0226_PROTECTED_TABLES });
const LOGIN_PREFIX_OBJECTS = Object.freeze([
  'staff_login_binding_control','staff_login_generations','staff_login_binding_intents','staff_login_bindings','staff_login_binding_audit',
  'staff_login_bindings_active_email','staff_login_bindings_active_subject',
  'staff_login_intent_insert','staff_login_intent_update','staff_login_intent_no_delete','staff_login_binding_insert',
  'staff_login_binding_update','staff_login_binding_no_delete','staff_login_binding_linked','staff_login_binding_revoked',
  'staff_login_canonical_insert_collision','staff_login_canonical_update_collision','staff_login_generation_update',
  'staff_login_generation_no_delete','staff_login_audit_no_update','staff_login_audit_no_delete',
  'staff_login_control_no_update','staff_login_control_no_delete',
]);

export const PRODUCTION_OPS_0226_BASELINE = Object.freeze({
  sourceMetadataSha256: '6c1d0d2d298982a54b6e0d7671399f297e024134e8a28348ce78ac787cf9d46f',
  observedAt: '2026-10-31T11:31:50.816Z',
  authorityDigestExcludedColumns: Object.freeze({ staff_users: Object.freeze(['last_seen_at']) }),
  ledgerCount: 225,
  ledgerNamesSha256: 'e9ca08f7e051a7581da54ba585b740d0cbf033c91f69470649750ae2fdabd8a7',
  ledgerSha256: '9fbe33d12e27fd5e20af45ba05db02711a623f19a0b298ef4b3eb7b526ece1bb',
  lastMigration: '0225_native_staff_lifecycle_bridge.sql',
  schemaObjectCount: 2449,
  schemaSha256: '71240c8a7cf5f916135d208b18c603b16a5978ef650bac21526b4967852834d7',
  protectedTableCounts: Object.freeze({staff_users:3,staff_role_assignments:2,local_staff_role_assignments:0,
    staff_permission_overrides:18,staff_divisions:0,roles:5,permissions:49,role_permissions:112,divisions:3,
    native_staff_admissions:1,native_staff_profiles:1,native_staff_admin_delegations:0,
    native_staff_management_delegations:0,native_staff_access_reconciliation:1}),
  protectedAuthorityTableDigests: Object.freeze({
    staff_users:'278d7e3447eed0ae624337346b69472a42d1ba1dfd184e88aa6488a84ba205e1',
    staff_role_assignments:'f88c328487d5ae44a5d5862f49ebaad3bcd929b2240375bc72e0dc717ef73579',
    local_staff_role_assignments:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    staff_permission_overrides:'feb2439d192e91099566a2f4691ca0c2b6876ecef64a531c192cc92d5ac5a5bd',
    staff_divisions:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    roles:'48da715d3973083fb7ad643f631c6c2bbdd209585a9b38a62bb40ea391279cfa',
    permissions:'5293ee5350f691dde75c74ec685e563abe08738e58c631a2629ea60af718f272',
    role_permissions:'8cff1adcaa37dda43fa83d314816ca2c8dfac5315bcd16d951d2d48f9bab3fc9',
    divisions:'19d87590a60964d99fca41cb978975a92f42c0b2cd2256ffbf345c335331e238',
    native_staff_admissions:'744b00fdb449256626e5e536006684597ab4ca9c108d448f13edec8efb6a656a',
    native_staff_profiles:'8c4f322a4c49d5c7b244cd69259141ad62a86116ab30e3c8b735f4f83f3180b9',
    native_staff_admin_delegations:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    native_staff_management_delegations:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    native_staff_access_reconciliation:'b33f860c6e6a1b24a477bb8ebc2a154cb374496e158a2245c89414f8a2a4a2cd',
  }),
  protectedAuthorityStateSHA256:'693160bfaf22aedd0c2a4386667ad6f003f15f2038deaac9eca7214cbad47dbf',
  nativeStaffControlEnabled:0,
});

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(`production_ops_0226:${code}`); };
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => isPlain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key);
    return !!d && d.enumerable && Object.hasOwn(d, 'value'); });
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('json_value_invalid');
};
const commitValid = value => COMMIT.test(value ?? '');
const iso = (value, now) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value && Date.parse(value) <= now && now - Date.parse(value) <= MAX_CAPTURE_AGE_MS;
const validIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;

function orderedSchema(schema) {
  if (!Array.isArray(schema) || schema.length > 10_000 || schema.some(row => !exactKeys(row, ['type','name','tbl_name','sql'])
    || !['table','index','view','trigger'].includes(row.type) || typeof row.name !== 'string'
    || typeof row.tbl_name !== 'string' || (row.sql !== null && typeof row.sql !== 'string'))) fail('schema_invalid');
  return schema;
}
function schemaFingerprint(schema) {
  const rows = orderedSchema(schema).filter(row => row.sql !== null && !row.name.startsWith('sqlite_') && !row.name.startsWith('_cf_'));
  return hash(JSON.stringify(rows.map(row => [row.type,row.name,row.tbl_name,row.sql])));
}
function ledgerFingerprint(ledger) {
  if (!Array.isArray(ledger) || ledger.length > 10_000 || ledger.some((row, index) => !exactKeys(row, ['id','name'])
    || !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.name !== 'string' || row.name.length < 1
    || (index > 0 && ledger[index - 1].id >= row.id)) || new Set(ledger.map(row => row.name)).size !== ledger.length)
    fail('ledger_invalid');
  return hash(ledger.map(row => row.name).join('\n'));
}
function fullLedgerFingerprint(ledger) {
  // Validate the complete id/name sequence independently of the readable names digest.
  ledgerFingerprint(ledger);
  return hash(JSON.stringify(ledger.map(row => [row.id,row.name])));
}
function objectKey(row) { return `${row.type}\u0000${row.name}\u0000${row.tbl_name}`; }
const AUTHORITY_DIGEST_EXCLUDED_COLUMNS = Object.freeze({ staff_users: Object.freeze(['last_seen_at']) });
function parseLastSeen(value) {
  if (value === null) return null;
  if (typeof value !== 'string') fail('last_seen_timestamp_invalid');
  const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u.exec(value);
  const isoUtc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!sql && !isoUtc) fail('last_seen_timestamp_invalid');
  const millis = Date.parse(sql ? `${sql[1]}T${sql[2]}Z` : value);
  if (!Number.isFinite(millis)) fail('last_seen_timestamp_invalid');
  const normalized = new Date(millis).toISOString();
  if (sql && normalized.slice(0, 19) !== value.replace(' ', 'T')) fail('last_seen_timestamp_invalid');
  if (isoUtc) {
    const expected = `${isoUtc[1]}.${(isoUtc[2] ?? '').padEnd(3, '0')}Z`;
    if (normalized !== expected) fail('last_seen_timestamp_invalid');
  }
  return millis;
}

function staffTelemetry(rows) {
  const ids = new Set(); let nonNull = 0;
  const normalized = rows.map(row => {
    if (typeof row.id !== 'string' || row.id.length === 0 || ids.has(row.id)) fail('staff_identity_set_invalid');
    ids.add(row.id);
    const millis = parseLastSeen(row.last_seen_at);
    if (millis !== null) nonNull++;
    return { id: row.id, last_seen_at: row.last_seen_at, millis };
  }).sort((a,b) => a.id.localeCompare(b.id));
  return { rows: rows.length, nonNullRows: nonNull,
    sha256: hash(canonical(normalized.map(({id,last_seen_at}) => ({id,last_seen_at})))) , normalized };
}
export function validateProductionOps0226LastSeenTransition(beforeRows, afterRows) {
  if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) fail('staff_identity_set_invalid');
  const before = staffTelemetry(beforeRows), after = staffTelemetry(afterRows);
  if (before.rows !== after.rows || before.normalized.some((row,index) => row.id !== after.normalized[index]?.id))
    fail('staff_identity_set_changed');
  let changedCount = 0;
  for (let i=0; i<before.rows; i++) {
    const prior=before.normalized[i], next=after.normalized[i];
    if (prior.last_seen_at !== next.last_seen_at) changedCount++;
    if (prior.millis !== null && (next.millis === null || next.millis < prior.millis)) fail('last_seen_timestamp_regressed');
  }
  return { beforeRows: before.rows, afterRows: after.rows, beforeNonNullRows: before.nonNullRows,
    afterNonNullRows: after.nonNullRows, beforeSha256: before.sha256, afterSha256: after.sha256, changedCount };
}
function protectedState(snapshot) {
  if (!exactKeys(snapshot.protectedRows, Object.keys(PRODUCTION_OPS_0226_PROTECTED_TABLES))) fail('protected_rows_invalid');
  if (!exactKeys(snapshot.authorityDigestExcludedColumns, ['staff_users'])
    || canonical(snapshot.authorityDigestExcludedColumns) !== canonical(AUTHORITY_DIGEST_EXCLUDED_COLUMNS)) fail('authority_exclusions_invalid');
  const counts = {}, digests = {};
  for (const [table, columns] of Object.entries(PRODUCTION_OPS_0226_PROTECTED_TABLES)) {
    const rows = snapshot.protectedRows[table];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS || rows.some(row => !exactKeys(row, columns))) fail('protected_rows_invalid');
    counts[table] = rows.length;
    const stableRows = table === 'staff_users' ? rows.map(({last_seen_at, ...row}) => row) : rows;
    digests[table] = hash(canonical([...stableRows].sort((a,b) => canonical(a).localeCompare(canonical(b)))));
  }
  const telemetry = staffTelemetry(snapshot.protectedRows.staff_users);
  const control = snapshot.protectedRows.native_staff_access_reconciliation;
  if (control.length !== 1 || control[0].singleton !== 1 || control[0].enabled !== 0) fail('native_staff_control_not_zero');
  return { counts, digests, stateSha256: hash(canonical({ counts, digests })), telemetry };
}

function validateTarget(target) {
  if (!exactKeys(target, Object.keys(PRODUCTION_OPS_0226_TARGET))
    || Object.entries(PRODUCTION_OPS_0226_TARGET).some(([key,value]) => target[key] !== value)) fail('target_mismatch');
}
function validateBaseline(snapshot, baseline, now) {
  if (!Number.isSafeInteger(baseline.ledgerCount) || baseline.ledgerCount < 1 || !SHA.test(baseline.ledgerNamesSha256)
    || !SHA.test(baseline.ledgerSha256)
    || !Number.isSafeInteger(baseline.schemaObjectCount) || baseline.schemaObjectCount < 1 || !SHA.test(baseline.schemaSha256)
    || !exactKeys(baseline.protectedTableCounts, Object.keys(PRODUCTION_OPS_0226_PROTECTED_TABLES))
    || !exactKeys(baseline.protectedAuthorityTableDigests, Object.keys(PRODUCTION_OPS_0226_PROTECTED_TABLES))
    || canonical(baseline.authorityDigestExcludedColumns) !== canonical(AUTHORITY_DIGEST_EXCLUDED_COLUMNS)
    || baseline.nativeStaffControlEnabled !== 0 || !SHA.test(baseline.protectedAuthorityStateSHA256 ?? '')) fail('baseline_profile_invalid');
  if (!exactKeys(snapshot, ['target','observedAt','ledger','schema','schemaColumns','protectedRows','authorityDigestExcludedColumns'])
    || !iso(snapshot.observedAt, now)) fail('snapshot_stale_or_invalid');
  validateTarget(snapshot.target);
  const namesSha256 = ledgerFingerprint(snapshot.ledger), ledgerSha256 = fullLedgerFingerprint(snapshot.ledger), schemaSha256 = schemaFingerprint(snapshot.schema);
  if (snapshot.ledger.length !== baseline.ledgerCount || namesSha256 !== baseline.ledgerNamesSha256) fail('ledger_pin_mismatch');
  if (ledgerSha256 !== baseline.ledgerSha256) fail('ledger_pin_mismatch');
  if (snapshot.schema.length !== baseline.schemaObjectCount || schemaSha256 !== baseline.schemaSha256) fail('schema_pin_mismatch');
  if (snapshot.ledger.at(-1)?.name !== baseline.lastMigration || snapshot.ledger.some(row => row.name === MIGRATION_NAME))
    fail('migration_gap_mismatch');
  if (snapshot.schema.some(row => row.name.startsWith('staff_login_'))) fail('login_schema_already_present');
  if (!exactKeys(snapshot.schemaColumns, Object.keys(REQUIRED_TABLE_COLUMNS))) fail('precondition_columns_invalid');
  for (const [table, required] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    const columns = snapshot.schemaColumns[table];
    if (!Array.isArray(columns) || columns.length !== required.length || new Set(columns).size !== columns.length
      || columns.some((name,index) => name !== required[index]))
      fail('precondition_columns_invalid');
  }
  const state = protectedState(snapshot);
  if (canonical(state.counts) !== canonical(baseline.protectedTableCounts)
    || canonical(state.digests) !== canonical(baseline.protectedAuthorityTableDigests)
    || state.stateSha256 !== baseline.protectedAuthorityStateSHA256) fail('protected_state_pin_mismatch');
  return { namesSha256, ledgerSha256, schemaSha256, state };
}

function readPinnedWireStatements(sourceSql) {
  if (hash(Buffer.from(sourceSql, 'utf8')) !== MIGRATION_SHA256) fail('migration_pin_mismatch');
  let bytes, fixture;
  try {
    bytes = fs.readFileSync(WIRE_FIXTURE_PATH);
    if (hash(bytes) !== WIRE_FIXTURE_SHA256) fail('wire_fixture_pin_mismatch');
    fixture = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error?.message?.startsWith('production_ops_0226:')) throw error;
    fail('wire_fixture_unavailable');
  }
  if (!exactKeys(fixture, ['schemaVersion','sourceMigrationSha256','wranglerCliSha256','splitterOutputStatementCount',
    'setupStatements','statementCount','statementsSha256','expectedAddedSchemaSha256','expectedAddedObjectCount','statements'])
    || fixture.schemaVersion !== 1 || fixture.sourceMigrationSha256 !== MIGRATION_SHA256
    || fixture.wranglerCliSha256 !== 'a1a7a98e0b073d39dc3229b1b89f66accb51ae557fb34552250f914f12a81efd'
    || fixture.splitterOutputStatementCount !== 25 || canonical(fixture.setupStatements) !== canonical(['PRAGMA foreign_keys = ON'])
    || fixture.statementCount !== 24 || !Array.isArray(fixture.statements) || fixture.statements.length !== 24
    || fixture.statements.some(statement => typeof statement !== 'string' || statement.length === 0)
    || hash(JSON.stringify(fixture.statements)) !== WIRE_STATEMENTS_SHA256 || fixture.statementsSha256 !== WIRE_STATEMENTS_SHA256
    || fixture.expectedAddedSchemaSha256 !== WIRE_SCHEMA_SHA256 || fixture.expectedAddedObjectCount !== 23)
    fail('wire_fixture_invalid');
  return fixture;
}

function expectedLoginObjects(statements) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,access_subject TEXT,status TEXT NOT NULL);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);
      CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT);`);
    for (const statement of statements) db.exec(statement);
    const all = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,12)='staff_login_' ORDER BY type,name")
      .all();
    const named = all.filter(row => row.name.startsWith('staff_login_'));
    if (named.length !== 23 || named.some(row => !LOGIN_PREFIX_OBJECTS.includes(row.name))
      || LOGIN_PREFIX_OBJECTS.some(name => !named.some(row => row.name === name))) fail('migration_object_contract_invalid');
    return all.map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }));
  } catch (error) {
    if (error?.message?.startsWith('production_ops_0226:')) throw error;
    fail('migration_schema_compile_failed');
  } finally { db.close(); }
}

function migrationSql(root = ROOT) {
  const filename = path.join(root, 'apps','operations','migrations',MIGRATION_NAME);
  let sql; try { sql = fs.readFileSync(filename, 'utf8'); } catch { fail('migration_source_unavailable'); }
  if (hash(Buffer.from(sql, 'utf8')) !== MIGRATION_SHA256) fail('migration_pin_mismatch');
  return sql;
}

function receiptProjection(snapshot, baseline, now) {
  const validated = validateBaseline(snapshot, baseline, now);
  return { observedAt: snapshot.observedAt, target: PRODUCTION_OPS_0226_TARGET,
    ledgerCount: snapshot.ledger.length, ledgerNamesSha256: validated.namesSha256, ledgerSha256: validated.ledgerSha256,
    schemaObjectCount: snapshot.schema.length, schemaSha256: validated.schemaSha256,
    protectedTableCounts: validated.state.counts, protectedAuthorityTableDigests: validated.state.digests,
    protectedAuthorityStateSHA256: validated.state.stateSha256,
    authorityDigestExcludedColumns: AUTHORITY_DIGEST_EXCLUDED_COLUMNS,
    staffLastSeenAtSha256: validated.state.telemetry.sha256, staffLastSeenAtRows: validated.state.telemetry.rows,
    staffLastSeenAtNonNullRows: validated.state.telemetry.nonNullRows, nativeStaffControlEnabled: 0 };
}

function postReceiptProjection(snapshot, now) {
  if (!validIso(snapshot.observedAt) || Date.parse(snapshot.observedAt) > now
    || now - Date.parse(snapshot.observedAt) > MAX_CAPTURE_AGE_MS) fail('post_snapshot_stale_or_invalid');
  validateTarget(snapshot.target);
  const state = protectedState(snapshot);
  return { observedAt: snapshot.observedAt, target: PRODUCTION_OPS_0226_TARGET,
    protectedTableCounts: state.counts, protectedAuthorityTableDigests: state.digests,
    protectedAuthorityStateSHA256: state.stateSha256, authorityDigestExcludedColumns: AUTHORITY_DIGEST_EXCLUDED_COLUMNS,
    staffLastSeenAtSha256: state.telemetry.sha256, staffLastSeenAtRows: state.telemetry.rows,
    staffLastSeenAtNonNullRows: state.telemetry.nonNullRows, nativeStaffControlEnabled: 0 };
}

function unsignedPlan(plan) { const { planSha256, ...value } = plan; return value; }
function planHash(plan) { return hash(canonical(unsignedPlan(plan))); }

function compileProduction(snapshot, { sourceCommit, root = ROOT, now = Date.now() } = {}) {
  if (!commitValid(sourceCommit)) fail('source_commit_invalid');
  const sql = migrationSql(root), pre = receiptProjection(snapshot, PRODUCTION_OPS_0226_BASELINE, now);
  const wire = readPinnedWireStatements(sql), expectedObjects = expectedLoginObjects(wire.statements);
  if (schemaFingerprint(expectedObjects) !== WIRE_SCHEMA_SHA256) fail('wire_expected_schema_mismatch');
  const plan = { schemaVersion: 2, contract: 'production-ops-staff-login-0226-one-shot-v2', sourceCommit,
    target: PRODUCTION_OPS_0226_TARGET, compiledAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    profileSourceMetadataSha256: PRODUCTION_OPS_0226_BASELINE.sourceMetadataSha256,
    migration: { name: MIGRATION_NAME, sha256: MIGRATION_SHA256, sql, ledgerAppend: true },
    wireFixtureSha256: WIRE_FIXTURE_SHA256, wireStatementsSha256: WIRE_STATEMENTS_SHA256,
    expectedAddedObjectsSha256: schemaFingerprint(expectedObjects), expectedAddedObjectCount: expectedObjects.length,
    expectedNamedObjectCount: 23, preflight: pre };
  plan.planSha256 = planHash(plan);
  return plan;
}

/** The provider is injectable for local tests; production target and profile are fixed. */
export function createProductionOps0226Operator(options = {}) {
  if (!exactKeys(options, [])) fail('operator_options_invalid');
  return Object.freeze({
    compile: compileProduction,
    executeOnce: async ({ plan, provider, journalPath, now = Date.now } = {}) => {
      if (!provider || typeof provider.readSnapshot !== 'function' || typeof provider.applyExactMigration !== 'function')
        fail('provider_contract_invalid');
      if (!path.isAbsolute(journalPath ?? '')) fail('journal_path_invalid');
      if (fs.existsSync(journalPath)) fail('journal_exists_no_replay');
      if (!exactKeys(plan, ['schemaVersion','contract','sourceCommit','target','compiledAt','expiresAt','profileSourceMetadataSha256','migration',
        'wireFixtureSha256','wireStatementsSha256','expectedAddedObjectsSha256','expectedAddedObjectCount','expectedNamedObjectCount','preflight','planSha256'])
        || plan.schemaVersion !== 2 || plan.contract !== 'production-ops-staff-login-0226-one-shot-v2'
        || plan.planSha256 !== planHash(plan) || !commitValid(plan.sourceCommit)
        || plan.profileSourceMetadataSha256 !== PRODUCTION_OPS_0226_BASELINE.sourceMetadataSha256) fail('plan_invalid');
      if (!exactKeys(plan.migration, ['name','sha256','sql','ledgerAppend'])
        || !exactKeys(plan.preflight, ['observedAt','target','ledgerCount','ledgerNamesSha256','ledgerSha256','schemaObjectCount','schemaSha256',
          'protectedTableCounts','protectedAuthorityTableDigests','protectedAuthorityStateSHA256','authorityDigestExcludedColumns',
          'staffLastSeenAtSha256','staffLastSeenAtRows','staffLastSeenAtNonNullRows','nativeStaffControlEnabled'])
        || canonical(plan.preflight.protectedTableCounts) !== canonical(PRODUCTION_OPS_0226_BASELINE.protectedTableCounts)
        || canonical(plan.preflight.protectedAuthorityTableDigests) !== canonical(PRODUCTION_OPS_0226_BASELINE.protectedAuthorityTableDigests)
        || plan.preflight.protectedAuthorityStateSHA256 !== PRODUCTION_OPS_0226_BASELINE.protectedAuthorityStateSHA256
        || canonical(plan.preflight.authorityDigestExcludedColumns) !== canonical(AUTHORITY_DIGEST_EXCLUDED_COLUMNS)
        || !SHA.test(plan.preflight.staffLastSeenAtSha256 ?? '')
        || plan.preflight.staffLastSeenAtRows !== PRODUCTION_OPS_0226_BASELINE.protectedTableCounts.staff_users
        || !Number.isSafeInteger(plan.preflight.staffLastSeenAtNonNullRows)
        || plan.preflight.staffLastSeenAtNonNullRows < 0 || plan.preflight.staffLastSeenAtNonNullRows > plan.preflight.staffLastSeenAtRows
        || !validIso(plan.compiledAt) || !validIso(plan.expiresAt)
        || Date.parse(plan.compiledAt) > now() || Date.parse(plan.expiresAt) <= now()
        || Date.parse(plan.expiresAt) - Date.parse(plan.compiledAt) > PLAN_TTL_MS) fail('plan_invalid');
      validateTarget(plan.target);
      if (plan.migration.name !== MIGRATION_NAME || plan.migration.sha256 !== MIGRATION_SHA256
        || plan.migration.ledgerAppend !== true || hash(Buffer.from(plan.migration.sql, 'utf8')) !== MIGRATION_SHA256
        || plan.wireFixtureSha256 !== WIRE_FIXTURE_SHA256 || plan.wireStatementsSha256 !== WIRE_STATEMENTS_SHA256
        || Date.parse(plan.expiresAt) <= now() || Date.parse(plan.compiledAt) > now()) fail('plan_expired_or_migration_pin_mismatch');
      const wire = readPinnedWireStatements(plan.migration.sql);

      const beforeSnapshot = await provider.readSnapshot({ target: PRODUCTION_OPS_0226_TARGET, phase: 'immediate-prewrite',
        query: PRODUCTION_OPS_0226_PRE_READ_QUERY });
      const before = receiptProjection(beforeSnapshot, PRODUCTION_OPS_0226_BASELINE, now());
      if (canonical(before.target) !== canonical(plan.preflight.target)
        || before.ledgerCount !== plan.preflight.ledgerCount
        || before.ledgerNamesSha256 !== plan.preflight.ledgerNamesSha256 || before.ledgerSha256 !== plan.preflight.ledgerSha256
        || before.schemaObjectCount !== plan.preflight.schemaObjectCount
        || before.schemaSha256 !== plan.preflight.schemaSha256
        || before.nativeStaffControlEnabled !== plan.preflight.nativeStaffControlEnabled
        || before.protectedAuthorityStateSHA256 !== plan.preflight.protectedAuthorityStateSHA256
        || canonical(before.authorityDigestExcludedColumns) !== canonical(plan.preflight.authorityDigestExcludedColumns)
        || canonical(before.protectedTableCounts) !== canonical(plan.preflight.protectedTableCounts)
        || canonical(before.protectedAuthorityTableDigests) !== canonical(plan.preflight.protectedAuthorityTableDigests)) fail('prewrite_drift');

      const journal = await openOneShotJournal(journalPath);
      try {
        await journal.append({ phase: 'migration-0226-apply-intent', planSha256: plan.planSha256,
          sourceCommit: plan.sourceCommit, migrationSha256: MIGRATION_SHA256, target: PRODUCTION_OPS_0226_TARGET,
          preflight: before });
        try {
          // One provider call. The injected adapter must not retry after an ambiguous response.
          await provider.applyExactMigration({ target: PRODUCTION_OPS_0226_TARGET, name: MIGRATION_NAME,
            sha256: MIGRATION_SHA256, sql: plan.migration.sql, appendLedger: true });
        } catch {
          await journal.append({ phase: 'migration-0226-outcome-unknown', planSha256: plan.planSha256,
            note: 'Do not retry; perform a separate read-only reconciliation.' });
          fail('outcome_unknown_no_retry');
        }
        await journal.append({ phase: 'migration-0226-call-returned', planSha256: plan.planSha256,
          providerReturned: true });
        let afterSnapshot;
        try {
          afterSnapshot = await provider.readSnapshot({ target: PRODUCTION_OPS_0226_TARGET, phase: 'postwrite',
            query: PRODUCTION_OPS_0226_POST_READ_QUERY });
          const after = validatePostSnapshot(beforeSnapshot, afterSnapshot, plan, PRODUCTION_OPS_0226_BASELINE, now());
          await journal.append({ phase: 'migration-0226-postread-verified', planSha256: plan.planSha256, postflight: after });
          return { schemaVersion: 2, contract: plan.contract, sourceCommit: plan.sourceCommit,
            planSha256: plan.planSha256, migrationSha256: MIGRATION_SHA256, target: PRODUCTION_OPS_0226_TARGET,
            before, after, mutationCalls: 1 };
        } catch (error) {
          await journal.append({ phase: 'migration-0226-postread-unverified', planSha256: plan.planSha256,
            reason: error?.message?.startsWith('production_ops_0226:') ? error.message : 'postread_failed',
            note: 'Do not retry; reconcile the existing migration state read-only.' });
          throw error;
        }
      } finally { await journal.close(); }
    },
  });
}

const defaultOperator = createProductionOps0226Operator();
export const compileProductionOpsStaffLogin0226Plan = defaultOperator.compile;
export const executeProductionOpsStaffLogin0226Once = defaultOperator.executeOnce;

function rowsSql(table, columns) {
  const projection = columns.map(column => `"${column}"`).join(',');
  const json = columns.map(column => `'${column}',q."${column}"`).join(',');
  return `'${table}',json((SELECT json_group_array(json_object(${json})) FROM (SELECT ${projection} FROM "${table}" ORDER BY ${projection} LIMIT ${MAX_ROWS + 1}) q))`;
}
const protectedRowsSql = Object.entries(PRODUCTION_OPS_0226_PROTECTED_TABLES).map(([table,columns]) => rowsSql(table,columns)).join(',\n  ');
const schemaColumnsSql = Object.keys(REQUIRED_TABLE_COLUMNS).map(table => `'${table}',json((SELECT json_group_array(name)
  FROM (SELECT name FROM pragma_table_info('${table}') ORDER BY cid)))`).join(',\n  ');
const commonSnapshotSql = `SELECT json_object(
  'ledger',json((SELECT json_group_array(json_object('id',id,'name',name)) FROM (SELECT id,name FROM d1_migrations ORDER BY id))),
  'schema',json((SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql))
    FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL
      AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name))),
  'schemaColumns',json_object(${schemaColumnsSql}),
  'authorityDigestExcludedColumns',json_object('staff_users',json_array('last_seen_at')),
  'protectedRows',json_object(${protectedRowsSql})`;
export const PRODUCTION_OPS_0226_PRE_READ_QUERY = `${commonSnapshotSql}) AS production_ops_0226_snapshot`;
export const PRODUCTION_OPS_0226_POST_READ_QUERY = `${commonSnapshotSql},
  'loginState',json_object(
    'controlCount',(SELECT count(*) FROM staff_login_binding_control),
    'controlSingleton',(SELECT singleton FROM staff_login_binding_control WHERE singleton=1),
    'controlSchemaVersion',(SELECT schema_version FROM staff_login_binding_control WHERE singleton=1),
    'generationsCount',(SELECT count(*) FROM staff_login_generations),
    'intentsCount',(SELECT count(*) FROM staff_login_binding_intents),
    'bindingsCount',(SELECT count(*) FROM staff_login_bindings),
    'auditCount',(SELECT count(*) FROM staff_login_binding_audit))) AS production_ops_0226_snapshot`;

export function parseProductionOps0226SnapshotResult(value, { observedAt } = {}) {
  let payload; try { payload = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail('read_result_invalid'); }
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true || !Array.isArray(payload[0].results)
    || payload[0].meta?.rows_written !== 0 || payload[0].meta?.changed_db !== false || payload[0].meta?.served_by_primary !== true
    || payload[0].results.length !== 1 || typeof payload[0].results[0]?.production_ops_0226_snapshot !== 'string'
    || Buffer.byteLength(payload[0].results[0].production_ops_0226_snapshot) > 24 * 1024 * 1024) fail('read_result_invalid');
  let snapshot; try { snapshot = JSON.parse(payload[0].results[0].production_ops_0226_snapshot); } catch { fail('read_result_invalid'); }
  return { ...snapshot, target: PRODUCTION_OPS_0226_TARGET, observedAt };
}

function validatePostSnapshot(beforeSnapshot, afterSnapshot, plan, baseline, now) {
  if (!exactKeys(afterSnapshot, ['target','observedAt','ledger','schema','schemaColumns','protectedRows','authorityDigestExcludedColumns','loginState'])
    || !iso(afterSnapshot.observedAt, now)) fail('post_snapshot_stale_or_invalid');
  orderedSchema(afterSnapshot.schema);
  const afterReceipt = postReceiptProjection(afterSnapshot, now);
  const afterProtected = { stateSha256: afterReceipt.protectedAuthorityStateSHA256, counts: afterReceipt.protectedTableCounts,
    digests: afterReceipt.protectedAuthorityTableDigests };
  const telemetry = validateProductionOps0226LastSeenTransition(beforeSnapshot.protectedRows.staff_users, afterSnapshot.protectedRows.staff_users);
  if (afterProtected.stateSha256 !== plan.preflight.protectedAuthorityStateSHA256
    || canonical(afterProtected.counts) !== canonical(plan.preflight.protectedTableCounts)
    || canonical(afterProtected.digests) !== canonical(plan.preflight.protectedAuthorityTableDigests)) fail('protected_rows_changed');
  if (canonical(afterSnapshot.schemaColumns) !== canonical(beforeSnapshot.schemaColumns)) fail('precondition_columns_changed');
  const beforeLedger = beforeSnapshot.ledger;
  if (!Array.isArray(afterSnapshot.ledger) || afterSnapshot.ledger.length !== beforeLedger.length + 1
    || beforeLedger.some((row,index) => row.id !== afterSnapshot.ledger[index]?.id || row.name !== afterSnapshot.ledger[index]?.name)
    || afterSnapshot.ledger.at(-1)?.id !== beforeLedger.at(-1)?.id + 1
    || afterSnapshot.ledger.at(-1)?.name !== MIGRATION_NAME) fail('ledger_append_not_exact');
  const wire = readPinnedWireStatements(plan.migration.sql);
  const newObjects = expectedLoginObjects(wire.statements), preKeys = new Set(beforeSnapshot.schema.map(objectKey));
  const oldAfter = afterSnapshot.schema.filter(row => preKeys.has(objectKey(row)));
  const addedAfter = afterSnapshot.schema.filter(row => !preKeys.has(objectKey(row)));
  if (canonical(oldAfter) !== canonical(beforeSnapshot.schema) || canonical(addedAfter) !== canonical(newObjects)
    || addedAfter.filter(row => row.name.startsWith('staff_login_')).length !== 23
    || schemaFingerprint(addedAfter) !== plan.expectedAddedObjectsSha256
    || addedAfter.length !== plan.expectedAddedObjectCount) fail('schema_delta_not_exact');
  const login = afterSnapshot.loginState;
  if (!exactKeys(login, ['controlCount','controlSingleton','controlSchemaVersion','generationsCount','intentsCount','bindingsCount','auditCount'])
    || login.controlCount !== 1 || login.controlSingleton !== 1 || login.controlSchemaVersion !== 1
    || login.generationsCount !== 0 || login.intentsCount !== 0 || login.bindingsCount !== 0 || login.auditCount !== 0)
    fail('login_seed_state_not_empty');
  return { observedAt: afterReceipt.observedAt, ledgerCount: afterSnapshot.ledger.length,
    ledgerNamesSha256: ledgerFingerprint(afterSnapshot.ledger), ledgerSha256: fullLedgerFingerprint(afterSnapshot.ledger),
    schemaObjectCount: afterSnapshot.schema.length,
    schemaSha256: schemaFingerprint(afterSnapshot.schema), protectedTableCounts: afterReceipt.protectedTableCounts,
    protectedAuthorityTableDigests: afterReceipt.protectedAuthorityTableDigests,
    protectedAuthorityStateSHA256: afterReceipt.protectedAuthorityStateSHA256, authorityDigestExcludedColumns: AUTHORITY_DIGEST_EXCLUDED_COLUMNS,
    staffLastSeenAtBeforeSha256: telemetry.beforeSha256, staffLastSeenAtAfterSha256: telemetry.afterSha256,
    staffLastSeenAtChangedCount: telemetry.changedCount, nativeStaffControlEnabled: 0,
    migrationRecordAdded: MIGRATION_NAME, loginObjectsAdded: 23, seededLoginRows: 1, aliasRowsAdded: 0 };
}

async function openOneShotJournal(filename) {
  if (fs.existsSync(filename)) fail('journal_exists_no_replay');
  let handle;
  try { handle = await fs.promises.open(filename, 'wx', 0o600); } catch { fail('journal_create_failed'); }
  return {
    async append(entry) { await handle.writeFile(`${canonical({ at: new Date().toISOString(), ...entry })}\n`, 'utf8'); await handle.sync(); },
    async close() { await handle.close(); },
  };
}
