import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  classifyThumbnailQueueBatch,
  canonicalThumbnailSourceKey,
  consumeThumbnailDeadLetters,
  consumeThumbnailJobs,
  enqueueThumbnailJob,
  getThumbnailForAuthorizedSource,
  processThumbnailJob,
  republishPendingThumbnailFallbacks,
  recoverExpiredThumbnailLeases,
  recoverTransientThumbnailFailures,
  THUMBNAIL_JOB_KIND,
  THUMBNAIL_MAX_DELIVERY_ATTEMPTS,
  THUMBNAIL_MAX_INPUT_BYTES,
  THUMBNAIL_MAX_RECOVERY_ATTEMPTS,
  PDF_THUMBNAIL_MAX_INPUT_BYTES,
  thumbnailObjectKey,
  thumbnailSourceEligible,
  thumbnailSourceKind,
  thumbnailStateForObject,
  videoThumbnailSourceDisabled,
  type ThumbnailJobMessage,
  type ThumbnailJobRow,
} from "../src/worker/image-thumbnails";
import type { Env } from "../src/worker/types";
import {
  THUMBNAIL_RENDER_PROFILE,
  type ContainerThumbnailResult,
} from "../src/worker/thumbnail-renderer-contract";

interface StoredJob extends ThumbnailJobRow {
  source_key: string;
  source_size: number;
  thumbnail_etag: string | null;
  thumbnail_size: number | null;
  attempt_count: number;
  error_message: string | null;
  dead_lettered: boolean;
  queue_published_at: string | null;
  render_not_before: string | null;
}

