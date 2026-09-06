import {
  buildServiceRequestNotificationSnapshot,
  parseServiceRequestNotificationSnapshot,
  PRIMARY_ALPHA_SOURCE_ID,
  createCatalogSourceContext,
  type ServiceRequestNotificationLifecycle,
  type ServiceRequestNotificationSnapshot,
  NATIVE_PORTAL_TARGET_SCOPES_SQL,
} from "@ltds/shared";
import { portalAutomaticEligibilityEnabled } from "./portal-automatic-eligibility";
import type { Env } from "./types";
import { sendAdminAlert } from "./alerts";
import { sendNotificationMail } from "./mailer";
import { d1TablesPresent } from "./schema-readiness";
import { projectAlphaDeliveryPrincipalGuard, resolveProjectAlphaDeliveryPrincipal } from "./share-recipients";
import { HTTPException } from "hono/http-exception";
import { advanceNotificationSourceSchedule, nativeBindingGuard, nativeDeliveryNotificationsReady,
  processPortalDeliveryNotificationBatches, scheduledNotificationSources } from "./portal-delivery-notification-batches";
import { recoverDeliveryShareSecret } from "./delivery-secret-recovery";
import { publicShareOrigin } from "./origins";
import { portalRootAccessAllowedSql } from "./client-portal-root-access";

export type NotificationKind = "share_created" | "share_updated" | "share_revoked" | "first_access" | "expiring_72h";
export interface NotificationPayload { publicId?: string | null; shareUrl?: string; clientName?: string; projectName?: string; r2Prefix?: string; expiresAt?: string | null; }
export type StoredNotificationPayload = Omit<NotificationPayload, "shareUrl">;
type NotificationRecipientAuthority = "direct_email" | "directory_principal";
interface NotificationRow {
  id: string;
  share_id: string;
  kind: NotificationKind;
  recipient_email: string;
  payload_json: string;
  attempts: number;
  share_version: number | null;
  recipient_authority_kind: NotificationRecipientAuthority | null;
  recipient_principal_public_id: string | null;
}
const MAX_ATTEMPTS = 3;
type DirectPortalNotificationRow={id:string;event_type:"granted"|"revoked";principal_public_id:string;
  principal_source_version:string;attempt_count:number;r2_prefix:string;
  owner_scope_type:"organization"|"department"|"client"|"project";owner_public_id:string;
  workspace_id:string;folder_binding_id:string;binding_source_version:string;grant_version:number;
  grant_status:"active"|"revoked";revoked_at:string|null;expires_at:string|null;source_id:string};
const DIRECT_SOURCE_INDEXES=["idx_project_alpha_delivery_notification_source_direct_pending",
  "idx_project_alpha_delivery_notification_source_processing",
  "idx_project_alpha_delivery_notification_ready_pending",
  "idx_project_alpha_delivery_notification_ready_processing",
  "idx_project_alpha_delivery_notification_pending_exhausted",
  "idx_project_alpha_delivery_notification_processing_exhausted"] as const;

type ClientPortalRequestEvent = "request_submitted" | "request_status_changed" | "request_confirmation_requested" | "request_client_response" | "request_work_area_changed" | "pa_draft_quote_created";
type ClientPortalRequestRecipient = "staff_triage" | "client_requester" | "native_request_owner";
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
  portal_workspace_id: string | null;
  portal_identity_id: string | null;
}

interface NativeRequestOwnerProof {
  workspaceId: string;
  identityId: string;
  sourceId: string;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  generationId: string;
  sourceSequence: number;
  authorityRevision: number;
  authorityVersion: number;
  connectorRevision: number;
  connectorVersion: number;
  projectPublicId: string | null;
  scopes: string;
}

/** Builds a current native request-owner proof from the same bounded scope
 * query used by Client.  It deliberately has no email fallback: ambiguity,
 * stale generations, revoked identity/membership, or lost project scope all
 * suppress this in-app-only intent. */
