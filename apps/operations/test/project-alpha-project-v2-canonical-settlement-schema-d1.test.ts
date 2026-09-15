import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare;
let db: D1Database;

const commandId = "10000000-0000-4000-8000-000000000001";
const sourceInstanceId = "20000000-0000-4000-8000-000000000002";
const applicationId = "30000000-0000-4000-8000-000000000003";
const historyEpochId = "40000000-0000-4000-8000-000000000004";
const acknowledgementId = "50000000-0000-4000-8000-000000000005";
const successReceiptId = "60000000-0000-4000-8000-000000000006";
const settlementId = "70000000-0000-4000-8000-000000000007";
const readRequestId = "80000000-0000-4000-8000-000000000008";
const paRequestId = "90000000-0000-4000-8000-000000000009";
const externalProjectId = "native-project";
const projectAlphaPublicId = "a".repeat(32);
const requestSha256 = "b".repeat(64);
const projectionSha256 = "c".repeat(64);
const responseSha256 = "d".repeat(64);
const readResponseSha256 = "e".repeat(64);

async function migrate(name: string) {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

async function baseSchema() {
  await migrate("0062_project_alpha_project_outbox.sql");
  await migrate("0063_project_alpha_project_adoption.sql");
  await migrate("0064_project_alpha_project_history_epoch.sql");
  await db.batch(splitD1MigrationStatements(`
    CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,active INTEGER,bound_access_subject TEXT,version INTEGER);
    CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER);
    CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER);
    CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER,UNIQUE(business_area_id,id));
    CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT);
    CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT);
  `).map(statement => db.prepare(statement)));
  await migrate("0086_native_shared_projects.sql");
  await migrate("0119_project_alpha_project_v2_persistence_ledger.sql");
}

function createCommand() {
  return JSON.stringify({
    commandId,
    externalId: externalProjectId,
    expectedAuthorizationGeneration: "0",
    project: { name: "Native project", description: "Shared description", estimatedStart: "2026-09-20", estimatedEnd: null },
    organization: { externalId: "organization-record", expectedPublicId: "f".repeat(32), expectedRevision: "3", expectedProjectionSha256: "1".repeat(64) },
    client: null,
  });
}

async function seedAcknowledgedCommand() {
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES('staff',1,'access|staff',1)"),
    db.prepare("INSERT INTO native_staff_profiles VALUES('staff','staff@example.test',1)"),
    db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,
      destination_base_url,expected_source_instance_id,expected_history_epoch_id)
      VALUES(?,'project-alpha:primary',?,'https://alpha.example.test',?,?)`)
      .bind(externalProjectId, applicationId, sourceInstanceId, historyEpochId),
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,external_project_id,granted_by)
      VALUES('grant','staff','project.shared.sync','allow','exact_project',?,'staff')`).bind(externalProjectId),
    db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,
      actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,
      grant_generation,scopes_json) VALUES(?,?,'staff','access|staff',1,1,'staff@example.test',
      '2999-01-01T00:00:00.000Z',1,'[]')`).bind(commandId, externalProjectId),
    db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,
      source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,
      attempts,next_attempt_at,expected_history_epoch_id) VALUES(?,?,'create',?,'project-alpha:primary',?,
      'https://alpha.example.test',?,'{"actorId":"staff"}','pending',0,0,?)`)
      .bind(commandId, externalProjectId, createCommand(), applicationId, sourceInstanceId, historyEpochId),
    db.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").bind(commandId),
  ]);
  await db.batch([
    db.prepare("INSERT INTO project_alpha_project_v2_request_fingerprints(command_id,request_sha256) VALUES(?,?)")
      .bind(commandId, requestSha256),
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
      VALUES(?,1,'11000000-0000-4000-8000-000000000011',?,'pending')`).bind(commandId, requestSha256),
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
      VALUES(?,2,'12000000-0000-4000-8000-000000000012',?,'acknowledged')`).bind(commandId, requestSha256),
  ]);
  await db.prepare(`INSERT INTO project_alpha_project_v2_validated_acknowledgements(
    acknowledgement_id,command_id,acknowledged_state_version,request_sha256,source_instance_id,application_id,
    history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,projection_sha256,
    authorization_generation,pa_request_id,pa_replayed,response_sha256)
    VALUES(?,?,2,?,?,?,?,'https://alpha.example.test',?,'1',?,'1',?,0,?)`)
    .bind(acknowledgementId, commandId, requestSha256, sourceInstanceId, applicationId, historyEpochId,
      projectAlphaPublicId, projectionSha256, paRequestId, responseSha256).run();
  await db.prepare(`INSERT INTO project_alpha_project_v2_success_receipts(
    receipt_id,acknowledgement_id,command_id,request_sha256,source_instance_id,application_id,history_epoch_id,
    destination_origin,project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,
    pa_request_id,pa_replayed,response_sha256)
    VALUES(?,?,?, ?,?,?,?,'https://alpha.example.test',?,'1',?,'1',?,0,?)`)
    .bind(successReceiptId, acknowledgementId, commandId, requestSha256, sourceInstanceId, applicationId,
      historyEpochId, projectAlphaPublicId, projectionSha256, paRequestId, responseSha256).run();
}

