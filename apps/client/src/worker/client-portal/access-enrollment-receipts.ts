import type { Env } from "../types";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;

function database(env: Env): D1Database {
  return env.DELIVERY_DB;
}

function normalizedEmail(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return normalized.length >= 3 && normalized.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized
    : null;
}

export async function invitationRecipientEmailHash(value: string): Promise<string | null> {
  const email = normalizedEmail(value);
  if (!email) return null;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface InvitationAccessEnrollmentReceiptInput {
  invitationId: string;
  workspaceId: string;
  email: string;
  enrollmentVersion: number;
  /** SHA-256 of the provider-side receipt or reconciliation record; never a token. */
  providerReceiptHash: string;
  enrolledAt: string;
}

/**
 * Server-only persistence seam for a future dedicated Client Portal Access
 * reconciler. It is intentionally not mounted on a public or portal route.
 */
export async function recordInvitationAccessEnrollmentReceipt(
  env: Env,
  input: InvitationAccessEnrollmentReceiptInput,
): Promise<boolean> {
  if (!OPAQUE_ID.test(input.invitationId) || !OPAQUE_ID.test(input.workspaceId)
    || !Number.isSafeInteger(input.enrollmentVersion) || input.enrollmentVersion < 1
    || !HASH.test(input.providerReceiptHash)) return false;
  const email = normalizedEmail(input.email);
  const emailHash = email ? await invitationRecipientEmailHash(email) : null;
  const enrolledAt = new Date(input.enrolledAt);
  if (!email || !emailHash || !Number.isFinite(enrolledAt.valueOf()) || enrolledAt.valueOf() > Date.now() + 5 * 60 * 1000) return false;
  const changed = await database(env).prepare(`INSERT INTO portal_v2_invitation_access_enrollment_receipts(
      invitation_id,workspace_id,invited_email_hash,invitation_token_hash,enrollment_version,
      provider_receipt_hash,enrolled_at,expires_at)
    SELECT id,workspace_id,?,token_hash,?,?,?,expires_at
    FROM portal_v2_invitations
    WHERE id=? AND workspace_id=? AND lower(invited_email)=?
      AND status='pending' AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
    ON CONFLICT(invitation_id) DO UPDATE SET
      workspace_id=excluded.workspace_id,invited_email_hash=excluded.invited_email_hash,
      invitation_token_hash=excluded.invitation_token_hash,enrollment_version=excluded.enrollment_version,
      provider_receipt_hash=excluded.provider_receipt_hash,enrolled_at=excluded.enrolled_at,
      expires_at=excluded.expires_at,revoked_at=NULL,updated_at=datetime('now')
    WHERE excluded.enrollment_version>portal_v2_invitation_access_enrollment_receipts.enrollment_version`)
    .bind(emailHash, input.enrollmentVersion, input.providerReceiptHash, enrolledAt.toISOString(), input.invitationId, input.workspaceId, email)
    .run();
  return changed.meta.changes === 1;
}

export async function revokeInvitationAccessEnrollmentReceipt(
  env: Env,
  invitationId: string,
  workspaceId: string,
  enrollmentVersion: number,
): Promise<boolean> {
  if (!OPAQUE_ID.test(invitationId) || !OPAQUE_ID.test(workspaceId)
    || !Number.isSafeInteger(enrollmentVersion) || enrollmentVersion < 1) return false;
  const changed = await database(env).prepare(`UPDATE portal_v2_invitation_access_enrollment_receipts
    SET revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
    WHERE invitation_id=? AND workspace_id=? AND enrollment_version=? AND revoked_at IS NULL`)
    .bind(invitationId, workspaceId, enrollmentVersion).run();
  return changed.meta.changes === 1;
}
