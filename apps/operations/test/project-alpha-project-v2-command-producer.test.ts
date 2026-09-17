import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { planProjectAlphaProjectV2Command, type ProjectAlphaProjectV2CommandProducerAction } from "../src/worker/project-alpha-project-v2-command-producer";

let runtime: Miniflare, db: D1Database, sequence = 0;
const uuid = () => `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
const sourceOne = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", appOne = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epochOne = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sourceTwo = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", appTwo = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", epochTwo = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const sha = "a".repeat(64), until = "2999-01-01T00:00:00.000Z";

async function migrate(name: string) {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}
function env() {
  return { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    "project-alpha:one": { sourceId: "project-alpha:one", enabled: false, baseUrl: "https://one.example.test", apiKey: "one", sourceInstanceId: sourceOne, applicationId: appOne, historyEpoch: epochOne },
    "project-alpha:two": { sourceId: "project-alpha:two", enabled: false, baseUrl: "https://two.example.test", apiKey: "two", sourceInstanceId: sourceTwo, applicationId: appTwo, historyEpoch: epochTwo },
  } }) };
}
async function actor() {
  const staffId = `staff-${++sequence}`, accessSubject = `subject-${sequence}`, email = `${staffId}@example.test`;
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES(?,1,?,1)").bind(staffId, accessSubject),
    db.prepare("INSERT INTO native_staff_profiles VALUES(?,?,1)").bind(staffId, email),
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,granted_by)
      VALUES(?,?,'project.shared.sync','allow','global',?)`).bind(`grant-${staffId}`, staffId, staffId),
  ]);
  return { staffId, accessSubject };
}
async function directory(sourceId: string, sourceInstanceId: string, applicationId: string, historyEpochId: string) {
  const organizationRecordId = uuid(), clientRecordId = uuid(), organizationPublicId = crypto.randomUUID().replaceAll("-", ""), clientPublicId = crypto.randomUUID().replaceAll("-", "");
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records(record_id,record_kind) VALUES(?,'organization')").bind(organizationRecordId),
    db.prepare("INSERT INTO operations_directory_records(record_id,record_kind) VALUES(?,'client')").bind(clientRecordId),
    db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
      VALUES(?,?,?,?,?,?,?)`).bind(sourceId, sourceInstanceId, applicationId, historyEpochId, "organization", organizationRecordId, organizationPublicId),
    db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
      VALUES(?,?,?,?,?,?,?)`).bind(sourceId, sourceInstanceId, applicationId, historyEpochId, "client", clientRecordId, clientPublicId),
    db.prepare("INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id) VALUES(?,?)").bind(clientRecordId, organizationRecordId),
  ]);
  return { organizationRecordId, clientRecordId, organizationPublicId, clientPublicId };
}
async function createAction(sourceId = "project-alpha:one"): Promise<Extract<ProjectAlphaProjectV2CommandProducerAction, { operation: "create" }>> {
  const sourceInstanceId = sourceId === "project-alpha:one" ? sourceOne : sourceTwo;
  const applicationId = sourceId === "project-alpha:one" ? appOne : appTwo;
  const historyEpochId = sourceId === "project-alpha:one" ? epochOne : epochTwo;
  const [staff, records] = await Promise.all([actor(), directory(sourceId, sourceInstanceId, applicationId, historyEpochId)]);
  return { sourceId, actor: { ...staff, verifiedUntil: until, scopes: [] }, operation: "create", local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null },
    directory: { organizationRecordId: records.organizationRecordId, clientRecordId: records.clientRecordId },
    command: { commandId: uuid(), externalId: `ops/project-${sequence}`, expectedAuthorizationGeneration: "0",
      project: { name: "Survey", description: null, estimatedStart: null, estimatedEnd: null },
      organization: { externalId: records.organizationRecordId, expectedPublicId: records.organizationPublicId, expectedRevision: "1", expectedProjectionSha256: sha },
      client: { externalId: records.clientRecordId, expectedPublicId: records.clientPublicId, expectedRevision: "1", expectedProjectionSha256: sha } },
  };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await migrate("0062_project_alpha_project_outbox.sql"); await migrate("0063_project_alpha_project_adoption.sql"); await migrate("0064_project_alpha_project_history_epoch.sql");
  await db.exec("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,active INTEGER,bound_access_subject TEXT,version INTEGER); CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER); CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER); CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER,UNIQUE(business_area_id,id)); CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT); CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT); CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT); CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT,payload BLOB); CREATE TABLE delivery_records(id TEXT PRIMARY KEY,payload BLOB); INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/s/keep',x'00ff80'); INSERT INTO delivery_records VALUES('delivery',x'ff0001');");
  await migrate("0086_native_shared_projects.sql"); await migrate("0119_project_alpha_project_v2_persistence_ledger.sql"); await migrate("0120_project_alpha_project_v2_canonical_settlement.sql"); await migrate("0121_project_alpha_project_v2_settlement_proof_expiry.sql"); await migrate("0122_project_alpha_project_v2_canonical_activation.sql");
});
afterAll(async () => runtime.dispose());

