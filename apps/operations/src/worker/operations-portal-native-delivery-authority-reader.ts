import { parseOperationsPortalNativeDeliveryAuthorityCommand, canonicalOperationsPortalNativeDeliveryAuthorityCommand,
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES, type OperationsPortalNativeDeliveryAuthorizationProof,
  type OperationsPortalNativeDeliveryAuthorizationReadRequest,
  type OperationsPortalNativeDeliveryAuthorizationReaderResult,
  type OperationsPortalNativeDeliveryFeature, type OperationsPortalNativeDeliveryPublicationPins,
  type OperationsPortalNativeDeliverySuccessorAuthorization,
  type OperationsPortalNativeDeliverySuccessorReaderResult, type WindowsPortalCatalogFeature,
  type OperationsPortalNativeCatalogSuccessorReaderResult } from "@ltds/shared/operations-portal-native-delivery-authority";
import { configuredDeploymentOrigin } from "@ltds/shared/configured-deployment-origin";
import { readWindowsPortalPublicationChainEvidence } from "./windows-portal-publication-chain";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const FEATURES = ["folder.list", "file.metadata", "file.preview", "file.download"] as const;

export type ReadOperationsPortalNativeDeliveryAuthorizationInput = OperationsPortalNativeDeliveryAuthorizationReadRequest;
export type OperationsPortalNativeDeliveryAuthorization = OperationsPortalNativeDeliveryAuthorizationProof;

