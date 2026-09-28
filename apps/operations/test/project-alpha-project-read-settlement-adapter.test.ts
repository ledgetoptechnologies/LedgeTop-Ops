import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { settleProjectAlphaProjectV2Command } from "../src/worker/project-alpha-project-settlement-adapter";
import { settleProjectAlphaProjectV2Read } from "../src/worker/project-alpha-project-read-settlement-adapter";
import { activateProjectAlphaProjectV2Canonical } from "../src/worker/project-alpha-project-canonical-activation-adapter";
import type { ProjectAlphaProjectBindCommand, ProjectAlphaProjectCreateCommand, ProjectAlphaProjectUpdateCommand } from "../src/worker/project-alpha-project-api-v2";

let runtime: Miniflare, db: D1Database, sequence = 0;
const uuid = () => `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const publicId = "d".repeat(32), projection = "a".repeat(64), organization = "e".repeat(32);
const connection = { baseUrl: "https://alpha.example.test", apiKey: "test-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };

async function migrate(name: string) {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}
function command(): ProjectAlphaProjectCreateCommand {
  return { commandId: uuid(), externalId: `ops/project-${sequence}`, expectedAuthorizationGeneration: "0", project: {
    name: "Survey", description: null, estimatedStart: null, estimatedEnd: null,
  }, organization: { externalId: "ops/org-1", expectedPublicId: organization, expectedRevision: "1", expectedProjectionSha256: projection }, client: null };
}
async function native(value: ProjectAlphaProjectCreateCommand, verifiedUntil = "2999-01-01T00:00:00.000Z") {
  const staff = `staff-${++sequence}`, subject = `subject-${sequence}`, email = `${staff}@example.test`;
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES(?,1,?,1)").bind(staff, subject),
    db.prepare("INSERT INTO native_staff_profiles VALUES(?,?,1)").bind(staff, email),
    db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id)
      VALUES(?,'project-alpha:primary',?,'https://alpha.example.test',?,?)`).bind(value.externalId, application, source, epoch),
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,external_project_id,granted_by)
      VALUES(?,?,'project.shared.sync','allow','exact_project',?,?)`).bind(`grant-${staff}`, staff, value.externalId, staff),
    db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
      VALUES(?,?,?,?,1,1,?,?,1,'[]')`).bind(value.commandId, value.externalId, staff, subject, email, verifiedUntil),
    db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,expected_history_epoch_id)
      VALUES(?,?,'create',?,'project-alpha:primary',?,'https://alpha.example.test',?,?,'pending',0,0,?)`).bind(value.commandId, value.externalId, JSON.stringify(value), application, source, JSON.stringify({ actorId: staff }), epoch),
    db.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").bind(value.commandId),
  ]);
  return staff;
}
const commandRoute = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
const readRoute = { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
function metadata(route: { method: string; path: string; requiredCapability: string; requiresSourceInstanceId: boolean; requiresApplicationId: boolean; requiresHistoryEpoch: boolean }) {
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", grantedCapabilities: ["api.capabilities.read", route.requiredCapability].map(name => ({ name })), implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, route] };
}
function json(value: unknown, status = 200, raw?: string) {
  return new Response(raw ?? JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } });
}
function acknowledgement(value: ProjectAlphaProjectCreateCommand) {
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", replayed: false, result: { resource: { type: "project", id: value.externalId, publicId, revision: "1", projectionSha256: projection }, authorizationGeneration: "1", presentation: { portalPublished: false, publicLinkEnabled: false } } };
}
function readBody(overrides: Record<string, unknown> = {}) {
  const base = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", replayed: false, accepted: true,
    resource: { type: "project", id: publicId, revision: "1", projectionSha256: projection }, data: { name: "Survey", description: null, status: "active", archived: false, overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null, clientPublicId: null, organizationPublicId: organization } };
  return { ...base, ...overrides };
}
async function acknowledged(verifiedUntil?: string) {
  const value = command(), staff = await native(value, verifiedUntil);
  const post = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST" ? json(acknowledgement(value), 201) : json(metadata(commandRoute)));
  const outcome = await settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, post);
  if (outcome.status !== "acknowledged") throw new Error(`setup failed: ${JSON.stringify(outcome)}`);
  return { value, staff, receiptId: outcome.receiptId };
}
async function waitUntil(instant: string) {
  const remaining = new Date(instant).valueOf() - Date.now();
  if (remaining >= 0) await new Promise(resolve => setTimeout(resolve, remaining + 25));
}
function reader(body: unknown, raw?: string, duringRead?: () => Promise<void>) {
  return vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith("/api/v2/capabilities")) return json(metadata(readRoute));
    await duringRead?.(); return json(body, 200, raw);
  });
}
async function snapshots() {
  const queries = {
    delivery_public_shares: "SELECT id,url,hex(payload) payload_hex FROM delivery_public_shares ORDER BY rowid",
    delivery_records: "SELECT id,hex(payload) payload_hex FROM delivery_records ORDER BY rowid",
    project_alpha_project_mappings: "SELECT * FROM project_alpha_project_mappings ORDER BY rowid",
    operations_shared_projects: "SELECT * FROM operations_shared_projects ORDER BY rowid",
    operations_shared_project_revisions: "SELECT * FROM operations_shared_project_revisions ORDER BY rowid",
  };
  return Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([table, sql]) => [table, JSON.stringify((await db.prepare(sql).all()).results)])));
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await migrate("0062_project_alpha_project_outbox.sql"); await migrate("0063_project_alpha_project_adoption.sql"); await migrate("0064_project_alpha_project_history_epoch.sql");
  await db.exec("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,active INTEGER,bound_access_subject TEXT,version INTEGER); CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER); CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER); CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER,UNIQUE(business_area_id,id)); CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT); CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT); CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT);");
  await migrate("0086_native_shared_projects.sql");
  await db.exec("CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT,payload BLOB); CREATE TABLE delivery_records(id TEXT PRIMARY KEY,payload BLOB); INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/secret',x'000102ff'); INSERT INTO delivery_records VALUES('delivery',x'00ff8041'); INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json) VALUES('sentinel','Sentinel','active','[]'); INSERT INTO operations_shared_project_revisions(external_project_id,version,pa_revision,read_json,refresh_command_id) VALUES('sentinel',1,NULL,'{\"sentinel\":true}',NULL);");
  await migrate("0119_project_alpha_project_v2_persistence_ledger.sql"); await migrate("0120_project_alpha_project_v2_canonical_settlement.sql");
  await migrate("0121_project_alpha_project_v2_settlement_proof_expiry.sql");
  await migrate("0122_project_alpha_project_v2_canonical_activation.sql");
  await db.batch(splitD1MigrationStatements(`CREATE TABLE project_alpha_existing_directory_binding_activation_receipts(
    activation_id TEXT PRIMARY KEY,source_id TEXT,source_instance_id TEXT,application_id TEXT,
    history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,activated_at TEXT
  ); CREATE TABLE project_alpha_acquired_canonical_mappings(
    record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
    resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,activation_state TEXT
  ); CREATE VIEW project_alpha_active_directory_mappings AS
    SELECT source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,
      history_epoch_id,'legacy' provenance_id,'legacy' mapping_kind,NULL created_at
    FROM project_alpha_directory_mappings
    UNION ALL
    SELECT source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,
      history_epoch_id,activation_id provenance_id,'acquired' mapping_kind,activated_at created_at
    FROM project_alpha_existing_directory_binding_activation_receipts;`).map(statement => db.prepare(statement)));
  await migrate("0131_project_alpha_project_active_directory_mapping_guards.sql");
});
afterAll(async () => runtime.dispose());

describe("dormant project v2 private read settlement", () => {
  it("stores raw-byte authenticated read evidence, uses GET only, and preserves every canonical/public/delivery table", async () => {
    const setup = await acknowledged(), before = await snapshots();
    const body = readBody(), raw = `\n${JSON.stringify(body, null, 2)}\n`, send = reader(body, raw);
    const result = await settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, connection, send);
    expect(result).toMatchObject({ status: "settled", successReceiptId: setup.receiptId, commandId: setup.value.commandId, replayed: false });
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
    const stored = await db.prepare(`SELECT read_response_sha256,read_json,prior_local_version,resulting_local_version,settlement_state
      FROM project_alpha_project_v2_canonical_settlement_receipts WHERE success_receipt_id=?`).bind(setup.receiptId).first();
    expect(stored).toEqual({ read_response_sha256: createHash("sha256").update(raw, "utf8").digest("hex"), read_json: raw,
      prior_local_version: 0, resulting_local_version: 0, settlement_state: "inactive" });
    expect(await snapshots()).toEqual(before);
  });

  it("returns the stored settlement on replay with zero network even after authority is revoked", async () => {
    const setup = await acknowledged(), first = await settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, connection, reader(readBody()));
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(setup.staff).run();
    const noNetwork = vi.fn<typeof fetch>();
    await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, { ...connection, baseUrl: "not a URL" }, noNetwork))
      .resolves.toEqual({ ...(first as object), replayed: true });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("resumes an existing 0119 receipt with capability/read GETs and never retries the POST", async () => {
    const setup = await acknowledged(), methods: string[] = [];
    const send = vi.fn<typeof fetch>(async (url, init) => { methods.push(init?.method ?? ""); return String(url).endsWith("capabilities") ? json(metadata(readRoute)) : json(readBody()); });
    await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, connection, send)).resolves.toMatchObject({ status: "settled", replayed: false });
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("rejects malformed, oversized, and acknowledgement-mismatched reads without a settlement receipt", async () => {
    const setup = await acknowledged();
    const invalidData = [
      { ...readBody().data, name: "bad\u0001name" },
      { ...readBody().data, estimatedStart: "2026-02-30" },
      { ...readBody().data, estimatedStart: "2026-09-20", estimatedEnd: "2026-09-19" },
      { ...readBody().data, status: "completed", completedAt: null },
      { ...readBody().data, status: "active", completedAt: "2026-09-15T00:00:00.000Z" },
      { ...readBody().data, archived: true, archivedAt: null },
      { ...readBody().data, archived: false, archivedAt: "2026-09-15T00:00:00.000Z" },
    ];
    for (const data of invalidData) {
      await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, connection, reader(readBody({ data }))))
        .resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    }
    const mismatch = readBody({ resource: { type: "project", id: publicId, revision: "2", projectionSha256: projection } });
    await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, connection, reader(mismatch)))
      .resolves.toEqual({ status: "uncertain", reason: "evidence" });
    const huge = `${JSON.stringify(readBody()).slice(0, -1)},"padding":"${"x".repeat(70_000)}"}`;
    await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, connection, reader({}, huge)))
      .resolves.toMatchObject({ status: "uncertain", reason: "response_limit" });
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_canonical_settlement_receipts WHERE success_receipt_id=?").bind(setup.receiptId).first("n")).toBe(0);
  });

  it("does not read or settle after authority is revoked", async () => {
    const setup = await acknowledged(); await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(setup.staff).run();
    const noNetwork = vi.fn<typeof fetch>();
    await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, connection, noNetwork)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(noNetwork).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_canonical_settlement_receipts WHERE success_receipt_id=?").bind(setup.receiptId).first("n")).toBe(0);
  });

  it("treats an expired proof as revoked before and during the private read", async () => {
    const beforeExpiry = new Date(Date.now() + 2_000).toISOString(), before = await acknowledged(beforeExpiry);
    await waitUntil(beforeExpiry);
    const noNetwork = vi.fn<typeof fetch>();
    await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, before.receiptId, connection, noNetwork))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(noNetwork).not.toHaveBeenCalled();

    const duringExpiry = new Date(Date.now() + 2_000).toISOString(), during = await acknowledged(duringExpiry);
    const send = reader(readBody(), undefined, () => waitUntil(duringExpiry));
    await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, during.receiptId, connection, send))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(send.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_canonical_settlement_receipts WHERE success_receipt_id IN (?,?)")
      .bind(before.receiptId, during.receiptId).first("n")).toBe(0);
  });

  it("rejects a head or mapping that becomes stale during the GET and creates no settlement receipt", async () => {
    for (const drift of ["head", "mapping"] as const) {
      const setup = await acknowledged();
      const duringRead = async () => {
        if (drift === "head") {
          await db.prepare("INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json) VALUES(?,'Raced','active','[]')").bind(setup.value.externalId).run();
        } else {
          await db.prepare("UPDATE project_alpha_project_outbox SET state='leased',lease_token='race',lease_expires_at=1 WHERE command_id=?").bind(setup.value.commandId).run();
          await db.prepare(`INSERT INTO project_alpha_project_mappings(external_project_id,source_id,source_instance_id,application_id,project_alpha_public_id,establishment_kind,establishment_command_id,create_command_id,history_epoch_id)
            VALUES(?,'project-alpha:primary',?,?,?,'create',?,?,?)`).bind(setup.value.externalId, source, application, publicId, setup.value.commandId, setup.value.commandId, epoch).run();
        }
      };
      await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, setup.receiptId, connection, reader(readBody(), undefined, duringRead)))
        .resolves.toEqual({ status: "blocked", reason: "stale" });
      expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_canonical_settlement_receipts WHERE success_receipt_id=?").bind(setup.receiptId).first("n")).toBe(0);
    }
  });
});

describe("unmounted project v2 canonical activation", () => {
  async function settled(verifiedUntil = "2999-01-01T00:00:00.000Z", mappingKind: "legacy" | "acquired" = "legacy") {
    const value = command(), staff = await native(value, verifiedUntil), selectedPublicId = createHash("sha256").update(value.commandId).digest("hex").slice(0, 32);
    const selectedOrganizationPublicId = createHash("sha256").update(`${value.commandId}:organization`).digest("hex").slice(0, 32);
    const acknowledgedBody = acknowledgement(value);
    const post = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST"
      ? json({ ...acknowledgedBody, result: { ...acknowledgedBody.result,
        resource: { ...acknowledgedBody.result.resource, publicId: selectedPublicId } } }, 201)
      : json(metadata(commandRoute)));
    const commandResult = await settleProjectAlphaProjectV2Command({ OPS_DB: db }, "create", connection, value, post);
    if (commandResult.status !== "acknowledged") throw new Error(`setup failed: ${JSON.stringify(commandResult)}`);
    const canonicalRead = readBody({ resource: { type: "project", id: selectedPublicId, revision: "1", projectionSha256: projection },
      data: { ...readBody().data, organizationPublicId: selectedOrganizationPublicId } });
    const result = await settleProjectAlphaProjectV2Read({ OPS_DB: db }, commandResult.receiptId, connection, reader(canonicalRead));
    if (result.status !== "settled") throw new Error(`settlement failed: ${JSON.stringify(result)}`);
    const organizationRecordId = uuid();
    await db.prepare("INSERT INTO operations_directory_records(record_id,record_kind) VALUES(?,'organization')").bind(organizationRecordId).run();
    if (mappingKind === "legacy") {
      await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,
        resource_type,external_id,project_alpha_public_id) VALUES('project-alpha:primary',?,?,?,'organization',?,?)`)
        .bind(source, application, epoch, organizationRecordId, selectedOrganizationPublicId).run();
    } else {
      await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
        activation_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,activated_at)
        VALUES(?,?,?,?,?,'organization',?,?,?)`).bind(uuid(), "project-alpha:primary", source, application, epoch,
          organizationRecordId, selectedOrganizationPublicId, "2026-09-22T12:00:00.000Z").run();
    }
    return { value, staff, receiptId: commandResult.receiptId, selectedPublicId, selectedOrganizationPublicId,
      settlementId: result.settlementId, organizationRecordId };
  }

  it("atomically creates mapping, canonical head/history, acknowledges the outbox, and preserves public/delivery bytes", async () => {
    const setup = await settled();
    const publicBefore = await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares ORDER BY id").all();
    const deliveryBefore = await db.prepare("SELECT id,hex(payload) payload FROM delivery_records ORDER BY id").all();
    await expect(db.prepare(`INSERT INTO project_alpha_project_v2_canonical_activation_receipts(
      activation_id,settlement_id,command_id,external_project_id,operation,prior_local_version,
      resulting_local_version,organization_record_id,client_record_id) VALUES(?,?,?,?,?,0,1,?,NULL)`)
      .bind(uuid(), setup.settlementId, setup.value.commandId, setup.value.externalId, "create", setup.organizationRecordId).run())
      .rejects.toThrow(/not exact/);
    const result = await activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, setup.settlementId);
    expect(result).toMatchObject({ status: "activated", settlementId: setup.settlementId,
      commandId: setup.value.commandId, externalProjectId: setup.value.externalId, version: 1, replayed: false });
    expect(await db.prepare(`SELECT source_id,project_alpha_public_id,establishment_kind,establishment_command_id
      FROM project_alpha_project_mappings WHERE external_project_id=?`).bind(setup.value.externalId).first()).toEqual({
      source_id: "project-alpha:primary", project_alpha_public_id: setup.selectedPublicId, establishment_kind: "create",
      establishment_command_id: setup.value.commandId,
    });
    expect(await db.prepare(`SELECT current_version,name,lifecycle,description,archived,overdue_warning,
      organization_record_id,client_record_id,canonical_projection_sha256
      FROM operations_shared_projects WHERE external_project_id=?`).bind(setup.value.externalId).first()).toEqual({
      current_version: 1, name: "Survey", lifecycle: "active", description: null, archived: 0,
      overdue_warning: 0, organization_record_id: setup.organizationRecordId, client_record_id: null,
      canonical_projection_sha256: projection,
    });
    expect(await db.prepare(`SELECT version,pa_revision,refresh_command_id,v2_settlement_id
      FROM operations_shared_project_revisions WHERE external_project_id=?`).bind(setup.value.externalId).first()).toEqual({
      version: 1, pa_revision: null, refresh_command_id: null, v2_settlement_id: setup.settlementId,
    });
    expect(await db.prepare("SELECT state,lease_token,lease_expires_at FROM project_alpha_project_outbox WHERE command_id=?")
      .bind(setup.value.commandId).first()).toEqual({ state: "acknowledged", lease_token: null, lease_expires_at: null });
    expect((await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares ORDER BY id").all()).results).toEqual(publicBefore.results);
    expect((await db.prepare("SELECT id,hex(payload) payload FROM delivery_records ORDER BY id").all()).results).toEqual(deliveryBefore.results);

    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(setup.staff).run();
    const noNetworkReplay = await activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, setup.settlementId);
    expect(noNetworkReplay).toEqual({ ...result, replayed: true });
    await expect(db.prepare("UPDATE project_alpha_project_v2_canonical_activation_receipts SET resulting_local_version=2").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM project_alpha_project_v2_canonical_activation_receipts WHERE settlement_id=?")
      .bind(setup.settlementId).run()).rejects.toThrow(/durable/);
  });

  it("accepts an acquired active Directory mapping, rejects an unrelated mapping, and preserves public/delivery bytes", async () => {
    const setup = await settled("2999-01-01T00:00:00.000Z", "acquired");
    const publicBefore = await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares ORDER BY id").all();
    const deliveryBefore = await db.prepare("SELECT id,hex(payload) payload FROM delivery_records ORDER BY id").all();
    const result = await activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, setup.settlementId);
    expect(result).toMatchObject({ status: "activated", version: 1 });
    expect((await db.prepare("SELECT mapping_kind FROM project_alpha_active_directory_mappings WHERE external_id=?")
      .bind(setup.organizationRecordId).first())).toEqual({ mapping_kind: "acquired" });
    expect((await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares ORDER BY id").all()).results)
      .toEqual(publicBefore.results);
    expect((await db.prepare("SELECT id,hex(payload) payload FROM delivery_records ORDER BY id").all()).results)
      .toEqual(deliveryBefore.results);

    const inactiveRecordId = uuid();
    await db.prepare("INSERT INTO operations_directory_records(record_id,record_kind) VALUES(?,'organization')")
      .bind(inactiveRecordId).run();
    await db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(
      record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,activation_state)
      VALUES(?,?,?,?,?,'organization',?,?,?)`).bind(inactiveRecordId, "project-alpha:primary", source, application, epoch,
        inactiveRecordId, "b".repeat(32), "inactive").run();
    await expect(db.prepare(`INSERT INTO operations_shared_projects(
      external_project_id,name,lifecycle,scopes_json,source_id,source_instance_id,application_id,history_epoch_id,
      project_alpha_public_id,pa_revision,current_version,canonical_projection_sha256,organization_record_id)
      VALUES('inactive-project','Inactive','active','[]',?,?,?,?,?,?,1,?,?)`)
      .bind(source, source, application, epoch, setup.selectedPublicId, "1", projection, inactiveRecordId).run())
      .rejects.toThrow(/not authorized/);
    await expect(db.prepare(`INSERT INTO operations_shared_projects(
      external_project_id,name,lifecycle,scopes_json,source_id,source_instance_id,application_id,history_epoch_id,
      project_alpha_public_id,pa_revision,current_version,canonical_projection_sha256,organization_record_id)
      VALUES('unrelated-project','Unrelated','active','[]',?,?,?,?,?,?,1,?,?)`)
      .bind(source, source, application, epoch, setup.selectedPublicId, "1", projection, "missing-organization").run())
      .rejects.toThrow(/not authorized/);
  });

  it("rolls back every canonical/outbox mutation when the final immutable receipt fails", async () => {
    const setup = await settled();
    await db.batch(splitD1MigrationStatements(`CREATE TRIGGER activation_test_fail BEFORE INSERT ON project_alpha_project_v2_canonical_activation_receipts
      WHEN NEW.settlement_id='${setup.settlementId}' BEGIN SELECT RAISE(ABORT,'injected activation failure'); END;`)
      .map(statement => db.prepare(statement)));
    try {
      await expect(activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, setup.settlementId))
        .resolves.toEqual({ status: "uncertain", reason: "database" });
      expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(setup.value.commandId).first("state")).toBe("pending");
      expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_mappings WHERE external_project_id=?").bind(setup.value.externalId).first("n")).toBe(0);
      expect(await db.prepare("SELECT count(*) n FROM operations_shared_projects WHERE external_project_id=?").bind(setup.value.externalId).first("n")).toBe(0);
      expect(await db.prepare("SELECT count(*) n FROM operations_shared_project_revisions WHERE external_project_id=?").bind(setup.value.externalId).first("n")).toBe(0);
    } finally { await db.exec("DROP TRIGGER activation_test_fail"); }
    await expect(activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, setup.settlementId))
      .resolves.toMatchObject({ status: "activated", replayed: false });
  });

  it("fails atomically when authority drifts inside the activation batch", async () => {
    const setup = await settled();
    await db.batch(splitD1MigrationStatements(`CREATE TRIGGER activation_test_authority_race
      AFTER UPDATE OF state ON project_alpha_project_outbox
      WHEN NEW.command_id='${setup.value.commandId}' AND NEW.state='leased' BEGIN
        UPDATE native_staff_admissions SET active=0 WHERE staff_id='${setup.staff}';
      END;`).map(statement => db.prepare(statement)));
    try {
      await expect(activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, setup.settlementId))
        .resolves.toEqual({ status: "uncertain", reason: "database" });
      expect(await db.prepare("SELECT active FROM native_staff_admissions WHERE staff_id=?").bind(setup.staff).first("active")).toBe(1);
      expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(setup.value.commandId).first("state")).toBe("pending");
      expect(await db.prepare("SELECT count(*) n FROM operations_shared_projects WHERE external_project_id=?").bind(setup.value.externalId).first("n")).toBe(0);
      expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_canonical_activation_receipts WHERE settlement_id=?").bind(setup.settlementId).first("n")).toBe(0);
    } finally { await db.exec("DROP TRIGGER activation_test_authority_race"); }
  });

  it("fails closed for a stale head and an expired proof before activation", async () => {
    const stale = await settled();
    await db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json,
      canonical_projection_sha256) VALUES(?,'Concurrent local project','active','[]',?)`)
      .bind(stale.value.externalId, "8".repeat(64)).run();
    await expect(activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, stale.settlementId))
      .resolves.toEqual({ status: "blocked", reason: "stale" });

    const expiresAt = new Date(Date.now() + 10_000).toISOString(), expired = await settled(expiresAt);
    await waitUntil(expiresAt);
    await expect(activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, expired.settlementId))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
  });

  it("fails closed on revoked authority and converges concurrent activation on one receipt", async () => {
    const revoked = await settled();
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(revoked.staff).run();
    await expect(activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, revoked.settlementId))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(revoked.value.commandId).first("state")).toBe("pending");

    const raced = await settled();
    const outcomes = await Promise.all([
      activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, raced.settlementId),
      activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, raced.settlementId),
    ]);
    expect(outcomes.every(value => value.status === "activated")).toBe(true);
    expect(new Set(outcomes.map(value => value.status === "activated" ? value.activationId : null)).size).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_canonical_activation_receipts WHERE settlement_id=?")
      .bind(raced.settlementId).first("n")).toBe(1);
  });

  it("applies exact update and bind settlements as versioned history without refresh", async () => {
    const created = await settled();
    const initial = await activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, created.settlementId);
    expect(initial).toMatchObject({ status: "activated", version: 1 });
    const actor = await db.prepare(`SELECT actor_staff_id,actor_access_subject,actor_admission_version,
      actor_profile_version,actor_email,grant_generation FROM native_project_command_proofs WHERE command_id=?`)
      .bind(created.value.commandId).first<{actor_staff_id:string;actor_access_subject:string;actor_admission_version:number;actor_profile_version:number;actor_email:string;grant_generation:number}>();
    const updateProjection = "b".repeat(64), updateId = uuid();
    const update: ProjectAlphaProjectUpdateCommand = { commandId: updateId, externalId: created.value.externalId,
      expectedRevision: "1", expectedProjectionSha256: projection, expectedAuthorizationGeneration: "1",
      project: { name: "Survey updated", description: "Canonical", estimatedStart: null, estimatedEnd: null } };
    await db.batch([
      db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,
        actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
        VALUES(?,?,?,?,?,?,?,'2999-01-01T00:00:00.000Z',?,'[]')`).bind(updateId, update.externalId,
        actor!.actor_staff_id, actor!.actor_access_subject, actor!.actor_admission_version,
        actor!.actor_profile_version, actor!.actor_email, actor!.grant_generation),
      db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,
        source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,
        attempts,next_attempt_at,expected_history_epoch_id) VALUES(?,?,'update',?,'project-alpha:primary',?,
        'https://alpha.example.test',?,?,'pending',0,0,?)`).bind(updateId, update.externalId, JSON.stringify(update),
        application, source, JSON.stringify({ actorId: actor!.actor_staff_id }), epoch),
      db.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").bind(updateId),
    ]);
    const updateRoute = { ...commandRoute, path: "/api/v2/projects/profile/commands", requiredCapability: "projects.write" };
    const updateAck = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", replayed: false, result: { resource: { type: "project",
        id: update.externalId, publicId: created.selectedPublicId, revision: "2", projectionSha256: updateProjection },
      authorizationGeneration: "1", presentation: { portalPublished: false, publicLinkEnabled: false } } };
    const updateSender = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST" ? json(updateAck) : json(metadata(updateRoute)));
    const updateCommand = await settleProjectAlphaProjectV2Command({ OPS_DB: db }, "update", connection, update, updateSender);
    expect(updateCommand).toMatchObject({ status: "acknowledged" });
    const updateRead = { ...readBody(), resource: { type: "project", id: created.selectedPublicId, revision: "2", projectionSha256: updateProjection },
      data: { ...readBody().data, name: "Survey updated", description: "Canonical",
        organizationPublicId: created.selectedOrganizationPublicId, overdueWarning: true } };
    const updateSettlement = await settleProjectAlphaProjectV2Read({ OPS_DB: db }, (updateCommand as {receiptId:string}).receiptId, connection, reader(updateRead));
    expect(updateSettlement).toMatchObject({ status: "settled" });
    const updated = await activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, (updateSettlement as {settlementId:string}).settlementId);
    expect(updated).toMatchObject({ status: "activated", version: 2 });
    expect(await db.prepare("SELECT current_version,name,overdue_warning FROM operations_shared_projects WHERE external_project_id=?")
      .bind(update.externalId).first()).toEqual({ current_version: 2, name: "Survey updated", overdue_warning: 1 });

    const bindExternal = `ops/bind-${sequence}`, bindId = uuid(), bindPublic = createHash("sha256").update(bindId).digest("hex").slice(0,32);
    const bindProjection = "c".repeat(64), localProjection = "9".repeat(64);
    const bind: ProjectAlphaProjectBindCommand = { commandId: bindId, externalId: bindExternal, expectedPublicId: bindPublic,
      expectedRevision: "1", expectedProjectionSha256: bindProjection, expectedAuthorizationGeneration: "0" };
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,
        destination_base_url,expected_source_instance_id,expected_history_epoch_id)
        VALUES(?,'project-alpha:primary',?,'https://alpha.example.test',?,?)`).bind(bindExternal, application, source, epoch),
      db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,external_project_id,granted_by)
        VALUES(?,?,'project.shared.sync','allow','exact_project',?,?)`).bind(`grant-${bindId}`, actor!.actor_staff_id, bindExternal, actor!.actor_staff_id),
    ]);
    const bindGeneration = await db.prepare("SELECT generation FROM native_project_grant_generations WHERE staff_id=?")
      .bind(actor!.actor_staff_id).first<number>("generation");
    await db.batch([
      db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,
        actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
        VALUES(?,?,?,?,?,?,?,'2999-01-01T00:00:00.000Z',?,'[]')`).bind(bindId, bindExternal,
        actor!.actor_staff_id, actor!.actor_access_subject, actor!.actor_admission_version,
        actor!.actor_profile_version, actor!.actor_email, bindGeneration),
      db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,
        source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,
        attempts,next_attempt_at,expected_history_epoch_id) VALUES(?,?,'bind',?,'project-alpha:primary',?,
        'https://alpha.example.test',?,?,'pending',0,0,?)`).bind(bindId, bindExternal, JSON.stringify(bind), application,
        source, JSON.stringify({ actorId: actor!.actor_staff_id }), epoch),
      db.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").bind(bindId),
      db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json,canonical_projection_sha256)
        VALUES(?,'Local project','active','[]',?)`).bind(bindExternal, localProjection),
      db.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,pa_revision,read_json,refresh_command_id)
        VALUES(?,1,NULL,'{"local":true}',NULL)`).bind(bindExternal),
    ]);
    const bindRoute = { ...commandRoute, path: "/api/v2/projects/bindings/commands", requiredCapability: "projects.bind" };
    const bindAck = { ...updateAck, result: { resource: { type: "project", id: bindExternal, publicId: bindPublic,
      revision: "1", projectionSha256: bindProjection }, authorizationGeneration: "1",
      presentation: { portalPublished: false, publicLinkEnabled: false } } };
    const bindSender = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST" ? json(bindAck) : json(metadata(bindRoute)));
    const bindCommand = await settleProjectAlphaProjectV2Command({ OPS_DB: db }, "bind", connection, bind, bindSender);
    expect(bindCommand).toMatchObject({ status: "acknowledged" });
    const bindRead = { ...readBody(), resource: { type: "project", id: bindPublic, revision: "1", projectionSha256: bindProjection },
      data: { ...readBody().data, name: "Bound project", organizationPublicId: null } };
    const bindSettlement = await settleProjectAlphaProjectV2Read({ OPS_DB: db }, (bindCommand as {receiptId:string}).receiptId, connection, reader(bindRead));
    expect(bindSettlement).toMatchObject({ status: "settled" });
    const bound = await activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, (bindSettlement as {settlementId:string}).settlementId);
    expect(bound).toMatchObject({ status: "activated", version: 2 });
    expect(await db.prepare("SELECT establishment_kind,project_alpha_public_id FROM project_alpha_project_mappings WHERE external_project_id=?")
      .bind(bindExternal).first()).toEqual({ establishment_kind: "bind", project_alpha_public_id: bindPublic });
  });
});
