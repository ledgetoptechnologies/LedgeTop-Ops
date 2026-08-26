import type { Env as ClientEnv } from "../types";
import { projectAccessTermsReady, projectAccessTermsSql } from './project-access-terms';
import { projectAccessCapacitySql } from './project-access-capacity';
type Env = Pick<ClientEnv, "DELIVERY_DB" | "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED">;

export const PORTAL_HIERARCHY_RELATIONS_FLAG = "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED";

export type RelationScopeType = "workspace" | "organization" | "standalone_client" | "department" | "client" | "project" | "folder" | "contact";
export interface RelationTarget { scopeType: RelationScopeType; publicId: string }
export interface RelationWorkspace { id: string; rootType: "organization" | "standalone_client"; rootPublicId: string }

const MAX_SCOPES = 64;
const MAX_AUTHORIZATION_TARGETS = 200;

export function portalHierarchyRelationsEnabled(env: Env): boolean {
  return env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true";
}

/**
 * Returns every exact scope that may govern a target in the active PA
 * generation. Unlike parent_public_id, relation edges preserve projects linked
 * to an organization, department, and client simultaneously. A missing root,
 * incomplete project lifecycle, expired completed project, cycle/overflow, or
 * inactive endpoint fails closed.
 */
export async function resolvePortalRelationTargetScopes(
  env: { DELIVERY_DB: Pick<D1Database, "prepare"> },
  workspace: RelationWorkspace,
  target: RelationTarget,
  options?: {retention:'structural'},
): Promise<Set<string> | null> {
  const scopes = new Set<string>([`workspace:${workspace.id}`]);
  if (target.scopeType === "workspace") return target.publicId === workspace.id ? scopes : null;

  let targetType: Exclude<RelationScopeType, "workspace" | "folder"> = target.scopeType as Exclude<RelationScopeType, "workspace" | "folder">;
  let targetPublicId = target.publicId;
  if (target.scopeType === "folder") {
    const binding = await env.DELIVERY_DB.prepare(`SELECT owner_scope_type,owner_public_id
      FROM portal_v2_folder_bindings WHERE workspace_id=? AND id=?
        AND status='active' AND revoked_at IS NULL`)
      .bind(workspace.id, target.publicId)
      .first<{ owner_scope_type: "organization" | "department" | "client" | "project"; owner_public_id: string }>();
    if (!binding) return null;
    scopes.add(`folder:${target.publicId}`);
    targetType = binding.owner_scope_type;
    targetPublicId = binding.owner_public_id;
  }

  const result = await env.DELIVERY_DB.prepare(`WITH RECURSIVE lineage(entity_type,public_id,depth) AS (
      SELECT entity.entity_type,entity.public_id,0
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities entity ON entity.workspace_id=checkpoint.workspace_id
        AND entity.generation_id=checkpoint.active_generation_id AND entity.active=1
      WHERE checkpoint.workspace_id=? AND entity.entity_type=? AND entity.public_id=?
      UNION
      SELECT relation.from_type,relation.from_public_id,lineage.depth+1
      FROM lineage
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_relations relation ON relation.workspace_id=checkpoint.workspace_id
        AND relation.generation_id=checkpoint.active_generation_id AND relation.active=1
        AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=relation.workspace_id
        AND parent.generation_id=relation.generation_id AND parent.entity_type=relation.from_type
        AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE lineage.depth<12
    ) SELECT entity_type,public_id,depth FROM lineage LIMIT ?`)
    .bind(workspace.id, targetType, targetPublicId, workspace.id, MAX_SCOPES + 1)
    .all<{ entity_type: string; public_id: string; depth: number }>();
  if (result.results.length === 0 || result.results.length > MAX_SCOPES || result.results.some(row => row.depth >= 12)) return null;
  const projectIds = [...new Set(result.results
    .filter(row => row.entity_type === "project")
    .map(row => row.public_id))];
  if (projectIds.length > 0) {
    const retained = await env.DELIVERY_DB.prepare(`SELECT COUNT(DISTINCT lifecycle.project_public_id) retained
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_project_lifecycle lifecycle ON lifecycle.workspace_id=checkpoint.workspace_id
        AND lifecycle.generation_id=checkpoint.active_generation_id
      JOIN json_each(?) requested ON requested.value=lifecycle.project_public_id
      WHERE checkpoint.workspace_id=?
        AND (lifecycle.lifecycle_status='active' OR (lifecycle.lifecycle_status='completed'
          AND ${options?.retention==='structural'?"datetime(lifecycle.completed_at) IS NOT NULL":"datetime(lifecycle.completed_at,'+30 days')>datetime('now')"}))`)
      .bind(JSON.stringify(projectIds), workspace.id)
      .first<number>("retained");
    if (retained !== projectIds.length) return null;
  }
  for (const row of result.results) scopes.add(`${row.entity_type}:${row.public_id}`);
  return scopes.has(`${workspace.rootType}:${workspace.rootPublicId}`) ? scopes : null;
}

