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
const uuid = () => `70000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;

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
  });

  it("rejects stale review fingerprints, existing targets, and business/organization proposals without writes", async () => {
    const stale = await submission();
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, stale.submissionId, "f".repeat(64)))
      .rejects.toThrow("client_onboarding_approval_denied");
    expect(approvedClientRecordId).not.toBe("");
    const existing = await submission(consumer, approvedClientRecordId);
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, existing.submissionId, existing.fieldsSha256))
      .rejects.toThrow("client_onboarding_approval_denied");
    const business = await submission({ ...consumer, clientType: "business", organizationName: "Example LLC" });
    await expect(approveNewNativeOnlyClientOnboarding(db, actor, business.submissionId, business.fieldsSha256))
      .rejects.toThrow("client_onboarding_approval_denied");
    for (const item of [stale, existing, business])
      expect(await db.prepare("SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?")
        .bind(item.submissionId).first()).toBeNull();
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
    const item = await submission(consumer, null, [
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
});
