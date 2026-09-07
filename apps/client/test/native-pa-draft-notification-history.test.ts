import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const origin = "https://client.example.test";
const owner: VerifiedClientPrincipal = { issuer: "https://issuer.test", subject: "native-owner", email: "owner@example.test" };
const other: VerifiedClientPrincipal = { issuer: "https://issuer.test", subject: "native-other", email: "other@example.test" };
const secondOwner: VerifiedClientPrincipal = { issuer: "https://issuer.test", subject: "native-owner-two", email: "owner-two@example.test" };

describe("native PA draft notification history — migrated D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let serial = 0;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "native-pa-draft-history" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const bindings = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: origin,
      CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
      DELIVERY_SESSION_SECRET: "native-pa-draft-history-session-secret-0001",
      ENVIRONMENT: "development",
    } satisfies Partial<Env>;
    // This read-only router test provides only bindings reached by its D1 paths.
    env = bindings as Env;
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  async function seed(label: string, principal: VerifiedClientPrincipal) {
    serial += 1;
    const suffix = `${label}-${serial}`, source = `project-alpha:history_${serial}`, account = `account-${suffix}`,
      storage = `storage-${suffix}`, workspace = `workspace-${suffix}`, identity = `identity-${suffix}`,
      request = `request-${suffix}`, root = `org-${suffix}`, notification = `notice-${suffix}`;
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES(?,?,'active',?,?)`).bind(account, `Account ${suffix}`, root, source),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES(?,?,?,?,?)")
        .bind(storage, account, principal.issuer, principal.subject, principal.email),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?, 'manager')").bind(account, storage),
      db.prepare(`INSERT INTO pa_portal_source_authorities
        (source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,active_revision,version,connector_revision,connector_version)
        VALUES(?,?,'https://native.example.test','/api/portal','native_history','pending',1,1,1,1)`).bind(source, `binding-${suffix}`),
      db.prepare(`INSERT INTO pa_portal_source_authority_revisions
        (source_id,revision,credential_ref,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES(?,1,'history-credential','https://native.example.test','operations','history-subject','history-key',?,'test')`).bind(source, "a".repeat(64)),
      db.prepare("UPDATE pa_portal_source_authorities SET state='active',version=2 WHERE source_id=?").bind(source),
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .bind(workspace, source, `source-workspace-${suffix}`),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'Native workspace','active',?)`).bind(workspace, root, source),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?, 'active')")
        .bind(identity, principal.issuer, principal.subject, principal.email),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
        VALUES(?,?,?,'project_alpha','active','member-v1')`).bind(`membership-${suffix}`, workspace, identity),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,?,?,?,'Native owner','member-v1','active')`).bind(workspace, `principal-${suffix}`, identity, principal.email),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES(?,?,?,1,'active',1,datetime('now'))`).bind(`generation-${suffix}`, workspace, `generation-${suffix}`),
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES(?,?,'organization',?,'Native organization','v1',1)`).bind(workspace, `generation-${suffix}`, root),
      db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)")
        .bind(`generation-${suffix}`, workspace),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .bind(workspace, `generation-${suffix}`),
      ...[["workspace.view", "workspace", workspace], ["request.create", "organization", root]].map(([capability, scopeType, scopePublicId]) => db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES(?,?,?,?,'allow',?,?,'project_alpha','active')`)
        .bind(`${capability}-${suffix}`, workspace, identity, capability, scopeType, scopePublicId)),
      db.prepare(`INSERT INTO portal_native_request_storage_bindings(workspace_id,source_id,account_id,storage_identity_id,state)
        VALUES(?,?,?,?, 'active')`).bind(workspace, source, account, storage),
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,created_by_identity_id,request_type,title,details,status,idempotency_key,request_fingerprint,catalog_source_id,portal_workspace_id,portal_identity_id,portal_project_public_id)
        VALUES(?,?,?,'service','Native PA draft','Native history request','accepted_pending_pa_linkage',?,?,?, ?,?,NULL)`)
        .bind(request, account, storage, `request-key-${suffix}`, "b".repeat(43), source, workspace, identity),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES(?,?,?,'pa_draft_quote_created','service_request',?,?,'A draft quote is ready','Review the non-financial draft status.','/portal/requests')`)
        .bind(notification, account, storage, request, `service-request:${notification}`),
    ]);
    return { identity, workspace, request, notification, source, requestEntitlement: `request.create-${suffix}` };
  }

  const history = (principal: VerifiedClientPrincipal, workspace: string) => new Hono().route("/api/client", createClientPortalRouter({
    resolvePrincipal: async () => principal,
    repository: d1ClientPortalRepository,
  })).request(`${origin}/api/client/notification-history`, { headers: { "X-LTDS-Workspace-Id": workspace } }, env);
  const mutate = (principal: VerifiedClientPrincipal, workspace: string, notification: string, action: "read" | "dismiss", bindings = env) => new Hono().route("/api/client", createClientPortalRouter({
    resolvePrincipal: async () => principal,
    repository: d1ClientPortalRepository,
  })).request(`${origin}/api/client/notifications/${notification}`, {
    method: "PATCH",
    headers: { Origin: origin, "Content-Type": "application/json", "X-LTDS-Workspace-Id": workspace },
    body: JSON.stringify({ action }),
  }, bindings);

  it("shows the PA draft notice only to its current native owner and removes it as authority changes", async () => {
    const mine = await seed("owner", owner);
    const theirs = await seed("other", other);
    const dismissible = await seed("owner-dismiss", secondOwner);

    const visible = await history(owner, mine.workspace);
    expect(visible.status).toBe(200);
    const visiblePage = await visible.json() as { coverage: { requests: string }; items: Array<{ id: string; kind: string }> };
    expect(visiblePage.coverage.requests).toBe("included");
    expect(visiblePage.items).toEqual([expect.objectContaining({ id: mine.notification, kind: "request" })]);

    expect((await history(owner, theirs.workspace)).status).toBe(403);
    expect((await history(other, mine.workspace)).status).toBe(403);
    const isolated = await history(other, theirs.workspace);
    expect(isolated.status).toBe(200);
    expect((await isolated.json() as { items: Array<{ id: string }> }).items.map(item => item.id)).toEqual([theirs.notification]);

    expect((await mutate(secondOwner, dismissible.workspace, dismissible.notification, "read")).status).toBe(200);
    const readHistory = await history(secondOwner, dismissible.workspace);
    expect(readHistory.status).toBe(200);
    expect((await readHistory.json() as { items: Array<{ id: string; readAt: string | null }> }).items)
      .toEqual([expect.objectContaining({ id: dismissible.notification, readAt: expect.any(String) })]);
    expect((await mutate(other, theirs.workspace, dismissible.notification, "dismiss")).status).toBe(404);
    expect(await db.prepare("SELECT dismissed_at FROM client_portal_notifications WHERE id=?").bind(dismissible.notification).first("dismissed_at")).toBeNull();
    expect((await mutate(secondOwner, dismissible.workspace, dismissible.notification, "dismiss")).status).toBe(200);
    expect(await db.prepare("SELECT dismissed_at FROM client_portal_notifications WHERE id=?").bind(dismissible.notification).first("dismissed_at")).toEqual(expect.any(String));
    const dismissedHistory = await history(secondOwner, dismissible.workspace);
    expect(dismissedHistory.status).toBe(200);
    expect(await dismissedHistory.json() as { items: Array<{ id: string }> }).toMatchObject({ items: [] });

    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id=?")
      .bind(mine.requestEntitlement).run();
    const entitlementRevoked = await history(owner, mine.workspace);
    expect(entitlementRevoked.status).toBe(200);
    expect((await entitlementRevoked.json() as { items: Array<{ id: string }> }).items.map(item => item.id)).not.toContain(mine.notification);

    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=?")
      .bind(mine.workspace, mine.identity).run();
    expect((await history(owner, mine.workspace)).status).toBe(403);
    expect((await history(other, theirs.workspace)).status).toBe(200);
  });

  it("pauses a mounted native inbox mutation without weakening foreign-workspace denial", async () => {
    const maintenanceOwner = { ...owner, subject: "native-maintenance-owner", email: "maintenance-owner@example.test" };
    const mine = await seed("maintenance", maintenanceOwner);
    const maintenanceEnv = { ...env, CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE: "true" };
    const paused = await mutate(maintenanceOwner, mine.workspace, mine.notification, "read", maintenanceEnv);
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("900");
    expect(await db.prepare("SELECT read_at FROM client_portal_notifications WHERE id=?").bind(mine.notification).first("read_at")).toBeNull();
    expect((await mutate(other, mine.workspace, mine.notification, "read", maintenanceEnv)).status).toBe(403);
  });
});
