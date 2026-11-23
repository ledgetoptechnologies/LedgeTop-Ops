import { HTTPException } from "hono/http-exception";
import type {
  ClientDelegatedShareSignerRequestV1,
  ClientDelegatedShareSignerSuccessV1,
} from "@ltds/shared";
import type { Env } from "../types";
import { constantTimeEqual, hmac, sha256 } from "../security";
import { configuredPublicShareOrigin } from "../origin-policy";
import type { VerifiedClientPrincipal } from "./types";
import { authorizePortalWorkspaceCapability, portalHierarchyV2Enabled } from "./workspace-v2";
import {
  authenticatedDeliveryGrantsEnabled,
  authorizeAuthenticatedDeliveryGrant,
} from "./authenticated-delivery-grants";
import { portalRootAccessAllowedSql } from "./workspace-access-policy";
import { activeClientAuthorityWorkspaceClaim } from "./client-authority-claim-read";

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

export function effectiveClientDelegatedShareStatus(
  status: ClientDelegatedShareSummary["status"],
  expiresAt: string,
  now = Date.now(),
): ClientDelegatedShareSummary["status"] {
  if (status === "failed" || status === "revoked" || status === "expired") return status;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= now ? "expired" : status;
}

export interface ClientDelegatedShareExpiryResult {
  sharesExpired: number;
  delegationsExpired: number;
  sharesAtLimit: boolean;
  delegationsAtLimit: boolean;
}

/**
 * Materialize elapsed delegated-share state for operator/client readback and
 * immutable audit history. Runtime authorization already checks expires_at on
 * every request, so this maintenance path can only remove authority; it never
 * creates or restores a membership, entitlement, delegation, or share.
 *
 * Each update and its deterministic event insert are committed in the same D1
 * batch. A concurrent explicit revoke wins when it commits first; when expiry
 * wins first, the existing revoke guard observes the terminal expired state.
 */
