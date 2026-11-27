// Offline tests for the onboarding approver grant one-shot. Every test runs against a disposable local SQLite
// built from this repository's Operations migrations, reached through the real Cloudflare provider with a
// synthetic fetch. Nothing contacts Cloudflare. All staff ids and emails are synthetic.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  APPROVER_GRANT_CONFIRMATION, APPROVER_GRANT_INSERT_SQL, APPROVER_GRANT_TARGET, approverGrantDelegationId,
  expectedApproverGrantRow, mainApproverGrant, parseApproverGrantArgs,
} from './production-ops-onboarding-approver-grant-once.mjs';
import { OPS_PRODUCTION_DATABASE } from './production-ops-0227-0244-ordered-once.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'apps', 'operations', 'migrations');
const TOKEN = 'synthetic-token-'.padEnd(48, 'x');
const SOURCE = 'a'.repeat(40);
const OWNER = 'staff-synthetic-owner';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
let work, template;
const open = [];

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-approver-grant-'));
  template = path.join(work, 'template.sqlite');
  const db = new DatabaseSync(template);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  for (const name of fs.readdirSync(MIGRATIONS).filter(item => /^\d{4}_.+\.sql$/u.test(item)).sort()) {
    db.exec('BEGIN');
    db.exec(fs.readFileSync(path.join(MIGRATIONS, name), 'utf8'));
    db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
    db.exec('COMMIT');
  }
  db.close();
});
after(() => {
  for (const db of open) try { db.close(); } catch {}
  fs.rmSync(work, { recursive: true, force: true });
});

let sequence = 0;
function freshDb() {
  const file = path.join(work, `db-${++sequence}.sqlite`);
  fs.copyFileSync(template, file);
  const db = new DatabaseSync(file);
  open.push(db);
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}

function person(db, id, { role = 'role-owner', status = 'active', admitted = true, profile = true } = {}) {
  const email = `${id}@example.test`, subject = `access|${id}`;
  db.prepare('INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,?)').run(id, email, id, subject, status);
  if (role) db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key)
    VALUES(?,?,?,'global',NULL,'global')`).run(`assignment-${id}`, id, role);
  if (admitted) db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').run(id, subject, id);
  if (admitted && profile) db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').run(id, email, id);
  return { id, email, subject };
}

/** Synthetic Cloudflare: D1 metadata plus /query batches executed on the local file, shaped like the REST API. */
function syntheticCloudflare(db, { name = APPROVER_GRANT_TARGET.databaseName, uuid = APPROVER_GRANT_TARGET.databaseId,
  failAfterInsert = false, httpFailWrite = false, failReadAfterWrite = false } = {}) {
  const calls = [];
  const json = value => ({ ok: true, status: 200, redirected: false, headers: { get: () => null }, text: async () => JSON.stringify(value) });
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${APPROVER_GRANT_TARGET.accountId}/d1/database/${uuid}`));
    if (init.method === 'GET') { calls.push({ kind: 'metadata' }); return json({ success: true, result: { uuid, name } }); }
    const body = JSON.parse(init.body);
    if (failReadAfterWrite && calls.some(call => call.kind === 'write')) throw new Error('synthetic read failure');
    const result = body.batch.map(({ sql, params }) => {
      const statement = db.prepare(sql);
      if (/^\s*SELECT/iu.test(sql)) { calls.push({ kind: 'read' }); return { success: true, results: statement.all(...params).map(row => ({ ...row })), meta: { changes: 0 } }; }
      calls.push({ kind: 'write', sql });
      const run = statement.run(...params);
      return { success: true, results: [], meta: { changes: Number(run.changes) } };
    });
    if (failAfterInsert && calls.at(-1).kind === 'write') throw new Error('synthetic connection reset');
    if (httpFailWrite && calls.at(-1).kind === 'write') return { ...json({ success: false }), ok: false, status: 500 };
    return json({ success: true, result });
  };
  return { fetchImpl, calls };
}

