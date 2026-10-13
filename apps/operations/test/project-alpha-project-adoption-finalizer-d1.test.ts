import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { produceProjectAlphaProjectAdoptionReview } from "../src/worker/project-alpha-project-adoption-review-producer";
import { reserveProjectAlphaProjectAdoptionReview } from "../src/worker/project-alpha-project-adoption-review-consumer";
import { planProjectAlphaProjectAdoptionBind } from "../src/worker/project-alpha-project-adoption-bind-consumer";
import { finalizeProjectAlphaProjectAdoption } from "../src/worker/project-alpha-project-adoption-finalizer";
import { readConfiguredProjectAlphaProjectInventory } from "../src/worker/project-alpha-project-inventory-api-v2";

let runtime: Miniflare;
let db: D1Database;

const sourceId = "project-alpha:primary";
const sourceInstanceId = "20000000-0000-4000-8000-000000000002";
const applicationId = "30000000-0000-4000-8000-000000000003";
const historyEpoch = "40000000-0000-4000-8000-000000000004";
const producerIdempotencyKey = "50000000-0000-4000-8000-000000000005";
const reservationIdempotencyKey = "60000000-0000-4000-8000-000000000006";
const requestId = "70000000-0000-4000-8000-000000000007";
const publicId = "a".repeat(32);
const organizationPublicId = "b".repeat(32);
const projectionSha256 = "c".repeat(64);
const externalProjectId = "finalizer-real-d1-project";
const staffId = "finalizer-real-d1-owner";
const accessSubject = "access|finalizer-real-d1-owner";
const email = "finalizer-owner@example.test";
const businessAreaId = "finalizer-real-d1-area";
const organizationRecordId = "finalizer-real-d1-organization";
const future = "2999-01-01T00:00:00.000Z";
type ProjectFixture = Readonly<{ externalProjectId: string; publicId: string; projectionSha256: string;
  producerKey: string; reservationKey: string; name: string }>;
type RemoteState = { bound: boolean };
const primaryProject: ProjectFixture = { externalProjectId, publicId, projectionSha256,
  producerKey: producerIdempotencyKey, reservationKey: reservationIdempotencyKey, name: "Reviewed Project" };
const retryProject: ProjectFixture = { externalProjectId: "finalizer-real-d1-retry-project", publicId: "d".repeat(32),
  projectionSha256: "e".repeat(64), producerKey: "90000000-0000-4000-8000-000000000009",
  reservationKey: "a0000000-0000-4000-8000-00000000000a", name: "Reviewed Retry Project" };

const connections = JSON.stringify({ version: 1, instances: {
  [sourceId]: { sourceId, enabled: true, baseUrl: "https://alpha.example.test", apiKey: "synthetic-private-key",
    sourceInstanceId, applicationId, historyEpoch },
} });
const env = () => ({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connections,
  PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED: "true" });
const actor = { staffId, accessSubject, email, admissionVersion: 1, profileVersion: 1, verifiedUntil: future };

function response(value: unknown, status = 200, raw?: string): Response {
  return new Response(raw ?? JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": requestId,
  } });
}

function detail(project: ProjectFixture) {
  return { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId, replayed: false, accepted: true,
    resource: { type: "project", id: project.publicId, revision: "7", projectionSha256: project.projectionSha256 },
    data: { name: project.name, description: null, status: "active", archived: false,
      overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null,
      clientPublicId: null, organizationPublicId } };
}

