import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWindowsEmployeeFilesStagingRouter, type WindowsEmployeeFilesStagingConfiguration } from "../src/worker/windows-files-staging";

const mocks = vi.hoisted(() => ({ keys: vi.fn(), identity: vi.fn(), roots: vi.fn(), resolve: vi.fn(), recheck: vi.fn(), provision: vi.fn(), audit: vi.fn() }));
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: mocks.keys }));
vi.mock("../src/worker/native-staff-identity", () => ({ resolveNativeStaffIdentityWithAdmissionVersion: mocks.identity }));
vi.mock("../src/worker/employee-read-authority", () => ({ listEmployeeReadRoots: mocks.roots, resolveEmployeeReadAuthority: mocks.resolve, recheckEmployeeReadAuthority: mocks.recheck }));
vi.mock("../src/worker/employee-read-provisioning", async () => ({ ...await vi.importActual<typeof import("../src/worker/employee-read-provisioning")>("../src/worker/employee-read-provisioning"), provisionEmployeeRead: mocks.provision, recordEmployeeContentStart: mocks.audit }));
const origin = "https://ops-staging.ledgetopdroneservices.com", issuer = "https://ledgetoptechnologies.cloudflareaccess.com", audience = "synthetic-staging-staff-audience";
// Illustrative admissible name only: no DNS lookup or network request is made.
const gatewayOrigin = "https://employee-files-staging.ledgetopdroneservices.com";
const gatewayId = "11111111-1111-4111-8111-111111111111", rootId = "22222222-2222-4222-8222-222222222222";
const config = (): WindowsEmployeeFilesStagingConfiguration => ({ environment: "staging", enabled: true, opsOrigin: origin,
  access: { enabled: true, issuer, staffAudience: audience },
  gateway: { origin: gatewayOrigin, gatewayId, keyId: "synthetic-staging", key: new Uint8Array(32).fill(1) },
  handleKey: new Uint8Array(32).fill(2), queueKey: new Uint8Array(32).fill(3) });
