import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_NAME = '0226_staff_login_bindings.sql';
const MIGRATION_SHA256 = 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5';
const WIRE_FIXTURE_PATH = path.join(ROOT, 'scripts','fixtures','staging-ops-0226-wrangler-wire-statements.json');
const WIRE_FIXTURE_SHA256 = 'fd02f7220e2afaeb1105a19da0dc14b3c9329c084ac6500b8d0b5e32b440edb3';
const WIRE_STATEMENTS_SHA256 = '29c324b1daa438c532ae050cb4f0d0e1db10b24eb4e876cef7682a9c98e03474';
const WIRE_SCHEMA_SHA256 = '2ec57a1391b2f63a042ff0e85b358e3666b74f4cc366eff7651c7cd4fbe4c729';
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const MAX_ROWS = 20_000;
const MAX_CAPTURE_AGE_MS = 60_000;
const PLAN_TTL_MS = 5 * 60_000;

export const STAGING_OPS_0226_TARGET = Object.freeze({
  environment: 'staging', accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
  application: 'operations', workerName: 'ledgetop-ops-staging', binding: 'OPS_DB',
  databaseName: 'ltds-ops-staging', databaseId: '78b34173-b168-4e3d-9832-bb9d245cc6b8',
});

/** Full legacy staff/role/profile/admission state. Rows are transient in memory;
 * only their counts and digests enter plans and journals. */
