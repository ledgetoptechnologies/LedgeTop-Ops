import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const nativeOwnerAuth = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: nativeOwnerAuth.authenticate }));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { publishOperationsPortalWorkspaceRpc } from "../../client/src/worker/operations-portal-workspace-publication-entrypoint";
import { sha256OperationsPortalWorkspacePublication, sha256OperationsPortalWorkspaceSnapshot }
  from "../../../packages/shared/src/operations-portal-workspace-publication";
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
import { canonicalOperationsPortalNativeInquiryCapabilityCommandV4 }
  from "../../../packages/shared/src/operations-portal-native-recipient-capabilities-v4";
import { prepareOperationsNativeInquiryCapability, dispatchOperationsNativeInquiryCapability }
  from "../src/worker/operations-portal-native-inquiry-capability-dispatch";
import { applyOperationsPortalNativeInquiryCapability, closeOperationsPortalNativeInquiryCapability,
  readOperationsPortalNativeInquiryCapabilityStatus } from "../../client/src/worker/operations-portal-native-inquiry-capability";
import { readNativeOperationsRequestCapabilities } from "../../client/src/worker/client-portal/operations-native-request-capability-read";
import { ensureOperationsNativeRecipientInquiryCapability, operationsNativeInquiryCapabilityOperationId }
  from "../src/worker/operations-portal-native-recipient-inquiry-owner";
import { listOpsPrincipalInquiries, submitOpsPrincipalInquiry } from "../src/worker/operations-native-principal-inquiries";
import { handleOperationsNativeRecipientOwnerHttp } from "../src/worker/operations-portal-native-recipient-owner-http";

const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const targetId = id(1), authorityId = id(2), publicationOperationId = id(3), publicationId = id(4), snapshotId = id(5),
  checkpointId = id(6);
const rootId = id(20), clientId = id(21), workspaceId = "workspace-one";
const issuer = "https://team.cloudflareaccess.com", subject = "access|recipient";
let sha = "a".repeat(64);
let publicationFingerprint = "b".repeat(64);
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const owner = { identity: { kind: "native" as const, staffId: "staff:owner", verifiedAccessSubject: "access|owner",
  email: "owner@example.test", displayName: "Owner", profileVersion: 3 }, admissionVersion: 2, verifiedUntil: future() };

