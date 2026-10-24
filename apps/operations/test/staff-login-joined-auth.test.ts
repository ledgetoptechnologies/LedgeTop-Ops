import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { createStaffLoginFixture } from "./helpers/staff-login-fixture";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { authenticateStaff, authenticateBoundStaffForViewerRenewal } from "../src/worker/auth";
import { authenticateNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import { csrfToken, requireMutationSecurity } from "../src/worker/request-security";
import { isAdministrator } from "../src/worker/acl";
import { registerStaffLoginClaimRoute, registerStaffLoginOwnerRoutes } from "../src/worker/staff-login-link-routes";
import { resolveVerifiedStaffLogin, assertCurrentStaffLogin, type VerifiedStaffLoginClaims } from "../src/worker/staff-login-bindings";
import type { Env, StaffPrincipal } from "../src/worker/types";

const verification = vi.hoisted(() => ({ key: null as unknown }));
vi.mock("jose", async importOriginal => ({ ...await importOriginal<typeof import("jose")>(),
  createRemoteJWKSet: vi.fn(() => verification.key) }));
const origin = "https://ops.example.test", audience = "synthetic-owner-ops-audience";
type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;

describe("same-owner sign-in: real RSA, D1 and HTTP boundaries", { timeout: 240_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createStaffLoginFixture>>;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let env: Env, app: App;
  beforeAll(async () => {
    const keys = await generateKeyPair("RS256"); privateKey = keys.privateKey; verification.key = keys.publicKey;
    fixture = await createStaffLoginFixture();
    const rateSql = readFileSync(new URL("../migrations/0075_native_staff_onboarding_rate_limits.sql", import.meta.url), "utf8");
    await fixture.db.batch(splitD1MigrationStatements(rateSql).map(sql => fixture.db.prepare(sql)));
    env = { OPS_DB: fixture.db, TEAM_DOMAIN: fixture.issuer, OPERATIONS_AUD: audience,
      ENVIRONMENT: "production", EXPECTED_HOST: "ops.example.test", OPERATIONS_ORIGINS: origin,
      OPERATIONS_SESSION_SECRET: "synthetic-owner-signin-session-secret-0001" } as Env;
    app = new Hono();
    registerStaffLoginClaimRoute(app);
    app.use("/api/*", async (c, next) => {
      const principal = await authenticateStaff(c.req.raw, c.env);
      c.set("principal", principal); c.set("administrator", await isAdministrator(c.env, principal));
      if (["POST", "DELETE", "PATCH", "PUT"].includes(c.req.method))
        await requireMutationSecurity(c.req.raw, c.env, principal);
      await next();
    });
    registerStaffLoginOwnerRoutes(app);
    app.get("/api/session", c => c.json({ id: c.get("principal").id, email: c.get("principal").email, administrator: c.get("administrator") }));
    app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "unavailable" }, 503));
  }, 180_000);
  afterAll(async () => fixture?.runtime.dispose());
  async function token(claims: VerifiedStaffLoginClaims, extra: Record<string, unknown> = {}, audiences: string | string[] = audience) {
    return new SignJWT({ type: "app", email: claims.email, ...extra }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
      .setIssuer(claims.issuer).setAudience(audiences).setSubject(claims.subject)
      .setIssuedAt(claims.issuedAt).setExpirationTime(claims.expiresAt).sign(privateKey);
  }
  async function request(path: string, jwt: string, init: RequestInit = {}) {
    return app.request(origin + path, { ...init, headers: { "Cf-Access-Jwt-Assertion": jwt,
      ...(init.body ? { "Content-Type": "application/json", Origin: origin } : {}), ...init.headers } }, env);
  }
  const nativeConfig = () => ({ enabled: true, issuer: fixture.issuer, staffAudience: audience });

  it("links both verified sign-ins to one owner, renews without rebinding, and revokes only the alternate credential", async () => {
    const primaryJwt = await token(fixture.primaryClaims);
    const primary = await authenticateStaff(new Request(origin, { headers: { "Cf-Access-Jwt-Assertion": primaryJwt } }), env);
    const csrf = await csrfToken(env, primary);
    const created = await request("/api/account/login-links/intents", primaryJwt, { method: "POST",
      headers: { "X-CSRF-Token": csrf }, body: JSON.stringify({ email: fixture.owner.alternate }) });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const intent = await created.json() as { intentId: string; targetEmail: string; verificationUrl: string };
    const url = new URL(intent.verificationUrl), secret = new URLSearchParams(url.hash.slice(1)).get("token")!;
    expect(url.origin + url.pathname).toBe(origin + "/auth/link-login"); expect(url.search).toBe("");
    const secondaryClaims = fixture.claims(fixture.owner.alternate, fixture.owner.alternateSubject);
    const secondaryJwt = await token(secondaryClaims);
    expect((await request("/api/session", secondaryJwt)).status).toBe(403);
    const value = { intentId: intent.intentId, verificationToken: secret };
    const preview = await request("/api/account/login-links/preview-claim", secondaryJwt, { method: "POST", body: JSON.stringify(value) });
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(await preview.json()).toMatchObject({ canonicalEmail: primary.email, targetEmail: fixture.owner.alternate, state: "pending" });
    expect(await fixture.db.prepare("SELECT count(*) n FROM staff_login_bindings").first("n")).toBe(0);
    const claimed = await request("/api/account/login-links/claim", secondaryJwt, { method: "POST", body: JSON.stringify(value) });
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    const binding = await claimed.json() as { bindingId: string; staffId: string; version: number };
    expect(binding.staffId).toBe(fixture.owner.id);
    expect(await (await request("/api/account/login-links/claim", secondaryJwt, { method: "POST", body: JSON.stringify(value) })).json()).toEqual(binding);
    expect(await (await request("/api/session", secondaryJwt)).json()).toEqual({ id: primary.id, email: primary.email, administrator: true });
    const raw = new Request(origin, { headers: { "Cf-Access-Jwt-Assertion": secondaryJwt } });
    const native = await authenticateNativeStaffWithAdmissionVersion(raw, fixture.db, nativeConfig());
    expect(native.identity.staffId).toBe(primary.id); expect(native.identity.verifiedAccessSubject).toBe(fixture.owner.subject);
    expect(native.verifiedLogin?.subject).toBe(fixture.owner.alternateSubject);
    expect(native.admissionVersion).toBe(7); expect(native.identity.profileVersion).toBe(18);
    const renewal = await authenticateBoundStaffForViewerRenewal(raw, env);
    expect(renewal.principal.id).toBe(primary.id); expect(renewal.principal.verifiedLogin?.kind).toBe("alternate");
    const linked = await resolveVerifiedStaffLogin(fixture.db, secondaryClaims); expect(linked).not.toBeNull();
    const secondaryStatus = await (await request("/api/account/login-links", secondaryJwt)).json() as {canManage:boolean;bindings:unknown[]};
    expect(secondaryStatus).toMatchObject({canManage:false,bindings:[]});
    const deleted = await request("/api/account/login-links/" + binding.bindingId, primaryJwt, {method:"DELETE",
      headers:{"X-CSRF-Token":csrf},body:JSON.stringify({expectedVersion:1})});
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect((await request("/api/session", secondaryJwt)).status).toBe(403);
    expect(await assertCurrentStaffLogin(fixture.db, linked!.proof)).toBe(false);
    await expect(authenticateBoundStaffForViewerRenewal(raw,env)).rejects.toMatchObject({status:403});
    await expect(authenticateNativeStaffWithAdmissionVersion(raw,fixture.db,nativeConfig())).rejects.toThrow("native_staff_access_denied");
    expect((await request("/api/session",primaryJwt)).status).toBe(200);
    const primaryNative=await authenticateNativeStaffWithAdmissionVersion(new Request(origin,{headers:{"Cf-Access-Jwt-Assertion":primaryJwt}}),fixture.db,nativeConfig());
    expect(primaryNative.admissionVersion).toBe(7);expect(primaryNative.identity.profileVersion).toBe(19);
    expect(await fixture.db.prepare("SELECT count(*) n FROM staff_users").first("n")).toBe(1);
    expect(await fixture.db.prepare("SELECT admission_version FROM test_employee_grants WHERE staff_id=?").bind(primary.id).first("admission_version")).toBe(7);
  });

  it("keeps exact pre-staff claim routing narrow and rejects missing CSRF, foreign origins and untrusted claims", async () => {
    const primaryJwt=await token(fixture.primaryClaims);
    const denied=await request("/api/account/login-links/intents",primaryJwt,{method:"POST",body:JSON.stringify({email:"other@example.test"})});
    expect(denied.status).toBe(403);
    const secondaryJwt=await token(fixture.claims("unlinked@example.test","access|unlinked"));
    expect((await request("/api/account/login-links/claim/child",secondaryJwt,{method:"POST",body:"{}"})).status).toBe(403);
    const value={intentId:crypto.randomUUID(),verificationToken:"a".repeat(64)};
    expect((await request("/api/account/login-links/claim",secondaryJwt,{method:"POST",headers:{Origin:"https://outside.example.test"},body:JSON.stringify(value)})).status).toBe(403);
    expect((await request("/api/account/login-links/claim",secondaryJwt,{method:"POST",body:JSON.stringify({...value,staffId:fixture.owner.id})})).status).toBe(400);
    const wrongIssuer=await token({...fixture.primaryClaims,issuer:"https://other.cloudflareaccess.com"});
    expect((await request("/api/session",wrongIssuer)).status).toBe(401);
    expect(await fixture.db.prepare("SELECT count(*) n FROM staff_login_bindings").first("n")).toBe(1);
  });

  it("rejects expired, service and multi-audience signed assertions before claim writes", async () => {
    const claims = fixture.claims("machine-target@example.test", "access|machine-target");
    const value = JSON.stringify({ intentId: crypto.randomUUID(), verificationToken: "b".repeat(64) });
    const invalid = [
      await token({ ...claims, issuedAt: claims.issuedAt - 30, expiresAt: claims.issuedAt - 1 }),
      await token(claims, { common_name: "synthetic-machine", service_token_status: true }),
      await token(claims, {}, [audience, "another-application"]),
    ];
    for (const jwt of invalid) {
      const denied = await request("/api/account/login-links/claim", jwt, { method: "POST", body: value });
      expect(denied.status, await denied.clone().text()).toBe(401);
    }
    expect(await fixture.db.prepare("SELECT count(*) n FROM staff_login_bindings").first("n")).toBe(1);
  });

  it("bounds invalid claim attempts with the durable per-identity quota", async () => {
    const jwt = await token(fixture.claims("limited@example.test", "access|limited"));
    const value = JSON.stringify({ intentId: crypto.randomUUID(), verificationToken: "c".repeat(64) });
    for (let index = 0; index < 12; index++) {
      const denied = await request("/api/account/login-links/claim", jwt, { method: "POST", body: value });
      expect(denied.status).toBe(403);
    }
    const limited = await request("/api/account/login-links/claim", jwt, { method: "POST", body: value });
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await fixture.db.prepare("SELECT count(*) n FROM staff_login_bindings").first("n")).toBe(1);
  });
});

