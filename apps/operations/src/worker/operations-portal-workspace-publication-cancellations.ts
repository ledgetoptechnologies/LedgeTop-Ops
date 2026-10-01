import {
  sha256OperationsPortalWorkspacePublication,
  parseOperationsPortalWorkspacePublicationRpcResponse,
  verifyOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublication,
} from "@ltds/shared/operations-portal-workspace-publication";
import { claimOperationsPortalWorkspacePublicationInvocation } from
  "./operations-portal-workspace-publication-invocations";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RPC_TIMEOUT_MS = 15_000;
type Plain = Record<string, unknown>;
type PublicationDatabase = Pick<D1DatabaseSession, "prepare" | "batch">;

export interface OperationsPortalWorkspacePublicationCancellationBinding {
  cancelWorkspacePublication(input: OperationsPortalWorkspacePublication): Promise<unknown>;
  getPublicationDisposition(input: OperationsPortalWorkspacePublication): Promise<unknown>;
}
export type CancelOperationsPortalWorkspacePublicationInput = Readonly<{
  db: D1Database;
  binding: OperationsPortalWorkspacePublicationCancellationBinding;
  operationId: string;
  invocationId: string;
}>;
export type OperationsPortalWorkspacePublicationCancellation = Readonly<{
  operationId: string; publicationId: string; requestFingerprint: string; targetId: string;
  targetRevision: string; clientAuthorityId: string; workspaceId: string;
  rootKind: "organization" | "standalone_client"; rootRecordId: string;
  expectedRevision: string; resultingRevision: string; sourceSequence: string;
  snapshotId: string; checkpointId: string; snapshotSha256: string; cancelledAt: string; replayed: boolean;
}>;
export type OperationsPortalWorkspacePublicationCancellationResult =
  | Readonly<{ operationId: string; status: "acknowledged"; replayed: boolean }>
  | Readonly<{ operationId: string; status: "cancelled";
      cancellation: OperationsPortalWorkspacePublicationCancellation; replayed: boolean }>
  | Readonly<{ operationId: string; status: "retry" }>;

type StoredCommand = {
  operation_id: string; publication_id: string; operation_fingerprint: string; canonical_publication_json: string;
  target_id: string; target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string;
  expected_revision: number; resulting_revision: number; source_sequence: number;
  snapshot_id: string; checkpoint_id: string; snapshot_sha256: string;
  state: "pending" | "retry" | "dispatching" | "acknowledged" | "dead" | "superseded";
  remote_attempted: number; claim_token: string | null; claim_until: string | null;
};
type ClientReceipt = { operationId: string; publicationId: string; requestFingerprint: string; targetId: string;
  resultingRevision: string; sourceSequence: string; snapshotId: string; snapshotSha256: string; replayed: boolean };
type StoredCancellation = { operation_id: string; publication_id: string; operation_fingerprint: string;
  target_id: string; target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string; expected_revision: number;
  resulting_revision: number; source_sequence: number; snapshot_id: string; checkpoint_id: string;
  snapshot_sha256: string; client_cancelled_at: string; client_replayed: number; cancelled_claim_token: string };

const fail = (code: string): never => { throw new Error(`operations_portal_workspace_publication_cancellation_${code}`); };

/** Reads response objects without invoking getters or coercion hooks. */
function exact(value: unknown, keys: readonly string[]): Plain | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key)
      || !("value" in descriptors[key]!) || descriptors[key]!.enumerable !== true)) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
function canonicalTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function exactReceipt(input: unknown, publication: OperationsPortalWorkspacePublication,
  fingerprint: string): ClientReceipt | null {
  const row = exact(input, ["operationId", "publicationId", "requestFingerprint", "targetId", "resultingRevision",
    "sourceSequence", "snapshotId", "snapshotSha256", "replayed"]);
  if (!row || row.operationId !== publication.operationId || row.publicationId !== publication.publicationId
    || row.requestFingerprint !== fingerprint || row.targetId !== publication.target.targetId
    || row.resultingRevision !== publication.resultingRevision
    || row.sourceSequence !== publication.snapshot.sourceSequence || row.snapshotId !== publication.snapshot.snapshotId
    || row.snapshotSha256 !== publication.snapshot.snapshotSha256 || typeof row.replayed !== "boolean") return null;
  return row as ClientReceipt;
}
function exactCancellation(input: unknown, publication: OperationsPortalWorkspacePublication,
  fingerprint: string): OperationsPortalWorkspacePublicationCancellation | null {
  const row = exact(input, ["operationId", "publicationId", "requestFingerprint", "targetId", "targetRevision",
    "clientAuthorityId", "workspaceId", "rootKind", "rootRecordId", "expectedRevision", "resultingRevision",
    "sourceSequence", "snapshotId", "checkpointId", "snapshotSha256", "cancelledAt", "replayed"]);
  if (!row || row.operationId !== publication.operationId || row.publicationId !== publication.publicationId
    || row.requestFingerprint !== fingerprint || row.targetId !== publication.target.targetId
    || row.targetRevision !== publication.target.targetRevision
    || row.clientAuthorityId !== publication.target.clientAuthorityId
    || row.workspaceId !== publication.target.workspaceId || row.rootKind !== publication.target.rootKind
    || row.rootRecordId !== publication.target.rootRecordId || row.expectedRevision !== publication.expectedRevision
    || row.resultingRevision !== publication.resultingRevision
    || row.sourceSequence !== publication.snapshot.sourceSequence || row.snapshotId !== publication.snapshot.snapshotId
    || row.checkpointId !== publication.snapshot.checkpointId
    || row.snapshotSha256 !== publication.snapshot.snapshotSha256 || !canonicalTime(row.cancelledAt)
    || typeof row.replayed !== "boolean") return null;
  return row as OperationsPortalWorkspacePublicationCancellation;
}
type Disposition = { kind: "committed"; receipt: ClientReceipt }
  | { kind: "cancelled"; cancellation: OperationsPortalWorkspacePublicationCancellation }
  | { kind: "not-found" };
function exactDisposition(input: unknown, publication: OperationsPortalWorkspacePublication,
  fingerprint: string): Disposition | null {
  const missing = exact(input, ["ok", "disposition"]);
  if (missing?.ok === true && missing.disposition === "not-found") return { kind: "not-found" };
  const committed = exact(input, ["ok", "disposition", "receipt"]);
  if (committed?.ok === true && committed.disposition === "committed") {
    const receipt = exactReceipt(committed.receipt, publication, fingerprint);
    return receipt ? { kind: "committed", receipt } : null;
  }
  const cancelled = exact(input, ["ok", "disposition", "cancellation"]);
  if (cancelled?.ok === true && cancelled.disposition === "cancelled") {
    const cancellation = exactCancellation(cancelled.cancellation, publication, fingerprint);
    return cancellation ? { kind: "cancelled", cancellation } : null;
  }
  return null;
}

class RpcTimeout extends Error {}
async function boundedRpc<T>(call: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new RpcTimeout("rpc-timeout")), RPC_TIMEOUT_MS);
    })]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}
