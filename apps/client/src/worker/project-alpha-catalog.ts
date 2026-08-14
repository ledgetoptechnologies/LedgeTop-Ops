import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PUBLIC_ID = /^(?=.{1,128}$)(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]*$/;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

type AccessVerifier = (request: Request, env: Env) => Promise<unknown>;

export interface CatalogQuestion {
  id: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "multi_select";
  required: boolean;
  helpText: string | null;
  maxLength?: number;
  minimum?: number | null;
  maximum?: number | null;
  options?: Array<{ value: string; label: string }>;
}

export interface CatalogProjectionItem {
  publicId: string;
  sourceVersion: string;
  name: string;
  summary: string | null;
  category: string;
  displayOrder: number;
  geometryRequirement: "none" | "optional" | "required";
  questions: CatalogQuestion[];
}

interface CommonDelivery {
  schemaVersion: 2;
  applicationKey: string;
  deliveryId: string;
  occurredAt: string;
  sourceGeneration: string;
  sourceSequence: number;
}

interface SnapshotPageDelivery extends CommonDelivery {
  kind: "snapshot.page";
  snapshotHash: string;
  pageNumber: number;
  pageCount: number;
  itemCount: number;
  items: CatalogProjectionItem[];
}

interface SnapshotActivateDelivery extends CommonDelivery {
  kind: "snapshot.activate";
  snapshotHash: string;
  pageCount: number;
  itemCount: number;
}

interface EventDelivery extends CommonDelivery {
  kind: "event";
  event: { action: "upsert"; item: CatalogProjectionItem } | { action: "tombstone"; publicId: string; sourceVersion: string };
}

export type CatalogProjectionDelivery = SnapshotPageDelivery | SnapshotActivateDelivery | EventDelivery;

interface ReceiptRow { payload_hash: string; status: "completed" | "ignored"; }
interface CheckpointRow { active_generation_id: string | null; source_generation: string; source_sequence: number; }
interface GenerationRow {
  id: string;
  source_generation: string;
  source_sequence: number;
  snapshot_hash: string;
  page_count: number;
  item_count: number;
  status: "staging" | "active" | "superseded" | "rejected";
  complete: number;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes)
      throw new Error("catalog-size-invalid");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("catalog-size-invalid");
        throw new Error("catalog-size-invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function database(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return typeof candidate.withSession === "function" ? candidate.withSession("first-primary") : env.DELIVERY_DB;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key)) && keys.every(key => key in value);
}

function optionalExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key));
}

function plainText(value: unknown, maximum: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error("catalog-schema-invalid");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) {
    throw new Error("catalog-text-invalid");
  }
  return normalized;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error("catalog-number-invalid");
  return value as number;
}

