import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AUTHORITY_MIGRATIONS_TABLE, buildAuthorityArtifacts } from "./production-native-authority-packet.mjs";

// This is a structural rehearsal with synthetic authority data. It is deliberately
// not evidence that the pending migrations have run against exact production data.
const root = path.resolve(import.meta.dirname, "..");
const migrationsDirectory = path.join(root, "apps", "operations", "migrations");
const ledgerCapture = path.join(root, "docs", "staging", "production-migration-ledger-order-2026-10-12.md");
const owner = Object.freeze({
  staffId: "staff-structural-rehearsal-owner",
  email: "structural-rehearsal-owner@example.invalid",
  displayName: "Structural Rehearsal Owner",
  accessSubject: "structural-rehearsal-access-subject-001",
});
const production = Object.freeze({
  worker: Object.freeze({ name: "structural-rehearsal-operations", environment: "production", workers_dev: false }),
  d1_databases: Object.freeze([
    Object.freeze({ binding: "DELIVERY_DB", database_name: "structural-rehearsal-delivery", database_id: "11111111-1111-4111-8111-111111111111" }),
    Object.freeze({ binding: "OPS_DB", database_name: "structural-rehearsal-operations", database_id: "22222222-2222-4222-8222-222222222222" }),
  ]),
});
const overrides = Object.freeze([
  Object.freeze({ id: "override-structural-delivery-browse", permissionKey: "delivery.browse", effect: "allow", scope: "global", divisionId: null, scopeKey: "global", createdBy: owner.staffId }),
  Object.freeze({ id: "override-structural-delivery-share-create", permissionKey: "delivery.share.create", effect: "allow", scope: "global", divisionId: null, scopeKey: "global", createdBy: owner.staffId }),
]);
const protectedTables = Object.freeze([
  "staff_users", "staff_role_assignments", "staff_permission_overrides",
  "native_staff_admissions", "native_staff_profiles", "native_staff_bootstrap_approvals",
  "native_staff_bootstrap_receipts", "native_directory_grants", "native_directory_grant_generations",
  "native_directory_grant_history", "native_project_grants", "native_project_grant_generations",
  AUTHORITY_MIGRATIONS_TABLE,
]);

function capturedOperationsLedger() {
  const operations = fs.readFileSync(ledgerCapture, "utf8").split("## Operations")[1]?.split("## Client")[0] ?? "";
  return [...operations.matchAll(/^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|$/gm)]
    .map(match => ({ id: Number(match[1]), name: match[2] }));
}

function sourceMigrations() {
  return fs.readdirSync(migrationsDirectory).filter(name => name.endsWith(".sql")).sort();
}

function applyMigration(db, name, table = "d1_migrations", sql = fs.readFileSync(path.join(migrationsDirectory, name), "utf8")) {
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(name);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
    throw error;
  }
}

function emptyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  return db;
}

