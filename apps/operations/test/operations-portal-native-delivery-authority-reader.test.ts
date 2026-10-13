import { describe, expect, it, vi } from "vitest";
import { readOperationsPortalNativeDeliveryAuthorization,
  readOperationsPortalNativeDeliveryAuthorizationEntrypoint }
  from "../src/worker/operations-portal-native-delivery-authority-reader";
import { dispatchStagedOperationsPortalNativeDeliveryAuthority }
  from "../src/worker/operations-portal-native-delivery-authority-dispatch";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const request = { authorityId: id(1), authorityRevision: 2, recipientBindingId: id(2), enrollmentIntentId: id(10),
  issuer: "https://tenant.cloudflareaccess.com", subject: "recipient", targetId: id(3), targetRevision: 4,
  targetClientRecordId: "client", clientAuthorityId: id(4), workspaceId: "workspace", homeOwnershipEpoch: 5,
  homeGrantRevision: 6, homeGrantOperationId: id(5), homeRequestFingerprint: "a".repeat(64),
  publicationOperationId: id(6), publicationId: id(7), publicationRevision: 8, publicationSourceSequence: 8,
  publicationSnapshotId: id(8), publicationSnapshotSha256: "b".repeat(64), folderReservationId: id(9),
  folderReservationRevision: 10, clientFolderBindingId: "binding", externalProjectId: "project", projectVersion: 11,
  opsFolderProjectId: "ops-project", opsDivisionId: "division", feature: "file.download" as const };
const row = { authority_id: request.authorityId, revision: request.authorityRevision,
  recipient_binding_id: request.recipientBindingId, enrollment_intent_id: request.enrollmentIntentId,
  issuer: request.issuer, subject: request.subject, target_id: request.targetId, target_revision: request.targetRevision,
  target_client_record_id: request.targetClientRecordId, client_authority_id: request.clientAuthorityId,
  workspace_id: request.workspaceId,
  client_folder_binding_id: request.clientFolderBindingId, folder_reservation_id: request.folderReservationId,
  folder_reservation_revision: request.folderReservationRevision, external_project_id: request.externalProjectId,
  project_version: request.projectVersion, publication_operation_id: request.publicationOperationId,
  publication_id: request.publicationId, publication_revision: request.publicationRevision,
  publication_source_sequence: request.publicationSourceSequence,
  publication_snapshot_id: request.publicationSnapshotId, publication_snapshot_sha256: request.publicationSnapshotSha256,
  home_ownership_epoch: request.homeOwnershipEpoch, home_grant_revision: request.homeGrantRevision,
  home_grant_operation_id: request.homeGrantOperationId, home_request_fingerprint: request.homeRequestFingerprint,
  ops_folder_project_id: request.opsFolderProjectId, ops_division_id: request.opsDivisionId,
  selected_r2_prefix: "projects/selected/", expires_at: "2099-01-01T00:00:00.000Z",
  features_json: JSON.stringify(["folder.list", "file.download"]) };

function database(result: typeof row | null) {
  const queries: string[] = [];
  const first = vi.fn(async () => result);
  const bind = vi.fn((..._values: unknown[]) => ({ first }));
  const prepare = vi.fn((sql: string) => { queries.push(sql); return { bind }; });
  return { value: { withSession: vi.fn(() => ({ prepare })) } as unknown as D1Database, queries, prepare, bind, first };
}

describe("operations native delivery authorization reader", () => {
  it("returns bounded internal storage metadata only after the exact joined proof", async () => {
    const fake = database(row);
    await expect(readOperationsPortalNativeDeliveryAuthorization(fake.value, request)).resolves.toEqual({
      authorityId: request.authorityId, authorityRevision: 2, recipientBindingId: request.recipientBindingId,
      enrollmentIntentId: request.enrollmentIntentId, issuer: request.issuer, subject: request.subject,
      targetId: request.targetId, targetRevision: request.targetRevision, targetClientRecordId: request.targetClientRecordId,
      clientAuthorityId: request.clientAuthorityId, workspaceId: request.workspaceId, clientFolderBindingId: "binding",
      folderReservationId: request.folderReservationId, folderReservationRevision: 10, externalProjectId: "project",
      projectVersion: 11, publicationOperationId: request.publicationOperationId, publicationId: request.publicationId,
      publicationRevision: 8, publicationSourceSequence: 8, publicationSnapshotId: request.publicationSnapshotId,
      publicationSnapshotSha256: request.publicationSnapshotSha256, homeOwnershipEpoch: 5, homeGrantRevision: 6,
      homeGrantOperationId: request.homeGrantOperationId, homeRequestFingerprint: request.homeRequestFingerprint,
      opsFolderProjectId: request.opsFolderProjectId, opsDivisionId: request.opsDivisionId,
      selectedR2Prefix: "projects/selected/", expiresAt: "2099-01-01T00:00:00.000Z",
      features: ["folder.list", "file.download"] });
    expect(fake.queries[0]).toContain("project_folders physical");
    expect(fake.queries[0]).toContain("operations_portal_workspace_publication_current_checkpoints");
    expect(fake.bind).toHaveBeenCalledWith(request.feature, 1, request.authorityId, request.authorityRevision,
      request.recipientBindingId, request.enrollmentIntentId, request.issuer, request.subject,
      request.targetId, request.targetRevision,
      request.targetClientRecordId, request.clientAuthorityId, request.workspaceId, request.homeOwnershipEpoch,
      request.homeGrantRevision, request.homeGrantOperationId, request.homeRequestFingerprint,
      request.publicationOperationId, request.publicationId, request.publicationRevision,
      request.publicationSourceSequence, request.publicationSnapshotId, request.publicationSnapshotSha256,
      request.folderReservationId, request.folderReservationRevision, request.clientFolderBindingId,
      request.externalProjectId, request.projectVersion, request.opsFolderProjectId, request.opsDivisionId);
  });

  it("fails closed for forged pins and missing current proof", async () => {
    const forged = database(row);
    await expect(readOperationsPortalNativeDeliveryAuthorization(forged.value,
      { ...request, publicationSnapshotSha256: "forged" })).rejects.toThrow("authorization_denied");
    expect(forged.prepare).not.toHaveBeenCalled();
    await expect(readOperationsPortalNativeDeliveryAuthorization(database(null).value, request))
      .rejects.toThrow("authorization_denied");
  });

  it("keeps both the reader and dispatcher staging/default-off", async () => {
    const fake = database(row);
    await expect(readOperationsPortalNativeDeliveryAuthorizationEntrypoint({ OPS_DB: fake.value,
      ENVIRONMENT: "production", EXPECTED_HOST: "ops.ledgetopdroneservices.com",
      OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true" }, request))
      .resolves.toBe(JSON.stringify({ ok: false, protocolVersion: 1, code: "disabled" }));
    expect(fake.prepare).not.toHaveBeenCalled();
    await expect(dispatchStagedOperationsPortalNativeDeliveryAuthority({ OPS_DB: fake.value,
      ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
      OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED: "false" }, id(20))).resolves.toBeNull();
  });
});
