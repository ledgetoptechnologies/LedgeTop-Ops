import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createEmployeeReadRouter, employeeWindowsFileName } from "../src/worker/employee-read-routes";
import type { EmployeeReadProof } from "../src/worker/employee-read-transport";

const mocks = vi.hoisted(() => ({ keys: vi.fn(), identity: vi.fn(), resolve: vi.fn(), recheck: vi.fn(), roots: vi.fn(), audit: vi.fn() }));
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: mocks.keys }));
vi.mock("../src/worker/native-staff-identity", () => ({ resolveNativeStaffIdentityWithAdmissionVersion: mocks.identity }));
vi.mock("../src/worker/employee-read-authority", () => ({ resolveEmployeeReadAuthority: mocks.resolve, recheckEmployeeReadAuthority: mocks.recheck, listEmployeeReadRoots: mocks.roots }));
vi.mock("../src/worker/employee-read-provisioning", () => ({ recordEmployeeContentStart: mocks.audit }));
const origin = "https://ops.example.test", issuer = "https://synthetic.cloudflareaccess.com", audience = "synthetic-staff-audience";
const rootId = "22222222-2222-4222-8222-222222222222", gatewayId = "11111111-1111-4111-8111-111111111111", sha = "a".repeat(64);
const snapshotId = "44444444-4444-4444-8444-444444444444", base = "/api/staff/files";
const config = () => ({ enabled: true, opsOrigin: origin, access: { enabled: true, issuer, staffAudience: audience },
  gateway: { origin: "https://gateway.example.test", gatewayId, keyId: "synthetic-key", key: new Uint8Array(32).fill(0x31) }, handleKey: new Uint8Array(32).fill(0x32) });
const proof = (): EmployeeReadProof => ({ gatewayId, rootId, rootGeneration: 1, rootFingerprint: "b".repeat(64), staffId: "staff:synthetic",
  accessSubject: "access|synthetic", admissionVersion: 2, profileVersion: 3, grantId: "33333333-3333-4333-8333-333333333333", grantGeneration: 4,
  verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() });
