// Focused synthetic control-flow/request regressions. No SQLite, Miniflare, JWT keys or provider transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  STAGE_PINS, STAGE_OWNER_ADOPTION_TARGET_STAFF_ID as TARGET,
  assertStageOwnerAdoptionPinsProvisioned, readStageOwnerAdoptionSourceMigrations,
  readStageOwnerAdoptionSnapshot, buildStageOwnerAdoptionPlan,
  stageOwnerAdoptionConsentEnvelope, prepareStageOwnerAdoption, executeStageOwnerAdoption,
} from './stage-owner-native-adoption.mjs';

const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v === null || typeof v !== 'object' ? JSON.stringify(v)
    : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const sha = s => createHash('sha256').update(s).digest('hex');
const target = {accountId:STAGE_PINS.accountId,databaseId:STAGE_PINS.databaseId};
const T = Date.parse('2035-01-01T00:00:00.000Z');
const iso = n => new Date(n).toISOString();
const row = {id:TARGET,email:'owner@example.test',display_name:'Synthetic Owner',access_subject:'access|synthetic',status:'active'};
const claims = {staffId:TARGET,email:row.email,accessSubject:row.access_subject,verifiedUntil:iso(T+60_000)};
const columns = Object.fromEntries(['staff_users','staff_divisions','permissions','roles','role_permissions','staff_role_assignments','staff_permission_overrides','local_staff_role_assignments'].map(n => [n,n==='staff_users'?[...Object.keys(row),'last_seen_at']:['id']]));
Object.assign(columns,{native_staff_admissions:['staff_id','bound_access_subject','active','admitted_by'],native_staff_profiles:['staff_id','login_email','display_name','version'],native_staff_bootstrap_approvals:['approval_id'],native_staff_bootstrap_receipts:['command_id']});
const ledger = readStageOwnerAdoptionSourceMigrations().names;

class FakeDb {
  ownerReads=0; lateOwner={...row}; afterCapture=()=>{}; afterProbe=()=>{};
  prepare(sql) {
    const db=this;
    return {sql,params:[],bind(...params){this.params=params;return this;},async all(){
      if(sql.includes('JOIN pragma_table_info')) return {success:true,results:Object.entries(columns).flatMap(([table_name,cs])=>cs.map(column_name=>({table_name,column_name})))};
      if(sql.startsWith('SELECT name FROM sqlite_schema')) return {success:true,results:Object.keys(columns).map(name=>({name}))};
      if(sql.startsWith('SELECT count(*) AS n')) return {success:true,results:[{n:1}]};
      throw Error('unexpected mock all');
    },async first(){
      if(sql.startsWith('SELECT id,email')){db.ownerReads++;return db.lateOwner;}
      if(sql.includes('AS admissions')){db.conflictParams=this.params;return {admissions:0,profiles:0};}
      throw Error('unexpected mock first');
    }};
  }
  async batch(statements) {
    if(statements[0].sql.startsWith('SELECT CASE WHEN')){
      await this.afterProbe();return statements.map(()=>({success:true,results:[{verified:1}]}));
    }
    const result=statements.map(({sql})=>{
      const value=sql.includes('FROM d1_migrations')?JSON.stringify(ledger)
        :sql.includes('json_array(count(*))')?'[1]'
          :sql.includes('LIMIT 20 OFFSET')?'[]'
            :JSON.stringify(Object.fromEntries(Object.keys(columns).map(n=>[n,n==='staff_users'?[{...row}]:[]])));
      return {success:true,results:[{value}]};
    });
    await this.afterCapture();return result;
  }
}
async function fixture() {
  const db=new FakeDb();const snapshot=await readStageOwnerAdoptionSnapshot(db,target);
  const approval={approvalId:'synthetic-approval',issuedAt:iso(T-1000),expiresAt:iso(T+120_000)},commandId='synthetic-command';
  const canonicalPlanJson=buildStageOwnerAdoptionPlan(snapshot,{approvalId:approval.approvalId,commandId});
  return {db,snapshot,input:{target:{...target},reviewedSnapshot:snapshot,canonicalPlanJson,approval,commandId,ownerIdentityToken:'synthetic-token',consent:{envelope:stageOwnerAdoptionConsentEnvelope({snapshot,canonicalPlanJson,approval,commandId}),proof:'synthetic-proof'}}};
}
const verifiers={verifyOwnerIdentity:async()=>({...claims}),verifyConsent:async()=>true,now:()=>T};
function altered(snapshot,change){const value=JSON.parse(snapshot.snapshotJson);change(value);const snapshotJson=canonical(value);return {snapshotJson,snapshotSha256:sha(snapshotJson)};}

