// Fixed-purpose Stage installer: adopt ONE existing Operations staff owner
// (staff-beau-koltz) into native identity: exactly one native_staff_admissions
// row and one native_staff_profiles row, with no grants, delegations,
// memberships or ACL changes.
//
// This module is deliberately separate from native-staff-bootstrap-d1.mjs.
// It does not widen v1/v2 bootstrap, cutover or production approval semantics,
// does not require control-plane membership, and is never reachable from a
// Worker route. It reuses the bootstrap installer's atomic mechanics (CAS
// SELECT guards that abort the batch, a NULL-gated insert into the immutable
// 0060 approvals table, approval-gated row inserts, a gated immutable receipt,
// one D1 batch, then a durable readback) and only the management-batch
// compiler is imported unchanged.
//
// It is NOT runnable today. It fails closed until all of these review inputs
// exist, none of which this module creates:
//   * a real owner-identity verifier (Access JWT signature, issuer, audience,
//     expiry) supplied by the operator as `verifyOwnerIdentity`;
//   * a real consent trust verifier over the closed consent envelope, backed
//     by a reviewed trust key, supplied as `verifyConsent`;
//   * Merger's readback that roles.manage is held as required (a precondition
//     owned by Merger, outside this module).
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileNativeStaffBootstrapManagementBatch } from './native-staff-bootstrap-d1.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = code => { throw new Error(`stage_owner_native_adoption_${code}`); };
const own = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value === null || typeof value !== 'object' ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const qid = value => {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) fail('schema_identifier_invalid');
  return `"${value}"`;
};
const sqlText = value => `'${String(value).replaceAll("'", "''")}'`;
const isHex64 = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const isIso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && new Date(value).toISOString() === value;

export const STAGE_OWNER_ADOPTION_PLAN_KIND = 'operations-stage-owner-native-adoption-v1';
export const STAGE_OWNER_ADOPTION_ACTION = 'adopt-existing-stage-owner-native-identity';
export const STAGE_OWNER_ADOPTION_PURPOSE = 'existing-owner-native-admission-and-profile-only';
export const STAGE_OWNER_ADOPTION_CONSENT_PHRASE =
  'I approve adopting my existing Stage Operations staff identity into one native admission and one native profile, with no grants';
export const STAGE_OWNER_ADOPTION_TARGET_STAFF_ID = 'staff-beau-koltz';
const ENVIRONMENT = 'staging';
const MAX_APPROVAL_LIFETIME_MS = 60 * 60 * 1000;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// Current main migration chain (not the stale 225-migration bootstrap pin).
// Any migration added, removed, renamed or edited changes these and refuses.
export const STAGE_OWNER_ADOPTION_MIGRATIONS = Object.freeze({
  count: 235,
  last: '0243_staff_logs_device_eligibility.sql',
  namesSha256: 'a34d43d7a2f94d4022a933c1fa427ce522f118dc79a39ee35b5a3e5c23e89937',
  contentsSha256: 'a7c4e5ae9d8f3f8e75659eff62a3e2c2f8a915dea3a08a799695cb690d476ae3',
});

// Stage-only target pins from Merger's independent, non-secret readback
// (2026-11-14). These are not production pins and grant nothing by themselves.
export const STAGE_PINS = Object.freeze({
  environment: ENVIRONMENT,
  accountId: 'df3f376bae6ee621f50cf972ebcc9484',
  databaseId: 'a58ea102-f04d-417a-bfd1-b0654cfeb503',
});

// Legacy ACL tables are guarded in full; native rows are guarded wherever they
// reference the target. staff_users.last_seen_at stays in the schema guard but
// is excluded from row state, matching the bootstrap installer's exemption.
const LEGACY_TABLES = Object.freeze(['staff_users', 'staff_divisions', 'permissions', 'roles', 'role_permissions',
  'staff_role_assignments', 'staff_permission_overrides', 'local_staff_role_assignments']);