describe("unmounted project-v2 command producer", () => {
  it("pins each deliberately selected source, canonicalizes once, and inserts only pending local evidence", async () => {
    const one = await createAction("project-alpha:one"), two = await createAction("project-alpha:two");
    const publicBefore = await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares").all();
    const deliveryBefore = await db.prepare("SELECT id,hex(payload) payload FROM delivery_records").all();
    await expect(planProjectAlphaProjectV2Command(env(), one)).resolves.toMatchObject({ status: "queued", replayed: false });
    await expect(planProjectAlphaProjectV2Command(env(), two)).resolves.toMatchObject({ status: "queued", replayed: false });
    expect(await db.prepare("SELECT source_id,application_id,destination_base_url,state FROM project_alpha_project_outbox WHERE command_id=?").bind(one.command.commandId).first())
      .toEqual({ source_id: "project-alpha:one", application_id: appOne, destination_base_url: "https://one.example.test", state: "pending" });
    expect(await db.prepare("SELECT source_id,application_id,destination_base_url,state FROM project_alpha_project_outbox WHERE command_id=?").bind(two.command.commandId).first())
      .toEqual({ source_id: "project-alpha:two", application_id: appTwo, destination_base_url: "https://two.example.test", state: "pending" });
    expect(await db.prepare("SELECT count(*) n FROM native_project_command_reservations WHERE command_id IN (?,?)").bind(one.command.commandId, two.command.commandId).first("n")).toBe(2);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_request_fingerprints WHERE command_id IN (?,?)").bind(one.command.commandId, two.command.commandId).first("n")).toBe(2);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_canonical_intents WHERE command_id IN (?,?)").bind(one.command.commandId, two.command.commandId).first("n")).toBe(2);
    expect((await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares").all()).results).toEqual(publicBefore.results);
    expect((await db.prepare("SELECT id,hex(payload) payload FROM delivery_records").all()).results).toEqual(deliveryBefore.results);
  });

  it("replays byte-identical command IDs and rejects a changed canonical body", async () => {
    const action = await createAction();
    const first = await planProjectAlphaProjectV2Command(env(), action);
    const replay = await planProjectAlphaProjectV2Command(env(), action);
    expect(first).toMatchObject({ status: "queued", replayed: false }); expect(replay).toEqual({ ...(first as object), replayed: true });
    const changed = { ...action, command: { ...action.command, project: { ...action.command.project, name: "Changed" } } } as ProjectAlphaProjectV2CommandProducerAction;
    await expect(planProjectAlphaProjectV2Command(env(), changed)).resolves.toEqual({ status: "conflict", reason: "command_id" });
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first("n")).toBe(1);
  });

  it("fails closed for a revoked staff member and missing or different directory mappings", async () => {
    const revoked = await createAction();
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(revoked.actor.staffId).run();
    await expect(planProjectAlphaProjectV2Command(env(), revoked)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_outbox WHERE command_id=?").bind(revoked.command.commandId).first("n")).toBe(0);

    const missing = await createAction();
    await db.prepare("DELETE FROM project_alpha_directory_mappings WHERE external_id=? AND resource_type='client'").bind(missing.directory.clientRecordId).run();
    await expect(planProjectAlphaProjectV2Command(env(), missing)).resolves.toEqual({ status: "blocked", reason: "directory" });
    const different = await createAction();
    const wrong = { ...different, command: { ...different.command, organization: { ...different.command.organization, expectedPublicId: "f".repeat(32) } } } as ProjectAlphaProjectV2CommandProducerAction;
    await expect(planProjectAlphaProjectV2Command(env(), wrong)).resolves.toEqual({ status: "blocked", reason: "directory" });
  });

  it("keeps a disabled/outage-selected connection pending and never sends", async () => {
    const action = await createAction(), sent = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", sent);
    try {
      await expect(planProjectAlphaProjectV2Command(env(), action)).resolves.toMatchObject({ status: "queued", replayed: false });
      expect(sent).not.toHaveBeenCalled();
      expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first("state")).toBe("pending");
      expect(await db.prepare("SELECT state FROM project_alpha_project_v2_events WHERE command_id=? AND state_version=1").bind(action.command.commandId).first("state")).toBe("pending");
    } finally { vi.unstubAllGlobals(); }
  });

  it("allows bind only from a current unmapped native head and rejects unsupported operations", async () => {
    const staff = await actor(), records = await directory("project-alpha:one", sourceOne, appOne, epochOne), externalId = `ops/bind-${sequence}`;
    await db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json,canonical_projection_sha256,organization_record_id,client_record_id)
      VALUES(?,'Native','active','[]',?,?,?)`).bind(externalId, sha, records.organizationRecordId, records.clientRecordId).run();
    const bind: ProjectAlphaProjectV2CommandProducerAction = { sourceId: "project-alpha:one", actor: { ...staff, verifiedUntil: until, scopes: [] }, operation: "bind",
      local: { expectedLocalVersion: 1, expectedLocalProjectionSha256: sha }, command: { commandId: uuid(), externalId, expectedPublicId: "1".repeat(32), expectedRevision: "1", expectedProjectionSha256: sha, expectedAuthorizationGeneration: "0" } };
    await expect(planProjectAlphaProjectV2Command(env(), bind)).resolves.toMatchObject({ status: "queued", replayed: false });
    const unsupported = { ...bind, operation: "refresh" } as unknown as ProjectAlphaProjectV2CommandProducerAction;
    await expect(planProjectAlphaProjectV2Command(env(), unsupported)).resolves.toEqual({ status: "blocked", reason: "invalid_action" });
  });
});
