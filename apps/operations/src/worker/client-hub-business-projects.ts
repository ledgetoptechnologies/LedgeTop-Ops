import { HTTPException } from "hono/http-exception";
import { sha256 } from "./crypto";
import { isBusinessProjectionSource, resolveClientHubSourceRoot } from "./client-hub-source";
import { readClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
import type { SqlFilter } from "./visibility";
import type { ClientHubCollectionContext, ClientHubCollectionResult } from "./client-hub-collections";
import type { Env, StaffPrincipal } from "./types";

export const BUSINESS_PROJECT_FILTERS = ["all", "current", "completed", "cancelled"] as const;
export type BusinessProjectFilter = typeof BUSINESS_PROJECT_FILTERS[number];
interface Cursor {
  v: 1; collection: "businessProjects"; root: string[]; context: string; policy: string; source: string;
  filter: BusinessProjectFilter; after: [string, string];
}
interface ProjectRow extends Record<string, unknown> { id: string; __created: string }

function eligible(context: ClientHubCollectionContext): boolean {
  const root = context.root;
  return isBusinessProjectionSource(root.source_id) && root.root_namespace === "business";
}
function rootTuple(context: ClientHubCollectionContext): string[] {
  const root = context.root;
  return [root.source_id, root.root_namespace, root.kind, root.public_id];
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0-\x1f\x7f]/.test(value);
}
function isFilter(value: unknown): value is BusinessProjectFilter {
  return typeof value === "string" && (BUSINESS_PROJECT_FILTERS as readonly string[]).includes(value);
}
function encode(cursor: Cursor): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(cursor)), byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(raw: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(raw)) throw new Error();
    const bytes = Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), value => value.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Partial<Cursor>;
    if (!value || value.v !== 1 || value.collection !== "businessProjects" || !isFilter(value.filter)
      || !Array.isArray(value.root) || value.root.length !== 4 || !value.root.every(validId)
      || ![value.context, value.policy, value.source].every(item => typeof item === "string" && /^[A-Za-z0-9_-]{43}$/.test(item))
      || !Array.isArray(value.after) || value.after.length !== 2 || !validId(value.after[1])
      || typeof value.after[0] !== "string" || !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value.after[0])) throw new Error();
    return value as Cursor;
  } catch { throw new HTTPException(400, { message: "Business project cursor is invalid" }); }
}

export async function clientHubBusinessProjectSourceProof(env: Env, context: ClientHubCollectionContext): Promise<string> {
  const root = context.root;
  if (!validId(root.public_id) || !["organization", "standalone_client"].includes(root.kind))
    throw new HTTPException(404, { message: "Client not found" });
  const source = await resolveClientHubSourceRoot(env, root.kind, root.public_id, root.source_id);
  if (!source?.active || (root.kind === "standalone_client" && source.organization_id !== null))
    throw new HTTPException(404, { message: "Client not found" });
  return sha256(JSON.stringify([rootTuple(context), source.id, source.active, source.organization_id,
    source.pa_public_id, source.mapping_status]));
}

export function clientHubBusinessProjectOwnership(context: ClientHubCollectionContext): SqlFilter {
  return context.root.kind === "organization"
    ? { sql: "p.projection_source_id=? AND (p.organization_id=? OR (p.organization_id IS NULL AND owner.organization_id=?))", values: [context.root.source_id, context.root.public_id, context.root.public_id] }
    : { sql: "p.projection_source_id=? AND p.client_id=? AND owner.id IS NOT NULL AND owner.organization_id IS NULL AND p.organization_id IS NULL", values: [context.root.source_id, context.root.public_id] };
}
function statusFilter(filter: BusinessProjectFilter): string {
  if (filter === "current") return " AND p.status IN ('not_started','active','overdue')";
  if (filter === "completed") return " AND p.status='completed'";
  if (filter === "cancelled") return " AND p.status='cancelled'";
  return "";
}
function changed(): never {
  throw new HTTPException(409, { message: "Project ownership or permissions changed. Refresh the client workspace to continue" });
}

/** Business history is independent of delivery grants. Source-created dates
 * are normalized to UTC; missing/invalid dates sort last. Neither local sync
 * timestamps nor source creation dates are described as recent activity.
 * Pages are live reads, not immutable snapshots. Callers must also recheck the
 * shared Client Hub context after hydration, as for the other collections. */
