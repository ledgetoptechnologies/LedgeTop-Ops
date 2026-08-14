import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import migration from "../migrations/0124_client_delegated_public_shares.sql?raw";
import provisioningMigration from "../migrations/0130_client_delegated_share_provisioning.sql?raw";
import { createSessionCookie, parseCookie, sha256 } from "../src/worker/security";
import { encodeItemRef } from "../src/worker/files";
import { createClientDelegatedPublicRouter } from "../src/worker/client-delegated-public";
import {
  authorizeClientDelegatedPublicShare,
  authorizeClientShareDelegation,
  canonicalDelegatedRelativePrefix,
  CLIENT_DELEGATED_SHARE_COOKIE,
  clientDelegatedShareCreationCapability,
  createClientDelegatedShareSessionCookie,
  delegatedTargetContained,
  listClientDelegatedShares,
  listClientDelegatedShareTargets,
  revokeClientDelegatedShare,
  verifyClientDelegatedShareSessionCookie,
} from "../src/worker/client-portal/delegated-shares";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { ClientPortalRepository } from "../src/worker/client-portal/types";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import type { Env } from "../src/worker/types";

const issuer = "https://clients.example.test";
const principal: VerifiedClientPrincipal = { issuer, subject: "identity-one", email: "one@example.test" };
const otherPrincipal: VerifiedClientPrincipal = { issuer, subject: "identity-two", email: "two@example.test" };
const workspaceId = "workspace-00000001";
const identityId = "identity-00000001";
const bindingId = "binding-000000001";
const rootTargetId = "target-root-000001";
const childTargetId = "target-child-00001";
const delegationId = "delegation-0000001";
const shareId = "client-share-000001";
const publicId = "clientpublicid0000000001";

async function applySql(db: D1Database, sql: string): Promise<void> {
  await db.exec(sql
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
    .replace(/\s*\n\s*/g, " "));
}