let pair: Awaited<ReturnType<typeof generateKeyPair>>, localKeys: ReturnType<typeof createLocalJWKSet>, token: string;
async function signed(claims: Record<string, unknown> = {}, aud: string | string[] = audience) {
  return new SignJWT({ type: "app", email: "synthetic@example.invalid", ...claims }).setProtectedHeader({ alg: "RS256", kid: "staging-test" })
    .setIssuer(issuer).setAudience(aud).setSubject("access|synthetic").setIssuedAt(Math.floor(Date.now() / 1000) - 1).setExpirationTime("1h").sign(pair.privateKey);
}
beforeAll(async () => {
  pair = await generateKeyPair("RS256", { extractable: true }); const jwk = await exportJWK(pair.publicKey); jwk.kid = "staging-test"; jwk.alg = "RS256";
  localKeys = createLocalJWKSet({ keys: [jwk] }); token = await signed();
});
beforeEach(() => {
  vi.resetAllMocks(); mocks.keys.mockReturnValue(localKeys);
  mocks.identity.mockImplementation(async (_db, input) => ({ identity: { kind: "native", staffId: "staff:synthetic", verifiedAccessSubject: input.verifiedAccessSubject,
    email: input.verifiedEmail, displayName: "Synthetic tester", profileVersion: 1 }, admissionVersion: 1 }));
  mocks.roots.mockResolvedValue([{ rootId, gatewayId, displayName: "Synthetic only" }, { rootId, gatewayId: "33333333-3333-4333-8333-333333333333", displayName: "Other gateway" }]);
  mocks.resolve.mockResolvedValue({ gatewayId, rootId, rootGeneration: 1, rootFingerprint: "a".repeat(64), staffId: "staff:synthetic", accessSubject: "access|synthetic",
    admissionVersion: 1, profileVersion: 1, grantId: "44444444-4444-4444-8444-444444444444", grantGeneration: 1, verifiedUntil: new Date(Date.now() + 3600000).toISOString() });
  mocks.recheck.mockResolvedValue(true); mocks.audit.mockResolvedValue(undefined); mocks.provision.mockResolvedValue({ schemaVersion: 1, commandId: "55555555-5555-4555-8555-555555555555", kind: "register-root", rootId, grantId: null, generation: 1 });
});
function harness(input = config()) {
  const withSession = vi.fn(() => { throw Error("unexpected database access"); });
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.operation === "manifest") return Response.json({ schemaVersion: 1, sha256: "a".repeat(64), size: 3, etag: '"' + "a".repeat(64) + '"',
      snapshotId: "66666666-6666-4666-8666-666666666666", snapshotExpiresAt: Math.floor(Date.now() / 1000) + 1800 });
    if (body.operation === "content") return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "application/octet-stream", "Content-Length": "3", ETag: '"' + "a".repeat(64) + '"' } });
    return Response.json({ schemaVersion: 1, entries: [], nextCursor: null });
  });
  const database = { withSession } as unknown as D1Database;
  const router = createWindowsEmployeeFilesStagingRouter(input, { database, fetch: fetcher as typeof fetch });
  const call = (path: string, options: RequestInit = {}, assertion: string | null = token, requestOrigin = origin) => router.fetch(new Request(requestOrigin + path, { ...options,
    headers: { ...(assertion === null ? {} : { "Cf-Access-Jwt-Assertion": assertion }), ...Object.fromEntries(new Headers(options.headers)) } }));
  return { router, call, database, withSession, fetcher };
}
describe("unmounted Windows employee staging composition", () => {
  it("composes actual human read, queue and admin routes without provisioning during discovery", async () => {
    const h = harness();
    const roots = await h.call("/api/staff/files/roots"); expect(roots.status).toBe(200);
    expect(await roots.json()).toEqual({ schemaVersion: 1, roots: [{ rootId, gatewayId, displayName: "Synthetic only" }] });
    const session = await h.call("/api/staff/files/queue/session"); expect(session.status).toBe(200);
    const body = await session.json() as { principalId: string }; expect(body.principalId).toMatch(/^odqp1_[0-9a-f]{64}$/u);
    const reference = await h.call(`/api/staff/files/queue/reference?rootId=${rootId}&path=synthetic.bin`); expect(reference.status).toBe(200);
    expect(await reference.json()).toMatchObject({ principalId: body.principalId, resourceRef: expect.stringMatching(/^odqr1_/u) });
    expect(mocks.provision).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled();
    const command = { commandId: "55555555-5555-4555-8555-555555555555", kind: "register-root", rootId, gatewayId, rootFingerprint: "b".repeat(64), displayName: "Synthetic only" };
    const admin = await h.call("/api/admin/employee-files/commands", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(command) });
    expect(admin.status).toBe(200); expect(mocks.provision).toHaveBeenCalledWith(h.database, expect.objectContaining({ admissionVersion: 1 }), command, { gatewayIds: [gatewayId] });
    expect((await h.call("/unrelated")).status).toBe(404);
  });
  it.each(["missing", "machine", "multi-audience", "wrong-audience", "tampered"])("retains real signed human admission on all routes: %s", async kind => {
    const assertion = kind === "missing" ? null : kind === "machine" ? await signed({ service_token_id: "machine" })
      : kind === "multi-audience" ? await signed({}, [audience, "other-audience"]) : kind === "wrong-audience" ? await signed({}, "other-audience") : token.slice(0, -5) + "AAAAA";
    const h = harness();
    for (const path of ["/api/staff/files/roots", "/api/staff/files/queue/session"]) expect((await h.call(path, {}, assertion)).status).toBe(401);
    expect((await h.call("/api/admin/employee-files/commands", { method: "POST", headers: { Origin: origin } }, assertion)).status).toBe(401);
    expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.roots).not.toHaveBeenCalled(); expect(mocks.provision).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled();
  });
  const invalid = [
    ["disabled", (c: any) => { c.enabled = false; }], ["string enabled", (c: any) => { c.enabled = "true"; }],
    ["production environment", (c: any) => { c.environment = "production"; }], ["production Ops", (c: any) => { c.opsOrigin = "https://ops.ledgetopdroneservices.com"; }],
    ["Ops slash alias", (c: any) => { c.opsOrigin += "/"; }], ["unknown config", (c: any) => { c.extra = true; }],
    ["production gateway", (c: any) => { c.gateway.origin = "https://employee-files.ledgetopdroneservices.com"; }],
    ["gateway foreign domain", (c: any) => { c.gateway.origin = "https://staging.attacker.invalid"; }],
    ["gateway port", (c: any) => { c.gateway.origin += ":8443"; }], ["gateway HTTP", (c: any) => { c.gateway.origin = "http://employee-files-staging.ledgetopdroneservices.com"; }],
    ["gateway path", (c: any) => { c.gateway.origin += "/v1/read"; }], ["gateway Ops loop", (c: any) => { c.gateway.origin = origin; }],
    ["gateway identifier", (c: any) => { c.gateway.gatewayId = "not-a-uuid"; }], ["key identifier", (c: any) => { c.gateway.keyId = "unsafe key"; }],
    ["foreign issuer", (c: any) => { c.access.issuer = "https://other.cloudflareaccess.com"; }], ["disabled identity", (c: any) => { c.access.enabled = false; }],
    ["unknown access option", (c: any) => { c.access.bypass = true; }], ["unknown gateway option", (c: any) => { c.gateway.extra = true; }],
    ["string identity enabled", (c: any) => { c.access.enabled = "true"; }], ["invalid audience", (c: any) => { c.access.staffAudience = "short"; }],
    ["production staff audience", (c: any) => { c.access.staffAudience = "d09e298c864b9c8f4491b4b42a4dbe2ecbf558b5868d18258443740e56032407"; }],
    ["short key", (c: any) => { c.queueKey = new Uint8Array(31); }], ["oversized key", (c: any) => { c.gateway.key = new Uint8Array(129); }],
    ["array key", (c: any) => { c.handleKey = Array(32).fill(7); }],
    ["gateway/handle reuse", (c: any) => { c.handleKey = new Uint8Array(c.gateway.key); }],
    ["gateway/queue reuse", (c: any) => { c.queueKey = new Uint8Array(c.gateway.key); }],
    ["handle/queue reuse", (c: any) => { c.queueKey = new Uint8Array(c.handleKey); }],
  ] as const;
  it.each(invalid)("fails closed before authentication, database or backend for %s", async (_label, mutate) => {
    const cfg = config(); mutate(cfg); const h = harness(cfg);
    for (const path of ["/api/staff/files/roots", "/api/staff/files/queue/session", "/api/admin/employee-files/commands"]) {
      const response = await h.call(path, path.includes("admin") ? { method: "POST", headers: { Origin: origin } } : {});
      expect(response.status).toBe(503); expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(await response.json()).toEqual({ error: "windows_files_unavailable" });
    }
    expect(h.withSession).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled(); expect(mocks.keys).not.toHaveBeenCalled(); expect(mocks.identity).not.toHaveBeenCalled();
  });
  it("rejects mismatched request hosts and browser origins before identity resolution", async () => {
    const h = harness();
    for (const path of ["/api/staff/files/roots", "/api/staff/files/queue/session"]) {
      expect((await h.call(path, {}, token, "https://ops.ledgetopdroneservices.com")).status).toBe(403);
      expect((await h.call(path, { headers: { Origin: "https://other.invalid" } })).status).toBe(403);
      expect((await h.call(path, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    }
    expect((await h.call("/api/admin/employee-files/commands", { method: "POST", headers: { Origin: origin } }, token, "https://ops.ledgetopdroneservices.com")).status).toBe(403);
    expect(mocks.identity).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("refuses missing D1 and invalid transport dependencies before authentication", async () => {
    for (const dependencies of [{ database: {} }, { database: { withSession() {} }, fetch: "fetch" }]) {
      const router = createWindowsEmployeeFilesStagingRouter(config(), dependencies as any);
      expect((await router.fetch(new Request(origin + "/api/staff/files/queue/session", { headers: { "Cf-Access-Jwt-Assertion": token } }))).status).toBe(503);
    }
    expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.keys).not.toHaveBeenCalled();
  });
  it("copies configuration and key bytes before caller mutations", async () => {
    const cfg = config(), h = harness(cfg);
    const first = await h.call(`/api/staff/files/queue/reference?rootId=${rootId}&path=synthetic.bin`); expect(first.status).toBe(200);
    const reference = await first.json() as { resourceRef: string; principalId: string };
    cfg.gateway.key.fill(8); cfg.handleKey.fill(8); cfg.queueKey.fill(8);
    Object.assign(cfg, { enabled: false, opsOrigin: "https://ops.ledgetopdroneservices.com" });
    Object.assign(cfg.access, { enabled: false, issuer: "https://other.cloudflareaccess.com", staffAudience: "other-staging-audience" });
    Object.assign(cfg.gateway, { gatewayId: rootId, origin: "https://production.invalid" });
    expect((await h.call("/api/staff/files/queue/session")).status).toBe(200);
    const entries = await h.call(`/api/staff/files/roots/${rootId}/entries?path=`); expect(entries.status).toBe(200);
    expect(h.fetcher.mock.calls[0]![0]).toBe(gatewayOrigin + "/v1/read");
    const init = h.fetcher.mock.calls[0]![1]!, headers = new Headers(init.headers), encoder = new TextEncoder();
    const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
    const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(String(init.body))));
    const material = ["ops-employee-read-v1", gatewayId, "synthetic-staging", headers.get("X-Ops-Read-Time"), headers.get("X-Ops-Read-Nonce"), "POST", "/v1/read", digest].join("\n");
    const originalSigningKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(1), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    expect(headers.get("X-Ops-Read-Signature")).toBe(hex(await crypto.subtle.sign("HMAC", originalSigningKey, encoder.encode(material))));
    // The encrypted original reference still decrypts with the captured queue key.
    const resolved = await h.call("/api/staff/files/queue/resolve?resourceRef=" + encodeURIComponent(reference.resourceRef));
    expect(resolved.status).toBe(200);
    const descriptor = await resolved.json() as { manifest: { downloadPath: string; strongETag: string } };
    const download = await h.call(descriptor.manifest.downloadPath, { headers: { "If-Match": descriptor.manifest.strongETag } });
    expect(download.status).toBe(200); expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.resolve.mock.calls.length).toBeGreaterThan(1);
  });
});
