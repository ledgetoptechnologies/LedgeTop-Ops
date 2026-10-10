import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 as target,compileRelationshipRecoveryAuthorityV184,applyRelationshipRecoveryAuthorityV184,reconcileRelationshipRecoveryAuthorityV184} from "./staging-relationship-generation-recovery-authority-v184.mjs";
import {STAGING_TARGET} from "./staging-onboarding-native-only-authority-packet.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),requireOperations=createRequire(path.join(root,"apps/operations/package.json"));
const {Miniflare}=requireOperations("miniflare"),{unstable_splitSqlQuery}=requireOperations("wrangler"),migrationDir=path.join(root,"apps/operations/migrations");
const migrationNames=fs.readdirSync(migrationDir).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
const all=async(db,sql,...params)=>(await db.prepare(sql).bind(...params).all()).results;
const first=(db,sql,...params)=>db.prepare(sql).bind(...params).first();
const uuid=n=>`70000000-0000-4000-8000-${String(n).padStart(12,"0")}`;

async function migrate(db){
  await db.prepare("PRAGMA foreign_keys=OFF").run();
  await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  for(const name of migrationNames){
    const statements=unstable_splitSqlQuery(fs.readFileSync(path.join(migrationDir,name),"utf8").replace(/\r\n/g,"\n")).map(sql=>sql.trim()).filter(sql=>sql&&!/^PRAGMA\s+foreign_keys\s*=\s*ON/i.test(sql));
    if(name.startsWith("0058_")){
      const guardAt=statements.findIndex(sql=>/^CREATE\s+TRIGGER\s+native_directory_enrollments_create_guard/i.test(sql));
      await db.batch(statements.slice(0,guardAt).map(sql=>db.prepare(sql)));
      await db.batch([
        db.prepare("INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,active,issued_by) VALUES('fixture-client',?,'access|owner',?,'client',json_array(json_object('businessAreaId',?,'divisionId',NULL)),json_object('name','Client'),json_array(json_object('sourceId',?,'sourceInstanceUUID',?,'applicationUUID',?,'origin','https://pa-staging.ledgetoptechnologies.com','externalCanonicalId',?)),0,?)").bind(target.staffId,target.clientRecordId,target.clientBusinessAreaId,target.sourceId,uuid(101),uuid(102),target.clientRecordId,target.staffId),
        db.prepare("INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,active,issued_by) VALUES('fixture-org',?,'access|owner',?,'organization',json_array(json_object('businessAreaId',?,'divisionId',NULL)),json_object('name','Organization'),json_array(json_object('sourceId',?,'sourceInstanceUUID',?,'applicationUUID',?,'origin','https://pa-staging.ledgetoptechnologies.com','externalCanonicalId',?)),0,?)").bind(target.staffId,target.organizationRecordId,target.organizationBusinessAreaId,target.sourceId,uuid(101),uuid(102),target.organizationRecordId,target.staffId),
        db.prepare("INSERT INTO native_directory_enrollments(record_id,destinations_json,create_admission_id) VALUES(?,json_array(json_object('sourceId',?,'sourceInstanceUUID',?,'applicationUUID',?,'historyEpoch',?,'origin','https://pa-staging.ledgetoptechnologies.com','externalCanonicalId',?)),'fixture-client')").bind(target.clientRecordId,target.sourceId,uuid(101),uuid(102),uuid(103),target.clientRecordId),
        db.prepare("INSERT INTO native_directory_enrollments(record_id,destinations_json,create_admission_id) VALUES(?,json_array(json_object('sourceId',?,'sourceInstanceUUID',?,'applicationUUID',?,'historyEpoch',?,'origin','https://pa-staging.ledgetoptechnologies.com','externalCanonicalId',?)),'fixture-org')").bind(target.organizationRecordId,target.sourceId,uuid(101),uuid(102),uuid(103),target.organizationRecordId),
      ]);
      await db.batch([...statements.slice(guardAt).map(sql=>db.prepare(sql)),db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
    }else if(name.startsWith("0081_")){
      const guardAt=statements.findIndex(sql=>/^CREATE\s+TRIGGER\s+operations_directory_client_organization_history_insert_guard/i.test(sql));
      await db.batch(statements.slice(0,guardAt).map(sql=>db.prepare(sql)));
      await db.prepare("INSERT INTO operations_directory_client_organization_history(client_record_id,relationship_version,mutation_id,previous_organization_record_id,organization_record_id,client_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version) VALUES(?,2,'fixture-mutation',NULL,?,2,1,?,'access|owner','owner@example.test',1,1)").bind(target.clientRecordId,target.organizationRecordId,target.staffId).run();
      await db.batch([...statements.slice(guardAt).map(sql=>db.prepare(sql)),db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
    }else if(name.startsWith("0133_")){
      const guardAt=statements.findIndex(sql=>/^CREATE\s+TRIGGER\s+project_alpha_directory_relationship_outbox_insert_guard/i.test(sql));
      await db.batch(statements.slice(0,guardAt).map(sql=>db.prepare(sql)));
      const organizationPublic=target.organizationPublicId,command=JSON.stringify({commandId:target.predecessorCommandId,expectedClientRevision:"7",expectedAuthorizationGeneration:target.predecessorAuthorizationGeneration,expectedCurrentOrganizationPublicId:null,organization:{externalId:target.organizationRecordId,publicId:organizationPublic,expectedRevision:"9"}});
      await db.prepare(`INSERT INTO project_alpha_directory_relationship_outbox(command_id,mutation_id,client_record_id,relationship_version,action,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,client_public_id,expected_client_revision,expected_authorization_generation,expected_current_organization_record_id,expected_current_organization_public_id,organization_record_id,organization_public_id,expected_organization_revision,command_json,request_json,state,next_attempt_at,outcome_json,created_at,updated_at) VALUES(?,'fixture-mutation',?,2,'assign',?,?,?,?, 'https://pa-staging.ledgetoptechnologies.com',?,'7',?,NULL,NULL,?,?,'9',?,json_object('body',1),'terminal',0,json_object('httpStatus',409),'2026-10-10T12:00:00.000Z','2026-10-10T12:00:00.000Z')`).bind(target.predecessorCommandId,target.clientRecordId,target.sourceId,target.sourceInstanceId,target.applicationId,target.historyEpochId,target.clientPublicId,target.predecessorAuthorizationGeneration,target.organizationRecordId,organizationPublic,command).run();
      await db.batch([...statements.slice(guardAt).map(sql=>db.prepare(sql)),db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
    }else if(name.startsWith("0135_")){
      const copyAt=statements.findIndex(sql=>/^INSERT INTO operations_directory_client_organizations_next/i.test(sql));
      await db.batch(statements.slice(0,copyAt).map(sql=>db.prepare(sql)));
      await db.prepare("INSERT INTO operations_directory_client_organizations_next(client_record_id,organization_record_id,relationship_version) VALUES(?,?,2)").bind(target.clientRecordId,target.organizationRecordId).run();
      await db.batch([...statements.slice(copyAt).map(sql=>db.prepare(sql)),db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
    }else await db.batch([...statements.map(sql=>db.prepare(sql)),db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
    if(name.startsWith("0057_"))await db.batch([
      db.prepare("UPDATE staff_users SET access_subject='access|owner',status='active' WHERE id=?").bind(target.staffId),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,'access|owner',1,?)").bind(target.staffId,target.staffId),
      db.prepare("INSERT OR IGNORE INTO native_business_areas(id,name,active) VALUES(?,'Portal Acceptance Staging',1)").bind(target.clientBusinessAreaId),
      db.prepare("INSERT OR IGNORE INTO native_business_areas(id,name,active) VALUES(?,'Drone Services Staging',1)").bind(target.organizationBusinessAreaId),
      db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',2)").bind(target.clientRecordId),
      db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)").bind(target.organizationRecordId),
      db.prepare("INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,active) VALUES(?,'business_area',?,1)").bind(target.clientRecordId,target.clientBusinessAreaId),
      db.prepare("INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,active) VALUES(?,'business_area',?,1)").bind(target.organizationRecordId,target.organizationBusinessAreaId),
    ]);
    if(name.startsWith("0059_"))await db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,'owner@example.test','Owner')").bind(target.staffId).run();
  }
  await db.prepare("PRAGMA foreign_keys=ON").run();
}

async function seed(db){
  const t="2026-10-10T12:00:00.000Z",z="0".repeat(64),instance=uuid(101),application=uuid(102),epoch=uuid(103),clientPublic="a".repeat(32),organizationPublic="b".repeat(32);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO native_business_areas(id,name,active) VALUES(?,'Drone Services Staging',1)").bind(target.organizationBusinessAreaId),
  ]);
  const grantIds=[uuid(2),uuid(3),uuid(4),uuid(5),uuid(6),uuid(7)];
  const grants=[{id:uuid(1),permission:"directory.profile.view",record:null,active:1,scope:"global"},{id:grantIds[3],permission:"directory.profile.edit",record:target.organizationRecordId,active:0,scope:"resource"},{id:grantIds[4],permission:"directory.identity.link",record:target.organizationRecordId,active:0,scope:"resource"}];
  for(const grant of grants)await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active,granted_by,created_at) VALUES(?, ?,?,'allow',?,?,?, ?,?)").bind(grant.id,target.staffId,grant.permission,grant.scope,grant.record,grant.active,target.staffId,t).run();
  return grantIds;
}

async function input(db,phase,grantIds,provisionArtifact){
  const stamp=(await first(db,"SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp")).stamp;
  return {schemaVersion:2,staging:STAGING_TARGET,phase,target,migrationNames,
    staff:await first(db,"SELECT id,status,access_subject FROM staff_users WHERE id=?",target.staffId),roles:await all(db,"SELECT id,staff_id,role_id,scope,scope_key FROM staff_role_assignments WHERE staff_id=? ORDER BY id",target.staffId),
    admission:await first(db,"SELECT * FROM native_staff_admissions WHERE staff_id=?",target.staffId),profile:await first(db,"SELECT * FROM native_staff_profiles WHERE staff_id=?",target.staffId),generation:await first(db,"SELECT * FROM native_directory_grant_generations WHERE staff_id=?",target.staffId),
    records:await all(db,"SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id IN (?,?) ORDER BY CASE record_kind WHEN 'client' THEN 0 ELSE 1 END",target.clientRecordId,target.organizationRecordId),resourceScopes:await all(db,"SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id IN (?,?) ORDER BY CASE record_id WHEN ? THEN 0 ELSE 1 END",target.clientRecordId,target.organizationRecordId,target.clientRecordId),relationship:await first(db,"SELECT client_record_id,organization_record_id,relationship_version FROM operations_directory_client_organizations WHERE client_record_id=?",target.clientRecordId),predecessor:await first(db,"SELECT command_id,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,client_record_id,client_public_id,relationship_version,action,organization_record_id,organization_public_id,command_json,state,outcome_json FROM project_alpha_directory_relationship_outbox WHERE command_id=?",target.predecessorCommandId),grants:await all(db,"SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id",target.staffId),history:await all(db,"SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_generation",target.staffId),approval:{approvalId:crypto.randomUUID(),commandId:crypto.randomUUID(),grantIds,issuedAt:stamp,expiresAt:new Date(Date.parse(stamp)+3600000).toISOString(),executedAt:stamp},...(provisionArtifact?{provisionArtifact}:{})};
}

test("v184 fixed relationship authority provisions and revokes atomically on intact 0001-0184 D1",async()=>{
  const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:`v184-${crypto.randomUUID()}`}});
  try{
    const db=await mf.getD1Database("DB");await migrate(db);assert.deepEqual((await all(db,"SELECT name FROM d1_migrations ORDER BY name")).map(row=>row.name),migrationNames);
    const grantIds=await seed(db),before=await first(db,"SELECT generation FROM native_directory_grant_generations WHERE staff_id=?",target.staffId),provision=compileRelationshipRecoveryAuthorityV184(await input(db,"provision",grantIds));
    await db.prepare(`CREATE TRIGGER v184_cas_race BEFORE INSERT ON native_directory_grants WHEN NEW.id='${grantIds[5]}' AND NEW.active=1 BEGIN SELECT RAISE(ABORT,'v184 cas race'); END`).run();
    await assert.rejects(applyRelationshipRecoveryAuthorityV184(db,provision,{target:STAGING_TARGET,root}),/v184 cas race/);
    assert.equal(await first(db,"SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?",provision.approval.approval_id),null);assert.deepEqual((await all(db,"SELECT active FROM native_directory_grants WHERE id IN (?,?,?,?,?,?) ORDER BY id",...grantIds)).map(row=>row.active),[0,0]);assert.deepEqual(await first(db,"SELECT generation FROM native_directory_grant_generations WHERE staff_id=?",target.staffId),before);
    await db.prepare("DROP TRIGGER v184_cas_race").run();await applyRelationshipRecoveryAuthorityV184(db,provision,{target:STAGING_TARGET,root});
    assert.deepEqual((await all(db,"SELECT active FROM native_directory_grants WHERE id IN (?,?,?,?,?,?) ORDER BY id",...grantIds)).map(row=>row.active),[1,1,1,1,1,1]);assert.equal((await all(db,"SELECT * FROM native_directory_grant_history WHERE staff_id=? AND grant_generation>?",target.staffId,before.generation)).length,6);assert.deepEqual(await first(db,"SELECT generation FROM native_directory_grant_generations WHERE staff_id=?",target.staffId),{generation:before.generation+6});assert.deepEqual(await first(db,"SELECT approval_id FROM native_staff_bootstrap_receipts WHERE command_id=?",provision.receipt.command_id),{approval_id:provision.approval.approval_id});assert.equal((await reconcileRelationshipRecoveryAuthorityV184(db,provision,{root})).status,"committed");
    const revoke=compileRelationshipRecoveryAuthorityV184(await input(db,"revoke",grantIds,provision));await applyRelationshipRecoveryAuthorityV184(db,revoke,{target:STAGING_TARGET,root});
    assert.deepEqual((await all(db,"SELECT active FROM native_directory_grants WHERE id IN (?,?,?,?,?,?) ORDER BY id",...grantIds)).map(row=>row.active),[0,0,0,0,0,0]);assert.deepEqual(await first(db,"SELECT revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?",provision.approval.approval_id),{revoked_at:revoke.input.approval.executedAt});assert.deepEqual(await first(db,"SELECT approval_id FROM native_staff_bootstrap_receipts WHERE command_id=?",revoke.receipt.command_id),{approval_id:revoke.approval.approval_id});
    for(const [index,id] of grantIds.entries())assert.deepEqual((await all(db,"SELECT grant_version,active FROM native_directory_grant_history WHERE grant_id=? ORDER BY grant_version",id)).map(row=>[row.grant_version,row.active]),index===3||index===4?[[1,0],[2,1],[3,0]]:[[1,1],[2,0]]);assert.equal((await reconcileRelationshipRecoveryAuthorityV184(db,revoke,{root})).status,"committed");
    const fenced=compileRelationshipRecoveryAuthorityV184(await input(db,"provision",grantIds));await db.prepare("INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,expected_relationship_version,previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,verified_until) VALUES(?,?,2,?,NULL,2,1,NULL,?,'access|owner','owner@example.test',1,1,?)").bind(uuid(199),target.clientRecordId,target.organizationRecordId,target.staffId,"2999-01-01T00:00:00.000Z").run();await assert.rejects(applyRelationshipRecoveryAuthorityV184(db,fenced,{target:STAGING_TARGET,root}),/malformed JSON/);assert.equal(await first(db,"SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?",fenced.approval.approval_id),null);assert.deepEqual((await all(db,"SELECT active FROM native_directory_grants WHERE id IN (?,?,?,?,?,?) ORDER BY id",...grantIds)).map(row=>row.active),[0,0,0,0,0,0]);await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id=?").bind(grantIds[0]).run();assert.equal((await reconcileRelationshipRecoveryAuthorityV184(db,revoke,{root})).status,"committed-but-drifted");
  }finally{await mf.dispose()}
},240000);
