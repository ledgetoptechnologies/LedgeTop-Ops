import { base64Url, hmac, timingSafeEqual } from "./crypto";
import { presignR2Get } from "./r2-signing";
import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_MAX_OUTPUT_BYTES,
  THUMBNAIL_WIDTH,
  canonicalThumbnailSourceKey,
  cleanThumbnailEtag,
  thumbnailSourceKind,
  thumbnailSourceWithinInputLimit,
} from "./image-thumbnails";
import { THUMBNAIL_RENDER_PROFILE, validWebp } from "./thumbnail-renderer-contract";
import type { Env } from "./types";

const RENDERER_API_PREFIX = "/api/internal/thumbnail-renderer/v1";
const MANAGED_PREFIX = "_ltds/derivatives/thumbnails/v1/managed/";
const RENDERER_LEASE_TOKEN_MAX_MS = 24 * 60 * 60 * 1000;
const RENDERER_DEFAULT_LEASE_MS = 5 * 60 * 1000;
const RENDERER_VIDEO_INITIAL_LEASE_MS = 15 * 60 * 1000;
// This lease/upload/completion API is exclusively the external TrueNAS
// renderer boundary. Cloudflare Container jobs complete through
// image-thumbnails.ts; the managed object-key layout is shared by both paths.
const PROVIDER = "ltds-truenas";
const UNIFIED_RENDERER_CONTRACT = "all-media-v1" as const;
const UNIFIED_RENDERER_HEALTH_SOURCE = "thumbnail-renderer-queue";

interface ClaimResponse {
  leaseId?: string;
  sourceKey?: string;
  sourceEtag?: string;
  sourceSize?: number;
  mediaKind?: string;
  sourceContentType?: string;
  thumbnailKey?: string;
  r2SourceUrl?: string;
  r2PresignedUrl?: string;
  r2UploadUrl?: string;
  status: string;
}

interface CompleteRequest {
  leaseId?: unknown;
  thumbnailKey?: unknown;
  thumbnailEtag?: unknown;
  thumbnailSize?: unknown;
}

interface RendererAttemptRequest {
  leaseId?: unknown;
  sourceKey?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
}

interface RendererAttemptJob {
  source_etag: string;
  source_size: number;
  thumbnail_key: string;
  attempt_count: number;
  lease_until: string | null;
  renderer_contract?: typeof UNIFIED_RENDERER_CONTRACT | null;
}

