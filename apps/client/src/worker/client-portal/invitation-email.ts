import type { Env } from "../types";
import { workspaceMembershipManagementEnabled } from "./workspace-memberships";
import {invitationRequestsReady,invitationPublicationSql} from './invitation-approval-policy';
import {reconcileExpiredWorkspaceInvitationApprovals} from './workspace-invitation-requests';

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60 * 1000;
const BASE_RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const SCRUBBED_PAYLOAD = JSON.stringify({ redacted: true });

interface InvitationEmailPayload {
  invitationId: string;
  token: string;
  expiresAt: string;
}

interface InvitationEmailRow {
  id: string;
  invitation_id: string;
  recipient_email: string;
  payload_json: string;
  attempts: number;
  lease_expires_at: string;
  workspace_name: string;
}

export interface InvitationEmailBatchResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
}

export function invitationEmailDeliveryEnabled(env: Env): boolean {
  if (!workspaceMembershipManagementEnabled(env)
    || env.CLIENT_PORTAL_ACCESS_ENROLLMENT_READY !== "true"
    || env.CLIENT_PORTAL_INVITATION_EMAIL_ENABLED !== "true") return false;
  if (!env.CLIENT_PORTAL_INVITATION_EMAIL || typeof env.CLIENT_PORTAL_INVITATION_EMAIL.send !== "function") return false;
  if (!normalizeEmail(env.CLIENT_PORTAL_INVITATION_FROM || "")) return false;
  try {
    const origin = new URL(env.CLIENT_PORTAL_ORIGIN || "");
    return origin.protocol === "https:" && origin.origin === env.CLIENT_PORTAL_ORIGIN && origin.pathname === "/";
  } catch {
    return false;
  }
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return normalized.length >= 3 && normalized.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized
    : null;
}

function parsePayload(value: string, expectedInvitationId: string): InvitationEmailPayload | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    if (Object.keys(object).sort().join(",") !== "expiresAt,invitationId,token") return null;
    if (object.invitationId !== expectedInvitationId) return null;
    if (typeof object.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(object.token)) return null;
    if (typeof object.expiresAt !== "string" || object.expiresAt.length > 64 || !Number.isFinite(Date.parse(object.expiresAt))) return null;
    return { invitationId: expectedInvitationId, token: object.token, expiresAt: object.expiresAt };
  } catch {
    return null;
  }
}

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function retryDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.max(0, attempt - 1)));
}

function errorCode(error: unknown): string {
  const value = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "E_UNKNOWN";
  return /^E_[A-Z0-9_]{1,60}$/.test(value) ? value : "E_UNKNOWN";
}

function isPermanentEmailError(code: string): boolean {
  return new Set([
    "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS",
    "E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED",
    "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_CONTENT_TOO_LARGE", "E_HEADER_NOT_ALLOWED",
    "E_HEADER_USE_API_FIELD", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG",
    "E_HEADER_NAME_INVALID", "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY",
  ]).has(code);
}

