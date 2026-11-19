import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWindowsFilesPolicyRouter, WINDOWS_FILES_MINIMUM_APP_VERSION } from "../src/worker/client-portal/windows-files-policy-routes";
import { createWindowsPortalStagingWorker, windowsPortalStagingPath } from "../src/worker/client-portal/windows-files-staging-worker";

const keys = vi.hoisted(() => vi.fn());
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: keys }));
const origin = "https://portal-staging.ledgetopdroneservices.com", issuer = "https://ledgetoptechnologies.cloudflareaccess.com";
const audience = "synthetic-policy-audience", path = "/api/client/operations/data/windows-files/policy";
const config = { enabled: true, portalOrigin: origin, issuer, audience };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256", { extractable: true });
  const key = await exportJWK(pair.publicKey); key.kid = "policy"; keys.mockReturnValue(createLocalJWKSet({ keys: [key] }));
});
const token = (aud = audience, claims: Record<string, unknown> = {}) => new SignJWT({ type: "app", email: "synthetic@example.invalid", ...claims })
  .setProtectedHeader({ alg: "RS256", kid: "policy" }).setIssuer(issuer).setSubject("synthetic-client").setAudience(aud).setExpirationTime("1h").sign(pair.privateKey);
const env = () => ({ ENVIRONMENT: "staging", CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin, CLIENT_ACCESS_TEAM_DOMAIN: issuer,
  CLIENT_ACCESS_AUD: audience, CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true" }) as never;
function call(target: string, assertion?: string, init: RequestInit = {}, options = config) {
  const headers = new Headers(init.headers); if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);
  return createWindowsFilesPolicyRouter(options).fetch(new Request(origin + target, { ...init, headers }), env());
}

describe("Windows files policy", () => {
  it("gives a signed-in client one read-only R2 root with every switch off", async () => {
    const response = await call(path, await token());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ schemaVersion: 1, role: "client", providerEnabled: false, hydrationEnabled: false,
      minimumAppVersion: WINDOWS_FILES_MINIMUM_APP_VERSION,
      roots: [{ id: "delivered", backend: "r2", rights: ["read"], listPath: "/api/client/operations/data/windows-catalog/deliveries" }] });
    expect(Date.parse(String(body.sessionExpiresAt))).toBeGreaterThan(Date.now());
    expect(JSON.stringify(body)).not.toMatch(/synthetic-client|synthetic@example/u);
  });

  it("answers every unauthenticated request the same way regardless of parameters", async () => {
    const wrongAudience = await token("another-audience"), machine = await token(audience, { service_token_id: "machine" });
    const attempts = [
      [path, undefined], [path + "?role=staff", undefined], [path + "?cursor=x&root=../../other", undefined],
      [path, "not-a-jwt"], [path + "?x=1", wrongAudience], [path, machine],
    ] as const;
    const seen = await Promise.all(attempts.map(async ([target, assertion]) => { const r = await call(target, assertion); return `${r.status} ${await r.text()}`; }));
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatch(/^401 /u);
  });

  it("rejects unknown parameters, other methods, cross-site callers and a disabled deployment", async () => {
    const jwt = await token();
    expect((await call(path + "?role=staff", jwt)).status).toBe(400);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await call(path, jwt, { method })).status).toBe(405);
    expect((await call(path, jwt, { headers: { Origin: "https://elsewhere.invalid" } })).status).toBe(403);
    expect((await call(path, jwt, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await call(path, jwt, {}, { ...config, enabled: false })).status).toBe(503);
    expect((await call("/api/client/operations/data/windows-files/other", jwt)).status).toBe(404);
  });

  it("is routed by the staging composition and nowhere else", async () => {
    expect(windowsPortalStagingPath(path)).toBe(true);
    expect(windowsPortalStagingPath("/api/client/operations/data/windows-files-other")).toBe(false);
    const fallback = { fetch: vi.fn(async () => new Response("fallback", { status: 418 })), scheduled: vi.fn() };
    const disabled = createWindowsPortalStagingWorker({ enabled: false, deployment: { accountId: "0".repeat(32), workerName: "synthetic-staging",
      databaseId: "00000000-0000-4000-8000-000000000001", bucketName: "synthetic-staging", opsReaderWorkerName: "synthetic-reader-staging" } }, fallback);
    const response = await disabled.fetch(new Request(origin + path, { headers: { "Cf-Access-Jwt-Assertion": await token() } }), env(), {} as ExecutionContext);
    expect(response.status).toBe(503); expect(fallback.fetch).not.toHaveBeenCalled();
  });
});
