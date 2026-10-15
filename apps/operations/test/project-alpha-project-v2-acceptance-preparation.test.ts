import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { prepareProjectAlphaProjectV2Acceptance, type ProjectAcceptancePreparationReaders } from "../src/worker/project-alpha-project-v2-acceptance-preparation";

let runtime: Miniflare, db: D1Database;
const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const hash = "a".repeat(64), projectHash = "b".repeat(64), organizationPublicId = "c".repeat(32), projectPublicId = "d".repeat(32);
const env = () => ({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
  "project-alpha:one": { sourceId: "project-alpha:one", enabled: true, baseUrl: "https://one.example.test", apiKey: "secret",
    sourceInstanceId, applicationId, historyEpoch },
} }) });
const actor = { staffId: "staff", accessSubject: "subject", email: "staff@example.test", admissionVersion: 1, profileVersion: 1, scopes: [] as const };
const inventory = vi.fn(async () => ({ status: "observed" as const, httpStatus: 200 as const, response: { apiVersion: "2" as const,
  sourceInstanceId, applicationId, historyEpoch, requestId: "10000000-0000-4000-8000-000000000001", authorizationGeneration: "7",
  projects: [], nextCursor: null } }));
const bindingStatus = vi.fn(async () => ({ status: "observed" as const, httpStatus: 200 as const, response: { apiVersion: "2" as const,
  sourceInstanceId, applicationId, historyEpoch, requestId: "10000000-0000-4000-8000-000000000002", authorizationGeneration: "7",
  binding: { externalId: "ops/project", publicId: projectPublicId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  resource: { revision: "2", projectionSha256: projectHash, status: "active" as const, archived: false } } }));
const project = vi.fn(async () => ({ status: "read" as const, httpStatus: 200 as const, response: { apiVersion: "2" as const,
  sourceInstanceId, applicationId, historyEpoch, requestId: "10000000-0000-4000-8000-000000000003", replayed: false as const, accepted: true,
  resource: { type: "project" as const, id: projectPublicId, revision: "2", projectionSha256: projectHash },
  data: { name: "Existing", description: null, status: "active" as const, archived: false, overdueWarning: false, completedAt: null,
    archivedAt: null, estimatedStart: null, estimatedEnd: null, clientPublicId: null, organizationPublicId } } }));
const readers = { inventory, bindingStatus, project } as ProjectAcceptancePreparationReaders;
const createRequest = () => ({ operation: "create" as const, sourceId: "project-alpha:one", expectedApplicationId: applicationId,
  externalProjectId: "ops/new-project", organizationRecordId: "org", clientRecordId: null, actor });
async function seedUpdate() {
  await db.batch([
    db.prepare("INSERT INTO operations_shared_projects VALUES('ops/project',2,?,'org',NULL,'project-alpha:one',?,?,?)").bind(projectHash, sourceInstanceId, applicationId, historyEpoch),
    db.prepare("INSERT INTO project_alpha_project_mappings VALUES('ops/project','project-alpha:one',?,?,?,?)").bind(sourceInstanceId, applicationId, historyEpoch, projectPublicId),
  ]);
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await db.exec(`CREATE TABLE native_staff_admissions(staff_id TEXT,active INTEGER,bound_access_subject TEXT,version INTEGER);
    CREATE TABLE native_staff_profiles(staff_id TEXT,login_email TEXT,version INTEGER);
    CREATE TABLE native_project_grant_generations(staff_id TEXT,generation INTEGER);
    CREATE TABLE native_project_grants(staff_id TEXT,capability TEXT,effect TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,external_project_id TEXT,active INTEGER);
    CREATE TABLE operations_directory_records(record_id TEXT,record_kind TEXT);
    CREATE TABLE project_alpha_active_directory_mappings(record_id TEXT,external_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_api_v2_directory_observations_current(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,project_alpha_public_id TEXT,resource_revision TEXT,projection_sha256 TEXT,present INTEGER,has_conflict INTEGER,binding_external_id TEXT,binding_status TEXT,binding_resource_revision TEXT);
    CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT,relationship_version INTEGER);
    CREATE TABLE project_alpha_project_destinations(external_project_id TEXT);
    CREATE TABLE project_alpha_project_outbox(external_project_id TEXT);
    CREATE TABLE operations_shared_projects(external_project_id TEXT,current_version INTEGER,canonical_projection_sha256 TEXT,organization_record_id TEXT,client_record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT);
    CREATE TABLE project_alpha_project_mappings(external_project_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,project_alpha_public_id TEXT);`);
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  for (const table of ["native_staff_admissions","native_staff_profiles","native_project_grant_generations","native_project_grants","operations_directory_records","project_alpha_active_directory_mappings","project_alpha_api_v2_directory_observations_current","operations_directory_client_organizations","project_alpha_project_destinations","project_alpha_project_outbox","operations_shared_projects","project_alpha_project_mappings"])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES('staff',1,'subject',1)"),
    db.prepare("INSERT INTO native_staff_profiles VALUES('staff','staff@example.test',1)"),
    db.prepare("INSERT INTO native_project_grant_generations VALUES('staff',1)"),
    db.prepare("INSERT INTO native_project_grants VALUES('staff','project.shared.sync','allow','global',NULL,NULL,NULL,1)"),
    db.prepare("INSERT INTO operations_directory_records VALUES('org','organization')"),
    db.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES('org','reviewed-org','project-alpha:one',?,?,?,?,?)").bind(sourceInstanceId, applicationId, historyEpoch, "organization", organizationPublicId),
    db.prepare("INSERT INTO project_alpha_api_v2_directory_observations_current VALUES('project-alpha:one',?,?,?,?,?,?,?,1,0,'reviewed-org','active',?)")
      .bind(sourceInstanceId, applicationId, historyEpoch, "organization", organizationPublicId, "3", hash, "3"),
  ]);
  vi.clearAllMocks();
});

