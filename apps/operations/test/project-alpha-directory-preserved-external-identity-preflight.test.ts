import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

const migration = readFileSync(new URL("../migrations/0174_project_alpha_directory_preserved_external_identity.sql", import.meta.url), "utf8");
let database: DatabaseSync | undefined;

function fixture(): DatabaseSync {
  database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE project_alpha_directory_read_adoption_finalizations(
      finalization_id TEXT PRIMARY KEY, reviewed_external_id TEXT NOT NULL
    );
    CREATE TABLE project_alpha_directory_reconciliation_findings(
      finding_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, resource_type TEXT NOT NULL, remote_public_id TEXT NOT NULL
    );
    CREATE TABLE project_alpha_directory_reconciliation_observations(
      run_id TEXT NOT NULL, resource_type TEXT NOT NULL, public_id TEXT NOT NULL,
      binding_external_id TEXT, binding_status TEXT, present INTEGER, binding_resource_revision TEXT
    );
    CREATE TABLE project_alpha_directory_reconciliation_actions(
      action_id TEXT PRIMARY KEY, finding_id TEXT NOT NULL
    );
    CREATE TABLE project_alpha_directory_reconciliation_action_outcomes(action_id TEXT PRIMARY KEY);
  `);
  return database;
}

function applyMigration(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    for (const statement of unstable_splitSqlQuery(migration.replace(/\r\n/g, "\n"))) {
      if (statement.trim()) db.exec(statement);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Transaction may already have rolled back. */ }
    throw error;
  }
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some(row => (row as { name: string }).name === column);
}

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("0174 preserved external identity migration preflight", () => {
  it("applies cleanly when no pre-existing acquisition work is in flight", () => {
    const db = fixture();
    applyMigration(db);

    expect(columnExists(db, "project_alpha_directory_read_adoption_finalizations", "acquisition_external_id")).toBe(true);
    expect(columnExists(db, "project_alpha_directory_reconciliation_actions", "external_id")).toBe(true);
  });

  it("rejects a pre-existing prepared finalization and rolls back every DDL change", () => {
    const db = fixture();
    db.prepare(`INSERT INTO project_alpha_directory_read_adoption_finalizations(finalization_id,reviewed_external_id)
      VALUES('prepared','sealed-pa-external-id')`).run();

    expect(() => applyMigration(db)).toThrow();
    expect(columnExists(db, "project_alpha_directory_read_adoption_finalizations", "acquisition_external_id")).toBe(false);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name='project_alpha_directory_read_adoption_finalizations_preserved_external_exact'`).get()).toBeUndefined();
  });

  it("rejects an unresolved reconciliation action and rolls back every DDL change", () => {
    const db = fixture();
    db.prepare(`INSERT INTO project_alpha_directory_reconciliation_actions(action_id,finding_id)
      VALUES('unresolved','finding')`).run();

    expect(() => applyMigration(db)).toThrow();
    expect(columnExists(db, "project_alpha_directory_reconciliation_actions", "external_id")).toBe(false);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name='project_alpha_directory_reconciliation_actions_preserved_external_exact'`).get()).toBeUndefined();
  });

  it("allows completed reconciliation history because its outcome is already durable", () => {
    const db = fixture();
    db.prepare(`INSERT INTO project_alpha_directory_reconciliation_actions(action_id,finding_id)
      VALUES('completed','finding')`).run();
    db.prepare(`INSERT INTO project_alpha_directory_reconciliation_action_outcomes(action_id) VALUES('completed')`).run();

    expect(() => applyMigration(db)).not.toThrow();
    expect(columnExists(db, "project_alpha_directory_reconciliation_actions", "external_id")).toBe(true);
  });
});
