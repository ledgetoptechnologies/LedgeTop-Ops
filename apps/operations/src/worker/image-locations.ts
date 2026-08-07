import {
  parseImageGps,
  IMAGE_LOCATION_EXIF_MAX_BYTES,
  type ImageLocationExifResult,
} from "./image-location-exif";
import type { Env } from "./types";

export const IMAGE_LOCATION_READ_BYTES = IMAGE_LOCATION_EXIF_MAX_BYTES;
const LOCATION_LEASE_MINUTES = 5;

type LocationStatus = "pending" | "processing" | "ready" | "absent" | "invalid" | "failed";

interface LocationJobRow {
  source_etag: string;
  status: LocationStatus;
}

function cleanEtag(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

export function imageParentPrefix(sourceKey: string): string {
  const normalized = sourceKey.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0 || slash >= 999) throw new Error("Image source folder is invalid");
  return normalized.slice(0, slash + 1);
}

async function registerLocationJob(
  env: Pick<Env, "DELIVERY_DB">,
  sourceKey: string,
  sourceEtag: string,
): Promise<boolean> {
  const result = await env.DELIVERY_DB.prepare(`/* image-location.register */
    INSERT INTO image_asset_locations(source_key,source_etag,folder_prefix,status)
    SELECT ?,?,?,'pending'
    WHERE EXISTS (
      SELECT 1 FROM file_index
      WHERE r2_key=? AND trim(etag,'"')=? AND media_kind='image'
    )
    ON CONFLICT(source_key) DO UPDATE SET
      source_etag=excluded.source_etag,
      folder_prefix=excluded.folder_prefix,
      latitude=CASE WHEN image_asset_locations.source_etag=excluded.source_etag THEN image_asset_locations.latitude ELSE NULL END,
      longitude=CASE WHEN image_asset_locations.source_etag=excluded.source_etag THEN image_asset_locations.longitude ELSE NULL END,
      status=CASE WHEN image_asset_locations.source_etag=excluded.source_etag THEN image_asset_locations.status ELSE 'pending' END,
      attempt_count=CASE WHEN image_asset_locations.source_etag=excluded.source_etag THEN image_asset_locations.attempt_count ELSE 0 END,
      error_code=CASE WHEN image_asset_locations.source_etag=excluded.source_etag THEN image_asset_locations.error_code ELSE NULL END,
      lease_until=CASE WHEN image_asset_locations.source_etag=excluded.source_etag THEN image_asset_locations.lease_until ELSE NULL END,
      last_enqueued_at=CASE WHEN image_asset_locations.source_etag=excluded.source_etag THEN image_asset_locations.last_enqueued_at ELSE NULL END,
      processed_at=CASE WHEN image_asset_locations.source_etag=excluded.source_etag THEN image_asset_locations.processed_at ELSE NULL END,
      updated_at=datetime('now')
    WHERE EXISTS (
      SELECT 1 FROM file_index
      WHERE r2_key=excluded.source_key AND trim(etag,'"')=excluded.source_etag AND media_kind='image'
    )`)
    .bind(sourceKey, cleanEtag(sourceEtag), imageParentPrefix(sourceKey), sourceKey, cleanEtag(sourceEtag))
    .run();
  return result.meta.changes === 1;
}

async function sourceIsTrashed(
  env: Pick<Env, "DELIVERY_DB">,
  sourceKey: string,
): Promise<boolean> {
  const row = await env.DELIVERY_DB.prepare(`/* image-location.trashed */
    SELECT physical_key FROM delivery_tombstones WHERE restored_at IS NULL
    AND (physical_key=? OR (tombstone_kind='prefix' AND substr(?,1,length(physical_key))=physical_key)) LIMIT 1`)
    .bind(sourceKey, sourceKey)
    .first<{ physical_key: string }>();
  return Boolean(row);
}

