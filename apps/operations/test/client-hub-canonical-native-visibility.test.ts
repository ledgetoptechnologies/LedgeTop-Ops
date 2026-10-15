import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalBusinessProjectPredicate } from "../src/worker/client-hub-canonical-projects";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { ClientHubBusinessProjectPolicy } from "../src/worker/client-hub-project-policy";
import type { Env } from "../src/worker/types";
const source="project-alpha:staging", instance="11111111-1111-4111-8111-111111111111",
 application="22222222-2222-4222-8222-222222222222",epoch="33333333-3333-4333-8333-333333333333";
const rootPublic="a".repeat(32), projectPublic="b".repeat(32), projection="c".repeat(64);
let runtime:Miniflare|undefined;
afterEach(async()=>{await runtime?.dispose();runtime=undefined;});
async function fixture(){
 runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
 const db=await runtime.getD1Database("OPS_DB") as D1Database;
 const ddl=[
 "CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER)",
 "CREATE TABLE operations_directory_records(record_id TEXT,record_kind TEXT,current_version INTEGER)",
 "CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT)",
 "CREATE TABLE project_alpha_project_mappings(external_project_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,project_alpha_public_id TEXT)",
 "CREATE TABLE operations_shared_projects(external_project_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,project_alpha_public_id TEXT,pa_revision TEXT,canonical_projection_sha256 TEXT,archived INTEGER,current_version INTEGER,organization_record_id TEXT,client_record_id TEXT,name TEXT,lifecycle TEXT,description TEXT,planned_start TEXT,planned_end TEXT,overdue_warning INTEGER,completed_at TEXT,archived_at TEXT)",
 "CREATE TABLE operations_shared_project_revisions(external_project_id TEXT,version INTEGER,pa_revision TEXT,refresh_command_id TEXT,v2_settlement_id TEXT,read_json TEXT)",
 "CREATE TABLE project_alpha_project_v2_canonical_activation_receipts(external_project_id TEXT,resulting_local_version INTEGER,organization_record_id TEXT,client_record_id TEXT)",
 "CREATE TABLE project_alpha_api_v2_inventory_conflicts(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,inventory_kind TEXT,external_id TEXT,project_alpha_public_id TEXT)",
 "CREATE TABLE project_alpha_api_v2_project_observations_current(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,external_project_id TEXT,project_alpha_public_id TEXT,has_conflict INTEGER,resource_revision TEXT,projection_sha256 TEXT,lifecycle_status TEXT,archived INTEGER)",
 "CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT)",
 // The restrictive ACL branch must remain executable even without a projected row.
 "CREATE TABLE pa_projects(projection_source_id TEXT,payload_json TEXT,client_id TEXT,organization_id TEXT,id TEXT)",
 "CREATE TABLE pa_clients(id TEXT,projection_source_id TEXT,active INTEGER,organization_id TEXT)",
 ];
 await db.batch(ddl.map(sql=>db.prepare(sql)));
 const tuple=[source,instance,application,epoch];
 const read={apiVersion:"2",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,
  resource:{type:"project",id:projectPublic,revision:"1",projectionSha256:projection},
  data:{name:"Synthetic native project",status:"active",description:null,estimatedStart:null,estimatedEnd:null,overdueWarning:false,archived:false,completedAt:null,archivedAt:null,organizationPublicId:rootPublic,clientPublicId:null}};
 await db.batch([
 db.prepare("INSERT INTO operations_directory_records VALUES('native-org','organization',1)"),
 db.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES(?,?,?,?, 'organization','native-org','remote-org',?)").bind(...tuple,rootPublic),
 db.prepare("INSERT INTO project_alpha_project_mappings VALUES('native-project',?,?,?,?,?)").bind(...tuple,projectPublic),
 db.prepare("INSERT INTO operations_shared_projects VALUES('native-project',?,?,?,?,?,'1',?,0,1,'native-org',NULL,'Synthetic native project','active',NULL,NULL,NULL,0,NULL,NULL)").bind(...tuple,projectPublic,projection),
 db.prepare("INSERT INTO operations_shared_project_revisions VALUES('native-project',1,NULL,NULL,'settlement',?)").bind(JSON.stringify(read)),
 db.prepare("INSERT INTO project_alpha_project_v2_canonical_activation_receipts VALUES('native-project',1,'native-org',NULL)"),
 ]);
 const connections=(enabled=true,historyEpoch=epoch)=>JSON.stringify({version:1,instances:{[source]:{sourceId:source,enabled,baseUrl:"https://pa.example.test",apiKey:"test-key",sourceInstanceId:instance,applicationId:application,historyEpoch}}});
 const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections()} as Env;
 const context:ClientHubCollectionContext={root:{source_id:source,root_namespace:"business",kind:"organization",public_id:"native-org",pa_internal_id:"remote-org",pa_public_id:rootPublic,
 mapping_status:"mapped",display_name:"Native organization",sort_name:"native organization",status:"active",portal_status:"not_provisioned",workspace_id:null,legacy_account_id:null,
 account_count:0,project_count:1,request_count:0,contact_count:0,meaningful_activity_at:null,source_version:null,indexed_at:"",scan_generation:0},
 access:{directory:true,requests:true,delivery:true,viewer:true},contextVersion:"reviewed-context",
 canonicalRoot:{sourceId:source,rootNamespace:"business",kind:"organization",publicId:"native-org"}};
 const policy:ClientHubBusinessProjectPolicy={allowed:true,canViewUnprojectedCanonical:true,proof:"reviewed-global-project-access",filter:{sql:"1=1",values:[]}};
 const visible=async(value=env,permission=policy)=>{const p=await canonicalBusinessProjectPredicate(value,context,permission);if(!p)return[];
 return(await db.prepare("SELECT s.external_project_id FROM operations_shared_projects s WHERE "+p.sql).bind(...p.values).all()).results;};
 return{db,env,visible,connections,policy};
}
describe("canonical native API-v2 source visibility",()=>{
 it("opens an exact activated native source without a classic connector and preserves hidden veto and project ACL",async()=>{
  const f=await fixture();expect(await f.visible()).toEqual([{external_project_id:"native-project"}]);
  expect(await f.visible(f.env,{...f.policy,canViewUnprojectedCanonical:false,filter:{sql:"0=1",values:[]}})).toEqual([]);
  await f.db.prepare("INSERT INTO pa_connectors VALUES(?,0)").bind(source).run();expect(await f.visible()).toEqual([]);
  await f.db.prepare("UPDATE pa_connectors SET read_visible=1").run();expect(await f.visible()).toHaveLength(1);
 },30_000);
 it("fails closed on disabled/changed source, nonunique mapping, altered owner or inconsistent immutable read",async()=>{
  const f=await fixture();
  for(const config of [f.connections(false),f.connections(true,"44444444-4444-4444-8444-444444444444"),
   f.connections().replace(instance,"55555555-5555-4555-8555-555555555555"),
   f.connections().replace(application,"66666666-6666-4666-8666-666666666666"),"{}",undefined])
   expect(await f.visible({...f.env,PROJECT_ALPHA_API_V2_CONNECTIONS:config})).toEqual([]);
  expect(await f.visible()).toHaveLength(1);
  await f.db.prepare("INSERT INTO project_alpha_project_mappings SELECT * FROM project_alpha_project_mappings").run();expect(await f.visible()).toEqual([]);
  await f.db.prepare("DELETE FROM project_alpha_project_mappings WHERE rowid=(SELECT max(rowid) FROM project_alpha_project_mappings)").run();expect(await f.visible()).toHaveLength(1);
  await f.db.prepare("UPDATE operations_shared_projects SET organization_record_id='other-org'").run();expect(await f.visible()).toEqual([]);
  await f.db.prepare("UPDATE operations_shared_projects SET organization_record_id='native-org'").run();
  await f.db.prepare("UPDATE operations_shared_project_revisions SET read_json=json_set(read_json,'$.data.name','wrong-profile')").run();expect(await f.visible()).toEqual([]);
 },30_000);
});