function producerTransport(project: ProjectFixture, state: RemoteState = { bound: false }) {
  const capabilities = { apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    grantedCapabilities: ["api.capabilities.read", "projects.v2.read", "projects.binding_status.read",
      "projects.inventory.read", "projects.adoption_candidates.read"].map(name => ({ name })),
    implementedEndpoints: [
      { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read",
        requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
      { method: "GET", path: "/api/v2/projects/bindings/status/{base64urlExternalId}",
        requiredCapability: "projects.binding_status.read", requiresSourceInstanceId: true,
        requiresApplicationId: true, requiresHistoryEpoch: true },
      { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read",
        requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
      { method: "GET", path: "/api/v2/projects/adoption-candidates",
        requiredCapability: "projects.adoption_candidates.read", requiresSourceInstanceId: true,
        requiresApplicationId: true, requiresHistoryEpoch: true },
    ] };
  return vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.endsWith("/api/v2/capabilities")) return response(capabilities);
    if (url.includes("/api/v2/projects/bindings/status/")) return state.bound
      ? response({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
        authorizationGeneration: "1", binding: { externalId: project.externalProjectId,
          publicId: project.publicId, createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:01.000Z" },
        resource: { revision: "7", projectionSha256: project.projectionSha256, status: "active", archived: false } })
      : response(null, 404, "");
    if (url.includes("/api/v2/projects/inventory?")) return response({ apiVersion: "2", sourceInstanceId,
      applicationId, historyEpoch, requestId, authorizationGeneration: state.bound ? "1" : "0",
      projects: state.bound ? [{ externalId: project.externalProjectId, publicId: project.publicId, revision: "7",
        projectionSha256: project.projectionSha256, status: "active", archived: false }] : [], nextCursor: null });
    if (url.includes("/api/v2/projects/adoption-candidates?")) return response({ apiVersion: "2", sourceInstanceId,
      applicationId, historyEpoch, requestId, authorizationGeneration: "0", projects: [{ publicId: project.publicId,
        revision: "7", projectionSha256: project.projectionSha256, name: project.name, status: "active", archived: false,
        organizationPublicId, clientPublicId: null }], nextCursor: null });
    if (url.endsWith(`/api/v2/projects/${project.publicId}`)) return response(detail(project));
    return new Response(null, { status: 404 });
  });
}

function finalizerTransport(project: ProjectFixture, state: RemoteState, failRead = false) {
  const commandRoute = { method: "POST", path: "/api/v2/projects/bindings/commands",
    requiredCapability: "projects.bind", requiresSourceInstanceId: true,
    requiresApplicationId: true, requiresHistoryEpoch: true };
  const readRoute = { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read",
    requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
  const inventoryRoute = { method: "GET", path: "/api/v2/projects/inventory",
    requiredCapability: "projects.inventory.read", requiresSourceInstanceId: true,
    requiresApplicationId: true, requiresHistoryEpoch: true };
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/capabilities")) {
      return response({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
        grantedCapabilities: ["api.capabilities.read", "projects.bind", "projects.v2.read", "projects.inventory.read"]
          .map(name => ({ name })),
        implementedEndpoints: [
          { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
          commandRoute, readRoute, inventoryRoute,
        ] });
    }
    if (init?.method === "POST") {
      state.bound = true;
      return response({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch,
        requestId, replayed: false, result: { resource: { type: "project", id: project.externalProjectId,
          publicId: project.publicId, revision: "7", projectionSha256: project.projectionSha256 }, authorizationGeneration: "1",
        presentation: { portalPublished: false, publicLinkEnabled: false } } }, 200);
    }
    if (url.includes("/api/v2/projects/inventory?")) return response({ apiVersion: "2", sourceInstanceId,
      applicationId, historyEpoch, requestId, authorizationGeneration: state.bound ? "1" : "0",
      projects: state.bound ? [{ externalId: project.externalProjectId, publicId: project.publicId, revision: "7",
        projectionSha256: project.projectionSha256, status: "active", archived: false }] : [], nextCursor: null });
    if (url.endsWith(`/api/v2/projects/${project.publicId}`))
      return failRead ? response({ error: "synthetic read failure" }, 500) : response(detail(project));
    return new Response(null, { status: 404 });
  });
}

