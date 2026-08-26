import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";

const acl = vi.hoisted(() => ({
  sqlScope: vi.fn(async () => ({ global: true, deniedGlobal: false })),
  hasPermission: vi.fn(async (_env: unknown, _principal: unknown, permission: string) =>
    ["delivery.share.audit", "viewer.view"].includes(permission)),
  isAdministrator: vi.fn(async () => true),
  hasLocalGlobalAllow: vi.fn(async () => false),
}));
const eligibility = vi.hoisted(() => ({
  eligibilityBlockManagementEnabled: vi.fn(() => true),
  portalOperationsManagementEnabled: vi.fn(() => true),
  listClientIdentityEligibility: vi.fn(async (_env: unknown, _principal: unknown, _options?: { workspaceId?: string }) => ({
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
const organizationUuid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const standaloneUuid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const replacementUuid = "cccccccccccccccccccccccccccccccc";
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
    CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}');
    INSERT INTO pa_organizations VALUES('pa-org','Organization One',1,'{"public_id":"${organizationUuid}"}');
    INSERT INTO pa_clients(id,name,organization_id,active) VALUES('pa-child-login','Login Contact','pa-org',1);
    INSERT INTO pa_clients(id,name,organization_id,active) VALUES('pa-child-no-login','No Login Contact','pa-org',1);
    INSERT INTO pa_clients VALUES('pa-standalone','Standalone One',NULL,1,'{"public_id":"${standaloneUuid}"}');
  `);
  await applySql(ops, readFileSync(new URL("../migrations/0032_client_hub_directory.sql", import.meta.url), "utf8").replace(/^\s*--.*$/gm, ""));
  await applySql(ops, `
    INSERT INTO client_hub_roots(source_id,kind,public_id,display_name,sort_name,status,portal_status,workspace_id,legacy_account_id,account_count,project_count,request_count,contact_count)
      VALUES('project-alpha:primary','organization','pa-org','Organization One','organization one','active','active','workspace-org','account-org',1,0,0,2),
        ('project-alpha:primary','standalone_client','pa-standalone','Standalone One','standalone one','active','not_provisioned',NULL,'account-standalone',1,1,1,1);
    UPDATE client_hub_directory_state SET ready=1;
    UPDATE client_hub_roots SET pa_public_id='${organizationUuid}' WHERE public_id='pa-org';
    UPDATE client_hub_roots SET pa_public_id='${standaloneUuid}' WHERE public_id='pa-standalone';
  `);
  await applySql(delivery, `
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT,status TEXT,project_alpha_client_id TEXT,
      project_alpha_organization_id TEXT,created_at TEXT,updated_at TEXT);
    CREATE UNIQUE INDEX account_pa_client ON client_accounts(project_alpha_client_id) WHERE project_alpha_client_id IS NOT NULL;
    CREATE UNIQUE INDEX account_pa_organization ON client_accounts(project_alpha_organization_id) WHERE project_alpha_organization_id IS NOT NULL;
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,
      pa_client_public_id TEXT,display_name TEXT,status TEXT,legacy_account_id TEXT);
    CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,source_generation TEXT,
      source_sequence INTEGER,status TEXT,complete INTEGER);
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT,source_sequence INTEGER);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,
      parent_public_id TEXT,active INTEGER,source_version TEXT);
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
    INSERT INTO portal_v2_workspaces VALUES('workspace-org','organization','${organizationUuid}',NULL,'Organization One','active','account-org');
    INSERT INTO portal_v2_directory_generations VALUES('generation-org','workspace-org','native-1',1,'active',1);
    INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-org','generation-org',1);
    INSERT INTO portal_v2_directory_entities VALUES('workspace-org','generation-org','organization','${organizationUuid}',NULL,1,'native-version');
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
  return { app, env, ops, delivery };
}

afterEach(async () => {
  vi.clearAllMocks();
  acl.sqlScope.mockResolvedValue({ global: true, deniedGlobal: false });
  acl.isAdministrator.mockResolvedValue(true);
  principal.id = "staff-one";
  await Promise.all(active.splice(0).map(item => item.dispose()));
});

type Page = { available: boolean; reason: string | null; nextCursor: string | null; hasMore: boolean; returned: number; limit: number };
type CollectionResponse = { items: Array<Record<string, unknown>>; page: Page; contextVersion: string;
  canonicalRoot: { sourceId: string; rootNamespace: string; kind: string; publicId: string } };
