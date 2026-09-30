import {
  canonicalOperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspacePublication,
  verifyOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublication,
} from "@ltds/shared/operations-portal-workspace-publication";

export type OperationsPortalWorkspacePublicationReceipt = Readonly<{
  operationId: string; publicationId: string; requestFingerprint: string; targetId: string;
  resultingRevision: string; sourceSequence: string; snapshotId: string; snapshotSha256: string; replayed: boolean;
}>;

type StoredReceipt = { operation_id: string; publication_id: string; request_fingerprint: string; target_id: string;
  resulting_revision: number; source_sequence: number; snapshot_id: string; snapshot_sha256: string };
type StoredHead = { revision: number; target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: string; root_record_id: string; source_sequence: number };
const failure = (code: string): never => { throw new Error(`operations_portal_workspace_publication_${code}`); };
const integer = (value: string): number => { const number = Number(value); return Number.isSafeInteger(number) ? number : failure("integer_overflow"); };
const receipt = (row: StoredReceipt, replayed: boolean): OperationsPortalWorkspacePublicationReceipt => ({
  operationId: row.operation_id, publicationId: row.publication_id, requestFingerprint: row.request_fingerprint,
  targetId: row.target_id, resultingRevision: String(row.resulting_revision), sourceSequence: String(row.source_sequence),
  snapshotId: row.snapshot_id, snapshotSha256: row.snapshot_sha256, replayed,
});

async function prior(db: D1DatabaseSession, operationId: string): Promise<StoredReceipt | null> {
  return db.prepare(`SELECT operation_id,publication_id,request_fingerprint,target_id,resulting_revision,
    source_sequence,snapshot_id,snapshot_sha256 FROM operations_portal_workspace_publication_receipts WHERE operation_id=?`)
    .bind(operationId).first<StoredReceipt>();
}

async function currentHead(db: D1DatabaseSession, targetId: string): Promise<StoredHead | null> {
  return db.prepare(`SELECT revision,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,source_sequence
    FROM operations_portal_workspace_publication_heads WHERE target_id=?`).bind(targetId).first<StoredHead>();
}

function receiptMatches(row: StoredReceipt, publication: OperationsPortalWorkspacePublication, fingerprint: string): boolean {
  return row.operation_id === publication.operationId && row.request_fingerprint === fingerprint
    && row.publication_id === publication.publicationId
    && row.target_id === publication.target.targetId && row.resulting_revision === integer(publication.resultingRevision)
    && row.source_sequence === integer(publication.snapshot.sourceSequence)
    && row.snapshot_id === publication.snapshot.snapshotId && row.snapshot_sha256 === publication.snapshot.snapshotSha256;
}

/** Read-only ambiguous-success reconciliation. An operation identifier alone
 * is never sufficient: the caller must re-present the complete closed publication. */
export async function getOperationsPortalWorkspacePublicationStatus(
  db: D1Database, input: unknown,
): Promise<OperationsPortalWorkspacePublicationReceipt | null> {
  const database = db.withSession("first-primary");
  const publication = await verifyOperationsPortalWorkspacePublication(input);
  if (!publication) return failure("invalid");
  const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
  const existing = await prior(database, publication.operationId);
  if (!existing) return null;
  if (!receiptMatches(existing, publication, fingerprint)) return failure("replay_mismatch");
  return receipt(existing, true);
}

/** Private persistence boundary only. Stored recipient/delivery heads remain
 * inert snapshot data; this function creates no identity, membership, grant,
 * entitlement, enrollment, service-home, folder binding, or route authority. */
