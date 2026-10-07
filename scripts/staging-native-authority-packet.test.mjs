import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const seededOwner = Object.freeze({ email: "beaukoltz@ledgetopdroneservices.com", displayName: "Beau Koltz",
  operationsStaffId: "staff-beau-koltz" });
const subject = "staging-access-subject-001";
const evidenceSha = "0123456789abcdef".repeat(4);
const issuedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const acquisitionRecord = Object.freeze({ id: "staging-directory-acquisition-record", kind: "organization", version: 1 });
const activationId = "10000000-0000-4000-8000-000000000001";
const REVIEWED_OPERATIONS_180 = Object.freeze({ count: 180,
  finalMigration: "0180_project_alpha_project_v2_recovery_authorization.sql",
  namesSha256: "8d7fdaaa7b453b32dd5e67d1a670554bc1c03aedf41c8ecadaddbbccf632e266",
  chainSha256: "6603a620f33f7d6cd88e23189203ddcb8a753b16167cd5e8ae427a31cf51b4b3" });
const sha256 = value => createHash("sha256").update(value).digest("hex");
function reviewedOperationsMigrations() {
  const directory = path.join(repositoryRoot, "apps", "operations", "migrations");
  const names = fs.readdirSync(directory).filter(name => name.endsWith(".sql")).sort()
    .slice(0, REVIEWED_OPERATIONS_180.count);
  assert.equal(names.length, REVIEWED_OPERATIONS_180.count);
  assert.equal(names.at(-1), REVIEWED_OPERATIONS_180.finalMigration);
  assert.equal(sha256(names.join("\n")), REVIEWED_OPERATIONS_180.namesSha256);
  assert.equal(sha256(names.map(name => `${name}\0${sha256(fs.readFileSync(path.join(directory, name), "utf8"))}`).join("\n")),
    REVIEWED_OPERATIONS_180.chainSha256);
  return { directory, names };
}

function input(overrides = {}) {
  const value = {
    schemaVersion: 3,
    packet: {
      packetId: "staging-authority-project-v2-001", mode: "create", operatorKind: "synthetic",
      staffId: owner.operationsStaffId,
      email: owner.email, displayName: owner.displayName, accessSubject: subject,
      issuedAt, expiresAt,
      reason: "Bounded joined Project-v2 staging acceptance",
      expected: { admissionVersion: 0, profileVersion: 0, grantVersion: 0, grantGeneration: 0 },
      evidence: { changeTicket: "change-staging-001", reviewer: "reviewer-staging-001", bindingEvidenceSha256: evidenceSha },
    },
  };
  return { ...value, ...overrides, packet: { ...value.packet, ...(overrides.packet ?? {}) } };
}

function acquisitionInput(overrides = {}) {
  const value = input({ schemaVersion: 4, packet: {
    packetId: "staging-authority-directory-acquisition-001", purpose: "existing-directory-acquisition",
    recordId: acquisitionRecord.id, recordKind: acquisitionRecord.kind, recordVersion: acquisitionRecord.version,
    reason: "Bounded existing Directory acquisition staging acceptance",
    expected: { admissionVersion: 0, profileVersion: 0, grantVersion: 0, grantGeneration: 0, directoryAuthorityState: "absent" },
  } });
  return { ...value, ...overrides, packet: { ...value.packet, ...(overrides.packet ?? {}) } };
}

function fixtureInput(overrides = {}) {
  const value = input({ schemaVersion: 5, packet: {
    packetId: "staging-authority-empty-enrollment-fixture-001", purpose: "staging-empty-enrollment-fixture",
    businessAreaId: "area-default", mode: "reactivate", reason: "Bounded empty-enrollment fixture staging acceptance",
    expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 2 },
  } });
  return { ...value, ...overrides, packet: { ...value.packet, ...(overrides.packet ?? {}) } };
}

function recipientEnrollmentInput(overrides = {}) {
  const value = input({ schemaVersion: 6, packet: {
    packetId: "staging-authority-recipient-enrollment-001", purpose: "recipient-enrollment-portal-access",
    recordId: acquisitionRecord.id, recordKind: acquisitionRecord.kind, recordVersion: acquisitionRecord.version,
    activationId, mode: "reactivate", reason: "Bounded exact-resource recipient enrollment staging acceptance",
    expected: { admissionVersion: 4, profileVersion: 1, grantVersion: 4, grantGeneration: 4,
      directoryGrantGeneration: 6, profileGrantVersion: 4, identityGrantVersion: 2,
      portalGrantVersion: 0, portalGrantState: "absent", directoryAuthorityState: "v4-acquisition-inactive" },
  } });
  return { ...value, ...overrides, packet: { ...value.packet, ...(overrides.packet ?? {}) } };
}

function preservativeAcquisitionInput(overrides = {}) {
  const value = input({ schemaVersion: 7, packet: {
    packetId: "staging-authority-preservative-acquisition-001",
    purpose: "existing-directory-acquisition-preserving-onboarding-profile",
    recordId: acquisitionRecord.id, recordKind: acquisitionRecord.kind, recordVersion: acquisitionRecord.version,
    businessAreaId: "area-default", mode: "reactivate",
    reason: "Bounded existing Directory acquisition preserving reviewed onboarding history",
    expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 1,
      directoryGrantGeneration: 4, profileGrantVersion: 1, onboardingGrantVersion: 3,
      profileHistoryGenerations: [1], onboardingHistoryGenerations: [2, 3, 4],
      identityGrantVersion: 0, identityHistoryGenerations: [], identityGrantState: "absent",
      directoryAuthorityState: "v7-profile-plus-onboarding-inactive" },
  } });
  return { ...value, ...overrides, packet: { ...value.packet, ...(overrides.packet ?? {}) } };
}

function preservativeRecipientEnrollmentInput(overrides = {}) {
  const value = input({ schemaVersion: 8, packet: {
    packetId: "staging-authority-preservative-recipient-001",
    purpose: "recipient-enrollment-portal-access-preserving-onboarding-profile",
    recordId: acquisitionRecord.id, recordKind: acquisitionRecord.kind, recordVersion: acquisitionRecord.version,
    activationId, businessAreaId: "area-default", mode: "reactivate",
    reason: "Bounded portal access preserving reviewed onboarding history",
    expected: { admissionVersion: 4, profileVersion: 1, grantVersion: 2, grantGeneration: 1,
      directoryGrantGeneration: 8, profileGrantVersion: 3, onboardingGrantVersion: 3,
      activationReceiptDirectoryGrantGeneration: 6,
      profileHistoryGenerations: [1, 5, 7], onboardingHistoryGenerations: [2, 3, 4],
      identityGrantVersion: 2, identityHistoryGenerations: [6, 8],
      portalGrantVersion: 0, portalHistoryGenerations: [], portalGrantState: "absent",
      directoryAuthorityState: "v7-acquisition-plus-onboarding-inactive" },
  } });
  return { ...value, ...overrides, packet: { ...value.packet, ...(overrides.packet ?? {}) } };
}

function seedAcquisitionRecord(db, record = acquisitionRecord) {
  // This fixture models a record created before the temporary packet exists.  The
  // authoritative create path would itself require the staff admission and
  // directory.profile.edit grant that this test must prove starts absent, so only
  // this isolated in-memory setup bypasses the two record-insert triggers.
  db.exec("DROP TRIGGER operations_directory_records_write_guard_insert; DROP TRIGGER operations_directory_records_write_guard_insert_consume; DROP TRIGGER operations_directory_staging_empty_enrollment_fixture_enrollment_guard;");
  db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,?,?)")
    .run(record.id, record.kind, record.version);
}

