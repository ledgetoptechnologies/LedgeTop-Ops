import { HTTPException } from "hono/http-exception";
import { hasLocalGlobalAllow, hasPermission, isAdministrator, sqlScope } from "./acl";
import { paProjectFilter } from "./visibility";
import { sha256 } from "./crypto";
import { isBusinessProjectionSource, validatedUniquePublicIdExpression, type ClientHubMappingStatus } from "./client-hub-source";
import type { Env, StaffPrincipal } from "./types";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import { readableBusinessPartySql } from "./business-parties";
import { businessActivityRecencyCte } from "./client-business-activity";

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
  source_name?: string;
  sort_name: string;
  status: string;
  portal_status: string;
  portal_access_state?: "active" | "revoked";
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

async function hydrateRootAccessStates<T extends Pick<ClientHubRoot,
  "source_id" | "root_namespace" | "kind" | "pa_public_id">>(env: Env, clients: T[]): Promise<Array<T & {
    portal_access_state: "active" | "revoked";
  }>> {
  if (env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED !== "true")
    return clients.map(client => ({ ...client, portal_access_state: "active" as const }));
  const roots = clients.flatMap(client => client.root_namespace === "business" && client.pa_public_id
    ? [{ sourceId: client.source_id, rootType: client.kind, rootPublicId: client.pa_public_id }] : []);
  if (!roots.length) return clients.map(client => ({ ...client, portal_access_state: "active" as const }));
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`WITH requested AS (
      SELECT json_extract(value,'$.sourceId') source_id,
        json_extract(value,'$.rootType') root_type,
        json_extract(value,'$.rootPublicId') root_public_id
      FROM json_each(?)
    ) SELECT policy.projection_source_id source_id,policy.root_type,policy.root_public_id,policy.state
    FROM portal_v2_root_access_policies policy JOIN requested
      ON requested.source_id=policy.projection_source_id AND requested.root_type=policy.root_type
      AND requested.root_public_id=policy.root_public_id
    WHERE policy.state='revoked' LIMIT 101`).bind(JSON.stringify(roots))
    .all<{ source_id: string; root_type: ClientHubKind; root_public_id: string; state: "revoked" }>();
  if (rows.results.length > 100) throw new HTTPException(503, { message: "Client portal status is temporarily unavailable" });
  const revoked = new Set(rows.results.map(row => JSON.stringify([row.source_id, row.root_type, row.root_public_id])));
  return clients.map(client => ({ ...client, portal_access_state: client.root_namespace === "business" && client.pa_public_id
    && revoked.has(JSON.stringify([client.source_id, client.kind, client.pa_public_id])) ? "revoked" : "active" }));
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
export interface ClientHubDirectoryQuery { q?: string; kind?: string; source?: string; cursor?: string; limit?: number; grouping?: string; sort?: string }
type Position = [string, string, ClientHubSource, ClientHubRootNamespace, ClientHubKind, string];
interface Cursor { v: 6; revision: number; activityRevision: number; asOf: string; sort: "recent" | "name";
  visibility: number; portalProof: string; source: ClientHubSource | null; q: string; kind: ClientHubKind | null;
  grouping: "customers" | "records"; policy: string; after: Position }

