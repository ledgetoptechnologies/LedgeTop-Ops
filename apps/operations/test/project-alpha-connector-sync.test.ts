import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { registerProjectAlphaConnector, resolveProjectAlphaConnector, reviseProjectAlphaConnector, setProjectAlphaConnectorState,
  type ProjectAlphaConnectorEnvironment, type ProjectAlphaConnectorRevisionInput } from "../src/worker/project-alpha-connectors";
import { syncRegisteredProjectAlpha } from "../src/worker/project-alpha";
import type { Env } from "../src/worker/types";

const primary = "project-alpha:primary";
const at = "2026-08-26T00:00:00Z";
const collections = ["users", "business_units", "worker_business_units", "clients", "organizations", "projects", "project_assignments",
  "service_locations", "application_entitlements", "operations", "operation_assignments", "tasks", "task_assignments", "calendar_events"];
const preservedOpsTables = ["staff_users", "staff_role_assignments", "staff_divisions", "divisions", "pa_application_entitlements"];
const preservedDeliveryTables = ["client_accounts", "client_identity_links", "client_account_members", "projects", "client_project_grants",
  "client_service_requests", "request_revisions", "portal_v2_workspaces", "portal_v2_entitlements"];
function page(label: string, index: number) {
  const value: Record<string, unknown> = { generated_at: at, has_more: index === 1, next_page: index === 1 ? 2 : null,
    ...Object.fromEntries(collections.map(name => [name, []])) };
  if (index === 1) Object.assign(value, {
    users: [{ id: 1, email: "existing-staff@example.test", display_name: `${label} user`, active: true }],
    business_units: [{ id: 2, name: `${label} unit`, code: "existing" }],
    worker_business_units: [{ user_id: 1, business_unit_id: 2 }],
    organizations: [{ id: 3, name: `${label} organization`, public_id: "a".repeat(32) }],
    clients: [{ id: 4, name: `${label} contact`, organization_id: 3, public_id: "b".repeat(32) }],
    application_entitlements: [{ id: 8, user_id: 1, application_key: "ltds_ops", role_key: "role-admin", enabled: true }],
  });
  else Object.assign(value, {
    projects: [{ id: 5, name: `${label} project`, client_id: 4, organization_id: 3, business_unit_id: 2, manager_user_id: 1, status: "active" }],
    project_assignments: [{ id: 6, project_id: 5, user_id: 1 }],
    service_locations: [{ id: 7, project_id: 5, client_id: 4, organization_id: 3, latitude: 44, longitude: -88 }],
    operations: [{ id: 9, project_id: 5, business_unit_id: 2, title: `${label} operation`, status: "scheduled", created_by: 1 }],
    operation_assignments: [{ operation_id: 9, user_id: 1, assigned_by: 1 }],
    tasks: [{ id: 10, operation_id: 9, project_id: 5, business_unit_id: 2, title: `${label} task`, status: "todo", created_by: 1 }],
    task_assignments: [{ task_id: 10, user_id: 1, assigned_by: 1 }],
    calendar_events: [{ source_type: "operation", source_id: 9, project_id: 5, business_unit_id: 2, title: `${label} visit`, start_at: at }],
  });
  return value;
}
const publicKey = (seed: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const credential = (seed: number) => ({ snapshotApiKey: `private-snapshot-credential-${seed}`,
  eventCurrent: { keyId: "current", algorithm: "ed25519" as const, value: publicKey(seed) } });
const revision = (ref: string): ProjectAlphaConnectorRevisionInput => ({ credentialRef: ref, snapshotBasePath: "/tenant-alpha",
  accessIssuer: "https://access.example.test", accessAudience: "event-audience", accessSubject: "event-service-token" });

/** Inject the administrative change immediately before the actual first data
 * projection batch, not during fetch or an earlier JavaScript proof lookup. */
function beforeProjectionBatch(database: D1Database, action: () => Promise<void>): { db: D1Database; fired: () => boolean } {
  const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
  const rawStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let called = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    sqlByStatement.set(wrapped, sql); rawStatements.set(wrapped, statement); return wrapped;
  };
  const proxy: D1Database = new Proxy(database, { get(target, key) {
    if (key === "withSession") return () => proxy;
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (key === "batch") return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (!called && statements.some(statement => /INSERT\s+INTO\s+pa_users\b/i.test(sqlByStatement.get(statement) ?? ""))) {
        called = true; await action();
      }
      return target.batch<T>(statements.map(statement => rawStatements.get(statement) ?? statement));
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { db: proxy, fired: () => called };
}

let runtime: Miniflare;
let ops: D1Database;
let delivery: D1Database;
let env: Env & ProjectAlphaConnectorEnvironment;
let nextSeed = 20;
const sets: Record<string, ReturnType<typeof credential>> = { primary: credential(1) };
async function snapshotRows(database: D1Database, tables: string[]) {
  const snapshot: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) snapshot[table] = (await database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>()).results;
  return snapshot;
}
function refreshCredentials() { env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS = JSON.stringify({ version: 1, sets }); }
async function secondary(name: string) {
  sets[name] = credential(++nextSeed); refreshCredentials();
  const sourceId = `project-alpha:${name}`, origin = `https://${name}.example.test`;
  await registerProjectAlphaConnector(env, { sourceId, producerBindingId: `producer-${name}`, snapshotOrigin: origin,
    applicationKey: "ltds_ops", profile: "business_data", displayName: name, revision: revision(name) }, "fixture-admin");
  await setProjectAlphaConnectorState(env, sourceId, { expectedVersion: 1, state: "active" }, "fixture-admin");
  return { sourceId, origin, name, apiKey: sets[name]!.snapshotApiKey };
}
function stableFetch(label: string) {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    return Response.json(page(label, Number(url.searchParams.get("page"))));
  });
}
async function assertNoProjection(id: string) {
  for (const table of ["pa_users", "pa_organizations", "pa_clients", "pa_projects", "pa_operations", "pa_tasks", "pa_projection_fingerprints"]) {
    expect(await ops.prepare(`SELECT count(*) count FROM ${table} WHERE projection_source_id=?`).bind(id).first("count")).toBe(0);
  }
  expect(await ops.prepare("SELECT count(*) count FROM sync_runs WHERE projection_source_id=? AND status='success'").bind(id).first("count")).toBe(0);
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('connector-sync')}}",
    d1Databases: ["OPS_DB", "DELIVERY_DB"] });
  ops = await runtime.getD1Database("OPS_DB") as D1Database;
  delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
  for (const [database, directory] of [[ops, new URL("../migrations/", import.meta.url)], [delivery, new URL("../../client/migrations/", import.meta.url)]] as const) {
    for (const file of readdirSync(directory).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(file, directory), "utf8"));
      if (statements.length) await database.batch(statements.map(sql => database.prepare(sql)));
    }
  }
  env = { OPS_DB: ops, DELIVERY_DB: delivery, PROJECT_ALPHA_BASE_URL: "https://primary.example.test", PROJECT_ALPHA_API_KEY: "existing-primary-key",
    APPLICATION_KEY: "ltds_ops", PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: publicKey(1) } as Env & ProjectAlphaConnectorEnvironment;
  refreshCredentials();
  await registerProjectAlphaConnector(env, { sourceId: primary, producerBindingId: "existing-primary", snapshotOrigin: "https://primary.example.test",
    applicationKey: "ltds_ops", profile: "primary_legacy", displayName: "Primary", revision: { ...revision("primary"), snapshotBasePath: "/" } }, "fixture-admin");
  await setProjectAlphaConnectorState(env, primary, { expectedVersion: 1, state: "active" }, "fixture-admin");
  await ops.batch([
    ops.prepare("INSERT INTO pa_users(id,email,display_name,payload_json,last_sync_id) VALUES('1','existing-staff@example.test','Primary user','{}','old')"),
    ops.prepare("INSERT INTO pa_clients(id,name,payload_json,last_sync_id) VALUES('4','Primary contact','{}','old')"),
    ops.prepare("INSERT INTO pa_projects(id,name,client_id,payload_json,last_sync_id) VALUES('5','Primary project','4','{}','old')"),
    ops.prepare("INSERT INTO divisions(id,name,code,project_alpha_business_unit_id) VALUES('primary-division','Primary division','existing','2')"),
    ops.prepare("INSERT INTO staff_users(id,email,display_name,project_alpha_user_id) VALUES('primary-staff','existing-staff@example.test','Primary staff','1')"),
    ops.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('primary-role','primary-staff','role-operator','global','global')"),
    ops.prepare("INSERT INTO pa_projection_fingerprints(collection,fingerprint,last_sync_id) VALUES('projects','unchanged-primary-fingerprint','old')"),
  ]);
  await delivery.batch([
    delivery.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_source_id) VALUES('primary-account','Primary customer','active','4','project-alpha:primary')"),
    delivery.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('primary-identity','primary-account','https://issuer.example.test','person','person@example.test')"),
    delivery.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('primary-account','primary-identity','manager')"),
    delivery.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_project_id,project_alpha_source_id) VALUES('primary-project','Primary customer','Primary project','Clients/primary/','5','project-alpha:primary')"),
    delivery.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES('primary-account','primary-project',1)"),
    delivery.prepare(`INSERT INTO client_service_requests(id,account_id,project_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status)
      VALUES('primary-request','primary-account','primary-project','primary-identity','service','Existing request','Existing scope','existing-request-key',?,'under_review')`).bind("r".repeat(43)),
    delivery.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
      VALUES('primary-revision','primary-request',1,'client','primary-identity','submitted','{ "preserved": true }')`),
  ]);
}, 120_000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await runtime?.dispose(); });

describe("registered source snapshot end-to-end", () => {
  it("uses the exact B destination/path/Bearer and stable two-page passes without changing primary staff or Delivery", async () => {
    const source = await secondary("sync-success"), beforeStaff = await snapshotRows(ops, preservedOpsTables), beforeDelivery = await snapshotRows(delivery, preservedDeliveryTables);
    const primaryBefore = (await ops.prepare("SELECT * FROM pa_projection_fingerprints WHERE projection_source_id=?").bind(primary).all()).results;
    const fetcher = stableFetch("Secondary"); vi.stubGlobal("fetch", fetcher);
    const resolved = await resolveProjectAlphaConnector(env, source.sourceId, "snapshot");
    expect(resolved.source.staffAuthority).toBe(false);
    expect(await syncRegisteredProjectAlpha(env, source.sourceId)).toMatchObject({ status: "success" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("page"))).toEqual(["1", "2", "1", "2"]);
    for (const [input, init] of fetcher.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe(source.origin); expect(url.pathname).toBe("/tenant-alpha/api/v1/ops/snapshot");
      expect(url.searchParams.get("limit")).toBe("500");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${source.apiKey}`); expect(init?.redirect).toBe("error");
    }
    expect(await snapshotRows(ops, preservedOpsTables)).toEqual(beforeStaff);
    expect(await snapshotRows(delivery, preservedDeliveryTables)).toEqual(beforeDelivery);
    expect((await ops.prepare("SELECT * FROM pa_projection_fingerprints WHERE projection_source_id=?").bind(primary).all()).results).toEqual(primaryBefore);
    const project = await ops.prepare("SELECT id,client_id,payload_json FROM pa_projects WHERE projection_source_id=?").bind(source.sourceId)
      .first<{ id: string; client_id: string; payload_json: string }>();
    expect(project?.id).toMatch(/^pa-local-/); expect(project?.client_id).not.toBe("4");
    expect(JSON.parse(project?.payload_json ?? "null")).toMatchObject({ id: 5, name: "Secondary project", client_id: 4 });
    expect(await ops.prepare("SELECT name FROM pa_projects WHERE id='5'").first("name")).toBe("Primary project");
    expect(await ops.prepare("SELECT display_name FROM pa_users WHERE id='1'").first("display_name")).toBe("Primary user");
    expect(await ops.prepare("SELECT count(*) count FROM pa_application_entitlements WHERE projection_source_id=?").bind(source.sourceId).first("count")).toBe(0);
    expect((await ops.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 60_000);

  it("rejects missing configured credentials and unknown sources before any fetch or projection attempt", async () => {
    const source = await secondary("sync-missing"), fetcher = stableFetch("Missing"); vi.stubGlobal("fetch", fetcher);
    await expect(syncRegisteredProjectAlpha({ ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: undefined }, source.sourceId))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    await expect(syncRegisteredProjectAlpha(env, "project-alpha:unregistered-sync")).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled(); await assertNoProjection(source.sourceId);
    expect(await ops.prepare("SELECT count(*) count FROM sync_runs WHERE projection_source_id=?").bind(source.sourceId).first("count")).toBe(0);
  }, 30_000);

  it("rejects a suspended connector before fetch without treating it as disabled scalar primary", async () => {
    const source = await secondary("sync-suspended"), fetcher = stableFetch("Suspended"); vi.stubGlobal("fetch", fetcher);
    await setProjectAlphaConnectorState(env, source.sourceId, { expectedVersion: 2, state: "suspended" }, "fixture-admin");
    const before = (await ops.prepare("SELECT * FROM integration_health WHERE projection_source_id=?").bind(primary).all()).results;
    await expect(syncRegisteredProjectAlpha(env, source.sourceId)).rejects.toMatchObject({ code: "changed" });
    expect(fetcher).not.toHaveBeenCalled(); await assertNoProjection(source.sourceId);
    expect((await ops.prepare("SELECT * FROM integration_health WHERE projection_source_id=?").bind(primary).all()).results).toEqual(before);
  }, 30_000);

  it.each(["revision", "suspension"])("rolls back the first projection batch after a %s race and does not publish false fingerprints or overwrite newer health", async change => {
    const source = await secondary(`sync-race-${change}`), fetcher = stableFetch("Raced"); vi.stubGlobal("fetch", fetcher);
    const raced = beforeProjectionBatch(ops, async () => {
      if (change === "revision") {
        const ref = `${source.name}-rotated`; sets[ref] = credential(++nextSeed); refreshCredentials();
        await reviseProjectAlphaConnector(env, source.sourceId, 2, revision(ref), "fixture-admin");
      } else await setProjectAlphaConnectorState(env, source.sourceId, { expectedVersion: 2, state: "suspended" }, "fixture-admin");
      await ops.prepare(`UPDATE integration_health SET status='healthy',last_success_at='2026-08-26T03:00:00Z',last_error_code=NULL
        WHERE projection_source_id=? AND integration='project-alpha'`).bind(source.sourceId).run();
    });
    await expect(syncRegisteredProjectAlpha({ ...env, OPS_DB: raced.db }, source.sourceId)).rejects.toThrow(/pa_connector_active_revision_guard/);
    expect(raced.fired()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(4); await assertNoProjection(source.sourceId);
    expect(await ops.prepare("SELECT status,last_success_at,last_error_code FROM integration_health WHERE projection_source_id=? AND integration='project-alpha'")
      .bind(source.sourceId).first()).toEqual({ status: "healthy", last_success_at: "2026-08-26T03:00:00Z", last_error_code: null });
    expect(await ops.prepare("SELECT status,error_code FROM sync_runs WHERE projection_source_id=?").bind(source.sourceId).first())
      .toEqual({ status: "failed", error_code: "project-alpha-sync-failed" });
    expect(await ops.prepare("SELECT count(*) count FROM pa_projection_entity_leases WHERE projection_source_id=?").bind(source.sourceId).first("count")).toBe(0);
  }, 60_000);

  it("cancels an oversized streamed snapshot before any business projection", async () => {
    const source = await secondary("sync-oversized"); let chunks = 0, cancelled = false;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(512 * 1024)); },
      cancel() { cancelled = true; },
    })));
    vi.stubGlobal("fetch", fetcher);
    await expect(syncRegisteredProjectAlpha(env, source.sourceId)).rejects.toThrow("project-alpha-page-too-large");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancelled).toBe(true); expect(chunks).toBeLessThanOrEqual(11);
    await assertNoProjection(source.sourceId);
    expect(await ops.prepare("SELECT last_error_code FROM integration_health WHERE projection_source_id=? AND integration='project-alpha'")
      .bind(source.sourceId).first("last_error_code")).toBe("project-alpha-page-too-large");
  }, 30_000);

  it("persists bounded failure codes, never the upstream URL or credentials from network errors", async () => {
    const source = await secondary("sync-failure");
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error(`Failed GET ${source.origin}/tenant-alpha?api_key=${source.apiKey}`); });
    vi.stubGlobal("fetch", fetcher);
    await expect(syncRegisteredProjectAlpha(env, source.sourceId)).rejects.toThrow("project-alpha-network-error");
    expect(fetcher).toHaveBeenCalledTimes(3); await assertNoProjection(source.sourceId);
    const health = await ops.prepare("SELECT * FROM integration_health WHERE projection_source_id=? AND integration='project-alpha'")
      .bind(source.sourceId).first();
    const runs = (await ops.prepare("SELECT * FROM sync_runs WHERE projection_source_id=?").bind(source.sourceId).all()).results;
    expect(health).toMatchObject({ status: "error", last_error_code: "project-alpha-network-error" });
    expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: "failed", error_code: "project-alpha-network-error" });
    expect(JSON.stringify([health, runs])).not.toContain(source.origin); expect(JSON.stringify([health, runs])).not.toContain(source.apiKey);
  }, 30_000);
});
