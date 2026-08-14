import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// Cross-system identity must be an opaque public identifier, never a serialized
// auto-increment key. At least one ASCII letter makes numeric IDs fail closed.
const PUBLIC_ID = /^(?=.{1,128}$)(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENTITY_TYPES = ["organization", "standalone_client", "department", "client", "project", "contact"] as const;
const CAPABILITIES = ["workspace.view", "directory.read", "delivery.view", "request.create", "member.manage", "delegated_share.create"] as const;
const SCOPE_TYPES = ["workspace", "organization", "department", "client", "project"] as const;
const RELATION_TYPES = ["contains", "contact_assignment"] as const;
const CONTAINS_RELATION_DIRECTIONS = new Set([
  "organization:department",
  "organization:client",
  "organization:project",
  "standalone_client:project",
  "department:project",
  "client:project",
]);
const CONTACT_ASSIGNMENT_SOURCES = new Set<EntityType>(["organization", "standalone_client", "department", "client", "project"]);
const SIGNED_PATH = "/api/internal/project-alpha/portal-v2";

type EntityType = typeof ENTITY_TYPES[number];
type Capability = typeof CAPABILITIES[number];
type ScopeType = typeof SCOPE_TYPES[number];
type RelationType = typeof RELATION_TYPES[number];
type AccessVerifier = (request: Request, env: Env) => Promise<unknown>;

interface WorkspaceResource {
  publicId: string;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  displayName: string;
  sourceVersion: string;
  active: boolean;
}

interface EntityResource {
  type: EntityType;
  publicId: string;
  parentPublicId: string | null;
  displayName: string;
  sourceVersion: string;
  active: boolean;
  primaryContact: boolean;
}

interface PrincipalResource {
  publicId: string;
  emailHint: string;
  displayName: string;
  sourceVersion: string;
  active: boolean;
}

interface EntitlementResource {
  publicId: string;
  principalPublicId: string;
  capability: Capability;
  effect: "allow" | "deny";
  scopeType: ScopeType;
  scopePublicId: string;
  sourceVersion: string;
  active: boolean;
  validFrom: string;
  expiresAt: string | null;
}

interface RelationResource {
  publicId: string;
  relationType: RelationType;
  from: { type: EntityType; publicId: string };
  to: { type: EntityType; publicId: string };
  sourceVersion: string;
  active: boolean;
}

interface ProjectLifecycleResource {
  projectPublicId: string;
  status: "active" | "completed";
  completedAt: string | null;
  sourceVersion: string;
}

interface CommonDelivery {
  schemaVersion: 2 | 3;
  applicationKey: string;
  deliveryId: string;
  occurredAt: string;
  sourceGeneration: string;
  sourceSequence: number;
  workspaceId: string;
}

interface SnapshotPageDelivery extends CommonDelivery {
  kind: "snapshot.page";
  snapshotHash: string;
  pageNumber: number;
  pageCount: number;
  recordCount: number;
  workspace: WorkspaceResource;
  entities: EntityResource[];
  principals: PrincipalResource[];
  entitlements: EntitlementResource[];
  relations: RelationResource[];
  projectLifecycles: ProjectLifecycleResource[];
}

interface SnapshotActivateDelivery extends CommonDelivery {
  kind: "snapshot.activate";
  snapshotHash: string;
  pageCount: number;
  recordCount: number;
}

type UpsertEvent =
  | { resource: "workspace"; action: "upsert"; workspace: WorkspaceResource }
  | { resource: "entity"; action: "upsert"; entity: EntityResource }
  | { resource: "principal"; action: "upsert"; principal: PrincipalResource }
  | { resource: "entitlement"; action: "upsert"; entitlement: EntitlementResource }
  | { resource: "relation"; action: "upsert"; relation: RelationResource }
  | { resource: "project_lifecycle"; action: "upsert"; projectLifecycle: ProjectLifecycleResource };
type TombstoneEvent = { resource: "workspace" | "entity" | "principal" | "entitlement" | "relation"; action: "tombstone"; publicId: string; sourceVersion: string };

interface EventDelivery extends CommonDelivery {
  kind: "event";
  event: UpsertEvent | TombstoneEvent;
}

export type PortalProjectionDelivery = SnapshotPageDelivery | SnapshotActivateDelivery | EventDelivery;

interface ProjectionGenerationRow {
  id: string;
  workspace_id: string;
  source_generation: string;
  source_sequence: number;
  snapshot_hash: string;
  page_count: number;
  record_count: number;
  workspace_root_type: WorkspaceResource["rootType"];
  workspace_root_public_id: string;
  workspace_display_name: string;
  workspace_source_version: string;
  workspace_active: number;
  status: "staging" | "active" | "superseded" | "rejected";
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes)
      throw new Error("portal-size-invalid");
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
        await reader.cancel("portal-size-invalid");
        throw new Error("portal-size-invalid");
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

async function directoryContractTablePresent(db: D1Database): Promise<boolean> {
  return (await db.prepare(`SELECT 1 present FROM sqlite_master
    WHERE type='table' AND name='portal_v2_directory_generation_contracts'`).first<number>("present")) === 1;
}

async function activeDirectoryContract(db: D1Database, workspaceId: string): Promise<{ schemaVersion: 2 | 3; tablePresent: boolean }> {
  const tablePresent = await directoryContractTablePresent(db);
  if (!tablePresent) return { schemaVersion: 2, tablePresent: false };
  const schemaVersion = await db.prepare(`SELECT contract.schema_version FROM portal_v2_directory_checkpoints checkpoint
    JOIN portal_v2_directory_generation_contracts contract ON contract.generation_id=checkpoint.active_generation_id AND contract.workspace_id=checkpoint.workspace_id
    WHERE checkpoint.workspace_id=?`).bind(workspaceId).first<number>("schema_version");
  if (schemaVersion !== 2 && schemaVersion !== 3) throw new Error("portal-generation-contract-missing");
  return { schemaVersion, tablePresent: true };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return keys.every(key => key in value) && Object.keys(value).every(key => allowed.has(key));
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error("portal-schema-invalid");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) throw new Error("portal-text-invalid");
  return normalized;
}

function publicId(value: unknown): string {
  const parsed = text(value, 128);
  if (!PUBLIC_ID.test(parsed)) throw new Error("portal-public-id-invalid");
  return parsed;
}

function safeId(value: unknown): string {
  const parsed = text(value, 128);
  if (!SAFE_ID.test(parsed)) throw new Error("portal-id-invalid");
  return parsed;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error("portal-number-invalid");
  return value as number;
}

function isoTimestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  const parsed = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) throw new Error("portal-timestamp-invalid");
  return new Date(parsed).toISOString();
}

function parseWorkspace(value: unknown): WorkspaceResource {
  if (!record(value) || !exactKeys(value, ["publicId", "rootType", "rootPublicId", "displayName", "sourceVersion", "active"])) throw new Error("portal-workspace-fields-invalid");
  if ((value.rootType !== "organization" && value.rootType !== "standalone_client") || typeof value.active !== "boolean") throw new Error("portal-workspace-invalid");
  return { publicId: publicId(value.publicId), rootType: value.rootType, rootPublicId: publicId(value.rootPublicId), displayName: text(value.displayName, 200), sourceVersion: safeId(value.sourceVersion), active: value.active };
}

function parseEntity(value: unknown): EntityResource {
  if (!record(value) || !exactKeys(value, ["type", "publicId", "parentPublicId", "displayName", "sourceVersion", "active", "primaryContact"])) throw new Error("portal-entity-fields-invalid");
  if (!ENTITY_TYPES.includes(value.type as EntityType) || typeof value.active !== "boolean" || typeof value.primaryContact !== "boolean") throw new Error("portal-entity-invalid");
  if (value.type !== "contact" && value.primaryContact) throw new Error("portal-primary-contact-invalid");
  return { type: value.type as EntityType, publicId: publicId(value.publicId), parentPublicId: value.parentPublicId === null ? null : publicId(value.parentPublicId), displayName: text(value.displayName, 240), sourceVersion: safeId(value.sourceVersion), active: value.active, primaryContact: value.primaryContact };
}

function parsePrincipal(value: unknown): PrincipalResource {
  if (!record(value) || !exactKeys(value, ["publicId", "emailHint", "displayName", "sourceVersion", "active"])) throw new Error("portal-principal-fields-invalid");
  const emailHint = text(value.emailHint, 320).toLocaleLowerCase("en-US");
  if (!EMAIL.test(emailHint) || typeof value.active !== "boolean") throw new Error("portal-principal-invalid");
  return { publicId: publicId(value.publicId), emailHint, displayName: text(value.displayName, 200), sourceVersion: safeId(value.sourceVersion), active: value.active };
}

