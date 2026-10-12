import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";
import { reserveOperationsPortalFolder, reserveOperationsPortalWorkspace } from "../src/worker/operations-portal-workspace-reservations";
import { reserveOperationsPortalWorkspacePublication,
  dispatchOperationsPortalWorkspacePublication as dispatchPublication,
  type OperationsPortalWorkspacePublicationBinding } from "../src/worker/operations-portal-workspace-publication-outbox";
import { reserveOperationsPortalWorkspacePublicationInvocation } from "../src/worker/operations-portal-workspace-publication-invocations";
import { issueOperationsPortalNativeRecipientIntent, redeemOperationsPortalNativeRecipientIntent,
  confirmOperationsPortalNativeRecipientIntent, readOperationsPortalNativeRecipientIntent } from "../src/worker/operations-portal-native-recipient-authority";
import { materializeOperationsPortalNativeRecipientAuthority,
  dispatchOperationsPortalNativeRecipientAuthority } from "../src/worker/operations-portal-native-recipient-authority-dispatch";
import { issueOperationsPortalNativeDeliveryAuthority,
  cancelOperationsPortalNativeDeliveryAuthorityForOwner, listOperationsPortalNativeDeliveryCandidates }
  from "../src/worker/operations-portal-native-delivery-authority-issuer";
import type { OperationsPortalNativeDeliveryCancellationBinding } from "@ltds/shared/operations-portal-native-delivery-authority";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import { applyOperationsPortalNativeRecipientAuthority,
  readOperationsPortalNativeRecipientAuthorityStatus } from "../../client/src/worker/operations-portal-native-recipient-authority";
import { publishOperationsPortalWorkspaceRpc, getOperationsPortalWorkspacePublicationStatusRpc }
  from "../../client/src/worker/operations-portal-workspace-publication-entrypoint";
import { applyOperationsPortalNativeDeliveryAuthority, cancelOperationsPortalNativeDeliveryAuthority,
  readOperationsPortalNativeDeliveryAuthorityDisposition, readOperationsPortalNativeDeliveryAuthorityStatus }
  from "../../client/src/worker/operations-portal-native-delivery-authority";

let runtime: Miniflare, operations: D1Database, client: D1Database, sequence = 1;
let scenario: { grantOperationId: string; authorityId: string; workspace: { targetId: string };
  operations: D1Database; client: D1Database } | undefined;
const id = () => `e0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const targetClient = "ops/cancel-checkpoint/client", source = "project-alpha:primary";
const sourceInstance = "11111111-1111-4111-8111-111111111111", application = "22222222-2222-4222-8222-222222222222";
const epoch = "33333333-3333-4333-8333-333333333333", division = "cancel-checkpoint-division";
const targetProject = "ops/cancel-checkpoint/project-client", siblingProject = "ops/cancel-checkpoint/project-sibling";
const otherProject = "ops/cancel-checkpoint/project-other", folderProject = "ops/cancel-checkpoint/physical-folder";
const selectedPrefix = "clients/cancel-checkpoint/project/selected/", basePrefix = "clients/cancel-checkpoint/project/";
const issuer = "https://cancel-checkpoint.cloudflareaccess.com", subject = "access|cancel-checkpoint-recipient";

function future(hours = 1) { return new Date(Date.now() + hours * 3_600_000).toISOString(); }
function owner(): AuthenticatedNativeStaffWithAdmissionVersion { return { identity: { kind: "native",
  staffId: "cancel-checkpoint-owner", verifiedAccessSubject: "access|cancel-checkpoint-owner",
  email: "cancel-checkpoint-owner@example.test", displayName: "Cancellation Checkpoint Owner", profileVersion: 1 },
  admissionVersion: 1, verifiedUntil: future(2) }; }
function recoveryOwner(): AuthenticatedNativeStaffWithAdmissionVersion { return { identity: { kind: "native",
  staffId: "cancel-checkpoint-recovery", verifiedAccessSubject: "access|cancel-checkpoint-recovery",
  email: "cancel-checkpoint-recovery@example.test", displayName: "Cancellation Checkpoint Recovery", profileVersion: 1 },
  admissionVersion: 1, verifiedUntil: future(2) }; }

async function seedStaff(staffId: string, email: string, accessSubject: string, permissions: string[]) {
  await operations.batch([
    operations.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')")
      .bind(staffId, email, "Synthetic Cancellation Staff", accessSubject),
    operations.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(staffId, accessSubject, staffId),
    operations.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(staffId, email, "Synthetic Cancellation Staff"),
    operations.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES(?,?,'role-owner','global',NULL,'global',?)`).bind(`${staffId}-role`, staffId, staffId),
    ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link"].map((permission, index) =>
      operations.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?,?,?,'allow','global',1,?)`).bind(`${staffId}-directory-${index}`, staffId, permission, staffId)),
    ...permissions.map((permission, index) => operations.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES(?,?,?,'allow','global',NULL,'global',?)`).bind(`${staffId}-permission-${index}`, staffId, permission, staffId)),
  ]);
}

