import {readAutomaticProfileRecoveryIdentity} from "../src/worker/directory-profile-recovery-identity";
import {writeNativeDirectoryLifecycle} from "../src/worker/native-directory-lifecycle-writer";
import {persistProjectAlphaDirectoryInventoryPage} from "../src/worker/project-alpha-v2-sync";
import {materializeResolvedProjectAlphaDirectoryClientIntents} from "../src/worker/project-alpha-directory-client-intent-materializer";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { prepareClientOnboardingSharedCompanyPlan } from "../src/worker/client-onboarding-shared-company-plan";
import { approveClientOnboardingSharedCompany } from "../src/worker/client-onboarding-shared-company-approval";
import { sharedProfileCreationFence,sharedProfileCreationStatements,type SharedProfileMember } from "../src/worker/native-directory-shared-profile-routes";
import { approveNewNativeOnlyClientOnboarding } from "../src/worker/client-onboarding-approval";
import { processClientOnboardingPortalActivation } from "../src/worker/client-onboarding-portal-activation";
import type { Env } from "../src/worker/types";
import type { SharedProfilePortalGrant } from "../src/worker/shared-profile-portal-authority";
import { manageSharedProfilePortalGrant,transitionSharedProfilePortalAuthority,bindSharedProfilePortalIdentity,authorizedSharedProfilePortalGrants } from "../src/worker/shared-profile-portal-authority";
const portalProofRead=vi.hoisted(()=>vi.fn());
const bindingRead=vi.hoisted(()=>vi.fn());
vi.mock("../src/worker/project-alpha-directory-read-api-v2",async original=>({...await original<typeof import("../src/worker/project-alpha-directory-read-api-v2")>(),readConfiguredProjectAlphaDirectoryClientPortalIdentity:portalProofRead,readConfiguredProjectAlphaDirectoryBindingStatus:bindingRead}));
vi.mock("../src/worker/project-alpha-directory-profile-api-v2",async original=>({...await original<typeof import("../src/worker/project-alpha-directory-profile-api-v2")>(),probeConfiguredProjectAlphaDirectoryClientContactProfile:async()=>({status:"verified"})}));

const inventoryRead = vi.hoisted(() => vi.fn());
vi.mock("../src/worker/project-alpha-directory-inventory-api-v2", () => ({
  readConfiguredProjectAlphaDirectoryInventory: inventoryRead,
}));