function parseEntitlement(value: unknown): EntitlementResource {
  if (!record(value) || !exactKeys(value, ["publicId", "principalPublicId", "capability", "effect", "scopeType", "scopePublicId", "sourceVersion", "active", "validFrom", "expiresAt"])) throw new Error("portal-entitlement-fields-invalid");
  if (!CAPABILITIES.includes(value.capability as Capability) || (value.effect !== "allow" && value.effect !== "deny") || !SCOPE_TYPES.includes(value.scopeType as ScopeType) || typeof value.active !== "boolean") throw new Error("portal-entitlement-invalid");
  const validFrom = isoTimestamp(value.validFrom)!;
  const expiresAt = isoTimestamp(value.expiresAt, true);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(validFrom)) throw new Error("portal-entitlement-window-invalid");
  return { publicId: publicId(value.publicId), principalPublicId: publicId(value.principalPublicId), capability: value.capability as Capability, effect: value.effect, scopeType: value.scopeType as ScopeType, scopePublicId: publicId(value.scopePublicId), sourceVersion: safeId(value.sourceVersion), active: value.active, validFrom, expiresAt };
}

function parseRelationEndpoint(value: unknown): RelationResource["from"] {
  if (!record(value) || !exactKeys(value, ["type", "publicId"]) || !ENTITY_TYPES.includes(value.type as EntityType)) throw new Error("portal-relation-endpoint-invalid");
  return { type: value.type as EntityType, publicId: publicId(value.publicId) };
}

function validRelationShape(relation: Pick<RelationResource, "relationType" | "from" | "to">): boolean {
  if (relation.from.publicId === relation.to.publicId) return false;
  if (relation.relationType === "contact_assignment")
    return CONTACT_ASSIGNMENT_SOURCES.has(relation.from.type) && relation.to.type === "contact";
  return CONTAINS_RELATION_DIRECTIONS.has(`${relation.from.type}:${relation.to.type}`);
}

function parseRelation(value: unknown): RelationResource {
  if (!record(value) || !exactKeys(value, ["publicId", "relationType", "from", "to", "sourceVersion", "active"])) throw new Error("portal-relation-fields-invalid");
  if (!RELATION_TYPES.includes(value.relationType as RelationType) || typeof value.active !== "boolean") throw new Error("portal-relation-invalid");
  const relation: RelationResource = {
    publicId: publicId(value.publicId), relationType: value.relationType as RelationType,
    from: parseRelationEndpoint(value.from), to: parseRelationEndpoint(value.to),
    sourceVersion: safeId(value.sourceVersion), active: value.active,
  };
  if (!validRelationShape(relation)) throw new Error("portal-relation-shape-invalid");
  return relation;
}

function parseProjectLifecycle(value: unknown): ProjectLifecycleResource {
  if (!record(value) || !exactKeys(value, ["projectPublicId", "status", "completedAt", "sourceVersion"])) throw new Error("portal-project-lifecycle-fields-invalid");
  if (value.status !== "active" && value.status !== "completed") throw new Error("portal-project-lifecycle-invalid");
  const completedAt = isoTimestamp(value.completedAt, true);
  if ((value.status === "active" && completedAt !== null) || (value.status === "completed" && completedAt === null)) throw new Error("portal-project-lifecycle-invalid");
  return { projectPublicId: publicId(value.projectPublicId), status: value.status, completedAt, sourceVersion: safeId(value.sourceVersion) };
}

function parseCommon(value: Record<string, unknown>, relationsEnabled: boolean): CommonDelivery {
  if ((value.schemaVersion !== 2 && !(relationsEnabled && value.schemaVersion === 3)) || typeof value.applicationKey !== "string") throw new Error("portal-envelope-invalid");
  const occurredAt = isoTimestamp(value.occurredAt)!;
  return { schemaVersion: value.schemaVersion as 2 | 3, applicationKey: value.applicationKey, deliveryId: safeId(value.deliveryId), occurredAt, sourceGeneration: safeId(value.sourceGeneration), sourceSequence: integer(value.sourceSequence, 1, Number.MAX_SAFE_INTEGER), workspaceId: publicId(value.workspaceId) };
}

export function parsePortalProjectionDelivery(value: unknown, expectedApplicationKey: string, relationsEnabled = false): PortalProjectionDelivery {
  if (!record(value) || typeof value.kind !== "string") throw new Error("portal-envelope-invalid");
  const common = parseCommon(value, relationsEnabled);
  if (!expectedApplicationKey || common.applicationKey !== expectedApplicationKey) throw new Error("portal-application-mismatch");
  const base = ["schemaVersion", "applicationKey", "deliveryId", "occurredAt", "sourceGeneration", "sourceSequence", "workspaceId", "kind"];
  if (value.kind === "snapshot.page") {
    const pageFields = [...base, "snapshotHash", "pageNumber", "pageCount", "recordCount", "workspace", "entities", "principals", "entitlements", ...(common.schemaVersion === 3 ? ["relations", "projectLifecycles"] : [])];
    if (!exactKeys(value, pageFields) || typeof value.snapshotHash !== "string" || !SHA256_HEX.test(value.snapshotHash) || !Array.isArray(value.entities) || !Array.isArray(value.principals) || !Array.isArray(value.entitlements) || (common.schemaVersion === 3 && (!Array.isArray(value.relations) || !Array.isArray(value.projectLifecycles)))) throw new Error("portal-snapshot-page-invalid");
    const pageNumber = integer(value.pageNumber, 1, 100);
    const pageCount = integer(value.pageCount, 1, 100);
    const recordCount = integer(value.recordCount, 1, 2000);
    const relations = common.schemaVersion === 3 ? (value.relations as unknown[]).map(parseRelation) : [];
    const projectLifecycles = common.schemaVersion === 3 ? (value.projectLifecycles as unknown[]).map(parseProjectLifecycle) : [];
    if (pageNumber > pageCount || value.entities.length + value.principals.length + value.entitlements.length + relations.length + projectLifecycles.length > 100) throw new Error("portal-snapshot-page-invalid");
    const workspace = parseWorkspace(value.workspace);
    if (workspace.publicId !== common.workspaceId) throw new Error("portal-workspace-mismatch");
    return { ...common, kind: "snapshot.page", snapshotHash: value.snapshotHash, pageNumber, pageCount, recordCount, workspace, entities: value.entities.map(parseEntity), principals: value.principals.map(parsePrincipal), entitlements: value.entitlements.map(parseEntitlement), relations, projectLifecycles };
  }
  if (value.kind === "snapshot.activate") {
    if (!exactKeys(value, [...base, "snapshotHash", "pageCount", "recordCount"]) || typeof value.snapshotHash !== "string" || !SHA256_HEX.test(value.snapshotHash)) throw new Error("portal-snapshot-activate-invalid");
    return { ...common, kind: "snapshot.activate", snapshotHash: value.snapshotHash, pageCount: integer(value.pageCount, 1, 100), recordCount: integer(value.recordCount, 1, 2000) };
  }
  if (value.kind !== "event" || !exactKeys(value, [...base, "event"]) || !record(value.event) || typeof value.event.resource !== "string" || typeof value.event.action !== "string") throw new Error("portal-event-invalid");
  const event = value.event;
  if (event.action === "tombstone") {
    if (!exactKeys(event, ["resource", "action", "publicId", "sourceVersion"]) || typeof event.resource !== "string" || !["workspace", "entity", "principal", "entitlement", ...(common.schemaVersion === 3 ? ["relation"] : [])].includes(event.resource)) throw new Error("portal-event-fields-invalid");
    return { ...common, kind: "event", event: { resource: event.resource as TombstoneEvent["resource"], action: "tombstone", publicId: publicId(event.publicId), sourceVersion: safeId(event.sourceVersion) } };
  }
  if (event.action !== "upsert") throw new Error("portal-event-action-invalid");
  if (event.resource === "workspace" && exactKeys(event, ["resource", "action", "workspace"])) return { ...common, kind: "event", event: { resource: "workspace", action: "upsert", workspace: parseWorkspace(event.workspace) } };
  if (event.resource === "entity" && exactKeys(event, ["resource", "action", "entity"])) return { ...common, kind: "event", event: { resource: "entity", action: "upsert", entity: parseEntity(event.entity) } };
  if (event.resource === "principal" && exactKeys(event, ["resource", "action", "principal"])) return { ...common, kind: "event", event: { resource: "principal", action: "upsert", principal: parsePrincipal(event.principal) } };
  if (event.resource === "entitlement" && exactKeys(event, ["resource", "action", "entitlement"])) return { ...common, kind: "event", event: { resource: "entitlement", action: "upsert", entitlement: parseEntitlement(event.entitlement) } };
  if (common.schemaVersion === 3 && event.resource === "relation" && exactKeys(event, ["resource", "action", "relation"])) return { ...common, kind: "event", event: { resource: "relation", action: "upsert", relation: parseRelation(event.relation) } };
  if (common.schemaVersion === 3 && event.resource === "project_lifecycle" && exactKeys(event, ["resource", "action", "projectLifecycle"])) return { ...common, kind: "event", event: { resource: "project_lifecycle", action: "upsert", projectLifecycle: parseProjectLifecycle(event.projectLifecycle) } };
  throw new Error("portal-event-fields-invalid");
}

function bytesFromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyHmac(rawBody: Uint8Array, timestamp: string, suppliedHeader: string | null, secret: string | undefined): Promise<void> {
  if (!secret || secret.length < 32 || !suppliedHeader?.startsWith("sha256=")) throw new Error("portal-signature-required");
  const suppliedHex = suppliedHeader.slice(7).toLowerCase();
  if (!SHA256_HEX.test(suppliedHex)) throw new Error("portal-signature-invalid");
  const prefix = new TextEncoder().encode(`${timestamp}\nPOST\n${SIGNED_PATH}\n`);
  const message = new Uint8Array(prefix.length + rawBody.length);
  message.set(prefix);
  message.set(rawBody, prefix.length);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, bytesFromHex(suppliedHex).buffer as ArrayBuffer, message.buffer as ArrayBuffer)) throw new Error("portal-signature-invalid");
}

export async function verifyPortalProjectionAccessAssertion(request: Request, env: Env): Promise<void> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const teamDomain = env.PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN?.replace(/\/$/, "");
  const audience = env.PROJECT_ALPHA_PORTAL_ACCESS_AUD;
  if (!assertion || !teamDomain?.startsWith("https://") || !audience) throw new Error("portal-access-required");
  try {
    await jwtVerify(assertion, createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`)), { issuer: teamDomain, audience, algorithms: ["RS256"] });
  } catch {
    throw new Error("portal-access-invalid");
  }
}

function receiptStatement(db: D1Database, delivery: PortalProjectionDelivery, payloadHash: string, kind: "snapshot_page" | "snapshot_activate" | "event", status: "completed" | "ignored" = "completed"): D1PreparedStatement {
  return db.prepare("INSERT INTO pa_portal_projection_receipts(delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status) VALUES(?,?,?,?,?,?)")
    .bind(delivery.deliveryId, delivery.workspaceId, kind, payloadHash, delivery.sourceSequence, status);
}

function auditStatement(db: D1Database, delivery: PortalProjectionDelivery, action: string, details: Record<string, unknown>): D1PreparedStatement {
  return db.prepare("INSERT INTO pa_portal_projection_audit(id,workspace_id,action,delivery_id,source_generation,source_sequence,details_json) VALUES(?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), delivery.workspaceId, action, delivery.deliveryId, delivery.sourceGeneration, delivery.sourceSequence, JSON.stringify(details));
}

async function existingReceipt(db: D1Database, deliveryId: string, payloadHash: string): Promise<"duplicate" | null> {
  const row = await db.prepare("SELECT payload_hash FROM pa_portal_projection_receipts WHERE delivery_id=?").bind(deliveryId).first<{ payload_hash: string }>();
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw new Error("portal-delivery-id-conflict");
  return "duplicate";
}

async function stageSnapshotPage(env: Env, delivery: SnapshotPageDelivery, payloadHash: string): Promise<"completed" | "ignored"> {
  const db = database(env);
  const checkpoint = await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(delivery.workspaceId).first<{ source_sequence: number }>();
  if (checkpoint && delivery.sourceSequence <= checkpoint.source_sequence) throw new Error("portal-snapshot-stale");
  let generation = await db.prepare("SELECT * FROM pa_portal_projection_generations WHERE workspace_id=? AND source_generation=?").bind(delivery.workspaceId, delivery.sourceGeneration).first<ProjectionGenerationRow>();
  if (!generation) {
    await db.prepare(`INSERT OR IGNORE INTO pa_portal_projection_generations
      (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'staging')`)
      .bind(crypto.randomUUID(), delivery.workspaceId, delivery.sourceGeneration, delivery.sourceSequence, delivery.snapshotHash, delivery.pageCount, delivery.recordCount, delivery.workspace.rootType, delivery.workspace.rootPublicId, delivery.workspace.displayName, delivery.workspace.sourceVersion, delivery.workspace.active ? 1 : 0).run();
    generation = await db.prepare("SELECT * FROM pa_portal_projection_generations WHERE workspace_id=? AND source_generation=?").bind(delivery.workspaceId, delivery.sourceGeneration).first<ProjectionGenerationRow>();
  }
  if (!generation || generation.status !== "staging" || generation.source_sequence !== delivery.sourceSequence || generation.snapshot_hash !== delivery.snapshotHash || generation.page_count !== delivery.pageCount || generation.record_count !== delivery.recordCount || generation.workspace_root_type !== delivery.workspace.rootType || generation.workspace_root_public_id !== delivery.workspace.rootPublicId || generation.workspace_display_name !== delivery.workspace.displayName || generation.workspace_source_version !== delivery.workspace.sourceVersion || generation.workspace_active !== (delivery.workspace.active ? 1 : 0)) throw new Error("portal-generation-conflict");
  if (env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true") {
    await db.prepare("INSERT OR IGNORE INTO pa_portal_projection_generation_contracts(generation_id,schema_version) VALUES (?,?)").bind(generation.id, delivery.schemaVersion).run();
    const contract = await db.prepare("SELECT schema_version FROM pa_portal_projection_generation_contracts WHERE generation_id=?").bind(generation.id).first<number>("schema_version");
    if (contract !== delivery.schemaVersion) throw new Error("portal-generation-contract-conflict");
  }
  const page = await db.prepare("SELECT payload_hash FROM pa_portal_projection_pages WHERE generation_id=? AND page_number=?").bind(generation.id, delivery.pageNumber).first<{ payload_hash: string }>();
  if (page) {
    if (page.payload_hash !== payloadHash) throw new Error("portal-page-conflict");
    await db.batch([receiptStatement(db, delivery, payloadHash, "snapshot_page", "ignored"), auditStatement(db, delivery, "delivery_replayed", { pageNumber: delivery.pageNumber })]);
    return "ignored";
  }
  const recordCount = delivery.entities.length + delivery.principals.length + delivery.entitlements.length + delivery.relations.length + delivery.projectLifecycles.length;
  await db.batch([
    db.prepare("INSERT INTO pa_portal_projection_pages(generation_id,page_number,record_count,payload_hash) VALUES(?,?,?,?)").bind(generation.id, delivery.pageNumber, recordCount, payloadHash),
    ...delivery.entities.map(entity => db.prepare(`INSERT INTO pa_portal_projection_entities
      (generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(generation!.id, entity.type, entity.publicId, entity.parentPublicId, entity.displayName, entity.sourceVersion, entity.active ? 1 : 0, entity.primaryContact ? 1 : 0)),
    ...delivery.principals.map(principal => db.prepare(`INSERT INTO pa_portal_projection_principals
      (generation_id,public_id,email_hint,display_name,source_version,active) VALUES(?,?,?,?,?,?)`)
      .bind(generation!.id, principal.publicId, principal.emailHint, principal.displayName, principal.sourceVersion, principal.active ? 1 : 0)),
    ...delivery.entitlements.map(entitlement => db.prepare(`INSERT INTO pa_portal_projection_entitlements
      (generation_id,public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,active,valid_from,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(generation!.id, entitlement.publicId, entitlement.principalPublicId, entitlement.capability, entitlement.effect, entitlement.scopeType, entitlement.scopePublicId, entitlement.sourceVersion, entitlement.active ? 1 : 0, entitlement.validFrom, entitlement.expiresAt)),
    ...delivery.relations.map(relation => db.prepare(`INSERT INTO pa_portal_projection_relations
      (generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(generation!.id, relation.publicId, relation.relationType, relation.from.type, relation.from.publicId, relation.to.type, relation.to.publicId, relation.sourceVersion, relation.active ? 1 : 0)),
    ...delivery.projectLifecycles.map(lifecycle => db.prepare(`INSERT INTO pa_portal_projection_project_lifecycle
      (generation_id,project_public_id,lifecycle_status,completed_at,source_version) VALUES(?,?,?,?,?)`)
      .bind(generation!.id, lifecycle.projectPublicId, lifecycle.status, lifecycle.completedAt, lifecycle.sourceVersion)),
    receiptStatement(db, delivery, payloadHash, "snapshot_page"),
    auditStatement(db, delivery, "snapshot_page_staged", { pageNumber: delivery.pageNumber, pageCount: delivery.pageCount, recordCount }),
  ]);
  return "completed";
}

function validateDirectory(workspace: WorkspaceResource, entities: EntityResource[]): void {
  const ids = new Set<string>();
  const byId = new Map<string, EntityResource>();
  for (const entity of entities) {
    if (ids.has(entity.publicId)) throw new Error("portal-entity-public-id-conflict");
    ids.add(entity.publicId);
    byId.set(entity.publicId, entity);
  }
  const roots = entities.filter(entity => entity.type === workspace.rootType && entity.publicId === workspace.rootPublicId && entity.parentPublicId === null);
  if (roots.length !== 1 || roots[0]!.active !== workspace.active) throw new Error("portal-root-invalid");
  for (const entity of entities) {
    if (entity.publicId === workspace.rootPublicId) continue;
    if (!entity.parentPublicId || !byId.has(entity.parentPublicId)) throw new Error("portal-parent-invalid");
    const seen = new Set<string>([entity.publicId]);
    let current = entity;
    for (let depth = 0; current.parentPublicId !== null; depth += 1) {
      if (depth >= 8 || seen.has(current.parentPublicId)) throw new Error("portal-lineage-invalid");
      seen.add(current.parentPublicId);
      const parent = byId.get(current.parentPublicId);
      if (!parent) throw new Error("portal-parent-invalid");
      current = parent;
    }
    if (current.publicId !== workspace.rootPublicId) throw new Error("portal-lineage-invalid");
  }
}

function validateAuthorization(workspace: WorkspaceResource, entities: EntityResource[], principals: PrincipalResource[], entitlements: EntitlementResource[]): void {
  const principalIds = new Set(principals.map(principal => principal.publicId));
  const activePrincipalIds = new Set(principals.filter(principal => principal.active).map(principal => principal.publicId));
  const entityScopes = new Set(entities.filter(entity => entity.active).map(entity => `${entity.type}:${entity.publicId}`));
  for (const entitlement of entitlements) {
    if (!principalIds.has(entitlement.principalPublicId)) throw new Error("portal-entitlement-principal-invalid");
    if (!entitlement.active) continue;
    if (!activePrincipalIds.has(entitlement.principalPublicId)) throw new Error("portal-entitlement-principal-invalid");
    if (entitlement.scopeType === "workspace") {
      if (entitlement.scopePublicId !== workspace.publicId) throw new Error("portal-entitlement-scope-invalid");
    } else if (!entityScopes.has(`${entitlement.scopeType}:${entitlement.scopePublicId}`)) throw new Error("portal-entitlement-scope-invalid");
  }
}

function validateRelationsAndLifecycle(
  workspace: WorkspaceResource,
  entities: EntityResource[],
  relations: RelationResource[],
  lifecycles: ProjectLifecycleResource[],
  occurredAt: string,
): void {
  const activeEntities = new Set(entities.filter(entity => entity.active).map(entity => `${entity.type}:${entity.publicId}`));
  const relationIds = new Set<string>();
  const logicalEdges = new Set<string>();
  const parents = new Map<string, string[]>();
  for (const relation of relations) {
    if (relationIds.has(relation.publicId)) throw new Error("portal-relation-public-id-conflict");
    relationIds.add(relation.publicId);
    const logical = `${relation.relationType}:${relation.from.type}:${relation.from.publicId}:${relation.to.type}:${relation.to.publicId}`;
    if (logicalEdges.has(logical)) throw new Error("portal-relation-duplicate");
    logicalEdges.add(logical);
    if (!relation.active) continue;
    const from = `${relation.from.type}:${relation.from.publicId}`;
    const to = `${relation.to.type}:${relation.to.publicId}`;
    if (!activeEntities.has(from) || !activeEntities.has(to) || from === to) throw new Error("portal-relation-endpoint-invalid");
    if (!validRelationShape(relation)) throw new Error("portal-relation-shape-invalid");
    const incoming = parents.get(to) ?? [];
    incoming.push(from);
    parents.set(to, incoming);
  }

  const root = `${workspace.rootType}:${workspace.rootPublicId}`;
  function reachesRoot(start: string, path: Set<string>): boolean {
    if (start === root) return true;
    if (path.has(start) || path.size >= 12) throw new Error("portal-relation-cycle-invalid");
    const next = parents.get(start);
    if (!next?.length) return false;
    const nextPath = new Set(path); nextPath.add(start);
    return next.some(parent => reachesRoot(parent, nextPath));
  }
  for (const entity of activeEntities) {
    if (!reachesRoot(entity, new Set())) throw new Error("portal-relation-lineage-invalid");
  }

  const lifecycleByProject = new Map<string, ProjectLifecycleResource>();
  for (const lifecycle of lifecycles) {
    if (lifecycleByProject.has(lifecycle.projectPublicId)) throw new Error("portal-project-lifecycle-duplicate");
    if (!activeEntities.has(`project:${lifecycle.projectPublicId}`)) throw new Error("portal-project-lifecycle-project-invalid");
    if (lifecycle.completedAt && Date.parse(lifecycle.completedAt) > Date.parse(occurredAt) + MAX_CLOCK_SKEW_MS) throw new Error("portal-project-lifecycle-future-invalid");
    lifecycleByProject.set(lifecycle.projectPublicId, lifecycle);
  }
  for (const entity of entities) {
    if (entity.active && entity.type === "project" && !lifecycleByProject.has(entity.publicId)) throw new Error("portal-project-lifecycle-missing");
  }
}

async function stagedResources(db: D1Database, generationId: string, relationsEnabled: boolean): Promise<{ entities: EntityResource[]; principals: PrincipalResource[]; entitlements: EntitlementResource[]; relations: RelationResource[]; projectLifecycles: ProjectLifecycleResource[] }> {
  const entityRows = await db.prepare("SELECT entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact FROM pa_portal_projection_entities WHERE generation_id=?").bind(generationId).all<{ entity_type: EntityType; public_id: string; parent_public_id: string | null; display_name: string; source_version: string; active: number; primary_contact: number }>();
  const principalRows = await db.prepare("SELECT public_id,email_hint,display_name,source_version,active FROM pa_portal_projection_principals WHERE generation_id=?").bind(generationId).all<{ public_id: string; email_hint: string; display_name: string; source_version: string; active: number }>();
  const entitlementRows = await db.prepare("SELECT public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,active,valid_from,expires_at FROM pa_portal_projection_entitlements WHERE generation_id=?").bind(generationId).all<{ public_id: string; principal_public_id: string; capability: Capability; effect: "allow" | "deny"; scope_type: ScopeType; scope_public_id: string; source_version: string; active: number; valid_from: string; expires_at: string | null }>();
  const relationRows = relationsEnabled ? await db.prepare("SELECT public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active FROM pa_portal_projection_relations WHERE generation_id=?").bind(generationId).all<{ public_id: string; relation_type: RelationType; from_type: EntityType; from_public_id: string; to_type: EntityType; to_public_id: string; source_version: string; active: number }>() : { results: [] };
  const lifecycleRows = relationsEnabled ? await db.prepare("SELECT project_public_id,lifecycle_status,completed_at,source_version FROM pa_portal_projection_project_lifecycle WHERE generation_id=?").bind(generationId).all<{ project_public_id: string; lifecycle_status: "active" | "completed"; completed_at: string | null; source_version: string }>() : { results: [] };
  return {
    entities: entityRows.results.map(row => ({ type: row.entity_type, publicId: row.public_id, parentPublicId: row.parent_public_id, displayName: row.display_name, sourceVersion: row.source_version, active: row.active === 1, primaryContact: row.primary_contact === 1 })),
    principals: principalRows.results.map(row => ({ publicId: row.public_id, emailHint: row.email_hint, displayName: row.display_name, sourceVersion: row.source_version, active: row.active === 1 })),
    entitlements: entitlementRows.results.map(row => ({ publicId: row.public_id, principalPublicId: row.principal_public_id, capability: row.capability, effect: row.effect, scopeType: row.scope_type, scopePublicId: row.scope_public_id, sourceVersion: row.source_version, active: row.active === 1, validFrom: row.valid_from, expiresAt: row.expires_at })),
    relations: relationRows.results.map(row => ({ publicId: row.public_id, relationType: row.relation_type, from: { type: row.from_type, publicId: row.from_public_id }, to: { type: row.to_type, publicId: row.to_public_id }, sourceVersion: row.source_version, active: row.active === 1 })),
    projectLifecycles: lifecycleRows.results.map(row => ({ projectPublicId: row.project_public_id, status: row.lifecycle_status, completedAt: row.completed_at, sourceVersion: row.source_version })),
  };
}

function authorizationRefreshStatements(db: D1Database, workspaceId: string, sourceSequence: number): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE portal_v2_workspace_memberships SET status='suspended',updated_at=datetime('now') WHERE workspace_id=? AND source_type='project_alpha'").bind(workspaceId),
    db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
      SELECT 'pa-membership:' || p.workspace_id || ':' || p.public_id,p.workspace_id,p.identity_id,'project_alpha','active',p.source_version
      FROM pa_portal_principals p JOIN portal_v2_identities i ON i.id=p.identity_id AND i.status='active' AND i.revoked_at IS NULL AND lower(i.verified_email)=lower(p.email_hint)
      WHERE p.workspace_id=? AND p.status='active' AND p.identity_id IS NOT NULL
      ON CONFLICT(workspace_id,identity_id) DO UPDATE SET status='active',source_version=excluded.source_version,revoked_at=NULL,updated_at=datetime('now') WHERE portal_v2_workspace_memberships.source_type='project_alpha'`).bind(workspaceId),
    db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND source_type='project_alpha' AND status<>'revoked'").bind(workspaceId),
    db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,source_version,status,valid_from,expires_at)
      SELECT 'pa-entitlement:' || intent.workspace_id || ':' || intent.public_id,intent.workspace_id,principal.identity_id,intent.capability,intent.effect,intent.scope_type,intent.scope_public_id,?,'project_alpha',intent.source_version,'active',intent.valid_from,intent.expires_at
      FROM pa_portal_entitlement_intents intent
      JOIN pa_portal_principals principal ON principal.workspace_id=intent.workspace_id AND principal.public_id=intent.principal_public_id AND principal.status='active' AND principal.identity_id IS NOT NULL
      JOIN portal_v2_identities identity ON identity.id=principal.identity_id AND identity.status='active' AND identity.revoked_at IS NULL AND lower(identity.verified_email)=lower(principal.email_hint)
      JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=intent.workspace_id AND membership.identity_id=principal.identity_id AND membership.status='active' AND membership.source_type='project_alpha'
      WHERE intent.workspace_id=? AND intent.status='active'
      ON CONFLICT(id) DO UPDATE SET identity_id=excluded.identity_id,capability=excluded.capability,effect=excluded.effect,scope_type=excluded.scope_type,scope_public_id=excluded.scope_public_id,entitlement_version=excluded.entitlement_version,source_version=excluded.source_version,status='active',valid_from=excluded.valid_from,expires_at=excluded.expires_at,revoked_at=NULL`).bind(sourceSequence, workspaceId),
  ];
}

