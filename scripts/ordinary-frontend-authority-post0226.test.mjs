import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { canonicalStaffReadiness, NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_TABLES } from './ordinary-frontend-authority-reader.mjs';
import { POST0226_LOGIN_TABLES, POST0226_STAFF_LOGIN_MIGRATION_SHA256, POST0226_STAFF_PRESERVATION_CONTRACT,
  POST0226_STAFF_PRESERVATION_QUERY, createPost0226StaffPreservationReview, qualifyPost0226Snapshot, validatePost0226Schema,
  validatePost0226StaffPreservationReview } from './ordinary-frontend-authority-post0226.mjs';
import { readPost0226StaffPreservationObservation } from './ordinary-frontend-authority-post0226-reader.mjs';
import { compileProductionAutoPost0226PreservationPolicy, loadPinnedProductionAutoPost0226PreservationPolicy,
  validateProductionAutoPost0226PreservationObservation, validateProductionAutoPost0226PreservationPolicy,
  validateProductionAutoPost0226PreservationReceipt,
  validateRepeatedProductionAutoPost0226PreservationReceipts,
  PRODUCTION_AUTO_POST0226_MAX_RECEIPTS,
  PRODUCTION_AUTO_POST0226_PRESERVATION_POLICY_SHA256 } from './production-auto-post0226-policy.mjs';
import { PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS, PRODUCTION_AUTO_FIXED_OPS_PRESERVATION_FENCES,
  PRODUCTION_AUTO_POSTBUILD_PRESERVATION_REFRESHES } from './production-auto-limits.mjs';

const sourceCommit = 'a'.repeat(40), observedAt = '2026-10-31T10:00:00.000Z', now = Date.parse('2026-10-31T10:01:00.000Z');
const sha = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
test('post-0226 receipt envelope includes bounded post-journal reads and one post-build refresh', () => {
  assert.equal(PRODUCTION_AUTO_POST0226_MAX_RECEIPTS, PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS
    + PRODUCTION_AUTO_FIXED_OPS_PRESERVATION_FENCES + PRODUCTION_AUTO_POSTBUILD_PRESERVATION_REFRESHES
    + PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS + 10);
  assert.equal(PRODUCTION_AUTO_POSTBUILD_PRESERVATION_REFRESHES, 1);
});