let pair: Awaited<ReturnType<typeof generateKeyPair>>, localKeys: ReturnType<typeof createLocalJWKSet>, token: string;
async function signed(claims: Record<string, unknown> = {}, aud: string | string[] = audience, iss = issuer) {
  return new SignJWT({ type: "app", email: "synthetic@example.invalid", ...claims }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
    .setIssuer(iss).setAudience(aud).setSubject(String(claims.sub ?? "access|synthetic")).setIssuedAt(Math.floor(Date.now() / 1000) - 1).setExpirationTime("1h").sign(pair.privateKey);
}
beforeAll(async () => { pair = await generateKeyPair("RS256", { extractable: true }); const key = await exportJWK(pair.publicKey); key.kid = "synthetic"; key.alg = "RS256"; localKeys = createLocalJWKSet({ keys: [key] }); token = await signed(); });
beforeEach(() => {
  vi.resetAllMocks(); mocks.keys.mockReturnValue(localKeys);
  mocks.identity.mockImplementation(async (_db, input) => ({ identity: { kind: "native", staffId: input.verifiedAccessSubject === "access|synthetic" ? "staff:synthetic" : "staff:other",
    verifiedAccessSubject: input.verifiedAccessSubject, email: input.verifiedEmail, displayName: "Synthetic employee", profileVersion: 3 }, admissionVersion: 2 }));
  mocks.resolve.mockResolvedValue(proof()); mocks.recheck.mockResolvedValue(true); mocks.audit.mockResolvedValue(undefined);
  mocks.roots.mockResolvedValue([{ rootId, gatewayId, displayName: "Synthetic files" }]);
});
function harness() {
  const cancel = vi.fn();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.operation === "manifest") return Response.json({ schemaVersion: 1, sha256: sha, size: 3, etag: `"${sha}"`, snapshotId, snapshotExpiresAt: Math.floor(Date.now() / 1000) + 1800 });
    if (body.operation === "list") return Response.json({ schemaVersion: 1, entries: [{ name: "photo.raw", kind: "file" }], nextCursor: null });
    const range = body.range as { start: number; end: number } | null, length = range ? range.end - range.start + 1 : 3;
    let sent = false;
    return new Response(new ReadableStream({ pull(c) { if (sent) c.close(); else { sent = true; c.enqueue(new Uint8Array(length).fill(7)); } }, cancel }, { highWaterMark: 0 }),
      { status: range ? 206 : 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(length), ETag: `"${sha}"`, ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/3` } : {}) } });
  });
  const cfg = config(), router = createEmployeeReadRouter(cfg, { database: {} as D1Database, fetch: fetcher as typeof fetch });
  const call = (path: string, headers: Record<string, string> = {}, method = "GET", assertion = token) => router.fetch(new Request(origin + path, { method, headers: { "Cf-Access-Jwt-Assertion": assertion, ...headers } }));
  const manifest = async () => { const response = await call(`${base}/roots/${rootId}/manifest?path=photos%2FMap+01.raw`); expect(response.status).toBe(200); return await response.json() as { downloadPath: string; strongETag: string; expiresAt: number; logicalFileId: string; name: string; remoteVersion: string }; };
  return { fetcher, cancel, cfg, router, call, manifest };
}
describe("unmounted employee read HTTP factory with real RS256 verification", () => {
  it("discovers only authorized labeled roots and never provisions a grant", async () => {
    const h = harness(), response = await h.call(base + "/roots");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ schemaVersion: 1, roots: [{ rootId, gatewayId, displayName: "Synthetic files" }] });
    expect(response.headers.get("Cache-Control")).toContain("no-store"); expect(h.fetcher).not.toHaveBeenCalled();
    expect((await h.call("/api/admin/employee-files/commands", {}, "POST")).status).toBe(404);
  });
  it.each(["machine", "multi-audience", "wrong-audience", "wrong-issuer", "tampered"])("rejects %s Access assertion before grant resolution", async kind => {
    const h = harness(); let assertion = token;
    if (kind === "machine") assertion = await signed({ service_token_id: "synthetic-machine" });
    if (kind === "multi-audience") assertion = await signed({}, [audience, "another-audience"]);
    if (kind === "wrong-audience") assertion = await signed({}, "another-staff-audience");
    if (kind === "wrong-issuer") assertion = await signed({}, audience, "https://other.cloudflareaccess.com");
    if (kind === "tampered") assertion = token.slice(0, -5) + "aaaaa";
    expect((await h.call(base + "/roots", {}, "GET", assertion)).status).toBe(401); expect(mocks.resolve).not.toHaveBeenCalled(); expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("fails disabled configuration and denies cross-origin browser requests before authentication", async () => {
    const h = harness();
    const disabled = createEmployeeReadRouter({ ...config(), enabled: false }, { database: {} as D1Database });
    expect((await disabled.fetch(new Request(origin + base + "/roots"))).status).toBe(503);
    const browserHeaders: Record<string, string>[] = [{ Origin: "https://evil.example.test" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of browserHeaders)
      expect((await h.call(base + "/roots", headers)).status).toBe(403);
    expect((await h.router.fetch(new Request("https://other.example.test" + base + "/roots"))).status).toBe(403);
    expect(mocks.identity).not.toHaveBeenCalled();
  });
  it.each(["", "?path=a&path=b", "?path=a&%70ath=b", "?path=a&unknown=1", "?path=%ZZ", "?path=%2e%2e%2fsecret", "?path=%252e%252e", "?path=a%5Cb", "?path=a&cursor=bad%2Fcursor"])("rejects ambiguous or unsafe query %s", async suffix => {
    const h = harness(); expect((await h.call(`${base}/roots/${rootId}/entries${suffix}`)).status).toBe(400); expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("decodes a canonical path exactly once and forwards only signed private selectors", async () => {
    const h = harness(), response = await h.call(`${base}/roots/${rootId}/entries?path=photos%2FMap+01&cursor=page.v1_next`);
    expect(response.status).toBe(200);
    const init = h.fetcher.mock.calls[0]![1]!; expect(JSON.parse(String(init.body))).toMatchObject({ path: "photos/Map 01", cursor: "page.v1_next", operation: "list" });
    expect(new Headers(init.headers).has("Cf-Access-Jwt-Assertion")).toBe(false);
  });
  it("mints the exact public descriptor without private paths or gateway URLs", async () => {
    const h = harness(), body = await h.manifest();
    expect(Object.keys(body).sort()).toEqual(["schemaVersion", "logicalFileId", "remoteVersion", "strongETag", "size", "sha256", "name", "downloadPath", "expiresAt"].sort());
    expect(body.logicalFileId).toMatch(/^oef1_[a-f0-9]{64}$/u); expect(body.remoteVersion).toBe(sha); expect(body.name).toBe("Map 01.raw");
    expect(body.downloadPath).toMatch(/^\/api\/staff\/files\/downloads\/eof1_[A-Za-z0-9_-]+$/u);
    expect(JSON.stringify(body)).not.toContain("gateway.example.test"); expect(JSON.stringify(body)).not.toContain("photos/");
    expect(body.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("snapshots deployment keys and origins when the unmounted factory is constructed", async () => {
    const h = harness(); h.cfg.access.issuer = "https://changed.cloudflareaccess.com"; h.cfg.access.staffAudience = "changed-audience";
    h.cfg.gateway.origin = "https://changed.example.test"; h.cfg.gateway.key.fill(0xff); h.cfg.handleKey.fill(0xee);
    const body = await h.manifest(), response = await h.call(body.downloadPath, { "If-Match": body.strongETag });
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer()).length).toBe(3);
    expect(h.fetcher.mock.calls.every(([url]) => url === "https://gateway.example.test/v1/read")).toBe(true);
  });
  it("rejects an expired file handle without backend content reads", async () => {
    const h = harness(), body = await h.manifest(); h.fetcher.mockClear();
    const clock = vi.spyOn(Date, "now").mockReturnValue((body.expiresAt + 1) * 1000);
    try { expect((await h.call(body.downloadPath, { "If-Match": body.strongETag })).status).toBe(404); }
    finally { clock.mockRestore(); }
    expect(h.fetcher).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("refuses a prepared snapshot whose remaining lifetime is unusable after the clock margin", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json({ schemaVersion: 1, sha256: sha, size: 3, etag: `"${sha}"`, snapshotId, snapshotExpiresAt: Math.floor(Date.now() / 1000) + 30 }));
    expect((await h.call(`${base}/roots/${rootId}/manifest?path=photo.raw`)).status).toBe(409);
  });
  it.each([undefined, '"other"', `W/"${sha}"`, "*"])("requires exact If-Match %s before content/audit", async etag => {
    const h = harness(), body = await h.manifest(); h.fetcher.mockClear();
    expect((await h.call(body.downloadPath, etag === undefined ? {} : { "If-Match": etag })).status).toBe(412);
    expect(h.fetcher).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["bytes=0-1", "bytes=1-"])("resolves and audits inclusive range %s against pinned total", async requested => {
    const h = harness(), body = await h.manifest(), response = await h.call(body.downloadPath, { "If-Match": body.strongETag, Range: requested });
    expect(response.status).toBe(206); expect(response.headers.get("Content-Range")).toBe(requested === "bytes=0-1" ? "bytes 0-1/3" : "bytes 1-2/3");
    expect(new Uint8Array(await response.arrayBuffer()).length).toBe(2); expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.resolve.mock.calls.at(-1)?.[3]).toBe("33333333-3333-4333-8333-333333333333");
  });
  it.each(["bytes=-1", "bytes=01-2", "bytes=0-3", "bytes=2-1", "bytes=0-1,2-2", "items=0-1", "bytes=0-9007199254740992"])("rejects unsupported range %s before content", async requested => {
    const h = harness(), body = await h.manifest(); h.fetcher.mockClear();
    expect((await h.call(body.downloadPath, { "If-Match": body.strongETag, Range: requested })).status).toBe(416);
    expect(h.fetcher).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("requires current exact grant/root/profile and refuses another authenticated human", async () => {
    const h = harness(), body = await h.manifest(); h.fetcher.mockClear();
    expect((await h.call(body.downloadPath, { "If-Match": body.strongETag }, "GET", await signed({ sub: "access|other" }))).status).toBe(403);
    for (const change of [{ rootGeneration: 2 }, { grantGeneration: 5 }, { profileVersion: 4 },
      { grantId: "55555555-5555-4555-8555-555555555555" }, { rootId: "66666666-6666-4666-8666-666666666666" }]) {
      mocks.resolve.mockResolvedValue({ ...proof(), ...change });
      expect((await h.call(body.downloadPath, { "If-Match": body.strongETag })).status).toBe(403);
    }
    mocks.resolve.mockResolvedValue(null); expect((await h.call(body.downloadPath, { "If-Match": body.strongETag })).status).toBe(403);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("cancels bytes on audit failure or revocation during fetch", async () => {
    for (const failure of ["audit", "revocation"]) {
      const h = harness(), body = await h.manifest();
      if (failure === "audit") mocks.audit.mockRejectedValueOnce(Error("private audit failure"));
      else { const original = h.fetcher.getMockImplementation()!; h.fetcher.mockImplementationOnce(async (url, init) => { const response = await original(url, init); mocks.recheck.mockResolvedValue(false); return response; }); }
      const response = await h.call(body.downloadPath, { "If-Match": body.strongETag });
      expect(response.status).toBe(failure === "audit" ? 502 : 403); expect(h.cancel).toHaveBeenCalledOnce();
      expect(await response.text()).not.toContain("private audit"); mocks.recheck.mockResolvedValue(true);
    }
  });
  it("denies changed total length even when a private response has a valid range shape", async () => {
    const h = harness(), body = await h.manifest();
    h.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: h.cancel }), { status: 206, headers: {
      "Content-Type": "application/octet-stream", "Content-Length": "2", "Content-Range": "bytes 0-1/4", ETag: `"${sha}"` } }));
    const response = await h.call(body.downloadPath, { "If-Match": body.strongETag, Range: "bytes=0-1" });
    expect(response.status).toBe(503); expect(h.cancel).toHaveBeenCalledOnce();
  });
  it("cancels the validated transport stream when authority changes at the final route handoff", async () => {
    const h = harness(), body = await h.manifest();
    mocks.audit.mockImplementationOnce(async () => {
      mocks.recheck.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    });
    const response = await h.call(body.downloadPath, { "If-Match": body.strongETag });
    expect(response.status).toBe(403); expect(h.cancel).toHaveBeenCalledOnce();
  });
  it.each(["CON.txt", "CONIN$", "LPT².map", ".LTDS-DOWNLOADS-V1", "a".repeat(149) + "😀.raw"])("produces a bounded safe Windows basename from %s", name => {
    const result = employeeWindowsFileName(name); expect(result.length).toBeLessThanOrEqual(150); expect(result).not.toMatch(/[. ]$/u);
    if (name.length < 150) expect(result.startsWith("_")).toBe(true);
  });
});
