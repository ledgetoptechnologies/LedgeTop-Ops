import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAuthenticatedContentStart,
  authenticatedContentAuditRequired,
  authenticatedContentAuditReadiness,
  AuthenticatedContentAuditUnavailableError,
} from "../src/worker/client-portal/authenticated-content-audit";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const migration = readFileSync(new URL("../migrations/0187_authenticated_content_audit.sql", import.meta.url), "utf8");
const secret = "test-authenticated-content-audit-secret-that-is-long-enough";

describe("authenticated content audit foundation", () => {
  let runtime: Miniflare;
  let database: D1Database;
  let env: Pick<Env, "DELIVERY_DB" | "CLIENT_PORTAL_CONTENT_AUDIT_ENABLED" | "CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET">;

  beforeEach(async () => {
    runtime = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default { fetch(){ return new Response('ok') } }",
      d1Databases: { DELIVERY_DB: crypto.randomUUID() },
    });
    database = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await database.batch(splitD1MigrationStatements(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT,project_alpha_source_id TEXT);
      CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT,revoked_at TEXT);
      CREATE TABLE client_account_members(account_id TEXT,identity_id TEXT,role TEXT,revoked_at TEXT);
      CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,scope_type TEXT,r2_prefix TEXT,revoked_at TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,active INTEGER);
      CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,revoked_at TEXT);
      CREATE TABLE client_member_project_grants(account_id TEXT,identity_id TEXT,project_id TEXT,revoked_at TEXT);
      CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT);
      CREATE TABLE delivery_tombstones(physical_key TEXT,tombstone_kind TEXT,restored_at TEXT);
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT,project_alpha_source_id TEXT,legacy_account_id TEXT);
      CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT);
      CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,status TEXT,revoked_at TEXT);
      CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT);
      CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,revoked_at TEXT,source_version TEXT,
        owner_scope_type TEXT,owner_public_id TEXT,r2_prefix TEXT);
      CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,
        grant_version INTEGER,binding_source_version TEXT,status TEXT,revoked_at TEXT,expires_at TEXT);
      CREATE TABLE project_alpha_delivery_portal_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,
        grant_version INTEGER,binding_source_version TEXT,status TEXT,revoked_at TEXT,expires_at TEXT,receipt_id TEXT);
      CREATE TABLE portal_native_staff_grants(source_id TEXT,binding_id TEXT,grant_id TEXT,state TEXT);
      CREATE TABLE project_alpha_delivery_intent_receipts(receipt_id TEXT,project_alpha_source_id TEXT,access_mode TEXT,
        resource_id TEXT,status TEXT);
    `).map(statement => database.prepare(statement)));
    await database.batch([
      database.prepare("INSERT INTO client_accounts VALUES ('account-a','active',NULL)"),
      database.prepare("INSERT INTO client_identity_links VALUES ('identity-a','account-a',NULL)"),
      database.prepare("INSERT INTO client_account_members VALUES ('account-a','identity-a','manager',NULL)"),
      database.prepare("INSERT INTO client_folder_associations VALUES ('association-a','account-a','project-a','project','private/clients/Acme/',NULL)"),
      database.prepare("INSERT INTO projects VALUES ('project-a',1)"),
      database.prepare("INSERT INTO client_project_grants VALUES ('account-a','project-a',NULL)"),
      database.prepare("INSERT INTO file_index VALUES ('private/clients/Acme/roof inspection/source-image.jpg','private-etag-value')"),
      database.prepare("INSERT INTO portal_v2_workspaces VALUES ('workspace-native','active','project-alpha:secondary',NULL)"),
      database.prepare("INSERT INTO pa_portal_workspace_sources VALUES ('workspace-native','project-alpha:secondary')"),
      database.prepare("INSERT INTO portal_v2_identities VALUES ('identity-native','active',NULL)"),
      database.prepare("INSERT INTO portal_v2_workspace_memberships VALUES ('workspace-native','identity-native','active',NULL,NULL)"),
      database.prepare("INSERT INTO portal_v2_folder_bindings VALUES ('binding-7','workspace-native','active',NULL,'binding-v7','project','pa-project-7','native/private/')"),
      database.prepare("INSERT INTO portal_v2_authenticated_delivery_grants VALUES ('grant-9-v2','workspace-native','binding-7',2,'binding-v7','active',NULL,NULL)"),
      database.prepare("INSERT INTO portal_native_staff_grants VALUES ('project-alpha:secondary','binding-7','grant-9-v2','active')"),
      database.prepare("INSERT INTO file_index VALUES ('native/private/model.glb','version-4')"),
    ]);
    env = { DELIVERY_DB: database, CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET: secret,
      CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: "true" };
  });

  afterEach(async () => runtime.dispose());

  async function applyMigration(collectionStartedAt?: string): Promise<void> {
    await database.batch(splitD1MigrationStatements(migration).map(statement => database.prepare(statement)));
    if (collectionStartedAt) {
      await database.prepare(
        "UPDATE portal_authenticated_content_history_state SET collection_started_at=? WHERE singleton=1",
      ).bind(collectionStartedAt).run();
    }
  }

  const legacy = {
    authorityMode: "legacy_delivery" as const,
    sourceId: "delivery:local",
    workspaceId: "workspace-a",
    accountId: "account-a",
    projectId: "project-a",
    associationId: "association-a",
    identityId: "identity-a",
    action: "file.preview_requested" as const,
    storageKey: "private/clients/Acme/roof inspection/source-image.jpg",
    contentVersion: "private-etag-value",
  };

  it("creates an immutable singleton and immutable, authority-shaped events", async () => {
    await applyMigration();
    const state = await database.prepare(
      "SELECT singleton,collection_started_at startedAt FROM portal_authenticated_content_history_state",
    ).first<{ singleton: number; startedAt: string }>();
    expect(state).toEqual({ singleton: 1, startedAt: null });
    const readiness = await authenticatedContentAuditReadiness(env);
    expect(readiness.ready).toBe(true);
    expect(readiness.collectionStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    await expect(database.prepare(
      "UPDATE portal_authenticated_content_history_state SET collection_started_at=? WHERE singleton=1",
    ).bind("2026-01-01T00:00:00.000Z").run()).rejects.toThrow(/immutable/);
    await expect(database.prepare(
      "INSERT INTO portal_authenticated_content_events(id,dedupe_key,dedupe_window,authority_mode,source_id,workspace_id,account_id,identity_id,project_id,project_public_id,association_id,folder_binding_id,grant_id,action,resource_fingerprint,content_version_fingerprint,resource_label,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind("bad", "a".repeat(43), 1, "native_delivery", "source", "workspace", "account-must-be-null", "identity", null, null, null, "binding", "grant", "file.preview_requested", "b".repeat(43), "c".repeat(43), "file.jpg", "2026-01-01T00:00:00.000Z").run()).rejects.toThrow();
  });

  it("deduplicates the same legacy content start within a bounded window without storing paths", async () => {
    await applyMigration("2026-09-01T12:00:00.000Z");
    const first = await appendAuthenticatedContentStart(env, legacy, new Date("2026-09-01T12:01:00.000Z"));
    const replay = await appendAuthenticatedContentStart(env, legacy, new Date("2026-09-01T12:09:59.999Z"));
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ id: first.id, occurredAt: first.occurredAt, replayed: true });

    const row = await database.prepare("SELECT * FROM portal_authenticated_content_events").first<Record<string, unknown>>();
    expect(row).toMatchObject({ authority_mode: "legacy_delivery", account_id: "account-a", project_id: "project-a",
      association_id: "association-a", resource_label: "source-image.jpg" });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(legacy.storageKey);
    expect(stored).not.toContain(legacy.contentVersion);
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_authenticated_content_events").first("count")).toBe(1);
    await expect(database.prepare(
      "UPDATE portal_authenticated_content_events SET resource_label='changed.jpg' WHERE id=?",
    ).bind(first.id).run()).rejects.toThrow(/immutable/);
    await expect(database.prepare("DELETE FROM portal_authenticated_content_events WHERE id=?").bind(first.id).run())
      .rejects.toThrow(/expired retention cutoff/);
    await database.batch([
      database.prepare("UPDATE portal_authenticated_content_retention_control SET delete_enabled=1,delete_before=? WHERE singleton=1")
        .bind("2099-01-01T00:00:00.000Z"),
      database.prepare("DELETE FROM portal_authenticated_content_events WHERE id=?").bind(first.id),
      database.prepare("UPDATE portal_authenticated_content_retention_control SET delete_enabled=0,delete_before=NULL WHERE singleton=1"),
    ]);
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_authenticated_content_events").first("count")).toBe(0);
  });

  it("separates actions and windows and records exact native authority coordinates", async () => {
    await applyMigration("2026-09-01T12:00:00.000Z");
    const preview = await appendAuthenticatedContentStart(env, legacy, new Date("2026-09-01T12:01:00.000Z"));
    const download = await appendAuthenticatedContentStart(env, { ...legacy, action: "file.download_requested" }, new Date("2026-09-01T12:01:01.000Z"));
    const later = await appendAuthenticatedContentStart(env, legacy, new Date("2026-09-01T12:10:00.000Z"));
    expect(new Set([preview.id, download.id, later.id]).size).toBe(3);

    await appendAuthenticatedContentStart(env, {
      authorityMode: "native_delivery",
      sourceId: "project-alpha:secondary",
      workspaceId: "workspace-native",
      projectPublicId: "pa-project-7",
      folderBindingId: "binding-7",
      grantId: "grant-9-v2",
      grantVersion: 2,
      grantSource: "staff",
      bindingSourceVersion: "binding-v7",
      ownerScopeType: "project",
      ownerPublicId: "pa-project-7",
      identityId: "identity-native",
      action: "file.download_requested",
      storageKey: "native/private/model.glb",
      contentVersion: "version-4",
    }, new Date("2026-09-01T12:02:00.000Z"));
    const native = await database.prepare(
      "SELECT source_id sourceId,workspace_id workspaceId,project_public_id projectPublicId,folder_binding_id folderBindingId,grant_id grantId,account_id accountId FROM portal_authenticated_content_events WHERE authority_mode='native_delivery'",
    ).first<Record<string, unknown>>();
    expect(native).toEqual({ sourceId: "project-alpha:secondary", workspaceId: "workspace-native",
      projectPublicId: "pa-project-7", folderBindingId: "binding-7", grantId: "grant-9-v2", accountId: null });
  });

  it("is default-off and fails readiness closed for missing, partial, or invalid configuration", async () => {
    expect(await authenticatedContentAuditRequired({ ...env, CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: undefined })).toBe(false);
    expect(await authenticatedContentAuditReadiness({ ...env, CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: undefined }))
      .toEqual({ ready: false, reason: "disabled" });
    await expect(appendAuthenticatedContentStart({ ...env, CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: undefined }, legacy))
      .rejects.toMatchObject({ code: "AUTHENTICATED_CONTENT_AUDIT_UNAVAILABLE", reason: "disabled" });
    expect(await authenticatedContentAuditReadiness(env)).toEqual({ ready: false, reason: "schema_missing" });
    await database.exec("CREATE TABLE portal_authenticated_content_history_state(singleton INTEGER PRIMARY KEY,collection_started_at TEXT)");
    expect(await authenticatedContentAuditReadiness(env)).toEqual({ ready: false, reason: "schema_incomplete" });
    expect(await authenticatedContentAuditReadiness({ ...env, CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET: "too-short" }))
      .toEqual({ ready: false, reason: "configuration_invalid" });
  });

  it("cannot silently stop collection after the immutable start is established", async () => {
    await applyMigration();
    expect(await authenticatedContentAuditRequired({ ...env, CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: undefined })).toBe(false);
    expect((await authenticatedContentAuditReadiness(env)).ready).toBe(true);
    await expect(authenticatedContentAuditRequired({ ...env, CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: "false" }))
      .rejects.toMatchObject({ code: "AUTHENTICATED_CONTENT_AUDIT_UNAVAILABLE", reason: "disabled" });
  });

  it("does not report success when the immutable append cannot commit", async () => {
    await applyMigration();
    await database.prepare(`CREATE TRIGGER reject_authenticated_content_insert BEFORE INSERT ON portal_authenticated_content_events
      BEGIN SELECT RAISE(ABORT,'simulated audit write failure'); END`).run();
    await expect(appendAuthenticatedContentStart(env, legacy)).rejects.toThrow(/simulated audit write failure/);
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_authenticated_content_events").first("count")).toBe(0);
    expect(AuthenticatedContentAuditUnavailableError).toBeTypeOf("function");
  });

  it("fails closed when exact legacy or native authority is no longer current", async () => {
    await applyMigration();
    await database.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now') WHERE id='association-a'").run();
    await expect(appendAuthenticatedContentStart(env, legacy)).rejects.toMatchObject({
      code: "AUTHENTICATED_CONTENT_AUDIT_UNAVAILABLE", reason: "state_invalid",
    });
    await database.prepare("UPDATE client_folder_associations SET revoked_at=NULL WHERE id='association-a'").run();

    const native = {
      authorityMode: "native_delivery" as const, sourceId: "project-alpha:secondary", workspaceId: "workspace-native",
      projectPublicId: "pa-project-7", folderBindingId: "binding-7", grantId: "grant-9-v2", grantVersion: 2,
      grantSource: "staff" as const, bindingSourceVersion: "binding-v7", ownerScopeType: "project" as const,
      ownerPublicId: "pa-project-7", identityId: "identity-native", action: "file.preview_requested" as const,
      storageKey: "native/private/model.glb", contentVersion: "version-4",
    };
    await database.prepare("UPDATE portal_native_staff_grants SET state='revoked' WHERE grant_id='grant-9-v2'").run();
    await expect(appendAuthenticatedContentStart(env, native)).rejects.toMatchObject({
      code: "AUTHENTICATED_CONTENT_AUDIT_UNAVAILABLE", reason: "state_invalid",
    });
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_authenticated_content_events").first("count")).toBe(0);
  });
});