async function protectedRows(): Promise<Record<string, string>> {
  const names = ["client_portal_access_authority_outbox", "client_portal_workspace_binding_outbox",
    "client_portal_authority_v2_outbox", "client_portal_recipient_enrollment_operations",
    "operations_portal_workspace_publication_outbox", "operations_portal_native_authority_outbox",
    "pa_connector_portal_coordination", "viewer_workspace_client_grant_rate_limits"];
  return Object.fromEntries(await Promise.all(names.map(async name => [name,
    JSON.stringify((await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results)] as const)));
}

async function plannedAdoption(project: ProjectFixture) {
  const remote: RemoteState = { bound: false };
  await db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,
    destination_base_url,expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,'https://alpha.example.test',?,?)`)
    .bind(project.externalProjectId, sourceId, applicationId, sourceInstanceId, historyEpoch).run();
  const reviewed = await produceProjectAlphaProjectAdoptionReview(env(), { staffId, accessSubject }, {
    idempotencyKey: project.producerKey, sourceId, externalProjectId: project.externalProjectId,
    projectAlphaPublicId: project.publicId,
  }, producerTransport(project, remote));
  if (reviewed.status !== "reviewed") throw new Error(`review setup failed: ${reviewed.status}`);
  const reserved = await reserveProjectAlphaProjectAdoptionReview({ OPS_DB: db }, { staffId, accessSubject }, {
    reviewItemId: reviewed.reviewItemId, idempotencyKey: project.reservationKey,
  });
  if (reserved.status !== "reserved") throw new Error(`reservation setup failed: ${reserved.status}`);
  const planned = await planProjectAlphaProjectAdoptionBind({ OPS_DB: db }, { staffId, accessSubject }, {
    reservationId: reserved.reservationId,
  });
  if (planned.status !== "planned") throw new Error(`bind setup failed: ${planned.status}`);
  return { reviewed, reserved, planned, remote };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter(value => /^\d{4}_.+\.sql$/.test(value)).sort()) {
    const sql = readFileSync(new URL(name, directory), "utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    // Seed immutable native identity and Directory state after their canonical
    // schemas exist but before 0058 closes direct writes behind command-proof
    // triggers. Later migrations must preserve and upgrade this exact fixture.
    if (name === "0057_native_directory_permissions.sql") await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name) VALUES(?,?,?)")
        .bind(staffId, email, "Finalizer Owner"),
      db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
        VALUES(?,?,1,?)`).bind(staffId, accessSubject, staffId),
      db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by)
        VALUES(?,?,'role-owner','global','global',?)`).bind("finalizer-owner-assignment", staffId, staffId),
      db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)")
        .bind(businessAreaId, "Finalizer Area"),
      db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)")
        .bind(organizationRecordId),
      db.prepare(`INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,active)
        VALUES(?,'business_area',?,1)`).bind(organizationRecordId, businessAreaId),
    ]);
    if (name === "0059_native_staff_profiles.sql") await db.prepare(`INSERT INTO native_staff_profiles(
      staff_id,login_email,display_name) VALUES(?,?,?)`).bind(staffId, email, "Finalizer Owner").run();
    if (name === "0065_project_alpha_directory_history_epoch.sql") {
      const directoryCommandId = "80000000-0000-4000-8000-000000000008";
      await db.batch([
        db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,
          external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,
          attempts,next_attempt_at,lease_token,lease_expires_at,expected_history_epoch_id)
          VALUES(?,?,?,'organization',?,'{}','https://alpha.example.test',?,'{}','leased',1,0,'fixture-lease',4102444800,?)`)
          .bind(directoryCommandId, sourceId, applicationId, organizationRecordId, sourceInstanceId, historyEpoch),
        db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,source_instance_id,application_id,
          history_epoch_id,resource_type,external_id,project_alpha_public_id,command_id)
          VALUES(?,?,?,?,'organization',?,?,?)`).bind(sourceId, sourceInstanceId, applicationId, historyEpoch,
            organizationRecordId, organizationPublicId, directoryCommandId),
        db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',lease_token=NULL,
          lease_expires_at=NULL,outcome_json='{"status":"acknowledged"}' WHERE command_id=?`)
          .bind(directoryCommandId),
      ]);
    }
  }
}, 120_000);