class FakeThumbnailDb {
  job: StoredJob | undefined;
  claims = 0;
  tombstoneChecks = 0;
  tombstoneOnCheck: number | undefined;
  leaseExpired = true;
  indexedEtag = "source-etag";
  indexedSize = 4096;
  indexedContentType = "image/jpeg";
  indexedMediaKind = "image";
  indexMissing = false;
  primaryHealthy = false;
  fallbackLockAvailable = true;

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
        if (sql.includes("thumbnail.primary-deferred")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "pending") {
            db.job.queue_published_at = null;
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.container-limited-primary")) {
          const [code, message, sourceKey, sourceEtag, expectedAttemptCount] = values as [string, string, string, string, number];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "processing" &&
            db.job.attempt_count === expectedAttemptCount) {
            db.job.status = "pending";
            db.job.error_code = code;
            db.job.error_message = message;
            db.job.queue_published_at = null;
            db.job.render_not_before = "2026-08-24 12:00:00";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.fallback-lock-register")) return result(1);
        if (sql.includes("thumbnail.fallback-lock-acquire")) {
          if (!db.fallbackLockAvailable) return result(0);
          db.fallbackLockAvailable = false;
          return result(1);
        }
        if (sql.includes("thumbnail.fallback-lock-complete")) return result(1);
        if (sql.includes("thumbnail.fallback-published")) {
          const [sourceKey, sourceEtag, sourceSize] = values as [string, string, number];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.source_size === sourceSize &&
            db.job.status === "pending" && db.job.queue_published_at === null) {
            db.job.queue_published_at = "2026-08-24 12:00:00";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("image-location.register")) return result(0);
        if (sql.includes("thumbnail.register")) {
          const [sourceKey, sourceEtag, sourceSize, thumbnailKey, , renderNotBefore] = values as [string, string, number, string, string, string];
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
              queue_published_at: null,
              render_not_before: renderNotBefore,
            };
          }
          return result(1);
        }
        if (sql.includes("thumbnail.ready")) {
          const [etag, size, , , sourceKey, sourceEtag, expectedAttemptCount] = values as [string, number, string, string, string, string, number];
          if (db.job?.source_key !== sourceKey || db.job.source_etag !== sourceEtag || db.job.status !== "processing" ||
            db.job.attempt_count !== expectedAttemptCount) return result(0);
          db.job.status = "ready";
          db.job.thumbnail_etag = etag;
          db.job.thumbnail_size = size;
          db.job.error_code = null;
          db.job.error_message = null;
          return result(1);
        }
        if (sql.includes("thumbnail.fail")) {
          const [status, code, message, , sourceKey, sourceEtag, expectedAttemptCount] = values as ["pending" | "failed", string, string, string, string, string, number];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "processing" &&
            db.job.attempt_count === expectedAttemptCount) {
            db.job.status = status;
            db.job.error_code = code;
            db.job.error_message = message;
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.dead-letter")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "failed") {
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
        if (sql.includes("thumbnail.video-disabled")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag &&
            (db.job.status === "pending" || db.job.status === "processing")) {
            db.job.status = "failed";
            db.job.thumbnail_etag = null;
            db.job.thumbnail_size = null;
            db.job.error_code = "video_thumbnail_disabled";
            db.job.error_message = "Video thumbnail rendering is disabled for this release";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.publish-record")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag &&
            (db.job.status === "pending" || db.job.status === "processing")) {
            db.job.queue_published_at ||= "2026-08-07 00:00:00";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.recovery-claim")) {
          const [sourceKey, sourceEtag, maxAttempts] = values as [string, string, number];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag &&
            db.job.status === "failed" && ["thumbnail_processing_error", "queue_publish_failed", "video_thumbnail_disabled"].includes(db.job.error_code || "") &&
            db.job.attempt_count < maxAttempts) {
            db.job.status = "pending";
            db.job.attempt_count += 1;
            db.job.error_code = null;
            db.job.error_message = null;
            db.job.dead_lettered = false;
            db.job.queue_published_at = null;
            db.job.render_not_before = "2026-08-24 12:00:00";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.recovery-published")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "pending") {
            db.job.queue_published_at = "2026-08-07 01:00:00";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.recovery-publish-failed")) {
          const [, sourceKey, sourceEtag] = values as [string, string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "pending") {
            db.job.status = "failed";
            db.job.error_code = "queue_publish_failed";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.expired-exhausted")) {
          const [sourceKey, sourceEtag, maxAttempts] = values as [string, string, number];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "processing" &&
            db.leaseExpired && db.job.attempt_count >= maxAttempts) {
            db.job.status = "failed";
            db.job.error_code = "retry_exhausted";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.expired-claim")) {
          const [sourceKey, sourceEtag, sourceSize, maxAttempts] = values as [string, string, number, number];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.source_size === sourceSize &&
            db.job.status === "processing" && db.leaseExpired && db.job.attempt_count < maxAttempts &&
            !db.indexMissing && db.indexedEtag === sourceEtag && db.indexedSize === sourceSize &&
            ["image", "pdf", "video"].includes(db.indexedMediaKind)) {
            db.job.status = "pending";
            db.job.error_code = null;
            db.job.error_message = null;
            db.job.dead_lettered = false;
            db.job.queue_published_at = null;
            db.job.render_not_before = "2026-08-24 12:00:00";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.expired-published")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "pending") {
            db.job.queue_published_at = "2026-08-10 20:00:00";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.expired-publish-failed")) {
          const [, sourceKey, sourceEtag] = values as [string, string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "pending") {
            db.job.status = "failed";
            db.job.error_code = "queue_publish_failed";
            return result(1);
          }
          return result(0);
        }
        if (sql.includes("thumbnail.cleanup-schedule")) return result(1);
        if (sql.includes("thumbnail.cleanup-delete")) {
          db.job = undefined;
          return result(1);
        }
        if (sql.includes("thumbnail.cleanup-prune")) return result(0);
        throw new Error(`Unhandled run query: ${sql}`);
      },
      async first<T>() {
        if (sql.includes("thumbnail.primary-health")) return { fresh: db.primaryHealthy ? 1 : 0 } as T;
        if (sql.includes("thumbnail.claim")) {
          const [, sourceKey, sourceEtag] = values as [string, string, string];
          if (db.job?.source_key === sourceKey && db.job.source_etag === sourceEtag && db.job.status === "pending") {
            db.job.status = "processing";
            db.job.attempt_count += 1;
            db.claims += 1;
            return { attempt_count: db.job.attempt_count } as T;
          }
          return null;
        }
        if (sql.includes("thumbnail.state") || sql.includes("thumbnail.current-row")) return (db.job || null) as T | null;
        if (sql.includes("thumbnail.expired-index")) {
          if (db.indexMissing) return null;
          return {
            etag: db.indexedEtag,
            size: db.indexedSize,
            content_type: db.indexedContentType,
            media_kind: db.indexedMediaKind,
          } as T;
        }
        if (sql.includes("thumbnail.trashed")) {
          db.tombstoneChecks += 1;
          return (db.tombstoneOnCheck && db.tombstoneChecks >= db.tombstoneOnCheck ? { id: "trash-race" } : null) as T | null;
        }
        if (sql.includes("thumbnail.cleanup-referenced")) return null;
        throw new Error(`Unhandled first query: ${sql}`);
      },
      async all<T>() {
        if (sql.includes("thumbnail.fallback-due")) {
          const [requireFailure, limit] = values as [number, number];
          const eligible = db.job?.status === "pending" && db.job.queue_published_at === null &&
            !db.indexMissing && db.indexedEtag === db.job.source_etag && db.indexedSize === db.job.source_size &&
            ["image", "pdf", "video"].includes(db.indexedMediaKind) &&
            db.job.error_code !== "pixel_limit_exceeded" &&
            (requireFailure === 0 || Boolean(db.job.error_code))
            ? [{ source_key: db.job.source_key, source_etag: db.job.source_etag, source_size: db.job.source_size }]
            : [];
          return { results: eligible.slice(0, limit) as T[] };
        }
        if (sql.includes("thumbnail.recovery-due")) {
          const [maxAttempts, limit] = values as [number, number];
          const eligible = db.job?.status === "failed" &&
            ["thumbnail_processing_error", "queue_publish_failed", "video_thumbnail_disabled"].includes(db.job.error_code || "") &&
            db.job.attempt_count < maxAttempts
            ? [{ source_key: db.job.source_key, source_etag: db.job.source_etag, source_size: db.job.source_size }]
            : [];
          return { results: eligible.slice(0, limit) as T[] };
        }
        if (sql.includes("thumbnail.expired-due")) {
          const [limit] = values as [number];
          const eligible = db.job?.status === "processing" && db.leaseExpired
            ? [{
                source_key: db.job.source_key,
                source_etag: db.job.source_etag,
                source_size: db.job.source_size,
                attempt_count: db.job.attempt_count,
              }]
            : [];
          return { results: eligible.slice(0, limit) as T[] };
        }
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

function validWebpBytes(width = 320, height = 240): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20], 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20);
  new DataView(bytes.buffer).setUint16(26, width, true);
  new DataView(bytes.buffer).setUint16(28, height, true);
  return bytes;
}

function fixtureThumbnailKey(sourceKey: string, sourceEtag: string): string {
  const digest = createHash("sha256").update(`ltds-thumbnail-managed:v1\0${sourceKey}\0${sourceEtag}`).digest("hex");
  return `_ltds/derivatives/thumbnails/v1/managed/${digest}.webp`;
}

