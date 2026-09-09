import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

import { dispatchIncomingPublicRequest } from "../src/worker/incoming";
import { createIncomingSession } from "../src/worker/incoming-security";

class IncomingBucket {
  uploads = new Map<string, { key: string; aborted: boolean; completed: boolean; size: number }>();
  objects = new Map<string, { size: number; etag: string; bytes: Uint8Array }>();
  aborts: string[] = [];

  async createMultipartUpload(key: string) {
    const uploadId = crypto.randomUUID();
    this.uploads.set(uploadId, { key, aborted: false, completed: false, size: 0 });
    return this.handle(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    if (this.uploads.get(uploadId)?.key !== key) throw new Error("unknown-upload");
    return this.handle(key, uploadId);
  }

  private handle(key: string, uploadId: string) {
    const bucket = this;
    return {
      key, uploadId,
      async abort() {
        const upload = bucket.uploads.get(uploadId)!;
        upload.aborted = true;
        bucket.aborts.push(uploadId);
      },
      async complete(parts: Array<{ partNumber: number; etag: string }>) {
        const upload = bucket.uploads.get(uploadId)!;
        if (upload.aborted) throw new Error("aborted");
        const checkpointSize = Number((bucket as any).checkpointSize || 4);
        upload.completed = true;
        upload.size = checkpointSize;
        const object = { size: checkpointSize, etag: parts.map(part => part.etag).join("-") || "etag", bytes: new Uint8Array([1, 2, 3, 4]) };
        bucket.objects.set(key, object);
        return object;
      },
    };
  }

  async head(key: string) { return this.objects.get(key) || null; }
  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { async arrayBuffer() { return object.bytes.buffer; } } : null;
  }
  async delete(key: string) { this.objects.delete(key); }
}

