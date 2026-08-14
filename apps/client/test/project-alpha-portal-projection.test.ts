import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import hierarchyMigration from "../migrations/0121_client_workspace_hierarchy_v2.sql?raw";
import projectionMigration from "../migrations/0125_project_alpha_portal_projection.sql?raw";
import { authorizePortalWorkspaceCapability } from "../src/worker/client-portal/workspace-v2";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import { handleProjectAlphaPortalProjectionRequest, parsePortalProjectionDelivery } from "../src/worker/project-alpha-portal";
import type { Env } from "../src/worker/types";
import portalFixture from "../../../packages/shared/fixtures/project-alpha-portal-v2.json";

const applicationKey = "field_operations_portal";
const secret = "portal-test-secret-at-least-thirty-two-bytes";
const access = async () => undefined;
const principal: VerifiedClientPrincipal = { issuer: "https://team.cloudflareaccess.com", subject: "verified-subject", email: "manager@example.test" };

async function signature(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}\nPOST\n/api/internal/project-alpha/portal-v2\n${body}`));
  return `sha256=${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

const workspace = {
  publicId: "pa-workspace-acme", rootType: "organization", rootPublicId: "pa-org-acme",
  displayName: "Acme Construction", sourceVersion: "org-v1", active: true,
} as const;
const contact = { type: "contact", publicId: "pa-contact-primary", parentPublicId: "pa-dept-field", displayName: "Primary Contact", sourceVersion: "contact-v1", active: true, primaryContact: true } as const;
const project = { type: "project", publicId: "pa-project-north", parentPublicId: "pa-dept-field", displayName: "North Site", sourceVersion: "project-v1", active: true, primaryContact: false } as const;
const projectedPrincipal = { publicId: "pa-principal-manager", emailHint: "manager@example.test", displayName: "Portal Manager", sourceVersion: "principal-v1", active: true } as const;

function envelope(kind: string, deliveryId: string, sourceSequence: number, extra: Record<string, unknown>) {
  return {
    schemaVersion: 2, applicationKey, deliveryId, occurredAt: "2026-08-13T18:00:00.000Z",
    sourceGeneration: "portal-2026-08-13", sourceSequence, workspaceId: workspace.publicId, kind, ...extra,
  };
}

async function applyMigration(db: D1Database, sql: string): Promise<void> {
  await db.exec(sql.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
}

describe("Project Alpha portal hierarchy projection", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default { fetch() { return new Response('ok'); } };", d1Databases: { DELIVERY_DB: "portal-projection-test" } });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,project_alpha_client_id TEXT,project_alpha_organization_id TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),last_seen_at TEXT,UNIQUE(issuer,subject),UNIQUE(id,account_id));
      CREATE TABLE client_account_members(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,role TEXT NOT NULL,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(account_id,identity_id));
      CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT NOT NULL,active INTEGER DEFAULT 1);
      CREATE TABLE client_project_grants(account_id TEXT NOT NULL,project_id TEXT NOT NULL,can_request_service INTEGER DEFAULT 0,revoked_at TEXT,PRIMARY KEY(account_id,project_id));
      CREATE TABLE client_member_project_grants(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,project_id TEXT NOT NULL,revoked_at TEXT,PRIMARY KEY(account_id,identity_id,project_id));
      CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,project_id TEXT,account_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),revoked_at TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await applyMigration(db, hierarchyMigration);
    await applyMigration(db, projectionMigration);
    await db.prepare("PRAGMA foreign_keys=ON").run();
    env = {
      DELIVERY_DB: db,
      PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true",
      PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret,
      PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      PROJECT_ALPHA_PORTAL_ACCESS_AUD: "portal-sync-audience",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
    } as Env;
  }, 30_000);

  afterAll(async () => miniflare.dispose());

  async function deliver(payload: Record<string, unknown>, options: { timestamp?: string; signature?: string; accessVerifier?: typeof access } = {}) {
    const body = JSON.stringify(payload);
    const timestamp = options.timestamp ?? new Date().toISOString();
    return handleProjectAlphaPortalProjectionRequest(new Request("https://client.test/api/internal/project-alpha/portal-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PA-Timestamp": timestamp, "X-PA-Delivery-ID": String(payload.deliveryId), "X-PA-Signature": options.signature ?? await signature(body, timestamp) },
      body,
    }), env, options.accessVerifier ?? access);
  }

  it("accepts and rejects the shared schema-v2 producer corpus exactly", () => {
    expect(portalFixture.contract).toBe("ltds-project-alpha-portal-v2");
    expect(portalFixture.endpoint).toBe("/api/internal/project-alpha/portal-v2");
    for (const delivery of Object.values(portalFixture.valid))
      expect(parsePortalProjectionDelivery(delivery, portalFixture.applicationKey)).toBeTruthy();
    for (const specimen of portalFixture.invalid)
      expect(() => parsePortalProjectionDelivery(specimen.delivery, portalFixture.applicationKey))
        .toThrow(specimen.expectedError);
    expect(portalFixture.relationProjectionStatus.acceptedByCurrentReceiver).toBe(false);
  });

  it("stages a complete bounded generation and atomically activates hierarchy and unbound authorization intent", async () => {
    const page = portalFixture.valid.snapshotPage as Record<string, unknown>;
    expect((await deliver(page)).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspaces").first("count")).toBe(0);
    expect((await deliver(portalFixture.valid.snapshotActivate as Record<string, unknown>)).status).toBe(200);
    expect(await db.prepare("SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first("active_generation_id")).toBeTruthy();
    expect(await db.prepare("SELECT primary_contact FROM portal_v2_directory_entities WHERE workspace_id=? AND public_id=?").bind(workspace.publicId, contact.publicId).first("primary_contact")).toBe(1);
    expect(await db.prepare("SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?").bind(workspace.publicId, projectedPrincipal.publicId).first("identity_id")).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_entitlements WHERE workspace_id=? AND source_type='project_alpha'").bind(workspace.publicId).first("count")).toBe(0);
  });

  it("does not treat email hints or primary contacts as identity proof, then projects grants only after an explicit verified binding", async () => {
    await db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES ('verified-identity',?,?,?,'active')").bind(principal.issuer, principal.subject, principal.email).run();
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "delivery.view", { scopeType: "project", publicId: project.publicId })).toBe(false);
    await db.prepare("UPDATE pa_portal_principals SET identity_id='verified-identity' WHERE workspace_id=? AND public_id=?").bind(workspace.publicId, projectedPrincipal.publicId).run();
    const refresh = envelope("event", "portal-event-11", 11, { event: { resource: "principal", action: "upsert", principal: { ...projectedPrincipal, sourceVersion: "principal-v2" } } });
    expect((await deliver(refresh)).status).toBe(200);
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "delivery.view", { scopeType: "project", publicId: project.publicId })).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "member.manage", { scopeType: "workspace", publicId: workspace.publicId })).toBe(false);
  });

  it("accepts exact replay, rejects delivery-id reuse and sequence gaps, and immediately removes a tombstoned principal", async () => {
    const replay = envelope("event", "portal-event-11", 11, { event: { resource: "principal", action: "upsert", principal: { ...projectedPrincipal, sourceVersion: "principal-v2" } } });
    expect((await (await deliver(replay)).json() as { status: string }).status).toBe("duplicate");
    expect((await deliver({ ...replay, occurredAt: "2026-08-13T18:01:00.000Z" })).status).toBe(409);
    expect((await deliver(envelope("event", "portal-event-13", 13, { event: { resource: "principal", action: "tombstone", publicId: projectedPrincipal.publicId, sourceVersion: "principal-v3" } }))).status).toBe(409);
    expect((await deliver(envelope("event", "portal-event-12", 12, { event: { resource: "principal", action: "tombstone", publicId: projectedPrincipal.publicId, sourceVersion: "principal-v3" } }))).status).toBe(200);
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "delivery.view", { scopeType: "project", publicId: project.publicId })).toBe(false);
  });

  it("hard-404s before Access, body reads, or D1 when independently disabled or incomplete", async () => {
    let accessCalls = 0;
    const request = () => new Request("https://client.test/api/internal/project-alpha/portal-v2", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const disabled = await handleProjectAlphaPortalProjectionRequest(request(), { PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "false" } as Env, async () => { accessCalls += 1; });
    expect(disabled.status).toBe(404);
    expect(accessCalls).toBe(0);
    const incomplete = await handleProjectAlphaPortalProjectionRequest(request(), { PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true" } as Env, async () => { accessCalls += 1; });
    expect(incomplete.status).toBe(404);
    const shortSecret = await handleProjectAlphaPortalProjectionRequest(request(), {
      ...env, PROJECT_ALPHA_PORTAL_HMAC_SECRET: "too-short",
    }, async () => { accessCalls += 1; });
    expect(shortSecret.status).toBe(404);
    expect(accessCalls).toBe(0);
    expect(env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED).toBe("true");
  });

  it("requires Access, fresh exact-body HMAC and opaque public ids", async () => {
    const payload = envelope("event", "portal-auth-13", 13, { event: { resource: "workspace", action: "tombstone", publicId: workspace.publicId, sourceVersion: "org-v2" } });
    expect((await deliver(payload, { accessVerifier: async () => { throw new Error("portal-access-invalid"); } })).status).toBe(401);
    expect((await deliver(payload, { timestamp: "2020-01-01T00:00:00.000Z" })).status).toBe(401);
    expect((await deliver(payload, { signature: `sha256=${"0".repeat(64)}` })).status).toBe(401);
    expect(() => parsePortalProjectionDelivery({ ...payload, apiKey: "forbidden" }, applicationKey)).toThrow();
    expect(() => parsePortalProjectionDelivery({ ...payload, workspaceId: 42 }, applicationKey)).toThrow();
    expect(() => parsePortalProjectionDelivery({ ...payload, workspaceId: "42" }, applicationKey)).toThrow();
  });

  it("rejects an oversized streamed body without relying on Content-Length", async () => {
    const response = await handleProjectAlphaPortalProjectionRequest(new Request(
      "https://client.test/api/internal/project-alpha/portal-v2",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array(256 * 1024 + 1),
      },
    ), env, access);
    expect(response.status).toBe(413);
  });

  it("is migration-idempotent and keeps referential integrity", async () => {
    await applyMigration(db, projectionMigration);
    const activeGenerationId = await db.prepare(
      "SELECT snapshot_generation_id FROM pa_portal_projection_checkpoints WHERE workspace_id=?",
    ).bind(workspace.publicId).first<string>("snapshot_generation_id");
    expect(activeGenerationId).toBeTruthy();
    await expect(db.prepare(`INSERT INTO pa_portal_projection_checkpoints
      (workspace_id,source_generation,source_sequence,snapshot_generation_id)
      VALUES ('pa-workspace-cross','generation-one',10,?)`).bind(activeGenerationId).run()).rejects.toThrow();
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
