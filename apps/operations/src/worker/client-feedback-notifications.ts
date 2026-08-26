import { feedbackFingerprint, readFeedbackRecord, type FeedbackRecord } from "../../../client/src/worker/client-portal/feedback-store";
import { reauthorizeFeedbackRecipient } from "../../../client/src/worker/client-portal/feedback-target";
import { sendNotificationMail, smtpNotificationsEnabled, type OutboundMail } from "./mailer";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

interface OutboxRow { id: string; notification_id: string; attempt_count: number; dispatch_fingerprint: string | null; feedback_id: string; feedback_revision: number }
export interface FeedbackNotificationDependencies {
  authorize: typeof reauthorizeFeedbackRecipient;
  send: typeof sendNotificationMail;
}
const defaults: FeedbackNotificationDependencies = { authorize: reauthorizeFeedbackRecipient, send: sendNotificationMail };
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function transportReady(env: Env): boolean {
  return smtpNotificationsEnabled(env)
    ? Boolean(env.SMTP_HOST && env.SMTP_USERNAME && env.SMTP_PASSWORD && env.SMTP_FROM)
    : Boolean(env.NOTIFICATION_EMAIL && env.NOTIFICATION_FROM);
}
function completionMail(env: Env, record: FeedbackRecord, email: string, notificationId: string): OutboundMail | null {
  try {
    const base = new URL(env.DELIVERY_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return null;
    const link = new URL(`/portal/feedback/${encodeURIComponent(record.id)}`,base);
    if (record.context.workspaceId) link.searchParams.set("workspace",record.context.workspaceId);
    // No client name, file path, feedback body or completion note leaves the
    // authenticated portal. This is a notification, not a bearer access link.
    return { to: email, fromName: "Client portal", subject: "Your feedback has been completed",
      text: `Your feedback has been marked Done. Sign in to view the response: ${link.href}`,
      html: `<p>Your feedback has been marked Done.</p><p><a href="${link.href.replaceAll("&","&amp;")}">Sign in to view the response</a></p>`,
      messageIdKey: `client-feedback:${notificationId}` };
  } catch { return null; }
}
async function finish(env: Env, row: OutboxRow, token: string, status: "sent"|"suppressed"|"failed"|"pending", code: string | null) {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const result = await db.batch([
    db.prepare(`UPDATE client_feedback_notification_outbox SET status=?,error_code=?,lease_token=NULL,lease_expires_at=NULL,
      sent_at=CASE WHEN ?='sent' THEN ${now} ELSE sent_at END,
      next_attempt_at=CASE WHEN ?='pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') ELSE next_attempt_at END,updated_at=${now}
      WHERE id=? AND status='processing' AND lease_token=?`).bind(status,code,status,status,row.id,token),
    db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
      SELECT 'system','feedback-dispatcher','client.feedback.notification_delivery','client_feedback',?,? WHERE changes()=1`)
      .bind(row.feedback_id,JSON.stringify({notificationId:row.notification_id,status,errorCode:code,attempt:row.attempt_count})),
  ]);
  return Number(result[0]?.meta.changes) === 1;
}

/** The completion transaction has already written the private in-app notice.
 * Email is bounded, at-least-once transport: a lost SMTP acknowledgement may
 * duplicate the same frozen message, never a newly composed private payload. */
export async function processClientFeedbackNotifications(env: Env, dependencies: FeedbackNotificationDependencies = defaults) {
  if (!(await d1TablesPresent(env.DELIVERY_DB,["client_feedback","client_feedback_notifications","client_feedback_notification_outbox"]))) return {processed:0};
  const db = env.DELIVERY_DB.withSession("first-primary");
  const exhausted = await db.prepare(`SELECT o.id,o.notification_id,o.attempt_count,o.dispatch_fingerprint,n.feedback_id,n.feedback_revision,o.lease_token
    FROM client_feedback_notification_outbox o JOIN client_feedback_notifications n ON n.id=o.notification_id
    WHERE o.status='processing' AND o.attempt_count>=3 AND o.lease_expires_at<=${now} ORDER BY o.lease_expires_at,o.id LIMIT 20`)
    .all<OutboxRow & {lease_token:string}>();
  for (const row of exhausted.results) await finish(env,row,row.lease_token,"failed","lease-expired");
  const candidates = await db.prepare(`SELECT o.id,o.notification_id,o.attempt_count,o.dispatch_fingerprint,n.feedback_id,n.feedback_revision
    FROM client_feedback_notification_outbox o JOIN client_feedback_notifications n ON n.id=o.notification_id
    WHERE o.attempt_count<3 AND ((o.status='pending' AND o.next_attempt_at<=${now}) OR (o.status='processing' AND o.lease_expires_at<=${now}))
    ORDER BY o.next_attempt_at,o.id LIMIT 5`).all<OutboxRow>();
  let processed = 0;
  for (const candidate of candidates.results) {
    const token = crypto.randomUUID();
    const claimed = await db.prepare(`UPDATE client_feedback_notification_outbox SET status='processing',attempt_count=attempt_count+1,
      lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),updated_at=${now}
      WHERE id=? AND attempt_count=? AND attempt_count<3 AND ((status='pending' AND next_attempt_at<=${now}) OR (status='processing' AND lease_expires_at<=${now}))`)
      .bind(token,candidate.id,candidate.attempt_count).run();
    if (Number(claimed.meta.changes) !== 1) continue;
    processed++;
    const row = {...candidate,attempt_count:candidate.attempt_count+1};
    try {
      if (!transportReady(env)) { await finish(env,row,token,"suppressed","mail-disabled"); continue; }
      const record = await readFeedbackRecord(db,row.feedback_id);
      if (!record || record.status !== "done" || record.revision !== row.feedback_revision) { await finish(env,row,token,"suppressed","feedback-unavailable"); continue; }
      const recipient = await dependencies.authorize(env,record);
      if (!recipient?.email) { await finish(env,row,token,"suppressed","recipient-unavailable"); continue; }
      const mail = completionMail(env,record,recipient.email,row.notification_id);
      if (!mail) { await finish(env,row,token,"suppressed","mail-configuration-invalid"); continue; }
      const fingerprint = await feedbackFingerprint({mail,transport:smtpNotificationsEnabled(env)?"smtp":"binding",
        from:smtpNotificationsEnabled(env)?env.SMTP_FROM:env.NOTIFICATION_FROM});
      // Re-read the committed fingerprint, not only the candidate snapshot: an
      // expired concurrent dispatcher may have published it before our claim.
      const publication = await db.prepare(`UPDATE client_feedback_notification_outbox SET dispatch_fingerprint=?,updated_at=${now}
        WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>${now}
          AND (dispatch_fingerprint IS NULL OR dispatch_fingerprint=?) AND (${recipient.authorization.guard.sql})`)
        .bind(fingerprint,row.id,token,fingerprint,...recipient.authorization.guard.bindings).run();
      if (Number(publication.meta.changes) !== 1) { await finish(env,row,token,"suppressed","delivery-context-changed"); continue; }
      await dependencies.send(env,mail);
      await finish(env,row,token,"sent",null);
    } catch {
      // Provider/SQL errors may contain credentials, recipient data or paths.
      // Persist only a bounded public error code, with token-fenced retry.
      await finish(env,row,token,row.attempt_count >= 3 ? "failed" : "pending","delivery-attempt-failed");
    }
  }
  return {processed};
}
