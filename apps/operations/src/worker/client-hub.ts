import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sqlScope } from "./acl";
import { listClientIdentityEligibility } from "./client-identity-eligibility";
import type { Env, StaffPrincipal } from "./types";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;
type ClientKind = "organization" | "standalone_client";

interface ClientHubPermissions {
  directory: boolean;
  requests: boolean;
  delivery: boolean;
  viewer: boolean;
}

interface WorkspaceRow {
  workspace_id: string | null;
  kind: ClientKind;
  public_id: string;
  display_name: string;
  status: string;
  portal_status: string;
  legacy_account_id: string | null;
  account_count: number;
  project_count: number;
  request_count: number;
}

interface ProjectAlphaClientRow {
  public_id: string;
  organization_id: string | null;
  display_name: string;
}

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

function accountWhere(kind: ClientKind): string {
  return kind === "organization"
    ? "(account.id=? OR account.project_alpha_organization_id=?)"
    : "(account.id=? OR (account.project_alpha_client_id=? AND account.project_alpha_organization_id IS NULL))";
}

function accountBindings(workspace: WorkspaceRow): [string, string] {
  return [workspace.legacy_account_id || "", workspace.public_id];
}

async function workspaceRows(env: Env): Promise<WorkspaceRow[]> {
  const result = await database(env).prepare(`SELECT workspace.id workspace_id,workspace.root_type kind,
      CASE workspace.root_type WHEN 'organization' THEN workspace.pa_organization_public_id ELSE workspace.pa_client_public_id END public_id,
      workspace.display_name,workspace.status,workspace.status portal_status,workspace.legacy_account_id,
      (SELECT COUNT(*) FROM client_accounts account
        WHERE account.id=workspace.legacy_account_id
          OR (workspace.root_type='organization' AND account.project_alpha_organization_id=workspace.pa_organization_public_id)
          OR (workspace.root_type='standalone_client' AND account.project_alpha_client_id=workspace.pa_client_public_id
            AND account.project_alpha_organization_id IS NULL)) account_count,
      (SELECT COUNT(DISTINCT project_grant.project_id) FROM client_project_grants project_grant
        JOIN client_accounts account ON account.id=project_grant.account_id
        WHERE project_grant.revoked_at IS NULL AND (account.id=workspace.legacy_account_id
          OR (workspace.root_type='organization' AND account.project_alpha_organization_id=workspace.pa_organization_public_id)
          OR (workspace.root_type='standalone_client' AND account.project_alpha_client_id=workspace.pa_client_public_id
            AND account.project_alpha_organization_id IS NULL))) project_count,
      (SELECT COUNT(*) FROM client_service_requests request
        JOIN client_accounts account ON account.id=request.account_id
        WHERE account.id=workspace.legacy_account_id
          OR (workspace.root_type='organization' AND account.project_alpha_organization_id=workspace.pa_organization_public_id)
          OR (workspace.root_type='standalone_client' AND account.project_alpha_client_id=workspace.pa_client_public_id
            AND account.project_alpha_organization_id IS NULL)) request_count
    FROM portal_v2_workspaces workspace
    WHERE workspace.status<>'closed'
    ORDER BY workspace.display_name COLLATE NOCASE,workspace.id LIMIT 501`).all<WorkspaceRow>();
  if (result.results.length > 500)
    throw new HTTPException(503, { message: "The client directory is too large" });
  return result.results;
}