test('only immutable Stage pins are accepted; every external pins override is refused',async()=>{
  const prod={...STAGE_PINS,accountId:'846c924bf17bf4f3dd15c97a4c5d1d51'};
  assert.throws(()=>assertStageOwnerAdoptionPinsProvisioned(prod),/stage_pins_unprovisioned/);
  assert.equal(assertStageOwnerAdoptionPinsProvisioned({...STAGE_PINS}),STAGE_PINS);
  const {db,input}=await fixture();
  await assert.rejects(readStageOwnerAdoptionSnapshot(db,{...target,accountId:prod.accountId}),/target_database_mismatch/);
  await assert.rejects(readStageOwnerAdoptionSnapshot(db,target,{pins:prod}),/stage_pins_override_forbidden/);
  await assert.rejects(prepareStageOwnerAdoption(input,{...verifiers,pins:prod}),/stage_pins_override_forbidden/);
  const prepared=await prepareStageOwnerAdoption(input,verifiers);
  await assert.rejects(executeStageOwnerAdoption(db,prepared,{...verifiers,pins:prod}),/stage_pins_override_forbidden/);
});

test('owner is derived from the captured CAS state, never a later staff query',async()=>{
  const db=new FakeDb();db.afterCapture=()=>{db.lateOwner={...row,access_subject:'access|changed-after-capture'};};
  const snapshot=await readStageOwnerAdoptionSnapshot(db,target);
  assert.equal(snapshot.owner.accessSubject,row.access_subject);assert.equal(db.ownerReads,0);
  assert.deepEqual(db.conflictParams,[TARGET,row.access_subject,row.email]);
});

test('hash-consistent production or mixed-owner snapshots fail build/consent/prepare',async()=>{
  const {snapshot,input}=await fixture();
  for(const mutate of [v=>{v.accountId='846c924bf17bf4f3dd15c97a4c5d1d51';},v=>{v.owner.staffId='staff-other';},v=>{v.owner.email='different@example.test';}]){
    const forged=altered(snapshot,mutate);
    assert.throws(()=>buildStageOwnerAdoptionPlan(forged,{approvalId:input.approval.approvalId,commandId:input.commandId}),/stage_pins_unprovisioned|snapshot_owner_mismatch/);
    assert.throws(()=>stageOwnerAdoptionConsentEnvelope({snapshot:forged,canonicalPlanJson:input.canonicalPlanJson,approval:input.approval,commandId:input.commandId}),/stage_pins_unprovisioned|snapshot_owner_mismatch/);
    await assert.rejects(prepareStageOwnerAdoption({...input,reviewedSnapshot:forged},verifiers),/stage_pins_unprovisioned|snapshot_owner_mismatch/);
  }
});

test('trusted JWT expiry is required, well-formed and still live',async()=>{
  const {input}=await fixture();
  const {verifiedUntil,...withoutExpiry}=claims;
  await assert.rejects(prepareStageOwnerAdoption(input,{...verifiers,verifyOwnerIdentity:async()=>withoutExpiry}),/owner_identity_mismatch/);
  for(const [value,error]of [[undefined,/owner_identity_expiry_invalid/],['not-an-expiry',/owner_identity_expiry_invalid/],[iso(T),/owner_identity_expired/]]){
    await assert.rejects(prepareStageOwnerAdoption(input,{...verifiers,verifyOwnerIdentity:async()=>({...claims,verifiedUntil:value})}),error);
  }
});