function r2Object(key: string, etag: string, size: number, contentType: string, body?: ReadableStream<Uint8Array>, payload?: Uint8Array) {
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
    async arrayBuffer() {
      const bytes = payload || new Uint8Array();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function fixture(options: {
  sourceKey?: string;
  contentType?: string;
  size?: number;
  queueError?: Error;
  tombstoneOnCheck?: number;
  rendererResult?: ContainerThumbnailResult;
  sidecarWinner?: boolean;
  sourceHeadMissing?: boolean;
  sourceHeadEtag?: string;
  indexMissing?: boolean;
  indexEtag?: string;
  leaseExpired?: boolean;
  primaryHealthy?: boolean;
  renderNotBefore?: string | null;
  duringRender?: (db: FakeThumbnailDb) => void;
} = {}) {
  const sourceKey = options.sourceKey || "Jobs/Clients/Synthetic/photo.jpg";
  const sourceEtag = "source-etag";
  const originalBody = stream([1, 2, 3, 4]);
  const thumbnailBytes = validWebpBytes();
  const thumbnailBody = stream([...thumbnailBytes]);
  const db = new FakeThumbnailDb();
  db.tombstoneOnCheck = options.tombstoneOnCheck;
  db.leaseExpired = options.leaseExpired ?? true;
  db.indexMissing = options.indexMissing ?? false;
  db.indexedEtag = options.indexEtag || sourceEtag;
  db.indexedSize = options.size ?? 4096;
  db.indexedContentType = options.contentType || "image/jpeg";
  db.indexedMediaKind = db.indexedContentType.startsWith("video/") ? "video" : db.indexedContentType === "application/pdf" ? "pdf" : "image";
  db.primaryHealthy = options.primaryHealthy ?? false;
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
    queue_published_at: null,
    render_not_before: options.renderNotBefore === undefined ? "2026-08-01 00:00:00" : options.renderNotBefore,
  };
  const putBodies: unknown[] = [];
  const putOptions: unknown[] = [];
  const getKeys: string[] = [];
  const stored = new Map<string, ReturnType<typeof r2Object>>();
  const sourceHead = r2Object(sourceKey, options.sourceHeadEtag || sourceEtag, options.size ?? 4096, options.contentType || "image/jpeg");
  const sourceObject = r2Object(sourceKey, sourceEtag, sourceHead.size, sourceHead.httpMetadata.contentType || "image/jpeg", originalBody);
  const renderThumbnail = vi.fn(async () => {
    options.duringRender?.(db);
    return options.rendererResult || {
      ok: true as const,
      bytes: thumbnailBytes.buffer.slice(0),
      contentType: "image/webp" as const,
    };
  });
  const idFromName = vi.fn(() => ({ name: "ltds-thumbnails" }));
  const rendererGet = vi.fn(() => ({ renderThumbnail }));
  const bucket = {
    async head(key: string) {
      if (key === sourceKey) return options.sourceHeadMissing ? null : sourceHead;
      if (key === db.job?.thumbnail_key && options.sidecarWinner && !stored.has(key)) {
        const winner = r2Object(key, "sidecar-etag", thumbnailBytes.byteLength, "image/webp", stream([...thumbnailBytes]), thumbnailBytes);
        winner.customMetadata = {
          sourceEtag,
          thumbnailProvider: "ltds-truenas",
          rendererProfile: THUMBNAIL_RENDER_PROFILE,
        };
        stored.set(key, winner);
      }
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
      const bytes = body instanceof Uint8Array ? body : new Uint8Array();
      const object = r2Object(key, "thumb-etag", bytes.byteLength, "image/webp", stream([...bytes]), bytes);
      object.customMetadata = (metadata as { customMetadata?: Record<string, string> }).customMetadata || {};
      stored.set(key, object);
      return object;
    },
    async delete(key: string | string[]) {
      for (const item of Array.isArray(key) ? key : [key]) stored.delete(item);
    },
  };
  const send = options.queueError ? vi.fn(async () => { throw options.queueError; }) : vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
  const bindings: Pick<Env, "DELIVERY_DB" | "DATA_BUCKET" | "THUMBNAIL_QUEUE" | "THUMBNAIL_RENDERER"> = {
    DELIVERY_DB: db as never,
    DATA_BUCKET: bucket as never,
    THUMBNAIL_QUEUE: { send } as never,
    THUMBNAIL_RENDERER: { idFromName, get: rendererGet } as never,
  };
  const env = { ...bindings } as unknown as Env;
  const message: ThumbnailJobMessage = { kind: THUMBNAIL_JOB_KIND, sourceKey, sourceEtag };
  return { env, db, message, originalBody, thumbnailBody, thumbnailBytes, putBodies, putOptions, getKeys, stored, send, renderThumbnail, rendererGet, idFromName };
}

function queueBatch(body: unknown, attempts = 1, queue = "test") {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    batch: {
      queue,
      messages: [{ id: "message-1", timestamp: new Date(), body, attempts, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    } as MessageBatch<unknown>,
    ack,
    retry,
  };
}

describe("private server thumbnail pipeline", () => {
  it("streams an eligible exact-version image through the private Container and records only the derived WebP", async () => {
    const value = fixture();
    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "ready",
      thumbnailKey: value.db.job?.thumbnail_key,
    });
    expect(value.getKeys).toEqual([value.message.sourceKey]);
    expect(value.renderThumbnail).toHaveBeenCalledWith(value.originalBody, { kind: "image", expectedSize: 4096 });
    expect(value.putBodies).toEqual([value.thumbnailBytes]);
    expect(value.putBodies[0]).not.toBe(value.originalBody);
    expect(value.putOptions[0]).toMatchObject({
      httpMetadata: { contentType: "image/webp", cacheControl: "private, no-store" },
      customMetadata: {
        sourceEtag: value.message.sourceEtag,
        thumbnailProvider: "cloudflare-container",
        rendererProfile: THUMBNAIL_RENDER_PROFILE,
      },
    });
    expect(value.db.job).toMatchObject({ status: "ready", attempt_count: 1, error_code: null });
  });

  it("accepts canonical sources throughout Jobs while rejecting outside and reserved paths", () => {
    expect(canonicalThumbnailSourceKey("Jobs/Internal/photo.jpg")).toBe(true);
    expect(canonicalThumbnailSourceKey("Jobs/Clients/Synthetic/photo.jpg")).toBe(true);
    expect(canonicalThumbnailSourceKey("Jobs2/Internal/photo.jpg")).toBe(false);
    expect(canonicalThumbnailSourceKey("jobs/Internal/photo.jpg")).toBe(false);
    expect(canonicalThumbnailSourceKey("Jobs/_ltds/private.jpg")).toBe(false);
    expect(canonicalThumbnailSourceKey("Jobs/Internal/.previews/thumb.webp")).toBe(false);
    expect(canonicalThumbnailSourceKey("Jobs/Internal/Dump/source.jpg")).toBe(false);
    expect(canonicalThumbnailSourceKey("Jobs/Internal/../Clients/photo.jpg")).toBe(false);
    expect(canonicalThumbnailSourceKey("Jobs\\Internal\\photo.jpg")).toBe(false);
  });

  it("uses one strict image, PDF, and TrueNAS-video eligibility policy", () => {
    expect(thumbnailSourceEligible("Jobs/Clients/Synthetic/photo.jpg", 1024, "image/jpeg")).toBe(true);
    expect(thumbnailSourceEligible("Jobs/Internal/source.tiff", THUMBNAIL_MAX_INPUT_BYTES, "image/tiff")).toBe(true);
    expect(thumbnailSourceEligible("Jobs/Internal/source.bmp", THUMBNAIL_MAX_INPUT_BYTES + 1, "image/bmp")).toBe(false);
    expect(thumbnailSourceEligible("Jobs/Clients/Synthetic/report.pdf", PDF_THUMBNAIL_MAX_INPUT_BYTES, "application/pdf")).toBe(true);
    expect(thumbnailSourceEligible("Jobs/Clients/Synthetic/report.pdf", PDF_THUMBNAIL_MAX_INPUT_BYTES + 1, "application/pdf")).toBe(false);
    expect(thumbnailSourceEligible("Jobs/Clients/Synthetic/flight.mp4", 1024, "video/mp4")).toBe(true);
    expect(thumbnailSourceEligible("Jobs/Clients/Synthetic/flight.mov", 1024, "video/quicktime")).toBe(true);
    expect(thumbnailSourceKind("Jobs/Internal/report.pdf", "application/pdf")).toBe("pdf");
    expect(thumbnailSourceKind("Jobs/Internal/photo.jpg", "image/jpeg")).toBe("image");
    expect(thumbnailSourceKind("Jobs/Internal/clip.mp4", "video/mp4")).toBe("video");
    expect(thumbnailSourceKind("Jobs/Internal/disguised.jpg", "video/mp4")).toBe("video");
    expect(thumbnailSourceKind("Jobs/Internal/disguised.mp4", "image/jpeg")).toBe("video");
    expect(thumbnailSourceKind("Jobs/Internal/unsupported.jpg", "video/x-unknown-codec")).toBeNull();
    expect(videoThumbnailSourceDisabled("Jobs/Internal/disguised.jpg", "video/mp4; codecs=avc1")).toBe(false);
    expect(videoThumbnailSourceDisabled("Jobs/Internal/disguised.mp4", "image/jpeg")).toBe(false);
  });

  it("renders an eligible PDF through the same private Container boundary", async () => {
    const value = fixture({ sourceKey: "Jobs/Internal/report.pdf", contentType: "application/pdf" });
    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "ready",
      thumbnailKey: value.db.job?.thumbnail_key,
    });
    expect(value.getKeys).toEqual([value.message.sourceKey]);
    expect(value.renderThumbnail).toHaveBeenCalledWith(value.originalBody, { kind: "pdf", expectedSize: 4096 });
    expect(value.putBodies).toEqual([value.thumbnailBytes]);
  });

  it("uses an opaque deterministic _ltds key scoped to the original object", async () => {
    const key = await thumbnailObjectKey("Jobs/Clients/Secret Client/client-name.jpg", "etag-a");
    expect(key).toMatch(/^_ltds\/derivatives\/thumbnails\/v1\/managed\/[a-f0-9]{64}\.webp$/);
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
    expect(value.db.job?.queue_published_at).toBeTruthy();
    expect(value.send).toHaveBeenCalledWith(value.message, { delaySeconds: 30 });
  });

  it("persists distinct direct-upload and prebuilt renderer not-before boundaries", async () => {
    const direct = fixture();
    direct.db.job = undefined;
    const directStarted = Date.now();
    await enqueueThumbnailJob(direct.env, {
      sourceKey: direct.message.sourceKey,
      sourceEtag: direct.message.sourceEtag,
      sourceSize: 4096,
    });
    expect(Date.parse(direct.db.job!.render_not_before!) - directStarted).toBeGreaterThanOrEqual(29_000);
    expect(Date.parse(direct.db.job!.render_not_before!) - directStarted).toBeLessThan(31_000);

    const prebuilt = fixture();
    prebuilt.db.job = undefined;
    const prebuiltStarted = Date.now();
    await enqueueThumbnailJob(prebuilt.env, {
      sourceKey: prebuilt.message.sourceKey,
      sourceEtag: prebuilt.message.sourceEtag,
      sourceSize: 4096,
      delaySeconds: 15 * 60,
    });
    expect(Date.parse(prebuilt.db.job!.render_not_before!) - prebuiltStarted).toBeGreaterThanOrEqual(899_000);
    expect(Date.parse(prebuilt.db.job!.render_not_before!) - prebuiltStarted).toBeLessThan(901_000);
    expect(prebuilt.send).toHaveBeenCalledWith(prebuilt.message, { delaySeconds: 15 * 60 });
  });

  it("fails an oversized PDF before any source-body read", async () => {
    const value = fixture({
      sourceKey: "Jobs/Clients/Synthetic/oversized.pdf",
      contentType: "application/pdf",
      size: PDF_THUMBNAIL_MAX_INPUT_BYTES + 1,
    });

    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({ outcome: "failed", errorCode: "input_too_large" });
    expect(value.getKeys).toEqual([]);
    expect(value.db.job).toMatchObject({ status: "failed", error_code: "input_too_large" });
  });

  it("leaves a video row pending for TrueNAS without claim or source-body/Container access", async () => {
    const value = fixture({ sourceKey: "Jobs/Clients/Synthetic/flight.mp4", contentType: "video/mp4" });

    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "pending",
      thumbnailKey: value.db.job?.thumbnail_key,
    });
    expect(value.db.claims).toBe(0);
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 0, error_code: null });
    expect(value.getKeys).toEqual([]);
    expect(value.renderThumbnail).not.toHaveBeenCalled();
  });

  it("acknowledges a live TrueNAS still lease after location work without burning a queue retry", async () => {
    const value = fixture();
    Object.assign(value.db.job!, { status: "processing", lease_active: 1 });
    const queue = queueBatch(value.message, 1);

    await consumeThumbnailJobs(queue.batch, value.env);

    expect(queue.ack).toHaveBeenCalledOnce();
    expect(queue.retry).not.toHaveBeenCalled();
    expect(value.db.claims).toBe(0);
    expect(value.db.job).toMatchObject({ status: "processing", lease_active: 1 });
    expect(value.renderThumbnail).not.toHaveBeenCalled();
  });

  it("keeps an unfailed still backlog on a healthy fully-busy TrueNAS pool beyond the initial delay", async () => {
    const value = fixture({ primaryHealthy: true });
    value.db.job!.queue_published_at = "2026-08-24 10:00:00";
    const queue = queueBatch(value.message, 1);

    await consumeThumbnailJobs(queue.batch, value.env);

    expect(queue.ack).toHaveBeenCalledOnce();
    expect(queue.retry).not.toHaveBeenCalled();
    expect(value.db.claims).toBe(0);
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 0, queue_published_at: null });
    expect(value.renderThumbnail).not.toHaveBeenCalled();
    expect(value.getKeys).toEqual([]);
  });

  it("lets Cloudflare render a retryable failed still even while TrueNAS presence is healthy", async () => {
    const value = fixture({ primaryHealthy: true });
    Object.assign(value.db.job!, { error_code: "decode_failed", error_message: "TrueNAS decoder failed" });

    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "ready",
      thumbnailKey: value.db.job?.thumbnail_key,
    });

    expect(value.db.claims).toBe(1);
    expect(value.renderThumbnail).toHaveBeenCalledOnce();
    expect(value.db.job).toMatchObject({ status: "ready", error_code: null });
  });

  it("republishes exact unpublished work only when primary presence is stale and serializes overlapping cron runs", async () => {
    const value = fixture();

    await expect(republishPendingThumbnailFallbacks(value.env)).resolves.toBe(1);
    await expect(republishPendingThumbnailFallbacks(value.env)).resolves.toBe(0);

    expect(value.send).toHaveBeenCalledTimes(1);
    expect(value.send).toHaveBeenCalledWith(value.message);
    expect(value.db.job).toMatchObject({ status: "pending", queue_published_at: "2026-08-24 12:00:00" });
  });

  it("republishes a failed-over still despite healthy primary presence but leaves unfailed primary work alone", async () => {
    const unfailed = fixture({ primaryHealthy: true });
    await expect(republishPendingThumbnailFallbacks(unfailed.env)).resolves.toBe(0);
    expect(unfailed.send).not.toHaveBeenCalled();

    const failedOver = fixture({ primaryHealthy: true });
    failedOver.db.job!.error_code = "decode_failed";
    await expect(republishPendingThumbnailFallbacks(failedOver.env)).resolves.toBe(1);
    expect(failedOver.send).toHaveBeenCalledWith(failedOver.message);
  });

  it("keeps a retryable video failure durable and pollable while its queue signal is republished", async () => {
    const value = fixture({ sourceKey: "Jobs/Clients/Synthetic/flight.mp4", contentType: "video/mp4", primaryHealthy: true });
    value.db.job!.error_code = "decode_failed";

    await expect(republishPendingThumbnailFallbacks(value.env)).resolves.toBe(1);
    expect(value.send).toHaveBeenCalledWith(value.message);
    expect(value.db.job).toMatchObject({ status: "pending", error_code: "decode_failed" });

    const queue = queueBatch(value.message);
    await consumeThumbnailJobs(queue.batch, value.env);
    expect(queue.ack).toHaveBeenCalledOnce();
    expect(value.db.job).toMatchObject({ status: "pending", error_code: "decode_failed" });
    expect(value.renderThumbnail).not.toHaveBeenCalled();
  });

  it.each([
    ["Jobs/Clients/Synthetic/flight.mp4", "image/jpeg"],
    ["Jobs/Clients/Synthetic/disguised.jpg", "video/mp4"],
  ])("registers and publishes video identity for the TrueNAS claim queue: %s", async (sourceKey, contentType) => {
    const value = fixture({ sourceKey, contentType });
    value.db.job = undefined;

    await expect(enqueueThumbnailJob(value.env, {
      sourceKey,
      sourceEtag: value.message.sourceEtag,
      sourceSize: 4096,
      contentType,
    })).resolves.toEqual({ enqueued: true, state: "pending" });
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(value.send).toHaveBeenCalledOnce();
  });

  it.each([
    ["Jobs/Clients/Synthetic/flight.mp4", "image/jpeg"],
    ["Jobs/Clients/Synthetic/disguised.jpg", "video/mp4"],
  ])("acks a video queue signal while preserving pending TrueNAS work: %s", async (sourceKey, contentType) => {
    const value = fixture({ sourceKey, contentType });
    const queue = queueBatch(value.message, THUMBNAIL_MAX_DELIVERY_ATTEMPTS);

    await consumeThumbnailJobs(queue.batch, value.env);

    expect(queue.ack).toHaveBeenCalledOnce();
    expect(queue.retry).not.toHaveBeenCalled();
    expect(value.db.claims).toBe(0);
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 0, error_code: null });
    expect(value.getKeys).toEqual([]);
    expect(value.renderThumbnail).not.toHaveBeenCalled();
  });

  it("publishes a same-version pending job only once after recording queue publication", async () => {
    const value = fixture();
    const input = {
      sourceKey: value.message.sourceKey,
      sourceEtag: value.message.sourceEtag,
      sourceSize: 4096,
      eventTime: "2026-08-02T12:00:00Z",
    };
    await expect(enqueueThumbnailJob(value.env, input)).resolves.toEqual({ enqueued: true, state: "pending" });
    await expect(enqueueThumbnailJob(value.env, input)).resolves.toEqual({ enqueued: false, state: "pending" });
    expect(value.send).toHaveBeenCalledTimes(1);
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

  it("does not touch R2 for a duplicate ready job", async () => {
    const value = fixture();
    Object.assign(value.db.job!, { status: "ready", thumbnail_etag: '"thumb-etag"', thumbnail_size: 1234 });
    expect((await processThumbnailJob(value.env, value.message)).outcome).toBe("duplicate");
    expect(value.getKeys).toEqual([]);
  });

  it("allows only one Container render when duplicate eligible queue events race", async () => {
    const value = fixture();
    const results = await Promise.all([
      processThumbnailJob(value.env, value.message),
      processThumbnailJob(value.env, value.message),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["ready", "retry"]);
    expect(value.db.job).toMatchObject({ status: "ready", attempt_count: 1 });
    expect(value.renderThumbnail).toHaveBeenCalledTimes(1);
    expect(value.putBodies).toHaveLength(1);
  });

  it("permanently rejects unsupported files without reading their body", async () => {
    const value = fixture({ sourceKey: "Jobs/Clients/Synthetic/archive.zip", contentType: "application/zip" });
    const result = await processThumbnailJob(value.env, value.message);
    expect(result).toEqual({ outcome: "failed", errorCode: "unsupported_file" });
    expect(value.getKeys).toEqual([]);
    expect(value.db.job).toMatchObject({ status: "failed", error_code: "unsupported_file" });
  });

  it("removes a tombstoned job before any source-body read or renderer handoff", async () => {
    const value = fixture({ tombstoneOnCheck: 1 });
    const result = await processThumbnailJob(value.env, value.message);
    expect(result).toEqual({ outcome: "obsolete" });
    expect(value.db.tombstoneChecks).toBe(1);
    expect(value.getKeys).toEqual([]);
    expect(value.db.job).toBeUndefined();
  });

  it("acknowledges an eligible queue message only after the Container result is ready", async () => {
    const value = fixture();
    const queue = queueBatch(value.message, 6);
    await consumeThumbnailJobs(queue.batch, value.env);
    expect(queue.ack).toHaveBeenCalledOnce();
    expect(queue.retry).not.toHaveBeenCalled();
    expect(value.db.job).toMatchObject({ status: "ready", attempt_count: 1 });
    expect(value.getKeys).toEqual([value.message.sourceKey]);
  });

  it("retries a transient Container timeout while leaving the exact-version job pending", async () => {
    const value = fixture({
      rendererResult: { ok: false, errorCode: "render_timeout", message: "bounded renderer timeout" },
    });
    const queue = queueBatch(value.message, 2);

    await consumeThumbnailJobs(queue.batch, value.env);

    expect(queue.ack).not.toHaveBeenCalled();
    expect(queue.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 1, error_code: "render_timeout" });
    expect(value.putBodies).toHaveLength(0);
  });

  it("releases the exact processing lease when the renderer RPC throws so a later delivery can claim", async () => {
    const value = fixture();
    value.renderThumbnail.mockRejectedValueOnce(new Error("synthetic Container startup outage"));

    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "retry",
      errorCode: "thumbnail_processing_error",
    });
    expect(value.db.job).toMatchObject({
      status: "pending",
      attempt_count: 1,
      error_code: "thumbnail_processing_error",
    });

    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "ready",
      thumbnailKey: value.db.job?.thumbnail_key,
    });
    expect(value.db.job).toMatchObject({ status: "ready", attempt_count: 2, error_code: null });
    expect(value.renderThumbnail).toHaveBeenCalledTimes(2);
  });

  it("does not clear a newer processing lease when a stale renderer attempt throws", async () => {
    const value = fixture();
    value.renderThumbnail.mockImplementationOnce(async () => {
      value.db.job!.attempt_count += 1;
      throw new Error("synthetic stale Container response");
    });

    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "retry",
      errorCode: "thumbnail_processing_error",
    });
    expect(value.db.job).toMatchObject({
      status: "processing",
      attempt_count: 2,
      error_code: null,
    });
  });

  it("keeps an unexpected final-attempt renderer failure visible through the DLQ", async () => {
    const value = fixture();
    value.renderThumbnail.mockRejectedValue(new Error("synthetic persistent Container outage"));
    const delivery = queueBatch(value.message, 6);

    await consumeThumbnailJobs(delivery.batch, value.env);

    expect(delivery.ack).not.toHaveBeenCalled();
    expect(delivery.retry).toHaveBeenCalledWith({ delaySeconds: 160 });
    expect(value.db.job).toMatchObject({
      status: "failed",
      attempt_count: 1,
      error_code: "thumbnail_processing_error",
      dead_lettered: false,
    });

    const deadLetter = queueBatch(value.message, 1, "ltds-thumbnail-jobs-dlq");
    await consumeThumbnailDeadLetters(deadLetter.batch, value.env);
    expect(deadLetter.ack).toHaveBeenCalledOnce();
    expect(value.db.job).toMatchObject({
      status: "failed",
      error_code: "thumbnail_processing_error",
      dead_lettered: true,
    });
  });

  it("does not let a delayed DLQ delivery fail a recovered or actively leased exact-version job", async () => {
    for (const status of ["pending", "processing"] as const) {
      const value = fixture();
      Object.assign(value.db.job!, {
        status,
        attempt_count: 7,
        error_code: null,
        error_message: null,
        dead_lettered: false,
      });
      const delayed = queueBatch(value.message, 1, "ltds-thumbnail-jobs-dlq");

      await consumeThumbnailDeadLetters(delayed.batch, value.env);

      expect(delayed.ack).toHaveBeenCalledOnce();
      expect(delayed.retry).not.toHaveBeenCalled();
      expect(value.db.job).toMatchObject({
        status,
        attempt_count: 7,
        error_code: null,
        dead_lettered: false,
      });
    }
  });

  it("acks a Cloudflare pixel-limit rejection and returns the exact job to TrueNAS", async () => {
    const value = fixture({
      rendererResult: { ok: false, errorCode: "pixel_limit_exceeded", message: "decoded image exceeds 256 MP" },
    });
    const queue = queueBatch(value.message);

    await consumeThumbnailJobs(queue.batch, value.env);

    expect(queue.ack).toHaveBeenCalledOnce();
    expect(queue.retry).not.toHaveBeenCalled();
    expect(value.db.job).toMatchObject({
      status: "pending",
      attempt_count: 1,
      error_code: "pixel_limit_exceeded",
      queue_published_at: null,
    });
    expect(value.putBodies).toHaveLength(0);

    value.db.fallbackLockAvailable = true;
    await expect(republishPendingThumbnailFallbacks(value.env)).resolves.toBe(0);
    expect(value.send).not.toHaveBeenCalled();
  });

  it("adopts a valid sidecar winner that lands during the Container render race", async () => {
    const value = fixture({ sidecarWinner: true });

    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "ready",
      thumbnailKey: value.db.job?.thumbnail_key,
    });

    expect(value.renderThumbnail).toHaveBeenCalledOnce();
    expect(value.putBodies).toHaveLength(0);
    expect(value.getKeys).toEqual([value.message.sourceKey, value.db.job?.thumbnail_key]);
    expect(value.db.job).toMatchObject({ status: "ready", attempt_count: 1 });
  });

  it("prevents an old claimant from completing after a newer processing attempt wins the lease", async () => {
    const value = fixture({
      duringRender(db) {
        if (!db.job) throw new Error("expected active thumbnail job");
        db.job.status = "processing";
        db.job.attempt_count += 1;
      },
    });

    await expect(processThumbnailJob(value.env, value.message)).resolves.toEqual({
      outcome: "failed",
      errorCode: "completion_race",
    });
    expect(value.db.job).toMatchObject({
      status: "processing",
      attempt_count: 2,
      thumbnail_etag: null,
    });
  });

  it("gives an exhausted transient failure one bounded second queue lifecycle without reading the original body", async () => {
    const value = fixture();
    Object.assign(value.db.job!, {
      status: "failed",
      attempt_count: 6,
      error_code: "thumbnail_processing_error",
      error_message: "temporary transform outage",
      dead_lettered: true,
    });

    await expect(recoverTransientThumbnailFailures(value.env)).resolves.toBe(1);
    expect(value.send).toHaveBeenCalledWith(value.message);
    expect(value.getKeys).toEqual([]);
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 7, error_code: null, dead_lettered: false });
    expect(value.db.job?.queue_published_at).toBeTruthy();
  });

  it("recovers a video row failed by the disabled release into pending TrueNAS work", async () => {
    const value = fixture({ sourceKey: "Jobs/Clients/Synthetic/legacy.mov", contentType: "video/quicktime" });
    Object.assign(value.db.job!, {
      status: "failed",
      attempt_count: 0,
      error_code: "video_thumbnail_disabled",
      error_message: "Video thumbnail rendering is disabled for this release",
    });

    await expect(recoverTransientThumbnailFailures(value.env)).resolves.toBe(1);
    expect(value.send).toHaveBeenCalledWith(value.message);
    expect(value.getKeys).toEqual([]);
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 1, error_code: null });
  });

  it("requeues an expired TrueNAS video lease without reading or Container rendering", async () => {
    const value = fixture({ sourceKey: "Jobs/Clients/Synthetic/flight.mp4", contentType: "video/mp4" });
    Object.assign(value.db.job!, { status: "processing", attempt_count: 2 });

    await expect(recoverExpiredThumbnailLeases(value.env)).resolves.toMatchObject({ scanned: 1, queued: 1 });
    expect(value.send).toHaveBeenCalledWith(value.message);
    expect(value.getKeys).toEqual([]);
    expect(value.renderThumbnail).not.toHaveBeenCalled();
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 2 });
  });

  it("never republishes permanent or recovery-exhausted thumbnail failures", async () => {
    const permanent = fixture();
    Object.assign(permanent.db.job!, { status: "failed", attempt_count: 1, error_code: "input_too_large" });
    await expect(recoverTransientThumbnailFailures(permanent.env)).resolves.toBe(0);
    expect(permanent.send).not.toHaveBeenCalled();

    const exhausted = fixture();
    Object.assign(exhausted.db.job!, {
      status: "failed",
      attempt_count: THUMBNAIL_MAX_RECOVERY_ATTEMPTS,
      error_code: "thumbnail_processing_error",
    });
    await expect(recoverTransientThumbnailFailures(exhausted.env)).resolves.toBe(0);
    expect(exhausted.send).not.toHaveBeenCalled();
  });

  it("keeps recovery queue publication failures visible and bounded", async () => {
    const value = fixture({ queueError: new Error("queue unavailable") });
    Object.assign(value.db.job!, { status: "failed", attempt_count: 6, error_code: "thumbnail_processing_error" });

    await expect(recoverTransientThumbnailFailures(value.env)).resolves.toBe(0);
    expect(value.db.job).toMatchObject({ status: "failed", attempt_count: 7, error_code: "queue_publish_failed" });
    expect(value.getKeys).toEqual([]);
  });

  it("requeues one expired current processing lease exactly once without reading the original body", async () => {
    const value = fixture();
    Object.assign(value.db.job!, { status: "processing", attempt_count: 2 });

    await expect(recoverExpiredThumbnailLeases(value.env)).resolves.toEqual({
      scanned: 1,
      queued: 1,
      invalidated: 0,
      exhausted: 0,
      publishFailed: 0,
    });
    await expect(recoverExpiredThumbnailLeases(value.env)).resolves.toEqual({
      scanned: 0,
      queued: 0,
      invalidated: 0,
      exhausted: 0,
      publishFailed: 0,
    });
    expect(value.send).toHaveBeenCalledTimes(1);
    expect(value.send).toHaveBeenCalledWith(value.message);
    expect(value.getKeys).toEqual([]);
    expect(value.db.job).toMatchObject({ status: "pending", attempt_count: 2, queue_published_at: expect.any(String) });
  });

  it("leaves a fresh processing lease untouched", async () => {
    const value = fixture({ leaseExpired: false });
    Object.assign(value.db.job!, { status: "processing", attempt_count: 1 });

    await expect(recoverExpiredThumbnailLeases(value.env)).resolves.toMatchObject({ scanned: 0, queued: 0 });
    expect(value.send).not.toHaveBeenCalled();
    expect(value.db.job).toMatchObject({ status: "processing", attempt_count: 1 });
  });

  it.each([
    ["replaced index", { indexEtag: "new-version" }],
    ["replaced R2 object", { sourceHeadEtag: "new-version" }],
    ["deleted source", { sourceHeadMissing: true }],
    ["missing current index", { indexMissing: true }],
    ["trashed source", { tombstoneOnCheck: 1 }],
  ])("invalidates an expired %s job instead of resurrecting it", async (_label, options) => {
    const value = fixture(options);
    Object.assign(value.db.job!, { status: "processing", attempt_count: 2 });

    await expect(recoverExpiredThumbnailLeases(value.env)).resolves.toMatchObject({
      scanned: 1,
      queued: 0,
      invalidated: 1,
    });
    expect(value.send).not.toHaveBeenCalled();
    expect(value.getKeys).toEqual([]);
    expect(value.db.job).toBeUndefined();
  });

  it("keeps expired-lease queue publication failure visible and retry-bounded", async () => {
    const value = fixture({ queueError: new Error("queue unavailable") });
    Object.assign(value.db.job!, { status: "processing", attempt_count: 2 });

    await expect(recoverExpiredThumbnailLeases(value.env)).resolves.toEqual({
      scanned: 1,
      queued: 0,
      invalidated: 0,
      exhausted: 0,
      publishFailed: 1,
    });
    expect(value.db.job).toMatchObject({ status: "failed", attempt_count: 2, error_code: "queue_publish_failed" });
    expect(value.getKeys).toEqual([]);
  });

  it("terminally exposes an expired processing lease at the recovery ceiling", async () => {
    const value = fixture();
    Object.assign(value.db.job!, {
      status: "processing",
      attempt_count: THUMBNAIL_MAX_RECOVERY_ATTEMPTS,
    });

    await expect(recoverExpiredThumbnailLeases(value.env)).resolves.toMatchObject({
      scanned: 1,
      queued: 0,
      exhausted: 1,
    });
    expect(value.send).not.toHaveBeenCalled();
    expect(value.db.job).toMatchObject({ status: "failed", error_code: "retry_exhausted" });
  });

  it("serves only a ready WebP after the caller has authorized the source", async () => {
    const value = fixture();
    const thumbnailKey = value.db.job!.thumbnail_key;
    const thumbnail = r2Object(thumbnailKey, "thumb-etag", 1234, "image/webp", value.thumbnailBody);
    thumbnail.customMetadata = { sourceEtag: value.message.sourceEtag };
    value.stored.set(thumbnailKey, thumbnail);
    Object.assign(value.db.job!, {
      status: "ready",
      thumbnail_etag: thumbnail.httpEtag,
      thumbnail_size: thumbnail.size,
    });
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