function seedActivationReceipt(db, id = activationId, record = acquisitionRecord, directoryGrantGeneration = 4,
  activatedBy = owner.operationsStaffId, bypassGuards = true) {
  // The activation consumer is independently covered. This authority test
  // inserts only its durable output so v6/v8 can prove they pin the exact UUID.
  if (bypassGuards) db.exec(`DROP TRIGGER project_alpha_existing_directory_binding_activation_exact;
    DROP TRIGGER project_alpha_existing_directory_binding_activation_authority;
    DROP TRIGGER project_alpha_existing_directory_binding_activation_relationship;
    DROP TRIGGER project_alpha_existing_directory_binding_activation_generation_exact;
    PRAGMA foreign_keys=OFF;`);
  db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
    activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,
    record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
    project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,
    acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256,
    activated_by_staff_id,directory_grant_generation)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004", "10000000-0000-4000-8000-000000000005",
      record.id, "project-alpha:staging", "source-instance", "application", "history-epoch", record.kind,
      "external-record", "a".repeat(32), "revision-1", record.version, "1".repeat(64), "2".repeat(64),
      "3".repeat(64), "4".repeat(64), activatedBy, directoryGrantGeneration,
    );
  db.exec("PRAGMA foreign_keys=ON;");
}

function establishReviewedOnboardingLineage(db) {
  seedAcquisitionRecord(db);
  db.prepare(`INSERT OR IGNORE INTO native_business_areas(id,name,active) VALUES('area-default','Reviewed staging area',1)`).run();
  db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by,version)
    VALUES(?,?,0,?,2)`).run(owner.operationsStaffId, subject, owner.operationsStaffId);
  db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version) VALUES(?,?,?,1)`)
    .run(owner.operationsStaffId, owner.email, owner.displayName);
  db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,granted_by,version)
    VALUES(?,?,'project.shared.sync','allow','global',0,?,2)`)
    .run(`staging-project-sync:${owner.operationsStaffId}`, owner.operationsStaffId, owner.operationsStaffId);
  db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
    VALUES(?,?,'directory.profile.edit','allow','global',0,?)`)
    .run(`staging-directory-profile-edit:${owner.operationsStaffId}`, owner.operationsStaffId, owner.operationsStaffId);
  const onboardingId = `staging-onboarding-profile-edit:${createHash("sha256").update(`${owner.operationsStaffId}:area-default`).digest("hex").slice(0, 32)}`;
  db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by)
    VALUES(?,?,'directory.profile.edit','allow','business_area','area-default',0,?)`)
    .run(onboardingId, owner.operationsStaffId, owner.operationsStaffId);
  db.prepare("UPDATE native_directory_grants SET active=1 WHERE id=?").run(onboardingId);
  db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").run(onboardingId);
  return onboardingId;
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-native-authority-"));
  const app = path.join(base, "apps", "operations");
  const migrations = path.join(app, "migrations"), reviewed = reviewedOperationsMigrations();
  fs.mkdirSync(migrations, { recursive: true });
  for (const name of reviewed.names) fs.copyFileSync(path.join(reviewed.directory, name), path.join(migrations, name));
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

function canonicalDatabase(databaseOwner = owner) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  const { directory, names } = reviewedOperationsMigrations();
  for (const name of names) {
    const source = fs.readFileSync(path.join(directory, name), "utf8");
    const seeded = name === "0002_seed_acl.sql" && databaseOwner === owner
      ? transformSeed("operations", source, owner) : source;
    applyMigration(db, seeded, name);
  }
  db.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
    .run(subject, databaseOwner.operationsStaffId);
  db.exec(`CREATE TABLE ${AUTHORITY_MIGRATIONS_TABLE}(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  return db;
}

function establishInactiveV4Authority(db, base) {
  seedAcquisitionRecord(db);
  const v3 = buildAuthorityArtifacts(base, input(), "revoke");
  applyMigration(db, v3.provision.sql, v3.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, v3.revoke.sql, v3.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  const v4 = buildAuthorityArtifacts(base, acquisitionInput({ packet: {
    mode: "reactivate",
    expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 2,
      directoryAuthorityState: "v3-profile-only-inactive" },
  } }), "revoke");
  applyMigration(db, v4.provision.sql, v4.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, v4.revoke.sql, v4.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  seedActivationReceipt(db);
}

test("validates a narrow, non-secret packet contract", () => {
  assert.deepEqual(validatePacketInput(input()), []);
  assert.deepEqual(validatePacketInput(input({ packet: {
    operatorKind: "legacy-roster-staging", staffId: seededOwner.operationsStaffId,
    email: seededOwner.email, displayName: seededOwner.displayName,
  } })), []);
  assert.deepEqual(validatePacketInput(acquisitionInput()), []);
  assert.deepEqual(validatePacketInput(recipientEnrollmentInput()), []);
  assert.deepEqual(validatePacketInput(preservativeAcquisitionInput()), []);
  assert.deepEqual(validatePacketInput(preservativeRecipientEnrollmentInput()), []);
  for (const invalid of [
    input({ extra: true }),
    { ...input(), schemaVersion: 2 },
    input({ packet: { operatorKind: "production-roster" } }),
    input({ packet: { accessSubject: "aaa.bbb.ccc" } }),
    input({ packet: { email: "owner@example.test" } }),
    input({ packet: { staffId: "staff-owner" } }),
    input({ packet: { staffId: seededOwner.operationsStaffId } }),
    input({ packet: { email: seededOwner.email } }),
    input({ packet: { displayName: seededOwner.displayName } }),
    input({ packet: { operatorKind: "legacy-roster-staging", staffId: "staff-kollins-stirn",
      email: "kstirn@ledgetopdroneservices.com", displayName: "Kollins Stirn" } }),
    input({ packet: { expiresAt: new Date(Date.parse(issuedAt) + 5 * 60 * 60 * 1000).toISOString() } }),
    input({ packet: { evidence: { changeTicket: "REPLACE_ME", reviewer: "reviewer", bindingEvidenceSha256: "0".repeat(64) } } }),
    acquisitionInput({ packet: { purpose: "arbitrary-directory-grants" } }),
    acquisitionInput({ packet: { unexpectedGrant: "directory.identity.link" } }),
    acquisitionInput({ packet: { expected: { admissionVersion: 0, profileVersion: 0, grantVersion: 0, grantGeneration: 0, directoryAuthorityState: "v4-acquisition-inactive" } } }),
    fixtureInput({ packet: { mode: "create", expected: { admissionVersion: 0, profileVersion: 0, grantVersion: 0, grantGeneration: 0 } } }),
    acquisitionInput({ schemaVersion: 5, packet: { purpose: "existing-directory-acquisition-after-fixture",
      businessAreaId: "area-default" } }),
    acquisitionInput({ schemaVersion: 5, packet: { purpose: "existing-directory-acquisition-after-fixture",
      businessAreaId: "area-default", mode: "reactivate",
      expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 2,
        directoryAuthorityState: "v3-profile-only-inactive" } } }),
    recipientEnrollmentInput({ packet: { activationId: "not-a-uuid" } }),
    recipientEnrollmentInput({ packet: { mode: "create" } }),
    recipientEnrollmentInput({ packet: { permission: "directory.portal_access.manage" } }),
    recipientEnrollmentInput({ packet: { expected: { ...recipientEnrollmentInput().packet.expected,
      directoryAuthorityState: "v5-acquisition-inactive" } } }),
    recipientEnrollmentInput({ packet: { expected: { ...recipientEnrollmentInput().packet.expected,
      portalGrantState: "inactive", portalGrantVersion: 0 } } }),
    preservativeAcquisitionInput({ packet: { purpose: "existing-directory-acquisition" } }),
    preservativeAcquisitionInput({ packet: { expected: { ...preservativeAcquisitionInput().packet.expected,
      directoryAuthorityState: "v4-acquisition-inactive" } } }),
    preservativeAcquisitionInput({ packet: { expected: { ...preservativeAcquisitionInput().packet.expected,
      onboardingGrantVersion: 2 } } }),
    preservativeRecipientEnrollmentInput({ packet: { purpose: "recipient-enrollment-portal-access" } }),
    preservativeRecipientEnrollmentInput({ packet: { expected: { ...preservativeRecipientEnrollmentInput().packet.expected,
      directoryAuthorityState: "v4-acquisition-inactive" } } }),
  ]) assert(validatePacketInput(invalid).length > 0);
});