const counts = db => Object.fromEntries(['staff_users', 'staff_role_assignments', 'staff_permission_overrides',
  'native_staff_management_delegations'].map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const args = (mode, extra = []) => [...(mode ? [`--${mode}`] : []), '--target-staff-id', OWNER,
  '--database-id', APPROVER_GRANT_TARGET.databaseId, '--database-name', APPROVER_GRANT_TARGET.databaseName, ...extra];
const receiptPath = () => path.join(work, `receipt-${++sequence}.json`);
const executeArgs = receipt => args('execute', ['--approval-ref', 'hub-task-123', '--receipt', receipt]);
function deps(cloudflare, extra = {}) {
  const phrases = [];
  return { phrases, value: { env: { CLOUDFLARE_API_TOKEN: TOKEN }, out: () => {}, fetchImpl: cloudflare.fetchImpl,
    sourceCheck: () => SOURCE, confirm: async phrase => { phrases.push(phrase); return true; }, ...extra } };
}

// --- synthetic onboarding approval, using the exact SQL of approveNativeStaffOnboarding and readNativeStaffOnboardingReview

const APPROVAL_SOURCE = fs.readFileSync(path.join(ROOT, 'apps', 'operations', 'src', 'worker', 'native-staff-onboarding-approval.ts'), 'utf8');
const APPROVAL_SCOPE = /const APPROVAL_SCOPE = `([^`]+)`;/u.exec(APPROVAL_SOURCE)?.[1];
const ONBOARDING = '50000000-0000-4000-8000-000000000001', PROPOSED = 'staff-synthetic-new';
const PROPOSAL = JSON.stringify({ memberships: [], directoryGrants: [], managementGrants: [] });

function claimedOnboarding(db) {
  const creator = person(db, 'staff-synthetic-creator', { role: null });
  // Test-only: the pending-onboarding triggers are lifted for this one insert, then restored unchanged.
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='native_staff_pending_onboarding'").all();
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.prepare(`INSERT INTO native_staff_pending_onboarding(onboarding_id,proposed_staff_id,login_email,display_name,
    invitation_secret_sha256,expires_at,state,version,proposal_json,proposal_sha256,created_by_staff_id,created_by_subject,
    reason,claimed_access_subject,claimed_at,claim_evidence_sha256) VALUES(?,?,?,?,?,?,'claimed',2,?,?,?,?,?,?,?,?)`)
    .run(ONBOARDING, PROPOSED, 'new-staff@example.test', 'New Staff', 'a'.repeat(64), new Date(Date.now() + 600_000).toISOString(),
      PROPOSAL, sha(PROPOSAL), creator.id, creator.subject, 'Synthetic invitation', 'access|new-staff', new Date().toISOString(), 'b'.repeat(64));
  for (const trigger of triggers) db.exec(trigger.sql);
}

function reviewVisible(db, approver) {
  assert.ok(APPROVAL_SCOPE, 'APPROVAL_SCOPE must be readable from the approval module');
  return db.prepare(`SELECT p.onboarding_id FROM native_staff_pending_onboarding p
    JOIN native_staff_admissions a ON a.staff_id=? AND a.active=1 AND a.version=1
      AND a.bound_access_subject=? AND a.bound_access_subject<>p.claimed_access_subject
    JOIN native_staff_profiles profile ON profile.staff_id=a.staff_id AND profile.version=1 AND profile.login_email=?
    JOIN staff_users staff ON staff.id=a.staff_id AND staff.email=profile.login_email COLLATE BINARY
      AND staff.access_subject=a.bound_access_subject AND staff.status='active'
    WHERE p.onboarding_id=? AND p.state='claimed' AND p.version=2
      AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND ${APPROVAL_SCOPE}`).get(approver.id, approver.subject, approver.email, ONBOARDING) !== undefined;
}

function approve(db, approver, commandId) {
  const resultJson = JSON.stringify({ contractVersion: 1, capability: 'staff.onboarding.approve', targetOnboardingId: ONBOARDING,
    proposedStaffId: PROPOSED, proposalSha256: sha(PROPOSAL), claimEvidenceSha256: 'b'.repeat(64),
    claimedAccessSubject: 'access|new-staff', proposal: JSON.parse(PROPOSAL), resultVersion: 3 });
  const resultSha = sha(resultJson), requestSha = sha(`request:${commandId}`);
  const join = `FROM native_staff_pending_onboarding p JOIN native_staff_management_fences f
    ON f.command_id=? AND f.target_onboarding_id=p.onboarding_id AND f.target_proposed_staff_id=p.proposed_staff_id
    WHERE p.state='claimed' AND p.version=2`;
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO native_staff_management_fences(target_kind,target_onboarding_id,target_proposed_staff_id,
      command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
      expected_version,result_version,reason,display_name,result_json,result_sha256,mutation_writes)
      VALUES('onboarding',?,?,?,?,1,'staff.onboarding.approve',?,?,NULL,2,3,?,NULL,?,?,1)`)
      .run(ONBOARDING, PROPOSED, commandId, requestSha, approver.id, approver.subject, 'Synthetic approval', resultJson, resultSha);
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,project_alpha_user_id,status,provisioning_source,sync_protected)
      SELECT p.proposed_staff_id,p.login_email,p.display_name,p.claimed_access_subject,NULL,'active','local',1 ${join}`).run(commandId);
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      SELECT p.proposed_staff_id,p.claimed_access_subject,1,f.actor_staff_id ${join}`).run(commandId);
    db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      SELECT p.proposed_staff_id,p.login_email,p.display_name ${join}`).run(commandId);
    db.prepare('UPDATE native_staff_management_fences SET mutation_writes=0 WHERE command_id=? AND mutation_writes=1').run(commandId);
    db.prepare(`INSERT INTO native_staff_management_commands(target_kind,target_onboarding_id,target_proposed_staff_id,
      command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
      expected_version,result_version,reason,display_name,result_json,result_sha256)
      VALUES('onboarding',?,?,?,?,1,'staff.onboarding.approve',?,?,NULL,2,3,?,NULL,?,?)`)
      .run(ONBOARDING, PROPOSED, commandId, requestSha, approver.id, approver.subject, 'Synthetic approval', resultJson, resultSha);
    db.exec('COMMIT');
    return 'approved';
  } catch (error) { db.exec('ROLLBACK'); return error.message; }
}

// ---------------------------------------------------------------------------

test('pins the same production target as the reviewed 0227..0244 one-shot', () => {
  assert.deepEqual({ ...APPROVER_GRANT_TARGET }, { ...OPS_PRODUCTION_DATABASE });
  assert.equal(APPROVER_GRANT_TARGET.databaseId, '6ebf7514-d306-4615-ae56-ad869c874dbd');
  assert.equal(APPROVER_GRANT_TARGET.databaseName, 'ltds-ops');
});

test('execute installs exactly one global allow row and makes a synthetic onboarding approval pass 0242 and APPROVAL_SCOPE', async () => {
  const db = freshDb();
  const owner = person(db, OWNER);
  claimedOnboarding(db);
  assert.equal(reviewVisible(db, owner), false);
  assert.equal(approve(db, owner, '60000000-0000-4000-8000-000000000001'), 'onboarding approval requires current global allow authority');
  const before = counts(db);
  const cloudflare = syntheticCloudflare(db), { phrases, value } = deps(cloudflare);
  const receipt = receiptPath();
  const result = await mainApproverGrant(executeArgs(receipt), value);
  assert.equal(result.status, 'complete', JSON.stringify(result.stop));
  assert.equal(result.writesPerformed, 1);
  assert.deepEqual(phrases, [`GRANT staff.onboarding.approve TO ${OWNER} ON ltds-ops`]);
  assert.equal(phrases[0], APPROVER_GRANT_CONFIRMATION(OWNER, 'ltds-ops'));
  assert.deepEqual(cloudflare.calls.map(call => call.kind), ['metadata', 'read', 'read', 'write', 'read']);
  const row = db.prepare(`SELECT id,actor_staff_id,contract_version,authority_domain,capability,effect,scope_kind,business_area_id,
    division_id,target_staff_id,active,version,granted_by FROM native_staff_management_delegations WHERE actor_staff_id=?`).all(OWNER);
  assert.deepEqual(row.map(item => ({ ...item })), [{ ...expectedApproverGrantRow(OWNER) }]);
  assert.equal(row[0].id, approverGrantDelegationId(OWNER));
  assert.deepEqual(counts(db), { ...before, native_staff_management_delegations: before.native_staff_management_delegations + 1 });
  assert.equal(db.prepare(`SELECT count(*) n FROM native_staff_management_delegations WHERE capability='staff.onboarding.approve'
    AND effect='allow' AND scope_kind='global' AND active=1 AND contract_version=1`).get().n, 1);
  // The grant now satisfies the review query and the 0242 fence and receipt triggers.
  assert.equal(reviewVisible(db, owner), true);
  assert.equal(approve(db, owner, '60000000-0000-4000-8000-000000000002'), 'approved');
  assert.deepEqual({ ...db.prepare('SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?').get(ONBOARDING) },
    { state: 'approved', version: 3 });
  const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(saved.status, 'complete');
  assert.equal(saved.approvalRef, 'hub-task-123');
  assert.equal(saved.sourceCommit, SOURCE);
  assert.equal(saved.postRead.classification, 'granted-exactly');
  const text = fs.readFileSync(receipt, 'utf8');
  assert.ok(!text.includes(TOKEN) && !text.includes('@') && !text.includes('access|'), 'receipt holds no token, email or access subject');
});

test('dry run reads, passes and writes nothing', async () => {
  const db = freshDb();
  person(db, OWNER);
  const before = counts(db), cloudflare = syntheticCloudflare(db), { phrases, value } = deps(cloudflare);
  const result = await mainApproverGrant(args(null), value);
  assert.equal(result.status, 'dry-run-passed');
  assert.equal(result.writesPerformed, 0);
  assert.deepEqual(phrases, []);
  assert.deepEqual(cloudflare.calls.map(call => call.kind), ['metadata', 'read']);
  assert.deepEqual(counts(db), before);
});

for (const [name, setup, code] of [
  ['a non-owner', db => person(db, OWNER, { role: 'role-operator' }), 'target_staff_not_owner'],
  ['an inactive staff user', db => person(db, OWNER, { status: 'inactive' }), 'target_staff_inactive'],
  ['a missing staff user', () => {}, 'target_staff_missing'],
  ['a staff user with no native admission', db => person(db, OWNER, { admitted: false }), 'target_native_admission_not_active'],
  ['an existing deny row', db => { person(db, OWNER); db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES('deny-row',?,'staff.onboarding.approve','deny','global',?)`).run(OWNER, OWNER); },
  'target_has_deny_row'],
  ['an existing allow row', db => { person(db, OWNER); db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,active,granted_by) VALUES('allow-row',?,'staff.onboarding.approve','allow','global',0,?)`).run(OWNER, OWNER); },
  'target_already_has_allow_row'],
  ['another global approver', db => { person(db, OWNER); person(db, 'staff-synthetic-other'); db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES('other-row',?,'staff.onboarding.approve','allow','global',?)`).run('staff-synthetic-other', 'staff-synthetic-other'); },
  'global_approver_count_not_zero:1'],
]) {
  test(`refuses ${name} in dry run and execute, with no write`, async () => {
    const db = freshDb();
    setup(db);
    const before = counts(db);
    for (const mode of [null, 'execute']) {
      const cloudflare = syntheticCloudflare(db), { phrases, value } = deps(cloudflare);
      const result = await mainApproverGrant(mode ? executeArgs(receiptPath()) : args(null), value);
      assert.equal(result.status, 'refused');
      assert.ok(result.stop.refusals.includes(code), JSON.stringify(result.stop));
      assert.deepEqual(phrases, []);
      assert.ok(!cloudflare.calls.some(call => call.kind === 'write'));
    }
    assert.deepEqual(counts(db), before);
  });
}

