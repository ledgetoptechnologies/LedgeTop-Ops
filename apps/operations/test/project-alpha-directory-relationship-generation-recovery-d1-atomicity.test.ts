import {readFileSync} from "node:fs";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Miniflare} from "miniflare";
import {splitD1MigrationStatements} from "../../client/test/helpers/d1-migrations";

let runtime:Miniflare,db:D1Database;
const client="10000000-0000-4000-8000-000000000001",org="10000000-0000-4000-8000-000000000002";
const predecessor="10000000-0000-4000-8000-000000000003",review="10000000-0000-4000-8000-000000000004";
const authorization="10000000-0000-4000-8000-000000000005",successor="10000000-0000-4000-8000-000000000006";
const source="project-alpha:test",instance="20000000-0000-4000-8000-000000000001",application="20000000-0000-4000-8000-000000000002";
const epoch="20000000-0000-4000-8000-000000000003",origin="https://pa.example.test",z="0".repeat(64);
const clientPublic="a".repeat(32),orgPublic="b".repeat(32);
const command=(id:string,generation:string)=>JSON.stringify({commandId:id,expectedClientRevision:"7",expectedAuthorizationGeneration:generation,
  expectedCurrentOrganizationPublicId:null,organization:{externalId:org,publicId:orgPublic,expectedRevision:"9"}});
const grants=JSON.stringify([client,org].flatMap(recordId=>["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage"]
  .map(permission=>({recordId,permission,grantId:`g-${recordId.at(-1)}-${permission}`}))));
