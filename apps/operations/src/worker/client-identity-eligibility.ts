import { HTTPException } from "hono/http-exception";
import { isAdministrator, sqlScope } from "./acl";
import { sha256 } from "./crypto";
import type { Env, StaffPrincipal } from "./types";

export interface EligibilityBlockInput { matchType: "issuer_subject" | "email"; issuer?: string; subject?: string; email?: string; reasonCode: string; expiresAt?: string | null }

function db(env: Env) { return env.DELIVERY_DB.withSession("first-primary"); }
async function requireAdmin(env: Env, principal: StaffPrincipal): Promise<void> {
  if (env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
  if (!(await isAdministrator(env, principal))) throw new HTTPException(403, { message: "Administrator access is required" });
}
function email(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}
function validKey(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(value); }

export async function listClientIdentityEligibility(env: Env, principal: StaffPrincipal) {
  if (env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
  const scope = await sqlScope(env, principal, "team.view");
  if (!scope.global || scope.deniedGlobal) throw new HTTPException(403, { message: "Global team.view permission required" });
  const [principals, blocks] = await Promise.all([
    db(env).prepare(`SELECT pa.workspace_id,pa.public_id,pa.display_name,pa.email_hint,pa.source_version,
      pa.status,eligibility.identity_id,identity.issuer,identity.subject,
      CASE WHEN EXISTS (SELECT 1 FROM portal_v2_workspace_memberships membership
        WHERE membership.identity_id=eligibility.identity_id AND membership.status='active' AND membership.revoked_at IS NULL
          AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))) THEN 1 ELSE 0 END has_workspace_access,
      CASE WHEN EXISTS (SELECT 1 FROM portal_v2_identity_eligibility_blocks block
        WHERE block.status='active' AND datetime(block.valid_from)<=datetime('now')
          AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
          AND ((block.match_type='email' AND block.normalized_email=lower(pa.email_hint))
            OR (block.match_type='issuer_subject' AND block.issuer=identity.issuer AND block.subject=identity.subject))) THEN 1 ELSE 0 END blocked
      FROM pa_portal_principals pa
      LEFT JOIN portal_v2_identity_eligibility_bindings eligibility
        ON eligibility.workspace_id=pa.workspace_id AND eligibility.principal_public_id=pa.public_id
      LEFT JOIN portal_v2_identities identity ON identity.id=eligibility.identity_id
      WHERE pa.status='active' ORDER BY pa.display_name COLLATE NOCASE,pa.email_hint,pa.workspace_id LIMIT 501`)
      .all<Record<string, unknown>>(),
    db(env).prepare(`SELECT id,match_type,issuer,subject,normalized_email,reason_code,status,valid_from,expires_at,
      created_by_actor_id,created_at,updated_at,revoked_at FROM portal_v2_identity_eligibility_blocks
      ORDER BY status,created_at DESC,id LIMIT 501`).all<Record<string, unknown>>(),
  ]);
  if (principals.results.length > 500 || blocks.results.length > 500)
    throw new HTTPException(503, { message: "Client identity directory is too large" });
  return { clients: principals.results, blocks: blocks.results };
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
