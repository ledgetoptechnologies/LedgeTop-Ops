import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { createNativeStaffOnboarding, revealNativeStaffOnboarding, snapshotNativeStaffHandoffKeyring } from "../src/worker/native-staff-onboarding-create";
import { handleOperationsNativeStaffLifecycleHttp } from "../src/worker/operations-native-staff-lifecycle-http";

let runtime: Miniflare, db: D1Database;
let sequence = 0;
const uuid = () => `30000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const keyring = { activeKeyId: "test-key", keys: { "test-key": "a".repeat(64) } };

async function creator() {
  const id = `onboarding-creator-${++sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(id, email, id, subject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, id),
    ...["staff.onboarding.create", "staff.onboarding.approve", "staff.admission.disable", "staff.membership.manage",
      "staff.directory_grant.manage", "staff.admin_delegation.manage", "staff.profile.read", "staff.profile.edit",
      "staff.admission.enable"].map(capability => db.prepare(`INSERT INTO native_staff_management_delegations
        (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`)
        .bind(`${id}:${capability}`, id, capability, id)),
  ]);
  return { id, email, subject };
}

describe("Operations native pending staff invitation create/reveal", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= "0076").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
  }, 90_000);
  afterAll(async () => runtime?.dispose());

  it("creates a pending invitation atomically, retries without issuing a second secret, and audits explicit reveal", async () => {
    const person = await creator();
    const authenticated = { identity: { kind: "native", staffId: person.id, verifiedAccessSubject: person.subject,
      email: person.email, displayName: person.id, profileVersion: 1 }, admissionVersion: 1,
      verifiedUntil: new Date(Date.now() + 600_000).toISOString() };
    const input = { commandId: uuid(), loginEmail: `invite-${++sequence}@example.test`, displayName: "Synthetic Invite",
      expiresAt: new Date(Date.now() + 600_000).toISOString(), reason: "Synthetic pending invitation contract test" };
    const created = await createNativeStaffOnboarding(db, input, authenticated, keyring);
    expect(created).toMatchObject({ commandId: input.commandId, resultVersion: 1, replayed: false });
    expect(await createNativeStaffOnboarding(db, input, authenticated, keyring)).toEqual({ ...created, replayed: true });
    expect(await db.prepare("SELECT state,version,created_by_staff_id FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(created.onboardingId).first()).toEqual({ state: "pending", version: 1, created_by_staff_id: person.id });
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?").bind(created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_profiles WHERE staff_id=?").bind(created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_admissions WHERE staff_id=?").bind(created.proposedStaffId).first("n")).toBe(0);
    const stored = await db.prepare("SELECT invitation_secret_sha256 FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(created.onboardingId).first<string>("invitation_secret_sha256");
    const handoff = await db.prepare("SELECT ciphertext_hex,secret_sha256 FROM native_staff_onboarding_handoffs WHERE command_id=?")
      .bind(input.commandId).first<{ ciphertext_hex: string; secret_sha256: string }>();
    expect(stored).toMatch(/^[0-9a-f]{64}$/u);
    expect(handoff).toMatchObject({ secret_sha256: stored });
    expect(handoff?.ciphertext_hex).toMatch(/^[0-9a-f]{160}$/u);
    expect(JSON.parse(await db.prepare("SELECT result_json FROM native_staff_management_commands WHERE command_id=?")
      .bind(input.commandId).first<string>("result_json") ?? "null").proposal).toEqual({ memberships: [], directoryGrants: [], managementGrants: [] });

    const revealed = await revealNativeStaffOnboarding(db, input.commandId, authenticated, keyring);
    expect(revealed).toMatchObject({ commandId: input.commandId, onboardingId: created.onboardingId,
      proposedStaffId: created.proposedStaffId, expiresAt: input.expiresAt });
    expect(revealed.invitationSecret).toMatch(/^[0-9a-f]{64}$/u);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_onboarding_reveal_audit WHERE command_id=?")
      .bind(input.commandId).first("n")).toBe(1);

    await db.prepare("UPDATE native_staff_management_delegations SET active=0,version=version+1 WHERE actor_staff_id=? AND capability='staff.onboarding.create'")
      .bind(person.id).run();
    await expect(revealNativeStaffOnboarding(db, input.commandId, authenticated, keyring))
      .rejects.toThrow("native_staff_onboarding_create_denied");
  });

  it("rejects extra browser fields and malformed keyrings before writing", async () => {
    const before = await db.prepare("SELECT count(*) n FROM native_staff_pending_onboarding").first<number>("n");
    const person = await creator();
    const authenticated = { identity: { kind: "native", staffId: person.id, verifiedAccessSubject: person.subject,
      email: person.email, displayName: person.id, profileVersion: 1 }, admissionVersion: 1,
      verifiedUntil: new Date(Date.now() + 600_000).toISOString() };
    const input = { commandId: uuid(), loginEmail: `invalid-${++sequence}@example.test`, displayName: "Synthetic Invite",
      expiresAt: new Date(Date.now() + 600_000).toISOString(), reason: "Synthetic strict-input test", proposedStaffId: "attacker-picked" };
    await expect(createNativeStaffOnboarding(db, input, authenticated, keyring)).rejects.toThrow("native_staff_onboarding_create_denied");
    expect(() => snapshotNativeStaffHandoffKeyring({ activeKeyId: "missing", keys: {} }))
      .toThrow("native_staff_handoff_keyring_unavailable");
    await expect(createNativeStaffOnboarding(db, input, authenticated, { activeKeyId: "missing", keys: {} }))
      .rejects.toThrow("native_staff_onboarding_create_denied");
    expect(await db.prepare("SELECT count(*) n FROM native_staff_pending_onboarding").first("n")).toBe(before);
  });

  it("keeps invitation creation unreachable while the dedicated feature flag is unset", async () => {
    const before = await db.prepare("SELECT count(*) n FROM native_staff_pending_onboarding").first<number>("n");
    const response = await handleOperationsNativeStaffLifecycleHttp(new Request("https://ops.example.test/api/native-staff/onboarding/create", {
      method: "POST", headers: { "Origin": "https://ops.example.test", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: "{}",
    }), { enabledFlag: "true", onboardingEnabledFlag: "false", expectedHost: "ops.example.test", database: db,
      configuration: { enabled: true, issuer: "https://synthetic-staff.cloudflareaccess.com", staffAudience: "synthetic-staff-audience",
        origin: "https://ops.example.test", csrfSecret: "synthetic-csrf-secret-only-for-local-fixtures-123" } });
    expect(response.status).toBe(404);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_pending_onboarding").first("n")).toBe(before);
  });
});
