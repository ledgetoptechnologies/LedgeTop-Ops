import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { settleProjectAlphaProjectV2Command } from "../src/worker/project-alpha-project-settlement-adapter";
import type { ProjectAlphaProjectCreateCommand } from "../src/worker/project-alpha-project-api-v2";

let runtime: Miniflare, db: D1Database, sequence = 0;
const uuid = () => `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", publicId = "d".repeat(32), projection = "a".repeat(64);
const connection = { baseUrl: "https://alpha.example.test", apiKey: "test-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
async function migrate(name: string) { const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"); await db.batch(splitD1MigrationStatements(sql).map(sql => db.prepare(sql))); }
function command(commandId = uuid(), externalId = `ops/project-${sequence}`): ProjectAlphaProjectCreateCommand { return { commandId, externalId, expectedAuthorizationGeneration: "0", project: { name: "Survey", description: null, estimatedStart: null, estimatedEnd: null }, organization: { externalId: "ops/org-1", expectedPublicId: "e".repeat(32), expectedRevision: "1", expectedProjectionSha256: projection }, client: null }; }
async function native(value: ProjectAlphaProjectCreateCommand) { const staff = `staff-${++sequence}`, subject = `subject-${sequence}`, email = `${staff}@example.test`;
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES(?,1,?,1)").bind(staff, subject), db.prepare("INSERT INTO native_staff_profiles VALUES(?,?,1)").bind(staff, email),
    db.prepare("INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id) VALUES(?,'project-alpha:primary',?,'https://alpha.example.test',?,?)").bind(value.externalId, application, source, epoch),
    db.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,external_project_id,granted_by) VALUES(?,?,'project.shared.sync','allow','exact_project',?,?)").bind(`grant-${staff}`, staff, value.externalId, staff),
    db.prepare("INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json) VALUES(?,?,?,?,1,1,?,'2999-01-01T00:00:00.000Z',1,'[]')").bind(value.commandId, value.externalId, staff, subject, email),
    db.prepare("INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,expected_history_epoch_id) VALUES(?,?, 'create',?,'project-alpha:primary',?,'https://alpha.example.test',?,?,'pending',0,0,?)").bind(value.commandId, value.externalId, JSON.stringify(value), application, source, JSON.stringify({ actorId: staff }), epoch),
    db.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").bind(value.commandId),
  ]);
  return staff;
}
function route() { return { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }; }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } }); }
function metadata() { return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", grantedCapabilities: ["api.capabilities.read", "projects.create"].map(name => ({ name })), implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, route()] }; }
function acknowledgement(value: ProjectAlphaProjectCreateCommand) { return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", replayed: false, result: { resource: { type: "project", id: value.externalId, publicId, revision: "1", projectionSha256: projection }, authorizationGeneration: "1", presentation: { portalPublished: false, publicLinkEnabled: false } } }; }
function sender(value: ProjectAlphaProjectCreateCommand, onPost?: () => Promise<void>) { return vi.fn<typeof fetch>(async (_url, init) => { if (init?.method === "POST") { await onPost?.(); return response(acknowledgement(value), 201); } return response(metadata()); }); }

beforeAll(async () => { runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] }); db = await runtime.getD1Database("OPS_DB") as D1Database;
  await migrate("0062_project_alpha_project_outbox.sql"); await migrate("0063_project_alpha_project_adoption.sql"); await migrate("0064_project_alpha_project_history_epoch.sql");
  await db.exec("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,active INTEGER,bound_access_subject TEXT,version INTEGER); CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER); CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER); CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER,UNIQUE(business_area_id,id)); CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT); CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT); CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT);");
  await migrate("0086_native_shared_projects.sql"); await db.exec("CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,project_id TEXT,url TEXT); INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json) VALUES('legacy-shared','Legacy','active','[]'); INSERT INTO delivery_public_shares VALUES('legacy-share','legacy-shared','https://public.example.test/secret');"); await migrate("0119_project_alpha_project_v2_persistence_ledger.sql");
});
afterAll(async () => runtime.dispose());

describe("dormant project v2 settlement adapter", () => {
  it("reserves exact request bytes before dispatch and atomically persists bounded transport provenance without legacy mutations", async () => { const value = command(); await native(value); const legacyBefore = await Promise.all([db.prepare("SELECT * FROM project_alpha_project_mappings").all(), db.prepare("SELECT * FROM operations_shared_projects WHERE external_project_id='legacy-shared'").all(), db.prepare("SELECT * FROM delivery_public_shares WHERE id='legacy-share'").all()]); let pendingAtPost = false; const send = sender(value, async () => { pendingAtPost = !!await db.prepare("SELECT 1 FROM project_alpha_project_v2_events WHERE command_id=? AND state='pending'").bind(value.commandId).first(); });
    await expect(settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, send)).resolves.toMatchObject({ status: "acknowledged", replayed: false }); expect(pendingAtPost).toBe(true);
    const stored = await db.prepare("SELECT request_sha256,response_sha256,destination_origin,pa_request_id FROM project_alpha_project_v2_validated_acknowledgements WHERE command_id=?").bind(value.commandId).first<{request_sha256:string;response_sha256:string;destination_origin:string;pa_request_id:string}>();
    expect(stored).toMatchObject({ destination_origin: connection.baseUrl, pa_request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }); expect(stored!.request_sha256).toBe(createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")); expect(stored!.response_sha256).toBe(createHash("sha256").update(JSON.stringify(acknowledgement(value)), "utf8").digest("hex"));
    expect(await db.prepare("SELECT COUNT(*) total FROM project_alpha_project_v2_success_receipts WHERE command_id=?").bind(value.commandId).first<number>("total")).toBe(1); const legacyAfter = await Promise.all([db.prepare("SELECT * FROM project_alpha_project_mappings").all(), db.prepare("SELECT * FROM operations_shared_projects WHERE external_project_id='legacy-shared'").all(), db.prepare("SELECT * FROM delivery_public_shares WHERE id='legacy-share'").all()]); expect(legacyAfter.map(result => result.results)).toEqual(legacyBefore.map(result => result.results));
  });
  it("rejects refresh before database or network activity and refuses a destination drift", async () => { const value = command(); await native(value); const send = vi.fn<typeof fetch>();
    await expect(settleProjectAlphaProjectV2Command({ OPS_DB: db }, "refresh", connection, { ...value, expectedPublicId: publicId, expectedPriorRevision: "1", expectedRevision: "2", expectedProjectionSha256: projection }, send)).resolves.toEqual({ status: "rejected", reason: "refresh_not_supported" });
    await expect(settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", { ...connection, baseUrl: "https://wrong.example.test" }, value, send)).resolves.toEqual({ status: "blocked", reason: "destination" }); expect(send).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT COUNT(*) total FROM project_alpha_project_v2_request_fingerprints WHERE command_id=?").bind(value.commandId).first<number>("total")).toBe(0);
  });
  it("rechecks live native authority after reservation and before any network request", async () => { const value = command(); const staff = await native(value); const send = vi.fn<typeof fetch>();
    const trigger = `CREATE TRIGGER settlement_test_authority_drift AFTER INSERT ON project_alpha_project_v2_request_fingerprints
      WHEN NEW.command_id='${value.commandId}' BEGIN
        UPDATE native_staff_admissions SET active=0 WHERE staff_id='${staff}';
      END;`;
    await db.batch(splitD1MigrationStatements(trigger).map(sql => db.prepare(sql)));
    try {
      await expect(settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, send)).resolves.toEqual({ status: "blocked", reason: "authority" });
      expect(send).not.toHaveBeenCalled();
      expect(await db.prepare("SELECT state FROM project_alpha_project_v2_events WHERE command_id=? ORDER BY state_version").bind(value.commandId).all()).toMatchObject({ results: [{ state: "pending" }, { state: "rejected" }] });
    } finally {
      await db.exec("DROP TRIGGER settlement_test_authority_drift");
    }
  });
  it("returns the exact settled receipt on replay without a second PA request", async () => { const value = command(); await native(value); const first = sender(value); const settled = await settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, first); const second = vi.fn<typeof fetch>();
    await expect(settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, second)).resolves.toEqual({ status: "acknowledged", receiptId: (settled as {receiptId:string}).receiptId, replayed: true }); expect(second).not.toHaveBeenCalled();
  });
  it("lets one concurrent caller win the reservation and never dispatches the loser", async () => { const value = command(); await native(value); const first = sender(value), second = sender(value); const results = await Promise.all([settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, first), settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, second)]);
    expect(results.filter(result => result.status === "acknowledged")).toHaveLength(1); expect(results.some(result => result.status === "blocked" || result.status === "uncertain")).toBe(true); expect(first.mock.calls.length + second.mock.calls.length).toBe(2);
  });
  it("fails closed for a lost acknowledgement and rolls back all success rows when live authority changes after PA responds", async () => { const lost = command(); await native(lost); const hash = createHash("sha256").update(JSON.stringify(lost), "utf8").digest("hex"); await db.batch([db.prepare("INSERT INTO project_alpha_project_v2_request_fingerprints(command_id,request_sha256) VALUES(?,?)").bind(lost.commandId,hash), db.prepare("INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state) VALUES(?,1,?,?,'pending')").bind(lost.commandId,uuid(),hash), db.prepare("INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state) VALUES(?,2,?,?,'acknowledged')").bind(lost.commandId,uuid(),hash)]);
    const noSend = vi.fn<typeof fetch>(); await expect(settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, lost, noSend)).resolves.toEqual({ status: "blocked", reason: "lost_ack" }); expect(noSend).not.toHaveBeenCalled();
    const value = command(); const staff = await native(value); const send = sender(value, async () => { await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(staff).run(); });
    await expect(settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, send)).resolves.toEqual({ status: "uncertain", reason: "database" });
    expect(await db.prepare("SELECT COUNT(*) total FROM project_alpha_project_v2_validated_acknowledgements WHERE command_id=?").bind(value.commandId).first<number>("total")).toBe(0); expect(await db.prepare("SELECT COUNT(*) total FROM project_alpha_project_v2_success_receipts WHERE command_id=?").bind(value.commandId).first<number>("total")).toBe(0);
  });
});