function schemaFixture({ wire = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,access_subject TEXT,status TEXT NOT NULL);
    CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
    CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);
    CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT);
    CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,version INTEGER NOT NULL,active INTEGER NOT NULL);`);
  const migration = requireMigration();
  if (wire) {
    const fixture = JSON.parse(readFileSync(new URL('../scripts/fixtures/production-ops-0226-wrangler-wire-statements.json', import.meta.url), 'utf8'));
    db.exec('PRAGMA foreign_keys=ON');
    for (const statement of fixture.statements) db.exec(statement);
  } else db.exec(migration);
  const schema = JSON.parse(JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE substr(name,1,12)='staff_login_' ORDER BY type,name").all()));
  const columns = Object.fromEntries(Object.entries(POST0226_LOGIN_TABLES).map(([table]) => [table,
    db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map(row => row.name)]));
  return { db, schema, columns };
}

let migrationText;
function requireMigration() {
  if (!migrationText) throw new Error('fixture_migration_not_loaded');
  return migrationText;
}

function rawFixture(schema, columns) {
  const tables = Object.fromEntries(Object.entries(ORDINARY_FRONTEND_AUTHORITY_TABLES).map(([name, fields]) => [name, []]));
  const user = { id: 'staff:synthetic-owner', email: 'owner@example.test', display_name: 'Synthetic Owner', access_subject: 'subject|owner', status: 'active' };
  tables.staff_users = [user];
  tables.staff_role_assignments = [{ id: 'assignment:owner', staff_id: user.id, role_id: 'role-owner', scope: 'global', division_id: null,
    scope_key: 'global', created_by: user.id, created_at: '2026-10-01 00:00:00' }];
  tables.roles = [{ id: 'role-owner', name: 'Owner', description: 'Synthetic', immutable: 1,
    created_at: '2026-10-01', updated_at: '2026-10-01' }];
  tables.native_staff_access_reconciliation = [{ singleton: 1, enabled: 0, generation: 0, applied_generation: 0, lease_id: null,
    lease_until: null, attempt_generation: null, attempts: 0, last_attempt_at: null, last_success_at: null, last_error: null }];
  const cohort = [{ staffId: user.id, email: user.email, accessSubject: user.access_subject, displayName: user.display_name,
    legacyStatus: 'active', bridgeStatus: 'not_admitted', nativeActive: null, admissionVersion: null, profileVersion: null }];
  const loginRows = Object.fromEntries(Object.keys(POST0226_LOGIN_TABLES).map(name => [name, []]));
  loginRows.staff_login_binding_control = [{ singleton: 1, schema_version: 1 }];
  loginRows.staff_login_generations = [{ staff_id: user.id, generation: 0 }];
  return { schema: [{ type:'table', name:'staff_users', sql:'CREATE TABLE staff_users(...)' }],
    schemaColumns: Object.fromEntries(Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES).map(name => [name, ORDINARY_FRONTEND_AUTHORITY_TABLES[name]])),
    bridgeMismatchCount: 1, nativeStaffCohort: cohort, controlPlane: [], nativeControlCandidates: [], ...tables,
    post0226Schema: schema, post0226Columns: columns, post0226Rows: loginRows };
}

test('migration pin and complete schema definition/inventory are exact', async () => {
  migrationText = await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  assert.equal(sha(migrationText), POST0226_STAFF_LOGIN_MIGRATION_SHA256);
  const fixture = schemaFixture();
  try {
    assert.match(await validatePost0226Schema(fixture), /^[a-f0-9]{64}$/u);
    await assert.rejects(validatePost0226Schema({ ...fixture, schema: fixture.schema.slice(1) }), /schema_inventory/u);
    await assert.rejects(validatePost0226Schema({ ...fixture, schema: [...fixture.schema,
      { type:'table', name:'staff_login_shadow', sql:'CREATE TABLE staff_login_shadow(x)' }] }), /schema_inventory/u);
    const altered = clone(fixture.schema); altered[0].sql += ' altered';
    await assert.rejects(validatePost0226Schema({ ...fixture, schema: altered }), /schema_definition_mismatch/u);
    const partial = clone(fixture.columns); partial.staff_login_bindings.pop();
    await assert.rejects(validatePost0226Schema({ ...fixture, columns: partial }), /schema_columns_mismatch/u);
  } finally { fixture.db.close(); }
});

test('accepts only the exact pinned guarded-Wrangler DDL reconstruction and rejects local SQL edits', async () => {
  migrationText ??= await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  const fixture = schemaFixture({ wire: true });
  try {
    assert.match(await validatePost0226Schema(fixture), /^[a-f0-9]{64}$/u);
    const semanticChange = clone(fixture.schema);
    const linked = semanticChange.find(row => row.name === 'staff_login_binding_linked');
    linked.sql = linked.sql.replace('generation=generation+1', 'generation=generation+2');
    await assert.rejects(validatePost0226Schema({ ...fixture, schema: semanticChange }), /schema_definition_mismatch/u);
    const arbitraryComment = clone(fixture.schema);
    arbitraryComment.find(row => row.name === 'staff_login_binding_linked').sql += ' /* additional comment */';
    await assert.rejects(validatePost0226Schema({ ...fixture, schema: arbitraryComment }), /schema_definition_mismatch/u);
  } finally { fixture.db.close(); }
});

test('short post-0226 review hashes complete state without returning personal or token data', async () => {
  migrationText ??= await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  const fixture = schemaFixture();
  try {
    const raw = rawFixture(fixture.schema, fixture.columns);
    const observation = await qualifyPost0226Snapshot(raw, { sourceCommit, observedAt, now });
    const review = await createPost0226StaffPreservationReview(observation, { sourceCommit,
      reviewedAt:'2026-10-31T10:00:30.000Z', expiresAt:'2026-10-31T10:10:00.000Z', now });
    const receipt = validatePost0226StaffPreservationReview(review, observation, { sourceCommit, now });
    assert.equal(receipt.contract, POST0226_STAFF_PRESERVATION_CONTRACT);
    assert.equal(receipt.nativeControlEnabled, 0);
    assert.equal(receipt.bridgeMismatchCount, 1);
    assert.equal(receipt.preservationOnly, true);
    assert.equal(receipt.fullStaffCutoverReadiness, false);
    assert.equal(receipt.aliasLinkingAuthorized, false);
    assert.equal(JSON.stringify(receipt).includes('owner@example.test'), false);
    assert.equal(JSON.stringify(receipt).includes('token_sha256'), false);
    assert.deepEqual(receipt.loginBindingCounts, Object.fromEntries(Object.keys(POST0226_LOGIN_TABLES).map(k => [k, k === 'staff_login_binding_control' || k === 'staff_login_generations' ? 1 : 0])));
    assert.equal(observation.accountId, NATIVE_STAFF_PRODUCTION_TARGET.accountId);
  } finally { fixture.db.close(); }
});

test('offline compiler and fixed recurring preservation policy pin qualified state and permit only source/time variation', async () => {
  migrationText ??= await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  const fixture = schemaFixture();
  try {
    const firstAt = '2026-10-31T10:00:00.000Z', firstNow = Date.parse(firstAt);
    const firstSource = 'a'.repeat(40), nextSource = 'b'.repeat(40);
    const raw = rawFixture(fixture.schema, fixture.columns);
    const first = await qualifyPost0226Snapshot(raw, { sourceCommit:firstSource, observedAt:firstAt, now:firstNow });
    const candidate = compileProductionAutoPost0226PreservationPolicy(first, { sourceCommit:firstSource, now:firstNow });
    assert.equal(candidate.offlineOnly, true);
    assert.equal(candidate.activationEnabled, false);
    assert.equal(candidate.policy.baseline.nativeControlEnabled, 0);
    assert.equal(candidate.policy.baseline.aliasLinkingAuthorized, false);
    assert.equal(validateProductionAutoPost0226PreservationPolicy(candidate.policy), candidate.policy);
    assert.equal(JSON.stringify(candidate).includes('owner@example.test'), false);
    assert.equal(JSON.stringify(candidate).includes('access_subject'), false);

    const secondAt = '2026-10-31T10:15:00.000Z', secondNow = Date.parse(secondAt);
    const second = await qualifyPost0226Snapshot(raw, { sourceCommit:nextSource, observedAt:secondAt, now:secondNow });
    const receipt1 = validateProductionAutoPost0226PreservationObservation(candidate.policy, first,
      { sourceCommit:firstSource, now:firstNow });
    assert.equal(validateProductionAutoPost0226PreservationReceipt(candidate.policy, receipt1,
      { sourceCommit:firstSource, now:firstNow }).stateSha256, receipt1.stateSha256);
    assert.throws(() => validateProductionAutoPost0226PreservationReceipt(candidate.policy, receipt1,
      { sourceCommit:firstSource, now:firstNow+60_001 }), /receipt_invalid_or_stale/u);
    assert.throws(() => validateProductionAutoPost0226PreservationReceipt(candidate.policy,
      { ...receipt1, bridgeMismatchCount:receipt1.bridgeMismatchCount+1 }, { sourceCommit:firstSource, now:firstNow }), /receipt_state_mismatch/u);
    const secondSameSource = await qualifyPost0226Snapshot(raw, { sourceCommit:firstSource, observedAt:secondAt, now:secondNow });
    const receipt2 = validateProductionAutoPost0226PreservationObservation(candidate.policy, secondSameSource,
      { sourceCommit:firstSource, now:secondNow });
    const nextSourceReceipt = validateProductionAutoPost0226PreservationObservation(candidate.policy, second,
      { sourceCommit:nextSource, now:secondNow });
    assert.equal(receipt1.sourceCommit, firstSource);
    assert.equal(receipt2.sourceCommit, firstSource);
    assert.equal(nextSourceReceipt.sourceCommit, nextSource);
    assert.equal(receipt1.stateSha256, receipt2.stateSha256);
    const repeated = validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy, [receipt1, receipt2],
      { sourceCommit:firstSource, now:secondNow });
    assert.equal(repeated.count, 2);
    assert.throws(() => validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy, [clone(receipt1), clone(receipt2)],
      { sourceCommit:firstSource, now:secondNow }), /repeated_receipt_not_prevalidated_in_run/u);
    assert.throws(() => validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy, [receipt1, receipt2],
      { sourceCommit:firstSource, now:secondNow+60_001 }), /repeated_receipt_latest_stale/u);
    const futureLatest = { ...receipt2, observedAt:new Date(secondNow+1_000).toISOString() };
    assert.throws(() => validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy, [receipt1, futureLatest],
      { sourceCommit:firstSource, now:secondNow }), /receipt_invalid_or_stale/u);
    assert.throws(() => validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy, [receipt2, receipt1],
      { sourceCommit:firstSource, now:secondNow }), /repeated_receipt_time_order_invalid/u);
    const tooLateAt = firstNow + 45 * 60_000 + 1_000;
    const tooLateObservation = await qualifyPost0226Snapshot(raw, { sourceCommit:firstSource,
      observedAt:new Date(tooLateAt).toISOString(), now:tooLateAt });
    const tooLateReceipt = validateProductionAutoPost0226PreservationObservation(candidate.policy, tooLateObservation,
      { sourceCommit:firstSource, now:tooLateAt });
    assert.throws(() => validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy,
      [receipt1, tooLateReceipt], { sourceCommit:firstSource, now:tooLateAt }), /repeated_receipt_sequence_too_long/u);
    const boundedSequence = Array.from({ length: PRODUCTION_AUTO_POST0226_MAX_RECEIPTS }, () =>
      validateProductionAutoPost0226PreservationObservation(candidate.policy, first, { sourceCommit:firstSource, now:firstNow }));
    assert.equal(validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy, boundedSequence,
      { sourceCommit:firstSource, now:firstNow }).count, PRODUCTION_AUTO_POST0226_MAX_RECEIPTS);
    const overBoundSequence = [...boundedSequence,
      validateProductionAutoPost0226PreservationObservation(candidate.policy, first, { sourceCommit:firstSource, now:firstNow })];
    assert.throws(() => validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy, overBoundSequence,
      { sourceCommit:firstSource, now:firstNow }), /repeated_receipts_required/u);

    const changedRows = clone(raw);
    changedRows.post0226Rows.staff_login_generations[0].generation += 1;
    const changedObservation = await qualifyPost0226Snapshot(changedRows, { sourceCommit:nextSource,
      observedAt:secondAt, now:secondNow });
    assert.throws(() => validateProductionAutoPost0226PreservationObservation(candidate.policy, changedObservation,
      { sourceCommit:nextSource, now:secondNow }), /preservation_state_changed/u);
    for (const changed of [
      { ...second, sourceCommit:firstSource },
      { ...second, accountId:'00000000000000000000000000000000' },
      { ...second, nativeControlEnabled:1 },
      { ...second, fullStaffCutoverReadiness:true },
      { ...second, aliasLinkingAuthorized:true },
      { ...second, loginSchemaSha256:'f'.repeat(64) },
      { ...second, extraApproval:true },
    ]) assert.throws(() => validateProductionAutoPost0226PreservationObservation(candidate.policy, changed,
      { sourceCommit:nextSource, now:secondNow }));
    assert.throws(() => validateProductionAutoPost0226PreservationObservation(candidate.policy, second,
      { sourceCommit:nextSource, now:secondNow+60_001 }), /observation_invalid_or_stale/u);
    const driftedReceipt = { ...receipt2, bridgeMismatchCount:receipt2.bridgeMismatchCount+1 };
    assert.throws(() => validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy,
      [receipt1, driftedReceipt], { sourceCommit:firstSource, now:secondNow }), /receipt_state_mismatch/u);
    const consistentTampering1 = { ...receipt1, bridgeMismatchCount:receipt1.bridgeMismatchCount+1 };
    const consistentTampering2 = { ...receipt2, bridgeMismatchCount:receipt2.bridgeMismatchCount+1 };
    assert.throws(() => validateRepeatedProductionAutoPost0226PreservationReceipts(candidate.policy,
      [consistentTampering1, consistentTampering2], { sourceCommit:firstSource, now:secondNow }), /receipt_state_mismatch/u);

    const originalPath = process.env.PRODUCTION_AUTO_POST0226_POLICY_PATH;
    process.env.PRODUCTION_AUTO_POST0226_POLICY_PATH = 'C:\\unreviewed\\policy.json';
    try {
      const pinned = loadPinnedProductionAutoPost0226PreservationPolicy();
      assert.equal(sha(canonicalStaffReadiness(pinned)), PRODUCTION_AUTO_POST0226_PRESERVATION_POLICY_SHA256);
      assert.equal(pinned.baseline.baseSnapshotSha256, '23a7e1603789e96d26b07aa60393411bdec3dc09494ad47464294b0ed62f860d');
      assert.equal(pinned.baseline.nativeControlEnabled, 0);
      assert.equal(pinned.baseline.preservationOnly, true);
      assert.throws(() => validateProductionAutoPost0226PreservationPolicy({ ...pinned,
        databaseId: '7f40a7b7-c3ec-470e-a626-e798867f71f8' }), /policy_invalid/u);
    } finally {
      if (originalPath === undefined) delete process.env.PRODUCTION_AUTO_POST0226_POLICY_PATH;
      else process.env.PRODUCTION_AUTO_POST0226_POLICY_PATH = originalPath;
    }
  } finally { fixture.db.close(); }
});

test('sequential unchanged captures validate by state digest while freshness remains independently enforced', async () => {
  migrationText ??= await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  const fixture = schemaFixture();
  try {
    const raw = rawFixture(fixture.schema, fixture.columns);
    const firstNow = Date.parse('2026-10-31T10:00:00.000Z');
    const first = await qualifyPost0226Snapshot(raw, { sourceCommit, observedAt:'2026-10-31T09:59:45.000Z', now:firstNow });
    const review = await createPost0226StaffPreservationReview(first, { sourceCommit,
      reviewedAt:'2026-10-31T10:00:00.000Z', expiresAt:'2026-10-31T10:10:00.000Z', now:firstNow });
    const secondNow = Date.parse('2026-10-31T10:00:20.000Z');
    const second = await qualifyPost0226Snapshot(raw, { sourceCommit, observedAt:'2026-10-31T10:00:15.000Z', now:secondNow });
    assert.notEqual(second.observedAt, first.observedAt);
    assert.equal(validatePost0226StaffPreservationReview(review, second, { sourceCommit, now:secondNow }).preservationOnly, true);
    const changedRaw = clone(raw);
    changedRaw.post0226Rows.staff_login_generations[0].generation += 1;
    const changed = await qualifyPost0226Snapshot(changedRaw, { sourceCommit,
      observedAt:'2026-10-31T10:00:25.000Z', now:Date.parse('2026-10-31T10:00:30.000Z') });
    assert.throws(() => validatePost0226StaffPreservationReview(review, changed, { sourceCommit, now:Date.parse('2026-10-31T10:00:30.000Z') }), /state_changed/u);
    await assert.rejects(qualifyPost0226Snapshot(raw, { sourceCommit, observedAt:'2026-10-31T09:58:00.000Z',
      now:Date.parse('2026-10-31T10:00:00.000Z') }), /snapshot_invalid/u);
    await assert.rejects(qualifyPost0226Snapshot(raw, { sourceCommit, observedAt:'2026-10-31T10:01:00.000Z',
      now:Date.parse('2026-10-31T10:00:00.000Z') }), /snapshot_invalid/u);
    assert.throws(() => { POST0226_LOGIN_TABLES.staff_login_bindings.push('id'); }, TypeError);
  } finally { fixture.db.close(); }
});

test('any alias/link/revoke rows or generation/profile change invalidate the short review while roles and admission remain pinned', async () => {
  migrationText ??= await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  const fixture = schemaFixture();
  try {
    const raw = rawFixture(fixture.schema, fixture.columns);
    const db = fixture.db;
    const createdAt = Date.now();
    db.prepare('INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,?)')
      .run('staff:synthetic-owner','owner@example.test','Synthetic Owner','subject|owner','active');
    db.prepare('INSERT INTO staff_role_assignments(staff_id,role_id,scope) VALUES(?,?,?)').run('staff:synthetic-owner','role-owner','global');
    db.prepare('INSERT INTO native_staff_admissions(staff_id,version,active) VALUES(?,?,?)').run('staff:synthetic-owner',3,0);
    db.prepare('INSERT INTO native_staff_profiles(staff_id,version,updated_at) VALUES(?,?,?)')
      .run('staff:synthetic-owner',1,'2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO staff_login_generations(staff_id,generation) VALUES(?,?)').run('staff:synthetic-owner',0);
    raw.post0226Rows.staff_login_generations = db.prepare('SELECT staff_id,generation FROM staff_login_generations').all()
      .map(row => ({ staff_id:row.staff_id, generation:row.generation }));
    raw.native_staff_profiles = [{ staff_id:'staff:synthetic-owner',login_email:'owner@example.test',display_name:'Synthetic Owner',
      version:1,created_at:'2026-10-01T00:00:00.000Z',updated_at:'2026-10-01T00:00:00.000Z' }];
    const initialRoles = db.prepare('SELECT * FROM staff_role_assignments').all();
    const initialAdmissions = db.prepare('SELECT * FROM native_staff_admissions').all();
    const observation = await qualifyPost0226Snapshot(raw, { sourceCommit, observedAt, now });
    const review = await createPost0226StaffPreservationReview(observation, { sourceCommit,
      reviewedAt:'2026-10-31T10:00:30.000Z', expiresAt:'2026-10-31T10:10:00.000Z', now });
    const tokenSha = 'a'.repeat(64);
    db.prepare(`INSERT INTO staff_login_binding_intents(id,staff_id,canonical_email,canonical_subject,issuer,alternate_email,
      token_sha256,generation,created_at_ms,expires_at_ms,status,binding_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('intent:synthetic','staff:synthetic-owner','owner@example.test','subject|owner','https://issuer.example.test',
        'alias@example.test',tokenSha,0,createdAt,createdAt+900000,'pending',null);
    const pending = { ...clone(raw), post0226Rows: { ...raw.post0226Rows,
      staff_login_binding_intents: db.prepare('SELECT * FROM staff_login_binding_intents').all().map(row => JSON.parse(JSON.stringify(row))) } };
    const pendingObservation = await qualifyPost0226Snapshot(pending, { sourceCommit, observedAt, now });
    assert.throws(() => validatePost0226StaffPreservationReview(review, pendingObservation, { sourceCommit, now }), /state_changed/u);
    db.prepare(`INSERT INTO staff_login_bindings(id,staff_id,issuer,login_email,access_subject,intent_id,version,status,created_at_ms,
      revoked_at_ms,revoked_by_staff_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run('binding:synthetic','staff:synthetic-owner','https://issuer.example.test','alias@example.test','subject|alias',
        'intent:synthetic',1,'active',createdAt,null,null);
    assert.equal(db.prepare('SELECT generation FROM staff_login_generations').get().generation,1);
    assert.equal(db.prepare('SELECT version FROM native_staff_profiles').get().version,2);
    assert.deepEqual(db.prepare('SELECT * FROM staff_role_assignments').all(), initialRoles);
    assert.deepEqual(db.prepare('SELECT * FROM native_staff_admissions').all(), initialAdmissions);
    const linked = { ...clone(pending), post0226Rows: { ...pending.post0226Rows,
      staff_login_binding_intents: db.prepare('SELECT * FROM staff_login_binding_intents').all().map(row => JSON.parse(JSON.stringify(row))),
      staff_login_bindings: db.prepare('SELECT * FROM staff_login_bindings').all().map(row => JSON.parse(JSON.stringify(row))),
      staff_login_generations: db.prepare('SELECT staff_id,generation FROM staff_login_generations').all().map(row => JSON.parse(JSON.stringify(row))),
      staff_login_binding_audit: db.prepare('SELECT * FROM staff_login_binding_audit').all().map(row => JSON.parse(JSON.stringify(row))) } };
    linked.native_staff_profiles = [{ staff_id:'staff:synthetic-owner',login_email:'owner@example.test',display_name:'Synthetic Owner',
      version:2,created_at:'2026-10-01T00:00:00.000Z',updated_at:'2026-10-31T10:00:00.000Z' }];
    linked.nativeStaffCohort[0].profileVersion = 2;
    const linkedObservation = await qualifyPost0226Snapshot(linked, { sourceCommit, observedAt, now });
    assert.throws(() => validatePost0226StaffPreservationReview(review, linkedObservation, { sourceCommit, now }), /state_changed/u);
    db.prepare(`UPDATE staff_login_bindings SET status='revoked',version=2,revoked_at_ms=?,revoked_by_staff_id=? WHERE id=?`)
      .run(createdAt+1,'staff:synthetic-owner','binding:synthetic');
    assert.equal(db.prepare('SELECT generation FROM staff_login_generations').get().generation,2);
    assert.equal(db.prepare('SELECT version FROM native_staff_profiles').get().version,3);
    assert.deepEqual(db.prepare('SELECT * FROM staff_role_assignments').all(), initialRoles);
    assert.deepEqual(db.prepare('SELECT * FROM native_staff_admissions').all(), initialAdmissions);
    const revoked = { ...clone(linked), post0226Rows: { ...linked.post0226Rows,
      staff_login_bindings: db.prepare('SELECT * FROM staff_login_bindings').all().map(row => JSON.parse(JSON.stringify(row))),
      staff_login_generations: db.prepare('SELECT staff_id,generation FROM staff_login_generations').all().map(row => JSON.parse(JSON.stringify(row))),
      staff_login_binding_audit: db.prepare('SELECT * FROM staff_login_binding_audit').all().map(row => JSON.parse(JSON.stringify(row))) } };
    revoked.native_staff_profiles[0].version = 3;
    revoked.nativeStaffCohort[0].profileVersion = 3;
    const revokedObservation = await qualifyPost0226Snapshot(revoked, { sourceCommit, observedAt, now });
    assert.throws(() => validatePost0226StaffPreservationReview(review, revokedObservation, { sourceCommit, now }), /state_changed/u);
  } finally { fixture.db.close(); }
});

test('pre-0226 review discriminator is not accepted by the post-0226 validator', async () => {
  migrationText ??= await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  const fixture = schemaFixture();
  try {
    const observation = await qualifyPost0226Snapshot(rawFixture(fixture.schema, fixture.columns), { sourceCommit, observedAt, now });
    const review = await createPost0226StaffPreservationReview(observation, { sourceCommit,
      reviewedAt:'2026-10-31T10:00:30.000Z', expiresAt:'2026-10-31T10:10:00.000Z', now });
    review.contract = 'ordinary-frontend-preserve-native-staff-v1';
    assert.throws(() => validatePost0226StaffPreservationReview(review, observation, { sourceCommit, now }));
  } finally { fixture.db.close(); }
});

test('reader is a one-query SELECT and returns only digests/counts for complete login rows', async () => {
  migrationText ??= await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  const fixture = schemaFixture();
  try {
    const raw = rawFixture(fixture.schema, fixture.columns);
    const secretMarker = 'd'.repeat(64);
    raw.post0226Rows.staff_login_binding_intents = [{ id:'intent:redacted',staff_id:'staff:synthetic-owner',canonical_email:'owner@example.test',
      canonical_subject:'subject|owner',issuer:'https://issuer.example.test',alternate_email:'alias@example.test',token_sha256:secretMarker,
      generation:0,created_at_ms:1,expires_at_ms:900001,status:'pending',binding_id:null }];
    const before = Date.now();
    const result = await readPost0226StaffPreservationObservation({ sourceCommit,
      now: () => before,
      read: async args => {
        assert.equal(args[0], 'd1');
        assert.equal(args[1], 'execute');
        assert.equal(args[3], '--remote');
        assert.match(args[7], /^SELECT json_object\(/u);
        assert.doesNotMatch(args[7], /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH)\b/iu);
        return [{ success:true, results:[{ frontend_authority_snapshot:JSON.stringify(raw) }] }];
      } });
    assert.equal(result.loginRows.staff_login_binding_intents.count, 1);
    assert.equal(JSON.stringify(result).includes(secretMarker), false);
    assert.equal(JSON.stringify(result).includes('alias@example.test'), false);
    assert.equal(POST0226_STAFF_PRESERVATION_QUERY.includes('post0226Rows'), true);
  } finally { fixture.db.close(); }
});

test('combined post-0226 query executes as a read-only snapshot against complete synthetic schema', async () => {
  migrationText ??= await readFile(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    const integerFields = new Set(['immutable','is_primary','active','singleton','enabled','generation','applied_generation',
      'attempt_generation','attempts','version','contract_version']);
    for (const [table, fields] of Object.entries(ORDINARY_FRONTEND_AUTHORITY_TABLES)) {
      const columns = fields.map(field => `"${field}" ${field === 'id' && table === 'staff_users' ? 'TEXT PRIMARY KEY'
        : integerFields.has(field) ? 'INTEGER' : 'TEXT'}`).join(',');
      db.exec(`CREATE TABLE "${table}" (${columns})`);
    }
    db.exec(`CREATE VIEW native_staff_control_plane_candidates AS
      SELECT staff_id,bound_access_subject,version AS admission_version,version AS profile_version FROM native_staff_admissions WHERE 0;
      CREATE VIEW native_staff_lifecycle_control_plane_candidates AS
      SELECT staff_id,bound_access_subject,admission_version,profile_version FROM native_staff_control_plane_candidates;`);
    db.exec(migrationText);
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,?)`)
      .run('staff:synthetic','synthetic@example.test','Synthetic','subject|synthetic','active');
    db.prepare(`INSERT INTO native_staff_access_reconciliation(singleton,enabled,generation,applied_generation,lease_id,lease_until,
      attempt_generation,attempts,last_attempt_at,last_success_at,last_error) VALUES(1,0,0,0,NULL,NULL,NULL,0,NULL,NULL,NULL)`).run();
    const selected = JSON.parse(db.prepare(POST0226_STAFF_PRESERVATION_QUERY).get().frontend_authority_snapshot);
    assert.equal(selected.staff_users.length, 1);
    assert.equal(selected.post0226Schema.length, 23);
    assert.equal(selected.post0226Rows.staff_login_binding_control.length, 1);
    assert.equal(selected.post0226Rows.staff_login_generations.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM staff_users').get().count, 1);
    const observation = await qualifyPost0226Snapshot(selected, { sourceCommit, observedAt, now });
    assert.equal(observation.nativeControlEnabled, 0);
    assert.equal(observation.bridgeMismatchCount, 1);
  } finally { db.close(); }
});