async function claimRows(env: Env, now: Date, limit: number): Promise<InvitationEmailRow[]> {
  const database = env.DELIVERY_DB;
  const publication=await invitationRequestsReady(database)?invitationPublicationSql('invitation'):'1';
  const nowIso = now.toISOString();
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const candidates = await database.prepare(`SELECT outbox.id FROM portal_v2_invitation_email_outbox outbox
    JOIN portal_v2_invitations invitation ON invitation.id=outbox.invitation_id
    JOIN portal_v2_invitation_access_enrollment_receipts receipt
      ON receipt.invitation_id=invitation.id AND receipt.workspace_id=invitation.workspace_id
      AND receipt.invited_email_hash=outbox.recipient_email_hash
      AND receipt.invitation_token_hash=invitation.token_hash
    WHERE ${publication} AND outbox.attempts<? AND datetime(outbox.next_attempt_at)<=datetime(?)
      AND (outbox.status IN ('pending','failed') OR (outbox.status='processing' AND datetime(outbox.lease_expires_at)<=datetime(?)))
      AND invitation.status='pending' AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime(?)
      AND receipt.revoked_at IS NULL AND datetime(receipt.enrolled_at)<=datetime(?) AND datetime(receipt.expires_at)>datetime(?)
    ORDER BY outbox.created_at,outbox.id LIMIT ?`)
    .bind(MAX_ATTEMPTS, nowIso, nowIso, nowIso, nowIso, nowIso, limit).all<{ id: string }>();
  const claimed: InvitationEmailRow[] = [];
  for (const candidate of candidates.results) {
    const updated = await database.prepare(`UPDATE portal_v2_invitation_email_outbox SET
      status='processing',attempts=attempts+1,lease_expires_at=?,updated_at=datetime(?)
      WHERE id=? AND attempts<? AND datetime(next_attempt_at)<=datetime(?)
        AND (status IN ('pending','failed') OR (status='processing' AND datetime(lease_expires_at)<=datetime(?)))
        AND EXISTS (SELECT 1 FROM portal_v2_invitations invitation
          JOIN portal_v2_invitation_access_enrollment_receipts receipt
            ON receipt.invitation_id=invitation.id AND receipt.workspace_id=invitation.workspace_id
            AND receipt.invited_email_hash=portal_v2_invitation_email_outbox.recipient_email_hash
            AND receipt.invitation_token_hash=invitation.token_hash
          WHERE ${publication} AND invitation.id=portal_v2_invitation_email_outbox.invitation_id
            AND invitation.status='pending' AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime(?)
            AND receipt.revoked_at IS NULL AND datetime(receipt.enrolled_at)<=datetime(?) AND datetime(receipt.expires_at)>datetime(?))`)
      .bind(lease, nowIso, candidate.id, MAX_ATTEMPTS, nowIso, nowIso, nowIso, nowIso, nowIso).run();
    if (updated.meta.changes !== 1) continue;
    const row = await database.prepare(`SELECT outbox.id,outbox.invitation_id,outbox.recipient_email,outbox.payload_json,
      outbox.attempts,outbox.lease_expires_at,workspace.display_name workspace_name
      FROM portal_v2_invitation_email_outbox outbox
      JOIN portal_v2_invitations invitation ON invitation.id=outbox.invitation_id
      JOIN portal_v2_workspaces workspace ON workspace.id=invitation.workspace_id
      JOIN portal_v2_invitation_access_enrollment_receipts receipt
        ON receipt.invitation_id=invitation.id AND receipt.workspace_id=invitation.workspace_id
        AND receipt.invited_email_hash=outbox.recipient_email_hash
        AND receipt.invitation_token_hash=invitation.token_hash
      WHERE outbox.id=? AND outbox.status='processing' AND outbox.lease_expires_at=?`)
      .bind(candidate.id, lease).first<InvitationEmailRow>();
    if (row) claimed.push(row);
  }
  return claimed;
}

async function cancelInvalidRows(env: Env, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  await env.DELIVERY_DB.prepare(`UPDATE portal_v2_invitation_email_outbox SET
    status='cancelled',payload_json=?,lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime(?)
    WHERE status IN ('pending','failed','processing') AND EXISTS (
      SELECT 1 FROM portal_v2_invitations invitation WHERE invitation.id=invitation_id
        AND (invitation.status<>'pending' OR invitation.revoked_at IS NOT NULL OR datetime(invitation.expires_at)<=datetime(?))
    )`).bind(SCRUBBED_PAYLOAD, nowIso, nowIso).run();
}

async function invitationStillSendable(env: Env, row: InvitationEmailRow, nowIso: string): Promise<boolean> {
  const publication=await invitationRequestsReady(env.DELIVERY_DB)?invitationPublicationSql('invitation'):'1';
  return (await env.DELIVERY_DB.prepare(`SELECT 1 ok FROM portal_v2_invitation_email_outbox outbox
    JOIN portal_v2_invitations invitation ON invitation.id=outbox.invitation_id
    JOIN portal_v2_invitation_access_enrollment_receipts receipt
      ON receipt.invitation_id=invitation.id AND receipt.workspace_id=invitation.workspace_id
      AND receipt.invited_email_hash=outbox.recipient_email_hash
      AND receipt.invitation_token_hash=invitation.token_hash
    WHERE ${publication} AND outbox.id=? AND outbox.status='processing' AND outbox.lease_expires_at=?
      AND lower(outbox.recipient_email)=lower(invitation.invited_email)
      AND invitation.status='pending' AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime(?)
      AND receipt.revoked_at IS NULL AND datetime(receipt.enrolled_at)<=datetime(?) AND datetime(receipt.expires_at)>datetime(?)`)
    .bind(row.id, row.lease_expires_at, nowIso, nowIso, nowIso).first("ok")) !== null;
}