test('refuses a database id other than the pinned production id, and a wrong database name', () => {
  assert.throws(() => parseApproverGrantArgs(['--target-staff-id', OWNER, '--database-id', '7f40a7b7-c3ec-470e-a626-e798867f71f8',
    '--database-name', 'ltds-ops']), /database_id_not_pinned_production/u);
  assert.throws(() => parseApproverGrantArgs(['--target-staff-id', OWNER, '--database-id', APPROVER_GRANT_TARGET.databaseId,
    '--database-name', 'ltds-ops-staging']), /database_name_mismatch/u);
  assert.throws(() => parseApproverGrantArgs(['--database-id', APPROVER_GRANT_TARGET.databaseId, '--database-name', 'ltds-ops']),
    /target_staff_id_required/u);
});

test('refuses when the D1 metadata does not name the pinned database', async () => {
  const db = freshDb();
  person(db, OWNER);
  const cloudflare = syntheticCloudflare(db, { name: 'some-other-db' }), { value } = deps(cloudflare);
  const result = await mainApproverGrant(args(null), value);
  assert.equal(result.status, 'refused');
  assert.equal(result.stop.code, 'ops_approver_grant_provider:target_mismatch');
  assert.deepEqual(cloudflare.calls.map(call => call.kind), ['metadata']);
});

