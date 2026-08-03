import { afterEach, describe, expect, it, vi } from "vitest";
import { syncProjectAlpha } from "../src/worker/project-alpha";
import type { Env } from "../src/worker/types";

class Statement {
  values: unknown[] = [];
  constructor(readonly sql: string, private readonly database: Database) {}
  bind(...values: unknown[]): this { this.values = values; return this; }
  async run(): Promise<object> { return {}; }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: (this.sql.includes("FROM pa_projection_fingerprints") ? this.database.fingerprints : []) as T[] };
  }
}

class Database {
  batches: Statement[][] = [];
  fingerprints: Array<{ collection: string; fingerprint: string }> = [];
  prepare(sql: string): Statement { return new Statement(sql, this); }
  async batch(statements: Statement[]): Promise<object[]> { this.batches.push(statements); return statements.map(() => ({})); }
  allSql(): string { return this.batches.flat().map((statement) => statement.sql).join("\n"); }
  rememberFingerprints(): void {
    this.fingerprints = this.batches.flat()
      .filter((statement) => statement.sql.includes("INSERT INTO pa_projection_fingerprints"))
      .map((statement) => ({ collection: String(statement.values[0]), fingerprint: String(statement.values[1]) }));
  }
}

const collectionNames = ["users","business_units","worker_business_units","clients","organizations","projects","project_assignments","service_locations","application_entitlements","operations","operation_assignments","tasks","task_assignments","calendar_events"] as const;
function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { generated_at: "2026-07-17T12:00:00Z", ...Object.fromEntries(collectionNames.map((name) => [name, []])), has_more: false, next_page: null, ...overrides };
}

