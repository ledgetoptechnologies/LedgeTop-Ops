import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStaffReadiness, NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY, ORDINARY_FRONTEND_AUTHORITY_TABLES } from './ordinary-frontend-authority-reader.mjs';
import { validateOrdinaryFrontendAuthorityObservation } from './ordinary-frontend-authority.mjs';

export const POST0226_STAFF_PRESERVATION_CONTRACT = 'ordinary-frontend-preserve-native-staff-post0226-v1';
export const POST0226_STAFF_LOGIN_MIGRATION_SHA256 = 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5';
const POST0226_WIRE_FIXTURE_SHA256 = 'fd02f7220e2afaeb1105a19da0dc14b3c9329c084ac6500b8d0b5e32b440edb3';
const POST0226_WIRE_STATEMENTS_SHA256 = '29c324b1daa438c532ae050cb4f0d0e1db10b24eb4e876cef7682a9c98e03474';
const POST0226_WIRE_SCHEMA_SHA256 = '2ec57a1391b2f63a042ff0e85b358e3666b74f4cc366eff7651c7cd4fbe4c729';
export const POST0226_LOGIN_TABLES = Object.freeze(Object.fromEntries(Object.entries({
  staff_login_binding_control: ['singleton','schema_version'],
  staff_login_generations: ['staff_id','generation'],
  staff_login_binding_intents: ['id','staff_id','canonical_email','canonical_subject','issuer','alternate_email','token_sha256','generation','created_at_ms','expires_at_ms','status','binding_id'],
  staff_login_bindings: ['id','staff_id','issuer','login_email','access_subject','intent_id','version','status','created_at_ms','revoked_at_ms','revoked_by_staff_id'],
  staff_login_binding_audit: ['id','staff_id','intent_id','binding_id','action','occurred_at_ms'],
}).map(([table, fields]) => [table, Object.freeze(fields)])));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ROWS = 20_000;
const MAX_AGE = 60_000;
const MAX_REVIEW_AGE = 15 * 60_000;
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
  && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const fail = code => { throw Error(`post0226_staff_preservation:${code}`); };
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const SUMMARY_KEYS = Object.freeze(['schemaVersion','contract','sourceCommit','accountId','databaseId','observedAt','baseSnapshotSha256',
  'baseTableCounts','loginSchemaSha256','loginRows','loginRowsSha256','bridgeMismatchCount','nativeControlEnabled',
  'legacyActiveStaffCount','preservationOnly','fullStaffCutoverReadiness','aliasLinkingAuthorized']);
const stateProjection = observation => Object.fromEntries(Object.entries(observation)
  .filter(([key]) => key !== 'schemaSha256' && key !== 'observedAt'));

const loginRowSql = Object.entries(POST0226_LOGIN_TABLES).map(([table, fields]) => {
  const projection = fields.map(x => `"${x}"`).join(',');
  const object = fields.map(x => `'${x}',q."${x}"`).join(',');
  return `'${table}',json((SELECT json_group_array(json_object(${object})) FROM (SELECT ${projection} FROM "${table}" ORDER BY ${projection} LIMIT ${MAX_ROWS + 1}) q))`;
}).join(',\n  ');
const POST0226_SCHEMA_QUERY = `, 'post0226Schema',json((SELECT json_group_array(json_object('type',type,'name',name,'sql',sql))
  FROM (SELECT type,name,sql FROM sqlite_master WHERE substr(name,1,12)='staff_login_' ORDER BY type,name))),
  'post0226Columns',json_object(${Object.entries(POST0226_LOGIN_TABLES).map(([t]) => `'${t}',json((SELECT json_group_array(name) FROM (SELECT name FROM pragma_table_info('${t}') ORDER BY cid)))`).join(',')}),
  'post0226Rows',json_object(${loginRowSql})`;
export const POST0226_STAFF_PRESERVATION_QUERY = ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY.replace(
  '\n) AS frontend_authority_snapshot', `${POST0226_SCHEMA_QUERY}\n) AS frontend_authority_snapshot`);
