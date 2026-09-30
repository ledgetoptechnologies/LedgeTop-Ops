import { describe, expect, it, vi } from "vitest";
import { handleOperationsNativeRecipientEnrollmentHttp as handle,
  type OperationsNativeRecipientEnrollmentHttpDependencies as Dependencies } from "../src/worker/client-portal/operations-native-recipient-enrollment-http";
import { handleRecipientEnrollmentHttp } from "../src/worker/client-portal/recipient-enrollment-http";
import type { Env } from "../src/worker/types";

const origin = "https://client-staging.example.test", base = `${origin}/api/client/operations/recipient-enrollment`;
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const intentId = id(1), opaqueToken = "a".repeat(64), operationId = id(2);
const target = { targetId: id(3), targetRevision: 1, clientRecordId: "ops/client/example" };
const proof = { principal: { issuer: "https://team.cloudflareaccess.com", subject: "individual-person", email: "not-an-identity@example.invalid" },
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
function deps(): Dependencies { return { env: {} as Env, enabled: true, environment: "staging", origin,
  csrfSecret: "synthetic-native-consent-csrf-secret-long-enough", resolveProof: vi.fn().mockResolvedValue(proof), binding: {
    inspectNativeEnrollment: vi.fn().mockResolvedValue({ intentId, revision: 1, state: "issued",
      target: { ...target, displayLabel: "Example Customer" }, expiresAt: "2099-01-01T00:00:00.000Z" }),
    redeemNativeEnrollment: vi.fn().mockResolvedValue({ intentId, revision: 2, state: "pending" }),
  } }; }
function request(path: string, body?: unknown, token?: string) { return new Request(`${base}/${path}`, {
  method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin",
    "X-Operations-Enrollment-Request": "1", "Content-Type": "application/json", ...(token ? { "X-CSRF-Token": token } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}); }
async function session(d: Dependencies) { const r = await handle(request("session"), d); expect(r.status).toBe(200);
  return (await r.json() as { csrfToken: string }).csrfToken; }
const consent = () => ({ intentId, opaqueToken, operationId, acknowledged: true, acknowledgedTarget: target });

describe("Ops-native individual consent HTTP boundary", () => {
  it("inspects only the explicit native target and sends server-derived subject, never email", async () => {
    const d = deps(), token = await session(d);
    const inspect = await handle(request("inspect", { intentId, opaqueToken }, token), d);
    expect(inspect.status).toBe(200); expect(inspect.headers.get("Cache-Control")).toBe("no-store");
    expect(await inspect.text()).not.toContain(opaqueToken);
    expect(d.binding!.redeemNativeEnrollment).not.toHaveBeenCalled();
    const redeem = await handle(request("redeem", consent(), token), d);
    expect(redeem.status).toBe(200); expect(await redeem.json()).toEqual({ intentId, revision: 2, state: "pending" });
    expect(d.binding!.redeemNativeEnrollment).toHaveBeenCalledWith({ protocolVersion: 1, intentId, opaqueToken, operationId,
      acknowledged: true, acknowledgedTarget: target, principal: { issuer: proof.principal.issuer, subject: proof.principal.subject },
      verifiedUntil: proof.verifiedUntil });
  });
  it.each(["disabled", "production"])("is absent when %s", async mode => {
    const d = deps(); if (mode === "disabled") d.enabled = false; else d.environment = "production";
    expect((await handle(request("session"), d)).status).toBe(404); expect(d.resolveProof).not.toHaveBeenCalled();
  });
  it.each([{ subject: "forged" }, { issuer: "forged" }, { email: "forged" }, { owner: true }, { verifiedUntil: proof.verifiedUntil }])
    ("rejects browser identity/authority input %j", async extra => {
      const d = deps(), token = await session(d);
      expect((await handle(request("redeem", { ...consent(), ...extra }, token), d)).status).toBe(400);
      expect(d.binding!.redeemNativeEnrollment).not.toHaveBeenCalled();
    });
  it("does not translate a legacy selection or accept numeric/string revision ambiguity", async () => {
    const d = deps(), token = await session(d);
    for (const bad of [{ clientRecordId: target.clientRecordId, selectionId: id(4) }, { ...target, targetRevision: "1" },
      { ...target, targetRevision: 0 }, { ...target, targetRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect((await handle(request("redeem", { ...consent(), acknowledgedTarget: bad }, token), d)).status).toBe(400);
    }
    expect(d.binding!.redeemNativeEnrollment).not.toHaveBeenCalled();
  });
  it("binds CSRF to subject and separates it from legacy consent", async () => {
    const d = deps(), token = await session(d);
    d.resolveProof = vi.fn().mockResolvedValue({ ...proof, principal: { ...proof.principal, subject: "same-email-different-person" } });
    expect((await handle(request("redeem", consent(), token), d)).status).toBe(403);
    const legacyRequest = new Request(`${origin}/api/client/v2/recipient-enrollment/session`, { headers: {
      Origin: origin, "Sec-Fetch-Site": "same-origin", "X-Recipient-Enrollment-Request": "1" } });
    const fresh = deps();
    const legacy = await handleRecipientEnrollmentHttp(legacyRequest, { ...fresh, binding: {
      inspectEnrollment: vi.fn(), redeemEnrollment: vi.fn() } });
    const legacyToken = (await legacy.json() as { csrfToken: string }).csrfToken;
    expect((await handle(request("redeem", consent(), legacyToken), fresh)).status).toBe(403);
  });
  it("rejects cross-origin, missing consent, oversized body and bearer query strings", async () => {
    const d = deps(), token = await session(d), cross = request("session"); cross.headers.set("Origin", "https://other.example.test");
    expect((await handle(cross, d)).status).toBe(403);
    expect((await handle(request(`session?token=${opaqueToken}`), d)).status).toBe(404);
    expect((await handle(request("session#unexpected"), d)).status).toBe(404);
    expect((await handle(request("redeem", { ...consent(), acknowledged: false }, token), d)).status).toBe(400);
    expect((await handle(request("inspect", { intentId, opaqueToken, extra: "x".repeat(5000) }, token), d)).status).toBe(400);
    expect(d.binding!.redeemNativeEnrollment).not.toHaveBeenCalled();
  });
  it("does not evaluate private response getters or leak raw transport errors", async () => {
    const d = deps(), token = await session(d); let reads = 0;
    d.binding!.inspectNativeEnrollment = vi.fn().mockResolvedValue(Object.defineProperty({}, "intentId", {
      enumerable: true, get() { reads++; throw Error("private"); } }));
    expect((await handle(request("inspect", { intentId, opaqueToken }, token), d)).status).toBe(403); expect(reads).toBe(0);
    d.binding!.redeemNativeEnrollment = vi.fn().mockRejectedValue(Error("private database error"));
    const r = await handle(request("redeem", consent(), token), d); expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("private database error");
  });
  it("rechecks the Access deadline after asynchronous inspection", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
    try {
      const d = deps(), token = await session(d);
      d.binding!.inspectNativeEnrollment = vi.fn().mockImplementation(async () => {
        vi.setSystemTime(new Date("2099-01-01T00:00:00.001Z"));
        return { intentId, revision: 1, state: "issued", target: { ...target, displayLabel: "Private Customer" }, expiresAt: proof.verifiedUntil };
      });
      const r = await handle(request("inspect", { intentId, opaqueToken }, token), d);
      expect(r.status).toBe(401); expect(await r.text()).not.toContain("Private Customer");
    } finally { vi.useRealTimers(); }
  });
  it("rejects hidden private response members at both envelope and target boundaries", async () => {
    const d = deps(), token = await session(d);
    const selected = { ...target, displayLabel: "Private Customer" };
    Object.defineProperty(selected, "displayLabel", { value: "Private Customer", enumerable: false });
    d.binding!.inspectNativeEnrollment = vi.fn().mockResolvedValue({ intentId, revision: 1, state: "issued",
      target: selected, expiresAt: proof.verifiedUntil });
    const inspect = await handle(request("inspect", { intentId, opaqueToken }, token), d);
    expect(inspect.status).toBe(403);
    expect(await inspect.text()).not.toContain("Private Customer");
    const result = { intentId, revision: 2, state: "pending" };
    Object.defineProperty(result, "state", { value: "pending", enumerable: false });
    d.binding!.redeemNativeEnrollment = vi.fn().mockResolvedValue(result);
    expect((await handle(request("redeem", consent(), token), d)).status).toBe(403);
  });
});
