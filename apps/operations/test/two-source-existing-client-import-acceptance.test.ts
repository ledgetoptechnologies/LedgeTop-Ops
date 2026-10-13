import { Miniflare } from "miniflare";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { writeNativeDirectoryProfile } from "../src/worker/native-directory-profile-writer";
import { acquireProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-binding-review-consumer";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";
import { applyCanonicalChain,applyCanonicalTail,canonicalOwner } from "./helpers/verified-recipient-canonical-lineage";
import { buildSyntheticOnboardingOperatorInput,cleanupSyntheticOnboardingOperator,
  provisionSyntheticOnboardingOperator } from "./helpers/synthetic-onboarding-operator-authority";

const area="staging-native-only-existing-client",recordId="83000000-0000-4000-8000-000000000001",lttOnlyRecordId="83000000-0000-4000-8000-000000000003";
const sources=[
  {sourceId:"project-alpha:ltds-staging",baseUrl:"https://ltds-pa.example.test",sourceInstanceId:"83100000-0000-4000-8000-000000000001",applicationId:"83100000-0000-4000-8000-000000000002",historyEpoch:"83100000-0000-4000-8000-000000000003",externalId:"ltds/client/overlap",publicId:"1".repeat(32)},
  {sourceId:"project-alpha:ltt-staging",baseUrl:"https://ltt-pa.example.test",sourceInstanceId:"83200000-0000-4000-8000-000000000001",applicationId:"83200000-0000-4000-8000-000000000002",historyEpoch:"83200000-0000-4000-8000-000000000003",externalId:"ltt/client/overlap",publicId:"2".repeat(32)},
] as const;
const seed={sourceId:"project-alpha:primary",baseUrl:"https://seed-pa.example.test",sourceInstanceId:"83300000-0000-4000-8000-000000000001",applicationId:"83300000-0000-4000-8000-000000000002",historyEpoch:"83300000-0000-4000-8000-000000000003"} as const;
const lttOnly={externalId:"ltt/client/only",publicId:"5".repeat(32)} as const;
const connections=JSON.stringify({version:1,instances:Object.fromEntries([...sources,seed].map(source=>[source.sourceId,{sourceId:source.sourceId,
  baseUrl:source.baseUrl,sourceInstanceId:source.sourceInstanceId,applicationId:source.applicationId,historyEpoch:source.historyEpoch,
  enabled:true,apiKey:"fixture-secret"}]))});
const seedConnections=JSON.stringify({version:1,instances:{[seed.sourceId]:{...seed,enabled:true,apiKey:"fixture-secret"}}});
const reviewer=(generation:number)=>({staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject,
  admissionVersion:1,profileVersion:1,grantGeneration:generation});
const uid=(prefix:string,n:number)=>`${prefix}000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const seen:string[]=[];

function remote():typeof fetch{
  const generations=new Map(sources.map(source=>[source.sourceId,"8"]));
  return vi.fn<typeof fetch>(async(input,init)=>{
    const url=new URL(String(input)),source=sources.find(item=>new URL(item.baseUrl).host===url.host);
    seen.push(`${init?.method??"GET"} ${url.host}${url.pathname}`);
    if(!source)throw Error("unexpected source host");
    const generation=generations.get(source.sourceId)!,requestId=crypto.randomUUID();
    const reply=(body:Record<string,unknown>)=>Response.json({...body,requestId},{headers:{"Cache-Control":"no-store","X-Request-ID":requestId}});
    if(url.pathname==="/api/v2/capabilities")return reply({apiVersion:"2",sourceInstanceId:source.sourceInstanceId,
      applicationId:source.applicationId,historyEpoch:source.historyEpoch,grantedCapabilities:["api.capabilities.read","directory.clients.read",
        "directory.clients.binding_status.read","directory.clients.bind"].map(name=>({name})),implementedEndpoints:[
        {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
        {method:"GET",path:"/api/v2/directory/clients/{publicId}",requiredCapability:"directory.clients.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
        {method:"GET",path:"/api/v2/bindings/client/status/{base64urlExternalId}",requiredCapability:"directory.clients.binding_status.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
        {method:"POST",path:"/api/v2/directory/clients/bindings/commands",requiredCapability:"directory.clients.bind",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true,requiresExpectedPublicId:true,requiresExpectedRevision:true}]});
    const selectedPublic=url.pathname===`/api/v2/directory/clients/${lttOnly.publicId}`?lttOnly.publicId:source.publicId;
    if(url.pathname===`/api/v2/directory/clients/${selectedPublic}`)return reply({apiVersion:"2",sourceInstanceId:source.sourceInstanceId,
      applicationId:source.applicationId,historyEpoch:source.historyEpoch,authorizationGeneration:generation,
      resource:{type:"client",id:selectedPublic,revision:"7"},data:{publicId:selectedPublic,name:"Same overlapping client",
        email:"same-overlap@example.test",phone:null,clientType:"consumer",organizationPublicId:null,
        address:{line1:null,line2:null,city:"Austin",state:"TX",postalCode:"78701",country:"US"}}});
    const bindingLttOnly=url.pathname===`/api/v2/bindings/client/status/${Buffer.from(lttOnly.externalId).toString("base64url")}`;
    const selectedExternal=bindingLttOnly?lttOnly.externalId:source.externalId,bindingPublic=bindingLttOnly?lttOnly.publicId:source.publicId;
    if(url.pathname===`/api/v2/bindings/client/status/${Buffer.from(selectedExternal).toString("base64url")}`)return reply({apiVersion:"2",
      sourceInstanceId:source.sourceInstanceId,applicationId:source.applicationId,historyEpoch:source.historyEpoch,authorizationGeneration:generation,
      binding:{type:"client",externalId:selectedExternal,publicId:bindingPublic,createdAt:"2026-10-12T00:00:00.000Z"},resource:{revision:"7",present:true}});
    if(url.pathname==="/api/v2/directory/clients/bindings/commands"){
      const body=JSON.parse(String(init?.body));
      const next=String(BigInt(generation)+1n);generations.set(source.sourceId,next);
      return reply({replayed:false,sourceInstanceId:source.sourceInstanceId,applicationId:source.applicationId,historyEpoch:source.historyEpoch,
        result:{binding:{publicId:body.expectedPublicId},resource:{type:"client",id:body.externalId,revision:"7"},authorizationGeneration:next}});
    }
    throw Error(`unexpected PA request ${url.pathname}`);
  });
}
function seedRemote():typeof fetch{return vi.fn<typeof fetch>(async(input,init)=>{
  const path=new URL(String(input)).pathname,requestId=crypto.randomUUID(),reply=(body:Record<string,unknown>,status=200)=>
    Response.json({...body,requestId},{status,headers:{"Cache-Control":"no-store","X-Request-ID":requestId}});
  if(path==="/api/v2/capabilities")return reply({apiVersion:"2",sourceInstanceId:seed.sourceInstanceId,applicationId:seed.applicationId,
    historyEpoch:seed.historyEpoch,grantedCapabilities:["api.capabilities.read","directory.inventory.read","directory.clients.create"].map(name=>({name})),implementedEndpoints:[
      {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
      {method:"GET",path:"/api/v2/directory/inventory",requiredCapability:"directory.inventory.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
      {method:"POST",path:"/api/v2/directory/clients/commands",requiredCapability:"directory.clients.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]});
  if(path==="/api/v2/directory/inventory")return reply({apiVersion:"2",sourceInstanceId:seed.sourceInstanceId,applicationId:seed.applicationId,
    historyEpoch:seed.historyEpoch,authorizationGeneration:"0",resources:[],nextCursor:null});
  const body=JSON.parse(String(init?.body));const publicId=String(body.externalId).endsWith("3")?"4".repeat(32):"3".repeat(32);
  return reply({replayed:false,sourceInstanceId:seed.sourceInstanceId,applicationId:seed.applicationId,
    historyEpoch:seed.historyEpoch,result:{resource:{type:"client",id:body.externalId,publicId,revision:"1"},authorizationGeneration:"1"}},201);
});}
async function snapshot(db:D1Database,tables:readonly string[]){return Object.fromEntries(await Promise.all(tables.map(async table=>
  [table,JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results)] as const)));}

describe("two-source governed existing-client import acceptance",()=>{
  let runtime:Miniflare,db:D1Database,generation:number,authority:Awaited<ReturnType<typeof provisionSyntheticOnboardingOperator>>;
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID()}});
    db=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await applyCanonicalChain(db,"operations","0183_project_alpha_binding_standalone_relationship_rows.sql",true,canonicalOwner.accessSubject);
    await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,'Existing client import',1)").bind(area).run();
    const clock=await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp").first<string>("stamp");
    authority=await provisionSyntheticOnboardingOperator(db,await buildSyntheticOnboardingOperatorInput(db,{staffId:canonicalOwner.operationsStaffId,
      email:canonicalOwner.email,displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,businessAreaId:area,
      issuedAt:new Date(Date.parse(clock!)-60_000).toISOString(),expiresAt:new Date(Date.parse(clock!)+3_600_000).toISOString(),executedAt:clock!}));
    const scope={businessAreaId:area,divisionId:null},profile={name:"Local reviewed client",email:"local@example.test",phone:"",clientType:"consumer" as const,
      addressLine1:"",addressLine2:"",city:"Austin",state:"TX",postalCode:"78701",country:"US"};
    const create=async(currentRecordId:string,suffix:string)=>{const admissionId=`existing-client-admission-${suffix}`;
      const destination={sourceId:seed.sourceId,sourceInstanceUUID:seed.sourceInstanceId,applicationUUID:seed.applicationId,historyEpoch:seed.historyEpoch,
        origin:seed.baseUrl,externalCanonicalId:currentRecordId,expectedAuthorizationGeneration:"0"};
      await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
        VALUES(?,?,?,?,'client',?,?,?,?)`).bind(admissionId,canonicalOwner.operationsStaffId,canonicalOwner.accessSubject,currentRecordId,JSON.stringify([scope]),JSON.stringify(profile),JSON.stringify([{...destination,expectedAuthorizationGeneration:undefined}]),canonicalOwner.operationsStaffId).run();
      await db.prepare(`INSERT INTO native_directory_create_admission_relationships
        (create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,NULL,NULL)`).bind(admissionId,currentRecordId).run();
      const written=await writeNativeDirectoryProfile(db,{operation:"create",mutationId:`83000000-0000-4000-8000-${suffix.padStart(12,"0")}`,recordId:currentRecordId,
        expectedLocalVersion:0,kind:"client",profile,scopes:[scope],destinations:[destination],createAdmissionId:admissionId,actor:{staffId:canonicalOwner.operationsStaffId,
          accessSubject:canonicalOwner.accessSubject,admissionVersion:1,loginEmail:canonicalOwner.email,profileVersion:1,
          selectedGrantId:authority.input.grantIds[0],selectedIdentityGrantId:authority.input.grantIds[1]},relationship:{organizationRecordId:null,expectedRelationshipVersion:0}});
      if(written.status!=="written")throw Error(JSON.stringify(written));
      const seeded=await dispatchProjectAlphaDirectoryProfileOutboxCommand({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:seedConnections},seed.sourceId,
        written.commandIds[0]!,seedRemote());if(seeded.status!=="acknowledged")throw Error(JSON.stringify(seeded));};
    await create(recordId,"2");await create(lttOnlyRecordId,"4");
    generation=3;await applyCanonicalTail(db,"0183_project_alpha_binding_standalone_relationship_rows.sql","0200_native_directory_active_binding_refresh_supersessions.sql");
  },240_000);
  afterAll(async()=>runtime.dispose());

  it("keeps identical LTDS/LTT client fields source-scoped and requires explicit acquisition per source",async()=>{
    const preserved=["operations_shared_projects","sop_documents","project_folders","folder_rules","client_portal_workspace_binding_selections"] as const;
    const before=await snapshot(db,preserved),fetcher=remote(),baseCount=await db.prepare("SELECT count(*) count FROM project_alpha_active_directory_mappings").first("count");
    expect(await db.prepare("SELECT count(*) count FROM folder_rules").first("count")).toBe(2);
    const ltt=sources[1],lttRequest={reviewId:uid("89",1),commandId:uid("90",1),sourceId:ltt.sourceId,recordId:lttOnlyRecordId,
      externalId:lttOnly.externalId,resourceType:"client" as const,projectAlphaPublicId:lttOnly.publicId,expectedProjectAlphaRevision:"7",
      expectedAuthorizationGeneration:"8",localRecordVersion:1,reviewer:reviewer(generation)};
    const lttAcquired=await acquireProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},lttRequest,fetcher);
    if(lttAcquired.status!=="acquired")throw Error(JSON.stringify(lttAcquired));
    await expect(activateProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
      {reviewItemId:lttAcquired.reviewReceiptId,idempotencyKey:uid("91",1)},
      {staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject},fetcher)).resolves.toMatchObject({status:"activated"});
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_active_directory_mappings WHERE record_id=? AND source_id=?`)
      .bind(lttOnlyRecordId,ltt.sourceId).first("count")).toBe(1);
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_active_directory_mappings WHERE record_id=? AND source_id=?`)
      .bind(lttOnlyRecordId,sources[0].sourceId).first("count")).toBe(0);
    let firstActivationKey="";
    for(const[index,source]of sources.entries()){
      const request={reviewId:uid("84",index+1),commandId:uid("85",index+1),sourceId:source.sourceId,recordId,externalId:source.externalId,
        resourceType:"client" as const,projectAlphaPublicId:source.publicId,expectedProjectAlphaRevision:"7",expectedAuthorizationGeneration:index===1?"9":"8",
        localRecordVersion:1,reviewer:reviewer(generation)};
      if(index===0){
        const wrongBase=remote(),wrongIdentity=vi.fn<typeof fetch>(async(input,init)=>{const response=await wrongBase(input,init);
          const body=await response.json() as Record<string,unknown>;return Response.json({...body,sourceInstanceId:sources[1].sourceInstanceId},
            {status:response.status,headers:response.headers});});
        const wrong=await acquireProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
          {...request,reviewId:uid("87",1),commandId:uid("88",1)},wrongIdentity);
        expect(wrong.status).not.toBe("acquired");
        expect(await db.prepare("SELECT count(*) count FROM project_alpha_active_directory_mappings").first("count")).toBe(Number(baseCount)+1);
      }
      const acquired=await acquireProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},request,fetcher);
      if(acquired.status!=="acquired")throw Error(JSON.stringify({acquired,seen}));
      if(index===0)await expect(acquireProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        {...request,sourceId:sources[1].sourceId},fetcher)).resolves.toMatchObject({status:"conflict"});
      const key=uid("86",index+1),activated=await activateProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        {reviewItemId:acquired.reviewReceiptId,idempotencyKey:key},{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject},fetcher);
      expect(activated).toMatchObject({status:"activated",replayed:false,recordId});
      await expect(acquireProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},request,fetcher))
        .resolves.toMatchObject({status:"acquired",replayed:true});
      await expect(activateProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        {reviewItemId:acquired.reviewReceiptId,idempotencyKey:key},{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject},fetcher))
        .resolves.toMatchObject({status:"activated",replayed:true});
      if(index===0)firstActivationKey=key;
      else await expect(activateProjectAlphaExistingDirectoryBinding({OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections},
        {reviewItemId:acquired.reviewReceiptId,idempotencyKey:firstActivationKey},
        {staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject},fetcher))
        .resolves.toMatchObject({status:"conflict"});
      if(index===0){
        expect(await db.prepare(`SELECT count(*) count FROM project_alpha_active_directory_mappings WHERE record_id=? AND source_id=?`)
          .bind(recordId,sources[0].sourceId).first("count")).toBe(1);
        expect(await db.prepare(`SELECT count(*) count FROM project_alpha_active_directory_mappings WHERE record_id=? AND source_id=?`)
          .bind(recordId,sources[1].sourceId).first("count")).toBe(0);
      }
    }
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_active_directory_mappings WHERE record_id=? AND resource_type='client'
      AND source_id IN (?,?)`).bind(recordId,sources[0].sourceId,sources[1].sourceId).first("count")).toBe(2);
    expect(await snapshot(db,preserved)).toEqual(before);
    await cleanupSyntheticOnboardingOperator(db,authority);
  },240_000);
});
