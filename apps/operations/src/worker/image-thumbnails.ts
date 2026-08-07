import type { Env } from "./types";

export const THUMBNAIL_JOB_KIND = "image-thumbnail.v1" as const;
export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 240;
export const THUMBNAIL_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const THUMBNAIL_MAX_OUTPUT_BYTES = 128 * 1024;
export const THUMBNAIL_MAX_DELIVERY_ATTEMPTS = 6;

const THUMBNAIL_LEASE_MINUTES = 5;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["avif", "gif", "heic", "heif", "jpeg", "jpg", "png", "webp"]);
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ThumbnailJobMessage {
  kind: typeof THUMBNAIL_JOB_KIND;
  sourceKey: string;
  sourceEtag: string;
}

export interface ThumbnailEnqueueInput {
  sourceKey: string;
  sourceEtag: string;
  sourceSize: number;
  eventTime?: string;
}

export type ThumbnailJobOutcome =
  | { outcome: "ready"; thumbnailKey: string }
  | { outcome: "duplicate"; thumbnailKey: string }
  | { outcome: "obsolete" }
  | { outcome: "failed"; errorCode: string }
  | { outcome: "retry"; errorCode: string };

export type ThumbnailState = "pending" | "ready" | "failed";

export interface ThumbnailStateRecord {
  state: ThumbnailState;
  thumbnailKey?: string;
  errorCode?: string;
}

export type AuthorizedThumbnail =
  | { state: "ready"; object: R2ObjectBody; sourceEtag: string; thumbnailKey: string }
  | { state: "pending" | "failed"; object: null; errorCode?: string };

export interface ThumbnailJobRow {
  source_key?: string;
  source_etag: string;
  thumbnail_key: string;
  status: "pending" | "processing" | "ready" | "failed";
  error_code: string | null;
  queue_published_at?: string | null;
}

export type ThumbnailQueueBatchKind = "jobs" | "dead_letters" | "other" | "mixed";

/** Cloudflare preserves the original body when moving a message to a DLQ. */
export function classifyThumbnailQueueBatch(
  batch: Pick<MessageBatch<unknown>, "queue" | "messages">,
): ThumbnailQueueBatchKind {
  const thumbnailMessages = batch.messages.filter((message) => isThumbnailJobMessage(message.body)).length;
  if (thumbnailMessages === 0) return "other";
  if (thumbnailMessages !== batch.messages.length) return "mixed";
  return /(?:^|[-_.])(?:dlq|dead[-_.]?letters?)(?:$|[-_.])/i.test(batch.queue) ? "dead_letters" : "jobs";
}

export function thumbnailStateForObject(sourceEtag: string, job: ThumbnailJobRow | null | undefined): ThumbnailStateRecord {
  if (!job || cleanEtag(job.source_etag) !== cleanEtag(sourceEtag)) return { state: "pending" };
  if (job.status === "ready") return { state: "ready", thumbnailKey: job.thumbnail_key };
  if (job.status === "failed") return { state: "failed", errorCode: job.error_code || undefined };
  return { state: "pending", errorCode: job.error_code || undefined };
}

class PermanentThumbnailError extends Error {
  constructor(readonly errorCode: string, message: string) {
    super(message);
    this.name = "PermanentThumbnailError";
  }
}

function cleanEtag(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** A filename-free key scoped to an exact source object version. */
export async function thumbnailObjectKey(sourceKey: string, sourceEtag: string): Promise<string> {
  const material = new TextEncoder().encode(`ltds-thumbnail:v2\0${sourceKey}\0${cleanEtag(sourceEtag)}`);
  return `_ltds/thumbnails/v2/${hex(await crypto.subtle.digest("SHA-256", material))}.webp`;
}

interface ThumbnailCleanupRow {
  thumbnail_key: string;
  source_key: string;
  source_etag: string;
  attempt_count: number;
}

const THUMBNAIL_CLEANUP_MAX_ATTEMPTS = 8;

export function isThumbnailJobMessage(value: unknown): value is ThumbnailJobMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ThumbnailJobMessage>;
  return candidate.kind === THUMBNAIL_JOB_KIND &&
    typeof candidate.sourceKey === "string" && candidate.sourceKey.length > 0 && candidate.sourceKey.length <= 1024 &&
    typeof candidate.sourceEtag === "string" && cleanEtag(candidate.sourceEtag).length > 0 && candidate.sourceEtag.length <= 256;
}

