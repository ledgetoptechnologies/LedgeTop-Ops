import {
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL,
  canonicalOperationsPortalNativeDeliveryAuthorityCommand,
  parseOperationsPortalNativeDeliveryAuthorityCommand,
  sha256OperationsPortalNativeDeliveryAuthorityCommand,
  type OperationsPortalNativeDeliveryAuthorityCommand,
  type OperationsPortalNativeDeliveryFeature,
} from "@ltds/shared/operations-portal-native-delivery-authority";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const FEATURES = ["folder.list", "file.metadata", "file.preview", "file.download"] as const;
const encoder = new TextEncoder();
type Owner = AuthenticatedNativeStaffWithAdmissionVersion;
type ContextRow = {
  target_id: string; target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string;
  recipient_binding_id: string; enrollment_intent_id: string; target_client_record_id: string; issuer: string; subject: string;
  home_ownership_epoch: number; home_grant_revision: number; home_grant_operation_id: string; home_request_fingerprint: string;
  publication_operation_id: string; publication_id: string; publication_revision: number;
  publication_source_sequence: number; publication_snapshot_id: string; publication_snapshot_sha256: string;
  folder_reservation_id: string; folder_reservation_revision: number; client_folder_binding_id: string;
  external_project_id: string; project_version: number; ops_folder_project_id: string; ops_division_id: string;
  selected_r2_prefix: string; base_r2_prefix: string; base_match_method: string; base_confirmed_by: string; base_confirmed_at: string;
  client_name?: string; recipient_label?: string; project_name?: string; division_name?: string;
};
type HeadRow = ContextRow & { authority_id: string; revision: number; state: "active" | "revoked";
  features_json: string; expires_at: string | null; reason_code: string; latest_operation_id: string };

export type IssueOperationsPortalNativeDeliveryAuthorityInput = Readonly<{
  operationId: string; authorityId: string; recipientBindingId: string; folderReservationId: string;
  expectedRevision: number; features: readonly OperationsPortalNativeDeliveryFeature[];
  expiresAt: string; reasonCode: string; expectedCandidateFingerprint?: string; owner: Owner;
}>;
export type RevokeOperationsPortalNativeDeliveryAuthorityInput = Readonly<{
  operationId: string; authorityId: string; expectedRevision: number; reasonCode: string; owner: Owner;
}>;
export type OperationsPortalNativeDeliveryAuthorityReview = Readonly<{
  authorityId: string; revision: number; state: "active" | "revoked"; recipientBindingId: string;
  enrollmentIntentId: string; folderReservationId: string; targetId: string; targetClientRecordId: string;
  workspaceId: string; clientFolderBindingId: string;
  externalProjectId: string; opsFolderProjectId: string; opsDivisionId: string;
  clientLabel: string; recipientLabel: string; projectLabel: string; folderLabel: string;
  features: readonly OperationsPortalNativeDeliveryFeature[]; expiresAt: string | null; latestOperationId: string;
}>;
export type OperationsPortalNativeDeliveryAuthorityOwnerStatus = Readonly<{
  authority: OperationsPortalNativeDeliveryAuthorityReview;
  latestAction: "delivery.grant" | "delivery.revoke";
  transportStatus: "pending" | "acknowledged" | "dead";
  recoveryOperationId: string | null;
}>;
export type OperationsPortalNativeDeliveryAuthorityOwnerPage = Readonly<{
  items: readonly OperationsPortalNativeDeliveryAuthorityOwnerStatus[];
  nextAuthorityId: string | null;
}>;
export type OperationsPortalNativeDeliveryCandidate = Readonly<{
  candidateFingerprint: string; recipientBindingId: string; enrollmentIntentId: string;
  targetId: string; targetRevision: number; targetClientRecordId: string; clientLabel: string; recipientLabel: string;
  workspaceId: string; homeOwnershipEpoch: number; homeGrantRevision: number; publicationRevision: number;
  folderReservationId: string; folderReservationRevision: number; clientFolderBindingId: string;
  externalProjectId: string; projectLabel: string; projectVersion: number; opsFolderProjectId: string;
  folderLabel: string; opsDivisionId: string;
}>;
export type OperationsPortalNativeDeliveryCandidatePage = Readonly<{
  items: readonly OperationsPortalNativeDeliveryCandidate[];
  next: Readonly<{ recipientBindingId: string; folderReservationId: string }> | null;
}>;

export class OperationsPortalNativeDeliveryCandidateStaleError extends Error {
  constructor() { super("operations_portal_native_delivery_candidate_stale"); }
}

function denied(cause?: unknown): never {
  throw new Error("operations_portal_native_delivery_authority_denied", cause ? { cause } : undefined);
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function instant(value: unknown, future = false): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && (!future || parsed > Date.now());
}
function exactFeatures(value: readonly OperationsPortalNativeDeliveryFeature[]): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > FEATURES.length) return false;
  let prior = -1;
  return value.every(feature => { const index = FEATURES.indexOf(feature); if (index <= prior) return false; prior = index; return true; });
}
async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function generation(database: Pick<D1Database, "prepare">, owner: Owner): Promise<number> {
  if (!instant(owner.verifiedUntil, true)) denied();
  const value = await database.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
    .bind(owner.identity.staffId).first<number>("generation");
  if (!Number.isSafeInteger(value) || value === null || value < 1) denied();
  return value;
}
async function ownerAuthorized(database: Pick<D1Database, "prepare">, owner: Owner, generationValue: number,
  rootRecordId: string, divisionId: string, action: "delivery.grant" | "delivery.revoke"): Promise<boolean> {
  const mutationPermission = action === "delivery.grant" ? "delivery.share.create" : "delivery.share.revoke";
  return Boolean(await database.prepare(`SELECT 1 FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=? AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation=?
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global') OR
          (role.role_id='role-division-manager' AND role.scope='division' AND role.division_id=?)))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=?)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=?)
      AND (SELECT count(DISTINCT permission.permission_key) FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.permission_key IN ('projects.view','delivery.browse',?)
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=?)))=3
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.permission_key IN ('projects.view','delivery.browse',?)
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=?)))`)
    .bind(owner.identity.email, owner.identity.profileVersion, generationValue, owner.identity.staffId,
      owner.identity.verifiedAccessSubject, owner.admissionVersion, divisionId, rootRecordId, rootRecordId,
      mutationPermission, divisionId, mutationPermission, divisionId).first());
}

