import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
type SchemaObject = {type:string;name:string;tbl_name:string;sql:string|null};

// Candidate compatibility only: this does not promote a migration or prove a
// positive enrollment/cancellation workflow against production records.
describe("0150 cancellation preserves history after all prior canonical migrations", () => {
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const candidate = readFileSync(new URL("../migrations/0150_client_portal_recipient_enrollment_cancellation.sql", import.meta.url), "utf8");
  const historyId = "cancellation-chain-historical-staff";
  const recordId = "cancellation-chain-client";
  const selectionId = "11111111-1111-4111-8111-111111111111";
  const authorityId = "22222222-2222-4222-8222-222222222222";
  const activationId = "33333333-3333-4333-8333-333333333333";
  const owner: AuthenticatedNativeStaffWithAdmissionVersion = { identity: { kind: "native", staffId: historyId,
    verifiedAccessSubject: "access|historical-staff", email: "historical-staff@example.test", displayName: "Historical Staff", profileVersion: 1 },
    admissionVersion: 1, verifiedUntil: "2099-01-01T00:00:00.000Z" };

  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {}", d1Databases: { DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("DB");
    const directory = new URL("../migrations/", import.meta.url);
    const names = reviewedOperationsMigrationNames(directory);
    expect(names).toHaveLength(183);
    expect(names.at(-1)).toBe("0183_project_alpha_binding_standalone_relationship_rows.sql");
    const candidateIndex = names.indexOf("0150_client_portal_recipient_enrollment_cancellation.sql");
    expect(candidateIndex).toBe(149);
    // Exercise 0150 at its real position, not whichever migration is newest.
    // The separate full-chain rehearsal includes subsequent migrations.
    const statements = names.slice(0, candidateIndex).flatMap(name => splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")));
    for (let offset = 0; offset < statements.length; offset += 100) {
      await db.batch(statements.slice(offset, offset + 100).map(sql => db.prepare(sql)));
    }
    await db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
      .bind(historyId, "historical-staff@example.test", "Historical Staff", "access|historical-staff").run();
    await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,'role-owner','global','global',?)")
      .bind("cancellation-chain-historical-role", historyId, historyId).run();
    await db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(historyId, owner.identity.verifiedAccessSubject, historyId).run();
    await db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version) VALUES(?,?,?,1)")
      .bind(historyId, owner.identity.email, owner.identity.displayName).run();
    await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('cancellation-chain-area','Cancellation Chain Area',1)").run();
    await db.batch([
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('cancellation-chain-portal-grant',?,'directory.portal_access.manage','allow','global',1,?)`).bind(historyId, historyId),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('cancellation-chain-profile-grant',?,'directory.profile.edit','allow','global',1,?)`).bind(historyId, historyId),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('cancellation-chain-identity-grant',?,'directory.identity.link','allow','global',1,?)`).bind(historyId, historyId),
    ]);
    const grantGeneration = Number(await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(historyId).first("generation"));
    expect(grantGeneration).toBe(3);
    const scopes = JSON.stringify([{ businessAreaId: "cancellation-chain-area", divisionId: null }]);
    const profile = JSON.stringify({ name: "Historical Client" });
    await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,'[]',?)`).bind("cancellation-chain-create", historyId, owner.identity.verifiedAccessSubject, recordId, "client", scopes, profile, historyId).run();
    await db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,create_admission_id,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,record_writes,revision_writes,audit_writes,intent_writes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',1,1,1,0)`).bind("cancellation-chain-create-mutation", "create", historyId,
        owner.identity.verifiedAccessSubject, 1, "directory.profile.edit", recordId, "client", 0, "cancellation-chain-create", "cancellation-chain-profile-grant", scopes, profile, "{}").run();
    await db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(recordId).run();
    await db.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,?,?)")
      .bind(recordId, "cancellation-chain-create-mutation", profile).run();
    await db.prepare("INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json,original_verified_access_subject) VALUES(?,?,?,1,'staff',?,?,?)")
      .bind("cancellation-chain-create-audit", "cancellation-chain-create-mutation", recordId, historyId, "{}", owner.identity.verifiedAccessSubject).run();
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(
      receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
      reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,
      reviewer_profile_version,reviewed_at,reviewed_local_record_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,'1',?,?,?,?,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1)`)
      .bind("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a".repeat(64), recordId, "project-alpha:primary", "11111111-1111-4111-8111-111111111112",
        "22222222-2222-4222-8222-222222222223", "33333333-3333-4333-8333-333333333334", "client", recordId, "b".repeat(32), "44444444-4444-4444-8444-444444444445",
        "c".repeat(64), historyId, owner.identity.verifiedAccessSubject).run();
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(
      command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,'1',?)`).bind("55555555-5555-4555-8555-555555555556", "a".repeat(64), recordId, "project-alpha:primary",
        "11111111-1111-4111-8111-111111111112", "22222222-2222-4222-8222-222222222223", "33333333-3333-4333-8333-333333333334", "client", recordId, "b".repeat(32), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").run();
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(command_id,state_version,transition_id,request_sha256,state,occurred_at)
        VALUES(?,1,'66666666-6666-4666-8666-666666666667',?,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind("55555555-5555-4555-8555-555555555556", "a".repeat(64)),
      db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(command_id,state_version,transition_id,request_sha256,state,occurred_at)
        VALUES(?,2,'77777777-7777-4777-8777-777777777778',?,'acknowledged',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind("55555555-5555-4555-8555-555555555556", "a".repeat(64)),
    ]);
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(
      command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
      project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256)
      VALUES(?,?,?,?,?,?,?,'1','https://pa.example.test','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',0,?)`).bind("55555555-5555-4555-8555-555555555556", "11111111-1111-4111-8111-111111111112",
        "22222222-2222-4222-8222-222222222223", "33333333-3333-4333-8333-333333333334", "client", recordId, "b".repeat(32), "d".repeat(64)).run();
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(
      receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,acquisition_evidence_sha256,
      profile_evidence_sha256,binding_status_evidence_sha256)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'1',?,?,?)`).bind("88888888-8888-4888-8888-888888888889", "a".repeat(64), "55555555-5555-4555-8555-555555555556", recordId,
        "project-alpha:primary", "11111111-1111-4111-8111-111111111112", "22222222-2222-4222-8222-222222222223", "33333333-3333-4333-8333-333333333334", "client", recordId,
        "b".repeat(32), "d".repeat(64), "e".repeat(64), "f".repeat(64)).run();
    await db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
      VALUES(? ,?,?,?,?,?,?,?,?)`).bind("88888888-8888-4888-8888-888888888889", recordId, "project-alpha:primary", "11111111-1111-4111-8111-111111111112", "22222222-2222-4222-8222-222222222223", "33333333-3333-4333-8333-333333333334", "client", recordId, "b".repeat(32)).run();
    await db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,actor_id,request_sha256)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind("99999999-9999-4999-8999-999999999990", "88888888-8888-4888-8888-888888888889", "99999999-9999-4999-8999-999999999999", recordId,
        "project-alpha:primary", "11111111-1111-4111-8111-111111111112", "22222222-2222-4222-8222-222222222223", "33333333-3333-4333-8333-333333333334", "client", recordId, "b".repeat(32), historyId, "a".repeat(64)).run();
    await db.prepare("INSERT INTO project_alpha_acquired_mapping_activation(receipt_id) VALUES(?)").bind("88888888-8888-4888-8888-888888888889").run();
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
      activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,record_id,source_id,source_instance_id,
      application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,local_record_version,
      request_sha256,acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256,activated_by_staff_id,directory_grant_generation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'1',1,?,?,?,?,?,?)`).bind(activationId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", activationId, "88888888-8888-4888-8888-888888888889", "99999999-9999-4999-8999-999999999990",
        recordId, "project-alpha:primary", "11111111-1111-4111-8111-111111111112", "22222222-2222-4222-8222-222222222223", "33333333-3333-4333-8333-333333333334", "client", recordId, "b".repeat(32), "a".repeat(64), "d".repeat(64), "e".repeat(64), "f".repeat(64), historyId, grantGeneration).run();
    await db.prepare(`INSERT INTO client_portal_workspace_binding_selections(
      selection_id,request_sha256,client_authority_id,record_id,activation_id,record_version,source_id,source_instance_id,application_id,
      history_epoch_id,root_type,root_public_id,workspace_id,source_workspace_id,checkpoint_source_generation,checkpoint_source_sequence,
      checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,reviewed_admission_version,reviewed_profile_version,
      reviewed_grant_generation,verified_until,state)
      VALUES(?,?,?,?,?,1,?,'11111111-1111-4111-8111-111111111112','22222222-2222-4222-8222-222222222223','33333333-3333-4333-8333-333333333334','standalone_client',?,
        'cancellation-chain-workspace','cancellation-chain-source-workspace','generation',1,'snapshot',?,?,1,1,?,'2099-01-01T00:00:00.000Z','inactive')`)
      .bind(selectionId, "9".repeat(64), authorityId, recordId, activationId, "project-alpha:primary", "b".repeat(32), historyId, owner.identity.verifiedAccessSubject, grantGeneration).run();
    await db.prepare(`INSERT INTO client_portal_workspace_binding_outbox(operation_id,client_authority_id,workspace_id,projection_source_id,source_workspace_id,root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,reviewed_admission_version,reviewed_profile_version,reviewed_grant_generation)
      VALUES(?,?,?,?,?,'standalone_client',?,'generation',1,'snapshot',?,?,1,1,?)`).bind(selectionId, authorityId, "cancellation-chain-workspace", "project-alpha:primary", "cancellation-chain-source-workspace", "b".repeat(32), historyId, owner.identity.verifiedAccessSubject, grantGeneration).run();
    await db.prepare("INSERT INTO client_portal_workspace_binding_outbox_audit VALUES(?,'inactive.binding.enqueued',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(selectionId, historyId, grantGeneration).run();
    await db.prepare("UPDATE client_portal_workspace_binding_outbox SET state='dispatching',claim_token='cancellation-chain-claim',claim_until='2099-01-01T00:00:00.000Z' WHERE operation_id=?").bind(selectionId).run();
    await db.prepare(`INSERT INTO client_portal_workspace_binding_outbox_receipts(operation_id,client_authority_id,workspace_id,projection_source_id,source_workspace_id,root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,checkpoint_snapshot_generation_id,state,revision,replayed,acknowledged_claim_token)
      VALUES(?,?,?,?,?,'standalone_client',?,'generation',1,'snapshot','inactive',1,0,'cancellation-chain-claim')`).bind(selectionId, authorityId, "cancellation-chain-workspace", "project-alpha:primary", "cancellation-chain-source-workspace", "b".repeat(32)).run();
    await db.prepare("UPDATE client_portal_workspace_binding_outbox SET state='acknowledged',attempt_count=1,claim_token=NULL,claim_until=NULL,acknowledged_claim_token='cancellation-chain-claim' WHERE operation_id=?").bind(selectionId).run();
    const issuedIntentId = "44444444-4444-4444-8444-444444444444";
    const pendingIntentId = "55555555-5555-4555-8555-555555555555";
    const issuedTokenDigest = "a".repeat(64);
    const pendingTokenDigest = "b".repeat(64);
    const issueRequestDigest = "c".repeat(64);
    const redeemRequestDigest = "d".repeat(64);
    await db.batch([
      db.prepare(`INSERT INTO client_portal_recipient_enrollment_intents(
        intent_id,selection_id,target_client_record_id,token_sha256,state,revision,issued_by_staff_id,issued_access_subject,
        issued_admission_version,issued_profile_version,issued_grant_generation,expires_at)
        VALUES(?,?,?,?,'issued',1,?,?,?,?,?,?)`).bind(issuedIntentId, selectionId, recordId, issuedTokenDigest, historyId,
          owner.identity.verifiedAccessSubject, 1, 1, grantGeneration, "2099-01-01T00:00:00.000Z"),
      db.prepare(`INSERT INTO client_portal_recipient_enrollment_intents(
        intent_id,selection_id,target_client_record_id,token_sha256,state,revision,issued_by_staff_id,issued_access_subject,
        issued_admission_version,issued_profile_version,issued_grant_generation,expires_at)
        VALUES(?,?,?,?,'issued',1,?,?,?,?,?,?)`).bind(pendingIntentId, selectionId, recordId, pendingTokenDigest, historyId,
          owner.identity.verifiedAccessSubject, 1, 1, grantGeneration, "2099-01-01T00:00:00.000Z"),
    ]);
    await db.batch([
      db.prepare(`INSERT INTO client_portal_recipient_enrollment_operations(
        operation_id,intent_id,action,request_sha256,resulting_revision,resulting_state,actor_staff_id,actor_access_subject,
        actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
        VALUES(?,?, 'issue',?,1,'issued',?,?,?,?,?,?)`).bind("66666666-6666-4666-8666-666666666666", issuedIntentId, issueRequestDigest,
          historyId, owner.identity.verifiedAccessSubject, 1, 1, grantGeneration, "2099-01-01T00:00:00.000Z"),
      db.prepare(`INSERT INTO client_portal_recipient_enrollment_operations(
        operation_id,intent_id,action,request_sha256,resulting_revision,resulting_state,actor_staff_id,actor_access_subject,
        actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
        VALUES(?,?, 'issue',?,1,'issued',?,?,?,?,?,?)`).bind("77777777-7777-4777-8777-777777777777", pendingIntentId, issueRequestDigest,
          historyId, owner.identity.verifiedAccessSubject, 1, 1, grantGeneration, "2099-01-01T00:00:00.000Z"),
    ]);
    await db.batch([
      db.prepare("INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind("66666666-6666-4666-8666-666666666666", issuedIntentId),
      db.prepare("INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind("77777777-7777-4777-8777-777777777777", pendingIntentId),
      db.prepare(`INSERT INTO client_portal_recipient_enrollment_operations(
        operation_id,intent_id,action,request_sha256,resulting_revision,resulting_state)
        VALUES(?,?, 'redeem',?,2,'pending')`).bind("88888888-8888-4888-8888-888888888888", pendingIntentId, redeemRequestDigest),
    ]);
    await db.prepare(`UPDATE client_portal_recipient_enrollment_intents
      SET state='pending',revision=2,access_issuer='https://client.cloudflareaccess.com',access_subject='access|historical-recipient',
        recipient_verified_until='2099-01-01T00:00:00.000Z'
      WHERE intent_id=?`).bind(pendingIntentId).run();
    await db.prepare("INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)")
      .bind("88888888-8888-4888-8888-888888888888", pendingIntentId).run();
  }, 240_000);
  afterAll(async () => { await runtime?.dispose(); });

  it("rolls back every candidate schema change on a late batch failure, then applies additively", async () => {
    const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
    const originalSchema: SchemaObject[] = (await db.prepare(schemaQuery).all<SchemaObject>()).results;
    const originalHistory = (await db.prepare("SELECT * FROM staff_users ORDER BY id").all()).results;
    const originalRoles = (await db.prepare("SELECT * FROM staff_role_assignments ORDER BY staff_id,role_id,scope").all()).results;
    const originalIntents = (await db.prepare("SELECT * FROM client_portal_recipient_enrollment_intents ORDER BY intent_id").all()).results;
    const originalOperations = (await db.prepare("SELECT * FROM client_portal_recipient_enrollment_operations ORDER BY operation_id").all()).results;
    const originalCommits = (await db.prepare("SELECT * FROM client_portal_recipient_enrollment_operation_commits ORDER BY operation_id").all()).results;
    const statements = splitD1MigrationStatements(candidate).map(sql => db.prepare(sql));
    // A duplicate historical primary key is an intentional late failure, not a
    // guard bypass. DDL and all new triggers must roll back with the batch.
    await expect(db.batch([...statements, db.prepare("INSERT INTO staff_users SELECT * FROM staff_users WHERE id=?").bind(historyId)]))
      .rejects.toThrow();
    expect((await db.prepare("SELECT * FROM staff_role_assignments ORDER BY staff_id,role_id,scope").all()).results).toEqual(originalRoles);
    expect((await db.prepare(schemaQuery).all()).results).toEqual(originalSchema);
    expect((await db.prepare("SELECT * FROM staff_users ORDER BY id").all()).results).toEqual(originalHistory);
    expect((await db.prepare("SELECT * FROM client_portal_recipient_enrollment_intents ORDER BY intent_id").all()).results).toEqual(originalIntents);
    expect((await db.prepare("SELECT * FROM client_portal_recipient_enrollment_operations ORDER BY operation_id").all()).results).toEqual(originalOperations);
    expect((await db.prepare("SELECT * FROM client_portal_recipient_enrollment_operation_commits ORDER BY operation_id").all()).results).toEqual(originalCommits);
    await db.batch(splitD1MigrationStatements(candidate).map(sql => db.prepare(sql)));
    const resultingSchema: SchemaObject[] = (await db.prepare(schemaQuery).all<SchemaObject>()).results;
    const oldNames = new Set(originalSchema.map(row => row.name));
    expect(resultingSchema.filter(row => oldNames.has(row.name))).toEqual(originalSchema);
    expect(resultingSchema.filter(row => !oldNames.has(row.name)).map(row => row.name).sort()).toEqual([
      "client_portal_recipient_enrollment_cancellations",
      "client_portal_recipient_enrollment_cancellation_audit",
      "client_portal_recipient_enrollment_cancellation_operation_id_guard",
      "client_portal_recipient_enrollment_cancellation_insert_guard",
      "client_portal_recipient_enrollment_cancellation_no_update",
      "client_portal_recipient_enrollment_cancellation_no_delete",
      "client_portal_recipient_enrollment_operation_cancel_fence",
      "client_portal_recipient_enrollment_commit_cancel_fence",
      "client_portal_recipient_enrollment_intent_cancel_fence",
      "client_portal_recipient_enrollment_outbox_cancel_fence",
      "client_portal_recipient_enrollment_outbox_cancel_update_fence",
    ].sort());
    expect((await db.prepare("SELECT * FROM staff_users ORDER BY id").all()).results).toEqual(originalHistory);
    expect((await db.prepare("SELECT * FROM staff_role_assignments ORDER BY staff_id,role_id,scope").all()).results).toEqual(originalRoles);
    expect((await db.prepare("SELECT * FROM client_portal_recipient_enrollment_intents ORDER BY intent_id").all()).results).toEqual(originalIntents);
    expect((await db.prepare("SELECT * FROM client_portal_recipient_enrollment_operations ORDER BY operation_id").all()).results).toEqual(originalOperations);
    expect((await db.prepare("SELECT * FROM client_portal_recipient_enrollment_operation_commits ORDER BY operation_id").all()).results).toEqual(originalCommits);
    expect(await db.prepare("SELECT count(*) n FROM client_portal_recipient_enrollment_cancellations").first("n")).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 120_000);
});
