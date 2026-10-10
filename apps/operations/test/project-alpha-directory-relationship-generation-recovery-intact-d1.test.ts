import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryRelationship } from "../src/worker/native-directory-relationship-writer";

const client="10000000-0000-4000-8000-000000000001",org="10000000-0000-4000-8000-000000000002";
const predecessor="10000000-0000-4000-8000-000000000003",review="10000000-0000-4000-8000-000000000004";
const authorization="10000000-0000-4000-8000-000000000005",successor="10000000-0000-4000-8000-000000000006";
const source="project-alpha:test",instance="20000000-0000-4000-8000-000000000001",application="20000000-0000-4000-8000-000000000002";
const epoch="20000000-0000-4000-8000-000000000003",origin="https://pa.example.test";
const clientPublic="a".repeat(32),orgPublic="b".repeat(32),z="0".repeat(64);
const grants=JSON.stringify([client,org].flatMap(recordId=>["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage"]
  .map(permission=>({recordId,permission,grantId:`g-${recordId.at(-1)}-${permission}`}))));
const command=(id:string,generation:string)=>JSON.stringify({commandId:id,expectedClientRevision:"7",expectedAuthorizationGeneration:generation,
  expectedCurrentOrganizationPublicId:null,organization:{externalId:org,publicId:orgPublic,expectedRevision:"9"}});

async function runSql(db:D1Database,sql:string):Promise<void>{
  const statements=splitD1MigrationStatements(sql).map(statement=>db.prepare(statement));
  for(let start=0;start<statements.length;start+=80) await db.batch(statements.slice(start,start+80));
}