async function clientRoots(env: Env): Promise<WorkspaceRow[]> {
  const [organizations, standaloneClients, workspaces, unlinkedAccounts, linkedAccountSummaries] = await Promise.all([
    env.OPS_DB.withSession("first-primary").prepare(
      "SELECT id public_id,name display_name FROM pa_organizations WHERE active=1 ORDER BY name COLLATE NOCASE,id",
    ).all<{ public_id: string; display_name: string }>(),
    env.OPS_DB.withSession("first-primary").prepare(
      "SELECT id public_id,name display_name FROM pa_clients WHERE active=1 AND organization_id IS NULL ORDER BY name COLLATE NOCASE,id",
    ).all<{ public_id: string; display_name: string }>(),
    workspaceRows(env),
    database(env).prepare(`SELECT account.id public_id,account.display_name,account.status,
      COUNT(DISTINCT project_grant.project_id) project_count,COUNT(DISTINCT request.id) request_count
      FROM client_accounts account
      LEFT JOIN client_project_grants project_grant ON project_grant.account_id=account.id AND project_grant.revoked_at IS NULL
      LEFT JOIN client_service_requests request ON request.account_id=account.id
      WHERE account.project_alpha_client_id IS NULL AND account.project_alpha_organization_id IS NULL AND account.status<>'closed'
      GROUP BY account.id ORDER BY account.display_name COLLATE NOCASE,account.id LIMIT 501`)
      .all<{ public_id: string; display_name: string; status: string; project_count: number; request_count: number }>(),
    database(env).prepare(`SELECT
      CASE WHEN account.project_alpha_organization_id IS NOT NULL THEN 'organization' ELSE 'standalone_client' END kind,
      COALESCE(account.project_alpha_organization_id,account.project_alpha_client_id) public_id,
      COUNT(DISTINCT account.id) account_count,COUNT(DISTINCT project_grant.project_id) project_count,
      COUNT(DISTINCT request.id) request_count
      FROM client_accounts account
      LEFT JOIN client_project_grants project_grant ON project_grant.account_id=account.id AND project_grant.revoked_at IS NULL
      LEFT JOIN client_service_requests request ON request.account_id=account.id
      WHERE account.project_alpha_organization_id IS NOT NULL OR account.project_alpha_client_id IS NOT NULL
      GROUP BY kind,public_id`).all<{ kind: ClientKind; public_id: string; account_count: number; project_count: number; request_count: number }>(),
  ]);
  if (unlinkedAccounts.results.length > 500)
    throw new HTTPException(503, { message: "The delivery-only client directory is too large" });
  const byRoot = new Map(workspaces.map(workspace => `${workspace.kind}\u0000${workspace.public_id}`).map((key, index) => [key, workspaces[index]!]));
  const summaries = new Map(linkedAccountSummaries.results.map(summary => [`${summary.kind}\u0000${summary.public_id}`, summary]));
  const roots: WorkspaceRow[] = [];
  for (const source of organizations.results) {
    const workspace = byRoot.get(`organization\u0000${source.public_id}`);
    const summary = summaries.get(`organization\u0000${source.public_id}`);
    roots.push(workspace ? { ...workspace, ...summary, display_name: source.display_name, status: "active" } : {
      workspace_id: null, kind: "organization", public_id: source.public_id, display_name: source.display_name,
      status: "active", portal_status: "not_provisioned", legacy_account_id: null,
      account_count: summary?.account_count || 0, project_count: summary?.project_count || 0,
      request_count: summary?.request_count || 0,
    });
  }
  for (const source of standaloneClients.results) {
    const workspace = byRoot.get(`standalone_client\u0000${source.public_id}`);
    const summary = summaries.get(`standalone_client\u0000${source.public_id}`);
    roots.push(workspace ? { ...workspace, ...summary, display_name: source.display_name, status: "active" } : {
      workspace_id: null, kind: "standalone_client", public_id: source.public_id, display_name: source.display_name,
      status: "active", portal_status: "not_provisioned", legacy_account_id: null,
      account_count: summary?.account_count || 0, project_count: summary?.project_count || 0,
      request_count: summary?.request_count || 0,
    });
  }
  const known = new Set(roots.map(root => `${root.kind}\u0000${root.public_id}`));
  for (const workspace of workspaces) {
    const key = `${workspace.kind}\u0000${workspace.public_id}`;
    if (!known.has(key)) roots.push(workspace);
  }
  for (const account of unlinkedAccounts.results) roots.push({
    workspace_id: null, kind: "standalone_client", public_id: account.public_id,
    display_name: account.display_name, status: account.status, portal_status: "not_provisioned",
    legacy_account_id: account.public_id, account_count: 1, project_count: account.project_count,
    request_count: account.request_count,
  });
  if (roots.length > 500) throw new HTTPException(503, { message: "The client directory is too large" });
  return roots.sort((left, right) => left.display_name.localeCompare(right.display_name) || left.public_id.localeCompare(right.public_id));
}

