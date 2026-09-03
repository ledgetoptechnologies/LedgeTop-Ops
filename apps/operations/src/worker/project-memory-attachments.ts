import { HTTPException } from "hono/http-exception";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { assertOverlayRoot, emptyMemory, guardedFence, parseMemory, prepareProject, projectGuard, rootRecordKind,
  type ProjectMemorySnapshot } from "./project-operational-memory";
import type { Env, StaffPrincipal } from "./types";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_PROJECT_ATTACHMENTS = 100;
const MAX_PROJECT_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const MAX_PROJECT_PENDING_ATTACHMENTS = 10;
const MAX_PROJECT_PENDING_BYTES = 100 * 1024 * 1024;
const MAX_ACTOR_PENDING_ATTACHMENTS = 5;
const MAX_ACTOR_PENDING_BYTES = 50 * 1024 * 1024;
const MAX_CLEANUP_ATTEMPTS = 8;
const idempotencyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const contextPattern = /^[A-Za-z0-9_-]{43}$/;
const attachmentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Environment = Pick<Env, "OPS_DB" | "DATA_BUCKET">;
type Database = Pick<D1Database, "prepare" | "batch">;
interface MemoryRow {
  version: number; root_record_kind: "organization" | "client"; root_id: string; snapshot_json: string;
}
interface AttachmentRow {
  id: string; projection_source_id: string; project_id: string; root_record_kind: "organization" | "client";
  root_id: string; source_kind: "staff_upload"; display_name: string; content_type: AcceptedContentType;
  size_bytes: number; object_key: string; object_etag: string; sha256: string; version_added: number;
  created_at: string;
}
interface IntentRow {
  actor_id: string; idempotency_key: string; request_fingerprint: string; projection_source_id: string;
  project_id: string; root_record_kind: "organization" | "client"; root_id: string; attachment_id: string;
  object_key: string; display_name: string; content_type: AcceptedContentType; size_bytes: number; sha256: string;
  object_etag: string | null; expected_context_version: string; expected_memory_version: number;
  amendment_reason: string | null; status: "prepared" | "object_written" | "completed" | "cleanup_pending" | "cleanup_complete" | "cleanup_failed";
  cleanup_claimed_at: string | null;
}
interface ReceiptRow {
  request_fingerprint: string; projection_source_id: string; project_id: string; attachment_id: string;
  result_version: number; result_json: string;
}
type AcceptedContentType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/tiff" | "application/pdf";

export interface ProjectMemoryAttachmentDto {
  id: string; name: string; contentType: AcceptedContentType; size: number; sourceKind: "staff_upload";
  versionAdded: number; createdAt: string; downloadPath: string;
}
export interface ProjectMemoryAttachmentMutationResult {
  sourceId: string; projectId: string; version: number; replayed: boolean; attachment: ProjectMemoryAttachmentDto;
}

