import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare;
let db: D1Database;
let sequence = 0;
const uuid = () => `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
const hash = "a".repeat(64);
const instant = "2026-09-14T12:35:56.789Z";

function seed() {
  const recordId = `record-${++sequence}`, sourceInstanceId = uuid(), applicationId = uuid(), historyEpochId = uuid();
  return { recordId, sourceId: "project-alpha:primary", sourceInstanceId, applicationId, historyEpochId,
    externalId: `external-${sequence}`, publicId: sequence.toString(16).padStart(32, "a"),
    acquiredReceiptId: uuid(), ownerClaimId: uuid() };
}
async function persist(v: ReturnType<typeof seed>) {
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(v.recordId),
    db.prepare("INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts VALUES(?,?,?,?,?,?,?,?,?,?,'7')")
      .bind(v.acquiredReceiptId, "command", v.recordId, v.sourceId, v.sourceInstanceId, v.applicationId, v.historyEpochId, "client", v.externalId, v.publicId),
    db.prepare("INSERT INTO project_alpha_acquired_canonical_mappings VALUES(?,?,?,?,?,?,?,?,?,NULL,'inactive')")
      .bind(v.acquiredReceiptId, v.recordId, v.sourceId, v.sourceInstanceId, v.applicationId, v.historyEpochId, "client", v.externalId, v.publicId),
    db.prepare("INSERT INTO project_alpha_acquired_native_owner_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(v.ownerClaimId, v.acquiredReceiptId, v.recordId, v.sourceId, v.sourceInstanceId, v.applicationId, v.historyEpochId, "client", v.externalId, v.publicId, 1),
  ]);
}
function command(v: ReturnType<typeof seed>, overrides: Record<string, unknown> = {}) {
  const value = { command_id: uuid(), request_sha256: hash, predecessor_kind: "acquired_mapping", predecessor_acquired_receipt_id: v.acquiredReceiptId,
    predecessor_refresh_receipt_id: null, native_owner_claim_id: v.ownerClaimId, record_id: v.recordId, source_id: v.sourceId,
    source_instance_id: v.sourceInstanceId, application_id: v.applicationId, history_epoch_id: v.historyEpochId, resource_type: "client",
    external_id: v.externalId, project_alpha_public_id: v.publicId, expected_prior_revision: "7", expected_live_revision: "8",
    expected_authorization_generation: "42", expected_local_record_version: 1, ...overrides };
  return db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_commands(
    command_id,request_sha256,predecessor_kind,predecessor_acquired_receipt_id,predecessor_refresh_receipt_id,native_owner_claim_id,
    record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
    expected_prior_revision,expected_live_revision,expected_authorization_generation,expected_local_record_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...Object.values(value));
}
function event(commandId: string, version: number, state: string, requestSha256 = hash) {
  return db.prepare("INSERT INTO project_alpha_existing_directory_binding_revision_refresh_events(command_id,state_version,transition_id,request_sha256,state,occurred_at) VALUES(?,?,?,?,?,?)")
    .bind(commandId, version, uuid(), requestSha256, state, instant);
}
function receipt(v: ReturnType<typeof seed>, commandId: string, overrides: Record<string, unknown> = {}) {
  const value = { receipt_id: uuid(), request_sha256: hash, command_id: commandId, native_owner_claim_id: v.ownerClaimId, record_id: v.recordId,
    source_id: v.sourceId, source_instance_id: v.sourceInstanceId, application_id: v.applicationId, history_epoch_id: v.historyEpochId,
    resource_type: "client", external_id: v.externalId, project_alpha_public_id: v.publicId, prior_revision: "7", live_revision: "8",
    authorization_generation: "43", local_record_version: 1, pa_request_id: uuid(), pa_replayed: 0, response_sha256: "b".repeat(64), received_at: instant, ...overrides };
  return db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_receipts(
    receipt_id,request_sha256,command_id,native_owner_claim_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
    resource_type,external_id,project_alpha_public_id,prior_revision,live_revision,authorization_generation,local_record_version,
    pa_request_id,pa_replayed,response_sha256,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...Object.values(value));
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await db.exec(`CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER);
    CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id TEXT PRIMARY KEY,command_id TEXT,record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,project_alpha_revision TEXT);
    CREATE TABLE project_alpha_acquired_canonical_mappings(receipt_id TEXT PRIMARY KEY,record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,native_owner_epoch_id TEXT,activation_state TEXT);
    CREATE TABLE project_alpha_acquired_native_owner_claims(claim_id TEXT PRIMARY KEY,receipt_id TEXT,record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,expected_local_record_version INTEGER);`);
  const migration = readFileSync(new URL("../migrations/0118_project_alpha_existing_directory_binding_revision_refresh_ledger.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement)));
});
afterAll(async () => runtime.dispose());

describe("0118 PA binding revision refresh ledger", () => {
  it("reserves exactly one append-only successor from an immutable acquired receipt", async () => {
    const v = seed(); await persist(v);
    const id = uuid();
    const attempts = await Promise.allSettled([command(v, { command_id: id }).run(), command(v, { command_id: uuid() }).run()]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await expect(command(v, { predecessor_acquired_receipt_id: v.acquiredReceiptId, expected_live_revision: "7" }).run()).rejects.toThrow();
    await expect(command(v, { predecessor_acquired_receipt_id: v.acquiredReceiptId, expected_prior_revision: "07" }).run()).rejects.toThrow();
    await expect(command(v, { predecessor_acquired_receipt_id: v.acquiredReceiptId, expected_authorization_generation: "042" }).run()).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) AS n FROM project_alpha_existing_directory_binding_revision_refresh_commands").first("n")).toBe(1);
  });

  it("requires a current local/owner/predecessor chain and records only a terminal exact receipt", async () => {
    const v = seed(); await persist(v); const id = uuid();
    await command(v, { command_id: id }).run();
    await expect(receipt(v, id).run()).rejects.toThrow(/acknowledged/);
    await expect(event(id, 1, "pending", "c".repeat(64)).run()).rejects.toThrow(/transition is invalid/);
    await event(id, 1, "pending").run();
    await event(id, 2, "acknowledged").run();
    await expect(receipt(v, id, { request_sha256: "c".repeat(64) }).run()).rejects.toThrow(/exact command/);
    await expect(receipt(v, id, { authorization_generation: "44" }).run()).rejects.toThrow(/exact command/);
    await expect(receipt(v, id, { authorization_generation: "043" }).run()).rejects.toThrow();
    await receipt(v, id).run();
    await expect(db.prepare("UPDATE project_alpha_existing_directory_binding_revision_refresh_receipts SET live_revision='9' WHERE command_id=?").bind(id).run()).rejects.toThrow(/immutable/);
    await db.prepare("UPDATE operations_directory_records SET current_version=2 WHERE record_id=?").bind(v.recordId).run();
    await expect(command(v, { command_id: uuid(), predecessor_kind: "revision_refresh", predecessor_acquired_receipt_id: null,
      predecessor_refresh_receipt_id: await db.prepare("SELECT receipt_id FROM project_alpha_existing_directory_binding_revision_refresh_receipts WHERE command_id=?").bind(id).first("receipt_id"), expected_prior_revision: "8", expected_live_revision: "9" }).run()).rejects.toThrow(/current exact predecessor/);
  });

  it("does not retrofit or alter legacy public mappings", async () => {
    const v = seed(); await persist(v);
    await db.prepare("INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)").bind(v.sourceId, v.sourceInstanceId, v.applicationId, "client", v.externalId, v.publicId).run();
    await expect(command(v).run()).rejects.toThrow(/legacy mapping/);
    expect(await db.prepare("SELECT count(*) AS n FROM project_alpha_directory_mappings").first("n")).toBe(1);
  });
});
