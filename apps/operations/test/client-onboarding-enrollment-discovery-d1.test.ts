import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readClientOnboardingEnrollmentChoices } from "../src/worker/client-onboarding-enrollment-discovery";

let runtime: Miniflare;
let database: D1Database;
let sequence = 0;

const authenticated = {
  identity: { kind: "native" as const, staffId: "staff:onboarding", verifiedAccessSubject: "access|staff:onboarding",
    email: "staff@example.test", displayName: "Onboarding staff", profileVersion: 1 },
  admissionVersion: 1,
  verifiedUntil: "2099-01-01T00:00:00.000Z",
};
const connections = JSON.stringify({ version: 1, instances: {
  "project-alpha:primary": { sourceId: "project-alpha:primary", enabled: true, baseUrl: "https://primary.example.test",
    apiKey: "primary-key", sourceInstanceId: "11111111-1111-4111-8111-111111111111",
    applicationId: "22222222-2222-4222-8222-222222222222", historyEpoch: "33333333-3333-4333-8333-333333333333" },
  "project-alpha:secondary": { sourceId: "project-alpha:secondary", enabled: true, baseUrl: "https://secondary.example.test",
    apiKey: "secondary-key", sourceInstanceId: "44444444-4444-4444-8444-444444444444",
    applicationId: "55555555-5555-4555-8555-555555555555", historyEpoch: "66666666-6666-4666-8666-666666666666" },
  "project-alpha:disabled": { sourceId: "project-alpha:disabled", enabled: false, baseUrl: "https://disabled.example.test",
    apiKey: "disabled-key", sourceInstanceId: "77777777-7777-4777-8777-777777777777",
    applicationId: "88888888-8888-4888-8888-888888888888", historyEpoch: "99999999-9999-4999-8999-999999999999" },
} });
function enabledConnections(count: number): string {
  return JSON.stringify({ version: 1, instances: Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(12, "0");
    return [`project-alpha:source${index + 1}`, {
      sourceId: `project-alpha:source${index + 1}`, enabled: true,
      baseUrl: `https://source${index + 1}.example.test`, apiKey: `key-${index + 1}`,
      sourceInstanceId: `10000000-0000-4000-8000-${suffix}`,
      applicationId: `20000000-0000-4000-8000-${suffix}`,
      historyEpoch: `30000000-0000-4000-8000-${suffix}`,
    }];
  })) });
}

async function grant(id: string, permission: string, effect: "allow" | "deny", scope: "global" | "division" | "resource",
  businessAreaId: string | null = null, divisionId: string | null = null, resourceId: string | null = null) {
  await database.prepare(`INSERT INTO native_directory_grants
    (id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,granted_by)
    VALUES(?,?,?,?,?,?,?,?,1,'staff:onboarding')`).bind(id, "staff:onboarding", permission, effect, scope,
    businessAreaId, divisionId, resourceId).run();
}

