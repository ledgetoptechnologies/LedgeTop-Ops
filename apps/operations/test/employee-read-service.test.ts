import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAuthenticatedEmployeeFile } from "../src/worker/employee-read-service";
import { signEmployeeReadBody, type EmployeeReadProof, type EmployeeReadSelection } from "../src/worker/employee-read-transport";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), resolve: vi.fn(), recheck: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.authenticate }));
vi.mock("../src/worker/employee-read-authority", () => ({ resolveEmployeeReadAuthority: mocks.resolve, recheckEmployeeReadAuthority: mocks.recheck }));

const gatewayId = "11111111-1111-4111-8111-111111111111", rootId = "22222222-2222-4222-8222-222222222222";
const sha = "a".repeat(64), database = {} as D1Database;
function authenticated(): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId: "staff:synthetic", verifiedAccessSubject: "access|synthetic", email: "synthetic@example.invalid",
    displayName: "Synthetic employee", profileVersion: 3 }, admissionVersion: 4, verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() };
}
function authority(): EmployeeReadProof {
  return { gatewayId, rootId, rootGeneration: 5, rootFingerprint: "b".repeat(64), staffId: "staff:synthetic",
    accessSubject: "access|synthetic", admissionVersion: 4, profileVersion: 3,
    grantId: "33333333-3333-4333-8333-333333333333", grantGeneration: 6, verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() };
}
function configuration() { return { enabled: true, access: { enabled: true, issuer: "https://synthetic.cloudflareaccess.com", staffAudience: "synthetic-staff-audience-only" },
  gateway: { origin: "https://gateway.example.test", gatewayId, keyId: "synthetic-key", key: new Uint8Array(32).fill(0x31) } }; }
