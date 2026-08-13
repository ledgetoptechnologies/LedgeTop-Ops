import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { constantTimeEqual, hmac } from "../security";
import type { VerifiedClientPrincipal } from "./types";
import { authorizePortalWorkspaceCapability, portalHierarchyV2Enabled } from "./workspace-v2";

export const CLIENT_DELEGATED_SHARE_COOKIE = "__Host-ltds_client_share";
export const CLIENT_DELEGATED_SHARE_PATH_PREFIX = "/client-share/";
const CLIENT_SHARE_SESSION_CONTEXT = "client-delegated-share:v1";

interface DelegationPolicyRow {
  delegation_id: string;
  workspace_id: string;
  identity_id: string;
  issuer: string;
  subject: string;
  verified_email: string | null;
  entitlement_id: string;
  entitlement_version: number;
  folder_binding_id: string;
  folder_binding_source_version: string;
  live_binding_source_version: string | null;
  root_relative_prefix: string;
  root_binding_source_version: string;
  root_staff_approved: number;
  target_id: string;
  target_relative_prefix: string;
  target_binding_source_version: string;
  target_staff_approved: number;
  allow_exact_root: number;
  maximum_link_lifetime_seconds: number;
  require_password: number;
  expires_at: string;
}

export interface AuthorizedClientShareDelegation {
  delegationId: string;
  workspaceId: string;
  identityId: string;
  folderBindingId: string;
  folderTargetId: string;
  maximumLinkLifetimeSeconds: number;
  requirePassword: boolean;
}

export interface ClientDelegatedShareSummary {
  id: string;
  publicId: string;
  path: string;
  label: string | null;
  status: "pending_signer" | "active" | "failed" | "revoked" | "expired";
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface ClientDelegatedShareSession {
  shareId: string;
  shareVersion: number;
  expiresAt: number;
}

function delegatedShareDb(env: Pick<Env, "DELIVERY_DB">): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & {
    withSession?: (consistency: "first-primary") => D1Database;
  };
  return candidate.withSession?.("first-primary") ?? candidate;
}

function opaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value);
}

