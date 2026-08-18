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
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT);
    CREATE TABLE portal_v2_identity_eligibility_bindings(identity_id TEXT,workspace_id TEXT,principal_public_id TEXT);
    CREATE TABLE portal_v2_workspace_memberships(identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT);
    CREATE TABLE portal_v2_identity_eligibility_blocks(id TEXT PRIMARY KEY,match_type TEXT,issuer TEXT,subject TEXT,
      normalized_email TEXT,reason_code TEXT,status TEXT DEFAULT 'active',valid_from TEXT DEFAULT (datetime('now')),
      expires_at TEXT,created_by_actor_type TEXT,created_by_actor_id TEXT,created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),revoked_at TEXT);
    CREATE TABLE portal_v2_identity_eligibility_block_mutations(actor_staff_id TEXT,idempotency_key TEXT,action TEXT,
      request_fingerprint TEXT,block_id TEXT,PRIMARY KEY(actor_staff_id,idempotency_key));
    CREATE TABLE portal_v2_identity_eligibility_block_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,block_id TEXT,action TEXT,
      actor_staff_id TEXT,details_json TEXT);
    INSERT INTO pa_portal_principals VALUES('workspace-one','principal-one','Acme Client','CLIENT@EXAMPLE.TEST','v1','active');
  `);
  return { database, env: { DELIVERY_DB: database, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true" } as Env };
}

afterEach(async () => { vi.clearAllMocks(); await Promise.all(active.splice(0).map(item => item.dispose())); });

describe("client identity eligibility administration", () => {
  it("creates, replays, lists, and revokes a normalized audited block", async () => {
    const { database, env } = await fixture();
    const input = { matchType: "email" as const, email: " Client@Example.Test ", reasonCode: "operator_opt_out", expiresAt: null };
    const created = await createEligibilityBlock(env, principal, input, "eligibility-key-0001");
    expect(created.replayed).toBe(false);
    expect(await createEligibilityBlock(env, principal, input, "eligibility-key-0001")).toEqual({ id: created.id, replayed: true });
    await expect(createEligibilityBlock(env, principal, { ...input, reasonCode: "changed" }, "eligibility-key-0001"))
      .rejects.toMatchObject({ status: 409 });
    const listed = await listClientIdentityEligibility(env, principal);
    expect(listed.clients).toEqual([expect.objectContaining({ display_name: "Acme Client", blocked: 1 })]);
    expect(listed.blocks).toEqual([expect.objectContaining({ id: created.id, normalized_email: "client@example.test", status: "active" })]);
    expect(await revokeEligibilityBlock(env, principal, created.id, "operator_opt_in", "eligibility-key-0002"))
      .toEqual({ id: created.id, replayed: false });
    expect(await database.prepare("SELECT COUNT(*) count FROM portal_v2_identity_eligibility_block_audit")
      .first<number>("count")).toBe(2);
  });

  it("fails closed when the feature or global permissions are unavailable", async () => {
    const { env } = await fixture();
    await expect(listClientIdentityEligibility({ ...env, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "false" }, principal))
      .rejects.toMatchObject({ status: 404 });
    acl.sqlScope.mockResolvedValueOnce({ global: false, deniedGlobal: false });
    await expect(listClientIdentityEligibility(env, principal)).rejects.toMatchObject({ status: 403 });
    acl.isAdministrator.mockResolvedValueOnce(false);
    await expect(createEligibilityBlock(env, principal,
      { matchType: "email", email: "client@example.test", reasonCode: "operator_opt_out" }, "eligibility-key-0003"))
      .rejects.toMatchObject({ status: 403 });
  });
});
