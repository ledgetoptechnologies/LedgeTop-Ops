import type { Env } from "./types";
import {
  THUMBNAIL_MAX_OUTPUT_BYTES,
  canonicalThumbnailSourceKey,
  enqueueThumbnailJob,
  thumbnailSourceKind,
  thumbnailSourceWithinInputLimit,
} from "./image-thumbnails";
import { THUMBNAIL_RENDER_PROFILE } from "./thumbnail-renderer-contract";

export const THUMBNAIL_BACKFILL_PREFIX = "Jobs/" as const;
const LIST_LIMIT = 100;
const DRY_RUN_PAGES_PER_TURN = 10;
const ENQUEUE_PAGES_PER_TURN = 3;
const MAX_RUN_ATTEMPTS = 8;
const RESUMABLE_LEGACY_FAILURES = new Set([
  "images_quota_exceeded",
  "input_too_large",
  "renderer_unavailable",
]);

export type ThumbnailBackfillMode = "dry_run" | "enqueue";

interface BackfillRun {
  id: string;
  mode: ThumbnailBackfillMode;
  cursor: string | null;
  attempt_count: number;
  error_code: string | null;
}

interface IndexedSource {
  r2_key: string;
  etag: string;
  size: number;
}

interface BackfillJob {
  source_key: string;
  source_etag: string;
  thumbnail_key: string;
  thumbnail_etag: string | null;
  thumbnail_size: number | null;
  status: "pending" | "processing" | "ready" | "failed";
  error_code: string | null;
  failed_at: string | null;
  dead_lettered_at: string | null;
  queue_published_at: string | null;
  thumbnail_provider: "ltds-truenas" | "cloudflare-container" | null;
  thumbnail_profile: string | null;
  thumbnail_manifest_key: string | null;
  thumbnail_manifest_etag: string | null;
}

interface PageCounts {
  discovered: number;
  eligible: number;
  queued: number;
  skipped: number;
  ready: number;
  failedDlq: number;
  pending: number;
}

function cleanEtag(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(",");
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Thumbnail backfill failed")
    .replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

async function currentRows<T>(env: Env, sql: string, keys: string[]): Promise<Map<string, T>> {
  if (!keys.length) return new Map();
  const rows = await env.DELIVERY_DB.prepare(sql.replace("/* keys */", placeholders(keys.length)))
    .bind(...keys).all<T & { r2_key?: string; source_key?: string }>();
  return new Map(rows.results.map((row) => [row.r2_key || row.source_key || "", row]));
}

async function currentTombstonedKeys(env: Env, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  // json_each binds the complete, at-most-100-key page as one value. EXISTS
  // returns at most one row per listed object, so neither the D1 result nor
  // Worker-side matching grows with the tenant's tombstone history.
  const result = await env.DELIVERY_DB.prepare(`/* thumbnail.backfill-tombstones */
    WITH page_keys(source_key) AS (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    )
    SELECT source_key FROM page_keys p
    WHERE EXISTS (
      SELECT 1 FROM delivery_tombstones t
      WHERE t.restored_at IS NULL AND (
        (t.tombstone_kind='exact' AND t.physical_key=p.source_key) OR
        (t.tombstone_kind='prefix' AND t.physical_key LIKE 'Jobs/%'
          AND substr(t.physical_key,-1)='/'
          AND substr(p.source_key,1,length(t.physical_key))=t.physical_key)
      )
    )`)
    .bind(JSON.stringify(keys)).all<{ source_key: string }>();
  return new Set(result.results.map((row) => row.source_key));
}

function failureCanResume(job: BackfillJob): boolean {
  return Boolean(job.error_code && RESUMABLE_LEGACY_FAILURES.has(job.error_code));
}

async function resetLegacyFailure(env: Env, job: BackfillJob): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.backfill-resume-renderer */
    UPDATE image_thumbnail_jobs SET status='pending',attempt_count=0,error_code=NULL,error_message=NULL,
      lease_until=NULL,failed_at=NULL,dead_lettered_at=NULL,queue_published_at=NULL,
      thumbnail_provider=NULL,thumbnail_profile=NULL,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='failed'
      AND error_code IN ('images_quota_exceeded','input_too_large','renderer_unavailable')`)
    .bind(job.source_key, job.source_etag).run();
}

async function readyThumbnailIsCurrent(env: Env, job: BackfillJob, sourceEtag: string): Promise<boolean> {
  if (!job.thumbnail_etag || !job.thumbnail_size || job.thumbnail_size <= 0 || job.thumbnail_size > THUMBNAIL_MAX_OUTPUT_BYTES) return false;
  const object = await env.DATA_BUCKET.head(job.thumbnail_key);
  if (!object || cleanEtag(object.httpEtag) !== cleanEtag(job.thumbnail_etag) ||
    object.size !== job.thumbnail_size || object.httpMetadata?.contentType !== "image/webp") return false;
  if (job.thumbnail_provider === "ltds-truenas") {
    if (job.thumbnail_profile !== THUMBNAIL_RENDER_PROFILE || !job.thumbnail_manifest_key || !job.thumbnail_manifest_etag) return false;
    const manifest = await env.DATA_BUCKET.head(job.thumbnail_manifest_key);
    return Boolean(manifest && cleanEtag(manifest.httpEtag) === cleanEtag(job.thumbnail_manifest_etag) &&
      manifest.size > 0 && manifest.httpMetadata?.contentType === "application/json");
  }
  if (job.thumbnail_provider === "cloudflare-container" && job.thumbnail_profile !== THUMBNAIL_RENDER_PROFILE) return false;
  return cleanEtag(object.customMetadata?.sourceEtag || "") === cleanEtag(sourceEtag);
}

async function makeReadyJobPending(env: Env, job: BackfillJob): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.backfill-repair-ready */
    UPDATE image_thumbnail_jobs SET status='pending',thumbnail_etag=NULL,thumbnail_size=NULL,
      error_code=NULL,error_message=NULL,lease_until=NULL,ready_at=NULL,failed_at=NULL,
      dead_lettered_at=NULL,queue_published_at=NULL,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='ready'`)
    .bind(job.source_key, job.source_etag).run();
}

