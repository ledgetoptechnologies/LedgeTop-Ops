import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { isAdministrator, sqlScope } from "./acl";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { isBusinessProjectionSource } from "./client-hub-source";
import type { Env, StaffPrincipal } from "./types";

type Database = Pick<D1Database, "prepare" | "batch">;
const PLACEHOLDER = "{recordId}";
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const mutationSchema = z.object({
  expectedConnectorVersion: z.number().int().positive(),
  expectedVersion: z.number().int().positive().nullable(),
  idempotencyKey,
  reviewedUrlTemplate: z.string().min(9).max(2048).nullable(),
}).strict();

export type ProjectManagementAvailabilityReason = "available" | "not_applicable" | "source_not_registered"
  | "source_inactive" | "route_not_configured" | "route_disabled" | "source_mapping_unavailable";
export interface ProjectManagementRouteSummary {
  sourceId: string;
  version: number;
  revision: number;
  enabled: boolean;
  reviewedUrlTemplate: string | null;
}
export interface ProjectManagementMutationInput {
  expectedConnectorVersion: number;
  expectedVersion: number | null;
  idempotencyKey: string;
  reviewedUrlTemplate: string | null;
}
export interface ProjectManagementMutationResult extends ProjectManagementRouteSummary { replayed: boolean }

interface RouteRow {
  source_id: string;
  version: number;
  active_revision: number;
  enabled: number;
  reviewed_url_template: string | null;
}
interface ReceiptRow {
  source_id: string;
  request_fingerprint: string;
  result_version: number;
  result_revision: number;
}
interface ActionRow {
  source_id: string;
  display_name: string;
  state: string;
  read_visible: number;
  connector_version: number;
  route_version: number | null;
  route_revision: number | null;
  enabled: number | null;
  reviewed_url_template: string | null;
  external_id: string | null;
  sync_status: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
}

export class ProjectAlphaProjectManagementError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "changed" | "unavailable", message: string) {
    super(message); this.name = "ProjectAlphaProjectManagementError";
  }
}
const fail = (code: ProjectAlphaProjectManagementError["code"], message: string): never => {
  throw new ProjectAlphaProjectManagementError(code, message);
};
function database(env: Pick<Env, "OPS_DB">): Database { return env.OPS_DB.withSession("first-primary"); }
function actor(value: string): string {
  if (!value || value.length > 256 || /[\0-\x1f\x7f]/.test(value)) return fail("invalid", "Project management actor is invalid");
  return value;
}
function source(value: string): string {
  if (!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) return fail("invalid", "Project Alpha source is invalid");
  return value;
}

/** A reviewed template is either an exact canonical HTTPS URL or has one
 * complete `{recordId}` path segment. Queries are deliberately disallowed:
 * this keeps credentials, tokens, and ambiguous query semantics out of the
 * durable registry and audit surface. */
export function validateProjectManagementUrlTemplate(value: string): string {
  if (value.trim() !== value || /[\0-\x20\x7f\\]/.test(value))
    return fail("invalid", "Project management URL must be a canonical HTTPS URL");
  const placeholders = value.split(PLACEHOLDER).length - 1;
  if (placeholders > 1 || (placeholders === 1 && !value.includes(`/${PLACEHOLDER}`)))
    return fail("invalid", "Project management URL template has an invalid record placeholder");
  const rendered = value.replace(PLACEHOLDER, "project-alpha-record-id");
  let url: URL;
  try { url = new URL(rendered); } catch { return fail("invalid", "Project management URL must be a canonical HTTPS URL"); }
  if (url.protocol !== "https:" || Boolean(url.username || url.password || url.search || url.hash)
    || `${url.origin}${url.pathname}` !== rendered
    || (placeholders === 1 && !url.pathname.split("/").includes("project-alpha-record-id")))
    return fail("invalid", "Project management URL must be canonical HTTPS without credentials, query, or fragment");
  return value;
}

