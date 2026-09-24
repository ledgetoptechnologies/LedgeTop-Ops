import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readClientOnboardingSubmissionForReview } from "../src/worker/client-onboarding-review";

let runtime: Miniflare | undefined;
let db: D1Database;
let sequence = 0;
const staffId = "onboarding-reviewer";
const existingRecordId = "20000000-0000-4000-8000-000000000001";
const actor = { identity: { kind: "native" as const, staffId,
  verifiedAccessSubject: "access|onboarding-reviewer", email: "reviewer@example.test",
  displayName: "Onboarding Reviewer", profileVersion: 1 }, admissionVersion: 1,
verifiedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
const fields = Object.freeze({ clientType: "consumer", name: "Client", email: "client@example.test",
  phone: "", organizationName: "", organizationEmail: "", organizationPhone: "",
  addressLine1: "1 Main", addressLine2: "", city: "Town", state: "TX",
  postalCode: "75001", country: "US" });
const uuid = () => `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;

async function grant(id: string, effect: "allow" | "deny", scopeKind: string,
  scope: { businessAreaId?: string; divisionId?: string; resourceId?: string } = {}) {
  await db.prepare(`INSERT INTO native_directory_grants
    (id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,granted_by)
    VALUES(?,?,'directory.profile.edit',?,?,?,?,?,?)`).bind(id, staffId, effect, scopeKind,
      scope.businessAreaId ?? null, scope.divisionId ?? null, scope.resourceId ?? null, staffId).run();
}

async function submission(targetClientRecordId: string | null,
  scopes: readonly { businessAreaId: string; divisionId: string | null }[]) {
  const invitationId = uuid(), commandId = uuid(), submissionId = uuid();
  await db.prepare(`INSERT INTO client_onboarding_invitations
    (invitation_id,secret_sha256,issued_by,bound_access_subject,expires_at,target_client_record_id,state,version)
    VALUES(?, ?, ?, ?, ?, ?, 'pending', 1)`).bind(invitationId, "a".repeat(64), staffId,
      actor.identity.verifiedAccessSubject, actor.verifiedUntil, targetClientRecordId).run();
  await db.prepare(`INSERT INTO client_onboarding_issuance_commands
    (invitation_id,command_id,request_sha256,scopes_json,issuer_admission_version,
      issuer_profile_version,issuer_email,verified_until) VALUES(?,?,?,?,1,1,?,?)`)
    .bind(invitationId, commandId, "b".repeat(64), targetClientRecordId === null
      ? JSON.stringify(scopes) : null, actor.identity.email, actor.verifiedUntil).run();
  await db.prepare(`INSERT INTO client_onboarding_submissions
    (invitation_id,submission_id,fields_json,fields_sha256) VALUES(?,?,?,?)`)
    .bind(invitationId, submissionId, JSON.stringify(fields), "c".repeat(64)).run();
  return submissionId;
}

async function denied(submissionId: string) {
  await expect(readClientOnboardingSubmissionForReview(db, actor, submissionId))
    .rejects.toThrow("client_onboarding_review_denied");
}

describe("client onboarding review against migrated D1", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(item => /^\d{4}_.+\.sql$/.test(item)
      && item.slice(0, 4) <= "0080").sort()) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"))
        .map(statement => db.prepare(statement)));
      if (name.startsWith("0057_")) await db.batch([
        db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(existingRecordId),
        db.prepare("INSERT INTO native_business_areas(id,name) VALUES('area:a','Area A')"),
        db.prepare("INSERT INTO native_business_areas(id,name) VALUES('area:b','Area B')"),
        db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('division:a','area:a','Division A')"),
        db.prepare(`INSERT INTO native_directory_resource_scopes
          (record_id,scope_kind,business_area_id,division_id) VALUES(?,'division','area:a','division:a')`).bind(existingRecordId),
      ]);
    }
    await db.batch([
      db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject)
        VALUES(?,?,?,?)`).bind(staffId, actor.identity.email, actor.identity.displayName,
          actor.identity.verifiedAccessSubject),
      db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
        VALUES(?,?,1,?)`).bind(staffId, actor.identity.verifiedAccessSubject, staffId),
      db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
        VALUES(?,?,?)`).bind(staffId, actor.identity.email, actor.identity.displayName),
    ]);
    await grant("bootstrap", "allow", "global");
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("requires allow coverage over every proposed scope and applies deny precedence", async () => {
    const id = await submission(null, [
      { businessAreaId: "area:a", divisionId: "division:a" },
      { businessAreaId: "area:b", divisionId: null },
    ]);
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='bootstrap'").run();
    await grant("allow-a", "allow", "business_area", { businessAreaId: "area:a" });
    await denied(id);
    await grant("allow-b", "allow", "business_area", { businessAreaId: "area:b" });
    await expect(readClientOnboardingSubmissionForReview(db, actor, id)).resolves
      .toMatchObject({ submissionId: id, scopes: [
        { businessAreaId: "area:a", divisionId: "division:a" },
        { businessAreaId: "area:b", divisionId: null },
      ] });
    await grant("deny-a-division", "deny", "division", { divisionId: "division:a" });
    await denied(id);
  });

  it("supports resource and assigned authority for existing targets and fails on matching denies", async () => {
    const resourceId = existingRecordId;
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id IN ('allow-a','allow-b','deny-a-division')").run();
    await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='bootstrap'").run();
    const id = await submission(resourceId, []);
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='bootstrap'").run();
    await grant("allow-resource", "allow", "resource", { resourceId });
    await expect(readClientOnboardingSubmissionForReview(db, actor, id)).resolves
      .toMatchObject({ submissionId: id, targetClientRecordId: resourceId });
    await grant("deny-resource", "deny", "resource", { resourceId });
    await denied(id);
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id IN ('allow-resource','deny-resource')").run();
    await db.prepare(`INSERT INTO native_directory_assignments(record_id,staff_id,assigned_by)
      VALUES(?,?,?)`).bind(resourceId, staffId, staffId).run();
    await grant("allow-assigned", "allow", "assigned");
    await expect(readClientOnboardingSubmissionForReview(db, actor, id)).resolves
      .toMatchObject({ submissionId: id });
    await grant("deny-assigned", "deny", "assigned");
    await denied(id);
  });
});