function parseQuestion(value: unknown): CatalogQuestion {
  if (!record(value)) throw new Error("catalog-question-invalid");
  const requiredKeys = ["id", "label", "type", "required"] as const;
  if (!optionalExactKeys(value, requiredKeys, ["helpText", "maxLength", "minimum", "maximum", "options"])) throw new Error("catalog-question-fields-invalid");
  const id = plainText(value.id, 64)!;
  if (!QUESTION_ID.test(id) || typeof value.required !== "boolean") throw new Error("catalog-question-invalid");
  const label = plainText(value.label, 160)!;
  const helpText = value.helpText === undefined || value.helpText === null ? null : plainText(value.helpText, 500);
  if (value.type === "text") {
    if (value.minimum !== undefined || value.maximum !== undefined || value.options !== undefined) throw new Error("catalog-question-fields-invalid");
    return { id, label, type: "text", required: value.required, helpText, maxLength: value.maxLength === undefined ? 1000 : integer(value.maxLength, 1, 2000) };
  }
  if (value.type === "number") {
    if (value.maxLength !== undefined || value.options !== undefined) throw new Error("catalog-question-fields-invalid");
    const minimum = value.minimum === undefined || value.minimum === null ? null : Number(value.minimum);
    const maximum = value.maximum === undefined || value.maximum === null ? null : Number(value.maximum);
    if ((minimum !== null && !Number.isFinite(minimum)) || (maximum !== null && !Number.isFinite(maximum)) || (minimum !== null && maximum !== null && minimum > maximum)) throw new Error("catalog-question-bounds-invalid");
    return { id, label, type: "number", required: value.required, helpText, minimum, maximum };
  }
  if (value.type === "boolean") {
    if (value.maxLength !== undefined || value.minimum !== undefined || value.maximum !== undefined || value.options !== undefined) throw new Error("catalog-question-fields-invalid");
    return { id, label, type: "boolean", required: value.required, helpText };
  }
  if (value.type !== "select" && value.type !== "multi-select") throw new Error("catalog-question-type-invalid");
  if (value.maxLength !== undefined || value.minimum !== undefined || value.maximum !== undefined || !Array.isArray(value.options) || value.options.length < 1 || value.options.length > 50) throw new Error("catalog-question-options-invalid");
  const seen = new Set<string>();
  const options = value.options.map(raw => {
    if (!record(raw) || !exactKeys(raw, ["value", "label"])) throw new Error("catalog-question-option-invalid");
    const optionValue = plainText(raw.value, 100)!;
    const optionLabel = plainText(raw.label, 160)!;
    if (seen.has(optionValue)) throw new Error("catalog-question-option-duplicate");
    seen.add(optionValue);
    return { value: optionValue, label: optionLabel };
  });
  return { id, label, type: value.type === "multi-select" ? "multi_select" : "select", required: value.required, helpText, options };
}

function parseItem(value: unknown): CatalogProjectionItem {
  if (!record(value) || !exactKeys(value, ["publicId", "sourceVersion", "name", "summary", "category", "displayOrder", "geometryRequirement", "questions"])) throw new Error("catalog-item-fields-invalid");
  const publicId = plainText(value.publicId, 128)!;
  const sourceVersion = plainText(value.sourceVersion, 128)!;
  if (!PUBLIC_ID.test(publicId) || !SAFE_ID.test(sourceVersion) || !Array.isArray(value.questions) || value.questions.length > 10) throw new Error("catalog-item-invalid");
  if (value.geometryRequirement !== "none" && value.geometryRequirement !== "optional" && value.geometryRequirement !== "required") throw new Error("catalog-geometry-requirement-invalid");
  const questions = value.questions.map(parseQuestion);
  if (new Set(questions.map(question => question.id)).size !== questions.length) throw new Error("catalog-question-duplicate");
  return {
    publicId,
    sourceVersion,
    name: plainText(value.name, 160)!,
    summary: value.summary === null ? null : plainText(value.summary, 1000),
    category: plainText(value.category, 100)!,
    displayOrder: integer(value.displayOrder, 0, 1_000_000),
    geometryRequirement: value.geometryRequirement,
    questions,
  };
}

function parseCommon(value: Record<string, unknown>): CommonDelivery {
  if (value.schemaVersion !== 2 || typeof value.applicationKey !== "string" || typeof value.deliveryId !== "string" || typeof value.occurredAt !== "string" || typeof value.sourceGeneration !== "string") throw new Error("catalog-envelope-invalid");
  if (!SAFE_ID.test(value.deliveryId) || !SAFE_ID.test(value.sourceGeneration) || !Number.isSafeInteger(value.sourceSequence) || (value.sourceSequence as number) < 1 || !Number.isFinite(Date.parse(value.occurredAt))) throw new Error("catalog-envelope-invalid");
  return value as unknown as CommonDelivery;
}

