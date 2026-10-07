import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare;
let db: D1Database;

const sourceId = "project-alpha:primary";
const sourceInstance = "22222222-2222-4222-8222-222222222222";
const application = "33333333-3333-4333-8333-333333333333";
const historyEpoch = "44444444-4444-4444-8444-444444444444";
const origin = "https://pa.example.test";
const recordId = "ops/client/42";
const externalId = "pa/client/existing-7";
const publicId = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const schema = `
    CREATE TABLE operations_directory_live_write_fences(
      mutation_id TEXT,record_id TEXT,record_kind TEXT,operation_kind TEXT,expected_version INTEGER,
      record_writes INTEGER,revision_writes INTEGER,audit_writes INTEGER,intent_writes INTEGER,
      destinations_json TEXT,profile_json TEXT
    );
    CREATE TABLE operations_directory_records(record_id TEXT,record_kind TEXT);
    CREATE TABLE project_alpha_active_directory_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,record_id TEXT,external_id TEXT,mapping_kind TEXT,project_alpha_public_id TEXT
    );
    CREATE TABLE operations_directory_intents(
      intent_id TEXT,mutation_id TEXT,record_id TEXT,record_version INTEGER,source_id TEXT,
      source_instance_uuid TEXT,application_uuid TEXT,expected_history_epoch_id TEXT,
      destination_origin TEXT,external_canonical_id TEXT,desired_payload_json TEXT
    );
    CREATE TRIGGER operations_directory_intents_write_guard BEFORE INSERT ON operations_directory_intents
    BEGIN SELECT RAISE(ABORT,'old guard'); END;
  `;
  await db.batch(splitD1MigrationStatements(schema).map(statement => db.prepare(statement)));
  const sql = readFileSync(new URL("../migrations/0177_operations_directory_acquired_intent_update_authority.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records VALUES(?, 'client')").bind(recordId),
    db.prepare(`INSERT INTO project_alpha_active_directory_mappings
      VALUES(?,?,?,?,?,?,?,'acquired',?)`).bind(sourceId, sourceInstance, application, historyEpoch,
        "client", recordId, externalId, publicId),
  ]);
});

afterAll(async () => { await runtime.dispose(); });

function destination() {
  return JSON.stringify([{ sourceId, sourceInstanceUUID: sourceInstance, applicationUUID: application,
    historyEpoch, origin, externalCanonicalId: recordId }]);
}
async function fence(mutationId: string, operationKind: string, payload = '{"name":"Updated"}') {
  await db.prepare(`INSERT INTO operations_directory_live_write_fences
    VALUES(?,?,?,?,1,0,0,0,1,?,json(?))`).bind(mutationId, recordId, "client", operationKind,
      destination(), payload).run();
}
function intent(mutationId: string, intentId: string, requestedExternalId = externalId, payload = '{"name":"Updated"}') {
  return db.prepare(`INSERT INTO operations_directory_intents
    VALUES(?,?,?,2,?,?,?,?,?,?,json(?))`).bind(intentId, mutationId, recordId, sourceId,
      sourceInstance, application, historyEpoch, origin, requestedExternalId, payload);
}

describe("append-only acquired PA Directory intent authority repair", () => {
  it("preserves every 0176 predicate and adds only the update-operation requirement", () => {
    const before = readFileSync(new URL("../migrations/0176_operations_directory_acquired_intent_authority.sql", import.meta.url), "utf8")
      .replace(/\s+/g, " ").trim();
    const after = readFileSync(new URL("../migrations/0177_operations_directory_acquired_intent_update_authority.sql", import.meta.url), "utf8")
      .replace("fence.operation_kind='update'\n        AND ", "")
      .replace(/\s+/g, " ").trim();
    expect(after).toBe(before);
  });

  it("allows the exact acquired mapping only for an update fence", async () => {
    await fence("mutation-update", "update");
    await expect(intent("mutation-update", "intent-update").run()).resolves.toMatchObject({ success: true });

    await fence("mutation-create", "create");
    await expect(intent("mutation-create", "intent-create").run())
      .rejects.toThrow("directory intent requires current native authority and enrollment");
  });

  it("fails closed for a wrong mapping kind, malformed public ID, payload drift, or wrong external ID", async () => {
    await fence("mutation-negative", "update");
    await db.prepare("UPDATE project_alpha_active_directory_mappings SET mapping_kind='legacy'").run();
    await expect(intent("mutation-negative", "intent-legacy").run()).rejects.toThrow(/current native authority/);

    await db.prepare("UPDATE project_alpha_active_directory_mappings SET mapping_kind='acquired',project_alpha_public_id='BAD'").run();
    await expect(intent("mutation-negative", "intent-public-id").run()).rejects.toThrow(/current native authority/);

    await db.prepare("UPDATE project_alpha_active_directory_mappings SET project_alpha_public_id=?").bind(publicId).run();
    await expect(intent("mutation-negative", "intent-payload", externalId, '{"name":"Drift"}').run())
      .rejects.toThrow(/current native authority/);
    await expect(intent("mutation-negative", "intent-external", "pa/client/wrong").run())
      .rejects.toThrow(/current native authority/);
  });
});
