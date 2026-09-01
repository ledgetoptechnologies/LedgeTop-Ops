import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateClientAccountRoot,
  listClientAccountRootActivation,
} from "../src/worker/client-account-root-activation";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { authorizePortalWorkspaceCapability } from "../../client/src/worker/client-portal/workspace-v2";

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
        project_alpha_client_id TEXT,project_alpha_organization_id TEXT,project_alpha_source_id TEXT,
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
      CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL,
        last_sync_id TEXT NOT NULL,updated_at TEXT NOT NULL,
        projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,organization_id TEXT,active INTEGER NOT NULL,
        last_sync_id TEXT NOT NULL,updated_at TEXT NOT NULL,
        projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      INSERT INTO pa_organizations(id,name,active,last_sync_id,updated_at) VALUES
        ('pa-org','PA Organization',1,'sync-org','2026-08-16T00:00:00Z'),
        ('inactive-org','Inactive',0,'sync-inactive-org','2026-08-16T00:00:00Z');
      INSERT INTO pa_clients(id,name,organization_id,active,last_sync_id,updated_at) VALUES
        ('pa-client','PA Client','pa-org',1,'sync-client','2026-08-16T00:00:00Z'),
        ('pa-standalone','Standalone Client',NULL,1,'sync-standalone','2026-08-16T00:00:00Z'),
        ('orphaned-client','Orphaned Client','inactive-org',1,'sync-orphan','2026-08-16T00:00:00Z'),
        ('inactive-client','Inactive Client',NULL,0,'sync-inactive','2026-08-16T00:00:00Z');
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

  it("does not activate a secondary Delivery account with equal primary Alpha IDs", async () => {
    await deliveryDb.prepare(`UPDATE client_accounts SET project_alpha_source_id='project-alpha:secondary',
      project_alpha_client_id='pa-client',project_alpha_organization_id='pa-org' WHERE id='other-account'`).run();
    const list = await listClientAccountRootActivation(env);
    expect(list.accounts.some(account => account.id === "other-account")).toBe(false);
    await expect(activateClientAccountRoot(env, principal, "other-account", {
      projectAlphaClientId: "pa-client", expectedUpdatedAt: "2026-08-16T00:00:00Z",
    })).rejects.toMatchObject({ status: 409 });
    expect(await deliveryDb.prepare("SELECT count(*) count FROM audit_log").first("count")).toBe(0);
    // A secondary duplicate cannot prevent the actual primary root activation.
    await expect(activateClientAccountRoot(env, principal, "legacy-account", {
      projectAlphaClientId: "pa-client", expectedUpdatedAt: "2026-08-16T00:00:00Z",
    })).resolves.toMatchObject({ unchanged: false, projectAlphaClientId: "pa-client" });
  });

  it.each(["pa-local-secondary-client", "pa-local-secondary-standalone", "primary-client-secondary-ancestor"])(
    "excludes unsupported source %s and rejects direct activation without Delivery writes", async clientId => {
      await seedSecondaryActivationSources(opsDb);
      const before = (await deliveryDb.prepare("SELECT * FROM client_accounts ORDER BY id").all()).results;
      const result = await listClientAccountRootActivation(env);
      expect(result.sources.map(source => source.clientId)).toEqual(["pa-client", "pa-standalone"]);
      await deliveryDb.prepare(`CREATE TRIGGER forbid_unsupported_activation BEFORE UPDATE ON client_accounts
        BEGIN SELECT RAISE(ABORT,'unexpected Delivery write'); END`).run();
      await expect(activateClientAccountRoot(env, principal, "legacy-account", {
        projectAlphaClientId: clientId, expectedUpdatedAt: "2026-08-16T00:00:00Z",
      })).rejects.toMatchObject({ status: 404 });
      expect((await deliveryDb.prepare("SELECT * FROM client_accounts ORDER BY id").all()).results).toEqual(before);
      expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM audit_log").first("count")).toBe(0);
    },
  );

  it("fails closed on remapping, duplicate roots, stale versions, and inactive source ancestry", async () => {
    await expect(activateClientAccountRoot(env, principal, "a".repeat(119), {
      projectAlphaClientId: "pa-standalone",
      expectedUpdatedAt: "v1",
    })).rejects.toMatchObject({ status: 400 });
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

  it("fails closed when the workspace migration schema or projection is incomplete", async () => {
    await deliveryDb.exec(`
      CREATE TABLE portal_v2_workspaces(
        id TEXT PRIMARY KEY,legacy_account_id TEXT UNIQUE,root_type TEXT NOT NULL,
        pa_organization_public_id TEXT,pa_client_public_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL,
        project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
      );
      UPDATE client_accounts SET project_alpha_source_id='project-alpha:primary',project_alpha_client_id='pa-client',project_alpha_organization_id='pa-org'
        WHERE id='legacy-account';
      INSERT INTO portal_v2_workspaces(id,legacy_account_id,root_type,pa_organization_public_id,display_name,status)
        VALUES ('workspace-legacy-account','legacy-account','organization','pa-org','Legacy Client','active');
      UPDATE client_accounts SET project_alpha_source_id='project-alpha:primary',project_alpha_client_id='pa-standalone' WHERE id='other-account';
    `.replace(/\s*\n\s*/g, " "));
    const result = await listClientAccountRootActivation(env);
    expect(result.workspaceMigrationApplied).toBe(true);
    expect(result.accounts.map(account => [account.id, account.activationState])).toEqual([
      ["legacy-account", "manual_review"],
      ["other-account", "manual_review"],
    ]);
    await deliveryDb.prepare("INSERT INTO client_accounts(id,display_name,status,updated_at) VALUES ('late-account','Late','active','v1')").run();
    await expect(activateClientAccountRoot(env, principal, "late-account", {
      projectAlphaClientId: "pa-standalone",
      expectedUpdatedAt: "v1",
    })).rejects.toMatchObject({ status: 409 });
  });
});