test("v4 acquisition packet activates, revokes, and reactivates only the exact two directory grants", () => {
  const db = canonicalDatabase(), base = fixture();
  seedAcquisitionRecord(db);
  const first = buildAuthorityArtifacts(base, acquisitionInput(), "revoke");
  applyMigration(db, first.provision.sql, first.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(db.prepare(`SELECT permission,active,scope_kind,effect,resource_id FROM native_directory_grants WHERE staff_id=? ORDER BY permission`)
    .all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.identity.link", active: 1, scope_kind: "resource", effect: "allow", resource_id: acquisitionRecord.id },
    { permission: "directory.profile.edit", active: 1, scope_kind: "global", effect: "allow", resource_id: null },
  ]);
  assert.deepEqual(first.provision.manifest.directoryGrants.map(grant => grant.permission), ["directory.profile.edit", "directory.identity.link"]);
  applyMigration(db, first.revoke.sql, first.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(db.prepare(`SELECT permission,active FROM native_directory_grants WHERE staff_id=? ORDER BY permission`)
    .all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.identity.link", active: 0 }, { permission: "directory.profile.edit", active: 0 },
  ]);
  const second = buildAuthorityArtifacts(base, acquisitionInput({ packet: {
    packetId: "staging-authority-directory-acquisition-002", mode: "reactivate",
    expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 2, directoryAuthorityState: "v4-acquisition-inactive" },
  } }), "provision");
  applyMigration(db, second.provision.sql, second.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(db.prepare(`SELECT permission,active FROM native_directory_grants WHERE staff_id=? ORDER BY permission`)
    .all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.identity.link", active: 1 }, { permission: "directory.profile.edit", active: 1 },
  ]);
  db.close();
});

test("v4 provision rejects a missing or stale reviewed directory record before granting authority", () => {
  for (const record of [
    { ...acquisitionRecord, version: acquisitionRecord.version + 1 },
    { ...acquisitionRecord, kind: "client" },
  ]) {
    const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), acquisitionInput(), "revoke");
    seedAcquisitionRecord(db, record);
    assert.throws(() => applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
    assert.equal(db.prepare("SELECT count(*) count FROM native_directory_grants WHERE staff_id=?").get(owner.operationsStaffId).count, 0);
    db.close();
  }
});

test("v4 can make the one explicit audited transition from an inactive v3 packet", () => {
  const db = canonicalDatabase(), base = fixture();
  seedAcquisitionRecord(db);
  const v3 = buildAuthorityArtifacts(base, input(), "revoke");
  applyMigration(db, v3.provision.sql, v3.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, v3.revoke.sql, v3.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area-default','Fixture area',1)").run();
  const v4 = buildAuthorityArtifacts(base, acquisitionInput({ packet: {
    mode: "reactivate",
    expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 2, directoryAuthorityState: "v3-profile-only-inactive" },
  } }), "provision");
  applyMigration(db, v4.provision.sql, v4.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(db.prepare(`SELECT permission,active FROM native_directory_grants WHERE staff_id=? ORDER BY permission`)
    .all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.identity.link", active: 1 }, { permission: "directory.profile.edit", active: 1 },
  ]);
  db.close();
});

test("v5 same-owner fixture lifecycle preserves inactive enrollment authority for its acquisition successor", () => {
  const db = canonicalDatabase(), base = fixture();
  db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area-default','Fixture area',1)").run();
  const v3 = buildAuthorityArtifacts(base, input(), "revoke");
  applyMigration(db, v3.provision.sql, v3.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, v3.revoke.sql, v3.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  const setup = buildAuthorityArtifacts(base, fixtureInput(), "revoke");
  applyMigration(db, setup.provision.sql, setup.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.equal(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", setup.ids.enrollmentGrant).active, 1);
  applyMigration(db, setup.revoke.sql, setup.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, `SELECT json_extract(result_json,'$.schemaVersion') schema_version,
    json_extract(result_json,'$.profileVersion') profile_version,
    json_extract(result_json,'$.grantVersion') grant_version,
    json_extract(result_json,'$.grantGeneration') grant_generation
    FROM native_staff_bootstrap_receipts WHERE command_id=?`, setup.ids.revokeCommand),
  { schema_version: 5, profile_version: 1, grant_version: 4, grant_generation: 4 });
  seedAcquisitionRecord(db);
  const acquisition = buildAuthorityArtifacts(base, acquisitionInput({ schemaVersion: 5, packet: {
    packetId: "staging-authority-directory-acquisition-after-fixture-001", purpose: "existing-directory-acquisition-after-fixture",
    businessAreaId: "area-default", mode: "reactivate",
    expected: { admissionVersion: 4, profileVersion: 1, grantVersion: 4, grantGeneration: 4, directoryAuthorityState: "v5-fixture-inactive" },
  } }), "revoke");
  applyMigration(db, acquisition.provision.sql, acquisition.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.equal(acquisition.provision.manifest.schemaVersion, 5);
  assert.equal(acquisition.provision.manifest.directoryGrants.at(-1).businessAreaIdSha256.length, 64);
  assert.deepEqual(db.prepare("SELECT permission,active FROM native_directory_grants WHERE staff_id=? ORDER BY permission").all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.enrollment.manage", active: 0 }, { permission: "directory.identity.link", active: 1 }, { permission: "directory.profile.edit", active: 1 },
  ]);
  applyMigration(db, acquisition.revoke.sql, acquisition.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(db.prepare("SELECT permission,active FROM native_directory_grants WHERE staff_id=? ORDER BY permission").all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.enrollment.manage", active: 0 }, { permission: "directory.identity.link", active: 0 }, { permission: "directory.profile.edit", active: 0 },
  ]);
  assert.deepEqual(db.prepare("SELECT json_extract(result_json,'$.schemaVersion') schema_version FROM native_staff_bootstrap_receipts WHERE command_id IN (?,?) ORDER BY command_id")
    .all(acquisition.ids.provisionCommand, acquisition.ids.revokeCommand).map(row => ({ ...row })), [{ schema_version: 5 }, { schema_version: 5 }]);
  db.close();
});

test("v6 activates and revokes only exact-resource portal access over inactive v4 authority", () => {
  const db = canonicalDatabase(), base = fixture();
  establishInactiveV4Authority(db, base);
  const packet = buildAuthorityArtifacts(base, recipientEnrollmentInput(), "revoke");
  assert.equal(packet.provision.manifest.schemaVersion, 6);
  assert.equal(packet.provision.manifest.purpose, "recipient-enrollment-portal-access");
  assert.equal(packet.provision.manifest.record.activationIdSha256.length, 64);
  assert.doesNotMatch(JSON.stringify([packet.provision.manifest, packet.revoke.manifest]), new RegExp(activationId));
  assert.match(packet.provision.sql, /directory\.portal_access\.manage','allow','resource'/);
  assert.doesNotMatch(packet.provision.sql, /directory\.portal_access\.manage','allow','global'/);
  assert.match(packet.revoke.sql, /intent\.state IN \('active','revoking'\)/);
  assert.doesNotMatch(packet.revoke.sql, /intent\.state IN \('issued','pending'/);

  applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId),
    { active: 1, version: 5 });
  assert.deepEqual(db.prepare(`SELECT permission,scope_kind,resource_id,active FROM native_directory_grants
    WHERE staff_id=? ORDER BY permission`).all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.identity.link", scope_kind: "resource", resource_id: acquisitionRecord.id, active: 0 },
    { permission: "directory.portal_access.manage", scope_kind: "resource", resource_id: acquisitionRecord.id, active: 1 },
    { permission: "directory.profile.edit", scope_kind: "global", resource_id: null, active: 0 },
  ]);
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?", owner.operationsStaffId),
    { generation: 7 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId),
    { active: 0, version: 4 });

  applyMigration(db, packet.revoke.sql, packet.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId),
    { active: 0, version: 6 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", packet.ids.portalAccessGrant), { active: 0 });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?", owner.operationsStaffId),
    { generation: 8 });
  assert.deepEqual(queryOne(db, `SELECT count(*) count,max(grant_version) version FROM native_directory_grant_history
    WHERE grant_id=?`, packet.ids.portalAccessGrant), { count: 2, version: 2 });
  db.close();
});

