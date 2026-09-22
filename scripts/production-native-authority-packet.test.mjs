import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AUTHORITY_MIGRATIONS_TABLE,
  buildAuthorityArtifacts,
  validateGeneratedAuthority,
  validatePacketInput,
  writeGeneratedAuthority,
} from "./production-native-authority-packet.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const owner = Object.freeze({
  staffId: "staff-reviewed-owner",
  email: "reviewed-owner@example.invalid",
  displayName: "Reviewed Owner",
});
const production = Object.freeze({
  worker: Object.freeze({ name: "reviewed-operations-worker", environment: "production", workers_dev: false }),
  d1_databases: Object.freeze([
    Object.freeze({ binding: "DELIVERY_DB", database_name: "reviewed-delivery", database_id: "11111111-1111-4111-8111-111111111111" }),
    Object.freeze({ binding: "OPS_DB", database_name: "reviewed-operations", database_id: "22222222-2222-4222-8222-222222222222" }),
  ]),
});
const subject = "production-access-subject-reviewed-001";
const evidenceSha = "0123456789abcdef".repeat(4);
const issuedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

function input(overrides = {}) {
  const value = {
    schemaVersion: 1,
    production,
    packet: {
      packetId: "production-authority-project-v2-001",
      mode: "create",
      ...owner,
      accessSubject: subject,
      issuedAt,
      expiresAt,
      reason: "Bounded production native Directory and Project authority window",
      expected: {
        admissionVersion: 0,
        profileVersion: 0,
        directoryGrantVersion: 0,
        directoryGrantGeneration: 0,
        projectGrantVersion: 0,
        projectGrantGeneration: 0,
      },
      evidence: {
        changeTicket: "change-production-001",
        reviewer: "reviewer-production-001",
        bindingEvidenceSha256: evidenceSha,
      },
    },
  };
  return { ...value, ...overrides, packet: { ...value.packet, ...(overrides.packet ?? {}) } };
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-production-native-authority-"));
  const app = path.join(base, "apps", "operations");
  fs.mkdirSync(app, { recursive: true });
  fs.cpSync(path.join(repositoryRoot, "apps", "operations", "migrations"), path.join(app, "migrations"), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "apps", "operations", "wrangler.jsonc"), "utf8"));
  config.name = production.worker.name;
  config.vars.ENVIRONMENT = production.worker.environment;
  config.workers_dev = production.worker.workers_dev;
  config.d1_databases = config.d1_databases.map(database => {
    const expected = production.d1_databases.find(item => item.binding === database.binding);
    return { ...database, database_name: expected.database_name, database_id: expected.database_id };
  });
  fs.writeFileSync(path.join(app, "wrangler.jsonc"), JSON.stringify(config));
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
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".sql")).sort())
    applyMigration(db, fs.readFileSync(path.join(directory, name), "utf8"), name);
  db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status,last_seen_at)
    VALUES(?,?,?,?,'active',datetime('now'))`).run(owner.staffId, owner.email, owner.displayName, subject);
  db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key)
    VALUES('assignment-reviewed-owner',?,'role-owner','global','global')`).run(owner.staffId);
  db.exec(`CREATE TABLE ${AUTHORITY_MIGRATIONS_TABLE}(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  return db;
}

test("accepts a strictly reviewed production owner tuple and create-mode zero state", () => {
  assert.deepEqual(validatePacketInput(input()), []);
  for (const invalid of [
    input({ extra: true }),
    { ...input(), schemaVersion: 2 },
    input({ packet: { mode: "reactivate" } }),
    input({ packet: { staffId: "invalid" } }),
    input({ packet: { email: "Not-Normalized@Example.invalid" } }),
    input({ packet: { displayName: "REPLACE_ME" } }),
    input({ production: { ...production, worker: { ...production.worker, environment: "staging" } } }),
    input({ packet: { accessSubject: "aaa.bbb.ccc" } }),
    input({ packet: { expected: { ...input().packet.expected, directoryGrantGeneration: 1 } } }),
    input({ packet: { expiresAt: new Date(Date.parse(issuedAt) + 5 * 60 * 60 * 1000).toISOString() } }),
    input({ packet: { evidence: { changeTicket: "REPLACE_ME", reviewer: "reviewer", bindingEvidenceSha256: "0".repeat(64) } } }),
  ]) assert(validatePacketInput(invalid).length > 0);
});

test("builds production-only one-migration configs and sanitized manifests through 0124", () => {
  const artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  for (const action of ["provision", "revoke"]) {
    const config = artifact.configs[action];
    assert.deepEqual(Object.keys(config).sort(), ["$schema", "compatibility_date", "compatibility_flags", "d1_databases", "main", "name", "workers_dev"].sort());
    assert.equal(config.d1_databases.length, 1);
    assert.deepEqual(config.d1_databases[0], {
      binding: "OPS_DB",
      database_name: production.d1_databases[1].database_name,
      database_id: production.d1_databases[1].database_id,
      migrations_dir: `.production-native-authority/${input().packet.packetId}/${action}`,
      migrations_table: AUTHORITY_MIGRATIONS_TABLE,
    });
    assert.equal(Object.hasOwn(config, "routes"), false);
    assert.equal(Object.hasOwn(config, "vars"), false);
    assert.equal(Object.hasOwn(config, "account_id"), false);
  }
  assert.notEqual(artifact.provision.name, artifact.revoke.name);
  assert.equal(artifact.provision.manifest.canonicalOperationsLedger.count, 124);
  assert.equal(artifact.provision.manifest.canonicalOperationsLedger.finalMigration,
    "0124_project_alpha_project_adoption_review_evidence.sql");
  const manifests = JSON.stringify([artifact.provision.manifest, artifact.revoke.manifest]);
  assert.doesNotMatch(manifests, new RegExp(owner.email.replaceAll(".", "\\.")));
  assert.doesNotMatch(manifests, new RegExp(subject));
  assert.doesNotMatch(manifests, new RegExp(owner.displayName));
  assert.match(artifact.provision.sql, /directory\.profile\.edit/);
  assert.match(artifact.provision.sql, /project\.shared\.sync/);
  assert.match(artifact.provision.sql, /native_directory_grant_history/);
  assert.match(artifact.provision.sql, /native_project_grant_generations/);
  assert.match(artifact.provision.sql, /SELECT count\(\*\) FROM d1_migrations/);
});

test("writes separate immutable provision and revoke artifact sets", () => {
  const base = fixture();
  const provision = buildAuthorityArtifacts(base, input(), "provision");
  assert.equal(writeGeneratedAuthority(base, provision).length, 3);
  assert.deepEqual(validateGeneratedAuthority(base, provision), []);
  const provisionDir = path.join(base, "apps", "operations", ".production-native-authority", input().packet.packetId, "provision");
  assert.deepEqual(fs.readdirSync(provisionDir), [provision.provision.name]);

  const revoke = buildAuthorityArtifacts(base, input(), "revoke");
  assert.equal(writeGeneratedAuthority(base, revoke).length, 3);
  assert.deepEqual(validateGeneratedAuthority(base, revoke), []);
  const revokeDir = path.join(base, "apps", "operations", ".production-native-authority", input().packet.packetId, "revoke");
  assert.deepEqual(fs.readdirSync(revokeDir), [revoke.revoke.name]);
  fs.appendFileSync(path.join(revokeDir, revoke.revoke.name), "-- drift\n");
  assert(validateGeneratedAuthority(base, revoke).some(error => error.includes("stale or was edited")));
  assert.throws(() => writeGeneratedAuthority(base, revoke), /invalid or stale/);
});

test("fails closed for production D1 identity and canonical migration drift", () => {
  const wrong = fixture();
  const configFile = path.join(wrong, "apps", "operations", "wrangler.jsonc");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.d1_databases.find(row => row.binding === "OPS_DB").database_id = "wrong-production-database";
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.throws(() => buildAuthorityArtifacts(wrong, input(), "provision"), /pinned production D1 inventory/);

  const drift = fixture();
  fs.appendFileSync(path.join(drift, "apps", "operations", "migrations", "0123_native_directory_authority_history.sql"), " ");
  assert.throws(() => buildAuthorityArtifacts(drift, input(), "provision"), /contents changed/);
});

test("canonical schema provisions and revokes exactly one bounded authority set", () => {
  const db = canonicalDatabase();
  const artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.staffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT login_email,display_name,version FROM native_staff_profiles WHERE staff_id=?", owner.staffId),
    { login_email: owner.email, display_name: owner.displayName, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,scope_kind,permission,effect FROM native_directory_grants WHERE staff_id=?", owner.staffId),
    { active: 1, scope_kind: "global", permission: "directory.profile.edit", effect: "allow" });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?", owner.staffId), { generation: 1 });
  assert.deepEqual(queryOne(db, `SELECT grant_version,active,grant_generation FROM native_directory_grant_history
    WHERE staff_id=? ORDER BY grant_version`, owner.staffId), { grant_version: 1, active: 1, grant_generation: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version,scope_kind,capability FROM native_project_grants WHERE staff_id=?", owner.staffId),
    { active: 1, version: 1, scope_kind: "global", capability: "project.shared.sync" });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_project_grant_generations WHERE staff_id=?", owner.staffId), { generation: 1 });

  applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.staffId), { active: 0, version: 2 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE staff_id=?", owner.staffId), { active: 0 });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?", owner.staffId), { generation: 2 });
  assert.deepEqual(db.prepare(`SELECT grant_version,active,grant_generation FROM native_directory_grant_history
    WHERE staff_id=? ORDER BY grant_version`).all(owner.staffId).map(row => ({ ...row })), [
    { grant_version: 1, active: 1, grant_generation: 1 },
    { grant_version: 2, active: 0, grant_generation: 2 },
  ]);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.staffId), { active: 0, version: 2 });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_project_grant_generations WHERE staff_id=?", owner.staffId), { generation: 2 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts WHERE operator_staff_id=?", owner.staffId).count, 2);
  db.close();
});

test("provision rejects canonical and auxiliary ledger drift atomically", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "provision");
  db.prepare("DELETE FROM d1_migrations WHERE name='0124_project_alpha_project_adoption_review_evidence.sql'").run();
  assert.throws(() => applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_admissions WHERE staff_id=?", owner.staffId).count, 0);
  db.prepare("INSERT INTO d1_migrations(name) VALUES('0124_project_alpha_project_adoption_review_evidence.sql')").run();
  db.prepare(`INSERT INTO ${AUTHORITY_MIGRATIONS_TABLE}(name) VALUES('unexpected.sql')`).run();
  assert.throws(() => applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 0);
  db.close();
});

test("revoke fails closed on Directory history or Project version drift", () => {
  for (const drift of [
    db => { db.prepare("UPDATE native_directory_grants SET active=0 WHERE staff_id=?").run(owner.staffId); db.prepare("UPDATE native_directory_grants SET active=1 WHERE staff_id=?").run(owner.staffId); },
    db => { db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE staff_id=?").run(owner.staffId); db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE staff_id=?").run(owner.staffId); },
  ]) {
    const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
    applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
    drift(db);
    assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
    assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
    assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
    db.close();
  }
});

test("revoke fails atomically while an actor Directory command is pending", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,
    actor_admission_version,permission,record_id,record_kind,expected_version,selected_grant_id,scopes_json,
    profile_json,command_json,destinations_json,intent_writes)
    VALUES(?,'update',?,?,1,'directory.profile.edit',?,'organization',1,?,'[]','{}','{}','[]',0)`)
    .run("production-pending-directory-fence", owner.staffId, subject, "production-pending-directory-record", artifact.ids.directoryGrant);
  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.staffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE staff_id=?", owner.staffId), { active: 1 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  db.close();
});

