import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

const migrations = resolve(import.meta.dirname, "../migrations");
const migrationFiles = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort();
const recoveryMigration = "0180_project_alpha_project_v2_recovery_authorization.sql";

const originalActor = "staff-beau-koltz";
const recoveryManager = "staff-kollins-stirn";
const originalSubject = "original-owner-subject";
const managerSubject = "recovery-manager-subject";
const commandId = "10000000-0000-4000-8000-000000000001";
const externalProjectId = "recovery-project";
const sourceId = "project-alpha:primary";
const sourceInstanceId = "20000000-0000-4000-8000-000000000002";
const applicationId = "30000000-0000-4000-8000-000000000003";
const historyEpochId = "40000000-0000-4000-8000-000000000004";
const requestSha256 = "a".repeat(64);
const responseSha256 = "b".repeat(64);
const projectAlphaPublicId = "c".repeat(32);
const projectionSha256 = "d".repeat(64);
const acknowledgementId = "a0000000-0000-4000-8000-00000000000a";
const successReceiptId = "b0000000-0000-4000-8000-00000000000b";
const destinationOrigin = "https://pa-recovery.example.test";

function migrate(db: DatabaseSync, name: string): void {
  for (const statement of unstable_splitSqlQuery(readFileSync(resolve(migrations, name), "utf8"))) {
    db.exec(statement);
  }
}

