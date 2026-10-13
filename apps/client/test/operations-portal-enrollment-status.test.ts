import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { writeClientAuthorityWorkspaceBinding } from "../src/worker/client-authority-workspace-binding";
import { writeClientPortalAuthorityV2 } from "../src/worker/client-portal-authority-v2";
import { readOperationsPortalEnrollmentStatus } from "../src/worker/client-portal/operations-portal-enrollment-status";

describe("Operations portal enrollment status reader", () => {
  let mf: Miniflare;
  let db: D1Database;
  const authorityId = "22222222-2222-4222-8222-222222222222";
  const workspaceId = "workspace-a";
  const bindingOperationId = "bind-1";
  const principal = { issuer: "https://access.example.test", subject: "person-1", email: "same@example.test" };
  const env = (enabled = "true") => ({ DELIVERY_DB: db, CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED: enabled,
    CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED: "true" });
  const command = (operationId: string, desiredState: "active" | "revoked" = "active", expectedGrantRevision = 0) => ({
    operationId, clientAuthorityId: authorityId, workspaceId, bindingOperationId, issuer: principal.issuer, subject: principal.subject,
    desiredState, expectedOwnershipEpoch: desiredState === "active" && expectedGrantRevision === 0 ? 0 : 1,
    expectedGrantRevision, scopes: [] as [],
  });

  beforeEach(async () => {
    mf = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default {}", d1Databases: { DELIVERY_DB: crypto.randomUUID() } });
    db = await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const root = "a".repeat(32);
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT,status TEXT NOT NULL)"),
      db.prepare("CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT)"),
      db.prepare("CREATE TABLE portal_v2_entitlements(workspace_id TEXT,identity_id TEXT,status TEXT)"),
      db.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT)"),
      db.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,projection_source_id TEXT,workspace_root_type TEXT,workspace_root_public_id TEXT)"),
      db.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT,source_sequence INTEGER,snapshot_generation_id TEXT)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES(?, 'organization', ?, NULL, 'project-alpha:east', 'active')").bind(workspaceId, root),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,'project-alpha:east','source-a')").bind(workspaceId),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-1',?,'generation-1',1,'project-alpha:east','organization',?)").bind(workspaceId, root),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES(?,'generation-1',1,'snapshot-1')").bind(workspaceId),
      db.prepare("INSERT INTO portal_v2_workspace_memberships VALUES(?, 'legacy-identity', 'active')").bind(workspaceId),
      db.prepare("INSERT INTO portal_v2_entitlements VALUES(?, 'legacy-identity', 'active')").bind(workspaceId),
    ]);
    for (const migration of ["0216_client_authority_workspace_ownership_claim.sql", "0217_client_authority_workspace_claim_evidence.sql", "0218_client_authority_workspace_binding.sql", "0219_operations_portal_authority_v2.sql", "0220_operations_portal_authority_v3_permissions.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    }
    await writeClientAuthorityWorkspaceBinding({ DELIVERY_DB: db, CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED: "true" }, {
      operationId: bindingOperationId, clientAuthorityId: authorityId, workspaceId, projectionSourceId: "project-alpha:east",
      sourceWorkspaceId: "source-a", rootType: "organization", rootPublicId: root,
      expectedCheckpoint: { sourceGeneration: "generation-1", sourceSequence: 1, snapshotGenerationId: "snapshot-1" },
    });
  });
  afterEach(async () => mf.dispose());

  it("is default-off and does not consult PA membership or entitlement rows", async () => {
    await writeClientPortalAuthorityV2(env(), command("grant-1"));
    await expect(readOperationsPortalEnrollmentStatus(env("false"), principal)).resolves.toEqual([]);
    await expect(readOperationsPortalEnrollmentStatus(env(), principal)).resolves.toEqual([{ authorityId, ownershipEpoch: 1, grantRevision: 1, state: "active" }]);
  });

  it("uses the exact Access issuer and subject, never the email", async () => {
    await writeClientPortalAuthorityV2(env(), command("grant-1"));
    await expect(readOperationsPortalEnrollmentStatus(env(), { ...principal, subject: "person-2" })).resolves.toEqual([]);
    await expect(readOperationsPortalEnrollmentStatus(env(), { ...principal, issuer: "https://other.example.test" })).resolves.toEqual([]);
  });

  it("returns bounded, authority-ID ordered statuses for distinct dual-source enrollments", async () => {
    const secondAuthorityId = "11111111-1111-4111-8111-111111111111";
    const secondWorkspaceId = "workspace-b";
    const secondBindingOperationId = "bind-2";
    const root = "b".repeat(32);
    await db.batch([
      db.prepare("INSERT INTO portal_v2_workspaces VALUES(?, 'organization', ?, NULL, 'project-alpha:west', 'active')").bind(secondWorkspaceId, root),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,'project-alpha:west','source-b')").bind(secondWorkspaceId),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-2',?,'generation-2',2,'project-alpha:west','organization',?)").bind(secondWorkspaceId, root),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES(?,'generation-2',2,'snapshot-2')").bind(secondWorkspaceId),
    ]);
    await writeClientAuthorityWorkspaceBinding({ DELIVERY_DB: db, CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED: "true" }, {
      operationId: secondBindingOperationId, clientAuthorityId: secondAuthorityId, workspaceId: secondWorkspaceId,
      projectionSourceId: "project-alpha:west", sourceWorkspaceId: "source-b", rootType: "organization", rootPublicId: root,
      expectedCheckpoint: { sourceGeneration: "generation-2", sourceSequence: 2, snapshotGenerationId: "snapshot-2" },
    });
    await writeClientPortalAuthorityV2(env(), command("grant-1"));
    await writeClientPortalAuthorityV2(env(), {
      operationId: "grant-2", clientAuthorityId: secondAuthorityId, workspaceId: secondWorkspaceId,
      bindingOperationId: secondBindingOperationId, issuer: principal.issuer, subject: principal.subject,
      desiredState: "active", expectedOwnershipEpoch: 0, expectedGrantRevision: 0, scopes: [] as [],
    });
    await expect(readOperationsPortalEnrollmentStatus(env(), principal)).resolves.toEqual([
      { authorityId: secondAuthorityId, ownershipEpoch: 1, grantRevision: 1, state: "active" },
      { authorityId, ownershipEpoch: 1, grantRevision: 1, state: "active" },
    ]);
  });

  it("drops immediately on revoke and resumes only at the next exact grant revision", async () => {
    await writeClientPortalAuthorityV2(env(), command("grant-1"));
    await writeClientPortalAuthorityV2(env(), command("revoke-2", "revoked", 1));
    await expect(readOperationsPortalEnrollmentStatus(env(), principal)).resolves.toEqual([]);
    await writeClientPortalAuthorityV2(env(), command("regrant-3", "active", 2));
    await expect(readOperationsPortalEnrollmentStatus(env(), principal)).resolves.toEqual([{ authorityId, ownershipEpoch: 1, grantRevision: 3, state: "active" }]);
  });

  it("fails closed for an inactive workspace", async () => {
    await writeClientPortalAuthorityV2(env(), command("grant-1"));
    await db.prepare("UPDATE portal_v2_workspaces SET status='suspended' WHERE id=?").bind(workspaceId).run();
    await expect(readOperationsPortalEnrollmentStatus(env(), principal)).resolves.toEqual([]);
  });

  it("fails closed when the required authority tables are absent or the epoch cannot join", async () => {
    const empty = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default {}", d1Databases: { DELIVERY_DB: crypto.randomUUID() } });
    const emptyDb = await empty.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await expect(readOperationsPortalEnrollmentStatus({ DELIVERY_DB: emptyDb, CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED: "true" }, principal)).resolves.toEqual([]);
    await empty.dispose();

    const mismatched = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default {}", d1Databases: { DELIVERY_DB: crypto.randomUUID() } });
    const mismatchedDb = await mismatched.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await mismatchedDb.batch([
      mismatchedDb.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT)"),
      mismatchedDb.prepare("CREATE TABLE portal_client_authority_workspace_bindings(client_authority_id TEXT,workspace_id TEXT,operation_id TEXT,state TEXT,revision INTEGER)"),
      mismatchedDb.prepare("CREATE TABLE portal_operations_workspace_authority_heads(workspace_id TEXT,client_authority_id TEXT,ownership_epoch INTEGER,state TEXT,binding_operation_id TEXT)"),
      mismatchedDb.prepare("CREATE TABLE portal_operations_principal_grant_heads(workspace_id TEXT,client_authority_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,grant_revision INTEGER,state TEXT)"),
      mismatchedDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?, 'active')").bind(workspaceId),
      mismatchedDb.prepare("INSERT INTO portal_client_authority_workspace_bindings VALUES(?,?,?,'inactive',1)").bind(authorityId, workspaceId, bindingOperationId),
      mismatchedDb.prepare("INSERT INTO portal_operations_workspace_authority_heads VALUES(?,?,2,'active',?)").bind(workspaceId, authorityId, bindingOperationId),
      mismatchedDb.prepare("INSERT INTO portal_operations_principal_grant_heads VALUES(?,?,?,?,1,1,'active')").bind(workspaceId, authorityId, principal.issuer, principal.subject),
    ]);
    await expect(readOperationsPortalEnrollmentStatus({ DELIVERY_DB: mismatchedDb, CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED: "true" }, principal)).resolves.toEqual([]);
    await mismatchedDb.batch([
      mismatchedDb.prepare("UPDATE portal_operations_principal_grant_heads SET ownership_epoch=2"),
      mismatchedDb.prepare("UPDATE portal_operations_workspace_authority_heads SET binding_operation_id='wrong-binding'"),
    ]);
    await expect(readOperationsPortalEnrollmentStatus({ DELIVERY_DB: mismatchedDb, CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED: "true" }, principal)).resolves.toEqual([]);
    await mismatched.dispose();
  });

  it("fails closed on malformed duplicate authority rows or more than 100 statuses", async () => {
    const malformed = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default {}", d1Databases: { DELIVERY_DB: crypto.randomUUID() } });
    const malformedDb = await malformed.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await malformedDb.batch([
      malformedDb.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT)"),
      malformedDb.prepare("CREATE TABLE portal_client_authority_workspace_bindings(client_authority_id TEXT,workspace_id TEXT,operation_id TEXT,state TEXT,revision INTEGER)"),
      malformedDb.prepare("CREATE TABLE portal_operations_workspace_authority_heads(workspace_id TEXT,client_authority_id TEXT,ownership_epoch INTEGER,state TEXT,binding_operation_id TEXT)"),
      malformedDb.prepare("CREATE TABLE portal_operations_principal_grant_heads(workspace_id TEXT,client_authority_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,grant_revision INTEGER,state TEXT)"),
    ]);
    const insert = (workspace: string, authority: string) => [
      malformedDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?, 'active')").bind(workspace),
      malformedDb.prepare("INSERT INTO portal_client_authority_workspace_bindings VALUES(?,?,?,'inactive',1)").bind(authority, workspace, `binding-${workspace}`),
      malformedDb.prepare("INSERT INTO portal_operations_workspace_authority_heads VALUES(?,?,1,'active',?)").bind(workspace, authority, `binding-${workspace}`),
      malformedDb.prepare("INSERT INTO portal_operations_principal_grant_heads VALUES(?,?,?,?,1,1,'active')").bind(workspace, authority, principal.issuer, principal.subject),
    ];
    await malformedDb.batch([...insert("duplicate-a", authorityId), ...insert("duplicate-b", authorityId)]);
    await expect(readOperationsPortalEnrollmentStatus({ DELIVERY_DB: malformedDb, CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED: "true" }, principal)).resolves.toEqual([]);
    await malformedDb.batch(Array.from({ length: 101 }, (_value, index) => insert(`overflow-${index}`, `authority-${index}`)).flat());
    await expect(readOperationsPortalEnrollmentStatus({ DELIVERY_DB: malformedDb, CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED: "true" }, principal)).resolves.toEqual([]);
    await malformed.dispose();
  });
});
