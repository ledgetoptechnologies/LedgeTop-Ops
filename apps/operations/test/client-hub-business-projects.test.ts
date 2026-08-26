import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlScope } from "../src/worker/acl";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { applyConnectorSchema } from "./helpers/project-alpha-connectors";

const acl = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true),
  sqlScope: vi.fn(async (): Promise<SqlScope> => ({ global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false })),
  isAdministrator: vi.fn(async () => true), hasLocalGlobalAllow: vi.fn(async () => false) }));
vi.mock("../src/worker/acl", () => acl);
import { listClientHubBusinessProjects } from "../src/worker/client-hub-business-projects";

const active: Miniflare[] = [];
const staff = { id: "staff-a", projectAlphaUserId: "user-a" } as StaffPrincipal;
const scope: SqlScope = { global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false };
function context(kind: "organization" | "standalone_client" = "organization", id = "org-a"): ClientHubCollectionContext {
  return {
    root: { source_id: "project-alpha:primary", root_namespace: "business", kind, public_id: id,
      pa_public_id: null, mapping_status: "missing", display_name: id, sort_name: id, status: "active",
      portal_status: "not_provisioned", workspace_id: null, legacy_account_id: null, account_count: 0,
      project_count: 0, request_count: 0, contact_count: 0, meaningful_activity_at: null,
      source_version: null, indexed_at: "", scan_generation: 0 },
    canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind, publicId: id },
    access: { directory: true, requests: true, delivery: true, viewer: true }, contextVersion: "a".repeat(43),
  };
}
const sql = (db: D1Database, statement: string) => db.exec(statement.replace(/\s*\n\s*/g, " "));
async function fixture() {
  const mf = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){ return new Response('ok'); } }", d1Databases: { OPS_DB: "business-projects" } });
  active.push(mf);
  const db = await mf.getD1Database("OPS_DB") as unknown as D1Database;
  await applyConnectorSchema(db);
  await sql(db, `CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,start_date TEXT,end_date TEXT,client_id TEXT,
      organization_id TEXT,manager_user_id TEXT,active INTEGER,payload_json TEXT,updated_at TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_users(id TEXT PRIMARY KEY,display_name TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_project_assignments(project_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_operations(id TEXT PRIMARY KEY,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_tasks(id TEXT PRIMARY KEY,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_task_assignments(task_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('org-a','Org A',1,'{}'),('org-b','Org B',1,'{}');
    INSERT INTO pa_clients(id,name,organization_id,active,payload_json) VALUES('client-a','Contact A','org-a',1,'{}'),('client-b','Contact B','org-b',1,'{}'),
      ('standalone','Standalone',NULL,1,'{}'),('inactive','Inactive','org-a',0,'{}');
    INSERT INTO pa_users(id,display_name) VALUES('user-a','Manager A');`);
  const env = { OPS_DB: db } as Env;
  async function project(id: string, values: { client?: string | null; organization?: string | null; status?: string;
    created?: unknown; payload?: string; active?: number; manager?: string | null; syncTime?: string } = {}) {
    await db.prepare(`INSERT INTO pa_projects(id,name,status,start_date,end_date,client_id,organization_id,manager_user_id,active,payload_json,updated_at) VALUES(?,?,?,'2026-08-01',NULL,?,?,?,?,?,?)`)
      .bind(id, `Project ${id}`, values.status ?? "active", values.client === undefined ? "client-a" : values.client,
        values.organization ?? null, values.manager ?? null, values.active ?? 1,
        values.payload ?? JSON.stringify({ created_at: values.created ?? "2026-01-01T00:00:00Z", confidential: "do not expose" }),
        values.syncTime ?? "2026-08-25").run();
  }
  return { db, env, project };
}
afterEach(async () => {
  vi.resetAllMocks();
  acl.hasPermission.mockResolvedValue(true); acl.sqlScope.mockResolvedValue(scope);
  acl.isAdministrator.mockResolvedValue(true); acl.hasLocalGlobalAllow.mockResolvedValue(false);
  staff.id = "staff-a"; staff.projectAlphaUserId = "user-a";
  await Promise.all(active.splice(0).map(item => item.dispose()));
});

