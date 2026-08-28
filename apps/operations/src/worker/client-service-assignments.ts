import { HTTPException } from "hono/http-exception";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { sha256 } from "./crypto";
import type { Env, StaffPrincipal } from "./types";

export const SERVICE_ASSIGNMENT_STATUSES = ["current", "effective", "upcoming", "expired", "needs_review"] as const;
export type ServiceAssignmentStatusFilter = (typeof SERVICE_ASSIGNMENT_STATUSES)[number];
export type ServiceAssignmentAvailabilityReason = "permission_required" | "not_applicable" | "workspace_unavailable"
  | "subject_mapping_unavailable" | "schema_unavailable" | "receiver_not_ready" | "directory_not_ready"
  | "projection_not_ready";

export interface ClientServiceAssignmentRow {
  row_key: string;
  assignment_public_id: string;
  service_public_id: string;
  service_name: string | null;
  service_label: string;
  service_source_version: string;
  assignment_source_version: string;
  subject_type: "organization" | "standalone_client";
  subject_public_id: string;
  subject_name: string;
  effective_status: Exclude<ServiceAssignmentStatusFilter, "current">;
  effective_from: string | null;
  effective_until: string | null;
  source_id: string;
  source_name: string;
  source_generation: string;
  source_sequence: number;
  source_updated_at: string;
}

export interface ClientServiceAssignmentReadiness {
  tables: "ready" | "unavailable";
  receiver: "ready" | "not_enrolled" | "suspended" | "unavailable";
  source: "observed" | "unobserved" | "unavailable";
  directory: "ready" | "unavailable";
  projection: "ready" | "unavailable";
  catalog: "ready" | "unavailable";
}

export interface ClientServiceAssignmentPage {
  available: boolean;
  reason: ServiceAssignmentAvailabilityReason | null;
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  limit: number;
}

export interface ClientServiceAssignmentResult {
  items: ClientServiceAssignmentRow[];
  page: ClientServiceAssignmentPage;
  readiness: ClientServiceAssignmentReadiness;
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"];
  contextVersion: string;
  refreshedAt: string;
}

export interface ClientServiceAssignmentQuery {
  q?: string;
  status?: string;
  cursor?: string;
  limit?: number;
  initial?: boolean;
}

interface AssignmentCheckpoint {
  active_generation_id: string;
  source_generation: string;
  source_sequence: number;
}

interface Cursor {
  v: 1;
  source: string;
  root: [string, string, string, string, string];
  project: null;
  context: string;
  checkpoint: [string, string, number];
  selection: string;
  after: [string, string, string];
}

interface ReadinessRow extends Record<string, unknown> {
  grant_state: string | null;
  receiver_workspace_state: string | null;
  source_state: string | null;
  owner_ready: number;
  workspace_ready: number;
  directory_ready: number;
  directory_generation_id: string | null;
  directory_source_sequence: number | null;
  directory_subject_version: string | null;
  active_generation_id: string | null;
  source_generation: string | null;
  source_sequence: number | null;
  projection_ready: number;
}

interface AssignmentRecord extends Record<string, unknown> {
  assignment_public_id: string;
  service_public_id: string;
  service_name: string | null;
  service_source_version: string;
  assignment_source_version: string;
  effective_status: ClientServiceAssignmentRow["effective_status"];
  effective_from: string | null;
  effective_until: string | null;
  source_generation: string;
  source_sequence: number;
  source_updated_at: string;
}

const REQUIRED_TABLES = ["pa_service_assignment_receiver_grants", "pa_service_assignment_receiver_workspaces",
  "pa_service_assignment_source_capabilities", "pa_service_assignment_generations", "pa_service_assignments",
  "pa_service_assignment_checkpoints", "pa_portal_workspace_sources", "portal_v2_workspaces",
  "portal_v2_directory_checkpoints", "portal_v2_directory_generations", "portal_v2_directory_entities"] as const;
