import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { clientOnboardingRecipientRouter } from "../../client/src/worker/client-onboarding-recipient";
import { issueClientOnboardingWithHandoff, revealClientOnboardingSecret } from
  "../src/worker/client-onboarding-handoff";
import { ClientOnboardingRecipientBridge } from "../src/worker/client-onboarding-recipient-entrypoint";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const origin = "https://portal.example.test";
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const actor = { identity: { kind: "native" as const, staffId: "recipient-e2e-issuer",
  verifiedAccessSubject: "access|recipient-e2e-issuer", email: "issuer@example.test",
  displayName: "Recipient E2E Issuer", profileVersion: 1 }, verifiedUntil: expiresAt };
const keyring = { activeKeyId: "current", keys: { current: "ab".repeat(32) } };
const fields = { clientType: "consumer", name: "Acceptance Recipient", email: "recipient@example.test",
  phone: "555-0100", organizationName: "", organizationEmail: "", organizationPhone: "",
  addressLine1: "1 Main St", addressLine2: "", city: "Example", state: "IL",
  postalCode: "60601", country: "US" };

let runtime: Miniflare | undefined;
let database: D1Database;

function post(path: string, value: Record<string, unknown>, bridge: ClientOnboardingRecipientBridge) {
  return clientOnboardingRecipientRouter.request(`${origin}${path}`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
    body: JSON.stringify(value) }, { CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true",
    CLIENT_ONBOARDING_RECIPIENT_BRIDGE: bridge,
    PUBLIC_SESSION_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) } } as never);
}

describe("local recipient invitation acceptance", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    database = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(item => /^\d{4}_.+\.sql$/.test(item)
      && (item.slice(0, 4) <= "0080" || item.startsWith("0140_"))).sort()) {
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"))
        .map(statement => database.prepare(statement)));
    }
    await database.prepare(`INSERT INTO staff_users(id,email,display_name)
      VALUES('recipient-e2e-issuer','issuer@example.test','Recipient E2E Issuer')`).run();
    await database.batch([
      database.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
        VALUES('recipient-e2e-issuer','access|recipient-e2e-issuer',1,'recipient-e2e-issuer')`),
      database.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
        VALUES('recipient-e2e-issuer','issuer@example.test','Recipient E2E Issuer')`),
      database.prepare("INSERT INTO native_business_areas(id,name) VALUES('area:recipient-e2e','Recipient E2E')"),
      database.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
        VALUES('recipient-e2e-edit','recipient-e2e-issuer','directory.profile.edit','allow',
          'business_area','area:recipient-e2e','recipient-e2e-issuer')`),
    ]);
  }, 120_000);

  afterAll(async () => runtime?.dispose());

  it("recovers a lost submit response with the same submission and rejects non-exact retries", async () => {
    const commandId = "00000000-0000-4000-8000-000000000101";
    const submissionId = "00000000-0000-4000-8000-000000000102";
    const receipt = await issueClientOnboardingWithHandoff(database, { authenticatedNativeStaff: actor,
      request: { commandId, expiresAt, targetClientRecordId: null,
        scopes: [{ businessAreaId: "area:recipient-e2e", divisionId: null }] } }, keyring);
    const { invitationSecret } = await revealClientOnboardingSecret(database,
      { authenticatedNativeStaff: actor, commandId }, keyring);
    const bridge = Object.assign(Object.create(ClientOnboardingRecipientBridge.prototype), { env: {
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true", OPS_DB: database,
    } }) as ClientOnboardingRecipientBridge;
    const base = `/${receipt.invitationId}`;

    const session = await post(`${base}/session`, { invitationSecret }, bridge);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ ok: true, state: "pending" });

    // The server commits, but the client never observes this response.
    await post(`${base}/submit`, { invitationSecret, submissionId, fields }, bridge);
    const recovered = await post(`${base}/submit`, { invitationSecret, submissionId, fields }, bridge);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ ok: true, state: "submitted", submissionId });

    const status = await post(`${base}/status`, { invitationSecret, submissionId }, bridge);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ ok: true, state: "submitted", submissionId });
    expect(await database.prepare("SELECT count(*) n FROM client_onboarding_submissions WHERE invitation_id=?")
      .bind(receipt.invitationId).first("n")).toBe(1);

    const altered = await post(`${base}/submit`, { invitationSecret, submissionId,
      fields: { ...fields, name: "Altered Recipient" } }, bridge);
    expect(altered.status).toBe(404);
    const wrongStatus = await post(`${base}/status`, { invitationSecret,
      submissionId: "00000000-0000-4000-8000-000000000103" }, bridge);
    expect(wrongStatus.status).toBe(404);
    const wrongSecret = await post(`${base}/status`, { invitationSecret: "00".repeat(32), submissionId }, bridge);
    expect(wrongSecret.status).toBe(404);
  });
});