async function nativeRequestOwnerProof(env: Env, row: ClientPortalRequestNotificationRow): Promise<NativeRequestOwnerProof | null> {
  if (!row.portal_workspace_id || !row.portal_identity_id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.request_id)) return null;
  const context = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT workspace.root_type rootType,
      COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) rootPublicId,
      checkpoint.active_generation_id generationId,checkpoint.source_sequence sourceSequence,
      authority.active_revision authorityRevision,authority.version authorityVersion,
      authority.connector_revision connectorRevision,authority.connector_version connectorVersion
    FROM client_service_requests request
    JOIN portal_v2_workspaces workspace ON workspace.id=request.portal_workspace_id AND workspace.status='active'
      AND workspace.legacy_account_id IS NULL AND workspace.project_alpha_source_id=request.catalog_source_id
    JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id AND owner.projection_source_id=workspace.project_alpha_source_id
    JOIN pa_portal_source_authorities authority ON authority.source_id=workspace.project_alpha_source_id AND authority.state='active'
    JOIN portal_v2_identities identity ON identity.id=request.portal_identity_id AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id AND membership.identity_id=identity.id
      AND membership.status='active' AND membership.revoked_at IS NULL AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=workspace.id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=checkpoint.active_generation_id
      AND root.entity_type=workspace.root_type AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root.active=1
    WHERE request.id=? AND request.catalog_source_id=? AND request.portal_workspace_id=? AND request.portal_identity_id=?
      AND ${portalRootAccessAllowedSql(env, "workspace")}
      AND (membership.source_type<>'project_alpha' OR EXISTS(SELECT 1 FROM pa_portal_principals principal
        WHERE principal.workspace_id=workspace.id AND principal.identity_id=identity.id AND principal.status='active'
          AND principal.source_version=membership.source_version AND lower(principal.email_hint)=lower(identity.verified_email)))`)
    .bind(row.request_id,row.catalog_source_id,row.portal_workspace_id,row.portal_identity_id)
    .first<Omit<NativeRequestOwnerProof, "workspaceId" | "identityId" | "sourceId" | "scopes">>();
  if (!context || !["organization", "standalone_client"].includes(context.rootType)) return null;
  // The outbox read intentionally does not expose the native project public id;
  // get it from its immutable request row before evaluating the shared scope SQL.
  const requestTarget = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT portal_project_public_id project_public_id
    FROM client_service_requests WHERE id=? AND portal_workspace_id=? AND portal_identity_id=? AND catalog_source_id=?`)
    .bind(row.request_id,row.portal_workspace_id,row.portal_identity_id,row.catalog_source_id).first<{ project_public_id: string | null }>();
  if (!requestTarget || (requestTarget.project_public_id !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestTarget.project_public_id))) return null;
  const project = requestTarget.project_public_id;
  const relations = env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true";
  const scoped = await env.DELIVERY_DB.withSession("first-primary").prepare(NATIVE_PORTAL_TARGET_SCOPES_SQL)
    .bind(JSON.stringify([{ scopeType: project ? "project" : context.rootType, publicId: project ?? context.rootPublicId }]),row.portal_workspace_id,context.generationId,relations ? 1 : 0,66)
    .all<{ entity_type: string; public_id: string; retained: number; depth: number }>();
  if (scoped.results.length === 0 || scoped.results.length > (relations ? 64 : 10) || scoped.results.some(item => item.retained <= 0 || (relations && item.depth >= 12))) return null;
  const scopes = [...new Set(scoped.results.map(item => `${item.entity_type}:${item.public_id}`))];
  if (!relations && scopes.length !== scoped.results.length) return null;
  if ((project && !scopes.includes(`project:${project}`)) || !scopes.includes(`${context.rootType}:${context.rootPublicId}`)) return null;
  scopes.push(`workspace:${row.portal_workspace_id}`);
  return { workspaceId: row.portal_workspace_id, identityId: row.portal_identity_id, sourceId: row.catalog_source_id, projectPublicId: project,
    rootType: context.rootType, rootPublicId: context.rootPublicId,
    generationId: context.generationId, sourceSequence: context.sourceSequence, authorityRevision: context.authorityRevision,
    authorityVersion: context.authorityVersion, connectorRevision: context.connectorRevision, connectorVersion: context.connectorVersion,
    scopes: JSON.stringify(scopes.sort()) };
}

