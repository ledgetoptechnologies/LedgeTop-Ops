import {readNativeDirectoryDurableRemoteHead} from "../src/worker/native-directory-profile-writer";
import {prepareClientOnboardingSharedCompanyPlan,readClientOnboardingSharedCompanyChoices} from "../src/worker/client-onboarding-shared-company-plan";
import {approveClientOnboardingSharedCompany} from "../src/worker/client-onboarding-shared-company-approval";
import {sharedProfileCreationFence,sharedProfileCreationStatements,type SharedProfileMember} from "../src/worker/native-directory-shared-profile-routes";
import { materializeResolvedProjectAlphaDirectoryClientIntents } from "../src/worker/project-alpha-directory-client-intent-materializer";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { approveNewNativeOnlyClientOnboarding as approveRaw } from "../src/worker/client-onboarding-approval";
import { readClientOnboardingExistingCompanies } from "../src/worker/client-onboarding-existing-company";
import { listClientOnboardingSubmissionsForReview } from "../src/worker/client-onboarding-review";

const inventoryRead = vi.hoisted(() => vi.fn());
const bindingRead=vi.hoisted(()=>vi.fn());
vi.mock("../src/worker/project-alpha-directory-read-api-v2",async original=>({
  ...await original<typeof import("../src/worker/project-alpha-directory-read-api-v2")>(),
  readConfiguredProjectAlphaDirectoryBindingStatus:bindingRead,
}));
vi.mock("../src/worker/project-alpha-directory-inventory-api-v2", () => ({
  readConfiguredProjectAlphaDirectoryInventory: inventoryRead,
}));

async function approveNewNativeOnlyClientOnboarding(...args:Parameters<typeof approveRaw>) {
  // Explicit company creation in these legacy creation regressions.
  if (args[6]===undefined && args[2] && await db.prepare("SELECT 1 FROM client_onboarding_submissions WHERE submission_id=? AND json_extract(fields_json,'$.clientType')='business'").bind(args[2]).first())
    args[6]={kind:"new"};
  return approveRaw(...args);
}
let runtime: Miniflare | undefined;
let db: D1Database;
let sequence = 0;
let approvedClientRecordId = "";
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

