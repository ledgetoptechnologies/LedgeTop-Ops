import { afterEach, describe, expect, it, vi } from "vitest";
import { issueOperationsNativeRecipientIntent, mutateOperationsNativeRecipientIntent,
  mutateOperationsNativeWorkspaceCleanup, openOperationsNativeRecipientOwnerSession,
  readOperationsNativeRecipientIntent, readOperationsNativeWorkspaceCleanup,
  type OperationsNativeRecipientReview,
  type OperationsNativeWorkspaceCleanupReview } from "../src/client/operations-native-recipient-owner-api";

const intentId = "22222222-2222-4222-8222-222222222222";
const targetId = "11111111-1111-4111-8111-111111111111";
const operationId = "33333333-3333-4333-8333-333333333333";
const bindingId = "44444444-4444-4444-8444-444444444444";
const expiresAt = "2099-01-01T00:00:00.000Z";
const csrf = `123.${"a".repeat(64)}`;
const principal = { issuer: "https://client.cloudflareaccess.com", subject: "access|recipient" };
const pending: OperationsNativeRecipientReview = { intentId, revision: 2, state: "pending",
  target: { targetId, targetRevision: 7, clientRecordId: "client:one" }, principal,
  recipientLabel: "recipient@example.test", recipientBindingId: null, expiresAt, recoveryOperationId: null };

function response(value: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value, { status })));
}
afterEach(() => vi.unstubAllGlobals());