const uuid = () => `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
async function submitted(targetClientRecordId: string | null,
  scopes: readonly { businessAreaId: string; divisionId: string | null }[]): Promise<string> {
  const invitationId = uuid(), commandId = uuid(), submissionId = uuid();
  await database.prepare(`INSERT INTO client_onboarding_invitations
    (invitation_id,secret_sha256,issued_by,bound_access_subject,expires_at,target_client_record_id,state,version)
    VALUES(?,?,?,?,?,?, 'pending',1)`).bind(invitationId, "a".repeat(64), "staff:onboarding",
      authenticated.identity.verifiedAccessSubject, authenticated.verifiedUntil, targetClientRecordId).run();
  await database.prepare(`INSERT INTO client_onboarding_issuance_commands
    (invitation_id,command_id,request_sha256,scopes_json,issuer_admission_version,
      issuer_profile_version,issuer_email,verified_until) VALUES(?,?,?,?,1,1,?,?)`)
    .bind(invitationId, commandId, "b".repeat(64), targetClientRecordId === null
      ? JSON.stringify(scopes) : null, authenticated.identity.email, authenticated.verifiedUntil).run();
  await database.prepare(`INSERT INTO client_onboarding_submissions
    (invitation_id,submission_id,fields_json,fields_sha256) VALUES(?,?,?,?)`)
    .bind(invitationId, submissionId, JSON.stringify({ name: "Client" }), "c".repeat(64)).run();
  return submissionId;
}

beforeEach(async () => {
  sequence = 0;
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter(item => /^\d{4}_.+\.sql$/.test(item)
    && item.slice(0, 4) <= "0080").sort()) {
    await database.batch(splitD1MigrationStatements(readFileSync(new URL(name, migrations), "utf8"))
      .map(statement => database.prepare(statement)));
    if (name.startsWith("0057_")) await database.batch([
      database.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version)
        VALUES('client:exact','client',1)`),
      database.prepare("INSERT INTO native_business_areas(id,name) VALUES('area:north','North'),('area:south','South')"),
      database.prepare("INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('division:north','area:north','North division')"),
      database.prepare(`INSERT INTO native_directory_resource_scopes
        (record_id,scope_kind,business_area_id,division_id) VALUES('client:exact','division','area:north','division:north')`),
      database.prepare(`INSERT INTO native_directory_resource_scopes
        (record_id,scope_kind,business_area_id,division_id) VALUES('client:exact','business_area','area:south',NULL)`),
    ]);
  }
  await database.batch([
    database.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject)
      VALUES('staff:onboarding','staff@example.test','Onboarding staff','access|staff:onboarding')`),
    database.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('staff:onboarding','access|staff:onboarding',1,'staff:onboarding')`),
    database.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('staff:onboarding','staff@example.test','Onboarding staff')`),
  ]);
  await grant("profile-view", "directory.profile.view", "allow", "global");
  await grant("profile-edit", "directory.profile.edit", "allow", "global");
  await grant("enrollment-manage", "directory.enrollment.manage", "allow", "global");
});
afterEach(async () => runtime.dispose());

describe("client onboarding enrollment choice discovery", () => {
  it("returns only enabled, server-owned source IDs for every authorized issuance scope without writes", async () => {
    const submissionId = await submitted(null, [
      { businessAreaId: "area:south", divisionId: null },
      { businessAreaId: "area:north", divisionId: "division:north" },
    ]);
    const before = await database.prepare("SELECT count(*) total FROM native_directory_grants").first<number>("total");
    const result = await readClientOnboardingEnrollmentChoices(database,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, authenticated, { submissionId });
    expect(result).toEqual({ sourceIds: ["project-alpha:primary", "project-alpha:secondary"] });
    expect(await database.prepare("SELECT count(*) total FROM native_directory_grants").first<number>("total")).toBe(before);
  });

  it("uses the current record scopes and fails closed when a deny applies to either permission", async () => {
    const submissionId = await submitted("client:exact", []);
    await expect(readClientOnboardingEnrollmentChoices(database,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, authenticated,
      { submissionId })).resolves.toEqual({
      sourceIds: ["project-alpha:primary", "project-alpha:secondary"],
    });
    await grant("deny-north", "directory.enrollment.manage", "deny", "division", null, "division:north");
    await expect(readClientOnboardingEnrollmentChoices(database,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, authenticated,
      { submissionId })).rejects.toThrow("client_onboarding_enrollment_discovery_denied");
  });

  it("requires both permissions for every proposed scope and rejects malformed deployment configuration", async () => {
    const submissionId = await submitted(null, [{ businessAreaId: "area:north", divisionId: "division:north" }]);
    await database.prepare("UPDATE native_directory_grants SET active=0 WHERE id='profile-view'").run();
    await expect(readClientOnboardingEnrollmentChoices(database,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, authenticated,
      { submissionId }))
      .rejects.toThrow("client_onboarding_enrollment_discovery_denied");
    await database.prepare("UPDATE native_directory_grants SET active=1 WHERE id='profile-view'").run();
    await expect(readClientOnboardingEnrollmentChoices(database,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: "{}" }, authenticated,
      { submissionId }))
      .rejects.toThrow("client_onboarding_enrollment_discovery_unavailable");
    await expect(readClientOnboardingEnrollmentChoices(database,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: enabledConnections(17) }, authenticated, { submissionId }))
      .rejects.toThrow("client_onboarding_enrollment_discovery_unavailable");
    await database.prepare("UPDATE native_staff_profiles SET version=version+1 WHERE staff_id='staff:onboarding'").run();
    await expect(readClientOnboardingEnrollmentChoices(database,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, authenticated, { submissionId }))
      .rejects.toThrow("client_onboarding_enrollment_discovery_denied");
  });
});