function nativeRequestOwnerGuard(env: Env, proof: NativeRequestOwnerProof, row: ClientPortalRequestNotificationRow): { sql: string; bindings: unknown[] } {
  const retention = env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true" ? `AND NOT EXISTS(
    SELECT 1 FROM json_each(?) target WHERE substr(target.value,1,8)='project:'
      AND NOT EXISTS(SELECT 1 FROM portal_v2_project_lifecycle lifecycle
        WHERE lifecycle.workspace_id=workspace.id AND lifecycle.generation_id=checkpoint.active_generation_id
          AND lifecycle.project_public_id=substr(target.value,9)
          AND (lifecycle.lifecycle_status='active' OR (lifecycle.lifecycle_status='completed'
            AND datetime(lifecycle.completed_at,'+30 days')>datetime('now')))))` : "";
  const denial = env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? `AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial
      WHERE denial.identity_id=identity.id AND denial.status='active' AND denial.revoked_at IS NULL
        AND datetime(denial.valid_from)<=datetime('now') AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
        AND (denial.scope_type='global' OR (denial.workspace_id=workspace.id AND denial.scope_public_id IS NOT NULL
          AND (denial.scope_type || ':' || denial.scope_public_id) IN (SELECT value FROM json_each(?)))))` : "";
  return { sql: `EXISTS(SELECT 1 FROM client_portal_notification_outbox outbox
    JOIN client_service_requests request ON request.id=outbox.request_id AND request.catalog_source_id=?
      AND request.portal_workspace_id=? AND request.portal_identity_id=? AND request.portal_project_public_id IS ?
      AND request.id=? AND request.account_id=? AND request.created_by_identity_id=?
    JOIN request_pa_draft_quote_receipts receipt ON outbox.dedupe_key=('pa_draft_quote_created:' || receipt.id || ':native_request_owner')
      AND receipt.request_id=request.id AND receipt.source_id=request.catalog_source_id AND receipt.scope_stale_at IS NULL
      AND receipt.request_revision=COALESCE((SELECT MAX(revision_number) FROM request_revisions WHERE request_id=request.id),0)
      AND receipt.area_revision=COALESCE((SELECT MAX(revision_number) FROM client_service_request_area_revisions WHERE request_id=request.id),0)
    JOIN portal_v2_workspaces workspace ON workspace.id=request.portal_workspace_id
    JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id AND owner.projection_source_id=workspace.project_alpha_source_id
    JOIN pa_portal_source_authorities authority ON authority.source_id=workspace.project_alpha_source_id AND authority.state='active'
      AND authority.active_revision=? AND authority.version=? AND authority.connector_revision=? AND authority.connector_version=?
    JOIN portal_v2_identities identity ON identity.id=? AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id AND membership.identity_id=identity.id
      AND membership.status='active' AND membership.revoked_at IS NULL AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id AND checkpoint.active_generation_id=? AND checkpoint.source_sequence=?
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=workspace.id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=checkpoint.active_generation_id
      AND root.entity_type=? AND root.public_id=? AND root.active=1
      AND root.entity_type=workspace.root_type AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
    WHERE outbox.id=? AND outbox.event_type='pa_draft_quote_created' AND outbox.recipient_kind='native_request_owner'
      AND outbox.status='processing' AND outbox.attempt_count=? AND outbox.lease_expires_at IS NOT NULL
      AND datetime(outbox.lease_expires_at)>datetime('now') AND workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.status='active' AND workspace.legacy_account_id IS NULL
      AND ${portalRootAccessAllowedSql(env, "workspace")}
      AND (membership.source_type<>'project_alpha' OR EXISTS(SELECT 1 FROM pa_portal_principals principal
        WHERE principal.workspace_id=workspace.id AND principal.identity_id=identity.id AND principal.status='active'
          AND principal.source_version=membership.source_version AND lower(principal.email_hint)=lower(identity.verified_email)))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM portal_v2_directory_entities project WHERE project.workspace_id=workspace.id
        AND project.generation_id=checkpoint.active_generation_id AND project.entity_type='project' AND project.active=1
        AND ('project:' || project.public_id) IN (SELECT value FROM json_each(?))))
      ${retention}
      ${denial}
      AND (SELECT count(*) FROM portal_v2_entitlements counted WHERE counted.workspace_id=workspace.id AND counted.identity_id=identity.id
        AND counted.capability='request.create' AND counted.status='active' AND counted.revoked_at IS NULL
        AND datetime(counted.valid_from)<=datetime('now') AND (counted.expires_at IS NULL OR datetime(counted.expires_at)>datetime('now')))<=200
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement WHERE entitlement.workspace_id=workspace.id AND entitlement.identity_id=identity.id
        AND entitlement.capability='request.create' AND entitlement.effect='deny' AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now') AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
        AND (entitlement.scope_type || ':' || entitlement.scope_public_id) IN (SELECT value FROM json_each(?)))
      AND EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement WHERE entitlement.workspace_id=workspace.id AND entitlement.identity_id=identity.id
        AND entitlement.capability='request.create' AND entitlement.effect='allow' AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now') AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
        AND (entitlement.scope_type || ':' || entitlement.scope_public_id) IN (SELECT value FROM json_each(?))))`,
    bindings: [proof.sourceId,proof.workspaceId,proof.identityId,proof.projectPublicId,row.request_id,row.account_id,row.requester_identity_id,proof.authorityRevision,proof.authorityVersion,proof.connectorRevision,proof.connectorVersion,proof.identityId,
      proof.generationId,proof.sourceSequence,proof.rootType,proof.rootPublicId,row.id,row.attempt_count+1,proof.workspaceId,proof.sourceId,proof.projectPublicId,proof.scopes,
      ...(env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true" ? [proof.scopes] : []),
      ...(env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? [proof.scopes] : []),proof.scopes,proof.scopes] };
}

export function normalizeRecipientEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Recipient email must be a string");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Recipient email is invalid");
  return email;
}

export function notificationDedupeKey(kind: NotificationKind, shareId: string, discriminator = ""): string { return `${kind}:${shareId}${discriminator ? `:${discriminator}` : ""}`; }

export function notificationStatement(env: Env, input: {
  shareId: string;
  kind: NotificationKind;
  recipientEmail: string | null;
  payload: StoredNotificationPayload;
  dedupeKey?: string;
  shareVersion?: number | null;
  recipientPrincipalPublicId?: string | null;
}): D1PreparedStatement | null {
  if (!input.recipientEmail) return null;
  const bearerBearing = input.kind === "share_created" || input.kind === "share_updated";
  if (bearerBearing && (!Number.isInteger(input.shareVersion) || Number(input.shareVersion) < 1))
    throw new Error("Bearer-bearing delivery notifications require an immutable share version");
  const recipientAuthorityKind: NotificationRecipientAuthority | null = bearerBearing
    ? (input.recipientPrincipalPublicId ? "directory_principal" : "direct_email")
    : null;
  return env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO delivery_notifications
    (id,dedupe_key,share_id,kind,recipient_email,payload_json,share_version,recipient_authority_kind,recipient_principal_public_id)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), input.dedupeKey || notificationDedupeKey(input.kind, input.shareId), input.shareId, input.kind,
      input.recipientEmail, JSON.stringify(input.payload), bearerBearing ? input.shareVersion : null,
      recipientAuthorityKind, recipientAuthorityKind === "directory_principal" ? input.recipientPrincipalPublicId : null);
}

function storedPayload(raw: string): { payload: StoredNotificationPayload; legacyShareUrl: string | null } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Delivery notification payload is invalid");
  const value = parsed as Record<string, unknown>;
  return { payload: {
    publicId: typeof value.publicId === "string" || value.publicId === null ? value.publicId : undefined,
    clientName: typeof value.clientName === "string" ? value.clientName : undefined,
    projectName: typeof value.projectName === "string" ? value.projectName : undefined,
    r2Prefix: typeof value.r2Prefix === "string" ? value.r2Prefix : undefined,
    expiresAt: typeof value.expiresAt === "string" || value.expiresAt === null ? value.expiresAt : undefined,
  }, legacyShareUrl: typeof value.shareUrl === "string" ? value.shareUrl : null };
}

function compatibleLegacyShareUrl(env: Env, value: string | null, publicId: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.origin !== publicShareOrigin(env)
      || url.pathname !== `/s/${encodeURIComponent(publicId)}` || url.search)
      return null;
    return /^[A-Za-z0-9_-]{43}$/.test(url.hash.slice(1)) ? url.toString() : null;
  } catch { return null; }
}

async function materializeNotificationPayload(env: Env, row: NotificationRow): Promise<NotificationPayload> {
  const stored = storedPayload(row.payload_json), payload = stored.payload;
  if (row.kind !== "share_created" && row.kind !== "share_updated") return payload;
  if (!row.share_version || !row.recipient_authority_kind)
    throw new HTTPException(409, { message: "Delivery notification authority is unavailable" });
  if (row.recipient_authority_kind === "directory_principal" && !row.recipient_principal_public_id)
    throw new HTTPException(409, { message: "Delivery notification recipient authority is unavailable" });
  const share = await env.DELIVERY_DB.prepare(`SELECT id,public_id,secret_ciphertext,secret_iv,revoked_at,expires_at
    FROM shares WHERE id=? AND share_version=? AND (
      (?='direct_email' AND lower(recipient_email)=lower(?)) OR
      (?='directory_principal' AND EXISTS(
        SELECT 1 FROM delivery_share_recipient_members member
        WHERE member.share_id=shares.id AND member.share_version=shares.share_version
          AND member.recipient_principal_public_id=?
          AND lower(member.recipient_normalized_email)=lower(?)
      ))
    )`).bind(row.share_id,row.share_version,row.recipient_authority_kind,row.recipient_email,
      row.recipient_authority_kind,row.recipient_principal_public_id,row.recipient_email).first<{
      id:string; public_id:string|null; secret_ciphertext:string|null; secret_iv:string|null;
      revoked_at:string|null; expires_at:string|null;
    }>();
  if (!share || share.revoked_at || (share.expires_at && Date.parse(share.expires_at) <= Date.now()))
    throw new HTTPException(409, { message: "Delivery link is no longer active" });
  if (!share.public_id) throw new Error("Delivery link public identity is unavailable");
  const secret = await recoverDeliveryShareSecret(env, share);
  const shareUrl = secret
    ? `${publicShareOrigin(env)}/s/${encodeURIComponent(share.public_id)}#${secret}`
    : compatibleLegacyShareUrl(env, stored.legacyShareUrl, share.public_id);
  if (!shareUrl) throw new Error("Delivery link bearer cannot be recovered");
  return {
    ...payload,
    publicId: share.public_id,
    shareUrl,
  };
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
    .bind(action, row.share_id, JSON.stringify({ notificationId: row.id, kind: row.kind,
      shareVersion: row.share_version, recipientAuthorityKind: row.recipient_authority_kind,
      recipientPrincipalPublicId: row.recipient_principal_public_id, ...detail })).run();
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
    const row = await env.DELIVERY_DB.prepare(`SELECT id,share_id,kind,recipient_email,payload_json,attempts,
        share_version,recipient_authority_kind,recipient_principal_public_id FROM delivery_notifications
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
        authority.workspace_id,authority.folder_binding_id,authority.directory_generation_id,workspace.project_alpha_source_id,
        authority.status authority_status,share.revoked_at,share.expires_at,binding.r2_prefix,
        CASE WHEN binding.id IS NOT NULL AND checkpoint.active_generation_id=authority.directory_generation_id
          AND generation.id IS NOT NULL AND workspace.status='active'
          AND EXISTS(SELECT 1 FROM portal_v2_directory_entities owner
            WHERE owner.workspace_id=authority.workspace_id AND owner.generation_id=generation.id
              AND owner.entity_type=binding.owner_scope_type AND owner.public_id=binding.owner_public_id
              AND owner.active=1 AND owner.source_version=binding.source_version)
          AND EXISTS(SELECT 1 FROM project_alpha_delivery_intent_receipts receipt WHERE receipt.access_mode='guest'
            AND receipt.resource_id=authority.share_id AND receipt.project_alpha_source_id=workspace.project_alpha_source_id)
          THEN 1 ELSE 0 END source_context_live
        FROM project_alpha_delivery_guest_authority authority
        JOIN shares share ON share.id=authority.share_id
        LEFT JOIN portal_v2_workspaces workspace ON workspace.id=authority.workspace_id
        LEFT JOIN portal_v2_folder_bindings binding ON binding.id=authority.folder_binding_id
          AND binding.workspace_id=authority.workspace_id AND binding.source_version=authority.binding_source_version
          AND binding.status='active' AND binding.revoked_at IS NULL
        LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=authority.workspace_id
        LEFT JOIN portal_v2_directory_generations generation ON generation.id=authority.directory_generation_id
          AND generation.workspace_id=authority.workspace_id AND generation.status='active' AND generation.complete=1
        WHERE authority.share_id=? LIMIT 2`).bind(row.share_id)
        .all<{principal_public_id:string;principal_source_version:string;workspace_id:string;folder_binding_id:string;directory_generation_id:string;
          project_alpha_source_id:string;authority_status:"active"|"revoked";revoked_at:string|null;expires_at:string|null;r2_prefix:string|null;source_context_live:number}>();
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
          authority.r2_prefix,authority.principal_public_id,authority.principal_source_version,
          createCatalogSourceContext(authority.project_alpha_source_id));
        if(recipient.workspaceId!==authority.workspace_id||recipient.folderBindingId!==authority.folder_binding_id||
          recipient.directoryGenerationId!==authority.directory_generation_id||
          recipient.recipients.length!==1||recipient.recipients[0]!.email!==row.recipient_email)
          throw new HTTPException(409,{message:"Delivery recipient is no longer eligible"});
      }
      const rendered = renderNotification(row.kind, await materializeNotificationPayload(env, row));
      await sendNotificationMail(env, { to: row.recipient_email, fromName: "LTDS Client Delivery", subject: rendered.subject, text: rendered.text, html: rendered.html, messageIdKey: row.id });
      const sent=await env.DELIVERY_DB.prepare("UPDATE delivery_notifications SET status='sent',sent_at=datetime('now'),lease_until=NULL,updated_at=datetime('now') WHERE id=? AND status='sending'").bind(row.id).run();
      if(sent.meta.changes===1){
        await auditNotification(env, "notification.sent", row, { attempt });
      }else{
        // The provider accepted this exact, previously-authorized generation,
        // but a concurrent recipient rotation terminally suppressed its local
        // row before the acknowledgement returned. The bearer in that message
        // belongs to the old generation and is no longer usable. Preserve the
        // provider outcome without falsely changing the delivery state to sent
        // or making the row retryable.
        const accepted=await env.DELIVERY_DB.prepare(`UPDATE delivery_notifications
          SET last_error='provider-accepted-after-suppression',lease_until=NULL,updated_at=datetime('now')
          WHERE id=? AND status='failed' AND last_error IN ('share-authorization-rotated','recipient-no-longer-eligible')`)
          .bind(row.id).run();
        if(accepted.meta.changes===1)
          await auditNotification(env,"notification.provider_accepted_after_suppression",row,{attempt});
      }
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
  const staging=await nativeDeliveryNotificationsReady(env);
  const stagedProcessed=staging?await processPortalDeliveryNotificationBatches(env):0;
  const sourceAuthoritiesReady=await d1TablesPresent(env.DELIVERY_DB,[
    "pa_portal_source_authorities","pa_portal_source_authority_revisions",
  ]);
  // Never let the direct sender race adoption. Already attempted/inflight jobs
  // and revocations retain their original outbox/provider identity unchanged.
  const directLane=staging?"AND NOT(outbox.event_type='granted' AND outbox.status='pending' AND outbox.attempt_count=0 AND outbox.lease_expires_at IS NULL)":"";
  const liveSource=sourceAuthoritiesReady
    ? `(workspace.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}' OR EXISTS(
        SELECT 1 FROM pa_portal_source_authorities authority
        JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id
          AND revision.revision=authority.active_revision
        WHERE authority.source_id=workspace.project_alpha_source_id AND authority.state='active'))`
    : `workspace.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}'`;
  const liveOwner=`EXISTS(SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities owner ON owner.workspace_id=checkpoint.workspace_id AND owner.generation_id=generation.id
      AND owner.entity_type=binding.owner_scope_type AND owner.public_id=binding.owner_public_id
      AND owner.active=1 AND owner.source_version=binding.source_version
    WHERE checkpoint.workspace_id=grant_record.workspace_id)`;
  const placeholders=DIRECT_SOURCE_INDEXES.map(()=>"?").join(",");
  const directSourceIndexes=await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT count(*) count FROM sqlite_master WHERE type='index' AND name IN (${placeholders})`,
  ).bind(...DIRECT_SOURCE_INDEXES).first<number>("count");
  const indexesReady=directSourceIndexes===DIRECT_SOURCE_INDEXES.length;
  const exhausted=indexesReady?(await Promise.all([
    env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id FROM project_alpha_delivery_portal_notification_outbox
      INDEXED BY idx_project_alpha_delivery_notification_pending_exhausted
      WHERE status='pending' AND attempt_count>=3 AND next_attempt_at<=datetime('now')
      ORDER BY next_attempt_at,created_at,id LIMIT 50`).all<{id:string}>(),
    env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id FROM project_alpha_delivery_portal_notification_outbox
      INDEXED BY idx_project_alpha_delivery_notification_processing_exhausted
      WHERE status='processing' AND attempt_count>=3 AND lease_expires_at<=datetime('now')
      ORDER BY lease_expires_at,created_at,id LIMIT 50`).all<{id:string}>(),
  ])).flatMap(result=>result.results):[];
  if(exhausted.length)await env.DELIVERY_DB.batch(exhausted.map(row=>env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox
    SET status='failed',lease_expires_at=NULL,last_error='attempts-exhausted',updated_at=datetime('now')
    WHERE id=? AND attempt_count>=? AND ((status='pending' AND datetime(next_attempt_at)<=datetime('now'))
      OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))` ).bind(row.id,MAX_ATTEMPTS)));
  let fairIds:string[]=[];
  if(indexesReady){
    const sources=await scheduledNotificationSources(env,"direct");
    const groups=await Promise.all(sources.map(async source=>{
      const rows=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,created_at,source_id FROM (
          SELECT id,created_at,project_alpha_source_id source_id FROM project_alpha_delivery_portal_notification_outbox
            INDEXED BY idx_project_alpha_delivery_notification_source_direct_pending
          WHERE project_alpha_source_id=?1 AND status='pending' AND attempt_count<3 AND next_attempt_at<=datetime('now')
            AND NOT(event_type='granted' AND attempt_count=0 AND lease_expires_at IS NULL)
          ORDER BY next_attempt_at,created_at,id LIMIT 25
        ) UNION ALL SELECT id,created_at,source_id FROM (
          SELECT id,created_at,project_alpha_source_id source_id FROM project_alpha_delivery_portal_notification_outbox
            INDEXED BY idx_project_alpha_delivery_notification_source_processing
          WHERE project_alpha_source_id=?1 AND status='processing' AND attempt_count<3 AND lease_expires_at<=datetime('now')
          ORDER BY lease_expires_at,created_at,id LIMIT 25
        )`).bind(source).all<{id:string;created_at:string;source_id:string}>();
      return rows.results.sort((left,right)=>left.created_at.localeCompare(right.created_at)||left.id.localeCompare(right.id));
    }));
    for(let rank=0;rank<50&&fairIds.length<25;rank++){
      const round=groups.flatMap(group=>group[rank]?[group[rank]!]:[]);
      fairIds.push(...round.slice(0,25-fairIds.length).map(row=>row.id));
    }
    const lastId=fairIds.at(-1),lastSource=lastId?groups.flat().find(row=>row.id===lastId):null;
    if(lastSource)await advanceNotificationSourceSchedule(env,"direct",lastSource.source_id);
    // Invalid or retired provenance cannot appear in the registered-source
    // probes. Reserve one bounded cleanup slot so old synthetic rows reach a
    // terminal state without restoring the former whole-table sweep.
    const [pendingProbe,processingProbe]=await Promise.all([
      env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,project_alpha_source_id source_id
        FROM project_alpha_delivery_portal_notification_outbox INDEXED BY idx_project_alpha_delivery_notification_ready_pending
        WHERE status='pending' AND attempt_count<3 AND next_attempt_at<=datetime('now')
        ORDER BY next_attempt_at,created_at,id LIMIT 25`).all<{id:string;source_id:string|null}>(),
      env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,project_alpha_source_id source_id
        FROM project_alpha_delivery_portal_notification_outbox INDEXED BY idx_project_alpha_delivery_notification_ready_processing
        WHERE status='processing' AND attempt_count<3 AND lease_expires_at<=datetime('now')
        ORDER BY lease_expires_at,created_at,id LIMIT 25`).all<{id:string;source_id:string|null}>(),
    ]);
    const registered=new Set(sources),orphan=[...pendingProbe.results,...processingProbe.results]
      .find(candidate=>!candidate.source_id||!registered.has(candidate.source_id))?.id;
    if(orphan&&!fairIds.includes(orphan)){
      if(fairIds.length===25)fairIds[24]=orphan;else fairIds.push(orphan);
    }
  }else{
    fairIds=(await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT outbox.id
      FROM project_alpha_delivery_portal_notification_outbox outbox
      WHERE outbox.attempt_count<3 AND ((outbox.status='pending' AND datetime(outbox.next_attempt_at)<=datetime('now'))
        OR (outbox.status='processing' AND datetime(outbox.lease_expires_at)<=datetime('now')))
      ${directLane} ORDER BY outbox.created_at,outbox.id LIMIT 25`).all<{id:string}>()).results.map(row=>row.id);
  }
  let processed=0;
  for(const targetId of fairIds){
    const row=await env.DELIVERY_DB.prepare(`SELECT outbox.id,outbox.event_type,outbox.principal_public_id,
      outbox.principal_source_version,outbox.attempt_count,binding.r2_prefix,binding.owner_scope_type,binding.owner_public_id,
      grant_record.workspace_id,grant_record.folder_binding_id,grant_record.binding_source_version,grant_record.grant_version,
      grant_record.status grant_status,grant_record.revoked_at,grant_record.expires_at,workspace.project_alpha_source_id source_id
      FROM project_alpha_delivery_portal_notification_outbox outbox
      JOIN project_alpha_delivery_portal_grants grant_record ON grant_record.id=outbox.grant_id
      JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id AND workspace.status='active'
      JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=outbox.receipt_id
        AND receipt.access_mode='portal' AND receipt.resource_id=grant_record.id
        AND receipt.project_alpha_source_id=workspace.project_alpha_source_id
      JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
        AND binding.workspace_id=grant_record.workspace_id AND binding.status='active' AND binding.revoked_at IS NULL
        AND binding.source_version=grant_record.binding_source_version
      WHERE ((outbox.status='pending' AND datetime(outbox.next_attempt_at)<=datetime('now')) OR
        (outbox.status='processing' AND datetime(outbox.lease_expires_at)<=datetime('now')))
        AND outbox.id=? AND outbox.attempt_count<3
        ${directLane}
        AND ${liveSource} AND ${liveOwner} AND ${portalRootAccessAllowedSql(env, "workspace")}
        AND ((outbox.event_type='revoked' AND grant_record.status='revoked' AND grant_record.revoked_at IS NOT NULL)
          OR (outbox.event_type='granted' AND grant_record.status='active' AND
          (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))))
      ORDER BY outbox.created_at LIMIT 1`)
      .bind(targetId).first<DirectPortalNotificationRow>();
    if(!row){
      await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='suppressed',
        lease_expires_at=NULL,last_error='authorization-no-longer-live',updated_at=datetime('now')
        WHERE id=? AND attempt_count<3 AND ((status='pending' AND datetime(next_attempt_at)<=datetime('now'))
          OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))` ).bind(targetId).run();
      continue;
    }
    const claimed=await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='processing',attempt_count=attempt_count+1,lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now') WHERE id=? AND
      attempt_count=? AND attempt_count<3 AND ((status='pending' AND datetime(next_attempt_at)<=datetime('now')) OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))` )
      .bind(row.id,row.attempt_count).run();
    if(!claimed.meta.changes)continue;
    processed+=1;
    const claimedAttempt=row.attempt_count+1;
    try{
      const source=createCatalogSourceContext(row.source_id);
      const recipient=await resolveProjectAlphaDeliveryPrincipal(env,row.r2_prefix,row.principal_public_id,row.principal_source_version,source);
      if(recipient.workspaceId!==row.workspace_id||recipient.folderBindingId!==row.folder_binding_id)
        throw new HTTPException(409,{message:"Delivery recipient binding changed"});
      const recipientEmail=recipient.recipients[0]?.email;
      if(!recipientEmail)throw new Error("recipient-unavailable");
      const granted=row.event_type==="granted",url=`${env.DELIVERY_BASE_URL.replace(/\/$/,"")}/portal/deliveries`;
      const bindingGuard=nativeBindingGuard(env,{source_id:source.sourceId,workspace_id:row.workspace_id,
        folder_binding_id:row.folder_binding_id,binding_source_version:row.binding_source_version,
        principal_public_id:row.principal_public_id,principal_source_version:row.principal_source_version,
        owner_scope_type:row.owner_scope_type,owner_public_id:row.owner_public_id,r2_prefix:row.r2_prefix});
      const principalGuard=projectAlphaDeliveryPrincipalGuard(env,{audience:recipient,
        principalSourceVersion:row.principal_source_version,bindingSourceVersion:row.binding_source_version,
        prefix:row.r2_prefix,allowUnclaimed:portalAutomaticEligibilityEnabled(env),source});
      const grantState=granted
        ? "grant_record.status='active' AND grant_record.revoked_at IS NULL AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))"
        : "grant_record.status='revoked' AND grant_record.revoked_at IS NOT NULL";
      const publication=await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox
        SET lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now')
        WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')
        AND EXISTS(SELECT 1 FROM project_alpha_delivery_portal_grants grant_record
          WHERE grant_record.id=project_alpha_delivery_portal_notification_outbox.grant_id
          AND grant_record.grant_version=? AND ${grantState})
        AND ${bindingGuard.sql} AND ${principalGuard.sql}`)
        .bind(row.id,claimedAttempt,row.grant_version,...bindingGuard.bindings,...principalGuard.bindings).run();
      if(publication.meta.changes!==1)throw new HTTPException(409,{message:"Delivery publication authority changed"});
      await sendNotificationMail(env,{to:recipientEmail,fromName:"LTDS Client Delivery",
        subject:granted?"Delivery available in your portal":"Portal delivery access revoked",
        text:granted?`A delivery is available in your LTDS portal.\n\nOpen the portal: ${url}`:"Access to a delivery in your LTDS portal was revoked.",
        html:granted?`<p>A delivery is available in your LTDS portal.</p><p><a href="${escapeHtml(url)}">Open the portal</a></p>`:"<p>Access to a delivery in your LTDS portal was revoked.</p>",messageIdKey:row.id});
      await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,updated_at=datetime('now')
        WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')`).bind(row.id,claimedAttempt).run();
    }catch(error){if(error instanceof HTTPException){await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='suppressed',lease_expires_at=NULL,last_error='recipient-no-longer-eligible',updated_at=datetime('now')
        WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')`).bind(row.id,claimedAttempt).run();continue;}const attempt=claimedAttempt,terminal=attempt>=MAX_ATTEMPTS;
      await env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status=?,next_attempt_at=datetime('now',?),lease_expires_at=NULL,last_error=?,updated_at=datetime('now')
        WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')`).bind(terminal?"failed":"pending",terminal?"+0 seconds":`+${2**attempt*5} minutes`,(error instanceof Error?error.message:"email-send-failed").slice(0,240),row.id,claimedAttempt).run();}
  }
  return processed+stagedProcessed;
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
    subject: "Service request approved for quote preparation",
    status: "Approved — Project Alpha draft pending",
    introduction: "LTDS approved the operational request and is preparing a Project Alpha draft quote.",
  },
  accepted_linked: {
    subject: "Project Alpha draft quote created",
    status: "PA draft quote created",
    introduction: "A Project Alpha draft quote was created. This does not mean the client accepted it.",
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
    row.event_type === "pa_draft_quote_created"
      ? "accepted_linked"
      : row.event_type === "request_work_area_changed"
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
      r.catalog_source_id,r.title,r.project_id,r.service_category,r.location_text,r.latitude,r.longitude,p.project_name,r.account_id,r.created_by_identity_id requester_identity_id,r.portal_workspace_id,r.portal_identity_id,
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
      const suppressed = await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status='suppressed',lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')")
        .bind(reason, row.id, attempt).run();
      if (suppressed.meta.changes) await auditClientRequestNotification(env, "client_request_notification.suppressed", row, { attempt, reason });
      continue;
    }
    const native = row.recipient_kind === "native_request_owner";
    try {
    if (row.event_type === "pa_draft_quote_created" && !native) {
      const current = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT EXISTS(
        SELECT 1 FROM request_pa_draft_quote_receipts receipt
        JOIN client_service_requests request ON request.id=receipt.request_id AND request.catalog_source_id=receipt.source_id
        JOIN client_portal_notification_outbox outbox ON outbox.request_id=request.id
          AND outbox.dedupe_key=('pa_draft_quote_created:' || receipt.id || ':client_requester')
        WHERE outbox.id=? AND outbox.status='processing' AND outbox.attempt_count=? AND datetime(outbox.lease_expires_at)>datetime('now')
          AND request.id=? AND request.account_id=? AND request.created_by_identity_id=? AND request.catalog_source_id=?
          AND receipt.scope_stale_at IS NULL
          AND receipt.request_revision=COALESCE((SELECT MAX(revision_number) FROM request_revisions WHERE request_id=request.id),0)
          AND receipt.area_revision=COALESCE((SELECT MAX(revision_number) FROM client_service_request_area_revisions WHERE request_id=request.id),0)
      ) current`).bind(row.id,attempt,row.request_id,row.account_id,row.requester_identity_id,row.catalog_source_id).first<number>("current");
      if (current !== 1) {
        const suppressed = await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status='suppressed',lease_expires_at=NULL,last_error='draft-receipt-no-longer-current',updated_at=datetime('now') WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')").bind(row.id,attempt).run();
        if (suppressed.meta.changes) await auditClientRequestNotification(env,"client_request_notification.suppressed",row,{attempt,reason:"draft-receipt-no-longer-current"});
        continue;
      }
    }
    const recipient = native ? "native-in-app" : row.recipient_kind === "staff_triage" ? normalizeRecipientEmail(env.CLIENT_REQUEST_TRIAGE_TO) : normalizeRecipientEmail(row.requester_email);
    const nativeProof = native ? await nativeRequestOwnerProof(env, row) : null;
    if(native && !nativeProof) {
      const suppressed = await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status='suppressed',lease_expires_at=NULL,last_error='native-recipient-no-longer-authorized',updated_at=datetime('now') WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')").bind(row.id,attempt).run();
      if (suppressed.meta.changes) await auditClientRequestNotification(env,"client_request_notification.suppressed",row,{attempt,reason:"native-recipient-no-longer-authorized"});
      continue;
    }
    if (!recipient) {
      const staffRecipientMissing = row.recipient_kind === "staff_triage";
      const unavailable = await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status=?,lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')")
        .bind(staffRecipientMissing ? "failed" : "suppressed", staffRecipientMissing ? "staff-triage-recipient-not-configured" : "requester-email-unavailable", row.id, attempt).run();
      if (unavailable.meta.changes) await auditClientRequestNotification(env, staffRecipientMissing ? "client_request_notification.failed" : "client_request_notification.suppressed", row, { attempt });
      if (staffRecipientMissing && unavailable.meta.changes)
        await sendAdminAlert(env, "Client request triage is not configured", `Notification ${row.id} for request ${row.request_id} could not be routed to staff.`);
      continue;
    }
      const snapshot = notificationSnapshot(row);
      const rendered = renderClientRequestNotification(snapshot, actionUrl(env, row, snapshot));
      if (native) {
        if (!portalInboxAvailable) throw new Error("native-portal-inbox-unavailable");
        const guard = nativeRequestOwnerGuard(env, nativeProof!, row);
        const dedupeKey = `service-request:${row.id}`;
        const title = rendered.subject.slice(0,160);
        const body = lifecyclePresentation[snapshot.lifecycle].introduction.slice(0,500);
        // Recheck the exact inbox record inside the same transaction. A pre-read
        // cannot prove it still exists when a reclaimed outbox attempt commits.
        const exactInbox = `EXISTS(SELECT 1 FROM client_portal_notifications
          WHERE account_id=? AND recipient_identity_id=? AND event_type='pa_draft_quote_created'
            AND source_type='service_request' AND source_id=? AND dedupe_key=? AND title=? AND body=? AND action_path='/portal/requests')`;
        const inboxBindings = [row.account_id,row.requester_identity_id,row.request_id,dedupeKey,title,body];
        const inbox = env.DELIVERY_DB.prepare(`INSERT INTO client_portal_notifications
          (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
          SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}
          ON CONFLICT(recipient_identity_id,dedupe_key) DO NOTHING`).bind(crypto.randomUUID(),row.account_id,row.requester_identity_id,
            "pa_draft_quote_created","service_request",row.request_id,dedupeKey,title,body,"/portal/requests",...guard.bindings);
        const sent = env.DELIVERY_DB.prepare(`UPDATE client_portal_notification_outbox SET status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,updated_at=datetime('now')
          WHERE id=? AND status='processing' AND ${guard.sql} AND ${exactInbox}`).bind(row.id,...guard.bindings,...inboxBindings);
        const audit = env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
          SELECT 'system','client-request-notifications','client_request_notification.sent','client_service_request',?,? WHERE ${guard.sql} AND ${exactInbox}`)
          .bind(row.request_id,JSON.stringify({notificationId:row.id,eventType:row.event_type,recipientKind:row.recipient_kind,attempt}),...guard.bindings,...inboxBindings);
        // Audit before changing processing -> sent: the shared guard intentionally
        // requires our live claim. An exact duplicate inbox row is a valid replay.
        const results = await env.DELIVERY_DB.batch([inbox,audit,sent]);
        if (!results[1]?.meta.changes || !results[2]?.meta.changes) {
          const suppressed = await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status='suppressed',lease_expires_at=NULL,last_error='native-recipient-no-longer-authorized',updated_at=datetime('now') WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')").bind(row.id,attempt).run();
          if (suppressed.meta.changes) await auditClientRequestNotification(env,"client_request_notification.suppressed",row,{attempt,reason:"native-recipient-no-longer-authorized"});
        }
        continue;
      }
      if ((row.recipient_kind === "client_requester" || native) && portalInboxAvailable) {
        const completed = snapshot.lifecycle === "completed";
        const estimate = snapshot.lifecycle === "estimate_ready";
        const workArea = snapshot.lifecycle === "work_area_changed";
        await env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO client_portal_notifications
          (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), row.account_id, row.requester_identity_id,
            native && row.event_type === "pa_draft_quote_created" ? "pa_draft_quote_created" : completed ? "request_completed" : estimate ? "estimate_ready" : workArea ? "work_area_changed" : "request_status", "service_request", row.request_id,
            `service-request:${row.id}`, rendered.subject.slice(0, 160),
            (workArea && snapshot.changeSummary ? snapshot.changeSummary : lifecyclePresentation[snapshot.lifecycle].introduction).slice(0, 500),
            "/portal/requests").run();
      }
      if(!native) await sendNotificationMail(env, { to: recipient, fromName: "LTDS Client Portal", subject: rendered.subject, text: rendered.text, html: rendered.html, messageIdKey: row.id });
      const sent = await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')").bind(row.id, attempt).run();
      if (sent.meta.changes) await auditClientRequestNotification(env, "client_request_notification.sent", row, { attempt });
    } catch (error) {
      const message = (error instanceof Error ? error.message : "email-send-failed").slice(0, 240);
      const terminal = attempt >= MAX_ATTEMPTS;
      const retried = await env.DELIVERY_DB.prepare("UPDATE client_portal_notification_outbox SET status=?,next_attempt_at=datetime('now',?),lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing' AND attempt_count=? AND datetime(lease_expires_at)>datetime('now')")
        .bind(terminal ? "failed" : "pending", terminal ? "+0 seconds" : `+${2 ** attempt * 5} minutes`, message, row.id, attempt).run();
      if (retried.meta.changes) {
        await auditClientRequestNotification(env, terminal ? "client_request_notification.failed" : "client_request_notification.retry_scheduled", row, { attempt, error: message });
        if (terminal && !native) await sendAdminAlert(env, "Client request notification failed", `${row.event_type} notification ${row.id}: ${message}`);
      }
    }
  }
  return processed;
}