export async function reconcileExpiredClientDelegatedShares(
  env: Pick<Env, "DELIVERY_DB">,
  options: { now?: number; limitPerType?: number } = {},
): Promise<ClientDelegatedShareExpiryResult> {
  const now = options.now ?? Date.now();
  const requestedLimit = options.limitPerType ?? 50;
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(50, requestedLimit))
    : 50;
  const nowIso = new Date(now).toISOString();
  const database = delegatedShareDb(env);
  const shares = await database.prepare(`SELECT id,workspace_id FROM client_delegated_shares
    WHERE status IN ('pending_signer','active') AND revoked_at IS NULL
      AND datetime(expires_at)<=datetime(?)
    ORDER BY expires_at,id LIMIT ?`).bind(nowIso, limit)
    .all<{ id: string; workspace_id: string }>();
  let sharesExpired = 0;
  if (shares.results.length) {
    const statements = shares.results.flatMap(row => [
      database.prepare(`UPDATE client_delegated_shares
        SET status='expired',share_version=share_version+1,updated_at=datetime(?)
        WHERE id=? AND workspace_id=?
          AND status IN ('pending_signer','active') AND revoked_at IS NULL
          AND datetime(expires_at)<=datetime(?)`)
        .bind(nowIso, row.id, row.workspace_id, nowIso),
      database.prepare(`INSERT OR IGNORE INTO client_delegated_share_events
        (id,workspace_id,delegation_id,share_id,actor_type,actor_id,event_type,details_json)
        SELECT 'client-share-expired:'||share.id,share.workspace_id,share.delegation_id,share.id,
          'system','client-portal-expiry','client_share.expired',
          json_object('reason','expires_at','expiresAt',share.expires_at)
        FROM client_delegated_shares share
        WHERE share.id=? AND share.workspace_id=? AND share.status='expired'
          AND share.revoked_at IS NULL AND datetime(share.expires_at)<=datetime(?)`)
        .bind(row.id, row.workspace_id, nowIso),
    ]);
    const results = await database.batch(statements);
    sharesExpired = results.reduce((count, result, index) =>
      index % 2 === 0 ? count + (result.meta.changes ?? 0) : count, 0);
  }

  const delegations = await database.prepare(`SELECT id,workspace_id FROM client_share_delegations
    WHERE status IN ('active','suspended') AND revoked_at IS NULL AND datetime(expires_at)<=datetime(?)
    ORDER BY expires_at,id LIMIT ?`).bind(nowIso, limit)
    .all<{ id: string; workspace_id: string }>();
  let delegationsExpired = 0;
  if (delegations.results.length) {
    const statements = delegations.results.flatMap(row => [
      database.prepare(`UPDATE client_share_delegations
        SET status='expired',delegation_version=delegation_version+1,updated_at=datetime(?)
        WHERE id=? AND workspace_id=? AND status IN ('active','suspended') AND revoked_at IS NULL
          AND datetime(expires_at)<=datetime(?)`)
        .bind(nowIso, row.id, row.workspace_id, nowIso),
      database.prepare(`INSERT OR IGNORE INTO client_delegated_share_events
        (id,workspace_id,delegation_id,actor_type,actor_id,event_type,details_json)
        SELECT 'client-delegation-expired:'||delegation.id,delegation.workspace_id,delegation.id,
          'system','client-portal-expiry','delegation.expired',
          json_object('reason','expires_at','expiresAt',delegation.expires_at)
        FROM client_share_delegations delegation
        WHERE delegation.id=? AND delegation.workspace_id=? AND delegation.status='expired'
          AND delegation.revoked_at IS NULL AND datetime(delegation.expires_at)<=datetime(?)`)
        .bind(row.id, row.workspace_id, nowIso),
    ]);
    const results = await database.batch(statements);
    delegationsExpired = results.reduce((count, result, index) =>
      index % 2 === 0 ? count + (result.meta.changes ?? 0) : count, 0);
  }
  return {
    sharesExpired,
    delegationsExpired,
    sharesAtLimit: shares.results.length === limit,
    delegationsAtLimit: delegations.results.length === limit,
  };
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
  env: Pick<Env, "DELIVERY_DB" | "CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED">,
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
      AND ${portalRootAccessAllowedSql(env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED === "true", "workspace")}
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
  // A client-generated public share can never outlive or exceed the current
  // staff-approved authenticated source grant. Revocation/source-version drift
  // therefore suspends existing bearer sessions immediately on their next use.
  if (authenticatedDeliveryGrantsEnabled(env) && !(await authorizeAuthenticatedDeliveryGrant(
    env, principal, row.workspace_id, row.folder_binding_id,
  ))) return null;
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
  const expectedOrigin = configuredPublicShareOrigin(env);
  if (!expectedOrigin) return null;
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

  // The signer and this Worker are separate services, so a claim can commit
  // after the pre-signer authorization and before its response is finalized.
  // Never disclose that newly minted bearer in that case. The public router
  // independently reauthorizes each use, but revoking the exact row here also
  // compensates the signer result before this function returns it to a caller.
  //
  // This cannot fence a claim which commits *after* this D1 decision: that
  // requires the future claim protocol to make the claim writer and delegated
  // share state one atomic authority transaction (or use a shared epoch).
  if (await activeClientAuthorityWorkspaceClaim(env.DELIVERY_DB, request.workspaceId)) {
    const revoked = await delegatedShareDb(env).prepare(`UPDATE client_delegated_shares
      SET status='revoked',revoked_at=datetime('now'),revoked_reason='client_authority_claim_fenced',
        share_version=share_version+1,updated_at=datetime('now')
      WHERE id=? AND workspace_id=? AND delegation_id=? AND status='active' AND revoked_at IS NULL`).bind(
      value.share.id, request.workspaceId, request.delegationId,
    ).run();
    if (revoked.meta.changes === 1) {
      const eventId = `client-share-claim-fenced-${(await sha256(JSON.stringify([
        request.workspaceId, value.share.id,
      ]))).slice(0, 43)}`;
      await delegatedShareDb(env).prepare(`INSERT OR IGNORE INTO client_delegated_share_events
        (id,workspace_id,delegation_id,share_id,actor_type,actor_id,event_type,request_idempotency_key,details_json)
        VALUES (?,?,?,?,? ,?,'client_share.claim_fenced',?,'{}')`).bind(
        eventId, request.workspaceId, request.delegationId, value.share.id,
        "system", delegation.identityId, request.idempotencyKey,
      ).run();
    }
    return null;
  }

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

