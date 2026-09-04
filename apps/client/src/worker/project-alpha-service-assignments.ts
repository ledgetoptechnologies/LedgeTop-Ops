import {
  PRIMARY_ALPHA_SOURCE_ID,
  SERVICE_ASSIGNMENT_SUBJECT_TYPES,
  createCatalogSourceContext,
  type CatalogSourceContext,
  type ServiceAssignmentProjectionDeliveryV1,
  type ServiceAssignmentProjectionItemV1,
  type ServiceAssignmentSubjectType,
} from "@ltds/shared";
import type { Env } from "./types";
import {
  assertPortalProjectionSourceProof,
  portalProjectionSourceFence,
  portalSourceAuthoritiesReady,
  reservePrimaryPortalSigningKeys,
  resolvePortalSourceAuthority,
  PortalSourceAuthorityError,
  type PortalAuthorityDatabase,
  type PortalProjectionWriteProof,
} from "./project-alpha-portal-authority";
import { verifyHmac, verifyPortalProjectionAccessAssertion } from "./project-alpha-portal";
import { verifyRegisteredPortalAccess } from "./project-alpha-portal-ingress";

const PRIMARY_PATH = "/api/internal/project-alpha/service-assignments-v1";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PUBLIC_ID = /^(?=.{1,128}$)(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SUBJECT_TYPES = new Set<string>(SERVICE_ASSIGNMENT_SUBJECT_TYPES);
type ProjectionStatus = "completed" | "ignored" | "duplicate";
type ProjectionDatabase = Pick<D1Database, "prepare" | "batch">;

interface CheckpointRow { active_generation_id: string; source_generation: string; source_sequence: number }
interface GenerationRow {
  id: string; source_generation: string; source_sequence: number; snapshot_hash: string;
  page_count: number; item_count: number; status: "staging" | "active" | "superseded" | "rejected"; complete: number;
}
interface WorkspaceProof {
  subjectType: ServiceAssignmentSubjectType; subjectPublicId: string; workspaceId: string;
  generationId: string; sourceSequence: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every(key => expected.has(key)) && keys.every(key => key in value);
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error("service-assignment-number-invalid");
  return value as number;
}
function safeId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_ID.test(value))
    throw new Error("service-assignment-id-invalid");
  return value;
}
function publicId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !PUBLIC_ID.test(value))
    throw new Error("service-assignment-public-id-invalid");
  return value;
}
function timestamp(value: unknown, nullable: true): string | null;
function timestamp(value: unknown, nullable?: false): string;
function timestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error("service-assignment-timestamp-invalid");
  return new Date(value).toISOString();
}
function parseItem(value: unknown): ServiceAssignmentProjectionItemV1 {
  if (!record(value) || !exactKeys(value, ["assignmentPublicId", "sourceVersion", "subjectType", "subjectPublicId",
    "servicePublicId", "serviceSourceVersion", "active", "effectiveFrom", "effectiveUntil"]))
    throw new Error("service-assignment-item-fields-invalid");
  if (!SUBJECT_TYPES.has(String(value.subjectType)) || typeof value.active !== "boolean")
    throw new Error("service-assignment-item-invalid");
  const effectiveFrom = timestamp(value.effectiveFrom, true), effectiveUntil = timestamp(value.effectiveUntil, true);
  if (effectiveFrom && effectiveUntil && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))
    throw new Error("service-assignment-window-invalid");
  return { assignmentPublicId: publicId(value.assignmentPublicId), sourceVersion: safeId(value.sourceVersion),
    subjectType: value.subjectType as ServiceAssignmentSubjectType, subjectPublicId: publicId(value.subjectPublicId),
    servicePublicId: publicId(value.servicePublicId), serviceSourceVersion: safeId(value.serviceSourceVersion),
    active: value.active, effectiveFrom, effectiveUntil };
}