async function stored(db: PublicationDatabase, operationId: string): Promise<StoredCommand | null> {
  return db.prepare(`SELECT command.operation_id,command.publication_id,command.operation_fingerprint,
      command.canonical_publication_json,command.target_id,command.target_revision,command.client_authority_id,
      command.workspace_id,command.root_kind,command.root_record_id,command.expected_revision,command.resulting_revision,
      command.source_sequence,command.snapshot_id,command.checkpoint_id,command.snapshot_sha256,outbox.state,
      outbox.remote_attempted,outbox.claim_token,outbox.claim_until
    FROM operations_portal_workspace_publication_commands command
    JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=command.operation_id
    WHERE command.operation_id=?`).bind(operationId).first<StoredCommand>();
}
async function storedCancellation(db: PublicationDatabase, operationId: string): Promise<StoredCancellation | null> {
  return db.prepare(`SELECT receipt.operation_id,receipt.publication_id,receipt.operation_fingerprint,receipt.target_id,
      receipt.target_revision,receipt.client_authority_id,receipt.workspace_id,receipt.root_kind,receipt.root_record_id,
      receipt.expected_revision,receipt.resulting_revision,receipt.source_sequence,receipt.snapshot_id,
      receipt.checkpoint_id,receipt.snapshot_sha256,receipt.client_cancelled_at,receipt.client_replayed,
      receipt.cancelled_claim_token
    FROM operations_portal_workspace_publication_cancellation_receipts receipt
    JOIN operations_portal_workspace_publication_cancellation_audit audit ON audit.operation_id=receipt.operation_id
      AND audit.action='workspace.snapshot.cancelled'
      AND audit.operation_fingerprint=receipt.operation_fingerprint
      AND audit.cancelled_claim_token=receipt.cancelled_claim_token
      AND audit.client_cancelled_at=receipt.client_cancelled_at
    WHERE receipt.operation_id=?`)
    .bind(operationId).first<StoredCancellation>();
}
function cancellationMatches(row: StoredCancellation, command: StoredCommand) {
  return row.operation_id === command.operation_id && row.publication_id === command.publication_id
    && row.operation_fingerprint === command.operation_fingerprint && row.target_id === command.target_id
    && row.target_revision === command.target_revision && row.client_authority_id === command.client_authority_id
    && row.workspace_id === command.workspace_id && row.root_kind === command.root_kind
    && row.root_record_id === command.root_record_id && row.expected_revision === command.expected_revision
    && row.resulting_revision === command.resulting_revision && row.source_sequence === command.source_sequence
    && row.snapshot_id === command.snapshot_id && row.checkpoint_id === command.checkpoint_id
    && row.snapshot_sha256 === command.snapshot_sha256 && canonicalTime(row.client_cancelled_at)
    && (row.client_replayed === 0 || row.client_replayed === 1) && typeof row.cancelled_claim_token === "string"
    && row.cancelled_claim_token.length > 0;
}
function cancellationFromRow(row: StoredCancellation): OperationsPortalWorkspacePublicationCancellation {
  return { operationId: row.operation_id, publicationId: row.publication_id,
    requestFingerprint: row.operation_fingerprint, targetId: row.target_id,
    targetRevision: String(row.target_revision), clientAuthorityId: row.client_authority_id,
    workspaceId: row.workspace_id, rootKind: row.root_kind, rootRecordId: row.root_record_id,
    expectedRevision: String(row.expected_revision), resultingRevision: String(row.resulting_revision),
    sourceSequence: String(row.source_sequence), snapshotId: row.snapshot_id, checkpointId: row.checkpoint_id,
    snapshotSha256: row.snapshot_sha256, cancelledAt: row.client_cancelled_at, replayed: true };
}
async function exactCommitted(db: PublicationDatabase, command: StoredCommand): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 exact FROM operations_portal_workspace_publication_receipts receipt
    JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=receipt.operation_id
    WHERE receipt.operation_id=? AND receipt.publication_id=? AND receipt.operation_fingerprint=?
      AND receipt.target_id=? AND receipt.resulting_revision=? AND receipt.source_sequence=?
      AND receipt.snapshot_id=? AND receipt.snapshot_sha256=? AND outbox.target_id=?
      AND outbox.checkpoint_id=? AND outbox.state='acknowledged'`)
    .bind(command.operation_id, command.publication_id, command.operation_fingerprint, command.target_id,
      command.resulting_revision, command.source_sequence, command.snapshot_id, command.snapshot_sha256,
      command.target_id, command.checkpoint_id).first("exact");
  return row === 1;
}
async function terminal(db: PublicationDatabase, command: StoredCommand): Promise<OperationsPortalWorkspacePublicationCancellationResult | null> {
  if (await exactCommitted(db, command)) {
    return { operationId: command.operation_id, status: "acknowledged", replayed: true };
  }
  const cancellation = await storedCancellation(db, command.operation_id);
  if (!cancellation) return null;
  if (!cancellationMatches(cancellation, command) || command.state !== "dead") return fail("terminal_inconsistent");
  return { operationId: command.operation_id, status: "cancelled", cancellation: cancellationFromRow(cancellation),
    replayed: true };
}
async function retry(db: PublicationDatabase, command: StoredCommand, claim: string, code: string) {
  const changed = await db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='retry',
      last_error_code=?,claim_token=NULL,claim_until=NULL,
      next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE operation_id=? AND state='dispatching' AND remote_attempted=1 AND claim_token=?`)
    .bind(code, command.operation_id, claim).run();
  if (changed.meta.changes === 1) return { operationId: command.operation_id, status: "retry" } as const;
  const current = await stored(db, command.operation_id);
  if (!current) return fail("not_found");
  const done = await terminal(db, current); if (done) return done;
  if (current.state === "retry" && current.remote_attempted === 1) {
    return { operationId: command.operation_id, status: "retry" } as const;
  }
  return fail("claim_conflict");
}
async function persistCommitted(db: PublicationDatabase, command: StoredCommand, claim: string,
  receipt: ClientReceipt): Promise<OperationsPortalWorkspacePublicationCancellationResult> {
  const head = command.expected_revision === 0
    ? db.prepare(`INSERT INTO operations_portal_workspace_publication_heads
        (target_id,publication_revision,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
          source_sequence,snapshot_id,checkpoint_id,snapshot_sha256,latest_operation_id)
        SELECT target_id,resulting_revision,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
          source_sequence,snapshot_id,checkpoint_id,snapshot_sha256,operation_id
        FROM operations_portal_workspace_publication_commands WHERE operation_id=?`).bind(command.operation_id)
    : db.prepare(`UPDATE operations_portal_workspace_publication_heads SET publication_revision=?,source_sequence=?,
        snapshot_id=?,checkpoint_id=?,snapshot_sha256=?,latest_operation_id=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE target_id=? AND publication_revision=?`)
      .bind(command.resulting_revision, command.source_sequence, command.snapshot_id, command.checkpoint_id,
        command.snapshot_sha256, command.operation_id, command.target_id, command.expected_revision);
  try {
    await db.batch([
      db.prepare(`INSERT INTO operations_portal_workspace_publication_receipts
        (operation_id,publication_id,operation_fingerprint,target_id,resulting_revision,source_sequence,snapshot_id,
          snapshot_sha256,acknowledged_claim_token) VALUES(?,?,?,?,?,?,?,?,?)`).bind(command.operation_id,
          command.publication_id, command.operation_fingerprint, command.target_id, command.resulting_revision,
          command.source_sequence, command.snapshot_id, command.snapshot_sha256, claim),
      head,
      db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='acknowledged',
        acknowledged_claim_token=?,claim_token=NULL,claim_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state='dispatching' AND remote_attempted=1 AND claim_token=?`)
        .bind(claim, command.operation_id, claim),
    ]);
  } catch {
    const current = await stored(db, command.operation_id);
    if (current) {
      const done = await terminal(db, current); if (done) return done;
    }
    return retry(db, command, claim, "cancellation-commit-conflict");
  }
  const current = await stored(db, command.operation_id);
  if (!current || !await exactCommitted(db, current)) return fail("commit_unverified");
  return { operationId: command.operation_id, status: "acknowledged", replayed: receipt.replayed };
}
async function persistCancelled(db: PublicationDatabase, command: StoredCommand, claim: string,
  cancellation: OperationsPortalWorkspacePublicationCancellation,
): Promise<OperationsPortalWorkspacePublicationCancellationResult> {
  try {
    await db.batch([
      db.prepare(`INSERT INTO operations_portal_workspace_publication_cancellation_receipts
        (operation_id,publication_id,operation_fingerprint,target_id,target_revision,client_authority_id,workspace_id,
          root_kind,root_record_id,expected_revision,resulting_revision,source_sequence,snapshot_id,checkpoint_id,
          snapshot_sha256,client_cancelled_at,client_replayed,cancelled_claim_token)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(command.operation_id, command.publication_id,
          command.operation_fingerprint, command.target_id, command.target_revision, command.client_authority_id,
          command.workspace_id, command.root_kind, command.root_record_id, command.expected_revision,
          command.resulting_revision, command.source_sequence, command.snapshot_id, command.checkpoint_id,
          command.snapshot_sha256, cancellation.cancelledAt, cancellation.replayed ? 1 : 0, claim),
      db.prepare(`INSERT INTO operations_portal_workspace_publication_cancellation_audit
        (operation_id,action,operation_fingerprint,cancelled_claim_token,client_cancelled_at)
        VALUES(?,'workspace.snapshot.cancelled',?,?,?)`).bind(command.operation_id, command.operation_fingerprint,
          claim, cancellation.cancelledAt),
      db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='dead',
        last_error_code='client-cancelled',claim_token=NULL,claim_until=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state='dispatching' AND remote_attempted=1 AND claim_token=?`)
        .bind(command.operation_id, claim),
    ]);
  } catch {
    const current = await stored(db, command.operation_id);
    if (current) {
      const done = await terminal(db, current); if (done) return done;
    }
    return retry(db, command, claim, "cancellation-receipt-conflict");
  }
  const current = await stored(db, command.operation_id);
  if (!current) return fail("commit_unverified");
  const done = await terminal(db, current);
  if (!done || done.status !== "cancelled") return fail("commit_unverified");
  return { ...done, replayed: cancellation.replayed };
}

/**
 * Resolves one previously attempted, ambiguous publication. Only an exact
 * durable Client terminal disposition can acknowledge or release its target
 * single-flight fence.
 */
export async function cancelOperationsPortalWorkspacePublication(
  input: CancelOperationsPortalWorkspacePublicationInput,
): Promise<OperationsPortalWorkspacePublicationCancellationResult> {
  const normalized = exact(input, ["db", "binding", "operationId", "invocationId"]);
  if (!normalized || typeof normalized.operationId !== "string" || !UUID.test(normalized.operationId)
    || typeof normalized.invocationId !== "string" || !UUID.test(normalized.invocationId)
    || !normalized.db || typeof normalized.db !== "object" || !normalized.binding
    || typeof normalized.binding !== "object") return fail("invalid_request");
  const database = normalized.db as D1Database;
  const binding = normalized.binding as OperationsPortalWorkspacePublicationCancellationBinding;
  const db = database.withSession("first-primary");
  const prior = await stored(db, normalized.operationId); if (!prior) return fail("not_found");
  const existing = await terminal(db, prior); if (existing) return existing;
  if (prior.remote_attempted !== 1 || (prior.state !== "retry" && prior.state !== "dispatching")) {
    return fail("not_cancelable");
  }
  const claim = crypto.randomUUID(), until = new Date(Date.now() + 60_000).toISOString();
  try {
    await claimOperationsPortalWorkspacePublicationInvocation({ db,
      invocationId: normalized.invocationId as string, operationId: prior.operation_id, action: "cancel",
      claimToken: claim, claimUntil: until, lastErrorCode: "cancellation-reconciling" });
  } catch { return fail("invocation_denied"); }

  let parsed: unknown;
  try { parsed = JSON.parse(prior.canonical_publication_json); }
  catch { return retry(db, prior, claim, "cancellation-invalid-command"); }
  const publication = await verifyOperationsPortalWorkspacePublication(parsed);
  if (!publication || await sha256OperationsPortalWorkspacePublication(publication) !== prior.operation_fingerprint) {
    return retry(db, prior, claim, "cancellation-invalid-command");
  }

  let response: unknown;
  try {
    response = parseOperationsPortalWorkspacePublicationRpcResponse(
      await boundedRpc(() => binding.getPublicationDisposition(publication)));
  } catch { return retry(db, prior, claim, "cancellation-rpc-ambiguous"); }
  let disposition = exactDisposition(response, publication, prior.operation_fingerprint);
  if (!disposition) return retry(db, prior, claim, "cancellation-response-invalid");
  if (disposition.kind === "committed") return persistCommitted(db, prior, claim, disposition.receipt);
  if (disposition.kind === "cancelled") return persistCancelled(db, prior, claim, disposition.cancellation);

  // An exact not-found response is only permission to request the idempotent
  // tombstone. It never clears the local fence by itself.
  try {
    response = parseOperationsPortalWorkspacePublicationRpcResponse(
      await boundedRpc(() => binding.cancelWorkspacePublication(publication)));
  } catch { return retry(db, prior, claim, "cancellation-rpc-ambiguous"); }
  disposition = exactDisposition(response, publication, prior.operation_fingerprint);
  if (!disposition || disposition.kind === "not-found") {
    return retry(db, prior, claim, "cancellation-response-invalid");
  }
  if (disposition.kind === "committed") return persistCommitted(db, prior, claim, disposition.receipt);
  return persistCancelled(db, prior, claim, disposition.cancellation);
}
