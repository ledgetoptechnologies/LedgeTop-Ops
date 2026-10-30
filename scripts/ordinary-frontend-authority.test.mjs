import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalStaffReadiness, NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_CONTRACT, validateOrdinaryFrontendAuthorityObservation } from './ordinary-frontend-authority.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_TABLES, ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY,
  readOrdinaryFrontendAuthorityObservation, validateOrdinaryFrontendAuthoritySchemaColumns,
  assertPre226StaffLoginSchema } from './ordinary-frontend-authority-reader.mjs';

const SOURCE = 'a'.repeat(40);
const NOW = Date.parse('2026-10-30T18:00:00.000Z');
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

function fixture() {
  const tables = Object.fromEntries(Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES).map(name => [name, []]));
  tables.staff_users = [
    { id: 'staff:legacy-unbound', email: 'owner@example.test', display_name: 'Owner', access_subject: null, status: 'active' },
    { id: 'staff:native-bound', email: 'staff@example.test', display_name: 'Staff', access_subject: 'access|staff-1', status: 'active' },
    { id: 'staff:inactive-history', email: 'former@example.test', display_name: 'Former Staff', access_subject: 'access|former', status: 'inactive' },
  ];
  tables.staff_role_assignments = [{ id: 'assignment:owner', staff_id: 'staff:legacy-unbound', role_id: 'role-owner',
    scope: 'global', division_id: null, scope_key: 'global', created_by: 'staff:legacy-unbound', created_at: '2026-10-01 00:00:00' }];
  tables.roles = [{ id: 'role-owner', name: 'Owner', description: 'Synthetic role', immutable: 1,
    created_at: '2026-09-01 00:00:00', updated_at: '2026-09-01 00:00:00' }];
  tables.permissions = [{ key: 'operations.read', description: 'Synthetic permission' }];
  tables.role_permissions = [{ role_id: 'role-owner', permission_key: 'operations.read' }];
  tables.native_staff_admissions = [{ staff_id: 'staff:native-bound', bound_access_subject: 'access|staff-1', active: 1,
    admitted_by: 'staff:legacy-unbound', version: 1, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }];
  tables.native_staff_profiles = [{ staff_id: 'staff:native-bound', login_email: 'staff@example.test', display_name: 'Staff',
    version: 1, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }];
  tables.native_staff_access_reconciliation = [{ singleton: 1, enabled: 0, generation: 0, applied_generation: 0,
    lease_id: null, lease_until: null, attempt_generation: null, attempts: 0, last_attempt_at: null,
    last_success_at: null, last_error: null }];
  const snapshot = { schemaSha256: 'b'.repeat(64), bridgeMismatchCount: 1,
    nativeStaffCohort: [
      { staffId: 'staff:legacy-unbound', email: 'owner@example.test', accessSubject: null, displayName: 'Owner',
        legacyStatus: 'active', bridgeStatus: 'not_admitted', nativeActive: null, admissionVersion: null, profileVersion: null },
      { staffId: 'staff:native-bound', email: 'staff@example.test', accessSubject: 'access|staff-1', displayName: 'Staff',
        legacyStatus: 'active', bridgeStatus: 'matched', nativeActive: 1, admissionVersion: 1, profileVersion: 1 },
    ],
    controlPlane: [], nativeControlCandidates: [], tables };
  const review = { schemaVersion: 1, contract: ORDINARY_FRONTEND_AUTHORITY_CONTRACT, application: 'operations',
    sourceCommit: SOURCE, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId,
    reviewedAt: '2026-10-30T17:59:30.000Z', expiresAt: '2026-10-30T18:15:00.000Z',
    snapshotObservedAt: '2026-10-30T17:59:00.000Z', snapshotSha256: hash(canonicalStaffReadiness(snapshot)), snapshot };
  const observation = { schemaVersion: 1, accountId: review.accountId, databaseId: review.databaseId,
    observedAt: '2026-10-30T17:59:45.000Z', snapshot: clone(snapshot) };
  return { review, observation, snapshot };
}