function bounded(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function denied(): never { throw new Error("operations_portal_native_delivery_authorization_denied"); }
function valid(input: ReadOperationsPortalNativeDeliveryAuthorizationInput): boolean {
  return UUID.test(input.authorityId) && integer(input.authorityRevision) && UUID.test(input.recipientBindingId)
    && UUID.test(input.enrollmentIntentId)
    && bounded(input.issuer) && bounded(input.subject) && UUID.test(input.targetId) && integer(input.targetRevision)
    && bounded(input.targetClientRecordId, 191) && UUID.test(input.clientAuthorityId) && bounded(input.workspaceId, 200)
    && integer(input.homeOwnershipEpoch) && integer(input.homeGrantRevision) && UUID.test(input.homeGrantOperationId)
    && HASH.test(input.homeRequestFingerprint) && UUID.test(input.publicationOperationId) && UUID.test(input.publicationId)
    && integer(input.publicationRevision) && integer(input.publicationSourceSequence) && UUID.test(input.publicationSnapshotId)
    && HASH.test(input.publicationSnapshotSha256) && UUID.test(input.folderReservationId)
    && integer(input.folderReservationRevision) && bounded(input.clientFolderBindingId, 200)
    && bounded(input.externalProjectId, 191) && integer(input.projectVersion) && bounded(input.opsFolderProjectId, 191)
    && bounded(input.opsDivisionId, 191) && FEATURES.includes(input.feature);
}

type Row = { authority_id: string; revision: number; recipient_binding_id: string; enrollment_intent_id: string;
  issuer: string; subject: string; target_id: string; target_revision: number; target_client_record_id: string;
  client_authority_id: string; workspace_id: string;
  client_folder_binding_id: string; folder_reservation_id: string; folder_reservation_revision: number;
  external_project_id: string; project_version: number; publication_operation_id: string; publication_id: string;
  publication_revision: number; publication_source_sequence: number; publication_snapshot_id: string;
  publication_snapshot_sha256: string;
  home_ownership_epoch: number; home_grant_revision: number; home_grant_operation_id: string; home_request_fingerprint: string;
  ops_folder_project_id: string; ops_division_id: string; selected_r2_prefix: string;
  expires_at: string; features_json: string };

/** Hot-path private proof. Call it before index access, each R2 head/get, and
 * immediately before byte handoff. The returned prefix is server-internal and
 * must never be copied into a browser response or signed handle plaintext. */
async function readAuthorization(database: D1Database, input: ReadOperationsPortalNativeDeliveryAuthorizationInput,
  requireAcknowledgedDelivery: boolean, effectivePublication?: OperationsPortalNativeDeliveryPublicationPins): Promise<OperationsPortalNativeDeliveryAuthorization> {
  if (!input || !valid(input)) denied();
  const row = await database.withSession("first-primary").prepare(`SELECT head.authority_id,head.revision,
      head.recipient_binding_id,head.enrollment_intent_id,head.issuer,head.subject,head.target_id,head.target_revision,
      head.target_client_record_id,head.client_authority_id,head.workspace_id,head.client_folder_binding_id,
      head.folder_reservation_id,head.folder_reservation_revision,head.external_project_id,head.project_version,
      head.publication_operation_id,head.publication_id,head.publication_revision,head.publication_source_sequence,
      head.publication_snapshot_id,
      head.publication_snapshot_sha256,head.home_ownership_epoch,head.home_grant_revision,head.home_grant_operation_id,
      head.home_request_fingerprint,head.ops_folder_project_id,head.ops_division_id,head.selected_r2_prefix,
      head.expires_at,head.features_json
    FROM operations_portal_native_delivery_authority_heads head
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=head.target_id
      AND workspace.state='active' AND workspace.target_revision=head.target_revision
      AND workspace.client_authority_id=head.client_authority_id AND workspace.workspace_id=head.workspace_id
    JOIN operations_portal_native_recipient_authority_heads recipient
      ON recipient.recipient_binding_id=head.recipient_binding_id AND recipient.target_id=head.target_id
      AND recipient.state='active' AND recipient.enrollment_intent_id=head.enrollment_intent_id
      AND recipient.target_client_record_id=head.target_client_record_id AND recipient.issuer=head.issuer
      AND recipient.subject=head.subject AND recipient.ownership_epoch=head.home_ownership_epoch
      AND recipient.grant_revision=head.home_grant_revision AND recipient.latest_operation_id=head.home_grant_operation_id
    JOIN operations_portal_native_authority_outbox home_outbox ON home_outbox.operation_id=head.home_grant_operation_id
      AND home_outbox.request_fingerprint=head.home_request_fingerprint AND home_outbox.state='acknowledged'
    JOIN operations_portal_native_authority_receipts home_receipt ON home_receipt.operation_id=home_outbox.operation_id
      AND home_receipt.resulting_state='active' AND home_receipt.target_id=head.target_id
      AND home_receipt.client_authority_id=head.client_authority_id AND home_receipt.workspace_id=head.workspace_id
      AND home_receipt.recipient_binding_id=head.recipient_binding_id
      AND home_receipt.enrollment_intent_id=head.enrollment_intent_id AND home_receipt.issuer=head.issuer
      AND home_receipt.subject=head.subject AND home_receipt.ownership_epoch=head.home_ownership_epoch
      AND home_receipt.grant_revision=head.home_grant_revision
      AND home_receipt.permissions_json='["operations.service_home.read"]'
    LEFT JOIN operations_portal_native_delivery_authority_outbox delivery_outbox
      ON delivery_outbox.operation_id=head.latest_operation_id
    LEFT JOIN operations_portal_native_delivery_authority_receipts delivery_receipt
      ON delivery_receipt.operation_id=delivery_outbox.operation_id
    JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=head.target_id
      AND publication.latest_operation_id=COALESCE(?,head.publication_operation_id)
      AND publication.target_revision=head.target_revision
      AND publication.client_authority_id=head.client_authority_id AND publication.workspace_id=head.workspace_id
      AND publication.root_kind=head.root_kind AND publication.root_record_id=head.root_record_id
      AND publication.publication_revision=COALESCE(?,head.publication_revision)
      AND publication.source_sequence=COALESCE(?,head.publication_source_sequence)
      AND publication.snapshot_id=COALESCE(?,head.publication_snapshot_id)
      AND publication.snapshot_sha256=COALESCE(?,head.publication_snapshot_sha256)
    JOIN operations_portal_workspace_publication_receipts publication_receipt
      ON publication_receipt.operation_id=publication.latest_operation_id
      AND publication_receipt.publication_id=COALESCE(?,head.publication_id)
      AND publication_receipt.target_id=publication.target_id
      AND publication_receipt.resulting_revision=publication.publication_revision
      AND publication_receipt.source_sequence=publication.source_sequence
      AND publication_receipt.snapshot_id=publication.snapshot_id
      AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_commands publication_command
      ON publication_command.operation_id=publication_receipt.operation_id
      AND publication_command.publication_id=COALESCE(?,head.publication_id)
      AND publication_command.target_id=publication.target_id
      AND publication_command.target_revision=publication.target_revision
      AND publication_command.client_authority_id=publication.client_authority_id
      AND publication_command.workspace_id=publication.workspace_id
      AND publication_command.root_kind=publication.root_kind
      AND publication_command.root_record_id=publication.root_record_id
      AND publication_command.checkpoint_id=publication.checkpoint_id
      AND publication_command.source_sequence=publication.source_sequence
      AND publication_command.snapshot_id=publication.snapshot_id
      AND publication_command.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_current_checkpoints current_checkpoint
      ON current_checkpoint.checkpoint_id=publication.checkpoint_id
    JOIN operations_portal_workspace_publication_folder_sources published_folder
      ON published_folder.checkpoint_id=publication.checkpoint_id
      AND published_folder.reservation_id=head.folder_reservation_id
      AND published_folder.binding_version=head.folder_reservation_revision
      AND published_folder.client_folder_binding_id=head.client_folder_binding_id
      AND published_folder.r2_prefix=head.selected_r2_prefix
      AND published_folder.external_project_id=head.external_project_id
      AND published_folder.ops_folder_project_id=head.ops_folder_project_id
      AND published_folder.division_id=head.ops_division_id
      AND published_folder.base_r2_prefix=head.base_r2_prefix
      AND published_folder.base_match_method=head.base_match_method
      AND published_folder.base_confirmed_by=head.base_confirmed_by
      AND published_folder.base_confirmed_at=head.base_confirmed_at
    JOIN operations_portal_workspace_publication_project_sources published_project
      ON published_project.checkpoint_id=publication.checkpoint_id
      AND published_project.external_project_id=head.external_project_id
      AND published_project.project_version=head.project_version
    JOIN operations_portal_folder_reservation_heads folder
      ON folder.reservation_id=head.folder_reservation_id AND folder.target_id=head.target_id
      AND folder.state='active' AND folder.revision=head.folder_reservation_revision
      AND folder.client_folder_binding_id=head.client_folder_binding_id
      AND folder.external_project_id=head.external_project_id AND folder.project_version=head.project_version
      AND folder.ops_folder_project_id=head.ops_folder_project_id AND folder.ops_division_id=head.ops_division_id
      AND folder.selected_r2_prefix=head.selected_r2_prefix AND folder.base_r2_prefix=head.base_r2_prefix
      AND folder.base_match_method=head.base_match_method AND folder.base_confirmed_by=head.base_confirmed_by
      AND folder.base_confirmed_at=head.base_confirmed_at
    JOIN operations_shared_projects project ON project.external_project_id=head.external_project_id
      AND project.current_version=head.project_version
    JOIN operations_shared_project_revisions project_revision ON project_revision.external_project_id=project.external_project_id
      AND project_revision.version=project.current_version
    JOIN project_folders physical ON physical.project_id=head.ops_folder_project_id
      AND physical.division_id=head.ops_division_id AND physical.r2_prefix=head.base_r2_prefix
      AND physical.match_method=head.base_match_method AND physical.confirmed_by=head.base_confirmed_by
      AND physical.confirmed_at=head.base_confirmed_at
    JOIN json_each(head.features_json) feature ON feature.value=?
    WHERE workspace.ownership_epoch=head.home_ownership_epoch
      AND ((project.client_record_id IS NOT NULL AND project.client_record_id=head.target_client_record_id)
        OR (project.client_record_id IS NULL AND head.root_kind='organization'
          AND project.organization_record_id=head.root_record_id))
      AND published_project.organization_record_id IS project.organization_record_id
      AND published_project.client_record_id IS project.client_record_id
      AND (?=0 OR (delivery_outbox.state='acknowledged' AND delivery_receipt.operation_id IS NOT NULL))
      AND head.authority_id=? AND head.revision=? AND head.state='active' AND head.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND head.recipient_binding_id=? AND head.enrollment_intent_id=? AND head.issuer=? AND head.subject=?
      AND head.target_id=? AND head.target_revision=?
      AND head.target_client_record_id=? AND head.client_authority_id=? AND head.workspace_id=?
      AND head.home_ownership_epoch=? AND head.home_grant_revision=? AND head.home_grant_operation_id=?
      AND head.home_request_fingerprint=? AND head.publication_operation_id=? AND head.publication_id=?
      AND head.publication_revision=? AND head.publication_source_sequence=? AND head.publication_snapshot_id=?
      AND head.publication_snapshot_sha256=? AND head.folder_reservation_id=? AND head.folder_reservation_revision=?
      AND head.client_folder_binding_id=? AND head.external_project_id=? AND head.project_version=?
      AND head.ops_folder_project_id=? AND head.ops_division_id=?
      AND substr(head.selected_r2_prefix,1,length(head.base_r2_prefix))=head.base_r2_prefix COLLATE BINARY`)
    .bind(effectivePublication?.operationId ?? null, effectivePublication?.revision ?? null,
      effectivePublication?.sourceSequence ?? null, effectivePublication?.snapshotId ?? null,
      effectivePublication?.snapshotSha256 ?? null, effectivePublication?.publicationId ?? null,
      effectivePublication?.publicationId ?? null, input.feature, requireAcknowledgedDelivery ? 1 : 0, input.authorityId, input.authorityRevision,
      input.recipientBindingId, input.enrollmentIntentId, input.issuer, input.subject,
      input.targetId, input.targetRevision, input.targetClientRecordId, input.clientAuthorityId, input.workspaceId,
      input.homeOwnershipEpoch, input.homeGrantRevision, input.homeGrantOperationId, input.homeRequestFingerprint,
      input.publicationOperationId, input.publicationId, input.publicationRevision, input.publicationSourceSequence,
      input.publicationSnapshotId, input.publicationSnapshotSha256, input.folderReservationId,
      input.folderReservationRevision, input.clientFolderBindingId, input.externalProjectId, input.projectVersion,
      input.opsFolderProjectId, input.opsDivisionId).first<Row>();
  if (!row) denied();
  let parsed: unknown; try { parsed = JSON.parse(row.features_json); } catch { denied(); }
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === "string" && FEATURES.includes(value as never))) denied();
  return Object.freeze({ authorityId: row.authority_id, authorityRevision: row.revision,
    recipientBindingId: row.recipient_binding_id, enrollmentIntentId: row.enrollment_intent_id,
    issuer: row.issuer, subject: row.subject, targetId: row.target_id, targetRevision: row.target_revision,
    targetClientRecordId: row.target_client_record_id, clientAuthorityId: row.client_authority_id,
    workspaceId: row.workspace_id,
    clientFolderBindingId: row.client_folder_binding_id, folderReservationId: row.folder_reservation_id,
    folderReservationRevision: row.folder_reservation_revision, externalProjectId: row.external_project_id,
    projectVersion: row.project_version, publicationOperationId: row.publication_operation_id,
    publicationId: row.publication_id, publicationRevision: row.publication_revision,
    publicationSourceSequence: row.publication_source_sequence,
    publicationSnapshotId: row.publication_snapshot_id, publicationSnapshotSha256: row.publication_snapshot_sha256,
    homeOwnershipEpoch: row.home_ownership_epoch, homeGrantRevision: row.home_grant_revision,
    homeGrantOperationId: row.home_grant_operation_id, homeRequestFingerprint: row.home_request_fingerprint,
    opsFolderProjectId: row.ops_folder_project_id, opsDivisionId: row.ops_division_id,
    selectedR2Prefix: row.selected_r2_prefix, expiresAt: row.expires_at,
    features: Object.freeze(parsed as OperationsPortalNativeDeliveryFeature[]) });
}

