import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  classifyThumbnailQueueBatch,
  consumeThumbnailDeadLetters,
  consumeThumbnailJobs,
  enqueueThumbnailJob,
  getThumbnailForAuthorizedSource,
  processThumbnailJob,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_JOB_KIND,
  THUMBNAIL_WIDTH,
  thumbnailObjectKey,
  thumbnailStateForObject,
  type ThumbnailJobMessage,
  type ThumbnailJobRow,
} from "../src/worker/image-thumbnails";
import type { Env } from "../src/worker/types";

interface StoredJob extends ThumbnailJobRow {
  source_key: string;
  source_size: number;
  thumbnail_etag: string | null;
  thumbnail_size: number | null;
  attempt_count: number;
  error_message: string | null;
  dead_lettered: boolean;
}

class FakeThumbnailDb {
  job: StoredJob | undefined;

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    return Promise.all(statements.map(statement => statement.run()));
  }

  prepare(sql: string) {
    const db = this;
    let values: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) {
        values = bound;
        return statement;
      },
      async run() {
        if (sql.includes("thumbnail.register")) {
          const [sourceKey, sourceEtag, sourceSize, thumbnailKey] = values as [string, string, number, string];
          if (!db.job || db.job.source_etag !== sourceEtag) {
            db.job = {
              source_key: sourceKey,
              source_etag: sourceEtag,
              source_size: sourceSize,
              thumbnail_key: thumbnailKey,
              thumbnail_etag: null,
              thumbnail_size: null,
              status: "pending",
              attempt_count: 0,
              error_code: null,
              error_message: null,
              dead_lettered: false,
            };
          }
          return result(1);
        }
        if (sql.includes("thumbnail.ready")) {
          const [etag, size, sourceKey, sourceEtag] = values as [string, number, string, string];
          if (db.job?.source_key !== sourceKey || db.job.source_etag !== sourceEtag || db.job.status !== "processing") return result(0);
          db.job.status = "ready";
          db.job.thumbnail_etag = etag;
          db.job.thumbnail_size = size;
          db.job.error_code = null;
          db.job.error_message = null;
          return result(1);
        }
        if (sql.includes("thumbnail.fail")) {
          const [status, code, message, , sourceKey, sourceEtag] = values as ["pending" | "failed", string, string, string, string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "processing") {
            db.job.status = status;
            db.job.error_code = code;
            db.job.error_message = message;
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.dead-letter")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status !== "ready") {
            db.job.status = "failed";
            db.job.error_code ||= "dead_lettered";
            db.job.dead_lettered = true;
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.requeue")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.error_code === "queue_publish_failed") {
            db.job.status = "pending";
            db.job.error_code = null;
            db.job.error_message = null;
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.enqueue-fail")) {
          const [message, sourceKey, sourceEtag] = values as [string, string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "pending") {
            db.job.status = "failed";
            db.job.error_code = "queue_publish_failed";
            db.job.error_message = message;
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.empty-source")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag) {
            db.job.status = "failed";
            db.job.thumbnail_etag = null;
            db.job.thumbnail_size = null;
            db.job.error_code = "empty_source";
            db.job.error_message = "The original image is empty";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.cleanup-schedule")) return result(1);
        if (sql.includes("thumbnail.cleanup-prune")) return result(0);
        throw new Error(`Unhandled run query: ${sql}`);
      },
      async first<T>() {
        if (sql.includes("thumbnail.claim")) {
          const [, sourceKey, sourceEtag] = values as [string, string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "pending") {
            db.job.status = "processing";
            db.job.attempt_count += 1;
            return { attempt_count: db.job.attempt_count } as T;
          }
          return null;
        }
        if (sql.includes("thumbnail.state") || sql.includes("thumbnail.current-row")) return (db.job || null) as T | null;
        if (sql.includes("thumbnail.trashed") || sql.includes("thumbnail.cleanup-referenced")) return null;
        throw new Error(`Unhandled first query: ${sql}`);
      },
      async all<T>() {
        if (sql.includes("thumbnail.cleanup-due") || sql.includes("thumbnail.cleanup-list")) return { results: [] as T[] };
        throw new Error(`Unhandled all query: ${sql}`);
      },
    };
    return statement;
  }
}

