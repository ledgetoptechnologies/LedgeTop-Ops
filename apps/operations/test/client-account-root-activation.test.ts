import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateClientAccountRoot,
  listClientAccountRootActivation,
} from "../src/worker/client-account-root-activation";
import type { Env, StaffPrincipal } from "../src/worker/types";

describe("legacy client account Project Alpha root activation", () => {
  let miniflare: Miniflare;
  let deliveryDb: D1Database;
  let opsDb: D1Database;
  let env: Env;
  const principal = {
    id: "staff-admin",
    email: "admin@example.test",
    displayName: "Admin",
  } as StaffPrincipal;

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-22",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "activation-delivery", OPS_DB: "activation-ops" },
    });
    deliveryDb = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    opsDb = await miniflare.getD1Database("OPS_DB") as unknown as D1Database;
    await deliveryDb.exec(`
      CREATE TABLE client_accounts(
        id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,
        project_alpha_client_id TEXT,project_alpha_organization_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT NOT NULL,actor_id TEXT,
        action TEXT NOT NULL,entity_type TEXT,entity_id TEXT,details_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO client_accounts(id,display_name,status,updated_at)
        VALUES ('legacy-account','Legacy Client','active','2026-08-16T00:00:00Z');
      INSERT INTO client_accounts(id,display_name,status,updated_at)
        VALUES ('other-account','Other Client','active','2026-08-16T00:00:00Z');
    `.replace(/\s*\n\s*/g, " "));
    await opsDb.exec(`
      CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL);
      CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,organization_id TEXT,active INTEGER NOT NULL);
      INSERT INTO pa_organizations(id,name,active) VALUES ('pa-org','PA Organization',1),('inactive-org','Inactive',0);
      INSERT INTO pa_clients(id,name,organization_id,active) VALUES
        ('pa-client','PA Client','pa-org',1),
        ('pa-standalone','Standalone Client',NULL,1),
        ('orphaned-client','Orphaned Client','inactive-org',1),
        ('inactive-client','Inactive Client',NULL,0);
    `.replace(/\s*\n\s*/g, " "));
    env = { DELIVERY_DB: deliveryDb, OPS_DB: opsDb } as Env;
  });

  afterEach(async () => miniflare.dispose());

  it("preflights only active, internally consistent PA clients without mutating data", async () => {
    const result = await listClientAccountRootActivation(env);
    expect(result.workspaceMigrationApplied).toBe(false);
    expect(result.accounts.map(account => [account.id, account.activationState])).toEqual([
      ["legacy-account", "unlinked"],
      ["other-account", "unlinked"],
    ]);
    expect(result.sources).toEqual([
      {
        clientId: "pa-client",
        clientName: "PA Client",
        organizationId: "pa-org",
        organizationName: "PA Organization",
        rootType: "organization",
        rootPublicId: "pa-org",
      },
      {
        clientId: "pa-standalone",
        clientName: "Standalone Client",
        organizationId: null,
        organizationName: null,
        rootType: "standalone_client",
        rootPublicId: "pa-standalone",
      },
    ]);
    expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM audit_log").first("count")).toBe(0);
  });

  it("derives one organization root, retains the concrete PA client, and writes one audit record", async () => {
    const activated = await activateClientAccountRoot(env, principal, "legacy-account", {
      projectAlphaClientId: "pa-client",
      expectedUpdatedAt: "2026-08-16T00:00:00Z",
    });
    expect(activated).toMatchObject({
      accountId: "legacy-account",
      projectAlphaClientId: "pa-client",
      projectAlphaOrganizationId: "pa-org",
      rootType: "organization",
      rootPublicId: "pa-org",
      unchanged: false,
    });
    expect(await deliveryDb.prepare(`SELECT project_alpha_client_id,project_alpha_organization_id
      FROM client_accounts WHERE id='legacy-account'`).first()).toEqual({
      project_alpha_client_id: "pa-client",
      project_alpha_organization_id: "pa-org",
    });
    const audit = await deliveryDb.prepare("SELECT action,details_json FROM audit_log").first<{
      action: string;
      details_json: string;
    }>();
    expect(audit?.action).toBe("client.account.project_alpha_root_linked");
    expect(JSON.parse(audit!.details_json)).toMatchObject({
      projectAlphaClientId: "pa-client",
      workspaceRootType: "organization",
      workspaceRootPublicId: "pa-org",
      preMigrationActivation: true,
    });

    const replay = await activateClientAccountRoot(env, principal, "legacy-account", {
      projectAlphaClientId: "pa-client",
      expectedUpdatedAt: "stale-but-idempotent",
    });
    expect(replay.unchanged).toBe(true);
    expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM audit_log").first("count")).toBe(1);
  });

  it("fails closed on remapping, duplicate roots, stale versions, and inactive source ancestry", async () => {
    await activateClientAccountRoot(env, principal, "legacy-account", {
      projectAlphaClientId: "pa-client",
      expectedUpdatedAt: "2026-08-16T00:00:00Z",
    });
    await expect(activateClientAccountRoot(env, principal, "legacy-account", {
      projectAlphaClientId: "pa-standalone",
      expectedUpdatedAt: "2026-08-16T00:00:00Z",
    })).rejects.toMatchObject({ status: 409 });
    await expect(activateClientAccountRoot(env, principal, "other-account", {
      projectAlphaClientId: "pa-client",
      expectedUpdatedAt: "2026-08-16T00:00:00Z",
    })).rejects.toMatchObject({ status: 409 });
    await expect(activateClientAccountRoot(env, principal, "other-account", {
      projectAlphaClientId: "pa-standalone",
      expectedUpdatedAt: "wrong-version",
    })).rejects.toMatchObject({ status: 409 });
    await expect(activateClientAccountRoot(env, principal, "other-account", {
      projectAlphaClientId: "orphaned-client",
      expectedUpdatedAt: "2026-08-16T00:00:00Z",
    })).rejects.toMatchObject({ status: 404 });
    expect(await deliveryDb.prepare("SELECT project_alpha_client_id FROM client_accounts WHERE id='other-account'").first("project_alpha_client_id")).toBeNull();
  });

  it("rolls the account update back when its mandatory audit insert fails", async () => {
    await deliveryDb.prepare(`CREATE TRIGGER reject_root_audit BEFORE INSERT ON audit_log
      WHEN NEW.action='client.account.project_alpha_root_linked'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`).run();
    await expect(activateClientAccountRoot(env, principal, "legacy-account", {
      projectAlphaClientId: "pa-client",
      expectedUpdatedAt: "2026-08-16T00:00:00Z",
    })).rejects.toThrow("audit unavailable");
    expect(await deliveryDb.prepare(`SELECT project_alpha_client_id,project_alpha_organization_id,updated_at
      FROM client_accounts WHERE id='legacy-account'`).first()).toEqual({
      project_alpha_client_id: null,
      project_alpha_organization_id: null,
      updated_at: "2026-08-16T00:00:00Z",
    });
    expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM audit_log").first("count")).toBe(0);
  });

  it("refuses late legacy linking after migration 0121 and reports missing versus completed projections", async () => {
    await deliveryDb.exec(`
      CREATE TABLE portal_v2_workspaces(
        id TEXT PRIMARY KEY,legacy_account_id TEXT UNIQUE,root_type TEXT NOT NULL,
        pa_organization_public_id TEXT,pa_client_public_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL
      );
      UPDATE client_accounts SET project_alpha_client_id='pa-client',project_alpha_organization_id='pa-org'
        WHERE id='legacy-account';
      INSERT INTO portal_v2_workspaces(id,legacy_account_id,root_type,pa_organization_public_id,display_name,status)
        VALUES ('workspace-legacy-account','legacy-account','organization','pa-org','Legacy Client','active');
      UPDATE client_accounts SET project_alpha_client_id='pa-standalone' WHERE id='other-account';
    `.replace(/\s*\n\s*/g, " "));
    const result = await listClientAccountRootActivation(env);
    expect(result.workspaceMigrationApplied).toBe(true);
    expect(result.accounts.map(account => [account.id, account.activationState])).toEqual([
      ["legacy-account", "projected"],
      ["other-account", "projection_missing"],
    ]);
    await deliveryDb.prepare("INSERT INTO client_accounts(id,display_name,status,updated_at) VALUES ('late-account','Late','active','v1')").run();
    await expect(activateClientAccountRoot(env, principal, "late-account", {
      projectAlphaClientId: "pa-standalone",
      expectedUpdatedAt: "v1",
    })).rejects.toMatchObject({ status: 409 });
  });
});
