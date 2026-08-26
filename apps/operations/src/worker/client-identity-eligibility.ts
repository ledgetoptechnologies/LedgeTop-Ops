import { HTTPException } from "hono/http-exception";
import { isAdministrator, sqlScope } from "./acl";
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

export async function listClientIdentityEligibility(env: Env, principal: StaffPrincipal, options: { workspaceId?: string } = {}) {
  const scope = await sqlScope(env, principal, "team.view");
  if (!scope.global || scope.deniedGlobal) throw new HTTPException(403, { message: "Global team.view permission required" });
  const workspaceValues = options.workspaceId === undefined ? [] : [options.workspaceId];
  const [principals, blocks, accessRows, invitationRows] = await Promise.all([
    db(env).prepare(`SELECT pa.workspace_id,workspace.display_name workspace_name,pa.public_id,pa.display_name,pa.email_hint,pa.source_version,
      pa.status,eligibility.identity_id,identity.issuer,identity.subject,
      CASE WHEN workspace.status='active' AND identity.status='active' AND identity.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM portal_v2_workspace_memberships membership
        WHERE membership.workspace_id=pa.workspace_id AND membership.identity_id=eligibility.identity_id
          AND membership.status='active' AND membership.revoked_at IS NULL
          AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))) THEN 1 ELSE 0 END has_workspace_access,
      CASE WHEN EXISTS (SELECT 1 FROM portal_v2_identity_eligibility_blocks block
        WHERE block.status='active' AND datetime(block.valid_from)<=datetime('now')
          AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
          AND ((block.match_type='email' AND block.normalized_email=lower(pa.email_hint))
            OR (block.match_type='issuer_subject' AND block.issuer=identity.issuer AND block.subject=identity.subject))) THEN 1 ELSE 0 END blocked
      FROM pa_portal_principals pa JOIN portal_v2_workspaces workspace ON workspace.id=pa.workspace_id
      LEFT JOIN portal_v2_identity_eligibility_bindings eligibility
        ON eligibility.workspace_id=pa.workspace_id AND eligibility.principal_public_id=pa.public_id
      LEFT JOIN portal_v2_identities identity ON identity.id=eligibility.identity_id
      WHERE pa.status='active' ${options.workspaceId === undefined ? "" : "AND pa.workspace_id=?"}
      ORDER BY pa.display_name COLLATE NOCASE,pa.email_hint,pa.workspace_id LIMIT 501`).bind(...workspaceValues)
      .all<Record<string, unknown>>(),
    db(env).prepare(`SELECT id,match_type,issuer,subject,normalized_email,reason_code,status,valid_from,expires_at,
      created_by_actor_id,created_at,updated_at,revoked_at FROM portal_v2_identity_eligibility_blocks block
      ${options.workspaceId === undefined ? "" : `WHERE EXISTS (SELECT 1 FROM pa_portal_principals scoped
        LEFT JOIN portal_v2_identity_eligibility_bindings binding
          ON binding.workspace_id=scoped.workspace_id AND binding.principal_public_id=scoped.public_id
        LEFT JOIN portal_v2_identities identity ON identity.id=binding.identity_id
        WHERE scoped.workspace_id=? AND ((block.match_type='email' AND block.normalized_email=lower(scoped.email_hint))
          OR (block.match_type='issuer_subject' AND block.issuer=identity.issuer AND block.subject=identity.subject)))`}
      ORDER BY status,created_at DESC,id LIMIT 501`).bind(...workspaceValues).all<Record<string, unknown>>(),
    db(env).prepare(`SELECT projected.workspace_id,projected.public_id,entitlement.capability,entitlement.effect,
        entitlement.scope_type,entitlement.scope_public_id,COALESCE(entity.display_name,entitlement.scope_public_id) scope_label
      FROM pa_portal_principals projected
      JOIN portal_v2_identity_eligibility_bindings eligibility ON eligibility.workspace_id=projected.workspace_id
        AND eligibility.principal_public_id=projected.public_id
      JOIN portal_v2_entitlements entitlement ON entitlement.workspace_id=projected.workspace_id
        AND entitlement.identity_id=eligibility.identity_id AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now')
        AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
      LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=entitlement.workspace_id
      LEFT JOIN portal_v2_directory_entities entity ON entity.workspace_id=entitlement.workspace_id
        AND entity.generation_id=checkpoint.active_generation_id AND entity.entity_type=entitlement.scope_type
        AND entity.public_id=entitlement.scope_public_id
      WHERE projected.status='active' ${options.workspaceId === undefined ? "" : "AND projected.workspace_id=?"}
      ORDER BY projected.workspace_id,projected.public_id,entitlement.capability,entitlement.scope_type,entitlement.scope_public_id
      LIMIT 5001`).bind(...workspaceValues).all<Record<string, unknown>>(),
    db(env).prepare(`SELECT projected.workspace_id,projected.public_id,invitation.id,invitation.status,
        invitation.expires_at,outbox.status email_status,outbox.attempts,outbox.last_error_code
      FROM pa_portal_principals projected
      JOIN portal_v2_invitations invitation ON invitation.workspace_id=projected.workspace_id
        AND lower(invitation.invited_email)=lower(projected.email_hint)
      LEFT JOIN portal_v2_invitation_email_outbox outbox ON outbox.invitation_id=invitation.id
      WHERE projected.status='active' AND invitation.id=(SELECT latest.id FROM portal_v2_invitations latest
        WHERE latest.workspace_id=projected.workspace_id AND lower(latest.invited_email)=lower(projected.email_hint)
        ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
      ${options.workspaceId === undefined ? "" : "AND projected.workspace_id=?"}
      ORDER BY projected.workspace_id,projected.public_id LIMIT 501`).bind(...workspaceValues).all<Record<string, unknown>>(),
  ]);
  if (principals.results.length > 500 || blocks.results.length > 500 || accessRows.results.length > 5000 || invitationRows.results.length > 500)
    throw new HTTPException(503, { message: "Client identity directory is too large" });
  const keyed = (workspaceId: unknown, publicId: unknown) => `${String(workspaceId)}\u0000${String(publicId)}`;
  const accessByPrincipal = new Map<string,Record<string,unknown>[]>();
  for (const row of accessRows.results) {
    const key = keyed(row.workspace_id,row.public_id), values = accessByPrincipal.get(key) ?? [];
    values.push({ capability: row.capability,effect: row.effect,scope_type: row.scope_type,
      scope_public_id: row.scope_public_id,scope_label: row.scope_label });
    accessByPrincipal.set(key,values);
  }
  const invitationByPrincipal = new Map(invitationRows.results.map(row => [keyed(row.workspace_id,row.public_id),{
    id: row.id,status: row.status,expires_at: row.expires_at,email_status: row.email_status,
    attempts: row.attempts,last_error_code: row.last_error_code,
  }]));
  const clients = principals.results.map(row => ({ ...row,
    // This is a workspace-shell indicator, never a content grant. Keep a live
    // eligibility block from being displayed alongside a positive access flag.
    has_workspace_access: row.blocked === 1 ? 0 : row.has_workspace_access,
    access: accessByPrincipal.get(keyed(row.workspace_id,row.public_id)) ?? [],
    invitation: invitationByPrincipal.get(keyed(row.workspace_id,row.public_id)) ?? null,
  }));
  return { clients, blocks: blocks.results,
    canManageEligibilityBlocks: eligibilityBlockManagementEnabled(env) && await isAdministrator(env, principal),
    canManagePortal: portalOperationsManagementEnabled(env) && await isAdministrator(env, principal) };
}

export async function retryClientPortalInvitation(env: Env, principal: StaffPrincipal,
  workspaceId: string, principalPublicId: string, key: string) {
  if (!portalOperationsManagementEnabled(env)) throw new HTTPException(404, { message: "Not found" });
  if (!(await isAdministrator(env, principal))) throw new HTTPException(403, { message: "Administrator access is required" });
  if (!validKey(key) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(principalPublicId))
    throw new HTTPException(400, { message: "Invitation retry request is invalid" });
  const fingerprint = await sha256(JSON.stringify(["portal-operations:v1","invitation.retry",workspaceId,principalPublicId]));
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
      AND lower(invitation.invited_email)=lower(principal.email_hint)
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
            AND lower(projected.email_hint)=lower(invitation.invited_email)
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