function createAuxiliaryLedger(db) {
  db.exec(`CREATE TABLE ${AUTHORITY_MIGRATIONS_TABLE}(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
}

function packetFixture(baseNames) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-ops-upgrade-rehearsal-"));
  const app = path.join(base, "apps", "operations"), target = path.join(app, "migrations");
  fs.mkdirSync(target, { recursive: true });
  for (const name of baseNames) fs.copyFileSync(path.join(migrationsDirectory, name), path.join(target, name));
  const config = JSON.parse(fs.readFileSync(path.join(root, "apps", "operations", "wrangler.jsonc"), "utf8"));
  config.name = production.worker.name;
  config.vars.ENVIRONMENT = production.worker.environment;
  config.workers_dev = production.worker.workers_dev;
  config.d1_databases = config.d1_databases.map(database => {
    const identity = production.d1_databases.find(candidate => candidate.binding === database.binding);
    return { ...database, database_name: identity.database_name, database_id: identity.database_id };
  });
  fs.writeFileSync(path.join(app, "wrangler.jsonc"), JSON.stringify(config));
  return base;
}

function packetInput() {
  return {
    schemaVersion: 1,
    production,
    packet: {
      packetId: "production-authority-project-v2-001",
      mode: "create",
      staffId: owner.staffId,
      email: owner.email,
      displayName: owner.displayName,
      accessSubject: owner.accessSubject,
      issuedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      reason: "Synthetic local structural upgrade rehearsal",
      permissionOverrides: overrides,
      expected: { admissionVersion: 0, profileVersion: 0, directoryGrantVersion: 0, directoryGrantGeneration: 0, projectGrantVersion: 0, projectGrantGeneration: 0 },
      evidence: { changeTicket: "synthetic-structural-rehearsal", reviewer: "synthetic-reviewer", bindingEvidenceSha256: "0123456789abcdef".repeat(4) },
    },
  };
}

function seedReviewedOwner(db) {
  db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status,last_seen_at)
    VALUES(?,?,?,?,'active',datetime('now'))`).run(owner.staffId, owner.email, owner.displayName, owner.accessSubject);
  db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key)
    VALUES('assignment-structural-rehearsal-owner',?,'role-owner','global','global')`).run(owner.staffId);
  const insert = db.prepare(`INSERT INTO staff_permission_overrides
    (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,?,?,?,?,?,?)`);
  for (const row of overrides) insert.run(row.id, owner.staffId, row.permissionKey, row.effect, row.scope, row.divisionId, row.scopeKey, row.createdBy);
}

function canonicalRows(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  const order = columns.map(name => `\"${name.replaceAll('"', '""')}\"`).join(",");
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map(row => ({ ...row }));
}

function snapshot(db) {
  const value = Object.fromEntries(protectedTables.map(table => [table, canonicalRows(db, table)]));
  const bytes = Buffer.from(JSON.stringify(value));
  return { value, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function schema(db) {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().map(row => ({ ...row }));
}

test("synthetic pinned-9000 authority survives the captured 0124-to-0200 structural upgrade", () => {
  const captured = capturedOperationsLedger(), names = sourceMigrations();
  assert.equal(captured.length, 124);
  assert.deepEqual(captured.map(row => row.id), Array.from({ length: 124 }, (_, index) => index + 1));
  assert.deepEqual(names.slice(0, 124), captured.map(row => row.name));
  assert.equal(names.length, 200);
  assert.match(names[124], /^0125_/);
  assert.match(names.at(-1), /^0200_/);

  const db = emptyDatabase();
  for (const name of names.slice(0, 124)) applyMigration(db, name);
  seedReviewedOwner(db);
  createAuxiliaryLedger(db);
  const artifact = buildAuthorityArtifacts(packetFixture(names.slice(0, 124)), packetInput(), "provision");
  assert.equal(artifact.provision.name, "9000_production-authority-project-v2-001_provision.sql");
  applyMigration(db, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE, artifact.provision.sql);

  const before = snapshot(db);
  for (const name of names.slice(124)) applyMigration(db, name);
  const after = snapshot(db);
  assert.deepEqual(after.value, before.value);
  assert(before.bytes.equals(after.bytes));
  assert.equal(after.sha256, before.sha256);

  assert.deepEqual(db.prepare("SELECT id,name FROM d1_migrations ORDER BY id").all().map(row => ({ ...row })),
    names.map((name, index) => ({ id: index + 1, name })));
  assert.deepEqual(db.prepare(`SELECT id,name,applied_at FROM ${AUTHORITY_MIGRATIONS_TABLE} ORDER BY id`).all().map(row => ({ ...row })),
    before.value[AUTHORITY_MIGRATIONS_TABLE]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);

  const canonical = emptyDatabase();
  for (const name of names) applyMigration(canonical, name);
  createAuxiliaryLedger(canonical);
  assert.deepEqual(schema(db), schema(canonical));
  canonical.close();
  db.close();
});