const contextSql = `SELECT workspace.target_id,workspace.target_revision,workspace.client_authority_id,workspace.workspace_id,
    workspace.root_kind,workspace.root_record_id,recipient.recipient_binding_id,recipient.enrollment_intent_id,
    recipient.target_client_record_id,recipient.issuer,recipient.subject,recipient.ownership_epoch home_ownership_epoch,
    recipient.grant_revision home_grant_revision,recipient.latest_operation_id home_grant_operation_id,
    home_outbox.request_fingerprint home_request_fingerprint,publication.latest_operation_id publication_operation_id,
    publication_receipt.publication_id,publication.publication_revision,publication.source_sequence publication_source_sequence,
    publication.snapshot_id publication_snapshot_id,publication.snapshot_sha256 publication_snapshot_sha256,
    folder.reservation_id folder_reservation_id,folder.revision folder_reservation_revision,
    folder.client_folder_binding_id,folder.external_project_id,folder.project_version,folder.ops_folder_project_id,
    folder.ops_division_id,folder.selected_r2_prefix,folder.base_r2_prefix,folder.base_match_method,
    folder.base_confirmed_by,folder.base_confirmed_at,published_client.display_name client_name,
    recipient_label.display_label recipient_label,published_project.name project_name,division.name division_name
  FROM operations_portal_native_workspace_authority_heads workspace
  JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.target_id=workspace.target_id
  LEFT JOIN operations_portal_native_recipient_labels recipient_label
    ON recipient_label.intent_id=recipient.enrollment_intent_id
  JOIN operations_portal_native_authority_outbox home_outbox
    ON home_outbox.operation_id=recipient.latest_operation_id AND home_outbox.state='acknowledged'
  JOIN operations_portal_native_authority_receipts home_receipt
    ON home_receipt.operation_id=home_outbox.operation_id AND home_receipt.resulting_state='active'
    AND home_receipt.target_id=workspace.target_id AND home_receipt.client_authority_id=workspace.client_authority_id
    AND home_receipt.workspace_id=workspace.workspace_id AND home_receipt.recipient_binding_id=recipient.recipient_binding_id
    AND home_receipt.enrollment_intent_id=recipient.enrollment_intent_id AND home_receipt.issuer=recipient.issuer
    AND home_receipt.subject=recipient.subject AND home_receipt.ownership_epoch=recipient.ownership_epoch
    AND home_receipt.grant_revision=recipient.grant_revision
    AND home_receipt.permissions_json='["operations.service_home.read"]'
  JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
    AND publication.target_revision=workspace.target_revision
    AND publication.client_authority_id=workspace.client_authority_id
    AND publication.workspace_id=workspace.workspace_id
    AND publication.root_kind=workspace.root_kind AND publication.root_record_id=workspace.root_record_id
  JOIN operations_portal_workspace_publication_receipts publication_receipt
    ON publication_receipt.operation_id=publication.latest_operation_id
    AND publication_receipt.target_id=publication.target_id
    AND publication_receipt.resulting_revision=publication.publication_revision
    AND publication_receipt.source_sequence=publication.source_sequence
    AND publication_receipt.snapshot_id=publication.snapshot_id
    AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
  JOIN operations_portal_workspace_publication_commands publication_command
    ON publication_command.operation_id=publication_receipt.operation_id
    AND publication_command.publication_id=publication_receipt.publication_id
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
  JOIN operations_portal_workspace_publication_project_sources published_project
    ON published_project.checkpoint_id=publication.checkpoint_id
    AND published_project.external_project_id=published_folder.external_project_id
  JOIN operations_portal_workspace_publication_directory_sources published_client
    ON published_client.checkpoint_id=publication.checkpoint_id
    AND published_client.record_id=recipient.target_client_record_id AND published_client.record_kind='client'
  JOIN operations_portal_folder_reservation_heads folder ON folder.reservation_id=published_folder.reservation_id
  JOIN operations_shared_projects project ON project.external_project_id=folder.external_project_id
  JOIN operations_shared_project_revisions project_revision
    ON project_revision.external_project_id=project.external_project_id AND project_revision.version=project.current_version
  JOIN project_folders physical ON physical.project_id=folder.ops_folder_project_id
  JOIN divisions division ON division.id=folder.ops_division_id
  WHERE workspace.state='active' AND recipient.state='active' AND workspace.ownership_epoch=recipient.ownership_epoch
    AND (recipient.expires_at IS NULL OR recipient.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND folder.target_id=workspace.target_id AND folder.state='active' AND folder.pinned_workspace_revision=workspace.target_revision
    AND ((project.client_record_id IS NOT NULL AND project.client_record_id=recipient.target_client_record_id)
      OR (project.client_record_id IS NULL AND workspace.root_kind='organization'
        AND project.organization_record_id=workspace.root_record_id))
    AND folder.project_version=project.current_version AND physical.division_id=folder.ops_division_id
    AND physical.r2_prefix=folder.base_r2_prefix AND physical.match_method=folder.base_match_method
    AND physical.confirmed_by=folder.base_confirmed_by AND physical.confirmed_at=folder.base_confirmed_at
    AND substr(folder.selected_r2_prefix,1,length(folder.base_r2_prefix))=folder.base_r2_prefix COLLATE BINARY
    AND published_folder.binding_version=folder.revision
    AND published_folder.external_project_id=folder.external_project_id
    AND published_folder.ops_folder_project_id=folder.ops_folder_project_id
    AND published_folder.division_id=folder.ops_division_id
    AND published_folder.client_folder_binding_id=folder.client_folder_binding_id
    AND published_folder.r2_prefix=folder.selected_r2_prefix
    AND published_folder.base_r2_prefix=folder.base_r2_prefix
    AND published_folder.base_match_method=folder.base_match_method
    AND published_folder.base_confirmed_by=folder.base_confirmed_by
    AND published_folder.base_confirmed_at=folder.base_confirmed_at
    AND published_project.project_version=project.current_version
    AND published_project.organization_record_id IS project.organization_record_id
    AND published_project.client_record_id IS project.client_record_id
    AND recipient.recipient_binding_id=? AND folder.reservation_id=?`;

