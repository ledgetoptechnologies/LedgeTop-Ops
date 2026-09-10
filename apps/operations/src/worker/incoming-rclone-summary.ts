import type { IncomingEnv } from "./incoming";

export type IncomingRclonePromotionSummary = "pending" | "copying" | "publishing" | "ready" | "failed" | "unavailable";

/** Project only authorized upload IDs. Callers must never pass client input. */
export async function summarizeIncomingRclonePromotions(env: IncomingEnv, authorizedUploadIds: readonly string[]): Promise<Map<string, IncomingRclonePromotionSummary>> {
  if (env.INCOMING_RCLONE_PROMOTION_ENABLED !== "true") return new Map();
  const ids = [...new Set(authorizedUploadIds)].filter(id => /^[A-Za-z0-9_-]{8,200}$/.test(id)).slice(0, 50);
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT ids.upload_id uploadId,
    CASE WHEN j.state IN ('ready','failed','unavailable','publishing') THEN j.state
      WHEN EXISTS(SELECT 1 FROM file_request_upload_promotion_outbox o WHERE o.upload_id=ids.upload_id AND o.state='needs_attention') THEN 'failed'
      WHEN j.state IN ('pending','copying') THEN j.state
      WHEN EXISTS(SELECT 1 FROM file_request_upload_promotion_outbox o WHERE o.upload_id=ids.upload_id) THEN 'pending'
      ELSE NULL END state
    FROM (SELECT id upload_id FROM file_request_uploads WHERE id IN (${placeholders})) ids
    LEFT JOIN file_request_upload_promotion_journal j ON j.upload_id=ids.upload_id`).bind(...ids).all<{ uploadId: string; state: IncomingRclonePromotionSummary | null }>();
  return new Map(rows.results.flatMap(row => row.state ? [[row.uploadId, row.state] as const] : []));
}
