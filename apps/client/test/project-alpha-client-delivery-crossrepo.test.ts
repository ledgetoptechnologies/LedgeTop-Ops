import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import hierarchyMigration from "../migrations/0121_client_workspace_hierarchy_v2.sql?raw";
import projectionMigration from "../migrations/0125_project_alpha_portal_projection.sql?raw";
import relationMigration from "../migrations/0129_portal_hierarchy_relations.sql?raw";
import legacyBridgeMigration from "../migrations/0132_portal_v2_legacy_member_bridges.sql?raw";
import denialMigration from "../migrations/0136_portal_v2_identity_denials.sql?raw";
import authenticatedGrantMigration from "../migrations/0137_authenticated_delivery_grants.sql?raw";
import eligibilityMigration from "../migrations/0145_portal_identity_eligibility.sql?raw";
import deliveryIntentMigration from "../migrations/0147_project_alpha_delivery_intents.sql?raw";
import sourceOwnershipMigration from "../migrations/0158_portal_source_ownership.sql?raw";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import portalFixture from "../../../packages/shared/fixtures/project-alpha-portal-v2.json";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { resolveCloudflareClientPrincipal } from "../src/worker/client-portal/access-identity";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import { handleProjectAlphaPortalProjectionRequest, verifyPortalProjectionAccessAssertion } from "../src/worker/project-alpha-portal";
import type { Env } from "../src/worker/types";

const origin = "https://client.test";
const applicationKey = "field_operations_portal";
const keyId = "portal-crossrepo-v1";
const secret = "portal-crossrepo-secret-at-least-thirty-two-bytes";
const workspaceId = "pa-workspace-acme";
const principalPublicId = "pa-principal-manager";
const projectPublicId = "pa-project-north";
const principal: VerifiedClientPrincipal = {
  issuer: "https://team.cloudflareaccess.com",
  subject: "client-manager-subject",
  email: "manager@example.test",
};