export async function consumeOperationsPortalWorkspacePublication(
  db: D1Database, input: unknown,
): Promise<OperationsPortalWorkspacePublicationReceipt> {
  const database = db.withSession("first-primary");
  const publication = await verifyOperationsPortalWorkspacePublication(input);
  if (!publication) return failure("invalid");
  const canonical = canonicalOperationsPortalWorkspacePublication(publication);
  const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
  const existing = await prior(database, publication.operationId);
  if (existing) {
    if (!receiptMatches(existing, publication, fingerprint)) return failure("replay_mismatch");
    return receipt(existing, true);
  }
  const expected = integer(publication.expectedRevision), resulting = integer(publication.resultingRevision);
  const targetRevision = integer(publication.target.targetRevision);
  const sequence = integer(publication.snapshot.sourceSequence), counts = publication.snapshot.counts;
  const values = [publication.target.targetId, resulting, targetRevision, publication.target.clientAuthorityId,
    publication.target.workspaceId, publication.target.rootKind, publication.target.rootRecordId, sequence,
    publication.snapshot.snapshotId, publication.snapshot.checkpointId, publication.snapshot.snapshotSha256,
    publication.operationId] as const;
  const head = expected === 0
    ? database.prepare(`INSERT INTO operations_portal_workspace_publication_heads
        (target_id,revision,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,source_sequence,
          snapshot_id,checkpoint_id,snapshot_sha256,latest_operation_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?
        WHERE NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_heads WHERE target_id=?)`)
      .bind(...values, publication.target.targetId)
    : database.prepare(`UPDATE operations_portal_workspace_publication_heads SET revision=?,target_revision=?,source_sequence=?,
        snapshot_id=?,checkpoint_id=?,snapshot_sha256=?,latest_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE target_id=? AND revision=? AND client_authority_id=? AND workspace_id=? AND root_kind=? AND root_record_id=?
          AND target_revision=? AND source_sequence<?`)
      .bind(resulting, targetRevision, sequence, publication.snapshot.snapshotId, publication.snapshot.checkpointId,
        publication.snapshot.snapshotSha256, publication.operationId, publication.target.targetId, expected,
        publication.target.clientAuthorityId, publication.target.workspaceId, publication.target.rootKind,
        publication.target.rootRecordId, targetRevision, sequence);
  try {
    await database.batch([
      database.prepare(`INSERT INTO operations_portal_workspace_publication_commands
        (operation_id,publication_id,request_fingerprint,target_id,target_revision,client_authority_id,workspace_id,root_kind,
          root_record_id,expected_revision,resulting_revision,snapshot_id,checkpoint_id,source_sequence,snapshot_sha256,
          canonical_publication_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(publication.operationId, publication.publicationId, fingerprint, publication.target.targetId, targetRevision,
          publication.target.clientAuthorityId, publication.target.workspaceId, publication.target.rootKind,
          publication.target.rootRecordId, expected, resulting, publication.snapshot.snapshotId,
          publication.snapshot.checkpointId, sequence, publication.snapshot.snapshotSha256, canonical, publication.observedAt),
      head,
      database.prepare(`INSERT INTO operations_portal_workspace_publication_snapshots
        (snapshot_id,target_id,revision,checkpoint_id,source_sequence,snapshot_sha256,snapshot_json,
          directory_record_count,project_count,folder_reservation_count,recipient_authority_head_count,
          delivery_authority_head_count,operation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(publication.snapshot.snapshotId, publication.target.targetId, resulting, publication.snapshot.checkpointId,
          sequence, publication.snapshot.snapshotSha256, JSON.stringify(publication.snapshot), counts.directoryRecords,
          counts.projects, counts.folderReservations, counts.recipientAuthorityHeads, counts.deliveryAuthorityHeads,
          publication.operationId),
      database.prepare(`INSERT INTO operations_portal_workspace_publication_history
        (target_id,revision,source_sequence,snapshot_id,snapshot_sha256,operation_id) VALUES(?,?,?,?,?,?)`)
        .bind(publication.target.targetId, resulting, sequence, publication.snapshot.snapshotId,
          publication.snapshot.snapshotSha256, publication.operationId),
      database.prepare(`INSERT INTO operations_portal_workspace_publication_receipts
        (operation_id,request_fingerprint,publication_id,target_id,resulting_revision,source_sequence,snapshot_id,snapshot_sha256)
        VALUES(?,?,?,?,?,?,?,?)`).bind(publication.operationId, fingerprint, publication.publicationId,
        publication.target.targetId, resulting, sequence, publication.snapshot.snapshotId, publication.snapshot.snapshotSha256),
    ]);
  } catch (error) {
    const raced = await prior(database, publication.operationId);
    if (raced) {
      if (!receiptMatches(raced, publication, fingerprint)) return failure("conflict");
      return receipt(raced, true);
    }
    const headNow = await currentHead(database, publication.target.targetId);
    if (headNow && (headNow.revision !== expected || headNow.target_revision !== targetRevision
      || headNow.client_authority_id !== publication.target.clientAuthorityId
      || headNow.workspace_id !== publication.target.workspaceId || headNow.root_kind !== publication.target.rootKind
      || headNow.root_record_id !== publication.target.rootRecordId || headNow.source_sequence >= sequence)) return failure("conflict");
    if (error instanceof Error && error.message.includes("SQLITE_CONSTRAINT")) return failure("conflict");
    throw error;
  }
  const stored = await prior(database, publication.operationId);
  if (!stored || stored.request_fingerprint !== fingerprint) return failure("commit_unverified");
  return receipt(stored, false);
}