/**
 * Resolves directory visibility for a bounded target set in one authorization
 * evaluation. The SQL retains the exact scope semantics above: workspace and
 * every active relation ancestor may govern a target, any matching deny wins,
 * and every project in the lineage must remain inside its retention window.
 */
export async function resolvePortalRelationAuthorizedTargets(
  env: Env,
  workspace: RelationWorkspace,
  identityId: string,
  capability: string,
  targets: RelationTarget[],
  retainedTermProjects:ReadonlySet<string>=new Set(),
): Promise<Set<string> | null> {
  if (targets.length > MAX_AUTHORIZATION_TARGETS) return null;
  if (targets.length === 0) return new Set();
  const termsReady=await projectAccessTermsReady(env.DELIVERY_DB);
  const requested = JSON.stringify(targets.map(target => ({
    scopeType: target.scopeType,
    publicId: target.publicId,
  })));
  const result = await env.DELIVERY_DB.prepare(`WITH RECURSIVE
    requested(target_type,target_public_id) AS (
      SELECT DISTINCT json_extract(value,'$.scopeType'),json_extract(value,'$.publicId') FROM json_each(?)
    ),
    active_generation(workspace_id,generation_id) AS (
      SELECT checkpoint.workspace_id,checkpoint.active_generation_id
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
      WHERE checkpoint.workspace_id=?
    ),
    lineage(target_type,target_public_id,entity_type,public_id,depth) AS (
      SELECT requested.target_type,requested.target_public_id,entity.entity_type,entity.public_id,0
      FROM requested
      JOIN active_generation
      JOIN portal_v2_directory_entities entity ON entity.workspace_id=active_generation.workspace_id
        AND entity.generation_id=active_generation.generation_id AND entity.active=1
        AND entity.entity_type=requested.target_type AND entity.public_id=requested.target_public_id
      UNION
      SELECT lineage.target_type,lineage.target_public_id,relation.from_type,relation.from_public_id,lineage.depth+1
      FROM lineage
      JOIN active_generation
      JOIN portal_v2_directory_relations relation ON relation.workspace_id=active_generation.workspace_id
        AND relation.generation_id=active_generation.generation_id AND relation.active=1
        AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=relation.workspace_id
        AND parent.generation_id=relation.generation_id AND parent.entity_type=relation.from_type
        AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE lineage.depth<12
    ),
    target_stats(target_type,target_public_id,scope_count,max_depth,reaches_root) AS (
      SELECT target_type,target_public_id,COUNT(*),MAX(depth),
        MAX(CASE WHEN entity_type=? AND public_id=? THEN 1 ELSE 0 END)
      FROM lineage GROUP BY target_type,target_public_id
    ),
    valid_targets(target_type,target_public_id) AS (
      SELECT stats.target_type,stats.target_public_id FROM target_stats stats
      WHERE stats.scope_count<=? AND stats.max_depth<12 AND stats.reaches_root=1
        AND NOT EXISTS (
          SELECT 1 FROM lineage project_lineage
          JOIN active_generation
          LEFT JOIN portal_v2_project_lifecycle lifecycle ON lifecycle.workspace_id=active_generation.workspace_id
            AND lifecycle.generation_id=active_generation.generation_id
            AND lifecycle.project_public_id=project_lineage.public_id
            AND (lifecycle.lifecycle_status='active' OR (lifecycle.lifecycle_status='completed'
              AND ${termsReady?"datetime(lifecycle.completed_at) IS NOT NULL":"datetime(lifecycle.completed_at,'+30 days')>datetime('now')"}))
          WHERE project_lineage.target_type=stats.target_type
            AND project_lineage.target_public_id=stats.target_public_id
            AND project_lineage.entity_type='project' AND lifecycle.project_public_id IS NULL
        )
    ),
    entitlement_count(row_count) AS (
      SELECT COUNT(*) FROM portal_v2_entitlements counted_entitlement
      WHERE workspace_id=? AND identity_id=? AND capability=?
        AND status='active' AND revoked_at IS NULL
        AND datetime(valid_from)<=datetime('now')
        AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
        AND ${projectAccessCapacitySql('counted_entitlement',termsReady)}
    ),
    matching(target_type,target_public_id,effect) AS (
      SELECT target.target_type,target.target_public_id,entitlement.effect
      FROM valid_targets target
      CROSS JOIN entitlement_count
      JOIN portal_v2_entitlements entitlement ON entitlement.workspace_id=?
        AND entitlement.identity_id=? AND entitlement.capability=?
        AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now')
        AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
        AND ${projectAccessCapacitySql('entitlement',termsReady)}
      WHERE entitlement_count.row_count<=200 AND (
        (entitlement.scope_type='workspace' AND entitlement.scope_public_id=?) OR EXISTS (
          SELECT 1 FROM lineage scope WHERE scope.target_type=target.target_type
            AND scope.target_public_id=target.target_public_id
            AND scope.entity_type=entitlement.scope_type AND scope.public_id=entitlement.scope_public_id
        )
      ) ${termsReady?`AND (entitlement.effect='deny' OR (
        (entitlement.access_terms_id IS NULL OR EXISTS(SELECT 1 FROM lineage term_target
          JOIN portal_project_access_terms term ON term.id=entitlement.access_terms_id
          WHERE term_target.target_type=target.target_type AND term_target.target_public_id=target.target_public_id
            AND term_target.entity_type='project' AND term_target.public_id=term.project_public_id
            AND ${projectAccessTermsSql({termsId:'entitlement.access_terms_id',workspaceId:'entitlement.workspace_id',projectId:'term_target.public_id',legacyRetained:'1'})}))
        AND NOT EXISTS(SELECT 1 FROM lineage project_scope JOIN active_generation
          LEFT JOIN portal_v2_project_lifecycle current_lifecycle ON current_lifecycle.workspace_id=active_generation.workspace_id
            AND current_lifecycle.generation_id=active_generation.generation_id AND current_lifecycle.project_public_id=project_scope.public_id
          WHERE project_scope.target_type=target.target_type AND project_scope.target_public_id=target.target_public_id
            AND project_scope.entity_type='project' AND NOT ${projectAccessTermsSql({termsId:'entitlement.access_terms_id',workspaceId:'entitlement.workspace_id',projectId:'project_scope.public_id',legacyRetained:`(current_lifecycle.lifecycle_status='active' OR datetime(current_lifecycle.completed_at,'+30 days')>datetime('now')
              OR (${capability==='directory.read'?"target.target_type='project' AND (entitlement.source_type='project_alpha' OR (entitlement.source_type='legacy' AND entitlement.scope_type='project'))":"0"})
              OR (target.target_type='project' AND target.target_public_id=project_scope.public_id AND project_scope.public_id IN(SELECT value FROM json_each(?))))`})})
      ))`:''}
    )
    SELECT target_type,target_public_id FROM matching
    GROUP BY target_type,target_public_id
    HAVING SUM(CASE WHEN effect='deny' THEN 1 ELSE 0 END)=0
      AND SUM(CASE WHEN effect='allow' THEN 1 ELSE 0 END)>0`)
    .bind(
      requested, workspace.id, workspace.rootType, workspace.rootPublicId, MAX_SCOPES,
      workspace.id, identityId, capability,
      workspace.id, identityId, capability, workspace.id,
      ...(termsReady?[JSON.stringify([...retainedTermProjects])]:[]),
    )
    .all<{ target_type: string; target_public_id: string }>();
  return new Set(result.results.map(row => `${row.target_type}:${row.target_public_id}`));
}