function environment(db: Database, deliveryDb: Database = new Database()): Env {
  return { OPS_DB: db as unknown as D1Database, DELIVERY_DB: deliveryDb as unknown as D1Database, PROJECT_ALPHA_BASE_URL: "https://pa.example.test", PROJECT_ALPHA_API_KEY: "secret", APPLICATION_KEY: "external_operations" } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

describe("Project Alpha snapshot synchronization", () => {
  it("does not touch projections when a later snapshot page fails", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page({ has_more: true, next_page: 2, users: [{ id: 7, email: "pilot@example.com" }] }))))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 })));

    await expect(syncProjectAlpha(environment(db))).rejects.toThrow("project-alpha-http-503");
    expect(db.allSql()).not.toContain("INSERT INTO pa_users");
    expect(db.allSql()).toContain("status='failed'");
  });

  it("fails closed before fetching or committing fingerprints when DELIVERY_DB is missing", async () => {
    const db = new Database();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const missingDelivery = { ...environment(db), DELIVERY_DB: undefined } as unknown as Env;

    await expect(syncProjectAlpha(missingDelivery)).rejects.toThrow("delivery-db-binding-required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.allSql()).not.toContain("INSERT INTO pa_projection_fingerprints");
    expect(db.allSql()).toContain("status='failed'");
  });

  it("projects PA-owned records and ignores legacy business-unit entitlement scopes", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page({
      users: [{ id: 7, email: "Pilot@Example.com", display_name: "Pilot" }],
      business_units: [{ id: 30, name: "Flight", code: "flight", is_active: true }],
      projects: [{ id: 50, name: "School survey", business_unit_id: 30, manager_user_id: 7 }],
      application_entitlements: [{ id: 9, user_id: 7, application_key: "external_operations", enabled: true, role_key: "role-operator", oversight_business_unit_ids: [30] }],
      operations: [{ id: 100, project_id: 50, business_unit_id: 30, title: "Survey", status: "scheduled" }],
      operation_assignments: [{ operation_id: 100, user_id: 7 }],
      tasks: [{ id: 110, project_id: 50, business_unit_id: 30, title: "Fly", status: "todo" }],
      task_assignments: [{ task_id: 110, user_id: 7 }],
      calendar_events: [{ source_type: "operation", source_id: 100, title: "Survey", start_at: "2026-07-18T12:00:00Z", business_unit_id: 30 }],
    })))));

    const result = await syncProjectAlpha(environment(db));
    const sql = db.allSql();
    expect(result.status).toBe("success");
    expect(sql).toContain("INSERT INTO pa_application_entitlements");
    expect(sql).toContain("manager_user_id");
    expect(sql).toContain("INSERT INTO pa_operations");
    expect(sql).toContain("INSERT INTO pa_tasks");
    expect(sql).toContain("INSERT INTO pa_task_assignments");
    expect(sql).toContain("INSERT INTO pa_calendar_events");
    expect(sql).toContain("project_alpha_business_unit_id");
    expect(sql).toContain("s.sync_protected=0");
    expect(sql).toContain("INSERT OR IGNORE INTO staff_role_assignments");
    expect(sql).toContain("SET status=CASE WHEN project_alpha_user_id IN");
    expect(sql).not.toContain("INSERT OR IGNORE INTO staff_divisions");
  });

  it("keeps ended Project Team memberships inactive during snapshot recovery", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page({
      project_assignments: [{ id: 12, project_id: 50, user_id: 7, ends_at: "2000-01-01T00:00:00.000000Z" }],
    })))));

    await syncProjectAlpha(environment(db));
    const assignment = db.batches.flat().find((statement) => statement.sql.includes("INSERT INTO pa_project_assignments"));
    expect(assignment?.values[3]).toBe(0);
    expect(assignment?.sql).toContain("active=excluded.active");
  });

  it("rejects an invalid application key before requesting a snapshot", async () => {
    const db = new Database();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalid = { ...environment(db), APPLICATION_KEY: "not valid" };

    await expect(syncProjectAlpha(invalid)).rejects.toThrow("project-alpha-application-key-invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires HTTPS for a non-local Project Alpha origin", async () => {
    const db = new Database();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const insecure = { ...environment(db), PROJECT_ALPHA_BASE_URL: "http://pa.example.test" };

    await expect(syncProjectAlpha(insecure)).rejects.toThrow("project-alpha-base-url-invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an empty-scope employee authenticated without granting a business-unit scope", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page({
      application_entitlements: [{ id: 9, user_id: 7, application_key: "external_operations", enabled: true, role_key: "role-operator", oversight_business_unit_ids: [] }],
    })))));

    await syncProjectAlpha(environment(db));
    expect(db.allSql()).toContain("'role-operator','assigned'");
    expect(db.allSql()).not.toContain("INSERT OR IGNORE INTO staff_divisions");
  });

  it("does not provision a role for a disabled entitlement", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page({
      users: [{ id: 7, email: "pilot@example.com", display_name: "Pilot", active: true }],
      application_entitlements: [{ id: 9, user_id: 7, application_key: "external_operations", enabled: false, role_key: "role-admin" }],
    })))));

    await syncProjectAlpha(environment(db));
    const roleInserts = db.batches.flat().filter((statement) => statement.sql.includes("INSERT OR IGNORE INTO staff_role_assignments"));
    expect(roleInserts).toHaveLength(0);
    expect(db.allSql()).toContain("e.active=1 AND e.enabled=1 AND u.active=1");
  });

  it("maps a PA administrator to the immutable global administrator role", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page({
      application_entitlements: [{ id: 9, user_id: 7, application_key: "external_operations", enabled: true, role_key: "role-admin", oversight_business_unit_ids: [] }],
    })))));

    await syncProjectAlpha(environment(db));
    expect(db.allSql()).toContain("'role-admin','global'");
    expect(db.allSql()).not.toContain("INSERT OR IGNORE INTO staff_divisions");
  });

  it("does not rewrite unchanged snapshot collections", async () => {
    const db = new Database();
    const snapshot = page({
      users: [{ id: 7, email: "pilot@example.com", display_name: "Pilot" }],
      operations: [{ id: 100, project_id: 50, title: "Survey", status: "scheduled" }],
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(snapshot)))));

    await syncProjectAlpha(environment(db));
    db.rememberFingerprints();
    db.batches = [];

    await syncProjectAlpha(environment(db));
    const sql = db.allSql();
    expect(sql).not.toContain("INSERT INTO pa_users");
    expect(sql).not.toContain("INSERT INTO pa_operations");
    expect(sql).not.toContain("DELETE FROM staff_role_assignments");
    expect(sql).not.toContain("INSERT INTO pa_projection_fingerprints");
    expect(sql).toContain("status='success'");
  });

  it("reconciles only the collection whose snapshot content changed", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page({
      users: [{ id: 7, email: "pilot@example.com" }],
      operations: [{ id: 100, project_id: 50, title: "Survey", status: "scheduled" }],
    })))).mockResolvedValueOnce(new Response(JSON.stringify(page({
      users: [{ id: 7, email: "pilot@example.com" }],
      operations: [],
    })))));

    await syncProjectAlpha(environment(db));
    db.rememberFingerprints();
    db.batches = [];

    await syncProjectAlpha(environment(db));
    const sql = db.allSql();
    expect(sql).toContain("UPDATE pa_operations SET active=0");
    expect(sql).not.toContain("UPDATE pa_users SET active=0");
    expect(sql).not.toContain("INSERT INTO pa_users");
  });

  it("reconciles portal account, project, and folder access against current PA ownership", async () => {
    const db = new Database(), deliveryDb = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page({
      clients: [
        { id: 70, name: "Prior client", organization_id: 80, active: false },
        { id: 71, name: "Current client", organization_id: 81, active: true },
      ],
      organizations: [
        { id: 80, name: "Prior organization", active: false },
        { id: 81, name: "Current organization", active: true },
      ],
      projects: [
        { id: 50, name: "Remapped project", client_id: 71, organization_id: 81, active: true },
        { id: 51, name: "Inactive project", client_id: 70, organization_id: 80, active: false },
      ],
    })))));

    await syncProjectAlpha(environment(db, deliveryDb));
    const sql = deliveryDb.allSql();
    expect(sql).toContain("project_alpha_organization_id=?,status=?");
    expect(sql).toContain("project_alpha_project_id NOT IN");
    expect(sql).toContain("UPDATE client_folder_associations SET revoked_at");
    expect(sql).toContain("UPDATE client_project_grants SET revoked_at");
    const remap = deliveryDb.batches.flat().find(statement => statement.sql.includes("UPDATE client_project_grants SET revoked_at") && statement.values.includes("50"));
    expect(remap?.values).toEqual(expect.arrayContaining(["50", 1, "71", "81"]));
    const inactive = deliveryDb.batches.flat().find(statement => statement.sql.includes("UPDATE client_project_grants SET revoked_at") && statement.values.includes("51"));
    expect(inactive?.values).toEqual(expect.arrayContaining(["51", 0]));
  });
});