export function parseServiceAssignmentProjectionDelivery(value: unknown,
  expectedApplicationKey: string): ServiceAssignmentProjectionDeliveryV1 {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.kind !== "string"
    || value.applicationKey !== expectedApplicationKey) throw new Error("service-assignment-envelope-invalid");
  const common = { schemaVersion: 1 as const, applicationKey: expectedApplicationKey,
    deliveryId: safeId(value.deliveryId), occurredAt: timestamp(value.occurredAt),
    sourceGeneration: safeId(value.sourceGeneration), sourceSequence: integer(value.sourceSequence, 1, Number.MAX_SAFE_INTEGER) };
  const base = ["schemaVersion", "applicationKey", "deliveryId", "occurredAt", "sourceGeneration", "sourceSequence", "kind"];
  if (value.kind === "snapshot.page") {
    if (!exactKeys(value, [...base, "snapshotHash", "pageNumber", "pageCount", "itemCount", "items"])
      || typeof value.snapshotHash !== "string" || !SHA256_HEX.test(value.snapshotHash) || !Array.isArray(value.items))
      throw new Error("service-assignment-snapshot-page-invalid");
    const pageNumber = integer(value.pageNumber, 1, 100), pageCount = integer(value.pageCount, 1, 100),
      itemCount = integer(value.itemCount, 0, 5000);
    if (pageNumber > pageCount || value.items.length > 100) throw new Error("service-assignment-snapshot-page-invalid");
    const items = value.items.map(parseItem);
    if (new Set(items.map(item => item.assignmentPublicId)).size !== items.length)
      throw new Error("service-assignment-item-duplicate");
    return { ...common, kind: "snapshot.page", snapshotHash: value.snapshotHash, pageNumber, pageCount, itemCount, items };
  }
  if (value.kind === "snapshot.activate") {
    if (!exactKeys(value, [...base, "snapshotHash", "pageCount", "itemCount"])
      || typeof value.snapshotHash !== "string" || !SHA256_HEX.test(value.snapshotHash))
      throw new Error("service-assignment-snapshot-activate-invalid");
    return { ...common, kind: "snapshot.activate", snapshotHash: value.snapshotHash,
      pageCount: integer(value.pageCount, 1, 100), itemCount: integer(value.itemCount, 0, 5000) };
  }
  if (value.kind !== "event" || !exactKeys(value, [...base, "event"]) || !record(value.event))
    throw new Error("service-assignment-event-invalid");
  if (value.event.action === "upsert" && exactKeys(value.event, ["action", "item"]))
    return { ...common, kind: "event", event: { action: "upsert", item: parseItem(value.event.item) } };
  if (value.event.action === "tombstone" && exactKeys(value.event, ["action", "assignmentPublicId", "sourceVersion"]))
    return { ...common, kind: "event", event: { action: "tombstone",
      assignmentPublicId: publicId(value.event.assignmentPublicId), sourceVersion: safeId(value.event.sourceVersion) } };
  throw new Error("service-assignment-event-invalid");
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalPageBytes(items: ServiceAssignmentProjectionItemV1[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, items }));
}
async function canonicalSnapshotHash(pages: Array<{ pageNumber: number; itemCount: number; pageHash: string }>,
  pageCount: number, itemCount: number): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, pageCount, itemCount, pages })));
}
async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new Error("service-assignment-size-invalid");
  if (!request.body) throw new Error("service-assignment-json-invalid");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("service-assignment-body-timeout")), 10_000); });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error("service-assignment-size-invalid");
      if (result.value.byteLength) chunks.push(result.value);
    }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
  if (!length) throw new Error("service-assignment-json-invalid");
  const body = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function checkpointGuard(sourceId: string, checkpoint: CheckpointRow | null) {
  return checkpoint ? { sql: `EXISTS(SELECT 1 FROM pa_service_assignment_checkpoints WHERE source_id=?
    AND active_generation_id=? AND source_generation=? AND source_sequence=?)`,
    bindings: [sourceId, checkpoint.active_generation_id, checkpoint.source_generation, checkpoint.source_sequence] as unknown[] }
    : { sql: "NOT EXISTS(SELECT 1 FROM pa_service_assignment_checkpoints WHERE source_id=?)", bindings: [sourceId] as unknown[] };
}
function generationGuard(sourceId: string, generation: GenerationRow | null) {
  return generation ? { sql: `EXISTS(SELECT 1 FROM pa_service_assignment_generations WHERE source_id=? AND id=?
    AND source_generation=? AND source_sequence=? AND snapshot_hash=? AND page_count=? AND item_count=? AND status=? AND complete=?)`,
    bindings: [sourceId, generation.id, generation.source_generation, generation.source_sequence, generation.snapshot_hash,
      generation.page_count, generation.item_count, generation.status, generation.complete] as unknown[] }
    : { sql: "1=1", bindings: [] as unknown[] };
}
function combinedGuard(...guards: Array<{ sql: string; bindings: unknown[] }>) {
  return { sql: guards.map(guard => `(${guard.sql})`).join(" AND "), bindings: guards.flatMap(guard => guard.bindings) };
}

