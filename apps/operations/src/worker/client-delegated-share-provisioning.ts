import { HTTPException } from "hono/http-exception";
import { decodeRef, normalizePrefix } from "./delivery";
import { sha256 } from "./crypto";
import type { Env, StaffPrincipal } from "./types";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

type DelegationStatus = "active" | "suspended" | "revoked" | "expired";

export interface DelegatedShareProvisioningState {
  workspaces: Array<{
    id: string;
    displayName: string;
    managers: Array<{
      identityId: string;
      email: string | null;
      entitlementId: string;
      entitlementVersion: number;
    }>;
  }>;
  targets: Array<{
    id: string;
    workspaceId: string;
    folderBindingId: string;
    displayName: string;
    exactRootApproved: boolean;
    status: string;
  }>;
  delegations: Array<{
    id: string;
    workspaceId: string;
    identityId: string;
    managerEmail: string | null;
    rootTargetId: string;
    allowExactRoot: boolean;
    requirePassword: boolean;
    imageLocationMapEnabled: boolean;
    maximumLinkLifetimeSeconds: number;
    version: number;
    status: DelegationStatus;
    expiresAt: string;
  }>;
  shares: Array<{
    id: string;
    publicId: string;
    delegationId: string;
    folderTargetId: string;
    label: string | null;
    status: string;
    expiresAt: string;
    createdAt: string;
  }>;
}

export interface CreateTargetInput {
  workspaceId: string;
  folderBindingId: string;
  folderRef: string;
  displayName: string;
  exactRootApproved: boolean;
}

export interface CreateDelegationInput {
  workspaceId: string;
  identityId: string;
  entitlementId: string;
  rootTargetId: string;
  allowExactRoot?: boolean;
  maximumLinkLifetimeSeconds?: number;
  requirePassword?: boolean;
  imageLocationMapEnabled?: boolean;
  expiresAt: string;
}

export interface DelegatedShareFolderContext {
  workspaceId: string;
  workspaceDisplayName: string;
  folderBindingId: string;
  currentTarget: { id: string; displayName: string; exactRootApproved: boolean } | null;
  ancestorTargets: Array<{ id: string; displayName: string; exactRootApproved: boolean }>;
  managers: Array<{ identityId: string; email: string | null; entitlementId: string }>;
}

function provisioningEnabled(env: Env): void {
  if (env.CLIENT_DELEGATED_SHARE_SIGNER_ENABLED !== "true")
    throw new HTTPException(404, { message: "Not found" });
}

function db(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return candidate.withSession?.("first-primary") ?? candidate;
}

function requireOpaque(...values: string[]): void {
  if (!values.every(value => OPAQUE_ID.test(value)))
    throw new HTTPException(400, { message: "Delegated share identifier is invalid" });
}

function requireKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value))
    throw new HTTPException(400, { message: "A valid Idempotency-Key is required" });
}

function canonicalRelativePrefix(value: string): string | null {
  if (value === "") return "";
  if (value.length > 900 || value !== value.normalize("NFC") || value.startsWith("/") ||
      !value.endsWith("/") || value.includes("//") || value.includes("\\") || value.includes("%") ||
      /[\u0000-\u001f\u007f]/.test(value)) return null;
  const segments = value.slice(0, -1).split("/");
  return segments.some(segment => !segment || segment === "." || segment === "..") ? null : value;
}

async function mutationFingerprint(action: string, input: unknown): Promise<string> {
  return sha256(JSON.stringify(["client-delegated-staff-mutation:v1", action, input]));
}