const database = (env: Environment): Database => env.OPS_DB.withSession("first-primary");
const changed = (): never => { throw new HTTPException(409, { message: "Project ownership, permissions, memory, or attachments changed. Refresh before continuing." }); };
const normalizeReason = (value: string | undefined): string | null => {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized))
    throw new HTTPException(400, { message: "X-Amendment-Reason is invalid" });
  return normalized;
};
const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, "0")).join("");
async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
}
function safeName(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(normalized))
    throw new HTTPException(400, { message: "X-File-Name contains unsafe directional or invisible characters" });
  const leaf = normalized.split(/[\\/]/).pop()?.trim() ?? "";
  const safe = Array.from(leaf.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "_").trim()).slice(0, 255).join("");
  if (!safe || safe === "." || safe === "..") throw new HTTPException(400, { message: "X-File-Name is invalid" });
  if (new TextEncoder().encode(safe).byteLength > 1024)
    throw new HTTPException(400, { message: "X-File-Name is too long" });
  return safe;
}
function exactHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) throw new HTTPException(400, { message: `${name} is required` });
  return value;
}
function encodedFileName(request: Request): string {
  const encoded = exactHeader(request, "X-File-Name");
  if (encoded.length > 3072 || /[^\x21-\x7e]/.test(encoded))
    throw new HTTPException(400, { message: "X-File-Name must be percent-encoded UTF-8" });
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); }
  catch { throw new HTTPException(400, { message: "X-File-Name must be percent-encoded UTF-8" }); }
  // A single canonical encoding makes client and server fingerprints agree and
  // prevents ambiguous double-decoding of percent sequences.
  if (encodeURIComponent(decoded) !== encoded)
    throw new HTTPException(400, { message: "X-File-Name must use canonical percent-encoded UTF-8" });
  return safeName(decoded);
}
function parseHeaders(request: Request) {
  const expectedContextVersion = exactHeader(request, "X-Expected-Context-Version");
  if (!contextPattern.test(expectedContextVersion)) throw new HTTPException(400, { message: "X-Expected-Context-Version is invalid" });
  const rawVersion = exactHeader(request, "X-Expected-Version");
  if (!/^(0|[1-9]\d*)$/.test(rawVersion)) throw new HTTPException(400, { message: "X-Expected-Version is invalid" });
  const expectedVersion = Number(rawVersion);
  if (!Number.isSafeInteger(expectedVersion)) throw new HTTPException(400, { message: "X-Expected-Version is invalid" });
  const idempotencyKey = exactHeader(request, "X-Idempotency-Key");
  if (!idempotencyPattern.test(idempotencyKey)) throw new HTTPException(400, { message: "X-Idempotency-Key is invalid" });
  const displayName = encodedFileName(request);
  const declaredType = exactHeader(request, "Content-Type").split(";", 1)[0]!.trim().toLowerCase();
  const amendmentReason = normalizeReason(request.headers.get("X-Amendment-Reason") ?? undefined);
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) throw new HTTPException(400, { message: "Content-Length is invalid" });
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > MAX_ATTACHMENT_BYTES)
      throw new HTTPException(413, { message: "Project-memory attachments are limited to 25 MiB" });
  }
  return { expectedContextVersion, expectedVersion, idempotencyKey, displayName, declaredType, amendmentReason };
}
async function boundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new HTTPException(400, { message: "Attachment content is required" });
  let size = 0, tooLarge = false;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    size += chunk.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) { tooLarge = true; controller.error(new Error("attachment-too-large")); return; }
    controller.enqueue(chunk);
  } });
  let buffer: ArrayBuffer;
  try {
    // Response.arrayBuffer creates the single contiguous payload used by magic
    // validation, hashing and R2; the limiter prevents unbounded chunked input.
    buffer = await new Response(request.body.pipeThrough(limiter)).arrayBuffer();
  } catch (error) {
    if (tooLarge || (error instanceof Error && error.message === "attachment-too-large"))
      throw new HTTPException(413, { message: "Project-memory attachments are limited to 25 MiB" });
    throw error;
  }
  if (size === 0) throw new HTTPException(400, { message: "Attachment content is required" });
  return new Uint8Array(buffer);
}
function starts(bytes: Uint8Array, values: number[]): boolean {
  return values.every((value, index) => bytes[index] === value);
}
function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}
function pdfContainsActiveToken(bytes: Uint8Array): boolean {
  // Decode bounded overlapping windows rather than materializing a second
  // full-size JS string for a 25 MiB PDF.
  const decoder = new TextDecoder("latin1"), window = 64 * 1024, overlap = 32;
  for (let offset = 0; offset < bytes.length; offset += window) {
    const start = Math.max(0, offset - overlap), end = Math.min(bytes.length, offset + window + overlap);
    const text = decoder.decode(bytes.subarray(start, end));
    // Decode PDF name escapes in each bounded window before inspecting names.
    const names = text.replace(/#([0-9a-f]{2})/gi, (_match, value: string) => String.fromCharCode(Number.parseInt(value, 16)));
    if (/\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|OpenAction|AA|AcroForm|XFA|Encrypt)\b/i.test(names)
      || /\/Type\s*\/ObjStm\b/i.test(names))
      return true;
  }
  return false;
}
function detectContent(bytes: Uint8Array): { contentType: AcceptedContentType; extensions: string[] } {
  if (bytes.length >= 16 && starts(bytes, [0xff, 0xd8, 0xff]) && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)
    return { contentType: "image/jpeg", extensions: ["jpg", "jpeg"] };
  if (bytes.length >= 20 && starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && ascii(bytes, bytes.length - 8, 4) === "IEND") return { contentType: "image/png", extensions: ["png"] };
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP"
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 <= bytes.length)
    return { contentType: "image/webp", extensions: ["webp"] };
  if (bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)) && bytes.at(-1) === 0x3b)
    return { contentType: "image/gif", extensions: ["gif"] };
  if (bytes.length >= 8 && (starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a]))) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), little = bytes[0] === 0x49;
    if (view.getUint32(4, little) < bytes.length) return { contentType: "image/tiff", extensions: ["tif", "tiff"] };
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 5) === "%PDF-"
    && new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 1024))).includes("%%EOF")) {
    if (pdfContainsActiveToken(bytes))
      throw new HTTPException(415, { message: "Active PDF content is not accepted for project memory" });
    return { contentType: "application/pdf", extensions: ["pdf"] };
  }
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))).trimStart().toLowerCase();
  if (prefix.startsWith("<svg") || prefix.startsWith("<?xml") || prefix.startsWith("<!doctype html") || prefix.startsWith("<html"))
    throw new HTTPException(415, { message: "SVG and HTML content is not accepted for project memory" });
  throw new HTTPException(415, { message: "Only verified JPEG, PNG, WebP, GIF, TIFF, and PDF files are accepted" });
}
function validateType(displayName: string, declaredType: string, bytes: Uint8Array): AcceptedContentType {
  const detected = detectContent(bytes), dot = displayName.lastIndexOf("."), extension = dot < 0 ? "" : displayName.slice(dot + 1).toLowerCase();
  if (!detected.extensions.includes(extension) || declaredType !== detected.contentType)
    throw new HTTPException(415, { message: "The file extension, declared content type, and verified content do not match" });
  return detected.contentType;
}
function attachmentPath(context: ClientHubCollectionContext, projectId: string, attachmentId: string): string {
  const routeKind = context.root.kind === "organization" ? "organizations" : "standalone";
  return `/api/client-hub/sources/${encodeURIComponent(context.root.source_id)}/business/${routeKind}/${encodeURIComponent(context.root.public_id)}`
    + `/business-projects/${encodeURIComponent(projectId)}/operational-memory/attachments/${encodeURIComponent(attachmentId)}/content`;
}
function dto(context: ClientHubCollectionContext, row: AttachmentRow): ProjectMemoryAttachmentDto {
  return { id: row.id, name: row.display_name, contentType: row.content_type, size: row.size_bytes,
    sourceKind: row.source_kind, versionAdded: row.version_added, createdAt: row.created_at,
    downloadPath: attachmentPath(context, row.project_id, row.id) };
}
async function receipt(db: Database, actorId: string, key: string): Promise<ReceiptRow | null> {
  return db.prepare(`SELECT request_fingerprint,projection_source_id,project_id,attachment_id,result_version,result_json
    FROM project_memory_attachment_mutations WHERE actor_id=? AND idempotency_key=?`).bind(actorId, key).first<ReceiptRow>();
}
async function replay(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext, projectId: string,
  fingerprint: string, row: ReceiptRow): Promise<ProjectMemoryAttachmentMutationResult> {
  if (row.request_fingerprint !== fingerprint || row.projection_source_id !== context.root.source_id || row.project_id !== projectId)
    throw new HTTPException(409, { message: "This operation key was already used for a different attachment" });
  await prepareProject(env as Env, principal, context, projectId, "project.memory.manage");
  const attachment = await database(env).prepare(`SELECT id,projection_source_id,project_id,root_record_kind,root_id,source_kind,
      display_name,content_type,size_bytes,object_key,object_etag,sha256,version_added,created_at
    FROM project_memory_attachments WHERE id=? AND projection_source_id=? AND project_id=?`)
    .bind(row.attachment_id, row.projection_source_id, row.project_id).first<AttachmentRow>();
  if (!attachment || attachment.root_record_kind !== rootRecordKind(context) || attachment.root_id !== context.root.public_id)
    throw new HTTPException(503, { message: "Saved attachment requires administrative review" });
  return { sourceId: row.projection_source_id, projectId: row.project_id, version: row.result_version,
    replayed: true, attachment: dto(context, attachment) };
}
async function scheduleCleanup(db: Database, actorId: string, key: string, code: string): Promise<void> {
  await db.prepare(`UPDATE project_memory_attachment_upload_intents SET status='cleanup_pending',cleanup_next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      cleanup_claimed_at=NULL,cleanup_error_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE actor_id=? AND idempotency_key=? AND status<>'completed'`).bind(code.slice(0, 80), actorId, key).run();
}
function errorCode(error: unknown): string {
  if (error instanceof HTTPException) return `http_${error.status}`;
  return error instanceof Error && /current context|version|UNIQUE|FOREIGN KEY|CHECK constraint|fence/i.test(error.message)
    ? "commit_conflict" : "upload_failure";
}