function fixture(mode: "terminal_uncertain" | "expired_lease_lost_ack"): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrationFiles) migrate(db, name);

  db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by,version)
    VALUES(?,?,1,?,1)`).run(originalActor, originalSubject, originalActor);
  db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by,version)
    VALUES(?,?,1,?,1)`).run(recoveryManager, managerSubject, originalActor);
  db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version)
    VALUES(?,'beau.fixture@example.test','Original actor',1)`).run(originalActor);
  db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version)
    VALUES(?,'kollins.fixture@example.test','Recovery manager',1)`).run(recoveryManager);
  db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
    VALUES('assignment-recovery-manager-owner',?,'role-owner','global',NULL,'global',?)`)
    .run(recoveryManager, originalActor);
  db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,
    destination_base_url,expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,?,?,?)`)
    .run(externalProjectId, sourceId, applicationId, destinationOrigin, sourceInstanceId, historyEpochId);
  db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by)
    VALUES('original-project-allow',?,'project.shared.sync','allow','global',1,1,?)`)
    .run(originalActor, originalActor);
  db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by)
    VALUES('recovery-project-allow',?,'project.shared.sync','allow','global',1,1,?)`)
    .run(recoveryManager, originalActor);
  db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,
    actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,
    grant_generation,scopes_json) VALUES(?,?,?,?,1,1,'beau.fixture@example.test',
      '2999-01-01T00:00:00.000Z',1,'[]')`)
    .run(commandId, externalProjectId, originalActor, originalSubject);
  const commandJson = JSON.stringify({ commandId, externalId: externalProjectId,
    expectedAuthorizationGeneration: "0",
    project: { name: "Recovery fixture", description: null, estimatedStart: null, estimatedEnd: null },
    organization: { externalId: "fixture-organization", expectedPublicId: "d".repeat(32),
      expectedRevision: "1", expectedProjectionSha256: "e".repeat(64) },
    client: null });
  const originJson = JSON.stringify({ actorId: originalActor });
  db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,
    source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,
    attempts,next_attempt_at,expected_history_epoch_id) VALUES(?,?,'create',?,?,?,?,?,?,'pending',0,0,?)`)
    .run(commandId, externalProjectId, commandJson, sourceId, applicationId, destinationOrigin,
      sourceInstanceId, originJson, historyEpochId);
  db.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").run(commandId);
  db.prepare(`INSERT INTO project_alpha_project_v2_request_fingerprints(command_id,request_sha256)
    VALUES(?,?)`).run(commandId, requestSha256);
  db.prepare(`INSERT INTO project_alpha_project_v2_canonical_intents(command_id,request_sha256,operation,
    external_project_id,expected_local_version,expected_local_projection_sha256,expected_grant_generation,
    expected_mapping_state,expected_project_alpha_public_id,source_id,source_instance_id,application_id,
    history_epoch_id) VALUES(?,?,'create',?,0,NULL,1,'absent',NULL,?,?,?,?)`)
    .run(commandId, requestSha256, externalProjectId, sourceId, sourceInstanceId, applicationId, historyEpochId);
  db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
    request_sha256,state) VALUES(?,1,'50000000-0000-4000-8000-000000000005',?,'pending')`)
    .run(commandId, requestSha256);

  if (mode === "terminal_uncertain") {
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
      request_sha256,state) VALUES(?,2,'60000000-0000-4000-8000-000000000006',?,'uncertain')`)
      .run(commandId, requestSha256);
    db.prepare(`UPDATE project_alpha_project_outbox SET state='terminal',attempts=1,outcome_json='{}',
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).run(commandId);
  } else {
    db.prepare(`UPDATE project_alpha_project_outbox SET state='leased',attempts=1,lease_token='lost-ack',
      lease_expires_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).run(commandId);
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
      request_sha256,state) VALUES(?,2,'60000000-0000-4000-8000-000000000006',?,'uncertain')`)
      .run(commandId, requestSha256);
  }
  // Model the actual recovery boundary: the original immutable command proof
  // still exists as history, but its transport authentication lifetime ended.
  db.exec(`DROP TRIGGER native_project_command_proofs_no_update;
    UPDATE native_project_command_proofs SET verified_until='2000-01-01T00:00:00.000Z'
      WHERE command_id='${commandId}';
    CREATE TRIGGER native_project_command_proofs_no_update BEFORE UPDATE ON native_project_command_proofs
    BEGIN SELECT RAISE(ABORT,'native project command proof is immutable'); END;`);
  return db;
}

function authorize(
  db: DatabaseSync,
  options: Readonly<{
    id?: string;
    mode?: "terminal_uncertain" | "expired_lease_lost_ack";
    requestHash?: string;
    expiryModifier?: string;
    actor?: "original" | "manager";
    actorAccessSubject?: string;
    actorEmail?: string;
    actorAdmissionVersion?: number;
    actorProfileVersion?: number;
    actorGrantGeneration?: number;
  }> = {},
): void {
  const authorizationId = options.id ?? "70000000-0000-4000-8000-000000000007";
  const mode = options.mode ?? "terminal_uncertain";
  const eventVersion = 2;
  const expiryModifier = options.expiryModifier ?? "+10 minutes";
  const terminal = mode === "terminal_uncertain";
  const actor = options.actor === "manager" ? recoveryManager : originalActor;
  const subject = options.actor === "manager" ? managerSubject : originalSubject;
  const actorEmail = options.actor === "manager"
    ? "kollins.fixture@example.test"
    : "beau.fixture@example.test";
  db.prepare(`INSERT INTO project_alpha_project_v2_recovery_authorizations(
    authorization_id,command_id,original_event_state_version,eligibility_state,original_outbox_state,
    original_attempts,original_lease_token,original_lease_expires_at,original_outcome_json,
    request_sha256,operation,
    external_project_id,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,
    expected_local_version,expected_local_projection_sha256,expected_mapping_state,
    expected_project_alpha_public_id,original_actor_staff_id,original_actor_access_subject,
    original_actor_email,original_actor_admission_version,original_actor_profile_version,
    original_actor_project_grant_generation,original_actor_scopes_json,
    actor_staff_id,actor_access_subject,actor_email,
    actor_admission_version,actor_profile_version,actor_project_grant_generation,actor_scopes_json,
    reason,expires_at)
    SELECT ?,?,?,?,?,1,?,?,?,?,'create',?,?,?,?,?,?,0,NULL,'absent',NULL,
      ?,?,'beau.fixture@example.test',1,1,1,'[]',?,?,?,?,?,?, '[]','Operator-reviewed exact replay',
      strftime('%Y-%m-%dT%H:%M:%fZ','now',?)
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=?`)
    .run(authorizationId, commandId, eventVersion, mode, terminal ? "terminal" : "leased",
      terminal ? null : "lost-ack", terminal ? null : 0, terminal ? "{}" : null,
      options.requestHash ?? requestSha256,
      externalProjectId, sourceId, sourceInstanceId, applicationId, historyEpochId, destinationOrigin,
      originalActor, originalSubject, actor, options.actorAccessSubject ?? subject,
      options.actorEmail ?? actorEmail, options.actorAdmissionVersion ?? 1,
      options.actorProfileVersion ?? 1, options.actorGrantGeneration ?? 1,
      expiryModifier, actor);
}

function acknowledgeRecovered(db: DatabaseSync, recoveryExpiryModifier = "+1 second"): void {
  authorize(db, { expiryModifier: recoveryExpiryModifier });
  db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
    request_sha256,state) VALUES(?,3,'80000000-0000-4000-8000-000000000008',?,'pending')`)
    .run(commandId, requestSha256);
  db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',outcome_json=NULL,
    lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=?`).run(commandId);
  db.prepare(`UPDATE project_alpha_project_outbox SET state='leased',attempts=2,
    lease_token='recovery-lease',lease_expires_at=unixepoch('now')+300,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).run(commandId);
  db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
    request_sha256,state) VALUES(?,4,'90000000-0000-4000-8000-000000000009',?,'acknowledged')`)
    .run(commandId, requestSha256);
  db.prepare(`INSERT INTO project_alpha_project_v2_validated_acknowledgements(
    acknowledgement_id,command_id,acknowledged_state_version,request_sha256,source_instance_id,
    application_id,history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,
    projection_sha256,authorization_generation,pa_request_id,pa_replayed,response_sha256)
    VALUES(?,?,4,?,?,?,?,?,?,'1',?,'1','e0000000-0000-4000-8000-00000000000e',0,?)`)
    .run(acknowledgementId, commandId, requestSha256, sourceInstanceId, applicationId,
      historyEpochId, destinationOrigin, projectAlphaPublicId, projectionSha256, responseSha256);
  db.prepare(`INSERT INTO project_alpha_project_v2_success_receipts(
    receipt_id,acknowledgement_id,command_id,request_sha256,source_instance_id,application_id,
    history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,projection_sha256,
    authorization_generation,pa_request_id,pa_replayed,response_sha256)
    SELECT ?,acknowledgement_id,command_id,request_sha256,source_instance_id,application_id,
      history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,projection_sha256,
      authorization_generation,pa_request_id,pa_replayed,response_sha256
    FROM project_alpha_project_v2_validated_acknowledgements WHERE acknowledgement_id=?`)
    .run(successReceiptId, acknowledgementId);
  db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
    outcome_json=json_object('receiptId',?),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=?`).run(successReceiptId, commandId);
}