async function activateSnapshot(env: Env, delivery: SnapshotActivateDelivery, payloadHash: string): Promise<"completed" | "ignored"> {
  const db = database(env);
  const contractTablePresent = await directoryContractTablePresent(db);
  const generation = await db.prepare("SELECT * FROM pa_portal_projection_generations WHERE workspace_id=? AND source_generation=?").bind(delivery.workspaceId, delivery.sourceGeneration).first<ProjectionGenerationRow>();
  if (!generation || generation.source_sequence !== delivery.sourceSequence || generation.snapshot_hash !== delivery.snapshotHash || generation.page_count !== delivery.pageCount || generation.record_count !== delivery.recordCount) throw new Error("portal-generation-incomplete");
  if (env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true") {
    const contract = await db.prepare("SELECT schema_version FROM pa_portal_projection_generation_contracts WHERE generation_id=?").bind(generation.id).first<number>("schema_version");
    if ((contract ?? 2) !== delivery.schemaVersion) throw new Error("portal-generation-contract-conflict");
  }
  const checkpoint = await db.prepare("SELECT source_generation,source_sequence,snapshot_generation_id FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(delivery.workspaceId).first<{ source_generation: string; source_sequence: number; snapshot_generation_id: string }>();
  if (checkpoint?.source_sequence === delivery.sourceSequence && checkpoint.snapshot_generation_id === generation.id && generation.status === "active") {
    await db.batch([receiptStatement(db, delivery, payloadHash, "snapshot_activate", "ignored"), auditStatement(db, delivery, "delivery_replayed", {})]);
    return "ignored";
  }
  if ((checkpoint && delivery.sourceSequence <= checkpoint.source_sequence) || generation.status !== "staging") throw new Error("portal-snapshot-stale");
  const pages = await db.prepare("SELECT COUNT(*) count,COALESCE(SUM(record_count),0) records,MIN(page_number) min_page,MAX(page_number) max_page FROM pa_portal_projection_pages WHERE generation_id=?").bind(generation.id).first<{ count: number; records: number; min_page: number | null; max_page: number | null }>();
  if (!pages || pages.count !== delivery.pageCount || pages.records !== delivery.recordCount || pages.min_page !== 1 || pages.max_page !== delivery.pageCount) throw new Error("portal-generation-incomplete");
  const resources = await stagedResources(db, generation.id, delivery.schemaVersion === 3);
  if (resources.entities.length + resources.principals.length + resources.entitlements.length + resources.relations.length + resources.projectLifecycles.length !== delivery.recordCount) throw new Error("portal-generation-incomplete");
  const workspace: WorkspaceResource = { publicId: generation.workspace_id, rootType: generation.workspace_root_type, rootPublicId: generation.workspace_root_public_id, displayName: generation.workspace_display_name, sourceVersion: generation.workspace_source_version, active: generation.workspace_active === 1 };
  validateDirectory(workspace, resources.entities);
  validateAuthorization(workspace, resources.entities, resources.principals, resources.entitlements);
  if (delivery.schemaVersion === 3) validateRelationsAndLifecycle(workspace, resources.entities, resources.relations, resources.projectLifecycles, delivery.occurredAt);
  const existingWorkspace = await db.prepare("SELECT root_type,pa_organization_public_id,pa_client_public_id FROM portal_v2_workspaces WHERE id=?").bind(workspace.publicId).first<{ root_type: WorkspaceResource["rootType"]; pa_organization_public_id: string | null; pa_client_public_id: string | null }>();
  if (existingWorkspace && (existingWorkspace.root_type !== workspace.rootType || (existingWorkspace.pa_organization_public_id ?? existingWorkspace.pa_client_public_id) !== workspace.rootPublicId)) throw new Error("portal-workspace-reparent-denied");
  const directoryGenerationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,status=excluded.status,updated_at=datetime('now')
      WHERE portal_v2_workspaces.root_type=excluded.root_type AND COALESCE(portal_v2_workspaces.pa_organization_public_id,'')=COALESCE(excluded.pa_organization_public_id,'') AND COALESCE(portal_v2_workspaces.pa_client_public_id,'')=COALESCE(excluded.pa_client_public_id,'')`)
      .bind(workspace.publicId, workspace.rootType, workspace.rootType === "organization" ? workspace.rootPublicId : null, workspace.rootType === "standalone_client" ? workspace.rootPublicId : null, workspace.displayName, workspace.active ? "active" : "suspended"),
    db.prepare("UPDATE portal_v2_directory_generations SET status='superseded' WHERE workspace_id=? AND status='active'").bind(workspace.publicId),
    db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
      VALUES(?,?,?,?,'active',1,datetime('now'))`).bind(directoryGenerationId, workspace.publicId, delivery.sourceGeneration, delivery.sourceSequence),
    ...(contractTablePresent ? [
      db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES (?,?,?)")
        .bind(directoryGenerationId, workspace.publicId, delivery.schemaVersion),
    ] : []),
    db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact)
      SELECT ?,?,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact FROM pa_portal_projection_entities WHERE generation_id=?`)
      .bind(workspace.publicId, directoryGenerationId, generation.id),
    ...resources.relations.map(relation => db.prepare(`INSERT INTO portal_v2_directory_relations
      (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(workspace.publicId, directoryGenerationId, relation.publicId, relation.relationType, relation.from.type, relation.from.publicId, relation.to.type, relation.to.publicId, relation.sourceVersion, relation.active ? 1 : 0)),
    ...resources.projectLifecycles.map(lifecycle => db.prepare(`INSERT INTO portal_v2_project_lifecycle
      (workspace_id,generation_id,project_public_id,lifecycle_status,completed_at,source_version)
      VALUES (?,?,?,?,?,?)`).bind(workspace.publicId, directoryGenerationId, lifecycle.projectPublicId, lifecycle.status, lifecycle.completedAt, lifecycle.sourceVersion)),
    db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET active_generation_id=excluded.active_generation_id,source_sequence=excluded.source_sequence,updated_at=datetime('now')`)
      .bind(workspace.publicId, directoryGenerationId, delivery.sourceSequence),
    db.prepare("UPDATE pa_portal_principals SET status='suspended',updated_at=datetime('now') WHERE workspace_id=?").bind(workspace.publicId),
    db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
      SELECT ?,public_id,email_hint,display_name,source_version,CASE active WHEN 1 THEN 'active' ELSE 'suspended' END FROM pa_portal_projection_principals WHERE generation_id=?
      ON CONFLICT(workspace_id,public_id) DO UPDATE SET email_hint=excluded.email_hint,display_name=excluded.display_name,source_version=excluded.source_version,status=excluded.status,updated_at=datetime('now')`)
      .bind(workspace.publicId, generation.id),
    db.prepare("UPDATE pa_portal_entitlement_intents SET status='suspended',updated_at=datetime('now') WHERE workspace_id=?").bind(workspace.publicId),
    db.prepare(`INSERT INTO pa_portal_entitlement_intents(workspace_id,public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,status,valid_from,expires_at)
      SELECT ?,public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,CASE active WHEN 1 THEN 'active' ELSE 'suspended' END,valid_from,expires_at FROM pa_portal_projection_entitlements WHERE generation_id=?
      ON CONFLICT(workspace_id,public_id) DO UPDATE SET principal_public_id=excluded.principal_public_id,capability=excluded.capability,effect=excluded.effect,scope_type=excluded.scope_type,scope_public_id=excluded.scope_public_id,source_version=excluded.source_version,status=excluded.status,valid_from=excluded.valid_from,expires_at=excluded.expires_at,updated_at=datetime('now')`)
      .bind(workspace.publicId, generation.id),
    ...authorizationRefreshStatements(db, workspace.publicId, delivery.sourceSequence),
    db.prepare("UPDATE pa_portal_projection_generations SET status='superseded' WHERE workspace_id=? AND status='active' AND id<>?").bind(workspace.publicId, generation.id),
    db.prepare("UPDATE pa_portal_projection_generations SET status='active',complete=1,activated_at=datetime('now') WHERE id=? AND status='staging'").bind(generation.id),
    db.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id) VALUES(?,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET source_generation=excluded.source_generation,source_sequence=excluded.source_sequence,snapshot_generation_id=excluded.snapshot_generation_id,updated_at=datetime('now')`)
      .bind(workspace.publicId, delivery.sourceGeneration, delivery.sourceSequence, generation.id),
    receiptStatement(db, delivery, payloadHash, "snapshot_activate"),
    auditStatement(db, delivery, "snapshot_activated", { pageCount: delivery.pageCount, recordCount: delivery.recordCount }),
  ];
  await db.batch(statements);
  const updated = await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first("source_sequence");
  if (updated !== delivery.sourceSequence) throw new Error("portal-activation-conflict");
  return "completed";
}

async function loadActiveResources(db: D1Database, workspaceId: string, relationsEnabled: boolean): Promise<{ workspace: WorkspaceResource; entities: EntityResource[]; principals: PrincipalResource[]; entitlements: EntitlementResource[]; relations: RelationResource[]; projectLifecycles: ProjectLifecycleResource[]; directoryGenerationId: string }> {
  const workspace = await db.prepare("SELECT root_type,pa_organization_public_id,pa_client_public_id,display_name,status FROM portal_v2_workspaces WHERE id=?").bind(workspaceId).first<{ root_type: WorkspaceResource["rootType"]; pa_organization_public_id: string | null; pa_client_public_id: string | null; display_name: string; status: string }>();
  const checkpoint = await db.prepare("SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?").bind(workspaceId).first<{ active_generation_id: string }>();
  if (!workspace || !checkpoint) throw new Error("portal-event-baseline-missing");
  const rows = await db.prepare("SELECT entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=?").bind(workspaceId, checkpoint.active_generation_id).all<{ entity_type: EntityType; public_id: string; parent_public_id: string | null; display_name: string; source_version: string; active: number; primary_contact: number }>();
  const principalRows = await db.prepare("SELECT public_id,email_hint,display_name,source_version,status FROM pa_portal_principals WHERE workspace_id=?").bind(workspaceId).all<{ public_id: string; email_hint: string; display_name: string; source_version: string; status: string }>();
  const entitlementRows = await db.prepare("SELECT public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,status,valid_from,expires_at FROM pa_portal_entitlement_intents WHERE workspace_id=?").bind(workspaceId).all<{ public_id: string; principal_public_id: string; capability: Capability; effect: "allow" | "deny"; scope_type: ScopeType; scope_public_id: string; source_version: string; status: string; valid_from: string; expires_at: string | null }>();
  const relationRows = relationsEnabled ? await db.prepare("SELECT public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active FROM portal_v2_directory_relations WHERE workspace_id=? AND generation_id=?").bind(workspaceId, checkpoint.active_generation_id).all<{ public_id: string; relation_type: RelationType; from_type: EntityType; from_public_id: string; to_type: EntityType; to_public_id: string; source_version: string; active: number }>() : { results: [] };
  const lifecycleRows = relationsEnabled ? await db.prepare("SELECT project_public_id,lifecycle_status,completed_at,source_version FROM portal_v2_project_lifecycle WHERE workspace_id=? AND generation_id=?").bind(workspaceId, checkpoint.active_generation_id).all<{ project_public_id: string; lifecycle_status: "active" | "completed"; completed_at: string | null; source_version: string }>() : { results: [] };
  return {
    workspace: { publicId: workspaceId, rootType: workspace.root_type, rootPublicId: workspace.pa_organization_public_id ?? workspace.pa_client_public_id!, displayName: workspace.display_name, sourceVersion: "event-baseline", active: workspace.status === "active" },
    directoryGenerationId: checkpoint.active_generation_id,
    entities: rows.results.map(row => ({ type: row.entity_type, publicId: row.public_id, parentPublicId: row.parent_public_id, displayName: row.display_name, sourceVersion: row.source_version, active: row.active === 1, primaryContact: row.primary_contact === 1 })),
    principals: principalRows.results.map(row => ({ publicId: row.public_id, emailHint: row.email_hint, displayName: row.display_name, sourceVersion: row.source_version, active: row.status === "active" })),
    entitlements: entitlementRows.results.map(row => ({ publicId: row.public_id, principalPublicId: row.principal_public_id, capability: row.capability, effect: row.effect, scopeType: row.scope_type, scopePublicId: row.scope_public_id, sourceVersion: row.source_version, active: row.status === "active", validFrom: row.valid_from, expiresAt: row.expires_at })),
    relations: relationRows.results.map(row => ({ publicId: row.public_id, relationType: row.relation_type, from: { type: row.from_type, publicId: row.from_public_id }, to: { type: row.to_type, publicId: row.to_public_id }, sourceVersion: row.source_version, active: row.active === 1 })),
    projectLifecycles: lifecycleRows.results.map(row => ({ projectPublicId: row.project_public_id, status: row.lifecycle_status, completedAt: row.completed_at, sourceVersion: row.source_version })),
  };
}

interface EventClosure {
  workspace: boolean;
  sourceVersion: string;
  entityIds: Set<string>;
  relationIds: Set<string>;
  projectLifecycleIds: Set<string>;
  entitlementIds: Set<string>;
}

function closeRelationStateForTombstone(
  current: Awaited<ReturnType<typeof loadActiveResources>>,
  targetPublicId: string | null,
  sourceVersion: string,
): EventClosure {
  const closure: EventClosure = {
    workspace: targetPublicId === null,
    sourceVersion,
    entityIds: new Set(),
    relationIds: new Set(),
    projectLifecycleIds: new Set(),
    entitlementIds: new Set(),
  };
  const closeEntity = (entity: EntityResource): void => {
    if (!entity.active) return;
    entity.active = false;
    entity.sourceVersion = sourceVersion;
    closure.entityIds.add(entity.publicId);
  };
  const closeRelation = (relation: RelationResource): void => {
    if (!relation.active) return;
    relation.active = false;
    relation.sourceVersion = sourceVersion;
    closure.relationIds.add(relation.publicId);
  };

  if (closure.workspace) {
    current.workspace.active = false;
    current.entities.forEach(closeEntity);
    current.principals.forEach(principal => {
      principal.active = false;
      principal.sourceVersion = sourceVersion;
    });
  } else {
    const target = current.entities.find(entity => entity.publicId === targetPublicId);
    if (!target || target.publicId === current.workspace.rootPublicId) throw new Error("portal-event-target-invalid");
    closeEntity(target);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const activeEntities = new Set(current.entities.filter(entity => entity.active).map(entity => `${entity.type}:${entity.publicId}`));
    for (const relation of current.relations) {
      if (!relation.active) continue;
      const from = `${relation.from.type}:${relation.from.publicId}`;
      const to = `${relation.to.type}:${relation.to.publicId}`;
      if (!activeEntities.has(from) || !activeEntities.has(to)) {
        closeRelation(relation);
        changed = true;
      }
    }
    const parents = new Map<string, string[]>();
    for (const relation of current.relations) {
      if (!relation.active) continue;
      const to = `${relation.to.type}:${relation.to.publicId}`;
      const incoming = parents.get(to) ?? [];
      incoming.push(`${relation.from.type}:${relation.from.publicId}`);
      parents.set(to, incoming);
    }
    const root = `${current.workspace.rootType}:${current.workspace.rootPublicId}`;
    const reachesRoot = (start: string, path: Set<string>): boolean => {
      if (start === root) return activeEntities.has(root);
      if (path.has(start) || path.size >= 12) return false;
      const nextPath = new Set(path); nextPath.add(start);
      return (parents.get(start) ?? []).some(parent => reachesRoot(parent, nextPath));
    };
    for (const entity of current.entities) {
      if (!entity.active || reachesRoot(`${entity.type}:${entity.publicId}`, new Set())) continue;
      closeEntity(entity);
      changed = true;
    }
  }

  const activeEntityScopes = new Set(current.entities.filter(entity => entity.active).map(entity => `${entity.type}:${entity.publicId}`));
  current.projectLifecycles = current.projectLifecycles.filter(lifecycle => {
    if (activeEntityScopes.has(`project:${lifecycle.projectPublicId}`)) return true;
    closure.projectLifecycleIds.add(lifecycle.projectPublicId);
    return false;
  });
  for (const entitlement of current.entitlements) {
    if (!entitlement.active) continue;
    const scopeActive = entitlement.scopeType === "workspace"
      ? !closure.workspace
      : activeEntityScopes.has(`${entitlement.scopeType}:${entitlement.scopePublicId}`);
    if (scopeActive) continue;
    entitlement.active = false;
    entitlement.sourceVersion = sourceVersion;
    closure.entitlementIds.add(entitlement.publicId);
  }
  return closure;
}

async function applyEvent(env: Env, delivery: EventDelivery, payloadHash: string): Promise<"completed"> {
  const db = database(env);
  const checkpoint = await db.prepare("SELECT source_generation,source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(delivery.workspaceId).first<{ source_generation: string; source_sequence: number }>();
  if (!checkpoint || checkpoint.source_generation !== delivery.sourceGeneration) throw new Error("portal-event-generation-mismatch");
  if (delivery.sourceSequence !== checkpoint.source_sequence + 1) throw new Error("portal-event-sequence-gap");
  const relationsEnabled = env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true";
  const activeContract = await activeDirectoryContract(db, delivery.workspaceId);
  const activeSchemaVersion = activeContract.schemaVersion;
  if (activeSchemaVersion === 3 && !relationsEnabled) throw new Error("portal-relation-contract-disabled");
  if (delivery.schemaVersion !== activeSchemaVersion) throw new Error("portal-event-schema-mismatch");
  const relationContractActive = activeSchemaVersion === 3;
  const current = await loadActiveResources(db, delivery.workspaceId, relationContractActive);
  const event = delivery.event;
  let closure: EventClosure | null = null;
  if (event.action === "upsert") {
    if (event.resource === "workspace") {
      if (event.workspace.publicId !== delivery.workspaceId || event.workspace.rootType !== current.workspace.rootType || event.workspace.rootPublicId !== current.workspace.rootPublicId) throw new Error("portal-workspace-reparent-denied");
      current.workspace = event.workspace;
    } else if (event.resource === "entity") {
      const index = current.entities.findIndex(entity => entity.publicId === event.entity.publicId);
      if (index >= 0 && current.entities[index]!.type !== event.entity.type) throw new Error("portal-entity-type-conflict");
      if (index >= 0) current.entities[index] = event.entity; else current.entities.push(event.entity);
    } else if (event.resource === "principal") {
      const index = current.principals.findIndex(principal => principal.publicId === event.principal.publicId);
      if (index >= 0) current.principals[index] = event.principal; else current.principals.push(event.principal);
    } else if (event.resource === "entitlement") {
      const index = current.entitlements.findIndex(entitlement => entitlement.publicId === event.entitlement.publicId);
      if (index >= 0) current.entitlements[index] = event.entitlement; else current.entitlements.push(event.entitlement);
    } else if (event.resource === "relation") {
      const index = current.relations.findIndex(relation => relation.publicId === event.relation.publicId);
      if (index >= 0) current.relations[index] = event.relation; else current.relations.push(event.relation);
    } else {
      const index = current.projectLifecycles.findIndex(lifecycle => lifecycle.projectPublicId === event.projectLifecycle.projectPublicId);
      if (index >= 0) current.projectLifecycles[index] = event.projectLifecycle; else current.projectLifecycles.push(event.projectLifecycle);
    }
  } else {
    if (event.resource === "workspace") {
      if (event.publicId !== delivery.workspaceId) throw new Error("portal-workspace-mismatch");
      if (relationContractActive) closure = closeRelationStateForTombstone(current, null, event.sourceVersion);
      else {
        current.workspace.active = false;
        const root = current.entities.find(entity => entity.publicId === current.workspace.rootPublicId);
        if (root) root.active = false;
      }
    } else if (event.resource === "entity") {
      const entity = current.entities.find(candidate => candidate.publicId === event.publicId);
      if (!entity || entity.publicId === current.workspace.rootPublicId) throw new Error("portal-event-target-invalid");
      if (relationContractActive) closure = closeRelationStateForTombstone(current, event.publicId, event.sourceVersion);
      else {
        entity.active = false;
        entity.sourceVersion = event.sourceVersion;
      }
    } else if (event.resource === "principal") {
      const principal = current.principals.find(candidate => candidate.publicId === event.publicId);
      if (!principal) throw new Error("portal-event-target-invalid");
      principal.active = false;
      principal.sourceVersion = event.sourceVersion;
      current.entitlements.filter(entitlement => entitlement.principalPublicId === event.publicId).forEach(entitlement => { entitlement.active = false; });
    } else if (event.resource === "entitlement") {
      const entitlement = current.entitlements.find(candidate => candidate.publicId === event.publicId);
      if (!entitlement) throw new Error("portal-event-target-invalid");
      entitlement.active = false;
      entitlement.sourceVersion = event.sourceVersion;
    } else {
      const relation = current.relations.find(candidate => candidate.publicId === event.publicId);
      if (!relation) throw new Error("portal-event-target-invalid");
      relation.active = false;
      relation.sourceVersion = event.sourceVersion;
    }
  }
  validateDirectory(current.workspace, current.entities);
  validateAuthorization(current.workspace, current.entities, current.principals, current.entitlements);
  if (relationContractActive) validateRelationsAndLifecycle(current.workspace, current.entities, current.relations, current.projectLifecycles, delivery.occurredAt);
  const directoryGenerationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE portal_v2_directory_generations SET status='superseded' WHERE workspace_id=? AND status='active'").bind(delivery.workspaceId),
    db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at) VALUES(?,?,?,?,'active',1,datetime('now'))`)
      .bind(directoryGenerationId, delivery.workspaceId, `event-${delivery.deliveryId}`, delivery.sourceSequence),
    ...(activeContract.tablePresent ? [
      db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES (?,?,?)")
        .bind(directoryGenerationId, delivery.workspaceId, activeSchemaVersion),
    ] : []),
    db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact)
      SELECT workspace_id,?,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=?`)
      .bind(directoryGenerationId, delivery.workspaceId, current.directoryGenerationId),
    ...(relationContractActive ? [
      db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        SELECT workspace_id,?,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active
        FROM portal_v2_directory_relations WHERE workspace_id=? AND generation_id=?`)
        .bind(directoryGenerationId, delivery.workspaceId, current.directoryGenerationId),
      db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,completed_at,source_version)
        SELECT workspace_id,?,project_public_id,lifecycle_status,completed_at,source_version
        FROM portal_v2_project_lifecycle WHERE workspace_id=? AND generation_id=?`)
        .bind(directoryGenerationId, delivery.workspaceId, current.directoryGenerationId),
    ] : []),
  ];
  if (closure?.entityIds.size) statements.push(db.prepare(`UPDATE portal_v2_directory_entities
    SET active=0,source_version=? WHERE workspace_id=? AND generation_id=?
      AND public_id IN (SELECT value FROM json_each(?))`)
    .bind(closure.sourceVersion, delivery.workspaceId, directoryGenerationId, JSON.stringify([...closure.entityIds])));
  if (closure?.relationIds.size) statements.push(db.prepare(`UPDATE portal_v2_directory_relations
    SET active=0,source_version=? WHERE workspace_id=? AND generation_id=?
      AND public_id IN (SELECT value FROM json_each(?))`)
    .bind(closure.sourceVersion, delivery.workspaceId, directoryGenerationId, JSON.stringify([...closure.relationIds])));
  if (closure?.projectLifecycleIds.size) statements.push(db.prepare(`DELETE FROM portal_v2_project_lifecycle
    WHERE workspace_id=? AND generation_id=? AND project_public_id IN (SELECT value FROM json_each(?))`)
    .bind(delivery.workspaceId, directoryGenerationId, JSON.stringify([...closure.projectLifecycleIds])));
  if (closure?.entitlementIds.size) statements.push(db.prepare(`UPDATE pa_portal_entitlement_intents
    SET status='suspended',source_version=?,updated_at=datetime('now') WHERE workspace_id=?
      AND public_id IN (SELECT value FROM json_each(?))`)
    .bind(closure.sourceVersion, delivery.workspaceId, JSON.stringify([...closure.entitlementIds])));
  if (closure?.workspace) statements.push(
    db.prepare("UPDATE pa_portal_principals SET status='suspended',source_version=?,updated_at=datetime('now') WHERE workspace_id=?")
      .bind(closure.sourceVersion, delivery.workspaceId),
    db.prepare("UPDATE pa_portal_entitlement_intents SET status='suspended',source_version=?,updated_at=datetime('now') WHERE workspace_id=?")
      .bind(closure.sourceVersion, delivery.workspaceId),
  );
  if (event.action === "upsert" && event.resource === "entity") statements.push(db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,generation_id,entity_type,public_id) DO UPDATE SET parent_public_id=excluded.parent_public_id,display_name=excluded.display_name,source_version=excluded.source_version,active=excluded.active,primary_contact=excluded.primary_contact`)
    .bind(delivery.workspaceId, directoryGenerationId, event.entity.type, event.entity.publicId, event.entity.parentPublicId, event.entity.displayName, event.entity.sourceVersion, event.entity.active ? 1 : 0, event.entity.primaryContact ? 1 : 0));
  if (!closure && event.action === "tombstone" && event.resource === "entity") statements.push(db.prepare("UPDATE portal_v2_directory_entities SET active=0,source_version=? WHERE workspace_id=? AND generation_id=? AND public_id=?").bind(event.sourceVersion, delivery.workspaceId, directoryGenerationId, event.publicId));
  if (event.action === "upsert" && event.resource === "relation") statements.push(db.prepare(`INSERT INTO portal_v2_directory_relations
    (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,generation_id,public_id) DO UPDATE SET
      relation_type=excluded.relation_type,from_type=excluded.from_type,from_public_id=excluded.from_public_id,
      to_type=excluded.to_type,to_public_id=excluded.to_public_id,source_version=excluded.source_version,active=excluded.active`)
    .bind(delivery.workspaceId, directoryGenerationId, event.relation.publicId, event.relation.relationType, event.relation.from.type, event.relation.from.publicId, event.relation.to.type, event.relation.to.publicId, event.relation.sourceVersion, event.relation.active ? 1 : 0));
  if (event.action === "tombstone" && event.resource === "relation") statements.push(db.prepare("UPDATE portal_v2_directory_relations SET active=0,source_version=? WHERE workspace_id=? AND generation_id=? AND public_id=?").bind(event.sourceVersion, delivery.workspaceId, directoryGenerationId, event.publicId));
  if (event.action === "upsert" && event.resource === "project_lifecycle") statements.push(db.prepare(`INSERT INTO portal_v2_project_lifecycle
    (workspace_id,generation_id,project_public_id,lifecycle_status,completed_at,source_version)
    VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,generation_id,project_public_id) DO UPDATE SET
      lifecycle_status=excluded.lifecycle_status,completed_at=excluded.completed_at,source_version=excluded.source_version`)
    .bind(delivery.workspaceId, directoryGenerationId, event.projectLifecycle.projectPublicId, event.projectLifecycle.status, event.projectLifecycle.completedAt, event.projectLifecycle.sourceVersion));
  if (event.resource === "workspace") {
    statements.push(db.prepare("UPDATE portal_v2_workspaces SET display_name=?,status=?,updated_at=datetime('now') WHERE id=?").bind(current.workspace.displayName, current.workspace.active ? "active" : "suspended", delivery.workspaceId));
    if (!closure && !current.workspace.active) statements.push(db.prepare("UPDATE portal_v2_directory_entities SET active=0 WHERE workspace_id=? AND generation_id=? AND public_id=?").bind(delivery.workspaceId, directoryGenerationId, current.workspace.rootPublicId));
  }
  if (event.resource === "principal") {
    if (event.action === "upsert") statements.push(db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status) VALUES(?,?,?,?,?,?)
      ON CONFLICT(workspace_id,public_id) DO UPDATE SET email_hint=excluded.email_hint,display_name=excluded.display_name,source_version=excluded.source_version,status=excluded.status,updated_at=datetime('now')`)
      .bind(delivery.workspaceId, event.principal.publicId, event.principal.emailHint, event.principal.displayName, event.principal.sourceVersion, event.principal.active ? "active" : "suspended"));
    else statements.push(db.prepare("UPDATE pa_portal_principals SET status='revoked',source_version=?,updated_at=datetime('now') WHERE workspace_id=? AND public_id=?").bind(event.sourceVersion, delivery.workspaceId, event.publicId));
  }
  if (event.resource === "entitlement") {
    if (event.action === "upsert") statements.push(db.prepare(`INSERT INTO pa_portal_entitlement_intents(workspace_id,public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,status,valid_from,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,public_id) DO UPDATE SET principal_public_id=excluded.principal_public_id,capability=excluded.capability,effect=excluded.effect,scope_type=excluded.scope_type,scope_public_id=excluded.scope_public_id,source_version=excluded.source_version,status=excluded.status,valid_from=excluded.valid_from,expires_at=excluded.expires_at,updated_at=datetime('now')`)
      .bind(delivery.workspaceId, event.entitlement.publicId, event.entitlement.principalPublicId, event.entitlement.capability, event.entitlement.effect, event.entitlement.scopeType, event.entitlement.scopePublicId, event.entitlement.sourceVersion, event.entitlement.active ? "active" : "suspended", event.entitlement.validFrom, event.entitlement.expiresAt));
    else statements.push(db.prepare("UPDATE pa_portal_entitlement_intents SET status='revoked',source_version=?,updated_at=datetime('now') WHERE workspace_id=? AND public_id=?").bind(event.sourceVersion, delivery.workspaceId, event.publicId));
  }
  if (event.action === "tombstone" && event.resource === "principal") statements.push(db.prepare("UPDATE pa_portal_entitlement_intents SET status='suspended',updated_at=datetime('now') WHERE workspace_id=? AND principal_public_id=?").bind(delivery.workspaceId, event.publicId));
  statements.push(
    ...authorizationRefreshStatements(db, delivery.workspaceId, delivery.sourceSequence),
    db.prepare(`UPDATE portal_v2_directory_checkpoints SET active_generation_id=?,source_sequence=?,updated_at=datetime('now') WHERE workspace_id=? AND source_sequence=?`)
      .bind(directoryGenerationId, delivery.sourceSequence, delivery.workspaceId, checkpoint.source_sequence),
    db.prepare("UPDATE pa_portal_projection_checkpoints SET source_sequence=?,updated_at=datetime('now') WHERE workspace_id=? AND source_generation=? AND source_sequence=?")
      .bind(delivery.sourceSequence, delivery.workspaceId, delivery.sourceGeneration, checkpoint.source_sequence),
    receiptStatement(db, delivery, payloadHash, "event"),
    auditStatement(db, delivery, event.action === "upsert" ? "event_upserted" : "event_tombstoned", { resource: event.resource }),
  );
  await db.batch(statements);
  const updated = await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(delivery.workspaceId).first("source_sequence");
  if (updated !== delivery.sourceSequence) throw new Error("portal-event-conflict");
  return "completed";
}

async function processDelivery(env: Env, delivery: PortalProjectionDelivery, payloadHash: string): Promise<"completed" | "ignored" | "duplicate"> {
  const db = database(env);
  const duplicate = await existingReceipt(db, delivery.deliveryId, payloadHash);
  if (duplicate) return duplicate;
  try {
    if (delivery.kind === "snapshot.page") return await stageSnapshotPage(env, delivery, payloadHash);
    if (delivery.kind === "snapshot.activate") return await activateSnapshot(env, delivery, payloadHash);
    return await applyEvent(env, delivery, payloadHash);
  } catch (error) {
    const raced = await existingReceipt(db, delivery.deliveryId, payloadHash);
    if (raced) return raced;
    throw error;
  }
}

function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : "portal-internal-error";
  if (message.includes("access") || message.includes("signature") || message.includes("timestamp")) return 401;
  if (message.includes("conflict") || message.includes("stale") || message.includes("sequence") || message.includes("generation") || message.includes("reparent")) return 409;
  if (message.includes("size")) return 413;
  if (message.startsWith("portal-")) return 422;
  return 500;
}

function projectionConfigurationReady(env: Env): boolean {
  if (env.PROJECT_ALPHA_PORTAL_SYNC_ENABLED !== "true") return false;
  if (!env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY || !SAFE_ID.test(env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY)) return false;
  if (!env.PROJECT_ALPHA_PORTAL_HMAC_SECRET || env.PROJECT_ALPHA_PORTAL_HMAC_SECRET.length < 32) return false;
  if (!env.PROJECT_ALPHA_PORTAL_ACCESS_AUD || env.PROJECT_ALPHA_PORTAL_ACCESS_AUD.length > 512) return false;
  try {
    const team = new URL(env.PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN ?? "");
    return team.protocol === "https:" && team.pathname === "/" && !team.username && !team.password && !team.search && !team.hash;
  } catch {
    return false;
  }
}

export async function handleProjectAlphaPortalProjectionRequest(request: Request, env: Env, accessVerifier: AccessVerifier = verifyPortalProjectionAccessAssertion): Promise<Response> {
  if (!projectionConfigurationReady(env)) return json(404, { error: "not-found" });
  try {
    if (request.method !== "POST") return json(404, { error: "not-found" });
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json(415, { error: "content-type-required" });
    await accessVerifier(request, env);
    const rawBody = await readBoundedRequestBody(request, MAX_BODY_BYTES);
    if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_BODY_BYTES) throw new Error("portal-size-invalid");
    const timestamp = request.headers.get("X-PA-Timestamp");
    if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || Math.abs(Date.now() - Date.parse(timestamp)) > MAX_CLOCK_SKEW_MS) throw new Error("portal-timestamp-invalid");
    await verifyHmac(rawBody, timestamp, request.headers.get("X-PA-Signature"), env.PROJECT_ALPHA_PORTAL_HMAC_SECRET);
    const parsed = parsePortalProjectionDelivery(
      JSON.parse(new TextDecoder().decode(rawBody)) as unknown,
      env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY!,
      env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true",
    );
    if (request.headers.get("X-PA-Delivery-ID") !== parsed.deliveryId) throw new Error("portal-delivery-id-mismatch");
    const status = await processDelivery(env, parsed, await sha256Hex(rawBody));
    return json(200, { ok: true, deliveryId: parsed.deliveryId, status });
  } catch (error) {
    const message = error instanceof SyntaxError ? "portal-json-invalid" : error instanceof Error ? error.message : "portal-internal-error";
    const status = statusForError(error);
    if (status >= 500) console.error(JSON.stringify({ event: "project_alpha_portal_projection_failed", error: message }));
    return json(status, { error: status >= 500 ? "portal-internal-error" : message });
  }
}
