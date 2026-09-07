import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { listClientBusinessActivity } from "./client-business-activity";
import { listClientAuditTimeline, parseClientAuditTimelineFilters } from "./client-audit-timeline";
import { sqlScope } from "./acl";
import { clientHubDetailPath, clientHubRouteKind, findClientHubRoot, listClientHubRoots,
  isClientHubRootNamespace, isClientHubSource, type ClientHubKind, type ClientHubRoot } from "./client-hub-directory";
import { isAlphaPublicId, isBusinessProjectionSource, resolveClientHubSourceRoot, validatedUniquePublicIdExpression } from "./client-hub-source";
import { resolveClientHubWorkspace, type ClientHubWorkspace } from "./client-hub-workspace";
import { CLIENT_HUB_COLLECTIONS, createClientHubCollectionContext, isClientHubCollection, listClientHubCollection,
  type ClientHubCollectionContext, type ClientHubPermissions } from "./client-hub-collections";
import { listClientHubBusinessProjects, BUSINESS_PROJECT_FILTERS, type BusinessProjectFilter } from "./client-hub-business-projects";
import { readClientHubBusinessProjectDetail } from "./client-hub-business-project-detail";
import { listClientHubFeedbackHistory, listClientHubProjectFeedbackHistory } from "./client-hub-project-feedback-history";
import { isPortalIdentityCollection, listPortalIdentityCollection, listPortalIdentityPage, portalIdentityQuery } from "./client-portal-identity-read";
import { registerClientInternalNoteRoutes } from "./client-internal-note-routes";
import { readBoundedJson } from "./bounded-json";
import { reactivateClientPortalWorkspaceAccess, suspendClientPortalWorkspaceAccess,
  type WorkspaceAccessMutationInput, type WorkspaceAccessReactivationInput } from "./client-portal-workspace-access";
import { mutatePortalRootAccess, readPortalRootAccess } from "./client-portal-root-access";
import { externalAccessQuery, listClientExternalAccess } from "./client-external-access";
import { listClientServiceAssignments, serviceAssignmentQuery } from "./client-service-assignments";
import type { Env, StaffPrincipal } from "./types";
import { requireProjectAlphaReadVisibility } from "./project-alpha-read-visibility";
import { readBusinessPartyForRoot } from "./business-parties";
import { registerProjectOperationalRoutes } from "./project-operational-routes";
import { registerOrganizationOperationalContactRoutes } from "./organization-operational-contact-routes";
import { readClientHubProjectManagementAction } from "./project-alpha-project-management";
import { exactBusinessProjectPublicId, listProjectAlphaContactRoles, projectAlphaContactRolesEnabled } from "./project-alpha-contact-roles";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;
type ClientKind = ClientHubKind;

type WorkspaceRow = ClientHubRoot;
const DETAIL_COLLECTIONS = [...CLIENT_HUB_COLLECTIONS, "businessProjects"] as const;

function database(env: Env) {
  return env.DELIVERY_DB.withSession("first-primary");
}

async function permissions(env: Env, principal: StaffPrincipal): Promise<ClientHubPermissions> {
  const [team, operations, deliveryAudit, deliveryCreate, viewerView, viewerManage] = await Promise.all([
    sqlScope(env, principal, "team.view"),
    sqlScope(env, principal, "operations.manage"),
    sqlScope(env, principal, "delivery.share.audit"),
    sqlScope(env, principal, "delivery.share.create"),
    sqlScope(env, principal, "viewer.view"),
    sqlScope(env, principal, "viewer.manage"),
  ]);
  const global = (scope: typeof team) => scope.global && !scope.deniedGlobal;
  return {
    directory: global(team),
    requests: global(operations),
    delivery: global(deliveryAudit) || global(deliveryCreate),
    viewer: global(viewerView) || global(viewerManage),
  };
}

function requireHubAccess(value: ClientHubPermissions): void {
  if (!value.directory && !value.requests)
    throw new HTTPException(403, { message: "Client Hub access is required" });
}

function routeKind(value: string): ClientKind | null {
  return value === "organizations"
    ? "organization"
    : value === "standalone"
      ? "standalone_client"
      : null;
}