async function workspaceProofs(db: PortalAuthorityDatabase, sourceId: string,
  subjects: ReadonlyArray<{ subjectType: ServiceAssignmentSubjectType; subjectPublicId: string }>): Promise<WorkspaceProof[]> {
  const unique = [...new Map(subjects.map(subject => [`${subject.subjectType}\0${subject.subjectPublicId}`, subject])).values()];
  if (!unique.length) return [];
  const tableCount = await db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN
    ('pa_portal_workspace_sources','portal_v2_workspaces','portal_v2_directory_checkpoints',
     'portal_v2_directory_generations','portal_v2_directory_entities')`).first<number>("n");
  if (tableCount !== 5) throw new Error("service-assignment-workspace-proof-unavailable");
  const proofs: WorkspaceProof[] = [];
  for (let index = 0; index < unique.length; index += 100) {
    const wanted = unique.slice(index, index + 100);
    const rows = (await db.prepare(`WITH requested AS (
        SELECT json_extract(value,'$.subjectType') subject_type,json_extract(value,'$.subjectPublicId') subject_public_id
        FROM json_each(?)
      ) SELECT requested.subject_type,requested.subject_public_id,owner.workspace_id,
        generation.id generation_id,generation.source_sequence FROM requested
      JOIN pa_service_assignment_receiver_workspaces allowlist
        ON allowlist.source_id=? AND allowlist.state='active'
      JOIN pa_portal_workspace_sources owner ON owner.projection_source_id=allowlist.source_id
        AND owner.workspace_id=allowlist.workspace_id
      JOIN portal_v2_workspaces workspace ON workspace.id=owner.workspace_id
        AND workspace.project_alpha_source_id=owner.projection_source_id AND workspace.status='active'
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
        AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities entity ON entity.workspace_id=workspace.id AND entity.generation_id=generation.id
        AND entity.entity_type=requested.subject_type AND entity.public_id=requested.subject_public_id AND entity.active=1
      ORDER BY requested.subject_type,requested.subject_public_id,owner.workspace_id`)
      .bind(JSON.stringify(wanted), sourceId).all<{ subject_type: ServiceAssignmentSubjectType; subject_public_id: string;
        workspace_id: string; generation_id: string; source_sequence: number }>()).results;
    const first = new Map<string, WorkspaceProof>(), ambiguous = new Set<string>();
    for (const row of rows) {
      const key = `${row.subject_type}\0${row.subject_public_id}`;
      if (first.has(key)) ambiguous.add(key);
      else first.set(key, { subjectType: row.subject_type, subjectPublicId: row.subject_public_id,
        workspaceId: row.workspace_id, generationId: row.generation_id, sourceSequence: row.source_sequence });
    }
    for (const subject of wanted) {
      const proof = first.get(`${subject.subjectType}\0${subject.subjectPublicId}`);
      if (!proof || ambiguous.has(`${subject.subjectType}\0${subject.subjectPublicId}`))
        throw new Error("service-assignment-workspace-not-allowed");
      proofs.push(proof);
    }
  }
  return proofs;
}

function serviceFence(db: ProjectionDatabase, sourceId: string, proofs: readonly WorkspaceProof[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO pa_service_assignment_write_fences(source_id,write_guard,updated_at)
    VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM pa_portal_source_write_fences WHERE source_id=? AND write_guard=1)
      AND EXISTS(SELECT 1 FROM pa_service_assignment_receiver_grants WHERE source_id=?
        AND capability='portal.service-assignments.publish' AND contract_version=1 AND state='active')
      AND EXISTS(SELECT 1 FROM pa_service_assignment_receiver_workspaces
        WHERE source_id=? AND state='active')
      AND NOT EXISTS(SELECT 1 FROM json_each(?) proof WHERE NOT COALESCE((
        SELECT count(*)=1 AND COALESCE(max(
          owner.workspace_id=json_extract(proof.value,'$.workspaceId')
          AND generation.id=json_extract(proof.value,'$.generationId')
          AND generation.source_sequence=json_extract(proof.value,'$.sourceSequence')
        ),0)=1
        FROM pa_service_assignment_receiver_workspaces allowlist
        JOIN pa_portal_workspace_sources owner ON owner.workspace_id=allowlist.workspace_id
          AND owner.projection_source_id=allowlist.source_id
        JOIN portal_v2_workspaces workspace ON workspace.id=owner.workspace_id
          AND workspace.project_alpha_source_id=owner.projection_source_id AND workspace.status='active'
        JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
        JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
          AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
          AND generation.status='active' AND generation.complete=1
        JOIN portal_v2_directory_entities entity ON entity.workspace_id=workspace.id AND entity.generation_id=generation.id
          AND entity.active=1 WHERE owner.projection_source_id=?
          AND allowlist.source_id=? AND allowlist.state='active'
          AND entity.entity_type=json_extract(proof.value,'$.subjectType')
          AND entity.public_id=json_extract(proof.value,'$.subjectPublicId')
      ),0))
      THEN 1 ELSE 0 END,datetime('now')) ON CONFLICT(source_id) DO UPDATE SET
      write_guard=excluded.write_guard,updated_at=excluded.updated_at`)
    .bind(sourceId, sourceId, sourceId, sourceId, JSON.stringify(proofs), sourceId, sourceId);
}
async function assertReceiverAdmission(db: PortalAuthorityDatabase, sourceId: string): Promise<void> {
  const row = await db.prepare(`SELECT 1 FROM pa_service_assignment_receiver_grants WHERE source_id=?
    AND capability='portal.service-assignments.publish' AND contract_version=1 AND state='active'
    AND EXISTS(SELECT 1 FROM pa_service_assignment_receiver_workspaces workspace
      WHERE workspace.source_id=? AND workspace.state='active')`).bind(sourceId, sourceId).first();
  if (!row) throw new Error("service-assignment-capability-unavailable");
}
function capability(db: ProjectionDatabase, sourceId: string) {
  return db.prepare(`INSERT INTO pa_service_assignment_source_capabilities(source_id,contract_version,state)
    VALUES(?,1,'supported') ON CONFLICT(source_id) DO UPDATE SET last_seen_at=datetime('now')`).bind(sourceId);
}
function receipt(db: ProjectionDatabase, sourceId: string, delivery: ServiceAssignmentProjectionDeliveryV1, bodyHash: string,
  kind: "snapshot_page" | "snapshot_activate" | "event", guard: { sql: string; bindings: unknown[] },
  status: "completed" | "ignored" = "completed") {
  return db.prepare(`INSERT INTO pa_service_assignment_projection_receipts
    (source_id,delivery_id,delivery_kind,payload_hash,source_sequence,status)
    VALUES(?,?,?,?,CASE WHEN ${guard.sql} THEN ? ELSE 0 END,?)`)
    .bind(sourceId, delivery.deliveryId, kind, bodyHash, ...guard.bindings, delivery.sourceSequence, status);
}
function audit(db: ProjectionDatabase, sourceId: string, delivery: ServiceAssignmentProjectionDeliveryV1,
  action: "snapshot_page_staged" | "snapshot_activated" | "event_upserted" | "event_tombstoned", details: object) {
  return db.prepare(`INSERT INTO pa_service_assignment_projection_audit
    (id,source_id,action,delivery_id,source_generation,source_sequence,details_json) VALUES(?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), sourceId, action, delivery.deliveryId, delivery.sourceGeneration,
      delivery.sourceSequence, JSON.stringify(details));
}
async function existingReceipt(db: ProjectionDatabase, sourceId: string, deliveryId: string, bodyHash: string): Promise<boolean> {
  const row = await db.prepare(`SELECT payload_hash FROM pa_service_assignment_projection_receipts
    WHERE source_id=? AND delivery_id=?`).bind(sourceId, deliveryId).first<{ payload_hash: string }>();
  if (!row) return false;
  if (row.payload_hash !== bodyHash) throw new Error("service-assignment-delivery-id-conflict");
  return true;
}
function itemValues(item: ServiceAssignmentProjectionItemV1, occurredAt: string): unknown[] {
  return [item.assignmentPublicId, item.sourceVersion, item.subjectType, item.subjectPublicId,
    item.servicePublicId, item.serviceSourceVersion, item.active ? 1 : 0, item.effectiveFrom, item.effectiveUntil, occurredAt];
}

async function stageSnapshotPage(db: ProjectionDatabase, sourceId: string,
  delivery: Extract<ServiceAssignmentProjectionDeliveryV1, { kind: "snapshot.page" }>, bodyHash: string,
  proofs: readonly WorkspaceProof[]): Promise<"completed" | "ignored"> {
  const checkpoint = await db.prepare("SELECT * FROM pa_service_assignment_checkpoints WHERE source_id=?")
    .bind(sourceId).first<CheckpointRow>();
  if (checkpoint && delivery.sourceSequence <= checkpoint.source_sequence)
    throw new Error("service-assignment-snapshot-stale");
  const generation = await db.prepare(`SELECT * FROM pa_service_assignment_generations
    WHERE source_id=? AND source_generation=?`).bind(sourceId, delivery.sourceGeneration).first<GenerationRow>();
  if (generation && (generation.source_sequence !== delivery.sourceSequence || generation.snapshot_hash !== delivery.snapshotHash
    || generation.page_count !== delivery.pageCount || generation.item_count !== delivery.itemCount
    || generation.status !== "staging" || generation.complete !== 0))
    throw new Error("service-assignment-generation-conflict");
  const generationId = generation?.id ?? crypto.randomUUID();
  const contentHash = await sha256Hex(canonicalPageBytes(delivery.items));
  const page = generation ? await db.prepare(`SELECT payload_hash,content_hash FROM pa_service_assignment_generation_pages
    WHERE source_id=? AND generation_id=? AND page_number=?`).bind(sourceId, generationId, delivery.pageNumber)
    .first<{ payload_hash: string; content_hash: string }>() : null;
  if (page && (page.payload_hash !== bodyHash || page.content_hash !== contentHash))
    throw new Error("service-assignment-page-conflict");
  const guard = combinedGuard(checkpointGuard(sourceId, checkpoint ?? null), generationGuard(sourceId, generation ?? null));
  const statements: D1PreparedStatement[] = [capability(db, sourceId),
    receipt(db, sourceId, delivery, bodyHash, "snapshot_page", guard, page ? "ignored" : "completed")];
  if (!page) {
    if (!generation) statements.push(db.prepare(`INSERT INTO pa_service_assignment_generations
      (id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status)
      VALUES(?,?,?,?,?,?,?,'staging')`).bind(generationId, sourceId, delivery.sourceGeneration, delivery.sourceSequence,
      delivery.snapshotHash, delivery.pageCount, delivery.itemCount));
    statements.push(db.prepare(`INSERT INTO pa_service_assignment_generation_pages
      (source_id,generation_id,page_number,item_count,content_hash,payload_hash) VALUES(?,?,?,?,?,?)`)
      .bind(sourceId, generationId, delivery.pageNumber, delivery.items.length, contentHash, bodyHash));
    for (const item of delivery.items) statements.push(db.prepare(`INSERT INTO pa_service_assignment_generation_items
      (source_id,generation_id,page_number,assignment_public_id,source_version,subject_type,subject_public_id,
       service_public_id,service_source_version,active,effective_from,effective_until,source_updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(sourceId, generationId, delivery.pageNumber, ...itemValues(item, delivery.occurredAt)));
    statements.push(audit(db, sourceId, delivery, "snapshot_page_staged",
      { pageNumber: delivery.pageNumber, itemCount: delivery.items.length }));
  }
  // Last statement: any grant, workspace, directory, or portal-authority change
  // rolls back every preceding write in this D1 transaction.
  statements.push(serviceFence(db, sourceId, proofs));
  await db.batch(statements);
  return page ? "ignored" : "completed";
}

