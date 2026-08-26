import { z } from "zod";
import { canTransitionClientFeedback, type ClientFeedbackStatus } from "@ltds/shared";

export interface FeedbackStoreContext {
  accountId: string; workspaceId: string | null; identityId: string;
  workspaceIdentityId: string | null; issuer: string; subject: string;
}
export interface FeedbackSourceOwner {
  account: { projectAlphaClientId: string | null; projectAlphaOrganizationId: string | null };
  project: { projectAlphaProjectId: string | null; sourceUpdatedAt: string | null } | null;
  workspace: { rootType: "organization" | "standalone_client"; rootPublicId: string; generationId: string; sourceSequence: number } | null;
  association: { prefix: string } | null;
  file: { etag: string; size: number; uploadedAt: string } | null;
}
/** Server-only. Never return this snapshot or a guard to the browser. */
export interface FeedbackStoredTarget {
  kind: "project" | "folder" | "file";
  projectId: string | null; associationId: string | null; relativePath: string | null; storageKey: string | null;
  label: string; projectName: string | null; sourceOwner: FeedbackSourceOwner;
}
/** Trusted SQL assembled by an authorization adapter, never request input. */
export interface FeedbackWriteGuard { sql: string; bindings: (string | number | null)[] }
export interface FeedbackWriteAuthorization {
  context: FeedbackStoreContext; target: FeedbackStoredTarget; guard: FeedbackWriteGuard;
}
export interface FeedbackRecord {
  id: string; context: FeedbackStoreContext; target: FeedbackStoredTarget;
  targetFingerprint: string; requestFingerprint: string;
  message: string; status: ClientFeedbackStatus; revision: number;
  completionNote: string | null; completedAt: string | null;
  createdAt: string; updatedAt: string;
}
type Database = Pick<D1Database, "prepare" | "batch">;
const nullableString = z.string().nullable();
const targetSchema = z.object({
  kind: z.enum(["project", "folder", "file"]), projectId: nullableString, associationId: nullableString,
  relativePath: nullableString, storageKey: nullableString, label: z.string().min(1).max(160),
  projectName: z.string().max(160).nullable(),
  sourceOwner: z.object({
    account: z.object({ projectAlphaClientId: nullableString, projectAlphaOrganizationId: nullableString }).strict(),
    project: z.object({ projectAlphaProjectId: nullableString, sourceUpdatedAt: nullableString }).strict().nullable(),
    workspace: z.object({ rootType: z.enum(["organization", "standalone_client"]), rootPublicId: z.string(), generationId: z.string(), sourceSequence: z.number().int().nonnegative() }).strict().nullable(),
    association: z.object({ prefix: z.string() }).strict().nullable(),
    file: z.object({ etag: z.string(), size: z.number().int().nonnegative(), uploadedAt: z.string() }).strict().nullable(),
  }).strict(),
}).strict().refine(target => target.kind === "project"
  ? target.projectId !== null && target.associationId === null && target.relativePath === null && target.storageKey === null
  : target.kind === "folder"
    ? target.projectId !== null && target.associationId !== null && target.relativePath !== null && target.storageKey === null
    : target.associationId !== null && target.storageKey !== null);
const contextSchema = z.object({
  accountId: z.string().min(1).max(128), workspaceId: z.string().min(1).max(128).nullable(),
  identityId: z.string().min(1).max(128), workspaceIdentityId: z.string().min(1).max(128).nullable(),
  issuer: z.string().min(1).max(512), subject: z.string().min(1).max(512),
}).strict().refine(context => (context.workspaceId === null) === (context.workspaceIdentityId === null));
interface Row {
  id: string; account_id: string; workspace_id: string | null; creator_identity_id: string;
  creator_workspace_identity_id: string | null; principal_issuer: string; principal_subject: string;
  target_json: string; target_fingerprint: string; request_fingerprint: string;
  message: string; status: ClientFeedbackStatus; revision: number; completion_note: string | null;
  completed_at: string | null; created_at: string; updated_at: string;
}
interface MutationReceipt { feedback_id: string; fingerprint: string; result_revision: number; result_status: "in_progress" | "done" }