let runtime: Miniflare | undefined;
let db: D1Database;
let deliveryDb:D1Database;
let sequence = 0;
const staffId = "native-onboarding-approver";
const actor = { identity: { kind: "native" as const, staffId,
  verifiedAccessSubject: "access|native-onboarding-approver", email: "approver@example.test",
  displayName: "Native Approver", profileVersion: 1 }, admissionVersion: 1,
verifiedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
const consumer = Object.freeze({ clientType: "consumer", name: "Reviewed Client",
  email: "client@example.test", phone: "920-555-0100", organizationName: "",
  organizationEmail: "", organizationPhone: "", addressLine1: "1 Main Street", addressLine2: "",
  city: "Town", state: "WI", postalCode: "54123", country: "US" });
const business = Object.freeze({ ...consumer, clientType: "business", name: "Avery Manager",
  email: "avery@example.test", organizationName: "Example LLC",
  organizationEmail: "", organizationPhone: "" });
const uuid = () => `70000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
const selectedSourceId = "project-alpha:primary";
const secondSourceId = "project-alpha:secondary";
const selectedConnection = JSON.stringify({ version: 1, instances: {
  [selectedSourceId]: { sourceId: selectedSourceId, enabled: true, baseUrl: "https://pa-primary.example.test",
    apiKey: "test-only-api-key", sourceInstanceId: "a0000000-0000-4000-8000-000000000001",
    applicationId: "b0000000-0000-4000-8000-000000000002",
    historyEpoch: "c0000000-0000-4000-8000-000000000003" },
} });
const dualConnection = JSON.stringify({ version: 1, instances: {
  ...JSON.parse(selectedConnection).instances,
  [secondSourceId]: { sourceId: secondSourceId, enabled: true, baseUrl: "https://pa-secondary.example.test",
    apiKey: "test-only-secondary-api-key", sourceInstanceId: "d0000000-0000-4000-8000-000000000004",
    applicationId: "e0000000-0000-4000-8000-000000000005",
    historyEpoch: "f0000000-0000-4000-8000-000000000006" },
} });
async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function submission(fields: typeof consumer | Record<string, string> = consumer,
  targetClientRecordId: string | null = null,
  scopes = [{ businessAreaId: "area:drone", divisionId: "division:north" }]) {
  const invitationId = uuid(), commandId = uuid(), submissionId = uuid(), fieldsSha256 = sequence.toString(16).padStart(64, "0");
  await db.batch([
    db.prepare(`INSERT INTO client_onboarding_invitations
      (invitation_id,secret_sha256,issued_by,bound_access_subject,expires_at,target_client_record_id,state,version)
      VALUES(?,?,?,?,?,?, 'pending',1)`).bind(invitationId, "a".repeat(64), staffId,
      actor.identity.verifiedAccessSubject, actor.verifiedUntil, targetClientRecordId),
    db.prepare(`INSERT INTO client_onboarding_issuance_commands
      (invitation_id,command_id,request_sha256,scopes_json,issuer_admission_version,
       issuer_profile_version,issuer_email,verified_until) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(invitationId, commandId, "b".repeat(64), targetClientRecordId === null ? JSON.stringify(scopes) : null,
        actor.admissionVersion, actor.identity.profileVersion, actor.identity.email, actor.verifiedUntil),
    db.prepare(`INSERT INTO client_onboarding_submissions
      (invitation_id,submission_id,fields_json,fields_sha256) VALUES(?,?,?,?)`)
      .bind(invitationId, submissionId, JSON.stringify(fields), fieldsSha256),
  ]);
  return { invitationId, submissionId, fieldsSha256 };
}

async function count(table: string): Promise<number> {
  return await db.prepare(`SELECT count(*) count FROM ${table}`).first<number>("count") ?? -1;
}