const AUTHORITY_WIDE_TABLES = new Set(['native_business_areas', 'native_business_divisions', 'native_directory_resource_scopes',
  'native_staff_delegation_ceilings', 'native_staff_authority_capabilities', 'native_staff_access_reconciliation']);
const ID_COLUMNS = new Set(['staff_id', 'actor_staff_id', 'target_staff_id', 'granted_by', 'admitted_by', 'created_by',
  'approved_by_staff_id', 'operator_staff_id', 'approved_operator_staff_id', 'issued_by_staff_id', 'owner_staff_id',
  'beneficiary_staff_id', 'selected_by_staff_id', 'reviewed_by_staff_id', 'terminal_by_staff_id', 'created_by_staff_id']);
const INSERT_COLUMNS = Object.freeze({
  native_staff_admissions: Object.freeze(['staff_id', 'bound_access_subject', 'active', 'admitted_by']),
  native_staff_profiles: Object.freeze(['staff_id', 'login_email', 'display_name', 'version']),
});
const GUARD_CHUNK = 20;
const MISMATCH = "json('stage-owner-native-adoption-snapshot-mismatch')";
const PREPARED = new WeakSet();

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneCanonical(value, code) {
  let encoded;
  try { encoded = canonical(value); } catch { fail(code); }
  if (typeof encoded !== 'string') fail(code);
  const cloned = JSON.parse(encoded);
  if (canonical(cloned) !== encoded) fail(code);
  return cloned;
}

/** Refuse unless every Stage pin is a concrete, non-placeholder value. */
export function assertStageOwnerAdoptionPinsProvisioned(pins = STAGE_PINS) {
  if (!own(pins, ['environment', 'accountId', 'databaseId']) || pins.environment !== ENVIRONMENT
    || !/^[0-9a-f]{32}$/u.test(pins.accountId ?? '') || /^0+$/u.test(pins.accountId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(pins.databaseId ?? '')
    || pins.databaseId === ZERO_UUID) fail('stage_pins_unprovisioned');
  return pins;
}

function assertTarget(target, pins) {
  if (!own(target, ['accountId', 'databaseId']) || target.accountId !== pins.accountId
    || target.databaseId !== pins.databaseId) fail('target_database_mismatch');
}

function migrationDirectory() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/operations/migrations');
}

