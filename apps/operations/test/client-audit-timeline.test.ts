import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const projectPolicy = vi.hoisted(() => ({ changed: false, deliveryAudit: true }));
vi.mock("../src/worker/acl", () => ({
  sqlScope: vi.fn(async () => ({ global: projectPolicy.deliveryAudit, deniedGlobal: !projectPolicy.deliveryAudit,
    divisions: [], deniedDivisions: [] })),
}));
vi.mock("../src/worker/client-hub-project-policy", () => ({
  readClientHubBusinessProjectPolicy: vi.fn(async () => ({ allowed: true,
    proof: (projectPolicy.changed ? "q" : "p").repeat(43), filter: { sql: "1=1", values: [] } })),
}));
vi.mock("../src/worker/client-hub-business-projects", () => ({
  clientHubBusinessProjectSourceProof: vi.fn(async () => "s".repeat(43)),
}));
vi.mock("../src/worker/client-hub-business-project-detail", () => ({
  readClientHubBusinessProjectDetail: vi.fn(async (_env: unknown, _actor: unknown,
    context: ClientHubCollectionContext, projectId: string) => ({ canonicalRoot: context.canonicalRoot,
    contextVersion: context.contextVersion, project: { id: projectId, name: "Project", status: "active" } })),
}));
import { listClientAuditTimeline } from "../src/worker/client-audit-timeline";

const staff: StaffPrincipal = { id: "timeline-staff", email: "staff@example.test", displayName: "Timeline Staff",
  accessSubject: "timeline-subject", projectAlphaUserId: null };
const otherStaff: StaffPrincipal = { ...staff, id: "different-staff", accessSubject: "different-subject" };
const accountId = "local-account";
function context(): ClientHubCollectionContext {
  return { root: { source_id: "delivery:local", root_namespace: "account", kind: "standalone_client",
    public_id: accountId, pa_public_id: null, mapping_status: "not_applicable", display_name: "Local client",
    sort_name: "local client", status: "active", portal_status: "not_provisioned", workspace_id: null,
    legacy_account_id: accountId, account_count: 1, project_count: 1, request_count: 2, contact_count: 0,
    meaningful_activity_at: null, source_version: null, indexed_at: "", scan_generation: 1 },
  access: { directory: true, requests: true, delivery: true, viewer: false }, contextVersion: "c".repeat(43),
  canonicalRoot: { sourceId: "delivery:local", rootNamespace: "account", kind: "standalone_client", publicId: accountId } };
}

