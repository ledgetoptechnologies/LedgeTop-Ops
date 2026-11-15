import type { VerifiedClientPrincipal } from "./types";

/** A request.create witness is a companion to an independently current v3
 * service-home grant. It cannot be used as workspace membership or file access. */
export type NativeOperationsRequestCapability = Readonly<{
  targetId: string;
  targetRevision: number;
  clientAuthorityId: string;
  workspaceId: string;
  targetClientRecordId: string;
  recipientBindingId: string;
  issuer: string;
  subject: string;
  baseOperationId: string;
  ownershipEpoch: number;
  grantRevision: number;
  capabilityOperationId: string;
  capabilityRevision: number;
  publicationOperationId: string;
  publicationRevision: number;
  publicationSourceSequence: number;
  publicationSnapshotId: string;
  publicationSnapshotSha256: string;
  expiresAt: string;
}>;

type CapabilityRow = {
  target_id: string; target_revision: number; client_authority_id: string; workspace_id: string;
  target_client_record_id: string; recipient_binding_id: string; issuer: string; subject: string;
  base_operation_id: string; base_ownership_epoch: number; base_grant_revision: number;
  capability_operation_id: string; capability_revision: number;
  publication_operation_id: string; publication_revision: number; publication_source_sequence: number;
  publication_snapshot_id: string; publication_snapshot_sha256: string; expires_at: string;
};
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH256 = /^[0-9a-f]{64}$/u;
const bounded = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0
  && value.length <= maximum && value.trim() === value && !/\p{C}/u.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && value.length === 24
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Returns null for unavailable/partial schema; [] means a valid read with no
 * active request capability. The query independently rechecks all v3 parent
 * pins and the latest publication on every call. */