async function replayedMutation(
  env: Env,
  principal: StaffPrincipal,
  action: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<string | null> {
  const row = await db(env).prepare(`SELECT actor_staff_id,action,entity_id,request_fingerprint
    FROM client_delegated_share_staff_mutations WHERE idempotency_key=?`)
    .bind(idempotencyKey).first<{
      actor_staff_id: string; action: string; entity_id: string; request_fingerprint: string;
    }>();
  if (!row) return null;
  if (row.actor_staff_id !== principal.id || row.action !== action || row.request_fingerprint !== fingerprint)
    throw new HTTPException(409, { message: "Idempotency-Key was already used for another change" });
  return row.entity_id;
}

function eventStatement(
  database: D1Database,
  workspaceId: string,
  entityId: string,
  actorId: string,
  eventType: string,
  details: Record<string, unknown> = {},
): D1PreparedStatement {
  const safeDetails = eventType.startsWith("target.") ? { targetId: entityId, ...details } : details;
  return database.prepare(`INSERT INTO client_delegated_share_events
    (id,workspace_id,delegation_id,actor_type,actor_id,event_type,details_json)
    VALUES (?,?,?,?,?,?,?)`).bind(
      `staff-event-${crypto.randomUUID()}`, workspaceId,
      eventType.startsWith("delegation.") ? entityId : null,
      "staff", actorId, eventType, JSON.stringify(safeDetails),
    );
}

export async function listDelegatedShareProvisioning(
  env: Env,
): Promise<DelegatedShareProvisioningState> {
  provisioningEnabled(env);
  const database = db(env);
  const [workspaceRows, managerRows, targets, delegations, shares] = await Promise.all([
    database.prepare(`SELECT id,display_name FROM portal_v2_workspaces
      WHERE status='active' ORDER BY display_name COLLATE NOCASE,id LIMIT 201`).all<{ id: string; display_name: string }>(),
    database.prepare(`SELECT DISTINCT membership.workspace_id,identity.id identity_id,identity.verified_email,
        entitlement.id entitlement_id,entitlement.entitlement_version
      FROM portal_v2_workspace_memberships membership
      JOIN portal_v2_identities identity ON identity.id=membership.identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_entitlements entitlement ON entitlement.workspace_id=membership.workspace_id
        AND entitlement.identity_id=membership.identity_id
        AND entitlement.capability='delegated_share.create' AND entitlement.effect='allow'
        AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now')
        AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
      WHERE membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      ORDER BY identity.verified_email,identity.id,entitlement.entitlement_version DESC LIMIT 501`)
      .all<{ workspace_id: string; identity_id: string; verified_email: string | null; entitlement_id: string; entitlement_version: number }>(),
    database.prepare(`SELECT target.id,target.workspace_id,target.folder_binding_id,label.display_name,
        target.staff_exact_root_approved,target.status
      FROM client_share_folder_targets target
      JOIN client_share_folder_target_labels label ON label.target_id=target.id AND label.workspace_id=target.workspace_id
      ORDER BY label.display_name COLLATE NOCASE,target.id LIMIT 501`)
      .all<{ id: string; workspace_id: string; folder_binding_id: string; display_name: string; staff_exact_root_approved: number; status: string }>(),
    database.prepare(`SELECT delegation.id,delegation.workspace_id,delegation.identity_id,identity.verified_email,
        delegation.root_target_id,delegation.allow_exact_root,delegation.require_password,
        delegation.maximum_link_lifetime_seconds,delegation.delegation_version,delegation.status,delegation.expires_at,
        COALESCE(policy.image_location_map_enabled,0) image_location_map_enabled
      FROM client_share_delegations delegation
      JOIN portal_v2_identities identity ON identity.id=delegation.identity_id
      LEFT JOIN client_share_delegation_policies policy
        ON policy.delegation_id=delegation.id AND policy.workspace_id=delegation.workspace_id
      ORDER BY delegation.created_at DESC,delegation.id LIMIT 501`)
      .all<{ id: string; workspace_id: string; identity_id: string; verified_email: string | null; root_target_id: string; allow_exact_root: number; require_password: number; image_location_map_enabled: number; maximum_link_lifetime_seconds: number; delegation_version: number; status: DelegationStatus; expires_at: string }>(),
    database.prepare(`SELECT id,public_id,delegation_id,folder_target_id,label,status,expires_at,created_at
      FROM client_delegated_shares ORDER BY created_at DESC,id LIMIT 501`)
      .all<{ id: string; public_id: string; delegation_id: string; folder_target_id: string; label: string | null; status: string; expires_at: string; created_at: string }>(),
  ]);
  if ([workspaceRows, managerRows, targets, delegations, shares].some(result => result.results.length > (result === workspaceRows ? 200 : 500)))
    throw new HTTPException(409, { message: "Delegated share provisioning list is too large" });
  return {
    workspaces: workspaceRows.results.map(workspace => ({
      id: workspace.id,
      displayName: workspace.display_name,
      managers: managerRows.results.filter(manager => manager.workspace_id === workspace.id).map(manager => ({
        identityId: manager.identity_id,
        email: manager.verified_email,
        entitlementId: manager.entitlement_id,
        entitlementVersion: manager.entitlement_version,
      })),
    })),
    targets: targets.results.map(target => ({
      id: target.id, workspaceId: target.workspace_id, folderBindingId: target.folder_binding_id,
      displayName: target.display_name, exactRootApproved: target.staff_exact_root_approved === 1,
      status: target.status,
    })),
    delegations: delegations.results.map(delegation => ({
      id: delegation.id, workspaceId: delegation.workspace_id, identityId: delegation.identity_id,
      managerEmail: delegation.verified_email, rootTargetId: delegation.root_target_id,
      allowExactRoot: delegation.allow_exact_root === 1, requirePassword: delegation.require_password === 1,
      imageLocationMapEnabled: delegation.image_location_map_enabled === 1,
      maximumLinkLifetimeSeconds: delegation.maximum_link_lifetime_seconds,
      version: delegation.delegation_version, status: delegation.status, expiresAt: delegation.expires_at,
    })),
    shares: shares.results.map(share => ({
      id: share.id, publicId: share.public_id, delegationId: share.delegation_id,
      folderTargetId: share.folder_target_id, label: share.label, status: share.status,
      expiresAt: share.expires_at, createdAt: share.created_at,
    })),
  };
}

export async function delegatedShareFolderContext(
  env: Env,
  authorizedFolderKey: string,
): Promise<DelegatedShareFolderContext | null> {
  provisioningEnabled(env);
  let folderPrefix = authorizedFolderKey.endsWith("/") ? authorizedFolderKey : `${authorizedFolderKey}/`;
  folderPrefix = normalizePrefix(folderPrefix);
  const database = db(env);
  const binding = await database.prepare(`SELECT binding.id,binding.workspace_id,binding.r2_prefix,
      workspace.display_name
    FROM portal_v2_folder_bindings binding
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'
    WHERE binding.status='active' AND binding.revoked_at IS NULL
      AND substr(?,1,length(binding.r2_prefix))=binding.r2_prefix
    ORDER BY length(binding.r2_prefix) DESC,binding.id LIMIT 2`).bind(folderPrefix)
    .all<{ id: string; workspace_id: string; r2_prefix: string; display_name: string }>();
  if (!binding.results.length || (binding.results[1] &&
      binding.results[1].r2_prefix.length === binding.results[0]!.r2_prefix.length)) return null;
  const selectedBinding = binding.results[0]!;
  const relativePrefix = canonicalRelativePrefix(folderPrefix.slice(normalizePrefix(selectedBinding.r2_prefix).length));
  if (relativePrefix === null) return null;
  const [targets, managers] = await Promise.all([
    database.prepare(`SELECT target.id,target.relative_prefix,target.staff_exact_root_approved,label.display_name
      FROM client_share_folder_targets target
      JOIN client_share_folder_target_labels label ON label.target_id=target.id AND label.workspace_id=target.workspace_id
      WHERE target.workspace_id=? AND target.folder_binding_id=? AND target.status='active' AND target.revoked_at IS NULL
        AND substr(?,1,length(target.relative_prefix))=target.relative_prefix
      ORDER BY length(target.relative_prefix) DESC,target.id LIMIT 101`)
      .bind(selectedBinding.workspace_id, selectedBinding.id, relativePrefix)
      .all<{ id: string; relative_prefix: string; staff_exact_root_approved: number; display_name: string }>(),
    database.prepare(`SELECT DISTINCT identity.id identity_id,identity.verified_email,entitlement.id entitlement_id
      FROM portal_v2_workspace_memberships membership
      JOIN portal_v2_identities identity ON identity.id=membership.identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_entitlements entitlement ON entitlement.workspace_id=membership.workspace_id
        AND entitlement.identity_id=membership.identity_id AND entitlement.capability='delegated_share.create'
        AND entitlement.effect='allow' AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now')
        AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
      WHERE membership.workspace_id=? AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      ORDER BY identity.verified_email,identity.id LIMIT 101`).bind(selectedBinding.workspace_id)
      .all<{ identity_id: string; verified_email: string | null; entitlement_id: string }>(),
  ]);
  if (targets.results.length > 100 || managers.results.length > 100)
    throw new HTTPException(409, { message: "Folder delegation context is too large" });
  const safeTargets = targets.results.map(target => ({
    id: target.id, displayName: target.display_name,
    exactRootApproved: target.staff_exact_root_approved === 1,
  }));
  const currentIndex = targets.results.findIndex(target => target.relative_prefix === relativePrefix);
  return {
    workspaceId: selectedBinding.workspace_id,
    workspaceDisplayName: selectedBinding.display_name,
    folderBindingId: selectedBinding.id,
    currentTarget: currentIndex >= 0 ? safeTargets[currentIndex]! : null,
    ancestorTargets: safeTargets.filter((_, index) => index !== currentIndex),
    managers: managers.results.map(manager => ({
      identityId: manager.identity_id, email: manager.verified_email, entitlementId: manager.entitlement_id,
    })),
  };
}

export async function createDelegatedShareTarget(
  env: Env,
  principal: StaffPrincipal,
  input: CreateTargetInput,
  idempotencyKey: string,
): Promise<{ id: string; replayed: boolean }> {
  provisioningEnabled(env);
  requireOpaque(input.workspaceId, input.folderBindingId);
  requireKey(idempotencyKey);
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 160)
    throw new HTTPException(400, { message: "Target name is invalid" });
  const fingerprint = await mutationFingerprint("target.create", { ...input, displayName });
  const replay = await replayedMutation(env, principal, "target.create", idempotencyKey, fingerprint);
  if (replay) return { id: replay, replayed: true };
  const database = db(env);
  const binding = await database.prepare(`SELECT r2_prefix,source_version FROM portal_v2_folder_bindings
    WHERE id=? AND workspace_id=? AND status='active' AND revoked_at IS NULL`)
    .bind(input.folderBindingId, input.workspaceId)
    .first<{ r2_prefix: string; source_version: string | null }>();
  if (!binding?.source_version) throw new HTTPException(404, { message: "Folder binding not found" });
  const bindingPrefix = normalizePrefix(binding.r2_prefix);
  let selected = decodeRef(input.folderRef);
  if (!selected.endsWith("/")) selected = `${selected}/`;
  selected = normalizePrefix(selected);
  if (!selected.startsWith(bindingPrefix)) throw new HTTPException(404, { message: "Folder binding not found" });
  const relativePrefix = canonicalRelativePrefix(selected.slice(bindingPrefix.length));
  if (relativePrefix === null || (relativePrefix === "" && !input.exactRootApproved))
    throw new HTTPException(400, { message: "Selecting the binding root requires explicit staff approval" });
  const id = `client-target-${crypto.randomUUID()}`;
  try {
    await database.batch([
      database.prepare(`INSERT INTO client_share_folder_targets
        (id,workspace_id,folder_binding_id,binding_source_version,relative_prefix,
         staff_exact_root_approved,created_by_staff_id)
        VALUES (?,?,?,?,?,?,?)`).bind(
          id, input.workspaceId, input.folderBindingId, binding.source_version,
          relativePrefix, input.exactRootApproved ? 1 : 0, principal.id,
        ),
      database.prepare(`INSERT INTO client_share_folder_target_labels
        (target_id,workspace_id,display_name) VALUES (?,?,?)`)
        .bind(id, input.workspaceId, displayName),
      database.prepare(`INSERT INTO client_delegated_share_staff_mutations
        (idempotency_key,workspace_id,actor_staff_id,action,entity_id,request_fingerprint)
        VALUES (?,?,?,'target.create',?,?)`)
        .bind(idempotencyKey, input.workspaceId, principal.id, id, fingerprint),
      eventStatement(database, input.workspaceId, id, principal.id, "target.created", {
        folderBindingId: input.folderBindingId, exactRootApproved: input.exactRootApproved,
      }),
    ]);
  } catch {
    const concurrent = await replayedMutation(env, principal, "target.create", idempotencyKey, fingerprint);
    if (concurrent) return { id: concurrent, replayed: true };
    throw new HTTPException(409, { message: "That folder target already exists or changed" });
  }
  return { id, replayed: false };
}

