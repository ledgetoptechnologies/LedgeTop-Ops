import { HTTPException } from "hono/http-exception";
import { hasLocalGlobalAllow, hasPermission, isAdministrator, sqlScope } from "./acl";
import { paProjectFilter } from "./visibility";
import { sha256 } from "./crypto";
import { isBusinessProjectionSource, validatedUniquePublicIdExpression, type ClientHubMappingStatus } from "./client-hub-source";
import type { Env, StaffPrincipal } from "./types";

export const CLIENT_HUB_SOURCES = ["project-alpha:primary", "delivery:local"] as const;
export type ClientHubSource = `project-alpha:${string}` | "delivery:local";
export type ClientHubKind = "organization" | "standalone_client";
export type ClientHubRootNamespace = "business" | "portal" | "account";
export interface ClientHubRoot {
  source_id: ClientHubSource;
  root_namespace: ClientHubRootNamespace;
  kind: ClientHubKind;
  /** Namespace-local key: internal business ID, exact portal workspace ID, or
   * local account ID. Only pa_public_id contains the exported Alpha public ID. */
  public_id: string;
  pa_public_id: string | null;
  mapping_status: ClientHubMappingStatus;
  display_name: string;
  sort_name: string;
  status: string;
  portal_status: string;
  workspace_id: string | null;
  legacy_account_id: string | null;
  account_count: number;
  project_count: number;
  request_count: number;
  contact_count: number;
  meaningful_activity_at: string | null;
  source_version: string | null;
  indexed_at: string;
  scan_generation: number;
}
export interface ClientHubDirectoryState {
  revision: number;
  ready: number;
  backfill_phase: string | null;
  backfill_cursor: string | null;
  last_success_at: string | null;
  generation: number;
  lease_token: string | null;
  lease_until: string | null;
  next_run_at: string | null;
}
export interface ClientHubDirectoryQuery { q?: string; kind?: string; cursor?: string; limit?: number }
type Position = [string, ClientHubSource, ClientHubRootNamespace, ClientHubKind, string];
interface Cursor { v: 2; revision: number; q: string; kind: ClientHubKind | null; policy: string; after: Position }

export function normalizeClientHubText(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}
export function normalizeClientHubPhone(value: string): string { return value.replace(/\D/g, ""); }
export function isClientHubSource(value: string): value is ClientHubSource {
  return value === "delivery:local" || isBusinessProjectionSource(value);
}
export function isClientHubKind(value: string): value is ClientHubKind {
  return value === "organization" || value === "standalone_client";
}
export function isClientHubRootNamespace(value: string): value is ClientHubRootNamespace {
  return value === "business" || value === "portal" || value === "account";
}
export function clientHubRouteKind(kind: ClientHubKind): "organizations" | "standalone" {
  return kind === "organization" ? "organizations" : "standalone";
}
export function clientHubDetailPath(root: Pick<ClientHubRoot, "source_id" | "root_namespace" | "kind" | "public_id">): string {
  return `/clients/sources/${encodeURIComponent(root.source_id)}/${root.root_namespace}/${clientHubRouteKind(root.kind)}/${encodeURIComponent(root.public_id)}`;
}
const visibleRoot = "root.status NOT IN ('closed','inactive')";
// An index refresh can lag an authoritative business reassignment/deactivation.
// Only live business roots belong to this source. A portal UUID by itself never
// establishes a business-root mapping, even when it resembles a record ID.
const liveBusinessRoot = `(root.root_namespace<>'business' OR (
  (root.kind='organization' AND EXISTS (SELECT 1 FROM pa_organizations organization
    WHERE organization.id=root.public_id AND organization.projection_source_id=root.source_id AND organization.active=1)) OR
  (root.kind='standalone_client' AND EXISTS (SELECT 1 FROM pa_clients client
    WHERE client.id=root.public_id AND client.projection_source_id=root.source_id AND client.active=1 AND client.organization_id IS NULL))))`;
const currentMapping = `CASE WHEN root.root_namespace='business'
  THEN CASE WHEN root.kind='organization' THEN (SELECT ${validatedUniquePublicIdExpression("pa_organizations", "source")}
    FROM pa_organizations source WHERE source.id=root.public_id AND source.projection_source_id=root.source_id)
  ELSE (SELECT ${validatedUniquePublicIdExpression("pa_clients", "source")} FROM pa_clients source WHERE source.id=root.public_id AND source.projection_source_id=root.source_id) END
  ELSE root.pa_public_id END`;
