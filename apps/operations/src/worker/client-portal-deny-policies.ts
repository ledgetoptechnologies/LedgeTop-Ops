import { HTTPException } from "hono/http-exception";
import { isAdministrator } from "./acl";
import type { Env, StaffPrincipal } from "./types";

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
export type PortalDenialScopeType = "global" | "workspace" | "organization" | "standalone_client" | "department" | "client" | "project" | "folder" | "contact";

export interface PortalIdentityDenialInput {
  identityId: string;
  workspaceId?: string | null;
  scopeType: PortalDenialScopeType;
  scopePublicId?: string | null;
  reasonCode: string;
  expiresAt?: string | null;
}

export interface PortalIdentityDenialView {
  id: string;
  identityId: string;
  workspaceId: string | null;
  scopeType: PortalDenialScopeType;
  scopePublicId: string | null;
  reasonCode: string;
  status: "active" | "revoked";
  validFrom: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PortalIdentityDenialListItem extends PortalIdentityDenialView {
  identityLabel: string;
  identityEmail: string | null;
  workspaceLabel: string | null;
  scopeLabel: string;
}

function database(env: Env): D1Database {
  const db = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return db.withSession?.("first-primary") ?? db;
}

export function portalDenyPolicyManagementEnabled(env: Env): boolean {
  // Never let staff create a denial that the Client Worker would ignore.
  // Rollout must enable the management and live-enforcement halves together.
  return env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" &&
    env.CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED === "true";
}

async function requirePortalDenyAdministrator(env: Env, principal: StaffPrincipal): Promise<void> {
  if (!portalDenyPolicyManagementEnabled(env)) throw new HTTPException(404, { message: "Not found" });
  if (!(await isAdministrator(env, principal))) throw new HTTPException(403, { message: "Administrator access is required" });
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function expiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.now() + 60_000 || parsed > Date.now() + 366 * 24 * 60 * 60 * 1000)
    throw new HTTPException(400, { message: "Denial expiry must be between one minute and one year from now" });
  return new Date(parsed).toISOString();
}

