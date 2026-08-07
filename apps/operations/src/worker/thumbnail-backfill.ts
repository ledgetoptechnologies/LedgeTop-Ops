import type { Env } from "./types";
import {
  THUMBNAIL_MAX_OUTPUT_BYTES,
  canonicalThumbnailSourceKey,
  enqueueThumbnailJob,
  thumbnailSourceKind,
  thumbnailSourceWithinInputLimit,
} from "./image-thumbnails";

export const THUMBNAIL_BACKFILL_PREFIX = "Jobs/Clients/" as const;
const LIST_LIMIT = 100;
const DRY_RUN_PAGES_PER_TURN = 10;
const ENQUEUE_PAGES_PER_TURN = 3;
const MAX_RUN_ATTEMPTS = 8;
const QUOTA_RESUME_REQUEST = "resume_images_quota";
const QUOTA_PROBE_PENDING = "quota_probe_pending";
const QUOTA_PROBE_MESSAGE =
  "Quota recovery probe stopped after one page. Confirm entitlement and probe results, then create a normal enqueue run.";

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
        (t.tombstone_kind='prefix' AND t.physical_key LIKE 'Jobs/Clients/%'
          AND substr(t.physical_key,-1)='/'
          AND substr(p.source_key,1,length(t.physical_key))=t.physical_key)
      )
    )`)
    .bind(JSON.stringify(keys)).all<{ source_key: string }>();
  return new Set(result.results.map((row) => row.source_key));
}

function quotaFailureCanResume(run: BackfillRun, job: BackfillJob): boolean {
  if (job.error_code !== "images_quota_exceeded") return false;
  if (run.error_code === QUOTA_RESUME_REQUEST) return true;
  if (!job.failed_at) return false;
  const failedAt = Date.parse(`${job.failed_at.replace(" ", "T")}Z`);
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return Number.isFinite(failedAt) && failedAt < monthStart;
}

async function resetQuotaFailure(env: Env, job: BackfillJob): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* thumbnail.backfill-resume-quota */
    UPDATE image_thumbnail_jobs SET status='pending',attempt_count=0,error_code=NULL,error_message=NULL,
      lease_until=NULL,failed_at=NULL,dead_lettered_at=NULL,queue_published_at=NULL,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='failed' AND error_code='images_quota_exceeded'`)
    .bind(job.source_key, job.source_etag).run();
}

async function readyThumbnailIsCurrent(env: Env, job: BackfillJob, sourceEtag: string): Promise<boolean> {
  if (!job.thumbnail_etag || !job.thumbnail_size || job.thumbnail_size <= 0 || job.thumbnail_size > THUMBNAIL_MAX_OUTPUT_BYTES) return false;
  const object = await env.DATA_BUCKET.head(job.thumbnail_key);
  return Boolean(object && cleanEtag(object.httpEtag) === cleanEtag(job.thumbnail_etag) &&
    object.size === job.thumbnail_size && object.httpMetadata?.contentType === "image/webp" &&
    cleanEtag(object.customMetadata?.sourceEtag || "") === cleanEtag(sourceEtag));
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
      failed_at,dead_lettered_at,queue_published_at FROM image_thumbnail_jobs WHERE source_key IN (/* keys */)`, keys),
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
    const resumableQuotaFailure = Boolean(sameVersion && job && quotaFailureCanResume(run, job));
    if (sameVersion && job?.status === "failed" && job.error_code !== "queue_publish_failed" && !resumableQuotaFailure) {
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
    if (resumableQuotaFailure && job) await resetQuotaFailure(env, job);
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

async function savePage(env: Env, runId: string, page: Awaited<ReturnType<typeof processPage>>, quotaProbe = false): Promise<void> {
  const complete = !page.truncated;
  const terminal = quotaProbe || complete;
  await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs SET
    cursor=?,page_count=page_count+1,attempt_count=0,
    discovered_count=discovered_count+?,eligible_count=eligible_count+?,queued_count=queued_count+?,
    skipped_count=skipped_count+?,ready_count=ready_count+?,failed_dlq_count=failed_dlq_count+?,pending_count=pending_count+?,
    status=?,lease_until=CASE WHEN ? THEN NULL ELSE datetime('now','+5 minutes') END,
    completed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,
    error_code=CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE error_code END,
    error_message=CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE error_message END,updated_at=datetime('now')
    WHERE id=?`)
    .bind(page.cursor, page.counts.discovered, page.counts.eligible, page.counts.queued,
      page.counts.skipped, page.counts.ready, page.counts.failedDlq, page.counts.pending,
      quotaProbe ? "failed" : complete ? "completed" : "running", terminal, terminal,
      quotaProbe, QUOTA_PROBE_PENDING, complete,
      quotaProbe, QUOTA_PROBE_MESSAGE, complete, runId).run();
}

