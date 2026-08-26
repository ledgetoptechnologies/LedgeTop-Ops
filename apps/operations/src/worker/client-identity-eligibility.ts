import { HTTPException } from "hono/http-exception";
import { isAdministrator } from "./acl";
import { sha256 } from "./crypto";
import type { Env, StaffPrincipal } from "./types";

export interface EligibilityBlockInput { matchType: "issuer_subject" | "email"; issuer?: string; subject?: string; email?: string; reasonCode: string; expiresAt?: string | null }

function db(env: Env) { return env.DELIVERY_DB.withSession("first-primary"); }
// Portal activation remains separate from eligibility deny policy rollout.
async function requireAdmin(env: Env, principal: StaffPrincipal): Promise<void> {
  if (!eligibilityBlockManagementEnabled(env)) throw new HTTPException(404, { message: "Not found" });
  if (!(await isAdministrator(env, principal))) throw new HTTPException(403, { message: "Administrator access is required" });
}
export function eligibilityBlockManagementEnabled(env: Partial<Pick<Env,
  "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED" | "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED">>): boolean {
  return env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" &&
    env.CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED === "true";
}
export function portalOperationsManagementEnabled(env: Partial<Pick<Env,
  "CLIENT_PORTAL_HIERARCHY_V2_ENABLED" | "CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED">>): boolean {
  return env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true" &&
    env.CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED === "true";
}
function email(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}
function validKey(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(value); }

export async function retryClientPortalInvitation(env: Env, principal: StaffPrincipal,
  workspaceId: string, principalPublicId: string, key: string) {
  if (!portalOperationsManagementEnabled(env)) throw new HTTPException(404, { message: "Not found" });
  if (!(await isAdministrator(env, principal))) throw new HTTPException(403, { message: "Administrator access is required" });
  if (!validKey(key) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(principalPublicId))
    throw new HTTPException(400, { message: "Invitation retry request is invalid" });
  // Migration 0149 stores hexadecimal SHA-256 receipts. Other contracts in
  // this module intentionally use the shared base64url helper; do not change
  // their encoding (or weaken the persisted receipt constraint).
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(["portal-operations:v1","invitation.retry",workspaceId,principalPublicId])))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const database = db(env);
  const prior = await database.prepare(`SELECT request_fingerprint,outcome,invitation_id
    FROM portal_v2_operations_management_mutations WHERE actor_staff_id=? AND idempotency_key=?`)
    .bind(principal.id,key).first<{request_fingerprint:string;outcome:string;invitation_id:string|null}>();
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new HTTPException(409,{message:"Idempotency-Key was already used"});
    return { outcome: prior.outcome, invitationId: prior.invitation_id, replayed: true };
  }
  const target = await database.prepare(`SELECT invitation.id,outbox.status email_status,outbox.payload_json,
      invitation.status invitation_status,invitation.expires_at
    FROM pa_portal_principals principal
    LEFT JOIN portal_v2_invitations invitation ON invitation.workspace_id=principal.workspace_id
      AND lower(trim(invitation.invited_email))=lower(trim(principal.email_hint))
    LEFT JOIN portal_v2_invitation_email_outbox outbox ON outbox.invitation_id=invitation.id
    WHERE principal.workspace_id=? AND principal.public_id=? AND principal.status='active'
    ORDER BY invitation.created_at DESC,invitation.id DESC LIMIT 1`).bind(workspaceId,principalPublicId)
    .first<{id:string|null;email_status:string|null;payload_json:string|null;invitation_status:string|null;expires_at:string|null}>();
  if (!target) throw new HTTPException(404,{message:"Projected client principal not found"});
  await database.batch([
    database.prepare(`UPDATE portal_v2_invitation_email_outbox SET
      status='pending',attempts=0,next_attempt_at=datetime('now'),lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime('now')
      WHERE invitation_id=? AND status='failed' AND payload_json NOT LIKE '%\"redacted\"%'
        AND EXISTS(SELECT 1 FROM portal_v2_invitations invitation
          JOIN pa_portal_principals projected ON projected.workspace_id=invitation.workspace_id
            AND lower(trim(projected.email_hint))=lower(trim(invitation.invited_email))
          WHERE invitation.id=portal_v2_invitation_email_outbox.invitation_id
            AND projected.workspace_id=? AND projected.public_id=? AND projected.status='active'
            AND invitation.status='pending' AND datetime(invitation.expires_at)>datetime('now'))`)
      .bind(target.id,workspaceId,principalPublicId),
    database.prepare(`INSERT INTO portal_v2_operations_management_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,workspace_id,principal_public_id,invitation_id,outcome)
      SELECT ?,?,'invitation.retry',?,?,?,?,CASE WHEN changes()=1 THEN 'queued'
        WHEN EXISTS(SELECT 1 FROM portal_v2_invitation_email_outbox outbox JOIN portal_v2_invitations invitation ON invitation.id=outbox.invitation_id
          WHERE invitation.id=? AND invitation.workspace_id=? AND invitation.status='pending'
            AND datetime(invitation.expires_at)>datetime('now') AND outbox.status='pending'
            AND outbox.payload_json NOT LIKE '%\"redacted\"%') THEN 'already_queued' ELSE 'not_repairable' END`)
      .bind(principal.id,key,fingerprint,workspaceId,principalPublicId,target.id,target.id,workspaceId),
    database.prepare(`INSERT INTO portal_v2_operations_management_audit
      (id,actor_staff_id,action,workspace_id,principal_public_id,invitation_id,details_json)
      SELECT ?,actor_staff_id,CASE WHEN outcome IN ('queued','already_queued') THEN 'invitation.retry.queued'
        ELSE 'invitation.retry.rejected' END,workspace_id,principal_public_id,invitation_id,
        json_object('previousEmailStatus',?,'outcome',outcome)
      FROM portal_v2_operations_management_mutations WHERE actor_staff_id=? AND idempotency_key=?`)
      .bind(crypto.randomUUID(),target.email_status,principal.id,key),
  ]);
  const receipt = await database.prepare(`SELECT outcome,invitation_id FROM portal_v2_operations_management_mutations
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(principal.id,key)
    .first<{outcome:string;invitation_id:string|null}>();
  if (!receipt) throw new HTTPException(409,{message:"Invitation changed; refresh and try again"});
  return { outcome: receipt.outcome, invitationId: receipt.invitation_id, replayed: false };
}

export async function createEligibilityBlock(env: Env, principal: StaffPrincipal, input: EligibilityBlockInput, key: string) {
  await requireAdmin(env, principal);
  if (!validKey(key) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(input.reasonCode))
    throw new HTTPException(400, { message: "Eligibility block request is invalid" });
  const normalizedEmail = input.matchType === "email" ? email(input.email || "") : null;
  const issuer = input.matchType === "issuer_subject" ? input.issuer?.trim() : null;
  const subject = input.matchType === "issuer_subject" ? input.subject?.trim() : null;
  if ((input.matchType === "email" && !normalizedEmail) ||
    (input.matchType === "issuer_subject" && (!issuer || !subject || issuer.length > 512 || subject.length > 512)))
    throw new HTTPException(400, { message: "Eligibility block target is invalid" });
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()))
    throw new HTTPException(400, { message: "Eligibility block expiry must be in the future" });
  const stable = { matchType: input.matchType, issuer, subject, normalizedEmail, reasonCode: input.reasonCode, expiresAt };
  const fingerprint = await sha256(JSON.stringify(["portal-eligibility-block:v1", "create", stable]));
  const prior = await db(env).prepare(`SELECT request_fingerprint,block_id FROM portal_v2_identity_eligibility_block_mutations
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(principal.id, key)
    .first<{ request_fingerprint: string; block_id: string }>();
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new HTTPException(409, { message: "Idempotency-Key was already used" });
    return { id: prior.block_id, replayed: true };
  }
  const id = crypto.randomUUID();
  await db(env).batch([
    db(env).prepare(`INSERT INTO portal_v2_identity_eligibility_blocks
      (id,match_type,issuer,subject,normalized_email,reason_code,expires_at,created_by_actor_type,created_by_actor_id)
      VALUES(?,?,?,?,?,?,?,'staff',?)`).bind(id, input.matchType, issuer, subject, normalizedEmail, input.reasonCode, expiresAt, principal.id),
    db(env).prepare(`INSERT INTO portal_v2_identity_eligibility_block_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,block_id) VALUES(?,?,'block.create',?,?)`)
      .bind(principal.id, key, fingerprint, id),
    db(env).prepare(`INSERT INTO portal_v2_identity_eligibility_block_audit(block_id,action,actor_staff_id,details_json)
      VALUES(?,'block.created',?,?)`).bind(id, principal.id, JSON.stringify(stable)),
  ]);
  return { id, replayed: false };
}

