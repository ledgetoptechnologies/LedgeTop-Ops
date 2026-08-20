import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import eligibilityMigration from "../migrations/0145_portal_identity_eligibility.sql?raw";
import { listPortalWorkspaces } from "../src/worker/client-portal/workspace-v2";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { Env } from "../src/worker/types";

const active: Miniflare[] = [];

async function fixture(): Promise<{ db: D1Database; env: Env }> {
  const miniflare = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DELIVERY_DB: "portal-identity-eligibility" } });
  active.push(miniflare);
  const db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await db.exec(`
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,verified_email TEXT,
      status TEXT,revoked_at TEXT,UNIQUE(issuer,subject));
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT,display_name TEXT);
    CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT,issuer TEXT,subject TEXT,email TEXT,revoked_at TEXT,
      UNIQUE(issuer,subject),UNIQUE(id,account_id));
    CREATE TABLE client_account_members(account_id TEXT,identity_id TEXT,role TEXT,can_view_billing INTEGER,revoked_at TEXT,
      PRIMARY KEY(account_id,identity_id));
    CREATE TABLE projects(id TEXT PRIMARY KEY,external_ref TEXT,client_name TEXT,project_name TEXT,active INTEGER,status TEXT,
      summary TEXT,site_address TEXT,service_address TEXT,project_contact_name TEXT,project_contact_email TEXT,
      project_contact_phone TEXT,next_milestone TEXT,source_updated_at TEXT);
    CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,can_request_service INTEGER,revoked_at TEXT);
    CREATE TABLE client_member_project_grants(account_id TEXT,identity_id TEXT,project_id TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,
      pa_client_public_id TEXT,display_name TEXT,status TEXT,legacy_account_id TEXT);
    CREATE TABLE portal_v2_workspace_memberships(id TEXT,workspace_id TEXT,identity_id TEXT,source_type TEXT,status TEXT,
      source_version TEXT,revoked_at TEXT,expires_at TEXT,updated_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(workspace_id,identity_id));
    CREATE TABLE portal_v2_identity_denials(identity_id TEXT,scope_type TEXT,status TEXT,revoked_at TEXT,
      valid_from TEXT,expires_at TEXT);
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT);
    CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,
      parent_public_id TEXT,active INTEGER);
    CREATE TABLE portal_v2_entitlements(workspace_id TEXT,identity_id TEXT,capability TEXT,effect TEXT,status TEXT,
      revoked_at TEXT,valid_from TEXT,expires_at TEXT,scope_type TEXT,scope_public_id TEXT,entitlement_version INTEGER,id TEXT);
    CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,email_hint TEXT,
      display_name TEXT,source_version TEXT,status TEXT,PRIMARY KEY(workspace_id,public_id));
  `.replace(/\s*\n\s*/g, " "));
  const migration = eligibilityMigration.replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " ");
  await db.exec(migration);
  await db.exec(migration);
  return { db, env: { DELIVERY_DB: db, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
    CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true" } as Env };
}

afterEach(async () => Promise.all(active.splice(0).map(instance => instance.dispose())));

describe("Project Alpha portal identity eligibility", () => {
  it("binds an exact active portal principal on first login without granting any workspace", async () => {
    const { db, env } = await fixture();
    await db.prepare("INSERT INTO client_accounts VALUES('account-one','active','Client')").run();
    await db.prepare(`INSERT INTO portal_v2_workspaces VALUES
      ('workspace-one','organization','org-one',NULL,'Client Workspace','active','account-one')`).run();
    await db.prepare(`INSERT INTO pa_portal_principals VALUES
      ('workspace-one','principal-one',NULL,'client@example.test','Client','source-v1','active')`).run();
    await expect(listPortalWorkspaces({ ...env, CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false" }, {
      issuer: "https://access.example.test", subject: "subject-one", email: "client@example.test",
    })).resolves.toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities").first("count")).toBe(0);
    await expect(listPortalWorkspaces(env, {
      issuer: "https://access.example.test", subject: "subject-one", email: "CLIENT@example.test",
    })).resolves.toEqual([{ id: "workspace-one", rootType: "organization", rootPublicId: "org-one", displayName: "Client Workspace" }]);
    expect(await db.prepare("SELECT issuer,subject,verified_email FROM portal_v2_identities").first())
      .toEqual({ issuer: "https://access.example.test", subject: "subject-one", verified_email: "client@example.test" });
    expect(await db.prepare(`SELECT workspace_id,principal_public_id FROM portal_v2_identity_eligibility_bindings`).first())
      .toEqual({ workspace_id: "workspace-one", principal_public_id: "principal-one" });
    expect(await db.prepare(`SELECT principal.identity_id,membership.source_type,membership.source_version
      FROM pa_portal_principals principal JOIN portal_v2_workspace_memberships membership
        ON membership.workspace_id=principal.workspace_id AND membership.identity_id=principal.identity_id
      WHERE principal.workspace_id='workspace-one' AND principal.public_id='principal-one'`).first())
      .toEqual({ identity_id: expect.any(String), source_type: "project_alpha", source_version: "source-v1" });
    await db.prepare("UPDATE portal_v2_workspace_memberships SET updated_at='2000-01-01T00:00:00Z'").run();
    await expect(listPortalWorkspaces(env, {
      issuer: "https://access.example.test", subject: "subject-one", email: "client@example.test",
    })).resolves.toHaveLength(1);
    expect(await db.prepare("SELECT updated_at FROM portal_v2_workspace_memberships").first("updated_at"))
      .toBe("2000-01-01T00:00:00Z");
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_account_members").first("count")).toBe(1);
    await db.prepare(`INSERT INTO projects VALUES('project-private','ref','Client','Private project',1,'active',
      NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`).run();
    await db.prepare("INSERT INTO client_project_grants VALUES('account-one','project-private',0,NULL)").run();
    const bridge = await db.prepare(`SELECT legacy_identity_id FROM portal_v2_identity_eligibility_legacy_bridges`).first<string>("legacy_identity_id");
    await expect(d1ClientPortalRepository.listProjects(env, { accountId: "account-one", identityId: bridge!,
      workspaceId: "workspace-one", principalIssuer: "https://access.example.test", principalSubject: "subject-one",
      displayName: "Client Workspace", role: "member", canViewBilling: false })).resolves.toEqual([]);
    await db.prepare("UPDATE pa_portal_principals SET source_version='source-v2' WHERE public_id='principal-one'").run();
    await expect(listPortalWorkspaces(env, {
      issuer: "https://access.example.test", subject: "subject-one", email: "client@example.test",
    })).resolves.toEqual([]);
    await db.prepare("UPDATE pa_portal_principals SET status='active',email_hint='changed@example.test' WHERE public_id='principal-one'").run();
    await expect(listPortalWorkspaces(env, {
      issuer: "https://access.example.test", subject: "subject-one", email: "client@example.test",
    })).resolves.toEqual([]);
    await db.prepare("UPDATE pa_portal_principals SET source_version='source-v1',status='revoked' WHERE public_id='principal-one'").run();
    await expect(listPortalWorkspaces(env, {
      issuer: "https://access.example.test", subject: "subject-one", email: "client@example.test",
    })).resolves.toEqual([]);
  }, 15_000);

  it("does not treat unrelated or invalid email records as portal principals", async () => {
    const { db, env } = await fixture();
    await db.prepare("INSERT INTO client_accounts VALUES('account-one','active','Client')").run();
    await db.prepare(`INSERT INTO portal_v2_workspaces VALUES
      ('workspace-one','organization','org-one',NULL,'Client Workspace','active','account-one')`).run();
    await db.prepare(`INSERT INTO pa_portal_principals VALUES
      ('workspace-one','principal-one',NULL,'portal@example.test','Portal','source-v1','active')`).run();
    await expect(listPortalWorkspaces(env, {
      issuer: "https://access.example.test", subject: "billing", email: "billing@example.test",
    })).resolves.toEqual([]);
    await expect(listPortalWorkspaces(env, {
      issuer: "https://access.example.test", subject: "invalid", email: "not-an-email",
    })).resolves.toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities").first("count")).toBe(0);
  });

  it("applies exact subject and email eligibility blocks before identity creation", async () => {
    const { db, env } = await fixture();
    await db.prepare("INSERT INTO client_accounts VALUES('account-one','active','Client')").run();
    await db.prepare(`INSERT INTO portal_v2_workspaces VALUES
      ('workspace-one','organization','org-one',NULL,'Client Workspace','active','account-one')`).run();
    await db.prepare(`INSERT INTO pa_portal_principals VALUES
      ('workspace-one','principal-one',NULL,'blocked@example.test','Blocked','source-v1','active')`).run();
    await db.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks
      (id,match_type,normalized_email,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('block-one','email','blocked@example.test','operator_block','staff','staff-one')`).run();
    await expect(listPortalWorkspaces(env, {
      issuer: "https://access.example.test", subject: "blocked", email: "blocked@example.test",
    })).resolves.toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities").first("count")).toBe(0);
  });
});
