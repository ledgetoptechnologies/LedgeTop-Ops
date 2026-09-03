import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import delegatedShareMigration from "../migrations/0124_client_delegated_public_shares.sql?raw";
import expiryMigration from "../migrations/0194_client_delegated_share_expiry.sql?raw";
import {
  effectiveClientDelegatedShareStatus,
  reconcileExpiredClientDelegatedShares,
} from "../src/worker/client-portal/delegated-shares";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const NOW = Date.UTC(2026, 8, 3, 5, 0, 0);
const past = new Date(NOW - 60_000).toISOString();
const future = new Date(NOW + 86_400_000).toISOString();

async function apply(db: D1Database, sql: string): Promise<void> {
  const statements = splitD1MigrationStatements(sql);
  if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
}

async function database(runtime: Miniflare, name: string): Promise<D1Database> {
  const db = await runtime.getD1Database(name) as unknown as D1Database;
  await apply(db, `
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE portal_v2_workspace_memberships(
      workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id,identity_id));
    CREATE TABLE portal_v2_entitlements(
      id TEXT NOT NULL,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,
      PRIMARY KEY(id),UNIQUE(id,workspace_id,identity_id));
    CREATE TABLE portal_v2_folder_bindings(
      id TEXT NOT NULL,workspace_id TEXT NOT NULL,
      PRIMARY KEY(id),UNIQUE(id,workspace_id));
  `);
  await apply(db, delegatedShareMigration);
  await apply(db, expiryMigration);
  return db;
}

async function seedGraph(db: D1Database, suffix: string, input: {
  workspaceId: string;
  shareExpiresAt: string;
  delegationExpiresAt: string;
}): Promise<{ shareId: string; delegationId: string; identityId: string }> {
  const identityId = `identity-${suffix}-00000001`;
  const entitlementId = `entitlement-${suffix}-00001`;
  const bindingId = `binding-${suffix}-000000001`;
  const targetId = `target-${suffix}-0000000001`;
  const delegationId = `delegation-${suffix}-000001`;
  const shareId = `client-share-${suffix}-000001`;
  const publicId = `public-${suffix}-0000000000001`;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO portal_v2_workspaces(id) VALUES(?)").bind(input.workspaceId),
    db.prepare("INSERT OR IGNORE INTO portal_v2_identities(id) VALUES(?)").bind(identityId),
    db.prepare("INSERT OR IGNORE INTO portal_v2_workspace_memberships(workspace_id,identity_id) VALUES(?,?)")
      .bind(input.workspaceId, identityId),
    db.prepare("INSERT OR IGNORE INTO portal_v2_entitlements(id,workspace_id,identity_id) VALUES(?,?,?)")
      .bind(entitlementId, input.workspaceId, identityId),
    db.prepare("INSERT OR IGNORE INTO portal_v2_folder_bindings(id,workspace_id) VALUES(?,?)")
      .bind(bindingId, input.workspaceId),
    db.prepare(`INSERT INTO client_share_folder_targets
      (id,workspace_id,folder_binding_id,binding_source_version,relative_prefix,created_by_staff_id)
      VALUES(?,?,?,'binding-v1','deliverables/','staff-test')`)
      .bind(targetId, input.workspaceId, bindingId),
    db.prepare(`INSERT INTO client_share_delegations
      (id,workspace_id,identity_id,entitlement_id,entitlement_version,folder_binding_id,
       folder_binding_source_version,root_target_id,expires_at,created_by_staff_id)
      VALUES(?,?,?,?,1,?,'binding-v1',?,?,'staff-test')`)
      .bind(delegationId, input.workspaceId, identityId, entitlementId, bindingId, targetId,
        input.delegationExpiresAt),
    db.prepare(`INSERT INTO client_delegated_shares
      (id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,token_hash,
       expires_at,idempotency_key,request_fingerprint)
      VALUES(?,?,?,?,?,?,?,?,'expiry-seed-key',?)`)
      .bind(shareId, publicId, input.workspaceId, delegationId, identityId, targetId,
        suffix.repeat(43).slice(0, 43), input.shareExpiresAt, "f".repeat(43)),
  ]);
  return { shareId, delegationId, identityId };
}

