import {
  canonicalOperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspacePublication,
  verifyOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublication,
} from "@ltds/shared/operations-portal-workspace-publication";
import type { OperationsPortalWorkspacePublicationReceipt } from "./operations-portal-workspace-publications";

export type OperationsPortalWorkspacePublicationCancellation = Readonly<{
  operationId: string; publicationId: string; requestFingerprint: string; targetId: string;
  targetRevision: string; clientAuthorityId: string; workspaceId: string;
  rootKind: "organization" | "standalone_client"; rootRecordId: string;
  expectedRevision: string; resultingRevision: string; sourceSequence: string;
  snapshotId: string; checkpointId: string; snapshotSha256: string; cancelledAt: string; replayed: boolean;
}>;
export type OperationsPortalWorkspacePublicationDisposition =
  | Readonly<{ disposition: "committed"; receipt: OperationsPortalWorkspacePublicationReceipt }>
  | Readonly<{ disposition: "cancelled"; cancellation: OperationsPortalWorkspacePublicationCancellation }>;

export class OperationsPortalWorkspacePublicationCancelledError extends Error {
  constructor(readonly cancellation: OperationsPortalWorkspacePublicationCancellation) {
    super("operations_portal_workspace_publication_cancelled");
  }
}

type StoredReceipt = { operation_id: string; publication_id: string; request_fingerprint: string; target_id: string;
  resulting_revision: number; source_sequence: number; snapshot_id: string; snapshot_sha256: string };
type StoredCancellation = { operation_id: string; publication_id: string; request_fingerprint: string; target_id: string;
  target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string; expected_revision: number;
  resulting_revision: number; source_sequence: number; snapshot_id: string; checkpoint_id: string;
  snapshot_sha256: string; canonical_publication_json: string; cancelled_at: string };

const failure = (code: string): never => { throw new Error(`operations_portal_workspace_publication_${code}`); };
const integer = (value: string): number => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : failure("integer_overflow");
};
async function receiptRow(db: D1DatabaseSession, operationId: string): Promise<StoredReceipt | null> {
  return db.prepare(`SELECT operation_id,publication_id,request_fingerprint,target_id,resulting_revision,
    source_sequence,snapshot_id,snapshot_sha256 FROM operations_portal_workspace_publication_receipts WHERE operation_id=?`)
    .bind(operationId).first<StoredReceipt>();
}
async function cancellationRow(db: D1DatabaseSession, operationId: string): Promise<StoredCancellation | null> {
  try {
    return await db.prepare(`SELECT operation_id,publication_id,request_fingerprint,target_id,target_revision,client_authority_id,
      workspace_id,root_kind,root_record_id,expected_revision,resulting_revision,source_sequence,snapshot_id,checkpoint_id,
      snapshot_sha256,canonical_publication_json,cancelled_at
      FROM operations_portal_workspace_publication_cancellations WHERE operation_id=?`)
      .bind(operationId).first<StoredCancellation>();
  } catch (error) {
    // The code may roll out before additive 0225 while the writer remains
    // default-off. Preserve 0223 receipt behavior, but never treat an insert
    // failure as cancellation success.
    if (error instanceof Error && error.message.includes("no such table")
      && error.message.includes("operations_portal_workspace_publication_cancellations")) return null;
    throw error;
  }
}
function receiptMatches(row: StoredReceipt, publication: OperationsPortalWorkspacePublication, fingerprint: string) {
  return row.operation_id === publication.operationId && row.publication_id === publication.publicationId
    && row.request_fingerprint === fingerprint && row.target_id === publication.target.targetId
    && row.resulting_revision === integer(publication.resultingRevision)
    && row.source_sequence === integer(publication.snapshot.sourceSequence)
    && row.snapshot_id === publication.snapshot.snapshotId && row.snapshot_sha256 === publication.snapshot.snapshotSha256;
}
function asReceipt(row: StoredReceipt): OperationsPortalWorkspacePublicationReceipt {
  return { operationId: row.operation_id, publicationId: row.publication_id, requestFingerprint: row.request_fingerprint,
    targetId: row.target_id, resultingRevision: String(row.resulting_revision), sourceSequence: String(row.source_sequence),
    snapshotId: row.snapshot_id, snapshotSha256: row.snapshot_sha256, replayed: true };
}
function cancellationMatches(row: StoredCancellation, publication: OperationsPortalWorkspacePublication, fingerprint: string) {
  return row.operation_id === publication.operationId && row.publication_id === publication.publicationId
    && row.request_fingerprint === fingerprint && row.target_id === publication.target.targetId
    && row.target_revision === integer(publication.target.targetRevision)
    && row.client_authority_id === publication.target.clientAuthorityId
    && row.workspace_id === publication.target.workspaceId && row.root_kind === publication.target.rootKind
    && row.root_record_id === publication.target.rootRecordId
    && row.expected_revision === integer(publication.expectedRevision)
    && row.resulting_revision === integer(publication.resultingRevision)
    && row.source_sequence === integer(publication.snapshot.sourceSequence)
    && row.snapshot_id === publication.snapshot.snapshotId && row.checkpoint_id === publication.snapshot.checkpointId
    && row.snapshot_sha256 === publication.snapshot.snapshotSha256
    && row.canonical_publication_json === canonicalOperationsPortalWorkspacePublication(publication);
}
function asCancellation(row: StoredCancellation, replayed: boolean): OperationsPortalWorkspacePublicationCancellation {
  return { operationId: row.operation_id, publicationId: row.publication_id, requestFingerprint: row.request_fingerprint,
    targetId: row.target_id, targetRevision: String(row.target_revision), clientAuthorityId: row.client_authority_id,
    workspaceId: row.workspace_id, rootKind: row.root_kind, rootRecordId: row.root_record_id,
    expectedRevision: String(row.expected_revision), resultingRevision: String(row.resulting_revision),
    sourceSequence: String(row.source_sequence), snapshotId: row.snapshot_id, checkpointId: row.checkpoint_id,
    snapshotSha256: row.snapshot_sha256, cancelledAt: row.cancelled_at, replayed };
}

