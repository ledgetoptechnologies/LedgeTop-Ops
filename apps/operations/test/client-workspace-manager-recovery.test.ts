import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listClientWorkspaceManagerRecovery,
  transferClientWorkspaceManager,
} from "../src/worker/client-workspace-manager-recovery";
import type { Env, StaffPrincipal } from "../src/worker/types";

describe("staff client workspace manager recovery", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;
  const principal = { id: "staff-recovery", email: "staff@example.test", displayName: "Recovery Staff" } as StaffPrincipal;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-16", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "manager-recovery" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE portal_v2_workspaces(
        id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,legacy_account_id TEXT,
        project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
      );
      CREATE TABLE portal_v2_identities(
        id TEXT PRIMARY KEY,verified_email TEXT,status TEXT NOT NULL,revoked_at TEXT
      );
      CREATE TABLE portal_v2_workspace_memberships(
        workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,status TEXT NOT NULL,source_type TEXT NOT NULL,
        expires_at TEXT,revoked_at TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(workspace_id,identity_id)
      );
      CREATE TABLE portal_v2_entitlements(
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,capability TEXT NOT NULL,
        effect TEXT NOT NULL,scope_type TEXT NOT NULL,scope_public_id TEXT NOT NULL,entitlement_version INTEGER NOT NULL DEFAULT 1,
        source_type TEXT NOT NULL,status TEXT NOT NULL,valid_from TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,revoked_at TEXT,
        UNIQUE(workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version)
      );
      CREATE TABLE portal_v2_membership_audit(
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,actor_identity_id TEXT,action TEXT NOT NULL,
        subject_identity_id TEXT,invitation_id TEXT,details_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `.replace(/\s*\n\s*/g, " "));
    await db.batch([
      db.prepare("INSERT INTO portal_v2_workspaces(id,display_name,status,legacy_account_id) VALUES ('workspace-a','Alpha Client','active','account-a')"),
      db.prepare("INSERT INTO portal_v2_identities(id,verified_email,status) VALUES ('manager-old','old@example.test','active')"),
      db.prepare("INSERT INTO portal_v2_identities(id,verified_email,status) VALUES ('manager-new','new@example.test','active')"),
      db.prepare("INSERT INTO portal_v2_identities(id,verified_email,status) VALUES ('pa-manager','pa@example.test','active')"),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(workspace_id,identity_id,status,source_type) VALUES ('workspace-a','manager-old','active','client_invitation')"),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(workspace_id,identity_id,status,source_type) VALUES ('workspace-a','manager-new','suspended','client_invitation')"),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(workspace_id,identity_id,status,source_type) VALUES ('workspace-a','pa-manager','active','project_alpha')"),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('old-manage','workspace-a','manager-old','member.manage','allow','workspace','workspace-a','client_invitation','active')"),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('pa-manage','workspace-a','pa-manager','member.manage','allow','workspace','workspace-a','project_alpha','active')"),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('pa-view','workspace-a','pa-manager','workspace.view','allow','workspace','workspace-a','project_alpha','active')"),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('new-delivery','workspace-a','manager-new','delivery.view','allow','workspace','workspace-a','client_invitation','suspended')"),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('new-request','workspace-a','manager-new','request.create','allow','workspace','workspace-a','client_invitation','suspended')"),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('new-share','workspace-a','manager-new','delegated_share.create','allow','workspace','workspace-a','client_invitation','suspended')"),
    ]);
    env = { DELIVERY_DB: db, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true" } as Env;
  });

  afterAll(async () => miniflare.dispose());

  it("lists only explicit workspace members and transfers before atomically offboarding the old local manager", async () => {
    const listed = await listClientWorkspaceManagerRecovery(env);
    expect(listed.workspaces).toHaveLength(1);
    expect(listed.workspaces[0]?.members.map(member => [member.identityId, member.manager])).toEqual([
      ["manager-new", false], ["manager-old", true], ["pa-manager", true],
    ]);

    await transferClientWorkspaceManager(env, principal, "workspace-a", {
      targetIdentityId: "manager-new", previousManagerIdentityId: "manager-old", suspendPrevious: true,
    });
    expect(await db.prepare("SELECT status FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-a' AND identity_id='manager-new'").first("status")).toBe("active");
    expect(await db.prepare("SELECT status FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-a' AND identity_id='manager-old'").first("status")).toBe("suspended");
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_entitlements WHERE workspace_id='workspace-a' AND identity_id='manager-new' AND capability='member.manage' AND status='active'").first("count")).toBe(1);
    expect((await db.prepare("SELECT capability,status FROM portal_v2_entitlements WHERE id IN ('new-delivery','new-request','new-share') ORDER BY capability").all()).results)
      .toEqual([
        { capability: "delegated_share.create", status: "suspended" },
        { capability: "delivery.view", status: "suspended" },
        { capability: "request.create", status: "suspended" },
      ]);
    const audit = await db.prepare("SELECT action,details_json FROM portal_v2_membership_audit WHERE subject_identity_id='manager-new'").first<{ action: string; details_json: string }>();
    expect(audit?.action).toBe("manager.transferred");
    expect(JSON.parse(audit!.details_json)).toMatchObject({ staffActorId: principal.id, previousManagerIdentityId: "manager-old", previousManagerSuspended: true });
  });

  it("never removes a Project Alpha-managed manager locally and leaves the last manager active after a failed replacement", async () => {
    await expect(transferClientWorkspaceManager(env, principal, "workspace-a", {
      targetIdentityId: "missing-member", previousManagerIdentityId: "pa-manager", suspendPrevious: true,
    })).rejects.toMatchObject({ status: 404 });
    expect(await db.prepare("SELECT status FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-a' AND identity_id='pa-manager'").first("status")).toBe("active");
    await expect(transferClientWorkspaceManager(env, principal, "workspace-a", {
      targetIdentityId: "manager-new", previousManagerIdentityId: "pa-manager", suspendPrevious: true,
    })).rejects.toMatchObject({ status: 409 });
    expect(await db.prepare("SELECT status FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-a' AND identity_id='pa-manager'").first("status")).toBe("active");
  });

  it("rejects an expired replacement without suspending the outgoing manager", async () => {
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,verified_email,status) VALUES ('manager-expired','expired@example.test','active')"),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(workspace_id,identity_id,status,source_type,expires_at) VALUES ('workspace-a','manager-expired','suspended','client_invitation','2000-01-01T00:00:00Z')"),
    ]);
    await expect(transferClientWorkspaceManager(env, principal, "workspace-a", {
      targetIdentityId: "manager-expired", previousManagerIdentityId: "manager-new", suspendPrevious: true,
    })).rejects.toMatchObject({ status: 404 });
    expect(await db.prepare("SELECT status FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-a' AND identity_id='manager-new'").first("status")).toBe("active");
  });

  it("does not suspend the outgoing manager when the replacement is revoked between review and the atomic batch", async () => {
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,verified_email,status) VALUES ('manager-race','race@example.test','active')"),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(workspace_id,identity_id,status,source_type) VALUES ('workspace-a','manager-race','suspended','client_invitation')"),
    ]);
    let intercepted = false;
    let raceDatabase: D1Database;
    raceDatabase = new Proxy(db as object, {
      get(target, property) {
        if (property === "withSession") return () => raceDatabase;
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          if (!intercepted) {
            intercepted = true;
            await db.prepare("UPDATE portal_v2_workspace_memberships SET revoked_at=datetime('now') WHERE workspace_id='workspace-a' AND identity_id='manager-race'").run();
          }
          return db.batch(statements);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as D1Database;
    await expect(transferClientWorkspaceManager({ ...env, DELIVERY_DB: raceDatabase }, principal, "workspace-a", {
      targetIdentityId: "manager-race", previousManagerIdentityId: "manager-new", suspendPrevious: true,
    })).rejects.toMatchObject({ status: 409 });
    expect(intercepted).toBe(true);
    expect(await db.prepare("SELECT status FROM portal_v2_workspace_memberships WHERE workspace_id='workspace-a' AND identity_id='manager-new'").first("status")).toBe("active");
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_membership_audit WHERE subject_identity_id='manager-race' AND action='manager.transferred'").first("count")).toBe(0);
  });

  it("is unavailable while the hierarchy rollout flag is false", async () => {
    await expect(listClientWorkspaceManagerRecovery({ ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false" })).rejects.toMatchObject({ status: 404 });
  });
});
