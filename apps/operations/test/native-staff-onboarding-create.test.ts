import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { createNativeStaffOnboarding, revealNativeStaffOnboarding, snapshotNativeStaffHandoffKeyring } from "../src/worker/native-staff-onboarding-create";
import { handleOperationsNativeStaffLifecycleHttp } from "../src/worker/operations-native-staff-lifecycle-http";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import type { OperationsNativeStaffLifecycleHttpDependencies } from "../src/worker/operations-native-staff-lifecycle-http";

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
    ...["staff.onboarding.create", "staff.onboarding.cancel", "staff.onboarding.approve", "staff.admission.disable", "staff.membership.manage",
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
    // The joined HTTP route also checks 0225's readiness row. Keep this narrow
    // local fixture table instead of applying the unrelated 0225+ schema chain.
    await db.prepare("CREATE TABLE native_staff_access_reconciliation(singleton INTEGER PRIMARY KEY, enabled INTEGER NOT NULL)").run();
    await db.prepare("INSERT INTO native_staff_access_reconciliation(singleton,enabled) VALUES(1,0)").run();
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

  it("reconciles an exact create after its deadline without renewing or duplicating it", async () => {
    const person = await creator(), baseline = Date.now();
    const authenticated = { identity: { kind: "native", staffId: person.id, verifiedAccessSubject: person.subject,
      email: person.email, displayName: person.id, profileVersion: 1 }, admissionVersion: 1,
      verifiedUntil: new Date(baseline + 600_000).toISOString() } as AuthenticatedNativeStaffWithAdmissionVersion;
    const input = { commandId: crypto.randomUUID(), loginEmail: `expiry-${++sequence}@example.test`,
      displayName: "Expiry reconciliation", expiresAt: new Date(baseline + 120_000).toISOString(), reason: "Lost create acknowledgment" };
    const created = await createNativeStaffOnboarding(db, input, authenticated, keyring);
    const clock = vi.spyOn(Date, "now");
    try {
      for (const at of [baseline + 100_000, baseline + 121_000]) {
        clock.mockReturnValue(at);
        expect(await createNativeStaffOnboarding(db, input, authenticated, keyring)).toEqual({ ...created, replayed: true });
        await expect(createNativeStaffOnboarding(db, { ...input, commandId: crypto.randomUUID() }, authenticated, keyring))
          .rejects.toThrow("native_staff_onboarding_create_denied");
      }
      expect(await db.prepare("SELECT count(*) n FROM native_staff_pending_onboarding WHERE onboarding_id=?").bind(created.onboardingId).first("n")).toBe(1);
      expect(await db.prepare("SELECT expires_at FROM native_staff_pending_onboarding WHERE onboarding_id=?").bind(created.onboardingId).first("expires_at")).toBe(input.expiresAt);
      expect(await db.prepare("SELECT count(*) n FROM native_staff_onboarding_handoffs WHERE command_id=?").bind(input.commandId).first("n")).toBe(1);
    } finally { clock.mockRestore(); }
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

  it("cancels through the gated route, then replays create with authoritative state", async () => {
    const person = await creator();
    const authenticated = { identity: { kind: "native", staffId: person.id, verifiedAccessSubject: person.subject,
      email: person.email, displayName: person.id, profileVersion: 1 }, admissionVersion: 1,
      verifiedUntil: new Date(Date.now() + 600_000).toISOString() } as AuthenticatedNativeStaffWithAdmissionVersion;
    const commandId = uuid(), input = { commandId, loginEmail: `cancelled-${++sequence}@example.test`,
      displayName: "Synthetic Cancelled Invite", expiresAt: new Date(Date.now() + 600_000).toISOString(),
      reason: "Synthetic create cancel replay" };
    const priorEnabled = await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first<number>("enabled");
    await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1").run();
    try {
      const deps: OperationsNativeStaffLifecycleHttpDependencies = {
        enabledFlag: "true", onboardingEnabledFlag: "true", onboardingCancelEnabledFlag: "true",
        environment: "staging", expectedHost: "ops.example.test", database: db,
        handoffKeyringJson: JSON.stringify(keyring), configuration: { enabled: true,
          issuer: "https://synthetic-staff.cloudflareaccess.com", staffAudience: "synthetic-staff-audience",
          origin: "https://ops.example.test", csrfSecret: "synthetic-csrf-secret-only-for-local-fixtures-123" },
        authenticate: async () => authenticated,
      };
      const root = "https://ops.example.test/api/native-staff";
      const session = await handleOperationsNativeStaffLifecycleHttp(new Request(`${root}/session`, { method: "GET",
        headers: { "Sec-Fetch-Site": "same-origin", "X-Native-Staff-Request": "1" } }), deps);
      expect(session.status).toBe(200);
      const { csrfToken } = await session.json() as { csrfToken: string };
      const create = () => handleOperationsNativeStaffLifecycleHttp(new Request(`${root}/onboarding/create`, {
        method: "POST", headers: { "Origin": "https://ops.example.test", "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(input),
      }), deps);
      const createdResponse = await create();
      expect(createdResponse.status).toBe(200);
      const createdBody = await createdResponse.json() as { receipt: { onboardingId: string; proposedStaffId: string }; state: string };
      expect(createdBody.state).toBe("pending");

      const cancelInput = { commandId: uuid(), onboardingId: createdBody.receipt.onboardingId,
        expectedVersion: 1, reason: "Synthetic routed invitation cancellation" };
      const cancelledResponse = await handleOperationsNativeStaffLifecycleHttp(new Request(`${root}/onboarding/cancel`, {
        method: "POST", headers: { "Origin": "https://ops.example.test", "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(cancelInput),
      }), deps);
      expect(cancelledResponse.status).toBe(200);
      expect(await cancelledResponse.json()).toMatchObject({ receipt: { commandId: cancelInput.commandId,
        onboardingId: createdBody.receipt.onboardingId, resultVersion: 2, state: "cancelled", replayed: false } });
      const authorityBeforeReplay = await db.prepare(`SELECT capability,effect,scope_kind,active,version
        FROM native_staff_management_delegations WHERE actor_staff_id=? AND capability='staff.onboarding.create'`)
        .bind(person.id).all();
      const replayResponse = await create();
      expect(replayResponse.status).toBe(200);
      const replayBody = await replayResponse.json() as { state: string; receipt: { replayed: boolean; state: string } };
      expect(replayBody).toMatchObject({ state: "cancelled", receipt: { replayed: true, state: "cancelled" } });
      expect(JSON.stringify(replayBody)).not.toContain("invitationSecret");
      expect(await db.prepare("SELECT count(*) n FROM native_staff_pending_onboarding WHERE onboarding_id=?")
        .bind(createdBody.receipt.onboardingId).first("n")).toBe(1);
      expect(await db.prepare("SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?")
        .bind(createdBody.receipt.onboardingId).first()).toEqual({ state: "cancelled", version: 2 });
      expect((await db.prepare(`SELECT capability,effect,scope_kind,active,version FROM native_staff_management_delegations
        WHERE actor_staff_id=? AND capability='staff.onboarding.create'`).bind(person.id).all()).results).toEqual(authorityBeforeReplay.results);
      await expect(revealNativeStaffOnboarding(db, commandId, authenticated, keyring))
        .rejects.toThrow("native_staff_onboarding_create_denied");
    } finally {
      await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=? WHERE singleton=1").bind(priorEnabled).run();
    }
  });
});
