import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const calls = vi.hoisted(() => ({ verify: vi.fn(), jwks: vi.fn() }));
vi.mock("jose", () => ({ jwtVerify: calls.verify }));
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: calls.jwks }));

import { createNativeStaffOnboarding, revealNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-create";
import { claimNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-claim";
import { handleOperationsNativeStaffLifecycleHttp } from "../src/worker/operations-native-staff-lifecycle-http";

let runtime: Miniflare, db: D1Database;
let sequence = 0;
const uuid = () => `40000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const keyring = { activeKeyId: "test-key", keys: { "test-key": "a".repeat(64) } };
const issuer = "https://synthetic-team.cloudflareaccess.com", staffAudience = "staff-audience-123456",
  claimantAudience = "claim-audience-123456", origin = "https://ops-staging.ledgetopdroneservices.com";
const secret = "c".repeat(64);
const expires = () => new Date(Date.now() + 600_000).toISOString();

async function creator() {
  const id = `claim-test-creator-${++sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(id, email, id, subject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, id),
    db.prepare(`INSERT INTO native_staff_management_delegations
      (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,'staff.onboarding.create','allow','global',?)`)
      .bind(`${id}:create`, id, id),
  ]);
  return { id, email, subject };
}
async function pending(loginEmail = `invite-${++sequence}@example.test`) {
  const person = await creator(), created = await createNativeStaffOnboarding(db, {
    commandId: uuid(), loginEmail, displayName: "Synthetic Claimant", expiresAt: expires(), reason: "Synthetic claim test",
  }, { identity: { kind: "native", staffId: person.id, verifiedAccessSubject: person.subject,
    email: person.email, displayName: person.id, profileVersion: 1 }, admissionVersion: 1, verifiedUntil: expires() }, keyring);
  const revealed = await revealNativeStaffOnboarding(db, created.commandId, {
    identity: { kind: "native", staffId: person.id, verifiedAccessSubject: person.subject,
      email: person.email, displayName: person.id, profileVersion: 1 }, admissionVersion: 1, verifiedUntil: expires(),
  }, keyring);
  return { created, revealed, loginEmail };
}
function dependencies(enabled = "true", environment = "staging", audience = claimantAudience, database = db) {
  return { enabledFlag: "true", onboardingEnabledFlag: "false", onboardingClaimEnabledFlag: enabled,
    onboardingClaimantAudience: audience, environment, expectedHost: new URL(origin).hostname,
    configuration: { enabled: true, issuer, staffAudience, origin, csrfSecret: "s".repeat(32) }, database };
}
function assertion(email: string, aud: string | string[] = claimantAudience) {
  const now = Math.floor(Date.now() / 1000);
  calls.verify.mockResolvedValue({ payload: { aud, type: "app", sub: `access|invitee-${email}`,
    email, iat: now - 1, exp: now + 300 } });
  return "synthetic.signed.assertion";
}
async function session(email: string, d = dependencies()) {
  const response = await handleOperationsNativeStaffLifecycleHttp(new Request(`${origin}/api/native-staff/onboarding/claim/session`, {
    headers: { "Cf-Access-Jwt-Assertion": assertion(email), "CF-Connecting-IP": "192.0.2.44",
      "Sec-Fetch-Site": "same-origin", "X-Onboarding-Claim-Request": "1" },
  }), d);
  return { response, body: await response.json() as { csrfToken?: string; verifiedUntil?: string; error?: string } };
}

