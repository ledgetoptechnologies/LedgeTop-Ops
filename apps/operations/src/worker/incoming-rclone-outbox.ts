import { dispatchIncomingRcloneSegment, type IncomingPromotionSegment } from "./incoming-rclone-dispatch";
import type { IncomingEnv } from "./incoming";

const LIMIT = 10, LEASE_SECONDS = 120, MAX_ATTEMPTS = 3;
type WorkflowBinding = Pick<Workflow<IncomingPromotionSegment>, "create" | "get">;
type Job = { uploadId: string; segment: number; consecutiveFailures: number; attemptCount: number; leaseToken: string | null };
export type IncomingOutboxResult = { enqueued: boolean; reason?: "disabled" | "not_eligible" };

function enabled(env: IncomingEnv): boolean { return env.INCOMING_RCLONE_PROMOTION_ENABLED === "true"; }
function valid(input: IncomingPromotionSegment): void {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(input.uploadId) || !Number.isInteger(input.segment) || input.segment < 0 || input.segment > 2000 || !Number.isInteger(input.consecutiveFailures) || input.consecutiveFailures < 0 || input.consecutiveFailures > 3) throw new Error("incoming_promotion_invalid_segment");
}
/** Durable intent only; callers must drain separately. Gate false means no D1 access. */
export async function enqueueIncomingRcloneSegment(env: IncomingEnv, input: IncomingPromotionSegment): Promise<IncomingOutboxResult> {
  if (!enabled(env)) return { enqueued: false, reason: "disabled" };
  valid(input);
  const result = await env.DELIVERY_DB.prepare(`INSERT INTO file_request_upload_promotion_outbox(upload_id,segment,consecutive_failures,state)
    SELECT u.id,?,?,'pending' FROM file_request_uploads u JOIN file_requests r ON r.id=u.request_id
    WHERE u.id=? AND u.status='quarantined' AND u.verification_state<>'rejected' AND r.revoked_at IS NULL
      AND datetime(r.expires_at)>datetime('now') AND datetime(u.created_at,'+14 days')>datetime('now')
    ON CONFLICT(upload_id,segment) DO NOTHING`).bind(input.segment, input.consecutiveFailures, input.uploadId).run();
  return result.meta.changes ? { enqueued: true } : { enqueued: false, reason: "not_eligible" };
}
async function lease(env: IncomingEnv): Promise<Job[]> {
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT upload_id uploadId,segment,consecutive_failures consecutiveFailures,attempt_count attemptCount
    FROM file_request_upload_promotion_outbox WHERE (state='pending' AND (next_attempt_at IS NULL OR datetime(next_attempt_at)<=datetime('now')))
      OR (state='leased' AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at)<=datetime('now')) ORDER BY created_at LIMIT ?`).bind(LIMIT).all<Omit<Job,"leaseToken">>();
  const leased: Job[] = [];
  for (const row of rows.results) { const token = crypto.randomUUID(); const changed = await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_outbox SET state='leased',lease_token=?,lease_expires_at=datetime('now','+${LEASE_SECONDS} seconds'),updated_at=datetime('now') WHERE upload_id=? AND segment=? AND ((state='pending' AND (next_attempt_at IS NULL OR datetime(next_attempt_at)<=datetime('now'))) OR (state='leased' AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at)<=datetime('now')))`)
      .bind(token,row.uploadId,row.segment).run(); if (changed.meta.changes) leased.push({ ...row, leaseToken: token }); }
  return leased;
}
async function stillEligible(env: IncomingEnv, job: Job): Promise<boolean> {
  return Boolean(await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT u.id FROM file_request_uploads u JOIN file_requests r ON r.id=u.request_id
    WHERE u.id=? AND u.status='quarantined' AND u.verification_state<>'rejected' AND r.revoked_at IS NULL AND datetime(r.expires_at)>datetime('now') AND datetime(u.created_at,'+14 days')>datetime('now')`).bind(job.uploadId).first());
}
/** Dispatch at most ten durable intents. A dispatched job is never restarted by this drainer. */
export async function drainIncomingRcloneOutbox(env: IncomingEnv, workflow?: WorkflowBinding): Promise<{ dispatched: number; retrying: number; attention: number }> {
  if (!enabled(env)) return { dispatched: 0, retrying: 0, attention: 0 };
  const binding = workflow ?? env.INCOMING_RCLONE_PROMOTION_WORKFLOW;
  if (!binding) throw new Error("incoming_promotion_binding_missing");
  let dispatched=0,retrying=0,attention=0;
  for (const job of await lease(env)) try {
    if (!await stillEligible(env, job)) {
      await env.DELIVERY_DB.prepare("UPDATE file_request_upload_promotion_outbox SET state='needs_attention',error_code='dispatch_not_eligible',lease_token=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE upload_id=? AND segment=? AND state='leased' AND lease_token=?").bind(job.uploadId,job.segment,job.leaseToken).run(); attention++; continue;
    }
    const outcome = await dispatchIncomingRcloneSegment(binding, { uploadId: job.uploadId, segment: job.segment, consecutiveFailures: job.consecutiveFailures });
    await env.DELIVERY_DB.prepare("UPDATE file_request_upload_promotion_outbox SET state='dispatched',instance_id=?,lease_token=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=datetime('now') WHERE upload_id=? AND segment=? AND state='leased' AND lease_token=?").bind(outcome.id,job.uploadId,job.segment,job.leaseToken).run(); dispatched++;
  } catch {
    const terminal = job.attemptCount + 1 >= MAX_ATTEMPTS;
    await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_outbox SET state=?,attempt_count=attempt_count+1,error_code='dispatch_unconfirmed',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=${terminal ? "NULL" : "datetime('now','+5 minutes')"},updated_at=datetime('now') WHERE upload_id=? AND segment=? AND state='leased' AND lease_token=?`).bind(terminal ? "needs_attention" : "pending",job.uploadId,job.segment,job.leaseToken).run(); terminal ? attention++ : retrying++;
  }
  return { dispatched,retrying,attention };
}
/** Bounded eligibility discovery for explicit backfill schedulers; no R2 reads. */
export async function backfillIncomingRcloneOutbox(env: IncomingEnv, limit = LIMIT): Promise<number> {
  if (!enabled(env)) return 0; const bounded = Math.max(1,Math.min(LIMIT,limit));
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT u.id FROM file_request_uploads u JOIN file_requests r ON r.id=u.request_id LEFT JOIN file_request_upload_promotion_outbox o ON o.upload_id=u.id AND o.segment=0
    WHERE o.upload_id IS NULL AND u.status='quarantined' AND u.verification_state<>'rejected' AND r.revoked_at IS NULL AND datetime(r.expires_at)>datetime('now') AND datetime(u.created_at,'+14 days')>datetime('now') ORDER BY u.created_at,u.id LIMIT ?`).bind(bounded).all<{id:string}>();
  let count=0; for (const row of rows.results) if ((await enqueueIncomingRcloneSegment(env,{uploadId:row.id,segment:0,consecutiveFailures:0})).enqueued) count++; return count;
}