export async function listClientHubBusinessProjects(env: Env, principal: StaffPrincipal,
  context: ClientHubCollectionContext,
  options: { limit?: number; cursor?: string; initial?: boolean; filter?: BusinessProjectFilter } = {},
): Promise<ClientHubCollectionResult> {
  const limit = options.limit ?? (options.initial ? 5 : 25), filter = options.filter ?? "all";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HTTPException(400, { message: "Business project limit must be between 1 and 100" });
  if (!isFilter(filter)) throw new HTTPException(400, { message: "Business project filter is invalid" });
  const cursor = options.cursor === undefined ? null : decode(options.cursor);
  if (cursor && (cursor.filter !== filter || JSON.stringify(cursor.root) !== JSON.stringify(rootTuple(context))))
    throw new HTTPException(400, { message: "Business project cursor does not match this client or filter" });
  if (cursor && cursor.context !== context.contextVersion) changed();
  const policy = await readClientHubBusinessProjectPolicy(env, principal);
  const reason = !context.access.directory || !policy.allowed ? "permission_required" : !eligible(context) ? "not_applicable" : null;
  if (reason === "permission_required" && !options.initial)
    throw new HTTPException(403, { message: "Client directory and project-view permissions are required" });
  const response: ClientHubCollectionResult = { items: [], canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
    page: { available: reason === null, reason, nextCursor: null, hasMore: false, returned: 0, limit } };
  if (reason) return response;
  const source = await clientHubBusinessProjectSourceProof(env, context);
  if (cursor && (cursor.policy !== policy.proof || cursor.source !== source)) changed();
  const owner = clientHubBusinessProjectOwnership(context);
  const where = `(${owner.sql}) AND (${policy.filter.sql})${statusFilter(filter)}`;
  const values = [...owner.values, ...policy.filter.values];
  // Nested CASE guards malformed/scalar legacy JSON. Requiring a date prefix
  // excludes SQLite-relative inputs such as "now" before parsing the date.
  const rawDate = `CASE WHEN json_valid(p.payload_json) THEN CASE WHEN json_type(p.payload_json,'$.created_at')='text'
    THEN json_extract(p.payload_json,'$.created_at') END END`;
  const rows = (await env.OPS_DB.withSession("first-primary").prepare(`WITH owned AS (
    SELECT p.id,p.name,p.status,p.start_date,p.end_date,p.client_id,p.organization_id,
      p.manager_user_id,manager.display_name manager_name,${rawDate} source_created_at
    FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
      LEFT JOIN pa_users manager ON manager.id=p.manager_user_id AND manager.projection_source_id=p.projection_source_id
    WHERE ${where}
  ), dated AS (
    SELECT *,CASE WHEN length(source_created_at) BETWEEN 10 AND 64
      AND source_created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
      AND strftime('%Y-%m-%d',substr(source_created_at,1,10),'+0 days')=substr(source_created_at,1,10)
      THEN strftime('%Y-%m-%dT%H:%M:%fZ',source_created_at) END created_at FROM owned
  ) SELECT id,name,status,start_date,end_date,client_id,organization_id,manager_user_id,manager_name,created_at,
      COALESCE(created_at,'') __created FROM dated
    ${cursor ? "WHERE (COALESCE(created_at,''),id)<(?,?)" : ""}
    ORDER BY COALESCE(created_at,'') DESC,id DESC LIMIT ?`)
    .bind(...values, ...(cursor?.after ?? []), limit + 1).all<ProjectRow>()).results;
  const pageRows = rows.slice(0, limit);

  const [currentPolicy, currentSource] = await Promise.all([
    readClientHubBusinessProjectPolicy(env, principal), clientHubBusinessProjectSourceProof(env, context),
  ]);
  if (currentPolicy.proof !== policy.proof || currentSource !== source) changed();
  // Assignment and individual project/client ownership can change independently
  // of the root proof. Recheck every returned ID through live SQL before release.
  // Bounded chunks leave room for the owner/assignment parameters in D1.
  for (let start = 0; start < pageRows.length; start += 40) {
    const ids = pageRows.slice(start, start + 40).map(row => row.id);
    const count = await env.OPS_DB.withSession("first-primary").prepare(`SELECT count(*) count FROM pa_projects p
      LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
      WHERE ${where} AND p.id IN (${ids.map(() => "?").join(",")})`).bind(...values, ...ids).first<number>("count");
    if (count !== ids.length) changed();
  }
  response.page.returned = pageRows.length;
  response.page.hasMore = rows.length > limit;
  if (response.page.hasMore) {
    const last = pageRows[pageRows.length - 1]!;
    response.page.nextCursor = encode({ v: 1, collection: "businessProjects", root: rootTuple(context),
      context: context.contextVersion, policy: policy.proof, source, filter, after: [last.__created, last.id] });
  }
  response.items = pageRows.map(({ __created: _created, ...row }) => ({ ...row,
    row_key: JSON.stringify(["businessProjects", context.root.source_id, row.id]) }));
  return response;
}
