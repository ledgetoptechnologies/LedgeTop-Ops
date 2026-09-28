import { afterEach, describe, expect, it, vi } from "vitest";
import { issueEnrollmentIntent, listEnrollmentIntents, mutateEnrollmentIntent, newEnrollmentOperationId, openEnrollmentOwnerSession, type EnrollmentReview }
  from "../src/client/client-portal-recipient-enrollment-owner-api";

const intentId = "22222222-2222-4222-8222-222222222222";
const selectionId = "11111111-1111-4111-8111-111111111111";
const operationId = "33333333-3333-4333-8333-333333333333";
const expiresAt = "2099-01-01T00:00:00.000Z";
const principal = { issuer: "https://client.cloudflareaccess.com", subject: "access|recipient" };
const pending: EnrollmentReview = { intentId, revision: 2, state: "pending", target: { clientRecordId: "client:one", selectionId },
  principal, expiresAt };

function response(value: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value, { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("recipient enrollment owner response correlation", () => {
  it("rejects impossible lifecycle/principal shapes and nonpositive revisions in owner lists", async () => {
    for (const changed of [{ ...pending, revision: 0 }, { ...pending, revision: -1 },
      { ...pending, state: "issued" }, { ...pending, principal: null },
      { ...pending, state: "active", principal: null }, { ...pending, state: "revoked", principal: null }]) {
      response({ intents: [changed] });
      await expect(listEnrollmentIntents()).rejects.toMatchObject({ uncertain: true });
    }
    response({ intents: [{ ...pending, state: "cancelled" }, { ...pending, state: "cancelled", principal: null }] });
    await expect(listEnrollmentIntents()).resolves.toHaveLength(2);
  });
  it("generates a standards-shaped v4 operation ID when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", { getRandomValues: <T extends ArrayBufferView>(value: T) => {
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0xab); return value;
    } });
    expect(newEnrollmentOperationId()).toBe("abababab-abab-4bab-abab-abababababab");
  });

  it("accepts only the server-validated exact HTTPS recipient origin", async () => {
    response({ csrfToken: "a".repeat(64), verifiedUntil: expiresAt, recipientOrigin: "https://client-staging.example.test" });
    await expect(openEnrollmentOwnerSession()).resolves.toMatchObject({ recipientOrigin: "https://client-staging.example.test" });
    for (const recipientOrigin of ["http://client-staging.example.test", "https://client-staging.example.test/path", "not a URL"]) {
      response({ csrfToken: "a".repeat(64), verifiedUntil: expiresAt, recipientOrigin });
      await expect(openEnrollmentOwnerSession()).rejects.toMatchObject({ uncertain: true });
    }
  });

  it("requires a fresh issuance to return the exact issued target and one-time token", async () => {
    const input = { operationId, selectionId, clientRecordId: "client:one", expiresAt };
    response({ ...pending, revision: 1, state: "issued", principal: null, opaqueToken: "b".repeat(64), replayed: false });
    await expect(issueEnrollmentIntent("a".repeat(64), input)).resolves.toMatchObject({ opaqueToken: "b".repeat(64), replayed: false });
    for (const changed of [
      { ...pending, revision: 2, state: "issued", principal: null, opaqueToken: "b".repeat(64), replayed: false },
      { ...pending, revision: 1, state: "issued", target: { ...pending.target, clientRecordId: "client:other" }, principal: null,
        opaqueToken: "b".repeat(64), replayed: false },
      { ...pending, revision: 1, state: "issued", principal: null, replayed: false },
      { ...pending, revision: 1, state: "issued", principal: null, opaqueToken: "b".repeat(64), replayed: true },
    ]) {
      response(changed);
      await expect(issueEnrollmentIntent("a".repeat(64), input)).rejects.toMatchObject({ uncertain: true });
    }
  });

  it("accepts an issuance replay only when the one-time token is absent", async () => {
    const input = { operationId, selectionId, clientRecordId: "client:one", expiresAt };
    response({ ...pending, revision: 1, state: "issued", principal: null, replayed: true });
    await expect(issueEnrollmentIntent("a".repeat(64), input)).resolves.toMatchObject({ opaqueToken: null, replayed: true });
  });

  it("correlates confirmation to the operation, intent, target, principal, state, and next revision", async () => {
    response({ operationId, status: "acknowledged", intent: { ...pending, revision: 3, state: "active" } });
    await expect(mutateEnrollmentIntent("a".repeat(64), pending, "confirm", operationId)).resolves.toMatchObject({
      review: { intentId, revision: 3, state: "active" }, status: "acknowledged",
    });
    for (const changed of [
      { operationId: "44444444-4444-4444-8444-444444444444", status: "acknowledged", intent: { ...pending, revision: 3, state: "active" } },
      { operationId, status: "acknowledged", intent: { ...pending, revision: 4, state: "active" } },
      { operationId, status: "acknowledged", intent: { ...pending, revision: 3, state: "active",
        principal: { ...principal, subject: "access|other" } } },
      { operationId, status: "acknowledged", intent: { ...pending, revision: 3, state: "active",
        target: { ...pending.target, selectionId: "55555555-5555-4555-8555-555555555555" } } },
    ]) {
      response(changed);
      await expect(mutateEnrollmentIntent("a".repeat(64), pending, "confirm", operationId)).rejects.toMatchObject({ uncertain: true });
    }
  });

  it("requires exact next-state correlation for revoke and reconcile", async () => {
    const active: EnrollmentReview = { ...pending, revision: 3, state: "active" };
    response({ operationId, status: "pending", intent: { ...active, revision: 4, state: "revoking" } }, 202);
    await expect(mutateEnrollmentIntent("a".repeat(64), active, "revoke", operationId)).resolves.toMatchObject({
      review: { revision: 4, state: "revoking" }, status: "pending",
    });
    const revoking: EnrollmentReview = { ...active, revision: 4, state: "revoking" };
    response({ review: { ...revoking, revision: 5, state: "revoked" }, replayed: false });
    await expect(mutateEnrollmentIntent("a".repeat(64), revoking, "reconcile", operationId)).resolves.toMatchObject({
      review: { revision: 5, state: "revoked" }, status: "acknowledged",
    });
    response({ review: { ...revoking, revision: 5, state: "active" }, replayed: false });
    await expect(mutateEnrollmentIntent("a".repeat(64), revoking, "reconcile", operationId)).rejects.toMatchObject({ uncertain: true });
  });

  it("correlates cancellation to an issued or pending intent and never accepts a grant state", async () => {
    response({ operationId, status: "acknowledged", intent: { ...pending, revision: 3, state: "cancelled" }, receipt: null, replayed: false });
    await expect(mutateEnrollmentIntent("a".repeat(64), pending, "cancel", operationId)).resolves.toMatchObject({
      review: { intentId, revision: 3, state: "cancelled" }, status: "acknowledged",
    });
    response({ operationId, status: "acknowledged", intent: { ...pending, revision: 3, state: "active" }, replayed: false });
    await expect(mutateEnrollmentIntent("a".repeat(64), pending, "cancel", operationId)).rejects.toMatchObject({ uncertain: true });
  });

  it("rejects ambiguous cancellation status and missing replay discrimination", async () => {
    const valid = { operationId, status: "acknowledged", intent: { ...pending, revision: 3, state: "cancelled" }, receipt: null, replayed: false };
    for (const changed of [ { ...valid, status: "pending" }, { ...valid, replayed: undefined }, { ...valid, replayed: "true" },
      { ...valid, receipt: undefined }, { ...valid, receipt: { intentId, revision: 3, state: "cancelled" } } ]) {
      response(changed);
      await expect(mutateEnrollmentIntent("a".repeat(64), pending, "cancel", operationId)).rejects.toMatchObject({ uncertain: true });
    }
  });

  it("parses only a correlated immutable cancellation replay receipt, never a new mutation", async () => {
    // Parser-only contract: current runtime still denies loss-of-target-visibility
    // retries until the separately requested authorization has been approved.
    const valid = { operationId, status: "acknowledged", intent: null, replayed: true,
      receipt: { intentId, revision: 3, state: "cancelled" } };
    response(valid);
    await expect(mutateEnrollmentIntent("a".repeat(64), pending, "cancel", operationId)).resolves.toMatchObject({
      review: null, receipt: { intentId, revision: 3, state: "cancelled" }, status: "acknowledged" });
    for (const changed of [ { ...valid, replayed: false }, { ...valid, replayed: undefined },
      { ...valid, operationId: "44444444-4444-4444-8444-444444444444" },
      { ...valid, receipt: { ...valid.receipt, revision: 4 } },
      { ...valid, receipt: { ...valid.receipt, intentId: "55555555-5555-4555-8555-555555555555" } } ]) {
      response(changed);
      await expect(mutateEnrollmentIntent("a".repeat(64), pending, "cancel", operationId)).rejects.toMatchObject({ uncertain: true });
    }
    response(valid);
    await expect(mutateEnrollmentIntent("a".repeat(64), { ...pending, state: "active" }, "cancel", operationId))
      .rejects.toMatchObject({ uncertain: true });
  });
});