const organizationPath = "http://local/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/pa-org";
const standalonePath = "http://local/api/client-hub/sources/project-alpha%3Aprimary/business/standalone/pa-standalone";
async function readCollection(app: Awaited<ReturnType<typeof fixture>>["app"], env: Env, path: string,
  name: string, cursor?: string | null, limit = 100): Promise<CollectionResponse> {
  const response = await app.request(`${path}/collections/${name}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {}, env);
  if (response.status !== 200) throw new Error(`Collection ${name} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<CollectionResponse>;
}

describe("Client Hub bounded detail collections", () => {
  it("pages more than 500 business contacts separately from the existing portal identities", async () => {
    const { app, env, ops } = await fixture();
    await applySql(ops, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<528)
      INSERT INTO pa_clients(id,name,organization_id,active) SELECT printf('bulk-%04d',n),'Business '||n,'pa-org',1 FROM ids;`);
    const detail = await app.request(organizationPath, {}, env);
    expect(detail.status).toBe(200);
    const initial = await detail.json() as { contacts: Array<Record<string, unknown>>; pages: Record<string, Page>; contextVersion: string };
    expect(initial.contacts.filter(row => row.record_type === "business_contact")).toHaveLength(5);
    expect(initial.contacts.filter(row => row.record_type === "portal_principal")).toHaveLength(1);
    expect(initial.pages.businessContacts).toMatchObject({ available: true, hasMore: true, returned: 5, limit: 5 });
    const seen = initial.contacts.filter(row => row.record_type === "business_contact").map(row => row.public_id);
    let cursor = initial.pages.businessContacts!.nextCursor;
    eligibility.listClientIdentityEligibility.mockClear();
    while (cursor) {
      const page = await readCollection(app, env, organizationPath, "businessContacts", cursor);
      expect(page.contextVersion).toBe(initial.contextVersion);
      expect(page.items.every(row => row.record_type === "business_contact" && row.identity_id === null)).toBe(true);
      expect(page.items.every(row => !Object.keys(row).some(key => key.startsWith("__cursor_")))).toBe(true);
      seen.push(...page.items.map(row => row.public_id));
      cursor = page.page.nextCursor;
    }
    expect(seen).toHaveLength(531);
    expect(new Set(seen).size).toBe(531);
    expect(eligibility.listClientIdentityEligibility).not.toHaveBeenCalled();
  }, 60_000);

  it("loads bounded first pages and every row beyond 200 across each grant/request inventory", async () => {
    const { app, env, delivery } = await fixture();
    await applySql(delivery, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<209)
      INSERT INTO projects SELECT printf('bulk-%04d',n),'Project '||n,'Organization','clients/org/',1,NULL FROM ids;
      INSERT INTO client_project_grants SELECT 'account-org',id,1,'2026-01-01',NULL FROM projects WHERE substr(id,1,5)='bulk-';
      INSERT INTO client_service_requests SELECT id,'account-org',id,'service','Request '||id,'submitted',NULL,'2026-02-01' FROM projects WHERE substr(id,1,5)='bulk-';
      INSERT INTO shares SELECT id,'Share '||id,'clients/org/'||id||'/','2026-01-01' FROM projects WHERE substr(id,1,5)='bulk-';
      INSERT INTO client_delivery_grants SELECT 'account-org',id,id,'2026-01-01',NULL,NULL FROM projects WHERE substr(id,1,5)='bulk-';
      INSERT INTO portal_v2_folder_bindings SELECT id,'workspace-org','clients/org/'||id||'/','organization','${organizationUuid}' FROM projects WHERE substr(id,1,5)='bulk-';
      INSERT INTO portal_v2_authenticated_delivery_grants SELECT id,'workspace-org',id,'workspace',NULL,'active',NULL,'2026-01-01','2026-02-01' FROM projects WHERE substr(id,1,5)='bulk-';
      INSERT INTO viewer_client_grants(id,account_id,project_id,scope_type,status,created_at,updated_at)
        SELECT id,'account-org',id,'project','active','2026-01-01','2026-02-01' FROM projects WHERE substr(id,1,5)='bulk-';
      INSERT INTO portal_v2_folder_bindings VALUES('foreign','other-workspace','clients/private/','organization','private');
      INSERT INTO portal_v2_authenticated_delivery_grants VALUES('bad-grant','workspace-org','foreign','workspace',NULL,'active',NULL,'9999','9999');`);
    const response = await app.request(organizationPath, {}, env);
    expect(response.status).toBe(200);
    const initial = await response.json() as Record<string, unknown> & { pages: Record<string, Page> };
    for (const name of ["projects", "requests", "deliveryGrants", "authenticatedDeliveryGrants", "viewerGrants"]) {
      const seen = (initial[name] as Array<Record<string, unknown>>).map(row => row.row_key);
      expect(seen).toHaveLength(5);
      expect(initial.pages[name]).toMatchObject({ available: true, hasMore: true, returned: 5 });
      let cursor = initial.pages[name]!.nextCursor;
      while (cursor) {
        const page = await readCollection(app, env, organizationPath, name, cursor);
        expect(page.items.some(row => row.id === "bad-grant" || row.r2_prefix === "clients/private/")).toBe(false);
        seen.push(...page.items.map(row => row.row_key));
        cursor = page.page.nextCursor;
      }
      expect(seen).toHaveLength(210);
      expect(new Set(seen).size).toBe(210);
    }
    expect(initial.pages.accounts).toMatchObject({ returned: 1, hasMore: false });
  }, 60_000);

  it("rejects malformed, wrong-root, wrong-collection, wrong-actor and invalid-limit cursors", async () => {
    const { app, env } = await fixture();
    const first = await readCollection(app, env, organizationPath, "businessContacts", null, 1);
    expect(first.page.nextCursor).toBeTruthy();
    for (const url of [
      `${organizationPath}/collections/businessContacts?cursor=not-json`,
      `${organizationPath}/collections/businessContacts?limit=0`,
      `${organizationPath}/collections/businessContacts?limit=101`,
      `${organizationPath}/collections/businessContacts?limit=abc`,
      `${organizationPath}/collections/unknown`,
      `${organizationPath}/collections/accounts?cursor=${first.page.nextCursor}`,
      `${standalonePath}/collections/businessContacts?cursor=${first.page.nextCursor}`,
    ]) expect((await app.request(url, {}, env)).status).toBe(400);
    principal.id = "other-staff";
    expect((await app.request(`${organizationPath}/collections/businessContacts?cursor=${first.page.nextCursor}`, {}, env)).status).toBe(409);
  }, 30_000);

  it("invalidates pages when exact mapping proof or management authority changes", async () => {
    const { app, env, delivery } = await fixture();
    const first = await readCollection(app, env, organizationPath, "businessContacts", null, 1);
    await delivery.prepare("UPDATE portal_v2_directory_entities SET source_version='next-version' WHERE workspace_id='workspace-org'").run();
    expect((await app.request(`${organizationPath}/collections/businessContacts?cursor=${first.page.nextCursor}`, {}, env)).status).toBe(409);
    const second = await readCollection(app, env, organizationPath, "businessContacts", null, 1);
    acl.isAdministrator.mockResolvedValue(false);
    expect((await app.request(`${organizationPath}/collections/businessContacts?cursor=${second.page.nextCursor}`, {}, env)).status).toBe(409);
  });

  it("invalidates an account reparent even when the business root has no portal workspace", async () => {
    const { app, env, delivery } = await fixture();
    await delivery.prepare("INSERT INTO client_service_requests VALUES('request-two','account-standalone','project-one','service','Next request','submitted','2026-02-01','2026-02-01')").run();
    const first = await readCollection(app, env, standalonePath, "requests", null, 1);
    await delivery.prepare("UPDATE client_accounts SET project_alpha_client_id='different-client' WHERE id='account-standalone'").run();
    expect((await app.request(`${standalonePath}/collections/requests?cursor=${first.page.nextCursor}`, {}, env)).status).toBe(409);
    const refreshed = await readCollection(app, env, standalonePath, "requests");
    expect(refreshed.items).toEqual([]);
  });

  it("rechecks live business-contact ownership before limit and uses immutable IDs rather than names", async () => {
    const { app, env, ops } = await fixture();
    await ops.prepare("INSERT INTO pa_clients(id,name,organization_id,active) VALUES('zz-last','Last Contact','pa-org',1)").run();
    const first = await readCollection(app, env, organizationPath, "businessContacts", null, 1);
    await ops.batch([
      ops.prepare("UPDATE pa_clients SET organization_id='other-org' WHERE id='pa-child-no-login'"),
      ops.prepare("UPDATE pa_clients SET name='A renamed contact' WHERE id='zz-last'"),
    ]);
    const next = await readCollection(app, env, organizationPath, "businessContacts", first.page.nextCursor, 1);
    expect(next.items.map(row => row.public_id)).toEqual(["zz-last"]);
    expect(next.page.hasMore).toBe(false);
    await ops.prepare("UPDATE pa_organizations SET active=0 WHERE id='pa-org'").run();
    expect((await app.request(`${organizationPath}/collections/businessContacts`, {}, env)).status).toBe(404);
  });

  it("exposes unavailable metadata without presenting a denied collection as an empty full history", async () => {
    const { app, env } = await fixture();
    acl.sqlScope.mockImplementation(async (...args: unknown[]) => ({ global: args[2] === "team.view", deniedGlobal: false }));
    const response = await app.request(standalonePath, {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ requests: [], deliveryGrants: [], viewerGrants: [], pages: {
      requests: { available: false, reason: "permission_required" },
      deliveryGrants: { available: false, reason: "permission_required" },
      viewerGrants: { available: false, reason: "permission_required" },
    } });
    for (const name of ["requests", "deliveryGrants", "authenticatedDeliveryGrants", "viewerGrants"])
      expect((await app.request(`${standalonePath}/collections/${name}`, {}, env)).status).toBe(403);
    acl.sqlScope.mockResolvedValue({ global: true, deniedGlobal: false });
    expect((await readCollection(app, env, standalonePath, "authenticatedDeliveryGrants")).page)
      .toMatchObject({ available: false, reason: "workspace_unavailable", returned: 0, hasMore: false });
    acl.sqlScope.mockResolvedValue({ global: false, deniedGlobal: false });
    expect((await app.request(`${organizationPath}/collections/businessContacts`, {}, env)).status).toBe(403);
  });

  it.each([0, 1])("continues a retained portal alias using its live canonical business root when the index row is absent (ready=%s)", async ready => {
    const { app, env, ops } = await fixture();
    await ops.prepare("DELETE FROM client_hub_roots WHERE public_id='pa-org'").run();
    await ops.prepare("UPDATE client_hub_directory_state SET ready=?").bind(ready).run();
    const alias = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/portal/organizations/workspace-org", {}, env);
    expect(alias.status).toBe(200);
    await expect(alias.json()).resolves.toMatchObject({ client: { root_namespace: "business", public_id: "pa-org" } });
    const first = await readCollection(app, env, organizationPath, "businessContacts", null, 1);
    expect(first.canonicalRoot).toEqual({ sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "pa-org" });
    expect((await readCollection(app, env, organizationPath, "businessContacts", first.page.nextCursor, 1)).items).toHaveLength(1);
  }, 30_000);

  it("does not bypass canonical ID validation through live-source fallback", async () => {
    const { app, env, ops } = await fixture();
    for (const id of ["x".repeat(513), "bad\u0001id"]) {
      await ops.prepare("INSERT INTO pa_organizations VALUES(?,'Invalid source ID',1,'{}')").bind(id).run();
      const path = `http://local/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/${encodeURIComponent(id)}`;
      expect((await app.request(path, {}, env)).status).toBe(404);
      expect((await app.request(`${path}/collections/businessContacts`, {}, env)).status).toBe(404);
    }
  });

  it.each(["suspended", "disabled"])("keeps an active business alias stable when its verified portal is %s", async portalStatus => {
    const { app, env, ops, delivery } = await fixture();
    await ops.prepare("DELETE FROM client_hub_roots WHERE public_id='pa-org'").run();
    await ops.prepare("UPDATE client_hub_directory_state SET ready=0").run();
    await delivery.prepare("UPDATE portal_v2_workspaces SET status=? WHERE id='workspace-org'").bind(portalStatus).run();
    await applySql(ops, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<5)
      INSERT INTO pa_clients(id,name,organization_id,active) SELECT 'extra-'||n,'Contact '||n,'pa-org',1 FROM ids;`);
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/portal/organizations/workspace-org", {}, env);
    expect(response.status).toBe(200);
    const detail = await response.json() as { client: Record<string, unknown>; pages: Record<string, Page>; contextVersion: string };
    expect(detail.client).toMatchObject({ root_namespace: "business", public_id: "pa-org", status: "active", portal_status: portalStatus });
    expect(detail.pages.businessContacts!.nextCursor).toBeTruthy();
    const continuation = await readCollection(app, env, organizationPath, "businessContacts", detail.pages.businessContacts!.nextCursor);
    expect(continuation.items).toHaveLength(3);
    expect(continuation.contextVersion).toBe(detail.contextVersion);
  }, 30_000);
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
        blocks: [],
        canManageEligibilityBlocks: true,
        canManagePortal: true,
      },
    });
  });

  it("loads only selected organization contacts, keeping business contacts distinct from portal principals", async () => {
    const { app, env } = await fixture();
    const response = await app.request("http://local/api/client-hub", {}, env);
    const body = await response.json() as { clients: Array<Record<string, unknown>> };
    const organization = body.clients.find(client => client.public_id === "pa-org");
    expect(organization).toMatchObject({ workspace_id: "workspace-org", contact_count: 2 });
    expect(organization).not.toHaveProperty("contacts");
    expect(eligibility.listClientIdentityEligibility).not.toHaveBeenCalled();
    const detail = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/organizations/pa-org", {}, env);
    expect(detail.status).toBe(200);
    const result = await detail.json() as { contacts: Array<Record<string, unknown>> };
    expect(result.contacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ public_id: "pa-child-login", identity_id: "identity-login", record_type: "portal_principal" }),
      expect.objectContaining({ public_id: "pa-child-login", identity_id: null, record_type: "business_contact" }),
      expect.objectContaining({ public_id: "pa-child-no-login", identity_id: null, record_type: "business_contact" }),
    ]));
    expect(new Set(result.contacts.map(contact => contact.contact_key)).size).toBe(3);
    expect(eligibility.listClientIdentityEligibility.mock.calls.at(-1)?.[2]).toEqual({ workspaceId: "workspace-org" });
  });

  it("does not confuse local accounts with an Alpha client having the same raw ID", async () => {
    const { app, env, ops, delivery } = await fixture();
    await applySql(ops, `INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status,legacy_account_id)
      VALUES('delivery:local','account','standalone_client','pa-standalone','Local Client','local client','active','pa-standalone');`);
    await applySql(delivery, `INSERT INTO client_accounts VALUES('pa-standalone','Local Client','active',NULL,NULL,datetime('now'),datetime('now'));`);
    expect((await app.request("http://local/api/client-hub/standalone/pa-standalone", {}, env)).status).toBe(409);
    const local = await app.request("http://local/api/client-hub/sources/delivery%3Alocal/standalone/pa-standalone", {}, env);
    await expect(local.json()).resolves.toMatchObject({ client: { source_id: "delivery:local" },
      accounts: [{ id: "pa-standalone" }], contacts: [], projects: [] });
    const alpha = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/standalone/pa-standalone", {}, env);
    await expect(alpha.json()).resolves.toMatchObject({ client: { source_id: "project-alpha:primary" },
      accounts: [{ id: "account-standalone" }], projects: [{ id: "project-one" }] });
  });

  it("keeps exact client detail available when more than 500 other roots exist", async () => {
    const { app, env, ops } = await fixture();
    await applySql(ops, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<509)
      INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status)
      SELECT 'delivery:local','account','standalone_client','other-'||n,'Other '||n,'other '||n,'active' FROM ids;`);
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/standalone/pa-standalone", {}, env);
    expect(response.status).toBe(200);
    expect(eligibility.listClientIdentityEligibility).not.toHaveBeenCalled();
  }, 30_000);

  it("does not hydrate a stale cached workspace or legacy account after reassignment", async () => {
    const { app, env, delivery } = await fixture();
    await delivery.prepare("UPDATE portal_v2_workspaces SET pa_organization_public_id='different-org' WHERE id='workspace-org'").run();
    await delivery.prepare("UPDATE client_accounts SET project_alpha_organization_id='different-org' WHERE id='account-org'").run();
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/organizations/pa-org", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ client: { workspace_id: null }, accounts: [], projects: [], authenticatedDeliveryGrants: [] });
    expect(eligibility.listClientIdentityEligibility).not.toHaveBeenCalled();
  });

  it("does not revive an inactive or organization-reassigned Alpha client through a stale indexed root", async () => {
    const { app, env, ops } = await fixture();
    await ops.prepare("UPDATE pa_clients SET organization_id='pa-org' WHERE id='pa-standalone'").run();
    expect((await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/standalone/pa-standalone", {}, env)).status).toBe(404);
    await ops.prepare("UPDATE pa_organizations SET active=0 WHERE id='pa-org'").run();
    expect((await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/organizations/pa-org", {}, env)).status).toBe(404);
    expect(eligibility.listClientIdentityEligibility).not.toHaveBeenCalled();
  });

  it("joins numeric business IDs to distinct native public IDs without changing legacy account joins", async () => {
    const { app, env, ops, delivery } = await fixture();
    await ops.batch([
      ops.prepare("UPDATE pa_organizations SET id='101' WHERE id='pa-org'"),
      ops.prepare("UPDATE pa_clients SET organization_id='101' WHERE organization_id='pa-org'"),
      ops.prepare("UPDATE client_hub_roots SET public_id='101' WHERE public_id='pa-org'"),
    ]);
    await delivery.prepare("UPDATE client_accounts SET project_alpha_organization_id='101' WHERE id='account-org'").run();
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/101", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ client: {
      public_id: "101", pa_public_id: organizationUuid, workspace_id: "workspace-org", root_namespace: "business",
    }, accounts: [{ id: "account-org", project_alpha_organization_id: "101" }] });
    expect(eligibility.listClientIdentityEligibility.mock.calls.at(-1)?.[2]).toEqual({ workspaceId: "workspace-org" });
  });

  it.each([
    ["{}", "missing"],
    ["broken-json", "invalid"],
    ['{"public_id":"pa-org"}', "invalid"],
  ])("does not attach a cached native workspace with unsupported mapping %s", async (payload, status) => {
    const { app, env, ops } = await fixture();
    await ops.prepare("UPDATE pa_organizations SET payload_json=? WHERE id='pa-org'").bind(payload).run();
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/pa-org", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ client: { pa_public_id: null, mapping_status: status,
      workspace_id: null, portal_status: "mapping_unavailable" }, accounts: [{ id: "account-org" }], authenticatedDeliveryGrants: [] });
    expect(eligibility.listClientIdentityEligibility).not.toHaveBeenCalled();
  });

  it("does not pick a winner when two source records export the same public ID", async () => {
    const { app, env, ops } = await fixture();
    await ops.prepare("INSERT INTO pa_organizations VALUES('other-org','Other organization',1,?)")
      .bind(JSON.stringify({ public_id: organizationUuid })).run();
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/pa-org", {}, env);
    await expect(response.json()).resolves.toMatchObject({ client: { pa_public_id: null, mapping_status: "ambiguous",
      workspace_id: null, portal_status: "mapping_unavailable" } });
    expect(eligibility.listClientIdentityEligibility).not.toHaveBeenCalled();
  });

  it("re-reads changed source public IDs instead of trusting stale cached directory associations", async () => {
    const { app, env, ops } = await fixture();
    await ops.prepare("UPDATE pa_organizations SET payload_json=? WHERE id='pa-org'")
      .bind(JSON.stringify({ public_id: replacementUuid })).run();
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/pa-org", {}, env);
    await expect(response.json()).resolves.toMatchObject({ client: { pa_public_id: replacementUuid, workspace_id: null }, authenticatedDeliveryGrants: [] });
    const listing = await app.request("http://local/api/client-hub", {}, env);
    await expect(listing.json()).resolves.toMatchObject({ clients: expect.arrayContaining([
      expect.objectContaining({ public_id: "pa-org", pa_public_id: replacementUuid, workspace_id: null, portal_status: "mapping_unavailable" }),
    ]) });
    expect(eligibility.listClientIdentityEligibility).not.toHaveBeenCalled();
  });

  it("retains exact portal-only detail without inventing business or legacy account ownership", async () => {
    const { app, env, ops } = await fixture();
    await ops.prepare("DELETE FROM pa_organizations WHERE id='pa-org'").run();
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/portal/organizations/workspace-org", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ client: { root_namespace: "portal", public_id: "workspace-org",
      workspace_id: "workspace-org", legacy_account_id: null }, accounts: [], projects: [],
      contacts: [expect.objectContaining({ record_type: "portal_principal" })] });
  });

  it("resolves retained portal URLs to a verified business alias even after its index row was folded away", async () => {
    const { app, env, ops } = await fixture();
    expect(await ops.prepare("SELECT count(*) n FROM client_hub_roots WHERE root_namespace='portal'").first("n")).toBe(0);
    const response = await app.request("http://local/api/client-hub/sources/project-alpha%3Aprimary/portal/organizations/workspace-org", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ client: { root_namespace: "business", public_id: "pa-org",
      pa_public_id: organizationUuid, detail_path: "/clients/sources/project-alpha%3Aprimary/business/organizations/pa-org" },
      accounts: [{ id: "account-org" }] });
  });
});