function extension(key: string): string {
  const leaf = key.replace(/\\/g, "/").split("/").pop() || "";
  return leaf.includes(".") ? leaf.slice(leaf.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function supportedThumbnailSource(key: string, contentType?: string): boolean {
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean((normalizedType && SUPPORTED_IMAGE_CONTENT_TYPES.has(normalizedType)) || SUPPORTED_IMAGE_EXTENSIONS.has(extension(key)));
}

function errorDetails(error: unknown): { code: string; message: string; permanent: boolean } {
  if (error instanceof PermanentThumbnailError) {
    return { code: error.errorCode, message: error.message, permanent: true };
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 9412) {
    return { code: "invalid_image", message: "Cloudflare Images rejected the original image", permanent: true };
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 9422) {
    return { code: "images_quota_exceeded", message: "Cloudflare Images transformation quota is exhausted", permanent: true };
  }
  const message = error instanceof Error ? error.message : "Unknown thumbnail processing error";
  return { code: "thumbnail_processing_error", message, permanent: false };
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 240) || "Thumbnail processing failed";
}

async function currentJob(env: Pick<Env, "DELIVERY_DB">, sourceKey: string): Promise<ThumbnailJobRow | null> {
  return env.DELIVERY_DB.prepare(`/* thumbnail.current-row */
    SELECT source_etag,thumbnail_key,status,error_code,queue_published_at FROM image_thumbnail_jobs WHERE source_key=?`)
    .bind(sourceKey)
    .first<ThumbnailJobRow>();
}

async function scheduleThumbnailCleanup(
  env: Pick<Env, "DELIVERY_DB">,
  input: { thumbnailKey: string; sourceKey: string; sourceEtag: string; reason: string },
): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-schedule */
    INSERT INTO image_thumbnail_cleanup_jobs(thumbnail_key,source_key,source_etag,reason,status,next_attempt_at)
    VALUES(?,?,?,?,'pending',datetime('now'))
    ON CONFLICT(thumbnail_key) DO UPDATE SET
      status='pending',reason=excluded.reason,next_attempt_at=datetime('now'),
      lease_until=NULL,error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now')`)
    .bind(input.thumbnailKey, input.sourceKey, cleanEtag(input.sourceEtag), input.reason)
    .run();
}

function cleanupRetryDelay(attempt: number): string {
  return `+${Math.min(3600, 15 * 2 ** Math.max(0, attempt - 1))} seconds`;
}

