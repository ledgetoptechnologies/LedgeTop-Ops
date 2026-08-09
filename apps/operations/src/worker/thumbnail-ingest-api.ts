import { timingSafeEqual } from "./crypto";
import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_MAX_OUTPUT_BYTES,
  THUMBNAIL_WIDTH,
  canonicalThumbnailSourceKey,
  cleanThumbnailEtag,
  sourceIsTrashed,
  thumbnailSourceKind,
  thumbnailSourceWithinInputLimit,
} from "./image-thumbnails";
import { THUMBNAIL_RENDER_PROFILE, validWebp } from "./thumbnail-renderer-contract";
import type { Env } from "./types";

const INGEST_PATH = "/api/internal/thumbnail-ingest/v1";
const PREBUILT_PREFIX = "_ltds/derivatives/thumbnails/v1/prebuilt/";
const PROVIDER = "ltds-truenas";
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;

interface RegisterRequest {
  schemaVersion?: unknown;
  provider?: unknown;
  manifestKey?: unknown;
  manifestEtag?: unknown;
  thumbnailKey?: unknown;
  thumbnailEtag?: unknown;
}

interface PrebuiltManifest {
  schemaVersion?: unknown;
  provider?: unknown;
  rendererVersion?: unknown;
  profile?: unknown;
  sourceKey?: unknown;
  sourceEtag?: unknown;
  sourceSize?: unknown;
  sourceMime?: unknown;
  sourceFingerprint?: unknown;
  createdAt?: unknown;
  thumbnail?: unknown;
}

interface SourceFingerprint {
  algorithm?: unknown;
  value?: unknown;
}

interface PrebuiltThumbnail {
  key?: unknown;
  mime?: unknown;
  width?: unknown;
  height?: unknown;
  bytes?: unknown;
  sha256?: unknown;
}

interface IndexedSource {
  etag: string;
  size: number;
  content_type: string | null;
  media_kind: string;
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
  return (env.THUMBNAIL_INGEST_EXPECTED_HOST || "").trim().toLowerCase();
}

async function boundedJson(request: Request): Promise<RegisterRequest> {
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  if (!request.body) throw new Error("invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("request_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) throw new Error("invalid_json");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
  return parsed as RegisterRequest;
}

