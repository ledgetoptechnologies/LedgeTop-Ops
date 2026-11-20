// Team "own users": the legacy access-controls writer through the real mounted
// Operations worker fetch path (real RS256 Access assertions from a locally generated
// key, real authenticateStaff/ACL/CSRF middleware) against every current Operations
// migration in local D1 (Miniflare). Native hires are created by the real invitation,
// claim and approval services and must stay out of this writer (sync_protected).
// Synthetic identities and hosts only.
//
// The roster flag (access_controls_editable) must equal the PUT route's decision for
// every row exercised here.
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { createNativeStaffOnboarding, revealNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-create";
import { authenticateNativeStaffOnboardingClaimant, claimNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-claim";
import { approveNativeStaffOnboarding, readNativeStaffOnboardingReview } from "../src/worker/native-staff-onboarding-approval";
import { csrfToken } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";
import worker from "../src/worker/index";

const keys = vi.hoisted(() => ({ resolver: undefined as unknown }));
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: () => keys.resolver }));
// Only the unused platform base classes are stubbed; fetch dispatch, auth, ACL, CSRF and D1 stay real.
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

const issuer = "https://synthetic-own-users-acl.cloudflareaccess.com";
const staffAudience = "synthetic-own-users-acl-staff", claimantAudience = "synthetic-own-users-acl-claimant";
const origin = "https://ops.example.test", sessionSecret = "synthetic-own-users-acl-session-secret-local-fixture-only";
const keyring = { activeKeyId: "fixture", keys: { fixture: "d".repeat(64) } };
let runtime: Miniflare, db: D1Database, signingKey: CryptoKey, sequence = 0;
type Person = { id: string; email: string; subject: string };
const uuid = () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const expires = () => new Date(Date.now() + 600_000).toISOString();

// Optional hook run just before the PUT's write batch (simulates a concurrent change after the read).
let beforeBatch: (() => Promise<void>) | undefined;
const opsDb = () => beforeBatch ? new Proxy(db, { get(target, key) {
  if (key === "batch") return async (statements: D1PreparedStatement[]) => {
    const hook = beforeBatch; beforeBatch = undefined; await hook?.(); return target.batch(statements);
  };
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} }) : db;
const env = () => ({ OPS_DB: opsDb(), TEAM_DOMAIN: issuer, OPERATIONS_AUD: staffAudience, ENVIRONMENT: "staging",
  EXPECTED_HOST: new URL(origin).hostname, PUBLIC_BASE_URL: origin, OPERATIONS_ORIGINS: origin,
  OPERATIONS_SESSION_SECRET: sessionSecret, AUDIT_IP_SECRET: "synthetic-own-users-acl-audit-secret-local-fixture-only" }) as unknown as Env;
const executionContext = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const fetch = (request: Request) => worker.fetch(request, env(), executionContext);