export async function drainThumbnailCleanup(env: Env, limit = 100): Promise<number> {
  const due = await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-due */
    SELECT thumbnail_key,source_key,source_etag,attempt_count FROM image_thumbnail_cleanup_jobs
    WHERE ((status IN ('pending','failed') AND (next_attempt_at IS NULL OR datetime(next_attempt_at)<=datetime('now')))
      OR (status='processing' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now'))))
      AND attempt_count<? ORDER BY updated_at LIMIT ?`)
    .bind(THUMBNAIL_CLEANUP_MAX_ATTEMPTS, Math.max(1, Math.min(100, limit)))
    .all<ThumbnailCleanupRow>();
  let completed = 0;
  for (const cleanup of due.results) {
    const claimed = await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-claim */
      UPDATE image_thumbnail_cleanup_jobs SET status='processing',attempt_count=attempt_count+1,
        lease_until=datetime('now',?),updated_at=datetime('now')
      WHERE thumbnail_key=? AND ((status IN ('pending','failed')
          AND (next_attempt_at IS NULL OR datetime(next_attempt_at)<=datetime('now')))
        OR (status='processing' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now'))))`)
      .bind(`+${THUMBNAIL_LEASE_MINUTES} minutes`, cleanup.thumbnail_key).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      const referenced = await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-referenced */
        SELECT source_key,status FROM image_thumbnail_jobs WHERE thumbnail_key=? LIMIT 1`)
        .bind(cleanup.thumbnail_key).first<{ source_key: string; status: ThumbnailJobRow["status"] }>();
      if (referenced && referenced.status !== "failed") {
        await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-complete */
          UPDATE image_thumbnail_cleanup_jobs SET status='completed',error_code='still_referenced',error_message=NULL,
            next_attempt_at=NULL,lease_until=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE thumbnail_key=?`)
          .bind(cleanup.thumbnail_key).run();
        completed += 1;
        continue;
      }
      await env.DATA_BUCKET.delete(cleanup.thumbnail_key);
      if (await env.DATA_BUCKET.head(cleanup.thumbnail_key)) throw new Error("Thumbnail object still exists after delete");
      const revived = await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-revived */
        SELECT source_key,source_etag,status FROM image_thumbnail_jobs WHERE thumbnail_key=? LIMIT 1`)
        .bind(cleanup.thumbnail_key)
        .first<{ source_key: string; source_etag: string; status: ThumbnailJobRow["status"] }>();
      if (revived && revived.status !== "failed") {
        await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-regenerate */
          UPDATE image_thumbnail_jobs SET status='pending',thumbnail_etag=NULL,thumbnail_size=NULL,
            error_code=NULL,error_message=NULL,lease_until=NULL,ready_at=NULL,failed_at=NULL,updated_at=datetime('now')
          WHERE source_key=? AND source_etag=? AND thumbnail_key=? AND status<>'failed'`)
          .bind(revived.source_key, revived.source_etag, cleanup.thumbnail_key).run();
        try {
          await env.THUMBNAIL_QUEUE.send({ kind: THUMBNAIL_JOB_KIND, sourceKey: revived.source_key, sourceEtag: cleanEtag(revived.source_etag) });
        } catch (error) {
          await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-regenerate-failed */
            UPDATE image_thumbnail_jobs SET status='failed',error_code='queue_publish_failed',error_message=?,
              failed_at=datetime('now'),updated_at=datetime('now') WHERE source_key=? AND source_etag=? AND status='pending'`)
            .bind(safeErrorMessage(error instanceof Error ? error.message : "Thumbnail regeneration queue publish failed"), revived.source_key, revived.source_etag)
            .run();
          throw error;
        }
      }
      await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-complete */
        UPDATE image_thumbnail_cleanup_jobs SET status='completed',error_code=NULL,error_message=NULL,
          next_attempt_at=NULL,lease_until=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE thumbnail_key=?`)
        .bind(cleanup.thumbnail_key).run();
      completed += 1;
    } catch (error) {
      const nextAttempt = cleanup.attempt_count + 1;
      const terminal = nextAttempt >= THUMBNAIL_CLEANUP_MAX_ATTEMPTS;
      await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-fail */
        UPDATE image_thumbnail_cleanup_jobs SET status='failed',error_code=?,error_message=?,
          next_attempt_at=CASE WHEN ? THEN NULL ELSE datetime('now',?) END,lease_until=NULL,updated_at=datetime('now')
        WHERE thumbnail_key=?`)
        .bind(terminal ? "cleanup_exhausted" : "cleanup_retry", safeErrorMessage(error instanceof Error ? error.message : "Thumbnail cleanup failed"), terminal, cleanupRetryDelay(nextAttempt), cleanup.thumbnail_key)
        .run();
    }
  }
  await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-prune */
    DELETE FROM image_thumbnail_cleanup_jobs WHERE status='completed' AND datetime(completed_at)<=datetime('now','-7 days')`).run();
  return completed;
}

export function canonicalThumbnailSourceKey(key: string): boolean {
  if (!key.startsWith("Jobs/Clients/") || key.length > 1024 || key.includes("\\") || /[\0-\x1f\x7f]/.test(key)) return false;
  const parts = key.split("/");
  return parts.every(part => part && part !== "." && part !== ".." && !["_ltds", ".previews", "dump"].includes(part.toLowerCase()));
}

export function normalizeThumbnailEventTime(value: string | undefined, now = new Date()): string {
  const nowMs = now.getTime();
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return now.toISOString();
  // Managed R2 event timestamps are historical observations. Never let an
  // internal message pin a source path ahead of the consumer's trusted clock.
  return new Date(Math.min(parsed, nowMs)).toISOString();
}

