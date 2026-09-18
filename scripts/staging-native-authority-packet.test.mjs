import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AUTHORITY_MIGRATIONS_TABLE, buildAuthorityArtifacts, validateGeneratedAuthority,
  validatePacketInput, writeGeneratedAuthority,
} from "./staging-native-authority-packet.mjs";
import { transformSeed } from "./staging-bootstrap.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const owner = Object.freeze({ email: "owner@staging.example.test", displayName: "Synthetic Staging Owner",
  clientStaffId: "staging-client-owner", operationsStaffId: "staging-operations-owner" });
const subject = "staging-access-subject-001";
const evidenceSha = "0123456789abcdef".repeat(4);
const issuedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

function input(overrides = {}) {
  const value = {
    schemaVersion: 1,
    packet: {
      packetId: "staging-authority-project-v2-001", mode: "create", staffId: owner.operationsStaffId,
      email: owner.email, displayName: owner.displayName, accessSubject: subject,
      issuedAt, expiresAt,
      reason: "Bounded joined Project-v2 staging acceptance",
      expected: { admissionVersion: 0, profileVersion: 0, grantVersion: 0, grantGeneration: 0 },
      evidence: { changeTicket: "change-staging-001", reviewer: "reviewer-staging-001", bindingEvidenceSha256: evidenceSha },
    },
  };
  return { ...value, ...overrides, packet: { ...value.packet, ...(overrides.packet ?? {}) } };
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-native-authority-"));
  const app = path.join(base, "apps", "operations");
  fs.mkdirSync(app, { recursive: true });
  fs.cpSync(path.join(repositoryRoot, "apps", "operations", "migrations"), path.join(app, "migrations"), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "docs", "staging", "operations.wrangler.json.example"), path.join(app, "wrangler.staging.json"));
  return base;
}

function queryOne(db, sql, ...values) {
  const row = db.prepare(sql).get(...values);
  return row ? { ...row } : row;
}
function applyMigration(db, sql, name, table = "d1_migrations") {
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

function canonicalDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  const directory = path.join(repositoryRoot, "apps", "operations", "migrations");
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
    const source = fs.readFileSync(path.join(directory, name), "utf8");
    applyMigration(db, name === "0002_seed_acl.sql" ? transformSeed("operations", source, owner) : source, name);
  }
  db.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
    .run(subject, owner.operationsStaffId);
  db.exec(`CREATE TABLE ${AUTHORITY_MIGRATIONS_TABLE}(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  return db;
}

test("validates a narrow, non-secret packet contract", () => {
  assert.deepEqual(validatePacketInput(input()), []);
  for (const invalid of [
    input({ extra: true }),
    input({ packet: { accessSubject: "aaa.bbb.ccc" } }),
    input({ packet: { email: "owner@example.test" } }),
    input({ packet: { staffId: "staff-owner" } }),
    input({ packet: { expiresAt: new Date(Date.parse(issuedAt) + 5 * 60 * 60 * 1000).toISOString() } }),
    input({ packet: { evidence: { changeTicket: "REPLACE_ME", reviewer: "reviewer", bindingEvidenceSha256: "0".repeat(64) } } }),
  ]) assert(validatePacketInput(invalid).length > 0);
});

test("builds separate one-migration configs with a dedicated ledger and sanitized manifests", () => {
  const artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  assert.equal(artifact.configs.provision.d1_databases.find(row => row.binding === "OPS_DB").migrations_table, AUTHORITY_MIGRATIONS_TABLE);
  assert.equal(artifact.configs.provision.d1_databases.find(row => row.binding === "OPS_DB").migrations_dir.endsWith("/provision"), true);
  assert.equal(artifact.configs.revoke.d1_databases.find(row => row.binding === "OPS_DB").migrations_dir.endsWith("/revoke"), true);
  assert.notEqual(artifact.provision.name, artifact.revoke.name);
  const manifests = JSON.stringify([artifact.provision.manifest, artifact.revoke.manifest]);
  assert.doesNotMatch(manifests, new RegExp(owner.email.replaceAll(".", "\\.")));
  assert.doesNotMatch(manifests, new RegExp(subject));
  assert.doesNotMatch(manifests, new RegExp(owner.displayName));
  assert.match(artifact.provision.sql, /project\.shared\.sync/);
  assert.match(artifact.provision.sql, /scope_kind='global'|,'global'/);
  assert.match(artifact.provision.sql, /SELECT count\(\*\) FROM d1_migrations/);
});

test("writes provision then revoke artifacts without exposing both migrations to either config", () => {
  const base = fixture();
  const provision = buildAuthorityArtifacts(base, input(), "provision");
  const provisionWritten = writeGeneratedAuthority(base, provision);
  assert.equal(provisionWritten.length, 3);
  assert.deepEqual(validateGeneratedAuthority(base, provision), []);
  const provisionDir = path.join(base, "apps", "operations", ".staging-native-authority", input().packet.packetId, "provision");
  assert.deepEqual(fs.readdirSync(provisionDir), [provision.provision.name]);

  const revoke = buildAuthorityArtifacts(base, input(), "revoke");
  const revokeWritten = writeGeneratedAuthority(base, revoke);
  assert.equal(revokeWritten.length, 3);
  assert.deepEqual(validateGeneratedAuthority(base, revoke), []);
  const revokeDir = path.join(base, "apps", "operations", ".staging-native-authority", input().packet.packetId, "revoke");
  assert.deepEqual(fs.readdirSync(revokeDir), [revoke.revoke.name]);
  fs.appendFileSync(path.join(revokeDir, revoke.revoke.name), "-- drift\n");
  assert(validateGeneratedAuthority(base, revoke).some(error => error.includes("stale or was edited")));
  assert.throws(() => writeGeneratedAuthority(base, revoke), /invalid or stale/);
});

test("fails closed for wrong staging identity and canonical migration drift", () => {
  const wrong = fixture();
  const configFile = path.join(wrong, "apps", "operations", "wrangler.staging.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.account_id = "production-account";
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.throws(() => buildAuthorityArtifacts(wrong, input(), "provision"), /exact staging Operations config/);

  const drift = fixture();
  fs.appendFileSync(path.join(drift, "apps", "operations", "migrations", "0086_native_shared_projects.sql"), " ");
  assert.throws(() => buildAuthorityArtifacts(drift, input(), "provision"), /contents changed/);
});

test("full canonical schema provisions, revokes, and reactivates exact native authority", () => {
  const db = canonicalDatabase();
  const base = fixture();
  const first = buildAuthorityArtifacts(base, input(), "revoke");
  applyMigration(db, first.provision.sql, first.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version,scope_kind,capability FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId),
    { active: 1, version: 1, scope_kind: "global", capability: "project.shared.sync" });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_project_grant_generations WHERE staff_id=?", owner.operationsStaffId), { generation: 1 });

  db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id)
    VALUES(?,?,?,?,?,?)`).run("staging-project-001", "project-alpha:staging", "00000000-0000-4000-8000-000000000001",
    "https://pa-staging.example.test", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003");
  db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,
    actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("00000000-0000-4000-8000-000000000004", "staging-project-001", owner.operationsStaffId,
    subject, 1, 1, owner.email, expiresAt, 1, "[]");
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_project_live_command_proofs WHERE actor_staff_id=?", owner.operationsStaffId).count, 1);

  applyMigration(db, first.revoke.sql, first.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 0, version: 2 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId), { active: 0, version: 2 });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_project_grant_generations WHERE staff_id=?", owner.operationsStaffId), { generation: 2 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_project_live_command_proofs WHERE actor_staff_id=?", owner.operationsStaffId).count, 0);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 2);

  const reactivationInput = input({ packet: { packetId: "staging-authority-project-v2-002", mode: "reactivate",
    expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 2 } } });
  const second = buildAuthorityArtifacts(base, reactivationInput, "provision");
  applyMigration(db, second.provision.sql, second.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 3 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 3 });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_project_grant_generations WHERE staff_id=?", owner.operationsStaffId), { generation: 3 });
  db.close();
});

