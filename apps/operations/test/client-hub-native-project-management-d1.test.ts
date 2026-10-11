import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { StaffPrincipal } from "../src/worker/types";

const auth = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("../src/worker/native-staff-auth",() => ({ authenticateNativeStaffWithAdmissionVersion: auth.current }));
const policy = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/worker/client-hub-project-policy",() => ({ readClientHubBusinessProjectPolicy: policy.read }));
import { prepareClientHubNativeProject, readClientHubNativeProjectCapability, submitClientHubNativeProject } from "../src/worker/client-hub-native-project-management";
import { listClientHubBusinessProjects } from "../src/worker/client-hub-business-projects";
import { canonicalBusinessProjectPredicate } from "../src/worker/client-hub-canonical-projects";
import { prepareProjectAlphaProjectV2Acceptance } from "../src/worker/project-alpha-project-v2-preparation";
import { planProjectAlphaProjectV2Command, type ProjectAlphaProjectV2CommandProducerAction } from "../src/worker/project-alpha-project-v2-command-producer";
import { dispatchProjectAlphaProjectV2PendingCommand } from "../src/worker/project-alpha-project-v2-pending-dispatcher";
import { settleProjectAlphaProjectV2Read } from "../src/worker/project-alpha-project-read-settlement-adapter";
import { activateProjectAlphaProjectV2Canonical } from "../src/worker/project-alpha-project-canonical-activation-adapter";

let runtime: Miniflare;
let db: D1Database;
const commandId = "10000000-0000-4000-8000-000000000001";
const externalId = "10000000-0000-4000-8000-000000000002";
const hash = "a".repeat(43);
const sourceInstanceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",applicationId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpochId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",orgId="20000000-0000-4000-8000-000000000001";
const orgPublic="c".repeat(32),projectPublic="d".repeat(32),projection="e".repeat(64);
const clientId="20000000-0000-4000-8000-000000000002",clientPublic="a".repeat(32),clientProjection="b".repeat(64);
const staff = { id:"staff-native",email:"staff-native@example.test",accessSubject:"access|staff-native",projectAlphaUserId:null } as StaffPrincipal;
const context = { root:{ source_id:"project-alpha:primary",root_namespace:"business",kind:"organization",public_id:orgId,
  pa_internal_id:orgId,pa_public_id:orgPublic,mapping_status:"mapped",display_name:"Organization",sort_name:"Organization",status:"active",
  portal_status:"not_provisioned",workspace_id:null,legacy_account_id:null,account_count:0,project_count:0,request_count:0,contact_count:0,
  meaningful_activity_at:null,source_version:null,indexed_at:"",scan_generation:0 },
  canonicalRoot:{sourceId:"project-alpha:primary",rootNamespace:"business",kind:"organization",publicId:orgId},
  access:{directory:true,requests:true,delivery:true,viewer:true},contextVersion:"x".repeat(43) } as ClientHubCollectionContext;
const standaloneContext={...context,root:{...context.root,kind:"standalone_client",public_id:clientId,
  pa_internal_id:clientId,pa_public_id:clientPublic,display_name:"Standalone client",sort_name:"Standalone client"},
  canonicalRoot:{...context.canonicalRoot,kind:"standalone_client",publicId:clientId},contextVersion:"y".repeat(43)} as ClientHubCollectionContext;
const env = () => ({ OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{"project-alpha:primary":{
  sourceId:"project-alpha:primary",enabled:true,baseUrl:"https://one.example.test",apiKey:"secret",sourceInstanceId,applicationId,historyEpoch:historyEpochId}}}) });
function activationSchemaDatabase(mode: "lookup-error" | "missing-fence"): D1Database {
  return new Proxy(db, { get(target, property) {
    if (property !== "prepare") {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (sql: string) => {
      if (mode === "lookup-error" && sql.includes("FROM client_hub_native_project_preparations WHERE command_id"))
        throw new Error("synthetic native preparation lookup failure");
      const statement = target.prepare(sql);
      if (mode !== "missing-fence" || !sql.includes("SELECT name FROM sqlite_master")) return statement;
      return new Proxy(statement, { get(statementTarget, statementProperty) {
        if (statementProperty === "all") return async () => ({ success: true,
          results: [{ name: "client_hub_native_project_preparations" }], meta: {} }) as D1Result<{ name: string }>;
        const value = Reflect.get(statementTarget, statementProperty);
        return typeof value === "function" ? value.bind(statementTarget) : value;
      } });
    };
  } }) as D1Database;
}
const inventoryReaders = () => ({inventory:vi.fn(async()=>({status:"observed" as const,httpStatus:200 as const,response:{apiVersion:"2" as const,
  sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:crypto.randomUUID(),authorizationGeneration:"7",projects:[],nextCursor:null}})),
  bindingStatus:vi.fn(),project:vi.fn()});
function projectAlphaTransport(external:string,name:string,failPost=false){let posts=0;
  const responsePublic=external.startsWith("ops/")?"5".repeat(32):external.startsWith("60000000")?"6".repeat(32):external.startsWith("70000000")?"8".repeat(32):external.startsWith("71000000")?"f".repeat(32):external.startsWith("75000000")?"4".repeat(32):projectPublic;
  const responseProjection=external.startsWith("ops/")?"8".repeat(64):external.startsWith("60000000")?"7".repeat(64):external.startsWith("70000000")?"9".repeat(64):external.startsWith("71000000")?"1".repeat(64):external.startsWith("75000000")?"5".repeat(64):projection;
  const send=vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input)),method=input instanceof Request?input.method:init?.method??"GET";
  const headers={"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":"50000000-0000-4000-8000-000000000008"};
  if(url.pathname==="/api/v2/capabilities")return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,
    requestId:headers["X-Request-ID"],grantedCapabilities:["api.capabilities.read","projects.create","projects.v2.read"].map(value=>({name:value})),implementedEndpoints:[
      {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},{method:"POST",path:"/api/v2/projects/commands",requiredCapability:"projects.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
      {method:"GET",path:"/api/v2/projects/{publicId}",requiredCapability:"projects.v2.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]}),{headers});
  if(method==="POST"){posts++;if(failPost)throw new Error("synthetic lost response");return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,
    requestId:headers["X-Request-ID"],replayed:true,result:{resource:{type:"project",id:external,publicId:responsePublic,revision:"1",projectionSha256:responseProjection},authorizationGeneration:"8",presentation:{portalPublished:false,publicLinkEnabled:false}}}),{status:201,headers});}
  if(url.pathname===`/api/v2/projects/${responsePublic}`)return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,
    requestId:headers["X-Request-ID"],replayed:false,accepted:true,resource:{type:"project",id:responsePublic,revision:"1",projectionSha256:responseProjection},data:{name,description:null,status:"active",archived:false,overdueWarning:false,completedAt:null,archivedAt:null,estimatedStart:null,estimatedEnd:null,clientPublicId:null,organizationPublicId:orgPublic}}),{headers});
  throw new Error(`unexpected ${method} ${url.pathname}`);});return {send,get posts(){return posts;}};}
