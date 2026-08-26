import {
  buildServiceRequestNotificationSnapshot,
  parseServiceRequestNotificationSnapshot,
  PRIMARY_ALPHA_SOURCE_ID,
  type ServiceRequestNotificationLifecycle,
  type ServiceRequestNotificationSnapshot,
} from "@ltds/shared";
import type { Env } from "./types";
import { sendAdminAlert } from "./alerts";
import { sendNotificationMail } from "./mailer";
import { d1TablesPresent } from "./schema-readiness";
import { resolveProjectAlphaDeliveryPrincipal } from "./share-recipients";
import { HTTPException } from "hono/http-exception";

export type NotificationKind = "share_created" | "share_updated" | "share_revoked" | "first_access" | "expiring_72h";
export interface NotificationPayload { publicId?: string | null; shareUrl?: string; clientName?: string; projectName?: string; r2Prefix?: string; expiresAt?: string | null; }
interface NotificationRow { id: string; share_id: string; kind: NotificationKind; recipient_email: string; payload_json: string; attempts: number; }
const MAX_ATTEMPTS = 3;

type ClientPortalRequestEvent = "request_submitted" | "request_status_changed" | "request_confirmation_requested" | "request_client_response" | "request_work_area_changed";
type ClientPortalRequestRecipient = "staff_triage" | "client_requester";
interface ClientPortalRequestNotificationRow {
  id: string;
  request_id: string;
  catalog_source_id: string;
  account_source_id: string | null;
  project_source_id: string | null;
  event_type: ClientPortalRequestEvent;
  status_value: string | null;
  recipient_kind: ClientPortalRequestRecipient;
  payload_json: string;
  attempt_count: number;
  title: string;
  project_id: string | null;
  service_category: string | null;
  location_text: string | null;
  latitude: number | null;
  longitude: number | null;
  project_name: string | null;
  requester_email: string | null;
  account_id: string;
  requester_identity_id: string;
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
  const recipientSnapshotsAvailable = await d1TablesPresent(env.DELIVERY_DB, [
    "delivery_share_audience_snapshots",
    "delivery_share_recipient_members",
  ]);
  const rows = await env.DELIVERY_DB.prepare(recipientSnapshotsAvailable
    ? `SELECT s.id,COALESCE(member.recipient_normalized_email,s.recipient_email) recipient_email,
        member.recipient_principal_public_id,s.public_id,p.client_name,p.project_name,
        COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix,s.expires_at FROM shares s
       JOIN projects p ON p.id=s.project_id
       LEFT JOIN delivery_share_audience_snapshots audience
         ON audience.share_id=s.id AND audience.share_version=s.share_version
       LEFT JOIN delivery_share_recipient_members member
         ON member.share_id=audience.share_id AND member.share_version=audience.share_version
       WHERE s.revoked_at IS NULL AND p.active=1 AND COALESCE(member.recipient_normalized_email,s.recipient_email) IS NOT NULL AND s.expires_at IS NOT NULL
         AND datetime(s.expires_at)>datetime('now') AND datetime(s.expires_at)<=datetime('now','+72 hours')`
    : `SELECT s.id,s.recipient_email,NULL recipient_principal_public_id,s.public_id,
        p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix,s.expires_at
       FROM shares s JOIN projects p ON p.id=s.project_id
       WHERE s.revoked_at IS NULL AND p.active=1 AND s.recipient_email IS NOT NULL AND s.expires_at IS NOT NULL
         AND datetime(s.expires_at)>datetime('now') AND datetime(s.expires_at)<=datetime('now','+72 hours')`)
    .all<{ id: string; recipient_email: string; recipient_principal_public_id: string | null; public_id: string | null; client_name: string; project_name: string; r2_prefix: string; expires_at: string }>();
  const statements = rows.results.map(row => notificationStatement(env, { shareId: row.id, kind: "expiring_72h", recipientEmail: row.recipient_email,
    dedupeKey: notificationDedupeKey("expiring_72h", row.id, `${row.expires_at}${row.recipient_principal_public_id ? `:${row.recipient_principal_public_id}` : ""}`), payload: { publicId: row.public_id, clientName: row.client_name, projectName: row.project_name, r2Prefix: row.r2_prefix, expiresAt: row.expires_at } }))
    .filter((statement): statement is D1PreparedStatement => Boolean(statement));
  if (statements.length) await env.DELIVERY_DB.batch(statements);
  return statements.length;
}

