import { HTTPException } from "hono/http-exception";
import { sha256 } from "./crypto";
import { clientHubBusinessProjectOwnership } from "./client-hub-business-projects";
import { isAlphaPublicId, validatedUniquePublicIdExpression } from "./client-hub-source";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import type { Env } from "./types";

export type ProjectAlphaContactRoleState = "unavailable" | "not_published" | "verified_empty" | "populated";
export type ProjectAlphaContactRoleScope = "organization" | "standalone_client" | "department" | "client" | "project";

export interface ProjectAlphaContactRoleItem {
  contactDisplayName: string;
  clientDisplayName: string;
  scopeType: ProjectAlphaContactRoleScope;
  scopeDisplayName: string;
  role: string;
  primary: boolean;
  primaryBilling: boolean;
  sendProjectInvoices: boolean;
  canViewInvoiceLinks: boolean;
}

export interface ProjectAlphaContactRolePage {
  state: ProjectAlphaContactRoleState;
  reason: "workspace_unavailable" | "schema_v4_not_published" | null;
  items: ProjectAlphaContactRoleItem[];
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  limit: number;
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"];
  contextVersion: string;
}

interface SelectionRow { generation_id: string; schema_version: number | null }
interface RoleRow {
  contact_display_name: string; client_display_name: string; scope_type: ProjectAlphaContactRoleScope;
  scope_display_name: string; role: string; primary_contact: number; primary_billing: number;
  send_project_invoices: number; can_view_invoice_links: number;
}
interface Cursor { v: 1; context: string; scope: string; offset: number }

export function projectAlphaContactRolesEnabled(env: Pick<Env, "CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED">): boolean {
  return env.CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED === "true";
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
    if (!value || value.v !== 1 || typeof value.context !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.context)
      || typeof value.scope !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.scope)
      || !Number.isSafeInteger(value.offset) || value.offset! < 0 || value.offset! > 10_000) throw new Error();
    return value as Cursor;
  } catch { throw new HTTPException(400, { message: "Project Alpha contact-role cursor is invalid" }); }
}

function empty(context: ClientHubCollectionContext, limit: number, state: ProjectAlphaContactRoleState,
  reason: ProjectAlphaContactRolePage["reason"]): ProjectAlphaContactRolePage {
  return { state, reason, items: [], nextCursor: null, hasMore: false, returned: 0, limit,
    canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion };
}

async function selection(env: Env, context: ClientHubCollectionContext): Promise<SelectionRow | null> {
  const root = context.root;
  if (!root.workspace_id || !isAlphaPublicId(root.pa_public_id)) return null;
  return env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT generation.id generation_id,contract.schema_version
    FROM portal_v2_workspaces workspace
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.source_sequence=checkpoint.source_sequence
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=generation.id
      AND root.entity_type=workspace.root_type AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
      AND root.parent_public_id IS NULL AND root.active=1
    LEFT JOIN portal_v2_contact_assignment_contracts contract ON contract.workspace_id=workspace.id
      AND contract.generation_id=generation.id AND contract.schema_version=4
    WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.root_type=?
      AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=? LIMIT 1`)
    .bind(root.workspace_id, root.source_id, root.kind, root.pa_public_id).first<SelectionRow>();
}

async function contactRoleSchemaAvailable(env: Pick<Env, "DELIVERY_DB">): Promise<boolean> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT COUNT(*) table_count
    FROM sqlite_master WHERE type='table'
      AND name IN ('portal_v2_contact_assignment_contracts','portal_v2_contact_assignments')`)
    .first<{ table_count: number }>();
  return row?.table_count === 2;
}

/** Resolves an exported Project Alpha project identifier only after the caller
 * has authorized the exact business project. The caller must perform the same
 * project/context checks again after the independent Client-D1 read. */