test('frontend-only contract preserves the reviewed mixed bridge/native cohort and disabled master control', () => {
  const { review, observation } = fixture();
  const receipt = validateOrdinaryFrontendAuthorityObservation(review, observation, { sourceCommit: SOURCE, now: NOW });
  assert.equal(receipt.contract, ORDINARY_FRONTEND_AUTHORITY_CONTRACT);
  assert.equal(receipt.controlEnabled, 0);
  assert.equal(receipt.legacyActiveStaffCount, 2);
  assert.equal(receipt.nativeStaffActiveCount, 1);
  assert.equal(receipt.controlPlaneCount, 0);
  assert.equal(receipt.bridgeMismatchCount, 1);
  assert.equal(JSON.stringify(receipt).includes('owner@example.test'), false);
  assert.equal(JSON.stringify(receipt).includes('access|staff-1'), false);
});

test('frontend-only contract refuses enabled or pending native control even if a packet hashes that state', () => {
  for (const change of [
    row => { row.enabled = 1; },
    row => { row.generation = 1; },
    row => { row.lease_id = 'lease:active'; },
    row => { row.last_error = 'failed'; },
  ]) {
    const { review, observation } = fixture();
    change(review.snapshot.tables.native_staff_access_reconciliation[0]);
    review.snapshotSha256 = hash(canonicalStaffReadiness(review.snapshot));
    observation.snapshot = clone(review.snapshot);
    assert.throws(() => validateOrdinaryFrontendAuthorityObservation(review, observation, { sourceCommit: SOURCE, now: NOW }),
      /disabled_control_baseline_required/u);
  }
});

test('fresh reads refuse changes to legacy roles, permissions, divisions, staff history, cohort or native bindings', () => {
  for (const mutate of [
    snapshot => { snapshot.tables.staff_role_assignments[0].role_id = 'role-admin'; },
    snapshot => { snapshot.tables.role_permissions[0].permission_key = 'operations.write'; },
    snapshot => { snapshot.tables.staff_users[2].status = 'active'; },
    snapshot => { snapshot.nativeStaffCohort[0].bridgeStatus = 'matched'; },
    snapshot => { snapshot.tables.native_staff_profiles[0].version += 1; },
    snapshot => { snapshot.bridgeMismatchCount = 0; },
  ]) {
    const { review, observation } = fixture(); mutate(observation.snapshot);
    assert.throws(() => validateOrdinaryFrontendAuthorityObservation(review, observation, { sourceCommit: SOURCE, now: NOW }),
      /reviewed_staff_or_control_state_changed/u);
  }
});

test('review packet purpose, source, identity and digest are pinned', () => {
  for (const change of [
    review => { review.contract = 'native-staff-cutover-v1'; },
    review => { review.application = 'client'; },
    review => { review.sourceCommit = 'c'.repeat(40); },
    review => { review.snapshotSha256 = '0'.repeat(64); },
  ]) {
    const { review, observation } = fixture(); change(review);
    assert.throws(() => validateOrdinaryFrontendAuthorityObservation(review, observation, { sourceCommit: SOURCE, now: NOW }));
  }
});

test('stale, expired, malformed, or identity-inconsistent observations fail closed', () => {
  const staleReview = fixture(); staleReview.review.expiresAt = '2026-10-30T17:59:59.000Z';
  assert.throws(() => validateOrdinaryFrontendAuthorityObservation(staleReview.review, staleReview.observation,
    { sourceCommit: SOURCE, now: NOW }), /review_expired_or_stale/u);
  const staleObservation = fixture(); staleObservation.observation.observedAt = '2026-10-30T17:58:59.000Z';
  assert.throws(() => validateOrdinaryFrontendAuthorityObservation(staleObservation.review, staleObservation.observation,
    { sourceCommit: SOURCE, now: NOW }), /observation_stale_or_invalid/u);
  const malformed = fixture(); malformed.observation.extra = true;
  assert.throws(() => validateOrdinaryFrontendAuthorityObservation(malformed.review, malformed.observation,
    { sourceCommit: SOURCE, now: NOW }), /observation_stale_or_invalid/u);
  const identity = fixture(); identity.observation.snapshot.nativeStaffCohort[0].staffId = 'staff:unknown';
  assert.throws(() => validateOrdinaryFrontendAuthorityObservation(identity.review, identity.observation,
    { sourceCommit: SOURCE, now: NOW }), /native_staff_cohort_invalid/u);
});

