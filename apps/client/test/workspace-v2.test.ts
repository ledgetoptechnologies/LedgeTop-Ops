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
  hashPortalInvitationToken,
  listPortalWorkspaces,
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
        id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1
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
        created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),revoked_at TEXT
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
    expect((await router.request("https://client.test/session", {}, env)).status).toBe(403);
    expect((await router.request("https://client.test/projects", {}, env)).status).toBe(403);
    const response = await router.request("https://client.test/v2/workspaces", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaces: [{ id: "workspace-b" }] });
  });

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
