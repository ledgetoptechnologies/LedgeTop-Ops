import { isMovedSourceMarker } from "@ltds/shared";
import {
  THUMBNAIL_MAX_OUTPUT_BYTES,
  canonicalThumbnailSourceKey,
  thumbnailObjectKey,
  thumbnailSourceKind,
  thumbnailSourceWithinInputLimit,
} from "./image-thumbnails";
import { THUMBNAIL_RENDER_PROFILE } from "./thumbnail-renderer-contract";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

const PAGE_LIMIT = 25;
const MAX_RUN_ATTEMPTS = 8;

interface RecoveryRun {
  cursor: string | null;
  cutoff_at: string;
  attempt_count: number;
}

interface RecoveryCandidate {
  source_key: string;
  source_etag: string;
  source_size: number;
  status: "failed" | "ready";
  error_code: string | null;
  thumbnail_key: string;
  thumbnail_etag: string | null;
  thumbnail_size: number | null;
  thumbnail_provider: "ltds-truenas" | "cloudflare-container" | null;
  thumbnail_profile: string | null;
  thumbnail_manifest_key: string | null;
  thumbnail_manifest_etag: string | null;
  attempt_count: number;
  updated_at: string;
}

function cleanEtag(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Legacy video thumbnail recovery failed")
    .replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

async function readyThumbnailIsUsable(env: Env, row: RecoveryCandidate): Promise<boolean> {
  const thumbnailEtag = cleanEtag(row.thumbnail_etag || "");
  if (!thumbnailEtag || !row.thumbnail_size || row.thumbnail_size <= 0 ||
    row.thumbnail_size > THUMBNAIL_MAX_OUTPUT_BYTES) return false;
  const thumbnail = await env.DATA_BUCKET.head(row.thumbnail_key);
  if (!thumbnail || cleanEtag(thumbnail.httpEtag) !== thumbnailEtag ||
    thumbnail.size !== row.thumbnail_size || thumbnail.httpMetadata?.contentType !== "image/webp") return false;

  if (row.thumbnail_provider === "ltds-truenas" && row.thumbnail_profile === THUMBNAIL_RENDER_PROFILE) {
    if (!row.thumbnail_manifest_key || !row.thumbnail_manifest_etag) return false;
    const manifest = await env.DATA_BUCKET.head(row.thumbnail_manifest_key);
    return Boolean(manifest && cleanEtag(manifest.httpEtag) === cleanEtag(row.thumbnail_manifest_etag) &&
      manifest.size > 0 && manifest.httpMetadata?.contentType === "application/json");
  }
  const managed = (row.thumbnail_provider === "cloudflare-container" && row.thumbnail_profile === THUMBNAIL_RENDER_PROFILE) ||
    (!row.thumbnail_provider && !row.thumbnail_profile);
  return managed && cleanEtag(thumbnail.customMetadata?.sourceEtag || "") === cleanEtag(row.source_etag);
}

async function resetCandidate(env: Env, row: RecoveryCandidate, thumbnailKey: string, cutoffAt: string,
  claimToken: string): Promise<boolean> {
  const sharedSet = `status='pending',thumbnail_key=?,thumbnail_etag=NULL,thumbnail_size=NULL,
    attempt_count=0,error_code=NULL,error_message=NULL,lease_until=NULL,ready_at=NULL,
    failed_at=NULL,dead_lettered_at=NULL,queue_published_at=NULL,thumbnail_provider=NULL,
    thumbnail_profile=NULL,thumbnail_manifest_key=NULL,thumbnail_manifest_etag=NULL,updated_at=datetime('now')`;
  const statement = row.status === "failed"
    ? env.DELIVERY_DB.prepare(`/* thumbnail.legacy-video-reset-failed */
        UPDATE image_thumbnail_jobs SET ${sharedSet}
        WHERE source_key=? AND source_etag=? AND source_size=? AND status='failed'
          AND error_code=? AND attempt_count=? AND COALESCE(thumbnail_key,'')=?
          AND COALESCE(thumbnail_etag,'')=? AND COALESCE(thumbnail_size,-1)=?
          AND COALESCE(thumbnail_provider,'')=? AND COALESCE(thumbnail_profile,'')=?
          AND COALESCE(thumbnail_manifest_key,'')=? AND COALESCE(thumbnail_manifest_etag,'')=?
          AND updated_at=? AND datetime(updated_at)<=datetime(?)
          AND EXISTS (SELECT 1 FROM legacy_video_thumbnail_recovery r WHERE r.singleton=1
            AND r.status='running' AND r.claim_token=? AND datetime(r.lease_until)>datetime('now'))`)
      .bind(thumbnailKey, row.source_key, cleanEtag(row.source_etag), row.source_size,
        row.error_code, row.attempt_count, row.thumbnail_key, row.thumbnail_etag || "", row.thumbnail_size ?? -1,
        row.thumbnail_provider || "", row.thumbnail_profile || "", row.thumbnail_manifest_key || "",
        row.thumbnail_manifest_etag || "", row.updated_at, cutoffAt, claimToken)
    : env.DELIVERY_DB.prepare(`/* thumbnail.legacy-video-reset-ready */
        UPDATE image_thumbnail_jobs SET ${sharedSet}
        WHERE source_key=? AND source_etag=? AND source_size=? AND status='ready'
          AND thumbnail_key=? AND COALESCE(thumbnail_etag,'')=? AND COALESCE(thumbnail_size,-1)=?
          AND attempt_count=? AND COALESCE(thumbnail_provider,'')=? AND COALESCE(thumbnail_profile,'')=?
          AND COALESCE(thumbnail_manifest_key,'')=? AND COALESCE(thumbnail_manifest_etag,'')=?
          AND updated_at=?
          AND datetime(updated_at)<=datetime(?)
          AND EXISTS (SELECT 1 FROM legacy_video_thumbnail_recovery r WHERE r.singleton=1
            AND r.status='running' AND r.claim_token=? AND datetime(r.lease_until)>datetime('now'))`)
      .bind(thumbnailKey, row.source_key, cleanEtag(row.source_etag), row.source_size,
        row.thumbnail_key, row.thumbnail_etag || "", row.thumbnail_size ?? -1, row.attempt_count,
        row.thumbnail_provider || "", row.thumbnail_profile || "", row.thumbnail_manifest_key || "",
        row.thumbnail_manifest_etag || "", row.updated_at, cutoffAt, claimToken);
  // Retirement triggers may add cleanup rows for stale thumbnail/manifest
  // artifacts, so D1 can report more than one changed row for one successful
  // source CAS.
  return Number((await statement.run()).meta.changes || 0) > 0;
}

/**
 * Repair only historical, exact-current video rows. Reset rows stay pending in
 * D1 for the authenticated TrueNAS `/claim` worker; no Cloudflare queue message
 * is published, so the image/PDF Container consumer never receives them.
 */
export async function processLegacyVideoThumbnailRecovery(env: Env, limit = PAGE_LIMIT): Promise<number> {
  if (!(await d1TablesPresent(env.DELIVERY_DB, ["legacy_video_thumbnail_recovery"]))) return 0;
  const run = await env.DELIVERY_DB.prepare(`SELECT cursor,cutoff_at,attempt_count
    FROM legacy_video_thumbnail_recovery
    WHERE singleton=1 AND (status='queued' OR (status='running' AND
      (lease_until IS NULL OR datetime(lease_until)<=datetime('now'))))`).first<RecoveryRun>();
  if (!run) return 0;
  const claimToken = crypto.randomUUID();
  const claimed = await env.DELIVERY_DB.prepare(`UPDATE legacy_video_thumbnail_recovery
    SET status='running',attempt_count=attempt_count+1,lease_until=datetime('now','+5 minutes'),
      claim_token=?,
      started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now')
    WHERE singleton=1 AND (status='queued' OR (status='running' AND
      (lease_until IS NULL OR datetime(lease_until)<=datetime('now'))))`).bind(claimToken).run();
  if (claimed.meta.changes !== 1) return 0;

  const boundedLimit = Math.max(1, Math.min(50, limit));
  try {
    const rows = await env.DELIVERY_DB.prepare(`/* thumbnail.legacy-video-page */
      SELECT j.source_key,j.source_etag,j.source_size,j.status,j.error_code,j.thumbnail_key,
        j.thumbnail_etag,j.thumbnail_size,j.thumbnail_provider,j.thumbnail_profile,
        j.thumbnail_manifest_key,j.thumbnail_manifest_etag,j.attempt_count,j.updated_at
      FROM image_thumbnail_jobs j
      JOIN file_index f ON f.r2_key=j.source_key
        AND trim(f.etag,'"')=trim(j.source_etag,'"') AND f.size=j.source_size
      WHERE j.source_key LIKE 'Jobs/%' AND j.source_key>COALESCE(?,'')
        AND f.media_kind='video' AND datetime(j.updated_at)<=datetime(?)
        AND ((j.status='failed' AND j.error_code IN ('unsupported_file','source_changed')) OR j.status='ready')
        AND NOT EXISTS (SELECT 1 FROM delivery_tombstones t WHERE t.restored_at IS NULL AND (
          (t.tombstone_kind='exact' AND t.physical_key=j.source_key) OR
          (t.tombstone_kind='prefix' AND substr(j.source_key,1,length(t.physical_key))=t.physical_key)))
      ORDER BY j.source_key LIMIT ?`)
      .bind(run.cursor, run.cutoff_at, boundedLimit).all<RecoveryCandidate>();

    let recovered = 0;
    let skipped = 0;
    for (const row of rows.results) {
      const source = canonicalThumbnailSourceKey(row.source_key) ? await env.DATA_BUCKET.head(row.source_key) : null;
      const kind = source ? thumbnailSourceKind(row.source_key, source.httpMetadata?.contentType) : null;
      const current = Boolean(source && !isMovedSourceMarker(source) && kind === "video" &&
        cleanEtag(source.httpEtag) === cleanEtag(row.source_etag) && source.size === row.source_size &&
        thumbnailSourceWithinInputLimit("video", source.size));
      if (!current || (row.status === "ready" && await readyThumbnailIsUsable(env, row))) {
        skipped += 1;
        continue;
      }
      const expectedThumbnailKey = await thumbnailObjectKey(row.source_key, row.source_etag);
      if (await resetCandidate(env, row, expectedThumbnailKey, run.cutoff_at, claimToken)) recovered += 1;
      else skipped += 1;
    }

    const complete = rows.results.length < boundedLimit;
    const cursor = rows.results.at(-1)?.source_key || run.cursor;
    const finalized = await env.DELIVERY_DB.prepare(`UPDATE legacy_video_thumbnail_recovery SET
      cursor=?,scanned_count=scanned_count+?,recovered_count=recovered_count+?,
      skipped_count=skipped_count+?,attempt_count=0,status=?,lease_until=NULL,error_code=NULL,
      claim_token=NULL,
      error_message=NULL,completed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,
      updated_at=datetime('now') WHERE singleton=1 AND status='running' AND claim_token=?
        AND datetime(lease_until)>datetime('now')`)
      .bind(cursor, rows.results.length, recovered, skipped, complete ? "completed" : "queued", complete, claimToken).run();
    if (finalized.meta.changes !== 1) return 0;
    return recovered;
  } catch (error) {
    const terminal = run.attempt_count + 1 >= MAX_RUN_ATTEMPTS;
    await env.DELIVERY_DB.prepare(`UPDATE legacy_video_thumbnail_recovery SET status=?,lease_until=NULL,claim_token=NULL,
      error_code=?,error_message=?,completed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,
      updated_at=datetime('now') WHERE singleton=1 AND status='running' AND claim_token=?
        AND datetime(lease_until)>datetime('now')`)
      .bind(terminal ? "failed" : "queued", terminal ? "legacy_video_recovery_exhausted" : "legacy_video_recovery_retry",
        safeError(error), terminal, claimToken).run();
    return 0;
  }
}
