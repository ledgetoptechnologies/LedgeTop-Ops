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

describe("client portal migrated-D1 end-to-end contract", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

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
      for (const statement of sql.split(/;\s*(?:\n|$)/)) {
        const executable = statement.replace(/^\s*--.*$/gm, "").trim();
        if (!executable || /^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(executable)) continue;
        await db.prepare(executable).run();
      }
    }

    await db.batch([
      db.prepare("INSERT INTO client_accounts (id,display_name,status) VALUES ('account-a','Acme Surveying','active')"),
      db.prepare("INSERT INTO client_identity_links (id,account_id,issuer,subject,email) VALUES ('identity-a','account-a',?,?,?)")
        .bind(principal.issuer, principal.subject, principal.email),
      db.prepare("INSERT INTO client_account_members (account_id,identity_id,role) VALUES ('account-a','identity-a','manager')"),
      db.prepare("INSERT INTO projects (id,external_ref,client_name,project_name,r2_prefix) VALUES ('project-a','ALPHA-1','Acme','North Site','clients/acme/north/')"),
      db.prepare("INSERT INTO projects (id,external_ref,client_name,project_name,r2_prefix) VALUES ('project-b','BETA-1','Other Client','Hidden Site','clients/other/hidden/')"),
      db.prepare("INSERT INTO shares (id,project_id,token_hash,label,created_by_type,created_by_id,public_id,share_version) VALUES ('share-a','project-a','token-hash-a','Final deliverables','staff','staff-owner','public-a',1)"),
      db.prepare("INSERT INTO client_project_grants (account_id,project_id,can_request_service) VALUES ('account-a','project-a',1)"),
      db.prepare("INSERT INTO client_delivery_grants (account_id,project_id,share_id,share_version) VALUES ('account-a','project-a','share-a',1)"),
    ]);

    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: portalOrigin,
      ENVIRONMENT: "development",
      PUBLIC_BULK_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
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

  it("applies the complete migration chain without granting implicit access", async () => {
    const migrationTables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('client_accounts','client_account_members','client_access_sync_outbox','client_portal_notification_outbox') ORDER BY name").all<{ name: string }>();
    expect(migrationTables.results.map(row => row.name)).toEqual([
      "client_access_sync_outbox",
      "client_account_members",
      "client_accounts",
      "client_portal_notification_outbox",
    ]);
    expect(await d1ClientPortalRepository.resolveSession(env, { ...principal, subject: "not-provisioned" })).toBeNull();
  });

  it("resolves a live Access subject and enforces account, project, delivery, and share grants", async () => {
    const sessionResponse = await portal().request(`${portalOrigin}/session`, {}, env);
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({
      account: { id: "account-a", displayName: "Acme Surveying" },
      capabilities: { manageTeam: true, viewBilling: false },
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

    const requestCount = await db.prepare("SELECT COUNT(*) AS count FROM client_service_requests").first<{ count: number }>();
    const notificationCount = await db.prepare("SELECT COUNT(*) AS count FROM client_portal_notification_outbox WHERE event_type='request_submitted' AND recipient_kind='staff_triage'").first<{ count: number }>();
    const auditCount = await db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='client.service_request.submitted'").first<{ count: number }>();
    expect(requestCount?.count).toBe(1);
    expect(notificationCount?.count).toBe(1);
    expect(auditCount?.count).toBe(1);
  });

  it("persists manager invitations and enqueues provision and revoke intents", async () => {
    const invitationResponse = await portal().request(`${portalOrigin}/team/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: portalOrigin },
      body: JSON.stringify({ email: "member@example.com", projectIds: ["project-a"] }),
    }, env);
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json() as { invitation: { id: string } }).invitation;

    const provision = await db.prepare("SELECT action,email,status FROM client_access_sync_outbox WHERE source_type='invite' AND source_id=? AND action='provision'")
      .bind(invitation.id).first<{ action: string; email: string; status: string }>();
    expect(provision).toEqual({ action: "provision", email: "member@example.com", status: "pending" });

    const revoked = await portal().request(`${portalOrigin}/team/invitations/${encodeURIComponent(invitation.id)}`, {
      method: "DELETE",
      headers: { Origin: portalOrigin },
    }, env);
    expect(revoked.status).toBe(204);
    const revoke = await db.prepare("SELECT action,email,status FROM client_access_sync_outbox WHERE source_type='invite' AND source_id=? AND action='revoke'")
      .bind(invitation.id).first<{ action: string; email: string; status: string }>();
    expect(revoke).toEqual({ action: "revoke", email: "member@example.com", status: "pending" });
  });
});