function result(changes: number) {
  return { success: true, meta: { changes } };
}

function stream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from(bytes)); controller.close(); } });
}

function fixtureThumbnailKey(sourceKey: string, sourceEtag: string): string {
  return `_ltds/thumbnails/v2/${createHash("sha256").update(`ltds-thumbnail:v2\0${sourceKey}\0${sourceEtag}`).digest("hex")}.webp`;
}

function r2Object(key: string, etag: string, size: number, contentType: string, body?: ReadableStream<Uint8Array>) {
  return {
    key,
    version: "v1",
    size,
    etag,
    httpEtag: `"${etag}"`,
    uploaded: new Date("2026-08-02T12:00:00Z"),
    httpMetadata: { contentType },
    customMetadata: {},
    storageClass: "Standard",
    checksums: {},
    body,
    bodyUsed: false,
  };
}

function fixture(options: { sourceKey?: string; contentType?: string; size?: number; transformError?: unknown; queueError?: Error } = {}) {
  const sourceKey = options.sourceKey || "Jobs/Clients/Synthetic/photo.jpg";
  const sourceEtag = "source-etag";
  const originalBody = stream([1, 2, 3, 4]);
  const thumbnailBody = stream([9, 8, 7]);
  const db = new FakeThumbnailDb();
  db.job = {
    source_key: sourceKey,
    source_etag: sourceEtag,
    source_size: options.size ?? 4096,
    thumbnail_key: fixtureThumbnailKey(sourceKey, sourceEtag),
    thumbnail_etag: null,
    thumbnail_size: null,
    status: "pending",
    attempt_count: 0,
    error_code: null,
    error_message: null,
    dead_lettered: false,
  };
  const putBodies: unknown[] = [];
  const putOptions: unknown[] = [];
  const getKeys: string[] = [];
  const transform = vi.fn();
  const output = vi.fn(async () => {
    if (options.transformError) throw options.transformError;
    return { contentType: () => "image/webp", image: () => thumbnailBody };
  });
  const input = vi.fn(() => ({
    transform(value: unknown) { transform(value); return { output }; },
  }));
  const stored = new Map<string, ReturnType<typeof r2Object>>();
  const sourceHead = r2Object(sourceKey, sourceEtag, options.size || 4096, options.contentType || "image/jpeg");
  const sourceObject = r2Object(sourceKey, sourceEtag, sourceHead.size, sourceHead.httpMetadata.contentType || "image/jpeg", originalBody);
  const bucket = {
    async head(key: string) {
      if (key === sourceKey) return sourceHead;
      return stored.get(key) || null;
    },
    async get(key: string) {
      getKeys.push(key);
      if (key === sourceKey) return sourceObject;
      return stored.get(key) || null;
    },
    async put(key: string, body: unknown, metadata: unknown) {
      putBodies.push(body);
      putOptions.push(metadata);
      const object = r2Object(key, "thumb-etag", 1234, "image/webp", body as ReadableStream<Uint8Array>);
      object.customMetadata = (metadata as { customMetadata?: Record<string, string> }).customMetadata || {};
      stored.set(key, object);
      return object;
    },
    async delete(key: string | string[]) {
      for (const item of Array.isArray(key) ? key : [key]) stored.delete(item);
    },
  };
  const send = options.queueError ? vi.fn(async () => { throw options.queueError; }) : vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
  const bindings: Pick<Env, "DELIVERY_DB" | "DATA_BUCKET" | "IMAGES" | "THUMBNAIL_QUEUE"> = {
    DELIVERY_DB: db as never,
    DATA_BUCKET: bucket as never,
    IMAGES: { input } as never,
    THUMBNAIL_QUEUE: { send } as never,
  };
  const env = bindings as Env;
  const message: ThumbnailJobMessage = { kind: THUMBNAIL_JOB_KIND, sourceKey, sourceEtag };
  return { env, db, message, input, transform, output, originalBody, thumbnailBody, putBodies, putOptions, getKeys, stored, send };
}