export async function uploadProjectMemoryAttachment(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, request: Request): Promise<ProjectMemoryAttachmentMutationResult> {
  const input = parseHeaders(request);
  // Reject unauthorized or stale callers before allocating/hashing a body that
  // may be the full 25 MiB. Authority is checked again after body validation.
  const initialPrepared = await prepareProject(env as Env, principal, context, projectId,
    "project.memory.manage", input.expectedContextVersion);
  const initialTerminal = initialPrepared.project.status === "completed" || initialPrepared.project.status === "cancelled";
  if (initialTerminal && !input.amendmentReason)
    throw new HTTPException(409, { message: "X-Amendment-Reason is required for a completed or cancelled project" });
  if (!initialTerminal && input.amendmentReason)
    throw new HTTPException(400, { message: "X-Amendment-Reason is only used after a project is completed or cancelled" });
  const db = database(env), earlyReceipt = await receipt(db, principal.id, input.idempotencyKey);
  if (!earlyReceipt) {
    const initialMemory = await db.prepare(`SELECT version,root_record_kind,root_id,snapshot_json FROM project_operational_memory
      WHERE projection_source_id=? AND project_id=?`).bind(initialPrepared.project.projection_source_id, projectId).first<MemoryRow>();
    assertOverlayRoot(context, initialMemory);
    if ((initialMemory?.version ?? 0) !== input.expectedVersion) changed();
  }
  const bytes = await boundedBody(request);
  const contentType = validateType(input.displayName, input.declaredType, bytes), digest = await sha256(bytes);
  const canonical = JSON.stringify({ sourceId: context.root.source_id, rootKind: context.root.kind, rootId: context.root.public_id,
    projectId, expectedContextVersion: input.expectedContextVersion, expectedVersion: input.expectedVersion,
    displayName: input.displayName, contentType, size: bytes.byteLength, sha256: digest, amendmentReason: input.amendmentReason });
  const requestFingerprint = await sha256(canonical);
  const saved = earlyReceipt ?? await receipt(db, principal.id, input.idempotencyKey);
  if (saved) return replay(env, principal, context, projectId, requestFingerprint, saved);

  const prepared = await prepareProject(env as Env, principal, context, projectId, "project.memory.manage", input.expectedContextVersion);
  const terminal = prepared.project.status === "completed" || prepared.project.status === "cancelled";
  if (terminal && !input.amendmentReason)
    throw new HTTPException(409, { message: "X-Amendment-Reason is required for a completed or cancelled project" });
  if (!terminal && input.amendmentReason)
    throw new HTTPException(400, { message: "X-Amendment-Reason is only used after a project is completed or cancelled" });
  const source = prepared.project.projection_source_id;
  const memory = await db.prepare(`SELECT version,root_record_kind,root_id,snapshot_json FROM project_operational_memory
    WHERE projection_source_id=? AND project_id=?`).bind(source, projectId).first<MemoryRow>();
  assertOverlayRoot(context, memory);
  if ((memory?.version ?? 0) !== input.expectedVersion) changed();
  const usage = await db.prepare(`SELECT count(*) count,COALESCE(sum(size_bytes),0) bytes FROM project_memory_attachments
    WHERE projection_source_id=? AND project_id=? AND root_record_kind=? AND root_id=?`)
    .bind(source, projectId, rootRecordKind(context), context.root.public_id).first<{ count: number; bytes: number }>();
  if (!usage || usage.count >= MAX_PROJECT_ATTACHMENTS || usage.bytes + bytes.byteLength > MAX_PROJECT_ATTACHMENT_BYTES)
    throw new HTTPException(409, { message: "This project has reached its private attachment quota" });

  // A Worker may have stopped after recording an intent or writing R2. Reap a
  // bounded stale batch before applying the atomic pending budget so abandoned
  // work cannot permanently lock an actor or project out of uploads.
  await cleanupProjectMemoryAttachmentUploads(env, MAX_PROJECT_PENDING_ATTACHMENTS);

  const proposedId = crypto.randomUUID(), proposedKey = `_ltds/ProjectMemory/${proposedId}/content`;
  await db.prepare(`INSERT OR IGNORE INTO project_memory_attachment_upload_intents
      (actor_id,idempotency_key,request_fingerprint,projection_source_id,project_id,root_record_kind,root_id,attachment_id,
       object_key,display_name,content_type,size_bytes,sha256,expected_context_version,expected_memory_version,amendment_reason,status)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared' WHERE
      (SELECT count(*) FROM project_memory_attachment_upload_intents pending WHERE pending.projection_source_id=? AND pending.project_id=?
        AND pending.status IN ('prepared','object_written','cleanup_pending','cleanup_failed'))<?
      AND COALESCE((SELECT sum(size_bytes) FROM project_memory_attachment_upload_intents pending
        WHERE pending.projection_source_id=? AND pending.project_id=? AND pending.status IN ('prepared','object_written','cleanup_pending','cleanup_failed')),0)+?<=?
      AND (SELECT count(*) FROM project_memory_attachment_upload_intents pending WHERE pending.actor_id=?
        AND pending.status IN ('prepared','object_written','cleanup_pending','cleanup_failed'))<?
      AND COALESCE((SELECT sum(size_bytes) FROM project_memory_attachment_upload_intents pending
        WHERE pending.actor_id=? AND pending.status IN ('prepared','object_written','cleanup_pending','cleanup_failed')),0)+?<=?`)
    .bind(principal.id, input.idempotencyKey, requestFingerprint, source, projectId,
      rootRecordKind(context), context.root.public_id, proposedId, proposedKey, input.displayName, contentType, bytes.byteLength, digest,
      input.expectedContextVersion, input.expectedVersion, input.amendmentReason,
      source, projectId, MAX_PROJECT_PENDING_ATTACHMENTS, source, projectId, bytes.byteLength, MAX_PROJECT_PENDING_BYTES,
      principal.id, MAX_ACTOR_PENDING_ATTACHMENTS, principal.id, bytes.byteLength, MAX_ACTOR_PENDING_BYTES).run();
  let intent = await db.prepare(`SELECT actor_id,idempotency_key,request_fingerprint,projection_source_id,project_id,root_record_kind,root_id,
      attachment_id,object_key,display_name,content_type,size_bytes,sha256,object_etag,expected_context_version,expected_memory_version,
      amendment_reason,status,cleanup_claimed_at FROM project_memory_attachment_upload_intents WHERE actor_id=? AND idempotency_key=?`)
    .bind(principal.id, input.idempotencyKey).first<IntentRow>();
  if (!intent) throw new HTTPException(429, { message: "This project has too many private attachment uploads awaiting cleanup. Try again after maintenance runs." });
  if (intent.request_fingerprint !== requestFingerprint || intent.projection_source_id !== source || intent.project_id !== projectId)
    throw new HTTPException(409, { message: "This operation key was already used for a different attachment" });
  if (intent.status === "completed") {
    const winner = await receipt(db, principal.id, input.idempotencyKey);
    if (!winner) throw new HTTPException(503, { message: "Saved attachment requires administrative review" });
    return replay(env, principal, context, projectId, requestFingerprint, winner);
  }
  if (intent.cleanup_claimed_at || intent.status === "cleanup_complete" || intent.status === "cleanup_failed")
    throw new HTTPException(409, { message: "This upload attempt is being cleaned up. Choose the file again to create a new operation." });

  try {
    let head = await env.DATA_BUCKET.head(intent.object_key);
    if (!head) {
      const stored = await env.DATA_BUCKET.put(intent.object_key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType }, customMetadata: {
          "ltds-sha256": digest, "ltds-size": String(bytes.byteLength), "ltds-attachment-id": intent.attachment_id,
        },
      });
      head = stored ?? await env.DATA_BUCKET.head(intent.object_key);
    }
    if (!head || head.size !== bytes.byteLength || head.customMetadata?.["ltds-sha256"] !== digest
      || head.customMetadata?.["ltds-size"] !== String(bytes.byteLength)
      || head.customMetadata?.["ltds-attachment-id"] !== intent.attachment_id)
      throw new HTTPException(409, { message: "The private attachment object could not be verified" });
    const promoted = await db.prepare(`UPDATE project_memory_attachment_upload_intents SET status='object_written',object_etag=?,
        cleanup_next_attempt_at=NULL,cleanup_claimed_at=NULL,cleanup_error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE actor_id=? AND idempotency_key=? AND status IN ('prepared','object_written','cleanup_pending') AND cleanup_claimed_at IS NULL`)
      .bind(head.etag, principal.id, input.idempotencyKey).run();
    if (promoted.meta.changes !== 1) throw new HTTPException(409, { message: "The upload cleanup lease changed. Retry with a new operation key." });
    intent = { ...intent, object_etag: head.etag, status: "object_written", cleanup_claimed_at: null };

    // Re-authorize after the non-transactional R2 write.  The D1 guards below
    // repeat this exact authority/version/root proof inside the final batch.
    const finalPrepared = await prepareProject(env as Env, principal, context, projectId, "project.memory.manage", input.expectedContextVersion);
    const current = await db.prepare(`SELECT version,root_record_kind,root_id,snapshot_json FROM project_operational_memory
      WHERE projection_source_id=? AND project_id=?`).bind(source, projectId).first<MemoryRow>();
    assertOverlayRoot(context, current);
    if ((current?.version ?? 0) !== input.expectedVersion) changed();
    const snapshot: ProjectMemorySnapshot = current ? parseMemory(current.snapshot_json) : emptyMemory();
    const snapshotJson = JSON.stringify(snapshot), version = input.expectedVersion + 1;
    const guard = projectGuard(finalPrepared, principal, "project.memory.manage", input.expectedVersion, "project_operational_memory");
    const resultBase = { sourceId: source, projectId, version };
    const createdAt = new Date().toISOString();
    const rowBase = { id: intent.attachment_id, projection_source_id: source, project_id: projectId,
      root_record_kind: rootRecordKind(context), root_id: context.root.public_id, source_kind: "staff_upload" as const,
      display_name: intent.display_name, content_type: intent.content_type, size_bytes: intent.size_bytes,
      object_key: intent.object_key, object_etag: intent.object_etag!, sha256: intent.sha256, version_added: version,
      created_at: createdAt };
    const publicResult: ProjectMemoryAttachmentMutationResult = { ...resultBase, replayed: false, attachment: dto(context, rowBase) };
    const statements: D1PreparedStatement[] = [
      guardedFence(db, finalPrepared, principal, "project.memory.manage", "memory", input.expectedVersion, 0, 0, guard, 1, 0, 0),
      db.prepare(`INSERT INTO project_memory_attachment_write_fences
        (projection_source_id,project_id,actor_id,idempotency_key,attachment_id,root_record_kind,root_id,expected_memory_version,incoming_size_bytes,
         memory_writes,revision_writes,attachment_writes,event_writes,mutation_writes,intent_writes,write_guard)
        VALUES(?,?,?,?,?,?,?,?,?,1,1,1,1,1,1,CASE WHEN ${guard.sql}
          AND EXISTS(SELECT 1 FROM project_memory_attachment_upload_intents intent WHERE intent.actor_id=? AND intent.idempotency_key=?
            AND intent.status='object_written' AND intent.cleanup_claimed_at IS NULL AND intent.attachment_id=? AND intent.object_etag=?)
          AND (SELECT count(*) FROM project_memory_attachments WHERE projection_source_id=? AND project_id=?)<100
          AND COALESCE((SELECT sum(size_bytes) FROM project_memory_attachments WHERE projection_source_id=? AND project_id=?),0)+?<=536870912
          THEN 1 ELSE 0 END)`)
        .bind(source, projectId, principal.id, input.idempotencyKey, intent.attachment_id, rootRecordKind(context), context.root.public_id,
          input.expectedVersion, intent.size_bytes,
          ...guard.values, principal.id, input.idempotencyKey, intent.attachment_id, intent.object_etag,
          source, projectId, source, projectId, intent.size_bytes),
    ];
    if (input.expectedVersion === 0) statements.push(db.prepare(`INSERT INTO project_operational_memory
      (projection_source_id,project_id,root_record_kind,root_id,version,snapshot_json,created_by,updated_by) VALUES(?,?,?,?,1,?,?,?)`)
      .bind(source, projectId, rootRecordKind(context), context.root.public_id, snapshotJson, principal.id, principal.id));
    else statements.push(db.prepare(`UPDATE project_operational_memory SET version=version+1,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE projection_source_id=? AND project_id=? AND version=?`).bind(principal.id, source, projectId, input.expectedVersion));
    statements.push(
      db.prepare(`INSERT INTO project_operational_memory_revisions
        (id,projection_source_id,project_id,version,change_kind,snapshot_json,amendment_reason,actor_id) VALUES(?,?,?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(), source, projectId, version, terminal ? "post_completion_amendment" : "saved", snapshotJson,
          input.amendmentReason, principal.id),
      db.prepare(`INSERT INTO project_memory_attachments
        (id,projection_source_id,project_id,root_record_kind,root_id,source_kind,display_name,content_type,size_bytes,
         object_key,object_etag,sha256,version_added,created_by,created_at) VALUES(?,?,?,?,?,'staff_upload',?,?,?,?,?,?,?,?,?)`)
        .bind(intent.attachment_id, source, projectId, rootRecordKind(context), context.root.public_id, intent.display_name,
          intent.content_type, intent.size_bytes, intent.object_key, intent.object_etag, intent.sha256, version, principal.id, createdAt),
      db.prepare(`INSERT INTO project_memory_attachment_events
        (id,projection_source_id,project_id,attachment_id,actor_id,event_kind,result_version,details_json)
        VALUES(?,?,?,?,?,'attachment_added',?,?)`).bind(crypto.randomUUID(), source, projectId, intent.attachment_id, principal.id,
          version, JSON.stringify({ schemaVersion: 1, sourceKind: "staff_upload", size: intent.size_bytes })),
      db.prepare(`INSERT INTO project_memory_attachment_mutations
        (actor_id,idempotency_key,operation_kind,request_fingerprint,projection_source_id,project_id,attachment_id,result_version,result_json)
        VALUES(?,?,'attachment_upload',?,?,?,?,?,?)`).bind(principal.id, input.idempotencyKey, requestFingerprint, source,
          projectId, intent.attachment_id, version, JSON.stringify({ schemaVersion: 1 })),
      db.prepare(`UPDATE project_memory_attachment_upload_intents SET status='completed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        cleanup_next_attempt_at=NULL,cleanup_claimed_at=NULL,cleanup_error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE actor_id=? AND idempotency_key=? AND status='object_written' AND cleanup_claimed_at IS NULL`)
        .bind(principal.id, input.idempotencyKey),
      db.prepare(`DELETE FROM project_memory_attachment_write_fences WHERE projection_source_id=? AND project_id=?`).bind(source, projectId),
      db.prepare(`DELETE FROM project_operational_write_fences WHERE projection_source_id=? AND project_id=?`).bind(source, projectId),
    );
    try { await db.batch(statements); }
    catch (error) {
      const winner = await receipt(db, principal.id, input.idempotencyKey);
      if (winner) return replay(env, principal, context, projectId, requestFingerprint, winner);
      throw error;
    }
    return publicResult;
  } catch (error) {
    await scheduleCleanup(db, principal.id, input.idempotencyKey, errorCode(error)).catch(() => undefined);
    if (error instanceof HTTPException) throw error;
    if (error instanceof Error && /current context|version|UNIQUE|FOREIGN KEY|CHECK constraint|fence/i.test(error.message)) changed();
    throw new HTTPException(503, { message: "The attachment could not be finalized. Retry with the same operation key." });
  }
}