interface PortalContactRootProof {
  sourceId: ClientHubSource;
  workspaceId: string;
  rootType: ClientHubKind;
  rootPublicId: string;
  legacyRoot: boolean;
}
interface PortalContactProof { enabled: boolean; fingerprint: string; roots: PortalContactRootProof[] }
const EMPTY_PORTAL_PROOF = "0".repeat(43);
const MAX_PORTAL_CONTACT_MATCHES = 1000;
export const PORTAL_CONTACT_MINIMUM_QUERY_LENGTH = 3;
const PORTAL_CONTACT_SCHEMA = {
  portal_v2_workspaces: ["id", "root_type", "pa_organization_public_id", "pa_client_public_id", "project_alpha_source_id", "status"],
  pa_portal_workspace_sources: ["workspace_id", "projection_source_id"],
  portal_v2_directory_checkpoints: ["workspace_id", "active_generation_id", "source_sequence"],
  portal_v2_directory_generations: ["id", "workspace_id", "source_generation", "source_sequence", "status", "complete"],
  portal_v2_directory_entities: ["workspace_id", "generation_id", "entity_type", "parent_public_id", "active", "public_id"],
  pa_portal_principals: ["workspace_id", "public_id", "identity_id", "email_hint", "display_name", "source_version", "status", "updated_at"],
  portal_v2_identities: ["id", "verified_email", "status", "revoked_at", "updated_at"],
  portal_v2_workspace_memberships: ["workspace_id", "identity_id", "status", "revoked_at", "expires_at", "updated_at"],
  pa_portal_source_authorities: ["source_id", "state", "version"],
} as const;

function canonicalTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

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
const visibleSource = `(root.source_id='delivery:local' OR ${projectAlphaReadVisibleSql("root.source_id")})`;
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
/** The app's error boundary must retain this specific code so clients clear
 * already-loaded rows after a source's read visibility changes. */
export class ClientHubSourcesChangedError extends HTTPException {
  readonly code = "source_visibility_changed" as const;
  constructor() {
    const message = "Client sources changed. Refresh the results to continue.";
    super(409, { message, res: Response.json({ code: "source_visibility_changed", error: message }, { status: 409 }) });
  }
}
function sourcesChanged(): never {
  throw new ClientHubSourcesChangedError();
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
    if (cursor.v !== 6 || !["customers", "records"].includes(cursor.grouping ?? "") || !Number.isSafeInteger(cursor.revision) || cursor.revision! < 0 ||
      !Number.isSafeInteger(cursor.activityRevision) || cursor.activityRevision! < 0 || !canonicalTime(cursor.asOf) || Date.parse(cursor.asOf) > Date.now() ||
      !["recent", "name"].includes(cursor.sort ?? "") ||
      !Number.isSafeInteger(cursor.visibility) || cursor.visibility! < 1 ||
      (cursor.source !== null && (typeof cursor.source !== "string" || !isClientHubSource(cursor.source))) ||
      typeof cursor.q !== "string" || typeof cursor.policy !== "string" || typeof cursor.portalProof !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(cursor.portalProof) ||
      (cursor.kind !== null && (typeof cursor.kind !== "string" || !isClientHubKind(cursor.kind))) ||
      !Array.isArray(cursor.after) || cursor.after.length !== 6 ||
      !cursor.after.every(item => typeof item === "string" && item.length <= 512) ||
      (cursor.after[0] !== "" && (!canonicalTime(cursor.after[0]) || cursor.after[0] > cursor.asOf)) ||
      !isClientHubSource(cursor.after[2]) || !isClientHubRootNamespace(cursor.after[3]) || !isClientHubKind(cursor.after[4])) throw new Error();
    return cursor as Cursor;
  } catch { throw new HTTPException(400, { message: "Client directory cursor is invalid" }); }
}

async function portalContactSchemaReady(database: Pick<D1Database, "prepare" | "batch">): Promise<boolean> {
  const tables = Object.keys(PORTAL_CONTACT_SCHEMA) as Array<keyof typeof PORTAL_CONTACT_SCHEMA>;
  const results = await database.batch<{ name: string }>(tables.map(table => database.prepare(`PRAGMA table_info('${table}')`)));
  return tables.every((table, index) => {
    const present = new Set(results[index]?.results.flatMap(row => typeof row.name === "string" ? [row.name] : []) ?? []);
    return PORTAL_CONTACT_SCHEMA[table].every(column => present.has(column));
  });
}
function portalProofTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)
    && Number.isFinite(Date.parse(normalized));
}

/** Resolve search matches from current portal authority before Operations
 * pagination. The caller receives only exact source/workspace/root keys;
 * principal and identity facts never cross this boundary. */