async function processPage(env: Env, run: BackfillRun): Promise<{ cursor: string | null; truncated: boolean; counts: PageCounts }> {
  const listed = await env.DATA_BUCKET.list({
    prefix: THUMBNAIL_BACKFILL_PREFIX,
    limit: LIST_LIMIT,
    ...(run.cursor ? { cursor: run.cursor } : {}),
    include: ["httpMetadata", "customMetadata"],
  });
  const counts: PageCounts = { discovered: listed.objects.length, eligible: 0, queued: 0, skipped: 0, ready: 0, failedDlq: 0, pending: 0 };
  const keys = listed.objects.map((object) => object.key);
  const [index, jobs, tombstonedKeys] = await Promise.all([
    currentRows<IndexedSource>(env, "SELECT r2_key,etag,size FROM file_index WHERE r2_key IN (/* keys */)", keys),
    currentRows<BackfillJob>(env, `SELECT source_key,source_etag,thumbnail_key,thumbnail_etag,thumbnail_size,status,error_code,
      failed_at,dead_lettered_at,queue_published_at,thumbnail_provider,thumbnail_profile,
      thumbnail_manifest_key,thumbnail_manifest_etag FROM image_thumbnail_jobs WHERE source_key IN (/* keys */)`, keys),
    currentTombstonedKeys(env, keys),
  ]);

  for (const object of listed.objects) {
    const indexed = index.get(object.key);
    const sourceKind = thumbnailSourceKind(object.key, object.httpMetadata?.contentType);
    if (object.key.endsWith("/") || !canonicalThumbnailSourceKey(object.key) ||
      !sourceKind || !thumbnailSourceWithinInputLimit(sourceKind, object.size) || tombstonedKeys.has(object.key) ||
      !indexed || cleanEtag(indexed.etag) !== cleanEtag(object.httpEtag) || indexed.size !== object.size) {
      counts.skipped += 1;
      continue;
    }

    counts.eligible += 1;
    const job = jobs.get(object.key);
    const sameVersion = Boolean(job && cleanEtag(job.source_etag) === cleanEtag(object.httpEtag));
    if (sameVersion && job?.status === "ready" && await readyThumbnailIsCurrent(env, job, object.httpEtag)) {
      counts.ready += 1;
      continue;
    }
    const resumableFailure = Boolean(sameVersion && job && failureCanResume(job));
    if (sameVersion && job?.status === "failed" && job.error_code !== "queue_publish_failed" && !resumableFailure) {
      counts.failedDlq += 1;
      continue;
    }
    if (sameVersion && (job?.status === "processing" || (job?.status === "pending" && job.queue_published_at))) {
      counts.pending += 1;
      continue;
    }

    if (run.mode === "dry_run") {
      counts.queued += 1;
      continue;
    }

    if (sameVersion && job?.status === "ready") await makeReadyJobPending(env, job);
    if (resumableFailure && job) await resetLegacyFailure(env, job);
    const result = await enqueueThumbnailJob(env, {
      sourceKey: object.key,
      sourceEtag: object.httpEtag,
      sourceSize: object.size,
      eventTime: object.uploaded.toISOString(),
    });
    if (result.enqueued) {
      await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs
        SET queued_count=queued_count+1,updated_at=datetime('now') WHERE id=?`).bind(run.id).run();
    } else if (result.state === "ready") counts.ready += 1;
    else if (result.state === "failed") counts.failedDlq += 1;
    else counts.pending += 1;
  }

  return {
    cursor: listed.truncated ? listed.cursor || null : null,
    truncated: listed.truncated,
    counts,
  };
}

async function savePage(env: Env, runId: string, page: Awaited<ReturnType<typeof processPage>>): Promise<void> {
  const complete = !page.truncated;
  await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs SET
    cursor=?,page_count=page_count+1,attempt_count=0,
    discovered_count=discovered_count+?,eligible_count=eligible_count+?,queued_count=queued_count+?,
    skipped_count=skipped_count+?,ready_count=ready_count+?,failed_dlq_count=failed_dlq_count+?,pending_count=pending_count+?,
    status=?,lease_until=CASE WHEN ? THEN NULL ELSE datetime('now','+5 minutes') END,
    completed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,
    error_code=CASE WHEN ? THEN NULL ELSE error_code END,
    error_message=CASE WHEN ? THEN NULL ELSE error_message END,updated_at=datetime('now')
    WHERE id=?`)
    .bind(page.cursor, page.counts.discovered, page.counts.eligible, page.counts.queued,
      page.counts.skipped, page.counts.ready, page.counts.failedDlq, page.counts.pending,
      complete ? "completed" : "running", complete, complete,
      complete, complete, runId).run();
}

export async function processThumbnailBackfills(env: Env): Promise<number> {
  const run = await env.DELIVERY_DB.prepare(`SELECT id,mode,cursor,attempt_count,error_code FROM image_thumbnail_backfill_runs
    WHERE status='queued' OR (status='running' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now')))
    ORDER BY created_at LIMIT 1`).first<BackfillRun>();
  if (!run) return 0;
  const claimed = await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs SET status='running',
    attempt_count=attempt_count+1,lease_until=datetime('now','+5 minutes'),started_at=COALESCE(started_at,datetime('now')),
    updated_at=datetime('now') WHERE id=? AND (status='queued' OR (status='running' AND
    (lease_until IS NULL OR datetime(lease_until)<=datetime('now'))))`).bind(run.id).run();
  if (claimed.meta.changes !== 1) return 0;

  try {
    const maxPages = run.mode === "dry_run" ? DRY_RUN_PAGES_PER_TURN : ENQUEUE_PAGES_PER_TURN;
    let processed = 0;
    for (; processed < maxPages; processed += 1) {
      const current = await env.DELIVERY_DB.prepare("SELECT id,mode,cursor,attempt_count,error_code FROM image_thumbnail_backfill_runs WHERE id=? AND status='running'")
        .bind(run.id).first<BackfillRun>();
      if (!current) break;
      const page = await processPage(env, current);
      await savePage(env, run.id, page);
      if (!page.truncated) return processed + 1;
    }
    await env.DELIVERY_DB.prepare("UPDATE image_thumbnail_backfill_runs SET lease_until=NULL,status='queued',updated_at=datetime('now') WHERE id=? AND status='running'")
      .bind(run.id).run();
    return processed;
  } catch (error) {
    const terminal = run.attempt_count + 1 >= MAX_RUN_ATTEMPTS;
    await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs SET status=?,lease_until=NULL,
      error_code=?,error_message=?,completed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,updated_at=datetime('now') WHERE id=?`)
      .bind(terminal ? "failed" : "queued", terminal ? "backfill_exhausted" : "backfill_retry",
        safeError(error), terminal, run.id).run();
    return 0;
  }
}
