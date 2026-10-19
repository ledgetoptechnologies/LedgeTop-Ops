import {materializeResolvedProjectAlphaDirectoryClientIntents} from "../src/worker/project-alpha-directory-client-intent-materializer";
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

describe("bounded automatic activation cursor wrap through actual migrated D1", () => {
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
      && item.slice(0, 4) <= "0219").sort())
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


  it("visits new decisions below an exhausted cursor in the same bounded tick and preserves a concurrent cursor winner",async()=>{
    inventoryRead.mockResolvedValue({status:"observed",inventory:{authorizationGeneration:"8"}});
    const approved=[];
    for(let n=0;n<6;n++){
      const item=await submission({...consumer,name:`Cursor Client ${n}`,email:`cursor-${n}@example.test`});
      approved.push(await approveNewNativeOnlyClientOnboarding(db,actor,item.submissionId,item.fieldsSha256,[selectedSourceId],selectedConnection));
    }
    const ids=approved.map(a=>a.decisionId).sort();
    const environment={OPS_DB:db,DELIVERY_DB:deliveryDb,PROJECT_ALPHA_API_V2_CONNECTIONS:selectedConnection,
      CLIENT_ONBOARDING_ADMIN_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:"true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:"true"} as Env;
    await db.prepare("UPDATE client_onboarding_portal_activation_scan SET after_decision_id=? WHERE singleton=1").bind("ffffffff-ffff-4fff-bfff-ffffffffffff").run();
    const versions=async()=>Object.fromEntries((await db.prepare("SELECT decision_id,version FROM client_onboarding_portal_activation_intents ORDER BY decision_id").all<{decision_id:string;version:number}>()).results.map(r=>[r.decision_id,r.version]));
    expect(await versions()).toEqual(Object.fromEntries(ids.map(id=>[id,1])));
    // All six were inserted behind the persisted cursor. The empty-tail read
    // now wraps immediately rather than spending this invocation resetting it.
    expect(await processClientOnboardingPortalActivation(environment)).toEqual({processed:4,active:0});
    expect(await versions()).toEqual(Object.fromEntries(ids.map((id,n)=>[id,n<4?2:1])));
    expect(await db.prepare("SELECT after_decision_id,version FROM client_onboarding_portal_activation_scan").first()).toEqual({after_decision_id:ids[3],version:2});
    expect(await processClientOnboardingPortalActivation(environment)).toEqual({processed:2,active:0});
    expect(await versions()).toEqual(Object.fromEntries(ids.map(id=>[id,2])));
    expect(await db.prepare("SELECT after_decision_id,version FROM client_onboarding_portal_activation_scan").first()).toEqual({after_decision_id:ids[5],version:3});
    let injected=false;
    // Another scheduler invocation wins the cursor CAS after our selection.
    // Do not replace the winner with this stale invocation's wrapped cursor.
    const competing="eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee";
    const raceDb={prepare:(sql:string)=>db.prepare(sql),batch:(statements:D1PreparedStatement[])=>db.batch(statements),withSession:()=>({prepare:(sql:string)=>{
      const statement=db.prepare(sql);
      if(!sql.startsWith("UPDATE client_onboarding_portal_activation_scan"))return statement;
      return {bind:(...args:unknown[])=>({run:async()=>{
        expect(injected).toBe(false);injected=true;
        await db.prepare("UPDATE client_onboarding_portal_activation_scan SET after_decision_id=?,version=version+1 WHERE singleton=1").bind(competing).run();
        return statement.bind(...args).run();
      }})};
    }})}as unknown as D1Database;
    expect(await processClientOnboardingPortalActivation({...environment,OPS_DB:raceDb})).toEqual({processed:4,active:0});
    expect(injected).toBe(true);expect(await versions()).toEqual(Object.fromEntries(ids.map((id,n)=>[id,n<4?3:2])));
    expect(await db.prepare("SELECT after_decision_id,version FROM client_onboarding_portal_activation_scan").first()).toEqual({after_decision_id:competing,version:4});
    expect((await db.prepare("SELECT DISTINCT reason FROM client_onboarding_portal_activation_intents").all()).results).toEqual([{reason:"awaiting_pa"}]);
    expect(await count("shared_profile_portal_grants")).toBe(0);
    expect(await count("client_onboarding_portal_activation_proofs")).toBe(0);
    expect(portalProofRead).not.toHaveBeenCalled();
  },120_000);
});
