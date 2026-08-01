import type { Env } from "./types";
import { sendAdminAlert } from "./alerts";

export type NotificationKind = "share_created" | "share_updated" | "share_revoked" | "first_access" | "expiring_72h";
export interface NotificationPayload { publicId?: string | null; shareUrl?: string; clientName?: string; projectName?: string; r2Prefix?: string; expiresAt?: string | null; }
interface NotificationRow { id: string; share_id: string; kind: NotificationKind; recipient_email: string; payload_json: string; attempts: number; }
const MAX_ATTEMPTS = 3;

type ClientPortalRequestEvent = "request_submitted" | "request_status_changed";
type ClientPortalRequestRecipient = "staff_triage" | "client_requester";
interface ClientPortalRequestNotificationRow {
  id: string;
  request_id: string;
  event_type: ClientPortalRequestEvent;
  status_value: string | null;
  recipient_kind: ClientPortalRequestRecipient;
  payload_json: string;
  attempt_count: number;
  title: string;
  request_type: string;
  details: string;
  location_text: string | null;
  desired_completion_at: string | null;
  project_name: string;
  client_name: string;
  requester_email: string | null;
}

export function normalizeRecipientEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Recipient email must be a string");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Recipient email is invalid");
  return email;
}

export function notificationDedupeKey(kind: NotificationKind, shareId: string, discriminator = ""): string { return `${kind}:${shareId}${discriminator ? `:${discriminator}` : ""}`; }

export function notificationStatement(env: Env, input: { shareId: string; kind: NotificationKind; recipientEmail: string | null; payload: NotificationPayload; dedupeKey?: string }): D1PreparedStatement | null {
  if (!input.recipientEmail) return null;
  return env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO delivery_notifications
    (id,dedupe_key,share_id,kind,recipient_email,payload_json) VALUES (?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), input.dedupeKey || notificationDedupeKey(input.kind, input.shareId), input.shareId, input.kind, input.recipientEmail, JSON.stringify(input.payload));
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
export function renderNotification(kind: NotificationKind, payload: NotificationPayload): { subject: string; text: string; html: string } {
  const name = payload.projectName || payload.clientName || payload.r2Prefix || "your delivery";
  const linkText = payload.shareUrl ? `\n\nOpen the delivery: ${payload.shareUrl}` : "";
  const linkHtml = payload.shareUrl ? `<p><a href="${escapeHtml(payload.shareUrl)}">Open the delivery</a></p>` : "";
  const safeName = escapeHtml(name);
  const messages: Record<NotificationKind, { subject: string; text: string; html: string }> = {
    share_created: { subject: `Delivery link ready: ${name}`, text: `Your delivery for ${name} is ready.${linkText}`, html: `<p>Your delivery for <strong>${safeName}</strong> is ready.</p>${linkHtml}` },
    share_updated: { subject: `Delivery link updated: ${name}`, text: `The delivery link for ${name} was updated.${linkText}`, html: `<p>The delivery link for <strong>${safeName}</strong> was updated.</p>${linkHtml}` },
    share_revoked: { subject: `Delivery access revoked: ${name}`, text: `Access to the delivery for ${name} has been revoked.`, html: `<p>Access to the delivery for <strong>${safeName}</strong> has been revoked.</p>` },
    first_access: { subject: `Your delivery was viewed: ${name}`, text: `Your delivery for ${name} was viewed for the first time.`, html: `<p>Your delivery for <strong>${safeName}</strong> was viewed for the first time.</p>` },
    expiring_72h: { subject: `Delivery link expires soon: ${name}`, text: `The delivery link for ${name} expires within 72 hours${payload.expiresAt ? `, on ${payload.expiresAt}` : ""}.`, html: `<p>The delivery link for <strong>${safeName}</strong> expires within 72 hours${payload.expiresAt ? `, on ${escapeHtml(payload.expiresAt)}` : ""}.</p>` },
  };
  return messages[kind];
}

