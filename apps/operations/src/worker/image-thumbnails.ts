import type { Env } from "./types";
import { currentLocationStatus, deleteImageLocation, processImageLocation } from "./image-locations";
import { isMovedSourceMarker } from "@ltds/shared";
import { THUMBNAIL_RENDER_PROFILE, validWebp, type ContainerThumbnailErrorCode } from "./thumbnail-renderer-contract";

export const THUMBNAIL_JOB_KIND = "image-thumbnail.v1" as const;
export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 240;
export const THUMBNAIL_MAX_INPUT_BYTES = 512 * 1024 * 1024;
export const PDF_THUMBNAIL_MAX_INPUT_BYTES = 256 * 1024 * 1024;
/** Retained for compatibility only; video rendering is disabled in this release. */
export const VIDEO_THUMBNAIL_MAX_INPUT_BYTES = 100_000_000;
export const THUMBNAIL_MAX_OUTPUT_BYTES = 128 * 1024;
export const THUMBNAIL_MAX_DELIVERY_ATTEMPTS = 6;
export const THUMBNAIL_MAX_RECOVERY_ATTEMPTS = THUMBNAIL_MAX_DELIVERY_ATTEMPTS * 2;
export const THUMBNAIL_SIDECAR_GRACE_SECONDS = 30;
export const THUMBNAIL_PREBUILT_GRACE_SECONDS = 15 * 60;

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
  "image/tiff",
  "image/bmp",
]);
SUPPORTED_IMAGE_EXTENSIONS.add("tif");
SUPPORTED_IMAGE_EXTENSIONS.add("tiff");
SUPPORTED_IMAGE_EXTENSIONS.add("bmp");

export type ThumbnailSourceKind = "image" | "pdf";

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
  delaySeconds?: number;
}

export type ThumbnailJobOutcome =
  | { outcome: "ready"; thumbnailKey: string }
  | { outcome: "pending"; thumbnailKey: string }
  | { outcome: "duplicate"; thumbnailKey: string }
  | { outcome: "obsolete" }
  | { outcome: "failed"; errorCode: string }
  | { outcome: "retry"; errorCode: string };

export type ThumbnailState = "pending" | "ready" | "failed";

export interface ThumbnailStateRecord {
  state: ThumbnailState;
  thumbnailKey?: string;
  thumbnailEtag?: string;
  thumbnailProvider?: string;
  thumbnailProfile?: string;
  errorCode?: string;
}

export type AuthorizedThumbnail =
  | { state: "ready"; object: R2ObjectBody; sourceEtag: string; thumbnailKey: string }
  | { state: "pending" | "failed"; object: null; errorCode?: string };

export interface ThumbnailJobRow {
  source_key?: string;
  source_etag: string;
  thumbnail_key: string;
  thumbnail_etag?: string | null;
  thumbnail_provider?: string | null;
  thumbnail_profile?: string | null;
  thumbnail_manifest_key?: string | null;
  thumbnail_manifest_etag?: string | null;
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
  if (job.status === "ready") return {
    state: "ready",
    thumbnailKey: job.thumbnail_key,
    ...(job.thumbnail_etag ? { thumbnailEtag: cleanEtag(job.thumbnail_etag) } : {}),
    ...(job.thumbnail_provider ? { thumbnailProvider: job.thumbnail_provider } : {}),
    ...(job.thumbnail_profile ? { thumbnailProfile: job.thumbnail_profile } : {}),
  };
  if (job.status === "failed") return { state: "failed", errorCode: job.error_code || undefined };
  return { state: "pending", errorCode: job.error_code || undefined };
}

export function cleanThumbnailEtag(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}
const cleanEtag = cleanThumbnailEtag;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** A filename-free key scoped to an exact source object version. */
export async function thumbnailObjectKey(sourceKey: string, sourceEtag: string): Promise<string> {
  const material = new TextEncoder().encode(`ltds-thumbnail-managed:v1\0${sourceKey}\0${cleanEtag(sourceEtag)}`);
  return `_ltds/derivatives/thumbnails/v1/managed/${hex(await crypto.subtle.digest("SHA-256", material))}.webp`;
}

interface ThumbnailCleanupRow {
  thumbnail_key: string;
  source_key: string;
  source_etag: string;
  artifact_etag: string | null;
  attempt_count: number;
}

interface RecoverableThumbnailRow {
  source_key: string;
  source_etag: string;
  source_size: number;
}

const THUMBNAIL_CLEANUP_MAX_ATTEMPTS = 8;
const THUMBNAIL_MANAGED_ORPHAN_GRACE_MS = 60 * 60 * 1000;

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
  return thumbnailSourceKind(key, contentType) !== null;
}

export function thumbnailSourceKind(key: string, contentType?: string): ThumbnailSourceKind | null {
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const sourceExtension = extension(key);
  if (sourceExtension === "pdf" || normalizedType === "application/pdf") return "pdf";
  if ((normalizedType && SUPPORTED_IMAGE_CONTENT_TYPES.has(normalizedType)) || SUPPORTED_IMAGE_EXTENSIONS.has(sourceExtension)) return "image";
  return null;
}

export function thumbnailSourceWithinInputLimit(kind: ThumbnailSourceKind, size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= (kind === "pdf"
    ? PDF_THUMBNAIL_MAX_INPUT_BYTES
    : THUMBNAIL_MAX_INPUT_BYTES);
}

/**
 * Exact source eligibility shared by listing, generation, and authorized
 * delivery. Unsupported media must never reach a thumbnail body lookup through
 * a forged or stale D1 row.
 */
export function thumbnailSourceEligible(
  key: string,
  size: number,
  contentType?: string,
): boolean {
  const kind = thumbnailSourceKind(key, contentType);
  return kind !== null && thumbnailSourceWithinInputLimit(kind, size);
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 240) || "Thumbnail processing failed";
}