async function portalContactProof(env: Env, q: string): Promise<PortalContactProof> {
  if (!env.DELIVERY_DB) return { enabled: false, fingerprint: EMPTY_PORTAL_PROOF, roots: [] };
  const database = env.DELIVERY_DB.withSession("first-primary");
  if (!(await portalContactSchemaReady(database)))
    return { enabled: false, fingerprint: EMPTY_PORTAL_PROOF, roots: [] };
  if (q.length < PORTAL_CONTACT_MINIMUM_QUERY_LENGTH)
    return { enabled: true, fingerprint: EMPTY_PORTAL_PROOF, roots: [] };
  const rows = (await database.prepare(`SELECT
      workspace.project_alpha_source_id source_id,workspace.id workspace_id,workspace.root_type,
      CASE workspace.root_type WHEN 'organization' THEN workspace.pa_organization_public_id ELSE workspace.pa_client_public_id END root_public_id,
      CASE WHEN generation.source_generation='legacy-backfill' THEN 1 ELSE 0 END legacy_root,
      principal.public_id principal_public_id,checkpoint.active_generation_id,checkpoint.source_sequence,
      principal.source_version,principal.updated_at principal_updated_at,identity.updated_at identity_updated_at,
      membership.updated_at membership_updated_at,COALESCE(authority.version,0) authority_version
      FROM pa_portal_principals principal
      JOIN portal_v2_workspaces workspace ON workspace.id=principal.workspace_id AND workspace.status='active'
      JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id
        AND owner.projection_source_id=workspace.project_alpha_source_id
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=workspace.id AND generation.source_sequence=checkpoint.source_sequence
        AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities root_entity ON root_entity.workspace_id=workspace.id AND root_entity.generation_id=generation.id
        AND root_entity.entity_type=workspace.root_type AND root_entity.parent_public_id IS NULL AND root_entity.active=1
        AND root_entity.public_id=CASE workspace.root_type WHEN 'organization' THEN workspace.pa_organization_public_id ELSE workspace.pa_client_public_id END
      JOIN portal_v2_identities identity ON identity.id=principal.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id
        AND membership.identity_id=identity.id AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR membership.expires_at>datetime('now'))
      LEFT JOIN pa_portal_source_authorities authority ON authority.source_id=workspace.project_alpha_source_id
      WHERE principal.status='active' AND (workspace.project_alpha_source_id='project-alpha:primary' OR authority.state='active')
        AND (instr(lower(principal.display_name),?)>0 OR instr(lower(principal.email_hint),?)>0
          OR instr(lower(COALESCE(identity.verified_email,'')),?)>0)
      ORDER BY workspace.project_alpha_source_id,workspace.id,principal.public_id LIMIT ?`)
    .bind(q, q, q, MAX_PORTAL_CONTACT_MATCHES + 1).all<Record<string, unknown>>()).results;
  if (rows.length > MAX_PORTAL_CONTACT_MATCHES)
    throw new HTTPException(413, { message: "Too many portal contacts match. Refine the client search." });
  const facts = rows.map(row => {
      const sourceId = row.source_id, workspaceId = row.workspace_id, rootType = row.root_type,
        rootPublicId = row.root_public_id, principalPublicId = row.principal_public_id,
        generationId = row.active_generation_id, sourceVersion = row.source_version,
        principalUpdatedAt = row.principal_updated_at, identityUpdatedAt = row.identity_updated_at,
        membershipUpdatedAt = row.membership_updated_at;
      if (typeof sourceId !== "string" || !isBusinessProjectionSource(sourceId)
        || typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 512
        || typeof rootType !== "string" || !isClientHubKind(rootType)
        || typeof rootPublicId !== "string" || !rootPublicId || rootPublicId.length > 512
        || typeof principalPublicId !== "string" || !principalPublicId || principalPublicId.length > 512
        || typeof generationId !== "string" || !generationId || generationId.length > 512
        || typeof sourceVersion !== "string" || !sourceVersion || sourceVersion.length > 512
        || !portalProofTimestamp(principalUpdatedAt) || !portalProofTimestamp(identityUpdatedAt)
        || !portalProofTimestamp(membershipUpdatedAt)
        || !Number.isSafeInteger(Number(row.source_sequence)) || Number(row.source_sequence) <= 0
        || !Number.isSafeInteger(Number(row.authority_version)) || Number(row.authority_version) < 0
        || ![0, 1].includes(Number(row.legacy_root))) unavailable();
      return { sourceId, workspaceId, rootType, rootPublicId, legacyRoot: Number(row.legacy_root) === 1,
        principalPublicId, generationId, sourceSequence: Number(row.source_sequence), sourceVersion,
        principalUpdatedAt, identityUpdatedAt, membershipUpdatedAt, authorityVersion: Number(row.authority_version) };
  });
  const roots = new Map<string, PortalContactRootProof>();
  for (const { principalPublicId: _principalPublicId, generationId: _generationId, sourceSequence: _sourceSequence,
    sourceVersion: _sourceVersion, principalUpdatedAt: _principalUpdatedAt, identityUpdatedAt: _identityUpdatedAt,
    membershipUpdatedAt: _membershipUpdatedAt, authorityVersion: _authorityVersion, ...root } of facts)
    roots.set(JSON.stringify([root.sourceId, root.workspaceId, root.rootType, root.rootPublicId, root.legacyRoot]), root);
  return { enabled: true, fingerprint: await sha256(JSON.stringify(facts)), roots: [...roots.values()] };
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
  if (options.source !== undefined && !isClientHubSource(options.source))
    throw new HTTPException(400, { message: "Client directory source is invalid" });
  const source = options.source as ClientHubSource | undefined;
  if ((options.q?.length ?? 0) > 200 || /[\0-\x1f\x7f]/.test(options.q ?? ""))
    throw new HTTPException(400, { message: "Client directory search is invalid" });
  const q = normalizeClientHubText(options.q ?? "");
  const portal = await portalContactProof(env, q);
  const grouping = options.grouping ?? "customers";
  if (grouping !== "customers" && grouping !== "records")
    throw new HTTPException(400, { message: "Client directory grouping is invalid" });
  const sort = options.sort ?? "recent";
  if (sort !== "recent" && sort !== "name")
    throw new HTTPException(400, { message: "Client directory sort is invalid" });
  const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
  const asOf = cursor?.asOf ?? new Date().toISOString();
  const { filter, policy } = await projectSearchAccess(env, principal);
  if (cursor && (cursor.q !== q || cursor.kind !== (kind ?? null) || cursor.source !== (source ?? null) || cursor.grouping !== grouping
    || cursor.sort !== sort || cursor.policy !== policy || cursor.portalProof !== portal.fingerprint))
    throw new HTTPException(400, { message: "Client directory cursor does not match this search" });
  const clauses = [visibleRoot, visibleSource, liveBusinessRoot], values: unknown[] = [];
  if (kind) { clauses.push("root.kind=?"); values.push(kind); }
  if (source) { clauses.push("root.source_id=?"); values.push(source); }
  if (q) {
    const phone = /^[\d\s()+.\-]+$/.test(q) ? normalizeClientHubPhone(q) : "";
    // D1 limits LIKE/GLOB patterns to 50 bytes. Literal instr supports the full
    // 200-character search contract without wildcard interpretation.
    const portalRoots = JSON.stringify(portal.roots);
    clauses.push(`(instr(root.sort_name,?)>0 OR instr(party.sort_name,?)>0 OR EXISTS (
      SELECT 1 FROM client_hub_search_values search WHERE search.source_id=root.source_id
        AND search.root_namespace=root.root_namespace AND search.kind=root.kind AND search.root_public_id=root.public_id
        AND ((search.root_namespace='business'
          AND (instr(search.normalized_value,?)>0${phone.length >= 3 ? " OR (search.field='phone' AND instr(search.normalized_value,?)>0)" : ""})
          AND ((search.record_type='pa_client' AND search.project_id IS NULL AND EXISTS (
            SELECT 1 FROM pa_clients contact WHERE contact.id=search.record_id AND contact.projection_source_id=root.source_id AND contact.active=1 AND
              ((root.kind='organization' AND contact.organization_id=root.public_id) OR
               (root.kind='standalone_client' AND contact.id=root.public_id AND contact.organization_id IS NULL))))
          OR (search.record_type='pa_project' AND search.record_id=search.project_id AND EXISTS (
            SELECT 1 FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
            WHERE p.id=search.project_id AND p.projection_source_id=root.source_id AND ${filter.sql} AND
              ((root.kind='organization' AND COALESCE(p.organization_id,owner.organization_id)=root.public_id) OR
               (root.kind='standalone_client' AND p.client_id=root.public_id AND owner.id IS NOT NULL
                 AND COALESCE(p.organization_id,owner.organization_id) IS NULL))))))
        OR (search.record_type='portal_principal' AND EXISTS (
          SELECT 1 FROM json_each(?) proof WHERE
            json_extract(proof.value,'$.sourceId')=root.source_id
            AND json_extract(proof.value,'$.workspaceId')=root.workspace_id
            AND json_extract(proof.value,'$.rootType')=root.kind
            AND (json_extract(proof.value,'$.rootPublicId')=${currentMapping}
              OR (json_extract(proof.value,'$.legacyRoot')=1 AND root.source_id='project-alpha:primary'
                AND root.legacy_account_id IS NOT NULL AND json_extract(proof.value,'$.rootPublicId')=root.public_id)))))))`);
    values.push(q, q, q);
    if (phone.length >= 3) values.push(phone);
    values.push(...filter.values);
    values.push(portalRoots);
  }
  // Match and authorize individual records first, then collapse the matching
  // records into customers before LIMIT/cursor application. Browser-only
  // deduplication would skip customers or repeat a party across pages.
  const afterName = "(root.display_sort_name,root.source_id,root.root_namespace,root.kind,root.public_id)>(?,?,?,?,?)";
  const pageAfter = !cursor ? "" : sort === "name" ? `AND ${afterName}`
    : `AND (COALESCE(root.live_activity_at,'')<? OR (COALESCE(root.live_activity_at,'')=? AND ${afterName}))`;
  const activity = businessActivityRecencyCte(filter, asOf);
  const pageValues = [...activity.values, ...values,
    ...(cursor ? [...(sort === "recent" ? [cursor.after[0], cursor.after[0]] : []), ...cursor.after.slice(1)] : []), limit + 1];
  const db = env.OPS_DB.withSession("first-primary");
  // State and page share one transaction. The writer advances revision only
  // alongside effective root/search changes, so mutable names cannot skip rows.
  type Snapshot = Pick<ClientHubDirectoryState, "revision" | "ready" | "last_success_at"> & { source_read_revision: number | null; activity_revision: number | null };
  type LiveRoot = ClientHubRoot & { live_pa_public_id: string | null; business_party_id: string | null;
    business_party_name: string | null; business_party_member_count: number | null; display_sort_name: string; party_rank: number; live_activity_at: string | null };
  type SourceSummary = { source_id: ClientHubSource; display_name: string };
  const results = await db.batch<LiveRoot | Snapshot | SourceSummary>([
    db.prepare(`SELECT revision,ready,last_success_at,
      (SELECT revision FROM client_business_activity_state WHERE singleton=1) activity_revision,
      (SELECT read_revision FROM pa_connector_directory_state WHERE id='directory') source_read_revision
      FROM client_hub_directory_state WHERE id='directory'`),
    db.prepare(`WITH ${activity.sql}, matching AS (
      SELECT root.*,${currentMapping} live_pa_public_id,
        party.id business_party_id,party.display_name business_party_name,
        CASE WHEN ${grouping === "customers" ? "party.id IS NOT NULL" : "0=1"} THEN (
          SELECT max(member_activity.meaningful_activity_at) FROM business_party_links member
          JOIN business_activity_roots member_activity ON member_activity.source_id=member.source_id
            AND member_activity.root_id=member.record_id AND member_activity.root_kind=CASE member.record_kind WHEN 'organization' THEN 'organization' ELSE 'standalone_client' END
          WHERE member.party_id=party.id AND member.unlinked_at IS NULL
        ) ELSE activity.meaningful_activity_at END live_activity_at,
        ${grouping === "customers" ? "COALESCE(party.sort_name,root.sort_name)" : "root.sort_name"} display_sort_name,
        CASE WHEN party.id IS NOT NULL THEN (SELECT count(*) FROM business_party_links members
          WHERE members.party_id=party.id AND members.unlinked_at IS NULL) END business_party_member_count
      FROM client_hub_roots root
      LEFT JOIN business_activity_roots activity ON root.root_namespace='business'
        AND activity.source_id=root.source_id AND activity.root_kind=root.kind AND activity.root_id=root.public_id
      LEFT JOIN business_party_links membership ON root.root_namespace='business'
        AND membership.source_id=root.source_id AND membership.record_id=root.public_id
        AND membership.record_kind=CASE root.kind WHEN 'organization' THEN 'organization' ELSE 'client' END
        AND membership.unlinked_at IS NULL
      LEFT JOIN business_parties party ON party.id=membership.party_id AND party.status='active'
        AND ${readableBusinessPartySql("party.id")}
      WHERE ${clauses.join(" AND ")}
    ), ranked AS (
      SELECT matching.*,row_number() OVER (
        PARTITION BY CASE WHEN ${grouping === "customers" ? "business_party_id IS NOT NULL" : "0=1"} THEN json_array('party',business_party_id)
          ELSE json_array('record',source_id,root_namespace,kind,public_id) END
        ORDER BY sort_name,source_id,root_namespace,kind,public_id
      ) party_rank FROM matching
    ) SELECT root.* FROM ranked root WHERE party_rank=1 ${pageAfter}
      ORDER BY ${sort === "recent" ? "COALESCE(root.live_activity_at,'') DESC," : ""}root.display_sort_name,root.source_id,root.root_namespace,root.kind,root.public_id LIMIT ?`).bind(...pageValues),
    db.prepare(`SELECT source_id,display_name FROM pa_connectors WHERE read_visible=1
      UNION ALL SELECT 'project-alpha:primary','Project Alpha' WHERE NOT EXISTS (
        SELECT 1 FROM pa_connectors WHERE source_id='project-alpha:primary')
      UNION ALL SELECT 'delivery:local','Local delivery'
      ORDER BY display_name COLLATE NOCASE,source_id LIMIT 35`),
  ]);
  const state = results[0]!.results.find((row): row is Snapshot => "revision" in row);
  if (!state?.ready) unavailable();
  if (!Number.isSafeInteger(state.source_read_revision) || state.source_read_revision! < 1) unavailable();
  if (!Number.isSafeInteger(state.activity_revision) || state.activity_revision! < 0) unavailable();
  if (cursor && cursor.visibility !== state.source_read_revision) sourcesChanged();
  const sources = results[2]!.results.filter((row): row is SourceSummary => "source_id" in row && "display_name" in row);
  if (sources.length > 34) unavailable();
  if (source && !sources.some(item => item.source_id === source))
    throw new HTTPException(404, { message: "Client source is unavailable" });
  if (cursor && cursor.revision !== state.revision) changed();
  if (cursor && cursor.activityRevision !== state.activity_revision) changed();
  // Permissions are read before the SQL batch. Recheck them and the effective
  // source/ownership epoch before releasing names or permission-scoped recency.
  // No claim of a cross-request snapshot: a changed context requires a reload.
  const [currentScope, currentProjectAccess, currentState, currentPortal] = await Promise.all([
    sqlScope(env, principal, "team.view"), projectSearchAccess(env, principal),
    env.OPS_DB.withSession("first-primary").prepare(`SELECT revision,
      (SELECT revision FROM client_business_activity_state WHERE singleton=1) activity_revision,
      (SELECT read_revision FROM pa_connector_directory_state WHERE id='directory') source_read_revision
      FROM client_hub_directory_state WHERE id='directory'`).first<Snapshot>(), portalContactProof(env, q),
  ]);
  if (!currentScope.global || currentScope.deniedGlobal)
    throw new HTTPException(403, { message: "Global team.view permission required" });
  if (currentState?.source_read_revision !== state.source_read_revision) sourcesChanged();
  if (currentPortal.fingerprint !== portal.fingerprint) changed();
  if (currentProjectAccess.policy !== policy || currentState?.revision !== state.revision || currentState?.activity_revision !== state.activity_revision) changed();
  const roots = results[1]!.results.filter((row): row is LiveRoot => "root_namespace" in row);
  const page = roots.slice(0, limit);
  const last = page.at(-1);
  const clients = page.map(({ live_pa_public_id, party_rank: _rank, display_sort_name: _displaySort, live_activity_at, business_party_id, business_party_name, business_party_member_count, ...root }) => ({ ...root,
      meaningful_activity_at: live_activity_at,
      ...(root.root_namespace === "business" && root.pa_public_id !== live_pa_public_id ? {
        pa_public_id: live_pa_public_id, mapping_status: live_pa_public_id ? "mapped" : "missing",
        workspace_id: null, portal_status: "mapping_unavailable",
      } : {}),
      source_name: sources.find(item => item.source_id === root.source_id)!.display_name,
      ...(business_party_id ? { business_party_id, business_party_name, business_party_member_count } : {}),
      route_kind: clientHubRouteKind(root.kind), detail_path: business_party_id && grouping === "customers"
        ? `/clients/parties/${encodeURIComponent(business_party_id)}` : clientHubDetailPath(root) }));
  return {
    clients: await hydrateRootAccessStates(env, clients),
    indexUpdatedAt: state.last_success_at,
    activityAsOf: asOf,
    activityCoverage: "project_alpha_business_records" as const,
    sort,
    sources,
    searchCapabilities: { businessContacts: true, portalContacts: portal.enabled,
      ...(portal.enabled ? { portalContactMinimumQueryLength: PORTAL_CONTACT_MINIMUM_QUERY_LENGTH } : {}) },
    nextCursor: roots.length > limit && last ? encodeCursor({ v: 6, revision: state.revision, activityRevision: state.activity_revision!, asOf, sort, visibility: state.source_read_revision!, portalProof: portal.fingerprint,
      source: source ?? null, q, kind: kind ?? null, grouping, policy,
      after: [last.live_activity_at ?? "", last.display_sort_name, last.source_id, last.root_namespace, last.kind, last.public_id] }) : null,
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
    WHERE root.kind=? AND root.public_id=? AND ${visibleRoot} AND ${visibleSource} AND ${liveBusinessRoot}${sourceId === undefined ? "" : " AND root.source_id=?"}
      ${rootNamespace === undefined ? "" : " AND root.root_namespace=?"} LIMIT 2`)
    .bind(kind, publicId, ...(sourceId === undefined ? [] : [sourceId]), ...(rootNamespace === undefined ? [] : [rootNamespace])).all<ClientHubRoot>();
  if (rows.results.length > 1)
    throw new HTTPException(409, { message: "This client link is ambiguous. Open the client from Client Hub" });
  if (rows.results[0]) return rows.results[0];
  const state = await db.prepare("SELECT ready FROM client_hub_directory_state WHERE id='directory'").first<{ ready: number }>();
  if (!state?.ready) unavailable();
  throw new HTTPException(404, { message: "Client not found" });
}
