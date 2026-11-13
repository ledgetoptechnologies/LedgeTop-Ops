import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
import { createNativeStaffOnboarding, revealNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-create";
import { authenticateNativeStaffOnboardingClaimant, claimNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-claim";
import { approveNativeStaffOnboarding, readNativeStaffOnboardingReview } from "../src/worker/native-staff-onboarding-approval";
import { cancelNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-cancel";

const keys = vi.hoisted(() => ({ resolver: undefined as unknown }));
// Resolve only locally generated fixture keys. JWT signature/issuer/audience
// verification is real; this test never fetches a JWKS or uses a live identity.
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: () => keys.resolver }));
const issuer = "https://synthetic-onboarding.cloudflareaccess.com";
const staffAudience = "synthetic-current-staff", claimantAudience = "synthetic-current-claimant";
const keyring = { activeKeyId: "fixture", keys: { fixture: "b".repeat(64) } };
let runtime: Miniflare, db: D1Database, privateKey: CryptoKey, sequence = 0;
const uuid = () => `60000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const expires = () => new Date(Date.now() + 600_000).toISOString();

async function fixtureStaff(capabilities: readonly string[]) {
  const id = `current-staff-${++sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
  // Direct setup is synthetic fixture data, never a production admission proof.
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(id, email, id, subject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, id),
    ...capabilities.map(capability => db.prepare(`INSERT INTO native_staff_management_delegations
      (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`)
      .bind(`${id}:${capability}`, id, capability, id)),
  ]);
  return { id, email, subject };
}
function actor(person: Awaited<ReturnType<typeof fixtureStaff>>) {
  return { staffId: person.id, verifiedAccessSubject: person.subject, admissionVersion: 1,
    profileVersion: 1, email: person.email, verifiedUntil: expires() };
}
async function invitation() {
  const creator = await fixtureStaff(["staff.onboarding.create"]);
  const input = { commandId: uuid(), loginEmail: `current-invite-${++sequence}@example.test`,
    displayName: "Current schema synthetic employee", expiresAt: expires(), reason: "Full source D1 fixture" };
  const authenticated = { identity: { kind: "native", staffId: creator.id,
    verifiedAccessSubject: creator.subject, email: creator.email, displayName: creator.id, profileVersion: 1 },
    admissionVersion: 1, verifiedUntil: expires() };
  const created = await createNativeStaffOnboarding(db, input, authenticated, keyring);
  const reveal = await revealNativeStaffOnboarding(db, input.commandId, authenticated, keyring);
  return { creator, input, created, reveal };
}
async function claimant(email: string, subject: string, audience: string = claimantAudience) {
  const jwt = await new SignJWT({ email, type: "app" }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return authenticateNativeStaffOnboardingClaimant(new Request("https://claim.example.test/", {
    headers: { "Cf-Access-Jwt-Assertion": jwt },
  }), { enabled: true, environment: "staging", issuer, staffAudience, claimantAudience });
}

describe("native onboarding against every current source migration in local D1", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('fixture')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    // Validate the unchanged historical inventory and explicitly byte-reviewed
    // successors, then APPLY every physical file. No historical cutoff/filter.
    reviewedOperationsMigrationNames(directory);
    const names = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
    expect(names).toHaveLength(235);
    expect(names.slice(-4)).toEqual(["0240_flight_logs_permissions.sql", "0241_staff_usernames.sql",
      "0242_native_staff_onboarding_approval_actor_authority.sql", "0243_staff_logs_device_eligibility.sql"]);
    for (const name of names) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    }
    const pair = await generateKeyPair("RS256"); privateKey = pair.privateKey;
    keys.resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "fixture", alg: "RS256" }] });
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("retains the real cutover default and the four explicit approval triggers", async () => {
    expect(await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled")).toBe(0);
    const triggers = await db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN
      ('native_staff_onboarding_approve_actor_allow','native_staff_onboarding_approve_actor_deny',
       'native_staff_onboarding_approve_receipt_actor_allow','native_staff_onboarding_approve_receipt_actor_deny')`).all();
    expect(triggers.results).toHaveLength(4);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("requires a valid claimant and approves one local identity with no PA link or implicit ACL", async () => {
    const invite = await invitation(), reviewer = await fixtureStaff(["staff.onboarding.approve"]);
    await expect(claimant(invite.input.loginEmail, "access|wrong-audience", staffAudience)).rejects.toThrow();
    const wrongEmail = await claimant("wrong@example.test", "access|wrong-email");
    await expect(claimNativeStaffOnboarding(db, { onboardingId: invite.created.onboardingId,
      invitationSecret: invite.reveal.invitationSecret }, wrongEmail)).rejects.toThrow();
    const verified = await claimant(invite.input.loginEmail, `access|current-invite-${++sequence}`);
    const claimInput = { onboardingId: invite.created.onboardingId, invitationSecret: invite.reveal.invitationSecret };
    await claimNativeStaffOnboarding(db, claimInput, verified);
    await expect(claimNativeStaffOnboarding(db, claimInput, verified)).rejects.toThrow();
    const review = await readNativeStaffOnboardingReview(db, invite.created.onboardingId, actor(reviewer));
    const input = { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion: 2,
      proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256, reason: "Full-chain fixture approval" };
    const receipt = await approveNativeStaffOnboarding(db, input, actor(reviewer));
    expect(await approveNativeStaffOnboarding(db, input, actor(reviewer))).toEqual({ ...receipt, replayed: true });
    expect(await db.prepare("SELECT project_alpha_user_id,provisioning_source,email,access_subject FROM staff_users WHERE id=?")
      .bind(invite.created.proposedStaffId).first()).toEqual({ project_alpha_user_id: null, provisioning_source: "local",
      email: invite.input.loginEmail, access_subject: verified.subject });
    for (const table of ["native_staff_target_memberships", "native_directory_grants"]) {
      expect(await db.prepare(`SELECT count(*) n FROM ${table} WHERE staff_id=?`).bind(invite.created.proposedStaffId).first("n")).toBe(0);
    }
    expect(await db.prepare("SELECT count(*) n FROM native_staff_management_delegations WHERE actor_staff_id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id=?")
      .bind(reviewer.id).first()).toEqual({ active: 1, version: 1 });
  });

  it("cancels and replays without creating an employee or changing creator admission", async () => {
    const invite = await invitation(), reviewer = await fixtureStaff(["staff.onboarding.cancel"]);
    const input = { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion: 1,
      reason: "Full-chain fixture cancellation" };
    const receipt = await cancelNativeStaffOnboarding(db, input, actor(reviewer));
    expect(await cancelNativeStaffOnboarding(db, input, actor(reviewer))).toEqual({ ...receipt, replayed: true });
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(invite.created.onboardingId).first()).toEqual({ state: "cancelled", version: 2 });
    expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id=?")
      .bind(invite.creator.id).first()).toEqual({ active: 1, version: 1 });
  });
});