async function currentJob(env: Pick<Env, "DELIVERY_DB">, sourceKey: string): Promise<ThumbnailJobRow | null> {
  return env.DELIVERY_DB.prepare(`/* thumbnail.current-row */
    SELECT source_etag,thumbnail_key,thumbnail_etag,thumbnail_manifest_key,thumbnail_manifest_etag,
      status,error_code,queue_published_at FROM image_thumbnail_jobs WHERE source_key=?`)
    .bind(sourceKey)
    .first<ThumbnailJobRow>();
}

export async function scheduleThumbnailCleanup(
  env: Pick<Env, "DELIVERY_DB">,
  input: { thumbnailKey: string; sourceKey: string; sourceEtag: string; artifactEtag?: string | null; reason: string },
): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-schedule */
    INSERT INTO image_thumbnail_cleanup_jobs(thumbnail_key,source_key,source_etag,artifact_etag,reason,status,next_attempt_at)
    VALUES(?,?,?,?,?,'pending',datetime('now'))
    ON CONFLICT(thumbnail_key) DO UPDATE SET
      status='pending',artifact_etag=excluded.artifact_etag,reason=excluded.reason,next_attempt_at=datetime('now'),
      lease_until=NULL,error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now')`)
    .bind(input.thumbnailKey, input.sourceKey, cleanEtag(input.sourceEtag), input.artifactEtag ? cleanEtag(input.artifactEtag) : null, input.reason)
    .run();
}

function cleanupRetryDelay(attempt: number): string {
  return `+${Math.min(3600, 15 * 2 ** Math.max(0, attempt - 1))} seconds`;
}