function intent(expectedLocalVersion = 0) {
  return db.prepare(`INSERT INTO project_alpha_project_v2_canonical_intents(
    command_id,request_sha256,operation,external_project_id,expected_local_version,
    expected_local_projection_sha256,expected_grant_generation,expected_mapping_state,
    expected_project_alpha_public_id,source_id,source_instance_id,application_id,history_epoch_id)
    VALUES(?,?,'create',?,?,?,1,'absent',NULL,'project-alpha:primary',?,?,?)`)
    .bind(commandId, requestSha256, externalProjectId, expectedLocalVersion,
      expectedLocalVersion === 0 ? null : "6".repeat(64), sourceInstanceId, applicationId, historyEpochId);
}

function readJson() {
  return JSON.stringify({
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId, requestId: readRequestId,
    replayed: false, accepted: true,
    resource: { type: "project", id: projectAlphaPublicId, revision: "1", projectionSha256 },
    data: { name: "Native project", description: "Shared description", status: "not_started", archived: false,
      overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: "2026-09-20",
      estimatedEnd: null, clientPublicId: null, organizationPublicId: "f".repeat(32) },
  });
}

function settlement(overrides: { readJson?: string; projectionSha256?: string; priorLocalVersion?: number } = {}) {
  const priorLocalVersion = overrides.priorLocalVersion ?? 0;
  return db.prepare(`INSERT INTO project_alpha_project_v2_canonical_settlement_receipts(
    settlement_id,success_receipt_id,command_id,operation,external_project_id,source_id,source_instance_id,
    application_id,history_epoch_id,project_alpha_public_id,project_alpha_revision,projection_sha256,
    prior_local_version,resulting_local_version,read_request_id,read_response_sha256,read_json)
    VALUES(?,?,?,'create',?,'project-alpha:primary',?,?,?,?,'1',?,?,?,?,?,?)`)
    .bind(settlementId, successReceiptId, commandId, externalProjectId, sourceInstanceId, applicationId,
      historyEpochId, projectAlphaPublicId, overrides.projectionSha256 ?? projectionSha256, priorLocalVersion,
      priorLocalVersion + 1, readRequestId, readResponseSha256, overrides.readJson ?? readJson());
}

beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await baseSchema();
});
afterEach(async () => runtime.dispose());

