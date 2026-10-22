import { describe, expect, it, vi } from "vitest";
import type { OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import { readWindowsPortalPublicationChainEvidence as read } from "../src/worker/windows-portal-publication-chain";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const grant = (): OperationsPortalNativeDeliveryAuthorityCommand => ({
  protocol: "operations-portal-native-delivery-authority", protocolVersion: 1, permissionSchemaVersion: 3,
  action: "delivery.grant", operationId: id(1), authority: { authorityId: id(2), expectedRevision: "0", resultingRevision: "1" },
  target: { targetId: id(3), targetRevision: "1", clientAuthorityId: id(4), workspaceId: "synthetic-workspace",
    rootKind: "standalone_client", rootRecordId: "synthetic-client" },
  recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: "synthetic-client",
    issuer: "https://synthetic.cloudflareaccess.com", subject: "synthetic-recipient", homeOwnershipEpoch: "1", homeGrantRevision: "1",
    homeGrantOperationId: id(7), homeRequestFingerprint: "a".repeat(64) },
  publication: { operationId: id(101), publicationId: id(201), revision: "1", sourceSequence: "1", snapshotId: id(301), snapshotSha256: "b".repeat(64) },
  resource: { folderReservationId: id(11), folderReservationRevision: "1", clientFolderBindingId: "synthetic-folder",
    externalProjectId: "synthetic-project", projectVersion: "1", opsFolderProjectId: "synthetic-physical", opsDivisionId: "synthetic-division",
    selectedR2Prefix: "synthetic/photos/", baseR2Prefix: "synthetic/", baseMatchMethod: "manual", baseConfirmedBy: "synthetic-owner",
    baseConfirmedAt: "2026-10-01T00:00:00.000Z" },
  features: ["file.download"], expiresAt: new Date(Date.now() + 3600_000).toISOString(), reasonCode: "Synthetic chain", observedAt: new Date().toISOString(),
});
const row = (sequence: number) => ({ operation_id: id(100 + sequence), publication_id: id(200 + sequence),
  expected_revision: sequence - 1, revision: sequence, source_sequence: sequence,
  snapshot_id: id(300 + sequence), snapshot_sha256: "b".repeat(64), resource_retained: 1 });
function database(count = 3, mutate: (rows: ReturnType<typeof row>[]) => unknown[] = rows => rows, race = false) {
  let anchors = 0;
  const prepare = vi.fn((sql: string) => ({ bind: (..._args: unknown[]) => ({
    first: async () => ++anchors === 2 && race ? null : row(count),
    all: async () => ({ success: true, results: mutate(Array.from({ length: count }, (_, i) => row(i + 1))) }),
  }) }));
  return { db: { withSession: () => ({ prepare }) } as unknown as D1Database, prepare };
}
describe("bounded Windows publication chain evidence validation", () => {
  it("accepts all 64 retained publications and returns an immutable non-storage proof", async () => {
    const result = await read(database(64).db, grant());
    expect(result).toMatchObject({ publicationCount: 64, first: { revision: 1 }, current: { revision: 64 } });
    expect(result.chainSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.current)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic/photos/");
  });
  it("rejects overflow before scanning history", async () => {
    const test = database(65);
    await expect(read(test.db, grant())).rejects.toThrow("chain_unproven");
    expect(test.prepare).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["missing history", (rows: ReturnType<typeof row>[]) => rows.filter(r => r.source_sequence !== 2)],
    ["duplicate applied sequence", (rows: ReturnType<typeof row>[]) => [rows[0], rows[0], rows[2]]],
    ["omitted then restored resource", (rows: ReturnType<typeof row>[]) => rows.map((r, i) => i === 1 ? { ...r, resource_retained: 0 } : r)],
    ["remap or ownership change", (rows: ReturnType<typeof row>[]) => rows.map((r, i) => i === 2 ? { ...r, resource_retained: 0 } : r)],
    ["non-contiguous predecessor", (rows: ReturnType<typeof row>[]) => rows.map((r, i) => i === 1 ? { ...r, expected_revision: 0 } : r)],
    ["wrong original operation", (rows: ReturnType<typeof row>[]) => rows.map((r, i) => i === 0 ? { ...r, operation_id: id(999) } : r)],
    ["wrong current snapshot", (rows: ReturnType<typeof row>[]) => rows.map((r, i) => i === 2 ? { ...r, snapshot_sha256: "c".repeat(64) } : r)],
  ] as const)("rejects %s", async (_name, mutate) => {
    await expect(read(database(3, mutate).db, grant())).rejects.toThrow("chain_unproven");
  });
  it("rejects revoke or publication races during evidence hashing", async () => {
    await expect(read(database(3, undefined, true).db, grant())).rejects.toThrow("chain_unproven");
  });
  it.each([null, { ...grant(), action: "delivery.revoke", features: [], expiresAt: null },
    { ...grant(), features: ["file.metadata"] }, { ...grant(), expiresAt: "2000-01-01T00:00:00.000Z" }])(
    "rejects invalid, expired or non-download grants before database access", async command => {
      const test = database();
      await expect(read(test.db, command)).rejects.toThrow("chain_unproven");
      expect(test.prepare).not.toHaveBeenCalled();
    });
});