async function token(email: string, subject: string, audience = staffAudience) {
  return new SignJWT({ email, type: "app" }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("10m").sign(signingKey);
}

/** Directly inserted synthetic staff rows (never a production admission proof). */
async function person(options: { role?: "role-admin" | "role-owner"; deny?: string[]; syncProtected?: boolean;
  local?: boolean; paLink?: string; native?: boolean; delegations?: string[] } = {}): Promise<Person> {
  const id = `own-acl-${++sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
  const statements = [db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,project_alpha_user_id,sync_protected,provisioning_source)
    VALUES(?,?,?,?,?,?,?)`).bind(id, email, id, subject, options.paLink ?? null, options.syncProtected ? 1 : 0,
    options.local ? "local" : "project-alpha")];
  if (options.role) statements.push(db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,?,'global','global')")
    .bind(uuid(), id, options.role));
  for (const permission of options.deny ?? []) statements.push(db.prepare(`INSERT INTO staff_permission_overrides
    (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,?,'deny','global',NULL,'global',?)`)
    .bind(uuid(), id, permission, id));
  if (options.native || options.delegations) statements.push(
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, id));
  for (const capability of options.delegations ?? []) statements.push(db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`).bind(`${id}:${capability}`, id, capability, id));
  await db.batch(statements);
  return { id, email, subject };
}

const nativeActor = (who: Person) => ({ staffId: who.id, verifiedAccessSubject: who.subject, admissionVersion: 1,
  profileVersion: 1, email: who.email, verifiedUntil: expires() });
const authenticated = (who: Person) => ({ identity: { kind: "native", staffId: who.id, verifiedAccessSubject: who.subject,
  email: who.email, displayName: who.id, profileVersion: 1 }, admissionVersion: 1, verifiedUntil: expires() });

let creator: Person, reviewer: Person;
/** A hire created by the real Ops invitation -> claim -> approval flow (the claimant is a new person). */
async function nativeHire(by: { creator: Person; approver: Person } = { creator, approver: reviewer }): Promise<Person> {
  const input = { commandId: uuid(), loginEmail: `hire-${++sequence}@example.test`, displayName: `Synthetic hire ${sequence}`,
    expiresAt: expires(), reason: "Team own-users access-controls fixture" };
  const created = await createNativeStaffOnboarding(db, input, authenticated(by.creator) as never, keyring);
  const reveal = await revealNativeStaffOnboarding(db, input.commandId, authenticated(by.creator) as never, keyring);
  const subject = `access|hire-${++sequence}`;
  const verified = await authenticateNativeStaffOnboardingClaimant(new Request("https://claim.example.test/", {
    headers: { "Cf-Access-Jwt-Assertion": await token(input.loginEmail, subject, claimantAudience) },
  }), { enabled: true, environment: "staging", issuer, staffAudience, claimantAudience });
  await claimNativeStaffOnboarding(db, { onboardingId: created.onboardingId, invitationSecret: reveal.invitationSecret }, verified);
  const review = await readNativeStaffOnboardingReview(db, created.onboardingId, nativeActor(by.approver));
  await approveNativeStaffOnboarding(db, { commandId: uuid(), onboardingId: created.onboardingId, expectedVersion: 2,
    proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256,
    reason: "Synthetic approval" }, nativeActor(by.approver));
  const row = await db.prepare("SELECT provisioning_source,sync_protected,project_alpha_user_id FROM staff_users WHERE id=?")
    .bind(created.proposedStaffId).first();
  expect(row).toEqual({ provisioning_source: "local", sync_protected: 1, project_alpha_user_id: null });
  return { id: created.proposedStaffId, email: input.loginEmail, subject };
}

const CONTROL_KEYS = ["allOperations", "sopAssignment", "deliveryBrowse", "deliveryLinkCreate", "deliveryLinkRevoke", "deliveryLinkAudit",
  "teamRoster", "administration", "viewerAccess", "viewerDatasets", "viewerProcessing", "viewerPublish", "viewerShareCreate",
  "viewerShareRevoke", "viewerClientAccess", "viewerStoragePurge"] as const;
const controls = (enabled: Partial<Record<typeof CONTROL_KEYS[number], boolean>> = {}) =>
  Object.fromEntries(CONTROL_KEYS.map(key => [key, enabled[key] ?? false])) as Record<string, boolean>;
async function putControls(actor: Person, targetId: string, body: Record<string, boolean>) {
  const csrf = await csrfToken(env(), { accessSubject: actor.subject } as StaffPrincipal);
  return fetch(new Request(`${origin}/api/admin/staff/${encodeURIComponent(targetId)}/access-controls`, { method: "PUT",
    body: JSON.stringify(body), headers: { "Cf-Access-Jwt-Assertion": await token(actor.email, actor.subject), Origin: origin,
      "Content-Type": "application/json", "X-CSRF-Token": csrf } }));
}
async function rosterFlags(actor: Person) {
  const response = await fetch(new Request(`${origin}/api/team/staff`, {
    headers: { "Cf-Access-Jwt-Assertion": await token(actor.email, actor.subject) } }));
  expect(response.status).toBe(200);
  const staff = ((await response.json()) as { staff: Array<Record<string, unknown>> }).staff;
  for (const row of staff) {
    expect(row).not.toHaveProperty("native_onboarded");
    expect(row).not.toHaveProperty("access_subject");
  }
  return new Map(staff.map(row => [row.id as string, row.access_controls_editable]));
}
const overrideCount = (staffId: string) =>
  db.prepare("SELECT count(*) n FROM staff_permission_overrides WHERE staff_id=?").bind(staffId).first<number>("n");
const auditCount = (staffId: string, actorId: string) => db.prepare(
  "SELECT count(*) n FROM audit_events WHERE action='staff.access_controls.updated' AND entity_id=? AND actor_id=?")
  .bind(staffId, actorId).first<number>("n");

/** PUT outcome and roster flag must agree; blocked PUTs write nothing. */
async function expectDecision(actor: Person, targetId: string, status: 200 | 403 | 409, flags: Map<string, unknown>) {
  const before = await overrideCount(targetId);
  const response = await putControls(actor, targetId, controls({ deliveryBrowse: true }));
  expect(response.status, targetId).toBe(status);
  expect(flags.get(targetId), targetId).toBe(status === 200);
  if (status === 200) {
    expect(await db.prepare("SELECT effect FROM staff_permission_overrides WHERE staff_id=? AND permission_key='delivery.browse'")
      .bind(targetId).first("effect")).toBe("allow");
    expect(await auditCount(targetId, actor.id)).toBe(1);
  } else {
    expect(await overrideCount(targetId)).toBe(before);
    expect(await auditCount(targetId, actor.id)).toBe(0);
  }
  return response;
}

describe("team own-users: access controls for Ops-native hires (full current D1 chain)", { timeout: 120_000 }, () => {
  let fixedOwnerId: string;
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('fixture')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    // The migration-seeded fixed owner (the only global owner before any fixture row exists).
    const seeded = await db.prepare("SELECT staff_id FROM staff_role_assignments WHERE role_id='role-owner' AND scope='global'").all<{ staff_id: string }>();
    expect(seeded.results).toHaveLength(1);
    fixedOwnerId = seeded.results[0]!.staff_id;
    const pair = await generateKeyPair("RS256"); signingKey = pair.privateKey;
    keys.resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "fixture", alg: "RS256" }] });
    creator = await person({ delegations: ["staff.onboarding.create"] });
    reviewer = await person({ delegations: ["staff.onboarding.approve"] });
  }, 180_000);
  afterAll(async () => runtime?.dispose());

  it("keeps every Ops-native hire and other protected row out of the legacy writer; edits only unprotected non-owners", async () => {
    const admin = await person({ role: "role-admin" });
    const hire = await nativeHire();
    const ownerHire = await nativeHire();
    await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-owner','global','global')")
      .bind(uuid(), ownerHire.id).run();
    // Unprotected global owners from either role table.
    const owner = await person({ role: "role-owner" });
    const localOwner = await person();
    await db.prepare("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,division_id,created_by) VALUES(?,?,'role-owner','global',NULL,?)")
      .bind(uuid(), localOwner.id, admin.id).run();
    // Legacy/unknown protected rows: no native records; a local look-alike with admission and
    // profile only; a Project Alpha-linked row.
    const legacy = await person({ syncProtected: true });
    const lookalike = await person({ syncProtected: true, local: true, native: true });
    const paLinked = await person({ syncProtected: true, local: true, native: true, paLink: "pa-synthetic-1" });
    const ordinary = await person();

    const flags = await rosterFlags(admin);
    for (const id of [hire.id, ownerHire.id, owner.id, localOwner.id, fixedOwnerId, legacy.id, lookalike.id, paLinked.id, admin.id])
      await expectDecision(admin, id, 409, flags);
    await expectDecision(admin, ordinary.id, 200, flags);
    const blocked = await putControls(admin, hire.id, controls());
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("Protected staff access controls cannot be changed") });
  });

  it("refuses an administrator's own edit and keeps the purge control owner-only", async () => {
    const hireAdmin = await nativeHire();
    await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-admin','global','global')")
      .bind(uuid(), hireAdmin.id).run();
    const target = await person();
    const flags = await rosterFlags(hireAdmin);
    await expectDecision(hireAdmin, hireAdmin.id, 409, flags);
    expect((await putControls(hireAdmin, target.id, controls({ viewerStoragePurge: true }))).status).toBe(403);
    expect(await overrideCount(target.id)).toBe(0);
    await expectDecision(hireAdmin, target.id, 200, flags);
  });

  it("blocks a hire whose invitation creator approved a different claimant, like any other native hire", async () => {
    const admin = await person({ role: "role-admin" });
    const both = await person({ delegations: ["staff.onboarding.create", "staff.onboarding.approve"] });
    const hire = await nativeHire({ creator: both, approver: both });
    expect(hire.id).not.toBe(both.id);
    expect(await db.prepare("SELECT state FROM native_staff_pending_onboarding WHERE proposed_staff_id=?")
      .bind(hire.id).first("state")).toBe("approved");
    const flags = await rosterFlags(admin);
    await expectDecision(admin, hire.id, 409, flags);
  });

  it("re-checks eligibility inside the write batch, so a change after the read cannot slip through", async () => {
    const admin = await person({ role: "role-admin" });
    const becomesOwner = await person(), becomesProtected = await person();
    beforeBatch = () => db.prepare("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,division_id,created_by) VALUES(?,?,'role-owner','global',NULL,?)")
      .bind(uuid(), becomesOwner.id, admin.id).run().then(() => undefined);
    const raced = await putControls(admin, becomesOwner.id, controls({ deliveryBrowse: true }));
    expect(raced.status).toBe(409);
    expect(await overrideCount(becomesOwner.id)).toBe(0);
    expect(await auditCount(becomesOwner.id, admin.id)).toBe(0);
    beforeBatch = () => db.prepare("UPDATE staff_users SET sync_protected=1 WHERE id=?")
      .bind(becomesProtected.id).run().then(() => undefined);
    expect((await putControls(admin, becomesProtected.id, controls({ deliveryBrowse: true }))).status).toBe(409);
    expect(await overrideCount(becomesProtected.id)).toBe(0);
    expect(beforeBatch).toBeUndefined();
  });

  it("returns 403 to a caller without global roles.manage and never offers the editor in their roster", async () => {
    const deniedAdmin = await person({ role: "role-admin", deny: ["roles.manage"] });
    const target = await person();
    const flags = await rosterFlags(deniedAdmin);
    await expectDecision(deniedAdmin, target.id, 403, flags);
    expect([...flags.values()].every(value => value === false)).toBe(true);
  });
});
