import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import migration from "../migrations/0124_client_delegated_public_shares.sql?raw";
import { createSessionCookie, parseCookie } from "../src/worker/security";
import {
  authorizeClientDelegatedPublicShare,
  authorizeClientShareDelegation,
  canonicalDelegatedRelativePrefix,
  CLIENT_DELEGATED_SHARE_COOKIE,
  clientDelegatedShareCreationCapability,
  createClientDelegatedShareSessionCookie,
  delegatedTargetContained,
  listClientDelegatedShares,
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
        pa_client_public_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL);
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
    `);
    await applySql(db, migration);
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
    expect(await revokeClientDelegatedShare(env, principal, workspaceId, shareId, "revoke-key-000001")).toBe("denied");
    expect(await revokeClientDelegatedShare(env, otherPrincipal, workspaceId, shareId, "revoke-key-000001")).toBe("revoked");
    expect(await revokeClientDelegatedShare(env, otherPrincipal, workspaceId, shareId, "revoke-key-000001")).toBe("replayed");
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
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await db.prepare("UPDATE client_share_delegations SET expires_at=datetime('now','-1 second') WHERE id=?")
      .bind(delegationId).run();
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, childTargetId)).toBeNull();
    await db.prepare("UPDATE client_share_delegations SET expires_at=datetime('now','+7 day'),status='revoked',revoked_at=datetime('now') WHERE id=?")
      .bind(delegationId).run();
    expect(await authorizeClientShareDelegation(env, principal, workspaceId, delegationId, childTargetId)).toBeNull();
  });
});
