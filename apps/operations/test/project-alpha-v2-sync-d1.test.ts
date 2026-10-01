import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const mocks = vi.hoisted(() => ({ configured: vi.fn(), probe: vi.fn(), directory: vi.fn(), projects: vi.fn() }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({
  withEnabledConfiguredProjectAlphaApiV2Connection: mocks.configured,
}));
vi.mock("../src/worker/project-alpha-api-v2", () => ({ probeProjectAlphaApiV2: mocks.probe }));
vi.mock("../src/worker/project-alpha-directory-command-api-v2", () => ({
  PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT: {
    method: "GET", path: "/api/v2/directory/inventory", requiredCapability: "directory.inventory.read",
    requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true,
  },
  readProjectAlphaDirectoryInventoryAfterVerifiedCapabilities: mocks.directory,
}));
vi.mock("../src/worker/project-alpha-project-inventory-api-v2", () => ({
  PROJECT_ALPHA_PROJECT_INVENTORY_ENDPOINT: {
    method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read",
    requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true,
  },
  readProjectAlphaProjectInventoryAfterVerifiedCapabilities: mocks.projects,
}));

import { persistProjectAlphaDirectoryInventoryPage, runProjectAlphaApiV2SyncPage,
  type ProjectAlphaApiV2SyncEnvironment }
  from "../src/worker/project-alpha-v2-sync";

const sourceId = "project-alpha:sync-test";
const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const directoryRequestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const projectRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const directoryPublicId = "1".repeat(32);
const projectPublicId = "2".repeat(32);
const connection = { baseUrl: "https://pa.example.test", apiKey: "private-test-key",
  expectedSourceInstanceId: sourceInstanceId, expectedApplicationId: applicationId,
  expectedHistoryEpoch: historyEpoch };

let runtime: Miniflare;
let database: D1Database;
let env: ProjectAlphaApiV2SyncEnvironment;

async function migrate(): Promise<void> {
  const directory = new URL("../migrations/", import.meta.url);
  const names = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  expect(names).toContain("0161_project_alpha_api_v2_inventory_observations.sql");
  const prerequisites = `
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY);
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY);
    CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY);
    CREATE TABLE operations_shared_projects(external_project_id TEXT PRIMARY KEY);
    CREATE TABLE project_alpha_directory_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_project_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      external_project_id TEXT,project_alpha_public_id TEXT);`;
  await database.batch(splitD1MigrationStatements(prerequisites).map(statement => database.prepare(statement)));
  const sql = readFileSync(new URL("0161_project_alpha_api_v2_inventory_observations.sql", directory), "utf8");
  await database.batch(splitD1MigrationStatements(sql).map(statement => database.prepare(statement)));
}

function directoryObserved(overrides: Record<string, unknown> = {}) {
  return { status: "observed", inventory: {
    authoritative: false as const, sourceId, sourceInstanceId, applicationId, historyEpoch,
    requestId: directoryRequestId, authorizationGeneration: "7", nextCursor: null,
    resources: [{ type: "client", publicId: directoryPublicId, revision: "3", present: true,
      lastAction: "upsert", projectionSha256: "a".repeat(64),
      binding: { externalId: "ops-customer-1", status: "active", resourceRevision: "3" } }],
    ...overrides,
  } };
}

function projectsObserved(overrides: Record<string, unknown> = {}) {
  return { status: "observed", httpStatus: 200, response: {
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch,
    requestId: projectRequestId, authorizationGeneration: "7", nextCursor: null,
    projects: [{ externalId: "ops-project-1", publicId: projectPublicId, revision: "4",
      projectionSha256: "b".repeat(64), status: "active", archived: false }],
    ...overrides,
  } };
}

async function resetDatabase(): Promise<void> {
  await runtime?.dispose();
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('local-test')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  await migrate();
  env = { OPS_DB: database, PROJECT_ALPHA_API_V2_SYNC_ENABLED: "true" };
}

afterAll(async () => { await runtime?.dispose(); });

beforeEach(async () => {
  await resetDatabase();
  vi.clearAllMocks();
  mocks.configured.mockImplementation(async (_env, _source, callback) =>
    ({ status: "enabled", value: await callback(connection) }));
  mocks.probe.mockResolvedValue({ status: "verified", sourceInstanceId, applicationId, historyEpoch,
    requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    grantedCapabilities: ["api.capabilities.read", "directory.inventory.read", "projects.inventory.read"] });
  mocks.directory.mockResolvedValue(directoryObserved());
  mocks.projects.mockResolvedValue(projectsObserved());
}, 60000);

describe("Project Alpha API-v2 inventory evidence ingestion", () => {
  it("is strictly default-off before connection resolution or any remote read", async () => {
    await expect(runProjectAlphaApiV2SyncPage({ OPS_DB: database }, { sourceId }, vi.fn()))
      .resolves.toEqual({ status: "disabled" });
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.directory).not.toHaveBeenCalled();
    expect(mocks.projects).not.toHaveBeenCalled();
  });

  it("persists exact validated evidence idempotently without projecting, mapping, or activating anything", async () => {
    const first = await runProjectAlphaApiV2SyncPage(env, { sourceId, limit: 100 }, vi.fn());
    expect(first).toEqual({ status: "completed",
      directory: { status: "persisted", itemCount: 1, conflictCount: 0, nextCursor: null,
        continuationIdentity: { sourceInstanceId, applicationId, historyEpoch, authorizationGeneration: "7" } },
      projects: { status: "persisted", itemCount: 1, conflictCount: 0, nextCursor: null,
        continuationIdentity: { sourceInstanceId, applicationId, historyEpoch, authorizationGeneration: "7" } } });
    await expect(runProjectAlphaApiV2SyncPage(env, { sourceId, limit: 100 }, vi.fn()))
      .resolves.toEqual(first);
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_inventory_receipts").first<number>("n")).toBe(2);
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_directory_observations").first<number>("n")).toBe(1);
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_project_observations").first<number>("n")).toBe(1);
    for (const table of ["pa_clients", "pa_projects", "operations_directory_records",
      "project_alpha_directory_mappings", "operations_shared_projects", "project_alpha_project_mappings"])
      expect(await database.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n"), table).toBe(0);
  });

  it("records exact-ID collisions for review and never selects or creates a mapping", async () => {
    await runProjectAlphaApiV2SyncPage(env, { sourceId }, vi.fn());
    mocks.directory.mockResolvedValueOnce(directoryObserved({
      requestId: "10000000-0000-4000-8000-000000000001",
      resources: [{ type: "client", publicId: "3".repeat(32), revision: "1", present: true,
        lastAction: "upsert", projectionSha256: "c".repeat(64),
        binding: { externalId: "ops-customer-1", status: "active", resourceRevision: "1" } }],
    }));
    mocks.projects.mockResolvedValueOnce(projectsObserved({
      requestId: "10000000-0000-4000-8000-000000000002",
      projects: [{ externalId: "ops-project-1", publicId: "4".repeat(32), revision: "1",
        projectionSha256: "d".repeat(64), status: "not_started", archived: false }],
    }));
    const result = await runProjectAlphaApiV2SyncPage(env, { sourceId }, vi.fn());
    expect(result).toMatchObject({ status: "partial",
      directory: { status: "conflicted", conflictCount: 1 },
      projects: { status: "conflicted", conflictCount: 1 } });
    const conflicts = await database.prepare(`SELECT inventory_kind,conflict_kind
      FROM project_alpha_api_v2_inventory_conflicts ORDER BY inventory_kind`).all();
    expect(conflicts.results).toEqual([
      { inventory_kind: "directory", conflict_kind: "external_id_collision" },
      { inventory_kind: "project", conflict_kind: "external_id_collision" },
    ]);
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_directory_mappings").first<number>("n")).toBe(0);
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_project_mappings").first<number>("n")).toBe(0);
  });

  it("records source identity drift without replacing the current trusted-source observation", async () => {
    await runProjectAlphaApiV2SyncPage(env, { sourceId }, vi.fn());
    const driftedSourceInstanceId = "99999999-9999-4999-8999-999999999999";
    const result = await persistProjectAlphaDirectoryInventoryPage(database, {
      ...directoryObserved().inventory,
      sourceInstanceId: driftedSourceInstanceId,
      requestId: "10000000-0000-4000-8000-000000000005",
      resources: [],
    }, null);
    expect(result).toEqual({ status: "conflicted", itemCount: 0, conflictCount: 1, nextCursor: null,
      continuationIdentity: { sourceInstanceId: driftedSourceInstanceId, applicationId, historyEpoch, authorizationGeneration: "7" } });
    expect(await database.prepare(`SELECT conflict_kind FROM project_alpha_api_v2_inventory_conflicts
      WHERE inventory_kind='directory' AND source_instance_id=?`).bind(driftedSourceInstanceId)
      .first<string>("conflict_kind")).toBe("source_identity_changed");
    const current = await database.prepare(`SELECT source_instance_id,has_conflict
      FROM project_alpha_api_v2_directory_observations_current
      WHERE project_alpha_public_id=?`).bind(directoryPublicId).first();
    expect(current).toEqual({ source_instance_id: sourceInstanceId, has_conflict: 0 });
  });

  it("retains prior observations across empty/incomplete pages instead of inferring deletion", async () => {
    await runProjectAlphaApiV2SyncPage(env, { sourceId }, vi.fn());
    mocks.directory.mockResolvedValueOnce(directoryObserved({
      requestId: "10000000-0000-4000-8000-000000000003", resources: [], nextCursor: null,
    }));
    mocks.projects.mockResolvedValueOnce(projectsObserved({
      requestId: "10000000-0000-4000-8000-000000000004", projects: [], nextCursor: null,
    }));
    const common = { v: 1 as const, sourceId, limit: 100, sourceInstanceId, applicationId, historyEpoch,
      authorizationGeneration: "7", expires: Date.now() + 60_000 };
    await runProjectAlphaApiV2SyncPage(env, { sourceId, continuation: { ...common, surface: "directory",
      cursor: `client:${directoryPublicId}` } }, vi.fn());
    await runProjectAlphaApiV2SyncPage(env, { sourceId, continuation: { ...common, surface: "projects",
      cursor: "ops-project-1" } }, vi.fn());
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_directory_observations_current").first<number>("n")).toBe(1);
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_project_observations_current").first<number>("n")).toBe(1);
  });

  it("persists stale Project binding evidence and leaves the Directory page usable", async () => {
    mocks.projects.mockResolvedValueOnce({ status: "binding_stale", httpStatus: 409, response: {
      apiVersion: "2", sourceInstanceId, applicationId, historyEpoch,
      requestId: projectRequestId, error: { code: "binding_stale", externalId: "ops-project-1" },
    } });
    await expect(runProjectAlphaApiV2SyncPage(env, { sourceId }, vi.fn())).resolves.toEqual({
      status: "partial",
      directory: { status: "persisted", itemCount: 1, conflictCount: 0, nextCursor: null,
        continuationIdentity: { sourceInstanceId, applicationId, historyEpoch, authorizationGeneration: "7" } },
      projects: { status: "blocked", reason: "binding_stale" },
    });
    expect(await database.prepare(`SELECT conflict_kind FROM project_alpha_api_v2_inventory_conflicts
      WHERE inventory_kind='project'`).first<string>("conflict_kind")).toBe("binding_stale");
  });

  it("refuses continuation inventory when authorization generation changed, before persisting any page", async () => {
    const cursor = `client:${directoryPublicId}`;
    mocks.directory.mockResolvedValueOnce(directoryObserved({
      requestId: "10000000-0000-4000-8000-000000000006", authorizationGeneration: "8",
      resources: [], nextCursor: null,
    }));
    const before = await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_inventory_receipts").first<number>("n");
    const result = await runProjectAlphaApiV2SyncPage(env, { sourceId, continuation: {
      v: 1, sourceId, surface: "directory", limit: 100, sourceInstanceId, applicationId, historyEpoch,
      authorizationGeneration: "7", cursor, expires: Date.now() + 60_000,
    } }, vi.fn());
    expect(result).toMatchObject({ status: "partial", directory: { status: "blocked", reason: "cursor_stale" },
      projects: { status: "not_requested" } });
    expect(mocks.directory).toHaveBeenCalledWith(connection, sourceId, { type: "all", cursor, limit: 100 }, expect.any(Function));
    expect(mocks.projects).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_inventory_receipts").first<number>("n")).toBe(before);
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_directory_observations").first<number>("n")).toBe(0);
  });

  it("rejects a continuation for a changed configured identity before requesting inventory", async () => {
    const changedConnection = { ...connection, expectedHistoryEpoch: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
    mocks.configured.mockImplementationOnce(async (_env, _source, callback) =>
      ({ status: "enabled", value: await callback(changedConnection) }));
    const result = await runProjectAlphaApiV2SyncPage(env, { sourceId, continuation: {
      v: 1, sourceId, surface: "projects", limit: 100, sourceInstanceId, applicationId, historyEpoch,
      authorizationGeneration: "7", cursor: "ops-project-1", expires: Date.now() + 60_000,
    } }, vi.fn());
    expect(result).toMatchObject({ status: "partial", projects: { status: "blocked", reason: "cursor_stale" } });
    expect(mocks.projects).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_inventory_receipts").first<number>("n")).toBe(0);
  });

  it("refuses same-request payload substitution while retaining immutable prior evidence", async () => {
    await runProjectAlphaApiV2SyncPage(env, { sourceId }, vi.fn());
    mocks.directory.mockResolvedValueOnce(directoryObserved({
      resources: [{ type: "client", publicId: directoryPublicId, revision: "3", present: true,
        lastAction: "upsert", projectionSha256: "f".repeat(64),
        binding: { externalId: "ops-customer-1", status: "active", resourceRevision: "3" } }],
    }));
    const result = await runProjectAlphaApiV2SyncPage(env, { sourceId }, vi.fn());
    expect(result).toMatchObject({ status: "partial", directory: { status: "blocked", reason: "storage" } });
    expect(await database.prepare(`SELECT conflict_kind FROM project_alpha_api_v2_inventory_conflicts
      WHERE inventory_kind='directory'`).first<string>("conflict_kind")).toBe("request_reuse_mismatch");
    expect(await database.prepare(`SELECT projection_sha256 FROM project_alpha_api_v2_directory_observations
      WHERE project_alpha_public_id=?`).bind(directoryPublicId).first<string>("projection_sha256")).toBe("a".repeat(64));
  });
});
