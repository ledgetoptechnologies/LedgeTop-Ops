import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createStagingOps0226Operator, STAGING_OPS_0226_BASELINE, STAGING_OPS_0226_TARGET,
  STAGING_OPS_0226_POST_READ_QUERY, STAGING_OPS_0226_PRE_READ_QUERY,
  STAGING_OPS_0226_PROTECTED_TABLES, parseStagingOps0226SnapshotResult,
} from './staging-ops-staff-login-0226-once.mjs';

const sourceCommit = 'dc8cedfe953ce75eb2f65de846de74d076b820f8';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safeTarget = structuredClone(STAGING_OPS_0226_TARGET);
const nowIso = () => new Date().toISOString();
const wireFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/staging-ops-0226-wrangler-wire-statements.json', import.meta.url), 'utf8'));

function fixture() {
  const db = new DatabaseSync(':memory:');
  const metadata = JSON.parse(fs.readFileSync(new URL('./fixtures/staging-ops-0226-schema-metadata.json', import.meta.url), 'utf8'));
  db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE);');
  for (const ddl of Object.values(metadata.tables)) db.exec(ddl);
  db.exec(`CREATE TABLE native_business_areas(id TEXT PRIMARY KEY);
    CREATE TABLE native_business_divisions(business_area_id TEXT,id TEXT,PRIMARY KEY(business_area_id,id));
    CREATE TABLE native_staff_authority_capabilities(contract_version INTEGER,authority_domain TEXT,capability TEXT,
      PRIMARY KEY(contract_version,authority_domain,capability));
    CREATE VIEW native_staff_control_plane_candidates AS SELECT staff_id,bound_access_subject,version admission_version,version profile_version
      FROM native_staff_admissions;
    CREATE VIEW native_staff_lifecycle_control_plane_candidates AS SELECT staff_id,bound_access_subject,version admission_version,version profile_version
      FROM native_staff_admissions;`);

  const names = [
    ...Array.from({ length: 223 }, (_v,i) => `${String(i+1).padStart(4,'0')}_fixture_${i+1}.sql`),
    '0224_windows_portal_publication_chain_index.sql',
    '0225_native_staff_lifecycle_bridge.sql',
    '0233_operations_portal_native_recipient_capability_intents.sql',
    '0234_operations_portal_native_inquiry_capability.sql',
    '0235_ops_principal_inquiries.sql',
  ];
  const insertMigration = db.prepare('INSERT INTO d1_migrations(name) VALUES(?)');
  for (const name of names) insertMigration.run(name);
  for (const statement of [
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('staff-owner','owner@example.invalid','Synthetic Owner','access|owner','active')`),
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('staff-inactive-history','history@example.invalid','Inactive History','access|history','inactive')`),
    db.prepare(`INSERT INTO staff_role_assignments VALUES('role-assignment-owner','staff-owner','role-owner','global',NULL,'global','seed','2026-01-01')`),
    db.prepare(`INSERT INTO staff_role_assignments VALUES('role-assignment-history','staff-inactive-history','role-owner','global',NULL,'global','seed','2025-01-01')`),
    db.prepare(`INSERT INTO local_staff_role_assignments VALUES('local-role-history','staff-inactive-history','role-staff','global',NULL,'seed','2025-01-01')`),
    db.prepare(`INSERT INTO staff_permission_overrides VALUES('override-history','staff-inactive-history','administration.view','deny','global',NULL,'global','seed','2025-01-01')`),
    db.prepare(`INSERT INTO roles VALUES('role-owner','Owner','Synthetic owner role',1,'2026-01-01','2026-01-01')`),
    db.prepare(`INSERT INTO roles VALUES('role-staff','Staff','Synthetic staff role',0,'2026-01-01','2026-01-01')`),
    db.prepare(`INSERT INTO permissions VALUES('administration.view','Synthetic administration permission')`),
    db.prepare(`INSERT INTO role_permissions VALUES('role-owner','administration.view')`),
    db.prepare(`INSERT INTO divisions(id,name,code,active,created_at,updated_at) VALUES('division-one','Division One','D1',1,'2026-01-01','2026-01-01')`),
    db.prepare(`INSERT INTO staff_divisions VALUES('staff-inactive-history','division-one',1,'2025-01-01')`),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by,version,created_at,updated_at) VALUES('staff-owner','access|owner',1,'staff-owner',1,'2026-01-01','2026-01-01')`),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by,version,created_at,updated_at) VALUES('staff-inactive-history','access|history',0,'staff-owner',2,'2025-01-01','2025-01-01')`),
    db.prepare(`INSERT INTO native_staff_profiles VALUES('staff-owner','owner@example.invalid','Synthetic Owner',4,'2026-01-01','2026-01-01')`),
    db.prepare(`INSERT INTO native_staff_profiles VALUES('staff-inactive-history','history@example.invalid','Inactive History',9,'2025-01-01','2025-01-01')`),
    db.prepare(`INSERT INTO native_staff_access_reconciliation VALUES(1,0,0,0,NULL,NULL,NULL,0,NULL,NULL,NULL)`),
  ]) statement.run();
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}