export class FeedbackStoreError extends Error {
  constructor(readonly code: "invalid" | "changed" | "idempotency_conflict") { super(`feedback_${code}`); }
}
export function feedbackScopeKey(context: Pick<FeedbackStoreContext, "accountId" | "workspaceId">): string {
  return context.workspaceId ? `workspace:${context.workspaceId}` : `account:${context.accountId}`;
}
export async function feedbackFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function record(row: Row): FeedbackRecord {
  return { id: row.id, context: contextSchema.parse({ accountId: row.account_id, workspaceId: row.workspace_id,
    identityId: row.creator_identity_id, workspaceIdentityId: row.creator_workspace_identity_id,
    issuer: row.principal_issuer, subject: row.principal_subject }), target: targetSchema.parse(JSON.parse(row.target_json)),
    targetFingerprint: row.target_fingerprint, requestFingerprint: row.request_fingerprint,
    message: row.message, status: row.status, revision: row.revision, completionNote: row.completion_note,
    completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
export async function readFeedbackRecord(db: Pick<D1Database, "prepare">, id: string): Promise<FeedbackRecord | null> {
  const row = await db.prepare("SELECT * FROM client_feedback WHERE id=?").bind(id).first<Row>();
  return row ? record(row) : null;
}
function keyValid(key: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key); }
function validateGuard(guard: FeedbackWriteGuard) {
  if (!guard.sql.trim() || guard.sql.length > 150_000 || guard.bindings.length > 75) throw new FeedbackStoreError("invalid");
}
async function requireCurrentGuard(db: Pick<D1Database, "prepare">, guard: FeedbackWriteGuard) {
  validateGuard(guard);
  if (!(await db.prepare(`SELECT 1 ok WHERE ${guard.sql}`).bind(...guard.bindings).first("ok"))) throw new FeedbackStoreError("changed");
}
async function existingSubmission(db: Pick<D1Database, "prepare">, context: FeedbackStoreContext, key: string) {
  const row = await db.prepare(`SELECT * FROM client_feedback
    WHERE scope_key=? AND principal_issuer=? AND principal_subject=? AND mutation_key=?`)
    .bind(feedbackScopeKey(context), context.issuer, context.subject, key).first<Row>();
  return row ? record(row) : null;
}

export async function createFeedbackRecord(db: Database, authorization: FeedbackWriteAuthorization, message: string, mutationKey: string) {
  const context = contextSchema.parse(authorization.context), target = targetSchema.parse(authorization.target);
  if (!keyValid(mutationKey) || message !== message.trim() || message.length < 1 || message.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) throw new FeedbackStoreError("invalid");
  validateGuard(authorization.guard);
  // Presentation changes do not alter an already-submitted request identity.
  // Source-version snapshots are still atomically checked by the target guard.
  const targetFingerprint = await feedbackFingerprint([feedbackScopeKey(context), context.accountId,
    target.kind, target.projectId, target.associationId, target.relativePath, target.storageKey]);
  const fingerprint = await feedbackFingerprint([targetFingerprint, message]);
  const prior = await existingSubmission(db, context, mutationKey);
  await requireCurrentGuard(db, authorization.guard);
  if (prior) {
    if (prior.requestFingerprint !== fingerprint) throw new FeedbackStoreError("idempotency_conflict");
    return { record: prior, replayed: true };
  }
  const id = crypto.randomUUID();
  try {
    const result = await db.batch([
      db.prepare(`INSERT INTO client_feedback
        (id,account_id,scope_key,workspace_id,creator_identity_id,creator_workspace_identity_id,
         principal_issuer,principal_subject,target_kind,project_id,target_json,target_fingerprint,message,mutation_key,request_fingerprint)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${authorization.guard.sql}`)
        .bind(id,context.accountId,feedbackScopeKey(context),context.workspaceId,context.identityId,context.workspaceIdentityId,
          context.issuer,context.subject,target.kind,target.projectId,JSON.stringify(target),targetFingerprint,message,mutationKey,fingerprint,
          ...authorization.guard.bindings),
      db.prepare(`INSERT INTO client_feedback_events(id,feedback_id,revision,actor_type,actor_id,status)
        SELECT ?,?,1,'client',?,'new' WHERE changes()=1`).bind(crypto.randomUUID(),id,context.workspaceIdentityId ?? context.identityId),
      db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
        SELECT 'client',?,'client.feedback.created','client_feedback',?,? WHERE changes()=1`)
        .bind(context.workspaceIdentityId ?? context.identityId,id,JSON.stringify({ accountId: context.accountId, workspaceId: context.workspaceId, targetKind: target.kind, revision: 1 })),
    ]);
    if (Number(result[0]?.meta.changes) !== 1) throw new FeedbackStoreError("changed");
  } catch (error) {
    const raced = await existingSubmission(db, context, mutationKey);
    if (!raced) throw error;
    await requireCurrentGuard(db, authorization.guard);
    if (raced.requestFingerprint !== fingerprint) throw new FeedbackStoreError("idempotency_conflict");
    return { record: raced, replayed: true };
  }
  const saved = await readFeedbackRecord(db,id);
  if (!saved) throw new FeedbackStoreError("changed");
  return { record: saved, replayed: false };
}

export async function transitionFeedbackRecord(db: Database, feedback: FeedbackRecord, actorId: string,
  input: { expectedRevision: number; status: "in_progress" | "done"; note: string | null }, mutationKey: string, guard: FeedbackWriteGuard) {
  if (!keyValid(mutationKey) || !actorId || actorId.length > 128 || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1 || input.expectedRevision > 2 || !["in_progress","done"].includes(input.status)
    || (input.note !== null && (input.status !== "done" || input.note !== input.note.trim() || input.note.length < 1 || input.note.length > 2000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.note)))) throw new FeedbackStoreError("invalid");
  validateGuard(guard);
  const fingerprint = await feedbackFingerprint([actorId,feedback.id,input.expectedRevision,input.status,input.note]);
  const receipt = () => db.prepare(`SELECT feedback_id,fingerprint,result_revision,result_status
    FROM client_feedback_mutations WHERE actor_staff_id=? AND mutation_key=?`).bind(actorId,mutationKey).first<MutationReceipt>();
  const replay = async (saved: MutationReceipt) => {
    await requireCurrentGuard(db,guard);
    if (saved.fingerprint !== fingerprint || saved.feedback_id !== feedback.id) throw new FeedbackStoreError("idempotency_conflict");
    const current = await readFeedbackRecord(db,feedback.id);
    if (!current) throw new FeedbackStoreError("changed");
    return { record: current, appliedRevision: saved.result_revision, replayed: true };
  };
  const prior = await receipt();
  if (prior) return replay(prior);
  if (feedback.revision !== input.expectedRevision || !canTransitionClientFeedback(feedback.status,input.status)) throw new FeedbackStoreError("changed");
  await requireCurrentGuard(db,guard);
  const next = input.expectedRevision + 1, notificationId = crypto.randomUUID();
  const transitionReceipt = `EXISTS(SELECT 1 FROM client_feedback_mutations WHERE actor_staff_id=? AND mutation_key=? AND fingerprint=?)`;
  try {
    const statements = [
      db.prepare(`UPDATE client_feedback SET status=?,revision=revision+1,completion_note=?,
        completed_at=CASE WHEN ?='done' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
        completed_by_staff_id=CASE WHEN ?='done' THEN ? ELSE NULL END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND revision=? AND status=? AND target_fingerprint=? AND (${guard.sql})`)
        .bind(input.status,input.note,input.status,input.status,actorId,feedback.id,input.expectedRevision,feedback.status,feedback.targetFingerprint,...guard.bindings),
      db.prepare(`INSERT INTO client_feedback_mutations(actor_staff_id,mutation_key,fingerprint,feedback_id,result_revision,result_status)
        SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(actorId,mutationKey,fingerprint,feedback.id,next,input.status),
      db.prepare(`INSERT INTO client_feedback_events(id,feedback_id,revision,actor_type,actor_id,status,note)
        SELECT ?,?,?,'staff',?,?,? WHERE changes()=1`).bind(crypto.randomUUID(),feedback.id,next,actorId,input.status,input.note),
      db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
        SELECT 'staff',?,'client.feedback.status_changed','client_feedback',?,? WHERE changes()=1`)
        .bind(actorId,feedback.id,JSON.stringify({ accountId: feedback.context.accountId, workspaceId: feedback.context.workspaceId, revision: next, status: input.status })),
    ];
    if (input.status === "done") statements.push(
      db.prepare(`INSERT INTO client_feedback_notifications(id,feedback_id,feedback_revision,account_id,recipient_identity_id,workspace_id,workspace_identity_id)
        SELECT ?,id,revision,account_id,creator_identity_id,workspace_id,creator_workspace_identity_id FROM client_feedback
        WHERE id=? AND revision=? AND status='done' AND ${transitionReceipt}`)
        .bind(notificationId,feedback.id,next,actorId,mutationKey,fingerprint),
      db.prepare(`INSERT INTO client_feedback_notification_outbox(id,notification_id)
        SELECT ?,? WHERE changes()=1`).bind(crypto.randomUUID(),notificationId),
    );
    const result = await db.batch(statements);
    if (Number(result[0]?.meta.changes) !== 1) throw new FeedbackStoreError("changed");
  } catch (error) {
    const raced = await receipt();
    if (raced) return replay(raced);
    throw error;
  }
  const saved = await readFeedbackRecord(db,feedback.id);
  if (!saved) throw new FeedbackStoreError("changed");
  return { record: saved, appliedRevision: next, replayed: false };
}