export function parseCatalogProjectionDelivery(value: unknown, expectedApplicationKey: string): CatalogProjectionDelivery {
  if (!record(value) || typeof value.kind !== "string") throw new Error("catalog-envelope-invalid");
  const common = parseCommon(value);
  if (!expectedApplicationKey || common.applicationKey !== expectedApplicationKey) throw new Error("catalog-application-mismatch");
  const base = ["schemaVersion", "applicationKey", "deliveryId", "occurredAt", "sourceGeneration", "sourceSequence", "kind"] as const;
  if (value.kind === "snapshot.page") {
    if (!exactKeys(value, [...base, "snapshotHash", "pageNumber", "pageCount", "itemCount", "items"]) || typeof value.snapshotHash !== "string" || !SHA256_HEX.test(value.snapshotHash) || !Array.isArray(value.items)) throw new Error("catalog-snapshot-page-invalid");
    const pageNumber = integer(value.pageNumber, 1, 100);
    const pageCount = integer(value.pageCount, 1, 100);
    const itemCount = integer(value.itemCount, 0, 500);
    if (pageNumber > pageCount || value.items.length > 50) throw new Error("catalog-snapshot-page-invalid");
    const items = value.items.map(parseItem);
    if (new Set(items.map(item => item.publicId)).size !== items.length) throw new Error("catalog-item-duplicate");
    return { ...common, kind: "snapshot.page", snapshotHash: value.snapshotHash, pageNumber, pageCount, itemCount, items };
  }
  if (value.kind === "snapshot.activate") {
    if (!exactKeys(value, [...base, "snapshotHash", "pageCount", "itemCount"]) || typeof value.snapshotHash !== "string" || !SHA256_HEX.test(value.snapshotHash)) throw new Error("catalog-snapshot-activate-invalid");
    return { ...common, kind: "snapshot.activate", snapshotHash: value.snapshotHash, pageCount: integer(value.pageCount, 1, 100), itemCount: integer(value.itemCount, 0, 500) };
  }
  if (value.kind === "event") {
    if (!exactKeys(value, [...base, "event"]) || !record(value.event) || typeof value.event.action !== "string") throw new Error("catalog-event-invalid");
    if (value.event.action === "upsert") {
      if (!exactKeys(value.event, ["action", "item"])) throw new Error("catalog-event-fields-invalid");
      return { ...common, kind: "event", event: { action: "upsert", item: parseItem(value.event.item) } };
    }
    if (value.event.action === "tombstone") {
      if (!exactKeys(value.event, ["action", "publicId", "sourceVersion"])) throw new Error("catalog-event-fields-invalid");
      const publicId = plainText(value.event.publicId, 128)!;
      const sourceVersion = plainText(value.event.sourceVersion, 128)!;
      if (!PUBLIC_ID.test(publicId) || !SAFE_ID.test(sourceVersion)) throw new Error("catalog-event-invalid");
      return { ...common, kind: "event", event: { action: "tombstone", publicId, sourceVersion } };
    }
    throw new Error("catalog-event-action-invalid");
  }
  throw new Error("catalog-kind-invalid");
}

function bytesFromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyHmac(rawBody: Uint8Array, timestamp: string, suppliedHeader: string | null, secret: string | undefined): Promise<void> {
  if (!secret || secret.length < 32 || !suppliedHeader?.startsWith("sha256=")) throw new Error("catalog-signature-required");
  const suppliedHex = suppliedHeader.slice(7).toLowerCase();
  if (!SHA256_HEX.test(suppliedHex)) throw new Error("catalog-signature-invalid");
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + rawBody.length);
  message.set(prefix);
  message.set(rawBody, prefix.length);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, bytesFromHex(suppliedHex).buffer as ArrayBuffer, message.buffer as ArrayBuffer)) throw new Error("catalog-signature-invalid");
}