describe("Project-v2 acceptance preparation", () => {
  it("derives create relation and generation fences and rejects ambiguous current directory evidence", async () => {
    const request = createRequest();
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), request, readers)).resolves.toMatchObject({ status: "prepared", preparation: {
      expectedAuthorizationGeneration: "7", directory: { organizationRecordId: "org" }, organization: { externalId: "reviewed-org", expectedPublicId: organizationPublicId, expectedRevision: "3", expectedProjectionSha256: hash } } });
    await db.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES('org','reviewed-org','project-alpha:one',?,?,?,?,?)")
      .bind(sourceInstanceId, applicationId, historyEpoch, "organization", organizationPublicId).run();
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), request, readers)).resolves.toEqual({ status: "blocked", reason: "directory" });
  });

  it("sandwiches update readback and returns server-derived local and remote CAS fences", async () => {
    await seedUpdate();
    const result = await prepareProjectAlphaProjectV2Acceptance(env(), { operation: "update", sourceId: "project-alpha:one",
      expectedApplicationId: applicationId, externalProjectId: "ops/project", actor }, readers);
    expect(result).toMatchObject({ status: "prepared", preparation: { expectedAuthorizationGeneration: "7", expectedPublicId: projectPublicId,
      expectedRevision: "2", expectedProjectionSha256: projectHash, local: { expectedLocalVersion: 2, expectedLocalProjectionSha256: projectHash },
      project: { name: "Existing" } } });
    expect(bindingStatus).toHaveBeenCalledTimes(2);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it("fails closed on missing admission/generation and explicit deny over allow", async () => {
    await db.prepare("DELETE FROM native_project_grant_generations").run();
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), createRequest(), readers)).resolves.toEqual({ status: "blocked", reason: "authority" });
    await db.prepare("INSERT INTO native_project_grant_generations VALUES('staff',1)").run();
    await db.prepare("INSERT INTO native_project_grants VALUES('staff','project.shared.sync','deny','global',NULL,NULL,NULL,1)").run();
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), createRequest(), readers))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
  });

  it("rejects wrong-tuple, stale binding revision, and pre-existing destination evidence", async () => {
    await db.prepare("UPDATE project_alpha_active_directory_mappings SET history_epoch_id='wrong'").run();
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), createRequest(), readers)).resolves.toEqual({ status: "blocked", reason: "directory" });
    await db.prepare("UPDATE project_alpha_active_directory_mappings SET history_epoch_id=?").bind(historyEpoch).run();
    await db.prepare("UPDATE project_alpha_api_v2_directory_observations_current SET binding_external_id='wrong-binding'").run();
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), createRequest(), readers)).resolves.toEqual({ status: "blocked", reason: "directory" });
    await db.prepare("UPDATE project_alpha_api_v2_directory_observations_current SET binding_external_id='reviewed-org'").run();
    await db.prepare("UPDATE project_alpha_api_v2_directory_observations_current SET binding_resource_revision='2'").run();
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), createRequest(), readers)).resolves.toEqual({ status: "blocked", reason: "directory" });
    await db.prepare("UPDATE project_alpha_api_v2_directory_observations_current SET binding_resource_revision='3'").run();
    await db.prepare("INSERT INTO project_alpha_project_destinations VALUES('ops/new-project')").run();
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), createRequest(), readers)).resolves.toEqual({ status: "blocked", reason: "stale" });
  });

  it("requires the exact client-to-organization relationship", async () => {
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES('client','client')"),
      db.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES('client','reviewed-client','project-alpha:one',?,?,?,?,?)").bind(sourceInstanceId, applicationId, historyEpoch, "client", "e".repeat(32)),
      db.prepare("INSERT INTO project_alpha_api_v2_directory_observations_current VALUES('project-alpha:one',?,?,?,?,?,?,?,1,0,'reviewed-client','active',?)")
        .bind(sourceInstanceId, applicationId, historyEpoch, "client", "e".repeat(32), "4", hash, "4"),
    ]);
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), { ...createRequest(), clientRecordId: "client" }, readers))
      .resolves.toEqual({ status: "blocked", reason: "directory" });
  });

  it("rejects same-endpoint relationship ABA when its monotonic version changes", async () => {
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES('client','client')"),
      db.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES('client','reviewed-client','project-alpha:one',?,?,?,?,?)").bind(sourceInstanceId, applicationId, historyEpoch, "client", "e".repeat(32)),
      db.prepare("INSERT INTO project_alpha_api_v2_directory_observations_current VALUES('project-alpha:one',?,?,?,?,?,?,?,1,0,'reviewed-client','active',?)")
        .bind(sourceInstanceId, applicationId, historyEpoch, "client", "e".repeat(32), "4", hash, "4"),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES('client','org',1)"),
    ]);
    const observed = await inventory();
    inventory.mockImplementationOnce(async () => {
      await db.prepare("UPDATE operations_directory_client_organizations SET relationship_version=2 WHERE client_record_id='client'").run();
      return observed;
    });
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), { ...createRequest(), clientRecordId: "client" }, readers))
      .resolves.toEqual({ status: "blocked", reason: "stale" });
  });

  it("rejects a changed remote sandwich and a local head changed during the read", async () => {
    await seedUpdate();
    bindingStatus.mockResolvedValueOnce(await bindingStatus()).mockResolvedValueOnce({ ...(await bindingStatus()), response: {
      ...(await bindingStatus()).response, resource: { ...(await bindingStatus()).response.resource, revision: "3" } } });
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), { operation: "update", sourceId: "project-alpha:one",
      expectedApplicationId: applicationId, externalProjectId: "ops/project", actor }, readers)).resolves.toEqual({ status: "blocked", reason: "remote" });
    vi.clearAllMocks();
    project.mockImplementationOnce(async () => {
      await db.prepare("UPDATE operations_shared_projects SET current_version=3 WHERE external_project_id='ops/project'").run();
      return { status: "read" as const, httpStatus: 200 as const, response: { apiVersion: "2" as const, sourceInstanceId, applicationId, historyEpoch,
        requestId: "10000000-0000-4000-8000-000000000003", replayed: false as const, accepted: true,
        resource: { type: "project" as const, id: projectPublicId, revision: "2", projectionSha256: projectHash },
        data: { name: "Existing", description: null, status: "active" as const, archived: false, overdueWarning: false, completedAt: null,
          archivedAt: null, estimatedStart: null, estimatedEnd: null, clientPublicId: null, organizationPublicId } } };
    });
    await expect(prepareProjectAlphaProjectV2Acceptance(env(), { operation: "update", sourceId: "project-alpha:one",
      expectedApplicationId: applicationId, externalProjectId: "ops/project", actor }, readers)).resolves.toEqual({ status: "blocked", reason: "stale" });
  });
});

