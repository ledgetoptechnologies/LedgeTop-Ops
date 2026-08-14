import migration from "../migrations/0119_client_request_attachments.sql?raw";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { acceptRequestAttachmentScanReceipt } from "../src/worker/client-portal/request-attachments";
import type { ClientPortalRepository, ClientPortalSession, ResolveClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const origin = "https://client.test";
const manager: ClientPortalSession = { accountId: "account-a", identityId: "identity-a", displayName: "Acme", role: "manager", canViewBilling: false };
const otherManager: ClientPortalSession = { accountId: "account-b", identityId: "identity-b", displayName: "Other", role: "manager", canViewBilling: false };
const principal: ResolveClientPrincipal = vi.fn(async request => ({ issuer: "https://issuer.test", subject: request.headers.get("X-Test-Subject") || "subject-a", email: "client@example.test" }));

function repository(): ClientPortalRepository {
  return {
    resolveSession: vi.fn(async (_env, resolved) => resolved.subject === "subject-b" ? otherManager : manager),
    listProjects: vi.fn(async () => []), getProject: vi.fn(async () => null), listProjectFiles: vi.fn(async () => null),
    listPastDeliveries: vi.fn(async () => ({ files: [], prefix: "", cursor: null })), listProjectFileLocations: vi.fn(async () => null),
    listPastDeliveryLocations: vi.fn(async () => ({ points: [], imageCount: 0, truncated: false })), getAuthorizedFile: vi.fn(async () => null),
    listDeliveries: vi.fn(async () => []), getDeliveryHandoff: vi.fn(async () => null), listNotifications: vi.fn(async () => ({ notifications: [], unreadCount: 0, cursor: null })),
    updateNotification: vi.fn(async () => false), listServiceRequests: vi.fn(async () => []), getServiceRequest: vi.fn(async () => null),
    createServiceRequest: vi.fn(async () => null), updateServiceRequest: vi.fn(async () => null), createChangeRequest: vi.fn(async () => null),
    listMembers: vi.fn(async () => []), listInvitations: vi.fn(async () => []), createInvitation: vi.fn(async () => null),
    revokeMember: vi.fn(async () => false), revokeInvitation: vi.fn(async () => false),
  };
}

describe("request attachment D1 and direct-R2 lifecycle", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;
  let completedSize = 0;
  const uploadCalls: string[] = [];
  const etag = "a".repeat(32);

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-16", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };", d1Databases: { DELIVERY_DB: "request-attachment-e2e" } });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT,status TEXT);
      CREATE TABLE client_identity_links(id TEXT,account_id TEXT,issuer TEXT,subject TEXT,email TEXT,revoked_at TEXT,PRIMARY KEY(id),UNIQUE(id,account_id));
      CREATE TABLE client_account_members(account_id TEXT,identity_id TEXT,role TEXT,revoked_at TEXT,PRIMARY KEY(account_id,identity_id));
      CREATE TABLE projects(id TEXT PRIMARY KEY,active INTEGER DEFAULT 1);
      CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,can_request_service INTEGER,revoked_at TEXT,PRIMARY KEY(account_id,project_id));
      CREATE TABLE client_member_project_grants(account_id TEXT,identity_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,identity_id,project_id));
      CREATE TABLE client_service_requests(id TEXT PRIMARY KEY);
      CREATE TABLE client_service_request_drafts(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,created_by_identity_id TEXT,state TEXT,submitted_request_id TEXT);
    `);
    await db.exec(migration.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
    await db.batch([
      db.prepare("INSERT INTO client_accounts VALUES ('account-a','Acme','active')"), db.prepare("INSERT INTO client_accounts VALUES ('account-b','Other','active')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES ('identity-a','account-a','issuer','a','a@example.test')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES ('identity-b','account-b','issuer','b','b@example.test')"),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('account-a','identity-a','manager')"),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('account-b','identity-b','manager')"),
      db.prepare("INSERT INTO client_service_request_drafts VALUES ('draft-a','account-a',NULL,'identity-a','draft',NULL)"),
    ]);
    const bucket = {
      async createMultipartUpload(key: string) {
        uploadCalls.push(`create:${key}`);
        return { key, uploadId: "r2-upload-a", async uploadPart() { throw new Error("Worker must not upload source bytes"); }, async abort() { uploadCalls.push("abort"); }, async complete() { throw new Error("use resumed upload"); } };
      },
      resumeMultipartUpload(key: string, uploadId: string) {
        return { key, uploadId, async uploadPart() { throw new Error("Worker must not upload source bytes"); }, async abort() { uploadCalls.push("abort"); }, async complete() {
          uploadCalls.push("complete"); completedSize = 10;
          return { key, size: 10, etag, httpEtag: `"${etag}"` };
        } };
      },
      async get(key: string) { return completedSize ? { key, size: completedSize, etag, httpEtag: `"${etag}"`, arrayBuffer: async () => new TextEncoder().encode("%PDF-test").buffer,
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("%PDF-test")); controller.close(); } }) } : null; },
      async head() { return completedSize ? { size: completedSize, etag, httpEtag: `"${etag}"` } : null; }, async delete() { completedSize = 0; },
    } as unknown as R2Bucket;
    env = { DELIVERY_DB: db, DATA_BUCKET: bucket, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_REQUEST_ATTACHMENTS_ENABLED: "true", CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET: "s".repeat(32), CLIENT_PORTAL_ORIGIN: origin,
      ENVIRONMENT: "development", R2_S3_ENDPOINT: "https://846c924bf17bf4f3dd15c97a4c5d1d51.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "client-data", CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID: "attachment-access",
      CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY: "attachment-secret".repeat(4),
      R2_ACCESS_KEY_ID: "download-only-access", R2_SECRET_ACCESS_KEY: "download-only-secret".repeat(4) } as Env;
  }, 30_000);

  afterAll(async () => { await miniflare.dispose(); });

  it("authorizes the draft, sends no source body through Worker, quarantines, scans, and immutably links", async () => {
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository() });
    const init = await app.request(`${origin}/service-request-drafts/draft-a/attachments`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ clientUploadId: "upload-client-0001", name: "authorization.pdf", contentType: "application/pdf", size: 10 }) }, env);
    expect(init.status).toBe(201);
    const created = await init.json() as { attachmentId: string };
    expect(uploadCalls).toHaveLength(1);

    const denied = await app.request(`${origin}/service-request-drafts/draft-a/attachments/${created.attachmentId}`, { headers: { "X-Test-Subject": "subject-b" } }, env);
    expect(denied.status).toBe(404);

    const ticket = await app.request(`${origin}/service-request-drafts/draft-a/attachments/${created.attachmentId}/part-ticket`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ partNumber: 1 }) }, env);
    expect(ticket.status).toBe(200);
    expect(await ticket.json()).toMatchObject({ method: "PUT", contentLength: 10, contentType: "application/pdf" });
    expect(uploadCalls).toHaveLength(1);

    const checkpoint = await app.request(`${origin}/service-request-drafts/draft-a/attachments/${created.attachmentId}/parts/1`, { method: "PUT", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ etag, size: 10 }) }, env);
    expect(checkpoint.status).toBe(200);
    const complete = await app.request(`${origin}/service-request-drafts/draft-a/attachments/${created.attachmentId}/complete`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ partNumber: 1, etag }] }) }, env);
    expect(await complete.json()).toMatchObject({ status: "quarantined" });
    await expect(db.prepare("UPDATE client_service_request_drafts SET state='submitted' WHERE id='draft-a'").run()).rejects.toThrow(/scan-complete/);

    expect(await acceptRequestAttachmentScanReceipt(env, `Bearer ${"s".repeat(32)}`, created.attachmentId, { verdict: "clean", sha256: "b".repeat(64) })).toBe("accepted");
    await db.prepare("INSERT INTO client_service_requests(id) VALUES ('request-a')").run();
    await db.prepare("UPDATE client_service_request_drafts SET state='submitted',submitted_request_id='request-a' WHERE id='draft-a'").run();
    expect(await db.prepare("SELECT submitted_request_id FROM client_service_request_attachments WHERE id=?").bind(created.attachmentId).first("submitted_request_id")).toBe("request-a");
    await expect(db.prepare("UPDATE client_service_request_attachments SET original_name='changed.pdf' WHERE id=?").bind(created.attachmentId).run()).rejects.toThrow(/immutable/);
  });
});