async function invitationStillPending(env: Env, row: InvitationEmailRow, nowIso: string): Promise<boolean> {
  return (await env.DELIVERY_DB.prepare(`SELECT 1 ok FROM portal_v2_invitation_email_outbox outbox
    JOIN portal_v2_invitations invitation ON invitation.id=outbox.invitation_id
    WHERE outbox.id=? AND outbox.status='processing' AND outbox.lease_expires_at=?
      AND lower(outbox.recipient_email)=lower(invitation.invited_email)
      AND invitation.status='pending' AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime(?)`)
    .bind(row.id, row.lease_expires_at, nowIso).first("ok")) !== null;
}

async function releaseForEnrollmentRetry(env: Env, row: InvitationEmailRow, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const nextAttempt = new Date(now.getTime() + BASE_RETRY_MS).toISOString();
  const changed = await env.DELIVERY_DB.prepare(`UPDATE portal_v2_invitation_email_outbox SET
    status='pending',attempts=MAX(0,attempts-1),next_attempt_at=?,lease_expires_at=NULL,
    last_error_code='access_enrollment_unavailable',updated_at=datetime(?)
    WHERE id=? AND status='processing' AND lease_expires_at=?`)
    .bind(nextAttempt, nowIso, row.id, row.lease_expires_at).run();
  return changed.meta.changes;
}

