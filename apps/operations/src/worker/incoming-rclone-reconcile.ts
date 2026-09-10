import type { IncomingPromotionSegment } from "./incoming-rclone-dispatch";
import type { IncomingEnv } from "./incoming";

const LIMIT = 10;
type Binding = Pick<Workflow<IncomingPromotionSegment>, "get">;
type Row = { uploadId: string; segment: number; instanceId: string | null };
export type IncomingReconcileResult = { inspected: number; actionable: number; transportFailures: number; skipped: number };

function enabled(env: IncomingEnv): boolean { return env.INCOMING_RCLONE_PROMOTION_ENABLED === "true"; }
function authoritativeFailure(status: string): string | null {
  return status === "errored" || status === "terminated" || status === "paused" ? `workflow_${status}` : null;
}

/**
 * Inspect only the latest dispatched segment for an upload. This never creates,
 * restarts, or requeues a workflow. A status-read failure is intentionally
 * retryable; only an authoritative terminal workflow status becomes actionable.
 */
export async function reconcileIncomingRcloneDispatched(env: IncomingEnv, workflow?: Binding): Promise<IncomingReconcileResult> {
  if (!enabled(env)) return { inspected: 0, actionable: 0, transportFailures: 0, skipped: 0 };
  const binding = workflow ?? env.INCOMING_RCLONE_PROMOTION_WORKFLOW;
  if (!binding) throw new Error("incoming_promotion_binding_missing");
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT o.upload_id uploadId,o.segment,o.instance_id instanceId
    FROM file_request_upload_promotion_outbox o LEFT JOIN file_request_upload_promotion_outbox newer ON newer.upload_id=o.upload_id AND newer.segment>o.segment
    LEFT JOIN file_request_upload_promotion_journal j ON j.upload_id=o.upload_id
    WHERE o.state='dispatched' AND newer.upload_id IS NULL AND o.instance_id IS NOT NULL
      AND (j.upload_id IS NULL OR j.state IN ('pending','copying')) ORDER BY (o.last_checked_at IS NOT NULL),COALESCE(o.last_checked_at,o.created_at),o.upload_id,o.segment LIMIT ?`).bind(LIMIT).all<Row>();
  let inspected=0,actionable=0,transportFailures=0,skipped=0;
  for (const row of rows.results) {
    inspected++;
    try {
      const state = await (await binding.get(row.instanceId!)).status();
      const reason = authoritativeFailure(state.status);
      if (!reason) {
        await env.DELIVERY_DB.prepare("UPDATE file_request_upload_promotion_outbox SET last_checked_at=datetime('now') WHERE upload_id=? AND segment=? AND state='dispatched' AND instance_id=?")
          .bind(row.uploadId,row.segment,row.instanceId).run();
        skipped++; continue;
      }
      const changed = await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_outbox SET state='needs_attention',error_code=?,updated_at=datetime('now')
        WHERE upload_id=? AND segment=? AND state='dispatched' AND instance_id=?
          AND NOT EXISTS (SELECT 1 FROM file_request_upload_promotion_outbox newer WHERE newer.upload_id=? AND newer.segment>?)
          AND NOT EXISTS (SELECT 1 FROM file_request_upload_promotion_journal j WHERE j.upload_id=? AND j.state NOT IN ('pending','copying'))`)
        .bind(reason,row.uploadId,row.segment,row.instanceId,row.uploadId,row.segment,row.uploadId).run();
      if (changed.meta.changes) actionable++; else skipped++;
    } catch {
      // Move a transport failure to the back of the fair queue without
      // changing its dispatched state or treating it as workflow failure.
      await env.DELIVERY_DB.prepare("UPDATE file_request_upload_promotion_outbox SET last_checked_at=datetime('now') WHERE upload_id=? AND segment=? AND state='dispatched' AND instance_id=?")
        .bind(row.uploadId,row.segment,row.instanceId).run();
      transportFailures++;
    }
  }
  return { inspected, actionable, transportFailures, skipped };
}