export async function verifyCatalogAccessAssertion(request: Request, env: Env): Promise<void> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const teamDomain = env.PROJECT_ALPHA_CATALOG_ACCESS_TEAM_DOMAIN?.replace(/\/$/, "");
  const audience = env.PROJECT_ALPHA_CATALOG_ACCESS_AUD;
  if (!assertion || !teamDomain?.startsWith("https://") || !audience) throw new Error("catalog-access-required");
  try {
    await jwtVerify(assertion, createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`)), { issuer: teamDomain, audience, algorithms: ["RS256"] });
  } catch {
    throw new Error("catalog-access-invalid");
  }
}

async function existingReceipt(env: Env, deliveryId: string, payloadHash: string): Promise<"duplicate" | null> {
  const receipt = await database(env).prepare("SELECT payload_hash,status FROM pa_service_catalog_projection_receipts WHERE delivery_id=?").bind(deliveryId).first<ReceiptRow>();
  if (!receipt) return null;
  if (receipt.payload_hash !== payloadHash) throw new Error("catalog-delivery-id-conflict");
  return "duplicate";
}

function receiptStatement(db: D1Database, delivery: CatalogProjectionDelivery, payloadHash: string, kind: "snapshot_page" | "snapshot_activate" | "event", status: "completed" | "ignored" = "completed"): D1PreparedStatement {
  return db.prepare(`INSERT INTO pa_service_catalog_projection_receipts(delivery_id,delivery_kind,payload_hash,source_sequence,status) VALUES(?,?,?,?,?)`)
    .bind(delivery.deliveryId, kind, payloadHash, delivery.sourceSequence, status);
}

function auditStatement(db: D1Database, delivery: CatalogProjectionDelivery, action: string, details: Record<string, unknown>): D1PreparedStatement {
  return db.prepare(`INSERT INTO pa_service_catalog_projection_audit(id,action,delivery_id,source_generation,source_sequence,details_json) VALUES(?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), action, delivery.deliveryId, delivery.sourceGeneration, delivery.sourceSequence, JSON.stringify(details));
}

