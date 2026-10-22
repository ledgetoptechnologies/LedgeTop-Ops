import { describe, expect, it, vi, afterEach } from "vitest";
import { queueContext, queuePrincipal, encodeQueueReference, decodeQueueReference, queueQuery } from "@ltds/shared/windows-queue-reference";
const c = { source: "employee" as const, origin: "https://ops.example.test", issuer: "https://synthetic.cloudflareaccess.com", audience: "synthetic-queue-audience", key: new Uint8Array(32).fill(11) };
describe("durable non-authorizing queue selectors", () => {
  afterEach(() => vi.useRealTimers());
  it("uses stable purpose/context/person/admission separated HMAC identities", async () => {
    const p = await queuePrincipal(c, ["person", "staff", 1]); expect(p).toMatch(/^odqp1_[a-f0-9]{64}$/u);
    expect(await queuePrincipal(c, ["person", "staff", 1])).toBe(p);
    for (const other of [{ ...c, source: "portal" as const }, { ...c, origin: "https://other.example.test" }, { ...c, audience: "other-queue-audience" }, { ...c, issuer: "https://other.cloudflareaccess.com" }]) expect(await queuePrincipal(other, ["person", "staff", 1])).not.toBe(p);
    expect(await queuePrincipal(c, ["person", "staff", 2])).not.toBe(p);
  });
  it("encrypts bounded 30day selector and denies tampering/wrong context/key", async () => {
    const p = await queuePrincipal(c, ["person"]), token = await encodeQueueReference(c, p, { rootId: "synthetic", path: "private-name" });
    expect(token.length).toBeLessThanOrEqual(16384); expect(token).not.toContain("private-name");
    const decoded = await decodeQueueReference(c, token); expect(decoded?.resource.path).toBe("private-name"); expect(decoded!.expiresAt - decoded!.issuedAt).toBe(30 * 86400);
    for (const context of [{ ...c, source: "portal" as const }, { ...c, key: new Uint8Array(32).fill(9) }, { ...c, audience: "another-queue-audience" }]) expect(await decodeQueueReference(context, token)).toBeNull();
    expect(await decodeQueueReference(c, token.slice(0, 20) + (token[20] === "A" ? "B" : "A") + token.slice(21))).toBeNull();
    expect(await decodeQueueReference(c, "odqr1_" + "a".repeat(16384))).toBeNull();
    vi.useFakeTimers(); vi.setSystemTime((decoded!.expiresAt + 1) * 1000); expect(await decodeQueueReference(c, token)).toBeNull();
  });
  it("snapshots caller claims/key before awaits", async () => {
    const input = { ...c, key: new Uint8Array(c.key) }, resource = { path: "first" }, p = await queuePrincipal(c, ["person"]);
    const result = encodeQueueReference(input, p, resource); resource.path = "second"; input.key.fill(0);
    expect((await decodeQueueReference(c, await result))?.resource.path).toBe("first");
  });
  it("rejects invalid deployment contexts/oversize claims and duplicate escaped query aliases", async () => {
    for (const input of [{ ...c, origin: c.origin + "/" }, { ...c, key: new Uint8Array(31) }, { ...c, issuer: "https://evil.example.test" }]) expect(() => queueContext(input)).toThrow();
    await expect(encodeQueueReference(c, await queuePrincipal(c, ["person"]), { huge: "a".repeat(12001) })).rejects.toThrow();
    expect(() => queueQuery(c.origin + "/?resourceRef=x&%72esourceRef=y", ["resourceRef"])).toThrow();
    expect(() => queueQuery(c.origin + "/?resourceRef=%zz", ["resourceRef"])).toThrow();
    expect(() => queueQuery(c.origin + "/?other=y", ["resourceRef"])).toThrow();
  });
});
