import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVerifiedRecipientDeliveryAuthorityReceipt,
  type VerifiedRecipientDeliveryAuthorityCommand,
} from "@ltds/shared/verified-recipient-delivery-authority";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../src/worker/verified-recipient-delivery-authority", () => ({
  applyVerifiedRecipientDeliveryAuthority: vi.fn(),
  getVerifiedRecipientDeliveryAuthorityStatus: vi.fn(),
}));
import { applyVerifiedRecipientDeliveryAuthority, getVerifiedRecipientDeliveryAuthorityStatus }
  from "../src/worker/verified-recipient-delivery-authority";
import { applyVerifiedRecipientDeliveryAuthorityRpc, getVerifiedRecipientDeliveryAuthorityStatusRpc,
  VerifiedRecipientDeliveryAuthorityIngress } from "../src/worker/verified-recipient-delivery-authority-entrypoint";

const writer = vi.mocked(applyVerifiedRecipientDeliveryAuthority);
const reader = vi.mocked(getVerifiedRecipientDeliveryAuthorityStatus);
const env = {
  DELIVERY_DB: {} as D1Database,
  ENVIRONMENT: "staging",
  EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com",
  CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED: "true",
  CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED: "true",
};
const command: VerifiedRecipientDeliveryAuthorityCommand = {
  protocol: "verified-recipient-delivery-authority", protocolVersion: 1, action: "upsert",
  operationId: "11111111-1111-4111-8111-111111111111",
  recipient: { recipientBindingId: "22222222-2222-4222-8222-222222222222",
    enrollmentIntentId: "33333333-3333-4333-8333-333333333333", enrollmentRevision: 4,
    issuer: "https://access.example.test", subject: "recipient-1" },
  selection: { selectionId: "44444444-4444-4444-8444-444444444444",
    clientAuthorityId: "55555555-5555-4555-8555-555555555555", clientRecordId: "client-1", workspaceId: "workspace-1" },
  homeAuthority: { ownershipEpoch: 1, grantRevision: 1,
    grantOperationId: "77777777-7777-4777-8777-777777777777" },
  resource: { folderBindingId: "folder-1", folderBindingSourceVersion: "version-1",
    sourceId: "project-alpha:secondary", projectPublicId: "project-1", projectSourceVersion: "project-version-1",
    currentGenerationId: "generation-1" },
  authority: { authorityId: "66666666-6666-4666-8666-666666666666", expectedRevision: 0, resultingRevision: 1 },
  terms: { reasonCode: "Client data review", expiresAt: null,
    accessTerms: { id: "terms-1", kind: "customer", mode: "until_revoked", reviewedExpiresAt: null, effectiveExpiresAt: null } },
  ownerProof: { staffId: "owner-1", verifiedAccessSubject: "owner-subject", admissionVersion: 1,
    profileVersion: 1, grantGeneration: 1, verifiedUntil: "2030-01-01T00:00:00.000Z" },
};

