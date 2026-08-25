import { HTTPException } from "hono/http-exception";
import {
  aggregateDeliveryLocations,
  thumbnailFallbackKindForFile,
  type DeliveryItem,
  type DeliveryLocationCollection,
} from "@ltds/shared";
import { hmac, timingSafeEqual } from "./crypto";
import { authorizeDeliveryFolderPrefix, deliverySourceUrl, encodeRef } from "./delivery";
import { thumbnailSourceEligible, thumbnailStateForObject, type ThumbnailJobRow } from "./image-thumbnails";
import type { Env, StaffPrincipal } from "./types";

export const IMAGE_LOCATION_MAP_LIMIT = 500;
const LOCATION_ASSET_REF_PREFIX = "loc_";
const LOCATION_ASSET_REF_PATTERN = /^loc_[A-Za-z0-9_-]{43}$/;

interface CurrentLocationAssetRow {
  source_key: string;
  source_etag: string;
  latitude: number;
  longitude: number;
  size: number;
  uploaded_at: string;
  content_type: string | null;
  media_kind: "image";
  thumbnail_source_etag: string | null;
  thumbnail_key: string | null;
  thumbnail_status: ThumbnailJobRow["status"] | null;
  thumbnail_error_code: string | null;
}

function cleanEtag(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

async function locationAssetRef(
  secret: string,
  prefix: string,
  sourceKey: string,
  sourceEtag: string,
): Promise<string> {
  return `${LOCATION_ASSET_REF_PREFIX}${await hmac(secret,
    `operations-location-asset:v1\0${prefix}\0${sourceKey}\0${cleanEtag(sourceEtag)}`)}`;
}

async function currentFolderLocationAssets(
  env: Pick<Env, "DELIVERY_DB">,
  prefix: string,
): Promise<CurrentLocationAssetRow[]> {
  const rows = await env.DELIVERY_DB.prepare(`/* image-location.operations-assets */
    SELECT location.source_key,location.source_etag,location.latitude,location.longitude,
      file.size,file.uploaded_at,file.content_type,file.media_kind,
      thumbnail.source_etag thumbnail_source_etag,thumbnail.thumbnail_key,
      thumbnail.status thumbnail_status,thumbnail.error_code thumbnail_error_code
    FROM image_asset_locations location
    JOIN file_index file ON file.r2_key=location.source_key
      AND trim(file.etag,'"')=location.source_etag AND file.media_kind='image'
    LEFT JOIN image_thumbnail_jobs thumbnail ON thumbnail.source_key=location.source_key
      AND trim(thumbnail.source_etag,'"')=location.source_etag
    WHERE location.status='ready' AND location.folder_prefix=?
      AND NOT EXISTS (
        SELECT 1 FROM delivery_tombstones tombstone
        WHERE tombstone.restored_at IS NULL AND (
          tombstone.physical_key=location.source_key OR
          (tombstone.tombstone_kind='prefix' AND substr(location.source_key,1,length(tombstone.physical_key))=tombstone.physical_key)
        )
      )
    ORDER BY location.source_key LIMIT ?`)
    .bind(prefix, IMAGE_LOCATION_MAP_LIMIT + 1)
    .all<CurrentLocationAssetRow>();
  return rows.results;
}

async function currentFolderImageCount(
  env: Pick<Env, "DELIVERY_DB">,
  prefix: string,
): Promise<number> {
  const row = await env.DELIVERY_DB.prepare(`/* image-location.operations-total */
    SELECT COUNT(*) image_count FROM file_index file
    WHERE file.media_kind='image'
      AND substr(file.r2_key,1,length(?))=?
      AND length(file.r2_key)>length(?)
      AND instr(substr(file.r2_key,length(?)+1),'/')=0
      AND NOT EXISTS (
        SELECT 1 FROM delivery_tombstones tombstone
        WHERE tombstone.restored_at IS NULL AND (
          tombstone.physical_key=file.r2_key OR
          (tombstone.tombstone_kind='prefix' AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)
        )
      )`)
    .bind(prefix, prefix, prefix, prefix)
    .first<{ image_count: number }>();
  return Math.max(0, Number(row?.image_count || 0));
}

async function authorizeResolverFolder(
  env: Env,
  principal: StaffPrincipal,
  prefixValue: string,
): Promise<string> {
  try {
    return await authorizeDeliveryFolderPrefix(env, principal, prefixValue);
  } catch (error) {
    if (error instanceof HTTPException && (error.status === 403 || error.status === 404)) {
      throw new HTTPException(404, { message: "Location asset not found" });
    }
    throw error;
  }
}

export async function listDeliveryFolderLocations(
  env: Env,
  principal: StaffPrincipal,
  prefixValue: string,
): Promise<DeliveryLocationCollection> {
  const prefix = await authorizeDeliveryFolderPrefix(env, principal, prefixValue);
  const [rows, totalImageCount] = await Promise.all([
    currentFolderLocationAssets(env, prefix),
    currentFolderImageCount(env, prefix),
  ]);
  const safeRows = await Promise.all(rows.map(async (row) => ({
    latitude: row.latitude,
    longitude: row.longitude,
    assetRef: await locationAssetRef(env.DELIVERY_TOKEN_SECRET, prefix, row.source_key, row.source_etag),
  })));
  const locations = aggregateDeliveryLocations(safeRows, IMAGE_LOCATION_MAP_LIMIT);
  return {
    ...locations,
    totalImageCount,
    unmappedImageCount: Math.max(0, totalImageCount - locations.imageCount),
  };
}

/**
 * Resolves a map representative only after the requested folder and the
 * exact, current, non-trashed D1 source version have both been reauthorized.
 * Neither this resolver nor the location listing reads an R2 object.
 */
export async function resolveDeliveryLocationAsset(
  env: Env,
  principal: StaffPrincipal,
  prefixValue: string,
  assetRef: string,
): Promise<DeliveryItem> {
  if (!LOCATION_ASSET_REF_PATTERN.test(assetRef)) {
    throw new HTTPException(404, { message: "Location asset not found" });
  }
  const prefix = await authorizeResolverFolder(env, principal, prefixValue);
  if (!prefix) throw new HTTPException(404, { message: "Location asset not found" });
  const rows = await currentFolderLocationAssets(env, prefix);
  let row: CurrentLocationAssetRow | undefined;
  for (const candidate of rows) {
    const expected = await locationAssetRef(
      env.DELIVERY_TOKEN_SECRET,
      prefix,
      candidate.source_key,
      candidate.source_etag,
    );
    if (timingSafeEqual(expected, assetRef)) {
      row = candidate;
      break;
    }
  }
  if (!row) throw new HTTPException(404, { message: "Location asset not found" });

  const id = encodeRef(row.source_key);
  const kind = "image" as const;
  const sourceUrl = deliverySourceUrl(kind, id);
  const eligible = thumbnailSourceEligible(row.source_key, row.size, row.content_type || undefined);
  const thumbnailJob: ThumbnailJobRow | undefined = row.thumbnail_source_etag && row.thumbnail_key && row.thumbnail_status
    ? {
        source_etag: row.thumbnail_source_etag,
        thumbnail_key: row.thumbnail_key,
        status: row.thumbnail_status,
        error_code: row.thumbnail_error_code,
      }
    : undefined;
  const thumbnailState = eligible
    ? thumbnailStateForObject(row.source_etag, thumbnailJob)
    : { state: "not_applicable" as const };
  const name = row.source_key.slice(prefix.length);
  return {
    id,
    name,
    displayName: name,
    kind,
    size: row.size,
    uploadedAt: row.uploaded_at,
    ...(thumbnailState.state === "ready" ? { thumbnailUrl: `/api/delivery/items/${id}/thumbnail` } : {}),
    thumbnailState: thumbnailState.state,
    thumbnailFallbackKind: thumbnailFallbackKindForFile(row.source_key, kind),
    previewUrl: sourceUrl,
    sourceUrl,
    downloadUrl: `/api/delivery/items/${id}/download`,
  };
}
