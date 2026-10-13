import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/0179_project_alpha_acquired_native_identity_collision.sql", import.meta.url), "utf8");
const source = "project-alpha:matrix";
const instance = "22222222-2222-4222-8222-222222222222";
const application = "33333333-3333-4333-8333-333333333333";
const resource = "client";

const legacyFields = ["external_id", "project_alpha_public_id"] as const;
const acquiredFields = ["record_id", "external_id", "project_alpha_public_id"] as const;
const acquiredTables = [
  { table: "project_alpha_acquired_canonical_mappings", label: "canonical" },
  { table: "project_alpha_acquired_native_owner_claims", label: "owner claim" },
] as const;

function schemaFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE project_alpha_directory_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,
      external_id TEXT,project_alpha_public_id TEXT
    );
    CREATE TABLE project_alpha_acquired_canonical_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,
      record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,receipt_id TEXT
    );
    CREATE TABLE project_alpha_acquired_native_owner_claims(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,
      record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,receipt_id TEXT
    );
    CREATE TRIGGER project_alpha_acquired_canonical_mappings_legacy_collision
      BEFORE INSERT ON project_alpha_acquired_canonical_mappings BEGIN SELECT 'old canonical guard'; END;
    CREATE TRIGGER project_alpha_acquired_canonical_mappings_native_identity_collision
      BEFORE INSERT ON project_alpha_acquired_canonical_mappings BEGIN SELECT 'old canonical identity guard'; END;
    CREATE TRIGGER project_alpha_acquired_native_owner_claims_legacy
      BEFORE INSERT ON project_alpha_acquired_native_owner_claims BEGIN SELECT 'old claim guard'; END;
    CREATE TRIGGER project_alpha_directory_mappings_acquired_collision
      BEFORE INSERT ON project_alpha_directory_mappings BEGIN SELECT 'old legacy guard'; END;
  `);
  return db;
}

function fixture() {
  const db = schemaFixture();
  for (const statement of splitD1MigrationStatements(migration)) db.exec(statement);
  return db;
}

function expectPreflightRejectsWithoutReplacingGuards(db: DatabaseSync) {
  expect(() => {
    db.exec("BEGIN");
    try {
      for (const statement of splitD1MigrationStatements(migration)) db.exec(statement);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }).toThrow(/CHECK constraint failed/);
  const previousGuards = db.prepare(`SELECT count(*) AS count FROM sqlite_master
    WHERE type='trigger' AND sql LIKE '%old %'`).get() as { count: number };
  expect(previousGuards.count).toBe(4);
}

function insertLegacy(db: DatabaseSync, values: { external_id: string; project_alpha_public_id: string }) {
  db.prepare(`INSERT INTO project_alpha_directory_mappings
    (source_id,source_instance_id,application_id,resource_type,external_id,project_alpha_public_id)
    VALUES(?,?,?,?,?,?)`).run(source, instance, application, resource, values.external_id, values.project_alpha_public_id);
}

function insertAcquired(
  db: DatabaseSync,
  table: string,
  id: string,
  override?: { field: typeof acquiredFields[number]; value: string },
  receiptId = `receipt-${id}`,
) {
  const values: Record<typeof acquiredFields[number], string> = {
    record_id: `ops-${id}`,
    external_id: `pa-${id}`,
    project_alpha_public_id: `public-${id}`,
  };
  if (override) values[override.field] = override.value;
  db.prepare(`INSERT INTO ${table}
    (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
    VALUES(?,?,?,?,?,?,?,?)`).run(source, instance, application, resource,
      values.record_id, values.external_id, values.project_alpha_public_id, receiptId);
}

const legacyCases = legacyFields.flatMap(legacyField => acquiredTables.flatMap(acquiredTable =>
  acquiredFields.flatMap(acquiredField => [
    { direction: "legacy first", legacyField, acquiredTable, acquiredField },
    { direction: "acquired first", legacyField, acquiredTable, acquiredField },
  ])));

const acquiredCases = acquiredTables.flatMap(leftTable => acquiredTables.flatMap(rightTable =>
  acquiredFields.flatMap(leftField => acquiredFields.map(rightField => ({
    leftTable, rightTable, leftField, rightField,
  })))));

describe("0179 acquired/native identity collision field matrix", () => {
  it.each(legacyCases)("preflight rejects existing legacy ↔ $acquiredTable.label collision ($legacyField ↔ $acquiredField, $direction)", row => {
    const db = schemaFixture();
    try {
      const collision = "preexisting-legacy-acquired-alias";
      if (row.direction === "legacy first") {
        insertLegacy(db, {
          external_id: row.legacyField === "external_id" ? collision : "legacy-external",
          project_alpha_public_id: row.legacyField === "project_alpha_public_id" ? collision : "legacy-public",
        });
        insertAcquired(db, row.acquiredTable.table, "preexisting-acquired", {
          field: row.acquiredField, value: collision,
        });
      } else {
        insertAcquired(db, row.acquiredTable.table, "preexisting-acquired", {
          field: row.acquiredField, value: collision,
        });
        insertLegacy(db, {
          external_id: row.legacyField === "external_id" ? collision : "legacy-external",
          project_alpha_public_id: row.legacyField === "project_alpha_public_id" ? collision : "legacy-public",
        });
      }
      expectPreflightRejectsWithoutReplacingGuards(db);
    } finally { db.close(); }
  });

  it.each(acquiredCases)("preflight rejects existing $leftTable.label ↔ $rightTable.label alias ($leftField ↔ $rightField)", row => {
    const db = schemaFixture();
    try {
      const collision = "preexisting-acquired-cross-field-alias";
      insertAcquired(db, row.leftTable.table, "preexisting-left", {
        field: row.leftField, value: collision,
      });
      insertAcquired(db, row.rightTable.table, "preexisting-right", {
        field: row.rightField, value: collision,
      });
      expectPreflightRejectsWithoutReplacingGuards(db);
    } finally { db.close(); }
  });

  it("preflight rejects canonical and owner-claim identities that disagree for one receipt", () => {
    const db = schemaFixture();
    try {
      insertAcquired(db, acquiredTables[0].table, "same-receipt-canonical", undefined, "receipt-shared");
      insertAcquired(db, acquiredTables[1].table, "same-receipt-owner-claim", undefined, "receipt-shared");
      expectPreflightRejectsWithoutReplacingGuards(db);
    } finally { db.close(); }
  });

  it.each(legacyCases)("blocks legacy ↔ $acquiredTable.label collision ($legacyField ↔ $acquiredField, $direction)", row => {
    const db = fixture();
    try {
      const collision = "cross-field-identity";
      if (row.direction === "legacy first") {
        insertLegacy(db, {
          external_id: row.legacyField === "external_id" ? collision : "legacy-external",
          project_alpha_public_id: row.legacyField === "project_alpha_public_id" ? collision : "a".repeat(32),
        });
        expect(() => insertAcquired(db, row.acquiredTable.table, "new-acquired", {
          field: row.acquiredField, value: collision,
        })).toThrow(/collides/);
      } else {
        insertAcquired(db, row.acquiredTable.table, "existing-acquired", {
          field: row.acquiredField, value: collision,
        });
        expect(() => insertLegacy(db, {
          external_id: row.legacyField === "external_id" ? collision : "new-legacy-external",
          project_alpha_public_id: row.legacyField === "project_alpha_public_id" ? collision : "b".repeat(32),
        })).toThrow(/collides/);
      }
    } finally { db.close(); }
  });

  it.each(acquiredCases)("blocks $leftTable.label ↔ $rightTable.label collision ($leftField ↔ $rightField)", row => {
    const db = fixture();
    try {
      const collision = "acquired-cross-field-identity";
      insertAcquired(db, row.leftTable.table, "existing", { field: row.leftField, value: collision });
      expect(() => insertAcquired(db, row.rightTable.table, "new", {
        field: row.rightField, value: collision,
      })).toThrow(/collides/);
    } finally { db.close(); }
  });
});
