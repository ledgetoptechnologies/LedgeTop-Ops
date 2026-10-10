import {readFileSync,readdirSync} from "node:fs";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {describe,expect,it} from "vitest";
import {unstable_splitSqlQuery} from "wrangler";

const migrations=resolve(import.meta.dirname,"../migrations"),z="0".repeat(64);
const client="10000000-0000-4000-8000-000000000001",org="10000000-0000-4000-8000-000000000002";
const predecessor="10000000-0000-4000-8000-000000000003",review="10000000-0000-4000-8000-000000000004";
const authorization="10000000-0000-4000-8000-000000000005",successor="10000000-0000-4000-8000-000000000006";
const source="project-alpha:test",instance="20000000-0000-4000-8000-000000000001",application="20000000-0000-4000-8000-000000000002";
const epoch="20000000-0000-4000-8000-000000000003",origin="https://pa.example.test";
const clientPublic="a".repeat(32),orgPublic="b".repeat(32),clientRequest="30000000-0000-4000-8000-000000000001",orgRequest="30000000-0000-4000-8000-000000000002";
const command=(id:string,generation:string)=>JSON.stringify({commandId:id,expectedClientRevision:"7",expectedAuthorizationGeneration:generation,
  expectedCurrentOrganizationPublicId:null,organization:{externalId:org,publicId:orgPublic,expectedRevision:"9"}});
const grants=JSON.stringify([client,org].flatMap(recordId=>["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage"]
  .map(permission=>({recordId,permission,grantId:`g-${recordId.at(-1)}-${permission}`}))));
