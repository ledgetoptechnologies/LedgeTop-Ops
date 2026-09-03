import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { isAdministrator } from "./acl";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { emptyMemory, parseMemory, prepareProject, rootRecordKind } from "./project-operational-memory";
import type { Env, StaffPrincipal } from "./types";

type Environment = Pick<Env, "OPS_DB">;
type Database = Pick<D1Database, "prepare" | "batch">;
type RootKind = "organization" | "client";
type Action = "reset" | "transfer";
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const operationKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const reason = z.string().min(3).max(1000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const previewProjectOperationalRecoverySchema = z.object({
  expectedContextVersion: proof,
  action: z.enum(["reset", "transfer"]),
  reason,
}).strict();
export const commitProjectOperationalRecoverySchema = previewProjectOperationalRecoverySchema.extend({
  previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: operationKey,
  confirmation: z.enum(["RESET PROJECT MEMORY", "TRANSFER PROJECT MEMORY"]),
}).strict().superRefine((value, issue) => {
  const expected = value.action === "reset" ? "RESET PROJECT MEMORY" : "TRANSFER PROJECT MEMORY";
  if (value.confirmation !== expected) issue.addIssue({ code: "custom", message: `Type ${expected} to confirm` });
});
type PreviewInput = z.infer<typeof previewProjectOperationalRecoverySchema>;
type CommitInput = z.infer<typeof commitProjectOperationalRecoverySchema>;

interface OverlayRow { version: number; root_record_kind: RootKind; root_id: string; snapshot_json?: string }
interface RootPointer { root_record_kind: RootKind; root_id: string }
interface LatestReceipt { recovery_sequence: number; contacts_visible_from_version: number; memory_visible_from_version: number;
  new_root_kind: RootKind; new_root_id: string }
interface ReceiptRow { request_fingerprint: string; preview_fingerprint: string; projection_source_id: string;
  project_id: string; new_root_kind: RootKind; new_root_id: string; result_json: string }
interface RecoveryPlan {
  input: PreviewInput;
  sourceId: string;
  projectId: string;
  projectRevision: string;
  newRoot: { kind: RootKind; id: string; revision: string };
  oldRoot: { kind: RootKind; id: string };
  contacts: OverlayRow | null;
  memory: OverlayRow | null;
  contactCount: number;
  memoryRevisionCount: number;
  excludedAttachmentCount: number;
  excludedAttachmentEventCount: number;
  excludedAttachmentMutationCount: number;
  latest: LatestReceipt | null;
  fingerprint: string;
}
export interface ProjectOperationalRecoveryPreview {
  fingerprint: string;
  action: Action;
  sourceId: string;
  project: { id: string; revision: string };
  currentRoot: { kind: RootKind; id: string };
  previousRoot: { kind: RootKind; id: string };
  changes: { contactsCleared: number; memoryTransferred: boolean; memoryReset: boolean; attachmentsExcluded: number };
}
export interface ProjectOperationalRecoveryResult extends ProjectOperationalRecoveryPreview {
  replayed: boolean;
  recoverySequence: number;
  contactsVersionAfter: number;
  memoryVersionAfter: number;
}
const savedResultSchema = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/), action: z.enum(["reset", "transfer"]),
  sourceId: z.string().min(1).max(512),
  project: z.object({ id: z.string().min(1).max(512), revision: z.string().min(1).max(512) }).strict(),
  currentRoot: z.object({ kind: z.enum(["organization", "client"]), id: z.string().min(1).max(512) }).strict(),
  previousRoot: z.object({ kind: z.enum(["organization", "client"]), id: z.string().min(1).max(512) }).strict(),
  changes: z.object({ contactsCleared: safeCount, memoryTransferred: z.boolean(), memoryReset: z.boolean(),
    attachmentsExcluded: safeCount }).strict(), replayed: z.boolean(), recoverySequence: safeCount.refine(value => value > 0),
  contactsVersionAfter: safeCount, memoryVersionAfter: safeCount }).strict();