describe("incoming upload public routes", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let bucket: IncomingBucket;
  let env: any;
  let cookie: string;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-08-06", modules: true, script: "export default { fetch() { return new Response('ok'); } };", d1Databases: { DB: "incoming-routes" } });
    db = await miniflare.getD1Database("DB") as unknown as D1Database;
    for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0198_incoming_upload_owner_notifications.sql", "0199_incoming_upload_pickup_lifecycle.sql", "0211_incoming_upload_verification_lifecycle.sql"]) {
      const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "");
      await db.exec(sql.replace(/\s*\n\s*/g, " "));
    }
  });

  beforeEach(async () => {
    await db.exec("DELETE FROM public_rate_limits; DELETE FROM incoming_upload_notification_digest_items; DELETE FROM incoming_upload_notification_digests; DELETE FROM file_request_upload_parts; DELETE FROM file_request_uploads; DELETE FROM file_request_contributors; DELETE FROM file_requests;");
    await db.batch([
      db.prepare("INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version) VALUES('request-a','public-a','Upload','staff',datetime('now','+1 day'),10,1000,1)"),
      db.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('contributor-a','request-a','Client','client@example.test','hash')"),
      db.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('contributor-b','request-a','Other','other@example.test','hash')"),
    ]);
    bucket = new IncomingBucket();
    env = {
      DELIVERY_DB: db, INCOMING_BUCKET: bucket, INCOMING_BASE_URL: "https://incoming.test", INCOMING_EXPECTED_HOST: "incoming.test",
      TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "turnstile-secret-that-is-at-least-32-bytes", INCOMING_SESSION_SECRET: "session-secret-that-is-at-least-32-bytes",
      INCOMING_ACCESS_CODE_PEPPER: "access-pepper-that-is-at-least-32-bytes", INCOMING_PICKUP_SECRET: "pickup-secret-that-is-at-least-32-bytes", R2_ACCOUNT_ID: "a".repeat(32),
      R2_INCOMING_BUCKET_NAME: "incoming", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret",
      INCOMING_LIFECYCLE_WORKFLOW: { create: vi.fn().mockResolvedValue({}) }, AUDIT_IP_SECRET: "audit-secret-that-is-at-least-32-bytes",
    };
    cookie = (await createIncomingSession(env.INCOMING_SESSION_SECRET, "request-a", "contributor-a", 1, Date.now() + 60_000)).split(";")[0]!;
  });

  afterAll(async () => miniflare.dispose());

  const request = (path: string, method = "GET", body?: unknown, suppliedCookie = cookie) => dispatchIncomingPublicRequest(new Request(`https://incoming.test${path}`, {
    method,
    headers: { Origin: "https://incoming.test", Cookie: suppliedCookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {} as ExecutionContext) as Promise<Response>;

  it("initializes, scopes a direct ticket, checkpoints, completes, and cleans parts", async () => {
    const initResponse = await request("/api/public/requests/public-a/files/init", "POST", { clientUploadId: "upload-client-0001", name: "photo.jpg", size: 4, contentType: "image/jpeg", resumeFingerprint: "b".repeat(64) });
    expect(initResponse.status).toBe(200);
    const init = await initResponse.json() as { fileId: string };
    const initialized = await db.prepare("SELECT object_key,upload_id FROM file_request_uploads WHERE id=?").bind(init.fileId).first<{ object_key: string; upload_id: string }>();
    expect(initialized?.object_key).toBe(`quarantine/request-a/${init.fileId}/object`);
    expect(bucket.uploads.get(initialized!.upload_id)?.key).toBe(`quarantine/request-a/${init.fileId}/object`);
    expect(await db.prepare("SELECT reserved_files,reserved_bytes FROM file_requests WHERE id='request-a'").first()).toEqual({ reserved_files: 1, reserved_bytes: 4 });

    const otherCookie = (await createIncomingSession(env.INCOMING_SESSION_SECRET, "request-a", "contributor-b", 1, Date.now() + 60_000)).split(";")[0]!;
    expect((await request(`/api/public/requests/public-a/files/${init.fileId}/part-ticket`, "POST", { partNumber: 1 }, otherCookie)).status).toBe(404);
    const ticketResponse = await request(`/api/public/requests/public-a/files/${init.fileId}/part-ticket`, "POST", { partNumber: 1 });
    const ticket = await ticketResponse.json() as { url: string; expiresIn: number; partNumber: number; contentLength: number; contentType: string };
    expect(ticket).toMatchObject({ expiresIn: 300, partNumber: 1, contentLength: 4, contentType: "image/jpeg" });
    const signedUrl = new URL(ticket.url);
    expect(signedUrl.searchParams.get("uploadId")).toBeTruthy();
    expect(signedUrl.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");

    const etag = "1".repeat(32);
    expect((await request(`/api/public/requests/public-a/files/${init.fileId}/parts/1`, "PUT", { etag: `"${etag}"`, size: 4 })).status).toBe(200);
    const complete = await request(`/api/public/requests/public-a/files/${init.fileId}/complete`, "POST", { parts: [{ partNumber: 1, etag }] });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ status: "quarantined", idempotent: false });
    expect(await db.prepare("SELECT COUNT(*) count FROM file_request_upload_parts WHERE upload_id=?").bind(init.fileId).first()).toEqual({ count: 0 });
    expect(await db.prepare("SELECT id,request_id,contributor_id,owner_staff_id,digest_version,file_count,total_bytes,status,attempt_count FROM incoming_upload_notification_digests").first()).toEqual({
      id: "incoming-upload-digest:request-a:contributor-a:v1", request_id: "request-a", contributor_id: "contributor-a",
      owner_staff_id: "staff", digest_version: 1, file_count: 1, total_bytes: 4, status: "pending", attempt_count: 0,
    });
    expect(await (await request(`/api/public/requests/public-a/files/${init.fileId}/complete`, "POST", { parts: [{ partNumber: 1, etag }] })).json()).toMatchObject({ status: "quarantined", idempotent: true });
    expect(await db.prepare("SELECT COUNT(*) count FROM incoming_upload_notification_digest_items WHERE upload_id=?").bind(init.fileId).first()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT file_count,total_bytes FROM incoming_upload_notification_digests").first()).toEqual({ file_count: 1, total_bytes: 4 });
  });

  it("accepts a legitimate multipart completion body above the small-route JSON limit", async () => {
    const partCount = 1_200;
    const declaredSize = partCount * 32 * 1024 ** 2;
    await db.prepare("UPDATE file_requests SET max_bytes=? WHERE id='request-a'").bind(declaredSize + 1).run();
    const initResponse = await request("/api/public/requests/public-a/files/init", "POST", {
      clientUploadId: "upload-client-large-completion",
      name: "large-video.mp4",
      size: declaredSize,
      contentType: "video/mp4",
      resumeFingerprint: "f".repeat(64),
    });
    expect(initResponse.status).toBe(200);
    const { fileId } = await initResponse.json() as { fileId: string };
    const parts = Array.from({ length: partCount }, (_, index) => ({
      partNumber: index + 1,
      etag: (index + 1).toString(16).padStart(32, "0"),
    }));
    expect(JSON.stringify({ parts }).length).toBeGreaterThan(64 * 1024);
    for (let offset = 0; offset < parts.length; offset += 100) {
      const values = parts.slice(offset, offset + 100)
        .map((part) => `('${fileId}',${part.partNumber},'${part.etag}',${32 * 1024 ** 2})`)
        .join(",");
      await db.exec(`INSERT INTO file_request_upload_parts(upload_id,part_number,etag,size) VALUES ${values}`);
    }
    (bucket as any).checkpointSize = declaredSize;

    const complete = await request(`/api/public/requests/public-a/files/${fileId}/complete`, "POST", { parts });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ status: "quarantined", idempotent: false });
  }, 15_000);

  it("rejects resume fingerprint replay and cancels owned multipart exactly once", async () => {
    const body = { clientUploadId: "upload-client-0002", name: "report.pdf", size: 4, contentType: "application/pdf", resumeFingerprint: "c".repeat(64) };
    const first = await (await request("/api/public/requests/public-a/files/init", "POST", body)).json() as { fileId: string };
    expect((await request("/api/public/requests/public-a/files/init", "POST", { ...body, resumeFingerprint: "d".repeat(64) })).status).toBe(409);
    const cancel = await request(`/api/public/requests/public-a/files/${first.fileId}`, "DELETE");
    expect(await cancel.json()).toMatchObject({ status: "cancelled", idempotent: false });
    expect(bucket.aborts).toHaveLength(1);
    expect(await db.prepare("SELECT reserved_files,reserved_bytes FROM file_requests WHERE id='request-a'").first()).toEqual({ reserved_files: 0, reserved_bytes: 0 });
    expect(await (await request(`/api/public/requests/public-a/files/${first.fileId}`, "DELETE")).json()).toMatchObject({ status: "cancelled", idempotent: true });
    expect(bucket.aborts).toHaveLength(1);
  });

  it("rejects cross-origin mutations before touching storage", async () => {
    const response = await dispatchIncomingPublicRequest(new Request("https://incoming.test/api/public/requests/public-a/files/init", {
      method: "POST", headers: { Origin: "https://evil.test", Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientUploadId: "upload-client-0003", name: "photo.jpg", size: 4, contentType: "image/jpeg", resumeFingerprint: "e".repeat(64) }),
    }), env, {} as ExecutionContext) as Response;
    expect(response.status).toBe(403);
    expect(await db.prepare("SELECT COUNT(*) count FROM file_request_uploads").first()).toEqual({ count: 0 });
  });

  it("rejects declared and streamed JSON bodies above the route limit", async () => {
    const declared = await dispatchIncomingPublicRequest(new Request("https://incoming.test/api/public/requests/public-a/files/init", {
      method: "POST",
      headers: {
        Origin: "https://incoming.test",
        Cookie: cookie,
        "Content-Type": "application/json",
        "Content-Length": "65537",
      },
      body: "{}",
    }), env, {} as ExecutionContext) as Response;
    expect(declared.status).toBe(413);

    const streamed = await dispatchIncomingPublicRequest(new Request("https://incoming.test/api/public/requests/public-a/files/init", {
      method: "POST",
      headers: { Origin: "https://incoming.test", Cookie: cookie, "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65_537).fill(32));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" }), env, {} as ExecutionContext) as Response;
    expect(streamed.status).toBe(413);
  });

  it("rate limits public authorization before parsing malformed JSON", async () => {
    const response = await dispatchIncomingPublicRequest(new Request("https://incoming.test/api/public/requests/public-a/authorize", {
      method: "POST",
      headers: { Origin: "https://incoming.test", "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
      body: "{",
    }), env, {} as ExecutionContext) as Response;
    expect(response.status).toBe(400);
    expect(await db.prepare("SELECT SUM(count) count FROM public_rate_limits").first()).toEqual({ count: 1 });
  });
});