export async function drainThumbnailCleanup(env: Env, limit = 100): Promise<number> {
  const due = await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-due */
    SELECT thumbnail_key,source_key,source_etag,artifact_etag,attempt_count FROM image_thumbnail_cleanup_jobs
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
        SELECT source_key,status FROM image_thumbnail_jobs WHERE thumbnail_key=? OR thumbnail_manifest_key=? LIMIT 1`)
        .bind(cleanup.thumbnail_key, cleanup.thumbnail_key).first<{ source_key: string; status: ThumbnailJobRow["status"] }>();
      if (referenced && referenced.status !== "failed") {
        await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-complete */
          UPDATE image_thumbnail_cleanup_jobs SET status='completed',error_code='still_referenced',error_message=NULL,
            next_attempt_at=NULL,lease_until=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE thumbnail_key=?`)
          .bind(cleanup.thumbnail_key).run();
        completed += 1;
        continue;
      }
      if (cleanup.artifact_etag) {
        const currentArtifact = await env.DATA_BUCKET.head(cleanup.thumbnail_key);
        if (currentArtifact && cleanEtag(currentArtifact.httpEtag) !== cleanEtag(cleanup.artifact_etag)) {
          await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-complete */
            UPDATE image_thumbnail_cleanup_jobs SET status='completed',error_code='artifact_version_changed',error_message=NULL,
              next_attempt_at=NULL,lease_until=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE thumbnail_key=?`)
            .bind(cleanup.thumbnail_key).run();
          completed += 1;
          continue;
        }
      }
      await env.DATA_BUCKET.delete(cleanup.thumbnail_key);
      if (await env.DATA_BUCKET.head(cleanup.thumbnail_key)) throw new Error("Thumbnail object still exists after delete");
      const revived = await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-revived */
        SELECT source_key,source_etag,status FROM image_thumbnail_jobs WHERE thumbnail_key=? OR thumbnail_manifest_key=? LIMIT 1`)
        .bind(cleanup.thumbnail_key, cleanup.thumbnail_key)
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
  if (!key.startsWith("Jobs/") || key.length > 1024 || key.includes("\\") || /[\0-\x1f\x7f]/.test(key)) return false;
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
      thumbnail_key=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag AND image_thumbnail_jobs.status='ready'
        THEN image_thumbnail_jobs.thumbnail_key ELSE excluded.thumbnail_key END,
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
      thumbnail_provider=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.thumbnail_provider ELSE NULL END,
      thumbnail_profile=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.thumbnail_profile ELSE NULL END,
      thumbnail_manifest_key=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.thumbnail_manifest_key ELSE NULL END,
      thumbnail_manifest_etag=CASE WHEN image_thumbnail_jobs.source_etag=excluded.source_etag THEN image_thumbnail_jobs.thumbnail_manifest_etag ELSE NULL END,
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
    const delaySeconds = Number.isSafeInteger(input.delaySeconds) && Number(input.delaySeconds) >= 0
      ? Math.min(THUMBNAIL_PREBUILT_GRACE_SECONDS, Number(input.delaySeconds))
      : THUMBNAIL_SIDECAR_GRACE_SECONDS;
    await env.THUMBNAIL_QUEUE.send(
      { kind: THUMBNAIL_JOB_KIND, sourceKey: input.sourceKey, sourceEtag },
      { delaySeconds },
    );
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

async function claimJob(env: Env, sourceKey: string, sourceEtag: string): Promise<number | null> {
  const claim = await env.DELIVERY_DB.prepare(`/* thumbnail.claim */
    UPDATE image_thumbnail_jobs
    SET status='processing',attempt_count=attempt_count+1,
      lease_until=datetime('now',?),updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND (
      status='pending' OR (status='processing' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now')))
    ) RETURNING attempt_count`)
    .bind(`+${THUMBNAIL_LEASE_MINUTES} minutes`, sourceKey, sourceEtag)
    .first<{ attempt_count: number }>();
  return claim?.attempt_count ?? null;
}

async function failJob(
  env: Env,
  sourceKey: string,
  sourceEtag: string,
  errorCode: string,
  message: string,
  terminal: boolean,
  expectedAttemptCount: number,
): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.fail */
    UPDATE image_thumbnail_jobs
    SET status=?,error_code=?,error_message=?,lease_until=NULL,
      failed_at=CASE WHEN ?='failed' THEN datetime('now') ELSE NULL END,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='processing' AND attempt_count=?`)
    .bind(terminal ? "failed" : "pending", errorCode, safeErrorMessage(message), terminal ? "failed" : "pending", sourceKey, sourceEtag, expectedAttemptCount)
    .run();
}

async function completeJob(
  env: Env,
  sourceKey: string,
  sourceEtag: string,
  thumbnail: R2Object,
  provider: "ltds-truenas" | "cloudflare-container",
): Promise<boolean> {
  const result = await env.DELIVERY_DB.prepare(`/* thumbnail.ready */
    UPDATE image_thumbnail_jobs
    SET status='ready',thumbnail_etag=?,thumbnail_size=?,error_code=NULL,error_message=NULL,
      lease_until=NULL,ready_at=datetime('now'),failed_at=NULL,dead_lettered_at=NULL,
      thumbnail_provider=?,thumbnail_profile=?,thumbnail_manifest_key=NULL,thumbnail_manifest_etag=NULL,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='processing'`)
    .bind(thumbnail.httpEtag, thumbnail.size, provider, THUMBNAIL_RENDER_PROFILE, sourceKey, sourceEtag)
    .run();
  return result.meta.changes === 1;
}

export async function sourceIsTrashed(env: Pick<Env, "DELIVERY_DB">, sourceKey: string): Promise<boolean> {
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
  expectedSourceEtag?: string,
): Promise<{ rows: number; objects: number }> {
  const normalizedPrefix = isPrefix ? (sourceKey.endsWith("/") ? sourceKey : `${sourceKey}/`) : sourceKey;
  const current = isPrefix ? null : await currentJob(env, sourceKey);
  const exact = current && (!expectedSourceEtag || cleanEtag(current.source_etag) === cleanEtag(expectedSourceEtag)) ? current : null;
  const rows = isPrefix
    ? await env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-list */
        SELECT source_key,source_etag,thumbnail_key,thumbnail_etag,thumbnail_manifest_key,thumbnail_manifest_etag,
          status,error_code FROM image_thumbnail_jobs
        WHERE substr(source_key,1,length(?))=? ORDER BY source_key`)
      .bind(normalizedPrefix, normalizedPrefix).all<ThumbnailJobRow>()
    : { results: exact ? [exact] : [] };
  if (!rows.results.length) return { rows: 0, objects: 0 };
  const statements = isPrefix
    ? [env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-delete-prefix */ DELETE FROM image_thumbnail_jobs WHERE substr(source_key,1,length(?))=?`).bind(normalizedPrefix, normalizedPrefix)]
    : rows.results.map(row => env.DELIVERY_DB.prepare(`/* thumbnail.cleanup-delete */ DELETE FROM image_thumbnail_jobs WHERE source_key=? AND source_etag=?`).bind(sourceKey, row.source_etag));
  const deleted = await env.DELIVERY_DB.batch(statements);
  const removedRows = deleted.some((result) => Number(result.meta.changes || 0) > 0) ? rows.results.length : 0;
  const keys = [...new Set(rows.results.flatMap(row => [row.thumbnail_key, row.thumbnail_manifest_key]).filter((key): key is string => Boolean(key)))];
  for (const row of rows.results) {
    await scheduleThumbnailCleanup(env, { thumbnailKey: row.thumbnail_key, sourceKey: row.source_key || sourceKey, sourceEtag: row.source_etag, artifactEtag: row.thumbnail_etag, reason: "source_removed" });
    if (row.thumbnail_manifest_key) {
      await scheduleThumbnailCleanup(env, {
        thumbnailKey: row.thumbnail_manifest_key,
        sourceKey: row.source_key || sourceKey,
        sourceEtag: row.source_etag,
        artifactEtag: row.thumbnail_manifest_etag,
        reason: "source_removed",
      });
    }
  }
  await drainThumbnailCleanup(env, Math.min(100, keys.length));
  return { rows: removedRows, objects: keys.length };
}

export async function enqueueThumbnailsForPath(env: Env, sourceKey: string, isPrefix: boolean): Promise<number> {
  const objects: R2Object[] = [];
  if (!isPrefix) {
    const object = await env.DATA_BUCKET.head(sourceKey);
    if (object && !isMovedSourceMarker(object)) objects.push(object);
  } else {
    const prefix = sourceKey.endsWith("/") ? sourceKey : `${sourceKey}/`;
    let cursor: string | undefined;
    do {
      const page = await env.DATA_BUCKET.list({ prefix, limit: 1000, cursor, include:["httpMetadata","customMetadata"] });
      objects.push(...page.objects.filter(object => !object.key.endsWith("/") && !isMovedSourceMarker(object)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  let queued = 0;
  for (const object of objects) {
    if (!thumbnailSourceEligible(object.key, object.size, object.httpMetadata?.contentType)) continue;
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
 * Give exhausted transient jobs one bounded second queue lifecycle. This is
 * intentionally separate from normal queue retries: the recovery counter is
 * persisted in D1, so a durable outage cannot create an infinite republish
 * loop. Permanent format/size failures are never selected.
 */
export async function recoverTransientThumbnailFailures(env: Env, limit = 25): Promise<number> {
  const rows = await env.DELIVERY_DB.prepare(`/* thumbnail.recovery-due */
    SELECT source_key,source_etag,source_size FROM image_thumbnail_jobs
    WHERE status='failed'
      AND error_code IN ('thumbnail_processing_error','queue_publish_failed')
      AND attempt_count<?
      AND failed_at IS NOT NULL AND datetime(failed_at)<=datetime('now','-15 minutes')
    ORDER BY failed_at,source_key LIMIT ?`)
    .bind(THUMBNAIL_MAX_RECOVERY_ATTEMPTS, Math.max(1, Math.min(100, limit)))
    .all<RecoverableThumbnailRow>();
  let queued = 0;
  for (const row of rows.results) {
    if (!canonicalThumbnailSourceKey(row.source_key) || await sourceIsTrashed(env, row.source_key)) continue;
    const source = await env.DATA_BUCKET.head(row.source_key);
    if (!source || cleanEtag(source.httpEtag) !== cleanEtag(row.source_etag) ||
      source.size !== row.source_size || !thumbnailSourceEligible(row.source_key, source.size, source.httpMetadata?.contentType)) continue;
    const claimed = await env.DELIVERY_DB.prepare(`/* thumbnail.recovery-claim */
      UPDATE image_thumbnail_jobs SET status='pending',attempt_count=attempt_count+1,
        error_code=NULL,error_message=NULL,lease_until=NULL,failed_at=NULL,dead_lettered_at=NULL,
        queue_published_at=NULL,updated_at=datetime('now')
      WHERE source_key=? AND source_etag=? AND status='failed'
        AND error_code IN ('thumbnail_processing_error','queue_publish_failed') AND attempt_count<?`)
      .bind(row.source_key, cleanEtag(row.source_etag), THUMBNAIL_MAX_RECOVERY_ATTEMPTS).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await env.THUMBNAIL_QUEUE.send({ kind: THUMBNAIL_JOB_KIND, sourceKey: row.source_key, sourceEtag: cleanEtag(row.source_etag) });
      await env.DELIVERY_DB.prepare(`/* thumbnail.recovery-published */
        UPDATE image_thumbnail_jobs SET queue_published_at=datetime('now'),updated_at=datetime('now')
        WHERE source_key=? AND source_etag=? AND status='pending'`)
        .bind(row.source_key, cleanEtag(row.source_etag)).run();
      queued += 1;
    } catch (error) {
      await env.DELIVERY_DB.prepare(`/* thumbnail.recovery-publish-failed */
        UPDATE image_thumbnail_jobs SET status='failed',error_code='queue_publish_failed',error_message=?,
          failed_at=datetime('now'),updated_at=datetime('now')
        WHERE source_key=? AND source_etag=? AND status='pending'`)
        .bind(safeErrorMessage(error instanceof Error ? error.message : "Thumbnail recovery queue publish failed"),
          row.source_key, cleanEtag(row.source_etag)).run();
    }
  }
  return queued;
}

export function prebuiltThumbnailArtifactKey(key: string): boolean {
  return key.startsWith("_ltds/derivatives/thumbnails/v1/prebuilt/") && new TextEncoder().encode(key).byteLength <= 1024 &&
    !key.includes("\\") && !/[\0-\x1f\x7f]/.test(key) && (key.endsWith(".webp") || key.endsWith(".json"));
}

export async function handleRemovedPrebuiltThumbnail(
  env: Env,
  key: string,
  removedEtag?: string,
): Promise<"ignored" | "stale" | "removed"> {
  if (!prebuiltThumbnailArtifactKey(key)) return "ignored";
  if (await env.DATA_BUCKET.head(key)) return "stale";
  const row = await env.DELIVERY_DB.prepare(`SELECT source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,
      thumbnail_manifest_key,thumbnail_manifest_etag FROM image_thumbnail_jobs
    WHERE thumbnail_provider='ltds-truenas' AND (thumbnail_key=? OR thumbnail_manifest_key=?) LIMIT 1`)
    .bind(key, key).first<ThumbnailRegistrationRow>();
  if (!row) return "ignored";
  const expectedArtifactEtag = key === row.thumbnail_key ? row.thumbnail_etag : row.thumbnail_manifest_etag;
  if (removedEtag && cleanEtag(removedEtag) !== cleanEtag(expectedArtifactEtag || "")) return "stale";
  const deleted = await env.DELIVERY_DB.prepare(`DELETE FROM image_thumbnail_jobs WHERE source_key=? AND source_etag=?
    AND thumbnail_key=? AND trim(thumbnail_etag,'"')=?
    AND COALESCE(thumbnail_manifest_key,'')=COALESCE(?,'')
    AND COALESCE(trim(thumbnail_manifest_etag,'"'),'')=COALESCE(?,'')`)
    .bind(row.source_key, row.source_etag, row.thumbnail_key, cleanEtag(row.thumbnail_etag), row.thumbnail_manifest_key,
      row.thumbnail_manifest_etag ? cleanEtag(row.thumbnail_manifest_etag) : null).run();
  if (deleted.meta.changes < 1) return "stale";
  const indexed = await env.DELIVERY_DB.prepare("SELECT etag,size,content_type FROM file_index WHERE r2_key=?")
    .bind(row.source_key).first<{ etag: string; size: number; content_type: string | null }>();
  const source = await env.DATA_BUCKET.head(row.source_key);
  if (indexed && source && cleanEtag(indexed.etag) === cleanEtag(source.httpEtag) && indexed.size === source.size &&
    thumbnailSourceEligible(row.source_key, source.size, source.httpMetadata?.contentType) && !await sourceIsTrashed(env, row.source_key)) {
    await enqueueThumbnailJob(env, { sourceKey: row.source_key, sourceEtag: source.httpEtag, sourceSize: source.size });
  }
  return "removed";
}

interface ThumbnailRegistrationRow {
  source_key: string;
  source_etag: string;
  source_size: number;
  thumbnail_key: string;
  thumbnail_etag: string;
  thumbnail_manifest_key: string | null;
  thumbnail_manifest_etag: string | null;
}

/** Bounded exact-identity audit of active managed and prebuilt registrations. */
export async function reconcileThumbnailRegistrations(env: Env, limit = 100): Promise<{ scanned: number; invalidated: number; completedCycle: boolean }> {
  const boundedLimit = Math.max(1, Math.min(200, limit));
  const state = await env.DELIVERY_DB.prepare("SELECT cursor FROM image_thumbnail_registration_reconciliation WHERE singleton=1")
    .first<{ cursor: string | null }>();
  const rows = await env.DELIVERY_DB.prepare(`SELECT source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,
      thumbnail_manifest_key,thumbnail_manifest_etag FROM image_thumbnail_jobs
    WHERE status='ready' AND source_key>? ORDER BY source_key LIMIT ?`)
    .bind(state?.cursor || "", boundedLimit).all<ThumbnailRegistrationRow>();
  let invalidated = 0;
  for (const row of rows.results) {
    const source = await env.DATA_BUCKET.head(row.source_key);
    const thumbnail = await env.DATA_BUCKET.head(row.thumbnail_key);
    const manifest = row.thumbnail_manifest_key ? await env.DATA_BUCKET.head(row.thumbnail_manifest_key) : null;
    const valid = source && cleanEtag(source.httpEtag) === cleanEtag(row.source_etag) && source.size === row.source_size &&
      thumbnail && cleanEtag(thumbnail.httpEtag) === cleanEtag(row.thumbnail_etag) &&
      (!row.thumbnail_manifest_key || (manifest && cleanEtag(manifest.httpEtag) === cleanEtag(row.thumbnail_manifest_etag || ""))) &&
      !await sourceIsTrashed(env, row.source_key);
    if (valid) continue;
    const removed = await env.DELIVERY_DB.prepare(`DELETE FROM image_thumbnail_jobs WHERE source_key=? AND source_etag=?
      AND thumbnail_key=? AND trim(thumbnail_etag,'"')=?
      AND COALESCE(thumbnail_manifest_key,'')=COALESCE(?,'')
      AND COALESCE(trim(thumbnail_manifest_etag,'"'),'')=COALESCE(?,'')`)
      .bind(row.source_key, row.source_etag, row.thumbnail_key, cleanEtag(row.thumbnail_etag), row.thumbnail_manifest_key,
        row.thumbnail_manifest_etag ? cleanEtag(row.thumbnail_manifest_etag) : null).run();
    if (removed.meta.changes < 1) continue;
    invalidated += 1;
    const indexed = await env.DELIVERY_DB.prepare("SELECT etag,size,content_type FROM file_index WHERE r2_key=?")
      .bind(row.source_key).first<{ etag: string; size: number; content_type: string | null }>();
    const live = await env.DATA_BUCKET.head(row.source_key);
    if (indexed && live && cleanEtag(indexed.etag) === cleanEtag(live.httpEtag) && indexed.size === live.size &&
      thumbnailSourceEligible(row.source_key, live.size, live.httpMetadata?.contentType) && !await sourceIsTrashed(env, row.source_key)) {
      await enqueueThumbnailJob(env, { sourceKey: row.source_key, sourceEtag: live.httpEtag, sourceSize: live.size });
    }
  }
  const completedCycle = rows.results.length < boundedLimit;
  const cursor = completedCycle ? null : rows.results.at(-1)?.source_key || null;
  await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_registration_reconciliation SET
    cursor=?,scanned_count=scanned_count+?,cleaned_count=cleaned_count+?,
    completed_cycles=completed_cycles+?,updated_at=datetime('now') WHERE singleton=1`)
    .bind(cursor, rows.results.length, invalidated, completedCycle ? 1 : 0).run();
  return { scanned: rows.results.length, invalidated, completedCycle };
}

