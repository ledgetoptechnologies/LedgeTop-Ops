import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";
import { authorizePortalWorkspaceCapability, portalHierarchyV2Enabled } from "./workspace-v2";

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AUTHORIZED_BINDING_LIMIT = 100;

interface GrantCandidate {
  folder_binding_id: string;
  r2_prefix: string;
  owner_scope_type: "organization" | "department" | "client" | "project";
  owner_public_id: string;
  audience_type: "organization" | "department" | "client" | "project" | "principal";
  audience_public_id: string;
  audience_source_version: string;
}

function portalDb(env: Env): D1Database {
  const db = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return db.withSession?.("first-primary") ?? db;
}

export function authenticatedDeliveryGrantsEnabled(env: Env): boolean {
  return portalHierarchyV2Enabled(env) && env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED === "true";
}

async function candidates(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  folderBindingId?: string,
): Promise<GrantCandidate[] | null> {
  const rows = await portalDb(env).prepare(`SELECT DISTINCT binding.id folder_binding_id,binding.r2_prefix,
      binding.owner_scope_type,binding.owner_public_id,grant_record.audience_type,
      grant_record.audience_public_id,grant_record.audience_source_version
    FROM portal_v2_identities identity
    JOIN portal_v2_workspace_memberships membership
      ON membership.identity_id=identity.id AND membership.workspace_id=?
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    LEFT JOIN portal_v2_authenticated_delivery_grant_recipients recipient
      ON recipient.workspace_id=membership.workspace_id AND recipient.identity_id=identity.id
    JOIN portal_v2_authenticated_delivery_grants grant_record
      ON grant_record.workspace_id=membership.workspace_id
      AND (grant_record.audience_type<>'principal' OR grant_record.id=recipient.grant_id)
      AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    JOIN portal_v2_folder_bindings binding
      ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=grant_record.workspace_id
      AND binding.status='active' AND binding.revoked_at IS NULL
      AND binding.source_version=grant_record.binding_source_version
    LEFT JOIN pa_portal_principals principal_record
      ON principal_record.workspace_id=recipient.workspace_id
      AND principal_record.public_id=recipient.principal_public_id
      AND principal_record.identity_id=recipient.identity_id AND principal_record.status='active'
      AND principal_record.source_version=recipient.principal_source_version
    WHERE identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
      AND (grant_record.audience_type<>'principal' OR principal_record.public_id IS NOT NULL)
      AND (? IS NULL OR binding.id=?)
    ORDER BY binding.id LIMIT ?`)
    .bind(workspaceId, principal.issuer, principal.subject,
      folderBindingId ?? null, folderBindingId ?? null, AUTHORIZED_BINDING_LIMIT + 1)
    .all<GrantCandidate>();
  return rows.results.length > AUTHORIZED_BINDING_LIMIT ? null : rows.results;
}

async function audienceLiveAndContained(env: Env, workspaceId: string, row: GrantCandidate): Promise<boolean> {
  if (row.audience_type === "principal") {
    const active = await portalDb(env).prepare(`SELECT 1 ok FROM pa_portal_principals
      WHERE workspace_id=? AND public_id=? AND source_version=? AND status='active'`)
      .bind(workspaceId, row.audience_public_id, row.audience_source_version).first("ok");
    return active !== null;
  }
  const active = await portalDb(env).prepare(`WITH RECURSIVE ancestry(entity_type,public_id,parent_public_id,source_version,depth) AS (
      SELECT owner.entity_type,owner.public_id,owner.parent_public_id,owner.source_version,0
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generations generation
        ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
        AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities owner
        ON owner.workspace_id=checkpoint.workspace_id AND owner.generation_id=checkpoint.active_generation_id
        AND owner.entity_type=? AND owner.public_id=? AND owner.active=1
      WHERE checkpoint.workspace_id=?
      UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,parent.source_version,ancestry.depth+1
      FROM ancestry
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=checkpoint.workspace_id AND parent.generation_id=checkpoint.active_generation_id
        AND parent.public_id=ancestry.parent_public_id AND parent.active=1
      WHERE ancestry.parent_public_id IS NOT NULL AND ancestry.depth<12
      UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,parent.source_version,ancestry.depth+1
      FROM ancestry
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_relations relation
        ON relation.workspace_id=checkpoint.workspace_id AND relation.generation_id=checkpoint.active_generation_id
        AND relation.to_type=ancestry.entity_type AND relation.to_public_id=ancestry.public_id
        AND relation.relation_type='contains' AND relation.active=1
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=relation.workspace_id AND parent.generation_id=relation.generation_id
        AND parent.entity_type=relation.from_type AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE ancestry.depth<12
    ) SELECT 1 ok FROM ancestry WHERE entity_type=? AND public_id=? AND source_version=? LIMIT 1`)
    .bind(row.owner_scope_type, row.owner_public_id, workspaceId, workspaceId, workspaceId,
      row.audience_type, row.audience_public_id, row.audience_source_version).first("ok");
  return active !== null;
}