function unavailable(): never {
  throw new HTTPException(503, { message: "The client directory is being prepared; please retry shortly" });
}
function changed(): never {
  throw new HTTPException(409, { message: "The client directory changed. Refresh the results to continue" });
}
function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error();
    const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const cursor = parsed as Partial<Cursor>;
    if (cursor.v !== 2 || !Number.isSafeInteger(cursor.revision) || cursor.revision! < 0 ||
      typeof cursor.q !== "string" || typeof cursor.policy !== "string" ||
      (cursor.kind !== null && (typeof cursor.kind !== "string" || !isClientHubKind(cursor.kind))) ||
      !Array.isArray(cursor.after) || cursor.after.length !== 5 ||
      !cursor.after.every(item => typeof item === "string") ||
      !isClientHubSource(cursor.after[1]) || !isClientHubRootNamespace(cursor.after[2]) || !isClientHubKind(cursor.after[3])) throw new Error();
    return cursor as Cursor;
  } catch { throw new HTTPException(400, { message: "Client directory cursor is invalid" }); }
}

/** Match the existing /api/projects permission and assignment policy. Search
 * must not disclose a client solely through an otherwise hidden project. */
async function projectSearchAccess(env: Env, principal: StaffPrincipal) {
  const [allowed, scope, administrator, explicitAll] = await Promise.all([
    hasPermission(env, principal, "projects.view"), sqlScope(env, principal, "projects.view"),
    isAdministrator(env, principal), hasLocalGlobalAllow(env, principal, "operations.view_all"),
  ]);
  const filter = allowed
    ? paProjectFilter(administrator ? scope : { ...scope, divisions: [] }, principal, administrator, administrator || explicitAll)
    : { sql: "0=1", values: [] };
  return { filter, policy: await sha256(JSON.stringify([principal.id, principal.projectAlphaUserId, allowed, scope, administrator, explicitAll])) };
}