test('execute needs an approval ref and a receipt', () => {
  assert.throws(() => parseApproverGrantArgs(args('execute', ['--receipt', receiptPath()])), /approval_ref_required/u);
  assert.throws(() => parseApproverGrantArgs(args('execute', ['--approval-ref', 'hub-task-123'])), /receipt_required/u);
  assert.throws(() => parseApproverGrantArgs(args(null, ['--approval-ref', 'hub-task-123'])), /approval_ref_invalid/u);
});

test('execute without an interactive terminal is refused before any request', async () => {
  const db = freshDb();
  person(db, OWNER);
  const before = counts(db), cloudflare = syntheticCloudflare(db);
  const { value } = deps(cloudflare);
  delete value.confirm;
  const receipt = receiptPath();
  const result = await mainApproverGrant(executeArgs(receipt), { ...value, stdin: { isTTY: false }, stdout: { isTTY: true } });
  assert.equal(result.status, 'refused');
  assert.equal(result.stop.code, 'ops_approver_grant:interactive_confirmation_required');
  assert.deepEqual(cloudflare.calls, []);
  assert.deepEqual(counts(db), before);
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).status, 'refused');
});

test('a declined confirmation or a failed source check writes nothing', async () => {
  const db = freshDb();
  person(db, OWNER);
  const before = counts(db);
  const declined = await mainApproverGrant(executeArgs(receiptPath()), { ...deps(syntheticCloudflare(db)).value, confirm: async () => false });
  assert.equal(declined.status, 'cancelled');
  const stale = await mainApproverGrant(executeArgs(receiptPath()), { ...deps(syntheticCloudflare(db)).value,
    sourceCheck: () => { throw new Error('production_ops_0226_runner_main_branch_stale'); } });
  assert.equal(stale.status, 'refused');
  assert.equal(stale.stop.code, 'ops_approver_grant:source_check_failed:production_ops_0226_runner_main_branch_stale');
  assert.deepEqual(counts(db), before);
});