describe("relationship recovery followed by a normal write on intact D1 guards",()=>{
  let runtime:Miniflare,db:D1Database;
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID()}});
    db=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    const directory=new URL("../migrations/",import.meta.url);
    const names=readdirSync(fileURLToPath(directory)).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name.slice(0,4)<="0183").sort();
    for(const name of names) await runSql(db,readFileSync(new URL(name,directory),"utf8"));

    // This is an imported, pre-existing historical snapshot. Triggers are suspended only for this
    // bootstrap and every captured trigger is restored before any recovery or writer operation.
    const triggers=(await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND sql IS NOT NULL ORDER BY name")
      .all<{name:string;sql:string}>()).results;
    for(const trigger of triggers) await db.prepare(`DROP TRIGGER "${trigger.name.replaceAll('"','""')}"`).run();
    await runSql(db,`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('admin','admin@example.test','Admin','access|admin','active');
      INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by,version) VALUES('admin','access|admin',1,'admin',1);
      INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version) VALUES('admin','admin@example.test','Admin',1);
      INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('admin-role','admin','role-owner','global','global');
      INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES('${client}','client',3),('${org}','organization',4);
      INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES('${client}',3,'client-profile',json_object('name','Client')),('${org}',4,'org-profile',json_object('name','Org'));
      INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version) VALUES('${client}','${org}',2);
      INSERT INTO operations_directory_client_organization_history(client_record_id,relationship_version,mutation_id,previous_organization_record_id,organization_record_id,client_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version)
        VALUES('${client}',2,'mutation',NULL,'${org}',3,4,'admin','access|admin','admin@example.test',1,1);
      INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,active,consumed_mutation_id,issued_by,consumed_at) VALUES
        ('admission-c','admin','access|admin','${client}','client',json_array(json_object('businessAreaId','historical','divisionId',NULL)),json_object('name','Client'),json_array(),0,'client-profile','admin','2026-01-01T00:00:00.000Z'),
        ('admission-o','admin','access|admin','${org}','organization',json_array(json_object('businessAreaId','historical','divisionId',NULL)),json_object('name','Org'),json_array(),0,'org-profile','admin','2026-01-01T00:00:00.000Z');
      INSERT INTO native_directory_enrollments(record_id,destinations_json,create_admission_id) VALUES
        ('${client}',json_array(json_object('sourceId','${source}','sourceInstanceUUID','${instance}','applicationUUID','${application}','historyEpoch','${epoch}','origin','${origin}','externalCanonicalId','${client}')),'admission-c'),
        ('${org}',json_array(json_object('sourceId','${source}','sourceInstanceUUID','${instance}','applicationUUID','${application}','historyEpoch','${epoch}','origin','${origin}','externalCanonicalId','${org}')),'admission-o');
      INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,next_attempt_at,outcome_json) VALUES
        ('map-c','${source}','${application}','client','${client}',json_object('operation','create'),'${origin}','${instance}',json_object('historyEpoch','${epoch}'),'acknowledged',0,json_object('status','acknowledged','response',json_object('result',json_object('authorizationGeneration','11')))),
        ('map-o','${source}','${application}','organization','${org}',json_object('commandId','map-o','operation','update','resourceType','organization','externalId','${org}','expectedProjectAlphaPublicId','${orgPublic}','expectedRevision','9','expectedAuthorizationGeneration','11','fields',json_object('name','Org')),'${origin}','${instance}',json_object('historyEpoch','${epoch}'),'acknowledged',0,
          json_object('status','acknowledged','response',json_object('sourceInstanceId','${instance}','applicationId','${application}','historyEpoch','${epoch}','requestId','30000000-0000-4000-8000-000000000004','replayed',json('false'),'result',json_object('resource',json_object('type','organization','publicId','${orgPublic}','revision','9'),'data',json_object('publicId','${orgPublic}'),'authorizationGeneration','11'))));
      UPDATE project_alpha_directory_outbox SET expected_history_epoch_id='${epoch}' WHERE command_id IN ('map-c','map-o');
      INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,application_uuid,destination_origin,external_canonical_id,desired_payload_json,state,expected_history_epoch_id)
        VALUES('org-intent','org-profile','${org}',4,'${source}','${instance}','${application}','${origin}','${org}',json_object('name','Org'),'acknowledged','${epoch}');
      INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at,history_epoch_id)
        SELECT 'org-intent','map-o',command_json,json_object('actorId','admin','authorityRevision','4'),json_object('kind','existing','sourceId','${source}','sourceInstanceUUID','${instance}','applicationUUID','${application}','origin','${origin}','externalCanonicalId','${org}'),0,'${epoch}' FROM project_alpha_directory_outbox WHERE command_id='map-o';
      INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id) VALUES
        ('${source}','client','${client}','${clientPublic}','${instance}','${application}','map-c','${epoch}'),('${source}','organization','${org}','${orgPublic}','${instance}','${application}','map-o','${epoch}');
      INSERT INTO project_alpha_directory_relationship_outbox(command_id,mutation_id,client_record_id,relationship_version,action,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,client_public_id,expected_client_revision,expected_authorization_generation,expected_current_organization_record_id,expected_current_organization_public_id,organization_record_id,organization_public_id,expected_organization_revision,command_json,request_json,state,next_attempt_at,outcome_json,created_at,updated_at)
        VALUES('${predecessor}','mutation','${client}',2,'assign','${source}','${instance}','${application}','${epoch}','${origin}','${clientPublic}','7','10',NULL,NULL,'${org}','${orgPublic}','9',json('${command(predecessor,"10")}'),json_object('body',1),'terminal',0,json_object('directoryRelationshipDispatcher','conflict','reason','http_status','httpStatus',409),'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count) VALUES
        ('${source}','${instance}','${application}','${epoch}','directory','30000000-0000-4000-8000-000000000001','11','${z}',1),('${source}','${instance}','${application}','${epoch}','directory','30000000-0000-4000-8000-000000000002','11','${z.replace(/^0/,"1")}',1);
      INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES
        ('${source}','${instance}','${application}','${epoch}','30000000-0000-4000-8000-000000000001','client','${clientPublic}','7',1,'upsert','${z}','${client}','active','7'),('${source}','${instance}','${application}','${epoch}','30000000-0000-4000-8000-000000000002','organization','${orgPublic}','9',1,'upsert','${z.replace(/^0/,"2")}','${org}','active','9');`);
    for(const item of JSON.parse(grants) as {recordId:string;permission:string;grantId:string}[]) await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?,'admin',?,'allow','resource',?,'admin')`).bind(item.grantId,item.permission,item.recordId).run();
    for(const trigger of triggers) await db.prepare(trigger.sql).run();
    const restored=(await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND sql IS NOT NULL ORDER BY name").all<{name:string;sql:string}>()).results;
    expect(restored).toEqual(triggers);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await runSql(db,readFileSync(new URL("0184_project_alpha_directory_relationship_generation_recovery.sql",directory),"utf8"));
  },240_000);
  afterAll(async()=>{await runtime.dispose();});

  it("admits exact recovery ACK evidence and an actual subsequent normal writer operation without disabling guards",async()=>{
    const predecessorBefore=await db.prepare("SELECT * FROM project_alpha_directory_relationship_outbox WHERE command_id=?").bind(predecessor).first();
    const historyBefore=(await db.prepare("SELECT * FROM operations_directory_client_organization_history WHERE client_record_id=? ORDER BY relationship_version").bind(client).all()).results;
    const row={review_id:review,client_record_id:client,source_id:source,source_instance_id:instance,application_id:application,history_epoch_id:epoch,
      destination_origin:origin,predecessor_command_id:predecessor,root_command_id:predecessor,relationship_version:2,action:"assign",
      local_previous_organization_record_id:null,intended_organization_record_id:org,client_record_version:3,organization_record_version:4,
      client_external_id:client,client_public_id:clientPublic,organization_external_id:org,organization_public_id:orgPublic,expected_client_revision:"7",
      expected_organization_revision:"9",remote_client_revision:"7",remote_parent_public_id:null,target_binding_active:1,target_binding_revision:"9",
      observed_authorization_generation:"11",client_inventory_request_id:"30000000-0000-4000-8000-000000000001",organization_inventory_request_id:"30000000-0000-4000-8000-000000000002",
      replay_request_path:`/api/v2/directory/clients/${clientPublic}/organization/assign/commands`,replay_conflict_json:JSON.stringify({apiVersion:"2",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId:"30000000-0000-4000-8000-000000000003",error:{code:"authorization_generation_conflict"}}),
      replay_request_sha256:z,replay_conflict_sha256:z,evidence_sha256:z,reviewer_staff_id:"admin",reviewer_access_subject:"access|admin",reviewer_email:"admin@example.test",reviewer_admission_version:1,reviewer_profile_version:1,selected_grants_json:grants,created_at:"2026-01-01T00:00:00.000Z",expires_at:"2999-01-01T00:00:00.000Z",state:"open"};
    const keys=Object.keys(row);await db.prepare(`INSERT INTO project_alpha_directory_relationship_generation_recovery_reviews(${keys.join(",")}) VALUES(${keys.map(()=>"?").join(",")})`).bind(...keys.map(key=>row[key as keyof typeof row])).run();
    const ledger={authorization_id:authorization,successor_command_id:successor,predecessor_command_id:predecessor,root_command_id:predecessor,review_id:review,recovery_depth:1,client_record_id:client,relationship_version:2,source_id:source,source_instance_id:instance,application_id:application,history_epoch_id:epoch,destination_origin:origin,observed_authorization_generation:"11",evidence_sha256:z,predecessor_command_json:command(predecessor,"10"),predecessor_outcome_sha256:z,successor_command_json:command(successor,"11"),successor_request_json:JSON.stringify({body:1}),reason:"reviewed",actor_staff_id:"admin",actor_access_subject:"access|admin",actor_email:"admin@example.test",actor_admission_version:1,actor_profile_version:1,selected_grants_json:grants,authorized_at:"2026-01-01T00:01:00.000Z",expires_at:"2999-01-01T00:00:00.000Z"};
    const lk=Object.keys(ledger),outbox={command_id:successor,authorization_id:authorization,predecessor_command_id:predecessor,source_id:source,source_instance_id:instance,application_id:application,history_epoch_id:epoch,destination_origin:origin,client_record_id:client,relationship_version:2,client_public_id:clientPublic,action:"assign",expected_client_revision:"7",expected_authorization_generation:"11",expected_current_organization_public_id:null,organization_record_id:org,organization_public_id:orgPublic,expected_organization_revision:"9",command_json:command(successor,"11"),request_json:JSON.stringify({body:1}),state:"pending",attempts:0,next_attempt_at:0,lease_token:null,lease_expires_at:null,outcome_json:null,created_at:"2026-01-01T00:01:00.000Z",updated_at:"2026-01-01T00:01:00.000Z"},ok=Object.keys(outbox);
    for(const invalidLedger of [
      {...ledger,source_id:"project-alpha:wrong"},
      {...ledger,root_command_id:"50000000-0000-4000-8000-000000000099"},
      {...ledger,observed_authorization_generation:"10"},
    ]){
      await expect(db.batch([db.prepare(`INSERT INTO project_alpha_directory_relationship_generation_recoveries(${lk.join(",")}) VALUES(${lk.map(()=>"?").join(",")})`).bind(...lk.map(key=>invalidLedger[key as keyof typeof invalidLedger])),db.prepare(`INSERT INTO project_alpha_directory_relationship_recovery_outbox(${ok.join(",")}) VALUES(${ok.map(()=>"?").join(",")})`).bind(...ok.map(key=>outbox[key as keyof typeof outbox])),db.prepare("UPDATE project_alpha_directory_relationship_generation_recovery_reviews SET state='authorized' WHERE review_id=? AND state='open'").bind(review)])).rejects.toThrow();
      expect(await db.prepare("SELECT count(*) count FROM project_alpha_directory_relationship_generation_recoveries").first<number>("count")).toBe(0);
      expect(await db.prepare("SELECT count(*) count FROM project_alpha_directory_relationship_recovery_outbox").first<number>("count")).toBe(0);
      expect(await db.prepare("SELECT state FROM project_alpha_directory_relationship_generation_recovery_reviews WHERE review_id=?").bind(review).first()).toEqual({state:"open"});
    }
    await db.batch([db.prepare(`INSERT INTO project_alpha_directory_relationship_generation_recoveries(${lk.join(",")}) VALUES(${lk.map(()=>"?").join(",")})`).bind(...lk.map(key=>ledger[key as keyof typeof ledger])),db.prepare(`INSERT INTO project_alpha_directory_relationship_recovery_outbox(${ok.join(",")}) VALUES(${ok.map(()=>"?").join(",")})`).bind(...ok.map(key=>outbox[key as keyof typeof outbox])),db.prepare("UPDATE project_alpha_directory_relationship_generation_recovery_reviews SET state='authorized' WHERE review_id=? AND state='open'").bind(review)]);
    const ack={status:"acknowledged",response:{sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId:"40000000-0000-4000-8000-000000000001",replayed:false,result:{action:"assign",client:{publicId:clientPublic,revision:"8"},organizationPublicId:orgPublic,authorizationGeneration:"12"}}};
    await db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='leased',attempts=1,lease_token='lease',lease_expires_at=? WHERE command_id=?").bind(9999999999999,successor).run();
    await db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?").bind(JSON.stringify(ack),successor).run();
    expect(await db.prepare("SELECT * FROM project_alpha_directory_relationship_outbox WHERE command_id=?").bind(predecessor).first()).toEqual(predecessorBefore);
    expect((await db.prepare("SELECT * FROM operations_directory_client_organization_history WHERE client_record_id=? ORDER BY relationship_version").bind(client).all()).results).toEqual(historyBefore);
    expect(await db.prepare("SELECT identity_valid,revision FROM project_alpha_directory_validated_recovery_relationship_acknowledgements WHERE command_id=?").bind(successor).first()).toEqual({identity_valid:1,revision:"8"});
    expect(await db.prepare("SELECT command_id FROM operations_directory_effective_materializations WHERE intent_id='org-intent'").first()).toEqual({command_id:"map-o"});
    let batchError:unknown;
    const observedDb={prepare:db.prepare.bind(db),batch:async(statements:D1PreparedStatement[])=>{
      try{return await db.batch(statements);}catch(error){batchError=error;throw error;}
    }} as D1Database;
    const result=await writeNativeDirectoryRelationship(observedDb,{mutationId:"50000000-0000-4000-8000-000000000001",clientRecordId:client,expectedRelationshipVersion:2,expectedClientRecordVersion:3,previousOrganization:{recordId:org,expectedRecordVersion:4},organization:null,actor:{staffId:"admin",accessSubject:"access|admin",email:"admin@example.test",admissionVersion:1,profileVersion:1}},true);
    if(result.status==="blocked"&&result.reason==="authority_or_race"&&batchError) throw batchError;
    expect(result).toEqual(expect.objectContaining({status:"written",replayed:false,relationshipVersion:3}));
    expect(await db.prepare("SELECT state,outcome_json FROM project_alpha_directory_relationship_outbox WHERE command_id=?").bind(predecessor).first()).toMatchObject({state:"terminal"});
    expect(await db.prepare("SELECT count(*) count FROM operations_directory_client_organization_history WHERE client_record_id=?").bind(client).first<number>("count")).toBe(historyBefore.length+1);
    const reservation=(result.status==="written"?result.reservations:[])[0];
    expect(reservation).toBeDefined();
    expect(await db.prepare("SELECT command_id FROM project_alpha_directory_live_relationship_commands WHERE command_id=?").bind(reservation!.commandId).first()).toEqual({command_id:reservation!.commandId});
  },60_000);
});