async function currentContext(database: Pick<D1Database, "prepare">, recipientBindingId: string, folderReservationId: string) {
  return database.prepare(contextSql).bind(recipientBindingId, folderReservationId).first<ContextRow>();
}
function candidateFingerprintPayload(context: ContextRow) {
  return { protocol: "operations-portal-native-delivery-candidate", protocolVersion: 1,
    targetId: context.target_id, targetRevision: context.target_revision, clientAuthorityId: context.client_authority_id,
    workspaceId: context.workspace_id, rootKind: context.root_kind, rootRecordId: context.root_record_id,
    recipientBindingId: context.recipient_binding_id, enrollmentIntentId: context.enrollment_intent_id,
    targetClientRecordId: context.target_client_record_id, issuer: context.issuer, subject: context.subject,
    homeOwnershipEpoch: context.home_ownership_epoch, homeGrantRevision: context.home_grant_revision,
    homeGrantOperationId: context.home_grant_operation_id, homeRequestFingerprint: context.home_request_fingerprint,
    publicationOperationId: context.publication_operation_id, publicationId: context.publication_id,
    publicationRevision: context.publication_revision, publicationSourceSequence: context.publication_source_sequence,
    publicationSnapshotId: context.publication_snapshot_id, publicationSnapshotSha256: context.publication_snapshot_sha256,
    folderReservationId: context.folder_reservation_id, folderReservationRevision: context.folder_reservation_revision,
    clientFolderBindingId: context.client_folder_binding_id, externalProjectId: context.external_project_id,
    projectVersion: context.project_version, opsFolderProjectId: context.ops_folder_project_id,
    opsDivisionId: context.ops_division_id, selectedR2Prefix: context.selected_r2_prefix,
    baseR2Prefix: context.base_r2_prefix, baseMatchMethod: context.base_match_method,
    baseConfirmedBy: context.base_confirmed_by, baseConfirmedAt: context.base_confirmed_at };
}
export async function fingerprintOperationsPortalNativeDeliveryCandidate(context: ContextRow): Promise<string> {
  return sha256(JSON.stringify(candidateFingerprintPayload(context)));
}
function label(value: string, fallback: string) {
  const normalized = value.trim();
  return normalized && !/\p{C}/u.test(normalized) ? Array.from(normalized).slice(0, 160).join("") : fallback;
}
async function candidate(context: ContextRow): Promise<OperationsPortalNativeDeliveryCandidate> {
  return Object.freeze({ candidateFingerprint: await fingerprintOperationsPortalNativeDeliveryCandidate(context),
    recipientBindingId: context.recipient_binding_id, enrollmentIntentId: context.enrollment_intent_id,
    targetId: context.target_id, targetRevision: context.target_revision,
    targetClientRecordId: context.target_client_record_id,
    clientLabel: label(context.client_name ?? "", `Client ${context.target_id.slice(0, 8)}`),
    recipientLabel: label(context.recipient_label ?? "", `Recipient ${context.enrollment_intent_id.slice(0, 8)}`),
    workspaceId: context.workspace_id, homeOwnershipEpoch: context.home_ownership_epoch,
    homeGrantRevision: context.home_grant_revision, publicationRevision: context.publication_revision,
    folderReservationId: context.folder_reservation_id, folderReservationRevision: context.folder_reservation_revision,
    clientFolderBindingId: context.client_folder_binding_id, externalProjectId: context.external_project_id,
    projectLabel: label(context.project_name ?? "", `Project ${context.external_project_id.slice(0, 12)}`),
    projectVersion: context.project_version, opsFolderProjectId: context.ops_folder_project_id,
    folderLabel: label(`${context.project_name ?? "Project"} — ${context.division_name ?? "Division"}`,
      `Folder ${context.client_folder_binding_id.slice(0, 12)}`), opsDivisionId: context.ops_division_id });
}

