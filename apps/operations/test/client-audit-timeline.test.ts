import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const projectPolicy = vi.hoisted(() => ({ changed: false, deliveryAudit: true, viewerManage: true,
  portal: true, portalReads: 0, losePortalAfterFirst: false }));
vi.mock("../src/worker/acl", () => ({
  sqlScope: vi.fn(async (_env: unknown, _actor: unknown, permission: string) => {
    let allowed = permission === "viewer.manage" ? projectPolicy.viewerManage : permission === "operations.manage"
      ? projectPolicy.portal : projectPolicy.deliveryAudit;
    if (permission === "operations.manage" && projectPolicy.losePortalAfterFirst && projectPolicy.portalReads++ > 0) allowed = false;
    return { global: allowed, deniedGlobal: !allowed, divisions: [], deniedDivisions: [] };
  }),
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
function primaryContext(): ClientHubCollectionContext {
  const value = context();
  value.root = { ...value.root, source_id: "project-alpha:primary", root_namespace: "business", kind: "organization",
    public_id: "organization-one", workspace_id: "workspace-one", legacy_account_id: null };
  value.canonicalRoot = { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization",
    publicId: "organization-one" };
  value.access = { directory: true, requests: true, delivery: true, viewer: true };
  return value;
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
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT);
      CREATE TABLE portal_v2_authenticated_delivery_grant_audit(id TEXT PRIMARY KEY,grant_id TEXT,workspace_id TEXT,
        action TEXT,created_at TEXT);
      CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT);
      CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,owner_scope_type TEXT,owner_public_id TEXT);
      CREATE TABLE portal_workspace_invitation_requests(id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,
        scope_type TEXT,scope_public_id TEXT);
      CREATE TABLE portal_workspace_invitation_request_audit(id TEXT PRIMARY KEY,workspace_id TEXT,request_id TEXT,
        actor_type TEXT,action TEXT,created_at TEXT);
      CREATE TABLE portal_workspace_peer_admin_audit(id TEXT PRIMARY KEY,workspace_id TEXT,action TEXT,created_at TEXT);
      CREATE TABLE portal_v2_identity_denials(id TEXT PRIMARY KEY,identity_id TEXT,workspace_id TEXT,scope_type TEXT,scope_public_id TEXT);
      CREATE TABLE portal_v2_identity_denial_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,denial_id TEXT,identity_id TEXT,
        workspace_id TEXT,action TEXT,actor_type TEXT,created_at TEXT);
      CREATE TABLE client_share_folder_targets(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT);
      CREATE TABLE client_share_delegations(id TEXT PRIMARY KEY,workspace_id TEXT,root_target_id TEXT);
      CREATE TABLE client_delegated_shares(id TEXT PRIMARY KEY,workspace_id TEXT,delegation_id TEXT,folder_target_id TEXT);
      CREATE TABLE client_delegated_share_events(id TEXT PRIMARY KEY,workspace_id TEXT,delegation_id TEXT,share_id TEXT,
        actor_type TEXT,event_type TEXT,details_json TEXT,created_at TEXT);
      CREATE TABLE viewer_client_grants(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT);
      CREATE TABLE viewer_client_grant_audit(id TEXT PRIMARY KEY,grant_id TEXT,action TEXT,actor_staff_id TEXT,
        idempotency_key TEXT,details_json TEXT,created_at TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await ops.exec(`CREATE TABLE client_business_activity_state(singleton INTEGER PRIMARY KEY,revision INTEGER);
      INSERT INTO client_business_activity_state VALUES(1,1);
      CREATE TABLE client_business_activity(sequence INTEGER PRIMARY KEY);`);
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary')"),
      delivery.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-other','project-alpha:secondary')"),
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
      delivery.prepare("INSERT INTO portal_v2_membership_audit VALUES('membership-system-1','workspace-one',NULL,'membership.suspended','2026-08-25T12:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_membership_audit VALUES('membership-system-2','workspace-one',NULL,'membership.reactivated','2026-08-25T11:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_membership_audit VALUES('membership-client','workspace-one','identity-private','membership.suspended','2026-08-24T10:00:00.000Z')"),
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

  it("invalidates a bounded read when the exact portal permission changes", async () => {
    projectPolicy.portalReads = 0; projectPolicy.losePortalAfterFirst = true;
    try {
      await expect(listClientAuditTimeline(env, staff, context(), { limit: 10 })).rejects.toMatchObject({ status: 409 });
    } finally { projectPolicy.losePortalAfterFirst = false; projectPolicy.portalReads = 0; }
  });

  it("federates every exact access ledger while redacting identities, details, reasons, paths, tokens, and proofs", async () => {
    await delivery.batch([
      delivery.prepare("INSERT INTO client_accounts VALUES('account-alpha','active','project-alpha:primary',NULL,'organization-one')"),
      delivery.prepare("INSERT INTO projects VALUES('project-alpha-local',1,'project-alpha:primary','project-one','Project one private')"),
      delivery.prepare("INSERT INTO projects VALUES('project-alpha-sibling',1,'project-alpha:primary','project-two','Project two private')"),
      delivery.prepare("INSERT INTO client_project_grants VALUES('account-alpha','project-alpha-local','2026-08-01T00:00:00.000Z',NULL)"),
      delivery.prepare("INSERT INTO client_project_grants VALUES('account-alpha','project-alpha-sibling','2026-08-01T00:00:00.000Z',NULL)"),
      delivery.prepare("INSERT INTO portal_v2_membership_audit VALUES('membership-one','workspace-one','identity-secret','membership.suspended','2026-08-26T10:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_workspace_invitation_requests VALUES('request-access-one','workspace-one','project-alpha:primary','project','project-one')"),
      delivery.prepare("INSERT INTO portal_workspace_invitation_request_audit VALUES('invitation-audit-one','workspace-one','request-access-one','staff','request.approved','2026-08-26T11:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_workspace_peer_admin_audit VALUES('peer-admin-one','workspace-one','manager.promoted','2026-08-26T12:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_identity_denials VALUES('denial-one','identity-denied-secret','workspace-one','project','project-one')"),
      delivery.prepare("INSERT INTO portal_v2_identity_denial_audit(denial_id,identity_id,workspace_id,action,actor_type,created_at) VALUES('denial-one','identity-denied-secret','workspace-one','denial.created','staff','2026-08-26T13:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_folder_bindings VALUES('binding-one','workspace-one','project','project-one')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grants VALUES('authenticated-one','workspace-one','binding-one')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES('authenticated-audit-one','authenticated-one','workspace-one','grant.created','2026-08-26T14:00:00.000Z')"),
      delivery.prepare("INSERT INTO client_share_folder_targets VALUES('target-one','workspace-one','binding-one')"),
      delivery.prepare("INSERT INTO client_share_delegations VALUES('delegation-one','workspace-one','target-one')"),
      delivery.prepare("INSERT INTO client_delegated_shares VALUES('delegated-share-one','workspace-one','delegation-one','target-one')"),
      delivery.prepare("INSERT INTO client_delegated_share_events VALUES('delegated-event-one','workspace-one','delegation-one','delegated-share-one','client','client_share.created',?,'2026-08-26T15:00:00.000Z')")
        .bind(JSON.stringify({ path: "private/folder", token: "delegated-secret", recipientEmail: "hidden@example.test" })),
      delivery.prepare("INSERT INTO client_delegated_share_events VALUES('delegated-noise','workspace-one','delegation-one','delegated-share-one','public','client_share.preview.viewed',?,'2026-08-26T15:30:00.000Z')")
        .bind(JSON.stringify({ itemRef: "private-item-reference" })),
      delivery.prepare("INSERT INTO viewer_client_grants VALUES('viewer-grant-one','account-alpha','project-alpha-local')"),
      delivery.prepare("INSERT INTO viewer_client_grant_audit VALUES('viewer-audit-one','viewer-grant-one','grant.created','staff-secret','viewer-idempotency-secret',?,'2026-08-26T16:00:00.000Z')")
        .bind(JSON.stringify({ reason: "private reason", proof: "private proof" })),
    ]);
    const result = await listClientAuditTimeline(env, staff, primaryContext(), { limit: 100,
      filters: { category: "access", actorType: "all", result: "all", from: null, to: null } });
    expect(new Set(result.items.map(event => event.resource.type))).toEqual(new Set([
      "workspace_membership", "workspace_invitation_request", "workspace_peer_administrator", "portal_identity_denial",
      "authenticated_delivery_grant", "delegated_client_share", "viewer_client_grant",
    ]));
    expect(result.items.some(event => event.producerEventId === "delegated-share:delegated-noise")).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/identity-secret|identity-denied-secret|staff-secret|idempotency-secret|private\/folder|delegated-secret|hidden@example|private-item|private reason|private proof|details_json|actor_id/i);
  });

  it("uses exact project mappings and keeps high-water pagination stable", async () => {
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_workspace_invitation_requests VALUES('request-cross-workspace','workspace-other','project-alpha:primary','project','project-one')"),
      delivery.prepare("INSERT INTO portal_workspace_invitation_request_audit VALUES('invitation-cross-workspace','workspace-one','request-cross-workspace','staff','request.approved','2026-08-26T11:45:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_identity_denials VALUES('denial-cross-workspace','identity-cross','workspace-other','project','project-one')"),
      delivery.prepare("INSERT INTO portal_v2_identity_denial_audit(denial_id,identity_id,workspace_id,action,actor_type,created_at) VALUES('denial-cross-workspace','identity-cross','workspace-one','denial.created','staff','2026-08-26T13:45:00.000Z')"),
      delivery.prepare("INSERT INTO portal_workspace_invitation_requests VALUES('request-access-two','workspace-one','project-alpha:primary','project','project-two')"),
      delivery.prepare("INSERT INTO portal_workspace_invitation_request_audit VALUES('invitation-audit-two','workspace-one','request-access-two','staff','request.approved','2026-08-26T11:30:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_identity_denials VALUES('denial-two','identity-sibling','workspace-one','project','project-two')"),
      delivery.prepare("INSERT INTO portal_v2_identity_denial_audit(denial_id,identity_id,workspace_id,action,actor_type,created_at) VALUES('denial-two','identity-sibling','workspace-one','denial.created','staff','2026-08-26T13:30:00.000Z')"),
      delivery.prepare("INSERT INTO portal_v2_folder_bindings VALUES('binding-two','workspace-one','project','project-two')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grants VALUES('authenticated-two','workspace-one','binding-two')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES('authenticated-audit-two','authenticated-two','workspace-one','grant.created','2026-08-26T14:30:00.000Z')"),
      delivery.prepare("INSERT INTO client_share_folder_targets VALUES('target-two','workspace-one','binding-two')"),
      delivery.prepare("INSERT INTO client_share_delegations VALUES('delegation-two','workspace-one','target-two')"),
      delivery.prepare("INSERT INTO client_delegated_share_events VALUES('delegated-event-two','workspace-one','delegation-two',NULL,'staff','delegation.created','{}','2026-08-26T15:30:00.000Z')"),
      delivery.prepare("INSERT INTO viewer_client_grants VALUES('viewer-grant-two','account-alpha','project-alpha-sibling')"),
      delivery.prepare("INSERT INTO viewer_client_grant_audit VALUES('viewer-audit-two','viewer-grant-two','grant.created','staff-secret-two','viewer-key-two','{}','2026-08-26T16:30:00.000Z')"),
    ]);
    const options = { projectId: "project-one", limit: 2,
      filters: { category: "access", actorType: "all", result: "all", from: null, to: null } as const };
    const first = await listClientAuditTimeline(env, staff, primaryContext(), options);
    expect(first.accessCoverage.workspace_membership).toEqual({ available: false, reason: "not_applicable" });
    expect(first.accessCoverage.workspace_peer_administrator).toEqual({ available: false, reason: "not_applicable" });
    expect(first.accessCoverage.workspace_invitation_request).toEqual({ available: true, reason: null });
    expect(first.page.hasMore).toBe(true);
    await delivery.prepare("INSERT INTO viewer_client_grant_audit VALUES('viewer-after-watermark','viewer-grant-one','grant.revoked','late-staff','late-key','{}','2026-08-27T20:00:00.000Z')").run();
    const collected = [...first.items]; let cursor = first.page.nextCursor;
    while (cursor) {
      const page = await listClientAuditTimeline(env, staff, primaryContext(), { ...options, cursor });
      collected.push(...page.items); cursor = page.page.nextCursor;
    }
    expect(new Set(collected.map(event => event.producerEventId))).toEqual(new Set([
      "invitation-request:invitation-audit-one", "identity-denial:1", "authenticated-grant:authenticated-audit-one",
      "delegated-share:delegated-event-one", "viewer-grant:viewer-audit-one",
    ]));
    expect(collected.some(event => /two|after-watermark/.test(event.producerEventId))).toBe(false);
    expect(collected.some(event => /cross-workspace/.test(event.producerEventId))).toBe(false);
    const clientScope = await listClientAuditTimeline(env, staff, primaryContext(), { limit: 100,
      filters: { category: "access", actorType: "all", result: "all", from: null, to: null } });
    expect(clientScope.items.some(event => /cross-workspace/.test(event.producerEventId))).toBe(false);
  });

  it("rejects stale project bindings when the authoritative workspace source no longer matches", async () => {
    await delivery.prepare("UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:secondary' WHERE id='workspace-one'").run();
    try {
      const result = await listClientAuditTimeline(env, staff, primaryContext(), { projectId: "project-one", limit: 100,
        filters: { category: "access", actorType: "all", result: "all", from: null, to: null } });
      expect(result.items.some(event => event.resource.type === "authenticated_delivery_grant")).toBe(false);
      expect(result.items.some(event => event.resource.type === "delegated_client_share")).toBe(false);
    } finally {
      await delivery.prepare("UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:primary' WHERE id='workspace-one'").run();
    }
  });

  it("discloses partial access adapter coverage without hiding unavailable ledgers", async () => {
    projectPolicy.deliveryAudit = false; projectPolicy.viewerManage = false;
    try {
      const result = await listClientAuditTimeline(env, staff, primaryContext(), { limit: 10,
        filters: { category: "access", actorType: "all", result: "all", from: null, to: null } });
      expect(result.accessCoverage.workspace_invitation_request).toEqual({ available: true, reason: null });
      expect(result.accessCoverage.authenticated_delivery_grant).toEqual({ available: false, reason: "permission_required" });
      expect(result.accessCoverage.viewer_client_grant).toEqual({ available: false, reason: "permission_required" });
      expect(result.accessCoverage.project_access).toEqual({ available: false, reason: "not_collected" });
    } finally { projectPolicy.deliveryAudit = true; projectPolicy.viewerManage = true; }
  });
});
