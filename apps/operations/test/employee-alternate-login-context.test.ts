import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffLoginProof } from "../src/worker/staff-login-bindings";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

const calls = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("../src/worker/staff-login-bindings", async () => ({
  ...await vi.importActual<typeof import("../src/worker/staff-login-bindings")>("../src/worker/staff-login-bindings"),
  assertCurrentStaffLogin: calls.current,
}));
import { resolveEmployeeReadAuthority, recheckEmployeeReadAuthority } from "../src/worker/employee-read-authority";
import { provisionEmployeeRead } from "../src/worker/employee-read-provisioning";
import { decodeEmployeeFileHandle, employeeLogicalFileId, encodeEmployeeFileHandle } from "../src/worker/employee-read-handles";
import { readEmployeeGateway } from "../src/worker/employee-read-transport";
import { createEmployeeQueueRouter } from "../src/worker/employee-queue-routes";
import * as nativeAuth from "../src/worker/native-staff-auth";
import * as nativeIdentity from "../src/worker/native-staff-identity";

const rootId = "11111111-1111-4111-8111-111111111111", gatewayId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
let login: StaffLoginProof, auth: AuthenticatedNativeStaffWithAdmissionVersion, active = true;
let afterRead: (() => void) | undefined;
const batches = vi.fn();
const row = () => ({ rootId, gatewayId, rootGeneration: 1, rootFingerprint: "a".repeat(64),
  staffId: "staff-owner", accessSubject: "access|owner", admissionVersion: 7, profileVersion: 3,
  grantId, grantGeneration: 1, email: "owner@example.test", expiresAt: Math.floor(Date.now() / 1000) + 300 });