describe("Project-v2 preparation SQL on the current migration schema", () => {
  let currentRuntime: Miniflare, currentDb: D1Database;
  beforeAll(async () => {
    currentRuntime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    currentDb = await currentRuntime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0180").sort();
    await currentDb.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
    for (const migration of migrations) await currentDb.batch([
      ...splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => currentDb.prepare(sql)),
      currentDb.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(migration),
    ]);
    await currentDb.batch([
      currentDb.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','subject','active')"),
      currentDb.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES('owner','subject',1,'owner')"),
      currentDb.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES('owner','owner@example.test','Owner')"),
      currentDb.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,granted_by) VALUES('project-global','owner','project.shared.sync','allow','global','owner')"),
    ]);
  }, 240_000);
  afterAll(async () => currentRuntime.dispose());

  it("compiles the helper query set against every migration through 0180", async () => {
    const currentEnv = { OPS_DB: currentDb, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
      "project-alpha:one": { sourceId: "project-alpha:one", enabled: true, baseUrl: "https://one.example.test", apiKey: "secret",
        sourceInstanceId, applicationId, historyEpoch },
    } }) };
    const currentActor = { ...actor, staffId: "owner", email: "owner@example.test" };
    await expect(prepareProjectAlphaProjectV2Acceptance(currentEnv, { ...createRequest(), actor: currentActor }, readers))
      .resolves.toEqual({ status: "blocked", reason: "directory" });
    await expect(prepareProjectAlphaProjectV2Acceptance(currentEnv, { operation: "update", sourceId: "project-alpha:one",
      expectedApplicationId: applicationId, externalProjectId: "ops/missing", actor: currentActor }, readers))
      .resolves.toEqual({ status: "blocked", reason: "stale" });
    await expect(currentDb.prepare(`EXPLAIN QUERY PLAN SELECT client_record_id,organization_record_id,relationship_version FROM operations_directory_client_organizations
      WHERE client_record_id=? AND organization_record_id=? LIMIT 2`).bind("client", "org").all()).resolves.toMatchObject({ success: true });
    expect((await currentDb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