export async function processInvitationEmailBatch(
  env: Env,
  options: { now?: Date; limit?: number } = {},
): Promise<InvitationEmailBatchResult> {
  const result: InvitationEmailBatchResult = { claimed: 0, sent: 0, retried: 0, failed: 0, cancelled: 0 };
  // Existing scheduled maintenance also recovers expired unsendable stages,
  // even when no mail provider is enabled. This grants or sends nothing.
  await reconcileExpiredWorkspaceInvitationApprovals(
    env.DELIVERY_DB,
    new Date(),
    env.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED === "true",
  );
  if (!invitationEmailDeliveryEnabled(env)) return result;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(options.limit ?? DEFAULT_BATCH_SIZE)));
  await cancelInvalidRows(env, now);
  const rows = await claimRows(env, now, limit);
  result.claimed = rows.length;
  for (const row of rows) {
    const payload = parsePayload(row.payload_json, row.invitation_id);
    const recipient = normalizeEmail(row.recipient_email);
    if (!payload || !recipient || Date.parse(payload.expiresAt) <= now.getTime()) {
      const changed = await env.DELIVERY_DB.prepare(`UPDATE portal_v2_invitation_email_outbox SET
        status='failed',attempts=20,payload_json=?,lease_expires_at=NULL,last_error_code='invalid_payload',updated_at=datetime(?)
        WHERE id=? AND status='processing' AND lease_expires_at=?`)
        .bind(SCRUBBED_PAYLOAD, nowIso, row.id, row.lease_expires_at).run();
      result.failed += changed.meta.changes;
      continue;
    }
    if (!(await invitationStillSendable(env, row, nowIso))) {
      if (await invitationStillPending(env, row, nowIso)) {
        result.retried += await releaseForEnrollmentRetry(env, row, now);
      } else {
        const changed = await env.DELIVERY_DB.prepare(`UPDATE portal_v2_invitation_email_outbox SET
          status='cancelled',payload_json=?,lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime(?)
          WHERE id=? AND status='processing' AND lease_expires_at=?`)
          .bind(SCRUBBED_PAYLOAD, nowIso, row.id, row.lease_expires_at).run();
        result.cancelled += changed.meta.changes;
      }
      continue;
    }
    const link = new URL("/portal/invitations/accept", env.CLIENT_PORTAL_ORIGIN);
    link.hash = `token=${encodeURIComponent(payload.token)}`;
    const workspaceName = row.workspace_name.trim().slice(0, 160) || "your client workspace";
    const fromName = (env.CLIENT_PORTAL_INVITATION_FROM_NAME || "LTDS Client Portal").trim().slice(0, 80) || "LTDS Client Portal";
    const expiryText = new Date(payload.expiresAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" });
    try {
      // Recheck immediately before handing the message to the external service.
      if (!(await invitationStillSendable(env, row, nowIso))) {
        const code = await invitationStillPending(env, row, nowIso)
          ? "E_ACCESS_ENROLLMENT_UNAVAILABLE"
          : "E_INVITATION_CANCELLED";
        throw Object.assign(new Error(code), { code });
      }
      await env.CLIENT_PORTAL_INVITATION_EMAIL!.send({
        to: recipient,
        from: { email: normalizeEmail(env.CLIENT_PORTAL_INVITATION_FROM!)!, name: fromName },
        subject: `You were invited to ${workspaceName}`.slice(0, 200),
        text: `You were invited to ${workspaceName} in the LTDS Client Portal.\n\nAccept invitation: ${link.toString()}\n\nThis invitation expires ${expiryText}. If you were not expecting it, you can ignore this email.`,
        html: `<p>You were invited to <strong>${htmlEscape(workspaceName)}</strong> in the LTDS Client Portal.</p><p><a href="${htmlEscape(link.toString())}">Accept invitation</a></p><p>This invitation expires ${htmlEscape(expiryText)}. If you were not expecting it, you can ignore this email.</p>`,
      });
      const changed = await env.DELIVERY_DB.prepare(`UPDATE portal_v2_invitation_email_outbox SET
        status='sent',payload_json=?,sent_at=datetime(?),lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime(?)
        WHERE id=? AND status='processing' AND lease_expires_at=?
          AND EXISTS (SELECT 1 FROM portal_v2_invitations invitation
            JOIN portal_v2_invitation_access_enrollment_receipts receipt
              ON receipt.invitation_id=invitation.id AND receipt.workspace_id=invitation.workspace_id
              AND receipt.invited_email_hash=portal_v2_invitation_email_outbox.recipient_email_hash
              AND receipt.invitation_token_hash=invitation.token_hash
            WHERE invitation.id=portal_v2_invitation_email_outbox.invitation_id
              AND invitation.status='pending' AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime(?)
              AND receipt.revoked_at IS NULL AND datetime(receipt.enrolled_at)<=datetime(?) AND datetime(receipt.expires_at)>datetime(?))`)
        .bind(SCRUBBED_PAYLOAD, nowIso, nowIso, row.id, row.lease_expires_at, nowIso, nowIso, nowIso).run();
      result.sent += changed.meta.changes;
      if (changed.meta.changes !== 1) {
        await env.DELIVERY_DB.prepare(`UPDATE portal_v2_invitation_email_outbox SET
          status='cancelled',payload_json=?,lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime(?)
          WHERE id=? AND status='processing' AND lease_expires_at=?`)
          .bind(SCRUBBED_PAYLOAD, nowIso, row.id, row.lease_expires_at).run();
        result.cancelled += 1;
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === "E_ACCESS_ENROLLMENT_UNAVAILABLE") {
        result.retried += await releaseForEnrollmentRetry(env, row, now);
        continue;
      }
      const permanent = code === "E_INVITATION_CANCELLED" || isPermanentEmailError(code) || row.attempts >= MAX_ATTEMPTS;
      const status = code === "E_INVITATION_CANCELLED" ? "cancelled" : "failed";
      const nextAttempt = new Date(now.getTime() + retryDelayMs(row.attempts)).toISOString();
      const changed = await env.DELIVERY_DB.prepare(`UPDATE portal_v2_invitation_email_outbox SET
        status=?,attempts=CASE WHEN ? THEN 20 ELSE attempts END,payload_json=CASE WHEN ? THEN ? ELSE payload_json END,
        next_attempt_at=?,lease_expires_at=NULL,last_error_code=?,updated_at=datetime(?)
        WHERE id=? AND status='processing' AND lease_expires_at=?`)
        .bind(status, permanent ? 1 : 0, permanent ? 1 : 0, SCRUBBED_PAYLOAD, nextAttempt, code, nowIso, row.id, row.lease_expires_at).run();
      if (changed.meta.changes === 1) {
        if (status === "cancelled") result.cancelled += 1;
        else if (permanent) result.failed += 1;
        else result.retried += 1;
      }
    }
  }
  return result;
}

export const invitationEmailInternals = { parsePayload, retryDelayMs, SCRUBBED_PAYLOAD };