async function seedRecord(recordId: string, kind: "organization" | "client", parent: string | null = null) {
  const mutationId = id(), admissionId = `admission-${id()}`;
  const scopes = [{ businessAreaId: "cancel-checkpoint-area", divisionId: "cancel-checkpoint-business-division" }];
  const destination = { sourceId: source, sourceInstanceUUID: sourceInstance, applicationUUID: application,
    historyEpoch: epoch, origin: "https://pa.example.test", externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" };
  const profile = kind === "organization" ? { name: "Cancellation Checkpoint Organization", generalEmail: "org@example.test",
    generalPhone: "", addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" }
    : { name: `Cancellation Checkpoint ${recordId === targetClient ? "Client" : "Sibling"}`,
      email: "client@example.test", phone: "", clientType: "business" as const,
      addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
  await operations.batch([
    operations.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, "cancel-checkpoint-owner", "access|cancel-checkpoint-owner", recordId,
        kind, JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ sourceId: destination.sourceId,
          sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID,
          historyEpoch: destination.historyEpoch, origin: destination.origin, externalCanonicalId: recordId }]), "cancel-checkpoint-owner"),
    ...(kind === "client" ? [operations.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,?,?)`)
      .bind(admissionId, recordId, parent, parent === null ? null : 1)] : []),
  ]);
  const write: NativeDirectoryCreateWrite = { operation: "create", mutationId, createAdmissionId: admissionId, recordId,
    expectedLocalVersion: 0, kind, profile, scopes, destinations: [destination], actor: {
      staffId: "cancel-checkpoint-owner", accessSubject: "access|cancel-checkpoint-owner",
      loginEmail: "cancel-checkpoint-owner@example.test", admissionVersion: 1, profileVersion: 1,
      selectedGrantId: "cancel-checkpoint-owner-directory-1", selectedIdentityGrantId: "cancel-checkpoint-owner-directory-2" },
    ...(kind === "client" ? { relationship: { organizationRecordId: parent, expectedRelationshipVersion: 0 } } : {}) } as NativeDirectoryCreateWrite;
  const outcome = await writeNativeDirectoryProfile(operations, write);
  if (outcome.status !== "written") throw new Error(`synthetic directory setup failed: ${outcome.reason}`);
  for (const commandId of outcome.commandIds) {
    const publicId = (sequence++).toString(16).padStart(32, "0");
    await operations.batch([
      operations.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,
        lease_token='cancel-checkpoint-fixture',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`).bind(commandId),
      operations.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
        project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
        VALUES(?,?,?,?,?,?,?,?)`).bind(source, kind, recordId, publicId, sourceInstance, application, epoch, commandId),
      operations.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,
        lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(JSON.stringify({ status: "acknowledged",
          response: { sourceInstanceId: sourceInstance, applicationId: application, historyEpoch: epoch,
            requestId: commandId, replayed: false, result: { resource: { type: kind, id: recordId,
              publicId, revision: "1" }, data: { publicId }, authorizationGeneration: "1" } } }), commandId),
    ]);
  }
  await operations.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=? AND state='materialized'")
    .bind(mutationId).run();
}

async function applyExact(database: D1Database, applicationName: "operations" | "client", name: string) {
  const migrationUrl = applicationName === "operations" ? new URL(`../migrations/${name}`, import.meta.url)
    : new URL(`../../client/migrations/${name}`, import.meta.url);
  await database.batch(splitD1MigrationStatements(readFileSync(migrationUrl, "utf8")).map(sql => database.prepare(sql)));
}

function topLevelViewPredicates(sql: string): string[] {
  const where = sql.slice(sql.indexOf("\nWHERE ") + "\nWHERE ".length).replace(/;\s*$/u, "");
  if (where === sql || where.trim().length === 0) throw new Error("view WHERE clause missing");
  return where.split(/\n  AND /u).map(predicate => predicate.replace(/\s+/gu, " ").trim());
}

async function publish(operationId: string) {
  const environment = { DELIVERY_DB: client, CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true",
    ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" } as const;
  const binding: OperationsPortalWorkspacePublicationBinding = {
    publishWorkspace: async value => JSON.stringify(await publishOperationsPortalWorkspaceRpc(environment, value)),
    getPublicationStatus: async value => JSON.stringify(await getOperationsPortalWorkspacePublicationStatusRpc(environment, value)),
  };
  const invocationId = id();
  await reserveOperationsPortalWorkspacePublicationInvocation(operations, owner(), { invocationId, operationId,
    action: "publish", reason: "Publish frozen terminal-cancellation test topology" });
  return dispatchPublication({ db: operations, binding, operationId, invocationId, action: "publish" });
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID(), CLIENT_DB: crypto.randomUUID() } });
  operations = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  client = await runtime.getD1Database("CLIENT_DB") as unknown as D1Database;
  await applyCanonicalChain(operations, "operations", "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql", true);
  await applyCanonicalChain(client, "client", "0223_operations_portal_workspace_publications.sql");
  for (const name of ["0224_operations_portal_native_recipient_authority.sql", "0225_operations_portal_workspace_publication_cancellations.sql",
    "0226_operations_portal_native_workspace_cleanup.sql", "0227_operations_portal_native_delivery_authority.sql",
    "0228_operations_portal_native_content_start_audit.sql", "0229_operations_portal_native_delivery_regrant.sql",
    "0230_operations_portal_native_delivery_terminal_cancellations.sql"]) await applyExact(client, "client", name);
  await seedStaff("cancel-checkpoint-owner", "cancel-checkpoint-owner@example.test", "access|cancel-checkpoint-owner",
    ["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"]);
  await seedStaff("cancel-checkpoint-recovery", "cancel-checkpoint-recovery@example.test", "access|cancel-checkpoint-recovery",
    ["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"]);
  await operations.batch([
    operations.prepare("INSERT INTO divisions(id,name,code,active) VALUES(?,'Cancellation Checkpoint','CANCEL-CHECKPOINT',1)").bind(division),
    operations.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('cancel-checkpoint-area','Cancellation Checkpoint',1)"),
    operations.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
      VALUES('cancel-checkpoint-business-division','cancel-checkpoint-area','Cancellation Checkpoint',1)`),
  ]);
  await seedRecord(targetClient, "client");
  await operations.batch([
    ...[[targetProject, "Client Project"], [siblingProject, "Sibling Project"],
      [otherProject, "Other Client Project"]].flatMap(([projectId, name]) => [
      operations.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,organization_record_id,client_record_id,scopes_json)
        VALUES(?,?,'active',NULL,?,'[]')`).bind(projectId, name, targetClient),
      operations.prepare("INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json) VALUES(?,1,'{}')")
        .bind(projectId),
    ]),
    operations.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
      VALUES(?,?,?,'manual','cancel-checkpoint-owner','2026-09-30 12:00:00')`).bind(folderProject, division, basePrefix),
  ]);
  const workspace = { operationId: id(), targetId: id(), clientAuthorityId: id(), workspaceId: `workspace:${id()}`,
    rootKind: "standalone_client" as const, rootRecordId: targetClient, rootRecordVersion: 1, relationshipVersion: 1,
    expectedRevision: 0 as const, reason: "Reserve exact cancellation workspace" };
  await reserveOperationsPortalWorkspace(operations, owner(), workspace);
  const folder = { operationId: id(), targetId: workspace.targetId, reservationId: id(), expectedRevision: 0 as const,
    expectedWorkspaceRevision: 1, externalProjectId: targetProject, projectVersion: 1, opsFolderProjectId: folderProject,
    opsDivisionId: division, baseR2Prefix: basePrefix, baseMatchMethod: "manual", baseConfirmedBy: "cancel-checkpoint-owner",
    baseConfirmedAt: "2026-09-30 12:00:00", clientFolderBindingId: `client-folder:${id()}`,
    selectedR2Prefix: selectedPrefix, reason: "Reserve exact current folder" };
  await reserveOperationsPortalFolder(operations, owner(), folder);
  const publication = await reserveOperationsPortalWorkspacePublication(operations, owner(), { operationId: id(), publicationId: id(),
    targetId: workspace.targetId, snapshotId: id(), checkpointId: id(), expectedRevision: 0, reason: "Publish three-project frozen topology" });
  await expect(publish(publication.operationId)).resolves.toMatchObject({ status: "acknowledged" });

  const recipient = await issueOperationsPortalNativeRecipientIntent(operations, { operationId: id(), targetId: workspace.targetId,
    targetClientRecordId: targetClient, expiresAt: future(24), owner: owner() });
  await redeemOperationsPortalNativeRecipientIntent(operations, { operationId: id(), intentId: recipient.review.intentId,
    opaqueToken: recipient.opaqueToken!, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
    verifiedUntil: future(2), acknowledgedTarget: { targetId: workspace.targetId, targetRevision: 1, clientRecordId: targetClient } });
  const homeOperation = id();
  await confirmOperationsPortalNativeRecipientIntent(operations, { operationId: homeOperation,
    intentId: recipient.review.intentId, expectedRevision: 2, owner: owner() });
  await materializeOperationsPortalNativeRecipientAuthority(operations, homeOperation);
  const recipientEnvironment = { DELIVERY_DB: client, ENVIRONMENT: "staging",
    EXPECTED_HOST: "client-staging.example.test", CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
    CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" } as const;
  await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: operations,
    OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true", OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
      applyNativeAuthority: wire => applyOperationsPortalNativeRecipientAuthority(recipientEnvironment, wire),
      getNativeAuthorityStatus: wire => readOperationsPortalNativeRecipientAuthorityStatus(recipientEnvironment, wire),
    } }, homeOperation)).resolves.toMatchObject({ status: "acknowledged" });
  const activeHome = await readOperationsPortalNativeRecipientIntent(operations, recipient.review.intentId);
  if (activeHome?.state !== "active" || !activeHome.recipientBindingId) throw new Error("synthetic active home required");
  // Candidate lookup is the same guarded read used by the owner UI.
  const candidateFingerprint = (await listOperationsPortalNativeDeliveryCandidates(operations, { targetId: workspace.targetId, owner: owner() }))
    .items.find(item => item.folderReservationId === folder.reservationId && item.recipientBindingId === activeHome.recipientBindingId)?.candidateFingerprint;
  if (!candidateFingerprint) throw new Error("synthetic exact candidate required");
  const grantOperationId = id(), authorityId = id();
  await issueOperationsPortalNativeDeliveryAuthority(operations, { operationId: grantOperationId, authorityId,
    recipientBindingId: activeHome.recipientBindingId, folderReservationId: folder.reservationId, expectedRevision: 0,
    expectedCandidateFingerprint: candidateFingerprint, features: ["file.download"], expiresAt: new Date(Date.now() + 1_000).toISOString(),
    reasonCode: "Never-materialized exact cancellation fixture", owner: owner() });
  await operations.prepare(`UPDATE operations_portal_native_delivery_authority_outbox SET state='dead',last_error_code='conflict',
    claim_token=NULL,claim_until=NULL WHERE operation_id=? AND state='pending'`).bind(grantOperationId).run();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await operations.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,organization_record_id,
    client_record_id,scopes_json) VALUES('ops/cancel-checkpoint/project-added-after-publication','Post-publication project',
    'active',NULL,?,'[]')`).bind(targetClient).run();
  await operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
    VALUES('ops/cancel-checkpoint/project-added-after-publication',1,'{}')`).run();

  scenario = { grantOperationId, authorityId, workspace, operations, client };
}, 240_000);

