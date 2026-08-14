import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import foundationMigration from "../../client/migrations/0124_client_delegated_public_shares.sql?raw";
import provisioningMigration from "../../client/migrations/0130_client_delegated_share_provisioning.sql?raw";
import { encodeRef } from "../src/worker/delivery";
import {
  createDelegatedShareDelegation,
  createDelegatedShareTarget,
  delegatedShareFolderContext,
  listDelegatedShareProvisioning,
  revokeDelegatedShareProvisioningEntity,
  transferDelegatedShareDelegation,
} from "../src/worker/client-delegated-share-provisioning";
import type { Env, StaffPrincipal } from "../src/worker/types";

const active: Miniflare[] = [];
const workspaceId = "workspace-00000001";
const bindingId = "binding-000000001";
const firstIdentity = "identity-00000001";
const secondIdentity = "identity-00000002";
const firstEntitlement = "entitlement-share-01";
const secondEntitlement = "entitlement-share-02";
const principal: StaffPrincipal = {
  id: "staff-administrator", email: "staff@example.test", displayName: "Staff",
  accessSubject: "staff-subject", projectAlphaUserId: null,
};

async function applySql(database: D1Database, sql: string): Promise<void> {
  await database.exec(sql.replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
}

async function fixture(): Promise<{ db: D1Database; env: Env }> {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DELIVERY_DB: "client-delegated-provisioning" },
  });
  active.push(miniflare);
  const database = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await applySql(database, `
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,
      verified_email TEXT,status TEXT NOT NULL,revoked_at TEXT,UNIQUE(issuer,subject));
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT NOT NULL,
      pa_organization_public_id TEXT,pa_client_public_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,
      identity_id TEXT NOT NULL,source_type TEXT NOT NULL,status TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,
      UNIQUE(workspace_id,identity_id));
    CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,status TEXT NOT NULL,complete INTEGER NOT NULL);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT NOT NULL,generation_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,public_id TEXT NOT NULL,parent_public_id TEXT,active INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,generation_id,entity_type,public_id));
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT NOT NULL);
    CREATE TABLE portal_v2_entitlements(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,
      capability TEXT NOT NULL,effect TEXT NOT NULL,scope_type TEXT NOT NULL,scope_public_id TEXT NOT NULL,
      entitlement_version INTEGER NOT NULL,status TEXT NOT NULL,valid_from TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,
      UNIQUE(id,workspace_id,identity_id));
    CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_scope_type TEXT NOT NULL,
      owner_public_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,source_version TEXT,status TEXT NOT NULL,revoked_at TEXT,
      UNIQUE(id,workspace_id));
  `);
  await applySql(database, foundationMigration);
  await applySql(database, provisioningMigration);
  await database.prepare("PRAGMA foreign_keys=ON").run();
  await database.batch([
    database.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status)
      VALUES (?,'organization','pa-org-one','Acme Organization','active')`).bind(workspaceId),
    ...[firstIdentity, secondIdentity].map((identity, index) => database.prepare(`INSERT INTO portal_v2_identities
      (id,issuer,subject,verified_email,status) VALUES (?,'https://clients.test',?,?, 'active')`)
      .bind(identity, `subject-${index}`, `manager-${index}@example.test`)),
    ...[firstIdentity, secondIdentity].map((identity, index) => database.prepare(`INSERT INTO portal_v2_workspace_memberships
      (id,workspace_id,identity_id,source_type,status) VALUES (?,?,?,'project_alpha','active')`)
      .bind(`membership-0000000${index + 1}`, workspaceId, identity)),
    database.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,status,complete)
      VALUES ('generation-000001',?,'active',1)`).bind(workspaceId),
    database.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,active)
      VALUES (?,'generation-000001','organization','pa-org-one',NULL,1)`).bind(workspaceId),
    database.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,active)
      VALUES (?,'generation-000001','project','pa-project-one','pa-org-one',1)`).bind(workspaceId),
    database.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id)
      VALUES (?,'generation-000001')`).bind(workspaceId),
    database.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_version,status)
      VALUES (?,?,'project','pa-project-one','clients/private/project/','binding-v1','active')`).bind(bindingId, workspaceId),
    ...[[firstIdentity, firstEntitlement], [secondIdentity, secondEntitlement]].map(([identity, entitlement]) => database.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,status,valid_from)
      VALUES (?,?,?,'delegated_share.create','allow','folder',?,1,'active',datetime('now','-1 day'))`)
      .bind(entitlement, workspaceId, identity, bindingId)),
  ]);
  return { db: database, env: {
    DELIVERY_DB: database, CLIENT_DELEGATED_SHARE_SIGNER_ENABLED: "true",
  } as Env };
}

afterEach(async () => Promise.all(active.splice(0).map(instance => instance.dispose())));

describe("Operations client-delegated share provisioning", () => {
  it("provisions opaque targets/delegations, transfers recovery authority, and revokes live policy", async () => {
    const { db, env } = await fixture();
    const root = await createDelegatedShareTarget(env, principal, {
      workspaceId, folderBindingId: bindingId,
      folderRef: encodeRef("clients/private/project/deliverables"),
      displayName: "Deliverables", exactRootApproved: true,
    }, "target-create-root-0001");
    const child = await createDelegatedShareTarget(env, principal, {
      workspaceId, folderBindingId: bindingId,
      folderRef: encodeRef("clients/private/project/deliverables/photos"),
      displayName: "Client photos", exactRootApproved: false,
    }, "target-create-child-001");
    expect((await createDelegatedShareTarget(env, principal, {
      workspaceId, folderBindingId: bindingId,
      folderRef: encodeRef("clients/private/project/deliverables/photos"),
      displayName: "Client photos", exactRootApproved: false,
    }, "target-create-child-001")).replayed).toBe(true);

    const delegation = await createDelegatedShareDelegation(env, principal, {
      workspaceId, identityId: firstIdentity, entitlementId: firstEntitlement,
      rootTargetId: root.id, allowExactRoot: false, requirePassword: true,
      imageLocationMapEnabled: true,
      maximumLinkLifetimeSeconds: 86400,
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    }, "delegation-create-0001");
    const state = await listDelegatedShareProvisioning(env);
    expect(state.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: child.id, displayName: "Client photos" }),
    ]));
    expect(state.delegations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: delegation.id, imageLocationMapEnabled: true }),
    ]));
    expect(await db.prepare("SELECT image_location_map_enabled FROM client_share_delegation_policies WHERE delegation_id=?")
      .bind(delegation.id).first("image_location_map_enabled")).toBe(1);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("clients/private");
    expect(serialized).not.toContain("relative_prefix");

    const context = await delegatedShareFolderContext(env, "clients/private/project/deliverables/photos");
    expect(context).toMatchObject({
      workspaceId, folderBindingId: bindingId,
      currentTarget: { id: child.id, displayName: "Client photos" },
      ancestorTargets: [expect.objectContaining({ id: root.id })],
    });

    const transferred = await transferDelegatedShareDelegation(env, principal, delegation.id, {
      identityId: secondIdentity, entitlementId: secondEntitlement, expectedVersion: 1,
    }, "delegation-transfer-01");
    expect(transferred).toMatchObject({ version: 2, replayed: false });
    expect(await db.prepare("SELECT identity_id FROM client_share_delegations WHERE id=?")
      .bind(delegation.id).first("identity_id")).toBe(secondIdentity);

    await revokeDelegatedShareProvisioningEntity(env, principal, "delegation", delegation.id, "delegation-revoke-001");
    expect(await db.prepare("SELECT status FROM client_share_delegations WHERE id=?")
      .bind(delegation.id).first("status")).toBe("revoked");
    expect(await db.prepare("SELECT COUNT(*) count FROM client_delegated_share_events WHERE actor_type='staff'")
      .first("count")).toBe(5);
  }, 20_000);

  it("stays unavailable while the rollout flag is false", async () => {
    const { env } = await fixture();
    await expect(listDelegatedShareProvisioning({ ...env, CLIENT_DELEGATED_SHARE_SIGNER_ENABLED: "false" }))
      .rejects.toMatchObject({ status: 404 });
  });
});
