import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { listClientExternalAccess } from "../src/worker/client-external-access";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";

const active: Miniflare[] = [];
const sql = (database: D1Database, statement: string) => database.exec(statement.replace(/\s*\n\s*/g, " "));

function context(workspace = "workspace-one", version = "context-one"): ClientHubCollectionContext {
  return {
    root: { source_id: "project-alpha:primary", source_name: "Project Alpha", root_namespace: "business", kind: "organization",
      public_id: "organization-one", pa_public_id: "organization-public", mapping_status: "mapped", display_name: "Organization One",
      sort_name: "Organization One", status: "active", portal_status: "active", workspace_id: workspace, legacy_account_id: null,
      account_count: 0, project_count: 0, request_count: 0, contact_count: 0, meaningful_activity_at: null,
      source_version: null, indexed_at: "", scan_generation: 1 },
    access: { directory: true, requests: false, delivery: false, viewer: false },
    canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "organization-one" },
    contextVersion: version,
  };
}

async function fixture() {
  const miniflare = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){ return new Response('ok'); } }", d1Databases: { DELIVERY_DB: "external-access" } });
  active.push(miniflare);
  const db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await sql(db, `
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT NOT NULL,display_name TEXT);
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,verified_email TEXT,status TEXT NOT NULL,revoked_at TEXT);
    CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,source_type TEXT NOT NULL,
      status TEXT NOT NULL,source_version TEXT,expires_at TEXT,revoked_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE pa_portal_principals(workspace_id TEXT NOT NULL,public_id TEXT NOT NULL,identity_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL,source_version TEXT NOT NULL);
    CREATE TABLE portal_v2_entitlements(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,effect TEXT NOT NULL,status TEXT NOT NULL,
      valid_from TEXT NOT NULL,expires_at TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_identity_eligibility_blocks(id TEXT PRIMARY KEY,match_type TEXT NOT NULL,normalized_email TEXT,issuer TEXT,subject TEXT,
      status TEXT NOT NULL,valid_from TEXT NOT NULL,expires_at TEXT);
    CREATE TABLE portal_v2_invitations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,token_hash TEXT NOT NULL,invited_email TEXT NOT NULL,
      accepted_by_identity_id TEXT,status TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE portal_v2_invitation_entitlements(invitation_id TEXT NOT NULL,capability TEXT NOT NULL);
    INSERT INTO portal_v2_workspaces VALUES('workspace-one','active','Organization One');
    INSERT INTO portal_v2_workspaces VALUES('workspace-two','active','Other Organization');
    INSERT INTO portal_v2_identities VALUES('identity-ops','issuer','ops','ops@example.test','active',NULL);
    INSERT INTO portal_v2_identities VALUES('identity-alpha','issuer','alpha','alpha@example.test','active',NULL);
    INSERT INTO portal_v2_identities VALUES('identity-same','issuer','same','ops@example.test','active',NULL);
    INSERT INTO portal_v2_identities VALUES('identity-expired','issuer','expired','expired@example.test','active',NULL);
    INSERT INTO portal_v2_identities VALUES('identity-invalid','issuer','invalid','invalid@example.test','active',NULL);
    INSERT INTO portal_v2_identities VALUES('identity-shell','issuer','shell','shell@example.test','active',NULL);
    INSERT INTO portal_v2_identities VALUES('identity-revoked-at','issuer','revoked-at','revoked-at@example.test','active','2026-08-27 11:00:00');
    INSERT INTO portal_v2_identities VALUES('identity-stale','issuer','stale','stale@example.test','active',NULL);
    INSERT INTO portal_v2_identities VALUES('identity-other','issuer','other','other@example.test','active',NULL);
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-ops','workspace-one','identity-ops','operations','active','ops-v1',NULL,NULL,'2026-08-27 12:00:06');
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-alpha','workspace-one','identity-alpha','project_alpha','active','alpha-v1',NULL,NULL,'2026-08-27 12:00:05');
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-same','workspace-one','identity-same','legacy','active','legacy-v1',NULL,NULL,'2026-08-27 12:00:04');
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-expired','workspace-one','identity-expired','client_invitation','active','invite-v1','2000-01-01 00:00:00',NULL,'2026-08-27 12:00:03');
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-invalid','workspace-one','identity-invalid','operations','active','ops-v2','not-a-date',NULL,'2026-08-27 12:00:02');
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-shell','workspace-one','identity-shell','operations','active','ops-v3',NULL,NULL,'2026-08-27 12:00:08');
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-revoked-at','workspace-one','identity-revoked-at','operations','active','ops-v4',NULL,NULL,'2026-08-27 12:00:00');
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-stale','workspace-one','identity-stale','project_alpha','active','alpha-v2',NULL,NULL,'2026-08-27 11:59:59');
    INSERT INTO portal_v2_workspace_memberships VALUES('membership-other','workspace-two','identity-other','operations','active','other-v1',NULL,NULL,'2026-08-27 12:00:09');
    INSERT INTO pa_portal_principals VALUES('workspace-one','principal-alpha','identity-alpha','Alpha Person','active','alpha-v1');
    INSERT INTO pa_portal_principals VALUES('workspace-one','principal-stale','identity-stale','Stale Person','active','alpha-v1');
    INSERT INTO portal_v2_entitlements VALUES('rule-stale','workspace-one','identity-stale','allow','active','2026-01-01',NULL,NULL);
    INSERT INTO portal_v2_entitlements VALUES('rule-one','workspace-one','identity-ops','allow','active','2026-01-01',NULL,NULL);
    INSERT INTO portal_v2_entitlements VALUES('rule-two','workspace-one','identity-ops','allow','active','2026-01-01',NULL,NULL);
    INSERT INTO portal_v2_entitlements VALUES('denied','workspace-one','identity-ops','deny','active','2026-01-01',NULL,NULL);
    INSERT INTO portal_v2_identity_eligibility_blocks VALUES('block-alpha','email','alpha@example.test',NULL,NULL,'active','2026-01-01',NULL);
    INSERT INTO portal_v2_invitations VALUES('invitation-pending','workspace-one','secret-hash-one','pending@example.test',NULL,'pending','2099-01-01 00:00:00',NULL,'2026-08-27 12:00:07');
    INSERT INTO portal_v2_invitations VALUES('invitation-revoked','workspace-one','secret-hash-two','revoked@example.test',NULL,'revoked','2099-01-01 00:00:00','2026-08-27 13:00:00','2026-08-27 12:00:01');
    INSERT INTO portal_v2_invitations VALUES('invitation-other','workspace-two','secret-hash-three','other-invite@example.test',NULL,'pending','2099-01-01 00:00:00',NULL,'2026-08-27 12:00:10');
    INSERT INTO portal_v2_invitation_entitlements VALUES('invitation-pending','workspace.view');
  `);
  return db;
}