async function registerJob(
  env: Env,
  sourceKey: string,
  sourceEtag: string,
  sourceSize: number,
  thumbnailKey: string,
  eventTime: string,
): Promise<{ applied: boolean; previousThumbnailKey?: string }> {
  const previous = await currentJob(env, sourceKey);
  await env.DELIVERY_DB.prepare(`/* thumbnail.register */
    INSERT INTO image_thumbnail_jobs(source_key,source_etag,source_size,thumbnail_key,status,last_event_at)
    VALUES(?,?,?,?,'pending',?)
    ON CONFLICT(source_key) DO UPDATE SET
      source_etag=excluded.source_etag,
      source_size=excluded.source_size,
      thumbnail_key=excluded.thumbnail_key,
      thumbnail_etag=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.thumbnail_etag ELSE NULL END,
      thumbnail_size=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.thumbnail_size ELSE NULL END,
      status=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.status ELSE 'pending' END,
      attempt_count=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.attempt_count ELSE 0 END,
      error_code=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.error_code ELSE NULL END,
      error_message=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.error_message ELSE NULL END,
      lease_until=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.lease_until ELSE NULL END,
      ready_at=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.ready_at ELSE NULL END,
      failed_at=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.failed_at ELSE NULL END,
      dead_lettered_at=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.dead_lettered_at ELSE NULL END,
      queue_published_at=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.queue_published_at ELSE NULL END,
      last_event_at=excluded.last_event_at,updated_at=datetime('now')
    WHERE image_thumbnail_jobs.last_event_at IS NULL
      OR julianday(excluded.last_event_at)>julianday(image_thumbnail_jobs.last_event_at)
      OR (julianday(excluded.last_event_at)=julianday(image_thumbnail_jobs.last_event_at)
        AND image_thumbnail_jobs.source_etag=excluded.source_etag)`)
    .bind(sourceKey, sourceEtag, sourceSize, thumbnailKey, eventTime)
    .run();
  const registered = await currentJob(env, sourceKey);
  const applied = Boolean(registered && cleanEtag(registered.source_etag) === sourceEtag && registered.thumbnail_key === thumbnailKey);
  if (applied && previous?.thumbnail_key && previous.thumbnail_key !== thumbnailKey) {
    await scheduleThumbnailCleanup(env, {
      thumbnailKey: previous.thumbnail_key,
      sourceKey,
      sourceEtag: previous.source_etag,
      reason: "source_replaced",
    });
    await drainThumbnailCleanup(env, 1);
  }
  return { applied, ...(previous?.thumbnail_key ? { previousThumbnailKey: previous.thumbnail_key } : {}) };
}

