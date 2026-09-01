import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { syncProjectAlpha, syncProjectAlphaForSource } from "../src/worker/project-alpha";
import { createProjectAlphaSourceContext, PRIMARY_PROJECT_ALPHA_SOURCE } from "../src/worker/project-alpha-source";
import { paProjectFilter, paResourceFilter, paCalendarFilter } from "../src/worker/visibility";
import type { Env, StaffPrincipal } from "../src/worker/types";

const collections = ["users", "business_units", "worker_business_units", "clients", "organizations", "projects", "project_assignments",
  "service_locations", "application_entitlements", "operations", "operation_assignments", "tasks", "task_assignments", "calendar_events"];
const other = createProjectAlphaSourceContext("project-alpha:secondary");
const connection = (secondary = false) => ({ baseUrl: secondary ? "https://secondary.example.test" : "https://primary.example.test",
  apiKey: secondary ? "secondary-secret" : "primary-secret", applicationKey: "external_operations" });
const at = "2026-08-26T00:00:00Z";
function snapshot(label: string, populated = true) {
  const payload: Record<string, unknown> = { generated_at: at, has_more: false, next_page: null,
    ...Object.fromEntries(collections.map(name => [name, []])) };
  if (populated) Object.assign(payload, {
    users: [{ id: 1, email: "shared@example.test", display_name: `${label} user`, active: true }],
    business_units: [{ id: 2, name: `${label} unit`, code: "shared" }],
    worker_business_units: [{ user_id: 1, business_unit_id: 2 }],
    organizations: [{ id: 3, name: `${label} organization`, public_id: "a".repeat(32) }],
    clients: [{ id: 4, organization_id: 3, name: `${label} client`, public_id: "b".repeat(32) }],
    projects: [{ id: 5, name: `${label} project`, client_id: 4, organization_id: 3, business_unit_id: 2, manager_user_id: 1, status: "active" }],
    project_assignments: [{ id: 6, project_id: 5, user_id: 1 }],
    service_locations: [{ id: 7, project_id: 5, client_id: 4, organization_id: 3, latitude: 44, longitude: -88 }],
    application_entitlements: [{ id: 8, user_id: 1, application_key: "external_operations", role_key: "role-admin", enabled: true }],
    operations: [{ id: 9, project_id: 5, business_unit_id: 2, title: `${label} operation`, status: "scheduled", created_by: 1 }],
    operation_assignments: [{ operation_id: 9, user_id: 1, assigned_by: 1 }],
    tasks: [{ id: 10, operation_id: 9, project_id: 5, business_unit_id: 2, assignee_user_id: 1, title: `${label} task`, status: "todo", created_by: 1 }],
    task_assignments: [{ task_id: 10, user_id: 1, assigned_by: 1 }],
    calendar_events: [{ source_type: "operation", source_id: 9, project_id: 5, business_unit_id: 2, title: `${label} visit`, start_at: at }],
  });
  return payload;
}

async function databaseFixture() {
  const runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB", "DELIVERY_DB"] });
  const ops = await runtime.getD1Database("OPS_DB") as D1Database;
  const delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
  try {
    for (const [db, path] of [[ops, "../migrations"], [delivery, "../../client/migrations"]] as const) {
      const directory = resolve(import.meta.dirname, path);
      for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
        const statements = splitD1MigrationStatements(await readFile(resolve(directory, name), "utf8"));
        if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
      }
    }
    const env = { OPS_DB: ops, DELIVERY_DB: delivery, PROJECT_ALPHA_BASE_URL: connection().baseUrl,
      PROJECT_ALPHA_API_KEY: connection().apiKey, APPLICATION_KEY: connection().applicationKey } as Env;
    return { runtime, ops, delivery, env };
  } catch (error) { await runtime.dispose(); throw error; }
}
afterEach(() => vi.unstubAllGlobals());