async function claimLocationJob(
  env: Pick<Env, "DELIVERY_DB">,
  sourceKey: string,
  sourceEtag: string,
): Promise<boolean> {
  const claimed = await env.DELIVERY_DB.prepare(`/* image-location.claim */
    UPDATE image_asset_locations
    SET status='processing',attempt_count=attempt_count+1,
      error_code=NULL,lease_until=datetime('now',?),updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND (
      status IN ('pending','failed') OR
      (status='processing' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now')))
    ) RETURNING source_key`)
    .bind(`+${LOCATION_LEASE_MINUTES} minutes`, sourceKey, cleanEtag(sourceEtag))
    .first<{ source_key: string }>();
  return Boolean(claimed);
}

async function finishLocationJob(
  env: Pick<Env, "DELIVERY_DB">,
  sourceKey: string,
  sourceEtag: string,
  result: ImageLocationExifResult,
): Promise<void> {
  const ready = result.state === "ready";
  await env.DELIVERY_DB.prepare(`/* image-location.finish */
    UPDATE image_asset_locations
    SET status=?,latitude=?,longitude=?,error_code=?,lease_until=NULL,
      processed_at=datetime('now'),updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='processing'`)
    .bind(
      result.state,
      ready ? result.latitude : null,
      ready ? result.longitude : null,
      result.state === "invalid" ? "malformed_exif" : null,
      sourceKey,
      cleanEtag(sourceEtag),
    )
    .run();
}

async function failLocationJob(
  env: Pick<Env, "DELIVERY_DB">,
  sourceKey: string,
  sourceEtag: string,
  errorCode: string,
): Promise<void> {
  await env.DELIVERY_DB.prepare(`/* image-location.fail */
    UPDATE image_asset_locations
    SET status='failed',latitude=NULL,longitude=NULL,error_code=?,lease_until=NULL,updated_at=datetime('now')
    WHERE source_key=? AND source_etag=? AND status='processing'`)
    .bind(errorCode, sourceKey, cleanEtag(sourceEtag))
    .run();
}

/**
 * Extracts once for an exact live R2 version. Only a bounded prefix is read;
 * parser failures become terminal invalid metadata while storage failures retry.
 */
export async function processImageLocation(
  env: Pick<Env, "DELIVERY_DB" | "DATA_BUCKET">,
  input: { sourceKey: string; sourceEtag: string; sourceSize: number },
): Promise<"ready" | "absent" | "invalid" | "duplicate" | "obsolete"> {
  const sourceEtag = cleanEtag(input.sourceEtag);
  if (!(await registerLocationJob(env, input.sourceKey, sourceEtag))) return "obsolete";
  if (!(await claimLocationJob(env, input.sourceKey, sourceEtag))) return "duplicate";
  try {
    if (!Number.isSafeInteger(input.sourceSize) || input.sourceSize <= 0) {
      await finishLocationJob(env, input.sourceKey, sourceEtag, { state: "absent" });
      return "absent";
    }
    // Trash can race the queue claim. Re-check immediately before the only
    // source-body read and remove only this exact version's state.
    if (await sourceIsTrashed(env, input.sourceKey)) {
      await env.DELIVERY_DB.prepare("DELETE FROM image_asset_locations WHERE source_key=? AND source_etag=?")
        .bind(input.sourceKey, sourceEtag)
        .run();
      return "obsolete";
    }
    const currentIndex = await env.DELIVERY_DB.prepare(`SELECT r2_key FROM file_index
      WHERE r2_key=? AND trim(etag,'"')=? AND media_kind='image'`)
      .bind(input.sourceKey, sourceEtag)
      .first<{ r2_key: string }>();
    if (!currentIndex) {
      await env.DELIVERY_DB.prepare("DELETE FROM image_asset_locations WHERE source_key=? AND source_etag=?")
        .bind(input.sourceKey, sourceEtag)
        .run();
      return "obsolete";
    }
    const length = Math.min(input.sourceSize, IMAGE_LOCATION_READ_BYTES);
    const object = await env.DATA_BUCKET.get(input.sourceKey, {
      range: { offset: 0, length },
      onlyIf: { etagMatches: sourceEtag },
    });
    if (!object || !("body" in object) || !object.body || cleanEtag(object.httpEtag) !== sourceEtag)
      throw new Error("The image changed before location extraction");
    const parsed = parseImageGps(new Uint8Array(await object.arrayBuffer()));
    await finishLocationJob(env, input.sourceKey, sourceEtag, parsed);
    return parsed.state;
  } catch (error) {
    await failLocationJob(env, input.sourceKey, sourceEtag, "location_read_failed");
    throw error;
  }
}

