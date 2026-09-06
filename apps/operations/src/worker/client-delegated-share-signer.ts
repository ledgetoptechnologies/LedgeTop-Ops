import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type ClientDelegatedShareSignerRequestV1,
  type ClientDelegatedShareSignerResultV1,
  type ClientDelegatedShareSignerSuccessV1,
} from "@ltds/shared";
import { z } from "zod";
import { hashAccessCode, hmac, randomToken, sha256 } from "./crypto";
import type { Env } from "./types";
import { publicShareOrigin } from "./origins";
import { portalRootAccessAllowedSql } from "./client-portal-root-access";

const CLIENT_SHARE_PATH_PREFIX = "/client-share/";
const SIGNER_PROTOCOL_VERSION = 1 as const;
const MINIMUM_LIFETIME_MS = 5 * 60 * 1000;
const MAXIMUM_RPC_BYTES = 4096;

const opaqueId = z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const signerRequest = z.object({
  protocolVersion: z.literal(SIGNER_PROTOCOL_VERSION),
  workspaceId: opaqueId,
  delegationId: opaqueId,
  expectedDelegationVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdByIdentityId: opaqueId,
  entitlementId: opaqueId,
  expectedEntitlementVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  folderBindingId: opaqueId,
  expectedBindingSourceVersion: z.string().min(1).max(128),
  folderTargetId: opaqueId,
  label: z.string().trim().min(1).max(160).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  accessCode: z.string().min(8).max(128).optional(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

interface AuthorizedSignerPolicy {
  workspace_id: string;
  identity_id: string;
  delegation_id: string;
  delegation_version: number;
  entitlement_id: string;
  entitlement_version: number;
  folder_binding_id: string;
  folder_binding_source_version: string;
  target_id: string;
  root_relative_prefix: string;
  target_relative_prefix: string;
  maximum_link_lifetime_seconds: number;
  require_password: number;
  delegation_expires_at: string;
}

interface StoredDelegatedShare {
  id: string;
  public_id: string;
  workspace_id: string;
  delegation_id: string;
  created_by_identity_id: string;
  folder_target_id: string;
  token_hash: string;
  share_version: number;
  label: string | null;
  password_hash: string | null;
  expires_at: string;
  status: string;
  signer_receipt_id: string | null;
  request_fingerprint: string;
  created_at: string;
}

function signerDb(env: Pick<Env, "DELIVERY_DB">): D1Database {
  const database = env.DELIVERY_DB as D1Database & {
    withSession?: (consistency: "first-primary") => D1Database;
  };
  return database.withSession?.("first-primary") ?? database;
}

function canonicalRelativePrefix(value: string): string | null {
  if (value === "") return "";
  if (value.length > 900 || value !== value.normalize("NFC")) return null;
  if (value.startsWith("/") || !value.endsWith("/") || value.includes("//")) return null;
  if (value.includes("\\") || value.includes("%") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const segments = value.slice(0, -1).split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return `${segments.join("/")}/`;
}

function contained(rootValue: string, targetValue: string, allowExactRoot: boolean): boolean {
  const root = canonicalRelativePrefix(rootValue), target = canonicalRelativePrefix(targetValue);
  if (root === null || target === null) return false;
  return target === root ? allowExactRoot : target.length > root.length && target.startsWith(root);
}

/*
 * This CTE is intentionally repeated for both the policy read and the final
 * INSERT. The INSERT therefore rechecks current membership, PA generation,
 * lineage, deny precedence, delegation version, binding version and target
 * containment in the same D1 statement that creates the bearer.
 */
function authorizedPolicyCte(env: Env): string {
  return `WITH RECURSIVE candidate AS (
  SELECT delegation.workspace_id,delegation.identity_id,delegation.id delegation_id,
    delegation.delegation_version,delegation.entitlement_id,delegation.entitlement_version,
    delegation.folder_binding_id,delegation.folder_binding_source_version,
    delegation.allow_exact_root,delegation.maximum_link_lifetime_seconds,
    delegation.require_password,delegation.expires_at delegation_expires_at,
    workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) workspace_root_public_id,
    binding.owner_scope_type,binding.owner_public_id,binding.source_version live_binding_source_version,
    delegated_allow.scope_type allow_scope_type,delegated_allow.scope_public_id allow_scope_public_id,
    root.relative_prefix root_relative_prefix,root.staff_exact_root_approved root_staff_approved,
    target.id target_id,target.relative_prefix target_relative_prefix,target.staff_exact_root_approved target_staff_approved
  FROM client_share_delegations delegation
  JOIN portal_v2_identities identity
    ON identity.id=delegation.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
  JOIN portal_v2_workspaces workspace
    ON workspace.id=delegation.workspace_id AND workspace.status='active'
    AND ${portalRootAccessAllowedSql(env, "workspace")}
  JOIN portal_v2_workspace_memberships membership
    ON membership.workspace_id=delegation.workspace_id AND membership.identity_id=delegation.identity_id
    AND membership.status='active' AND membership.revoked_at IS NULL
    AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
  JOIN portal_v2_entitlements delegated_allow
    ON delegated_allow.id=delegation.entitlement_id
    AND delegated_allow.workspace_id=delegation.workspace_id
    AND delegated_allow.identity_id=delegation.identity_id
    AND delegated_allow.capability='delegated_share.create' AND delegated_allow.effect='allow'
    AND delegated_allow.entitlement_version=delegation.entitlement_version
    AND delegated_allow.status='active' AND delegated_allow.revoked_at IS NULL
    AND datetime(delegated_allow.valid_from)<=datetime('now')
    AND (delegated_allow.expires_at IS NULL OR datetime(delegated_allow.expires_at)>datetime('now'))
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
  WHERE delegation.id=? AND delegation.workspace_id=? AND delegation.identity_id=?
    AND delegation.delegation_version=? AND delegation.entitlement_id=?
    AND delegation.entitlement_version=? AND delegation.folder_binding_id=?
    AND delegation.folder_binding_source_version=?
    AND binding.source_version=delegation.folder_binding_source_version
    AND root.binding_source_version=delegation.folder_binding_source_version
    AND target.binding_source_version=delegation.folder_binding_source_version
    AND delegation.status='active' AND delegation.revoked_at IS NULL
    AND datetime(delegation.expires_at)>datetime('now')
), lineage(entity_type,public_id,parent_public_id,depth) AS (
  SELECT entity.entity_type,entity.public_id,entity.parent_public_id,0
  FROM candidate
  JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=candidate.workspace_id
  JOIN portal_v2_directory_generations generation
    ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
    AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities entity
    ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
    AND entity.entity_type=candidate.owner_scope_type AND entity.public_id=candidate.owner_public_id
    AND entity.active=1
  UNION ALL
  SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1
  FROM lineage
  JOIN candidate
  JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=candidate.workspace_id
  JOIN portal_v2_directory_entities parent
    ON parent.workspace_id=checkpoint.workspace_id AND parent.generation_id=checkpoint.active_generation_id
    AND parent.public_id=lineage.parent_public_id AND parent.active=1
  WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<8
), authorized AS (
  SELECT candidate.* FROM candidate
  WHERE (candidate.target_relative_prefix<>candidate.root_relative_prefix OR candidate.allow_exact_root=1)
    AND (candidate.target_relative_prefix=candidate.root_relative_prefix
      OR length(candidate.target_relative_prefix)>length(candidate.root_relative_prefix))
    AND substr(candidate.target_relative_prefix,1,length(candidate.root_relative_prefix))=candidate.root_relative_prefix
    AND (candidate.root_relative_prefix='' OR (
      substr(candidate.root_relative_prefix,1,1)<>'/'
      AND substr(candidate.root_relative_prefix,-1)='/'
      AND instr(candidate.root_relative_prefix,'\\')=0
      AND instr('/'||candidate.root_relative_prefix,'/./')=0
      AND instr('/'||candidate.root_relative_prefix,'/../')=0
    ))
    AND (candidate.target_relative_prefix='' OR (
      substr(candidate.target_relative_prefix,1,1)<>'/'
      AND substr(candidate.target_relative_prefix,-1)='/'
      AND instr(candidate.target_relative_prefix,'\\')=0
      AND instr('/'||candidate.target_relative_prefix,'/./')=0
      AND instr('/'||candidate.target_relative_prefix,'/../')=0
    ))
    AND (candidate.target_relative_prefix<>'' OR candidate.target_staff_approved=1)
    AND (candidate.root_relative_prefix<>'' OR candidate.root_staff_approved=1)
    AND instr(candidate.target_relative_prefix,'%')=0 AND instr(candidate.root_relative_prefix,'%')=0
    AND instr(candidate.target_relative_prefix,'//')=0 AND instr(candidate.root_relative_prefix,'//')=0
    AND EXISTS (SELECT 1 FROM lineage
      WHERE lineage.entity_type=candidate.root_type AND lineage.public_id=candidate.workspace_root_public_id)
    AND (
      (candidate.allow_scope_type='workspace' AND candidate.allow_scope_public_id=candidate.workspace_id)
      OR (candidate.allow_scope_type='folder' AND candidate.allow_scope_public_id=candidate.folder_binding_id)
      OR EXISTS (SELECT 1 FROM lineage
        WHERE lineage.entity_type=candidate.allow_scope_type AND lineage.public_id=candidate.allow_scope_public_id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM portal_v2_entitlements denied
      WHERE denied.workspace_id=candidate.workspace_id AND denied.identity_id=candidate.identity_id
        AND denied.capability='delegated_share.create' AND denied.effect='deny'
        AND denied.status='active' AND denied.revoked_at IS NULL
        AND datetime(denied.valid_from)<=datetime('now')
        AND (denied.expires_at IS NULL OR datetime(denied.expires_at)>datetime('now'))
        AND (
          (denied.scope_type='workspace' AND denied.scope_public_id=candidate.workspace_id)
          OR (denied.scope_type='folder' AND denied.scope_public_id=candidate.folder_binding_id)
          OR EXISTS (SELECT 1 FROM lineage
            WHERE lineage.entity_type=denied.scope_type AND lineage.public_id=denied.scope_public_id)
        )
    )
)`;
}

function policyBindings(input: ClientDelegatedShareSignerRequestV1): unknown[] {
  return [
    input.folderTargetId,
    input.delegationId,
    input.workspaceId,
    input.createdByIdentityId,
    input.expectedDelegationVersion,
    input.entitlementId,
    input.expectedEntitlementVersion,
    input.folderBindingId,
    input.expectedBindingSourceVersion,
  ];
}

function failure(code: Exclude<ClientDelegatedShareSignerResultV1, { ok: true }>["code"]): ClientDelegatedShareSignerResultV1 {
  return { ok: false, protocolVersion: SIGNER_PROTOCOL_VERSION, code };
}

async function requestFingerprint(env: Env, input: ClientDelegatedShareSignerRequestV1): Promise<string> {
  return hmac(env.DELIVERY_TOKEN_SECRET, JSON.stringify([
    "client-delegated-share-request:v1",
    input.workspaceId,
    input.delegationId,
    input.expectedDelegationVersion,
    input.createdByIdentityId,
    input.entitlementId,
    input.expectedEntitlementVersion,
    input.folderBindingId,
    input.expectedBindingSourceVersion,
    input.folderTargetId,
    input.label,
    input.expiresAt,
    input.accessCode ?? null,
    input.idempotencyKey,
  ]));
}

async function bearerSecret(env: Env, shareId: string, shareVersion: number): Promise<string> {
  return hmac(env.DELIVERY_TOKEN_SECRET, `client-delegated-share-bearer:v1:${shareId}:${shareVersion}`);
}

function clientShareBaseUrl(env: Env): URL | null {
  try {
    return new URL(publicShareOrigin(env));
  } catch {
    return null;
  }
}

async function storedShareByIdempotency(
  database: D1Database,
  input: ClientDelegatedShareSignerRequestV1,
): Promise<StoredDelegatedShare | null> {
  return database.prepare(`SELECT id,public_id,workspace_id,delegation_id,created_by_identity_id,
      folder_target_id,token_hash,share_version,label,password_hash,expires_at,status,
      signer_receipt_id,request_fingerprint,created_at
    FROM client_delegated_shares
    WHERE workspace_id=? AND created_by_identity_id=? AND idempotency_key=?`)
    .bind(input.workspaceId, input.createdByIdentityId, input.idempotencyKey)
    .first<StoredDelegatedShare>();
}

async function successResult(
  env: Env,
  baseUrl: URL,
  share: StoredDelegatedShare,
  replayed: boolean,
): Promise<ClientDelegatedShareSignerSuccessV1 | null> {
  if (share.status !== "active" || !share.signer_receipt_id || share.share_version !== 1) return null;
  const secret = await bearerSecret(env, share.id, share.share_version);
  if (await sha256(secret) !== share.token_hash) return null;
  const path = `${CLIENT_SHARE_PATH_PREFIX}${encodeURIComponent(share.public_id)}`;
  const url = new URL(path, baseUrl);
  url.hash = secret;
  return {
    ok: true,
    protocolVersion: SIGNER_PROTOCOL_VERSION,
    receiptId: share.signer_receipt_id,
    replayed,
    share: {
      id: share.id,
      publicId: share.public_id,
      path,
      shareUrl: url.toString(),
      label: share.label,
      status: "active",
      passwordProtected: Boolean(share.password_hash),
      expiresAt: share.expires_at,
      createdAt: share.created_at,
    },
  };
}

export async function signClientDelegatedShare(
  env: Env,
  value: unknown,
  now = Date.now(),
): Promise<ClientDelegatedShareSignerResultV1> {
  if (env.CLIENT_DELEGATED_SHARE_SIGNER_ENABLED !== "true") return failure("configuration_error");
  if (!env.DELIVERY_TOKEN_SECRET || env.DELIVERY_TOKEN_SECRET.length < 32 ||
      !env.DELIVERY_ACCESS_CODE_PEPPER || env.DELIVERY_ACCESS_CODE_PEPPER.length < 32)
    return failure("configuration_error");
  const baseUrl = clientShareBaseUrl(env);
  if (!baseUrl) return failure("configuration_error");

  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { return failure("invalid_request"); }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAXIMUM_RPC_BYTES)
    return failure("invalid_request");
  const parsed = signerRequest.safeParse(value);
  if (!parsed.success) return failure("invalid_request");
  const input: ClientDelegatedShareSignerRequestV1 = {
    ...parsed.data,
    label: parsed.data.label?.trim() ?? null,
    expiresAt: new Date(parsed.data.expiresAt).toISOString(),
  };
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < now + MINIMUM_LIFETIME_MS)
    return failure("invalid_request");

  const database = signerDb(env);
  const policy = await database.prepare(`${authorizedPolicyCte(env)}
    SELECT workspace_id,identity_id,delegation_id,delegation_version,entitlement_id,
      entitlement_version,folder_binding_id,folder_binding_source_version,target_id,
      root_relative_prefix,target_relative_prefix,maximum_link_lifetime_seconds,
      require_password,delegation_expires_at FROM authorized LIMIT 2`)
    .bind(...policyBindings(input)).all<AuthorizedSignerPolicy>();
  if (policy.results.length !== 1) return failure("denied");
  const authorization = policy.results[0]!;
  if (!contained(authorization.root_relative_prefix, authorization.target_relative_prefix,
    authorization.root_relative_prefix === authorization.target_relative_prefix) ||
      expiresAtMs > now + authorization.maximum_link_lifetime_seconds * 1000 ||
      expiresAtMs > Date.parse(authorization.delegation_expires_at))
    return failure("denied");
  if (authorization.require_password === 1 && !input.accessCode) return failure("invalid_request");

  const fingerprint = await requestFingerprint(env, input);
  const existing = await storedShareByIdempotency(database, input);
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) return failure("idempotency_conflict");
    return (await successResult(env, baseUrl, existing, true)) ?? failure("denied");
  }

  const shareId = `client-share-${crypto.randomUUID()}`;
  const publicId = `cs_${randomToken(18)}`;
  const receiptId = `client-share-signer-${crypto.randomUUID()}`;
  const secret = await bearerSecret(env, shareId, 1);
  const tokenHash = await sha256(secret);
  let password: Awaited<ReturnType<typeof hashAccessCode>> | null = null;
  try {
    password = input.accessCode ? await hashAccessCode(input.accessCode, env.DELIVERY_ACCESS_CODE_PEPPER) : null;
  } catch {
    return failure("configuration_error");
  }

  try {
    const inserted = await database.prepare(`${authorizedPolicyCte(env)}
      INSERT INTO client_delegated_shares
        (id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,
         token_hash,share_version,label,password_hash,password_salt,password_algorithm,
         expires_at,status,signer_receipt_id,idempotency_key,request_fingerprint)
      SELECT ?,?,authorized.workspace_id,authorized.delegation_id,authorized.identity_id,
        authorized.target_id,?,1,?,?,?,?,?,'active',?,?,?
      FROM authorized
      WHERE datetime(?)>datetime('now','+5 minutes')
        AND unixepoch(?)<=unixepoch('now')+authorized.maximum_link_lifetime_seconds
        AND datetime(?)<=datetime(authorized.delegation_expires_at)
        AND (authorized.require_password=0 OR ?=1)`)
      .bind(
        ...policyBindings(input),
        shareId, publicId, tokenHash, input.label,
        password?.hash ?? null, password?.salt ?? null, password?.algorithm ?? null,
        input.expiresAt, receiptId, input.idempotencyKey, fingerprint,
        input.expiresAt, input.expiresAt, input.expiresAt, input.accessCode ? 1 : 0,
      ).run();
    if (inserted.meta.changes !== 1) return failure("denied");
  } catch {
    // A concurrent exact retry can win the unique idempotency constraint.
    // Read it back below and return only if its keyed fingerprint is identical.
  }

  const created = await storedShareByIdempotency(database, input);
  if (!created) return failure("denied");
  if (created.request_fingerprint !== fingerprint) return failure("idempotency_conflict");
  return (await successResult(env, baseUrl, created, created.id !== shareId)) ?? failure("denied");
}

/** Private named entrypoint. It has no route and exposes only the bounded RPC method. */
export class ClientDelegatedShareSigner extends WorkerEntrypoint<Env> {
  async createClientDelegatedShare(
    request: ClientDelegatedShareSignerRequestV1,
  ): Promise<ClientDelegatedShareSignerResultV1> {
    return signClientDelegatedShare(this.env, request);
  }
}