test('an existing receipt file is never replaced', async () => {
  const db = freshDb();
  person(db, OWNER);
  const receipt = receiptPath();
  fs.writeFileSync(receipt, 'earlier');
  await assert.rejects(mainApproverGrant(executeArgs(receipt), deps(syntheticCloudflare(db)).value), /receipt_exists_no_replay/u);
  assert.equal(fs.readFileSync(receipt, 'utf8'), 'earlier');
});

test('an ambiguous write is never retried and is reconciled read-only', async () => {
  const db = freshDb();
  person(db, OWNER);
  const cloudflare = syntheticCloudflare(db, { failAfterInsert: true });
  const result = await mainApproverGrant(executeArgs(receiptPath()), deps(cloudflare).value);
  assert.equal(result.status, 'reconciliation-required');
  assert.equal(result.write.outcome, 'ambiguous');
  assert.equal(result.reconcile, 'granted-exactly');
  assert.equal(cloudflare.calls.filter(call => call.kind === 'write').length, 1);
  const reconciled = await mainApproverGrant(args('reconcile'), deps(syntheticCloudflare(db)).value);
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(reconciled.reconcile, 'granted-exactly');
});

test('the write guard inserts nothing if a precondition changed after the last read', () => {
  const db = freshDb();
  person(db, OWNER);
  db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").run(OWNER);
  const run = db.prepare(APPROVER_GRANT_INSERT_SQL).run(OWNER, approverGrantDelegationId(OWNER));
  assert.equal(Number(run.changes), 0);
});