describe("shared-company onboarding through all-child ACK and own-principal activation", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      compatibilityFlags: ["nodejs_compat"], script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: ["OPS_DB","DELIVERY_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    deliveryDb=await runtime.getD1Database("DELIVERY_DB") as D1Database;
    await deliveryDb.batch([
      'CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,status TEXT,pa_organization_public_id TEXT)',
      'CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT)',
      'CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT)',
      'CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER)',
      'CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,status TEXT,PRIMARY KEY(workspace_id,public_id))',
      'CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,status TEXT,revoked_at TEXT)',
      'CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT)',
      'CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,public_id TEXT,entity_type TEXT,parent_public_id TEXT,active INTEGER)',
      'CREATE TABLE pa_portal_entitlement_intents(workspace_id TEXT,principal_public_id TEXT,scope_type TEXT,scope_public_id TEXT,effect TEXT,capability TEXT,status TEXT,valid_from TEXT,expires_at TEXT)',
    ].map(sql=>deliveryDb.prepare(sql)));
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(item => /^\d{4}_.+\.sql$/.test(item)
      && item.slice(0, 4) <= "0220").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"))
        .map(statement => db.prepare(statement)));

    await db.batch([
      db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
        VALUES(?,?,?,?,'active')`).bind(staffId, actor.identity.email, actor.identity.displayName,
          actor.identity.verifiedAccessSubject),
      db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
        VALUES(?,?,1,?)`).bind(staffId, actor.identity.verifiedAccessSubject, staffId),
      db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
        VALUES(?,?,?)`).bind(staffId, actor.identity.email, actor.identity.displayName),
      db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area:drone','Drone',1)"),
      db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
        VALUES('division:north','area:drone','North',1)`),
      db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
        VALUES('division:south','area:drone','South',1)`),
      db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('approve-profile',?,'directory.profile.edit','allow','global',1,?)`).bind(staffId, staffId),
      db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('approve-identity',?,'directory.identity.link','allow','global',1,?)`).bind(staffId, staffId),
      db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('approve-enrollment',?,'directory.enrollment.manage','allow','global',1,?)`).bind(staffId, staffId),
    ]);
    await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('owner-role',?,'role-owner','global','global')").bind(staffId).run();
  }, 240_000);
  afterAll(async () => runtime?.dispose());


  const configs=JSON.parse(dualConnection).instances;
  const parents:SharedProfileMember[]=[];
  let companyGroupId="",generation="8";
  const environment=()=>({OPS_DB:db,DELIVERY_DB:deliveryDb,PROJECT_ALPHA_API_V2_CONNECTIONS:dualConnection,
    CLIENT_ONBOARDING_ADMIN_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:"true",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:"true"} as Env);
  const publicId=()=>uuid().replaceAll("-","");
  async function ack(recordId:string,type:"organization"|"client",sourceId:string,publicID:string){
    const command=await db.prepare(`SELECT outbox.command_id,outbox.command_json FROM operations_directory_intents intent
      JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
      WHERE intent.record_id=? AND intent.source_id=? AND intent.record_version=1`).bind(recordId,sourceId).first<{command_id:string;command_json:string}>();
    expect(command).toBeTruthy();const c=configs[sourceId];
    const commandId=command!.command_id;
    const acknowledgedGeneration=(BigInt(JSON.parse(command!.command_json).expectedAuthorizationGeneration)+1n).toString();
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='synthetic',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'").bind(commandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,?,?,?,?,?,?,?)`).bind(sourceId,type,recordId,publicID,c.sourceInstanceId,c.applicationId,c.historyEpoch,commandId).run();
    const outcome={status:"acknowledged",response:{requestId:commandId,replayed:false,sourceInstanceId:c.sourceInstanceId,applicationId:c.applicationId,historyEpoch:c.historyEpoch,
      result:{resource:{type,id:recordId,publicId:publicID,revision:"1"},data:{publicId:publicID},authorizationGeneration:acknowledgedGeneration}}};
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'").bind(JSON.stringify(outcome),commandId).run();
    await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE record_id=? AND source_id=? AND state='materialized'").bind(recordId,sourceId).run();
  }
  async function companies(){
    inventoryRead.mockImplementation(async(_environment,sourceId)=>{const c=configs[sourceId];return{status:"observed",inventory:{authoritative:false,sourceId,
      sourceInstanceId:c.sourceInstanceId,applicationId:c.applicationId,historyEpoch:c.historyEpoch,requestId:uuid(),authorizationGeneration:generation,resources:[],nextCursor:null}};});
    bindingRead.mockImplementation(async(_environment,sourceId,type,externalId,pub)=>{const c=configs[sourceId];return{status:"observed",observation:{authoritative:false,sourceId,
      sourceInstanceId:c.sourceInstanceId,applicationId:c.applicationId,historyEpoch:c.historyEpoch,requestId:uuid(),authorizationGeneration:"9",
      binding:{type,externalId,publicId:pub,createdAt:"2026-01-01T00:00:00.000Z"},resource:{revision:"1",present:true}}};});
    if(parents.length)return;
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('approve-view',?,'directory.profile.view','allow','global',1,?)`).bind(staffId,staffId).run();
    for(const source of [selectedSourceId,secondSourceId]){
      const item=await submission(business),created=await approveNewNativeOnlyClientOnboarding(db,actor,item.submissionId,item.fieldsSha256,[source],dualConnection,{kind:"new"});
      await ack(created.organizationRecordId!,"organization",source,publicId());
      await materializeResolvedProjectAlphaDirectoryClientIntents(db,[source],12,Date.now());
      await ack(created.clientRecordId,"client",source,publicId());
      // These two synthetic approvals only establish existing company aliases.
      await db.prepare("UPDATE client_onboarding_portal_activation_intents SET state='blocked',reason='enrollment_required',version=version+1 WHERE decision_id=?").bind(created.decisionId).run();
      const profile=JSON.parse((await db.prepare("SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=1").bind(created.organizationRecordId).first<string>("profile_json"))!);
      parents.push({recordId:created.organizationRecordId!,kind:"organization",version:1,profile,sourceIds:[source],parentRecordId:null,parentVersion:null,relationshipVersion:null});
    }
    parents.sort((a,b)=>a.recordId.localeCompare(b.recordId));companyGroupId=uuid();
    const preview=uuid(),writerActor={staffId,accessSubject:actor.identity.verifiedAccessSubject,admissionVersion:1,profileVersion:1,loginEmail:actor.identity.email};
    const proof={members:parents,primaryRecordId:parents[0]!.recordId,profile:parents[0]!.profile,kind:"organization",differences:[],actor:writerActor};
    await db.batch([
      db.prepare("INSERT INTO native_directory_shared_profile_previews(token,actor_id,proof_json,expires_at) VALUES(?,?,?,?)").bind(preview,staffId,JSON.stringify(proof),actor.verifiedUntil),
      sharedProfileCreationFence(db,{groupId:companyGroupId,mutationId:uuid(),mode:"pair",requestSha256:"e".repeat(64),actor:writerActor,kind:"organization",profile:parents[0]!.profile,members:parents,previewToken:preview}),
      ...sharedProfileCreationStatements(db,companyGroupId,"organization",parents[0]!.profile,parents,staffId),
    ]);generation="9";
  }
  async function fixture(sources=[selectedSourceId,secondSourceId]){
    await companies();
    const item=await submission({...business,name:`Reviewed shared contact ${sequence}`});
    const input={commandId:uuid(),submissionId:item.submissionId,fieldsSha256:item.fieldsSha256,sourceIds:sources,
      organizationSelection:{kind:"shared_existing",groupId:companyGroupId,expectedVersion:1,members:parents.map(m=>({recordId:m.recordId,expectedVersion:1}))}};
    const plan=await prepareClientOnboardingSharedCompanyPlan(db,actor,input,dualConnection);
    const approved=await approveClientOnboardingSharedCompany(db,actor,{planId:plan.planId,submissionId:item.submissionId,fieldsSha256:item.fieldsSha256},dualConnection);
    const children=approved.members.map(m=>({...m,sourceId:m.sourceIds[0]!,publicId:publicId(),principalId:publicId(),managerId:publicId(),workspaceId:uuid()}));
    const observations=new Map(children.map(child=>{const c=configs[child.sourceId];return [child.clientRecordId,{authoritative:false,sourceId:child.sourceId,
      sourceInstanceId:c.sourceInstanceId,applicationId:c.applicationId,historyEpoch:c.historyEpoch,requestId:uuid(),authorizationGeneration:"10",
      binding:{type:"client",externalId:child.clientRecordId,publicId:child.publicId,createdAt:"2026-10-19T00:00:00.000Z"},resource:{revision:"1",present:true},
      clientPortalIdentity:{state:"eligible",principalPublicId:child.principalId,associationVersion:"a".repeat(64)}}] as const;}));
    portalProofRead.mockImplementation(async(_env,_source,external)=>observations.has(external)?{status:"observed",observation:observations.get(external)}:{status:"uncertain",reason:"unavailable"});
    async function acknowledge(index:number){const child=children[index]!;
      await ack(child.clientRecordId,"client",child.sourceId,child.publicId);
      const parentPublic=await db.prepare("SELECT project_alpha_public_id FROM project_alpha_active_directory_mappings WHERE record_id=? AND source_id=? AND resource_type='organization'")
        .bind(child.parentRecordId,child.sourceId).first<string>("project_alpha_public_id");
      const generationId=uuid();
      await deliveryDb.batch([
        deliveryDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,'active',?)").bind(child.workspaceId,child.sourceId,parentPublic),
        deliveryDb.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)").bind(child.workspaceId,child.sourceId,uuid()),
        deliveryDb.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES(?,?)").bind(child.workspaceId,generationId),
        deliveryDb.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,'active',1)").bind(generationId,child.workspaceId),
        deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,'organization',NULL,1)").bind(child.workspaceId,generationId,parentPublic),
        deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,'client',?,1)").bind(child.workspaceId,generationId,child.publicId,parentPublic),
        ...[child.principalId,child.managerId].flatMap(p=>[
          deliveryDb.prepare("INSERT INTO pa_portal_principals VALUES(?,?,NULL,'active')").bind(child.workspaceId,p),
          deliveryDb.prepare("INSERT INTO pa_portal_entitlement_intents VALUES(?,?,'client',?,'allow','directory.read','active',NULL,NULL)").bind(child.workspaceId,p,child.publicId),
        ]),
      ]);
    }
    const tick=async(env:Env=environment())=>{await processClientOnboardingPortalActivation(env);await processClientOnboardingPortalActivation(env);};
    const grants=async()=>(await db.prepare("SELECT * FROM shared_profile_portal_grants WHERE group_id=? ORDER BY record_id").bind(plan.planId).all<SharedProfilePortalGrant&{state:string}>()).results;
    const state=()=>db.prepare("SELECT state,reason FROM client_onboarding_portal_activation_intents WHERE decision_id=?").bind(plan.planId).first();
    return {plan,approved,children,observations,acknowledge,tick,grants,state};
  }
  it("waits for BOTH exact ACKs, groups source-owned contacts and grants only each own principal",async()=>{
    const f=await fixture();await f.tick();expect(await f.state()).toEqual({state:"pending",reason:"awaiting_pa"});
    await f.acknowledge(0);await f.tick();expect(await f.grants()).toHaveLength(0);
    expect(await db.prepare("SELECT id FROM native_directory_shared_profiles WHERE id=?").bind(f.plan.planId).first()).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_portal_activation_proofs WHERE decision_id=?").bind(f.plan.planId).first("n")).toBe(0);
    await f.acknowledge(1);await f.tick();expect(await f.state()).toEqual({state:"active",reason:"active"});
    const grants=await f.grants();expect(grants).toHaveLength(2);
    for(const child of f.children)expect(grants.find(g=>g.record_id===child.clientRecordId)).toMatchObject({principal_public_id:child.principalId,target_public_id:child.publicId});
    expect(await db.prepare("SELECT membership_json FROM native_directory_shared_profiles WHERE id=?").bind(f.plan.planId).first("membership_json"))
      .toBe(JSON.stringify(f.children.map(c=>c.clientRecordId).sort()));
    expect(await count("client_onboarding_shared_contact_creation_fences")).toBe(0);
    expect(await count("operations_portal_native_delivery_authority_heads")).toBe(0);
    await f.tick();expect(await f.grants()).toHaveLength(2);
    // An already-active intent is historical status, never client authority.
    const first=grants[0]!;
    expect((await transitionSharedProfilePortalAuthority(environment(),{protocolVersion:1,operationId:uuid(),workspaceId:first.workspace_id,
      sourceId:first.source_id,expectedRevision:1,revision:1,state:"active"})).ok).toBe(true);
    const proof={protocolVersion:1 as const,workspaceId:first.workspace_id,sourceId:first.source_id,issuer:"https://access.example.test",subject:uuid(),
      authorityRevision:1,contextVersion:"f".repeat(64),verifiedUntil:new Date(Date.now()+30_000).toISOString(),
      targets:[{principalPublicId:first.principal_public_id,scopeType:"client" as const,publicId:first.target_public_id}]};
    expect((await bindSharedProfilePortalIdentity(environment(),proof)).bound).toBe(1);
    expect(await authorizedSharedProfilePortalGrants(environment(),proof)).toHaveLength(1);
    const current=(await f.grants()).find(g=>g.id===first.id)!;
    expect((await manageSharedProfilePortalGrant(environment(),{id:staffId,email:actor.identity.email,displayName:actor.identity.displayName,
      accessSubject:actor.identity.verifiedAccessSubject,projectAlphaUserId:null},
      {operationId:uuid(),id:current.id,workspaceId:current.workspace_id,sourceId:current.source_id,recipientMode:"first_verified_identity",
       issuer:null,subject:null,principalPublicId:current.principal_public_id,targetType:"client",targetPublicId:current.target_public_id,
       recordId:current.record_id,groupId:current.group_id,expectedRevision:current.revision,state:"revoked"},
      {admissionVersion:1,profileVersion:1})).ok).toBe(true);
    expect(await authorizedSharedProfilePortalGrants(environment(),proof)).toHaveLength(0);
    await f.tick();expect(await f.state()).toEqual({state:"active",reason:"active"});
    expect((await f.grants()).find(g=>g.id===first.id)!.state).toBe("revoked");
  },120_000);
  function loseAcknowledgement(fragment:string){
    const sql=new WeakMap<object,string>();let lost=false;
    const wrap=(target:any):any=>new Proxy(target,{get(target,key){
      if(key==="withSession")return(...args:unknown[])=>wrap(target.withSession(...args));
      if(key==="prepare")return(query:string)=>{const statement=target.prepare(query),wrapped=new Proxy(statement,{get(value,part){
        if(part==="bind")return(...args:unknown[])=>{const bound=value.bind(...args);sql.set(bound,query);return bound;};
        const member=Reflect.get(value,part,value);return typeof member==="function"?member.bind(value):member;
      }});sql.set(wrapped,query);return wrapped;};
      if(key==="batch")return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);
        if(!lost&&statements.some(s=>sql.get(s)?.includes(fragment))){lost=true;throw Error("synthetic committed acknowledgement loss");}return result;};
      const member=Reflect.get(target,key,target);return typeof member==="function"?member.bind(target):member;
    }});return {database:wrap(db) as D1Database,lost:()=>lost};
  }
  it.each(["INSERT INTO client_onboarding_shared_contact_creation_fences","INSERT INTO shared_profile_portal_grants"])("reconciles a committed %s acknowledgement loss without duplicate grants",async fragment=>{
    const f=await fixture();await f.acknowledge(0);await f.acknowledge(1);
    const race=loseAcknowledgement(fragment),uncertain={...environment(),OPS_DB:race.database};
    await processClientOnboardingPortalActivation(uncertain);expect(race.lost()).toBe(true);
    await f.tick();await f.tick();expect(await f.state()).toEqual({state:"active",reason:"active"});expect(await f.grants()).toHaveLength(2);
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_portal_activation_proofs WHERE decision_id=?").bind(f.plan.planId).first("n")).toBe(2);
  },120_000);
  it("rejects a principal that changes between the two proof reads before any group or grant",async()=>{
    const f=await fixture();await f.acknowledge(0);await f.acknowledge(1);const calls=new Map<string,number>();
    portalProofRead.mockImplementation(async(_env,_source,external)=>{const proof=f.observations.get(external);if(!proof)return{status:"uncertain",reason:"unavailable"};
      const count=(calls.get(external)??0)+1;calls.set(external,count);
      return{status:"observed",observation:count%2===0?{...proof,clientPortalIdentity:{...proof.clientPortalIdentity,principalPublicId:f.children.find(c=>c.clientRecordId===external)!.managerId}}:proof};});
    await f.tick();expect(await f.grants()).toHaveLength(0);expect(await f.state()).toEqual({state:"pending",reason:"awaiting_pa"});
    expect(await db.prepare("SELECT id FROM native_directory_shared_profiles WHERE id=?").bind(f.plan.planId).first()).toBeNull();
    // Hold this deliberately unstable synthetic request before the next fixture.
    await db.prepare("UPDATE client_onboarding_portal_activation_intents SET state='blocked',reason='identity_changed',version=version+1 WHERE decision_id=?").bind(f.plan.planId).run();
  },120_000);
  it("does not replace a reserved own identity after grouping committed before a crash",async()=>{
    const f=await fixture();await f.acknowledge(0);await f.acknowledge(1);
    const race=loseAcknowledgement("INSERT INTO client_onboarding_shared_contact_creation_fences");
    await processClientOnboardingPortalActivation({...environment(),OPS_DB:race.database});expect(race.lost()).toBe(true);
    const child=f.children[0]!,old=f.observations.get(child.clientRecordId)!;
    f.observations.set(child.clientRecordId,{...old,clientPortalIdentity:{...old.clientPortalIdentity,principalPublicId:child.managerId,associationVersion:"b".repeat(64)}});
    await f.tick();expect(await f.grants()).toHaveLength(0);expect(await f.state()).toEqual({state:"blocked",reason:"identity_changed"});
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_portal_activation_proofs WHERE decision_id=?").bind(f.plan.planId).first("n")).toBe(2);
  },120_000);
  it("never restores a revoked template after a partial grant acknowledgement was lost",async()=>{
    const f=await fixture();await f.acknowledge(0);await f.acknowledge(1);
    const race=loseAcknowledgement("INSERT INTO shared_profile_portal_grants");
    await processClientOnboardingPortalActivation({...environment(),OPS_DB:race.database});expect(race.lost()).toBe(true);
    const grants=await f.grants();expect(grants).toHaveLength(1);const grant=grants[0]!;
    const revoked=await manageSharedProfilePortalGrant(environment(),{id:staffId,email:actor.identity.email,displayName:actor.identity.displayName,
      accessSubject:actor.identity.verifiedAccessSubject,projectAlphaUserId:null},
      {operationId:uuid(),id:grant.id,workspaceId:grant.workspace_id,sourceId:grant.source_id,
       recipientMode:"first_verified_identity",issuer:null,subject:null,principalPublicId:grant.principal_public_id,
       targetType:"client",targetPublicId:grant.target_public_id,recordId:grant.record_id,groupId:grant.group_id,expectedRevision:grant.revision,state:"revoked"},
      {admissionVersion:1,profileVersion:1});
    expect(revoked.ok).toBe(true);await f.tick();expect(await f.state()).toEqual({state:"blocked",reason:"identity_changed"});
    expect(await f.grants()).toHaveLength(1);expect((await f.grants())[0]!.state).toBe("revoked");
  },120_000);
  it("rechecks the original approver after proof reads and refuses new grants after a current deny",async()=>{
    const f=await fixture();await f.acknowledge(0);await f.acknowledge(1);let changed=false;
    portalProofRead.mockImplementation(async(_env,_source,external)=>{const proof=f.observations.get(external);if(!proof)return{status:"uncertain",reason:"unavailable"};
      if(!changed){changed=true;await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('deny-after-proof',?,'directory.identity.link','deny','global',1,?)`).bind(staffId,staffId).run();}return{status:"observed",observation:proof};});
    await f.tick();expect(await f.state()).toEqual({state:"blocked",reason:"authority_changed"});expect(await f.grants()).toHaveLength(0);
    expect(await db.prepare("SELECT id FROM native_directory_shared_profiles WHERE id=?").bind(f.plan.planId).first()).toBeNull();
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='deny-after-proof'").run();
  },120_000);
  it("creates and activates only the selected company source without a second PA contact",async()=>{
    const f=await fixture([selectedSourceId]);expect(f.children).toHaveLength(1);
    expect(f.children[0]!.sourceId).toBe(selectedSourceId);
    await f.acknowledge(0);await f.tick();expect(await f.state()).toEqual({state:"active",reason:"active"});
    expect(await f.grants()).toHaveLength(1);
    expect(await db.prepare(`SELECT count(*) n FROM client_onboarding_shared_company_plan_children child
      JOIN operations_directory_intents intent ON intent.record_id=child.client_record_id
      WHERE child.plan_id=? AND intent.source_id=?`).bind(f.plan.planId,secondSourceId).first("n")).toBe(0);
  },120_000);
  it("does not issue templates after the original approver profile version changes",async()=>{
    const f=await fixture();await f.acknowledge(0);await f.acknowledge(1);let changed=false;
    portalProofRead.mockImplementation(async(_env,_source,external)=>{const proof=f.observations.get(external);if(!proof)return{status:"uncertain",reason:"unavailable"};
      if(!changed){changed=true;await db.prepare("UPDATE native_staff_profiles SET version=version+1 WHERE staff_id=?").bind(staffId).run();}
      return{status:"observed",observation:proof};});
    await f.tick();expect(await f.state()).toEqual({state:"blocked",reason:"authority_changed"});expect(await f.grants()).toHaveLength(0);
    expect(await db.prepare("SELECT id FROM native_directory_shared_profiles WHERE id=?").bind(f.plan.planId).first()).toBeNull();
  },120_000);
  it("denies at the isolated AUTO helper boundary when the original local parent is archive-pending but the target parent and PA own witnesses remain active",async()=>{
    // This directly tests helper policy, not Client admission/browser auth. All
    // company planning, approval and automatic proof/grant issuance remain real.
    // Refresh the synthetic caller from its CURRENT native profile; an earlier
    // case deliberately advanced that version, which must never be rolled back.
    actor.identity.profileVersion=(await db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').bind(staffId).first<number>('version'))!;
    const f=await fixture();await f.acknowledge(0);await f.acknowledge(1);await f.tick();
    expect(await f.state()).toEqual({state:'active',reason:'active'});
    const grants=await f.grants(),original=f.children[0]!,target=f.children[1]!;
    expect(original.parentRecordId).not.toBe(target.parentRecordId);
    const grant=grants.find(g=>g.record_id===original.clientRecordId)!,config=configs[target.sourceId];
    const requested={sourceId:target.sourceId,sourceInstanceId:config.sourceInstanceId,applicationId:config.applicationId,historyEpoch:config.historyEpoch,
      recordId:target.clientRecordId,externalId:target.clientRecordId,publicId:target.publicId,expectedRevision:'1'};
    const noHttp=vi.fn<typeof fetch>(async()=>{throw Error('HTTP outside mocked PA own-witness boundary');});
    const beforeProofs=(await db.prepare('SELECT * FROM client_onboarding_portal_activation_proofs WHERE decision_id=? ORDER BY grant_id').bind(f.plan.planId).all()).results;
    const beforeOwn=JSON.stringify([...f.observations]);
    expect(await readAutomaticProfileRecoveryIdentity(environment(),grant,requested,noHttp)).toMatchObject({status:'observed'});
    const parentConfig=configs[original.sourceId],parentPublic=(await db.prepare("SELECT project_alpha_public_id FROM project_alpha_active_directory_mappings WHERE record_id=? AND source_id=? AND resource_type='organization'").bind(original.parentRecordId,original.sourceId).first<string>('project_alpha_public_id'))!;
    expect(await persistProjectAlphaDirectoryInventoryPage(db,{authoritative:false,sourceId:original.sourceId,sourceInstanceId:parentConfig.sourceInstanceId,
      applicationId:parentConfig.applicationId,historyEpoch:parentConfig.historyEpoch,requestId:uuid(),authorizationGeneration:'10',nextCursor:null,
      resources:[{type:'organization',publicId:parentPublic,revision:'1',present:true,lastAction:'upsert',projectionSha256:'a'.repeat(64),binding:{externalId:original.parentRecordId,status:'active',resourceRevision:'1'}}]},null)).toMatchObject({status:'persisted'});
    const archived=await writeNativeDirectoryLifecycle(db,{mutationId:uuid(),recordId:original.parentRecordId,kind:'organization',action:'archive',expectedLifecycleVersion:0,expectedRecordVersion:1,
      actor:{staffId,accessSubject:actor.identity.verifiedAccessSubject,admissionVersion:actor.admissionVersion,loginEmail:actor.identity.email,profileVersion:actor.identity.profileVersion,
        selectedProfileGrantId:'approve-profile',selectedEnrollmentGrantId:'approve-enrollment',verifiedUntil:actor.verifiedUntil}});
    expect(archived,JSON.stringify(archived)).toMatchObject({status:'written',lifecycleStatus:'archive_pending'});
    expect(await db.prepare("SELECT coalesce((SELECT status FROM operations_directory_lifecycle_state WHERE record_id=?),'active') status").bind(target.parentRecordId).first('status')).toBe('active');
    expect(await readAutomaticProfileRecoveryIdentity(environment(),grant,requested,noHttp)).toEqual({status:'denied'});
    expect(JSON.stringify([...f.observations])).toBe(beforeOwn);
    expect((await db.prepare('SELECT * FROM client_onboarding_portal_activation_proofs WHERE decision_id=? ORDER BY grant_id').bind(f.plan.planId).all()).results).toEqual(beforeProofs);
    expect(noHttp).not.toHaveBeenCalled();
  },180_000);

});