/** Default and maximum rows read per share or target listing page. */
export const CLIENT_DELEGATED_SHARE_PAGE_SIZE = 100;
/** One listing walk may follow at most this many cursors, within this lifetime. */
export const CLIENT_DELEGATED_SHARE_CURSOR_MAX_PAGES = 50;
const CLIENT_DELEGATED_SHARE_CURSOR_TTL_MS = 15 * 60_000;
/** Cursor pages are not charged to the 60/min "list" budget (only a walk's
 * first page is), but they are bounded by their own wider per-minute budget. */
export const CLIENT_DELEGATED_SHARE_CURSOR_RATE_LIMIT = 600;

export type ClientDelegatedShareListKind = "shares" | "targets";
/** `limitQuery` is the raw route value, validated only after authorization. */
export interface ClientDelegatedSharePageOptions { cursor?: string | null; limit?: number; limitQuery?: string }
/** Raw keyset position: the sort keys of the last row read, authorized or not. */
export interface ClientDelegatedShareRowPageOptions { after?: string[] | null; limit?: number }
interface CursorContext { env: Pick<Env, "DELIVERY_SESSION_SECRET">; principal: VerifiedClientPrincipal; workspaceId: string; kind: ClientDelegatedShareListKind }
/** deadline: absolute ms set on a walk's first page and copied unchanged to every later cursor. */
interface CursorState { keys: string[]; page: number; deadline: number }

function clientDelegatedSharePageSize(limit: number | undefined): number {
  return Number.isInteger(limit) && limit! >= 1 ? Math.min(limit!, CLIENT_DELEGATED_SHARE_PAGE_SIZE) : CLIENT_DELEGATED_SHARE_PAGE_SIZE;
}

const cursorEncoder = new TextEncoder();
function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  try { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0)); } catch { return null; }
}
async function cursorKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", cursorEncoder.encode(`client-delegated-share-cursor-v1\0${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
function cursorAad(context: CursorContext): Uint8Array<ArrayBuffer> {
  return cursorEncoder.encode(["client-delegated-share-cursor-v1", context.kind, context.workspaceId,
    context.principal.issuer, context.principal.subject].join("\0"));
}

/** Opaque cursor: AES-GCM under a key derived from DELIVERY_SESSION_SECRET and
 * bound to the list kind, workspace and caller, so its contents (which may be
 * sort keys of rows the caller cannot see) are never readable or reusable
 * elsewhere. */
export async function encodeClientDelegatedShareCursor(context: CursorContext, state: CursorState): Promise<string> {
  const secret = context.env.DELIVERY_SESSION_SECRET ?? "";
  if (secret.length < 32) throw new HTTPException(503, { message: "Share listing is unavailable" });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = cursorEncoder.encode(JSON.stringify({ k: state.keys, p: state.page, e: state.deadline }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: cursorAad(context) }, await cursorKey(secret), plain));
  const payload = new Uint8Array(iv.length + sealed.length);
  payload.set(iv); payload.set(sealed, iv.length);
  return `ds2.${base64url(payload)}`;
}

/** Null for anything malformed, foreign or past the page bound. Expiry is
 * checked separately (clientDelegatedShareCursorExpired) so callers can tell
 * the client to restart the walk instead of reporting a bad request. */
