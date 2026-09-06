import { hasPermission } from "./acl";
import { sendNotificationMail } from "./mailer";
import type { Env } from "./types";

const MAX_ATTEMPTS = 3;
const BATCH_LIMIT = 20;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

interface IncomingUploadNotificationRow {
  id: string;
  request_id: string;
  contributor_id: string;
  owner_staff_id: string;
  digest_version: number;
  request_title: string;
  contributor_name: string;
  file_count: number;
  total_bytes: number;
  attempt_count: number;
}

interface IncomingUploadNotificationRecipient {
  id: string;
  email: string;
  display_name: string;
  access_subject: string | null;
  project_alpha_user_id: string | null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function byteLabel(value: number): string {
  return `${value.toLocaleString("en-US")} byte${value === 1 ? "" : "s"}`;
}

async function retryOrFail(env: Env, digestId: string, attempt: number, errorCode: string): Promise<void> {
  await env.DELIVERY_DB.prepare(`UPDATE incoming_upload_notification_digests SET status=?,
    next_attempt_at=datetime('now',?),lease_expires_at=NULL,last_error_code=?,updated_at=datetime('now')
    WHERE id=? AND status='processing'`)
    .bind(attempt >= MAX_ATTEMPTS ? "failed" : "retry", attempt >= MAX_ATTEMPTS ? "+0 seconds" : `+${2 ** attempt * 5} minutes`,
      errorCode, digestId).run();
}

/** Records one file in the current aggregate generation inside the completion batch. */
export function incomingUploadReceivedDigestStatement(database: D1Database, uploadId: string): D1PreparedStatement {
  return database.prepare(`INSERT INTO incoming_upload_notification_digest_items
      (upload_id,request_id,contributor_id,digest_version,file_size)
    SELECT upload.id,upload.request_id,upload.contributor_id,
      COALESCE((SELECT CASE WHEN latest.status='pending' AND latest.attempt_count=0
          THEN latest.digest_version ELSE latest.digest_version+1 END
        FROM incoming_upload_notification_digests latest
        WHERE latest.request_id=upload.request_id AND latest.contributor_id=upload.contributor_id
        ORDER BY latest.digest_version DESC LIMIT 1),1),
      upload.actual_size
    FROM file_request_uploads upload
    WHERE upload.id=? AND upload.status='quarantined' AND upload.actual_size>0
    ON CONFLICT(upload_id) DO NOTHING`).bind(uploadId);
}

export async function processIncomingUploadNotifications(env: Env): Promise<number> {
  let processed = 0;
  for (; processed < BATCH_LIMIT; processed += 1) {
    const row = await env.DELIVERY_DB.prepare(`SELECT digest.id,digest.request_id,digest.contributor_id,
        digest.owner_staff_id,digest.digest_version,digest.file_count,digest.total_bytes,digest.attempt_count,
        request.title request_title,contributor.name contributor_name
      FROM incoming_upload_notification_digests digest
      JOIN file_requests request ON request.id=digest.request_id
      JOIN file_request_contributors contributor
        ON contributor.id=digest.contributor_id AND contributor.request_id=digest.request_id
      WHERE ((digest.status='pending' AND datetime(digest.quiet_until)<=datetime('now'))
        OR (digest.status='retry' AND datetime(digest.next_attempt_at)<=datetime('now'))
        OR (digest.status='processing' AND datetime(digest.lease_expires_at)<=datetime('now')))
        AND digest.attempt_count<? ORDER BY digest.created_at,digest.id LIMIT 1`)
      .bind(MAX_ATTEMPTS).first<IncomingUploadNotificationRow>();
    if (!row) break;

    const claimed = await env.DELIVERY_DB.prepare(`UPDATE incoming_upload_notification_digests SET
        status='processing',attempt_count=attempt_count+1,lease_expires_at=datetime('now','+10 minutes'),
        updated_at=datetime('now')
      WHERE id=? AND attempt_count<? AND ((status='pending' AND datetime(quiet_until)<=datetime('now'))
        OR (status='retry' AND datetime(next_attempt_at)<=datetime('now'))
        OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))`)
      .bind(row.id, MAX_ATTEMPTS).run();
    if (!claimed.meta.changes) {
      processed -= 1;
      continue;
    }

    // A file may join an attempt-0 pending generation between the candidate
    // SELECT and the claim UPDATE. Re-read only after the generation becomes
    // immutable so the delivered count and byte total cannot be stale.
    const claimedRow = await env.DELIVERY_DB.prepare(`SELECT digest.id,digest.request_id,digest.contributor_id,
        digest.owner_staff_id,digest.digest_version,digest.file_count,digest.total_bytes,digest.attempt_count,
        request.title request_title,contributor.name contributor_name
      FROM incoming_upload_notification_digests digest
      JOIN file_requests request ON request.id=digest.request_id
      JOIN file_request_contributors contributor
        ON contributor.id=digest.contributor_id AND contributor.request_id=digest.request_id
      WHERE digest.id=? AND digest.status='processing'`)
      .bind(row.id).first<IncomingUploadNotificationRow>();
    if (!claimedRow) continue;

    const owner = await env.OPS_DB.withSession("first-primary").prepare(`SELECT id,email,display_name,access_subject,project_alpha_user_id
      FROM staff_users WHERE id=? AND status='active'`)
      .bind(claimedRow.owner_staff_id).first<IncomingUploadNotificationRecipient>();
    if (!owner || !EMAIL.test(owner.email)) {
      await env.DELIVERY_DB.prepare(`UPDATE incoming_upload_notification_digests SET
        status='suppressed',lease_expires_at=NULL,last_error_code='owner-recipient-unavailable',updated_at=datetime('now')
        WHERE id=? AND status='processing'`).bind(row.id).run();
      continue;
    }
    const principal = { id: owner.id, email: owner.email, displayName: owner.display_name,
      accessSubject: owner.access_subject ?? "", projectAlphaUserId: owner.project_alpha_user_id };
    let authorized: boolean;
    try {
      authorized = await hasPermission(env, principal, "file_requests.view");
    } catch {
      await retryOrFail(env, row.id, claimedRow.attempt_count, "owner-authorization-check-failed");
      continue;
    }
    if (!authorized) {
      await env.DELIVERY_DB.prepare(`UPDATE incoming_upload_notification_digests SET
        status='suppressed',lease_expires_at=NULL,last_error_code='owner-recipient-unauthorized',updated_at=datetime('now')
        WHERE id=? AND status='processing'`).bind(row.id).run();
      continue;
    }

    const title = claimedRow.request_title.trim().slice(0, 200) || "Incoming uploads";
    const contributor = claimedRow.contributor_name.trim().slice(0, 120) || "A contributor";
    const count = `${claimedRow.file_count} new file${claimedRow.file_count === 1 ? "" : "s"}`;
    const bytes = byteLabel(claimedRow.total_bytes);
    const text = `${contributor} uploaded ${count} (${bytes}) for “${title}”. The files were received and are pending verification. They will remain quarantined until verification is complete.`;
    try {
      await sendNotificationMail(env, {
        to: owner.email,
        fromName: "LTDS Incoming Uploads",
        subject: `${count} received and pending verification`,
        text,
        html: `<p><strong>${escapeHtml(contributor)}</strong> uploaded ${escapeHtml(count)} (${escapeHtml(bytes)}) for <strong>${escapeHtml(title)}</strong>.</p><p>The files were received and are pending verification. They will remain quarantined until verification is complete.</p>`,
        messageIdKey: claimedRow.id,
      });
      await env.DELIVERY_DB.prepare(`UPDATE incoming_upload_notification_digests SET
        status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime('now')
        WHERE id=? AND status='processing'`).bind(row.id).run();
    } catch {
      await retryOrFail(env, row.id, claimedRow.attempt_count, "mail-transport-failed");
    }
  }
  return processed;
}
