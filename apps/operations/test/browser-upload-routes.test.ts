import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "../src/worker/types";

const acl = vi.hoisted(() => ({ requirePermission: vi.fn() }));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("../src/worker/acl", () => ({ requirePermission: acl.requirePermission }));
vi.mock("../src/worker/request-security", () => ({
  requireMutationSecurity: vi.fn(),
  auditStatement: async (env: Env) => env.OPS_DB.prepare("SELECT 1"),
}));

import { cleanupBrowserUploadSessions, expireBrowserUploadSessions, registerR2CrudRoutes } from "../src/worker/r2-crud";
import { drainThumbnailCleanup, thumbnailObjectKey } from "../src/worker/image-thumbnails";

type TestApp = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;

interface StoredObject {
  key: string;
  version: string;
  etag: string;
  httpEtag: string;
  size: number;
  uploaded: Date;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  storageClass: "Standard";
  checksums: Record<string, never>;
  bytes: Uint8Array;
}

interface MultipartState {
  key: string;
  uploadId: string;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  parts: Map<number, { etag: string; bytes: Uint8Array }>;
  aborted: boolean;
}

function sqlFile(url: URL): string {
  return readFileSync(url, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
    .replace(/\s*\n\s*/g, " ");
}

async function bodyBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
}

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, MultipartState>();
  readonly calls = { head: [] as string[], get: [] as string[], put: [] as string[], list: [] as string[],
    create: [] as string[], resume: [] as string[], delete: [] as string[], abort: [] as string[] };
  private sequence = 0;
  abortFailures = 0;

  clearCalls() {
    for (const values of Object.values(this.calls)) values.length = 0;
  }

  seed(key: string, bytes: Uint8Array, contentType = "application/octet-stream", customMetadata: Record<string, string> = {}) {
    const etag = `seed-${++this.sequence}`;
    const stored: StoredObject = {
      key, version: `version-${etag}`, etag, httpEtag: `"${etag}"`, size: bytes.byteLength,
      uploaded: new Date("2026-08-07T12:00:00Z"), httpMetadata: { contentType }, customMetadata,
      storageClass: "Standard", checksums: {}, bytes,
    };
    this.objects.set(key, stored);
    return stored;
  }

  private metadata(stored: StoredObject) {
    const { bytes: _bytes, ...metadata } = stored;
    return metadata;
  }

  async head(key: string) {
    this.calls.head.push(key);
    const stored = this.objects.get(key);
    return stored ? this.metadata(stored) : null;
  }

  async get(key: string) {
    this.calls.get.push(key);
    const stored = this.objects.get(key);
    if (!stored) return null;
    const copy = Uint8Array.from(stored.bytes);
    return {
      ...this.metadata(stored),
      body: new Blob([copy.buffer]).stream(),
      bodyUsed: false,
      async arrayBuffer() { return Uint8Array.from(stored.bytes).buffer; },
      async text() { return new TextDecoder().decode(stored.bytes); },
      async json<T>() { return JSON.parse(new TextDecoder().decode(stored.bytes)) as T; },
      async blob() { return new Blob([Uint8Array.from(stored.bytes).buffer]); },
      writeHttpMetadata() {},
    };
  }

  async put(key: string, value: unknown, options: R2PutOptions = {}) {
    this.calls.put.push(key);
    const current = this.objects.get(key);
    const condition = options.onlyIf instanceof Headers ? options.onlyIf : null;
    if (condition?.get("If-None-Match") === "*" && current) return null;
    if (condition?.has("If-Match") && current?.httpEtag !== condition.get("If-Match")) return null;
    const bytes = await bodyBytes(value);
    const contentType = options.httpMetadata instanceof Headers
      ? options.httpMetadata.get("content-type") || "application/octet-stream"
      : options.httpMetadata?.contentType || "application/octet-stream";
    return this.seed(key, bytes, contentType, options.customMetadata || {});
  }

  async delete(key: string | string[]) {
    for (const item of Array.isArray(key) ? key : [key]) {
      this.calls.delete.push(item);
      this.objects.delete(item);
    }
  }

  async list(options: { prefix?: string }) {
    this.calls.list.push(options.prefix || "");
    return {
      objects: [...this.objects.values()].filter(item => item.key.startsWith(options.prefix || "")).map(item => this.metadata(item)),
      delimitedPrefixes: [], truncated: false,
    };
  }

  private handle(state: MultipartState) {
    const bucket = this;
    return {
      key: state.key,
      uploadId: state.uploadId,
      async uploadPart(partNumber: number, value: unknown) {
        const bytes = await bodyBytes(value);
        const etag = `part-${partNumber}-${bytes.byteLength}`;
        state.parts.set(partNumber, { etag, bytes });
        return { partNumber, etag };
      },
      async complete(parts: R2UploadedPart[]) {
        const chunks = parts.map(part => state.parts.get(part.partNumber)?.bytes || new Uint8Array());
        const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bucket.seed(state.key, bytes, state.httpMetadata.contentType, state.customMetadata);
      },
      async abort() {
        bucket.calls.abort.push(state.key);
        if (bucket.abortFailures > 0) {
          bucket.abortFailures -= 1;
          throw new Error("synthetic transient multipart abort failure");
        }
        state.aborted = true;
      },
    };
  }

  async createMultipartUpload(key: string, options: R2MultipartOptions = {}) {
    this.calls.create.push(key);
    const httpMetadata = options.httpMetadata instanceof Headers
      ? { contentType: options.httpMetadata.get("content-type") || undefined }
      : options.httpMetadata || {};
    const state: MultipartState = {
      key, uploadId: `upload-${++this.sequence}`, httpMetadata,
      customMetadata: options.customMetadata || {}, parts: new Map(), aborted: false,
    };
    this.uploads.set(state.uploadId, state);
    return this.handle(state);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    this.calls.resume.push(key);
    const state = this.uploads.get(uploadId);
    if (!state || state.key !== key) throw new Error("Unknown multipart upload");
    return this.handle(state);
  }
}

