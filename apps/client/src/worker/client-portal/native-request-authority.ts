import { portalSourceAuthorityGuard, type PortalSourceAuthorityProof } from "../project-alpha-portal-authority";
import { sha256 } from "../security";
import type { Env } from "../types";
import type { ClientPortalSession, VerifiedClientPrincipal } from "./types";
import { readNativeTargetScopes } from "./native-portal-scopes";
import {
  portalHierarchyV2Enabled,
  portalIdentityDenylistEnabled,
  resolveNativePortalWorkspaceReadContext,
} from "./workspace-v2";

const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface RequestEntitlementRow {
  id: string;
  effect: "allow" | "deny";
  scope_type: string;
  scope_public_id: string;
}

export interface NativeRequestAuthorityProof {
  sourceId: string;
  workspaceId: string;
  identityId: string;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  projectPublicId: string | null;
  generationId: string;
  sourceSequence: number;
  targetScopes: string[];
  allowedEntitlementIds: string[];
  authority: PortalSourceAuthorityProof;
  denylistEnabled: boolean;
  evaluatedAt: string;
  expiresAt: string;
}

export interface NativeRequestStorageOwner {
  accountId: string;
  storageIdentityId: string;
}

function database(env: Env) {
  return env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
}

const NATIVE_REQUEST_SCHEMA_CACHE_MS = 30_000;
const nativeRequestSchemaCache = new WeakMap<object, { checkedAt: number; ready: boolean }>();
const nativeRequestTables = [
  "portal_native_request_storage_bindings",
  "portal_native_request_attachment_part_tickets",
] as const;
const nativeRequestTriggers = [
  "portal_native_request_storage_binding_conflicting_insert",
  "portal_native_request_storage_binding_owner_update",
  "portal_native_request_storage_binding_delete",
  "portal_native_request_attachment_ticket_owner_update",
  "client_request_drafts_native_owner_insert",
  "client_requests_native_owner_insert",
  "client_request_drafts_native_owner_update",
  "client_request_drafts_native_project_update",
  "client_requests_native_owner_update",
  "client_request_drafts_native_shape_update",
  "client_requests_native_shape_update",
] as const;
const nativeRequestOwnerColumns = ["portal_workspace_id", "portal_identity_id", "portal_project_public_id"] as const;

/** Exact expand-contract probe for migration 0185. The cache is deliberately
 * short and keyed by the D1 binding, so an expand can become visible without a
 * Worker restart while repeated workspace-shell reads stay bounded. */
export async function nativeRequestSchemaReady(
  env: Env,
  options: { refresh?: boolean; now?: number } = {},
): Promise<boolean> {
  const key = env.DELIVERY_DB as unknown as object;
  const now = options.now ?? Date.now();
  const cached = nativeRequestSchemaCache.get(key);
  if (!options.refresh && cached && now - cached.checkedAt < NATIVE_REQUEST_SCHEMA_CACHE_MS) return cached.ready;
  let ready = false;
  try {
    const names = [...nativeRequestTables, ...nativeRequestTriggers];
    const objects = (await database(env).prepare(
      `SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")})`,
    ).bind(...names).all<{ type: "table" | "trigger"; name: string }>()).results;
    const present = new Set(objects.map(row => `${row.type}:${row.name}`));
    const objectsReady = nativeRequestTables.every(name => present.has(`table:${name}`))
      && nativeRequestTriggers.every(name => present.has(`trigger:${name}`));
    if (objectsReady) {
      const [draftColumns, requestColumns] = await Promise.all([
        database(env).prepare("PRAGMA table_info(client_service_request_drafts)").all<{ name: string }>(),
        database(env).prepare("PRAGMA table_info(client_service_requests)").all<{ name: string }>(),
      ]);
      const draft = new Set(draftColumns.results.map(row => row.name));
      const request = new Set(requestColumns.results.map(row => row.name));
      ready = nativeRequestOwnerColumns.every(name => draft.has(name) && request.has(name));
    }
  } catch {
    ready = false;
  }
  nativeRequestSchemaCache.set(key, { checkedAt: now, ready });
  return ready;
}

