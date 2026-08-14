import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import migration from "../migrations/0121_client_workspace_hierarchy_v2.sql?raw";
import membershipMigration from "../migrations/0123_portal_v2_membership_management.sql?raw";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import {
  acceptPortalWorkspaceInvitation,
  authorizePortalWorkspaceCapability,
  authorizeEffectiveWorkspaceNotification,
  authorizeEffectiveWorkspaceProject,
  hashPortalInvitationToken,
  listPortalWorkspaces,
  resolveEffectivePortalWorkspaceContext,
} from "../src/worker/client-portal/workspace-v2";
import {
  createWorkspaceInvitation,
  listWorkspaceAccess,
  revokeWorkspaceInvitation,
  suspendWorkspaceMember,
  transferWorkspaceManagerByStaff,
} from "../src/worker/client-portal/workspace-memberships";
import type { Env } from "../src/worker/types";

const issuer = "https://team.cloudflareaccess.com";
const principal: VerifiedClientPrincipal = { issuer, subject: "one", email: "one@example.test" };

describe("client workspace hierarchy v2", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "workspace-v2" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE client_accounts(
        id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,
        project_alpha_client_id TEXT,project_alpha_organization_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE client_identity_links(
        id TEXT PRIMARY KEY,account_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,
        revoked_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')),last_seen_at TEXT,
        UNIQUE(issuer,subject),UNIQUE(id,account_id),FOREIGN KEY(account_id) REFERENCES client_accounts(id)
      );
      CREATE TABLE client_account_members(
        account_id TEXT NOT NULL,identity_id TEXT NOT NULL,role TEXT NOT NULL,can_view_billing INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(account_id,identity_id),FOREIGN KEY(identity_id,account_id) REFERENCES client_identity_links(id,account_id)
      );
      CREATE TABLE projects(
        id TEXT PRIMARY KEY,project_alpha_project_id TEXT,external_ref TEXT,client_name TEXT NOT NULL DEFAULT 'Client',project_name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,status TEXT,summary TEXT,site_address TEXT,service_address TEXT,project_contact_name TEXT,
        project_contact_email TEXT,project_contact_phone TEXT,next_milestone TEXT,source_updated_at TEXT
      );
      CREATE TABLE client_project_grants(
        account_id TEXT NOT NULL,project_id TEXT NOT NULL,can_request_service INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT,PRIMARY KEY(account_id,project_id),
        FOREIGN KEY(account_id) REFERENCES client_accounts(id),FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE client_member_project_grants(
        account_id TEXT NOT NULL,identity_id TEXT NOT NULL,project_id TEXT NOT NULL,revoked_at TEXT,
        PRIMARY KEY(account_id,identity_id,project_id)
      );
      CREATE TABLE client_folder_associations(
        id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,project_id TEXT,account_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,
        created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),revoked_at TEXT,
        logical_grant_id TEXT,grant_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE client_service_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,project_id TEXT,created_by_identity_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'submitted');
      CREATE TABLE client_service_request_drafts(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,project_id TEXT,created_by_identity_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'draft');
      CREATE TABLE client_portal_notifications(
        id TEXT PRIMARY KEY,account_id TEXT NOT NULL,recipient_identity_id TEXT NOT NULL,event_type TEXT NOT NULL,
        source_type TEXT NOT NULL,source_id TEXT NOT NULL,dedupe_key TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,
        action_path TEXT,read_at TEXT,dismissed_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `.replace(/\s*\n\s*/g, " "));
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id) VALUES ('account-a','Alpha Org','active','pa-org-a')"),
      db.prepare("INSERT INTO client_accounts(id,display_name,status) VALUES ('account-unrooted','No stable PA root','active')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES ('identity-one','account-a',?,?,?)")
        .bind(issuer, principal.subject, principal.email),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('account-a','identity-one','manager')"),
      db.prepare("INSERT INTO projects(id,project_alpha_project_id,project_name) VALUES ('project-a','pa-project-a','North Site')"),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES ('account-a','project-a',1)"),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,project_id,account_id,r2_prefix,created_by) VALUES ('folder-a','project','project-a','account-a','clients/a/north/','staff')"),
    ]);
    await db.exec(migration
      .replace(/^\s*--.*$/gm, "")
      .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
      .replace(/\s*\n\s*/g, " "));
    await db.exec(membershipMigration
      .replace(/^\s*--.*$/gm, "")
      .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
      .replace(/\s*\n\s*/g, " "));
    await db.prepare("PRAGMA foreign_keys=ON").run();
    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: "true",
      CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: "true",
      CLIENT_PORTAL_INVITATION_FROM: "portal@example.test",
      CLIENT_PORTAL_INVITATION_EMAIL: { send: async (_message: EmailMessageBuilder) => ({ messageId: "test-only" }) },
      CLIENT_PORTAL_ORIGIN: "https://client.test",
      ENVIRONMENT: "development",
    } as Env;
  }, 30_000);

  afterAll(async () => miniflare.dispose());

  async function addWorkspaceB() {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO portal_v2_workspaces(id,root_type,pa_client_public_id,display_name,status) VALUES ('workspace-b','standalone_client','pa-client-b','Beta Client','active')"),
      db.prepare("INSERT OR IGNORE INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES ('membership-b-one','workspace-b','identity-one','project_alpha','active')"),
      db.prepare("INSERT OR IGNORE INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES ('generation-b','workspace-b','generation-b',1,'active',1)"),
      db.prepare("INSERT OR IGNORE INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES ('workspace-b','generation-b','standalone_client','pa-client-b','Beta Client','1')"),
      db.prepare("INSERT OR IGNORE INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES ('workspace-b','generation-b',1)"),
      db.prepare("INSERT OR IGNORE INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('b-view','workspace-b','identity-one','workspace.view','allow','workspace','workspace-b','project_alpha','active')"),
      db.prepare("INSERT OR IGNORE INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('b-directory','workspace-b','identity-one','directory.read','allow','workspace','workspace-b','project_alpha','active')"),
    ]);
  }

  it("upgrades only rooted legacy accounts, backfills explicit grants, and retains foreign-key integrity", async () => {
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspaces").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspaces WHERE legacy_account_id='account-unrooted'").first("count")).toBe(0);
    expect(await authorizePortalWorkspaceCapability(env, principal, "workspace-account-a", "request.create", {
      scopeType: "project", publicId: "pa-project-a",
    })).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env, principal, "workspace-account-a", "delivery.view", {
      scopeType: "folder", publicId: "legacy-folder-folder-a",
    })).toBe(true);
    await db.exec(migration
      .replace(/^\s*--.*$/gm, "")
      .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
      .replace(/\s*\n\s*/g, " "));
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspaces WHERE id='workspace-account-a'").first("count")).toBe(1);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("is default-off and permits one verified identity to switch between independent workspaces", async () => {
    await addWorkspaceB();
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-b' AND identity_id='identity-one'").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_directory_checkpoints WHERE workspace_id='workspace-b'").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_directory_entities WHERE workspace_id='workspace-b' AND entity_type='standalone_client' AND public_id='pa-client-b'").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_entitlements WHERE id='b-view'").first("count")).toBe(1);
    expect(await authorizePortalWorkspaceCapability(env, principal, "workspace-b", "workspace.view", {
      scopeType: "workspace", publicId: "workspace-b",
    })).toBe(true);
    expect((await listPortalWorkspaces(env, principal)).map(workspace => workspace.id)).toEqual([
      "workspace-account-a",
      "workspace-b",
    ]);
    expect(await listPortalWorkspaces({ ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false" }, principal)).toEqual([]);
  });

  it("denies revoked entitlements and gives matching explicit denies precedence", async () => {
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id LIKE '%pa-project-a-request'").run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "workspace-account-a", "request.create", {
      scopeType: "project", publicId: "pa-project-a",
    })).toBe(false);
    await db.prepare("UPDATE portal_v2_entitlements SET status='active',revoked_at=NULL WHERE id LIKE '%pa-project-a-request'").run();
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status)
      VALUES ('deny-request-a','workspace-account-a','identity-one','request.create','deny','project','pa-project-a',2,'operations','active')`).run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "workspace-account-a", "request.create", {
      scopeType: "project", publicId: "pa-project-a",
    })).toBe(false);
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='deny-request-a'").run();
    await db.prepare("UPDATE portal_v2_directory_entities SET active=0 WHERE workspace_id='workspace-account-a' AND public_id='pa-org-a'").run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "workspace-account-a", "delivery.view", {
      scopeType: "project", publicId: "pa-project-a",
    })).toBe(false);
    await db.prepare("UPDATE portal_v2_directory_entities SET active=1 WHERE workspace_id='workspace-account-a' AND public_id='pa-org-a'").run();
  });

  it("never derives authorization from email or primary-contact metadata", async () => {
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES ('identity-contact',?,'contact','one@example.test')").bind(issuer),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,primary_contact)
        VALUES ('workspace-account-a','legacy-generation-account-a','contact','pa-contact-primary','pa-org-a','Primary Contact','1',1)`),
    ]);
    expect(await listPortalWorkspaces(env, { issuer, subject: "contact", email: "one@example.test" })).toEqual([]);
  });

  it("fails closed across workspace IDs and keeps v2-only principals out of every legacy route", async () => {
    await addWorkspaceB();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES ('identity-v2-only',?,'v2-only','v2@example.test')").bind(issuer),
      db.prepare("INSERT OR IGNORE INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES ('membership-b-v2','workspace-b','identity-v2-only','project_alpha','active')"),
      db.prepare("INSERT OR IGNORE INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('b-v2-view','workspace-b','identity-v2-only','workspace.view','allow','workspace','workspace-b','project_alpha','active')"),
    ]);
    const v2Only: VerifiedClientPrincipal = { issuer, subject: "v2-only", email: "v2@example.test" };
    expect(await authorizePortalWorkspaceCapability(env, v2Only, "workspace-account-a", "workspace.view", {
      scopeType: "workspace", publicId: "workspace-account-a",
    })).toBe(false);
    const router = createClientPortalRouter({ resolvePrincipal: async () => v2Only, repository: d1ClientPortalRepository });
    const bootstrap = await router.request("https://client.test/session", {}, env);
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({ account: { id: "" }, capabilities: { workspaceHierarchyV2: true } });
    expect((await router.request("https://client.test/projects", {}, env)).status).toBe(403);
    const response = await router.request("https://client.test/v2/workspaces", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaces: [{ id: "workspace-b" }] });
  });

  it("resolves one selected workspace and intersects local resources with scoped v2 allows and denies", async () => {
    const context = await resolveEffectivePortalWorkspaceContext(env, principal, "workspace-account-a");
    expect(context).toMatchObject({
      workspaceId: "workspace-account-a",
      legacyAccountId: "account-a",
      legacyIdentityId: "identity-one",
    });
    if (!context) throw new Error("workspace context not resolved");
    expect(await authorizeEffectiveWorkspaceProject(env, principal, context, "delivery.view", "project-a")).toBe(true);
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status)
      VALUES ('cutover-deny-project','workspace-account-a','identity-one','delivery.view','deny','project','pa-project-a',99,'operations','active')`).run();
    expect(await authorizeEffectiveWorkspaceProject(env, principal, context, "delivery.view", "project-a")).toBe(false);
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='cutover-deny-project'").run();

    await addWorkspaceB();
    expect(await resolveEffectivePortalWorkspaceContext(env, principal, "workspace-b")).toBeNull();
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='suspended' WHERE workspace_id='workspace-account-a' AND identity_id='identity-one'").run();
    expect(await resolveEffectivePortalWorkspaceContext(env, principal, "workspace-account-a")).toBeNull();
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='active' WHERE workspace_id='workspace-account-a' AND identity_id='identity-one'").run();
  });

  it("scopes notification access to the selected workspace and its live resource entitlement", async () => {
    const context = await resolveEffectivePortalWorkspaceContext(env, principal, "workspace-account-a");
    if (!context) throw new Error("workspace context not resolved");
    await db.batch([
      db.prepare("INSERT INTO client_service_requests(id,account_id,project_id,created_by_identity_id) VALUES ('request-a','account-a','project-a','identity-one')"),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body)
        VALUES ('notice-a','account-a','identity-one','request_status','service_request','request-a','notice-a','Updated','Request updated')`),
    ]);
    expect(await authorizeEffectiveWorkspaceNotification(env, principal, context, "notice-a")).toBe(true);
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status)
      VALUES ('cutover-deny-notice','workspace-account-a','identity-one','request.create','deny','project','pa-project-a',99,'operations','active')`).run();
    expect(await authorizeEffectiveWorkspaceNotification(env, principal, context, "notice-a")).toBe(false);
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='cutover-deny-notice'").run();
  });

  it("requires workspace selection on cutover legacy resource routes while preserving exact flag-off behavior", async () => {
    const router = createClientPortalRouter({ resolvePrincipal: async () => principal, repository: d1ClientPortalRepository });
    const selected = await router.request("https://client.test/projects", {
      headers: { "X-LTDS-Workspace-Id": "workspace-account-a" },
    }, env);
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ projects: [{ id: "project-a" }] });
    expect((await router.request("https://client.test/projects", {}, env)).status).toBe(403);
    expect((await router.request("https://client.test/projects", {
      headers: { "X-LTDS-Workspace-Id": "workspace-b" },
    }, env)).status).toBe(403);
    const legacy = await router.request("https://client.test/projects", {}, {
      ...env,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false",
    });
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ projects: [{ id: "project-a" }] });
  });

  it("does not let legacy team routes bypass a workspace-v2 member.manage deny", async () => {
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status)
      VALUES ('cutover-deny-member-manage','workspace-account-a','identity-one','member.manage','deny','workspace','workspace-account-a',99,'operations','active')`).run();
    const router = createClientPortalRouter({ resolvePrincipal: async () => principal, repository: d1ClientPortalRepository });
    const selected = { "X-LTDS-Workspace-Id": "workspace-account-a" };
    const mutationHeaders = { ...selected, Origin: "https://client.test", "Content-Type": "application/json" };
    const before = await db.prepare("SELECT COUNT(*) count FROM portal_v2_invitations").first<number>("count");

    expect((await router.request("https://client.test/team", { headers: selected }, {
      ...env, CLIENT_PORTAL_TEAM_ENABLED: "true",
    })).status).toBe(403);
    expect((await router.request("https://client.test/team/invitations", {
      method: "POST", headers: mutationHeaders,
      body: JSON.stringify({ email: "blocked@example.test", role: "member", projectIds: ["project-a"] }),
    }, { ...env, CLIENT_PORTAL_TEAM_ENABLED: "true" })).status).toBe(403);
    expect((await router.request("https://client.test/team/members/identity-one", {
      method: "DELETE", headers: mutationHeaders,
    }, { ...env, CLIENT_PORTAL_TEAM_ENABLED: "true" })).status).toBe(403);
    expect((await router.request("https://client.test/team/invitations/invite-a", {
      method: "DELETE", headers: mutationHeaders,
    }, { ...env, CLIENT_PORTAL_TEAM_ENABLED: "true" })).status).toBe(403);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_invitations").first<number>("count")).toBe(before);
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='cutover-deny-member-manage'").run();
  });

  it("applies the selected-workspace draft guard to every request and attachment subroute", async () => {
    await db.prepare("INSERT INTO client_service_request_drafts(id,account_id,project_id,created_by_identity_id) VALUES ('draft-a','account-a','project-a','identity-one')").run();
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status)
      VALUES ('cutover-deny-draft','workspace-account-a','identity-one','request.create','deny','project','pa-project-a',100,'operations','active')`).run();
    const router = createClientPortalRouter({ resolvePrincipal: async () => principal, repository: d1ClientPortalRepository });
    const headers = { "X-LTDS-Workspace-Id": "workspace-account-a", Origin: "https://client.test" };
    const paths: Array<[string, string]> = [
      ["GET", "/service-request-drafts/draft-a"],
      ["GET", "/service-request-drafts/draft-a/attachments"],
      ["POST", "/service-request-drafts/draft-a/attachments"],
      ["GET", "/service-request-drafts/draft-a/attachments/attachment-a"],
      ["POST", "/service-request-drafts/draft-a/attachments/attachment-a/part-ticket"],
      ["PUT", "/service-request-drafts/draft-a/attachments/attachment-a/parts/1"],
      ["POST", "/service-request-drafts/draft-a/attachments/attachment-a/complete"],
      ["DELETE", "/service-request-drafts/draft-a/attachments/attachment-a"],
      ["PUT", "/service-request-drafts/draft-a"],
      ["GET", "/service-request-drafts/draft-a/pricing-hint"],
      ["POST", "/service-request-drafts/draft-a/submit"],
    ];
    for (const [method, path] of paths) {
      const response = await router.request(`https://client.test${path}`, { method, headers }, {
        ...env,
        CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='cutover-deny-draft'").run();
  }, 30_000);

  it("accepts only hashed, unexpired, email-bound invitations and makes same-identity replay idempotent", async () => {
    const token = "A".repeat(48);
    const tokenHash = await hashPortalInvitationToken(token);
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES ('identity-invite',?,'invite','invite@example.test')").bind(issuer),
      db.prepare(`INSERT INTO portal_v2_invitations
        (id,workspace_id,token_hash,invited_email,invited_by_identity_id,expires_at)
        VALUES ('invite-a','workspace-account-a',?,'invite@example.test','identity-one','2099-01-01T00:00:00Z')`).bind(tokenHash),
      db.prepare(`INSERT INTO portal_v2_invitation_entitlements(invitation_id,capability,scope_type,scope_public_id)
        VALUES ('invite-a','workspace.view','workspace','workspace-account-a')`),
    ]);
    const invited = { issuer, subject: "invite", email: "invite@example.test" };
    expect(await acceptPortalWorkspaceInvitation(env, invited, token)).toBe("accepted");
    expect(await acceptPortalWorkspaceInvitation(env, invited, token)).toBe("replayed");
    expect(await listPortalWorkspaces(env, invited)).toMatchObject([{ id: "workspace-account-a" }]);
    expect(await acceptPortalWorkspaceInvitation(env, { ...invited, email: "wrong@example.test" }, token)).toBe("denied");
    expect(await db.prepare("SELECT token_hash FROM portal_v2_invitations WHERE id='invite-a'").first("token_hash")).toBe(tokenHash);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_invitations WHERE token_hash=?").bind(token).first("count")).toBe(0);
  });

  it("defaults invitations to an exact live project and never delegates manager capabilities", async () => {
    const missingProject = await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "contractor@example.test", capabilities: ["delivery.view"],
    }, "project-default-missing-0001");
    expect(missingProject.outcome).toBe("invalid");

    const escalation = await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "contractor@example.test", projectPublicId: "pa-project-a",
      capabilities: ["member.manage"],
    }, "no-escalation-capability-0001");
    expect(escalation.outcome).toBe("invalid");

    const created = await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "Contractor@Example.Test", projectPublicId: "pa-project-a",
      capabilities: ["delivery.view", "request.create"],
    }, "project-invitation-create-0001");
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") throw new Error("invitation was not created");
    expect(created.invitation).toMatchObject({ email: "contractor@example.test", scope: { type: "project", publicId: "pa-project-a" } });
    expect(created.invitation.capabilities).toEqual(["delivery.view", "request.create", "workspace.view"]);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_invitation_entitlements WHERE invitation_id=? AND capability IN ('member.manage','delegated_share.create')")
      .bind(created.invitation.id).first("count")).toBe(0);
    expect(await db.prepare("SELECT length(token_hash) FROM portal_v2_invitations WHERE id=?").bind(created.invitation.id).first("length(token_hash)")).toBe(43);

    const replay = await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "contractor@example.test", projectPublicId: "pa-project-a",
      capabilities: ["request.create", "delivery.view"],
    }, "project-invitation-create-0001");
    expect(replay).toMatchObject({ outcome: "replayed", invitation: { id: created.invitation.id } });
    expect((await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "other@example.test", projectPublicId: "pa-project-a", capabilities: ["delivery.view"],
    }, "project-invitation-create-0001")).outcome).toBe("conflict");

    expect((await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "wide@example.test", organizationWide: true, capabilities: ["delivery.view"],
    }, "workspace-wide-no-confirm-01")).outcome).toBe("invalid");
    expect((await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "wide@example.test", organizationWide: true, confirmOrganizationWide: true, capabilities: ["delivery.view"],
    }, "workspace-wide-confirmed-01")).outcome).toBe("created");

    await addWorkspaceB();
    expect((await createWorkspaceInvitation(env, principal, "workspace-b", {
      email: "idor@example.test", organizationWide: true, confirmOrganizationWide: true, capabilities: ["delivery.view"],
    }, "cross-workspace-denial-0001")).outcome).toBe("denied");
    const access = await listWorkspaceAccess(env, principal, "workspace-account-a");
    expect(access?.invitations.some(invitation => invitation.id === created.invitation.id)).toBe(true);
  }, 30_000);

  it("binds acceptance to verified issuer, subject, and exact email and rejects replay by another subject", async () => {
    const result = await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "new-person@example.test", projectPublicId: "pa-project-a", capabilities: ["delivery.view"],
    }, "acceptance-binding-test-0001");
    if (result.outcome !== "created") throw new Error("invitation was not created");
    const payload = await db.prepare("SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?")
      .bind(result.invitation.id).first<string>("payload_json");
    const token = (JSON.parse(payload!) as { token: string }).token;
    const invited = { issuer, subject: "new-person-subject", email: "new-person@example.test" };
    expect(await acceptPortalWorkspaceInvitation(env, { ...invited, email: "mismatch@example.test" }, token)).toBe("denied");
    expect(await acceptPortalWorkspaceInvitation(env, invited, token)).toBe("accepted");
    expect(await acceptPortalWorkspaceInvitation(env, invited, token)).toBe("replayed");
    expect(await db.prepare("SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?")
      .bind(result.invitation.id).first("payload_json")).toBe('{"redacted":true}');
    expect(await acceptPortalWorkspaceInvitation(env, { ...invited, subject: "attacker" }, token)).toBe("denied");
    expect(await authorizePortalWorkspaceCapability(env, invited, "workspace-account-a", "delivery.view", { scopeType: "project", publicId: "pa-project-a" })).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env, invited, "workspace-account-a", "member.manage", { scopeType: "workspace", publicId: "workspace-account-a" })).toBe(false);

    const revoked = await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "revoked@example.test", projectPublicId: "pa-project-a", capabilities: ["delivery.view"],
    }, "revoked-acceptance-test-01");
    if (revoked.outcome !== "created") throw new Error("revocation invitation was not created");
    const revokedPayload = await db.prepare("SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?")
      .bind(revoked.invitation.id).first<string>("payload_json");
    expect(await revokeWorkspaceInvitation(env, principal, "workspace-account-a", revoked.invitation.id)).toBe(true);
    expect(await db.prepare("SELECT status,payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?")
      .bind(revoked.invitation.id).first()).toMatchObject({ status: "cancelled", payload_json: '{"redacted":true}' });
    expect(await acceptPortalWorkspaceInvitation(env, { issuer, subject: "revoked", email: "revoked@example.test" }, (JSON.parse(revokedPayload!) as { token: string }).token)).toBe("denied");

    const expired = await createWorkspaceInvitation(env, principal, "workspace-account-a", {
      email: "expired@example.test", projectPublicId: "pa-project-a", capabilities: ["delivery.view"],
    }, "expired-acceptance-test-01");
    if (expired.outcome !== "created") throw new Error("expiry invitation was not created");
    const expiredPayload = await db.prepare("SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?")
      .bind(expired.invitation.id).first<string>("payload_json");
    await db.prepare("UPDATE portal_v2_invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").bind(expired.invitation.id).run();
    expect(await acceptPortalWorkspaceInvitation(env, { issuer, subject: "expired", email: "expired@example.test" }, (JSON.parse(expiredPayload!) as { token: string }).token)).toBe("denied");
  }, 30_000);

  it("protects the last manager and makes a suspended manager fail authorization immediately", async () => {
    expect(await suspendWorkspaceMember(env, principal, "workspace-account-a", "identity-one")).toBe("last_manager");
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES ('identity-manager-two',?,'manager-two','manager-two@example.test')").bind(issuer),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES ('membership-manager-two','workspace-account-a','identity-manager-two','operations','active')"),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES ('manager-two-view','workspace-account-a','identity-manager-two','workspace.view','allow','workspace','workspace-account-a','operations','active')`),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES ('manager-two-manage','workspace-account-a','identity-manager-two','member.manage','allow','workspace','workspace-account-a','operations','active')`),
    ]);
    const managerTwo = { issuer, subject: "manager-two", email: "manager-two@example.test" };
    expect(await suspendWorkspaceMember(env, principal, "workspace-account-a", "identity-manager-two")).toBe("suspended");
    expect(await authorizePortalWorkspaceCapability(env, managerTwo, "workspace-account-a", "member.manage", { scopeType: "workspace", publicId: "workspace-account-a" })).toBe(false);
    expect(await listWorkspaceAccess(env, managerTwo, "workspace-account-a")).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-account-a' AND identity_id NOT IN ('identity-manager-two') AND status='active'").first<number>("count")).toBeGreaterThan(0);
    expect(await transferWorkspaceManagerByStaff(env, "workspace-account-a", "identity-manager-two", "staff-admin-a")).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env, managerTwo, "workspace-account-a", "member.manage", { scopeType: "workspace", publicId: "workspace-account-a" })).toBe(true);
  });

  it("does not let a client suspension pretend to override a Project Alpha-managed member", async () => {
    await db.prepare("UPDATE portal_v2_workspace_memberships SET source_type='project_alpha' WHERE workspace_id='workspace-account-a' AND identity_id='identity-one'").run();
    expect(await suspendWorkspaceMember(env, principal, "workspace-account-a", "identity-one")).toBe("managed_source");
    expect(await db.prepare("SELECT status FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-account-a' AND identity_id='identity-one'").first("status")).toBe("active");
    await db.prepare("UPDATE portal_v2_workspace_memberships SET source_type='legacy' WHERE workspace_id='workspace-account-a' AND identity_id='identity-one'").run();
  });

  it("enforces same-origin and workspace authorization on membership HTTP routes", async () => {
    const router = createClientPortalRouter({ resolvePrincipal: async () => principal, repository: d1ClientPortalRepository });
    const outboxBefore = await db.prepare("SELECT COUNT(*) count FROM portal_v2_invitation_email_outbox").first<number>("count");
    const disabled = await router.request("https://client.test/v2/workspaces/workspace-account-a/invitations", {
      method: "POST", headers: { Origin: "https://client.test", "Content-Type": "application/json", "Idempotency-Key": "route-disabled-test-0001" },
      body: JSON.stringify({ email: "route@example.test", projectPublicId: "pa-project-a", capabilities: ["delivery.view"] }),
    }, { ...env, CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: "false" });
    expect(disabled.status).toBe(404);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_invitation_email_outbox").first<number>("count")).toBe(outboxBefore);

    const deliveryDisabled = await router.request("https://client.test/v2/workspaces/workspace-account-a/invitations", {
      method: "POST", headers: { Origin: "https://client.test", "Content-Type": "application/json", "Idempotency-Key": "route-email-disabled-0001" },
      body: JSON.stringify({ email: "route@example.test", projectPublicId: "pa-project-a", capabilities: ["delivery.view"] }),
    }, { ...env, CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: "false" });
    expect(deliveryDisabled.status).toBe(503);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_invitation_email_outbox").first<number>("count")).toBe(outboxBefore);

    const forbiddenOrigin = await router.request("https://client.test/v2/workspaces/workspace-account-a/invitations", {
      method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json", "Idempotency-Key": "route-origin-test-000001" },
      body: JSON.stringify({ email: "route@example.test", projectPublicId: "pa-project-a", capabilities: ["delivery.view"] }),
    }, env);
    expect(forbiddenOrigin.status).toBe(403);

    const crossWorkspace = await router.request("https://client.test/v2/workspaces/workspace-b/invitations", {
      method: "POST", headers: { Origin: "https://client.test", "Content-Type": "application/json", "Idempotency-Key": "route-idor-test-0000001" },
      body: JSON.stringify({ email: "route@example.test", organizationWide: true, confirmOrganizationWide: true, capabilities: ["delivery.view"] }),
    }, env);
    expect(crossWorkspace.status).toBe(404);

    const valid = await router.request("https://client.test/v2/workspaces/workspace-account-a/invitations", {
      method: "POST", headers: { Origin: "https://client.test", "Content-Type": "application/json", "Idempotency-Key": "route-valid-test-0000001" },
      body: JSON.stringify({ email: "route@example.test", projectPublicId: "pa-project-a", capabilities: ["delivery.view"] }),
    }, env);
    expect(valid.status).toBe(201);
  }, 30_000);

  it("rejects duplicate, incomplete, and out-of-order directory cutovers", async () => {
    await expect(db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES ('generation-replay','workspace-account-a','other',0,'active',1)").run())
      .rejects.toThrow();
    await db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES ('generation-incomplete','workspace-account-a','incomplete',1,'staging',0)").run();
    await expect(db.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='generation-incomplete',source_sequence=1 WHERE workspace_id='workspace-account-a'").run())
      .rejects.toThrow(/complete active generation/);
    await db.batch([
      db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES ('generation-two','workspace-account-a','two',2,'active',1)"),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES ('workspace-account-a','generation-two','organization','pa-org-a','Alpha Org','2')"),
    ]);
    await db.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='generation-two',source_sequence=2 WHERE workspace_id='workspace-account-a'").run();
    await expect(db.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='legacy-generation-account-a',source_sequence=0 WHERE workspace_id='workspace-account-a'").run())
      .rejects.toThrow(/stale or conflicting/);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