describe("default-off staging native staff invitation claim", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= "0076").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
  }, 90_000);
  afterAll(async () => runtime?.dispose());
  beforeEach(() => { vi.clearAllMocks(); calls.jwks.mockReturnValue("synthetic-jwks"); });

  it("verifies the separate audience, consumes an exact-email secret once, and creates no staff authority", async () => {
    const invite = await pending();
    const { response: sessionResponse, body: sessionBody } = await session(invite.loginEmail);
    expect(sessionResponse.status).toBe(200);
    expect(calls.verify).toHaveBeenLastCalledWith("synthetic.signed.assertion", "synthetic-jwks", {
      issuer, audience: claimantAudience, algorithms: ["RS256"],
    });
    const response = await handleOperationsNativeStaffLifecycleHttp(new Request(`${origin}/api/native-staff/onboarding/claim`, {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion(invite.loginEmail), "CF-Connecting-IP": "192.0.2.44",
        "Sec-Fetch-Site": "same-origin", Origin: origin, "Content-Type": "application/json",
        "X-CSRF-Token": sessionBody.csrfToken! },
      body: JSON.stringify({ onboardingId: invite.created.onboardingId, invitationSecret: invite.revealed.invitationSecret }),
    }), dependencies());
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ onboardingId: invite.created.onboardingId, state: "claimed" });
    expect(JSON.stringify(body)).not.toContain(invite.revealed.invitationSecret);
    expect(await db.prepare(`SELECT state,version,claimed_access_subject,claim_evidence_sha256 FROM native_staff_pending_onboarding
      WHERE onboarding_id=?`).bind(invite.created.onboardingId).first()).toMatchObject({
      state: "claimed", version: 2, claimed_access_subject: `access|invitee-${invite.loginEmail}`,
    });
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?").bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_admissions WHERE staff_id=?").bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_profiles WHERE staff_id=?").bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_target_memberships WHERE staff_id=?").bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_directory_grants WHERE staff_id=?").bind(invite.created.proposedStaffId).first("n")).toBe(0);
  });

  it("denies wrong email, wrong secret, replay, mixed audience, and a claimant audience equal to staff", async () => {
    const invite = await pending();
    const { body: sessionBody } = await session(invite.loginEmail);
    const attempt = async (email: string, invitationSecret: string, audience: string | string[] = claimantAudience,
      d = dependencies()) => {
      const csrfBody = email === invite.loginEmail ? sessionBody : (await session(email)).body;
      const response = await handleOperationsNativeStaffLifecycleHttp(new Request(`${origin}/api/native-staff/onboarding/claim`, {
        method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion(email, audience), "CF-Connecting-IP": "192.0.2.45",
          "Sec-Fetch-Site": "same-origin", Origin: origin, "Content-Type": "application/json",
          "X-CSRF-Token": csrfBody.csrfToken! },
        body: JSON.stringify({ onboardingId: invite.created.onboardingId, invitationSecret }),
      }), d);
      return response;
    };
    expect((await attempt("wrong@example.test", invite.revealed.invitationSecret)).status).toBe(403);
    expect((await attempt(invite.loginEmail, "d".repeat(64))).status).toBe(403);
    expect((await attempt("other@example.test", invite.revealed.invitationSecret, [claimantAudience, "extra"])).status).toBe(403);
    expect((await attempt("other@example.test", invite.revealed.invitationSecret, claimantAudience,
      dependencies("true", "staging", staffAudience))).status).toBe(404);
    expect(await db.prepare("SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(invite.created.onboardingId).first()).toEqual({ state: "pending", version: 1 });
    const validSession = await session(invite.loginEmail);
    const claimRequest = () => handleOperationsNativeStaffLifecycleHttp(new Request(`${origin}/api/native-staff/onboarding/claim`, {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion(invite.loginEmail), "CF-Connecting-IP": "192.0.2.46",
        "Sec-Fetch-Site": "same-origin", Origin: origin, "Content-Type": "application/json",
        "X-CSRF-Token": validSession.body.csrfToken! },
      body: JSON.stringify({ onboardingId: invite.created.onboardingId, invitationSecret: invite.revealed.invitationSecret }),
    }), dependencies());
    expect((await claimRequest()).status).toBe(200);
    expect((await claimRequest()).status).toBe(403);
  });

  it("consumes the invitation only once when two verified claim requests race", async () => {
    const invite = await pending();
    const { body: sessionBody } = await session(invite.loginEmail);
    const request = () => handleOperationsNativeStaffLifecycleHttp(new Request(`${origin}/api/native-staff/onboarding/claim`, {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion(invite.loginEmail),
        "CF-Connecting-IP": "192.0.2.48", "Sec-Fetch-Site": "same-origin", Origin: origin,
        "Content-Type": "application/json", "X-CSRF-Token": sessionBody.csrfToken! },
      body: JSON.stringify({ onboardingId: invite.created.onboardingId, invitationSecret: invite.revealed.invitationSecret }),
    }), dependencies());
    const responses = await Promise.all([request(), request()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 403]);
    expect(await db.prepare("SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(invite.created.onboardingId).first()).toEqual({ state: "claimed", version: 2 });
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(0);
  });

  it("returns success when the verified token expires after the claim CAS commits", async () => {
    const invite = await pending();
    const sessionResult = await session(invite.loginEmail);
    expect(sessionResult.response.status).toBe(200);
    const realNow = Date.now.bind(Date);
    let committed = false;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + (committed ? 600_000 : 0));
    try {
      const d = { ...dependencies(), claimOnboarding: async (database: D1Database, input: unknown, claimant: unknown) => {
        const result = await claimNativeStaffOnboarding(database, input, claimant);
        // Simulate the verified Access assertion expiring while D1 acknowledges
        // the completed CAS, before the HTTP layer finishes its response.
        committed = true;
        return result;
      } };
      const response = await handleOperationsNativeStaffLifecycleHttp(new Request(`${origin}/api/native-staff/onboarding/claim`, {
        method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion(invite.loginEmail), "CF-Connecting-IP": "192.0.2.47",
          "Sec-Fetch-Site": "same-origin", Origin: origin, "Content-Type": "application/json",
          "X-CSRF-Token": sessionResult.body.csrfToken! },
        body: JSON.stringify({ onboardingId: invite.created.onboardingId, invitationSecret: invite.revealed.invitationSecret }),
      }), d);
      expect(committed).toBe(true);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ onboardingId: invite.created.onboardingId, state: "claimed" });
      expect(await db.prepare("SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?")
        .bind(invite.created.onboardingId).first()).toEqual({ state: "claimed", version: 2 });
    } finally {
      clock.mockRestore();
    }
  });

  it("is unavailable outside staging or while disabled", async () => {
    assertion("invitee@example.test");
    for (const d of [dependencies("false"), dependencies("true", "production")]) {
      const response = await handleOperationsNativeStaffLifecycleHttp(new Request(`${origin}/api/native-staff/onboarding/claim/session`, {
        headers: { "Cf-Access-Jwt-Assertion": "synthetic.assertion", "Sec-Fetch-Site": "same-origin",
          "X-Onboarding-Claim-Request": "1" },
      }), d);
      expect(response.status).toBe(404);
    }
    expect(calls.verify).not.toHaveBeenCalled();
  });
});
