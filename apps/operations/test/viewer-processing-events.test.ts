import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/worker/viewer-session-issuer", () => ({
  introspectClientViewerSourceAuthorization: vi.fn(async (_env, input) => ({
    active: true,
    authorizationId: input.authorizationId,
    authorizationVersion: input.authorizationVersion,
    subject: input.subject,
    modelId: input.modelId,
    expiresAt: null,
  })),
}));
import type { Env } from "../src/worker/types";
import {
  processViewerProcessingNotifications,
  pruneViewerEventNonces,
  pruneViewerMachineRateLimits,
  registerViewerProcessingRoutes,
  signViewerProcessingEvent,
  viewerMachineHostRequest,
} from "../src/worker/viewer-processing";

const instances: Miniflare[] = [];
const secret = "viewer-event-secret-32-characters-minimum";
let database: D1Database, env: Env, app: Hono<any>;

async function setup(): Promise<void> {
  const instance = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: { OPS_DB: "viewer-events" } });
  instances.push(instance);
  database = await instance.getD1Database("OPS_DB") as unknown as D1Database;
  await database.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,display_name TEXT,access_subject TEXT,
    project_alpha_user_id TEXT,status TEXT,created_at TEXT,updated_at TEXT,last_seen_at TEXT);
    CREATE TABLE roles(id TEXT PRIMARY KEY,name TEXT,description TEXT,immutable INTEGER);
    CREATE TABLE permissions(key TEXT PRIMARY KEY,description TEXT);
    CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT,PRIMARY KEY(role_id,permission_key));
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,actor_email TEXT,
      actor_display_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,division_id TEXT,details_json TEXT,
      client_address_hash TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO roles VALUES('role-owner','Owner','Owner',1),('role-admin','Admin','Admin',1);
    INSERT INTO staff_users VALUES('staff-one','staff@example.test','Staff','subject',NULL,'active',datetime('now'),datetime('now'),NULL);`.replace(/\s*\n\s*/g, " "));
  const migration = readFileSync(new URL("../migrations/0027_viewer_processing_control_plane.sql", import.meta.url), "utf8");
  await database.exec(migration.replace(/--.*$/gm, "").replace(/\s*\n\s*/g, " "));
  const labelsMigration = readFileSync(new URL("../migrations/0028_viewer_processing_labels.sql", import.meta.url), "utf8");
  await database.exec(labelsMigration.replace(/--.*$/gm, "").replace(/\s*\n\s*/g, " "));
  const machineRateMigration = readFileSync(new URL("../migrations/0029_viewer_machine_rate_limits.sql", import.meta.url), "utf8");
  await database.exec(machineRateMigration.replace(/--.*$/gm, "").replace(/\s*\n\s*/g, " "));
  env = {
    OPS_DB: database, VIEWER_INTEGRATION_ENABLED: "true", VIEWER_PROCESSING_ENABLED: "true",
    PUBLIC_BASE_URL: "https://ops.example.test",
    VIEWER_BASE_URL: "https://viewer.example.test", VIEWER_EVENT_KEY_ID: "viewer-v1",
    VIEWER_EVENT_HMAC_SECRET: secret, NOTIFICATION_FROM: "notify@example.test",
    CLIENT_VIEWER_SHARES_ENABLED: "true", INCOMING_EXPECTED_HOST: "incoming.example.test",
    NOTIFICATION_EMAIL: { send: vi.fn(async () => undefined) },
  } as unknown as Env;
  app = new Hono(); registerViewerProcessingRoutes(app);
}

function body(eventId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, eventId, type: "processing.ready_for_review",
    occurredAt: new Date().toISOString(), projectId: "project-one", taskId: "task-one",
    attemptId: "attempt-one", requestedBySubject: "ops:staff-one", status: "ready_for_review",
    reviewUrl: "https://ops.example.test/operations/processing?attemptId=attempt-one", ...overrides });
}

async function request(eventBody: string, nonce: string): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = await signViewerProcessingEvent({ secret, method: "POST", path: "/api/viewer/events", body: eventBody, timestamp, nonce });
  return app.fetch(new Request("https://ops.example.test/api/viewer/events", { method: "POST", headers: {
    "Content-Type": "application/json", "Idempotency-Key": JSON.parse(eventBody).eventId,
    "X-LTDS-Viewer-Key-Id": "viewer-v1", "X-LTDS-Viewer-Timestamp": String(timestamp),
    "X-LTDS-Viewer-Nonce": nonce, "X-LTDS-Viewer-Content-SHA256": signed.contentSha256,
    "X-LTDS-Viewer-Signature": signed.signature,
  }, body: eventBody }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}

async function introspectionRequest(body: string, nonce: string, signatureSecret = secret): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000), path = "/api/viewer/source-authorizations/introspect";
  const signed = await signViewerProcessingEvent({ secret: signatureSecret, method: "POST", path, body, timestamp, nonce });
  return app.fetch(new Request(`https://incoming.example.test${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-LTDS-Viewer-Key-Id": "viewer-v1",
    "X-LTDS-Viewer-Timestamp": String(timestamp), "X-LTDS-Viewer-Nonce": nonce,
    "X-LTDS-Viewer-Content-SHA256": signed.contentSha256, "X-LTDS-Viewer-Signature": signed.signature,
  }, body }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}