async function seedSecondaryActivationSources(db: D1Database) {
  await db.batch([
    db.prepare(`INSERT INTO pa_organizations(id,name,active,last_sync_id,updated_at,projection_source_id)
      VALUES('pa-local-secondary-org','Secondary organization',1,'secondary','2026-08-16','project-alpha:secondary')`),
    db.prepare(`INSERT INTO pa_clients(id,name,organization_id,active,last_sync_id,updated_at,projection_source_id) VALUES
      ('pa-local-secondary-client','Secondary client','pa-local-secondary-org',1,'secondary','2026-08-16','project-alpha:secondary'),
      ('pa-local-secondary-standalone','Secondary standalone',NULL,1,'secondary','2026-08-16','project-alpha:secondary'),
      ('primary-client-secondary-ancestor','Invalid historical link','pa-local-secondary-org',1,'primary','2026-08-16','project-alpha:primary')`),
  ]);
}

async function applyClientMigrationsWithUnrootedFixture(db: D1Database) {
  const migrationsDirectory = fileURLToPath(new URL("../../client/migrations/", import.meta.url));
  for (const migration of readdirSync(migrationsDirectory).filter(name => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../../client/migrations/${migration}`, import.meta.url), "utf8")
      .replace(/\r\n/g, "\n");
    if (/\bCREATE\s+TRIGGER\b/i.test(sql)) {
      await db.exec(sql
        .replace(/^\s*--.*$/gm, "")
        .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
        .replace(/\s*\n\s*/g, " "));
    } else {
      const statements = sql.split(/;\s*(?:\n|$)/)
        .map(statement => statement.replace(/^\s*--.*$/gm, "").trim())
        .filter(statement => statement && !/^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(statement))
        .map(statement => db.prepare(statement));
      if (migration === "0103_client_portal_workspace.sql") await db.batch(statements);
      else for (const statement of statements) await statement.run();
    }
    // Production had this active, unrooted account before the pending
    // 0114-0142 migrations. Seeding after the last applied migration (0112)
    // reproduces that exact upgrade boundary: 0121 intentionally cannot create
    // a workspace until an administrator selects a concrete PA public root.
    if (migration === "0112_public_share_location_privacy.sql") {
      await db.batch([
        db.prepare(`INSERT INTO staff_users(id,email,role) VALUES
          ('staff-admin','admin@example.test','admin')`),
        db.prepare(`INSERT INTO client_accounts(id,display_name,status,created_at,updated_at)
          VALUES ('late-account','Late Client','active','2026-08-16T00:00:00Z','2026-08-16T00:00:00Z')`),
        db.prepare(`INSERT INTO client_identity_links
          (id,account_id,issuer,subject,email,created_at,last_seen_at)
          VALUES ('late-identity','late-account','https://issuer.test','late-subject',
            'late@example.test','2026-08-16T00:00:00Z','2026-08-16T01:00:00Z')`),
        db.prepare(`INSERT INTO client_account_members
          (account_id,identity_id,role,created_at,updated_at)
          VALUES ('late-account','late-identity','manager','2026-08-16T00:00:00Z','2026-08-16T00:00:00Z')`),
        db.prepare(`INSERT INTO projects
          (id,client_name,project_name,r2_prefix,project_alpha_project_id,created_by)
          VALUES ('late-project','Late Client','North Site','clients/late/',
            'pa-project-late','staff-admin')`),
        db.prepare(`INSERT INTO client_project_grants
          (account_id,project_id,can_request_service,granted_by)
          VALUES ('late-account','late-project',1,'staff-admin')`),
        db.prepare(`INSERT INTO client_folder_associations
          (id,scope_type,project_id,account_id,r2_prefix,created_by)
          VALUES ('late-folder','project','late-project','late-account',
            'clients/late/north/','staff-admin')`),
      ]);
    }
  }
  await db.prepare("PRAGMA foreign_keys=ON").run();
}

describe("post-0121 client account root activation on the real Client migration schema", () => {
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
      d1Databases: { DELIVERY_DB: "activation-real-delivery", OPS_DB: "activation-real-ops" },
    });
    deliveryDb = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    opsDb = await miniflare.getD1Database("OPS_DB") as unknown as D1Database;
    await applyClientMigrationsWithUnrootedFixture(deliveryDb);
    await opsDb.exec(`
      CREATE TABLE pa_organizations(
        id TEXT PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',last_sync_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
      );
      CREATE TABLE pa_clients(
        id TEXT PRIMARY KEY,name TEXT NOT NULL,organization_id TEXT,active INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',last_sync_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
      );
      INSERT INTO pa_organizations(id,name,active,last_sync_id,updated_at)
        VALUES ('pa-org-late','Late Organization',1,'sync-org-late','2026-08-17T00:00:00Z');
      INSERT INTO pa_clients(id,name,organization_id,active,last_sync_id,updated_at) VALUES
        ('pa-client-late','Late PA Client','pa-org-late',1,'sync-client-late','2026-08-17T00:00:00Z'),
        ('pa-linked','Linked PA Client',NULL,1,'sync-linked','2026-08-17T00:00:00Z'),
        ('pa-storage','Storage PA Client',NULL,1,'sync-storage','2026-08-17T00:00:00Z'),
        ('pa-partial','Partial PA Client',NULL,1,'sync-partial','2026-08-17T00:00:00Z'),
        ('pa-rollback','Rollback PA Client',NULL,1,'sync-rollback','2026-08-17T00:00:00Z'),
        ('pa-race','Race PA Client',NULL,1,'sync-race','2026-08-17T00:00:00Z'),
        ('pa-reparent','Reparented Client','pa-org-late',1,'sync-reparent','2026-08-17T00:00:00Z');
    `.replace(/\s*\n\s*/g, " "));
    env = { DELIVERY_DB: deliveryDb, OPS_DB: opsDb } as Env;
  }, 30_000);

  afterEach(async () => miniflare.dispose());

  it("creates, repairs, replays, rejects conflicts, rolls back, and remains race-safe", async () => {
    await seedSecondaryActivationSources(opsDb);
    const preflight = await listClientAccountRootActivation(env);
    expect(preflight.workspaceMigrationApplied).toBe(true);
    expect(preflight.accounts.find(account => account.id === "late-account")?.activationState).toBe("unlinked");
    expect(preflight.sources.some(source => source.clientId.includes("secondary"))).toBe(false);
    const beforeUnsupported = (await deliveryDb.prepare("SELECT * FROM client_accounts ORDER BY id").all()).results;
    const beforeAudit = await deliveryDb.prepare("SELECT COUNT(*) count FROM audit_log").first<number>("count");
    for (const clientId of ["pa-local-secondary-client", "pa-local-secondary-standalone", "primary-client-secondary-ancestor"]) {
      await expect(activateClientAccountRoot(env, principal, "late-account", {
        projectAlphaClientId: clientId, expectedUpdatedAt: "2026-08-16T00:00:00Z",
      })).rejects.toMatchObject({ status: 404 });
    }
    expect((await deliveryDb.prepare("SELECT * FROM client_accounts ORDER BY id").all()).results).toEqual(beforeUnsupported);
    expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM audit_log").first("count")).toBe(beforeAudit);
    expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM portal_v2_workspaces").first("count")).toBe(0);

    // A different producer may use the exact same root bytes. Its reserved,
    // unbridged workspace must neither block nor satisfy primary activation.
    await deliveryDb.batch([
      deliveryDb.prepare(`INSERT INTO pa_portal_workspace_sources
        (workspace_id,projection_source_id,source_workspace_id)
        VALUES('secondary-workspace','project-alpha:secondary','source-workspace')`),
      deliveryDb.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES('secondary-workspace','organization','pa-org-late','Other source','active','project-alpha:secondary')`),
      deliveryDb.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_source_id,updated_at)
        VALUES('storage-masquerade','Storage only','active','project-alpha:primary','storage-v1')`),
      deliveryDb.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES('storage-masquerade-identity','storage-masquerade','urn:ltds:native-request-storage',
          'storage-masquerade',NULL)`),
      deliveryDb.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_client_public_id,display_name,status,project_alpha_source_id)
        VALUES('storage-masquerade-workspace','standalone_client','pa-storage',
          'Storage only','active','project-alpha:primary')`),
      deliveryDb.prepare(`INSERT INTO portal_native_request_storage_bindings
        (workspace_id,source_id,account_id,storage_identity_id)
        VALUES('storage-masquerade-workspace','project-alpha:primary','storage-masquerade',
          'storage-masquerade-identity')`),
    ]);
    expect((await listClientAccountRootActivation(env)).accounts
      .some(account => account.id === "storage-masquerade")).toBe(false);
    await expect(activateClientAccountRoot(env, principal, "storage-masquerade", {
      projectAlphaClientId: "pa-storage", expectedUpdatedAt: "storage-v1",
    })).rejects.toMatchObject({ status: 404 });
    const activated = await activateClientAccountRoot(env, principal, "late-account", {
      projectAlphaClientId: "pa-client-late",
      expectedUpdatedAt: "2026-08-16T00:00:00Z",
    });
    expect(activated).toMatchObject({ unchanged: false, rootType: "organization", rootPublicId: "pa-org-late" });
    expect(await deliveryDb.prepare(`SELECT project_alpha_source_id FROM portal_v2_workspaces
      WHERE id='workspace-late-account'`).first("project_alpha_source_id")).toBe("project-alpha:primary");
    expect(await deliveryDb.prepare(`SELECT legacy_account_id FROM portal_v2_workspaces
      WHERE id='secondary-workspace'`).first("legacy_account_id")).toBeNull();
    expect(await deliveryDb.prepare(`SELECT root_type,pa_organization_public_id,pa_client_public_id,legacy_account_id
      FROM portal_v2_workspaces WHERE id='workspace-late-account'`).first()).toEqual({
      root_type: "organization",
      pa_organization_public_id: "pa-org-late",
      pa_client_public_id: null,
      legacy_account_id: "late-account",
    });
    expect(await deliveryDb.prepare(`SELECT schema_version FROM portal_v2_directory_generation_contracts
      WHERE generation_id='legacy-generation-late-account'`).first("schema_version")).toBe(2);
    expect(await deliveryDb.prepare(`SELECT COUNT(*) count FROM portal_v2_directory_entities
      WHERE workspace_id='workspace-late-account'`).first("count")).toBe(2);
    expect(await deliveryDb.prepare(`SELECT COUNT(*) count FROM portal_v2_entitlements
      WHERE workspace_id='workspace-late-account'`).first("count")).toBe(5);
    expect(await deliveryDb.prepare(`SELECT COUNT(*) count FROM portal_v2_folder_bindings
      WHERE workspace_id='workspace-late-account'`).first("count")).toBe(1);
    expect(await authorizePortalWorkspaceCapability({
      DELIVERY_DB: deliveryDb,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
    } as never, {
      issuer: "https://issuer.test",
      subject: "late-subject",
      email: "late@example.test",
    }, "workspace-late-account", "request.create", {
      scopeType: "project",
      publicId: "pa-project-late",
    })).toBe(true);
    expect(await deliveryDb.prepare(`SELECT action FROM audit_log
      WHERE entity_id='late-account' ORDER BY id DESC LIMIT 1`).first("action"))
      .toBe("client.account.project_alpha_root_linked");
    expect((await deliveryDb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    const replay = await activateClientAccountRoot(env, principal, "late-account", {
      projectAlphaClientId: "pa-client-late",
      expectedUpdatedAt: "stale-exact-replay",
    });
    expect(replay.unchanged).toBe(true);
    expect(await deliveryDb.prepare(`SELECT COUNT(*) count FROM audit_log
      WHERE entity_id='late-account' AND action='client.account.project_alpha_root_linked'`).first("count")).toBe(1);

    await deliveryDb.prepare(`UPDATE portal_v2_entitlements SET expires_at='2020-01-01T00:00:00Z'
      WHERE id='legacy-entitlement-late-account-late-identity-workspace-view'`).run();
    expect((await listClientAccountRootActivation(env)).accounts
      .find(account => account.id === "late-account")?.activationState).toBe("manual_review");
    await expect(activateClientAccountRoot(env, principal, "late-account", {
      projectAlphaClientId: "pa-client-late",
      expectedUpdatedAt: "stale-exact-replay",
    })).rejects.toMatchObject({ status: 409 });
    await deliveryDb.prepare(`UPDATE portal_v2_entitlements SET expires_at=NULL
      WHERE id='legacy-entitlement-late-account-late-identity-workspace-view'`).run();
    await deliveryDb.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
      VALUES ('unexpected-legacy-allow','workspace-late-account','late-identity',
        'delegated_share.create','allow','workspace','workspace-late-account','legacy','active')`).run();
    expect((await listClientAccountRootActivation(env)).accounts
      .find(account => account.id === "late-account")?.activationState).toBe("manual_review");
    await deliveryDb.prepare("DELETE FROM portal_v2_entitlements WHERE id='unexpected-legacy-allow'").run();
    expect((await listClientAccountRootActivation(env)).accounts
      .find(account => account.id === "late-account")?.activationState).toBe("projected");

    // A signed PA snapshot legitimately supersedes the exclusive legacy
    // baseline and may add non-legacy members/grants. Activation must recognize
    // that authoritative state, replay unchanged, and never lower its checkpoint.
    const accountVersionBeforeSignedReplay = await deliveryDb.prepare(`SELECT updated_at
      FROM client_accounts WHERE id='late-account'`).first<string>("updated_at");
    await deliveryDb.batch([
      deliveryDb.prepare(`INSERT INTO portal_v2_identities
        (id,issuer,subject,verified_email,status)
        VALUES ('signed-identity','https://issuer.test','signed-subject','signed@example.test','active')`),
      deliveryDb.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status,source_version)
        VALUES ('signed-membership','workspace-late-account','signed-identity','project_alpha','active','signed-v1')`),
      deliveryDb.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES ('signed-generation-late','workspace-late-account','signed-v1',1,'active',1,datetime('now'))`),
      deliveryDb.prepare(`INSERT INTO portal_v2_directory_generation_contracts
        (generation_id,workspace_id,schema_version)
        VALUES ('signed-generation-late','workspace-late-account',3)`),
      deliveryDb.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES ('workspace-late-account','signed-generation-late','organization','pa-org-late',NULL,
          'Late Organization','signed-v1',1)`),
      deliveryDb.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES ('workspace-late-account','signed-generation-late','project','pa-project-late','pa-org-late',
          'North Site','signed-v1',1)`),
      deliveryDb.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
          source_type,source_version,status)
        VALUES ('signed-workspace-view','workspace-late-account','signed-identity','workspace.view','allow',
          'workspace','workspace-late-account','project_alpha','signed-v1','active')`),
      deliveryDb.prepare(`UPDATE portal_v2_directory_checkpoints
        SET active_generation_id='signed-generation-late',source_sequence=1,updated_at=datetime('now')
        WHERE workspace_id='workspace-late-account'`),
      deliveryDb.prepare(`UPDATE portal_v2_directory_generations SET status='superseded'
        WHERE id='legacy-generation-late-account'`),
    ]);
    expect((await listClientAccountRootActivation(env)).accounts
      .find(account => account.id === "late-account")?.activationState).toBe("projected");
    const signedReplay = await activateClientAccountRoot(env, principal, "late-account", {
      projectAlphaClientId: "pa-client-late",
      expectedUpdatedAt: "intentionally-stale-after-signed-cutover",
    });
    expect(signedReplay.unchanged).toBe(true);
    expect(await deliveryDb.prepare(`SELECT active_generation_id,source_sequence
      FROM portal_v2_directory_checkpoints WHERE workspace_id='workspace-late-account'`).first()).toEqual({
      active_generation_id: "signed-generation-late",
      source_sequence: 1,
    });
    expect(await deliveryDb.prepare(`SELECT updated_at FROM client_accounts
      WHERE id='late-account'`).first("updated_at")).toBe(accountVersionBeforeSignedReplay);
    await deliveryDb.prepare(`UPDATE portal_v2_directory_generation_contracts SET schema_version=2
      WHERE generation_id='signed-generation-late' AND workspace_id='workspace-late-account'`).run();
    expect((await listClientAccountRootActivation(env)).accounts
      .find(account => account.id === "late-account")?.activationState).toBe("projected");
    expect((await activateClientAccountRoot(env, principal, "late-account", {
      projectAlphaClientId: "pa-client-late",
      expectedUpdatedAt: "still-stale-for-schema-v2-authoritative-replay",
    })).unchanged).toBe(true);
    expect(await deliveryDb.prepare(`SELECT active_generation_id,source_sequence
      FROM portal_v2_directory_checkpoints WHERE workspace_id='workspace-late-account'`).first()).toEqual({
      active_generation_id: "signed-generation-late",
      source_sequence: 1,
    });

    // An account linked before this repair was available can be completed only
    // when no projection rows exist and the exact optimistic version matches.
    await deliveryDb.batch([
      deliveryDb.prepare(`INSERT INTO client_accounts
        (id,display_name,status,project_alpha_client_id,updated_at,project_alpha_source_id)
        VALUES ('linked-account','Linked Account','active','pa-linked','linked-v1','project-alpha:primary')`),
      deliveryDb.prepare(`INSERT INTO client_identity_links
        (id,account_id,issuer,subject,email) VALUES
        ('linked-identity','linked-account','https://issuer.test','linked-subject','linked@example.test')`),
      deliveryDb.prepare(`INSERT INTO client_account_members(account_id,identity_id,role)
        VALUES ('linked-account','linked-identity','manager')`),
    ]);
    const repaired = await activateClientAccountRoot(env, principal, "linked-account", {
      projectAlphaClientId: "pa-linked",
      expectedUpdatedAt: "linked-v1",
    });
    expect(repaired.unchanged).toBe(false);
    expect(await deliveryDb.prepare(`SELECT action FROM audit_log
      WHERE entity_id='linked-account' ORDER BY id DESC LIMIT 1`).first("action"))
      .toBe("client.account.project_alpha_projection_repaired");

    await deliveryDb.batch([
      deliveryDb.prepare(`INSERT INTO client_accounts(id,display_name,status,updated_at)
        VALUES ('partial-account','Partial Account','active','partial-v1')`),
      deliveryDb.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_client_public_id,legacy_account_id,display_name,status)
        VALUES ('workspace-partial-account','standalone_client','wrong-root','partial-account','Partial Account','active')`),
    ]);
    await expect(activateClientAccountRoot(env, principal, "partial-account", {
      projectAlphaClientId: "pa-partial",
      expectedUpdatedAt: "partial-v1",
    })).rejects.toMatchObject({ status: 409 });
    expect(await deliveryDb.prepare(`SELECT project_alpha_client_id FROM client_accounts
      WHERE id='partial-account'`).first("project_alpha_client_id")).toBeNull();
    expect((await listClientAccountRootActivation(env)).accounts
      .find(account => account.id === "partial-account")?.activationState).toBe("manual_review");

    await deliveryDb.batch([
      deliveryDb.prepare(`INSERT INTO client_accounts(id,display_name,status,updated_at)
        VALUES ('reparent-account','Reparent Account','active','reparent-v1')`),
      deliveryDb.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_client_public_id,display_name,status)
        VALUES ('stale-standalone-workspace','standalone_client','pa-reparent','Stale standalone','active')`),
    ]);
    await expect(activateClientAccountRoot(env, principal, "reparent-account", {
      projectAlphaClientId: "pa-reparent",
      expectedUpdatedAt: "reparent-v1",
    })).rejects.toMatchObject({ status: 409 });

    await deliveryDb.prepare(`INSERT INTO client_accounts(id,display_name,status,updated_at)
      VALUES ('rollback-account','Rollback Account','active','rollback-v1')`).run();
    await deliveryDb.prepare(`CREATE TRIGGER reject_projection_audit BEFORE INSERT ON audit_log
      WHEN NEW.action='client.account.project_alpha_root_linked' AND NEW.entity_id='rollback-account'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`).run();
    await expect(activateClientAccountRoot(env, principal, "rollback-account", {
      projectAlphaClientId: "pa-rollback",
      expectedUpdatedAt: "rollback-v1",
    })).rejects.toMatchObject({ status: 409 });
    expect(await deliveryDb.prepare(`SELECT project_alpha_client_id,updated_at FROM client_accounts
      WHERE id='rollback-account'`).first()).toEqual({
      project_alpha_client_id: null,
      updated_at: "rollback-v1",
    });
    expect(await deliveryDb.prepare(`SELECT COUNT(*) count FROM portal_v2_workspaces
      WHERE legacy_account_id='rollback-account'`).first("count")).toBe(0);
    await deliveryDb.prepare("DROP TRIGGER reject_projection_audit").run();

    await deliveryDb.batch([
      deliveryDb.prepare(`INSERT INTO client_accounts(id,display_name,status,updated_at)
        VALUES ('race-a','Race A','active','race-v1')`),
      deliveryDb.prepare(`INSERT INTO client_accounts(id,display_name,status,updated_at)
        VALUES ('race-b','Race B','active','race-v1')`),
    ]);
    const race = await Promise.allSettled(["race-a", "race-b"].map(accountId =>
      activateClientAccountRoot(env, principal, accountId, {
        projectAlphaClientId: "pa-race",
        expectedUpdatedAt: "race-v1",
      })));
    expect(race.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await deliveryDb.prepare(`SELECT COUNT(*) count FROM client_accounts
      WHERE project_alpha_client_id='pa-race'`).first("count")).toBe(1);
    expect(await deliveryDb.prepare(`SELECT COUNT(*) count FROM portal_v2_workspaces
      WHERE pa_client_public_id='pa-race'`).first("count")).toBe(1);
    expect((await deliveryDb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 60_000);
});