function parseRange(value: string | null, size: number): { offset: number; length: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || value.includes(",") || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) } : "invalid";
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return "invalid";
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}
function disposition(name: string): string {
  const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}
export async function serveProjectMemoryAttachment(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, attachmentId: string, request: Request): Promise<Response> {
  if (!attachmentIdPattern.test(attachmentId)) throw new HTTPException(404, { message: "Attachment not found" });
  const firstProject = await prepareProject(env as Env, principal, context, projectId), db = database(env);
  const lookup = () => db.prepare(`SELECT id,projection_source_id,project_id,root_record_kind,root_id,source_kind,display_name,
      content_type,size_bytes,object_key,object_etag,sha256,version_added,created_at FROM project_memory_attachments
    WHERE id=? AND projection_source_id=? AND project_id=? AND root_record_kind=? AND root_id=?`)
    .bind(attachmentId, firstProject.project.projection_source_id, projectId, rootRecordKind(context), context.root.public_id).first<AttachmentRow>();
  const first = await lookup();
  if (!first) throw new HTTPException(404, { message: "Attachment not found" });
  const head = await env.DATA_BUCKET.head(first.object_key);
  if (!head || head.size !== first.size_bytes || head.etag !== first.object_etag
    || head.customMetadata?.["ltds-sha256"] !== first.sha256
    || head.customMetadata?.["ltds-size"] !== String(first.size_bytes)
    || head.customMetadata?.["ltds-attachment-id"] !== first.id)
    throw new HTTPException(409, { message: "Attachment content no longer matches its audited version" });
  const currentProject = await prepareProject(env as Env, principal, context, projectId), second = await lookup();
  if (currentProject.policy.proof !== firstProject.policy.proof || currentProject.sourceProof !== firstProject.sourceProof
    || JSON.stringify(currentProject.project) !== JSON.stringify(firstProject.project)
    || JSON.stringify(currentProject.root) !== JSON.stringify(firstProject.root) || JSON.stringify(second) !== JSON.stringify(first))
    changed();
  const requested = parseRange(request.headers.get("Range"), first.size_bytes);
  if (requested === "invalid") return new Response(null, { status: 416, headers: {
    "Content-Range": `bytes */${first.size_bytes}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  } });
  const headers = new Headers({ "Content-Type": first.content_type, "Content-Disposition": disposition(first.display_name),
    ETag: head.httpEtag, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Length": String(requested?.length ?? first.size_bytes) });
  if (requested) headers.set("Content-Range", `bytes ${requested.offset}-${requested.offset + requested.length - 1}/${first.size_bytes}`);
  if (request.method === "HEAD") return new Response(null, { status: requested ? 206 : 200, headers });
  const releaseProject = await prepareProject(env as Env, principal, context, projectId), releaseRow = await lookup();
  if (releaseProject.policy.proof !== firstProject.policy.proof || releaseProject.sourceProof !== firstProject.sourceProof
    || JSON.stringify(releaseProject.project) !== JSON.stringify(firstProject.project)
    || JSON.stringify(releaseProject.root) !== JSON.stringify(firstProject.root) || JSON.stringify(releaseRow) !== JSON.stringify(first))
    changed();
  const object = await env.DATA_BUCKET.get(first.object_key, { ...(requested ? { range: requested } : {}), onlyIf: { etagMatches: first.object_etag } });
  if (!object || !("body" in object) || object.etag !== first.object_etag || object.size !== first.size_bytes
    || object.customMetadata?.["ltds-sha256"] !== first.sha256
    || object.customMetadata?.["ltds-attachment-id"] !== first.id)
    throw new HTTPException(409, { message: "Attachment content changed while it was being opened" });
  return new Response(object.body, { status: requested ? 206 : 200, headers });
}

/** Reference-safe, bounded cleanup for upload intents left after an ambiguous
 * R2/D1 boundary failure.  A claimed intent cannot be finalized. */
export async function cleanupProjectMemoryAttachmentUploads(env: Environment, limit = 10): Promise<number> {
  const db = database(env); let processed = 0;
  const abandoned = await db.prepare(`UPDATE project_memory_attachment_upload_intents
    SET status='cleanup_pending',cleanup_next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),cleanup_claimed_at=NULL,
      cleanup_error_code='abandoned_upload',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE status IN ('prepared','object_written') AND datetime(updated_at)<=datetime('now','-1 hour')`).run();
  for (let index = 0; index < Math.max(0, Math.min(limit, 25)); index += 1) {
    const candidate = await db.prepare(`SELECT actor_id,idempotency_key FROM project_memory_attachment_upload_intents
      WHERE status='cleanup_pending' AND cleanup_attempts<? AND datetime(COALESCE(cleanup_next_attempt_at,'1970-01-01'))<=datetime('now')
        AND (cleanup_claimed_at IS NULL OR datetime(cleanup_claimed_at)<=datetime('now','-10 minutes'))
      ORDER BY cleanup_next_attempt_at,created_at LIMIT 1`).bind(MAX_CLEANUP_ATTEMPTS).first<{ actor_id: string; idempotency_key: string }>();
    if (!candidate) break;
    const claimed = await db.prepare(`UPDATE project_memory_attachment_upload_intents SET cleanup_claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        cleanup_attempts=cleanup_attempts+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE actor_id=? AND idempotency_key=? AND status='cleanup_pending' AND cleanup_attempts<?
        AND (cleanup_claimed_at IS NULL OR datetime(cleanup_claimed_at)<=datetime('now','-10 minutes'))`)
      .bind(candidate.actor_id, candidate.idempotency_key, MAX_CLEANUP_ATTEMPTS).run();
    if (claimed.meta.changes !== 1) continue;
    const row = await db.prepare(`SELECT attachment_id,object_key,object_etag,size_bytes,sha256,cleanup_attempts
      FROM project_memory_attachment_upload_intents WHERE actor_id=? AND idempotency_key=?`)
      .bind(candidate.actor_id, candidate.idempotency_key)
      .first<{ attachment_id: string; object_key: string; object_etag: string | null; size_bytes: number; sha256: string; cleanup_attempts: number }>();
    if (!row) continue;
    try {
      const referenced = await db.prepare("SELECT 1 FROM project_memory_attachments WHERE id=? AND object_key=?")
        .bind(row.attachment_id, row.object_key).first<number>();
      if (referenced) throw new Error("referenced_attachment");
      {
        const head = await env.DATA_BUCKET.head(row.object_key);
        if (head) {
          if (head.size !== row.size_bytes || (row.object_etag && head.etag !== row.object_etag)
            || head.customMetadata?.["ltds-sha256"] !== row.sha256
            || head.customMetadata?.["ltds-attachment-id"] !== row.attachment_id)
            throw new Error("ownership_mismatch");
          // The D1 claim excludes finalization. Delete only this exact random
          // object, then verify it is gone before completing the intent.
          await env.DATA_BUCKET.delete(row.object_key);
          if (await env.DATA_BUCKET.head(row.object_key)) throw new Error("object_remained");
        }
      }
      await db.prepare(`UPDATE project_memory_attachment_upload_intents SET status='cleanup_complete',cleanup_claimed_at=NULL,
        cleanup_next_attempt_at=NULL,cleanup_error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE actor_id=? AND idempotency_key=? AND status='cleanup_pending' AND cleanup_claimed_at IS NOT NULL`)
        .bind(candidate.actor_id, candidate.idempotency_key).run();
    } catch (error) {
      const manual = error instanceof Error && ["ownership_mismatch", "referenced_attachment"].includes(error.message);
      const terminal = manual || row.cleanup_attempts >= MAX_CLEANUP_ATTEMPTS, delay = Math.min(60, Math.max(1, row.cleanup_attempts * 5));
      await db.prepare(`UPDATE project_memory_attachment_upload_intents SET status=?,cleanup_claimed_at=NULL,cleanup_error_code='cleanup_failed',
        cleanup_next_attempt_at=CASE WHEN ? THEN NULL ELSE datetime('now','+' || ? || ' minutes') END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE actor_id=? AND idempotency_key=? AND status='cleanup_pending'`)
        .bind(terminal ? "cleanup_failed" : "cleanup_pending", terminal ? 1 : 0, delay, candidate.actor_id, candidate.idempotency_key).run();
    }
    processed += 1;
  }
  const pruned = await db.prepare(`DELETE FROM project_memory_attachment_upload_intents
    WHERE (status='completed' AND datetime(updated_at)<=datetime('now','-30 days'))
       OR (status='cleanup_complete' AND datetime(updated_at)<=datetime('now','-7 days'))`).run();
  if (processed || abandoned.meta.changes || pruned.meta.changes) console.log(JSON.stringify({
    event: "project_memory_attachment_cleanup.tick", processed, abandoned: abandoned.meta.changes, pruned: pruned.meta.changes,
  }));
  return processed;
}