describe("delegated-share expiry reconciliation", () => {
  let runtime: Miniflare;

  beforeAll(() => {
    runtime = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: {
        EXPIRY_DB_A: "delegated-expiry-a",
        EXPIRY_DB_B: "delegated-expiry-b",
        EXPIRY_DB_C: "delegated-expiry-c",
      },
    });
  });

  afterAll(async () => runtime.dispose());

  it("materializes share and delegation expiry once with deterministic workspace-scoped events", async () => {
    const db = await database(runtime, "EXPIRY_DB_A");
    const first = await seedGraph(db, "a", {
      workspaceId: "workspace-a-000001", shareExpiresAt: past, delegationExpiresAt: future,
    });
    const second = await seedGraph(db, "b", {
      workspaceId: "workspace-b-000001", shareExpiresAt: future, delegationExpiresAt: past,
    });
    const terminal = await seedGraph(db, "terminal", {
      workspaceId: "workspace-terminal-1", shareExpiresAt: past, delegationExpiresAt: past,
    });
    await db.batch([
      db.prepare("UPDATE client_delegated_shares SET status='failed' WHERE id=?").bind(terminal.shareId),
      db.prepare("UPDATE client_share_delegations SET status='suspended' WHERE id=?").bind(terminal.delegationId),
    ]);
    const result = await reconcileExpiredClientDelegatedShares({ DELIVERY_DB: db }, { now: NOW });
    expect(result).toEqual({ sharesExpired: 1, delegationsExpired: 2, sharesAtLimit: false, delegationsAtLimit: false });
    expect(await db.prepare("SELECT status,share_version FROM client_delegated_shares WHERE id=?")
      .bind(first.shareId).first()).toEqual({ status: "expired", share_version: 2 });
    expect(await db.prepare("SELECT status,delegation_version FROM client_share_delegations WHERE id=?")
      .bind(second.delegationId).first()).toEqual({ status: "expired", delegation_version: 2 });
    expect(await db.prepare("SELECT status FROM client_delegated_shares WHERE id=?")
      .bind(terminal.shareId).first("status")).toBe("failed");
    expect(await db.prepare("SELECT status,delegation_version FROM client_share_delegations WHERE id=?")
      .bind(terminal.delegationId).first()).toEqual({ status: "expired", delegation_version: 2 });
    expect((await db.prepare(`SELECT id,workspace_id,event_type,actor_type,actor_id FROM client_delegated_share_events
      ORDER BY id`).all()).results).toEqual([
      {
        id: `client-delegation-expired:${second.delegationId}`,
        workspace_id: "workspace-b-000001", event_type: "delegation.expired",
        actor_type: "system", actor_id: "client-portal-expiry",
      },
      {
        id: `client-delegation-expired:${terminal.delegationId}`,
        workspace_id: "workspace-terminal-1", event_type: "delegation.expired",
        actor_type: "system", actor_id: "client-portal-expiry",
      },
      {
        id: `client-share-expired:${first.shareId}`,
        workspace_id: "workspace-a-000001", event_type: "client_share.expired",
        actor_type: "system", actor_id: "client-portal-expiry",
      },
    ]);
    expect(await reconcileExpiredClientDelegatedShares({ DELIVERY_DB: db }, { now: NOW }))
      .toEqual({ sharesExpired: 0, delegationsExpired: 0, sharesAtLimit: false, delegationsAtLimit: false });
    expect(await db.prepare("SELECT count(*) count FROM client_delegated_share_events").first("count")).toBe(3);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(3);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_entitlements").first("count")).toBe(3);
  });

  it("preserves the terminal winner for both revoke-before-expiry and expiry-before-revoke", async () => {
    const db = await database(runtime, "EXPIRY_DB_B");
    const revokedFirst = await seedGraph(db, "c", {
      workspaceId: "workspace-c-000001", shareExpiresAt: past, delegationExpiresAt: future,
    });
    const expiredFirst = await seedGraph(db, "d", {
      workspaceId: "workspace-d-000001", shareExpiresAt: past, delegationExpiresAt: future,
    });
    await db.prepare(`UPDATE client_delegated_shares SET status='revoked',revoked_at=?,share_version=share_version+1
      WHERE id=? AND status IN ('pending_signer','active','failed') AND revoked_at IS NULL`)
      .bind(new Date(NOW - 1_000).toISOString(), revokedFirst.shareId).run();
    expect((await reconcileExpiredClientDelegatedShares({ DELIVERY_DB: db }, { now: NOW })).sharesExpired).toBe(1);
    const lateRevoke = await db.prepare(`UPDATE client_delegated_shares SET status='revoked',revoked_at=?,share_version=share_version+1
      WHERE id=? AND status IN ('pending_signer','active','failed') AND revoked_at IS NULL`)
      .bind(new Date(NOW + 1_000).toISOString(), expiredFirst.shareId).run();
    expect(lateRevoke.meta.changes).toBe(0);
    expect(await db.prepare("SELECT status FROM client_delegated_shares WHERE id=?")
      .bind(revokedFirst.shareId).first("status")).toBe("revoked");
    expect(await db.prepare("SELECT status FROM client_delegated_shares WHERE id=?")
      .bind(expiredFirst.shareId).first("status")).toBe("expired");
    expect(await db.prepare("SELECT count(*) count FROM client_delegated_share_events WHERE share_id=?")
      .bind(revokedFirst.shareId).first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM client_delegated_share_events WHERE share_id=? AND event_type='client_share.expired'")
      .bind(expiredFirst.shareId).first("count")).toBe(1);
  });

  it("keeps each pass bounded and reports elapsed status before maintenance runs", async () => {
    const db = await database(runtime, "EXPIRY_DB_C");
    const graph = await seedGraph(db, "e", {
      workspaceId: "workspace-e-000001", shareExpiresAt: past, delegationExpiresAt: future,
    });
    for (let index = 2; index <= 5; index++) {
      await db.prepare(`INSERT INTO client_delegated_shares
        (id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,token_hash,
         expires_at,idempotency_key,request_fingerprint)
        SELECT ?,?,workspace_id,delegation_id,created_by_identity_id,folder_target_id,?,?,?,?
        FROM client_delegated_shares WHERE id=?`)
        .bind(`client-share-e-00000${index}`, `public-e-000000000000${index}`,
          String(index).repeat(43).slice(0, 43), past, `expiry-seed-key-${index}`, "f".repeat(43), graph.shareId).run();
    }
    expect(effectiveClientDelegatedShareStatus("active", past, NOW)).toBe("expired");
    expect(effectiveClientDelegatedShareStatus("failed", past, NOW)).toBe("failed");
    expect(effectiveClientDelegatedShareStatus("revoked", past, NOW)).toBe("revoked");
    expect(await reconcileExpiredClientDelegatedShares({ DELIVERY_DB: db }, { now: NOW, limitPerType: 2 }))
      .toMatchObject({ sharesExpired: 2, sharesAtLimit: true });
    expect(await reconcileExpiredClientDelegatedShares({ DELIVERY_DB: db }, { now: NOW, limitPerType: 2 }))
      .toMatchObject({ sharesExpired: 2, sharesAtLimit: true });
    expect(await reconcileExpiredClientDelegatedShares({ DELIVERY_DB: db }, { now: NOW, limitPerType: 2 }))
      .toMatchObject({ sharesExpired: 1, sharesAtLimit: false });
    expect(await db.prepare("SELECT count(*) count FROM client_delegated_share_events WHERE event_type='client_share.expired'")
      .first("count")).toBe(5);
  });

  it("wires the reconciler only into the hourly maintenance window", () => {
    const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    const hourly = source.match(/if \(event\.cron === "15 \* \* \* \*"\) tasks\.push\(([\s\S]*?)\n  \);/);
    expect(hourly?.[1]).toContain("reconcileExpiredClientDelegatedShares(env)");
    expect(source.match(/reconcileExpiredClientDelegatedShares\(env\)/g)).toHaveLength(1);
  });
});