export async function listOperationsPortalNativeDeliveryCandidates(database: D1Database, input: Readonly<{
  targetId: string; after?: Readonly<{ recipientBindingId: string; folderReservationId: string }> | null;
  limit?: number; owner: Owner;
}>): Promise<OperationsPortalNativeDeliveryCandidatePage> {
  if (!UUID.test(input.targetId) || input.after && (!UUID.test(input.after.recipientBindingId)
    || !UUID.test(input.after.folderReservationId))) denied();
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) denied();
  const session = database.withSession("first-primary"), generationValue = await generation(session, input.owner);
  const filter = contextSql.slice(0, contextSql.lastIndexOf("AND recipient.recipient_binding_id=?"));
  let afterRecipient = input.after?.recipientBindingId ?? "";
  let afterFolder = input.after?.folderReservationId ?? "";
  const items: OperationsPortalNativeDeliveryCandidate[] = [];
  const authorization = new Map<string, boolean>();
  let more = false;
  let lastScanned: Readonly<{ recipientBindingId: string; folderReservationId: string }> | null = null;
  for (let page = 0; page < 10 && items.length <= limit; page += 1) {
    const rows = await session.prepare(`${filter}
      AND workspace.target_id=?
      AND (recipient.recipient_binding_id>? OR (recipient.recipient_binding_id=? AND folder.reservation_id>?))
      ORDER BY recipient.recipient_binding_id,folder.reservation_id LIMIT 50`)
      .bind(input.targetId, afterRecipient, afterRecipient, afterFolder).all<ContextRow>();
    if (!rows.results.length) { more = false; break; }
    more = rows.results.length === 50;
    for (const row of rows.results) {
      afterRecipient = row.recipient_binding_id; afterFolder = row.folder_reservation_id;
      lastScanned = { recipientBindingId: afterRecipient, folderReservationId: afterFolder };
      const key = `${row.root_record_id}\u0000${row.ops_division_id}`;
      let authorized = authorization.get(key);
      if (authorized === undefined) {
        authorized = await ownerAuthorized(session, input.owner, generationValue, row.root_record_id,
          row.ops_division_id, "delivery.grant");
        authorization.set(key, authorized);
      }
      if (authorized) items.push(await candidate(row));
      if (items.length > limit) break;
    }
    if (items.length > limit || rows.results.length < 50) break;
  }
  const hasNext = items.length > limit || more;
  const selected = items.slice(0, limit);
  const last = selected.at(-1);
  const next = items.length > limit && last
    ? { recipientBindingId: last.recipientBindingId, folderReservationId: last.folderReservationId }
    : hasNext ? lastScanned : null;
  return Object.freeze({ items: Object.freeze(selected), next: next ? Object.freeze(next) : null });
}
async function head(database: Pick<D1Database, "prepare">, authorityId: string) {
  return database.prepare(`SELECT head.*,project.name project_name,division.name division_name,
      json_extract(client_revision.profile_json,'$.name') client_name,recipient_label.display_label recipient_label
    FROM operations_portal_native_delivery_authority_heads head
    LEFT JOIN operations_shared_projects project ON project.external_project_id=head.external_project_id
    LEFT JOIN divisions division ON division.id=head.ops_division_id
    LEFT JOIN operations_directory_records client_record ON client_record.record_id=head.target_client_record_id
    LEFT JOIN operations_directory_revisions client_revision ON client_revision.record_id=client_record.record_id
      AND client_revision.version=client_record.current_version
    LEFT JOIN operations_portal_native_recipient_labels recipient_label
      ON recipient_label.intent_id=head.enrollment_intent_id
    WHERE head.authority_id=?`)
    .bind(authorityId).first<HeadRow>();
}
function review(row: HeadRow): OperationsPortalNativeDeliveryAuthorityReview {
  let parsed: unknown; try { parsed = JSON.parse(row.features_json); } catch { parsed = []; }
  const features = Array.isArray(parsed) ? parsed.filter((feature): feature is OperationsPortalNativeDeliveryFeature =>
    typeof feature === "string" && FEATURES.includes(feature as OperationsPortalNativeDeliveryFeature)) : [];
  return Object.freeze({ authorityId: row.authority_id, revision: row.revision, state: row.state,
    recipientBindingId: row.recipient_binding_id, folderReservationId: row.folder_reservation_id,
    enrollmentIntentId: row.enrollment_intent_id, targetId: row.target_id,
    targetClientRecordId: row.target_client_record_id,
    workspaceId: row.workspace_id, clientFolderBindingId: row.client_folder_binding_id,
    externalProjectId: row.external_project_id, opsFolderProjectId: row.ops_folder_project_id,
    opsDivisionId: row.ops_division_id,
    clientLabel: label(row.client_name ?? "", `Client ${row.target_id.slice(0, 8)}`),
    recipientLabel: label(row.recipient_label ?? "", `Recipient ${row.enrollment_intent_id.slice(0, 8)}`),
    projectLabel: label(row.project_name ?? "", `Project ${row.external_project_id.slice(0, 12)}`),
    folderLabel: label(`${row.project_name ?? "Project"} — ${row.division_name ?? "Division"}`,
      `Folder ${row.client_folder_binding_id.slice(0, 12)}`),
    features: Object.freeze(features), expiresAt: row.expires_at, latestOperationId: row.latest_operation_id });
}
function replayReview(command: OperationsPortalNativeDeliveryAuthorityCommand,
  recipientLabel?: string): OperationsPortalNativeDeliveryAuthorityReview {
  return Object.freeze({ authorityId: command.authority.authorityId, revision: Number(command.authority.resultingRevision),
    state: command.action === "delivery.grant" ? "active" : "revoked",
    recipientBindingId: command.recipient.recipientBindingId,
    enrollmentIntentId: command.recipient.enrollmentIntentId,
    folderReservationId: command.resource.folderReservationId, targetId: command.target.targetId,
    targetClientRecordId: command.recipient.targetClientRecordId,
    workspaceId: command.target.workspaceId, clientFolderBindingId: command.resource.clientFolderBindingId,
    externalProjectId: command.resource.externalProjectId, opsFolderProjectId: command.resource.opsFolderProjectId,
    opsDivisionId: command.resource.opsDivisionId,
    clientLabel: label(command.recipient.targetClientRecordId, `Client ${command.target.targetId.slice(0, 8)}`),
    recipientLabel: label(recipientLabel ?? "", `Recipient ${command.recipient.enrollmentIntentId.slice(0, 8)}`),
    projectLabel: `Project ${command.resource.externalProjectId.slice(0, 12)}`,
    folderLabel: `Folder ${command.resource.clientFolderBindingId.slice(0, 12)}`,
    features: command.features, expiresAt: command.expiresAt, latestOperationId: command.operationId });
}
function command(context: ContextRow, input: { operationId: string; authorityId: string; expectedRevision: number;
  features: readonly OperationsPortalNativeDeliveryFeature[]; expiresAt: string | null; reasonCode: string },
  action: "delivery.grant" | "delivery.revoke", observedAt: string): OperationsPortalNativeDeliveryAuthorityCommand {
  return {
    protocol: OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL, protocolVersion: 1, permissionSchemaVersion: 3,
    action, operationId: input.operationId,
    authority: { authorityId: input.authorityId, expectedRevision: String(input.expectedRevision),
      resultingRevision: String(input.expectedRevision + 1) },
    target: { targetId: context.target_id, targetRevision: String(context.target_revision),
      clientAuthorityId: context.client_authority_id, workspaceId: context.workspace_id,
      rootKind: context.root_kind, rootRecordId: context.root_record_id },
    recipient: { recipientBindingId: context.recipient_binding_id, enrollmentIntentId: context.enrollment_intent_id,
      targetClientRecordId: context.target_client_record_id, issuer: context.issuer, subject: context.subject,
      homeOwnershipEpoch: String(context.home_ownership_epoch), homeGrantRevision: String(context.home_grant_revision),
      homeGrantOperationId: context.home_grant_operation_id, homeRequestFingerprint: context.home_request_fingerprint },
    publication: { operationId: context.publication_operation_id, publicationId: context.publication_id,
      revision: String(context.publication_revision), sourceSequence: String(context.publication_source_sequence),
      snapshotId: context.publication_snapshot_id, snapshotSha256: context.publication_snapshot_sha256 },
    resource: { folderReservationId: context.folder_reservation_id,
      folderReservationRevision: String(context.folder_reservation_revision),
      clientFolderBindingId: context.client_folder_binding_id, externalProjectId: context.external_project_id,
      projectVersion: String(context.project_version), opsFolderProjectId: context.ops_folder_project_id,
      opsDivisionId: context.ops_division_id, selectedR2Prefix: context.selected_r2_prefix,
      baseR2Prefix: context.base_r2_prefix, baseMatchMethod: context.base_match_method,
      baseConfirmedBy: context.base_confirmed_by, baseConfirmedAt: context.base_confirmed_at },
    features: Object.freeze([...input.features]), expiresAt: input.expiresAt, reasonCode: input.reasonCode, observedAt,
  };
}
function contextFromHead(row: HeadRow): ContextRow { return row; }
function stableFingerprint(input: object) { return sha256(JSON.stringify(input)); }

