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
}));

vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  requirePermission: mocks.requirePermission,
  sqlScope: mocks.sqlScope,
  hasLocalGlobalAllow: mocks.hasLocalGlobalAllow,
  loadGrants: mocks.loadGrants,
  evaluatePermission: mocks.evaluatePermission,
}));

import { registerTeamAssignedWorkRoutes } from "../src/worker/team-assigned-work";

type SqlValue = string | number | bigint | null | Uint8Array;

class D1Statement {
  values: unknown[] = [];
  constructor(readonly database: DatabaseSync, readonly sql: string) {}
  bind(...values: unknown[]) {
    const next = new D1Statement(this.database, this.sql);
    next.values = values;
    return next;
  }
  private statement(): StatementSync { return this.database.prepare(this.sql); }
  private bindings(): SqlValue[] {
    return this.values.map(value => value === undefined ? null : value as SqlValue);
  }
  async first<T>() { return (this.statement().get(...this.bindings()) as T | undefined) || null; }
  async all<T>() {
    return { results: this.statement().all(...this.bindings()) as T[], meta: { changes: 0 } };
  }
}

function d1(database: DatabaseSync) {
  const api = {
    prepare(sql: string) { return new D1Statement(database, sql); },
    withSession() { return api; },
  };
  return api;
}