/** Internal-only canonicalization. Relative prefixes never cross a client API. */
export function canonicalDelegatedRelativePrefix(value: string): string | null {
  if (value === "") return "";
  if (value.length > 900 || value !== value.normalize("NFC")) return null;
  if (value.startsWith("/") || !value.endsWith("/") || value.includes("//")) return null;
  if (value.includes("\\") || value.includes("%") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const segments = value.slice(0, -1).split("/");
  if (!segments.length || segments.some(segment => !segment || segment === "." || segment === "..")) return null;
  return `${segments.join("/")}/`;
}

export function delegatedTargetContained(
  rootPrefix: string,
  targetPrefix: string,
  allowExactRoot: boolean,
): boolean {
  const root = canonicalDelegatedRelativePrefix(rootPrefix);
  const target = canonicalDelegatedRelativePrefix(targetPrefix);
  if (root === null || target === null) return false;
  if (root === target) return allowExactRoot;
  // Both non-empty prefixes end at a slash boundary; an empty root contains
  // every non-empty target but is never itself selected by default.
  return target.length > root.length && target.startsWith(root);
}

async function principalIdentityId(
  env: Pick<Env, "DELIVERY_DB">,
  principal: VerifiedClientPrincipal,
): Promise<string | null> {
  if (!principal.issuer || !principal.subject || principal.issuer.length > 512 || principal.subject.length > 512) return null;
  const row = await delegatedShareDb(env).prepare(`SELECT id FROM portal_v2_identities
    WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL`)
    .bind(principal.issuer, principal.subject).first<{ id: string }>();
  return row?.id ?? null;
}

async function delegationPolicyRow(
  env: Pick<Env, "DELIVERY_DB">,
  workspaceId: string,
  delegationId: string,
  targetId: string,
): Promise<DelegationPolicyRow | null> {
  if (![workspaceId, delegationId, targetId].every(opaqueId)) return null;
  return delegatedShareDb(env).prepare(`
    SELECT delegation.id delegation_id,delegation.workspace_id,delegation.identity_id,
      identity.issuer,identity.subject,identity.verified_email,
      delegation.entitlement_id,delegation.entitlement_version,
      delegation.folder_binding_id,delegation.folder_binding_source_version,
      binding.source_version live_binding_source_version,
      root.relative_prefix root_relative_prefix,root.binding_source_version root_binding_source_version,
      root.staff_exact_root_approved root_staff_approved,
      target.id target_id,target.relative_prefix target_relative_prefix,
      target.binding_source_version target_binding_source_version,
      target.staff_exact_root_approved target_staff_approved,
      delegation.allow_exact_root,delegation.maximum_link_lifetime_seconds,
      delegation.require_password,delegation.expires_at
    FROM client_share_delegations delegation
    JOIN portal_v2_identities identity
      ON identity.id=delegation.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN portal_v2_workspaces workspace
      ON workspace.id=delegation.workspace_id AND workspace.status='active'
    JOIN portal_v2_workspace_memberships membership
      ON membership.workspace_id=delegation.workspace_id AND membership.identity_id=delegation.identity_id
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN portal_v2_entitlements entitlement
      ON entitlement.id=delegation.entitlement_id
      AND entitlement.workspace_id=delegation.workspace_id
      AND entitlement.identity_id=delegation.identity_id
      AND entitlement.capability='delegated_share.create' AND entitlement.effect='allow'
      AND entitlement.entitlement_version=delegation.entitlement_version
      AND entitlement.status='active' AND entitlement.revoked_at IS NULL
      AND datetime(entitlement.valid_from)<=datetime('now')
      AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
    JOIN portal_v2_folder_bindings binding
      ON binding.id=delegation.folder_binding_id AND binding.workspace_id=delegation.workspace_id
      AND binding.status='active' AND binding.revoked_at IS NULL
    JOIN client_share_folder_targets root
      ON root.id=delegation.root_target_id AND root.workspace_id=delegation.workspace_id
      AND root.folder_binding_id=delegation.folder_binding_id
      AND root.status='active' AND root.revoked_at IS NULL
    JOIN client_share_folder_targets target
      ON target.id=? AND target.workspace_id=delegation.workspace_id
      AND target.folder_binding_id=delegation.folder_binding_id
      AND target.status='active' AND target.revoked_at IS NULL
    WHERE delegation.id=? AND delegation.workspace_id=? AND delegation.status='active'
      AND delegation.revoked_at IS NULL AND datetime(delegation.expires_at)>datetime('now')`)
    .bind(targetId, delegationId, workspaceId)
    .first<DelegationPolicyRow>();
}

async function authorizeDelegationRow(
  env: Env,
  row: DelegationPolicyRow,
  expectedIdentityId?: string,
): Promise<AuthorizedClientShareDelegation | null> {
  if (expectedIdentityId && row.identity_id !== expectedIdentityId) return null;
  if (!row.live_binding_source_version || row.live_binding_source_version !== row.folder_binding_source_version ||
      row.root_binding_source_version !== row.folder_binding_source_version ||
      row.target_binding_source_version !== row.folder_binding_source_version) return null;
  if (!delegatedTargetContained(row.root_relative_prefix, row.target_relative_prefix, row.allow_exact_root === 1)) return null;
  if (row.target_relative_prefix === "" && row.target_staff_approved !== 1) return null;
  if (row.root_relative_prefix === "" && row.root_staff_approved !== 1) return null;

  const principal: VerifiedClientPrincipal = {
    issuer: row.issuer,
    subject: row.subject,
    email: row.verified_email ?? "",
  };
  // Re-evaluate the complete PA lineage plus deny precedence on every call.
  if (!(await authorizePortalWorkspaceCapability(env, principal, row.workspace_id, "delegated_share.create", {
    scopeType: "folder",
    publicId: row.folder_binding_id,
  }))) return null;
  return {
    delegationId: row.delegation_id,
    workspaceId: row.workspace_id,
    identityId: row.identity_id,
    folderBindingId: row.folder_binding_id,
    folderTargetId: row.target_id,
    maximumLinkLifetimeSeconds: row.maximum_link_lifetime_seconds,
    requirePassword: row.require_password === 1,
  };
}

export async function authorizeClientShareDelegation(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  delegationId: string,
  targetId: string,
): Promise<AuthorizedClientShareDelegation | null> {
  if (!portalHierarchyV2Enabled(env)) return null;
  const identityId = await principalIdentityId(env, principal);
  if (!identityId) return null;
  const row = await delegationPolicyRow(env, workspaceId, delegationId, targetId);
  return row ? authorizeDelegationRow(env, row, identityId) : null;
}

/** Every bearer request calls this after its distinct cookie/secret check. */
export async function authorizeClientDelegatedPublicShare(
  env: Env,
  publicId: string,
  shareVersion: number,
): Promise<AuthorizedClientShareDelegation | null> {
  if (!portalHierarchyV2Enabled(env) || !/^[A-Za-z0-9][A-Za-z0-9_-]{19,63}$/.test(publicId)) return null;
  if (!Number.isSafeInteger(shareVersion) || shareVersion < 1) return null;
  const share = await delegatedShareDb(env).prepare(`SELECT delegation_id,workspace_id,created_by_identity_id,folder_target_id
    FROM client_delegated_shares WHERE public_id=? AND share_version=? AND status='active'
      AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`)
    .bind(publicId, shareVersion)
    .first<{ delegation_id: string; workspace_id: string; created_by_identity_id: string; folder_target_id: string }>();
  if (!share) return null;
  const row = await delegationPolicyRow(env, share.workspace_id, share.delegation_id, share.folder_target_id);
  // The creator is immutable audit provenance, not ongoing ownership. Staff may
  // adopt the same delegation to a replacement manager; live authorization is
  // always the delegation's current exact identity and entitlement version.
  return row ? authorizeDelegationRow(env, row) : null;
}

/** No creation path is enabled until the Operations signer RPC is implemented and contract-tested. */
export function clientDelegatedShareCreationCapability(_env: Env): {
  enabled: false;
  reason: "operations-signer-binding-required";
} {
  return { enabled: false, reason: "operations-signer-binding-required" };
}

export async function consumeClientDelegatedShareRate(
  env: Pick<Env, "DELIVERY_DB">,
  workspaceId: string,
  identityId: string,
  action: "create" | "list" | "revoke",
  limit = action === "create" ? 10 : 60,
  now = Date.now(),
): Promise<boolean> {
  const windowStart = Math.floor(now / 60_000);
  const result = await delegatedShareDb(env).prepare(`INSERT INTO client_delegated_share_rate_windows
    (workspace_id,identity_id,action,window_start,request_count) VALUES (?,?,?,?,1)
    ON CONFLICT(workspace_id,identity_id,action,window_start) DO UPDATE
      SET request_count=request_count+1,updated_at=datetime('now')
      WHERE request_count<?`)
    .bind(workspaceId, identityId, action, windowStart, limit).run();
  return result.meta.changes === 1;
}

export async function listClientDelegatedShares(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
): Promise<ClientDelegatedShareSummary[] | null> {
  const identityId = await principalIdentityId(env, principal);
  if (!identityId || !(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "workspace.view", {
    scopeType: "workspace", publicId: workspaceId,
  }))) return null;
  if (!(await consumeClientDelegatedShareRate(env, workspaceId, identityId, "list")))
    throw new HTTPException(429, { message: "Too many share requests" });
  const rows = await delegatedShareDb(env).prepare(`SELECT id,public_id,label,status,expires_at,revoked_at,created_at,
      delegation_id,folder_target_id
    FROM client_delegated_shares WHERE workspace_id=?
    ORDER BY created_at DESC,id LIMIT 101`).bind(workspaceId)
    .all<{ id: string; public_id: string; label: string | null; status: ClientDelegatedShareSummary["status"]; expires_at: string; revoked_at: string | null; created_at: string; delegation_id: string; folder_target_id: string }>();
  if (rows.results.length > 100) throw new HTTPException(409, { message: "Share list is too large" });
  const authorized: typeof rows.results = [];
  for (const row of rows.results) {
    if (await authorizeClientShareDelegation(env, principal, workspaceId, row.delegation_id, row.folder_target_id))
      authorized.push(row);
  }
  return authorized.map(row => ({
    id: row.id,
    publicId: row.public_id,
    path: `${CLIENT_DELEGATED_SHARE_PATH_PREFIX}${encodeURIComponent(row.public_id)}`,
    label: row.label,
    status: row.status,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }));
}