const manifestSelection = (): EmployeeReadSelection => ({ operation: "manifest", path: "photos/map.raw", expectedSha256: null, range: null });
const contentSelection = (): EmployeeReadSelection => ({ operation: "content", path: "photos/map.raw", expectedSha256: sha, range: null });
const request = (init: RequestInit = {}) => new Request("https://ops.example.test/api/unmounted-employee-read", init);
function content() {
  const cancel = vi.fn(); let emitted = false;
  return { cancel, response: new Response(new ReadableStream<Uint8Array>({ pull(c) {
    if (emitted) c.close(); else { emitted = true; c.enqueue(new Uint8Array([1, 2, 3])); }
  }, cancel }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/octet-stream", "Content-Length": "3", ETag: `"${sha}"` } }) };
}
function dependencies(response = Response.json({ schemaVersion: 1, sha256: sha, size: 3, etag: `"${sha}"` })) {
  return { fetch: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response),
    auditContentStart: vi.fn(async (_proof: EmployeeReadProof, _selection: EmployeeReadSelection) => undefined) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); mocks.authenticate.mockResolvedValue(authenticated()); mocks.resolve.mockResolvedValue(authority()); mocks.recheck.mockResolvedValue(true); });

describe("unmounted authenticated employee read service", () => {
  it("stays disabled before authentication or backend access", async () => {
    const deps = dependencies();
    const result = await readAuthenticatedEmployeeFile(request(), database, rootId, manifestSelection(), { ...configuration(), enabled: false }, deps);
    expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: "employee_read_disabled" });
    expect(mocks.authenticate).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each(["POST", "HEAD", "PUT"])("rejects unsupported method %s without authenticating", async method => {
    const deps = dependencies();
    expect((await readAuthenticatedEmployeeFile(request({ method }), database, rootId, manifestSelection(), configuration(), deps)).status).toBe(403);
    expect(mocks.authenticate).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("fails closed on native authentication failure without leaking its diagnostic", async () => {
    mocks.authenticate.mockRejectedValueOnce(Error("synthetic private diagnostic, not a real token")); const deps = dependencies();
    const result = await readAuthenticatedEmployeeFile(request(), database, rootId, manifestSelection(), configuration(), deps);
    expect(result.status).toBe(403); expect(await result.text()).toBe('{"error":"employee_read_denied"}');
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each([null, { ...authority(), gatewayId: "44444444-4444-4444-8444-444444444444" }])("rejects missing grant or wrong gateway authority", async proof => {
    mocks.resolve.mockResolvedValueOnce(proof); const deps = dependencies();
    expect((await readAuthenticatedEmployeeFile(request(), database, rootId, manifestSelection(), configuration(), deps)).status).toBe(403);
    expect(mocks.authenticate).toHaveBeenCalledOnce(); expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("joins native authentication, selected root and full fresh proof rechecks with the actual transport", async () => {
    const person = authenticated(), proof = authority(), req = request(), cfg = configuration(), deps = dependencies();
    mocks.authenticate.mockResolvedValueOnce(person); mocks.resolve.mockResolvedValueOnce(proof);
    const result = await readAuthenticatedEmployeeFile(req, database, rootId, manifestSelection(), cfg, deps);
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ sha256: sha });
    expect(mocks.authenticate).toHaveBeenCalledWith(req, database, cfg.access);
    expect(mocks.resolve).toHaveBeenCalledWith(database, person, rootId);
    expect(mocks.recheck.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const args of mocks.recheck.mock.calls) expect(args).toEqual([database, proof]);
    expect(deps.fetch.mock.calls[0]![0]).toBe("https://gateway.example.test/v1/read");
    expect(deps.auditContentStart).not.toHaveBeenCalled();
  });
  it("passes mandatory content audit the exact full proof and selection before bytes", async () => {
    const source = content(), deps = dependencies(source.response), proof = authority(), selected = contentSelection();
    mocks.resolve.mockResolvedValueOnce(proof);
    const result = await readAuthenticatedEmployeeFile(request(), database, rootId, selected, configuration(), deps);
    expect(deps.auditContentStart).toHaveBeenCalledWith(proof, selected);
    expect(result.status).toBe(200); expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(mocks.recheck.mock.calls.at(-1)).toEqual([database, proof]);
  });
  it("cancels the acquired body if the real authority recheck callback denies after fetch", async () => {
    const source = content(), deps = dependencies(source.response);
    deps.fetch.mockImplementationOnce(async () => { mocks.recheck.mockResolvedValue(false); return source.response; });
    expect((await readAuthenticatedEmployeeFile(request(), database, rootId, contentSelection(), configuration(), deps)).status).toBe(403);
    expect(source.cancel).toHaveBeenCalledOnce(); expect(deps.auditContentStart).not.toHaveBeenCalled();
  });
  it("requires successful auditing and rejects missing audit sink at runtime", async () => {
    for (const missing of [false, true]) {
      const source = content(), deps = dependencies(source.response);
      deps.auditContentStart.mockRejectedValue(Error("synthetic audit unavailable"));
      const wired = missing ? { fetch: deps.fetch } as unknown as Parameters<typeof readAuthenticatedEmployeeFile>[5] : deps;
      const result = await readAuthenticatedEmployeeFile(request(), database, rootId, contentSelection(), configuration(), wired);
      expect(result.status).toBe(502); expect(source.cancel).toHaveBeenCalledOnce();
    }
  });
  it("copies access settings, gateway key and nested selection before authentication awaits", async () => {
    const gate = deferred<AuthenticatedNativeStaffWithAdmissionVersion>(), cfg = configuration(), originalKey = new Uint8Array(cfg.gateway.key);
    const selected = { operation: "content" as const, path: "photos/map.raw", expectedSha256: sha, range: { start: 0, end: 2 } };
    const deps = dependencies(new Response(new Uint8Array([1, 2, 3]), { status: 206,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "3", ETag: `"${sha}"`, "Content-Range": "bytes 0-2/4" } }));
    mocks.authenticate.mockImplementationOnce(() => gate.promise);
    const result = readAuthenticatedEmployeeFile(request(), database, rootId, selected, cfg, deps);
    cfg.access.issuer = "https://changed.cloudflareaccess.com"; cfg.access.staffAudience = "changed-audience";
    cfg.gateway.origin = "https://changed.example.test"; cfg.gateway.key.fill(0xff); selected.path = "changed.raw"; selected.range.end = 99;
    gate.resolve(authenticated());
    const response = await result; expect(response.status).toBe(206); await response.arrayBuffer();
    expect(mocks.authenticate.mock.calls[0]![2]).toMatchObject({ issuer: "https://synthetic.cloudflareaccess.com", staffAudience: "synthetic-staff-audience-only" });
    const [url, init] = deps.fetch.mock.calls[0]!, body = String(init!.body), headers = new Headers(init!.headers);
    expect(url).toBe("https://gateway.example.test/v1/read");
    expect(JSON.parse(body)).toMatchObject({ path: "photos/map.raw", range: { start: 0, end: 2 } });
    expect(headers.get("X-Ops-Read-Signature")).toBe(await signEmployeeReadBody(body, { ...cfg.gateway, key: originalKey },
      Number(headers.get("X-Ops-Read-Time")), headers.get("X-Ops-Read-Nonce")!));
  });
  it("propagates Request.signal cancellation during backend fetch and discards the acquired body", async () => {
    const source = content(), deps = dependencies(source.response), entered = deferred<void>(), release = deferred<Response>(), controller = new AbortController();
    let backendSignal: AbortSignal | null | undefined;
    deps.fetch.mockImplementationOnce(async (_url, init) => { backendSignal = init?.signal; entered.resolve(); return release.promise; });
    const pending = readAuthenticatedEmployeeFile(request({ signal: controller.signal }), database, rootId, contentSelection(), configuration(), deps);
    await entered.promise; controller.abort(); release.resolve(source.response);
    expect((await pending).status).toBe(403); expect(backendSignal?.aborted).toBe(true);
    expect(source.cancel).toHaveBeenCalledOnce(); expect(deps.auditContentStart).not.toHaveBeenCalled();
  });
  it("does not reach the backend when Request.signal was already aborted", async () => {
    const controller = new AbortController(); controller.abort(); const deps = dependencies();
    expect((await readAuthenticatedEmployeeFile(request({ signal: controller.signal }), database, rootId, manifestSelection(), configuration(), deps)).status).toBe(403);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