async function qualifyingEntitlement(
  database: D1Database,
  input: { workspaceId: string; identityId: string; entitlementId: string; rootTargetId: string },
): Promise<{ version: number; folderBindingId: string; sourceVersion: string } | null> {
  return database.prepare(`WITH RECURSIVE candidate AS (
      SELECT entitlement.entitlement_version,entitlement.scope_type,entitlement.scope_public_id,
        binding.id folder_binding_id,binding.owner_scope_type,binding.owner_public_id,binding.source_version,
        workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id
      FROM portal_v2_workspace_memberships membership
      JOIN portal_v2_identities identity ON identity.id=membership.identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspaces workspace ON workspace.id=membership.workspace_id AND workspace.status='active'
      JOIN portal_v2_entitlements entitlement ON entitlement.id=? AND entitlement.workspace_id=membership.workspace_id
        AND entitlement.identity_id=membership.identity_id AND entitlement.capability='delegated_share.create'
        AND entitlement.effect='allow' AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now')
        AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
      JOIN client_share_folder_targets target ON target.id=? AND target.workspace_id=membership.workspace_id
        AND target.status='active' AND target.revoked_at IS NULL
      JOIN portal_v2_folder_bindings binding ON binding.id=target.folder_binding_id
        AND binding.workspace_id=target.workspace_id AND binding.status='active' AND binding.revoked_at IS NULL
        AND binding.source_version=target.binding_source_version
      WHERE membership.workspace_id=? AND membership.identity_id=? AND membership.status='active'
        AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    ), lineage(entity_type,public_id,parent_public_id,depth) AS (
      SELECT entity.entity_type,entity.public_id,entity.parent_public_id,0 FROM candidate
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities entity ON entity.workspace_id=checkpoint.workspace_id
        AND entity.generation_id=checkpoint.active_generation_id AND entity.entity_type=candidate.owner_scope_type
        AND entity.public_id=candidate.owner_public_id AND entity.active=1
      UNION ALL
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1 FROM lineage
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=checkpoint.workspace_id
        AND parent.generation_id=checkpoint.active_generation_id AND parent.public_id=lineage.parent_public_id
        AND parent.active=1 WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<8
    )
    SELECT entitlement_version version,folder_binding_id folderBindingId,source_version sourceVersion FROM candidate
    WHERE EXISTS (SELECT 1 FROM lineage WHERE entity_type=candidate.root_type AND public_id=candidate.root_public_id)
      AND ((scope_type='workspace' AND scope_public_id=?)
        OR (scope_type='folder' AND scope_public_id=folder_binding_id)
        OR EXISTS (SELECT 1 FROM lineage WHERE entity_type=candidate.scope_type AND public_id=candidate.scope_public_id))
      AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements denied
        WHERE denied.workspace_id=? AND denied.identity_id=? AND denied.capability='delegated_share.create'
          AND denied.effect='deny' AND denied.status='active' AND denied.revoked_at IS NULL
          AND datetime(denied.valid_from)<=datetime('now')
          AND (denied.expires_at IS NULL OR datetime(denied.expires_at)>datetime('now'))
          AND ((denied.scope_type='workspace' AND denied.scope_public_id=?)
            OR (denied.scope_type='folder' AND denied.scope_public_id=folder_binding_id)
            OR EXISTS (SELECT 1 FROM lineage WHERE entity_type=denied.scope_type AND public_id=denied.scope_public_id)))
    LIMIT 1`).bind(
      input.entitlementId, input.rootTargetId, input.workspaceId, input.identityId,
      input.workspaceId, input.workspaceId, input.workspaceId,
      input.workspaceId, input.identityId, input.workspaceId,
    ).first<{ version: number; folderBindingId: string; sourceVersion: string }>();
}

