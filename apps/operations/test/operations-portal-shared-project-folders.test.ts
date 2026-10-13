import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { applyReviewedOperationsMigrationChain } from "./helpers/apply-reviewed-operations-migration-chain";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";
import { reserveOperationsPortalFolder, reserveOperationsPortalWorkspace } from "../src/worker/operations-portal-workspace-reservations";
import { confirmOperationsPortalSharedProjectFolder, lookupOperationsPortalSharedProjectFolder,
  type ConfirmOperationsPortalSharedProjectFolder, type OperationsPortalSharedProjectFolderAssociation }
  from "../src/worker/operations-portal-shared-project-folders";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

const staffId = "native-folder-owner";
const rootRecordId = "ops/organization/native-folder-root";
const otherRootRecordId = "ops/organization/native-folder-other-root";
const workspaceTargetId = "a0000000-0000-4000-8000-000000000001";
const workspaceId = "native-folder-workspace";
const divisionA = "native-folder-division-a";
const divisionB = "native-folder-division-b";
const sourceInstanceUUID = "a1111111-1111-4111-8111-111111111111";
const applicationUUID = "a2222222-2222-4222-8222-222222222222";
const historyEpoch = "a3333333-3333-4333-8333-333333333333";
let sequence = 10;
const uid = () => `a0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;

let runtime: Miniflare;
let db: D1Database;

function actor(overrides: Partial<AuthenticatedNativeStaffWithAdmissionVersion> = {}): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId, verifiedAccessSubject: `access|${staffId}`,
    email: `${staffId}@example.test`, displayName: "Native Folder Owner", profileVersion: 1 }, admissionVersion: 1,
    verifiedUntil: new Date(Date.now() + 3_600_000).toISOString(), ...overrides };
}

async function seedOwner() {
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
      .bind(staffId, `${staffId}@example.test`, "Native Folder Owner", `access|${staffId}`),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(staffId, `access|${staffId}`, staffId),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(staffId, `${staffId}@example.test`, "Native Folder Owner"),
    db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES(?,?,'role-owner','global',NULL,'global',?)`).bind(`${staffId}-owner`, staffId, staffId),
    ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link"].map((permission, index) =>
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?,?,?,'allow','global',1,?)`).bind(`${staffId}-native-${index}`, staffId, permission, staffId)),
    ...["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"].map((permission, index) =>
      db.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,?,?,'allow','global',NULL,'global',?)`).bind(`${staffId}-ops-${index}`, staffId, permission, staffId)),
  ]);
}

async function seedRoot(recordId = rootRecordId, organizationName = "Native Folder Organization") {
  const createAdmissionId = `admission-${uid()}`;
  const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID, applicationUUID, historyEpoch,
    origin: "https://pa.example.test", externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" };
  const scopes = [{ businessAreaId: "native-folder-area", divisionId: "native-folder-directory-division" }];
  const profile = { name: organizationName, generalEmail: "native-folder@example.test", generalPhone: "",
    addressLine1: "1 Native Way", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
  await db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId, staffId, `access|${staffId}`, recordId, "organization",
      JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ ...destination, expectedAuthorizationGeneration: undefined }]),
      staffId).run();
  const write = { operation: "create", mutationId: uid(), createAdmissionId, recordId,
    expectedLocalVersion: 0, kind: "organization", profile, scopes, destinations: [destination], actor: {
      staffId, accessSubject: `access|${staffId}`, loginEmail: `${staffId}@example.test`, admissionVersion: 1,
      profileVersion: 1, selectedGrantId: `${staffId}-native-1`, selectedIdentityGrantId: `${staffId}-native-2`,
    } } as NativeDirectoryCreateWrite;
  const outcome = await writeNativeDirectoryProfile(db, write);
  expect(outcome).toMatchObject({ status: "written", version: 1 });
}

