import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWindowsEmployeeStagingWorker, windowsEmployeeStagingPath } from "../src/worker/windows-files-staging-worker";
const mocks = vi.hoisted(() => ({ keys: vi.fn(), identity: vi.fn() }));
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: mocks.keys }));
vi.mock("../src/worker/native-staff-identity", () => ({ resolveNativeStaffIdentityWithAdmissionVersion: mocks.identity }));
const origin = "https://ops-staging.ledgetopdroneservices.com", issuer = "https://ledgetoptechnologies.cloudflareaccess.com";
const audience = "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b";
let jwt: string;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true }), publicKey = await exportJWK(pair.publicKey); publicKey.kid = "staging-worker";
  mocks.keys.mockReturnValue(createLocalJWKSet({ keys: [publicKey] }));
  mocks.identity.mockImplementation(async (_db, input) => ({ identity: { kind: "native", staffId: "synthetic-staff", verifiedAccessSubject: input.verifiedAccessSubject,
    email: input.verifiedEmail, displayName: "Synthetic worker tester", profileVersion: 1 }, admissionVersion: 1 }));
  jwt = await new SignJWT({ type: "app", email: "synthetic@example.invalid" }).setProtectedHeader({ alg: "RS256", kid: publicKey.kid })
    .setIssuer(issuer).setSubject("access|synthetic").setAudience(audience).setIssuedAt(Math.floor(Date.now() / 1000) - 1).setExpirationTime("1h").sign(pair.privateKey);
});
function setup(enabled = true) {
  const query = vi.fn(async () => ({ success: true, results: [] }));
  const fetch = vi.fn(async () => new Response("legacy", { status: 418 })), scheduled = vi.fn(), queue = vi.fn();
  const env = { ENVIRONMENT: "staging", PUBLIC_BASE_URL: origin, EXPECTED_HOST: new URL(origin).host, TEAM_DOMAIN: issuer, OPERATIONS_AUD: audience,
    WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64url"), WINDOWS_EMPLOYEE_HANDLE_KEY: Buffer.alloc(32, 2).toString("base64url"), WINDOWS_EMPLOYEE_QUEUE_KEY: Buffer.alloc(32, 3).toString("base64url"),
    OPS_DB: { withSession: () => ({ prepare: () => ({ bind: () => ({ all: query, first: async () => ({ id: "synthetic-staff" }) }) }) }) } };
  const profile = { enabled, gateway: { origin: "https://synthetic-files-staging.ledgetopdroneservices.com", gatewayId: "00000000-0000-4000-8000-000000000001", keyId: "synthetic" } };
  const worker = createWindowsEmployeeStagingWorker(profile, { fetch, scheduled, queue });
  const call = (path: string, method = "GET", assertion?: string) => worker.fetch(new Request(origin + path, { method, headers: assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {} }), env as never, {} as ExecutionContext);
  return { worker, profile, env, fetch, scheduled, queue, query, call };
}
describe("generated staging Ops main composition", () => {
  it("dispatches actual signed-human roots route and preserves background handlers/fallback", async () => {
    const h = setup();
    const response = await h.call("/api/staff/files/roots", "GET", jwt);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ schemaVersion: 1, roots: [] });
    expect(h.query).toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.call("/dashboard")).status).toBe(418);
    expect(h.worker.queue).toBe(h.queue); expect(h.worker.scheduled).toBe(h.scheduled);
  });
  it.each(["/api/staff/files", "/api/admin/employee-files"])("owns all verbs and unknown children of %s without denial fallback", async base => {
    const h = setup();
    for (const path of [base, base + "/", base + "/unknown"]) for (const method of ["GET", "POST", "HEAD", "OPTIONS"])
      expect((await h.call(path, method)).status).not.toBe(418);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
    for (const path of [base + "-other", base + "%2froots", base + "%252froots"]) expect(windowsEmployeeStagingPath(path)).toBe(false);
  });
  it.each(["", "short", "a".repeat(43), Buffer.alloc(31).toString("base64url"), Buffer.alloc(33).toString("base64url")])("refuses malformed dedicated key %s only on owned routes", async value => {
    const h = setup(); h.env.WINDOWS_EMPLOYEE_HANDLE_KEY = value;
    expect((await h.call("/api/staff/files/roots", "GET", jwt)).status).toBe(503);
    expect(h.query).not.toHaveBeenCalled(); expect((await h.call("/health")).status).toBe(418);
  });
  it("refuses key reuse, production configuration and post-construction enable mutation", async () => {
    const h = setup(); h.env.WINDOWS_EMPLOYEE_HANDLE_KEY = h.env.WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY;
    expect((await h.call("/api/staff/files/roots", "GET", jwt)).status).toBe(503);
    h.env.ENVIRONMENT = "production";
    expect((await h.call("/api/staff/files/roots", "GET", jwt)).status).toBe(503);
    const disabled = setup(false); disabled.profile.enabled = true;
    expect((await disabled.call("/api/staff/files/roots", "GET", jwt)).status).toBe(503);
    expect(disabled.query).not.toHaveBeenCalled();
  });
  it("preserves fallback rejection even when Windows keys are absent", async () => {
    const h = setup(); h.env.WINDOWS_EMPLOYEE_HANDLE_KEY = "";
    const failure = new Error("ordinary fallback error"); h.fetch.mockRejectedValue(failure);
    await expect(h.call("/dashboard")).rejects.toBe(failure);
    expect(h.query).not.toHaveBeenCalled();
  });
});