test("v6 repeats only by reactivating the same exact portal grant and history", () => {
  const db = canonicalDatabase(), base = fixture();
  establishInactiveV4Authority(db, base);
  const first = buildAuthorityArtifacts(base, recipientEnrollmentInput(), "revoke");
  applyMigration(db, first.provision.sql, first.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, first.revoke.sql, first.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  const secondInput = recipientEnrollmentInput({ packet: {
    packetId: "staging-authority-recipient-enrollment-002",
    expected: { ...recipientEnrollmentInput().packet.expected, admissionVersion: 6,
      directoryGrantGeneration: 8, portalGrantVersion: 2, portalGrantState: "inactive" },
  } });
  const second = buildAuthorityArtifacts(base, secondInput, "provision");
  applyMigration(db, second.provision.sql, second.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.equal(second.ids.portalAccessGrant, first.ids.portalAccessGrant);
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", second.ids.portalAccessGrant), { active: 1 });
  assert.deepEqual(queryOne(db, `SELECT count(*) count,max(grant_version) version FROM native_directory_grant_history
    WHERE grant_id=?`, second.ids.portalAccessGrant), { count: 3, version: 3 });
  db.close();
});

test("v6 fails closed on exact activation, admission, profile, generation, shape, and history drift", () => {
  for (const scenario of [
    { input: recipientEnrollmentInput({ packet: { activationId: "10000000-0000-4000-8000-000000000099" } }) },
    { mutate: db => db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('unexpected-v6-grant',?,'directory.profile.view','allow','global',0,?)`).run(owner.operationsStaffId, owner.operationsStaffId) },
    { mutate: db => db.prepare("UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?")
      .run(owner.operationsStaffId) },
    { mutate: db => db.prepare("UPDATE native_staff_profiles SET version=version+1 WHERE staff_id=?")
      .run(owner.operationsStaffId) },
    { mutate: db => {
      db.prepare("UPDATE native_directory_grants SET active=1 WHERE id=?").run(`staging-directory-profile-edit:${owner.operationsStaffId}`);
      db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").run(`staging-directory-profile-edit:${owner.operationsStaffId}`);
    } },
    { mutate: db => {
      db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE staff_id=?").run(owner.operationsStaffId);
      db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE staff_id=?").run(owner.operationsStaffId);
    } },
  ]) {
    const db = canonicalDatabase(), base = fixture();
    establishInactiveV4Authority(db, base);
    const packet = buildAuthorityArtifacts(base, scenario.input ?? recipientEnrollmentInput(), "provision");
    scenario.mutate?.(db);
    assert.throws(() => applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE));
    assert.equal(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE permission='directory.portal_access.manage'").count, 0);
    db.close();
  }
});

test("v6 revoke rejects altered provision evidence and in-flight actor work", () => {
  for (const mutate of [
    (db, packet) => {
      db.exec("DROP TRIGGER native_staff_bootstrap_approvals_update_guard;");
      db.prepare("UPDATE native_staff_bootstrap_approvals SET canonical_plan_sha256=? WHERE approval_id=?")
        .run("f".repeat(64), packet.ids.provisionApproval);
    },
    (db, packet) => {
      db.exec("DROP TRIGGER native_staff_bootstrap_receipts_no_update;");
      db.prepare("UPDATE native_staff_bootstrap_receipts SET result_json='{}',result_sha256=? WHERE command_id=?")
        .run("e".repeat(64), packet.ids.provisionCommand);
    },
    (db, packet) => db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,
      bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,
      selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes)
      VALUES(?,'update',?,?,5,'directory.profile.edit',?,'organization',1,?,'[]','{}','{}','[]',0)`)
      .run("staging-v6-inflight-fence", owner.operationsStaffId, subject, acquisitionRecord.id, packet.ids.directoryGrant),
  ]) {
    const db = canonicalDatabase(), base = fixture();
    establishInactiveV4Authority(db, base);
    const packet = buildAuthorityArtifacts(base, recipientEnrollmentInput(), "revoke");
    applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE);
    mutate(db, packet);
    assert.throws(() => applyMigration(db, packet.revoke.sql, packet.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
    assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId),
      { active: 1, version: 5 });
    assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", packet.ids.portalAccessGrant), { active: 1 });
    db.close();
  }
});

test("v7 acquisition preserves exact onboarding profile lineage through provision and revoke", () => {
  const db = canonicalDatabase(), base = fixture(), onboardingId = establishReviewedOnboardingLineage(db);
  const before = db.prepare(`SELECT grant_version,active,grant_generation FROM native_directory_grant_history
    WHERE grant_id=? ORDER BY grant_version`).all(onboardingId).map(row => ({ ...row }));
  const packet = buildAuthorityArtifacts(base, preservativeAcquisitionInput(), "revoke");
  assert.equal(packet.provision.manifest.schemaVersion, 7);
  assert.equal(packet.ids.onboardingProfileGrant, onboardingId);
  applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(db.prepare(`SELECT permission,scope_kind,active FROM native_directory_grants WHERE staff_id=? ORDER BY id`)
    .all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.identity.link", scope_kind: "resource", active: 1 },
    { permission: "directory.profile.edit", scope_kind: "global", active: 1 },
    { permission: "directory.profile.edit", scope_kind: "business_area", active: 0 },
  ]);
  assert.deepEqual(db.prepare(`SELECT grant_version,active,grant_generation FROM native_directory_grant_history
    WHERE grant_id=? ORDER BY grant_version`).all(onboardingId).map(row => ({ ...row })), before);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId), { active: 0, version: 2 });
  applyMigration(db, packet.revoke.sql, packet.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE staff_id=? AND active=1", owner.operationsStaffId), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT grant_version,active,grant_generation FROM native_directory_grant_history
    WHERE grant_id=? ORDER BY grant_version`).all(onboardingId).map(row => ({ ...row })), before);
  assert.deepEqual(queryOne(db, `SELECT count(*) count,max(grant_version) version FROM native_directory_grant_history WHERE grant_id=?`, packet.ids.directoryGrant), { count: 3, version: 3 });
  assert.deepEqual(queryOne(db, `SELECT count(*) count,max(grant_version) version FROM native_directory_grant_history WHERE grant_id=?`, packet.ids.identityGrant), { count: 2, version: 2 });
  db.close();
});

test("v7 acquisition repeats only over the exact three-grant inactive lineage", () => {
  const db = canonicalDatabase(), base = fixture();
  establishReviewedOnboardingLineage(db);
  const first = buildAuthorityArtifacts(base, preservativeAcquisitionInput(), "revoke");
  applyMigration(db, first.provision.sql, first.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, first.revoke.sql, first.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  const second = buildAuthorityArtifacts(base, preservativeAcquisitionInput({ packet: {
    packetId: "staging-authority-preservative-acquisition-002",
    expected: { ...preservativeAcquisitionInput().packet.expected, admissionVersion: 4,
      directoryGrantGeneration: 8, profileGrantVersion: 3, identityGrantVersion: 2,
      profileHistoryGenerations: [1, 5, 7],
      identityHistoryGenerations: [6, 8], identityGrantState: "inactive",
      directoryAuthorityState: "v7-acquisition-plus-onboarding-inactive" },
  } }), "revoke");
  applyMigration(db, second.provision.sql, second.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, second.revoke.sql, second.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.equal(second.ids.identityGrant, first.ids.identityGrant);
  assert.deepEqual(queryOne(db, `SELECT count(*) count,max(grant_version) version FROM native_directory_grant_history WHERE grant_id=?`, second.ids.onboardingProfileGrant), { count: 3, version: 3 });
  assert.deepEqual(queryOne(db, `SELECT count(*) count,max(grant_version) version FROM native_directory_grant_history WHERE grant_id=?`, second.ids.directoryGrant), { count: 5, version: 5 });
  assert.deepEqual(queryOne(db, `SELECT count(*) count,max(grant_version) version FROM native_directory_grant_history WHERE grant_id=?`, second.ids.identityGrant), { count: 4, version: 4 });
  db.close();
});

test("v7 rejects onboarding/history drift, unexpected grants, altered receipt, and in-flight work", () => {
  for (const scenario of [
    { before: db => db.prepare("UPDATE native_directory_grants SET active=1 WHERE scope_kind='business_area' AND permission='directory.profile.edit'").run() },
    { before: db => db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('unexpected-v7-grant',?,'directory.profile.view','allow','global',0,?)`).run(owner.operationsStaffId, owner.operationsStaffId) },
    { before: db => { db.exec("DROP TRIGGER native_directory_grant_history_no_update;"); db.prepare(`UPDATE native_directory_grant_history SET grant_generation=1 WHERE scope_kind='business_area' AND grant_version=1`).run(); } },
    { before: db => { db.exec("DROP TRIGGER native_directory_grant_history_no_update;"); db.prepare(`UPDATE native_directory_grant_history SET grant_generation=4 WHERE scope_kind='global' AND permission='directory.profile.edit' AND grant_version=1`).run(); } },
    { before: db => { db.exec("DROP TRIGGER native_directory_grants_identity; DROP TRIGGER native_directory_grants_generation_update;"); db.prepare(`UPDATE native_directory_grants SET effect='deny' WHERE scope_kind='business_area' AND permission='directory.profile.edit'`).run(); } },
    { before: db => { db.exec("DROP TRIGGER native_directory_grants_identity; DROP TRIGGER native_directory_grants_generation_update;"); db.prepare(`UPDATE native_directory_grants SET scope_kind='assigned',business_area_id=NULL WHERE scope_kind='business_area' AND permission='directory.profile.edit'`).run(); } },
    { before: db => { db.exec("DROP TRIGGER native_directory_grants_identity; DROP TRIGGER native_directory_grants_generation_update; INSERT INTO native_business_areas(id,name,active) VALUES('area-drift','Drift',1);"); db.prepare(`UPDATE native_directory_grants SET business_area_id='area-drift' WHERE scope_kind='business_area' AND permission='directory.profile.edit'`).run(); } },
    { before: db => { db.exec("DROP TRIGGER native_directory_grants_identity; DROP TRIGGER native_directory_grants_generation_update; PRAGMA foreign_keys=OFF;"); db.prepare(`UPDATE native_directory_grants SET id='staging-onboarding-profile-edit:wrong-reviewed-id' WHERE scope_kind='business_area' AND permission='directory.profile.edit'`).run(); db.exec("PRAGMA foreign_keys=ON;"); } },
    { before: db => { db.exec("DROP TRIGGER native_directory_grant_history_no_delete;"); db.prepare(`DELETE FROM native_directory_grant_history WHERE scope_kind='business_area' AND grant_version=2`).run(); } },
    { after: (db, packet) => { db.exec("DROP TRIGGER native_staff_bootstrap_receipts_no_update;"); db.prepare("UPDATE native_staff_bootstrap_receipts SET result_sha256=? WHERE command_id=?").run("e".repeat(64), packet.ids.provisionCommand); } },
    { after: (db, packet) => db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,
      actor_admission_version,permission,record_id,record_kind,expected_version,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes)
      VALUES(?,'update',?,?,3,'directory.profile.edit',?,'organization',1,?,'[]','{}','{}','[]',0)`)
      .run("staging-v7-inflight", owner.operationsStaffId, subject, acquisitionRecord.id, packet.ids.directoryGrant) },
  ]) {
    const db = canonicalDatabase(), base = fixture(); establishReviewedOnboardingLineage(db);
    const packet = buildAuthorityArtifacts(base, preservativeAcquisitionInput(), "revoke");
    if (scenario.before) {
      scenario.before(db);
      assert.throws(() => applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE));
      assert.deepEqual(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE permission='directory.identity.link'"), { count: 0 });
    } else {
      applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE);
      scenario.after(db, packet);
      assert.throws(() => applyMigration(db, packet.revoke.sql, packet.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
      assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", packet.ids.identityGrant), { active: 1 });
    }
    db.close();
  }
});

test("v8 portal phase preserves all three prior grants and exact onboarding history", () => {
  const db = canonicalDatabase(), base = fixture(), onboardingId = establishReviewedOnboardingLineage(db);
  const acquisition = buildAuthorityArtifacts(base, preservativeAcquisitionInput(), "revoke");
  applyMigration(db, acquisition.provision.sql, acquisition.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  seedActivationReceipt(db, activationId, acquisitionRecord, 6);
  applyMigration(db, acquisition.revoke.sql, acquisition.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  const before = db.prepare(`SELECT * FROM native_directory_grant_history WHERE grant_id IN (?,?,?) ORDER BY grant_id,grant_version`)
    .all(acquisition.ids.directoryGrant, acquisition.ids.identityGrant, onboardingId).map(row => ({ ...row }));
  const grantsBefore = db.prepare(`SELECT * FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id`)
    .all(acquisition.ids.directoryGrant, acquisition.ids.identityGrant, onboardingId).map(row => ({ ...row }));
  const packet = buildAuthorityArtifacts(base, preservativeRecipientEnrollmentInput(), "revoke");
  assert.equal(packet.provision.manifest.schemaVersion, 8);
  applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE staff_id=? AND active=1", owner.operationsStaffId), { count: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", packet.ids.portalAccessGrant), { active: 1 });
  applyMigration(db, packet.revoke.sql, packet.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(db.prepare(`SELECT * FROM native_directory_grant_history WHERE grant_id IN (?,?,?) ORDER BY grant_id,grant_version`)
    .all(acquisition.ids.directoryGrant, acquisition.ids.identityGrant, onboardingId).map(row => ({ ...row })), before);
  assert.deepEqual(db.prepare(`SELECT * FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id`)
    .all(acquisition.ids.directoryGrant, acquisition.ids.identityGrant, onboardingId).map(row => ({ ...row })), grantsBefore);
  assert.deepEqual(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE staff_id=? AND active=1", owner.operationsStaffId), { count: 0 });
  db.close();
});

test("v8 repeats the same portal grant and fails closed on activation or lineage drift", () => {
  const db = canonicalDatabase(), base = fixture(); establishReviewedOnboardingLineage(db);
  const acquisition = buildAuthorityArtifacts(base, preservativeAcquisitionInput(), "revoke");
  applyMigration(db, acquisition.provision.sql, acquisition.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  seedActivationReceipt(db, activationId, acquisitionRecord, 6);
  applyMigration(db, acquisition.revoke.sql, acquisition.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  const first = buildAuthorityArtifacts(base, preservativeRecipientEnrollmentInput(), "revoke");
  applyMigration(db, first.provision.sql, first.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, first.revoke.sql, first.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  const second = buildAuthorityArtifacts(base, preservativeRecipientEnrollmentInput({ packet: {
    packetId: "staging-authority-preservative-recipient-002",
    expected: { ...preservativeRecipientEnrollmentInput().packet.expected, admissionVersion: 6,
      directoryGrantGeneration: 10, portalGrantVersion: 2, portalHistoryGenerations: [9, 10], portalGrantState: "inactive" },
  } }), "provision");
  applyMigration(db, second.provision.sql, second.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.equal(second.ids.portalAccessGrant, first.ids.portalAccessGrant);
  assert.deepEqual(queryOne(db, `SELECT count(*) count,max(grant_version) version FROM native_directory_grant_history WHERE grant_id=?`, second.ids.portalAccessGrant), { count: 3, version: 3 });
  db.close();

  for (const mutate of [
    (database) => database.prepare("UPDATE native_directory_grants SET active=1 WHERE scope_kind='business_area' AND permission='directory.profile.edit'").run(),
    (database) => database.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('unexpected-v8-grant',?,'directory.profile.view','allow','global',0,?)`).run(owner.operationsStaffId, owner.operationsStaffId),
    (database) => { database.exec("DROP TRIGGER native_directory_grant_history_no_update;"); database.prepare(`UPDATE native_directory_grant_history SET grant_generation=7 WHERE permission='directory.identity.link' AND grant_version=1`).run(); },
  ]) {
    const driftDb = canonicalDatabase(), driftBase = fixture(); establishReviewedOnboardingLineage(driftDb);
    const setup = buildAuthorityArtifacts(driftBase, preservativeAcquisitionInput(), "revoke");
    applyMigration(driftDb, setup.provision.sql, setup.provision.name, AUTHORITY_MIGRATIONS_TABLE);
    seedActivationReceipt(driftDb, activationId, acquisitionRecord, 6);
    applyMigration(driftDb, setup.revoke.sql, setup.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
    mutate(driftDb);
    const portal = buildAuthorityArtifacts(driftBase, preservativeRecipientEnrollmentInput(), "provision");
    assert.throws(() => applyMigration(driftDb, portal.provision.sql, portal.provision.name, AUTHORITY_MIGRATIONS_TABLE));
    driftDb.close();
  }
});

