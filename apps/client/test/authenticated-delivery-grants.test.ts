import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import denialMigration from "../migrations/0136_portal_v2_identity_denials.sql?raw";
import grantMigration from "../migrations/0137_authenticated_delivery_grants.sql?raw";
import {
  authorizeAuthenticatedDeliveryGrant,
  listAuthorizedAuthenticatedDeliveryPrefixes,
} from "../src/worker/client-portal/authenticated-delivery-grants";
import type { Env } from "../src/worker/types";

const executable = (sql: string) => sql.replace(/^\s*--.*$/gm, "")
  .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " ");

describe("authenticated delivery grant live authorization", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;
  const principal = { issuer: "https://access.test", subject: "subject-a", email: "display-only@example.test" };

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-16", modules: true,
      script: "export default { fetch(){ return new Response('ok') } }", d1Databases: { DELIVERY_DB: "auth-grants" } });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(executable(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,project_alpha_source_id TEXT);
      CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,verified_email TEXT,
        status TEXT NOT NULL DEFAULT 'active',revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),UNIQUE(issuer,subject));
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT NOT NULL,pa_organization_public_id TEXT,pa_client_public_id TEXT,
        legacy_account_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,source_type TEXT,
        status TEXT NOT NULL DEFAULT 'active',expires_at TEXT,revoked_at TEXT,UNIQUE(workspace_id,identity_id),FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id),FOREIGN KEY(identity_id) REFERENCES portal_v2_identities(id));
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
        r2_prefix TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT 'project_alpha',source_version TEXT,status TEXT NOT NULL DEFAULT 'active',revoked_at TEXT,
        UNIQUE(id,workspace_id),FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id));
      CREATE TABLE portal_primary_staff_bindings(binding_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE pa_portal_principals(workspace_id TEXT NOT NULL,public_id TEXT NOT NULL,identity_id TEXT,email_hint TEXT,display_name TEXT NOT NULL,
        source_version TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',PRIMARY KEY(workspace_id,public_id),UNIQUE(workspace_id,identity_id),FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id),FOREIGN KEY(identity_id) REFERENCES portal_v2_identities(id));
      CREATE TABLE portal_v2_identity_eligibility_bindings(identity_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
        principal_public_id TEXT NOT NULL,principal_source_version TEXT NOT NULL,verified_email TEXT NOT NULL);
      CREATE TABLE project_alpha_delivery_portal_grants(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,folder_binding_id TEXT NOT NULL,
        binding_source_version TEXT NOT NULL,audience_type TEXT NOT NULL,audience_public_id TEXT NOT NULL,
        audience_source_version TEXT NOT NULL,grant_version INTEGER NOT NULL DEFAULT 1 CHECK(grant_version>=1),
        status TEXT NOT NULL DEFAULT 'active',expires_at TEXT);
    `));
    await db.exec(executable(denialMigration));
    await db.exec(executable(grantMigration));
    await db.exec(executable(`
      INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES
        ('identity-a','https://access.test','subject-a','person@example.test'),
        ('identity-b','https://access.test','subject-b','second@example.test');
      INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status) VALUES ('workspace-a','organization','org-a','Org A','active');
      INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,status) VALUES
        ('membership-a','workspace-a','identity-a','active'),
        ('membership-b','workspace-a','identity-b','active');
      INSERT INTO portal_v2_directory_generations(id,workspace_id,status,complete) VALUES ('generation-a','workspace-a','active',1);
      INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id) VALUES ('workspace-a','generation-a');
      INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES
        ('workspace-a','generation-a','organization','org-a',NULL,'Org A','org-v1'),
        ('workspace-a','generation-a','project','project-a','org-a','Project A','project-v1');
      INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id) VALUES
        ('delivery-a','workspace-a','identity-a','delivery.view','allow','project','project-a'),
        ('delivery-b','workspace-a','identity-b','delivery.view','allow','project','project-a');
      INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_version)
        VALUES ('binding-a','workspace-a','project','project-a','clients/a/','binding-v1');
      INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status) VALUES
        ('workspace-a','principal-a','identity-a','ignored@example.test','Person A','principal-v1','active'),
        ('workspace-a','principal-b','identity-b','ignored2@example.test','Person B','principal-b-v1','active');
      INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
        audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES ('grant-a-v1','grant-a',1,'workspace-a','binding-a','binding-v1','organization','org-a','org-v1','client_delivery','staff-a');
    `));
    env = { DELIVERY_DB: db, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true" } as Env;
  });

  afterAll(async () => miniflare.dispose());

  it("requires the exact issuer and subject and is default-off", async () => {
    expect(await authorizeAuthenticatedDeliveryGrant({ ...env, AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "false" }, principal, "workspace-a", "binding-a")).toBe(false);
    expect(await authorizeAuthenticatedDeliveryGrant(env, principal, "workspace-a", "binding-a")).toBe(true);
    expect([...await listAuthorizedAuthenticatedDeliveryPrefixes(env, principal, "workspace-a")]).toEqual(["clients/a/"]);
    expect(await authorizeAuthenticatedDeliveryGrant(env, { ...principal, subject: "subject-b" }, "workspace-a", "binding-a")).toBe(true);
    expect(await authorizeAuthenticatedDeliveryGrant(env, { ...principal, subject: "different" }, "workspace-a", "binding-a")).toBe(false);
  });

  it("keeps secondary unbridged native workspaces unavailable despite matching identity and grants", async () => {
    // This focused reader fixture intentionally allows a source swap; production
    // migration coverage separately proves that ownership cannot be reassigned.
    await db.prepare("UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:secondary' WHERE id='workspace-a'").run();
    try {
      expect(await authorizeAuthenticatedDeliveryGrant(env, principal, "workspace-a", "binding-a")).toBe(false);
      expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env, principal, "workspace-a")).toEqual(new Set());
      expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities").first("count")).toBe(2);
    } finally {
      await db.prepare("UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:primary' WHERE id='workspace-a'").run();
    }
  });

  it("fails a primary Operations binding closed without an active 0189 receipt",async()=>{
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_type='operations' WHERE id='binding-a'").run();
    expect(await authorizeAuthenticatedDeliveryGrant(env,principal,"workspace-a","binding-a")).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env,principal,"workspace-a")).toEqual(new Set());
    await db.prepare(`INSERT INTO portal_primary_staff_bindings(binding_id,workspace_id,r2_prefix,state)
      VALUES('binding-a','workspace-a','clients/a/','active')`).run();
    expect(await authorizeAuthenticatedDeliveryGrant(env,principal,"workspace-a","binding-a")).toBe(true);
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_type='project_alpha' WHERE id='binding-a'").run();
  });

  it("fails closed immediately for revoke, source drift, identity denial, and hierarchy move", async () => {
    await db.prepare("UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id='staff-a',revoke_reason_code='removed' WHERE id='grant-a-v1'").run();
    expect(await authorizeAuthenticatedDeliveryGrant(env, principal, "workspace-a", "binding-a")).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env, principal, "workspace-a")).toEqual(new Set());
    await expect(db.prepare("UPDATE portal_v2_authenticated_delivery_grants SET status='active',revoked_at=NULL,revoked_by_staff_id=NULL,revoke_reason_code=NULL WHERE id='grant-a-v1'").run()).rejects.toThrow();
    await db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
      audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
      VALUES ('grant-a-v2','grant-a',2,'workspace-a','binding-a','binding-v1','organization','org-a','org-v1','restored','staff-a')`).run();
    expect(await authorizeAuthenticatedDeliveryGrant(env, principal, "workspace-a", "binding-a")).toBe(true);
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='binding-v2' WHERE id='binding-a'").run();
    expect(await authorizeAuthenticatedDeliveryGrant(env, principal, "workspace-a", "binding-a")).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env, principal, "workspace-a")).toEqual(new Set());
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='binding-v1' WHERE id='binding-a'").run();
    await db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,scope_type,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES ('denial-a','identity-a','global','security','staff','staff-a')`).run();
    expect(await authorizeAuthenticatedDeliveryGrant({ ...env, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true" }, principal, "workspace-a", "binding-a")).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes({ ...env, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true" }, principal, "workspace-a")).toEqual(new Set());
    await db.prepare("UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),revoked_by_actor_type='staff',revoked_by_actor_id='staff-a' WHERE id='denial-a'").run();
    await db.prepare("UPDATE portal_v2_directory_entities SET parent_public_id='other-org' WHERE public_id='project-a'").run();
    expect(await authorizeAuthenticatedDeliveryGrant(env, principal, "workspace-a", "binding-a")).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env, principal, "workspace-a")).toEqual(new Set());
  });

  it("rejects malformed expiry instead of failing open", async () => {
    await expect(db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
      audience_type,audience_public_id,audience_source_version,reason_code,expires_at,created_by_staff_id)
      VALUES ('bad-date','bad-date',1,'workspace-a','binding-a','binding-v1','project','project-a','project-v1','test','not-a-date','staff-a')`).run()).rejects.toThrow();
  });
});