afterAll(async () => { await runtime?.dispose(); });

it("runs the reviewed adoption through the real v2 ledgers and blocks a drifted activated replay", async () => {
  await db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,granted_by)
    VALUES(?,?,'project.shared.sync','allow','business_area',?,?)`)
    .bind("finalizer-project-grant", staffId, businessAreaId, staffId).run();

  const { reviewed, reserved, planned, remote } = await plannedAdoption(primaryProject);
  expect(reviewed).toMatchObject({ status: "reviewed", replayed: false });
  expect(reserved).toMatchObject({ status: "reserved", replayed: false });
  expect(planned).toMatchObject({ status: "planned", replayed: false });

  const protectedBefore = await protectedRows();
  const send = finalizerTransport(primaryProject, remote);
  await expect(readConfiguredProjectAlphaProjectInventory(env(), sourceId, { limit: 200 }, send))
    .resolves.toMatchObject({ status: "observed", response: {
      authorizationGeneration: "0", projects: [], nextCursor: null,
    } });
  send.mockClear();
  await db.prepare("UPDATE native_business_areas SET active=0 WHERE id=?").bind(businessAreaId).run();
  const driftedBeforeDispatch = vi.fn<typeof fetch>();
  await expect(finalizeProjectAlphaProjectAdoption(env(), actor, {
    reservationId: reserved.reservationId, commandId: planned.commandId,
  }, driftedBeforeDispatch)).resolves.toEqual({
    stage: "preflight", outcome: { status: "blocked", reason: "authority" },
  });
  expect(driftedBeforeDispatch).not.toHaveBeenCalled();
  await db.prepare("UPDATE native_business_areas SET active=1 WHERE id=?").bind(businessAreaId).run();

  await expect(finalizeProjectAlphaProjectAdoption(env(), actor, {
    reservationId: reserved.reservationId, commandId: planned.commandId,
  }, send)).resolves.toMatchObject({ stage: "activate", outcome: { status: "activated", replayed: false,
    commandId: planned.commandId, externalProjectId, version: 2 } });
  expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(send.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(3);
  expect(await protectedRows()).toEqual(protectedBefore);
  expect(await db.prepare(`SELECT source_id,source_instance_id,application_id,history_epoch_id,
      project_alpha_public_id,current_version,name FROM operations_shared_projects WHERE external_project_id=?`)
    .bind(externalProjectId).first()).toEqual({ source_id: sourceId, source_instance_id: sourceInstanceId,
      application_id: applicationId, history_epoch_id: historyEpoch, project_alpha_public_id: publicId,
      current_version: 2, name: "Reviewed Project" });
  expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_v2_canonical_activation_receipts WHERE command_id=?")
    .bind(planned.commandId).first("count")).toBe(1);
  expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_mappings WHERE external_project_id=?")
    .bind(externalProjectId).first("count")).toBe(1);
  const inventory = await db.prepare(`SELECT project.external_project_id,project.name,project.current_version,
      project.project_alpha_public_id,mapping.project_alpha_public_id mapping_public_id,revision.read_json
    FROM operations_shared_projects project
    JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=project.external_project_id
      AND mapping.source_id=project.source_id AND mapping.source_instance_id=project.source_instance_id
      AND mapping.application_id=project.application_id AND mapping.history_epoch_id=project.history_epoch_id
    JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
      AND revision.version=project.current_version
    WHERE project.external_project_id=?`).bind(externalProjectId).all<{
      external_project_id: string; name: string; current_version: number; project_alpha_public_id: string;
      mapping_public_id: string; read_json: string;
    }>();
  expect(inventory.results).toHaveLength(1);
  expect(inventory.results[0]).toMatchObject({ external_project_id: externalProjectId, name: "Reviewed Project",
    current_version: 2, project_alpha_public_id: publicId, mapping_public_id: publicId });
  expect(JSON.parse(inventory.results[0]!.read_json)).toMatchObject({
    resource: { id: publicId, revision: "7", projectionSha256 }, data: { name: "Reviewed Project" },
  });
  const normalInventory = await readConfiguredProjectAlphaProjectInventory(env(), sourceId, { limit: 200 }, send);
  expect(normalInventory).toEqual({ status: "observed", httpStatus: 200, response: {
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId, authorizationGeneration: "1",
    projects: [{ externalId: externalProjectId, publicId, revision: "7", projectionSha256,
      status: "active", archived: false }],
    nextCursor: null,
  } });
  const duplicateCandidateTransport = producerTransport(primaryProject, remote);
  await expect(produceProjectAlphaProjectAdoptionReview(env(), { staffId, accessSubject }, {
    idempotencyKey: "b0000000-0000-4000-8000-00000000000b", sourceId,
    externalProjectId, projectAlphaPublicId: publicId,
  }, duplicateCandidateTransport)).resolves.toEqual({ status: "blocked", reason: "local_state" });
  expect(duplicateCandidateTransport).not.toHaveBeenCalled();

  const replayTransport = vi.fn<typeof fetch>();
  await expect(finalizeProjectAlphaProjectAdoption(env(), actor, {
    reservationId: reserved.reservationId, commandId: planned.commandId,
  }, replayTransport)).resolves.toMatchObject({ stage: "activate", outcome: { status: "activated", replayed: true,
    commandId: planned.commandId, externalProjectId, version: 2 } });
  expect(replayTransport).not.toHaveBeenCalled();
  expect(await protectedRows()).toEqual(protectedBefore);
  expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_mappings WHERE external_project_id=?")
    .bind(externalProjectId).first("count")).toBe(1);

  await db.prepare("UPDATE native_business_areas SET active=0 WHERE id=?").bind(businessAreaId).run();
  const noNetwork = vi.fn<typeof fetch>();
  await expect(finalizeProjectAlphaProjectAdoption(env(), actor, {
    reservationId: reserved.reservationId, commandId: planned.commandId,
  }, noNetwork)).resolves.toEqual({ stage: "preflight", outcome: { status: "blocked", reason: "authority" } });
  expect(noNetwork).not.toHaveBeenCalled();
});

it("retries settlement after a persisted acknowledgement without another command POST", async () => {
  await db.prepare("UPDATE native_business_areas SET active=1 WHERE id=?").bind(businessAreaId).run();
  const { reserved, planned, remote } = await plannedAdoption(retryProject);
  const protectedBefore = await protectedRows();
  const failingRead = finalizerTransport(retryProject, remote, true);
  const first = await finalizeProjectAlphaProjectAdoption(env(), actor, {
    reservationId: reserved.reservationId, commandId: planned.commandId,
  }, failingRead);
  expect(first.stage).toBe("settle");
  expect(first.outcome.status).not.toBe("settled");
  expect(failingRead.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_v2_success_receipts WHERE command_id=?")
    .bind(planned.commandId).first("count")).toBe(1);
  expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?")
    .bind(planned.commandId).first("state")).toBe("pending");
  expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_v2_canonical_activation_receipts WHERE command_id=?")
    .bind(planned.commandId).first("count")).toBe(0);

  const retry = finalizerTransport(retryProject, remote);
  await expect(finalizeProjectAlphaProjectAdoption(env(), actor, {
    reservationId: reserved.reservationId, commandId: planned.commandId,
  }, retry)).resolves.toMatchObject({ stage: "activate", outcome: { status: "activated", replayed: false,
    commandId: planned.commandId, externalProjectId: retryProject.externalProjectId, version: 2 } });
  expect(retry.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  expect(retry.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  expect(await protectedRows()).toEqual(protectedBefore);
  expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_v2_success_receipts WHERE command_id=?")
    .bind(planned.commandId).first("count")).toBe(1);
  expect(await db.prepare("SELECT count(*) count FROM project_alpha_project_v2_canonical_activation_receipts WHERE command_id=?")
    .bind(planned.commandId).first("count")).toBe(1);
});
