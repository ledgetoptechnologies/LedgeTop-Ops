// Ordered once-operator for the Operations D1 migrations 0227..0244.
//
// It advances a D1 database whose ledger is exactly the 226-row production
// ledger ending at 0226_staff_login_bindings.sql through the ten pinned files,
// one at a time, in lexical order. Each file is applied the same way as the
// 0226 precedent: one D1 REST batch holding the pinned Wrangler wire statements
// plus `INSERT INTO d1_migrations(name) VALUES (?)`. A read-only preflight runs
// before each file and an exact post-check after it. The first mismatch or
// failure stops the run; nothing is retried, replayed or resumed.
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
export const OPS_0227_0244_AUTHORITY_NOTE = 'recapture the post-0226 authority snapshot (role_permissions changed)';
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
      ('provisioning_source','sync_protected','project_alpha_user_id','access_subject','status')))`;
const PROBE_KEYS = Object.freeze(['ownerAdminRoles', 'flightLogsPermissions', 'flightLogsRolePermissions', 'claimedOnboarding',
  'onboardingApprovers', 'staffLoginPrerequisiteTables', 'catalogPermissionKeys', 'nativeHireOverrides', 'nativeHires',
  'nativeStaffReconciliationRows', 'nativeStaffReconciliationEnabled', 'staffUsersViewColumns']);

/** One read-only SELECT. `tables` adds row counts for tables a step created (post-check only). */
export function ops0227To0244SnapshotQuery(tables = []) {
  if (!Array.isArray(tables) || tables.some(table => !IDENT.test(table))) fail('read_query_tables_invalid');
  const tableRows = tables.length === 0 ? 'json_object()'
    : `json_object(${tables.map(table => `'${table}',(SELECT count(*) FROM "${table}")`).join(',')})`;
  return `SELECT json_object(
  'ledger',json((SELECT json_group_array(json_object('id',id,'name',name)) FROM (SELECT id,name FROM d1_migrations ORDER BY id))),
  'schema',json((SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql))
    FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL
      AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name))),
  'probes',${PROBES_SQL},
  'tableRows',${tableRows}) AS ops_0227_0244_snapshot`;
}
export const OPS_0227_0244_PRE_READ_QUERY = ops0227To0244SnapshotQuery();
const WRITE_WORD = /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA\s+\w+\s*=|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT)\b/iu;
export function isOps0227To0244ReadQuery(query) {
  return typeof query === 'string' && query.startsWith('SELECT json_object(\n  \'ledger\'')
    && query.endsWith(' AS ops_0227_0244_snapshot') && !WRITE_WORD.test(query.replace(/'[^']*'/gu, "''")) && !query.includes(';');
}

/** Parses a D1 `/query` result for the snapshot query; it must be a zero-write primary read. */
export function parseOps0227To0244SnapshotResult(value, { observedAt } = {}) {
  let payload; try { payload = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail('read_result_invalid'); }
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true || !Array.isArray(payload[0].results)
    || payload[0].meta?.rows_written !== 0 || payload[0].meta?.changed_db !== false || payload[0].meta?.served_by_primary !== true
    || payload[0].results.length !== 1 || typeof payload[0].results[0]?.ops_0227_0244_snapshot !== 'string'
    || Buffer.byteLength(payload[0].results[0].ops_0227_0244_snapshot) > 24 * 1024 * 1024) fail('read_result_invalid');
  let snapshot; try { snapshot = JSON.parse(payload[0].results[0].ops_0227_0244_snapshot); } catch { fail('read_result_invalid'); }
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) fail('read_result_invalid');
  return validateSnapshot({ ...snapshot, observedAt });
}

function validateSnapshot(snapshot) {
  if (!exactKeys(snapshot, ['ledger', 'schema', 'probes', 'tableRows', 'observedAt'])) fail('snapshot_invalid');
  const { ledger, schema, probes, tableRows } = snapshot;
  if (!Array.isArray(ledger) || ledger.length > MAX_ROWS || ledger.some((row, index) => !exactKeys(row, ['id', 'name'])
    || !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.name !== 'string' || row.name.length === 0
    || (index > 0 && ledger[index - 1].id >= row.id)) || new Set(ledger.map(row => row.name)).size !== ledger.length) fail('ledger_invalid');
  if (!Array.isArray(schema) || schema.length > MAX_ROWS || schema.some(row => !exactKeys(row, ['type', 'name', 'tbl_name', 'sql'])
    || !['table', 'index', 'view', 'trigger'].includes(row.type) || typeof row.name !== 'string'
    || typeof row.tbl_name !== 'string' || typeof row.sql !== 'string')) fail('schema_invalid');
  if (!exactKeys(probes, PROBE_KEYS) || PROBE_KEYS.some(key => key !== 'nativeStaffReconciliationEnabled'
    && (!Number.isSafeInteger(probes[key]) || probes[key] < 0))
    || (probes.nativeStaffReconciliationEnabled !== null && !Number.isSafeInteger(probes.nativeStaffReconciliationEnabled))) fail('probes_invalid');
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

function stepPreflightChecks(snapshot, file) {
  const names = new Set(file.expectedAddedObjects.map(object => object.name));
  const p = snapshot.probes, checks = [
    check('file_objects_absent', 0, snapshot.schema.filter(row => names.has(row.name)).length),
  ];
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

function postChecks(before, after, file) {
  const expectedLedger = [...before.ledger, { id: before.ledger.at(-1).id + 1, name: file.name }];
  const beforeKeys = new Set(before.schema.map(objectKey));
  const kept = after.schema.filter(row => beforeKeys.has(objectKey(row)));
  const added = after.schema.filter(row => !beforeKeys.has(objectKey(row)));
  const checks = [
    check('ledger_row_appended', true, canonical(after.ledger) === canonical(expectedLedger)),
    check('existing_schema_unchanged', true, canonical(kept) === canonical(before.schema)),
    check('added_objects', file.expectedAddedObjects, added.map(({ type, name, tbl_name }) => ({ type, name, tbl_name }))),
    check('added_schema_sha256', file.expectedAddedSchemaSha256, schemaRowsSha256(added)),
    check('new_table_rows', file.expectedNewTableRows, after.tableRows),
  ];
  if (file.name.startsWith('0240')) checks.push(check('flight_logs_permissions', 2, after.probes.flightLogsPermissions),
    check('flight_logs_role_permissions', 2 * before.probes.ownerAdminRoles, after.probes.flightLogsRolePermissions));
  return { checks, addedObjectCount: added.length };
}

const failed = checks => checks.find(item => !item.ok);
const ledgerSummary = ledger => ({ count: ledger.length, lastMigration: ledger.at(-1)?.name ?? null, namesSha256: namesSha256(ledger) });

// ---------------------------------------------------------------------------
// Receipt

/** Exclusive receipt file. It is rewritten in full after every step, so a stop leaves a complete partial receipt. */
export function openOps0227To0244Receipt(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('receipt_path_invalid');
  let fd;
  try { fd = fs.openSync(filename, 'wx', 0o600); } catch (error) {
    if (error?.code === 'EEXIST') fail('receipt_exists_no_replay');
    fail('receipt_create_failed');
  }
  return {
    write(receipt) {
      const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      fs.ftruncateSync(fd, 0); fs.writeSync(fd, bytes, 0, bytes.length, 0); fs.fsyncSync(fd);
    },
    close() { fs.closeSync(fd); },
  };
}

// ---------------------------------------------------------------------------
// Ordered run

const errorCode = error => (error instanceof Error && /^ops_0227_0244[a-z_]*:/u.test(error.message)) ? error.message : 'unexpected_error';

/**
 * Runs the ordered plan against an injected provider:
 *   provider.readSnapshot({ query }) -> parsed snapshot (read-only)
 *   provider.applyMigration({ name, sha256, statements, statementsSha256 }) -> one batch, never retried
 * mode 'dry-run' performs one read and never calls applyMigration.
 */
export async function runOps0227To0244Ordered({ plan, provider, mode = 'dry-run', target, receipt = null,
  now = () => new Date(), log = () => {} } = {}) {
  if (!['dry-run', 'execute'].includes(mode)) fail('mode_invalid');
  if (!plan || plan.contract !== OPS_0227_0244_CONTRACT || !Array.isArray(plan.files) || plan.files.length !== 10) fail('plan_invalid');
  if (!provider || typeof provider.readSnapshot !== 'function' || (mode === 'execute' && typeof provider.applyMigration !== 'function'))
    fail('provider_contract_invalid');
  if (mode === 'execute' && !receipt) fail('receipt_required');
  const stamp = () => now().toISOString();
  const state = {
    schemaVersion: 1, contract: OPS_0227_0244_CONTRACT, mode, planSha256: plan.planSha256, fixtureSha256: plan.fixtureSha256,
    target: target ?? null, startedAt: stamp(), finishedAt: null, status: 'running', stop: null,
    files: plan.files.map(({ order, name, ledgerId, sha256, statementCount, statementsSha256, expectedAddedObjectCount }) =>
      ({ order, name, ledgerId, sha256, statementCount, statementsSha256, expectedAddedObjectCount })),
    initial: null, steps: [], notes: [], finalLedger: null, writesPerformed: 0,
  };
  const persist = () => { if (receipt) receipt.write(state); };
  const stop = (step, phase, code, detail = null) => {
    state.status = 'stopped'; state.stop = { step, phase, code, ...(detail ? { detail } : {}) };
    log(`STOP at ${step ?? 'start'} (${phase}): ${code}`);
  };
  const read = async query => provider.readSnapshot({ query });
  persist();
  let current;
  try { current = await read(OPS_0227_0244_PRE_READ_QUERY); }
  catch (error) { stop(null, 'initial-read', errorCode(error)); }
  if (current) {
    const checks = initialLedgerChecks(current, plan);
    state.initial = { observedAt: current.observedAt, ledger: ledgerSummary(current.ledger), schemaObjectCount: current.schema.length, checks };
    const bad = failed(checks);
    if (bad) stop(null, 'initial-ledger', `prior_ledger_mismatch:${bad.name}`);
  }
  persist();
  const initialLedger = current?.ledger ?? [];
  for (let index = 0; state.status === 'running' && index < plan.files.length; index++) {
    const file = plan.files[index];
    const step = { order: file.order, name: file.name, preflight: null, apply: null, post: null };
    state.steps.push(step);
    if (mode === 'execute' && index > 0) {
      try { current = await read(OPS_0227_0244_PRE_READ_QUERY); }
      catch (error) { stop(file.name, 'preflight-read', errorCode(error)); persist(); break; }
    }
    const checks = [...(mode === 'execute' || index === 0 ? ledgerChecks(current, initialLedger, plan, index) : []),
      ...stepPreflightChecks(current, file)];
    step.preflight = { observedAt: current.observedAt, ledgerCount: current.ledger.length,
      ledgerDeferred: mode === 'dry-run' && index > 0, checks, recorded: recordedCounts(current, file) };
    const bad = failed(checks);
    if (bad) { stop(file.name, 'preflight', `preflight_failed:${bad.name}`); persist(); break; }
    log(`${mode === 'execute' ? 'preflight ok' : 'dry-run ok'}: ${file.name}`);
    if (mode === 'dry-run') { persist(); continue; }
    step.apply = { startedAt: stamp(), finishedAt: null, statements: file.statementCount + 1 };
    persist();
    try {
      await provider.applyMigration({ name: file.name, sha256: file.sha256, statements: file.statements,
        statementsSha256: file.statementsSha256 });
    } catch (error) {
      step.apply.finishedAt = stamp();
      stop(file.name, 'apply', 'apply_failed_outcome_unknown_no_retry', errorCode(error));
      state.notes.push('Do not retry or resume. Reconcile d1_migrations and sqlite_master read-only before any next step.');
      persist(); break;
    }
    state.writesPerformed++;
    step.apply.finishedAt = stamp();
    persist();
    let after;
    try { after = await read(ops0227To0244SnapshotQuery(Object.keys(file.expectedNewTableRows).sort())); }
    catch (error) { stop(file.name, 'post-read', errorCode(error)); persist(); break; }
    const post = postChecks(current, after, file);
    step.post = { observedAt: after.observedAt, ledgerCount: after.ledger.length, ledgerTail: after.ledger.at(-1)?.name ?? null,
      addedObjectCount: post.addedObjectCount, tableRows: after.tableRows, checks: post.checks };
    const badPost = failed(post.checks);
    if (badPost) { stop(file.name, 'post-check', `post_check_failed:${badPost.name}`); persist(); break; }
    log(`applied and verified: ${file.name} (ledger ${after.ledger.length})`);
    if (file.name.startsWith('0240')) { state.notes.push(`After 0240: ${OPS_0227_0244_AUTHORITY_NOTE}`); log(`NOTE: ${OPS_0227_0244_AUTHORITY_NOTE}`); }
    current = after;
  }
  if (state.status === 'running') {
    state.status = mode === 'execute' ? 'complete' : 'dry-run-passed';
    if (mode === 'dry-run') state.notes.push(`0240 will change role_permissions: ${OPS_0227_0244_AUTHORITY_NOTE} after the apply.`);
  }
  if (current) state.finalLedger = ledgerSummary(current.ledger);
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

const USAGE = 'usage: node scripts/production-ops-0227-0244-ordered-once.mjs [--dry-run | --execute --receipt <absolute path>] '
  + '--account-id <id> --database-id <uuid> --database-name <name> [--rehearsal] [--receipt <absolute path>]';

export function parseOps0227To0244Args(args, env = {}) {
  const options = { mode: 'dry-run', accountId: env.CLOUDFLARE_ACCOUNT_ID ?? null, databaseId: null, databaseName: null,
    receiptPath: null, rehearsal: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail('usage');
    seen.add(arg);
    if (arg === '--dry-run' || arg === '--execute') {
      if (seen.has('--dry-run') && seen.has('--execute')) fail('usage');
      options.mode = arg.slice(2);
    } else if (arg === '--rehearsal') options.rehearsal = true;
    else if (['--account-id', '--database-id', '--database-name', '--receipt'].includes(arg)) {
      const value = args[++i];
      if (typeof value !== 'string' || value.startsWith('--') || value.length === 0) fail('usage');
      options[{ '--account-id': 'accountId', '--database-id': 'databaseId', '--database-name': 'databaseName', '--receipt': 'receiptPath' }[arg]] = value;
    } else fail('usage');
  }
  if (!/^[a-f0-9]{32}$/u.test(options.accountId ?? '')) fail('account_id_required');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(options.databaseId ?? '')) fail('database_id_required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(options.databaseName ?? '')) fail('database_name_required');
  if (options.receiptPath !== null && !path.isAbsolute(options.receiptPath)) fail('receipt_path_invalid');
  const isProduction = options.databaseId === OPS_PRODUCTION_DATABASE.databaseId;
  if (isProduction && (options.accountId !== OPS_PRODUCTION_DATABASE.accountId || options.databaseName !== OPS_PRODUCTION_DATABASE.databaseName))
    fail('production_target_mismatch');
  if (options.mode === 'execute') {
    if (!options.receiptPath) fail('receipt_required');
    if (isProduction && options.rehearsal) fail('rehearsal_refuses_production_database');
    if (!isProduction && !options.rehearsal) fail('rehearsal_flag_required_for_non_production_database');
  }
  return Object.freeze({ ...options, environment: isProduction ? 'production' : 'non-production' });
}

async function promptConfirmation(phrase) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('interactive_confirmation_required');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(`Type ${phrase} to apply ten migrations in order: `)) === phrase; }
  finally { terminal.close(); }
}

/** CLI entry with injectable dependencies for offline tests. */
export async function mainOps0227To0244(args, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const out = dependencies.out ?? (line => process.stdout.write(`${line}\n`));
  const options = parseOps0227To0244Args(args, env);
  const target = { environment: options.environment, accountId: options.accountId, databaseId: options.databaseId,
    databaseName: options.databaseName };
  let receipt = null;
  if (options.receiptPath) receipt = (dependencies.openReceipt ?? openOps0227To0244Receipt)(options.receiptPath);
  try {
    let plan;
    try { plan = loadVerifiedOps0227To0244Plan({ root: dependencies.root ?? ROOT }); }
    catch (error) {
      const refusal = { schemaVersion: 1, contract: OPS_0227_0244_CONTRACT, mode: options.mode, target, status: 'refused',
        stop: { step: null, phase: 'local-verification', code: errorCode(error) }, writesPerformed: 0, at: new Date().toISOString() };
      receipt?.write(refusal);
      return refusal;
    }
    out(`Ordered plan ${plan.planSha256} (prior ledger ${plan.priorLedger.count} -> ${plan.finalLedger.count}):\n${describeOps0227To0244Plan(plan)}`);
    if (options.mode === 'execute' && options.environment === 'production') await (dependencies.sourceCheck ?? defaultSourceCheck)();
    const token = env.CLOUDFLARE_API_TOKEN;
    if (typeof token !== 'string' || token.length < 20 || token.length > 16_384) fail('cloudflare_token_missing');
    const providerFactory = dependencies.providerFactory ?? (await import('./production-ops-0227-0244-cloudflare-provider.mjs')).createOps0227To0244CloudflareProvider;
    const provider = providerFactory({ getBearerToken: () => token, accountId: options.accountId, databaseId: options.databaseId,
      databaseName: options.databaseName, allowWrites: options.mode === 'execute' });
    await provider.assertTarget();
    const readOnly = { readSnapshot: query => provider.readSnapshot(query) };
    const rehearsal = await runOps0227To0244Ordered({ plan, provider: readOnly, mode: 'dry-run', target, receipt: options.mode === 'dry-run' ? receipt : null, log: out });
    if (options.mode === 'dry-run' || rehearsal.status !== 'dry-run-passed') {
      if (options.mode === 'execute') receipt?.write({ ...rehearsal, mode: 'execute', status: 'refused' });
      return rehearsal;
    }
    const phrase = OPS_0227_0244_CONFIRMATION(options.databaseName);
    if (!await (dependencies.confirm ?? promptConfirmation)(phrase)) {
      const cancelled = { ...rehearsal, mode: 'execute', status: 'cancelled', writesPerformed: 0 };
      receipt?.write(cancelled);
      return cancelled;
    }
    return await runOps0227To0244Ordered({ plan, provider, mode: 'execute', target, receipt, log: out });
  } finally { receipt?.close(); }
}

async function defaultSourceCheck() {
  const { currentMainSource } = await import('./production-ops-staff-login-0226-run.mjs');
  return currentMainSource();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await mainOps0227To0244(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ status: result.status, mode: result.mode, stop: result.stop ?? null,
      finalLedger: result.finalLedger ?? null, writesPerformed: result.writesPerformed ?? 0 })}\n`);
    process.exitCode = ['complete', 'dry-run-passed'].includes(result.status) ? 0 : result.status === 'cancelled' ? 2 : 1;
  } catch (error) {
    process.stderr.write(`${errorCode(error) === 'unexpected_error' ? 'ops_0227_0244:unexpected_error' : errorCode(error)}\n${errorCode(error) === 'ops_0227_0244:usage' ? `${USAGE}\n` : ''}`);
    process.exitCode = 1;
  }
}