export async function exactBusinessProjectPublicId(env: Pick<Env, "OPS_DB">, context: ClientHubCollectionContext,
  projectId: string): Promise<string | null> {
  const owner = clientHubBusinessProjectOwnership(context);
  const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT
    ${validatedUniquePublicIdExpression("pa_projects", "p")} project_public_id
    FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id
      AND owner.projection_source_id=p.projection_source_id AND owner.active=1
    WHERE p.id=? AND p.active=1 AND (${owner.sql}) LIMIT 1`).bind(projectId, ...owner.values)
    .first<{ project_public_id: string | null }>();
  return isAlphaPublicId(row?.project_public_id) ? row.project_public_id : null;
}

/** Informational projection only. This function never reads identities,
 * memberships, entitlements, invitations, notifications, email or phone, and
 * never mutates either database. A role is not portal or Operations authority. */
export async function listProjectAlphaContactRoles(env: Env, context: ClientHubCollectionContext,
  options: { limit?: number; cursor?: string; initial?: boolean; project?: boolean; projectPublicId?: string | null } = {},
): Promise<ProjectAlphaContactRolePage> {
  const limit = options.limit ?? (options.initial ? 5 : 25);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HTTPException(400, { message: "Project Alpha contact-role limit must be between 1 and 100" });
  if (!context.access.directory) throw new HTTPException(403, { message: "Global team.view permission required" });
  if (context.root.root_namespace !== "business") return empty(context, limit, "unavailable", "workspace_unavailable");
  if (options.project === true && !isAlphaPublicId(options.projectPublicId))
    return empty(context, limit, "unavailable", "workspace_unavailable");
  if (!await contactRoleSchemaAvailable(env)) return empty(context, limit, "unavailable", "workspace_unavailable");

  const selected = await selection(env, context);
  if (!selected) return empty(context, limit, "unavailable", "workspace_unavailable");
  if (selected.schema_version !== 4) return empty(context, limit, "not_published", "schema_v4_not_published");

  const scopeProof = await sha256(JSON.stringify([context.contextVersion, options.project ? "project" : "root",
    options.projectPublicId ?? null]));
  const cursor = options.cursor === undefined ? null : decode(options.cursor);
  if (cursor && (cursor.context !== context.contextVersion || cursor.scope !== scopeProof))
    throw new HTTPException(409, { message: "Client mapping, selected generation, or contact-role scope changed. Refresh to continue" });
  const offset = cursor?.offset ?? 0;
  const scopeWhere = options.project
    ? "assignment.scope_type='project' AND assignment.scope_public_id=?"
    : "assignment.scope_type IN ('organization','standalone_client','department','client')";
  const values = options.project ? [options.projectPublicId!] : [];
  const rows = (await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT
      contact.display_name contact_display_name,client.display_name client_display_name,
      assignment.scope_type,scope.display_name scope_display_name,assignment.role,
      assignment.primary_contact,assignment.primary_billing,assignment.send_project_invoices,
      assignment.can_view_invoice_links
    FROM portal_v2_contact_assignments assignment
    JOIN portal_v2_directory_entities contact ON contact.workspace_id=assignment.workspace_id
      AND contact.generation_id=assignment.generation_id AND contact.entity_type='contact'
      AND contact.public_id=assignment.contact_public_id AND contact.active=1
    JOIN portal_v2_directory_entities client ON client.workspace_id=assignment.workspace_id
      AND client.generation_id=assignment.generation_id AND client.entity_type IN ('client','standalone_client')
      AND client.public_id=assignment.client_public_id AND client.active=1
    JOIN portal_v2_directory_entities scope ON scope.workspace_id=assignment.workspace_id
      AND scope.generation_id=assignment.generation_id AND scope.entity_type=assignment.scope_type
      AND scope.public_id=assignment.scope_public_id AND scope.active=1
    WHERE assignment.workspace_id=? AND assignment.generation_id=? AND assignment.active=1 AND ${scopeWhere}
    ORDER BY assignment.scope_type ASC,scope.display_name COLLATE NOCASE ASC,assignment.role ASC,
      contact.display_name COLLATE NOCASE ASC,assignment.public_id ASC LIMIT ? OFFSET ?`)
    .bind(context.root.workspace_id!, selected.generation_id, ...values, limit + 1, offset).all<RoleRow>()).results;
  const pageRows = rows.slice(0, limit), hasMore = rows.length > limit && offset + limit <= 10_000;
  return {
    state: pageRows.length || offset > 0 ? "populated" : "verified_empty", reason: null,
    items: pageRows.map(row => ({ contactDisplayName: row.contact_display_name, clientDisplayName: row.client_display_name,
      scopeType: row.scope_type, scopeDisplayName: row.scope_display_name, role: row.role,
      primary: row.primary_contact === 1, primaryBilling: row.primary_billing === 1,
      sendProjectInvoices: row.send_project_invoices === 1, canViewInvoiceLinks: row.can_view_invoice_links === 1 })),
    nextCursor: hasMore ? encode({ v: 1, context: context.contextVersion, scope: scopeProof, offset: offset + limit }) : null,
    hasMore, returned: pageRows.length, limit, canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
  };
}