const CATALOG_TABLES = ["pa_service_catalog_items", "pa_service_catalog_checkpoint"] as const;

function invalid(message = "Service assignment query is invalid"): never {
  throw new HTTPException(400, { message });
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    invalid("Service assignment page limit must be between 1 and 100");
  return limit;
}

function encode(cursor: Cursor): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(cursor)), byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0))));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const cursor = parsed as Partial<Cursor>;
    if (cursor.v !== 1 || typeof cursor.source !== "string"
      || cursor.project !== null || typeof cursor.context !== "string" || typeof cursor.selection !== "string"
      || !Array.isArray(cursor.root) || cursor.root.length !== 5
      || !cursor.root.every(item => typeof item === "string" && item.length <= 512)
      || !Array.isArray(cursor.checkpoint) || cursor.checkpoint.length !== 3
      || typeof cursor.checkpoint[0] !== "string" || typeof cursor.checkpoint[1] !== "string"
      || !Number.isSafeInteger(cursor.checkpoint[2])
      || !Array.isArray(cursor.after) || cursor.after.length !== 3
      || !cursor.after.every(item => typeof item === "string" && item.length <= 512)) throw new Error();
    return cursor as Cursor;
  } catch {
    invalid("Service assignment cursor is invalid");
  }
}

function unavailable(context: ClientHubCollectionContext, limit: number, reason: ServiceAssignmentAvailabilityReason,
  readiness: ClientServiceAssignmentReadiness): ClientServiceAssignmentResult {
  return { items: [], page: { available: false, reason, nextCursor: null, hasMore: false, returned: 0, limit }, readiness,
    canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion, refreshedAt: new Date().toISOString() };
}

function schemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:|no such column:|has no column named/i.test(message);
}

function rootTuple(context: ClientHubCollectionContext): Cursor["root"] {
  return [context.root.root_namespace, context.root.kind, context.root.public_id,
    context.root.pa_public_id ?? "", context.root.workspace_id ?? ""];
}

function checkpointTuple(checkpoint: AssignmentCheckpoint): Cursor["checkpoint"] {
  return [checkpoint.active_generation_id, checkpoint.source_generation, checkpoint.source_sequence];
}

export function serviceAssignmentQuery(parameters: URLSearchParams): ClientServiceAssignmentQuery {
  const limit = parameters.get("limit");
  return { q: parameters.get("q") ?? undefined, status: parameters.get("status") ?? undefined,
    cursor: parameters.get("cursor") ?? undefined,
    limit: limit === null ? undefined : /^\d+$/.test(limit) ? Number(limit) : Number.NaN };
}