function authorizePostAck(
  db: DatabaseSync,
  options: Readonly<{ id?: string; actor?: "original" | "manager"; responseHash?: string;
    expiryModifier?: string }> = {},
): void {
  const actor = options.actor === "manager" ? recoveryManager : originalActor;
  const subject = options.actor === "manager" ? managerSubject : originalSubject;
  db.prepare(`INSERT INTO project_alpha_project_v2_post_ack_authorizations(
    authorization_id,success_receipt_id,acknowledgement_id,command_id,acknowledged_state_version,
    request_sha256,response_sha256,operation,external_project_id,source_id,source_instance_id,
    application_id,history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,
    projection_sha256,expected_local_version,expected_local_projection_sha256,expected_mapping_state,
    expected_project_alpha_public_id,actor_staff_id,actor_access_subject,actor_email,
    actor_admission_version,actor_profile_version,actor_project_grant_generation,actor_scopes_json,
    reason,expires_at)
    SELECT ?,?,?,?,?,? ,?,'create',?,?,?,?,?,? ,?,'1',?,0,NULL,'absent',NULL,
      ?,?,profile.login_email,admission.version,profile.version,generation.generation,'[]',
      'Resume exact acknowledged command',strftime('%Y-%m-%dT%H:%M:%fZ','now',?)
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=?`)
    .run(options.id ?? "c0000000-0000-4000-8000-00000000000c", successReceiptId,
      acknowledgementId, commandId, 4, requestSha256, options.responseHash ?? responseSha256,
      externalProjectId, sourceId, sourceInstanceId, applicationId, historyEpochId, destinationOrigin,
      projectAlphaPublicId, projectionSha256, actor, subject, options.expiryModifier ?? "+10 minutes", actor);
}

