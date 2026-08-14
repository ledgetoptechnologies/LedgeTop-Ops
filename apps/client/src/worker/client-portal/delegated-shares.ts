import { HTTPException } from "hono/http-exception";
import type {
  ClientDelegatedShareSignerRequestV1,
  ClientDelegatedShareSignerSuccessV1,
} from "@ltds/shared";
import type { Env } from "../types";
import { constantTimeEqual, hmac, sha256 } from "../security";
import type { VerifiedClientPrincipal } from "./types";
import { authorizePortalWorkspaceCapability, portalHierarchyV2Enabled } from "./workspace-v2";

export const CLIENT_DELEGATED_SHARE_COOKIE = "__Secure-ltds_client_share";
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
  delegation_version: number;
  folder_binding_id: string;
  folder_binding_source_version: string;
  live_binding_source_version: string | null;
  binding_r2_prefix: string;
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
  image_location_map_enabled: number;
  expires_at: string;
}

export interface AuthorizedClientShareDelegation {
  delegationId: string;
  workspaceId: string;
  identityId: string;
  delegationVersion: number;
  entitlementId: string;
  entitlementVersion: number;
  folderBindingId: string;
  folderBindingSourceVersion: string;
  folderTargetId: string;
  maximumLinkLifetimeSeconds: number;
  requirePassword: boolean;
  imageLocationMapEnabled: boolean;
  /** Server-only physical scope. Never serialize this value to a client. */
  deliveryPrefix: string;
}