async function createLegacyMappedProject(external:string) {
  const commandId="39000000-0000-4000-8000-000000000090", transport=projectAlphaTransport(external,"Imported legacy project");
  const actor={staffId:staff.id,accessSubject:staff.accessSubject,email:staff.email,admissionVersion:1,profileVersion:1,scopes:[]};
  const prepared=await prepareProjectAlphaProjectV2Acceptance(env() as never,{operation:"create",sourceId:"project-alpha:primary",
    expectedApplicationId:applicationId,externalProjectId:external,organizationRecordId:orgId,clientRecordId:null,actor},inventoryReaders() as never);
  if(prepared.status!=="prepared"||prepared.preparation.operation!=="create")throw new Error(`legacy prepare ${JSON.stringify(prepared)}`);
  const value=prepared.preparation;
  const action:Extract<ProjectAlphaProjectV2CommandProducerAction,{operation:"create"}>={sourceId:value.sourceId,actor:{...actor,
    verifiedUntil:"2999-01-01T00:00:00.000Z"},operation:"create",local:value.local,directory:value.directory,
    command:{commandId,externalId:external,expectedAuthorizationGeneration:value.expectedAuthorizationGeneration,
      project:{name:"Imported legacy project",description:null,estimatedStart:null,estimatedEnd:null},
      organization:value.organization,client:value.client}};
  const environment=env() as never;
  const planned=await planProjectAlphaProjectV2Command(environment,action);if(planned.status!=="queued")throw new Error(`legacy plan ${JSON.stringify(planned)}`);
  const dispatched=await dispatchProjectAlphaProjectV2PendingCommand(environment,"project-alpha:primary",commandId,transport.send);
  if(dispatched.status!=="acknowledged")throw new Error(`legacy dispatch ${JSON.stringify(dispatched)}`);
  const settled=await settleProjectAlphaProjectV2Read({OPS_DB:db},dispatched.receiptId,{baseUrl:"https://one.example.test",apiKey:"secret",
    expectedSourceInstanceId:sourceInstanceId,expectedApplicationId:applicationId,expectedHistoryEpoch:historyEpochId},transport.send);
  if(settled.status!=="settled")throw new Error(`legacy settlement ${JSON.stringify(settled)}`);
  const activated=await activateProjectAlphaProjectV2Canonical({OPS_DB:db},settled.settlementId);
  if(activated.status!=="activated")throw new Error(`legacy activation ${JSON.stringify(activated)}`);
}
function standaloneTransport(external:string,name:string,failPost=false,publicChar="0"){let posts=0;const responsePublic=publicChar.repeat(32),responseProjection="6".repeat(64);
  const send=vi.fn<typeof fetch>(async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));
    const method=input instanceof Request?input.method:init?.method??"GET",requestId=crypto.randomUUID();
    const headers={"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":requestId};
    if(url.pathname==="/api/v2/capabilities")return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId,
      grantedCapabilities:["api.capabilities.read","projects.create","projects.v2.read"].map(name=>({name})),implementedEndpoints:[
        {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},{method:"POST",path:"/api/v2/projects/commands",requiredCapability:"projects.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},{method:"GET",path:"/api/v2/projects/{publicId}",requiredCapability:"projects.v2.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]}),{headers});
    if(method==="POST"){posts++;if(failPost)throw new Error("synthetic standalone lost response");return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId,replayed:posts>1,
      result:{resource:{type:"project",id:external,publicId:responsePublic,revision:"1",projectionSha256:responseProjection},authorizationGeneration:"8",presentation:{portalPublished:false,publicLinkEnabled:false}}}),{status:201,headers});}
    if(url.pathname===`/api/v2/projects/${responsePublic}`)return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId,replayed:false,accepted:true,
      resource:{type:"project",id:responsePublic,revision:"1",projectionSha256:responseProjection},data:{name,description:null,status:"active",archived:false,overdueWarning:false,completedAt:null,archivedAt:null,estimatedStart:null,estimatedEnd:null,clientPublicId:clientPublic,organizationPublicId:null}}),{headers});
    throw new Error(`unexpected ${method} ${url.pathname}`);});return {send,get posts(){return posts;}};}

async function insert(id = commandId, external = externalId) {
  const generation=await db.prepare("SELECT generation FROM native_project_grant_generations WHERE staff_id=?").bind(staff.id).first<number>("generation");
  const frozen=JSON.stringify({sourceId:"project-alpha:primary",expectedApplicationId:applicationId,operation:"create",scopes:[],
    local:{expectedLocalVersion:0,expectedLocalProjectionSha256:null},directory:{organizationRecordId:orgId,clientRecordId:null},
    command:{commandId:id,externalId:external,expectedAuthorizationGeneration:String(generation),project:{name:"Fixture",description:null,
      estimatedStart:null,estimatedEnd:null},organization:{externalId:orgId,expectedPublicId:orgPublic,expectedRevision:"3",
      expectedProjectionSha256:projection},client:null}});
  return db.prepare(`INSERT INTO client_hub_native_project_preparations(
    command_id,external_project_id,request_json,request_sha256,context_source_id,context_root_namespace,context_root_kind,
    context_root_public_id,context_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,
    actor_profile_version,authority_generation,source_instance_id,application_id,history_epoch_id)
    VALUES(?,?,?,?,'project-alpha:primary','business','organization',?,'context',?,?,?,?,?,?,?,?,?)`)
    .bind(id,external,frozen,hash,orgId,staff.id,staff.accessSubject,staff.email,1,1,generation,
      sourceInstanceId,applicationId,historyEpochId).run();
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const names = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  expect(names.at(-1)).toBe("0190_client_hub_native_project_preparation_authority.sql");
  for (const name of names) {
    const migration = readFileSync(new URL(name,directory),"utf8");
    const statements=splitD1MigrationStatements(migration);
    if(name==="0081_operations_directory_relationships.sql"){
      for(const sql of statements){
        if(sql.startsWith("CREATE TRIGGER operations_directory_client_organizations_insert_guard"))
          await db.prepare("INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version) VALUES(?,NULL,1)").bind(clientId).run();
        await db.prepare(sql).run();
      }
    }else await db.batch(statements.map(sql => db.prepare(sql)));
    if(name==="0033_projection_sources.sql")await db.batch([
      db.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
        VALUES('project-alpha:primary','organization',?,?)`).bind(orgId,orgId),
      db.prepare(`INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id)
        VALUES(?,'Organization',1,?,'sync','project-alpha:primary')`).bind(orgId,JSON.stringify({public_id:orgPublic})),
    ]);
    if(name==="0055_operations_directory_authority.sql")await db.batch([
      db.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)`).bind(orgId),
      db.prepare(`INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json)
        VALUES(?,1,'fixture-org-revision',?)`).bind(orgId,JSON.stringify({name:"Organization"})),
      db.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)`).bind(clientId),
      db.prepare(`INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json)
        VALUES(?,1,'fixture-client-revision',?)`).bind(clientId,JSON.stringify({name:"Standalone client"})),
    ]);
    if(name==="0059_native_staff_profiles.sql")await db.batch([
      db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')`).bind(staff.id,staff.email,"Native Staff",staff.accessSubject),
      db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)`).bind(staff.id,staff.accessSubject,staff.id),
      db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version) VALUES(?,?,?,1)`).bind(staff.id,staff.email,"Native Staff"),
    ]);
    if(name==="0065_project_alpha_directory_history_epoch.sql")await db.batch([
      db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,
        destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,lease_token,lease_expires_at,expected_history_epoch_id)
        VALUES('map-org','project-alpha:primary',?,'organization',?,'{}','https://one.example.test',?,'{}','leased',1,0,'fixture',4102444800,?)`)
        .bind(applicationId,orgId,sourceInstanceId,historyEpochId),
      db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id)
        VALUES('project-alpha:primary','organization',?,?,?,?,?,?)`).bind(orgId,orgPublic,sourceInstanceId,applicationId,"map-org",historyEpochId),
      db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,
        destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,lease_token,lease_expires_at,expected_history_epoch_id)
        VALUES('map-client','project-alpha:primary',?,'client',?,'{}','https://one.example.test',?,'{}','leased',1,0,'fixture-client',4102444800,?)`)
        .bind(applicationId,clientId,sourceInstanceId,historyEpochId),
      db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id)
        VALUES('project-alpha:primary','client',?,?,?,?,?,?)`).bind(clientId,clientPublic,sourceInstanceId,applicationId,"map-client",historyEpochId),
    ]);
  }
  await db.batch([
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by)
      VALUES('grant-native',?,'project.shared.sync','allow','global',1,1,?)`).bind(staff.id,staff.id),
    db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count)
      VALUES('project-alpha:primary',?,?,?,'directory','30000000-0000-4000-8000-000000000001','7',?,1)`).bind(sourceInstanceId,applicationId,historyEpochId,"f".repeat(64)),
    db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision)
      VALUES('project-alpha:primary',?,?,?,'30000000-0000-4000-8000-000000000001','organization',?,'3',1,'upsert',?,?,'active','3')`)
      .bind(sourceInstanceId,applicationId,historyEpochId,orgPublic,projection,orgId),
    db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision)
      VALUES('project-alpha:primary',?,?,?,'30000000-0000-4000-8000-000000000001','client',?,'2',1,'upsert',?,?,'active','2')`)
      .bind(sourceInstanceId,applicationId,historyEpochId,clientPublic,clientProjection,clientId),
  ]);
  auth.current.mockResolvedValue({ identity:{staffId:staff.id,email:staff.email,verifiedAccessSubject:staff.accessSubject,profileVersion:1},
    admissionVersion:1,verifiedUntil:"2999-01-01T00:00:00.000Z" });
  policy.read.mockResolvedValue({allowed:true,filter:{sql:"1=1",values:[]},canViewUnprojectedCanonical:true,proof:"p".repeat(43)});
},180_000);
afterAll(async () => runtime.dispose());