describe("operations-native recipient owner API", () => {
  it("accepts only the bucketed CSRF session and exact HTTPS recipient origin", async () => {
    response({ csrfToken: csrf, verifiedUntil: expiresAt, recipientOrigin: "https://client-staging.example.test" });
    await expect(openOperationsNativeRecipientOwnerSession()).resolves.toMatchObject({ csrfToken: csrf,
      recipientOrigin: "https://client-staging.example.test" });
    for (const changed of [
      { csrfToken: "a".repeat(64), verifiedUntil: expiresAt, recipientOrigin: "https://client-staging.example.test" },
      { csrfToken: csrf, verifiedUntil: expiresAt, recipientOrigin: "https://client-staging.example.test/path" },
      { csrfToken: csrf, verifiedUntil: expiresAt, recipientOrigin: "http://client-staging.example.test" },
    ]) {
      response(changed);
      await expect(openOperationsNativeRecipientOwnerSession()).rejects.toMatchObject({ uncertain: true });
    }
  });

  it("requires fresh issuance to preserve the exact target/client/expiration and return one token", async () => {
    const input = { operationId, targetId, targetClientRecordId: "client:one", expiresAt };
    const issued = { ...pending, revision: 1, state: "issued", principal: null, recipientBindingId: null,
      target: { ...pending.target, targetRevision: 8 }, recoveryOperationId: undefined };
    response({ review: issued, opaqueToken: "b".repeat(64), replayed: false }, 201);
    await expect(issueOperationsNativeRecipientIntent(csrf, input)).resolves.toMatchObject({
      review: { state: "issued", target: { targetId, targetRevision: 8 } }, opaqueToken: "b".repeat(64) });
    for (const changed of [
      { review: { ...issued, target: { ...issued.target, targetId: bindingId } }, opaqueToken: "b".repeat(64), replayed: false },
      { review: issued, replayed: false },
      { review: issued, opaqueToken: "b".repeat(64), replayed: true },
    ]) {
      response(changed);
      await expect(issueOperationsNativeRecipientIntent(csrf, input)).rejects.toMatchObject({ uncertain: true });
    }
  });

  it("reads only an exact owner-reviewed intent and validates its stored recovery operation", async () => {
    const confirming = { ...pending, revision: 3, state: "confirming", recipientBindingId: bindingId,
      recoveryOperationId: operationId };
    response({ intent: confirming });
    await expect(readOperationsNativeRecipientIntent(intentId)).resolves.toMatchObject({ state: "confirming",
      recoveryOperationId: operationId });
    for (const changed of [
      { ...confirming, intentId: bindingId },
      { ...confirming, recoveryOperationId: "not-an-operation" },
      { ...confirming, target: { ...confirming.target, targetRevision: 0 } },
      { ...confirming, principal: { ...principal, issuer: "https://example.test" } },
      { ...confirming, recipientLabel: "\u0000hidden" },
      { ...pending, recipientBindingId: bindingId },
      { ...confirming, recipientBindingId: null },
    ]) {
      response({ intent: changed });
      await expect(readOperationsNativeRecipientIntent(intentId)).rejects.toMatchObject({ uncertain: true });
    }
  });

  it("correlates pending confirmation and recovery to every immutable identity pin", async () => {
    const confirming: OperationsNativeRecipientReview = { ...pending, revision: 3, state: "confirming",
      recipientBindingId: bindingId, recoveryOperationId: operationId };
    response({ operationId, status: "pending", intent: confirming, replayed: false }, 202);
    await expect(mutateOperationsNativeRecipientIntent(csrf, pending, "confirm",
      { operationId, expectedRevision: 2 })).resolves.toMatchObject({ kind: "transport", status: "pending",
      intent: { state: "confirming" } });
    response({ operationId, status: "acknowledged", intent: { ...confirming, revision: 4, state: "active" } });
    await expect(mutateOperationsNativeRecipientIntent(csrf, confirming, "recover",
      { operationId, expectedRevision: 3 })).resolves.toMatchObject({ status: "acknowledged",
      intent: { revision: 4, state: "active" } });
    for (const changed of [
      { ...confirming, target: { ...confirming.target, targetRevision: 8 } },
      { ...confirming, principal: { ...principal, subject: "access|other" } },
      { ...confirming, recipientLabel: "other@example.test" },
    ]) {
      response({ operationId, status: "pending", intent: changed, replayed: false }, 202);
      await expect(mutateOperationsNativeRecipientIntent(csrf, pending, "confirm",
        { operationId, expectedRevision: 2 })).rejects.toMatchObject({ uncertain: true });
    }
    response({ operationId, status: "acknowledged", intent: { ...confirming, revision: 4, state: "active",
      recipientBindingId: targetId } });
    await expect(mutateOperationsNativeRecipientIntent(csrf, confirming, "recover",
      { operationId, expectedRevision: 3 })).rejects.toMatchObject({ uncertain: true });
  });

  it("accepts cancellation only as the exact next immutable audit state", async () => {
    response({ review: { ...pending, revision: 3, state: "cancelled" }, replayed: false });
    await expect(mutateOperationsNativeRecipientIntent(csrf, pending, "cancel",
      { operationId, expectedRevision: 2 })).resolves.toMatchObject({ kind: "cancel",
      review: { revision: 3, state: "cancelled" } });
    response({ review: { ...pending, revision: 3, state: "active" }, replayed: false });
    await expect(mutateOperationsNativeRecipientIntent(csrf, pending, "cancel",
      { operationId, expectedRevision: 2 })).rejects.toMatchObject({ uncertain: true });
  });

  it("reads only an exact owner-authorized workspace cleanup state", async () => {
    const active = { targetId, state: "active", ownershipEpoch: 4, recoveryOperationId: null };
    response({ workspace: active });
    await expect(readOperationsNativeWorkspaceCleanup(targetId)).resolves.toEqual(active);
    for (const changed of [
      { ...active, targetId: bindingId },
      { ...active, ownershipEpoch: 0 },
      { ...active, recoveryOperationId: operationId },
      { ...active, state: "revoking", recoveryOperationId: null },
      { ...active, state: "revoked", recoveryOperationId: "not-an-operation" },
    ]) {
      response({ workspace: changed });
      await expect(readOperationsNativeWorkspaceCleanup(targetId)).rejects.toMatchObject({ uncertain: true });
    }
  });

  it("pins workspace revoke and recovery to the exact target, epoch, and stored operation", async () => {
    const active: OperationsNativeWorkspaceCleanupReview = { targetId, state: "active", ownershipEpoch: 4,
      recoveryOperationId: null };
    const revoking: OperationsNativeWorkspaceCleanupReview = { targetId, state: "revoking", ownershipEpoch: 5,
      recoveryOperationId: operationId };
    response({ operationId, status: "pending", workspace: revoking, replayed: false }, 202);
    await expect(mutateOperationsNativeWorkspaceCleanup(csrf, active, "revoke",
      { operationId, expectedOwnershipEpoch: 4, reason: "Retire exact staging workspace" }))
      .resolves.toMatchObject({ status: "pending", workspace: revoking });
    response({ operationId, status: "acknowledged", workspace: { ...revoking, state: "revoked" } });
    await expect(mutateOperationsNativeWorkspaceCleanup(csrf, revoking, "recover",
      { operationId, expectedOwnershipEpoch: 5 })).resolves.toMatchObject({ status: "acknowledged",
      workspace: { state: "revoked", ownershipEpoch: 5 } });
    response({ operationId, status: "pending", workspace: { ...revoking, targetId: bindingId } }, 202);
    await expect(mutateOperationsNativeWorkspaceCleanup(csrf, active, "revoke",
      { operationId, expectedOwnershipEpoch: 4, reason: "Retire exact staging workspace" }))
      .rejects.toMatchObject({ uncertain: true });
  });

  it("classifies a rejected workspace cleanup fetch as uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    await expect(mutateOperationsNativeWorkspaceCleanup(csrf,
      { targetId, state: "active", ownershipEpoch: 4, recoveryOperationId: null }, "revoke",
      { operationId, expectedOwnershipEpoch: 4, reason: "Retire exact staging workspace" }))
      .rejects.toMatchObject({ status: 503, uncertain: true });
  });
});