async function activateSnapshot(db: ProjectionDatabase, sourceId: string,
  delivery: Extract<ServiceAssignmentProjectionDeliveryV1, { kind: "snapshot.activate" }>, bodyHash: string,
  proofs: readonly WorkspaceProof[]): Promise<"completed"> {
  const checkpoint = await db.prepare("SELECT * FROM pa_service_assignment_checkpoints WHERE source_id=?")
    .bind(sourceId).first<CheckpointRow>();
  if (checkpoint && delivery.sourceSequence <= checkpoint.source_sequence)
    throw new Error("service-assignment-snapshot-stale");
  const generation = await db.prepare(`SELECT * FROM pa_service_assignment_generations
    WHERE source_id=? AND source_generation=?`).bind(sourceId, delivery.sourceGeneration).first<GenerationRow>();
  if (!generation || generation.source_sequence !== delivery.sourceSequence || generation.snapshot_hash !== delivery.snapshotHash
    || generation.page_count !== delivery.pageCount || generation.item_count !== delivery.itemCount
    || generation.status !== "staging" || generation.complete !== 0)
    throw new Error("service-assignment-generation-mismatch");
  const pages = (await db.prepare(`SELECT page_number,item_count,content_hash FROM pa_service_assignment_generation_pages
    WHERE source_id=? AND generation_id=? ORDER BY page_number`).bind(sourceId, generation.id)
    .all<{ page_number: number; item_count: number; content_hash: string }>()).results;
  const itemCount = pages.reduce((sum, page) => sum + page.item_count, 0);
  const actualItems = await db.prepare(`SELECT count(*) count FROM pa_service_assignment_generation_items
    WHERE source_id=? AND generation_id=?`).bind(sourceId, generation.id).first<number>("count");
  if (pages.length !== delivery.pageCount || itemCount !== delivery.itemCount || actualItems !== delivery.itemCount)
    throw new Error("service-assignment-snapshot-incomplete");
  const computed = await canonicalSnapshotHash(pages.map(page => ({ pageNumber: page.page_number,
    itemCount: page.item_count, pageHash: page.content_hash })), delivery.pageCount, delivery.itemCount);
  if (computed !== delivery.snapshotHash) throw new Error("service-assignment-snapshot-digest-invalid");
  const conflict = await db.prepare(`SELECT 1 FROM pa_service_assignment_generation_items incoming
    JOIN pa_service_assignments existing ON existing.source_id=incoming.source_id
      AND existing.assignment_public_id=incoming.assignment_public_id AND existing.source_version=incoming.source_version
    WHERE incoming.source_id=? AND incoming.generation_id=? AND
      (existing.subject_type<>incoming.subject_type OR existing.subject_public_id<>incoming.subject_public_id
       OR existing.service_public_id<>incoming.service_public_id OR existing.service_source_version<>incoming.service_source_version
       OR existing.active<>incoming.active OR COALESCE(existing.effective_from,'')<>COALESCE(incoming.effective_from,'')
       OR COALESCE(existing.effective_until,'')<>COALESCE(incoming.effective_until,'')) LIMIT 1`)
    .bind(sourceId, generation.id).first();
  if (conflict) throw new Error("service-assignment-source-version-conflict");
  const guard = combinedGuard(checkpointGuard(sourceId, checkpoint ?? null), generationGuard(sourceId, generation));
  await db.batch([
    capability(db, sourceId), receipt(db, sourceId, delivery, bodyHash, "snapshot_activate", guard),
    db.prepare("UPDATE pa_service_assignments SET active=0 WHERE source_id=? AND active=1").bind(sourceId),
    db.prepare(`INSERT INTO pa_service_assignments
      (source_id,assignment_public_id,source_version,subject_type,subject_public_id,service_public_id,
       service_source_version,active,effective_from,effective_until,source_updated_at,source_generation,source_sequence)
      SELECT source_id,assignment_public_id,source_version,subject_type,subject_public_id,service_public_id,
       service_source_version,active,effective_from,effective_until,source_updated_at,?,?
      FROM pa_service_assignment_generation_items WHERE source_id=? AND generation_id=?
      ON CONFLICT(source_id,assignment_public_id,source_version) DO UPDATE SET active=excluded.active,
       mirrored_at=datetime('now'),source_generation=excluded.source_generation,source_sequence=excluded.source_sequence`)
      .bind(delivery.sourceGeneration, delivery.sourceSequence, sourceId, generation.id),
    db.prepare("UPDATE pa_service_assignment_entity_state SET active=0,updated_at=datetime('now') WHERE source_id=?").bind(sourceId),
    db.prepare(`INSERT INTO pa_service_assignment_entity_state(source_id,assignment_public_id,source_version,source_sequence,active)
      SELECT source_id,assignment_public_id,source_version,?,active FROM pa_service_assignment_generation_items
      WHERE source_id=? AND generation_id=? ON CONFLICT(source_id,assignment_public_id) DO UPDATE SET
      source_version=excluded.source_version,source_sequence=excluded.source_sequence,active=excluded.active,updated_at=datetime('now')`)
      .bind(delivery.sourceSequence, sourceId, generation.id),
    db.prepare("UPDATE pa_service_assignment_generations SET status='superseded' WHERE source_id=? AND status='active'").bind(sourceId),
    db.prepare("UPDATE pa_service_assignment_generations SET status='active',complete=1,activated_at=datetime('now') WHERE source_id=? AND id=? AND status='staging'")
      .bind(sourceId, generation.id),
    db.prepare(`INSERT INTO pa_service_assignment_checkpoints(source_id,active_generation_id,source_generation,source_sequence)
      VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET active_generation_id=excluded.active_generation_id,
      source_generation=excluded.source_generation,source_sequence=excluded.source_sequence,updated_at=datetime('now')`)
      .bind(sourceId, generation.id, delivery.sourceGeneration, delivery.sourceSequence),
    audit(db, sourceId, delivery, "snapshot_activated", { pageCount: delivery.pageCount, itemCount: delivery.itemCount }),
    serviceFence(db, sourceId, proofs),
  ]);
  return "completed";
}