beforeEach(setup);
afterEach(async () => Promise.all(instances.splice(0).map(instance => instance.dispose())));

describe("Viewer processing event callback", () => {
  it("admits only the two exact Incoming machine paths and validates introspection before authorization work", async () => {
    expect(viewerMachineHostRequest("https://incoming.example.test/api/viewer/events", "POST", env)).toBe(true);
    expect(viewerMachineHostRequest("https://incoming.example.test/api/viewer/source-authorizations/introspect", "POST", env)).toBe(true);
    expect(viewerMachineHostRequest("https://ops.example.test/api/viewer/events", "POST", env)).toBe(false);
    expect(viewerMachineHostRequest("https://incoming.example.test/api/other", "POST", env)).toBe(false);
    const payload = JSON.stringify({ authorizationId: "source-one", authorizationVersion: 1,
      subject: "subject-one", modelId: "model-one", shareId: "share-one" });
    expect((await introspectionRequest(payload, "introspection-bad-123456", "wrong-secret-with-at-least-32-characters")).status).toBe(401);
    const valid = await introspectionRequest(payload, "introspection-good-12345");
    expect(valid.status).toBe(200);
    expect(valid.headers.get("Cache-Control")).toBe("no-store");
    expect(await valid.json()).toEqual({ active: true, authorizationId: "source-one", authorizationVersion: 1,
      subject: "subject-one", modelId: "model-one", expiresAt: null });
  });
  it("keeps storage deletion owner-only in the Operations permission seed", async () => {
    const result = await database.prepare("SELECT role_id,permission_key FROM role_permissions WHERE permission_key LIKE 'viewer.%' ORDER BY role_id,permission_key").all<{ role_id: string; permission_key: string }>();
    expect(result.results.filter(row => row.role_id === "role-admin").map(row => row.permission_key)).toEqual([
      "viewer.datasets.manage", "viewer.processing.manage", "viewer.publish",
    ]);
    expect(result.results.filter(row => row.role_id === "role-owner").map(row => row.permission_key)).toEqual([
      "viewer.datasets.manage", "viewer.processing.manage", "viewer.publish", "viewer.storage.purge",
    ]);
  });

  it("atomically creates one inbox event, audit, and durable notification intent", async () => {
    const response = await request(body("event-ready-000001", { projectDisplayName: "Wrightstown", taskDisplayName: "August survey" }), "event-nonce-1234567890");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, replayed: false });
    expect(await database.prepare("SELECT COUNT(*) FROM viewer_processing_events").first<number>("COUNT(*)")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) FROM viewer_processing_notification_outbox").first<number>("COUNT(*)")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) FROM audit_events").first<number>("COUNT(*)")).toBe(1);
    expect(await database.prepare("SELECT project_display_name,task_display_name FROM viewer_processing_events").first()).toMatchObject({ project_display_name: "Wrightstown", task_display_name: "August survey" });
  });

  it("replays an identical event, rejects a changed body, and rejects nonce reuse for a new event", async () => {
    const original = body("event-ready-000001");
    expect((await request(original, "event-nonce-1234567890")).status).toBe(202);
    expect((await request(original, "event-nonce-2234567890")).status).toBe(200);
    expect((await request(body("event-ready-000001", { status: "changed" }), "event-nonce-3234567890")).status).toBe(409);
    expect((await request(body("event-ready-000002"), "event-nonce-1234567890")).status).toBe(409);
    expect(await database.prepare("SELECT COUNT(*) FROM viewer_processing_events").first<number>("COUNT(*)")).toBe(1);
  });

  it("rejects review open redirects and non-opaque attempt identifiers", async () => {
    expect((await request(body("event-ready-000003", { reviewUrl: "https://evil.example/operations/processing?attemptId=attempt-one" }), "event-nonce-4234567890")).status).toBe(400);
    expect((await request(body("event-ready-000004", { attemptId: "../attempt-one" }), "event-nonce-5234567890")).status).toBe(400);
    expect(await database.prepare("SELECT COUNT(*) FROM viewer_processing_events").first<number>("COUNT(*)")).toBe(0);
  });

  it("requires one canonical attemptId query on the exact public Operations route", async () => {
    const invalid = [
      "https://ops.example.test/operations/processing?attemptId=other-attempt",
      "https://ops.example.test/operations/processing?attemptId=attempt-one&attemptId=attempt-one",
      "https://ops.example.test/operations/processing?attemptId=attempt-one&next=https%3A%2F%2Fevil.example",
      "https://ops.example.test/operations/processing/?attemptId=attempt-one",
      "https://ops.example.test/operations/processing?attemptId=attempt-one#fragment",
      "http://ops.example.test/operations/processing?attemptId=attempt-one",
    ];
    for (const [index, reviewUrl] of invalid.entries()) {
      const response = await request(body(`event-invalid-url-${index}`, { reviewUrl }), `invalid-url-nonce-${index}-123456`);
      expect(response.status, reviewUrl).toBe(400);
    }
    expect(await database.prepare("SELECT COUNT(*) FROM viewer_processing_events").first<number>("COUNT(*)")).toBe(0);
  });

  it("delivers the durable notification and only prunes expired nonces", async () => {
    expect((await request(body("event-ready-000001"), "event-nonce-1234567890")).status).toBe(202);
    expect(await processViewerProcessingNotifications(env)).toBe(1);
    expect(await database.prepare("SELECT status FROM viewer_processing_notification_outbox").first<string>("status")).toBe("sent");
    await database.prepare("INSERT INTO viewer_event_nonces VALUES('viewer-v1','expired-nonce-12345',datetime('now','-1 minute'),datetime('now'))").run();
    await pruneViewerEventNonces(env);
    expect(await database.prepare("SELECT COUNT(*) FROM viewer_event_nonces").first<number>("COUNT(*)")).toBe(1);
  });

  it("bounds machine-rate windows without deleting the current window", async () => {
    await database.prepare("INSERT INTO viewer_machine_rate_limits VALUES('event',datetime('now','-20 minutes'),7)").run();
    await database.prepare("INSERT INTO viewer_machine_rate_limits VALUES('source-introspection',strftime('%Y-%m-%dT%H:%M:00Z','now'),2)").run();
    expect(await pruneViewerMachineRateLimits(env)).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) FROM viewer_machine_rate_limits").first<number>("COUNT(*)")).toBe(1);
  });
});