describe("staff Client Hub audit timeline", { timeout: 60_000 }, () => {
  let runtime: Miniflare, delivery: D1Database, ops: D1Database, env: Env;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB", "DELIVERY_DB"] });
    delivery = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    ops = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await delivery.exec(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT NOT NULL,project_alpha_source_id TEXT,
        project_alpha_client_id TEXT,project_alpha_organization_id TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,active INTEGER NOT NULL,project_alpha_source_id TEXT,
        project_alpha_project_id TEXT,project_name TEXT);
      CREATE TABLE client_project_grants(account_id TEXT NOT NULL,project_id TEXT NOT NULL,granted_at TEXT NOT NULL,
        revoked_at TEXT,PRIMARY KEY(account_id,project_id));
      CREATE TABLE client_service_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,project_id TEXT,title TEXT NOT NULL);
      CREATE TABLE request_revisions(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,author_type TEXT NOT NULL,
        action TEXT NOT NULL,snapshot_json TEXT NOT NULL,note TEXT,created_at TEXT NOT NULL);
      CREATE TABLE shares(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,label TEXT);
      CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,action TEXT NOT NULL,
        entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,details_json TEXT,created_at TEXT NOT NULL);
      CREATE TABLE portal_v2_membership_audit(id TEXT PRIMARY KEY,workspace_id TEXT,actor_identity_id TEXT,
        action TEXT,created_at TEXT);
      CREATE TABLE portal_v2_authenticated_delivery_grant_audit(id TEXT PRIMARY KEY,grant_id TEXT,workspace_id TEXT,
        action TEXT,created_at TEXT);
      CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT);
      CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,owner_scope_type TEXT,owner_public_id TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await delivery.batch([
      delivery.prepare("INSERT INTO client_accounts VALUES(?, 'active',NULL,NULL,NULL)").bind(accountId),
      delivery.prepare("INSERT INTO projects VALUES('project-local',1,NULL,NULL,'Private project label')"),
      delivery.prepare("INSERT INTO client_project_grants VALUES(?,'project-local','2026-08-01T00:00:00.000Z',NULL)").bind(accountId),
      delivery.prepare("INSERT INTO client_service_requests VALUES('request-one',?,'project-local','Roof inspection')").bind(accountId),
      delivery.prepare(`INSERT INTO request_revisions VALUES('revision-one','request-one','client','submitted',?,?,'2026-08-20T10:00:00.000Z')`)
        .bind(JSON.stringify({ private: "snapshot must not leave D1" }), "private request note"),
      delivery.prepare(`INSERT INTO request_revisions VALUES('revision-two','request-one','staff','status_changed',?,NULL,'2026-08-21T10:00:00.000Z')`)
        .bind(JSON.stringify({ private: "new snapshot must not leave D1" })),
      delivery.prepare("INSERT INTO shares VALUES('share-one','project-local','Client link')"),
      delivery.prepare(`INSERT INTO audit_log(actor_type,action,entity_type,entity_id,details_json,created_at)
        VALUES('staff','share.created','share','share-one',?,'2026-08-22T10:00:00.000Z')`)
        .bind(JSON.stringify({ r2Prefix: "private/path", recipientEmail: "private@example.test" })),
      delivery.prepare(`INSERT INTO audit_log(actor_type,action,entity_type,entity_id,details_json,created_at)
        VALUES('system','notification.failed','share','share-one',?,'2026-08-23T10:00:00.000Z')`)
        .bind(JSON.stringify({ error: "private provider response" })),
    ]);
    env = { OPS_DB: ops, DELIVERY_DB: delivery, OPERATIONS_SESSION_SECRET: "timeline-test-secret-that-is-long-enough-12345" } as Env;
  });
  afterAll(async () => runtime?.dispose());

  it("merges bounded primary/local ledgers without releasing payloads, notes, addresses, or paths", async () => {
    const first = await listClientAuditTimeline(env, staff, context(), { limit: 2 });
    expect(first).toMatchObject({ canonicalRoot: context().canonicalRoot, projectId: null,
      coverage: { project: { available: false, reason: "not_applicable" }, request: { available: true },
        feedback: { available: false, reason: "not_collected" }, delivery: { available: true }, notification: { available: true } },
      page: { returned: 2, limit: 2, hasMore: true } });
    expect(first.items.map(event => [event.category, event.action])).toEqual([
      ["notification", "notification.failed"], ["delivery", "share.created"],
    ]);
    expect(JSON.stringify(first)).not.toMatch(/snapshot must|private request|private\/path|private@example|provider response|details_json|r2Prefix/i);
    const second = await listClientAuditTimeline(env, staff, context(), { limit: 2, cursor: first.page.nextCursor! });
    expect(second.asOf).toBe(first.asOf);
    expect(second.items.map(event => event.action)).toEqual(["status_changed", "submitted"]);
    expect(second.page).toMatchObject({ returned: 2, hasMore: false, nextCursor: null });
  });

  it("binds continuations to actor, filters and the current account scope", async () => {
    const first = await listClientAuditTimeline(env, staff, context(), { limit: 1 });
    await expect(listClientAuditTimeline(env, otherStaff, context(), { limit: 1, cursor: first.page.nextCursor! }))
      .rejects.toMatchObject({ status: 400 });
    await expect(listClientAuditTimeline(env, staff, context(), { limit: 1, cursor: first.page.nextCursor!,
      filters: { category: "request", actorType: "all", result: "all", from: null, to: null } }))
      .rejects.toMatchObject({ status: 400 });
    await delivery.prepare("UPDATE client_accounts SET status='closed' WHERE id=?").bind(accountId).run();
    await expect(listClientAuditTimeline(env, staff, context(), { limit: 1, cursor: first.page.nextCursor! }))
      .rejects.toMatchObject({ status: 409 });
    await delivery.prepare("UPDATE client_accounts SET status='active' WHERE id=?").bind(accountId).run();
  });

  it("applies category, actor, result and time filters before pagination", async () => {
    const result = await listClientAuditTimeline(env, staff, context(), { limit: 10,
      filters: { category: "notification", actorType: "system", result: "failed",
        from: "2026-08-23T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z" } });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ category: "notification", action: "notification.failed",
      actor: { type: "system", label: "System" }, result: "failed" });
  });

  it("does not treat delivery share creation permission as audit permission", async () => {
    projectPolicy.deliveryAudit = false;
    try {
      const result = await listClientAuditTimeline(env, staff, context(), { limit: 10,
        filters: { category: "delivery", actorType: "all", result: "all", from: null, to: null } });
      expect(result.coverage.delivery).toEqual({ available: false, reason: "permission_required" });
      expect(result.items).toEqual([]);
    } finally { projectPolicy.deliveryAudit = true; }
  });

  it("filters mixed workspace membership actors before applying the adapter limit", async () => {
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_membership_audit VALUES('membership-system-1','workspace-one',NULL,'membership.updated','2026-08-25T12:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_membership_audit VALUES('membership-system-2','workspace-one',NULL,'membership.updated','2026-08-25T11:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_membership_audit VALUES('membership-client','workspace-one','identity-private','membership.updated','2026-08-24T10:00:00.000Z')"),
    ]);
    const workspaceContext = context();
    workspaceContext.root.workspace_id = "workspace-one";
    const result = await listClientAuditTimeline(env, staff, workspaceContext, { limit: 1,
      filters: { category: "access", actorType: "client", result: "succeeded", from: null, to: null } });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ producerEventId: "membership:membership-client",
      actor: { type: "client", label: "Client" } });
  });

  it("filters delivery actor and result before applying the adapter limit", async () => {
    await delivery.batch([
      delivery.prepare(`INSERT INTO audit_log(actor_type,action,entity_type,entity_id,details_json,created_at)
        VALUES('system','share.updated','share','share-one',NULL,'2026-08-25T12:00:00.000Z')`),
      delivery.prepare(`INSERT INTO audit_log(actor_type,action,entity_type,entity_id,details_json,created_at)
        VALUES('system','share.updated','share','share-one',NULL,'2026-08-25T11:00:00.000Z')`),
      delivery.prepare(`INSERT INTO audit_log(actor_type,action,entity_type,entity_id,details_json,created_at)
        VALUES('system','notification.sent','share','share-one',NULL,'2026-08-25T10:00:00.000Z')`),
      delivery.prepare(`INSERT INTO audit_log(actor_type,action,entity_type,entity_id,details_json,created_at)
        VALUES('system','notification.sent','share','share-one',NULL,'2026-08-25T09:00:00.000Z')`),
    ]);
    const staffDelivery = await listClientAuditTimeline(env, staff, context(), { limit: 1,
      filters: { category: "delivery", actorType: "staff", result: "succeeded", from: null, to: null } });
    expect(staffDelivery.items).toHaveLength(1);
    expect(staffDelivery.items[0]).toMatchObject({ action: "share.created", actor: { type: "staff" } });
    const failedNotification = await listClientAuditTimeline(env, staff, context(), { limit: 1,
      filters: { category: "notification", actorType: "system", result: "failed", from: null, to: null } });
    expect(failedNotification.items).toHaveLength(1);
    expect(failedNotification.items[0]).toMatchObject({ action: "notification.failed", result: "failed" });
  });
});