export async function processDeliveryNotifications(env: Env): Promise<number> {
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
      const integrationAuthority=await env.DELIVERY_DB.prepare(`SELECT authority.principal_public_id,authority.principal_source_version,
        authority.status authority_status,share.revoked_at,share.expires_at,binding.r2_prefix,
        CASE WHEN binding.id IS NOT NULL AND checkpoint.active_generation_id=authority.directory_generation_id
          AND generation.id IS NOT NULL THEN 1 ELSE 0 END source_context_live
        FROM project_alpha_delivery_guest_authority authority
        JOIN shares share ON share.id=authority.share_id
        LEFT JOIN portal_v2_folder_bindings binding ON binding.id=authority.folder_binding_id
          AND binding.workspace_id=authority.workspace_id AND binding.source_version=authority.binding_source_version
          AND binding.status='active' AND binding.revoked_at IS NULL
        LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=authority.workspace_id
        LEFT JOIN portal_v2_directory_generations generation ON generation.id=authority.directory_generation_id
          AND generation.workspace_id=authority.workspace_id AND generation.status='active' AND generation.complete=1
        WHERE authority.share_id=? LIMIT 2`).bind(row.share_id)
        .all<{principal_public_id:string;principal_source_version:string;authority_status:"active"|"revoked";revoked_at:string|null;expires_at:string|null;r2_prefix:string|null;source_context_live:number}>();
      if(integrationAuthority.results.length>1)throw new HTTPException(409,{message:"Delivery recipient authority is ambiguous"});
      if(integrationAuthority.results.length===1){
        const authority=integrationAuthority.results[0]!,createdLifecycle=row.kind!=="share_revoked";
        if(authority.source_context_live!==1||!authority.r2_prefix)
          throw new HTTPException(409,{message:"Delivery source authority is no longer live"});
        if(createdLifecycle&&(authority.authority_status!=="active"||authority.revoked_at!==null||
          (authority.expires_at!==null&&Date.parse(authority.expires_at)<=Date.now())))
          throw new HTTPException(409,{message:"Delivery link is no longer active"});
        if(!createdLifecycle&&(authority.authority_status!=="revoked"||authority.revoked_at===null))
          throw new HTTPException(409,{message:"Delivery revocation is not authoritative"});
        const recipient=await resolveProjectAlphaDeliveryPrincipal(env,
          authority.r2_prefix,authority.principal_public_id,authority.principal_source_version);
        if(recipient.recipients.length!==1||recipient.recipients[0]!.email!==row.recipient_email)
          throw new HTTPException(409,{message:"Delivery recipient is no longer eligible"});
      }
      const rendered = renderNotification(row.kind, JSON.parse(row.payload_json) as NotificationPayload);
      await sendNotificationMail(env, { to: row.recipient_email, fromName: "LTDS Client Delivery", subject: rendered.subject, text: rendered.text, html: rendered.html, messageIdKey: row.id });
      await env.DELIVERY_DB.prepare("UPDATE delivery_notifications SET status='sent',sent_at=datetime('now'),lease_until=NULL,updated_at=datetime('now') WHERE id=? AND status='sending'").bind(row.id).run();
      await auditNotification(env, "notification.sent", row, { attempt });
    } catch (error) {
      if(error instanceof HTTPException){
        // The legacy delivery_notifications lifecycle has no `suppressed`
        // state. Terminal `failed` is the non-retryable state; the audit action
        // preserves the more precise suppression reason.
        await env.DELIVERY_DB.prepare("UPDATE delivery_notifications SET status='failed',lease_until=NULL,last_error='recipient-no-longer-eligible',updated_at=datetime('now') WHERE id=? AND status='sending'").bind(row.id).run();
        await auditNotification(env,"notification.suppressed",row,{attempt,reason:"recipient-no-longer-eligible"});
        continue;
      }
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

export async function processProjectAlphaDeliveryPortalNotifications(env:Env):Promise<number>{
  await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='suppressed',
    last_error='authorization-no-longer-live',updated_at=datetime('now') WHERE status IN ('pending','processing') AND
    NOT EXISTS(SELECT 1 FROM project_alpha_delivery_portal_grants grant_record
      JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
        AND binding.workspace_id=grant_record.workspace_id AND binding.status='active' AND binding.revoked_at IS NULL
        AND binding.source_version=grant_record.binding_source_version
      WHERE grant_record.id=project_alpha_delivery_portal_notification_outbox.grant_id
        AND (project_alpha_delivery_portal_notification_outbox.event_type='revoked' OR (grant_record.status='active' AND
          (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now')))))`).run();
  let processed=0;
  for(;processed<25;processed+=1){
    const row=await env.DELIVERY_DB.prepare(`SELECT outbox.id,outbox.event_type,outbox.principal_public_id,
      outbox.principal_source_version,outbox.attempt_count,binding.r2_prefix
      FROM project_alpha_delivery_portal_notification_outbox outbox
      JOIN project_alpha_delivery_portal_grants grant_record ON grant_record.id=outbox.grant_id
      JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
        AND binding.workspace_id=grant_record.workspace_id AND binding.status='active' AND binding.revoked_at IS NULL
        AND binding.source_version=grant_record.binding_source_version
      WHERE ((outbox.status='pending' AND datetime(outbox.next_attempt_at)<=datetime('now')) OR
        (outbox.status='processing' AND datetime(outbox.lease_expires_at)<=datetime('now')))
        AND (outbox.event_type='revoked' OR (grant_record.status='active' AND
          (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))))
      ORDER BY outbox.created_at LIMIT 1`)
      .first<{id:string;event_type:"granted"|"revoked";principal_public_id:string;principal_source_version:string;attempt_count:number;r2_prefix:string}>();
    if(!row)break;
    const claimed=await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='processing',attempt_count=attempt_count+1,lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now') WHERE id=? AND
      ((status='pending' AND datetime(next_attempt_at)<=datetime('now')) OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))` ).bind(row.id).run();
    if(!claimed.meta.changes){processed-=1;continue;}
    try{
      const recipient=await resolveProjectAlphaDeliveryPrincipal(env,row.r2_prefix,row.principal_public_id,row.principal_source_version);
      const recipientEmail=recipient.recipients[0]?.email;
      if(!recipientEmail)throw new Error("recipient-unavailable");
      const granted=row.event_type==="granted",url=`${env.DELIVERY_BASE_URL.replace(/\/$/,"")}/portal/deliveries`;
      await sendNotificationMail(env,{to:recipientEmail,fromName:"LTDS Client Delivery",
        subject:granted?"Delivery available in your portal":"Portal delivery access revoked",
        text:granted?`A delivery is available in your LTDS portal.\n\nOpen the portal: ${url}`:"Access to a delivery in your LTDS portal was revoked.",
        html:granted?`<p>A delivery is available in your LTDS portal.</p><p><a href="${escapeHtml(url)}">Open the portal</a></p>`:"<p>Access to a delivery in your LTDS portal was revoked.</p>",messageIdKey:row.id});
      await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND status='processing'`).bind(row.id).run();
    }catch(error){if(error instanceof HTTPException){await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='suppressed',lease_expires_at=NULL,last_error='recipient-no-longer-eligible',updated_at=datetime('now') WHERE id=?`).bind(row.id).run();continue;}const attempt=row.attempt_count+1,terminal=attempt>=MAX_ATTEMPTS;
      await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status=?,next_attempt_at=datetime('now',?),lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=?`).bind(terminal?"failed":"pending",terminal?"+0 seconds":`+${2**attempt*5} minutes`,(error instanceof Error?error.message:"email-send-failed").slice(0,240),row.id).run();}
  }
  return processed;
}

const lifecyclePresentation: Record<
  ServiceRequestNotificationLifecycle,
  { subject: string; status: string; introduction: string }
> = {
  submitted: {
    subject: "Service request submitted",
    status: "Submitted",
    introduction: "A service request was submitted.",
  },
  under_review: {
    subject: "Service request under review",
    status: "Under review",
    introduction: "LTDS is reviewing your service request.",
  },
  accepted_pending_pa_linkage: {
    subject: "Service request accepted",
    status: "Accepted — next steps being prepared",
    introduction: "LTDS accepted your service request and is preparing the next steps.",
  },
  accepted_linked: {
    subject: "Service request accepted",
    status: "Accepted",
    introduction: "Your service request is accepted.",
  },
  declined: {
    subject: "Service request declined",
    status: "Declined",
    introduction: "LTDS cannot proceed with this service request.",
  },
  cancelled: {
    subject: "Service request cancelled",
    status: "Cancelled",
    introduction: "This service request was cancelled.",
  },
  completed: {
    subject: "Service request completed",
    status: "Completed",
    introduction: "This service request is complete.",
  },
  estimate_ready: {
    subject: "Operational estimate ready",
    status: "Estimate ready",
    introduction: "A non-binding operational estimate is ready for your review.",
  },
  client_response_received: {
    subject: "Client response received",
    status: "Client response received",
    introduction: "A client responded to the operational estimate.",
  },
  work_area_changed: {
    subject: "Service request work area updated",
    status: "Work area updated",
    introduction: "LTDS updated the work area after staff review.",
  },
};

export function renderClientRequestNotification(
  snapshot: ServiceRequestNotificationSnapshot,
  actionUrl: string,
): { subject: string; text: string; html: string } {
  const presentation = lifecyclePresentation[snapshot.lifecycle];
  const context =
    snapshot.projectContext.kind === "existing_project"
      ? `Existing project — ${snapshot.projectContext.label}`
      : snapshot.projectContext.label;
  const actionLabel =
    snapshot.action === "review_in_operations"
      ? "Review in LTDS Operations"
      : "Open the client portal";
  const subjectPrefix =
    snapshot.lifecycle === "submitted" && snapshot.action === "review_in_operations"
      ? "New service request"
      : presentation.subject;
  const changeText = snapshot.changeSummary ? `\nChange: ${snapshot.changeSummary}` : "";
  const changeHtml = snapshot.changeSummary ? `<br><strong>Change:</strong> ${escapeHtml(snapshot.changeSummary)}` : "";
  const text = `${presentation.introduction}\n\nTitle: ${snapshot.title}\nContext: ${context}\nScope: ${snapshot.scopeLabel}\nLocation: ${snapshot.locationLabel}\nStatus: ${presentation.status}${changeText}\n\n${actionLabel}: ${actionUrl}`;
  const html = `<p>${escapeHtml(presentation.introduction)}</p><p><strong>Title:</strong> ${escapeHtml(snapshot.title)}<br><strong>Context:</strong> ${escapeHtml(context)}<br><strong>Scope:</strong> ${escapeHtml(snapshot.scopeLabel)}<br><strong>Location:</strong> ${escapeHtml(snapshot.locationLabel)}<br><strong>Status:</strong> ${escapeHtml(presentation.status)}${changeHtml}</p><p><a href="${escapeHtml(actionUrl)}">${escapeHtml(actionLabel)}</a></p>`;
  return { subject: `${subjectPrefix}: ${snapshot.title}`, text, html };
}

function notificationSnapshot(row: ClientPortalRequestNotificationRow): ServiceRequestNotificationSnapshot {
  try {
    const stored = parseServiceRequestNotificationSnapshot(JSON.parse(row.payload_json));
    if (stored) return stored;
  } catch {
    // Legacy payloads are rebuilt from the same request-scoped, nonfinancial fields below.
  }
  const lifecycle: ServiceRequestNotificationLifecycle =
    row.event_type === "request_work_area_changed"
      ? "work_area_changed"
      : row.event_type === "request_confirmation_requested"
      ? "estimate_ready"
      : row.event_type === "request_client_response"
        ? "client_response_received"
        : (row.status_value as ServiceRequestNotificationLifecycle) || "submitted";
  return buildServiceRequestNotificationSnapshot({
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    serviceCategory: row.service_category,
    locationLabel: row.location_text,
    latitude: row.latitude,
    longitude: row.longitude,
    lifecycle,
    action:
      row.recipient_kind === "staff_triage"
        ? "review_in_operations"
        : "open_client_portal",
  });
}

function actionUrl(env: Env, row: ClientPortalRequestNotificationRow, snapshot: ServiceRequestNotificationSnapshot): string {
  const base = snapshot.action === "review_in_operations" ? env.PUBLIC_BASE_URL : env.DELIVERY_BASE_URL;
  const path = snapshot.action === "review_in_operations"
    ? `/operations/client-requests/${encodeURIComponent(row.request_id)}`
    : "/portal/requests";
  return new URL(path, base).toString();
}

async function auditClientRequestNotification(env: Env, action: string, row: ClientPortalRequestNotificationRow, detail: Record<string, unknown>): Promise<void> {
  await env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('system','client-request-notifications',?,'client_service_request',?,?)`)
    .bind(action, row.request_id, JSON.stringify({ notificationId: row.id, eventType: row.event_type, recipientKind: row.recipient_kind, ...detail })).run();
}

/** Delivers the durable client-request intent ledger. A missing recipient is deliberately suppressed, never retried forever. */
export async function processClientPortalRequestNotifications(env: Env): Promise<number> {
  const portalInboxAvailable = await d1TablesPresent(env.DELIVERY_DB, ["client_portal_notifications"]);
  let processed = 0;
  for (; processed < 25; processed += 1) {
    const row = await env.DELIVERY_DB.prepare(`SELECT n.id,n.request_id,n.event_type,n.status_value,n.recipient_kind,n.payload_json,n.attempt_count,
      r.catalog_source_id,r.title,r.project_id,r.service_category,r.location_text,r.latitude,r.longitude,p.project_name,r.account_id,r.created_by_identity_id requester_identity_id,
      account.project_alpha_source_id account_source_id,p.project_alpha_source_id project_source_id,
      CASE WHEN n.recipient_kind='client_requester' THEN i.email ELSE NULL END requester_email
      FROM client_portal_notification_outbox n
      JOIN client_service_requests r ON r.id=n.request_id
      LEFT JOIN projects p ON p.id=r.project_id
      LEFT JOIN client_accounts account ON account.id=r.account_id AND account.status='active'
      LEFT JOIN client_identity_links i ON i.id=r.created_by_identity_id AND i.account_id=account.id AND i.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM client_account_members member WHERE member.account_id=account.id AND member.identity_id=i.id AND member.revoked_at IS NULL)
        AND ((r.project_id IS NULL) OR EXISTS (
          SELECT 1 FROM client_project_grants request_grant
          JOIN projects request_project ON request_project.id=request_grant.project_id AND request_project.active=1
          JOIN client_account_members request_member ON request_member.account_id=account.id AND request_member.identity_id=i.id AND request_member.revoked_at IS NULL
          WHERE request_grant.account_id=account.id AND request_grant.project_id=r.project_id AND request_grant.revoked_at IS NULL
            AND (request_member.role='manager' OR EXISTS (
              SELECT 1 FROM client_member_project_grants member_grant
              WHERE member_grant.account_id=account.id AND member_grant.identity_id=i.id
                AND member_grant.project_id=r.project_id AND member_grant.revoked_at IS NULL
            ))
        ))
      WHERE ((n.status='pending' AND datetime(n.next_attempt_at)<=datetime('now')) OR (n.status='processing' AND datetime(n.lease_expires_at)<=datetime('now')))
        AND n.attempt_count < ? ORDER BY n.created_at LIMIT 1`).bind(MAX_ATTEMPTS).first<ClientPortalRequestNotificationRow>();
    if (!row) break;
    const claimed = await env.DELIVERY_DB.prepare(`UPDATE client_portal_notification_outbox SET status='processing',attempt_count=attempt_count+1,lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now')
      WHERE id=? AND attempt_count < ? AND ((status='pending' AND datetime(next_attempt_at)<=datetime('now')) OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))`)
      .bind(row.id, MAX_ATTEMPTS).run();
    if (!claimed.meta.changes) { processed -= 1; continue; }
    const attempt = row.attempt_count + 1;
    // Client request routes currently support only the primary catalog. Keep
    // other sources in staff triage, but never send an unusable client action.
    // Suppress after claiming so unsupported intent cannot remain queued forever.
    if (row.recipient_kind === "client_requester" && (row.catalog_source_id !== PRIMARY_ALPHA_SOURCE_ID ||
      (row.account_source_id !== null && row.account_source_id !== PRIMARY_ALPHA_SOURCE_ID) ||
      (row.project_source_id !== null && row.project_source_id !== PRIMARY_ALPHA_SOURCE_ID))) {
      const reason = row.catalog_source_id !== PRIMARY_ALPHA_SOURCE_ID ? "unsupported-catalog-source" : "unsupported-business-source";
      await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status='suppressed',lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing'")
        .bind(reason, row.id).run();
      await auditClientRequestNotification(env, "client_request_notification.suppressed", row, { attempt, reason });
      continue;
    }
    const recipient = row.recipient_kind === "staff_triage" ? normalizeRecipientEmail(env.CLIENT_REQUEST_TRIAGE_TO) : normalizeRecipientEmail(row.requester_email);
    if (!recipient) {
      const staffRecipientMissing = row.recipient_kind === "staff_triage";
      await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status=?,lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing'")
        .bind(staffRecipientMissing ? "failed" : "suppressed", staffRecipientMissing ? "staff-triage-recipient-not-configured" : "requester-email-unavailable", row.id).run();
      await auditClientRequestNotification(env, staffRecipientMissing ? "client_request_notification.failed" : "client_request_notification.suppressed", row, { attempt });
      if (staffRecipientMissing)
        await sendAdminAlert(env, "Client request triage is not configured", `Notification ${row.id} for request ${row.request_id} could not be routed to staff.`);
      continue;
    }
    try {
      const snapshot = notificationSnapshot(row);
      const rendered = renderClientRequestNotification(snapshot, actionUrl(env, row, snapshot));
      if (row.recipient_kind === "client_requester" && portalInboxAvailable) {
        const completed = snapshot.lifecycle === "completed";
        const estimate = snapshot.lifecycle === "estimate_ready";
        const workArea = snapshot.lifecycle === "work_area_changed";
        await env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO client_portal_notifications
          (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), row.account_id, row.requester_identity_id,
            completed ? "request_completed" : estimate ? "estimate_ready" : workArea ? "work_area_changed" : "request_status", "service_request", row.request_id,
            `service-request:${row.id}`, rendered.subject.slice(0, 160),
            (workArea && snapshot.changeSummary ? snapshot.changeSummary : lifecyclePresentation[snapshot.lifecycle].introduction).slice(0, 500),
            "/portal/requests").run();
      }
      await sendNotificationMail(env, { to: recipient, fromName: "LTDS Client Portal", subject: rendered.subject, text: rendered.text, html: rendered.html, messageIdKey: row.id });
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