afterAll(async () => runtime.dispose());

describe("0197 terminal cancellation checkpoint scope", () => {
  it("allows exact never-recorded cleanup after one unrelated eligible project is added, without relaxing frozen-source guards", async () => {
    const f = scenario;
    if (!f) throw new Error("cancellation checkpoint scenario was not initialized");
    const strictSql = await f.operations.prepare(`SELECT sql FROM sqlite_master WHERE type='view'
      AND name='operations_portal_workspace_publication_current_checkpoints'`).first<string>("sql");
    const cancellationSql = await f.operations.prepare(`SELECT sql FROM sqlite_master WHERE type='view'
      AND name='operations_portal_workspace_delivery_cancellation_checkpoints'`).first<string>("sql");
    if (!strictSql || !cancellationSql) throw new Error("checkpoint views missing");
    const strictPredicates = topLevelViewPredicates(strictSql);
    const cancellationPredicates = topLevelViewPredicates(cancellationSql);
    const allowedProjectSetPredicates = strictPredicates.filter(predicate =>
      predicate.startsWith("checkpoint.project_count=(SELECT count(*) FROM operations_shared_projects project")
      || predicate.startsWith("NOT EXISTS(SELECT 1 FROM operations_shared_projects project"));
    expect(allowedProjectSetPredicates).toHaveLength(2);
    expect(cancellationPredicates).toEqual(strictPredicates.filter(predicate => !allowedProjectSetPredicates.includes(predicate)));
    expect(await f.operations.prepare(`SELECT project_count FROM operations_portal_workspace_publication_checkpoints
      WHERE checkpoint_id=(SELECT checkpoint_id FROM operations_portal_workspace_publication_heads WHERE target_id=?)`)
      .bind(f.workspace.targetId).first("project_count")).toBe(3);
    expect(await f.operations.prepare(`SELECT count(*) n FROM operations_shared_projects WHERE client_record_id=?`)
      .bind(targetClient).first("n")).toBe(4);
    await expect(f.operations.prepare(`SELECT count(*) n FROM operations_portal_workspace_publication_current_checkpoints
      WHERE checkpoint_id=(SELECT checkpoint_id FROM operations_portal_workspace_publication_heads WHERE target_id=?)`)
      .bind(f.workspace.targetId).first("n")).resolves.toBe(0);
    await expect(f.operations.prepare(`SELECT count(*) n FROM operations_portal_workspace_delivery_cancellation_checkpoints
      WHERE checkpoint_id=(SELECT checkpoint_id FROM operations_portal_workspace_publication_heads WHERE target_id=?)`)
      .bind(f.workspace.targetId).first("n")).resolves.toBe(1);
    await expect(listOperationsPortalNativeDeliveryCandidates(f.operations, { targetId: f.workspace.targetId, owner: owner() }))
      .resolves.toMatchObject({ items: [] });
    await expect(f.operations.prepare("UPDATE operations_shared_projects SET name='Frozen project drift' WHERE external_project_id=?")
      .bind(targetProject).run()).rejects.toThrow("shared project update requires a versioned writer");
    await expect(f.operations.prepare("DELETE FROM operations_shared_projects WHERE external_project_id=?")
      .bind(targetProject).run()).rejects.toThrow();
    await expect(f.operations.prepare(`SELECT count(*) n FROM operations_portal_workspace_delivery_cancellation_checkpoints
      WHERE checkpoint_id=(SELECT checkpoint_id FROM operations_portal_workspace_publication_heads WHERE target_id=?)`)
      .bind(f.workspace.targetId).first("n")).resolves.toBe(1);
    const tombstone = await f.client.prepare(`SELECT count(*) n FROM operations_portal_native_delivery_cancellations
      WHERE operation_id=?`).bind(f.grantOperationId).first("n");
    expect(tombstone).toBe(0);
    const cancellationEnvironment = { DELIVERY_DB: f.client, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_CANCELLATION_ENABLED: "true" };
    const binding: OperationsPortalNativeDeliveryCancellationBinding = {
      applyNativeDeliveryAuthority: input => applyOperationsPortalNativeDeliveryAuthority(cancellationEnvironment, input),
      getNativeDeliveryAuthorityStatus: input => readOperationsPortalNativeDeliveryAuthorityStatus(cancellationEnvironment, input),
      getNativeDeliveryAuthorityDisposition: input => readOperationsPortalNativeDeliveryAuthorityDisposition(cancellationEnvironment, input),
      cancelNativeDeliveryAuthority: input => cancelOperationsPortalNativeDeliveryAuthority(cancellationEnvironment, input),
    };
    await expect(cancelOperationsPortalNativeDeliveryAuthorityForOwner(f.operations, binding,
      { authorityId: f.authorityId, operationId: f.grantOperationId, owner: recoveryOwner() }))
      .resolves.toMatchObject({ disposition: "cancelled", replayed: false });
    await expect(f.operations.prepare(`SELECT count(*) n FROM operations_portal_native_delivery_cancellation_receipts
      WHERE operation_id=?`).bind(f.grantOperationId).first("n")).resolves.toBe(1);
    await expect(f.operations.prepare(`SELECT count(*) n FROM operations_portal_native_delivery_authority_heads
      WHERE authority_id=?`).bind(f.authorityId).first("n")).resolves.toBe(0);
    await expect(f.operations.prepare("PRAGMA foreign_key_check").all()).resolves.toMatchObject({ results: [] });
    await expect(f.client.prepare("PRAGMA foreign_key_check").all()).resolves.toMatchObject({ results: [] });
    await expect(f.client.prepare(`SELECT count(*) n FROM operations_portal_native_delivery_cancellations
      WHERE operation_id=?`).bind(f.grantOperationId).first("n")).resolves.toBe(1);
  });
});
