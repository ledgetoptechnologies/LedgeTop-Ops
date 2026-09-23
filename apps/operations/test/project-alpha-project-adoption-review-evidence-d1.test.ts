import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reserveProjectAlphaProjectAdoptionReview } from "../src/worker/project-alpha-project-adoption-review-consumer";
import { planProjectAlphaProjectAdoptionBind } from "../src/worker/project-alpha-project-adoption-bind-consumer";
import { produceProjectAlphaProjectAdoptionReview } from "../src/worker/project-alpha-project-adoption-review-producer";
import { dispatchProjectAlphaProjectV2PendingCommand } from "../src/worker/project-alpha-project-v2-pending-dispatcher";

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
const clientPublicId = "d".repeat(32);
const hash = "c".repeat(64);
const detailHash = "2beb7793e47ac43b6fc431a8860fab8fe296650bc376440a2e3b31886162cc0e";
const clientDetailHash = "b155ff100e5dba2118a2f8a490718216e5bcba05c0e1b9b4cb43af0dfd412118";
const reviewerActor = { staffId: "staff", accessSubject: "access|staff" } as const;

const reserveReview = (input: unknown, caller: unknown = reviewerActor) =>
  reserveProjectAlphaProjectAdoptionReview({ OPS_DB: db }, caller, input);
const planAdoption = (input: unknown, caller: unknown = reviewerActor, database: D1Database = db) =>
  planProjectAlphaProjectAdoptionBind({ OPS_DB: database }, caller, input);
const producerSelection = { idempotencyKey, sourceId: "project-alpha:primary",
  externalProjectId: "server-generated-project", projectAlphaPublicId: publicId } as const;
const producerRequestId = "80000000-0000-4000-8000-000000000008";
const producerConnection = () => JSON.stringify({ version: 1, instances: { "project-alpha:primary": {
  sourceId: "project-alpha:primary", enabled: true, baseUrl: "https://alpha.example.test", apiKey: "test-secret",
  sourceInstanceId, applicationId, historyEpoch: historyEpochId,
} } });
const producerEnv = (database: D1Database = db) => ({ OPS_DB: database, PROJECT_ALPHA_API_V2_CONNECTIONS: producerConnection() });