test('an HTTP failure answering the write is ambiguous, never refused', async () => {
  const db = freshDb();
  person(db, OWNER);
  const cloudflare = syntheticCloudflare(db, { httpFailWrite: true });
  const result = await mainApproverGrant(executeArgs(receiptPath()), deps(cloudflare).value);
  assert.equal(result.status, 'reconciliation-required');
  assert.equal(result.writesPerformed, null);
  assert.equal(result.reconcile, 'granted-exactly');
  assert.equal(cloudflare.calls.filter(call => call.kind === 'write').length, 1);
});

test('a failed read-back after an acknowledged write needs reconciliation and keeps writesPerformed 1', async () => {
  const db = freshDb();
  person(db, OWNER);
  const result = await mainApproverGrant(executeArgs(receiptPath()), deps(syntheticCloudflare(db, { failReadAfterWrite: true })).value);
  assert.equal(result.status, 'reconciliation-required');
  assert.equal(result.writesPerformed, 1);
});

test('a guard refusal (changes 0) from the provider is refused and reconciled read-only', async () => {
  const db = freshDb();
  person(db, OWNER);
  const cloudflare = syntheticCloudflare(db);
  const value = { ...deps(cloudflare).value, confirm: async () => {
    db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").run(OWNER); return true; } };
  // The post-confirmation read sees the change, so force the guard path with a provider that skips that read.
  const { createApproverGrantCloudflareProvider } = await import('./production-ops-onboarding-approver-grant-cloudflare-provider.mjs');
  let reads = 0;
  value.providerFactory = config => {
    const real = createApproverGrantCloudflareProvider(config);
    return { ...real, read: async input => { const row = await real.read(input);
      return ++reads === 2 ? { ...row, staff_active: 1, native_identity_consistent: 1 } : row; } };
  };
  const result = await mainApproverGrant(executeArgs(receiptPath()), value);
  assert.equal(result.status, 'refused');
  assert.equal(result.write.outcome, 'guard-refused');
  assert.equal(result.reconcile, 'not-granted');
  assert.equal(db.prepare('SELECT count(*) n FROM native_staff_management_delegations WHERE actor_staff_id=?').get(OWNER).n, 0);
});

test('refuses an active existing allow row', async () => {
  const db = freshDb();
  person(db, OWNER);
  db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by)
    VALUES('allow-active',?,'staff.onboarding.approve','allow','global',?)`).run(OWNER, OWNER);
  const result = await mainApproverGrant(args(null), deps(syntheticCloudflare(db)).value);
  assert.equal(result.status, 'refused');
  assert.ok(result.stop.refusals.includes('target_already_has_allow_row'));
});