function capture(db, phase, observedAt = nowIso(), target = safeTarget) {
  const query = phase === 'postwrite' ? STAGING_OPS_0226_POST_READ_QUERY : STAGING_OPS_0226_PRE_READ_QUERY;
  const row = db.prepare(query).get();
  return { ...JSON.parse(row.staging_ops_0226_snapshot), target: structuredClone(target), observedAt };
}

function baselineFrom(snapshot) {
  const ledgerNamesSha256 = hash(snapshot.ledger.map(row => row.name).join('\n'));
  const ledgerSha256 = hash(JSON.stringify(snapshot.ledger.map(row => [row.id,row.name])));
  const schemaSha256 = hash(JSON.stringify(snapshot.schema.map(row => [row.type,row.name,row.tbl_name,row.sql])));
  return { ledgerCount: snapshot.ledger.length, ledgerNamesSha256, ledgerSha256, schemaObjectCount: snapshot.schema.length, schemaSha256,
    requiredMigrations: STAGING_OPS_0226_BASELINE.requiredMigrations,
    forbiddenPending: STAGING_OPS_0226_BASELINE.forbiddenPending };
}

function journalLocation() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-ops-0226-'));
  return { directory, journalPath: path.join(directory, 'journal.jsonl'), cleanup: () => fs.rmSync(directory, { recursive:true, force:true }) };
}

function providerFor(db, { mutateAfterApply = false } = {}) {
  const calls = { reads:[], mutations:0 };
  return { calls, provider: {
    async readSnapshot(args) { calls.reads.push(args.phase); return capture(db, args.phase); },
    async applyExactMigration({ name, sha256: migrationSha, sql, appendLedger }) {
      calls.mutations++;
      assert.equal(name, '0226_staff_login_bindings.sql');
      assert.equal(migrationSha, 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5');
      assert.equal(appendLedger, true);
      db.exec('PRAGMA foreign_keys = ON');
      for (const statement of wireFixture.statements) db.exec(statement);
      db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
      if (typeof mutateAfterApply === 'function') mutateAfterApply(db);
      else if (mutateAfterApply) db.prepare(`UPDATE staff_role_assignments SET created_at='changed' WHERE id='role-assignment-history'`).run();
      return { applied:true };
    },
  } };
}

test('pinned baseline comes from actual staging capsule metadata and exact table definitions', () => {
  const metadata = JSON.parse(fs.readFileSync(new URL('./fixtures/staging-ops-0226-schema-metadata.json', import.meta.url), 'utf8'));
  assert.equal(metadata.sourceCapsuleSha256, '4e4e7961009a6b019857f8a2d5b10b91641fb5a08115c60bf3730b98dec0dfa6');
  assert.equal(metadata.ledgerCount, STAGING_OPS_0226_BASELINE.ledgerCount);
  assert.equal(metadata.ledgerNamesSha256, STAGING_OPS_0226_BASELINE.ledgerNamesSha256);
  assert.equal(metadata.ledgerSha256, STAGING_OPS_0226_BASELINE.ledgerSha256);
  assert.equal(metadata.schemaObjectCount, STAGING_OPS_0226_BASELINE.schemaObjectCount);
  assert.equal(metadata.schemaSha256, STAGING_OPS_0226_BASELINE.schemaSha256);
  const db = new DatabaseSync(':memory:');
  try {
    for (const ddl of Object.values(metadata.tables)) db.exec(ddl);
    for (const [table, columns] of Object.entries(STAGING_OPS_0226_PROTECTED_TABLES)) {
      assert.deepEqual(db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name), columns);
    }
  } finally { db.close(); }
});