export async function revokeEligibilityBlock(env: Env, principal: StaffPrincipal, blockId: string, reasonCode: string, key: string) {
  await requireAdmin(env, principal);
  if (!validKey(key) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(reasonCode))
    throw new HTTPException(400, { message: "Eligibility block revocation is invalid" });
  const fingerprint = await sha256(JSON.stringify(["portal-eligibility-block:v1", "revoke", blockId, reasonCode]));
  const prior = await db(env).prepare(`SELECT request_fingerprint,block_id FROM portal_v2_identity_eligibility_block_mutations
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(principal.id, key)
    .first<{ request_fingerprint: string; block_id: string }>();
  if (prior) {
    if (prior.request_fingerprint !== fingerprint || prior.block_id !== blockId) throw new HTTPException(409, { message: "Idempotency-Key was already used" });
    return { id: blockId, replayed: true };
  }
  const existing = await db(env).prepare("SELECT id,status FROM portal_v2_identity_eligibility_blocks WHERE id=?")
    .bind(blockId).first<{ id: string; status: string }>();
  if (!existing) throw new HTTPException(404, { message: "Eligibility block not found" });
  await db(env).batch([
    db(env).prepare(`UPDATE portal_v2_identity_eligibility_blocks SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now')),
      updated_at=datetime('now') WHERE id=? AND status='active'`).bind(blockId),
    db(env).prepare(`INSERT INTO portal_v2_identity_eligibility_block_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,block_id) VALUES(?,?,'block.revoke',?,?)`)
      .bind(principal.id, key, fingerprint, blockId),
    db(env).prepare(`INSERT INTO portal_v2_identity_eligibility_block_audit(block_id,action,actor_staff_id,details_json)
      VALUES(?,'block.revoked',?,?)`).bind(blockId, principal.id, JSON.stringify({ reasonCode })),
  ]);
  return { id: blockId, replayed: false };
}
