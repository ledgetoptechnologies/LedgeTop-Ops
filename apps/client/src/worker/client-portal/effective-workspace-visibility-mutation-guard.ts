import { d1TablesPresent } from '../schema-readiness';
import { projectAccessTermsReady, projectAccessTermsSql } from './project-access-terms';
import { projectAccessCapacitySql } from './project-access-capacity';
import { eligiblePortalShellQuery, type EffectivePortalWorkspaceContext, type PortalAuthorizationEnv } from './workspace-v2';

/** Recheck the selected workspace's shell at the notification write boundary. */
export async function readEffectiveWorkspaceVisibilityMutationGuard(
  env: Pick<PortalAuthorizationEnv, 'DELIVERY_DB'>,
  context: EffectivePortalWorkspaceContext,
): Promise<{ sql: string; bindings: string[] }> {
  const termsReady = await projectAccessTermsReady(env.DELIVERY_DB.withSession('first-primary'));
  const shellReady = await d1TablesPresent(env.DELIVERY_DB, [
    'portal_v2_identity_eligibility_bindings', 'portal_v2_identity_eligibility_legacy_bridges',
    'pa_portal_principals',
  ]);
  const shell = shellReady ? `EXISTS(${eligiblePortalShellQuery(true, 'visibility_context.workspace_id', 'visibility_context.identity_id')})` : '0';
  const live = `entitlement.workspace_id=visibility_context.workspace_id
    AND entitlement.identity_id=visibility_context.identity_id AND entitlement.capability='workspace.view'
    AND entitlement.status='active' AND entitlement.revoked_at IS NULL
    AND datetime(entitlement.valid_from)<=datetime('now')
    AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))`;
  const terms = termsReady ? projectAccessTermsSql({
    termsId: 'entitlement.access_terms_id', workspaceId: 'entitlement.workspace_id',
    projectId: '(SELECT project_public_id FROM portal_project_access_terms WHERE id=entitlement.access_terms_id)',
    legacyRetained: '1',
  }) : '1';
  return {
    sql: `EXISTS(WITH visibility_context(workspace_id,identity_id) AS (VALUES (?,?))
      SELECT 1 FROM visibility_context WHERE ${shell} OR (
        (SELECT COUNT(*) FROM portal_v2_entitlements entitlement WHERE ${live}
          AND ${projectAccessCapacitySql('entitlement', termsReady)})<=200
        AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement WHERE ${live}
          AND entitlement.effect='deny' AND entitlement.scope_type='workspace'
          AND entitlement.scope_public_id=visibility_context.workspace_id)
        AND EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement WHERE ${live}
          AND entitlement.effect='allow' AND entitlement.scope_type='workspace'
          AND entitlement.scope_public_id=visibility_context.workspace_id AND ${terms})
      ))`,
    bindings: [context.workspaceId, context.identityId],
  };
}