export function readOperationsPortalNativeDeliveryAuthorization(database: D1Database,
  input: ReadOperationsPortalNativeDeliveryAuthorizationInput): Promise<OperationsPortalNativeDeliveryAuthorization> {
  return readAuthorization(database, input, true);
}

/** Private producer proof for the Windows successor RPC (source, not deployed).
 * Both history retention and current home/recipient/folder authority are needed.
 * No caller can supply effective publication pins without proving the chain. */
export function readWindowsPortalSuccessorAuthorization(database: D1Database,
  rawGrant: unknown): Promise<OperationsPortalNativeDeliverySuccessorAuthorization> {
  return readFeatureSuccessorAuthorization(database, rawGrant, "file.download");
}
async function readFeatureSuccessorAuthorization(database: D1Database,
  rawGrant: unknown, feature: WindowsPortalCatalogFeature | "file.download"): Promise<OperationsPortalNativeDeliverySuccessorAuthorization> {
  const grant = parseOperationsPortalNativeDeliveryAuthorityCommand(rawGrant);
  if (!grant || grant.action !== "delivery.grant" || !["folder.list", "file.metadata", "file.download"].includes(feature)
    || !grant.features.includes(feature)) return denied();
  const a = grant.authority, t = grant.target, r = grant.recipient, p = grant.publication, f = grant.resource;
  const input: ReadOperationsPortalNativeDeliveryAuthorizationInput = {
    authorityId: a.authorityId, authorityRevision: Number(a.resultingRevision), recipientBindingId: r.recipientBindingId,
    enrollmentIntentId: r.enrollmentIntentId, issuer: r.issuer, subject: r.subject, targetId: t.targetId,
    targetRevision: Number(t.targetRevision), targetClientRecordId: r.targetClientRecordId, clientAuthorityId: t.clientAuthorityId,
    workspaceId: t.workspaceId, homeOwnershipEpoch: Number(r.homeOwnershipEpoch), homeGrantRevision: Number(r.homeGrantRevision),
    homeGrantOperationId: r.homeGrantOperationId, homeRequestFingerprint: r.homeRequestFingerprint,
    publicationOperationId: p.operationId, publicationId: p.publicationId, publicationRevision: Number(p.revision),
    publicationSourceSequence: Number(p.sourceSequence), publicationSnapshotId: p.snapshotId, publicationSnapshotSha256: p.snapshotSha256,
    folderReservationId: f.folderReservationId, folderReservationRevision: Number(f.folderReservationRevision),
    clientFolderBindingId: f.clientFolderBindingId, externalProjectId: f.externalProjectId, projectVersion: Number(f.projectVersion),
    opsFolderProjectId: f.opsFolderProjectId, opsDivisionId: f.opsDivisionId, feature,
  };
  const before = await readWindowsPortalPublicationChainEvidence(database, grant, feature);
  const initial = await readAuthorization(database, input, true, before.current);
  if (!initial.features.includes(feature)) return denied();
  const after = await readWindowsPortalPublicationChainEvidence(database, grant, feature);
  if (after.chainSha256 !== before.chainSha256 || JSON.stringify(after.current) !== JSON.stringify(before.current)) return denied();
  // This last atomic query also rejects a home/recipient/folder change during
  // the history recheck, or a publication advance after the chain was captured.
  const authorization = await readAuthorization(database, input, true, after.current);
  if (!authorization.features.includes(feature) || !(Date.parse(authorization.expiresAt) > Date.now())) return denied();
  return Object.freeze({ authorization, continuity: after });
}

