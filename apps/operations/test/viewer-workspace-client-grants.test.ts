import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";
import { drainViewerSessionRevocations } from "../src/worker/viewer-integration";
import {
  registerViewerProcessingRoutes,
  pruneViewerMachineRateLimits,
  signViewerProcessingEvent,
  viewerMachineHostRequest,
} from "../src/worker/viewer-processing";

const instances: Miniflare[] = [];
const secret = "viewer-client-grant-secret-32-characters-minimum";
const path = "/api/viewer/workspace/client-grants";
let ops: D1Database, delivery: D1Database, env: Env, app: Hono<any>;

async function setup(): Promise<void> {
  const instance = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { OPS_DB: "viewer-client-grant-ops", DELIVERY_DB: "viewer-client-grant-delivery" } });
  instances.push(instance);
  ops = await instance.getD1Database("OPS_DB") as unknown as D1Database;
  delivery = await instance.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await ops.exec(`
    CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,display_name TEXT,access_subject TEXT,project_alpha_user_id TEXT,status TEXT);
    CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
    CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,actor_email TEXT,
      actor_display_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,division_id TEXT,details_json TEXT,
      client_address_hash TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY,active INTEGER,updated_at TEXT);
    CREATE TABLE viewer_event_nonces(key_id TEXT,nonce TEXT,expires_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(key_id,nonce));
    CREATE TABLE viewer_machine_rate_limits(scope TEXT,window_start TEXT,request_count INTEGER,PRIMARY KEY(scope,window_start));
    CREATE TABLE viewer_workspace_client_grant_rate_limits(window_start TEXT PRIMARY KEY,request_count INTEGER CHECK(request_count>=1));
    INSERT INTO staff_users VALUES('staff-one','staff@example.test','Staff One','access-subject-one',NULL,'active');
    INSERT INTO staff_role_assignments VALUES('staff-one','viewer-manager','global',NULL);
    INSERT INTO role_permissions VALUES('viewer-manager','viewer.view');
    INSERT INTO role_permissions VALUES('viewer-manager','viewer.manage');
    INSERT INTO pa_projects VALUES('pa-project-one',1,'2026-08-18T12:00:00.000Z');
  `.replace(/\s*\n\s*/g, " "));
  await delivery.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects(id TEXT PRIMARY KEY,client_name TEXT,project_name TEXT,active INTEGER,
      project_alpha_project_id TEXT,source_updated_at TEXT);
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT,status TEXT);
    CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id));
    CREATE TABLE viewer_model_associations(id TEXT PRIMARY KEY,project_id TEXT,project_alpha_project_id TEXT,
      project_source_version TEXT,viewer_model_id TEXT,viewer_model_version_id TEXT,viewer_resource_version TEXT,
      model_title TEXT,model_provider TEXT,model_status TEXT,state TEXT,association_version INTEGER,
      created_by_staff_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,revoked_by_staff_id TEXT,revoke_reason TEXT);
    CREATE TABLE viewer_client_grants(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,scope_type TEXT,
      association_id TEXT,include_future_published INTEGER,can_measure INTEGER,can_view_cameras INTEGER,can_download INTEGER,
      authorization_expires_at TEXT,grant_version INTEGER DEFAULT 1,status TEXT DEFAULT 'active',created_by_staff_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,revoked_at TEXT,
      revoked_by_staff_id TEXT,revoke_reason TEXT);
    CREATE UNIQUE INDEX live_viewer_grant ON viewer_client_grants(account_id,project_id,scope_type,COALESCE(association_id,''))
      WHERE status='active' AND revoked_at IS NULL;
    CREATE TABLE viewer_client_grant_mutation_receipts(actor_staff_id TEXT,idempotency_key TEXT,action TEXT,
      request_fingerprint TEXT,grant_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(actor_staff_id,idempotency_key));
    CREATE TABLE viewer_client_grant_audit(id TEXT PRIMARY KEY,grant_id TEXT,action TEXT,actor_staff_id TEXT,
      idempotency_key TEXT,details_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(actor_staff_id,idempotency_key));
    CREATE TABLE viewer_session_revocation_outbox(id TEXT PRIMARY KEY,association_id TEXT,association_version INTEGER,
      idempotency_key TEXT UNIQUE,state TEXT DEFAULT 'pending',attempt_count INTEGER DEFAULT 0,
      next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,last_error_code TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,delivered_at TEXT,UNIQUE(association_id,association_version));
    INSERT INTO projects VALUES('project-one','Acme','Project One',1,'pa-project-one','2026-08-18T12:00:00.000Z');
    INSERT INTO client_accounts VALUES('account-one','Acme','active');
    INSERT INTO client_project_grants VALUES('account-one','project-one',NULL);
    INSERT INTO viewer_model_associations(id,project_id,project_alpha_project_id,project_source_version,viewer_model_id,
      viewer_model_version_id,viewer_resource_version,model_title,model_provider,model_status,state,association_version,created_by_staff_id)
      VALUES('association-one','project-one','pa-project-one','2026-08-18T12:00:00.000Z','model-one','version-one',
      'resource-one','Model One','provider','ready','active',1,'staff-one');
  `.replace(/\s*\n\s*/g, " "));
  env = { OPS_DB: ops, DELIVERY_DB: delivery, VIEWER_INTEGRATION_ENABLED: "true",
    CLIENT_VIEWER_SESSION_ISSUER_ENABLED: "true", VIEWER_BASE_URL: "https://viewer.example.test",
    VIEWER_SERVICE_KEY_ID: "operations-v1",
    VIEWER_EVENT_KEY_ID: "viewer-v1", VIEWER_EVENT_HMAC_SECRET: secret,
    VIEWER_SERVICE_HMAC_SECRET: "viewer-service-secret-32-characters-minimum",
    AUDIT_IP_SECRET: "audit-address-secret-32-characters-minimum",
    INCOMING_EXPECTED_HOST: "incoming.example.test" } as unknown as Env;
  app = new Hono();
  registerViewerProcessingRoutes(app);
}

async function machine(body: unknown, nonce: string, options: { host?: string; signingSecret?: string; raw?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(body), timestamp = Math.floor(Date.now() / 1000);
  const signed = await signViewerProcessingEvent({ secret: options.signingSecret ?? secret, method: "POST", path, body: raw, timestamp, nonce });
  return app.fetch(new Request(`https://${options.host ?? "incoming.example.test"}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-LTDS-Viewer-Key-Id": "viewer-v1",
    "X-LTDS-Viewer-Timestamp": String(timestamp), "X-LTDS-Viewer-Nonce": nonce,
    "X-LTDS-Viewer-Content-SHA256": signed.contentSha256, "X-LTDS-Viewer-Signature": signed.signature,
  }, body: raw }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}