test("revoke fails atomically while an actor Project command is pending", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  const externalProjectId = "production-project-pending";
  const commandId = "00000000-0000-4000-8000-000000000030";
  const sourceId = "project-alpha:production";
  const applicationId = "00000000-0000-4000-8000-000000000031";
  const sourceInstanceId = "00000000-0000-4000-8000-000000000032";
  const historyEpochId = "00000000-0000-4000-8000-000000000033";
  const destination = "https://project-alpha.example.invalid";
  db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,
    expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,?,?,?)`)
    .run(externalProjectId, sourceId, applicationId, destination, sourceInstanceId, historyEpochId);
  db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,
    actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(commandId, externalProjectId, owner.staffId, subject, 1, 1, owner.email, expiresAt, 1, "[]");
  db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,application_id,
    destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,expected_history_epoch_id)
    VALUES(?,?,'create','{}',?,?,?,?,?,'pending',0,0,?)`)
    .run(commandId, externalProjectId, sourceId, applicationId, destination, sourceInstanceId,
      JSON.stringify({ actorId: owner.staffId }), historyEpochId);
  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.staffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.staffId), { active: 1, version: 1 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  db.close();
});

test("late failures roll back every provision and revoke mutation", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  const failingProvision = `${artifact.provision.sql}\nCREATE TABLE forced_packet_failure(ok INTEGER CHECK(ok=1));\nINSERT INTO forced_packet_failure VALUES(0);`;
  assert.throws(() => applyMigration(db, failingProvision, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_admissions WHERE staff_id=?", owner.staffId).count, 0);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_directory_grant_history WHERE staff_id=?", owner.staffId).count, 0);
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  const failingRevoke = `${artifact.revoke.sql}\nCREATE TABLE forced_revoke_failure(ok INTEGER CHECK(ok=1));\nINSERT INTO forced_revoke_failure VALUES(0);`;
  assert.throws(() => applyMigration(db, failingRevoke, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.staffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE staff_id=?", owner.staffId), { active: 1 });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?", owner.staffId), { generation: 1 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  db.close();
});
