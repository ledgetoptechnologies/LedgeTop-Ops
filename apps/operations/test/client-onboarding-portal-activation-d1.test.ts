import {resolveBusinessProfileProof} from "../../client/src/worker/client-portal/business-profile";
import {dispatchProjectAlphaDirectoryProfileOutboxCommand} from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";
import {recoverDirectoryProfileGeneration} from "../src/worker/project-alpha-directory-profile-generation-recovery";
import {updateSharedPortalProfile} from "../src/worker/shared-profile-portal-composer";
import {bindSharedProfilePortalIdentity,transitionSharedProfilePortalAuthority,manageSharedProfilePortalGrant} from "../src/worker/shared-profile-portal-authority";
import {materializeResolvedProjectAlphaDirectoryClientIntents} from "../src/worker/project-alpha-directory-client-intent-materializer";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { approveNewNativeOnlyClientOnboarding } from "../src/worker/client-onboarding-approval";
import { processClientOnboardingPortalActivation,onboardingPortalGrantIdentityCurrent } from "../src/worker/client-onboarding-portal-activation";
import { readNativeDirectoryDurableRemoteHead } from "../src/worker/native-directory-profile-writer";
import type { Env } from "../src/worker/types";
import type { SharedProfilePortalGrant } from "../src/worker/shared-profile-portal-authority";
// Trusted admission/read-target boundary only; actual Client authority-head,
// entitlement-target SQL, transition/bind coordinator and Ops writers run below.
const clientWorkspaceRead=vi.hoisted(()=>vi.fn());
vi.mock('../../client/src/worker/client-portal/workspace-v2',()=>({resolveNativePortalWorkspaceReadContext:clientWorkspaceRead,authorizeNativePortalReadTarget:async()=>true}));
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
let restoreOwnTestClock:(()=>void)|undefined;
afterEach(()=>{restoreOwnTestClock?.();restoreOwnTestClock=undefined;});
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
       issuer_profile_version,issuer_email,verified_until) VALUES(?,?,?,?,1,1,?,?)`)
      .bind(invitationId, commandId, "b".repeat(64), targetClientRecordId === null ? JSON.stringify(scopes) : null,
        actor.identity.email, actor.verifiedUntil),
    db.prepare(`INSERT INTO client_onboarding_submissions
      (invitation_id,submission_id,fields_json,fields_sha256) VALUES(?,?,?,?)`)
      .bind(invitationId, submissionId, JSON.stringify(fields), fieldsSha256),
  ]);
  return { invitationId, submissionId, fieldsSha256 };
}

async function count(table: string): Promise<number> {
  return await db.prepare(`SELECT count(*) count FROM ${table}`).first<number>("count") ?? -1;
}

describe("approved onboarding through real D1 shared-profile and template issuers", () => {
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
    await deliveryDb.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0232_shared_profile_edit_authority.sql',import.meta.url),'utf8')).map(sql=>deliveryDb.prepare(sql)));
    await deliveryDb.prepare('UPDATE portal_shared_profile_runtime SET hooks_ready=1 WHERE id=1').run();
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


  it("waits for exact selected PA ACKs, grants only the PA-managed own principal, and never grants files",async()=>{
    inventoryRead.mockResolvedValue({status:"observed",inventory:{authorizationGeneration:"8"}});
    const item=await submission();
    const approved=await approveNewNativeOnlyClientOnboarding(db,actor,item.submissionId,item.fieldsSha256,[selectedSourceId],selectedConnection);
    const environment={OPS_DB:db,DELIVERY_DB:deliveryDb,PROJECT_ALPHA_API_V2_CONNECTIONS:selectedConnection,
      CLIENT_ONBOARDING_ADMIN_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:"true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:"true"} as Env;
    const tick=()=>processClientOnboardingPortalActivation(environment);
    await tick();
    expect(await db.prepare("SELECT state,reason FROM client_onboarding_portal_activation_intents WHERE decision_id=?").bind(approved.decisionId).first())
      .toEqual({state:"pending",reason:"awaiting_pa"});
    expect(await count("shared_profile_portal_grants")).toBe(0);
    const outbox=await db.prepare(`SELECT o.command_id FROM project_alpha_directory_outbox o
      JOIN operations_directory_materializations m ON m.command_id=o.command_id
      JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=?`).bind(approved.clientRecordId).first<{command_id:string}>();
    expect(outbox).not.toBeNull();
    const publicId="f".repeat(32),principalId="d".repeat(32),managerId="e".repeat(32),commandId=outbox!.command_id;
    const identity={sourceInstanceId:"a0000000-0000-4000-8000-000000000001",applicationId:"b0000000-0000-4000-8000-000000000002",historyEpoch:"c0000000-0000-4000-8000-000000000003"};
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='synthetic',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'").bind(commandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,'client',?,?,?,?,?,?)`).bind(selectedSourceId,approved.clientRecordId,publicId,identity.sourceInstanceId,identity.applicationId,identity.historyEpoch,commandId).run();
    const outcome={status:"acknowledged",response:{requestId:commandId,replayed:false,...identity,result:{resource:{type:"client",id:approved.clientRecordId,publicId,revision:"1"},data:{publicId},authorizationGeneration:"9"}}};
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'").bind(JSON.stringify(outcome),commandId).run();
    await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE record_id=? AND state='materialized'").bind(approved.clientRecordId).run();
    const durable=await readNativeDirectoryDurableRemoteHead(db,"client",approved.clientRecordId,1,
      {sourceId:selectedSourceId,sourceInstanceUUID:identity.sourceInstanceId,applicationUUID:identity.applicationId,historyEpoch:identity.historyEpoch,origin:"https://pa-primary.example.test",externalCanonicalId:approved.clientRecordId});
    expect(durable).not.toBeNull();
    const workspace=uuid(),generation=uuid();
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,'active',NULL)").bind(workspace,selectedSourceId),
      deliveryDb.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)").bind(workspace,selectedSourceId,uuid()),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES(?,?)").bind(workspace,generation),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,'active',1)").bind(generation,workspace),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,'standalone_client',NULL,1)").bind(workspace,generation,publicId),
      ...[principalId,managerId].flatMap(principal=>[
        deliveryDb.prepare("INSERT INTO pa_portal_principals VALUES(?,?,NULL,'active')").bind(workspace,principal),
        deliveryDb.prepare("INSERT INTO pa_portal_entitlement_intents VALUES(?,?,'client',?,'allow','directory.read','active',NULL,NULL)").bind(workspace,principal,publicId),
      ]),
    ]);
    const observed={authoritative:false,sourceId:selectedSourceId,...identity,requestId:uuid(),authorizationGeneration:"9",
      binding:{type:"client",externalId:approved.clientRecordId,publicId,createdAt:"2026-10-18T00:00:00.000Z"},resource:{revision:"1",present:true},
      clientPortalIdentity:{state:"eligible",principalPublicId:principalId,associationVersion:"a".repeat(64)}};
    portalProofRead.mockResolvedValue({status:"observed",observation:observed});
    await tick();await tick();
    const state=await db.prepare("SELECT state,reason FROM client_onboarding_portal_activation_intents WHERE decision_id=?").bind(approved.decisionId).first();
    expect(state).toEqual({state:"active",reason:"active"});
    const grants=(await db.prepare("SELECT * FROM shared_profile_portal_grants").all<SharedProfilePortalGrant&{recipient_mode:string}>()).results;
    expect(grants).toHaveLength(1);expect(grants[0]).toMatchObject({principal_public_id:principalId,record_id:approved.clientRecordId,target_public_id:publicId,recipient_mode:"first_verified_identity"});
    expect(await count("client_onboarding_portal_activation_proofs")).toBe(1);
    expect(await count("native_directory_shared_profiles")).toBe(1);
    expect(await count("operations_portal_native_delivery_authority_heads")).toBe(0);
    expect((await db.prepare("SELECT DISTINCT source_id FROM operations_directory_intents WHERE record_id=?").bind(approved.clientRecordId).all()).results).toEqual([{source_id:selectedSourceId}]);
    await tick();await tick();expect(await count("shared_profile_portal_grants")).toBe(1);
    expect(await onboardingPortalGrantIdentityCurrent(environment,grants[0]!)).toBe(true);
    portalProofRead.mockResolvedValue({status:"observed",observation:{...observed,clientPortalIdentity:{...observed.clientPortalIdentity,principalPublicId:managerId}}});
    expect(await onboardingPortalGrantIdentityCurrent(environment,grants[0]!)).toBe(false);
  },120_000);
  it("materializes and activates only the new contact after a reviewed existing company's exact next-revision ACK",async()=>{
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('view-existing-parent',?,'directory.profile.view','allow','global',1,?)`).bind(staffId,staffId).run();
    const identity={sourceInstanceId:"a0000000-0000-4000-8000-000000000001",applicationId:"b0000000-0000-4000-8000-000000000002",historyEpoch:"c0000000-0000-4000-8000-000000000003"};
    inventoryRead.mockImplementation(async()=>({status:"observed",inventory:{authoritative:false,sourceId:selectedSourceId,...identity,
      requestId:uuid(),authorizationGeneration:"8",resources:[],nextCursor:null}}));
    bindingRead.mockImplementation(async(_env,_source,type,externalId,publicId)=>({status:"observed",observation:{authoritative:false,sourceId:selectedSourceId,...identity,
      requestId:uuid(),authorizationGeneration:"9",binding:{type,externalId,publicId,createdAt:"2026-01-01T00:00:00.000Z"},resource:{revision:"1",present:true}}}));
    const initial=await submission(business),companyCreated=await approveNewNativeOnlyClientOnboarding(db,actor,initial.submissionId,initial.fieldsSha256,[selectedSourceId],selectedConnection,{kind:"new"});
    const company=companyCreated.organizationRecordId!,companyPublic="1".repeat(32);
    async function ack(recordId:string,type:"organization"|"client",version:number,publicId:string,authorizationGeneration="9"){
      const row=await db.prepare(`SELECT outbox.command_id FROM operations_directory_intents intent
        JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
        JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
        WHERE intent.record_id=? AND intent.record_version=?`).bind(recordId,version).first<{command_id:string}>();
      expect(row).not.toBeNull();const commandId=row!.command_id;
      await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='synthetic',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'").bind(commandId).run();
      if(version===1)await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
        VALUES(?,?,?,?,?,?,?,?)`).bind(selectedSourceId,type,recordId,publicId,identity.sourceInstanceId,identity.applicationId,identity.historyEpoch,commandId).run();
      const outcome={status:"acknowledged",response:{requestId:commandId,replayed:false,...identity,result:{resource:version===1?{type,id:recordId,publicId,revision:String(version)}:{type,publicId,revision:String(version)},data:{publicId},authorizationGeneration}}};
      await db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'").bind(JSON.stringify(outcome),commandId).run();
      await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE record_id=? AND record_version=? AND state='materialized'").bind(recordId,version).run();
    }
    await ack(company,"organization",1,companyPublic);
    await materializeResolvedProjectAlphaDirectoryClientIntents(db,[selectedSourceId],12,Date.now());
    await ack(companyCreated.clientRecordId,"client",1,"2".repeat(32));
    inventoryRead.mockImplementation(async()=>({status:"observed",inventory:{authoritative:false,sourceId:selectedSourceId,...identity,
      requestId:uuid(),authorizationGeneration:"9",resources:[],nextCursor:null}}));
    const next=await submission({...business,name:"Exact new contact"});
    const selection={kind:"existing" as const,recordId:company,expectedVersion:1};
    const approved=await approveNewNativeOnlyClientOnboarding(db,actor,next.submissionId,next.fieldsSha256,[selectedSourceId],selectedConnection,selection);
    expect(await materializeResolvedProjectAlphaDirectoryClientIntents(db,[selectedSourceId],12,Date.now())).toMatchObject({materialized:0});
    await ack(company,"organization",2,companyPublic);
    expect(await materializeResolvedProjectAlphaDirectoryClientIntents(db,[selectedSourceId],12,Date.now())).toMatchObject({materialized:1,blocked:0});
    const publicId="3".repeat(32),principalId="4".repeat(32),managerId="5".repeat(32);
    await ack(approved.clientRecordId,"client",1,publicId,"10");
    const workspace=uuid(),generation=uuid();
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,'active',?)").bind(workspace,selectedSourceId,companyPublic),
      deliveryDb.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)").bind(workspace,selectedSourceId,uuid()),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES(?,?)").bind(workspace,generation),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,'active',1)").bind(generation,workspace),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,'organization',NULL,1)").bind(workspace,generation,companyPublic),
      deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,'client',?,1)").bind(workspace,generation,publicId,companyPublic),
      ...[principalId,managerId].flatMap(principal=>[
        deliveryDb.prepare("INSERT INTO pa_portal_principals VALUES(?,?,NULL,'active')").bind(workspace,principal),
        deliveryDb.prepare("INSERT INTO pa_portal_entitlement_intents VALUES(?,?,'client',?,'allow','directory.read','active',NULL,NULL)").bind(workspace,principal,publicId),
      ]),
    ]);
    const observed={authoritative:false,sourceId:selectedSourceId,...identity,requestId:uuid(),authorizationGeneration:"10",
      binding:{type:"client",externalId:approved.clientRecordId,publicId,createdAt:"2026-10-18T00:00:00.000Z"},resource:{revision:"1",present:true},
      clientPortalIdentity:{state:"eligible",principalPublicId:principalId,associationVersion:"b".repeat(64)}};
    portalProofRead.mockImplementation(async(_env,_source,externalId)=>externalId===approved.clientRecordId
      ?{status:"observed",observation:observed}:{status:"uncertain",reason:"invalid_contract"});
    const environment={OPS_DB:db,DELIVERY_DB:deliveryDb,PROJECT_ALPHA_API_V2_CONNECTIONS:selectedConnection,
      CLIENT_ONBOARDING_ADMIN_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:"true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:"true"} as Env;
    for(let n=0;n<3;n++)await processClientOnboardingPortalActivation(environment);
    expect(await db.prepare("SELECT state,reason FROM client_onboarding_portal_activation_intents WHERE decision_id=?").bind(approved.decisionId).first()).toEqual({state:"active",reason:"active"});
    const grants=(await db.prepare("SELECT * FROM shared_profile_portal_grants WHERE record_id=?").bind(approved.clientRecordId).all<SharedProfilePortalGrant>()).results;
    expect(grants).toHaveLength(1);expect(grants[0]).toMatchObject({principal_public_id:principalId,target_public_id:publicId,target_type:"client"});
    expect(await onboardingPortalGrantIdentityCurrent(environment,grants[0]!)).toBe(true);
    expect(await count("operations_portal_native_delivery_authority_heads")).toBe(0);
    expect(await approveNewNativeOnlyClientOnboarding(db,actor,next.submissionId,next.fieldsSha256,[selectedSourceId],selectedConnection,selection)).toMatchObject({...approved,replayed:true});
    for(let n=0;n<2;n++)await processClientOnboardingPortalActivation(environment);
    expect(await db.prepare("SELECT count(*) total FROM shared_profile_portal_grants WHERE record_id=?").bind(approved.clientRecordId).first("total")).toBe(1);
  },120_000);

  for(const mode of ['current','association_changed_after_append','principal_changed','eligibility_revoked']as const){
    it(`recovers an automatically activated own-client profile only with current principal and stored association: ${mode}`,async()=>{
      const identity={sourceInstanceId:"a0000000-0000-4000-8000-000000000001",applicationId:"b0000000-0000-4000-8000-000000000002",historyEpoch:"c0000000-0000-4000-8000-000000000003"};
      let generation=8,revision='1',remoteProfile:Record<string,string>={};
      const publicId=uuid().replaceAll('-',''),principalId=uuid().replaceAll('-',''),workspace=uuid(),projection=uuid();
      let own:{state:'eligible'|'revoked';principalPublicId:string|null;associationVersion:string|null}={state:'eligible',principalPublicId:principalId,associationVersion:'a'.repeat(64)};
      let changeOnSuccessorProbe=false;const contactPosts:Array<{body:Record<string,any>;path:string}>=[],receipts=new Map<string,{body:string;result:unknown}>();
      const response=(body:Record<string,any>,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':body.requestId}});
      const env={OPS_DB:db,DELIVERY_DB:deliveryDb,PROJECT_ALPHA_API_V2_CONNECTIONS:selectedConnection,
        NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true',CLIENT_ONBOARDING_ADMIN_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',
        CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:'true'}as Env;
      const send=vi.fn<typeof fetch>(async(url,init)=>{
        const path=new URL(String(url)).pathname,base={...identity,requestId:uuid()};
        if(path.endsWith('/capabilities')){
          if(changeOnSuccessorProbe&&await db.prepare('SELECT 1 FROM project_alpha_directory_profile_generation_recoveries WHERE record_id=?').bind(approved.clientRecordId).first()){
            own={...own,associationVersion:'b'.repeat(64)};changeOnSuccessorProbe=false;
          }
          const endpoints=[{method:'POST',path:'/api/v2/directory/clients/commands',requiredCapability:'directory.clients.create'},
            {method:'POST',path:'/api/v2/directory/clients/{publicId}/contact-profile/commands',requiredCapability:'directory.clients.write',requiresExpectedRevision:true},
            {method:'GET',path:'/api/v2/directory/clients/{publicId}',requiredCapability:'directory.clients.read'}];
          return response({...base,apiVersion:'2',grantedCapabilities:['api.capabilities.read','directory.clients.create','directory.clients.write','directory.clients.read'].map(name=>({name})),
            implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},...endpoints.map(e=>({...e,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]});
        }
        if(init?.method!=='POST')return response({...base,apiVersion:'2',authorizationGeneration:String(generation),resource:{type:'client',id:publicId,revision},
          data:{publicId,name:remoteProfile.name,email:remoteProfile.email||null,phone:remoteProfile.phone||null,clientType:'consumer',organizationPublicId:null,
            address:{line1:remoteProfile.addressLine1||null,line2:remoteProfile.addressLine2||null,city:remoteProfile.city||null,state:remoteProfile.state||null,postalCode:remoteProfile.postalCode||null,country:remoteProfile.country||null}}});
        const body=JSON.parse(String(init.body)),prior=receipts.get(body.commandId);
        if(path.endsWith('/contact-profile/commands'))contactPosts.push({body,path});
        if(prior){expect(prior.body).toBe(String(init.body));return response({...base,replayed:true,result:prior.result});}
        if(body.expectedAuthorizationGeneration!==String(generation))return response({...base,apiVersion:'2',error:{code:'authorization_generation_conflict'}},409);
        if(path.endsWith('/contact-profile/commands')){
          expect(body.expectedRevision).toBe(revision);remoteProfile={...body.profile};revision=String(Number(revision)+1);
          const result={resource:{type:'client',publicId,revision},authorizationGeneration:String(generation)};
          receipts.set(body.commandId,{body:String(init.body),result});return response({...base,replayed:false,result});
        }
        expect(path).toBe('/api/v2/directory/clients/commands');remoteProfile={...body.profile};generation++;
        const result={resource:{type:'client',id:body.externalId,publicId,revision},authorizationGeneration:String(generation)};
        receipts.set(body.commandId,{body:String(init.body),result});return response({...base,replayed:false,result},201);
      });
      inventoryRead.mockImplementation(async()=>({status:'observed',inventory:{authoritative:false,sourceId:selectedSourceId,...identity,requestId:uuid(),authorizationGeneration:String(generation),resources:[],nextCursor:null}}));
      const item=await submission(),approved=await approveNewNativeOnlyClientOnboarding(db,actor,item.submissionId,item.fieldsSha256,[selectedSourceId],selectedConnection);
      const originalCreate=await db.prepare(`SELECT m.command_id FROM operations_directory_intents i JOIN operations_directory_materializations m ON m.intent_id=i.intent_id WHERE i.record_id=?`).bind(approved.clientRecordId).first<string>('command_id');
      expect(originalCreate).not.toBeNull();expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,selectedSourceId,originalCreate!,send)).toMatchObject({status:'acknowledged'});
      for(const [table,column]of [['pa_portal_principals','source_version'],['pa_portal_principals','email_hint'],['portal_v2_identities','verified_email'],['portal_v2_workspace_memberships','expires_at']]as const){
        if(!(await deliveryDb.prepare(`PRAGMA table_info('${table}')`).all<{name:string}>()).results.some(c=>c.name===column))await deliveryDb.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run();
      }
      await deliveryDb.prepare('CREATE TABLE IF NOT EXISTS portal_v2_identity_eligibility_bindings(workspace_id TEXT,principal_public_id TEXT,identity_id TEXT,principal_source_version TEXT,verified_email TEXT)').run();
      await deliveryDb.prepare('CREATE TABLE IF NOT EXISTS portal_v2_entitlements(workspace_id TEXT,identity_id TEXT,status TEXT,expires_at TEXT)').run();
      await deliveryDb.batch([
        deliveryDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,'active',NULL)").bind(workspace,selectedSourceId),
        deliveryDb.prepare('INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)').bind(workspace,selectedSourceId,uuid()),
        deliveryDb.prepare('INSERT INTO portal_v2_directory_checkpoints VALUES(?,?)').bind(workspace,projection),
        deliveryDb.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,'active',1)").bind(projection,workspace),
        deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,'standalone_client',NULL,1)").bind(workspace,projection,publicId),
        deliveryDb.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,status) VALUES(?,?,NULL,'active')").bind(workspace,principalId),
        deliveryDb.prepare("INSERT INTO pa_portal_entitlement_intents VALUES(?,?,'client',?,'allow','directory.read','active',NULL,NULL)").bind(workspace,principalId,publicId),
      ]);
      const observation=()=>({authoritative:false,sourceId:selectedSourceId,...identity,requestId:uuid(),authorizationGeneration:String(generation),
        binding:{type:'client',externalId:approved.clientRecordId,publicId,createdAt:'2026-10-19T00:00:00.000Z'},resource:{revision,present:true},clientPortalIdentity:{...own}});
      portalProofRead.mockImplementation(async()=>({status:'observed',observation:observation()}));
      bindingRead.mockImplementation(async()=>({status:'observed',observation:observation()}));
      for(let n=0;n<3;n++)await processClientOnboardingPortalActivation(env);
      const activationState=await db.prepare('SELECT state,reason FROM client_onboarding_portal_activation_intents WHERE decision_id=?').bind(approved.decisionId).first();
      expect(activationState,JSON.stringify(activationState)).toMatchObject({state:'active'});
      const grant=await db.prepare(`SELECT g.*,s.profile_json,s.version,s.kind FROM shared_profile_portal_grants g JOIN native_directory_shared_profiles s ON s.id=g.group_id JOIN client_onboarding_portal_activation_proofs p ON p.grant_id=g.id WHERE p.decision_id=?`).bind(approved.decisionId).first<SharedProfilePortalGrant>();
      expect(grant).not.toBeNull();expect(grant!.principal_public_id).toBe(principalId);
      // The real Client coordinator, not a staff/manual activation call, opens
      // the existing blocked Ops head after fresh admitted context and targets.
      expect(await db.prepare('SELECT state FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(workspace).first('state')).toBe('blocked');
      const clientIdentity=uuid(),principal={issuer:'https://access.example.test',subject:'auto-own-'+approved.clientRecordId,email:consumer.email};
      await deliveryDb.prepare('UPDATE pa_portal_principals SET identity_id=?,source_version=? WHERE workspace_id=? AND public_id=?').bind(clientIdentity,'1',workspace,principalId).run();
      clientWorkspaceRead.mockImplementation(async()=>({workspaceId:workspace,sourceId:selectedSourceId,identityId:clientIdentity,rootType:'standalone_client',rootPublicId:publicId,
        generationId:projection,contextVersion:'c'.repeat(64)}));
      const clientEnv={DELIVERY_DB:deliveryDb,SHARED_PROFILE_PORTAL:{
        transitionAuthority:(value:Parameters<typeof transitionSharedProfilePortalAuthority>[1])=>transitionSharedProfilePortalAuthority(env,value),
        bindProfileIdentity:(value:Parameters<typeof bindSharedProfilePortalIdentity>[1])=>bindSharedProfilePortalIdentity(env,value),
      }}as unknown as Parameters<typeof resolveBusinessProfileProof>[0];
      const admittedProof=await resolveBusinessProfileProof(clientEnv,principal,workspace);
      expect(admittedProof).not.toBeNull();const proof=admittedProof!;
      expect(await db.prepare('SELECT state FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(workspace).first('state')).toBe('active');
      expect(await db.prepare('SELECT issuer,subject,revision FROM shared_profile_portal_grants WHERE id=?').bind(grant!.id).first()).toEqual({revision:2,issuer:principal.issuer,subject:principal.subject});
      const portalRead=vi.fn(async()=>{const current=await resolveBusinessProfileProof(clientEnv,principal,workspace,{bindTemplates:false});return current?{ok:true,proof:current}:{ok:false};});
      env.SHARED_PROFILE_PORTAL_AUTHORITY={readAuthority:portalRead}as unknown as Env['SHARED_PROFILE_PORTAL_AUTHORITY'];
      const desired={...JSON.parse(grant!.profile_json),phone:'920-555-0198'},mutationId=uuid();
      const written=await updateSharedPortalProfile(env,{...proof,grantId:grant!.id,expectedVersion:1,mutationId,profile:desired});
      expect(written).toMatchObject({ok:true,profiles:[{version:2}]});
      const predecessor=await db.prepare(`SELECT o.command_id,o.command_json FROM operations_directory_intents i JOIN operations_directory_materializations m ON m.intent_id=i.intent_id JOIN project_alpha_directory_outbox o ON o.command_id=m.command_id WHERE i.record_id=? AND i.record_version=2`).bind(approved.clientRecordId).first<{command_id:string;command_json:string}>();
      expect(predecessor).not.toBeNull();generation++;
      const refused=await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,selectedSourceId,predecessor!.command_id,send);
      expect(refused,JSON.stringify(refused)).toMatchObject({status:'conflict',profileGenerationConflict:true});
      if(mode==='association_changed_after_append')changeOnSuccessorProbe=true;
      if(mode==='principal_changed')own={...own,principalPublicId:uuid().replaceAll('-','')};
      if(mode==='eligibility_revoked')own={state:'revoked',principalPublicId:null,associationVersion:null};
      const beforeHead=await db.prepare('SELECT workspace_id,source_id,revision,state,operation_id FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(workspace).first<Record<string,unknown>>();
      const result=await recoverDirectoryProfileGeneration(env,selectedSourceId,predecessor!.command_id,send);
      const lineage=(await db.prepare('SELECT * FROM project_alpha_directory_profile_generation_recoveries WHERE record_id=?').bind(approved.clientRecordId).all<Record<string,any>>()).results;
      expect(await db.prepare('SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?').bind(predecessor!.command_id).first('command_json')).toBe(predecessor!.command_json);
      expect(await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(predecessor!.command_id).first('state')).toBe('terminal');
      if(mode==='current'){
        expect(result,JSON.stringify(result)).toMatchObject({status:'acknowledged'});
        const afterHead=await db.prepare('SELECT workspace_id,source_id,revision,state,operation_id FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(workspace).first<Record<string,unknown>>();
        expect({...afterHead,operation_id:null}).toEqual({...beforeHead,operation_id:null});expect(afterHead!.operation_id).not.toBe(beforeHead!.operation_id);
        expect(lineage).toHaveLength(1);expect(lineage[0]).toMatchObject({identity_policy:'automatic_own',endpoint_policy:'contact'});
        const original=JSON.parse(predecessor!.command_json),successor=JSON.parse(lineage[0]!.successor_command_json);
        expect(successor).toEqual({...original,commandId:lineage[0]!.successor_command_id,expectedAuthorizationGeneration:String(generation)});
        expect(JSON.parse(lineage[0]!.observed_identity_json).clientPortalIdentity).toEqual({state:'eligible',principalPublicId:principalId,associationVersion:'a'.repeat(64)});
        const posts=contactPosts.length;expect(await recoverDirectoryProfileGeneration(env,selectedSourceId,predecessor!.command_id,send)).toMatchObject({status:'acknowledged'});expect(contactPosts).toHaveLength(posts);expect(remoteProfile).toEqual(desired);
      }else{
        expect(result.status).not.toBe('acknowledged');expect(remoteProfile.phone).toBe(consumer.phone);
        expect(lineage).toHaveLength(mode==='association_changed_after_append'?1:0);
        if(lineage.length)expect(contactPosts.every(p=>p.body.commandId!==lineage[0]!.successor_command_id)).toBe(true);
      }
      expect(portalRead).toHaveBeenCalled();
      expect(await db.prepare('SELECT association_version FROM client_onboarding_portal_activation_proofs WHERE grant_id=?').bind(grant!.id).first('association_version')).toBe('a'.repeat(64));
    },180_000);
  }

  for(const mode of ['current','target_template_revoked','target_template_revoked_during_probe','target_association_changed','original_own_changed','proof_expires_before_post']as const){
    it(`recovers the secondary PA from a primary-bound automatic own grant with distinct PA identities: ${mode}`,async()=>{
      type Remote={sourceId:string;origin:string;identity:{sourceInstanceId:string;applicationId:string;historyEpoch:string};publicId:string;principalId:string;association:string;generation:number;revision:string;profile:Record<string,string>;workspace:string;projection:string};
      const sources=[selectedSourceId,secondSourceId],states=new Map<string,Remote>(sources.map((sourceId,index)=>{
        const config=JSON.parse(dualConnection).instances[sourceId];
        return[sourceId,{sourceId,origin:config.baseUrl as string,identity:{sourceInstanceId:config.sourceInstanceId as string,applicationId:config.applicationId as string,historyEpoch:config.historyEpoch as string},
          publicId:uuid().replaceAll('-',''),principalId:uuid().replaceAll('-',''),association:(index?'b':'a').repeat(64),generation:8,revision:'1',profile:{}as Record<string,string>,workspace:uuid(),projection:uuid()}]as [string,Remote];
      }));
      const primary=states.get(selectedSourceId)!,secondary=states.get(secondSourceId)!;
      let revokeTargetDuringRead:(()=>Promise<void>)|null=null,expireBeforePost=false,clockShifted=false,latestClientDeadline=0;
      const endpointRows=[{method:'POST',path:'/api/v2/directory/clients/commands',requiredCapability:'directory.clients.create'},
        {method:'POST',path:'/api/v2/directory/clients/{publicId}/contact-profile/commands',requiredCapability:'directory.clients.write',requiresExpectedRevision:true},
        {method:'GET',path:'/api/v2/directory/clients/{publicId}',requiredCapability:'directory.clients.read'}];
      const receipts=new Map<string,{body:string;result:unknown}>(),posts:Array<{sourceId:string;body:Record<string,any>}>=[];
      const response=(body:Record<string,any>,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':body.requestId}});
      const send=vi.fn<typeof fetch>(async(url,init)=>{
        const parsed=new URL(String(url)),remote=[...states.values()].find(s=>s.origin===parsed.origin)!;expect(remote).toBeDefined();
        const base={...remote.identity,requestId:uuid()};
        if(parsed.pathname.endsWith('/capabilities'))return response({...base,apiVersion:'2',grantedCapabilities:['api.capabilities.read','directory.clients.create','directory.clients.write','directory.clients.read'].map(name=>({name})),
          implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},...endpointRows.map(e=>({...e,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]});
        if(init?.method!=='POST')return response({...base,apiVersion:'2',authorizationGeneration:String(remote.generation),resource:{type:'client',id:remote.publicId,revision:remote.revision},data:{
          publicId:remote.publicId,name:remote.profile.name,email:remote.profile.email||null,phone:remote.profile.phone||null,clientType:'consumer',organizationPublicId:null,
          address:{line1:remote.profile.addressLine1||null,line2:remote.profile.addressLine2||null,city:remote.profile.city||null,state:remote.profile.state||null,postalCode:remote.profile.postalCode||null,country:remote.profile.country||null}}});
        const body=JSON.parse(String(init.body));posts.push({sourceId:remote.sourceId,body});const prior=receipts.get(body.commandId);
        if(prior){expect(prior.body).toBe(String(init.body));return response({...base,replayed:true,result:prior.result});}
        if(body.expectedAuthorizationGeneration!==String(remote.generation))return response({...base,apiVersion:'2',error:{code:'authorization_generation_conflict'}},409);
        if(parsed.pathname.endsWith('/contact-profile/commands')){
          expect(body.expectedRevision).toBe(remote.revision);remote.profile={...body.profile};remote.revision=String(Number(remote.revision)+1);
          const result={resource:{type:'client',publicId:remote.publicId,revision:remote.revision},authorizationGeneration:String(remote.generation)};
          receipts.set(body.commandId,{body:String(init.body),result});return response({...base,replayed:false,result});
        }
        expect(parsed.pathname).toBe('/api/v2/directory/clients/commands');remote.profile={...body.profile};remote.generation++;
        const result={resource:{type:'client',id:body.externalId,publicId:remote.publicId,revision:remote.revision},authorizationGeneration:String(remote.generation)};
        receipts.set(body.commandId,{body:String(init.body),result});return response({...base,replayed:false,result},201);
      });
      inventoryRead.mockImplementation(async(_env,sourceId)=>{const r=states.get(sourceId)!;return{status:'observed',inventory:{authoritative:false,sourceId,...r.identity,requestId:uuid(),authorizationGeneration:String(r.generation),resources:[],nextCursor:null}};});
      const item=await submission(),approved=await approveNewNativeOnlyClientOnboarding(db,actor,item.submissionId,item.fieldsSha256,sources,dualConnection);
      const env={OPS_DB:db,DELIVERY_DB:deliveryDb,PROJECT_ALPHA_API_V2_CONNECTIONS:dualConnection,NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true',CLIENT_ONBOARDING_ADMIN_ENABLED:'true',
        CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:'true'}as Env;
      for(const sourceId of sources){
        const command=await db.prepare(`SELECT m.command_id FROM operations_directory_intents i JOIN operations_directory_materializations m ON m.intent_id=i.intent_id WHERE i.record_id=? AND i.source_id=?`).bind(approved.clientRecordId,sourceId).first<string>('command_id');
        expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,sourceId,command!,send)).toMatchObject({status:'acknowledged'});
      }
      // Same minimal Delivery projection boundary as the single-source cases.
      for(const[table,column]of [['pa_portal_principals','source_version'],['pa_portal_principals','email_hint'],['portal_v2_identities','verified_email'],['portal_v2_workspace_memberships','expires_at']]as const)
        if(!(await deliveryDb.prepare(`PRAGMA table_info('${table}')`).all<{name:string}>()).results.some(c=>c.name===column))await deliveryDb.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run();
      await deliveryDb.prepare('CREATE TABLE IF NOT EXISTS portal_v2_identity_eligibility_bindings(workspace_id TEXT,principal_public_id TEXT,identity_id TEXT,principal_source_version TEXT,verified_email TEXT)').run();
      await deliveryDb.prepare('CREATE TABLE IF NOT EXISTS portal_v2_entitlements(workspace_id TEXT,identity_id TEXT,status TEXT,expires_at TEXT)').run();
      for(const r of states.values())await deliveryDb.batch([
        deliveryDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,'active',NULL)").bind(r.workspace,r.sourceId),
        deliveryDb.prepare('INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)').bind(r.workspace,r.sourceId,uuid()),
        deliveryDb.prepare('INSERT INTO portal_v2_directory_checkpoints VALUES(?,?)').bind(r.workspace,r.projection),
        deliveryDb.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,'active',1)").bind(r.projection,r.workspace),
        deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,'standalone_client',NULL,1)").bind(r.workspace,r.projection,r.publicId),
        deliveryDb.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,status) VALUES(?,?,NULL,'active')").bind(r.workspace,r.principalId),
        deliveryDb.prepare("INSERT INTO pa_portal_entitlement_intents VALUES(?,?,'client',?,'allow','directory.read','active',NULL,NULL)").bind(r.workspace,r.principalId,r.publicId),
      ]);
      const observation=(sourceId:string)=>{const r=states.get(sourceId)!;return{authoritative:false,sourceId,...r.identity,requestId:uuid(),authorizationGeneration:String(r.generation),
        binding:{type:'client',externalId:approved.clientRecordId,publicId:r.publicId,createdAt:'2026-10-19T00:00:00.000Z'},resource:{revision:r.revision,present:true},
        clientPortalIdentity:{state:'eligible',principalPublicId:r.principalId,associationVersion:r.association}};};
      portalProofRead.mockImplementation(async(_env,sourceId)=>{
        if(sourceId===secondSourceId&&revokeTargetDuringRead){const hook=revokeTargetDuringRead;revokeTargetDuringRead=null;await hook();}
        if(sourceId===secondSourceId&&expireBeforePost&&await db.prepare('SELECT 1 FROM project_alpha_directory_profile_generation_recoveries WHERE record_id=?').bind(approved.clientRecordId).first()){
          expect(latestClientDeadline).toBeGreaterThan(Date.now());expireBeforePost=false;clockShifted=true;
          const clock=vi.spyOn(Date,'now').mockReturnValue(latestClientDeadline+1);restoreOwnTestClock=()=>clock.mockRestore();
        }
        return{status:'observed',observation:observation(sourceId)};
      });
      bindingRead.mockImplementation(async(_env,sourceId)=>({status:'observed',observation:observation(sourceId)}));
      for(let n=0;n<4;n++)await processClientOnboardingPortalActivation(env);
      const activation=await db.prepare('SELECT state,reason FROM client_onboarding_portal_activation_intents WHERE decision_id=?').bind(approved.decisionId).first();
      expect(activation,JSON.stringify(activation)).toMatchObject({state:'active'});
      const grants=(await db.prepare(`SELECT g.*,s.profile_json FROM shared_profile_portal_grants g JOIN native_directory_shared_profiles s ON s.id=g.group_id JOIN client_onboarding_portal_activation_proofs p ON p.grant_id=g.id WHERE p.decision_id=? ORDER BY g.source_id`).bind(approved.decisionId).all<SharedProfilePortalGrant>()).results;
      expect(grants).toHaveLength(2);const originalGrant=grants.find(g=>g.source_id===selectedSourceId)!,targetGrant=grants.find(g=>g.source_id===secondSourceId)!;
      expect(originalGrant.principal_public_id).not.toBe(targetGrant.principal_public_id);
      const clientIdentity=uuid(),principal={issuer:'https://access.example.test',subject:'two-pa-own-'+approved.clientRecordId,email:consumer.email};
      await deliveryDb.prepare('UPDATE pa_portal_principals SET identity_id=?,source_version=? WHERE workspace_id=? AND public_id=?').bind(clientIdentity,'1',primary.workspace,primary.principalId).run();
      clientWorkspaceRead.mockImplementation(async()=>({workspaceId:primary.workspace,sourceId:selectedSourceId,identityId:clientIdentity,rootType:'standalone_client',rootPublicId:primary.publicId,generationId:primary.projection,contextVersion:'c'.repeat(64)}));
      const clientEnv={DELIVERY_DB:deliveryDb,SHARED_PROFILE_PORTAL:{
        transitionAuthority:(value:Parameters<typeof transitionSharedProfilePortalAuthority>[1])=>transitionSharedProfilePortalAuthority(env,value),
        bindProfileIdentity:(value:Parameters<typeof bindSharedProfilePortalIdentity>[1])=>bindSharedProfilePortalIdentity(env,value),
      }}as unknown as Parameters<typeof resolveBusinessProfileProof>[0];
      const proof=await resolveBusinessProfileProof(clientEnv,principal,primary.workspace);expect(proof).not.toBeNull();
      env.SHARED_PROFILE_PORTAL_AUTHORITY={readAuthority:async()=>{const current=await resolveBusinessProfileProof(clientEnv,principal,primary.workspace,{bindTemplates:false});if(current)latestClientDeadline=Date.parse(current.verifiedUntil);return current?{ok:true,proof:current}:{ok:false};}}as unknown as Env['SHARED_PROFILE_PORTAL_AUTHORITY'];
      const desired={...JSON.parse(originalGrant.profile_json),phone:'920-555-0197'};
      expect(await updateSharedPortalProfile(env,{...proof!,grantId:originalGrant.id,expectedVersion:1,mutationId:uuid(),profile:desired})).toMatchObject({ok:true});
      const commands=(await db.prepare(`SELECT o.command_id,o.command_json,o.source_id FROM operations_directory_intents i JOIN operations_directory_materializations m ON m.intent_id=i.intent_id JOIN project_alpha_directory_outbox o ON o.command_id=m.command_id WHERE i.record_id=? AND i.record_version=2 ORDER BY o.source_id`).bind(approved.clientRecordId).all<{command_id:string;command_json:string;source_id:string}>()).results;
      expect(commands).toHaveLength(2);const primaryCommand=commands.find(c=>c.source_id===selectedSourceId)!,targetCommand=commands.find(c=>c.source_id===secondSourceId)!;
      expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,selectedSourceId,primaryCommand.command_id,send)).toMatchObject({status:'acknowledged'});
      expect(primary.revision).toBe('2');secondary.generation++;
      const refusal=await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,secondSourceId,targetCommand.command_id,send);
      expect(refusal,JSON.stringify(refusal)).toMatchObject({status:'conflict',profileGenerationConflict:true});
      const revokeTarget=async()=>{
        const owner={id:staffId,email:actor.identity.email,displayName:actor.identity.displayName,accessSubject:actor.identity.verifiedAccessSubject,projectAlphaUserId:null};
        expect(await manageSharedProfilePortalGrant(env,owner,{operationId:uuid(),id:targetGrant.id,workspaceId:secondary.workspace,sourceId:secondSourceId,
          recipientMode:'first_verified_identity',issuer:null,subject:null,principalPublicId:secondary.principalId,targetType:'client',targetPublicId:secondary.publicId,recordId:approved.clientRecordId,
          groupId:targetGrant.group_id,expectedRevision:1,state:'revoked'})).toMatchObject({ok:true,revision:2});
      }
      if(mode==='target_template_revoked')await revokeTarget();
      if(mode==='target_template_revoked_during_probe')revokeTargetDuringRead=revokeTarget;
      if(mode==='proof_expires_before_post')expireBeforePost=true;
      if(mode==='target_association_changed')secondary.association='d'.repeat(64);
      if(mode==='original_own_changed')primary.association='e'.repeat(64);
      const result=await recoverDirectoryProfileGeneration(env,secondSourceId,targetCommand.command_id,send);
      const lineage=(await db.prepare('SELECT * FROM project_alpha_directory_profile_generation_recoveries WHERE predecessor_command_id=?').bind(targetCommand.command_id).all<Record<string,any>>()).results;
      expect(primary.profile).toEqual(desired);expect(await db.prepare('SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?').bind(targetCommand.command_id).first('command_json')).toBe(targetCommand.command_json);
      if(mode==='current'){
        expect(result,JSON.stringify(result)).toMatchObject({status:'acknowledged'});expect(lineage).toHaveLength(1);expect(secondary.profile).toEqual(desired);
        expect(lineage[0]).toMatchObject({source_id:secondSourceId,identity_policy:'automatic_own'});
        expect(JSON.parse(lineage[0]!.observed_identity_json).clientPortalIdentity).toMatchObject({principalPublicId:secondary.principalId,associationVersion:'b'.repeat(64)});
        expect(await db.prepare('SELECT state FROM operations_directory_intents WHERE record_id=? AND record_version=2 AND source_id=?').bind(approved.clientRecordId,secondSourceId).first('state')).toBe('acknowledged');
      }else{
        expect(result.status,JSON.stringify(result)).not.toBe('acknowledged');expect(lineage).toHaveLength(mode==='proof_expires_before_post'?1:0);expect(secondary.profile.phone).toBe(consumer.phone);
        if(mode==='proof_expires_before_post'){expect(clockShifted).toBe(true);expect(posts.every(p=>p.body.commandId!==lineage[0]!.successor_command_id)).toBe(true);}
        if(mode==='target_template_revoked_during_probe')expect(revokeTargetDuringRead).toBeNull();
      }
      expect(await db.prepare('SELECT issuer,subject FROM shared_profile_portal_grants WHERE id=?').bind(targetGrant.id).first()).toEqual({issuer:null,subject:null});
      expect((await db.prepare('SELECT source_id,principal_public_id,association_version FROM client_onboarding_portal_activation_proofs WHERE decision_id=? ORDER BY source_id').bind(approved.decisionId).all()).results).toEqual([
        {source_id:selectedSourceId,principal_public_id:primary.principalId,association_version:'a'.repeat(64)},
        {source_id:secondSourceId,principal_public_id:secondary.principalId,association_version:'b'.repeat(64)},
      ].sort((a,b)=>a.source_id.localeCompare(b.source_id)));
    },240_000);
  }

});
