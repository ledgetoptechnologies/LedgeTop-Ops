import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare;
let db: D1Database;
const sourceInstanceId = "20000000-0000-4000-8000-000000000002";
const applicationId = "30000000-0000-4000-8000-000000000003";
const historyEpochId = "40000000-0000-4000-8000-000000000004";
const reviewItemId = "50000000-0000-4000-8000-000000000005";
const reservationId = "60000000-0000-4000-8000-000000000006";
const idempotencyKey = "70000000-0000-4000-8000-000000000007";
const publicId = "a".repeat(32);
const organizationPublicId = "b".repeat(32);
const hash = "c".repeat(64);
const detailHash = "d".repeat(64);

async function migrate(name: string) {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

async function setupSchema() {
  await migrate("0062_project_alpha_project_outbox.sql");
  await migrate("0063_project_alpha_project_adoption.sql");
  await migrate("0064_project_alpha_project_history_epoch.sql");
  await db.batch(splitD1MigrationStatements(`
    CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,active INTEGER,bound_access_subject TEXT,version INTEGER,admitted_by TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER);
    CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT);
    CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER);
    CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER,UNIQUE(business_area_id,id));
    CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT);
    CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT);
    CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER,granted_by TEXT,created_at TEXT);
    CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT);
    CREATE TRIGGER native_staff_admissions_identity BEFORE UPDATE ON native_staff_admissions BEGIN SELECT 1; END;
    INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/unchanged');
  `).map(statement => db.prepare(statement)));
  await migrate("0086_native_shared_projects.sql");
  await migrate("0119_project_alpha_project_v2_persistence_ledger.sql");
  await migrate("0120_project_alpha_project_v2_canonical_settlement.sql");
  await migrate("0121_project_alpha_project_v2_settlement_proof_expiry.sql");
  await migrate("0122_project_alpha_project_v2_canonical_activation.sql");
  await migrate("0123_native_directory_authority_history.sql");
  await migrate("0124_project_alpha_project_adoption_review_evidence.sql");
}

function detailJson() {
  return JSON.stringify({
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
    requestId: "80000000-0000-4000-8000-000000000008", replayed: false, accepted: true,
    resource: { type: "project", id: publicId, revision: "7", projectionSha256: hash },
    data: { name: "Reviewed Project", description: null, status: "active", archived: false,
      overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null,
      clientPublicId: null, organizationPublicId },
  });
}

async function seedAuthority(externalProjectId = "server-generated-project") {
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES('staff',1,'access|staff',1,'staff','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z') ON CONFLICT(staff_id) DO NOTHING"),
    db.prepare("INSERT INTO native_staff_profiles VALUES('staff','staff@example.test',1) ON CONFLICT(staff_id) DO NOTHING"),
    db.prepare("INSERT INTO staff_role_assignments VALUES('owner-assignment','staff','role-owner','global') ON CONFLICT(id) DO NOTHING"),
    db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id)
      VALUES(?,'project-alpha:primary',?,'https://alpha.example.test',?,?) ON CONFLICT(external_project_id) DO NOTHING`).bind(externalProjectId, applicationId, sourceInstanceId, historyEpochId),
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,external_project_id,granted_by)
      VALUES(?, 'staff','project.shared.sync','allow','exact_project',?,'staff') ON CONFLICT DO NOTHING`).bind(`grant-${externalProjectId}`, externalProjectId),
    db.prepare("INSERT INTO operations_directory_records VALUES('organization-record','organization') ON CONFLICT(record_id) DO NOTHING"),
    db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES('project-alpha:primary',?,?,?,?,'organization-record',?)`)
      .bind(sourceInstanceId, applicationId, historyEpochId, "organization", organizationPublicId),
  ]);
}

function reviewStatement(
  itemId = reviewItemId,
  externalProjectId = "server-generated-project",
  requestHash = hash,
  detail = detailJson(),
  grantGeneration = 1,
  independentEvidenceHash = "e".repeat(64),
  expiryModifier = "+5 minutes",
) {
  return db.prepare(`INSERT INTO project_alpha_project_adoption_review_evidence(
    review_item_id,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,external_project_id,
    project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,canonical_detail_read_json,
    canonical_detail_read_sha256,organization_record_id,organization_project_alpha_public_id,client_record_id,client_project_alpha_public_id,
    reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewer_owner_role_id,independent_evidence_sha256,project_grant_generation,normalized_scopes_json,reviewed_at,expires_at)
    VALUES(?,?,'project-alpha:primary',?,?,?,? ,?,'7',?,'0',?,?, 'organization-record',?,NULL,NULL,'staff','access|staff',1,1,'role-owner',?,?,'[]',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','${expiryModifier}'))`)
    .bind(itemId, requestHash, sourceInstanceId, applicationId, historyEpochId, externalProjectId, publicId, hash, detail, detailHash, organizationPublicId, independentEvidenceHash, grantGeneration);
}