async function selectedWorkspace(env: Env, kind: ClientKind, publicId: string): Promise<WorkspaceRow> {
  const rows = await clientRoots(env);
  const workspace = rows.find(row => row.kind === kind && row.public_id === publicId);
  if (!workspace) throw new HTTPException(404, { message: "Client not found" });
  return workspace;
}

async function projectAlphaClients(env: Env): Promise<ProjectAlphaClientRow[]> {
  const rows = await env.OPS_DB.withSession("first-primary").prepare(
    "SELECT id public_id,organization_id,name display_name FROM pa_clients WHERE active=1 ORDER BY name COLLATE NOCASE,id",
  ).all<ProjectAlphaClientRow>();
  return rows.results;
}

function contactsForRoot(
  root: WorkspaceRow,
  sourceClients: ProjectAlphaClientRow[],
  projected: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const projectedContacts = root.workspace_id
    ? projected.filter(contact => contact.workspace_id === root.workspace_id)
    : [];
  const byPublicId = new Map(projectedContacts.map(contact => [String(contact.public_id), contact]));
  const sourceContacts = sourceClients.filter(client => root.kind === "organization"
    ? client.organization_id === root.public_id
    : client.organization_id === null && client.public_id === root.public_id);
  for (const client of sourceContacts) {
    if (byPublicId.has(client.public_id)) continue;
    projectedContacts.push({
      workspace_id: root.workspace_id,
      public_id: client.public_id,
      display_name: client.display_name,
      email_hint: "",
      status: "active",
      identity_id: null,
      has_workspace_access: 0,
      blocked: 0,
      access: [],
      invitation: null,
    });
  }
  return projectedContacts.sort((left, right) => String(left.display_name).localeCompare(String(right.display_name)));
}

async function clientHubDirectory(env: Env, principal: StaffPrincipal, access: ClientHubPermissions) {
  if (!access.directory) return [];
  const [workspaces, identities, sourceClients] = await Promise.all([
    clientRoots(env),
    listClientIdentityEligibility(env, principal),
    projectAlphaClients(env),
  ]);
  return workspaces.map(workspace => ({
    ...workspace,
    route_kind: workspace.kind === "organization" ? "organizations" : "standalone",
    contacts: contactsForRoot(workspace, sourceClients, identities.clients as Array<Record<string, unknown>>),
  }));
}