/** Pre-dispatch proof uses the same current resource joins but cannot require a
 * receipt for the command that has not reached Client yet. Never use it for a
 * content request. */
export async function verifyOperationsPortalNativeDeliveryGrantForDispatch(database: D1Database,
  input: ReadOperationsPortalNativeDeliveryAuthorizationInput): Promise<boolean> {
  try { await readAuthorization(database, input, false); return true; } catch { return false; }
}

export type OperationsPortalNativeDeliveryAuthorizationReaderEnv = Readonly<{
  OPS_DB: D1Database; ENVIRONMENT?: string; EXPECTED_HOST?: string; PUBLIC_BASE_URL?: string;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED?: string;
}>;
/** Separate private protocol; never accepts a caller-supplied effective
 * publication or treats an ordinary grant proof as a successor response. */
export async function readWindowsPortalSuccessorAuthorizationEntrypoint(
  env: OperationsPortalNativeDeliveryAuthorizationReaderEnv, raw: unknown,
): Promise<string> {
  const failure = (code: "disabled" | "invalid" | "denied" | "unavailable") => {
    const result: OperationsPortalNativeDeliverySuccessorReaderResult = { ok: false, protocolVersion: 1, code };
    return JSON.stringify(result);
  };
  if (!configuredDeploymentOrigin({ environment: env.ENVIRONMENT ?? "", origin: env.PUBLIC_BASE_URL,
    expectedHost: env.EXPECTED_HOST }) || env.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED !== "true") return failure("disabled");
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES) return failure("invalid");
  let grant;
  try {
    grant = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(raw));
    if (!grant || canonicalOperationsPortalNativeDeliveryAuthorityCommand(grant) !== raw) return failure("invalid");
  } catch { return failure("invalid"); }
  try {
    const successor = await readWindowsPortalSuccessorAuthorization(env.OPS_DB, grant);
    const result: OperationsPortalNativeDeliverySuccessorReaderResult = { ok: true, protocolVersion: 1, successor };
    const serialized = JSON.stringify(result);
    return new TextEncoder().encode(serialized).byteLength <= 16_384 ? serialized : failure("unavailable");
  } catch (error) {
    return failure(error instanceof Error && (error.message === "operations_portal_native_delivery_authorization_denied"
      || error.message === "windows_portal_publication_chain_unproven") ? "denied" : "unavailable");
  }
}
/** Explicit catalog-only RPC; download protocol and preview access remain separate. */
export async function readWindowsPortalCatalogSuccessorAuthorizationEntrypoint(
  env: OperationsPortalNativeDeliveryAuthorizationReaderEnv, raw: unknown, feature: unknown,
): Promise<string> {
  const failure = (code: "disabled" | "invalid" | "denied" | "unavailable") =>
    JSON.stringify({ ok: false, protocolVersion: 1, code } satisfies OperationsPortalNativeCatalogSuccessorReaderResult);
  if (!configuredDeploymentOrigin({ environment: env.ENVIRONMENT ?? "", origin: env.PUBLIC_BASE_URL,
    expectedHost: env.EXPECTED_HOST }) || env.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED !== "true") return failure("disabled");
  if (feature !== "folder.list" && feature !== "file.metadata") return failure("invalid");
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES) return failure("invalid");
  let grant;
  try {
    grant = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(raw));
    if (!grant || canonicalOperationsPortalNativeDeliveryAuthorityCommand(grant) !== raw) return failure("invalid");
  } catch { return failure("invalid"); }
  try {
    const catalog = await readFeatureSuccessorAuthorization(env.OPS_DB, grant, feature);
    const result: OperationsPortalNativeCatalogSuccessorReaderResult = { ok: true, protocolVersion: 1, feature, catalog };
    const serialized = JSON.stringify(result);
    return new TextEncoder().encode(serialized).byteLength <= 16_384 ? serialized : failure("unavailable");
  } catch (error) {
    return failure(error instanceof Error && (error.message === "operations_portal_native_delivery_authorization_denied"
      || error.message === "windows_portal_publication_chain_unproven") ? "denied" : "unavailable");
  }
}
/** Root mounts this behind a private RPC entrypoint; it intentionally has no
 * HTTP/browser serializer and defaults off outside an exact configured deployment. */
export async function readOperationsPortalNativeDeliveryAuthorizationEntrypoint(
  env: OperationsPortalNativeDeliveryAuthorizationReaderEnv,
  input: ReadOperationsPortalNativeDeliveryAuthorizationInput,
): Promise<string> {
  if (!configuredDeploymentOrigin({ environment: env.ENVIRONMENT ?? "", origin: env.PUBLIC_BASE_URL,
      expectedHost: env.EXPECTED_HOST })
    || env.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED !== "true") {
    const result: OperationsPortalNativeDeliveryAuthorizationReaderResult =
      { ok: false, protocolVersion: 1, code: "disabled" };
    return JSON.stringify(result);
  }
  try {
    const result: OperationsPortalNativeDeliveryAuthorizationReaderResult = { ok: true, protocolVersion: 1,
      authorization: await readOperationsPortalNativeDeliveryAuthorization(env.OPS_DB, input) };
    return JSON.stringify(result);
  } catch {
    const result: OperationsPortalNativeDeliveryAuthorizationReaderResult =
      { ok: false, protocolVersion: 1, code: "denied" };
    return JSON.stringify(result);
  }
}
