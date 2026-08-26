import type { PortalAuthorizationEnv } from './workspace-v2';
import type { VerifiedClientPrincipal } from './types';
import { portalSourceAuthorityGuard, readPortalSourceAuthorityProof, portalSourceAuthoritiesReady } from '../project-alpha-portal-authority';

/** The existing opt-in PA principal policy, without a legacy account bridge.
 * Email selects an explicit signed principal, never a business contact. */
export async function bindNativePortalEligibility(env: PortalAuthorizationEnv, principal: VerifiedClientPrincipal, email: string): Promise<void> {
  if (env.CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED !== 'true'
    || !await portalSourceAuthoritiesReady(env.DELIVERY_DB)) return;
  const db = env.DELIVERY_DB.withSession('first-primary');
  const rows = await db.prepare(`SELECT p.workspace_id,p.public_id,p.source_version,w.project_alpha_source_id,
      checkpoint.active_generation_id,checkpoint.source_sequence
    FROM pa_portal_principals p JOIN portal_v2_workspaces w ON w.id=p.workspace_id
    JOIN pa_portal_workspace_sources mapping ON mapping.workspace_id=w.id AND mapping.projection_source_id=w.project_alpha_source_id
    JOIN pa_portal_source_authorities authority ON authority.source_id=w.project_alpha_source_id AND authority.state='active'
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=w.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=w.id AND generation.status='active' AND generation.complete=1
    WHERE w.status='active' AND w.legacy_account_id IS NULL AND p.status='active' AND lower(p.email_hint)=?
      AND (p.identity_id IS NULL OR p.identity_id=(SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?))
      AND NOT EXISTS(SELECT 1 FROM pa_portal_principals other WHERE other.workspace_id=p.workspace_id
        AND other.status='active' AND lower(other.email_hint)=lower(p.email_hint) AND other.public_id<>p.public_id)
      AND (p.identity_id IS NULL OR NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings e
        JOIN portal_v2_workspace_memberships m ON m.identity_id=e.identity_id AND m.workspace_id=e.workspace_id
        WHERE e.identity_id=p.identity_id AND e.workspace_id=p.workspace_id AND e.principal_public_id=p.public_id
          AND e.principal_source_version=p.source_version AND lower(e.verified_email)=lower(p.email_hint)
          AND m.status='active' AND m.revoked_at IS NULL AND m.source_version=p.source_version
          AND (m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now')))
        OR EXISTS(SELECT 1 FROM pa_portal_entitlement_intents i WHERE i.workspace_id=p.workspace_id
          AND i.principal_public_id=p.public_id AND i.status='active' AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements e
            WHERE e.id='pa-entitlement:'||i.workspace_id||':'||i.public_id AND e.identity_id=p.identity_id
              AND e.source_version=i.source_version AND e.status='active' AND e.revoked_at IS NULL)))
    ORDER BY p.workspace_id,p.public_id LIMIT 33`).bind(email,principal.issuer,principal.subject).all<{
      workspace_id:string;public_id:string;source_version:string;project_alpha_source_id:string;active_generation_id:string;source_sequence:number;
    }>();
  // Do not partially auto-enrol an overflowing/ambiguous candidate set.
  if (rows.results.length > 32) return;
  for (const row of rows.results) {
    const authority = await readPortalSourceAuthorityProof(db,row.project_alpha_source_id);
    if (!authority) continue;
    const guard = portalSourceAuthorityGuard(authority);
    const identitySql = `SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=? AND status='active'
      AND revoked_at IS NULL AND lower(verified_email)=?`;
    const identityArgs = [principal.issuer,principal.subject,email];
    const live = `(${guard.sql}) AND EXISTS(SELECT 1 FROM pa_portal_principals p
      JOIN portal_v2_workspaces w ON w.id=p.workspace_id AND w.status='active' AND w.legacy_account_id IS NULL
      JOIN pa_portal_workspace_sources map ON map.workspace_id=w.id AND map.projection_source_id=w.project_alpha_source_id
      JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=w.id
      JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.workspace_id=w.id AND g.complete=1 AND g.status='active'
      JOIN portal_v2_directory_entities root ON root.workspace_id=w.id AND root.generation_id=g.id AND root.active=1
        AND root.entity_type=w.root_type AND root.public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id)
      WHERE p.workspace_id=? AND p.public_id=? AND p.source_version=? AND p.status='active' AND lower(p.email_hint)=?
        AND w.project_alpha_source_id=? AND cp.active_generation_id=? AND cp.source_sequence=?
        AND (p.identity_id IS NULL OR p.identity_id=(${identitySql}))
        AND NOT EXISTS(SELECT 1 FROM pa_portal_principals other WHERE other.workspace_id=p.workspace_id
          AND other.status='active' AND lower(other.email_hint)=? AND other.public_id<>p.public_id))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks b WHERE b.status='active'
        AND datetime(b.valid_from)<=datetime('now') AND (b.expires_at IS NULL OR datetime(b.expires_at)>datetime('now'))
        AND ((b.match_type='issuer_subject' AND b.issuer=? AND b.subject=?) OR (b.match_type='email' AND b.normalized_email=?)))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identities i WHERE i.issuer=? AND i.subject=?
        AND (i.status<>'active' OR i.revoked_at IS NOT NULL OR lower(i.verified_email)<>?))
      ${env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED==='true'?`AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials d
        JOIN portal_v2_identities i ON i.id=d.identity_id WHERE i.issuer=? AND i.subject=? AND d.status='active' AND d.revoked_at IS NULL
          AND datetime(d.valid_from)<=datetime('now') AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now'))
          AND (d.scope_type='global' OR (d.workspace_id=? AND d.scope_type='workspace' AND d.scope_public_id=?)))`:''}`;
    const args = [...guard.bindings,row.workspace_id,row.public_id,row.source_version,email,row.project_alpha_source_id,
      row.active_generation_id,row.source_sequence,...identityArgs,email,...identityArgs,...identityArgs,
      ...(env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED==='true'?[principal.issuer,principal.subject,row.workspace_id,row.workspace_id]:[])];
    try { await db.batch([
      db.prepare(`INSERT INTO pa_portal_source_write_fences(source_id,write_guard) VALUES(?,CASE WHEN ${live} THEN 1 ELSE 0 END)
        ON CONFLICT(source_id) DO UPDATE SET write_guard=excluded.write_guard`).bind(row.project_alpha_source_id,...args),
      db.prepare(`INSERT OR IGNORE INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')`)
        .bind(crypto.randomUUID(),...identityArgs),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings(identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
        SELECT id,?,?,?,? FROM portal_v2_identities WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?
        ON CONFLICT(identity_id,workspace_id,principal_public_id) DO UPDATE SET principal_source_version=excluded.principal_source_version,
          verified_email=excluded.verified_email`).bind(row.workspace_id,row.public_id,row.source_version,email,...identityArgs),
      db.prepare(`UPDATE pa_portal_principals SET identity_id=(${identitySql}) WHERE workspace_id=? AND public_id=? AND source_version=?`)
        .bind(...identityArgs,row.workspace_id,row.public_id,row.source_version),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
        SELECT 'pa-membership:'||workspace_id||':'||public_id,workspace_id,identity_id,'project_alpha','active',source_version
        FROM pa_portal_principals WHERE workspace_id=? AND public_id=? AND identity_id IS NOT NULL
        ON CONFLICT(workspace_id,identity_id) DO UPDATE SET status='active',source_version=excluded.source_version,revoked_at=NULL,
          updated_at=datetime('now') WHERE portal_v2_workspace_memberships.source_type='project_alpha'`)
        .bind(row.workspace_id,row.public_id),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
          entitlement_version,source_type,source_version,status,valid_from,expires_at)
        SELECT 'pa-entitlement:'||i.workspace_id||':'||i.public_id,i.workspace_id,p.identity_id,i.capability,i.effect,i.scope_type,
          i.scope_public_id,?,'project_alpha',i.source_version,'active',i.valid_from,i.expires_at
        FROM pa_portal_entitlement_intents i JOIN pa_portal_principals p ON p.workspace_id=i.workspace_id AND p.public_id=i.principal_public_id
        JOIN portal_v2_workspace_memberships m ON m.workspace_id=p.workspace_id AND m.identity_id=p.identity_id
          AND m.source_type='project_alpha' AND m.status='active' AND m.revoked_at IS NULL
        WHERE i.workspace_id=? AND i.principal_public_id=? AND i.status='active'
        ON CONFLICT(id) DO UPDATE SET identity_id=excluded.identity_id,capability=excluded.capability,effect=excluded.effect,
          scope_type=excluded.scope_type,scope_public_id=excluded.scope_public_id,entitlement_version=excluded.entitlement_version,
          source_version=excluded.source_version,status='active',valid_from=excluded.valid_from,expires_at=excluded.expires_at,revoked_at=NULL`)
        .bind(row.source_sequence,row.workspace_id,row.public_id),
    ]); } catch(error) {
      // A concurrent change in one source must not prevent discovery of the
      // person's independently authorized other workspaces.
      if(!String(error).includes('pa_portal_source_write_guard'))throw error;
    }
  }
}