test("late migration failure rolls authority and ledger row back", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "provision");
  const failing = `${artifact.provision.sql}\nCREATE TABLE forced_packet_failure(ok INTEGER CHECK(ok=1));\nINSERT INTO forced_packet_failure VALUES(0);`;
  assert.throws(() => applyMigration(db, failing, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId).count, 0);
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 0);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 0);
  db.close();
});

test("revoke fails atomically while an actor command is pending", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  const externalProjectId = "staging-project-pending", commandId = "00000000-0000-4000-8000-000000000010";
  const sourceId = "project-alpha:staging", applicationId = "00000000-0000-4000-8000-000000000011";
  const sourceInstanceId = "00000000-0000-4000-8000-000000000012", historyEpochId = "00000000-0000-4000-8000-000000000013";
  const destination = "https://pa-staging.example.test";
  db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,
    expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,?,?,?)`)
    .run(externalProjectId, sourceId, applicationId, destination, sourceInstanceId, historyEpochId);
  db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,
    actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(commandId, externalProjectId, owner.operationsStaffId, subject, 1, 1, owner.email, expiresAt, 1, "[]");
  db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,application_id,
    destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,expected_history_epoch_id)
    VALUES(?,?,'create','{}',?,?,?,?,?,'pending',0,0,?)`)
    .run(commandId, externalProjectId, sourceId, applicationId, destination, sourceInstanceId,
      JSON.stringify({ actorId: owner.operationsStaffId }), historyEpochId);
  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  db.close();
});

test("provision rejects canonical-ledger drift before writing authority", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "provision");
  db.prepare("DELETE FROM d1_migrations WHERE name='0122_project_alpha_project_v2_canonical_activation.sql'").run();
  assert.throws(() => applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId).count, 0);
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 0);
  db.close();
});