function render(template: string, recordId: string): string {
  const value = template.replace(PLACEHOLDER, encodeURIComponent(recordId));
  if (value.length > 4096) return fail("unavailable", "Project management destination is unavailable");
  // The stored template was reviewed, but validate the rendered destination as
  // a separate defense against unexpected source identifiers.
  let url: URL;
  try { url = new URL(value); } catch { return fail("unavailable", "Project management destination is unavailable"); }
  if (url.protocol !== "https:" || Boolean(url.username || url.password || url.search || url.hash)
    || `${url.origin}${url.pathname}` !== value) return fail("unavailable", "Project management destination is unavailable");
  return value;
}
async function fingerprint(sourceId: string, value: z.infer<typeof mutationSchema>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([sourceId, value.expectedConnectorVersion, value.expectedVersion,
    value.reviewedUrlTemplate]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function summary(row: RouteRow): ProjectManagementRouteSummary {
  return { sourceId: row.source_id, version: row.version, revision: row.active_revision,
    enabled: row.enabled === 1, reviewedUrlTemplate: row.enabled === 1 ? row.reviewed_url_template : null };
}
async function routeAt(database: Database, sourceId: string, version: number, revision: number): Promise<RouteRow | null> {
  return database.prepare(`SELECT route.source_id,? version,revision.revision active_revision,
    revision.enabled,revision.reviewed_url_template
    FROM pa_connector_project_management_route_revisions revision
    JOIN pa_connector_project_management_routes route ON route.source_id=revision.source_id
    WHERE revision.source_id=? AND revision.revision=?`)
    .bind(version, sourceId, revision).first<RouteRow>();
}
async function receipt(database: Database, actorId: string, key: string): Promise<ReceiptRow | null> {
  return database.prepare(`SELECT source_id,request_fingerprint,result_version,result_revision
    FROM pa_connector_project_management_route_mutations WHERE actor_id=? AND idempotency_key=?`)
    .bind(actorId, key).first<ReceiptRow>();
}
async function replay(database: Database, actorId: string, key: string, expectedFingerprint: string) {
  const saved = await receipt(database, actorId, key);
  if (!saved) return null;
  if (saved.request_fingerprint !== expectedFingerprint)
    return fail("conflict", "This operation key was already used for a different project management route");
  const route = await routeAt(database, saved.source_id, saved.result_version, saved.result_revision);
  if (!route) return fail("unavailable", "Project management route receipt could not be verified");
  return { ...summary(route), replayed: true } satisfies ProjectManagementMutationResult;
}
function writeError(error: unknown): never {
  if (error instanceof ProjectAlphaProjectManagementError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/pa_project_management_route_guard|project management route|UNIQUE constraint/i.test(message))
    return fail("changed", "Project management route or source changed. Refresh before saving again");
  return fail("unavailable", "Project management route could not be saved");
}

/** The caller supplies current administrator authority. This function still
 * fences the exact active connector and route versions inside the D1 batch. */
export async function setProjectAlphaProjectManagementRoute(env: Pick<Env, "OPS_DB">, requestedSource: string,
  raw: ProjectManagementMutationInput, actorId: string): Promise<ProjectManagementMutationResult> {
  const parsed = mutationSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid", "Project management route request is invalid");
  const value = parsed.data, sourceId = source(requestedSource), author = actor(actorId), db = database(env);
  const template = value.reviewedUrlTemplate === null ? null : validateProjectManagementUrlTemplate(value.reviewedUrlTemplate);
  const request = { ...value, reviewedUrlTemplate: template };
  const hash = await fingerprint(sourceId, request);
  const previous = await replay(db, author, request.idempotencyKey, hash);
  if (previous) return previous;
  const current = await db.prepare(`SELECT route.version,route.active_revision
    FROM pa_connectors connector LEFT JOIN pa_connector_project_management_routes route ON route.source_id=connector.source_id
    WHERE connector.source_id=? AND connector.state='active' AND connector.read_visible=1 AND connector.version=?`)
    .bind(sourceId, request.expectedConnectorVersion).first<{ version: number | null; active_revision: number | null }>();
  if (!current || (request.expectedVersion === null ? current.version !== null : current.version !== request.expectedVersion))
    return fail("changed", "Project management route or source changed. Refresh before saving again");
  const nextVersion = (current.version ?? 0) + 1, nextRevision = (current.active_revision ?? 0) + 1, enabled = template === null ? 0 : 1;
  const routeGuard = request.expectedVersion === null
    ? "NOT EXISTS(SELECT 1 FROM pa_connector_project_management_routes route WHERE route.source_id=connector.source_id)"
    : "EXISTS(SELECT 1 FROM pa_connector_project_management_routes route WHERE route.source_id=connector.source_id AND route.version=?)";
  const guardBindings: Array<string | number> = [sourceId, sourceId, request.expectedConnectorVersion];
  if (request.expectedVersion !== null) guardBindings.push(request.expectedVersion);
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO pa_connector_project_management_route_write_fences(source_id,write_guard)
      SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM pa_connectors connector WHERE connector.source_id=?
        AND connector.state='active' AND connector.read_visible=1 AND connector.version=? AND ${routeGuard}) THEN 1 ELSE 0 END
      ON CONFLICT(source_id) DO UPDATE SET write_guard=excluded.write_guard`).bind(...guardBindings),
  ];
  if (request.expectedVersion === null) statements.push(
    db.prepare(`INSERT INTO pa_connector_project_management_routes(source_id,active_revision,version,updated_by)
      VALUES(?,1,1,?)`).bind(sourceId, author),
  );
  statements.push(
    db.prepare(`INSERT INTO pa_connector_project_management_route_revisions
      (source_id,revision,enabled,reviewed_url_template,created_by) VALUES(?,?,?,?,?)`)
      .bind(sourceId, nextRevision, enabled, template, author),
  );
  if (request.expectedVersion !== null) statements.push(
    db.prepare(`UPDATE pa_connector_project_management_routes SET active_revision=?,version=version+1,
      updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_id=? AND version=?`)
      .bind(nextRevision, author, sourceId, request.expectedVersion),
  );
  statements.push(
    db.prepare(`INSERT INTO pa_connector_project_management_route_audit
      (id,source_id,actor_id,action,route_version,route_revision,details_json) VALUES(?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), sourceId, author, enabled ? "configured" : "disabled", nextVersion, nextRevision,
        JSON.stringify({ enabled: enabled === 1, templateKind: template?.includes(PLACEHOLDER) ? "record_path" : template ? "base_url" : "disabled" })),
    db.prepare(`INSERT INTO pa_connector_project_management_route_mutations
      (actor_id,idempotency_key,source_id,request_fingerprint,result_version,result_revision) VALUES(?,?,?,?,?,?)`)
      .bind(author, request.idempotencyKey, sourceId, hash, nextVersion, nextRevision),
  );
  try { await db.batch(statements); }
  catch (error) {
    const winner = await replay(db, author, request.idempotencyKey, hash);
    if (winner) return winner;
    writeError(error);
  }
  const saved = await routeAt(db, sourceId, nextVersion, nextRevision);
  if (!saved) return fail("unavailable", "Project management route could not be verified");
  return { ...summary(saved), replayed: false };
}

