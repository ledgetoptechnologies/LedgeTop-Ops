import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { refreshProjectAlphaProjectBinding } from "../src/worker/project-alpha-project-binding-revision-refresh";

const source = "project-alpha:primary";
const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const externalProjectId = "ops/project-1";
const publicId = "1".repeat(32);
const projection = "a".repeat(64);
const commandId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const requestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const connection = { sourceId: source, enabled: true, baseUrl: "https://pa.example.test", apiKey: "private",
  sourceInstanceId, applicationId, historyEpoch };

let runtime: Miniflare;
let db: D1Database;
let seed = 0;
const uuid = () => `f0000000-0000-4000-8000-${(++seed).toString(16).padStart(12, "0")}`;

function metadata() {
  return { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "projects.binding_status.read" }, { name: "projects.binding.revision.refresh" }],
    implementedEndpoints: [
      { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      { method: "GET", path: "/api/v2/projects/bindings/status/{base64urlExternalId}", requiredCapability: "projects.binding_status.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
      { method: "POST", path: "/api/v2/projects/bindings/revisions/commands", requiredCapability: "projects.binding.revision.refresh", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
    ] };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId } });
}
function stale() {
  return { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId, error: { code: "binding_stale" }, authorizationGeneration: "6",
    binding: { externalId: externalProjectId, publicId, revision: "2" }, resource: { revision: "10", projectionSha256: projection } };
}
function observed() {
  return { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId, authorizationGeneration: "7",
    binding: { externalId: externalProjectId, publicId, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:01.000Z" },
    resource: { revision: "10", projectionSha256: projection, status: "active", archived: false } };
}
function acknowledgement() {
  return { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId, replayed: false,
    result: { resource: { type: "project", id: externalProjectId, publicId, revision: "10", projectionSha256: projection }, authorizationGeneration: "7",
      presentation: { portalPublished: true, publicLinkEnabled: true } } };
}
function env(configuredConnection = connection) {
  return { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [source]: configuredConnection } }) } as never;
}
function fakeFetch(mode: "success" | "failure" | "observed-first" | "no-capability" = "success") {
  let statusReads = 0;
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/capabilities")) {
      if (mode === "no-capability") {
        const value = metadata();
        return json({ ...value, grantedCapabilities: value.grantedCapabilities.filter(item => item.name !== "projects.binding.revision.refresh"), implementedEndpoints: value.implementedEndpoints.filter(item => item.requiredCapability !== "projects.binding.revision.refresh") });
      }
      return json(metadata());
    }
    if (path.includes("/bindings/status/")) {
      statusReads += 1;
      return mode === "observed-first" || statusReads > 1 ? json(observed()) : json(stale(), 409);
    }
    if (path.endsWith("/bindings/revisions/commands")) return mode === "failure" ? json({ error: "offline" }, 503) : json(acknowledgement());
    throw new Error(`unexpected request ${String(url)} ${init?.method ?? "GET"}`);
  };
}

