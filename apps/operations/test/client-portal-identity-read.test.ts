import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";

const acl = vi.hoisted(() => ({ sqlScope: vi.fn(async () => ({ global: true, deniedGlobal: false })),
  isAdministrator: vi.fn(async () => true) }));
vi.mock("../src/worker/acl", () => acl);
import { listPortalIdentityCollection, listPortalIdentityPage, type PortalIdentityScope } from "../src/worker/client-portal-identity-read";
import type { Env, StaffPrincipal } from "../src/worker/types";

const running: Miniflare[] = [];
const actor = { id: "operator-one" } as StaffPrincipal;
const globalScope: PortalIdentityScope = { kind: "global" };
async function sql(db: D1Database, value: string) { await db.exec(value.replace(/\s*\n\s*/g, " ")); }
// Use production CREATE TABLE statements, including foreign keys, uniqueness and
// validity CHECKs. Read tests must not silently simplify away real constraints.
function createTable(migration: string, name: string): string {
  const text = readFileSync(new URL(`../../client/migrations/${migration}`, import.meta.url), "utf8");
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  if (start < 0) throw new Error(`Missing migration table ${name}`);
  return text.slice(start, text.indexOf("\n);", start) + 3);
}
async function fixture() {
  const miniflare = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){return new Response('ok')} }", d1Databases: { DELIVERY_DB: "identity-read" } });
  running.push(miniflare);
  const db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await sql(db, "CREATE TABLE client_accounts(id TEXT PRIMARY KEY);");
  for (const table of ["portal_v2_identities", "portal_v2_workspaces", "portal_v2_workspace_memberships",
    "portal_v2_directory_generations", "portal_v2_directory_entities", "portal_v2_directory_checkpoints",
    "portal_v2_entitlements", "portal_v2_invitations"])
    await sql(db, createTable("0121_client_workspace_hierarchy_v2.sql", table));
  await sql(db, createTable("0125_project_alpha_portal_projection.sql", "pa_portal_principals"));
  await sql(db, createTable("0145_portal_identity_eligibility.sql", "portal_v2_identity_eligibility_bindings"));
  await sql(db, createTable("0145_portal_identity_eligibility.sql", "portal_v2_identity_eligibility_blocks"));
  await sql(db, createTable("0136_portal_v2_identity_denials.sql", "portal_v2_identity_denials"));
  await sql(db, createTable("0123_portal_v2_membership_management.sql", "portal_v2_invitation_email_outbox"));
  // Supporting indexes already shipped with these production tables.
  await sql(db, `CREATE INDEX eligibility_principal ON portal_v2_identity_eligibility_bindings(workspace_id,principal_public_id,identity_id);
    CREATE INDEX entitlement_effective ON portal_v2_entitlements(workspace_id,identity_id,capability,status,effect,expires_at);
    CREATE INDEX eligibility_email ON portal_v2_identity_eligibility_blocks(match_type,normalized_email,status,expires_at);
    CREATE INDEX eligibility_subject ON portal_v2_identity_eligibility_blocks(match_type,issuer,subject,status,expires_at);`);
  await sql(db, readFileSync(new URL("../../client/migrations/0152_portal_identity_read_indexes.sql", import.meta.url), "utf8").replace(/^\s*--.*$/gm, ""));
  const env = { DELIVERY_DB: db, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED: "true",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true", CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true" } as Env;
  await sql(db, `INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status)
    VALUES('workspace-one','organization','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','One','active'),
      ('workspace-two','organization','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','Two','active');
    INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      SELECT 'generation-'||id,id,'native',1,'active',1 FROM portal_v2_workspaces;
    INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
      SELECT id,'generation-'||id,1 FROM portal_v2_workspaces;
    INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version)
      SELECT id,'generation-'||id,'organization',pa_organization_public_id,display_name,'v1' FROM portal_v2_workspaces;
    INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
      VALUES('workspace-one','principal-one',' Person@Example.Test ','Person One','v1','active'),
        ('workspace-two','principal-one','person@example.test','Person Two','v1','active');`);
  return { db, env };
}
function clientScope(workspaceId: string | null, version = "root-version-one",
  sourceId: "project-alpha:primary" | "project-alpha:secondary" = "project-alpha:primary"): PortalIdentityScope {
  return { kind: "client", context: { root: {
    source_id: sourceId, root_namespace: "business", kind: "organization", public_id: "101",
    pa_public_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mapping_status: "mapped", display_name: "One", sort_name: "one",
    status: "active", portal_status: "active", workspace_id: workspaceId, legacy_account_id: null,
    account_count: 0, project_count: 0, request_count: 0, contact_count: 0, meaningful_activity_at: null,
    source_version: null, indexed_at: "", scan_generation: 0,
  }, contextVersion: version, access: { directory: true, delivery: true, viewer: true, requests: true },
  canonicalRoot: { sourceId, rootNamespace: "business", kind: "organization", publicId: "101" } } };
}
async function link(db: D1Database, id = "identity-one", workspace = "workspace-one", explicit = true, version = "v1") {
  await db.prepare("INSERT OR IGNORE INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,'issuer',?,'PERSON@example.test')").bind(id, id).run();
  await db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings(identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
    VALUES(?,?,'principal-one',?,'person@example.test')`).bind(id, workspace, version).run();
  await db.prepare(`INSERT OR IGNORE INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type)
    VALUES(?,?,?,'project_alpha')`).bind(`membership-${workspace}-${id}`, workspace, id).run();
  if (explicit) await db.prepare("UPDATE pa_portal_principals SET identity_id=? WHERE workspace_id=? AND public_id='principal-one'").bind(id, workspace).run();
}
afterEach(async () => {
  await Promise.all(running.splice(0).map(item => item.dispose()));
  vi.clearAllMocks(); acl.sqlScope.mockResolvedValue({ global: true, deniedGlobal: false }); acl.isAdministrator.mockResolvedValue(true);
});

describe("bounded portal identity reads", () => {
  it("keeps read availability separate from mutation flags and never offers malformed-email actions", async () => {
    const { db, env } = await fixture();
    for (const email of ["", "missing-at.example.test", "a@b", " bad email@example.test ", "x".repeat(245) + "@example.test"]) {
      await db.prepare("UPDATE pa_portal_principals SET email_hint=? WHERE workspace_id='workspace-one'").bind(email).run();
      const page = await listPortalIdentityPage(env, actor, clientScope("workspace-one"));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.actions.canCreateEmailBlock).toBe(false);
    }
    await db.prepare("UPDATE pa_portal_principals SET email_hint='valid@example.test' WHERE workspace_id='workspace-one'").run();
    const disabled = await listPortalIdentityPage({ ...env, CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "false",
      CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED: "false" }, actor, clientScope("workspace-one"));
    expect(disabled.items).toHaveLength(1);
    expect(disabled.capabilities).toEqual({ canManagePortal: false, canManageEligibilityBlocks: false, canManageWorkspaceAccess: false,
      canReviewIdentityDetails: true });
    expect(disabled.items[0]!.actions.canCreateEmailBlock).toBe(false);
    acl.isAdministrator.mockResolvedValue(false);
    expect((await listPortalIdentityPage(env, actor, clientScope("workspace-one"))).capabilities)
      .toEqual({ canManagePortal: false, canManageEligibilityBlocks: false, canManageWorkspaceAccess: false, canReviewIdentityDetails: true });
    acl.sqlScope.mockResolvedValue({ global: false, deniedGlobal: false });
    await expect(listPortalIdentityPage(env, actor, globalScope)).rejects.toMatchObject({ status: 403 });
  }, 30_000);

  it("shows a shared global login independently in a secondary workspace without enabling primary-only actions", async () => {
    const { db, env } = await fixture();
    await link(db, "identity-one", "workspace-one");
    await link(db, "identity-one", "workspace-two");
    await db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,expires_at)
      VALUES('secondary-invitation','workspace-two',?,'person@example.test','identity-one','2099-01-01')`).bind("a".repeat(43)).run();
    const primary = await listPortalIdentityPage(env, actor, clientScope("workspace-one"));
    const secondary = await listPortalIdentityPage(env, actor,
      clientScope("workspace-two", "secondary-root", "project-alpha:secondary"));
    expect(primary.items[0]).toMatchObject({ identity_id: "identity-one", binding_status: "linked", has_workspace_access: 1 });
    expect(secondary.items[0]).toMatchObject({ workspace_id: "workspace-two", identity_id: "identity-one",
      binding_status: "linked", has_workspace_access: 1,
      invitation: null,
      actions: { canRetryInvitation: false, canCreateEmailBlock: false, canReviewEligibilityBlocks: false } });
    expect(secondary.capabilities).toEqual({ canManagePortal: false, canManageEligibilityBlocks: false, canManageWorkspaceAccess: false,
      canReviewIdentityDetails: false });
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_identities").first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first("n")).toBe(2);
  }, 30_000);

  it("rejects inactive workspace, identity and membership state without creating new authority", async () => {
    const { db, env } = await fixture(); await link(db);
    const scope = clientScope("workspace-one");
    const scenarios = [
      ["portal_v2_workspaces", "status='suspended'", "status='active'"],
      ["portal_v2_workspaces", "status='disabled'", "status='active'"],
      ["portal_v2_identities", "status='suspended'", "status='active'"],
      ["portal_v2_identities", "revoked_at='2020-01-01'", "revoked_at=NULL"],
      ["portal_v2_workspace_memberships", "status='suspended'", "status='active'"],
      ["portal_v2_workspace_memberships", "revoked_at='2020-01-01'", "revoked_at=NULL"],
      ["portal_v2_workspace_memberships", "expires_at='2020-01-01'", "expires_at=NULL"],
    ] as const;
    for (const [table, inactive, restore] of scenarios) {
      await sql(db, `UPDATE ${table} SET ${inactive};`);
      expect((await listPortalIdentityPage(env, actor, scope)).items[0]!.has_workspace_access, table + inactive).toBe(0);
      await sql(db, `UPDATE ${table} SET ${restore};`);
    }
    expect((await listPortalIdentityPage(env, actor, scope)).items[0]!.has_workspace_access).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements").first("n")).toBe(0);
  }, 30_000);

  it("reports an exact workspace denial without leaking it into another workspace", async () => {
    const { db, env } = await fixture();
    await link(db, "identity-one", "workspace-one");
    await link(db, "identity-one", "workspace-two");
    const before = await listPortalIdentityPage(env, actor, clientScope("workspace-one"));
    await db.prepare(`INSERT INTO portal_v2_identity_denials
      (id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,created_by_actor_type,created_by_actor_id)
      VALUES('workspace-denial-one','identity-one','workspace-one','workspace','workspace-one','operator_workspace_pause','staff','operator-one')`).run();
    const paused = await listPortalIdentityPage(env, actor, clientScope("workspace-one"));
    expect(paused.items[0]).toMatchObject({ has_workspace_access: 0, workspaceAccessSuspended: true,
      workspaceDenialCount: 1, removableWorkspaceDenialId: "workspace-denial-one",
      actions: { canSuspendWorkspaceAccess: false, canReactivateWorkspaceAccess: true } });
    expect(paused.items[0]!.principalContextVersion).not.toBe(before.items[0]!.principalContextVersion);
    const other = await listPortalIdentityPage(env, actor, clientScope("workspace-two"));
    expect(other.items[0]).toMatchObject({ has_workspace_access: 1, workspaceAccessSuspended: false,
      workspaceDenialCount: 0 });
  }, 30_000);

  it("pages over 500 principals and searches unloaded names literally before the limit", async () => {
    const { db, env } = await fixture();
    await sql(db, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<529)
      INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
      SELECT 'workspace-one',printf('bulk-%04d',n),'bulk-'||n||'@example.test','Bulk '||n,'v1','active' FROM ids;`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listPortalIdentityPage(env, actor, globalScope, { limit: 50, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map(item => item.row_key)); cursor = page.page.nextCursor;
      expect(page.items.every(item => item.accessLoaded === false && !("access" in item))).toBe(true);
    } while (cursor);
    expect(seen).toHaveLength(532); expect(new Set(seen).size).toBe(532);
    const longName = "Literal %_ " + "é".repeat(80);
    await db.prepare("UPDATE pa_portal_principals SET display_name=? WHERE public_id='bulk-0529'").bind(longName).run();
    const result = await listPortalIdentityPage(env, actor, globalScope, { q: longName, limit: 1 });
    expect(result.items.map(item => item.public_id)).toEqual(["bulk-0529"]);
    expect(result.page.hasMore).toBe(false);
  }, 120_000);

  it("does not fan out historical bindings or infer current identity from equal email alone", async () => {
    const { db, env } = await fixture();
    await link(db, "old-one", "workspace-one", false, "old-version");
    await link(db, "old-two", "workspace-one", false, "old-version");
    await link(db, "identity-one", "workspace-one", false);
    const page = await listPortalIdentityPage(env, actor, clientScope("workspace-one"));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ binding_status: "linked", identity_id: "identity-one", has_workspace_access: 1 });
    await link(db, "identity-two", "workspace-one", false);
    expect((await listPortalIdentityPage(env, actor, clientScope("workspace-one"), { link: "conflict", limit: 1 })).items[0])
      .toMatchObject({ binding_status: "conflict", identity_id: null, has_workspace_access: 0 });
    await db.prepare("UPDATE pa_portal_principals SET identity_id='old-one' WHERE workspace_id='workspace-one'").run();
    await db.prepare("UPDATE portal_v2_identities SET verified_email='someone-else@example.test' WHERE id='old-one'").run();
    expect((await listPortalIdentityPage(env, actor, clientScope("workspace-one"))).items[0])
      .toMatchObject({ binding_status: "unlinked", identity_id: null, has_workspace_access: 0 });
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements").first("n")).toBe(0);
  }, 30_000);

  it("requires membership in the exact workspace and live principal, identity, and workspace state", async () => {
    const { db, env } = await fixture();
    await link(db);
    await db.prepare("UPDATE pa_portal_principals SET identity_id='identity-one' WHERE workspace_id='workspace-two'").run();
    let page = await listPortalIdentityPage(env, actor, globalScope);
    expect(page.items.map(item => [item.workspace_id, item.has_workspace_access])).toEqual([["workspace-one", 1], ["workspace-two", 0]]);
    await db.prepare("UPDATE portal_v2_workspace_memberships SET expires_at='2000-01-01' WHERE workspace_id='workspace-one'").run();
    page = await listPortalIdentityPage(env, actor, globalScope);
    expect(page.items.every(item => item.has_workspace_access === 0)).toBe(true);
    await db.prepare("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id='workspace-one'").run();
    expect((await listPortalIdentityPage(env, actor, globalScope)).items).toHaveLength(1);
    expect((await listPortalIdentityPage(env, actor, globalScope, { principalStatus: "suspended" })).items[0])
      .toMatchObject({ status: "suspended", has_workspace_access: 0 });
  }, 30_000);

  it("summarizes effective opt-outs independently of paged history with normalized emails", async () => {
    const { db, env } = await fixture(); await link(db);
    await sql(db, `INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,normalized_email,reason_code,status,valid_from,expires_at,created_by_actor_type,created_by_actor_id)
      VALUES('live-one','email','person@example.test','test','active','2000-01-01',NULL,'staff','one'),
        ('live-two','email','PERSON@EXAMPLE.TEST','test','active','2000-01-01',NULL,'staff','one'),
        ('scheduled','email','person@example.test','test','active','2099-01-01',NULL,'staff','one'),
        ('expired','email','person@example.test','test','active','2000-01-01','2001-01-01','staff','one'),
        ('revoked','email','person@example.test','test','revoked','2000-01-01',NULL,'staff','one');`);
    const scope = clientScope("workspace-one");
    let item = (await listPortalIdentityPage(env, actor, scope, { blocked: "yes", limit: 1 })).items[0]!;
    expect(item).toMatchObject({ email_hint: "person@example.test", blocked: 1, effectiveEmailBlockCount: 2,
      removableEmailBlockId: null, has_workspace_access: 0, actions: { canCreateEmailBlock: false } });
    const history = await listPortalIdentityCollection(env, actor, scope, { workspaceId: "workspace-one", publicId: "principal-one" },
      "eligibility-blocks", { expectedPrincipalContext: item.principalContextVersion, limit: 1 });
    expect(history.page.hasMore).toBe(true); expect(history.items).toHaveLength(1);
    await db.prepare("UPDATE portal_v2_identity_eligibility_blocks SET status='revoked' WHERE id='live-two'").run();
    item = (await listPortalIdentityPage(env, actor, scope)).items[0]!;
    expect(item).toMatchObject({ effectiveEmailBlockCount: 1, removableEmailBlockId: "live-one" });
    await db.prepare("UPDATE portal_v2_identity_eligibility_blocks SET status='revoked' WHERE id='live-one'").run();
    item = (await listPortalIdentityPage(env, actor, scope, { blocked: "no" })).items[0]!;
    expect(item).toMatchObject({ blocked: 0, effectiveEmailBlockCount: 0, removableEmailBlockId: null });
  }, 30_000);

  it("pages more than 5000 explicit rules without treating them as effective authorization", async () => {
    const { db, env } = await fixture(); await link(db);
    await sql(db, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<5004)
      INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,valid_from,created_at)
      SELECT printf('rule-%05d',n),'workspace-one','identity-one','delivery.view',CASE WHEN n%2=0 THEN 'allow' ELSE 'deny' END,
        'project','project-'||n,'operations','2000-01-01','2026-01-01' FROM ids;`);
    const scope = clientScope("workspace-one"), item = (await listPortalIdentityPage(env, actor, scope)).items[0]!;
    expect(item.hasExplicitAccess).toBe(true); expect(item.accessLoaded).toBe(false);
    const seen: string[] = []; let cursor: string | null = null;
    do {
      const page = await listPortalIdentityCollection(env, actor, scope, { workspaceId: "workspace-one", publicId: "principal-one" }, "access",
        { expectedPrincipalContext: item.principalContextVersion, limit: 100, ...(cursor ? { cursor } : {}) });
      expect(page.items.every(row => row.effective_now === true && ["allow", "deny"].includes(String(row.effect)))).toBe(true);
      seen.push(...page.items.map(row => String(row.id))); cursor = page.page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5005); expect(new Set(seen).size).toBe(5005);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements").first("n")).toBe(5005);
  }, 180_000);

  it("loads long invitation histories by current workspace/email without exposing delivery secrets", async () => {
    const { db, env } = await fixture(); await link(db);
    await sql(db, `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<509)
      INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,expires_at,created_at)
      SELECT printf('invite-%04d',n),'workspace-one',printf('%043d',n),'PERSON@example.test','identity-one','2099-01-01','2026-01-01' FROM ids;
      INSERT INTO portal_v2_invitation_email_outbox(id,invitation_id,recipient_email,payload_json,status)
      VALUES('outbox','invite-0509','person@example.test','{"token":"never-return-this"}','failed');`);
    const scope = clientScope("workspace-one"), item = (await listPortalIdentityPage(env, actor, scope)).items[0]!;
    expect(item.actions.canRetryInvitation).toBe(true);
    expect(item.invitation?.id).toBe("invite-0509");
    let cursor: string | null = null; const seen: string[] = [];
    do {
      const result = await listPortalIdentityCollection(env, actor, scope, { workspaceId: "workspace-one", publicId: "principal-one" },
        "invitations", { expectedPrincipalContext: item.principalContextVersion, limit: 100, ...(cursor ? { cursor } : {}) });
      expect(JSON.stringify(result)).not.toMatch(/token_hash|payload_json|never-return-this/);
      seen.push(...result.items.map(row => String(row.id))); cursor = result.page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(510);
  }, 60_000);

  it("fences nested reads against principal reassignment, source changes, root changes and different actors", async () => {
    const { db, env } = await fixture(); await link(db);
    const scope = clientScope("workspace-one"), item = (await listPortalIdentityPage(env, actor, scope)).items[0]!;
    const key = { workspaceId: "workspace-one", publicId: "principal-one" };
    await expect(listPortalIdentityCollection(env, actor, scope, key, "access", { expectedPrincipalContext: "" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(listPortalIdentityCollection(env, actor, clientScope("workspace-two"), key, "access", { expectedPrincipalContext: item.principalContextVersion }))
      .rejects.toMatchObject({ status: 404 });
    await expect(listPortalIdentityCollection(env, { ...actor, id: "different-actor" }, scope, key, "access", { expectedPrincipalContext: item.principalContextVersion }))
      .rejects.toMatchObject({ status: 409 });
    await expect(listPortalIdentityCollection(env, actor, clientScope("workspace-one", "different-root"), key, "access", { expectedPrincipalContext: item.principalContextVersion }))
      .rejects.toMatchObject({ status: 409 });
    await db.prepare("UPDATE pa_portal_principals SET source_version='v2' WHERE workspace_id='workspace-one'").run();
    await expect(listPortalIdentityCollection(env, actor, scope, key, "access", { expectedPrincipalContext: item.principalContextVersion }))
      .rejects.toMatchObject({ status: 409 });
    acl.sqlScope.mockResolvedValue({ global: false, deniedGlobal: false });
    await expect(listPortalIdentityPage(env, actor, scope)).rejects.toMatchObject({ status: 403 });
  }, 30_000);

  it("makes unlinked access and missing workspaces explicitly unavailable rather than empty grants", async () => {
    const { env } = await fixture();
    expect((await listPortalIdentityPage(env, actor, clientScope(null))).page)
      .toMatchObject({ available: false, reason: "workspace_unavailable" });
    const scope = clientScope("workspace-one"), item = (await listPortalIdentityPage(env, actor, scope)).items[0]!;
    expect((await listPortalIdentityCollection(env, actor, scope, { workspaceId: "workspace-one", publicId: "principal-one" }, "access",
      { expectedPrincipalContext: item.principalContextVersion })).page).toMatchObject({ available: false, reason: "identity_unlinked" });
    const first = await listPortalIdentityPage(env, actor, globalScope, { limit: 1 });
    await expect(listPortalIdentityPage(env, actor, globalScope, { q: "other", cursor: first.page.nextCursor! })).rejects.toMatchObject({ status: 400 });
    await expect(listPortalIdentityPage(env, actor, globalScope, { cursor: "bad-cursor" })).rejects.toMatchObject({ status: 400 });
    await expect(listPortalIdentityPage(env, actor, globalScope, { limit: 51 })).rejects.toMatchObject({ status: 400 });
  }, 30_000);

  it("pushes workspace and exact principal keys through indexed lookup before expensive hydration", async () => {
    const { db, env } = await fixture();
    const captured: Array<{ query: string; values: unknown[] }> = [];
    const recording = new Proxy(db, {
      get(target, property) {
        if (property !== "withSession") return Reflect.get(target, property);
        return (...args: Parameters<D1Database["withSession"]>) => {
          const session = target.withSession(...args);
          return new Proxy(session, { get(value, key) {
            if (key !== "prepare") return Reflect.get(value, key);
            return (query: string) => {
              const entry = { query, values: [] as unknown[] }; captured.push(entry);
              const handler: ProxyHandler<D1PreparedStatement> = { get(statement, member) {
                if (member !== "bind") return Reflect.get(statement, member);
                return (...bindings: unknown[]) => { entry.values = bindings; return new Proxy(statement.bind(...bindings), handler); };
              } };
              return new Proxy(value.prepare(query), handler);
            };
          } });
        };
      },
    });
    await listPortalIdentityPage({ ...env, DELIVERY_DB: recording }, actor, clientScope("workspace-one"), { limit: 5 });
    const factQueries = captured.filter(entry => entry.query.startsWith("WITH principal_keys"));
    expect(factQueries).toHaveLength(2);
    for (const entry of factQueries) {
      const initialKeys = entry.query.split("), resolved AS")[0]!;
      expect(initialKeys).toContain("FROM pa_portal_principals pa WHERE");
      expect(initialKeys).toContain("pa.workspace_id=?");
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${entry.query}`).bind(...entry.values).all<{ detail: string }>();
      expect(plan.results.some(row => /SEARCH pa USING INDEX .*workspace_id=/.test(row.detail)), JSON.stringify(plan.results)).toBe(true);
      expect(plan.results.some(row => /SCAN pa\b/.test(row.detail))).toBe(false);
    }
  }, 30_000);
});
