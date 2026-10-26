import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { executeNativeStaffBootstrapInstall as execute, prepareNativeStaffBootstrapInstall as prepare,
  nativeStaffBootstrapInsertColumns } from './native-staff-bootstrap-installer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const cohort = [{ staffId:'operator', email:'operator@example.invalid', accessSubject:'sub|operator', active:true }];
const admins = ['operator'], permissions = [{ staffId:'operator', permission:'client.read', effect:'allow', scope:'all' }];
const snapshot = { schemaVersion:1, migrationLedgerSha256:'a'.repeat(64), cohort, controlPlaneStaffIds:admins,
  cohortSha256:hash(JSON.stringify(cohort)), controlPlaneSha256:hash(JSON.stringify(admins)), permissionStateSha256:hash(JSON.stringify(permissions)) };
// The installer uses canonical JSON. This deliberately local synthetic plan is
// a test fixture, never an owner acceptance or a production approval.
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : !value || typeof value !== 'object' ? JSON.stringify(value)
  : `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
const digest = value => hash(stable(value));
const approval = { approvalId:'test-approval', operatorStaffId:'operator', operatorAccessSubject:'sub|operator',
  issuedByStaffId:'root-test', issuedByAccessSubject:'sub|root-test', issuedAt:'2026-10-26T00:00:00.000Z', expiresAt:'2026-10-27T00:00:00.000Z' };
const bindingEvidenceJson = stable({ kind:'test-only-binding', operatorStaffId:'operator', operatorSubject:'sub|operator' });
const makeInput = () => {
  const reviewedSnapshot = { schemaVersion:1, migrationLedgerSha256:snapshot.migrationLedgerSha256,
    cohortSha256:digest(cohort), controlPlaneSha256:digest(admins), permissionStateSha256:digest(permissions), cohort, controlPlaneStaffIds:admins };
  const plan = { kind:'operations-native-staff-bootstrap-install-v1', reviewedSnapshotSha256:digest(reviewedSnapshot), approvalId:approval.approvalId,
    rows:[] };
  const canonicalPlanJson = stable(plan);
  return { approval, canonicalPlanJson, bindingEvidenceJson, reviewedSnapshot,
    trustEnvelope:{ signature:'test-only' } };
};
const trusted = async ({ trustEnvelope }) => trustEnvelope?.signature === 'test-only';

async function actualSchemaDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,access_subject TEXT UNIQUE,project_alpha_user_id TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT 'now',updated_at TEXT NOT NULL DEFAULT 'now',last_seen_at TEXT);
    INSERT INTO staff_users(id,email,display_name,access_subject) VALUES ('operator','operator@example.invalid','Operator','sub|operator'),('root-test','root@example.invalid','Root test','sub|root-test');`);
  for (const name of ['0057_native_directory_permissions.sql','0059_native_staff_profiles.sql','0060_native_staff_bootstrap.sql'])
    db.exec(await readFile(new URL(`../apps/operations/migrations/${name}`, import.meta.url), 'utf8'));
  return db;
}
function adapter(db, current = { ...snapshot, permissions }) {
  let writes = 0;
  const keyColumn = { native_staff_bootstrap_approvals:'approval_id', native_staff_admissions:'staff_id', native_staff_profiles:'staff_id',
    native_staff_target_memberships:'id', native_staff_admin_delegations:'id', native_staff_management_delegations:'id',
    native_directory_grants:'id', native_directory_assignments:'record_id' };
  const tx = {
    async readSnapshot(){ return structuredClone(current); },
    async findBootstrapReceipt(id){ return db.prepare('SELECT command_id FROM native_staff_bootstrap_receipts WHERE approval_id=?').get(id) ?? null; },
    async findApproval(id){ return db.prepare('SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?').get(id) ?? null; },
    async findExactRow(table,row){
      if (!Object.hasOwn(nativeStaffBootstrapInsertColumns,table)) throw Error('table not allowed');
      return db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn[table]}=?`).get(row[keyColumn[table]]) ?? null;
    },
    async insertExactRow(table,row){
      if (!Object.hasOwn(nativeStaffBootstrapInsertColumns,table)) throw Error('table not allowed');
      const cols=nativeStaffBootstrapInsertColumns[table]; db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c])); writes++;
    },
    async insertBootstrapReceipt(row){
      db.prepare(`INSERT INTO native_staff_bootstrap_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.commandId,row.approvalId,row.operatorStaffId,row.operatorAccessSubject,row.canonicalPlanJson,row.canonicalPlanSha256,row.bindingEvidenceJson,row.bindingEvidenceSha256,row.resultJson,row.resultSha256); writes++;
    },
  };
  return { writes:()=>writes, withImmediateTransaction: async fn => { db.exec('BEGIN IMMEDIATE'); try { const value=await fn(tx); db.exec('COMMIT'); return value; } catch(e){ db.exec('ROLLBACK'); throw e; } } };
}

test('requires independently supplied trust and rejects boolean/role-shaped substitutes', async () => {
  await assert.rejects(prepare(makeInput()), /trust_verifier_required/);
  await assert.rejects(prepare(makeInput(), { verifyTrust:async value => value.trustEnvelope === true }), /independent_approval_missing/);
});

test('writes approval and immutable receipt in one real SQLite transaction against 0057/0059/0060 schema', async t => {
  const db=await actualSchemaDb(); t.after(()=>db.close()); const management=adapter(db);
  const prepared=await prepare(makeInput(),{verifyTrust:trusted});
  const result=await execute(prepared,management,{verifyTrust:trusted});
  assert.equal(result.insertedRows,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM native_staff_bootstrap_approvals').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM native_staff_bootstrap_receipts').get().n,1);
  assert.deepEqual(db.prepare('SELECT id,email,access_subject FROM staff_users ORDER BY id').all().map(row=>({...row})),[
    {id:'operator',email:'operator@example.invalid',access_subject:'sub|operator'}, {id:'root-test',email:'root@example.invalid',access_subject:'sub|root-test'}]);
  await assert.rejects(execute(prepared,management,{verifyTrust:trusted}), /already_consumed/);
});

test('state drift and trust revocation reject before first write; failed receipt rolls the whole batch back', async t => {
  const db=await actualSchemaDb(); t.after(()=>db.close());
  const prepared=await prepare(makeInput(),{verifyTrust:trusted});
  const changed=adapter(db,{...snapshot,permissions:[...permissions,{staffId:'operator',permission:'extra',effect:'allow',scope:'all'}]});
  await assert.rejects(execute(prepared,changed,{verifyTrust:trusted}), /state_changed/); assert.equal(changed.writes(),0);
  const revoked=adapter(db);
  await assert.rejects(execute(prepared,revoked,{verifyTrust:async()=>false}), /independent_approval_revoked/); assert.equal(revoked.writes(),0);
  const failing=adapter(db); const original=failing.withImmediateTransaction;
  failing.withImmediateTransaction=fn=>original(async tx=>{ const insert=tx.insertBootstrapReceipt; tx.insertBootstrapReceipt=async()=>{throw Error('simulated receipt fault')}; return fn(tx); });
  await assert.rejects(execute(prepared,failing,{verifyTrust:trusted}), /simulated receipt fault/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM native_staff_bootstrap_approvals').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM native_staff_bootstrap_receipts').get().n,0);
});
