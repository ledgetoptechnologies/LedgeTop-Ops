import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from
  "../src/worker/native-directory-profile-writer";
import { reserveOperationsPortalFolder, reserveOperationsPortalWorkspace } from
  "../src/worker/operations-portal-workspace-reservations";
import { reserveOperationsPortalWorkspacePublication,
  dispatchOperationsPortalWorkspacePublication as dispatchPublication,
  type OperationsPortalWorkspacePublicationBinding } from
  "../src/worker/operations-portal-workspace-publication-outbox";
import { reserveOperationsPortalWorkspacePublicationInvocation } from
  "../src/worker/operations-portal-workspace-publication-invocations";
import { publishOperationsPortalWorkspaceRpc, getOperationsPortalWorkspacePublicationStatusRpc } from
  "../../client/src/worker/operations-portal-workspace-publication-entrypoint";
import { issueOperationsPortalNativeRecipientIntent, redeemOperationsPortalNativeRecipientIntent,
  confirmOperationsPortalNativeRecipientIntent, readOperationsPortalNativeRecipientIntent } from
  "../src/worker/operations-portal-native-recipient-authority";
import { materializeOperationsPortalNativeRecipientAuthority,
  dispatchOperationsPortalNativeRecipientAuthority } from
  "../src/worker/operations-portal-native-recipient-authority-dispatch";
import { applyOperationsPortalNativeRecipientAuthority, readOperationsPortalNativeRecipientAuthorityStatus } from
  "../../client/src/worker/operations-portal-native-recipient-authority";
import { issueOperationsPortalNativeDeliveryAuthority, listOperationsPortalNativeDeliveryCandidates,
  revokeOperationsPortalNativeDeliveryAuthority } from
  "../src/worker/operations-portal-native-delivery-authority-issuer";
import { dispatchNextOperationsPortalNativeDeliveryAuthority } from
  "../src/worker/operations-portal-native-delivery-authority-dispatch";
import { readOperationsPortalNativeDeliveryAuthorization } from
  "../src/worker/operations-portal-native-delivery-authority-reader";
import { claimOperationsPortalNativeDeliveryRecoveryInvocation,
  reserveOperationsPortalNativeDeliveryRecoveryInvocation } from
  "../src/worker/operations-portal-native-delivery-recovery-invocations";
import { parseOperationsPortalNativeDeliveryAuthorityCommand,
  type OperationsPortalNativeDeliveryAuthorityBinding,
  type OperationsPortalNativeDeliveryAuthorityCommand } from
  "@ltds/shared/operations-portal-native-delivery-authority";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

let runtime: Miniflare, operations: D1Database, client: D1Database, sequence = 1;
const id = () => `d0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const organization = "ops/organization/native-delivery";
const clientRecord = "ops/client/native-delivery";
const siblingClientRecord = "ops/client/native-delivery-sibling";
const externalProject = "ops/project/native-delivery";
const siblingExternalProject = "ops/project/native-delivery-sibling";
const organizationExternalProject = "ops/project/native-delivery-organization";
const physicalProject = "ops/physical/native-delivery";
const siblingPhysicalProject = "ops/physical/native-delivery-sibling";
const organizationPhysicalProject = "ops/physical/native-delivery-organization";
const wildcardPhysicalProject = "ops/physical/native%_delivery";
const division = "native-delivery-division";
const basePrefix = "clients/native-delivery/project/";
const siblingBasePrefix = "clients/native-delivery-sibling/project/";
const organizationBasePrefix = "organizations/native-delivery/project/";
const wildcardBasePrefix = "clients/native%_delivery/project/";
const issuer = "https://native-delivery.cloudflareaccess.com", subject = "access|native-delivery-recipient";

function future(hours = 1) { return new Date(Date.now() + hours * 3_600_000).toISOString(); }
function owner(): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId: "native-delivery-owner",
    verifiedAccessSubject: "access|native-delivery-owner", email: "native-delivery-owner@example.test",
    displayName: "Native Delivery Owner", profileVersion: 1 }, admissionVersion: 1, verifiedUntil: future(2) };
}
function recoveryOwner(): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId: "native-delivery-recovery-manager",
    verifiedAccessSubject: "access|native-delivery-recovery-manager",
    email: "native-delivery-recovery-manager@example.test", displayName: "Native Delivery Recovery Manager",
    profileVersion: 1 }, admissionVersion: 1, verifiedUntil: future(2) };
}

async function seedManager() {
  await operations.batch([
    operations.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES('native-delivery-owner','native-delivery-owner@example.test','Native Delivery Owner',
        'access|native-delivery-owner','active')`),
    operations.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('native-delivery-owner','access|native-delivery-owner',1,'native-delivery-owner')`),
    operations.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('native-delivery-owner','native-delivery-owner@example.test','Native Delivery Owner')`),
    operations.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES('native-delivery-owner-role','native-delivery-owner','role-owner','global',NULL,'global',
        'native-delivery-owner')`),
    ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link"].map((permission, index) =>
      operations.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?, 'native-delivery-owner',?,'allow','global',1,'native-delivery-owner')`)
        .bind(`native-delivery-grant-${index}`, permission)),
    ...["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"].map((permission, index) =>
      operations.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,'native-delivery-owner',?,'allow','global',NULL,'global','native-delivery-owner')`)
        .bind(`native-delivery-permission-${index}`, permission)),
  ]);
}

async function seedRecoveryManager() {
  await operations.batch([
    operations.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES('native-delivery-recovery-manager','native-delivery-recovery-manager@example.test',
        'Native Delivery Recovery Manager','access|native-delivery-recovery-manager','active')`),
    operations.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('native-delivery-recovery-manager','access|native-delivery-recovery-manager',1,'native-delivery-owner')`),
    operations.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('native-delivery-recovery-manager','native-delivery-recovery-manager@example.test',
        'Native Delivery Recovery Manager')`),
    operations.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES('native-delivery-recovery-manager-role','native-delivery-recovery-manager','role-owner','global',NULL,
        'global','native-delivery-owner')`),
    operations.prepare(`INSERT INTO native_directory_grants
      (id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('native-delivery-recovery-portal-grant','native-delivery-recovery-manager',
        'directory.portal_access.manage','allow','global',1,'native-delivery-owner')`),
    ...["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"].map((permission, index) =>
      operations.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,'native-delivery-recovery-manager',?,'allow','global',NULL,'global','native-delivery-owner')`)
        .bind(`native-delivery-recovery-permission-${index}`, permission)),
  ]);
}

