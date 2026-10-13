import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyOperationsPortalNativeRecipientAuthority, readOperationsPortalNativeRecipientAuthorityStatus }
  from "../../client/src/worker/operations-portal-native-recipient-authority";
import { issueOperationsPortalNativeRecipientIntent, redeemOperationsPortalNativeRecipientIntent,
  cancelOperationsPortalNativeRecipientIntent, confirmOperationsPortalNativeRecipientIntent,
  revokeOperationsPortalNativeRecipient, readOperationsPortalNativeRecipientIntent,
  readOperationsPortalNativeRecipientIntentForOwner } from "../src/worker/operations-portal-native-recipient-authority";
import { dispatchOperationsPortalNativeRecipientAuthority, materializeOperationsPortalNativeRecipientAuthority }
  from "../src/worker/operations-portal-native-recipient-authority-dispatch";
import { readOperationsPortalNativeWorkspaceCleanupForOwner, reserveOperationsPortalNativeWorkspaceCleanupRecovery,
  revokeOperationsPortalNativeWorkspaceAuthority }
  from "../src/worker/operations-portal-native-workspace-cleanup";
import { readClientPortalServiceMetadata } from "../src/worker/client-portal-service-metadata";

const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const targetId = id(1), authorityId = id(2), publicationOperationId = id(3), publicationId = id(4), snapshotId = id(5),
  checkpointId = id(6);
const rootId = "organization:one", clientId = "client:one", workspaceId = "workspace-one";
const issuer = "https://team.cloudflareaccess.com", subject = "access|recipient", sha = "a".repeat(64);
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const owner = { identity: { kind: "native" as const, staffId: "staff:owner", verifiedAccessSubject: "access|owner",
  email: "owner@example.test", displayName: "Owner", profileVersion: 3 }, admissionVersion: 2, verifiedUntil: future() };

async function applyCleanupMigration(database: D1Database) {
  const migration = readFileSync(new URL("../migrations/0157_operations_portal_native_workspace_cleanup.sql",
    import.meta.url), "utf8");
  await database.batch(splitD1MigrationStatements(migration).map(statement => database.prepare(statement)));
  // 0160 is ordered after 0157 in release. Refresh its narrowed replacement
  // triggers here because this fixture deliberately applies 0157 over a
  // populated 0154/0160 recipient workflow.
  const labels = readFileSync(new URL("../migrations/0160_operations_portal_native_recipient_labels.sql",
    import.meta.url), "utf8");
  await database.batch(splitD1MigrationStatements(labels).map(statement => database.prepare(statement)));
}