afterEach(async () => { await Promise.all(active.splice(0).map(instance => instance.dispose())); });

describe("Client Hub external access roster", () => {
  it("lists current Operations memberships and unlinked invitations without leaking another workspace", async () => {
    const db = await fixture();
    const result = await listClientExternalAccess({ DELIVERY_DB: db }, context(), { limit: 25 });
    expect(result.items.map(row => row.row_key)).toEqual([
      JSON.stringify(["membership", "membership-shell"]), JSON.stringify(["invitation", "invitation-pending"]), JSON.stringify(["membership", "membership-ops"]),
      JSON.stringify(["membership", "membership-same"]),
    ]);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "membership", display_name: "ops@example.test", source_type: "operations", access_status: "active", assigned_access_count: 2 }),
      expect.objectContaining({ email_hint: "shell@example.test", access_status: "unassigned", assigned_access_count: 0 }),
      expect.objectContaining({ kind: "invitation", email_hint: "pending@example.test", source_type: "client_invitation", access_status: "pending", assigned_access_count: 1 }),
    ]));
    expect(JSON.stringify(result)).not.toContain("secret-hash");
    expect(JSON.stringify(result)).not.toContain("other@example.test");
  });

  it("preserves distinct same-email identities and presents lifecycle failures honestly", async () => {
    const db = await fixture();
    const result = await listClientExternalAccess({ DELIVERY_DB: db }, context(), { status: "all", limit: 25 });
    expect(result.items.filter(row => row.email_hint === "ops@example.test")).toHaveLength(2);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ display_name: "Alpha Person", access_status: "blocked" }),
      expect.objectContaining({ email_hint: "expired@example.test", access_status: "expired" }),
      expect.objectContaining({ email_hint: "invalid@example.test", access_status: "needs_review" }),
      expect.objectContaining({ email_hint: "revoked@example.test", access_status: "revoked" }),
      expect.objectContaining({ email_hint: "revoked-at@example.test", access_status: "revoked" }),
      expect.objectContaining({ email_hint: "stale@example.test", access_status: "needs_review" }),
    ]));
  });

  it("searches unloaded records and applies exact status filters", async () => {
    const db = await fixture();
    const searched = await listClientExternalAccess({ DELIVERY_DB: db }, context(), { q: "alpha person", status: "all", limit: 25 });
    expect(searched.items).toEqual([expect.objectContaining({ display_name: "Alpha Person", access_status: "blocked" })]);
    const revoked = await listClientExternalAccess({ DELIVERY_DB: db }, context(), { status: "revoked", limit: 25 });
    expect(revoked.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ email_hint: "revoked@example.test" }),
      expect.objectContaining({ email_hint: "revoked-at@example.test" }),
    ]));
    expect(revoked.items).toHaveLength(2);
  });

  it("uses a context and filter-bound opaque continuation cursor", async () => {
    const db = await fixture();
    const first = await listClientExternalAccess({ DELIVERY_DB: db }, context(), { status: "all", limit: 2 });
    expect(first.page).toMatchObject({ hasMore: true, returned: 2, limit: 2 });
    expect(first.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await listClientExternalAccess({ DELIVERY_DB: db }, context(), { status: "all", limit: 2, cursor: first.page.nextCursor! });
    expect(second.items.map(row => row.row_key)).not.toEqual(expect.arrayContaining(first.items.map(row => row.row_key)));
    await expect(listClientExternalAccess({ DELIVERY_DB: db }, context(), { status: "active", limit: 2, cursor: first.page.nextCursor! }))
      .rejects.toMatchObject({ status: 409 });
    await expect(listClientExternalAccess({ DELIVERY_DB: db }, context("workspace-one", "replacement-context"), { status: "all", limit: 2, cursor: first.page.nextCursor! }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("reports an unavailable verified workspace instead of a false zero", async () => {
    const db = await fixture(), missing = context();
    missing.root.workspace_id = null;
    const result = await listClientExternalAccess({ DELIVERY_DB: db }, missing);
    expect(result).toMatchObject({ items: [], page: { available: false, reason: "workspace_unavailable" } });
  });
});