function producerJson(value: unknown, raw?: string, requestId = producerRequestId, status = 200) {
  return new Response(raw ?? JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": requestId,
  } });
}
function producerCapabilities(requestId = producerRequestId) {
  return { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
    requestId, grantedCapabilities: ["api.capabilities.read", "projects.v2.read",
      "projects.binding_status.read", "projects.inventory.read"].map(name => ({ name })), implementedEndpoints: [
      { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read",
        requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
      { method: "GET", path: "/api/v2/projects/bindings/status/{base64urlExternalId}",
        requiredCapability: "projects.binding_status.read", requiresSourceInstanceId: true,
        requiresApplicationId: true, requiresHistoryEpoch: true },
      { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read",
        requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
    ] };
}
type ProducerRemote = {
  requestId?: string;
  detail?: unknown;
  detailRaw?: string;
  binding?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
};
function producerSend(overrides: ProducerRemote = {}) {
  const requestId = overrides.requestId ?? producerRequestId;
  const detail = overrides.detail ?? { ...JSON.parse(detailJson()), requestId };
  const binding = overrides.binding ?? { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
    requestId, authorizationGeneration: "0", binding: { externalId: "server-generated-project",
      publicId, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:01.000Z" },
    resource: { revision: "7", projectionSha256: hash, status: "active", archived: false } };
  const inventory = overrides.inventory ?? { apiVersion: "2", sourceInstanceId, applicationId,
    historyEpoch: historyEpochId, requestId, authorizationGeneration: "0",
    projects: [{ externalId: "server-generated-project", publicId, revision: "7", projectionSha256: hash,
      status: "active", archived: false }], nextCursor: null };
  return vi.fn<typeof fetch>(async url => {
    const value = String(url);
    if (value.endsWith("/api/v2/capabilities")) return producerJson(producerCapabilities(requestId), undefined, requestId);
    if (value.includes("/api/v2/projects/bindings/status/")) return producerJson(binding, undefined, requestId);
    if (value.includes("/api/v2/projects/inventory?")) return producerJson(inventory, undefined, requestId);
    if (value.endsWith(`/api/v2/projects/${publicId}`)) return producerJson(detail, overrides.detailRaw, requestId);
    return new Response(null, { status: 404 });
  });
}
const produceReview = (send: typeof fetch = producerSend(), selected: unknown = producerSelection,
  caller: unknown = reviewerActor, database: D1Database = db) =>
  produceProjectAlphaProjectAdoptionReview(producerEnv(database), caller, selected, send);

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
    CREATE TABLE native_directory_resource_scopes(record_id TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,active INTEGER);
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
  await db.batch(splitD1MigrationStatements(`
    CREATE TABLE project_alpha_existing_directory_binding_activation_receipts(
      activation_id TEXT PRIMARY KEY,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,activated_at TEXT
    );
    CREATE VIEW project_alpha_active_directory_mappings AS
      SELECT source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,
        NULL AS provenance_id,'legacy' AS mapping_kind,NULL AS created_at FROM project_alpha_directory_mappings
      UNION ALL
      SELECT source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,
        activation_id AS provenance_id,'acquired' AS mapping_kind,activated_at AS created_at
        FROM project_alpha_existing_directory_binding_activation_receipts;
  `).map(statement => db.prepare(statement)));
  await migrate("0126_project_alpha_project_active_directory_mapping_bridge.sql");
  await migrate("0128_project_alpha_project_adoption_bind_bridge.sql");
  await migrate("0130_project_alpha_project_adoption_review_producer.sql");
}

function detailJson(clientId: string | null = null) {
  return JSON.stringify({
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
    requestId: "80000000-0000-4000-8000-000000000008", replayed: false, accepted: true,
    resource: { type: "project", id: publicId, revision: "7", projectionSha256: hash },
    data: { name: "Reviewed Project", description: null, status: "active", archived: false,
      overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null,
      clientPublicId: clientId, organizationPublicId },
  });
}

async function seedAuthority(externalProjectId = "server-generated-project", mappingKind: "legacy" | "acquired" = "legacy") {
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES('staff',1,'access|staff',1,'staff','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z') ON CONFLICT(staff_id) DO NOTHING"),
    db.prepare("INSERT INTO native_staff_profiles VALUES('staff','staff@example.test',1) ON CONFLICT(staff_id) DO NOTHING"),
    db.prepare("INSERT INTO staff_role_assignments VALUES('owner-assignment','staff','role-owner','global') ON CONFLICT(id) DO NOTHING"),
    db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id)
      VALUES(?,'project-alpha:primary',?,'https://alpha.example.test',?,?) ON CONFLICT(external_project_id) DO NOTHING`).bind(externalProjectId, applicationId, sourceInstanceId, historyEpochId),
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,external_project_id,granted_by)
      VALUES(?, 'staff','project.shared.sync','allow','exact_project',?,'staff') ON CONFLICT DO NOTHING`).bind(`grant-${externalProjectId}`, externalProjectId),
    db.prepare("INSERT INTO operations_directory_records VALUES('organization-record','organization') ON CONFLICT(record_id) DO NOTHING"),
    mappingKind === "legacy"
      ? db.prepare(`INSERT INTO project_alpha_directory_mappings
          SELECT 'project-alpha:primary',?,?,?,?,'organization-record',?
          WHERE NOT EXISTS (SELECT 1 FROM project_alpha_directory_mappings WHERE source_id='project-alpha:primary'
            AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type='organization'
            AND external_id='organization-record' AND project_alpha_public_id=?)`)
        .bind(sourceInstanceId, applicationId, historyEpochId, "organization", organizationPublicId,
          sourceInstanceId, applicationId, historyEpochId, organizationPublicId)
      : db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts
          VALUES('61000000-0000-4000-8000-000000000006','project-alpha:primary',?,?,?,'organization','organization-record',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(activation_id) DO NOTHING`)
        .bind(sourceInstanceId, applicationId, historyEpochId, organizationPublicId),
  ]);
}

async function seedActivatedClient(withRelationship = true) {
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records VALUES('client-record','client')"),
    db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts
      VALUES('62000000-0000-4000-8000-000000000006','project-alpha:primary',?,?,?,'client','client-record',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(sourceInstanceId, applicationId, historyEpochId, clientPublicId),
    ...(withRelationship ? [db.prepare("INSERT INTO operations_directory_client_organizations VALUES('client-record','organization-record')")] : []),
  ]);
}

async function seedScopedAuthority(scope: "business_area" | "division") {
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES('staff',1,'access|staff',1,'staff','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z')"),
    db.prepare("INSERT INTO native_staff_profiles VALUES('staff','staff@example.test',1)"),
    db.prepare("INSERT INTO staff_role_assignments VALUES('owner-assignment','staff','role-owner','global')"),
    db.prepare("INSERT INTO native_business_areas VALUES('area',1)"),
    db.prepare("INSERT INTO native_business_divisions VALUES('division','area',1)"),
    db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id)
      VALUES('server-generated-project','project-alpha:primary',?,'https://alpha.example.test',?,?)`).bind(applicationId, sourceInstanceId, historyEpochId),
    scope === "business_area"
      ? db.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,granted_by) VALUES('grant-scope','staff','project.shared.sync','allow','business_area','area','staff')")
      : db.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,division_id,granted_by) VALUES('grant-scope','staff','project.shared.sync','allow','division','area','division','staff')"),
    db.prepare("INSERT INTO operations_directory_records VALUES('organization-record','organization')"),
    db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES('project-alpha:primary',?,?,?,'organization','organization-record',?)`)
      .bind(sourceInstanceId, applicationId, historyEpochId, organizationPublicId),
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
  scopesJson = "[]",
  clientRecordId: string | null = null,
  clientProjectAlphaPublicId: string | null = null,
  canonicalDetailHash = detailHash,
) {
  return db.prepare(`INSERT INTO project_alpha_project_adoption_review_evidence(
    review_item_id,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,external_project_id,
    project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,canonical_detail_read_json,
    canonical_detail_read_sha256,organization_record_id,organization_project_alpha_public_id,client_record_id,client_project_alpha_public_id,
    reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewer_owner_role_id,independent_evidence_sha256,project_grant_generation,normalized_scopes_json,reviewed_at,expires_at)
    VALUES(?,?,'project-alpha:primary',?,?,?,? ,?,'7',?,'0',?,?, 'organization-record',?,?,?,'staff','access|staff',1,1,'role-owner',?,?,?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','${expiryModifier}'))`)
    .bind(itemId, requestHash, sourceInstanceId, applicationId, historyEpochId, externalProjectId, publicId, hash, detail, canonicalDetailHash,
      organizationPublicId, clientRecordId, clientProjectAlphaPublicId, independentEvidenceHash, grantGeneration, scopesJson);
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

async function seedReservation(expiryModifier = "+5 minutes") {
  await seedAuthority();
  await reviewStatement(reviewItemId, "server-generated-project", hash, detailJson(), 1,
    "e".repeat(64), expiryModifier).run();
  const outcome = await reserveReview({ reviewItemId, idempotencyKey });
  if (outcome.status !== "reserved") throw new Error(`reservation setup failed: ${outcome.status}`);
  return outcome.reservationId;
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

  it("accepts activated organization and client mappings only with their current relationship", async () => {
    await seedAuthority("server-generated-project", "acquired");
    await seedActivatedClient(false);
    const reviewedDetail = detailJson(clientPublicId);
    const statement = () => reviewStatement(reviewItemId, "server-generated-project", hash, reviewedDetail, 1,
      "e".repeat(64), "+5 minutes", "[]", "client-record", clientPublicId, clientDetailHash);
    await expect(statement().run()).rejects.toThrow(/authority/);
    await db.prepare("INSERT INTO operations_directory_client_organizations VALUES('client-record','organization-record')").run();
    const beforeShare = await db.prepare("SELECT * FROM delivery_public_shares").all();
    await statement().run();
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toMatchObject({ status: "reserved", replayed: false });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_directory_mappings").first("count")).toBe(0);
    expect(await db.prepare("SELECT mapping_kind FROM project_alpha_active_directory_mappings ORDER BY resource_type").all())
      .toMatchObject({ results: [{ mapping_kind: "acquired" }, { mapping_kind: "acquired" }] });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_outbox").first("count")).toBe(0);
    expect((await db.prepare("SELECT * FROM delivery_public_shares").all()).results).toEqual(beforeShare.results);
  });

  it("fails closed when an activated mapping collides with an otherwise exact legacy row", async () => {
    await seedAuthority("server-generated-project", "acquired");
    await reviewStatement().run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings
      VALUES('project-alpha:primary',?,?,?,'organization','organization-record',?)`)
      .bind(sourceInstanceId, applicationId, historyEpochId, organizationPublicId).run();
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_reservations").first("count")).toBe(0);
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

  it("invalidates reviewed authority when its business area is deactivated", async () => {
    await seedScopedAuthority("business_area");
    const scopes = JSON.stringify([{ scopeKind: "business_area", businessAreaId: "area", divisionId: null }]);
    await reviewStatement(reviewItemId, "server-generated-project", hash, detailJson(), 1, "e".repeat(64), "+5 minutes", scopes).run();
    await db.prepare("UPDATE native_business_areas SET active=0 WHERE id='area'").run();
    await expect(reservationStatement().run()).rejects.toThrow(/not current and exact/);
  });

  it("rejects inactive or parent-mismatched division scopes", async () => {
    await seedScopedAuthority("division");
    const divisionScope = JSON.stringify([{ scopeKind: "division", businessAreaId: "area", divisionId: "division" }]);
    await db.prepare("UPDATE native_business_divisions SET active=0 WHERE id='division'").run();
    await expect(reviewStatement(reviewItemId, "server-generated-project", hash, detailJson(), 1, "e".repeat(64), "+5 minutes", divisionScope).run()).rejects.toThrow(/authority/);

    await db.prepare("UPDATE native_business_divisions SET active=1 WHERE id='division'").run();
    await db.prepare("INSERT INTO native_business_areas VALUES('other-area',1)").run();
    const mismatchedScope = JSON.stringify([{ scopeKind: "division", businessAreaId: "other-area", divisionId: "division" }]);
    await expect(reviewStatement("57000000-0000-4000-8000-000000000005", "server-generated-project", hash, detailJson(), 1, "e".repeat(64), "+5 minutes", mismatchedScope).run()).rejects.toThrow(/authority/);
  });
});

describe("private project adoption review producer", () => {
  it("creates and exactly replays one short-lived review without public-state mutation", async () => {
    await seedAuthority();
    const publicBefore = await db.prepare("SELECT * FROM delivery_public_shares ORDER BY id").all();
    const first = await produceReview();
    expect(first).toMatchObject({ status: "reviewed", replayed: false });
    if (first.status !== "reviewed") throw new Error("producer setup failed");
    await expect(produceReview()).resolves.toEqual({ ...first, replayed: true });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_evidence").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_producer_receipts").first("count")).toBe(1);
    expect(await db.prepare(`SELECT source_id,external_project_id,project_alpha_public_id,reviewer_staff_id,
      reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,project_grant_generation,
      normalized_scopes_json FROM project_alpha_project_adoption_review_evidence`).first()).toEqual({
      source_id: "project-alpha:primary", external_project_id: "server-generated-project",
      project_alpha_public_id: publicId, reviewer_staff_id: "staff", reviewer_access_subject: "access|staff",
      reviewer_admission_version: 1, reviewer_profile_version: 1, project_grant_generation: 1,
      normalized_scopes_json: "[]",
    });
    expect((await db.prepare("SELECT * FROM delivery_public_shares ORDER BY id").all()).results).toEqual(publicBefore.results);
    expect(await db.prepare("SELECT count(*) count FROM operations_shared_projects").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_outbox").first("count")).toBe(0);
  });

  it("replays stable semantic evidence across fresh PA request IDs without replacing byte-exact evidence", async () => {
    await seedAuthority();
    const firstRequestId = "81000000-0000-4000-8000-000000000008";
    const secondRequestId = "82000000-0000-4000-8000-000000000008";
    const first = await produceReview(producerSend({ requestId: firstRequestId }));
    expect(first).toMatchObject({ status: "reviewed", replayed: false });
    if (first.status !== "reviewed") throw new Error("producer setup failed");
    const stored = await db.prepare(`SELECT canonical_detail_read_json,canonical_detail_read_sha256
      FROM project_alpha_project_adoption_review_evidence WHERE review_item_id=?`)
      .bind(first.reviewItemId).first<{ canonical_detail_read_json: string; canonical_detail_read_sha256: string }>();
    expect(JSON.parse(stored!.canonical_detail_read_json)).toMatchObject({ requestId: firstRequestId });

    await expect(produceReview(producerSend({ requestId: secondRequestId })))
      .resolves.toEqual({ ...first, replayed: true });
    expect(await db.prepare(`SELECT canonical_detail_read_json,canonical_detail_read_sha256
      FROM project_alpha_project_adoption_review_evidence WHERE review_item_id=?`).bind(first.reviewItemId).first())
      .toEqual(stored);
    expect(stored!.canonical_detail_read_json).not.toContain(secondRequestId);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_evidence").first("count")).toBe(1);
  });

  it("accepts only exact server selection and actor objects and stays out of the root dispatcher", async () => {
    const send = producerSend();
    await expect(produceReview(send, producerSelection, null))
      .resolves.toEqual({ status: "rejected", reason: "invalid_actor" });
    await expect(produceReview(send, producerSelection, { ...reviewerActor, profileVersion: 1 }))
      .resolves.toEqual({ status: "rejected", reason: "invalid_actor" });
    for (const selected of [null, { ...producerSelection, baseUrl: "https://browser.invalid" },
      { ...producerSelection, sourceInstanceId }, { ...producerSelection, idempotencyKey: "not-a-uuid" }]) {
      await expect(produceReview(send, selected)).resolves.toEqual({ status: "rejected", reason: "invalid_selection" });
    }
    expect(send).not.toHaveBeenCalled();
    const index = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("project-alpha-project-adoption-review-producer");
    const module = await import("../src/worker/project-alpha-project-adoption-review-producer");
    expect(Object.keys(module)).toEqual(["produceProjectAlphaProjectAdoptionReview"]);
  });

  it("binds review production to the current actor, owner role, and Project grants", async () => {
    await seedAuthority();
    await expect(produceReview(producerSend(), producerSelection,
      { staffId: "staff", accessSubject: "access|other" }))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id='staff'").run();
    await expect(produceReview()).resolves.toEqual({ status: "blocked", reason: "authority" });
    await db.prepare("UPDATE native_staff_admissions SET active=1,version=3 WHERE staff_id='staff'").run();
    await db.prepare("DELETE FROM staff_role_assignments WHERE staff_id='staff'").run();
    await expect(produceReview()).resolves.toEqual({ status: "blocked", reason: "authority" });
    await db.prepare("INSERT INTO staff_role_assignments VALUES('owner-again','staff','role-owner','global')").run();
    await db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,external_project_id,granted_by)
      VALUES('deny-project','staff','project.shared.sync','deny','exact_project','server-generated-project','staff')`).run();
    await expect(produceReview()).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_evidence").first("count")).toBe(0);
  });

  it("fails closed on remote drift and malformed or duplicate JSON", async () => {
    await seedAuthority();
    const driftedBinding = { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
      requestId: producerRequestId, authorizationGeneration: "0", binding: { externalId: "server-generated-project",
        publicId, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:01.000Z" },
      resource: { revision: "8", projectionSha256: hash, status: "active", archived: false } };
    await expect(produceReview(producerSend({ binding: driftedBinding })))
      .resolves.toEqual({ status: "blocked", reason: "remote" });
    const duplicate = detailJson().replace(`"requestId":"${producerRequestId}"`,
      `"requestId":"${producerRequestId}","requestId":"${producerRequestId}"`);
    await expect(produceReview(producerSend({ detailRaw: duplicate })))
      .resolves.toEqual({ status: "uncertain", reason: "remote" });
    const collisionInventory = { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
      requestId: producerRequestId, authorizationGeneration: "0", projects: [
        { externalId: "server-generated-project", publicId: "f".repeat(32), revision: "7",
          projectionSha256: hash, status: "active", archived: false },
      ], nextCursor: null };
    await expect(produceReview(producerSend({ inventory: collisionInventory })))
      .resolves.toEqual({ status: "blocked", reason: "remote" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_evidence").first("count")).toBe(0);
  });

  it("requires one exact active Directory mapping from the selected source", async () => {
    await seedAuthority();
    await db.prepare("DELETE FROM project_alpha_directory_mappings WHERE external_id='organization-record'").run();
    await expect(produceReview()).resolves.toEqual({ status: "blocked", reason: "directory" });
    await db.prepare(`INSERT INTO project_alpha_directory_mappings
      VALUES('project-alpha:other',?,?,?,'organization','organization-record',?)`)
      .bind(sourceInstanceId, applicationId, historyEpochId, organizationPublicId).run();
    await expect(produceReview()).resolves.toEqual({ status: "blocked", reason: "directory" });
    await db.prepare(`INSERT INTO project_alpha_directory_mappings
      VALUES('project-alpha:primary',?,?,?,'organization','organization-record',?)`)
      .bind(sourceInstanceId, applicationId, historyEpochId, organizationPublicId).run();
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts
      VALUES('63000000-0000-4000-8000-000000000006','project-alpha:primary',?,?,?,'organization','organization-record',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(sourceInstanceId, applicationId, historyEpochId, organizationPublicId).run();
    await expect(produceReview()).resolves.toEqual({ status: "blocked", reason: "directory" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_producer_receipts").first("count")).toBe(0);
  });

  it("requires the exact current organization-client relationship", async () => {
    await seedAuthority("server-generated-project", "acquired");
    await seedActivatedClient(false);
    const clientDetail = JSON.parse(detailJson(clientPublicId));
    await expect(produceReview(producerSend({ detail: clientDetail })))
      .resolves.toEqual({ status: "blocked", reason: "relationship" });
    await db.prepare("INSERT INTO operations_directory_client_organizations VALUES('client-record','organization-record')").run();
    await expect(produceReview(producerSend({ detail: clientDetail })))
      .resolves.toMatchObject({ status: "reviewed", replayed: false });
  });

  it("loads canonical live scopes and rejects later scope drift on replay", async () => {
    await seedScopedAuthority("business_area");
    await db.prepare(`INSERT INTO native_directory_resource_scopes
      VALUES('organization-record','business_area','area',NULL,1)`).run();
    const first = await produceReview();
    expect(first).toMatchObject({ status: "reviewed", replayed: false });
    expect(await db.prepare("SELECT normalized_scopes_json FROM project_alpha_project_adoption_review_evidence")
      .first("normalized_scopes_json")).toBe('[{"scopeKind":"business_area","businessAreaId":"area","divisionId":null}]');
    await db.prepare("UPDATE native_directory_resource_scopes SET active=0 WHERE record_id='organization-record'").run();
    await expect(produceReview()).resolves.toEqual({ status: "blocked", reason: "authority" });
  });

  it("atomically rejects business-area or division deactivation immediately before persistence", async () => {
    await seedAuthority();
    await db.batch([
      db.prepare("INSERT INTO native_business_areas VALUES('area',1)"),
      db.prepare("INSERT INTO native_business_divisions VALUES('division','area',1)"),
      db.prepare("INSERT INTO native_directory_resource_scopes VALUES('organization-record','business_area','area',NULL,1)"),
      db.prepare("INSERT INTO native_directory_resource_scopes VALUES('organization-record','division','area','division',1)"),
    ]);
    const racing = (statement: string) => new Proxy(db, { get(target, property) {
      if (property !== "batch") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (statements: D1PreparedStatement[]) => {
        await target.prepare(statement).run();
        return target.batch(statements);
      };
    } }) as D1Database;
    await expect(produceReview(producerSend(), producerSelection, reviewerActor,
      racing("UPDATE native_business_areas SET active=0 WHERE id='area'")))
      .resolves.toEqual({ status: "blocked", reason: "stale_evidence" });
    await db.prepare("UPDATE native_business_areas SET active=1 WHERE id='area'").run();
    await expect(produceReview(producerSend(), producerSelection, reviewerActor,
      racing("UPDATE native_business_divisions SET active=0 WHERE id='division'")))
      .resolves.toEqual({ status: "blocked", reason: "stale_evidence" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_evidence").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_producer_receipts").first("count")).toBe(0);
  });

  it("enforces idempotency conflicts and rejects expired replay evidence", async () => {
    await seedAuthority();
    const first = await produceReview();
    expect(first.status).toBe("reviewed");
    await expect(produceReview(producerSend(), { ...producerSelection, projectAlphaPublicId: "f".repeat(32) }))
      .resolves.toEqual({ status: "conflict", reason: "idempotency_key" });
    await db.exec("DROP TRIGGER project_alpha_project_adoption_review_evidence_no_update");
    await db.prepare(`UPDATE project_alpha_project_adoption_review_evidence
      SET reviewed_at='2026-09-20T00:00:00.000Z',expires_at='2026-09-20T00:01:00.000Z'`).run();
    await expect(produceReview()).resolves.toEqual({ status: "blocked", reason: "stale_evidence" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_producer_receipts").first("count")).toBe(1);
  });

  it("rolls back evidence and receipt together on a final-batch failure", async () => {
    await seedAuthority();
    const failingDb = new Proxy(db, { get(target, property) {
      if (property !== "batch") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (statements: D1PreparedStatement[]) => target.batch([...statements,
        target.prepare(`INSERT INTO project_alpha_project_adoption_review_producer_receipts(
          producer_receipt_id,idempotency_key,request_sha256,canonical_request_json,review_item_id,source_id,
          external_project_id,project_alpha_public_id,reviewer_staff_id,reviewer_access_subject)
          VALUES('not-a-uuid','not-a-uuid','bad','{}','missing','bad','bad','bad','bad','bad')`)]);
    } }) as D1Database;
    await expect(produceReview(producerSend(), producerSelection, reviewerActor, failingDb))
      .resolves.toEqual({ status: "blocked", reason: "stale_evidence" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_evidence").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_producer_receipts").first("count")).toBe(0);
  });
});

describe("project adoption review reservation consumer", () => {
  it("atomically reserves only server-owned evidence and exactly replays it without creating a bind", async () => {
    await seedAuthority();
    await reviewStatement().run();
    const beforeShare = await db.prepare("SELECT * FROM delivery_public_shares").all();
    const first = await reserveReview({ reviewItemId, idempotencyKey });
    expect(first).toMatchObject({ status: "reserved", reviewItemId, idempotencyKey, replayed: false });
    if (first.status !== "reserved") throw new Error("reservation setup failed");
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toEqual({ ...first, replayed: true });
    expect(await db.prepare(`SELECT reservation_id,review_item_id,idempotency_key,request_sha256,source_id,
      source_instance_id,application_id,history_epoch_id,external_project_id,project_alpha_public_id,
      project_alpha_revision,projection_sha256,authorization_generation,canonical_detail_read_sha256,
      reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,
      project_grant_generation,normalized_scopes_json
      FROM project_alpha_project_adoption_review_reservations`).first()).toEqual({
      reservation_id: first.reservationId, review_item_id: reviewItemId, idempotency_key: idempotencyKey,
      request_sha256: hash, source_id: "project-alpha:primary", source_instance_id: sourceInstanceId,
      application_id: applicationId, history_epoch_id: historyEpochId, external_project_id: "server-generated-project",
      project_alpha_public_id: publicId, project_alpha_revision: "7", projection_sha256: hash,
      authorization_generation: "0", canonical_detail_read_sha256: detailHash, reviewer_staff_id: "staff",
      reviewer_access_subject: "access|staff", reviewer_admission_version: 1, reviewer_profile_version: 1,
      project_grant_generation: 1, normalized_scopes_json: "[]",
    });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_outbox").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM operations_shared_projects").first("count")).toBe(0);
    expect((await db.prepare("SELECT * FROM delivery_public_shares").all()).results).toEqual(beforeShare.results);
  });

  it("accepts exactly two UUID fields and remains unmounted from the Worker", async () => {
    await seedAuthority();
    await reviewStatement().run();
    await expect(reserveReview({ reviewItemId, idempotencyKey }, null))
      .resolves.toEqual({ status: "rejected", reason: "invalid_actor" });
    await expect(reserveReview({ reviewItemId, idempotencyKey }, { ...reviewerActor, unexpected: true }))
      .resolves.toEqual({ status: "rejected", reason: "invalid_actor" });
    for (const caller of [
      { staffId: "other-staff", accessSubject: reviewerActor.accessSubject },
      { staffId: reviewerActor.staffId, accessSubject: "access|other" },
    ]) await expect(reserveReview({ reviewItemId, idempotencyKey }, caller))
      .resolves.toEqual({ status: "blocked", reason: "caller" });
    for (const invalid of [
      null,
      { reviewItemId, idempotencyKey, externalProjectId: "browser-controlled" },
      { reviewItemId: "5000000A-0000-4000-8000-000000000005", idempotencyKey },
      { reviewItemId, idempotencyKey: "not-a-uuid" },
    ]) await expect(reserveReview(invalid))
      .resolves.toEqual({ status: "rejected", reason: "invalid_action" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_reservations").first("count")).toBe(0);
    const index = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("project-alpha-project-adoption-review-consumer");
    const module = await import("../src/worker/project-alpha-project-adoption-review-consumer");
    expect(Object.keys(module)).toEqual(["reserveProjectAlphaProjectAdoptionReview"]);
  });

  it("binds the stored reviewer to the current admission", async () => {
    await seedAuthority();
    await reviewStatement().run();
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id='staff'").run();
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_reservations").first("count")).toBe(0);
  });

  it("binds the stored reviewer to the current profile", async () => {
    await seedAuthority();
    await reviewStatement().run();
    await db.prepare("UPDATE native_staff_profiles SET version=2 WHERE staff_id='staff'").run();
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_reservations").first("count")).toBe(0);
  });

  it("rejects missing or digest-invalid private evidence without a reservation", async () => {
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toEqual({ status: "blocked", reason: "missing_review" });
    await seedAuthority();
    await db.prepare(`INSERT INTO project_alpha_project_adoption_review_evidence(
      review_item_id,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,external_project_id,
      project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,canonical_detail_read_json,
      canonical_detail_read_sha256,organization_record_id,organization_project_alpha_public_id,client_record_id,client_project_alpha_public_id,
      reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewer_owner_role_id,
      independent_evidence_sha256,project_grant_generation,normalized_scopes_json,reviewed_at,expires_at)
      VALUES(?,?,'project-alpha:primary',?,?,?,'server-generated-project',?,'7',?,'0',?,?,'organization-record',?,NULL,NULL,
        'staff','access|staff',1,1,'role-owner',?,1,'[]',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'))`)
      .bind(reviewItemId, hash, sourceInstanceId, applicationId, historyEpochId, publicId, hash, detailJson(), "d".repeat(64), organizationPublicId, "e".repeat(64)).run();
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toEqual({ status: "blocked", reason: "invalid_evidence" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_reservations").first("count")).toBe(0);
  });

  it("fails closed when grant authority, directory mapping, local head, or expiry changes", async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => db.prepare("UPDATE native_project_grants SET active=0,version=2 WHERE id='grant-server-generated-project'").run(),
      () => db.prepare("DELETE FROM project_alpha_directory_mappings").run(),
      () => db.prepare("INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json) VALUES('server-generated-project','Drift','active','[]')").run(),
      async () => { await new Promise(resolve => setTimeout(resolve, 1_100)); },
    ];
    for (const [index, drift] of cases.entries()) {
      if (index > 0) {
        await runtime.dispose();
        runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
        db = await runtime.getD1Database("OPS_DB") as D1Database;
        await setupSchema();
      }
      await seedAuthority();
      await reviewStatement(reviewItemId, "server-generated-project", hash, detailJson(), 1, "e".repeat(64), index === 3 ? "+1 second" : "+5 minutes").run();
      await drift();
      await expect(reserveReview({ reviewItemId, idempotencyKey }))
        .resolves.toEqual({ status: "blocked", reason: "current_state" });
      expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_reservations").first("count")).toBe(0);
    }
  });

  it("does not turn an exact idempotent replay into stale authority", async () => {
    await seedAuthority();
    await reviewStatement().run();
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toMatchObject({ status: "reserved", replayed: false });
    await db.prepare("UPDATE native_project_grants SET active=0,version=2 WHERE id='grant-server-generated-project'").run();
    await expect(reserveReview({ reviewItemId, idempotencyKey }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_reservations").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_outbox").first("count")).toBe(0);
  });

  it("keeps review-item and idempotency-key collisions distinct and stores one winner under a race", async () => {
    await seedAuthority();
    await reviewStatement().run();
    const [left, right] = await Promise.all([
      reserveReview({ reviewItemId, idempotencyKey }),
      reserveReview({ reviewItemId, idempotencyKey }),
    ]);
    expect(left.status).toBe("reserved");
    expect(right.status).toBe("reserved");
    if (left.status !== "reserved" || right.status !== "reserved") throw new Error("race setup failed");
    expect(left.reservationId).toBe(right.reservationId);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_review_reservations").first("count")).toBe(1);

    const differentKey = "71000000-0000-4000-8000-000000000007";
    await expect(reserveReview({ reviewItemId, idempotencyKey: differentKey }))
      .resolves.toEqual({ status: "conflict", reason: "review_item" });
    const secondReview = "51000000-0000-4000-8000-000000000005";
    await reviewStatement(secondReview).run();
    await expect(reserveReview({ reviewItemId: secondReview, idempotencyKey }))
      .resolves.toEqual({ status: "conflict", reason: "idempotency_key" });
  });
});

describe("project adoption bind bridge consumer", () => {
  it("atomically creates one native head, revision, and exact pending bind plan and replays it", async () => {
    const savedReservationId = await seedReservation();
    const publicBefore = await db.prepare("SELECT * FROM delivery_public_shares ORDER BY id").all();
    const first = await planAdoption({ reservationId: savedReservationId });
    expect(first).toMatchObject({ status: "planned", reservationId: savedReservationId, replayed: false });
    if (first.status !== "planned") throw new Error("bind bridge setup failed");
    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toEqual({ ...first, replayed: true });
    expect(await db.prepare(`SELECT external_project_id,current_version,name,description,lifecycle,source_id,
      project_alpha_public_id,canonical_projection_sha256,organization_record_id,client_record_id
      FROM operations_shared_projects WHERE external_project_id='server-generated-project'`).first()).toEqual({
      external_project_id: "server-generated-project", current_version: 1, name: "Reviewed Project",
      description: null, lifecycle: "active", source_id: null, project_alpha_public_id: null,
      canonical_projection_sha256: hash, organization_record_id: "organization-record", client_record_id: null,
    });
    expect(await db.prepare("SELECT version,pa_revision,refresh_command_id,v2_settlement_id FROM operations_shared_project_revisions WHERE external_project_id='server-generated-project'").first())
      .toEqual({ version: 1, pa_revision: null, refresh_command_id: null, v2_settlement_id: null });
    expect(await db.prepare("SELECT operation,state,command_json FROM project_alpha_project_outbox WHERE command_id=?")
      .bind(first.commandId).first<{ operation: string; state: string; command_json: string }>()).toMatchObject({
      operation: "bind", state: "pending", command_json: JSON.stringify({ commandId: first.commandId,
        externalId: "server-generated-project", expectedPublicId: publicId, expectedRevision: "7",
        expectedProjectionSha256: hash, expectedAuthorizationGeneration: "0" }),
    });
    expect(await db.prepare("SELECT expected_local_version,expected_local_projection_sha256,expected_mapping_state FROM project_alpha_project_v2_canonical_intents WHERE command_id=?")
      .bind(first.commandId).first()).toEqual({ expected_local_version: 1, expected_local_projection_sha256: hash, expected_mapping_state: "absent" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_mappings").first("count")).toBe(0);
    expect((await db.prepare("SELECT * FROM delivery_public_shares ORDER BY id").all()).results).toEqual(publicBefore.results);
  });

  it("pins observed PA revision and projection so a persistence race is rejected by the pending bind", async () => {
    await seedAuthority();
    const publicBefore = await db.prepare("SELECT * FROM delivery_public_shares ORDER BY id").all();
    let liveRevision = "7", liveProjectionSha256 = hash, raced = false;
    const racingDb = new Proxy(db, { get(target, property) {
      if (property !== "batch") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (statements: D1PreparedStatement[]) => {
        liveRevision = "8";
        liveProjectionSha256 = "e".repeat(64);
        raced = true;
        return target.batch(statements);
      };
    } }) as D1Database;
    const produced = await produceReview(producerSend(), producerSelection, reviewerActor, racingDb);
    expect(produced).toMatchObject({ status: "reviewed", replayed: false });
    expect(raced).toBe(true);
    if (produced.status !== "reviewed") throw new Error("producer setup failed");
    const reserved = await reserveReview({ reviewItemId: produced.reviewItemId, idempotencyKey });
    if (reserved.status !== "reserved") throw new Error("reservation setup failed");
    const planned = await planAdoption({ reservationId: reserved.reservationId });
    expect(planned).toMatchObject({ status: "planned", replayed: false });
    if (planned.status !== "planned") throw new Error("bind plan setup failed");

    const dispatchRequestId = "83000000-0000-4000-8000-000000000008";
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== "POST") return producerJson({
        apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
        requestId: dispatchRequestId,
        grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "projects.bind" }],
        implementedEndpoints: [
          { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
          { method: "POST", path: "/api/v2/projects/bindings/commands", requiredCapability: "projects.bind",
            requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
        ],
      }, undefined, dispatchRequestId);
      const command = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(command).toMatchObject({ expectedRevision: "7", expectedProjectionSha256: hash });
      expect([command.expectedRevision, command.expectedProjectionSha256])
        .not.toEqual([liveRevision, liveProjectionSha256]);
      return producerJson({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch: historyEpochId,
        requestId: dispatchRequestId, error: { code: "resource_precondition_conflict" } },
      undefined, dispatchRequestId, 409);
    });
    await expect(dispatchProjectAlphaProjectV2PendingCommand(producerEnv(), producerSelection.sourceId,
      planned.commandId, transport)).resolves.toEqual({ status: "conflict", reason: "resource_precondition_conflict",
      httpStatus: 409, requestId: dispatchRequestId });
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?")
      .bind(planned.commandId).first("state")).toBe("terminal");
    expect((await db.prepare("SELECT state FROM project_alpha_project_v2_events WHERE command_id=? ORDER BY state_version")
      .bind(planned.commandId).all<{ state: string }>()).results.map(row => row.state)).toEqual(["pending", "conflict"]);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_mappings").first("count")).toBe(0);
    expect((await db.prepare("SELECT * FROM delivery_public_shares ORDER BY id").all()).results).toEqual(publicBefore.results);
  });

  it("accepts only one immutable reservation UUID and remains unmounted", async () => {
    await expect(planAdoption({ reservationId }, null))
      .resolves.toEqual({ status: "rejected", reason: "invalid_actor" });
    await expect(planAdoption({ reservationId }, { ...reviewerActor, unexpected: true }))
      .resolves.toEqual({ status: "rejected", reason: "invalid_actor" });
    for (const invalid of [null, {}, { reservationId: "not-a-uuid" },
      { reservationId, commandId: "browser-selected" }]) {
      await expect(planAdoption(invalid))
        .resolves.toEqual({ status: "rejected", reason: "invalid_action" });
    }
    await expect(planAdoption({ reservationId }))
      .resolves.toEqual({ status: "blocked", reason: "missing_reservation" });
    const index = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("project-alpha-project-adoption-bind-consumer");
    const module = await import("../src/worker/project-alpha-project-adoption-bind-consumer");
    expect(Object.keys(module)).toEqual(["planProjectAlphaProjectAdoptionBind"]);
  });

  it("binds first plan and replay to the current authenticated reviewer", async () => {
    const savedReservationId = await seedReservation();
    for (const caller of [
      { staffId: "other-staff", accessSubject: reviewerActor.accessSubject },
      { staffId: reviewerActor.staffId, accessSubject: "access|other" },
    ]) await expect(planAdoption({ reservationId: savedReservationId }, caller))
      .resolves.toEqual({ status: "blocked", reason: "caller" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_bind_receipts").first("count")).toBe(0);

    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toMatchObject({ status: "planned", replayed: false });
    await db.prepare("UPDATE native_staff_profiles SET version=2 WHERE staff_id='staff'").run();
    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
  });

  it("rolls back every planned row when current authority is revoked", async () => {
    const savedReservationId = await seedReservation();
    await db.prepare("UPDATE native_project_grants SET active=0,version=2 WHERE id='grant-server-generated-project'").run();
    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM operations_shared_projects").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_outbox").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_bind_receipts").first("count")).toBe(0);
  });

  it("rejects expired reservations without leaving a native head or bind plan", async () => {
    const savedReservationId = await seedReservation("+1 second");
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM operations_shared_projects").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM native_project_command_proofs").first("count")).toBe(0);
  });

  it("fails closed for missing or multiple active Directory mappings", async () => {
    const savedReservationId = await seedReservation();
    await db.prepare("DELETE FROM project_alpha_directory_mappings WHERE external_id='organization-record'").run();
    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM operations_shared_projects").first("count")).toBe(0);

    await db.prepare(`INSERT INTO project_alpha_directory_mappings
      VALUES('project-alpha:primary',?,?,?,'organization','organization-record',?)`)
      .bind(sourceInstanceId, applicationId, historyEpochId, organizationPublicId).run();
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts
      VALUES('63000000-0000-4000-8000-000000000006','project-alpha:primary',?,?,?,'organization','organization-record',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(sourceInstanceId, applicationId, historyEpochId, organizationPublicId).run();
    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_outbox").first("count")).toBe(0);
  });

  it("requires the reviewed organization-client relationship at bridge time", async () => {
    await seedAuthority("server-generated-project", "acquired");
    await seedActivatedClient(true);
    await reviewStatement(reviewItemId, "server-generated-project", hash, detailJson(clientPublicId), 1,
      "e".repeat(64), "+5 minutes", "[]", "client-record", clientPublicId, clientDetailHash).run();
    const reserved = await reserveReview({ reviewItemId, idempotencyKey });
    if (reserved.status !== "reserved") throw new Error("reservation setup failed");
    await db.prepare("DELETE FROM operations_directory_client_organizations WHERE client_record_id='client-record'").run();
    await expect(planAdoption({ reservationId: reserved.reservationId }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_bind_receipts").first("count")).toBe(0);
  });

  it("rejects stale local revisions and one-to-one identity collisions", async () => {
    const savedReservationId = await seedReservation();
    await db.prepare(`INSERT INTO operations_shared_projects(external_project_id,current_version,name,lifecycle,
      organization_record_id,scopes_json,canonical_projection_sha256)
      VALUES('server-generated-project',2,'Stale local head','active','organization-record','[]',?)`).bind(hash).run();
    await db.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES('server-generated-project',2,'{}')`).run();
    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_outbox").first("count")).toBe(0);
  });

  it("rejects a PA Project identity already pinned to another local project", async () => {
    const savedReservationId = await seedReservation();
    await db.exec(`
      DROP TRIGGER project_alpha_project_outbox_native_proof;
      DROP TRIGGER project_alpha_project_mapping_command_valid;
      DROP TRIGGER project_alpha_project_mapping_epoch_valid;
      DROP TRIGGER project_alpha_project_mappings_v2_settlement_guard;
    `);
    await db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,
      source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,
      expected_history_epoch_id,state,next_attempt_at,outcome_json)
      VALUES('91000000-0000-4000-8000-000000000009','server-generated-project','bind','{"expectedRevision":"7"}',
        'project-alpha:primary',?,'https://alpha.example.test',?,'{}',?,'acknowledged',0,'{}')`)
      .bind(applicationId, sourceInstanceId, historyEpochId).run();
    await db.prepare(`INSERT INTO project_alpha_project_mappings(external_project_id,source_id,source_instance_id,
      application_id,history_epoch_id,project_alpha_public_id,establishment_kind,establishment_command_id)
      VALUES('server-generated-project','project-alpha:primary',?,?,?,?,'bind','91000000-0000-4000-8000-000000000009')`)
      .bind(sourceInstanceId, applicationId, historyEpochId, publicId).run();
    await expect(planAdoption({ reservationId: savedReservationId }))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM operations_shared_projects").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_bind_receipts").first("count")).toBe(0);
  });

  it("rolls back earlier writes when the final atomic batch statement fails", async () => {
    const savedReservationId = await seedReservation();
    const failingDb = new Proxy(db, { get(target, property) {
      if (property !== "withSession") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return () => new Proxy(target.withSession("first-primary"), { get(session, sessionProperty) {
        if (sessionProperty !== "batch") {
          const value = Reflect.get(session, sessionProperty, session);
          return typeof value === "function" ? value.bind(session) : value;
        }
        return (statements: D1PreparedStatement[]) => session.batch([...statements,
          session.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json)
            VALUES('server-generated-project','forced duplicate','active','[]')`)]);
      } });
    } }) as D1Database;
    await expect(planAdoption({ reservationId: savedReservationId }, reviewerActor, failingDb))
      .resolves.toEqual({ status: "blocked", reason: "current_state" });
    expect(await db.prepare("SELECT count(*) count FROM operations_shared_projects").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM native_project_command_proofs").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_outbox").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_adoption_bind_receipts").first("count")).toBe(0);
  });
});