export async function processThumbnailBackfills(env: Env): Promise<number> {
  const run = await env.DELIVERY_DB.prepare(`SELECT id,mode,cursor,attempt_count,error_code FROM image_thumbnail_backfill_runs
    WHERE status='queued' OR (status='running' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now')))
    ORDER BY created_at LIMIT 1`).first<BackfillRun>();
  if (!run) return 0;
  if (run.mode === "enqueue" && run.error_code !== QUOTA_RESUME_REQUEST) {
    const quotaFailure = await env.DELIVERY_DB.prepare(`SELECT 1 blocked FROM image_thumbnail_jobs
      WHERE status='failed' AND error_code='images_quota_exceeded'
        AND datetime(failed_at)>=datetime('now','start of month') LIMIT 1`).first<{blocked:number}>();
    if (quotaFailure) {
      await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs SET status='failed',lease_until=NULL,
        error_code='images_quota_exceeded',error_message='Cloudflare Images monthly transformation quota is exhausted',
        completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')`)
        .bind(run.id).run();
      return 0;
    }
  }
  const claimed = await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs SET status='running',
    attempt_count=attempt_count+1,lease_until=datetime('now','+5 minutes'),started_at=COALESCE(started_at,datetime('now')),
    updated_at=datetime('now') WHERE id=? AND (status='queued' OR (status='running' AND
    (lease_until IS NULL OR datetime(lease_until)<=datetime('now'))))`).bind(run.id).run();
  if (claimed.meta.changes !== 1) return 0;

  try {
    // An explicit same-month quota resume is a bounded probe. If entitlement
    // is still exhausted, the newly failed rows block the next scheduler turn
    // instead of continuously republishing the entire inventory.
    const quotaProbe = run.mode === "enqueue" && run.error_code === QUOTA_RESUME_REQUEST;
    const maxPages = quotaProbe
      ? 1
      : run.mode === "dry_run" ? DRY_RUN_PAGES_PER_TURN : ENQUEUE_PAGES_PER_TURN;
    let processed = 0;
    for (; processed < maxPages; processed += 1) {
      const current = await env.DELIVERY_DB.prepare("SELECT id,mode,cursor,attempt_count,error_code FROM image_thumbnail_backfill_runs WHERE id=? AND status='running'")
        .bind(run.id).first<BackfillRun>();
      if (!current) break;
      const page = await processPage(env, current);
      await savePage(env, run.id, page, quotaProbe);
      if (quotaProbe || !page.truncated) return processed + 1;
    }
    await env.DELIVERY_DB.prepare("UPDATE image_thumbnail_backfill_runs SET lease_until=NULL,status='queued',updated_at=datetime('now') WHERE id=? AND status='running'")
      .bind(run.id).run();
    return processed;
  } catch (error) {
    const quotaProbe = run.mode === "enqueue" && run.error_code === QUOTA_RESUME_REQUEST;
    if (quotaProbe) {
      await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs SET status='failed',lease_until=NULL,
        error_code=?,error_message=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .bind(QUOTA_PROBE_PENDING, QUOTA_PROBE_MESSAGE, run.id).run();
      return 0;
    }

    const terminal = run.attempt_count + 1 >= MAX_RUN_ATTEMPTS;
    await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_backfill_runs SET status=?,lease_until=NULL,
      error_code=?,error_message=?,completed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,updated_at=datetime('now') WHERE id=?`)
      .bind(terminal ? "failed" : "queued", terminal ? "backfill_exhausted" : "backfill_retry",
        safeError(error), terminal, run.id).run();
    return 0;
  }
}
