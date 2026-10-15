import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const sourceId = "project-alpha:primary";
const sourceInstanceId = "10000000-0000-4000-8000-000000000001";
const applicationId = "10000000-0000-4000-8000-000000000002";
const historyEpochId = "10000000-0000-4000-8000-000000000003";
const origin = "https://pa.example.test";
const publicId = "a".repeat(32);

describe("0173 acquired Directory intent destination transition", () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {}", d1Databases: { OPS_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await db.batch(splitD1MigrationStatements(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE operations_directory_records(
        record_id TEXT PRIMARY KEY,record_kind TEXT NOT NULL,current_version INTEGER NOT NULL);
      CREATE TABLE operations_directory_intents(
        intent_id TEXT PRIMARY KEY,record_id TEXT NOT NULL,source_id TEXT NOT NULL,
        source_instance_uuid TEXT NOT NULL,application_uuid TEXT NOT NULL,
        expected_history_epoch_id TEXT NOT NULL,destination_origin TEXT NOT NULL,
        external_canonical_id TEXT NOT NULL);
      CREATE TABLE test_active_directory_mappings(
        source_id TEXT NOT NULL,resource_type TEXT NOT NULL,record_id TEXT NOT NULL,
        external_id TEXT NOT NULL,project_alpha_public_id TEXT NOT NULL,
        source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,
        history_epoch_id TEXT NOT NULL,mapping_kind TEXT NOT NULL);
      CREATE VIEW project_alpha_active_directory_mappings AS
        SELECT *,NULL AS provenance_id,NULL AS created_at FROM test_active_directory_mappings;
      CREATE TRIGGER operations_directory_intents_destination_pinned
      BEFORE INSERT ON operations_directory_intents
      WHEN EXISTS(SELECT 1 FROM operations_directory_intents previous
        WHERE previous.record_id=NEW.record_id AND previous.source_id=NEW.source_id
          AND previous.source_instance_uuid=NEW.source_instance_uuid
          AND previous.application_uuid=NEW.application_uuid
          AND (previous.destination_origin IS NOT NEW.destination_origin
            OR previous.external_canonical_id IS NOT NEW.external_canonical_id))
      BEGIN SELECT RAISE(ABORT,'directory destination requires explicit reconciliation'); END;
    `).map(statement => db.prepare(statement)));
    const migration = readFileSync(new URL("../migrations/0173_operations_directory_intent_acquired_destination_transition.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement)));
  });

  afterEach(async () => { await runtime.dispose(); });

  const insertIntent = (intentId: string, recordId: string, externalId: string,
    destinationOrigin = origin, historyEpoch = historyEpochId) => db.prepare(`INSERT INTO operations_directory_intents(
      intent_id,record_id,source_id,source_instance_uuid,application_uuid,expected_history_epoch_id,
      destination_origin,external_canonical_id) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(intentId,recordId,sourceId,sourceInstanceId,applicationId,historyEpoch,destinationOrigin,externalId).run();

  const insertMapping = (recordId: string, externalId: string, mappingKind = "acquired",
    mappedPublicId = publicId, historyEpoch = historyEpochId) => db.prepare(`INSERT INTO test_active_directory_mappings(
      source_id,resource_type,record_id,external_id,project_alpha_public_id,source_instance_id,
      application_id,history_epoch_id,mapping_kind) VALUES(?,'organization',?,?,?,?,?,?,?)`)
    .bind(sourceId,recordId,externalId,mappedPublicId,sourceInstanceId,applicationId,historyEpoch,mappingKind).run();

  async function seedRecord(recordId: string) {
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(recordId).run();
    await insertIntent(`${recordId}:create`,recordId,recordId);
  }

  it("permits only the exact active acquired Ops-to-PA pair", async () => {
    const recordId = "ops/exact", externalId = "pa/exact";
    await seedRecord(recordId);
    await insertMapping(recordId,externalId);
    await expect(insertIntent("exact:update",recordId,externalId)).resolves.toBeTruthy();
    expect(await db.prepare("SELECT external_canonical_id FROM operations_directory_intents WHERE intent_id='exact:update'")
      .first("external_canonical_id")).toBe(externalId);
  });

  it("blocks mismatched, swapped, unmapped, wrong-history, and invalid-public pairs", async () => {
    const cases = [
      { name: "mismatched", recordId: "ops/mismatched", requested: "pa/mismatched", mappedRecord: "ops/mismatched", mappedExternal: "pa/other" },
      { name: "swapped", recordId: "ops/swapped", requested: "pa/swapped", mappedRecord: "pa/swapped", mappedExternal: "ops/swapped" },
      { name: "unmapped", recordId: "ops/unmapped", requested: "pa/unmapped" },
      { name: "history", recordId: "ops/history", requested: "pa/history", mappedRecord: "ops/history", mappedExternal: "pa/history",
        mappedHistory: "20000000-0000-4000-8000-000000000003" },
      { name: "public", recordId: "ops/public", requested: "pa/public", mappedRecord: "ops/public", mappedExternal: "pa/public",
        mappedPublic: "not-a-public-id" },
    ] as const;
    for (const value of cases) {
      await seedRecord(value.recordId);
      if ("mappedRecord" in value) await insertMapping(value.mappedRecord,value.mappedExternal,"acquired",
        "mappedPublic" in value ? value.mappedPublic : publicId,"mappedHistory" in value ? value.mappedHistory : historyEpochId);
      await expect(insertIntent(`${value.name}:update`,value.recordId,value.requested))
        .rejects.toThrow("directory destination requires explicit reconciliation");
    }
  });

  it("keeps legacy destination changes and origin changes pinned", async () => {
    const legacyRecordId = "ops/legacy", legacyExternalId = "pa/legacy";
    await seedRecord(legacyRecordId);
    await insertMapping(legacyRecordId,legacyExternalId,"legacy");
    await expect(insertIntent("legacy:update",legacyRecordId,legacyExternalId))
      .rejects.toThrow("directory destination requires explicit reconciliation");

    const originRecordId = "ops/origin", originExternalId = "pa/origin";
    await seedRecord(originRecordId);
    await insertMapping(originRecordId,originExternalId);
    await expect(insertIntent("origin:update",originRecordId,originExternalId,"https://other-pa.example.test"))
      .rejects.toThrow("directory destination requires explicit reconciliation");
  });
});