/**
 * Cursor-bounded inventory of the backend-owned managed namespace only.
 * Prebuilt objects remain exclusively TrueNAS/rclone-owned and are never
 * deleted merely because registration has not arrived yet.
 */
export async function reconcileManagedThumbnailOrphans(
  env: Env,
  limit = 100,
  now = new Date(),
): Promise<{ scanned: number; cleaned: number; completedCycle: boolean }> {
  const boundedLimit = Math.max(1, Math.min(200, limit));
  const state = await env.DELIVERY_DB.prepare("SELECT cursor FROM image_thumbnail_managed_orphan_reconciliation WHERE singleton=1")
    .first<{ cursor: string | null }>();
  const page = await env.DATA_BUCKET.list({
    prefix: "_ltds/derivatives/thumbnails/v1/managed/",
    limit: boundedLimit,
    ...(state?.cursor ? { cursor: state.cursor } : {}),
  });
  const cutoff = now.getTime() - THUMBNAIL_MANAGED_ORPHAN_GRACE_MS;
  let cleaned = 0;
  for (const object of page.objects) {
    if (object.uploaded.getTime() > cutoff) continue;
    const referenced = await env.DELIVERY_DB.prepare(`SELECT source_key FROM image_thumbnail_jobs
      WHERE thumbnail_key=? AND status<>'failed' LIMIT 1`).bind(object.key).first<{ source_key: string }>();
    if (referenced) continue;
    const current = await env.DATA_BUCKET.head(object.key);
    if (!current || cleanEtag(current.httpEtag) !== cleanEtag(object.httpEtag) || current.uploaded.getTime() > cutoff) continue;
    await scheduleThumbnailCleanup(env, {
      thumbnailKey: object.key,
      sourceKey: "_ltds/managed-orphan-reconciliation",
      sourceEtag: cleanEtag(object.httpEtag),
      artifactEtag: object.httpEtag,
      reason: "managed_orphan_reconciliation",
    });
    cleaned += await drainThumbnailCleanup(env, 1);
  }
  const completedCycle = !page.truncated;
  await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_managed_orphan_reconciliation SET
    cursor=?,scanned_count=scanned_count+?,cleaned_count=cleaned_count+?,
    completed_cycles=completed_cycles+?,updated_at=datetime('now') WHERE singleton=1`)
    .bind(page.truncated ? page.cursor : null, page.objects.length, cleaned, completedCycle ? 1 : 0).run();
  return { scanned: page.objects.length, cleaned, completedCycle };
}

const PERMANENT_CONTAINER_FAILURES = new Set<ContainerThumbnailErrorCode>([
  "encrypted_pdf",
  "invalid_input",
  "invalid_output",
  "invalid_request",
  "metadata_not_stripped",
  "output_too_large",
  "pdf_page_limit",
  "pixel_limit_exceeded",
  "unsupported_format",
]);

async function adoptExistingThumbnail(
  env: Env,
  sourceKey: string,
  sourceEtag: string,
  thumbnailKey: string,
  thumbnail: R2Object,
): Promise<{ adopted: boolean; provider?: "ltds-truenas" | "cloudflare-container" }> {
  const provider = thumbnail.customMetadata?.thumbnailProvider;
  if ((provider !== "ltds-truenas" && provider !== "cloudflare-container") ||
    thumbnail.customMetadata?.rendererProfile !== THUMBNAIL_RENDER_PROFILE ||
    cleanEtag(thumbnail.customMetadata?.sourceEtag || "") !== sourceEtag ||
    thumbnail.httpMetadata?.contentType !== "image/webp" || thumbnail.size <= 0 || thumbnail.size > THUMBNAIL_MAX_OUTPUT_BYTES) {
    return { adopted: false };
  }
  const object = await env.DATA_BUCKET.get(thumbnailKey, { onlyIf: { etagMatches: cleanEtag(thumbnail.httpEtag) } });
  if (!object || !("body" in object) || !validWebp(new Uint8Array(await object.arrayBuffer()))) return { adopted: false };
  return { adopted: await completeJob(env, sourceKey, sourceEtag, thumbnail, provider), provider };
}

async function renderContainerThumbnail(
  env: Env,
  source: ReadableStream<Uint8Array>,
  kind: ThumbnailSourceKind,
  expectedSize: number,
) {
  const renderer = env.THUMBNAIL_RENDERER.get(env.THUMBNAIL_RENDERER.idFromName("ltds-thumbnails"));
  return renderer.renderThumbnail(source, { kind, expectedSize });
}

interface ThumbnailProcessingAttempt {
  claimAttempt: number | null;
}

/** Process one exact-version queue job using the private, non-public Container. */
async function processThumbnailJobAttempt(
  env: Env,
  message: ThumbnailJobMessage,
  options: { finalAttempt?: boolean },
  processing: ThumbnailProcessingAttempt,
): Promise<ThumbnailJobOutcome> {
  const sourceEtag = cleanEtag(message.sourceEtag);
  if (!canonicalThumbnailSourceKey(message.sourceKey)) return { outcome: "obsolete" };
  if (await sourceIsTrashed(env, message.sourceKey)) {
    await removeThumbnailStateForPath(env, message.sourceKey);
    return { outcome: "obsolete" };
  }

  // Reject forged, retired, and terminal duplicate messages from durable state
  // before touching R2. Location-only jobs (for example TIFF EXIF extraction)
  // have their own exact-version row and may proceed without a thumbnail row.
  const registered = await currentJob(env, message.sourceKey);
  const currentThumbnail = registered && cleanEtag(registered.source_etag) === sourceEtag
    ? registered
    : null;
  if (currentThumbnail?.status === "ready") {
    return { outcome: "duplicate", thumbnailKey: currentThumbnail.thumbnail_key };
  }
  if (currentThumbnail?.status === "failed") return { outcome: "obsolete" };
  const location = currentThumbnail ? null : await currentLocationStatus(env, message.sourceKey);
  const currentLocation = location && cleanEtag(location.source_etag) === sourceEtag &&
    ["pending", "processing", "failed"].includes(location.status)
    ? location
    : null;
  if (!currentThumbnail && !currentLocation) return { outcome: "obsolete" };

  const sourceHead = await env.DATA_BUCKET.head(message.sourceKey);
  if (!sourceHead) {
    const claimAttempt = currentThumbnail ? await claimJob(env, message.sourceKey, sourceEtag) : null;
    if (claimAttempt !== null) {
      await failJob(env, message.sourceKey, sourceEtag, "source_missing", "The original no longer exists", true, claimAttempt);
      return { outcome: "failed", errorCode: "source_missing" };
    }
    if (currentLocation) await deleteImageLocation(env, message.sourceKey, sourceEtag);
    return { outcome: "obsolete" };
  }
  if (cleanEtag(sourceHead.httpEtag) !== sourceEtag) {
    const claimAttempt = currentThumbnail ? await claimJob(env, message.sourceKey, sourceEtag) : null;
    if (claimAttempt !== null) {
      await failJob(env, message.sourceKey, sourceEtag, "source_changed", "The queued original version is obsolete", true, claimAttempt);
    }
    if (currentLocation) await deleteImageLocation(env, message.sourceKey, sourceEtag);
    return { outcome: "obsolete" };
  }

  if (currentLocation || thumbnailSourceKind(message.sourceKey, sourceHead.httpMetadata?.contentType) === "image") {
    try {
      await processImageLocation(env, {
        sourceKey: message.sourceKey,
        sourceEtag,
        sourceSize: sourceHead.size,
      });
    } catch (error) {
      // Location metadata is best-effort and must never block thumbnail
      // readiness. Its versioned state remains failed for bounded backfill.
      console.error(JSON.stringify({
        event: "image-location.process-failed",
        message: safeErrorMessage(error instanceof Error ? error.message : "Image location extraction failed"),
      }));
    }
  }

  if (!currentThumbnail) return { outcome: "obsolete" };
  const thumbnailKey = currentThumbnail.thumbnail_key;
  const sourceKind = thumbnailSourceKind(message.sourceKey, sourceHead.httpMetadata?.contentType);
  if (!sourceKind || !thumbnailSourceWithinInputLimit(sourceKind, sourceHead.size)) {
    const claimAttempt = await claimJob(env, message.sourceKey, sourceEtag);
    if (claimAttempt !== null) {
      await failJob(
        env,
        message.sourceKey,
        sourceEtag,
        sourceKind ? "input_too_large" : "unsupported_file",
        sourceKind ? "The source exceeds the private renderer input limit" : "The source format is not supported by the private renderer",
        true,
        claimAttempt,
      );
    }
    return { outcome: "failed", errorCode: sourceKind ? "input_too_large" : "unsupported_file" };
  }

  const claimAttempt = await claimJob(env, message.sourceKey, sourceEtag);
  if (claimAttempt === null) {
    const raced = await currentJob(env, message.sourceKey);
    return raced?.status === "ready" && cleanEtag(raced.source_etag) === sourceEtag
      ? { outcome: "duplicate", thumbnailKey: raced.thumbnail_key }
      : { outcome: "retry", errorCode: "renderer_busy" };
  }
  processing.claimAttempt = claimAttempt;

  const source = await env.DATA_BUCKET.get(message.sourceKey, { onlyIf: { etagMatches: sourceEtag } });
  if (!source || !("body" in source) || cleanEtag(source.httpEtag) !== sourceEtag || source.size !== sourceHead.size) {
    await failJob(env, message.sourceKey, sourceEtag, "source_changed", "The source changed before private rendering", true, claimAttempt);
    return { outcome: "obsolete" };
  }

  const rendered = await renderContainerThumbnail(env, source.body, sourceKind, source.size);
  if (!rendered.ok) {
    const terminal = PERMANENT_CONTAINER_FAILURES.has(rendered.errorCode) || Boolean(options.finalAttempt);
    await failJob(env, message.sourceKey, sourceEtag, rendered.errorCode, rendered.message, terminal, claimAttempt);
    return terminal
      ? { outcome: "failed", errorCode: rendered.errorCode }
      : { outcome: "retry", errorCode: rendered.errorCode };
  }
  const renderedBytes = new Uint8Array(rendered.bytes);
  if (!validWebp(renderedBytes)) {
    await failJob(env, message.sourceKey, sourceEtag, "invalid_output", "The private renderer returned an invalid thumbnail", true, claimAttempt);
    return { outcome: "failed", errorCode: "invalid_output" };
  }

  const currentSource = await env.DATA_BUCKET.head(message.sourceKey);
  if (!currentSource || cleanEtag(currentSource.httpEtag) !== sourceEtag || currentSource.size !== sourceHead.size ||
    await sourceIsTrashed(env, message.sourceKey)) {
    await failJob(env, message.sourceKey, sourceEtag, "source_changed", "The source changed during private rendering", true, claimAttempt);
    return { outcome: "obsolete" };
  }

  const existing = await env.DATA_BUCKET.head(thumbnailKey);
  if (existing) {
    const adopted = await adoptExistingThumbnail(env, message.sourceKey, sourceEtag, thumbnailKey, existing);
    if (adopted.adopted) return { outcome: "ready", thumbnailKey };
    const raced = await currentJob(env, message.sourceKey);
    if (raced?.status === "ready" && cleanEtag(raced.source_etag) === sourceEtag) {
      return { outcome: "duplicate", thumbnailKey: raced.thumbnail_key };
    }
    await failJob(env, message.sourceKey, sourceEtag, "thumbnail_conflict", "A conflicting derivative occupied the private thumbnail key", true, claimAttempt);
    await scheduleThumbnailCleanup(env, { thumbnailKey, sourceKey: message.sourceKey, sourceEtag, reason: "invalid_renderer_race" });
    await drainThumbnailCleanup(env, 1);
    return { outcome: "failed", errorCode: "thumbnail_conflict" };
  }

  let stored = await env.DATA_BUCKET.put(thumbnailKey, renderedBytes, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "image/webp", cacheControl: "private, no-store" },
    customMetadata: {
      sourceEtag,
      thumbnailProvider: "cloudflare-container",
      rendererProfile: THUMBNAIL_RENDER_PROFILE,
    },
  });
  if (!stored) {
    const winner = await env.DATA_BUCKET.head(thumbnailKey);
    if (winner && (await adoptExistingThumbnail(env, message.sourceKey, sourceEtag, thumbnailKey, winner)).adopted) {
      return { outcome: "ready", thumbnailKey };
    }
    await failJob(env, message.sourceKey, sourceEtag, "thumbnail_conflict", "The private thumbnail race could not be validated", true, claimAttempt);
    return { outcome: "failed", errorCode: "thumbnail_conflict" };
  }

  const finalSource = await env.DATA_BUCKET.head(message.sourceKey);
  if (!finalSource || cleanEtag(finalSource.httpEtag) !== sourceEtag || finalSource.size !== sourceHead.size ||
    await sourceIsTrashed(env, message.sourceKey)) {
    await failJob(env, message.sourceKey, sourceEtag, "source_changed", "The source changed before thumbnail registration", true, claimAttempt);
    await scheduleThumbnailCleanup(env, { thumbnailKey, sourceKey: message.sourceKey, sourceEtag, reason: "source_changed_after_render" });
    await drainThumbnailCleanup(env, 1);
    return { outcome: "obsolete" };
  }
  if (!(await completeJob(env, message.sourceKey, sourceEtag, stored, "cloudflare-container"))) {
    const raced = await currentJob(env, message.sourceKey);
    if (raced?.status === "ready" && cleanEtag(raced.source_etag) === sourceEtag) {
      if (raced.thumbnail_key !== thumbnailKey) {
        await scheduleThumbnailCleanup(env, {
          thumbnailKey,
          sourceKey: message.sourceKey,
          sourceEtag,
          artifactEtag: stored.httpEtag,
          reason: "prebuilt_won_container_race",
        });
        await drainThumbnailCleanup(env, 1);
      }
      return { outcome: "duplicate", thumbnailKey: raced.thumbnail_key };
    }
    await failJob(env, message.sourceKey, sourceEtag, "completion_race", "Thumbnail registration lost its exact-version race", true, claimAttempt);
    await scheduleThumbnailCleanup(env, { thumbnailKey, sourceKey: message.sourceKey, sourceEtag, artifactEtag: stored.httpEtag, reason: "lost_container_completion_race" });
    await drainThumbnailCleanup(env, 1);
    return { outcome: "failed", errorCode: "completion_race" };
  }
  return { outcome: "ready", thumbnailKey };

}

export async function processThumbnailJob(
  env: Env,
  message: ThumbnailJobMessage,
  options: { finalAttempt?: boolean } = {},
): Promise<ThumbnailJobOutcome> {
  const processing: ThumbnailProcessingAttempt = { claimAttempt: null };
  try {
    return await processThumbnailJobAttempt(env, message, options, processing);
  } catch (error) {
    if (processing.claimAttempt === null) throw error;
    const terminal = Boolean(options.finalAttempt);
    await failJob(
      env,
      message.sourceKey,
      cleanEtag(message.sourceEtag),
      "thumbnail_processing_error",
      error instanceof Error ? error.message : "Private thumbnail processing failed",
      terminal,
      processing.claimAttempt,
    );
    return terminal
      ? { outcome: "failed", errorCode: "thumbnail_processing_error" }
      : { outcome: "retry", errorCode: "thumbnail_processing_error" };
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
      const finalized = await env.DELIVERY_DB.prepare(`/* thumbnail.dead-letter */
        UPDATE image_thumbnail_jobs
        SET status='failed',error_code=COALESCE(error_code,'dead_lettered'),
          error_message=COALESCE(error_message,'Thumbnail retries were exhausted'),lease_until=NULL,
          failed_at=COALESCE(failed_at,datetime('now')),dead_lettered_at=datetime('now'),updated_at=datetime('now')
        WHERE source_key=? AND source_etag=? AND status='failed'`)
        .bind(queueMessage.body.sourceKey, cleanEtag(queueMessage.body.sourceEtag))
        .run();
      // The queue body has no lifecycle epoch. A delayed DLQ copy must never
      // turn a recovered pending job or a newer active lease back into a
      // terminal failure. Final attempts already persist `failed` before the
      // queue moves their message, so only that state is safe to annotate.
      if (finalized.meta.changes !== 1) {
        queueMessage.ack();
        continue;
      }
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
    SELECT source_etag,thumbnail_key,thumbnail_etag,thumbnail_provider,thumbnail_profile,status,error_code FROM image_thumbnail_jobs WHERE source_key=?`)
    .bind(sourceKey)
    .first<ThumbnailJobRow>();
  if (!row) return { state: "pending" };
  return thumbnailStateForObject(expectedSourceEtag || row.source_etag, row);
}

