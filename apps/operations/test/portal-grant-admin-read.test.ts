import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import denialMigration from "../../client/migrations/0136_portal_v2_identity_denials.sql?raw";
import grantMigration from "../../client/migrations/0137_authenticated_delivery_grants.sql?raw";

const mocks = vi.hoisted(() => ({ requirePermission: vi.fn(), isAdministrator: vi.fn() }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  requirePermission: mocks.requirePermission,
  isAdministrator: mocks.isAdministrator,
}));

import { listAuthenticatedDeliveryGrants, revokeAuthenticatedDeliveryGrant, searchAuthenticatedDeliveryGrantAudiences } from "../src/worker/authenticated-delivery-grants";
import { createPortalIdentityDenial, listPortalIdentityDenials, searchPortalDenyScopes } from "../src/worker/client-portal-deny-policies";
import type { Env, StaffPrincipal } from "../src/worker/types";

const executable = (sql: string) => sql.replace(/^\s*--.*$/gm, "")
  .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " ");
const principal: StaffPrincipal = { id: "staff-admin", email: "admin@example.test", displayName: "Admin",
  accessSubject: "access-admin", projectAlphaUserId: "pa-admin" };

describe("bounded staff grant and denial reads", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-16", modules: true,
      script: "export default { fetch(){ return new Response('ok') } }", d1Databases: { DELIVERY_DB: "grant-admin-reads" } });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(executable(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,project_alpha_source_id TEXT);
      CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,verified_email TEXT,
        status TEXT NOT NULL DEFAULT 'active',revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),UNIQUE(issuer,subject));
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT NOT NULL,pa_organization_public_id TEXT,pa_client_public_id TEXT,
        legacy_account_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,source_type TEXT,
        status TEXT NOT NULL DEFAULT 'active',expires_at TEXT,revoked_at TEXT,UNIQUE(workspace_id,identity_id));
      CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,status TEXT NOT NULL,complete INTEGER NOT NULL);
      CREATE TABLE portal_v2_directory_entities(workspace_id TEXT NOT NULL,generation_id TEXT NOT NULL,entity_type TEXT NOT NULL,public_id TEXT NOT NULL,
        parent_public_id TEXT,display_name TEXT NOT NULL,source_version TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(workspace_id,generation_id,entity_type,public_id));
      CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT NOT NULL);
      CREATE TABLE portal_v2_directory_relations(workspace_id TEXT NOT NULL,generation_id TEXT NOT NULL,relation_type TEXT NOT NULL,
        from_type TEXT NOT NULL,from_public_id TEXT NOT NULL,to_type TEXT NOT NULL,to_public_id TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE portal_v2_entitlements(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,capability TEXT NOT NULL,effect TEXT NOT NULL,
        scope_type TEXT NOT NULL,scope_public_id TEXT NOT NULL,entitlement_version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',
        valid_from TEXT NOT NULL DEFAULT (datetime('now')),expires_at TEXT,revoked_at TEXT);
      CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_scope_type TEXT NOT NULL,owner_public_id TEXT NOT NULL,
        r2_prefix TEXT NOT NULL,source_version TEXT,status TEXT NOT NULL DEFAULT 'active',revoked_at TEXT,updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(id,workspace_id));
      CREATE TABLE pa_portal_principals(workspace_id TEXT NOT NULL,public_id TEXT NOT NULL,identity_id TEXT,email_hint TEXT,display_name TEXT NOT NULL,
        source_version TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',PRIMARY KEY(workspace_id,public_id),UNIQUE(workspace_id,identity_id));
    `));
    await db.exec(executable(denialMigration));
    await db.exec(executable(grantMigration));
    await db.exec(executable(`
      INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES
        ('identity-a','https://access.test','subject-a','person@example.test'),
        ('identity-b','https://access.test','subject-b','private-outside-scope@example.test'),
        ('identity-c','https://access.test','subject-c','manager-c@example.test');
      INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status) VALUES ('workspace-a','organization','org-a','Acme Workspace','active');
      INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,status) VALUES
        ('membership-a','workspace-a','identity-a','active'),('membership-b','workspace-a','identity-b','active'),
        ('membership-c','workspace-a','identity-c','active');
      INSERT INTO portal_v2_directory_generations(id,workspace_id,status,complete) VALUES ('generation-a','workspace-a','active',1);
      INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id) VALUES ('workspace-a','generation-a');
      INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES
        ('workspace-a','generation-a','organization','org-a',NULL,'Acme Organization','org-v1'),
        ('workspace-a','generation-a','project','project-a','org-a','Hilly Haven','project-v1');
      INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_version)
        VALUES ('binding-a','workspace-a','project','project-a','Jobs/Clients/Acme/','binding-v1');
      INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id)
        VALUES ('delivery-a','workspace-a','identity-a','delivery.view','allow','project','project-a'),
          ('manage-b','workspace-a','identity-b','member.manage','allow','project','project-a'),
          ('manage-c','workspace-a','identity-c','member.manage','allow','project','project-a');
      INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES ('workspace-a','principal-a','identity-a','display@example.test','Alex Client','principal-v1','active'),
          ('workspace-a','principal-b','identity-b','private-outside-scope@example.test','Second Private Client','principal-b-v1','active');
      INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
        audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES ('grant-a-v1','grant-a',1,'workspace-a','binding-a','binding-v1','organization','org-a','org-v1','client_delivery','staff-admin');
      INSERT INTO portal_v2_identity_denials(id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,created_by_actor_type,created_by_actor_id)
        VALUES ('denial-a','identity-a','workspace-a','project','project-a','security_response','staff','staff-admin');
    `));
    const opsDb = {
      withSession() { return this; },
      prepare() { return { bind() { return { async all() { return { results: [{ division_id: "division-a", r2_prefix: "Jobs/Clients/Acme/" }] }; } }; } }; },
    };
    env = { DELIVERY_DB: db, OPS_DB: opsDb, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true", CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true" } as unknown as Env;
  });

  beforeEach(() => {
    mocks.requirePermission.mockReset().mockResolvedValue(undefined);
    mocks.isAdministrator.mockReset().mockResolvedValue(true);
  });
  afterAll(async () => miniflare.dispose());

  it("lists only safe grant metadata and identifies dynamic group authority", async () => {
    const result = await listAuthenticatedDeliveryGrants(env, principal, "Jobs/Clients/Acme/");
    expect(result).toMatchObject({ folderBindingId: "binding-a", grants: [{
      grantId: "grant-a", audienceLabel: "Acme Organization", workspaceLabel: "Acme Workspace",
      dynamicAudience: true, recipientCount: 0,
    }] });
    expect(JSON.stringify(result)).not.toContain("Jobs/Clients/Acme");
    expect(mocks.requirePermission).toHaveBeenCalledTimes(1);
    expect(mocks.requirePermission.mock.calls[0]?.slice(1)).toEqual([
      principal, "delivery.share.create", { divisionId: "division-a" }, true,
    ]);
  });

  it("returns bounded safe scope labels without storage paths", async () => {
    const result = await searchPortalDenyScopes(env, principal, "project", "Hilly");
    expect(result.scopes).toEqual([{ scopeType: "project", workspaceId: "workspace-a", publicId: "project-a",
      displayName: "Hilly Haven", workspaceLabel: "Acme Workspace",
      breadcrumb: "Acme Workspace › Acme Organization › Hilly Haven" }]);
    expect(JSON.stringify(result)).not.toContain("Jobs/Clients");
  });

  it("does not disclose a principal or email without live delivery access to the exact folder", async () => {
    const searchEnv = { ...env, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "false" };
    const hidden = await searchAuthenticatedDeliveryGrantAudiences(searchEnv, principal, "binding-a", "Second");
    expect(hidden.audiences).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain("private-outside-scope@example.test");
    const visible = await searchAuthenticatedDeliveryGrantAudiences(searchEnv, principal, "binding-a", "Alex");
    expect(visible.audiences).toContainEqual({ type: "principal", publicId: "principal-a",
      displayName: "Alex Client", email: "person@example.test" });
  });

  it("lists denial history with display-only identity and scope labels", async () => {
    const result = await listPortalIdentityDenials(env, principal);
    expect(result.denials[0]).toMatchObject({ id: "denial-a", identityId: "identity-a",
      identityLabel: "Alex Client", identityEmail: "person@example.test", workspaceLabel: "Acme Workspace",
      scopeLabel: "Hilly Haven", status: "active" });
  });

  it("allows only one concurrent revoker to write the audited transition", async () => {
    const other = { ...principal, id: "staff-second", email: "second-admin@example.test" };
    const settled = await Promise.allSettled([
      revokeAuthenticatedDeliveryGrant(env, principal, "grant-a", 1, "security_response", "revoke-security-0001"),
      revokeAuthenticatedDeliveryGrant(env, other, "grant-a", 1, "security_response", "revoke-security-0002"),
    ]);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_authenticated_delivery_grant_audit WHERE action='grant.revoked'").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_authenticated_delivery_grant_mutations WHERE action='grant.revoke'").first("count")).toBe(1);
    const mutation = await db.prepare("SELECT actor_staff_id,idempotency_key FROM portal_v2_authenticated_delivery_grant_mutations WHERE action='grant.revoke'")
      .first<{ actor_staff_id: string; idempotency_key: string }>();
    const auditActor = await db.prepare("SELECT actor_staff_id FROM portal_v2_authenticated_delivery_grant_audit WHERE action='grant.revoked'")
      .first("actor_staff_id");
    expect(mutation?.idempotency_key).toMatch(/^revoke-security-000[12]$/);
    expect(auditActor).toBe(mutation?.actor_staff_id);
  });

  it("serializes concurrent denials so one effective scoped manager always remains", async () => {
    const input = (identityId: string) => ({ identityId, workspaceId: "workspace-a",
      scopeType: "project" as const, scopePublicId: "project-a", reasonCode: "security_response" });
    const settled = await Promise.allSettled([
      createPortalIdentityDenial(env, principal, input("identity-b"), "deny-manager-b-0001"),
      createPortalIdentityDenial(env, principal, input("identity-c"), "deny-manager-c-0001"),
    ]);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
    const active = await db.prepare(`SELECT identity_id FROM portal_v2_identity_denials
      WHERE identity_id IN ('identity-b','identity-c') AND status='active'`).all<{ identity_id: string }>();
    expect(active.results).toHaveLength(1);
    const survivor = active.results[0]!.identity_id === "identity-b" ? "identity-c" : "identity-b";
    expect(survivor).toMatch(/^identity-[bc]$/);
  });

  it("keeps both management reads default-off", async () => {
    await expect(listAuthenticatedDeliveryGrants({ ...env, AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "false" }, principal, "Jobs/Clients/Acme/"))
      .rejects.toMatchObject({ status: 404 });
    await expect(listPortalIdentityDenials({ ...env, CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "false" }, principal))
      .rejects.toMatchObject({ status: 404 });
  });
});
