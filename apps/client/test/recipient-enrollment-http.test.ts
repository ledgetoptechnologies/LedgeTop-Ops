import { describe, expect, it, vi } from "vitest";
import { handleRecipientEnrollmentHttp, type RecipientEnrollmentHttpDependencies } from "../src/worker/client-portal/recipient-enrollment-http";
import type { Env } from "../src/worker/types";

const origin = "https://client-staging.example.test", base = `${origin}/api/client/v2/recipient-enrollment`;
const intentId = "11111111-1111-4111-8111-111111111111", selectionId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333", opaqueToken = "a".repeat(64);
const target = { clientRecordId: "ops-client", selectionId };
const proof = { principal: { issuer: "https://team.cloudflareaccess.com", subject: "person|one", email: "private@example.test" }, verifiedUntil: "2099-01-01T00:00:00.000Z" };
function dependencies(): RecipientEnrollmentHttpDependencies {
  return { env: {} as Env, enabled: true, environment: "staging", origin, csrfSecret: "synthetic-enrollment-csrf-secret-at-least-32-bytes",
    resolveProof: vi.fn().mockResolvedValue(proof), binding: {
      inspectEnrollment: vi.fn().mockResolvedValue({ intentId, revision: 1, state: "issued", target: { ...target, displayLabel: "Example customer" }, expiresAt: "2099-01-01T00:00:00.000Z" }),
      redeemEnrollment: vi.fn().mockResolvedValue({ intentId, revision: 2, state: "pending" }),
    } };
}
function request(path: string, body?: unknown, csrf?: string) {
  return new Request(`${base}/${path}`, { method: body === undefined ? "GET" : "POST", headers: {
    Origin: origin, "Sec-Fetch-Site": "same-origin", "X-Recipient-Enrollment-Request": "1", "Content-Type": "application/json",
    ...(csrf ? { "X-CSRF-Token": csrf } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function session(deps: RecipientEnrollmentHttpDependencies) {
  const response = await handleRecipientEnrollmentHttp(request("session"), deps);
  expect(response.status).toBe(200);
  return (await response.json() as { csrfToken: string }).csrfToken;
}
describe("staging recipient enrollment consent boundary", () => {
  it("accepts a same-origin session GET without the browser's optional Origin header", async () => {
    const deps = dependencies(), input = request("session"); input.headers.delete("Origin");
    expect((await handleRecipientEnrollmentHttp(input, deps)).status).toBe(200);
    expect(deps.binding!.inspectEnrollment).not.toHaveBeenCalled();
  });
  it("rejects a hostname that only contains staging as part of another word", async () => {
    const deps = dependencies(); deps.origin = "https://notstaging.example.test";
    expect((await handleRecipientEnrollmentHttp(request("session"), deps)).status).toBe(503);
    expect(deps.resolveProof).not.toHaveBeenCalled();
  });
  it.each(["disabled", "production"])("is absent in %s without checking identity", async mode => {
    const deps = dependencies(); if (mode === "disabled") deps.enabled = false; else deps.environment = "production";
    expect((await handleRecipientEnrollmentHttp(request("session"), deps)).status).toBe(404);
    expect(deps.resolveProof).not.toHaveBeenCalled();
  });
  it("shows only the exact token-selected target and does not redeem on inspection", async () => {
    const deps = dependencies(), csrf = await session(deps);
    const response = await handleRecipientEnrollmentHttp(request("inspect", { intentId, opaqueToken }, csrf), deps);
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(deps.binding!.inspectEnrollment).toHaveBeenCalledWith({ protocolVersion: 1, intentId, opaqueToken });
    expect(deps.binding!.redeemEnrollment).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(opaqueToken);
  });
  it("sends only server-derived identity and explicit target consent through private RPC", async () => {
    const deps = dependencies(), csrf = await session(deps);
    const response = await handleRecipientEnrollmentHttp(request("redeem", { intentId, opaqueToken, operationId, acknowledged: true, acknowledgedTarget: target }, csrf), deps);
    expect(response.status).toBe(200);
    expect(deps.binding!.redeemEnrollment).toHaveBeenCalledWith({ protocolVersion: 1, intentId, opaqueToken, operationId,
      acknowledged: true, acknowledgedTarget: target, principal: { issuer: proof.principal.issuer, subject: proof.principal.subject }, verifiedUntil: proof.verifiedUntil });
    expect(await response.json()).toEqual({ intentId, revision: 2, state: "pending" });
  });
  it.each([{ issuer: "fake" }, { subject: "fake" }, { email: "fake@example.test" }, { verifiedUntil: "2099-01-01" }])("rejects browser identity/deadline field %j", async extra => {
    const deps = dependencies(), csrf = await session(deps);
    expect((await handleRecipientEnrollmentHttp(request("redeem", { intentId, opaqueToken, operationId, acknowledged: true, acknowledgedTarget: target, ...extra }, csrf), deps)).status).toBe(400);
    expect(deps.binding!.redeemEnrollment).not.toHaveBeenCalled();
  });
  it("rejects missing consent or CSRF before private mutation", async () => {
    const deps = dependencies(), csrf = await session(deps);
    expect((await handleRecipientEnrollmentHttp(request("redeem", { intentId, opaqueToken, operationId, acknowledged: false, acknowledgedTarget: target }, csrf), deps)).status).toBe(400);
    expect((await handleRecipientEnrollmentHttp(request("inspect", { intentId, opaqueToken }), deps)).status).toBe(403);
    expect(deps.binding!.redeemEnrollment).not.toHaveBeenCalled();
  });
  it("rejects oversized bodies and accessor-bearing private responses", async () => {
    const deps = dependencies(), csrf = await session(deps);
    expect((await handleRecipientEnrollmentHttp(request("inspect", { intentId, opaqueToken, extra: "x".repeat(5000) }, csrf), deps)).status).toBe(400);
    const accessor = Object.defineProperty({}, "intentId", { enumerable: true, get() { throw Error("do not execute"); } });
    deps.binding!.inspectEnrollment = vi.fn().mockResolvedValue(accessor);
    expect((await handleRecipientEnrollmentHttp(request("inspect", { intentId, opaqueToken }, csrf), deps)).status).toBe(403);
  });
  it("binds CSRF to the current issuer and subject rather than email", async () => {
    const deps = dependencies(), csrf = await session(deps);
    deps.resolveProof = vi.fn().mockResolvedValue({ ...proof, principal: { ...proof.principal, subject: "different" } });
    expect((await handleRecipientEnrollmentHttp(request("inspect", { intentId, opaqueToken }, csrf), deps)).status).toBe(403);
    expect(deps.binding!.inspectEnrollment).not.toHaveBeenCalled();
  });
  it("rejects cross-origin calls and token query parameters", async () => {
    const deps = dependencies(), cross = request("session"); cross.headers.set("Origin", "https://other.example.test");
    expect((await handleRecipientEnrollmentHttp(cross, deps)).status).toBe(403);
    expect((await handleRecipientEnrollmentHttp(request(`session?token=${opaqueToken}`), deps)).status).toBe(404);
  });
  it("fails closed for missing/expired proof and malformed or unavailable private responses", async () => {
    const deps = dependencies(); deps.resolveProof = vi.fn().mockResolvedValue(null);
    expect((await handleRecipientEnrollmentHttp(request("session"), deps)).status).toBe(401);
    deps.resolveProof = vi.fn().mockResolvedValue({ ...proof, verifiedUntil: "2000-01-01T00:00:00.000Z" });
    expect((await handleRecipientEnrollmentHttp(request("session"), deps)).status).toBe(401);
    deps.resolveProof = vi.fn().mockResolvedValue(proof); const csrf = await session(deps);
    deps.binding!.inspectEnrollment = vi.fn().mockResolvedValue({ intentId, state: "active" });
    expect((await handleRecipientEnrollmentHttp(request("inspect", { intentId, opaqueToken }, csrf), deps)).status).toBe(403);
    deps.binding!.inspectEnrollment = vi.fn().mockRejectedValue(new Error("private storage"));
    const response = await handleRecipientEnrollmentHttp(request("inspect", { intentId, opaqueToken }, csrf), deps);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private storage");
  });
  it("does not issue CSRF after the signed session expires during signing", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-28T00:00:00.000Z"));
    const original = crypto.subtle.sign.bind(crypto.subtle);
    const signing = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (algorithm, key, data) => {
      const result = await original(algorithm, key, data);
      vi.setSystemTime(new Date("2099-01-01T00:00:00.001Z"));
      return result;
    });
    try {
      const response = await handleRecipientEnrollmentHttp(request("session"), dependencies());
      expect(response.status).toBe(401); expect(await response.text()).not.toContain("csrfToken");
    } finally { signing.mockRestore(); vi.useRealTimers(); }
  });
  it("does not expose inspection data after the signed session expires during RPC", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-28T00:00:00.000Z"));
    try {
      const deps = dependencies(), csrf = await session(deps);
      deps.binding!.inspectEnrollment = vi.fn().mockImplementation(async () => {
        vi.setSystemTime(new Date("2099-01-01T00:00:00.001Z"));
        return { intentId, revision: 1, state: "issued", target: { ...target, displayLabel: "Private target" }, expiresAt: "2099-01-01T00:00:00.000Z" };
      });
      const response = await handleRecipientEnrollmentHttp(request("inspect", { intentId, opaqueToken }, csrf), deps);
      expect(response.status).toBe(401); expect(await response.text()).not.toContain("Private target");
    } finally { vi.useRealTimers(); }
  });
});