function queueBatch(body: unknown, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    batch: {
      queue: "test",
      messages: [{ id: "message-1", timestamp: new Date(), body, attempts, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    } as MessageBatch<unknown>,
    ack,
    retry,
  };
}

describe("Cloudflare image thumbnail pipeline", () => {
  it("creates one fixed WebP from the original stream and never stores the original as a thumbnail", async () => {
    const value = fixture();
    const result = await processThumbnailJob(value.env, value.message);

    expect(result.outcome).toBe("ready");
    expect(value.input).toHaveBeenCalledWith(value.originalBody);
    expect(value.transform).toHaveBeenCalledWith({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, fit: "cover", gravity: "center" });
    expect(value.output).toHaveBeenCalledWith({ format: "image/webp", quality: 78, anim: false });
    expect(value.putBodies).toEqual([value.thumbnailBody]);
    expect(value.putBodies[0]).not.toBe(value.originalBody);
    expect(value.putOptions[0]).toMatchObject({ httpMetadata: { contentType: "image/webp", cacheControl: "private, no-store" } });
    expect(value.db.job).toMatchObject({ status: "ready", attempt_count: 1, thumbnail_size: 1234 });
  });

  it("uses an opaque deterministic _ltds key scoped to the original object", async () => {
    const key = await thumbnailObjectKey("Jobs/Clients/Secret Client/client-name.jpg", "etag-a");
    expect(key).toMatch(/^_ltds\/thumbnails\/v2\/[a-f0-9]{64}\.webp$/);
    expect(key).not.toContain("Secret");
    expect(await thumbnailObjectKey("Jobs/Clients/Secret Client/client-name.jpg", "etag-a")).toBe(key);
    expect(await thumbnailObjectKey("Jobs/Clients/Secret Client/client-name.jpg", "etag-b")).not.toBe(key);
    expect(await thumbnailObjectKey("Jobs/Clients/Secret Client/other.jpg", "etag-a")).not.toBe(key);
  });

  it("durably registers pending state before publishing the queue message", async () => {
    const value = fixture();
    const queued = await enqueueThumbnailJob(value.env, {
      sourceKey: value.message.sourceKey,
      sourceEtag: value.message.sourceEtag,
      sourceSize: 4096,
    });
    expect(queued).toEqual({ enqueued: true, state: "pending" });
    expect(value.db.job?.status).toBe("pending");
    expect(value.send).toHaveBeenCalledWith(value.message);
  });

  it("makes queue publication failures visible in durable state and rethrows", async () => {
    const value = fixture({ queueError: new Error("queue unavailable") });
    await expect(enqueueThumbnailJob(value.env, {
      sourceKey: value.message.sourceKey,
      sourceEtag: value.message.sourceEtag,
      sourceSize: 4096,
    })).rejects.toThrow("queue unavailable");
    expect(value.db.job).toMatchObject({ status: "failed", error_code: "queue_publish_failed" });
  });

  it("records an empty image as a terminal fallback without publishing or retrying", async () => {
    const value = fixture({ size: 0 });
    const queued = await enqueueThumbnailJob(value.env, {
      sourceKey: value.message.sourceKey,
      sourceEtag: value.message.sourceEtag,
      sourceSize: 0,
    });
    expect(queued).toEqual({ enqueued: false, state: "failed" });
    expect(value.send).not.toHaveBeenCalled();
    expect(value.db.job).toMatchObject({ source_size: 0, status: "failed", error_code: "empty_source" });
  });

  it("classifies renamed thumbnail queues by body and a generic DLQ token", () => {
    const value = fixture();
    const batch = queueBatch(value.message).batch;
    expect(classifyThumbnailQueueBatch({ ...batch, queue: "tenant-media-work" })).toBe("jobs");
    expect(classifyThumbnailQueueBatch({ ...batch, queue: "tenant-media-dlq-v2" })).toBe("dead_letters");
    expect(classifyThumbnailQueueBatch({ ...batch, queue: "tenant-media-dead-letter-v2" })).toBe("dead_letters");
    const fileEvent = { ...batch.messages[0]!, body: { action: "PutObject" } };
    expect(classifyThumbnailQueueBatch({ ...batch, messages: [fileEvent] })).toBe("other");
    expect(classifyThumbnailQueueBatch({ ...batch, messages: [...batch.messages, fileEvent] })).toBe("mixed");
  });

  it("does not regenerate a ready job when the same event is delivered twice", async () => {
    const value = fixture();
    expect((await processThumbnailJob(value.env, value.message)).outcome).toBe("ready");
    expect((await processThumbnailJob(value.env, value.message)).outcome).toBe("duplicate");
    expect(value.input).toHaveBeenCalledTimes(1);
    expect(value.putBodies).toHaveLength(1);
  });

  it("allows only one concurrent claimant for duplicate queue events", async () => {
    const value = fixture();
    const results = await Promise.all([
      processThumbnailJob(value.env, value.message),
      processThumbnailJob(value.env, value.message),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["duplicate", "ready"]);
    expect(value.input).toHaveBeenCalledTimes(1);
    expect(value.putBodies).toHaveLength(1);
  });

  it("permanently rejects unsupported files without reading their body", async () => {
    const value = fixture({ sourceKey: "Jobs/Clients/Synthetic/archive.zip", contentType: "application/zip" });
    const result = await processThumbnailJob(value.env, value.message);
    expect(result).toEqual({ outcome: "failed", errorCode: "unsupported_file" });
    expect(value.getKeys).toEqual([]);
    expect(value.input).not.toHaveBeenCalled();
    expect(value.db.job).toMatchObject({ status: "failed", error_code: "unsupported_file" });
  });

  it("classifies Cloudflare Images invalid-image errors as permanent", async () => {
    const invalid = Object.assign(new Error("bad bytes"), { code: 9412 });
    const value = fixture({ transformError: invalid });
    const queue = queueBatch(value.message);
    await consumeThumbnailJobs(queue.batch, value.env);
    expect(queue.ack).toHaveBeenCalledOnce();
    expect(queue.retry).not.toHaveBeenCalled();
    expect(value.db.job).toMatchObject({ status: "failed", error_code: "invalid_image" });
  });

  it("keeps transient failures pending for retry and exposes terminal retry exhaustion", async () => {
    const value = fixture({ transformError: new Error("temporary transform outage") });
    const first = await processThumbnailJob(value.env, value.message);
    expect(first).toEqual({ outcome: "retry", errorCode: "thumbnail_processing_error" });
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 1 });

    const final = await processThumbnailJob(value.env, value.message, { finalAttempt: true });
    expect(final).toEqual({ outcome: "failed", errorCode: "thumbnail_processing_error" });
    expect(value.db.job).toMatchObject({ status: "failed", attempt_count: 2 });

    const deadLetter = queueBatch(value.message);
    await consumeThumbnailDeadLetters(deadLetter.batch, value.env);
    expect(deadLetter.ack).toHaveBeenCalledOnce();
    expect(value.db.job?.dead_lettered).toBe(true);
  });

  it("retries the final queue delivery so Cloudflare can move it to the DLQ", async () => {
    const value = fixture({ transformError: new Error("temporary transform outage") });
    const queue = queueBatch(value.message, 6);
    await consumeThumbnailJobs(queue.batch, value.env);
    expect(queue.ack).not.toHaveBeenCalled();
    expect(queue.retry).toHaveBeenCalledOnce();
    expect(value.db.job?.status).toBe("failed");
  });

  it("serves only a ready WebP after the caller has authorized the source", async () => {
    const value = fixture();
    await processThumbnailJob(value.env, value.message);
    value.getKeys.length = 0;
    const result = await getThumbnailForAuthorizedSource(value.env, value.message.sourceKey);
    expect(result.state).toBe("ready");
    expect(value.getKeys).toEqual([value.db.job?.thumbnail_key]);
    expect(value.getKeys).not.toContain(value.message.sourceKey);
  });

  it("maps processing and stale rows to pending without exposing a derivative key", () => {
    const job: ThumbnailJobRow = { source_etag: "current", thumbnail_key: "_ltds/secret.webp", status: "processing", error_code: null };
    expect(thumbnailStateForObject("current", job)).toEqual({ state: "pending", errorCode: undefined });
    expect(thumbnailStateForObject("new-version", { ...job, status: "ready" })).toEqual({ state: "pending" });
  });
});