export async function listClientHubRoots(env: Env, principal: StaffPrincipal, options: ClientHubDirectoryQuery = {}) {
  const directoryScope = await sqlScope(env, principal, "team.view");
  if (!directoryScope.global || directoryScope.deniedGlobal)
    throw new HTTPException(403, { message: "Global team.view permission required" });
  const limit = options.limit ?? 24;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HTTPException(400, { message: "Client directory limit must be between 1 and 100" });
  if (options.kind !== undefined && !isClientHubKind(options.kind))
    throw new HTTPException(400, { message: "Client directory kind is invalid" });
  const kind = options.kind as ClientHubKind | undefined;
  if ((options.q?.length ?? 0) > 200 || /[\0-\x1f\x7f]/.test(options.q ?? ""))
    throw new HTTPException(400, { message: "Client directory search is invalid" });
  const q = normalizeClientHubText(options.q ?? "");
  const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
  const { filter, policy } = await projectSearchAccess(env, principal);
  if (cursor && (cursor.q !== q || cursor.kind !== (kind ?? null) || cursor.policy !== policy))
    throw new HTTPException(400, { message: "Client directory cursor does not match this search" });
  const clauses = [visibleRoot, liveBusinessRoot], values: unknown[] = [];
  if (kind) { clauses.push("root.kind=?"); values.push(kind); }
  if (q) {
    const phone = /^[\d\s()+.\-]+$/.test(q) ? normalizeClientHubPhone(q) : "";
    // D1 limits LIKE/GLOB patterns to 50 bytes. Literal instr supports the full
    // 200-character search contract without wildcard interpretation.
    clauses.push(`(instr(root.sort_name,?)>0 OR EXISTS (
      SELECT 1 FROM client_hub_search_values search WHERE search.source_id=root.source_id
        AND search.root_namespace=root.root_namespace AND search.kind=root.kind AND search.root_public_id=root.public_id
        AND (instr(search.normalized_value,?)>0${phone.length >= 3 ? " OR (search.field='phone' AND instr(search.normalized_value,?)>0)" : ""})
        AND search.root_namespace='business' AND (
          (search.record_type='pa_client' AND search.project_id IS NULL AND EXISTS (
            SELECT 1 FROM pa_clients contact WHERE contact.id=search.record_id AND contact.projection_source_id=root.source_id AND contact.active=1 AND
              ((root.kind='organization' AND contact.organization_id=root.public_id) OR
               (root.kind='standalone_client' AND contact.id=root.public_id AND contact.organization_id IS NULL))))
          OR (search.record_type='pa_project' AND search.record_id=search.project_id AND EXISTS (
            SELECT 1 FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
            WHERE p.id=search.project_id AND p.projection_source_id=root.source_id AND ${filter.sql} AND
              ((root.kind='organization' AND COALESCE(p.organization_id,owner.organization_id)=root.public_id) OR
               (root.kind='standalone_client' AND p.client_id=root.public_id AND owner.id IS NOT NULL
                 AND COALESCE(p.organization_id,owner.organization_id) IS NULL)))))))`);
    // Portal-principal search additionally needs a live cross-database ownership
    // proof before pagination. Until that contract exists the API explicitly
    // reports portalContacts=false rather than searching stale principal rows.
    values.push(q, q);
    if (phone.length >= 3) values.push(phone);
    values.push(...filter.values);
  }
  if (cursor) {
    clauses.push("(root.sort_name,root.source_id,root.root_namespace,root.kind,root.public_id)>(?,?,?,?,?)");
    values.push(...cursor.after);
  }
  const db = env.OPS_DB.withSession("first-primary");
  // State and page share one transaction. The writer advances revision only
  // alongside effective root/search changes, so mutable names cannot skip rows.
  type Snapshot = Pick<ClientHubDirectoryState, "revision" | "ready" | "last_success_at">;
  type LiveRoot = ClientHubRoot & { live_pa_public_id: string | null };
  const results = await db.batch<LiveRoot | Snapshot>([
    db.prepare("SELECT revision,ready,last_success_at FROM client_hub_directory_state WHERE id='directory'"),
    db.prepare(`SELECT root.*,${currentMapping} live_pa_public_id FROM client_hub_roots root WHERE ${clauses.join(" AND ")}
      ORDER BY root.sort_name,root.source_id,root.root_namespace,root.kind,root.public_id LIMIT ?`).bind(...values, limit + 1),
  ]);
  const state = results[0]!.results.find((row): row is Snapshot => "revision" in row);
  if (!state?.ready) unavailable();
  if (cursor && cursor.revision !== state.revision) changed();
  const roots = results[1]!.results.filter((row): row is LiveRoot => "source_id" in row);
  const page = roots.slice(0, limit);
  const last = page.at(-1);
  return {
    clients: page.map(({ live_pa_public_id, ...root }) => ({ ...root,
      ...(root.root_namespace === "business" && root.pa_public_id !== live_pa_public_id ? {
        pa_public_id: live_pa_public_id, mapping_status: live_pa_public_id ? "mapped" : "missing",
        workspace_id: null, portal_status: "mapping_unavailable",
      } : {}),
      source_name: root.source_id === "project-alpha:primary" ? "Project Alpha" : root.source_id === "delivery:local" ? "Local delivery" : root.source_id,
      route_kind: clientHubRouteKind(root.kind), detail_path: clientHubDetailPath(root) })),
    indexUpdatedAt: state.last_success_at,
    searchCapabilities: { businessContacts: true, portalContacts: false },
    nextCursor: roots.length > limit && last ? encodeCursor({ v: 2, revision: state.revision, q, kind: kind ?? null, policy,
      after: [last.sort_name, last.source_id, last.root_namespace, last.kind, last.public_id] }) : null,
  };
}

/** Exact-key lookup, independent of directory size. A legacy URL may resolve
 * only when its unqualified kind/public ID has a single source. */
export async function findClientHubRoot(env: Env, kind: ClientHubKind, publicId: string, sourceId?: string, rootNamespace?: string): Promise<ClientHubRoot> {
  if (!publicId || publicId.length > 512 || /[\0-\x1f\x7f]/.test(publicId) || (sourceId !== undefined && !isClientHubSource(sourceId)) ||
    (rootNamespace !== undefined && !isClientHubRootNamespace(rootNamespace)))
    throw new HTTPException(404, { message: "Client not found" });
  const db = env.OPS_DB.withSession("first-primary");
  const rows = await db.prepare(`SELECT root.* FROM client_hub_roots root
    WHERE root.kind=? AND root.public_id=? AND ${visibleRoot}${sourceId === undefined ? "" : " AND root.source_id=?"}
      ${rootNamespace === undefined ? "" : " AND root.root_namespace=?"} LIMIT 2`)
    .bind(kind, publicId, ...(sourceId === undefined ? [] : [sourceId]), ...(rootNamespace === undefined ? [] : [rootNamespace])).all<ClientHubRoot>();
  if (rows.results.length > 1)
    throw new HTTPException(409, { message: "This client link is ambiguous. Open the client from Client Hub" });
  if (rows.results[0]) return rows.results[0];
  const state = await db.prepare("SELECT ready FROM client_hub_directory_state WHERE id='directory'").first<{ ready: number }>();
  if (!state?.ready) unavailable();
  throw new HTTPException(404, { message: "Client not found" });
}