async function advancePublication(ops: D1Database) {
  const nextOperation = id(50), nextPublication = id(51), nextSnapshot = id(52), nextCheckpoint = id(53);
  const nextSha = "f".repeat(64), nextObservedAt = new Date().toISOString();
  const nextDirectory = [
    { recordId: rootId, kind: "organization", version: "1", parentRecordId: null, relationshipVersion: null,
      displayName: "Exact Organization", externalFences: [] },
    { recordId: clientId, kind: "client", version: "1", parentRecordId: rootId, relationshipVersion: "1",
      displayName: "Exact Client", externalFences: [] },
  ];
  const nextSnapshotDocument = { snapshotId: nextSnapshot, checkpointId: nextCheckpoint, sourceSequence: "2", complete: true,
    counts: { directoryRecords: 2, projects: 0, folderReservations: 0, recipientAuthorityHeads: 0,
      deliveryAuthorityHeads: 0 }, directoryRecords: nextDirectory, projects: [], folderReservations: [],
    recipientAuthorityHeads: [], deliveryAuthorityHeads: [], snapshotSha256: nextSha };
  const nextCanonical = JSON.stringify({ protocol: "operations-portal-workspace-publication", protocolVersion: 1,
    action: "publish", publicationId: nextPublication, operationId: nextOperation, expectedRevision: "1",
    resultingRevision: "2", target: { targetId, targetRevision: "1", clientAuthorityId: authorityId, workspaceId,
      rootKind: "organization", rootRecordId: rootId }, snapshot: nextSnapshotDocument,
    actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
      admissionVersion: "2", profileVersion: "3", grantGeneration: "4", verifiedUntil: owner.verifiedUntil },
    observedAt: nextObservedAt });
  await ops.batch([
    ops.prepare(`INSERT INTO operations_portal_workspace_publication_checkpoints
      VALUES(?,?,1,2,0,0,?,?,?,?,?)`).bind(nextCheckpoint, targetId, "1".repeat(64), "2".repeat(64),
        "3".repeat(64), nextObservedAt, nextObservedAt),
    ops.prepare(`INSERT INTO operations_portal_workspace_publication_directory_sources
      VALUES(?,?,'organization',1,NULL,NULL,'Exact Organization')`).bind(nextCheckpoint, rootId),
    ops.prepare(`INSERT INTO operations_portal_workspace_publication_directory_sources
      VALUES(?,?,'client',1,?,1,'Exact Client')`).bind(nextCheckpoint, clientId, rootId),
    ops.prepare(`INSERT INTO operations_portal_workspace_publication_snapshots
      (snapshot_id,checkpoint_id,target_id,source_sequence,snapshot_sha256,snapshot_json) VALUES(?,?,?,2,?,?)`)
      .bind(nextSnapshot, nextCheckpoint, targetId, nextSha, JSON.stringify(nextSnapshotDocument)),
    ops.prepare(`INSERT INTO operations_portal_workspace_publication_commands
      (operation_id,publication_id,operation_fingerprint,canonical_publication_json,target_id,target_revision,
       client_authority_id,workspace_id,root_kind,root_record_id,expected_revision,resulting_revision,snapshot_id,
       checkpoint_id,source_sequence,snapshot_sha256,authorized_by_staff_id,authorized_access_subject,authorized_email,
       authorized_admission_version,authorized_profile_version,authorized_grant_generation,authorized_verified_until,
       reason,observed_at) VALUES(?,?,?,?,?,1,?,?, 'organization',?,1,2,?,?,2,?,?,?,?,2,3,4,?,'publication drift fixture',?)`)
      .bind(nextOperation, nextPublication, "9".repeat(64), nextCanonical, targetId, authorityId, workspaceId, rootId,
        nextSnapshot, nextCheckpoint, nextSha, owner.identity.staffId, owner.identity.verifiedAccessSubject,
        owner.identity.email, owner.verifiedUntil, nextObservedAt),
    ops.prepare(`INSERT INTO operations_portal_workspace_publication_audit
      VALUES(?,'workspace.snapshot.enqueued',?,4,?)`).bind(nextOperation, owner.identity.staffId, nextObservedAt),
    ops.prepare(`INSERT INTO operations_portal_workspace_publication_outbox(operation_id,target_id,checkpoint_id)
      VALUES(?,?,?)`).bind(nextOperation, targetId, nextCheckpoint),
  ]);
  const nextClaim = "next-publication-claim";
  await ops.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='dispatching',attempt_count=1,
    claim_token=?,claim_until=?,updated_at=? WHERE operation_id=?`).bind(nextClaim, future(), nextObservedAt, nextOperation).run();
  await ops.prepare(`UPDATE operations_portal_workspace_publication_outbox SET remote_attempted=1 WHERE operation_id=?`)
    .bind(nextOperation).run();
  await ops.prepare(`INSERT INTO operations_portal_workspace_publication_receipts VALUES(?,?,?,?,2,2,?,?,?,?)`)
    .bind(nextOperation, nextPublication, "9".repeat(64), targetId, nextSnapshot, nextSha, nextClaim, nextObservedAt).run();
  await ops.prepare(`UPDATE operations_portal_workspace_publication_heads SET publication_revision=2,source_sequence=2,
    snapshot_id=?,checkpoint_id=?,snapshot_sha256=?,latest_operation_id=?,updated_at=? WHERE target_id=?`)
    .bind(nextSnapshot, nextCheckpoint, nextSha, nextOperation, nextObservedAt, targetId).run();
  await ops.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='acknowledged',
    acknowledged_claim_token=?,updated_at=? WHERE operation_id=?`).bind(nextClaim, nextObservedAt, nextOperation).run();
}