export async function listProjectAlphaProjectManagementRoutes(env: Pick<Env, "OPS_DB">): Promise<ProjectManagementRouteSummary[]> {
  const rows = await database(env).prepare(`SELECT route.source_id,route.version,route.active_revision,
    revision.enabled,revision.reviewed_url_template
    FROM pa_connector_project_management_routes route
    JOIN pa_connector_project_management_route_revisions revision
      ON revision.source_id=route.source_id AND revision.revision=route.active_revision
    ORDER BY route.source_id LIMIT 33`).all<RouteRow>();
  if (rows.results.length > 32) return fail("unavailable", "Project management route registry exceeds its supported limit");
  return rows.results.map(summary);
}

function safeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
function normalizedSync(value: string | null): "healthy" | "error" | "disabled" | "unknown" {
  return value === "healthy" || value === "error" || value === "disabled" ? value : "unknown";
}
function explanation(reason: ProjectManagementAvailabilityReason, sourceName: string): string {
  if (reason === "available") return `Create the authoritative project in ${sourceName}. Operations will show it after Project Alpha synchronization completes.`;
  if (reason === "source_inactive") return `${sourceName} is not active. Project creation is unavailable until an administrator restores the source connection.`;
  if (reason === "route_disabled") return `Project creation links are disabled for ${sourceName}.`;
  if (reason === "route_not_configured") return `An administrator has not reviewed a Project Alpha project-management link for ${sourceName}.`;
  if (reason === "source_mapping_unavailable") return `The exact ${sourceName} client identifier is unavailable. Refresh after source synchronization completes.`;
  if (reason === "source_not_registered") return `This Project Alpha source is not registered for project management.`;
  return "Project creation is available only from an exact Project Alpha business record.";
}