async function recordUnifiedRendererHealth(env: Pick<Env, "DELIVERY_DB">): Promise<void> {
  await env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health(
    source,last_attempt_at,last_success_at,status,details_json,updated_at)
    VALUES(?,datetime('now'),datetime('now'),'healthy',?,datetime('now'))
    ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),last_success_at=datetime('now'),
      status='healthy',details_json=excluded.details_json,updated_at=datetime('now')
    WHERE delivery_sync_health.last_success_at IS NULL
      OR datetime(delivery_sync_health.last_success_at)<=datetime('now','-30 seconds')`)
    .bind(UNIFIED_RENDERER_HEALTH_SOURCE, JSON.stringify({ contract: UNIFIED_RENDERER_CONTRACT })).run();
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function authorized(request: Request, env: Env): boolean {
  const match = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get("Authorization") || "");
  const supplied = match?.[1] || "";
  const configured = env.THUMBNAIL_INGEST_SECRET || "";
  return configured.length >= 32 && supplied.length >= 32 && timingSafeEqual(configured, supplied);
}

function expectedHost(env: Env): string {
  return (env.THUMBNAIL_RENDERER_EXPECTED_HOST || env.THUMBNAIL_INGEST_EXPECTED_HOST || "").trim().toLowerCase();
}

/**
 * Dispatch renderer API requests: claim, complete, heartbeat.
 * The TrueNAS thumbnail worker calls these to lease jobs, upload
 * thumbnails to R2, and report completion.
 */
export async function dispatchThumbnailRendererApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(RENDERER_API_PREFIX)) return null;

  const host = expectedHost(env);
  if (!host || url.hostname.toLowerCase() !== host) return null;
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

  const path = url.pathname.slice(RENDERER_API_PREFIX.length);

  // POST /claim - lease the next pending thumbnail job
  if (path === "/claim" && request.method === "POST") {
    return handleClaim(request, env);
  }

  // GET /source/:leaseId - stream the R2 source to the worker (proxy via R2 binding)
  if (path.startsWith("/source/") && request.method === "GET") {
    return handleSourceDownload(request, env, path.slice("/source/".length));
  }

  // PUT /thumbnail/:leaseId - receive the rendered thumbnail and store it in R2
  if (path.startsWith("/thumbnail/") && request.method === "PUT") {
    return handleThumbnailUpload(request, env, path.slice("/thumbnail/".length));
  }

  // POST /complete - report a completed thumbnail (thumbnail already uploaded to R2)
  if (path === "/complete" && request.method === "POST") {
    return handleComplete(request, env);
  }

  // POST /heartbeat - extend a lease
  if (path === "/heartbeat" && request.method === "POST") {
    return handleHeartbeat(request, env);
  }

  // POST /fail - report a failed job
  if (path === "/fail" && request.method === "POST") {
    return handleFail(request, env);
  }

  return json({ error: "not_found" }, 404);
}

async function boundedJson(request: Request, maxBytes = 8 * 1024): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("no_body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error("too_large"); }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
}

/**
 * Claim the next eligible pending thumbnail job.
 * Finds a job that's pending or has an expired lease, atomically claims it,
 * and returns the source details plus presigned URLs for download and upload.
 */
async function handleClaim(request: Request, env: Env): Promise<Response> {
  // The external TrueNAS renderer is the primary renderer for every supported
  // media kind. `video` remains available for the previously published worker;
  // `all` is the explicit unified-worker contract. The Cloudflare queue
  // consumer remains a still/PDF fallback and loses the atomic D1 claim when
  // TrueNAS has already leased the exact source version.
  const includeKind = new URL(request.url).searchParams.get("includeKind") || "";
  if (includeKind && includeKind !== "video" && includeKind !== "all") return json({ error: "invalid_request" }, 400);
  if (includeKind === "all") {
    await recordUnifiedRendererHealth(env);
  }
  // Allow excluding a media kind (e.g. excludeKind=video to only claim photos)
  const excludeKind = new URL(request.url).searchParams.get("excludeKind") || "";
  const excludeClause = excludeKind === "video"
    ? "AND source_key NOT LIKE '%.MP4' AND source_key NOT LIKE '%.mp4' AND source_key NOT LIKE '%.MOV' AND source_key NOT LIKE '%.mov' AND source_key NOT LIKE '%.MKV' AND source_key NOT LIKE '%.mkv'"
    : excludeKind === "image"
    ? "AND (source_key LIKE '%.MP4' OR source_key LIKE '%.mp4' OR source_key LIKE '%.MOV' OR source_key LIKE '%.mov' OR source_key LIKE '%.MKV' OR source_key LIKE '%.mkv')"
    : "";

  // For the video-only TrueNAS worker, drive the lookup from file_index's
  // existing media-kind index. The previous correlated EXISTS started from
  // every pending thumbnail job; an image-only backfill could therefore make
  // an idle video claim scan and sort the entire pending image backlog. CROSS
  // JOIN deliberately pins SQLite's loop order to the selective video index,
  // then performs a primary-key lookup for only those source keys.
  const job = await env.DELIVERY_DB.prepare(includeKind === "video"
    ? `SELECT job.source_key,job.source_etag,job.source_size,job.thumbnail_key,job.attempt_count
       FROM file_index AS source INDEXED BY idx_file_index_kind
       CROSS JOIN image_thumbnail_jobs AS job
       WHERE source.media_kind='video'
         AND job.source_key=source.r2_key
         AND trim(source.etag,'"')=job.source_etag
         AND source.size=job.source_size
         AND job.status='pending'
         AND (job.render_not_before IS NULL OR datetime(job.render_not_before)<=datetime('now'))
         AND (job.lease_until IS NULL OR job.lease_until < datetime('now'))
       ORDER BY job.queue_published_at ASC
       LIMIT 1`
    : includeKind === "all"
    ? `SELECT job.source_key,job.source_etag,job.source_size,job.thumbnail_key,job.attempt_count
       FROM image_thumbnail_jobs AS job
       INNER JOIN file_index AS source ON source.r2_key=job.source_key
         AND trim(source.etag,'"')=job.source_etag
         AND source.size=job.source_size
       WHERE source.media_kind IN ('image','pdf','video')
         AND job.status='pending'
         AND (job.render_not_before IS NULL OR datetime(job.render_not_before)<=datetime('now'))
         AND (job.error_code IS NULL OR job.error_code='pixel_limit_exceeded' OR source.media_kind='video')
         AND (job.lease_until IS NULL OR job.lease_until < datetime('now'))
       ORDER BY job.queue_published_at ASC
       LIMIT 1`
    : `SELECT source_key,source_etag,source_size,thumbnail_key,attempt_count
       FROM image_thumbnail_jobs
       WHERE status='pending'
         AND (render_not_before IS NULL OR datetime(render_not_before)<=datetime('now'))
         AND (lease_until IS NULL OR lease_until < datetime('now'))
         ${excludeClause}
       ORDER BY queue_published_at ASC
       LIMIT 1`
  ).first<{ source_key: string; source_etag: string; source_size: number; thumbnail_key: string; attempt_count: number }>();

  if (!job) return json({ status: "idle" }, 200);

  // Verify the source still exists in R2
  const sourceHead = await env.DATA_BUCKET.head(job.source_key);
  if (!sourceHead || cleanThumbnailEtag(sourceHead.httpEtag) !== cleanThumbnailEtag(job.source_etag) || sourceHead.size !== job.source_size) {
    // Source changed or gone - mark as failed
    await env.DELIVERY_DB.prepare(
      `UPDATE image_thumbnail_jobs SET status='failed', error_code='source_changed',
       error_message='Source changed before render', updated_at=datetime('now')
       WHERE source_key=? AND source_etag=?`
    ).bind(job.source_key, job.source_etag).run();
    return json({ status: "idle" }, 200);
  }

  // Determine media kind
  const kind = thumbnailSourceKind(job.source_key, sourceHead.httpMetadata?.contentType);
  if (!kind || !thumbnailSourceWithinInputLimit(kind, job.source_size)) {
    await env.DELIVERY_DB.prepare(
      `UPDATE image_thumbnail_jobs SET status='failed', error_code='unsupported_file',
       error_message='File type or size not supported', updated_at=datetime('now')
       WHERE source_key=? AND source_etag=?`
    ).bind(job.source_key, job.source_etag).run();
    return json({ status: "idle" }, 200);
  }

  // Video renderers may need time to seek a large source before their first
  // heartbeat. Keep the initial video lease aligned with the 15-minute signed
  // R2 read URL while retaining the shorter default for other media. Longer
  // work must still extend the attempt through the heartbeat endpoint.
  const initialLeaseMs = kind === "video" ? RENDERER_VIDEO_INITIAL_LEASE_MS : RENDERER_DEFAULT_LEASE_MS;
  const leaseUntil = new Date(Date.now() + initialLeaseMs).toISOString();
  const attemptCount = job.attempt_count + 1;

  const claimResult = await env.DELIVERY_DB.prepare(
    `UPDATE image_thumbnail_jobs SET status='processing', lease_until=?, attempt_count=?,
     error_code=NULL, error_message=NULL, updated_at=datetime('now')
     WHERE source_key=? AND source_etag=? AND status='pending'`
  ).bind(leaseUntil, attemptCount, job.source_key, job.source_etag).run();

  if (!claimResult.meta.changes || claimResult.meta.changes < 1) {
    // Someone else claimed it - try again next call
    return json({ status: "idle" }, 200);
  }

  // Return proxy URLs instead of presigned R2 URLs.
  // The TrueNAS worker downloads via GET /source/{leaseId}?key=...
  // and uploads via PUT /thumbnail/{leaseId}?key=...
  // The Worker proxies R2 through its binding - no S3 credentials needed on TrueNAS.
  const thumbnailKey = job.thumbnail_key;
  const leaseId = await createRendererLease(env, {
    v: 1,
    sourceKey: job.source_key,
    sourceEtag: cleanThumbnailEtag(job.source_etag),
    sourceSize: job.source_size,
    thumbnailKey,
    attemptCount,
    ...(includeKind === "all" ? { rendererContract: UNIFIED_RENDERER_CONTRACT } : {}),
    // The database lease is bounded and must be extended by heartbeat. The
    // attempt-bound token lasts longer so a heartbeat does not invalidate the
    // source/upload URLs during a large video render.
    expiresAt: Date.now() + RENDERER_LEASE_TOKEN_MAX_MS,
  });

  // For videos: generate a presigned R2 GET URL so ffmpeg can read directly
  // from R2 with HTTP Range (only pulls ~10-40MB, not the full file).
  // For images/PDFs: use the Worker proxy URL (full download to tmpfs).
  let r2PresignedUrl: string | undefined;
  if (kind === "video" && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    try {
      r2PresignedUrl = await presignR2Get({
        accountId: env.R2_ACCOUNT_ID,
        bucket: env.R2_BUCKET_NAME,
        key: job.source_key,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        expiresSeconds: 900,
      });
    } catch {
      // If signing fails, fall back to proxy download
    }
  }

  const response: ClaimResponse = {
    status: "claimed",
    leaseId,
    sourceKey: job.source_key,
    sourceEtag: cleanThumbnailEtag(job.source_etag),
    sourceSize: job.source_size,
    mediaKind: kind,
    sourceContentType: sourceHead.httpMetadata?.contentType || "application/octet-stream",
    thumbnailKey,
    r2SourceUrl: `${RENDERER_API_PREFIX}/source/${leaseId}?key=${encodeURIComponent(job.source_key)}`,
    r2PresignedUrl,
    r2UploadUrl: `${RENDERER_API_PREFIX}/thumbnail/${leaseId}?key=${encodeURIComponent(thumbnailKey)}`,
  };

  return json(response, 200);
}

/**
 * Stream the R2 source object to the TrueNAS worker.
 * Supports HTTP Range requests for video seeking.
 */
async function handleSourceDownload(request: Request, env: Env, leaseId: string): Promise<Response> {
  const sourceKey = new URL(request.url).searchParams.get("key");
  if (!sourceKey) return json({ error: "missing_key" }, 400);

  // The renderer bearer is never a bucket-wide read capability. Restrict each
  // proxy read to the exact current source of an unexpired processing lease.
  const job = await env.DELIVERY_DB.prepare(`SELECT source_etag,source_size,thumbnail_key,attempt_count
    FROM image_thumbnail_jobs WHERE source_key=? AND status='processing'
      AND lease_until IS NOT NULL AND datetime(lease_until)>datetime('now')`)
    .bind(sourceKey).first<{ source_etag: string; source_size: number; thumbnail_key: string; attempt_count: number }>();
  if (!job || !(await verifyRendererLease(env, leaseId, {
    sourceKey, sourceEtag: job.source_etag, sourceSize: job.source_size,
    thumbnailKey: job.thumbnail_key, attemptCount: job.attempt_count,
  }))) return json({ error: "source_not_found" }, 404);

  const rangeHeader = request.headers.get("Range");

  // HEAD the object to get its full size for Content-Range
  const head = await env.DATA_BUCKET.head(sourceKey);
  if (!head || cleanThumbnailEtag(head.httpEtag) !== cleanThumbnailEtag(job.source_etag) || head.size !== job.source_size)
    return json({ error: "source_not_found" }, 404);
  const totalSize = head.size;

  if (rangeHeader) {
    // Parse the Range header (e.g. "bytes=0-1023")
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1]!, 10);
      const requestedEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= totalSize || requestedEnd < start)
        return json({ error: "range_not_satisfiable" }, 416);
      const end = Math.min(requestedEnd, totalSize - 1);
      const length = end - start + 1;

      const object = await env.DATA_BUCKET.get(sourceKey, {
        onlyIf: { etagMatches: cleanThumbnailEtag(job.source_etag) },
        range: { offset: start, length },
      });
      if (!object || !("body" in object)) return json({ error: "range_not_satisfiable" }, 416);

      const headers = new Headers();
      headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
      headers.set("ETag", object.httpEtag);
      headers.set("Content-Length", String(length));
      headers.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cache-Control", "private, no-store");
      return new Response(object.body, { status: 206, headers });
    }
  }

  // Full download (no Range header)
  const object = await env.DATA_BUCKET.get(sourceKey, { onlyIf: { etagMatches: cleanThumbnailEtag(job.source_etag) } });
  if (!object || !("body" in object)) return json({ error: "source_not_found" }, 404);

  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  return new Response(object.body, { status: 200, headers });
}

/**
 * Receive the rendered thumbnail from the TrueNAS worker and store it in R2.
 */
async function handleThumbnailUpload(request: Request, env: Env, leaseId: string): Promise<Response> {
  const thumbnailKey = new URL(request.url).searchParams.get("key");
  if (!thumbnailKey) return json({ error: "missing_key" }, 400);
  if (!thumbnailKey.startsWith("_ltds/thumbnails/") && !thumbnailKey.startsWith("_ltds/derivatives/thumbnails/")) {
    return json({ error: "invalid_key" }, 400);
  }

  const job = await env.DELIVERY_DB.prepare(`SELECT source_key,source_etag,source_size,attempt_count FROM image_thumbnail_jobs
    WHERE thumbnail_key=? AND status='processing' AND lease_until IS NOT NULL
      AND datetime(lease_until)>datetime('now')`)
    .bind(thumbnailKey).first<{ source_key: string; source_etag: string; source_size: number; attempt_count: number }>();
  if (!job || !(await verifyRendererLease(env, leaseId, {
    sourceKey: job.source_key, sourceEtag: job.source_etag, sourceSize: job.source_size,
    thumbnailKey, attemptCount: job.attempt_count,
  }))) return json({ error: "job_not_found" }, 404);

  // Read body (max 128KB)
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "no_body" }, 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > THUMBNAIL_MAX_OUTPUT_BYTES) { await reader.cancel(); return json({ error: "too_large" }, 413); }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

  if (!validWebp(bytes)) return json({ error: "invalid_webp" }, 400);

  // Look up the source etag from the lease so we can embed it in the thumbnail's customMetadata.
  // getThumbnailForAuthorizedSource requires customMetadata.sourceEtag to match the source.
  const sourceEtag = cleanThumbnailEtag(job.source_etag);

  const stored = await env.DATA_BUCKET.put(thumbnailKey, bytes, {
    httpMetadata: { contentType: "image/webp", cacheControl: "private, no-store" },
    customMetadata: {
      rendererProvider: PROVIDER,
      rendererProfile: THUMBNAIL_RENDER_PROFILE,
      sourceEtag,
    },
  });

  return json({ status: "stored", etag: cleanThumbnailEtag(stored?.httpEtag || ""), size: length }, 200);
}

/**
 * Complete a job - the worker has already uploaded the thumbnail to R2.
 * Verify the thumbnail exists, is valid WebP, and mark the job as ready.
 */
async function handleComplete(request: Request, env: Env): Promise<Response> {
  let body: CompleteRequest;
  try {
    body = await boundedJson(request) as CompleteRequest;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const leaseId = typeof body.leaseId === "string" ? body.leaseId : null;
  const thumbnailKey = typeof body.thumbnailKey === "string" ? body.thumbnailKey : null;
  const thumbnailEtag = body.thumbnailEtag ? cleanThumbnailEtag(String(body.thumbnailEtag)) : null;
  const thumbnailSize = typeof body.thumbnailSize === "number" ? body.thumbnailSize : null;

  if (!leaseId || !thumbnailKey || !thumbnailEtag || !thumbnailSize) {
    return json({ error: "invalid_request" }, 400);
  }

  // Find the job for this thumbnail key
  const job = await env.DELIVERY_DB.prepare(
    `SELECT source_key, source_etag, source_size, status, attempt_count, lease_until
     FROM image_thumbnail_jobs WHERE thumbnail_key=?`
  ).bind(thumbnailKey).first<{ source_key: string; source_etag: string; source_size: number; status: string; attempt_count: number; lease_until: string | null }>();

  if (!job) return json({ error: "job_not_found" }, 404);
  if (job.status === "ready") return json({ status: "already_ready" }, 200);
  if (job.status !== "processing" || !job.lease_until || Date.parse(job.lease_until) <= Date.now() ||
    !(await verifyRendererLease(env, leaseId, {
      sourceKey: job.source_key, sourceEtag: job.source_etag, sourceSize: job.source_size,
      thumbnailKey, attemptCount: job.attempt_count,
    }))) return json({ error: "job_not_found" }, 404);

  // Verify the thumbnail only after authorizing the exact current attempt so
  // stale or forged leases cannot probe managed object keys.
  const thumbHead = await env.DATA_BUCKET.head(thumbnailKey);
  if (!thumbHead || cleanThumbnailEtag(thumbHead.httpEtag) !== thumbnailEtag ||
    thumbHead.size !== thumbnailSize || thumbHead.httpMetadata?.contentType !== "image/webp") {
    return json({ error: "thumbnail_not_found" }, 409);
  }

  // Verify the source still exists
  const sourceHead = await env.DATA_BUCKET.head(job.source_key);
  if (!sourceHead || cleanThumbnailEtag(sourceHead.httpEtag) !== cleanThumbnailEtag(job.source_etag) ||
    sourceHead.size !== job.source_size) {
    const failed = await env.DELIVERY_DB.prepare(
      `UPDATE image_thumbnail_jobs SET status='failed', error_code='source_changed', updated_at=datetime('now')
       WHERE source_key=? AND source_etag=? AND thumbnail_key=? AND status='processing'
         AND attempt_count=? AND lease_until IS NOT NULL AND datetime(lease_until)>datetime('now')`
    ).bind(job.source_key, job.source_etag, thumbnailKey, job.attempt_count).run();
    if (failed.meta.changes !== 1) return json({ error: "job_not_found" }, 404);
    return json({ error: "source_changed" }, 409);
  }

  // Validate the thumbnail is a proper WebP
  const thumbObject = await env.DATA_BUCKET.get(thumbnailKey, { onlyIf: { etagMatches: thumbnailEtag } });
  if (!thumbObject || !("body" in thumbObject)) return json({ error: "thumbnail_not_found" }, 409);
  const thumbBytes = new Uint8Array(await thumbObject.arrayBuffer());
  if (!validWebp(thumbBytes)) return json({ error: "invalid_thumbnail" }, 400);

  // Mark the job as ready
  const completed = await env.DELIVERY_DB.prepare(
    `UPDATE image_thumbnail_jobs SET status='ready', thumbnail_etag=?, thumbnail_size=?,
     thumbnail_provider=?, thumbnail_profile=?, lease_until=NULL,
     ready_at=datetime('now'), error_code=NULL, error_message=NULL, updated_at=datetime('now')
     WHERE source_key=? AND source_etag=? AND thumbnail_key=? AND status='processing'
       AND attempt_count=? AND lease_until IS NOT NULL AND datetime(lease_until)>datetime('now')`
  ).bind(
    thumbnailEtag, thumbnailSize, PROVIDER, THUMBNAIL_RENDER_PROFILE,
    job.source_key, job.source_etag, thumbnailKey, job.attempt_count,
  ).run();
  if (completed.meta.changes !== 1) return json({ error: "job_not_found" }, 404);

  return json({ status: "ready" }, 200);
}

async function currentRendererAttempt(
  env: Env,
  sourceKey: string,
  leaseId: string,
): Promise<RendererAttemptJob | null> {
  const job = await env.DELIVERY_DB.prepare(`SELECT source_etag,source_size,thumbnail_key,attempt_count,lease_until
    FROM image_thumbnail_jobs WHERE source_key=? AND status='processing'
      AND lease_until IS NOT NULL AND datetime(lease_until)>datetime('now')`)
    .bind(sourceKey).first<RendererAttemptJob>();
  if (!job) return null;
  const lease = await verifiedRendererLease(env, leaseId, {
    sourceKey,
    sourceEtag: job.source_etag,
    sourceSize: job.source_size,
    thumbnailKey: job.thumbnail_key,
    attemptCount: job.attempt_count,
  });
  if (!lease) return null;
  return { ...job, renderer_contract: lease.rendererContract || null };
}

/**
 * Heartbeat - extend a lease.
 */
async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  let body: RendererAttemptRequest;
  try {
    body = await boundedJson(request) as RendererAttemptRequest;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : null;
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : null;
  if (!sourceKey || !leaseId) return json({ error: "invalid_request" }, 400);
  const job = await currentRendererAttempt(env, sourceKey, leaseId);
  if (!job) return json({ error: "job_not_found" }, 404);

  // An early heartbeat must not shorten the longer initial video lease. Once
  // the initial horizon is within five minutes, heartbeats extend it as a
  // rolling five-minute lease.
  const currentLeaseMs = Date.parse(job.lease_until || "");
  const renewedLeaseMs = Date.now() + RENDERER_DEFAULT_LEASE_MS;
  const leaseUntil = new Date(Math.max(currentLeaseMs, renewedLeaseMs)).toISOString();
  const heartbeat = await env.DELIVERY_DB.prepare(
    `UPDATE image_thumbnail_jobs SET lease_until=?, updated_at=datetime('now')
     WHERE source_key=? AND source_etag=? AND thumbnail_key=? AND status='processing'
       AND attempt_count=? AND lease_until IS NOT NULL AND datetime(lease_until)>datetime('now')`
  ).bind(leaseUntil, sourceKey, job.source_etag, job.thumbnail_key, job.attempt_count).run();
  if (heartbeat.meta.changes !== 1) return json({ error: "job_not_found" }, 404);

  // Polling slots cannot report presence while all of them are rendering.
  // The signed claim contract therefore lets a busy unified slot refresh the
  // same health record without trusting a client-supplied capability string.
  if (job.renderer_contract === UNIFIED_RENDERER_CONTRACT) {
    await recordUnifiedRendererHealth(env);
  }

  return json({ status: "ok" }, 200);
}

/**
 * Fail - report a failed job.
 */
async function handleFail(request: Request, env: Env): Promise<Response> {
  let body: RendererAttemptRequest;
  try {
    body = await boundedJson(request) as RendererAttemptRequest;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : null;
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : null;
  const errorCode = typeof body.errorCode === "string" ? body.errorCode : "render_failed";
  const errorMessage = typeof body.errorMessage === "string" ? body.errorMessage.slice(0, 240) : "Render failed";

  if (!sourceKey || !leaseId) return json({ error: "invalid_request" }, 400);
  const job = await currentRendererAttempt(env, sourceKey, leaseId);
  if (!job) return json({ error: "job_not_found" }, 404);

  const terminal = job.attempt_count >= 6;
  const failed = await env.DELIVERY_DB.prepare(
    `UPDATE image_thumbnail_jobs SET status=?, error_code=?, error_message=?, lease_until=NULL,
     render_not_before=CASE WHEN ? THEN render_not_before ELSE datetime('now') END,
     ${terminal ? "failed_at=datetime('now')," : "queue_published_at=NULL,"}
     updated_at=datetime('now')
     WHERE source_key=? AND source_etag=? AND thumbnail_key=? AND status='processing'
       AND attempt_count=? AND lease_until IS NOT NULL AND datetime(lease_until)>datetime('now')`
  ).bind(
    terminal ? "failed" : "pending", errorCode, errorMessage, terminal,
    sourceKey, job.source_etag, job.thumbnail_key, job.attempt_count,
  ).run();
  if (failed.meta.changes !== 1) return json({ error: "job_not_found" }, 404);

  if (!terminal) {
    try {
      await env.THUMBNAIL_QUEUE.send({
        kind: "image-thumbnail.v1",
        sourceKey,
        sourceEtag: cleanThumbnailEtag(job.source_etag),
      });
      await env.DELIVERY_DB.prepare(`UPDATE image_thumbnail_jobs
        SET queue_published_at=datetime('now'),updated_at=datetime('now')
        WHERE source_key=? AND source_etag=? AND status='pending'`)
        .bind(sourceKey, cleanThumbnailEtag(job.source_etag)).run();
    } catch {
      // The durable pending row with a null publish marker is intentional.
      // Scheduled stale-renderer reconciliation republishes it if the server
      // stops before claiming it again.
    }
  }

  return json({ status: terminal ? "failed" : "retrying" }, 200);
}

/**
 * Create a presigned URL for R2 S3-compatible API.
 * Uses the AWS Signature V4 algorithm with R2 credentials.
 */
async function createR2PresignedUrl(
  env: Env,
  host: string,
  bucket: string,
  key: string,
  method: "GET" | "PUT",
  expiresInSeconds: number,
): Promise<string> {
  // R2 S3-compatible presigned URL
  // We need the R2 access key ID and secret from env
  // The Worker has R2 binding but for presigned URLs we need S3 credentials
  // Return the S3-compatible URL - the worker will sign it with its credentials
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const endpoint = `https://${host}/${bucket}/${encodedKey}`;

  // For now, return the unsigned URL. The TrueNAS worker will use its own
  // R2 S3 credentials (separate bucket-scoped key) to sign requests.
  // This keeps the R2 secret out of the Worker env and on TrueNAS only.
  return endpoint;
}