export async function readNativeOperationsRequestCapabilities(database: D1Database,
  principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">, enabled: boolean,
): Promise<readonly NativeOperationsRequestCapability[] | null> {
  if (!enabled) return [];
  if (!bounded(principal.issuer, 512) || !bounded(principal.subject, 512)) return [];
  try {
    const result = await database.withSession("first-primary").prepare(`
      SELECT workspace.target_id,workspace.target_revision,workspace.client_authority_id,workspace.workspace_id,
        recipient.target_client_record_id,recipient.recipient_binding_id,recipient.issuer,recipient.subject,
        recipient.latest_operation_id base_operation_id,recipient.ownership_epoch base_ownership_epoch,
        recipient.grant_revision base_grant_revision,capability.operation_id capability_operation_id,
        capability.resulting_revision capability_revision,capability.publication_operation_id,
        capability.publication_revision,capability.publication_source_sequence,capability.publication_snapshot_id,
        capability.publication_snapshot_sha256,capability.expires_at
      FROM operations_portal_native_inquiry_capability_heads cap_head
      JOIN operations_portal_native_inquiry_capability_commands capability
        ON capability.operation_id=cap_head.latest_operation_id AND capability.intent_id=cap_head.intent_id
          AND capability.action='grant' AND capability.resulting_revision=cap_head.revision
          AND capability.permission='operations.request.create'
      JOIN operations_portal_native_inquiry_capability_receipts cap_receipt
        ON cap_receipt.operation_id=capability.operation_id AND cap_receipt.request_fingerprint=capability.request_fingerprint
          AND cap_receipt.resulting_revision=capability.resulting_revision AND cap_receipt.state='prepared'
      JOIN operations_portal_native_inquiry_capability_closures closure
        ON closure.operation_id=capability.operation_id AND closure.request_fingerprint=capability.request_fingerprint
          AND closure.client_receipt_fingerprint=cap_receipt.request_fingerprint AND closure.resulting_state='active'
          AND length(closure.operations_receipt_fingerprint)=64
      JOIN operations_portal_native_recipient_authority_heads recipient
        ON recipient.recipient_binding_id=cap_head.recipient_binding_id AND recipient.target_id=cap_head.target_id
          AND recipient.latest_operation_id=cap_head.base_operation_id
          AND recipient.ownership_epoch=cap_head.base_ownership_epoch AND recipient.grant_revision=cap_head.base_grant_revision
          AND recipient.state='active' AND recipient.permissions_json='["operations.service_home.read"]'
          AND recipient.issuer=? AND recipient.subject=?
          AND (recipient.expires_at IS NULL OR datetime(recipient.expires_at)>datetime('now'))
      JOIN operations_portal_native_authority_receipts base_receipt
        ON base_receipt.operation_id=recipient.latest_operation_id
          AND base_receipt.target_id=recipient.target_id AND base_receipt.recipient_binding_id=recipient.recipient_binding_id
          AND base_receipt.ownership_epoch=recipient.ownership_epoch AND base_receipt.grant_revision=recipient.grant_revision
          AND base_receipt.state='active'
      JOIN operations_portal_native_authority_commands base_command
        ON base_command.operation_id=base_receipt.operation_id AND base_command.request_fingerprint=base_receipt.request_fingerprint
          AND base_command.action='recipient.grant' AND base_command.target_id=recipient.target_id
          AND base_command.recipient_binding_id=recipient.recipient_binding_id
          AND base_command.enrollment_intent_id=cap_head.intent_id
          AND base_command.target_client_record_id=recipient.target_client_record_id
          AND base_command.issuer=recipient.issuer AND base_command.subject=recipient.subject
          AND base_command.permissions_json='["operations.service_home.read"]'
      JOIN operations_portal_native_workspace_authority_heads workspace
        ON workspace.target_id=recipient.target_id AND workspace.ownership_epoch=recipient.ownership_epoch
          AND workspace.state='active' AND workspace.target_revision=capability.target_revision
          AND workspace.client_authority_id=capability.client_authority_id AND workspace.workspace_id=capability.workspace_id
      JOIN operations_portal_workspace_publication_heads publication
        ON publication.target_id=workspace.target_id AND publication.target_revision=workspace.target_revision
          AND publication.client_authority_id=workspace.client_authority_id AND publication.workspace_id=workspace.workspace_id
          AND publication.latest_operation_id=capability.publication_operation_id
          AND publication.revision=capability.publication_revision
          AND publication.source_sequence=capability.publication_source_sequence
          AND publication.snapshot_id=capability.publication_snapshot_id
          AND publication.snapshot_sha256=capability.publication_snapshot_sha256
      JOIN operations_portal_workspace_publication_receipts publication_receipt
        ON publication_receipt.operation_id=publication.latest_operation_id
          AND publication_receipt.resulting_revision=publication.revision
          AND publication_receipt.source_sequence=publication.source_sequence
          AND publication_receipt.snapshot_id=publication.snapshot_id
          AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
      JOIN operations_portal_workspace_publication_snapshots snapshot
        ON snapshot.snapshot_id=publication.snapshot_id AND snapshot.operation_id=publication.latest_operation_id
          AND snapshot.target_id=publication.target_id AND snapshot.revision=publication.revision
          AND snapshot.source_sequence=publication.source_sequence AND snapshot.snapshot_sha256=publication.snapshot_sha256
      JOIN operations_portal_workspace_publication_history publication_history
        ON publication_history.operation_id=publication_receipt.operation_id
          AND publication_history.target_id=publication.target_id AND publication_history.revision=publication.revision
          AND publication_history.source_sequence=publication.source_sequence
          AND publication_history.snapshot_id=publication.snapshot_id
          AND publication_history.snapshot_sha256=publication.snapshot_sha256
      JOIN json_each(snapshot.snapshot_json,'$.directoryRecords') member
      WHERE cap_head.state='active' AND cap_head.revision=1
        AND cap_head.intent_id=recipient.enrollment_intent_id AND cap_head.base_operation_id=base_command.operation_id
        AND capability.base_operation_id=base_command.operation_id
        AND capability.base_ownership_epoch=recipient.ownership_epoch
        AND capability.base_grant_revision=recipient.grant_revision
        AND capability.recipient_binding_id=recipient.recipient_binding_id
        AND capability.target_id=workspace.target_id AND capability.target_client_record_id=recipient.target_client_record_id
        AND capability.issuer=recipient.issuer AND capability.subject=recipient.subject
        AND capability.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND (recipient.expires_at IS NULL OR datetime(capability.expires_at)<=datetime(recipient.expires_at))
        AND json_extract(member.value,'$.recordId')=recipient.target_client_record_id
        AND json_extract(member.value,'$.kind')='client'
        AND ((workspace.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=workspace.root_record_id)
          OR (workspace.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
            AND json_extract(member.value,'$.recordId')=workspace.root_record_id))
      ORDER BY workspace.client_authority_id LIMIT 21
    `).bind(principal.issuer, principal.subject).all<CapabilityRow>();
    if (!result.success || result.results.length > 20) return null;
    const capabilities: NativeOperationsRequestCapability[] = [];
    for (const row of result.results) {
      if (!UUID4.test(row.target_id) || !Number.isSafeInteger(row.target_revision) || row.target_revision < 1
        || !UUID4.test(row.client_authority_id) || !bounded(row.workspace_id, 200)
        || !bounded(row.target_client_record_id, 191) || !UUID4.test(row.recipient_binding_id)
        || !bounded(row.issuer, 512) || !bounded(row.subject, 512) || !UUID4.test(row.base_operation_id)
        || !Number.isSafeInteger(row.base_ownership_epoch) || row.base_ownership_epoch < 1
        || !Number.isSafeInteger(row.base_grant_revision) || row.base_grant_revision < 1
        || !UUID4.test(row.capability_operation_id) || row.capability_revision !== 1
        || !UUID4.test(row.publication_operation_id) || !Number.isSafeInteger(row.publication_revision)
        || row.publication_revision < 1 || !Number.isSafeInteger(row.publication_source_sequence)
        || row.publication_source_sequence < 1 || !UUID4.test(row.publication_snapshot_id)
        || !HASH256.test(row.publication_snapshot_sha256) || !instant(row.expires_at)
        || Date.parse(row.expires_at) <= Date.now()) return null;
      capabilities.push(Object.freeze({ targetId: row.target_id, targetRevision: row.target_revision,
        clientAuthorityId: row.client_authority_id, workspaceId: row.workspace_id,
        targetClientRecordId: row.target_client_record_id, recipientBindingId: row.recipient_binding_id,
        issuer: row.issuer, subject: row.subject, baseOperationId: row.base_operation_id,
        ownershipEpoch: row.base_ownership_epoch, grantRevision: row.base_grant_revision,
        capabilityOperationId: row.capability_operation_id, capabilityRevision: row.capability_revision,
        publicationOperationId: row.publication_operation_id, publicationRevision: row.publication_revision,
        publicationSourceSequence: row.publication_source_sequence, publicationSnapshotId: row.publication_snapshot_id,
        publicationSnapshotSha256: row.publication_snapshot_sha256, expiresAt: row.expires_at }));
    }
    return new Set(capabilities.map(item => item.targetId)).size === capabilities.length ? Object.freeze(capabilities) : null;
  } catch { return null; }
}
