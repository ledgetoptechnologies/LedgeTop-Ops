import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleNativeWorkforceTimeRecordHttp, nativeWorkforceTimeRecordHttpRequest,
  type NativeWorkforceTimeRecordHttpDependencies } from "../src/worker/native-workforce-time-record-http";
import { NativeWorkforceTimeRecordConflict, NativeWorkforceTimeRecordDenied,
  NativeWorkforceTimeRecordOutcomeUnknown } from "../src/worker/native-workforce-time-record";

const calls = vi.hoisted(() => ({ auth: vi.fn(), record: vi.fn(), submit: vi.fn(), review: vi.fn(), quota: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: calls.auth }));
vi.mock("../src/worker/native-workforce-time-record", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/native-workforce-time-record")>(),
  recordNativeWorkforceTime: calls.record,
}));
vi.mock("../src/worker/native-workforce-time-transitions", () => ({
  submitNativeWorkforceTime: calls.submit, reviewNativeWorkforceTime: calls.review,
}));
const origin = "https://ops.example.test";
const auth = { admissionVersion: 2, verifiedUntil: "2099-01-01T00:00:00.000Z",
  identity: { kind: "native", staffId: "actor", verifiedAccessSubject: "access|actor",
    email: "actor@example.test", displayName: "Actor", profileVersion: 1 } };
const deps = (enabled = true): NativeWorkforceTimeRecordHttpDependencies => ({ database: {} as D1Database,
  configuration: { enabled, issuer: "https://team.cloudflareaccess.com",
    staffAudience: "operations-audience", origin: enabled ? origin : "", csrfSecret: "x".repeat(48) },
  consumeRateLimit: calls.quota });
const get = () => new Request(`${origin}/api/native-workforce/time-record/session`,
  { headers: { "X-Native-Workforce-Request": "1" } });
beforeEach(() => { vi.clearAllMocks(); calls.quota.mockResolvedValue(true); calls.auth.mockResolvedValue(auth);
  calls.record.mockResolvedValue({ commandId: "command", entryId: "entry", revision: 1,
    beneficiaryStaffId: "actor", replayed: false, createdAt: "2026-09-22T00:00:00.000Z" }); });

describe("native workforce time-record HTTP boundary", () => {
  it("reserves only exact session and record routes and stays absent while disabled", async () => {
    expect(nativeWorkforceTimeRecordHttpRequest("POST", "/api/native-workforce/time-record")).toBe("record");
    expect(nativeWorkforceTimeRecordHttpRequest("GET", "/api/native-workforce/time-record/session")).toBe("session");
    expect(nativeWorkforceTimeRecordHttpRequest("POST", "/api/native-workforce/time-record/submit")).toBe("submit");
    expect(nativeWorkforceTimeRecordHttpRequest("POST", "/api/native-workforce/time-record/review")).toBe("review");
    expect(nativeWorkforceTimeRecordHttpRequest("POST", "/api/native-workforce/time-record/")).toBeNull();
    expect((await handleNativeWorkforceTimeRecordHttp(get(), deps(false))).status).toBe(404);
    expect(calls.auth).not.toHaveBeenCalled();
  });

  it("authenticates natively and issues a purpose-separated session token", async () => {
    const response = await handleNativeWorkforceTimeRecordHttp(get(), deps());
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ csrfToken: expect.stringMatching(/^[0-9a-f]{64}$/), staffId: "actor" });
  });

  it("requires exact origin, CSRF, JSON content type, and bounded body before execution", async () => {
    const session = await handleNativeWorkforceTimeRecordHttp(get(), deps());
    const token = (await session.json() as { csrfToken: string }).csrfToken;
    const request = new Request(`${origin}/api/native-workforce/time-record`, { method: "POST", headers: {
      Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ commandId: "command" }) });
    expect((await handleNativeWorkforceTimeRecordHttp(request, deps())).status).toBe(200);
    const foreign = new Request(`${origin}/api/native-workforce/time-record`, { method: "POST",
      headers: { Origin: "https://evil.example.test", "Content-Type": "application/json", "X-CSRF-Token": token }, body: "{}" });
    expect((await handleNativeWorkforceTimeRecordHttp(foreign, deps())).status).toBe(403);
    expect(calls.record).toHaveBeenCalledTimes(1);
  });

  it("fails closed on rate limit and never invokes the executor", async () => {
    calls.quota.mockResolvedValue(false);
    expect((await handleNativeWorkforceTimeRecordHttp(get(), deps())).status).toBe(429);
    expect(calls.auth).not.toHaveBeenCalled(); expect(calls.record).not.toHaveBeenCalled();
  });

  it("maps only typed denial/conflict and keeps ambiguous outcomes retryable", async () => {
    const session = await handleNativeWorkforceTimeRecordHttp(get(), deps());
    const token = (await session.json() as { csrfToken: string }).csrfToken;
    const execute = () => handleNativeWorkforceTimeRecordHttp(new Request(
      `${origin}/api/native-workforce/time-record`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token }, body: "{}" }), deps());
    calls.record.mockRejectedValueOnce(new NativeWorkforceTimeRecordDenied());
    expect((await execute()).status).toBe(403);
    calls.record.mockRejectedValueOnce(new NativeWorkforceTimeRecordConflict());
    expect((await execute()).status).toBe(409);
    for (const error of [new NativeWorkforceTimeRecordOutcomeUnknown(),
      new Error("database transport failed with private details")]) {
      calls.record.mockRejectedValueOnce(error);
      const response = await execute();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "outcome_unknown" });
    }
  });

  it("dispatches submit and review through the same native authenticated boundary", async () => {
    calls.submit.mockResolvedValue({ action: "submitted" });
    calls.review.mockResolvedValue({ action: "approved" });
    const session = await handleNativeWorkforceTimeRecordHttp(get(), deps());
    const token = (await session.json() as { csrfToken: string }).csrfToken;
    const execute = (path: string) => handleNativeWorkforceTimeRecordHttp(new Request(`${origin}${path}`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token },
      body: "{}" }), deps());
    expect(await (await execute("/api/native-workforce/time-record/submit")).json()).toEqual({ action: "submitted" });
    expect(await (await execute("/api/native-workforce/time-record/review")).json()).toEqual({ action: "approved" });
    expect(calls.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ identity: auth.identity }), {});
    expect(calls.review).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ identity: auth.identity }), {});
  });
});
