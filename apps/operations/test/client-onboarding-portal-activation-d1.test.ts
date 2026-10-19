import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { approveNewNativeOnlyClientOnboarding } from "../src/worker/client-onboarding-approval";
import { processClientOnboardingPortalActivation,onboardingPortalGrantIdentityCurrent } from "../src/worker/client-onboarding-portal-activation";
import { readNativeDirectoryDurableRemoteHead } from "../src/worker/native-directory-profile-writer";
import type { Env } from "../src/worker/types";
import type { SharedProfilePortalGrant } from "../src/worker/shared-profile-portal-authority";
const portalProofRead=vi.hoisted(()=>vi.fn());
vi.mock("../src/worker/project-alpha-directory-read-api-v2",async original=>({...await original<typeof import("../src/worker/project-alpha-directory-read-api-v2")>(),readConfiguredProjectAlphaDirectoryClientPortalIdentity:portalProofRead}));
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
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(item => /^\d{4}_.+\.sql$/.test(item)
      && item.slice(0, 4) <= "0214").sort())
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
});