const commandColumns = ["operation_id","command_sha256","operation_fingerprint","canonical_command_json","action",
  "authority_id","expected_revision","resulting_revision","target_id","target_revision","client_authority_id","workspace_id",
  "root_kind","root_record_id","recipient_binding_id","enrollment_intent_id","target_client_record_id","issuer","subject",
  "home_ownership_epoch","home_grant_revision","home_grant_operation_id","home_request_fingerprint","publication_operation_id",
  "publication_id","publication_revision","publication_source_sequence","publication_snapshot_id","publication_snapshot_sha256",
  "folder_reservation_id","folder_reservation_revision","client_folder_binding_id","external_project_id","project_version",
  "ops_folder_project_id","ops_division_id","selected_r2_prefix","base_r2_prefix","base_match_method","base_confirmed_by",
  "base_confirmed_at","features_json","expires_at","reason_code","observed_at"] as const;
function commandBindings(value: OperationsPortalNativeDeliveryAuthorityCommand, commandHash: string, fingerprint: string) {
  return [value.operationId,commandHash,fingerprint,JSON.stringify(value),value.action,value.authority.authorityId,
    Number(value.authority.expectedRevision),Number(value.authority.resultingRevision),value.target.targetId,
    Number(value.target.targetRevision),value.target.clientAuthorityId,value.target.workspaceId,value.target.rootKind,
    value.target.rootRecordId,value.recipient.recipientBindingId,value.recipient.enrollmentIntentId,
    value.recipient.targetClientRecordId,value.recipient.issuer,value.recipient.subject,Number(value.recipient.homeOwnershipEpoch),
    Number(value.recipient.homeGrantRevision),value.recipient.homeGrantOperationId,value.recipient.homeRequestFingerprint,
    value.publication.operationId,value.publication.publicationId,Number(value.publication.revision),
    Number(value.publication.sourceSequence),value.publication.snapshotId,value.publication.snapshotSha256,
    value.resource.folderReservationId,Number(value.resource.folderReservationRevision),value.resource.clientFolderBindingId,
    value.resource.externalProjectId,Number(value.resource.projectVersion),value.resource.opsFolderProjectId,
    value.resource.opsDivisionId,value.resource.selectedR2Prefix,value.resource.baseR2Prefix,value.resource.baseMatchMethod,
    value.resource.baseConfirmedBy,value.resource.baseConfirmedAt,JSON.stringify(value.features),value.expiresAt,value.reasonCode,
    value.observedAt];
}
async function exactReplay(database: D1DatabaseSession, operationId: string, fingerprint: string, owner: Owner,
  generationValue: number): Promise<{ review: OperationsPortalNativeDeliveryAuthorityReview; replayed: true }> {
  const row = await database.prepare(`SELECT command.canonical_command_json,command.operation_fingerprint,
      authorization.authorized_by_staff_id,authorization.authorized_access_subject
    FROM operations_portal_native_delivery_authority_commands command
    JOIN operations_portal_native_delivery_authorizations authorization ON authorization.operation_id=command.operation_id
    JOIN operations_portal_native_delivery_authority_commits committed ON committed.operation_id=command.operation_id
    WHERE command.operation_id=?`).bind(operationId).first<{ canonical_command_json: string; operation_fingerprint: string;
      authorized_by_staff_id: string; authorized_access_subject: string }>();
  if (!row || row.operation_fingerprint !== fingerprint || row.authorized_by_staff_id !== owner.identity.staffId
    || row.authorized_access_subject !== owner.identity.verifiedAccessSubject) denied();
  let parsed: unknown; try { parsed = JSON.parse(row.canonical_command_json); } catch { denied(); }
  const stored = parseOperationsPortalNativeDeliveryAuthorityCommand(parsed); if (!stored) denied();
  if (!await ownerAuthorized(database, owner, generationValue, stored.target.rootRecordId,
    stored.resource.opsDivisionId, stored.action)) denied();
  const committed = await database.prepare(`SELECT 1 FROM operations_portal_native_delivery_authority_commits
    WHERE operation_id=? AND authority_id=? AND resulting_revision=? AND resulting_state=?`)
    .bind(stored.operationId, stored.authority.authorityId, Number(stored.authority.resultingRevision),
      stored.action === "delivery.grant" ? "active" : "revoked").first();
  if (!committed) denied();
  const storedLabel = await database.prepare(`SELECT display_label FROM operations_portal_native_recipient_labels
    WHERE intent_id=?`).bind(stored.recipient.enrollmentIntentId).first<string>("display_label");
  return { review: replayReview(stored, storedLabel ?? undefined), replayed: true };
}

