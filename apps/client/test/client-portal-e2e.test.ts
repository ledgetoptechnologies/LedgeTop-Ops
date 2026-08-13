import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const portalOrigin = "https://client.test";
const principal: VerifiedClientPrincipal = {
  issuer: "https://team.cloudflareaccess.com",
  subject: "subject-manager-a",
  email: "manager@example.com",
};
const otherPrincipal: VerifiedClientPrincipal = {
  issuer: principal.issuer,
  subject: "subject-manager-b",
  email: "other-manager@example.com",
};

describe("client portal migrated-D1 end-to-end contract", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;
  let bucketGetKeys: string[];

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "client-portal-e2e" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;

    const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const migration of readdirSync(migrationsDirectory).filter(name => name.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
      if (["0107_thumbnail_cleanup_jobs.sql", "0111_thumbnail_render_provenance.sql", "0116_incoming_upload_hardening.sql", "0118_staff_work_area_revisions.sql", "0119_client_request_attachments.sql", "0120_project_alpha_draft_quote_receipts.sql", "0121_client_workspace_hierarchy_v2.sql", "0126_delivery_share_recipient_snapshots.sql"].includes(migration)) {
        await db.exec(sql.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
        continue;
      }
      if (migration === "0103_client_portal_workspace.sql") {
        await db.batch([
          db.prepare("INSERT INTO client_accounts (id,display_name,status) VALUES ('migration-account','Migration Client','active')"),
          db.prepare("INSERT INTO client_identity_links (id,account_id,issuer,subject,email) VALUES ('migration-identity','migration-account','https://issuer.test','migration-subject','migration@example.test')"),
          db.prepare("INSERT INTO client_account_members (account_id,identity_id,role) VALUES ('migration-account','migration-identity','manager')"),
          db.prepare("INSERT INTO projects (id,external_ref,client_name,project_name,r2_prefix) VALUES ('migration-project','MIG-1','Migration Client','Retained Project','clients/migration/project/')"),
          db.prepare("INSERT INTO client_project_grants (account_id,project_id,can_request_service) VALUES ('migration-account','migration-project',1)"),
          db.prepare("INSERT INTO client_service_requests (id,account_id,project_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status) VALUES ('migration-request','migration-account','migration-project','migration-identity','service','Retained request','Keep this row through migration','migration-key-0000000001','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','accepted')"),
          db.prepare("INSERT INTO client_portal_notification_outbox (id,request_id,event_type,status_value,recipient_kind,payload_json) VALUES ('migration-notification','migration-request','request_status_changed','accepted','client_requester','{}')"),
          db.prepare("INSERT INTO client_service_requests (id,account_id,project_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,area_geojson,status) VALUES ('migration-invalid-json','migration-account','migration-project','migration-identity','service','Legacy malformed geometry','Preserve the request and sanitize invalid JSON','migration-key-0000000002','ccccccccccccccccccccccccccccccccccccccccccc','not-json','submitted')"),
          db.prepare("INSERT INTO client_portal_notification_outbox (id,request_id,event_type,status_value,recipient_kind,payload_json) VALUES ('migration-invalid-payload','migration-invalid-json','request_submitted','submitted','staff_triage','not-json')"),
        ]);
        const statements = sql.split(/;\s*(?:\n|$)/)
          .map(statement => statement.replace(/^\s*--.*$/gm, "").trim())
          .filter(Boolean)
          .map(statement => db.prepare(statement));
        await db.batch(statements);
        continue;
      }
      if (migration === "0104_service_request_thread.sql")
        await db.prepare("UPDATE client_service_requests SET poi_points_json='also-not-json' WHERE id='migration-invalid-json'").run();
      for (const statement of sql.split(/;\s*(?:\n|$)/)) {
        const executable = statement.replace(/^\s*--.*$/gm, "").trim();
        if (!executable || /^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(executable)) continue;
        await db.prepare(executable).run();
      }
    }
    await db.prepare("PRAGMA foreign_keys = ON").run();

    await db.batch([
      db.prepare("INSERT INTO client_accounts (id,display_name,status) VALUES ('account-a','Acme Surveying','active')"),
      db.prepare("INSERT INTO client_accounts (id,display_name,status) VALUES ('account-b','Other Client','active')"),
      db.prepare("INSERT INTO client_identity_links (id,account_id,issuer,subject,email) VALUES ('identity-a','account-a',?,?,?)")
        .bind(principal.issuer, principal.subject, principal.email),
      db.prepare("INSERT INTO client_identity_links (id,account_id,issuer,subject,email) VALUES ('identity-b','account-b',?,?,?)")
        .bind(otherPrincipal.issuer, otherPrincipal.subject, otherPrincipal.email),
      db.prepare("INSERT INTO client_account_members (account_id,identity_id,role) VALUES ('account-a','identity-a','manager')"),
      db.prepare("INSERT INTO client_account_members (account_id,identity_id,role) VALUES ('account-b','identity-b','manager')"),
      db.prepare("INSERT INTO projects (id,external_ref,client_name,project_name,r2_prefix) VALUES ('project-a','ALPHA-1','Acme','North Site','clients/acme/north/')"),
      db.prepare("INSERT INTO projects (id,external_ref,client_name,project_name,r2_prefix) VALUES ('project-b','BETA-1','Other Client','Hidden Site','clients/other/hidden/')"),
      db.prepare("INSERT INTO shares (id,project_id,token_hash,label,created_by_type,created_by_id,public_id,share_version) VALUES ('share-a','project-a','token-hash-a','Final deliverables','staff','staff-owner','public-a',1)"),
      db.prepare("INSERT INTO client_project_grants (account_id,project_id,can_request_service) VALUES ('account-a','project-a',1)"),
      db.prepare("INSERT INTO client_delivery_grants (account_id,project_id,share_id,share_version) VALUES ('account-a','project-a','share-a',1)"),
      db.prepare("INSERT INTO client_service_requests (id,account_id,project_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status) VALUES ('billing-request','account-a','project-a','identity-a','service','Quoted request','Billing visibility fixture','billing-key-00000000001','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','accepted_linked')"),
      db.prepare("INSERT INTO request_pa_artifacts (id,request_id,artifact_type,project_alpha_artifact_id,document_number,artifact_status,total_minor,currency,verification_fingerprint,verified_at,verified_by) VALUES ('billing-artifact','billing-request','quote','42','Q-0042','approved',125000,'USD','verified-fingerprint','2026-08-01T12:00:00Z','staff-owner')"),
      db.prepare("INSERT INTO client_folder_associations (id,scope_type,project_id,account_id,r2_prefix,created_by) VALUES ('folder-project-a','project','project-a','account-a','clients/acme/north/','staff-owner')"),
      db.prepare("INSERT INTO client_folder_associations (id,scope_type,project_id,account_id,r2_prefix,created_by) VALUES ('folder-project-percent','project','project-a','account-a','clients/acme/%/','staff-owner')"),
      db.prepare("INSERT INTO client_folder_associations (id,scope_type,project_id,account_id,r2_prefix,created_by) VALUES ('folder-project-case','project','project-a','account-a','clients/acme/Case/','staff-owner')"),
      db.prepare("INSERT INTO client_folder_associations (id,scope_type,project_id,account_id,r2_prefix,created_by) VALUES ('folder-client-a','client',NULL,'account-a','clients/acme/archive/','staff-owner')"),
      db.prepare("INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES ('clients/acme/north/report.pdf','etag-report',123,'2026-08-01T12:00:00Z','application/pdf','pdf')"),
      db.prepare("INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES ('clients/acme/archive/old.txt','etag-old',12,'2026-07-01T12:00:00Z','text/plain','text')"),
      db.prepare("INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES ('clients/acme/%/literal.txt','etag-literal',10,'2026-08-01T12:00:00Z','text/plain','text')"),
      db.prepare("INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES ('clients/acme/x/wildcard-leak.txt','etag-wildcard',10,'2026-08-01T12:00:00Z','text/plain','text')"),
      db.prepare("INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES ('clients/acme/Case/exact.txt','etag-case',10,'2026-08-01T12:00:00Z','text/plain','text')"),
      db.prepare("INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES ('clients/acme/case/case-leak.txt','etag-case-leak',10,'2026-08-01T12:00:00Z','text/plain','text')"),
      db.prepare("INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES ('clients/other/hidden/secret.pdf','etag-secret',44,'2026-08-01T12:00:00Z','application/pdf','pdf')"),
    ]);

    bucketGetKeys = [];
    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: portalOrigin,
      ENVIRONMENT: "development",
      PUBLIC_BULK_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
      DATA_BUCKET: {
        get: async (key: string) => {
          bucketGetKeys.push(key);
          return key === "clients/acme/north/report.pdf" ? {
            body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("report")); controller.close(); } }),
            httpEtag: '"etag-report"',
            writeHttpMetadata(headers: Headers) { headers.set("Content-Type", "application/pdf"); },
          } : null;
        },
      } as unknown as R2Bucket,
    } as Env;
  }, 30_000);

  afterAll(async () => {
    await miniflare.dispose();
  });

  function portal() {
    return createClientPortalRouter({
      resolvePrincipal: async () => principal,
      repository: d1ClientPortalRepository,
    });
  }

  function portalFor(resolvedPrincipal: VerifiedClientPrincipal | null) {
    return createClientPortalRouter({
      resolvePrincipal: async () => resolvedPrincipal,
      repository: d1ClientPortalRepository,
    });
  }

  it("applies the complete migration chain without granting implicit access", async () => {
    const migrationTables = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (
      'client_accounts','client_account_members','client_access_sync_outbox','client_portal_notification_outbox',
      'client_folder_grant_mutations','client_folder_grant_notifications','client_service_request_drafts',
      'client_service_request_area_revisions','client_service_request_attachments','request_pa_draft_quote_receipts',
      'portal_v2_workspaces','pa_service_catalog_generations','portal_v2_invitation_commands',
      'client_delegated_shares','pa_portal_projection_generations','delivery_share_audience_snapshots',
      'delivery_share_recipient_members'
    ) ORDER BY name`).all<{ name: string }>();
    expect(migrationTables.results.map(row => row.name)).toEqual([
      "client_access_sync_outbox",
      "client_account_members",
      "client_accounts",
      "client_delegated_shares",
      "client_folder_grant_mutations",
      "client_folder_grant_notifications",
      "client_portal_notification_outbox",
      "client_service_request_area_revisions",
      "client_service_request_attachments",
      "client_service_request_drafts",
      "delivery_share_audience_snapshots",
      "delivery_share_recipient_members",
      "pa_portal_projection_generations",
      "pa_service_catalog_generations",
      "portal_v2_invitation_commands",
      "portal_v2_workspaces",
      "request_pa_draft_quote_receipts",
    ]);
    expect(await d1ClientPortalRepository.resolveSession(env, { ...principal, subject: "not-provisioned" })).toBeNull();
    expect(await db.prepare("SELECT status FROM client_service_requests WHERE id='migration-request'").first("status")).toBe("accepted_pending_pa_linkage");
    expect(await db.prepare("SELECT status_value FROM client_portal_notification_outbox WHERE id='migration-notification'").first("status_value")).toBe("accepted_pending_pa_linkage");
    expect(await db.prepare("SELECT json_extract(snapshot_json,'$.areaGeoJson') area,json_array_length(json_extract(snapshot_json,'$.poiPoints')) points FROM request_revisions WHERE request_id='migration-invalid-json'").first()).toMatchObject({ area: null, points: 0 });
    expect(await db.prepare("SELECT json_extract(payload_json,'$.legacyPayloadDiscarded') discarded FROM client_portal_notification_outbox WHERE id='migration-invalid-payload'").first("discarded")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='client_service_request_area_revisions'").first("count")).toBe(1);
    expect((await db.prepare("PRAGMA table_info(request_pa_artifacts)").all<{ name: string }>()).results.map(column => column.name))
      .toEqual(expect.arrayContaining(["scope_stale_at", "scope_stale_area_revision_id"]));
    expect((await db.prepare("PRAGMA table_info(request_pa_draft_quote_receipts)").all<{ name: string }>()).results.map(column => column.name))
      .toContain("scope_stale_at");
    await db.prepare(`INSERT INTO client_service_request_area_revisions
      (id,request_id,revision_number,base_request_updated_at,area_geojson,poi_points_json,reason,change_summary,created_by,mutation_key,mutation_fingerprint)
      VALUES ('migration-area-revision','migration-request',1,'2026-08-01T12:00:00Z',NULL,'[]','Boundary reviewed','service-area boundary removed','staff-test','migration-area-key-0001',?)`)
      .bind("a".repeat(64)).run();
    await expect(db.prepare("UPDATE client_service_request_area_revisions SET reason='Changed in place' WHERE id='migration-area-revision'").run())
      .rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM client_service_request_area_revisions WHERE id='migration-area-revision'").run())
      .rejects.toThrow(/immutable/);
    await db.prepare(`INSERT INTO request_pa_draft_quote_receipts
      (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,
       project_alpha_receipt_id,project_alpha_artifact_public_id,artifact_status,
       artifact_version,editor_path,created_by)
      VALUES ('migration-pa-receipt','migration-request',1,0,'migration-pa-receipt-key-0001',?,
        'pa-receipt-public','pa-artifact-public','draft',1,'/drafts/pa-artifact-public','staff-test')`)
      .bind("b".repeat(64)).run();
    await expect(db.prepare("UPDATE request_pa_draft_quote_receipts SET editor_path='/changed' WHERE id='migration-pa-receipt'").run())
      .rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM request_pa_draft_quote_receipts WHERE id='migration-pa-receipt'").run())
      .rejects.toThrow(/immutable/);
    const triggerNames = (await db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
      'client_request_area_revisions_no_update','client_request_area_revisions_no_delete',
      'trg_client_request_attachment_submit_guard','trg_client_request_attachment_link_submission',
      'trg_client_request_attachment_linked_update_guard','trg_client_request_attachment_linked_delete_guard',
      'trg_request_pa_draft_quote_receipts_no_update','trg_request_pa_draft_quote_receipts_no_delete',
      'portal_v2_checkpoint_requires_complete_generation_insert',
      'portal_v2_checkpoint_requires_complete_generation_update',
      'portal_v2_checkpoint_prevents_out_of_order_update',
      'trg_delivery_share_audience_snapshots_no_update',
      'trg_delivery_share_audience_snapshots_no_delete',
      'trg_delivery_share_recipient_members_no_update',
      'trg_delivery_share_recipient_members_no_delete'
    ) ORDER BY name`).all<{ name: string }>()).results.map(row => row.name);
    expect(triggerNames).toHaveLength(15);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await expect(db.prepare("INSERT INTO client_portal_notification_outbox (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json) VALUES ('migration-linked','migration-request','request_status_changed','accepted_linked','client_requester','request_status_changed:accepted_linked:client_requester','{}')").run()).resolves.toBeTruthy();
    await expect(db.prepare("INSERT INTO client_portal_notification_outbox (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json) VALUES ('migration-area-notice','migration-request','request_work_area_changed','under_review','client_requester','request_work_area_changed:migration-area-revision:client_requester','{}')").run()).resolves.toBeTruthy();
    await expect(db.prepare("INSERT INTO client_portal_notification_outbox (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json) VALUES ('migration-orphan','missing-request','request_status_changed','completed','client_requester','request_status_changed:completed:client_requester','{}')").run()).rejects.toThrow();
  });

  it("resolves a live Access subject and enforces account, project, delivery, and share grants", async () => {
    const sessionResponse = await portal().request(`${portalOrigin}/session`, {}, env);
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({
      account: { id: "account-a", displayName: "Acme Surveying" },
      capabilities: { manageTeam: false, viewBilling: false },
    });

    const projectResponse = await portal().request(`${portalOrigin}/projects`, {}, env);
    expect(projectResponse.status).toBe(200);
    expect(await projectResponse.json()).toMatchObject({ projects: [{ id: "project-a", canRequestService: true }] });

    const deliveryResponse = await portal().request(`${portalOrigin}/projects/project-a/deliveries`, {}, env);
    expect(deliveryResponse.status).toBe(200);
    expect(await deliveryResponse.json()).toMatchObject({ deliveries: [{ shareId: "share-a", publicId: "public-a", shareVersion: 1 }] });

    await db.prepare("UPDATE shares SET share_version=2 WHERE id='share-a'").run();
    const staleGrantResponse = await portal().request(`${portalOrigin}/projects/project-a/deliveries`, {}, env);
    expect(await staleGrantResponse.json()).toEqual({ deliveries: [] });
    await db.prepare("UPDATE shares SET share_version=1 WHERE id='share-a'").run();
  });

  it("issues only authorization-bound file paths and reauthorizes before every controlled download", async () => {
    const projectFiles = await portal().request(`${portalOrigin}/projects/project-a/files`, {}, env);
    expect(projectFiles.status).toBe(200);
    const projectBody = await projectFiles.json() as { files: Array<{ id: string; key: string; downloadPath: string }> };
    expect(projectBody.files.map(file => file.key)).toEqual([
      "clients/acme/%/literal.txt",
      "clients/acme/Case/exact.txt",
      "clients/acme/north/report.pdf",
    ]);

    const archive = await portal().request(`${portalOrigin}/past-deliveries`, {}, env);
    const archiveBody = await archive.json() as { files: Array<{ key: string; downloadPath: string }> };
    expect(archiveBody.files.map(file => file.key)).toEqual(["clients/acme/archive/old.txt"]);

    const reportFile = projectBody.files.find(file => file.key === "clients/acme/north/report.pdf")!;
    const issuedUrl = new URL(reportFile.downloadPath, portalOrigin);
    expect(issuedUrl.origin).toBe(portalOrigin);
    expect(issuedUrl.pathname).toMatch(/^\/api\/client\/files\/[A-Za-z0-9_-]+\/download$/);
    expect([...issuedUrl.searchParams]).toEqual([["projectId", "project-a"]]);
    expect(issuedUrl.searchParams.has("signature")).toBe(false);
    expect(issuedUrl.searchParams.has("expires")).toBe(false);

    const routePath = reportFile.downloadPath.replace(/^\/api\/client/, "");
    const served = await portal().request(`${portalOrigin}${routePath}`, {}, env);
    expect(served.status).toBe(200);
    expect(served.headers.get("Cache-Control")).toBe("private, no-store");
    expect(served.headers.get("Content-Disposition")).toContain("attachment");
    expect(await served.text()).toBe("report");
    expect(bucketGetKeys).toContain("clients/acme/north/report.pdf");

    bucketGetKeys.length = 0;
    const otherClientListing = await portalFor(otherPrincipal).request(`${portalOrigin}/projects/project-a/files`, {}, env);
    expect(otherClientListing.status).toBe(404);
    const otherClientDownload = await portalFor(otherPrincipal).request(`${portalOrigin}${routePath}`, {}, env);
    expect(otherClientDownload.status).toBe(404);

    const unauthenticatedDownload = await portalFor(null).request(`${portalOrigin}${routePath}`, {}, env);
    expect(unauthenticatedDownload.status).toBe(401);
    expect(bucketGetKeys).toEqual([]);

    const withoutProjectGrant = await portal().request(`${portalOrigin}${routePath.replace("?projectId=project-a", "")}`, {}, env);
    expect(withoutProjectGrant.status).toBe(404);
    expect(bucketGetKeys).toEqual([]);

    const archiveRoutePath = archiveBody.files[0]!.downloadPath.replace(/^\/api\/client/, "");
    await db.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now') WHERE id='folder-client-a'").run();
    const revokedClientFolderDownload = await portal().request(`${portalOrigin}${archiveRoutePath}`, {}, env);
    expect(revokedClientFolderDownload.status).toBe(404);
    expect(bucketGetKeys).toEqual([]);
    await db.prepare("UPDATE client_folder_associations SET revoked_at=NULL WHERE id='folder-client-a'").run();

    await db.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now') WHERE id='folder-project-a'").run();
    const revokedFolderDownload = await portal().request(`${portalOrigin}${routePath}`, {}, env);
    expect(revokedFolderDownload.status).toBe(404);
    expect(bucketGetKeys).toEqual([]);
    await db.prepare("UPDATE client_folder_associations SET revoked_at=NULL WHERE id='folder-project-a'").run();

    await db.prepare("UPDATE client_project_grants SET revoked_at=datetime('now') WHERE account_id='account-a' AND project_id='project-a'").run();
    const revokedProjectDownload = await portal().request(`${portalOrigin}${routePath}`, {}, env);
    expect(revokedProjectDownload.status).toBe(404);
    expect(bucketGetKeys).toEqual([]);
    await db.prepare("UPDATE client_project_grants SET revoked_at=NULL WHERE account_id='account-a' AND project_id='project-a'").run();

    await db.prepare(`INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,deleted_by,purge_after)
      VALUES('portal-tombstone','clients/acme/north/report.pdf','exact','staff-owner',datetime('now','+7 days'))`).run();
    const trashedListing = await portal().request(`${portalOrigin}/projects/project-a/files`, {}, env);
    expect((await trashedListing.json() as { files: Array<{ key: string }> }).files.map(file => file.key))
      .not.toContain("clients/acme/north/report.pdf");
    const trashedDownload = await portal().request(`${portalOrigin}${routePath}`, {}, env);
    expect(trashedDownload.status).toBe(404);
    expect(bucketGetKeys).toEqual([]);

    await db.prepare("UPDATE delivery_tombstones SET restored_at=datetime('now'),restored_by='staff-owner' WHERE id='portal-tombstone'").run();
    const restoredDownload = await portal().request(`${portalOrigin}${routePath}`, {}, env);
    expect(restoredDownload.status).toBe(200);
    expect(bucketGetKeys).toEqual(["clients/acme/north/report.pdf"]);
  });

  it("creates an idempotent request and durable staff-notification/audit records", async () => {
    const request = () => portal().request(`${portalOrigin}/service-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "portal-e2e-request-0001",
        Origin: portalOrigin,
      },
      body: JSON.stringify({
        projectId: "project-a",
        requestType: "flight",
        title: "North site flight",
        details: "Capture current grading progress.",
        location: "North site",
        preferredStartAt: "2026-08-10T15:00:00.000Z",
      }),
    }, env);

    const created = await request();
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { request: { id: string } };
    expect(createdBody.request.id).toBeTruthy();

    const replayed = await request();
    expect(replayed.status).toBe(200);
    expect((await replayed.json() as { request: { id: string } }).request.id).toBe(createdBody.request.id);

    const requestCount = await db.prepare("SELECT COUNT(*) AS count FROM client_service_requests WHERE account_id='account-a' AND idempotency_key='portal-e2e-request-0001'").first<{ count: number }>();
    const notificationCount = await db.prepare("SELECT COUNT(*) AS count FROM client_portal_notification_outbox WHERE request_id=? AND event_type='request_submitted' AND recipient_kind='staff_triage'").bind(createdBody.request.id).first<{ count: number }>();
    const auditCount = await db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='client.service_request.submitted'").first<{ count: number }>();
    expect(requestCount?.count).toBe(1);
    expect(notificationCount?.count).toBe(1);
    expect(auditCount?.count).toBe(1);
  });

  it("edits submitted work idempotently, creates one child revision, and records one estimate response", async () => {
    const baseInput = {
      projectId: "project-a",
      requestType: "service",
      title: "Model update",
      details: "Update the current site model.",
      location: "North site",
      preferredStartAt: null,
      poiPoints: [],
    };
    const createdResponse = await portal().request(`${portalOrigin}/service-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "portal-e2e-edit-base-0001", Origin: portalOrigin },
      body: JSON.stringify(baseInput),
    }, env);
    const created = (await createdResponse.json() as { request: { id: string; updatedAt: string } }).request;
    const editedInput = { ...baseInput, title: "Updated model and contours", details: "Update the site model and deliver current contours." };
    const edit = () => portal().request(`${portalOrigin}/service-requests/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "portal-e2e-edit-mutation-0001",
        "If-Match": created.updatedAt,
        Origin: portalOrigin,
      },
      body: JSON.stringify(editedInput),
    }, env);
    expect((await edit()).status).toBe(200);
    expect((await edit()).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) count FROM request_revisions WHERE request_id=? AND action='client_edit'").bind(created.id).first("count")).toBe(1);

    await db.prepare("UPDATE client_service_requests SET status='under_review' WHERE id=?").bind(created.id).run();
    const changeInput = { ...editedInput, title: "Add east parcel", details: "Include the east parcel in the reviewed scope.", parentRequestId: created.id };
    const change = () => portal().request(`${portalOrigin}/service-requests/${created.id}/change-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "portal-e2e-child-change-0001", Origin: portalOrigin },
      body: JSON.stringify(changeInput),
    }, env);
    expect((await change()).status).toBe(201);
    expect((await change()).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_service_requests WHERE parent_request_id=?").bind(created.id).first("count")).toBe(1);

    await db.prepare("INSERT INTO request_operational_estimates(id,request_id,version,scope_text,status,created_by,mutation_key,mutation_fingerprint) VALUES ('estimate-e2e',?,1,'Update model and contours','ready','staff-reviewer','staff-estimate-e2e-0001',?)")
      .bind(created.id, "d".repeat(64)).run();
    const respond = () => portal().request(`${portalOrigin}/service-requests/${created.id}/estimate-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "portal-e2e-estimate-response-0001", Origin: portalOrigin },
      body: JSON.stringify({ estimateId: "estimate-e2e", response: "accept", note: null }),
    }, env);
    expect((await respond()).status).toBe(200);
    expect((await respond()).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) count FROM request_revisions WHERE request_id=? AND action='client_response'").bind(created.id).first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_portal_notification_outbox WHERE request_id=? AND event_type='request_client_response'").bind(created.id).first("count")).toBe(1);
    const responsePayload = await db.prepare("SELECT payload_json FROM client_portal_notification_outbox WHERE request_id=? AND event_type='request_client_response'").bind(created.id).first<{ payload_json: string }>();
    const responsePresentation = JSON.parse(responsePayload!.payload_json);
    expect(responsePresentation).toMatchObject({ presentationVersion: 1, lifecycle: "client_response_received", action: "review_in_operations" });
    expect(JSON.stringify(responsePresentation)).not.toMatch(/estimate-e2e|amount|currency|quote|invoice|billing|site_contact/i);
  });

  it("enforces billing visibility on verified quote summaries server-side", async () => {
    const hidden = await portal().request(`${portalOrigin}/service-requests`, {}, env);
    const hiddenRequest = (await hidden.json() as { requests: Array<{ id: string; acceptedQuote: unknown }> }).requests.find(request => request.id === "billing-request");
    expect(hiddenRequest?.acceptedQuote).toBeNull();

    await db.prepare("UPDATE client_account_members SET can_view_billing=1 WHERE account_id='account-a' AND identity_id='identity-a'").run();
    const visible = await portal().request(`${portalOrigin}/service-requests`, {}, env);
    const visibleRequest = (await visible.json() as { requests: Array<{ id: string; acceptedQuote: { documentNumber: string; total: number } | null }> }).requests.find(request => request.id === "billing-request");
    expect(visibleRequest?.acceptedQuote).toMatchObject({ documentNumber: "Q-0042", total: 1250 });
    await db.prepare("UPDATE client_account_members SET can_view_billing=0 WHERE account_id='account-a' AND identity_id='identity-a'").run();
  });

  it("autosaves and idempotently submits a versioned multi-service draft with immutable catalog snapshots", async () => {
    await db.prepare(`INSERT INTO pa_service_catalog_items(public_id,source_version,name,summary,question_schema_json,source_updated_at)
      VALUES ('svc-2d-map','pa-v4','2D Mapping','Orthomosaic and map products',?, '2026-08-13T12:00:00Z')`)
      .bind(JSON.stringify([{ id: "resolution", label: "Resolution", type: "select", required: true, options: [{ value: "standard", label: "Standard" }] }])).run();
    const areaGeoJson = { type: "Polygon", coordinates: [[[-88, 44], [-87.99, 44], [-87.99, 44.01], [-88, 44.01], [-88, 44]]] };
    const input = {
      projectId: "project-a", requestType: "service", title: "Map the site", details: "Capture the current construction area.",
      location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
      siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson, poiPoints: [],
      services: [{ publicId: "svc-2d-map", answers: { resolution: "standard" } }],
    };
    const create = () => portal().request(`${portalOrigin}/service-request-drafts`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "portal-draft-create-0001", Origin: portalOrigin }, body: JSON.stringify(input),
    }, env);
    const created = await create();
    expect(created.status).toBe(201);
    const createdDraft = (await created.json() as { draft: { id: string; version: number; areaSquareMeters: number; areaAcres: number } }).draft;
    expect(createdDraft.areaSquareMeters).toBeGreaterThan(880_000);
    expect(createdDraft.areaAcres).toBeGreaterThan(217);
    expect((await create()).status).toBe(200);

    await db.prepare("UPDATE pa_service_catalog_items SET source_version='pa-v5',name='Renamed mapping' WHERE public_id='svc-2d-map'").run();
    const storedDraftService = await db.prepare("SELECT service_source_version,json_extract(service_snapshot_json,'$.name') name FROM client_service_request_draft_services WHERE draft_id=?").bind(createdDraft.id).first<{ service_source_version: string; name: string }>();
    expect(storedDraftService).toEqual({ service_source_version: "pa-v4", name: "2D Mapping" });

    const submit = () => portal().request(`${portalOrigin}/service-request-drafts/${createdDraft.id}/submit`, {
      method: "POST", headers: { "Idempotency-Key": "portal-draft-submit-0001", "If-Match": String(createdDraft.version), Origin: portalOrigin },
    }, env);
    expect((await submit()).status).toBe(422);
    await db.prepare("UPDATE pa_service_catalog_items SET source_version='pa-v4',name='2D Mapping' WHERE public_id='svc-2d-map'").run();
    const submitted = await submit();
    expect(submitted.status).toBe(201);
    const requestId = (await submitted.json() as { request: { id: string } }).request.id;
    expect((await submit()).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_service_requests WHERE id=?").bind(requestId).first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_service_request_services WHERE request_id=? AND service_public_id='svc-2d-map' AND service_source_version='pa-v4'").bind(requestId).first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM request_revisions WHERE request_id=? AND action='submitted'").bind(requestId).first("count")).toBe(1);
  });

  it("hides stored service-request notifications after project access is revoked", async () => {
    await db.batch([
      db.prepare("UPDATE client_account_members SET role='member' WHERE account_id='account-a' AND identity_id='identity-a'"),
      db.prepare("INSERT INTO client_member_project_grants(account_id,identity_id,project_id,granted_by_identity_id) VALUES('account-a','identity-a','project-a','identity-a')"),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES ('project-notice','account-a','identity-a','request_status','service_request','billing-request','project-notice-key','Project update','A request changed.','/portal/requests')`),
    ]);
    const visible = await portal().request(`${portalOrigin}/notifications`, {}, env);
    expect((await visible.json() as any).notifications.map((item: any) => item.id)).toContain("project-notice");

    await db.prepare("UPDATE client_member_project_grants SET revoked_at=datetime('now') WHERE account_id='account-a' AND identity_id='identity-a' AND project_id='project-a'").run();
    const hidden = await portal().request(`${portalOrigin}/notifications`, {}, env);
    expect((await hidden.json() as any).notifications.map((item: any) => item.id)).not.toContain("project-notice");

    await db.batch([
      db.prepare("DELETE FROM client_portal_notifications WHERE id='project-notice'"),
      db.prepare("DELETE FROM client_member_project_grants WHERE account_id='account-a' AND identity_id='identity-a' AND project_id='project-a'"),
      db.prepare("UPDATE client_account_members SET role='manager' WHERE account_id='account-a' AND identity_id='identity-a'"),
    ]);
  });

  it("keeps the incomplete invitation workflow unavailable in the pilot", async () => {
    const invitationResponse = await portal().request(`${portalOrigin}/team/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: portalOrigin },
      body: JSON.stringify({ email: "member@example.com", projectIds: ["project-a"] }),
    }, env);
    expect(invitationResponse.status).toBe(404);
    const outbox = await db.prepare("SELECT COUNT(*) count FROM client_access_sync_outbox").first<{ count: number }>();
    expect(outbox?.count).toBe(0);
  });
});
