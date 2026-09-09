/**
 * Conservative cleanup companion for incoming-rclone-promotion.  It is called
 * only after the existing lifecycle has durably changed an upload to expired.
 * R2's binding has no conditional delete, so this module never deletes ready/
 * even after a matching HEAD: a replacement between HEAD and delete would be
 * indistinguishable and could destroy another publisher's object.
 */
import type { IncomingEnv } from "./incoming";

type Journal = { state: string; destinationKey: string; multipartUploadId: string | null; destinationEtag: string | null; destinationBytes: number | null; destinationVersion: string | null };
export type IncomingPromotionRetentionResult =
  | { kind: "not_expired" | "no_journal" | "ready_missing" | "ready_retained" | "multipart_aborted" }
  | { kind: "needs_review"; reason: "publishing_uncertain" | "destination_proof_missing" | "destination_changed" | "conditional_delete_unavailable" | "multipart_abort_failed" };

async function current(env: IncomingEnv, uploadId: string): Promise<{ status: string } | null> {
  return env.DELIVERY_DB.withSession("first-primary").prepare("SELECT status FROM file_request_uploads WHERE id=?").bind(uploadId).first<{ status: string }>();
}
async function journal(env: IncomingEnv, uploadId: string): Promise<Journal | null> {
  return env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT state,destination_key destinationKey,multipart_upload_id multipartUploadId,
    destination_etag destinationEtag,destination_bytes destinationBytes,destination_version destinationVersion
    FROM file_request_upload_promotion_journal WHERE upload_id=?`).bind(uploadId).first<Journal>();
}
function destinationMatches(object: R2Object, row: Journal): boolean {
  return row.destinationEtag !== null && row.destinationBytes !== null && row.destinationVersion !== null
    && object.etag.toLowerCase() === row.destinationEtag.toLowerCase() && object.size === row.destinationBytes && object.version === row.destinationVersion;
}

/**
 * Retire promotion work after `file_request_uploads.status` is already
 * `expired`. Correct lifecycle ordering is: (1) atomically expire the upload,
 * (2) invoke this helper to fence/abort promotion multipart work, then (3)
 * perform the existing quarantine-source deletion.  This helper never marks an
 * upload accepted and never infers that a missing ready object was delivered.
 */
export async function cleanupIncomingRclonePromotionRetention(env: IncomingEnv, uploadId: string): Promise<IncomingPromotionRetentionResult> {
  const upload = await current(env, uploadId);
  if (!upload || upload.status !== "expired") return { kind: "not_expired" };
  const row = await journal(env, uploadId);
  if (!row) return { kind: "no_journal" };

  if (row.state === "ready") {
    const object = await env.INCOMING_BUCKET.head(row.destinationKey);
    if (!object) return { kind: "ready_missing" }; // rclone MOVE is normal, not delivery evidence.
    if (!destinationMatches(object, row)) return { kind: "needs_review", reason: row.destinationEtag ? "destination_changed" : "destination_proof_missing" };
    // Physical expiration is exclusively R2 lifecycle policy. This is a
    // successful retention outcome, never a Worker-side ready delete.
    return { kind: "ready_retained" };
  }
  if (row.state === "publishing") return { kind: "needs_review", reason: "publishing_uncertain" };

  // Set the terminal pre-publication fence before abort. A copy already in
  // flight can finish its R2 call, but cannot persist a part or pass the
  // promotion's final status CAS after this transition.
  await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET state='unavailable',error_code='retention_expired',updated_at=datetime('now')
    WHERE upload_id=? AND state IN ('pending','copying','failed')`).bind(uploadId).run();
  if (!row.multipartUploadId) return { kind: "multipart_aborted" };
  try {
    await env.INCOMING_BUCKET.resumeMultipartUpload(row.destinationKey, row.multipartUploadId).abort();
    return { kind: "multipart_aborted" };
  } catch { return { kind: "needs_review", reason: "multipart_abort_failed" }; }
}

type Due = { uploadId: string };
export type IncomingRcloneRetentionRun = { processed: number; completed: number; retrying: number };

/** Bounded maintenance; gate false performs no D1/R2 access. */
export async function runIncomingRcloneRetention(env: IncomingEnv): Promise<IncomingRcloneRetentionRun> {
  if (env.INCOMING_RCLONE_PROMOTION_ENABLED !== "true") return { processed: 0, completed: 0, retrying: 0 };
  const due = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT j.upload_id uploadId FROM file_request_upload_promotion_journal j
    JOIN file_request_uploads u ON u.id=j.upload_id WHERE j.retention_completed_at IS NULL AND u.status IN ('quarantined','rejected','expired')
      AND datetime(u.created_at,'+14 days')<=datetime('now') AND (j.retention_checked_at IS NULL OR datetime(j.retention_checked_at)<=datetime('now','-5 minutes'))
    ORDER BY (j.retention_checked_at IS NOT NULL),j.retention_checked_at,j.upload_id LIMIT 10`).all<Due>();
  let processed=0,completed=0,retrying=0;
  for (const row of due.results) {
    const claimed = await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET retention_checked_at=datetime('now'),updated_at=datetime('now')
      WHERE upload_id=? AND retention_completed_at IS NULL AND (retention_checked_at IS NULL OR datetime(retention_checked_at)<=datetime('now','-5 minutes'))`).bind(row.uploadId).run();
    if (!claimed.meta.changes) continue;
    processed++;
    // This is the durable expiry fence. It cannot touch accepted rows and the
    // quota trigger fires only when quota_released_at was previously NULL.
    await env.DELIVERY_DB.prepare(`UPDATE file_request_uploads SET status='expired',quota_released_at=COALESCE(quota_released_at,datetime('now')),quota_release_managed=1,updated_at=datetime('now')
      WHERE id=? AND status IN ('quarantined','rejected','expired')
        AND datetime(created_at,'+14 days')<=datetime('now')`).bind(row.uploadId).run();
    const result = await cleanupIncomingRclonePromotionRetention(env, row.uploadId);
    if (["no_journal","ready_retained","ready_missing","multipart_aborted"].includes(result.kind)) {
      await env.DELIVERY_DB.prepare("UPDATE file_request_upload_promotion_journal SET retention_completed_at=datetime('now'),updated_at=datetime('now') WHERE upload_id=? AND retention_completed_at IS NULL").bind(row.uploadId).run(); completed++;
    } else retrying++;
  }
  return { processed, completed, retrying };
}
