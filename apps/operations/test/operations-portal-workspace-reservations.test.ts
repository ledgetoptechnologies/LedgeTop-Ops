import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { applyCanonicalChain, applyCanonicalMigrationSchema } from "./helpers/verified-recipient-canonical-lineage";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite,
  type NativeDirectoryProfileWriteOutcome } from "../src/worker/native-directory-profile-writer";
import { writeNativeDirectoryRelationship } from "../src/worker/native-directory-relationship-writer";
import { reserveOperationsPortalFolder, reserveOperationsPortalWorkspace, revokeOperationsPortalFolder,
  revokeOperationsPortalWorkspace } from "../src/worker/operations-portal-workspace-reservations";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

let runtime: Miniflare;
let db: D1Database;
let sequence = 1;
const uid = () => `90000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const org = "ops/organization/native-portal-root";
const division = "ops-portal-division";
const project = "ops/project-native-without-pa-mapping";
const physicalProject = "ops/physical-project-native-portal";
const base = "clients/native-root/project/";
const sourceInstanceUUID = "11111111-1111-4111-8111-111111111111";
const applicationUUID = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
let organizationSeed: Awaited<ReturnType<typeof seedRecord>>;
let organizationPublicId: string;

function authority(staffId: string): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId, verifiedAccessSubject: `access|${staffId}`,
    email: `${staffId}@example.test`, displayName: staffId, profileVersion: 1 }, admissionVersion: 1,
    verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() };
}
async function seedManager(staffId: string, folderAction: "create" | "revoke" | "both") {
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
      .bind(staffId, `${staffId}@example.test`, staffId, `access|${staffId}`),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(staffId, `access|${staffId}`, staffId),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(staffId, `${staffId}@example.test`, staffId),
    db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES(?,?,'role-owner','global',NULL,'global',?)`).bind(`${staffId}-trusted-owner`, staffId, staffId),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.portal_access.manage','allow','global',1,?)`).bind(`${staffId}-portal`, staffId, staffId),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.profile.edit','allow','global',1,?)`).bind(`${staffId}-profile`, staffId, staffId),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.identity.link','allow','global',1,?)`).bind(`${staffId}-identity`, staffId, staffId),
    ...["projects.view", "delivery.browse",
      ...(folderAction === "both" ? ["delivery.share.create", "delivery.share.revoke"]
        : [`delivery.share.${folderAction}`])].map((permission, index) => db.prepare(`INSERT INTO staff_permission_overrides
          (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
          VALUES(?,?,?,'allow','global',NULL,'global',?)`).bind(`${staffId}-permission-${index}`, staffId, permission, staffId)),
  ]);
}
async function seedRecord(recordId: string, kind: "organization" | "client") {
  const mutationId = uid(), createAdmissionId = `admission-${uid()}`;
  const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID, applicationUUID,
    historyEpoch, origin: "https://pa.example.test", externalCanonicalId: recordId,
    expectedAuthorizationGeneration: "0" };
  const scopes = [{ businessAreaId: "portal-area", divisionId: "portal-native-division" }];
  const profile = kind === "organization"
    ? { name: "Native Organization", generalEmail: "native-org@example.test", generalPhone: "512-555-0100",
      addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" }
    : { name: "Native Client", email: "native-client@example.test", phone: "512-555-0101", clientType: "business" as const,
      addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
  await db.batch([
    db.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId, "portal-manager-a", "access|portal-manager-a", recordId, kind,
        JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ ...destination, expectedAuthorizationGeneration: undefined }]),
        "portal-manager-a"),
    ...(kind === "client" ? [db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id)
      VALUES(?,?)`).bind(createAdmissionId, recordId)] : []),
  ]);
  const write = { operation: "create", mutationId, createAdmissionId, recordId, expectedLocalVersion: 0, kind,
    profile, scopes, destinations: [destination], actor: { staffId: "portal-manager-a", accessSubject: "access|portal-manager-a",
      loginEmail: "portal-manager-a@example.test", admissionVersion: 1, profileVersion: 1,
      selectedGrantId: "portal-manager-a-profile", selectedIdentityGrantId: "portal-manager-a-identity" },
    ...(kind === "client" ? { relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } } : {})
  } as NativeDirectoryCreateWrite;
  const outcome = await writeNativeDirectoryProfile(db, write);
  expect(outcome).toMatchObject({ status: "written", version: 1 });
  return { write, outcome };
}
async function acknowledgeCreate(seed: Awaited<ReturnType<typeof seedRecord>>, publicId: string,
  authorizationGeneration = "1") {
  const outcome = seed.outcome;
  if (outcome.status !== "written") throw new Error(`seed write failed: ${outcome.reason}`);
  for (const commandId of outcome.commandIds) {
    await db.batch([
      db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='fixture',
        lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`).bind(commandId),
      db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,
        source_instance_id,application_id,history_epoch_id,command_id) VALUES(?,?,?,?,?,?,?,?)`).bind(
          seed.write.destinations[0]!.sourceId, seed.write.kind, seed.write.recordId, publicId,
          seed.write.destinations[0]!.sourceInstanceUUID, seed.write.destinations[0]!.applicationUUID,
          seed.write.destinations[0]!.historyEpoch, commandId),
      db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,
        lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(JSON.stringify({ status: "acknowledged",
          response: { requestId: commandId, replayed: false,
            sourceInstanceId: seed.write.destinations[0]!.sourceInstanceUUID,
            applicationId: seed.write.destinations[0]!.applicationUUID,
            historyEpoch: seed.write.destinations[0]!.historyEpoch, result: { resource: { type: seed.write.kind,
              id: seed.write.recordId, publicId, revision: "1" }, data: { publicId }, authorizationGeneration } } }), commandId),
    ]);
  }
  await db.prepare(`UPDATE operations_directory_intents SET state='acknowledged'
    WHERE mutation_id=? AND state='materialized'`).bind(seed.write.mutationId).run();
}
async function updateOrganizationProfile(seed: Awaited<ReturnType<typeof seedRecord>>, publicId: string) {
  const destination = { ...seed.write.destinations[0]!, expectedAuthorizationGeneration: "1" };
  const outcome: NativeDirectoryProfileWriteOutcome = await writeNativeDirectoryProfile(db, {
    operation: "update", mutationId: uid(), recordId: seed.write.recordId, expectedLocalVersion: 1,
    kind: "organization", profile: { ...(seed.write.profile as Extract<NativeDirectoryCreateWrite,
      { kind: "organization" }> ["profile"]), name: "Native Organization Updated" }, destinations: [destination],
    actor: seed.write.actor,
  });
  expect(outcome).toMatchObject({ status: "written", version: 2 });
  if (outcome.status !== "written") throw new Error(`profile update failed: ${outcome.reason}`);
  for (const commandId of outcome.commandIds) {
    await db.batch([
      db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='fixture-update',
        lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`).bind(commandId),
      db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,
        lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(JSON.stringify({ status: "acknowledged",
          response: { requestId: commandId, replayed: false, sourceInstanceId: destination.sourceInstanceUUID,
            applicationId: destination.applicationUUID, historyEpoch: destination.historyEpoch,
            result: { resource: { type: "organization", publicId, revision: "2" }, data: { publicId },
              authorizationGeneration: "1" } } }), commandId),
    ]);
  }
  await db.prepare(`UPDATE operations_directory_intents SET state='acknowledged'
    WHERE mutation_id=? AND state='materialized'`).bind(outcome.mutationId).run();
}
function workspaceCommand(rootRecordId = org) {
  return { operationId: uid(), targetId: uid(), clientAuthorityId: uid(), workspaceId: `workspace:${uid()}`,
    rootKind: "organization" as const, rootRecordId, rootRecordVersion: 1, relationshipVersion: null,
    expectedRevision: 0 as const, reason: "Explicit native workspace reservation" };
}
function folderCommand(targetId: string, reservationId = uid(), selectedR2Prefix = base) {
  return { operationId: uid(), targetId, reservationId, expectedRevision: 0 as const, expectedWorkspaceRevision: 1,
    externalProjectId: project, projectVersion: 1, opsFolderProjectId: physicalProject, opsDivisionId: division,
    baseR2Prefix: base, baseMatchMethod: "manual", baseConfirmedBy: "portal-manager-a",
    baseConfirmedAt: "2026-09-30 12:00:00", clientFolderBindingId: `client-folder:${reservationId}`,
    selectedR2Prefix, reason: "Explicit selected folder reservation" };
}
async function rawWorkspaceRevokeProbe(sourceOperationId: string, operationId: string, auditJson: string, verifiedUntil: string) {
  return db.prepare(`INSERT INTO operations_portal_workspace_reservation_commands(
    operation_id,operation_fingerprint,canonical_command_json,action,target_id,expected_revision,resulting_revision,
    client_authority_id,workspace_id,root_kind,root_record_id,root_record_version,relationship_version,reservation_id,
    workspace_revision,external_project_id,project_version,ops_folder_project_id,ops_division_id,base_r2_prefix,
    base_match_method,base_confirmed_by,base_confirmed_at,client_folder_binding_id,selected_r2_prefix,
    authorized_by_staff_id,authorized_access_subject,authorized_email,authorized_admission_version,
    authorized_profile_version,authorized_grant_generation,authorized_verified_until,reason)
    SELECT ?,'0000000000000000000000000000000000000000000000000000000000000000',?,'workspace.revoke',target_id,1,2,
      client_authority_id,workspace_id,root_kind,root_record_id,root_record_version,relationship_version,NULL,
      NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,authorized_by_staff_id,authorized_access_subject,
      authorized_email,authorized_admission_version,authorized_profile_version,authorized_grant_generation,?,
      'Raw audit probe' FROM operations_portal_workspace_reservation_commands WHERE operation_id=?`)
    .bind(operationId, auditJson, verifiedUntil, sourceOperationId).run();
}
async function rawWorkspaceHeadRevoke(targetId: string, operationId: string, staffId: string) {
  return db.prepare(`UPDATE operations_portal_workspace_reservation_heads SET revision=revision+1,state='revoked',
    latest_operation_id=?,revoked_by_staff_id=?,revoked_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE target_id=? AND revision=1 AND state='active'`).bind(operationId, staffId, operationId, targetId).run();
}
async function rawFolderReserveClone(sourceOperationId: string, operationId: string, reservationId: string,
  bindingId: string, selectedPrefix: string, auditJson: string) {
  return db.prepare(`INSERT INTO operations_portal_workspace_reservation_commands(
    operation_id,operation_fingerprint,canonical_command_json,action,target_id,expected_revision,resulting_revision,
    client_authority_id,workspace_id,root_kind,root_record_id,root_record_version,relationship_version,reservation_id,
    workspace_revision,external_project_id,project_version,ops_folder_project_id,ops_division_id,base_r2_prefix,
    base_match_method,base_confirmed_by,base_confirmed_at,client_folder_binding_id,selected_r2_prefix,
    authorized_by_staff_id,authorized_access_subject,authorized_email,authorized_admission_version,
    authorized_profile_version,authorized_grant_generation,authorized_verified_until,reason)
    SELECT ?,'1111111111111111111111111111111111111111111111111111111111111111',?,action,target_id,0,1,
      client_authority_id,workspace_id,root_kind,root_record_id,root_record_version,relationship_version,?,
      workspace_revision,external_project_id,project_version,ops_folder_project_id,ops_division_id,base_r2_prefix,
      base_match_method,base_confirmed_by,base_confirmed_at,?,?,authorized_by_staff_id,authorized_access_subject,
      authorized_email,authorized_admission_version,authorized_profile_version,authorized_grant_generation,
      authorized_verified_until,'Delayed commit probe' FROM operations_portal_workspace_reservation_commands
      WHERE operation_id=?`).bind(operationId, auditJson, reservationId, bindingId, selectedPrefix, sourceOperationId).run();
}
async function rawFolderHead(operationId: string) {
  return db.prepare(`INSERT INTO operations_portal_folder_reservation_heads(reservation_id,target_id,revision,state,
    latest_operation_id,pinned_workspace_revision,external_project_id,project_version,ops_folder_project_id,
    ops_division_id,base_r2_prefix,base_match_method,base_confirmed_by,base_confirmed_at,client_folder_binding_id,
    selected_r2_prefix,creation_operation_id,created_by_staff_id,created_access_subject,created_admission_version,
    created_profile_version,created_grant_generation)
    SELECT reservation_id,target_id,1,'active',operation_id,workspace_revision,external_project_id,project_version,
      ops_folder_project_id,ops_division_id,base_r2_prefix,base_match_method,base_confirmed_by,base_confirmed_at,
      client_folder_binding_id,selected_r2_prefix,operation_id,authorized_by_staff_id,authorized_access_subject,
      authorized_admission_version,authorized_profile_version,authorized_grant_generation
    FROM operations_portal_workspace_reservation_commands WHERE operation_id=?`).bind(operationId).run();
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID() } });
  db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  const migrations = await applyCanonicalChain(db, "operations", "0152_operations_portal_workspace_reservations.sql", true);
  expect(migrations).toHaveLength(152);
  // The current writer consumes the 0170 active-mapping projection (including
  // the distinct Ops record_id). Keep the historical authority fixture, but
  // install that exact current schema contract before exercising the writer.
  await applyCanonicalMigrationSchema(db, "0170_project_alpha_active_directory_project_guard.sql");
  // This is an explicit local proposal supplement, not canonical migration
  // 0182. It keeps the historical portal chain while exercising the current
  // normalized relationship-revision evidence contract used by the writer.
  const relationshipProposal = readFileSync(new URL(
    "../../../scripts/proposals/0182_project_alpha_directory_relationship_recovery_guard.sql", import.meta.url), "utf8");
  const revisionMarker = "DROP VIEW project_alpha_directory_relationship_revision_evidence;";
  const revisionOffset = relationshipProposal.indexOf(revisionMarker);
  if (revisionOffset < 0) throw new Error("missing proposal revision-evidence replacement");
  await db.batch(splitD1MigrationStatements(relationshipProposal.slice(revisionOffset)
    .replaceAll("operations_directory_effective_materializations", "operations_directory_materializations"))
    .map(statement => db.prepare(statement)));
  await seedManager("portal-manager-a", "both");
  await seedManager("portal-manager-b", "revoke");
  await db.batch([
    db.prepare("INSERT INTO divisions(id,name,code,active) VALUES(?, 'Portal Division','PORTAL-NATIVE',1)").bind(division),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('portal-area','Portal Area',1)"),
    db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('portal-native-division','portal-area','Portal Division',1)"),
  ]);
  organizationSeed = await seedRecord(org, "organization");
  organizationPublicId = "11111111111111111111111111111111";
  await acknowledgeCreate(organizationSeed, organizationPublicId);
  await db.batch([
    db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,organization_record_id,scopes_json)
      VALUES(?,'Native Project','active',?,'[]')`).bind(project, org),
    db.prepare("INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json) VALUES(?,1,'{}')").bind(project),
    db.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
      VALUES(?,?,?,?,?,?)`).bind(physicalProject, division, base, "manual", "portal-manager-a", "2026-09-30 12:00:00"),
  ]);
}, 240_000);
afterAll(async () => { await runtime.dispose(); });

