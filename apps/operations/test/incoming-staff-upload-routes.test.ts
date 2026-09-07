import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  requirePermission: mocks.requirePermission,
}));

import worker from "../src/worker/index";
import { dispatchIncomingPublicRequest } from "../src/worker/incoming";

class MetadataOnlyIncomingBucket {
  objects = new Map<string, { size: number; uploaded: Date; httpMetadata?: { contentType?: string } }>();
  headCalls = 0;

  async head(key: string) {
    this.headCalls += 1;
    return this.objects.get(key) || null;
  }

  async get() { throw new Error("Staff inspection must not read quarantine bytes"); }
  async delete(key: string) { this.objects.delete(key); }
}

const principal = { id: "staff-incoming", email: "staff@example.test", displayName: "Staff", accessSubject: "access-subject", projectAlphaUserId: null };
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let runtime: Miniflare;
let database: D1Database;
let bucket: MetadataOnlyIncomingBucket;
let environment: Record<string, unknown>;
const claimOne = "11111111-1111-4111-8111-111111111111";
const claimTwo = "22222222-2222-4222-8222-222222222222";
const claimThree = "33333333-3333-4333-8333-333333333333";

function staffRequest(path: string) {
  return worker.fetch(new Request(`https://ops.example${path}`), environment as never, context);
}
function pickupRequest(path: string, body: unknown) {
  return dispatchIncomingPublicRequest(new Request(`https://incoming.example${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer pickup-secret-at-least-32-characters", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), environment as never, context) as Promise<Response>;
}

describe("incoming upload staff records and pickup lifecycle", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default { fetch(){ return new Response('ok'); } }",
      d1Databases: { DB: "incoming-staff-detail" },
    });
    database = await runtime.getD1Database("DB") as unknown as D1Database;
    for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0198_incoming_upload_owner_notifications.sql", "0199_incoming_upload_pickup_lifecycle.sql"]) {
      const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8")
        .replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "");
      await database.exec(sql.replace(/\s*\n\s*/g, " "));
    }
  });

  beforeEach(async () => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(true);
    mocks.requirePermission.mockReset().mockResolvedValue(undefined);
    await database.exec("DELETE FROM incoming_upload_notification_digest_items; DELETE FROM incoming_upload_notification_digests; DELETE FROM file_request_upload_parts; DELETE FROM file_request_uploads; DELETE FROM file_request_contributors; DELETE FROM incoming_link_state; DELETE FROM file_requests;");
    await database.batch([
      database.prepare("INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version) VALUES('request-one','public-one','Receive files','staff-incoming',datetime('now','+1 day'),10,999999,1)"),
      database.prepare("INSERT INTO incoming_link_state(slot,active_request_id) VALUES('default','request-one')"),
      database.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('contributor-one','request-one','Joe Gaworecki','joe@example.test','hashed')"),
      database.prepare("INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,actual_size,content_type,status,completed_at) VALUES('upload-one','request-one','contributor-one','quarantine/request-one/upload-one/object','multipart-one','iCloud <Photos>.zip',893398388,893398388,'application/zip','quarantined',datetime('now'))"),
    ]);
    bucket = new MetadataOnlyIncomingBucket();
    bucket.objects.set("quarantine/request-one/upload-one/object", { size: 893398388, uploaded: new Date("2026-09-06T12:00:00.000Z"), httpMetadata: { contentType: "application/zip" } });
    environment = {
      OPS_DB: {}, DELIVERY_DB: database, INCOMING_BUCKET: bucket,
      ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example",
      INCOMING_BASE_URL: "https://incoming.example", INCOMING_PICKUP_SECRET: "pickup-secret-at-least-32-characters",
      TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "turnstile-secret", INCOMING_SESSION_SECRET: "session-secret",
      INCOMING_ACCESS_CODE_PEPPER: "access-pepper", R2_ACCOUNT_ID: "account", R2_INCOMING_BUCKET_NAME: "incoming",
      R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", INCOMING_LIFECYCLE_WORKFLOW: {},
    };
  });

  afterAll(async () => { await runtime.dispose(); });

  it("shows staff lifecycle metadata without returning a private object key or bytes", async () => {
    const response = await staffRequest("/api/delivery/incoming-link/uploads/upload-one");
    expect(response.status).toBe(200);
    const payload = await response.json() as { upload: Record<string, unknown> };
    expect(payload.upload).toMatchObject({
      id: "upload-one", fileName: "iCloud <Photos>.zip", status: "quarantined", pickupState: "awaiting_pickup",
      bucketObject: { state: "present", size: 893398388, contentType: "application/zip" },
    });
    expect(JSON.stringify(payload)).not.toContain("quarantine/request-one");
    expect(JSON.stringify(payload)).not.toContain("downloadUrl");
    expect(bucket.headCalls).toBe(1);
  });

  it("claims exactly once and permits an idempotent replay by the same server", async () => {
    const [first, concurrent] = await Promise.all([
      pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimOne }),
      pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimTwo }),
    ]);
    const responses = [first, concurrent];
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect(responses.filter(response => response.status === 409)).toHaveLength(1);
    const winner = first.status === 200 ? claimOne : claimTwo;
    const replay = await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: winner });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, state: "scanning", claimToken: winner, replayed: true });
    const heartbeat = await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "heartbeat", claimToken: winner });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ ok: true, state: "scanning", claimToken: winner, leaseExpiresAt: expect.any(String) });
    expect(await database.prepare("SELECT pickup_state,pickup_attempt_count,pickup_claim_token,pickup_lease_expires_at FROM file_request_uploads WHERE id='upload-one'").first())
      .toMatchObject({ pickup_state: "scanning", pickup_attempt_count: 1, pickup_claim_token: winner, pickup_lease_expires_at: expect.any(String) });
  });

  it("only permits a due retry to be reclaimed and fences a different claimant", async () => {
    const started = await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimOne });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ ok: true, state: "scanning", claimToken: claimOne, replayed: false });

    const wrongRetry = await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "retry", claimToken: claimTwo, retryAfterSeconds: 3600, errorCode: "source_unavailable" });
    expect(wrongRetry.status).toBe(409);
    const retry = await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "retry", claimToken: claimOne, retryAfterSeconds: 3600, errorCode: "source_unavailable" });
    expect(retry.status).toBe(200);
    expect(await database.prepare("SELECT pickup_state,pickup_attempt_count,pickup_next_attempt_at,pickup_last_error_code,pickup_claim_token FROM file_request_uploads WHERE id='upload-one'").first())
      .toMatchObject({ pickup_state: "retry", pickup_attempt_count: 1, pickup_last_error_code: "source_unavailable", pickup_next_attempt_at: expect.any(String), pickup_claim_token: null });

    const early = await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimTwo });
    expect(early.status).toBe(409);
    await database.prepare("UPDATE file_request_uploads SET pickup_next_attempt_at=datetime('now','-1 second') WHERE id='upload-one'").run();
    const due = await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimTwo });
    expect(due.status).toBe(200);
    expect(await due.json()).toMatchObject({ ok: true, state: "scanning", claimToken: claimTwo, replayed: false });
  });

  it("reclaims a stale server lease but rejects its stale retry and final receipt", async () => {
    expect((await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimOne })).status).toBe(200);
    await database.prepare("UPDATE file_request_uploads SET pickup_lease_expires_at=datetime('now','-1 second') WHERE id='upload-one'").run();
    expect((await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimTwo })).status).toBe(200);

    const staleRetry = await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "retry", claimToken: claimOne, retryAfterSeconds: 60, errorCode: "source_unavailable" });
    expect(staleRetry.status).toBe(409);
    bucket.objects.delete("quarantine/request-one/upload-one/object");
    const staleAccepted = await pickupRequest("/api/internal/uploads/upload-one/accepted", { claimToken: claimOne, sha256: "a".repeat(64) });
    expect(staleAccepted.status).toBe(409);
    expect(await database.prepare("SELECT status,pickup_state,pickup_claim_token FROM file_request_uploads WHERE id='upload-one'").first())
      .toMatchObject({ status: "quarantined", pickup_state: "scanning", pickup_claim_token: claimTwo });
  });

  it("accepts only the live claim after the server has removed the quarantined object", async () => {
    expect((await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimThree })).status).toBe(200);
    bucket.objects.delete("quarantine/request-one/upload-one/object");
    const accepted = await pickupRequest("/api/internal/uploads/upload-one/accepted", { claimToken: claimThree, sha256: "b".repeat(64) });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, status: "accepted", idempotent: false });
  });

  it("recovers the exact persisted claim after a crash between R2 deletion and final receipt", async () => {
    expect((await pickupRequest("/api/internal/uploads/upload-one/pickup-status", { state: "scanning", claimToken: claimThree })).status).toBe(200);
    // Simulate a worker crash after durable local promotion and R2 deletion.
    // A different claimant cannot recover this row, but the saved claim token
    // can complete the final receipt without leaving it stranded forever.
    await database.prepare("UPDATE file_request_uploads SET pickup_lease_expires_at=datetime('now','-1 second') WHERE id='upload-one'").run();
    bucket.objects.delete("quarantine/request-one/upload-one/object");
    const recovered = await pickupRequest("/api/internal/uploads/upload-one/accepted", { claimToken: claimThree, sha256: "c".repeat(64) });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ ok: true, status: "accepted", idempotent: false });
  });
});
