import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";

const acl = vi.hoisted(() => ({
  isAdministrator: vi.fn(async () => true),
  sqlScope: vi.fn(async () => ({ global: true, deniedGlobal: false })),
}));
vi.mock("../src/worker/acl", () => acl);

import {
  createEligibilityBlock,
  listClientIdentityEligibility,
  retryClientPortalInvitation,
  revokeEligibilityBlock,
} from "../src/worker/client-identity-eligibility";
import type { Env, StaffPrincipal } from "../src/worker/types";

const active: Miniflare[] = [];
const principal = { id: "staff-admin" } as StaffPrincipal;
async function applySql(database: D1Database, sql: string): Promise<void> {
  await database.exec(sql.replace(/\s*\n\s*/g, " "));
}

async function fixture() {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){ return new Response('ok'); } }",
    d1Databases: { DELIVERY_DB: "client-eligibility" },
  });
  active.push(miniflare);
  const database = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await applySql(database, `
    CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,display_name TEXT,email_hint TEXT,source_version TEXT,status TEXT);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,display_name TEXT,status TEXT DEFAULT 'active');
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,status TEXT DEFAULT 'active',revoked_at TEXT);
    CREATE TABLE portal_v2_identity_eligibility_bindings(identity_id TEXT,workspace_id TEXT,principal_public_id TEXT);
    CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT,
      PRIMARY KEY(workspace_id,identity_id));
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,display_name TEXT);
    CREATE TABLE portal_v2_entitlements(workspace_id TEXT,identity_id TEXT,capability TEXT,effect TEXT,scope_type TEXT,
      scope_public_id TEXT,status TEXT,revoked_at TEXT,valid_from TEXT,expires_at TEXT);
    CREATE TABLE portal_v2_invitations(id TEXT,workspace_id TEXT,invited_email TEXT,status TEXT,expires_at TEXT,created_at TEXT,
      PRIMARY KEY(id,workspace_id));
    CREATE TABLE portal_v2_invitation_email_outbox(invitation_id TEXT,email_status TEXT,status TEXT,payload_json TEXT,attempts INTEGER,
      last_error_code TEXT,next_attempt_at TEXT,lease_expires_at TEXT,updated_at TEXT);
    CREATE TABLE portal_v2_identity_eligibility_blocks(id TEXT PRIMARY KEY,match_type TEXT,issuer TEXT,subject TEXT,
      normalized_email TEXT,reason_code TEXT,status TEXT DEFAULT 'active',valid_from TEXT DEFAULT (datetime('now')),
      expires_at TEXT,created_by_actor_type TEXT,created_by_actor_id TEXT,created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),revoked_at TEXT);
    CREATE TABLE portal_v2_identity_eligibility_block_mutations(actor_staff_id TEXT,idempotency_key TEXT,action TEXT,
      request_fingerprint TEXT,block_id TEXT,PRIMARY KEY(actor_staff_id,idempotency_key));
    CREATE TABLE portal_v2_identity_eligibility_block_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,block_id TEXT,action TEXT,
      actor_staff_id TEXT,details_json TEXT);
    CREATE TABLE portal_v2_operations_management_mutations(actor_staff_id TEXT,idempotency_key TEXT,action TEXT,
      request_fingerprint TEXT,workspace_id TEXT,principal_public_id TEXT,invitation_id TEXT,outcome TEXT,
      PRIMARY KEY(actor_staff_id,idempotency_key));
    CREATE TABLE portal_v2_operations_management_audit(id TEXT,actor_staff_id TEXT,action TEXT,workspace_id TEXT,
      principal_public_id TEXT,invitation_id TEXT,details_json TEXT);
    INSERT INTO portal_v2_workspaces(id,display_name) VALUES('workspace-one','Acme Workspace');
    INSERT INTO pa_portal_principals VALUES('workspace-one','principal-one','Acme Client','CLIENT@EXAMPLE.TEST','v1','active');
  `);
  return { database, env: { DELIVERY_DB: database, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
    CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true" } as Env };
}

afterEach(async () => { vi.clearAllMocks(); await Promise.all(active.splice(0).map(item => item.dispose())); });

describe("client identity eligibility administration", () => {
  it("scopes detail to one workspace even when the global identity directory exceeds 500", async () => {
    const { database, env } = await fixture();
    await applySql(database, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<509)
      INSERT INTO portal_v2_workspaces(id,display_name) SELECT 'other-'||n,'Other '||n FROM ids;
      WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<509)
      INSERT INTO pa_portal_principals SELECT 'other-'||n,'principal-'||n,'Other '||n,'other-'||n||'@example.test','v1','active' FROM ids;`);
    await applySql(database, `INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,normalized_email,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('target-block','email','client@example.test','test','staff','staff-admin'),
        ('unrelated-block','email','other-1@example.test','test','staff','staff-admin');`);
    await expect(listClientIdentityEligibility(env, principal)).rejects.toMatchObject({ status: 503 });
    const result = await listClientIdentityEligibility(env, principal, { workspaceId: "workspace-one" });
    expect(result.clients).toEqual([expect.objectContaining({ workspace_id: "workspace-one", public_id: "principal-one", blocked: 1 })]);
    expect(result.blocks).toEqual([expect.objectContaining({ id: "target-block" })]);
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(0);
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_entitlements").first("count")).toBe(0);
  }, 30_000);

  it("shows access only for the exact principal workspace when an identity belongs to two workspaces", async () => {
    const { database, env } = await fixture();
    await applySql(database, `
      INSERT INTO portal_v2_workspaces(id,display_name) VALUES('workspace-two','Second Workspace');
      INSERT INTO pa_portal_principals VALUES('workspace-two','principal-two','Second Client','CLIENT@EXAMPLE.TEST','v1','active');
      INSERT INTO portal_v2_identities(id,issuer,subject) VALUES('identity-one','https://identity.example.test','person-one');
      INSERT INTO portal_v2_identity_eligibility_bindings VALUES('identity-one','workspace-one','principal-one');
      INSERT INTO portal_v2_identity_eligibility_bindings VALUES('identity-one','workspace-two','principal-two');
      INSERT INTO portal_v2_workspace_memberships VALUES('workspace-one','identity-one','active',NULL,NULL);
    `);
    const listed = await listClientIdentityEligibility(env, principal);
    expect(listed.clients).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace_id: "workspace-one", identity_id: "identity-one", has_workspace_access: 1 }),
      expect.objectContaining({ workspace_id: "workspace-two", identity_id: "identity-one", has_workspace_access: 0 }),
    ]));
    // Reading the directory must never create the missing membership or grants.
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_entitlements").first("count")).toBe(0);
  });

  it("requires live workspace, identity, and membership state for the access indicator", async () => {
    const { database, env } = await fixture();
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const scenarios = [
      ["workspace-suspended", "suspended", "active", null, "active", null, null],
      ["workspace-disabled", "disabled", "active", null, "active", null, null],
      ["workspace-closed", "closed", "active", null, "active", null, null],
      ["identity-suspended", "active", "suspended", null, "active", null, null],
      ["identity-revoked", "active", "active", past, "active", null, null],
      ["membership-suspended", "active", "active", null, "suspended", null, null],
      ["membership-revoked", "active", "active", null, "active", past, null],
      ["membership-expired", "active", "active", null, "active", null, past],
      ["live", "active", "active", null, "active", null, future],
    ] as const;
    await database.batch(scenarios.flatMap(([id, workspaceStatus, identityStatus, identityRevoked, memberStatus, memberRevoked, memberExpiry]) => [
      database.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,?)").bind(id, id, workspaceStatus),
      database.prepare("INSERT INTO pa_portal_principals VALUES(?,?,?,'client@example.test','v1','active')").bind(id, id, id),
      database.prepare("INSERT INTO portal_v2_identities VALUES(?,'https://identity.example.test',?,?,?)").bind(id, id, identityStatus, identityRevoked),
      database.prepare("INSERT INTO portal_v2_identity_eligibility_bindings VALUES(?,?,?)").bind(id, id, id),
      database.prepare("INSERT INTO portal_v2_workspace_memberships VALUES(?,?,?,?,?)").bind(id, id, memberStatus, memberRevoked, memberExpiry),
    ]));
    const listed = await listClientIdentityEligibility(env, principal);
    for (const [id] of scenarios)
      expect(listed.clients, id).toEqual(expect.arrayContaining([
        expect.objectContaining({ workspace_id: id, has_workspace_access: id === "live" ? 1 : 0 }),
      ]));
  });

  it("does not label a blocked identity as having workspace access", async () => {
    const { database, env } = await fixture();
    await applySql(database, `
      INSERT INTO portal_v2_identities(id,issuer,subject) VALUES('identity-one','https://identity.example.test','person-one');
      INSERT INTO portal_v2_identity_eligibility_bindings VALUES('identity-one','workspace-one','principal-one');
      INSERT INTO portal_v2_workspace_memberships VALUES('workspace-one','identity-one','active',NULL,NULL);
    `);
    const block = await createEligibilityBlock(env, principal,
      { matchType: "issuer_subject", issuer: "https://identity.example.test", subject: "person-one", reasonCode: "operator_opt_out" },
      "eligibility-subject-0001");
    expect((await listClientIdentityEligibility(env, principal)).clients[0])
      .toMatchObject({ blocked: 1, has_workspace_access: 0 });
    await revokeEligibilityBlock(env, principal, block.id, "operator_opt_in", "eligibility-subject-0002");
    expect((await listClientIdentityEligibility(env, principal)).clients[0])
      .toMatchObject({ blocked: 0, has_workspace_access: 1 });
  });

  it("creates, replays, lists, and revokes a normalized audited block", async () => {
    const { database, env } = await fixture();
    const input = { matchType: "email" as const, email: " Client@Example.Test ", reasonCode: "operator_opt_out", expiresAt: null };
    const created = await createEligibilityBlock(env, principal, input, "eligibility-key-0001");
    expect(created.replayed).toBe(false);
    expect(await createEligibilityBlock(env, principal, input, "eligibility-key-0001")).toEqual({ id: created.id, replayed: true });
    await expect(createEligibilityBlock(env, principal, { ...input, reasonCode: "changed" }, "eligibility-key-0001"))
      .rejects.toMatchObject({ status: 409 });
    const listed = await listClientIdentityEligibility(env, principal);
    expect(listed.canManageEligibilityBlocks).toBe(true);
    expect(listed.clients).toEqual([expect.objectContaining({ display_name: "Acme Client", blocked: 1 })]);
    expect(listed.blocks).toEqual([expect.objectContaining({ id: created.id, normalized_email: "client@example.test", status: "active" })]);
    expect(await revokeEligibilityBlock(env, principal, created.id, "operator_opt_in", "eligibility-key-0002"))
      .toEqual({ id: created.id, replayed: false });
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_identity_eligibility_block_audit")
      .first<number>("count")).toBe(2);
  });

  it("retries only a still-valid invitation with an intact delivery secret", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_invitations VALUES
      ('invite-one','workspace-one','client@example.test','pending',datetime('now','+1 day'),datetime('now'))`).run();
    await database.prepare(`INSERT INTO portal_v2_invitation_email_outbox
      (invitation_id,status,payload_json,attempts,last_error_code,next_attempt_at,updated_at)
      VALUES('invite-one','failed','{"token":"kept"}',3,'E_TEMP',datetime('now','+1 hour'),datetime('now'))`).run();
    const enabled = { ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED: "true" };
    await expect(retryClientPortalInvitation(enabled,principal,"workspace-one","principal-one","retry-invitation-0001"))
      .resolves.toMatchObject({ outcome: "queued", replayed: false });
    await expect(retryClientPortalInvitation(enabled,principal,"workspace-one","principal-one","retry-invitation-0001"))
      .resolves.toMatchObject({ outcome: "queued", replayed: true });
    expect(await database.prepare("SELECT status FROM portal_v2_invitation_email_outbox WHERE invitation_id='invite-one'").first("status"))
      .toBe("pending");
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_operations_management_audit").first("count")).toBe(1);
  });

  it("keeps portal recovery default-off, administrator-only, and idempotency scoped to one principal", async () => {
    const { database, env } = await fixture();
    await expect(retryClientPortalInvitation(env,principal,"workspace-one","principal-one","retry-invitation-0002"))
      .rejects.toMatchObject({ status: 404 });
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_operations_management_mutations").first("count")).toBe(0);
    const enabled = { ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED: "true" };
    acl.isAdministrator.mockResolvedValueOnce(false);
    await expect(retryClientPortalInvitation(enabled,principal,"workspace-one","principal-one","retry-invitation-0003"))
      .rejects.toMatchObject({ status: 403 });
    await retryClientPortalInvitation(enabled,principal,"workspace-one","principal-one","retry-invitation-0004");
    await expect(retryClientPortalInvitation(enabled,principal,"workspace-one","different-principal","retry-invitation-0004"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("records terminal invitations as not repairable without changing their outbox", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_invitations VALUES
      ('invite-redacted','workspace-one','client@example.test','accepted',datetime('now','+1 day'),datetime('now'))`).run();
    await database.prepare(`INSERT INTO portal_v2_invitation_email_outbox
      (invitation_id,status,payload_json,attempts,last_error_code,next_attempt_at,updated_at)
      VALUES('invite-redacted','failed','{"redacted":true}',8,'invalid_payload',datetime('now'),datetime('now'))`).run();
    const enabled = { ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED: "true" };
    await expect(retryClientPortalInvitation(enabled,principal,"workspace-one","principal-one","retry-invitation-0005"))
      .resolves.toMatchObject({ outcome: "not_repairable" });
    expect(await database.prepare("SELECT status FROM portal_v2_invitation_email_outbox WHERE invitation_id='invite-redacted'").first("status"))
      .toBe("failed");
  });

  it("rolls the outbox retry back when its immutable receipt cannot be audited", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_invitations VALUES
      ('invite-race','workspace-one','client@example.test','pending',datetime('now','+1 day'),datetime('now'))`).run();
    await database.prepare(`INSERT INTO portal_v2_invitation_email_outbox
      (invitation_id,status,payload_json,attempts,last_error_code,next_attempt_at,updated_at)
      VALUES('invite-race','failed','{"token":"kept"}',3,'E_TEMP',datetime('now'),datetime('now'))`).run();
    await database.exec("CREATE TRIGGER reject_portal_retry_audit BEFORE INSERT ON portal_v2_operations_management_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
    const enabled = { ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED: "true" };
    await expect(retryClientPortalInvitation(enabled,principal,"workspace-one","principal-one","retry-invitation-0006"))
      .rejects.toThrow();
    expect(await database.prepare("SELECT status FROM portal_v2_invitation_email_outbox WHERE invitation_id='invite-race'").first("status"))
      .toBe("failed");
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_operations_management_mutations").first("count")).toBe(0);
  });

  it("keeps reads available while mutations require both rollout flags and administrator authority", async () => {
    const { env } = await fixture();
    await expect(listClientIdentityEligibility({ ...env, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "false" }, principal))
      .resolves.toMatchObject({ canManageEligibilityBlocks: false, clients: [expect.any(Object)] });
    acl.sqlScope.mockResolvedValueOnce({ global: false, deniedGlobal: false });
    await expect(listClientIdentityEligibility(env, principal)).rejects.toMatchObject({ status: 403 });
    await expect(createEligibilityBlock({ ...env, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "false" }, principal,
      { matchType: "email", email: "client@example.test", reasonCode: "operator_opt_out" }, "eligibility-key-0003"))
      .rejects.toMatchObject({ status: 404 });
    await expect(createEligibilityBlock({ ...env, CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "false" }, principal,
      { matchType: "email", email: "client@example.test", reasonCode: "operator_opt_out" }, "eligibility-key-0004"))
      .rejects.toMatchObject({ status: 404 });
    acl.isAdministrator.mockResolvedValueOnce(false);
    await expect(createEligibilityBlock(env, principal,
      { matchType: "email", email: "client@example.test", reasonCode: "operator_opt_out" }, "eligibility-key-0005"))
      .rejects.toMatchObject({ status: 403 });
  });
});
