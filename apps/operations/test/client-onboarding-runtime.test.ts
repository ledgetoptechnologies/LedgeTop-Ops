import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { parseClientOnboardingFields } from "@ltds/shared";
import { issueClientOnboardingWithHandoff, revealClientOnboardingSecret } from
  "../src/worker/client-onboarding-handoff";
import { submitClientOnboarding } from "../src/worker/client-onboarding-submissions";
import { consumeClientOnboardingRateLimit } from "../src/worker/client-onboarding-rate-limit";

let runtime: Miniflare | undefined;
let db: D1Database;
let serial = 0;
const uuid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, "0")}`;
const expiresAt = "2099-01-01T00:00:00.000Z";
const actor = { identity: { kind: "native" as const, staffId: "client-onboarding-issuer",
  verifiedAccessSubject: "access|client-onboarding-issuer", email: "issuer@example.test",
  displayName: "Client Onboarding Issuer", profileVersion: 1 }, verifiedUntil: expiresAt };
const keyring = { activeKeyId: "current", keys: { current: "ab".repeat(32) } };
const fields = { clientType: "consumer", name: " Example Person ", email: "PERSON@EXAMPLE.TEST",
  phone: "555-0100", organizationName: "stale", organizationEmail: "stale@example.test",
  organizationPhone: "stale", addressLine1: "1 Main St", addressLine2: "", city: "Example",
  state: "Illinois", postalCode: "60601", country: "US" };

describe("bounded client profile onboarding runtime", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(item => /^\d{4}_.+\.sql$/.test(item)
      && item.slice(0, 4) <= "0080").sort()) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"))
        .map(statement => db.prepare(statement)));
    }
    await db.prepare(`INSERT INTO staff_users(id,email,display_name)
      VALUES('client-onboarding-issuer','issuer@example.test','Client Onboarding Issuer')`).run();
    await db.batch([
      db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
        VALUES('client-onboarding-issuer','access|client-onboarding-issuer',1,'client-onboarding-issuer')`),
      db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
        VALUES('client-onboarding-issuer','issuer@example.test','Client Onboarding Issuer')`),
      db.prepare("INSERT INTO native_business_areas(id,name) VALUES('area:onboarding','Onboarding')"),
      db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
        VALUES('client-onboarding-edit','client-onboarding-issuer','directory.profile.edit','allow',
          'business_area','area:onboarding','client-onboarding-issuer')`),
    ]);
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("strictly snapshots the shared PA-compatible field set", () => {
    const parsed = parseClientOnboardingFields(fields);
    expect(parsed).toMatchObject({ name: "Example Person", email: "person@example.test",
      organizationName: "", organizationEmail: "", organizationPhone: "" });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseClientOnboardingFields({ ...fields, portalMembership: "forged" }))
      .toThrow("client_onboarding_fields_invalid");
  });

  it("atomically issues, encrypts, reveals with audit, and accepts one exact submission", async () => {
    const directoryBefore = await db.prepare("SELECT count(*) n FROM operations_directory_records").first("n");
    const entitlementsBefore = await db.prepare("SELECT count(*) n FROM pa_application_entitlements").first("n");
    const commandId = uuid();
    const request = { authenticatedNativeStaff: actor, request: { commandId, expiresAt,
      targetClientRecordId: null, scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] } };
    const receipt = await issueClientOnboardingWithHandoff(db, request, keyring);
    expect(receipt).toMatchObject({ state: "pending", expiresAt });
    expect(await issueClientOnboardingWithHandoff(db, request, keyring)).toEqual(receipt);
    const revelation = await revealClientOnboardingSecret(db,
      { authenticatedNativeStaff: actor, commandId }, keyring);
    expect(revelation.invitationSecret).toMatch(/^[0-9a-f]{64}$/);
    const stored = await db.prepare("SELECT * FROM client_onboarding_handoffs WHERE command_id=?")
      .bind(commandId).first();
    expect(JSON.stringify(stored)).not.toContain(revelation.invitationSecret);
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_reveal_audit WHERE command_id=?")
      .bind(commandId).first("n")).toBe(1);
    const submission = { invitationId: receipt.invitationId, invitationSecret: revelation.invitationSecret,
      submissionId: uuid(), fields };
    const submitted = await submitClientOnboarding(db, submission);
    expect(submitted.state).toBe("submitted");
    expect(await submitClientOnboarding(db, submission)).toEqual(submitted);
    await expect(submitClientOnboarding(db, { ...submission, invitationSecret: "00".repeat(32) }))
      .rejects.toThrow("client_onboarding_submission_denied");
    await expect(submitClientOnboarding(db, { ...submission, submissionId: uuid() }))
      .rejects.toThrow("client_onboarding_submission_denied");
    await expect(revealClientOnboardingSecret(db, { authenticatedNativeStaff: actor, commandId }, keyring))
      .rejects.toThrow("client_onboarding_handoff_reveal_denied");
    expect(await db.prepare("SELECT state FROM client_onboarding_invitations WHERE invitation_id=?")
      .bind(receipt.invitationId).first("state")).toBe("submitted");
    expect(await db.prepare("SELECT count(*) n FROM operations_directory_records").first("n")).toBe(directoryBefore);
    expect(await db.prepare("SELECT count(*) n FROM pa_application_entitlements").first("n")).toBe(entitlementsBefore);
  });

  it("enforces current issuer authority and a separate atomic public quota", async () => {
    const rateKey = `client-onboarding:ip:${"1".padStart(64, "0")}`;
    const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
      consumeClientOnboardingRateLimit(db, rateKey, 2, 60)));
    expect(outcomes.filter(Boolean)).toHaveLength(2);
    await expect(consumeClientOnboardingRateLimit(db, "192.0.2.1", 2, 60))
      .rejects.toThrow("client_onboarding_rate_limit_unavailable");
    await expect(issueClientOnboardingWithHandoff(db, { authenticatedNativeStaff: actor,
      request: { commandId: uuid(), expiresAt: "2020-01-01T00:00:00.000Z", targetClientRecordId: null,
        scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] } }, keyring))
      .rejects.toThrow("client_onboarding_handoff_issue_denied");
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='client-onboarding-edit'").run();
    await expect(issueClientOnboardingWithHandoff(db, { authenticatedNativeStaff: actor,
      request: { commandId: uuid(), expiresAt, targetClientRecordId: null,
        scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] } }, keyring))
      .rejects.toThrow("client_onboarding_handoff_issue_denied");
  });
});
