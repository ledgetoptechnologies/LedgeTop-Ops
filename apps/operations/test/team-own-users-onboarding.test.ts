// Team "own users" security requirement R7 against every current Operations
// migration in local D1 (Miniflare), with real RS256 Access assertions signed by
// a locally generated key. Synthetic identities only; nothing leaves the process.
//   - a pending or claimed invitation is never an active Operations identity;
//   - a newly approved hire starts with an empty Operations ACL (no roles, no
//     overrides, not an administrator), not only empty native delegations;
//   - the invitation's creator may approve a different claimant (documented).
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { createNativeStaffOnboarding, revealNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-create";
import { authenticateNativeStaffOnboardingClaimant, claimNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-claim";
import { approveNativeStaffOnboarding, readNativeStaffOnboardingReview } from "../src/worker/native-staff-onboarding-approval";
import { authenticateStaff } from "../src/worker/auth";
import { isAdministrator, permissionKeys } from "../src/worker/acl";
import type { Env } from "../src/worker/types";

const keys = vi.hoisted(() => ({ resolver: undefined as unknown }));
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: () => keys.resolver }));
const issuer = "https://synthetic-team-own-users.cloudflareaccess.com";
const staffAudience = "synthetic-team-own-users-staff", claimantAudience = "synthetic-team-own-users-claimant";
const keyring = { activeKeyId: "fixture", keys: { fixture: "c".repeat(64) } };
let runtime: Miniflare, db: D1Database, privateKey: CryptoKey, sequence = 0;
const uuid = () => `70000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const expires = () => new Date(Date.now() + 600_000).toISOString();
type Person = { id: string; email: string; subject: string };

async function fixtureStaff(capabilities: readonly string[]): Promise<Person> {
  const id = `team-own-${++sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
  // Direct synthetic fixture rows, never a production admission proof.
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
const actor = (person: Person) => ({ staffId: person.id, verifiedAccessSubject: person.subject, admissionVersion: 1,
  profileVersion: 1, email: person.email, verifiedUntil: expires() });
const authenticated = (person: Person) => ({ identity: { kind: "native", staffId: person.id, verifiedAccessSubject: person.subject,
  email: person.email, displayName: person.id, profileVersion: 1 }, admissionVersion: 1, verifiedUntil: expires() });

async function invitation(creator: Person) {
  const input = { commandId: uuid(), loginEmail: `invitee-${++sequence}@example.test`,
    displayName: "Synthetic invited employee", expiresAt: expires(), reason: "Team own-users security fixture" };
  const created = await createNativeStaffOnboarding(db, input, authenticated(creator) as never, keyring);
  const reveal = await revealNativeStaffOnboarding(db, input.commandId, authenticated(creator) as never, keyring);
  return { input, created, reveal };
}
async function sign(email: string, subject: string, audience: string) {
  return new SignJWT({ email, type: "app" }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
}
async function claim(invite: Awaited<ReturnType<typeof invitation>>, subject: string) {
  const verified = await authenticateNativeStaffOnboardingClaimant(new Request("https://claim.example.test/", {
    headers: { "Cf-Access-Jwt-Assertion": await sign(invite.input.loginEmail, subject, claimantAudience) },
  }), { enabled: true, environment: "staging", issuer, staffAudience, claimantAudience });
  await claimNativeStaffOnboarding(db, { onboardingId: invite.created.onboardingId, invitationSecret: invite.reveal.invitationSecret }, verified);
  return verified;
}
const env = () => ({ OPS_DB: db, TEAM_DOMAIN: issuer, OPERATIONS_AUD: staffAudience }) as Env;
async function staffSignIn(email: string, subject: string) {
  return authenticateStaff(new Request("https://ops.example.test/api/session", {
    headers: { "Cf-Access-Jwt-Assertion": await sign(email, subject, staffAudience) } }), env());
}
async function operationsAcl(staffId: string) {
  const count = async (sql: string) => db.prepare(sql).bind(staffId).first<number>("n");
  return {
    roles: await count("SELECT count(*) n FROM staff_role_assignments WHERE staff_id=?"),
    localRoles: await count("SELECT count(*) n FROM local_staff_role_assignments WHERE staff_id=?"),
    overrides: await count("SELECT count(*) n FROM staff_permission_overrides WHERE staff_id=?"),
    divisions: await count("SELECT count(*) n FROM staff_divisions WHERE staff_id=?"),
  };
}

describe("team own-users R7: invitations, empty ACL and approval (full current D1 chain)", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('fixture')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    const pair = await generateKeyPair("RS256"); privateKey = pair.privateKey;
    keys.resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "fixture", alg: "RS256" }] });
  }, 180_000);
  afterAll(async () => runtime?.dispose());

  it("never admits a pending or claimed invitation to Operations, and an approved hire starts with an empty Operations ACL", async () => {
    expect(await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled")).toBe(0);
    const creator = await fixtureStaff(["staff.onboarding.create"]), reviewer = await fixtureStaff(["staff.onboarding.approve"]);
    const invite = await invitation(creator), subject = `access|invitee-${++sequence}`;

    // Pending: the invited email has no staff row and cannot sign in, even with a valid staff-audience assertion.
    await expect(staffSignIn(invite.input.loginEmail, subject)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email=? OR id=?")
      .bind(invite.input.loginEmail, invite.created.proposedStaffId).first("n")).toBe(0);

    // Claimed (identity proven, not yet approved): still no staff row and still no sign-in.
    const verified = await claim(invite, subject);
    expect(verified.subject).toBe(subject);
    await expect(staffSignIn(invite.input.loginEmail, subject)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email=? OR id=?")
      .bind(invite.input.loginEmail, invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT state FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(invite.created.onboardingId).first("state")).toBe("claimed");

    // Approved by a reviewer: the new identity exists but carries no Operations authority at all.
    const review = await readNativeStaffOnboardingReview(db, invite.created.onboardingId, actor(reviewer));
    await approveNativeStaffOnboarding(db, { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion: 2,
      proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256,
      reason: "Synthetic approval" }, actor(reviewer));
    expect(await operationsAcl(invite.created.proposedStaffId)).toEqual({ roles: 0, localRoles: 0, overrides: 0, divisions: 0 });
    // New hires are inserted sync_protected=1, so the legacy access-controls writer refuses
    // them (409); see team-own-users-access-controls.test.ts.
    expect(await db.prepare("SELECT sync_protected FROM staff_users WHERE id=?").bind(invite.created.proposedStaffId).first("sync_protected")).toBe(1);
    const principal = await staffSignIn(invite.input.loginEmail, subject);
    expect(principal.id).toBe(invite.created.proposedStaffId);
    expect(await isAdministrator(env(), principal)).toBe(false);
    expect(await permissionKeys(env(), principal)).toEqual([]);
    // A different Access subject presenting the invited email is still refused (bound subject).
    await expect(staffSignIn(invite.input.loginEmail, `access|impostor-${++sequence}`)).rejects.toMatchObject({ status: 403 });
  });

  // Documented behaviour: the invitation's creator may approve a different
  // claimant (the person being hired). The claimant is never the approver.
  it("lets the invitation's creator approve a different claimant", async () => {
    const creator = await fixtureStaff(["staff.onboarding.create", "staff.onboarding.approve"]);
    const invite = await invitation(creator);
    await claim(invite, `access|claimant-${++sequence}`);
    expect(invite.created.proposedStaffId).not.toBe(creator.id);
    const review = await readNativeStaffOnboardingReview(db, invite.created.onboardingId, actor(creator));
    await approveNativeStaffOnboarding(db, { commandId: uuid(), onboardingId: invite.created.onboardingId,
      expectedVersion: 2, proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256,
      reason: "Creator approves a different claimant" }, actor(creator));
    expect(await db.prepare("SELECT state FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(invite.created.onboardingId).first("state")).toBe("approved");
    expect(await operationsAcl(invite.created.proposedStaffId)).toEqual({ roles: 0, localRoles: 0, overrides: 0, divisions: 0 });
  });
});