if (POST0226_STAFF_PRESERVATION_QUERY === ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY) fail('query_extension_failed');

async function expectedPost0226WireSchema() {
  const fixturePath = path.join(ROOT, 'scripts/fixtures/production-ops-0226-wrangler-wire-statements.json');
  const bytes = await readFile(fixturePath);
  if (hash(bytes.toString('utf8')) !== POST0226_WIRE_FIXTURE_SHA256) fail('wire_fixture_pin_mismatch');
  let fixture;
  try { fixture = JSON.parse(bytes.toString('utf8')); } catch { fail('wire_fixture_invalid'); }
  if (!exact(fixture, ['schemaVersion','sourceMigrationSha256','wranglerCliSha256','splitterOutputStatementCount',
    'setupStatements','statementCount','statementsSha256','expectedAddedSchemaSha256','expectedAddedObjectCount','statements'])
    || fixture.schemaVersion !== 1 || fixture.sourceMigrationSha256 !== POST0226_STAFF_LOGIN_MIGRATION_SHA256
    || fixture.wranglerCliSha256 !== 'a1a7a98e0b073d39dc3229b1b89f66accb51ae557fb34552250f914f12a81efd'
    || fixture.splitterOutputStatementCount !== 25 || canonicalStaffReadiness(fixture.setupStatements) !== canonicalStaffReadiness(['PRAGMA foreign_keys = ON'])
    || fixture.statementCount !== 24 || !Array.isArray(fixture.statements) || fixture.statements.length !== 24
    || fixture.statements.some(statement => typeof statement !== 'string' || statement.length === 0)
    || hash(JSON.stringify(fixture.statements)) !== POST0226_WIRE_STATEMENTS_SHA256
    || fixture.statementsSha256 !== POST0226_WIRE_STATEMENTS_SHA256
    || fixture.expectedAddedSchemaSha256 !== POST0226_WIRE_SCHEMA_SHA256 || fixture.expectedAddedObjectCount !== 23)
    fail('wire_fixture_invalid');

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,access_subject TEXT,status TEXT NOT NULL);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);
      CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT);`);
    for (const statement of fixture.statements) db.exec(statement);
    const full = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,12)='staff_login_' ORDER BY type,name").all();
    const digest = hash(JSON.stringify(full.map(row => [row.type,row.name,row.tbl_name,row.sql])));
    if (full.length !== fixture.expectedAddedObjectCount || digest !== POST0226_WIRE_SCHEMA_SHA256)
      fail('wire_fixture_schema_mismatch');
    return full.map(({ type, name, sql }) => ({ type, name, sql }));
  } catch (error) {
    if (error?.message?.startsWith('post0226_staff_preservation:')) throw error;
    fail('wire_fixture_schema_generation_failed');
  } finally { db.close(); }
}

/** Exact schema contract is pinned to the complete migration object inventory and
 * ordered columns. Unknown objects beneath the staff_login_ prefix fail closed. */
export async function validatePost0226Schema({ schema, columns, migrationPath = path.join(ROOT, 'apps/operations/migrations/0226_staff_login_bindings.sql') } = {}) {
  if (!Array.isArray(schema) || schema.length !== 23 || schema.some(row => !exact(row, ['type','name','sql'])
    || !['table','index','trigger'].includes(row.type) || typeof row.name !== 'string' || typeof row.sql !== 'string')) fail('schema_inventory_invalid');
  const migration = await readFile(migrationPath, 'utf8');
  if (hash(migration) !== POST0226_STAFF_LOGIN_MIGRATION_SHA256) fail('migration_pin_mismatch');
  const db = new DatabaseSync(':memory:');
  let expected;
  try {
    db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,access_subject TEXT,status TEXT NOT NULL);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);
      CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT);`);
    db.exec(migration);
    expected = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE substr(name,1,12)='staff_login_' ORDER BY type,name").all();
  } catch { fail('migration_schema_generation_failed'); }
  finally { db.close(); }
  const wireExpected = await expectedPost0226WireSchema();
  const objectTypes = new Map([
    ...Object.keys(POST0226_LOGIN_TABLES).map(n => [n,'table']),
    ['staff_login_bindings_active_email','index'], ['staff_login_bindings_active_subject','index'],
    ...['staff_login_intent_insert','staff_login_intent_update','staff_login_intent_no_delete','staff_login_binding_insert',
      'staff_login_binding_update','staff_login_binding_no_delete','staff_login_binding_linked','staff_login_binding_revoked',
      'staff_login_canonical_insert_collision','staff_login_canonical_update_collision','staff_login_generation_update',
      'staff_login_generation_no_delete','staff_login_audit_no_update','staff_login_audit_no_delete',
      'staff_login_control_no_update','staff_login_control_no_delete'].map(n => [n,'trigger']),
  ]);
  const actual = [...schema].sort((a,b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  if (actual.some(row => !objectTypes.has(row.name) || row.type !== objectTypes.get(row.name))
    || new Set(actual.map(r => r.name)).size !== objectTypes.size || objectTypes.size !== 23) fail('schema_inventory_unknown_or_incomplete');
  const actualCanonical = canonicalStaffReadiness(actual);
  if (actualCanonical !== canonicalStaffReadiness(expected)
    && actualCanonical !== canonicalStaffReadiness(wireExpected)) fail('schema_definition_mismatch');
  if (!exact(columns, Object.keys(POST0226_LOGIN_TABLES))) fail('schema_columns_invalid');
  for (const [table, expected] of Object.entries(POST0226_LOGIN_TABLES)) {
    const got = columns[table];
    if (!Array.isArray(got) || got.length !== expected.length || got.some((field,i) => field !== expected[i])) fail('schema_columns_mismatch');
  }
  return hash(canonicalStaffReadiness({ migrationSha256: POST0226_STAFF_LOGIN_MIGRATION_SHA256,
    schema: actual, columns }));
}

function baseSnapshotDigest(snapshot, sourceCommit, accountId, databaseId, observedAt, now) {
  if (!snapshot || !exact(snapshot, ['schemaSha256','bridgeMismatchCount','nativeStaffCohort','controlPlane','nativeControlCandidates','tables'])) fail('base_snapshot_invalid');
  const reviewAt = new Date(Math.min(Date.parse(observedAt), now)).toISOString();
  const baseReview = { schemaVersion: 1, contract: 'ordinary-frontend-preserve-native-staff-v1', application: 'operations', sourceCommit,
    accountId, databaseId, reviewedAt: reviewAt, expiresAt: new Date(Date.parse(reviewAt)+60_000).toISOString(),
    snapshotObservedAt: reviewAt, snapshotSha256: hash(canonicalStaffReadiness(snapshot)), snapshot };
  const baseObservation = { schemaVersion: 1, accountId, databaseId, observedAt: reviewAt, snapshot };
  validateOrdinaryFrontendAuthorityObservation(baseReview, baseObservation, { sourceCommit, now: Date.parse(reviewAt)+1 });
  return hash(canonicalStaffReadiness(snapshot));
}

function digestLoginRows(rows, staffRows) {
  if (!exact(rows, Object.keys(POST0226_LOGIN_TABLES))) fail('login_rows_invalid');
  const result = {};
  const knownStaff = new Set(staffRows.map(row => row.id));
  for (const [table, fields] of Object.entries(POST0226_LOGIN_TABLES)) {
    const list = rows[table];
    if (!Array.isArray(list) || list.length > MAX_ROWS || list.some(row => !exact(row, fields))) fail('login_rows_invalid');
    result[table] = { count: list.length, sha256: hash(canonicalStaffReadiness(list)) };
    if (table === 'staff_login_generations') for (const row of list) {
      if (typeof row.staff_id !== 'string' || !Number.isSafeInteger(row.generation) || row.generation < 0) fail('generation_row_invalid');
      if (!knownStaff.has(row.staff_id)) fail('generation_staff_unknown');
    }
    if (table === 'staff_login_binding_intents' && list.some(row => typeof row.token_sha256 !== 'string' || !SHA.test(row.token_sha256))) fail('intent_row_invalid');
  }
  const control = rows.staff_login_binding_control;
  if (control.length !== 1 || control[0].singleton !== 1 || control[0].schema_version !== 1) fail('login_control_invalid');
  const intents = new Map(rows.staff_login_binding_intents.map(row => [row.id, row]));
  const bindings = new Map(rows.staff_login_bindings.map(row => [row.id, row]));
  if (intents.size !== rows.staff_login_binding_intents.length || bindings.size !== rows.staff_login_bindings.length
    || rows.staff_login_binding_intents.some(r => (r.status === 'claimed' && !bindings.has(r.binding_id))
      || (r.status === 'pending' && rows.staff_login_bindings.some(b => b.intent_id === r.id)))
    || rows.staff_login_generations.some(r => !knownStaff.has(r.staff_id) || !Number.isSafeInteger(r.generation) || r.generation < 0)
    || rows.staff_login_binding_intents.some(r => typeof r.id !== 'string' || !knownStaff.has(r.staff_id)
      || typeof r.canonical_email !== 'string' || typeof r.canonical_subject !== 'string' || typeof r.issuer !== 'string'
      || typeof r.alternate_email !== 'string' || !Number.isSafeInteger(r.generation) || r.generation < 0
      || !Number.isSafeInteger(r.created_at_ms) || !Number.isSafeInteger(r.expires_at_ms)
      || !['pending','claimed'].includes(r.status) || (r.status === 'pending' ? r.binding_id !== null : typeof r.binding_id !== 'string'))
    || rows.staff_login_bindings.some(r => typeof r.id !== 'string' || !knownStaff.has(r.staff_id)
      || typeof r.issuer !== 'string' || typeof r.login_email !== 'string' || typeof r.access_subject !== 'string'
      || typeof r.intent_id !== 'string' || !intents.has(r.intent_id) || intents.get(r.intent_id).staff_id !== r.staff_id
      || !['active','revoked'].includes(r.status) || !Number.isSafeInteger(r.version)
      || (r.status === 'active' ? r.version !== 1 || r.revoked_at_ms !== null || r.revoked_by_staff_id !== null
        : r.version !== 2 || !Number.isSafeInteger(r.revoked_at_ms) || r.revoked_by_staff_id !== r.staff_id))
    || rows.staff_login_binding_audit.some(r => typeof r.id !== 'string' || !knownStaff.has(r.staff_id)
      || typeof r.intent_id !== 'string' || !intents.has(r.intent_id) || !['intent_created','linked','revoked'].includes(r.action)
      || !Number.isSafeInteger(r.occurred_at_ms))) fail('login_relations_invalid');
  return result;
}

function summarize(snapshot, loginRows, schemaSha256, identity) {
  const schemaDigest = schemaSha256;
  const baseSha256 = baseSnapshotDigest(snapshot, identity.sourceCommit, identity.accountId, identity.databaseId,
    identity.observedAt, identity.now);
  const loginDigests = digestLoginRows(loginRows, snapshot.tables.staff_users);
  const tableCounts = Object.fromEntries(Object.entries(snapshot.tables).map(([table, list]) => [table, list.length]));
  return { schemaVersion: 1, contract: POST0226_STAFF_PRESERVATION_CONTRACT, sourceCommit: identity.sourceCommit,
    accountId: identity.accountId, databaseId: identity.databaseId, observedAt: identity.observedAt,
    baseSnapshotSha256: baseSha256, baseTableCounts: tableCounts, loginSchemaSha256: schemaDigest,
    loginRows: loginDigests, loginRowsSha256: hash(canonicalStaffReadiness(loginDigests)),
    bridgeMismatchCount: snapshot.bridgeMismatchCount, nativeControlEnabled: 0,
    legacyActiveStaffCount: snapshot.tables.staff_users.filter(r => r.status === 'active').length,
    preservationOnly: true, fullStaffCutoverReadiness: false, aliasLinkingAuthorized: false };
}

export async function createPost0226StaffPreservationReview(observation, { sourceCommit, reviewedAt, expiresAt, now = Date.now() } = {}) {
  if (!COMMIT.test(sourceCommit ?? '') || observation?.sourceCommit !== sourceCommit || !stamp(reviewedAt) || !stamp(expiresAt)
    || Date.parse(reviewedAt) > now || Date.parse(expiresAt) <= Date.parse(reviewedAt)
    || Date.parse(expiresAt)-Date.parse(reviewedAt) > MAX_REVIEW_AGE) fail('review_parameters_invalid');
  const { schemaSha256, ...summary } = observation;
  if (!exact(summary, SUMMARY_KEYS) || observation.contract !== POST0226_STAFF_PRESERVATION_CONTRACT
    || observation.schemaVersion !== 1 || observation.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId
    || observation.databaseId !== NATIVE_STAFF_PRODUCTION_TARGET.databaseId || observation.schemaSha256 !== observation.loginSchemaSha256
    || !stamp(observation.observedAt) || Date.parse(observation.observedAt) > now
    || !SHA.test(schemaSha256 ?? '') || !SHA.test(observation.baseSnapshotSha256 ?? '')
    || !SHA.test(observation.loginRowsSha256 ?? '') || observation.nativeControlEnabled !== 0
    || observation.preservationOnly !== true || observation.fullStaffCutoverReadiness !== false
    || observation.aliasLinkingAuthorized !== false || !Number.isSafeInteger(observation.bridgeMismatchCount)
    || observation.bridgeMismatchCount < 0 || observation.bridgeMismatchCount > MAX_ROWS
    || !Number.isSafeInteger(observation.legacyActiveStaffCount) || observation.legacyActiveStaffCount < 1
    || !exact(observation.baseTableCounts, Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES))
    || Object.values(observation.baseTableCounts).some(n => !Number.isSafeInteger(n) || n < 0 || n > MAX_ROWS)
    || !exact(observation.loginRows, Object.keys(POST0226_LOGIN_TABLES))
    || Object.values(observation.loginRows).some(v => !exact(v, ['count','sha256']) || !Number.isSafeInteger(v.count)
      || v.count < 0 || v.count > MAX_ROWS || !SHA.test(v.sha256))) fail('observation_invalid');
  const reviewed = { schemaVersion: 1, contract: POST0226_STAFF_PRESERVATION_CONTRACT, sourceCommit,
    accountId: observation.accountId, databaseId: observation.databaseId, reviewedAt, expiresAt,
    observationObservedAt: observation.observedAt, observationSha256: hash(canonicalStaffReadiness(stateProjection(summary))),
    loginSchemaSha256: schemaSha256, baseSnapshotSha256: observation.baseSnapshotSha256,
    loginRowsSha256: observation.loginRowsSha256, bridgeMismatchCount: observation.bridgeMismatchCount,
    legacyActiveStaffCount: observation.legacyActiveStaffCount, baseTableCounts: observation.baseTableCounts };
  return reviewed;
}

