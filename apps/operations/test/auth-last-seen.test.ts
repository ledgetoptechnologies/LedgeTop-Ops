// last_seen_at is best-effort telemetry for an already-bound identity; everything that decides access stays
// fail-closed. Real RS256 Access tokens and D1 (Miniflare); a write-failing D1 wrapper simulates the daily quota.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isAdministrator } from "../src/worker/acl";
import { generateKeyPair, SignJWT } from "jose";
import { createStaffLoginFixture } from "./helpers/staff-login-fixture";
import { authenticateStaff, authenticateBoundStaffForViewerRenewal } from "../src/worker/auth";
import type { Env } from "../src/worker/types";

const verification = vi.hoisted(() => ({ key: null as unknown }));
vi.mock("jose", async importOriginal => ({ ...await importOriginal<typeof import("jose")>(), createRemoteJWKSet: vi.fn(() => verification.key) }));
const audience = "synthetic-last-seen-audience";
const TELEMETRY = /^UPDATE staff_users SET last_seen_at=datetime\('now'\) WHERE id=\?/;

/** A D1 whose matching statements fail (like an exhausted daily write quota or an outage); everything else is real. */
function failing(db: D1Database, pattern: RegExp): D1Database {
  const wrap = (target: any): any => new Proxy(target, { get(t, prop) {
    if (prop === "withSession") return (...args: unknown[]) => wrap(t.withSession(...args));
    if (prop === "prepare") return (sql: string) => {
      if (!pattern.test(sql)) return t.prepare(sql);
      const fail = () => Promise.reject(new Error("D1_ERROR: unavailable"));
      return { bind: () => ({ run: fail, first: fail, all: fail }) };
    };
    const value = t[prop];
    return typeof value === "function" ? value.bind(t) : value;
  } });
  return wrap(db);
}

describe("last_seen_at is best-effort; access decisions stay fail-closed", { timeout: 240_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createStaffLoginFixture>>;
  let privateKey: CryptoKey;
  beforeAll(async () => {
    const keys = await generateKeyPair("RS256"); privateKey = keys.privateKey; verification.key = keys.publicKey;
    fixture = await createStaffLoginFixture();
  }, 180_000);
  afterAll(async () => fixture?.runtime.dispose());
  const env = (db: D1Database) => ({ OPS_DB: db, TEAM_DOMAIN: fixture.issuer, OPERATIONS_AUD: audience, ENVIRONMENT: "production",
    EXPECTED_HOST: "ops.example.test", OPERATIONS_ORIGINS: "https://ops.example.test" }) as unknown as Env;
  async function request(email: string, subject: string) {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ type: "app", email }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
      .setIssuer(fixture.issuer).setAudience(audience).setSubject(subject).setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
    return new Request("https://ops.example.test/api/session", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
  }

  it("an already-bound staff member still signs in when the telemetry write fails (sign-in and Viewer renewal)", async () => {
    const db = failing(fixture.db, TELEMETRY);
    const principal = await authenticateStaff(await request(fixture.owner.email, fixture.owner.subject), env(db));
    expect(principal.id).toBe(fixture.owner.id);
    const renewal = await authenticateBoundStaffForViewerRenewal(await request(fixture.owner.email, fixture.owner.subject), env(db));
    expect(renewal.principal.id).toBe(fixture.owner.id);
  });

  it("a FIRST subject binding whose write fails is still denied, and nothing is bound", async () => {
    await fixture.db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,project_alpha_user_id,status) VALUES('unbound','unbound@example.test','U',NULL,NULL,'active')").run();
    const db = failing(fixture.db, /^UPDATE staff_users SET access_subject=\?/);
    await expect(authenticateStaff(await request("unbound@example.test", "access|unbound"), env(db))).rejects.toMatchObject({ status: 403 });
    expect((await fixture.db.prepare("SELECT access_subject FROM staff_users WHERE id='unbound'").first<{ access_subject: string | null }>())?.access_subject).toBeNull();
  });

  it("a mismatched Access identity and an inactive staff member are denied even with telemetry failing", async () => {
    const db = failing(fixture.db, TELEMETRY);
    await expect(authenticateStaff(await request(fixture.owner.email, "access|someone-else"), env(db))).rejects.toMatchObject({ status: 403 });
    await fixture.db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(fixture.owner.id).run();
    try {
      await expect(authenticateStaff(await request(fixture.owner.email, fixture.owner.subject), env(db))).rejects.toBeTruthy();
    } finally { await fixture.db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(fixture.owner.id).run(); }
  });

  it("a failing essential read (the staff lookup) still fails closed", async () => {
    const db = failing(fixture.db, /^SELECT id,email,display_name,access_subject,project_alpha_user_id FROM staff_users WHERE email=\?/);
    await expect(authenticateStaff(await request(fixture.owner.email, fixture.owner.subject), env(db))).rejects.toBeTruthy();
  });

  it("the full /api/session route: works with telemetry failing, fails closed when the ACL read fails", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("/api/*", async (c, next) => {
      const principal = await authenticateStaff(c.req.raw, c.env);
      (c as any).set("administrator", await isAdministrator(c.env, principal));
      (c as any).set("principal", principal);
      await next();
    });
    app.get("/api/session", c => c.json({ id: (c as any).get("principal").id, administrator: (c as any).get("administrator") }));
    app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "unavailable" }, 503));
    const telemetryDown = await app.request(await request(fixture.owner.email, fixture.owner.subject), undefined, env(failing(fixture.db, TELEMETRY)));
    expect(telemetryDown.status).toBe(200);
    expect(await telemetryDown.json()).toEqual({ id: fixture.owner.id, administrator: true });
    const aclDown = await app.request(await request(fixture.owner.email, fixture.owner.subject), undefined,
      env(failing(fixture.db, /FROM staff_role_assignments/)));
    expect(aclDown.status).toBeGreaterThanOrEqual(500);
    expect(await aclDown.json()).not.toHaveProperty("id");
  });
});
