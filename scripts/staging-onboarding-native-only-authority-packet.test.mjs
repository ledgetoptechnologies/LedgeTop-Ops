import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {STAGING_TARGET,nativeOnlyGrantIds,nativeClientCreationGrantIds,compileNativeOnlyAuthorityPacket,applyNativeOnlyAuthorityPacket} from './staging-onboarding-native-only-authority-packet.mjs';

const root=path.resolve(import.meta.dirname,'..');
const requireOperations=createRequire(path.join(root,'apps/operations/package.json'));
const {Miniflare}=requireOperations('miniflare');
const {unstable_splitSqlQuery}=requireOperations('wrangler');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const first=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const apply=(db,packet)=>applyNativeOnlyAuthorityPacket(db,packet,{target:STAGING_TARGET});
let counter=0;
async function fixture(db,{clientCreation=false}={}){
  const n=++counter,staff=`staging-packet-operator-${n}`,area=`staging-native-only-test-${n}`,subject=`native|test-${n}`;
  await db.prepare('INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)').bind(staff,`${staff}@example.test`,'Synthetic Operator',subject).run();
  await db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(staff,subject,staff).run();
  await db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(staff,`${staff}@example.test`,'Synthetic Operator').run();
  await db.prepare('INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)').bind(area,'Reviewed Synthetic Area').run();
  await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
    VALUES(?,?,'directory.profile.view','allow','global',1,?)`).bind(`existing-view-${n}`,staff,staff).run();
  const now=await first(db,"SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp");
  const executedAt=now.stamp;
  const values={schemaVersion:clientCreation?3:2,staging:{...STAGING_TARGET},phase:'provision',
    admission:await first(db,'SELECT * FROM native_staff_admissions WHERE staff_id=?',staff),
    profile:await first(db,'SELECT * FROM native_staff_profiles WHERE staff_id=?',staff),
    generation:await first(db,'SELECT * FROM native_directory_grant_generations WHERE staff_id=?',staff),
    businessArea:await first(db,'SELECT * FROM native_business_areas WHERE id=?',area),
    grants:await all(db,'SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id',staff),
    history:await all(db,'SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_id,grant_version',staff),
    approval:{approvalId:id(n*10+1),commandId:id(n*10+2),revokeApprovalId:id(n*10+3),revokeCommandId:id(n*10+4),
      issuedByStaffId:staff,issuedByAccessSubject:subject,issuedAt:new Date(Date.parse(executedAt)-60_000).toISOString(),
      expiresAt:new Date(Date.parse(executedAt)+3600_000).toISOString(),executedAt,
      grantIds:(clientCreation?nativeClientCreationGrantIds:nativeOnlyGrantIds)(staff,area,id(n*10+1))},priorProvision:null};
  return values;
}
async function snapshot(db,values){
  const staff=values.admission.staff_id;
  return {
    admission:await first(db,'SELECT * FROM native_staff_admissions WHERE staff_id=?',staff),
    profile:await first(db,'SELECT * FROM native_staff_profiles WHERE staff_id=?',staff),
    generation:await first(db,'SELECT * FROM native_directory_grant_generations WHERE staff_id=?',staff),
    grants:await all(db,'SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id',staff),
    history:await all(db,'SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_id,grant_version',staff),
    approvals:await all(db,'SELECT * FROM native_staff_bootstrap_approvals WHERE approved_operator_staff_id=? ORDER BY approval_id',staff),
    receipts:await all(db,'SELECT * FROM native_staff_bootstrap_receipts WHERE operator_staff_id=? ORDER BY command_id',staff),
  };
}
async function revokeValues(db,values){
  const current=await snapshot(db,values);
  const now=(await first(db,"SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp")).stamp;
  return {...structuredClone(values),phase:'revoke',admission:current.admission,profile:current.profile,generation:current.generation,
    grants:current.grants,history:current.history,
    approval:{...values.approval,issuedAt:new Date(Date.parse(now)-60_000).toISOString(),expiresAt:new Date(Date.parse(now)+3600_000).toISOString(),executedAt:now},
    priorProvision:{approval:await first(db,'SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?',values.approval.approvalId),
      receipt:await first(db,'SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?',values.approval.commandId)}};
}

async function seedProjectOutbox(db,values,state){
  const n=(++counter)*10+800000,commandId=id(n+1),externalProjectId=`packet-project-${n}`;
  const applicationId=id(n+2),sourceInstanceId=id(n+3),historyEpochId=id(n+4),staff=values.admission.staff_id;
  await db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,
    expected_source_instance_id,expected_history_epoch_id) VALUES(?,'project-alpha:primary',?,'https://alpha.example.test',?,?)`)
    .bind(externalProjectId,applicationId,sourceInstanceId,historyEpochId).run();
  await db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,external_project_id,granted_by)
    VALUES(?,?,'project.shared.sync','allow','exact_project',?,?)`)
    .bind(`packet-project-grant-${n}`,staff,externalProjectId,staff).run();
  const generation=await first(db,'SELECT generation FROM native_project_grant_generations WHERE staff_id=?',staff);
  await db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,
    actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
    VALUES(?,?,?,?,?,?,?,'2999-01-01T00:00:00.000Z',?,'[]')`)
    .bind(commandId,externalProjectId,staff,values.admission.bound_access_subject,values.admission.version,values.profile.version,
      values.profile.login_email,generation.generation).run();
  const commandJson=JSON.stringify({commandId,externalId:externalProjectId,expectedAuthorizationGeneration:'0',project:{},organization:{},client:null});
  const leased=state==='leased';
  await db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,
    application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,
    lease_token,lease_expires_at,expected_history_epoch_id) VALUES(?,?,'create',?,'project-alpha:primary',?,
    'https://alpha.example.test',?,?,?,0,0,?,?,?)`)
    .bind(commandId,externalProjectId,commandJson,applicationId,sourceInstanceId,JSON.stringify({actorId:staff}),state,
      leased?`lease-${n}`:null,leased?Date.now()+60_000:null,historyEpochId).run();
  return commandId;
}

async function seedDirectoryOutbox(db,values,state){
  const n=(++counter)*10+900000,commandId=id(n+1),leased=state==='leased',staff=values.admission.staff_id;
  await db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,
    command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,
    lease_token,lease_expires_at,expected_history_epoch_id)
    VALUES(?,'project-alpha:primary',?,'client',?,'{}','https://alpha.example.test',?,?,?,0,0,?,?,?)`)
    .bind(commandId,id(n+2),`packet-client-${n}`,id(n+3),JSON.stringify({actorId:staff}),state,
      leased?`lease-${n}`:null,leased?Date.now()+60_000:null,id(n+4)).run();
  return commandId;
}