describe("0120 dormant PA project v2 canonical settlement schema", () => {
  it("preserves a populated 0086 head and adds the current shared-project domain fields", async () => {
    await db.batch(splitD1MigrationStatements(`
      CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT);
      INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/secret');
      INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json)
      VALUES('existing','Existing','active','[]');
    `).map(statement => db.prepare(statement)));
    const beforeShare = await db.prepare("SELECT * FROM delivery_public_shares").all();
    await migrate("0120_project_alpha_project_v2_canonical_settlement.sql");
    expect(await db.prepare(`SELECT external_project_id,name,lifecycle,description,completed_at,archived,archived_at,canonical_projection_sha256
      FROM operations_shared_projects WHERE external_project_id='existing'`).first()).toEqual({
        external_project_id: "existing", name: "Existing", lifecycle: "active", description: null,
        completed_at: null, archived: 0, archived_at: null, canonical_projection_sha256: null,
      });
    expect((await db.prepare("SELECT * FROM delivery_public_shares").all()).results).toEqual(beforeShare.results);
    await expect(db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json,archived)
      VALUES('bad-archive','Bad','active','[]',1)`).run()).rejects.toThrow(/archive state is invalid/);
  });

  it("records exact immutable intent and inactive read evidence without canonical side effects", async () => {
    await migrate("0120_project_alpha_project_v2_canonical_settlement.sql");
    await seedAcknowledgedCommand();
    await intent().run();
    await settlement().run();
    expect(await db.prepare("SELECT settlement_state FROM project_alpha_project_v2_canonical_settlement_receipts").first("settlement_state")).toBe("inactive");
    expect(await db.prepare("SELECT count(*) FROM project_alpha_project_mappings").first("count(*)")).toBe(0);
    expect(await db.prepare("SELECT count(*) FROM operations_shared_projects").first("count(*)")).toBe(0);
    expect(await db.prepare("SELECT count(*) FROM operations_shared_project_revisions").first("count(*)")).toBe(0);
    await expect(db.prepare("UPDATE project_alpha_project_v2_canonical_intents SET expected_local_version=1").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM project_alpha_project_v2_canonical_settlement_receipts").run()).rejects.toThrow(/durable/);
  });

  it("rejects a stale local version and rechecks live native authority for settlement evidence", async () => {
    await migrate("0120_project_alpha_project_v2_canonical_settlement.sql");
    await seedAcknowledgedCommand();
    await db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json,
      canonical_projection_sha256) VALUES(?,'Native project','not_started','[]',?)`)
      .bind(externalProjectId, "6".repeat(64)).run();
    await expect(intent(0).run()).rejects.toThrow(/not current and exact/);
    await intent(1).run();
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id='staff'").run();
    await expect(settlement({ priorLocalVersion: 1 }).run()).rejects.toThrow(/not exact/);
  });

  it("rejects read evidence that differs from the exact 0119 receipt", async () => {
    await migrate("0120_project_alpha_project_v2_canonical_settlement.sql");
    await seedAcknowledgedCommand();
    await intent().run();
    const wrongRead = JSON.stringify({ ...JSON.parse(readJson()), resource: {
      type: "project", id: projectAlphaPublicId, revision: "1", projectionSha256: "9".repeat(64) } });
    await expect(settlement({ readJson: wrongRead }).run()).rejects.toThrow(/not exact/);
    await expect(settlement({ projectionSha256: "9".repeat(64) }).run()).rejects.toThrow(/not exact/);
    const extraOuterMember = JSON.stringify({ ...JSON.parse(readJson()), unexpected: true });
    await expect(settlement({ readJson: extraOuterMember }).run()).rejects.toThrow(/not exact/);
    const extraResourceMember = JSON.parse(readJson()) as Record<string, unknown>;
    extraResourceMember.resource = { ...(extraResourceMember.resource as object), unexpected: true };
    await expect(settlement({ readJson: JSON.stringify(extraResourceMember) }).run()).rejects.toThrow(/not exact/);
    const missingOptionalWithDuplicate = readJson().replace('"description":"Shared description",', '"name":"Duplicate",');
    await expect(settlement({ readJson: missingOptionalWithDuplicate }).run()).rejects.toThrow(/not exact/);
    const missingArchivedWithDuplicate = readJson().replace('"archived":false,', '"name":"Duplicate",');
    await expect(settlement({ readJson: missingArchivedWithDuplicate }).run()).rejects.toThrow(/not exact/);
    const missingOverdueWithDuplicate = readJson().replace('"overdueWarning":false,', '"name":"Duplicate",');
    await expect(settlement({ readJson: missingOverdueWithDuplicate }).run()).rejects.toThrow(/not exact/);
  });

  it("rechecks the pinned local head immediately before accepting settlement evidence", async () => {
    await migrate("0120_project_alpha_project_v2_canonical_settlement.sql");
    await seedAcknowledgedCommand();
    await intent().run();
    await db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json,
      canonical_projection_sha256) VALUES(?,'Intervening project','not_started','[]',?)`)
      .bind(externalProjectId, "7".repeat(64)).run();
    await expect(settlement().run()).rejects.toThrow(/not exact/);
  });

  it("keeps mapping, head updates, and v2 history settlement deferred", async () => {
    await migrate("0120_project_alpha_project_v2_canonical_settlement.sql");
    await seedAcknowledgedCommand();
    await intent().run();
    await settlement().run();
    await expect(db.prepare(`INSERT INTO operations_shared_project_revisions(
      external_project_id,version,pa_revision,read_json,refresh_command_id,v2_settlement_id)
      VALUES(?,1,'1',?,NULL,?)`).bind(externalProjectId, readJson(), settlementId).run())
      .rejects.toThrow(/canonical history settlement is not enabled|FOREIGN KEY|CHECK constraint/);
    expect(await db.prepare("SELECT count(*) FROM project_alpha_project_mappings").first("count(*)")).toBe(0);
    expect(await db.prepare("SELECT count(*) FROM operations_shared_projects").first("count(*)")).toBe(0);
  });
});