interface RendererLease {
  v: 1;
  sourceKey: string;
  sourceEtag: string;
  sourceSize: number;
  thumbnailKey: string;
  attemptCount: number;
  rendererContract?: typeof UNIFIED_RENDERER_CONTRACT;
  expiresAt: number;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_lease");
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function createRendererLease(env: Env, lease: RendererLease): Promise<string> {
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(lease)));
  return `v1.${encoded}.${await hmac(env.THUMBNAIL_INGEST_SECRET || "", `thumbnail-renderer-lease:v1:${encoded}`)}`;
}

async function verifyRendererLease(
  env: Env,
  leaseId: string | null,
  expected: Omit<RendererLease, "v" | "expiresAt" | "rendererContract">,
): Promise<boolean> {
  return Boolean(await verifiedRendererLease(env, leaseId, expected));
}

async function verifiedRendererLease(
  env: Env,
  leaseId: string | null,
  expected: Omit<RendererLease, "v" | "expiresAt" | "rendererContract">,
): Promise<RendererLease | null> {
  if (!leaseId || leaseId.length > 4096) return null;
  const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(leaseId);
  if (!match) return null;
  const [encoded, signature] = [match[1]!, match[2]!];
  let lease: RendererLease;
  try {
    lease = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(encoded))) as RendererLease;
  } catch {
    return null;
  }
  const valid = timingSafeEqual(
    await hmac(env.THUMBNAIL_INGEST_SECRET || "", `thumbnail-renderer-lease:v1:${encoded}`),
    signature,
  ) && lease.v === 1 && lease.expiresAt > Date.now() &&
    lease.sourceKey === expected.sourceKey && cleanThumbnailEtag(lease.sourceEtag) === cleanThumbnailEtag(expected.sourceEtag) &&
    lease.sourceSize === expected.sourceSize && lease.thumbnailKey === expected.thumbnailKey &&
    lease.attemptCount === expected.attemptCount;
  return valid ? lease : null;
}
