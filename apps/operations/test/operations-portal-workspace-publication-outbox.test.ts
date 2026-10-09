import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { sha256OperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublication } from "@ltds/shared/operations-portal-workspace-publication";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";
import { writeNativeDirectoryRelationship } from "../src/worker/native-directory-relationship-writer";
import { reserveOperationsPortalFolder, reserveOperationsPortalWorkspace,
  revokeOperationsPortalFolder, revokeOperationsPortalWorkspace }
  from "../src/worker/operations-portal-workspace-reservations";
import { dispatchOperationsPortalWorkspacePublication as guardedDispatch, reserveOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublicationBinding } from "../src/worker/operations-portal-workspace-publication-outbox";
import { reserveOperationsPortalWorkspacePublicationInvocation } from
  "../src/worker/operations-portal-workspace-publication-invocations";
import { cancelOperationsPortalWorkspacePublication as guardedCancel } from
  "../src/worker/operations-portal-workspace-publication-cancellations";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { getOperationsPortalWorkspacePublicationStatusRpc, publishOperationsPortalWorkspaceRpc }
  from "../../client/src/worker/operations-portal-workspace-publication-entrypoint";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

let runtime: Miniflare, operations: D1Database, client: D1Database, sequence = 1;
const id = () => `a0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const rpcResponse = (value: unknown) => JSON.stringify(value);
const organization = "ops/organization/native-publication";
const directClient = "ops/client/native-publication";
const project = "ops/project/native-publication-selected-folder";
const organizationProject = "ops/project/native-publication-organization-only";
const clientProject = "ops/project/native-publication-client-only";
const lateProject = "ops/project/native-publication-late-owned";
const foreignOrganization = "ops/organization/native-publication-foreign";
const foreignClient = "ops/client/native-publication-foreign";
const foreignProject = "ops/project/native-publication-foreign";
const mismatchedProject = "ops/project/native-publication-mismatched-owners";
const standaloneClient = "ops/client/native-publication-standalone";
const standaloneProject = "ops/project/native-publication-standalone";
const physicalProject = "ops/physical/native-publication-selected-folder";
const division = "native-publication-division";
const base = "clients/native-publication/project/";
const sourceInstance = "11111111-1111-4111-8111-111111111111";
const application = "22222222-2222-4222-8222-222222222222";
const epoch = "33333333-3333-4333-8333-333333333333";

function actor(): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId: "publication-owner", verifiedAccessSubject: "access|publication-owner",
    email: "publication-owner@example.test", displayName: "Publication Owner", profileVersion: 1 }, admissionVersion: 1,
    verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() };
}
async function seedManager() {
  await operations.batch([
    operations.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES('publication-owner','publication-owner@example.test','Publication Owner','access|publication-owner','active')`),
    operations.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('publication-owner','access|publication-owner',1,'publication-owner')`),
    operations.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('publication-owner','publication-owner@example.test','Publication Owner')`),
    operations.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES('publication-owner-role','publication-owner','role-owner','global',NULL,'global','publication-owner')`),
    operations.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('publication-owner-portal','publication-owner','directory.portal_access.manage','allow','global',1,'publication-owner')`),
    operations.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('publication-owner-profile','publication-owner','directory.profile.edit','allow','global',1,'publication-owner')`),
    operations.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('publication-owner-identity','publication-owner','directory.identity.link','allow','global',1,'publication-owner')`),
    ...["delivery.browse", "delivery.share.create", "delivery.share.revoke"].map((permission, index) =>
      operations.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,?,?,'allow','global',NULL,'global','publication-owner')`)
        .bind(`publication-owner-permission-${index}`, "publication-owner", permission)),
  ]);
}
function managerActor(staffId: string, profileVersion = 1, admissionVersion = 1): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId, verifiedAccessSubject: `access|${staffId}`,
    email: `${staffId}@example.test`, displayName: staffId, profileVersion }, admissionVersion,
    verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() };
}
async function seedAdditionalManager(staffId: string) {
  await operations.batch([
    operations.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES(?,?,?,?, 'active')`).bind(staffId, `${staffId}@example.test`, staffId, `access|${staffId}`),
    operations.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES(?,?,1,?)`).bind(staffId, `access|${staffId}`, staffId),
    operations.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES(?,?,?)`).bind(staffId, `${staffId}@example.test`, staffId),
    operations.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES(?,?,'role-owner','global',NULL,'global',?)`).bind(`${staffId}-role`, staffId, staffId),
    operations.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.portal_access.manage','allow','global',1,?)`).bind(`${staffId}-portal`, staffId, staffId),
    ...["projects.view", "delivery.browse"].map((permission, index) => operations.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES(?,?,?,'allow','global',NULL,'global',?)`).bind(`${staffId}-permission-${index}`, staffId, permission, staffId)),
  ]);
}
async function seedRecord(recordId: string, kind: "organization" | "client", parent: string | null = null) {
  const mutationId = id(), admissionId = `admission-${id()}`;
  const scopes = [{ businessAreaId: "publication-area", divisionId: "publication-business-division" }];
  const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID: sourceInstance, applicationUUID: application,
    historyEpoch: epoch, origin: "https://pa.example.test", externalCanonicalId: recordId,
    expectedAuthorizationGeneration: "0" };
  const profile = kind === "organization"
    ? { name: "Native Publication Organization", generalEmail: "organization@example.test", generalPhone: "",
      addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" }
    : { name: "Native Direct Client", email: "client@example.test", phone: "", clientType: "business" as const,
      addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
  const admission = operations.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, "publication-owner", "access|publication-owner", recordId, kind,
      JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ sourceId: destination.sourceId,
        sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID,
        historyEpoch: destination.historyEpoch, origin: destination.origin, externalCanonicalId: recordId }]), "publication-owner");
  await operations.batch([admission, ...(kind === "client" ? [operations.prepare(`INSERT INTO
    native_directory_create_admission_relationships(create_admission_id,client_record_id,organization_record_id,
      organization_record_version) VALUES(?,?,?,?)`).bind(admissionId, recordId, parent, parent === null ? null : 1)] : [])]);
  const write = { operation: "create", mutationId, createAdmissionId: admissionId, recordId, expectedLocalVersion: 0,
    kind, profile, scopes, destinations: [destination], actor: { staffId: "publication-owner",
      accessSubject: "access|publication-owner", loginEmail: "publication-owner@example.test", admissionVersion: 1,
      profileVersion: 1, selectedGrantId: "publication-owner-profile", selectedIdentityGrantId: "publication-owner-identity" },
    ...(kind === "client" ? { relationship: { organizationRecordId: parent, expectedRelationshipVersion: 0 } } : {})
  } as NativeDirectoryCreateWrite;
  const outcome = await writeNativeDirectoryProfile(operations, write);
  expect(outcome, outcome.status === "blocked" ? outcome.reason : undefined)
    .toMatchObject({ status: "written", version: 1 });
  return { write, outcome };
}
async function acknowledgeCreate(seed: Awaited<ReturnType<typeof seedRecord>>, publicId: string) {
  if (seed.outcome.status !== "written") throw new Error(`seed write failed: ${seed.outcome.reason}`);
  for (const commandId of seed.outcome.commandIds) {
    await operations.batch([
      operations.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,
        lease_token='publication-fixture',lease_expires_at=9999999999999
        WHERE command_id=? AND state='pending'`).bind(commandId),
      operations.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
        project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
        VALUES(?,?,?,?,?,?,?,?)`).bind(seed.write.destinations[0]!.sourceId, seed.write.kind,
          seed.write.recordId, publicId, seed.write.destinations[0]!.sourceInstanceUUID,
          seed.write.destinations[0]!.applicationUUID, seed.write.destinations[0]!.historyEpoch, commandId),
      operations.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,
        lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(JSON.stringify({
          status: "acknowledged", response: { requestId: commandId, replayed: false,
            sourceInstanceId: seed.write.destinations[0]!.sourceInstanceUUID,
            applicationId: seed.write.destinations[0]!.applicationUUID,
            historyEpoch: seed.write.destinations[0]!.historyEpoch, result: { resource: { type: seed.write.kind,
              id: seed.write.recordId, publicId, revision: "1" }, data: { publicId }, authorizationGeneration: "1" } },
        }), commandId),
    ]);
  }
  await operations.prepare(`UPDATE operations_directory_intents SET state='acknowledged'
    WHERE mutation_id=? AND state='materialized'`).bind(seed.write.mutationId).run();
}
function workspaceInput(root: { kind: "organization" | "standalone_client"; recordId: string;
  relationshipVersion: number | null } = { kind: "organization", recordId: organization, relationshipVersion: null }) {
  return { operationId: id(), targetId: id(), clientAuthorityId: id(), workspaceId: `workspace:${id()}`,
    rootKind: root.kind, rootRecordId: root.recordId, rootRecordVersion: 1,
    relationshipVersion: root.relationshipVersion, expectedRevision: 0 as const,
    reason: "Reserve native publication workspace" };
}
function folderInput(targetId: string, selectedR2Prefix: string) {
  const reservationId = id();
  return { operationId: id(), targetId, reservationId, expectedRevision: 0 as const, expectedWorkspaceRevision: 1,
    externalProjectId: project, projectVersion: 1, opsFolderProjectId: physicalProject, opsDivisionId: division,
    baseR2Prefix: base, baseMatchMethod: "manual", baseConfirmedBy: "publication-owner",
    baseConfirmedAt: "2026-09-30 12:00:00", clientFolderBindingId: `client-folder:${reservationId}`,
    selectedR2Prefix, reason: "Reserve exact selected folder" };
}
function publicationInput(targetId: string, expectedRevision: number) {
  return { operationId: id(), publicationId: id(), targetId, snapshotId: id(), checkpointId: id(), expectedRevision,
    reason: "Publish complete native topology snapshot" };
}
async function dispatchOperationsPortalWorkspacePublication(input: {
  db: D1Database; binding: OperationsPortalWorkspacePublicationBinding; operationId: string;
}) {
  const invocationId = id();
  let action: "publish" | "recover" = "publish";
  try {
    await reserveOperationsPortalWorkspacePublicationInvocation(input.db, actor(), { invocationId,
      operationId: input.operationId, action, reason: "Test exact publication invocation" });
  } catch {
    action = "recover";
    try { await reserveOperationsPortalWorkspacePublicationInvocation(input.db, actor(), { invocationId,
      operationId: input.operationId, action, reason: "Test exact publication recovery" }); } catch { /* terminal */ }
  }
  return guardedDispatch({ ...input, invocationId, action });
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID(), CLIENT_DB: crypto.randomUUID() } });
  operations = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  client = await runtime.getD1Database("CLIENT_DB") as unknown as D1Database;
  expect(await applyCanonicalChain(operations, "operations",
    "0153_operations_portal_workspace_publication_outbox.sql", true)).toHaveLength(153);
  for (const name of ["0155_operations_portal_workspace_publication_cancellations.sql",
    "0156_operations_portal_workspace_publication_invocations.sql"]) {
    const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await operations.batch(splitD1MigrationStatements(sql).map(statement => operations.prepare(statement)));
  }
  // Current directory writers query the Ops record ID separately from PA's
  // external ID; refresh the mapping view while preserving this focused legacy
  // fixture lineage.
  const mappingViewMigration = readFileSync(new URL(
    "../migrations/0170_project_alpha_active_directory_project_guard.sql", import.meta.url), "utf8");
  await operations.batch(splitD1MigrationStatements(mappingViewMigration)
    .map(statement => operations.prepare(statement)));
  // This is an explicit local proposal supplement, not canonical migration
  // 0182. It keeps the historical portal chain while exercising the current
  // normalized relationship-revision evidence contract used by the writer.
  const relationshipProposal = readFileSync(new URL(
    "../../../scripts/proposals/0182_project_alpha_directory_relationship_recovery_guard.sql", import.meta.url), "utf8");
  const revisionMarker = "DROP VIEW project_alpha_directory_relationship_revision_evidence;";
  const revisionOffset = relationshipProposal.indexOf(revisionMarker);
  if (revisionOffset < 0) throw new Error("missing proposal revision-evidence replacement");
  await operations.batch(splitD1MigrationStatements(relationshipProposal.slice(revisionOffset)
    .replaceAll("operations_directory_effective_materializations", "operations_directory_materializations"))
    .map(statement => operations.prepare(statement)));
  expect(await applyCanonicalChain(client, "client", "0223_operations_portal_workspace_publications.sql")).toHaveLength(142);
  await seedManager();
  await operations.batch([
    operations.prepare(`INSERT INTO divisions(id,name,code,active)
      VALUES(?,'Native Publication Division','NATIVE-PUBLICATION',1)`).bind(division),
    operations.prepare(`INSERT INTO native_business_areas(id,name,active)
      VALUES('publication-area','Publication Area',1)`),
    operations.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
      VALUES('publication-business-division','publication-area','Publication Business Division',1)`),
  ]);
  const organizationSeed = await seedRecord(organization, "organization");
  await acknowledgeCreate(organizationSeed, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  await seedRecord(directClient, "client", organization);
  const foreignOrganizationSeed = await seedRecord(foreignOrganization, "organization");
  await acknowledgeCreate(foreignOrganizationSeed, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  await seedRecord(foreignClient, "client", foreignOrganization);
  const standaloneClientSeed = await seedRecord(standaloneClient, "client", null);
  await acknowledgeCreate(standaloneClientSeed, "cccccccccccccccccccccccccccccccc");
  await operations.batch([
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,organization_record_id,client_record_id,scopes_json)
      VALUES(?,'Selected Folder Project','active',?,?,'[]')`).bind(project, organization, directClient),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(project),
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,organization_record_id,scopes_json)
      VALUES(?,'Organization Project','active',?,'[]')`).bind(organizationProject, organization),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(organizationProject),
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,client_record_id,scopes_json)
      VALUES(?,'Client Project','active',?,'[]')`).bind(clientProject, directClient),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(clientProject),
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,organization_record_id,scopes_json)
      VALUES(?,'Foreign Project','active',?,'[]')`).bind(foreignProject, foreignOrganization),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(foreignProject),
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,organization_record_id,client_record_id,scopes_json)
      VALUES(?,'Mismatched Owner Project','active',?,?,'[]')`)
      .bind(mismatchedProject, organization, foreignClient),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(mismatchedProject),
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,client_record_id,scopes_json)
      VALUES(?,'Standalone Project','active',?,'[]')`).bind(standaloneProject, standaloneClient),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(standaloneProject),
    operations.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
      VALUES(?,?,?,?,?,?)`).bind(physicalProject, division, base, "manual", "publication-owner", "2026-09-30 12:00:00"),
  ]);
}, 240_000);
afterAll(async () => runtime.dispose());

describe("0153 native Operations workspace topology publication outbox with current 0170 mapping view", () => {
  it("closes exact source checkpoints through Client and recovers a lost response without widening authority", async () => {
    const owner = actor(), workspace = workspaceInput();
    await reserveOperationsPortalWorkspace(operations, owner, workspace);
    let hostileToStringCalled = false;
    const hostileOperationId = { toString() { hostileToStringCalled = true; return id(); } };
    await expect(reserveOperationsPortalWorkspacePublication(operations, owner, {
      ...publicationInput(workspace.targetId, 0), operationId: hostileOperationId,
    } as unknown as Parameters<typeof reserveOperationsPortalWorkspacePublication>[2]))
      .rejects.toThrow("operations_portal_workspace_publication_denied");
    expect(hostileToStringCalled).toBe(false);
    await expect(reserveOperationsPortalWorkspacePublication(operations, owner, {
      ...publicationInput(workspace.targetId, 0), reason: `bounded${" ".repeat(501)}`,
    })).rejects.toThrow("operations_portal_workspace_publication_denied");
    expect(await operations.prepare(`SELECT count(*) count
      FROM operations_portal_workspace_publication_commands`).first("count")).toBe(0);
    await operations.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES('publication-owner-project-view-deny','publication-owner','projects.view','deny','global',NULL,'global',
        'publication-owner')`).run();
    await expect(reserveOperationsPortalWorkspacePublication(operations, owner,
      publicationInput(workspace.targetId, 0))).rejects.toThrow("operations_portal_workspace_publication_denied");
    await operations.prepare(`DELETE FROM staff_permission_overrides
      WHERE id='publication-owner-project-view-deny'`).run();
    const initialFolder = folderInput(workspace.targetId, `${base}initial/`);
    await reserveOperationsPortalFolder(operations, owner, initialFolder);

    const staleInput = publicationInput(workspace.targetId, 0);
    const concurrent = await Promise.all([
      reserveOperationsPortalWorkspacePublication(operations, owner, staleInput),
      reserveOperationsPortalWorkspacePublication(operations, owner, staleInput),
    ]);
    expect(concurrent.map(value => value.replayed).sort()).toEqual([false, true]);
    const stale = concurrent.find(value => !value.replayed)!;
    expect(stale).toMatchObject({ publicationRevision: 1, sourceSequence: 1, state: "pending", replayed: false });
    const snapshot = JSON.parse(String(await operations.prepare(`SELECT snapshot_json FROM
      operations_portal_workspace_publication_snapshots WHERE snapshot_id=?`).bind(stale.snapshotId)
      .first("snapshot_json"))) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ complete: true, counts: { directoryRecords: 2, projects: 3,
      folderReservations: 1, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      recipientAuthorityHeads: [], deliveryAuthorityHeads: [] });
    expect((snapshot.projects as Array<{ externalProjectId: string }>).map(value => value.externalProjectId))
      .toEqual([clientProject, organizationProject, project].sort());
    expect(JSON.stringify(snapshot)).not.toContain(foreignProject);
    expect(JSON.stringify(snapshot)).not.toContain(mismatchedProject);
    expect(snapshot).not.toHaveProperty("projects.0.externalFence.sourceId");
    const rejectRawSnapshot = async (candidate: Record<string, unknown>,
      transform: (json: string) => string = value => value) => {
      const rawCheckpointId = id(), rawSnapshotId = id();
      candidate.checkpointId = rawCheckpointId;
      candidate.snapshotId = rawSnapshotId;
      candidate.snapshotSha256 = "f".repeat(64);
      await expect(operations.batch([
        operations.prepare(`INSERT INTO operations_portal_workspace_publication_checkpoints
          (checkpoint_id,target_id,target_revision,directory_record_count,project_count,folder_reservation_count,
            directory_sha256,project_sha256,folder_sha256,observed_at)
          SELECT ?,target_id,target_revision,directory_record_count,project_count,folder_reservation_count,
            directory_sha256,project_sha256,folder_sha256,observed_at
          FROM operations_portal_workspace_publication_checkpoints WHERE checkpoint_id=?`)
          .bind(rawCheckpointId, staleInput.checkpointId),
        operations.prepare(`INSERT INTO operations_portal_workspace_publication_directory_sources
          SELECT ?,record_id,record_kind,record_version,parent_record_id,relationship_version,display_name
          FROM operations_portal_workspace_publication_directory_sources WHERE checkpoint_id=?`)
          .bind(rawCheckpointId, staleInput.checkpointId),
        operations.prepare(`INSERT INTO operations_portal_workspace_publication_project_sources
          SELECT ?,external_project_id,project_version,name,lifecycle,planned_start,planned_end,completed_at,archived,
            archived_at,overdue_warning,published,organization_record_id,client_record_id
          FROM operations_portal_workspace_publication_project_sources WHERE checkpoint_id=?`)
          .bind(rawCheckpointId, staleInput.checkpointId),
        operations.prepare(`INSERT INTO operations_portal_workspace_publication_folder_sources
          SELECT ?,reservation_id,external_project_id,ops_folder_project_id,division_id,client_folder_binding_id,
            binding_version,r2_prefix,base_r2_prefix,base_match_method,base_confirmed_by,base_confirmed_at
          FROM operations_portal_workspace_publication_folder_sources WHERE checkpoint_id=?`)
          .bind(rawCheckpointId, staleInput.checkpointId),
        operations.prepare(`INSERT INTO operations_portal_workspace_publication_snapshots
          (snapshot_id,checkpoint_id,target_id,source_sequence,snapshot_sha256,snapshot_json)
          VALUES(?,?,?,1,?,?)`).bind(rawSnapshotId, rawCheckpointId, workspace.targetId,
            "f".repeat(64), transform(JSON.stringify(candidate))),
      ])).rejects.toThrow("publication snapshot is not the exact normalized checkpoint");
    };
    const duplicateDirectory = structuredClone(snapshot) as Record<string, any>;
    duplicateDirectory.directoryRecords = [duplicateDirectory.directoryRecords[0], duplicateDirectory.directoryRecords[0]];
    await rejectRawSnapshot(duplicateDirectory);
    const missingNullable = structuredClone(snapshot) as Record<string, any>;
    delete missingNullable.projects[0].plannedStart;
    missingNullable.projects[0].unknownNullable = null;
    await rejectRawSnapshot(missingNullable);
    const malformedVersion = structuredClone(snapshot) as Record<string, any>;
    malformedVersion.projects[0].version = "1junk";
    await rejectRawSnapshot(malformedVersion);
    const missingBoolean = structuredClone(snapshot) as Record<string, any>;
    delete missingBoolean.projects[0].archived;
    missingBoolean.projects[0].unknownArchived = false;
    await rejectRawSnapshot(missingBoolean);
    const numericComplete = structuredClone(snapshot) as Record<string, any>;
    numericComplete.complete = 1;
    await rejectRawSnapshot(numericComplete);
    const booleanCount = structuredClone(snapshot) as Record<string, any>;
    booleanCount.counts.projects = false;
    await rejectRawSnapshot(booleanCount);
    await rejectRawSnapshot(structuredClone(snapshot), value => value.replace('"complete":true',
      '"complete":true,"complete":true'));
    await expect(reserveOperationsPortalWorkspacePublication(operations, owner,
      publicationInput(workspace.targetId, 0))).rejects.toThrow("operations_portal_workspace_publication_conflict");

    await operations.batch([
      operations.prepare(`INSERT INTO operations_shared_projects
        (external_project_id,name,lifecycle,organization_record_id,scopes_json)
        VALUES(?,'Late Owned Project','active',?,'[]')`).bind(lateProject, organization),
      operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
        VALUES(?,1,'{}')`).bind(lateProject),
    ]);
    const neverCalled: OperationsPortalWorkspacePublicationBinding = {
      publishWorkspace: async () => { throw new Error("must not dispatch stale first attempt"); },
      getPublicationStatus: async () => { throw new Error("must not query an unattempted stale command"); },
    };
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: neverCalled,
      operationId: stale.operationId })).resolves.toEqual({ operationId: stale.operationId, status: "superseded" });
    await revokeOperationsPortalFolder(operations, owner, { operationId: id(), targetId: workspace.targetId,
      reservationId: initialFolder.reservationId, expectedRevision: 1, reason: "Create pre-dispatch source drift" });

    const precommitFolder = folderInput(workspace.targetId, `${base}precommit/`);
    await reserveOperationsPortalFolder(operations, owner, precommitFolder);
    const authorityInput = publicationInput(workspace.targetId, 0);
    const authorityCommand = await reserveOperationsPortalWorkspacePublication(operations, owner, authorityInput);
    await operations.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES('publication-owner-project-view-deny','publication-owner','projects.view','deny','global',NULL,'global',
        'publication-owner')`).run();
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: neverCalled,
      operationId: authorityCommand.operationId })).resolves.toEqual({ operationId: authorityCommand.operationId,
      status: "superseded" });
    await operations.prepare(`DELETE FROM staff_permission_overrides
      WHERE id='publication-owner-project-view-deny'`).run();

    const preInvokeCrashInput = publicationInput(workspace.targetId, 0);
    const preInvokeCrash = await reserveOperationsPortalWorkspacePublication(operations, owner, preInvokeCrashInput);
    await operations.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='dispatching',
      attempt_count=1,claim_token='crashed-before-rpc',claim_until='2000-01-01T00:00:00.000Z'
      WHERE operation_id=? AND state='pending' AND remote_attempted=0`).bind(preInvokeCrash.operationId).run();
    await operations.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='retry',
      last_error_code='source-or-authority-race',claim_token=NULL,claim_until=NULL
      WHERE operation_id=? AND state='dispatching' AND remote_attempted=0`).bind(preInvokeCrash.operationId).run();
    await revokeOperationsPortalFolder(operations, owner, { operationId: id(), targetId: workspace.targetId,
      reservationId: precommitFolder.reservationId, expectedRevision: 1,
      reason: "Crash before remote-attempt marker permits safe supersession" });
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: neverCalled,
      operationId: preInvokeCrash.operationId })).resolves.toEqual({ operationId: preInvokeCrash.operationId,
      status: "superseded" });

    const recoveryFolder = folderInput(workspace.targetId, `${base}recovery/`);
    await reserveOperationsPortalFolder(operations, owner, recoveryFolder);

    const clientEnvironment = { DELIVERY_DB: client,
      CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true", ENVIRONMENT: "staging",
      EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" } as const;
    const timeoutRecoveryInput = publicationInput(workspace.targetId, 0);
    const timeoutRecovery = await reserveOperationsPortalWorkspacePublication(operations, owner, timeoutRecoveryInput);
    let recoveryPublishes = 0, recoveryStatusChecks = 0;
    const restoredTransport: OperationsPortalWorkspacePublicationBinding = {
      publishWorkspace: async publication => {
        recoveryPublishes += 1;
        if (recoveryPublishes === 1) throw new Error("simulated local timeout before remote invocation");
        return rpcResponse(await publishOperationsPortalWorkspaceRpc(clientEnvironment, publication));
      },
      getPublicationStatus: async publication => {
        recoveryStatusChecks += 1;
        return rpcResponse(await getOperationsPortalWorkspacePublicationStatusRpc(clientEnvironment, publication));
      },
    };
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: restoredTransport,
      operationId: timeoutRecovery.operationId })).resolves.toEqual({ operationId: timeoutRecovery.operationId,
      status: "retry" });
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: restoredTransport,
      operationId: timeoutRecovery.operationId })).resolves.toMatchObject({ operationId: timeoutRecovery.operationId,
      status: "acknowledged" });
    expect({ recoveryPublishes, recoveryStatusChecks }).toEqual({ recoveryPublishes: 2, recoveryStatusChecks: 1 });

    await revokeOperationsPortalFolder(operations, owner, { operationId: id(), targetId: workspace.targetId,
      reservationId: recoveryFolder.reservationId, expectedRevision: 1,
      reason: "Replace the acknowledged selected folder" });
    expect(await client.prepare(`SELECT count(*) count FROM operations_portal_workspace_publication_receipts`)
      .first("count")).toBe(1);

    const currentFolder = folderInput(workspace.targetId, `${base}current/`);
    await reserveOperationsPortalFolder(operations, owner, currentFolder);
    const currentInput = publicationInput(workspace.targetId, 1);
    const current = await reserveOperationsPortalWorkspacePublication(operations, owner, currentInput);
    await expect(reserveOperationsPortalWorkspacePublication(operations, owner, currentInput))
      .resolves.toEqual({ ...current, replayed: true });
    let calls = 0;
    const lostResponse: OperationsPortalWorkspacePublicationBinding = {
      publishWorkspace: async publication => {
        calls += 1;
        const result = await publishOperationsPortalWorkspaceRpc(clientEnvironment, publication);
        if (calls === 1) throw new Error("response lost after Client commit");
        return rpcResponse(result);
      },
      getPublicationStatus: async publication => rpcResponse(
        await getOperationsPortalWorkspacePublicationStatusRpc(clientEnvironment, publication)),
    };
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: lostResponse,
      operationId: current.operationId })).resolves.toEqual({ operationId: current.operationId, status: "retry" });
    expect(await client.prepare(`SELECT count(*) count FROM operations_portal_workspace_publication_receipts`)
      .first("count")).toBe(2);

    // Drift after an ambiguous response is reconciled through the exact Client
    // status tuple. The stale command is never republished merely because it was attempted.
    await revokeOperationsPortalFolder(operations, owner, { operationId: id(), targetId: workspace.targetId,
      reservationId: currentFolder.reservationId, expectedRevision: 1, reason: "Drift after ambiguous remote commit" });
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: lostResponse,
      operationId: current.operationId })).resolves.toMatchObject({ operationId: current.operationId,
      status: "acknowledged", replayed: true });
    expect(calls).toBe(1);
    expect(await operations.prepare(`SELECT publication_revision,target_revision,source_sequence
      FROM operations_portal_workspace_publication_heads WHERE target_id=?`).bind(workspace.targetId).first())
      .toEqual({ publication_revision: 2, target_revision: 1, source_sequence: 2 });
    expect(await operations.prepare(`SELECT state FROM operations_portal_workspace_publication_outbox WHERE operation_id=?`)
      .bind(current.operationId).first("state")).toBe("acknowledged");

    const ambiguousFolder = folderInput(workspace.targetId, `${base}ambiguous/`);
    await reserveOperationsPortalFolder(operations, owner, ambiguousFolder);
    const ambiguousInput = publicationInput(workspace.targetId, 2);
    const ambiguous = await reserveOperationsPortalWorkspacePublication(operations, owner, ambiguousInput);
    let ambiguousPublishes = 0, ambiguousStatuses = 0;
    let attemptedPublication: OperationsPortalWorkspacePublication | null = null;
    const unresolvedTransport: OperationsPortalWorkspacePublicationBinding = {
      publishWorkspace: async publication => {
        ambiguousPublishes += 1;
        attemptedPublication = publication;
        return { malformed: true };
      },
      getPublicationStatus: async publication => {
        ambiguousStatuses += 1;
        if (ambiguousStatuses === 1) return rpcResponse(
          await getOperationsPortalWorkspacePublicationStatusRpc(clientEnvironment, publication));
        if (ambiguousStatuses === 2) return { malformed: true };
        if (ambiguousStatuses === 3) return "{";
        if (ambiguousStatuses === 4) return `"${"x".repeat(16_385)}"`;
        if (ambiguousStatuses === 5) return '{"ok":true,"ok":true,"disposition":"not-found"}';
        if (ambiguousStatuses === 6) return ` ${rpcResponse({ ok: true, disposition: "not-found" })}`;
        if (attemptedPublication === null) throw new Error("publication was not attempted");
        const exactReceipt = {
          operationId: attemptedPublication.operationId,
          publicationId: attemptedPublication.publicationId,
          requestFingerprint: await sha256OperationsPortalWorkspacePublication(attemptedPublication),
          targetId: attemptedPublication.target.targetId,
          resultingRevision: attemptedPublication.resultingRevision,
          sourceSequence: attemptedPublication.snapshot.sourceSequence,
          snapshotId: attemptedPublication.snapshot.snapshotId,
          snapshotSha256: attemptedPublication.snapshot.snapshotSha256,
          replayed: false,
        };
        if (ambiguousStatuses === 7) return rpcResponse({ ok: true, receipt: exactReceipt, extra: true });
        if (ambiguousStatuses === 8) return rpcResponse({ ok: true,
          receipt: { ...exactReceipt, extra: true } });
        if (ambiguousStatuses === 9) return rpcResponse({ ok: true,
          receipt: { ...exactReceipt, requestFingerprint: "0".repeat(64) } });
        if (ambiguousStatuses === 10) return rpcResponse({ ok: true,
          receipt: { ...exactReceipt, targetId: id() } });
        if (ambiguousStatuses === 11) return rpcResponse({ ok: true,
          receipt: { ...exactReceipt, resultingRevision: 3 } });
        if (ambiguousStatuses === 12) return rpcResponse({ ok: false,
          protocol: "operations-portal-workspace-publication", protocolVersion: 1,
          code: "temporarily-unavailable", retryable: true });
        if (ambiguousStatuses === 13) return rpcResponse({ ok: false,
          protocol: "operations-portal-workspace-publication", protocolVersion: 1,
          code: "conflict", retryable: false });
        throw new Error("status transport unavailable");
      },
    };
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: unresolvedTransport,
      operationId: ambiguous.operationId })).resolves.toEqual({ operationId: ambiguous.operationId, status: "retry" });
    await expect(operations.prepare(`UPDATE operations_portal_workspace_publication_outbox SET remote_attempted=0
      WHERE operation_id=?`).bind(ambiguous.operationId).run())
      .rejects.toThrow("publication remote-attempt marker is invalid");
    for (const unsafeState of ["dead", "superseded"] as const) {
      await expect(operations.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state=?
        WHERE operation_id=?`).bind(unsafeState, ambiguous.operationId).run())
        .rejects.toThrow("publication outbox transition denied");
    }
    await operations.prepare(`UPDATE operations_portal_workspace_publication_outbox SET last_error_code=NULL
      WHERE operation_id=? AND state='retry'`).bind(ambiguous.operationId).run();
    await revokeOperationsPortalFolder(operations, owner, { operationId: id(), targetId: workspace.targetId,
      reservationId: ambiguousFolder.reservationId, expectedRevision: 1,
      reason: "Prove stale attempted publication remains fenced until terminal Client evidence" });
    for (let index = 0; index < 14; index += 1) {
      await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: unresolvedTransport,
        operationId: ambiguous.operationId })).resolves.toEqual({ operationId: ambiguous.operationId, status: "retry" });
    }
    expect({ ambiguousPublishes, ambiguousStatuses }).toEqual({ ambiguousPublishes: 1, ambiguousStatuses: 14 });
    expect(await operations.prepare(`SELECT state,last_error_code FROM operations_portal_workspace_publication_outbox
      WHERE operation_id=?`).bind(ambiguous.operationId).first()).toEqual({ state: "retry",
      last_error_code: "rpc-outcome-ambiguous" });
    expect(await operations.prepare(`SELECT count(*) count FROM client_portal_authority_v2_outbox`).first("count")).toBe(0);
    expect(await operations.prepare(`SELECT count(*) count FROM verified_recipient_delivery_authority_outbox`).first("count")).toBe(0);
  }, 180_000);

  it("publishes a standalone client's complete project set without requiring a folder", async () => {
    const owner = actor();
    const workspace = workspaceInput({ kind: "standalone_client", recordId: standaloneClient, relationshipVersion: 1 });
    await reserveOperationsPortalWorkspace(operations, owner, workspace);
    const publication = await reserveOperationsPortalWorkspacePublication(operations, owner,
      publicationInput(workspace.targetId, 0));
    const snapshot = JSON.parse(String(await operations.prepare(`SELECT snapshot_json FROM
      operations_portal_workspace_publication_snapshots WHERE snapshot_id=?`).bind(publication.snapshotId)
      .first("snapshot_json"))) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ complete: true, counts: { directoryRecords: 1, projects: 1,
      folderReservations: 0, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      folderReservations: [], recipientAuthorityHeads: [], deliveryAuthorityHeads: [] });
    expect(snapshot.projects).toEqual([expect.objectContaining({ externalProjectId: standaloneProject,
      organizationRecordId: null, clientRecordId: standaloneClient, externalFence: null })]);
    const relationship = await writeNativeDirectoryRelationship(operations, {
      mutationId: id(), clientRecordId: standaloneClient, expectedRelationshipVersion: 1,
      expectedClientRecordVersion: 1, previousOrganization: null,
      organization: { recordId: foreignOrganization, expectedRecordVersion: 1 },
      actor: { staffId: "publication-owner", accessSubject: "access|publication-owner",
        email: "publication-owner@example.test", admissionVersion: 1, profileVersion: 1 },
    });
    expect(relationship).toMatchObject({ status: "written", relationshipVersion: 2 });
    const neverCalled: OperationsPortalWorkspacePublicationBinding = {
      publishWorkspace: async () => { throw new Error("must not publish a linked standalone root"); },
      getPublicationStatus: async () => { throw new Error("must not query an unattempted stale command"); },
    };
    await expect(dispatchOperationsPortalWorkspacePublication({ db: operations, binding: neverCalled,
      operationId: publication.operationId })).resolves.toEqual({ operationId: publication.operationId,
      status: "superseded" });
  }, 60_000);

  it("pins one-use current-manager invocations while separating publish, recovery, and stale cleanup", async () => {
    for (const manager of ["publication-manager", "profile-stale-manager", "admission-stale-manager",
      "generation-stale-manager", "denied-manager", "outscope-manager"]) await seedAdditionalManager(manager);
    const crossRoot = "ops/organization/publication-invoker-cross";
    const guardRoot = "ops/organization/publication-invoker-guard";
    await acknowledgeCreate(await seedRecord(crossRoot, "organization"), "dddddddddddddddddddddddddddddddd");
    await acknowledgeCreate(await seedRecord(guardRoot, "organization"), "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    const crossProject = "ops/project/publication-invoker-cross";
    await operations.batch([operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,organization_record_id,scopes_json)
      VALUES(?,'Invoker Cross Project','active',?,'[]')`).bind(crossProject, crossRoot),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(crossProject)]);
    const makeCommand = async (rootRecordId: string, withFolder = false) => {
      const workspace = workspaceInput({ kind: "organization", recordId: rootRecordId, relationshipVersion: null });
      await reserveOperationsPortalWorkspace(operations, actor(), workspace);
      const folder = withFolder ? { ...folderInput(workspace.targetId, `${base}guard-${id()}/`),
        externalProjectId: crossProject } : null;
      if (folder) await reserveOperationsPortalFolder(operations, actor(), folder);
      const input = publicationInput(workspace.targetId, 0);
      const command = await reserveOperationsPortalWorkspacePublication(operations, actor(), input);
      return { workspace, folder, input, command };
    };

    const crossManager = await makeCommand(crossRoot, true);
    const guardCandidate = await makeCommand(guardRoot);
    await expect(reserveOperationsPortalWorkspacePublicationInvocation(operations, {
      ...managerActor("publication-manager"), identity: { ...managerActor("publication-manager").identity,
        verifiedAccessSubject: "access|forged-manager" } }, { invocationId: id(),
      operationId: crossManager.command.operationId, action: "publish", reason: "Forged identity must fail" }))
      .rejects.toThrow("operations_portal_workspace_publication_invocation_denied");
    await operations.prepare(`DELETE FROM staff_role_assignments WHERE staff_id='outscope-manager'`).run();
    await expect(reserveOperationsPortalWorkspacePublicationInvocation(operations, managerActor("outscope-manager"), {
      invocationId: id(), operationId: crossManager.command.operationId, action: "publish",
      reason: "Out-of-scope manager must fail",
    })).rejects.toThrow("operations_portal_workspace_publication_invocation_denied");
    const crossInvocation = id();
    await reserveOperationsPortalWorkspacePublicationInvocation(operations, managerActor("publication-manager"), {
      invocationId: crossInvocation, operationId: crossManager.command.operationId, action: "publish",
      reason: "Different current manager publishes exact snapshot",
    });
    let attempted: OperationsPortalWorkspacePublication | null = null;
    expect(await guardedDispatch({ db: operations, operationId: crossManager.command.operationId,
      invocationId: crossInvocation, action: "publish", binding: {
        async publishWorkspace(publication) { attempted = publication; throw new Error("ambiguous"); },
        async getPublicationStatus() { throw new Error("not-before-publish"); },
      } })).toEqual({ operationId: crossManager.command.operationId, status: "retry" });
    expect(await operations.prepare(`SELECT action||':'||invoked_by_staff_id value
      FROM operations_portal_workspace_publication_invocation_audit WHERE invocation_id=?`)
      .bind(crossInvocation).first("value")).toBe("publish:publication-manager");

    for (const [staffId, invalidate] of [
      ["profile-stale-manager", async () => operations.prepare(`UPDATE native_staff_profiles
        SET display_name='stale profile',version=version+1 WHERE staff_id='profile-stale-manager'`).run()],
      ["admission-stale-manager", async () => operations.prepare(`UPDATE native_staff_admissions
        SET active=0,version=version+1 WHERE staff_id='admission-stale-manager'`).run()],
      ["generation-stale-manager", async () => operations.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('generation-stale-extra','generation-stale-manager','directory.profile.view','allow','global',1,
          'generation-stale-manager')`).run()],
    ] as const) {
      const invocationId = id();
      await reserveOperationsPortalWorkspacePublicationInvocation(operations, managerActor(staffId), { invocationId,
        operationId: guardCandidate.command.operationId, action: "publish", reason: `Invalidate ${staffId} proof` });
      await invalidate();
      let rpc = false;
      await expect(guardedDispatch({ db: operations, operationId: guardCandidate.command.operationId,
        invocationId, action: "publish", binding: { async publishWorkspace() { rpc = true; return {}; },
          async getPublicationStatus() { rpc = true; return {}; } } })).rejects
        .toThrow("operations_portal_workspace_publication_invocation_denied");
      expect(rpc).toBe(false);
    }

    const deniedInvocation = id();
    await reserveOperationsPortalWorkspacePublicationInvocation(operations, managerActor("denied-manager"), {
      invocationId: deniedInvocation, operationId: guardCandidate.command.operationId, action: "publish",
      reason: "Deny must win at claim",
    });
    await operations.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES('denied-manager-deny','denied-manager','projects.view','deny','global',NULL,'global','denied-manager')`).run();
    await expect(guardedDispatch({ db: operations, operationId: guardCandidate.command.operationId,
      invocationId: deniedInvocation, action: "publish", binding: { async publishWorkspace() { return {}; },
        async getPublicationStatus() { return {}; } } })).rejects
      .toThrow("operations_portal_workspace_publication_invocation_denied");

    const racedInvocation = id();
    await reserveOperationsPortalWorkspacePublicationInvocation(operations, managerActor("publication-manager"), {
      invocationId: racedInvocation, operationId: guardCandidate.command.operationId, action: "publish",
      reason: "One invocation wins a concurrent claim",
    });
    const raceBinding: OperationsPortalWorkspacePublicationBinding = {
      async publishWorkspace() { await new Promise(resolve => setTimeout(resolve, 20)); return { malformed: true }; },
      async getPublicationStatus() { return { malformed: true }; },
    };
    const raceResults = await Promise.allSettled([guardedDispatch({ db: operations,
      operationId: guardCandidate.command.operationId, invocationId: racedInvocation, action: "publish", binding: raceBinding }),
    guardedDispatch({ db: operations, operationId: guardCandidate.command.operationId,
      invocationId: racedInvocation, action: "publish", binding: raceBinding })]);
    expect(raceResults.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(raceResults.filter(result => result.status === "rejected")).toHaveLength(1);
    const recoveryInvocation = id();
    await reserveOperationsPortalWorkspacePublicationInvocation(operations, managerActor("publication-manager"), {
      invocationId: recoveryInvocation, operationId: guardCandidate.command.operationId, action: "recover",
      reason: "Status-only recovery cannot publish",
    });
    let recoveryPublishes = 0;
    expect(await guardedDispatch({ db: operations, operationId: guardCandidate.command.operationId,
      invocationId: recoveryInvocation, action: "recover", binding: {
        async publishWorkspace() { recoveryPublishes += 1; throw new Error("must-not-publish"); },
        async getPublicationStatus() { return rpcResponse({ ok: false,
          protocol: "operations-portal-workspace-publication", protocolVersion: 1,
          code: "not-found", retryable: false }); },
      } })).toEqual({ operationId: guardCandidate.command.operationId, status: "retry" });
    expect(recoveryPublishes).toBe(0);

    expect(attempted).not.toBeNull();
    await revokeOperationsPortalFolder(operations, actor(), { operationId: id(), targetId: crossManager.workspace.targetId,
      reservationId: crossManager.folder!.reservationId, expectedRevision: 1, reason: "Drift folder before cleanup" });
    await revokeOperationsPortalWorkspace(operations, actor(), { operationId: id(), targetId: crossManager.workspace.targetId,
      expectedRevision: 1, reason: "Drift workspace before cleanup" });
    await operations.prepare(`UPDATE native_staff_admissions SET active=0,version=version+1
      WHERE staff_id='publication-owner'`).run();
    const cancelInvocation = id();
    await reserveOperationsPortalWorkspacePublicationInvocation(operations, managerActor("publication-manager"), {
      invocationId: cancelInvocation, operationId: crossManager.command.operationId, action: "cancel",
      reason: "Current manager cleans stale creator attempt",
    });
    const publication = attempted!;
    const requestFingerprint = await sha256OperationsPortalWorkspacePublication(publication);
    const cancellation = { operationId: publication.operationId, publicationId: publication.publicationId,
      requestFingerprint, targetId: publication.target.targetId, targetRevision: publication.target.targetRevision,
      clientAuthorityId: publication.target.clientAuthorityId, workspaceId: publication.target.workspaceId,
      rootKind: publication.target.rootKind, rootRecordId: publication.target.rootRecordId,
      expectedRevision: publication.expectedRevision, resultingRevision: publication.resultingRevision,
      sourceSequence: publication.snapshot.sourceSequence, snapshotId: publication.snapshot.snapshotId,
      checkpointId: publication.snapshot.checkpointId, snapshotSha256: publication.snapshot.snapshotSha256,
      cancelledAt: "2026-09-30T12:00:00.000Z", replayed: false };
    expect(await guardedCancel({ db: operations, operationId: crossManager.command.operationId,
      invocationId: cancelInvocation, binding: { async getPublicationDisposition() {
        return rpcResponse({ ok: true, disposition: "not-found" }); }, async cancelWorkspacePublication() {
        return rpcResponse({ ok: true, disposition: "cancelled", cancellation }); } } })).toMatchObject({
      operationId: crossManager.command.operationId, status: "cancelled" });
  }, 180_000);
});