describe("Operations-native recipient authority end-to-end D1", () => {
  let runtime: Miniflare, ops: D1Database, client: D1Database;
  beforeEach(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID(), DELIVERY_DB: crypto.randomUUID() } });
    ops = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    client = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await ops.batch([
      ops.prepare(`CREATE TABLE operations_portal_workspace_reservation_heads(target_id TEXT PRIMARY KEY,revision INTEGER,
        client_authority_id TEXT,workspace_id TEXT,root_kind TEXT,root_record_id TEXT,state TEXT)`),
      ops.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER)"),
      ops.prepare(`CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,profile_json TEXT,
        PRIMARY KEY(record_id,version))`),
      ops.prepare(`CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,
        organization_record_id TEXT,relationship_version INTEGER)`),
      ops.prepare(`CREATE TABLE operations_directory_client_organization_history(client_record_id TEXT,
        relationship_version INTEGER,PRIMARY KEY(client_record_id,relationship_version))`),
      ops.prepare(`CREATE TABLE client_onboarding_recipient_identity_bindings(binding_id TEXT PRIMARY KEY,
        target_client_record_id TEXT,access_issuer TEXT,access_subject TEXT,status TEXT,expires_at TEXT,
        revoked_at TEXT,updated_at TEXT)`),
      ops.prepare(`CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,
        active INTEGER,version INTEGER)`),
      ops.prepare(`CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER)`),
      ops.prepare("CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER)"),
      ops.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
      ops.prepare(`CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,
        business_area_id TEXT,division_id TEXT)`),
      ops.prepare(`CREATE TABLE operations_portal_workspace_effective_portal_permissions(staff_id TEXT,effect TEXT,record_id TEXT)`),
      ops.prepare(`CREATE TABLE operations_portal_workspace_effective_permissions(staff_id TEXT,permission_key TEXT,
        effect TEXT,scope TEXT,division_id TEXT)`),
      ops.prepare(`CREATE TABLE operations_portal_folder_reservation_heads(reservation_id TEXT PRIMARY KEY,target_id TEXT,
        state TEXT,revision INTEGER,external_project_id TEXT,ops_folder_project_id TEXT,ops_division_id TEXT,
        client_folder_binding_id TEXT,selected_r2_prefix TEXT,base_r2_prefix TEXT,base_match_method TEXT,
        base_confirmed_by TEXT,base_confirmed_at TEXT)`),
      ops.prepare(`CREATE TABLE operations_shared_projects(external_project_id TEXT PRIMARY KEY,current_version INTEGER,
        name TEXT,lifecycle TEXT,planned_start TEXT,planned_end TEXT,completed_at TEXT,archived INTEGER,archived_at TEXT,
        overdue_warning INTEGER,organization_record_id TEXT,client_record_id TEXT)`),
      ops.prepare(`CREATE TABLE operations_shared_project_revisions(external_project_id TEXT,version INTEGER,
        PRIMARY KEY(external_project_id,version))`),
      ops.prepare(`CREATE TABLE project_folders(project_id TEXT PRIMARY KEY,division_id TEXT,r2_prefix TEXT,
        match_method TEXT,confirmed_by TEXT,confirmed_at TEXT)`),
      ops.prepare("CREATE TABLE operations_service_definitions(service_id TEXT PRIMARY KEY,provider_id TEXT,display_name TEXT)"),
      ops.prepare(`CREATE TABLE operations_customer_service_enrollments(customer_record_id TEXT,service_id TEXT,
        revision INTEGER,state TEXT)`),
    ]);
    const publicationMigration = readFileSync(new URL("../migrations/0153_operations_portal_workspace_publication_outbox.sql",
      import.meta.url), "utf8");
    await ops.batch(splitD1MigrationStatements(publicationMigration).map(statement => ops.prepare(statement)));
    const opsMigration = readFileSync(new URL("../migrations/0154_operations_portal_native_recipient_authority.sql", import.meta.url), "utf8");
    for (const [index, statement] of splitD1MigrationStatements(opsMigration).entries()) {
      try { await ops.prepare(statement).run(); }
      catch (error) { throw new Error(`0154 statement ${index} failed`, { cause: error }); }
    }
    const labelMigration = readFileSync(new URL("../migrations/0160_operations_portal_native_recipient_labels.sql",
      import.meta.url), "utf8");
    await ops.batch(splitD1MigrationStatements(labelMigration).map(statement => ops.prepare(statement)));
    const directoryRecords = [
      { recordId: rootId, kind: "organization", version: "1", parentRecordId: null, relationshipVersion: null,
        displayName: "Exact Organization", externalFences: [] },
      { recordId: clientId, kind: "client", version: "1", parentRecordId: rootId, relationshipVersion: "1",
        displayName: "Exact Client", externalFences: [] },
    ];
    const observedAt = new Date().toISOString();
    const snapshot = { snapshotId, checkpointId, sourceSequence: "1", complete: true,
      counts: { directoryRecords: 2, projects: 0, folderReservations: 0, recipientAuthorityHeads: 0,
        deliveryAuthorityHeads: 0 }, directoryRecords, projects: [], folderReservations: [], recipientAuthorityHeads: [],
      deliveryAuthorityHeads: [], snapshotSha256: sha };
    const directory = JSON.stringify({ directoryRecords: directoryRecords.map(record => ({ recordId: record.recordId,
      kind: record.kind, parentRecordId: record.parentRecordId })) });
    const canonicalPublication = JSON.stringify({ protocol: "operations-portal-workspace-publication", protocolVersion: 1,
      action: "publish", publicationId, operationId: publicationOperationId, expectedRevision: "0", resultingRevision: "1",
      target: { targetId, targetRevision: "1", clientAuthorityId: authorityId, workspaceId,
        rootKind: "organization", rootRecordId: rootId }, snapshot,
      actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
        admissionVersion: "2", profileVersion: "3", grantGeneration: "4", verifiedUntil: owner.verifiedUntil }, observedAt });
    await ops.batch([
      ops.prepare("INSERT INTO operations_portal_workspace_reservation_heads VALUES(?,1,?,?,'organization',?,'active')")
        .bind(targetId, authorityId, workspaceId, rootId),
      ops.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(rootId),
      ops.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(clientId),
      ops.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,?)")
        .bind(rootId, JSON.stringify({ name: "Exact Organization" })),
      ops.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,?)").bind(clientId, JSON.stringify({ name: "Exact Client" })),
      ops.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?,1)").bind(clientId, rootId),
      ops.prepare("INSERT INTO operations_directory_client_organization_history VALUES(?,1)").bind(clientId),
      ops.prepare("INSERT INTO native_staff_admissions VALUES(?,?,1,2)").bind(owner.identity.staffId, owner.identity.verifiedAccessSubject),
      ops.prepare("INSERT INTO native_staff_profiles VALUES(?,?,3)").bind(owner.identity.staffId, owner.identity.email),
      ops.prepare("INSERT INTO native_directory_grant_generations VALUES(?,4)").bind(owner.identity.staffId),
      ops.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global',NULL)").bind(owner.identity.staffId),
      ops.prepare("INSERT INTO operations_portal_workspace_effective_portal_permissions VALUES(?,'allow',?)")
        .bind(owner.identity.staffId, rootId),
      ops.prepare("INSERT INTO operations_portal_workspace_effective_permissions VALUES(?,'projects.view','allow','global',NULL)")
        .bind(owner.identity.staffId),
      ops.prepare("INSERT INTO operations_service_definitions VALUES('web','operations','Website services')"),
      ops.prepare("INSERT INTO operations_customer_service_enrollments VALUES(?,'web',1,'active')").bind(clientId),
    ]);
    await ops.batch([
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_checkpoints
        VALUES(?,?,1,2,0,0,?,?,?,?,?)`).bind(checkpointId, targetId, "c".repeat(64), "d".repeat(64), "e".repeat(64),
          observedAt, observedAt),
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_directory_sources
        VALUES(?,?,'organization',1,NULL,NULL,'Exact Organization')`).bind(checkpointId, rootId),
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_directory_sources
        VALUES(?,?,'client',1,?,1,'Exact Client')`).bind(checkpointId, clientId, rootId),
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_snapshots
        (snapshot_id,checkpoint_id,target_id,source_sequence,snapshot_sha256,snapshot_json) VALUES(?,?,?,1,?,?)`)
        .bind(snapshotId, checkpointId, targetId, sha, JSON.stringify(snapshot)),
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_commands
        (operation_id,publication_id,operation_fingerprint,canonical_publication_json,target_id,target_revision,
         client_authority_id,workspace_id,root_kind,root_record_id,expected_revision,resulting_revision,snapshot_id,
         checkpoint_id,source_sequence,snapshot_sha256,authorized_by_staff_id,authorized_access_subject,authorized_email,
         authorized_admission_version,authorized_profile_version,authorized_grant_generation,authorized_verified_until,
         reason,observed_at) VALUES(?,?,?,?,?,1,?,?, 'organization',?,0,1,?,?,1,?,?,?,?,2,3,4,?,'native authority fixture',?)`)
        .bind(publicationOperationId, publicationId, "b".repeat(64), canonicalPublication, targetId, authorityId, workspaceId,
          rootId, snapshotId, checkpointId, sha, owner.identity.staffId, owner.identity.verifiedAccessSubject,
          owner.identity.email, owner.verifiedUntil, observedAt),
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_audit
        VALUES(?,'workspace.snapshot.enqueued',?,4,?)`).bind(publicationOperationId, owner.identity.staffId, observedAt),
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_outbox(operation_id,target_id,checkpoint_id)
        VALUES(?,?,?)`).bind(publicationOperationId, targetId, checkpointId),
    ]);
    const claim = "publication-claim";
    await ops.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='dispatching',attempt_count=1,
      claim_token=?,claim_until=?,updated_at=? WHERE operation_id=?`).bind(claim, future(), observedAt, publicationOperationId).run();
    await ops.prepare(`UPDATE operations_portal_workspace_publication_outbox SET remote_attempted=1
      WHERE operation_id=?`).bind(publicationOperationId).run();
    await ops.batch([
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_receipts
        VALUES(?,?,?,?,1,1,?,?,?,?)`).bind(publicationOperationId, publicationId, "b".repeat(64), targetId,
          snapshotId, sha, claim, observedAt),
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_heads
        VALUES(?,1,1,?,?, 'organization',?,1,?,?,?,?,?)`).bind(targetId, authorityId, workspaceId, rootId,
          snapshotId, checkpointId, sha, publicationOperationId, observedAt),
    ]);
    await ops.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='acknowledged',
      acknowledged_claim_token=?,updated_at=? WHERE operation_id=?`).bind(claim, observedAt, publicationOperationId).run();
    await client.batch([
      client.prepare("CREATE TABLE operations_portal_workspace_publication_commands(operation_id TEXT PRIMARY KEY,target_id TEXT)"),
      client.prepare(`CREATE TABLE operations_portal_workspace_publication_receipts(operation_id TEXT PRIMARY KEY,
        publication_id TEXT,request_fingerprint TEXT,target_id TEXT,resulting_revision INTEGER,source_sequence INTEGER,
        snapshot_id TEXT,snapshot_sha256 TEXT)`),
      client.prepare(`CREATE TABLE operations_portal_workspace_publication_heads(target_id TEXT PRIMARY KEY,revision INTEGER,
        target_revision INTEGER,client_authority_id TEXT,workspace_id TEXT,root_kind TEXT,root_record_id TEXT,
        source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT,latest_operation_id TEXT)`),
      client.prepare(`CREATE TABLE operations_portal_workspace_publication_snapshots(snapshot_id TEXT PRIMARY KEY,
        operation_id TEXT,target_id TEXT,revision INTEGER,source_sequence INTEGER,snapshot_sha256 TEXT,snapshot_json TEXT)`),
      client.prepare(`CREATE TABLE operations_portal_workspace_publication_history(operation_id TEXT PRIMARY KEY,
        target_id TEXT,revision INTEGER,source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT)`),
    ]);
    const clientMigration = readFileSync(new URL("../../client/migrations/0224_operations_portal_native_recipient_authority.sql", import.meta.url), "utf8");
    await client.batch(splitD1MigrationStatements(clientMigration).map(statement => client.prepare(statement)));
    const clientCleanupMigration = readFileSync(new URL("../../client/migrations/0226_operations_portal_native_workspace_cleanup.sql",
      import.meta.url), "utf8");
    await client.batch(splitD1MigrationStatements(clientCleanupMigration).map(statement => client.prepare(statement)));
    await client.batch([
      client.prepare("INSERT INTO operations_portal_workspace_publication_commands VALUES(?,?)").bind(publicationOperationId, targetId),
      client.prepare("INSERT INTO operations_portal_workspace_publication_receipts VALUES(?,?,?,?,1,1,?,?)")
        .bind(publicationOperationId, publicationId, "b".repeat(64), targetId, snapshotId, sha),
      client.prepare("INSERT INTO operations_portal_workspace_publication_heads VALUES(?,1,1,?,?, 'organization',?,1,?,?,?)")
        .bind(targetId, authorityId, workspaceId, rootId, snapshotId, sha, publicationOperationId),
      client.prepare("INSERT INTO operations_portal_workspace_publication_snapshots VALUES(?,?,?,1,1,?,?)")
        .bind(snapshotId, publicationOperationId, targetId, sha, directory),
      client.prepare("INSERT INTO operations_portal_workspace_publication_history VALUES(?,?,1,1,?,?)")
        .bind(publicationOperationId, targetId, snapshotId, sha),
    ]);
  });
  afterEach(async () => runtime.dispose());

  it("issues, redeems, reviews, confirms, recovers transport, authorizes metadata, and revokes", async () => {
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, { operationId: id(10), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner });
    expect(issued.opaqueToken).toMatch(/^[0-9a-f]{64}$/u);
    const issuedPins = await ops.prepare(`SELECT token_sha256,target_relationship_version
      FROM operations_portal_native_recipient_intents WHERE intent_id=?`).bind(issued.review.intentId)
      .first<{ token_sha256: string; target_relationship_version: number }>();
    if (!issuedPins) throw new Error("expected issued intent pins");
    const forgedDeadline = future();
    const forgedCanonical = JSON.stringify({ action: "redeem", operationId: id(90), intentId: issued.review.intentId,
      request: { expectedRevision: 1, targetId, targetRevision: 1, targetClientRecordId: clientId,
        targetRelationshipVersion: issuedPins.target_relationship_version, tokenSha256: issuedPins.token_sha256,
        issuer: "https://foreign.cloudflareaccess.com", subject: "access|foreign",
        recipientLabel: "foreign@example.test", verifiedUntil: forgedDeadline }, actor: null });
    await expect(ops.batch([
      ops.prepare(`INSERT INTO operations_portal_native_recipient_operations
        (operation_id,intent_id,action,expected_revision,resulting_revision,resulting_state,request_sha256,canonical_request_json)
        VALUES(?,?,'redeem',1,2,'pending',?,?)`).bind(id(90), issued.review.intentId, "f".repeat(64), forgedCanonical),
      ops.prepare(`UPDATE operations_portal_native_recipient_intents SET state='pending',revision=2,
        access_issuer=?,access_subject=?,recipient_verified_until=? WHERE intent_id=? AND state='issued' AND revision=1`)
        .bind(issuer, subject, forgedDeadline, issued.review.intentId),
    ])).rejects.toThrow("transition denied");
    expect(await ops.prepare("SELECT 1 FROM operations_portal_native_recipient_operations WHERE operation_id=?")
      .bind(id(90)).first()).toBeNull();
    const redeemed = await redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(11),
      intentId: issued.review.intentId, opaqueToken: issued.opaqueToken!, principal: { issuer, subject },
      recipientLabel: "recipient@example.test", verifiedUntil: future(),
      acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId } });
    expect(redeemed.review).toMatchObject({ state: "pending", revision: 2, principal: { issuer, subject } });
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ state: "pending", revision: 2, recipientLabel: "recipient@example.test",
        recoveryOperationId: null });
    await expect(redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(11),
      intentId: issued.review.intentId, opaqueToken: issued.opaqueToken!, principal: { issuer, subject },
      recipientLabel: "foreign@example.test", verifiedUntil: future(),
      acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId } }))
      .rejects.toThrow("operations_portal_native_recipient_denied");
    await expect(ops.prepare(`UPDATE operations_portal_native_recipient_labels SET display_label='stale@example.test'
      WHERE intent_id=?`).bind(issued.review.intentId).run()).rejects.toThrow("immutable");
    await expect(ops.prepare(`INSERT INTO operations_portal_native_recipient_labels
      (intent_id,redeem_operation_id,access_issuer,access_subject,display_label,label_source)
      VALUES(?,?,?,?,?,'access.email')`).bind(issued.review.intentId, id(11), issuer, "access|foreign",
        "recipient@example.test").run()).rejects.toThrow("not an exact committed redemption");
    await expect(ops.prepare(`INSERT INTO operations_portal_native_recipient_labels
      (intent_id,redeem_operation_id,access_issuer,access_subject,display_label,label_source)
      VALUES(?,?,?,?,?,'access.email')`).bind(issued.review.intentId, id(11), issuer, subject,
        "stale@example.test").run()).rejects.toThrow("not an exact committed redemption");
    const confirmRequest = { operationId: id(12), intentId: issued.review.intentId, expectedRevision: 2, owner };
    const confirmed = await confirmOperationsPortalNativeRecipientIntent(ops, confirmRequest);
    expect(confirmed.review.state).toBe("confirming");
    await expect(confirmOperationsPortalNativeRecipientIntent(ops, confirmRequest))
      .resolves.toMatchObject({ replayed: true, review: { state: "confirming", revision: 3 } });
    // Apply the forward migration over populated provisioning workspace and
    // active recipient-head rows, not an empty schema, and retain FK closure.
    await applyCleanupMigration(ops);
    expect((await ops.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await materializeOperationsPortalNativeRecipientAuthority(ops, id(12));
    let simulateAmbiguousGrant = true;
    const binding = {
      applyNativeAuthority: async (wire: string) => {
        const response = await applyOperationsPortalNativeRecipientAuthority({ DELIVERY_DB: client,
          ENVIRONMENT: "staging", CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, wire);
        if (simulateAmbiguousGrant) {
          simulateAmbiguousGrant = false;
          throw new Error("simulated response loss after committed native grant");
        }
        return response;
      },
      getNativeAuthorityStatus: (wire: string) => readOperationsPortalNativeRecipientAuthorityStatus({ DELIVERY_DB: client,
        ENVIRONMENT: "staging", CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" }, wire),
    };
    const dispatchEnv = { OPS_DB: ops, OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: binding,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true" };
    await expect(dispatchOperationsPortalNativeRecipientAuthority(dispatchEnv, id(12)))
      .resolves.toMatchObject({ status: "acknowledged" });
    const active = await readOperationsPortalNativeRecipientIntent(ops, issued.review.intentId);
    expect(active).toMatchObject({ state: "active", revision: 4 });
    await expect(confirmOperationsPortalNativeRecipientIntent(ops, { ...confirmRequest,
      owner: { ...owner, verifiedUntil: future() } }))
      .resolves.toMatchObject({ replayed: true, review: { state: "active", revision: 4 } });
    const metadataRequest = { protocolVersion: 1, authorityId, workspaceId, ownershipEpoch: 1, grantRevision: 1,
      issuer, subject };
    await expect(readClientPortalServiceMetadata(ops, metadataRequest, true)).resolves.toEqual({ ok: true,
      protocolVersion: 1, services: [{ serviceId: "web", providerId: "operations", displayLabel: "Website services", revision: 1 }] });
    await expect(revokeOperationsPortalNativeWorkspaceAuthority(ops, { operationId: id(14), targetId,
      expectedOwnershipEpoch: 1, reason: "cleanup must wait for every recipient", owner }))
      .rejects.toThrow("operations_portal_native_workspace_cleanup_denied");
    // The live target and relationship can move after a grant. Cleanup is
    // authorized against the immutable workspace lineage, never the stale
    // current topology, and cannot create any new grant.
    await ops.batch([
      ops.prepare("UPDATE operations_portal_workspace_reservation_heads SET revision=2 WHERE target_id=?").bind(targetId),
      ops.prepare("UPDATE operations_directory_client_organizations SET relationship_version=2 WHERE client_record_id=?")
        .bind(clientId),
    ]);
    const revokeRequest = { operationId: id(13), intentId: issued.review.intentId, expectedRevision: 4, owner };
    const revoked = await revokeOperationsPortalNativeRecipient(ops, revokeRequest);
    expect(revoked.review.state).toBe("revoking");
    await expect(revokeOperationsPortalNativeRecipient(ops, revokeRequest))
      .resolves.toMatchObject({ replayed: true, review: { state: "revoking", revision: 5 } });
    await expect(readClientPortalServiceMetadata(ops, metadataRequest, true)).resolves.toMatchObject({ ok: false, code: "denied" });
    await materializeOperationsPortalNativeRecipientAuthority(ops, id(13));
    await expect(dispatchOperationsPortalNativeRecipientAuthority(dispatchEnv, id(13)))
      .resolves.toMatchObject({ status: "acknowledged" });
    await expect(dispatchOperationsPortalNativeRecipientAuthority(dispatchEnv, id(13)))
      .resolves.toMatchObject({ status: "acknowledged" });
    expect(await readOperationsPortalNativeRecipientIntent(ops, issued.review.intentId))
      .toMatchObject({ state: "revoked", revision: 6 });
    await expect(revokeOperationsPortalNativeRecipient(ops, revokeRequest))
      .resolves.toMatchObject({ replayed: true, review: { state: "revoked", revision: 6 } });
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ state: "revoked", revision: 6, recoveryOperationId: id(13) });
    await expect(revokeOperationsPortalNativeRecipient(ops, { ...revokeRequest,
      owner: { ...owner, verifiedUntil: future() } }))
      .resolves.toMatchObject({ replayed: true, review: { state: "revoked", revision: 6 } });
    expect(await ops.prepare(`SELECT count(*) count FROM operations_portal_native_authority_commands
      WHERE action='recipient.revoke'`).first<number>("count")).toBe(1);

    const cleanupRequest = { operationId: id(14), targetId, expectedOwnershipEpoch: 1,
      reason: "all native recipient authority is revoked", owner };
    await expect(revokeOperationsPortalNativeWorkspaceAuthority(ops, cleanupRequest))
      .resolves.toMatchObject({ state: "revoking", ownershipEpoch: 2, replayed: false });
    await expect(readOperationsPortalNativeWorkspaceCleanupForOwner(ops, targetId, owner))
      .resolves.toMatchObject({ state: "revoking", ownershipEpoch: 2, recoveryOperationId: id(14) });
    const originalWire = await ops.prepare(`SELECT canonical_wire_json FROM operations_portal_native_workspace_cleanup_commands
      WHERE operation_id=?`).bind(id(14)).first<string>("canonical_wire_json");
    expect(originalWire).toBeTypeOf("string");

    await ops.batch([
      ops.prepare("UPDATE native_staff_admissions SET version=3 WHERE staff_id=?").bind(owner.identity.staffId),
      ops.prepare("UPDATE native_staff_profiles SET version=4 WHERE staff_id=?").bind(owner.identity.staffId),
      ops.prepare("UPDATE native_directory_grant_generations SET generation=5 WHERE staff_id=?").bind(owner.identity.staffId),
    ]);
    const renewedOwner = { ...owner, admissionVersion: 3, verifiedUntil: future(),
      identity: { ...owner.identity, profileVersion: 4 } };
    await expect(revokeOperationsPortalNativeWorkspaceAuthority(ops, { ...cleanupRequest, owner: renewedOwner }))
      .resolves.toMatchObject({ state: "revoking", ownershipEpoch: 2, replayed: true });
    expect(await ops.prepare(`SELECT canonical_wire_json FROM operations_portal_native_workspace_cleanup_commands
      WHERE operation_id=?`).bind(id(14)).first<string>("canonical_wire_json")).toBe(originalWire);
    expect(await ops.prepare("SELECT count(*) count FROM operations_portal_native_workspace_cleanup_commands")
      .first<number>("count")).toBe(1);

    // Exhausting the bounded background budget cannot strand a fresh explicit
    // owner recovery. The one-use invocation rechecks current authority and
    // applies only the already frozen wire.
    await ops.prepare(`UPDATE operations_portal_native_workspace_cleanup_outbox
      SET attempts=8,state='pending',available_at=0,lease_token=NULL,lease_expires_at=NULL WHERE operation_id=?`)
      .bind(id(14)).run();
    await expect(dispatchOperationsPortalNativeRecipientAuthority(dispatchEnv, id(14)))
      .resolves.toEqual({ status: "idle" });
    await expect(reserveOperationsPortalNativeWorkspaceCleanupRecovery(ops, { invocationId: id(15),
      operationId: id(14), owner: renewedOwner }))
      .resolves.toMatchObject({ state: "authorized", replayed: false });
    let cleanupApplyCalls = 0;
    const cleanupDispatch = { ...dispatchEnv, OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
      ...binding, applyNativeAuthority: async (wire: string) => { cleanupApplyCalls += 1;
        return applyOperationsPortalNativeRecipientAuthority({ DELIVERY_DB: client,
          ENVIRONMENT: "staging", CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, wire); },
    } };
    await expect(dispatchOperationsPortalNativeRecipientAuthority(cleanupDispatch, id(14), id(15)))
      .resolves.toEqual({ status: "acknowledged", operationId: id(14) });
    expect(cleanupApplyCalls).toBe(1);
    await expect(readOperationsPortalNativeWorkspaceCleanupForOwner(ops, targetId, renewedOwner))
      .resolves.toMatchObject({ state: "revoked", ownershipEpoch: 2, recoveryOperationId: id(14) });
    expect(await ops.prepare("SELECT count(*) count FROM operations_portal_native_workspace_cleanup_invocation_audit")
      .first<number>("count")).toBe(1);
    await expect(ops.prepare("UPDATE operations_portal_workspace_reservation_heads SET state='revoked' WHERE target_id=?")
      .bind(targetId).run()).resolves.toBeDefined();
  });

  it("cancels atomically, replays exactly, rejects stale CAS, and applies deny-winning owner reads", async () => {
    await applyCleanupMigration(ops);
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, { operationId: id(20), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner });
    const request = { operationId: id(21), intentId: issued.review.intentId, expectedRevision: 1, owner };
    await expect(cancelOperationsPortalNativeRecipientIntent(ops, request))
      .resolves.toMatchObject({ replayed: false, review: { state: "cancelled", revision: 2 } });
    await expect(cancelOperationsPortalNativeRecipientIntent(ops, request))
      .resolves.toMatchObject({ replayed: true, review: { state: "cancelled", revision: 2 } });
    await expect(cancelOperationsPortalNativeRecipientIntent(ops, { ...request, operationId: id(22) }))
      .rejects.toThrow("operations_portal_native_recipient_denied");
    await ops.prepare("INSERT INTO operations_portal_workspace_effective_portal_permissions VALUES(?,'deny',?)")
      .bind(owner.identity.staffId, rootId).run();
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .rejects.toThrow("operations_portal_native_recipient_denied");
  });

  it("reuses the frozen authority wire after a later valid publication and refuses to dispatch it as current", async () => {
    await applyCleanupMigration(ops);
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, { operationId: id(40), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner });
    await redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(41), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken!, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
      verifiedUntil: future(),
      acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId } });
    await confirmOperationsPortalNativeRecipientIntent(ops, { operationId: id(42), intentId: issued.review.intentId,
      expectedRevision: 2, owner });
    const frozen = await materializeOperationsPortalNativeRecipientAuthority(ops, id(42));

    await advancePublication(ops);

    await expect(materializeOperationsPortalNativeRecipientAuthority(ops, id(42)))
      .resolves.toEqual({ operationId: id(42), requestFingerprint: frozen.requestFingerprint, replayed: true });
    let applyCalls = 0, statusCalls = 0;
    const shouldNotApply = async () => { applyCalls += 1; throw new Error("stale authority reached Client apply"); };
    const status = async (wire: string) => { statusCalls += 1; return readOperationsPortalNativeRecipientAuthorityStatus({
      DELIVERY_DB: client, ENVIRONMENT: "staging", CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" }, wire); };
    await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: ops,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { applyNativeAuthority: shouldNotApply,
        getNativeAuthorityStatus: status } }, id(42)))
      .resolves.toEqual({ status: "retry", operationId: id(42), code: "authorization-stale" });
    expect({ applyCalls, statusCalls }).toEqual({ applyCalls: 0, statusCalls: 1 });
  });

  it("status-reconciles an exact remote grant after publication drift without applying stale authority again", async () => {
    await applyCleanupMigration(ops);
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, { operationId: id(60), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner });
    await redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(61), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken!, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
      verifiedUntil: future(),
      acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId } });
    await confirmOperationsPortalNativeRecipientIntent(ops, { operationId: id(62), intentId: issued.review.intentId,
      expectedRevision: 2, owner });
    const frozen = await materializeOperationsPortalNativeRecipientAuthority(ops, id(62));
    const wire = await ops.prepare(`SELECT canonical_wire_json FROM operations_portal_native_authority_outbox
      WHERE operation_id=?`).bind(id(62)).first<string>("canonical_wire_json");
    expect(wire).toBeTypeOf("string");
    await expect(ops.prepare(`UPDATE operations_portal_native_authority_outbox SET canonical_wire_json='{}'
      WHERE operation_id=?`).bind(id(62)).run()).rejects.toThrow("operations portal native authority wire is immutable");
    const lostResponse = await applyOperationsPortalNativeRecipientAuthority({ DELIVERY_DB: client, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, wire!);
    expect(JSON.parse(lostResponse)).toMatchObject({ ok: true, status: "recorded", operationId: id(62) });
    await advancePublication(ops);
    await expect(materializeOperationsPortalNativeRecipientAuthority(ops, id(62)))
      .resolves.toEqual({ operationId: id(62), requestFingerprint: frozen.requestFingerprint, replayed: true });
    let applyCalls = 0, statusCalls = 0;
    const shouldNotApply = async () => { applyCalls += 1; throw new Error("stale authority reached Client apply"); };
    const status = async (request: string) => { statusCalls += 1; return readOperationsPortalNativeRecipientAuthorityStatus({
      DELIVERY_DB: client, ENVIRONMENT: "staging", CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" }, request); };
    await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: ops,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { applyNativeAuthority: shouldNotApply,
        getNativeAuthorityStatus: status } }, id(62)))
      .resolves.toEqual({ status: "acknowledged", operationId: id(62) });
    expect({ applyCalls, statusCalls }).toEqual({ applyCalls: 0, statusCalls: 1 });
    await expect(readOperationsPortalNativeRecipientIntent(ops, issued.review.intentId))
      .resolves.toMatchObject({ state: "active", revision: 4 });
  });
});