export function nativeServiceRequestsEnabled(env: Env): boolean {
  return env.CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED === "true"
    && env.CLIENT_PORTAL_REQUEST_V2_ENABLED === "true"
    && portalHierarchyV2Enabled(env);
}

function principalFromSession(session: ClientPortalSession): VerifiedClientPrincipal | null {
  return session.workspaceId && session.principalIssuer && session.principalSubject
    ? { issuer: session.principalIssuer, subject: session.principalSubject, email: session.principalEmail ?? "" }
    : null;
}

export async function resolveNativeRequestAuthority(
  env: Env,
  session: ClientPortalSession,
  projectPublicId: string | null,
): Promise<NativeRequestAuthorityProof | null> {
  if (!nativeServiceRequestsEnabled(env) || !await nativeRequestSchemaReady(env)
    || (projectPublicId !== null && !PUBLIC_ID.test(projectPublicId))) return null;
  const principal = principalFromSession(session);
  if (!principal || !session.workspaceId) return null;
  const context = await resolveNativePortalWorkspaceReadContext(env, principal, session.workspaceId);
  if (!context || !SOURCE_ID.test(context.sourceId)
    || (session.nativeSourceId && session.nativeSourceId !== context.sourceId)
    || (session.nativePortalIdentityId && session.nativePortalIdentityId !== context.identityId)) return null;
  const target = projectPublicId
    ? { scopeType: "project" as const, publicId: projectPublicId }
    : { scopeType: context.rootType, publicId: context.rootPublicId };
  const targetState = (await readNativeTargetScopes(env, context, [target])).get(`${target.scopeType}:${target.publicId}`);
  if (!targetState) return null;
  const scopes = targetState.scopes;
  const rows = await database(env).prepare(`SELECT id,effect,scope_type,scope_public_id
    FROM portal_v2_entitlements
    WHERE workspace_id=? AND identity_id=? AND capability='request.create'
      AND status='active' AND revoked_at IS NULL
      AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
    ORDER BY id LIMIT 201`).bind(context.workspaceId, context.identityId).all<RequestEntitlementRow>();
  if (rows.results.length > 200) return null;
  const applicable = rows.results.filter(row => scopes.has(`${row.scope_type}:${row.scope_public_id}`));
  if (applicable.some(row => row.effect === "deny")) return null;
  const allowed = applicable.filter(row => row.effect === "allow").map(row => row.id);
  if (!allowed.length) return null;
  if (portalIdentityDenylistEnabled(env) && context.denials.some(denial => denial.scope_type === "global"
    || (denial.workspace_id === context.workspaceId && denial.scope_public_id !== null
      && scopes.has(`${denial.scope_type}:${denial.scope_public_id}`)))) return null;
  const checkpoint = await database(env).prepare(`SELECT source_sequence FROM portal_v2_directory_checkpoints
    WHERE workspace_id=? AND active_generation_id=?`).bind(context.workspaceId, context.generationId)
    .first<number>("source_sequence");
  if (!Number.isSafeInteger(checkpoint) || checkpoint! < 0) return null;
  const current = await resolveNativePortalWorkspaceReadContext(env, principal, context.workspaceId);
  if (!current || current.contextVersion !== context.contextVersion) return null;
  const evaluatedAt = new Date().toISOString();
  return Object.freeze({
    sourceId: context.sourceId,
    workspaceId: context.workspaceId,
    identityId: context.identityId,
    rootType: context.rootType,
    rootPublicId: context.rootPublicId,
    projectPublicId,
    generationId: context.generationId,
    sourceSequence: checkpoint!,
    targetScopes: [...scopes].sort(),
    allowedEntitlementIds: allowed.sort(),
    authority: context.authority,
    denylistEnabled: portalIdentityDenylistEnabled(env),
    evaluatedAt,
    expiresAt: new Date(Date.parse(evaluatedAt) + 30_000).toISOString(),
  });
}

