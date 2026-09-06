/** Operations-owned root policy. Absence means allowed so the additive
 * migration preserves every existing workspace until an administrator acts. */
export function portalRootAccessAllowedSql(enabled: boolean, workspaceAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(workspaceAlias)) throw new Error("Invalid workspace SQL alias");
  if (!enabled) return "1=1";
  return `NOT EXISTS (SELECT 1 FROM portal_v2_root_access_policies root_policy
    WHERE root_policy.projection_source_id=${workspaceAlias}.project_alpha_source_id
      AND root_policy.root_type=${workspaceAlias}.root_type
      AND root_policy.root_public_id=COALESCE(${workspaceAlias}.pa_organization_public_id,${workspaceAlias}.pa_client_public_id)
      AND root_policy.state='revoked')`;
}