export async function readClientHubProjectManagementAction(env: Env, principal: StaffPrincipal,
  context: ClientHubCollectionContext, refreshHref: string) {
  const root = context.root;
  let row: ActionRow | null = null;
  if (root.root_namespace === "business" && isBusinessProjectionSource(root.source_id)) {
    const kind = root.kind === "organization" ? "organization" : "client";
    row = await database(env).prepare(`SELECT connector.source_id,connector.display_name,connector.state,connector.read_visible,
      connector.version connector_version,route.version route_version,route.active_revision route_revision,
      revision.enabled,revision.reviewed_url_template,mapping.external_id,
      health.status sync_status,health.last_attempt_at,health.last_success_at
      FROM pa_connectors connector
      LEFT JOIN pa_projection_record_ids mapping ON mapping.projection_source_id=connector.source_id
        AND mapping.record_kind=? AND mapping.local_id=?
      LEFT JOIN pa_connector_project_management_routes route ON route.source_id=connector.source_id
      LEFT JOIN pa_connector_project_management_route_revisions revision
        ON revision.source_id=route.source_id AND revision.revision=route.active_revision
      LEFT JOIN integration_health health ON health.integration='project-alpha'
        AND health.projection_source_id=connector.source_id
      WHERE connector.source_id=?
      ORDER BY mapping.external_id LIMIT 2`).bind(kind, root.public_id, root.source_id).all<ActionRow>()
      .then(result => result.results.length === 1 ? result.results[0]! : null);
  }
  const sourceName = row?.display_name ?? root.source_name ?? "Project Alpha";
  let reason: ProjectManagementAvailabilityReason = root.root_namespace !== "business" || !isBusinessProjectionSource(root.source_id)
    ? "not_applicable" : !row?.source_id ? "source_not_registered" : row.state !== "active" || row.read_visible !== 1
      ? "source_inactive" : row.route_version === null ? "route_not_configured" : row.enabled !== 1 || !row.reviewed_url_template
        ? "route_disabled" : !row.external_id ? "source_mapping_unavailable" : "available";
  let href: string | null = null;
  if (reason === "available") {
    try { href = render(validateProjectManagementUrlTemplate(row!.reviewed_url_template!), row!.external_id!); }
    catch { reason = "route_disabled"; }
  }
  // Make the returned URL a proof of the same still-current source, route and
  // immutable mapping observed above. No snapshot origin participates.
  if (href && !await database(env).prepare(`SELECT 1 current FROM pa_connectors connector
    JOIN pa_connector_project_management_routes route ON route.source_id=connector.source_id
    JOIN pa_connector_project_management_route_revisions revision
      ON revision.source_id=route.source_id AND revision.revision=route.active_revision
    JOIN pa_projection_record_ids mapping ON mapping.projection_source_id=connector.source_id
      AND mapping.record_kind=? AND mapping.local_id=? AND mapping.external_id=?
    WHERE connector.source_id=? AND connector.state='active' AND connector.read_visible=1
      AND connector.version=? AND route.version=? AND route.active_revision=?
      AND revision.enabled=1 AND revision.reviewed_url_template=?`)
    .bind(root.kind === "organization" ? "organization" : "client", root.public_id, row!.external_id,
      root.source_id, row!.connector_version, row!.route_version, row!.route_revision, row!.reviewed_url_template).first()) {
    throw new HTTPException(409, { message: "Project Alpha project management configuration changed. Refresh the client workspace." });
  }
  const [scope, administrator] = await Promise.all([
    sqlScope(env, principal, "integrations.manage"), isAdministrator(env, principal),
  ]);
  const canSync = Boolean(row?.source_id && row.state === "active" && administrator && scope.global && !scope.deniedGlobal);
  const syncStatus = row?.source_id ? normalizedSync(row.sync_status) : "not_configured";
  return {
    canonicalRoot: context.canonicalRoot,
    contextVersion: context.contextVersion,
    source: { sourceId: root.source_id, displayName: sourceName, state: row?.state ?? "unregistered" },
    availability: { available: reason === "available", reason, explanation: explanation(reason, sourceName) },
    action: href ? { label: "Create project in Project Alpha", href, external: true as const } : null,
    sync: {
      status: syncStatus,
      lastAttemptAt: safeTimestamp(row?.last_attempt_at ?? null),
      lastSuccessAt: safeTimestamp(row?.last_success_at ?? null),
      explanation: syncStatus === "not_configured" ? `No exact-source project-management connector is enrolled for ${sourceName}. Existing business records may still come from the primary Project Alpha synchronization.`
        : syncStatus === "healthy" ? `The latest ${sourceName} synchronization completed successfully.`
        : syncStatus === "error" ? `${sourceName} synchronization needs attention. Creating a project in Project Alpha does not create a local Operations project.`
        : syncStatus === "disabled" ? `${sourceName} synchronization is disabled.`
        : `No successful ${sourceName} synchronization has been recorded yet.`,
      refresh: { label: "Refresh synchronization status", href: refreshHref, method: "GET" as const },
      requestSync: canSync ? { label: "Sync source now", href: `/api/admin/integrations/project-alpha/connectors/${encodeURIComponent(root.source_id)}/sync`, method: "POST" as const } : null,
    },
  };
}