describe("Client Hub business project history", () => {
  it("pages past 200 records independently of delivery grants, with bounded first and subsequent pages", async () => {
    const { db, env } = await fixture();
    await sql(db, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<212)
      INSERT INTO pa_projects(id,name,status,start_date,end_date,client_id,organization_id,manager_user_id,active,payload_json,updated_at) SELECT printf('project-%04d',n),'Project '||n,'completed',NULL,NULL,'client-a',NULL,NULL,1,
        '{"created_at":"2026-01-01T00:00:00Z","private":"hidden"}','2026-08-25' FROM ids;`);
    const first = await listClientHubBusinessProjects(env, staff, context(), { initial: true });
    expect(first.page).toMatchObject({ available: true, limit: 5, returned: 5, hasMore: true });
    const ids = first.items.map(item => item.id);
    let cursor = first.page.nextCursor;
    while (cursor) {
      const next = await listClientHubBusinessProjects(env, staff, context(), { cursor });
      expect(next.page.limit).toBe(25);
      ids.push(...next.items.map(item => item.id)); cursor = next.page.nextCursor;
    }
    expect(ids).toHaveLength(213); expect(new Set(ids).size).toBe(213);
    expect(first.items[0]).not.toHaveProperty("payload_json");
    expect(first.items[0]).not.toHaveProperty("r2_prefix");
    expect(first.items[0]).not.toHaveProperty("updated_at");
    expect(first.items[0]).not.toHaveProperty("__created");
    expect(first.items[0]?.row_key).toBe(JSON.stringify(["businessProjects", "project-alpha:primary", "project-0212"]));
  }, 60_000);

  it("normalizes source timezone offsets, puts malformed or missing dates last, and ignores local sync times", async () => {
    const { env, project } = await fixture();
    await project("utc-newer", { created: "2026-02-01T05:00:00Z", syncTime: "2020-01-01" });
    await project("offset-older", { created: "2026-02-01T09:00:00+05:00", syncTime: "2099-01-01" });
    await project("unknown-z", { payload: "not-json" });
    await project("unknown-y", { payload: '{"created_at":"now"}' });
    await project("unknown-x", { payload: '{"created_at":42}' });
    await project("unknown-w", { payload: "{}" });
    await project("unknown-v", { payload: "[]" });
    await project("unknown-u", { payload: '{"created_at":"not-a-date"}' });
    await project("unknown-t", { payload: '{"created_at":"2026-02-30T12:00:00Z"}' });
    const found: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const page = await listClientHubBusinessProjects(env, staff, context(), { limit: 1, cursor });
      found.push(...page.items); cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    expect(found.map(item => item.id)).toEqual(["utc-newer", "offset-older", "unknown-z", "unknown-y", "unknown-x", "unknown-w", "unknown-v", "unknown-u", "unknown-t"]);
    expect(found[1]?.created_at).toBe("2026-02-01T04:00:00.000Z");
    expect(found.slice(2).every(item => item.created_at === null)).toBe(true);
  }, 30_000);

  it("uses factual current/completed/cancelled filters without treating source-active as current work", async () => {
    const { env, project } = await fixture();
    for (const status of ["not_started", "active", "overdue", "completed", "cancelled", "custom_status"])
      await project(status, { status });
    await project("deleted", { status: "completed", active: 0 });
    expect((await listClientHubBusinessProjects(env, staff, context(), { filter: "all" })).items).toHaveLength(6);
    expect((await listClientHubBusinessProjects(env, staff, context(), { filter: "current" })).items.map(row => row.status).sort())
      .toEqual(["active", "not_started", "overdue"]);
    expect((await listClientHubBusinessProjects(env, staff, context(), { filter: "completed" })).items.map(row => row.status)).toEqual(["completed"]);
    expect((await listClientHubBusinessProjects(env, staff, context(), { filter: "cancelled" })).items.map(row => row.status)).toEqual(["cancelled"]);
  });

  it("uses exact current ownership with explicit organization precedence and inactive-owner exclusion", async () => {
    const { db, env, project } = await fixture();
    await project("inherited"); await project("explicit", { client: "client-b", organization: "org-a" });
    await project("other-org", { organization: "org-b" }); await project("inactive-owner", { client: "inactive" });
    await project("standalone", { client: "standalone" });
    expect((await listClientHubBusinessProjects(env, staff, context())).items.map(row => row.id).sort()).toEqual(["explicit", "inherited"]);
    const solo = context("standalone_client", "standalone");
    expect((await listClientHubBusinessProjects(env, staff, solo)).items.map(row => row.id)).toEqual(["standalone"]);
    await db.prepare("UPDATE pa_projects SET organization_id='org-b' WHERE id='standalone'").run();
    expect((await listClientHubBusinessProjects(env, staff, solo)).items).toEqual([]);
    await db.prepare("UPDATE pa_clients SET organization_id='org-a' WHERE id='standalone'").run();
    await expect(listClientHubBusinessProjects(env, staff, solo)).rejects.toMatchObject({ status: 404 });
  });

  it("requires project permission in addition to directory access", async () => {
    const { env, project } = await fixture(); await project("hidden");
    acl.hasPermission.mockResolvedValue(false);
    expect((await listClientHubBusinessProjects(env, staff, context(), { initial: true })).page)
      .toMatchObject({ available: false, reason: "permission_required" });
    await expect(listClientHubBusinessProjects(env, staff, context())).rejects.toMatchObject({ status: 403 });
    acl.hasPermission.mockResolvedValue(true);
    acl.sqlScope.mockResolvedValue({ ...scope, deniedGlobal: true });
    await expect(listClientHubBusinessProjects(env, staff, context())).rejects.toMatchObject({ status: 403 });
  });

  it("honors manager, project, operation and task assignments without granting unrelated projects", async () => {
    const { db, env, project } = await fixture();
    acl.isAdministrator.mockResolvedValue(false);
    await project("managed", { manager: "user-a" });
    for (const id of ["direct", "operation", "task", "hidden"]) await project(id);
    await sql(db, `INSERT INTO pa_project_assignments(project_id,user_id,active) VALUES('direct','user-a',1);
      INSERT INTO pa_operations(id,project_id,active) VALUES('operation-a','operation',1);
      INSERT INTO pa_operation_assignments(operation_id,user_id,active) VALUES('operation-a','user-a',1);
      INSERT INTO pa_tasks(id,project_id,active) VALUES('task-a','task',1);
      INSERT INTO pa_task_assignments(task_id,user_id,active) VALUES('task-a','user-a',1);`);
    expect((await listClientHubBusinessProjects(env, staff, context())).items.map(row => row.id).sort())
      .toEqual(["direct", "managed", "operation", "task"]);
    acl.hasLocalGlobalAllow.mockResolvedValue(true);
    expect((await listClientHubBusinessProjects(env, staff, context())).items).toHaveLength(5);
    acl.sqlScope.mockResolvedValue({ ...scope, deniedGlobal: true });
    await expect(listClientHubBusinessProjects(env, staff, context())).rejects.toMatchObject({ status: 403 });
  });

  it("rechecks returned project ownership after the data query", async () => {
    const { db, env, project } = await fixture(); await project("moving");
    acl.isAdministrator.mockImplementationOnce(async () => true).mockImplementationOnce(async () => {
      await db.prepare("UPDATE pa_clients SET organization_id='org-b' WHERE id='client-a'").run(); return true;
    });
    await expect(listClientHubBusinessProjects(env, staff, context())).rejects.toMatchObject({ status: 409 });
  });

  it("rechecks live assignments after the data query, not only cached policy flags", async () => {
    const { db, env, project } = await fixture(); await project("assigned");
    await db.prepare("INSERT INTO pa_project_assignments(project_id,user_id,active) VALUES('assigned','user-a',1)").run();
    acl.isAdministrator.mockImplementationOnce(async () => false).mockImplementationOnce(async () => {
      await db.prepare("UPDATE pa_project_assignments SET active=0").run(); return false;
    });
    await expect(listClientHubBusinessProjects(env, staff, context())).rejects.toMatchObject({ status: 409 });
  });

  it("rejects cross-root, filter, actor, context, malformed and invalid-limit continuations", async () => {
    const { env, project } = await fixture(); await project("a"); await project("b");
    const first = await listClientHubBusinessProjects(env, staff, context(), { limit: 1 });
    const cursor = first.page.nextCursor!;
    await expect(listClientHubBusinessProjects(env, staff, context("organization", "org-b"), { cursor })).rejects.toMatchObject({ status: 400 });
    await expect(listClientHubBusinessProjects(env, staff, context(), { cursor, filter: "completed" })).rejects.toMatchObject({ status: 400 });
    await expect(listClientHubBusinessProjects(env, staff, { ...context(), contextVersion: "b".repeat(43) }, { cursor })).rejects.toMatchObject({ status: 409 });
    staff.id = "staff-b";
    await expect(listClientHubBusinessProjects(env, staff, context(), { cursor })).rejects.toMatchObject({ status: 409 });
    for (const limit of [0, 101, Number.NaN, 1.5])
      await expect(listClientHubBusinessProjects(env, staff, context(), { limit })).rejects.toMatchObject({ status: 400 });
    await expect(listClientHubBusinessProjects(env, staff, context(), { cursor: "bad-json" })).rejects.toMatchObject({ status: 400 });
  });

  it("never maps a portal workspace or local account ID directly to a business project", async () => {
    const { env, project } = await fixture(); await project("business");
    for (const namespace of ["portal", "account"] as const) {
      const current = context(); current.root.root_namespace = namespace;
      current.root.source_id = namespace === "account" ? "delivery:local" : "project-alpha:primary";
      expect((await listClientHubBusinessProjects(env, staff, current, { initial: true })).page)
        .toMatchObject({ available: false, reason: "not_applicable", returned: 0 });
    }
  });
});
