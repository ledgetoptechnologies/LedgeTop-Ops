import { describe, expect, it } from "vitest";
import {
  canonicalOperationsPortalNativeDeliveryAuthorityCommand,
  parseOperationsPortalNativeDeliveryAuthorityCommand,
  parseOperationsPortalNativeDeliveryAuthorityReceipt,
  sha256OperationsPortalNativeDeliveryAuthorityCommand,
} from "@ltds/shared/operations-portal-native-delivery-authority";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const command = () => ({
  protocol: "operations-portal-native-delivery-authority", protocolVersion: 1, permissionSchemaVersion: 3,
  action: "delivery.grant", operationId: id(1),
  authority: { authorityId: id(2), expectedRevision: "0", resultingRevision: "1" },
  target: { targetId: id(3), targetRevision: "2", clientAuthorityId: id(4), workspaceId: "workspace",
    rootKind: "organization", rootRecordId: "root" },
  recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: "client",
    issuer: "https://tenant.cloudflareaccess.com", subject: "recipient", homeOwnershipEpoch: "1",
    homeGrantRevision: "3", homeGrantOperationId: id(7), homeRequestFingerprint: "a".repeat(64) },
  publication: { operationId: id(8), publicationId: id(9), revision: "4", sourceSequence: "4",
    snapshotId: id(10), snapshotSha256: "b".repeat(64) },
  resource: { folderReservationId: id(11), folderReservationRevision: "5", clientFolderBindingId: "binding",
    externalProjectId: "project", projectVersion: "6", opsFolderProjectId: "ops-project", opsDivisionId: "division",
    selectedR2Prefix: "projects/ops/selected/", baseR2Prefix: "projects/ops/", baseMatchMethod: "manual",
    baseConfirmedBy: "staff", baseConfirmedAt: "2026-09-30T12:00:00.000Z" },
  features: ["folder.list", "file.metadata", "file.preview", "file.download"],
  expiresAt: "2026-10-01T12:00:00.000Z", reasonCode: "explicit folder share", observedAt: "2026-09-30T12:00:00.000Z",
});

describe("operations native delivery authority contract", () => {
  it("canonicalizes exact resource and recipient pins", async () => {
    const parsed = parseOperationsPortalNativeDeliveryAuthorityCommand(command());
    expect(parsed).toEqual(command());
    expect(JSON.parse(canonicalOperationsPortalNativeDeliveryAuthorityCommand(command()))).toEqual(command());
    expect(await sha256OperationsPortalNativeDeliveryAuthorityCommand(command())).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects extra keys, unordered features, invalid containment, and grant without expiry", () => {
    expect(parseOperationsPortalNativeDeliveryAuthorityCommand({ ...command(), forged: true })).toBeNull();
    expect(parseOperationsPortalNativeDeliveryAuthorityCommand({ ...command(), features: ["file.download", "folder.list"] })).toBeNull();
    expect(parseOperationsPortalNativeDeliveryAuthorityCommand({ ...command(), resource: {
      ...command().resource, selectedR2Prefix: "other/selected/" } })).toBeNull();
    expect(parseOperationsPortalNativeDeliveryAuthorityCommand({ ...command(), expiresAt: null })).toBeNull();
  });

  it("accepts a historical revoke with copied pins and no features or expiry", () => {
    const revoke = { ...command(), action: "delivery.revoke", features: [], expiresAt: null };
    expect(parseOperationsPortalNativeDeliveryAuthorityCommand(revoke)).toEqual(revoke);
    expect(parseOperationsPortalNativeDeliveryAuthorityCommand({ ...revoke, expiresAt: undefined })).toBeNull();
    expect(parseOperationsPortalNativeDeliveryAuthorityCommand({ ...revoke, expiresAt: 0 })).toBeNull();
    expect(parseOperationsPortalNativeDeliveryAuthorityCommand({ ...command(),
      expiresAt: "2026-11-01T12:00:00.000Z" })).toBeNull();
  });

  it("matches exact receipts to the command and fingerprint", () => {
    const parsed = parseOperationsPortalNativeDeliveryAuthorityCommand(command())!;
    const receipt = { protocol: parsed.protocol, protocolVersion: 1, status: "recorded", operationId: parsed.operationId,
      requestFingerprint: "c".repeat(64), action: parsed.action, authorityId: parsed.authority.authorityId,
      recipientBindingId: parsed.recipient.recipientBindingId, folderReservationId: parsed.resource.folderReservationId,
      resultingRevision: parsed.authority.resultingRevision, resultingState: "active" };
    expect(parseOperationsPortalNativeDeliveryAuthorityReceipt(receipt, parsed, "c".repeat(64))).toEqual(receipt);
    expect(parseOperationsPortalNativeDeliveryAuthorityReceipt({ ...receipt, folderReservationId: id(99) }, parsed,
      "c".repeat(64))).toBeNull();
  });
});