async function stageSnapshotPage(env: Env, delivery: SnapshotPageDelivery, payloadHash: string): Promise<"completed" | "ignored"> {
  const db = database(env);
  const checkpoint = await db.prepare("SELECT source_sequence FROM pa_service_catalog_checkpoint WHERE singleton=1").first<{ source_sequence: number }>();
  if (!checkpoint || delivery.sourceSequence <= checkpoint.source_sequence) throw new Error("catalog-snapshot-stale");
  let generation = await db.prepare("SELECT * FROM pa_service_catalog_generations WHERE source_generation=?").bind(delivery.sourceGeneration).first<GenerationRow>();
  if (!generation) {
    const generationId = crypto.randomUUID();
    await db.prepare(`INSERT INTO pa_service_catalog_generations(id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status) VALUES(?,?,?,?,?,?,'staging')`)
      .bind(generationId, delivery.sourceGeneration, delivery.sourceSequence, delivery.snapshotHash, delivery.pageCount, delivery.itemCount).run();
    generation = await db.prepare("SELECT * FROM pa_service_catalog_generations WHERE source_generation=?").bind(delivery.sourceGeneration).first<GenerationRow>();
  }
  if (!generation || generation.source_sequence !== delivery.sourceSequence || generation.snapshot_hash !== delivery.snapshotHash || generation.page_count !== delivery.pageCount || generation.item_count !== delivery.itemCount || generation.status !== "staging") throw new Error("catalog-generation-conflict");
  const existingPage = await db.prepare("SELECT payload_hash FROM pa_service_catalog_generation_pages WHERE generation_id=? AND page_number=?").bind(generation.id, delivery.pageNumber).first<{ payload_hash: string }>();
  if (existingPage) {
    if (existingPage.payload_hash !== payloadHash) throw new Error("catalog-page-conflict");
    await db.batch([
      receiptStatement(db, delivery, payloadHash, "snapshot_page", "ignored"),
      auditStatement(db, delivery, "delivery_replayed", { kind: delivery.kind, pageNumber: delivery.pageNumber }),
    ]);
    return "ignored";
  }
  await db.batch([
    db.prepare("INSERT INTO pa_service_catalog_generation_pages(generation_id,page_number,item_count,payload_hash) VALUES(?,?,?,?)").bind(generation.id, delivery.pageNumber, delivery.items.length, payloadHash),
    ...delivery.items.map(item => db.prepare(`INSERT INTO pa_service_catalog_generation_items
      (generation_id,page_number,public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(generation!.id, delivery.pageNumber, item.publicId, item.sourceVersion, item.name, item.summary, item.category, item.displayOrder, item.geometryRequirement, JSON.stringify(item.questions))),
    receiptStatement(db, delivery, payloadHash, "snapshot_page"),
    auditStatement(db, delivery, "snapshot_page_staged", { pageNumber: delivery.pageNumber, pageCount: delivery.pageCount, itemCount: delivery.items.length }),
  ]);
  return "completed";
}

async function activateSnapshot(env: Env, delivery: SnapshotActivateDelivery, payloadHash: string): Promise<"completed" | "ignored"> {
  const db = database(env);
  const generation = await db.prepare("SELECT * FROM pa_service_catalog_generations WHERE source_generation=?").bind(delivery.sourceGeneration).first<GenerationRow>();
  if (!generation || generation.source_sequence !== delivery.sourceSequence || generation.snapshot_hash !== delivery.snapshotHash || generation.page_count !== delivery.pageCount || generation.item_count !== delivery.itemCount) throw new Error("catalog-generation-incomplete");
  const checkpoint = await db.prepare("SELECT active_generation_id,source_generation,source_sequence FROM pa_service_catalog_checkpoint WHERE singleton=1").first<CheckpointRow>();
  if (!checkpoint) throw new Error("catalog-checkpoint-missing");
  if (checkpoint.source_sequence === delivery.sourceSequence && checkpoint.active_generation_id === generation.id && generation.status === "active") {
    await db.batch([
      receiptStatement(db, delivery, payloadHash, "snapshot_activate", "ignored"),
      auditStatement(db, delivery, "delivery_replayed", { kind: delivery.kind }),
    ]);
    return "ignored";
  }
  if (delivery.sourceSequence <= checkpoint.source_sequence || generation.status !== "staging") throw new Error("catalog-snapshot-stale");
  const staged = await db.prepare(`SELECT COUNT(DISTINCT page_number) page_count,COUNT(*) item_count,MIN(page_number) min_page,MAX(page_number) max_page FROM pa_service_catalog_generation_items WHERE generation_id=?`).bind(generation.id).first<{ page_count: number; item_count: number; min_page: number | null; max_page: number | null }>();
  const receivedPages = await db.prepare("SELECT COUNT(*) count,SUM(item_count) item_count,MIN(page_number) min_page,MAX(page_number) max_page FROM pa_service_catalog_generation_pages WHERE generation_id=?").bind(generation.id).first<{ count: number; item_count: number | null; min_page: number | null; max_page: number | null }>();
  if (!staged || !receivedPages || receivedPages.count !== delivery.pageCount || (receivedPages.item_count ?? 0) !== delivery.itemCount || receivedPages.min_page !== 1 || receivedPages.max_page !== delivery.pageCount || staged.item_count !== delivery.itemCount) throw new Error("catalog-generation-incomplete");
  const reusedVersion = await db.prepare(`SELECT 1 conflict FROM pa_service_catalog_generation_items staged
    JOIN pa_service_catalog_items current ON current.public_id=staged.public_id AND current.source_version=staged.source_version
    WHERE staged.generation_id=? AND (
      current.name<>staged.name OR COALESCE(current.summary,'')<>COALESCE(staged.summary,'')
      OR current.category<>staged.category OR current.display_order<>staged.display_order
      OR current.geometry_requirement<>staged.geometry_requirement
      OR current.question_schema_json<>staged.question_schema_json
    ) LIMIT 1`).bind(generation.id).first("conflict");
  if (reusedVersion) throw new Error("catalog-source-version-conflict");
  await db.batch([
    db.prepare("UPDATE pa_service_catalog_items SET active=0 WHERE active=1"),
    db.prepare(`INSERT INTO pa_service_catalog_items
      (public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at,mirrored_at,source_generation,source_sequence)
      SELECT public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,1,?,datetime('now'),?,?
      FROM pa_service_catalog_generation_items WHERE generation_id=?
      ON CONFLICT(public_id,source_version) DO UPDATE SET name=excluded.name,summary=excluded.summary,category=excluded.category,display_order=excluded.display_order,geometry_requirement=excluded.geometry_requirement,question_schema_json=excluded.question_schema_json,active=1,source_updated_at=excluded.source_updated_at,mirrored_at=datetime('now'),source_generation=excluded.source_generation,source_sequence=excluded.source_sequence`)
      .bind(delivery.occurredAt, delivery.sourceGeneration, delivery.sourceSequence, generation.id),
    db.prepare("UPDATE pa_service_catalog_entity_state SET active=0,source_sequence=?,updated_at=datetime('now')").bind(delivery.sourceSequence),
    db.prepare(`INSERT INTO pa_service_catalog_entity_state(public_id,source_version,source_sequence,active)
      SELECT public_id,source_version,?,1 FROM pa_service_catalog_generation_items WHERE generation_id=?
      ON CONFLICT(public_id) DO UPDATE SET source_version=excluded.source_version,source_sequence=excluded.source_sequence,active=1,updated_at=datetime('now')`)
      .bind(delivery.sourceSequence, generation.id),
    db.prepare("UPDATE pa_service_catalog_generations SET status='superseded' WHERE status='active' AND id<>?").bind(generation.id),
    db.prepare("UPDATE pa_service_catalog_generations SET status='active',complete=1,activated_at=datetime('now') WHERE id=? AND status='staging'").bind(generation.id),
    db.prepare("UPDATE pa_service_catalog_checkpoint SET active_generation_id=?,source_generation=?,source_sequence=?,updated_at=datetime('now') WHERE singleton=1 AND source_sequence<?")
      .bind(generation.id, delivery.sourceGeneration, delivery.sourceSequence, delivery.sourceSequence),
    receiptStatement(db, delivery, payloadHash, "snapshot_activate"),
    auditStatement(db, delivery, "snapshot_activated", { pageCount: delivery.pageCount, itemCount: delivery.itemCount }),
  ]);
  return "completed";
}

async function applyEvent(env: Env, delivery: EventDelivery, payloadHash: string): Promise<"completed"> {
  const db = database(env);
  const checkpoint = await db.prepare("SELECT active_generation_id,source_generation,source_sequence FROM pa_service_catalog_checkpoint WHERE singleton=1").first<CheckpointRow>();
  if (!checkpoint?.active_generation_id || delivery.sourceGeneration !== checkpoint.source_generation) throw new Error("catalog-event-generation-mismatch");
  if (delivery.sourceSequence !== checkpoint.source_sequence + 1) throw new Error("catalog-event-sequence-gap");
  const publicId = delivery.event.action === "upsert" ? delivery.event.item.publicId : delivery.event.publicId;
  const sourceVersion = delivery.event.action === "upsert" ? delivery.event.item.sourceVersion : delivery.event.sourceVersion;
  if (delivery.event.action === "upsert") {
    const item = delivery.event.item;
    const reusedVersion = await db.prepare(`SELECT 1 conflict FROM pa_service_catalog_items
      WHERE public_id=? AND source_version=? AND (
        name<>? OR COALESCE(summary,'')<>COALESCE(?, '') OR category<>? OR display_order<>?
        OR geometry_requirement<>? OR question_schema_json<>?
      ) LIMIT 1`).bind(item.publicId,item.sourceVersion,item.name,item.summary,item.category,item.displayOrder,item.geometryRequirement,JSON.stringify(item.questions)).first("conflict");
    if (reusedVersion) throw new Error("catalog-source-version-conflict");
  }
  const statements: D1PreparedStatement[] = [db.prepare("UPDATE pa_service_catalog_items SET active=0 WHERE public_id=? AND active=1").bind(publicId)];
  if (delivery.event.action === "upsert") {
    const item = delivery.event.item;
    statements.push(db.prepare(`INSERT INTO pa_service_catalog_items
      (public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at,mirrored_at,source_generation,source_sequence)
      VALUES(?,?,?,?,?,?,?,?,1,?,datetime('now'),?,?)
      ON CONFLICT(public_id,source_version) DO UPDATE SET name=excluded.name,summary=excluded.summary,category=excluded.category,display_order=excluded.display_order,geometry_requirement=excluded.geometry_requirement,question_schema_json=excluded.question_schema_json,active=1,source_updated_at=excluded.source_updated_at,mirrored_at=datetime('now'),source_generation=excluded.source_generation,source_sequence=excluded.source_sequence`)
      .bind(item.publicId, item.sourceVersion, item.name, item.summary, item.category, item.displayOrder, item.geometryRequirement, JSON.stringify(item.questions), delivery.occurredAt, delivery.sourceGeneration, delivery.sourceSequence));
  }
  statements.push(
    db.prepare(`INSERT INTO pa_service_catalog_entity_state(public_id,source_version,source_sequence,active) VALUES(?,?,?,?)
      ON CONFLICT(public_id) DO UPDATE SET source_version=excluded.source_version,source_sequence=excluded.source_sequence,active=excluded.active,updated_at=datetime('now')`)
      .bind(publicId, sourceVersion, delivery.sourceSequence, delivery.event.action === "upsert" ? 1 : 0),
    db.prepare("UPDATE pa_service_catalog_checkpoint SET source_sequence=?,updated_at=datetime('now') WHERE singleton=1 AND source_generation=? AND source_sequence=?")
      .bind(delivery.sourceSequence, delivery.sourceGeneration, checkpoint.source_sequence),
    receiptStatement(db, delivery, payloadHash, "event"),
    auditStatement(db, delivery, delivery.event.action === "upsert" ? "event_upserted" : "event_tombstoned", { publicId }),
  );
  await db.batch(statements);
  return "completed";
}

async function processDelivery(env: Env, delivery: CatalogProjectionDelivery, payloadHash: string): Promise<"completed" | "ignored" | "duplicate"> {
  const duplicate = await existingReceipt(env, delivery.deliveryId, payloadHash);
  if (duplicate) return duplicate;
  try {
    if (delivery.kind === "snapshot.page") return await stageSnapshotPage(env, delivery, payloadHash);
    if (delivery.kind === "snapshot.activate") return await activateSnapshot(env, delivery, payloadHash);
    return await applyEvent(env, delivery, payloadHash);
  } catch (error) {
    const raced = await existingReceipt(env, delivery.deliveryId, payloadHash);
    if (raced) return raced;
    throw error;
  }
}

function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : "catalog-internal-error";
  if (message.includes("access") || message.includes("signature") || message.includes("timestamp")) return 401;
  if (message.includes("conflict") || message.includes("stale") || message.includes("sequence") || message.includes("generation")) return 409;
  if (message.includes("size")) return 413;
  if (message.startsWith("catalog-")) return 422;
  return 500;
}

export async function handleProjectAlphaCatalogRequest(request: Request, env: Env, accessVerifier: AccessVerifier = verifyCatalogAccessAssertion): Promise<Response> {
  if (env.PROJECT_ALPHA_CATALOG_SYNC_ENABLED !== "true") return json(404, { error: "not-found" });
  try {
    if (request.method !== "POST") return json(404, { error: "not-found" });
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json(415, { error: "content-type-required" });
    await accessVerifier(request, env);
    const rawBody = await readBoundedRequestBody(request, MAX_BODY_BYTES);
    if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_BODY_BYTES) throw new Error("catalog-size-invalid");
    const timestamp = request.headers.get("X-PA-Timestamp");
    if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || Math.abs(Date.now() - Date.parse(timestamp)) > MAX_CLOCK_SKEW_MS) throw new Error("catalog-timestamp-invalid");
    await verifyHmac(rawBody, timestamp, request.headers.get("X-PA-Signature"), env.PROJECT_ALPHA_CATALOG_HMAC_SECRET);
    const parsed = parseCatalogProjectionDelivery(JSON.parse(new TextDecoder().decode(rawBody)) as unknown, env.PROJECT_ALPHA_CATALOG_APPLICATION_KEY ?? "");
    if (request.headers.get("X-PA-Delivery-ID") !== parsed.deliveryId) throw new Error("catalog-delivery-id-mismatch");
    const status = await processDelivery(env, parsed, await sha256Hex(rawBody));
    return json(200, { ok: true, deliveryId: parsed.deliveryId, status });
  } catch (error) {
    const message = error instanceof SyntaxError ? "catalog-json-invalid" : error instanceof Error ? error.message : "catalog-internal-error";
    const status = statusForError(error);
    if (status >= 500) console.error(JSON.stringify({ event: "project_alpha_catalog_projection_failed", error: message }));
    return json(status, { error: status >= 500 ? "catalog-internal-error" : message });
  }
}
