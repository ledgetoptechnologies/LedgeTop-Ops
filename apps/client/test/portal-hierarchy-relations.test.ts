import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import hierarchyMigration from "../migrations/0121_client_workspace_hierarchy_v2.sql?raw";
import membershipMigration from "../migrations/0123_portal_v2_membership_management.sql?raw";
import projectionMigration from "../migrations/0125_project_alpha_portal_projection.sql?raw";
import scrubMigration from "../migrations/0127_portal_invitation_secret_scrub.sql?raw";
import relationMigration from "../migrations/0129_portal_hierarchy_relations.sql?raw";
import enrollmentReceiptMigration from "../migrations/0133_portal_invitation_access_enrollment_receipts.sql?raw";
import {
  authorizePortalWorkspaceCapability,
  listPortalWorkspaceHierarchy,
} from "../src/worker/client-portal/workspace-v2";
import { createWorkspaceInvitation, revokeWorkspaceInvitation } from "../src/worker/client-portal/workspace-memberships";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const principal: VerifiedClientPrincipal = {
  issuer: "https://access.example.test", subject: "manager-subject", email: "manager@example.test",
};

async function migrate(db: D1Database, sql: string): Promise<void> {
  await db.exec(sql.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
}

describe("portal relation hierarchy compatibility", () => {
  let mf: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    mf = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "relations-test" } });
    db = await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,project_alpha_source_id TEXT DEFAULT 'project-alpha:primary',project_alpha_client_id TEXT,project_alpha_organization_id TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),last_seen_at TEXT,UNIQUE(issuer,subject),UNIQUE(id,account_id));
      CREATE TABLE client_account_members(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,role TEXT NOT NULL,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(account_id,identity_id));
      CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT NOT NULL,active INTEGER DEFAULT 1);
      CREATE TABLE client_project_grants(account_id TEXT NOT NULL,project_id TEXT NOT NULL,can_request_service INTEGER DEFAULT 0,revoked_at TEXT,PRIMARY KEY(account_id,project_id));
      CREATE TABLE client_member_project_grants(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,project_id TEXT NOT NULL,revoked_at TEXT,PRIMARY KEY(account_id,identity_id,project_id));
      CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,project_id TEXT,account_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),revoked_at TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await migrate(db, hierarchyMigration);
    await migrate(db, membershipMigration);
    await migrate(db, projectionMigration);
    await migrate(db, scrubMigration);
    await migrate(db, relationMigration);
    await migrate(db, enrollmentReceiptMigration);
    await db.batch([
      db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status) VALUES ('ws-acme','organization','org-acme','Acme','active')"),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES ('manager',?,?,?,'active')").bind(principal.issuer, principal.subject, principal.email),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES ('membership-manager','ws-acme','manager','project_alpha','active')"),
      db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES ('gen-1','ws-acme','source-1',1,'active',1)"),
      ...[
        ["organization", "org-acme", "Acme"], ["department", "dept-field", "Field"],
        ["client", "client-owner", "Owner"], ["project", "project-one", "Project One"],
        ["project", "project-private", "Private"], ["contact", "contact-one", "Alex"],
      ].map(([type, id, name]) => db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES ('ws-acme','gen-1',?,?,?,'v1',1)`).bind(type, id, name)),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES ('ws-acme','gen-1',1)"),
      ...[
        ["r-org-dept", "contains", "organization", "org-acme", "department", "dept-field"],
        ["r-org-client", "contains", "organization", "org-acme", "client", "client-owner"],
        ["r-dept-project", "contains", "department", "dept-field", "project", "project-one"],
        ["r-client-project", "contains", "client", "client-owner", "project", "project-one"],
        ["r-client-private", "contains", "client", "client-owner", "project", "project-private"],
        ["r-dept-contact", "contact_assignment", "department", "dept-field", "contact", "contact-one"],
      ].map(values => db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
        VALUES ('ws-acme','gen-1',?,?,?,?,?,?,'v1')`).bind(...values)),
      db.prepare("INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version) VALUES ('ws-acme','gen-1','project-one','active','v1')"),
      db.prepare("INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version) VALUES ('ws-acme','gen-1','project-private','active','v1')"),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES ('view','ws-acme','manager','workspace.view','allow','workspace','ws-acme','project_alpha','active')`),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES ('directory-dept','ws-acme','manager','directory.read','allow','department','dept-field','project_alpha','active')`),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES ('manage-dept','ws-acme','manager','member.manage','allow','department','dept-field','project_alpha','active')`),
    ]);
    env = { DELIVERY_DB: db, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true", CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: "true" } as Env;
  }, 30_000);

  afterAll(async () => mf.dispose());

  it("uses versioned many-to-many edges and filters hierarchy to readable scopes", async () => {
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "project", publicId: "project-one" })).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "client", publicId: "client-owner" })).toBe(false);
    const entries = await listPortalWorkspaceHierarchy(env, principal, "ws-acme", null);
    expect(entries?.map(entry => entry.publicId).sort()).toEqual(["contact-one", "dept-field", "project-one"]);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_directory_relations WHERE to_public_id='contact-one'").first("count")).toBe(1);
  });

  it("evaluates hierarchy visibility as one bounded entitlement set", async () => {
    let entitlementQueries = 0;
    const countedDb = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") return (query: string) => {
          if (query.includes("entitlement_count(row_count)")) entitlementQueries += 1;
          return target.prepare(query);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const entries = await listPortalWorkspaceHierarchy({ ...env, DELIVERY_DB: countedDb }, principal, "ws-acme", null);
    expect(entries?.map(entry => entry.publicId).sort()).toEqual(["contact-one", "dept-field", "project-one"]);
    expect(entitlementQueries).toBe(1);
  });

  it("gives any matching deny precedence across a project's target scopes", async () => {
    await db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
      VALUES ('deny-client','ws-acme','manager','directory.read','deny','client','client-owner','project_alpha','active')`).run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "project", publicId: "project-one" })).toBe(false);
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='deny-client'").run();
  });

  it("expires completed project authority after 30 days and restores it on PA reopen", async () => {
    await db.prepare("UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=datetime('now','-29 days'),source_version='v2' WHERE project_public_id='project-one'").run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "project", publicId: "project-one" })).toBe(true);
    await db.prepare("UPDATE portal_v2_project_lifecycle SET completed_at=datetime('now','-31 days'),source_version='v3' WHERE project_public_id='project-one'").run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "project", publicId: "project-one" })).toBe(false);
    await db.prepare("UPDATE portal_v2_project_lifecycle SET lifecycle_status='active',completed_at=NULL,source_version='v4' WHERE project_public_id='project-one'").run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "project", publicId: "project-one" })).toBe(true);
  });

  it("applies project lifecycle retention to descendants as well as the project target", async () => {
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES ('ws-acme','gen-1','contact','contact-project-only','Project Contact','v1',1)`),
      db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
        VALUES ('ws-acme','gen-1','r-project-contact','contact_assignment','project','project-one','contact','contact-project-only','v1')`),
    ]);
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "contact", publicId: "contact-project-only" })).toBe(true);
    await db.prepare("UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=datetime('now','-31 days'),source_version='v5' WHERE project_public_id='project-one'").run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "contact", publicId: "contact-project-only" })).toBe(false);
    expect((await listPortalWorkspaceHierarchy(env, principal, "ws-acme", null))?.some(entry => entry.publicId === "contact-project-only")).toBe(false);
    await db.prepare("UPDATE portal_v2_project_lifecycle SET lifecycle_status='active',completed_at=NULL,source_version='v6' WHERE project_public_id='project-one'").run();
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "directory.read", { scopeType: "contact", publicId: "contact-project-only" })).toBe(true);
  });

  it("lets a scoped PA manager create only a local guest inside that scope", async () => {
    const created = await createWorkspaceInvitation(env, principal, "ws-acme", {
      email: "guest@example.test", projectPublicId: "project-one", capabilities: ["delivery.view"],
    }, "invite-project-one-0001");
    expect(created.outcome).toBe("created");
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_invitation_entitlements WHERE capability='member.manage'").first("count")).toBe(0);
    expect((await createWorkspaceInvitation(env, principal, "ws-acme", {
      email: "wide@example.test", organizationWide: true, confirmOrganizationWide: true, capabilities: ["delivery.view"],
    }, "invite-workspace-00001")).outcome).toBe("denied");
    expect(await authorizePortalWorkspaceCapability(env, principal, "ws-acme", "member.manage", { scopeType: "project", publicId: "project-one" })).toBe(true);
    expect(created.outcome === "created" && await revokeWorkspaceInvitation(env, principal, "ws-acme", created.invitation.id)).toBe(true);
  });

  it("is default-off, idempotent, and enforces relation endpoint integrity", async () => {
    expect(await authorizePortalWorkspaceCapability({ ...env, CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "false" }, principal, "ws-acme", "directory.read", { scopeType: "project", publicId: "project-one" })).toBe(false);
    await migrate(db, relationMigration);
    await expect(db.prepare(`INSERT INTO portal_v2_directory_relations
      (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
      VALUES ('ws-acme','gen-1','bad','contains','department','missing','project','project-one','v1')`).run()).rejects.toThrow();
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
