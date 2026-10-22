import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, parseOperationsPortalNativeDeliveryAuthorityCommand,
  sha256OperationsPortalNativeDeliveryAuthorityCommand,
  type OperationsPortalNativeDeliveryAuthorityCommand, type OperationsPortalNativeDeliveryPublicationPins,
  type OperationsPortalNativeDeliveryPublicationContinuity } from "@ltds/shared/operations-portal-native-delivery-authority";

/** A bounded prerequisite for a future successor RPC, NOT content authorization.
 * It proves historical resource retention only. Current recipient/home authority,
 * portal consumer state, handles, audit and byte handoff still require proofs. */
export const WINDOWS_PORTAL_PUBLICATION_CHAIN_LIMIT = 64;
type Publication = OperationsPortalNativeDeliveryPublicationPins;
type Head = { operation_id: string; publication_id: string; revision: number; source_sequence: number;
  snapshot_id: string; snapshot_sha256: string };
type History = Head & { expected_revision: number; resource_retained: number };
export type WindowsPortalPublicationChainEvidence = OperationsPortalNativeDeliveryPublicationContinuity;
const fail = (): never => { throw new Error("windows_portal_publication_chain_unproven"); };
const publication = (r: Head): Publication => Object.freeze({ operationId: r.operation_id, publicationId: r.publication_id,
  revision: r.revision, sourceSequence: r.source_sequence, snapshotId: r.snapshot_id, snapshotSha256: r.snapshot_sha256 });