export function validatePost0226StaffPreservationReview(review, observation, { sourceCommit, now = Date.now() } = {}) {
  const keys = ['schemaVersion','contract','sourceCommit','accountId','databaseId','reviewedAt','expiresAt','observationObservedAt',
    'observationSha256','loginSchemaSha256','baseSnapshotSha256','loginRowsSha256','bridgeMismatchCount','legacyActiveStaffCount','baseTableCounts'];
  if (!exact(review, keys) || review.schemaVersion !== 1 || review.contract !== POST0226_STAFF_PRESERVATION_CONTRACT
    || review.sourceCommit !== sourceCommit || !COMMIT.test(sourceCommit ?? '')
    || review.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId || review.databaseId !== NATIVE_STAFF_PRODUCTION_TARGET.databaseId
    || !stamp(review.reviewedAt) || !stamp(review.expiresAt) || !stamp(review.observationObservedAt)
    || Date.parse(review.reviewedAt) > now || Date.parse(review.observationObservedAt) > Date.parse(review.reviewedAt)
    || Date.parse(review.reviewedAt)-Date.parse(review.observationObservedAt) > MAX_AGE || Date.parse(review.expiresAt) <= now
    || Date.parse(review.expiresAt)-Date.parse(review.reviewedAt) > MAX_REVIEW_AGE) fail('review_invalid_or_stale');
  if (!observation || !exact(observation, [...SUMMARY_KEYS, 'schemaSha256']) || observation.schemaVersion !== 1
    || observation.contract !== POST0226_STAFF_PRESERVATION_CONTRACT
    || observation.sourceCommit !== sourceCommit || observation.accountId !== review.accountId || observation.databaseId !== review.databaseId
    || !stamp(observation.observedAt) || Date.parse(observation.observedAt) > now || now-Date.parse(observation.observedAt) > MAX_AGE
    || observation.baseSnapshotSha256 !== review.baseSnapshotSha256 || observation.loginSchemaSha256 !== review.loginSchemaSha256
    || observation.loginRowsSha256 !== review.loginRowsSha256 || observation.bridgeMismatchCount !== review.bridgeMismatchCount
    || observation.legacyActiveStaffCount !== review.legacyActiveStaffCount
    || canonicalStaffReadiness(observation.baseTableCounts) !== canonicalStaffReadiness(review.baseTableCounts)
    || hash(canonicalStaffReadiness(stateProjection(observation))) !== review.observationSha256)
    fail('reviewed_staff_login_or_authority_state_changed');
  return { schemaVersion: 1, contract: POST0226_STAFF_PRESERVATION_CONTRACT, sourceCommit, accountId: review.accountId,
    databaseId: review.databaseId, reviewSha256: hash(canonicalStaffReadiness(review)), observationSha256: review.observationSha256,
    observedAt: observation.observedAt, baseSnapshotSha256: observation.baseSnapshotSha256,
    loginSchemaSha256: observation.loginSchemaSha256, loginRowsSha256: observation.loginRowsSha256,
    loginBindingCounts: Object.fromEntries(Object.entries(observation.loginRows).map(([table,value]) => [table,value.count])),
    bridgeMismatchCount: observation.bridgeMismatchCount, nativeControlEnabled: 0, preservationOnly: true,
    fullStaffCutoverReadiness: false, aliasLinkingAuthorized: false };
}