async function denialView(db: D1Database, denialId: string): Promise<PortalIdentityDenialView | null> {
  const row = await db.prepare(`SELECT id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,status,
      valid_from,expires_at,created_at,updated_at
    FROM portal_v2_identity_denials WHERE id=?`).bind(denialId).first<{
      id: string; identity_id: string; workspace_id: string | null; scope_type: PortalDenialScopeType;
      scope_public_id: string | null; reason_code: string; status: "active" | "revoked";
      valid_from: string; expires_at: string | null; created_at: string; updated_at: string;
    }>();
  return row ? { id: row.id, identityId: row.identity_id, workspaceId: row.workspace_id,
    scopeType: row.scope_type, scopePublicId: row.scope_public_id, reasonCode: row.reason_code,
    status: row.status, validFrom: row.valid_from, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

async function replay(db: D1Database, actorId: string, key: string, action: string, fingerprint: string): Promise<PortalIdentityDenialView | null> {
  const row = await db.prepare(`SELECT request_fingerprint,action,denial_id
    FROM portal_v2_identity_denial_mutations WHERE actor_staff_id=? AND idempotency_key=?`)
    .bind(actorId, key).first<{ request_fingerprint: string; action: string; denial_id: string }>();
  if (!row) return null;
  if (row.action !== action || row.request_fingerprint !== fingerprint)
    throw new HTTPException(409, { message: "Idempotency-Key was already used for a different denial request" });
  return denialView(db, row.denial_id);
}

async function validateScope(db: D1Database, input: PortalIdentityDenialInput): Promise<void> {
  if (input.scopeType === "global") {
    if (input.workspaceId || input.scopePublicId) throw new HTTPException(400, { message: "Global denial scope is invalid" });
    return;
  }
  if (!input.workspaceId || !OPAQUE.test(input.workspaceId)) throw new HTTPException(400, { message: "Denial workspace is invalid" });
  if (input.scopeType === "workspace") {
    if (input.scopePublicId !== input.workspaceId) throw new HTTPException(400, { message: "Workspace denial scope is invalid" });
    const active = await db.prepare("SELECT 1 ok FROM portal_v2_workspaces WHERE id=? AND status='active'").bind(input.workspaceId).first("ok");
    if (active === null) throw new HTTPException(404, { message: "Workspace not found" });
    return;
  }
  if (!input.scopePublicId || !OPAQUE.test(input.scopePublicId)) throw new HTTPException(400, { message: "Denial scope is invalid" });
  if (input.scopeType === "folder") {
    const active = await db.prepare(`SELECT 1 ok FROM portal_v2_folder_bindings
      WHERE id=? AND workspace_id=? AND status='active' AND revoked_at IS NULL`)
      .bind(input.scopePublicId, input.workspaceId).first("ok");
    if (active === null) throw new HTTPException(404, { message: "Denial scope not found" });
    return;
  }
  const active = await db.prepare(`SELECT 1 ok FROM portal_v2_directory_checkpoints checkpoint
    JOIN portal_v2_directory_generations generation
      ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities entity
      ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
      AND entity.entity_type=? AND entity.public_id=? AND entity.active=1
    WHERE checkpoint.workspace_id=?`).bind(input.scopeType, input.scopePublicId, input.workspaceId).first("ok");
  if (active === null) throw new HTTPException(404, { message: "Denial scope not found" });
}

async function protectLastWorkspaceManager(db: D1Database, identityId: string, workspaceId: string | null): Promise<void> {
  const managed = await db.prepare(`SELECT membership.workspace_id
    FROM portal_v2_workspace_memberships membership
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id
      AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN portal_v2_entitlements allow_record
      ON allow_record.workspace_id=membership.workspace_id AND allow_record.identity_id=membership.identity_id
      AND allow_record.capability='member.manage' AND allow_record.effect='allow'
      AND allow_record.scope_type='workspace' AND allow_record.scope_public_id=membership.workspace_id
      AND allow_record.status='active' AND allow_record.revoked_at IS NULL
      AND datetime(allow_record.valid_from)<=datetime('now')
      AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
    WHERE membership.identity_id=? AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      AND (? IS NULL OR membership.workspace_id=?)
      AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements deny_record
        WHERE deny_record.workspace_id=allow_record.workspace_id AND deny_record.identity_id=allow_record.identity_id
          AND deny_record.capability='member.manage' AND deny_record.effect='deny'
          AND deny_record.scope_type='workspace' AND deny_record.scope_public_id=allow_record.scope_public_id
          AND deny_record.status='active' AND deny_record.revoked_at IS NULL
          AND datetime(deny_record.valid_from)<=datetime('now')
          AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now')))
    GROUP BY membership.workspace_id LIMIT 101`).bind(identityId, workspaceId, workspaceId).all<{ workspace_id: string }>();
  if (managed.results.length > 100) throw new HTTPException(409, { message: "Manager scope is too large to deny safely" });
  for (const managedWorkspace of managed.results) {
    const replacement = await db.prepare(`SELECT 1 ok FROM portal_v2_workspace_memberships membership
      JOIN portal_v2_identities identity ON identity.id=membership.identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_entitlements allow_record
        ON allow_record.workspace_id=membership.workspace_id AND allow_record.identity_id=membership.identity_id
      WHERE membership.workspace_id=? AND membership.identity_id<>? AND membership.status='active'
        AND membership.revoked_at IS NULL AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
        AND allow_record.capability='member.manage' AND allow_record.effect='allow'
        AND allow_record.scope_type='workspace' AND allow_record.scope_public_id=membership.workspace_id
        AND allow_record.status='active' AND allow_record.revoked_at IS NULL
        AND datetime(allow_record.valid_from)<=datetime('now')
        AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
        AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements deny_record
          WHERE deny_record.workspace_id=allow_record.workspace_id AND deny_record.identity_id=allow_record.identity_id
            AND deny_record.capability='member.manage' AND deny_record.effect='deny'
            AND deny_record.scope_type='workspace' AND deny_record.scope_public_id=allow_record.scope_public_id
            AND deny_record.status='active' AND deny_record.revoked_at IS NULL
            AND datetime(deny_record.valid_from)<=datetime('now')
            AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now')))
        AND NOT EXISTS (SELECT 1 FROM portal_v2_identity_denials active_denial
          WHERE active_denial.identity_id=membership.identity_id AND active_denial.status='active'
            AND active_denial.revoked_at IS NULL AND datetime(active_denial.valid_from)<=datetime('now')
            AND (active_denial.expires_at IS NULL OR datetime(active_denial.expires_at)>datetime('now'))
            AND (active_denial.scope_type='global' OR
              (active_denial.workspace_id=membership.workspace_id AND active_denial.scope_type='workspace'
               AND active_denial.scope_public_id=membership.workspace_id)))
      LIMIT 1`).bind(managedWorkspace.workspace_id, identityId).first("ok");
    if (replacement === null) throw new HTTPException(409, { message: "Transfer manager access before denying the last workspace manager" });
  }
}

async function scopedTargetKeys(db: D1Database, workspaceId: string, scopeType: PortalDenialScopeType, publicId: string): Promise<Set<string> | null> {
  if (scopeType === "workspace") return new Set([`workspace:${workspaceId}`]);
  if (scopeType === "global") return null;
  let targetType: Exclude<PortalDenialScopeType, "global" | "workspace" | "folder">;
  let targetId = publicId;
  const keys = new Set<string>([`workspace:${workspaceId}`]);
  if (scopeType === "folder") {
    const binding = await db.prepare(`SELECT owner_scope_type,owner_public_id FROM portal_v2_folder_bindings
      WHERE id=? AND workspace_id=? AND status='active' AND revoked_at IS NULL`).bind(publicId, workspaceId)
      .first<{ owner_scope_type: "organization" | "department" | "client" | "project"; owner_public_id: string }>();
    if (!binding) return null;
    keys.add(`folder:${publicId}`);
    targetType = binding.owner_scope_type;
    targetId = binding.owner_public_id;
  } else targetType = scopeType;
  const rows = await db.prepare(`WITH RECURSIVE lineage(entity_type,public_id,parent_public_id,depth) AS (
      SELECT entity.entity_type,entity.public_id,entity.parent_public_id,0
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_entities entity
        ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
      WHERE checkpoint.workspace_id=? AND entity.entity_type=? AND entity.public_id=? AND entity.active=1
      UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1
      FROM lineage JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=checkpoint.workspace_id AND parent.generation_id=checkpoint.active_generation_id
        AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<12
      UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1
      FROM lineage JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_relations relation
        ON relation.workspace_id=checkpoint.workspace_id AND relation.generation_id=checkpoint.active_generation_id
        AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
        AND relation.relation_type='contains' AND relation.active=1
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=relation.workspace_id AND parent.generation_id=relation.generation_id
        AND parent.entity_type=relation.from_type AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE lineage.depth<12
    ) SELECT entity_type,public_id FROM lineage LIMIT 51`)
    .bind(workspaceId, targetType, targetId, workspaceId, workspaceId)
    .all<{ entity_type: PortalDenialScopeType; public_id: string }>();
  if (!rows.results.length || rows.results.length > 50) return null;
  for (const row of rows.results) keys.add(`${row.entity_type}:${row.public_id}`);
  return keys;
}

async function protectLastScopedManager(db: D1Database, identityId: string, workspaceId: string,
  scopeType: PortalDenialScopeType, publicId: string): Promise<void> {
  const keys = await scopedTargetKeys(db, workspaceId, scopeType, publicId);
  if (!keys) return;
  const rows = await db.prepare(`SELECT membership.identity_id,entitlement.effect,
      entitlement.scope_type,entitlement.scope_public_id
    FROM portal_v2_workspace_memberships membership
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id
      AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN portal_v2_entitlements entitlement
      ON entitlement.workspace_id=membership.workspace_id AND entitlement.identity_id=membership.identity_id
      AND entitlement.capability='member.manage' AND entitlement.status='active' AND entitlement.revoked_at IS NULL
      AND datetime(entitlement.valid_from)<=datetime('now')
      AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
    WHERE membership.workspace_id=? AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    ORDER BY membership.identity_id,entitlement.effect LIMIT 401`).bind(workspaceId)
    .all<{ identity_id: string; effect: "allow" | "deny"; scope_type: PortalDenialScopeType; scope_public_id: string }>();
  if (rows.results.length > 400) throw new HTTPException(409, { message: "Manager scope is too large to deny safely" });
  const byIdentity = new Map<string, { allow: boolean; deny: boolean }>();
  for (const row of rows.results) {
    if (!keys.has(`${row.scope_type}:${row.scope_public_id}`)) continue;
    const state = byIdentity.get(row.identity_id) ?? { allow: false, deny: false };
    if (row.effect === "allow") state.allow = true;
    else state.deny = true;
    byIdentity.set(row.identity_id, state);
  }
  const target = byIdentity.get(identityId);
  if (!target?.allow || target.deny) return;
  for (const [candidateId, state] of byIdentity) {
    if (candidateId === identityId || !state.allow || state.deny) continue;
    const blocked = await db.prepare(`SELECT 1 ok FROM portal_v2_identity_denials
      WHERE identity_id=? AND status='active' AND revoked_at IS NULL
        AND datetime(valid_from)<=datetime('now') AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
        AND (scope_type='global' OR (workspace_id=? AND
          ((scope_type='workspace' AND scope_public_id=?) OR
           (scope_type||':'||scope_public_id) IN (SELECT value FROM json_each(?))))) LIMIT 1`)
      .bind(candidateId, workspaceId, workspaceId, JSON.stringify([...keys])).first("ok");
    if (blocked === null) return;
  }
  throw new HTTPException(409, { message: "Transfer scoped manager access before denying the last effective manager" });
}

async function protectLastEffectiveManager(db: D1Database, identityId: string, input: PortalIdentityDenialInput): Promise<void> {
  if (input.scopeType === "workspace") {
    await protectLastWorkspaceManager(db, identityId, input.workspaceId!);
    return;
  }
  if (input.scopeType !== "global") {
    await protectLastScopedManager(db, identityId, input.workspaceId!, input.scopeType, input.scopePublicId!);
    return;
  }
  await protectLastWorkspaceManager(db, identityId, null);
  const scopes = await db.prepare(`SELECT DISTINCT workspace_id,scope_type,scope_public_id
    FROM portal_v2_entitlements WHERE identity_id=? AND capability='member.manage' AND effect='allow'
      AND scope_type<>'workspace' AND status='active' AND revoked_at IS NULL
      AND datetime(valid_from)<=datetime('now') AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
    ORDER BY workspace_id,scope_type,scope_public_id LIMIT 101`).bind(identityId)
    .all<{ workspace_id: string; scope_type: PortalDenialScopeType; scope_public_id: string }>();
  if (scopes.results.length > 100) throw new HTTPException(409, { message: "Manager scope is too large to deny safely" });
  for (const scope of scopes.results)
    await protectLastScopedManager(db, identityId, scope.workspace_id, scope.scope_type, scope.scope_public_id);
}

export async function searchPortalDenyIdentities(env: Env, principal: StaffPrincipal, queryValue: string, workspaceId?: string | null) {
  await requirePortalDenyAdministrator(env, principal);
  const query = queryValue.trim().toLowerCase();
  if (query.length < 2 || query.length > 100 || (workspaceId && !OPAQUE.test(workspaceId)))
    throw new HTTPException(400, { message: "Identity search is invalid" });
  const rows = await database(env).prepare(`SELECT DISTINCT identity.id,principal.display_name,identity.verified_email
    FROM portal_v2_identities identity
    JOIN pa_portal_principals principal ON principal.identity_id=identity.id AND principal.status='active'
      AND (? IS NULL OR principal.workspace_id=?)
    WHERE identity.status='active' AND identity.revoked_at IS NULL
      AND (lower(principal.display_name) LIKE ? ESCAPE '\\' OR lower(identity.verified_email) LIKE ? ESCAPE '\\')
    ORDER BY lower(principal.display_name),identity.id LIMIT 21`)
    .bind(workspaceId ?? null, workspaceId ?? null, `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`, `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`)
    .all<{ id: string; display_name: string; verified_email: string | null }>();
  if (rows.results.length > 20) throw new HTTPException(409, { message: "Identity search is too broad" });
  return { identities: rows.results.map(row => ({ identityId: row.id, displayName: row.display_name, email: row.verified_email })) };
}

export async function searchPortalDenyScopes(
  env: Env,
  principal: StaffPrincipal,
  scopeType: "workspace" | "organization" | "department" | "client" | "project",
  queryValue: string,
): Promise<{ scopes: Array<{ scopeType: typeof scopeType; workspaceId: string; publicId: string; displayName: string; workspaceLabel: string; breadcrumb: string }> }> {
  await requirePortalDenyAdministrator(env, principal);
  const query = queryValue.trim().toLowerCase();
  if (query.length < 2 || query.length > 100)
    throw new HTTPException(400, { message: "Denial scope search is invalid" });
  const like = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const db = database(env);
  if (scopeType === "workspace") {
    const rows = await db.prepare(`SELECT id,display_name FROM portal_v2_workspaces
      WHERE status='active' AND lower(display_name) LIKE ? ESCAPE '\\'
      ORDER BY lower(display_name),id LIMIT 21`).bind(like)
      .all<{ id: string; display_name: string }>();
    if (rows.results.length > 20) throw new HTTPException(409, { message: "Scope search is too broad" });
    return { scopes: rows.results.map(row => ({ scopeType, workspaceId: row.id, publicId: row.id,
      displayName: row.display_name, workspaceLabel: row.display_name, breadcrumb: row.display_name })) };
  }
  const rows = await db.prepare(`SELECT entity.workspace_id,entity.public_id,entity.display_name,
      workspace.display_name workspace_label,
      COALESCE(parent.display_name,workspace.display_name) parent_label
    FROM portal_v2_directory_checkpoints checkpoint
    JOIN portal_v2_directory_generations generation
      ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_workspaces workspace ON workspace.id=checkpoint.workspace_id AND workspace.status='active'
    JOIN portal_v2_directory_entities entity
      ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
      AND entity.entity_type=? AND entity.active=1
    LEFT JOIN portal_v2_directory_entities parent
      ON parent.workspace_id=entity.workspace_id AND parent.generation_id=entity.generation_id
      AND parent.public_id=entity.parent_public_id AND parent.active=1
    WHERE lower(entity.display_name) LIKE ? ESCAPE '\\' OR lower(workspace.display_name) LIKE ? ESCAPE '\\'
    ORDER BY lower(workspace.display_name),lower(entity.display_name),entity.public_id LIMIT 21`)
    .bind(scopeType, like, like).all<{ workspace_id: string; public_id: string; display_name: string;
      workspace_label: string; parent_label: string }>();
  if (rows.results.length > 20) throw new HTTPException(409, { message: "Scope search is too broad" });
  return { scopes: rows.results.map(row => ({ scopeType, workspaceId: row.workspace_id, publicId: row.public_id,
    displayName: row.display_name, workspaceLabel: row.workspace_label,
    breadcrumb: `${row.workspace_label} › ${row.parent_label} › ${row.display_name}` })) };
}

export async function listPortalIdentityDenials(
  env: Env,
  principal: StaffPrincipal,
): Promise<{ denials: PortalIdentityDenialListItem[] }> {
  await requirePortalDenyAdministrator(env, principal);
  const rows = await database(env).prepare(`SELECT denial.id,denial.identity_id,denial.workspace_id,
      denial.scope_type,denial.scope_public_id,denial.reason_code,denial.status,denial.valid_from,
      denial.expires_at,denial.created_at,denial.updated_at,identity.verified_email,
      COALESCE((SELECT display_name FROM pa_portal_principals
        WHERE identity_id=identity.id ORDER BY status='active' DESC,display_name LIMIT 1),'Verified portal identity') identity_label,
      workspace.display_name workspace_label,
      COALESCE(entity.display_name,binding_label.display_name,
        CASE WHEN denial.scope_type='global' THEN 'All client workspaces'
             WHEN denial.scope_type='workspace' THEN workspace.display_name
             ELSE 'Scoped portal resource' END) scope_label
    FROM portal_v2_identity_denials denial
    JOIN portal_v2_identities identity ON identity.id=denial.identity_id
    LEFT JOIN portal_v2_workspaces workspace ON workspace.id=denial.workspace_id
    LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=denial.workspace_id
    LEFT JOIN portal_v2_directory_entities entity
      ON denial.scope_type NOT IN ('global','workspace','folder')
      AND entity.workspace_id=denial.workspace_id AND entity.generation_id=checkpoint.active_generation_id
      AND entity.entity_type=denial.scope_type AND entity.public_id=denial.scope_public_id
    LEFT JOIN portal_v2_folder_bindings binding ON denial.scope_type='folder'
      AND binding.workspace_id=denial.workspace_id AND binding.id=denial.scope_public_id
    LEFT JOIN portal_v2_directory_entities binding_label
      ON binding_label.workspace_id=binding.workspace_id AND binding_label.generation_id=checkpoint.active_generation_id
      AND binding_label.entity_type=binding.owner_scope_type AND binding_label.public_id=binding.owner_public_id
    ORDER BY denial.updated_at DESC,denial.id DESC LIMIT 101`).all<{
      id: string; identity_id: string; workspace_id: string | null; scope_type: PortalDenialScopeType;
      scope_public_id: string | null; reason_code: string; status: "active" | "revoked";
      valid_from: string; expires_at: string | null; created_at: string; updated_at: string;
      verified_email: string | null; identity_label: string; workspace_label: string | null; scope_label: string;
    }>();
  if (rows.results.length > 100)
    throw new HTTPException(409, { message: "There are too many denial records to manage safely" });
  return { denials: rows.results.map(row => ({
    id: row.id, identityId: row.identity_id, workspaceId: row.workspace_id,
    scopeType: row.scope_type, scopePublicId: row.scope_public_id, reasonCode: row.reason_code,
    status: row.status, validFrom: row.valid_from, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at, identityLabel: row.identity_label,
    identityEmail: row.verified_email, workspaceLabel: row.workspace_label, scopeLabel: row.scope_label,
  })) };
}

export async function createPortalIdentityDenial(env: Env, principal: StaffPrincipal, input: PortalIdentityDenialInput, idempotencyKey: string): Promise<{ denial: PortalIdentityDenialView; replayed: boolean }> {
  await requirePortalDenyAdministrator(env, principal);
  if (!OPAQUE.test(input.identityId) || !IDEMPOTENCY.test(idempotencyKey) || !REASON.test(input.reasonCode))
    throw new HTTPException(400, { message: "Identity denial request is invalid" });
  const expiresAt = expiry(input.expiresAt);
  const normalized = { identityId: input.identityId, workspaceId: input.workspaceId ?? null,
    scopeType: input.scopeType, scopePublicId: input.scopePublicId ?? null,
    reasonCode: input.reasonCode, expiresAt };
  const fingerprint = await sha256(JSON.stringify(normalized));
  const db = database(env);
  const prior = await replay(db, principal.id, idempotencyKey, "denial.create", fingerprint);
  if (prior) return { denial: prior, replayed: true };
  const identity = await db.prepare(`SELECT 1 ok FROM portal_v2_identities
    WHERE id=? AND status='active' AND revoked_at IS NULL`).bind(input.identityId).first("ok");
  if (identity === null) throw new HTTPException(404, { message: "Verified portal identity not found" });
  await validateScope(db, normalized);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lock = await db.prepare(`SELECT version FROM portal_v2_identity_denial_invariant_lock WHERE id=1`)
      .first<{ version: number }>();
    if (!lock || !Number.isSafeInteger(lock.version))
      throw new HTTPException(503, { message: "Portal denial safety state is unavailable" });
    await protectLastEffectiveManager(db, input.identityId, normalized);
    const denialId = crypto.randomUUID();
    try {
      const results = await db.batch([
        db.prepare(`UPDATE portal_v2_identity_denial_invariant_lock
          SET version=version+1,updated_at=datetime('now') WHERE id=1 AND version=?`).bind(lock.version),
        db.prepare(`INSERT INTO portal_v2_identity_denials
          (id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,expires_at,
           created_by_actor_type,created_by_actor_id)
          SELECT ?,?,?,?,?,?,?,'staff',? WHERE changes()=1`).bind(denialId, normalized.identityId,
          normalized.workspaceId, normalized.scopeType, normalized.scopePublicId,
          normalized.reasonCode, normalized.expiresAt, principal.id),
        db.prepare(`INSERT INTO portal_v2_identity_denial_mutations
          (actor_staff_id,idempotency_key,action,request_fingerprint,denial_id,details_json)
          SELECT ?,?,'denial.create',?,?,? WHERE changes()=1`).bind(principal.id, idempotencyKey,
          fingerprint, denialId, JSON.stringify({ reasonCode: normalized.reasonCode,
            expiresAt: normalized.expiresAt })),
      ]);
      if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1)
        return { denial: (await denialView(db, denialId))!, replayed: false };
      const raced = await replay(db, principal.id, idempotencyKey, "denial.create", fingerprint);
      if (raced) return { denial: raced, replayed: true };
    } catch (error) {
      const raced = await replay(db, principal.id, idempotencyKey, "denial.create", fingerprint);
      if (raced) return { denial: raced, replayed: true };
      throw error;
    }
  }
  throw new HTTPException(409, { message: "Portal manager authority changed; refresh and try again" });
}