async function auditNotification(env: Env, action: string, row: NotificationRow, detail: Record<string, unknown>): Promise<void> {
  await env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('system','notifications',?,'share',?,?)`)
    .bind(action, row.share_id, JSON.stringify({ notificationId: row.id, kind: row.kind, ...detail })).run();
}

export async function enqueueExpiringNotifications(env: Env): Promise<number> {
  const rows = await env.DELIVERY_DB.prepare(`SELECT s.id,s.recipient_email,s.public_id,p.client_name,p.project_name,
    COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix,s.expires_at FROM shares s
    JOIN projects p ON p.id=s.project_id
    WHERE s.revoked_at IS NULL AND p.active=1 AND s.recipient_email IS NOT NULL AND s.expires_at IS NOT NULL
    AND datetime(s.expires_at)>datetime('now') AND datetime(s.expires_at)<=datetime('now','+72 hours')`)
    .all<{ id: string; recipient_email: string; public_id: string | null; client_name: string; project_name: string; r2_prefix: string; expires_at: string }>();
  const statements = rows.results.map(row => notificationStatement(env, { shareId: row.id, kind: "expiring_72h", recipientEmail: row.recipient_email,
    dedupeKey: notificationDedupeKey("expiring_72h", row.id, row.expires_at), payload: { publicId: row.public_id, clientName: row.client_name, projectName: row.project_name, r2Prefix: row.r2_prefix, expiresAt: row.expires_at } }))
    .filter((statement): statement is D1PreparedStatement => Boolean(statement));
  if (statements.length) await env.DELIVERY_DB.batch(statements);
  return statements.length;
}

export async function processDeliveryNotifications(env: Env): Promise<number> {
  if (!env.NOTIFICATION_EMAIL || !env.NOTIFICATION_FROM) return 0;
  let processed = 0;
  for (; processed < 25; processed += 1) {
    const row = await env.DELIVERY_DB.prepare(`SELECT id,share_id,kind,recipient_email,payload_json,attempts FROM delivery_notifications
      WHERE ((status='queued' AND datetime(next_attempt_at)<=datetime('now')) OR (status='sending' AND datetime(lease_until)<=datetime('now'))) AND attempts < ?
      ORDER BY created_at LIMIT 1`).bind(MAX_ATTEMPTS).first<NotificationRow>();
    if (!row) break;
    const claimed = await env.DELIVERY_DB.prepare(`UPDATE delivery_notifications SET status='sending',attempts=attempts+1,lease_until=datetime('now','+15 minutes'),updated_at=datetime('now')
      WHERE id=? AND attempts < ? AND ((status='queued' AND datetime(next_attempt_at)<=datetime('now')) OR (status='sending' AND datetime(lease_until)<=datetime('now')))`)
      .bind(row.id, MAX_ATTEMPTS).run();
    if (!claimed.meta.changes) { processed -= 1; continue; }
    const attempt = row.attempts + 1;
    try {
      const rendered = renderNotification(row.kind, JSON.parse(row.payload_json) as NotificationPayload);
      await env.NOTIFICATION_EMAIL.send({ to: row.recipient_email, from: { email: env.NOTIFICATION_FROM, name: "LTDS Client Delivery" }, subject: rendered.subject, text: rendered.text, html: rendered.html });
      await env.DELIVERY_DB.prepare("UPDATE delivery_notifications SET status='sent',sent_at=datetime('now'),lease_until=NULL,updated_at=datetime('now') WHERE id=? AND status='sending'").bind(row.id).run();
      await auditNotification(env, "notification.sent", row, { attempt });
    } catch (error) {
      const message = (error instanceof Error ? error.message : "email-send-failed").slice(0, 240);
      const terminal = attempt >= MAX_ATTEMPTS;
      await env.DELIVERY_DB.prepare("UPDATE delivery_notifications SET status=?,next_attempt_at=datetime('now',?),lease_until=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='sending'")
        .bind(terminal ? "failed" : "queued", terminal ? "+0 seconds" : `+${2 ** attempt * 5} minutes`, message, row.id).run();
      await auditNotification(env, terminal ? "notification.failed" : "notification.retry_scheduled", row, { attempt, error: message });
      if (terminal) await sendAdminAlert(env, "Client notification failed", `${row.kind} for ${row.recipient_email}: ${message}`);
    }
  }
  return processed;
}

function clientRequestNotification(row: ClientPortalRequestNotificationRow): { subject: string; text: string; html: string } {
  const project = row.project_name || row.client_name || "client portal";
  const status = row.status_value || "submitted";
  if (row.recipient_kind === "client_requester") {
    const subject = `Request ${status.replace(/_/g, " ")}: ${row.title}`;
    const text = `Your ${row.request_type} request for ${project} is now ${status.replace(/_/g, " ")}.`;
    return { subject, text, html: `<p>${escapeHtml(text)}</p>` };
  }
  const due = row.desired_completion_at ? `\nRequested completion: ${row.desired_completion_at}` : "";
  const location = row.location_text ? `\nLocation: ${row.location_text}` : "";
  const text = `A client submitted a ${row.request_type} request for ${project}.\n\nTitle: ${row.title}${location}${due}\n\nDetails:\n${row.details}`;
  const html = `<p>A client submitted a <strong>${escapeHtml(row.request_type)}</strong> request for <strong>${escapeHtml(project)}</strong>.</p><p><strong>Title:</strong> ${escapeHtml(row.title)}${row.location_text ? `<br><strong>Location:</strong> ${escapeHtml(row.location_text)}` : ""}${row.desired_completion_at ? `<br><strong>Requested completion:</strong> ${escapeHtml(row.desired_completion_at)}` : ""}</p><p><strong>Details</strong><br>${escapeHtml(row.details).replace(/\n/g, "<br>")}</p>`;
  return { subject: `New client request: ${row.title}`, text, html };
}

async function auditClientRequestNotification(env: Env, action: string, row: ClientPortalRequestNotificationRow, detail: Record<string, unknown>): Promise<void> {
  await env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('system','client-request-notifications',?,'client_service_request',?,?)`)
    .bind(action, row.request_id, JSON.stringify({ notificationId: row.id, eventType: row.event_type, recipientKind: row.recipient_kind, ...detail })).run();
}

