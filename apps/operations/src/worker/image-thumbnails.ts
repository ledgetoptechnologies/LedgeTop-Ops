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
  source_etag: string;
  thumbnail_key: string;
  status: "pending" | "processing" | "ready" | "failed";
  error_code: string | null;
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

/** A filename-free, stable key. D1 source_etag gates stale delivery after an overwrite. */
export async function thumbnailObjectKey(sourceKey: string): Promise<string> {
  const material = new TextEncoder().encode(`ltds-thumbnail:v1\0${sourceKey}`);
  return `_ltds/thumbnails/v1/${hex(await crypto.subtle.digest("SHA-256", material))}.webp`;
}

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

function supportedImage(key: string, contentType?: string): boolean {
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
  const message = error instanceof Error ? error.message : "Unknown thumbnail processing error";
  return { code: "thumbnail_processing_error", message, permanent: false };
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 240) || "Thumbnail processing failed";
}

async function registerJob(
  env: Env,
  sourceKey: string,
  sourceEtag: string,
  sourceSize: number,
  thumbnailKey: string,
): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.register */
    INSERT INTO image_thumbnail_jobs(source_key,source_etag,source_size,thumbnail_key,status,last_event_at)
    VALUES(?,?,?,?,'pending',datetime('now'))
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
      last_event_at=datetime('now'),updated_at=datetime('now')`)
    .bind(sourceKey, sourceEtag, sourceSize, thumbnailKey)
    .run();
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
  input: { sourceKey: string; sourceEtag: string; sourceSize: number },
): Promise<{ enqueued: boolean; state: ThumbnailState }> {
  const sourceEtag = cleanEtag(input.sourceEtag);
  if (!input.sourceKey || !sourceEtag || !Number.isSafeInteger(input.sourceSize) || input.sourceSize < 0) {
    throw new Error("Invalid thumbnail enqueue input");
  }
  const thumbnailKey = await thumbnailObjectKey(input.sourceKey);
  await registerJob(env, input.sourceKey, sourceEtag, input.sourceSize, thumbnailKey);
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
  const current = await getThumbnailState(env, input.sourceKey, sourceEtag);
  if (current.state === "ready" || current.state === "failed") return { enqueued: false, state: current.state };
  try {
    await env.THUMBNAIL_QUEUE.send({ kind: THUMBNAIL_JOB_KIND, sourceKey: input.sourceKey, sourceEtag });
    return { enqueued: true, state: "pending" };
  } catch (error) {
    await env.DELIVERY_DB.prepare(`/* thumbnail.enqueue-fail */
      UPDATE image_thumbnail_jobs
      SET status='failed',error_code='queue_publish_failed',error_message=?,failed_at=datetime('now'),updated_at=datetime('now')
      WHERE source_key=? AND source_etag=? AND status='pending'`)
      .bind(safeErrorMessage(error instanceof Error ? error.message : "Thumbnail queue publish failed"), input.sourceKey, sourceEtag)
      .run();
    throw error;
  }
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

  const thumbnailKey = await thumbnailObjectKey(message.sourceKey);
  await registerJob(env, message.sourceKey, sourceEtag, sourceHead.size, thumbnailKey);
  await resetQueuePublishFailure(env, message.sourceKey, sourceEtag);
  if (!(await claimJob(env, message.sourceKey, sourceEtag))) return { outcome: "duplicate", thumbnailKey };

  try {
    if (!supportedImage(message.sourceKey, sourceHead.httpMetadata?.contentType)) {
      throw new PermanentThumbnailError("unsupported_file", "The original is not a supported image format");
    }
    if (sourceHead.size > THUMBNAIL_MAX_INPUT_BYTES) {
      throw new PermanentThumbnailError("input_too_large", "The original exceeds the Cloudflare Images binding input limit");
    }

    const source = await env.DATA_BUCKET.get(message.sourceKey);
    if (!source || cleanEtag(source.httpEtag) !== sourceEtag) {
      throw new Error("The original changed or disappeared before thumbnail generation");
    }
    const transformed = await env.IMAGES.input(source.body)
      .transform({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, fit: "cover", gravity: "center" })
      .output({ format: "image/webp", quality: 78, anim: false });
    if (transformed.contentType() !== "image/webp") {
      throw new PermanentThumbnailError("invalid_transform_output", "Cloudflare Images returned an unexpected output format");
    }

    const currentSource = await env.DATA_BUCKET.head(message.sourceKey);
    if (!currentSource || cleanEtag(currentSource.httpEtag) !== sourceEtag) {
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
      await env.DATA_BUCKET.delete(thumbnailKey);
      throw new PermanentThumbnailError("output_too_large", "The generated thumbnail exceeds the delivery size limit");
    }
    if (!(await completeJob(env, message.sourceKey, sourceEtag, stored))) return { outcome: "obsolete" };
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
