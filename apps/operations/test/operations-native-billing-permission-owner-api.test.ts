import { afterEach, describe, expect, it, vi } from "vitest";
import { issueNativeBillingPermission, NativeBillingPermissionOwnerApiError, readNativeBillingPermissionSession,
  reviewNativeBillingPermission, revokeNativeBillingPermission } from "../src/client/operations-native-billing-permission-owner-api";

const base = "/api/native-client-portal/operations-billing-permissions";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const csrf = `123.${"a".repeat(64)}`, staffId = "staff:billing-manager", resourceId = "ops/project:alpha";
const review = { staffId, resourceId, generation: 2, permissions: [
  { grantId: id(1), effect: "allow", scopeKind: "resource", resourceId, revoked: false },
] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { "Content-Type": "application/json; charset=utf-8" } });
const rejected = async (promise: Promise<unknown>) => {
  try { await promise; throw new Error("expected rejection"); }
  catch (error) { if (error instanceof Error && error.message === "expected rejection") throw error;
    expect(error).toBeInstanceOf(NativeBillingPermissionOwnerApiError); return error as NativeBillingPermissionOwnerApiError; }
};
afterEach(() => vi.unstubAllGlobals());

describe("native billing permission owner API", () => {
  it("loads only a bucketed CSRF session and sends same-origin no-store owner requests", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ csrfToken: csrf })).mockResolvedValueOnce(json({ review }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readNativeBillingPermissionSession()).toEqual({ csrfToken: csrf });
    expect(await reviewNativeBillingPermission(csrf, { staffId, resourceId })).toEqual(review);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${base}/review`);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe(csrf);
    expect(new Headers(init.headers).get("X-Native-Staff-Request")).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({ staffId, resourceId });
  });

  it("accepts only bounded active resource rows and rejects global, revoked, duplicate, or mismatched rows", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ review })).mockResolvedValueOnce(json({ review: { ...review,
      permissions: [...review.permissions, { ...review.permissions[0], grantId: id(1) }] } }))
      .mockResolvedValueOnce(json({ review: { ...review, permissions: Array.from({ length: 101 }, (_, i) =>
        ({ grantId: id(i + 1), effect: "allow", scopeKind: "resource", resourceId, revoked: false })) } }))
      .mockResolvedValueOnce(json({ review: { ...review, permissions: [{ ...review.permissions[0], resourceId: "ops/other" }] } }))
      .mockResolvedValueOnce(json({ review: { ...review, permissions: [{ ...review.permissions[0],
        scopeKind: "global", resourceId: null }] } }))
      .mockResolvedValueOnce(json({ review: { ...review, permissions: [{ ...review.permissions[0], revoked: true }] } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await reviewNativeBillingPermission(csrf, { staffId, resourceId })).toEqual(review);
    await rejected(reviewNativeBillingPermission(csrf, { staffId, resourceId }));
    await rejected(reviewNativeBillingPermission(csrf, { staffId, resourceId }));
    await rejected(reviewNativeBillingPermission(csrf, { staffId, resourceId }));
    await rejected(reviewNativeBillingPermission(csrf, { staffId, resourceId }));
    await rejected(reviewNativeBillingPermission(csrf, { staffId, resourceId }));
  });

  it("pins issue and revoke responses to exact operation, grant, and next generation", async () => {
    const operationId = id(3), grantId = id(4);
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ status: "applied", operationId, grantId, generation: 3 }))
      .mockResolvedValueOnce(json({ status: "replayed", operationId, grantId, generation: 3 }))
      .mockResolvedValueOnce(json({ status: "applied", operationId: id(5), grantId, generation: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const issue = { operationId, grantId, expectedGeneration: 2, staffId, effect: "allow" as const, resourceId };
    expect(await issueNativeBillingPermission(csrf, issue)).toEqual({ status: "applied", operationId, grantId, generation: 3 });
    expect(await issueNativeBillingPermission(csrf, issue)).toEqual({ status: "replayed", operationId, grantId, generation: 3 });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ confirm: true, ...issue });
    await rejected(revokeNativeBillingPermission(csrf, { operationId, grantId, expectedGeneration: 2 }));
    const [revokePath, revokeInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(revokePath).toBe(`${base}/grants/${grantId}/revoke`);
    expect(JSON.parse(String(revokeInit.body))).toEqual({ confirm: true, operationId, expectedGeneration: 2 });
    expect(Object.keys(JSON.parse(String(revokeInit.body))).sort()).toEqual(["confirm", "operationId", "expectedGeneration"].sort());
  });

  it("accepts only exact generic conflicts and classifies denial versus uncertainty", async () => {
    const operationId = id(6), grantId = id(7), input = { operationId, grantId, expectedGeneration: 2 };
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: "conflict" }, 409))
      .mockResolvedValueOnce(json({ error: "conflict", reason: "generation" }, 409))
      .mockResolvedValueOnce(json({ error: "denied" }, 403)).mockRejectedValueOnce(new TypeError("network"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await revokeNativeBillingPermission(csrf, input)).toEqual({ status: "conflict" });
    await rejected(revokeNativeBillingPermission(csrf, input));
    expect(await rejected(revokeNativeBillingPermission(csrf, input))).toMatchObject({ status: 403, uncertain: false });
    expect(await rejected(revokeNativeBillingPermission(csrf, input))).toMatchObject({ status: 503, uncertain: true });
  });

  it("enforces response byte bounds, JSON content type, and local selection validation", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(65_537), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response("{}", { headers: { "Content-Type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);
    await rejected(readNativeBillingPermissionSession()); await rejected(readNativeBillingPermissionSession());
    await rejected(reviewNativeBillingPermission(csrf, { staffId: "contains space", resourceId }));
    await rejected(issueNativeBillingPermission("bad", { operationId: id(8), grantId: id(9), expectedGeneration: 2,
      staffId, effect: "allow", resourceId }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