async function applyEvent(db: ProjectionDatabase, sourceId: string,
  delivery: Extract<ServiceAssignmentProjectionDeliveryV1, { kind: "event" }>, bodyHash: string,
  proofs: readonly WorkspaceProof[]): Promise<"completed"> {
  const checkpoint = await db.prepare("SELECT * FROM pa_service_assignment_checkpoints WHERE source_id=?")
    .bind(sourceId).first<CheckpointRow>();
  if (!checkpoint || checkpoint.source_generation !== delivery.sourceGeneration)
    throw new Error("service-assignment-event-generation-mismatch");
  if (delivery.sourceSequence !== checkpoint.source_sequence + 1)
    throw new Error("service-assignment-event-sequence-gap");
  const assignmentId = delivery.event.action === "upsert" ? delivery.event.item.assignmentPublicId : delivery.event.assignmentPublicId;
  const sourceVersion = delivery.event.action === "upsert" ? delivery.event.item.sourceVersion : delivery.event.sourceVersion;
  const current = await db.prepare(`SELECT source_version FROM pa_service_assignment_entity_state
    WHERE source_id=? AND assignment_public_id=?`).bind(sourceId, assignmentId).first<{ source_version: string }>();
  // A tombstone has no subject on the wire. Never invent its containment or
  // accept a deletion for an entity this source has not previously established.
  if (delivery.event.action === "tombstone" && !current)
    throw new Error("service-assignment-tombstone-unknown");
  if (delivery.event.action === "tombstone" && current?.source_version !== sourceVersion)
    throw new Error("service-assignment-source-version-conflict");
  if (delivery.event.action === "upsert") {
    const item = delivery.event.item;
    const conflict = await db.prepare(`SELECT 1 FROM pa_service_assignments WHERE source_id=? AND assignment_public_id=?
      AND source_version=? AND (subject_type<>? OR subject_public_id<>? OR service_public_id<>? OR service_source_version<>?
       OR active<>? OR COALESCE(effective_from,'')<>COALESCE(?,'') OR COALESCE(effective_until,'')<>COALESCE(?,'')) LIMIT 1`)
      .bind(sourceId, item.assignmentPublicId, item.sourceVersion, item.subjectType, item.subjectPublicId,
        item.servicePublicId, item.serviceSourceVersion, item.active ? 1 : 0, item.effectiveFrom, item.effectiveUntil).first();
    if (conflict) throw new Error("service-assignment-source-version-conflict");
  }
  const guard = checkpointGuard(sourceId, checkpoint);
  const statements: D1PreparedStatement[] = [capability(db, sourceId), receipt(db, sourceId, delivery, bodyHash, "event", guard),
    db.prepare("UPDATE pa_service_assignments SET active=0 WHERE source_id=? AND assignment_public_id=? AND active=1")
      .bind(sourceId, assignmentId)];
  if (delivery.event.action === "upsert") {
    const item = delivery.event.item;
    statements.push(db.prepare(`INSERT INTO pa_service_assignments
      (source_id,assignment_public_id,source_version,subject_type,subject_public_id,service_public_id,
       service_source_version,active,effective_from,effective_until,source_updated_at,source_generation,source_sequence)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,assignment_public_id,source_version) DO UPDATE SET
       active=excluded.active,mirrored_at=datetime('now'),source_generation=excluded.source_generation,source_sequence=excluded.source_sequence`)
      .bind(sourceId, ...itemValues(item, delivery.occurredAt), delivery.sourceGeneration, delivery.sourceSequence));
  }
  statements.push(
    db.prepare(`INSERT INTO pa_service_assignment_entity_state(source_id,assignment_public_id,source_version,source_sequence,active)
      VALUES(?,?,?,?,?) ON CONFLICT(source_id,assignment_public_id) DO UPDATE SET source_version=excluded.source_version,
      source_sequence=excluded.source_sequence,active=excluded.active,updated_at=datetime('now')`)
      .bind(sourceId, assignmentId, sourceVersion, delivery.sourceSequence,
        delivery.event.action === "upsert" && delivery.event.item.active ? 1 : 0),
    db.prepare("UPDATE pa_service_assignment_checkpoints SET source_sequence=?,updated_at=datetime('now') WHERE source_id=?")
      .bind(delivery.sourceSequence, sourceId),
    audit(db, sourceId, delivery, delivery.event.action === "upsert" ? "event_upserted" : "event_tombstoned",
      { assignmentPublicId: assignmentId }),
    serviceFence(db, sourceId, proofs),
  );
  await db.batch(statements);
  return "completed";
}