async function clientHubDetail(env: Env, principal: StaffPrincipal, kind: ClientKind, publicId: string) {
  const access = await permissions(env, principal);
  requireHubAccess(access);
  if (!access.directory)
    throw new HTTPException(403, { message: "Global team.view permission required" });
  const [workspace, identityDirectory, sourceClients] = await Promise.all([
    selectedWorkspace(env, kind, publicId),
    listClientIdentityEligibility(env, principal),
    projectAlphaClients(env),
  ]);
  const bindings = accountBindings(workspace);
  const where = accountWhere(workspace.kind);
  const db = database(env);
  const [accounts, projects, requests, deliveryGrants, authenticatedGrants, viewerGrants] = await Promise.all([
    db.prepare(`SELECT account.id,account.display_name,account.status,account.project_alpha_client_id,
      account.project_alpha_organization_id,account.created_at,account.updated_at
      FROM client_accounts account WHERE ${where} ORDER BY account.display_name COLLATE NOCASE,account.id`)
      .bind(...bindings).all<Record<string, unknown>>(),
    db.prepare(`SELECT project.id,project.project_name,project.client_name,project.r2_prefix,project.active,
      project.project_alpha_project_id,project_grant.account_id,project_grant.can_request_service,
      project_grant.granted_at
      FROM client_project_grants project_grant JOIN client_accounts account ON account.id=project_grant.account_id
      JOIN projects project ON project.id=project_grant.project_id
      WHERE ${where} AND project_grant.revoked_at IS NULL
      ORDER BY project.active DESC,project.project_name COLLATE NOCASE,project.id`)
      .bind(...bindings).all<Record<string, unknown>>(),
    access.requests
      ? db.prepare(`SELECT request.id,request.account_id,request.project_id,request.request_type,request.title,
          request.status,request.created_at,request.updated_at,project.project_name
          FROM client_service_requests request JOIN client_accounts account ON account.id=request.account_id
          LEFT JOIN projects project ON project.id=request.project_id WHERE ${where}
          ORDER BY request.created_at DESC,request.id DESC LIMIT 201`)
        .bind(...bindings).all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] }),
    access.delivery
      ? db.prepare(`SELECT delivery.account_id,delivery.project_id,delivery.share_id,delivery.granted_at,
          delivery.expires_at,delivery.revoked_at,share.label,share.r2_prefix,share.created_at,
          project.project_name
          FROM client_delivery_grants delivery JOIN client_accounts account ON account.id=delivery.account_id
          JOIN shares share ON share.id=delivery.share_id JOIN projects project ON project.id=delivery.project_id
          WHERE ${where} ORDER BY delivery.granted_at DESC,delivery.share_id DESC LIMIT 201`)
        .bind(...bindings).all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] }),
    access.delivery && workspace.workspace_id
      ? db.prepare(`SELECT grant_record.id,grant_record.audience_type,grant_record.audience_public_id,
          grant_record.status,grant_record.expires_at,grant_record.created_at,grant_record.updated_at,
          binding.r2_prefix,binding.owner_scope_type,binding.owner_public_id
          FROM portal_v2_authenticated_delivery_grants grant_record
          JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
          WHERE grant_record.workspace_id=? ORDER BY grant_record.updated_at DESC,grant_record.id DESC LIMIT 201`)
        .bind(workspace.workspace_id).all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] }),
    access.viewer
      ? db.prepare(`SELECT grant_record.id,grant_record.account_id,grant_record.project_id,grant_record.scope_type,
          grant_record.association_id,grant_record.include_future_published,grant_record.can_measure,
          grant_record.can_view_cameras,grant_record.can_download,grant_record.authorization_expires_at,
          grant_record.status,grant_record.created_at,grant_record.updated_at,project.project_name,
          association.model_title
          FROM viewer_client_grants grant_record JOIN client_accounts account ON account.id=grant_record.account_id
          JOIN projects project ON project.id=grant_record.project_id
          LEFT JOIN viewer_model_associations association ON association.id=grant_record.association_id
          WHERE ${where} ORDER BY grant_record.updated_at DESC,grant_record.id DESC LIMIT 201`)
        .bind(...bindings).all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] }),
  ]);
  const bounded = (rows: Record<string, unknown>[], label: string) => {
    if (rows.length > 200) throw new HTTPException(503, { message: `${label} history is too large` });
    return rows;
  };
  return {
    client: workspace,
    contacts: contactsForRoot(workspace, sourceClients, identityDirectory.clients as Array<Record<string, unknown>>),
    accounts: accounts.results,
    projects: projects.results,
    requests: bounded(requests.results, "Client request"),
    deliveryGrants: bounded(deliveryGrants.results, "Delivery grant"),
    authenticatedDeliveryGrants: bounded(authenticatedGrants.results, "Authenticated delivery grant"),
    viewerGrants: bounded(viewerGrants.results, "Viewer grant"),
    capabilities: access,
  };
}

export function registerClientHubRoutes(app: App): void {
  app.get("/api/client-hub", async c => {
    const access = await permissions(c.env, c.get("principal"));
    requireHubAccess(access);
    return c.json({ clients: await clientHubDirectory(c.env, c.get("principal"), access), capabilities: access });
  });
  app.get("/api/client-hub/:kind/:publicId", async c => {
    const kind = routeKind(c.req.param("kind"));
    if (!kind) throw new HTTPException(404, { message: "Client not found" });
    return c.json(await clientHubDetail(c.env, c.get("principal"), kind, c.req.param("publicId")));
  });
}
