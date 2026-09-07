import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/image-thumbnails", () => ({
  canonicalThumbnailSourceKey: vi.fn(() => false),
  enqueueThumbnailJob: vi.fn(async () => undefined),
  removeThumbnailStateForPath: vi.fn(async () => undefined),
  supportedThumbnailSource: vi.fn(() => false),
  thumbnailSourceEligible: vi.fn(() => false),
}));

import { deliveryIndexRecoveryEnabled, prepareDeliveryIndexCreateAcceptance, prepareDeliveryIndexRepair, readDeliveryIndexObservation } from "../src/worker/delivery-index-acceptance";
import { processR2OperationJobs } from "../src/worker/r2-crud";
import { enqueueThumbnailJob, removeThumbnailStateForPath, thumbnailSourceEligible } from "../src/worker/image-thumbnails";
import type { Env } from "../src/worker/types";

interface StoredObject extends R2ObjectBody { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }

describe("provider-aware delivery index repairs — migrated real D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let deliveryDb: D1Database;
  let opsDb: D1Database;
  let counter = 0;

  async function apply(db: D1Database, sql: string) {
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
  }

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "delivery-index-repair", OPS_DB: "delivery-index-repair-ops" } });
    deliveryDb = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    opsDb = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await apply(deliveryDb, `
      CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,uploaded_at TEXT NOT NULL,
        content_type TEXT,media_kind TEXT NOT NULL,stream_uid TEXT,stream_status TEXT,stream_upload_url TEXT,
        stream_upload_offset INTEGER,stream_error TEXT,updated_at TEXT);
      CREATE TABLE image_asset_locations(source_key TEXT PRIMARY KEY,source_etag TEXT NOT NULL);
      CREATE TABLE projects(id TEXT PRIMARY KEY,active INTEGER NOT NULL,r2_prefix TEXT);
      CREATE TABLE shares(id TEXT PRIMARY KEY,project_id TEXT,r2_prefix TEXT,revoked_at TEXT,expires_at TEXT,share_version INTEGER,revoked_reason TEXT);
      CREATE TABLE audit_log(actor_type TEXT,actor_id TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details_json TEXT);
    `);
    await apply(deliveryDb, readFileSync(new URL("../../client/migrations/0206_delivery_index_provider_identity.sql", import.meta.url), "utf8"));
    await apply(opsDb, `
      CREATE TABLE r2_operation_jobs(id TEXT PRIMARY KEY,kind TEXT,status TEXT,requested_by TEXT,source_key TEXT,target_key TEXT,
        conflict_policy TEXT,payload_json TEXT,cursor TEXT,processed_items INTEGER DEFAULT 0,total_items INTEGER,lease_until TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,claim_token TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT,completed_at TEXT,error_code TEXT,error_message TEXT);
      CREATE TABLE r2_replacement_recovery(id TEXT PRIMARY KEY,original_key TEXT,recovery_key TEXT,purge_after TEXT,replacement_result_etag TEXT);
    `);
  }, 180_000);

  beforeEach(async () => {
    await deliveryDb.batch([
      deliveryDb.prepare("DELETE FROM image_asset_locations"),
      deliveryDb.prepare("DELETE FROM file_index"),
    ]);
    await opsDb.prepare("DELETE FROM r2_operation_jobs").run();
    vi.mocked(enqueueThumbnailJob).mockClear();
    vi.mocked(removeThumbnailStateForPath).mockClear();
    vi.mocked(thumbnailSourceEligible).mockReset();
    vi.mocked(thumbnailSourceEligible).mockReturnValue(false);
  });

  afterAll(async () => runtime?.dispose());

  function object(key: string, etag: string, version: string, size = 12): StoredObject {
    const payload = new Response(new Uint8Array(size));
    return { key, etag, version, httpEtag: `"${etag}"`, size, uploaded: new Date("2026-09-07T08:00:00.000Z"),
      httpMetadata: { contentType: "application/octet-stream" }, customMetadata: {}, storageClass: "Standard",
      checksums: { toJSON: () => ({}) },
      writeHttpMetadata(headers) { headers.set("Content-Type", this.httpMetadata.contentType); },
      get body() { return payload.body!; }, get bodyUsed() { return payload.bodyUsed; },
      arrayBuffer: () => payload.arrayBuffer(), bytes: () => payload.bytes(), text: () => payload.text(),
      json: <T>() => payload.json<T>(), blob: () => payload.blob() };
  }

  async function row(key: string) {
    return deliveryDb.prepare(`SELECT file_record.r2_key,file_record.provider_version,file_record.notification_observation_version,file_record.etag,
      file_record.stream_uid,file_record.stream_status,file_record.stream_upload_url,file_record.stream_upload_offset,file_record.stream_error,revisions.revision
      FROM delivery_file_index_revisions revisions LEFT JOIN file_index file_record ON file_record.r2_key=revisions.r2_key
      WHERE revisions.r2_key=?`).bind(key).first<Record<string, unknown>>();
  }

  it("is enabled only when recovery and notification storage are both explicitly enabled", () => {
    expect(deliveryIndexRecoveryEnabled({ AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true", AUTHENTICATED_DELIVERY_RECOVERY_ENABLED: "true" })).toBe(true);
    expect(deliveryIndexRecoveryEnabled({ AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true" })).toBe(false);
    expect(deliveryIndexRecoveryEnabled({ AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "false", AUTHENTICATED_DELIVERY_RECOVERY_ENABLED: "true" })).toBe(false);
  });

  it("writes provider identity while preserving the notification marker and supplied stream state", async () => {
    const key = "Jobs/Clients/repair/marker.bin";
    await deliveryDb.prepare(`INSERT INTO file_index(r2_key,provider_version,notification_observation_version,etag,size,uploaded_at,
      content_type,media_kind,stream_uid,stream_status,stream_upload_url,stream_upload_offset,stream_error)
      VALUES(?,?,?, ?,12,?,'application/octet-stream','other',?,?,?,?,?)`)
      .bind(key, "provider-old", "notification-old", "old-etag", "2026-09-07T08:00:00.000Z", "old-stream", "ready", "https://tus.example.test/old-stream", 8, null).run();
    const primary = deliveryDb.withSession("first-primary");
    const snapshot = await readDeliveryIndexObservation(primary, key);
    await prepareDeliveryIndexRepair(primary, snapshot, object(key, "new-etag", "provider-new"), {
      uid: "copied-stream", status: "pending", error: null,
    }).run();
    expect(await row(key)).toMatchObject({ r2_key: key, provider_version: "provider-new",
      notification_observation_version: "notification-old", etag: "\"new-etag\"",
      stream_uid: "copied-stream", stream_status: "pending", stream_upload_url: "https://tus.example.test/old-stream",
      stream_upload_offset: 8, stream_error: null });

    const resetSnapshot = await readDeliveryIndexObservation(deliveryDb.withSession("first-primary"), key);
    await prepareDeliveryIndexRepair(deliveryDb.withSession("first-primary"), resetSnapshot, object(key, "new-etag", "provider-new"), {
      uid: null, status: null, error: null, uploadUrl: null, uploadOffset: 0,
    }).run();
    expect(await row(key)).toMatchObject({ notification_observation_version: "notification-old",
      stream_uid: null, stream_status: null, stream_upload_url: null, stream_upload_offset: 0, stream_error: null });
  });

  it("applies an explicitly requested resumable-upload reset in the create-acceptance CAS", async () => {
    const key = "Jobs/Clients/repair/create-stream.bin";
    const primary = deliveryDb.withSession("first-primary");
    const snapshot = await readDeliveryIndexObservation(primary, key);
    await prepareDeliveryIndexCreateAcceptance(primary, snapshot, object(key, "created-etag", "provider-created"), {
      uid: null, status: "disabled", error: null, uploadUrl: null, uploadOffset: 0,
    }).run();
    expect(await row(key)).toMatchObject({ provider_version: "provider-created",
      notification_observation_version: "provider-created", stream_uid: null, stream_status: "disabled",
      stream_upload_url: null, stream_upload_offset: 0, stream_error: null });
  });

  it("fences a repair prepared before a newer indexed replacement", async () => {
    const key = "Jobs/Clients/repair/race.bin";
    await deliveryDb.prepare(`INSERT INTO file_index(r2_key,provider_version,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,12,?,'application/octet-stream','other')`)
      .bind(key, "provider-old", "old-etag", "2026-09-07T08:00:00.000Z").run();
    const primary = deliveryDb.withSession("first-primary");
    const snapshot = await readDeliveryIndexObservation(primary, key);
    await deliveryDb.prepare("UPDATE file_index SET provider_version=?,etag=? WHERE r2_key=?")
      .bind("provider-winner", "winner-etag", key).run();
    await prepareDeliveryIndexRepair(primary, snapshot, object(key, "stale-etag", "provider-stale")).run();
    expect(await row(key)).toMatchObject({ provider_version: "provider-winner", etag: "winner-etag" });
  });

  async function environment(recovery: boolean, replacementAfterWrite = false) {
    counter++;
    const source = `Jobs/Clients/repair-${counter}/source.bin`, target = `Jobs/Clients/repair-${counter}/target.bin`;
    const objects = new Map<string, StoredObject>([[source, object(source, "source-etag", "source-version")]]);
    let wrote = false;
    const bucket: R2Bucket = {
      async head(key: string) {
        if (replacementAfterWrite && wrote && key === target) return object(target, "replacement-etag", "replacement-version");
        return objects.get(key) || null;
      },
      async get(key: string, options?: R2GetOptions) {
        const current = objects.get(key) || null;
        const match = options?.onlyIf instanceof Headers ? options.onlyIf.get("If-Match") : options?.onlyIf?.etagMatches;
        if (current && match && current.etag !== match.replace(/^"|"$/g, "")) return null;
        return current;
      },
      async put(key: string, _body: unknown, options?: R2PutOptions) {
        const written = object(key, "target-etag", "target-version");
        written.httpMetadata.contentType = (options?.httpMetadata instanceof Headers
          ? options.httpMetadata.get("Content-Type") : options?.httpMetadata?.contentType) || "application/octet-stream";
        written.customMetadata = options?.customMetadata || {};
        objects.set(key, written);
        wrote = true;
        return written;
      },
      async delete(keys: string | string[]) { for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key); },
      async list() { return { objects: [], delimitedPrefixes: [], truncated: false }; },
      async createMultipartUpload() { throw new Error("unexpected multipart upload"); },
      resumeMultipartUpload() { throw new Error("unexpected multipart resume"); },
    };
    await deliveryDb.prepare(`INSERT INTO file_index(r2_key,provider_version,etag,size,uploaded_at,content_type,media_kind,
      stream_uid,stream_status,stream_upload_url,stream_upload_offset,stream_error)
      VALUES(?,?,?,12,?,'application/octet-stream','other','source-stream','ready','https://tus.example.test/source-stream',12,NULL)`)
      .bind(source, "source-version", "\"source-etag\"", "2026-09-07T08:00:00.000Z").run();
    await opsDb.prepare(`INSERT INTO r2_operation_jobs(id,kind,status,requested_by,source_key,target_key,conflict_policy,payload_json)
      VALUES(?, 'batch','queued','staff-a',NULL,NULL,'fail',?)`).bind(`job-${counter}`, JSON.stringify([
      { kind: "copy", sourceKey: source, targetKey: target, conflict: "fail", sharePolicy: "revoke" },
    ])).run();
    const bindings: Partial<Env> & { AUTHENTICATED_DELIVERY_RECOVERY_ENABLED?: string } = {
      DELIVERY_DB: deliveryDb, OPS_DB: opsDb, DATA_BUCKET: bucket,
      AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true",
      ...(recovery ? { AUTHENTICATED_DELIVERY_RECOVERY_ENABLED: "true" } : {}),
    };
    return { source, target, env: bindings as Env };
  }

  it("keeps the legacy copy index write unchanged while recovery is off", async () => {
    const value = await environment(false);
    await processR2OperationJobs(value.env);
    expect(await row(value.target)).toMatchObject({ r2_key: value.target, provider_version: null,
      notification_observation_version: null, etag: "\"target-etag\"", stream_uid: "source-stream", stream_status: "ready",
      stream_upload_url: null, stream_upload_offset: null });
    expect(await row(value.source)).toMatchObject({ stream_upload_url: "https://tus.example.test/source-stream", stream_upload_offset: 12 });
  });

  it("indexes a copied current upload by provider version without creating a notification marker", async () => {
    const value = await environment(true);
    await processR2OperationJobs(value.env);
    expect(await row(value.target)).toMatchObject({ r2_key: value.target, provider_version: "target-version",
      notification_observation_version: null, etag: "\"target-etag\"", stream_uid: "source-stream", stream_status: "ready",
      stream_upload_url: null, stream_upload_offset: null });
    expect(await row(value.source)).toMatchObject({ stream_upload_url: "https://tus.example.test/source-stream", stream_upload_offset: 12 });
  });

  it("leaves the index untouched when the post-write authoritative HEAD is a different provider upload", async () => {
    const value = await environment(true, true);
    await processR2OperationJobs(value.env);
    expect(await row(value.target)).toBeNull();
    expect(await opsDb.prepare("SELECT status FROM r2_operation_jobs WHERE id=?").bind(`job-${counter}`).first("status")).not.toBe("completed");
  });

  async function moveEnvironment(replaceAfterMarkerHead: boolean, replaceDuringTargetPut = false) {
    counter++;
    const source = `Jobs/Clients/repair-${counter}/source.bin`, target = `Jobs/Clients/repair-${counter}/target.bin`;
    const original = object(source, "same-etag", "source-v1");
    const replacement = object(source, "same-etag", "source-v2");
    const objects = new Map<string, StoredObject>([[source, original]]);
    let raced = false, replacedBeforeRetire = false;
    function put(key: string, body: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options: R2PutOptions & { onlyIf: R2Conditional | Headers }): Promise<R2Object | null>;
    function put(key: string, body: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions): Promise<R2Object>;
    async function put(key: string, _body: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions): Promise<R2Object | null> {
      const current = objects.get(key) || null;
      const etagMatch = options?.onlyIf instanceof Headers ? undefined : options?.onlyIf?.etagMatches;
      if (etagMatch && current?.etag !== etagMatch.replace(/^"|"$/g, "")) return null;
      const metadata = options?.customMetadata || {};
      const written = object(key, key === source ? "marker-etag" : "target-etag",
        key === source ? "marker-v1" : "target-v1", key === source ? 0 : 12);
      written.customMetadata = metadata;
      written.httpMetadata.contentType = (options?.httpMetadata instanceof Headers
        ? options.httpMetadata.get("Content-Type") : options?.httpMetadata?.contentType) || "application/octet-stream";
      objects.set(key, written);
      if (key === target && replaceDuringTargetPut && !replacedBeforeRetire) {
        replacedBeforeRetire = true;
        objects.set(source, replacement);
        await deliveryDb.prepare("UPDATE file_index SET provider_version=? WHERE r2_key=?")
          .bind("source-v2", source).run();
      }
      return written;
    }
    const bucket: R2Bucket = {
      async head(key: string) {
        const current = objects.get(key) || null;
        if (key === source && replaceAfterMarkerHead && !raced && current && current.customMetadata.ltdsMoveMarker) {
          raced = true;
          objects.set(source, replacement);
          await deliveryDb.prepare("UPDATE file_index SET provider_version=? WHERE r2_key=?")
            .bind("source-v2", source).run();
          return current;
        }
        return current;
      },
      async get(key: string, options?: R2GetOptions) {
        const current = objects.get(key) || null;
        const match = options?.onlyIf instanceof Headers ? options.onlyIf.get("If-Match") : options?.onlyIf?.etagMatches;
        if (current && match && current.etag !== match.replace(/^"|"$/g, "")) return null;
        return current;
      },
      put,
      async delete(keys: string | string[]) { for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key); },
      async list() { return { objects: [], delimitedPrefixes: [], truncated: false }; },
      async createMultipartUpload() { throw new Error("unexpected multipart upload"); },
      resumeMultipartUpload() { throw new Error("unexpected multipart resume"); },
    };
    await deliveryDb.batch([
      deliveryDb.prepare(`INSERT INTO file_index(r2_key,provider_version,etag,size,uploaded_at,content_type,media_kind)
        VALUES(?,?,?,12,?,'application/octet-stream','other')`)
        .bind(source, "source-v1", '"same-etag"', "2026-09-07T08:00:00.000Z"),
      deliveryDb.prepare("INSERT INTO image_asset_locations(source_key,source_etag) VALUES(?,?)").bind(source, "same-etag"),
    ]);
    await opsDb.prepare(`INSERT INTO r2_operation_jobs(id,kind,status,requested_by,source_key,target_key,conflict_policy,payload_json)
      VALUES(?, 'batch','queued','staff-a',NULL,NULL,'fail',?)`).bind(`move-${counter}`, JSON.stringify([
      { kind: "move", sourceKey: source, targetKey: target, conflict: "fail", sharePolicy: "revoke" },
    ])).run();
    return { source, target, objects, env: {
      DELIVERY_DB: deliveryDb, OPS_DB: opsDb, DATA_BUCKET: bucket,
      AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true", AUTHENTICATED_DELIVERY_RECOVERY_ENABLED: "true",
    } as Env };
  }

  it("preserves an identical-byte replacement indexed after marker HEAD", async () => {
    const value = await moveEnvironment(true);

    await processR2OperationJobs(value.env);

    expect(await row(value.source)).toMatchObject({ provider_version: "source-v2", etag: '"same-etag"' });
    expect(await deliveryDb.prepare("SELECT source_etag FROM image_asset_locations WHERE source_key=?").bind(value.source)
      .first("source_etag")).toBe("same-etag");
    expect((await value.objects.get(value.source))?.version).toBe("source-v2");
    expect(await opsDb.prepare("SELECT status FROM r2_operation_jobs WHERE id=?").bind(`move-${counter}`).first("status")).toBe("completed");
  });

  it("fails the old move intent when an identical-byte replacement wins before marker retirement", async () => {
    const value = await moveEnvironment(false, true);

    await processR2OperationJobs(value.env);

    expect(await row(value.source)).toMatchObject({ provider_version: "source-v2", etag: '"same-etag"' });
    expect((await value.objects.get(value.source))?.version).toBe("source-v2");
    expect(await deliveryDb.prepare("SELECT source_etag FROM image_asset_locations WHERE source_key=?").bind(value.source)
      .first("source_etag")).toBe("same-etag");
    expect(await opsDb.prepare("SELECT status,error_message FROM r2_operation_jobs WHERE id=?").bind(`move-${counter}`).first())
      .toEqual({ status: "failed", error_message: "source-provider-changed-before-move-retire" });
  });

  it("cleans the indexed source and its location after a normal provider-aware move", async () => {
    const value = await moveEnvironment(false);

    await processR2OperationJobs(value.env);

    expect(await row(value.source)).toMatchObject({ r2_key: null });
    expect(await deliveryDb.prepare("SELECT source_key FROM image_asset_locations WHERE source_key=?").bind(value.source).first()).toBeNull();
    expect((await value.objects.get(value.source))?.customMetadata.ltdsMovedSourceProviderVersion).toBe("source-v1");
    expect(vi.mocked(removeThumbnailStateForPath).mock.calls.map(call => call.slice(1))).toContainEqual([value.source, false, "same-etag"]);
    expect(await opsDb.prepare("SELECT status FROM r2_operation_jobs WHERE id=?").bind(`move-${counter}`).first("status")).toBe("completed");
  });

  it("repairs and re-enqueues a replacement that lands during derivative cleanup", async () => {
    const value = await moveEnvironment(false);
    vi.mocked(removeThumbnailStateForPath).mockImplementationOnce(async () => {
      value.objects.set(value.source, object(value.source, "same-etag", "source-v2"));
      await deliveryDb.prepare("INSERT INTO file_index(r2_key,provider_version,etag,size,uploaded_at,content_type,media_kind)\n        VALUES(?,?,?,12,?,'application/octet-stream','other')")
        .bind(value.source, "source-v2", '"same-etag"', "2026-09-07T08:00:00.000Z").run();
      vi.mocked(thumbnailSourceEligible).mockReturnValue(true);
      return { rows: 0, objects: 0 };
    });

    await processR2OperationJobs(value.env);

    expect(await row(value.source)).toMatchObject({ provider_version: "source-v2", etag: '"same-etag"' });
    expect(vi.mocked(enqueueThumbnailJob).mock.calls.map(call => call.slice(1))).toContainEqual([expect.objectContaining({
      sourceKey: value.source, sourceEtag: '"same-etag"', sourceSize: 12,
    })]);
    expect(await opsDb.prepare("SELECT status FROM r2_operation_jobs WHERE id=?").bind(`move-${counter}`).first("status")).toBe("completed");
  });
});