/** Exact current-main migration names and file contents, as pinned above. */
export function readStageOwnerAdoptionSourceMigrations(directory = migrationDirectory()) {
  const names = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
  const contentsSha256 = sha(names.map(name => {
    const file = path.join(directory, name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('source_migration_file_invalid');
    return `${name}\0${sha(readFileSync(file))}`;
  }).join('\n'));
  return { names, namesSha256: sha(names.join('\n')), contentsSha256 };
}

function verifySourceMigrations(ledger) {
  const source = readStageOwnerAdoptionSourceMigrations();
  const pin = STAGE_OWNER_ADOPTION_MIGRATIONS;
  if (source.names.length !== pin.count || source.names.at(-1) !== pin.last || source.namesSha256 !== pin.namesSha256
    || source.contentsSha256 !== pin.contentsSha256) fail('source_migration_chain_changed');
  if (!Array.isArray(ledger) || canonical(ledger) !== canonical(source.names)) fail('database_migration_ledger_mismatch');
  return source;
}

async function all(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  if (result?.success !== true || !Array.isArray(result.results)) fail('read_failed');
  return result.results;
}

async function schemaModel(db) {
  const tableRows = await all(db, `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'
    AND name NOT IN ('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY name`);
  const columnRows = await all(db, `SELECT s.name table_name,p.name column_name FROM sqlite_schema s
    JOIN pragma_table_info(s.name) p WHERE s.type='table' AND s.name NOT LIKE 'sqlite_%'
      AND s.name NOT IN ('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY s.name,p.cid`);
  const tables = new Map(tableRows.map(row => [row.name, columnRows.filter(c => c.table_name === row.name).map(c => c.column_name)]));
  for (const name of LEGACY_TABLES) if (!tables.has(name)) fail('legacy_schema_missing');
  for (const [table, columns] of Object.entries(INSERT_COLUMNS)) {
    if (!tables.has(table) || columns.some(column => !tables.get(table).includes(column))) fail('install_schema_mismatch');
  }
  for (const table of ['native_staff_bootstrap_approvals', 'native_staff_bootstrap_receipts']) {
    if (!tables.has(table)) fail('approval_schema_missing');
  }
  return tables;
}

function tableStateSql(table, columns) {
  const stateColumns = table === 'staff_users' ? columns.filter(column => column !== 'last_seen_at') : columns;
  let predicate = '';
  if (!LEGACY_TABLES.includes(table) && !AUTHORITY_WIDE_TABLES.has(table)) {
    const references = columns.filter(column => ID_COLUMNS.has(column) || /(?:staff|user)_id$/u.test(column));
    if (!references.length) return null;
    predicate = ` WHERE ${references.map(column => `${qid(column)} IN (SELECT value FROM selected_ids)`).join(' OR ')}`;
  }
  const selected = stateColumns.map(column => `${sqlText(column)},${qid(column)}`).join(',');
  const from = `SELECT ${stateColumns.map(qid).join(',')} FROM ${qid(table)}${predicate} ORDER BY ${stateColumns.map(qid).join(',')}`;
  return `json((SELECT json_group_array(json_object(${selected})) FROM (${from})))`;
}

const SCHEMA_FILTER = `name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA') AND type IN ('table','view','index','trigger')`;

/** Read-only queries whose JSON text values form the reviewed state. */
function stateQueries(tables, targetStaffId, schemaCount) {
  const ids = JSON.stringify([targetStaffId]);
  const queries = [
    { key: 'ledger', sql: `SELECT json((SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY name))) AS value`, params: [] },
    { key: 'schema_count', sql: `SELECT json_array(count(*)) AS value FROM sqlite_schema WHERE ${SCHEMA_FILTER}`, params: [] },
  ];
  for (let offset = 0; offset < schemaCount; offset += GUARD_CHUNK) {
    queries.push({ key: `schema:${offset / GUARD_CHUNK}`, sql: `SELECT json((SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql))
      FROM (SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE ${SCHEMA_FILTER} ORDER BY type,name LIMIT ${GUARD_CHUNK} OFFSET ${offset}))) AS value`, params: [] });
  }
  const names = [...tables.keys()].sort().filter(name => tableStateSql(name, tables.get(name)));
  for (let offset = 0; offset < names.length; offset += GUARD_CHUNK) {
    const chunk = names.slice(offset, offset + GUARD_CHUNK);
    const object = `json_object(${chunk.map(name => `${JSON.stringify(name)},${tableStateSql(name, tables.get(name))}`).join(',')})`;
    queries.push({ key: `rows:${offset / GUARD_CHUNK}`,
      sql: `WITH selected_ids(value) AS (SELECT value FROM json_each(?)) SELECT ${object} AS value`, params: [ids] });
  }
  return queries;
}

function guardStatements(queries, expected, { failClosed }) {
  return queries.map(query => ({ key: query.key,
    sql: `SELECT CASE WHEN (${query.sql.replace(/ AS value$/u, '')})=? THEN 1 ELSE ${failClosed ? MISMATCH : '0'} END AS verified`,
    params: [...query.params, expected[query.key]] }));
}

/** Read and fingerprint the exact current Stage state for the fixed target. */
export async function readStageOwnerAdoptionSnapshot(db, target, { pins = STAGE_PINS } = {}) {
  assertStageOwnerAdoptionPinsProvisioned(pins);
  assertTarget(target, pins);
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') fail('database_invalid');
  const tables = await schemaModel(db);
  const schemaCount = (await all(db, `SELECT count(*) AS n FROM sqlite_schema WHERE ${SCHEMA_FILTER}`))[0]?.n;
  if (!Number.isSafeInteger(schemaCount) || schemaCount < 1) fail('schema_invalid');
  const queries = stateQueries(tables, STAGE_OWNER_ADOPTION_TARGET_STAFF_ID, schemaCount);
  const results = await db.batch(queries.map(query => db.prepare(query.sql).bind(...query.params)));
  if (!Array.isArray(results) || results.length !== queries.length
    || results.some(result => result?.success !== true || typeof result.results?.[0]?.value !== 'string')) fail('snapshot_invalid');
  const state = Object.fromEntries(queries.map((query, index) => [query.key, results[index].results[0].value]));
  const ledger = JSON.parse(state.ledger);
  const source = verifySourceMigrations(ledger);
  const schemaJson = queries.filter(query => query.key.startsWith('schema:')).map(query => state[query.key]).join('\n');
  const owner = await db.prepare(`SELECT id,email,display_name,access_subject,status FROM staff_users WHERE id=?`)
    .bind(STAGE_OWNER_ADOPTION_TARGET_STAFF_ID).first();
  if (!owner || owner.status !== 'active' || typeof owner.access_subject !== 'string' || !owner.access_subject
    || typeof owner.email !== 'string' || typeof owner.display_name !== 'string') fail('target_staff_not_adoptable');
  const conflicts = await db.prepare(`SELECT
      (SELECT count(*) FROM native_staff_admissions WHERE staff_id=?1 OR bound_access_subject=?2) AS admissions,
      (SELECT count(*) FROM native_staff_profiles WHERE staff_id=?1 OR login_email=lower(?3)) AS profiles`)
    .bind(owner.id, owner.access_subject, owner.email).first();
  if (conflicts?.admissions !== 0 || conflicts?.profiles !== 0) fail('target_already_native_or_identity_taken');
  const snapshot = { schemaVersion: 1, environment: ENVIRONMENT, accountId: pins.accountId, databaseId: pins.databaseId,
    targetStaffId: owner.id, migrationNamesSha256: source.namesSha256, migrationContentsSha256: source.contentsSha256,
    schemaSha256: sha(schemaJson), state,
    owner: { staffId: owner.id, email: owner.email, displayName: owner.display_name, accessSubject: owner.access_subject } };
  const snapshotJson = canonical(snapshot);
  return deepFreeze({ snapshotJson, snapshotSha256: sha(snapshotJson), ...cloneCanonical(snapshot, 'snapshot_invalid') });
}

/** The only plan this module accepts: two identity rows for the fixed target, no grants. */
export function buildStageOwnerAdoptionPlan(snapshot, { approvalId, commandId }) {
  if (!snapshot || sha(snapshot.snapshotJson ?? '') !== snapshot.snapshotSha256) fail('snapshot_invalid');
  const reviewed = JSON.parse(snapshot.snapshotJson), owner = reviewed.owner;
  return canonical({ kind: STAGE_OWNER_ADOPTION_PLAN_KIND, purpose: STAGE_OWNER_ADOPTION_PURPOSE, environment: reviewed.environment,
    accountId: reviewed.accountId, databaseId: reviewed.databaseId, targetStaffId: owner.staffId,
    migrationNamesSha256: reviewed.migrationNamesSha256, migrationContentsSha256: reviewed.migrationContentsSha256,
    schemaSha256: reviewed.schemaSha256, reviewedSnapshotSha256: snapshot.snapshotSha256, approvalId, commandId, grants: [],
    rows: [
      { table: 'native_staff_admissions', row: { staff_id: owner.staffId, bound_access_subject: owner.accessSubject, active: 1, admitted_by: owner.staffId } },
      { table: 'native_staff_profiles', row: { staff_id: owner.staffId, login_email: owner.email.toLowerCase(), display_name: owner.displayName, version: 1 } },
    ] });
}

function verifyPlan(plan, canonicalPlanJson, snapshot, pins, approval, commandId) {
  const expected = buildStageOwnerAdoptionPlan(snapshot, { approvalId: approval.approvalId, commandId });
  if (canonicalPlanJson !== expected || canonical(plan) !== expected) fail('plan_not_fixed_purpose');
  const reviewed = JSON.parse(snapshot.snapshotJson);
  if (reviewed.accountId !== pins.accountId || reviewed.databaseId !== pins.databaseId || reviewed.environment !== ENVIRONMENT
    || reviewed.targetStaffId !== STAGE_OWNER_ADOPTION_TARGET_STAFF_ID
    || reviewed.migrationNamesSha256 !== STAGE_OWNER_ADOPTION_MIGRATIONS.namesSha256
    || reviewed.migrationContentsSha256 !== STAGE_OWNER_ADOPTION_MIGRATIONS.contentsSha256) fail('plan_binding_invalid');
  if (plan.rows.length !== 2 || plan.grants.length !== 0) fail('plan_not_fixed_purpose');
}

const CONSENT_KEYS = Object.freeze(['schemaVersion', 'action', 'purpose', 'environment', 'accountId', 'databaseId', 'targetStaffId',
  'ownerEmail', 'ownerAccessSubject', 'migrationNamesSha256', 'migrationContentsSha256', 'schemaSha256', 'reviewedSnapshotSha256',
  'canonicalPlanSha256', 'approvalId', 'commandId', 'issuedAt', 'expiresAt', 'consentPhrase']);

/** The closed envelope an owner consents to; a trust verifier signs/verifies exactly this. */
export function stageOwnerAdoptionConsentEnvelope({ snapshot, canonicalPlanJson, approval, commandId }) {
  const reviewed = JSON.parse(snapshot.snapshotJson);
  return { schemaVersion: 1, action: STAGE_OWNER_ADOPTION_ACTION, purpose: STAGE_OWNER_ADOPTION_PURPOSE, environment: reviewed.environment,
    accountId: reviewed.accountId, databaseId: reviewed.databaseId, targetStaffId: reviewed.owner.staffId,
    ownerEmail: reviewed.owner.email.toLowerCase(), ownerAccessSubject: reviewed.owner.accessSubject,
    migrationNamesSha256: reviewed.migrationNamesSha256, migrationContentsSha256: reviewed.migrationContentsSha256,
    schemaSha256: reviewed.schemaSha256, reviewedSnapshotSha256: snapshot.snapshotSha256, canonicalPlanSha256: sha(canonicalPlanJson),
    approvalId: approval.approvalId, commandId, issuedAt: approval.issuedAt, expiresAt: approval.expiresAt,
    consentPhrase: STAGE_OWNER_ADOPTION_CONSENT_PHRASE };
}

function verifyWindow(approval, now) {
  const issued = Date.parse(approval.issuedAt), expires = Date.parse(approval.expiresAt), at = now();
  if (!isIso(approval.issuedAt) || !isIso(approval.expiresAt) || !(expires > issued) || expires - issued > MAX_APPROVAL_LIFETIME_MS
    || !Number.isFinite(at)) fail('approval_window_invalid');
  if (at < issued || at >= expires) fail('approval_expired_or_not_yet_valid');
}

async function verifyIdentityAndConsent(input, snapshot, ownerIdentityToken, { verifyOwnerIdentity, verifyConsent }) {
  const reviewed = JSON.parse(snapshot.snapshotJson);
  if (typeof ownerIdentityToken !== 'string' || !ownerIdentityToken) fail('owner_identity_token_required');
  let claims;
  try { claims = await verifyOwnerIdentity(ownerIdentityToken); } catch { fail('owner_identity_unverified'); }
  if (!own(claims, ['staffId', 'email', 'accessSubject']) || claims.staffId !== reviewed.owner.staffId
    || typeof claims.email !== 'string' || claims.email.toLowerCase() !== reviewed.owner.email.toLowerCase()
    || claims.accessSubject !== reviewed.owner.accessSubject) fail('owner_identity_mismatch');
  const envelope = stageOwnerAdoptionConsentEnvelope({ snapshot, canonicalPlanJson: input.canonicalPlanJson,
    approval: input.approval, commandId: input.commandId });
  if (!own(input.consent?.envelope, CONSENT_KEYS) || canonical(input.consent.envelope) !== canonical(envelope)) fail('consent_envelope_mismatch');
  let trusted = false;
  try { trusted = await verifyConsent({ envelope, envelopeSha256: sha(canonical(envelope)), proof: input.consent.proof }); }
  catch { trusted = false; }
  if (trusted !== true) fail('consent_untrusted');
  return envelope;
}

function bindingEvidence(snapshot, envelope) {
  const reviewed = JSON.parse(snapshot.snapshotJson);
  // Never store the identity token or consent proof; bind their verified outcome.
  return canonical({ kind: 'stage-owner-live-identity-and-consent-v1', staffId: reviewed.owner.staffId,
    email: reviewed.owner.email.toLowerCase(), accessSubject: reviewed.owner.accessSubject,
    consentEnvelopeSha256: sha(canonical(envelope)) });
}

/** Validate a reviewed adoption request. Refuses without real, injected verifiers. */
export async function prepareStageOwnerAdoption(input, { pins = STAGE_PINS, verifyOwnerIdentity, verifyConsent, now = Date.now } = {}) {
  assertStageOwnerAdoptionPinsProvisioned(pins);
  if (typeof verifyOwnerIdentity !== 'function') fail('owner_identity_verifier_unprovisioned');
  if (typeof verifyConsent !== 'function') fail('consent_verifier_unprovisioned');
  if (!own(input, ['target', 'reviewedSnapshot', 'canonicalPlanJson', 'approval', 'commandId', 'ownerIdentityToken', 'consent'])
    || !own(input.approval, ['approvalId', 'issuedAt', 'expiresAt']) || !own(input.consent, ['envelope', 'proof'])
    || typeof input.canonicalPlanJson !== 'string' || typeof input.ownerIdentityToken !== 'string' || !input.ownerIdentityToken
    || typeof input.reviewedSnapshot?.snapshotJson !== 'string') fail('input_invalid');
  assertTarget(input.target, pins);
  const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
  if (!ID.test(input.approval.approvalId) || !ID.test(input.commandId) || input.approval.approvalId === input.commandId) fail('identifier_invalid');
  const snapshot = { snapshotJson: input.reviewedSnapshot.snapshotJson, snapshotSha256: input.reviewedSnapshot.snapshotSha256 };
  if (!isHex64(snapshot.snapshotSha256) || sha(snapshot.snapshotJson) !== snapshot.snapshotSha256) fail('snapshot_integrity_mismatch');
  let plan; try { plan = JSON.parse(input.canonicalPlanJson); } catch { fail('plan_json_invalid'); }
  verifyPlan(plan, input.canonicalPlanJson, snapshot, pins, input.approval, input.commandId);
  verifyWindow(input.approval, now);
  const envelope = await verifyIdentityAndConsent(input, snapshot, input.ownerIdentityToken, { verifyOwnerIdentity, verifyConsent });
  const bindingEvidenceJson = bindingEvidence(snapshot, envelope);
  const prepared = deepFreeze({ target: { ...input.target }, pins: { ...pins }, reviewedSnapshot: snapshot,
    canonicalPlanJson: input.canonicalPlanJson, planSha256: sha(input.canonicalPlanJson), plan: cloneCanonical(plan, 'plan_json_invalid'),
    approval: { ...input.approval }, commandId: input.commandId,
    consent: cloneCanonical(input.consent, 'input_invalid'), bindingEvidenceJson, bindingSha256: sha(bindingEvidenceJson) });
  PREPARED.add(prepared);
  return prepared;
}

function receiptResult(prepared) {
  const resultJson = canonical({ schemaVersion: 1, kind: STAGE_OWNER_ADOPTION_PLAN_KIND, approvalId: prepared.approval.approvalId,
    commandId: prepared.commandId, targetStaffId: STAGE_OWNER_ADOPTION_TARGET_STAFF_ID, canonicalPlanSha256: prepared.planSha256,
    bindingEvidenceSha256: prepared.bindingSha256, insertedRowCount: 2, grantCount: 0 });
  return { resultJson, resultSha256: sha(resultJson) };
}

function writeStatements(prepared) {
  const owner = JSON.parse(prepared.reviewedSnapshot.snapshotJson).owner, a = prepared.approval;
  // NULL approval_id (NOT NULL) aborts and rolls back the whole batch when the
  // window is closed or the approval/command identifiers were ever used.
  const approval = { sql: `INSERT INTO native_staff_bootstrap_approvals(approval_id,canonical_plan_json,canonical_plan_sha256,
    approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,
    issued_by_staff_id,issued_by_access_subject,issued_at,expires_at,revoked_at)
    SELECT CASE WHEN julianday(?)<=julianday('now') AND julianday(?)>julianday('now')
      AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=? OR approval_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=? OR command_id=? OR approval_id=?)
      THEN ? ELSE NULL END,?,?,?,?,?,?,?,?,?,?,NULL`,
  params: [a.issuedAt, a.expiresAt, a.approvalId, prepared.commandId, prepared.commandId, a.approvalId, a.approvalId, a.approvalId,
    prepared.canonicalPlanJson, prepared.planSha256, owner.staffId, owner.accessSubject, prepared.bindingEvidenceJson,
    prepared.bindingSha256, owner.staffId, owner.accessSubject, a.issuedAt, a.expiresAt] };
  const rows = prepared.plan.rows.map(item => {
    const columns = INSERT_COLUMNS[item.table];
    return { sql: `INSERT INTO ${qid(item.table)}(${columns.map(qid).join(',')}) SELECT ${columns.map(() => '?').join(',')}
      WHERE EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=? AND canonical_plan_sha256=? AND revoked_at IS NULL)`,
    params: [...columns.map(column => item.row[column]), a.approvalId, prepared.planSha256] };
  });
  const { resultJson, resultSha256 } = receiptResult(prepared);
  // The receipt is NULL-gated on both identity rows having landed exactly.
  const receipt = { sql: `INSERT INTO native_staff_bootstrap_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,
    canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256)
    SELECT CASE WHEN EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=? AND revoked_at IS NULL)
      AND (SELECT count(*) FROM native_staff_admissions WHERE staff_id=? AND bound_access_subject=? AND active=1 AND admitted_by=?)=1
      AND (SELECT count(*) FROM native_staff_profiles WHERE staff_id=? AND login_email=? AND display_name=? AND version=1)=1
      THEN ? ELSE NULL END,?,?,?,?,?,?,?,?,?`,
  params: [a.approvalId, owner.staffId, owner.accessSubject, owner.staffId, owner.staffId, owner.email.toLowerCase(), owner.displayName,
    prepared.commandId, a.approvalId, owner.staffId, owner.accessSubject, prepared.canonicalPlanJson, prepared.planSha256,
    prepared.bindingEvidenceJson, prepared.bindingSha256, resultJson, resultSha256] };
  return [approval, ...rows, receipt];
}

async function confirmDurable(db, prepared) {
  const owner = JSON.parse(prepared.reviewedSnapshot.snapshotJson).owner;
  const approval = await db.prepare(`SELECT canonical_plan_sha256,approved_operator_staff_id,issued_by_staff_id,
    independent_binding_verification_sha256,revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?`).bind(prepared.approval.approvalId).first();
  const receipt = await db.prepare(`SELECT approval_id,canonical_plan_sha256,result_json,result_sha256
    FROM native_staff_bootstrap_receipts WHERE command_id=?`).bind(prepared.commandId).first();
  const admission = await db.prepare(`SELECT staff_id,bound_access_subject,active,admitted_by FROM native_staff_admissions WHERE staff_id=?`).bind(owner.staffId).first();
  const profile = await db.prepare(`SELECT staff_id,login_email,display_name,version FROM native_staff_profiles WHERE staff_id=?`).bind(owner.staffId).first();
  const expected = receiptResult(prepared);
  return approval?.canonical_plan_sha256 === prepared.planSha256 && approval.approved_operator_staff_id === owner.staffId
    && approval.issued_by_staff_id === owner.staffId && approval.independent_binding_verification_sha256 === prepared.bindingSha256
    && approval.revoked_at === null && receipt?.approval_id === prepared.approval.approvalId
    && receipt.canonical_plan_sha256 === prepared.planSha256 && receipt.result_json === expected.resultJson
    && receipt.result_sha256 === expected.resultSha256
    && canonical({ ...admission }) === canonical(prepared.plan.rows[0].row) && canonical({ ...profile }) === canonical(prepared.plan.rows[1].row);
}

/** Execute exactly one atomic batch on the pinned Stage database. */
export async function executeStageOwnerAdoption(db, prepared, { ownerIdentityToken, verifyOwnerIdentity, verifyConsent, submitBatch, now = Date.now } = {}) {
  if (!PREPARED.has(prepared)) fail('prepared_artifact_invalid');
  assertStageOwnerAdoptionPinsProvisioned(prepared.pins);
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || typeof submitBatch !== 'function') fail('d1_target_required');
  if (typeof verifyOwnerIdentity !== 'function' || typeof verifyConsent !== 'function') fail('verifiers_required');
  verifyWindow(prepared.approval, now);
  // A fresh live identity token is required at execution; the prepared
  // artifact never retains one. Consent is re-verified too (revocation).
  await verifyIdentityAndConsent(prepared, prepared.reviewedSnapshot, ownerIdentityToken, { verifyOwnerIdentity, verifyConsent });
  const reviewed = JSON.parse(prepared.reviewedSnapshot.snapshotJson);
  const tables = await schemaModel(db);
  const queries = stateQueries(tables, STAGE_OWNER_ADOPTION_TARGET_STAFF_ID, JSON.parse(reviewed.state.schema_count)[0]);
  if (queries.some(query => typeof reviewed.state[query.key] !== 'string')
    || Object.keys(reviewed.state).length !== queries.length) fail('snapshot_changed_shape');
  const probe = guardStatements(queries, reviewed.state, { failClosed: false });
  const probeResults = await db.batch(probe.map(statement => db.prepare(statement.sql).bind(...statement.params)));
  const mismatch = probeResults.findIndex(row => row?.success !== true || row.results?.[0]?.verified !== 1);
  if (mismatch >= 0) fail(`snapshot_changed_${probe[mismatch].key}`);
  const guards = guardStatements(queries, reviewed.state, { failClosed: true });
  const batch = [...guards, ...writeStatements(prepared)];
  const request = compileNativeStaffBootstrapManagementBatch(batch.map(({ sql, params }) => ({ sql, params })));
  let result;
  try { result = await submitBatch(request, { accountId: prepared.target.accountId, databaseId: prepared.target.databaseId }); }
  catch (error) { throw new Error('stage_owner_native_adoption_atomic_batch_refused', { cause: error }); }
  if (!Array.isArray(result) || result.length !== batch.length || result.some(row => row?.success !== true)
    || result.slice(0, guards.length).some(row => row.results?.[0]?.verified !== 1)) fail('atomic_batch_not_committed');
  if (!await confirmDurable(db, prepared)) fail('commit_outcome_uncertain');
  return Object.freeze({ schemaVersion: 1, kind: STAGE_OWNER_ADOPTION_PLAN_KIND, approvalId: prepared.approval.approvalId,
    commandId: prepared.commandId, targetStaffId: STAGE_OWNER_ADOPTION_TARGET_STAFF_ID, canonicalPlanSha256: prepared.planSha256,
    insertedRowCount: 2, grantCount: 0 });
}
