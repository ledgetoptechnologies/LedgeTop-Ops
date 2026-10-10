import type { VerifiedClientPrincipal } from "./types";

export type NativeOperationsPortalHome = Readonly<{
  authorityId: string;
  workspaceId: string;
  targetId: string;
  recipientBindingId: string;
  ownershipEpoch: number;
  grantRevision: number;
}>;

type Row = {
  authority_id: string; workspace_id: string; target_id: string;
  recipient_binding_id: string; ownership_epoch: number; grant_revision: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);

/** Service-home discovery only. A home permission never grants file access.
 * Missing/partial migrations, receipt drift and over-limit results fail closed.
 * The caller must use a server-verified principal and recheck after async work. */
export async function readNativeOperationsPortalHomes(
  database: D1Database,
  principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">,
  enabled: boolean,
): Promise<readonly NativeOperationsPortalHome[] | null> {
  if (!enabled) return [];
  if (!bounded(principal.issuer, 512) || !bounded(principal.subject, 512)) return [];
  try {
    const result = await database.withSession("first-primary").prepare(`
      SELECT workspace.client_authority_id authority_id,workspace.workspace_id,
        workspace.target_id,recipient.recipient_binding_id,
        recipient.ownership_epoch,recipient.grant_revision
      FROM operations_portal_native_recipient_authority_heads recipient
      JOIN operations_portal_native_workspace_authority_heads workspace
        ON workspace.target_id=recipient.target_id
          AND workspace.ownership_epoch=recipient.ownership_epoch AND workspace.state='active'
      JOIN operations_portal_native_authority_receipts receipt
        ON receipt.operation_id=recipient.latest_operation_id
          AND receipt.target_id=recipient.target_id
          AND receipt.recipient_binding_id=recipient.recipient_binding_id
          AND receipt.ownership_epoch=recipient.ownership_epoch
          AND receipt.grant_revision=recipient.grant_revision AND receipt.state='active'
          AND receipt.action='recipient.grant'
      JOIN operations_portal_native_authority_commands command
        ON command.operation_id=receipt.operation_id
          AND command.request_fingerprint=receipt.request_fingerprint
          AND command.client_authority_id=workspace.client_authority_id
          AND command.workspace_id=workspace.workspace_id
          AND command.target_revision=workspace.target_revision
          AND command.recipient_binding_id=recipient.recipient_binding_id
          AND command.enrollment_intent_id=recipient.enrollment_intent_id
          AND command.target_client_record_id=recipient.target_client_record_id
          AND command.issuer=recipient.issuer AND command.subject=recipient.subject
          AND command.permissions_json=recipient.permissions_json
      JOIN operations_portal_workspace_publication_heads publication
        ON publication.target_id=workspace.target_id
          AND publication.target_revision=workspace.target_revision
          AND publication.client_authority_id=workspace.client_authority_id
          AND publication.workspace_id=workspace.workspace_id
          AND publication.root_kind=workspace.root_kind AND publication.root_record_id=workspace.root_record_id
      JOIN operations_portal_workspace_publication_snapshots snapshot
        ON snapshot.snapshot_id=publication.snapshot_id
          AND snapshot.operation_id=publication.latest_operation_id
          AND snapshot.target_id=publication.target_id AND snapshot.revision=publication.revision
          AND snapshot.source_sequence=publication.source_sequence
          AND snapshot.snapshot_sha256=publication.snapshot_sha256
      JOIN operations_portal_workspace_publication_receipts publication_receipt
        ON publication_receipt.operation_id=publication.latest_operation_id
          AND publication_receipt.target_id=publication.target_id
          AND publication_receipt.resulting_revision=publication.revision
          AND publication_receipt.source_sequence=publication.source_sequence
          AND publication_receipt.snapshot_id=snapshot.snapshot_id
          AND publication_receipt.snapshot_sha256=snapshot.snapshot_sha256
      JOIN operations_portal_workspace_publication_history publication_history
        ON publication_history.operation_id=publication_receipt.operation_id
          AND publication_history.target_id=publication.target_id
          AND publication_history.revision=publication.revision
          AND publication_history.source_sequence=publication.source_sequence
          AND publication_history.snapshot_id=snapshot.snapshot_id
          AND publication_history.snapshot_sha256=snapshot.snapshot_sha256
      WHERE recipient.issuer=? AND recipient.subject=? AND recipient.state='active'
        AND recipient.permissions_json='["operations.service_home.read"]'
        AND (recipient.expires_at IS NULL OR datetime(recipient.expires_at)>datetime('now'))
        AND ((workspace.root_kind='standalone_client' AND recipient.target_client_record_id=workspace.root_record_id)
          OR (workspace.root_kind='organization' AND EXISTS (
            SELECT 1 FROM json_each(snapshot.snapshot_json,'$.directoryRecords') member
            WHERE json_extract(member.value,'$.recordId')=recipient.target_client_record_id
              AND json_extract(member.value,'$.kind')='client'
              AND json_extract(member.value,'$.parentRecordId')=workspace.root_record_id)))
      ORDER BY workspace.client_authority_id LIMIT 21
    `).bind(principal.issuer, principal.subject).all<Row>();
    if (!result.success || result.results.length > 20) return null;
    const homes: NativeOperationsPortalHome[] = [];
    for (const row of result.results) {
      if (!uuid.test(row.authority_id) || !uuid.test(row.target_id) || !uuid.test(row.recipient_binding_id)
        || !bounded(row.workspace_id, 200) || !Number.isSafeInteger(row.ownership_epoch) || row.ownership_epoch < 1
        || !Number.isSafeInteger(row.grant_revision) || row.grant_revision < 1) return null;
      homes.push(Object.freeze({ authorityId: row.authority_id, workspaceId: row.workspace_id,
        targetId: row.target_id, recipientBindingId: row.recipient_binding_id,
        ownershipEpoch: row.ownership_epoch, grantRevision: row.grant_revision }));
    }
    return new Set(homes.map(home => home.authorityId)).size === homes.length ? Object.freeze(homes) : null;
  } catch { return null; }
}