describe("authenticated browser delivery uploads", () => {
  let miniflare: Miniflare;
  let opsDb: D1Database;
  let deliveryDb: D1Database;
  let bucket: FakeBucket;
  let queueSend: ReturnType<typeof vi.fn>;
  let env: Env;
  const admin: StaffPrincipal = {
    id: "staff-admin", email: "admin@example.test", displayName: "Admin", accessSubject: "access-admin", projectAlphaUserId: null,
  };

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-08-04", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { OPS_DB: "browser-upload-ops", DELIVERY_DB: "browser-upload-delivery" },
    });
    opsDb = await miniflare.getD1Database("OPS_DB") as unknown as D1Database;
    deliveryDb = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    for (const name of ["0001_operations.sql", "0011_r2_crud_jobs.sql", "0018_browser_upload_intents.sql"]) {
      const sql = sqlFile(new URL(`../migrations/${name}`, import.meta.url));
      // The route fixture mocks ACL evaluation, so it needs the 0011 tables but
      // not its role-grant seed statements (which depend on the separate seed migration).
      await opsDb.exec(name === "0011_r2_crud_jobs.sql"
        ? sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS local_staff_role_assignments"))
        : sql);
    }
    await deliveryDb.exec("CREATE TABLE file_index (r2_key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at TEXT NOT NULL, content_type TEXT, media_kind TEXT NOT NULL, stream_uid TEXT, stream_status TEXT, stream_upload_url TEXT, stream_upload_offset INTEGER NOT NULL DEFAULT 0, stream_error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));");
    for (const name of ["0106_image_thumbnail_jobs.sql", "0107_thumbnail_cleanup_jobs.sql", "0108_thumbnail_backfill_runs.sql"]) {
      await deliveryDb.exec(sqlFile(new URL(`../../client/migrations/${name}`, import.meta.url)));
    }
  });

  afterAll(async () => miniflare.dispose());

  beforeEach(async () => {
    await opsDb.exec("DELETE FROM r2_upload_parts; DELETE FROM r2_upload_sessions; DELETE FROM browser_upload_intent_files; DELETE FROM browser_upload_intents; DELETE FROM r2_replacement_recovery; DELETE FROM project_folders; DELETE FROM staff_users; DELETE FROM divisions;");
    await deliveryDb.exec("DELETE FROM image_thumbnail_jobs; DELETE FROM file_index;");
    await opsDb.prepare("INSERT INTO divisions(id,name,code) VALUES('division-acme','Acme Division','ACME')").run();
    await opsDb.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)")
      .bind(admin.id, admin.email, admin.displayName, admin.accessSubject).run();
    await opsDb.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by)
      VALUES('project-acme','division-acme','Jobs/Clients/Acme/','manual',?)`).bind(admin.id).run();
    bucket = new FakeBucket();
    queueSend = vi.fn(async () => undefined);
    env = {
      OPS_DB: opsDb, DELIVERY_DB: deliveryDb, DATA_BUCKET: bucket as never,
      THUMBNAIL_QUEUE: { send: queueSend } as never,
      DIRECT_DELIVERY_UPLOADS_ENABLED: "true",
    } as unknown as Env;
    acl.requirePermission.mockReset();
    acl.requirePermission.mockResolvedValue(undefined);
  });

  function app(principal: StaffPrincipal = admin, administrator = true) {
    const instance = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
    instance.use("*", async (c, next) => {
      c.set("principal", principal);
      c.set("administrator", administrator);
      await next();
    });
    registerR2CrudRoutes(instance as never);
    return instance;
  }

  function jsonRequest(instance: TestApp, path: string, body: unknown, idempotencyKey?: string) {
    return instance.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: JSON.stringify(body),
    }, env);
  }

  const manifest = (files: unknown[], collisionPolicy = "fail") => ({
    rootPrefix: "Jobs/Clients/Acme/Delivery/", collisionPolicy, files,
  });

  async function createIntent(instance: TestApp, files: unknown[], key = "browser_upload_test_key_0001", collisionPolicy = "fail") {
    const response = await jsonRequest(instance, "/api/delivery/uploads/intents", manifest(files, collisionPolicy), key);
    const text = await response.text();
    let body = {} as { intentId: string; status: string; fileCount: number; totalBytes: number };
    try { body = JSON.parse(text) as typeof body; } catch { /* Hono renders uncaught HTTPException messages as text. */ }
    return { response, body };
  }

  async function createFourByteSession(instance: TestApp, relativePath: string, idempotencyKey: string, collisionPolicy = "replace") {
    const intent = await createIntent(instance, [{ relativePath, size: 4, contentType: "image/jpeg" }], idempotencyKey, collisionPolicy);
    expect(intent.response.status).toBe(201);
    const response = await jsonRequest(instance, "/api/delivery/uploads", { intentId: intent.body.intentId, ordinal: 0 });
    expect(response.status).toBe(201);
    const session = await response.json() as {sessionId:string};
    const part = await instance.request(`/api/delivery/uploads/${session.sessionId}/parts/1`, {
      method: "PUT", headers: { "Content-Length": "4", "Content-Type": "application/octet-stream" },
      body: Uint8Array.from([1, 2, 3, 4]),
    }, env);
    expect(part.status).toBe(200);
    return session;
  }

  function interceptCompletionClaim(beforeClaim: () => Promise<void>) {
    const original = opsDb;
    let intercepted = false;
    env = {
      ...env,
      OPS_DB: new Proxy(original, {
        get(target, property) {
          if (property !== "prepare") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("SET status='completing'")) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "bind") {
                  const value = Reflect.get(statementTarget, statementProperty);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...values: unknown[]) => {
                  const bound = statementTarget.bind(...values);
                  return new Proxy(bound, {
                    get(boundTarget, boundProperty) {
                      if (boundProperty === "run") return async () => {
                        if (!intercepted) {
                          intercepted = true;
                          await beforeClaim();
                        }
                        return boundTarget.run();
                      };
                      const value = Reflect.get(boundTarget, boundProperty);
                      return typeof value === "function" ? value.bind(boundTarget) : value;
                    },
                  });
                };
              },
            });
          };
        },
      }) as unknown as D1Database,
    };
  }

  it("creates single and folder intents and replays only an identical idempotent manifest", async () => {
    const instance = app();
    const files = [
      { relativePath: "cover.jpg", size: 4, contentType: "image/jpeg" },
      { relativePath: "nested/detail.png", size: 5, contentType: "image/png" },
    ];
    const created = await createIntent(instance, files);
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ status: "active", fileCount: 2, totalBytes: 9 });
    const rows = await opsDb.prepare("SELECT ordinal,relative_path,object_key FROM browser_upload_intent_files ORDER BY ordinal")
      .all<{ordinal:number;relative_path:string;object_key:string}>();
    expect(rows.results).toEqual([
      { ordinal: 0, relative_path: "cover.jpg", object_key: "Jobs/Clients/Acme/Delivery/cover.jpg" },
      { ordinal: 1, relative_path: "nested/detail.png", object_key: "Jobs/Clients/Acme/Delivery/nested/detail.png" },
    ]);

    const replay = await createIntent(instance, files);
    expect(replay.response.status).toBe(200);
    expect(replay.body.intentId).toBe(created.body.intentId);
    const mismatch = await createIntent(instance, [{ ...files[0] as object, size: 6 }]);
    expect(mismatch.response.status).toBe(409);
    expect(bucket.calls.create).toEqual([]);
  });

  it("rejects malicious paths, active content, duplicate relative paths, and oversized file counts", async () => {
    const instance = app();
    const cases = [
      manifest([{ relativePath: "../escape.jpg", size: 1, contentType: "image/jpeg" }]),
      manifest([{ relativePath: "nested\\escape.jpg", size: 1, contentType: "image/jpeg" }]),
      manifest([{ relativePath: "page.html", size: 1, contentType: "text/html" }]),
      manifest([
        { relativePath: "same.jpg", size: 1, contentType: "image/jpeg" },
        { relativePath: "same.jpg", size: 1, contentType: "image/jpeg" },
      ]),
      manifest(Array.from({ length: 101 }, (_, index) => ({ relativePath: `${index}.jpg`, size: 1, contentType: "image/jpeg" }))),
    ];
    for (const [index, body] of cases.entries()) {
      const response = await jsonRequest(instance, "/api/delivery/uploads/intents", body, `browser_validation_key_${String(index).padStart(16, "0")}`);
      expect([400, 415]).toContain(response.status);
    }
    expect(bucket.calls.head).toEqual([]);
    expect(bucket.calls.get).toEqual([]);
    expect(bucket.calls.create).toEqual([]);
    expect((await opsDb.prepare("SELECT COUNT(*) count FROM browser_upload_intents").first<{count:number}>())?.count).toBe(0);
  });

  it("denies revoked, cross-client, and public-shaped principals before any R2 access", async () => {
    acl.requirePermission.mockImplementation(async (_env: Env, principal: StaffPrincipal, _permission: unknown, context: {divisionId?:string|null}) => {
      if (principal.id === "revoked" || principal.id === "public-share" ||
        (principal.id === "cross-client" && context.divisionId === "division-acme")) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
    });
    for (const id of ["revoked", "cross-client", "public-share"]) {
      const principal = { ...admin, id, email: `${id}@example.test`, accessSubject: `subject-${id}` };
      const response = await createIntent(app(principal), [{ relativePath: "denied.jpg", size: 4, contentType: "image/jpeg" }], `browser_denied_key_${id.padEnd(16, "0")}`);
      expect(response.response.status).toBe(403);
    }
    expect(bucket.calls.head).toEqual([]);
    expect(bucket.calls.get).toEqual([]);
    expect(bucket.calls.list).toEqual([]);
    expect(bucket.calls.create).toEqual([]);
    expect((await opsDb.prepare("SELECT COUNT(*) count FROM browser_upload_intents").first<{count:number}>())?.count).toBe(0);
  });

  it("resumes a private multipart upload, validates part size, checkpoints, and enqueues one thumbnail", async () => {
    const instance = app();
    const intent = await createIntent(instance, [{ relativePath: "photo.jpg", size: 4, contentType: "image/jpeg" }]);
    const sessionResponse = await jsonRequest(instance, "/api/delivery/uploads", { intentId: intent.body.intentId, ordinal: 0 });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { sessionId:string; key:string; partSize:number; status:string };
    expect(session).toMatchObject({ key: "Jobs/Clients/Acme/Delivery/photo.jpg", partSize: 32 * 1024 ** 2, status: "active" });
    expect(bucket.calls.create).toHaveLength(1);
    expect(bucket.calls.create[0]).toMatch(/^_ltds\/browser-uploads\//);

    const sessionReplay = await jsonRequest(instance, "/api/delivery/uploads", { intentId: intent.body.intentId, ordinal: 0 });
    expect(sessionReplay.status).toBe(200);
    expect((await sessionReplay.json() as {sessionId:string}).sessionId).toBe(session.sessionId);
    expect(bucket.calls.create).toHaveLength(1);

    const badPart = await instance.request(`/api/delivery/uploads/${session.sessionId}/parts/1`, {
      method: "PUT", headers: { "Content-Length": "3", "Content-Type": "application/octet-stream" }, body: Uint8Array.from([1, 2, 3]),
    }, env);
    expect(badPart.status).toBe(400);
    expect(bucket.calls.resume).toEqual([]);

    const part = await instance.request(`/api/delivery/uploads/${session.sessionId}/parts/1`, {
      method: "PUT", headers: { "Content-Length": "4", "Content-Type": "application/octet-stream" }, body: Uint8Array.from([1, 2, 3, 4]),
    }, env);
    expect(part.status).toBe(200);
    expect(await part.json()).toMatchObject({ partNumber: 1, size: 4 });

    const checkpoint = await instance.request(`/api/delivery/uploads/${session.sessionId}`, {}, env);
    expect(checkpoint.status).toBe(200);
    expect(await checkpoint.json()).toMatchObject({
      sessionId: session.sessionId, status: "active", parts: [{ partNumber: 1, size: 4 }],
    });

    const completed = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ status: "completed", key: "Jobs/Clients/Acme/Delivery/photo.jpg" });
    expect(bucket.objects.get("Jobs/Clients/Acme/Delivery/photo.jpg")?.bytes).toEqual(Uint8Array.from([1, 2, 3, 4]));
    expect(await deliveryDb.prepare("SELECT r2_key,media_kind FROM file_index WHERE r2_key=?")
      .bind("Jobs/Clients/Acme/Delivery/photo.jpg").first()).toEqual({ r2_key: "Jobs/Clients/Acme/Delivery/photo.jpg", media_kind: "image" });
    expect(queueSend).toHaveBeenCalledOnce();
    expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({
      kind: "image-thumbnail.v1", sourceKey: "Jobs/Clients/Acme/Delivery/photo.jpg",
    }));
    expect(await deliveryDb.prepare("SELECT status,queue_published_at FROM image_thumbnail_jobs WHERE source_key=?")
      .bind("Jobs/Clients/Acme/Delivery/photo.jpg").first()).toMatchObject({ status: "pending", queue_published_at: expect.any(String) });

    const completionReplay = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(completionReplay.status).toBe(200);
    expect(queueSend).toHaveBeenCalledOnce();
  });

  it("applies fail and rename collision policies before creating a staging upload", async () => {
    const existing = "Jobs/Clients/Acme/Delivery/existing.jpg";
    bucket.seed(existing, Uint8Array.from([9]), "image/jpeg");
    const instance = app();
    const failedIntent = await createIntent(instance, [{ relativePath: "existing.jpg", size: 4, contentType: "image/jpeg" }], "browser_collision_fail_0001", "fail");
    const failedSession = await jsonRequest(instance, "/api/delivery/uploads", { intentId: failedIntent.body.intentId, ordinal: 0 });
    expect(failedSession.status).toBe(409);
    expect(bucket.calls.create).toEqual([]);

    const renamedIntent = await createIntent(instance, [{ relativePath: "existing.jpg", size: 4, contentType: "image/jpeg" }], "browser_collision_rename_01", "rename");
    const renamedSession = await jsonRequest(instance, "/api/delivery/uploads", { intentId: renamedIntent.body.intentId, ordinal: 0 });
    expect(renamedSession.status).toBe(201);
    expect(await renamedSession.json()).toMatchObject({ key: "Jobs/Clients/Acme/Delivery/existing (2).jpg" });
    expect(bucket.objects.get(existing)?.bytes).toEqual(Uint8Array.from([9]));
  });

  it("atomically admits only one of two concurrent requests for the tenth owner slot", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const expired = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await opsDb.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES('other-owner','other@example.test','Other','other-subject')").run();
    const sessions = [];
    for (let index = 0; index < 9; index += 1) {
      sessions.push(opsDb.prepare(`INSERT INTO r2_upload_sessions
        (id,upload_id,object_key,expected_size,content_type,created_by,expires_at)
        VALUES(?,?,?,?,?,?,?)`).bind(`existing-${index}`, `existing-upload-${index}`,
        `Jobs/Clients/Acme/Delivery/existing-${index}.jpg`, 4, "image/jpeg", admin.id, future));
    }
    // An expired row for this owner and active rows for another owner must not
    // consume the administrator's remaining slot.
    sessions.push(opsDb.prepare(`INSERT INTO r2_upload_sessions
      (id,upload_id,object_key,expected_size,content_type,created_by,expires_at)
      VALUES('expired-owner-row','expired-owner-upload','Jobs/Clients/Acme/Delivery/expired.jpg',4,'image/jpeg',?,?)`)
      .bind(admin.id, expired));
    for (let index = 0; index < 3; index += 1) {
      sessions.push(opsDb.prepare(`INSERT INTO r2_upload_sessions
        (id,upload_id,object_key,expected_size,content_type,created_by,expires_at)
        VALUES(?,?,?,?,?,'other-owner',?)`).bind(`other-${index}`, `other-upload-${index}`,
        `Jobs/Clients/Other/file-${index}.jpg`, 4, "image/jpeg", future));
    }
    await opsDb.batch(sessions);

    const instance = app();
    const first = await createIntent(instance, [{ relativePath: "slot-a.jpg", size: 4, contentType: "image/jpeg" }], "browser_slot_race_a_001");
    const second = await createIntent(instance, [{ relativePath: "slot-b.jpg", size: 4, contentType: "image/jpeg" }], "browser_slot_race_b_001");
    bucket.clearCalls();
    const responses = await Promise.all([
      jsonRequest(instance, "/api/delivery/uploads", { intentId: first.body.intentId, ordinal: 0 }),
      jsonRequest(instance, "/api/delivery/uploads", { intentId: second.body.intentId, ordinal: 0 }),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([201, 429]);
    expect(await opsDb.prepare(`SELECT COUNT(*) count FROM r2_upload_sessions
      WHERE created_by=? AND status IN ('active','completing') AND datetime(expires_at)>datetime('now')`)
      .bind(admin.id).first()).toEqual({ count: 10 });
    expect(await opsDb.prepare(`SELECT COUNT(*) count FROM r2_upload_sessions
      WHERE intent_id IN (?,?)`).bind(first.body.intentId, second.body.intentId).first()).toEqual({ count: 1 });
    expect(await opsDb.prepare(`SELECT COUNT(*) count FROM browser_upload_intent_files
      WHERE intent_id IN (?,?) AND session_id IS NOT NULL`).bind(first.body.intentId, second.body.intentId).first()).toEqual({ count: 1 });
    expect(bucket.calls.create).toHaveLength(2);
    expect(bucket.calls.abort).toHaveLength(1);
  });

  it("replaces through private recovery and retires the prior thumbnail version", async () => {
    const key = "Jobs/Clients/Acme/Delivery/replaced.jpg";
    const previous = bucket.seed(key, Uint8Array.from([9]), "image/jpeg");
    const previousThumbnailKey = await thumbnailObjectKey(key, previous.httpEtag);
    const previousThumbnail = bucket.seed(previousThumbnailKey, Uint8Array.from([8]), "image/webp", {
      sourceEtag: previous.httpEtag,
    });
    await deliveryDb.prepare(`INSERT INTO image_thumbnail_jobs(
      source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,last_event_at,ready_at)
      VALUES(?,?,?,?,?,?,'ready',datetime('now','-1 day'),datetime('now','-1 day'))`)
      .bind(key, previous.httpEtag, previous.size, previousThumbnailKey, previousThumbnail.httpEtag, previousThumbnail.size).run();

    const instance = app();
    const intent = await createIntent(instance, [{ relativePath: "replaced.jpg", size: 4, contentType: "image/jpeg" }],
      "browser_collision_replace_1", "replace");
    const sessionResponse = await jsonRequest(instance, "/api/delivery/uploads", { intentId: intent.body.intentId, ordinal: 0 });
    const session = await sessionResponse.json() as {sessionId:string};
    const part = await instance.request(`/api/delivery/uploads/${session.sessionId}/parts/1`, {
      method: "PUT", headers: { "Content-Length": "4", "Content-Type": "application/octet-stream" },
      body: Uint8Array.from([1, 2, 3, 4]),
    }, env);
    expect(part.status).toBe(200);
    const completed = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(completed.status).toBe(200);

    expect(bucket.objects.get(key)?.bytes).toEqual(Uint8Array.from([1, 2, 3, 4]));
    const recovery = await opsDb.prepare("SELECT original_key,recovery_key,replacement_result_etag FROM r2_replacement_recovery WHERE original_key=?")
      .bind(key).first<{original_key:string;recovery_key:string;replacement_result_etag:string}>();
    expect(recovery?.original_key).toBe(key);
    expect(recovery?.replacement_result_etag).toBe(bucket.objects.get(key)?.httpEtag);
    expect(bucket.objects.get(recovery!.recovery_key)?.bytes).toEqual(Uint8Array.from([9]));
    await drainThumbnailCleanup(env);
    expect(bucket.objects.has(previousThumbnailKey)).toBe(false);
    expect(await deliveryDb.prepare("SELECT source_etag,status,queue_published_at FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(key).first()).toMatchObject({ status: "pending", queue_published_at: expect.any(String) });
    expect(queueSend).toHaveBeenCalledOnce();
  });

  it("restores only the exact replacement result and refreshes the indexed thumbnail lifecycle", async () => {
    const key = "Jobs/Clients/Acme/Delivery/restorable.jpg";
    const original = bucket.seed(key, Uint8Array.from([9]), "image/jpeg");
    const instance = app();
    const session = await createFourByteSession(instance, "restorable.jpg", "browser_restore_exact_result_1");
    expect((await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {})).status).toBe(200);
    const recovery = await opsDb.prepare("SELECT id,recovery_key,replacement_result_etag FROM r2_replacement_recovery WHERE original_key=?")
      .bind(key).first<{id:string;recovery_key:string;replacement_result_etag:string}>();
    expect(recovery?.replacement_result_etag).toBe(bucket.objects.get(key)?.httpEtag);
    queueSend.mockClear();

    const restoredResponse = await jsonRequest(instance, `/api/delivery/fs/replacements/${recovery!.id}/restore`, {});
    expect(restoredResponse.status).toBe(200);
    const restored = bucket.objects.get(key)!;
    expect(restored.bytes).toEqual(Uint8Array.from([9]));
    expect(restored.httpEtag).not.toBe(original.httpEtag);
    expect(restored.customMetadata.replacementRecoveryRestore).toBe(recovery!.id);
    expect(bucket.objects.has(recovery!.recovery_key)).toBe(false);
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM r2_replacement_recovery WHERE id=?").bind(recovery!.id).first()).toEqual({ count: 0 });
    expect(await deliveryDb.prepare("SELECT etag,size,content_type,media_kind FROM file_index WHERE r2_key=?").bind(key).first())
      .toEqual({ etag: restored.httpEtag, size: 1, content_type: "image/jpeg", media_kind: "image" });
    expect(queueSend).toHaveBeenCalledOnce();
    expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: key, sourceEtag: restored.etag }));
  });

  it("preserves recovery when a newer writer wins before restore", async () => {
    const key = "Jobs/Clients/Acme/Delivery/restore-conflict.jpg";
    bucket.seed(key, Uint8Array.from([9]), "image/jpeg");
    const instance = app();
    const session = await createFourByteSession(instance, "restore-conflict.jpg", "browser_restore_conflict_01");
    expect((await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {})).status).toBe(200);
    const recovery = await opsDb.prepare("SELECT id,recovery_key FROM r2_replacement_recovery WHERE original_key=?")
      .bind(key).first<{id:string;recovery_key:string}>();
    const winner = bucket.seed(key, Uint8Array.from([7, 7]), "image/jpeg");
    bucket.clearCalls();
    queueSend.mockClear();

    const response = await jsonRequest(instance, `/api/delivery/fs/replacements/${recovery!.id}/restore`, {});
    expect(response.status).toBe(409);
    expect(bucket.objects.get(key)).toMatchObject({ httpEtag: winner.httpEtag, bytes: Uint8Array.from([7, 7]) });
    expect(bucket.objects.has(recovery!.recovery_key)).toBe(true);
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM r2_replacement_recovery WHERE id=?").bind(recovery!.id).first()).toEqual({ count: 1 });
    expect(bucket.calls.get).not.toContain(recovery!.recovery_key);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("filters replacement recovery listings by current division scope without R2 access", async () => {
    await opsDb.prepare("INSERT INTO divisions(id,name,code) VALUES('division-other','Other Division','OTHER')").run();
    await opsDb.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by)
      VALUES('project-other','division-other','Jobs/Clients/Other/','manual',?)`).bind(admin.id).run();
    await opsDb.batch([
      opsDb.prepare("INSERT INTO r2_replacement_recovery(id,original_key,recovery_key,replacement_result_etag,purge_after) VALUES('recovery-acme','Jobs/Clients/Acme/Delivery/a.jpg','Jobs/Clients/_ltds/replacements/a/a.jpg','\"a\"',datetime('now','+7 days'))"),
      opsDb.prepare("INSERT INTO r2_replacement_recovery(id,original_key,recovery_key,replacement_result_etag,purge_after) VALUES('recovery-other','Jobs/Clients/Other/Delivery/b.jpg','Jobs/Clients/_ltds/replacements/b/b.jpg','\"b\"',datetime('now','+7 days'))"),
    ]);
    const scoped = { ...admin, id: "scoped", email: "scoped@example.test", accessSubject: "scoped-subject" };
    acl.requirePermission.mockImplementation(async (_env: Env, principal: StaffPrincipal, _permission: unknown, context?: {divisionId?:string|null}) => {
      if (principal.id === "revoked" || context?.divisionId !== "division-acme") throw new HTTPException(403, { message: "Forbidden" });
    });
    bucket.clearCalls();
    const scopedResponse = await app(scoped, false).request("/api/delivery/fs/replacements", {}, env);
    expect(scopedResponse.status).toBe(200);
    expect(await scopedResponse.json()).toEqual({ items: [expect.objectContaining({ id: "recovery-acme", original_key: "Jobs/Clients/Acme/Delivery/a.jpg" })] });

    const revoked = { ...scoped, id: "revoked" };
    const revokedResponse = await app(revoked, false).request("/api/delivery/fs/replacements", {}, env);
    expect(revokedResponse.status).toBe(200);
    expect(await revokedResponse.json()).toEqual({ items: [] });
    expect((await jsonRequest(app(scoped, false), "/api/delivery/fs/replacements/recovery-other/restore", {})).status).toBe(403);
    expect((await jsonRequest(app(revoked, false), "/api/delivery/fs/replacements/recovery-acme/restore", {})).status).toBe(403);
    expect(bucket.calls.head).toEqual([]);
    expect(bucket.calls.get).toEqual([]);
    expect(bucket.calls.list).toEqual([]);
  });

  it("removes a recovery object if its durable ledger write fails before publication", async () => {
    const key = "Jobs/Clients/Acme/Delivery/recovery-ledger-failure.jpg";
    const previous = bucket.seed(key, Uint8Array.from([9]), "image/jpeg");
    const instance = app();
    const session = await createFourByteSession(instance, "recovery-ledger-failure.jpg", "browser_recovery_ledger_fail_1");
    const originalOpsDb = env.OPS_DB;
    env = {
      ...env,
      OPS_DB: new Proxy(originalOpsDb, {
        get(target, property) {
          if (property !== "prepare") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("INSERT INTO r2_replacement_recovery")) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "bind") {
                  const value = Reflect.get(statementTarget, statementProperty);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...values: unknown[]) => {
                  const bound = statementTarget.bind(...values);
                  return new Proxy(bound, {
                    get(boundTarget, boundProperty) {
                      if (boundProperty === "run") return async () => { throw new Error("synthetic recovery ledger outage"); };
                      const value = Reflect.get(boundTarget, boundProperty);
                      return typeof value === "function" ? value.bind(boundTarget) : value;
                    },
                  });
                };
              },
            });
          };
        },
      }) as unknown as D1Database,
    };

    const completed = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(completed.status).toBe(500);
    expect(bucket.objects.get(key)).toMatchObject({ httpEtag: previous.httpEtag, bytes: Uint8Array.from([9]) });
    expect([...bucket.objects.keys()].filter(candidate => candidate.startsWith("Jobs/Clients/_ltds/replacements/"))).toEqual([]);
    expect(await originalOpsDb.prepare("SELECT COUNT(*) count FROM r2_replacement_recovery").first()).toEqual({ count: 0 });
    expect(await originalOpsDb.prepare("SELECT status,completion_claimed_at FROM r2_upload_sessions WHERE id=?").bind(session.sessionId).first())
      .toEqual({ status: "active", completion_claimed_at: null });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("rejects a stale replace after another writer publishes over the captured ETag", async () => {
    const key = "Jobs/Clients/Acme/Delivery/raced-present.jpg";
    bucket.seed(key, Uint8Array.from([9]), "image/jpeg");
    const instance = app();
    const session = await createFourByteSession(instance, "raced-present.jpg", "browser_replace_race_present_1");
    const baseline = await opsDb.prepare("SELECT destination_baseline FROM r2_upload_sessions WHERE id=?")
      .bind(session.sessionId).first<{destination_baseline:string}>();
    expect(baseline?.destination_baseline).toMatch(/^etag:/);

    const publishedByB = bucket.seed(key, Uint8Array.from([7, 7, 7, 7]), "image/jpeg");
    const thumbnailKey = await thumbnailObjectKey(key, publishedByB.httpEtag);
    const thumbnail = bucket.seed(thumbnailKey, Uint8Array.from([6]), "image/webp", { sourceEtag: publishedByB.httpEtag });
    await deliveryDb.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,?,?,?)`).bind(key, publishedByB.httpEtag, publishedByB.size, publishedByB.uploaded.toISOString(), "image/jpeg", "image").run();
    await deliveryDb.prepare(`INSERT INTO image_thumbnail_jobs(
      source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,last_event_at,ready_at)
      VALUES(?,?,?,?,?,?,'ready',datetime('now'),datetime('now'))`)
      .bind(key, publishedByB.httpEtag, publishedByB.size, thumbnailKey, thumbnail.httpEtag, thumbnail.size).run();

    const completed = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(completed.status).toBe(409);
    expect(bucket.objects.get(key)).toMatchObject({ httpEtag: publishedByB.httpEtag, bytes: Uint8Array.from([7, 7, 7, 7]) });
    expect(bucket.objects.has(thumbnailKey)).toBe(true);
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM r2_replacement_recovery").first()).toEqual({ count: 0 });
    expect(await opsDb.prepare("SELECT status,completion_claimed_at FROM r2_upload_sessions WHERE id=?").bind(session.sessionId).first())
      .toEqual({ status: "active", completion_claimed_at: null });
    expect(await deliveryDb.prepare("SELECT etag,size FROM file_index WHERE r2_key=?").bind(key).first())
      .toEqual({ etag: publishedByB.httpEtag, size: 4 });
    expect(await deliveryDb.prepare("SELECT source_etag,status FROM image_thumbnail_jobs WHERE source_key=?").bind(key).first())
      .toEqual({ source_etag: publishedByB.httpEtag, status: "ready" });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("rejects a stale replace when its captured absent destination is created before completion", async () => {
    const key = "Jobs/Clients/Acme/Delivery/raced-absent.jpg";
    const instance = app();
    const session = await createFourByteSession(instance, "raced-absent.jpg", "browser_replace_race_absent_01");
    expect(await opsDb.prepare("SELECT destination_baseline FROM r2_upload_sessions WHERE id=?").bind(session.sessionId).first())
      .toEqual({ destination_baseline: "absent" });

    const publishedByB = bucket.seed(key, Uint8Array.from([5, 5, 5, 5]), "image/jpeg");
    await deliveryDb.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,?,?,?)`).bind(key, publishedByB.httpEtag, publishedByB.size, publishedByB.uploaded.toISOString(), "image/jpeg", "image").run();

    const completed = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(completed.status).toBe(409);
    expect(bucket.objects.get(key)).toMatchObject({ httpEtag: publishedByB.httpEtag, bytes: Uint8Array.from([5, 5, 5, 5]) });
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM r2_replacement_recovery").first()).toEqual({ count: 0 });
    expect(await deliveryDb.prepare("SELECT etag,size FROM file_index WHERE r2_key=?").bind(key).first())
      .toEqual({ etag: publishedByB.httpEtag, size: 4 });
    expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM image_thumbnail_jobs").first()).toEqual({ count: 0 });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("does not publish when cancellation atomically wins the completion claim race", async () => {
    const instance = app();
    const session = await createFourByteSession(instance, "cancel-race.jpg", "browser_cancel_race_0001", "fail");
    const finalKey = "Jobs/Clients/Acme/Delivery/cancel-race.jpg";
    let cancellation: Response | undefined;
    interceptCompletionClaim(async () => {
      cancellation = await instance.request(`/api/delivery/uploads/${session.sessionId}`, { method: "DELETE" }, env);
    });

    const completion = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(cancellation?.status).toBe(200);
    expect(completion.status).toBe(409);
    expect(bucket.objects.has(finalKey)).toBe(false);
    expect(await opsDb.prepare("SELECT status,completion_claimed_at FROM r2_upload_sessions WHERE id=?")
      .bind(session.sessionId).first()).toEqual({ status: "aborted", completion_claimed_at: null });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("does not publish when expiry atomically wins the completion claim race", async () => {
    const instance = app();
    const session = await createFourByteSession(instance, "expiry-race.jpg", "browser_expiry_race_0001", "fail");
    const row = await opsDb.prepare("SELECT intent_id FROM r2_upload_sessions WHERE id=?")
      .bind(session.sessionId).first<{intent_id:string}>();
    const finalKey = "Jobs/Clients/Acme/Delivery/expiry-race.jpg";
    let expired = 0;
    interceptCompletionClaim(async () => {
      await opsDb.prepare("UPDATE r2_upload_sessions SET expires_at='2000-01-01T00:00:00Z' WHERE id=?")
        .bind(session.sessionId).run();
      await opsDb.prepare("UPDATE browser_upload_intents SET expires_at='2000-01-01T00:00:00Z' WHERE id=?")
        .bind(row!.intent_id).run();
      expired = await expireBrowserUploadSessions(env, 1);
    });

    const completion = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(expired).toBe(1);
    expect(completion.status).toBe(409);
    expect(bucket.objects.has(finalKey)).toBe(false);
    expect(await opsDb.prepare("SELECT status,completion_claimed_at FROM r2_upload_sessions WHERE id=?")
      .bind(session.sessionId).first()).toEqual({ status: "expired", completion_claimed_at: null });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("durably retries transient terminal staging cleanup without reopening completion", async () => {
    const instance = app();
    const session = await createFourByteSession(instance, "cleanup-retry.jpg", "browser_cleanup_retry_0001", "fail");
    const row = await opsDb.prepare("SELECT staging_key FROM r2_upload_sessions WHERE id=?").bind(session.sessionId).first<{staging_key:string}>();
    bucket.abortFailures = 1;

    const completion = await jsonRequest(instance, `/api/delivery/uploads/${session.sessionId}/complete`, {});
    expect(completion.status).toBe(200);
    expect(bucket.objects.has(row!.staging_key)).toBe(true);
    expect(await opsDb.prepare("SELECT status,cleanup_status,cleanup_attempts,cleanup_error FROM r2_upload_sessions WHERE id=?")
      .bind(session.sessionId).first()).toMatchObject({
      status: "completed", cleanup_status: "pending", cleanup_attempts: 1,
      cleanup_error: "synthetic transient multipart abort failure",
    });

    await opsDb.prepare("UPDATE r2_upload_sessions SET cleanup_next_attempt_at='2000-01-01T00:00:00Z' WHERE id=?")
      .bind(session.sessionId).run();
    await expect(cleanupBrowserUploadSessions(env, 1)).resolves.toBe(1);
    expect(bucket.objects.has(row!.staging_key)).toBe(false);
    expect(await opsDb.prepare("SELECT status,cleanup_status,cleanup_attempts,cleanup_error FROM r2_upload_sessions WHERE id=?")
      .bind(session.sessionId).first()).toEqual({ status: "completed", cleanup_status: "complete", cleanup_attempts: 2, cleanup_error: null });
  });

  it("reclaims a stale cleanup claim and an expired stale completion lease", async () => {
    const instance = app();
    const cleanupSession = await createFourByteSession(instance, "cleanup-crash.jpg", "browser_cleanup_crash_0001", "fail");
    const cleanupRow = await opsDb.prepare("SELECT staging_key FROM r2_upload_sessions WHERE id=?").bind(cleanupSession.sessionId).first<{staging_key:string}>();
    bucket.seed(cleanupRow!.staging_key, Uint8Array.from([1]), "image/jpeg");
    await opsDb.prepare(`UPDATE r2_upload_sessions SET status='aborted',cleanup_status='pending',cleanup_next_attempt_at=datetime('now'),
      cleanup_claimed_at=datetime('now') WHERE id=?`).bind(cleanupSession.sessionId).run();
    await expect(cleanupBrowserUploadSessions(env, 1)).resolves.toBe(0);
    expect(bucket.objects.has(cleanupRow!.staging_key)).toBe(true);
    await opsDb.prepare("UPDATE r2_upload_sessions SET cleanup_claimed_at=datetime('now','-6 minutes') WHERE id=?")
      .bind(cleanupSession.sessionId).run();
    await expect(cleanupBrowserUploadSessions(env, 1)).resolves.toBe(1);
    expect(bucket.objects.has(cleanupRow!.staging_key)).toBe(false);

    const expiring = await createFourByteSession(instance, "stale-completing.jpg", "browser_stale_completing_1", "fail");
    const expiringRow = await opsDb.prepare("SELECT intent_id FROM r2_upload_sessions WHERE id=?").bind(expiring.sessionId).first<{intent_id:string}>();
    await opsDb.prepare(`UPDATE r2_upload_sessions SET status='completing',expires_at='2000-01-01T00:00:00Z',
      completion_claimed_at=datetime('now','-6 minutes') WHERE id=?`).bind(expiring.sessionId).run();
    await opsDb.prepare("UPDATE browser_upload_intents SET expires_at='2000-01-01T00:00:00Z' WHERE id=?")
      .bind(expiringRow!.intent_id).run();
    await expect(expireBrowserUploadSessions(env, 1)).resolves.toBe(1);
    expect(await opsDb.prepare("SELECT status,completion_claimed_at,cleanup_status FROM r2_upload_sessions WHERE id=?")
      .bind(expiring.sessionId).first()).toEqual({ status: "expired", completion_claimed_at: null, cleanup_status: "complete" });
  });

  it("expires bounded active sessions by aborting multipart state and removing only staging objects", async () => {
    const instance = app();
    const intent = await createIntent(instance, [{ relativePath: "expire.jpg", size: 4, contentType: "image/jpeg" }]);
    const response = await jsonRequest(instance, "/api/delivery/uploads", { intentId: intent.body.intentId, ordinal: 0 });
    const session = await response.json() as {sessionId:string};
    const row = await opsDb.prepare("SELECT staging_key FROM r2_upload_sessions WHERE id=?").bind(session.sessionId).first<{staging_key:string}>();
    bucket.seed(row!.staging_key, Uint8Array.from([1]), "image/jpeg");
    await opsDb.prepare("UPDATE r2_upload_sessions SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").bind(session.sessionId).run();
    await opsDb.prepare("UPDATE browser_upload_intents SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").bind(intent.body.intentId).run();

    await expect(expireBrowserUploadSessions(env, 1)).resolves.toBe(1);
    expect(bucket.calls.abort).toContain(row!.staging_key);
    expect(bucket.calls.delete).toContain(row!.staging_key);
    expect(bucket.objects.has(row!.staging_key)).toBe(false);
    expect(await opsDb.prepare("SELECT status FROM r2_upload_sessions WHERE id=?").bind(session.sessionId).first()).toEqual({ status: "expired" });
    expect(await opsDb.prepare("SELECT status,error_code FROM browser_upload_intent_files WHERE intent_id=? AND ordinal=0")
      .bind(intent.body.intentId).first()).toEqual({ status: "aborted", error_code: "expired" });
  });
});
