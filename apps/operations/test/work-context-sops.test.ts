import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  sqlScope: vi.fn(),
  hasLocalGlobalAllow: vi.fn(),
  loadGrants: vi.fn(),
  evaluatePermission: vi.fn(),
  auditAddress: vi.fn(),
}));

vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  requirePermission: mocks.requirePermission,
  sqlScope: mocks.sqlScope,
  hasLocalGlobalAllow: mocks.hasLocalGlobalAllow,
  loadGrants: mocks.loadGrants,
  evaluatePermission: mocks.evaluatePermission,
}));
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  auditAddress: mocks.auditAddress,
}));

import {
  decorateWorkContextsWithSops,
  readAuthorizedWorkContextSopRevision,
  registerWorkContextSopRoutes,
} from "../src/worker/work-context-sops";

type SqlValue = string | number | bigint | null | Uint8Array;

class D1Statement {
  values: unknown[] = [];
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly beforeExecute?: () => void | Promise<void>,
  ) {}
  bind(...values: unknown[]) {
    const next = new D1Statement(this.database, this.sql, this.beforeExecute);
    next.values = values;
    return next;
  }
  private statement(): StatementSync { return this.database.prepare(this.sql); }
  private bindings(): SqlValue[] {
    return this.values.map(value => value === undefined ? null : value as SqlValue);
  }
  async first<T>() {
    await this.beforeExecute?.();
    return (this.statement().get(...this.bindings()) as T | undefined) || null;
  }
  async all<T>() {
    await this.beforeExecute?.();
    return { results: this.statement().all(...this.bindings()) as T[], meta: { changes: 0 } };
  }
  async run<T>() {
    await this.beforeExecute?.();
    const result = this.statement().run(...this.bindings());
    return { results: [] as T[], meta: { changes: Number(result.changes) } };
  }
}