async function migrate(db: D1Database, sql: string): Promise<void> {
  await db.exec(sql.replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
    .replace(/\s*\n\s*/g, " "));
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(body: string, timestamp: string, deliveryId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(
    `${timestamp}\nPOST\n/api/internal/project-alpha/portal-v2\n${keyId}\n${deliveryId}\n${body}`,
  ));
  return `sha256=${[...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("Project Alpha to authenticated Client delivery cross-repository contract", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;
  let bucketReads: string[];
  let accessPrivateKey: CryptoKey;
  let localJwks: JWTVerifyGetKey;
  let clientToken: string;
  let projectionToken: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.alg = "RS256"; publicJwk.kid = "crossrepo-access-key"; publicJwk.use = "sig";
    accessPrivateKey = pair.privateKey;
    localJwks = createLocalJWKSet({ keys: [publicJwk] });
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    clientToken = await new SignJWT({
      iss: principal.issuer, aud: "client-portal-audience", type: "app",
      sub: principal.subject, email: principal.email, exp: expiresAt,
    }).setProtectedHeader({ alg: "RS256", kid: "crossrepo-access-key" }).sign(accessPrivateKey);
    projectionToken = await new SignJWT({
      iss: principal.issuer, aud: "portal-sync-audience", sub: "project-alpha-service", exp: expiresAt,
    }).setProtectedHeader({ alg: "RS256", kid: "crossrepo-access-key" }).sign(accessPrivateKey);
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-16", modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DELIVERY_DB: "pa-client-delivery-crossrepo" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,project_alpha_source_id TEXT DEFAULT 'project-alpha:primary',
        project_alpha_client_id TEXT,project_alpha_organization_id TEXT,created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
      CREATE TABLE client_identity_links(id TEXT NOT NULL,account_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,
        revoked_at TEXT,created_at TEXT DEFAULT(datetime('now')),last_seen_at TEXT,PRIMARY KEY(id),UNIQUE(id,account_id),UNIQUE(issuer,subject));
      CREATE TABLE client_account_members(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,role TEXT NOT NULL,can_view_billing INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT,created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(account_id,identity_id));
      CREATE TABLE projects(id TEXT PRIMARY KEY,external_ref TEXT NOT NULL,client_name TEXT NOT NULL,project_name TEXT NOT NULL,r2_prefix TEXT,project_alpha_source_id TEXT DEFAULT 'project-alpha:primary',
        project_alpha_project_id TEXT,active INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',summary TEXT,site_address TEXT,
        service_address TEXT,project_contact_name TEXT,project_contact_email TEXT,project_contact_phone TEXT,next_milestone TEXT,source_updated_at TEXT);
      CREATE TABLE client_project_grants(account_id TEXT NOT NULL,project_id TEXT NOT NULL,can_request_service INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT,PRIMARY KEY(account_id,project_id));
      CREATE TABLE client_member_project_grants(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,project_id TEXT NOT NULL,
        granted_by_identity_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,identity_id,project_id));
      CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,project_id TEXT,account_id TEXT NOT NULL,
        r2_prefix TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT DEFAULT(datetime('now')),revoked_at TEXT);
      CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,uploaded_at TEXT NOT NULL,content_type TEXT,media_kind TEXT NOT NULL);
      CREATE TABLE delivery_tombstones(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,deleted_by TEXT NOT NULL,
        purge_after TEXT NOT NULL,restored_at TEXT,restored_by TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await migrate(db, hierarchyMigration);
    await migrate(db, projectionMigration);
    await migrate(db, relationMigration);
    await migrate(db, legacyBridgeMigration);
    await migrate(db, denialMigration);
    await migrate(db, authenticatedGrantMigration);
    await migrate(db, eligibilityMigration);
    await migrate(db, deliveryIntentMigration);
    await db.batch(splitD1MigrationStatements(sourceOwnershipMigration).map(sql => db.prepare(sql)));
    await db.prepare("PRAGMA foreign_keys=ON").run();

    await db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id)
      VALUES('account-acme','Acme Construction','active','pa-org-acme')`).run();
    bucketReads = [];
    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: origin,
      CLIENT_ACCESS_TEAM_DOMAIN: principal.issuer,
      CLIENT_ACCESS_AUD: "client-portal-audience",
      DELIVERY_SESSION_SECRET: "crossrepo-session-secret-at-least-thirty-two-bytes",
      PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true",
      PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: keyId,
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret,
      PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      PROJECT_ALPHA_PORTAL_ACCESS_AUD: "portal-sync-audience",
      DATA_BUCKET: {
        head: async (key: string) => key === "clients/acme/north/report.pdf" ? {
          key, size: 6, etag: "etag-report", httpEtag: '"etag-report"', customMetadata: {},
          writeHttpMetadata(headers: Headers) { headers.set("Content-Type", "application/pdf"); },
        } : null,
        get: async (key: string) => {
          bucketReads.push(key);
          if (key !== "clients/acme/north/report.pdf") return null;
          const bytes = new TextEncoder().encode("report");
          return { body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
            etag: "etag-report", httpEtag: '"etag-report"',
            writeHttpMetadata(headers: Headers) { headers.set("Content-Type", "application/pdf"); } };
        },
      } as unknown as R2Bucket,
    } as Env;
  }, 60_000);

  afterAll(async () => miniflare.dispose());

  async function deliver(payload: Record<string, unknown>, targetEnv: Env = env): Promise<Response> {
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    return handleProjectAlphaPortalProjectionRequest(new Request(`${origin}/api/internal/project-alpha/portal-v2`, {
      method: "POST", body, headers: {
        "Content-Type": "application/json",
        "X-Portal-Integration-Application-Key": applicationKey,
        "X-Portal-Integration-Timestamp": timestamp,
        "X-Portal-Integration-Body-SHA256": await sha256(body),
        "X-Portal-Integration-Key-Id": keyId,
        "X-Portal-Integration-Delivery-Id": String(payload.deliveryId),
        "X-Portal-Integration-Signature": await signature(body, timestamp, String(payload.deliveryId)),
        "Cf-Access-Jwt-Assertion": projectionToken,
      },
    }), targetEnv, (request, receiverEnv) => verifyPortalProjectionAccessAssertion(request, receiverEnv, localJwks));
  }

  function portal() {
    return createClientPortalRouter({
      resolvePrincipal: (request, resolverEnv) => resolveCloudflareClientPrincipal(request, resolverEnv, localJwks),
      repository: d1ClientPortalRepository,
    });
  }

  function request(path: string, workspace = workspaceId, token = clientToken) {
    return portal().request(`${origin}${path}`, {
      headers: {
        ...(workspace ? { "X-LTDS-Workspace-Id": workspace } : {}),
        "Cf-Access-Jwt-Assertion": token,
      },
    }, env);
  }

  it("keeps the identity shell empty until both PA authority and an explicit folder grant are live", async () => {
    expect((await deliver(portalFixture.valid.snapshotPage as Record<string, unknown>)).status).toBe(200);
    expect((await deliver(portalFixture.valid.snapshotActivate as Record<string, unknown>)).status).toBe(200);
    await db.prepare("UPDATE portal_v2_workspaces SET legacy_account_id='account-acme' WHERE id=?").bind(workspaceId).run();

    // A real signed Client request runs the production bootstrap: it binds the
    // exact issuer/subject, retains email only as verified metadata, creates a
    // PA-owned membership, and materializes current PA entitlement intents.
    expect((await request("/session", "")).status).toBe(200);
    const identityId = await db.prepare(`SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?`)
      .bind(principal.issuer, principal.subject).first<string>("id");
    const legacyIdentityId = await db.prepare(`SELECT legacy_identity_id FROM portal_v2_identity_eligibility_legacy_bridges
      WHERE workspace_id=? AND identity_id=? AND status='active'`).bind(workspaceId, identityId).first<string>("legacy_identity_id");
    expect(identityId).toBeTruthy();
    expect(legacyIdentityId).toBeTruthy();
    expect(await (await request("/projects")).json()).toEqual({ projects: [] });
    expect(bucketReads).toEqual([]);

    await db.batch([
      db.prepare(`INSERT INTO projects(id,external_ref,client_name,project_name,r2_prefix,project_alpha_project_id)
        VALUES('project-local','ACME-1','Acme','North Site','clients/acme/north/',?)`).bind(projectPublicId),
      db.prepare(`INSERT INTO client_project_grants(account_id,project_id) VALUES('account-acme','project-local')`),
      db.prepare(`INSERT INTO client_member_project_grants(account_id,identity_id,project_id,granted_by_identity_id)
        VALUES('account-acme',?,'project-local',?)`).bind(legacyIdentityId, legacyIdentityId),
      db.prepare(`INSERT INTO client_folder_associations(id,scope_type,project_id,account_id,r2_prefix,created_by)
        VALUES('folder-association','project','project-local','account-acme','clients/acme/north/','staff-owner')`),
      db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES('folder-binding',?,'project',?,'clients/acme/north/','operations','project-v1','active')`).bind(workspaceId, projectPublicId),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
        (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,
          audience_source_version,reason_code,created_by_staff_id)
        VALUES('delivery-grant','delivery-logical',1,?,'folder-binding','project-v1','principal',?,'principal-v1','client_delivery','staff-owner')`)
        .bind(workspaceId, principalPublicId),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
        (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES('delivery-grant',?,?,?,'principal-v1')`).bind(workspaceId, principalPublicId, identityId),
      db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
        VALUES('clients/acme/north/report.pdf','etag-report',6,'2026-08-20T12:00:00Z','application/pdf','pdf')`),
    ]);

    expect(await db.prepare(`SELECT status,source_version FROM portal_v2_entitlements
      WHERE workspace_id=? AND identity_id=? AND capability='delivery.view'`)
      .bind(workspaceId, identityId).first()).toMatchObject({ status: "active", source_version: "grant-v1" });
    expect(await db.prepare(`SELECT status,source_version FROM portal_v2_workspace_memberships
      WHERE workspace_id=? AND identity_id=?`).bind(workspaceId, identityId).first())
      .toMatchObject({ status: "active", source_version: "principal-v1" });
    const projects = await (await request("/projects")).json() as { projects: Array<{ id: string }> };
    expect(projects.projects.map(project => project.id)).toEqual(["project-local"]);
    const filesResponse = await request("/projects/project-local/files");
    expect(filesResponse.status).toBe(200);
    const files = await filesResponse.json() as { files: Array<{ downloadPath: string }> };
    expect(files.files).toHaveLength(1);
    const downloadPath = files.files[0]!.downloadPath.replace(/^\/api\/client/, "");
    expect((await request(downloadPath)).status).toBe(200);
    expect(bucketReads).toEqual(["clients/acme/north/report.pdf"]);

    bucketReads.length = 0;
    expect((await request("/projects/project-local/files", "pa-workspace-other")).status).toBe(403);
    expect(bucketReads).toEqual([]);
    expect((await portal().request(`${origin}${downloadPath}`, {
      headers: {
        "X-LTDS-Workspace-Id": workspaceId,
        "Cf-Access-Jwt-Assertion": clientToken,
      },
    }, { ...env, AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "false" } as Env)).status).toBe(404);
    expect(bucketReads).toEqual([]);

    // Revocation is checked on every request. A previously issued opaque path
    // cannot revive authority and must not touch R2.
    bucketReads.length = 0;
    await db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',
      revoked_at=datetime('now'),revoked_by_staff_id='staff-owner',revoke_reason_code='client_access_removed'
      WHERE id='delivery-grant'`).run();
    expect((await request(downloadPath)).status).toBe(404);
    expect(bucketReads).toEqual([]);

    const tombstone = {
      schemaVersion: 2, applicationKey, deliveryId: "portal-principal-tombstone-11",
      occurredAt: "2026-08-20T12:00:00.000Z", sourceGeneration: "portal-2026-08-13", sourceSequence: 11,
      workspaceId, kind: "event",
      event: { resource: "principal", action: "tombstone", publicId: principalPublicId, sourceVersion: "principal-v3" },
    };
    expect((await deliver(tombstone)).status).toBe(200);
    expect((await request("/projects")).status).toBe(403);
    expect((await request(downloadPath)).status).toBe(403);
    expect(bucketReads).toEqual([]);
  }, 60_000);

  it("hard-fails closed across workspaces and when either rollout flag is off", async () => {
    const disabledPortal = { ...env, CLIENT_PORTAL_ENABLED: "false" } as Env;
    expect((await portal().request(`${origin}/session`, {}, disabledPortal)).status).toBe(404);
    const disabledProjection = { ...env, PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "false" } as Env;
    const disabledPayload = { ...portalFixture.valid.event, deliveryId: "disabled-projection" } as Record<string, unknown>;
    expect((await deliver(disabledPayload, disabledProjection)).status).toBe(404);

    const unknownToken = await new SignJWT({
      iss: principal.issuer, aud: "client-portal-audience", type: "app",
      sub: "not-activated", email: principal.email, exp: Math.floor(Date.now() / 1000) + 300,
    }).setProtectedHeader({ alg: "RS256", kid: "crossrepo-access-key" }).sign(accessPrivateKey);
    const identitiesBefore = await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities").first<number>("count");
    expect((await portal().request(`${origin}/session`, {
      headers: { "Cf-Access-Jwt-Assertion": unknownToken },
    }, {
      ...env, CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false",
    } as Env)).status).toBe(403);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities").first<number>("count"))
      .toBe(identitiesBefore);
    expect(bucketReads).toEqual([]);
  });
});