test('guarded native-only packet against the complete current 183-migration schema',async t=>{
  const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",
    d1Databases:{DB:`${id(900)}-${crypto.randomUUID()}`},d1Persist:"./.tmp-checks/staging-native-only-authority"});
  try {
    const db=await mf.getD1Database('DB');
    const files=fs.readdirSync(path.join(root,'apps/operations/migrations')).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
    assert.equal(files.length,183);
    await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run();
    for(const name of files){
      const sql=fs.readFileSync(path.join(root,'apps/operations/migrations',name),'utf8').replace(/\r\n/g,'\n');
      const parts=unstable_splitSqlQuery(sql).map(part=>part.trim()).filter(part=>part&&!/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(part));
      await db.batch([...parts.map(part=>db.prepare(part)),db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
    }
    await t.test('native-only compiler rejects a missing, extra, renamed, or modified 0183 migration', async t => {
      const values=await fixture(db);
      const source=path.join(root,'apps','operations','migrations');
      const migrationName='0183_project_alpha_binding_standalone_relationship_rows.sql';
      const cases=[
        ['missing',directory=>fs.rmSync(path.join(directory,migrationName))],
        ['extra',directory=>fs.writeFileSync(path.join(directory,'0184_unreviewed.sql'),'SELECT 1;\n')],
        ['renamed',directory=>fs.renameSync(path.join(directory,migrationName),path.join(directory,'0183_wrong_name.sql'))],
        ['modified',directory=>fs.appendFileSync(path.join(directory,migrationName),'-- drift\n')],
      ];
      for(const [label,mutate] of cases) await t.test(label,()=>{
        const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-native-only-chain-'));
        const directory=path.join(tempRoot,'apps','operations','migrations');
        try{
          fs.mkdirSync(directory,{recursive:true});
          fs.cpSync(source,directory,{recursive:true});
          mutate(directory);
          assert.throws(()=>compileNativeOnlyAuthorityPacket(values,{root:tempRoot}),/exact reviewed migration names and contents required/);
        }finally{fs.rmSync(tempRoot,{recursive:true,force:true});}
      });
    });
    await t.test('provision, exact replay and paired revoke preserve prior owner access and histories',async()=>{
      const values=await fixture(db),before=await snapshot(db,values),packet=compileNativeOnlyAuthorityPacket(values);
      assert.deepEqual(await apply(db,packet),{replayed:false});
      assert.deepEqual(await apply(db,packet),{replayed:true});
      const after=await snapshot(db,values);
      assert.deepEqual(after.admission,before.admission); assert.deepEqual(after.profile,before.profile);
      assert.equal(after.generation.generation,before.generation.generation+2); assert.equal(after.grants.length,before.grants.length+2);
      assert.deepEqual(after.grants.filter(row=>!values.approval.grantIds.includes(row.id)),before.grants);
      assert.deepEqual(after.history.filter(row=>row.grant_generation<=before.generation.generation),before.history);
      assert.deepEqual(after.receipts,[packet.receipt]);
      const revoke=compileNativeOnlyAuthorityPacket(await revokeValues(db,values));
      assert.deepEqual(await apply(db,revoke),{replayed:false}); assert.deepEqual(await apply(db,revoke),{replayed:true});
      const revoked=await snapshot(db,values);
      assert.deepEqual(revoked.admission,before.admission); assert.deepEqual(revoked.profile,before.profile);
      assert.deepEqual(revoked.grants.filter(row=>!values.approval.grantIds.includes(row.id)),before.grants);
      assert.ok(revoked.grants.filter(row=>values.approval.grantIds.includes(row.id)).every(row=>row.active===0));
      assert.equal(revoked.generation.generation,before.generation.generation+4);
      assert.deepEqual(await apply(db,packet),{replayed:true});
      assert.deepEqual(await snapshot(db,values),revoked,'provision replay cannot restore revoked authority');
    });
    await t.test('v3 client-creation packet provisions exactly three grants, replays, and revokes as one pair',async()=>{
      const values=await fixture(db,{clientCreation:true}),before=await snapshot(db,values);
      const packet=compileNativeOnlyAuthorityPacket(values);
      assert.equal(packet.schemaVersion,3);
      assert.deepEqual(await apply(db,packet),{replayed:false});
      assert.deepEqual(await apply(db,packet),{replayed:true});
      const after=await snapshot(db,values);
      assert.deepEqual(after.admission,before.admission); assert.deepEqual(after.profile,before.profile);
      assert.equal(after.generation.generation,before.generation.generation+3);
      assert.equal(after.grants.length,before.grants.length+3);
      assert.deepEqual(after.grants.filter(row=>values.approval.grantIds.includes(row.id)).map(row=>row.permission).sort(),[
        'directory.enrollment.manage','directory.identity.link','directory.profile.edit']);
      assert.deepEqual(after.grants.filter(row=>!values.approval.grantIds.includes(row.id)),before.grants);
      assert.deepEqual(after.history.filter(row=>row.grant_generation<=before.generation.generation),before.history);
      assert.deepEqual(after.receipts,[packet.receipt]);
      const revoke=compileNativeOnlyAuthorityPacket(await revokeValues(db,values));
      assert.equal(revoke.schemaVersion,3);
      assert.deepEqual(await apply(db,revoke),{replayed:false});
      assert.deepEqual(await apply(db,revoke),{replayed:true});
      const revoked=await snapshot(db,values);
      assert.deepEqual(revoked.admission,before.admission); assert.deepEqual(revoked.profile,before.profile);
      assert.deepEqual(revoked.grants.filter(row=>!values.approval.grantIds.includes(row.id)),before.grants);
      assert.ok(revoked.grants.filter(row=>values.approval.grantIds.includes(row.id)).every(row=>row.active===0));
      assert.equal(revoked.generation.generation,before.generation.generation+6);
      assert.deepEqual(await apply(db,packet),{replayed:true});
      assert.deepEqual(await snapshot(db,values),revoked,'v3 provision replay cannot restore revoked authority');
    });
    await t.test('v3 rejects missing, extra, reordered, and v2 grant IDs before mutation',async()=>{
      const values=await fixture(db,{clientCreation:true}),before=await snapshot(db,values);
      for (const mutate of [
        copy=>copy.approval.grantIds.pop(),
        copy=>copy.approval.grantIds.push(id(999991)),
        copy=>copy.approval.grantIds.reverse(),
        copy=>{copy.approval.grantIds=nativeOnlyGrantIds(copy.admission.staff_id,copy.businessArea.id,copy.approval.approvalId);},
      ]) {
        const copy=structuredClone(values); mutate(copy);
        assert.throws(()=>compileNativeOnlyAuthorityPacket(copy),/grant ids|permission-bound/);
      }
      assert.deepEqual(await snapshot(db,values),before);
    });
    for (const permission of ['directory.profile.edit','directory.identity.link','directory.enrollment.manage']) {
      await t.test(`v3 rejects active ${permission} deny with exact rollback`,async()=>{
        const values=await fixture(db,{clientCreation:true}),staff=values.admission.staff_id;
        await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by)
          VALUES(?,?,?,'deny','business_area',?,1,?)`).bind(`deny-v3-${++counter}`,staff,permission,values.businessArea.id,staff).run();
        const actual=await snapshot(db,values);
        Object.assign(values,{grants:actual.grants,history:actual.history,generation:actual.generation});
        const packet=compileNativeOnlyAuthorityPacket(values),before=await snapshot(db,values);
        await assert.rejects(apply(db,packet));
        assert.deepEqual(await snapshot(db,values),before);
      });
    }
    await t.test('v3 revoke rejects target grant/history drift and leaves the drift untouched',async()=>{
      const values=await fixture(db,{clientCreation:true}),packet=compileNativeOnlyAuthorityPacket(values);
      await apply(db,packet);
      await db.prepare('UPDATE native_directory_grants SET active=0 WHERE id=?').bind(values.approval.grantIds[2]).run();
      const drifted=await snapshot(db,values);
      const attempted={...structuredClone(values),phase:'revoke',admission:drifted.admission,profile:drifted.profile,
        generation:drifted.generation,grants:drifted.grants,history:drifted.history,
        priorProvision:{approval:await first(db,'SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?',values.approval.approvalId),
          receipt:await first(db,'SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?',values.approval.commandId)}};
      assert.throws(()=>compileNativeOnlyAuthorityPacket(attempted),/exact active packet grants|required|modified since provision/);
      assert.deepEqual(await snapshot(db,values),drifted);
    });
    await t.test('v3 failure after two grant inserts rolls back approval, grants, history and generation',async()=>{
      const values=await fixture(db,{clientCreation:true}),packet=compileNativeOnlyAuthorityPacket(values);
      const thirdId=values.approval.grantIds[2],trigger=`test_packet_v3_rollback_${++counter}`;
      await db.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON native_directory_grants WHEN NEW.id='${thirdId}' BEGIN
        SELECT RAISE(ABORT,'injected before third v3 grant');
      END`).run();
      const before=await snapshot(db,values);
      try {await assert.rejects(apply(db,packet)); assert.deepEqual(await snapshot(db,values),before);}
      finally {await db.prepare(`DROP TRIGGER ${trigger}`).run();}
    });
    for(const kind of ['generation','admission-timestamp','profile-timestamp','history-timestamp','missing-grant','extra-grant','stale-subject','expired','deny-fresh-readback','active-work','migration-ledger']){
      await t.test(`rejects ${kind} with exact full rollback`,async()=>{
        const values=await fixture(db),staff=values.admission.staff_id;
        let packet=compileNativeOnlyAuthorityPacket(values);
        if(kind==='generation'){values.generation.updated_at='2020-01-01T00:00:00.000Z'; packet=compileNativeOnlyAuthorityPacket(values);}
        if(kind==='admission-timestamp'){values.admission.updated_at='2020-01-01T00:00:00.000Z'; packet=compileNativeOnlyAuthorityPacket(values);}
        if(kind==='profile-timestamp'){values.profile.updated_at='2020-01-01T00:00:00.000Z'; packet=compileNativeOnlyAuthorityPacket(values);}
        if(kind==='history-timestamp'){values.history[0].recorded_at='2020-01-01T00:00:00.000Z'; packet=compileNativeOnlyAuthorityPacket(values);}
        if(kind==='missing-grant'){values.grants=[]; values.history=[]; packet=compileNativeOnlyAuthorityPacket(values);}
        if(kind==='extra-grant')await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
          VALUES(?,?,'directory.portal_access.manage','allow','global',1,?)`).bind(`extra-${staff}`,staff,staff).run();
        if(kind==='stale-subject'){values.admission.bound_access_subject='other|subject';values.approval.issuedByAccessSubject='other|subject';packet=compileNativeOnlyAuthorityPacket(values);}
        if(kind==='expired'){
          values.approval.issuedAt='2020-01-01T00:00:00.000Z'; values.approval.executedAt='2020-01-01T00:01:00.000Z';values.approval.expiresAt='2020-01-01T01:00:00.000Z';
          packet=compileNativeOnlyAuthorityPacket(values);
        }
        if(kind==='deny-fresh-readback'){
          await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by)
            VALUES(?,?,'directory.profile.edit','deny','business_area',?,1,?)`).bind(`deny-${staff}`,staff,values.businessArea.id,staff).run();
          const actual=await snapshot(db,values); Object.assign(values,{grants:actual.grants,history:actual.history,generation:actual.generation});
          packet=compileNativeOnlyAuthorityPacket(values); // No stale-read excuse: explicit deny itself blocks.
        }
        if(kind==='active-work')await db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,
          actor_admission_version,permission,record_id,record_kind,expected_version,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes)
          VALUES(?,'update',?,?,1,'directory.profile.edit',?,'client',1,?,'[]','{}','{}','[]',0)`)
          .bind(`work-${staff}`,staff,values.admission.bound_access_subject,`record-${staff}`,values.grants[0].id).run();
        if(kind==='migration-ledger')await db.prepare("INSERT INTO d1_migrations(name) VALUES('9999_unreviewed.sql')").run();
        const before=await snapshot(db,values);
        try {await assert.rejects(apply(db,packet)); assert.deepEqual(await snapshot(db,values),before);}
        finally {if(kind==='migration-ledger')await db.prepare("DELETE FROM d1_migrations WHERE name='9999_unreviewed.sql'").run();}
      });
    }
    await t.test('active management and admin fences block both actor and target staff',async()=>{
      const actor=await fixture(db),target=await fixture(db),actorPacket=compileNativeOnlyAuthorityPacket(actor),targetPacket=compileNativeOnlyAuthorityPacket(target);
      const actorBefore=await snapshot(db,actor),targetBefore=await snapshot(db,target);
      const requestHash=crypto.createHash('sha256').update('packet active-work test').digest('hex');
      const resultJson=JSON.stringify({contractVersion:1,capability:'staff.profile.edit',targetStaffId:target.admission.staff_id,
        resultVersion:target.profile.version+1,displayName:'Changed Name'});
      const resultHash=crypto.createHash('sha256').update(resultJson).digest('hex');
      await db.prepare(`INSERT INTO native_staff_management_fences(command_id,request_sha256,contract_version,capability,
        actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256)
        VALUES(?,?,1,'staff.profile.edit',?,?,?,?,?,'packet active-work test','Changed Name',?,?)`)
        .bind(`packet-management-${++counter}`,requestHash,actor.admission.staff_id,actor.admission.bound_access_subject,
          target.admission.staff_id,target.profile.version,target.profile.version+1,resultJson,resultHash).run();
      await assert.rejects(apply(db,actorPacket)); await assert.rejects(apply(db,targetPacket));
      assert.deepEqual(await snapshot(db,actor),actorBefore); assert.deepEqual(await snapshot(db,target),targetBefore);
      await db.prepare('DELETE FROM native_staff_management_fences WHERE actor_staff_id=? AND target_staff_id=?')
        .bind(actor.admission.staff_id,target.admission.staff_id).run();
      await db.prepare(`INSERT INTO native_staff_admin_command_fences(command_id,request_sha256,action,actor_staff_id,
        actor_access_subject,target_staff_id,expected_version,result_version,reason,expected_display_name)
        VALUES(?,?,'staff.profile.edit',?,?,?,?,?,'packet active-work test','Changed Name')`)
        .bind(`packet-admin-${++counter}`,requestHash,actor.admission.staff_id,actor.admission.bound_access_subject,
          target.admission.staff_id,target.profile.version,target.profile.version+1).run();
      await assert.rejects(apply(db,actorPacket)); await assert.rejects(apply(db,targetPacket));
      assert.deepEqual(await snapshot(db,actor),actorBefore); assert.deepEqual(await snapshot(db,target),targetBefore);
    });
    for(const kind of ['project','directory'])for(const state of ['pending','leased','terminal']){
      await t.test(`${kind} ${state} outbox has exact active-work state semantics`,async()=>{
        const values=await fixture(db),packet=compileNativeOnlyAuthorityPacket(values),before=await snapshot(db,values);
        const commandId=kind==='project'?await seedProjectOutbox(db,values,state):await seedDirectoryOutbox(db,values,state);
        if(state==='terminal'){
          assert.deepEqual(await apply(db,packet),{replayed:false});
          assert.equal((await first(db,`SELECT state FROM project_alpha_${kind}_outbox WHERE command_id=?`,commandId)).state,'terminal');
        } else {
          await assert.rejects(apply(db,packet)); assert.deepEqual(await snapshot(db,values),before);
        }
      });
    }
    for(const kind of ['throw-after-first-grant','postcondition-drift','grant-cas-noop']){
      await t.test(`proves atomic rollback AFTER mutation: ${kind}`,async()=>{
        const values=await fixture(db),packet=compileNativeOnlyAuthorityPacket(values),[firstId,secondId]=values.approval.grantIds;
        const trigger=`test_packet_${++counter}`;
        let body;
        if(kind==='throw-after-first-grant')body=`SELECT RAISE(ABORT,'injected after first grant');`;
        else if(kind==='grant-cas-noop')body=`SELECT RAISE(IGNORE);`;
        else body=`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by)
          VALUES('injected-${firstId}','${values.admission.staff_id}','directory.profile.view','allow','business_area','${values.businessArea.id}',1,'${values.admission.staff_id}');`;
        // The second grant is reached only after the approval, first grant,
        // first generation increment, and first history append have executed.
        await db.prepare(`CREATE TRIGGER ${trigger} ${kind==='postcondition-drift'?'AFTER':'BEFORE'} INSERT ON native_directory_grants
          WHEN NEW.id='${secondId}' BEGIN ${body} END`).run();
        const before=await snapshot(db,values);
        try {await assert.rejects(apply(db,packet));assert.deepEqual(await snapshot(db,values),before);}
        finally {await db.prepare(`DROP TRIGGER ${trigger}`).run();}
      });
    }
    await t.test('post-write active work aborts and rolls back the grant and generated history',async()=>{
      const values=await fixture(db),packet=compileNativeOnlyAuthorityPacket(values),secondId=values.approval.grantIds[1];
      const trigger=`test_packet_post_work_${++counter}`,mutationId=`post-work-${counter}`,recordId=`post-work-record-${counter}`;
      await db.prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON native_directory_grants WHEN NEW.id='${secondId}' BEGIN
        INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,
          actor_admission_version,permission,record_id,record_kind,expected_version,selected_grant_id,scopes_json,
          profile_json,command_json,destinations_json,intent_writes)
        VALUES('${mutationId}','update','${values.admission.staff_id}','${values.admission.bound_access_subject}',
          ${values.admission.version},'directory.profile.edit','${recordId}','client',1,'${values.grants[0].id}',
          '[]','{}','{}','[]',0);
      END`).run();
      const before=await snapshot(db,values);
      try {
        await assert.rejects(apply(db,packet)); assert.deepEqual(await snapshot(db,values),before);
        assert.equal(await first(db,'SELECT mutation_id FROM operations_directory_write_fences WHERE mutation_id=?',mutationId),null);
      } finally {await db.prepare(`DROP TRIGGER ${trigger}`).run();}
    });
    await t.test('refuses wrong runtime destination, altered packet, duplicate and unbound grant IDs',async()=>{
      const values=await fixture(db),packet=compileNativeOnlyAuthorityPacket(values),before=await snapshot(db,values);
      await assert.rejects(applyNativeOnlyAuthorityPacket(db,packet,{target:{...STAGING_TARGET,environment:'production'}}),/binding context/);
      const altered=structuredClone(packet);altered.statements.splice(0,1);
      await assert.rejects(apply(db,altered),/packet altered/);
      const duplicate=structuredClone(values);duplicate.grants.push({...duplicate.grants[0]}); assert.throws(()=>compileNativeOnlyAuthorityPacket(duplicate),/duplicate/);
      const wrongIds=structuredClone(values);wrongIds.approval.grantIds.reverse();assert.throws(()=>compileNativeOnlyAuthorityPacket(wrongIds),/permission-bound/);
      const wrongStage=structuredClone(values);wrongStage.staging.databaseName='client-data';assert.throws(()=>compileNativeOnlyAuthorityPacket(wrongStage),/staging identity/);
      assert.deepEqual(await snapshot(db,values),before);
    });
    await t.test('revoke rejects unrelated receipts, altered target IDs, and current grant changes',async()=>{
      const values=await fixture(db),packet=compileNativeOnlyAuthorityPacket(values);await apply(db,packet);
      const revoke=await revokeValues(db,values),before=await snapshot(db,values);
      const bad=structuredClone(revoke);bad.priorProvision.receipt.result_sha256='0'.repeat(64);
      assert.throws(()=>compileNativeOnlyAuthorityPacket(bad),/paired prior provision/);
      const ids=structuredClone(revoke);ids.approval.grantIds.reverse();assert.throws(()=>compileNativeOnlyAuthorityPacket(ids),/permission-bound/);
      const wrong=structuredClone(revoke);wrong.priorProvision.approval.revoked_at=wrong.approval.executedAt;
      assert.throws(()=>compileNativeOnlyAuthorityPacket(wrong),/paired prior provision/);
      assert.deepEqual(await snapshot(db,values),before);
      await db.prepare('UPDATE native_directory_grants SET active=0 WHERE id=?').bind(values.approval.grantIds[0]).run();
      const after=await snapshot(db,values);
      await assert.rejects(apply(db,compileNativeOnlyAuthorityPacket(revoke)));
      assert.deepEqual(await snapshot(db,values),after,'failed revoke must not touch changed grants');
    });
  } finally {await mf.dispose();}
});