test('snapshot query is one finite SELECT and captures legacy permission and native control surfaces only', () => {
  assert.match(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY, /^SELECT json_object\(/u);
  assert.match(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY, /staff_role_assignments/u);
  assert.match(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY, /local_staff_role_assignments/u);
  assert.match(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY, /staff_permission_overrides/u);
  assert.match(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY, /native_staff_access_reconciliation/u);
  assert.doesNotMatch(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|PRAGMA)\b/iu);
  assert.doesNotMatch(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY, /project_alpha_user_id|clients|client_data/iu);
});

test('schema column inventory rejects a missing projected field before snapshot qualification', () => {
  const columns = Object.fromEntries(Object.entries(ORDINARY_FRONTEND_AUTHORITY_TABLES));
  columns.native_staff_control_plane_candidates = ['staff_id','bound_access_subject','admission_version','profile_version'];
  columns.native_staff_lifecycle_control_plane_candidates = ['staff_id','bound_access_subject','admission_version','profile_version'];
  validateOrdinaryFrontendAuthoritySchemaColumns(columns);
  columns.staff_users = columns.staff_users.filter(column => column !== 'access_subject');
  assert.throws(() => validateOrdinaryFrontendAuthoritySchemaColumns(columns), /schema_column_missing:staff_users/u);
});

test('post-0226 staff login objects refuse the fixed pre-0226 authority contract', () => {
  assert.doesNotThrow(() => assertPre226StaffLoginSchema([{ type: 'table', name: 'staff_users', sql: '...' }]));
  assert.throws(() => assertPre226StaffLoginSchema([{ type: 'table', name: 'staff_users', sql: '...' },
    { type: 'table', name: 'staff_login_binding_control', sql: '...' }]), /requires_pre0226_staff_login_schema/u);
});

