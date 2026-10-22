import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalEmployeeReadPath, readEmployeeGateway, signEmployeeReadBody,
  type EmployeeGatewayConfiguration, type EmployeeReadProof, type EmployeeReadSelection } from "../src/worker/employee-read-transport";

const gateway = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const proof = () => ({ gatewayId: gateway, rootId: "22222222-2222-4222-8222-222222222222",
  rootGeneration: 3, rootFingerprint: "b".repeat(64), staffId: "staff:synthetic", accessSubject: "access|synthetic",
  admissionVersion: 4, profileVersion: 5, grantId: "33333333-3333-4333-8333-333333333333",
  grantGeneration: 6, verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() });
const config = (): EmployeeGatewayConfiguration => ({ origin: "https://private-gateway.example.test", gatewayId: gateway,
  keyId: "employee-v1", key: new Uint8Array(32).fill(0x31) });
const selection = (operation: "list" | "manifest" | "content" = "content"): EmployeeReadSelection => ({ operation,
  path: operation === "list" ? "" : "photos/image.raw", expectedSha256: operation === "content" ? sha : null, range: null });
const manifest = () => Response.json({ schemaVersion: 1, sha256: sha, size: 3, etag: `"${sha}"` });
function content(chunks: number[][] = [[1, 2, 3]], length = 3, extra: Record<string, string> = {}, status = 200) {
  const cancel = vi.fn(); let index = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    if (index === chunks.length) c.close(); else c.enqueue(new Uint8Array(chunks[index++]!));
  }, cancel }, { highWaterMark: 0 });
  return { cancel, response: new Response(body, { status, headers: { "Content-Type": "application/octet-stream",
    "Content-Length": String(length), ETag: `"${sha}"`, ...extra } }) };
}
function harness(response: Response = manifest()) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  const recheck = vi.fn(async (_proof: EmployeeReadProof) => true);
  const auditContentStart = vi.fn(async (_proof: EmployeeReadProof, _selection: EmployeeReadSelection) => undefined);
  return { fetcher, recheck, auditContentStart, dependencies: { fetch: fetcher as typeof fetch, recheck, auditContentStart } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("employee private read transport", () => {
  it("matches the shared independently generated Python/TypeScript protocol fixture", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../employee-read-gateway/testdata/protocol-vector.json", import.meta.url), "utf8"));
    const claims = JSON.parse(vector.body);
    expect(await signEmployeeReadBody(vector.body, { origin: "https://private-gateway.example.test", gatewayId: claims.gatewayId,
      keyId: vector.keyId, key: new Uint8Array(Buffer.from(vector.keyHex, "hex")) }, vector.timestamp, vector.nonce)).toBe(vector.signature);
  });
  it("matches an independent Node HMAC vector for the exact protocol/body bytes", async () => {
    const body = '{"schemaVersion":1,"path":"photos/é.raw"}';
    const c = config(), timestamp = 1_800_000_000, nonce = "0123456789abcdef0123456789abcdef";
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const material = ["ops-employee-read-v1", gateway, "employee-v1", String(timestamp), nonce, "POST", "/v1/read", bodyHash].join("\n");
    const expected = createHmac("sha256", c.key).update(material, "utf8").digest("hex");
    expect(await signEmployeeReadBody(body, c, timestamp, nonce)).toBe(expected);
    expect(await signEmployeeReadBody(body + " ", c, timestamp, nonce)).not.toBe(expected);
    expect(await signEmployeeReadBody(body, { ...c, gatewayId: "44444444-4444-4444-8444-444444444444" }, timestamp, nonce)).not.toBe(expected);
  });

  it("uses one fixed POST endpoint with manual redirects and no human JWT/cookies", async () => {
    const h = harness();
    const response = await readEmployeeGateway(proof(), selection("manifest"), config(), h.dependencies);
    expect(response.status).toBe(200);
    const [url, init] = h.fetcher.mock.calls[0]!;
    expect(url).toBe("https://private-gateway.example.test/v1/read");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    const headers = new Headers(init!.headers);
    expect([...headers.keys()].sort()).toEqual(["content-type", "x-ops-read-key-id", "x-ops-read-nonce", "x-ops-read-signature", "x-ops-read-time"]);
    expect(headers.has("authorization")).toBe(false); expect(headers.has("cf-access-token")).toBe(false);
    expect(headers.has("cf-access-jwt-assertion")).toBe(false); expect(headers.has("cookie")).toBe(false);
    const body = String(init!.body), parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ gatewayId: gateway, operation: "manifest", expectedSha256: null, range: null });
    expect(parsed.expiresAt - Number(headers.get("x-ops-read-time"))).toBeLessThanOrEqual(30);
    expect(parsed.deadlineAt - Number(headers.get("x-ops-read-time"))).toBeLessThanOrEqual(900);
    expect(headers.get("x-ops-read-signature")).toBe(await signEmployeeReadBody(body, config(), Number(headers.get("x-ops-read-time")), headers.get("x-ops-read-nonce")!));
    expect(h.auditContentStart).not.toHaveBeenCalled();
  });

  it.each(["http://private-gateway.example.test", "https://private-gateway.example.test/path", "https://user:pass@private-gateway.example.test", "https://private-gateway.example.test?x=1", "https://private-gateway.example.test#x"])("rejects unsafe configured origin %s before fetch", async origin => {
    const h = harness(); expect((await readEmployeeGateway(proof(), selection(), { ...config(), origin }, h.dependencies)).status).toBe(502);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each([0, 31, 129])("rejects invalid signing key length %s", async size => {
    const h = harness(); expect((await readEmployeeGateway(proof(), selection(), { ...config(), key: new Uint8Array(size) }, h.dependencies)).status).toBe(502);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("rejects wrong instance and expired human proof before backend access", async () => {
    const h = harness();
    expect((await readEmployeeGateway({ ...proof(), gatewayId: "44444444-4444-4444-8444-444444444444" }, selection(), config(), h.dependencies)).status).toBe(502);
    expect((await readEmployeeGateway({ ...proof(), verifiedUntil: new Date(Date.now() - 1).toISOString() }, selection(), config(), h.dependencies)).status).toBe(403);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each(["/absolute", "trailing/", "a//b", ".", "a/../b", "a/./b", "a\\b", "a%2fb", "C:drive", "a\u0000b", "a\ud800b", "a".repeat(256), Array(66).fill("a").join("/")])("rejects noncanonical path %s", async path => {
    expect(canonicalEmployeeReadPath(path, false)).toBe(false);
    const h = harness(); expect((await readEmployeeGateway(proof(), { ...selection(), path }, config(), h.dependencies)).status).toBe(502);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("allows root only for listing and accepts canonical Unicode source names", () => {
    expect(canonicalEmployeeReadPath("", true)).toBe(true); expect(canonicalEmployeeReadPath("", false)).toBe(false);
    expect(canonicalEmployeeReadPath("images/é😀.raw", false)).toBe(true);
  });
  it("discards redirects without following or leaking backend response details", async () => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { status: 302,
      headers: { Location: "https://untrusted.example.test/private-path?secret=not-a-real-secret" } });
    const h = harness(response), result = await readEmployeeGateway(proof(), selection("manifest"), config(), h.dependencies);
    expect(result.status).toBe(502); expect(h.fetcher).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
    expect(await result.text()).toBe('{"error":"employee_gateway_unavailable"}'); expect(result.headers.has("location")).toBe(false);
  });
  it("does not call the gateway for a pre-aborted request", async () => {
    const h = harness(), controller = new AbortController(); controller.abort();
    expect((await readEmployeeGateway(proof(), selection(), config(), h.dependencies, controller.signal)).status).toBe(403);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("discards an acquired body when authority is revoked during fetch", async () => {
    const source = content(), h = harness(source.response);
    h.fetcher.mockImplementationOnce(async () => { h.recheck.mockResolvedValue(false); return source.response; });
    expect((await readEmployeeGateway(proof(), selection(), config(), h.dependencies)).status).toBe(403);
    expect(source.cancel).toHaveBeenCalledOnce(); expect(h.auditContentStart).not.toHaveBeenCalled();
  });
  it("rechecks authority after asynchronous metadata body consumption", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ pull(c) {
      h.recheck.mockResolvedValue(false); c.enqueue(new TextEncoder().encode('{"schemaVersion":1,"sha256":"' + sha + '","size":3,"etag":"\\"' + sha + '\\""}')); c.close();
    } }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json" } }));
    expect((await readEmployeeGateway(proof(), selection("manifest"), config(), h.dependencies)).status).toBe(403);
  });
  it("rechecks after auditing and cancels without delivering bytes on revocation", async () => {
    const source = content(), h = harness(source.response);
    h.auditContentStart.mockImplementationOnce(async () => { h.recheck.mockResolvedValue(false); });
    expect((await readEmployeeGateway(proof(), selection(), config(), h.dependencies)).status).toBe(403);
    expect(h.auditContentStart).toHaveBeenCalledOnce(); expect(source.cancel).toHaveBeenCalledOnce();
  });
  it("cancels acquired content on audit failure and returns only a static error", async () => {
    const source = content(), h = harness(source.response);
    h.auditContentStart.mockRejectedValueOnce(Error("private-source-path and synthetic-signature"));
    const result = await readEmployeeGateway(proof(), selection(), config(), h.dependencies);
    expect(result.status).toBe(502); expect(source.cancel).toHaveBeenCalledOnce();
    expect(await result.text()).not.toContain("private-source-path");
  });
  it("streams exact content only after auditing, and propagates downstream cancellation", async () => {
    const source = content([[1], [2], [3]]), h = harness(source.response);
    const result = await readEmployeeGateway(proof(), selection(), config(), h.dependencies);
    expect(h.auditContentStart).toHaveBeenCalledOnce();
    const reader = result.body!.getReader(); expect(await reader.read()).toMatchObject({ value: new Uint8Array([1]) });
    await reader.cancel(); expect(source.cancel).toHaveBeenCalledOnce();
    expect((h.fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
  });
  it("preserves a verified conditional inclusive range", async () => {
    const source = content([[7, 8]], 2, { "Content-Range": "bytes 1-2/4" }, 206), h = harness(source.response);
    const result = await readEmployeeGateway(proof(), { ...selection(), range: { start: 1, end: 2 } }, config(), h.dependencies);
    expect(result.status).toBe(206); expect(result.headers.get("Content-Range")).toBe("bytes 1-2/4");
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([7, 8]);
  });
  it.each(["etag", "range", "encoding", "length"])("cancels invalid %s content headers before audit", async changed => {
    const source = content([[1, 2, 3]], 3, changed === "etag" ? { ETag: '"other"' } : changed === "range" ? { "Content-Range": "bytes 0-2/3" }
      : changed === "encoding" ? { "Content-Encoding": "gzip" } : { "Content-Length": "03" });
    const h = harness(source.response);
    expect((await readEmployeeGateway(proof(), selection(), config(), h.dependencies)).status).toBe(502);
    expect(source.cancel).toHaveBeenCalledOnce(); expect(h.auditContentStart).not.toHaveBeenCalled();
  });
  it("errors and cancels oversized streaming content without publishing the extra bytes", async () => {
    const source = content([[1, 2], [3, 4]]), h = harness(source.response);
    const result = await readEmployeeGateway(proof(), selection(), config(), h.dependencies), reader = result.body!.getReader();
    expect(await reader.read()).toMatchObject({ value: new Uint8Array([1, 2]) });
    await expect(reader.read()).rejects.toThrow("employee_read_interrupted"); expect(source.cancel).toHaveBeenCalledOnce();
  });
  it("errors on a truncated body instead of treating partial content as complete", async () => {
    const source = content([[1, 2]]), h = harness(source.response);
    const result = await readEmployeeGateway(proof(), selection(), config(), h.dependencies);
    await expect(result.arrayBuffer()).rejects.toThrow("employee_read_interrupted");
  });
  it("copies proof, nested selection and key before the first authority await", async () => {
    const p = proof(), c = config(), originalKey = new Uint8Array(c.key);
    const selected = { operation: "content" as const, path: "photos/image.raw", expectedSha256: sha, range: { start: 1, end: 2 } };
    const source = content([[7, 8]], 2, { "Content-Range": "bytes 1-2/4" }, 206), h = harness(source.response), gate = deferred<boolean>();
    h.recheck.mockImplementationOnce(() => gate.promise);
    const pending = readEmployeeGateway(p, selected, c, h.dependencies);
    p.staffId = "staff:other"; p.grantGeneration = 99; selected.path = "other.raw"; selected.range.end = 100; c.key.fill(0xff);
    gate.resolve(true);
    const response = await pending;
    expect(response.status).toBe(206); await response.arrayBuffer();
    const init = h.fetcher.mock.calls[0]![1]!, body = String(init.body), headers = new Headers(init.headers);
    expect(JSON.parse(body)).toMatchObject({ staffId: "staff:synthetic", grantGeneration: 6, path: "photos/image.raw", range: { start: 1, end: 2 } });
    expect(h.recheck.mock.calls.every(([seen]) => seen.staffId === "staff:synthetic" && seen.grantGeneration === 6)).toBe(true);
    expect(headers.get("x-ops-read-signature")).toBe(await signEmployeeReadBody(body, { ...c, key: originalKey }, Number(headers.get("x-ops-read-time")), headers.get("x-ops-read-nonce")!));
  });
  it("requires UTF-8 byte order rather than UTF-16 code-unit order for directory names", async () => {
    const entries = [{ name: "\uff01", kind: "file" }, { name: "😀", kind: "folder" }];
    const sorted = harness(Response.json({ schemaVersion: 1, entries }));
    expect((await readEmployeeGateway(proof(), selection("list"), config(), sorted.dependencies)).status).toBe(200);
    const reversed = harness(Response.json({ schemaVersion: 1, entries: [...entries].reverse() }));
    expect((await readEmployeeGateway(proof(), selection("list"), config(), reversed.dependencies)).status).toBe(502);
  });
  it.each(['{"schemaVersion":1,"entries":[],"entries":[]}', '{"schemaVersion":1,"entries":[],"unexpected":"private"}'])("rejects duplicate or extra metadata fields", async text => {
    const h = harness(new Response(text, { headers: { "Content-Type": "application/json" } }));
    expect((await readEmployeeGateway(proof(), selection("list"), config(), h.dependencies)).status).toBe(502);
  });
  it("accepts 200 maximum-length Unicode names even when Python JSON escapes inflate their wire size", async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({ name: String(index).padStart(3, "0") + "é".repeat(125), kind: "file" }));
    const body = JSON.stringify({ schemaVersion: 1, entries }).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(65_536);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(262_144);
    const h = harness(new Response(body, { headers: { "Content-Type": "application/json" } }));
    const result = await readEmployeeGateway(proof(), selection("list"), config(), h.dependencies);
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ schemaVersion: 1, entries });
  });
  it.each([["list", 262_144], ["manifest", 65_536]] as const)("rejects over-limit %s metadata and cancels its body", async (operation, limit) => {
    const cancel = vi.fn(); let sent = false;
    const h = harness(new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(limit + 1)); } }, cancel }), { headers: { "Content-Type": "application/json" } }));
    expect((await readEmployeeGateway(proof(), selection(operation), config(), h.dependencies)).status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects a chunk arriving after the deadline even before the timer callback runs", async () => {
    const now = Date.now(); let clock = now; vi.spyOn(Date, "now").mockImplementation(() => clock);
    const waiting = deferred<void>(), chunk = deferred<Uint8Array>(), cancel = vi.fn();
    const source = new Response(new ReadableStream<Uint8Array>({ async pull(c) { waiting.resolve(); c.enqueue(await chunk.promise); }, cancel }, { highWaterMark: 0 }),
      { headers: { "Content-Type": "application/octet-stream", "Content-Length": "3", ETag: `"${sha}"` } });
    const h = harness(source), response = await readEmployeeGateway(proof(), selection(), config(), h.dependencies);
    const read = response.body!.getReader().read(); await waiting.promise;
    clock += 901_000; chunk.resolve(new Uint8Array([1, 2, 3]));
    await expect(read).rejects.toThrow("employee_read_interrupted"); expect(cancel).toHaveBeenCalledOnce();
  });
});