async function persist(database: D1DatabaseSession, wire: OperationsPortalNativeDeliveryAuthorityCommand,
  fingerprint: string, owner: Owner, generationValue: number): Promise<OperationsPortalNativeDeliveryAuthorityReview> {
  const canonical = canonicalOperationsPortalNativeDeliveryAuthorityCommand(wire);
  const commandHash = await sha256OperationsPortalNativeDeliveryAuthorityCommand(wire);
  const placeholders = commandColumns.map(() => "?").join(",");
  const insertCommand = database.prepare(`INSERT INTO operations_portal_native_delivery_authority_commands
    (${commandColumns.join(",")}) VALUES(${placeholders})`).bind(...commandBindings(wire, commandHash, fingerprint));
  const authorize = database.prepare(`INSERT INTO operations_portal_native_delivery_authorizations
    (operation_id,authorized_by_staff_id,authorized_access_subject,authorized_email,authorized_admission_version,
     authorized_profile_version,authorized_grant_generation,authorized_verified_until) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(wire.operationId, owner.identity.staffId, owner.identity.verifiedAccessSubject, owner.identity.email,
      owner.admissionVersion, owner.identity.profileVersion, generationValue, owner.verifiedUntil);
  const mutate = wire.authority.expectedRevision === "0"
    ? database.prepare(`INSERT INTO operations_portal_native_delivery_authority_heads
        (authority_id,revision,state,latest_operation_id,target_id,target_revision,client_authority_id,workspace_id,root_kind,
         root_record_id,recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,home_ownership_epoch,
         home_grant_revision,home_grant_operation_id,home_request_fingerprint,publication_operation_id,publication_id,
         publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
         folder_reservation_id,folder_reservation_revision,client_folder_binding_id,external_project_id,project_version,
         ops_folder_project_id,ops_division_id,selected_r2_prefix,base_r2_prefix,base_match_method,base_confirmed_by,
         base_confirmed_at,features_json,expires_at,reason_code)
       SELECT authority_id,resulting_revision,'active',operation_id,target_id,target_revision,client_authority_id,workspace_id,
         root_kind,root_record_id,recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,
         home_ownership_epoch,home_grant_revision,home_grant_operation_id,home_request_fingerprint,publication_operation_id,
         publication_id,publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
         folder_reservation_id,folder_reservation_revision,client_folder_binding_id,external_project_id,project_version,
         ops_folder_project_id,ops_division_id,selected_r2_prefix,base_r2_prefix,base_match_method,base_confirmed_by,
         base_confirmed_at,features_json,expires_at,reason_code
       FROM operations_portal_native_delivery_authority_commands WHERE operation_id=?`).bind(wire.operationId)
    : database.prepare(`UPDATE operations_portal_native_delivery_authority_heads SET
        (revision,state,latest_operation_id,target_revision,home_ownership_epoch,home_grant_revision,home_grant_operation_id,
         home_request_fingerprint,publication_operation_id,publication_id,publication_revision,publication_source_sequence,
         publication_snapshot_id,publication_snapshot_sha256,folder_reservation_revision,project_version,features_json,
         expires_at,reason_code,updated_at)=(SELECT resulting_revision,
           CASE action WHEN 'delivery.grant' THEN 'active' ELSE 'revoked' END,operation_id,target_revision,
           home_ownership_epoch,home_grant_revision,home_grant_operation_id,home_request_fingerprint,publication_operation_id,
           publication_id,publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
           folder_reservation_revision,project_version,features_json,expires_at,reason_code,
           strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM operations_portal_native_delivery_authority_commands WHERE operation_id=?)
       WHERE authority_id=? AND revision=? AND state='active'`)
      .bind(wire.operationId, wire.authority.authorityId, Number(wire.authority.expectedRevision));
  const statements: D1PreparedStatement[] = [insertCommand, authorize, mutate];
  if (wire.action === "delivery.revoke") statements.push(database.prepare(`INSERT INTO operations_portal_native_delivery_authority_tombstones
    (authority_id,operation_id,revision,recipient_binding_id,folder_reservation_id) VALUES(?,?,?,?,?)`)
    .bind(wire.authority.authorityId, wire.operationId, Number(wire.authority.resultingRevision),
      wire.recipient.recipientBindingId, wire.resource.folderReservationId));
  statements.push(
    database.prepare(`INSERT INTO operations_portal_native_delivery_authority_commits
      (operation_id,authority_id,resulting_revision,resulting_state) VALUES(?,?,?,?)`)
      .bind(wire.operationId, wire.authority.authorityId, Number(wire.authority.resultingRevision),
        wire.action === "delivery.grant" ? "active" : "revoked"),
    database.prepare(`INSERT INTO operations_portal_native_delivery_authority_outbox
      (operation_id,request_fingerprint,canonical_wire_json) VALUES(?,?,?)`).bind(wire.operationId, commandHash, canonical),
    database.prepare(`INSERT INTO operations_portal_native_delivery_authority_audit
      (operation_id,action,operation_fingerprint,authorized_by_staff_id,authorized_grant_generation) VALUES(?,?,?,?,?)`)
      .bind(wire.operationId, wire.action === "delivery.grant" ? "native.folder.grant.enqueued" : "native.folder.revoke.enqueued",
        fingerprint, owner.identity.staffId, generationValue),
  );
  await database.batch(statements);
  const result = await head(database, wire.authority.authorityId); if (!result) denied();
  return review(result);
}

export async function issueOperationsPortalNativeDeliveryAuthority(database: D1Database,
  input: IssueOperationsPortalNativeDeliveryAuthorityInput) {
  if (!UUID.test(input.operationId) || !UUID.test(input.authorityId) || !UUID.test(input.recipientBindingId)
    || !UUID.test(input.folderReservationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !exactFeatures(input.features) || !instant(input.expiresAt, true)
    || Date.parse(input.expiresAt) > Date.now() + 30 * 86_400_000 || !bounded(input.reasonCode, 200)
    || input.expectedCandidateFingerprint !== undefined && !HASH.test(input.expectedCandidateFingerprint)) denied();
  const session = database.withSession("first-primary"), generationValue = await generation(session, input.owner);
  const fingerprint = await stableFingerprint({ action: "delivery.grant", operationId: input.operationId,
    authorityId: input.authorityId, recipientBindingId: input.recipientBindingId,
    folderReservationId: input.folderReservationId, expectedRevision: input.expectedRevision,
    features: input.features, expiresAt: input.expiresAt, reasonCode: input.reasonCode,
    expectedCandidateFingerprint: input.expectedCandidateFingerprint ?? null });
  const existing = await session.prepare("SELECT 1 FROM operations_portal_native_delivery_authority_commands WHERE operation_id=?")
    .bind(input.operationId).first();
  if (existing) return exactReplay(session, input.operationId, fingerprint, input.owner, generationValue);
  const context = await currentContext(session, input.recipientBindingId, input.folderReservationId); if (!context) denied();
  if (input.expectedCandidateFingerprint !== undefined
    && input.expectedCandidateFingerprint !== await fingerprintOperationsPortalNativeDeliveryCandidate(context))
    throw new OperationsPortalNativeDeliveryCandidateStaleError();
  if (!await ownerAuthorized(session, input.owner, generationValue, context.root_record_id, context.ops_division_id,
    "delivery.grant")) denied();
  const wire = command(context, input, "delivery.grant", new Date().toISOString());
  if (!parseOperationsPortalNativeDeliveryAuthorityCommand(wire)) denied();
  try { return { review: await persist(session, wire, fingerprint, input.owner, generationValue), replayed: false as const }; }
  catch (error) {
    try { return await exactReplay(session, input.operationId, fingerprint, input.owner, generationValue); }
    catch { denied(error); }
  }
}

export async function revokeOperationsPortalNativeDeliveryAuthority(database: D1Database,
  input: RevokeOperationsPortalNativeDeliveryAuthorityInput) {
  if (!UUID.test(input.operationId) || !UUID.test(input.authorityId) || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1 || !bounded(input.reasonCode, 200)) denied();
  const session = database.withSession("first-primary"), generationValue = await generation(session, input.owner);
  const fingerprint = await stableFingerprint({ action: "delivery.revoke", operationId: input.operationId,
    authorityId: input.authorityId, expectedRevision: input.expectedRevision, reasonCode: input.reasonCode });
  const existing = await session.prepare("SELECT 1 FROM operations_portal_native_delivery_authority_commands WHERE operation_id=?")
    .bind(input.operationId).first();
  if (existing) return exactReplay(session, input.operationId, fingerprint, input.owner, generationValue);
  const current = await head(session, input.authorityId);
  if (!current || current.state !== "active" || current.revision !== input.expectedRevision) denied();
  if (!await ownerAuthorized(session, input.owner, generationValue, current.root_record_id, current.ops_division_id,
    "delivery.revoke")) denied();
  const wire = command(contextFromHead(current), { ...input, features: [], expiresAt: null },
    "delivery.revoke", new Date().toISOString());
  if (!parseOperationsPortalNativeDeliveryAuthorityCommand(wire)) denied();
  try { return { review: await persist(session, wire, fingerprint, input.owner, generationValue), replayed: false as const }; }
  catch (error) {
    try { return await exactReplay(session, input.operationId, fingerprint, input.owner, generationValue); }
    catch { denied(error); }
  }
}

export async function readOperationsPortalNativeDeliveryAuthorityForOwner(database: D1Database,
  authorityId: string, owner: Owner): Promise<OperationsPortalNativeDeliveryAuthorityReview> {
  if (!UUID.test(authorityId)) denied();
  const session = database.withSession("first-primary"), generationValue = await generation(session, owner);
  const current = await head(session, authorityId); if (!current) denied();
  if (!await ownerAuthorized(session, owner, generationValue, current.root_record_id, current.ops_division_id,
    current.state === "active" ? "delivery.grant" : "delivery.revoke")) denied();
  return review(current);
}

export async function readOperationsPortalNativeDeliveryAuthorityStatusForOwner(database: D1Database,
  authorityId: string, owner: Owner): Promise<OperationsPortalNativeDeliveryAuthorityOwnerStatus> {
  if (!UUID.test(authorityId)) denied();
  const session = database.withSession("first-primary"), generationValue = await generation(session, owner);
  const current = await head(session, authorityId); if (!current) denied();
  if (!await ownerAuthorized(session, owner, generationValue, current.root_record_id, current.ops_division_id,
    current.state === "active" ? "delivery.grant" : "delivery.revoke")) denied();
  const transport = await session.prepare(`SELECT command.action,outbox.state
    FROM operations_portal_native_delivery_authority_commands command
    JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
    WHERE command.operation_id=? AND command.authority_id=? AND command.resulting_revision=?`)
    .bind(current.latest_operation_id, current.authority_id, current.revision)
    .first<{ action: "delivery.grant" | "delivery.revoke"; state: string }>();
  if (!transport || transport.action !== "delivery.grant" && transport.action !== "delivery.revoke") denied();
  const transportStatus = transport.state === "acknowledged" ? "acknowledged" as const
    : transport.state === "dead" ? "dead" as const : "pending" as const;
  return Object.freeze({ authority: review(current), latestAction: transport.action, transportStatus,
    recoveryOperationId: transportStatus === "pending" ? current.latest_operation_id : null });
}

export async function listOperationsPortalNativeDeliveryAuthoritiesForOwner(database: D1Database, input: Readonly<{
  targetId: string; afterAuthorityId?: string | null; limit?: number; owner: Owner;
}>): Promise<OperationsPortalNativeDeliveryAuthorityOwnerPage> {
  if (!UUID.test(input.targetId) || input.afterAuthorityId && !UUID.test(input.afterAuthorityId)) denied();
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) denied();
  const session = database.withSession("first-primary"), generationValue = await generation(session, input.owner);
  let after = input.afterAuthorityId ?? "", more = false;
  const items: OperationsPortalNativeDeliveryAuthorityOwnerStatus[] = [];
  let lastScanned: string | null = null;
  for (let page = 0; page < 10 && items.length <= limit; page += 1) {
    const rows = await session.prepare(`SELECT head.*,project.name project_name,division.name division_name,
        json_extract(client_revision.profile_json,'$.name') client_name,
        command.action latest_action,outbox.state transport_state
      FROM operations_portal_native_delivery_authority_heads head
      LEFT JOIN operations_shared_projects project ON project.external_project_id=head.external_project_id
      LEFT JOIN divisions division ON division.id=head.ops_division_id
      LEFT JOIN operations_directory_records client_record ON client_record.record_id=head.target_client_record_id
      LEFT JOIN operations_directory_revisions client_revision ON client_revision.record_id=client_record.record_id
        AND client_revision.version=client_record.current_version
      JOIN operations_portal_native_delivery_authority_commands command
        ON command.operation_id=head.latest_operation_id AND command.authority_id=head.authority_id
        AND command.resulting_revision=head.revision
      JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
      WHERE head.target_id=? AND head.authority_id>? ORDER BY head.authority_id LIMIT 50`)
      .bind(input.targetId, after).all<HeadRow & { latest_action: "delivery.grant" | "delivery.revoke";
        transport_state: string }>();
    if (!rows.results.length) { more = false; break; }
    more = rows.results.length === 50;
    for (const row of rows.results) {
      after = row.authority_id; lastScanned = after;
      if (!await ownerAuthorized(session, input.owner, generationValue, row.root_record_id, row.ops_division_id,
        row.latest_action)) continue;
      const transportStatus = row.transport_state === "acknowledged" ? "acknowledged" as const
        : row.transport_state === "dead" ? "dead" as const : "pending" as const;
      items.push(Object.freeze({ authority: review(row), latestAction: row.latest_action, transportStatus,
        recoveryOperationId: transportStatus === "pending" ? row.latest_operation_id : null }));
      if (items.length > limit) break;
    }
    if (items.length > limit || rows.results.length < 50) break;
  }
  const selected = items.slice(0, limit), lastSelected = selected.at(-1)?.authority.authorityId ?? null;
  const nextAuthorityId = items.length > limit ? lastSelected : more ? lastScanned : null;
  return Object.freeze({ items: Object.freeze(selected), nextAuthorityId });
}