export async function revokePortalIdentityDenial(env: Env, principal: StaffPrincipal, denialId: string, expectedUpdatedAt: string, reasonCode: string, idempotencyKey: string): Promise<{ denial: PortalIdentityDenialView; replayed: boolean }> {
  await requirePortalDenyAdministrator(env, principal);
  if (!OPAQUE.test(denialId) || !IDEMPOTENCY.test(idempotencyKey) || !REASON.test(reasonCode) || !Number.isFinite(Date.parse(expectedUpdatedAt)))
    throw new HTTPException(400, { message: "Denial revocation request is invalid" });
  const fingerprint = await sha256(JSON.stringify({ denialId, expectedUpdatedAt, reasonCode }));
  const db = database(env);
  const prior = await replay(db, principal.id, idempotencyKey, "denial.revoke", fingerprint);
  if (prior) return { denial: prior, replayed: true };
  const results = await db.batch([
    db.prepare(`UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),
      revoked_by_actor_type='staff',revoked_by_actor_id=?,updated_at=datetime('now')
      WHERE id=? AND status='active' AND revoked_at IS NULL AND updated_at=?`).bind(principal.id, denialId, expectedUpdatedAt),
    db.prepare(`INSERT INTO portal_v2_identity_denial_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,denial_id,details_json)
      SELECT ?,?,'denial.revoke',?,?,? WHERE changes()=1`).bind(principal.id, idempotencyKey, fingerprint, denialId,
      JSON.stringify({ reasonCode })),
  ]);
  // D1's reported update count is not a stable compare-and-swap signal when
  // the immutable audit trigger also writes. The mutation receipt is inserted
  // only when SQLite's statement-local changes() observes the guarded update;
  // read that durable receipt back before deciding the transition lost a race.
  const committed = await replay(db, principal.id, idempotencyKey, "denial.revoke", fingerprint);
  if (!committed || committed.status !== "revoked")
    throw new HTTPException(409, { message: "Denial changed; refresh and try again" });
  return { denial: committed, replayed: false };
}