/** Delivers the durable client-request intent ledger. A missing recipient is deliberately suppressed, never retried forever. */
export async function processClientPortalRequestNotifications(env: Env): Promise<number> {
  if (!env.NOTIFICATION_EMAIL || !env.NOTIFICATION_FROM) return 0;
  let processed = 0;
  for (; processed < 25; processed += 1) {
    const row = await env.DELIVERY_DB.prepare(`SELECT n.id,n.request_id,n.event_type,n.status_value,n.recipient_kind,n.payload_json,n.attempt_count,
      r.title,r.request_type,r.details,r.location_text,r.desired_completion_at,p.project_name,p.client_name,
      CASE WHEN n.recipient_kind='client_requester' THEN i.email ELSE NULL END requester_email
      FROM client_portal_notification_outbox n
      JOIN client_service_requests r ON r.id=n.request_id
      JOIN projects p ON p.id=r.project_id
      LEFT JOIN client_identity_links i ON i.id=r.created_by_identity_id AND i.revoked_at IS NULL
      WHERE ((n.status='pending' AND datetime(n.next_attempt_at)<=datetime('now')) OR (n.status='processing' AND datetime(n.lease_expires_at)<=datetime('now')))
        AND n.attempt_count < ? ORDER BY n.created_at LIMIT 1`).bind(MAX_ATTEMPTS).first<ClientPortalRequestNotificationRow>();
    if (!row) break;
    const claimed = await env.DELIVERY_DB.prepare(`UPDATE client_portal_notification_outbox SET status='processing',attempt_count=attempt_count+1,lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now')
      WHERE id=? AND attempt_count < ? AND ((status='pending' AND datetime(next_attempt_at)<=datetime('now')) OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))`)
      .bind(row.id, MAX_ATTEMPTS).run();
    if (!claimed.meta.changes) { processed -= 1; continue; }
    const attempt = row.attempt_count + 1;
    const recipient = row.recipient_kind === "staff_triage" ? normalizeRecipientEmail(env.CLIENT_REQUEST_TRIAGE_TO) : normalizeRecipientEmail(row.requester_email);
    if (!recipient) {
      await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status='suppressed',lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing'")
        .bind(row.recipient_kind === "staff_triage" ? "staff-triage-recipient-not-configured" : "requester-email-unavailable", row.id).run();
      await auditClientRequestNotification(env, "client_request_notification.suppressed", row, { attempt });
      continue;
    }
    try {
      const rendered = clientRequestNotification(row);
      await env.NOTIFICATION_EMAIL.send({ to: recipient, from: { email: env.NOTIFICATION_FROM, name: "LTDS Client Portal" }, subject: rendered.subject, text: rendered.text, html: rendered.html });
      await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND status='processing'").bind(row.id).run();
      await auditClientRequestNotification(env, "client_request_notification.sent", row, { attempt });
    } catch (error) {
      const message = (error instanceof Error ? error.message : "email-send-failed").slice(0, 240);
      const terminal = attempt >= MAX_ATTEMPTS;
      await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status=?,next_attempt_at=datetime('now',?),lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing'")
        .bind(terminal ? "failed" : "pending", terminal ? "+0 seconds" : `+${2 ** attempt * 5} minutes`, message, row.id).run();
      await auditClientRequestNotification(env, terminal ? "client_request_notification.failed" : "client_request_notification.retry_scheduled", row, { attempt, error: message });
      if (terminal) await sendAdminAlert(env, "Client request notification failed", `${row.event_type} notification ${row.id}: ${message}`);
    }
  }
  return processed;
}
