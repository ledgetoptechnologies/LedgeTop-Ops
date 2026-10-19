import type { Env } from "./types";
import { readClientOnboardingNotificationRecipient } from "./client-onboarding-review";
import { sendNotificationMail, validateNotificationMailTransport, notificationMailFailureCode,
  type OutboundMail } from "./mailer";

export const CLIENT_ONBOARDING_NOTIFICATION_CRON = "11-56/15 * * * *";
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const BATCH = 8;
type Checkpoint = { revision: number; last_submission_id: string; last_staff_id: string };
type Recipient = { submission_id: string; staff_id: string; recipient_email: string;
  admission_version: number; profile_version: number; version: number; attempt_count: number };
export type ClientOnboardingNotificationConfiguration = Readonly<{ enabled: boolean; notBefore: string; staffIds: readonly string[]; reviewOrigin: string }>;

export function clientOnboardingNotificationConfiguration(env: Pick<Env,
  "CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED" | "CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE"
  | "CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS" | "CLIENT_ONBOARDING_ADMIN_ORIGIN">): ClientOnboardingNotificationConfiguration | null {
  if (env.CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED !== "true") return null;
  try {
    const origin = new URL(env.CLIENT_ONBOARDING_ADMIN_ORIGIN ?? "");
    const cutoff = env.CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE ?? "";
    const ids: unknown = JSON.parse(env.CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS ?? "[]");
    if (origin.protocol !== "https:" || origin.origin !== env.CLIENT_ONBOARDING_ADMIN_ORIGIN || origin.port
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)
      || !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString() !== cutoff
      || !Array.isArray(ids) || ids.length < 1 || ids.length > 16
      || !ids.every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/.test(id))
      || new Set(ids).size !== ids.length || ids.some(id => /\p{C}/u.test(id))) throw Error();
    return Object.freeze({ enabled: true, notBefore: cutoff, staffIds: Object.freeze([...ids]), reviewOrigin: origin.origin });
  } catch { throw Error("client_onboarding_notification_configuration_invalid"); }
}

async function checkpoint(db: D1DatabaseSession, phase: "fanout" | "delivery"): Promise<Checkpoint> {
  const row = await db.prepare("SELECT revision,last_submission_id,last_staff_id FROM client_onboarding_notification_scan_checkpoints WHERE phase=?")
    .bind(phase).first<Checkpoint>();
  if (!row) throw Error("client_onboarding_notification_schema_unavailable");
  return row;
}
async function advance(db: D1DatabaseSession, phase: "fanout" | "delivery", old: Checkpoint, submissionId: string, staffId = "") {
  await db.prepare(`UPDATE client_onboarding_notification_scan_checkpoints SET revision=revision+1,last_submission_id=?,last_staff_id=?
    WHERE phase=? AND revision=?`).bind(submissionId,staffId,phase,old.revision).run();
}
function mail(configuration: ClientOnboardingNotificationConfiguration, row: Recipient): OutboundMail {
  // A staff-authenticated review URL, never a recipient invitation or bearer.
  const link = `${configuration.reviewOrigin}/administration/client-onboarding?submission=${encodeURIComponent(row.submission_id)}`;
  return { to: row.recipient_email, fromName: "Ledge Top Operations", subject: "Client onboarding is ready for review",
    text: `A client onboarding submission is available for review. Sign into Operations: ${link}`,
    html: `<p>A client onboarding submission is available for review.</p><p><a href="${link}">Sign into Operations</a></p>`,
    messageIdKey: `client-onboarding:${row.submission_id}:${row.staff_id}` };
}

/** Only schema0094/0095 and the existing transport are used. No external service
 * setup and no client mail. Expired attempted sends require reconciliation. */