export async function qualifyPost0226Snapshot(raw, { sourceCommit, observedAt, now = Date.now() } = {}) {
  if (!COMMIT.test(sourceCommit ?? '') || !stamp(observedAt) || Date.parse(observedAt) > now || now-Date.parse(observedAt) > MAX_AGE
    || !raw || !Array.isArray(raw.schema) || !raw.post0226Schema || !raw.post0226Columns || !raw.post0226Rows) fail('snapshot_invalid');
  const identity = { sourceCommit, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId, databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId,
    observedAt, now };
  const loginSchemaSha256 = await validatePost0226Schema({ schema: raw.post0226Schema, columns: raw.post0226Columns });
  const schema = raw.schema;
  const schemaColumns = raw.schemaColumns;
  if (!Array.isArray(schema) || !schemaColumns || typeof schemaColumns !== 'object') fail('base_schema_invalid');
  const snapshot = { schemaSha256: hash(canonicalStaffReadiness({ definitions: schema, columns: schemaColumns })),
    bridgeMismatchCount: raw.bridgeMismatchCount, nativeStaffCohort: raw.nativeStaffCohort,
    controlPlane: raw.controlPlane, nativeControlCandidates: raw.nativeControlCandidates,
    tables: Object.fromEntries(Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES).map(table => [table, raw[table]])) };
  const summary = summarize(snapshot, raw.post0226Rows, loginSchemaSha256, identity);
  return { ...summary, schemaSha256: loginSchemaSha256 };
}