const principals = {
  admin: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", accessSubject: "admin", projectAlphaUserId: "pa-admin" },
  viewer: { id: "staff-viewer", email: "viewer@example.test", displayName: "Viewer", accessSubject: "viewer", projectAlphaUserId: "pa-viewer" },
  noSop: { id: "staff-no-sop", email: "nosop@example.test", displayName: "No SOP", accessSubject: "no-sop", projectAlphaUserId: "pa-no-sop" },
  hidden: { id: "staff-hidden", email: "hidden@example.test", displayName: "Hidden", accessSubject: "hidden", projectAlphaUserId: "pa-hidden" },
} as const;

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,display_name TEXT,project_alpha_user_id TEXT UNIQUE);
    CREATE TABLE staff_divisions(staff_id TEXT NOT NULL,division_id TEXT NOT NULL);
    CREATE TABLE divisions(id TEXT PRIMARY KEY,project_alpha_business_unit_id TEXT UNIQUE);
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE pa_operations(
      id TEXT PRIMARY KEY,project_id TEXT,business_unit_id TEXT,title TEXT NOT NULL,status TEXT NOT NULL,
      scheduled_start_at TEXT,updated_at TEXT NOT NULL,active INTEGER NOT NULL
    );
    CREATE TABLE pa_operation_assignments(
      operation_id TEXT NOT NULL,user_id TEXT NOT NULL,active INTEGER NOT NULL,
      PRIMARY KEY(operation_id,user_id)
    );
    CREATE TABLE operational_job_briefs(operation_id TEXT PRIMARY KEY);
    CREATE TABLE operational_job_brief_sop_links(operation_id TEXT NOT NULL,revision_id TEXT NOT NULL);
    INSERT INTO divisions VALUES ('division-flight','unit-flight');
    INSERT INTO pa_projects VALUES ('project-1','North site');
    INSERT INTO pa_operations VALUES
      ('operation-1','project-1','unit-flight','North capture','scheduled','2026-08-15T15:00:00Z','2026-08-10T00:00:00Z',1),
      ('operation-2','project-1','unit-flight','South capture','ready',NULL,'2026-08-11T00:00:00Z',1);
    INSERT INTO pa_operation_assignments VALUES
      ('operation-1','pa-pilot',1),('operation-2','pa-pilot',1),
      ('operation-1','pa-viewer',1),('operation-1','pa-no-sop',1);
    INSERT INTO operational_job_briefs VALUES ('operation-1');
    INSERT INTO operational_job_brief_sop_links VALUES
      ('operation-1','revision-1'),('operation-1','revision-2'),('operation-2','revision-3');
  `);
  const staff = database.prepare("INSERT INTO staff_users VALUES (?,?,?,?)");
  for (const principal of Object.values(principals))
    staff.run(principal.id, principal.email, principal.displayName, principal.projectAlphaUserId);
  staff.run("staff-pilot", "pilot@example.test", "Pilot", "pa-pilot");
  for (const id of [...Object.values(principals).map(principal => principal.id), "staff-pilot"])
    database.prepare("INSERT INTO staff_divisions VALUES (?,'division-flight')").run(id);

  const env = { OPS_DB: d1(database) } as any;
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    const key = c.req.header("X-Test-User") as keyof typeof principals | null;
    if (!key || !principals[key]) throw new HTTPException(401, { message: "Authentication required" });
    c.set("principal", principals[key]);
    c.set("administrator", key === "admin");
    await next();
  });
  app.onError((error, c) => error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: "Internal error" }, 500));
  registerTeamAssignedWorkRoutes(app);
  return { app, env, database };
}

function request(user: keyof typeof principals) {
  return new Request("https://ops.example/api/team/staff/staff-pilot/assigned-work", {
    headers: { "X-Test-User": user },
  });
}

describe("Team assigned work", () => {
  beforeEach(() => {
    mocks.requirePermission.mockReset().mockImplementation(async (
      _env: unknown,
      principal: { id: string },
      permission: string,
    ) => {
      if (principal.id !== principals.hidden.id && ["team.view", "operations.view"].includes(permission)) return;
      throw new HTTPException(403, { message: `Missing permission: ${permission}` });
    });
    mocks.sqlScope.mockReset().mockImplementation(async (
      _env: unknown,
      _principal: unknown,
      permission: string,
    ) => permission === "team.view"
      ? { global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false }
      : { global: false, divisions: [], assigned: true, own: false, deniedDivisions: [], deniedGlobal: false });
    mocks.hasLocalGlobalAllow.mockReset().mockResolvedValue(false);
    mocks.loadGrants.mockReset().mockResolvedValue([]);
    mocks.evaluatePermission.mockReset().mockImplementation((
      _grants: unknown,
      principal: { id: string },
      permission: string,
    ) => permission === "sops.view" && principal.id !== principals.noSop.id);
  });

  it("shows an administrator all active assignments and safe SOP counts", async () => {
    const state = setup();
    const response = await state.app.fetch(request("admin"), state.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      staff: { id: "staff-pilot", displayName: "Pilot" },
      truncated: false,
      operations: [
        { id: "operation-1", projectName: "North site", briefAvailable: true, canViewSops: true, sopCount: 2 },
        { id: "operation-2", briefAvailable: false, canViewSops: true, sopCount: 1 },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("pa-pilot");
    expect(JSON.stringify(body)).not.toContain("assigned_staff_ids");
  });

  it("intersects the target's assignments with the caller's assigned-operation visibility", async () => {
    const state = setup();
    const response = await state.app.fetch(request("viewer"), state.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ operations: [{ id: "operation-1" }] });
    expect(body.operations).toHaveLength(1);

    state.database.prepare("DELETE FROM pa_operation_assignments WHERE user_id='pa-viewer'").run();
    state.database.prepare("INSERT INTO pa_operation_assignments VALUES ('operation-2','pa-viewer',1)").run();
    const reassigned = await state.app.fetch(request("viewer"), state.env);
    expect(await reassigned.json()).toMatchObject({ operations: [{ id: "operation-2" }] });
  });

  it("does not disclose SOP counts without scoped sops.view and explicitly denies Team access", async () => {
    const state = setup();
    const noSop = await state.app.fetch(request("noSop"), state.env);
    expect(noSop.status).toBe(200);
    expect(await noSop.json()).toMatchObject({
      operations: [{ id: "operation-1", canViewSops: false, sopCount: 0 }],
    });
    const denied = await state.app.fetch(request("hidden"), state.env);
    expect(denied.status).toBe(403);
  });
});
