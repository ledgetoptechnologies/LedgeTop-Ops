import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issueClientOnboardingInvitation } from "../src/worker/client-onboarding-issuance";
import { submitClientOnboarding } from "../src/worker/client-onboarding-submissions";
import { approveNativeOnlyClientOnboarding } from "../src/worker/native-directory-onboarding-write-composer";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";
import { applyCanonicalChain, applyCanonicalTail, canonicalOwner } from "./helpers/verified-recipient-canonical-lineage";
import { buildSyntheticOnboardingOperatorInput, cleanupSyntheticOnboardingOperator,
  provisionSyntheticOnboardingOperator } from "./helpers/synthetic-onboarding-operator-authority";

const area="staging-native-only-two-source-client";
const sources=[
  {sourceId:"project-alpha:ltds-staging",baseUrl:"https://ltds-pa.example.test",sourceInstanceId:"81000000-0000-4000-8000-000000000001",applicationId:"81000000-0000-4000-8000-000000000002",historyEpoch:"81000000-0000-4000-8000-000000000003"},
  {sourceId:"project-alpha:ltt-staging",baseUrl:"https://ltt-pa.example.test",sourceInstanceId:"82000000-0000-4000-8000-000000000001",applicationId:"82000000-0000-4000-8000-000000000002",historyEpoch:"82000000-0000-4000-8000-000000000003"},
] as const;
const connections=JSON.stringify({version:1,instances:Object.fromEntries(sources.map(source=>[source.sourceId,{...source,enabled:true,apiKey:"fixture-secret"}]))});
const id=(n:number)=>`80000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
async function derivedUuid(seed:string){const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(seed))).slice(0,16);
  digest[6]=(digest[6]!&15)|64;digest[8]=(digest[8]!&63)|128;const h=[...digest].map(value=>value.toString(16).padStart(2,"0")).join("");
  return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}

function remote():typeof fetch{return vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(String(input)),source=sources.find(item=>new URL(item.baseUrl).host===url.host);
  if(!source)throw Error("unexpected source");
  const requestId=crypto.randomUUID(),reply=(body:Record<string,unknown>,status=200)=>Response.json({...body,requestId},{status,headers:{"Cache-Control":"no-store","X-Request-ID":requestId}});
  if(url.pathname==="/api/v2/capabilities")return reply({apiVersion:"2",sourceInstanceId:source.sourceInstanceId,
    applicationId:source.applicationId,historyEpoch:source.historyEpoch,grantedCapabilities:["api.capabilities.read","directory.inventory.read","directory.clients.create"].map(name=>({name})),
    implementedEndpoints:[{method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
      {method:"GET",path:"/api/v2/directory/inventory",requiredCapability:"directory.inventory.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
      {method:"POST",path:"/api/v2/directory/clients/commands",requiredCapability:"directory.clients.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]});
  if(url.pathname==="/api/v2/directory/inventory")return reply({apiVersion:"2",sourceInstanceId:source.sourceInstanceId,
    applicationId:source.applicationId,historyEpoch:source.historyEpoch,authorizationGeneration:"7",
    resources:[],nextCursor:null});
  if(url.pathname==="/api/v2/directory/clients/commands"){
    const body=JSON.parse(String(init?.body));
    return reply({replayed:false,sourceInstanceId:source.sourceInstanceId,applicationId:source.applicationId,
      historyEpoch:source.historyEpoch,result:{resource:{type:"client",id:body.externalId,publicId:"d".repeat(32),revision:"1"},
        authorizationGeneration:"8"}},201);
  }
  throw Error(`unexpected request ${url.pathname}`);
});}

describe("two-source governed standalone-client onboarding acceptance",()=>{
  let runtime:Miniflare,db:D1Database,authority:Awaited<ReturnType<typeof provisionSyntheticOnboardingOperator>>;
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID()}});
    db=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await applyCanonicalChain(db,"operations","0183_project_alpha_binding_standalone_relationship_rows.sql",true,canonicalOwner.accessSubject);
    await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,'Two-source governed client area',1)").bind(area).run();
    const clock=await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp").first<string>("stamp");
    const input=await buildSyntheticOnboardingOperatorInput(db,{staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,
      displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,businessAreaId:area,
      issuedAt:new Date(Date.parse(clock!)-60_000).toISOString(),expiresAt:new Date(Date.parse(clock!)+3_600_000).toISOString(),executedAt:clock!});
    authority=await provisionSyntheticOnboardingOperator(db,input);
    await applyCanonicalTail(db,"0183_project_alpha_binding_standalone_relationship_rows.sql","0200_native_directory_active_binding_refresh_supersessions.sql");
  },240_000);
  afterAll(async()=>runtime.dispose());

  it("rejects wrong area, expiry, duplicate identities, and rolls back a valid late provision failure",async()=>{
    const isolated=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID()}});
    const other=await isolated.getD1Database("OPS_DB") as unknown as D1Database;
    await applyCanonicalChain(other,"operations","0183_project_alpha_binding_standalone_relationship_rows.sql",true,canonicalOwner.accessSubject);
    await other.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,'Negative area',1)").bind(area).run();
    const clock=await other.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp").first<string>("stamp");
    const valid=await buildSyntheticOnboardingOperatorInput(other,{staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,
      displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,businessAreaId:area,
      issuedAt:new Date(Date.parse(clock!)-60_000).toISOString(),expiresAt:new Date(Date.parse(clock!)+3_600_000).toISOString(),executedAt:clock!});
    await expect(provisionSyntheticOnboardingOperator(other,{...valid,businessAreaId:"wrong-area"})).rejects.toThrow();
    await expect(provisionSyntheticOnboardingOperator(other,{...valid,email:"other@example.test"})).rejects.toThrow();
    await expect(provisionSyntheticOnboardingOperator(other,{...valid,accessSubject:"acct:wrong-subject"})).rejects.toThrow();
    await expect(provisionSyntheticOnboardingOperator(other,{...valid,expiresAt:new Date(Date.parse(clock!)-1).toISOString()})).rejects.toThrow();
    await expect(provisionSyntheticOnboardingOperator(other,{...valid,grantIds:[valid.grantIds[0],valid.grantIds[0],valid.grantIds[2]]})).rejects.toThrow();
    await expect(provisionSyntheticOnboardingOperator(other,valid,{lateFailure:true})).rejects.toThrow();
    expect(await other.prepare("SELECT count(*) count FROM native_staff_admissions WHERE staff_id=?")
      .bind(canonicalOwner.operationsStaffId).first("count")).toBe(0);
    expect(await other.prepare("SELECT count(*) count FROM native_directory_grants WHERE staff_id=?")
      .bind(canonicalOwner.operationsStaffId).first("count")).toBe(0);
    expect(await other.prepare("SELECT count(*) count FROM native_staff_bootstrap_approvals WHERE approval_id=?")
      .bind(valid.approvalId).first("count")).toBe(0);
    await isolated.dispose();
  },240_000);

  it("rejects provision replay without changing the existing authority",async()=>{
    await expect(provisionSyntheticOnboardingOperator(db,authority.input,{lateFailure:true})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) count FROM native_staff_admissions WHERE staff_id=? AND active=1 AND version=1")
      .bind(canonicalOwner.operationsStaffId).first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM native_directory_grants WHERE staff_id=? AND active=1")
      .bind(canonicalOwner.operationsStaffId).first("count")).toBe(3);
  });

  it("issues, submits, and approves one null-parent client into exactly two explicit PA sources, then cleans authority",async()=>{
    const auth={identity:{kind:"native" as const,staffId:canonicalOwner.operationsStaffId,
      verifiedAccessSubject:canonicalOwner.accessSubject,email:canonicalOwner.email,displayName:canonicalOwner.displayName,
      profileVersion:1},admissionVersion:1,verifiedUntil:new Date(Date.now()+1_800_000).toISOString()};
    const invitationSecret="9".repeat(64),invitationId=id(1),submissionId=id(2);
    await expect(issueClientOnboardingInvitation(db,{authenticatedNativeStaff:{identity:auth.identity,verifiedUntil:auth.verifiedUntil},
      request:{commandId:id(3),invitationId,invitationSecret,expiresAt:new Date(Date.now()+3_600_000).toISOString(),
        targetClientRecordId:null,scopes:[{businessAreaId:area,divisionId:null}]}})).resolves.toMatchObject({state:"pending"});
    const fields={clientType:"consumer" as const,name:"Two-source new client",email:"two-source-new-client@example.test",phone:"",
      organizationName:"",organizationEmail:"",organizationPhone:"",addressLine1:"",addressLine2:"",city:"Austin",state:"TX",postalCode:"78701",country:"US"};
    const submission=await submitClientOnboarding(db,{invitationId,invitationSecret,submissionId,fields});
    const recordId=id(4),mutationId=id(5),decisionId=id(6),relationshipMutationId=await derivedUuid(`${mutationId}\0client-relationship\0unlinked`);
    const approved=await approveNativeOnlyClientOnboarding(db,{decisionId,invitationId,submissionId,
      fieldsSha256:submission.fieldsSha256,requestSha256:"a".repeat(64),reason:"Approved explicit two-source standalone client",
      reviewedFieldsJson:JSON.stringify(fields),enrollmentSourceIds:sources.map(source=>source.sourceId),
      scopes:[{businessAreaId:area,divisionId:null}],verifiedUntil:auth.verifiedUntil,
      relationship:{mode:"change",expectedVersion:0,mutationId:relationshipMutationId},
      profile:{operation:"create",mutationId,recordId,expectedLocalVersion:0,kind:"client",
        createAdmissionId:`client-onboarding:${decisionId}:client`,profile:{name:fields.name,email:fields.email,phone:fields.phone,
          clientType:fields.clientType,addressLine1:fields.addressLine1,addressLine2:fields.addressLine2,city:fields.city,state:fields.state,
          postalCode:fields.postalCode,country:fields.country},scopes:[{businessAreaId:area,divisionId:null}],destinations:[],
        actor:{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject,admissionVersion:1,
          selectedGrantId:authority.input.grantIds[0],loginEmail:canonicalOwner.email,profileVersion:1,
          selectedIdentityGrantId:authority.input.grantIds[1]},relationship:{organizationRecordId:null,expectedRelationshipVersion:0}}},
    async selected=>selected.map(sourceId=>{const source=sources.find(value=>value.sourceId===sourceId)!;return{sourceId,
      sourceInstanceUUID:source.sourceInstanceId,applicationUUID:source.applicationId,historyEpoch:source.historyEpoch,
      origin:source.baseUrl,expectedAuthorizationGeneration:"7"};}));
    expect(approved).toMatchObject({status:"written",replayed:false,organizationRecordId:null,relationshipVersion:1});
    if(approved.status!=="written")throw Error(JSON.stringify(approved));
    expect(await db.prepare(`SELECT count(*) count FROM operations_directory_client_organizations
      WHERE client_record_id=? AND organization_record_id IS NULL AND relationship_version=1`).bind(approved.clientRecordId).first("count")).toBe(1);
    const commandRows=(await db.prepare("SELECT source_id,command_id FROM project_alpha_directory_outbox WHERE external_id=? ORDER BY source_id")
      .bind(approved.clientRecordId).all<{source_id:string;command_id:string}>()).results;
    expect(commandRows.map(row=>row.source_id)).toEqual(sources.map(source=>source.sourceId));
    for(const row of commandRows)await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand({OPS_DB:db,
      PROJECT_ALPHA_API_V2_CONNECTIONS:connections},row.source_id,row.command_id,remote())).resolves.toMatchObject({status:"acknowledged"});
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_directory_outbox WHERE external_id=? AND state='acknowledged'
      AND source_id IN (?,?)`).bind(approved.clientRecordId,sources[0].sourceId,sources[1].sourceId).first("count")).toBe(2);
    const mappings=(await db.prepare(`SELECT source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id
      FROM project_alpha_directory_mappings WHERE external_id=? AND source_id IN (?,?) ORDER BY source_id`)
      .bind(approved.clientRecordId,sources[0].sourceId,sources[1].sourceId).all()).results;
    expect(mappings).toEqual(sources.map(source=>({source_id:source.sourceId,source_instance_id:source.sourceInstanceId,
      application_id:source.applicationId,history_epoch_id:source.historyEpoch,project_alpha_public_id:"d".repeat(32)})));
    await expect(approveNativeOnlyClientOnboarding(db,{decisionId,invitationId,submissionId,
      fieldsSha256:submission.fieldsSha256,requestSha256:"a".repeat(64),reason:"Approved explicit two-source standalone client",
      reviewedFieldsJson:JSON.stringify(fields),enrollmentSourceIds:sources.map(source=>source.sourceId),
      scopes:[{businessAreaId:area,divisionId:null}],verifiedUntil:auth.verifiedUntil,
      relationship:{mode:"change",expectedVersion:0,mutationId:relationshipMutationId},profile:{operation:"create",mutationId,recordId,
        expectedLocalVersion:0,kind:"client",createAdmissionId:`client-onboarding:${decisionId}:client`,profile:{name:fields.name,
          email:fields.email,phone:fields.phone,clientType:fields.clientType,addressLine1:fields.addressLine1,addressLine2:fields.addressLine2,
          city:fields.city,state:fields.state,postalCode:fields.postalCode,country:fields.country},scopes:[{businessAreaId:area,divisionId:null}],
        destinations:[],actor:{staffId:canonicalOwner.operationsStaffId,accessSubject:canonicalOwner.accessSubject,admissionVersion:1,
          selectedGrantId:authority.input.grantIds[0],loginEmail:canonicalOwner.email,profileVersion:1,
          selectedIdentityGrantId:authority.input.grantIds[1]},relationship:{organizationRecordId:null,expectedRelationshipVersion:0}}},
    async()=>{throw Error("replay must not resolve destinations");})).resolves.toMatchObject({status:"written",replayed:true});
    await expect(cleanupSyntheticOnboardingOperator(db,authority,{lateFailure:true})).rejects.toThrow();
    expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id=?")
      .bind(canonicalOwner.operationsStaffId).first()).toEqual({active:1,version:1});
    expect(await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
      .bind(canonicalOwner.operationsStaffId).first("generation")).toBe(3);
    await cleanupSyntheticOnboardingOperator(db,authority);
    expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id=?")
      .bind(canonicalOwner.operationsStaffId).first()).toEqual({active:0,version:2});
    expect(await db.prepare("SELECT count(*) count FROM native_directory_grants WHERE staff_id=? AND active=0")
      .bind(canonicalOwner.operationsStaffId).first("count")).toBe(3);
    expect(await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
      .bind(canonicalOwner.operationsStaffId).first("generation")).toBe(6);
    await expect(cleanupSyntheticOnboardingOperator(db,authority)).rejects.toThrow();
    expect(await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
      .bind(canonicalOwner.operationsStaffId).first("generation")).toBe(6);
  },240_000);

  it("rejects an ABA-mutated grant history before cleanup",async()=>{
    const isolated=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID()}});
    const other=await isolated.getD1Database("OPS_DB") as unknown as D1Database;
    await applyCanonicalChain(other,"operations","0183_project_alpha_binding_standalone_relationship_rows.sql",true,canonicalOwner.accessSubject);
    await other.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,'ABA area',1)").bind(area).run();
    const clock=await other.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp").first<string>("stamp");
    const input=await buildSyntheticOnboardingOperatorInput(other,{staffId:canonicalOwner.operationsStaffId,email:canonicalOwner.email,
      displayName:canonicalOwner.displayName,accessSubject:canonicalOwner.accessSubject,businessAreaId:area,
      issuedAt:new Date(Date.parse(clock!)-60_000).toISOString(),expiresAt:new Date(Date.parse(clock!)+3_600_000).toISOString(),executedAt:clock!});
    const provisioned=await provisionSyntheticOnboardingOperator(other,input);
    await other.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").bind(input.grantIds[0]).run();
    await other.prepare("UPDATE native_directory_grants SET active=1 WHERE id=?").bind(input.grantIds[0]).run();
    await applyCanonicalTail(other,"0183_project_alpha_binding_standalone_relationship_rows.sql","0200_native_directory_active_binding_refresh_supersessions.sql");
    await expect(cleanupSyntheticOnboardingOperator(other,provisioned)).rejects.toThrow();
    expect(await other.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
      .bind(canonicalOwner.operationsStaffId).first("generation")).toBe(5);
    await isolated.dispose();
  },240_000);
});
