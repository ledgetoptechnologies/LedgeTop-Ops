import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEmployeeFileHandle as encode, decodeEmployeeFileHandle as decode, employeeLogicalFileId as identity,
  employeeFileProofMatches, type EmployeeHandleContext, type EmployeeFileHandle } from "../src/worker/employee-read-handles";

const context = (): EmployeeHandleContext => ({ opsOrigin: "https://ops.example.test", issuer: "https://synthetic.cloudflareaccess.com",
  audience: "synthetic-staff-audience", key: new Uint8Array(32).fill(0x31) });
const value = (): EmployeeFileHandle => ({ v: 1, proof: { gatewayId: "11111111-1111-4111-8111-111111111111",
  rootId: "22222222-2222-4222-8222-222222222222", rootGeneration: 1, rootFingerprint: "a".repeat(64), staffId: "staff:synthetic",
  accessSubject: "access|synthetic", admissionVersion: 2, profileVersion: 3, grantId: "33333333-3333-4333-8333-333333333333", grantGeneration: 4,
  verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() }, path: "photos/Map 01.raw",
  snapshotId: "44444444-4444-4444-8444-444444444444", sha256: "b".repeat(64), size: 30_000_000_000, expiresAt: Math.floor(Date.now() / 1000) + 800 });
afterEach(() => vi.restoreAllMocks());
describe("employee encrypted selectors and stable logical identity", () => {
  it("roundtrips bounded opaque encrypted claims with a fresh IV", async () => {
    const input = value(), one = await encode(context(), input), two = await encode(context(), input);
    expect(one).toMatch(/^eof1_[A-Za-z0-9_-]+$/u); expect(one.length).toBeLessThanOrEqual(16384); expect(one).not.toBe(two);
    expect(one).not.toContain("photos"); expect(one).not.toContain("access"); expect(await decode(context(), one)).toEqual(input);
  });
  it.each(["origin", "issuer", "audience", "key"])("binds encryption to %s context", async field => {
    const token = await encode(context(), value()), changed = { ...context() };
    if (field === "origin") changed.opsOrigin = "https://other.example.test";
    if (field === "issuer") changed.issuer = "https://other.cloudflareaccess.com";
    if (field === "audience") changed.audience = "other-staff-audience";
    if (field === "key") changed.key = new Uint8Array(32).fill(0x32);
    expect(await decode(changed, token)).toBeNull();
  });
  it("rejects tampering, unknown protocol, noncanonical encoding and oversized handles", async () => {
    const token = await encode(context(), value());
    for (const changed of [token.slice(0, 30) + (token[30] === "a" ? "b" : "a") + token.slice(31), token + "=", token.replace("eof1_", "ond1_"), "eof1_" + "a".repeat(16384)])
      expect(await decode(context(), changed)).toBeNull();
  });
  it("rejects expired claims on read and impossible lifetimes on mint", async () => {
    const now = Date.now(), input = value(), token = await encode(context(), input);
    vi.spyOn(Date, "now").mockReturnValue(now + 801_000);
    expect(await decode(context(), token)).toBeNull();
    await expect(encode(context(), { ...value(), expiresAt: Math.floor(Date.now() / 1000) + 901 })).rejects.toThrow();
  });
  it("keeps logical identity across snapshots, profile edits and expiry renewal while path/grant/actor/root changes differ", async () => {
    const input = value(), original = await identity(context(), input.proof, input.path);
    expect(original).toMatch(/^oef1_[a-f0-9]{64}$/u);
    expect(await identity(context(), { ...input.proof, profileVersion: 99, verifiedUntil: new Date(Date.now() + 9_000_000).toISOString() }, input.path)).toBe(original);
    for (const proof of [{ ...input.proof, grantGeneration: 5 }, { ...input.proof, admissionVersion: 3 }, { ...input.proof, rootGeneration: 2 }, { ...input.proof, accessSubject: "access|other" }])
      expect(await identity(context(), proof, input.path)).not.toBe(original);
    expect(await identity(context(), input.proof, "other.raw")).not.toBe(original);
  });
  it("matches every current proof pin and bounds refreshed human expiry", () => {
    const input = value(); expect(employeeFileProofMatches(input, input.proof)).toBe(true);
    for (const field of ["rootGeneration", "admissionVersion", "profileVersion", "grantGeneration"] as const)
      expect(employeeFileProofMatches(input, { ...input.proof, [field]: input.proof[field] + 1 })).toBe(false);
    expect(employeeFileProofMatches(input, { ...input.proof, verifiedUntil: new Date(input.expiresAt * 1000 - 1).toISOString() })).toBe(false);
  });
  it("copies mutable context key and claims before cryptographic awaits", async () => {
    const c = context(), input = value(), original = context();
    const pending = encode(c, input); c.key.fill(0xff); input.path = "changed.raw"; input.proof.grantGeneration = 99;
    expect(await decode(original, await pending)).toMatchObject({ path: "photos/Map 01.raw", proof: { grantGeneration: 4 } });
  });
});