async function readReadiness(db: D1DatabaseSession, context: ClientHubCollectionContext): Promise<ReadinessRow> {
  return await db.prepare(`SELECT
    (SELECT state FROM pa_service_assignment_receiver_grants WHERE source_id=?) grant_state,
    (SELECT state FROM pa_service_assignment_receiver_workspaces WHERE source_id=? AND workspace_id=?) receiver_workspace_state,
    (SELECT state FROM pa_service_assignment_source_capabilities WHERE source_id=?) source_state,
    EXISTS(SELECT 1 FROM pa_portal_workspace_sources WHERE workspace_id=? AND projection_source_id=?) owner_ready,
    EXISTS(SELECT 1 FROM portal_v2_workspaces WHERE id=? AND project_alpha_source_id=? AND root_type=?
      AND COALESCE(pa_organization_public_id,pa_client_public_id)=? AND status NOT IN ('closed','disabled')) workspace_ready,
    EXISTS(SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
        AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities entity ON entity.workspace_id=checkpoint.workspace_id
        AND entity.generation_id=checkpoint.active_generation_id AND entity.entity_type=? AND entity.public_id=?
        AND entity.parent_public_id IS NULL AND entity.active=1
      WHERE checkpoint.workspace_id=?) directory_ready,
    (SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?) directory_generation_id,
    (SELECT source_sequence FROM portal_v2_directory_checkpoints WHERE workspace_id=?) directory_source_sequence,
    (SELECT entity.source_version FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_entities entity ON entity.workspace_id=checkpoint.workspace_id
        AND entity.generation_id=checkpoint.active_generation_id AND entity.entity_type=? AND entity.public_id=?
        AND entity.parent_public_id IS NULL AND entity.active=1 WHERE checkpoint.workspace_id=?) directory_subject_version,
    (SELECT active_generation_id FROM pa_service_assignment_checkpoints WHERE source_id=?) active_generation_id,
    (SELECT source_generation FROM pa_service_assignment_checkpoints WHERE source_id=?) source_generation,
    (SELECT source_sequence FROM pa_service_assignment_checkpoints WHERE source_id=?) source_sequence,
    EXISTS(SELECT 1 FROM pa_service_assignment_checkpoints checkpoint
      JOIN pa_service_assignment_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.source_id=checkpoint.source_id AND generation.source_generation=checkpoint.source_generation
        AND generation.source_sequence=checkpoint.source_sequence AND generation.status='active' AND generation.complete=1
      WHERE checkpoint.source_id=?) projection_ready`)
    .bind(context.root.source_id, context.root.source_id, context.root.workspace_id, context.root.source_id,
      context.root.workspace_id, context.root.source_id, context.root.workspace_id, context.root.source_id,
      context.root.kind, context.root.pa_public_id, context.root.kind, context.root.pa_public_id,
      context.root.workspace_id, context.root.workspace_id, context.root.workspace_id, context.root.kind,
      context.root.pa_public_id, context.root.workspace_id, context.root.source_id, context.root.source_id, context.root.source_id,
      context.root.source_id).first<ReadinessRow>() ?? {
      grant_state: null, receiver_workspace_state: null, source_state: null, owner_ready: 0, workspace_ready: 0,
      directory_ready: 0, directory_generation_id: null, directory_source_sequence: null, directory_subject_version: null,
      active_generation_id: null, source_generation: null, source_sequence: null, projection_ready: 0,
    };
}

function readinessProof(value: ReadinessRow): string {
  return JSON.stringify([value.grant_state, value.receiver_workspace_state, value.source_state, value.owner_ready,
    value.workspace_ready, value.directory_ready, value.directory_generation_id, value.directory_source_sequence,
    value.directory_subject_version, value.active_generation_id, value.source_generation,
    value.source_sequence, value.projection_ready]);
}

/**
 * Read-only, exact-subject assignment facts. Workspace containment proves that
 * the exported subject belongs to this exact source/root; it is never used as
 * a broad assignment selector. Assignments do not grant portal access, enable
 * requests, or expose pricing.
 */