async function stagedSubjects(db: ProjectionDatabase, sourceId: string, sourceGeneration: string) {
  return (await db.prepare(`SELECT item.subject_type,item.subject_public_id FROM pa_service_assignment_generation_items item
    JOIN pa_service_assignment_generations generation ON generation.id=item.generation_id AND generation.source_id=item.source_id
    WHERE item.source_id=? AND generation.source_generation=? GROUP BY item.subject_type,item.subject_public_id`)
    .bind(sourceId, sourceGeneration).all<{ subject_type: ServiceAssignmentSubjectType; subject_public_id: string }>()).results
    .map(row => ({ subjectType: row.subject_type, subjectPublicId: row.subject_public_id }));
}
async function tombstoneSubject(db: ProjectionDatabase, sourceId: string, assignmentId: string, sourceVersion: string) {
  const row = await db.prepare(`SELECT assignment.subject_type,assignment.subject_public_id
    FROM pa_service_assignment_entity_state state JOIN pa_service_assignments assignment
      ON assignment.source_id=state.source_id AND assignment.assignment_public_id=state.assignment_public_id
      AND assignment.source_version=state.source_version
    WHERE state.source_id=? AND state.assignment_public_id=? AND state.source_version=?`)
    .bind(sourceId, assignmentId, sourceVersion)
    .first<{ subject_type: ServiceAssignmentSubjectType; subject_public_id: string }>();
  if (!row) throw new Error("service-assignment-tombstone-unknown");
  return { subjectType: row.subject_type, subjectPublicId: row.subject_public_id };
}