test("v8 rejects a wrong activation and blocks revoke on altered evidence or in-flight work", () => {
  for (const scenario of [
    { input: preservativeRecipientEnrollmentInput({ packet: { activationId: "10000000-0000-4000-8000-000000000099" } }) },
    { wrongGeneration: 5 },
    { after: (db, packet) => { db.exec("DROP TRIGGER native_staff_bootstrap_receipts_no_update;"); db.prepare("UPDATE native_staff_bootstrap_receipts SET result_json='{}',result_sha256=? WHERE command_id=?").run("d".repeat(64), packet.ids.provisionCommand); } },
    { after: (db, packet) => db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,
      bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,
      selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes)
      VALUES(?,'update',?,?,5,'directory.profile.edit',?,'organization',1,?,'[]','{}','{}','[]',0)`)
      .run("staging-v8-inflight", owner.operationsStaffId, subject, acquisitionRecord.id, packet.ids.directoryGrant) },
  ]) {
    const db = canonicalDatabase(), base = fixture(); establishReviewedOnboardingLineage(db);
    const acquisition = buildAuthorityArtifacts(base, preservativeAcquisitionInput(), "revoke");
    applyMigration(db, acquisition.provision.sql, acquisition.provision.name, AUTHORITY_MIGRATIONS_TABLE);
    seedActivationReceipt(db, activationId, acquisitionRecord, scenario.wrongGeneration ?? 6);
    applyMigration(db, acquisition.revoke.sql, acquisition.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
    const packet = buildAuthorityArtifacts(base, scenario.input ?? preservativeRecipientEnrollmentInput(), "revoke");
    if (scenario.input || scenario.wrongGeneration) {
      assert.throws(() => applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE));
      assert.deepEqual(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE permission='directory.portal_access.manage'"), { count: 0 });
    } else {
      applyMigration(db, packet.provision.sql, packet.provision.name, AUTHORITY_MIGRATIONS_TABLE);
      scenario.after(db, packet);
      assert.throws(() => applyMigration(db, packet.revoke.sql, packet.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
      assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", packet.ids.portalAccessGrant), { active: 1 });
    }
    db.close();
  }
});

test("v8 rejects receipt actor, record kind, version, and missing receipt drift atomically", () => {
  for (const scenario of [
    { activatedBy: "different-reviewed-owner" },
    { record: { ...acquisitionRecord, kind: "client" } },
    { record: { ...acquisitionRecord, version: acquisitionRecord.version + 1 } },
    { missing: true },
  ]) {
    const db = canonicalDatabase(), base = fixture(); establishReviewedOnboardingLineage(db);
    const acquisition = buildAuthorityArtifacts(base, preservativeAcquisitionInput(), "revoke");
    applyMigration(db, acquisition.provision.sql, acquisition.provision.name, AUTHORITY_MIGRATIONS_TABLE);
    if (!scenario.missing) seedActivationReceipt(db, activationId, scenario.record ?? acquisitionRecord, 6,
      scenario.activatedBy ?? owner.operationsStaffId);
    applyMigration(db, acquisition.revoke.sql, acquisition.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
    const before = db.prepare("SELECT * FROM native_directory_grant_history ORDER BY grant_id,grant_version")
      .all().map(row => ({ ...row }));
    const portal = buildAuthorityArtifacts(base, preservativeRecipientEnrollmentInput(), "provision");
    assert.throws(() => applyMigration(db, portal.provision.sql, portal.provision.name, AUTHORITY_MIGRATIONS_TABLE));
    assert.deepEqual(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE permission='directory.portal_access.manage'"), { count: 0 });
    assert.deepEqual(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE} WHERE name=?`, portal.provision.name), { count: 0 });
    assert.deepEqual(db.prepare("SELECT * FROM native_directory_grant_history ORDER BY grant_id,grant_version")
      .all().map(row => ({ ...row })), before);
    db.close();
  }
});