export async function deleteImageLocation(
  env: Pick<Env, "DELIVERY_DB">,
  sourceKey: string,
  sourceEtag?: string,
): Promise<void> {
  await env.DELIVERY_DB.prepare(sourceEtag
    ? "DELETE FROM image_asset_locations WHERE source_key=? AND source_etag=?"
    : "DELETE FROM image_asset_locations WHERE source_key=?")
    .bind(...(sourceEtag ? [sourceKey, cleanEtag(sourceEtag)] : [sourceKey]))
    .run();
}

export async function enqueueImageLocationJob(
  env: Env,
  input: { sourceKey: string; sourceEtag: string },
): Promise<boolean> {
  const sourceEtag = cleanEtag(input.sourceEtag);
  if (!(await registerLocationJob(env, input.sourceKey, sourceEtag))) return false;
  await env.THUMBNAIL_QUEUE.send({
    kind: "image-thumbnail.v1",
    sourceKey: input.sourceKey,
    sourceEtag,
  });
  await env.DELIVERY_DB.prepare(`UPDATE image_asset_locations
    SET last_enqueued_at=datetime('now'),updated_at=datetime('now')
    WHERE source_key=? AND source_etag=?`)
    .bind(input.sourceKey, sourceEtag)
    .run();
  return true;
}

/** Bounded rollout/backfill for image versions that predate the migration. */
export async function enqueueImageLocationBackfill(env: Env, limit = 25): Promise<number> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 25;
  const candidates = await env.DELIVERY_DB.prepare(`/* image-location.backfill */
    SELECT f.r2_key,f.etag,f.size
    FROM file_index f
    LEFT JOIN image_asset_locations location ON location.source_key=f.r2_key
    WHERE f.media_kind='image'
      AND f.r2_key NOT LIKE '_ltds/%' AND f.r2_key NOT LIKE '%/_ltds/%'
      AND f.r2_key NOT LIKE '.previews/%' AND f.r2_key NOT LIKE '%/.previews/%'
      AND f.r2_key NOT LIKE 'dump/%' AND f.r2_key NOT LIKE '%/dump/%'
      AND NOT EXISTS (
        SELECT 1 FROM delivery_tombstones tombstone
        WHERE tombstone.restored_at IS NULL AND (
          tombstone.physical_key=f.r2_key OR
          (tombstone.tombstone_kind='prefix' AND substr(f.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)
        )
      )
      AND (
        location.source_key IS NULL OR location.source_etag<>trim(f.etag,'"') OR
        location.status='failed' OR
        (location.status IN ('pending','processing') AND (
          location.last_enqueued_at IS NULL OR datetime(location.last_enqueued_at)<=datetime('now','-30 minutes')
        ))
      )
    ORDER BY f.r2_key LIMIT ?`)
    .bind(boundedLimit)
    .all<{ r2_key: string; etag: string; size: number }>();
  let enqueued = 0;
  for (const row of candidates.results) {
    try {
      if (await enqueueImageLocationJob(env, { sourceKey: row.r2_key, sourceEtag: row.etag })) enqueued += 1;
    } catch (error) {
      await env.DELIVERY_DB.prepare(`UPDATE image_asset_locations
        SET status='failed',error_code='queue_publish_failed',lease_until=NULL,updated_at=datetime('now')
        WHERE source_key=? AND source_etag=? AND status<>'ready'`)
        .bind(row.r2_key, cleanEtag(row.etag)).run();
      console.error(JSON.stringify({
        event: "image-location.backfill-enqueue-failed",
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }));
    }
  }
  return enqueued;
}

export async function currentLocationStatus(
  env: Pick<Env, "DELIVERY_DB">,
  sourceKey: string,
): Promise<LocationJobRow | null> {
  return env.DELIVERY_DB.prepare("SELECT source_etag,status FROM image_asset_locations WHERE source_key=?")
    .bind(sourceKey)
    .first<LocationJobRow>();
}