export async function revokeClientDelegatedShare(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  shareId: string,
  idempotencyKey: string,
): Promise<"revoked" | "replayed" | "denied"> {
  if (!opaqueId(workspaceId) || !opaqueId(shareId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) return "denied";
  const identityId = await principalIdentityId(env, principal);
  if (!identityId || !(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "workspace.view", {
    scopeType: "workspace", publicId: workspaceId,
  }))) return "denied";
  if (!(await consumeClientDelegatedShareRate(env, workspaceId, identityId, "revoke")))
    throw new HTTPException(429, { message: "Too many share requests" });
  const share = await delegatedShareDb(env).prepare(`SELECT delegation_id,folder_target_id FROM client_delegated_shares
    WHERE id=? AND workspace_id=?`).bind(shareId, workspaceId)
    .first<{ delegation_id: string; folder_target_id: string }>();
  if (!share || !(await authorizeClientShareDelegation(
    env, principal, workspaceId, share.delegation_id, share.folder_target_id,
  ))) return "denied";
  const prior = await delegatedShareDb(env).prepare(`SELECT id FROM client_delegated_share_events
    WHERE workspace_id=? AND actor_type='client' AND actor_id=?
      AND event_type='client_share.revoked' AND request_idempotency_key=?`)
    .bind(workspaceId, identityId, idempotencyKey).first<{ id: string }>();
  if (prior) return "replayed";
  const result = await delegatedShareDb(env).prepare(`UPDATE client_delegated_shares
    SET status='revoked',revoked_at=datetime('now'),revoked_by_identity_id=?,
      revoked_reason='client_revoked',share_version=share_version+1,updated_at=datetime('now')
    WHERE id=? AND workspace_id=?
      AND status IN ('pending_signer','active','failed') AND revoked_at IS NULL`)
    .bind(identityId, shareId, workspaceId).run();
  if (result.meta.changes !== 1) return "denied";
  await delegatedShareDb(env).prepare(`INSERT INTO client_delegated_share_events
    (id,workspace_id,share_id,actor_type,actor_id,event_type,request_idempotency_key)
    VALUES (?,?,?,?,?,'client_share.revoked',?)`)
    .bind(crypto.randomUUID(), workspaceId, shareId, "client", identityId, idempotencyKey).run();
  return "revoked";
}