describe("client-delegated public share foundation", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "delegated-shares" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await applySql(db, `
      CREATE TABLE portal_v2_identities(
        id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,verified_email TEXT,
        status TEXT NOT NULL,revoked_at TEXT,UNIQUE(issuer,subject));
      CREATE TABLE portal_v2_workspaces(
        id TEXT PRIMARY KEY,root_type TEXT NOT NULL,pa_organization_public_id TEXT,
        pa_client_public_id TEXT,legacy_account_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE portal_v2_workspace_memberships(
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,
        source_type TEXT NOT NULL,status TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,
        UNIQUE(workspace_id,identity_id));
      CREATE TABLE portal_v2_directory_generations(
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,status TEXT NOT NULL,complete INTEGER NOT NULL);
      CREATE TABLE portal_v2_directory_entities(
        workspace_id TEXT NOT NULL,generation_id TEXT NOT NULL,entity_type TEXT NOT NULL,
        public_id TEXT NOT NULL,parent_public_id TEXT,active INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,generation_id,entity_type,public_id));
      CREATE TABLE portal_v2_directory_checkpoints(
        workspace_id TEXT PRIMARY KEY,active_generation_id TEXT NOT NULL);
      CREATE TABLE portal_v2_entitlements(
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,
        capability TEXT NOT NULL,effect TEXT NOT NULL,scope_type TEXT NOT NULL,
        scope_public_id TEXT NOT NULL,entitlement_version INTEGER NOT NULL,
        status TEXT NOT NULL,valid_from TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,
        UNIQUE(id,workspace_id,identity_id));
      CREATE TABLE portal_v2_folder_bindings(
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_scope_type TEXT NOT NULL,
        owner_public_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,source_version TEXT,
        status TEXT NOT NULL,revoked_at TEXT,UNIQUE(id,workspace_id));
      CREATE TABLE delivery_tombstones(
        physical_key TEXT PRIMARY KEY,tombstone_kind TEXT NOT NULL,restored_at TEXT);
      CREATE TABLE file_aliases(physical_key TEXT PRIMARY KEY,display_name TEXT NOT NULL);
      CREATE TABLE image_thumbnail_jobs(
        source_key TEXT PRIMARY KEY,source_etag TEXT,thumbnail_key TEXT,thumbnail_etag TEXT,
        thumbnail_size INTEGER,status TEXT);
      CREATE TABLE file_index(
        r2_key TEXT PRIMARY KEY,etag TEXT,media_kind TEXT,size INTEGER,uploaded_at TEXT,
        content_type TEXT,stream_uid TEXT,stream_status TEXT);
      CREATE TABLE image_asset_locations(
        source_key TEXT PRIMARY KEY,source_etag TEXT NOT NULL,folder_prefix TEXT NOT NULL,
        latitude REAL,longitude REAL,status TEXT NOT NULL);
    `);
    await applySql(db, migration);
    await applySql(db, provisioningMigration);
    await db.prepare("PRAGMA foreign_keys=ON").run();
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES (?,?,?,?, 'active')`).bind(identityId, issuer, principal.subject, principal.email),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES ('identity-00000002',?,?,?, 'active')`).bind(issuer, otherPrincipal.subject, otherPrincipal.email),
      db.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_organization_public_id,display_name,status)
        VALUES (?,'organization','pa-org-one','Organization','active')`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status)
        VALUES ('membership-000001',?,?,'project_alpha','active')`).bind(workspaceId, identityId),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,status,complete)
        VALUES ('generation-000001',?,'active',1)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,active)
        VALUES (?,'generation-000001','organization','pa-org-one',NULL,1)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,active)
        VALUES (?,'generation-000001','project','pa-project-one','pa-org-one',1)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id)
        VALUES (?,'generation-000001')`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_folder_bindings
        (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_version,status)
        VALUES (?,?,'project','pa-project-one','clients/private/project/','binding-v1','active')`)
        .bind(bindingId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
         entitlement_version,status,valid_from)
        VALUES ('entitlement-share-01',?,?,'delegated_share.create','allow','folder',?,7,'active',datetime('now','-1 day'))`)
        .bind(workspaceId, identityId, bindingId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
         entitlement_version,status,valid_from)
        VALUES ('entitlement-view-001',?,?,'workspace.view','allow','workspace',?,1,'active',datetime('now','-1 day'))`)
        .bind(workspaceId, identityId, workspaceId),
      db.prepare(`INSERT INTO client_share_folder_targets
        (id,workspace_id,folder_binding_id,binding_source_version,relative_prefix,created_by_staff_id)
        VALUES (?,?,?,'binding-v1','deliverables/','staff-one')`)
        .bind(rootTargetId, workspaceId, bindingId),
      db.prepare(`INSERT INTO client_share_folder_targets
        (id,workspace_id,folder_binding_id,binding_source_version,relative_prefix,created_by_staff_id)
        VALUES (?,?,?,'binding-v1','deliverables/photos/','staff-one')`)
        .bind(childTargetId, workspaceId, bindingId),
      db.prepare(`INSERT INTO client_share_delegations
        (id,workspace_id,identity_id,entitlement_id,entitlement_version,
         folder_binding_id,folder_binding_source_version,root_target_id,
         expires_at,created_by_staff_id)
        VALUES (?,?,?,'entitlement-share-01',7,?,'binding-v1',?,datetime('now','+7 day'),'staff-one')`)
        .bind(delegationId, workspaceId, identityId, bindingId, rootTargetId),
      db.prepare(`INSERT INTO client_share_folder_target_labels(target_id,workspace_id,display_name)
        VALUES (?,?,'Approved root')`).bind(rootTargetId, workspaceId),
      db.prepare(`INSERT INTO client_share_folder_target_labels(target_id,workspace_id,display_name)
        VALUES (?,?,'Client photos')`).bind(childTargetId, workspaceId),
    ]);
    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      ENVIRONMENT: "development",
    } as Env;
  }, 30_000);

  afterAll(async () => miniflare.dispose());

  it("normalizes internal prefixes and rejects traversal, encoding, case and boundary ambiguity", () => {
    expect(canonicalDelegatedRelativePrefix("deliverables/photos/")).toBe("deliverables/photos/");
    expect(canonicalDelegatedRelativePrefix("deliverables/../private/")).toBeNull();
    expect(canonicalDelegatedRelativePrefix("deliverables/%2e%2e/private/")).toBeNull();
    expect(canonicalDelegatedRelativePrefix("deliverables\\photos/")).toBeNull();
    expect(delegatedTargetContained("deliverables/", "deliverables/photos/", false)).toBe(true);
    expect(delegatedTargetContained("deliverables/", "deliverables/", false)).toBe(false);
    expect(delegatedTargetContained("deliverables/", "deliverables-old/photos/", false)).toBe(false);
    expect(delegatedTargetContained("Deliverables/", "deliverables/photos/", false)).toBe(false);
  });

  it("lists only authorized opaque targets and never serializes storage or policy internals", async () => {
    const targets = await listClientDelegatedShareTargets(env, principal, workspaceId);
    expect(targets).toEqual([expect.objectContaining({
      delegationId, folderTargetId: childTargetId, displayName: "Client photos",
      requirePassword: false,
    })]);
    const serialized = JSON.stringify(targets);
    expect(serialized).not.toContain("clients/private");
    expect(serialized).not.toContain("deliverables/");
    expect(serialized).not.toContain(bindingId);
    expect(serialized).not.toContain("entitlement-share-01");
    expect(await listClientDelegatedShareTargets(env, otherPrincipal, workspaceId)).toBeNull();

    await db.prepare("UPDATE client_share_delegations SET allow_exact_root=1 WHERE id=?").bind(delegationId).run();
    expect(await listClientDelegatedShareTargets(env, principal, workspaceId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ folderTargetId: rootTargetId })]));
    await db.prepare("UPDATE client_share_delegations SET allow_exact_root=0 WHERE id=?").bind(delegationId).run();
  });

  it("authorizes only the exact identity, workspace, binding version and strict descendant", async () => {
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, childTargetId))
      .toMatchObject({ identityId, folderBindingId: bindingId, folderTargetId: childTargetId });
    expect(await authorizeClientShareDelegation(env, otherPrincipal, workspaceId, delegationId, childTargetId)).toBeNull();
    expect(await authorizeClientShareDelegation(env, principal, "workspace-00000002", delegationId, childTargetId)).toBeNull();
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, rootTargetId)).toBeNull();

    await db.prepare("UPDATE client_share_delegations SET allow_exact_root=1 WHERE id=?").bind(delegationId).run();
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, rootTargetId)).not.toBeNull();
    await db.prepare("UPDATE client_share_delegations SET allow_exact_root=0 WHERE id=?").bind(delegationId).run();
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='binding-v2' WHERE id=?").bind(bindingId).run();
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, childTargetId)).toBeNull();
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='binding-v1' WHERE id=?").bind(bindingId).run();
    await db.prepare("UPDATE client_share_folder_targets SET binding_source_version='binding-v0' WHERE id=?").bind(childTargetId).run();
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, childTargetId)).toBeNull();
    await db.prepare("UPDATE client_share_folder_targets SET binding_source_version='binding-v1' WHERE id=?").bind(childTargetId).run();
  });

  it("calls the private signer only after authorization and records a verified idempotent receipt", async () => {
    const signerCalls: unknown[] = [];
    const signerSecret = "s".repeat(43);
    const signerShareId = "client-share-route-0001";
    const signerPublicId = "cs_clientroutepublic0001";
    const signerReceiptId = "client-share-signer-route-0001";
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const binding = {
      createClientDelegatedShare: async (request: any) => {
        signerCalls.push(request);
        await db.prepare(`INSERT OR IGNORE INTO client_delegated_shares
          (id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,
           token_hash,share_version,label,expires_at,status,signer_receipt_id,idempotency_key,request_fingerprint)
          VALUES (?,?,?,?,?,?,?,1,?,?,'active',?,?,?)`)
          .bind(
            signerShareId, signerPublicId, request.workspaceId, request.delegationId,
            request.createdByIdentityId, request.folderTargetId, await sha256(signerSecret),
            request.label, request.expiresAt, signerReceiptId, request.idempotencyKey, "r".repeat(43),
          ).run();
        return {
          ok: true as const,
          protocolVersion: 1 as const,
          receiptId: signerReceiptId,
          replayed: false,
          share: {
            id: signerShareId,
            publicId: signerPublicId,
            path: `/client-share/${signerPublicId}`,
            shareUrl: `https://client.test/client-share/${signerPublicId}#${signerSecret}`,
            label: request.label,
            status: "active" as const,
            passwordProtected: false,
            expiresAt: request.expiresAt,
            createdAt: new Date().toISOString(),
          },
        };
      },
    };
    const repository = {
      resolveSession: async () => ({
        accountId: "legacy-account", identityId, displayName: "Organization",
        role: "manager", canViewBilling: false,
      }),
    } as unknown as ClientPortalRepository;
    const router = createClientPortalRouter({ resolvePrincipal: async () => principal, repository });
    const response = await router.request(
      `https://client.test/v2/workspaces/${workspaceId}/delegated-shares`,
      {
        method: "POST",
        headers: {
          Origin: "https://client.test",
          "Content-Type": "application/json",
          "Idempotency-Key": "create-route-success-0001",
        },
        body: JSON.stringify({ delegationId, folderTargetId: childTargetId, expiresAt }),
      },
      {
        ...env,
        CLIENT_PORTAL_ENABLED: "true",
        CLIENT_PORTAL_ORIGIN: "https://client.test",
        CLIENT_DELEGATED_SHARES_ENABLED: "true",
        CLIENT_DELEGATED_SHARE_SIGNER: binding,
      },
    );
    expect(response.status).toBe(201);
    const body = await response.json<any>();
    expect(body.share).toMatchObject({ id: signerShareId, path: `/client-share/${signerPublicId}` });
    expect(JSON.stringify(body)).not.toContain("clients/private/project");
    expect(signerCalls).toEqual([expect.objectContaining({
      protocolVersion: 1,
      workspaceId,
      createdByIdentityId: identityId,
      expectedDelegationVersion: 1,
      expectedEntitlementVersion: 7,
      expectedBindingSourceVersion: "binding-v1",
    })]);
    expect(await db.prepare(`SELECT COUNT(*) count FROM client_delegated_share_events
      WHERE share_id=? AND event_type='client_share.created'`).bind(signerShareId).first("count")).toBe(1);
    await db.batch([
      db.prepare("DELETE FROM client_delegated_share_events WHERE share_id=?").bind(signerShareId),
      db.prepare("DELETE FROM client_delegated_shares WHERE id=?").bind(signerShareId),
      db.prepare("DELETE FROM client_delegated_share_rate_windows WHERE action='create'")
    ]);
  });

  it("rejects cross-workspace delegation and share references at the database boundary", async () => {
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_client_public_id,display_name,status)
        VALUES ('workspace-00000002','standalone_client','pa-client-two','Other workspace','active')`),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status)
        VALUES ('membership-cross-01','workspace-00000002',?,'operations','active')`).bind(identityId),
    ]);
    await expect(db.prepare(`INSERT INTO client_share_delegations
      (id,workspace_id,identity_id,entitlement_id,entitlement_version,
       folder_binding_id,folder_binding_source_version,root_target_id,
       expires_at,created_by_staff_id)
      VALUES ('delegation-cross-01','workspace-00000002',?,'entitlement-share-01',7,?,'binding-v1',?,datetime('now','+1 day'),'staff-one')`)
      .bind(identityId, bindingId, rootTargetId).run()).rejects.toThrow();

    await expect(db.prepare(`INSERT INTO client_delegated_shares
      (id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,
       token_hash,share_version,expires_at,status,idempotency_key,request_fingerprint)
      VALUES ('client-share-cross1','clientpublicid0000000099','workspace-00000002',?,?,?,
        ?,1,datetime('now','+1 day'),'active','cross-create-key-01',?)`)
      .bind(delegationId, identityId, childTargetId, "x".repeat(43), "y".repeat(43)).run()).rejects.toThrow();
  });

  it("rechecks live membership, entitlement, deny precedence and delegation on every bearer request", async () => {
    await db.prepare(`INSERT INTO client_delegated_shares
      (id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,
       token_hash,share_version,expires_at,status,idempotency_key,request_fingerprint)
      VALUES (?,?,?,?,?,?,?,1,datetime('now','+1 day'),'active','create-key-00000001',?)`)
      .bind(shareId, publicId, workspaceId, delegationId, identityId, childTargetId, "t".repeat(43), "f".repeat(43)).run();
    expect(await authorizeClientDelegatedPublicShare(env, publicId, 1)).not.toBeNull();

    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
       entitlement_version,status,valid_from)
      VALUES ('entitlement-deny-01',?,?,'delegated_share.create','deny','folder',?,8,'active',datetime('now','-1 day'))`)
      .bind(workspaceId, identityId, bindingId).run();
    expect(await authorizeClientDelegatedPublicShare(env, publicId, 1)).toBeNull();
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id='entitlement-deny-01'").run();
    expect(await authorizeClientDelegatedPublicShare(env, publicId, 1)).not.toBeNull();
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=?")
      .bind(workspaceId, identityId).run();
    expect(await authorizeClientDelegatedPublicShare(env, publicId, 1)).toBeNull();
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='active',revoked_at=NULL WHERE workspace_id=? AND identity_id=?")
      .bind(workspaceId, identityId).run();
  });

  it("serves only the live delegated subtree through the isolated cookie and API namespace", async () => {
    const bearerSecret = "delegated-browser-fragment-secret-000000000001";
    await db.prepare("UPDATE client_delegated_shares SET token_hash=? WHERE id=?")
      .bind(await sha256(bearerSecret), shareId).run();
    const root = "clients/private/project/deliverables/photos/";
    const objects = new Map<string, { bytes: Uint8Array; type: string; uploaded: Date; etag: string }>([
      [`${root}visible.jpg`, { bytes: new TextEncoder().encode("visible-image"), type: "image/jpeg", uploaded: new Date("2026-08-01T12:00:00Z"), etag: '"visible-etag"' }],
      [`${root}_ltds/hidden.jpg`, { bytes: new TextEncoder().encode("hidden"), type: "image/jpeg", uploaded: new Date("2026-08-01T12:00:00Z"), etag: '"hidden-etag"' }],
      [`${root}deleted.jpg`, { bytes: new TextEncoder().encode("deleted"), type: "image/jpeg", uploaded: new Date("2026-08-01T12:00:00Z"), etag: '"deleted-etag"' }],
      ["clients/private/project/deliverables/sibling/secret.pdf", { bytes: new TextEncoder().encode("sibling"), type: "application/pdf", uploaded: new Date("2026-08-01T12:00:00Z"), etag: '"sibling-etag"' }],
    ]);
    const r2Object = (key: string, value: (typeof objects extends Map<string, infer V> ? V : never)) => ({
      key, size: value.bytes.byteLength, uploaded: value.uploaded, httpEtag: value.etag,
      httpMetadata: { contentType: value.type }, customMetadata: {},
      writeHttpMetadata(headers: Headers) { headers.set("Content-Type", value.type); },
    });
    const bucket = {
      async list(options: { prefix: string; delimiter?: string }) {
        const listed = [...objects.entries()].filter(([key]) => key.startsWith(options.prefix));
        const direct = listed.filter(([key]) => !key.slice(options.prefix.length).includes("/"));
        const prefixes = [...new Set(listed.flatMap(([key]) => {
          const rest = key.slice(options.prefix.length); const slash = rest.indexOf("/");
          return slash < 0 ? [] : [`${options.prefix}${rest.slice(0, slash + 1)}`];
        }))];
        return { objects: direct.map(([key, value]) => r2Object(key, value)), delimitedPrefixes: prefixes,
          truncated: false, cursor: undefined };
      },
      async head(key: string) { const value = objects.get(key); return value ? r2Object(key, value) : null; },
      async get(key: string) { const value = objects.get(key); return value ? { ...r2Object(key, value), body: value.bytes } : null; },
    } as unknown as R2Bucket;
    const allow = { success: true } as RateLimitOutcome;
    const limiter = { limit: async () => allow } as RateLimit;
    const sessionSecret = "client-share-session-secret-must-be-unique-0001";
    await db.prepare("INSERT INTO delivery_tombstones(physical_key,tombstone_kind) VALUES (?,'exact')")
      .bind(`${root}deleted.jpg`).run();
    await db.batch([
      db.prepare(`INSERT INTO file_index(r2_key,etag,media_kind,size,uploaded_at,content_type)
        VALUES (?,'visible-etag','image',13,'2026-08-01T12:00:00Z','image/jpeg')`).bind(`${root}visible.jpg`),
      db.prepare(`INSERT INTO image_asset_locations
        (source_key,source_etag,folder_prefix,latitude,longitude,status)
        VALUES (?,'visible-etag',?,44.5133,-88.0133,'ready')`).bind(`${root}visible.jpg`, root),
    ]);
    const router = createClientDelegatedPublicRouter();
    const requestEnv = {
      ...env,
      DATA_BUCKET: bucket,
      CLIENT_DELEGATED_SHARES_ENABLED: "true",
      CLIENT_DELEGATED_SHARE_SESSION_SECRET: sessionSecret,
      CLIENT_DELEGATED_SHARE_KEY_ID: "client-v1",
      DELIVERY_ACCESS_CODE_PEPPER: "access-code-pepper-must-be-at-least-32",
      AUDIT_IP_SECRET: "audit-secret-must-be-at-least-32-characters",
      PUBLIC_SESSION_RATE_LIMITER: limiter,
      ACCESS_CODE_RATE_LIMITER: limiter,
      PUBLIC_MANIFEST_RATE_LIMITER: limiter,
      PUBLIC_MEDIA_RATE_LIMITER: limiter,
      PUBLIC_THUMBNAIL_RATE_LIMITER: limiter,
      PUBLIC_DOWNLOAD_RATE_LIMITER: limiter,
      PUBLIC_STREAM_RATE_LIMITER: limiter,
    } as Env;
    const executionCtx = { waitUntil(promise: Promise<unknown>) { void promise; }, passThroughOnException() {} } as ExecutionContext;
    const sessionResponse = await router.request(`https://client.test/shares/${publicId}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: bearerSecret }),
    }, requestEnv, executionCtx);
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({ publicId, canonicalPath: `/client-share/${publicId}` });
    const setCookie = sessionResponse.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("Path=/client-share/");
    const cookie = `${CLIENT_DELEGATED_SHARE_COOKIE}=${parseCookie(setCookie, CLIENT_DELEGATED_SHARE_COOKIE)}`;

    const staffCookie = await createSessionCookie(sessionSecret, "client-v1", shareId, 1, Date.now() + 60_000);
    expect((await router.request(`https://client.test/shares/${publicId}/manifest`, {
      headers: { Cookie: staffCookie },
    }, requestEnv, executionCtx)).status).toBe(401);

    const manifestResponse = await router.request(`https://client.test/shares/${publicId}/manifest`, {
      headers: { Cookie: cookie },
    }, requestEnv, executionCtx);
    expect(manifestResponse.status).toBe(200);
    const manifestBody = await manifestResponse.json<any>();
    expect(manifestBody.items).toEqual([expect.objectContaining({
      name: "visible.jpg",
      downloadUrl: expect.stringMatching(/^\/client-share\/api\/shares\//),
    })]);
    expect(JSON.stringify(manifestBody)).not.toContain("clients/private");
    expect(JSON.stringify(manifestBody)).not.toContain("hidden.jpg");
    expect(JSON.stringify(manifestBody)).not.toContain("deleted.jpg");

    const disabledLocations = await router.request(`https://client.test/shares/${publicId}/locations`, {
      headers: { Cookie: cookie },
    }, requestEnv, executionCtx);
    expect(await disabledLocations.json()).toEqual({
      locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null,
    });
    await db.prepare(`INSERT INTO client_share_delegation_policies
      (delegation_id,workspace_id,image_location_map_enabled,created_by_staff_id)
      VALUES (?,?,1,'staff-one')`).bind(delegationId, workspaceId).run();
    const locationsResponse = await router.request(`https://client.test/shares/${publicId}/locations`, {
      headers: { Cookie: cookie },
    }, { ...requestEnv, MAPBOX_PUBLIC_TOKEN: "pk.test" }, executionCtx);
    expect(locationsResponse.status).toBe(200);
    const locationsBody = await locationsResponse.json<any>();
    expect(locationsBody).toMatchObject({
      locations: { points: [{ latitude: 44.5133, longitude: -88.0133, imageCount: 1 }], imageCount: 1 },
      mapboxPublicToken: "pk.test",
    });
    expect(JSON.stringify(locationsBody)).not.toContain("clients/private");
    expect(JSON.stringify(locationsBody)).not.toContain("source_key");
    expect(JSON.stringify(locationsBody)).not.toContain("EXIF");
    const assetRef = locationsBody.locations.points[0].assetRef as string;
    const mappedAsset = await router.request(
      `https://client.test/shares/${publicId}/locations/${encodeURIComponent(assetRef)}`,
      { headers: { Cookie: cookie } }, requestEnv, executionCtx,
    );
    expect(mappedAsset.status).toBe(200);
    const mappedBody = await mappedAsset.json<any>();
    expect(mappedBody.item).toMatchObject({
      name: "visible.jpg",
      sourceUrl: expect.stringMatching(/^\/client-share\/api\/shares\//),
      downloadUrl: expect.stringMatching(/^\/client-share\/api\/shares\//),
    });
    expect(JSON.stringify(mappedBody)).not.toContain("clients/private");
    await db.prepare("UPDATE client_share_delegation_policies SET image_location_map_enabled=0 WHERE delegation_id=?")
      .bind(delegationId).run();
    expect((await router.request(
      `https://client.test/shares/${publicId}/locations/${encodeURIComponent(assetRef)}`,
      { headers: { Cookie: cookie } }, requestEnv, executionCtx,
    )).status).toBe(404);
    await db.prepare("UPDATE client_share_delegation_policies SET image_location_map_enabled=1 WHERE delegation_id=?")
      .bind(delegationId).run();

    const visibleRef = encodeItemRef("visible.jpg");
    const download = await router.request(
      `https://client.test/shares/${publicId}/items/${visibleRef}/download`, { headers: { Cookie: cookie } }, requestEnv, executionCtx,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("visible-image");
    expect(download.headers.get("Content-Disposition")).toContain("attachment");
    const hidden = await router.request(
      `https://client.test/shares/${publicId}/items/${encodeItemRef("_ltds/hidden.jpg")}/download`,
      { headers: { Cookie: cookie } }, requestEnv, executionCtx,
    );
    expect(hidden.status).toBe(404);
    const deleted = await router.request(
      `https://client.test/shares/${publicId}/items/${encodeItemRef("deleted.jpg")}/download`,
      { headers: { Cookie: cookie } }, requestEnv, executionCtx,
    );
    expect(deleted.status).toBe(404);
    const sibling = await router.request(
      `https://client.test/shares/${publicId}/items/${encodeItemRef("../sibling/secret.pdf")}/download`,
      { headers: { Cookie: cookie } }, requestEnv, executionCtx,
    );
    expect(sibling.status).toBeGreaterThanOrEqual(400);

    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=?")
      .bind(workspaceId, identityId).run();
    expect((await router.request(`https://client.test/shares/${publicId}/manifest`, {
      headers: { Cookie: cookie },
    }, requestEnv, executionCtx)).status).toBe(404);
    expect((await router.request(`https://client.test/shares/${publicId}/locations`, {
      headers: { Cookie: cookie },
    }, requestEnv, executionCtx)).status).toBe(404);
    expect((await router.request(
      `https://client.test/shares/${publicId}/locations/${encodeURIComponent(assetRef)}`,
      { headers: { Cookie: cookie } }, requestEnv, executionCtx,
    )).status).toBe(404);
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='active',revoked_at=NULL WHERE workspace_id=? AND identity_id=?")
      .bind(workspaceId, identityId).run();
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='binding-v2' WHERE id=?").bind(bindingId).run();
    expect((await router.request(`https://client.test/shares/${publicId}/manifest`, {
      headers: { Cookie: cookie },
    }, requestEnv, executionCtx)).status).toBe(404);
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='binding-v1' WHERE id=?").bind(bindingId).run();
    await db.prepare("UPDATE client_share_delegations SET status='revoked',revoked_at=datetime('now') WHERE id=?")
      .bind(delegationId).run();
    expect((await router.request(`https://client.test/shares/${publicId}/manifest`, {
      headers: { Cookie: cookie },
    }, requestEnv, executionCtx)).status).toBe(404);
    await db.prepare("UPDATE client_share_delegations SET status='active',revoked_at=NULL WHERE id=?")
      .bind(delegationId).run();
    await db.prepare("UPDATE client_delegated_shares SET share_version=2 WHERE id=?").bind(shareId).run();
    expect((await router.request(`https://client.test/shares/${publicId}/manifest`, {
      headers: { Cookie: cookie },
    }, requestEnv, executionCtx)).status).toBe(404);
    await db.prepare("UPDATE client_delegated_shares SET share_version=1 WHERE id=?").bind(shareId).run();
  }, 30_000);

  it("keeps links workspace-owned across reviewed delegate replacement and revokes idempotently", async () => {
    const listed = await listClientDelegatedShares(env, principal, workspaceId);
    expect(listed).toEqual([expect.objectContaining({ publicId, path: `/client-share/${publicId}` })]);
    expect(JSON.stringify(listed)).not.toContain("clients/private");
    expect(await listClientDelegatedShares(env, otherPrincipal, workspaceId)).toBeNull();

    await db.batch([
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status)
        VALUES ('membership-000002',?,'identity-00000002','operations','active')`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
         entitlement_version,status,valid_from)
        VALUES ('replacement-share-1',?,'identity-00000002','delegated_share.create','allow','folder',?,1,'active',datetime('now','-1 day'))`)
        .bind(workspaceId, bindingId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
         entitlement_version,status,valid_from)
        VALUES ('replacement-view-01',?,'identity-00000002','workspace.view','allow','workspace',?,1,'active',datetime('now','-1 day'))`)
        .bind(workspaceId, workspaceId),
    ]);
    // Reviewed Operations adoption changes the delegation authority; the
    // original creator remains immutable provenance on the share row.
    await db.prepare(`UPDATE client_share_delegations
      SET identity_id='identity-00000002',entitlement_id='replacement-share-1',
        entitlement_version=1,delegation_version=delegation_version+1
      WHERE id=?`).bind(delegationId).run();
    expect(await authorizeClientDelegatedPublicShare(env, publicId, 1)).not.toBeNull();
    expect(await listClientDelegatedShares(env, principal, workspaceId)).toEqual([]);
    expect(await listClientDelegatedShares(env, otherPrincipal, workspaceId))
      .toEqual([expect.objectContaining({ publicId })]);
    const secondShareId = "client-share-000002";
    await db.prepare(`INSERT INTO client_delegated_shares
      (id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,
       token_hash,share_version,expires_at,status,idempotency_key,request_fingerprint)
      VALUES (?,'clientpublicid0000000002',?,?,?,?,?,1,datetime('now','+1 day'),'active','create-key-00000002',?)`)
      .bind(secondShareId, workspaceId, delegationId, identityId, childTargetId, "u".repeat(43), "g".repeat(43)).run();
    expect(await revokeClientDelegatedShare(env, principal, workspaceId, shareId, "revoke-key-000001")).toBe("denied");
    expect(await revokeClientDelegatedShare(env, otherPrincipal, workspaceId, shareId, "revoke-key-000001")).toBe("revoked");
    expect(await revokeClientDelegatedShare(env, otherPrincipal, workspaceId, shareId, "revoke-key-000001")).toBe("replayed");
    expect(await revokeClientDelegatedShare(env, otherPrincipal, workspaceId, secondShareId, "revoke-key-000001")).toBe("revoked");
    expect(await db.prepare("SELECT status FROM client_delegated_shares WHERE id=?").bind(secondShareId).first("status")).toBe("revoked");
    expect(await authorizeClientDelegatedPublicShare(env, publicId, 1)).toBeNull();
  }, 20_000);

  it("uses a distinct cookie name and signing context that cannot replay staff sessions", async () => {
    const secret = "a".repeat(48), keyId = "client-v1", expiresAt = Date.now() + 60_000;
    const clientCookie = await createClientDelegatedShareSessionCookie(secret, keyId, {
      shareId, shareVersion: 2, expiresAt,
    });
    expect(clientCookie).toContain(`${CLIENT_DELEGATED_SHARE_COOKIE}=`);
    expect(clientCookie).toContain("Path=/client-share/");
    const clientValue = parseCookie(clientCookie, CLIENT_DELEGATED_SHARE_COOKIE);
    await expect(verifyClientDelegatedShareSessionCookie(secret, keyId, clientValue))
      .resolves.toMatchObject({ shareId, shareVersion: 2 });

    const staffCookie = await createSessionCookie(secret, keyId, shareId, 2, expiresAt);
    const staffValue = parseCookie(staffCookie, "__Host-ltds_delivery");
    await expect(verifyClientDelegatedShareSessionCookie(secret, keyId, staffValue)).rejects.toThrow("Invalid client share session");
    await expect(verifyClientDelegatedShareSessionCookie(secret, keyId, parseCookie(staffCookie, CLIENT_DELEGATED_SHARE_COOKIE)))
      .rejects.toThrow("required");
  });

  it("keeps creation hard-disabled without an Operations signer binding", () => {
    expect(clientDelegatedShareCreationCapability({
      ...env,
      CLIENT_DELEGATED_SHARES_ENABLED: "true",
      CLIENT_DELEGATED_SHARE_SESSION_SECRET: "x".repeat(48),
    })).toEqual({ enabled: false, reason: "operations-signer-binding-required" });
  });

  it("returns unavailable before authorization or durable rate mutation", async () => {
    const eventsBefore = await db.prepare("SELECT COUNT(*) count FROM client_delegated_share_events").first<number>("count");
    const repository = {
      resolveSession: async () => ({
        accountId: "legacy-account", identityId, displayName: "Organization",
        role: "manager", canViewBilling: false,
      }),
    } as unknown as ClientPortalRepository;
    const router = createClientPortalRouter({ resolvePrincipal: async () => principal, repository });
    const response = await router.request(
      `https://client.test/v2/workspaces/${workspaceId}/delegated-shares`,
      {
        method: "POST",
        headers: {
          Origin: "https://client.test",
          "Content-Type": "application/json",
          "Idempotency-Key": "create-disabled-0001",
        },
        body: JSON.stringify({
          delegationId,
          folderTargetId: childTargetId,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      },
      {
        ...env,
        CLIENT_PORTAL_ENABLED: "true",
        CLIENT_PORTAL_ORIGIN: "https://client.test",
        CLIENT_DELEGATED_SHARES_ENABLED: "true",
      },
    );
    expect(response.status).toBe(503);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_delegated_share_rate_windows WHERE action='create'").first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_delegated_share_events").first("count")).toBe(eventsBefore);
  });

  it("is migration-idempotent and denies expired or revoked delegation state immediately", async () => {
    await applySql(db, migration);
    await applySql(db, provisioningMigration);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await db.prepare("UPDATE client_share_delegations SET expires_at=datetime('now','-1 second') WHERE id=?")
      .bind(delegationId).run();
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, childTargetId)).toBeNull();
    await db.prepare("UPDATE client_share_delegations SET expires_at=datetime('now','+7 day'),status='revoked',revoked_at=datetime('now') WHERE id=?")
      .bind(delegationId).run();
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, childTargetId)).toBeNull();
  });
});
