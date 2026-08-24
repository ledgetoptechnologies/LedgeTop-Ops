import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";

const acl = vi.hoisted(() => ({
  sqlScope: vi.fn(async () => ({ global: true, deniedGlobal: false })),
  hasPermission: vi.fn(async (_env: unknown, _principal: unknown, permission: string) =>
    ["delivery.share.audit", "viewer.view"].includes(permission)),
}));
const eligibility = vi.hoisted(() => ({
  listClientIdentityEligibility: vi.fn(async () => ({
    clients: [{
      workspace_id: "workspace-org", public_id: "pa-child-login", display_name: "Login Contact",
      email_hint: "login@example.test", status: "active", identity_id: "identity-login",
      has_workspace_access: 1, blocked: 0, access: [], invitation: null,
    }],
    blocks: [{ id: "block-one", match_type: "email", normalized_email: "login@example.test", status: "active" }],
    canManageEligibilityBlocks: true,
    canManagePortal: true,
  })),
}));
vi.mock("../src/worker/acl", () => acl);
vi.mock("../src/worker/client-identity-eligibility", () => eligibility);

import { registerClientHubRoutes } from "../src/worker/client-hub";
import type { Env, StaffPrincipal } from "../src/worker/types";

const active: Miniflare[] = [];
const principal = { id: "staff-one" } as StaffPrincipal;
const applySql = (database: D1Database, sql: string) => database.exec(sql.replace(/\s*\n\s*/g, " "));

async function fixture() {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-08-06",
    modules: true,
    script: "export default { fetch(){ return new Response('ok'); } }",
    d1Databases: { OPS_DB: "client-hub-ops", DELIVERY_DB: "client-hub-delivery" },
  });
  active.push(miniflare);
  const ops = await miniflare.getD1Database("OPS_DB") as unknown as D1Database;
  const delivery = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await applySql(ops, `
    CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT,active INTEGER);
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,active INTEGER);
    INSERT INTO pa_organizations VALUES('pa-org','Organization One',1);
    INSERT INTO pa_clients VALUES('pa-child-login','Login Contact','pa-org',1);
    INSERT INTO pa_clients VALUES('pa-child-no-login','No Login Contact','pa-org',1);
    INSERT INTO pa_clients VALUES('pa-standalone','Standalone One',NULL,1);
  `);
  await applySql(delivery, `
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT,status TEXT,project_alpha_client_id TEXT,
      project_alpha_organization_id TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,
      pa_client_public_id TEXT,display_name TEXT,status TEXT,legacy_account_id TEXT);
    CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,can_request_service INTEGER,granted_at TEXT,revoked_at TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,project_name TEXT,client_name TEXT,r2_prefix TEXT,active INTEGER,
      project_alpha_project_id TEXT);
    CREATE TABLE client_service_requests(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,request_type TEXT,title TEXT,
      status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE shares(id TEXT PRIMARY KEY,label TEXT,r2_prefix TEXT,created_at TEXT);
    CREATE TABLE client_delivery_grants(account_id TEXT,project_id TEXT,share_id TEXT,granted_at TEXT,expires_at TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,r2_prefix TEXT,owner_scope_type TEXT,owner_public_id TEXT);
    CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,
      audience_type TEXT,audience_public_id TEXT,status TEXT,expires_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE viewer_model_associations(id TEXT PRIMARY KEY,model_title TEXT);
    CREATE TABLE viewer_client_grants(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,scope_type TEXT,association_id TEXT,
      include_future_published INTEGER,can_measure INTEGER,can_view_cameras INTEGER,can_download INTEGER,
      authorization_expires_at TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO client_accounts VALUES('account-standalone','Standalone One','active','pa-standalone',NULL,datetime('now'),datetime('now'));
    INSERT INTO client_accounts VALUES('account-org','Organization One','active','pa-child-login','pa-org',datetime('now'),datetime('now'));
    INSERT INTO portal_v2_workspaces VALUES('workspace-org','organization','pa-org',NULL,'Organization One','active','account-org');
    INSERT INTO projects VALUES('project-one','Project One','Standalone One','clients/standalone/project-one/',1,'pa-project-one');
    INSERT INTO client_project_grants VALUES('account-standalone','project-one',1,datetime('now'),NULL);
    INSERT INTO client_service_requests VALUES('request-one','account-standalone','project-one','service','Oldest request','submitted','2026-01-01','2026-01-01');
    INSERT INTO shares VALUES('share-one','Delivered folder','clients/standalone/project-one/',datetime('now'));
    INSERT INTO client_delivery_grants VALUES('account-standalone','project-one','share-one',datetime('now'),NULL,NULL);
  `);
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", true); await next(); });
  registerClientHubRoutes(app);
  const env = { OPS_DB: ops, DELIVERY_DB: delivery } as Env;
  return { app, env };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(active.splice(0).map(item => item.dispose()));
});

describe("Client Hub", () => {
  it("lists PA clients before portal provisioning and hydrates their delivery counts and detail", async () => {
    const { app, env } = await fixture();
    const list = await app.request("http://local/api/client-hub", {}, env);
    expect(list.status).toBe(200);
    const body = await list.json() as { clients: Array<Record<string, unknown>> };
    expect(body.clients).toEqual(expect.arrayContaining([
      expect.objectContaining({ public_id: "pa-standalone", portal_status: "not_provisioned", account_count: 1,
        project_count: 1, request_count: 1 }),
    ]));

    const detail = await app.request("http://local/api/client-hub/standalone/pa-standalone", {}, env);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      client: { public_id: "pa-standalone", workspace_id: null, portal_status: "not_provisioned" },
      projects: [expect.objectContaining({ id: "project-one" })],
      requests: [expect.objectContaining({ id: "request-one" })],
      deliveryGrants: [expect.objectContaining({ share_id: "share-one" })],
      authenticatedDeliveryGrants: [],
      accessManagement: {
        blocks: [expect.objectContaining({ id: "block-one" })],
        canManageEligibilityBlocks: true,
        canManagePortal: true,
      },
    });
  });

  it("expands organization clients even when a child has no portal login", async () => {
    const { app, env } = await fixture();
    const response = await app.request("http://local/api/client-hub", {}, env);
    const body = await response.json() as { clients: Array<{ public_id: string; workspace_id: string | null; contacts: Array<{ public_id: string; identity_id: string | null }> }> };
    const organization = body.clients.find(client => client.public_id === "pa-org");
    expect(organization).toMatchObject({ workspace_id: "workspace-org" });
    expect(organization?.contacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ public_id: "pa-child-login", identity_id: "identity-login" }),
      expect.objectContaining({ public_id: "pa-child-no-login", identity_id: null }),
    ]));
  });
});
