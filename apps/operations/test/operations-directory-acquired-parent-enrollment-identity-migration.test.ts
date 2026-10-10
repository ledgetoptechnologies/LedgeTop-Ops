import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { acquiredDirectoryMappingUpdateEvidence } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";

const sourceId = "project-alpha:primary";
const sourceInstanceId = "10000000-0000-4000-8000-000000000001";
const applicationId = "10000000-0000-4000-8000-000000000002";
const historyEpochId = "10000000-0000-4000-8000-000000000003";
const origin = "https://pa.example.test";
const organizationRecordId = "ops/organization/parent";
const organizationExternalId = "pa/organization/parent";
const organizationPublicId = "a".repeat(32);
const activationId = "20000000-0000-4000-8000-000000000001";
const acquiredReceiptId = "20000000-0000-4000-8000-000000000002";
const nativeOwnerClaimId = "20000000-0000-4000-8000-000000000003";
const nativeOwnerEpochId = "20000000-0000-4000-8000-000000000004";
const enrollment = JSON.stringify([{ sourceId, sourceInstanceUUID: sourceInstanceId,
  applicationUUID: applicationId, historyEpoch: historyEpochId, origin,
  externalCanonicalId: organizationRecordId }]);

describe("0175 acquired parent enrollment identity guard", () => {
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
      CREATE TABLE operations_directory_revisions(
        record_id TEXT NOT NULL,version INTEGER NOT NULL,mutation_id TEXT NOT NULL UNIQUE,
        profile_json TEXT NOT NULL,PRIMARY KEY(record_id,version));
      CREATE TABLE operations_directory_audit(
        audit_id TEXT PRIMARY KEY,mutation_id TEXT NOT NULL,record_id TEXT NOT NULL,
        record_version INTEGER NOT NULL,actor_type TEXT NOT NULL,command_json TEXT NOT NULL);
      CREATE TABLE operations_directory_intents(
        intent_id TEXT PRIMARY KEY,mutation_id TEXT NOT NULL,record_id TEXT NOT NULL,
        record_version INTEGER NOT NULL,source_id TEXT NOT NULL,source_instance_uuid TEXT NOT NULL,
        application_uuid TEXT NOT NULL,destination_origin TEXT NOT NULL,
        external_canonical_id TEXT NOT NULL,expected_history_epoch_id TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE operations_directory_materializations(
        intent_id TEXT PRIMARY KEY,command_id TEXT NOT NULL,command_json TEXT NOT NULL,
        history_epoch_id TEXT NOT NULL);
      CREATE TABLE project_alpha_directory_outbox(
        command_id TEXT PRIMARY KEY,state TEXT NOT NULL,command_json TEXT NOT NULL,
        outcome_json TEXT,source_id TEXT NOT NULL,expected_source_instance_id TEXT NOT NULL,
        application_id TEXT NOT NULL,expected_history_epoch_id TEXT NOT NULL,
        destination_base_url TEXT NOT NULL,resource_type TEXT NOT NULL,external_id TEXT NOT NULL);
      CREATE TABLE operations_directory_client_organizations(
        client_record_id TEXT PRIMARY KEY,organization_record_id TEXT,relationship_version INTEGER NOT NULL);
      CREATE TABLE operations_directory_client_organization_history(
        client_record_id TEXT NOT NULL,relationship_version INTEGER NOT NULL,mutation_id TEXT NOT NULL,
        previous_organization_record_id TEXT,organization_record_id TEXT,client_record_version INTEGER NOT NULL,
        previous_organization_record_version INTEGER,organization_record_version INTEGER,
        PRIMARY KEY(client_record_id,relationship_version));
      CREATE TABLE operations_directory_live_write_fences(
        mutation_id TEXT PRIMARY KEY,record_id TEXT NOT NULL,record_writes INTEGER NOT NULL,
        revision_writes INTEGER NOT NULL,audit_writes INTEGER NOT NULL,intent_writes INTEGER NOT NULL);
      CREATE TABLE native_directory_enrollments(
        record_id TEXT PRIMARY KEY,destinations_json TEXT NOT NULL,create_admission_id TEXT NOT NULL);
      CREATE TRIGGER native_directory_enrollments_no_update BEFORE UPDATE ON native_directory_enrollments
        BEGIN SELECT RAISE(ABORT,'native directory enrollment is immutable'); END;
      CREATE TRIGGER native_directory_enrollments_no_delete BEFORE DELETE ON native_directory_enrollments
        BEGIN SELECT RAISE(ABORT,'native directory enrollment is durable'); END;
      CREATE TABLE project_alpha_directory_mappings(
        source_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,
        source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,command_id TEXT,created_at TEXT);
      CREATE TABLE project_alpha_acquired_native_owner_claims(
        claim_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,native_owner_epoch_id TEXT NOT NULL,
        record_id TEXT NOT NULL,source_id TEXT NOT NULL,source_instance_id TEXT NOT NULL,
        application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,resource_type TEXT NOT NULL,
        external_id TEXT NOT NULL,project_alpha_public_id TEXT NOT NULL,
        expected_local_record_version INTEGER NOT NULL,actor_id TEXT NOT NULL,request_sha256 TEXT NOT NULL);
      CREATE TABLE project_alpha_existing_directory_binding_activation_receipts(
        activation_id TEXT PRIMARY KEY,acquired_receipt_id TEXT NOT NULL,
        native_owner_claim_id TEXT NOT NULL REFERENCES project_alpha_acquired_native_owner_claims(claim_id),
        record_id TEXT NOT NULL,source_id TEXT NOT NULL,
        source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,external_id TEXT NOT NULL,project_alpha_public_id TEXT NOT NULL,
        project_alpha_revision TEXT NOT NULL,local_record_version INTEGER NOT NULL,
        expected_authorization_generation TEXT NOT NULL,result_authorization_generation TEXT NOT NULL,
        activated_at TEXT NOT NULL);
      CREATE TRIGGER project_alpha_existing_directory_binding_activation_owner_exact
        BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
        WHEN NOT EXISTS(SELECT 1 FROM project_alpha_acquired_native_owner_claims claim
          WHERE claim.claim_id=NEW.native_owner_claim_id AND claim.receipt_id=NEW.acquired_receipt_id
            AND claim.record_id=NEW.record_id AND claim.source_id=NEW.source_id
            AND claim.source_instance_id=NEW.source_instance_id AND claim.application_id=NEW.application_id
            AND claim.history_epoch_id=NEW.history_epoch_id AND claim.resource_type=NEW.resource_type
            AND claim.external_id=NEW.external_id
            AND claim.project_alpha_public_id=NEW.project_alpha_public_id
            AND claim.expected_local_record_version=NEW.local_record_version)
        BEGIN SELECT RAISE(ABORT,'activation requires exact native owner claim'); END;
      CREATE TABLE project_alpha_existing_directory_binding_revision_refresh_receipts(
        receipt_id TEXT PRIMARY KEY,native_owner_claim_id TEXT NOT NULL
          REFERENCES project_alpha_acquired_native_owner_claims(claim_id),
        record_id TEXT NOT NULL,local_record_version INTEGER NOT NULL,source_id TEXT NOT NULL,
        source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,external_id TEXT NOT NULL,project_alpha_public_id TEXT NOT NULL,
        live_revision TEXT NOT NULL,authorization_generation TEXT NOT NULL);
      CREATE TABLE project_alpha_existing_directory_binding_revision_refresh_commands(
        predecessor_refresh_receipt_id TEXT,native_owner_claim_id TEXT NOT NULL
          REFERENCES project_alpha_acquired_native_owner_claims(claim_id),
        record_id TEXT NOT NULL,expected_local_record_version INTEGER NOT NULL,source_id TEXT NOT NULL,
        source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,external_id TEXT NOT NULL,project_alpha_public_id TEXT NOT NULL);
      CREATE VIEW project_alpha_active_directory_mappings AS
        SELECT source_id,resource_type,external_id AS record_id,external_id,project_alpha_public_id,
          source_instance_id,application_id,history_epoch_id,command_id AS provenance_id,
          'legacy' AS mapping_kind,created_at
        FROM project_alpha_directory_mappings
        UNION ALL
        SELECT source_id,resource_type,record_id,external_id,project_alpha_public_id,
          source_instance_id,application_id,history_epoch_id,activation_id AS provenance_id,
          'acquired' AS mapping_kind,activated_at AS created_at
        FROM project_alpha_existing_directory_binding_activation_receipts;
      CREATE TABLE operations_directory_intent_relationship_dependencies(
        intent_id TEXT PRIMARY KEY,client_record_id TEXT NOT NULL,client_record_version INTEGER NOT NULL,
        relationship_version INTEGER NOT NULL,relationship_mutation_id TEXT NOT NULL,
        organization_record_id TEXT,organization_record_version INTEGER,source_id TEXT NOT NULL,
        source_instance_uuid TEXT NOT NULL,application_uuid TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
        destination_origin TEXT NOT NULL,parent_external_canonical_id TEXT,evidence_kind TEXT NOT NULL,
        parent_intent_id TEXT,parent_mapping_command_id TEXT,parent_activation_id TEXT,
        parent_public_id TEXT,parent_ack_revision TEXT,parent_ack_command_json TEXT,
        parent_ack_outcome_json TEXT);
      CREATE TRIGGER operations_directory_intent_relationship_dependencies_insert_guard
        BEFORE INSERT ON operations_directory_intent_relationship_dependencies WHEN 0
        BEGIN SELECT RAISE(ABORT,'old guard'); END;
    `).map(statement => db.prepare(statement)));
    const migration = readFileSync(new URL(
      "../migrations/0175_operations_directory_acquired_parent_enrollment_identity.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement)));
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(organizationRecordId),
      db.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,'parent-create','{}')").bind(organizationRecordId),
      db.prepare("INSERT INTO native_directory_enrollments VALUES(?,?,'parent-admission')")
        .bind(organizationRecordId,enrollment),
      db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(
        claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,source_instance_id,application_id,
        history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,
        actor_id,request_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(nativeOwnerClaimId,acquiredReceiptId,nativeOwnerEpochId,
          organizationRecordId,sourceId,sourceInstanceId,applicationId,historyEpochId,"organization",
          organizationExternalId,organizationPublicId,1,"owner","c".repeat(64)),
      db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
        activation_id,acquired_receipt_id,native_owner_claim_id,record_id,source_id,source_instance_id,
        application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
        project_alpha_revision,local_record_version,expected_authorization_generation,
        result_authorization_generation,activated_at)
        VALUES(?,?,?,?,?,?,?,?,'organization',?,?,'7',1,'3','4','2026-10-05T00:00:00.000Z')`)
        .bind(activationId,acquiredReceiptId,nativeOwnerClaimId,organizationRecordId,sourceId,
          sourceInstanceId,applicationId,historyEpochId,organizationExternalId,organizationPublicId),
    ]);
  });

  afterEach(async () => { await runtime.dispose(); });

  async function seedClient(stem: string) {
    const clientRecordId = `ops/client/${stem}`, mutationId = `client-mutation-${stem}`,
      intentId = `client-intent-${stem}`, relationshipMutationId = `relationship-${stem}`;
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(clientRecordId),
      db.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,?,'{}')").bind(clientRecordId,mutationId),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?,1)")
        .bind(clientRecordId,organizationRecordId),
      db.prepare(`INSERT INTO operations_directory_client_organization_history
        VALUES(?,1,?,NULL,?,1,NULL,1)`).bind(clientRecordId,relationshipMutationId,organizationRecordId),
      db.prepare(`INSERT INTO operations_directory_intents VALUES(?,?,?,1,?,?,?,?,?,?,'ready')`)
        .bind(intentId,mutationId,clientRecordId,sourceId,sourceInstanceId,applicationId,origin,
          `pa/client/${stem}`,historyEpochId),
      db.prepare("INSERT INTO operations_directory_live_write_fences VALUES(?,?,0,0,0,0)")
        .bind(mutationId,clientRecordId),
    ]);
    return { clientRecordId,intentId,relationshipMutationId };
  }

  async function insertDependency(stem: string, overrides: Record<string, unknown> = {}) {
    const client = await seedClient(stem);
    const row = { ...client, clientRecordVersion: 1, relationshipVersion: 1,
      organizationRecordId, organizationRecordVersion: 1, sourceId, sourceInstanceId, applicationId,
      historyEpochId, origin, parentExternalId: organizationExternalId, evidenceKind: "acquired_mapping",
      parentIntentId: null, parentMappingCommandId: null, parentActivationId: activationId,
      parentPublicId: organizationPublicId, parentAckRevision: "7", parentAckCommandJson: null,
      parentAckOutcomeJson: null, ...overrides };
    return db.prepare(`INSERT INTO operations_directory_intent_relationship_dependencies(
      intent_id,client_record_id,client_record_version,relationship_version,relationship_mutation_id,
      organization_record_id,organization_record_version,source_id,source_instance_uuid,application_uuid,
      history_epoch_id,destination_origin,parent_external_canonical_id,evidence_kind,parent_intent_id,
      parent_mapping_command_id,parent_activation_id,parent_public_id,parent_ack_revision,
      parent_ack_command_json,parent_ack_outcome_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(row.intentId,row.clientRecordId,row.clientRecordVersion,row.relationshipVersion,
        row.relationshipMutationId,row.organizationRecordId,row.organizationRecordVersion,row.sourceId,
        row.sourceInstanceId,row.applicationId,row.historyEpochId,row.origin,row.parentExternalId,
        row.evidenceKind,row.parentIntentId,row.parentMappingCommandId,row.parentActivationId,
        row.parentPublicId,row.parentAckRevision,row.parentAckCommandJson,row.parentAckOutcomeJson).run();
  }

  async function seedParentUpdate(state: "acknowledged" | "pending" = "acknowledged") {
    const command = JSON.stringify({ operation: "update",resourceType: "organization",
      externalId: organizationExternalId,expectedProjectAlphaPublicId: organizationPublicId });
    const outcome = JSON.stringify({ status: "acknowledged",response: { sourceInstanceId,applicationId,
      historyEpoch: historyEpochId,result: { resource: { type: "organization",publicId: organizationPublicId,
        revision: "8" }, authorizationGeneration: "5" } } });
    await db.batch([
      db.prepare("UPDATE operations_directory_records SET current_version=2 WHERE record_id=?")
        .bind(organizationRecordId),
      db.prepare("INSERT INTO operations_directory_revisions VALUES(?,2,'parent-update','{}')")
        .bind(organizationRecordId),
      db.prepare("INSERT INTO operations_directory_audit VALUES('parent-audit','parent-update',?,2,'staff',?)")
        .bind(organizationRecordId,JSON.stringify({ operation: "update" })),
      db.prepare(`INSERT INTO operations_directory_intents VALUES(
        'parent-update-intent','parent-update',?,2,?,?,?,?,?,?,'acknowledged')`)
        .bind(organizationRecordId,sourceId,sourceInstanceId,applicationId,origin,organizationExternalId,historyEpochId),
      db.prepare("INSERT INTO operations_directory_materializations VALUES('parent-update-intent','parent-update-command',?,?)")
        .bind(command,historyEpochId),
      db.prepare(`INSERT INTO project_alpha_directory_outbox VALUES(
        'parent-update-command',?,?,?,?,?,?,?,?,?,?)`)
        .bind(state,command,outcome,sourceId,sourceInstanceId,applicationId,historyEpochId,origin,
          "organization",organizationExternalId),
    ]);
  }

  it("keeps the immutable enrollment on the Ops ID and accepts the exact acquired identity", async () => {
    await expect(insertDependency("initial")).resolves.toBeTruthy();
    expect(JSON.parse(await db.prepare("SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?")
      .bind(organizationRecordId).first<string>("destinations_json") ?? "[]"))
      .toEqual([{ sourceId,sourceInstanceUUID: sourceInstanceId,applicationUUID: applicationId,
        historyEpoch: historyEpochId,origin,externalCanonicalId: organizationRecordId }]);
    await expect(db.prepare("UPDATE native_directory_enrollments SET destinations_json='[]' WHERE record_id=?")
      .bind(organizationRecordId).run()).rejects.toThrow("native directory enrollment is immutable");
  });

  it("validates a split Ops/PA update through the real acquired view and exact activation tuple", async () => {
    const context = { record_id: organizationRecordId, external_id: organizationExternalId, source_id: sourceId,
      expected_source_instance_id: sourceInstanceId, application_id: applicationId,
      expected_history_epoch_id: historyEpochId, resource_type: "organization" as const,
      destination_base_url: origin, record_version: 2 };
    await expect(acquiredDirectoryMappingUpdateEvidence(db, context, "7", "4", organizationPublicId)).resolves.toBe(true);
    await expect(acquiredDirectoryMappingUpdateEvidence(db, { ...context, source_id: "project-alpha:secondary" },
      "7", "4", organizationPublicId)).resolves.toBe(false);
    await expect(acquiredDirectoryMappingUpdateEvidence(db, { ...context, external_id: "pa/organization/wrong" },
      "7", "4", organizationPublicId)).resolves.toBe(false);
    await expect(acquiredDirectoryMappingUpdateEvidence(db, context, "7", "4", "b".repeat(32))).resolves.toBe(false);
  });

  it("requires an acquired activation to carry the exact native owner claim", async () => {
    await expect(db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
      activation_id,acquired_receipt_id,native_owner_claim_id,record_id,source_id,source_instance_id,
      application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
      project_alpha_revision,local_record_version,expected_authorization_generation,
      result_authorization_generation,activated_at)
      VALUES('20000000-0000-4000-8000-000000000005','wrong-receipt',?,?,?,?,?,?,
        'organization',?,?,'7',1,'3','4','2026-10-05T00:00:00.000Z')`)
      .bind(nativeOwnerClaimId,organizationRecordId,sourceId,sourceInstanceId,applicationId,historyEpochId,
        organizationExternalId,organizationPublicId).run())
      .rejects.toThrow("activation requires exact native owner claim");
  });

  it("does not accept refresh evidence whose owner claim is for a different acquired receipt", async () => {
    const mismatchedClaimId = "20000000-0000-4000-8000-000000000006";
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(
        claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,source_instance_id,application_id,
        history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,
        actor_id,request_sha256) VALUES(?,'wrong-receipt','20000000-0000-4000-8000-000000000007',
          ?,?,?,?,?,'organization',?,?,1,'owner',?)`)
        .bind(mismatchedClaimId,organizationRecordId,sourceId,sourceInstanceId,applicationId,historyEpochId,
          organizationExternalId,organizationPublicId,"d".repeat(64)),
      db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_receipts(
        receipt_id,native_owner_claim_id,record_id,local_record_version,source_id,source_instance_id,
        application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
        live_revision,authorization_generation)
        VALUES('20000000-0000-4000-8000-000000000008',?,?,1,?,?,?,?,'organization',?,?,'8','5')`)
        .bind(mismatchedClaimId,organizationRecordId,sourceId,sourceInstanceId,applicationId,historyEpochId,
          organizationExternalId,organizationPublicId),
    ]);
    const context = { record_id: organizationRecordId, external_id: organizationExternalId, source_id: sourceId,
      expected_source_instance_id: sourceInstanceId, application_id: applicationId,
      expected_history_epoch_id: historyEpochId, resource_type: "organization" as const,
      destination_base_url: origin, record_version: 2 };
    await expect(acquiredDirectoryMappingUpdateEvidence(db, context, "8", "5", organizationPublicId))
      .resolves.toBe(false);
  });

  it("accepts later acquired updates only from the exact acknowledged current-version PA tuple", async () => {
    await seedParentUpdate();
    const context = { record_id: organizationRecordId, external_id: organizationExternalId, source_id: sourceId,
      expected_source_instance_id: sourceInstanceId, application_id: applicationId,
      expected_history_epoch_id: historyEpochId, resource_type: "organization" as const,
      destination_base_url: origin, record_version: 3 };
    await expect(acquiredDirectoryMappingUpdateEvidence(db, context, "8", "5", organizationPublicId)).resolves.toBe(true);
    await expect(acquiredDirectoryMappingUpdateEvidence(db, context, "7", "5", organizationPublicId)).resolves.toBe(false);
    await expect(acquiredDirectoryMappingUpdateEvidence(db, context, "8", "4", organizationPublicId)).resolves.toBe(false);
    await expect(acquiredDirectoryMappingUpdateEvidence(db, { ...context, expected_history_epoch_id: "30000000-0000-4000-8000-000000000003" },
      "8", "5", organizationPublicId)).resolves.toBe(false);
  });

  it("accepts only the exact acknowledged PA update for the current Ops parent version", async () => {
    await seedParentUpdate();
    await expect(insertDependency("updated",{ organizationRecordVersion: 2 })).resolves.toBeTruthy();
  });

  it("rejects missing or mismatched receipts and every wrong authority tuple", async () => {
    const cases: Array<[string,Record<string,unknown>]> = [
      ["missing",{ parentActivationId: "missing-activation" }],
      ["external",{ parentExternalId: "pa/organization/wrong" }],
      ["public",{ parentPublicId: "b".repeat(32) }],
      ["revision",{ parentAckRevision: "8" }],
      ["source",{ sourceId: "project-alpha:secondary" }],
      ["instance",{ sourceInstanceId: "30000000-0000-4000-8000-000000000001" }],
      ["application",{ applicationId: "30000000-0000-4000-8000-000000000002" }],
      ["history",{ historyEpochId: "30000000-0000-4000-8000-000000000003" }],
      ["origin",{ origin: "https://other-pa.example.test" }],
    ];
    for (const [name,overrides] of cases)
      await expect(insertDependency(name,overrides))
        .rejects.toThrow("directory intent relationship dependency requires live canonical evidence");
  });

  it("rejects stale parent versions and unacknowledged updates", async () => {
    await db.prepare("UPDATE operations_directory_records SET current_version=2 WHERE record_id=?")
      .bind(organizationRecordId).run();
    await db.prepare("INSERT INTO operations_directory_revisions VALUES(?,2,'parent-stale','{}')")
      .bind(organizationRecordId).run();
    await expect(insertDependency("stale",{ organizationRecordVersion: 2 }))
      .rejects.toThrow("directory intent relationship dependency requires live canonical evidence");
  });

  it("rejects an update whose PA outbox result is not acknowledged", async () => {
    await seedParentUpdate("pending");
    await expect(insertDependency("pending",{ organizationRecordVersion: 2 }))
      .rejects.toThrow("directory intent relationship dependency requires live canonical evidence");
  });

  it("does not treat a legacy mapping as acquired parent evidence", async () => {
    await db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(
      ?, 'organization', ?, ?, ?, ?, ?, 'legacy-command','2026-10-05T00:00:00.000Z')`)
      .bind(sourceId,organizationExternalId,organizationPublicId,sourceInstanceId,applicationId,historyEpochId).run();
    await expect(insertDependency("legacy",{ parentActivationId: "legacy-command" }))
      .rejects.toThrow("directory intent relationship dependency requires live canonical evidence");
  });
});
