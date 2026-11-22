import {
  canonicalOperationsPortalWorkspacePublication,
  verifyOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublication,
} from "@ltds/shared/operations-portal-workspace-publication";
import type { Env } from "./types";
import { sha256Hex } from "./security";

type NativeAuthorityEnv = Pick<Env, "DELIVERY_DB" | "CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED">;
export type NativeDirectFolderCoordinate = Readonly<{
  workspaceId: string; targetId: string; clientAuthorityId: string; sourceId: string;
}>;
export type NativeDirectFolderRecipient = Readonly<{
  issuer: string; subject: string; recipientRecordId: string; bindingId: string;
  grantRevision: number; ownershipEpoch: number; expiresAt: string | null;
}>;
export type NativeDirectFolderState = Readonly<{
  workspaceId: string; targetId: string; clientAuthorityId: string; targetRevision: number;
  publicationRevision: number; sourceId: string; snapshotId: string; snapshotSha256: string;
  rootKind: "organization" | "standalone_client"; rootRecordId: string; rootPublicId: string;
  workspaceVersion: string; membershipVersion: string; memberCount: number;
  snapshot: OperationsPortalWorkspacePublication["snapshot"];
  authorityModel: "operations_native"; recipients: readonly NativeDirectFolderRecipient[];
}>;

type PublicationRow = {
  target_id: string; revision: number; target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: string; root_record_id: string; ownership_epoch: number; source_sequence: number;
  snapshot_id: string; checkpoint_id: string; snapshot_sha256: string; latest_operation_id: string;
  snapshot_json: string; canonical_publication_json: string; request_fingerprint: string;
};
type RecipientRow = {
  recipient_binding_id: string; target_client_record_id: string; issuer: string; subject: string;
  grant_revision: number; ownership_epoch: number; expires_at: string | null;
};

const SOURCE = "project-alpha:primary";
const MAX_RECIPIENTS = 1_000;
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0
  && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

function enabled(env: NativeAuthorityEnv): void {
  if (env.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED !== "true")
    throw new Error("native-direct-folder-authority-disabled");
}
function validateCoordinate(input: NativeDirectFolderCoordinate): void {
  if (!input || input.sourceId !== SOURCE || !bounded(input.workspaceId, 200) || !uuid.test(input.targetId)
    || !uuid.test(input.clientAuthorityId)) throw new Error("native-direct-folder-coordinate-invalid");
}
function matchingRecord(publication: OperationsPortalWorkspacePublication, recordId: string) {
  return publication.snapshot.directoryRecords.find(record => record.recordId === recordId);
}
function eligibleRecipient(publication: OperationsPortalWorkspacePublication, row: RecipientRow): boolean {
  const root = matchingRecord(publication, publication.target.rootRecordId);
  const recipient = matchingRecord(publication, row.target_client_record_id);
  if (!root || !recipient || root.parentRecordId !== null) return false;
  if (publication.target.rootKind === "standalone_client")
    return root.kind === "client" && recipient.recordId === root.recordId && recipient.kind === "client"
      && recipient.parentRecordId === null;
  return root.kind === "organization" && recipient.kind === "client"
    && recipient.parentRecordId === root.recordId;
}