const db = (env: Environment): Database => env.OPS_DB.withSession("first-primary");
const changed = (): never => { throw new HTTPException(409, { message: "Project ownership or recovery state changed. Prepare a new recovery preview." }); };
const normalize = (value: string) => value.normalize("NFC").trim();
function parse<T>(schema: z.ZodType<T>, raw: unknown, message: string): T {
  const result = schema.safeParse(raw); if (!result.success) throw new HTTPException(400, { message }); return result.data;
}
async function sha(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function sameRoot(row: Pick<OverlayRow, "root_record_kind" | "root_id">, kind: RootKind, id: string): boolean {
  return row.root_record_kind === kind && row.root_id === id;
}

async function buildPlan(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  projectId: string, raw: unknown): Promise<RecoveryPlan> {
  if (!(await isAdministrator(env as Env, principal))) throw new HTTPException(403, { message: "Administrator access required" });
  const parsed = parse(previewProjectOperationalRecoverySchema, raw, "Project recovery preview is invalid");
  const input = { ...parsed, reason: normalize(parsed.reason) };
  if (input.reason.length < 3) throw new HTTPException(400, { message: "Project recovery reason is required" });
  const prepared = await prepareProject(env, principal, context, projectId, "project.contacts.manage", input.expectedContextVersion);
  await prepareProject(env, principal, context, projectId, "project.memory.manage", input.expectedContextVersion);
  const database = db(env), sourceId = prepared.project.projection_source_id;
  const [contacts, memory, contactCount, memoryRevisionCount, excludedAttachments, excludedAttachmentCount,
    excludedAttachmentEventCount, excludedAttachmentMutationCount, latest] = await Promise.all([
    database.prepare(`SELECT version,root_record_kind,root_id FROM project_operational_contact_sets
      WHERE projection_source_id=? AND project_id=?`).bind(sourceId, projectId).first<OverlayRow>(),
    database.prepare(`SELECT version,root_record_kind,root_id,snapshot_json FROM project_operational_memory
      WHERE projection_source_id=? AND project_id=?`).bind(sourceId, projectId).first<OverlayRow>(),
    database.prepare(`SELECT count(*) count FROM project_operational_contact_assignments
      WHERE projection_source_id=? AND project_id=?`).bind(sourceId, projectId).first<number>("count"),
    database.prepare(`SELECT count(*) count FROM project_operational_memory_revisions
      WHERE projection_source_id=? AND project_id=?`).bind(sourceId, projectId).first<number>("count"),
    database.prepare(`SELECT root_record_kind,root_id,count(*) count FROM project_memory_attachments
      WHERE projection_source_id=? AND project_id=? AND (root_record_kind<>? OR root_id<>?)
      GROUP BY root_record_kind,root_id ORDER BY root_record_kind,root_id LIMIT 2`)
      .bind(sourceId, projectId, rootRecordKind(context), context.root.public_id)
      .all<{ root_record_kind: RootKind; root_id: string; count: number }>(),
    database.prepare(`SELECT count(*) count FROM project_memory_attachments
      WHERE projection_source_id=? AND project_id=? AND (root_record_kind<>? OR root_id<>?)`)
      .bind(sourceId, projectId, rootRecordKind(context), context.root.public_id).first<number>("count"),
    database.prepare(`SELECT count(*) count FROM project_memory_attachment_events event
      JOIN project_memory_attachments attachment ON attachment.id=event.attachment_id
        AND attachment.projection_source_id=event.projection_source_id AND attachment.project_id=event.project_id
      WHERE attachment.projection_source_id=? AND attachment.project_id=?
        AND (attachment.root_record_kind<>? OR attachment.root_id<>?)`)
      .bind(sourceId, projectId, rootRecordKind(context), context.root.public_id).first<number>("count"),
    database.prepare(`SELECT count(*) count FROM project_memory_attachment_mutations mutation
      JOIN project_memory_attachments attachment ON attachment.id=mutation.attachment_id
        AND attachment.projection_source_id=mutation.projection_source_id AND attachment.project_id=mutation.project_id
      WHERE attachment.projection_source_id=? AND attachment.project_id=?
        AND (attachment.root_record_kind<>? OR attachment.root_id<>?)`)
      .bind(sourceId, projectId, rootRecordKind(context), context.root.public_id).first<number>("count"),
    database.prepare(`SELECT recovery_sequence,contacts_visible_from_version,memory_visible_from_version,new_root_kind,new_root_id
      FROM project_operational_recovery_receipts WHERE projection_source_id=? AND project_id=?
      ORDER BY recovery_sequence DESC LIMIT 1`).bind(sourceId, projectId).first<LatestReceipt>(),
  ]);
  if (!Number.isSafeInteger(contactCount ?? 0) || (contactCount ?? 0) < 0 || (contactCount ?? 0) > 100
    || !Number.isSafeInteger(memoryRevisionCount ?? 0) || (memoryRevisionCount ?? 0) < 0
    || !Number.isSafeInteger(excludedAttachmentCount ?? 0) || (excludedAttachmentCount ?? 0) < 0
    || !Number.isSafeInteger(excludedAttachmentEventCount ?? 0) || (excludedAttachmentEventCount ?? 0) < 0
    || !Number.isSafeInteger(excludedAttachmentMutationCount ?? 0) || (excludedAttachmentMutationCount ?? 0) < 0
    || (latest && (!Number.isSafeInteger(latest.recovery_sequence) || latest.recovery_sequence < 1)))
    throw new HTTPException(503, { message: "Stored operational recovery state requires administrative review" });
  const liveCandidates: RootPointer[] = [...(contacts ? [contacts] : []), ...(memory ? [memory] : [])];
  const liveMismatched = liveCandidates.filter(row => !sameRoot(row, rootRecordKind(context), context.root.public_id));
  // A pre-0052 database can still contain several prior roots. They are
  // counted for the first recovery but never used to infer an owner when a
  // live overlay or the last audited receipt provides one; commit archives
  // every non-current attachment row at the database boundary.
  const fallbackRoots: RootPointer[] = latest ? [{ root_record_kind: latest.new_root_kind, root_id: latest.new_root_id }]
    : excludedAttachments.results;
  const mismatched = liveMismatched.length ? liveMismatched
    : fallbackRoots.filter(row => !sameRoot(row, rootRecordKind(context), context.root.public_id));
  const latestMatchesCurrent = latest && latest.new_root_kind === rootRecordKind(context) && latest.new_root_id === context.root.public_id;
  if (!liveMismatched.length && (latestMatchesCurrent || !excludedAttachmentCount))
    throw new HTTPException(409, { message: "Project operational recovery is not required" });
  const old = mismatched[0];
  if (!old || liveMismatched.some(row => !sameRoot(row, old.root_record_kind, old.root_id))
    || (!liveMismatched.length && !latest && mismatched.some(row => !sameRoot(row, old.root_record_kind, old.root_id))))
    throw new HTTPException(503, { message: "Stored operational roots require administrative review before recovery" });
  if ((contacts && sameRoot(contacts, rootRecordKind(context), context.root.public_id))
    || (memory && sameRoot(memory, rootRecordKind(context), context.root.public_id)))
    throw new HTTPException(503, { message: "Mixed current and reassigned operational records require administrative review" });
  const fingerprint = await sha({ schemaVersion: 1, input, sourceId, projectId,
    projectRevision: prepared.project.last_sync_id, newRoot: [rootRecordKind(context), context.root.public_id, prepared.root.last_sync_id],
    oldRoot: [old.root_record_kind, old.root_id], versions: [contacts?.version ?? 0, memory?.version ?? 0],
    contactCount: contactCount ?? 0, memoryRevisionCount: memoryRevisionCount ?? 0,
    excludedAttachmentCount: excludedAttachmentCount ?? 0,
    excludedAttachmentEventCount: excludedAttachmentEventCount ?? 0,
    excludedAttachmentMutationCount: excludedAttachmentMutationCount ?? 0,
    recoverySequence: latest?.recovery_sequence ?? 0 });
  return { input, sourceId, projectId, projectRevision: prepared.project.last_sync_id,
    newRoot: { kind: rootRecordKind(context), id: context.root.public_id, revision: prepared.root.last_sync_id },
    oldRoot: { kind: old.root_record_kind, id: old.root_id }, contacts: contacts ?? null, memory: memory ?? null,
    contactCount: contactCount ?? 0, memoryRevisionCount: memoryRevisionCount ?? 0,
    excludedAttachmentCount: excludedAttachmentCount ?? 0,
    excludedAttachmentEventCount: excludedAttachmentEventCount ?? 0,
    excludedAttachmentMutationCount: excludedAttachmentMutationCount ?? 0,
    latest: latest ?? null, fingerprint };
}
export async function canRecoverProjectOperational(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string): Promise<boolean> {
  if (!(await isAdministrator(env as Env, principal))) return false;
  try {
    await prepareProject(env, principal, context, projectId, "project.contacts.manage");
    await prepareProject(env, principal, context, projectId, "project.memory.manage");
    return true;
  } catch (error) {
    if (error instanceof HTTPException && [403, 404].includes(error.status)) return false;
    throw error;
  }
}
function preview(plan: RecoveryPlan): ProjectOperationalRecoveryPreview {
  return { fingerprint: plan.fingerprint, action: plan.input.action, sourceId: plan.sourceId,
    project: { id: plan.projectId, revision: plan.projectRevision },
    currentRoot: { kind: plan.newRoot.kind, id: plan.newRoot.id }, previousRoot: { kind: plan.oldRoot.kind, id: plan.oldRoot.id }, changes: {
      contactsCleared: plan.contactCount, memoryTransferred: plan.input.action === "transfer" && Boolean(plan.memory),
      memoryReset: plan.input.action === "reset" && Boolean(plan.memory), attachmentsExcluded: plan.excludedAttachmentCount,
    } };
}
export async function previewProjectOperationalRecovery(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, raw: unknown): Promise<ProjectOperationalRecoveryPreview> {
  return preview(await buildPlan(env, principal, context, projectId, raw));
}
function receiptResult(row: ReceiptRow): ProjectOperationalRecoveryResult {
  try {
    const parsed = savedResultSchema.safeParse(JSON.parse(row.result_json));
    if (!parsed.success || parsed.data.sourceId !== row.projection_source_id || parsed.data.project.id !== row.project_id
      || parsed.data.fingerprint !== row.preview_fingerprint || parsed.data.currentRoot.kind !== row.new_root_kind
      || parsed.data.currentRoot.id !== row.new_root_id) throw new Error();
    return parsed.data;
  }
  catch { throw new HTTPException(503, { message: "Saved project recovery receipt requires administrative review" }); }
}
export async function commitProjectOperationalRecovery(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, raw: unknown): Promise<ProjectOperationalRecoveryResult> {
  if (!(await isAdministrator(env as Env, principal))) throw new HTTPException(403, { message: "Administrator access required" });
  const parsed = parse(commitProjectOperationalRecoverySchema, raw, "Project recovery commit is invalid");
  const input = { ...parsed, reason: normalize(parsed.reason) };
  const requestFingerprint = await sha({ ...input, idempotencyKey: undefined, previewFingerprint: undefined });
  const database = db(env);
  const saved = await database.prepare(`SELECT request_fingerprint,preview_fingerprint,projection_source_id,project_id,new_root_kind,new_root_id,result_json
    FROM project_operational_recovery_receipts WHERE actor_id=? AND idempotency_key=?`)
    .bind(principal.id, input.idempotencyKey).first<ReceiptRow>();
  if (saved) {
    if (saved.request_fingerprint !== requestFingerprint || saved.preview_fingerprint !== input.previewFingerprint
      || saved.projection_source_id !== context.root.source_id || saved.project_id !== projectId
      || saved.new_root_kind !== rootRecordKind(context) || saved.new_root_id !== context.root.public_id) changed();
    const current = await prepareProject(env, principal, context, projectId, "project.contacts.manage", input.expectedContextVersion);
    await prepareProject(env, principal, context, projectId, "project.memory.manage", input.expectedContextVersion);
    const stored = receiptResult(saved);
    if (current.project.last_sync_id !== stored.project.revision) changed();
    return { ...stored, replayed: true };
  }
  const plan = await buildPlan(env, principal, context, projectId, {
    expectedContextVersion: input.expectedContextVersion, action: input.action, reason: input.reason,
  });
  if (plan.fingerprint !== input.previewFingerprint) changed();
  const contactsBefore = plan.contacts?.version ?? 0, memoryBefore = plan.memory?.version ?? 0;
  const contactsAfter = contactsBefore + (plan.contacts ? 1 : 0), memoryAfter = memoryBefore + (plan.memory ? 1 : 0);
  const sequence = (plan.latest?.recovery_sequence ?? 0) + 1;
  const contactsVisibleFrom = plan.contacts ? contactsAfter : (plan.latest?.contacts_visible_from_version ?? 1);
  const memoryVisibleFrom = plan.input.action === "reset" && plan.memory ? memoryAfter
    : (plan.latest?.memory_visible_from_version ?? 1);
  const result: ProjectOperationalRecoveryResult = { ...preview(plan), replayed: false, recoverySequence: sequence,
    contactsVersionAfter: contactsAfter, memoryVersionAfter: memoryAfter };
  const statements: D1PreparedStatement[] = [database.prepare(`INSERT INTO project_operational_recovery_fences
    (actor_id,idempotency_key,projection_source_id,project_id,project_last_sync_id,old_root_kind,old_root_id,new_root_kind,new_root_id,
     new_root_last_sync_id,contacts_version,memory_version,contact_set_writes,assignment_deletes,contact_revision_writes,
     memory_writes,memory_revision_writes,memory_revision_archives,memory_revision_deletes,attachment_archives,
     attachment_event_archives,attachment_event_deletes,attachment_mutation_archives,attachment_mutation_deletes,
     attachment_deletes,receipt_writes,write_guard)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`)
    .bind(principal.id, input.idempotencyKey, plan.sourceId, projectId, plan.projectRevision, plan.oldRoot.kind, plan.oldRoot.id,
      plan.newRoot.kind, plan.newRoot.id, plan.newRoot.revision, contactsBefore, memoryBefore, plan.contacts ? 1 : 0,
      plan.contactCount, plan.contacts ? 1 : 0, plan.memory ? 1 : 0, plan.memory ? 1 : 0,
      plan.input.action === "reset" ? plan.memoryRevisionCount : 0,
      plan.input.action === "reset" ? plan.memoryRevisionCount : 0,
      plan.excludedAttachmentCount, plan.excludedAttachmentEventCount, plan.excludedAttachmentEventCount,
      plan.excludedAttachmentMutationCount, plan.excludedAttachmentMutationCount, plan.excludedAttachmentCount, 1)];
  if (plan.contacts) {
    statements.push(database.prepare(`UPDATE project_operational_contact_sets SET root_record_kind=?,root_id=?,version=version+1,
      updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE projection_source_id=? AND project_id=? AND version=?`)
      .bind(plan.newRoot.kind, plan.newRoot.id, principal.id, plan.sourceId, projectId, contactsBefore));
    statements.push(database.prepare(`DELETE FROM project_operational_contact_assignments WHERE projection_source_id=? AND project_id=?`)
      .bind(plan.sourceId, projectId));
    statements.push(database.prepare(`INSERT INTO project_operational_contact_revisions
      (id,projection_source_id,project_id,version,snapshot_json,actor_id) VALUES(?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), plan.sourceId, projectId, contactsAfter, JSON.stringify({ schemaVersion: 1, assignments: [] }), principal.id));
  }
  if (plan.memory) {
    const snapshot = plan.input.action === "transfer" ? JSON.stringify(parseMemory(plan.memory.snapshot_json ?? null)) : JSON.stringify(emptyMemory());
    statements.push(database.prepare(`UPDATE project_operational_memory SET root_record_kind=?,root_id=?,version=version+1,snapshot_json=?,
      updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE projection_source_id=? AND project_id=? AND version=?`)
      .bind(plan.newRoot.kind, plan.newRoot.id, snapshot, principal.id, plan.sourceId, projectId, memoryBefore));
    if (plan.input.action === "reset" && plan.memoryRevisionCount) {
      statements.push(database.prepare(`INSERT INTO project_operational_memory_revision_archive
        (projection_source_id,project_id,version,change_kind,snapshot_json,amendment_reason,actor_id,created_at,recovery_actor_id,recovery_idempotency_key)
        SELECT projection_source_id,project_id,version,change_kind,snapshot_json,amendment_reason,actor_id,created_at,?,?
        FROM project_operational_memory_revisions WHERE projection_source_id=? AND project_id=? AND version<=?`)
        .bind(principal.id, input.idempotencyKey, plan.sourceId, projectId, memoryBefore));
      statements.push(database.prepare(`DELETE FROM project_operational_memory_revisions
        WHERE projection_source_id=? AND project_id=? AND version<=?`).bind(plan.sourceId, projectId, memoryBefore));
    }
    statements.push(database.prepare(`INSERT INTO project_operational_memory_revisions
      (id,projection_source_id,project_id,version,change_kind,snapshot_json,amendment_reason,actor_id)
      VALUES(?,?,?,?, 'saved',?,NULL,?)`).bind(crypto.randomUUID(), plan.sourceId, projectId, memoryAfter, snapshot, principal.id));
  }
  if (plan.excludedAttachmentCount) {
    statements.push(database.prepare(`INSERT INTO project_memory_attachment_archive
      (id,projection_source_id,project_record_kind,project_id,root_record_kind,root_id,source_kind,display_name,content_type,
       size_bytes,object_key,object_etag,sha256,version_added,created_by,created_at,recovery_actor_id,recovery_idempotency_key)
      SELECT id,projection_source_id,project_record_kind,project_id,root_record_kind,root_id,source_kind,display_name,content_type,
       size_bytes,object_key,object_etag,sha256,version_added,created_by,created_at,?,?
      FROM project_memory_attachments WHERE projection_source_id=? AND project_id=?
        AND (root_record_kind<>? OR root_id<>?) ORDER BY created_at,id`)
      .bind(principal.id, input.idempotencyKey, plan.sourceId, projectId, plan.newRoot.kind, plan.newRoot.id));
    if (plan.excludedAttachmentEventCount) {
      statements.push(database.prepare(`INSERT INTO project_memory_attachment_event_archive
        (id,projection_source_id,project_record_kind,project_id,attachment_id,actor_id,event_kind,result_version,details_json,
         created_at,recovery_actor_id,recovery_idempotency_key)
        SELECT event.id,event.projection_source_id,event.project_record_kind,event.project_id,event.attachment_id,event.actor_id,
         event.event_kind,event.result_version,event.details_json,event.created_at,?,?
        FROM project_memory_attachment_events event JOIN project_memory_attachment_archive attachment
          ON attachment.id=event.attachment_id AND attachment.projection_source_id=event.projection_source_id
          AND attachment.project_id=event.project_id
        WHERE event.projection_source_id=? AND event.project_id=? ORDER BY event.created_at,event.id`)
        .bind(principal.id, input.idempotencyKey, plan.sourceId, projectId));
    }
    if (plan.excludedAttachmentMutationCount) {
      statements.push(database.prepare(`INSERT INTO project_memory_attachment_mutation_archive
        (actor_id,idempotency_key,operation_kind,request_fingerprint,projection_source_id,project_record_kind,project_id,
         attachment_id,result_version,result_json,created_at,recovery_actor_id,recovery_idempotency_key)
        SELECT mutation.actor_id,mutation.idempotency_key,mutation.operation_kind,mutation.request_fingerprint,
         mutation.projection_source_id,mutation.project_record_kind,mutation.project_id,mutation.attachment_id,
         mutation.result_version,mutation.result_json,mutation.created_at,?,?
        FROM project_memory_attachment_mutations mutation JOIN project_memory_attachment_archive attachment
          ON attachment.id=mutation.attachment_id AND attachment.projection_source_id=mutation.projection_source_id
          AND attachment.project_id=mutation.project_id
        WHERE mutation.projection_source_id=? AND mutation.project_id=? ORDER BY mutation.created_at,mutation.actor_id,mutation.idempotency_key`)
        .bind(principal.id, input.idempotencyKey, plan.sourceId, projectId));
    }
    statements.push(database.prepare(`DELETE FROM project_memory_attachment_events WHERE projection_source_id=? AND project_id=?
      AND attachment_id IN (SELECT id FROM project_memory_attachment_archive WHERE recovery_actor_id=? AND recovery_idempotency_key=?)`)
      .bind(plan.sourceId, projectId, principal.id, input.idempotencyKey));
    statements.push(database.prepare(`DELETE FROM project_memory_attachment_mutations WHERE projection_source_id=? AND project_id=?
      AND attachment_id IN (SELECT id FROM project_memory_attachment_archive WHERE recovery_actor_id=? AND recovery_idempotency_key=?)`)
      .bind(plan.sourceId, projectId, principal.id, input.idempotencyKey));
    statements.push(database.prepare(`DELETE FROM project_memory_attachments WHERE projection_source_id=? AND project_id=?
      AND id IN (SELECT id FROM project_memory_attachment_archive WHERE recovery_actor_id=? AND recovery_idempotency_key=?)`)
      .bind(plan.sourceId, projectId, principal.id, input.idempotencyKey));
  }
  statements.push(database.prepare(`INSERT INTO project_operational_recovery_receipts
    (actor_id,idempotency_key,request_fingerprint,preview_fingerprint,projection_source_id,project_id,recovery_sequence,action,
     old_root_kind,old_root_id,new_root_kind,new_root_id,reason,contacts_version_before,contacts_version_after,
     memory_version_before,memory_version_after,contacts_visible_from_version,memory_visible_from_version,
     cleared_contact_count,excluded_attachment_count,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(principal.id, input.idempotencyKey, requestFingerprint, input.previewFingerprint, plan.sourceId, projectId, sequence,
      plan.input.action, plan.oldRoot.kind, plan.oldRoot.id, plan.newRoot.kind, plan.newRoot.id, plan.input.reason,
      contactsBefore, contactsAfter, memoryBefore, memoryAfter, contactsVisibleFrom, memoryVisibleFrom,
      plan.contactCount, plan.excludedAttachmentCount, JSON.stringify(result)));
  statements.push(database.prepare(`DELETE FROM project_operational_recovery_fences WHERE actor_id=? AND idempotency_key=?`)
    .bind(principal.id, input.idempotencyKey));
  try { await database.batch(statements); return result; }
  catch (error) {
    const winner = await database.prepare(`SELECT request_fingerprint,preview_fingerprint,projection_source_id,project_id,new_root_kind,new_root_id,result_json
      FROM project_operational_recovery_receipts WHERE actor_id=? AND idempotency_key=?`)
      .bind(principal.id, input.idempotencyKey).first<ReceiptRow>();
    if (winner) {
      if (winner.request_fingerprint !== requestFingerprint || winner.preview_fingerprint !== input.previewFingerprint
        || winner.projection_source_id !== context.root.source_id || winner.project_id !== projectId
        || winner.new_root_kind !== rootRecordKind(context) || winner.new_root_id !== context.root.public_id) changed();
      const current = await prepareProject(env, principal, context, projectId, "project.contacts.manage", input.expectedContextVersion);
      await prepareProject(env, principal, context, projectId, "project.memory.manage", input.expectedContextVersion);
      const stored = receiptResult(winner);
      if (current.project.last_sync_id !== stored.project.revision) changed();
      return { ...stored, replayed: true };
    }
    if (error instanceof Error && /recovery|current context|constraint|version|unique|foreign key/i.test(error.message)) changed();
    throw new HTTPException(503, { message: "Project recovery could not be completed. Retry with the same operation key." });
  }
}