export function nativeRequestMutationGuardSql(proof: NativeRequestAuthorityProof): {
  sql: string;
  bindings: unknown[];
} {
  const authority = portalSourceAuthorityGuard(proof.authority);
  const scopes = JSON.stringify(proof.targetScopes);
  const allowed = JSON.stringify(proof.allowedEntitlementIds);
  const targetSql = proof.projectPublicId === null ? "1=1" : `EXISTS(
    SELECT 1 FROM portal_v2_directory_entities project
    WHERE project.workspace_id=workspace.id AND project.generation_id=checkpoint.active_generation_id
      AND project.entity_type='project' AND project.public_id=? AND project.active=1
      AND ('project:' || project.public_id) IN (SELECT value FROM json_each(?)))`;
  const targetBindings = proof.projectPublicId === null ? [] : [proof.projectPublicId, scopes];
  const denialSql = proof.denylistEnabled ? `AND NOT EXISTS(
    SELECT 1 FROM portal_v2_identity_denials denial
    WHERE denial.identity_id=identity.id AND denial.status='active' AND denial.revoked_at IS NULL
      AND datetime(denial.valid_from)<=datetime('now')
      AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
      AND (denial.scope_type='global' OR (denial.workspace_id=workspace.id
        AND denial.scope_public_id IS NOT NULL
        AND (denial.scope_type || ':' || denial.scope_public_id) IN (SELECT value FROM json_each(?)))))` : "";
  return {
    sql: `EXISTS(
      SELECT 1 FROM portal_v2_workspaces workspace
      JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id
        AND owner.projection_source_id=workspace.project_alpha_source_id
      JOIN portal_v2_identities identity ON identity.id=? AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id
        AND membership.identity_id=identity.id AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
        AND checkpoint.active_generation_id=? AND checkpoint.source_sequence=?
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id
        AND root.generation_id=checkpoint.active_generation_id AND root.entity_type=?
        AND root.public_id=? AND root.active=1
      WHERE workspace.id=? AND workspace.status='active' AND workspace.legacy_account_id IS NULL
        AND workspace.project_alpha_source_id=? AND ${authority.sql}
        AND (membership.source_type<>'project_alpha' OR EXISTS(
          SELECT 1 FROM pa_portal_principals current_principal
          WHERE current_principal.workspace_id=workspace.id
            AND current_principal.identity_id=identity.id
            AND current_principal.status='active'
            AND current_principal.source_version=membership.source_version
            AND lower(current_principal.email_hint)=lower(identity.verified_email)))
        AND datetime(?)<=datetime('now') AND datetime(?)>datetime('now')
        AND ${targetSql}
        ${denialSql}
        AND (SELECT COUNT(*) FROM portal_v2_entitlements counted
          WHERE counted.workspace_id=workspace.id AND counted.identity_id=identity.id
            AND counted.capability='request.create' AND counted.status='active' AND counted.revoked_at IS NULL
            AND datetime(counted.valid_from)<=datetime('now')
            AND (counted.expires_at IS NULL OR datetime(counted.expires_at)>datetime('now')))<=200
        AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
          WHERE entitlement.workspace_id=workspace.id AND entitlement.identity_id=identity.id
            AND entitlement.capability='request.create' AND entitlement.effect='deny'
            AND entitlement.status='active' AND entitlement.revoked_at IS NULL
            AND datetime(entitlement.valid_from)<=datetime('now')
            AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
            AND (entitlement.scope_type || ':' || entitlement.scope_public_id) IN (SELECT value FROM json_each(?)))
        AND EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
          WHERE entitlement.workspace_id=workspace.id AND entitlement.identity_id=identity.id
            AND entitlement.capability='request.create' AND entitlement.effect='allow'
            AND entitlement.status='active' AND entitlement.revoked_at IS NULL
            AND datetime(entitlement.valid_from)<=datetime('now')
            AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
            AND (entitlement.scope_type || ':' || entitlement.scope_public_id) IN (SELECT value FROM json_each(?))
            AND entitlement.id IN (SELECT value FROM json_each(?))))`,
    bindings: [
      proof.identityId, proof.generationId, proof.sourceSequence, proof.rootType, proof.rootPublicId,
      proof.workspaceId, proof.sourceId, ...authority.bindings, proof.evaluatedAt, proof.expiresAt,
      ...targetBindings, ...(proof.denylistEnabled ? [scopes] : []), scopes, scopes, allowed,
    ],
  };
}