export const STAGING_OPS_0226_PROTECTED_TABLES = Object.freeze(Object.fromEntries(Object.entries({
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

const REQUIRED_TABLE_COLUMNS = Object.freeze({ ...STAGING_OPS_0226_PROTECTED_TABLES });
const LOGIN_PREFIX_OBJECTS = Object.freeze([
  'staff_login_binding_control','staff_login_generations','staff_login_binding_intents','staff_login_bindings','staff_login_binding_audit',
  'staff_login_bindings_active_email','staff_login_bindings_active_subject',
  'staff_login_intent_insert','staff_login_intent_update','staff_login_intent_no_delete','staff_login_binding_insert',
  'staff_login_binding_update','staff_login_binding_no_delete','staff_login_binding_linked','staff_login_binding_revoked',
  'staff_login_canonical_insert_collision','staff_login_canonical_update_collision','staff_login_generation_update',
  'staff_login_generation_no_delete','staff_login_audit_no_update','staff_login_audit_no_delete',
  'staff_login_control_no_update','staff_login_control_no_delete',
]);

export const STAGING_OPS_0226_BASELINE = Object.freeze({
  ledgerCount: 228,
  ledgerNamesSha256: '141339754613ec2cebcc738e4e40c751e330e5bfcb5b5027e2286d61f4902fbc',
  ledgerSha256: 'aa555ae2aeecad2b86d0fbbf2a1023ec32411b84430aeb966de6257af1b2f789',
  schemaObjectCount: 2482,
  schemaSha256: '0669845dedc950215d37efff792ceae8ce29f335590eea45721619c8aa438388',
  requiredMigrations: Object.freeze([
    '0224_windows_portal_publication_chain_index.sql',
    '0225_native_staff_lifecycle_bridge.sql',
    '0233_operations_portal_native_recipient_capability_intents.sql',
    '0234_operations_portal_native_inquiry_capability.sql',
    '0235_ops_principal_inquiries.sql',
  ]),
  forbiddenPending: Object.freeze([
    '0226_staff_login_bindings.sql', '0227_owner_intel_reads.sql','0228_competitor_intel_ingest.sql',
    '0229_owner_intel_source_feed.sql','0230_app_release_pilot.sql','0231_owner_google_ads_summary.sql',
  ]),
});

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(`staging_ops_0226:${code}`); };
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
function protectedState(snapshot) {
  if (!exactKeys(snapshot.protectedRows, Object.keys(STAGING_OPS_0226_PROTECTED_TABLES))) fail('protected_rows_invalid');
  const counts = {}, digests = {};
  for (const [table, columns] of Object.entries(STAGING_OPS_0226_PROTECTED_TABLES)) {
    const rows = snapshot.protectedRows[table];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS || rows.some(row => !exactKeys(row, columns))) fail('protected_rows_invalid');
    counts[table] = rows.length;
    digests[table] = hash(canonical([...rows].sort((a,b) => canonical(a).localeCompare(canonical(b)))));
  }
  const control = snapshot.protectedRows.native_staff_access_reconciliation;
  if (control.length !== 1 || control[0].singleton !== 1 || control[0].enabled !== 0) fail('native_staff_control_not_zero');
  return { counts, digests, stateSha256: hash(canonical({ counts, digests })) };
}

function validateTarget(target) {
  if (!exactKeys(target, Object.keys(STAGING_OPS_0226_TARGET))
    || Object.entries(STAGING_OPS_0226_TARGET).some(([key,value]) => target[key] !== value)) fail('target_mismatch');
}
function validateBaseline(snapshot, baseline, now) {
  if (!exactKeys(baseline, ['ledgerCount','ledgerNamesSha256','ledgerSha256','schemaObjectCount','schemaSha256','requiredMigrations','forbiddenPending'])
    || !Number.isSafeInteger(baseline.ledgerCount) || baseline.ledgerCount < 1 || !SHA.test(baseline.ledgerNamesSha256)
    || !SHA.test(baseline.ledgerSha256)
    || !Number.isSafeInteger(baseline.schemaObjectCount) || baseline.schemaObjectCount < 1 || !SHA.test(baseline.schemaSha256)
    || !Array.isArray(baseline.requiredMigrations) || !Array.isArray(baseline.forbiddenPending)) fail('baseline_profile_invalid');
  if (!exactKeys(snapshot, ['target','observedAt','ledger','schema','schemaColumns','protectedRows'])
    || !iso(snapshot.observedAt, now)) fail('snapshot_stale_or_invalid');
  validateTarget(snapshot.target);
  const namesSha256 = ledgerFingerprint(snapshot.ledger), ledgerSha256 = fullLedgerFingerprint(snapshot.ledger), schemaSha256 = schemaFingerprint(snapshot.schema);
  if (snapshot.ledger.length !== baseline.ledgerCount || namesSha256 !== baseline.ledgerNamesSha256) fail('ledger_pin_mismatch');
  if (ledgerSha256 !== baseline.ledgerSha256) fail('ledger_pin_mismatch');
  if (snapshot.schema.length !== baseline.schemaObjectCount || schemaSha256 !== baseline.schemaSha256) fail('schema_pin_mismatch');
  const names = new Set(snapshot.ledger.map(row => row.name));
  if (baseline.requiredMigrations.some(name => !names.has(name)) || baseline.forbiddenPending.some(name => names.has(name)))
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
    if (error?.message?.startsWith('staging_ops_0226:')) throw error;
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
    if (error?.message?.startsWith('staging_ops_0226:')) throw error;
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
  return { observedAt: snapshot.observedAt, target: STAGING_OPS_0226_TARGET,
    ledgerCount: snapshot.ledger.length, ledgerNamesSha256: validated.namesSha256, ledgerSha256: validated.ledgerSha256,
    schemaObjectCount: snapshot.schema.length, schemaSha256: validated.schemaSha256,
    protectedTableCounts: validated.state.counts, protectedStateSha256: validated.state.stateSha256,
    nativeStaffControlEnabled: 0 };
}

function postReceiptProjection(snapshot, now) {
  if (!validIso(snapshot.observedAt) || Date.parse(snapshot.observedAt) > now
    || now - Date.parse(snapshot.observedAt) > MAX_CAPTURE_AGE_MS) fail('post_snapshot_stale_or_invalid');
  validateTarget(snapshot.target);
  const state = protectedState(snapshot);
  return { observedAt: snapshot.observedAt, target: STAGING_OPS_0226_TARGET,
    protectedTableCounts: state.counts, protectedStateSha256: state.stateSha256, nativeStaffControlEnabled: 0 };
}

function unsignedPlan(plan) { const { planSha256, ...value } = plan; return value; }
function planHash(plan) { return hash(canonical(unsignedPlan(plan))); }

function compileWithBaseline(snapshot, { baseline, sourceCommit, root = ROOT, now = Date.now() } = {}) {
  if (!commitValid(sourceCommit)) fail('source_commit_invalid');
  const sql = migrationSql(root), pre = receiptProjection(snapshot, baseline, now);
  const wire = readPinnedWireStatements(sql), expectedObjects = expectedLoginObjects(wire.statements);
  if (schemaFingerprint(expectedObjects) !== WIRE_SCHEMA_SHA256) fail('wire_expected_schema_mismatch');
  const plan = { schemaVersion: 1, contract: 'staging-ops-staff-login-0226-one-shot-v1', sourceCommit,
    target: STAGING_OPS_0226_TARGET, compiledAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    migration: { name: MIGRATION_NAME, sha256: MIGRATION_SHA256, sql, ledgerAppend: true },
    wireFixtureSha256: WIRE_FIXTURE_SHA256, wireStatementsSha256: WIRE_STATEMENTS_SHA256,
    expectedAddedObjectsSha256: schemaFingerprint(expectedObjects), expectedAddedObjectCount: expectedObjects.length,
    expectedNamedObjectCount: 23, preflight: pre };
  plan.planSha256 = planHash(plan);
  return plan;
}

/** The default planner uses the exact staging ledger/schema captured in the
 * hash-only control capsule. The factory is injectable solely for synthetic
 * local tests; it never changes the fixed account/database or migration pin. */
export function createStagingOps0226Operator({ baseline = STAGING_OPS_0226_BASELINE } = {}) {
  return Object.freeze({
    compile: (snapshot, options = {}) => compileWithBaseline(snapshot, { ...options, baseline }),
    executeOnce: async ({ plan, provider, journalPath, now = Date.now } = {}) => {
      if (!provider || typeof provider.readSnapshot !== 'function' || typeof provider.applyExactMigration !== 'function')
        fail('provider_contract_invalid');
      if (!path.isAbsolute(journalPath ?? '')) fail('journal_path_invalid');
      if (fs.existsSync(journalPath)) fail('journal_exists_no_replay');
      if (!exactKeys(plan, ['schemaVersion','contract','sourceCommit','target','compiledAt','expiresAt','migration',
        'wireFixtureSha256','wireStatementsSha256','expectedAddedObjectsSha256','expectedAddedObjectCount','expectedNamedObjectCount','preflight','planSha256'])
        || plan.schemaVersion !== 1 || plan.contract !== 'staging-ops-staff-login-0226-one-shot-v1'
        || plan.planSha256 !== planHash(plan) || !commitValid(plan.sourceCommit)) fail('plan_invalid');
      if (!exactKeys(plan.migration, ['name','sha256','sql','ledgerAppend'])
        || !exactKeys(plan.preflight, ['observedAt','target','ledgerCount','ledgerNamesSha256','ledgerSha256','schemaObjectCount','schemaSha256',
          'protectedTableCounts','protectedStateSha256','nativeStaffControlEnabled'])
        || !validIso(plan.compiledAt) || !validIso(plan.expiresAt)
        || Date.parse(plan.compiledAt) > now() || Date.parse(plan.expiresAt) <= now()
        || Date.parse(plan.expiresAt) - Date.parse(plan.compiledAt) > PLAN_TTL_MS) fail('plan_invalid');
      validateTarget(plan.target);
      if (plan.migration.name !== MIGRATION_NAME || plan.migration.sha256 !== MIGRATION_SHA256
        || plan.migration.ledgerAppend !== true || hash(Buffer.from(plan.migration.sql, 'utf8')) !== MIGRATION_SHA256
        || plan.wireFixtureSha256 !== WIRE_FIXTURE_SHA256 || plan.wireStatementsSha256 !== WIRE_STATEMENTS_SHA256
        || Date.parse(plan.expiresAt) <= now() || Date.parse(plan.compiledAt) > now()) fail('plan_expired_or_migration_pin_mismatch');
      const wire = readPinnedWireStatements(plan.migration.sql);

      const beforeSnapshot = await provider.readSnapshot({ target: STAGING_OPS_0226_TARGET, phase: 'immediate-prewrite',
        query: STAGING_OPS_0226_PRE_READ_QUERY });
      const before = receiptProjection(beforeSnapshot, baseline, now());
      if (before.ledgerNamesSha256 !== plan.preflight.ledgerNamesSha256 || before.ledgerSha256 !== plan.preflight.ledgerSha256
        || before.schemaSha256 !== plan.preflight.schemaSha256
        || before.protectedStateSha256 !== plan.preflight.protectedStateSha256
        || canonical(before.protectedTableCounts) !== canonical(plan.preflight.protectedTableCounts)) fail('prewrite_drift');

      const journal = await openOneShotJournal(journalPath);
      try {
        await journal.append({ phase: 'migration-0226-apply-intent', planSha256: plan.planSha256,
          sourceCommit: plan.sourceCommit, migrationSha256: MIGRATION_SHA256, target: STAGING_OPS_0226_TARGET,
          preflight: before });
        try {
          // One provider call. The injected adapter must not retry after an ambiguous response.
          await provider.applyExactMigration({ target: STAGING_OPS_0226_TARGET, name: MIGRATION_NAME,
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
          afterSnapshot = await provider.readSnapshot({ target: STAGING_OPS_0226_TARGET, phase: 'postwrite',
            query: STAGING_OPS_0226_POST_READ_QUERY });
          const after = validatePostSnapshot(beforeSnapshot, afterSnapshot, plan, baseline, now());
          await journal.append({ phase: 'migration-0226-postread-verified', planSha256: plan.planSha256, postflight: after });
          return { schemaVersion: 1, contract: plan.contract, sourceCommit: plan.sourceCommit,
            planSha256: plan.planSha256, migrationSha256: MIGRATION_SHA256, target: STAGING_OPS_0226_TARGET,
            before, after, mutationCalls: 1 };
        } catch (error) {
          await journal.append({ phase: 'migration-0226-postread-unverified', planSha256: plan.planSha256,
            reason: error?.message?.startsWith('staging_ops_0226:') ? error.message : 'postread_failed',
            note: 'Do not retry; reconcile the existing migration state read-only.' });
          throw error;
        }
      } finally { await journal.close(); }
    },
  });
}

const defaultOperator = createStagingOps0226Operator();
export const compileStagingOpsStaffLogin0226Plan = defaultOperator.compile;
export const executeStagingOpsStaffLogin0226Once = defaultOperator.executeOnce;

function rowsSql(table, columns) {
  const projection = columns.map(column => `"${column}"`).join(',');
  const json = columns.map(column => `'${column}',q."${column}"`).join(',');
  return `'${table}',json((SELECT json_group_array(json_object(${json})) FROM (SELECT ${projection} FROM "${table}" ORDER BY ${projection} LIMIT ${MAX_ROWS + 1}) q))`;
}
const protectedRowsSql = Object.entries(STAGING_OPS_0226_PROTECTED_TABLES).map(([table,columns]) => rowsSql(table,columns)).join(',\n  ');
const schemaColumnsSql = Object.keys(REQUIRED_TABLE_COLUMNS).map(table => `'${table}',json((SELECT json_group_array(name)
  FROM (SELECT name FROM pragma_table_info('${table}') ORDER BY cid)))`).join(',\n  ');
const commonSnapshotSql = `SELECT json_object(
  'ledger',json((SELECT json_group_array(json_object('id',id,'name',name)) FROM (SELECT id,name FROM d1_migrations ORDER BY id))),
  'schema',json((SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql))
    FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL
      AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name))),
  'schemaColumns',json_object(${schemaColumnsSql}),
  'protectedRows',json_object(${protectedRowsSql})`;
export const STAGING_OPS_0226_PRE_READ_QUERY = `${commonSnapshotSql}) AS staging_ops_0226_snapshot`;
export const STAGING_OPS_0226_POST_READ_QUERY = `${commonSnapshotSql},
  'loginState',json_object(
    'controlCount',(SELECT count(*) FROM staff_login_binding_control),
    'controlSingleton',(SELECT singleton FROM staff_login_binding_control WHERE singleton=1),
    'controlSchemaVersion',(SELECT schema_version FROM staff_login_binding_control WHERE singleton=1),
    'generationsCount',(SELECT count(*) FROM staff_login_generations),
    'intentsCount',(SELECT count(*) FROM staff_login_binding_intents),
    'bindingsCount',(SELECT count(*) FROM staff_login_bindings),
    'auditCount',(SELECT count(*) FROM staff_login_binding_audit))) AS staging_ops_0226_snapshot`;

export function parseStagingOps0226SnapshotResult(value, { observedAt, target = STAGING_OPS_0226_TARGET } = {}) {
  let payload; try { payload = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail('read_result_invalid'); }
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true || !Array.isArray(payload[0].results)
    || payload[0].meta?.rows_written !== 0 || payload[0].meta?.changed_db !== false || payload[0].meta?.served_by_primary !== true
    || payload[0].results.length !== 1 || typeof payload[0].results[0]?.staging_ops_0226_snapshot !== 'string'
    || Buffer.byteLength(payload[0].results[0].staging_ops_0226_snapshot) > 24 * 1024 * 1024) fail('read_result_invalid');
  let snapshot; try { snapshot = JSON.parse(payload[0].results[0].staging_ops_0226_snapshot); } catch { fail('read_result_invalid'); }
  return { ...snapshot, target, observedAt };
}

function validatePostSnapshot(beforeSnapshot, afterSnapshot, plan, baseline, now) {
  if (!exactKeys(afterSnapshot, ['target','observedAt','ledger','schema','schemaColumns','protectedRows','loginState'])
    || !iso(afterSnapshot.observedAt, now)) fail('post_snapshot_stale_or_invalid');
  orderedSchema(afterSnapshot.schema);
  const afterReceipt = postReceiptProjection(afterSnapshot, now);
  const afterProtected = { stateSha256: afterReceipt.protectedStateSha256, counts: afterReceipt.protectedTableCounts };
  if (afterProtected.stateSha256 !== plan.preflight.protectedStateSha256
    || canonical(afterProtected.counts) !== canonical(plan.preflight.protectedTableCounts)) fail('protected_rows_changed');
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
    protectedStateSha256: afterReceipt.protectedStateSha256, nativeStaffControlEnabled: 0,
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