async function seedProject(externalProjectId: string, organizationRecordId = rootRecordId) {
  await db.batch([
    db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,organization_record_id,scopes_json)
      VALUES(?,'Native shared project','active',?,'[]')`).bind(externalProjectId, organizationRecordId),
    db.prepare("INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json) VALUES(?,1,'{}')")
      .bind(externalProjectId),
  ]);
}

function confirmation(externalProjectId: string, prefix: string, expectedAssociation: OperationsPortalSharedProjectFolderAssociation | null = null,
  opsDivisionId = divisionA): ConfirmOperationsPortalSharedProjectFolder {
  return { targetId: workspaceTargetId, externalProjectId, expectedProjectVersion: 1, expectedAssociation,
    opsDivisionId, baseR2Prefix: prefix };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID() } });
  db = await runtime.getD1Database("OPS_DB");
  const migrationNames = await applyReviewedOperationsMigrationChain(db);
  expect(migrationNames).toHaveLength(187);
  expect(migrationNames.at(-1)).toBe("0187_operations_portal_native_delivery_literal_prefix_guard.sql");
  const migrationLedger = await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{ name: string }>();
  expect(migrationLedger.results.map(row => row.name)).toEqual(migrationNames);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  await db.batch([
    db.prepare("INSERT INTO divisions(id,name,code,active) VALUES(?,'Native folder A','NFA',1)").bind(divisionA),
    db.prepare("INSERT INTO divisions(id,name,code,active) VALUES(?,'Native folder B','NFB',1)").bind(divisionB),
    db.prepare("INSERT INTO divisions(id,name,code,active) VALUES('native-folder-inactive','Inactive','NFI',0)"),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('native-folder-area','Native folder area',1)"),
    db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
      VALUES('native-folder-directory-division','native-folder-area','Native folder directory division',1)`),
  ]);
  await seedOwner();
  await seedRoot();
  await seedRoot(otherRootRecordId, "Other Native Folder Organization");
  await reserveOperationsPortalWorkspace(db, actor(), { operationId: uid(), targetId: workspaceTargetId,
    clientAuthorityId: uid(), workspaceId, rootKind: "organization", rootRecordId, rootRecordVersion: 1,
    relationshipVersion: null, expectedRevision: 0, reason: "Native shared-project folder test workspace" });
}, 240_000);

afterAll(async () => { await runtime.dispose(); });