export interface AuthorizedClientDelegatedPublicDelivery extends AuthorizedClientShareDelegation {
  shareId: string;
  publicId: string;
  shareVersion: number;
  tokenHash: string;
  label: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  passwordAlgorithm: string | null;
  shareExpiresAt: string;
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

export interface ClientDelegatedShareTargetSummary {
  delegationId: string;
  folderTargetId: string;
  displayName: string;
  maximumLinkLifetimeSeconds: number;
  requirePassword: boolean;
  delegationExpiresAt: string;
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

function canonicalR2Prefix(value: string): string | null {
  if (value.length < 2 || value.length > 1000 || value !== value.normalize("NFC")) return null;
  if (value.startsWith("/") || !value.endsWith("/") || value.includes("//")) return null;
  if (value.includes("\\") || value.includes("%") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const segments = value.slice(0, -1).split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return null;
  return `${segments.join("/")}/`;
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
      delegation.entitlement_id,delegation.entitlement_version,delegation.delegation_version,
      delegation.folder_binding_id,delegation.folder_binding_source_version,
      binding.source_version live_binding_source_version,binding.r2_prefix binding_r2_prefix,
      root.relative_prefix root_relative_prefix,root.binding_source_version root_binding_source_version,
      root.staff_exact_root_approved root_staff_approved,
      target.id target_id,target.relative_prefix target_relative_prefix,
      target.binding_source_version target_binding_source_version,
      target.staff_exact_root_approved target_staff_approved,
      delegation.allow_exact_root,delegation.maximum_link_lifetime_seconds,
      delegation.require_password,delegation.expires_at,
      COALESCE(policy.image_location_map_enabled,0) image_location_map_enabled
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
    LEFT JOIN client_share_delegation_policies policy
      ON policy.delegation_id=delegation.id AND policy.workspace_id=delegation.workspace_id
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
  const bindingPrefix = canonicalR2Prefix(row.binding_r2_prefix);
  if (!bindingPrefix) return null;

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
    delegationVersion: row.delegation_version,
    entitlementId: row.entitlement_id,
    entitlementVersion: row.entitlement_version,
    folderBindingId: row.folder_binding_id,
    folderBindingSourceVersion: row.folder_binding_source_version,
    folderTargetId: row.target_id,
    maximumLinkLifetimeSeconds: row.maximum_link_lifetime_seconds,
    requirePassword: row.require_password === 1,
    imageLocationMapEnabled: row.image_location_map_enabled === 1,
    deliveryPrefix: `${bindingPrefix}${row.target_relative_prefix}`,
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
  const delivery = await authorizeClientDelegatedPublicDelivery(env, { publicId, shareVersion }, false);
  if (!delivery) return null;
  const { shareId: _shareId, publicId: _publicId, shareVersion: _shareVersion, tokenHash: _tokenHash,
    label: _label, passwordHash: _passwordHash, passwordSalt: _passwordSalt,
    passwordAlgorithm: _passwordAlgorithm, shareExpiresAt: _shareExpiresAt, ...authorization } = delivery;
  return authorization;
}

/** Resolves a delegated bearer to an exact live delivery scope on every request. */
export async function authorizeClientDelegatedPublicDelivery(
  env: Env,
  input: { publicId: string; shareVersion: number; expectedShareId?: string },
  enforceFeatureFlag = true,
): Promise<AuthorizedClientDelegatedPublicDelivery | null> {
  if ((enforceFeatureFlag && env.CLIENT_DELEGATED_SHARES_ENABLED !== "true") || !portalHierarchyV2Enabled(env) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{19,63}$/.test(input.publicId)) return null;
  if (!Number.isSafeInteger(input.shareVersion) || input.shareVersion < 1 ||
      (input.expectedShareId !== undefined && !opaqueId(input.expectedShareId))) return null;
  const share = await delegatedShareDb(env).prepare(`SELECT id,public_id,delegation_id,workspace_id,
      created_by_identity_id,folder_target_id,share_version,token_hash,label,password_hash,password_salt,
      password_algorithm,expires_at
    FROM client_delegated_shares WHERE public_id=? AND share_version=?
      AND (? IS NULL OR id=?) AND status='active' AND revoked_at IS NULL
      AND datetime(expires_at)>datetime('now')`)
    .bind(input.publicId, input.shareVersion, input.expectedShareId ?? null, input.expectedShareId ?? null)
    .first<{
      id: string; public_id: string; delegation_id: string; workspace_id: string;
      created_by_identity_id: string; folder_target_id: string; share_version: number;
      token_hash: string; label: string | null; password_hash: string | null;
      password_salt: string | null; password_algorithm: string | null; expires_at: string;
    }>();
  if (!share) return null;
  const row = await delegationPolicyRow(env, share.workspace_id, share.delegation_id, share.folder_target_id);
  // The creator is immutable audit provenance, not ongoing ownership. Staff may
  // adopt the same delegation to a replacement manager; live authorization is
  // always the delegation's current exact identity and entitlement version.
  const authorization = row ? await authorizeDelegationRow(env, row) : null;
  if (!authorization) return null;
  return {
    ...authorization,
    shareId: share.id,
    publicId: share.public_id,
    shareVersion: share.share_version,
    tokenHash: share.token_hash,
    label: share.label,
    passwordHash: share.password_hash,
    passwordSalt: share.password_salt,
    passwordAlgorithm: share.password_algorithm,
    shareExpiresAt: share.expires_at,
  };
}

export type ClientDelegatedShareCreationCapability =
  | { enabled: true }
  | { enabled: false; reason: "feature-disabled" | "operations-signer-binding-required" };

/** Both the explicit rollout flag and the private named-entrypoint binding are required. */
export function clientDelegatedShareCreationCapability(env: Env): ClientDelegatedShareCreationCapability {
  if (env.CLIENT_DELEGATED_SHARES_ENABLED !== "true")
    return { enabled: false, reason: "feature-disabled" };
  if (!env.CLIENT_DELEGATED_SHARE_SIGNER ||
      typeof env.CLIENT_DELEGATED_SHARE_SIGNER.createClientDelegatedShare !== "function")
    return { enabled: false, reason: "operations-signer-binding-required" };
  return { enabled: true };
}

function validSignerSuccess(value: unknown): value is ClientDelegatedShareSignerSuccessV1 {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ClientDelegatedShareSignerSuccessV1>;
  const share = result.share;
  return result.ok === true && result.protocolVersion === 1 && typeof result.replayed === "boolean" &&
    typeof result.receiptId === "string" && opaqueId(result.receiptId) && Boolean(share) &&
    typeof share?.id === "string" && opaqueId(share.id) &&
    typeof share.publicId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{19,63}$/.test(share.publicId) &&
    typeof share.path === "string" && typeof share.shareUrl === "string" &&
    (share.label === null || (typeof share.label === "string" && share.label.length >= 1 && share.label.length <= 160)) &&
    share.status === "active" && typeof share.passwordProtected === "boolean" &&
    typeof share.expiresAt === "string" && Number.isFinite(Date.parse(share.expiresAt)) &&
    typeof share.createdAt === "string" && Number.isFinite(Date.parse(share.createdAt));
}

/**
 * Treat the RPC response as untrusted until it is tied back to the signer row,
 * bearer hash and exact request. The event ID is deterministic so an HTTP retry
 * cannot create duplicate audit records after a successful signer call.
 */
export async function verifyAndRecordClientDelegatedShareSignerResult(
  env: Env,
  delegation: AuthorizedClientShareDelegation,
  request: ClientDelegatedShareSignerRequestV1,
  value: unknown,
): Promise<ClientDelegatedShareSignerSuccessV1 | null> {
  if (!validSignerSuccess(value)) return null;
  const expectedPath = `${CLIENT_DELEGATED_SHARE_PATH_PREFIX}${encodeURIComponent(value.share.publicId)}`;
  if (value.share.path !== expectedPath || value.share.label !== request.label ||
      value.share.expiresAt !== request.expiresAt) return null;
  let url: URL;
  try { url = new URL(value.share.shareUrl); } catch { return null; }
  const configured = env.CLIENT_PORTAL_ORIGIN || env.PUBLIC_BASE_URL;
  let expectedOrigin: string;
  try { expectedOrigin = new URL(configured).origin; } catch { return null; }
  const secret = url.hash.slice(1);
  if (url.origin !== expectedOrigin || url.pathname !== expectedPath || url.search ||
      !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;

  const row = await delegatedShareDb(env).prepare(`SELECT token_hash FROM client_delegated_shares
    WHERE id=? AND public_id=? AND workspace_id=? AND delegation_id=?
      AND created_by_identity_id=? AND folder_target_id=? AND signer_receipt_id=?
      AND idempotency_key=? AND share_version=1 AND status='active'
      AND revoked_at IS NULL AND expires_at=? AND label IS ?`)
    .bind(
      value.share.id, value.share.publicId, request.workspaceId, request.delegationId,
      delegation.identityId, request.folderTargetId, value.receiptId,
      request.idempotencyKey, request.expiresAt, request.label,
    ).first<{ token_hash: string }>();
  if (!row || !constantTimeEqual(row.token_hash, await sha256(secret))) return null;

  const eventId = `client-share-event-${(await sha256(JSON.stringify([
    request.workspaceId, delegation.identityId, request.idempotencyKey,
  ]))).slice(0, 43)}`;
  await delegatedShareDb(env).prepare(`INSERT OR IGNORE INTO client_delegated_share_events
    (id,workspace_id,delegation_id,share_id,actor_type,actor_id,event_type,request_idempotency_key,details_json)
    VALUES (?,?,?,?,? ,?,'client_share.created',?,'{}')`)
    .bind(
      eventId, request.workspaceId, request.delegationId, value.share.id,
      "client", delegation.identityId, request.idempotencyKey,
    ).run();
  return value;
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

/** Lists only opaque, currently authorized target choices. No binding prefix,
 * relative prefix, storage key, entitlement ID, or internal source version is
 * serialized to the client. */
export async function listClientDelegatedShareTargets(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
): Promise<ClientDelegatedShareTargetSummary[] | null> {
  const identityId = await principalIdentityId(env, principal);
  if (!identityId || !(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "workspace.view", {
    scopeType: "workspace", publicId: workspaceId,
  }))) return null;
  if (!(await consumeClientDelegatedShareRate(env, workspaceId, identityId, "list")))
    throw new HTTPException(429, { message: "Too many share requests" });
  const rows = await delegatedShareDb(env).prepare(`SELECT delegation.id delegation_id,target.id target_id,
      label.display_name,delegation.maximum_link_lifetime_seconds,delegation.require_password,
      delegation.expires_at
    FROM client_share_delegations delegation
    JOIN client_share_folder_targets target
      ON target.workspace_id=delegation.workspace_id
      AND target.folder_binding_id=delegation.folder_binding_id
      AND target.status='active' AND target.revoked_at IS NULL
    JOIN client_share_folder_target_labels label
      ON label.target_id=target.id AND label.workspace_id=target.workspace_id
    WHERE delegation.workspace_id=? AND delegation.identity_id=?
      AND delegation.status='active' AND delegation.revoked_at IS NULL
      AND datetime(delegation.expires_at)>datetime('now')
    ORDER BY label.display_name COLLATE NOCASE,target.id,delegation.id LIMIT 101`)
    .bind(workspaceId, identityId)
    .all<{
      delegation_id: string; target_id: string; display_name: string;
      maximum_link_lifetime_seconds: number; require_password: number; expires_at: string;
    }>();
  if (rows.results.length > 100)
    throw new HTTPException(409, { message: "Share target list is too large" });
  const authorized: ClientDelegatedShareTargetSummary[] = [];
  for (const row of rows.results) {
    const delegation = await authorizeClientShareDelegation(
      env, principal, workspaceId, row.delegation_id, row.target_id,
    );
    if (!delegation) continue;
    authorized.push({
      delegationId: row.delegation_id,
      folderTargetId: row.target_id,
      displayName: row.display_name,
      maximumLinkLifetimeSeconds: row.maximum_link_lifetime_seconds,
      requirePassword: row.require_password === 1,
      delegationExpiresAt: row.expires_at,
    });
  }
  return authorized;
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
      AND share_id=? AND event_type='client_share.revoked' AND request_idempotency_key=?`)
    .bind(workspaceId, identityId, shareId, idempotencyKey).first<{ id: string }>();
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
