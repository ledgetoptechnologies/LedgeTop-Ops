import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ claim: vi.fn(), current: vi.fn(), reader: vi.fn() }));
vi.mock("../src/worker/operations-portal-native-delivery-recovery-invocations", () => ({
  claimOperationsPortalNativeDeliveryRecoveryInvocation: calls.claim,
  currentOperationsPortalNativeDeliveryRecoveryInvocation: calls.current,
}));
vi.mock("../src/worker/operations-portal-native-delivery-authority-reader", () => ({
  verifyOperationsPortalNativeDeliveryGrantForDispatch: calls.reader,
}));
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand,
  parseOperationsPortalNativeDeliveryAuthorityCommand, sha256OperationsPortalNativeDeliveryAuthorityCommand }
  from "@ltds/shared/operations-portal-native-delivery-authority";
import { dispatchNextOperationsPortalNativeDeliveryAuthority }
  from "../src/worker/operations-portal-native-delivery-authority-dispatch";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

async function fixture() {
  const command = parseOperationsPortalNativeDeliveryAuthorityCommand({
    protocol: "operations-portal-native-delivery-authority", protocolVersion: 1, permissionSchemaVersion: 3,
    action: "delivery.grant", operationId: id(1),
    authority: { authorityId: id(2), expectedRevision: "0", resultingRevision: "1" },
    target: { targetId: id(3), targetRevision: "1", clientAuthorityId: id(4), workspaceId: "workspace",
      rootKind: "organization", rootRecordId: "root" },
    recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: "client",
      issuer: "https://synthetic.cloudflareaccess.com", subject: "recipient", homeOwnershipEpoch: "1",
      homeGrantRevision: "1", homeGrantOperationId: id(7), homeRequestFingerprint: "a".repeat(64) },
    publication: { operationId: id(8), publicationId: id(9), revision: "1", sourceSequence: "1",
      snapshotId: id(10), snapshotSha256: "b".repeat(64) },
    resource: { folderReservationId: id(11), folderReservationRevision: "1", clientFolderBindingId: "binding",
      externalProjectId: "project", projectVersion: "1", opsFolderProjectId: "folder", opsDivisionId: "division",
      selectedR2Prefix: "projects/selected/", baseR2Prefix: "projects/", baseMatchMethod: "manual",
      baseConfirmedBy: "manager", baseConfirmedAt: "2026-09-30T12:00:00.000Z" },
    features: ["file.download"], expiresAt: "2026-10-01T12:00:00.000Z", reasonCode: "share",
    observedAt: "2026-09-30T12:00:00.000Z",
  });
  if (!command) throw new Error("invalid fixture command");
  const canonical = canonicalOperationsPortalNativeDeliveryAuthorityCommand(command);
  const fingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(command);
  const releases: unknown[][] = [];
  const prepare = (sql: string) => ({ bind: (...values: unknown[]) => ({
    first: async () => {
      if (sql.startsWith("SELECT 1 FROM operations_portal_native_delivery_authority_receipts")) return null;
      if (sql.includes("SELECT outbox.operation_id,command.action")) return { operation_id: command.operationId,
        action: command.action, request_fingerprint: fingerprint, canonical_wire_json: canonical,
        state: "dispatching", attempt_count: 1, claim_token: values[1] };
      return null;
    },
    run: async () => { if (sql.includes("SET state=?")) releases.push(values); return { meta: { changes: 1 } }; },
  }) });
  return { command, fingerprint, releases,
    database: { withSession: () => ({ prepare }) } as unknown as D1Database };
}

describe("native delivery manual recovery final actor proof", () => {
  beforeEach(() => { vi.clearAllMocks(); calls.claim.mockResolvedValue(true); calls.reader.mockResolvedValue(true); });

  it("does not apply when the current manager loses authority during the resource proof await", async () => {
    const value = await fixture();
    calls.current.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const apply = vi.fn(), status = vi.fn(async () => JSON.stringify({ ok: false, protocolVersion: 1,
      code: "not_found", retryable: false }));
    await expect(dispatchNextOperationsPortalNativeDeliveryAuthority({ database: value.database,
      operationId: value.command.operationId, recoveryInvocationId: id(12),
      binding: { applyNativeDeliveryAuthority: apply, getNativeDeliveryAuthorityStatus: status } }))
      .resolves.toEqual({ operationId: value.command.operationId, state: "retry" });
    expect(calls.current).toHaveBeenCalledTimes(2);
    expect(calls.reader).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(value.releases[0]?.[2]).toBe("recovery_invoker_changed");
  });
});