test('generated authority query executes against a synthetic SQLite schema without changing data', () => {
  const database = new DatabaseSync(':memory:');
  const integerFields = new Set(['immutable','is_primary','active','singleton','enabled','generation','applied_generation',
    'attempt_generation','attempts','version','contract_version']);
  try {
    for (const [table, fields] of Object.entries(ORDINARY_FRONTEND_AUTHORITY_TABLES)) {
      const columns = fields.map(field => `"${field}" ${integerFields.has(field) ? 'INTEGER' : 'TEXT'}`).join(',');
      database.exec(`CREATE TABLE "${table}" (${columns})`);
    }
    database.exec(`CREATE VIEW native_staff_control_plane_candidates AS
      SELECT staff_id,bound_access_subject,version AS admission_version,version AS profile_version
      FROM native_staff_admissions WHERE active=1 AND 0`);
    database.exec(`CREATE VIEW native_staff_lifecycle_control_plane_candidates AS
      SELECT staff_id,bound_access_subject,admission_version,profile_version
      FROM native_staff_control_plane_candidates`);
    const insert = (table, row) => {
      const entries = Object.entries(row), fields = entries.map(([key]) => `"${key}"`).join(',');
      database.prepare(`INSERT INTO "${table}" (${fields}) VALUES (${entries.map(() => '?').join(',')})`).run(...entries.map(([,value]) => value));
    };
    insert('staff_users', { id: 'staff:legacy', email: 'legacy@example.test', display_name: 'Legacy', access_subject: null, status: 'active' });
    insert('staff_users', { id: 'staff:native', email: 'native@example.test', display_name: 'Native', access_subject: 'subject|native', status: 'active' });
    insert('staff_role_assignments', { id: 'assignment:legacy', staff_id: 'staff:legacy', role_id: 'role-owner', scope: 'global',
      division_id: null, scope_key: 'global', created_by: 'staff:legacy', created_at: '2026-10-01 00:00:00' });
    insert('native_staff_admissions', { staff_id: 'staff:native', bound_access_subject: 'subject|native', active: 1,
      admitted_by: 'staff:legacy', version: 1, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' });
    insert('native_staff_profiles', { staff_id: 'staff:native', login_email: 'native@example.test', display_name: 'Native',
      version: 1, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' });
    insert('native_staff_access_reconciliation', { singleton: 1, enabled: 0, generation: 0, applied_generation: 0,
      lease_id: null, lease_until: null, attempt_generation: null, attempts: 0, last_attempt_at: null,
      last_success_at: null, last_error: null });
    const before = database.prepare('SELECT COUNT(*) AS count FROM staff_users').get().count;
    const raw = JSON.parse(database.prepare(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY).get().frontend_authority_snapshot);
    const after = database.prepare('SELECT COUNT(*) AS count FROM staff_users').get().count;
    assert.equal(raw.bridgeMismatchCount, 1);
    assert.equal(raw.staff_users.length, 2);
    assert.equal(raw.nativeStaffCohort.find(row => row.staffId === 'staff:legacy').bridgeStatus, 'not_admitted');
    assert.equal(raw.controlPlane.length, 0);
    validateOrdinaryFrontendAuthoritySchemaColumns(raw.schemaColumns);
    assertPre226StaffLoginSchema(raw.schema);
    database.exec(`CREATE TABLE staff_login_binding_control (singleton INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL);
      CREATE TABLE staff_login_generations (staff_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      CREATE TABLE staff_login_binding_intents (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE staff_login_bindings (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE staff_login_binding_audit (id TEXT PRIMARY KEY, action TEXT NOT NULL);
      CREATE UNIQUE INDEX staff_login_bindings_active_email ON staff_login_bindings(status);
      CREATE TRIGGER staff_login_control_no_delete BEFORE DELETE ON staff_login_binding_control
        BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    const after0226 = JSON.parse(database.prepare(ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY).get().frontend_authority_snapshot);
    assert.deepEqual(new Set(after0226.schema.filter(row => row.name.startsWith('staff_login_')).map(row => row.name)), new Set([
      'staff_login_binding_control','staff_login_generations','staff_login_binding_intents','staff_login_bindings',
      'staff_login_binding_audit','staff_login_bindings_active_email','staff_login_control_no_delete',
    ]));
    assert.throws(() => assertPre226StaffLoginSchema(after0226.schema), /requires_pre0226_staff_login_schema/u);
    assert.equal(before, after);
  } finally { database.close(); }
});

test('snapshot reader accepts only its bound read-only query and emits the canonical review shape', async () => {
  const { review, snapshot } = fixture();
  let selectedArgs;
  const started = NOW;
  const schemaColumns = { ...ORDINARY_FRONTEND_AUTHORITY_TABLES,
    native_staff_control_plane_candidates: ['staff_id','bound_access_subject','admission_version','profile_version'],
    native_staff_lifecycle_control_plane_candidates: ['staff_id','bound_access_subject','admission_version','profile_version'] };
  const schema = [{ type: 'table', name: 'staff_users', sql: 'CREATE TABLE staff_users(...)' }];
  const sqlSnapshot = { bridgeMismatchCount: snapshot.bridgeMismatchCount, nativeStaffCohort: snapshot.nativeStaffCohort,
    controlPlane: snapshot.controlPlane, nativeControlCandidates: snapshot.nativeControlCandidates,
    schema, schemaColumns,
    ...snapshot.tables };
  const observation = await readOrdinaryFrontendAuthorityObservation({ review, sourceCommit: SOURCE,
    now: () => started, read: async args => {
      selectedArgs = args;
      return [{ success: true, results: [{ frontend_authority_snapshot: JSON.stringify(sqlSnapshot) }] }];
    } });
  assert.equal(selectedArgs[0], 'd1');
  assert.equal(selectedArgs[1], 'execute');
  assert.equal(selectedArgs[4], '--config');
  assert.equal(selectedArgs[6], '--command');
  assert.equal(selectedArgs[7], ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY);
  assert.equal(observation.accountId, review.accountId);
  assert.equal(observation.snapshot.nativeStaffCohort.length, 2);
  assert.deepEqual(Object.keys(observation.snapshot.tables).sort(), Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES).sort());
  assert.equal(observation.snapshot.schemaSha256, hash(canonicalStaffReadiness({ definitions: schema, columns: schemaColumns })));
  const missingColumn = clone(sqlSnapshot);
  missingColumn.schemaColumns.staff_users = missingColumn.schemaColumns.staff_users.filter(column => column !== 'access_subject');
  await assert.rejects(readOrdinaryFrontendAuthorityObservation({ review, sourceCommit: SOURCE,
    now: () => started, read: async () => [{ success: true,
      results: [{ frontend_authority_snapshot: JSON.stringify(missingColumn) }] }] }), /schema_column_missing:staff_users/u);
});