const db = { withSession() { return { prepare() { return { bind() { return this; }, async first() {
  afterRead?.(); return row();
} }; }, batch: batches }; } } as unknown as D1Database;
beforeEach(() => {
  vi.clearAllMocks(); active = true; afterRead = undefined;
  login = Object.freeze({ kind: "alternate", staffId: "staff-owner", canonicalEmail: "owner@example.test",
    canonicalSubject: "access|owner", issuer: "https://synthetic.cloudflareaccess.com", email: "alternate@example.test",
    subject: "access|alternate", expiresAt: Math.floor(Date.now() / 1000) + 600,
    bindingId: "44444444-4444-4444-8444-444444444444", bindingVersion: 1, generation: 2 });
  auth = Object.freeze({ identity: Object.freeze({ kind: "native", staffId: "staff-owner", email: "owner@example.test",
    verifiedAccessSubject: "access|owner", displayName: "Owner", profileVersion: 3 }), admissionVersion: 7,
    verifiedUntil: new Date(login.expiresAt * 1000).toISOString(), verifiedLogin: login });
  calls.current.mockImplementation(async () => active);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("employee authority retains actual alternate-login proof", () => {
  it("carries a validated alternate proof into the private authority for later backend rechecks", async () => {
    const proof = await resolveEmployeeReadAuthority(db, auth, rootId);
    expect(proof?.verifiedLogin).toEqual(login);
    expect(proof).toMatchObject({ staffId: auth.identity.staffId, accessSubject: auth.identity.verifiedAccessSubject, admissionVersion: 7 });
    expect(await recheckEmployeeReadAuthority(db, proof!)).toBe(true);
    expect(calls.current).toHaveBeenCalledWith(db, login);
  });
  it("does not collapse an alternate proof back to canonical-only authority after revocation", async () => {
    const proof = await resolveEmployeeReadAuthority(db, auth, rootId);
    active = false;
    expect(await recheckEmployeeReadAuthority(db, proof!)).toBe(false);
    expect(await resolveEmployeeReadAuthority(db, auth, rootId)).toBeNull();
  });
  it("rejects an alternate revoked during a root-authority read", async () => {
    afterRead = () => { active = false; };
    expect(await resolveEmployeeReadAuthority(db, auth, rootId)).toBeNull();
  });
  it.each([
    { staffId: "staff-other" }, { canonicalSubject: "access|other" }, { canonicalEmail: "other@example.test" },
    { bindingId: null }, { bindingVersion: 0 }, { unexpected: "field" },
  ])("rejects a mismatched or malformed login proof before granting root access: %j", async change => {
    expect(await resolveEmployeeReadAuthority(db, { ...auth, verifiedLogin: { ...login, ...change } } as typeof auth, rootId)).toBeNull();
  });
  it("preserves the primary-only strict shape and does not require alias storage for that request", async () => {
    const { verifiedLogin: _login, ...primary } = auth;
    const proof = await resolveEmployeeReadAuthority(db, primary, rootId);
    expect(proof).not.toBeNull(); expect(Object.hasOwn(proof!, "verifiedLogin")).toBe(false);
    expect(calls.current).not.toHaveBeenCalled();
  });
  it("rejects stale alternate manager context before any provisioning batch", async () => {
    active = false;
    await expect(provisionEmployeeRead(db, auth, { commandId: crypto.randomUUID(), kind: "register-root",
      rootId, gatewayId, rootFingerprint: "a".repeat(64), displayName: "Synthetic files" }, { gatewayIds: [gatewayId] }))
      .rejects.toMatchObject({ status: 403 });
    expect(batches).not.toHaveBeenCalled();
  });
  it("keeps actual login evidence out of the selector while current authority retains it", async () => {
    const proof = (await resolveEmployeeReadAuthority(db, auth, rootId))!;
    const context = { opsOrigin: "https://ops.example.test", issuer: login.issuer, audience: "synthetic-staff-audience", key: new Uint8Array(32).fill(0x31) };
    const token = await encodeEmployeeFileHandle(context, { v: 1, proof, path: "photo.raw",
      snapshotId: "55555555-5555-4555-8555-555555555555", sha256: "b".repeat(64), size: 3,
      expiresAt: Math.floor(Date.now() / 1000) + 60 });
    const selector = await decodeEmployeeFileHandle(context, token);
    expect(selector).not.toBeNull();
    expect(Object.hasOwn(selector!.proof, "verifiedLogin")).toBe(false);
    expect(JSON.stringify(selector)).not.toContain(login.email); expect(JSON.stringify(selector)).not.toContain(login.subject);
    const { verifiedLogin: _login, ...canonical } = proof;
    expect(await employeeLogicalFileId(context, proof, "photo.raw")).toBe(await employeeLogicalFileId(context, canonical, "photo.raw"));
    active = false;
    expect(await recheckEmployeeReadAuthority(db, proof)).toBe(false);
    expect(await resolveEmployeeReadAuthority(db, auth, rootId)).toBeNull();
  });
  it("snapshots the actual login before upstream waits without forwarding it to the gateway", async () => {
    const proof = (await resolveEmployeeReadAuthority(db, auth, rootId))!;
    const mutableLogin = { ...login }, input = { ...proof, verifiedLogin: mutableLogin };
    const recheck = vi.fn(async (current: typeof proof) => {
      mutableLogin.subject = "access|changed-after-call";
      return current.verifiedLogin?.subject === login.subject && Object.isFrozen(current.verifiedLogin);
    });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).not.toContain(login.email); expect(body).not.toContain(login.subject); expect(body).not.toContain("verifiedLogin");
      return Response.json({ schemaVersion: 1, sha256: "b".repeat(64), size: 3, etag: `"${"b".repeat(64)}"`,
        snapshotId: "55555555-5555-4555-8555-555555555555", snapshotExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    });
    const response = await readEmployeeGateway(input, { operation: "manifest", path: "photo.raw", expectedSha256: null, range: null },
      { origin: "https://gateway.example.test", gatewayId, keyId: "synthetic", key: new Uint8Array(32).fill(0x31) },
      { fetch: fetcher as typeof fetch, recheck, auditContentStart: async () => {} });
    expect(response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1); expect(recheck.mock.calls.length).toBeGreaterThan(1);
  });
  it.each([true, false])("queue session preserves alternate proof when re-resolving current identity (current=%s)", async isCurrent => {
    vi.spyOn(nativeAuth, "authenticateNativeStaffWithAdmissionVersion").mockResolvedValue(auth);
    const fresh = vi.spyOn(nativeIdentity, "resolveCanonicalNativeStaffIdentityWithAdmissionVersion")
      .mockResolvedValue(isCurrent ? { identity: auth.identity, admissionVersion: auth.admissionVersion } : null);
    const router = createEmployeeQueueRouter({ enabled: true, opsOrigin: "https://ops.example.test",
      access: { enabled: true, issuer: login.issuer, staffAudience: "synthetic-staff-audience" },
      gateway: { origin: "https://gateway.example.test", gatewayId, keyId: "synthetic", key: new Uint8Array(32).fill(0x31) },
      handleKey: new Uint8Array(32).fill(0x32), queueKey: new Uint8Array(32).fill(0x33) }, { database: db });
    const response = await router.fetch(new Request("https://ops.example.test/api/staff/files/queue/session"));
    expect(response.status).toBe(isCurrent ? 200 : 401);
    expect(fresh).toHaveBeenCalledWith(db, login);
    expect(await response.text()).not.toContain("verifiedLogin");
  });
});