describe("source-isolated business snapshots", () => {
  it("captures first-load dated client/org/project observations after owner projection and does not turn replay clocks into activity", async () => {
    const { runtime, ops, env } = await databaseFixture();
    try {
      const payload = snapshot("Dated");
      for (const [collection, updatedAt] of [
        ["organizations", "2026-01-01 01:02:03"],
        ["clients", "2026-01-02 01:02:03"],
        ["projects", "2026-01-03 01:02:03"],
      ] as const) {
        for (const row of payload[collection] as Array<Record<string, unknown>>) row.updated_at = updatedAt;
      }
      expect(await ops.prepare("SELECT count(*) n FROM pa_organizations").first("n")).toBe(0);
      expect(await ops.prepare("SELECT count(*) n FROM pa_clients").first("n")).toBe(0);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
      // The real writer projects clients before organizations. The client
      // observation therefore requires the post-all-rows owner-resolution hook.
      await syncProjectAlpha(env);
      const before = (await ops.prepare("SELECT * FROM client_business_activity ORDER BY record_kind").all()).results;
      expect(before).toHaveLength(3);
      expect(before).toMatchObject([
        { projection_source_id: PRIMARY_PROJECT_ALPHA_SOURCE.sourceId, record_kind: "client", record_id: "4",
          root_kind: "organization", root_id: "3", origin: "source_observation", action: "source_record_updated",
          occurred_at: "2026-01-02T01:02:03.000Z", source_updated_at: "2026-01-02T01:02:03.000Z" },
        { projection_source_id: PRIMARY_PROJECT_ALPHA_SOURCE.sourceId, record_kind: "organization", record_id: "3",
          root_kind: "organization", root_id: "3", origin: "source_observation", action: "source_record_updated",
          occurred_at: "2026-01-01T01:02:03.000Z", source_updated_at: "2026-01-01T01:02:03.000Z" },
        { projection_source_id: PRIMARY_PROJECT_ALPHA_SOURCE.sourceId, record_kind: "project", record_id: "5",
          root_kind: "organization", root_id: "3", origin: "source_observation", action: "source_record_updated",
          occurred_at: "2026-01-03T01:02:03.000Z", source_updated_at: "2026-01-03T01:02:03.000Z" },
      ]);
      payload.generated_at = "2026-08-27T00:00:00Z";
      await syncProjectAlpha(env);
      expect((await ops.prepare("SELECT * FROM client_business_activity ORDER BY record_kind").all()).results).toEqual(before);
      expect(await ops.prepare("SELECT count(*) n FROM client_business_activity WHERE record_kind NOT IN ('client','organization','project') OR occurred_at>=?")
        .bind(at).first("n")).toBe(0);
    } finally { await runtime.dispose(); }
  }, 60_000);

  it("preserves primary IDs and all typed relationships while secondary IDs, payloads, health and fingerprints stay independent", async () => {
    const { runtime, ops, delivery, env } = await databaseFixture();
    try {
      const payloads = { primary: snapshot("Primary"), secondary: snapshot("Secondary") };
      // Exercise reconciliation beyond the bind-parameter budget as well as
      // two producers using identical business IDs.
      (payloads.primary.clients as unknown[]).push(...Array.from({ length: 120 }, (_, i) => ({ id: 100 + i, name: `Primary client ${i}` })));
      const requests: Array<{ host: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
      vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
        requests.push({ host: url.hostname, authorization: new Headers(init.headers).get("Authorization"), redirect: init.redirect });
        return Response.json(url.hostname.startsWith("secondary") ? payloads.secondary : payloads.primary);
      }));
      await syncProjectAlpha(env);
      const staffBefore = await ops.prepare("SELECT * FROM staff_users ORDER BY id").all();
      const rolesBefore = await ops.prepare("SELECT * FROM staff_role_assignments ORDER BY id").all();
      const divisionsBefore = await ops.prepare("SELECT * FROM divisions ORDER BY id").all();
      const deliveryBefore = await delivery.prepare("SELECT * FROM client_accounts ORDER BY id").all();
      const primaryFingerprints = await ops.prepare("SELECT * FROM pa_projection_fingerprints WHERE projection_source_id=? ORDER BY collection").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).all();
      // A forged boolean cannot elevate a secondary server context.
      await syncProjectAlphaForSource({ ...env, DELIVERY_DB: undefined } as unknown as Env,
        { ...other, staffAuthority: true }, connection(true));
      expect((await ops.prepare("SELECT * FROM staff_users ORDER BY id").all()).results).toEqual(staffBefore.results);
      expect((await ops.prepare("SELECT * FROM staff_role_assignments ORDER BY id").all()).results).toEqual(rolesBefore.results);
      expect((await ops.prepare("SELECT * FROM divisions ORDER BY id").all()).results).toEqual(divisionsBefore.results);
      expect((await delivery.prepare("SELECT * FROM client_accounts ORDER BY id").all()).results).toEqual(deliveryBefore.results);
      expect((await ops.prepare("SELECT * FROM pa_projection_fingerprints WHERE projection_source_id=? ORDER BY collection").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).all()).results).toEqual(primaryFingerprints.results);
      expect(await ops.prepare("SELECT count(*) n FROM pa_application_entitlements WHERE projection_source_id=?").bind(other.sourceId).first("n")).toBe(0);
      const projects = (await ops.prepare("SELECT * FROM pa_projects ORDER BY projection_source_id").all<{ id: string; client_id: string; organization_id: string; manager_user_id: string; payload_json: string; projection_source_id: string }>()).results;
      expect(projects).toHaveLength(2);
      expect(projects[0]!.id).toBe("5");
      expect(projects[1]!.id).toMatch(/^pa-local-/);
      expect(JSON.parse(projects[1]!.payload_json)).toMatchObject({ id: 5, client_id: 4, organization_id: 3, manager_user_id: 1 });
      for (const [field, table] of [["client_id", "pa_clients"], ["organization_id", "pa_organizations"], ["manager_user_id", "pa_users"]] as const) {
        expect(await ops.prepare(`SELECT projection_source_id FROM ${table} WHERE id=?`).bind(projects[1]![field]).first("projection_source_id")).toBe(other.sourceId);
      }
      const calendar = await ops.prepare("SELECT e.id,e.source_id,e.payload_json,o.projection_source_id FROM pa_calendar_events e JOIN pa_operations o ON o.id=e.source_id WHERE e.projection_source_id=?").bind(other.sourceId).first<{ id: string; source_id: string; projection_source_id: string; payload_json: string }>();
      expect(calendar).toMatchObject({ projection_source_id: other.sourceId });
      expect(calendar!.id).toMatch(/^pa-local-/);
      expect(JSON.parse(calendar!.payload_json).source_id).toBe(9);
      expect(await ops.prepare("SELECT id FROM pa_calendar_events WHERE projection_source_id=?").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).first("id")).toBe("operation:9");
      expect(requests.filter(r => r.host.startsWith("secondary")).every(r => r.authorization === "Bearer secondary-secret")).toBe(true);
      expect(requests.every(r => r.redirect === "manual")).toBe(true);
      const principal = { id: "staff-pa-1", projectAlphaUserId: "1" } as StaffPrincipal;
      const scope = { deniedGlobal: false, global: false, divisions: [], deniedDivisions: [], assigned: true, own: false };
      for (const [table, filter, expectedId] of [
        ["pa_projects", paProjectFilter(scope, principal, false), "5"],
        ["pa_tasks", paResourceFilter(scope, principal, false, "p", "task"), "10"],
        ["pa_calendar_events", paCalendarFilter(scope, principal, false, "p"), "operation:9"],
      ] as const) {
        expect(filter.sql).toContain("p.projection_source_id='project-alpha:primary'");
        expect((await ops.prepare(`SELECT p.id FROM ${table} p WHERE ${filter.sql}`).bind(...filter.values).all()).results)
          .toEqual([{ id: expectedId }]);
      }
      const stableBId = projects[1]!.id;
      await syncProjectAlphaForSource(env, other, connection(true));
      expect(await ops.prepare("SELECT id FROM pa_projects WHERE projection_source_id=?").bind(other.sourceId).first("id")).toBe(stableBId);
      payloads.primary = snapshot("Primary", false);
      await syncProjectAlpha(env);
      expect(await ops.prepare("SELECT active FROM pa_projects WHERE id='5'").first("active")).toBe(0);
      expect(await ops.prepare("SELECT active FROM pa_projects WHERE id=?").bind(stableBId).first("active")).toBe(1);
      expect(await ops.prepare("SELECT count(*) n FROM integration_health WHERE integration='project-alpha' AND status='healthy'").first("n")).toBe(2);

      expect((await ops.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await runtime.dispose(); }
  }, 90_000);

  it("an incomplete secondary snapshot leaves primary records, health and its lease untouched", async () => {
    const { runtime, ops, env } = await databaseFixture();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot("Primary"))));
      await syncProjectAlpha(env);
      const before = (await ops.prepare("SELECT * FROM pa_projects").all()).results;
      await ops.prepare("INSERT INTO pa_projection_entity_leases(projection_source_id,entity_type,entity_id,owner_event_id,lease_until) VALUES(?,'integration_projection','project-alpha','primary-running',datetime('now','+1 hour'))").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).run();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
      await expect(syncProjectAlphaForSource(env, other, connection(true))).rejects.toThrow("project-alpha-http-503");
      expect((await ops.prepare("SELECT * FROM pa_projects").all()).results).toEqual(before);
      expect(await ops.prepare("SELECT status FROM integration_health WHERE integration='project-alpha' AND projection_source_id=?").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).first("status")).toBe("healthy");
      expect(await ops.prepare("SELECT status FROM integration_health WHERE integration='project-alpha' AND projection_source_id=?").bind(other.sourceId).first("status")).toBe("error");
      expect(await ops.prepare("SELECT owner_event_id FROM pa_projection_entity_leases WHERE projection_source_id=?").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).first("owner_event_id")).toBe("primary-running");
      expect(await ops.prepare("SELECT count(*) n FROM pa_projection_entity_leases WHERE projection_source_id=?").bind(other.sourceId).first("n")).toBe(0);
    } finally { await runtime.dispose(); }
  }, 60_000);
});
