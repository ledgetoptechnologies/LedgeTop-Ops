import type { VerifiedClientPrincipal } from './types';
import type { EffectivePortalWorkspaceContext, PortalAuthorizationEnv } from './workspace-v2';
import { localOrPrimaryAlphaReference } from './project-alpha-source';

/** Identity only: callers must also enforce current workspace/resource capability. */
export async function readEffectiveWorkspaceIdentityMutationGuard(
  env: Pick<PortalAuthorizationEnv, 'DELIVERY_DB'>,
  principal: VerifiedClientPrincipal,
  context: EffectivePortalWorkspaceContext,
): Promise<{ sql: string; bindings: string[] }> {
  const tables = await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name IN ('portal_v2_legacy_member_bridges',
      'portal_v2_identity_eligibility_legacy_bridges','portal_v2_identity_eligibility_blocks')`)
    .all<{ name: string }>();
  const present = new Set(tables.results.map(row => row.name));
  const bindings: string[] = [context.identityId, principal.issuer, principal.subject];
  const clauses = [`EXISTS(SELECT 1 FROM portal_v2_identities mutation_identity
    WHERE mutation_identity.id=? AND mutation_identity.issuer=? AND mutation_identity.subject=?
      AND mutation_identity.status='active' AND mutation_identity.revoked_at IS NULL)`];
  if (present.has('portal_v2_identity_eligibility_blocks')) {
    const email = principal.email.trim().toLocaleLowerCase('en-US');
    const canonicalEmail = email.length >= 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
    clauses.push(`NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block
      WHERE block.status='active' AND datetime(block.valid_from)<=datetime('now')
        AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
        AND ((block.match_type='issuer_subject' AND block.issuer=? AND block.subject=?)
          OR (block.match_type='email' AND block.normalized_email=?)))`);
    bindings.push(principal.issuer, principal.subject, canonicalEmail);
  }
  // Match resolveEffectivePortalWorkspaceContext's ordered fallback, rather than
  // accepting any surviving bridge to a different local identity. Both bridge
  // tables have a primary key on (workspace_id, identity_id).
  const candidates: string[] = [];
  for (const table of ['portal_v2_legacy_member_bridges', 'portal_v2_identity_eligibility_legacy_bridges'] as const) {
    if (!present.has(table)) continue;
    candidates.push(`(SELECT link.id FROM ${table} bridge
      JOIN client_accounts account ON account.id=bridge.legacy_account_id AND account.id=?
        AND account.status='active' AND ${localOrPrimaryAlphaReference('account')}
      JOIN client_identity_links link ON link.id=bridge.legacy_identity_id
        AND link.account_id=account.id AND link.revoked_at IS NULL
      JOIN client_account_members member ON member.account_id=account.id
        AND member.identity_id=link.id AND member.revoked_at IS NULL
      WHERE bridge.workspace_id=? AND bridge.identity_id=?
        AND bridge.status='active' AND bridge.revoked_at IS NULL LIMIT 1)`);
    bindings.push(context.legacyAccountId, context.workspaceId, context.identityId);
  }
  candidates.push(`(SELECT link.id FROM client_accounts account
    JOIN client_identity_links link ON link.account_id=account.id AND link.issuer=?
      AND link.subject=? AND link.revoked_at IS NULL
    JOIN client_account_members member ON member.account_id=account.id
      AND member.identity_id=link.id AND member.revoked_at IS NULL
    WHERE account.id=? AND account.status='active' AND ${localOrPrimaryAlphaReference('account')} LIMIT 1)`);
  bindings.push(principal.issuer, principal.subject, context.legacyAccountId);
  clauses.push(`${candidates.length > 1 ? `COALESCE(${candidates.join(',')})` : candidates[0]}=?`);
  bindings.push(context.legacyIdentityId);
  return { sql: clauses.map(clause => `(${clause})`).join(' AND '), bindings };
}