test("canonical receipt guards reject synthetic direct insertion and duplicate activation IDs", () => {
  const db = canonicalDatabase(), base = fixture(); establishReviewedOnboardingLineage(db);
  const acquisition = buildAuthorityArtifacts(base, preservativeAcquisitionInput(), "provision");
  applyMigration(db, acquisition.provision.sql, acquisition.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  // No normal acquisition/review evidence exists: the real guards must reject
  // this fixture output. A successful reduced fixture is not live acceptance.
  assert.throws(() => seedActivationReceipt(db, activationId, acquisitionRecord, 6, owner.operationsStaffId, false));
  assert.deepEqual(queryOne(db, "SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts"), { count: 0 });
  seedActivationReceipt(db, activationId, acquisitionRecord, 6);
  // Isolate the activation primary key: all other unique coordinates differ.
  // Foreign keys are disabled only for this reduced in-memory receipt fixture;
  // the real guard rejection above remains a separate assertion.
  const duplicate = { ...queryOne(db, "SELECT * FROM project_alpha_existing_directory_binding_activation_receipts"),
    review_receipt_id: "20000000-0000-4000-8000-000000000002",
    idempotency_key: "20000000-0000-4000-8000-000000000003",
    acquired_receipt_id: "20000000-0000-4000-8000-000000000004",
    native_owner_claim_id: "20000000-0000-4000-8000-000000000005",
    source_id: "project-alpha:other-synthetic-source" };
  const columns = Object.keys(duplicate);
  db.exec("PRAGMA foreign_keys=OFF;");
  try {
    assert.throws(() => db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts
      (${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(duplicate)),
      /UNIQUE constraint failed: project_alpha_existing_directory_binding_activation_receipts\.activation_id/);
  } finally { db.exec("PRAGMA foreign_keys=ON;"); }
  assert.deepEqual(queryOne(db, "SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts"), { count: 1 });
  db.close();
});

test("v5 fixture provision fails closed when its fixed fixture identity is already present", () => {
  const db = canonicalDatabase(), base = fixture();
  const v3 = buildAuthorityArtifacts(base, input(), "revoke");
  applyMigration(db, v3.provision.sql, v3.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, v3.revoke.sql, v3.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area-default','Fixture area',1)").run();
  seedAcquisitionRecord(db, { id: "staging-native-empty-enrollment-organization-v1", kind: "organization", version: 1 });
  const setup = buildAuthorityArtifacts(base, fixtureInput(), "provision");
  assert.throws(() => applyMigration(db, setup.provision.sql, setup.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 0, version: 2 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId).count, 1);
  db.close();
});

test("v5 fixture revoke fails atomically while an actor Project command is pending", () => {
  const db = canonicalDatabase(), base = fixture();
  const v3 = buildAuthorityArtifacts(base, input(), "revoke");
  applyMigration(db, v3.provision.sql, v3.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, v3.revoke.sql, v3.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area-default','Fixture area',1)").run();
  const setup = buildAuthorityArtifacts(base, fixtureInput(), "revoke");
  applyMigration(db, setup.provision.sql, setup.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  const externalProjectId = "staging-v5-pending-project", commandId = "00000000-0000-4000-8000-000000000021";
  const sourceId = "project-alpha:staging", applicationId = "00000000-0000-4000-8000-000000000022";
  const instanceId = "00000000-0000-4000-8000-000000000023", epochId = "00000000-0000-4000-8000-000000000024", destination = "https://pa-staging.example.test";
  db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,?,?,?)`)
    .run(externalProjectId, sourceId, applicationId, destination, instanceId, epochId);
  db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(commandId, externalProjectId, owner.operationsStaffId, subject, 3, 1, owner.email, expiresAt, 3, "[]");
  db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,expected_history_epoch_id) VALUES(?,?,'create','{}',?,?,?,?,?,'pending',0,0,?)`)
    .run(commandId, externalProjectId, sourceId, applicationId, destination, instanceId, JSON.stringify({ actorId: owner.operationsStaffId }), epochId);
  assert.throws(() => applyMigration(db, setup.revoke.sql, setup.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 3 });
  assert.deepEqual(db.prepare("SELECT permission,active FROM native_directory_grants WHERE staff_id=? ORDER BY permission").all(owner.operationsStaffId).map(row => ({ ...row })), [
    { permission: "directory.enrollment.manage", active: 1 }, { permission: "directory.profile.edit", active: 1 },
  ]);
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 3);
  db.close();
});

for (const [name, drift, identityActive = 1] of [
  ["an inactive identity grant", (db, artifact) => db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").run(artifact.ids.identityGrant), 0],
  ["an added deny grant", (db) => db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
    VALUES('v4-directory-deny',?,'directory.identity.link','deny','global',1,?)`).run(owner.operationsStaffId, owner.operationsStaffId)],
  ["an added non-global grant", (db) => db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
    VALUES('v4-directory-assigned',?,'directory.identity.link','allow','assigned',1,?)`).run(owner.operationsStaffId, owner.operationsStaffId), 1],
]) test(`v4 revoke fails closed on ${name}`, () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), acquisitionInput(), "revoke");
  seedAcquisitionRecord(db);
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  drift(db, artifact);
  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", artifact.ids.identityGrant), { active: identityActive });
  db.close();
});

