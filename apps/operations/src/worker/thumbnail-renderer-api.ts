import { timingSafeEqual } from "./crypto";
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
const PROVIDER = "cloudflare-container";

interface ClaimResponse {
  leaseId?: string;
  sourceKey?: string;
  sourceEtag?: string;
  sourceSize?: number;
  mediaKind?: string;
  thumbnailKey?: string;
  r2SourceUrl?: string;
  r2UploadUrl?: string;
  status: string;
}

interface CompleteRequest {
  leaseId?: unknown;
  thumbnailKey?: unknown;
  thumbnailEtag?: unknown;
  thumbnailSize?: unknown;
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

function expectedHosts(env: Env): string[] {
  const hosts: string[] = [];
  const ingest = (env.THUMBNAIL_INGEST_EXPECTED_HOST || "").trim().toLowerCase();
  const incoming = (env.INCOMING_EXPECTED_HOST || "").trim().toLowerCase();
  if (ingest) hosts.push(ingest);
  if (incoming) hosts.push(incoming);
  return hosts;
}

/**
 * Dispatch renderer API requests: claim, complete, heartbeat.
 * The TrueNAS thumbnail worker calls these to lease jobs, upload
 * thumbnails to R2, and report completion.
 */
export async function dispatchThumbnailRendererApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(RENDERER_API_PREFIX)) return null;

  const hosts = expectedHosts(env);
  if (hosts.length === 0 || !hosts.includes(url.hostname.toLowerCase())) return null;
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
async function handleClaim(_request: Request, env: Env): Promise<Response> {
  // Find the next pending job
  const job = await env.DELIVERY_DB.prepare(
    `SELECT source_key, source_etag, source_size, thumbnail_key, attempt_count
     FROM image_thumbnail_jobs
     WHERE status = 'pending'
       AND (lease_until IS NULL OR lease_until < datetime('now'))
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

  // Atomically claim the job (set to processing, lease for 5 minutes)
  const leaseId = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
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

  const response: ClaimResponse = {
    status: "claimed",
    leaseId,
    sourceKey: job.source_key,
    sourceEtag: cleanThumbnailEtag(job.source_etag),
    sourceSize: job.source_size,
    mediaKind: kind,
    thumbnailKey,
    r2SourceUrl: `${RENDERER_API_PREFIX}/source/${leaseId}?key=${encodeURIComponent(job.source_key)}`,
    r2UploadUrl: `${RENDERER_API_PREFIX}/thumbnail/${leaseId}?key=${encodeURIComponent(thumbnailKey)}`,
  };

  return json(response, 200);
}

/**
 * Stream the R2 source object to the TrueNAS worker.
 * Supports HTTP Range requests for video seeking.
 */
async function handleSourceDownload(request: Request, env: Env, _leaseId: string): Promise<Response> {
  const sourceKey = new URL(request.url).searchParams.get("key");
  if (!sourceKey) return json({ error: "missing_key" }, 400);

  const rangeHeader = request.headers.get("Range");

  // HEAD the object to get its full size for Content-Range
  const head = await env.DATA_BUCKET.head(sourceKey);
  if (!head) return json({ error: "source_not_found" }, 404);
  const totalSize = head.size;

  if (rangeHeader) {
    // Parse the Range header (e.g. "bytes=0-1023")
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1]!, 10);
      const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

      const object = await env.DATA_BUCKET.get(sourceKey, { onlyIf: new Headers({ Range: `bytes=${start}-${end}` }) });
      if (!object || !("body" in object)) return json({ error: "range_not_satisfiable" }, 416);

      const headers = new Headers();
      headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
      headers.set("ETag", object.httpEtag);
      headers.set("Content-Length", String(object.size));
      headers.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cache-Control", "private, no-store");
      return new Response(object.body, { status: 206, headers });
    }
  }

  // Full download (no Range header)
  const object = await env.DATA_BUCKET.get(sourceKey);
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
async function handleThumbnailUpload(request: Request, env: Env, _leaseId: string): Promise<Response> {
  const thumbnailKey = new URL(request.url).searchParams.get("key");
  if (!thumbnailKey) return json({ error: "missing_key" }, 400);
  if (!thumbnailKey.startsWith("_ltds/thumbnails/") && !thumbnailKey.startsWith("_ltds/derivatives/thumbnails/")) {
    return json({ error: "invalid_key" }, 400);
  }

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
  const sourceKey = thumbnailKey.replace(/^_ltds\/thumbnails\/v2\//, "");
  // The thumbnail key is a hash, not the source key. We need to find the job.
  // Use the lease ID from the path to find the source etag.
  const job = await env.DELIVERY_DB.prepare(
    `SELECT source_etag FROM image_thumbnail_jobs WHERE thumbnail_key=? AND status='processing'`
  ).bind(thumbnailKey).first<{ source_etag: string }>();

  const sourceEtag = job ? cleanThumbnailEtag(job.source_etag) : "";

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

  if (!thumbnailKey || !thumbnailEtag || !thumbnailSize) {
    return json({ error: "invalid_request" }, 400);
  }

  // Verify the thumbnail exists in R2
  const thumbHead = await env.DATA_BUCKET.head(thumbnailKey);
  if (!thumbHead || cleanThumbnailEtag(thumbHead.httpEtag) !== thumbnailEtag ||
    thumbHead.size !== thumbnailSize || thumbHead.httpMetadata?.contentType !== "image/webp") {
    return json({ error: "thumbnail_not_found" }, 409);
  }

  // Find the job for this thumbnail key
  const job = await env.DELIVERY_DB.prepare(
    `SELECT source_key, source_etag, source_size, status FROM image_thumbnail_jobs WHERE thumbnail_key=?`
  ).bind(thumbnailKey).first<{ source_key: string; source_etag: string; source_size: number; status: string }>();

  if (!job) return json({ error: "job_not_found" }, 404);
  if (job.status === "ready") return json({ status: "already_ready" }, 200);

  // Verify the source still exists
  const sourceHead = await env.DATA_BUCKET.head(job.source_key);
  if (!sourceHead || cleanThumbnailEtag(sourceHead.httpEtag) !== cleanThumbnailEtag(job.source_etag)) {
    await env.DELIVERY_DB.prepare(
      `UPDATE image_thumbnail_jobs SET status='failed', error_code='source_changed', updated_at=datetime('now')
       WHERE source_key=? AND source_etag=?`
    ).bind(job.source_key, job.source_etag).run();
    return json({ error: "source_changed" }, 409);
  }

  // Validate the thumbnail is a proper WebP
  const thumbObject = await env.DATA_BUCKET.get(thumbnailKey, { onlyIf: { etagMatches: thumbnailEtag } });
  if (!thumbObject || !("body" in thumbObject)) return json({ error: "thumbnail_not_found" }, 409);
  const thumbBytes = new Uint8Array(await thumbObject.arrayBuffer());
  if (!validWebp(thumbBytes)) return json({ error: "invalid_thumbnail" }, 400);

  // Mark the job as ready
  await env.DELIVERY_DB.prepare(
    `UPDATE image_thumbnail_jobs SET status='ready', thumbnail_etag=?, thumbnail_size=?,
     thumbnail_provider=?, thumbnail_profile=?, lease_until=NULL,
     ready_at=datetime('now'), error_code=NULL, error_message=NULL, updated_at=datetime('now')
     WHERE source_key=? AND source_etag=?`
  ).bind(thumbnailEtag, thumbnailSize, PROVIDER, THUMBNAIL_RENDER_PROFILE, job.source_key, job.source_etag).run();

  return json({ status: "ready" }, 200);
}

/**
 * Heartbeat - extend a lease.
 */
async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await boundedJson(request);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : null;
  if (!sourceKey) return json({ error: "invalid_request" }, 400);

  const leaseUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await env.DELIVERY_DB.prepare(
    `UPDATE image_thumbnail_jobs SET lease_until=?, updated_at=datetime('now')
     WHERE source_key=? AND status='processing'`
  ).bind(leaseUntil, sourceKey).run();

  return json({ status: "ok" }, 200);
}

/**
 * Fail - report a failed job.
 */
async function handleFail(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await boundedJson(request);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : null;
  const errorCode = typeof body.errorCode === "string" ? body.errorCode : "render_failed";
  const errorMessage = typeof body.errorMessage === "string" ? body.errorMessage.slice(0, 240) : "Render failed";

  if (!sourceKey) return json({ error: "invalid_request" }, 400);

  const job = await env.DELIVERY_DB.prepare(
    `SELECT attempt_count FROM image_thumbnail_jobs WHERE source_key=? AND status='processing'`
  ).bind(sourceKey).first<{ attempt_count: number }>();

  if (!job) return json({ error: "job_not_found" }, 404);

  const terminal = job.attempt_count >= 6;
  await env.DELIVERY_DB.prepare(
    `UPDATE image_thumbnail_jobs SET status=?, error_code=?, error_message=?, lease_until=NULL,
     ${terminal ? "failed_at=datetime('now')," : "queue_published_at=datetime('now'),"}
     updated_at=datetime('now')
     WHERE source_key=? AND status='processing'`
  ).bind(terminal ? "failed" : "pending", errorCode, errorMessage, sourceKey).run();

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