export async function createDelegatedShareDelegation(
  env: Env,
  principal: StaffPrincipal,
  input: CreateDelegationInput,
  idempotencyKey: string,
): Promise<{ id: string; replayed: boolean }> {
  provisioningEnabled(env);
  requireOpaque(input.workspaceId, input.identityId, input.entitlementId, input.rootTargetId);
  requireKey(idempotencyKey);
  const lifetime = input.maximumLinkLifetimeSeconds ?? 604800;
  const expiresAt = new Date(input.expiresAt);
  if (!Number.isInteger(lifetime) || lifetime < 300 || lifetime > 2592000 ||
      !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 300_000)
    throw new HTTPException(400, { message: "Delegation policy is invalid" });
  const normalized = {
    ...input, allowExactRoot: input.allowExactRoot === true,
    requirePassword: input.requirePassword === true,
    imageLocationMapEnabled: input.imageLocationMapEnabled === true,
    maximumLinkLifetimeSeconds: lifetime, expiresAt: expiresAt.toISOString(),
  };
  const fingerprint = await mutationFingerprint("delegation.create", normalized);
  const replay = await replayedMutation(env, principal, "delegation.create", idempotencyKey, fingerprint);
  if (replay) return { id: replay, replayed: true };
  const database = db(env);
  const entitlement = await qualifyingEntitlement(database, input);
  if (!entitlement) throw new HTTPException(404, { message: "Manager entitlement is not authorized for this folder" });
  const target = await database.prepare(`SELECT staff_exact_root_approved,relative_prefix FROM client_share_folder_targets
    WHERE id=? AND workspace_id=? AND status='active' AND revoked_at IS NULL`)
    .bind(input.rootTargetId, input.workspaceId).first<{ staff_exact_root_approved: number; relative_prefix: string }>();
  if (!target || (normalized.allowExactRoot && target.relative_prefix === "" && target.staff_exact_root_approved !== 1))
    throw new HTTPException(400, { message: "Exact-root delegation requires explicit target approval" });
  const id = `client-delegation-${crypto.randomUUID()}`;
  try {
    await database.batch([
      database.prepare(`INSERT INTO client_share_delegations
        (id,workspace_id,identity_id,entitlement_id,entitlement_version,folder_binding_id,
         folder_binding_source_version,root_target_id,allow_exact_root,
         maximum_link_lifetime_seconds,require_password,expires_at,created_by_staff_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          id, input.workspaceId, input.identityId, input.entitlementId, entitlement.version,
          entitlement.folderBindingId, entitlement.sourceVersion, input.rootTargetId,
          normalized.allowExactRoot ? 1 : 0, lifetime, normalized.requirePassword ? 1 : 0,
          normalized.expiresAt, principal.id,
        ),
      database.prepare(`INSERT INTO client_delegated_share_staff_mutations
        (idempotency_key,workspace_id,actor_staff_id,action,entity_id,request_fingerprint)
        VALUES (?,?,?,'delegation.create',?,?)`)
        .bind(idempotencyKey, input.workspaceId, principal.id, id, fingerprint),
      database.prepare(`INSERT INTO client_share_delegation_policies
        (delegation_id,workspace_id,image_location_map_enabled,created_by_staff_id)
        VALUES (?,?,?,?)`).bind(
          id, input.workspaceId, normalized.imageLocationMapEnabled ? 1 : 0, principal.id,
        ),
      eventStatement(database, input.workspaceId, id, principal.id, "delegation.created", {
        allowExactRoot: normalized.allowExactRoot, requirePassword: normalized.requirePassword,
        imageLocationMapEnabled: normalized.imageLocationMapEnabled,
      }),
    ]);
  } catch (error) {
    const concurrent = await replayedMutation(env, principal, "delegation.create", idempotencyKey, fingerprint);
    if (concurrent) return { id: concurrent, replayed: true };
    console.warn(JSON.stringify({
      event: "client-delegated-share.delegation-create-failed",
      message: error instanceof Error ? error.message : "unknown",
    }));
    throw new HTTPException(409, { message: "Delegation could not be created" });
  }
  return { id, replayed: false };
}

export async function transferDelegatedShareDelegation(
  env: Env,
  principal: StaffPrincipal,
  delegationId: string,
  input: { identityId: string; entitlementId: string; expectedVersion: number },
  idempotencyKey: string,
): Promise<{ id: string; version: number; replayed: boolean }> {
  provisioningEnabled(env);
  requireOpaque(delegationId, input.identityId, input.entitlementId);
  requireKey(idempotencyKey);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new HTTPException(400, { message: "Delegation version is invalid" });
  const database = db(env);
  const current = await database.prepare(`SELECT workspace_id,root_target_id,delegation_version,status
    FROM client_share_delegations WHERE id=?`).bind(delegationId)
    .first<{ workspace_id: string; root_target_id: string; delegation_version: number; status: string }>();
  if (!current || current.status !== "active") throw new HTTPException(404, { message: "Delegation not found" });
  const fingerprint = await mutationFingerprint("delegation.transfer", { delegationId, ...input });
  const replay = await replayedMutation(env, principal, "delegation.transfer", idempotencyKey, fingerprint);
  if (replay) {
    const version = await database.prepare("SELECT delegation_version FROM client_share_delegations WHERE id=?")
      .bind(delegationId).first<number>("delegation_version");
    return { id: replay, version: version ?? input.expectedVersion + 1, replayed: true };
  }
  const entitlement = await qualifyingEntitlement(database, {
    workspaceId: current.workspace_id, identityId: input.identityId,
    entitlementId: input.entitlementId, rootTargetId: current.root_target_id,
  });
  if (!entitlement) throw new HTTPException(404, { message: "Replacement manager is not authorized for this folder" });
  const nextVersion = input.expectedVersion + 1;
  const result = await database.batch([
    database.prepare(`UPDATE client_share_delegations SET identity_id=?,entitlement_id=?,
      entitlement_version=?,delegation_version=delegation_version+1,updated_at=datetime('now')
      WHERE id=? AND delegation_version=? AND status='active' AND revoked_at IS NULL`)
      .bind(input.identityId, input.entitlementId, entitlement.version, delegationId, input.expectedVersion),
    database.prepare(`INSERT INTO client_delegated_share_staff_mutations
      (idempotency_key,workspace_id,actor_staff_id,action,entity_id,request_fingerprint)
      SELECT ?,?,?, 'delegation.transfer',?,? WHERE EXISTS (
        SELECT 1 FROM client_share_delegations WHERE id=? AND identity_id=? AND delegation_version=?
      )`).bind(idempotencyKey, current.workspace_id, principal.id, delegationId, fingerprint,
        delegationId, input.identityId, nextVersion),
    database.prepare(`INSERT INTO client_delegated_share_events
      (id,workspace_id,delegation_id,actor_type,actor_id,event_type,details_json)
      SELECT ?,?,?, 'staff',?,'delegation.transferred',? WHERE EXISTS (
        SELECT 1 FROM client_share_delegations WHERE id=? AND identity_id=? AND delegation_version=?
      )`).bind(`staff-event-${crypto.randomUUID()}`, current.workspace_id, delegationId,
        principal.id, JSON.stringify({ replacementIdentityId: input.identityId, expectedVersion: input.expectedVersion }),
        delegationId, input.identityId, nextVersion),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new HTTPException(409, { message: "Delegation changed; refresh before transferring" });
  return { id: delegationId, version: nextVersion, replayed: false };
}

export async function revokeDelegatedShareProvisioningEntity(
  env: Env,
  principal: StaffPrincipal,
  kind: "target" | "delegation",
  entityId: string,
  idempotencyKey: string,
): Promise<{ id: string; replayed: boolean }> {
  provisioningEnabled(env);
  requireOpaque(entityId);
  requireKey(idempotencyKey);
  const database = db(env);
  const row = kind === "target"
    ? await database.prepare("SELECT workspace_id,status FROM client_share_folder_targets WHERE id=?")
      .bind(entityId).first<{ workspace_id: string; status: string }>()
    : await database.prepare("SELECT workspace_id,status FROM client_share_delegations WHERE id=?")
      .bind(entityId).first<{ workspace_id: string; status: string }>();
  if (!row) throw new HTTPException(404, { message: `${kind === "target" ? "Target" : "Delegation"} not found` });
  const action = `${kind}.revoke`;
  const fingerprint = await mutationFingerprint(action, { entityId });
  const replay = await replayedMutation(env, principal, action, idempotencyKey, fingerprint);
  if (replay) return { id: replay, replayed: true };
  if (row.status === "revoked") throw new HTTPException(409, { message: "Already revoked; use the original idempotency key to replay" });
  const update = kind === "target"
    ? database.prepare(`UPDATE client_share_folder_targets SET status='revoked',revoked_at=datetime('now'),updated_at=datetime('now')
        WHERE id=? AND status<>'revoked'`).bind(entityId)
    : database.prepare(`UPDATE client_share_delegations SET status='revoked',revoked_at=datetime('now'),
        revoked_by_staff_id=?,delegation_version=delegation_version+1,updated_at=datetime('now')
        WHERE id=? AND status<>'revoked'`).bind(principal.id, entityId);
  const result = await database.batch([
    update,
    database.prepare(`INSERT INTO client_delegated_share_staff_mutations
      (idempotency_key,workspace_id,actor_staff_id,action,entity_id,request_fingerprint)
      VALUES (?,?,?,?,?,?)`).bind(idempotencyKey, row.workspace_id, principal.id, action, entityId, fingerprint),
    eventStatement(database, row.workspace_id, entityId, principal.id, `${kind}.revoked`),
  ]);
  if (result[0]?.meta.changes !== 1) throw new HTTPException(409, { message: "Provisioning state changed" });
  return { id: entityId, replayed: false };
}
