import { afterEach, describe, expect, it, vi } from "vitest";
import { syncProjectAlpha } from "../src/worker/project-alpha";
import type { Env } from "../src/worker/types";

class Statement {
  values: unknown[] = [];
  constructor(readonly sql: string) {}
  bind(...values: unknown[]): this { this.values = values; return this; }
  async run(): Promise<object> { return {}; }
}

class Database {
  batches: Statement[][] = [];
  prepare(sql: string): Statement { return new Statement(sql); }
  async batch(statements: Statement[]): Promise<object[]> { this.batches.push(statements); return statements.map(() => ({})); }
  allSql(): string { return this.batches.flat().map((statement) => statement.sql).join("\n"); }
}

const collectionNames = ["users","business_units","worker_business_units","clients","organizations","projects","project_assignments","service_locations","application_entitlements","operations","operation_assignments","tasks","calendar_events"] as const;
function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { generated_at: "2026-07-17T12:00:00Z", ...Object.fromEntries(collectionNames.map((name) => [name, []])), has_more: false, next_page: null, ...overrides };
}

function environment(db: Database): Env {
  return { OPS_DB: db as unknown as D1Database, PROJECT_ALPHA_BASE_URL: "https://pa.example.test", PROJECT_ALPHA_API_KEY: "secret" } as Env;
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

  it("projects PA-owned records and reconciles roles only within explicit business-unit scope", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page({
      users: [{ id: 7, email: "Pilot@Example.com", display_name: "Pilot" }],
      business_units: [{ id: 30, name: "Flight", code: "flight", is_active: true }],
      application_entitlements: [{ id: 9, user_id: 7, application_key: "ltds_ops", enabled: true, role_key: "role-operator", business_unit_ids: [30] }],
      operations: [{ id: 100, project_id: 50, business_unit_id: 30, title: "Survey", status: "scheduled" }],
      operation_assignments: [{ operation_id: 100, user_id: 7 }],
      tasks: [{ id: 110, project_id: 50, business_unit_id: 30, title: "Fly", status: "todo" }],
      calendar_events: [{ source_type: "operation", source_id: 100, title: "Survey", start_at: "2026-07-18T12:00:00Z", business_unit_id: 30 }],
    })))));

    const result = await syncProjectAlpha(environment(db));
    const sql = db.allSql();
    expect(result.status).toBe("success");
    expect(sql).toContain("INSERT INTO pa_application_entitlements");
    expect(sql).toContain("INSERT INTO pa_operations");
    expect(sql).toContain("INSERT INTO pa_tasks");
    expect(sql).toContain("INSERT INTO pa_calendar_events");
    expect(sql).toContain("project_alpha_business_unit_id");
    expect(sql).toContain("s.sync_protected=0");
    expect(sql).toContain("INSERT OR IGNORE INTO staff_role_assignments");
  });

  it("fails closed by creating no role assignment for an enabled entitlement with empty scope", async () => {
    const db = new Database();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page({
      application_entitlements: [{ id: 9, user_id: 7, application_key: "ltds_ops", enabled: true, role_key: "role-operator", business_unit_ids: [] }],
    })))));

    await syncProjectAlpha(environment(db));
    expect(db.allSql()).not.toContain("INSERT OR IGNORE INTO staff_role_assignments");
    expect(db.allSql()).toContain("DELETE FROM staff_role_assignments");
  });
});
