import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeBillingOwnerApiError, grantNativeBillingAuthority, readNativeBillingAuthority,
  readNativeBillingOwnerSession, revokeNativeBillingAuthority, reviewNativeBillingSelection }
  from "../src/client/operations-native-billing-owner-api";

const base = "/api/native-client-portal/operations-billing-authority";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const targetId = id(1), recipientBindingId = id(2), grantId = id(3), operationId = id(4);
const csrfToken = `123456.${"a".repeat(64)}`;
const entity = { kind: "project" as const, nativeId: "ops/project:alpha" };
const selection = { targetId, recipientBindingId, entity, expiresAt: null };
const review = { ...selection, expectedRevision: 0, reviewFingerprint: "b".repeat(64), grantId: null };
const authority = { ...selection, grantId, revision: 1, state: "active" as const, live: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { "Content-Type": "application/json; charset=utf-8" } });
const asError = async (promise: Promise<unknown>) => {
  try { await promise; throw new Error("expected rejection"); }
  catch (error) { if (error instanceof Error && error.message === "expected rejection") throw error;
    expect(error).toBeInstanceOf(NativeBillingOwnerApiError); return error as NativeBillingOwnerApiError; }
};
afterEach(() => vi.unstubAllGlobals());

describe("native billing owner client API", () => {
  it("uses same-origin, no-store staff requests and requires a valid CSRF token for writes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ review })); vi.stubGlobal("fetch", fetchMock);
    await reviewNativeBillingSelection(csrfToken, selection);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${base}/review`);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(new Headers(init.headers).get("X-Native-Staff-Request")).toBe("1");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe(csrfToken);
    await expect(reviewNativeBillingSelection("invalid", selection)).rejects.toMatchObject({ uncertain: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts only exact, validated JSON and matching reviewed identity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ csrfToken }))
      .mockResolvedValueOnce(json({ review: { ...review, privateLedgerProof: "secret" } }))
      .mockResolvedValueOnce(json({ review: { ...review, entity: { ...entity, nativeId: "other" } } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readNativeBillingOwnerSession()).toEqual({ csrfToken });
    await asError(reviewNativeBillingSelection(csrfToken, selection));
    await asError(reviewNativeBillingSelection(csrfToken, selection));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects oversized, non-JSON, and malformed responses", async () => {
    const tooLarge = new Response(new Uint8Array(65_537), { headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.fn().mockResolvedValueOnce(tooLarge)
      .mockResolvedValueOnce(new Response("{}", { headers: { "Content-Type": "text/plain" } }))
      .mockResolvedValueOnce(new Response("{", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await asError(readNativeBillingOwnerSession());
    await asError(readNativeBillingOwnerSession());
    await asError(readNativeBillingOwnerSession());
  });

  it("requires exact grant identity, operation identity, and monotonic revision", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ status: "applied", operationId, authority }))
      .mockResolvedValueOnce(json({ status: "applied", operationId: id(5), authority }))
      .mockResolvedValueOnce(json({ status: "applied", operationId, authority: { ...authority, revision: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const grant = { ...selection, operationId, grantId, expectedRevision: 0, reviewFingerprint: "b".repeat(64) };
    expect(await grantNativeBillingAuthority(csrfToken, grant)).toEqual({ status: "applied", operationId, authority });
    await asError(grantNativeBillingAuthority(csrfToken, grant));
    await asError(revokeNativeBillingAuthority(csrfToken, { operationId, grantId, expectedRevision: 1 }));
  });

  it("preserves replay status and reports revoked current status without implying reactivation", async () => {
    const revoked = { ...authority, revision: 2, state: "revoked" as const, live: false };
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ status: "replayed", operationId, authority: revoked }))
      .mockResolvedValueOnce(json({ authority: revoked }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await revokeNativeBillingAuthority(csrfToken, { operationId, grantId, expectedRevision: 1 });
    expect(result).toEqual({ status: "replayed", operationId, authority: revoked });
    expect(result.status).toBe("replayed");
    if (result.status !== "replayed") throw new Error("expected replayed revoke");
    expect(result.authority).toMatchObject({ state: "revoked", live: false, revision: 2 });
    expect(await readNativeBillingAuthority(grantId)).toEqual(revoked);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${base}/grants/${grantId}/revoke`);
  });

  it("returns only recognized conflicts and distinguishes denied from uncertain failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: "conflict" }, 409))
      .mockResolvedValueOnce(json({ error: "conflict", reason: "secret" }, 409))
      .mockResolvedValueOnce(json({ error: "denied" }, 403))
      .mockRejectedValueOnce(new Error("network failed"));
    vi.stubGlobal("fetch", fetchMock);
    const input = { operationId, grantId, expectedRevision: 1 };
    expect(await revokeNativeBillingAuthority(csrfToken, input)).toEqual({ status: "conflict", reason: "conflict" });
    await asError(revokeNativeBillingAuthority(csrfToken, input));
    expect(await asError(revokeNativeBillingAuthority(csrfToken, input))).toMatchObject({ status: 403, uncertain: false });
    expect(await asError(revokeNativeBillingAuthority(csrfToken, input))).toMatchObject({ status: 503, uncertain: true });
  });
});