test('changed actor identity after asynchronous probes prevents submission',async()=>{
  const {db,input}=await fixture();const prepared=await prepareStageOwnerAdoption(input,verifiers);let current={...claims},submissions=0;
  db.afterProbe=()=>{current={...claims,accessSubject:'access|different-owner'};};
  await assert.rejects(executeStageOwnerAdoption(db,prepared,{...verifiers,ownerIdentityToken:'fresh-synthetic-token',verifyOwnerIdentity:async()=>current,submitBatch:async()=>{submissions++;return [];}}),/owner_identity_mismatch/);
  assert.equal(submissions,0);
});

test('approval window closing during asynchronous probes prevents submission',async()=>{
  const {db,input}=await fixture();let clock=T,submissions=0;
  const identity=async()=>({...claims,verifiedUntil:iso(T+180_000)});
  const prepared=await prepareStageOwnerAdoption(input,{...verifiers,verifyOwnerIdentity:identity});
  db.afterProbe=()=>{clock=T+120_000;};
  await assert.rejects(executeStageOwnerAdoption(db,prepared,{...verifiers,ownerIdentityToken:'fresh-synthetic-token',verifyOwnerIdentity:identity,now:()=>clock,submitBatch:async()=>{submissions++;return [];}}),/approval_expired_or_not_yet_valid/);
  assert.equal(submissions,0);
});

test('JWT expiry during consent cannot be extended by mutating the returned claims object',async()=>{
  const {input}=await fixture();let clock=T;const returned={...claims};
  await assert.rejects(prepareStageOwnerAdoption(input,{...verifiers,now:()=>clock,verifyOwnerIdentity:async()=>returned,verifyConsent:async()=>{returned.verifiedUntil=iso(T+86400_000);clock=T+60_000;return true;}}),/owner_identity_expired/);
});

test('expiry after asynchronous CAS probes prevents any submission',async()=>{
  const {db,input}=await fixture();const prepared=await prepareStageOwnerAdoption(input,verifiers);let clock=T,submissions=0;
  db.afterProbe=()=>{clock=T+60_000;};
  await assert.rejects(executeStageOwnerAdoption(db,prepared,{...verifiers,ownerIdentityToken:'fresh-synthetic-token',now:()=>clock,submitBatch:async()=>{submissions++;return [];}}),/owner_identity_expired/);
  assert.equal(submissions,0);
});

test('consent revocation after asynchronous probes is rechecked before submission',async()=>{
  const {db,input}=await fixture();const prepared=await prepareStageOwnerAdoption(input,verifiers);let trusted=true,submissions=0;
  db.afterProbe=()=>{trusted=false;};
  await assert.rejects(executeStageOwnerAdoption(db,prepared,{...verifiers,ownerIdentityToken:'fresh-synthetic-token',verifyConsent:async()=>trusted,submitBatch:async()=>{submissions++;return [];}}),/consent_untrusted/);
  assert.equal(submissions,0);
});

test('one compiled atomic request gates every write and final receipt on fresh JWT and approval expiry',async()=>{
  const {db,input}=await fixture();const prepared=await prepareStageOwnerAdoption(input,verifiers);let submissions=0,captured;
  assert.ok(!JSON.stringify(prepared).includes('synthetic-token'));
  await assert.rejects(executeStageOwnerAdoption(db,prepared,{...verifiers,ownerIdentityToken:'fresh-synthetic-token',submitBatch:async(request,t)=>{assert.deepEqual(t,target);submissions++;captured=request;throw Error('synthetic transport stop');}}),/atomic_batch_refused/);
  assert.equal(submissions,1);assert.ok(!JSON.stringify(captured).includes('synthetic-token'));
  const writes=captured.batch.filter(s=>s.sql.startsWith('INSERT INTO'));
  assert.equal(writes.length,4);
  for(const statement of writes){
    assert.ok(statement.params.includes(claims.verifiedUntil));assert.ok(statement.params.includes(input.approval.expiresAt));
    assert.equal((statement.sql.match(/\?/g)||[]).length,statement.params.length);
  }
  assert.ok(writes.at(-1).sql.includes('THEN ? ELSE NULL'));assert.equal(writes.at(-1).params[2],claims.verifiedUntil);
});