async function publishClientPublicationSuccessor(client: D1Database) {
  const nextSnapshot = { snapshotId: id(52), checkpointId: id(53), sourceSequence: "2", complete: true,
    counts: { directoryRecords: 2, projects: 0, folderReservations: 0, recipientAuthorityHeads: 0,
      deliveryAuthorityHeads: 0 }, directoryRecords: [
      { recordId: rootId, kind: "organization", version: "1", parentRecordId: null, relationshipVersion: null,
        displayName: "Exact Organization", externalFences: [] },
      { recordId: clientId, kind: "client", version: "1", parentRecordId: rootId, relationshipVersion: "1",
        displayName: "Exact Client", externalFences: [] },
    ], projects: [], folderReservations: [], recipientAuthorityHeads: [], deliveryAuthorityHeads: [], snapshotSha256: "a".repeat(64) };
  const publication = { protocol: "operations-portal-workspace-publication", protocolVersion: 1, action: "publish",
    publicationId: id(51), operationId: id(50), expectedRevision: "1", resultingRevision: "2",
    target: { targetId, targetRevision: "1", clientAuthorityId: authorityId, workspaceId,
      rootKind: "organization", rootRecordId: rootId }, snapshot: nextSnapshot,
    actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
      admissionVersion: "2", profileVersion: "3", grantGeneration: "4", verifiedUntil: owner.verifiedUntil },
    observedAt: new Date().toISOString() };
  nextSnapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(publication);
  const result = await publishOperationsPortalWorkspaceRpc({ DELIVERY_DB: client,
    CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true", ENVIRONMENT: "staging",
    EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" }, publication);
  expect(result).toMatchObject({ ok: true, receipt: { operationId: id(50), resultingRevision: "2" } });
}

async function applyCleanupMigration(database: D1Database) {
  // 0234 is an application successor after the recipient v2 rewrite. Reapply
  // the migration on this fixture after resetting its empty test-only tables.
  for (const table of ["closures", "history", "outbox", "heads", "receipts", "commands"]) {
    await database.prepare(`DROP TABLE IF EXISTS operations_portal_native_inquiry_capability_${table}`).run();
  }
  const migration = readFileSync(new URL("../migrations/0157_operations_portal_native_workspace_cleanup.sql",
    import.meta.url), "utf8");
  await database.batch(splitD1MigrationStatements(migration).map(statement => database.prepare(statement)));
  // 0160 is ordered after 0157 in release. Refresh its narrowed replacement
  // triggers here because this fixture deliberately applies 0157 over a
  // populated 0154/0160 recipient workflow.
  const labels = readFileSync(new URL("../migrations/0160_operations_portal_native_recipient_labels.sql",
    import.meta.url), "utf8");
  await database.batch(splitD1MigrationStatements(labels).map(statement => database.prepare(statement)));
  const inquiryCapabilityMigration = readFileSync(new URL("../migrations/0234_operations_portal_native_inquiry_capability.sql",
    import.meta.url), "utf8");
  await database.batch(splitD1MigrationStatements(inquiryCapabilityMigration).map(statement => database.prepare(statement)));
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
      ops.prepare(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,display_name TEXT,access_subject TEXT,status TEXT)`),
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
    const capabilityIntentMigration = readFileSync(new URL("../migrations/0233_operations_portal_native_recipient_capability_intents.sql",
      import.meta.url), "utf8");
    await ops.batch(splitD1MigrationStatements(capabilityIntentMigration).map(statement => ops.prepare(statement)));
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
    const publicationDocument = { protocol: "operations-portal-workspace-publication", protocolVersion: 1,
      action: "publish", publicationId, operationId: publicationOperationId, expectedRevision: "0", resultingRevision: "1",
      target: { targetId, targetRevision: "1", clientAuthorityId: authorityId, workspaceId,
        rootKind: "organization", rootRecordId: rootId }, snapshot,
      actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
        admissionVersion: "2", profileVersion: "3", grantGeneration: "4", verifiedUntil: owner.verifiedUntil }, observedAt };
    sha = await sha256OperationsPortalWorkspaceSnapshot(publicationDocument);
    snapshot.snapshotSha256 = sha;
    publicationFingerprint = await sha256OperationsPortalWorkspacePublication(publicationDocument);
    const canonicalPublication = JSON.stringify(publicationDocument);
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
        .bind(publicationOperationId, publicationId, publicationFingerprint, canonicalPublication, targetId, authorityId, workspaceId,
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
        VALUES(?,?,?,?,1,1,?,?,?,?)`).bind(publicationOperationId, publicationId, publicationFingerprint, targetId,
          snapshotId, sha, claim, observedAt),
      ops.prepare(`INSERT INTO operations_portal_workspace_publication_heads
        VALUES(?,1,1,?,?, 'organization',?,1,?,?,?,?,?)`).bind(targetId, authorityId, workspaceId, rootId,
          snapshotId, checkpointId, sha, publicationOperationId, observedAt),
    ]);
    await ops.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='acknowledged',
      acknowledged_claim_token=?,updated_at=? WHERE operation_id=?`).bind(claim, observedAt, publicationOperationId).run();
    const clientPublicationMigration = readFileSync(new URL("../../client/migrations/0223_operations_portal_workspace_publications.sql",
      import.meta.url), "utf8");
    await client.batch(splitD1MigrationStatements(clientPublicationMigration).map(statement => client.prepare(statement)));
    const clientPublication = await publishOperationsPortalWorkspaceRpc({ DELIVERY_DB: client,
      CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true", ENVIRONMENT: "staging",
      EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" }, JSON.parse(canonicalPublication));
    expect(clientPublication, JSON.stringify(clientPublication)).toMatchObject({ ok: true, receipt: { operationId: publicationOperationId,
      targetId, resultingRevision: "1", sourceSequence: "1", snapshotId, snapshotSha256: sha } });
    const clientMigration = readFileSync(new URL("../../client/migrations/0224_operations_portal_native_recipient_authority.sql", import.meta.url), "utf8");
    await client.batch(splitD1MigrationStatements(clientMigration).map(statement => client.prepare(statement)));
    const clientCleanupMigration = readFileSync(new URL("../../client/migrations/0226_operations_portal_native_workspace_cleanup.sql",
      import.meta.url), "utf8");
    await client.batch(splitD1MigrationStatements(clientCleanupMigration).map(statement => client.prepare(statement)));
    const clientInquiryCapabilityMigration = readFileSync(new URL("../../client/migrations/0243_operations_portal_native_inquiry_capability.sql",
      import.meta.url), "utf8");
    await client.batch(splitD1MigrationStatements(clientInquiryCapabilityMigration).map(statement => client.prepare(statement)));
    expect((await client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  afterEach(async () => runtime.dispose());

  it("reports the current home-only v3 grant in owner review without requiring v4 companion tables", async () => {
    await applyCleanupMigration(ops);
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, {
      operationId: id(251), targetId, targetClientRecordId: clientId, expiresAt: future(), owner,
    });
    expect(issued.review.permissionSchemaVersion).toBe(3);
    await redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(252), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken!, principal: { issuer, subject }, recipientLabel: "legacy-v3@example.test",
      verifiedUntil: future(), acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId } });
    await confirmOperationsPortalNativeRecipientIntent(ops, { operationId: id(253), intentId: issued.review.intentId,
      expectedRevision: 2, owner });
    const clientEnv = { DELIVERY_DB:client, ENVIRONMENT:"staging", EXPECTED_HOST:"client-staging.example.test",
      CLIENT_PORTAL_ORIGIN:"https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST:"client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED:"true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED:"true" };
    await materializeOperationsPortalNativeRecipientAuthority(ops, id(253));
    const dispatched = await dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB:ops,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED:"true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY:{
        applyNativeAuthority:(wire:string) => applyOperationsPortalNativeRecipientAuthority(clientEnv, wire),
        getNativeAuthorityStatus:(wire:string) => readOperationsPortalNativeRecipientAuthorityStatus(clientEnv, wire),
      } }, id(253));
    expect(dispatched).toMatchObject({ status:"acknowledged", operationId:id(253) });
    const durable = await ops.prepare(`SELECT intent.state,intent.permission_schema_version,intent.expires_at,
        intent.recipient_verified_until,head.recipient_binding_id binding_id,head.latest_operation_id grant_operation_id,
        head.state head_state,head.permission_schema_version head_schema,head.grant_revision,head.expires_at base_expires_at,receipt.resulting_state,
        workspace.state workspace_state,workspace.ownership_epoch workspace_epoch,binding.status binding_status,
        binding.access_issuer,binding.access_subject,binding.expires_at binding_expires_at
      FROM operations_portal_native_recipient_intents intent
      JOIN operations_portal_native_recipient_authority_heads head ON head.enrollment_intent_id=intent.intent_id
      JOIN operations_portal_native_authority_receipts receipt ON receipt.operation_id=head.latest_operation_id
      JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=head.target_id
      JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=head.recipient_binding_id
      WHERE intent.intent_id=?`).bind(issued.review.intentId).first<Record<string, unknown>>();
    expect(durable).toMatchObject({ state:"active", permission_schema_version:3, head_state:"active", head_schema:3,
      resulting_state:"active", workspace_state:"active", binding_status:"active", access_issuer:issuer, access_subject:subject });
    expect(Date.parse(String(durable?.expires_at))).toBeGreaterThan(Date.now());

    for (const table of ["closures","history","outbox","heads","receipts","commands"])
      await ops.prepare(`DROP TABLE operations_portal_native_inquiry_capability_${table}`).run();
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ permissionSchemaVersion:3, state:"active", capabilityStatus:"not_requested",
        effectivePermissions:["operations.service_home.read"] });

    const deniedReview = () => expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ permissionSchemaVersion:3, capabilityStatus:"not_requested", effectivePermissions:[] });
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await ops.prepare("UPDATE client_onboarding_recipient_identity_bindings SET expires_at=? WHERE binding_id=?")
      .bind(expiredAt, durable?.binding_id).run();
    await deniedReview();
    await ops.prepare("UPDATE client_onboarding_recipient_identity_bindings SET expires_at=NULL WHERE binding_id=?")
      .bind(durable?.binding_id).run();

    await ops.prepare("DROP TRIGGER operations_portal_native_receipts_no_update").run();
    await ops.prepare("UPDATE operations_portal_native_authority_receipts SET resulting_state='revoked' WHERE operation_id=?")
      .bind(durable?.grant_operation_id).run();
    await deniedReview();
    await ops.prepare("UPDATE operations_portal_native_authority_receipts SET resulting_state='active' WHERE operation_id=?")
      .bind(durable?.grant_operation_id).run();

    await ops.prepare("DROP TRIGGER operations_portal_native_recipient_head_update_guard").run();
    await ops.prepare("UPDATE operations_portal_native_recipient_authority_heads SET expires_at=? WHERE recipient_binding_id=?")
      .bind(expiredAt, durable?.binding_id).run();
    await deniedReview();
    await ops.prepare("UPDATE operations_portal_native_recipient_authority_heads SET expires_at=NULL WHERE recipient_binding_id=?")
      .bind(durable?.binding_id).run();
    await ops.prepare("UPDATE operations_portal_native_recipient_authority_heads SET grant_revision=grant_revision+1 WHERE recipient_binding_id=?")
      .bind(durable?.binding_id).run();
    await deniedReview();
    await ops.prepare("UPDATE operations_portal_native_recipient_authority_heads SET grant_revision=? WHERE recipient_binding_id=?")
      .bind(durable?.grant_revision, durable?.binding_id).run();

    await ops.prepare("DROP TRIGGER operations_portal_native_workspace_finalize_guard").run();
    await ops.prepare("UPDATE operations_portal_native_workspace_authority_heads SET ownership_epoch=? WHERE target_id=?")
      .bind(Number(durable?.workspace_epoch) + 1, targetId).run();
    await deniedReview();
    await ops.prepare("UPDATE operations_portal_native_workspace_authority_heads SET ownership_epoch=? WHERE target_id=?")
      .bind(durable?.workspace_epoch, targetId).run();

    await ops.prepare("DROP TRIGGER operations_portal_native_recipient_transition_guard").run();
    await ops.prepare("UPDATE operations_portal_native_recipient_intents SET expires_at=?,recipient_verified_until=? WHERE intent_id=?")
      .bind(expiredAt, expiredAt, issued.review.intentId).run();
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ permissionSchemaVersion:3, state:"active", capabilityStatus:"not_requested",
        effectivePermissions:["operations.service_home.read"] });
  });

  it("pins an explicit request-create selection in the immutable issue review without changing the v3 home grant", async () => {
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, { operationId: id(70), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner, legacyShape: false, permissionSchemaVersion: 4,
      permissions: ["operations.request.create", "operations.service_home.read"] });
    expect(issued.review).toMatchObject({ permissionSchemaVersion: 4,
      permissions: ["operations.request.create", "operations.service_home.read"] });
    const pinned = await ops.prepare(`SELECT permission_schema_version,requested_permissions_json
      FROM operations_portal_native_recipient_intents WHERE intent_id=?`).bind(issued.review.intentId)
      .first<{ permission_schema_version: number; requested_permissions_json: string }>();
    expect(pinned).toEqual({ permission_schema_version: 4,
      requested_permissions_json: '["operations.request.create","operations.service_home.read"]' });
    const issue = await ops.prepare(`SELECT canonical_request_json FROM operations_portal_native_recipient_operations
      WHERE operation_id=? AND action='issue'`).bind(id(70)).first<{ canonical_request_json: string }>();
    expect(JSON.parse(issue!.canonical_request_json).request).toMatchObject({ permissionSchemaVersion: 4,
      permissions: ["operations.request.create", "operations.service_home.read"] });
    await expect(ops.prepare(`UPDATE operations_portal_native_recipient_intents
      SET requested_permissions_json='["operations.service_home.read"]' WHERE intent_id=?`)
      .bind(issued.review.intentId).run()).rejects.toThrow();
    expect((await ops.prepare(`SELECT requested_permissions_json FROM operations_portal_native_recipient_intents WHERE intent_id=?`)
      .bind(issued.review.intentId).first<{ requested_permissions_json: string }>())?.requested_permissions_json)
      .toBe('["operations.request.create","operations.service_home.read"]');
  });

  it("requires recipient acknowledgement of the exact v4 capability set before redeem", async () => {
    const permissions = ["operations.request.create", "operations.service_home.read"] as const;
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, { operationId: id(71), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner, legacyShape: false,
      permissionSchemaVersion: 4, permissions });
    const redeem = { operationId: id(72), intentId: issued.review.intentId, opaqueToken: issued.opaqueToken!,
      principal: { issuer, subject }, recipientLabel: "recipient@example.test", verifiedUntil: future(),
      acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId } };
    await expect(redeemOperationsPortalNativeRecipientIntent(ops, redeem))
      .rejects.toThrow("operations_portal_native_recipient_denied");
    expect(await ops.prepare("SELECT state FROM operations_portal_native_recipient_intents WHERE intent_id=?")
      .bind(issued.review.intentId).first("state")).toBe("issued");
    await expect(redeemOperationsPortalNativeRecipientIntent(ops, { ...redeem,
      acknowledgedPermissions: ["operations.service_home.read", "operations.request.create"] as never,
      acknowledgedPermissionSchemaVersion: 4 }))
      .rejects.toThrow("operations_portal_native_recipient_denied");
    const redeemed = await redeemOperationsPortalNativeRecipientIntent(ops, { ...redeem,
      acknowledgedPermissions: permissions, acknowledgedPermissionSchemaVersion: 4 });
    expect(redeemed.review).toMatchObject({ state: "pending", permissionSchemaVersion: 4, permissions });
  });

  it("closes the explicit request.create companion only after both D1 receipts and hides it on publication drift", async () => {
    const permissions = ["operations.request.create", "operations.service_home.read"] as const;
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, { operationId: id(70), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner, legacyShape: false,
      permissionSchemaVersion: 4, permissions });
    await redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(71), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken!, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
      verifiedUntil: future(), acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId },
      acknowledgedPermissions: permissions, acknowledgedPermissionSchemaVersion: 4 });
    await confirmOperationsPortalNativeRecipientIntent(ops, { operationId: id(72), intentId: issued.review.intentId,
      expectedRevision: 2, owner });
    await applyCleanupMigration(ops);
    await materializeOperationsPortalNativeRecipientAuthority(ops, id(72));
    const clientEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED: "true" };
    let loseApplyResponse = true, holdFirstClosure = true, loseClosureResponse = true;
    const binding = {
      applyNativeAuthority: (wire: string) => applyOperationsPortalNativeRecipientAuthority({ ...clientEnv,
        CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, wire),
      getNativeAuthorityStatus: (wire: string) => readOperationsPortalNativeRecipientAuthorityStatus(clientEnv, wire),
      applyNativeInquiryCapability: async (wire: string) => {
        const result = await applyOperationsPortalNativeInquiryCapability(clientEnv, wire);
        if (loseApplyResponse && JSON.parse(result).ok === true) {
          loseApplyResponse = false; throw new Error("simulated Client apply response loss");
        }
        return result;
      },
      closeNativeInquiryCapability: async (wire: string) => {
        if (holdFirstClosure) { holdFirstClosure = false;
          return JSON.stringify({ ok: false, protocolVersion: 1, code: "temporary_failure", retryable: true }); }
        const result = await closeOperationsPortalNativeInquiryCapability(clientEnv, wire);
        if (loseClosureResponse) { loseClosureResponse = false; throw new Error("simulated Client closure response loss"); }
        return result;
      },
      getNativeInquiryCapabilityStatus: (wire: string) => readOperationsPortalNativeInquiryCapabilityStatus(clientEnv, wire),
    };
    const dispatchEnv = { OPS_DB: ops, OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: binding,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true" };
    await expect(dispatchOperationsPortalNativeRecipientAuthority(dispatchEnv, id(72)))
      .resolves.toMatchObject({ status: "acknowledged" });
    const pins = await ops.prepare(`SELECT intent.expires_at,intent.grant_operation_id,intent.target_client_record_id,
        intent.access_issuer,intent.access_subject,recipient.recipient_binding_id,recipient.ownership_epoch,
        recipient.grant_revision,workspace.target_revision,workspace.client_authority_id,workspace.workspace_id,
        publication.latest_operation_id publication_operation_id,publication.publication_revision,
        publication.source_sequence,publication.snapshot_id,publication.snapshot_sha256
      FROM operations_portal_native_recipient_intents intent
      JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.enrollment_intent_id=intent.intent_id
      JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=intent.target_id
      JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
      WHERE intent.intent_id=?`).bind(issued.review.intentId).first<Record<string, string | number>>();
    if (!pins) throw new Error("expected current v3 and publication pins");
    const makeCommand = (operationId: string, action: "grant" | "revoke") => canonicalOperationsPortalNativeInquiryCapabilityCommandV4({
      protocol: "operations-portal-native-inquiry-capability", protocolVersion: 1, permissionSchemaVersion: 4,
      action, operationId, target: { targetId, targetRevision: String(pins.target_revision),
        clientAuthorityId: pins.client_authority_id, workspaceId: pins.workspace_id, targetClientRecordId: pins.target_client_record_id },
      recipient: { recipientBindingId: pins.recipient_binding_id, enrollmentIntentId: issued.review.intentId,
        issuer: pins.access_issuer, subject: pins.access_subject },
      baseAuthority: { operationId: pins.grant_operation_id, ownershipEpoch: String(pins.ownership_epoch),
        grantRevision: String(pins.grant_revision) },
      publication: { operationId: pins.publication_operation_id, revision: String(pins.publication_revision),
        sourceSequence: String(pins.source_sequence), snapshotId: pins.snapshot_id, snapshotSha256: pins.snapshot_sha256 },
      transition: action === "grant" ? { expectedRevision: "0", resultingRevision: "1" }
        : { expectedRevision: "1", resultingRevision: "2" }, permission: "operations.request.create",
      expiresAt: pins.expires_at, actorProof: { staffId: owner.identity.staffId,
        verifiedAccessSubject: owner.identity.verifiedAccessSubject, admissionVersion: String(owner.admissionVersion),
        profileVersion: String(owner.identity.profileVersion), grantGeneration: "4", verifiedUntil: future() },
      observedAt: new Date().toISOString(),
    });
    const grantWire = makeCommand(id(73), "grant");
    const preparedGrant = await prepareOperationsNativeInquiryCapability({ ...dispatchEnv,
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true" }, grantWire);
    if (!preparedGrant.ok) throw new Error(`companion-prepare-${preparedGrant.code}`);
    expect(preparedGrant).toMatchObject({ ok: true, action: "grant", state: "prepared", replayed: false });
    await expect(prepareOperationsNativeInquiryCapability({ ...dispatchEnv,
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true" }, grantWire))
      .resolves.toMatchObject({ ok: true, state: "pending", replayed: true });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    const partialGrant = await dispatchOperationsNativeInquiryCapability({ ...dispatchEnv,
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true" }, id(73));
    expect(partialGrant).toMatchObject({ ok: false, code: "client_closure_pending", retryable: true });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    const grantDelivered = await dispatchOperationsNativeInquiryCapability({ ...dispatchEnv,
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true" }, id(73));
    if (!grantDelivered.ok) throw new Error(`companion-dispatch-${grantDelivered.code}`);
    expect(grantDelivered).toMatchObject({ ok: true, action: "grant", state: "active", replayed: false });
    await expect(dispatchOperationsNativeInquiryCapability({ ...dispatchEnv,
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true" }, id(73)))
      .resolves.toMatchObject({ ok: true, action: "grant", state: "active", replayed: true });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true))
      .resolves.toMatchObject([{ targetId, baseOperationId: pins.grant_operation_id, capabilityOperationId: id(73) }]);
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ capabilityStatus:"active", effectivePermissions:permissions });
    const recipientBindingId = await ops.prepare(`SELECT recipient_binding_id FROM operations_portal_native_recipient_intents
      WHERE intent_id=?`).bind(issued.review.intentId).first<string>("recipient_binding_id");
    const expiredBinding = new Date(Date.now() - 60_000).toISOString();
    await ops.prepare("UPDATE client_onboarding_recipient_identity_bindings SET expires_at=? WHERE binding_id=?")
      .bind(expiredBinding, recipientBindingId).run();
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ effectivePermissions:[] });
    await ops.prepare("UPDATE client_onboarding_recipient_identity_bindings SET expires_at=NULL WHERE binding_id=?")
      .bind(recipientBindingId).run();
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ capabilityStatus:"active", effectivePermissions:permissions });

    const headUpdateGuard = await ops.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger'
      AND name='operations_portal_native_recipient_head_update_guard'`).first<string>("sql");
    expect(headUpdateGuard).toBeTypeOf("string");
    await ops.prepare("DROP TRIGGER operations_portal_native_recipient_head_update_guard").run();
    await ops.prepare("UPDATE operations_portal_native_recipient_authority_heads SET expires_at=? WHERE recipient_binding_id=?")
      .bind(expiredBinding, recipientBindingId).run();
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ effectivePermissions:[] });
    await ops.prepare("UPDATE operations_portal_native_recipient_authority_heads SET expires_at=NULL WHERE recipient_binding_id=?")
      .bind(recipientBindingId).run();
    await ops.prepare(headUpdateGuard!).run();
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ capabilityStatus:"active", effectivePermissions:permissions });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer: "https://foreign.cloudflareaccess.com",
      subject: "access|other" }, true)).resolves.toEqual([]);
    await publishClientPublicationSuccessor(client);
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    await revokeOperationsPortalNativeRecipient(ops, { operationId: id(75), intentId: issued.review.intentId,
      expectedRevision: 4, owner });
    const revokeWire = makeCommand(id(74), "revoke");
    const preparedRevoke = await prepareOperationsNativeInquiryCapability({ ...dispatchEnv,
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "false" }, revokeWire);
    if (!preparedRevoke.ok) throw new Error(`companion-revoke-prepare-${preparedRevoke.code}`);
    expect(preparedRevoke).toMatchObject({ ok: true, action: "revoke", state: "prepared" });
    await expect(dispatchOperationsNativeInquiryCapability({ ...dispatchEnv,
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "false" }, id(74)))
      .resolves.toMatchObject({ ok: true, action: "revoke", state: "revoked" });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    expect(await ops.prepare(`SELECT count(*) count FROM operations_portal_native_inquiry_capability_closures
      WHERE operation_id=? AND resulting_state='active'`).bind(id(73)).first<number>("count")).toBe(1);
    expect(await ops.prepare(`SELECT state FROM operations_portal_native_inquiry_capability_heads WHERE intent_id=?`)
      .bind(issued.review.intentId).first<string>("state")).toBe("revoked");
    expect((await ops.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("runs the reviewed v4 owner path through both receipts, inquiry submit/idempotency, and full revoke", async () => {
    nativeOwnerAuth.authenticate.mockResolvedValue(owner);
    const permissions = ["operations.request.create", "operations.service_home.read"] as const;
    const ownerOrigin = "https://ops-staging.example.test";
    const ownerPath = "/api/native-client-portal/operations-recipient-enrollment";
    const clientEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED: "true" };
    let failFirstCapabilityClosure = true, failFirstCapabilityRevoke = true;
    const ownerEnv = { OPS_DB: ops, OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true", OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
        applyNativeAuthority: (wire: string) => applyOperationsPortalNativeRecipientAuthority(clientEnv, wire),
        getNativeAuthorityStatus: (wire: string) => readOperationsPortalNativeRecipientAuthorityStatus(clientEnv, wire),
        applyNativeInquiryCapability: (wire: string) => {
          const command = JSON.parse(wire) as { action?: string };
          if (command.action === "revoke" && failFirstCapabilityRevoke) {
            failFirstCapabilityRevoke = false;
            return JSON.stringify({ ok: false, protocolVersion: 1, code: "temporary_failure", retryable: true });
          }
          return applyOperationsPortalNativeInquiryCapability(clientEnv, wire);
        },
        closeNativeInquiryCapability: (wire: string) => {
          if (failFirstCapabilityClosure) {
            failFirstCapabilityClosure = false;
            return JSON.stringify({ ok: false, protocolVersion: 1, code: "temporary_failure", retryable: true });
          }
          return closeOperationsPortalNativeInquiryCapability(clientEnv, wire);
        },
        getNativeInquiryCapabilityStatus: (wire: string) => readOperationsPortalNativeInquiryCapabilityStatus(clientEnv, wire),
      } },
      ownerDependencies = { environment: "staging", expectedHost: "ops-staging.example.test", database: ops,
        dispatch: ownerEnv, configuration: { enabled: true, issuer: "https://team.cloudflareaccess.com",
          staffAudience: "a".repeat(16), origin: ownerOrigin, recipientOrigin: "https://client-staging.example.test",
          csrfSecret: "native-owner-test-csrf-secret-long-enough" } };
    const ownerRequest = (path: string, method: "GET" | "POST", csrfToken?: string, body?: unknown) => new Request(
      `${ownerOrigin}${ownerPath}/${path}`, { method, headers: { Origin: ownerOrigin, "Sec-Fetch-Site": "same-origin",
        "X-Native-Staff-Request": "1", ...(method === "POST" ? { "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken ?? "" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const session = await handleOperationsNativeRecipientOwnerHttp(ownerRequest("session", "GET"), ownerDependencies);
    expect(session.status).toBe(200);
    const csrfToken = (await session.json() as { csrfToken: string }).csrfToken;
    const issueResponse = await handleOperationsNativeRecipientOwnerHttp(ownerRequest("intents", "POST", csrfToken, {
      operationId: id(170), targetId, targetClientRecordId: clientId, expiresAt: future(), permissions,
    }), ownerDependencies);
    expect(issueResponse.status).toBe(201);
    const issued = await issueResponse.json() as { review: { intentId: string }; opaqueToken: string };
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ permissionSchemaVersion: 4, capabilityStatus: "pending", effectivePermissions: [] });
    const inspected = await handleOperationsNativeRecipientOwnerHttp(ownerRequest(`intents/${issued.review.intentId}`, "GET"), ownerDependencies);
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ intent: { permissionSchemaVersion: 4, permissions } });
    await redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(171), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
      verifiedUntil: future(), acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId },
      acknowledgedPermissions: permissions, acknowledgedPermissionSchemaVersion: 4 });
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ state: "pending", permissionSchemaVersion: 4, permissions,
        capabilityStatus: "pending", effectivePermissions: [] });
    await applyCleanupMigration(ops);
    const confirmResponse = await handleOperationsNativeRecipientOwnerHttp(ownerRequest(`intents/${issued.review.intentId}/confirm`, "POST",
      csrfToken, { operationId: id(172), expectedRevision: 2 }), ownerDependencies);
    expect(confirmResponse.status, JSON.stringify(await confirmResponse.clone().json())).toBe(202);
    expect(await confirmResponse.json()).toMatchObject({ status: "pending", intent: { permissionSchemaVersion: 4,
      capabilityStatus: "pending", effectivePermissions: ["operations.service_home.read"] } });
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ capabilityStatus: "pending", effectivePermissions: ["operations.service_home.read"] });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    const recovery = await handleOperationsNativeRecipientOwnerHttp(ownerRequest(`intents/${issued.review.intentId}/recover`, "POST",
      csrfToken, { operationId: id(172), expectedRevision: 4 }), ownerDependencies);
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({ status: "acknowledged", intent: { capabilityStatus: "active",
      effectivePermissions: permissions } });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toHaveLength(1);

    const enrollmentProof = await ops.prepare(`SELECT recipient_verified_until FROM operations_portal_native_recipient_intents
      WHERE intent_id=?`).bind(issued.review.intentId).first<{ recipient_verified_until: string }>();
    expect(enrollmentProof?.recipient_verified_until).toBeTruthy();
    const transitionGuard = await ops.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger'
      AND name='operations_portal_native_recipient_transition_guard'`).first<{ sql: string }>();
    expect(transitionGuard?.sql).toBeTruthy();
    await ops.prepare("DROP TRIGGER operations_portal_native_recipient_transition_guard").run();
    try {
      await ops.prepare(`UPDATE operations_portal_native_recipient_intents SET recipient_verified_until=? WHERE intent_id=?`)
        .bind(new Date(Date.now() - 60_000).toISOString(), issued.review.intentId).run();
      await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
        .resolves.toMatchObject({ capabilityStatus: "active", effectivePermissions: permissions });
      await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toHaveLength(1);
      await ops.prepare(`UPDATE operations_portal_native_recipient_intents SET recipient_verified_until=? WHERE intent_id=?`)
        .bind(enrollmentProof!.recipient_verified_until, issued.review.intentId).run();
    } finally {
      await ops.prepare(transitionGuard!.sql).run();
    }

    const opsInquiryMigration = readFileSync(new URL("../migrations/0235_ops_principal_inquiries.sql", import.meta.url), "utf8");
    await ops.batch(splitD1MigrationStatements(opsInquiryMigration).map(statement => ops.prepare(statement)));
    const inquiriesEnv = { OPS_DB: ops, CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED: "true" } as never;
    const capabilityProofs = await readNativeOperationsRequestCapabilities(client, { issuer, subject }, true);
    const listRequest = JSON.stringify({ protocolVersion: 1, proofs: capabilityProofs });
    expect(JSON.parse(await listOpsPrincipalInquiries(inquiriesEnv, listRequest))).toMatchObject({ ok: true, inquiries: [] });
    const inquiryInput = { kind: "website", title: "Website request", details: "Please contact us about website work.",
      location: null, idempotencyKey: "v4-owner-flow-idempotency-1" };
    const submitRequest = JSON.stringify({ protocolVersion: 1, proofs: capabilityProofs, input: inquiryInput });
    const created = JSON.parse(await submitOpsPrincipalInquiry(inquiriesEnv, submitRequest));
    expect(created).toMatchObject({ ok: true, replayed: false, inquiry: { kind: "website", title: "Website request" } });
    expect(JSON.parse(await submitOpsPrincipalInquiry(inquiriesEnv, submitRequest)))
      .toMatchObject({ ok: true, replayed: true, inquiry: { id: created.inquiry.id } });
    expect(JSON.parse(await listOpsPrincipalInquiries(inquiriesEnv, listRequest))).toMatchObject({
      ok: true, inquiries: [{ id: created.inquiry.id, title: "Website request" }] });
    expect(await ops.prepare("SELECT count(*) n FROM operations_native_principal_inquiry_outbox")
      .first<number>("n")).toBe(1);
    expect(await ops.prepare("SELECT count(*) n FROM operations_native_principal_inquiry_audit WHERE action='submitted'")
      .first<number>("n")).toBe(1);

    const revokeBody = { operationId: id(173), expectedRevision: 4 };
    const pendingRevoke = await handleOperationsNativeRecipientOwnerHttp(ownerRequest(`intents/${issued.review.intentId}/revoke`, "POST",
      csrfToken, revokeBody), ownerDependencies);
    expect(pendingRevoke.status).toBe(202);
    expect(await pendingRevoke.json()).toMatchObject({ status: "pending", intent: { capabilityStatus: "pending",
      effectivePermissions: [] } });
    expect(await readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).toEqual([]);
    expect(JSON.parse(await listOpsPrincipalInquiries(inquiriesEnv, listRequest))).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.parse(await submitOpsPrincipalInquiry(inquiriesEnv, submitRequest))).toEqual({ ok: false, code: "unavailable" });
    const revokeResponse = await handleOperationsNativeRecipientOwnerHttp(ownerRequest(`intents/${issued.review.intentId}/revoke`, "POST",
      csrfToken, revokeBody), ownerDependencies);
    expect(revokeResponse.status).toBe(200);
    expect(await revokeResponse.json()).toMatchObject({ status: "acknowledged", intent: { capabilityStatus: "revoked",
      effectivePermissions: [] } });
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ capabilityStatus: "revoked", effectivePermissions: [] });
  });

  it("durably revokes a v4 parent without promoting a never-created companion grant", async () => {
    nativeOwnerAuth.authenticate.mockResolvedValue(owner);
    const ownerOrigin = "https://ops-staging.example.test";
    const ownerPath = "/api/native-client-portal/operations-recipient-enrollment";
    const clientEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED: "true" };
    let grantAttempts = 0;
    const binding = {
      applyNativeAuthority: (wire: string) => applyOperationsPortalNativeRecipientAuthority(clientEnv, wire),
      getNativeAuthorityStatus: (wire: string) => readOperationsPortalNativeRecipientAuthorityStatus(clientEnv, wire),
      applyNativeInquiryCapability: (wire: string) => {
        const command = JSON.parse(wire) as { action?: string };
        if (command.action === "grant") {
          grantAttempts++;
          return JSON.stringify({ ok: false, protocolVersion: 1, code: "temporary_failure", retryable: true });
        }
        return applyOperationsPortalNativeInquiryCapability(clientEnv, wire);
      },
      closeNativeInquiryCapability: (wire: string) => closeOperationsPortalNativeInquiryCapability(clientEnv, wire),
      getNativeInquiryCapabilityStatus: (wire: string) => readOperationsPortalNativeInquiryCapabilityStatus(clientEnv, wire),
    };
    const ownerDependencies = { environment: "staging", expectedHost: "ops-staging.example.test", database: ops,
      dispatch: { OPS_DB: ops, OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
        OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true", OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: binding },
      configuration: { enabled: true, issuer, staffAudience: "a".repeat(16), origin: ownerOrigin,
        recipientOrigin: "https://client-staging.example.test", csrfSecret: "native-owner-test-csrf-secret-long-enough" } };
    const ownerRequest = (path: string, method: "GET" | "POST", csrfToken?: string, body?: unknown) => new Request(
      `${ownerOrigin}${ownerPath}/${path}`, { method, headers: { Origin: ownerOrigin, "Sec-Fetch-Site": "same-origin",
        "X-Native-Staff-Request": "1", ...(method === "POST" ? { "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken ?? "" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const session = await handleOperationsNativeRecipientOwnerHttp(ownerRequest("session", "GET"), ownerDependencies);
    const csrfToken = (await session.json() as { csrfToken: string }).csrfToken;
    const issueResponse = await handleOperationsNativeRecipientOwnerHttp(ownerRequest("intents", "POST", csrfToken, {
      operationId: id(180), targetId, targetClientRecordId: clientId, expiresAt: future(),
      permissions: ["operations.request.create", "operations.service_home.read"],
    }), ownerDependencies);
    expect(issueResponse.status).toBe(201);
    const issued = await issueResponse.json() as { review: { intentId: string }; opaqueToken: string };
    await redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(181), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
      verifiedUntil: future(), acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId },
      acknowledgedPermissions: ["operations.request.create", "operations.service_home.read"],
      acknowledgedPermissionSchemaVersion: 4 });
    await applyCleanupMigration(ops);
    const confirm = await handleOperationsNativeRecipientOwnerHttp(ownerRequest(`intents/${issued.review.intentId}/confirm`, "POST",
      csrfToken, { operationId: id(182), expectedRevision: 2 }), ownerDependencies);
    expect(confirm.status).toBe(202);
    expect(await ops.prepare(`SELECT count(*) n FROM operations_portal_native_inquiry_capability_heads WHERE intent_id=?`)
      .bind(issued.review.intentId).first<number>("n")).toBe(0);
    expect(await client.prepare(`SELECT count(*) n FROM operations_portal_native_inquiry_capability_commands WHERE intent_id=?`)
      .bind(issued.review.intentId).first<number>("n")).toBe(0);

    const revoke = await handleOperationsNativeRecipientOwnerHttp(ownerRequest(`intents/${issued.review.intentId}/revoke`, "POST",
      csrfToken, { operationId: id(183), expectedRevision: 4 }), ownerDependencies);
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ status: "acknowledged", intent: { capabilityStatus: "revoked",
      effectivePermissions: [] } });
    expect(grantAttempts).toBe(1);
    expect(await ops.prepare(`SELECT count(*) n FROM operations_portal_native_inquiry_capability_heads WHERE intent_id=?`)
      .bind(issued.review.intentId).first<number>("n")).toBe(0);
    expect(await client.prepare(`SELECT count(*) n FROM operations_portal_native_inquiry_capability_commands WHERE intent_id=?`)
      .bind(issued.review.intentId).first<number>("n")).toBe(0);
    const storedGrantOperation = await ops.prepare(`SELECT operation_id FROM operations_portal_native_inquiry_capability_commands
      WHERE intent_id=? AND action='grant'`).bind(issued.review.intentId).first<string>("operation_id");
    expect(storedGrantOperation).toBeTruthy();
    await expect(dispatchOperationsNativeInquiryCapability(ownerDependencies.dispatch, storedGrantOperation!))
      .resolves.toMatchObject({ ok: false, code: "capability_not_found" });
    expect(grantAttempts).toBe(1);
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ capabilityStatus: "revoked", effectivePermissions: [] });
  });

  it("does not close a companion grant whose RPC returns after the parent revoke CAS", async () => {
    const permissions = ["operations.request.create", "operations.service_home.read"] as const;
    const clientEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED: "true" };
    const issued = await issueOperationsPortalNativeRecipientIntent(ops, { operationId: id(190), targetId,
      targetClientRecordId: clientId, expiresAt: future(), owner, legacyShape: false,
      permissionSchemaVersion: 4, permissions });
    await redeemOperationsPortalNativeRecipientIntent(ops, { operationId: id(191), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken!, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
      verifiedUntil: future(), acknowledgedTarget: { targetId, targetRevision: 1, clientRecordId: clientId },
      acknowledgedPermissions: permissions, acknowledgedPermissionSchemaVersion: 4 });
    await applyCleanupMigration(ops);
    const baseConfirm = await confirmOperationsPortalNativeRecipientIntent(ops, { operationId: id(192),
      intentId: issued.review.intentId, expectedRevision: 2, owner });
    await materializeOperationsPortalNativeRecipientAuthority(ops, id(192));
    const clientBaseEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" };
    const baseBinding = { applyNativeAuthority: (wire: string) => applyOperationsPortalNativeRecipientAuthority(clientBaseEnv, wire),
      getNativeAuthorityStatus: (wire: string) => readOperationsPortalNativeRecipientAuthorityStatus(clientBaseEnv, wire) };
    await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: ops,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: baseBinding,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true" }, baseConfirm.authorityOperationId))
      .resolves.toMatchObject({ status: "acknowledged" });
    const pins = await ops.prepare(`SELECT intent.expires_at,intent.grant_operation_id,intent.target_client_record_id,
        intent.access_issuer,intent.access_subject,recipient.recipient_binding_id,recipient.ownership_epoch,
        recipient.grant_revision,workspace.target_revision,workspace.client_authority_id,workspace.workspace_id,
        publication.latest_operation_id publication_operation_id,publication.publication_revision,
        publication.source_sequence,publication.snapshot_id,publication.snapshot_sha256
      FROM operations_portal_native_recipient_intents intent
      JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.enrollment_intent_id=intent.intent_id
      JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=intent.target_id
      JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
      WHERE intent.intent_id=?`).bind(issued.review.intentId).first<Record<string, string | number>>();
    if (!pins) throw new Error("expected current base and publication pins");
    const capabilityGrantOperationId = await operationsNativeInquiryCapabilityOperationId("grant", id(192));
    const makeGrant = () => canonicalOperationsPortalNativeInquiryCapabilityCommandV4({
      protocol: "operations-portal-native-inquiry-capability", protocolVersion: 1, permissionSchemaVersion: 4,
      action: "grant", operationId: capabilityGrantOperationId, target: { targetId, targetRevision: String(pins.target_revision),
        clientAuthorityId: pins.client_authority_id, workspaceId: pins.workspace_id,
        targetClientRecordId: pins.target_client_record_id },
      recipient: { recipientBindingId: pins.recipient_binding_id, enrollmentIntentId: issued.review.intentId,
        issuer: pins.access_issuer, subject: pins.access_subject },
      baseAuthority: { operationId: pins.grant_operation_id, ownershipEpoch: String(pins.ownership_epoch),
        grantRevision: String(pins.grant_revision) },
      publication: { operationId: pins.publication_operation_id, revision: String(pins.publication_revision),
        sourceSequence: String(pins.source_sequence), snapshotId: pins.snapshot_id, snapshotSha256: pins.snapshot_sha256 },
      transition: { expectedRevision: "0", resultingRevision: "1" }, permission: "operations.request.create",
      expiresAt: pins.expires_at, actorProof: { staffId: owner.identity.staffId,
        verifiedAccessSubject: owner.identity.verifiedAccessSubject, admissionVersion: String(owner.admissionVersion),
        profileVersion: String(owner.identity.profileVersion), grantGeneration: "4", verifiedUntil: future() },
      observedAt: new Date().toISOString(),
    });
    let revokeDuringGrantResponse = false;
    const capabilityBinding = {
      ...baseBinding,
      applyNativeInquiryCapability: async (wire: string) => {
        const applied = await applyOperationsPortalNativeInquiryCapability(clientEnv, wire);
        const command = JSON.parse(wire) as { action?: string };
        if (command.action === "grant" && !revokeDuringGrantResponse) {
          revokeDuringGrantResponse = true;
          const parentRevoke = await revokeOperationsPortalNativeRecipient(ops, { operationId: id(194),
            intentId: issued.review.intentId, expectedRevision: 4, owner });
          await materializeOperationsPortalNativeRecipientAuthority(ops, parentRevoke.authorityOperationId);
          await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: ops,
            OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: capabilityBinding,
            OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true" }, parentRevoke.authorityOperationId))
            .resolves.toMatchObject({ status: "acknowledged" });
        }
        return applied;
      },
      closeNativeInquiryCapability: (wire: string) => closeOperationsPortalNativeInquiryCapability(clientEnv, wire),
      getNativeInquiryCapabilityStatus: (wire: string) => readOperationsPortalNativeInquiryCapabilityStatus(clientEnv, wire),
    };
    const dispatchEnv = { OPS_DB: ops, OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: capabilityBinding,
      OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "true" };
    const prepared = await prepareOperationsNativeInquiryCapability(dispatchEnv, makeGrant());
    if (!prepared.ok) throw new Error(`race-grant-prepare-${prepared.code}`);
    const raced = await dispatchOperationsNativeInquiryCapability(dispatchEnv, capabilityGrantOperationId);
    expect(raced).toMatchObject({ ok: false, code: "revocation_pending", retryable: true });
    expect(revokeDuringGrantResponse).toBe(true);
    expect(await ops.prepare(`SELECT count(*) n FROM operations_portal_native_inquiry_capability_closures
      WHERE operation_id=? AND resulting_state='active'`).bind(capabilityGrantOperationId).first<number>("n")).toBe(0);
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    const cleaned = await ensureOperationsNativeRecipientInquiryCapability(dispatchEnv, issued.review.intentId, id(194), "revoke", owner);
    expect(cleaned).toMatchObject({ ok: true, state: "revoked" });
    expect(await ops.prepare(`SELECT state FROM operations_portal_native_inquiry_capability_heads WHERE intent_id=?`)
      .bind(issued.review.intentId).first<string>("state")).toBe("revoked");
    await expect(readNativeOperationsRequestCapabilities(client, { issuer, subject }, true)).resolves.toEqual([]);
    await expect(readOperationsPortalNativeRecipientIntentForOwner(ops, issued.review.intentId, owner))
      .resolves.toMatchObject({ state: "revoked", capabilityStatus: "revoked", effectivePermissions: [] });
  });

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
          ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
          CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
          CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, wire);
        if (simulateAmbiguousGrant) {
          simulateAmbiguousGrant = false;
          throw new Error("simulated response loss after committed native grant");
        }
        return response;
      },
      getNativeAuthorityStatus: (wire: string) => readOperationsPortalNativeRecipientAuthorityStatus({ DELIVERY_DB: client,
        ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
        CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
        CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" }, wire),
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
          ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
          CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
          CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, wire); },
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
      DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" }, wire); };
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
      EXPECTED_HOST: "client-staging.example.test", CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, wire!);
    expect(JSON.parse(lostResponse)).toMatchObject({ ok: true, status: "recorded", operationId: id(62) });
    await advancePublication(ops);
    await expect(materializeOperationsPortalNativeRecipientAuthority(ops, id(62)))
      .resolves.toEqual({ operationId: id(62), requestFingerprint: frozen.requestFingerprint, replayed: true });
    let applyCalls = 0, statusCalls = 0;
    const shouldNotApply = async () => { applyCalls += 1; throw new Error("stale authority reached Client apply"); };
    const status = async (request: string) => { statusCalls += 1; return readOperationsPortalNativeRecipientAuthorityStatus({
      DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" }, request); };
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