async function readPortalRoot(env: Env, kind: ClientKind, workspaceId: string): Promise<ClientHubWorkspace | null> {
  return database(env).prepare(`SELECT id,root_type,display_name,status,legacy_account_id,
    pa_organization_public_id,pa_client_public_id,project_alpha_source_id FROM portal_v2_workspaces
    WHERE id=? AND root_type=? AND project_alpha_source_id='project-alpha:primary' AND status<>'closed'`).bind(workspaceId, kind).first<ClientHubWorkspace>();
}

function portalDirectoryRoot(portal: ClientHubWorkspace): WorkspaceRow {
  return { source_id: "project-alpha:primary", root_namespace: "portal", kind: portal.root_type,
    public_id: portal.id, pa_public_id: null, mapping_status: "missing", display_name: portal.display_name,
    sort_name: portal.display_name, status: portal.status, portal_status: portal.status,
    workspace_id: portal.id, legacy_account_id: null, account_count: 0, project_count: 0,
    request_count: 0, contact_count: 0, meaningful_activity_at: null, source_version: null,
    indexed_at: "", scan_generation: 0 };
}

/** A retained portal URL can acquire a business alias only from current source
 * mapping/legacy provenance and the same exact verified workspace resolver. */
async function businessAlias(env: Env, root: WorkspaceRow, portal: ClientHubWorkspace): Promise<WorkspaceRow | null> {
  const candidates = new Set<string>();
  const publicId = portal.root_type === "organization" ? portal.pa_organization_public_id : portal.pa_client_public_id;
  if (isAlphaPublicId(publicId)) {
    const table = portal.root_type === "organization" ? "pa_organizations" : "pa_clients";
    const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT source.id FROM ${table} source
      WHERE source.active=1 AND source.projection_source_id='project-alpha:primary' ${portal.root_type === "standalone_client" ? "AND source.organization_id IS NULL" : ""}
        AND ${validatedUniquePublicIdExpression(table, "source")}=? LIMIT 2`).bind(publicId).all<{ id: string }>();
    for (const row of rows.results) candidates.add(row.id);
  }
  if (portal.legacy_account_id) {
    const account = await database(env).prepare(`SELECT project_alpha_client_id,project_alpha_organization_id
      FROM client_accounts WHERE id=? AND status='active' AND project_alpha_source_id='project-alpha:primary'`).bind(portal.legacy_account_id)
      .first<{ project_alpha_client_id: string | null; project_alpha_organization_id: string | null }>();
    const internalId = portal.root_type === "organization" ? account?.project_alpha_organization_id
      : account?.project_alpha_organization_id === null ? account.project_alpha_client_id : null;
    if (internalId) candidates.add(internalId);
  }
  const matches: WorkspaceRow[] = [];
  for (const internalId of candidates) {
    const source = await resolveClientHubSourceRoot(env, root.kind, internalId);
    if (!source?.active || (root.kind === "standalone_client" && source.organization_id !== null)) continue;
    const resolved = await resolveClientHubWorkspace(env, { key: internalId, source_id: "project-alpha:primary", kind: root.kind,
      business_id: internalId, pa_public_id: source.pa_public_id, workspace_id: null });
    if (resolved.status === "conflict") throw new HTTPException(409, { message: "This portal's business link needs review" });
    if (resolved.workspace?.id === portal.id) matches.push({ ...root, root_namespace: "business", public_id: source.id,
      pa_public_id: source.pa_public_id, mapping_status: source.mapping_status, display_name: source.display_name,
      status: "active", workspace_id: portal.id, legacy_account_id: portal.legacy_account_id, portal_status: portal.status });
  }
  if (matches.length > 1) throw new HTTPException(409, { message: "This portal's business link is ambiguous" });
  return matches[0] ?? null;
}

async function liveDetailRoot(env: Env, root: WorkspaceRow): Promise<WorkspaceRow> {
  const visibility = await requireProjectAlphaReadVisibility(env, root.source_id);
  root = { ...root, source_name: visibility.display_name! };
  const db = database(env);
  if (root.root_namespace === "account" && root.source_id === "delivery:local") {
    const account = await db.prepare(`SELECT id,display_name,status FROM client_accounts WHERE id=?
      AND project_alpha_source_id IS NULL AND project_alpha_client_id IS NULL AND project_alpha_organization_id IS NULL AND status<>'closed'`)
      .bind(root.public_id).first<{ id: string; display_name: string; status: string }>();
    if (!account) throw new HTTPException(404, { message: "Client not found" });
    return { ...root, display_name: account.display_name, status: account.status, workspace_id: null,
      legacy_account_id: account.id, portal_status: "not_provisioned", pa_public_id: null, mapping_status: "not_applicable" };
  }
  if (!isBusinessProjectionSource(root.source_id)) throw new HTTPException(404, { message: "Client not found" });
  if (root.root_namespace === "portal") {
    if (root.source_id !== "project-alpha:primary") throw new HTTPException(404, { message: "Client not found" });
    const portal = await readPortalRoot(env, root.kind, root.public_id);
    if (!portal) throw new HTTPException(404, { message: "Client not found" });
    const resolved = await resolveClientHubWorkspace(env, { key: root.public_id, source_id: "project-alpha:primary", kind: root.kind,
      workspace_id: portal.id, business_id: null, pa_public_id: null });
    if (resolved.workspace) {
      const alias = await businessAlias(env, root, portal);
      if (alias) return { ...alias, source_name: visibility.display_name! };
    }
    // The portal namespace identifies the workspace itself, not a business ID.
    // Its legacy account bridge is never enough to invent business ownership.
    return { ...root, display_name: portal.display_name, status: portal.status,
      pa_public_id: null, mapping_status: "missing", legacy_account_id: null,
      workspace_id: resolved.workspace?.id ?? null,
      portal_status: resolved.status === "mapped" ? portal.status : "projection_pending" };
  }
  if (root.root_namespace !== "business") throw new HTTPException(404, { message: "Client not found" });
  const source = await resolveClientHubSourceRoot(env, root.kind, root.public_id, root.source_id);
  if (!source || !source.active || (root.kind === "standalone_client" && source.organization_id !== null))
    throw new HTTPException(404, { message: "Client not found" });
  // Business provenance is not a portal grant. Resolve only a same-source,
  // source-owned workspace; secondary sources can never use legacy bridges.
  const resolved = await resolveClientHubWorkspace(env, { key: root.public_id, source_id: root.source_id, kind: root.kind,
    workspace_id: null, business_id: source.id, pa_public_id: source.pa_public_id });
  const workspace = resolved.workspace;
  // The directory is eventually consistent. Never use its cached workspace or
  // account association to hydrate access after the live source was reassigned.
  return { ...root, display_name: source.display_name, status: "active",
    pa_public_id: source.pa_public_id, mapping_status: source.mapping_status,
    workspace_id: workspace?.id ?? null, legacy_account_id: root.source_id === "project-alpha:primary" ? workspace?.legacy_account_id ?? null : null,
    portal_status: workspace?.status ?? (resolved.status === "conflict" ? "mapping_conflict"
      : resolved.status === "pending" ? "projection_pending" : source.mapping_status !== "mapped" ? "mapping_unavailable"
        : root.source_id === "project-alpha:primary" ? "not_provisioned" : "not_supported") };
}
async function resolveDetailContext(env: Env, principal: StaffPrincipal, kind: ClientKind, publicId: string,
  sourceId?: string, rootNamespace?: string): Promise<ClientHubCollectionContext> {
  // Validate before either the portal alias or live-source fallback can bypass
  // the indexed lookup. Keep the exact-ID contract identical on every route.
  if (!publicId || publicId.length > 512 || /[\0-\x1f\x7f]/.test(publicId)
    || (sourceId !== undefined && !isClientHubSource(sourceId))
    || (rootNamespace !== undefined && !isClientHubRootNamespace(rootNamespace)))
    throw new HTTPException(404, { message: "Client not found" });
  const access = await permissions(env, principal);
  requireHubAccess(access);
  if (!access.directory)
    throw new HTTPException(403, { message: "Global team.view permission required" });
  if (sourceId) await requireProjectAlphaReadVisibility(env, sourceId);
  // Portal aliases outlive index folding into a business root. Resolve their
  // exact live workspace even after the old materialized portal row is swept.
  const portal = sourceId === "project-alpha:primary" && rootNamespace === "portal"
    ? await readPortalRoot(env, kind, publicId) : null;
  let indexed: WorkspaceRow;
  try {
    indexed = portal ? portalDirectoryRoot(portal) : await findClientHubRoot(env, kind, publicId, sourceId, rootNamespace);
  } catch (error) {
    // A verified portal alias may point at a canonical business route before the
    // next directory reconciliation. Exact live source identity, never an ID
    // guess or cached portal association, can hydrate that route in the meantime.
    if (!(error instanceof HTTPException) || !(error.status === 404 || (error.status === 503
      && error.message === "The client directory is being prepared; please retry shortly"))
      || !sourceId || !isBusinessProjectionSource(sourceId) || rootNamespace !== "business") throw error;
    const source = await resolveClientHubSourceRoot(env, kind, publicId, sourceId);
    if (!source?.active || (kind === "standalone_client" && source.organization_id !== null)) throw error;
    indexed = { source_id: sourceId, root_namespace: "business", kind, public_id: source.id,
      pa_public_id: source.pa_public_id, mapping_status: source.mapping_status, display_name: source.display_name,
      sort_name: source.display_name, status: "active", portal_status: "not_provisioned", workspace_id: null,
      legacy_account_id: null, account_count: 0, project_count: 0, request_count: 0, contact_count: 0,
      meaningful_activity_at: null, source_version: null, indexed_at: "", scan_generation: 0 };
  }
  const workspace = await liveDetailRoot(env, indexed);
  return createClientHubCollectionContext(env, principal, workspace, access);
}

async function verifyContext(env: Env, principal: StaffPrincipal, context: ClientHubCollectionContext): Promise<void> {
  // Recheck live authority after hydration as well. Cross-D1 reads cannot form
  // one atomic snapshot; this closes observed mapping/permission changes without
  // claiming that an opaque cursor freezes grants or source ownership.
  const root = await liveDetailRoot(env, context.root);
  const current = await createClientHubCollectionContext(env, principal, root, await permissions(env, principal));
  if (current.contextVersion !== context.contextVersion)
    throw new HTTPException(409, { message: "Client mapping or permissions changed. Refresh the client workspace to continue" });
}

/** Reuse the exact live Client Hub authorization and ownership proof for
 * source-qualified composite workspaces. These exports do not broaden access:
 * callers still receive a context for one exact source root and must recheck it
 * after any independently hydrated data. */
export async function resolveClientHubDetailContext(env: Env, principal: StaffPrincipal, kind: ClientKind, publicId: string,
  sourceId?: string, rootNamespace?: string): Promise<ClientHubCollectionContext> {
  return resolveDetailContext(env, principal, kind, publicId, sourceId, rootNamespace);
}

export async function verifyClientHubDetailContext(env: Env, principal: StaffPrincipal,
  context: ClientHubCollectionContext): Promise<void> {
  return verifyContext(env, principal, context);
}

async function clientHubDetail(env: Env, principal: StaffPrincipal, kind: ClientKind, publicId: string, sourceId?: string, rootNamespace?: string) {
  const context = await resolveDetailContext(env, principal, kind, publicId, sourceId, rootNamespace);
  const workspace = context.root, access = context.access;
  const contactRolesAvailable = projectAlphaContactRolesEnabled(env) && workspace.root_namespace === "business";
  const [portalIdentities, portalRootAccess, externalAccess, serviceAssignments, collections, projectAlphaContactRoles] = await Promise.all([
    listPortalIdentityPage(env, principal, { kind: "client", context }, { limit: 5 }),
    readPortalRootAccess(env, principal, context),
    listClientExternalAccess(env, context, { limit: 5 }),
    listClientServiceAssignments(env, principal, context, { initial: true, limit: 5 }),
    Promise.all(DETAIL_COLLECTIONS.map(async collection => ({ collection,
      result: collection === "businessProjects" ? await listClientHubBusinessProjects(env, principal, context, { initial: true, limit: 5 })
        : await listClientHubCollection(env, context, collection, { initial: true, limit: 5 }) }))),
    contactRolesAvailable ? listProjectAlphaContactRoles(env, context, { initial: true, limit: 5 }) : Promise.resolve(undefined),
  ]);
  const items = (collection: typeof DETAIL_COLLECTIONS[number]) => collections.find(page => page.collection === collection)!.result.items;
  await verifyContext(env, principal, context);
  // Party membership is live presentation state, not part of the paged source
  // context. Read it after slow hydration so an intervening unlink is observed.
  const party = workspace.root_namespace === "business" ? await readBusinessPartyForRoot(env, principal,
    { sourceId: workspace.source_id, kind: workspace.kind, recordId: workspace.public_id })
    : { businessParty: null, canManageBusinessParties: false };
  // Cross-database reads are not an atomic snapshot; retain the source/authority
  // check around this final independently authorized metadata read.
  await verifyContext(env, principal, context);
  return {
    ...party,
    client: { ...workspace, route_kind: clientHubRouteKind(workspace.kind), detail_path: clientHubDetailPath(workspace) },
    contacts: items("businessContacts"),
    portalIdentities,
    portalRootAccess,
    externalAccess,
    serviceAssignments,
    accounts: items("accounts"),
    projects: items("projects"),
    businessProjects: items("businessProjects"),
    requests: items("requests"),
    deliveryGrants: items("deliveryGrants"),
    authenticatedDeliveryGrants: items("authenticatedDeliveryGrants"),
    viewerGrants: items("viewerGrants"),
    pages: Object.fromEntries(collections.map(({ collection, result }) => [collection, result.page])),
    contextVersion: context.contextVersion,
    capabilities: access,
    internalNotesAvailable: true,
    organizationOperationalContactsAvailable: workspace.root_namespace === "business" && workspace.kind === "organization",
    projectAlphaContactRolesAvailable: contactRolesAvailable,
    projectAlphaContactRoles,
    projectManagementAvailable: workspace.root_namespace === "business",
    businessActivityAvailable: workspace.root_namespace === "business",
    auditTimelineAvailable: true,
  };
}

function workspaceAccessMutationInput(value: unknown, reactivate: false): WorkspaceAccessMutationInput;
function workspaceAccessMutationInput(value: unknown, reactivate: true): WorkspaceAccessReactivationInput;
function workspaceAccessMutationInput(value: unknown, reactivate: boolean): WorkspaceAccessMutationInput | WorkspaceAccessReactivationInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HTTPException(400, { message: "Portal workspace access request is invalid" });
  const input = value as Record<string, unknown>;
  const allowed = new Set(["expectedContextVersion", "expectedPrincipalContext", "reasonCode",
    ...(reactivate ? ["denialId", "expectedUpdatedAt"] : [])]);
  if (Object.keys(input).some(key => !allowed.has(key))
    || typeof input.expectedContextVersion !== "string" || typeof input.expectedPrincipalContext !== "string"
    || typeof input.reasonCode !== "string" || (reactivate
      && (typeof input.denialId !== "string" || typeof input.expectedUpdatedAt !== "string")))
    throw new HTTPException(400, { message: "Portal workspace access request is invalid" });
  return input as unknown as WorkspaceAccessMutationInput | WorkspaceAccessReactivationInput;
}

function rootAccessMutationInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HTTPException(400, { message: "Portal root access request is invalid" });
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["expectedContextVersion", "expectedVersion", "reasonCode"].includes(key))
    || typeof input.expectedContextVersion !== "string" || typeof input.expectedVersion !== "number"
    || typeof input.reasonCode !== "string")
    throw new HTTPException(400, { message: "Portal root access request is invalid" });
  return input as { expectedContextVersion: string; expectedVersion: number; reasonCode: string };
}

export function registerClientHubRoutes(app: App): void {
  registerClientInternalNoteRoutes(app, resolveDetailContext, verifyContext);
  registerProjectOperationalRoutes(app, resolveDetailContext, verifyContext);
  registerOrganizationOperationalContactRoutes(app, resolveDetailContext, verifyContext);
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/project-management", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), c.req.param("rootNamespace"));
    const expected = c.req.query("expectedContextVersion");
    if (expected !== undefined && expected !== context.contextVersion)
      throw new HTTPException(409, { message: "Client context changed. Refresh the workspace to continue" });
    const result = await readClientHubProjectManagementAction(c.env, principal, context, new URL(c.req.url).pathname);
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/timeline", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), c.req.param("rootNamespace"));
    const params = new URL(c.req.url).searchParams, rawLimit = params.get("limit");
    const result = await listClientAuditTimeline(c.env, principal, context, {
      expectedContextVersion: params.get("expectedContextVersion") ?? undefined,
      filters: parseClientAuditTimelineFilters(params), cursor: params.get("cursor") ?? undefined,
      limit: rawLimit === null ? 10 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN,
    });
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/activity", async c => {
    if (c.req.param("rootNamespace") !== "business" || !isBusinessProjectionSource(c.req.param("sourceId")))
      throw new HTTPException(404, { message: "Business activity is unavailable for this source" });
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const expected = c.req.query("expectedContextVersion");
    if (expected !== undefined && expected !== context.contextVersion)
      throw new HTTPException(409, { message: "Client context changed. Refresh the workspace to continue" });
    const limit = c.req.query("limit");
    const result = await listClientBusinessActivity(c.env, principal, context, {
      projectId: c.req.query("projectId"), cursor: c.req.query("cursor"),
      limit: limit === undefined ? 5 : /^\d+$/.test(limit) ? Number(limit) : Number.NaN,
    });
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/business-projects/:projectId", async c => {
    if (c.req.param("rootNamespace") !== "business" || !isBusinessProjectionSource(c.req.param("sourceId")))
      throw new HTTPException(404, { message: "Business project not found" });
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"), c.req.param("sourceId"), c.req.param("rootNamespace"));
    const projectId = c.req.param("projectId");
    const result = await readClientHubBusinessProjectDetail(c.env, principal, context, projectId,
      { expectedContextVersion: c.req.query("expectedContextVersion") });
    const contactRolesAvailable = projectAlphaContactRolesEnabled(c.env);
    let projectAlphaContactRoles;
    if (contactRolesAvailable) {
      const projectPublicId = await exactBusinessProjectPublicId(c.env, context, projectId);
      projectAlphaContactRoles = await listProjectAlphaContactRoles(c.env, context,
        { initial: true, limit: 5, project: true, projectPublicId });
      await readClientHubBusinessProjectDetail(c.env, principal, context, projectId,
        { expectedContextVersion: context.contextVersion });
      const currentProjectPublicId = await exactBusinessProjectPublicId(c.env, context, projectId);
      if (currentProjectPublicId !== projectPublicId)
        throw new HTTPException(409, { message: "Project ownership or contact-role scope changed. Refresh to continue" });
    }
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json({ ...result, projectAlphaContactRolesAvailable: contactRolesAvailable, projectAlphaContactRoles });
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/project-alpha-contact-roles", async c => {
    if (!projectAlphaContactRolesEnabled(c.env))
      throw new HTTPException(404, { message: "Project Alpha contact roles are not enabled" });
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), c.req.param("rootNamespace"));
    const rawLimit = c.req.query("limit");
    const result = await listProjectAlphaContactRoles(c.env, context, { cursor: c.req.query("cursor"),
      limit: rawLimit === undefined ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN });
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/business-projects/:projectId/project-alpha-contact-roles", async c => {
    if (!projectAlphaContactRolesEnabled(c.env))
      throw new HTTPException(404, { message: "Project Alpha contact roles are not enabled" });
    if (c.req.param("rootNamespace") !== "business" || !isBusinessProjectionSource(c.req.param("sourceId")))
      throw new HTTPException(404, { message: "Business project contact roles are unavailable for this source" });
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal"), projectId = c.req.param("projectId");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), "business");
    await readClientHubBusinessProjectDetail(c.env, principal, context, projectId,
      { expectedContextVersion: c.req.query("expectedContextVersion") });
    const projectPublicId = await exactBusinessProjectPublicId(c.env, context, projectId), rawLimit = c.req.query("limit");
    const result = await listProjectAlphaContactRoles(c.env, context, { project: true, projectPublicId,
      cursor: c.req.query("cursor"), limit: rawLimit === undefined ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN });
    await readClientHubBusinessProjectDetail(c.env, principal, context, projectId,
      { expectedContextVersion: context.contextVersion });
    const currentProjectPublicId = await exactBusinessProjectPublicId(c.env, context, projectId);
    if (currentProjectPublicId !== projectPublicId)
      throw new HTTPException(409, { message: "Project ownership or contact-role scope changed. Refresh to continue" });
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/business-projects/:projectId/timeline", async c => {
    if (c.req.param("rootNamespace") !== "business" || !isBusinessProjectionSource(c.req.param("sourceId")))
      throw new HTTPException(404, { message: "Business project timeline is unavailable for this source" });
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), "business");
    const params = new URL(c.req.url).searchParams, rawLimit = params.get("limit");
    const result = await listClientAuditTimeline(c.env, principal, context, {
      projectId: c.req.param("projectId"), expectedContextVersion: params.get("expectedContextVersion") ?? undefined,
      filters: parseClientAuditTimelineFilters(params), cursor: params.get("cursor") ?? undefined,
      limit: rawLimit === null ? 10 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN,
    });
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/business-projects/:projectId/feedback-history", async c => {
    if (c.req.param("rootNamespace") !== "business" || !isBusinessProjectionSource(c.req.param("sourceId")))
      throw new HTTPException(404, { message: "Project feedback history is unavailable for this source" });
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env,principal,kind,c.req.param("publicId"),c.req.param("sourceId"),"business");
    const rawLimit = c.req.query("limit");
    const result = await listClientHubProjectFeedbackHistory(c.env,principal,context,c.req.param("projectId"),{
      expectedContextVersion:c.req.query("expectedContextVersion"),cursor:c.req.query("cursor"),
      limit:rawLimit===undefined?5:/^\d+$/.test(rawLimit)?Number(rawLimit):Number.NaN,
    });
    await verifyContext(c.env,principal,context);
    c.header("Cache-Control","no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/feedback-history",async c=>{
    if(c.req.param("rootNamespace")!=="business"||!isBusinessProjectionSource(c.req.param("sourceId")))
      throw new HTTPException(404,{message:"Client feedback history is unavailable for this source"});
    const kind=routeKind(c.req.param("kind"));
    if(!kind)throw new HTTPException(404,{message:"Client not found"});
    const principal=c.get("principal");
    const context=await resolveDetailContext(c.env,principal,kind,c.req.param("publicId"),c.req.param("sourceId"),"business");
    const rawLimit=c.req.query("limit");
    const result=await listClientHubFeedbackHistory(c.env,principal,context,{
      expectedContextVersion:c.req.query("expectedContextVersion"),cursor:c.req.query("cursor"),
      limit:rawLimit===undefined?5:/^\d+$/.test(rawLimit)?Number(rawLimit):Number.NaN,
    });
    await verifyContext(c.env,principal,context);
    c.header("Cache-Control","no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/identities", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"), c.req.param("sourceId"), c.req.param("rootNamespace"));
    const result = await listPortalIdentityPage(c.env, principal, { kind: "client", context }, portalIdentityQuery(new URL(c.req.url).searchParams));
    await verifyContext(c.env, principal, context);
    return c.json(result);
  });
  app.post("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/identities/:principalId/workspace-access/suspend", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), c.req.param("rootNamespace"));
    const result = await suspendClientPortalWorkspaceAccess(c.env, principal, context,
      c.req.param("principalId"), workspaceAccessMutationInput(await readBoundedJson(c.req.raw, 16_384, "Workspace access request"), false),
      c.req.header("Idempotency-Key") || "");
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.post("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/identities/:principalId/workspace-access/reactivate", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), c.req.param("rootNamespace"));
    const result = await reactivateClientPortalWorkspaceAccess(c.env, principal, context,
      c.req.param("principalId"), workspaceAccessMutationInput(await readBoundedJson(c.req.raw, 16_384, "Workspace access request"), true),
      c.req.header("Idempotency-Key") || "");
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.post("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/portal-access/:action", async c => {
    const kind = routeKind(c.req.param("kind"));
    const action = c.req.param("action");
    if (!kind || (action !== "revoke" && action !== "restore"))
      throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), c.req.param("rootNamespace"));
    const input = rootAccessMutationInput(await readBoundedJson(c.req.raw, 16_384, "Portal root access request"));
    const result = await mutatePortalRootAccess(c.env, principal, context, { ...input, action },
      c.req.header("Idempotency-Key") || "", () => verifyContext(c.env, principal, context));
    c.header("Cache-Control", "no-store");
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/external-access", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"), c.req.param("sourceId"), c.req.param("rootNamespace"));
    const result = await listClientExternalAccess(c.env, context, externalAccessQuery(new URL(c.req.url).searchParams));
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/service-assignments", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"),
      c.req.param("sourceId"), c.req.param("rootNamespace"));
    const result = await listClientServiceAssignments(c.env, principal, context,
      serviceAssignmentQuery(new URL(c.req.url).searchParams));
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/identities/:principalId/:collection", async c => {
    const kind = routeKind(c.req.param("kind")), collection = c.req.param("collection");
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    if (!isPortalIdentityCollection(collection)) throw new HTTPException(400, { message: "Portal identity collection is invalid" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"), c.req.param("sourceId"), c.req.param("rootNamespace"));
    if (context.root.root_namespace !== "business" || !isBusinessProjectionSource(context.root.source_id))
      throw new HTTPException(404, { message: "Portal identity details are unavailable for this source" });
    if (!context.root.workspace_id) throw new HTTPException(404, { message: "Client portal workspace is unavailable" });
    const query = portalIdentityQuery(new URL(c.req.url).searchParams);
    const result = await listPortalIdentityCollection(c.env, principal, { kind: "client", context },
      { workspaceId: context.root.workspace_id, publicId: c.req.param("principalId") }, collection,
      { expectedPrincipalContext: c.req.query("expectedPrincipalContext") ?? "", cursor: query.cursor, limit: query.limit });
    await verifyContext(c.env, principal, context);
    return c.json(result);
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/collections/:collection", async c => {
    const kind = routeKind(c.req.param("kind")), collection = c.req.param("collection");
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    if (!isClientHubCollection(collection) && collection !== "businessProjects") throw new HTTPException(400, { message: "Client collection is invalid" });
    const principal = c.get("principal");
    const context = await resolveDetailContext(c.env, principal, kind, c.req.param("publicId"), c.req.param("sourceId"), c.req.param("rootNamespace"));
    const rawLimit = c.req.query("limit");
    const options = {
      cursor: c.req.query("cursor"), limit: rawLimit === undefined ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN,
    };
    const filter = c.req.query("filter");
    if (collection === "businessProjects" && filter !== undefined && !(BUSINESS_PROJECT_FILTERS as readonly string[]).includes(filter))
      throw new HTTPException(400, { message: "Business project filter is invalid" });
    const result = collection === "businessProjects"
      ? await listClientHubBusinessProjects(c.env, principal, context, { ...options, filter: filter as BusinessProjectFilter | undefined })
      : await listClientHubCollection(c.env, context, collection, options);
    await verifyContext(c.env, principal, context);
    return c.json(result);
  });
  app.get("/api/client-hub", async c => {
    const access = await permissions(c.env, c.get("principal"));
    requireHubAccess(access);
    const limit = c.req.query("limit");
    const result = access.directory ? await listClientHubRoots(c.env, c.get("principal"), {
      q: c.req.query("q"), kind: c.req.query("kind"), source: c.req.query("source"), cursor: c.req.query("cursor"), grouping: c.req.query("grouping"), sort: c.req.query("sort"),
      limit: limit === undefined ? undefined : /^\d+$/.test(limit) ? Number(limit) : Number.NaN,
    }) : { clients: [], nextCursor: null };
    return c.json({ ...result, capabilities: access });
  });
  app.get("/api/client-hub/sources/:sourceId/:kind/:publicId", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    return c.json(await clientHubDetail(c.env, c.get("principal"), kind, c.req.param("publicId"), c.req.param("sourceId")));
  });
  app.get("/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    return c.json(await clientHubDetail(c.env, c.get("principal"), kind, c.req.param("publicId"), c.req.param("sourceId"), c.req.param("rootNamespace")));
  });
  app.get("/api/client-hub/:kind/:publicId", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    return c.json(await clientHubDetail(c.env, c.get("principal"), kind, c.req.param("publicId")));
  });
}