async function processNotifications(env: Env,
  send: (env: Env, mail: OutboundMail) => Promise<void> = sendNotificationMail): Promise<{ staged: number; sent: number; uncertain: number }> {
  const configuration = clientOnboardingNotificationConfiguration(env);
  if (!configuration) return { staged: 0, sent: 0, uncertain: 0 };
  validateNotificationMailTransport(env);
  const db = env.OPS_DB.withSession("first-primary");
  await db.prepare(`UPDATE client_onboarding_review_notification_recipients SET state='reconciliation_required',version=version+1,
    lease_token=NULL,lease_until=NULL WHERE (submission_id,staff_id) IN (
      SELECT submission_id,staff_id FROM client_onboarding_review_notification_recipients WHERE state='leased'
      AND attempted_at IS NOT NULL AND lease_until<=${now} ORDER BY lease_until,submission_id,staff_id LIMIT 32)`).run();
  let staged = 0, sent = 0, uncertain = 0;
  const fanout = await checkpoint(db,"fanout");
  const events = (await db.prepare(`SELECT submission_id FROM client_onboarding_review_notification_events
    WHERE sealed_at IS NULL AND created_at>=? AND submission_id>? ORDER BY submission_id LIMIT ?`)
    .bind(configuration.notBefore,fanout.last_submission_id,BATCH).all<{submission_id:string}>()).results;
  for (const event of events) {
    const recipients = [];
    for (const staffId of configuration.staffIds) {
      const recipient = await readClientOnboardingNotificationRecipient(env.OPS_DB,event.submission_id,staffId);
      if (recipient) recipients.push({staffId,...recipient});
    }
    if (recipients.length) {
      const results = await db.batch([
        ...recipients.map(recipient => db.prepare(`INSERT OR IGNORE INTO client_onboarding_review_notification_recipients
          (submission_id,staff_id,admission_version,profile_version,recipient_email)
          SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM client_onboarding_review_notification_events
            WHERE submission_id=? AND sealed_at IS NULL AND created_at>=?)
          AND NOT EXISTS(SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?)
          AND (${recipient.guard.sql})`)
          .bind(event.submission_id,recipient.staffId,recipient.admissionVersion,recipient.profileVersion,recipient.email,
            event.submission_id,configuration.notBefore,event.submission_id,...recipient.guard.bindings)),
        db.prepare(`UPDATE client_onboarding_review_notification_events SET sealed_at=${now}
          WHERE submission_id=? AND sealed_at IS NULL AND EXISTS(
            SELECT 1 FROM client_onboarding_review_notification_recipients WHERE submission_id=?)`)
          .bind(event.submission_id,event.submission_id),
      ]);
      staged += results.slice(0,-1).reduce((total,result)=>total+Number(result.meta.changes),0);
    }
  }
  await advance(db,"fanout",fanout,events.at(-1)?.submission_id??"");
  const delivery = await checkpoint(db,"delivery");
  const rows = (await db.prepare(`SELECT recipient.* FROM client_onboarding_review_notification_recipients recipient
    JOIN client_onboarding_review_notification_events event ON event.submission_id=recipient.submission_id AND event.created_at>=?
    WHERE recipient.attempt_count<3 AND (recipient.state='pending' AND (recipient.next_attempt_at IS NULL OR recipient.next_attempt_at<=${now})
      OR recipient.state='leased' AND recipient.attempted_at IS NULL AND recipient.lease_until<=${now})
    AND (recipient.submission_id>? OR (recipient.submission_id=? AND recipient.staff_id>?))
    ORDER BY recipient.submission_id,recipient.staff_id LIMIT ?`)
    .bind(configuration.notBefore,delivery.last_submission_id,delivery.last_submission_id,delivery.last_staff_id,BATCH).all<Recipient>()).results;
  const startedAt = Date.now();
  let last: Recipient | undefined;
  for (const row of rows) {
    // Leave enough time for one existing SMTP transport timeout and settlement.
    if (Date.now()-startedAt>60_000) break;
    last = row;
    const current = configuration.staffIds.includes(row.staff_id)
      ? await readClientOnboardingNotificationRecipient(env.OPS_DB,row.submission_id,row.staff_id) : null;
    if (!current || current.email!==row.recipient_email || current.admissionVersion!==row.admission_version || current.profileVersion!==row.profile_version) {
      await db.prepare(`UPDATE client_onboarding_review_notification_recipients SET state='suppressed',version=version+1,
        lease_token=NULL,lease_until=NULL WHERE submission_id=? AND staff_id=? AND version=?`)
        .bind(row.submission_id,row.staff_id,row.version).run();
      continue;
    }
    const token = crypto.randomUUID();
    const claim = await db.prepare(`UPDATE client_onboarding_review_notification_recipients SET state='leased',version=version+1,
      lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),attempted_at=NULL
      WHERE submission_id=? AND staff_id=? AND version=? AND (state='pending'
        OR state='leased' AND attempted_at IS NULL AND lease_until<=${now})`).bind(token,row.submission_id,row.staff_id,row.version).run();
    if (Number(claim.meta.changes)!==1) continue;
    const recheck = await readClientOnboardingNotificationRecipient(env.OPS_DB,row.submission_id,row.staff_id);
    if (!recheck || recheck.email!==current.email || recheck.admissionVersion!==current.admissionVersion || recheck.profileVersion!==current.profileVersion) continue;
    const attempt = await db.prepare(`UPDATE client_onboarding_review_notification_recipients SET attempted_at=${now},version=version+1,
      attempt_count=attempt_count+1
      WHERE submission_id=? AND staff_id=? AND state='leased' AND lease_token=? AND attempted_at IS NULL
        AND lease_until>${now} AND attempt_count<3
        AND (${recheck.guard.sql})`)
      .bind(row.submission_id,row.staff_id,token,...recheck.guard.bindings).run();
    if (Number(attempt.meta.changes)!==1) continue;
    let state: "sent" | "pending" | "reconciliation_required" = "sent";
    try { await send(env,mail(configuration,row)); }
    catch (error) {
      // Only a typed definitive pre-acceptance error is retryable. Binding errors,
      // opaque failures, timeouts or SMTP uncertainty never duplicate a notice.
      state = row.attempt_count < 2 && ["mail-connection-failed","mail-smtp-authentication-failed","mail-smtp-rejected"].includes(notificationMailFailureCode(error))
        ? "pending" : "reconciliation_required";
    }
    await db.prepare(`UPDATE client_onboarding_review_notification_recipients SET state=?,version=version+1,
      lease_token=NULL,lease_until=NULL,sent_at=CASE WHEN ?='sent' THEN ${now} ELSE NULL END,
      next_attempt_at=CASE WHEN ?='pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes') ELSE NULL END
      WHERE submission_id=? AND staff_id=? AND state='leased' AND lease_token=?`)
      .bind(state,state,state,row.submission_id,row.staff_id,token).run();
    if (state==='sent') sent++; else if (state==='reconciliation_required') uncertain++;
  }
  await advance(db,"delivery",delivery,last?.submission_id??"",last?.staff_id??"");
  return {staged,sent,uncertain};
}

/** Do not let transport/SQL diagnostics leak recipient or credential data into
 * the scheduler's generic error logger. The durable row retains its state. */
export async function processClientOnboardingNotifications(env: Env,
  send: (env: Env, mail: OutboundMail) => Promise<void> = sendNotificationMail) {
  try { return await processNotifications(env, send); }
  catch { throw Error("client_onboarding_notifications_failed"); }
}