/**
 * Call only after the route has authenticated and authorized sourceKey. This
 * helper verifies the current original ETag but never reads the original body.
 */
export async function getThumbnailForAuthorizedSource(
  env: Env,
  sourceKey: string,
  authorizedSource?: R2Object,
): Promise<AuthorizedThumbnail> {
  const source = authorizedSource ?? await env.DATA_BUCKET.head(sourceKey);
  if (!source) return { state: "pending", object: null };
  const state = await getThumbnailState(env, sourceKey, source.httpEtag);
  if (state.state !== "ready" || !state.thumbnailKey || !state.thumbnailEtag) {
    return { state: state.state === "failed" ? "failed" : "pending", object: null, errorCode: state.errorCode };
  }
  const object = await env.DATA_BUCKET.get(state.thumbnailKey, { onlyIf: { etagMatches: state.thumbnailEtag } });
  const registeredPrebuilt = state.thumbnailProvider === "ltds-truenas" && state.thumbnailProfile === THUMBNAIL_RENDER_PROFILE;
  const registeredManaged = ((state.thumbnailProvider === "cloudflare-container" && state.thumbnailProfile === THUMBNAIL_RENDER_PROFILE) ||
    (!state.thumbnailProvider && !state.thumbnailProfile)) &&
    cleanEtag(object && "body" in object ? object.customMetadata?.sourceEtag || "" : "") === cleanEtag(source.httpEtag);
  if (!object || !("body" in object) || cleanEtag(object.httpEtag) !== state.thumbnailEtag ||
    object.httpMetadata?.contentType !== "image/webp" || object.size <= 0 || object.size > THUMBNAIL_MAX_OUTPUT_BYTES ||
    (!registeredPrebuilt && !registeredManaged)) return { state: "pending", object: null };
  return { state: "ready", object, sourceEtag: cleanEtag(source.httpEtag), thumbnailKey: state.thumbnailKey };
}
