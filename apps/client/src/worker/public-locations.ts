import { HTTPException } from "hono/http-exception";
import { aggregateDeliveryLocations, type DeliveryItem, type DeliveryLocationCollection } from "@ltds/shared";
import { decodeItemRef, encodeItemRef, isHiddenKey, keyWithinRoot, normalizeRoot } from "./files";
import { constantTimeEqual, hmac } from "./security";
import { thumbnailFieldsForObject, type ThumbnailJobRow } from "./thumbnails";
import type { Env, ShareRow } from "./types";

const PUBLIC_LOCATION_LIMIT = 500;
const LOCATION_REF_PATTERN = /^loc_[A-Za-z0-9_-]{43}$/;

interface LocationRow {
  source_key: string;
  source_etag: string;
  latitude: number;
  longitude: number;
  size: number;
  uploaded_at: string;
  content_type: string | null;
  thumbnail_source_etag: string | null;
  thumbnail_key: string | null;
  thumbnail_etag: string | null;
  thumbnail_size: number | null;
  thumbnail_status: ThumbnailJobRow["status"] | null;
}

function locationPrefix(share: Pick<ShareRow, "r2_prefix">, folderRef: string): string {
  const root = normalizeRoot(share.r2_prefix);
  return folderRef ? `${keyWithinRoot(root, decodeItemRef(folderRef)).replace(/\/$/, "")}/` : root;
}

async function currentShareLocationRows(env: Pick<Env, "DELIVERY_DB">, share: Pick<ShareRow, "r2_prefix">, folderRef: string): Promise<LocationRow[]> {
  const prefix = locationPrefix(share, folderRef);
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`/* image-location.public-share-assets */
    SELECT location.source_key,location.source_etag,location.latitude,location.longitude,
      file.size,file.uploaded_at,file.content_type,
      thumbnail.source_etag thumbnail_source_etag,thumbnail.thumbnail_key,thumbnail.thumbnail_etag,
      thumbnail.thumbnail_size,thumbnail.status thumbnail_status
    FROM image_asset_locations location
    JOIN file_index file ON file.r2_key=location.source_key
      AND trim(file.etag,'"')=location.source_etag AND file.media_kind='image'
    LEFT JOIN image_thumbnail_jobs thumbnail ON thumbnail.source_key=location.source_key
      AND trim(thumbnail.source_etag,'"')=location.source_etag
    WHERE location.status='ready' AND location.folder_prefix=?
      AND location.latitude BETWEEN -90 AND 90 AND location.longitude BETWEEN -180 AND 180
      AND NOT EXISTS (
        SELECT 1 FROM delivery_tombstones tombstone
        WHERE tombstone.restored_at IS NULL AND (
          tombstone.physical_key=location.source_key OR
          (tombstone.tombstone_kind='prefix' AND substr(location.source_key,1,length(tombstone.physical_key))=tombstone.physical_key)
        )
      )
    ORDER BY location.source_key LIMIT ?`)
    .bind(prefix, PUBLIC_LOCATION_LIMIT + 1)
    .all<LocationRow>();
  return rows.results;
}

async function locationRef(secret: string, share: Pick<ShareRow, "id" | "share_version">, prefix: string, row: Pick<LocationRow, "source_key" | "source_etag">): Promise<string> {
  return `loc_${await hmac(secret, `public-location:v1\0${share.id}\0${share.share_version}\0${prefix}\0${row.source_key}\0${row.source_etag}`)}`;
}

export async function listPublicShareLocations(env: Pick<Env, "DELIVERY_DB" | "DELIVERY_SESSION_SECRET">, share: ShareRow, folderRef = ""): Promise<DeliveryLocationCollection> {
  const prefix = locationPrefix(share, folderRef); const rows = (await currentShareLocationRows(env, share, folderRef)).filter(row => row.source_key.startsWith(prefix) && !isHiddenKey(row.source_key));
  return aggregateDeliveryLocations(await Promise.all(rows.map(async row => ({
    latitude: row.latitude,
    longitude: row.longitude,
    assetRef: await locationRef(env.DELIVERY_SESSION_SECRET, share, prefix, row),
  }))), PUBLIC_LOCATION_LIMIT);
}

export async function resolvePublicShareLocation(env: Pick<Env, "DELIVERY_DB" | "DELIVERY_SESSION_SECRET">, share: ShareRow, assetRef: string, folderRef = ""): Promise<DeliveryItem> {
  if (!LOCATION_REF_PATTERN.test(assetRef)) throw new HTTPException(404, { message: "Mapped image not found" });
  const root = normalizeRoot(share.r2_prefix), prefix = locationPrefix(share, folderRef); const rows = await currentShareLocationRows(env, share, folderRef); let row: LocationRow | undefined;
  for (const candidate of rows) {
    if (!candidate.source_key.startsWith(prefix) || isHiddenKey(candidate.source_key)) continue;
    if (constantTimeEqual(await locationRef(env.DELIVERY_SESSION_SECRET, share, prefix, candidate), assetRef)) { row = candidate; break; }
  }
  if (!row || !row.source_key.startsWith(root)) throw new HTTPException(404, { message: "Mapped image not found" });
  const relative = row.source_key.slice(root.length); const id = encodeItemRef(relative); const base = `/api/public/shares/${encodeURIComponent(share.public_id!)}/items/${id}`;
  const thumbnail = row.thumbnail_source_etag && row.thumbnail_key && row.thumbnail_status ? {
    source_etag: row.thumbnail_source_etag, thumbnail_key: row.thumbnail_key, thumbnail_etag: row.thumbnail_etag,
    thumbnail_size: row.thumbnail_size, status: row.thumbnail_status,
  } satisfies ThumbnailJobRow : undefined;
  return {
    id, name: relative.split("/").pop() || "Mapped image", kind: "image", size: row.size, uploadedAt: row.uploaded_at,
    ...thumbnailFieldsForObject(row.source_key, "image", base, row.source_etag, thumbnail, row.size, row.content_type || undefined),
    previewUrl: `${base}/source`, sourceUrl: `${base}/source`, downloadUrl: `${base}/download`,
  };
}
