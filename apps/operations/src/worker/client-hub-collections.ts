import { HTTPException } from "hono/http-exception";
import { sha256 } from "./crypto";
import { isAdministrator } from "./acl";
import { eligibilityBlockManagementEnabled, portalOperationsManagementEnabled } from "./client-identity-eligibility";
import { readClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
import type { ClientHubRoot } from "./client-hub-directory";
import type { Env, StaffPrincipal } from "./types";

export const CLIENT_HUB_COLLECTIONS = ["businessContacts", "accounts", "projects", "requests", "deliveryGrants",
  "authenticatedDeliveryGrants", "viewerGrants"] as const;
export type ClientHubCollection = (typeof CLIENT_HUB_COLLECTIONS)[number];
export interface ClientHubPermissions { directory: boolean; requests: boolean; delivery: boolean; viewer: boolean }
export interface ClientHubCollectionPage {
  available: boolean;
  reason: "permission_required" | "workspace_unavailable" | "not_applicable" | null;
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  limit: number;
}
export interface ClientHubCollectionContext {
  root: ClientHubRoot;
  access: ClientHubPermissions;
  contextVersion: string;
  canonicalRoot: { sourceId: string; rootNamespace: string; kind: string; publicId: string };
}
export interface ClientHubCollectionResult {
  items: Array<Record<string, unknown>>;
  page: ClientHubCollectionPage;
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"];
  contextVersion: string;
}
interface Cursor { v: 1; root: string[]; collection: ClientHubCollection; context: string; after: string[] }
interface Query {
  select: string; from: string; where: string; values: string[]; order: string[]; descending: boolean;
  keys: string[]; business?: boolean;
}

export function isClientHubCollection(value: string): value is ClientHubCollection {
  return (CLIENT_HUB_COLLECTIONS as readonly string[]).includes(value);
}

/** This proof is deliberately live, not the periodically reconciled directory
 * revision or snapshot-only fingerprints. It invalidates pages after mapping,
 * selected projection proof, actor, or permission changes. It is not a grant. */
export async function createClientHubCollectionContext(env: Env, principal: StaffPrincipal,
  root: ClientHubRoot, access: ClientHubPermissions): Promise<ClientHubCollectionContext> {
  const scope = accountScope(root);
  // Migration 0103 uniquely indexes each non-null Alpha organization/client
  // account link; local roots identify exactly one account and portal roots none.
  // Keep this proof bounded and fail closed if that invariant is ever violated.
  const accountProof = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT account.id,account.status,
    account.project_alpha_client_id,account.project_alpha_organization_id FROM client_accounts account
    WHERE ${scope.where} ORDER BY account.id LIMIT 2`).bind(...scope.values).all<Record<string, unknown>>();
  if (accountProof.results.length > 1)
    throw new HTTPException(409, { message: "This client's account association is ambiguous and needs review" });
  const proof = root.workspace_id ? await env.DELIVERY_DB.withSession("first-primary").prepare(`
    SELECT workspace.id,workspace.root_type,workspace.status,workspace.legacy_account_id,
      workspace.pa_organization_public_id,workspace.pa_client_public_id,
      checkpoint.active_generation_id,checkpoint.source_sequence,
      generation.source_generation,generation.status generation_status,generation.complete,
      entity.public_id entity_public_id,entity.source_version,entity.active entity_active
    FROM portal_v2_workspaces workspace
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.source_sequence=checkpoint.source_sequence
    JOIN portal_v2_directory_entities entity ON entity.workspace_id=workspace.id
      AND entity.generation_id=generation.id AND entity.entity_type=workspace.root_type
      AND entity.parent_public_id IS NULL
      AND entity.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
    WHERE workspace.id=? ORDER BY entity.public_id LIMIT 2`).bind(root.workspace_id).all<Record<string, unknown>>() : null;
  const canonicalRoot = { sourceId: root.source_id, rootNamespace: root.root_namespace, kind: root.kind, publicId: root.public_id };
  const businessProjectPolicy = await readClientHubBusinessProjectPolicy(env, principal);
  const contextVersion = await sha256(JSON.stringify([canonicalRoot, principal.id, access,
    root.pa_public_id, root.mapping_status, root.status, root.workspace_id, root.legacy_account_id,
    root.portal_status, proof?.results ?? [], accountProof.results, await isAdministrator(env, principal),
    eligibilityBlockManagementEnabled(env), portalOperationsManagementEnabled(env), businessProjectPolicy.proof]));
  return { root, access, canonicalRoot, contextVersion };
}

function rootTuple(context: ClientHubCollectionContext): string[] {
  const root = context.root;
  return [root.source_id, root.root_namespace, root.kind, root.public_id];
}
function encode(cursor: Cursor): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(cursor)), byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error();
    const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const cursor = parsed as Partial<Cursor>;
    if (cursor.v !== 1 || typeof cursor.collection !== "string" || !isClientHubCollection(cursor.collection)
      || typeof cursor.context !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(cursor.context)
      || !Array.isArray(cursor.root) || cursor.root.length !== 4
      || !cursor.root.every(item => typeof item === "string" && item.length <= 512)
      || !Array.isArray(cursor.after) || cursor.after.length < 1 || cursor.after.length > 3
      || !cursor.after.every(item => typeof item === "string" && item.length <= 512)) throw new Error();
    return cursor as Cursor;
  } catch { throw new HTTPException(400, { message: "Client collection cursor is invalid" }); }
}
function accountScope(root: ClientHubRoot): { where: string; values: string[] } {
  if (root.root_namespace === "portal") return { where: "0=1", values: [] };
  if (root.root_namespace === "account") return { where: "account.id=? AND account.project_alpha_client_id IS NULL AND account.project_alpha_organization_id IS NULL", values: [root.public_id] };
  return { where: root.kind === "organization" ? "account.project_alpha_organization_id=?"
    : "account.project_alpha_client_id=? AND account.project_alpha_organization_id IS NULL", values: [root.public_id] };
}
function availability(context: ClientHubCollectionContext, collection: ClientHubCollection): ClientHubCollectionPage["reason"] {
  if (!context.access.directory || (collection === "requests" && !context.access.requests)
    || (["deliveryGrants", "authenticatedDeliveryGrants"].includes(collection) && !context.access.delivery)
    || (collection === "viewerGrants" && !context.access.viewer)) return "permission_required";
  if (collection === "authenticatedDeliveryGrants" && !context.root.workspace_id) return "workspace_unavailable";
  if (collection === "businessContacts" && (context.root.source_id !== "project-alpha:primary"
    || context.root.root_namespace !== "business")) return "not_applicable";
  return null;
}
function collectionQuery(context: ClientHubCollectionContext, collection: ClientHubCollection): Query {
  const root = context.root, scope = accountScope(root);
  const common = { where: scope.where, values: scope.values, descending: true };
  switch (collection) {
    case "businessContacts": return { select: "id public_id,organization_id,name display_name", from: "pa_clients",
      where: `active=1 AND ${root.kind === "organization" ? "organization_id=?" : "id=? AND organization_id IS NULL"}`,
      values: [root.public_id], order: ["id"], descending: false, keys: ["public_id"], business: true };
    case "accounts": return { ...common,
      select: "account.id,account.display_name,account.status,account.project_alpha_client_id,account.project_alpha_organization_id,account.created_at,account.updated_at",
      from: "client_accounts account", order: ["COALESCE(account.created_at,'')", "account.id"], keys: ["id"] };
    case "projects": return { ...common,
      select: "project.id,project.project_name,project.client_name,project.r2_prefix,project.active,project.project_alpha_project_id,project_grant.account_id,project_grant.can_request_service,project_grant.granted_at",
      from: "client_project_grants project_grant JOIN client_accounts account ON account.id=project_grant.account_id JOIN projects project ON project.id=project_grant.project_id",
      where: `${scope.where} AND project_grant.revoked_at IS NULL`,
      order: ["COALESCE(project_grant.granted_at,'')", "project_grant.account_id", "project_grant.project_id"], keys: ["account_id", "id"] };
    case "requests": return { ...common,
      select: "request.id,request.account_id,request.project_id,request.request_type,request.title,request.status,request.created_at,request.updated_at,project.project_name",
      from: "client_service_requests request JOIN client_accounts account ON account.id=request.account_id LEFT JOIN projects project ON project.id=request.project_id",
      order: ["COALESCE(request.created_at,'')", "request.id"], keys: ["id"] };
    case "deliveryGrants": return { ...common,
      select: "delivery.account_id,delivery.project_id,delivery.share_id,delivery.granted_at,delivery.expires_at,delivery.revoked_at,share.label,share.r2_prefix,share.created_at,project.project_name",
      from: "client_delivery_grants delivery JOIN client_accounts account ON account.id=delivery.account_id JOIN shares share ON share.id=delivery.share_id JOIN projects project ON project.id=delivery.project_id",
      order: ["COALESCE(delivery.granted_at,'')", "delivery.account_id", "delivery.share_id"], keys: ["account_id", "share_id"] };
    case "authenticatedDeliveryGrants": return { ...common,
      select: "grant_record.id,grant_record.audience_type,grant_record.audience_public_id,grant_record.status,grant_record.expires_at,grant_record.created_at,grant_record.updated_at,binding.r2_prefix,binding.owner_scope_type,binding.owner_public_id",
      from: "portal_v2_authenticated_delivery_grants grant_record JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=grant_record.workspace_id",
      where: "grant_record.workspace_id=?", values: [root.workspace_id!],
      order: ["COALESCE(grant_record.created_at,'')", "grant_record.id"], keys: ["id"] };
    case "viewerGrants": return { ...common,
      select: "grant_record.id,grant_record.account_id,grant_record.project_id,grant_record.scope_type,grant_record.association_id,grant_record.include_future_published,grant_record.can_measure,grant_record.can_view_cameras,grant_record.can_download,grant_record.authorization_expires_at,grant_record.status,grant_record.created_at,grant_record.updated_at,project.project_name,association.model_title",
      from: "viewer_client_grants grant_record JOIN client_accounts account ON account.id=grant_record.account_id JOIN projects project ON project.id=grant_record.project_id LEFT JOIN viewer_model_associations association ON association.id=grant_record.association_id",
      order: ["COALESCE(grant_record.created_at,'')", "grant_record.id"], keys: ["id"] };
  }
}

/** Live keyset pages, not a database snapshot: rows added above an existing
 * cursor appear after refresh. Current ownership/authorization is applied in SQL
 * before the keyset and limit. No collection creates or infers an access grant. */
export async function listClientHubCollection(env: Env, context: ClientHubCollectionContext, collection: ClientHubCollection,
  options: { limit?: number; cursor?: string; initial?: boolean } = {}): Promise<ClientHubCollectionResult> {
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HTTPException(400, { message: "Client collection limit must be between 1 and 100" });
  const reason = availability(context, collection);
  if (reason === "permission_required" && !options.initial)
    throw new HTTPException(403, { message: "Client collection permission is required" });
  const page: ClientHubCollectionPage = { available: reason === null, reason, nextCursor: null, hasMore: false, returned: 0, limit };
  const response = { items: [] as Array<Record<string, unknown>>, page, canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion };
  const cursor = options.cursor === undefined ? null : decode(options.cursor);
  if (cursor && (cursor.collection !== collection || JSON.stringify(cursor.root) !== JSON.stringify(rootTuple(context))))
    throw new HTTPException(400, { message: "Client collection cursor does not match this collection" });
  if (cursor && cursor.context !== context.contextVersion)
    throw new HTTPException(409, { message: "Client mapping or permissions changed. Refresh the client workspace to continue" });
  if (reason) return response;
  const query = collectionQuery(context, collection);
  if (cursor && cursor.after.length !== query.order.length)
    throw new HTTPException(400, { message: "Client collection cursor is invalid" });
  const after = cursor ? ` AND (${query.order.join(",")}) ${query.descending ? "<" : ">"} (${query.order.map(() => "?").join(",")})` : "";
  const sql = `SELECT ${query.select},${query.order.map((expression, index) => `${expression} __cursor_${index}`).join(",")}
    FROM ${query.from} WHERE (${query.where})${after}
    ORDER BY ${query.order.map(expression => `${expression} ${query.descending ? "DESC" : "ASC"}`).join(",")} LIMIT ?`;
  const db = (query.business ? env.OPS_DB : env.DELIVERY_DB).withSession("first-primary");
  const result = await db.prepare(sql).bind(...query.values, ...(cursor?.after ?? []), limit + 1).all<Record<string, unknown>>();
  const rows = result.results.slice(0, limit);
  page.returned = rows.length;
  page.hasMore = result.results.length > limit;
  if (page.hasMore) {
    const last = rows[rows.length - 1]!;
    page.nextCursor = encode({ v: 1, root: rootTuple(context), collection, context: context.contextVersion,
      after: query.order.map((_expression, index) => String(last[`__cursor_${index}`])) });
  }
  response.items = rows.map(row => {
    const item: Record<string, unknown> = { ...row, row_key: JSON.stringify([collection, ...query.keys.map(key => row[key])]) };
    for (let index = 0; index < query.order.length; index++) delete item[`__cursor_${index}`];
    return query.business ? { ...item, contact_key: `business:${context.root.source_id}:${String(row.public_id)}`,
      record_type: "business_contact", workspace_id: context.root.workspace_id, email_hint: "", status: "active",
      identity_id: null, has_workspace_access: 0, blocked: 0, access: [], invitation: null } : item;
  });
  return response;
}