export async function decodeClientDelegatedShareCursor(context: CursorContext, value: string): Promise<CursorState | null> {
  const secret = context.env.DELIVERY_SESSION_SECRET ?? "";
  if (secret.length < 32 || value.length > 2048 || !value.startsWith("ds2.")) return null;
  const payload = fromBase64url(value.slice(4));
  if (!payload || payload.length < 29) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(0, 12), additionalData: cursorAad(context) },
      await cursorKey(secret), payload.slice(12));
    const state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as { k?: unknown; p?: unknown; e?: unknown };
    if (!Array.isArray(state.k) || state.k.length !== 2 || !state.k.every(key => typeof key === "string" && key.length <= 512)) return null;
    if (!Number.isInteger(state.p) || (state.p as number) < 1 || (state.p as number) >= CLIENT_DELEGATED_SHARE_CURSOR_MAX_PAGES) return null;
    if (typeof state.e !== "number" || !Number.isSafeInteger(state.e)) return null;
    return { keys: state.k as string[], page: state.p as number, deadline: state.e };
  } catch {
    return null;
  }
}

function invalidCursor(): never {
  throw new HTTPException(400, { message: "Invalid share list cursor" });
}

/** A walk lives CLIENT_DELEGATED_SHARE_CURSOR_TTL_MS from its first page; later pages never extend it. */
export function clientDelegatedShareCursorExpired(state: Pick<CursorState, "deadline">, now = Date.now()): boolean {
  return state.deadline <= now || state.deadline > now + CLIENT_DELEGATED_SHARE_CURSOR_TTL_MS;
}

/** Status the portal client treats as "restart the walk from page one". */
export const CLIENT_DELEGATED_SHARE_CURSOR_EXPIRED_STATUS = 410;

/** Separate budget for cursor pages. The rate table's action CHECK only allows
 * create/list/revoke, so cursor pages use the "list" action in a negative
 * window_start namespace (-(minute+1)); first pages keep the minute >= 0.
 * Any clean-up job or query over client_delegated_share_rate_windows must
 * tolerate negative windows: compare abs(window_start) with the cut-off minute
 * (a plain "window_start < cutoff" would delete live cursor windows early, and
 * "window_start BETWEEN ..." would never delete them). No such job exists today. */
async function consumeClientDelegatedShareCursorRate(env: Pick<Env, "DELIVERY_DB">, workspaceId: string, identityId: string, now = Date.now()) {
  const result = await delegatedShareDb(env).prepare(`INSERT INTO client_delegated_share_rate_windows
    (workspace_id,identity_id,action,window_start,request_count) VALUES (?,?,'list',?,1)
    ON CONFLICT(workspace_id,identity_id,action,window_start) DO UPDATE
      SET request_count=request_count+1,updated_at=datetime('now')
      WHERE request_count<?`)
    .bind(workspaceId, identityId, -(Math.floor(now / 60_000) + 1), CLIENT_DELEGATED_SHARE_CURSOR_RATE_LIMIT).run();
  return result.meta.changes === 1;
}

/** Parses a raw `limit` query value: absent, or an integer 1-100; otherwise 400. */
function parseClientDelegatedShareLimitQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > CLIENT_DELEGATED_SHARE_PAGE_SIZE)
    throw new HTTPException(400, { message: "Invalid share list limit" });
  return Number(value);
}

/** Authorizes the caller, validates the cursor and limit, then charges the right
 * budget. Order matters: an unauthorized caller gets null (404) before any query
 * value is examined. */
