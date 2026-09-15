import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { settleProjectAlphaProjectV2Command } from "../src/worker/project-alpha-project-settlement-adapter";
import { settleProjectAlphaProjectV2Read } from "../src/worker/project-alpha-project-read-settlement-adapter";
import type { ProjectAlphaProjectCreateCommand } from "../src/worker/project-alpha-project-api-v2";

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
function metadata(route: typeof commandRoute | typeof readRoute) {
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
    const beforeExpiry = new Date(Date.now() + 500).toISOString(), before = await acknowledged(beforeExpiry);
    await waitUntil(beforeExpiry);
    const noNetwork = vi.fn<typeof fetch>();
    await expect(settleProjectAlphaProjectV2Read({ OPS_DB: db }, before.receiptId, connection, noNetwork))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(noNetwork).not.toHaveBeenCalled();

    const duringExpiry = new Date(Date.now() + 750).toISOString(), during = await acknowledged(duringExpiry);
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