async function resetQueuePublishFailure(env: Env, sourceKey: string, sourceEtag: string): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.requeue */
    UPDATE image_thumbnail_jobs SET status='pending',error_code=NULL,error_message=NULL,failed_at=NULL,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='failed' AND error_code='queue_publish_failed'`)
    .bind(sourceKey, sourceEtag)
    .run();
}

export async function enqueueThumbnailJob(
  env: Env,
  input: ThumbnailEnqueueInput,
): Promise<{ enqueued: boolean; state: ThumbnailState }> {
  const sourceEtag = cleanEtag(input.sourceEtag);
  if (!canonicalThumbnailSourceKey(input.sourceKey) || !sourceEtag || !Number.isSafeInteger(input.sourceSize) || input.sourceSize < 0) {
    throw new Error("Invalid thumbnail enqueue input");
  }
  const thumbnailKey = await thumbnailObjectKey(input.sourceKey, sourceEtag);
  const eventTime = normalizeThumbnailEventTime(input.eventTime);
  const registration = await registerJob(env, input.sourceKey, sourceEtag, input.sourceSize, thumbnailKey, eventTime);
  if (!registration.applied) {
    const current = await currentJob(env, input.sourceKey);
    return { enqueued: false, state: current?.status === "ready" ? "ready" : current?.status === "failed" ? "failed" : "pending" };
  }
  await resetQueuePublishFailure(env, input.sourceKey, sourceEtag);
  if (input.sourceSize === 0) {
    await env.DELIVERY_DB.prepare(`/* thumbnail.empty-source */
      UPDATE image_thumbnail_jobs
      SET status='failed',thumbnail_etag=NULL,thumbnail_size=NULL,
        error_code='empty_source',error_message='The original image is empty',
        lease_until=NULL,failed_at=datetime('now'),updated_at=datetime('now')
      WHERE source_key=? AND source_etag=?`)
      .bind(input.sourceKey, sourceEtag)
      .run();
    return { enqueued: false, state: "failed" };
  }
  const current = await currentJob(env, input.sourceKey);
  if (current?.status === "ready" || current?.status === "failed") return { enqueued: false, state: current.status };
  if (current?.queue_published_at) return { enqueued: false, state: "pending" };
  try {
    await env.THUMBNAIL_QUEUE.send({ kind: THUMBNAIL_JOB_KIND, sourceKey: input.sourceKey, sourceEtag });
  } catch (error) {
    await env.DELIVERY_DB.prepare(`/* thumbnail.enqueue-fail */
      UPDATE image_thumbnail_jobs
      SET status='failed',error_code='queue_publish_failed',error_message=?,failed_at=datetime('now'),updated_at=datetime('now')
      WHERE source_key=? AND source_etag=? AND status='pending'`)
      .bind(safeErrorMessage(error instanceof Error ? error.message : "Thumbnail queue publish failed"), input.sourceKey, sourceEtag)
      .run();
    throw error;
  }
  try {
    await env.DELIVERY_DB.prepare(`/* thumbnail.publish-record */
      UPDATE image_thumbnail_jobs SET queue_published_at=COALESCE(queue_published_at,datetime('now')),updated_at=datetime('now')
      WHERE source_key=? AND source_etag=? AND status IN ('pending','processing')`)
      .bind(input.sourceKey, sourceEtag).run();
  } catch (error) {
    // The queue accepted the message. A marker write failure must not poison
    // the pending job: at-least-once delivery plus the versioned consumer is
    // safer than recording a false publish failure after successful send.
    console.error(JSON.stringify({
      event: "thumbnail.publish_marker.error",
      sourceKey: input.sourceKey,
      sourceEtag,
      message: safeErrorMessage(error instanceof Error ? error.message : "Thumbnail publish marker failed"),
    }));
  }
  return { enqueued: true, state: "pending" };
}

async function claimJob(env: Env, sourceKey: string, sourceEtag: string): Promise<boolean> {
  const claim = await env.DELIVERY_DB.prepare(`/* thumbnail.claim */
    UPDATE image_thumbnail_jobs
    SET status='processing',attempt_count=attempt_count+1,
      lease_until=datetime('now',?),updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND (
      status='pending' OR (status='processing' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now')))
    ) RETURNING attempt_count`)
    .bind(`+${THUMBNAIL_LEASE_MINUTES} minutes`, sourceKey, sourceEtag)
    .first<{ attempt_count: number }>();
  return Boolean(claim);
}

async function failJob(
  env: Env,
  sourceKey: string,
  sourceEtag: string,
  errorCode: string,
  message: string,
  terminal: boolean,
): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.fail */
    UPDATE image_thumbnail_jobs
    SET status=?,error_code=?,error_message=?,lease_until=NULL,
      failed_at=CASE WHEN ?='failed' THEN datetime('now') ELSE NULL END,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='processing'`)
    .bind(terminal ? "failed" : "pending", errorCode, safeErrorMessage(message), terminal ? "failed" : "pending", sourceKey, sourceEtag)
    .run();
}

async function completeJob(env: Env, sourceKey: string, sourceEtag: string, thumbnail: R2Object): Promise<boolean> {
  const result = await env.DELIVERY_DB.prepare(`/* thumbnail.ready */
    UPDATE image_thumbnail_jobs
    SET status='ready',thumbnail_etag=?,thumbnail_size=?,error_code=NULL,error_message=NULL,
      lease_until=NULL,ready_at=datetime('now'),failed_at=NULL,dead_lettered_at=NULL,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='processing'`)
    .bind(thumbnail.httpEtag, thumbnail.size, sourceKey, sourceEtag)
    .run();
  return result.meta.changes === 1;
}