async function beginClientDelegatedSharePage(
  env: Env, principal: VerifiedClientPrincipal, workspaceId: string, kind: ClientDelegatedShareListKind,
  options: ClientDelegatedSharePageOptions,
): Promise<{ identityId: string; context: CursorContext; state: CursorState | null; limit: number | undefined; deadline: number } | null> {
  const identityId = await principalIdentityId(env, principal);
  if (!identityId || !(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "workspace.view", {
    scopeType: "workspace", publicId: workspaceId,
  }))) return null;
  const context: CursorContext = { env, principal, workspaceId, kind };
  const now = Date.now();
  const state = options.cursor ? await decodeClientDelegatedShareCursor(context, options.cursor) ?? invalidCursor() : null;
  if (state && clientDelegatedShareCursorExpired(state, now))
    throw new HTTPException(CLIENT_DELEGATED_SHARE_CURSOR_EXPIRED_STATUS, { message: "Share list expired; reload it from the start" });
  const limit = options.limitQuery !== undefined ? parseClientDelegatedShareLimitQuery(options.limitQuery) : options.limit;
  const allowed = state
    ? await consumeClientDelegatedShareCursorRate(env, workspaceId, identityId, now)
    : await consumeClientDelegatedShareRate(env, workspaceId, identityId, "list", undefined, now);
  if (!allowed) throw new HTTPException(429, { message: "Too many share requests" });
  // The walk's deadline is fixed on its first page and copied, never extended.
  const deadline = state?.deadline ?? now + CLIENT_DELEGATED_SHARE_CURSOR_TTL_MS;
  return { identityId, context, state, limit, deadline };
}

type DelegatedShareListRow = { id: string; public_id: string; label: string | null; status: ClientDelegatedShareSummary["status"]; expires_at: string; revoked_at: string | null; created_at: string; delegation_id: string; folder_target_id: string };

/** One keyset page of a workspace's share rows, newest first (created_at DESC, id).
 * Both keys are immutable and revocation only changes status, so a walk
 * returns every row that existed when it started exactly once. */
export async function pageClientDelegatedShareRows(
  database: D1Database,
  workspaceId: string,
  options: ClientDelegatedShareRowPageOptions = {},
): Promise<{ rows: DelegatedShareListRow[]; nextAfter: string[] | null }> {
  const limit = clientDelegatedSharePageSize(options.limit), after = options.after ?? null;
  const rows = await database.prepare(`SELECT id,public_id,label,status,expires_at,revoked_at,created_at,
      delegation_id,folder_target_id
    FROM client_delegated_shares WHERE workspace_id=?1
      AND (?2 IS NULL OR created_at<?2 OR (created_at=?2 AND id>?3))
    ORDER BY created_at DESC,id LIMIT ?4`)
    .bind(workspaceId, after?.[0] ?? null, after?.[1] ?? null, limit + 1)
    .all<DelegatedShareListRow>();
  const page = rows.results.slice(0, limit), last = page.at(-1);
  return { rows: page, nextAfter: rows.results.length > limit && last ? [last.created_at, last.id] : null };
}

/** First page only; kept for callers that predate paging. */
export async function listClientDelegatedShares(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
): Promise<ClientDelegatedShareSummary[] | null> {
  return (await listClientDelegatedSharePage(env, principal, workspaceId))?.shares ?? null;
}

export async function listClientDelegatedSharePage(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  options: ClientDelegatedSharePageOptions = {},
): Promise<{ shares: ClientDelegatedShareSummary[]; nextCursor: string | null } | null> {
  const begun = await beginClientDelegatedSharePage(env, principal, workspaceId, "shares", options);
  if (!begun) return null;
  const { rows, nextAfter } = await pageClientDelegatedShareRows(delegatedShareDb(env), workspaceId, {
    after: begun.state?.keys ?? null, ...(begun.limit === undefined ? {} : { limit: begun.limit }),
  });
  const authorized: DelegatedShareListRow[] = [];
  for (const row of rows) {
    if (await authorizeClientShareDelegation(env, principal, workspaceId, row.delegation_id, row.folder_target_id))
      authorized.push(row);
  }
  const nextCursor = nextAfter
    ? await encodeClientDelegatedShareCursor(begun.context, { keys: nextAfter, page: (begun.state?.page ?? 0) + 1, deadline: begun.deadline }) : null;
  return { nextCursor, shares: authorized.map(row => ({
    id: row.id,
    publicId: row.public_id,
    path: `${CLIENT_DELEGATED_SHARE_PATH_PREFIX}${encodeURIComponent(row.public_id)}`,
    label: row.label,
    status: effectiveClientDelegatedShareStatus(row.status, row.expires_at),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  })) };
}

