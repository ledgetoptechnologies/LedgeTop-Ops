import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientDelegatedShareSignerRequestV1 } from "@ltds/shared";
import { readFileSync } from "node:fs";
import migration from "../../client/migrations/0124_client_delegated_public_shares.sql?raw";
import rootAccessMigration from "../../client/migrations/0197_portal_root_access_policy.sql?raw";
import { sha256 } from "../src/worker/crypto";
import { signClientDelegatedShare } from "../src/worker/client-delegated-share-signer";
import type { Env } from "../src/worker/types";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const workspaceId = "workspace-00000001";
const identityId = "identity-00000001";
const delegationId = "delegation-0000001";
const entitlementId = "entitlement-share-01";
const bindingId = "binding-000000001";
const rootTargetId = "target-root-000001";
const childTargetId = "target-child-00001";

async function applySql(db: D1Database, sql: string): Promise<void> {
  await db.exec(sql
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
    .replace(/\s*\n\s*/g, " "));
}

interface Fixture { miniflare: Miniflare; db: D1Database; env: Env; request: ClientDelegatedShareSignerRequestV1 }
const active: Miniflare[] = [];

async function fixture(): Promise<Fixture> {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-07-22",
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DELIVERY_DB: "delegated-signer" },
  });
  active.push(miniflare);
  const db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await applySql(db, `
    CREATE TABLE portal_v2_identities(
      id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,verified_email TEXT,
      status TEXT NOT NULL,revoked_at TEXT,UNIQUE(issuer,subject));
    CREATE TABLE portal_v2_workspaces(
      id TEXT PRIMARY KEY,root_type TEXT NOT NULL,pa_organization_public_id TEXT,
      pa_client_public_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
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
  await applySql(db, rootAccessMigration);
  await db.prepare("PRAGMA foreign_keys=ON").run();
  await db.batch([
    db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
      VALUES (?,'https://clients.example.test','subject-one','one@example.test','active')`).bind(identityId),
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
      VALUES (?,?,?,'delegated_share.create','allow','folder',?,7,'active',datetime('now','-1 day'))`)
      .bind(entitlementId, workspaceId, identityId, bindingId),
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
      VALUES (?,?,?,?,7,?,'binding-v1',?,datetime('now','+7 day'),'staff-one')`)
      .bind(delegationId, workspaceId, identityId, entitlementId, bindingId, rootTargetId),
  ]);
  const env = {
    DELIVERY_DB: db,
    DELIVERY_BASE_URL: "https://client.example.test",
    PUBLIC_SHARE_ORIGIN: "https://delivery.example.test",
    DELIVERY_TOKEN_SECRET: "operations-token-secret-value-that-never-leaves",
    DELIVERY_ACCESS_CODE_PEPPER: "operations-access-pepper-value-that-never-leaves",
    CLIENT_DELEGATED_SHARE_SIGNER_ENABLED: "true",
    CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
  } as Env;
  const request: ClientDelegatedShareSignerRequestV1 = {
    protocolVersion: 1,
    workspaceId,
    delegationId,
    expectedDelegationVersion: 1,
    createdByIdentityId: identityId,
    entitlementId,
    expectedEntitlementVersion: 7,
    folderBindingId: bindingId,
    expectedBindingSourceVersion: "binding-v1",
    folderTargetId: childTargetId,
    label: "Client photos",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    idempotencyKey: "create-client-share-0001",
  };
  return { miniflare, db, env, request };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(active.splice(0).map((instance) => instance.dispose()));
});