test("v4 reactivation rejects an asserted complete inactive set when the identity grant is absent", () => {
  const db = canonicalDatabase(), base = fixture();
  seedAcquisitionRecord(db);
  const v3 = buildAuthorityArtifacts(base, input(), "revoke");
  applyMigration(db, v3.provision.sql, v3.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  applyMigration(db, v3.revoke.sql, v3.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  const v4 = buildAuthorityArtifacts(base, acquisitionInput({ packet: {
    mode: "reactivate",
    expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 2, directoryAuthorityState: "v4-acquisition-inactive" },
  } }), "provision");
  assert.throws(() => applyMigration(db, v4.provision.sql, v4.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 0 });
  db.close();
});

test("v4 revoke fails atomically while an actor directory write fence survives", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), acquisitionInput(), "revoke");
  seedAcquisitionRecord(db);
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,
    actor_admission_version,permission,record_id,record_kind,expected_version,selected_grant_id,scopes_json,
    profile_json,command_json,destinations_json,intent_writes)
    VALUES(?,'update',?,? ,1,'directory.profile.edit',?,'organization',1,?,'[]','{}','{}','[]',0)`)
    .run("v4-surviving-directory-fence", owner.operationsStaffId, subject, "staging-v4-record", artifact.ids.directoryGrant);
  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", artifact.ids.identityGrant), { active: 1 });
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
  db.close();
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
  assert.match(artifact.provision.sql, /directory\.profile\.edit/);
  assert.match(artifact.provision.sql, /scope_kind='global'|,'global'/);
  assert.match(artifact.provision.sql, /SELECT count\(\*\) FROM d1_migrations/);
  assert.deepEqual(artifact.provision.manifest.canonicalOperationsLedger, {
    count: REVIEWED_OPERATIONS_180.count,
    finalMigration: REVIEWED_OPERATIONS_180.finalMigration,
    chainSha256: REVIEWED_OPERATIONS_180.chainSha256,
  });
  assert.deepEqual(artifact.provision.manifest.directoryGrant, {
    id: `staging-directory-profile-edit:${owner.operationsStaffId}`,
    permission: "directory.profile.edit", effect: "allow", scopeKind: "global",
  });
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

test("reviewed authority packets reject an unreviewed migration after the exact 0180 chain", () => {
  const base = fixture();
  fs.writeFileSync(path.join(base, "apps", "operations", "migrations", "0170_unreviewed_staging_test.sql"), "SELECT 1;\n");
  assert.throws(() => buildAuthorityArtifacts(base, input(), "provision"), /exact reviewed 180-file Operations chain/);
});

test("full canonical schema provisions, revokes, and reactivates exact native authority", () => {
  const db = canonicalDatabase();
  const base = fixture();
  const first = buildAuthorityArtifacts(base, input(), "revoke");
  applyMigration(db, first.provision.sql, first.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version,scope_kind,capability FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId),
    { active: 1, version: 1, scope_kind: "global", capability: "project.shared.sync" });
  assert.deepEqual(queryOne(db, `SELECT active,scope_kind,permission,effect FROM native_directory_grants WHERE staff_id=?`, owner.operationsStaffId),
    { active: 1, scope_kind: "global", permission: "directory.profile.edit", effect: "allow" });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_project_grant_generations WHERE staff_id=?", owner.operationsStaffId), { generation: 1 });
  const provisionReceipt = queryOne(db, `SELECT canonical_plan_json,result_json FROM native_staff_bootstrap_receipts
    WHERE command_id=?`, first.ids.provisionCommand);
  assert.deepEqual(JSON.parse(provisionReceipt.canonical_plan_json).directoryGrant, {
    id: first.ids.directoryGrant, permission: "directory.profile.edit", effect: "allow", scopeKind: "global",
  });
  assert.equal(JSON.parse(provisionReceipt.result_json).directoryGrantActive, 1);

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
  assert.deepEqual(queryOne(db, "SELECT active,count(*) count FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId),
    { active: 0, count: 1 });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_project_grant_generations WHERE staff_id=?", owner.operationsStaffId), { generation: 2 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_project_live_command_proofs WHERE actor_staff_id=?", owner.operationsStaffId).count, 0);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 2);
  const revokeReceipt = queryOne(db, `SELECT canonical_plan_json,result_json FROM native_staff_bootstrap_receipts
    WHERE command_id=?`, first.ids.revokeCommand);
  assert.equal(JSON.parse(revokeReceipt.canonical_plan_json).expected.directoryGrantActive, 1);
  assert.equal(JSON.parse(revokeReceipt.result_json).directoryGrantActive, 0);

  const reactivationInput = input({ packet: { packetId: "staging-authority-project-v2-002", mode: "reactivate",
    expected: { admissionVersion: 2, profileVersion: 1, grantVersion: 2, grantGeneration: 2 } } });
  const second = buildAuthorityArtifacts(base, reactivationInput, "provision");
  applyMigration(db, second.provision.sql, second.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 3 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 3 });
  assert.deepEqual(queryOne(db, "SELECT active,count(*) count FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId),
    { active: 1, count: 1 });
  assert.deepEqual(queryOne(db, "SELECT generation FROM native_project_grant_generations WHERE staff_id=?", owner.operationsStaffId), { generation: 3 });
  db.close();
});

test("late migration failure rolls authority and ledger row back", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "provision");
  const failing = `${artifact.provision.sql}\nCREATE TABLE forced_packet_failure(ok INTEGER CHECK(ok=1));\nINSERT INTO forced_packet_failure VALUES(0);`;
  assert.throws(() => applyMigration(db, failing, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId).count, 0);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId).count, 0);
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
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1 });
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  db.close();
});

test("revoke fails atomically while an actor has a live Project-v2 recovery authorization", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  const externalProjectId = "staging-project-recovery", commandId = "10000000-0000-4000-8000-000000000010";
  const authorizationId = "20000000-0000-4000-8000-000000000020";
  const sourceId = "project-alpha:staging", applicationId = "30000000-0000-4000-8000-000000000030";
  const sourceInstanceId = "40000000-0000-4000-8000-000000000040";
  const historyEpochId = "50000000-0000-4000-8000-000000000050";
  const destination = "https://pa-staging.example.test", requestSha256 = "a".repeat(64);
  const commandJson = JSON.stringify({ commandId, externalId: externalProjectId });
  db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,
    expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,?,?,?)`)
    .run(externalProjectId, sourceId, applicationId, destination, sourceInstanceId, historyEpochId);
  db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,
    actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(commandId, externalProjectId, owner.operationsStaffId, subject,
      1, 1, owner.email, expiresAt, 1, "[]");
  db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,application_id,
    destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,expected_history_epoch_id)
    VALUES(?,?,'create',?,?,?,?,?,?,'pending',0,0,?)`)
    .run(commandId, externalProjectId, commandJson, sourceId, applicationId, destination, sourceInstanceId,
      JSON.stringify({ actorId: owner.operationsStaffId }), historyEpochId);
  db.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").run(commandId);
  db.prepare("INSERT INTO project_alpha_project_v2_request_fingerprints(command_id,request_sha256) VALUES(?,?)")
    .run(commandId, requestSha256);
  db.prepare(`INSERT INTO project_alpha_project_v2_canonical_intents(command_id,request_sha256,operation,
    external_project_id,expected_local_version,expected_local_projection_sha256,expected_grant_generation,
    expected_mapping_state,expected_project_alpha_public_id,source_id,source_instance_id,application_id,history_epoch_id)
    VALUES(?,?,'create',?,0,NULL,1,'absent',NULL,?,?,?,?)`)
    .run(commandId, requestSha256, externalProjectId, sourceId, sourceInstanceId, applicationId, historyEpochId);
  db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
    VALUES(?,1,'60000000-0000-4000-8000-000000000060',?,'pending')`).run(commandId, requestSha256);
  db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
    VALUES(?,2,'70000000-0000-4000-8000-000000000070',?,'uncertain')`).run(commandId, requestSha256);
  db.prepare(`UPDATE project_alpha_project_outbox SET state='terminal',attempts=1,outcome_json='{}',
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).run(commandId);
  db.prepare(`INSERT INTO project_alpha_project_v2_recovery_authorizations(
    authorization_id,command_id,original_event_state_version,eligibility_state,original_outbox_state,
    original_attempts,original_lease_token,original_lease_expires_at,original_outcome_json,request_sha256,operation,
    external_project_id,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,
    expected_local_version,expected_local_projection_sha256,expected_mapping_state,expected_project_alpha_public_id,
    actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,
    actor_project_grant_generation,actor_scopes_json,reason,expires_at)
    VALUES(?,?,2,'terminal_uncertain','terminal',1,NULL,NULL,'{}',?,'create',?,?,?,?,?,?,0,NULL,'absent',NULL,
      ?,?,?,1,1,1,'[]','Guarded staging recovery',strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'))`)
    .run(authorizationId, commandId, requestSha256, externalProjectId, sourceId, sourceInstanceId, applicationId,
      historyEpochId, destination, owner.operationsStaffId, subject, owner.email);
  assert.equal(queryOne(db, `SELECT count(*) count FROM project_alpha_project_v2_live_recovery_authorizations
    WHERE actor_staff_id=?`, owner.operationsStaffId).count, 1);

  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?",
    owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?",
    owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE staff_id=?",
    owner.operationsStaffId), { active: 1 });
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  db.close();
});