function exec(db:DatabaseSync,path:string){for(const sql of unstable_splitSqlQuery(readFileSync(path,"utf8")))db.exec(sql);}
function setup(){const db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=OFF");
  for(const name of readdirSync(migrations).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<="0183").sort())exec(db,resolve(migrations,name));
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {name:string}[])db.exec(`DROP TRIGGER "${name}"`);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('admin','admin@example.test','Admin','access|admin','active');
    INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by,version) VALUES('admin','access|admin',1,'admin',1);
    INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version) VALUES('admin','admin@example.test','Admin',1);
    INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('admin-role','admin','role-owner','global','global');
    INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES('${client}','client',3),('${org}','organization',4);
    INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version) VALUES('${client}','${org}',2);
    INSERT INTO operations_directory_client_organization_history(client_record_id,relationship_version,mutation_id,previous_organization_record_id,
      organization_record_id,client_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version)
      VALUES('${client}',2,'mutation',NULL,'${org}',3,4,'admin','access|admin','admin@example.test',1,1);
    INSERT INTO native_directory_enrollments(record_id,destinations_json,create_admission_id) VALUES
      ('${client}',json_array(json_object('sourceId','${source}','sourceInstanceUUID','${instance}','applicationUUID','${application}','historyEpoch','${epoch}','origin','${origin}','externalCanonicalId','${client}')),'admission-c'),
      ('${org}',json_array(json_object('sourceId','${source}','sourceInstanceUUID','${instance}','applicationUUID','${application}','historyEpoch','${epoch}','origin','${origin}','externalCanonicalId','${org}')),'admission-o');
    INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id)
      VALUES('${source}','client','${client}','${clientPublic}','${instance}','${application}','map-c','${epoch}'),
      ('${source}','organization','${org}','${orgPublic}','${instance}','${application}','map-o','${epoch}');
    INSERT INTO project_alpha_directory_relationship_outbox(command_id,mutation_id,client_record_id,relationship_version,action,source_id,source_instance_id,
      application_id,history_epoch_id,destination_origin,client_public_id,expected_client_revision,expected_authorization_generation,
      expected_current_organization_record_id,expected_current_organization_public_id,organization_record_id,organization_public_id,
      expected_organization_revision,command_json,request_json,state,next_attempt_at,outcome_json,created_at,updated_at)
      VALUES('${predecessor}','mutation','${client}',2,'assign','${source}','${instance}','${application}','${epoch}','${origin}',
      '${clientPublic}','7','10',NULL,NULL,'${org}','${orgPublic}','9',json('${command(predecessor,"10")}'),json_object('body',1),'terminal',0,
      json_object('status','conflict','reason','remote','httpStatus',409),'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,
      authorization_generation,page_sha256,item_count) VALUES
      ('${source}','${instance}','${application}','${epoch}','directory','${clientRequest}','11','${z}',1),
      ('${source}','${instance}','${application}','${epoch}','directory','${orgRequest}','11','${z.replace(/^0/,"1")}',1);
    INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,
      project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES
      ('${source}','${instance}','${application}','${epoch}','${clientRequest}','client','${clientPublic}','7',1,'upsert','${z}','${client}','active','7'),
      ('${source}','${instance}','${application}','${epoch}','${orgRequest}','organization','${orgPublic}','9',1,'upsert','${z.replace(/^0/,"2")}','${org}','active','9');`);
  for(const item of JSON.parse(grants) as {recordId:string;permission:string;grantId:string}[])db.prepare(`INSERT INTO native_directory_grants
    (id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?,'admin',?,'allow','resource',?,'admin')`).run(item.grantId,item.permission,item.recordId);
  exec(db,resolve(migrations,"0184_project_alpha_directory_relationship_generation_recovery.sql"));db.exec("PRAGMA foreign_keys=ON");return db;}
function insertReview(db:DatabaseSync,overrides:Record<string,unknown>={}){const row={review_id:review,client_record_id:client,source_id:source,source_instance_id:instance,
  application_id:application,history_epoch_id:epoch,destination_origin:origin,predecessor_command_id:predecessor,root_command_id:predecessor,
  relationship_version:2,action:"assign",local_previous_organization_record_id:null,intended_organization_record_id:org,client_record_version:3,
  organization_record_version:4,client_external_id:client,client_public_id:clientPublic,organization_external_id:org,organization_public_id:orgPublic,
  expected_client_revision:"7",expected_organization_revision:"9",remote_client_revision:"7",remote_parent_public_id:null,target_binding_active:1,
  target_binding_revision:"9",observed_authorization_generation:"11",client_inventory_request_id:clientRequest,organization_inventory_request_id:orgRequest,
  replay_request_path:`/api/v2/directory/clients/${clientPublic}/organization/assign/commands`,replay_conflict_json:JSON.stringify({apiVersion:"2",
    sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId:"30000000-0000-4000-8000-000000000003",
    error:{code:"authorization_generation_conflict"}}),
  replay_request_sha256:z,replay_conflict_sha256:z,evidence_sha256:z,reviewer_staff_id:"admin",reviewer_access_subject:"access|admin",
  reviewer_email:"admin@example.test",reviewer_admission_version:1,reviewer_profile_version:1,selected_grants_json:grants,
  created_at:"2026-01-01T00:00:00.000Z",expires_at:"2999-01-01T00:00:00.000Z",state:"open",...overrides};
  const keys=Object.keys(row);db.prepare(`INSERT INTO project_alpha_directory_relationship_generation_recovery_reviews(${keys.join(",")}) VALUES(${keys.map(()=>"?").join(",")})`).run(...keys.map(k=>(row as any)[k]));}
function statements(db:DatabaseSync,ledger:Record<string,unknown>={}){const l={authorization_id:authorization,successor_command_id:successor,
  predecessor_command_id:predecessor,root_command_id:predecessor,review_id:review,recovery_depth:1,client_record_id:client,relationship_version:2,
  source_id:source,source_instance_id:instance,application_id:application,history_epoch_id:epoch,destination_origin:origin,
  observed_authorization_generation:"11",evidence_sha256:z,predecessor_command_json:command(predecessor,"10"),predecessor_outcome_sha256:z,
  successor_command_json:command(successor,"11"),successor_request_json:JSON.stringify({body:1}),reason:"reviewed",
  actor_staff_id:"admin",actor_access_subject:"access|admin",actor_email:"admin@example.test",actor_admission_version:1,actor_profile_version:1,
  selected_grants_json:grants,authorized_at:"2026-01-01T00:01:00.000Z",expires_at:"2999-01-01T00:00:00.000Z",...ledger};
  const lk=Object.keys(l),ledgerStatement=db.prepare(`INSERT INTO project_alpha_directory_relationship_generation_recoveries(${lk.join(",")}) VALUES(${lk.map(()=>"?").join(",")})`),
    insertLedger={run:()=>ledgerStatement.run(...lk.map(k=>(l as any)[k]))};
  const o={command_id:successor,authorization_id:authorization,predecessor_command_id:predecessor,source_id:source,source_instance_id:instance,
    application_id:application,history_epoch_id:epoch,destination_origin:origin,client_record_id:client,relationship_version:2,client_public_id:clientPublic,
    action:"assign",expected_client_revision:"7",expected_authorization_generation:"11",expected_current_organization_public_id:null,
    organization_record_id:org,organization_public_id:orgPublic,expected_organization_revision:"9",command_json:command(successor,"11"),
    request_json:JSON.stringify({body:1}),state:"pending",attempts:0,next_attempt_at:0,lease_token:null,lease_expires_at:null,outcome_json:null,
    created_at:"2026-01-01T00:01:00.000Z",updated_at:"2026-01-01T00:01:00.000Z"};const ok=Object.keys(o);
  const outboxStatement=db.prepare(`INSERT INTO project_alpha_directory_relationship_recovery_outbox(${ok.join(",")}) VALUES(${ok.map(()=>"?").join(",")})`),
    authorizationStatement=db.prepare("UPDATE project_alpha_directory_relationship_generation_recovery_reviews SET state='authorized' WHERE review_id=? AND state='open'");
  return {insertLedger,insertOutbox:{run:()=>outboxStatement.run(...ok.map(k=>(o as any)[k]))},authorize:{run:()=>authorizationStatement.run(review)}};}

describe("relationship generation recovery 0184 D1 contract",()=>{
  it("atomically reserves one exact successor and preserves the terminal predecessor",()=>{const db=setup();insertReview(db);const s=statements(db);
    db.exec("BEGIN");s.insertLedger.run();s.insertOutbox.run();s.authorize.run();db.exec("COMMIT");
    expect(db.prepare("SELECT command_kind FROM project_alpha_directory_effective_relationship_commands WHERE command_id=?").get(successor)).toEqual({command_kind:"generation_recovery"});
    expect(db.prepare("SELECT state FROM project_alpha_directory_relationship_outbox WHERE command_id=?").get(predecessor)).toEqual({state:"terminal"});});
  it("rejects ledger plus outbox without review finalization at commit",()=>{const db=setup();insertReview(db);const partial=statements(db);db.exec("BEGIN");partial.insertLedger.run();partial.insertOutbox.run();
    expect(()=>db.exec("COMMIT")).toThrow();db.exec("ROLLBACK");expect(db.prepare("SELECT count(*) n FROM project_alpha_directory_relationship_generation_recoveries").get()).toEqual({n:0});});
  it.each<[string,Record<string,unknown>]>([["wrong selected grant",{selected_grants_json:grants.replace("directory.profile.view","wrong")}],
    ["missing one grant",{selected_grants_json:JSON.stringify(JSON.parse(grants).slice(1))}],
    ["stale actor profile",{actor_profile_version:2}],
    ["mismatched source",{source_id:"project-alpha:other"}]])("rejects %s",(_name,ledger)=>{const db=setup();insertReview(db);expect(()=>statements(db,ledger).insertLedger.run()).toThrow();});
  it("rejects a current deny and an expired review",()=>{let db=setup();insertReview(db);db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by)
    VALUES('deny','admin','directory.profile.edit','deny','resource',?,'admin')`).run(client);expect(()=>statements(db).insertLedger.run()).toThrow();
    db=setup();insertReview(db,{expires_at:"2026-01-01T00:00:30.000Z"});expect(()=>statements(db).insertLedger.run()).toThrow();},15_000);
  it.each<[string,(db:DatabaseSync)=>void]>([
    ["record version drift",db=>{db.prepare("UPDATE operations_directory_records SET current_version=5 WHERE record_id=?").run(org);}],
    ["enrollment drift",db=>{db.prepare("DELETE FROM native_directory_enrollments WHERE record_id=?").run(client);}],
    ["mapping drift",db=>{db.prepare("DELETE FROM project_alpha_directory_mappings WHERE external_id=?").run(org);}],
    ["newer persisted generation",db=>{db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
      history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count) VALUES(?,?,?,?, 'directory',?,?,?,0)`)
      .run(source,instance,application,epoch,"30000000-0000-4000-8000-000000000099","12","3".repeat(64));}],
  ])("rejects authorization after %s",(_name,drift)=>{const db=setup();insertReview(db);drift(db);expect(()=>statements(db).insertLedger.run()).toThrow();});
  it("retains exact ACK evidence after authority is revoked",()=>{const db=setup();insertReview(db);const s=statements(db);db.exec("BEGIN");s.insertLedger.run();s.insertOutbox.run();s.authorize.run();db.exec("COMMIT");
    const ack={status:"acknowledged",response:{sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId:"40000000-0000-4000-8000-000000000001",replayed:false,
      result:{action:"assign",client:{publicId:clientPublic,revision:"8"},organizationPublicId:orgPublic,authorizationGeneration:"12"}}};
    db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='leased',attempts=attempts+1,lease_token='lease',lease_expires_at=? WHERE command_id=?").run(9999999999999,successor);
    db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE command_id=?").run(JSON.stringify(ack),"2026-01-01T00:02:00.000Z",successor);
    db.prepare("UPDATE native_directory_grants SET active=0 WHERE staff_id='admin'").run();
    expect(db.prepare("SELECT count(*) n FROM project_alpha_directory_effective_relationship_commands WHERE command_id=?").get(successor)).toEqual({n:0});
    expect(db.prepare("SELECT identity_valid FROM project_alpha_directory_validated_recovery_relationship_acknowledgements WHERE command_id=?").get(successor)).toEqual({identity_valid:1});
    expect(db.prepare("SELECT recovery_authorization_id FROM project_alpha_directory_effective_relationship_revision_evidence WHERE recovery_authorization_id=?").get(authorization)).toEqual({recovery_authorization_id:authorization});});
  it("rejects malformed ACK evidence and pending-to-ACK settlement",()=>{const db=setup();insertReview(db);const s=statements(db);db.exec("BEGIN");s.insertLedger.run();s.insertOutbox.run();s.authorize.run();db.exec("COMMIT");
    const malformed={status:"acknowledged",response:{sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,
      requestId:"40000000-0000-4000-8000-000000000001",result:{action:"assign",client:{publicId:clientPublic,revision:"8"},organizationPublicId:orgPublic}}};
    expect(()=>db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='acknowledged',outcome_json=? WHERE command_id=?").run(JSON.stringify(malformed),successor)).toThrow();
    db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='leased',attempts=attempts+1,lease_token='lease',lease_expires_at=? WHERE command_id=?").run(9999999999999,successor);
    db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?").run(JSON.stringify(malformed),successor);
    expect(db.prepare("SELECT identity_valid FROM project_alpha_directory_validated_recovery_relationship_acknowledgements WHERE command_id=?").get(successor)).toEqual({identity_valid:0});});
  it("projects the next normal relationship command only through the exact recovered root and source",()=>{const db=setup();insertReview(db);const s=statements(db);
    db.exec("BEGIN");s.insertLedger.run();s.insertOutbox.run();s.authorize.run();db.exec("COMMIT");
    const ack={status:"acknowledged",response:{sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,
      requestId:"40000000-0000-4000-8000-000000000001",replayed:false,result:{action:"assign",
        client:{publicId:clientPublic,revision:"8"},organizationPublicId:orgPublic,authorizationGeneration:"12"}}};
    db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='leased',attempts=1,lease_token='lease',lease_expires_at=? WHERE command_id=?")
      .run(9999999999999,successor);
    db.prepare("UPDATE project_alpha_directory_relationship_recovery_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?")
      .run(JSON.stringify(ack),successor);
    db.exec(`INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES
      ('${client}',3,'client-profile',json_object('name','Client')),('${org}',4,'org-profile',json_object('name','Org'));
      UPDATE operations_directory_client_organizations SET organization_record_id=NULL,relationship_version=3 WHERE client_record_id='${client}';
      INSERT INTO operations_directory_client_organization_history(client_record_id,relationship_version,mutation_id,
        previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,
        organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version)
      VALUES('${client}',3,'next-mutation','${org}',NULL,3,4,NULL,'admin','access|admin','admin@example.test',1,1);`);
    const next="50000000-0000-4000-8000-000000000001",remove=JSON.stringify({commandId:next,expectedClientRevision:"8",
      expectedAuthorizationGeneration:"12",expectedCurrentOrganizationPublicId:orgPublic,organization:null});
    db.prepare(`INSERT INTO project_alpha_directory_relationship_outbox(command_id,mutation_id,client_record_id,relationship_version,action,
      source_id,source_instance_id,application_id,history_epoch_id,destination_origin,client_public_id,expected_client_revision,
      expected_authorization_generation,expected_current_organization_record_id,expected_current_organization_public_id,
      organization_record_id,organization_public_id,expected_organization_revision,command_json,request_json,state,next_attempt_at)
      VALUES(?,'next-mutation',?,3,'remove',?,?,?,?,?,?, '8','12',?,?,NULL,NULL,NULL,?,json_object('body',2),'pending',0)`)
      .run(next,client,source,instance,application,epoch,origin,clientPublic,org,orgPublic,remove);
    expect(db.prepare("SELECT command_id FROM project_alpha_directory_live_relationship_commands WHERE command_id=?").get(next))
      .toEqual({command_id:next});
    const wrongSource="50000000-0000-4000-8000-000000000002";
    db.prepare(`INSERT INTO project_alpha_directory_relationship_outbox(command_id,mutation_id,client_record_id,relationship_version,action,
      source_id,source_instance_id,application_id,history_epoch_id,destination_origin,client_public_id,expected_client_revision,
      expected_authorization_generation,expected_current_organization_record_id,expected_current_organization_public_id,
      organization_record_id,organization_public_id,expected_organization_revision,command_json,request_json,state,next_attempt_at)
      VALUES(?,'next-mutation',?,3,'remove','project-alpha:wrong',?,?,?,?,?, '8','12',?,?,NULL,NULL,NULL,?,json_object('body',2),'pending',0)`)
      .run(wrongSource,client,instance,application,epoch,origin,clientPublic,org,orgPublic,
        JSON.stringify({...JSON.parse(remove),commandId:wrongSource}));
    expect(db.prepare("SELECT command_id FROM project_alpha_directory_live_relationship_commands WHERE command_id=?").get(wrongSource)).toBeUndefined();});
});
