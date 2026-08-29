import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const projectPolicy = vi.hoisted(() => ({ changed: false, deliveryAudit: true, viewerManage: true,
  portal: true, projects: true, portalReads: 0, losePortalAfterFirst: false }));
const feedbackScopeRace=vi.hoisted(()=>({calls:0,failAfter:null as number|null}));
vi.mock("../src/worker/acl", () => ({
  sqlScope: vi.fn(async (_env: unknown, _actor: unknown, permission: string) => {
    let allowed = permission === "viewer.manage" ? projectPolicy.viewerManage : permission === "operations.manage"
      ? projectPolicy.portal : projectPolicy.deliveryAudit;
    if (permission === "operations.manage" && projectPolicy.losePortalAfterFirst && projectPolicy.portalReads++ > 0) allowed = false;
    return { global: allowed, deniedGlobal: !allowed, divisions: [], deniedDivisions: [] };
  }),
}));
vi.mock("../src/worker/client-hub-project-policy", () => ({
  readClientHubBusinessProjectPolicy: vi.fn(async () => ({ allowed: projectPolicy.projects,
    proof: (projectPolicy.changed ? "q" : projectPolicy.projects ? "p" : "n").repeat(43),
    filter: { sql: projectPolicy.projects ? "1=1" : "0=1", values: [] } })),
}));
vi.mock("../src/worker/client-hub-business-projects", () => ({
  clientHubBusinessProjectSourceProof: vi.fn(async () => "s".repeat(43)),
}));
vi.mock("../src/worker/client-hub-business-project-detail", () => ({
  readClientHubBusinessProjectDetail: vi.fn(async (_env: unknown, _actor: unknown,
    context: ClientHubCollectionContext, projectId: string) => ({ canonicalRoot: context.canonicalRoot,
    contextVersion: context.contextVersion, project: { id: projectId, name: "Project", status: "active" } })),
}));
vi.mock("../src/worker/client-feedback", async importOriginal => {
  const original=await importOriginal<typeof import("../src/worker/client-feedback")>();
  return {...original,
    readStaffFeedbackPolicy:vi.fn(async()=>({grants:[],administrator:true,proof:"f".repeat(43)})),
    readStaffFeedbackScope:vi.fn(async(_env:unknown,_actor:unknown,record:{id:string;targetFingerprint:string;
      target:{sourceOwner:{project:{projectAlphaProjectId:string|null}|null}}})=>{
      feedbackScopeRace.calls+=1;
      return feedbackScopeRace.failAfter!==null&&feedbackScopeRace.calls>feedbackScopeRace.failAfter?null
        :{projectId:record.target.sourceOwner.project?.projectAlphaProjectId??"",proof:`feedback:${record.id}:${record.targetFingerprint}`};
    }),
  };
});
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
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,status TEXT);
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
      CREATE TABLE client_business_activity(sequence INTEGER PRIMARY KEY,projection_source_id TEXT,event_key TEXT,
        origin TEXT,record_kind TEXT,record_id TEXT,root_kind TEXT,root_id TEXT,root_record_kind TEXT,
        action TEXT,occurred_at TEXT,source_updated_at TEXT);
      CREATE TABLE client_business_activity_records(projection_source_id TEXT,record_kind TEXT,record_id TEXT,
        root_kind TEXT,root_id TEXT,record_name TEXT,readable INTEGER);
      CREATE TABLE pa_connectors(source_id TEXT PRIMARY KEY,read_visible INTEGER);
      CREATE TABLE staff_users(id TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE pa_projection_record_ids(projection_source_id TEXT,record_kind TEXT,local_id TEXT,
        PRIMARY KEY(projection_source_id,record_kind,local_id));
      CREATE TABLE pa_clients(id TEXT,projection_source_id TEXT,organization_id TEXT,active INTEGER,
        PRIMARY KEY(id,projection_source_id));
      CREATE TABLE pa_organizations(id TEXT,projection_source_id TEXT,name TEXT,active INTEGER,
        PRIMARY KEY(id,projection_source_id));
      CREATE TABLE pa_projects(id TEXT,projection_source_id TEXT,client_id TEXT,organization_id TEXT,name TEXT,
        active INTEGER,PRIMARY KEY(id,projection_source_id));
      CREATE TABLE project_operational_contact_sets(projection_source_id TEXT,project_record_kind TEXT,project_id TEXT,
        root_record_kind TEXT,root_id TEXT,version INTEGER,PRIMARY KEY(projection_source_id,project_id));
      CREATE TABLE project_operational_contact_revisions(id TEXT PRIMARY KEY,projection_source_id TEXT,project_id TEXT,
        version INTEGER,actor_id TEXT);
      CREATE TABLE project_operational_memory(projection_source_id TEXT,project_record_kind TEXT,project_id TEXT,
        root_record_kind TEXT,root_id TEXT,version INTEGER,PRIMARY KEY(projection_source_id,project_id));
      CREATE TABLE project_operational_memory_revisions(id TEXT PRIMARY KEY,projection_source_id TEXT,project_id TEXT,
        version INTEGER,change_kind TEXT,actor_id TEXT);
      CREATE TABLE project_operational_events(id TEXT PRIMARY KEY,projection_source_id TEXT,project_record_kind TEXT,
        project_id TEXT,actor_id TEXT,event_kind TEXT,result_version INTEGER,details_json TEXT,created_at TEXT);
      CREATE TABLE organization_operational_contact_sets(projection_source_id TEXT,organization_record_kind TEXT,
        organization_id TEXT,version INTEGER,PRIMARY KEY(projection_source_id,organization_id));
      CREATE TABLE organization_operational_contact_revisions(id TEXT PRIMARY KEY,projection_source_id TEXT,
        organization_id TEXT,version INTEGER,snapshot_json TEXT,actor_id TEXT,created_at TEXT);
      CREATE TABLE organization_operational_events(id TEXT PRIMARY KEY,projection_source_id TEXT,
        organization_record_kind TEXT,organization_id TEXT,actor_id TEXT,event_kind TEXT,result_version INTEGER,
        details_json TEXT,created_at TEXT);`
      .replace(/\s*\n\s*/g, " "));
    await ops.prepare("INSERT INTO staff_users VALUES('operational-actor','active')").run();
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary','active')"),
      delivery.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-other','project-alpha:secondary','active')"),
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
      expect(result.accessCoverage.project_access).toEqual({ available: false, reason: "not_collected", collectedSince: null });
    } finally { projectPolicy.deliveryAudit = true; projectPolicy.viewerManage = true; }
  });

  it("reports project-access notices as not collected before migration 0169 is ready", async () => {
    const result = await listClientAuditTimeline(env, staff, primaryContext(), { projectId: "project-one", limit: 10,
      filters: { category: "notification", actorType: "all", result: "all", from: null, to: null } });
    expect(result.notificationCoverage.project_access_collaborator_notice).toEqual({ available: false, reason: "not_collected" });
    expect(result.notificationCoverage.project_access_companion_notice).toEqual({ available: false, reason: "not_collected" });
    expect(result.items).toEqual([]);
  });

  it("federates exact operational project events with stable pagination and strict redaction", async () => {
    await ops.batch([
      ops.prepare("INSERT INTO pa_clients VALUES('client-one','project-alpha:primary','organization-one',1)"),
      ops.prepare("INSERT INTO pa_clients VALUES('client-other','project-alpha:primary','organization-other',1)"),
      ops.prepare("INSERT INTO pa_projects VALUES('project-one','project-alpha:primary','client-one','organization-one','Church survey',1)"),
      ops.prepare("INSERT INTO pa_projects VALUES('project-sibling','project-alpha:primary','client-one','organization-one','Sibling survey',1)"),
      ops.prepare("INSERT INTO pa_projects VALUES('project-malformed','project-alpha:primary','client-one','organization-one','Malformed overlay',1)"),
      ops.prepare("INSERT INTO pa_projects VALUES('project-reassigned','project-alpha:primary','client-other','organization-other','Reassigned project',1)"),
      ops.prepare("INSERT INTO pa_projects VALUES('project-wrong-source','project-alpha:secondary','client-one','organization-one','Wrong source',1)"),
      ...["project-one", "project-sibling", "project-malformed", "project-reassigned"].map(id =>
        ops.prepare("INSERT INTO pa_projection_record_ids VALUES('project-alpha:primary','project',?)").bind(id)),
      ops.prepare("INSERT INTO pa_projection_record_ids VALUES('project-alpha:secondary','project','project-wrong-source')"),
      ops.prepare("INSERT INTO project_operational_contact_sets VALUES('project-alpha:primary','project','project-one','organization','organization-one',2)"),
      ops.prepare("INSERT INTO project_operational_contact_revisions VALUES('contacts-one-v1','project-alpha:primary','project-one',1,'operational-actor')"),
      ops.prepare("INSERT INTO project_operational_contact_revisions VALUES('contacts-one-v2','project-alpha:primary','project-one',2,'operational-actor')"),
      ops.prepare("INSERT INTO project_operational_memory VALUES('project-alpha:primary','project','project-one','organization','organization-one',3)"),
      ops.prepare("INSERT INTO project_operational_memory_revisions VALUES('memory-one-v1','project-alpha:primary','project-one',1,'saved','operational-actor')"),
      ops.prepare("INSERT INTO project_operational_memory_revisions VALUES('memory-one-v2','project-alpha:primary','project-one',2,'post_completion_amendment','operational-actor')"),
      ops.prepare("INSERT INTO project_operational_memory_revisions VALUES('memory-one-v3','project-alpha:primary','project-one',3,'saved','operational-actor')"),
      ops.prepare("INSERT INTO project_operational_contact_sets VALUES('project-alpha:primary','project','project-sibling','organization','organization-one',1)"),
      ops.prepare("INSERT INTO project_operational_contact_revisions VALUES('contacts-sibling-v1','project-alpha:primary','project-sibling',1,'operational-actor')"),
      ops.prepare("INSERT INTO project_operational_contact_sets VALUES('project-alpha:primary','project','project-malformed','organization','organization-other',1)"),
      ops.prepare("INSERT INTO project_operational_contact_revisions VALUES('contacts-malformed-v1','project-alpha:primary','project-malformed',1,'operational-actor')"),
      ops.prepare("INSERT INTO project_operational_contact_sets VALUES('project-alpha:primary','project','project-reassigned','organization','organization-one',1)"),
      ops.prepare("INSERT INTO project_operational_contact_revisions VALUES('contacts-reassigned-v1','project-alpha:primary','project-reassigned',1,'operational-actor')"),
      ops.prepare("INSERT INTO project_operational_contact_sets VALUES('project-alpha:secondary','project','project-wrong-source','organization','organization-one',1)"),
      ops.prepare("INSERT INTO project_operational_contact_revisions VALUES('contacts-wrong-source-v1','project-alpha:secondary','project-wrong-source',1,'operational-actor')"),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-contacts','project-alpha:primary','project','project-one','operational-actor','contacts_saved',1,?,'2026-08-25T10:00:00.000Z')")
        .bind(JSON.stringify({ assignmentCount: 2, privateEmail: "never@example.test", instructions: "private instructions" })),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-contacts-copy','project-alpha:primary','project','project-one','operational-actor','contacts_saved',2,?,'2026-08-25T11:00:00.000Z')")
        .bind(JSON.stringify({ copied: true, sourceProjectId: "secret-source-project", copiedContactIds: ["secret-contact"] })),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-memory','project-alpha:primary','project','project-one','operational-actor','memory_saved',1,?,'2026-08-25T12:00:00.000Z')")
        .bind(JSON.stringify({ sectionCount: 4, plan: "private plan" })),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-memory-amended','project-alpha:primary','project','project-one','operational-actor','memory_amended',2,?,'2026-08-25T13:00:00.000Z')")
        .bind(JSON.stringify({ sectionCount: 5, amendmentReason: "private reason" })),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-memory-copy','project-alpha:primary','project','project-one','operational-actor','memory_saved',3,?,'2026-08-25T13:30:00.000Z')")
        .bind(JSON.stringify({ copied: true, sourceProjectId: "secret-memory-source", sections: ["private-plan"] })),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-sibling','project-alpha:primary','project','project-sibling','operational-actor','contacts_saved',1,'{}','2026-08-25T14:00:00.000Z')"),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-malformed','project-alpha:primary','project','project-malformed','operational-actor','contacts_saved',1,'{}','2026-08-25T15:00:00.000Z')"),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-reassigned','project-alpha:primary','project','project-reassigned','operational-actor','contacts_saved',1,'{}','2026-08-25T16:00:00.000Z')"),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-wrong-source','project-alpha:secondary','project','project-wrong-source','operational-actor','contacts_saved',1,'{}','2026-08-25T17:00:00.000Z')"),
    ]);
    const options = { projectId: "project-one", limit: 2,
      filters: { category: "project", actorType: "staff", result: "succeeded", from: null, to: null } as const };
    const first = await listClientAuditTimeline(env, staff, primaryContext(), options);
    expect(first.projectCoverage).toEqual({ source_record_activity: { available: true, reason: null },
      operational_project_activity: { available: true, reason: null },
      organization_contact_activity: { available: false, reason: "not_applicable" } });
    expect(first.page.hasMore).toBe(true);
    await ops.batch([
      ops.prepare("UPDATE project_operational_contact_sets SET version=3 WHERE projection_source_id='project-alpha:primary' AND project_id='project-one'"),
      ops.prepare("INSERT INTO project_operational_contact_revisions VALUES('contacts-one-v3','project-alpha:primary','project-one',3,'operational-actor')"),
      ops.prepare("INSERT INTO project_operational_events VALUES('event-after-watermark','project-alpha:primary','project','project-one','operational-actor','contacts_saved',3,'{}','2026-08-25T18:00:00.000Z')"),
    ]);
    const collected = [...first.items]; let cursor = first.page.nextCursor;
    while (cursor) {
      const page = await listClientAuditTimeline(env, staff, primaryContext(), { ...options, cursor });
      collected.push(...page.items); cursor = page.page.nextCursor;
    }
    expect(collected.map(event => event.action)).toEqual([
      "project.memory.copied_forward", "project.memory.amended", "project.memory.saved",
      "project.contacts.copied_forward", "project.contacts.saved",
    ]);
    expect(collected.every(event => event.producer === "operations" && event.actor?.type === "staff"
      && event.result === "succeeded" && event.resource.id === "project-one")).toBe(true);
    expect(collected.some(event => event.producerEventId.includes("after-watermark"))).toBe(false);
    expect(JSON.stringify(collected)).not.toMatch(/never@example|private|secret-source|secret-contact|details_json|result_version|actor_id/i);

    const root = await listClientAuditTimeline(env, staff, primaryContext(), { limit: 100,
      filters: { category: "project", actorType: "staff", result: "succeeded",
        from: "2026-08-25T14:00:00.000Z", to: "2026-08-25T18:00:00.000Z" } });
    expect(root.items.filter(event => event.producer === "operations").map(event => event.producerEventId))
      .toEqual(["operational-project:event-after-watermark", "operational-project:event-sibling"]);
    expect(JSON.stringify(root)).not.toMatch(/event-malformed|event-reassigned|event-wrong-source/);
    const denied = await listClientAuditTimeline(env, staff, primaryContext(), { projectId: "project-one", limit: 1,
      filters: { category: "project", actorType: "system", result: "succeeded", from: null, to: null } });
    expect(denied.items).toEqual([]);
  });

  it("federates exact organization contact history with stable pagination and strict redaction", async () => {
    const occurredAt = "2026-08-27T19:00:00.000Z";
    await ops.batch([
      ops.prepare("INSERT INTO pa_organizations VALUES('organization-one','project-alpha:primary','Greenwood Project Management LLC',1)"),
      ops.prepare("INSERT INTO pa_organizations VALUES('organization-other','project-alpha:primary','Other organization',1)"),
      ops.prepare("INSERT INTO pa_organizations VALUES('organization-one','project-alpha:secondary','Wrong-source organization',1)"),
      ops.prepare("INSERT INTO pa_projection_record_ids VALUES('project-alpha:primary','organization','organization-one')"),
      ops.prepare("INSERT INTO pa_projection_record_ids VALUES('project-alpha:primary','organization','organization-other')"),
      ops.prepare("INSERT INTO pa_projection_record_ids VALUES('project-alpha:secondary','organization','organization-one')"),
      ops.prepare("INSERT INTO organization_operational_contact_sets VALUES('project-alpha:primary','organization','organization-one',3)"),
      ops.prepare("INSERT INTO organization_operational_contact_sets VALUES('project-alpha:primary','organization','organization-other',1)"),
      ops.prepare("INSERT INTO organization_operational_contact_sets VALUES('project-alpha:secondary','organization','organization-one',1)"),
      ...[1, 2, 3].map(version => ops.prepare(`INSERT INTO organization_operational_contact_revisions
        VALUES(?,?,?,?,?,?,?)`).bind(`organization-one-v${version}`, "project-alpha:primary", "organization-one", version,
          JSON.stringify({ assignments: [{ contactId: `private-contact-${version}`, email: `private-${version}@example.test` }] }),
          "operational-actor", occurredAt)),
      ops.prepare(`INSERT INTO organization_operational_contact_revisions VALUES('organization-other-v1','project-alpha:primary',
        'organization-other',1,?,'operational-actor',?)`).bind(JSON.stringify({ private: "sibling snapshot" }), occurredAt),
      ops.prepare(`INSERT INTO organization_operational_contact_revisions VALUES('organization-wrong-source-v1','project-alpha:secondary',
        'organization-one',1,?,'operational-actor',?)`).bind(JSON.stringify({ private: "wrong source snapshot" }), occurredAt),
      ...["a", "b", "c"].map((suffix, index) => ops.prepare(`INSERT INTO organization_operational_events
        VALUES(?,?,?,?,?,'contacts_saved',?,?,?)`).bind(`event-org-${suffix}`, "project-alpha:primary", "organization",
          "organization-one", "operational-actor", index + 1,
          JSON.stringify({ privateContactIds: [`private-contact-${index + 1}`], secretChannel: "private@example.test" }), occurredAt)),
      ops.prepare(`INSERT INTO organization_operational_events VALUES('event-org-sibling','project-alpha:primary','organization',
        'organization-other','operational-actor','contacts_saved',1,?,?)`).bind(JSON.stringify({ private: "sibling event" }), occurredAt),
      ops.prepare(`INSERT INTO organization_operational_events VALUES('event-org-wrong-source','project-alpha:secondary','organization',
        'organization-one','operational-actor','contacts_saved',1,?,?)`).bind(JSON.stringify({ private: "wrong source event" }), occurredAt),
    ]);
    const options = { limit: 1,
      filters: { category: "project", actorType: "staff", result: "succeeded", from: occurredAt, to: occurredAt } as const };
    const first = await listClientAuditTimeline(env, staff, primaryContext(), options);
    expect(first.projectCoverage.organization_contact_activity).toEqual({ available: true, reason: null });
    expect(first.page.hasMore).toBe(true);
    await ops.batch([
      ops.prepare(`UPDATE organization_operational_contact_sets SET version=4
        WHERE projection_source_id='project-alpha:primary' AND organization_id='organization-one'`),
      ops.prepare(`INSERT INTO organization_operational_contact_revisions VALUES('organization-one-v4','project-alpha:primary',
        'organization-one',4,?,'operational-actor',?)`).bind(JSON.stringify({ private: "late snapshot" }), occurredAt),
      ops.prepare(`INSERT INTO organization_operational_events VALUES('event-org-late','project-alpha:primary','organization',
        'organization-one','operational-actor','contacts_saved',4,?,?)`).bind(JSON.stringify({ private: "late event" }), occurredAt),
    ]);
    const collected = [...first.items]; let cursor = first.page.nextCursor;
    while (cursor) {
      const page = await listClientAuditTimeline(env, staff, primaryContext(), { ...options, cursor });
      collected.push(...page.items); cursor = page.page.nextCursor;
    }
    expect(collected.map(event => event.producerEventId)).toEqual([
      "organization-contacts:event-org-a", "organization-contacts:event-org-b", "organization-contacts:event-org-c",
    ]);
    expect(collected.every(event => event.action === "organization.contacts.saved" && event.producer === "operations"
      && event.actor?.type === "staff" && event.resource.type === "organization_operational_contacts"
      && event.resource.label === "Greenwood Project Management LLC")).toBe(true);
    expect(JSON.stringify(collected)).not.toMatch(/late|sibling|wrong-source|private-contact|private@example|snapshot_json|details_json|actor_id/i);
  });

  it("reports operational project activity as permission required without projects.view", async () => {
    projectPolicy.projects = false;
    try {
      const result = await listClientAuditTimeline(env, staff, primaryContext(), { limit: 100,
        filters: { category: "project", actorType: "staff", result: "succeeded", from: null, to: null } });
      expect(result.projectCoverage).toEqual({ source_record_activity: { available: true, reason: null },
        operational_project_activity: { available: false, reason: "permission_required" },
        organization_contact_activity: { available: false, reason: "permission_required" } });
      expect(result.items.filter(event => event.producer === "operations")).toEqual([]);
    } finally { projectPolicy.projects = true; }
  });

  it("federates redacted project-access notices with exact root/project scope and a stable high-water", async () => {
    await delivery.exec(`
      CREATE TABLE portal_project_access_terms(id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,
        project_public_id TEXT,kind TEXT);
      CREATE TABLE portal_project_access_notice_outbox(id TEXT PRIMARY KEY,access_terms_id TEXT,workspace_id TEXT,source_id TEXT,
        project_public_id TEXT,identity_id TEXT,event_type TEXT,error_code TEXT);
      CREATE TABLE portal_project_access_notice_audit(id TEXT PRIMARY KEY,outbox_id TEXT,workspace_id TEXT,
        project_public_id TEXT,identity_id TEXT,event_type TEXT,action TEXT,reason_code TEXT,created_at TEXT);
      CREATE TABLE portal_project_access_companion_notice_outbox(id TEXT PRIMARY KEY,access_terms_id TEXT,workspace_id TEXT,
        source_id TEXT,project_public_id TEXT,recipient_role TEXT,origin_id TEXT,companion_actor_id TEXT,event_type TEXT,error_code TEXT);
      CREATE TABLE portal_project_access_companion_notice_audit(id TEXT PRIMARY KEY,outbox_id TEXT,workspace_id TEXT,
        project_public_id TEXT,recipient_role TEXT,event_type TEXT,action TEXT,reason_code TEXT,created_at TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_project_access_terms VALUES('terms-one','workspace-one','project-alpha:primary','project-one','collaborator')"),
      delivery.prepare("INSERT INTO portal_project_access_terms VALUES('terms-two','workspace-one','project-alpha:primary','project-two','collaborator')"),
      delivery.prepare("INSERT INTO portal_project_access_terms VALUES('terms-other','workspace-other','project-alpha:secondary','project-one','collaborator')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_outbox VALUES('outbox-one','terms-one','workspace-one','project-alpha:primary','project-one','identity-private-one','warning_7d','private-error')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_outbox VALUES('outbox-two','terms-one','workspace-one','project-alpha:primary','project-one','identity-private-two','warning_24h','private-error-two')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_outbox VALUES('outbox-sibling','terms-two','workspace-one','project-alpha:primary','project-two','identity-sibling','expired','private-sibling')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_outbox VALUES('outbox-wrong-source','terms-one','workspace-one','project-alpha:secondary','project-one','identity-wrong-source','expired','private-source')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_outbox VALUES('outbox-other-workspace','terms-other','workspace-other','project-alpha:secondary','project-one','identity-other-workspace','expired','private-workspace')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_outbox VALUES('outbox-terms-mismatch','terms-two','workspace-one','project-alpha:primary','project-one','identity-terms-mismatch','expired','private-terms')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-one','outbox-one','workspace-one','project-one','identity-private-one','warning_7d','notice.sent','private-reason-one','2026-08-27T10:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-two','outbox-two','workspace-one','project-one','identity-private-two','warning_24h','notice.retry_scheduled','private-reason-two','2026-08-27T09:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-sibling','outbox-sibling','workspace-one','project-two','identity-sibling','expired','notice.failed','private-sibling-reason','2026-08-27T08:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-wrong-source','outbox-wrong-source','workspace-one','project-one','identity-wrong-source','expired','notice.sent','private-source-reason','2026-08-27T07:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-other-workspace','outbox-other-workspace','workspace-other','project-one','identity-other-workspace','expired','notice.sent','private-workspace-reason','2026-08-27T06:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-terms-mismatch','outbox-terms-mismatch','workspace-one','project-one','identity-terms-mismatch','expired','notice.sent','private-terms-reason','2026-08-27T11:45:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-noise-action','outbox-one','workspace-one','project-one','identity-private-one','warning_7d','notice.opened','private-open','2026-08-27T11:00:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-noise-type','outbox-one','workspace-one','project-one','identity-private-one','warning_30d','notice.sent','private-type','2026-08-27T11:30:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_companion_notice_outbox VALUES('companion-inviter','terms-one','workspace-one','project-alpha:primary','project-one','inviter','invitation-private','identity-inviter-private','warning_7d','private-companion-error')"),
      delivery.prepare("INSERT INTO portal_project_access_companion_notice_outbox VALUES('companion-creator','terms-one','workspace-one','project-alpha:primary','project-one','access_creator','grant-private','staff-private','warning_24h','private-creator-error')"),
      delivery.prepare("INSERT INTO portal_project_access_companion_notice_outbox VALUES('companion-sibling','terms-two','workspace-one','project-alpha:primary','project-two','inviter','invitation-sibling','identity-sibling-private','expired','private-sibling-error')"),
      delivery.prepare("INSERT INTO portal_project_access_companion_notice_outbox VALUES('companion-mismatch','terms-two','workspace-one','project-alpha:primary','project-one','inviter','invitation-mismatch','identity-mismatch-private','expired','private-mismatch-error')"),
      delivery.prepare("INSERT INTO portal_project_access_companion_notice_audit VALUES('companion-audit-inviter','companion-inviter','workspace-one','project-one','inviter','warning_7d','notice.sent','private-companion-reason','2026-08-27T10:30:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_companion_notice_audit VALUES('companion-audit-creator','companion-creator','workspace-one','project-one','access_creator','warning_24h','notice.failed','private-creator-reason','2026-08-27T09:30:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_companion_notice_audit VALUES('companion-audit-sibling','companion-sibling','workspace-one','project-two','inviter','expired','notice.sent','private-sibling-companion','2026-08-27T08:30:00.000Z')"),
      delivery.prepare("INSERT INTO portal_project_access_companion_notice_audit VALUES('companion-audit-mismatch','companion-mismatch','workspace-one','project-one','inviter','expired','notice.sent','private-mismatch-companion','2026-08-27T11:50:00.000Z')"),
    ]);
    const options = { projectId: "project-one", limit: 2,
      filters: { category: "notification", actorType: "system", result: "all", from: null, to: null } as const };
    const first = await listClientAuditTimeline(env, staff, primaryContext(), options);
    expect(first.notificationCoverage).toMatchObject({ project_access_collaborator_notice: { available: true, reason: null },
      project_access_companion_notice: { available: true, reason: null } });
    expect(first.items).toMatchObject([
      { producerEventId: "project-access-companion-notice:companion-audit-inviter", category: "notification",
        action: "project_access.inviter.warning_7d.sent", actor: { type: "system", label: "System" },
        resource: { type: "project_access_notice", label: "Project access notice" }, result: "succeeded" },
      { producerEventId: "project-access-notice:audit-one", action: "project_access.collaborator.warning_7d.sent", result: "succeeded" },
    ]);
    expect(first.page.hasMore).toBe(true);
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_project_access_notice_outbox VALUES('outbox-late','terms-one','workspace-one','project-alpha:primary','project-one','identity-late','expired','private-late')"),
      delivery.prepare("INSERT INTO portal_project_access_notice_audit VALUES('audit-late','outbox-late','workspace-one','project-one','identity-late','expired','notice.failed','private-late-reason','2026-08-27T12:00:00.000Z')"),
    ]);
    const second = await listClientAuditTimeline(env, staff, primaryContext(), { ...options, cursor: first.page.nextCursor! });
    expect(second.items).toMatchObject([
      { producerEventId: "project-access-companion-notice:companion-audit-creator",
        action: "project_access.access_creator.warning_24h.failed", result: "failed" },
      { producerEventId: "project-access-notice:audit-two",
        action: "project_access.collaborator.warning_24h.retry_scheduled", result: "informational" },
    ]);
    expect(second.page).toMatchObject({ hasMore: false, nextCursor: null });
    const serialized = JSON.stringify([first, second]);
    expect(serialized).not.toMatch(/identity-private|identity-sibling|identity-wrong|identity-other|identity-late|identity-inviter|staff-private|invitation-private|grant-private|private-|outbox-|reason_code|error_code/i);
    const root = await listClientAuditTimeline(env, staff, primaryContext(), { limit: 100,
      filters: { category: "notification", actorType: "system", result: "all", from: null, to: null } });
    expect(new Set(root.items.filter(event => event.resource.type === "project_access_notice").map(event => event.producerEventId)))
      .toEqual(new Set(["project-access-notice:audit-one", "project-access-notice:audit-two", "project-access-notice:audit-sibling",
        "project-access-notice:audit-late", "project-access-companion-notice:companion-audit-inviter",
        "project-access-companion-notice:companion-audit-creator", "project-access-companion-notice:companion-audit-sibling"]));
  });

  it("binds notice continuation and coverage to the current portal-management permission", async () => {
    const options = { projectId: "project-one", limit: 1,
      filters: { category: "notification", actorType: "system", result: "all", from: null, to: null } as const };
    const first = await listClientAuditTimeline(env, staff, primaryContext(), options);
    projectPolicy.portal = false;
    try {
      await expect(listClientAuditTimeline(env, staff, primaryContext(), { ...options, cursor: first.page.nextCursor! }))
        .rejects.toMatchObject({ status: 409 });
      const denied = await listClientAuditTimeline(env, staff, primaryContext(), options);
      expect(denied.notificationCoverage.project_access_collaborator_notice).toEqual({ available: false, reason: "permission_required" });
      expect(denied.notificationCoverage.project_access_companion_notice).toEqual({ available: false, reason: "permission_required" });
      expect(denied.items).toEqual([]);
    } finally { projectPolicy.portal = true; }
  });

  it("paginates canonical project access exactly once and suppresses only authorized snapshot duplicates",async()=>{
    await delivery.exec(`CREATE TABLE portal_project_access_authority_history_state(singleton INTEGER PRIMARY KEY,collection_started_at TEXT);
      INSERT INTO portal_project_access_authority_history_state VALUES(1,'2026-08-27T12:00:00.000Z');
      CREATE TABLE portal_project_access_authority_events(recorded_sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,
        workspace_id TEXT,source_id TEXT,project_public_id TEXT,authority_type TEXT,authority_id TEXT,producer_event_key TEXT UNIQUE,
        event_kind TEXT,actor_type TEXT,occurred_at TEXT);`
      .replace(/\s*\n\s*/g,' '));
    const at='2026-08-27T20:00:00.000Z';
    await delivery.batch([
      ...Array.from({length:5},(_,index)=>delivery.prepare(`INSERT INTO portal_project_access_authority_events
        (id,workspace_id,source_id,project_public_id,authority_type,authority_id,producer_event_key,event_kind,actor_type,occurred_at)
        VALUES(?,?,?,?,?,?,?,'grant_created','staff',?)`).bind(`canonical-${index}`,'workspace-one','project-alpha:primary','project-one',
          'authenticated_delivery_grant',`canonical-grant-${index}`,`canonical-key-${index}`,at)),
      delivery.prepare("INSERT INTO portal_v2_folder_bindings VALUES('binding-post','workspace-one','project','project-one')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grants VALUES('grant-post','workspace-one','binding-post')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES('audit-post','grant-post','workspace-one','grant.created','2026-08-27T18:00:00.000Z')"),
      delivery.prepare(`INSERT INTO portal_project_access_authority_events(id,workspace_id,source_id,project_public_id,authority_type,authority_id,producer_event_key,event_kind,actor_type,occurred_at)
        VALUES('canonical-post','workspace-one','project-alpha:primary','project-one','authenticated_delivery_grant','grant-post','authenticated-grant-audit:audit-post','grant_created','staff','2026-08-27T18:00:00.000Z')`),
      delivery.prepare("INSERT INTO portal_v2_folder_bindings VALUES('binding-wrong-source','workspace-one','project','project-one')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grants VALUES('grant-wrong-source','workspace-one','binding-wrong-source')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES('audit-wrong-source','grant-wrong-source','workspace-one','grant.created','2026-08-27T17:00:00.000Z')"),
      delivery.prepare(`INSERT INTO portal_project_access_authority_events(id,workspace_id,source_id,project_public_id,authority_type,authority_id,producer_event_key,event_kind,actor_type,occurred_at)
        VALUES('canonical-wrong-source','workspace-one','project-alpha:secondary','project-one','authenticated_delivery_grant','grant-wrong-source','authenticated-grant-audit:audit-wrong-source','grant_created','staff','2026-08-27T17:00:00.000Z')`),
      delivery.prepare("INSERT INTO portal_v2_folder_bindings VALUES('binding-late','workspace-one','project','project-one')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grants VALUES('grant-late','workspace-one','binding-late')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_audit VALUES('audit-late','grant-late','workspace-one','grant.created','2026-08-27T16:30:00.000Z')"),
    ]);
    const filters={category:'access',actorType:'staff',result:'succeeded',from:'2026-08-27T19:00:00.000Z',to:'2026-08-27T21:00:00.000Z'} as const;
    const options={projectId:'project-one',limit:2,filters},first=await listClientAuditTimeline(env,staff,primaryContext(),options);
    expect(first.accessCoverage.project_access).toEqual({available:true,reason:null,collectedSince:'2026-08-27T12:00:00.000Z'});
    const collected=[...first.items];let cursor=first.page.nextCursor;
    while(cursor){const page=await listClientAuditTimeline(env,staff,primaryContext(),{...options,cursor});collected.push(...page.items);cursor=page.page.nextCursor;}
    const canonical=collected.filter(item=>item.action==='project_access.grant_created');
    expect(canonical.map(item=>item.producerEventId.replace(/^project-access:\d{20}:/,''))).toEqual([
      'canonical-0','canonical-1','canonical-2','canonical-3','canonical-4',
    ]);
    expect(new Set(canonical.map(item=>item.id)).size).toBe(5);
    const duplicateWindow=await listClientAuditTimeline(env,staff,primaryContext(),{projectId:'project-one',limit:20,
      filters:{...filters,from:'2026-08-27T16:00:00.000Z',to:'2026-08-27T18:30:00.000Z'}});
    expect(duplicateWindow.items.filter(item=>item.action==='grant.created'&&item.producerEventId.includes('audit-post'))).toEqual([]);
    expect(duplicateWindow.items.some(item=>item.producerEventId==='authenticated-grant:audit-wrong-source')).toBe(true);
    projectPolicy.portal=false;
    try{
      const legacy=await listClientAuditTimeline(env,staff,primaryContext(),{projectId:'project-one',limit:20,
        filters:{...filters,from:'2026-08-27T17:30:00.000Z',to:'2026-08-27T18:30:00.000Z'}});
      expect(legacy.accessCoverage.project_access).toMatchObject({available:false,reason:'permission_required'});
      expect(legacy.items.some(item=>item.producerEventId==='authenticated-grant:audit-post')).toBe(true);
    }finally{projectPolicy.portal=true;}

    const snapshot=await listClientAuditTimeline(env,staff,primaryContext(),{projectId:'project-one',limit:1,
      filters:{...filters,from:'2026-08-27T16:00:00.000Z',to:'2026-08-27T21:00:00.000Z'}});
    await delivery.prepare(`INSERT INTO portal_project_access_authority_events(id,workspace_id,source_id,project_public_id,authority_type,authority_id,producer_event_key,event_kind,actor_type,occurred_at)
      VALUES('canonical-late','workspace-one','project-alpha:primary','project-one','authenticated_delivery_grant','grant-late','authenticated-grant-audit:audit-late','grant_created','staff','2026-08-27T16:30:00.000Z')`).run();
    const later:typeof snapshot.items=[];let next=snapshot.page.nextCursor;
    while(next){const page=await listClientAuditTimeline(env,staff,primaryContext(),{projectId:'project-one',limit:1,filters:{...filters,from:'2026-08-27T16:00:00.000Z',to:'2026-08-27T21:00:00.000Z'},cursor:next});later.push(...page.items);next=page.page.nextCursor;}
    expect(later.some(item=>item.producerEventId==='authenticated-grant:audit-late')).toBe(true);
  });

  it("federates redacted project feedback lifecycle events and excludes other target kinds",async()=>{
    await delivery.exec(`CREATE TABLE client_feedback(id TEXT PRIMARY KEY,account_id TEXT,scope_key TEXT,workspace_id TEXT,
      creator_identity_id TEXT,creator_workspace_identity_id TEXT,principal_issuer TEXT,principal_subject TEXT,target_kind TEXT,
      project_id TEXT,target_json TEXT,target_fingerprint TEXT,message TEXT,status TEXT,revision INTEGER,completion_note TEXT,
      completed_at TEXT,completed_by_staff_id TEXT,mutation_key TEXT,request_fingerprint TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE client_feedback_events(id TEXT PRIMARY KEY,feedback_id TEXT,revision INTEGER,actor_type TEXT,actor_id TEXT,
        status TEXT,note TEXT,created_at TEXT);
      CREATE TABLE client_feedback_mutations(id TEXT);CREATE TABLE client_feedback_notifications(id TEXT);
      CREATE TABLE client_feedback_notification_outbox(id TEXT);`.replace(/\s*\n\s*/g," "));
    const target=(label:string)=>JSON.stringify({kind:"project",projectId:"project-alpha-local",associationId:null,
      relativePath:null,storageKey:null,label,projectName:"Private project name",sourceOwner:{version:2,
        account:{projectAlphaClientId:null,projectAlphaOrganizationId:"organization-one",projectAlphaSourceId:"project-alpha:primary"},
        project:{projectAlphaProjectId:"project-one",sourceUpdatedAt:"private-source-version",projectAlphaSourceId:"project-alpha:primary"},
        workspace:null,association:null,file:null}});
    await delivery.batch([
      delivery.prepare("INSERT OR IGNORE INTO client_accounts VALUES('account-alpha','active','project-alpha:primary',NULL,'organization-one')"),
      delivery.prepare("INSERT OR IGNORE INTO projects VALUES('project-alpha-local',1,'project-alpha:primary','project-one','Private project label')"),
      delivery.prepare("INSERT OR IGNORE INTO client_project_grants VALUES('account-alpha','project-alpha-local','2026-08-01T00:00:00.000Z',NULL)"),
      delivery.prepare(`INSERT INTO client_feedback VALUES('feedback-authorized','account-alpha','account:account-alpha',NULL,
        'private-client-identity',NULL,'private-issuer','private-subject','project','project-alpha-local',?,?,'private message',
        'done',3,'private completion note','2026-08-28T12:00:00.000Z','private-staff','private-mutation-key-123',?,
        '2026-08-28T10:00:00.000Z','2026-08-28T12:00:00.000Z')`).bind(target("Secret target label"),"a".repeat(64),"b".repeat(64)),
      delivery.prepare(`INSERT INTO client_feedback VALUES('feedback-unauthorized','account-alpha','account:account-alpha',NULL,
        'private-other-identity',NULL,'private-issuer','private-other-subject','folder','project-alpha-local',?,?,'other secret',
        'new',1,NULL,NULL,NULL,'private-mutation-key-456',?,'2026-08-28T13:00:00.000Z','2026-08-28T13:00:00.000Z')`)
        .bind(target("Unauthorized"),"c".repeat(64),"d".repeat(64)),
      delivery.prepare("INSERT INTO client_feedback_events VALUES('feedback-event-unauthorized','feedback-unauthorized',1,'client','private-client','new','private note','2026-08-28T13:00:00.000Z')"),
      delivery.prepare("INSERT INTO client_feedback_events VALUES('feedback-event-3','feedback-authorized',3,'staff','private-staff','done','private done note','2026-08-28T12:00:00.000Z')"),
      delivery.prepare("INSERT INTO client_feedback_events VALUES('feedback-event-2','feedback-authorized',2,'staff','private-staff','in_progress','private progress note','2026-08-28T11:00:00.000Z')"),
      delivery.prepare("INSERT INTO client_feedback_events VALUES('feedback-event-1','feedback-authorized',1,'client','private-client','new','private submitted note','2026-08-28T10:00:00.000Z')"),
    ]);
    const options={projectId:"project-one",limit:1,filters:{category:"feedback",actorType:"all",result:"succeeded",
      from:null,to:null}} as const;
    const first=await listClientAuditTimeline(env,staff,primaryContext(),options);
    expect(first.coverage.feedback).toEqual({available:true,reason:null});
    expect(first.items[0]).toMatchObject({producer:"client_feedback",action:"feedback.completed",
      actor:{type:"staff",label:"Team"},resource:{type:"client_feedback",id:"feedback-authorized",label:"Client feedback"}});
    await delivery.prepare("INSERT INTO client_feedback_events VALUES('feedback-event-late','feedback-authorized',4,'staff','private-staff','done',NULL,'2026-08-28T14:00:00.000Z')").run();
    const events=[...first.items];let cursor=first.page.nextCursor;
    while(cursor){const page=await listClientAuditTimeline(env,staff,primaryContext(),{...options,cursor});events.push(...page.items);cursor=page.page.nextCursor;}
    expect(events.map(event=>event.action)).toEqual(["feedback.completed","feedback.started","feedback.submitted"]);
    expect(JSON.stringify(events)).not.toMatch(/Unauthorized|Secret target|Private project|private message|private note|identity|issuer|subject|source-version|completion/i);
    await delivery.prepare("DELETE FROM client_feedback_events WHERE id='feedback-event-late'").run();
    feedbackScopeRace.calls=0;feedbackScopeRace.failAfter=1;
    try{
      await expect(listClientAuditTimeline(env,staff,primaryContext(),options)).rejects.toMatchObject({status:409});
    }finally{feedbackScopeRace.calls=0;feedbackScopeRace.failAfter=null;}
  });
});