async function applyServiceAssignmentProjectionCore(env: Env, sourceValue: CatalogSourceContext,
  authorityProof: PortalProjectionWriteProof|null, delivery: ServiceAssignmentProjectionDeliveryV1,
  bodyHash: string): Promise<ProjectionStatus> {
  const sourceId = createCatalogSourceContext(sourceValue.sourceId).sourceId;
  if ((authorityProof&&authorityProof.sourceId!==sourceId)||!SHA256_HEX.test(bodyHash))throw new PortalSourceAuthorityError("invalid");
  const session = env.DELIVERY_DB.withSession("first-primary");
  if(authorityProof)await assertPortalProjectionSourceProof(session,authorityProof);
  await assertReceiverAdmission(session, sourceId);
  if (await existingReceipt(session, sourceId, delivery.deliveryId, bodyHash)) return "duplicate";
  const subjects = delivery.kind === "snapshot.page" ? delivery.items
    : delivery.kind === "snapshot.activate" ? await stagedSubjects(session, sourceId, delivery.sourceGeneration)
      : delivery.event.action === "upsert" ? [delivery.event.item]
        : [await tombstoneSubject(session, sourceId, delivery.event.assignmentPublicId, delivery.event.sourceVersion)];
  const proofs = await workspaceProofs(session, sourceId, subjects);
  const db: PortalAuthorityDatabase = {
    prepare: sql => session.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => authorityProof
      ?(await session.batch<T>([portalProjectionSourceFence(session,authorityProof),...statements])).slice(1)
      :session.batch<T>(statements),
  };
  try {
    const result = delivery.kind === "snapshot.page"
      ? await stageSnapshotPage(db, sourceId, delivery, bodyHash, proofs)
      : delivery.kind === "snapshot.activate"
        ? await activateSnapshot(db, sourceId, delivery, bodyHash, proofs)
        : await applyEvent(db, sourceId, delivery, bodyHash, proofs);
    if(authorityProof)await assertPortalProjectionSourceProof(session,authorityProof);
    await assertReceiverAdmission(session, sourceId);
    return result;
  } catch (error) {
    if (await existingReceipt(session, sourceId, delivery.deliveryId, bodyHash)) return "duplicate";
    if (error instanceof Error && /pa_portal_source_write_guard|pa_service_assignment_write_guard/.test(error.message))
      throw new PortalSourceAuthorityError("changed");
    if (error instanceof Error && error.message.includes("service_assignment_delivery_write_guard"))
      throw new Error("service-assignment-write-conflict");
    throw error;
  }
}

/** Trusted storage seam. HTTP callers never construct source context/proof. */
export function applyServiceAssignmentProjectionDelivery(env:Env,sourceValue:CatalogSourceContext,
  authorityProof:PortalProjectionWriteProof,delivery:ServiceAssignmentProjectionDeliveryV1,bodyHash:string):Promise<ProjectionStatus>{
  return applyServiceAssignmentProjectionCore(env,sourceValue,authorityProof,delivery,bodyHash);
}

/** Private Ops Sync seam. Only the fixed primary source may omit a Client-side
 * authority proof; secondary sources remain fenced by their Client registry. */
export function applyServiceAssignmentProjectionFromOpsSync(env:Env,sourceValue:CatalogSourceContext,
  authorityProof:PortalProjectionWriteProof|null,delivery:ServiceAssignmentProjectionDeliveryV1,bodyHash:string):Promise<ProjectionStatus>{
  const source=createCatalogSourceContext(sourceValue.sourceId);
  if(source.sourceId!==PRIMARY_ALPHA_SOURCE_ID&&!authorityProof)throw new PortalSourceAuthorityError("invalid");
  return applyServiceAssignmentProjectionCore(env,source,authorityProof,delivery,bodyHash);
}