describe("native Operations portal workspace reservations against the current Directory mapping view", () => {
  it("reserves an Ops root and native project folders atomically without PA, grants, links, or outbox writes", async () => {
    const actor = authority("portal-manager-a"), workspaceInput = workspaceCommand();
    const beforeGrants = await db.prepare("SELECT count(*) n FROM native_directory_grants").first<number>("n");
    const beforeOutbox = await db.prepare("SELECT count(*) n FROM verified_recipient_delivery_authority_outbox").first<number>("n");
    const reserved = await reserveOperationsPortalWorkspace(db, actor, workspaceInput);
    expect(reserved).toEqual({ operationId: workspaceInput.operationId, action: "workspace.reserve",
      targetId: workspaceInput.targetId, reservationId: null, revision: 1, state: "active", replayed: false });
    expect(await db.prepare("SELECT count(*) n FROM native_directory_grants").first("n"))
      .toBe(beforeGrants);
    await expect(reserveOperationsPortalWorkspace(db, actor, workspaceInput)).resolves.toEqual({ ...reserved, replayed: true });
    await expect(reserveOperationsPortalWorkspace(db, { ...actor, verifiedUntil: "not-a-time" }, workspaceInput))
      .rejects.toThrow("operations_portal_workspace_reservation_denied");
    await expect(reserveOperationsPortalWorkspace(db, { ...actor, admissionVersion: 2 }, workspaceInput))
      .rejects.toThrow("operations_portal_workspace_reservation_denied");
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.enrollment.manage','allow','global',1,?)`).bind("portal-manager-a-replay-rotation",
        "portal-manager-a", "portal-manager-a").run();
    await expect(reserveOperationsPortalWorkspace(db, actor, workspaceInput)).resolves.toEqual({ ...reserved, replayed: true });
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.portal_access.manage','deny','global',1,?)`).bind("portal-manager-a-replay-deny",
        "portal-manager-a", "portal-manager-a").run();
    await expect(reserveOperationsPortalWorkspace(db, actor, workspaceInput))
      .rejects.toThrow("operations_portal_workspace_reservation_denied");
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='portal-manager-a-replay-deny'").run();
    await expect(reserveOperationsPortalWorkspace(db, actor, workspaceInput)).resolves.toEqual({ ...reserved, replayed: true });
    await expect(reserveOperationsPortalWorkspace(db, actor, { ...workspaceInput, reason: "Changed request" }))
      .rejects.toThrow("operations_portal_workspace_reservation_denied");
    await updateOrganizationProfile(organizationSeed, organizationPublicId);
    expect(await db.prepare(`SELECT current_version FROM operations_directory_records WHERE record_id=?`)
      .bind(org).first("current_version")).toBe(2);
    expect(await db.prepare(`SELECT root_record_version FROM operations_portal_workspace_reservation_heads WHERE target_id=?`)
      .bind(workspaceInput.targetId).first("root_record_version")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM staff_role_assignments WHERE staff_id=? AND role_id='role-owner'")
      .bind("portal-manager-a").first("n")).toBe(1);

    const storedAudit = await db.prepare(`SELECT canonical_command_json json,authorized_verified_until verifiedUntil
      FROM operations_portal_workspace_reservation_commands WHERE operation_id=?`).bind(workspaceInput.operationId)
      .first<{ json: string; verifiedUntil: string }>();
    expect(storedAudit).toBeTruthy();
    const stored = JSON.parse(storedAudit!.json) as { actor: Record<string, unknown> };
    const rawRequest = { operationId: "", targetId: workspaceInput.targetId, expectedRevision: 1, reason: "Raw audit probe" };
    const malformed = [
      (operationId: string) => ({ actor: stored.actor, request: { ...rawRequest, operationId }, extra: 1 }),
      (operationId: string) => ({ action: "workspace.revoke", actor: { ...stored.actor, email: undefined, extra: 1 },
        request: { ...rawRequest, operationId } }),
      (operationId: string) => ({ action: "workspace.revoke", actor: stored.actor,
        request: { operationId, expectedRevision: 1, reason: "Raw audit probe", extra: 1 } }),
      (operationId: string) => ({ action: "workspace.revoke", actor: stored.actor,
        request: { ...rawRequest, operationId, reason: null } }),
    ];
    for (const value of malformed) {
      const operationId = uid();
      await expect(rawWorkspaceRevokeProbe(workspaceInput.operationId, operationId,
        JSON.stringify(value(operationId)), storedAudit!.verifiedUntil)).rejects.toThrow();
    }
    const malformedTime = "z".repeat(24), malformedTimeOperation = uid();
    await expect(rawWorkspaceRevokeProbe(workspaceInput.operationId, malformedTimeOperation, JSON.stringify({
      action: "workspace.revoke", actor: { ...stored.actor, verifiedUntil: malformedTime },
      request: { ...rawRequest, operationId: malformedTimeOperation },
    }), malformedTime)).rejects.toThrow();
    expect(await db.prepare(`SELECT count(*) n FROM operations_portal_workspace_reservation_commands
      WHERE operation_id<>?`).bind(workspaceInput.operationId).first("n")).toBe(0);

    const raceOrg = "ops/organization/delayed-workspace-revoke";
    const raceProject = "ops/project-delayed-workspace-revoke";
    const racePhysicalProject = "ops/physical-project-delayed-workspace-revoke";
    const raceBase = "clients/delayed-workspace-revoke/project/";
    await seedRecord(raceOrg, "organization");
    await db.batch([
      db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,organization_record_id,scopes_json)
        VALUES(?,'Delayed Revoke Project','active',?,'[]')`).bind(raceProject, raceOrg),
      db.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
        VALUES(?,1,'{}')`).bind(raceProject),
      db.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
        VALUES(?,?,?,?,?,?)`).bind(racePhysicalProject, division, raceBase, "manual", "portal-manager-a",
          "2026-09-30 12:00:00"),
    ]);
    const raceWorkspace = workspaceCommand(raceOrg);
    await reserveOperationsPortalWorkspace(db, actor, raceWorkspace);
    const raceStored = await db.prepare(`SELECT canonical_command_json json,authorized_verified_until verifiedUntil
      FROM operations_portal_workspace_reservation_commands WHERE operation_id=?`).bind(raceWorkspace.operationId)
      .first<{ json: string; verifiedUntil: string }>();
    const raceActor = (JSON.parse(raceStored!.json) as { actor: Record<string, unknown> }).actor;
    const delayedRevokeOperation = uid();
    await rawWorkspaceRevokeProbe(raceWorkspace.operationId, delayedRevokeOperation, JSON.stringify({
      action: "workspace.revoke", actor: raceActor, request: { operationId: delayedRevokeOperation,
        targetId: raceWorkspace.targetId, expectedRevision: 1, reason: "Raw audit probe" },
    }), raceStored!.verifiedUntil);
    const racedFolder = { ...folderCommand(raceWorkspace.targetId, uid(), raceBase), externalProjectId: raceProject,
      opsFolderProjectId: racePhysicalProject, baseR2Prefix: raceBase };
    await expect(reserveOperationsPortalFolder(db, actor, racedFolder)).resolves.toMatchObject({ state: "active" });
    await expect(rawWorkspaceHeadRevoke(raceWorkspace.targetId, delayedRevokeOperation, "portal-manager-a"))
      .rejects.toThrow(/workspace head update denied/);
    expect(await db.prepare(`SELECT state FROM operations_portal_workspace_reservation_heads WHERE target_id=?`)
      .bind(raceWorkspace.targetId).first("state")).toBe("active");
    expect(await db.prepare(`SELECT state FROM operations_portal_folder_reservation_heads WHERE reservation_id=?`)
      .bind(racedFolder.reservationId).first("state")).toBe("active");

    const deniedFolder = folderCommand(workspaceInput.targetId, uid(), `${base}denied/`);
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES(?,?,'delivery.share.create','deny','division',?,?,?)`).bind(uid(), "portal-manager-a", division, division, "portal-manager-a").run();
    await expect(reserveOperationsPortalFolder(db, actor, deniedFolder)).rejects.toThrow("operations_portal_workspace_reservation_denied");
    expect(await db.prepare("SELECT count(*) n FROM operations_portal_workspace_reservation_commands WHERE operation_id=?")
      .bind(deniedFolder.operationId).first("n")).toBe(0);
    await db.prepare(`DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key='delivery.share.create'
      AND effect='deny' AND scope='division' AND division_id=?`).bind("portal-manager-a", division).run();

    const parent = folderCommand(workspaceInput.targetId, uid(), base);
    const child = folderCommand(workspaceInput.targetId, uid(), `${base}photos/`);
    await expect(reserveOperationsPortalFolder(db, actor, parent)).resolves.toMatchObject({ state: "active", revision: 1 });
    await expect(reserveOperationsPortalFolder(db, actor, child)).resolves.toMatchObject({ state: "active", revision: 1 });
    expect(await db.prepare(`SELECT root_record_version FROM operations_portal_workspace_reservation_heads WHERE target_id=?`)
      .bind(workspaceInput.targetId).first("root_record_version")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_mappings WHERE external_project_id=?")
      .bind(project).first("n")).toBe(0);
    await expect(reserveOperationsPortalFolder(db, actor,
      folderCommand(workspaceInput.targetId, uid(), "clients/native-root/project-confusable/")))
      .rejects.toThrow("operations_portal_workspace_reservation_denied");
    await expect(reserveOperationsPortalFolder(db, actor, { ...folderCommand(workspaceInput.targetId),
      operationId: uid(), projectVersion: 2 })).rejects.toThrow("operations_portal_workspace_reservation_denied");

    await expect(db.prepare("UPDATE project_folders SET r2_prefix='clients/moved/' WHERE project_id=?")
      .bind(physicalProject).run()).rejects.toThrow(/active operations portal folder reservation blocks base change/);
    await expect(revokeOperationsPortalWorkspace(db, actor, { operationId: uid(), targetId: workspaceInput.targetId,
      expectedRevision: 1, reason: "Cannot revoke with active selected folders" }))
      .rejects.toThrow("operations_portal_workspace_reservation_denied");

    const managerB = authority("portal-manager-b");
    const revokeParent = { operationId: uid(), targetId: workspaceInput.targetId, reservationId: parent.reservationId,
      expectedRevision: 1, reason: "Cross-manager selected folder revocation" };
    await expect(revokeOperationsPortalFolder(db, managerB, revokeParent)).resolves.toMatchObject({ state: "revoked", revision: 2 });
    await expect(revokeOperationsPortalFolder(db, managerB, revokeParent)).resolves.toMatchObject({ replayed: true });
    await revokeOperationsPortalFolder(db, managerB, { ...revokeParent, operationId: uid(), reservationId: child.reservationId });
    const provenance = await db.prepare(`SELECT created_by_staff_id,revoked_by_staff_id,base_r2_prefix,selected_r2_prefix
      FROM operations_portal_folder_reservation_heads WHERE reservation_id=?`).bind(parent.reservationId).first();
    expect(provenance).toEqual({ created_by_staff_id: "portal-manager-a", revoked_by_staff_id: "portal-manager-b",
      base_r2_prefix: base, selected_r2_prefix: base });

    const sourceFolder = await db.prepare("SELECT canonical_command_json json FROM operations_portal_workspace_reservation_commands WHERE operation_id=?")
      .bind(parent.operationId).first<{ json: string }>();
    const rejectedPrefixOperation = uid(), rejectedPrefixReservation = uid();
    const rejectedPrefixAudit = JSON.parse(sourceFolder!.json) as { request: Record<string, unknown> };
    rejectedPrefixAudit.request = { ...rejectedPrefixAudit.request, operationId: rejectedPrefixOperation,
      reservationId: rejectedPrefixReservation, clientFolderBindingId: `client-folder:${rejectedPrefixReservation}`,
      selectedR2Prefix: `${base}_LTDS/`, reason: "Delayed commit probe" };
    await expect(rawFolderReserveClone(parent.operationId, rejectedPrefixOperation, rejectedPrefixReservation,
      `client-folder:${rejectedPrefixReservation}`, `${base}_LTDS/`, JSON.stringify(rejectedPrefixAudit)))
      .rejects.toThrow(/selected folder prefix is invalid/);
    const delayedOperation = uid(), delayedReservation = uid(), delayedBinding = `client-folder:${delayedReservation}`;
    const delayedAudit = JSON.parse(sourceFolder!.json) as { request: Record<string, unknown> };
    delayedAudit.request = { ...delayedAudit.request, operationId: delayedOperation, reservationId: delayedReservation,
      clientFolderBindingId: delayedBinding, selectedR2Prefix: `${base}delayed/`, reason: "Delayed commit probe" };
    await expect(rawFolderReserveClone(parent.operationId, delayedOperation, delayedReservation, delayedBinding,
      `${base}delayed/`, JSON.stringify(delayedAudit))).resolves.toBeTruthy();
    await db.prepare("DELETE FROM staff_role_assignments WHERE staff_id='portal-manager-a' AND role_id='role-owner'").run();
    await expect(rawFolderHead(delayedOperation)).rejects.toThrow(/folder head insert denied/);
    await db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES('portal-manager-a-trusted-owner-restored','portal-manager-a','role-owner','global',NULL,'global','portal-manager-a')`).run();
    await expect(db.prepare("UPDATE project_folders SET r2_prefix='clients/moved/' WHERE project_id=?")
      .bind(physicalProject).run()).resolves.toMatchObject({ meta: expect.objectContaining({ changes: 1 }) });
    await expect(rawFolderHead(delayedOperation)).rejects.toThrow(/folder head insert denied/);
    await db.prepare("UPDATE project_folders SET r2_prefix=? WHERE project_id=?").bind(base, physicalProject).run();

    const revoked = await revokeOperationsPortalWorkspace(db, managerB, { operationId: uid(), targetId: workspaceInput.targetId,
      expectedRevision: 1, reason: "Cross-manager workspace revocation" });
    expect(revoked).toMatchObject({ state: "revoked", revision: 2 });
    expect(await db.prepare("SELECT created_by_staff_id FROM operations_portal_workspace_reservation_heads WHERE target_id=?")
      .bind(workspaceInput.targetId).first("created_by_staff_id")).toBe("portal-manager-a");
    expect(await db.prepare("SELECT count(*) n FROM verified_recipient_delivery_authority_outbox").first("n"))
      .toBe(beforeOutbox);
  }, 120_000);

  it("accepts a current explicit NULL-parent standalone client and rejects stale relationship pins", async () => {
    const actor = authority("portal-manager-a"), client = "ops/client/service-enrollment-full-chain";
    const clientSeed = await seedRecord(client, "client");
    await acknowledgeCreate(clientSeed, "22222222222222222222222222222222");
    const standaloneProject = "ops/project-native-standalone", standalonePhysical = "ops/physical-project-standalone";
    const standaloneBase = "clients/standalone/project/";
    await db.batch([
      db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,client_record_id,scopes_json)
        VALUES(?,'Standalone Native Project','active',?,'[]')`).bind(standaloneProject, client),
      db.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json)
        VALUES(?,1,'{}')`).bind(standaloneProject),
      db.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at)
        VALUES(?,?,?,?,?,?)`).bind(standalonePhysical, division, standaloneBase, "manual", "portal-manager-a",
          "2026-09-30 12:00:00"),
    ]);
    const command = { ...workspaceCommand(client), rootKind: "standalone_client" as const, relationshipVersion: 1 };
    const expiringActor = { ...actor, verifiedUntil: new Date(Date.now() + 1_000).toISOString() };
    const reserved = await reserveOperationsPortalWorkspace(db, expiringActor, command);
    expect(reserved).toMatchObject({ state: "active", revision: 1, replayed: false });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const historicalVerifiedUntil = await db.prepare(`SELECT authorized_verified_until
      FROM operations_portal_workspace_reservation_commands WHERE operation_id=?`).bind(command.operationId)
      .first<string>("authorized_verified_until");
    expect(historicalVerifiedUntil).not.toBeNull();
    expect(new Date(historicalVerifiedUntil!).getTime())
      .toBeLessThanOrEqual(Date.now());
    await expect(reserveOperationsPortalWorkspace(db, authority("portal-manager-a"), command))
      .resolves.toEqual({ ...reserved, replayed: true });
    await expect(reserveOperationsPortalWorkspace(db, { ...authority("portal-manager-a"),
      verifiedUntil: new Date(Date.now() - 1_000).toISOString() }, command))
      .rejects.toThrow("operations_portal_workspace_reservation_denied");
    await expect(reserveOperationsPortalWorkspace(db, actor, { ...workspaceCommand(client), relationshipVersion: 2,
      rootKind: "standalone_client" as const })).rejects.toThrow("operations_portal_workspace_reservation_denied");

    const activeFolder = { ...folderCommand(command.targetId, uid(), standaloneBase), externalProjectId: standaloneProject,
      opsFolderProjectId: standalonePhysical, baseR2Prefix: standaloneBase };
    await expect(reserveOperationsPortalFolder(db, authority("portal-manager-a"), activeFolder))
      .resolves.toMatchObject({ state: "active", revision: 1 });
    const linked = await writeNativeDirectoryRelationship(db, { mutationId: uid(), clientRecordId: client,
      expectedRelationshipVersion: 1, expectedClientRecordVersion: 1, previousOrganization: null,
      organization: { recordId: org, expectedRecordVersion: 2 }, actor: { staffId: "portal-manager-a",
        accessSubject: "access|portal-manager-a", email: "portal-manager-a@example.test", admissionVersion: 1,
        profileVersion: 1 } });
    expect(linked).toMatchObject({ status: "written", relationshipVersion: 2 });
    const blockedFolder = { ...folderCommand(command.targetId, uid(), `${standaloneBase}blocked/`),
      externalProjectId: standaloneProject, opsFolderProjectId: standalonePhysical, baseR2Prefix: standaloneBase };
    await expect(reserveOperationsPortalFolder(db, authority("portal-manager-a"), blockedFolder))
      .rejects.toThrow("operations_portal_workspace_reservation_denied");
    const cleanupActor = authority("portal-manager-b");
    await expect(revokeOperationsPortalFolder(db, cleanupActor, { operationId: uid(), targetId: command.targetId,
      reservationId: activeFolder.reservationId, expectedRevision: 1, reason: "Cleanup after standalone topology drift" }))
      .resolves.toMatchObject({ state: "revoked", revision: 2 });
    await expect(revokeOperationsPortalWorkspace(db, cleanupActor, { operationId: uid(), targetId: command.targetId,
      expectedRevision: 1, reason: "Cleanup workspace after standalone topology drift" }))
      .resolves.toMatchObject({ state: "revoked", revision: 2 });
    expect(await db.prepare(`SELECT root_record_version,relationship_version,created_by_staff_id,revoked_by_staff_id
      FROM operations_portal_workspace_reservation_heads WHERE target_id=?`).bind(command.targetId).first())
      .toEqual({ root_record_version: 1, relationship_version: 1, created_by_staff_id: "portal-manager-a",
        revoked_by_staff_id: "portal-manager-b" });
  }, 120_000);
});
