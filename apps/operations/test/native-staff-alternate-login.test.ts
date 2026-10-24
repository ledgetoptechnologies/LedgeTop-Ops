import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { StaffLoginProof } from "../src/worker/staff-login-bindings";

const calls = vi.hoisted(() => ({ keys: vi.fn(), resolve: vi.fn(), current: vi.fn() }));
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: calls.keys }));
vi.mock("../src/worker/staff-login-bindings", async () => ({
  ...await vi.importActual<typeof import("../src/worker/staff-login-bindings")>("../src/worker/staff-login-bindings"),
  resolveVerifiedStaffLogin: calls.resolve, assertCurrentStaffLogin: calls.current,
}));

import { authenticateNativeStaff, authenticateNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

const issuer = "https://synthetic-team.cloudflareaccess.com", audience = "synthetic-staff-audience";
const primaryEmail = "owner@example.test", alternateEmail = "alternate@example.test";
const primarySubject = "access|owner", alternateSubject = "access|alternate";
const config = { enabled: true, issuer, staffAudience: audience };
let pair: Awaited<ReturnType<typeof generateKeyPair>>, keys: ReturnType<typeof createLocalJWKSet>;
let current = true, nativeActive = true, afterCanonicalRead: (() => void) | undefined;
let proof: StaffLoginProof;
const reads: Array<readonly unknown[]> = [];

beforeAll(async () => {
  pair = await generateKeyPair("RS256", { extractable: true });
  const key = await exportJWK(pair.publicKey); key.kid = "synthetic"; key.alg = "RS256";
  keys = createLocalJWKSet({ keys: [key] });
});
beforeEach(() => {
  vi.clearAllMocks(); current = nativeActive = true; afterCanonicalRead = undefined; reads.length = 0;
  proof = Object.freeze({ kind: "alternate", staffId: "staff-owner", canonicalEmail: primaryEmail,
    canonicalSubject: primarySubject, issuer, email: alternateEmail, subject: alternateSubject,
    expiresAt: Math.floor(Date.now() / 1000) + 600, bindingId: "11111111-1111-4111-8111-111111111111", bindingVersion: 1, generation: 2 });
  calls.keys.mockReturnValue(keys);
  calls.current.mockImplementation(async () => current);
  calls.resolve.mockImplementation(async (_db, claims) => {
    if (!current || claims.issuer !== issuer || claims.email !== alternateEmail || claims.subject !== alternateSubject) return null;
    proof = Object.freeze({ ...proof, expiresAt: claims.expiresAt });
    return { staff: { id: proof.staffId, email: primaryEmail, accessSubject: primarySubject }, proof };
  });
});

const db = { withSession() { return { prepare() { let bound: readonly unknown[] = [];
  return { bind(...values: unknown[]) { bound = values; return this; }, async all() {
    reads.push(bound);
    const matches = nativeActive && bound[0] === primarySubject && bound[1] === primaryEmail;
    if (matches) afterCanonicalRead?.();
    return { results: matches ? [{ staff_id: "staff-owner", bound_access_subject: primarySubject,
      login_email: primaryEmail, display_name: "Owner", version: 3, admission_version: 7 }] : [] };
  } };
} }; } } as unknown as D1Database;

async function request(email = alternateEmail, subject = alternateSubject,
  options: { issuer?: string; audience?: string; claims?: Record<string, unknown> } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ type: "app", email, ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic" }).setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience).setSubject(subject).setIssuedAt(now - 1).setExpirationTime(now + 600).sign(pair.privateKey);
  return new Request("https://ops.example.test/api/session", { headers: { "Cf-Access-Jwt-Assertion": assertion } });
}

describe("native alternate login with real RS256 verification", () => {
  it("preserves the primary native-only flow and its exact outer shape", async () => {
    const result = await authenticateNativeStaffWithAdmissionVersion(await request(primaryEmail, primarySubject), db, config);
    expect(result.identity).toMatchObject({ staffId: "staff-owner", email: primaryEmail, verifiedAccessSubject: primarySubject });
    expect(Object.keys(result).sort()).toEqual(["admissionVersion", "identity", "verifiedUntil"]);
    expect(calls.resolve).not.toHaveBeenCalled(); expect(calls.current).not.toHaveBeenCalled();
  });
  it("uses the same canonical profile while retaining the actual alternate JWT identity", async () => {
    const result = await authenticateNativeStaffWithAdmissionVersion(await request(), db, config);
    expect(result.identity).toEqual({ kind: "native", staffId: "staff-owner", email: primaryEmail,
      verifiedAccessSubject: primarySubject, displayName: "Owner", profileVersion: 3 });
    expect(result.verifiedLogin).toMatchObject({ email: alternateEmail, subject: alternateSubject, issuer });
    expect(result.admissionVersion).toBe(7);
    expect(calls.resolve).toHaveBeenCalledWith(db, expect.objectContaining({ email: alternateEmail, subject: alternateSubject, issuer }));
    expect(reads).toEqual([[alternateSubject, alternateEmail], [primarySubject, primaryEmail]]);
  });
  it("retains actual login evidence in the non-admission-version wrapper", async () => {
    const result = await authenticateNativeStaff(await request(), db, config);
    expect(result.verifiedLogin).toEqual(proof); expect(Object.hasOwn(result, "admissionVersion")).toBe(false);
  });
  it.each([
    { issuer: "https://wrong.cloudflareaccess.com" }, { audience: "different-staff-audience" },
    { claims: { service_token_id: "synthetic-service" } }, { claims: { common_name: "synthetic-service" } }, { claims: { type: "service" } },
  ])("rejects an invalid human assertion before alternate resolution: %j", async options => {
    await expect(authenticateNativeStaffWithAdmissionVersion(await request(alternateEmail, alternateSubject, options), db, config)).rejects.toThrow("native_staff_access_denied");
    expect(calls.resolve).not.toHaveBeenCalled(); expect(reads).toEqual([]);
  });
  it.each([["other@example.test", alternateSubject], [alternateEmail, "access|other"],
    [primaryEmail, alternateSubject], [alternateEmail, primarySubject]])("rejects a mismatched verified email or subject", async (email, subject) => {
    await expect(authenticateNativeStaffWithAdmissionVersion(await request(email, subject), db, config)).rejects.toThrow("native_staff_access_denied");
  });
  it("cannot turn a legacy primary record into a missing native admission", async () => {
    nativeActive = false;
    calls.resolve.mockResolvedValue({ proof: { ...proof, kind: "primary", bindingId: null, bindingVersion: 0 } });
    await expect(authenticateNativeStaffWithAdmissionVersion(await request(), db, config)).rejects.toThrow("native_staff_access_denied");
  });
  it("rejects a binding whose canonical profile resolves to another staff ID", async () => {
    calls.resolve.mockImplementation(async () => ({ staff: { id: "staff-other" }, proof: { ...proof, staffId: "staff-other" } }));
    await expect(authenticateNativeStaffWithAdmissionVersion(await request(), db, config)).rejects.toThrow("native_staff_access_denied");
  });
  it("denies a revoked or pending alternate and an inactive canonical native profile", async () => {
    current = false;
    await expect(authenticateNativeStaffWithAdmissionVersion(await request(), db, config)).rejects.toThrow("native_staff_access_denied");
    current = true; nativeActive = false;
    await expect(authenticateNativeStaffWithAdmissionVersion(await request(), db, config)).rejects.toThrow("native_staff_access_denied");
  });
  it("does not return canonical authority when the alternate changes during native lookup", async () => {
    afterCanonicalRead = () => { current = false; };
    await expect(authenticateNativeStaffWithAdmissionVersion(await request(), db, config)).rejects.toThrow("native_staff_access_denied");
  });
});