export function serviceAssignmentSourcePath(sourceId: string): string {
  return `/api/internal/project-alpha/sources/${encodeURIComponent(createCatalogSourceContext(sourceId).sourceId)}/service-assignments-v1`;
}
function json(status: number, value: object): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function statusForError(error: unknown): number {
  if (error instanceof PortalSourceAuthorityError) return ["conflict", "changed"].includes(error.code) ? 409
    : error.code === "invalid" ? 400 : error.code === "unavailable" ? 404 : 503;
  const message = error instanceof Error ? error.message : "";
  if (/service-assignment-(?:workspace-proof|authority)-unavailable/.test(message)
    || /no such (?:table|column): pa_service_assignment_/i.test(message)) return 503;
  if (message === "service-assignment-capability-unavailable") return 404;
  if (/access|signature|signing-key|timestamp/.test(message)) return 401;
  if (/workspace-not-allowed/.test(message)) return 403;
  if (/conflict|stale|sequence|generation|incomplete|capacity/.test(message)) return 409;
  if (/size/.test(message)) return 413;
  if (/timeout/.test(message)) return 408;
  if (message.startsWith("service-assignment-")) return 422;
  return 500;
}
async function decodeAndVerify(request: Request, applicationKey: string, current: { keyId: string; value: string },
  previous: { keyId: string; value: string } | null, path: string) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
    throw new Error("service-assignment-content-type-invalid");
  const raw = await readBoundedBody(request), bodyHash = await sha256Hex(raw);
  const timestampHeader = request.headers.get("X-Portal-Integration-Timestamp");
  if (!timestampHeader || !Number.isFinite(Date.parse(timestampHeader))
    || Math.abs(Date.now() - Date.parse(timestampHeader)) > MAX_CLOCK_SKEW_MS)
    throw new Error("service-assignment-timestamp-invalid");
  if (request.headers.get("X-Portal-Integration-Application-Key") !== applicationKey)
    throw new Error("service-assignment-application-mismatch");
  if (request.headers.get("X-Portal-Integration-Body-SHA256")?.toLowerCase() !== bodyHash)
    throw new Error("service-assignment-body-digest-invalid");
  const keyId = request.headers.get("X-Portal-Integration-Key-Id"),
    deliveryId = request.headers.get("X-Portal-Integration-Delivery-Id");
  if (!keyId || !deliveryId || !SAFE_ID.test(deliveryId)) throw new Error("service-assignment-signing-key-invalid");
  const key = keyId === current.keyId ? current : keyId === previous?.keyId ? previous : null;
  if (!key) throw new Error("service-assignment-signing-key-invalid");
  await verifyHmac(raw, timestampHeader, keyId, deliveryId,
    request.headers.get("X-Portal-Integration-Signature"), key.value, path);
  let wire: unknown;
  try { wire = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new Error("service-assignment-json-invalid"); }
  const delivery = parseServiceAssignmentProjectionDelivery(wire, applicationKey);
  if (delivery.deliveryId !== deliveryId) throw new Error("service-assignment-delivery-id-mismatch");
  return { delivery, bodyHash };
}
function primaryConfiguration(env: Env) {
  const current = { keyId: env.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID ?? "", value: env.PROJECT_ALPHA_PORTAL_HMAC_SECRET ?? "" };
  const previous = env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID && env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET
    ? { keyId: env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID, value: env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET } : null;
  if (env.PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED !== "true"
    || !SAFE_ID.test(env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY ?? "") || !SAFE_ID.test(current.keyId) || current.value.length < 32
    || (previous && (!SAFE_ID.test(previous.keyId) || previous.keyId === current.keyId || previous.value.length < 32))) return null;
  return { applicationKey: env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY!, current, previous };
}

export async function handleProjectAlphaServiceAssignmentsRequest(request: Request, env: Env,
  accessVerifier: (request: Request, env: Env) => Promise<void> = verifyPortalProjectionAccessAssertion): Promise<Response> {
  const config = primaryConfiguration(env);
  if (!config || request.method !== "POST") return json(404, { error: "not-found" });
  try {
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
      return json(415, { error: "content-type-required" });
    await accessVerifier(request, env);
    const verified = await decodeAndVerify(request, config.applicationKey, config.current, config.previous, PRIMARY_PATH);
    const proof = await reservePrimaryPortalSigningKeys(env);
    if (!proof) throw new Error("service-assignment-authority-unavailable");
    const status = await applyServiceAssignmentProjectionDelivery(env,
      createCatalogSourceContext(PRIMARY_ALPHA_SOURCE_ID), proof, verified.delivery, verified.bodyHash);
    return json(200, { ok: true, deliveryId: verified.delivery.deliveryId, status });
  } catch (error) {
    const status = statusForError(error);
    if (status >= 500) console.error(JSON.stringify({ event: "project_alpha_service_assignment_projection_failed",
      error: error instanceof Error ? error.message : "service-assignment-internal-error" }));
    return json(status, { error: status >= 500 ? "service-assignment-internal-error"
      : error instanceof Error ? error.message : "service-assignment-invalid" });
  }
}

type RegisteredAuthority = Awaited<ReturnType<typeof resolvePortalSourceAuthority>>;
export async function handleRegisteredProjectAlphaServiceAssignmentsRequest(request: Request, env: Env, sourceId: string,
  accessVerifier: (request: Request, authority: RegisteredAuthority) => Promise<void> = verifyRegisteredPortalAccess): Promise<Response> {
  if (env.PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED !== "true" || request.method !== "POST")
    return json(404, { error: "not-found" });
  try {
    const session = env.DELIVERY_DB.withSession("first-primary");
    if (!await portalSourceAuthoritiesReady(session)) return json(503, { error: "service-assignment-authority-unavailable" });
    const authority = await resolvePortalSourceAuthority(env, sourceId);
    // Grant denial happens before Access/network work and before reading a body.
    await assertReceiverAdmission(session, authority.proof.sourceId);
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
      return json(415, { error: "content-type-required" });
    await accessVerifier(request, authority);
    const path = serviceAssignmentSourcePath(authority.proof.sourceId);
    const verified = await decodeAndVerify(request, authority.applicationKey, authority.current, authority.previous, path);
    const status = await applyServiceAssignmentProjectionDelivery(env, createCatalogSourceContext(authority.proof.sourceId),
      authority.proof, verified.delivery, verified.bodyHash);
    return json(200, { ok: true, deliveryId: verified.delivery.deliveryId, status });
  } catch (error) {
    const status = statusForError(error);
    if (status >= 500) console.error(JSON.stringify({ event: "project_alpha_service_assignment_projection_failed",
      error: error instanceof Error ? error.message : "service-assignment-internal-error" }));
    return json(status, { error: status >= 500 ? "service-assignment-internal-error"
      : error instanceof Error ? error.message : "service-assignment-invalid" });
  }
}