describe("native-only client onboarding approval against migrated D1", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      compatibilityFlags: ["nodejs_compat"], script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(item => /^\d{4}_.+\.sql$/.test(item)
      && item.slice(0, 4) <= "0218").sort())
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
  }, 240_000);
  afterAll(async () => runtime?.dispose());

  it("creates exactly one unlinked native client, replays deterministically, and reserves no PA work", async () => {
    const item = await submission(), beforeOutbox = await count("project_alpha_directory_outbox");
    expect((await listClientOnboardingSubmissionsForReview(db, actor)).submissions.map(item => item.submissionId)).toContain(item.submissionId);
    const first = await approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256);
    expect((await listClientOnboardingSubmissionsForReview(db, actor)).submissions.map(item => item.submissionId)).not.toContain(item.submissionId);
    expect(await db.prepare("SELECT client_record_id,policy,state FROM client_onboarding_portal_activation_intents WHERE decision_id=?")
      .bind(first.decisionId).first()).toEqual({client_record_id:first.clientRecordId,policy:"own_client_profile_v1",state:"pending"});
    approvedClientRecordId = first.clientRecordId;
    expect(first).toMatchObject({ status: "written", replayed: false, submissionId: item.submissionId,
      clientRecordVersion: 1, relationshipVersion: 1 });
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256))
      .resolves.toMatchObject({ status: "written", replayed: true, decisionId: first.decisionId,
        clientRecordId: first.clientRecordId });
    expect(await db.prepare(`SELECT record_kind,current_version FROM operations_directory_records
      WHERE record_id=?`).bind(first.clientRecordId).first()).toEqual({ record_kind: "client", current_version: 1 });
    expect(await db.prepare(`SELECT organization_record_id,relationship_version
      FROM operations_directory_client_organizations WHERE client_record_id=?`)
      .bind(first.clientRecordId).first()).toEqual({ organization_record_id: null, relationship_version: 1 });
    expect(await db.prepare("SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?")
      .bind(first.clientRecordId).first("destinations_json")).toBe("[]");
    expect(await count("project_alpha_directory_outbox")).toBe(beforeOutbox);
    expect(await db.prepare("SELECT count(*) count FROM operations_directory_intents WHERE record_id=?")
      .bind(first.clientRecordId).first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM client_onboarding_decisions WHERE submission_id=?")
      .bind(item.submissionId).first("count")).toBe(1);
    const immutable = await db.prepare(`SELECT decision.request_sha256,audit.mutation_id,
      history.mutation_id relationship_mutation_id FROM client_onboarding_decisions decision
      JOIN operations_directory_audit audit ON audit.record_id=decision.client_record_id
      JOIN operations_directory_client_organization_history history ON history.client_record_id=decision.client_record_id
      WHERE decision.submission_id=?`).bind(item.submissionId).first<Record<string, string>>();
    expect(immutable?.request_sha256).toBe(await sha256(JSON.stringify([
      "client-onboarding-native-only-approval-v1", first.decisionId, item.invitationId, item.submissionId,
      item.fieldsSha256, "b".repeat(64), "Approved as a new native-only, unlinked client profile",
      JSON.stringify(consumer), [{ businessAreaId: "area:drone", divisionId: "division:north" }],
      first.clientRecordId, immutable?.mutation_id, immutable?.relationship_mutation_id, staffId,
      actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.profileVersion,
    ])));
  });

  it("pins selected server-owned PA identity and replays without resolving changed configuration", async () => {
    const item = await submission();
    inventoryRead.mockResolvedValue({ status: "observed", inventory: { authorizationGeneration: "7" } });
    const first = await approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId,
      item.fieldsSha256, [selectedSourceId], selectedConnection);
    expect(first).toMatchObject({ status: "written", replayed: false });
    const stored = await db.prepare(`SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?`)
      .bind(first.clientRecordId).first<string>("destinations_json");
    expect(JSON.parse(stored ?? "null")).toEqual([{ sourceId: selectedSourceId,
      sourceInstanceUUID: "a0000000-0000-4000-8000-000000000001",
      applicationUUID: "b0000000-0000-4000-8000-000000000002",
      historyEpoch: "c0000000-0000-4000-8000-000000000003",
      origin: "https://pa-primary.example.test", externalCanonicalId: first.clientRecordId }]);
    expect(await db.prepare(`SELECT count(*) count FROM operations_directory_intents WHERE record_id=?`)
      .bind(first.clientRecordId).first<number>("count")).toBe(1);
    inventoryRead.mockReset().mockRejectedValue(new Error("must_not_probe_replay"));
    const replay = await approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId,
      item.fieldsSha256, [selectedSourceId]);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(inventoryRead).not.toHaveBeenCalled();
  });

  it("binds one consumer record to both explicitly selected PA instances", async () => {
    const item = await submission();
    inventoryRead.mockReset().mockResolvedValue({ status: "observed",
      inventory: { authorizationGeneration: "8" } });
    const first = await approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId,
      item.fieldsSha256, [secondSourceId, selectedSourceId], dualConnection);
    expect(first).toMatchObject({ status: "written", replayed: false });
    const stored = await db.prepare(`SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?`)
      .bind(first.clientRecordId).first<string>("destinations_json");
    expect((JSON.parse(stored ?? "null") as Array<{ sourceId: string }>).map(item => item.sourceId))
      .toEqual([selectedSourceId, secondSourceId]);
    expect(await db.prepare(`SELECT count(*) count FROM operations_directory_intents WHERE record_id=?`)
      .bind(first.clientRecordId).first<number>("count")).toBe(2);
    expect(inventoryRead).toHaveBeenCalledTimes(2);
  });

  it("rejects stale review fingerprints and existing targets without writes", async () => {
    const stale = await submission();
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, stale.submissionId, "f".repeat(64)))
      .rejects.toThrow("client_onboarding_approval_denied");
    expect(approvedClientRecordId).not.toBe("");
    const existing = await submission(consumer, approvedClientRecordId);
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, existing.submissionId, existing.fieldsSha256))
      .rejects.toThrow("client_onboarding_approval_denied");
    for (const item of [stale, existing])
      expect(await db.prepare("SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?")
        .bind(item.submissionId).first()).toBeNull();
  });

  it("atomically creates and links a native organization and client, replays, and reserves no access or delivery work", async () => {
    const item = await submission(business);
    const sideEffectTables = ["project_alpha_directory_outbox", "project_alpha_directory_relationship_outbox",
      "operations_directory_intents", "operations_directory_materializations",
      "operations_directory_intent_relationship_dependencies", "project_alpha_active_directory_mappings",
      "native_directory_grants", "client_onboarding_invitations"];
    const before = new Map<string, number>();
    for (const table of sideEffectTables) before.set(table, await count(table));
    const first = await approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256);
    expect(first).toMatchObject({ status: "written", replayed: false, clientRecordVersion: 1,
      organizationRecordVersion: 1, relationshipVersion: 1 });
    expect(first.organizationRecordId).toMatch(/^[0-9a-f-]{36}$/);
    const replay = await approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await db.prepare(`SELECT record_id,record_kind,current_version FROM operations_directory_records
      WHERE record_id IN (?,?) ORDER BY record_kind`).bind(first.clientRecordId, first.organizationRecordId).all())
      .toMatchObject({ results: [
        { record_id: first.clientRecordId, record_kind: "client", current_version: 1 },
        { record_id: first.organizationRecordId, record_kind: "organization", current_version: 1 },
      ] });
    expect(await db.prepare(`SELECT organization_record_id,relationship_version FROM operations_directory_client_organizations
      WHERE client_record_id=?`).bind(first.clientRecordId).first()).toEqual({
        organization_record_id: first.organizationRecordId, relationship_version: 1 });
    expect(await db.prepare(`SELECT organization_record_id,relationship_version FROM operations_directory_client_organization_history
      WHERE client_record_id=?`).bind(first.clientRecordId).first()).toMatchObject({
        organization_record_id: first.organizationRecordId, relationship_version: 1 });
    for (const recordId of [first.clientRecordId, first.organizationRecordId]) {
      expect(await db.prepare("SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?")
        .bind(recordId).first("destinations_json")).toBe("[]");
      expect(await db.prepare("SELECT count(*) count FROM operations_directory_revisions WHERE record_id=?")
        .bind(recordId).first("count")).toBe(1);
      expect(await db.prepare("SELECT count(*) count FROM operations_directory_audit WHERE record_id=?")
        .bind(recordId).first("count")).toBe(1);
    }
    expect(await db.prepare(`SELECT count(*) count FROM native_directory_create_admissions
      WHERE record_id IN (?,?) AND active=0 AND consumed_mutation_id IS NOT NULL`)
      .bind(first.clientRecordId, first.organizationRecordId).first("count")).toBe(2);
    expect(await count("client_onboarding_decision_fences")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM client_onboarding_decisions WHERE submission_id=?")
      .bind(item.submissionId).first("count")).toBe(1);
    for (const table of sideEffectTables) expect(await count(table), table).toBe(before.get(table));
  });

  it("rolls back every business artifact on a late decision failure", async () => {
    const item = await submission(business);
    const beforeRecords = await count("operations_directory_records"), beforeAdmissions = await count("native_directory_create_admissions");
    await db.prepare(`CREATE TRIGGER reject_business_decision BEFORE INSERT ON client_onboarding_decisions
      WHEN NEW.submission_id='${item.submissionId}' BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END`).run();
    try {
      await expect(approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256))
        .rejects.toThrow("client_onboarding_approval_denied");
      expect(await count("operations_directory_records")).toBe(beforeRecords);
      expect(await count("native_directory_create_admissions")).toBe(beforeAdmissions);
      expect(await db.prepare("SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?").bind(item.submissionId).first()).toBeNull();
      expect(await db.prepare("SELECT 1 FROM client_onboarding_decision_fences WHERE submission_id=?").bind(item.submissionId).first()).toBeNull();
    } finally { await db.prepare("DROP TRIGGER reject_business_decision").run(); }
  });

  it("rechecks current independent authority before replaying a business approval", async () => {
    const item = await submission(business);
    const first = await approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256);
    const records = await count("operations_directory_records"), decisions = await count("client_onboarding_decisions");
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='approve-identity'").run();
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256))
      .rejects.toThrow("client_onboarding_approval_denied");
    expect(await count("operations_directory_records")).toBe(records);
    expect(await count("client_onboarding_decisions")).toBe(decisions);
    expect(first.organizationRecordId).not.toBeNull();
    await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='approve-identity'").run();
  });

  it("requires current identity-link authority independently of review access", async () => {
    const item = await submission();
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='approve-identity'").run();
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256))
      .rejects.toThrow("client_onboarding_approval_denied");
    expect(await db.prepare("SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?")
      .bind(item.submissionId).first()).toBeNull();
    await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='approve-identity'").run();
  });

  it("rejects ambiguous consumer organization fields and business submissions without an organization name", async () => {
    const consumerWithOrganization = await submission({ ...consumer, organizationPhone: "920-555-0199" });
    const businessWithoutOrganization = await submission({ ...business, organizationName: "" });
    for (const item of [consumerWithOrganization, businessWithoutOrganization]) {
      await expect(approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256))
        .rejects.toThrow("client_onboarding_approval_denied");
      expect(await db.prepare("SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?")
        .bind(item.submissionId).first()).toBeNull();
    }
  });

  it("rejects split grants when no selected grant covers every proposed scope", async () => {
    await db.batch([
      db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='approve-profile'"),
      db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,division_id,active,granted_by)
        VALUES('approve-profile-north',?,'directory.profile.edit','allow','division','division:north',1,?)`)
        .bind(staffId, staffId),
      db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,division_id,active,granted_by)
        VALUES('approve-profile-south',?,'directory.profile.edit','allow','division','division:south',1,?)`)
        .bind(staffId, staffId),
    ]);
    const item = await submission(business, null, [
      { businessAreaId: "area:drone", divisionId: "division:north" },
      { businessAreaId: "area:drone", divisionId: "division:south" },
    ]);
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256))
      .rejects.toThrow("client_onboarding_approval_denied");
    expect(await db.prepare("SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?")
      .bind(item.submissionId).first()).toBeNull();
    await db.batch([
      db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='approve-profile'"),
      db.prepare("UPDATE native_directory_grants SET active=0 WHERE id IN ('approve-profile-north','approve-profile-south')"),
    ]);
  });

  it("applies scoped deny precedence independently to both business records", async () => {
    const item = await submission(business), beforeRecords = await count("operations_directory_records");
    await db.prepare(`INSERT INTO native_directory_grants
      (id,staff_id,permission,effect,scope_kind,division_id,active,granted_by)
      VALUES('deny-business-identity-north',?,'directory.identity.link','deny','division','division:north',1,?)`)
      .bind(staffId, staffId).run();
    try {
      await expect(approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256))
        .rejects.toThrow("client_onboarding_approval_denied");
      expect(await count("operations_directory_records")).toBe(beforeRecords);
      expect(await db.prepare("SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?")
        .bind(item.submissionId).first()).toBeNull();
    } finally {
      await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='deny-business-identity-north'").run();
    }
  });
  it("requires an explicit company review choice while preserving individual API compatibility",async()=>{
    const item=await submission(business), before=await count("operations_directory_records");
    await expect(approveRaw(db,actor,item.submissionId,item.fieldsSha256)).rejects.toThrow("client_onboarding_approval_denied");
    expect(await count("operations_directory_records")).toBe(before);
    const person=await submission(consumer);
    await expect(approveRaw(db,actor,person.submissionId,person.fieldsSha256,[],undefined,{kind:"new"}))
      .rejects.toThrow("client_onboarding_approval_denied");
    expect(await approveRaw(db,actor,person.submissionId,person.fieldsSha256)).toMatchObject({status:"written"});
  });

  it("reuses an explicitly reviewed company without changing its fields or duplicating it, and replays exactly",async()=>{
    const firstItem=await submission(business);
    const first=await approveRaw(db,actor,firstItem.submissionId,firstItem.fieldsSha256,[],undefined,{kind:"new"});
    const companyId=first.organizationRecordId!;
    await db.prepare(`INSERT OR IGNORE INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('approve-view',?,'directory.profile.view','allow','global',1,?)`).bind(staffId,staffId).run();
    const item=await submission({...business,name:"Second Contact",organizationName:"Unreviewed changed company",organizationPhone:"920-555-0999"});
    const choices=await readClientOnboardingExistingCompanies(db,actor,{submissionId:item.submissionId,sourceIds:[],query:"Example",afterRecordId:null});
    expect(choices.companies.find(value=>value.recordId===companyId)).toMatchObject({expectedVersion:1,reusable:true,sourceIds:[]});
    const selection={kind:"existing" as const,recordId:companyId,expectedVersion:1};
    const before=await count("operations_directory_records"), outbox=await count("project_alpha_directory_outbox");
    const result=await approveRaw(db,actor,item.submissionId,item.fieldsSha256,[],undefined,selection);
    expect(result).toMatchObject({status:"written",organizationRecordId:companyId,organizationRecordVersion:2,relationshipVersion:1});
    expect(await count("operations_directory_records")).toBe(before+1);
    expect(await count("project_alpha_directory_outbox")).toBe(outbox);
    expect(await db.prepare(`SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=2`).bind(companyId).first("profile_json"))
      .toBe(await db.prepare(`SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=1`).bind(companyId).first("profile_json"));
    expect(await db.prepare("SELECT organization_record_id FROM operations_directory_client_organizations WHERE client_record_id=?").bind(result.clientRecordId).first("organization_record_id")).toBe(companyId);
    expect(await approveRaw(db,actor,item.submissionId,item.fieldsSha256,[],undefined,selection)).toMatchObject({...result,replayed:true});
    await expect(approveRaw(db,actor,item.submissionId,item.fieldsSha256,[],undefined,{...selection,expectedVersion:2}))
      .rejects.toThrow("client_onboarding_approval_denied");
  });

  it("rejects uncovered PA destinations, stale companies, and current scoped denies before any mutation",async()=>{
    const firstItem=await submission(business);
    const first=await approveRaw(db,actor,firstItem.submissionId,firstItem.fieldsSha256,[],undefined,{kind:"new"});
    const selection={kind:"existing" as const,recordId:first.organizationRecordId!,expectedVersion:1};
    const item=await submission(business),before=await count("operations_directory_records");
    const choices=await readClientOnboardingExistingCompanies(db,actor,{submissionId:item.submissionId,sourceIds:[selectedSourceId],query:"Example",afterRecordId:null});
    expect(choices.companies.find(value=>value.recordId===selection.recordId)).toMatchObject({reusable:false,reason:"selected_sources_not_covered"});
    await expect(approveRaw(db,actor,item.submissionId,item.fieldsSha256,[selectedSourceId],selectedConnection,selection)).rejects.toThrow();
    await expect(approveRaw(db,actor,item.submissionId,item.fieldsSha256,[],undefined,{...selection,expectedVersion:99})).rejects.toThrow();
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active,granted_by)
      VALUES('deny-reuse-company',?,'directory.profile.edit','deny','resource',?,1,?)`).bind(staffId,selection.recordId,staffId).run();
    try {
      await expect(approveRaw(db,actor,item.submissionId,item.fieldsSha256,[],undefined,selection)).rejects.toThrow();
      await expect(readClientOnboardingExistingCompanies(db,actor,{submissionId:item.submissionId,sourceIds:[],query:"",afterRecordId:null})).rejects.toThrow();
    } finally {await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='deny-reuse-company'").run();}
    expect(await count("operations_directory_records")).toBe(before);
  });

  it("links a second enrolled contact through the existing company's exact PA parent intent, without another company create",async()=>{
    await db.prepare(`INSERT OR IGNORE INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('approve-view',?,'directory.profile.view','allow','global',1,?)`).bind(staffId,staffId).run();
    inventoryRead.mockResolvedValue({status:"observed",inventory:{authorizationGeneration:"8"}});
    const item=await submission(business);
    const first=await approveRaw(db,actor,item.submissionId,item.fieldsSha256,[selectedSourceId],selectedConnection,{kind:"new"});
    const company=first.organizationRecordId!;
    const outbox=await db.prepare(`SELECT o.command_id FROM project_alpha_directory_outbox o
      JOIN operations_directory_materializations m ON m.command_id=o.command_id
      JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=?`).bind(company).first<{command_id:string}>();
    expect(outbox).not.toBeNull();
    const commandId=outbox!.command_id,publicId="a".repeat(32);
    const identity={sourceInstanceId:"a0000000-0000-4000-8000-000000000001",applicationId:"b0000000-0000-4000-8000-000000000002",historyEpoch:"c0000000-0000-4000-8000-000000000003"};
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='synthetic',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'").bind(commandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,'organization',?,?,?,?,?,?)`).bind(selectedSourceId,company,publicId,identity.sourceInstanceId,identity.applicationId,identity.historyEpoch,commandId).run();
    const outcome={status:"acknowledged",response:{requestId:commandId,replayed:false,...identity,result:{resource:{type:"organization",id:company,publicId,revision:"1"},data:{publicId},authorizationGeneration:"9"}}};
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'").bind(JSON.stringify(outcome),commandId).run();
    await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE record_id=? AND state='materialized'").bind(company).run();
    await expect(materializeResolvedProjectAlphaDirectoryClientIntents(db,[selectedSourceId],12,Date.now())).resolves.toMatchObject({materialized:1});
    const childOutbox=await db.prepare(`SELECT o.command_id FROM project_alpha_directory_outbox o
      JOIN operations_directory_materializations m ON m.command_id=o.command_id
      JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=?`).bind(first.clientRecordId).first<{command_id:string}>();
    const childCommandId=childOutbox!.command_id,childPublicId="b".repeat(32);
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='synthetic',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'").bind(childCommandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,'client',?,?,?,?,?,?)`).bind(selectedSourceId,first.clientRecordId,childPublicId,identity.sourceInstanceId,identity.applicationId,identity.historyEpoch,childCommandId).run();
    const childOutcome={status:"acknowledged",response:{requestId:childCommandId,replayed:false,...identity,result:{resource:{type:"client",id:first.clientRecordId,publicId:childPublicId,revision:"1"},data:{publicId:childPublicId},authorizationGeneration:"9"}}};
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'").bind(JSON.stringify(childOutcome),childCommandId).run();
    await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE record_id=? AND state='materialized'").bind(first.clientRecordId).run();
    inventoryRead.mockImplementation(async()=>({status:"observed",inventory:{authoritative:false,sourceId:selectedSourceId,
      ...identity,requestId:uuid(),authorizationGeneration:"9",resources:[],nextCursor:null}}));
    bindingRead.mockResolvedValue({status:"observed",observation:{authorizationGeneration:"9",resource:{revision:"1"}}});
    const next=await submission({...business,name:"Another Contact"});
    const result=await approveRaw(db,actor,next.submissionId,next.fieldsSha256,[selectedSourceId],selectedConnection,
      {kind:"existing",recordId:company,expectedVersion:1});
    expect(result).toMatchObject({organizationRecordId:company,organizationRecordVersion:2});
    expect(await db.prepare("SELECT json_extract(audit.command_json,'$.operation') operation FROM operations_directory_audit audit JOIN operations_directory_revisions revision ON revision.mutation_id=audit.mutation_id WHERE revision.record_id=? AND revision.version=2").bind(company).first("operation")).toBe("update");
    expect((await db.prepare(`SELECT evidence_kind,organization_record_id,organization_record_version,parent_external_canonical_id
      FROM operations_directory_intent_relationship_dependencies WHERE client_record_id=?`).bind(result.clientRecordId).all()).results)
      .toEqual([{evidence_kind:"parent_intent",organization_record_id:company,organization_record_version:2,parent_external_canonical_id:company}]);
    expect(await db.prepare("SELECT count(*) total FROM operations_directory_intents WHERE record_id=?").bind(result.clientRecordId).first("total")).toBe(1);
    const update=await db.prepare(`SELECT outbox.command_id FROM operations_directory_intents intent
      JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
      WHERE intent.record_id=? AND intent.record_version=2`).bind(company).first<{command_id:string}>();
    expect(update).not.toBeNull();const updateCommandId=update!.command_id;
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='synthetic',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'").bind(updateCommandId).run();
    const updated={status:"acknowledged",response:{requestId:updateCommandId,replayed:false,...identity,result:{resource:{type:"organization",publicId,revision:"2"},data:{publicId},authorizationGeneration:"9"}}};
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'").bind(JSON.stringify(updated),updateCommandId).run();
    await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE record_id=? AND record_version=2 AND state='materialized'").bind(company).run();
    const wrongParentProof=new Proxy(db,{get(target,property){
      if(property==="prepare")return(sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.includes("parent_audit.command_json parent_audit_command_json"))return statement;
        const wrapped=(bound:D1PreparedStatement):D1PreparedStatement=>new Proxy(bound,{get(value,key){
          if(key==="bind")return(...parameters:unknown[])=>wrapped(value.bind(...parameters));
          if(key==="all")return async()=>{
            const result=await value.all<Record<string,unknown>>();
            return {...result,results:result.results.map(row=>{
              const audit=JSON.parse(String(row.parent_audit_command_json));audit.expectedLocalVersion=0;
              return {...row,parent_audit_command_json:JSON.stringify(audit)};
            })};
          };
          const member=value[key as keyof D1PreparedStatement];return typeof member==="function"?member.bind(value):member;
        }});
        return wrapped(statement);
      };
      const value=target[property as keyof D1Database];return typeof value==="function"?value.bind(target):value;
    }});
    await expect(materializeResolvedProjectAlphaDirectoryClientIntents(wrongParentProof,[selectedSourceId],12,Date.now())).resolves.toMatchObject({materialized:0,blocked:1});
    await expect(materializeResolvedProjectAlphaDirectoryClientIntents(db,[selectedSourceId],12,Date.now())).resolves.toMatchObject({materialized:1,blocked:0});
    const second=await db.prepare(`SELECT materialization.command_id,materialization.command_json FROM operations_directory_intents intent
      JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id WHERE intent.record_id=?`).bind(result.clientRecordId).first<{command_id:string;command_json:string}>();
    expect(second).not.toBeNull();expect(JSON.parse(second!.command_json).fields.organizationPublicId).toBe(publicId);
    const secondPublic="c".repeat(32),secondId=second!.command_id;
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='synthetic',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'").bind(secondId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,'client',?,?,?,?,?,?)`).bind(selectedSourceId,result.clientRecordId,secondPublic,identity.sourceInstanceId,identity.applicationId,identity.historyEpoch,secondId).run();
    const secondOutcome={status:"acknowledged",response:{requestId:secondId,replayed:false,...identity,result:{resource:{type:"client",id:result.clientRecordId,publicId:secondPublic,revision:"1"},data:{publicId:secondPublic},authorizationGeneration:"10"}}};
    await db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'").bind(JSON.stringify(secondOutcome),secondId).run();
    await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE record_id=? AND state='materialized'").bind(result.clientRecordId).run();
    expect(await readNativeDirectoryDurableRemoteHead(db,"client",result.clientRecordId,1,{sourceId:selectedSourceId,
      sourceInstanceUUID:identity.sourceInstanceId,applicationUUID:identity.applicationId,historyEpoch:identity.historyEpoch,
      origin:"https://pa-primary.example.test",externalCanonicalId:result.clientRecordId})).toEqual({projectAlphaPublicId:secondPublic,externalCanonicalId:result.clientRecordId,revision:"1"});
    expect(await approveRaw(db,actor,next.submissionId,next.fieldsSha256,[selectedSourceId],selectedConnection,
      {kind:"existing",recordId:company,expectedVersion:1})).toMatchObject({...result,replayed:true});
    expect(await materializeResolvedProjectAlphaDirectoryClientIntents(db,[selectedSourceId],12,Date.now())).toMatchObject({materialized:0});
  });

  it("seals a grouped company plan then atomically approves only its exact selected new contacts without changing companies or grants",async()=>{
    await db.prepare(`INSERT OR IGNORE INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('approve-view',?,'directory.profile.view','allow','global',1,?)`).bind(staffId,staffId).run();
    const configurations=JSON.parse(dualConnection).instances;
    let currentGeneration="8";
    inventoryRead.mockImplementation(async(_environment,sourceId)=>{
      const source=configurations[sourceId];return {status:"observed",inventory:{authoritative:false,sourceId,
        sourceInstanceId:source.sourceInstanceId,applicationId:source.applicationId,historyEpoch:source.historyEpoch,
        requestId:uuid(),authorizationGeneration:currentGeneration,resources:[],nextCursor:null}};
    });
    bindingRead.mockImplementation(async(_environment,sourceId,type,externalId,publicId)=>{
      const source=configurations[sourceId];return {status:"observed",observation:{sourceId,
        sourceInstanceId:source.sourceInstanceId,applicationId:source.applicationId,historyEpoch:source.historyEpoch,
        requestId:uuid(),authorizationGeneration:"9",binding:{type,externalId,publicId,createdAt:"2026-01-01T00:00:00.000Z"},resource:{revision:"1",present:true}}};
    });
    async function ack(recordId:string,type:"organization"|"client",sourceId:string,publicId:string){
      const row=await db.prepare(`SELECT o.command_id FROM project_alpha_directory_outbox o JOIN operations_directory_materializations m ON m.command_id=o.command_id
        JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=?`).bind(recordId).first<{command_id:string}>();
      expect(row).not.toBeNull();const command=row!.command_id,source=configurations[sourceId];
      await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='synthetic',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'").bind(command).run();
      await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
        VALUES(?,?,?,?,?,?,?,?)`).bind(sourceId,type,recordId,publicId,source.sourceInstanceId,source.applicationId,source.historyEpoch,command).run();
      const outcome={status:"acknowledged",response:{requestId:command,replayed:false,sourceInstanceId:source.sourceInstanceId,applicationId:source.applicationId,historyEpoch:source.historyEpoch,
        result:{resource:{type,id:recordId,publicId,revision:"1"},data:{publicId},authorizationGeneration:"9"}}};
      await db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'").bind(JSON.stringify(outcome),command).run();
      await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE record_id=? AND state='materialized'").bind(recordId).run();
    }
    const members:SharedProfileMember[]=[];
    for(const [index,source] of [selectedSourceId,secondSourceId].entries()){
      const item=await submission(business),created=await approveRaw(db,actor,item.submissionId,item.fieldsSha256,[source],dualConnection,{kind:"new"});
      await ack(created.organizationRecordId!,"organization",source,(index===0?"6":"7").repeat(32));
      await materializeResolvedProjectAlphaDirectoryClientIntents(db,[source],12,Date.now());
      await ack(created.clientRecordId,"client",source,(index===0?"8":"9").repeat(32));
      const fields=JSON.parse(await db.prepare("SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=1").bind(created.organizationRecordId).first<string>("profile_json") ?? "null");
      members.push({recordId:created.organizationRecordId!,version:1,kind:"organization",profile:fields,sourceIds:[source],parentRecordId:null,parentVersion:null,relationshipVersion:null});
    }
    members.sort((a,b)=>a.recordId.localeCompare(b.recordId));
    const groupId=uuid(),preview=uuid(),mutation=uuid(),writerActor={staffId,accessSubject:actor.identity.verifiedAccessSubject,
      admissionVersion:actor.admissionVersion,profileVersion:actor.identity.profileVersion,loginEmail:actor.identity.email};
    const proof={members,primaryRecordId:members[0]!.recordId,profile:members[0]!.profile,kind:"organization",differences:[],actor:writerActor};
    await db.batch([
      db.prepare("INSERT INTO native_directory_shared_profile_previews(token,actor_id,proof_json,expires_at) VALUES(?,?,?,?)").bind(preview,staffId,JSON.stringify(proof),actor.verifiedUntil),
      sharedProfileCreationFence(db,{groupId,mutationId:mutation,mode:"pair",requestSha256:"c".repeat(64),actor:writerActor,kind:"organization",profile:members[0]!.profile,members,previewToken:preview}),
      ...sharedProfileCreationStatements(db,groupId,"organization",members[0]!.profile,members,staffId),
    ]);
    currentGeneration="9";
    const proposal=await submission({...business,name:"Reviewed group contact"});
    const selection={kind:"shared_existing",groupId,expectedVersion:1,members:members.map(m=>({recordId:m.recordId,expectedVersion:m.version}))};
    const input={commandId:uuid(),submissionId:proposal.submissionId,fieldsSha256:proposal.fieldsSha256,sourceIds:[selectedSourceId,secondSourceId],organizationSelection:selection};
    const choices=await readClientOnboardingSharedCompanyChoices(db,actor,{submissionId:proposal.submissionId,sourceIds:input.sourceIds,query:"Example",afterGroupId:null});
    expect(choices.companies.find(c=>c.groupId===groupId)).toMatchObject({reviewAvailable:true,expectedVersion:1});
    const beforeRecords=await count("operations_directory_records"),beforeAdmissions=await count("native_directory_create_admissions"),beforeGrants=await count("shared_profile_portal_grants");
    const plan=await prepareClientOnboardingSharedCompanyPlan(db,actor,input,dualConnection);
    expect(plan).toMatchObject({planId:input.commandId,state:"reviewed",approvalAvailable:false,replayed:false,sourceIds:input.sourceIds});
    expect(plan.children).toHaveLength(2);
    for(const child of plan.children){expect(child.sourceIds).toHaveLength(1);expect(child.parentRecordVersion).toBe(1);
      expect(members.find(m=>m.recordId===child.parentRecordId)?.sourceIds).toEqual(child.sourceIds);}
    expect(await count("operations_directory_records")).toBe(beforeRecords);
    expect(await count("native_directory_create_admissions")).toBe(beforeAdmissions);
    expect(await count("shared_profile_portal_grants")).toBe(beforeGrants);
    expect(await db.prepare("SELECT count(*) total FROM client_onboarding_decisions WHERE submission_id=?").bind(proposal.submissionId).first("total")).toBe(0);
    expect(await prepareClientOnboardingSharedCompanyPlan(db,actor,input,dualConnection)).toEqual({...plan,replayed:true});
    await expect(prepareClientOnboardingSharedCompanyPlan(db,actor,{...input,organizationSelection:{...selection,expectedVersion:2}},dualConnection)).rejects.toThrow();
    await expect(prepareClientOnboardingSharedCompanyPlan(db,actor,{...input,sourceIds:[secondSourceId]},dualConnection)).rejects.toThrow();
    await expect(db.prepare("UPDATE client_onboarding_shared_company_plans SET request_sha256=? WHERE plan_id=?").bind("d".repeat(64),plan.planId).run()).rejects.toThrow("immutable");
    await expect(db.prepare("DELETE FROM client_onboarding_shared_company_plan_children WHERE plan_id=?").bind(plan.planId).run()).rejects.toThrow("durable");
    const oldCount=await count("client_onboarding_shared_company_plans"),newId=uuid();
    await expect(db.batch([
      db.prepare(`INSERT INTO client_onboarding_shared_company_plans SELECT ?,submission_id,invitation_id,fields_sha256,request_sha256,
        company_group_id,company_group_version,company_members_json,source_ids_json,scopes_json,client_profile_json,reviewer_staff_id,
        reviewer_subject,reviewer_email,reviewer_admission_version,reviewer_profile_version,verified_until,created_at
        FROM client_onboarding_shared_company_plans WHERE plan_id=?`).bind(newId,plan.planId),
      db.prepare("INSERT INTO client_onboarding_shared_company_plan_seals(plan_id,child_count) VALUES(?,2)").bind(newId),
    ])).rejects.toThrow("not exhausted");
    expect(await count("client_onboarding_shared_company_plans")).toBe(oldCount);
    const primaryOnly=await prepareClientOnboardingSharedCompanyPlan(db,actor,{...input,commandId:uuid(),sourceIds:[selectedSourceId]},dualConnection);
    expect(primaryOnly.children).toHaveLength(1);expect(primaryOnly.children[0]!.sourceIds).toEqual([selectedSourceId]);
    const unknown={...input,commandId:uuid(),sourceIds:["project-alpha:missing"]};
    await expect(prepareClientOnboardingSharedCompanyPlan(db,actor,unknown,dualConnection)).rejects.toThrow();
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active,granted_by)
      VALUES('deny-shared-plan',?,'directory.identity.link','deny','resource',?,1,?)`).bind(staffId,members[0]!.recordId,staffId).run();
    try{await expect(prepareClientOnboardingSharedCompanyPlan(db,actor,{...input,commandId:uuid()},dualConnection)).rejects.toThrow();
      await expect(readClientOnboardingSharedCompanyChoices(db,actor,{submissionId:proposal.submissionId,sourceIds:input.sourceIds,query:"",afterGroupId:null})).rejects.toThrow();
    }finally{await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='deny-shared-plan'").run();}
    const approvalInput={planId:plan.planId,submissionId:proposal.submissionId,fieldsSha256:proposal.fieldsSha256};
    // The last child receipt fails after both writers were staged. The batch
    // must not leave its earlier sibling, admissions, outbox or decision behind.
    await db.prepare(`CREATE TRIGGER test_fail_last_shared_child BEFORE INSERT ON client_onboarding_shared_company_child_receipts
      WHEN NEW.client_record_id=(SELECT max(client_record_id) FROM client_onboarding_shared_company_plan_children WHERE plan_id=NEW.plan_id)
      BEGIN SELECT RAISE(ABORT,'synthetic last child failure'); END`).run();
    const baselineOutbox=await count("project_alpha_directory_outbox");
    await expect(approveClientOnboardingSharedCompany(db,actor,approvalInput,dualConnection)).rejects.toThrow();
    expect(await count("operations_directory_records")).toBe(beforeRecords);
    expect(await count("native_directory_create_admissions")).toBe(beforeAdmissions);
    expect(await count("project_alpha_directory_outbox")).toBe(baselineOutbox);
    expect(await db.prepare("SELECT count(*) total FROM client_onboarding_decisions WHERE submission_id=?").bind(proposal.submissionId).first("total")).toBe(0);
    await db.prepare("DROP TRIGGER test_fail_last_shared_child").run();
    const approved=await approveClientOnboardingSharedCompany(db,actor,approvalInput,dualConnection);
    expect(approved).toMatchObject({decisionId:plan.planId,replayed:false,portalActivation:"pending"});
    expect(approved.members).toHaveLength(2);
    expect(await count("operations_directory_records")).toBe(beforeRecords+2);
    expect(await count("native_directory_create_admissions")).toBe(beforeAdmissions+2);
    expect(await count("project_alpha_directory_outbox")).toBe(baselineOutbox+2);
    for(const parent of members)expect(await db.prepare("SELECT current_version FROM operations_directory_records WHERE record_id=?").bind(parent.recordId).first("current_version")).toBe(1);
    expect(await count("shared_profile_portal_grants")).toBe(beforeGrants);
    expect(await count("client_onboarding_shared_company_execution_fences")).toBe(0);
    expect(await db.prepare("SELECT count(*) total FROM client_onboarding_shared_company_child_receipts WHERE plan_id=?").bind(plan.planId).first("total")).toBe(2);
    expect(await db.prepare("SELECT json_array_length(destinations_json) total FROM client_onboarding_portal_activation_intents WHERE decision_id=?").bind(plan.planId).first("total")).toBe(2);
    expect(await approveClientOnboardingSharedCompany(db,actor,approvalInput,dualConnection)).toEqual({...approved,replayed:true});
    const unrelated=await submission({...business,name:"No decision fence"}),unfencedId=uuid();
    await expect(db.prepare(`INSERT INTO client_onboarding_decisions
      SELECT ?,?, ?,?,request_sha256,outcome,reviewer_staff_id,reviewer_subject,reviewer_email,original_admission_version,
       original_profile_version,reason,reviewed_fields_json,client_record_id,client_record_version,organization_record_id,
       organization_record_version,relationship_version,json_set(receipt_json,'$.decisionId',?,'$.invitationId',?,'$.submissionId',?),decided_at
      FROM client_onboarding_decisions WHERE decision_id=?`).bind(unfencedId,unrelated.invitationId,unrelated.submissionId,unrelated.fieldsSha256,
       unfencedId,unrelated.invitationId,unrelated.submissionId,plan.planId).run()).rejects.toThrow("artifacts are incomplete");
  },120_000);

});
