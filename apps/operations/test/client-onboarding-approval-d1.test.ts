import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { approveNewNativeOnlyClientOnboarding } from "../src/worker/client-onboarding-approval";

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
      && item.slice(0, 4) <= "0140").sort())
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
    ]);
  }, 240_000);
  afterAll(async () => runtime?.dispose());

  it("creates exactly one unlinked native client, replays deterministically, and reserves no PA work", async () => {
    const item = await submission(), beforeOutbox = await count("project_alpha_directory_outbox");
    const first = await approveNewNativeOnlyClientOnboarding(db, actor, item.submissionId, item.fieldsSha256);
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
});