function insertion(table:string,row:Record<string,unknown>){const keys=Object.keys(row);return db.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(()=>"?").join(",")})`).bind(...keys.map(key=>row[key]));}
function reviewRow(){return {review_id:review,client_record_id:client,source_id:source,source_instance_id:instance,application_id:application,
  history_epoch_id:epoch,destination_origin:origin,predecessor_command_id:predecessor,root_command_id:predecessor,relationship_version:2,
  action:"assign",local_previous_organization_record_id:null,intended_organization_record_id:org,client_record_version:3,organization_record_version:4,
  client_external_id:client,client_public_id:clientPublic,organization_external_id:org,organization_public_id:orgPublic,expected_client_revision:"7",
  expected_organization_revision:"9",remote_client_revision:"7",remote_parent_public_id:null,target_binding_active:1,target_binding_revision:"9",
  observed_authorization_generation:"11",client_inventory_request_id:"30000000-0000-4000-8000-000000000001",
  organization_inventory_request_id:"30000000-0000-4000-8000-000000000002",replay_request_path:`/api/v2/directory/clients/${clientPublic}/organization/assign/commands`,
  replay_conflict_json:JSON.stringify({apiVersion:"2",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,
    requestId:"30000000-0000-4000-8000-000000000003",error:{code:"authorization_generation_conflict"}}),replay_request_sha256:z,
  replay_conflict_sha256:z,evidence_sha256:z,reviewer_staff_id:"admin",reviewer_access_subject:"access|admin",reviewer_email:"admin@example.test",
  reviewer_admission_version:1,reviewer_profile_version:1,selected_grants_json:grants,created_at:"2026-01-01T00:00:00.000Z",
  expires_at:"2999-01-01T00:00:00.000Z",state:"open"};}
function ledgerRow(){return {authorization_id:authorization,successor_command_id:successor,predecessor_command_id:predecessor,root_command_id:predecessor,
  review_id:review,review_state:"authorized",recovery_depth:1,client_record_id:client,relationship_version:2,source_id:source,source_instance_id:instance,
  application_id:application,history_epoch_id:epoch,destination_origin:origin,observed_authorization_generation:"11",evidence_sha256:z,
  predecessor_command_json:command(predecessor,"10"),predecessor_outcome_sha256:z,successor_command_json:command(successor,"11"),
  successor_request_json:JSON.stringify({body:1}),reason:"reviewed",actor_staff_id:"admin",actor_access_subject:"access|admin",
  actor_email:"admin@example.test",actor_admission_version:1,actor_profile_version:1,selected_grants_json:grants,
  authorized_at:"2026-01-01T00:01:00.000Z",expires_at:"2999-01-01T00:00:00.000Z"};}
function outboxRow(){return {command_id:successor,authorization_id:authorization,predecessor_command_id:predecessor,source_id:source,
  source_instance_id:instance,application_id:application,history_epoch_id:epoch,destination_origin:origin,client_record_id:client,relationship_version:2,
  client_public_id:clientPublic,action:"assign",expected_client_revision:"7",expected_authorization_generation:"11",
  expected_current_organization_public_id:null,organization_record_id:org,organization_public_id:orgPublic,expected_organization_revision:"9",
  command_json:command(successor,"11"),request_json:JSON.stringify({body:1}),state:"pending",attempts:0,next_attempt_at:0,lease_token:null,
  lease_expires_at:null,outcome_json:null,created_at:"2026-01-01T00:01:00.000Z",updated_at:"2026-01-01T00:01:00.000Z"};}

beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
  db=await runtime.getD1Database("OPS_DB") as D1Database;
  const stubs=`CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY);CREATE TABLE project_alpha_directory_relationship_outbox(command_id TEXT PRIMARY KEY);
    CREATE TABLE staff_users(id TEXT PRIMARY KEY);CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY);
    CREATE VIEW project_alpha_directory_live_relationship_commands AS SELECT command_id,NULL source_id,NULL source_instance_id,NULL application_id,
      NULL history_epoch_id,NULL destination_origin,NULL client_record_id,NULL relationship_version,NULL client_public_id,NULL action,NULL command_json,
      NULL request_json,NULL state,NULL attempts,NULL next_attempt_at,NULL lease_token,NULL lease_expires_at,NULL outcome_json,NULL created_at,NULL updated_at
      FROM project_alpha_directory_relationship_outbox WHERE 0;
    CREATE TABLE project_alpha_directory_relationship_revision_evidence(record_id TEXT,record_kind TEXT,record_version INTEGER,source_id TEXT,source_instance_id TEXT,
      application_id TEXT,history_epoch_id TEXT,destination_origin TEXT,public_id TEXT,revision TEXT,identity_valid INTEGER);`;
  await db.batch(splitD1MigrationStatements(stubs).map(sql=>db.prepare(sql)));
  const migration=readFileSync(new URL("../migrations/0184_project_alpha_directory_relationship_generation_recovery.sql",import.meta.url),"utf8");
  await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
  for(const name of ["project_alpha_directory_relationship_generation_recovery_review_exact","project_alpha_directory_relationship_generation_recovery_authorization_review_exact",
    "project_alpha_directory_relationship_generation_recovery_predecessor_exact","project_alpha_directory_relationship_generation_recovery_canonical_exact","project_alpha_directory_relationship_generation_recovery_successor_exact",
    "project_alpha_directory_relationship_generation_recovery_actor","project_alpha_directory_relationship_generation_recovery_grants_shape",
    "project_alpha_directory_relationship_generation_recovery_grants_allow","project_alpha_directory_relationship_generation_recovery_grants_deny",
    "project_alpha_directory_relationship_generation_recovery_record_versions",
    "project_alpha_directory_relationship_generation_recovery_client_enrollment",
    "project_alpha_directory_relationship_generation_recovery_organization_enrollment",
    "project_alpha_directory_relationship_generation_recovery_client_mapping",
    "project_alpha_directory_relationship_generation_recovery_organization_mapping",
    "project_alpha_directory_relationship_generation_recovery_newer_generation",
    "project_alpha_directory_relationship_recovery_outbox_exact"])
    await db.exec(`DROP TRIGGER ${name}`);
  await db.batch([db.prepare("INSERT INTO operations_directory_records VALUES(?)").bind(client),db.prepare("INSERT INTO operations_directory_records VALUES(?)").bind(org),
    db.prepare("INSERT INTO project_alpha_directory_relationship_outbox VALUES(?)").bind(predecessor),db.prepare("INSERT INTO staff_users VALUES('admin')"),
    ...JSON.parse(grants).map((value:{grantId:string})=>db.prepare("INSERT OR IGNORE INTO native_directory_grants VALUES(?)").bind(value.grantId))]);
},120_000);afterAll(async()=>runtime.dispose());

describe("0184 real D1 deferred atomic reservation",()=>{
  it("rolls back ledger plus outbox when review authorization is omitted",async()=>{await insertion("project_alpha_directory_relationship_generation_recovery_reviews",reviewRow()).run();
    await expect(db.batch([insertion("project_alpha_directory_relationship_generation_recoveries",ledgerRow()),
      insertion("project_alpha_directory_relationship_recovery_outbox",outboxRow())])).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_relationship_generation_recoveries").first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_relationship_recovery_outbox").first("n")).toBe(0);});
  it("commits the exact three-statement authorization atomically",async()=>{await db.batch([insertion("project_alpha_directory_relationship_generation_recoveries",ledgerRow()),
    insertion("project_alpha_directory_relationship_recovery_outbox",outboxRow()),
    db.prepare("UPDATE project_alpha_directory_relationship_generation_recovery_reviews SET state='authorized' WHERE review_id=? AND state='open'").bind(review)]);
    expect(await db.prepare("SELECT state FROM project_alpha_directory_relationship_generation_recovery_reviews WHERE review_id=?").bind(review).first("state")).toBe("authorized");
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_relationship_generation_recoveries").first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_relationship_recovery_outbox").first("n")).toBe(1);});
});
