import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { WINDOWS_SCHEMA_QUERY } from "./windows-files-schema-query.mjs";
import { WINDOWS_STAGING_READ_QUERIES } from "./windows-files-staging-preflight.mjs";

test("schema observation excludes only the actual reserved SQLite namespace", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE sqliteX_visible(value TEXT);
      CREATE TABLE regular(id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE _cf_METADATA(value TEXT);
      CREATE TABLE d1_migrations(name TEXT);`);
    const oldNames = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    assert.ok(!oldNames.includes("sqliteX_visible"));
    assert.ok(db.prepare("SELECT name FROM sqlite_master").all().some(row => row.name === "sqlite_sequence"));
    assert.equal(WINDOWS_STAGING_READ_QUERIES.schema, WINDOWS_SCHEMA_QUERY);
    const names = db.prepare(WINDOWS_SCHEMA_QUERY).all().map(row => row.name);
    assert.deepEqual(names, ["_cf_METADATA", "d1_migrations", "regular", "sqliteX_visible"]);
  } finally {
    db.close();
  }
});
