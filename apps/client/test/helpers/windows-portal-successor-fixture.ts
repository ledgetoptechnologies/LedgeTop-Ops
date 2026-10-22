import type { OperationsPortalNativeDeliveryAuthorityCommand, OperationsPortalNativeDeliveryAuthorizationProof,
  OperationsPortalNativeDeliverySuccessorAuthorization } from "@ltds/shared/operations-portal-native-delivery-authority";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, sha256OperationsPortalNativeDeliveryAuthorityCommand }
  from "@ltds/shared/operations-portal-native-delivery-authority";
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const principal = { issuer: "https://synthetic.cloudflareaccess.com", subject: "synthetic-recipient" };
export function grant(): OperationsPortalNativeDeliveryAuthorityCommand {
  return { protocol: "operations-portal-native-delivery-authority", protocolVersion: 1, permissionSchemaVersion: 3,
    action: "delivery.grant", operationId: id(1), authority: { authorityId: id(2), expectedRevision: "0", resultingRevision: "1" },
    target: { targetId: id(3), targetRevision: "1", clientAuthorityId: id(4), workspaceId: "synthetic-workspace",
      rootKind: "standalone_client", rootRecordId: "synthetic-client" },
    recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: "synthetic-client", ...principal,
      homeOwnershipEpoch: "1", homeGrantRevision: "1", homeGrantOperationId: id(7), homeRequestFingerprint: "a".repeat(64) },
    publication: { operationId: id(101), publicationId: id(201), revision: "1", sourceSequence: "1", snapshotId: id(301), snapshotSha256: "b".repeat(64) },
    resource: { folderReservationId: id(11), folderReservationRevision: "1", clientFolderBindingId: "synthetic-folder",
      externalProjectId: "synthetic-project", projectVersion: "1", opsFolderProjectId: "synthetic-physical", opsDivisionId: "synthetic-division",
      selectedR2Prefix: "synthetic/photos/", baseR2Prefix: "synthetic/", baseMatchMethod: "manual", baseConfirmedBy: "synthetic-owner",
      baseConfirmedAt: "2026-10-01T00:00:00.000Z" },
    features: ["file.download"], expiresAt: new Date(Date.now() + 3600_000).toISOString(), reasonCode: "Synthetic successor",
    observedAt: new Date().toISOString() };
}
export async function fixture() {
  const command = grant(), fingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(command);
  const authorization: OperationsPortalNativeDeliveryAuthorizationProof = {
    authorityId: id(2), authorityRevision: 1, recipientBindingId: id(5), enrollmentIntentId: id(6), ...principal,
    targetId: id(3), targetRevision: 1, targetClientRecordId: "synthetic-client", clientAuthorityId: id(4), workspaceId: "synthetic-workspace",
    clientFolderBindingId: "synthetic-folder", folderReservationId: id(11), folderReservationRevision: 1,
    externalProjectId: "synthetic-project", projectVersion: 1, publicationOperationId: id(101), publicationId: id(201),
    publicationRevision: 1, publicationSourceSequence: 1, publicationSnapshotId: id(301), publicationSnapshotSha256: "b".repeat(64),
    homeOwnershipEpoch: 1, homeGrantRevision: 1, homeGrantOperationId: id(7), homeRequestFingerprint: "a".repeat(64),
    opsFolderProjectId: "synthetic-physical", opsDivisionId: "synthetic-division", selectedR2Prefix: "synthetic/photos/",
    expiresAt: command.expiresAt!, features: ["file.download"],
  };
  const first = { operationId: id(101), publicationId: id(201), revision: 1, sourceSequence: 1, snapshotId: id(301), snapshotSha256: "b".repeat(64) };
  const current = { operationId: id(103), publicationId: id(203), revision: 3, sourceSequence: 3, snapshotId: id(303), snapshotSha256: "c".repeat(64) };
  const successor: OperationsPortalNativeDeliverySuccessorAuthorization = { authorization, continuity: {
    grantOperationId: id(1), grantFingerprint: fingerprint, first, current, publicationCount: 3, chainSha256: "d".repeat(64),
  } };
  const candidate = { canonical_command_json: canonicalOperationsPortalNativeDeliveryAuthorityCommand(command), request_fingerprint: fingerprint,
    publication_operation_id: current.operationId, publication_id: current.publicationId, publication_revision: 3,
    publication_source_sequence: 3, snapshot_id: current.snapshotId, snapshot_sha256: current.snapshotSha256 };
  return { command, successor, candidate, reply: { ok: true, protocolVersion: 1, successor } };
}