beforeEach(async () => {
  if (!runtime) {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
  }
  seed = 0;
  await db.exec("DROP TABLE IF EXISTS project_alpha_project_binding_revision_refresh_receipts; DROP TABLE IF EXISTS project_alpha_project_binding_revision_refresh_events; DROP TABLE IF EXISTS project_alpha_project_binding_revision_refresh_commands; DROP TABLE IF EXISTS project_alpha_project_mappings; DROP TABLE IF EXISTS project_alpha_project_destinations; DROP TABLE IF EXISTS operations_shared_projects; DROP TABLE IF EXISTS delivery_public_shares;");
  await db.exec(`CREATE TABLE project_alpha_project_destinations(external_project_id TEXT PRIMARY KEY,source_id TEXT,application_id TEXT,destination_base_url TEXT,expected_source_instance_id TEXT);
    CREATE TABLE project_alpha_project_mappings(external_project_id TEXT PRIMARY KEY,source_id TEXT,source_instance_id TEXT,application_id TEXT,project_alpha_public_id TEXT,establishment_command_id TEXT);
    CREATE TABLE operations_shared_projects(external_project_id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT);`);
  const migration = readFileSync(new URL("../migrations/0128_project_alpha_project_binding_revision_refresh_ledger.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement)));
  await db.batch([
    db.prepare("INSERT INTO project_alpha_project_destinations VALUES(?,?,?,?,?)").bind(externalProjectId, source, applicationId, connection.baseUrl, sourceInstanceId),
    db.prepare("INSERT INTO project_alpha_project_mappings VALUES(?,?,?,?,?,?)").bind(externalProjectId, source, sourceInstanceId, applicationId, publicId, uuid()),
    db.prepare("INSERT INTO operations_shared_projects VALUES(?,?)").bind(externalProjectId, "Untouched project"),
    db.prepare("INSERT INTO delivery_public_shares VALUES(?,?)").bind("share", "https://public.example.test/unchanged"),
  ]);
});

afterAll(() => runtime?.dispose());

describe("staging project binding revision refresh", () => {
  it("fences the exact stale status, confirms after ack, and leaves project/public-link data unchanged", async () => {
    const result = await refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fakeFetch());
    expect(result).toMatchObject({ status: "acknowledged", postStatusConfirmed: true });
    expect(await db.prepare("SELECT name FROM operations_shared_projects WHERE external_project_id=?").bind(externalProjectId).first("name")).toBe("Untouched project");
    expect(await db.prepare("SELECT url FROM delivery_public_shares WHERE id='share'").first("url")).toBe("https://public.example.test/unchanged");
    expect(await db.prepare("SELECT expected_prior_revision,expected_live_revision FROM project_alpha_project_binding_revision_refresh_commands").first()).toEqual({ expected_prior_revision: "2", expected_live_revision: "10" });
  });

  it("replays a completed command without another PA request", async () => {
    let calls = 0;
    const fetcher = async (...args: Parameters<typeof fetch>) => { calls += 1; return fakeFetch()(...args); };
    await refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fetcher);
    const before = calls;
    const replay = await refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fetcher);
    expect(replay).toMatchObject({ status: "acknowledged", replayed: true });
    expect(calls).toBe(before);
  });

  it("does not replay an old receipt after the source alias is reconfigured", async () => {
    await refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fakeFetch());
    const reconfigured = { ...connection, applicationId: "99999999-9999-4999-8999-999999999999" };
    await expect(refreshProjectAlphaProjectBinding(env(reconfigured), { sourceId: source, externalProjectId, commandId }, fakeFetch()))
      .resolves.toEqual({ status: "blocked", reason: "identity" });
  });

  it("does not poison a command when preflight proves no POST was sent", async () => {
    let posts = 0;
    const missing = fakeFetch("no-capability");
    const wrappedMissing = async (...args: Parameters<typeof fetch>) => { if (String(args[0]).endsWith("/bindings/revisions/commands")) posts += 1; return missing(...args); };
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, wrappedMissing)).resolves.toEqual({ status: "blocked", reason: "no_send_preflight" });
    expect(posts).toBe(0);
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fakeFetch())).resolves.toMatchObject({ status: "acknowledged" });
  });

  it("allows repeated no-send preflight recovery without leaving the command pending", async () => {
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fakeFetch("no-capability"))).resolves.toEqual({ status: "blocked", reason: "no_send_preflight" });
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fakeFetch("no-capability"))).resolves.toEqual({ status: "blocked", reason: "no_send_preflight" });
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fakeFetch())).resolves.toMatchObject({ status: "acknowledged" });
    expect(await db.prepare("SELECT state_version,state FROM project_alpha_project_binding_revision_refresh_events WHERE command_id=? ORDER BY state_version").bind(commandId).all())
      .toMatchObject({ results: [
        { state_version: 1, state: "pending" },
        { state_version: 2, state: "preflight_blocked" },
        { state_version: 3, state: "pending" },
        { state_version: 4, state: "preflight_blocked" },
        { state_version: 5, state: "pending" },
        { state_version: 6, state: "acknowledged" },
      ] });
  });

  it("does not retry an uncertain command", async () => {
    let calls = 0;
    const fetcher = async (...args: Parameters<typeof fetch>) => { calls += 1; return fakeFetch("failure")(...args); };
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fetcher)).resolves.toMatchObject({ status: "uncertain" });
    const before = calls;
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fetcher)).resolves.toEqual({ status: "blocked", reason: "prior_uncertain" });
    expect(calls).toBe(before);
  });

  it("lets one concurrent reservation win and never double-dispatches", async () => {
    let posts = 0;
    const base = fakeFetch();
    const fetcher = async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/bindings/revisions/commands")) { posts += 1; await Promise.resolve(); }
      return base(...args);
    };
    const [first, second] = await Promise.all([
      refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fetcher),
      refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fetcher),
    ]);
    expect([first.status, second.status].filter(value => value === "acknowledged")).toHaveLength(1);
    expect([first.status, second.status].some(value => value === "blocked")).toBe(true);
    expect(posts).toBe(1);
  });

  it("fails closed when the selected binding is current", async () => {
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fakeFetch("observed-first"))).resolves.toEqual({ status: "blocked", reason: "not_stale" });
    expect(await db.prepare("SELECT count(*) AS count FROM project_alpha_project_binding_revision_refresh_commands").first("count")).toBe(0);
  });

  it("rejects a source outside the canonical selection and a non-exact local mapping", async () => {
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: "primary", externalProjectId, commandId }, fakeFetch())).resolves.toEqual({ status: "rejected", reason: "invalid_input" });
    await db.prepare("DELETE FROM project_alpha_project_mappings WHERE external_project_id=?").bind(externalProjectId).run();
    await expect(refreshProjectAlphaProjectBinding(env(), { sourceId: source, externalProjectId, commandId }, fakeFetch())).resolves.toEqual({ status: "blocked", reason: "mapping" });
    expect(await db.prepare("SELECT count(*) AS count FROM project_alpha_project_binding_revision_refresh_commands").first("count")).toBe(0);
  });
});