const createEnvelope = (key: string, associationId: string | null = null) => ({ subject: "ops:staff-one", action: "create",
  idempotencyKey: key, grant: { accountId: "account-one", projectId: "project-one",
    scopeType: associationId ? "task" : "project", associationId, includeFuturePublished: !associationId,
    expiresAt: null, permissions: { measure: true, cameras: true, download: false } } });

beforeEach(setup);
afterEach(async () => Promise.all(instances.splice(0).map(instance => instance.dispose())));

describe("Viewer workspace client-grant machine bridge", () => {
  it("applies the dedicated rate-limit migration fresh and on replay, and prunes only expired windows", async () => {
    const migration = readFileSync(new URL("../migrations/0030_viewer_client_grant_bridge_rate_limit.sql", import.meta.url), "utf8");
    await ops.prepare("DROP TABLE viewer_workspace_client_grant_rate_limits").run();
    await ops.exec(migration.replace(/\s*\n\s*/g, " "));
    await ops.exec(migration.replace(/\s*\n\s*/g, " "));
    await ops.prepare("INSERT INTO viewer_workspace_client_grant_rate_limits VALUES(datetime('now','-20 minutes'),7)").run();
    await ops.prepare("INSERT INTO viewer_workspace_client_grant_rate_limits VALUES(strftime('%Y-%m-%dT%H:%M:00Z','now'),2)").run();
    expect(await pruneViewerMachineRateLimits(env)).toBe(1);
    expect(await ops.prepare("SELECT COUNT(*) count FROM viewer_workspace_client_grant_rate_limits").first<number>("count")).toBe(1);
  });

  it("is default-off with zero mutation and admits only the exact Incoming host/path", async () => {
    env.VIEWER_INTEGRATION_ENABLED = "false";
    expect((await machine(createEnvelope("create-default-off-0001"), "default-off-nonce-0001")).status).toBe(404);
    expect(await ops.prepare("SELECT COUNT(*) count FROM viewer_event_nonces").first<number>("count")).toBe(0);
    expect(await delivery.prepare("SELECT COUNT(*) count FROM viewer_client_grants").first<number>("count")).toBe(0);
    expect(viewerMachineHostRequest(`https://incoming.example.test${path}`, "POST", env)).toBe(true);
    expect(viewerMachineHostRequest(`https://ops.example.test${path}`, "POST", env)).toBe(false);
  });

  it("rejects wrong HMAC, replayed nonce, and oversized bodies before domain mutation", async () => {
    expect((await machine({ subject: "ops:staff-one", action: "list" }, "wrong-hmac-nonce-0001",
      { signingSecret: "wrong-secret-that-is-at-least-32-characters" })).status).toBe(401);
    expect((await machine({ subject: "ops:staff-one", action: "list" }, "replay-nonce-value-0001")).status).toBe(200);
    expect((await machine({ subject: "ops:staff-one", action: "list" }, "replay-nonce-value-0001")).status).toBe(409);
    const oversized = JSON.stringify({ subject: "ops:staff-one", action: "list", padding: "x".repeat(17_000) });
    expect((await machine({}, "oversized-nonce-0001", { raw: oversized })).status).toBe(413);
    expect(await delivery.prepare("SELECT COUNT(*) count FROM viewer_client_grants").first<number>("count")).toBe(0);
  });

  it("requires an active bound staff subject plus live global viewer.view and viewer.manage grants", async () => {
    await ops.prepare("UPDATE staff_users SET status='disabled' WHERE id='staff-one'").run();
    expect((await machine({ subject: "ops:staff-one", action: "list" }, "disabled-staff-nonce-01")).status).toBe(403);
    await ops.prepare("UPDATE staff_users SET status='active' WHERE id='staff-one'").run();
    await ops.prepare("DELETE FROM role_permissions").run();
    expect((await machine({ subject: "ops:staff-one", action: "list" }, "missing-permission-0001")).status).toBe(403);
    await ops.prepare("INSERT INTO role_permissions VALUES('viewer-manager','viewer.manage')").run();
    expect((await machine({ subject: "ops:staff-one", action: "list" }, "missing-base-view-0001")).status).toBe(403);
  });

  it("returns the exact bounded snapshot and rejects more than 500 grants", async () => {
    const response = await machine({ subject: "ops:staff-one", action: "list" }, "snapshot-nonce-value-01");
    expect(response.status).toBe(200);
    const snapshot = await response.json() as Record<string, unknown[]>;
    expect(Object.keys(snapshot).sort()).toEqual(["associations", "grants", "projects"]);
    expect(snapshot.grants).toEqual([]);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects![0]).toMatchObject({ id: "project-one", accountId: "account-one",
      clientName: "Acme", projectName: "Project One" });
    expect(snapshot.associations).toHaveLength(1);
    expect(snapshot.associations![0]).toEqual({
      id: "association-one",
      projectId: "project-one",
      viewerModelId: "model-one",
      viewerModelVersionId: "version-one",
      modelTitle: "Model One",
    });
    await delivery.prepare("DROP INDEX live_viewer_grant").run();
    await delivery.prepare(`WITH RECURSIVE numbers(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM numbers WHERE value<500)
      INSERT INTO viewer_client_grants(id,account_id,project_id,scope_type,association_id,include_future_published,
        can_measure,can_view_cameras,can_download,created_by_staff_id,status)
      SELECT 'grant-'||value,'account-one','project-one','project',NULL,1,1,1,0,'staff-one','active' FROM numbers`).run();
    expect((await machine({ subject: "ops:staff-one", action: "list" }, "snapshot-overflow-0001")).status).toBe(503);
  });

  it("returns identifiers from the exact association row that passed live revalidation", async () => {
    const realPrepare = delivery.prepare.bind(delivery);
    let refreshed = false;
    env.DELIVERY_DB = {
      prepare(query: string) {
        const prepared = realPrepare(query);
        if (!query.includes("WHERE association.id=?")) return prepared;
        return {
          bind(...values: unknown[]) {
            const bound = prepared.bind(...values);
            return {
              async first<T = Record<string, unknown>>(columnName?: string) {
                if (!refreshed) {
                  refreshed = true;
                  await realPrepare(`UPDATE viewer_model_associations
                    SET viewer_model_version_id='version-two',viewer_resource_version='resource-two'
                    WHERE id='association-one'`).run();
                }
                return columnName === undefined ? bound.first<T>() : bound.first<T>(columnName);
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
    } as unknown as D1Database;
    const response = await machine({ subject: "ops:staff-one", action: "list" }, "snapshot-refresh-nonce-01");
    expect(response.status).toBe(200);
    const snapshot = await response.json() as { associations: Array<Record<string, unknown>> };
    expect(refreshed).toBe(true);
    expect(snapshot.associations).toEqual([{
      id: "association-one",
      projectId: "project-one",
      viewerModelId: "model-one",
      viewerModelVersionId: "version-two",
      modelTitle: "Model One",
    }]);
  });

  it("creates atomically, replays identically, conflicts on key reuse, and denies stale task associations", async () => {
    const original = createEnvelope("create-idempotency-0001");
    expect((await machine(original, "create-first-nonce-0001")).status).toBe(201);
    const replay = await machine(original, "create-replay-nonce-001");
    expect(replay.status).toBe(200);
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
    expect(await delivery.prepare("SELECT COUNT(*) count FROM viewer_client_grants").first<number>("count")).toBe(1);
    expect(await delivery.prepare("SELECT COUNT(*) count FROM viewer_client_grant_audit").first<number>("count")).toBe(1);
    expect((await machine(createEnvelope("create-idempotency-0001", "association-one"), "create-conflict-nonce-01")).status).toBe(409);
    await delivery.prepare("UPDATE viewer_model_associations SET project_source_version='stale'").run();
    expect((await machine(createEnvelope("stale-association-key-1", "association-one"), "stale-association-nonce1")).status).toBe(404);
  });

  it("rolls back grant and receipt when authoritative audit persistence fails", async () => {
    await delivery.prepare(`CREATE TRIGGER reject_grant_audit BEFORE INSERT ON viewer_client_grant_audit
      BEGIN SELECT RAISE(ABORT,'injected authoritative audit failure'); END`).run();
    expect((await machine(createEnvelope("audit-rollback-key-001"), "audit-rollback-nonce-01")).status).toBe(500);
    expect(await delivery.prepare("SELECT COUNT(*) count FROM viewer_client_grants").first<number>("count")).toBe(0);
    expect(await delivery.prepare("SELECT COUNT(*) count FROM viewer_client_grant_mutation_receipts").first<number>("count")).toBe(0);
  });

  it("revokes once, bumps versions, drains the outbox, and safely replays", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { sourceAuthorization: { id: string; version: number } };
      return new Response(JSON.stringify({ sourceAuthorization: { type: "model_association", ...parsed.sourceAuthorization },
        revokedGrants: 1, revokedSessions: 2 }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const created = await machine(createEnvelope("revoke-create-key-0001"), "revoke-create-nonce-01");
    const grantId = ((await created.json()) as { grants: Array<{ id: string }> }).grants[0]!.id;
    const revoke = { subject: "ops:staff-one", action: "revoke", idempotencyKey: "revoke-key-value-00001", grantId, reason: "Access removed" };
    const first = await machine(revoke, "revoke-first-nonce-0001");
    expect(first.status).toBe(202);
    expect((await first.json() as { sessionRevocation: unknown }).sessionRevocation).toEqual({ delivered: 0, pending: 1 });
    expect(await delivery.prepare("SELECT grant_version FROM viewer_client_grants WHERE id=?").bind(grantId).first<number>("grant_version")).toBe(2);
    expect(await delivery.prepare("SELECT association_version FROM viewer_model_associations WHERE id='association-one'").first<number>("association_version")).toBe(2);
    await delivery.prepare("UPDATE viewer_session_revocation_outbox SET next_attempt_at=datetime('now','-1 second')").run();
    expect(await drainViewerSessionRevocations(env, { fetcher })).toEqual({ delivered: 1, pending: 0 });
    expect(await delivery.prepare("SELECT state FROM viewer_session_revocation_outbox").first<string>("state")).toBe("delivered");
    const replay = await machine(revoke, "revoke-replay-nonce-001");
    expect(replay.status).toBe(200);
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
    expect(await delivery.prepare("SELECT grant_version FROM viewer_client_grants WHERE id=?").bind(grantId).first<number>("grant_version")).toBe(2);
    const secondKey = await machine({ ...revoke, idempotencyKey: "revoke-key-value-00002" }, "revoke-second-key-nonce");
    expect(secondKey.status).toBe(409);
    expect(await delivery.prepare("SELECT association_version FROM viewer_model_associations WHERE id='association-one'").first<number>("association_version")).toBe(2);
    expect(await delivery.prepare("SELECT COUNT(*) count FROM viewer_session_revocation_outbox").first<number>("count")).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }, 15_000);
});