function d1(database: DatabaseSync) {
  let beforeStatement: (() => void | Promise<void>) | null = null;
  let beforeBatch: (() => void | Promise<void>) | null = null;
  const consumeStatementHook = async () => {
    const hook = beforeStatement;
    beforeStatement = null;
    await hook?.();
  };
  const api = {
    prepare(sql: string) { return new D1Statement(database, sql, consumeStatementHook); },
    withSession() { return api; },
    setBeforeStatement(hook: () => void | Promise<void>) { beforeStatement = hook; },
    setBeforeBatch(hook: () => void | Promise<void>) { beforeBatch = hook; },
    async batch(statements: D1Statement[]) {
      const hook = beforeBatch;
      beforeBatch = null;
      await hook?.();
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(
          /^\s*(SELECT|PRAGMA)\b/i.test(statement.sql)
            ? await statement.all()
            : await statement.run(),
        );
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return api;
}

const principals = {
  admin: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", accessSubject: "admin", projectAlphaUserId: "pa-admin" },
  pilot: { id: "staff-pilot", email: "pilot@example.test", displayName: "Colin Pilot", accessSubject: "pilot", projectAlphaUserId: "pa-pilot" },
  noSop: { id: "staff-no-sop", email: "nosop@example.test", displayName: "No SOP", accessSubject: "no-sop", projectAlphaUserId: "pa-no-sop" },
  operationOnly: { id: "staff-operation", email: "operation@example.test", displayName: "Operation Assignee", accessSubject: "operation", projectAlphaUserId: "pa-operation" },
  unrelated: { id: "staff-other", email: "other@example.test", displayName: "Other", accessSubject: "other", projectAlphaUserId: "pa-other" },
} as const;

const revisionOne = "11111111-1111-4111-8111-111111111111";
const revisionTwo = "22222222-2222-4222-8222-222222222222";

function setup(options: { withLinkSchema?: boolean } = {}) {
  const withLinkSchema = options.withLinkSchema ?? true;
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,project_alpha_user_id TEXT UNIQUE);
    CREATE TABLE permissions(key TEXT PRIMARY KEY,description TEXT NOT NULL);
    CREATE TABLE roles(id TEXT PRIMARY KEY);
    CREATE TABLE role_permissions(role_id TEXT NOT NULL,permission_key TEXT NOT NULL,PRIMARY KEY(role_id,permission_key));
    CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
    CREATE TABLE staff_permission_overrides(id TEXT PRIMARY KEY,staff_id TEXT NOT NULL,permission_key TEXT NOT NULL,effect TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
    CREATE TABLE operational_job_briefs(operation_id TEXT PRIMARY KEY);
    CREATE TABLE divisions(id TEXT PRIMARY KEY,project_alpha_business_unit_id TEXT UNIQUE);
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT,business_unit_id TEXT,manager_user_id TEXT,active INTEGER NOT NULL,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_project_assignments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,user_id TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE TABLE pa_operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE TABLE pa_operation_assignments(operation_id TEXT NOT NULL,user_id TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(operation_id,user_id));
    CREATE TABLE pa_tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT,business_unit_id TEXT,created_by_user_id TEXT,active INTEGER NOT NULL,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_task_assignments(task_id TEXT NOT NULL,user_id TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(task_id,user_id));
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,actor_email TEXT,actor_display_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,division_id TEXT,details_json TEXT,client_address_hash TEXT,created_at TEXT DEFAULT(datetime('now')));
  `);
  database.exec(readFileSync(new URL("../migrations/0020_internal_sop_library.sql", import.meta.url), "utf8"));
  if (withLinkSchema)
    database.exec(readFileSync(new URL("../migrations/0023_project_task_sop_links.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0025_sop_assignment_permission.sql", import.meta.url), "utf8"));
  const addStaff = database.prepare("INSERT INTO staff_users VALUES (?,?,?,?)");
  for (const principal of Object.values(principals))
    addStaff.run(principal.id, principal.email, principal.displayName, principal.projectAlphaUserId);
  database.prepare("INSERT INTO divisions VALUES ('division-flight','unit-flight')").run();
  database.prepare("INSERT INTO pa_projects(id,name,status,business_unit_id,manager_user_id,active) VALUES ('project-1','North site','active','unit-flight','pa-admin',1)").run();
  database.prepare("INSERT INTO pa_tasks(id,project_id,title,status,business_unit_id,created_by_user_id,active) VALUES ('task-1','project-1','Capture LiDAR','todo','unit-flight','pa-admin',1)").run();
  database.prepare("INSERT INTO pa_operations VALUES ('operation-1','project-1',1)").run();
  database.prepare("INSERT INTO pa_operation_assignments VALUES ('operation-1','pa-operation',1)").run();
  database.prepare("INSERT INTO pa_project_assignments VALUES ('project-pilot','project-1','pa-pilot',1)").run();
  database.prepare("INSERT INTO pa_project_assignments VALUES ('project-no-sop','project-1','pa-no-sop',1)").run();
  database.prepare("INSERT INTO pa_task_assignments VALUES ('task-1','pa-pilot',1)").run();
  database.prepare("INSERT INTO pa_task_assignments VALUES ('task-1','pa-no-sop',1)").run();
  database.exec(`
    INSERT OR IGNORE INTO permissions(key,description) VALUES
      ('projects.view','Projects'),('tasks.view','Tasks'),('operations.manage','Manage operations'),
      ('tasks.update','Update tasks'),('operations.view_all','View all work');
  `);
  const grant = database.prepare(`INSERT INTO staff_permission_overrides
    (id,staff_id,permission_key,effect,scope,division_id) VALUES (?,?,?,'allow','global',NULL)`);
  for (const permission of ["projects.view", "tasks.view", "sops.view", "sops.assign", "operations.manage", "tasks.update"])
    grant.run(`admin-${permission}`, principals.admin.id, permission);
  for (const permission of ["projects.view", "tasks.view", "sops.view"])
    grant.run(`pilot-${permission}`, principals.pilot.id, permission);
  for (const permission of ["projects.view", "tasks.view"])
    grant.run(`no-sop-${permission}`, principals.noSop.id, permission);
  for (const permission of ["projects.view", "sops.view"])
    grant.run(`operation-${permission}`, principals.operationOnly.id, permission);
  for (const permission of ["projects.view", "sops.view"])
    grant.run(`other-${permission}`, principals.unrelated.id, permission);
  database.prepare(`INSERT INTO sop_documents
    (id,slug,status,version,created_by,updated_by)
    VALUES ('sop-lidar','lidar-capture','draft',1,'staff-admin','staff-admin')`).run();
  database.prepare(`INSERT INTO sop_revisions
    (id,sop_id,revision_number,change_kind,title,purpose,markdown_body,rendered_html,toc_json,
      sanitizer_version,author_id,author_email,author_display_name,published_at)
    VALUES (?,'sop-lidar',1,'published','LiDAR capture','Collect a LiDAR dataset safely.',
      '# LiDAR','<h1>LiDAR</h1>','[]',1,'staff-admin','admin@example.test','Admin',datetime('now'))`).run(revisionOne);
  database.prepare(`UPDATE sop_documents SET status='published',published_revision_id=?,published_at=datetime('now')
    WHERE id='sop-lidar'`).run(revisionOne);
  const env = { OPS_DB: d1(database) } as any;
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    const key = c.req.header("X-Test-User") as keyof typeof principals | undefined;
    if (!key || !principals[key]) throw new HTTPException(401, { message: "Authentication required" });
    c.set("principal", principals[key]);
    c.set("administrator", key === "admin");
    await next();
  });
  app.onError((error, c) => error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: "Internal error" }, 500));
  registerWorkContextSopRoutes(app);
  return { database, env, app };
}

function request(path: string, user: keyof typeof principals, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Test-User", user);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`https://ops.example${path}`, { ...init, headers });
}

describe("Project and Task direct SOP links", () => {
  beforeEach(() => {
    mocks.sqlScope.mockReset().mockResolvedValue({
      global: false,
      divisions: [],
      assigned: true,
      own: false,
      deniedDivisions: [],
      deniedGlobal: false,
    });
    mocks.hasLocalGlobalAllow.mockReset().mockResolvedValue(false);
    mocks.auditAddress.mockReset().mockResolvedValue("address-hash");
    mocks.requirePermission.mockReset().mockImplementation(async (
      _env: unknown,
      principal: { id: string },
      permission: string,
    ) => {
      if (["projects.view", "tasks.view"].includes(permission)) return;
      if (permission === "sops.view" && principal.id !== principals.noSop.id) return;
      if (permission === "sops.assign" && principal.id === principals.admin.id) return;
      throw new HTTPException(403, { message: `Missing permission: ${permission}` });
    });
    mocks.loadGrants.mockReset().mockResolvedValue([]);
    mocks.evaluatePermission.mockReset().mockImplementation((
      _grants: unknown,
      principal: { id: string },
      permission: string,
    ) => permission === "sops.view"
      ? principal.id !== principals.noSop.id
      : permission === "sops.assign" && principal.id === principals.admin.id);
  });

  it("does not infer secondary-source SOP access from a primary staff assignment", async () => {
    const state = setup();
    for (const kind of ["project", "task"] as const) {
      const id = `${kind}-1`;
      const path = `/api/work-contexts/${kind}/${id}/sops`;
      expect((await state.app.fetch(request(path, "pilot"), state.env)).status).toBe(200);
      // Deliberately leave the synthetic same-ID assignment in place: source
      // provenance must reject it even before migration relationship guards.
      state.database.prepare(`UPDATE pa_${kind}s SET projection_source_id='project-alpha:secondary' WHERE id=?`).run(id);
      expect((await state.app.fetch(request(path, "pilot"), state.env)).status).toBe(404);
      expect((await state.app.fetch(request(path, "admin"), state.env)).status).toBe(200);
    }
  });

  it("degrades list decoration and returns a stable capability response before migration 0023", async () => {
    const state = setup({ withLinkSchema: false });
    await expect(decorateWorkContextsWithSops(
      state.env,
      principals.admin,
      "project",
      [{ id: "project-1", name: "North site" }],
    )).resolves.toEqual([{
      id: "project-1",
      name: "North site",
      sopLinks: [],
      sopLinkVersion: 0,
      canManageSops: false,
    }]);

    const read = await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "admin",
    ), state.env);
    expect(read.status).toBe(503);
    expect(await read.json()).toEqual({
      error: "Work-context SOP links are temporarily unavailable",
      code: "capability_unavailable",
    });

    const write = await state.app.fetch(request("/api/work-contexts/task/task-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [] }),
    }), state.env);
    expect(write.status).toBe(503);
    await expect(readAuthorizedWorkContextSopRevision(
      state.env,
      principals.admin,
      "project",
      "project-1",
      "lidar-capture",
      revisionOne,
    )).rejects.toMatchObject({ status: 404 });
  });

  it("pins exact revisions without Project-to-Task inheritance and rejects stale replacement", async () => {
    const state = setup();
    const projectPut = await state.app.fetch(request("/api/work-contexts/project/project-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), state.env);
    expect(projectPut.status).toBe(200);
    expect(await projectPut.json()).toMatchObject({
      version: 1,
      context: { kind: "project", id: "project-1" },
      sops: [{
        revisionId: revisionOne,
        revisionNumber: 1,
        href: `/sops/lidar-capture/revisions/${revisionOne}?contextKind=project&contextId=project-1`,
      }],
    });

    const pilotProject = await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "pilot",
    ), state.env);
    expect(pilotProject.status).toBe(200);
    const pilotBody = await pilotProject.json() as any;
    expect(pilotBody.canEdit).toBe(false);
    expect(JSON.stringify(pilotBody)).not.toContain("<h1>");
    expect(JSON.stringify(pilotBody)).not.toContain("markdown");
    const operationAssignee = await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "operationOnly",
    ), state.env);
    expect(operationAssignee.status).toBe(200);
    expect(await operationAssignee.json()).toMatchObject({
      canEdit: false,
      sops: [{ revisionId: revisionOne }],
    });
    await expect(readAuthorizedWorkContextSopRevision(
      state.env,
      principals.pilot,
      "project",
      "project-1",
      "lidar-capture",
      revisionOne,
    )).resolves.toMatchObject({ revision_id: revisionOne, slug: "lidar-capture" });
    await expect(readAuthorizedWorkContextSopRevision(
      state.env,
      principals.unrelated,
      "project",
      "project-1",
      "lidar-capture",
      revisionOne,
    )).rejects.toMatchObject({ status: 404 });

    const taskBefore = await state.app.fetch(request(
      "/api/work-contexts/task/task-1/sops",
      "pilot",
    ), state.env);
    expect(taskBefore.status).toBe(200);
    expect(await taskBefore.json()).toMatchObject({ version: 0, sops: [] });

    const forbidden = await state.app.fetch(request("/api/work-contexts/task/task-1/sops", "pilot", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), state.env);
    expect(forbidden.status).toBe(403);

    const taskPut = await state.app.fetch(request("/api/work-contexts/task/task-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), state.env);
    expect(taskPut.status).toBe(200);
    const stale = await state.app.fetch(request("/api/work-contexts/task/task-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [] }),
    }), state.env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ currentVersion: 1 });
    expect(state.database.prepare("SELECT COUNT(*) count FROM audit_events").get()).toEqual({ count: 2 });
    expect(state.database.prepare("SELECT COUNT(*) count FROM work_context_sop_mutation_guards").get())
      .toEqual({ count: 0 });
    state.database.prepare(
      "DELETE FROM work_context_sop_links WHERE context_kind='project' AND context_id='project-1' AND revision_id=?",
    ).run(revisionOne);
    await expect(readAuthorizedWorkContextSopRevision(
      state.env,
      principals.pilot,
      "project",
      "project-1",
      "lidar-capture",
      revisionOne,
    )).rejects.toMatchObject({ status: 404 });
  });

  it("keeps existing pins on their immutable revision after republish and archive", async () => {
    const state = setup();
    expect((await state.app.fetch(request("/api/work-contexts/project/project-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), state.env)).status).toBe(200);
    state.database.prepare(`INSERT INTO sop_revisions
      (id,sop_id,revision_number,parent_revision_id,change_kind,title,purpose,markdown_body,rendered_html,toc_json,
        sanitizer_version,author_id,author_email,author_display_name,published_at)
      VALUES (?,'sop-lidar',2,?,'published','LiDAR capture v2','Updated capture guidance.',
        '# LiDAR v2','<h1>LiDAR v2</h1>','[]',1,'staff-admin','admin@example.test','Admin',datetime('now'))`)
      .run(revisionTwo, revisionOne);
    state.database.prepare("UPDATE sop_documents SET published_revision_id=?,version=2 WHERE id='sop-lidar'")
      .run(revisionTwo);

    const pinned = await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "pilot",
    ), state.env);
    expect(await pinned.json()).toMatchObject({
      sops: [{ revisionId: revisionOne, revisionNumber: 1, archived: false, publicationState: "superseded" }],
    });
    const preservedAfterRepublish = await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "admin",
      {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: 1, revisionIds: [revisionOne] }),
      },
    ), state.env);
    expect(preservedAfterRepublish.status).toBe(200);
    expect(await preservedAfterRepublish.json()).toMatchObject({
      version: 2,
      sops: [{ revisionId: revisionOne, publicationState: "superseded" }],
    });
    const oldOnTask = await state.app.fetch(request("/api/work-contexts/task/task-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), state.env);
    expect(oldOnTask.status).toBe(409);
    expect((await state.app.fetch(request("/api/work-contexts/task/task-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionTwo] }),
    }), state.env)).status).toBe(200);

    state.database.prepare("UPDATE sop_documents SET status='archived',archived_at=datetime('now') WHERE id='sop-lidar'").run();
    const retained = await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "pilot",
    ), state.env);
    expect(await retained.json()).toMatchObject({
      sops: [{ revisionId: revisionOne, archived: true, publicationState: "archived" }],
    });
    const preservedAfterArchive = await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "admin",
      {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: 2, revisionIds: [revisionOne] }),
      },
    ), state.env);
    expect(preservedAfterArchive.status).toBe(200);
    expect(await preservedAfterArchive.json()).toMatchObject({
      version: 3,
      sops: [{ revisionId: revisionOne, publicationState: "archived" }],
    });
    await expect(readAuthorizedWorkContextSopRevision(
      state.env,
      principals.pilot,
      "project",
      "project-1",
      "lidar-capture",
      revisionOne,
    )).resolves.toMatchObject({ status: "archived", revision_id: revisionOne });

    state.database.prepare(`UPDATE sop_documents
      SET status='draft',draft_revision_id=?,published_revision_id=NULL,archived_at=NULL
      WHERE id='sop-lidar'`).run(revisionTwo);
    const unpublished = await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "pilot",
    ), state.env);
    expect(await unpublished.json()).toMatchObject({
      sops: [{ revisionId: revisionOne, publicationState: "unpublished" }],
    });
  });

  it("denies a pinned revision when assignment or SOP access is revoked immediately before its authoritative read", async () => {
    const assignmentState = setup();
    expect((await assignmentState.app.fetch(request("/api/work-contexts/project/project-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), assignmentState.env)).status).toBe(200);
    assignmentState.env.OPS_DB.setBeforeStatement(() => {
      assignmentState.database.prepare("DELETE FROM pa_project_assignments WHERE user_id='pa-pilot'").run();
      assignmentState.database.prepare("DELETE FROM pa_task_assignments WHERE user_id='pa-pilot'").run();
    });
    await expect(readAuthorizedWorkContextSopRevision(
      assignmentState.env,
      principals.pilot,
      "project",
      "project-1",
      "lidar-capture",
      revisionOne,
    )).rejects.toMatchObject({ status: 404 });

    const aclState = setup();
    expect((await aclState.app.fetch(request("/api/work-contexts/task/task-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), aclState.env)).status).toBe(200);
    aclState.env.OPS_DB.setBeforeStatement(() => {
      aclState.database.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id)
        VALUES ('pilot-sops-deny','staff-pilot','sops.view','deny','global',NULL)`).run();
    });
    await expect(readAuthorizedWorkContextSopRevision(
      aclState.env,
      principals.pilot,
      "task",
      "task-1",
      "lidar-capture",
      revisionOne,
    )).rejects.toMatchObject({ status: 404 });
  });

  it("treats assignment or ACL revocation immediately before the replacement batch as denial", async () => {
    const aclState = setup();
    aclState.env.OPS_DB.setBeforeBatch(() => {
      aclState.database.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id)
        VALUES ('admin-assign-deny','staff-admin','sops.assign','deny','global',NULL)`).run();
    });
    const aclDenied = await aclState.app.fetch(request("/api/work-contexts/project/project-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), aclState.env);
    expect(aclDenied.status).toBe(403);
    expect(await aclDenied.json()).toMatchObject({
      error: "Your access to manage these quick SOP links changed. Refresh and try again.",
    });
    expect(aclState.database.prepare("SELECT COUNT(*) count FROM work_context_sop_link_sets").get())
      .toEqual({ count: 0 });
    expect(aclState.database.prepare("SELECT COUNT(*) count FROM audit_events").get())
      .toEqual({ count: 0 });

    const assignmentState = setup();
    assignmentState.env.OPS_DB.setBeforeBatch(() => {
      assignmentState.database.prepare(
        "UPDATE pa_projects SET manager_user_id='pa-other' WHERE id='project-1'",
      ).run();
    });
    const assignmentDenied = await assignmentState.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "admin",
      {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
      },
    ), assignmentState.env);
    expect(assignmentDenied.status).toBe(403);
    expect(assignmentState.database.prepare("SELECT COUNT(*) count FROM work_context_sop_links").get())
      .toEqual({ count: 0 });
    expect(assignmentState.database.prepare("SELECT COUNT(*) count FROM work_context_sop_mutation_guards").get())
      .toEqual({ count: 0 });
  });

  it("allows narrow SOP assignment without granting project, task, or SOP authoring permissions", async () => {
    const state = setup();
    state.database.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id)
      VALUES ('pilot-sops-assign','staff-pilot','sops.assign','allow','global',NULL)`).run();
    mocks.requirePermission.mockImplementation(async (
      _env: unknown,
      principal: { id: string },
      permission: string,
    ) => {
      if (["projects.view", "tasks.view", "sops.view"].includes(permission)) return;
      if (permission === "sops.assign" && new Set<string>([principals.admin.id, principals.pilot.id]).has(principal.id)) return;
      throw new HTTPException(403, { message: `Missing permission: ${permission}` });
    });
    mocks.evaluatePermission.mockImplementation((
      _grants: unknown,
      principal: { id: string },
      permission: string,
    ) => permission === "sops.view"
      ? principal.id !== principals.noSop.id
      : permission === "sops.assign" && new Set<string>([principals.admin.id, principals.pilot.id]).has(principal.id));

    const project = await state.app.fetch(request("/api/work-contexts/project/project-1/sops", "pilot", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), state.env);
    expect(project.status).toBe(200);
    expect(await project.json()).toMatchObject({ canEdit: true, version: 1 });

    const task = await state.app.fetch(request("/api/work-contexts/task/task-1/sops", "pilot", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), state.env);
    expect(task.status).toBe(200);
    expect(state.database.prepare(`SELECT permission_key FROM staff_permission_overrides
      WHERE staff_id='staff-pilot' AND permission_key IN ('operations.manage','tasks.update','sops.manage')`).all())
      .toEqual([]);
  });

  it("requires both work visibility and SOP permission and decorates lists with summaries only", async () => {
    const state = setup();
    expect((await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "unrelated",
    ), state.env)).status).toBe(404);
    expect((await state.app.fetch(request(
      "/api/work-contexts/project/project-1/sops",
      "noSop",
    ), state.env)).status).toBe(403);

    expect((await state.app.fetch(request("/api/work-contexts/project/project-1/sops", "admin", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, revisionIds: [revisionOne] }),
    }), state.env)).status).toBe(200);
    const adminRows = await decorateWorkContextsWithSops(
      state.env,
      principals.admin,
      "project",
      [{ id: "project-1", name: "North site" }],
    );
    expect(adminRows).toMatchObject([{
      id: "project-1",
      sopLinkVersion: 1,
      canManageSops: true,
      sopLinks: [{ revisionId: revisionOne, title: "LiDAR capture" }],
    }]);
    expect(JSON.stringify(adminRows)).not.toContain("<h1>");
    expect(JSON.stringify(adminRows)).not.toContain("markdown");

    const hidden = await decorateWorkContextsWithSops(
      state.env,
      principals.noSop,
      "project",
      [{ id: "project-1", name: "North site" }],
    );
    expect(hidden).toMatchObject([{
      sopLinkVersion: 0,
      canManageSops: false,
      sopLinks: [],
    }]);
  });
});