describe("native Operations shared-project folder confirmation", { timeout: 120_000, concurrent: false }, () => {
  it("looks up and confirms a native project without PA or legacy portal rows and preserves an exact no-op retry", async () => {
    const externalProjectId = "ops/project/native-folder-positive";
    const prefix = "projects/native-folder-positive/";
    await seedProject(externalProjectId);
    expect(await db.prepare("SELECT count(*) n FROM pa_projects").first("n")).toBe(0);
    const before = await lookupOperationsPortalSharedProjectFolder(db, actor(), { targetId: workspaceTargetId, externalProjectId });
    expect(before).toMatchObject({ externalProjectId, projectVersion: 1, association: null });

    const input = confirmation(externalProjectId, prefix);
    const first = await confirmOperationsPortalSharedProjectFolder(db, actor(), input);
    expect(first.association).toMatchObject({ opsFolderProjectId: externalProjectId, opsDivisionId: divisionA,
      baseR2Prefix: prefix, baseMatchMethod: "manual", baseConfirmedBy: staffId });
    const replay = await confirmOperationsPortalSharedProjectFolder(db, actor(), input);
    expect(replay).toEqual(first);
    expect(await db.prepare("SELECT count(*) n FROM project_folders WHERE project_id=?").bind(externalProjectId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM pa_projects").first("n")).toBe(0);
  });

  it("resolves project visibility against the associated division and honors matching denies", async () => {
    const projectA = "ops/project/native-folder-scope-a";
    const projectB = "ops/project/native-folder-scope-b";
    await seedProject(projectA);
    await seedProject(projectB);
    await confirmOperationsPortalSharedProjectFolder(db, actor(), confirmation(projectA, "projects/native-folder-scope-a/"));
    await confirmOperationsPortalSharedProjectFolder(db, actor(), confirmation(projectB, "projects/native-folder-scope-b/", null, divisionB));
    await db.prepare(`DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key='projects.view'
      AND effect='allow' AND scope='global'`).bind(staffId).run();
    await db.prepare("DELETE FROM role_permissions WHERE role_id='role-owner' AND permission_key='projects.view'").run();
    try {
      await db.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,?,'projects.view','allow','division',?,?,?)`).bind(uid(), staffId, divisionA, divisionA, staffId).run();
      await expect(lookupOperationsPortalSharedProjectFolder(db, actor(), {
        targetId: workspaceTargetId, externalProjectId: projectA,
      })).resolves.toMatchObject({ association: { opsDivisionId: divisionA } });
      await expect(lookupOperationsPortalSharedProjectFolder(db, actor(), {
        targetId: workspaceTargetId, externalProjectId: projectB,
      })).rejects.toThrow("operations_portal_shared_project_folder_denied");

      await db.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,?,'projects.view','deny','division',?,?,?)`).bind(uid(), staffId, divisionA, divisionA, staffId).run();
      await expect(lookupOperationsPortalSharedProjectFolder(db, actor(), {
        targetId: workspaceTargetId, externalProjectId: projectA,
      })).rejects.toThrow("operations_portal_shared_project_folder_denied");
    } finally {
      await db.prepare(`DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key='projects.view'
        AND scope='division'`).bind(staffId).run();
      await db.prepare(`INSERT OR IGNORE INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,?,'projects.view','allow','global',NULL,'global',?)`).bind(`${staffId}-ops-0`, staffId, staffId).run();
      await db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-owner','projects.view')").run();
    }
  });

  it("rejects a project owned by a different native directory root", async () => {
    const externalProjectId = "ops/project/native-folder-wrong-root";
    await seedProject(externalProjectId, otherRootRecordId);
    await expect(lookupOperationsPortalSharedProjectFolder(db, actor(), {
      targetId: workspaceTargetId, externalProjectId,
    })).rejects.toThrow("operations_portal_shared_project_folder_denied");
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(),
      confirmation(externalProjectId, "projects/native-folder-wrong-root/")))
      .rejects.toThrow("operations_portal_shared_project_folder_denied");
  });

  it("rejects malformed prefixes, stale project versions, expired actors, and explicit permission denies", async () => {
    const externalProjectId = "ops/project/native-folder-denials";
    await seedProject(externalProjectId);
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(), confirmation(externalProjectId, "projects//bad/")))
      .rejects.toThrow("operations_portal_shared_project_folder_invalid");
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(), { ...confirmation(externalProjectId, "projects/valid/"),
      expectedProjectVersion: 2 })).rejects.toThrow("operations_portal_shared_project_folder_denied");
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor({ verifiedUntil: new Date(Date.now() - 1_000).toISOString() }),
      confirmation(externalProjectId, "projects/valid/"))).rejects.toThrow("operations_portal_shared_project_folder_denied");

    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES(?,?,'delivery.share.create','deny','division',?,?,?)`).bind(uid(), staffId, divisionA, divisionA, staffId).run();
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(), confirmation(externalProjectId, "projects/valid/")))
      .rejects.toThrow("operations_portal_shared_project_folder_denied");
    await db.prepare(`DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key='delivery.share.create'
      AND effect='deny' AND division_id=?`).bind(staffId, divisionA).run();

    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(), confirmation(externalProjectId,
      "projects/inactive/", null, "native-folder-inactive"))).rejects.toThrow("operations_portal_shared_project_folder_denied");
    expect(await db.prepare("SELECT count(*) n FROM project_folders WHERE project_id=?").bind(externalProjectId).first("n")).toBe(0);
  });

  it("uses the complete prior proof, a monotonic confirmation token, and full old-division authority for moves", async () => {
    const externalProjectId = "ops/project/native-folder-cas";
    await seedProject(externalProjectId);
    const original = await confirmOperationsPortalSharedProjectFolder(db, actor(),
      confirmation(externalProjectId, "projects/native-folder-cas/"));
    const staleConfirmerProof = original.association!;
    await db.prepare("UPDATE project_folders SET confirmed_by='staging-operations-owner' WHERE project_id=?")
      .bind(externalProjectId).run();
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(),
      confirmation(externalProjectId, "projects/native-folder-moved/", staleConfirmerProof, divisionB)))
      .rejects.toThrow("operations_portal_shared_project_folder_conflict");

    const staleTimestampProof = (await lookupOperationsPortalSharedProjectFolder(db, actor(), {
      targetId: workspaceTargetId, externalProjectId })).association!;
    await db.prepare("UPDATE project_folders SET confirmed_at='2099-01-01T00:00:00.000Z' WHERE project_id=?")
      .bind(externalProjectId).run();
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(),
      confirmation(externalProjectId, "projects/native-folder-moved/", staleTimestampProof, divisionB)))
      .rejects.toThrow("operations_portal_shared_project_folder_conflict");

    const current = (await lookupOperationsPortalSharedProjectFolder(db, actor(), {
      targetId: workspaceTargetId, externalProjectId })).association!;
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES(?,?,'delivery.browse','deny','division',?,?,?)`).bind(uid(), staffId, divisionA, divisionA, staffId).run();
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(),
      confirmation(externalProjectId, "projects/native-folder-moved/", current, divisionB)))
      .rejects.toThrow("operations_portal_shared_project_folder_denied");
    await db.prepare(`DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key='delivery.browse'
      AND effect='deny' AND division_id=?`).bind(staffId, divisionA).run();

    const moveInput = confirmation(externalProjectId, "projects/native-folder-moved/", current, divisionB);
    const moved = await confirmOperationsPortalSharedProjectFolder(db, actor(), moveInput);
    expect(await confirmOperationsPortalSharedProjectFolder(db, actor(), moveInput)).toEqual(moved);
    const movedBack = await confirmOperationsPortalSharedProjectFolder(db, actor(),
      confirmation(externalProjectId, current.baseR2Prefix, moved.association!, divisionA));
    expect(movedBack.association).toMatchObject({ opsDivisionId: divisionA, baseR2Prefix: current.baseR2Prefix });
    expect(movedBack.association!.baseConfirmedAt).not.toBe(current.baseConfirmedAt);
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(),
      confirmation(externalProjectId, "projects/native-folder-aba/", current, divisionB)))
      .rejects.toThrow("operations_portal_shared_project_folder_conflict");
  });

  it("leaves the reservation trigger as the final fence against moving an active published base", async () => {
    const externalProjectId = "ops/project/native-folder-reserved";
    const prefix = "projects/native-folder-reserved/";
    await seedProject(externalProjectId);
    const confirmed = await confirmOperationsPortalSharedProjectFolder(db, actor(), confirmation(externalProjectId, prefix));
    const proof = confirmed.association!;
    await reserveOperationsPortalFolder(db, actor(), { operationId: uid(), targetId: workspaceTargetId,
      reservationId: uid(), expectedRevision: 0, expectedWorkspaceRevision: 1, externalProjectId,
      projectVersion: confirmed.projectVersion, opsFolderProjectId: proof.opsFolderProjectId,
      opsDivisionId: proof.opsDivisionId, baseR2Prefix: proof.baseR2Prefix, baseMatchMethod: proof.baseMatchMethod,
      baseConfirmedBy: proof.baseConfirmedBy, baseConfirmedAt: proof.baseConfirmedAt,
      clientFolderBindingId: `binding:${externalProjectId}`, selectedR2Prefix: prefix,
      reason: "Pin confirmed native base" });
    await expect(confirmOperationsPortalSharedProjectFolder(db, actor(),
      confirmation(externalProjectId, "projects/native-folder-reserved-moved/", proof, divisionB)))
      .rejects.toThrow("operations_portal_shared_project_folder_conflict");
    expect(await db.prepare("SELECT r2_prefix FROM project_folders WHERE project_id=?").bind(externalProjectId).first("r2_prefix"))
      .toBe(prefix);
  });
});