describe("Project v2 recovery authorization migration", () => {
  it("preserves recovery migration order and the full current empty migration chain", () => {
    expect(migrationFiles.at(-5)).toBe(recoveryMigration);
    expect(migrationFiles.at(-4)).toBe("0181_project_alpha_directory_create_generation_recovery.sql");
    expect(migrationFiles.at(-3)).toBe("0182_project_alpha_directory_relationship_recovery_guard.sql");
    expect(migrationFiles.at(-2)).toBe("0183_project_alpha_binding_standalone_relationship_rows.sql");
    expect(migrationFiles.at(-1)).toBe("0184_project_alpha_directory_relationship_generation_recovery.sql");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const name of migrationFiles) migrate(db, name);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name='project_alpha_project_v2_recovery_authorizations'`).get()).toEqual({
      name: "project_alpha_project_v2_recovery_authorizations",
    });
  });

  it("authorizes an exact terminal-uncertain replay for the original actor at the exact generation", () => {
    const db = fixture("terminal_uncertain");
    authorize(db);
    expect(db.prepare(`SELECT command_id,eligibility_state,actor_staff_id
      FROM project_alpha_project_v2_live_recovery_authorizations`).get()).toEqual({
      command_id: commandId,
      eligibility_state: "terminal_uncertain",
      actor_staff_id: originalActor,
    });
  });

  it("rejects a different recovery manager before dispatch and rejects a concurrent live authorization", () => {
    const crossActor = fixture("terminal_uncertain");
    expect(() => authorize(crossActor, { actor: "manager" })).toThrow(/not current and exact/);
    expect(crossActor.prepare(`SELECT count(*) AS count
      FROM project_alpha_project_v2_recovery_authorizations`).get()).toEqual({ count: 0 });

    const duplicate = fixture("terminal_uncertain");
    authorize(duplicate);
    expect(() => authorize(duplicate, { id: "71000000-0000-4000-8000-000000000007" }))
      .toThrow(/not current and exact/);
    expect(duplicate.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_recovery_authorizations").get())
      .toEqual({ count: 1 });
  });

  it("fails closed when original actor identity or manager permission is revoked", () => {
    const originalRevoked = fixture("terminal_uncertain");
    authorize(originalRevoked);
    originalRevoked.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?")
      .run(originalActor);
    expect(originalRevoked.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 0 });

    const nonManager = fixture("terminal_uncertain");
    nonManager.prepare("DELETE FROM staff_role_assignments WHERE staff_id=?").run(recoveryManager);
    expect(() => authorize(nonManager, { actor: "manager" })).toThrow(/not current and exact/);
  });

  it("rejects forged recovery-manager identity fields at the SQLite authorization guard", () => {
    const cases = [
      { actorAccessSubject: "forged-manager-subject" },
      { actorEmail: "forged-manager@example.test" },
      { actorAdmissionVersion: 2 },
      { actorProfileVersion: 2 },
    ] as const;
    for (const forged of cases) {
      const db = fixture("terminal_uncertain");
      expect(() => authorize(db, { actor: "manager", ...forged })).toThrow(/not current and exact/);
      expect(db.prepare(`SELECT count(*) AS count
        FROM project_alpha_project_v2_recovery_authorizations`).get()).toEqual({ count: 0 });
    }
  });

  it("allows a new immutable authorization only after every prior authorization for the event expired", async () => {
    const db = fixture("terminal_uncertain");
    authorize(db, { expiryModifier: "+1 second" });
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 1 });
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 0 });
    authorize(db, { id: "71000000-0000-4000-8000-000000000007" });
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_recovery_authorizations").get())
      .toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 1 });
  });

  it("blocks terminal-to-pending transition bypass without the exact authorization and successor event", () => {
    const db = fixture("terminal_uncertain");
    expect(() => db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
      request_sha256,state) VALUES(?,3,'b0000000-0000-4000-8000-00000000000b',?,'pending')`)
      .run(commandId, requestSha256)).toThrow(/requires exact recovery authority/);
    expect(() => db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',outcome_json=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).run(commandId))
      .toThrow(/requires exact recovery transition/);
    expect(db.prepare("SELECT state,outcome_json FROM project_alpha_project_outbox WHERE command_id=?")
      .get(commandId)).toEqual({ state: "terminal", outcome_json: "{}" });
  });

  it("rolls back authorization and successor event when the outbox reopen fails mid-transaction", () => {
    const db = fixture("terminal_uncertain");
    db.exec("BEGIN IMMEDIATE");
    authorize(db);
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
      request_sha256,state) VALUES(?,3,'b1000000-0000-4000-8000-00000000000b',?,'pending')`)
      .run(commandId, requestSha256);
    expect(() => db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',attempts=attempts+1,
      outcome_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`)
      .run(commandId)).toThrow(/requires exact recovery transition/);
    db.exec("ROLLBACK");

    expect(db.prepare(`SELECT count(*) AS count
      FROM project_alpha_project_v2_recovery_authorizations`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT count(*) AS count FROM project_alpha_project_v2_events
      WHERE command_id=? AND state_version=3`).get(commandId)).toEqual({ count: 0 });
    expect(db.prepare(`SELECT state,attempts,outcome_json FROM project_alpha_project_outbox
      WHERE command_id=?`).get(commandId)).toEqual({ state: "terminal", attempts: 1, outcome_json: "{}" });
  });

  it("keeps recovery authority live across uncertain-to-pending, acknowledgement, and settlement handoff", () => {
    const db = fixture("terminal_uncertain");
    authorize(db);
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
      request_sha256,state) VALUES(?,3,'80000000-0000-4000-8000-000000000008',?,'pending')`)
      .run(commandId, requestSha256);
    db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',outcome_json=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).run(commandId);
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 1 });
    expect(db.prepare(`SELECT count(*) AS count FROM native_project_live_command_proofs
      WHERE command_id=? AND verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(commandId))
      .toEqual({ count: 1 });

    db.prepare(`UPDATE project_alpha_project_outbox SET state='leased',attempts=2,lease_token='recovery-lease',
      lease_expires_at=unixepoch('now')+300,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=?`).run(commandId);
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
      request_sha256,state) VALUES(?,4,'90000000-0000-4000-8000-000000000009',?,'acknowledged')`)
      .run(commandId, requestSha256);
    db.prepare(`UPDATE project_alpha_project_outbox SET state='acknowledged',lease_token=NULL,
      lease_expires_at=NULL,outcome_json='{}',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=?`).run(commandId);
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 1 });
    expect(db.prepare(`SELECT count(*) AS count FROM native_project_live_command_proofs
      WHERE command_id=? AND verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(commandId))
      .toEqual({ count: 1 });
  });

  it("authorizes an expired leased lost-ack replay but rejects a live lease", () => {
    const db = fixture("expired_lease_lost_ack");
    authorize(db, { mode: "expired_lease_lost_ack" });
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 1 });
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
      request_sha256,state) VALUES(?,3,'b0000000-0000-4000-8000-00000000000b',?,'pending')`)
      .run(commandId, requestSha256);
    db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).run(commandId);
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 1 });
    db.prepare(`UPDATE project_alpha_project_outbox SET state='leased',attempts=2,lease_token='recovery-lease',
      lease_expires_at=unixepoch('now')+300,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=?`).run(commandId);
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,
      request_sha256,state) VALUES(?,4,'a0000000-0000-4000-8000-00000000000a',?,'acknowledged')`)
      .run(commandId, requestSha256);
    db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
      outcome_json='{}',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=?`).run(commandId);
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 1 });

    const liveLeaseDb = fixture("expired_lease_lost_ack");
    liveLeaseDb.prepare(`UPDATE project_alpha_project_outbox SET lease_expires_at=unixepoch('now')+300
      WHERE command_id=?`).run(commandId);
    expect(() => authorize(liveLeaseDb, { mode: "expired_lease_lost_ack" }))
      .toThrow(/not current and exact/);
  });

  it("keeps the ledger immutable and drops live authority when manager authority is denied", () => {
    const db = fixture("terminal_uncertain");
    authorize(db);
    expect(() => db.prepare(`UPDATE project_alpha_project_v2_recovery_authorizations
      SET reason='changed' WHERE command_id=?`).run(commandId)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM project_alpha_project_v2_recovery_authorizations WHERE command_id=?")
      .run(commandId)).toThrow(/durable/);
    db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,
      scope_key,created_by) VALUES('deny-recovery-manager',?,'integrations.manage','deny','global',NULL,'global',?)`)
      .run(originalActor, originalActor);
    expect(db.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_live_recovery_authorizations").get())
      .toEqual({ count: 0 });
  });

  it("atomically rejects stale hashes, denied project grants, and overlong replay windows", () => {
    const stale = fixture("terminal_uncertain");
    stale.exec("BEGIN IMMEDIATE");
    expect(() => authorize(stale, { requestHash: "b".repeat(64) })).toThrow(/not current and exact/);
    stale.exec("ROLLBACK");
    expect(stale.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_recovery_authorizations").get())
      .toEqual({ count: 0 });

    const generationDrift = fixture("terminal_uncertain");
    generationDrift.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,
      external_project_id,active,version,granted_by)
      VALUES('recovery-extra-allow',?,'project.shared.sync','allow','exact_project',?,1,1,?)`)
      .run(originalActor, externalProjectId, originalActor);
    expect(() => authorize(generationDrift)).toThrow(/not current and exact/);
    expect(generationDrift.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_recovery_authorizations").get())
      .toEqual({ count: 0 });

    const denied = fixture("terminal_uncertain");
    denied.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by)
      VALUES('recovery-project-deny',?,'project.shared.sync','deny','global',1,1,?)`)
      .run(originalActor, originalActor);
    expect(() => authorize(denied)).toThrow(/not current and exact/);
    expect(denied.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_recovery_authorizations").get())
      .toEqual({ count: 0 });

    const overlong = fixture("terminal_uncertain");
    expect(() => authorize(overlong, { expiryModifier: "+16 minutes" })).toThrow(/not current and exact/);
    expect(overlong.prepare("SELECT count(*) AS count FROM project_alpha_project_v2_recovery_authorizations").get())
      .toEqual({ count: 0 });
  });

  it("issues an immutable receipt-bound settlement proof after recovery authority expires", async () => {
    const db = fixture("terminal_uncertain");
    acknowledgeRecovered(db);
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(db.prepare(`SELECT count(*) AS count FROM native_project_live_command_proofs
      WHERE command_id=? AND verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(commandId))
      .toEqual({ count: 0 });

    authorizePostAck(db);
    expect(db.prepare(`SELECT success_receipt_id,response_sha256 FROM
      project_alpha_project_v2_live_post_ack_authorizations`).get()).toEqual({
      success_receipt_id: successReceiptId, response_sha256: responseSha256,
    });
    expect(db.prepare(`SELECT count(*) AS count FROM project_alpha_project_v2_live_settlement_proofs
      WHERE command_id=? AND verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(commandId))
      .toEqual({ count: 1 });
    // The settle-only proof is deliberately not projected into the producer/
    // dispatcher view, so it cannot authorize another Project Alpha POST.
    expect(db.prepare(`SELECT count(*) AS count FROM native_project_live_command_proofs
      WHERE command_id=? AND verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(commandId))
      .toEqual({ count: 0 });
    expect(() => db.prepare(`UPDATE project_alpha_project_v2_post_ack_authorizations
      SET reason='changed' WHERE command_id=?`).run(commandId)).toThrow(/immutable/);
    expect(() => db.prepare(`DELETE FROM project_alpha_project_v2_post_ack_authorizations
      WHERE command_id=?`).run(commandId)).toThrow(/durable/);
  });

  it("rejects duplicate, cross-actor, mismatched receipt, and revoked settle-only authority", async () => {
    const duplicate = fixture("terminal_uncertain");
    acknowledgeRecovered(duplicate);
    await new Promise(resolve => setTimeout(resolve, 1_300));
    authorizePostAck(duplicate);
    expect(() => authorizePostAck(duplicate, { id: "d0000000-0000-4000-8000-00000000000d" }))
      .toThrow(/not current and exact/);

    const crossActor = fixture("terminal_uncertain");
    acknowledgeRecovered(crossActor);
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(() => authorizePostAck(crossActor, { actor: "manager" })).toThrow(/not current and exact/);

    const mismatched = fixture("terminal_uncertain");
    acknowledgeRecovered(mismatched);
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(() => authorizePostAck(mismatched, { responseHash: "f".repeat(64) }))
      .toThrow(/not current and exact/);

    duplicate.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,
      active,version,granted_by) VALUES('post-ack-deny',?,'project.shared.sync','deny','global',1,1,?)`)
      .run(originalActor, originalActor);
    expect(duplicate.prepare(`SELECT count(*) AS count FROM project_alpha_project_v2_live_post_ack_authorizations`)
      .get()).toEqual({ count: 0 });
    expect(duplicate.prepare(`SELECT count(*) AS count FROM project_alpha_project_v2_live_settlement_proofs
      WHERE command_id=? AND verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(commandId))
      .toEqual({ count: 0 });
  });

  it("allows a fresh exact settlement proof after an unused proof expires", async () => {
    const db = fixture("terminal_uncertain");
    acknowledgeRecovered(db);
    await new Promise(resolve => setTimeout(resolve, 1_300));
    authorizePostAck(db, { expiryModifier: "+1 second" });
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(db.prepare(`SELECT count(*) AS count FROM project_alpha_project_v2_live_post_ack_authorizations`).get())
      .toEqual({ count: 0 });
    authorizePostAck(db, { id: "d0000000-0000-4000-8000-00000000000d" });
    expect(db.prepare(`SELECT count(*) AS count FROM project_alpha_project_v2_post_ack_authorizations`).get())
      .toEqual({ count: 2 });
    expect(db.prepare(`SELECT count(*) AS count FROM project_alpha_project_v2_live_post_ack_authorizations`).get())
      .toEqual({ count: 1 });
  });
});