export async function listClientServiceAssignments(env: Pick<Env, "DELIVERY_DB">, principal: StaffPrincipal,
  context: ClientHubCollectionContext, options: ClientServiceAssignmentQuery = {}): Promise<ClientServiceAssignmentResult> {
  const limit = pageLimit(options.limit);
  const baseline: ClientServiceAssignmentReadiness = { tables: "ready", receiver: "unavailable", source: "unavailable",
    directory: "unavailable", projection: "unavailable", catalog: "unavailable" };
  if (!context.access.directory || !context.access.requests) {
    if (!options.initial) throw new HTTPException(403, { message: "Client service assignment access is required" });
    return unavailable(context, limit, "permission_required", baseline);
  }
  if (context.root.root_namespace !== "business" || !context.root.source_id.startsWith("project-alpha:"))
    return unavailable(context, limit, "not_applicable", baseline);
  if (!context.root.workspace_id)
    return unavailable(context, limit, "workspace_unavailable", baseline);
  if (context.root.mapping_status !== "mapped" || !context.root.pa_public_id)
    return unavailable(context, limit, "subject_mapping_unavailable", baseline);

  const q = (options.q ?? "").normalize("NFC").trim().toLocaleLowerCase("en-US");
  if ((options.q?.length ?? 0) > 200 || /[\0-\x1f\x7f]/.test(options.q ?? "")) invalid();
  const status = options.status ?? "current";
  if (!(SERVICE_ASSIGNMENT_STATUSES as readonly string[]).includes(status))
    invalid("Service assignment status is invalid");

  const db = env.DELIVERY_DB.withSession("first-primary");
  const tableRows = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${[...REQUIRED_TABLES, ...CATALOG_TABLES].map(() => "?").join(",")})`)
    .bind(...REQUIRED_TABLES, ...CATALOG_TABLES).all<{ name: string }>();
  const tables = new Set(tableRows.results.map(row => row.name));
  if (REQUIRED_TABLES.some(table => !tables.has(table)))
    return unavailable(context, limit, "schema_unavailable", { ...baseline, tables: "unavailable" });
  const catalogReady = CATALOG_TABLES.every(table => tables.has(table));

  let readiness: ReadinessRow;
  try {
    readiness = await readReadiness(db, context);
  } catch (error) {
    if (schemaError(error)) return unavailable(context, limit, "schema_unavailable", { ...baseline, tables: "unavailable" });
    throw error;
  }
  const state: ClientServiceAssignmentReadiness = { tables: "ready",
    receiver: readiness.grant_state === "suspended" || readiness.receiver_workspace_state === "suspended" ? "suspended"
      : !readiness.grant_state || !readiness.receiver_workspace_state ? "not_enrolled"
        : readiness.grant_state === "active" && readiness.receiver_workspace_state === "active" ? "ready" : "unavailable",
    source: readiness.source_state === "supported" ? "observed" : readiness.source_state ? "unavailable" : "unobserved",
    directory: readiness.owner_ready === 1 && readiness.workspace_ready === 1 && readiness.directory_ready === 1 ? "ready" : "unavailable",
    projection: readiness.projection_ready === 1 ? "ready" : "unavailable", catalog: catalogReady ? "ready" : "unavailable" };
  if (state.receiver !== "ready") return unavailable(context, limit, "receiver_not_ready", state);
  if (state.directory !== "ready") return unavailable(context, limit, "directory_not_ready", state);
  if (state.projection !== "ready" || !readiness.active_generation_id || !readiness.source_generation
    || !Number.isSafeInteger(readiness.source_sequence)) return unavailable(context, limit, "projection_not_ready", state);
  const checkpoint: AssignmentCheckpoint = { active_generation_id: readiness.active_generation_id,
    source_generation: readiness.source_generation, source_sequence: readiness.source_sequence! };

  const selection = await sha256(JSON.stringify([principal.id, context.root.source_id, rootTuple(context), null,
    context.contextVersion, checkpointTuple(checkpoint), q, status]));
  const cursor = options.cursor === undefined ? null : decode(options.cursor);
  if (cursor && (cursor.source !== context.root.source_id || cursor.project !== null
    || JSON.stringify(cursor.root) !== JSON.stringify(rootTuple(context)) || cursor.context !== context.contextVersion
    || JSON.stringify(cursor.checkpoint) !== JSON.stringify(checkpointTuple(checkpoint)) || cursor.selection !== selection))
    throw new HTTPException(409, { message: "Client, source, assignment checkpoint, or filters changed. Refresh the client workspace" });

  const predicates: string[] = [];
  const values: unknown[] = [context.root.source_id, context.root.kind, context.root.pa_public_id];
  if (q) { predicates.push("(instr(lower(service_public_id),?)>0 OR instr(lower(COALESCE(service_name,'')),?)>0)"); values.push(q, q); }
  if (status !== "current") { predicates.push("effective_status=?"); values.push(status); }
  if (cursor) { predicates.push("(source_updated_at,assignment_public_id,assignment_source_version)<(?,?,?)"); values.push(...cursor.after); }
  const catalogJoin = catalogReady ? `LEFT JOIN pa_service_catalog_items catalog ON catalog.source_id=assignment.source_id
      AND catalog.public_id=assignment.service_public_id AND catalog.source_version=assignment.service_source_version AND catalog.active=1` : "";
  const catalogName = catalogReady ? "catalog.name" : "NULL";
  let result: D1Result<AssignmentRecord>;
  try {
    result = await db.prepare(`WITH effective AS (SELECT assignment.assignment_public_id,assignment.service_public_id,
      ${catalogName} service_name,assignment.service_source_version,assignment.source_version assignment_source_version,
      assignment.effective_from,assignment.effective_until,assignment.source_generation,assignment.source_sequence,
      assignment.source_updated_at,CASE
        WHEN (assignment.effective_from IS NOT NULL AND datetime(assignment.effective_from) IS NULL)
          OR (assignment.effective_until IS NOT NULL AND datetime(assignment.effective_until) IS NULL) THEN 'needs_review'
        WHEN assignment.effective_from IS NOT NULL AND datetime(assignment.effective_from)>datetime('now') THEN 'upcoming'
        WHEN assignment.effective_until IS NOT NULL AND datetime(assignment.effective_until)<=datetime('now') THEN 'expired'
        ELSE 'effective' END effective_status
      FROM pa_service_assignments assignment ${catalogJoin}
      WHERE assignment.source_id=? AND assignment.subject_type=? AND assignment.subject_public_id=? AND assignment.active=1)
      SELECT * FROM effective ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
      ORDER BY source_updated_at DESC,assignment_public_id DESC,assignment_source_version DESC LIMIT ?`)
      .bind(...values, limit + 1).all<AssignmentRecord>();
  } catch (error) {
    if (schemaError(error)) return unavailable(context, limit, "schema_unavailable", { ...state, tables: "unavailable" });
    throw error;
  }
  let afterReadiness: ReadinessRow;
  try { afterReadiness = await readReadiness(db, context); }
  catch (error) {
    if (schemaError(error))
      throw new HTTPException(409, { message: "Service assignment readiness changed. Refresh the client workspace" });
    throw error;
  }
  if (readinessProof(afterReadiness) !== readinessProof(readiness))
    throw new HTTPException(409, { message: "Service assignment readiness changed. Refresh the client workspace" });

  const rows = result.results.slice(0, limit);
  const page: ClientServiceAssignmentPage = { available: true, reason: null, nextCursor: null,
    hasMore: result.results.length > limit, returned: rows.length, limit };
  if (page.hasMore) {
    const last = rows[rows.length - 1]!;
    page.nextCursor = encode({ v: 1, source: context.root.source_id, root: rootTuple(context),
      project: null, context: context.contextVersion, checkpoint: checkpointTuple(checkpoint), selection,
      after: [last.source_updated_at, last.assignment_public_id, last.assignment_source_version] });
  }
  return { items: rows.map(row => ({ row_key: JSON.stringify([context.root.source_id, row.assignment_public_id,
      row.assignment_source_version]), assignment_public_id: row.assignment_public_id,
    service_public_id: row.service_public_id, service_name: row.service_name,
    service_label: row.service_name ?? row.service_public_id, service_source_version: row.service_source_version,
    assignment_source_version: row.assignment_source_version, subject_type: context.root.kind,
    subject_public_id: context.root.pa_public_id!, subject_name: context.root.display_name,
    effective_status: row.effective_status, effective_from: row.effective_from, effective_until: row.effective_until,
    source_id: context.root.source_id, source_name: context.root.source_name ?? context.root.source_id,
    source_generation: row.source_generation, source_sequence: Number(row.source_sequence),
    source_updated_at: row.source_updated_at })), page, readiness: state, canonicalRoot: context.canonicalRoot,
    contextVersion: context.contextVersion, refreshedAt: new Date().toISOString() };
}