describe("verified-recipient private delivery authority RPC", () => {
  beforeEach(() => { writer.mockReset(); reader.mockReset(); });

  it("is default-off before inspecting input or accessing storage", async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("must not inspect"); } });
    for (const flag of [undefined, "false", "TRUE", "1"]) {
      await expect(applyVerifiedRecipientDeliveryAuthorityRpc({ ...env,
        CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED: flag }, hostile))
        .resolves.toMatchObject({ ok: false, code: "disabled", retryable: true });
      await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc({ ...env,
        CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED: flag }, hostile))
        .resolves.toMatchObject({ ok: false, code: "disabled", retryable: true });
    }
    expect(writer).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
  });

  it("denies missing, production, and wrong-host environments before storage", async () => {
    for (const candidate of [
      { ...env, ENVIRONMENT: undefined }, { ...env, ENVIRONMENT: "production" },
      { ...env, EXPECTED_HOST: undefined }, { ...env, EXPECTED_HOST: "portal.ledgetopdroneservices.com" },
    ]) await expect(applyVerifiedRecipientDeliveryAuthorityRpc(candidate, command))
      .resolves.toMatchObject({ ok: false, code: "disabled" });
    expect(writer).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
  });

  it("rejects hostile, extra-field and operation-only inputs without storage", async () => {
    for (const input of [null, { ...command, owner: true }, { operationId: command.operationId },
      new Proxy({}, { getPrototypeOf() { throw new Error("private error"); } })]) {
      await expect(applyVerifiedRecipientDeliveryAuthorityRpc(env, input))
        .resolves.toMatchObject({ ok: false, code: "invalid", retryable: false });
      await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(env, input))
        .resolves.toMatchObject({ ok: false, code: "invalid", retryable: false });
    }
    expect(writer).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
  });

  it("returns only the exact durable closed receipt", async () => {
    const receipt = createVerifiedRecipientDeliveryAuthorityReceipt(command, "recorded");
    writer.mockResolvedValueOnce(receipt);
    await expect(applyVerifiedRecipientDeliveryAuthorityRpc(env, command)).resolves.toEqual({ ok: true, receipt });
    expect(writer).toHaveBeenCalledWith(env, command);
  });

  it("recovers using the full command and never mutates in status", async () => {
    const receipt = createVerifiedRecipientDeliveryAuthorityReceipt(command, "replayed");
    reader.mockResolvedValueOnce(receipt);
    await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(env, command)).resolves.toEqual({ ok: true, receipt });
    expect(reader).toHaveBeenCalledWith(env, command); expect(writer).not.toHaveBeenCalled();
    reader.mockResolvedValueOnce(null);
    await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(env, command))
      .resolves.toMatchObject({ ok: false, code: "not_found", retryable: false });
  });

  it("fails closed on a mismatched durable receipt instead of echoing the caller", async () => {
    const other = { ...command, recipient: { ...command.recipient, subject: "other-person" } };
    writer.mockResolvedValueOnce(createVerifiedRecipientDeliveryAuthorityReceipt(other, "recorded"));
    await expect(applyVerifiedRecipientDeliveryAuthorityRpc(env, command))
      .resolves.toMatchObject({ ok: false, code: "conflict", retryable: false });
    reader.mockResolvedValueOnce(createVerifiedRecipientDeliveryAuthorityReceipt(other, "replayed"));
    await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(env, command))
      .resolves.toMatchObject({ ok: false, code: "conflict", retryable: false });
  });

  it("returns no active capabilities for an acknowledged revoke", async () => {
    const revoke = { ...command, action: "revoke" as const,
      authority: { ...command.authority, expectedRevision: 1, resultingRevision: 2 } };
    writer.mockResolvedValueOnce(createVerifiedRecipientDeliveryAuthorityReceipt(revoke, "recorded"));
    await expect(applyVerifiedRecipientDeliveryAuthorityRpc(env, revoke)).resolves.toMatchObject({
      ok: true, receipt: { resultingState: "revoked", capabilities: [], affectedScopes: [
        { capability: "workspace.view", scopeType: "workspace", scopeId: "workspace-1" },
        { capability: "delivery.view", scopeType: "folder", scopeId: "folder-1" },
      ] },
    });
  });

  it("sanitizes transport/storage failures without command bytes or database details", async () => {
    writer.mockRejectedValueOnce(new Error("SQL private subject/credential details"));
    const failed = await applyVerifiedRecipientDeliveryAuthorityRpc(env, command);
    expect(failed).toEqual({ ok: false, protocol: command.protocol, protocolVersion: 1,
      code: "temporarily-unavailable", retryable: true });
    writer.mockRejectedValueOnce(new Error("verified-recipient-delivery-authority-cas-conflict"));
    await expect(applyVerifiedRecipientDeliveryAuthorityRpc(env, command))
      .resolves.toMatchObject({ ok: false, code: "conflict", retryable: false });
    reader.mockRejectedValueOnce(new Error("verified-recipient-delivery-authority-status-disabled"));
    await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(env, command))
      .resolves.toMatchObject({ ok: false, code: "disabled", retryable: true });
  });

  it("does not expose its authority methods over HTTP", async () => {
    const response = await VerifiedRecipientDeliveryAuthorityIngress.prototype.fetch();
    expect(response.status).toBe(404); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(writer).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
  });

  it("sanitizes hostile exception objects without reading message accessors", async () => {
    const accessor = new Error();
    const messageGetter = vi.fn(() => { throw new Error("private exception details"); });
    Object.defineProperty(accessor, "message", { get: messageGetter });
    const nonString = new Error();
    Object.defineProperty(nonString, "message", { value: null });
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("private prototype details"); } });
    for (const error of [accessor, nonString, hostile]) {
      writer.mockRejectedValueOnce(error);
      reader.mockRejectedValueOnce(error);
      await expect(applyVerifiedRecipientDeliveryAuthorityRpc(env, command))
        .resolves.toMatchObject({ ok: false, code: "temporarily-unavailable", retryable: true });
      await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(env, command))
        .resolves.toMatchObject({ ok: false, code: "temporarily-unavailable", retryable: true });
    }
    expect(messageGetter).not.toHaveBeenCalled();
  });
});