async function readDisposition(db: D1DatabaseSession, publication: OperationsPortalWorkspacePublication,
  fingerprint: string): Promise<OperationsPortalWorkspacePublicationDisposition | null> {
  const committed = await receiptRow(db, publication.operationId);
  if (committed) {
    if (!receiptMatches(committed, publication, fingerprint)) return failure("replay_mismatch");
    return { disposition: "committed", receipt: asReceipt(committed) };
  }
  const cancelled = await cancellationRow(db, publication.operationId);
  if (!cancelled) return null;
  if (!cancellationMatches(cancelled, publication, fingerprint)) return failure("replay_mismatch");
  return { disposition: "cancelled", cancellation: asCancellation(cancelled, true) };
}

export async function getOperationsPortalWorkspacePublicationDisposition(
  db: D1Database, input: unknown,
): Promise<OperationsPortalWorkspacePublicationDisposition | null> {
  const database = db.withSession("first-primary");
  const publication = await verifyOperationsPortalWorkspacePublication(input);
  if (!publication) return failure("invalid");
  const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
  return readDisposition(database, publication, fingerprint);
}

/** Permanently terminates one exact, not-yet-committed publication attempt.
 * The complete publication is re-presented so an operation id alone can never
 * cancel or discover another snapshot. */
export async function cancelOperationsPortalWorkspacePublication(
  db: D1Database, input: unknown,
): Promise<OperationsPortalWorkspacePublicationDisposition> {
  const database = db.withSession("first-primary");
  const publication = await verifyOperationsPortalWorkspacePublication(input);
  if (!publication) return failure("invalid");
  const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
  const existing = await readDisposition(database, publication, fingerprint);
  if (existing) return existing;
  const canonical = canonicalOperationsPortalWorkspacePublication(publication);
  try {
    await database.prepare(`INSERT INTO operations_portal_workspace_publication_cancellations
      (operation_id,publication_id,request_fingerprint,target_id,target_revision,client_authority_id,workspace_id,
        root_kind,root_record_id,expected_revision,resulting_revision,source_sequence,snapshot_id,checkpoint_id,
        snapshot_sha256,canonical_publication_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(publication.operationId, publication.publicationId, fingerprint, publication.target.targetId,
        integer(publication.target.targetRevision), publication.target.clientAuthorityId, publication.target.workspaceId,
        publication.target.rootKind, publication.target.rootRecordId, integer(publication.expectedRevision),
        integer(publication.resultingRevision), integer(publication.snapshot.sourceSequence), publication.snapshot.snapshotId,
        publication.snapshot.checkpointId, publication.snapshot.snapshotSha256, canonical, publication.observedAt).run();
  } catch (error) {
    const raced = await readDisposition(database, publication, fingerprint);
    if (raced) return raced;
    if (error instanceof Error && error.message.includes("SQLITE_CONSTRAINT")) return failure("conflict");
    throw error;
  }
  const stored = await cancellationRow(database, publication.operationId);
  if (!stored || !cancellationMatches(stored, publication, fingerprint)) return failure("commit_unverified");
  return { disposition: "cancelled", cancellation: asCancellation(stored, false) };
}

/** Used by the publication consumer after a failed atomic batch to distinguish
 * an exact tombstone winner from an unrelated constraint failure. */
export async function getExactOperationsPortalWorkspacePublicationCancellation(
  db: D1DatabaseSession, publication: OperationsPortalWorkspacePublication, fingerprint: string,
): Promise<OperationsPortalWorkspacePublicationCancellation | null> {
  const row = await cancellationRow(db, publication.operationId);
  if (!row) return null;
  if (!cancellationMatches(row, publication, fingerprint)) return failure("replay_mismatch");
  return asCancellation(row, true);
}