type DelegatedShareTargetRow = {
  delegation_id: string; target_id: string; display_name: string;
  maximum_link_lifetime_seconds: number; require_password: number; expires_at: string;
};

/** One keyset page of the identity's active delegation targets, ordered by the
 * immutable (target id, delegation id) so a label rename mid-walk cannot skip or
 * repeat a row. Display order (label, case-insensitive) is applied by the
 * portal client after the full walk. */
export async function pageClientDelegatedShareTargetRows(
  database: D1Database,
  workspaceId: string,
  identityId: string,
  options: ClientDelegatedShareRowPageOptions = {},
): Promise<{ rows: DelegatedShareTargetRow[]; nextAfter: string[] | null }> {
  const limit = clientDelegatedSharePageSize(options.limit), after = options.after ?? null;
  const rows = await database.prepare(`SELECT delegation.id delegation_id,target.id target_id,
      label.display_name,delegation.maximum_link_lifetime_seconds,delegation.require_password,
      delegation.expires_at
    FROM client_share_delegations delegation
    JOIN client_share_folder_targets target
      ON target.workspace_id=delegation.workspace_id
      AND target.folder_binding_id=delegation.folder_binding_id
      AND target.status='active' AND target.revoked_at IS NULL
    JOIN client_share_folder_target_labels label
      ON label.target_id=target.id AND label.workspace_id=target.workspace_id
    WHERE delegation.workspace_id=?1 AND delegation.identity_id=?2
      AND delegation.status='active' AND delegation.revoked_at IS NULL
      AND datetime(delegation.expires_at)>datetime('now')
      AND (?3 IS NULL OR target.id>?3 OR (target.id=?3 AND delegation.id>?4))
    ORDER BY target.id,delegation.id LIMIT ?5`)
    .bind(workspaceId, identityId, after?.[0] ?? null, after?.[1] ?? null, limit + 1)
    .all<DelegatedShareTargetRow>();
  const page = rows.results.slice(0, limit), last = page.at(-1);
  return { rows: page, nextAfter: rows.results.length > limit && last ? [last.target_id, last.delegation_id] : null };
}

/** First page only; kept for callers that predate paging. */
export async function listClientDelegatedShareTargets(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
): Promise<ClientDelegatedShareTargetSummary[] | null> {
  return (await listClientDelegatedShareTargetPage(env, principal, workspaceId))?.targets ?? null;
}

/** Lists only opaque, currently authorized target choices. No binding prefix,
 * relative prefix, storage key, entitlement ID, or internal source version is
 * serialized to the client. */
export async function listClientDelegatedShareTargetPage(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  options: ClientDelegatedSharePageOptions = {},
): Promise<{ targets: ClientDelegatedShareTargetSummary[]; nextCursor: string | null } | null> {
  const begun = await beginClientDelegatedSharePage(env, principal, workspaceId, "targets", options);
  if (!begun) return null;
  const { rows, nextAfter } = await pageClientDelegatedShareTargetRows(delegatedShareDb(env), workspaceId, begun.identityId, {
    after: begun.state?.keys ?? null, ...(begun.limit === undefined ? {} : { limit: begun.limit }),
  });
  const authorized: ClientDelegatedShareTargetSummary[] = [];
  for (const row of rows) {
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
  const nextCursor = nextAfter
    ? await encodeClientDelegatedShareCursor(begun.context, { keys: nextAfter, page: (begun.state?.page ?? 0) + 1, deadline: begun.deadline }) : null;
  return { targets: authorized, nextCursor };
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