function validPrebuiltKey(key: unknown, suffix: ".json" | ".webp"): key is string {
  if (typeof key !== "string" || key.length <= PREBUILT_PREFIX.length || new TextEncoder().encode(key).byteLength > 1024 || !key.startsWith(PREBUILT_PREFIX) ||
    key.includes("\\") || /[\0-\x1f\x7f]/.test(key) || !key.endsWith(suffix)) return false;
  return key.split("/").every((part) => part && part !== "." && part !== "..");
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function exactEtag(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const clean = cleanThumbnailEtag(value);
  return clean && /^[\x21-\x7e]+$/.test(clean) ? clean : null;
}

function normalizedMime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.split(";", 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(normalized) ? normalized : null;
}

function checksumSha256Hex(object: R2Object): string | null {
  const checksum = object.checksums?.sha256;
  if (!checksum || checksum.byteLength !== 32) return null;
  return [...new Uint8Array(checksum)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function registerReady(
  env: Env,
  input: {
    sourceKey: string;
    sourceEtag: string;
    sourceSize: number;
    thumbnailKey: string;
    thumbnailEtag: string;
    thumbnailSize: number;
    manifestKey: string;
    manifestEtag: string;
  },
): Promise<boolean> {
  const active = `EXISTS (SELECT 1 FROM file_index f WHERE f.r2_key=? AND trim(f.etag,'"')=? AND f.size=?
      AND f.media_kind IN ('image','pdf'))
    AND NOT EXISTS (SELECT 1 FROM delivery_tombstones t WHERE t.restored_at IS NULL
      AND (t.physical_key=? OR (t.tombstone_kind='prefix' AND substr(?,1,length(t.physical_key))=t.physical_key)))`;
  await env.DELIVERY_DB.prepare(`INSERT INTO image_thumbnail_jobs(
      source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,attempt_count,
      error_code,error_message,lease_until,last_event_at,ready_at,failed_at,dead_lettered_at,queue_published_at,
      thumbnail_provider,thumbnail_profile,thumbnail_manifest_key,thumbnail_manifest_etag
    ) SELECT ?,?,?,?,?,?,'ready',0,NULL,NULL,NULL,datetime('now'),datetime('now'),NULL,NULL,NULL,?,?,?,?
      WHERE ${active}
    ON CONFLICT(source_key) DO UPDATE SET
      source_etag=excluded.source_etag,source_size=excluded.source_size,
      thumbnail_key=excluded.thumbnail_key,thumbnail_etag=excluded.thumbnail_etag,thumbnail_size=excluded.thumbnail_size,
      status='ready',attempt_count=0,error_code=NULL,error_message=NULL,lease_until=NULL,
      last_event_at=excluded.last_event_at,ready_at=excluded.ready_at,failed_at=NULL,dead_lettered_at=NULL,
      queue_published_at=NULL,thumbnail_provider=excluded.thumbnail_provider,thumbnail_profile=excluded.thumbnail_profile,
      thumbnail_manifest_key=excluded.thumbnail_manifest_key,thumbnail_manifest_etag=excluded.thumbnail_manifest_etag,
      updated_at=datetime('now') WHERE ${active}`)
    .bind(
      input.sourceKey, input.sourceEtag, input.sourceSize, input.thumbnailKey, input.thumbnailEtag, input.thumbnailSize,
      PROVIDER, THUMBNAIL_RENDER_PROFILE, input.manifestKey, input.manifestEtag,
      input.sourceKey, input.sourceEtag, input.sourceSize, input.sourceKey, input.sourceKey,
      input.sourceKey, input.sourceEtag, input.sourceSize, input.sourceKey, input.sourceKey,
    ).run();
  const row = await env.DELIVERY_DB.prepare(`SELECT source_etag,thumbnail_key,thumbnail_etag,status,
      thumbnail_provider,thumbnail_profile,thumbnail_manifest_key,thumbnail_manifest_etag
    FROM image_thumbnail_jobs WHERE source_key=?`).bind(input.sourceKey).first<Record<string, unknown>>();
  return row?.status === "ready" && cleanThumbnailEtag(String(row.source_etag || "")) === input.sourceEtag &&
    row.thumbnail_key === input.thumbnailKey && cleanThumbnailEtag(String(row.thumbnail_etag || "")) === input.thumbnailEtag &&
    row.thumbnail_provider === PROVIDER && row.thumbnail_profile === THUMBNAIL_RENDER_PROFILE &&
    row.thumbnail_manifest_key === input.manifestKey && cleanThumbnailEtag(String(row.thumbnail_manifest_etag || "")) === input.manifestEtag;
}

export async function dispatchThumbnailIngestRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== INGEST_PATH) return null;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const host = expectedHost(env);
  if (!host || url.hostname.toLowerCase() !== host) return json({ error: "host_mismatch" }, 421);
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    return json({ error: "unsupported_media_type" }, 415);
  }

  let body: RegisterRequest;
  try {
    body = await boundedJson(request);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "request_too_large";
    return json({ error: tooLarge ? "request_too_large" : "invalid_request" }, tooLarge ? 413 : 400);
  }
  const manifestEtag = exactEtag(body.manifestEtag);
  const thumbnailEtag = exactEtag(body.thumbnailEtag);
  if (body.schemaVersion !== 1 || body.provider !== PROVIDER || !validPrebuiltKey(body.manifestKey, ".json") ||
    !validPrebuiltKey(body.thumbnailKey, ".webp") || !manifestEtag || !thumbnailEtag) {
    return json({ error: "invalid_request" }, 400);
  }

  const manifestHead = await env.DATA_BUCKET.head(body.manifestKey);
  if (!manifestHead || cleanThumbnailEtag(manifestHead.httpEtag) !== manifestEtag || manifestHead.size <= 0 || manifestHead.size > MAX_MANIFEST_BYTES ||
    manifestHead.httpMetadata?.contentType !== "application/json") return json({ error: "manifest_not_current" }, 409);
  const manifestObject = await env.DATA_BUCKET.get(body.manifestKey, { onlyIf: { etagMatches: manifestEtag } });
  if (!manifestObject || !("body" in manifestObject) || cleanThumbnailEtag(manifestObject.httpEtag) !== manifestEtag) {
    return json({ error: "manifest_not_current" }, 409);
  }
  const manifest = await manifestObject.json<PrebuiltManifest>().catch(() => null);
  const derivative = manifest?.thumbnail && typeof manifest.thumbnail === "object" && !Array.isArray(manifest.thumbnail)
    ? manifest.thumbnail as PrebuiltThumbnail : null;
  const fingerprint = manifest?.sourceFingerprint && typeof manifest.sourceFingerprint === "object" && !Array.isArray(manifest.sourceFingerprint)
    ? manifest.sourceFingerprint as SourceFingerprint : null;
  const sourceEtag = exactEtag(manifest?.sourceEtag);
  const sourceMime = normalizedMime(manifest?.sourceMime);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.provider !== PROVIDER || manifest.profile !== THUMBNAIL_RENDER_PROFILE ||
    typeof manifest.rendererVersion !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(manifest.rendererVersion) ||
    typeof manifest.sourceKey !== "string" || !canonicalThumbnailSourceKey(manifest.sourceKey) || !sourceEtag ||
    typeof manifest.sourceSize !== "number" || !Number.isSafeInteger(manifest.sourceSize) || manifest.sourceSize <= 0 || !sourceMime ||
    !fingerprint || fingerprint.algorithm !== "sha256" || typeof fingerprint.value !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint.value) ||
    typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !derivative || derivative.key !== body.thumbnailKey || derivative.mime !== "image/webp" ||
    derivative.width !== THUMBNAIL_WIDTH || derivative.height !== THUMBNAIL_HEIGHT || typeof derivative.bytes !== "number" ||
    !Number.isSafeInteger(derivative.bytes) || derivative.bytes <= 0 || derivative.bytes > THUMBNAIL_MAX_OUTPUT_BYTES ||
    typeof derivative.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(derivative.sha256)) {
    return json({ error: "invalid_manifest" }, 400);
  }
  const expectedThumbnailKey = `${PREBUILT_PREFIX}${manifest.sourceKey}/${fingerprint.value}.webp`;
  const expectedManifestKey = `${PREBUILT_PREFIX}${manifest.sourceKey}/${fingerprint.value}.json`;
  if (new TextEncoder().encode(expectedThumbnailKey).byteLength > 1024 || new TextEncoder().encode(expectedManifestKey).byteLength > 1024 ||
    body.thumbnailKey !== expectedThumbnailKey || body.manifestKey !== expectedManifestKey) return json({ error: "invalid_manifest" }, 400);

  const indexed = await env.DELIVERY_DB.prepare("SELECT etag,size,content_type,media_kind FROM file_index WHERE r2_key=?")
    .bind(manifest.sourceKey).first<IndexedSource>();
  const kind = thumbnailSourceKind(manifest.sourceKey, indexed?.content_type || undefined);
  if (!indexed || cleanThumbnailEtag(indexed.etag) !== sourceEtag || indexed.size !== manifest.sourceSize ||
    normalizedMime(indexed.content_type) !== sourceMime || !kind || !thumbnailSourceWithinInputLimit(kind, manifest.sourceSize) ||
    await sourceIsTrashed(env, manifest.sourceKey)) return json({ error: "source_not_current" }, 409);
  const source = await env.DATA_BUCKET.head(manifest.sourceKey);
  if (!source || cleanThumbnailEtag(source.httpEtag) !== sourceEtag || source.size !== manifest.sourceSize ||
    checksumSha256Hex(source) !== fingerprint.value ||
    (source.httpMetadata?.contentType && normalizedMime(source.httpMetadata.contentType) !== sourceMime)) {
    return json({ error: "source_not_current" }, 409);
  }

  const thumbnailHead = await env.DATA_BUCKET.head(body.thumbnailKey);
  if (!thumbnailHead || cleanThumbnailEtag(thumbnailHead.httpEtag) !== thumbnailEtag || thumbnailHead.size !== derivative.bytes ||
    thumbnailHead.httpMetadata?.contentType !== "image/webp") return json({ error: "thumbnail_not_current" }, 409);
  const thumbnail = await env.DATA_BUCKET.get(body.thumbnailKey, { onlyIf: { etagMatches: thumbnailEtag } });
  if (!thumbnail || !("body" in thumbnail) || cleanThumbnailEtag(thumbnail.httpEtag) !== thumbnailEtag) {
    return json({ error: "invalid_thumbnail" }, 400);
  }
  const thumbnailBytes = await thumbnail.arrayBuffer();
  if (!validWebp(new Uint8Array(thumbnailBytes)) || await sha256Hex(thumbnailBytes) !== derivative.sha256) {
    return json({ error: "invalid_thumbnail" }, 400);
  }

  const finalSource = await env.DATA_BUCKET.head(manifest.sourceKey);
  const finalManifest = await env.DATA_BUCKET.head(body.manifestKey);
  const finalThumbnail = await env.DATA_BUCKET.head(body.thumbnailKey);
  if (!finalSource || cleanThumbnailEtag(finalSource.httpEtag) !== sourceEtag || finalSource.size !== manifest.sourceSize ||
    checksumSha256Hex(finalSource) !== fingerprint.value ||
    !finalManifest || cleanThumbnailEtag(finalManifest.httpEtag) !== manifestEtag ||
    !finalThumbnail || cleanThumbnailEtag(finalThumbnail.httpEtag) !== thumbnailEtag || finalThumbnail.size !== derivative.bytes ||
    await sourceIsTrashed(env, manifest.sourceKey) || !await registerReady(env, {
      sourceKey: manifest.sourceKey,
      sourceEtag,
      sourceSize: manifest.sourceSize,
      thumbnailKey: body.thumbnailKey,
      thumbnailEtag,
      thumbnailSize: derivative.bytes,
      manifestKey: body.manifestKey,
      manifestEtag,
    })) return json({ error: "source_not_current" }, 409);

  return json({ status: "ready", provider: PROVIDER, profile: THUMBNAIL_RENDER_PROFILE }, 200);
}

export const THUMBNAIL_PREBUILT_PREFIX = PREBUILT_PREFIX;