test('pinned Wrangler wire statements reproduce the actual two-comment SQLite definition', () => {
  const rawDb = fixture(), wireDb = fixture();
  try {
    const source = fs.readFileSync(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
    rawDb.exec(source);
    for (const statement of wireFixture.statements) wireDb.exec(statement);
    const raw = rawDb.prepare("SELECT sql FROM sqlite_master WHERE name='staff_login_binding_linked'").get().sql;
    const wire = wireDb.prepare("SELECT sql FROM sqlite_master WHERE name='staff_login_binding_linked'").get().sql;
    assert.match(raw, /Invalidate ephemeral native contexts/u);
    assert.doesNotMatch(wire, /Invalidate ephemeral native contexts/u);
    assert.notEqual(raw, wire);
    assert.equal(hash(JSON.stringify(wireFixture.statements)), wireFixture.statementsSha256);
  } finally { rawDb.close(); wireDb.close(); }
});

test('compiles and executes only the pinned 0226 migration, preserving complete staff/role/admission history', async t => {
  const db = fixture(), local = journalLocation(); t.after(() => { db.close(); local.cleanup(); });
  const pre = capture(db, 'preflight');
  const operator = createStagingOps0226Operator({ baseline:baselineFrom(pre) });
  const plan = operator.compile(pre, { sourceCommit, now:Date.now() });
  assert.equal(plan.migration.name, '0226_staff_login_bindings.sql');
  assert.equal(plan.migration.ledgerAppend, true);
  assert.equal(plan.expectedNamedObjectCount, 23);
  assert.equal(plan.preflight.nativeStaffControlEnabled, 0);
  assert.deepEqual(plan.preflight.protectedTableCounts.staff_users, 2);
  assert.equal(JSON.stringify(plan).includes('owner@example.invalid'), false);
  assert.equal(JSON.stringify(plan).includes('history@example.invalid'), false);

  const { provider, calls } = providerFor(db);
  const result = await operator.executeOnce({ plan, provider, journalPath:local.journalPath });
  assert.equal(result.mutationCalls, 1);
  assert.deepEqual(calls.reads, ['immediate-prewrite','postwrite']);
  assert.equal(calls.mutations, 1);
  assert.equal(result.after.loginObjectsAdded, 23);
  assert.equal(result.after.aliasRowsAdded, 0);
  assert.equal(result.after.nativeStaffControlEnabled, 0);
  assert.equal(result.after.ledgerCount, 229);
  assert.equal(db.prepare('SELECT count(*) n FROM staff_login_binding_control WHERE singleton=1 AND schema_version=1').get().n, 1);
  for (const table of ['staff_login_generations','staff_login_binding_intents','staff_login_bindings','staff_login_binding_audit'])
    assert.equal(db.prepare(`SELECT count(*) n FROM "${table}"`).get().n, 0);
  assert.equal(db.prepare('SELECT status FROM staff_users WHERE id=?').get('staff-inactive-history').status, 'inactive');
  assert.equal(db.prepare('SELECT active FROM native_staff_admissions WHERE staff_id=?').get('staff-inactive-history').active, 0);
  assert.equal(db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').get('staff-inactive-history').version, 9);
  assert.equal(db.prepare('SELECT role_id FROM staff_role_assignments WHERE id=?').get('role-assignment-history').role_id, 'role-owner');
  const journal = fs.readFileSync(local.journalPath, 'utf8');
  assert.equal(journal.includes('owner@example.invalid'), false);
  assert.equal(journal.includes('history@example.invalid'), false);
  assert.equal(journal.includes('verificationToken'), false);
  assert.match(journal, /migration-0226-apply-intent/u);
  assert.match(journal, /migration-0226-postread-verified/u);
});

test('prewrite staff/role drift blocks before journal creation and migration call', async t => {
  const db = fixture(), local = journalLocation(); t.after(() => { db.close(); local.cleanup(); });
  const operator = createStagingOps0226Operator({ baseline:baselineFrom(capture(db, 'preflight')) });
  const plan = operator.compile(capture(db, 'preflight'), { sourceCommit, now:Date.now() });
  db.prepare(`UPDATE staff_role_assignments SET scope='division',division_id='division-one',scope_key='division-one' WHERE id='role-assignment-history'`).run();
  const { provider, calls } = providerFor(db);
  await assert.rejects(operator.executeOnce({ plan, provider, journalPath:local.journalPath }), /prewrite_drift/u);
  assert.equal(calls.mutations, 0);
  assert.deepEqual(calls.reads, ['immediate-prewrite']);
  assert.equal(fs.existsSync(local.journalPath), false);
});

test('full ledger id changes and omitted staff provisioning fields are protected', async t => {
  const db = fixture(), local = journalLocation(); t.after(() => { db.close(); local.cleanup(); });
  const initial = capture(db,'preflight'), operator = createStagingOps0226Operator({ baseline:baselineFrom(initial) });
  const plan = operator.compile(initial,{sourceCommit,now:Date.now()});
  db.prepare('UPDATE d1_migrations SET id=id+1000 WHERE id=(SELECT MAX(id) FROM d1_migrations)').run();
  assert.throws(() => operator.compile(capture(db,'preflight'),{sourceCommit,now:Date.now()}), /ledger_pin_mismatch/u);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n, 228);
  db.prepare('UPDATE d1_migrations SET id=id-1000 WHERE id=(SELECT MAX(id) FROM d1_migrations)').run();
  const { provider, calls } = providerFor(db,{ mutateAfterApply: database => {
    database.prepare("UPDATE staff_users SET provisioning_source='project-alpha',sync_protected=1 WHERE id='staff-inactive-history'").run();
  }});
  await assert.rejects(operator.executeOnce({plan,provider,journalPath:local.journalPath}), /protected_rows_changed/u);
  assert.equal(calls.mutations,1);
});

test('postwrite row drift is held with one attempt and no retry', async t => {
  const db = fixture(), local = journalLocation(); t.after(() => { db.close(); local.cleanup(); });
  const operator = createStagingOps0226Operator({ baseline:baselineFrom(capture(db, 'preflight')) });
  const plan = operator.compile(capture(db, 'preflight'), { sourceCommit, now:Date.now() });
  const { provider, calls } = providerFor(db, { mutateAfterApply:true });
  await assert.rejects(operator.executeOnce({ plan, provider, journalPath:local.journalPath }), /protected_rows_changed/u);
  assert.equal(calls.mutations, 1);
  assert.deepEqual(calls.reads, ['immediate-prewrite','postwrite']);
  assert.match(fs.readFileSync(local.journalPath, 'utf8'), /migration-0226-postread-unverified/u);
  await assert.rejects(operator.executeOnce({ plan, provider, journalPath:local.journalPath }), /journal_exists_no_replay/u);
  assert.equal(calls.mutations, 1);
});

test('a corrupted wire trigger is rejected by exact schema verification', async t => {
  const db = fixture(), local = journalLocation(); t.after(() => { db.close(); local.cleanup(); });
  const before = capture(db,'preflight'), operator = createStagingOps0226Operator({ baseline:baselineFrom(before) });
  const plan = operator.compile(before,{sourceCommit,now:Date.now()});
  const { provider, calls } = providerFor(db,{mutateAfterApply: database => {
    database.exec("DROP TRIGGER staff_login_binding_linked; CREATE TRIGGER staff_login_binding_linked AFTER INSERT ON staff_login_bindings BEGIN SELECT 1; END;");
  }});
  await assert.rejects(operator.executeOnce({plan,provider,journalPath:local.journalPath}), /schema_delta_not_exact/u);
  assert.equal(calls.mutations,1);
});

test('ambiguous apply response is journaled and never retried', async t => {
  const db = fixture(), local = journalLocation(); t.after(() => { db.close(); local.cleanup(); });
  const operator = createStagingOps0226Operator({ baseline:baselineFrom(capture(db, 'preflight')) });
  const plan = operator.compile(capture(db, 'preflight'), { sourceCommit, now:Date.now() });
  const calls = { reads:0, mutations:0 };
  const provider = { async readSnapshot({phase}) { calls.reads++; return capture(db,phase); }, async applyExactMigration() {
    calls.mutations++; db.exec(plan.migration.sql); db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(plan.migration.name);
    throw Error('synthetic lost response');
  } };
  await assert.rejects(operator.executeOnce({ plan, provider, journalPath:local.journalPath }), /outcome_unknown_no_retry/u);
  assert.deepEqual(calls, { reads:1, mutations:1 });
  assert.match(fs.readFileSync(local.journalPath, 'utf8'), /migration-0226-outcome-unknown/u);
  await assert.rejects(operator.executeOnce({ plan, provider, journalPath:local.journalPath }), /journal_exists_no_replay/u);
  assert.equal(calls.mutations, 1);
});

test('wrong target, ledger/schema pin, migration bytes, and prior/partial 0226 state refuse', async t => {
  const db = fixture(), local = journalLocation(); t.after(() => { db.close(); local.cleanup(); });
  const pre = capture(db, 'preflight'), baseline = baselineFrom(pre), operator = createStagingOps0226Operator({ baseline });
  assert.throws(() => operator.compile({ ...pre, target:{ ...safeTarget, databaseId:'wrong' } }, { sourceCommit, now:Date.now() }), /target_mismatch/u);
  assert.throws(() => operator.compile(pre, { sourceCommit:'not-a-commit', now:Date.now() }), /source_commit_invalid/u);
  assert.throws(() => createStagingOps0226Operator({ baseline:{ ...baseline, schemaSha256:'0'.repeat(64) } })
    .compile(pre, { sourceCommit, now:Date.now() }), /schema_pin_mismatch/u);

  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-ops-0226-bad-source-'));
  t.after(() => fs.rmSync(badRoot, { recursive:true, force:true }));
  const badPath = path.join(badRoot,'apps','operations','migrations'); fs.mkdirSync(badPath,{recursive:true});
  fs.writeFileSync(path.join(badPath,'0226_staff_login_bindings.sql'), 'SELECT 1;\n');
  assert.throws(() => operator.compile(pre, { sourceCommit, now:Date.now(), root:badRoot }), /migration_pin_mismatch/u);

  db.exec('CREATE TABLE staff_login_shadow(id TEXT)');
  assert.throws(() => operator.compile(capture(db,'preflight'), { sourceCommit, now:Date.now() }), /schema_pin_mismatch|login_schema_already_present/u);
  db.exec('DROP TABLE staff_login_shadow');
  const { provider, calls } = providerFor(db);
  await assert.rejects(operator.executeOnce({ plan:operator.compile(pre,{sourceCommit,now:Date.now()}), provider,
    journalPath:'relative-journal.jsonl' }), /journal_path_invalid/u); // no mutation because the path must be absolute
  assert.equal(calls.mutations,0);
});

test('already applied 0226 is refused before a second write; prior journal blocks replay before reads', async t => {
  const db = fixture(), local = journalLocation(); t.after(() => { db.close(); local.cleanup(); });
  const before = capture(db,'preflight'), baseline = baselineFrom(before), operator = createStagingOps0226Operator({ baseline });
  const plan = operator.compile(before,{sourceCommit,now:Date.now()}), { provider, calls } = providerFor(db);
  await operator.executeOnce({ plan, provider, journalPath:local.journalPath });
  assert.throws(() => operator.compile(capture(db,'postwrite'),{sourceCommit,now:Date.now()}), /snapshot_stale_or_invalid/u);
  const readsBefore = calls.reads.length;
  await assert.rejects(operator.executeOnce({ plan, provider, journalPath:local.journalPath }), /journal_exists_no_replay/u);
  assert.equal(calls.reads.length, readsBefore);
  assert.equal(calls.mutations,1);
});

test('snapshot query is SELECT-only and parser requires no-write primary-read metadata', () => {
  assert.match(STAGING_OPS_0226_PRE_READ_QUERY.trim(), /^SELECT\b/u);
  assert.match(STAGING_OPS_0226_POST_READ_QUERY.trim(), /^SELECT\b/u);
  assert.doesNotMatch(STAGING_OPS_0226_PRE_READ_QUERY, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/iu);
  const response = [{ success:true, results:[{ staging_ops_0226_snapshot: JSON.stringify({}) }],
    meta:{ rows_written:0, changed_db:false, served_by_primary:true } }];
  const parsed = parseStagingOps0226SnapshotResult(response,
    { observedAt:'2026-10-31T00:00:00.000Z' });
  assert.deepEqual(parsed.target, safeTarget);
  assert.equal(parsed.observedAt, '2026-10-31T00:00:00.000Z');
  assert.equal(Object.hasOwn(parsed,'staffRows'), false);
  assert.equal(Object.keys(STAGING_OPS_0226_PROTECTED_TABLES).includes('native_staff_access_reconciliation'), true);
  for (const meta of [{rows_written:1,changed_db:true,served_by_primary:true},
    {rows_written:0,changed_db:false,served_by_primary:false}, {rows_written:0,changed_db:false}]) {
    assert.throws(() => parseStagingOps0226SnapshotResult([{...response[0],meta}],
      { observedAt:'2026-10-31T00:00:00.000Z' }), /read_result_invalid/u);
  }
});