/** Creates only a source-qualified storage namespace. It does not create a
 * portal membership, entitlement, project grant, or legacy workspace bridge. */
export async function ensureNativeRequestStorage(
  env: Env,
  proof: NativeRequestAuthorityProof,
  displayName: string,
): Promise<NativeRequestStorageOwner | null> {
  const currentGuard = nativeRequestMutationGuardSql(proof);
  if ((await database(env).prepare(`SELECT ${currentGuard.sql} ok`).bind(...currentGuard.bindings)
    .first<number>("ok")) !== 1) return null;
  const existing = await database(env).prepare(`SELECT binding.account_id,binding.storage_identity_id
    FROM portal_native_request_storage_bindings binding
    JOIN client_accounts account ON account.id=binding.account_id AND account.status='active'
      AND account.project_alpha_source_id=binding.source_id
    JOIN client_identity_links identity ON identity.id=binding.storage_identity_id
      AND identity.account_id=binding.account_id AND identity.revoked_at IS NULL
    WHERE binding.workspace_id=? AND binding.source_id=? AND binding.state='active'`)
    .bind(proof.workspaceId, proof.sourceId)
    .first<{ account_id: string; storage_identity_id: string }>();
  if (existing) return { accountId: existing.account_id, storageIdentityId: existing.storage_identity_id };
  const suffix = (await sha256(`${proof.sourceId}\n${proof.workspaceId}`)).slice(0, 32);
  const accountId = `native-request-account:${suffix}`;
  const storageIdentityId = `native-request-storage:${suffix}`;
  const safeName = displayName.trim().slice(0, 200) || "Project Alpha workspace";
  const rootColumns = proof.rootType === "organization"
    ? { client: null, organization: proof.rootPublicId }
    : { client: proof.rootPublicId, organization: null };
  const db = database(env);
  try {
    await db.batch([
      db.prepare(`INSERT INTO client_accounts
        (id,display_name,status,project_alpha_client_id,project_alpha_organization_id,project_alpha_source_id)
        VALUES (?,?,'active',?,?,?) ON CONFLICT(id) DO NOTHING`)
        .bind(accountId, safeName, rootColumns.client, rootColumns.organization, proof.sourceId),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email,last_seen_at)
        SELECT ?,?,'urn:ltds:native-request-storage',?,NULL,datetime('now')
        WHERE EXISTS(SELECT 1 FROM client_accounts account WHERE account.id=? AND account.status='active'
          AND account.project_alpha_source_id=?) ON CONFLICT(id) DO NOTHING`)
        .bind(storageIdentityId, accountId, `${proof.sourceId}:${proof.workspaceId}`, accountId, proof.sourceId),
      db.prepare(`INSERT INTO portal_native_request_storage_bindings
        (workspace_id,source_id,account_id,storage_identity_id)
        SELECT ?,?,?,? WHERE ${currentGuard.sql}
        ON CONFLICT(workspace_id) DO NOTHING`)
        .bind(proof.workspaceId, proof.sourceId, accountId, storageIdentityId, ...currentGuard.bindings),
    ]);
  } catch {
    return null;
  }
  const created = await db.prepare(`SELECT account_id,storage_identity_id
    FROM portal_native_request_storage_bindings
    WHERE workspace_id=? AND source_id=? AND state='active'`)
    .bind(proof.workspaceId, proof.sourceId)
    .first<{ account_id: string; storage_identity_id: string }>();
  return created ? { accountId: created.account_id, storageIdentityId: created.storage_identity_id } : null;
}