/**
 * Intersects an exact verified portal identity and its live portal-v2
 * entitlement with one versioned staff-approved folder grant. The grant never
 * replaces PA identity/membership authority; both sides must still be live.
 */
export async function authorizeAuthenticatedDeliveryGrant(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  folderBindingId: string,
): Promise<boolean> {
  if (!authenticatedDeliveryGrantsEnabled(env) || !OPAQUE.test(workspaceId) || !OPAQUE.test(folderBindingId)) return false;
  const authorizedByHierarchy = await authorizePortalWorkspaceCapability(
    env, principal, workspaceId, "delivery.view", { scopeType: "folder", publicId: folderBindingId },
  );
  if (!authorizedByHierarchy) return false;
  const rows = await candidates(env, principal, workspaceId, folderBindingId);
  if (!rows) return false;
  for (const row of rows) {
    if (await audienceLiveAndContained(env, workspaceId, row)) return true;
  }
  return false;
}

/** Server-only prefix set for repository SQL filtering. Raw prefixes must never
 * be serialized in browser responses. */
export async function listAuthorizedAuthenticatedDeliveryPrefixes(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
): Promise<Set<string>> {
  if (!authenticatedDeliveryGrantsEnabled(env) || !OPAQUE.test(workspaceId)) return new Set();
  // Resolve every folder binding in one bounded authorization query. Calling
  // the single-binding resolver in a loop repeated identity, membership,
  // hierarchy, entitlement and denial reads up to 100 times on each listing.
  const rows = await portalDb(env).prepare(`WITH RECURSIVE base AS (
      SELECT DISTINCT identity.id identity_id,workspace.id workspace_id,workspace.root_type,
        COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,
        grant_record.id grant_id,grant_record.audience_type,grant_record.audience_public_id,
        grant_record.audience_source_version,binding.id folder_binding_id,binding.r2_prefix,
        owner.entity_type,owner.public_id,owner.parent_public_id,owner.source_version
      FROM portal_v2_identities identity
      JOIN portal_v2_workspace_memberships membership
        ON membership.identity_id=identity.id AND membership.workspace_id=?
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      JOIN portal_v2_workspaces workspace
        ON workspace.id=membership.workspace_id AND workspace.status='active'
      JOIN portal_v2_authenticated_delivery_grants grant_record
        ON grant_record.workspace_id=workspace.id AND grant_record.status='active'
        AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
      JOIN portal_v2_folder_bindings binding
        ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=grant_record.workspace_id
        AND binding.status='active' AND binding.revoked_at IS NULL
        AND binding.source_version=grant_record.binding_source_version
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
      JOIN portal_v2_directory_generations generation
        ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
        AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities owner
        ON owner.workspace_id=workspace.id AND owner.generation_id=checkpoint.active_generation_id
        AND owner.entity_type=binding.owner_scope_type AND owner.public_id=binding.owner_public_id
        AND owner.active=1
      LEFT JOIN portal_v2_authenticated_delivery_grant_recipients recipient
        ON grant_record.audience_type='principal' AND recipient.grant_id=grant_record.id
        AND recipient.workspace_id=workspace.id AND recipient.identity_id=identity.id
        AND recipient.principal_public_id=grant_record.audience_public_id
      LEFT JOIN pa_portal_principals principal_record
        ON principal_record.workspace_id=recipient.workspace_id
        AND principal_record.public_id=recipient.principal_public_id
        AND principal_record.identity_id=recipient.identity_id AND principal_record.status='active'
        AND principal_record.source_version=recipient.principal_source_version
      WHERE identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
        AND (grant_record.audience_type<>'principal' OR principal_record.public_id IS NOT NULL)
    ), lineage(grant_id,entity_type,public_id,parent_public_id,source_version,depth) AS (
      SELECT grant_id,entity_type,public_id,parent_public_id,source_version,0 FROM base
      UNION
      SELECT lineage.grant_id,parent.entity_type,parent.public_id,parent.parent_public_id,parent.source_version,lineage.depth+1
      FROM lineage
      JOIN base ON base.grant_id=lineage.grant_id
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=base.workspace_id
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=base.workspace_id AND parent.generation_id=checkpoint.active_generation_id
        AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<12
      UNION
      SELECT lineage.grant_id,parent.entity_type,parent.public_id,parent.parent_public_id,parent.source_version,lineage.depth+1
      FROM lineage
      JOIN base ON base.grant_id=lineage.grant_id
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=base.workspace_id
      JOIN portal_v2_directory_relations relation
        ON relation.workspace_id=base.workspace_id AND relation.generation_id=checkpoint.active_generation_id
        AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
        AND relation.relation_type='contains' AND relation.active=1
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=relation.workspace_id AND parent.generation_id=relation.generation_id
        AND parent.entity_type=relation.from_type AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE ?='true' AND lineage.depth<12
    )
    SELECT DISTINCT base.r2_prefix
    FROM base
    WHERE EXISTS (SELECT 1 FROM lineage root
        WHERE root.grant_id=base.grant_id AND root.entity_type=base.root_type
          AND root.public_id=base.root_public_id)
      AND (base.audience_type='principal' OR EXISTS (SELECT 1 FROM lineage audience
        WHERE audience.grant_id=base.grant_id AND audience.entity_type=base.audience_type
          AND audience.public_id=base.audience_public_id
          AND audience.source_version=base.audience_source_version))
      AND EXISTS (SELECT 1 FROM portal_v2_entitlements allow_record
        WHERE allow_record.workspace_id=base.workspace_id AND allow_record.identity_id=base.identity_id
          AND allow_record.capability='delivery.view' AND allow_record.effect='allow'
          AND allow_record.status='active' AND allow_record.revoked_at IS NULL
          AND datetime(allow_record.valid_from)<=datetime('now')
          AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
          AND ((allow_record.scope_type='workspace' AND allow_record.scope_public_id=?)
            OR (allow_record.scope_type='folder' AND allow_record.scope_public_id=base.folder_binding_id)
            OR EXISTS (SELECT 1 FROM lineage allowed_scope WHERE allowed_scope.grant_id=base.grant_id
              AND allowed_scope.entity_type=allow_record.scope_type
              AND allowed_scope.public_id=allow_record.scope_public_id)))
      AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements deny_record
        WHERE deny_record.workspace_id=base.workspace_id AND deny_record.identity_id=base.identity_id
          AND deny_record.capability='delivery.view' AND deny_record.effect='deny'
          AND deny_record.status='active' AND deny_record.revoked_at IS NULL
          AND datetime(deny_record.valid_from)<=datetime('now')
          AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
          AND ((deny_record.scope_type='workspace' AND deny_record.scope_public_id=?)
            OR (deny_record.scope_type='folder' AND deny_record.scope_public_id=base.folder_binding_id)
            OR EXISTS (SELECT 1 FROM lineage denied_scope WHERE denied_scope.grant_id=base.grant_id
              AND denied_scope.entity_type=deny_record.scope_type
              AND denied_scope.public_id=deny_record.scope_public_id)))
      AND (?<>'true' OR NOT EXISTS (SELECT 1 FROM portal_v2_identity_denials active_denial
        WHERE active_denial.identity_id=base.identity_id AND active_denial.status='active'
          AND active_denial.revoked_at IS NULL AND datetime(active_denial.valid_from)<=datetime('now')
          AND (active_denial.expires_at IS NULL OR datetime(active_denial.expires_at)>datetime('now'))
          AND (active_denial.scope_type='global' OR (active_denial.workspace_id=base.workspace_id AND
            ((active_denial.scope_type='workspace' AND active_denial.scope_public_id=?)
              OR (active_denial.scope_type='folder' AND active_denial.scope_public_id=base.folder_binding_id)
              OR EXISTS (SELECT 1 FROM lineage denied_identity_scope
                WHERE denied_identity_scope.grant_id=base.grant_id
                  AND denied_identity_scope.entity_type=active_denial.scope_type
                  AND denied_identity_scope.public_id=active_denial.scope_public_id))))))
    ORDER BY base.r2_prefix LIMIT ?`)
    .bind(workspaceId, principal.issuer, principal.subject,
      env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED ?? "false",
      workspaceId, workspaceId, env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED ?? "false", workspaceId,
      AUTHORIZED_BINDING_LIMIT + 1)
    .all<{ r2_prefix: string }>();
  if (rows.results.length > AUTHORIZED_BINDING_LIMIT) return new Set();
  return new Set(rows.results.map(row => row.r2_prefix));
}