async function sourceIsTrashed(env: Pick<Env, "DELIVERY_DB">, sourceKey: string): Promise<boolean> {
  const row = await env.DELIVERY_DB.prepare(`/* thumbnail.trashed */
    SELECT id FROM delivery_tombstones WHERE restored_at IS NULL
    AND (physical_key=? OR (tombstone_kind='prefix' AND substr(?,1,length(physical_key))=physical_key)) LIMIT 1`)
    .bind(sourceKey, sourceKey)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function removeThumbnailStateForPath(
  env: Env,
  sourceKey: string,
  isPrefix = false,
): Promise<{ rows: number; objects: number }> {
  const normalizedPrefix = isPrefix ? (sourceKey.endsWith("/") ? sourceKey : `${sourceKey}/`) : sourceKey;
  const exact = isPrefix ? null : await currentJob(env, sourceKey);
  const rows = isPrefix
    ? await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-list */
        SELECT source_key,source_etag,thumbnail_key,status,error_code FROM image_thumbnail_jobs
        WHERE substr(source_key,1,length(?))=? ORDER BY source_key`)
      .bind(normalizedPrefix, normalizedPrefix).all<ThumbnailJobRow>()
    : { results: exact ? [exact] : [] };
  if (!rows.results.length) return { rows: 0, objects: 0 };
  const statements = isPrefix
    ? [env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-delete-prefix */ DELETE FROM image_thumbnail_jobs WHERE substr(source_key,1,length(?))=?`).bind(normalizedPrefix, normalizedPrefix)]
    : rows.results.map(row => env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-delete */ DELETE FROM image_thumbnail_jobs WHERE source_key=? AND source_etag=?`).bind(sourceKey, row.source_etag));
  const deleted = await env.DELIVERY_DB.batch(statements);
  const removedRows = deleted.reduce((sum, result) => sum + Number(result.meta.changes || 0), 0);
  const keys = [...new Set(rows.results.map(row => row.thumbnail_key).filter(Boolean))];
  for (const row of rows.results) {
    await scheduleThumbnailCleanup(env, { thumbnailKey: row.thumbnail_key, sourceKey: row.source_key || sourceKey, sourceEtag: row.source_etag, reason: "source_removed" });
  }
  await drainThumbnailCleanup(env, Math.min(100, keys.length));
  return { rows: removedRows, objects: keys.length };
}

export async function enqueueThumbnailsForPath(env: Env, sourceKey: string, isPrefix: boolean): Promise<number> {
  const objects: R2Object[] = [];
  if (!isPrefix) {
    const object = await env.DATA_BUCKET.head(sourceKey);
    if (object) objects.push(object);
  } else {
    const prefix = sourceKey.endsWith("/") ? sourceKey : `${sourceKey}/`;
    let cursor: string | undefined;
    do {
      const page = await env.DATA_BUCKET.list({ prefix, limit: 1000, cursor });
      objects.push(...page.objects.filter(object => !object.key.endsWith("/")));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  let queued = 0;
  for (const object of objects) {
    if (!canonicalThumbnailSourceKey(object.key) || !supportedThumbnailSource(object.key, object.httpMetadata?.contentType)) continue;
    const result = await enqueueThumbnailJob(env, {
      sourceKey: object.key,
      sourceEtag: object.httpEtag,
      sourceSize: object.size,
      eventTime: object.uploaded.toISOString(),
    });
    if (result.enqueued) queued += 1;
  }
  return queued;
}

/**
 * Process one queue job. The original is streamed from private R2 directly into
 * Cloudflare Images and only the fixed WebP output stream is written to R2.
 */
export async function processThumbnailJob(
  env: Env,
  message: ThumbnailJobMessage,
  options: { finalAttempt?: boolean } = {},
): Promise<ThumbnailJobOutcome> {
  const sourceEtag = cleanEtag(message.sourceEtag);
  if (!canonicalThumbnailSourceKey(message.sourceKey)) return { outcome: "obsolete" };
  const registered = await currentJob(env, message.sourceKey);
  if (!registered || cleanEtag(registered.source_etag) !== sourceEtag) return { outcome: "obsolete" };
  const thumbnailKey = registered.thumbnail_key;
  if (registered.status === "ready") return { outcome: "duplicate", thumbnailKey };
  if (registered.status === "failed") return { outcome: "obsolete" };
  if (await sourceIsTrashed(env, message.sourceKey)) {
    await removeThumbnailStateForPath(env, message.sourceKey);
    return { outcome: "obsolete" };
  }
  const sourceHead = await env.DATA_BUCKET.head(message.sourceKey);
  if (!sourceHead) {
    if (await claimJob(env, message.sourceKey, sourceEtag)) {
      await failJob(env, message.sourceKey, sourceEtag, "source_missing", "The original no longer exists", true);
      return { outcome: "failed", errorCode: "source_missing" };
    }
    return { outcome: "obsolete" };
  }
  if (cleanEtag(sourceHead.httpEtag) !== sourceEtag) {
    if (await claimJob(env, message.sourceKey, sourceEtag)) {
      await failJob(env, message.sourceKey, sourceEtag, "source_changed", "The queued original version is obsolete", true);
    }
    return { outcome: "obsolete" };
  }

  if (!(await claimJob(env, message.sourceKey, sourceEtag))) return { outcome: "duplicate", thumbnailKey };

  try {
    if (!supportedThumbnailSource(message.sourceKey, sourceHead.httpMetadata?.contentType)) {
      throw new PermanentThumbnailError("unsupported_file", "The original is not a supported image format");
    }
    if (sourceHead.size > THUMBNAIL_MAX_INPUT_BYTES) {
      throw new PermanentThumbnailError("input_too_large", "The original exceeds the Cloudflare Images binding input limit");
    }

    // Trash can race the queue claim. Re-check immediately before the only
    // original-body read so a newly tombstoned source never reaches Images.
    if (await sourceIsTrashed(env, message.sourceKey)) {
      await removeThumbnailStateForPath(env, message.sourceKey);
      return { outcome: "obsolete" };
    }

    const source = await env.DATA_BUCKET.get(message.sourceKey);
    if (!source || cleanEtag(source.httpEtag) !== sourceEtag) {
      await failJob(env, message.sourceKey, sourceEtag, "source_changed", "The original changed before thumbnail generation", true);
      return { outcome: "obsolete" };
    }
    const transformed = await env.IMAGES.input(source.body)
      .transform({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, fit: "cover", gravity: "center" })
      .output({ format: "image/webp", quality: 78, anim: false });
    if (transformed.contentType() !== "image/webp") {
      throw new PermanentThumbnailError("invalid_transform_output", "Cloudflare Images returned an unexpected output format");
    }

    const currentSource = await env.DATA_BUCKET.head(message.sourceKey);
    if (!currentSource || cleanEtag(currentSource.httpEtag) !== sourceEtag || await sourceIsTrashed(env, message.sourceKey)) {
      await failJob(env, message.sourceKey, sourceEtag, "source_changed", "The original changed during thumbnail generation", true);
      return { outcome: "obsolete" };
    }
    const previousThumbnail = await env.DATA_BUCKET.head(thumbnailKey);

    const stored = await env.DATA_BUCKET.put(thumbnailKey, transformed.image(), {
      onlyIf: previousThumbnail
        ? { etagMatches: cleanEtag(previousThumbnail.httpEtag) }
        : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "image/webp", cacheControl: "private, no-store" },
      customMetadata: { sourceEtag },
    });
    if (!stored) {
      const state = await getThumbnailState(env, message.sourceKey, sourceEtag);
      if (state.state === "ready") return { outcome: "duplicate", thumbnailKey };
      throw new Error("A concurrent thumbnail writer changed the destination object");
    }
    if (stored.size <= 0) throw new Error("R2 did not persist the thumbnail output");
    if (stored.size > THUMBNAIL_MAX_OUTPUT_BYTES) {
      await failJob(env, message.sourceKey, sourceEtag, "output_too_large", "The generated thumbnail exceeds the delivery size limit", true);
      await scheduleThumbnailCleanup(env, { thumbnailKey, sourceKey: message.sourceKey, sourceEtag, reason: "invalid_output" });
      await drainThumbnailCleanup(env, 1);
      return { outcome: "failed", errorCode: "output_too_large" };
    }
    if (!(await completeJob(env, message.sourceKey, sourceEtag, stored))) {
      await scheduleThumbnailCleanup(env, { thumbnailKey, sourceKey: message.sourceKey, sourceEtag, reason: "lost_completion_race" });
      await drainThumbnailCleanup(env, 1);
      return { outcome: "obsolete" };
    }
    return { outcome: "ready", thumbnailKey };
  } catch (error) {
    const details = errorDetails(error);
    const terminal = details.permanent || options.finalAttempt === true;
    await failJob(env, message.sourceKey, sourceEtag, details.code, details.message, terminal);
    return terminal
      ? { outcome: "failed", errorCode: details.code }
      : { outcome: "retry", errorCode: details.code };
  }
}

function retryDelay(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}

export async function consumeThumbnailJobs(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const queueMessage of batch.messages) {
    if (!isThumbnailJobMessage(queueMessage.body)) {
      console.warn(JSON.stringify({ event: "thumbnail.job.invalid", messageId: queueMessage.id }));
      queueMessage.ack();
      continue;
    }
    try {
      const finalAttempt = queueMessage.attempts >= THUMBNAIL_MAX_DELIVERY_ATTEMPTS;
      const result = await processThumbnailJob(env, queueMessage.body, { finalAttempt });
      if (result.outcome === "retry" || (result.outcome === "failed" && finalAttempt)) {
        queueMessage.retry({ delaySeconds: retryDelay(queueMessage.attempts) });
      } else {
        queueMessage.ack();
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "thumbnail.job.error",
        messageId: queueMessage.id,
        message: safeErrorMessage(error instanceof Error ? error.message : "Unknown thumbnail queue error"),
      }));
      queueMessage.retry({ delaySeconds: retryDelay(queueMessage.attempts) });
    }
  }
}

export async function consumeThumbnailDeadLetters(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const queueMessage of batch.messages) {
    if (!isThumbnailJobMessage(queueMessage.body)) {
      queueMessage.ack();
      continue;
    }
    try {
      await env.DELIVERY_DB.prepare(`/* thumbnail.dead-letter */
        UPDATE image_thumbnail_jobs
        SET status='failed',error_code=COALESCE(error_code,'dead_lettered'),
          error_message=COALESCE(error_message,'Thumbnail retries were exhausted'),lease_until=NULL,
          failed_at=COALESCE(failed_at,datetime('now')),dead_lettered_at=datetime('now'),updated_at=datetime('now')
        WHERE source_key=? AND source_etag=? AND status<>'ready'`)
        .bind(queueMessage.body.sourceKey, cleanEtag(queueMessage.body.sourceEtag))
        .run();
      await scheduleThumbnailCleanup(env, {
        thumbnailKey: await thumbnailObjectKey(queueMessage.body.sourceKey, queueMessage.body.sourceEtag),
        sourceKey: queueMessage.body.sourceKey,
        sourceEtag: queueMessage.body.sourceEtag,
        reason: "dead_lettered",
      });
      await drainThumbnailCleanup(env, 1);
      queueMessage.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: "thumbnail.dead-letter.error",
        messageId: queueMessage.id,
        message: safeErrorMessage(error instanceof Error ? error.message : "Unknown thumbnail dead-letter error"),
      }));
      queueMessage.retry({ delaySeconds: 60 });
    }
  }
}

export async function getThumbnailState(
  env: Env,
  sourceKey: string,
  expectedSourceEtag?: string,
): Promise<ThumbnailStateRecord> {
  const row = await env.DELIVERY_DB.prepare(`/* thumbnail.state */
    SELECT source_etag,thumbnail_key,status,error_code FROM image_thumbnail_jobs WHERE source_key=?`)
    .bind(sourceKey)
    .first<ThumbnailJobRow>();
  if (!row) return { state: "pending" };
  return thumbnailStateForObject(expectedSourceEtag || row.source_etag, row);
}

/**
 * Call only after the route has authenticated and authorized sourceKey. This
 * helper verifies the current original ETag but never reads the original body.
 */
export async function getThumbnailForAuthorizedSource(env: Env, sourceKey: string): Promise<AuthorizedThumbnail> {
  const source = await env.DATA_BUCKET.head(sourceKey);
  if (!source) return { state: "pending", object: null };
  const state = await getThumbnailState(env, sourceKey, source.httpEtag);
  if (state.state !== "ready" || !state.thumbnailKey) {
    return { state: state.state === "failed" ? "failed" : "pending", object: null, errorCode: state.errorCode };
  }
  const object = await env.DATA_BUCKET.get(state.thumbnailKey);
  if (!object || object.httpMetadata?.contentType !== "image/webp" || object.size <= 0 || object.size > THUMBNAIL_MAX_OUTPUT_BYTES ||
    cleanEtag(object.customMetadata?.sourceEtag || "") !== cleanEtag(source.httpEtag)) return { state: "pending", object: null };
  return { state: "ready", object, sourceEtag: cleanEtag(source.httpEtag), thumbnailKey: state.thumbnailKey };
}