async function anchor(db: D1DatabaseSession, grant: OperationsPortalNativeDeliveryAuthorityCommand, canonical: string) {
  // An old grant cannot follow a replacement or even a same-authority revision.
  // The complete immutable wire must still be the acknowledged active head.
  return db.prepare(`SELECT p.latest_operation_id operation_id,c.publication_id,p.publication_revision revision,
      p.source_sequence,p.snapshot_id,p.snapshot_sha256
    FROM operations_portal_native_delivery_authority_heads h
    JOIN operations_portal_native_delivery_authority_outbox o ON o.operation_id=h.latest_operation_id
      AND o.state='acknowledged' AND o.canonical_wire_json=?
    JOIN operations_portal_native_delivery_authority_receipts r ON r.operation_id=o.operation_id
      AND r.acknowledged_claim_token=o.acknowledged_claim_token
    JOIN operations_portal_workspace_publication_heads p ON p.target_id=h.target_id
      AND p.target_revision=h.target_revision AND p.client_authority_id=h.client_authority_id
      AND p.workspace_id=h.workspace_id AND p.root_kind=h.root_kind AND p.root_record_id=h.root_record_id
    JOIN operations_portal_workspace_publication_commands c ON c.operation_id=p.latest_operation_id
      AND c.target_id=p.target_id AND c.snapshot_id=p.snapshot_id AND c.snapshot_sha256=p.snapshot_sha256
      AND c.source_sequence=p.source_sequence AND c.resulting_revision=p.publication_revision
    JOIN operations_portal_workspace_publication_current_checkpoints cp ON cp.checkpoint_id=p.checkpoint_id
    WHERE h.authority_id=? AND h.latest_operation_id=? AND h.revision=? AND h.state='active'
      AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(canonical, grant.authority.authorityId, grant.operationId, Number(grant.authority.resultingRevision)).first<Head>();
}

/** No HTTP/RPC mount or change to existing authorization. Only immutable
 * acknowledged applied publications count; failed/unapplied commands do not.
 * Every intermediate publication must retain the exact folder and project. */
export async function readWindowsPortalPublicationChainEvidence(database: D1Database,
  rawGrant: unknown): Promise<WindowsPortalPublicationChainEvidence> {
  const grant = parseOperationsPortalNativeDeliveryAuthorityCommand(rawGrant);
  if (!grant || grant.action !== "delivery.grant" || !grant.features.includes("file.download")
    || !grant.expiresAt || Date.parse(grant.expiresAt) <= Date.now()) return fail();
  const firstSequence = Number(grant.publication.sourceSequence), firstRevision = Number(grant.publication.revision);
  if (!Number.isSafeInteger(firstSequence) || !Number.isSafeInteger(firstRevision) || firstRevision !== firstSequence) return fail();
  const canonical = canonicalOperationsPortalNativeDeliveryAuthorityCommand(grant), db = database.withSession("first-primary");
  const before = await anchor(db, grant, canonical);
  if (!before || !Number.isSafeInteger(before.source_sequence) || before.revision !== before.source_sequence
    || before.source_sequence < firstSequence || before.source_sequence - firstSequence >= WINDOWS_PORTAL_PUBLICATION_CHAIN_LIMIT) return fail();
  const r = grant.resource, t = grant.target;
  const history = await db.prepare(`SELECT c.operation_id,c.publication_id,c.expected_revision,c.resulting_revision revision,
      c.source_sequence,c.snapshot_id,c.snapshot_sha256,
      CASE WHEN c.target_revision=? AND c.client_authority_id=? AND c.workspace_id=? AND c.root_kind=? AND c.root_record_id=?
        AND f.reservation_id IS NOT NULL AND f.binding_version=? AND f.client_folder_binding_id=?
        AND f.external_project_id=? AND f.ops_folder_project_id=? AND f.division_id=? AND f.r2_prefix=?
        AND f.base_r2_prefix=? AND f.base_match_method=? AND f.base_confirmed_by=? AND f.base_confirmed_at=?
        AND project.external_project_id IS NOT NULL AND project.project_version=? AND project.published=1
        AND project.organization_record_id IS original_project.organization_record_id
        AND project.client_record_id IS original_project.client_record_id
        THEN 1 ELSE 0 END resource_retained
    FROM operations_portal_workspace_publication_commands c
    JOIN operations_portal_workspace_publication_receipts receipt ON receipt.operation_id=c.operation_id
      AND receipt.publication_id=c.publication_id AND receipt.operation_fingerprint=c.operation_fingerprint
      AND receipt.target_id=c.target_id AND receipt.resulting_revision=c.resulting_revision
      AND receipt.source_sequence=c.source_sequence AND receipt.snapshot_id=c.snapshot_id AND receipt.snapshot_sha256=c.snapshot_sha256
    JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=c.operation_id
      AND outbox.state='acknowledged' AND outbox.acknowledged_claim_token=receipt.acknowledged_claim_token
    JOIN operations_portal_workspace_publication_checkpoints cp ON cp.checkpoint_id=c.checkpoint_id
      AND cp.target_id=c.target_id AND cp.target_revision=c.target_revision
    JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=c.snapshot_id
      AND snapshot.checkpoint_id=c.checkpoint_id AND snapshot.target_id=c.target_id
      AND snapshot.source_sequence=c.source_sequence AND snapshot.snapshot_sha256=c.snapshot_sha256
    LEFT JOIN operations_portal_workspace_publication_folder_sources f ON f.checkpoint_id=c.checkpoint_id AND f.reservation_id=?
    LEFT JOIN operations_portal_workspace_publication_project_sources project
      ON project.checkpoint_id=c.checkpoint_id AND project.external_project_id=f.external_project_id
    JOIN operations_portal_workspace_publication_commands original ON original.operation_id=?
    JOIN operations_portal_workspace_publication_project_sources original_project
      ON original_project.checkpoint_id=original.checkpoint_id AND original_project.external_project_id=?
    WHERE c.target_id=? AND c.source_sequence BETWEEN ? AND ?
    ORDER BY c.source_sequence,c.operation_id LIMIT 65`)
    .bind(Number(t.targetRevision), t.clientAuthorityId, t.workspaceId, t.rootKind, t.rootRecordId,
      Number(r.folderReservationRevision), r.clientFolderBindingId, r.externalProjectId, r.opsFolderProjectId, r.opsDivisionId,
      r.selectedR2Prefix, r.baseR2Prefix, r.baseMatchMethod, r.baseConfirmedBy, r.baseConfirmedAt, Number(r.projectVersion),
      r.folderReservationId, grant.publication.operationId, r.externalProjectId, t.targetId, firstSequence, before.source_sequence).all<History>();
  const rows = history.results;
  if (!history.success || rows.length !== before.source_sequence - firstSequence + 1 || rows.some((row, index) => row.resource_retained !== 1
    || row.source_sequence !== firstSequence + index || row.revision !== row.source_sequence
    || row.expected_revision !== row.revision - 1)) return fail();
  const first = publication(rows[0]!), current = publication(rows[rows.length - 1]!);
  if (first.operationId !== grant.publication.operationId || first.publicationId !== grant.publication.publicationId
    || first.snapshotId !== grant.publication.snapshotId || first.snapshotSha256 !== grant.publication.snapshotSha256
    || JSON.stringify(current) !== JSON.stringify(publication(before))) return fail();
  const grantFingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(grant);
  const chainSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
    protocol: "windows-portal-publication-chain-v1", grantFingerprint, publications: rows.map(publication),
  }))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  // Recheck the acknowledged grant and current publication after the history read and hashing.
  const after = await anchor(db, grant, canonical);
  if (!after || JSON.stringify(publication(after)) !== JSON.stringify(current) || Date.parse(grant.expiresAt) <= Date.now()) return fail();
  return Object.freeze({ grantOperationId: grant.operationId, grantFingerprint, first, current, publicationCount: rows.length, chainSha256 });
}