describe("private Operations client-delegated share signer", () => {
  it("uses a default-off named-entrypoint service binding with no copied token secret", () => {
    const operationsConfig = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    const clientConfig = JSON.parse(readFileSync(new URL("../../client/wrangler.jsonc", import.meta.url), "utf8"));
    expect(operationsConfig.vars.CLIENT_DELEGATED_SHARE_SIGNER_ENABLED).toBe("false");
    expect(clientConfig.vars.CLIENT_DELEGATED_SHARES_ENABLED).toBe("false");
    expect(clientConfig.services).toContainEqual({
      binding: "CLIENT_DELEGATED_SHARE_SIGNER",
      service: "ltds-ops",
      entrypoint: "ClientDelegatedShareSigner",
    });
    expect(JSON.stringify(clientConfig)).not.toContain("DELIVERY_TOKEN_SECRET");
  });

  it("creates a distinct client namespace bearer without returning storage or Operations secrets", async () => {
    const { db, env, request } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await signClientDelegatedShare(env, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.share.path).toMatch(/^\/client-share\/cs_[A-Za-z0-9_-]+$/);
    expect(result.share.shareUrl).toMatch(/^https:\/\/delivery\.example\.test\/client-share\/cs_.+#[A-Za-z0-9_-]{43}$/);
    expect(result.share.shareUrl).not.toContain("/s/");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("clients/private/project");
    expect(serialized).not.toContain(env.DELIVERY_TOKEN_SECRET);
    expect(serialized).not.toContain("r2Prefix");
    expect(serialized).not.toContain("accessCode");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    const row = await db.prepare("SELECT token_hash,public_id,signer_receipt_id FROM client_delegated_shares WHERE id=?")
      .bind(result.share.id).first<{ token_hash: string; public_id: string; signer_receipt_id: string }>();
    expect(row?.public_id).toBe(result.share.publicId);
    expect(row?.signer_receipt_id).toBe(result.receiptId);
    expect(row?.token_hash).toBe(await sha256(new URL(result.share.shareUrl).hash.slice(1)));
  });

  it("replays the exact idempotency request and rejects key reuse with a different fingerprint", async () => {
    const { env, request } = await fixture();
    const first = await signClientDelegatedShare(env, request);
    const replay = await signClientDelegatedShare(env, request);
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.replayed).toBe(true);
    expect(replay.share.id).toBe(first.share.id);
    expect(replay.share.shareUrl).toBe(first.share.shareUrl);
    expect(replay.receiptId).toBe(first.receiptId);
    await expect(signClientDelegatedShare(env, { ...request, label: "Different" }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "idempotency_conflict" });
  });

  it("denies cross-identity/workspace references and current explicit deny precedence", async () => {
    const { db, env, request } = await fixture();
    await expect(signClientDelegatedShare(env, { ...request, createdByIdentityId: "identity-00000002" }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "denied" });
    await expect(signClientDelegatedShare(env, { ...request, workspaceId: "workspace-00000002" }))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "denied" });
    await db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
       entitlement_version,status,valid_from)
      VALUES ('entitlement-deny-01',?,?,'delegated_share.create','deny','workspace',?,8,'active',datetime('now','-1 day'))`)
      .bind(workspaceId, identityId, workspaceId).run();
    await expect(signClientDelegatedShare(env, request))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "denied" });
  });

  it("does not mint a bearer after the exact workspace root is revoked", async () => {
    const { db, env, request } = await fixture();
    await db.prepare(`INSERT INTO portal_v2_root_access_policies
      (projection_source_id,root_type,root_public_id,state,version,reason_code,
       created_by_staff_id,updated_by_staff_id,updated_at)
      VALUES ('project-alpha:primary','organization','pa-org-one','revoked',1,
        'security_concern','staff-one','staff-one',datetime('now'))`).run();
    await expect(signClientDelegatedShare(env, request))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "denied" });
    expect(await db.prepare("SELECT COUNT(*) count FROM client_delegated_shares")
      .first<number>("count")).toBe(0);
  });

  it("denies stale or revoked delegation, binding and target versions", async () => {
    const { db, env, request } = await fixture();
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='binding-v2' WHERE id=?").bind(bindingId).run();
    await expect(signClientDelegatedShare(env, request)).resolves.toMatchObject({ ok: false, code: "denied" });
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='binding-v1' WHERE id=?").bind(bindingId).run();
    await db.prepare("UPDATE client_share_folder_targets SET binding_source_version='binding-v0' WHERE id=?").bind(childTargetId).run();
    await expect(signClientDelegatedShare(env, request)).resolves.toMatchObject({ ok: false, code: "denied" });
    await db.prepare("UPDATE client_share_folder_targets SET binding_source_version='binding-v1' WHERE id=?").bind(childTargetId).run();
    await db.prepare("UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(bindingId).run();
    await expect(signClientDelegatedShare(env, request)).resolves.toMatchObject({ ok: false, code: "denied" });
    await db.prepare("UPDATE portal_v2_folder_bindings SET status='active',revoked_at=NULL WHERE id=?").bind(bindingId).run();
    await db.prepare("UPDATE client_share_delegations SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(delegationId).run();
    await expect(signClientDelegatedShare(env, request)).resolves.toMatchObject({ ok: false, code: "denied" });
  });

  it("enforces password and lifetime policy and remains disabled by default", async () => {
    const { db, env, request } = await fixture();
    await db.prepare("UPDATE client_share_delegations SET require_password=1,maximum_link_lifetime_seconds=1800 WHERE id=?")
      .bind(delegationId).run();
    await expect(signClientDelegatedShare(env, request)).resolves.toMatchObject({ ok: false, code: "denied" });
    const withinPolicy = { ...request, expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() };
    await expect(signClientDelegatedShare(env, withinPolicy)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    const protectedResult = await signClientDelegatedShare(env, { ...withinPolicy, accessCode: "private-code-123" });
    expect(protectedResult.ok && protectedResult.share.passwordProtected).toBe(true);
    expect(JSON.stringify(protectedResult)).not.toContain("private-code-123");
    await expect(signClientDelegatedShare({ ...env, CLIENT_DELEGATED_SHARE_SIGNER_ENABLED: "false" }, request))
      .resolves.toEqual({ ok: false, protocolVersion: 1, code: "configuration_error" });
  });
});