describe("Client Hub native project durable preparation ledger", () => {
  it("rejects an immutable preparation when authority is revoked after readiness was observed", async () => {
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    await expect(readClientHubNativeProjectCapability(env() as never,staff,context)).resolves.toMatchObject({available:true});
    const raceCommand="39000000-0000-4000-8000-000000000001",raceExternal="39000000-0000-4000-8000-000000000002";
    await db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'").run();
    await expect(insert(raceCommand,raceExternal)).rejects.toThrow(/authority is not current and exact/);
    expect(await db.prepare("SELECT count(*) n FROM client_hub_native_project_preparations WHERE command_id=?")
      .bind(raceCommand).first("n")).toBe(0);
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
  });
  it("joins normal preparation through the real outbox, PA acknowledgement, settlement, activation, and business collection",async()=>{
    const command="40000000-0000-4000-8000-000000000001",external="40000000-0000-4000-8000-000000000002";
    const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const readers={inventory:vi.fn(async()=>({status:"observed" as const,httpStatus:200 as const,response:{apiVersion:"2" as const,
      sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:"50000000-0000-4000-8000-000000000001",authorizationGeneration:"7",projects:[],nextCursor:null}})),
      bindingStatus:vi.fn(),project:vi.fn()};
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,
      commandId:command,externalProjectId:external,scopes:[],project:{name:"Joined project",description:null,estimatedStart:null,estimatedEnd:null}},readers as never);
    expect(prepared.status).toBe("prepared"); if(prepared.status!=="prepared")throw new Error("prepare failed");
    let posts=0;
    const send=vi.fn<typeof fetch>(async(input,init)=>{
      const url=new URL(input instanceof Request?input.url:String(input)),method=input instanceof Request?input.method:init?.method??"GET";
      if(url.pathname==="/api/v2/capabilities")return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,
        requestId:"50000000-0000-4000-8000-000000000002",grantedCapabilities:["api.capabilities.read","projects.create","projects.v2.read"].map(name=>({name})),
        implementedEndpoints:[{method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},{method:"POST",path:"/api/v2/projects/commands",requiredCapability:"projects.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},{method:"GET",path:"/api/v2/projects/{publicId}",requiredCapability:"projects.v2.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":"50000000-0000-4000-8000-000000000002"}});
      if(method==="POST"){posts++;return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:"50000000-0000-4000-8000-000000000003",replayed:false,result:{resource:{type:"project",id:external,publicId:projectPublic,revision:"1",projectionSha256:projection},authorizationGeneration:"8",presentation:{portalPublished:false,publicLinkEnabled:false}}}),{status:201,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":"50000000-0000-4000-8000-000000000003"}})}
      if(url.pathname===`/api/v2/projects/${projectPublic}`)return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:"50000000-0000-4000-8000-000000000004",replayed:false,accepted:true,resource:{type:"project",id:projectPublic,revision:"1",projectionSha256:projection},data:{name:"Joined project",description:null,status:"active",archived:false,overdueWarning:false,completedAt:null,archivedAt:null,estimatedStart:null,estimatedEnd:null,clientPublicId:null,organizationPublicId:orgPublic}}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":"50000000-0000-4000-8000-000000000004"}});
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    const outcome=await submitClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,request:prepared.request},send);
    if(outcome.status!=="activated")throw new Error(`joined outcome ${JSON.stringify(outcome)}`);
    expect(outcome).toMatchObject({status:"activated",externalProjectId:external}); expect(posts).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_outbox WHERE command_id=?").bind(command).first("n")).toBe(1);
    const visible=await listClientHubBusinessProjects(env() as never,staff,context);
    if(!visible.items.length){const predicate=await canonicalBusinessProjectPredicate(env() as never,context,await policy.read());
      const state=await db.prepare("SELECT external_project_id,organization_record_id,project_alpha_public_id FROM operations_shared_projects WHERE external_project_id=?").bind(external).all();
      throw new Error(`visibility ${JSON.stringify({predicate,state:state.results,page:visible.page})}`);}
    expect(visible.items).toEqual(expect.arrayContaining([expect.objectContaining({external_project_id:external,origin:"canonical"})]));
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},send)).resolves.toMatchObject({status:"activated",replayed:true});
    expect(posts).toBe(1);
    for(const tampered of [
      {...prepared.request,command:{...prepared.request.command,project:{...prepared.request.command.project,name:"Tampered"}}},
      {...prepared.request,scopes:[{scopeKind:"business_area",businessAreaId:"forged",divisionId:null}]},
      {...prepared.request,command:{...prepared.request.command,organization:{...prepared.request.command.organization,expectedRevision:"4"}}},
    ])await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:tampered},send)).rejects.toMatchObject({status:409});
    await db.batch([
      db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('unrelated-area','Unrelated',1)"),
      db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,active,version,granted_by)
        VALUES('grant-unrelated',?,'project.shared.sync','allow','business_area','unrelated-area',1,1,?)`).bind(staff.id,staff.id),
    ]);
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},send)).resolves.toMatchObject({status:"activated",replayed:true});
    expect(posts).toBe(1);
    await db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'").run();
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},send)).rejects.toMatchObject({status:409});
  });
  it("updates an owned canonical project with exact local and remote CAS and replays without a resend",async()=>{
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    const command="41000000-0000-4000-8000-000000000001",external="40000000-0000-4000-8000-000000000002";
    const nextProjection="2".repeat(64),request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const binding=()=>({status:"observed" as const,httpStatus:200 as const,response:{apiVersion:"2" as const,sourceInstanceId,applicationId,
      historyEpoch:historyEpochId,requestId:crypto.randomUUID(),authorizationGeneration:"8",binding:{externalId:external,publicId:projectPublic,
        createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"},resource:{revision:"1",projectionSha256:projection,status:"active" as const,archived:false}}});
    const readers={inventory:vi.fn(),bindingStatus:vi.fn(async()=>binding()),project:vi.fn(async()=>({status:"read" as const,httpStatus:200 as const,
      response:{apiVersion:"2" as const,sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:crypto.randomUUID(),replayed:false as const,accepted:true,
        resource:{type:"project" as const,id:projectPublic,revision:"1",projectionSha256:projection},data:{name:"Joined project",description:null,status:"active" as const,
          archived:false,overdueWarning:false,completedAt:null,archivedAt:null,estimatedStart:null,estimatedEnd:null,clientPublicId:null,organizationPublicId:orgPublic}}}))};
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,
      operation:"update",commandId:command,externalProjectId:external,scopes:[],project:{name:"Updated project",description:"Revised",estimatedStart:null,estimatedEnd:null}},readers as never);
    expect(prepared).toMatchObject({status:"prepared",request:{operation:"update",local:{expectedLocalVersion:1,expectedLocalProjectionSha256:projection},
      command:{expectedPublicId:projectPublic,expectedRevision:"1",expectedProjectionSha256:projection,project:{name:"Updated project"}}}});
    if(prepared.status!=="prepared")throw new Error("update prepare failed");
    let posts=0;
    const send=vi.fn<typeof fetch>(async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input)),method=input instanceof Request?input.method:init?.method??"GET";
      const headers={"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":crypto.randomUUID()};
      if(url.pathname==="/api/v2/capabilities")return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:headers["X-Request-ID"],
        grantedCapabilities:["api.capabilities.read","projects.write","projects.v2.read"].map(name=>({name})),implementedEndpoints:[
          {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},{method:"POST",path:"/api/v2/projects/profile/commands",requiredCapability:"projects.write",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
          {method:"GET",path:"/api/v2/projects/{publicId}",requiredCapability:"projects.v2.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]}),{headers});
      if(method==="POST"){posts++;return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:headers["X-Request-ID"],replayed:false,
        result:{resource:{type:"project",id:external,publicId:projectPublic,revision:"2",projectionSha256:nextProjection},authorizationGeneration:"8",presentation:{portalPublished:false,publicLinkEnabled:false}}}),{status:200,headers});}
      if(url.pathname===`/api/v2/projects/${projectPublic}`)return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:headers["X-Request-ID"],replayed:false,accepted:true,
        resource:{type:"project",id:projectPublic,revision:"2",projectionSha256:nextProjection},data:{name:"Updated project",description:"Revised",status:"active",archived:false,overdueWarning:false,completedAt:null,archivedAt:null,
          estimatedStart:null,estimatedEnd:null,clientPublicId:null,organizationPublicId:orgPublic}}),{headers});throw new Error(`unexpected ${method} ${url.pathname}`);});
    await expect(submitClientHubNativeProject({ ...env(), OPS_DB: activationSchemaDatabase("missing-fence") } as never,
      request,staff,context,{expectedContextVersion:context.contextVersion,request:prepared.request},send))
      .resolves.toMatchObject({status:"uncertain",reason:"database"});
    expect(posts).toBe(1);
    await expect(submitClientHubNativeProject({ ...env(), OPS_DB: activationSchemaDatabase("lookup-error") } as never,
      request,staff,context,{expectedContextVersion:context.contextVersion,request:prepared.request},send))
      .resolves.toMatchObject({status:"uncertain",reason:"database"});
    expect(posts).toBe(1);
    const updated=await submitClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,request:prepared.request},send);
    if(updated.status!=="activated"){
      const diagnostics=await Promise.all([
        db.prepare("SELECT state,outcome_json FROM project_alpha_project_outbox WHERE command_id=?").bind(command).all(),
        db.prepare("SELECT state_version,state FROM project_alpha_project_v2_events WHERE command_id=? ORDER BY state_version").bind(command).all(),
        db.prepare("SELECT * FROM project_alpha_project_v2_success_receipts WHERE command_id=?").bind(command).all(),
      ]);throw new Error(`update outcome ${JSON.stringify({updated,diagnostics:diagnostics.map(row=>row.results)})}`);
    }
    expect(updated).toMatchObject({status:"activated",externalProjectId:external,version:2});
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,request:prepared.request},send))
      .resolves.toMatchObject({status:"activated",replayed:true});
    expect(posts).toBe(1);
    expect(await db.prepare("SELECT current_version,canonical_projection_sha256 FROM operations_shared_projects WHERE external_project_id=?").bind(external).first())
      .toEqual({current_version:2,canonical_projection_sha256:nextProjection});
    await expect(db.prepare("UPDATE project_alpha_project_v2_update_activation_fences SET name='tampered' WHERE command_id=?").bind(command).run())
      .rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?").bind(command).run())
      .rejects.toThrow(/durable/);
    await expect(db.prepare("UPDATE operations_shared_projects SET name='late reuse' WHERE external_project_id=?").bind(external).run())
      .rejects.toThrow(/versioned writer/);

    const command2="42000000-0000-4000-8000-000000000001",finalProjection="3".repeat(64);
    const request2=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command2}});
    const readers2={inventory:vi.fn(),bindingStatus:vi.fn(async()=>({status:"observed" as const,httpStatus:200 as const,response:{apiVersion:"2" as const,
      sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:crypto.randomUUID(),authorizationGeneration:"8",
      binding:{externalId:external,publicId:projectPublic,createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"},
      resource:{revision:"2",projectionSha256:nextProjection,status:"active" as const,archived:false}}})),project:vi.fn(async()=>({status:"read" as const,httpStatus:200 as const,
      response:{apiVersion:"2" as const,sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:crypto.randomUUID(),replayed:false as const,accepted:true,
        resource:{type:"project" as const,id:projectPublic,revision:"2",projectionSha256:nextProjection},data:{name:"Updated project",description:"Revised",status:"active" as const,
          archived:false,overdueWarning:false,completedAt:null,archivedAt:null,estimatedStart:null,estimatedEnd:null,clientPublicId:null,organizationPublicId:orgPublic}}}))};
    const prepared2=await prepareClientHubNativeProject(env() as never,request2,staff,context,{expectedContextVersion:context.contextVersion,
      operation:"update",commandId:command2,externalProjectId:external,scopes:[],project:{name:"Updated twice",description:null,estimatedStart:null,estimatedEnd:null}},readers2 as never);
    expect(prepared2).toMatchObject({status:"prepared",request:{local:{expectedLocalVersion:2,expectedLocalProjectionSha256:nextProjection},command:{expectedRevision:"2"}}});
    if(prepared2.status!=="prepared")throw new Error("second update prepare failed");
    let secondPosts=0;
    const send2=vi.fn<typeof fetch>(async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input)),method=input instanceof Request?input.method:init?.method??"GET";
      const headers={"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":crypto.randomUUID()};
      if(url.pathname==="/api/v2/capabilities")return send(input,init);
      if(method==="POST"){secondPosts++;return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:headers["X-Request-ID"],replayed:false,
        result:{resource:{type:"project",id:external,publicId:projectPublic,revision:"3",projectionSha256:finalProjection},authorizationGeneration:"8",presentation:{portalPublished:false,publicLinkEnabled:false}}}),{headers});}
      if(url.pathname===`/api/v2/projects/${projectPublic}`)return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:headers["X-Request-ID"],replayed:false,accepted:true,
        resource:{type:"project",id:projectPublic,revision:"3",projectionSha256:finalProjection},data:{name:"Updated twice",description:null,status:"active",archived:false,overdueWarning:false,completedAt:null,archivedAt:null,
          estimatedStart:null,estimatedEnd:null,clientPublicId:null,organizationPublicId:orgPublic}}),{headers});throw new Error(`unexpected ${method} ${url.pathname}`);});
    await db.prepare(`CREATE TRIGGER fixture_abort_second_project_update BEFORE UPDATE ON operations_shared_projects
      WHEN OLD.external_project_id='40000000-0000-4000-8000-000000000002' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`).run();
    await expect(submitClientHubNativeProject(env() as never,request2,staff,context,{expectedContextVersion:context.contextVersion,request:prepared2.request},send2))
      .resolves.toMatchObject({status:"uncertain",reason:"database"});
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?").bind(command2).first("n")).toBe(0);
    expect(await db.prepare("SELECT current_version FROM operations_shared_projects WHERE external_project_id=?").bind(external).first("current_version")).toBe(2);
    const forgedScopes=JSON.stringify([{scopeKind:"business_area",businessAreaId:"forged-area",divisionId:null}]);
    await expect(db.prepare(`INSERT INTO project_alpha_project_v2_update_activation_fences(
      settlement_id,command_id,external_project_id,prior_version,prior_projection_sha256,resulting_version,
      source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id,project_alpha_revision,
      projection_sha256,name,description,lifecycle,planned_start,planned_end,organization_record_id,client_record_id,
      scopes_json,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_email,
      grant_generation,verified_until,completed_at,archived,archived_at,overdue_warning)
      SELECT settlement.settlement_id,settlement.command_id,settlement.external_project_id,intent.expected_local_version,
       intent.expected_local_projection_sha256,intent.expected_local_version+1,settlement.source_id,settlement.source_instance_id,
       settlement.application_id,settlement.history_epoch_id,settlement.project_alpha_public_id,settlement.project_alpha_revision,
       settlement.projection_sha256,json_extract(settlement.read_json,'$.data.name'),json_extract(settlement.read_json,'$.data.description'),
       json_extract(settlement.read_json,'$.data.status'),json_extract(settlement.read_json,'$.data.estimatedStart'),
       json_extract(settlement.read_json,'$.data.estimatedEnd'),?,NULL,?,proof.actor_staff_id,proof.actor_access_subject,
       proof.actor_admission_version,proof.actor_profile_version,proof.actor_email,proof.grant_generation,proof.verified_until,
       json_extract(settlement.read_json,'$.data.completedAt'),json_extract(settlement.read_json,'$.data.archived'),
       json_extract(settlement.read_json,'$.data.archivedAt'),json_extract(settlement.read_json,'$.data.overdueWarning')
      FROM project_alpha_project_v2_canonical_settlement_receipts settlement
      JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
      JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=settlement.command_id
      WHERE settlement.command_id=? LIMIT 1`).bind(orgId,forgedScopes,command2).run()).rejects.toThrow(/lacks current authority/);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?").bind(command2).first("n")).toBe(0);
    await db.prepare("DROP TRIGGER fixture_abort_second_project_update").run();
    const exactFence=db.prepare(`INSERT INTO project_alpha_project_v2_update_activation_fences(
      settlement_id,command_id,external_project_id,prior_version,prior_projection_sha256,resulting_version,
      source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id,project_alpha_revision,
      projection_sha256,name,description,lifecycle,planned_start,planned_end,organization_record_id,client_record_id,
      scopes_json,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_email,
      grant_generation,verified_until,completed_at,archived,archived_at,overdue_warning)
      SELECT settlement.settlement_id,settlement.command_id,settlement.external_project_id,intent.expected_local_version,
       intent.expected_local_projection_sha256,intent.expected_local_version+1,settlement.source_id,settlement.source_instance_id,
       settlement.application_id,settlement.history_epoch_id,settlement.project_alpha_public_id,settlement.project_alpha_revision,
       settlement.projection_sha256,json_extract(settlement.read_json,'$.data.name'),json_extract(settlement.read_json,'$.data.description'),
       json_extract(settlement.read_json,'$.data.status'),json_extract(settlement.read_json,'$.data.estimatedStart'),
       json_extract(settlement.read_json,'$.data.estimatedEnd'),?,NULL,proof.scopes_json,proof.actor_staff_id,proof.actor_access_subject,
       proof.actor_admission_version,proof.actor_profile_version,proof.actor_email,proof.grant_generation,proof.verified_until,
       json_extract(settlement.read_json,'$.data.completedAt'),json_extract(settlement.read_json,'$.data.archived'),
       json_extract(settlement.read_json,'$.data.archivedAt'),json_extract(settlement.read_json,'$.data.overdueWarning')
      FROM project_alpha_project_v2_canonical_settlement_receipts settlement
      JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
      JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=settlement.command_id
      WHERE settlement.command_id=? LIMIT 1`).bind(orgId,command2);
    const exactUpdate=db.prepare(`UPDATE operations_shared_projects SET
      current_version=(SELECT resulting_version FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      pa_revision=(SELECT project_alpha_revision FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      canonical_projection_sha256=(SELECT projection_sha256 FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      name=(SELECT name FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      description=(SELECT description FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      lifecycle=(SELECT lifecycle FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      planned_start=(SELECT planned_start FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      planned_end=(SELECT planned_end FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      scopes_json=(SELECT scopes_json FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      completed_at=(SELECT completed_at FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      archived=(SELECT archived FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      archived_at=(SELECT archived_at FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?),
      overdue_warning=(SELECT overdue_warning FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?)
      WHERE external_project_id=?`).bind(command2,command2,command2,command2,command2,command2,command2,
        command2,command2,command2,command2,command2,command2,external);
    await expect(db.batch([exactFence,
      db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'"),exactUpdate]))
      .rejects.toThrow(/update fence lacks current authority/);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_update_activation_fences WHERE command_id=?")
      .bind(command2).first("n")).toBe(0);
    expect(await db.prepare("SELECT active FROM native_project_grants WHERE id='grant-native'").first("active")).toBe(1);
    await expect(submitClientHubNativeProject(env() as never,request2,staff,context,{expectedContextVersion:context.contextVersion,request:prepared2.request},send2))
      .resolves.toMatchObject({status:"activated",version:3});
    expect(secondPosts).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM client_hub_native_project_preparations WHERE external_project_id=?").bind(external).first("n")).toBe(3);
  });
  it("updates an existing canonical project whose external ID is not a UUID without widening its frozen scope",async()=>{
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    const external="ops/project-acceptance-20261008-portal-1",command="43000000-0000-4000-8000-000000000001";
    const publicId="5".repeat(32),initialProjection="8".repeat(64),nextProjection="7".repeat(64);
    await createLegacyMappedProject(external);
    const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const readers={inventory:vi.fn(),bindingStatus:vi.fn(async()=>({status:"observed" as const,httpStatus:200 as const,response:{apiVersion:"2" as const,
      sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:crypto.randomUUID(),authorizationGeneration:"8",
      binding:{externalId:external,publicId,createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"},
      resource:{revision:"1",projectionSha256:initialProjection,status:"active" as const,archived:false}}})),project:vi.fn(async()=>({status:"read" as const,httpStatus:200 as const,
      response:{apiVersion:"2" as const,sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId:crypto.randomUUID(),replayed:false as const,accepted:true,
        resource:{type:"project" as const,id:publicId,revision:"1",projectionSha256:initialProjection},data:{name:"Imported legacy project",description:null,
          status:"active" as const,archived:false,overdueWarning:false,completedAt:null,archivedAt:null,estimatedStart:null,estimatedEnd:null,
          clientPublicId:null,organizationPublicId:orgPublic}}}))};
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,
      operation:"update",commandId:command,externalProjectId:external,scopes:[],project:{name:"Updated legacy project",description:"Preserved by explicit edit",
        estimatedStart:null,estimatedEnd:null}},readers as never);
    expect(prepared).toMatchObject({status:"prepared",request:{operation:"update",command:{externalId:external,expectedPublicId:publicId}}});
    if(prepared.status!=="prepared")throw new Error("legacy update prepare failed");
    const send=vi.fn<typeof fetch>(async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));
      const method=input instanceof Request?input.method:init?.method??"GET",requestId=crypto.randomUUID();
      const headers={"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":requestId};
      if(url.pathname==="/api/v2/capabilities")return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,
        requestId,grantedCapabilities:["api.capabilities.read","projects.write","projects.v2.read"].map(name=>({name})),implementedEndpoints:[
          {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
          {method:"POST",path:"/api/v2/projects/profile/commands",requiredCapability:"projects.write",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
          {method:"GET",path:"/api/v2/projects/{publicId}",requiredCapability:"projects.v2.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]}),{headers});
      if(method==="POST")return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId,replayed:false,
        result:{resource:{type:"project",id:external,publicId,revision:"2",projectionSha256:nextProjection},authorizationGeneration:"8",
          presentation:{portalPublished:false,publicLinkEnabled:false}}}),{headers});
      if(url.pathname===`/api/v2/projects/${publicId}`)return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,
        requestId,replayed:false,accepted:true,resource:{type:"project",id:publicId,revision:"2",projectionSha256:nextProjection},
        data:{name:"Updated legacy project",description:"Preserved by explicit edit",status:"active",archived:false,overdueWarning:false,completedAt:null,
          archivedAt:null,estimatedStart:null,estimatedEnd:null,clientPublicId:null,organizationPublicId:orgPublic}}),{headers});
      throw new Error(`unexpected ${method} ${url.pathname}`);});
    const changedScope={...prepared.request,scopes:[{scopeKind:"business_area" as const,businessAreaId:"forged",divisionId:null}]};
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:changedScope},send)).rejects.toMatchObject({status:409});
    expect(send).not.toHaveBeenCalled();
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},send)).resolves.toMatchObject({status:"activated",externalProjectId:external,version:2});
    expect(await db.prepare("SELECT current_version,canonical_projection_sha256 FROM operations_shared_projects WHERE external_project_id=?")
      .bind(external).first()).toEqual({current_version:2,canonical_projection_sha256:nextProjection});
    expect(await db.prepare("SELECT count(*) n FROM client_hub_native_project_preparations WHERE external_project_id=?")
      .bind(external).first("n")).toBe(1);
  });
  it("creates and lists a project for an exact standalone client without fabricating an organization",async()=>{
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    const command="72000000-0000-4000-8000-000000000001",external="72000000-0000-4000-8000-000000000002";
    const project="2".repeat(32),projectHash="3".repeat(64);
    const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,standaloneContext,{expectedContextVersion:standaloneContext.contextVersion,
      commandId:command,externalProjectId:external,scopes:[],project:{name:"Standalone project",description:null,estimatedStart:null,estimatedEnd:null}},inventoryReaders() as never);
    expect(prepared.status).toBe("prepared");if(prepared.status!=="prepared")throw new Error("prepare failed");
    expect(prepared.request.directory).toEqual({organizationRecordId:null,clientRecordId:clientId});
    expect(prepared.request.command.organization).toBeNull();
    expect(prepared.request.command.client).toMatchObject({externalId:clientId,expectedPublicId:clientPublic});
    const send=vi.fn<typeof fetch>(async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));
      const method=input instanceof Request?input.method:init?.method??"GET",requestId=crypto.randomUUID();
      const headers={"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":requestId};
      if(url.pathname==="/api/v2/capabilities")return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId,
        grantedCapabilities:["api.capabilities.read","projects.create","projects.v2.read"].map(name=>({name})),implementedEndpoints:[
          {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},{method:"POST",path:"/api/v2/projects/commands",requiredCapability:"projects.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},{method:"GET",path:"/api/v2/projects/{publicId}",requiredCapability:"projects.v2.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]}),{headers});
      if(method==="POST")return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId,replayed:false,
        result:{resource:{type:"project",id:external,publicId:project,revision:"1",projectionSha256:projectHash},authorizationGeneration:"8",presentation:{portalPublished:false,publicLinkEnabled:false}}}),{status:201,headers});
      if(url.pathname===`/api/v2/projects/${project}`)return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId,applicationId,historyEpoch:historyEpochId,requestId,replayed:false,accepted:true,
        resource:{type:"project",id:project,revision:"1",projectionSha256:projectHash},data:{name:"Standalone project",description:null,status:"active",archived:false,overdueWarning:false,completedAt:null,archivedAt:null,estimatedStart:null,estimatedEnd:null,clientPublicId:clientPublic,organizationPublicId:null}}),{headers});
      throw new Error(`unexpected ${method} ${url.pathname}`);});
    const outcome=await submitClientHubNativeProject(env() as never,request,staff,standaloneContext,
      {expectedContextVersion:standaloneContext.contextVersion,request:prepared.request},send);
    if(outcome.status!=="activated")throw new Error(`standalone outcome ${JSON.stringify(outcome)}`);
    expect(await db.prepare("SELECT organization_record_id,client_record_id FROM operations_shared_projects WHERE external_project_id=?")
      .bind(external).first()).toEqual({organization_record_id:null,client_record_id:clientId});
    const visible=await listClientHubBusinessProjects(env() as never,staff,standaloneContext);
    expect(visible.items).toEqual(expect.arrayContaining([expect.objectContaining({external_project_id:external,origin:"canonical"})]));
  });
  it("leaves zero producer artifacts when first-submit preparation admission expired",async()=>{
    const command="74000000-0000-4000-8000-000000000001",external="74000000-0000-4000-8000-000000000002";
    const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,
      commandId:command,externalProjectId:external,scopes:[],project:{name:"Expired preparation",description:null,estimatedStart:null,estimatedEnd:null}},inventoryReaders() as never);
    expect(prepared.status).toBe("prepared");if(prepared.status!=="prepared")throw new Error("prepare failed");
    await db.prepare("DROP TRIGGER client_hub_native_project_preparations_immutable_update").run();
    await db.prepare("UPDATE client_hub_native_project_preparations SET created_at='1999-01-01T00:00:00.000Z',expires_at='2000-01-01T00:00:00.000Z' WHERE command_id=?").bind(command).run();
    const trigger=splitD1MigrationStatements(readFileSync(new URL("../migrations/0188_client_hub_native_project_preparations.sql",import.meta.url),"utf8"))
      .find(sql=>sql.startsWith("CREATE TRIGGER client_hub_native_project_preparations_immutable_update"));
    if(!trigger)throw new Error("missing preparation immutability trigger fixture");await db.prepare(trigger).run();
    const transport=projectAlphaTransport(external,"Expired preparation");
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},transport.send)).resolves.toMatchObject({status:"uncertain"});
    expect(transport.posts).toBe(0);
    for(const table of ["native_project_command_reservations","project_alpha_project_outbox","native_project_command_proofs",
      "project_alpha_project_v2_events","project_alpha_project_v2_request_fingerprints","project_alpha_project_v2_canonical_intents"])
      expect(await db.prepare(`SELECT count(*) n FROM ${table} WHERE command_id=?`).bind(command).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_destinations WHERE external_project_id=?")
      .bind(external).first("n")).toBe(0);
  });
  it("recovers the exact uncertain POST after equivalent authority generation drift",async()=>{
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO native_business_areas(id,name,active) VALUES('unrelated-area','Unrelated',1)"),
      db.prepare(`INSERT OR IGNORE INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,active,version,granted_by)
        VALUES('grant-unrelated',?,'project.shared.sync','allow','business_area','unrelated-area',1,1,?)`).bind(staff.id,staff.id),
    ]);
    const command="60000000-0000-4000-8000-000000000001",external="60000000-0000-4000-8000-000000000002";
    const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,
      commandId:command,externalProjectId:external,scopes:[],project:{name:"Recovered project",description:null,estimatedStart:null,estimatedEnd:null}},inventoryReaders() as never);
    expect(prepared.status).toBe("prepared");if(prepared.status!=="prepared")throw new Error("prepare failed");
    const lost=projectAlphaTransport(external,"Recovered project",true);
    const lostOutcome=await submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},lost.send);
    if(lostOutcome.status!=="uncertain")throw new Error(`lost outcome ${JSON.stringify(lostOutcome)}`);
    if(lost.posts!==1){const state=await db.prepare("SELECT state,attempts,outcome_json FROM project_alpha_project_outbox WHERE command_id=?").bind(command).all();
      throw new Error(`lost dispatch did not POST ${JSON.stringify({lostOutcome,state:state.results})}`);}
    expect(await db.prepare("SELECT transmission_started_at IS NOT NULL started FROM client_hub_native_project_preparations WHERE command_id=?")
      .bind(command).first("started")).toBe(1);
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(command).first("state")).toBe("terminal");
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-unrelated'").run();
    const tampered={...prepared.request,command:{...prepared.request.command,project:{...prepared.request.command.project,name:"Tampered recovery"}}};
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:tampered},projectAlphaTransport(external,"Tampered").send))
      .rejects.toMatchObject({status:409});
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(command).first("state")).toBe("terminal");
    expect(await db.prepare("SELECT count(*) count FROM client_hub_native_project_recovery_authorizations WHERE command_id=?")
      .bind(command).first("count")).toBe(0);
    await db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'").run();
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},projectAlphaTransport(external,"Revoked").send))
      .rejects.toMatchObject({status:409});
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(command).first("state")).toBe("terminal");
    expect(await db.prepare("SELECT count(*) count FROM client_hub_native_project_recovery_authorizations WHERE command_id=?")
      .bind(command).first("count")).toBe(0);
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    const relationshipState=await db.prepare(`SELECT mapping.record_id,mapping.external_id,mapping.project_alpha_public_id,
      observation.resource_revision,observation.projection_sha256,observation.present,observation.has_conflict,
      observation.binding_external_id,observation.binding_status,observation.binding_resource_revision
      FROM project_alpha_active_directory_mappings mapping JOIN project_alpha_api_v2_directory_observations_current observation
      ON observation.source_id=mapping.source_id AND observation.project_alpha_public_id=mapping.project_alpha_public_id
      WHERE mapping.record_id=?`).bind(orgId).all();
    expect(relationshipState.results).toEqual([expect.objectContaining({external_id:prepared.request.command.organization!.externalId,
      project_alpha_public_id:prepared.request.command.organization!.expectedPublicId,
      resource_revision:prepared.request.command.organization!.expectedRevision,
      projection_sha256:prepared.request.command.organization!.expectedProjectionSha256,present:1,has_conflict:0,
      binding_status:"active"})]);
    const secondLost=projectAlphaTransport(external,"Recovered project",true);
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},secondLost.send)).resolves.toMatchObject({status:"uncertain"});
    expect(secondLost.posts).toBe(1);
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(command).first("state")).toBe("terminal");
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-unrelated'").run();
    const recovered=projectAlphaTransport(external,"Recovered project");
    const recoveryOutcome=await submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},recovered.send);
    if(recoveryOutcome.status!=="activated"){const diagnostics=await Promise.all([
      db.prepare("SELECT state,attempts,outcome_json FROM project_alpha_project_outbox WHERE command_id=?").bind(command).all(),
      db.prepare("SELECT state_version,state FROM project_alpha_project_v2_events WHERE command_id=? ORDER BY state_version").bind(command).all(),
      db.prepare("SELECT authorization_id FROM project_alpha_project_v2_recovery_authorizations WHERE command_id=?").bind(command).all(),
    ]);throw new Error(`recovery outcome ${JSON.stringify({recoveryOutcome,diagnostics:diagnostics.map(value=>value.results)})}`);}
    expect(recovered.posts).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM client_hub_native_project_recovery_authorizations WHERE command_id=?")
      .bind(command).first("count")).toBe(2);
    expect(await db.prepare("SELECT count(*) count FROM client_hub_native_project_post_ack_continuations WHERE command_id=?")
      .bind(command).first("count")).toBe(1);
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},recovered.send)).resolves.toMatchObject({status:"activated",replayed:true});
    expect(recovered.posts).toBe(1);
    await db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'").run();
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},recovered.send)).rejects.toMatchObject({status:409});
  });
  it("reauthorizes an expired lost-ack lease and never resends after acknowledgement",async()=>{
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    const command="70000000-0000-4000-8000-000000000001",external="70000000-0000-4000-8000-000000000002";
    const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,
      commandId:command,externalProjectId:external,scopes:[],project:{name:"Expired lease project",description:null,estimatedStart:null,estimatedEnd:null}},inventoryReaders() as never);
    expect(prepared.status).toBe("prepared");if(prepared.status!=="prepared")throw new Error("prepare failed");
    await db.prepare(`CREATE TRIGGER fixture_abort_client_hub_ack BEFORE INSERT ON project_alpha_project_v2_success_receipts
      WHEN NEW.command_id='70000000-0000-4000-8000-000000000001' BEGIN SELECT RAISE(ABORT,'fixture lost ack'); END`).run();
    const transport=projectAlphaTransport(external,"Expired lease project");
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},transport.send)).resolves.toMatchObject({status:"uncertain"});
    expect(transport.posts).toBe(1);
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},transport.send)).resolves.toMatchObject({status:"uncertain",reason:"lost_ack"});
    expect(transport.posts).toBe(1);
    await db.batch([db.prepare("DROP TRIGGER fixture_abort_client_hub_ack"),
      db.prepare("UPDATE project_alpha_project_outbox SET lease_expires_at=0 WHERE command_id=? AND state='leased'").bind(command)]);
    await db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'").run();
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},transport.send)).rejects.toMatchObject({status:409});
    expect(transport.posts).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM client_hub_native_project_recovery_renewal_receipts WHERE command_id=?")
      .bind(command).first("n")).toBe(0);
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},transport.send)).resolves.toMatchObject({status:"activated"});
    expect(transport.posts).toBe(2);
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},transport.send)).resolves.toMatchObject({status:"activated",replayed:true});
    expect(transport.posts).toBe(2);
    expect(await db.prepare("SELECT authorization_reason FROM client_hub_native_project_recovery_renewal_receipts WHERE command_id=?")
      .bind(command).first("authorization_reason")).toBe("expired_lease");
  });
  it("renews an expired bound authorization after an unsent preflight failure",async()=>{
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    const command="71000000-0000-4000-8000-000000000001",external="71000000-0000-4000-8000-000000000002";
    const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,
      commandId:command,externalProjectId:external,scopes:[],project:{name:"Renewed unsent project",description:null,estimatedStart:null,estimatedEnd:null}},inventoryReaders() as never);
    expect(prepared.status).toBe("prepared");if(prepared.status!=="prepared")throw new Error("prepare failed");
    const lost=projectAlphaTransport(external,"Renewed unsent project",true);
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},lost.send)).resolves.toMatchObject({status:"uncertain"});
    auth.current.mockResolvedValueOnce({identity:{staffId:staff.id,email:staff.email,verifiedAccessSubject:staff.accessSubject,profileVersion:1},
      admissionVersion:1,verifiedUntil:new Date(Date.now()+1_200).toISOString()});
    const preflight=vi.fn<typeof fetch>(async()=>new Response("unavailable",{status:503}));
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},preflight)).resolves.toMatchObject({status:"blocked",reason:"preflight"});
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(command).first("state")).toBe("pending");
    await new Promise(resolve=>setTimeout(resolve,2_500));
    const expiry=await db.prepare(`SELECT authorization.expires_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') now,
      (SELECT count(*) FROM client_hub_native_project_live_recovery_authorizations live WHERE live.command_id=authorization.command_id) live_count
      FROM client_hub_native_project_recovery_authorizations authorization WHERE authorization.command_id=?`).bind(command).first();
    expect(expiry).toMatchObject({live_count:0});
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO native_business_areas(id,name,active) VALUES('renew-area','Renew',1)"),
      db.prepare(`INSERT OR IGNORE INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,active,version,granted_by)
        VALUES('grant-renew-area',?,'project.shared.sync','allow','business_area','renew-area',1,1,?)`).bind(staff.id,staff.id),
    ]);
    const recovered=projectAlphaTransport(external,"Renewed unsent project");
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},recovered.send)).resolves.toMatchObject({status:"activated"});
    expect(recovered.posts).toBe(1);
    expect(await db.prepare("SELECT authorization_reason FROM client_hub_native_project_recovery_renewal_receipts WHERE command_id=?")
      .bind(command).first("authorization_reason")).toBe("expired_unsent");
  });
  it("stores a factual ACK but requires fresh authority to settle after an in-flight revoke",async()=>{
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    const command="75000000-0000-4000-8000-000000000001",external="75000000-0000-4000-8000-000000000002";
    const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
    const prepared=await prepareClientHubNativeProject(env() as never,request,staff,context,{expectedContextVersion:context.contextVersion,
      commandId:command,externalProjectId:external,scopes:[],project:{name:"In-flight revoke",description:null,estimatedStart:null,estimatedEnd:null}},inventoryReaders() as never);
    expect(prepared.status).toBe("prepared");if(prepared.status!=="prepared")throw new Error("prepare failed");
    const lost=projectAlphaTransport(external,"In-flight revoke",true);
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},lost.send)).resolves.toMatchObject({status:"uncertain"});
    const acknowledged=projectAlphaTransport(external,"In-flight revoke");
    const revokeDuringAck=vi.fn<typeof fetch>(async(input,init)=>{const response=await acknowledged.send(input,init);
      const method=input instanceof Request?input.method:init?.method??"GET";
      if(method==="POST")await db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'").run();
      return response;});
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},revokeDuringAck)).resolves.toMatchObject({status:"blocked",reason:"authority"});
    expect(acknowledged.posts).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_success_receipts WHERE command_id=?").bind(command).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM client_hub_native_project_post_ack_continuations WHERE command_id=?").bind(command).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM operations_shared_projects WHERE external_project_id=?").bind(external).first("n")).toBe(0);
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    await expect(submitClientHubNativeProject(env() as never,request,staff,context,
      {expectedContextVersion:context.contextVersion,request:prepared.request},acknowledged.send)).resolves.toMatchObject({status:"activated"});
    expect(acknowledged.posts).toBe(1);
  });
  it("recovers expired leased and expired-unsent attempts for an exact standalone client owner",async()=>{
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    for(const scenario of ["expired_lease","expired_unsent"] as const){
      const digit=scenario==="expired_lease"?"76000000":"77000000";
      const command=`${digit}-0000-4000-8000-000000000001`,external=`${digit}-0000-4000-8000-000000000002`;
      const request=new Request("https://ops.example.test/client",{headers:{Authorization:"Bearer local","Idempotency-Key":command}});
      const prepared=await prepareClientHubNativeProject(env() as never,request,staff,standaloneContext,{expectedContextVersion:standaloneContext.contextVersion,
        commandId:command,externalProjectId:external,scopes:[],project:{name:`Standalone ${scenario}`,description:null,estimatedStart:null,estimatedEnd:null}},inventoryReaders() as never);
      expect(prepared.status).toBe("prepared");if(prepared.status!=="prepared")throw new Error("prepare failed");
      const lost=standaloneTransport(external,`Standalone ${scenario}`,true);
      await expect(submitClientHubNativeProject(env() as never,request,staff,standaloneContext,
        {expectedContextVersion:standaloneContext.contextVersion,request:prepared.request},lost.send)).resolves.toMatchObject({status:"uncertain"});
      if(scenario==="expired_lease"){
        await db.prepare(`CREATE TRIGGER fixture_abort_standalone_ack BEFORE INSERT ON project_alpha_project_v2_success_receipts
          WHEN NEW.command_id='76000000-0000-4000-8000-000000000001' BEGIN SELECT RAISE(ABORT,'fixture lost ack'); END`).run();
        // The first synthetic loss is terminal; reopen once, then make the
        // second successfully-returned ACK batch fail so its lease expires.
        const ack=standaloneTransport(external,`Standalone ${scenario}`,false,"7");
        await expect(submitClientHubNativeProject(env() as never,request,staff,standaloneContext,
          {expectedContextVersion:standaloneContext.contextVersion,request:prepared.request},ack.send)).resolves.toMatchObject({status:"uncertain"});
        await db.batch([db.prepare("DROP TRIGGER fixture_abort_standalone_ack"),db.prepare("UPDATE project_alpha_project_outbox SET lease_expires_at=0 WHERE command_id=?").bind(command)]);
        const recovered=standaloneTransport(external,`Standalone ${scenario}`,false,"7");
        await expect(submitClientHubNativeProject(env() as never,request,staff,standaloneContext,
          {expectedContextVersion:standaloneContext.contextVersion,request:prepared.request},recovered.send)).resolves.toMatchObject({status:"activated"});
      }else{
        auth.current.mockResolvedValueOnce({identity:{staffId:staff.id,email:staff.email,verifiedAccessSubject:staff.accessSubject,profileVersion:1},
          admissionVersion:1,verifiedUntil:new Date(Date.now()+1_200).toISOString()});
        const preflight=vi.fn<typeof fetch>(async()=>new Response("unavailable",{status:503}));
        await expect(submitClientHubNativeProject(env() as never,request,staff,standaloneContext,
          {expectedContextVersion:standaloneContext.contextVersion,request:prepared.request},preflight)).resolves.toMatchObject({status:"blocked",reason:"preflight"});
        await new Promise(resolve=>setTimeout(resolve,2_500));
        await db.prepare("UPDATE native_project_grants SET version=version+1 WHERE id='grant-native'").run();
        const recovered=standaloneTransport(external,`Standalone ${scenario}`,false,"9");
        await expect(submitClientHubNativeProject(env() as never,request,staff,standaloneContext,
          {expectedContextVersion:standaloneContext.contextVersion,request:prepared.request},recovered.send)).resolves.toMatchObject({status:"activated"});
      }
      expect(await db.prepare("SELECT organization_record_id,client_record_id FROM operations_shared_projects WHERE external_project_id=?")
        .bind(external).first()).toEqual({organization_record_id:null,client_record_id:clientId});
    }
  });
  it("binds both identifiers and permits only the one-way first-transmission transition", async () => {
    await insert();
    await expect(insert(commandId,"10000000-0000-4000-8000-000000000003")).rejects.toThrow();
    await expect(insert("10000000-0000-4000-8000-000000000004",externalId)).resolves.toMatchObject({success:true});
    expect(await db.prepare("SELECT count(*) n FROM client_hub_native_project_preparations WHERE external_project_id=?")
      .bind(externalId).first("n")).toBe(2);
    await expect(db.prepare("UPDATE client_hub_native_project_preparations SET request_json='{}' WHERE command_id=?")
      .bind(commandId).run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM client_hub_native_project_preparations WHERE command_id=?")
      .bind(commandId).run()).rejects.toThrow(/cannot be deleted/);
    await db.prepare(`UPDATE client_hub_native_project_preparations
      SET transmission_started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).bind(commandId).run();
    await expect(db.prepare(`UPDATE client_hub_native_project_preparations
      SET transmission_started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE command_id=?`).bind(commandId).run())
      .rejects.toThrow(/immutable/);
    await expect(db.prepare(`UPDATE client_hub_native_project_preparations
      SET transmission_started_at=NULL WHERE command_id=?`).bind(commandId).run()).rejects.toThrow(/immutable/);
  });

  it("enforces a base64url SHA-256 shape and a bounded pre-transmission expiry", async () => {
    await expect(db.prepare(`INSERT INTO client_hub_native_project_preparations(
      command_id,external_project_id,request_json,request_sha256,context_source_id,context_root_namespace,context_root_kind,
      context_root_public_id,context_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,
      actor_profile_version,authority_generation,source_instance_id,application_id,history_epoch_id)
      VALUES('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000006','{}',?,'s','business','organization',
      'o','c','staff','subject','staff@example.test',1,1,1,'a','b','c')`).bind("!".repeat(43)).run()).rejects.toThrow();
    const row = await db.prepare("SELECT created_at,expires_at FROM client_hub_native_project_preparations WHERE command_id=?")
      .bind(commandId).first<{ created_at: string; expires_at: string }>();
    expect(row).not.toBeNull();
    expect(Date.parse(row!.expires_at)-Date.parse(row!.created_at)).toBe(15*60*1000);
  });

  it("rejects preparation when the exact owner observation changes after readiness", async () => {
    await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'").run();
    const requestId="30000000-0000-4000-8000-000000000099";
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(
        source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,
        authorization_generation,page_sha256,item_count)
        VALUES('project-alpha:primary',?,?,?,'directory',?,'99',?,1)`)
        .bind(sourceInstanceId,applicationId,historyEpochId,requestId,"9".repeat(64)),
      db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(
        source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,
        project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
        binding_external_id,binding_status,binding_resource_revision)
        VALUES('project-alpha:primary',?,?,?,?,'organization',?,'4',0,'delete',?,?,'tombstoned','4')`)
        .bind(sourceInstanceId,applicationId,historyEpochId,requestId,orgPublic,"8".repeat(64),orgId),
    ]);
    const driftCommand="39000000-0000-4000-8000-000000000099";
    await expect(insert(driftCommand,"39000000-0000-4000-8000-000000000098"))
      .rejects.toThrow(/authority is not current and exact/);
    expect(await db.prepare("SELECT count(*) n FROM client_hub_native_project_preparations WHERE command_id=?")
      .bind(driftCommand).first("n")).toBe(0);
  });
});
