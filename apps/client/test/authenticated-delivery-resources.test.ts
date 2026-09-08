import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { decodeAuthenticatedDeliveryHandle } from "../src/worker/client-portal/authenticated-delivery-handles";
import { appendAuthenticatedContentStart } from "../src/worker/client-portal/authenticated-content-audit";
import { reservePrimaryPortalSigningKeys } from "../src/worker/project-alpha-portal-authority";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const origin = "https://client.example.test";
const principal: VerifiedClientPrincipal = { issuer: "https://issuer.test", subject: "ad1-owner", email: "ad1-owner@example.test" };
const otherPrincipal: VerifiedClientPrincipal = { issuer: "https://issuer.test", subject: "ad1-other", email: "ad1-other@example.test" };

describe("authenticated delivery resources — migrated effective workspace", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let bucket: R2Bucket;
  let env: Env;
  let currentPrincipal = principal;
  let revokeAtHead = false;
  let rootHandle = "";
  let policyRootHandle = "";

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: { DELIVERY_DB: "authenticated-delivery-resources" }, r2Buckets: { DATA_BUCKET: "authenticated-delivery-resources" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    bucket = await runtime.getR2Bucket("DATA_BUCKET") as unknown as R2Bucket;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    env = {
      DELIVERY_DB: db, DATA_BUCKET: bucket,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true", CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true", CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin,
      DELIVERY_SESSION_SECRET: "authenticated-delivery-resources-session-secret-0001",
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: "authenticated-delivery-resources-primary-hmac-secret-0001",
      ENVIRONMENT: "development",
    } as Env;
    await reservePrimaryPortalSigningKeys(env);
    await seed();
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  function app() {
    return createClientPortalRouter({ resolvePrincipal: async () => currentPrincipal });
  }
  async function request(path: string, init: RequestInit = {}) {
    return app().request(`${origin}${path}`, init, env);
  }
  async function freshRoot() {
    const response = await request("/authenticated-deliveries/files?folder=" + encodeURIComponent(rootHandle), { headers: { "X-LTDS-Workspace-ID": "ad1-workspace" } });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<{ folders: Array<{ id: string; name: string }>; files: Array<{ id: string; name: string }>; breadcrumbs: Array<{ id: string; name: string }> }>;
  }
  async function currentFileHandle() {
    const file = (await freshRoot()).files.find(value => value.name === "readme.txt");
    expect(file?.id).toMatch(/^ad1_[A-Za-z0-9_-]+$/);
    return file!.id;
  }
  async function currentPolicyFileHandle() {
    const response = await request("/authenticated-deliveries/files?folder=" + encodeURIComponent(policyRootHandle), { headers: { "X-LTDS-Workspace-ID": "ad1-workspace" } });
    expect(response.status, await response.clone().text()).toBe(200);
    const file = (await response.json() as { files: Array<{ id: string; name: string }> }).files.find(value => value.name === "readme.txt");
    expect(file?.id).toMatch(/^ad1_[A-Za-z0-9_-]+$/);
    return file!.id;
  }

  it("lists only the exact folder, preserves Unicode children and produces opaque breadcrumbs", async () => {
    const page = await freshRoot();
    expect(page.files.map(file => file.name)).toEqual(["readme.txt"]);
    expect(page.folders.map(folder => folder.name)).toEqual(["evidence", "📷"]);
    expect(page.breadcrumbs).toHaveLength(1);
    expect(page.breadcrumbs[0]!.name).toBe("Shared delivery");
    expect(await decodeAuthenticatedDeliveryHandle(env, page.breadcrumbs[0]!.id)).toMatchObject({ kind: "folder", path: "", eventId: "ad1-event", workspaceId: "ad1-workspace" });
    expect(page.files[0]!.id).toMatch(/^ad1_[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(page)).not.toContain("clients/ad1/effective/");
    expect(JSON.stringify(page)).not.toContain("effective-adjacent");
    const unicode = page.folders.find(folder => folder.name === "📷")!;
    const nested = await request(`/authenticated-deliveries/files?folder=${encodeURIComponent(unicode.id)}`, { headers: { "X-LTDS-Workspace-ID": "ad1-workspace" } });
    expect(nested.status, await nested.clone().text()).toBe(200);
    expect((await nested.json() as { breadcrumbs: Array<{ name: string }>; files: Array<{ name: string }> }).breadcrumbs.map(crumb => crumb.name))
      .toEqual(["Shared delivery", "📷"]);
  });

  it("derives headerless media workspace from the AD1 coordinate and rejects cross-actor or conflicting workspace requests", async () => {
    const fileHandle = await currentFileHandle();
    const full = await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`);
    expect(full.status, await full.clone().text()).toBe(200);
    expect(await full.text()).toBe("readme body");
    const preview = await request(`/authenticated-deliveries/preview?file=${encodeURIComponent(fileHandle)}`);
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(await preview.text()).toBe("readme body");
    const head = await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(full.headers.get("etag"));
    expect(await head.text()).toBe("");
    const ranged = await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`, { headers: { Range: "bytes=0-5" } });
    expect(ranged.status).toBe(206); expect(await ranged.text()).toBe("readme");
    const etag = full.headers.get("etag")!;
    const cached = await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`, { headers: { "If-None-Match": etag } });
    expect(cached.status).toBe(304);
    const conflicting = await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`, { headers: { "X-LTDS-Workspace-ID": "other-workspace" } });
    expect(conflicting.status).toBe(404);
    try {
      currentPrincipal = otherPrincipal;
      const crossed = await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`);
      expect(crossed.status).toBe(403);
    } finally { currentPrincipal = principal; }
  });

  it("fences stale index versions after handle issuance", async () => {
    const fileHandle = await currentFileHandle();
    await db.prepare("UPDATE file_index SET etag='stale-index' WHERE r2_key='clients/ad1/effective/readme.txt'").run();
    expect((await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`)).status).toBe(404);
    await db.prepare("UPDATE file_index SET etag=? WHERE r2_key='clients/ad1/effective/readme.txt'").bind((await bucket.head("clients/ad1/effective/readme.txt"))!.etag).run();
  });

  it("writes the exact current v2 authority audit record and fails closed when audit append cannot commit", async () => {
    const fileHandle = await currentFileHandle();
    env.CLIENT_PORTAL_CONTENT_AUDIT_ENABLED = "true";
    env.CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET = "authenticated-delivery-resources-audit-secret-0001";
    const etag = (await bucket.head("clients/ad1/effective/readme.txt"))!.etag;
    await appendAuthenticatedContentStart(env, {
      authorityMode: "native_delivery", grantSource: "authenticated_delivery", recipientEventId: "ad1-event", batchId: "ad1-batch",
      sourceId: "project-alpha:primary", workspaceId: "ad1-workspace", identityId: "ad1-global", projectPublicId: null,
      folderBindingId: "ad1-binding", grantId: "ad1-grant", grantVersion: 1, bindingSourceVersion: "ad1-v1",
      ownerScopeType: "organization", ownerPublicId: "ad1-org", action: "file.download_requested",
      storageKey: "clients/ad1/effective/readme.txt", contentVersion: etag,
    });
    const first = await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`);
    expect(first.status, await first.clone().text()).toBe(200); await first.text();
    expect(await db.prepare(`SELECT authority_mode,source_id,workspace_id,identity_id,folder_binding_id,grant_id,account_id
      FROM portal_authenticated_content_events`).first()).toEqual({ authority_mode: "native_delivery", source_id: "project-alpha:primary", workspace_id: "ad1-workspace",
      identity_id: "ad1-global", folder_binding_id: "ad1-binding", grant_id: "ad1-grant", account_id: null });
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_content_events WHERE action='file.download_requested'").first("count")).toBe(1);
    await db.prepare(`CREATE TRIGGER reject_ad1_audit BEFORE INSERT ON portal_authenticated_content_events
      WHEN NEW.action='file.preview_requested' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`).run();
    const blocked = await request(`/authenticated-deliveries/preview?file=${encodeURIComponent(fileHandle)}`);
    expect(blocked.status).toBe(503); expect(await blocked.text()).not.toContain("readme body");
  });

  it("fences a separately-issued handle after its notification policy is revised", async () => {
    const fileHandle = await currentPolicyFileHandle();
    expect((await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`)).status).toBe(200);
    await db.prepare(`UPDATE portal_authenticated_delivery_notification_policies
      SET access_notice_enabled=0,change_mode='off',policy_version=policy_version+1,updated_by_staff_id='staff',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE grant_id='ad1-policy-grant' AND identity_id='ad1-global' AND policy_version=1`).run();
    expect((await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`)).status).toBe(404);
  });

  it("fences an already-issued handle when its grant is revoked during R2 head", async () => {
    const fileHandle = await currentFileHandle();
    const original = bucket;
    env.DATA_BUCKET = new Proxy(original, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "head") return async (...args: Parameters<R2Bucket["head"]>) => {
        const result = await target.head(...args);
        if (revokeAtHead) { revokeAtHead = false; await db.prepare("UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id='staff',revoke_reason_code='test' WHERE id='ad1-grant'").run(); }
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }) as R2Bucket;
    try {
      revokeAtHead = true;
      expect((await request(`/authenticated-deliveries/download?file=${encodeURIComponent(fileHandle)}`)).status).toBe(404);
    } finally { env.DATA_BUCKET = original; }
  });

  async function seed() {
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id) VALUES('ad1-account','AD1 account','active','ad1-org','project-alpha:primary')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('ad1-legacy','ad1-account',?,?,?)").bind(principal.issuer, principal.subject, principal.email),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('ad1-account','ad1-legacy','manager')"),
      db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,legacy_account_id,display_name,status,project_alpha_source_id) VALUES('ad1-workspace','organization','ad1-org','ad1-account','AD1 workspace','active','project-alpha:primary')"),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES('ad1-global',?,?,?,'active')").bind(principal.issuer, principal.subject, principal.email),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version) VALUES('ad1-member','ad1-workspace','ad1-global','legacy','active','ad1-v1')"),
      db.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status) VALUES('ad1-workspace','ad1-principal','ad1-global',?,'AD1 principal','ad1-v1','active')").bind(principal.email),
      db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at) VALUES('ad1-generation','ad1-workspace','ad1-generation',1,'active',1,datetime('now'))"),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active) VALUES('ad1-workspace','ad1-generation','organization','ad1-org',NULL,'AD1 organization','ad1-v1',1)"),
      db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES('ad1-generation','ad1-workspace',3)"),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES('ad1-workspace','ad1-generation',1)"),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status) VALUES('ad1-view','ad1-workspace','ad1-global','workspace.view','allow','workspace','ad1-workspace','project_alpha','ad1-v1','active'),('ad1-delivery','ad1-workspace','ad1-global','delivery.view','allow','folder','ad1-binding','project_alpha','ad1-v1','active')"),
      db.prepare("INSERT INTO portal_v2_identity_eligibility_bindings(identity_id,workspace_id,principal_public_id,principal_source_version,verified_email) VALUES('ad1-global','ad1-workspace','ad1-principal','ad1-v1',?)").bind(principal.email),
      db.prepare("INSERT INTO portal_v2_identity_eligibility_legacy_bridges(workspace_id,identity_id,legacy_account_id,legacy_identity_id) VALUES('ad1-workspace','ad1-global','ad1-account','ad1-legacy')"),
      db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status) VALUES('ad1-binding','ad1-workspace','organization','ad1-org','clients/ad1/effective/','project_alpha','ad1-v1','active')"),
      db.prepare("INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id) VALUES('ad1-grant','ad1-logical',1,'ad1-workspace','ad1-binding','ad1-v1','principal','ad1-principal','ad1-v1','test','staff')"),
      db.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES('ad1-grant','ad1-workspace','ad1-principal','ad1-global','ad1-v1')"),
      db.prepare("INSERT INTO portal_authenticated_delivery_notification_policies(grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,access_notice_enabled,change_mode,updated_by_staff_id) VALUES('ad1-grant',1,'ad1-logical','ad1-workspace','project-alpha:primary','ad1-global','ad1-principal','ad1-v1',1,'both','staff')"),
      db.prepare("INSERT INTO portal_authenticated_delivery_change_batches(id,grant_id,grant_version,logical_grant_id,workspace_id,source_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,eligible_at,added_count,removed_count,bell_published_at) VALUES('ad1-batch','ad1-grant',1,'ad1-logical','ad1-workspace','project-alpha:primary','ad1-binding','ad1-v1','organization','ad1-org','clients/ad1/effective/','ad1-global','ad1-principal','ad1-v1',1,datetime('now','-1 second'),2,0,datetime('now'))"),
      db.prepare("INSERT INTO authenticated_delivery_recipient_events(id,batch_id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count) SELECT 'ad1-event',id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count FROM portal_authenticated_delivery_change_batches WHERE id='ad1-batch'"),
      db.prepare("INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id) VALUES('ad1-policy-grant','ad1-policy-logical',1,'ad1-workspace','ad1-binding','ad1-v1','principal','ad1-principal','ad1-v1','test','staff')"),
      db.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES('ad1-policy-grant','ad1-workspace','ad1-principal','ad1-global','ad1-v1')"),
      db.prepare("INSERT INTO portal_authenticated_delivery_notification_policies(grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,access_notice_enabled,change_mode,updated_by_staff_id) VALUES('ad1-policy-grant',1,'ad1-policy-logical','ad1-workspace','project-alpha:primary','ad1-global','ad1-principal','ad1-v1',1,'both','staff')"),
      db.prepare("INSERT INTO portal_authenticated_delivery_change_batches(id,grant_id,grant_version,logical_grant_id,workspace_id,source_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,eligible_at,added_count,removed_count,bell_published_at) VALUES('ad1-policy-batch','ad1-policy-grant',1,'ad1-policy-logical','ad1-workspace','project-alpha:primary','ad1-binding','ad1-v1','organization','ad1-org','clients/ad1/effective/','ad1-global','ad1-principal','ad1-v1',1,datetime('now','-1 second'),2,0,datetime('now'))"),
      db.prepare("INSERT INTO authenticated_delivery_recipient_events(id,batch_id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count) SELECT 'ad1-policy-event',id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count FROM portal_authenticated_delivery_change_batches WHERE id='ad1-policy-batch'"),
      db.prepare("INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,deleted_by,purge_after) VALUES('ad1-tombstone','clients/ad1/effective/removed.txt','exact','staff','2099-01-01T00:00:00.000Z')"),
    ]);
    const entries = [["clients/ad1/effective/readme.txt", "readme body", "text/plain"], ["clients/ad1/effective/evidence/readme.txt", "evidence", "text/plain"], ["clients/ad1/effective/📷/photo.jpg", "photo", "image/jpeg"], ["clients/ad1/effective-other/adjacent.txt", "adjacent", "text/plain"], ["clients/ad1/effective/_ltds/hidden.txt", "hidden", "text/plain"], ["clients/ad1/effective/removed.txt", "removed", "text/plain"]] as const;
    for (const [key, body, contentType] of entries) {
      const object = await bucket.put(key, body, { httpMetadata: { contentType } });
      await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,?)")
        .bind(key, object!.etag, body.length, "2026-09-01T12:00:00.000Z", contentType, contentType === "image/jpeg" ? "image" : "text").run();
    }
    const history = await createClientPortalRouter({ resolvePrincipal: async () => principal })
      .request(`${origin}/notification-history`, { headers: { "X-LTDS-Workspace-ID": "ad1-workspace" } }, env);
    expect(history.status, await history.clone().text()).toBe(200);
    const historyBody = await history.json() as { items: Array<{ id: string; actionPath: string | null }> };
    const item = historyBody.items.find(value => value.id === "ad1-event");
    rootHandle = new URL(item!.actionPath!, origin).searchParams.get("folder")!;
    const policyItem = historyBody.items.find(value => value.id === "ad1-policy-event");
    policyRootHandle = new URL(policyItem!.actionPath!, origin).searchParams.get("folder")!;
  }
});
