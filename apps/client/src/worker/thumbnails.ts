import { HTTPException } from "hono/http-exception";
import { isMovedSourceMarker } from "@ltds/shared";
import { thumbnailFallbackKindForFile, type DeliveryItem, type ThumbnailState } from "@ltds/shared";
import { matchesEtag } from "./prepared-images";

const MAX_THUMBNAIL_BYTES = 128 * 1024;
const MAX_IMAGE_THUMBNAIL_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_PDF_THUMBNAIL_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_VIDEO_THUMBNAIL_INPUT_BYTES = 10 * 1024 * 1024 * 1024;

export interface ThumbnailJobRow {
  source_etag: string;
  thumbnail_key: string;
  thumbnail_etag: string | null;
  thumbnail_size: number | null;
  status: "pending" | "processing" | "ready" | "failed";
}

export function thumbnailStateForObject(
  sourceEtag: string,
  job: ThumbnailJobRow | null | undefined,
): ThumbnailState {
  if (!job || cleanEtag(job.source_etag) !== cleanEtag(sourceEtag)) return "pending";
  if (job.status === "failed") return "failed";
  return job.status === "ready" && Boolean(job.thumbnail_etag) ? "ready" : "pending";
}

export function isThumbnailCandidate(
  kind: Exclude<DeliveryItem["kind"], "folder">,
  sourceSize: number | undefined,
): boolean {
  const limit = kind === "image" ? MAX_IMAGE_THUMBNAIL_INPUT_BYTES
    : kind === "pdf" ? MAX_PDF_THUMBNAIL_INPUT_BYTES
    : kind === "video" ? MAX_VIDEO_THUMBNAIL_INPUT_BYTES
    : 0;
  return limit > 0 && (sourceSize === undefined || (sourceSize > 0 && sourceSize <= limit));
}

export function thumbnailFieldsForObject(
  sourceKey: string,
  kind: Exclude<DeliveryItem["kind"], "folder">,
  baseUrl: string,
  sourceEtag: string,
  job: ThumbnailJobRow | null | undefined,
  sourceSize?: number,
  contentType?: string,
): Pick<DeliveryItem, "thumbnailState" | "thumbnailFallbackKind" | "thumbnailUrl"> {
  const thumbnailState = isThumbnailCandidate(kind, sourceSize) ? thumbnailStateForObject(sourceEtag, job) : "not_applicable";
  return {
    thumbnailState,
    thumbnailFallbackKind: thumbnailFallbackKindForFile(sourceKey, kind),
    ...(thumbnailState === "ready" ? { thumbnailUrl: `${baseUrl}/thumbnail` } : {}),
  };
}

function cleanEtag(value: string): string {
  return value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

export async function serveAuthorizedThumbnail(
  env: Pick<EnvLike, "DELIVERY_DB" | "DATA_BUCKET">,
  sourceKey: string,
  request: { method: string; ifNoneMatch?: string; kind?: Exclude<DeliveryItem["kind"], "folder"> },
): Promise<Response> {
  const job = await env.DELIVERY_DB
    .prepare(`SELECT source_etag,thumbnail_key,thumbnail_etag,thumbnail_size,status
      FROM image_thumbnail_jobs WHERE source_key=?`)
    .bind(sourceKey)
    .first<ThumbnailJobRow>();
  if (!job || job.status !== "ready" || !job.thumbnail_etag || !job.thumbnail_size) {
    throw new HTTPException(409, { message: "Thumbnail is not ready", cause: { code: job?.status === "failed" ? "THUMBNAIL_FAILED" : "THUMBNAIL_PENDING" } });
  }
  const source = await env.DATA_BUCKET.head(sourceKey);
  if (!source || isMovedSourceMarker(source)) throw new HTTPException(404, { message: "File not found" });
  if (!isThumbnailCandidate(request.kind || "image", source.size))
    throw new HTTPException(409, { message: "Thumbnail is not available for this file type", cause: { code: "THUMBNAIL_NOT_APPLICABLE" } });
  if (cleanEtag(source.httpEtag) !== cleanEtag(job.source_etag)) {
    throw new HTTPException(409, { message: "Thumbnail is not ready", cause: { code: "THUMBNAIL_PENDING" } });
  }
  const thumbnail = await env.DATA_BUCKET.head(job.thumbnail_key);
  if (!thumbnail || thumbnail.size <= 0 || thumbnail.size > MAX_THUMBNAIL_BYTES ||
    cleanEtag(thumbnail.httpEtag) !== cleanEtag(job.thumbnail_etag) || thumbnail.size !== job.thumbnail_size) {
    throw new HTTPException(409, { message: "Thumbnail is not ready", cause: { code: "THUMBNAIL_FAILED" } });
  }
  const responseEtag = thumbnail.httpEtag.startsWith('"') ? thumbnail.httpEtag : `"${cleanEtag(thumbnail.httpEtag)}"`;
  const headers = new Headers({
    "Content-Type": "image/webp",
    "Content-Disposition": "inline",
    "Content-Length": String(thumbnail.size),
    "Cache-Control": "private, no-store",
    "ETag": responseEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (matchesEtag(request.ifNoneMatch, responseEtag)) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { headers });
  const object = await env.DATA_BUCKET.get(job.thumbnail_key, { onlyIf: { etagMatches: thumbnail.etag } });
  if (!object || !("body" in object) || object.size !== thumbnail.size) {
    throw new HTTPException(409, { message: "Thumbnail is not ready", cause: { code: "THUMBNAIL_FAILED" } });
  }
  return new Response(object.body, { headers });
}

interface StatementLike {
  bind(...values: unknown[]): StatementLike;
  first<T>(): Promise<T | null>;
}

interface EnvLike {
  DELIVERY_DB: { prepare(query: string): StatementLike };
  DATA_BUCKET: {
    head(key: string): Promise<{ size: number; etag: string; httpEtag: string; customMetadata?:Record<string,string> } | null>;
    get(key: string, options: { onlyIf: { etagMatches: string } }): Promise<{ size: number; body?: BodyInit } | null>;
  };
}