test("provision rejects canonical-ledger drift before writing authority", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "provision");
  db.prepare("DELETE FROM d1_migrations WHERE name='0138_project_alpha_directory_reconciliation_review.sql'").run();
  assert.throws(() => applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId).count, 0);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId).count, 0);
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 0);
  db.close();
});

test("legacy-roster-staging provisions only the exact seeded staging owner", () => {
  const legacy = input({ packet: {
    operatorKind: "legacy-roster-staging", staffId: seededOwner.operationsStaffId,
    email: seededOwner.email, displayName: seededOwner.displayName,
  } });
  const db = canonicalDatabase(seededOwner);
  const artifact = buildAuthorityArtifacts(fixture(), legacy, "revoke");
  assert.equal(artifact.provision.manifest.operatorKind, "legacy-roster-staging");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?",
    seededOwner.operationsStaffId), { active: 1, version: 1 });
  const receipt = queryOne(db, `SELECT canonical_plan_json FROM native_staff_bootstrap_receipts
    WHERE command_id=?`, artifact.ids.provisionCommand);
  assert.equal(JSON.parse(receipt.canonical_plan_json).operatorKind, "legacy-roster-staging");
  applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?",
    seededOwner.operationsStaffId), { active: 0, version: 2 });
  db.close();
});

test("revoke fails atomically while an actor directory command is pending", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,
    command_json,destination_base_url,expected_source_instance_id,expected_history_epoch_id,origin_snapshot_json,next_attempt_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,0)`).run(
    "00000000-0000-4000-8000-000000000020", "project-alpha:staging", "00000000-0000-4000-8000-000000000021",
    "organization", "staging-directory-pending", "{}", "https://pa-staging.example.test",
    "00000000-0000-4000-8000-000000000022", "00000000-0000-4000-8000-000000000023",
    JSON.stringify({ actorId: owner.operationsStaffId }),
  );
  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1 });
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  db.close();
});

test("revoke fails atomically while an actor directory write fence survives", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,
    actor_admission_version,permission,record_id,record_kind,expected_version,selected_grant_id,scopes_json,
    profile_json,command_json,destinations_json,intent_writes)
    VALUES(?,'update',?,? ,1,'directory.profile.edit',?,'organization',1,?,'[]','{}','{}','[]',0)`)
    .run("staging-surviving-directory-fence", owner.operationsStaffId, subject,
      "staging-surviving-directory-record", artifact.ids.directoryGrant);
  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
  db.close();
});

test("late revoke failure rolls every authority change and audit write back", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  const failing = `${artifact.revoke.sql}\nCREATE TABLE forced_revoke_failure(ok INTEGER CHECK(ok=1));\nINSERT INTO forced_revoke_failure VALUES(0);`;
  assert.throws(() => applyMigration(db, failing, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1 });
  assert.deepEqual(queryOne(db, "SELECT revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?", artifact.ids.provisionApproval), { revoked_at: null });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
  db.close();
});

test("provision fails closed on a pre-existing directory authority state", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "provision");
  // The current canonical chain records grant history. A valid pre-existing
  // grant therefore requires an admission, which itself proves the packet is
  // not creating authority from the exact expected zero-version state.
  db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
    VALUES(?,?,1,?)`).run(owner.operationsStaffId, subject, owner.operationsStaffId);
  db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
    VALUES('pre-existing-directory-grant',?,'directory.profile.view','allow','global',1,?)`)
    .run(owner.operationsStaffId, owner.operationsStaffId);
  assert.throws(() => applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_directory_grants WHERE staff_id=?", owner.operationsStaffId).count, 1);
  assert.deepEqual(queryOne(db, "SELECT active,bound_access_subject FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId),
    { active: 1, bound_access_subject: subject });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 0);
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 0);
  db.close();
});

test("revoke fails closed on added directory-authority drift", () => {
  const db = canonicalDatabase(), artifact = buildAuthorityArtifacts(fixture(), input(), "revoke");
  applyMigration(db, artifact.provision.sql, artifact.provision.name, AUTHORITY_MIGRATIONS_TABLE);
  db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
    VALUES('drift-directory-deny',?,'directory.profile.edit','deny','global',1,?)`)
    .run(owner.operationsStaffId, owner.operationsStaffId);
  assert.throws(() => applyMigration(db, artifact.revoke.sql, artifact.revoke.name, AUTHORITY_MIGRATIONS_TABLE));
  assert.equal(queryOne(db, "SELECT active FROM native_directory_grants WHERE id=?", artifact.ids.directoryGrant).active, 1);
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_staff_admissions WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.deepEqual(queryOne(db, "SELECT active,version FROM native_project_grants WHERE staff_id=?", owner.operationsStaffId), { active: 1, version: 1 });
  assert.equal(queryOne(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts").count, 1);
  assert.equal(queryOne(db, `SELECT count(*) count FROM ${AUTHORITY_MIGRATIONS_TABLE}`).count, 1);
  db.close();
});