async function readState(env: NativeAuthorityEnv, input: NativeDirectFolderCoordinate): Promise<NativeDirectFolderState | null> {
  enabled(env);
  validateCoordinate(input);
  const database = env.DELIVERY_DB.withSession("first-primary");
  const row = await database.prepare(`SELECT workspace.target_id,publication.revision,workspace.target_revision,
      workspace.client_authority_id,workspace.workspace_id,workspace.root_kind,workspace.root_record_id,
      workspace.ownership_epoch,publication.source_sequence,publication.snapshot_id,publication.checkpoint_id,
      publication.snapshot_sha256,publication.latest_operation_id,snapshot.snapshot_json,
      command.canonical_publication_json,receipt.request_fingerprint
    FROM operations_portal_native_workspace_authority_heads workspace
    JOIN operations_portal_workspace_publication_heads publication
      ON publication.target_id=workspace.target_id AND publication.target_revision=workspace.target_revision
      AND publication.client_authority_id=workspace.client_authority_id AND publication.workspace_id=workspace.workspace_id
      AND publication.root_kind=workspace.root_kind AND publication.root_record_id=workspace.root_record_id
    JOIN operations_portal_workspace_publication_snapshots snapshot
      ON snapshot.snapshot_id=publication.snapshot_id AND snapshot.operation_id=publication.latest_operation_id
      AND snapshot.target_id=publication.target_id AND snapshot.revision=publication.revision
      AND snapshot.checkpoint_id=publication.checkpoint_id AND snapshot.source_sequence=publication.source_sequence
      AND snapshot.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_receipts receipt
      ON receipt.operation_id=publication.latest_operation_id AND receipt.target_id=publication.target_id
      AND receipt.resulting_revision=publication.revision AND receipt.source_sequence=publication.source_sequence
      AND receipt.snapshot_id=snapshot.snapshot_id AND receipt.snapshot_sha256=snapshot.snapshot_sha256
    JOIN operations_portal_workspace_publication_history history
      ON history.operation_id=receipt.operation_id AND history.target_id=receipt.target_id
      AND history.revision=receipt.resulting_revision AND history.source_sequence=receipt.source_sequence
      AND history.snapshot_id=receipt.snapshot_id AND history.snapshot_sha256=receipt.snapshot_sha256
    JOIN operations_portal_workspace_publication_commands command
      ON command.operation_id=receipt.operation_id AND command.request_fingerprint=receipt.request_fingerprint
      AND command.target_id=workspace.target_id AND command.target_revision=workspace.target_revision
      AND command.client_authority_id=workspace.client_authority_id AND command.workspace_id=workspace.workspace_id
      AND command.root_kind=workspace.root_kind AND command.root_record_id=workspace.root_record_id
      AND command.resulting_revision=publication.revision AND command.snapshot_id=publication.snapshot_id
      AND command.checkpoint_id=publication.checkpoint_id AND command.source_sequence=publication.source_sequence
      AND command.snapshot_sha256=publication.snapshot_sha256
    WHERE workspace.target_id=? AND workspace.workspace_id=? AND workspace.client_authority_id=?
      AND workspace.state='active' AND workspace.ownership_epoch>0 LIMIT 2`)
    .bind(input.targetId, input.workspaceId, input.clientAuthorityId).all<PublicationRow>();
  if (!row.success) throw new Error("native-direct-folder-publication-query-failed");
  if (row.results.length === 0) return null;
  if (row.results.length !== 1) throw new Error("native-direct-folder-publication-ambiguous");
  const stored = row.results[0]!;
  if (!positive(stored.revision) || !positive(stored.target_revision) || !positive(stored.ownership_epoch)
    || !positive(stored.source_sequence) || !uuid.test(stored.target_id) || !uuid.test(stored.client_authority_id)
    || !bounded(stored.workspace_id, 200) || !bounded(stored.snapshot_id, 200) || !bounded(stored.checkpoint_id, 200)
    || !sha256.test(stored.snapshot_sha256) || !sha256.test(stored.request_fingerprint))
    throw new Error("native-direct-folder-publication-row-invalid");
  let canonicalDocument: unknown, storedSnapshot: unknown;
  try {
    canonicalDocument = JSON.parse(stored.canonical_publication_json);
    storedSnapshot = JSON.parse(stored.snapshot_json);
  } catch { throw new Error("native-direct-folder-publication-json-invalid"); }
  const publication = await verifyOperationsPortalWorkspacePublication(canonicalDocument);
  if (!publication || canonicalOperationsPortalWorkspacePublication(publication) !== stored.canonical_publication_json
    || JSON.stringify(publication.snapshot) !== JSON.stringify(storedSnapshot)
    || publication.target.targetId !== stored.target_id || publication.target.targetRevision !== String(stored.target_revision)
    || publication.target.clientAuthorityId !== stored.client_authority_id || publication.target.workspaceId !== stored.workspace_id
    || publication.target.rootKind !== stored.root_kind || publication.target.rootRecordId !== stored.root_record_id
    || publication.resultingRevision !== String(stored.revision) || publication.snapshot.sourceSequence !== String(stored.source_sequence)
    || publication.snapshot.snapshotId !== stored.snapshot_id || publication.snapshot.checkpointId !== stored.checkpoint_id
    || publication.snapshot.snapshotSha256 !== stored.snapshot_sha256)
    throw new Error("native-direct-folder-publication-proof-invalid");
  if (publication.target.targetId !== input.targetId || publication.target.workspaceId !== input.workspaceId
    || publication.target.clientAuthorityId !== input.clientAuthorityId || input.sourceId !== SOURCE)
    throw new Error("native-direct-folder-publication-coordinate-mismatch");
  const root = matchingRecord(publication, publication.target.rootRecordId);
  if (!root || root.parentRecordId !== null
    || publication.target.rootKind === "organization" && root.kind !== "organization"
    || publication.target.rootKind === "standalone_client" && root.kind !== "client")
    throw new Error("native-direct-folder-publication-root-invalid");

  const recipientResult = await database.prepare(`SELECT recipient.recipient_binding_id,recipient.target_client_record_id,
      recipient.issuer,recipient.subject,recipient.grant_revision,recipient.ownership_epoch,recipient.expires_at
    FROM operations_portal_native_recipient_authority_heads recipient
    JOIN operations_portal_native_authority_receipts receipt
      ON receipt.operation_id=recipient.latest_operation_id AND receipt.target_id=recipient.target_id
      AND receipt.recipient_binding_id=recipient.recipient_binding_id AND receipt.ownership_epoch=recipient.ownership_epoch
      AND receipt.grant_revision=recipient.grant_revision AND receipt.state='active' AND receipt.action='recipient.grant'
    JOIN operations_portal_native_authority_commands command
      ON command.operation_id=receipt.operation_id AND command.request_fingerprint=receipt.request_fingerprint
      AND command.action='recipient.grant' AND command.target_id=recipient.target_id
      AND command.target_revision=? AND command.client_authority_id=? AND command.workspace_id=?
      AND command.root_kind=? AND command.root_record_id=?
      AND command.recipient_binding_id=recipient.recipient_binding_id
      AND command.enrollment_intent_id=recipient.enrollment_intent_id
      AND command.target_client_record_id=recipient.target_client_record_id
      AND command.issuer=recipient.issuer AND command.subject=recipient.subject
      AND command.resulting_ownership_epoch=recipient.ownership_epoch
      AND command.resulting_grant_revision=recipient.grant_revision
      AND command.permissions_json=recipient.permissions_json AND command.expires_at IS recipient.expires_at
    WHERE recipient.target_id=? AND recipient.ownership_epoch=? AND recipient.state='active'
      AND recipient.permissions_json='["operations.service_home.read"]'
      AND (recipient.expires_at IS NULL OR datetime(recipient.expires_at)>datetime('now'))
    ORDER BY recipient.target_client_record_id,recipient.issuer,recipient.subject LIMIT ?`)
    .bind(stored.target_revision, stored.client_authority_id, stored.workspace_id, stored.root_kind,
      stored.root_record_id, stored.target_id, stored.ownership_epoch, MAX_RECIPIENTS + 1).all<RecipientRow>();
  if (!recipientResult.success || recipientResult.results.length > MAX_RECIPIENTS)
    throw new Error("native-direct-folder-recipient-query-failed");
  const recipients: NativeDirectFolderRecipient[] = [];
  const seen = new Set<string>();
  for (const recipient of recipientResult.results) {
    if (!uuid.test(recipient.recipient_binding_id) || !bounded(recipient.target_client_record_id, 200)
      || !bounded(recipient.issuer, 512) || !bounded(recipient.subject, 512)
      || !positive(recipient.grant_revision) || recipient.ownership_epoch !== stored.ownership_epoch
      || recipient.expires_at !== null && (!bounded(recipient.expires_at, 40) || !Number.isFinite(Date.parse(recipient.expires_at)))
      || !eligibleRecipient(publication, recipient)) throw new Error("native-direct-folder-recipient-proof-invalid");
    const identityKey = JSON.stringify([recipient.issuer, recipient.subject]);
    if (seen.has(identityKey)) throw new Error("native-direct-folder-recipient-ambiguous");
    seen.add(identityKey);
    recipients.push(Object.freeze({ issuer: recipient.issuer, subject: recipient.subject,
      recipientRecordId: recipient.target_client_record_id, bindingId: recipient.recipient_binding_id,
      grantRevision: recipient.grant_revision, ownershipEpoch: recipient.ownership_epoch, expiresAt: recipient.expires_at }));
  }
  const workspaceVersion = await sha256Hex(JSON.stringify(["operations-native-direct-folder-v1", input.sourceId,
    stored.target_id, stored.target_revision, stored.client_authority_id, stored.workspace_id, stored.root_kind,
    stored.root_record_id, stored.ownership_epoch, stored.revision, stored.source_sequence, stored.snapshot_id, stored.snapshot_sha256]));
  const membershipVersion = await sha256Hex(JSON.stringify(["operations-native-direct-folder-recipients-v1", input.workspaceId,
    recipients.map(item => [item.issuer, item.subject, item.recipientRecordId, item.bindingId,
      item.grantRevision, item.ownershipEpoch, item.expiresAt])]));
  return Object.freeze({ workspaceId: stored.workspace_id, targetId: stored.target_id,
    clientAuthorityId: stored.client_authority_id, targetRevision: stored.target_revision,
    publicationRevision: stored.revision, sourceId: input.sourceId, snapshotId: stored.snapshot_id,
    snapshotSha256: stored.snapshot_sha256, rootKind: publication.target.rootKind,
    rootRecordId: publication.target.rootRecordId, rootPublicId: publication.target.rootRecordId,
    workspaceVersion, membershipVersion, memberCount: recipients.length, snapshot: publication.snapshot,
    authorityModel: "operations_native", recipients: Object.freeze(recipients) });
}

export async function readNativeDirectFolderWorkspaceState(env: NativeAuthorityEnv,
  coordinate: NativeDirectFolderCoordinate): Promise<NativeDirectFolderState | null> {
  return readState(env, coordinate);
}

export async function readNativeDirectFolderRecipients(env: NativeAuthorityEnv,
  coordinate: NativeDirectFolderCoordinate): Promise<readonly NativeDirectFolderRecipient[] | null> {
  const state = await readState(env, coordinate);
  return state?.recipients ?? null;
}