function reservationStatement(itemId = reviewItemId, key = idempotencyKey) {
  return db.prepare(`INSERT INTO project_alpha_project_adoption_review_reservations(
    reservation_id,review_item_id,idempotency_key,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,
    external_project_id,project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,canonical_detail_read_sha256,
    organization_record_id,organization_project_alpha_public_id,client_record_id,client_project_alpha_public_id,
    reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewer_owner_role_id,independent_evidence_sha256,project_grant_generation,normalized_scopes_json)
    SELECT ?,review_item_id,?,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,external_project_id,
      project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,canonical_detail_read_sha256,
      organization_record_id,organization_project_alpha_public_id,client_record_id,client_project_alpha_public_id,
      reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewer_owner_role_id,independent_evidence_sha256,project_grant_generation,normalized_scopes_json
    FROM project_alpha_project_adoption_review_evidence WHERE review_item_id=?`).bind(reservationId, key, itemId);
}

beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await setupSchema();
});
afterEach(async () => runtime.dispose());

describe("0124 project adoption review evidence", () => {
  it("pins immutable exact review evidence and consumes it once without touching delivery or shared-project state", async () => {
    await seedAuthority();
    const beforeShare = await db.prepare("SELECT * FROM delivery_public_shares").all();
    await reviewStatement().run();
    await reservationStatement().run();
    expect(await db.prepare("SELECT review_item_id,external_project_id,project_alpha_revision,authorization_generation FROM project_alpha_project_adoption_review_evidence").first())
      .toEqual({ review_item_id: reviewItemId, external_project_id: "server-generated-project", project_alpha_revision: "7", authorization_generation: "0" });
    expect(await db.prepare("SELECT review_item_id,idempotency_key FROM project_alpha_project_adoption_review_reservations").first())
      .toEqual({ review_item_id: reviewItemId, idempotency_key: idempotencyKey });
    await expect(reservationStatement().run()).rejects.toThrow();
    await expect(db.prepare("UPDATE project_alpha_project_adoption_review_evidence SET authorization_generation='1'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM project_alpha_project_adoption_review_reservations").run()).rejects.toThrow(/durable/);
    expect((await db.prepare("SELECT * FROM delivery_public_shares").all()).results).toEqual(beforeShare.results);
    expect(await db.prepare("SELECT count(*) FROM operations_shared_projects").first("count(*)")).toBe(0);
  });

  it("rejects malformed detail, identity collisions, and expired or changed current authority", async () => {
    await seedAuthority();
    const malformedDetail = JSON.stringify({ ...JSON.parse(detailJson()), resource: { type: "project", id: publicId, revision: "7", projectionSha256: "f".repeat(64) } });
    await expect(reviewStatement("51000000-0000-4000-8000-000000000005", "server-generated-project", "e".repeat(64), malformedDetail).run()).rejects.toThrow(/detail|authority/);
    await reviewStatement().run();
    await seedAuthority("second-server-project");
    await expect(reviewStatement("52000000-0000-4000-8000-000000000005", "second-server-project", hash, detailJson(), 2).run()).rejects.toThrow(/identity collision/);
    await db.prepare("UPDATE native_project_grants SET active=0,version=2 WHERE id='grant-server-generated-project'").run();
    await expect(reservationStatement().run()).rejects.toThrow(/not current and exact/);
  });

  it("rejects non-distinct evidence digests and a review window longer than four hours", async () => {
    await seedAuthority();
    await expect(reviewStatement("53000000-0000-4000-8000-000000000005", "server-generated-project", hash, detailJson(), 1, hash).run()).rejects.toThrow();
    await expect(reviewStatement("54000000-0000-4000-8000-000000000005", "server-generated-project", hash, detailJson(), 1, "e".repeat(64), "+5 hours").run()).rejects.toThrow();
  });

  it("requires the current global owner role, directory mapping, and unmodified native authority", async () => {
    await seedAuthority();
    await db.prepare("DELETE FROM staff_role_assignments WHERE id='owner-assignment'").run();
    await expect(reviewStatement().run()).rejects.toThrow(/authority/);

    await seedAuthority();
    await db.prepare("DELETE FROM project_alpha_directory_mappings").run();
    await expect(reviewStatement().run()).rejects.toThrow(/authority/);

    await seedAuthority();
    await reviewStatement().run();
    await db.prepare("UPDATE native_staff_profiles SET version=2 WHERE staff_id='staff'").run();
    await expect(reservationStatement().run()).rejects.toThrow(/not current and exact/);

    await db.prepare("UPDATE native_staff_profiles SET version=1 WHERE staff_id='staff'").run();
    await seedAuthority();
    const admissionReviewId = "56000000-0000-4000-8000-000000000005";
    await reviewStatement(admissionReviewId).run();
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id='staff'").run();
    await expect(reservationStatement(admissionReviewId).run()).rejects.toThrow(/not current and exact/);
  });

  it("requires the exact destination and rejects an existing local project head or PA mapping", async () => {
    await seedAuthority();
    await db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id)
      VALUES('wrong-destination','project-alpha:primary','90000000-0000-4000-8000-000000000009','https://alpha.example.test',?,?)`).bind(sourceInstanceId, historyEpochId).run();
    await expect(reviewStatement("55000000-0000-4000-8000-000000000005", "wrong-destination").run()).rejects.toThrow(/authority/);

    await db.exec(`
      DROP TRIGGER project_alpha_project_outbox_native_proof;
      DROP TRIGGER project_alpha_project_mapping_command_valid;
      DROP TRIGGER project_alpha_project_mapping_epoch_valid;
      DROP TRIGGER project_alpha_project_mappings_v2_settlement_guard;
    `);
    await db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,expected_history_epoch_id,state,next_attempt_at,outcome_json)
      VALUES('91000000-0000-4000-8000-000000000009','server-generated-project','bind','{"expectedRevision":"7"}','project-alpha:primary',?,'https://alpha.example.test',?,'{}',?,'acknowledged',0,'{}')`)
      .bind(applicationId, sourceInstanceId, historyEpochId).run();
    await db.prepare(`INSERT INTO project_alpha_project_mappings(external_project_id,source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id,establishment_kind,establishment_command_id)
      VALUES('server-generated-project','project-alpha:primary',?,?,?,?,'bind','91000000-0000-4000-8000-000000000009')`)
      .bind(sourceInstanceId, applicationId, historyEpochId, publicId).run();
    await expect(reviewStatement().run()).rejects.toThrow(/authority/);

    await db.prepare("INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json) VALUES('server-generated-project','Existing local project','active','[]')").run();
    await expect(reviewStatement().run()).rejects.toThrow(/authority/);
  });
});