async function seedRecord(recordId: string, kind: "organization" | "client", parent: string | null = null) {
  const mutationId = id(), admissionId = `admission-${id()}`;
  const scopes = [{ businessAreaId: "native-delivery-area", divisionId: "native-delivery-business-division" }];
  const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
    applicationUUID: "22222222-2222-4222-8222-222222222222",
    historyEpoch: "33333333-3333-4333-8333-333333333333", origin: "https://pa.example.test",
    externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" };
  const profile = kind === "organization"
    ? { name: "Native Delivery Organization", generalEmail: "organization@example.test", generalPhone: "",
      addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" }
    : { name: "Native Delivery Client", email: "client@example.test", phone: "", clientType: "business" as const,
      addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
  await operations.batch([
    operations.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, "native-delivery-owner", "access|native-delivery-owner",
        recordId, kind, JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ sourceId: destination.sourceId,
          sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID,
          historyEpoch: destination.historyEpoch, origin: destination.origin, externalCanonicalId: recordId }]),
        "native-delivery-owner"),
    ...(kind === "client" ? [operations.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version)
      VALUES(?,?,?,?)`).bind(admissionId, recordId, parent, parent === null ? null : 1)] : []),
  ]);
  const write = { operation: "create", mutationId, createAdmissionId: admissionId, recordId,
    expectedLocalVersion: 0, kind, profile, scopes, destinations: [destination], actor: {
      staffId: "native-delivery-owner", accessSubject: "access|native-delivery-owner",
      loginEmail: "native-delivery-owner@example.test", admissionVersion: 1, profileVersion: 1,
      selectedGrantId: "native-delivery-grant-1", selectedIdentityGrantId: "native-delivery-grant-2" },
    ...(kind === "client" ? { relationship: { organizationRecordId: parent, expectedRelationshipVersion: 0 } } : {}),
  } as NativeDirectoryCreateWrite;
  const outcome = await writeNativeDirectoryProfile(operations, write);
  if (outcome.status !== "written") throw new Error(`native directory seed failed: ${outcome.reason}`);
  expect(outcome).toMatchObject({ status: "written", version: 1 });
  return { write, outcome };
}

async function acknowledgeCreate(seed: Awaited<ReturnType<typeof seedRecord>>, publicId: string) {
  for (const commandId of seed.outcome.commandIds) await operations.batch([
    operations.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,
      lease_token='native-delivery-fixture',lease_expires_at=9999999999999
      WHERE command_id=? AND state='pending'`).bind(commandId),
    operations.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
      project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,?,?,?,?,?,?,?)`).bind(seed.write.destinations[0]!.sourceId, seed.write.kind,
      seed.write.recordId, publicId, seed.write.destinations[0]!.sourceInstanceUUID,
      seed.write.destinations[0]!.applicationUUID, seed.write.destinations[0]!.historyEpoch, commandId),
    operations.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,
      lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(JSON.stringify({
        status: "acknowledged", response: { sourceInstanceId: seed.write.destinations[0]!.sourceInstanceUUID,
          applicationId: seed.write.destinations[0]!.applicationUUID,
          historyEpoch: seed.write.destinations[0]!.historyEpoch, requestId: commandId, replayed: false,
          result: { resource: { type: seed.write.kind,
            id: seed.write.recordId, publicId, revision: "1" }, data: { publicId },
            authorizationGeneration: "1" } },
      }), commandId),
  ]);
  await operations.prepare(`UPDATE operations_directory_intents SET state='acknowledged'
    WHERE mutation_id=? AND state='materialized'`).bind(seed.write.mutationId).run();
}

async function applyDraft(database: D1Database, application: "operations" | "client", name: string) {
  const url = application === "operations" ? new URL(`../migrations/${name}`, import.meta.url)
    : new URL(`../../client/migrations/${name}`, import.meta.url);
  await database.batch(splitD1MigrationStatements(readFileSync(url, "utf8")).map(statement => database.prepare(statement)));
}

async function dispatchCurrentPublication(operationId: string) {
  const clientEnvironment = { DELIVERY_DB: client, CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true",
    ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" } as const;
  const binding: OperationsPortalWorkspacePublicationBinding = {
    publishWorkspace: async publication => JSON.stringify(await publishOperationsPortalWorkspaceRpc(clientEnvironment, publication)),
    getPublicationStatus: async publication => JSON.stringify(
      await getOperationsPortalWorkspacePublicationStatusRpc(clientEnvironment, publication)),
  };
  const invocationId = id();
  await reserveOperationsPortalWorkspacePublicationInvocation(operations, owner(), { invocationId, operationId,
    action: "publish", reason: "Dispatch exact native delivery publication" });
  return dispatchPublication({ db: operations, binding, operationId, invocationId, action: "publish" });
}

function deliveryReadRequest(command: OperationsPortalNativeDeliveryAuthorityCommand) {
  return { authorityId: command.authority.authorityId, authorityRevision: Number(command.authority.resultingRevision),
    recipientBindingId: command.recipient.recipientBindingId, enrollmentIntentId: command.recipient.enrollmentIntentId,
    issuer: command.recipient.issuer, subject: command.recipient.subject, targetId: command.target.targetId,
    targetRevision: Number(command.target.targetRevision), targetClientRecordId: command.recipient.targetClientRecordId,
    clientAuthorityId: command.target.clientAuthorityId, workspaceId: command.target.workspaceId,
    homeOwnershipEpoch: Number(command.recipient.homeOwnershipEpoch),
    homeGrantRevision: Number(command.recipient.homeGrantRevision), homeGrantOperationId: command.recipient.homeGrantOperationId,
    homeRequestFingerprint: command.recipient.homeRequestFingerprint, publicationOperationId: command.publication.operationId,
    publicationId: command.publication.publicationId, publicationRevision: Number(command.publication.revision),
    publicationSourceSequence: Number(command.publication.sourceSequence),
    publicationSnapshotId: command.publication.snapshotId, publicationSnapshotSha256: command.publication.snapshotSha256,
    folderReservationId: command.resource.folderReservationId,
    folderReservationRevision: Number(command.resource.folderReservationRevision),
    clientFolderBindingId: command.resource.clientFolderBindingId, externalProjectId: command.resource.externalProjectId,
    projectVersion: Number(command.resource.projectVersion), opsFolderProjectId: command.resource.opsFolderProjectId,
    opsDivisionId: command.resource.opsDivisionId, feature: "file.download" as const };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID(), CLIENT_DB: crypto.randomUUID() } });
  operations = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  client = await runtime.getD1Database("CLIENT_DB") as unknown as D1Database;
  expect(await applyCanonicalChain(operations, "operations",
    "0187_operations_portal_native_delivery_literal_prefix_guard.sql", true)).toHaveLength(187);
  expect(await applyCanonicalChain(client, "client", "0223_operations_portal_workspace_publications.sql"))
    .toHaveLength(142);
  await applyDraft(client, "client", "0224_operations_portal_native_recipient_authority.sql");
  await seedManager();
  await seedRecoveryManager();
  await operations.batch([
    operations.prepare("INSERT INTO divisions(id,name,code,active) VALUES(?,'Native Delivery Division','NATIVE-DELIVERY',1)")
      .bind(division),
    operations.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('native-delivery-area','Delivery Area',1)"),
    operations.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
      VALUES('native-delivery-business-division','native-delivery-area','Delivery Business Division',1)`),
  ]);
  const organizationSeed = await seedRecord(organization, "organization");
  await acknowledgeCreate(organizationSeed, "10000000000000000000000000000001");
  await seedRecord(clientRecord, "client", organization);
  await seedRecord(siblingClientRecord, "client", organization);
  await operations.batch([
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,organization_record_id,client_record_id,scopes_json)
      VALUES(?,'Native Delivery Project','active',?,?,'[]')`).bind(externalProject, organization, clientRecord),
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,organization_record_id,client_record_id,scopes_json)
      VALUES(?,'Sibling Client Project','active',?,?,'[]')`)
      .bind(siblingExternalProject, organization, siblingClientRecord),
    operations.prepare(`INSERT INTO operations_shared_projects
      (external_project_id,name,lifecycle,organization_record_id,client_record_id,scopes_json)
      VALUES(?,'Organization Project','active',?,NULL,'[]')`).bind(organizationExternalProject, organization),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(externalProject),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(siblingExternalProject),
    operations.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
      VALUES(?,1,'{}')`).bind(organizationExternalProject),
    operations.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
      VALUES(?,?,?,?,?,?)`).bind(physicalProject, division, basePrefix, "manual", "native-delivery-owner",
        "2026-09-30 12:00:00"),
    operations.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
      VALUES(?,?,?,?,?,?)`).bind(siblingPhysicalProject, division, siblingBasePrefix, "manual", "native-delivery-owner",
        "2026-09-30 12:00:00"),
    operations.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
      VALUES(?,?,?,?,?,?)`).bind(organizationPhysicalProject, division, organizationBasePrefix, "manual",
        "native-delivery-owner", "2026-09-30 12:00:00"),
    operations.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
      VALUES(?,?,?,?,?,?)`).bind(wildcardPhysicalProject, division, wildcardBasePrefix, "manual",
        "native-delivery-owner", "2026-09-30 12:00:00"),
  ]);
}, 240_000);
afterAll(async () => runtime.dispose());

describe("Ops native selected-folder authority against real 0152-0160 plus current 0170 mapping view", () => {
  it("uses literal, case-sensitive selected-prefix containment without D1 LIKE patterns", async () => {
    const contained = async (selected: string, base: string) => operations.prepare(`SELECT
      substr(?,1,length(?))=? COLLATE BINARY matches`).bind(selected, base, base).first<number>("matches");
    const longLiteralBase = `clients/${"literal-segment/".repeat(5)}percent%/underscore_/backslash\\/`;
    expect(longLiteralBase.length).toBeGreaterThan(50);
    await expect(contained(`${longLiteralBase}selected/`, longLiteralBase)).resolves.toBe(1);
    await expect(contained(`${longLiteralBase.toUpperCase()}selected/`, longLiteralBase)).resolves.toBe(0);
    await expect(contained(`${longLiteralBase.slice(0, -1)}-sibling/selected/`, longLiteralBase)).resolves.toBe(0);
    await expect(contained("", longLiteralBase)).resolves.toBe(0);
    await expect(contained(`${longLiteralBase}selected/`, `${longLiteralBase}invalid`)).resolves.toBe(0);
  });

  it("grants, dispatches, reads exact current proof, denies drift/retarget, and revokes locally first", async () => {
    const containment = async (candidate: string) => operations.prepare(`SELECT
      substr(?,1,length(r2_prefix))=r2_prefix COLLATE BINARY matches
      FROM project_folders WHERE project_id=?`).bind(candidate, wildcardPhysicalProject).first<number>("matches");
    await expect(containment(`${wildcardBasePrefix}selected/`)).resolves.toBe(1);
    await expect(containment("clients/nativeAA_delivery/project/selected/")).resolves.toBe(0);
    const workspace = { operationId: id(), targetId: id(), clientAuthorityId: id(), workspaceId: `workspace:${id()}`,
      rootKind: "organization" as const, rootRecordId: organization, rootRecordVersion: 1,
      relationshipVersion: null, expectedRevision: 0 as const, reason: "Reserve native delivery workspace" };
    await reserveOperationsPortalWorkspace(operations, owner(), workspace);
    const folder = { operationId: id(), targetId: workspace.targetId, reservationId: id(), expectedRevision: 0 as const,
      expectedWorkspaceRevision: 1, externalProjectId: externalProject, projectVersion: 1,
      opsFolderProjectId: physicalProject, opsDivisionId: division, baseR2Prefix: basePrefix,
      baseMatchMethod: "manual", baseConfirmedBy: "native-delivery-owner", baseConfirmedAt: "2026-09-30 12:00:00",
      clientFolderBindingId: `client-folder:${id()}`, selectedR2Prefix: `${basePrefix}selected/`,
      reason: "Reserve exact native delivery folder" };
    await reserveOperationsPortalFolder(operations, owner(), folder);
    const siblingFolder = { operationId: id(), targetId: workspace.targetId, reservationId: id(), expectedRevision: 0 as const,
      expectedWorkspaceRevision: 1, externalProjectId: siblingExternalProject, projectVersion: 1,
      opsFolderProjectId: siblingPhysicalProject, opsDivisionId: division, baseR2Prefix: siblingBasePrefix,
      baseMatchMethod: "manual", baseConfirmedBy: "native-delivery-owner", baseConfirmedAt: "2026-09-30 12:00:00",
      clientFolderBindingId: `client-folder:${id()}`, selectedR2Prefix: `${siblingBasePrefix}selected/`,
      reason: "Reserve sibling client folder" };
    await reserveOperationsPortalFolder(operations, owner(), siblingFolder);
    const organizationFolder = { operationId: id(), targetId: workspace.targetId, reservationId: id(),
      expectedRevision: 0 as const, expectedWorkspaceRevision: 1, externalProjectId: organizationExternalProject,
      projectVersion: 1, opsFolderProjectId: organizationPhysicalProject, opsDivisionId: division,
      baseR2Prefix: organizationBasePrefix, baseMatchMethod: "manual", baseConfirmedBy: "native-delivery-owner",
      baseConfirmedAt: "2026-09-30 12:00:00", clientFolderBindingId: `client-folder:${id()}`,
      selectedR2Prefix: `${organizationBasePrefix}selected/`, reason: "Reserve organization-wide folder" };
    await reserveOperationsPortalFolder(operations, owner(), organizationFolder);
    const publication = await reserveOperationsPortalWorkspacePublication(operations, owner(), { operationId: id(),
      publicationId: id(), targetId: workspace.targetId, snapshotId: id(), checkpointId: id(), expectedRevision: 0,
      reason: "Publish native delivery topology" });
    await expect(dispatchCurrentPublication(publication.operationId)).resolves.toMatchObject({ status: "acknowledged" });

    const issued = await issueOperationsPortalNativeRecipientIntent(operations, { operationId: id(),
      targetId: workspace.targetId, targetClientRecordId: clientRecord, expiresAt: future(24), owner: owner() });
    await redeemOperationsPortalNativeRecipientIntent(operations, { operationId: id(), intentId: issued.review.intentId,
      opaqueToken: issued.opaqueToken!, principal: { issuer, subject }, recipientLabel: "recipient@example.test",
      verifiedUntil: future(2),
      acknowledgedTarget: { targetId: workspace.targetId, targetRevision: 1, clientRecordId: clientRecord } });
    const homeOperationId = id();
    await confirmOperationsPortalNativeRecipientIntent(operations, { operationId: homeOperationId,
      intentId: issued.review.intentId, expectedRevision: 2, owner: owner() });
    await materializeOperationsPortalNativeRecipientAuthority(operations, homeOperationId);
    const recipientEnvironment = { DELIVERY_DB: client, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" } as const;
    await expect(dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: operations,
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
        applyNativeAuthority: wire => applyOperationsPortalNativeRecipientAuthority(recipientEnvironment, wire),
        getNativeAuthorityStatus: wire => readOperationsPortalNativeRecipientAuthorityStatus(recipientEnvironment, wire),
      } }, homeOperationId)).resolves.toMatchObject({ status: "acknowledged" });
    const activeHome = await readOperationsPortalNativeRecipientIntent(operations, issued.review.intentId);
    expect(activeHome).toMatchObject({ state: "active", recipientBindingId: expect.any(String) });
    if (!activeHome) throw new Error("expected active native recipient home");

    const candidatePage = await listOperationsPortalNativeDeliveryCandidates(operations, {
      targetId: workspace.targetId, owner: owner() });
    const reviewedCandidate = candidatePage.items.find(item => item.recipientBindingId === activeHome.recipientBindingId
      && item.folderReservationId === folder.reservationId);
    expect(reviewedCandidate).toMatchObject({ targetId: workspace.targetId, targetClientRecordId: clientRecord,
      recipientLabel: "recipient@example.test", externalProjectId: externalProject, projectVersion: 1 });
    if (!reviewedCandidate) throw new Error("expected exact native delivery candidate");
    expect(candidatePage.items.some(item => item.folderReservationId === siblingFolder.reservationId)).toBe(false);
    const organizationCandidate = candidatePage.items.find(item => item.folderReservationId === organizationFolder.reservationId);
    expect(organizationCandidate).toMatchObject({ targetClientRecordId: clientRecord,
      externalProjectId: organizationExternalProject, folderReservationId: organizationFolder.reservationId });
    if (!organizationCandidate) throw new Error("expected organization-wide delivery candidate");
    await expect(issueOperationsPortalNativeDeliveryAuthority(operations, { operationId: id(), authorityId: id(),
      recipientBindingId: activeHome.recipientBindingId!, folderReservationId: siblingFolder.reservationId,
      expectedRevision: 0, features: ["file.download"], expiresAt: future(1),
      reasonCode: "Cross-client folder must remain denied", owner: owner() }))
      .rejects.toThrow("authority_denied");
    const organizationAuthorityId = id();
    await expect(issueOperationsPortalNativeDeliveryAuthority(operations, { operationId: id(),
      authorityId: organizationAuthorityId, recipientBindingId: activeHome.recipientBindingId!,
      folderReservationId: organizationFolder.reservationId, expectedRevision: 0,
      expectedCandidateFingerprint: organizationCandidate.candidateFingerprint, features: ["file.download"],
      expiresAt: future(1), reasonCode: "Organization-wide project policy", owner: owner() }))
      .resolves.toMatchObject({ replayed: false, review: { state: "active", revision: 1,
        folderReservationId: organizationFolder.reservationId } });
    await expect(revokeOperationsPortalNativeDeliveryAuthority(operations, { operationId: id(),
      authorityId: organizationAuthorityId, expectedRevision: 1, reasonCode: "Close organization-wide proof",
      owner: owner() })).resolves.toMatchObject({ replayed: false, review: { state: "revoked", revision: 2 } });
    await expect(issueOperationsPortalNativeDeliveryAuthority(operations, { operationId: id(), authorityId: id(),
      recipientBindingId: activeHome.recipientBindingId!, folderReservationId: folder.reservationId, expectedRevision: 0,
      expectedCandidateFingerprint: "f".repeat(64), features: ["file.download"], expiresAt: future(1),
      reasonCode: "Stale reviewed selection", owner: owner() })).rejects.toThrow("candidate_stale");

    const deliveryOperationId = id(), deliveryAuthorityId = id();
    const originalAuthor = { ...owner(), verifiedUntil: new Date(Date.now() + 2_500).toISOString() };
    const delivery = await issueOperationsPortalNativeDeliveryAuthority(operations, { operationId: deliveryOperationId,
      authorityId: deliveryAuthorityId, recipientBindingId: activeHome.recipientBindingId!,
      folderReservationId: folder.reservationId, expectedRevision: 0,
      expectedCandidateFingerprint: reviewedCandidate.candidateFingerprint,
      features: ["folder.list", "file.metadata", "file.preview", "file.download"], expiresAt: future(1),
      reasonCode: "Owner approved exact selected folder", owner: originalAuthor });
    expect(delivery).toMatchObject({ replayed: false,
      review: { state: "active", revision: 1, recipientLabel: "recipient@example.test" } });
    const deliveryBinding: OperationsPortalNativeDeliveryAuthorityBinding = {
      getNativeDeliveryAuthorityStatus: async () => JSON.stringify({ ok: false, protocolVersion: 1,
        code: "not_found", retryable: false }),
      applyNativeDeliveryAuthority: async wireJson => {
        const command = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(wireJson));
        if (!command) throw new Error("invalid delivery wire");
        const fingerprint = await operations.prepare(`SELECT request_fingerprint FROM
          operations_portal_native_delivery_authority_outbox WHERE operation_id=?`)
          .bind(command.operationId).first<string>("request_fingerprint");
        return JSON.stringify({ ok: true, protocolVersion: 1, receipt: {
          protocol: command.protocol, protocolVersion: 1, status: "recorded", operationId: command.operationId,
          requestFingerprint: fingerprint, action: command.action, authorityId: command.authority.authorityId,
          recipientBindingId: command.recipient.recipientBindingId,
          folderReservationId: command.resource.folderReservationId,
          resultingRevision: command.authority.resultingRevision,
          resultingState: command.action === "delivery.grant" ? "active" : "revoked" } });
      },
    };
    const staleInvocationId = id(), recoveryInvocationId = id(), competingInvocationId = id();
    await reserveOperationsPortalNativeDeliveryRecoveryInvocation(operations, { invocationId: staleInvocationId,
      operationId: deliveryOperationId, authorityId: deliveryAuthorityId, expectedRevision: 1,
      reason: "Original manager began recovery", owner: originalAuthor });
    await new Promise(resolve => setTimeout(resolve, 2_700));
    await reserveOperationsPortalNativeDeliveryRecoveryInvocation(operations, { invocationId: recoveryInvocationId,
      operationId: deliveryOperationId, authorityId: deliveryAuthorityId, expectedRevision: 1,
      reason: "Fresh manager recovers exact pending grant", owner: recoveryOwner() });
    await reserveOperationsPortalNativeDeliveryRecoveryInvocation(operations, { invocationId: competingInvocationId,
      operationId: deliveryOperationId, authorityId: deliveryAuthorityId, expectedRevision: 1,
      reason: "Second concurrent exact recovery", owner: recoveryOwner() });
    const boundedInvocations = [];
    for (let index = 0; index < 5; index += 1) {
      const invocationId = id(); boundedInvocations.push(invocationId);
      await reserveOperationsPortalNativeDeliveryRecoveryInvocation(operations, { invocationId,
        operationId: deliveryOperationId, authorityId: deliveryAuthorityId, expectedRevision: 1,
        reason: `Bounded alternate recovery ${index + 1}`, owner: recoveryOwner() });
    }
    await expect(reserveOperationsPortalNativeDeliveryRecoveryInvocation(operations, { invocationId: id(),
      operationId: deliveryOperationId, authorityId: deliveryAuthorityId, expectedRevision: 1,
      reason: "Ninth recovery must be refused", owner: recoveryOwner() })).rejects.toThrow("invocation_denied");
    await expect(reserveOperationsPortalNativeDeliveryRecoveryInvocation(operations, { invocationId: boundedInvocations[0]!,
      operationId: deliveryOperationId, authorityId: deliveryAuthorityId, expectedRevision: 1,
      reason: "Bounded alternate recovery 1", owner: recoveryOwner() })).resolves.toMatchObject({ replayed: true });
    await expect(reserveOperationsPortalNativeDeliveryRecoveryInvocation(operations, { invocationId: recoveryInvocationId,
      operationId: deliveryOperationId, authorityId: deliveryAuthorityId, expectedRevision: 1,
      reason: "Changed frozen recovery body", owner: recoveryOwner() })).rejects.toThrow("invocation_denied");
    const applySpy = vi.spyOn(deliveryBinding, "applyNativeDeliveryAuthority");
    const races = await Promise.all([
      dispatchNextOperationsPortalNativeDeliveryAuthority({ database: operations, binding: deliveryBinding,
        operationId: deliveryOperationId, recoveryInvocationId }),
      dispatchNextOperationsPortalNativeDeliveryAuthority({ database: operations, binding: deliveryBinding,
        operationId: deliveryOperationId, recoveryInvocationId: competingInvocationId }),
    ]);
    expect(races).toContainEqual({ operationId: deliveryOperationId, state: "acknowledged" });
    expect(applySpy).toHaveBeenCalledTimes(1);
    const invocations = await operations.prepare(`SELECT invocation_id,state FROM
      operations_portal_native_delivery_recovery_invocations WHERE operation_id=? ORDER BY invocation_id`)
      .bind(deliveryOperationId).all<{ invocation_id: string; state: string }>();
    expect(invocations.results.filter(row => row.state === "claimed")).toHaveLength(1);
    expect(invocations.results.filter(row => row.state === "authorized")).toHaveLength(7);
    const claimedInvocation = invocations.results.find(row => row.state === "claimed")!;
    await expect(claimOperationsPortalNativeDeliveryRecoveryInvocation(operations.withSession("first-primary"), {
      invocationId: claimedInvocation.invocation_id, operationId: deliveryOperationId, claimToken: id() }))
      .resolves.toBe(false);
    expect(await operations.prepare(`SELECT count(*) count FROM
      operations_portal_native_delivery_recovery_invocation_audit WHERE operation_id=?`)
      .bind(deliveryOperationId).first<number>("count")).toBe(1);
    const authorizedInvocation = invocations.results.find(row => row.state === "authorized")!;
    await expect(operations.prepare(`UPDATE operations_portal_native_delivery_recovery_invocations
      SET invocation_id=? WHERE invocation_id=?`).bind(id(), authorizedInvocation.invocation_id).run())
      .rejects.toThrow("claim denied");
    await expect(operations.prepare(`DELETE FROM operations_portal_native_delivery_recovery_invocation_audit
      WHERE invocation_id=?`).bind(claimedInvocation.invocation_id).run()).rejects.toThrow("durable");
    const wireJson = await operations.prepare(`SELECT canonical_wire_json FROM
      operations_portal_native_delivery_authority_outbox WHERE operation_id=?`)
      .bind(deliveryOperationId).first<string>("canonical_wire_json");
    const command = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(wireJson!))!;
    const request = deliveryReadRequest(command);
    await expect(readOperationsPortalNativeDeliveryAuthorization(operations, request)).resolves.toMatchObject({
      authorityId: deliveryAuthorityId, recipientBindingId: activeHome.recipientBindingId,
      folderReservationId: folder.reservationId, selectedR2Prefix: folder.selectedR2Prefix });
    for (const forged of [{ ...request, subject: "access|wrong-person" }, { ...request, folderReservationId: id() },
      { ...request, opsDivisionId: "wrong-division" }, { ...request, targetRevision: 2 },
      { ...request, homeOwnershipEpoch: 2 }]) {
      await expect(readOperationsPortalNativeDeliveryAuthorization(operations, forged))
        .rejects.toThrow("authorization_denied");
    }

    await operations.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES('native-delivery-create-deny','native-delivery-owner','delivery.share.create','deny','division',?,?,
        'native-delivery-owner')`).bind(division, division).run();
    await expect(issueOperationsPortalNativeDeliveryAuthority(operations, { operationId: id(),
      authorityId: deliveryAuthorityId, recipientBindingId: activeHome.recipientBindingId!,
      folderReservationId: folder.reservationId, expectedRevision: 1, features: ["file.download"],
      expiresAt: future(1), reasonCode: "Denied renewal", owner: owner() }))
      .rejects.toThrow("authority_denied");
    await operations.prepare("DELETE FROM staff_permission_overrides WHERE id='native-delivery-create-deny'").run();

    const forgedOperation = id(), forgedCanonical = JSON.stringify({ protocol: command.protocol, protocolVersion: 1,
      permissionSchemaVersion: 3, action: "delivery.revoke", operationId: forgedOperation,
      authority: { authorityId: deliveryAuthorityId, expectedRevision: "1", resultingRevision: "2" } });
    await expect(operations.prepare(`INSERT INTO operations_portal_native_delivery_authority_commands
      (operation_id,command_sha256,operation_fingerprint,canonical_command_json,action,authority_id,expected_revision,
       resulting_revision,target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
       recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,home_ownership_epoch,
       home_grant_revision,home_grant_operation_id,home_request_fingerprint,publication_operation_id,publication_id,
       publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
       folder_reservation_id,folder_reservation_revision,client_folder_binding_id,external_project_id,project_version,
       ops_folder_project_id,ops_division_id,selected_r2_prefix,base_r2_prefix,base_match_method,base_confirmed_by,
       base_confirmed_at,features_json,expires_at,reason_code,observed_at)
      SELECT ?,?,?,?,'delivery.revoke',authority_id,resulting_revision,resulting_revision+1,target_id,target_revision,
       client_authority_id,workspace_id,root_kind,root_record_id,recipient_binding_id,enrollment_intent_id,
       target_client_record_id,issuer,subject,home_ownership_epoch,home_grant_revision,home_grant_operation_id,
       home_request_fingerprint,publication_operation_id,publication_id,publication_revision,publication_source_sequence,
       publication_snapshot_id,publication_snapshot_sha256,folder_reservation_id,folder_reservation_revision,
       client_folder_binding_id,external_project_id,project_version,ops_folder_project_id,ops_division_id,
       selected_r2_prefix||'retarget/',base_r2_prefix,base_match_method,base_confirmed_by,base_confirmed_at,
       '[]',NULL,'forged historical retarget',strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM operations_portal_native_delivery_authority_commands WHERE operation_id=?`)
      .bind(forgedOperation, "c".repeat(64), "d".repeat(64), forgedCanonical, deliveryOperationId).run())
      .rejects.toThrow("revision denied");

    const revokeOperationId = id();
    await expect(revokeOperationsPortalNativeDeliveryAuthority(operations, { operationId: revokeOperationId,
      authorityId: deliveryAuthorityId, expectedRevision: 1, reasonCode: "Remove exact selected folder", owner: owner() }))
      .resolves.toMatchObject({ replayed: false, review: { state: "revoked", revision: 2 } });
    await expect(readOperationsPortalNativeDeliveryAuthorization(operations, request))
      .rejects.toThrow("authorization_denied");
    expect(await operations.prepare(`SELECT state FROM operations_portal_native_delivery_authority_outbox
      WHERE operation_id=?`).bind(revokeOperationId).first("state")).toBe("pending");
  });

  it("keeps the forward folder guard executable and rejects a literal-prefix mismatch", async () => {
    const guards = await operations.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND tbl_name='operations_portal_native_delivery_authority_commands'
      AND sql LIKE 'CREATE TRIGGER%BEFORE INSERT%'`).all<{ name: string }>();
    for (const guard of guards.results) {
      if (guard.name === "operations_portal_native_delivery_grant_folder_guard") continue;
      expect(guard.name).toMatch(/^operations_portal_native_delivery_[a-z0-9_]+$/u);
      await operations.prepare(`DROP TRIGGER ${guard.name}`).run();
    }
    const sourceOperationId = await operations.prepare(`SELECT operation_id FROM
      operations_portal_native_delivery_authority_commands WHERE action='delivery.grant' ORDER BY created_at LIMIT 1`)
      .first<string>("operation_id");
    expect(sourceOperationId).toBeTruthy();
    const operationId = id(), authorityId = id();
    await expect(operations.prepare(`INSERT INTO operations_portal_native_delivery_authority_commands
      (operation_id,command_sha256,operation_fingerprint,canonical_command_json,action,authority_id,expected_revision,
       resulting_revision,target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
       recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,home_ownership_epoch,
       home_grant_revision,home_grant_operation_id,home_request_fingerprint,publication_operation_id,publication_id,
       publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
       folder_reservation_id,folder_reservation_revision,client_folder_binding_id,external_project_id,project_version,
       ops_folder_project_id,ops_division_id,selected_r2_prefix,base_r2_prefix,base_match_method,base_confirmed_by,
       base_confirmed_at,features_json,expires_at,reason_code,observed_at)
      SELECT ?,?, ?,json_set(canonical_command_json,'$.operationId',?,'$.authority.authorityId',?),
       action,?,expected_revision,resulting_revision,target_id,target_revision,client_authority_id,workspace_id,
       root_kind,root_record_id,recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,
       home_ownership_epoch,home_grant_revision,home_grant_operation_id,home_request_fingerprint,
       publication_operation_id,publication_id,publication_revision,publication_source_sequence,
       publication_snapshot_id,publication_snapshot_sha256,folder_reservation_id,folder_reservation_revision,
       client_folder_binding_id,external_project_id,project_version,ops_folder_project_id,ops_division_id,
       upper(selected_r2_prefix),base_r2_prefix,base_match_method,base_confirmed_by,base_confirmed_at,
       features_json,expires_at,'literal prefix mismatch',observed_at
      FROM operations_portal_native_delivery_authority_commands WHERE operation_id=?`)
      .bind(operationId, "a".repeat(64), "b".repeat(64), operationId, authorityId, authorityId, sourceOperationId).run())
      .rejects.toThrow("operations portal native delivery current folder denied");
  });
}, 300_000);