export async function createClientDelegatedShareSessionCookie(
  secret: string,
  keyId: string,
  session: ClientDelegatedShareSession,
  now = Date.now(),
): Promise<string> {
  const payload = `${CLIENT_SHARE_SESSION_CONTEXT}:${keyId}:${session.shareId}:${session.shareVersion}:${session.expiresAt}`;
  const signature = await hmac(secret, payload);
  const value = `${keyId}.${session.shareId}.${session.shareVersion}.${session.expiresAt}.${signature}`;
  const maxAge = Math.max(0, Math.floor((session.expiresAt - now) / 1000));
  return `${CLIENT_DELEGATED_SHARE_COOKIE}=${encodeURIComponent(value)}; Path=/client-share/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export async function verifyClientDelegatedShareSessionCookie(
  secret: string,
  expectedKeyId: string,
  value: string | null,
  now = Date.now(),
): Promise<ClientDelegatedShareSession> {
  if (!value) throw new HTTPException(401, { message: "Client share session required" });
  const [keyId, shareId, versionRaw, expiresRaw, signature, extra] = value.split(".");
  const shareVersion = Number(versionRaw), expiresAt = Number(expiresRaw);
  if (extra !== undefined || keyId !== expectedKeyId || !opaqueId(shareId ?? "") || !signature ||
      !Number.isSafeInteger(shareVersion) || shareVersion < 1 || !Number.isSafeInteger(expiresAt) || expiresAt <= now)
    throw new HTTPException(401, { message: "Client share session expired" });
  const payload = `${CLIENT_SHARE_SESSION_CONTEXT}:${keyId}:${shareId}:${shareVersion}:${expiresAt}`;
  if (!constantTimeEqual(await hmac(secret, payload), signature))
    throw new HTTPException(401, { message: "Invalid client share session" });
  return { shareId: shareId!, shareVersion, expiresAt };
}
