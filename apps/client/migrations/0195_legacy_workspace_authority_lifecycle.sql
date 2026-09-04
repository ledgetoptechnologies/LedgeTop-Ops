-- Legacy bootstrap projections are cached authority, not independent grants.
-- Signed successor generations and other sources are deliberately excluded.
CREATE VIEW portal_legacy_bootstrap_workspaces AS
SELECT w.id,w.legacy_account_id FROM portal_v2_workspaces w
JOIN portal_v2_directory_checkpoints c ON c.workspace_id=w.id
JOIN portal_v2_directory_generations g ON g.id=c.active_generation_id AND g.workspace_id=w.id
WHERE w.project_alpha_source_id='project-alpha:primary' AND w.legacy_account_id IS NOT NULL
AND g.id='legacy-generation-' || w.legacy_account_id AND g.source_generation='legacy-backfill'
AND g.source_sequence=0 AND c.source_sequence=0 AND g.status='active' AND g.complete=1;

CREATE TRIGGER portal_legacy_account_authority_invalidate
AFTER UPDATE OF project_alpha_client_id,project_alpha_organization_id,status ON client_accounts
WHEN NEW.project_alpha_client_id IS NOT OLD.project_alpha_client_id
 OR NEW.project_alpha_organization_id IS NOT OLD.project_alpha_organization_id
 OR NEW.status<>'active'
 OR EXISTS(SELECT 1 FROM portal_v2_workspaces w JOIN portal_legacy_bootstrap_workspaces b ON b.id=w.id
 WHERE b.legacy_account_id=NEW.id AND NOT(
 (w.root_type='organization' AND NEW.project_alpha_organization_id IS w.pa_organization_public_id)
 OR (w.root_type='standalone_client' AND NEW.project_alpha_organization_id IS NULL AND NEW.project_alpha_client_id IS w.pa_client_public_id)))
BEGIN
 UPDATE portal_v2_workspaces SET status='suspended',updated_at=datetime('now')
 WHERE id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=NEW.id);
 UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
 WHERE source_type='legacy' AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=NEW.id);
 UPDATE portal_v2_entitlements SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now'))
 WHERE source_type='legacy' AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=NEW.id);
 UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
 WHERE source_type='legacy' AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=NEW.id);
 UPDATE portal_v2_directory_entities SET active=0
 WHERE source_version='legacy-backfill' AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=NEW.id);
END;

CREATE TRIGGER portal_legacy_client_account_members_revoke
AFTER UPDATE OF revoked_at,role ON client_account_members
WHEN NEW.revoked_at IS NOT NULL OR NEW.role IS NOT OLD.role
BEGIN
 UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
 WHERE source_type='legacy' AND identity_id=OLD.identity_id
 AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=OLD.account_id);
 UPDATE portal_v2_entitlements SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now'))
 WHERE source_type='legacy' AND identity_id=OLD.identity_id
 AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=OLD.account_id);
END;

CREATE TRIGGER portal_legacy_client_account_members_delete
AFTER DELETE ON client_account_members

BEGIN
 UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
 WHERE source_type='legacy' AND identity_id=OLD.identity_id
 AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=OLD.account_id);
 UPDATE portal_v2_entitlements SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now'))
 WHERE source_type='legacy' AND identity_id=OLD.identity_id
 AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=OLD.account_id);
END;

CREATE TRIGGER portal_legacy_client_identity_links_revoke
AFTER UPDATE OF revoked_at ON client_identity_links
WHEN NEW.revoked_at IS NOT NULL
BEGIN
 UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
 WHERE source_type='legacy' AND identity_id=OLD.id
 AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=OLD.account_id);
 UPDATE portal_v2_entitlements SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now'))
 WHERE source_type='legacy' AND identity_id=OLD.id
 AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=OLD.account_id);
END;

CREATE TRIGGER portal_legacy_client_identity_links_delete
AFTER DELETE ON client_identity_links

BEGIN
 UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
 WHERE source_type='legacy' AND identity_id=OLD.id
 AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=OLD.account_id);
 UPDATE portal_v2_entitlements SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now'))
 WHERE source_type='legacy' AND identity_id=OLD.id
 AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces WHERE legacy_account_id=OLD.account_id);
END;

-- Reconcile existing stale rows using the same atomic lifecycle rules.
UPDATE client_accounts SET status=status WHERE id IN(SELECT legacy_account_id FROM portal_legacy_bootstrap_workspaces);
UPDATE client_account_members SET revoked_at=revoked_at WHERE revoked_at IS NOT NULL;
UPDATE client_identity_links SET revoked_at=revoked_at WHERE revoked_at IS NOT NULL;
-- Deleted legacy memberships/identities cannot be resurrected by old projections.
UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now'))
WHERE source_type='legacy' AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces)
AND NOT EXISTS(SELECT 1 FROM portal_legacy_bootstrap_workspaces b
 JOIN client_account_members m ON m.account_id=b.legacy_account_id AND m.identity_id=portal_v2_workspace_memberships.identity_id AND m.revoked_at IS NULL
 JOIN client_identity_links i ON i.account_id=m.account_id AND i.id=m.identity_id AND i.revoked_at IS NULL
 WHERE b.id=portal_v2_workspace_memberships.workspace_id);
UPDATE portal_v2_entitlements SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now'))
WHERE source_type='legacy' AND workspace_id IN(SELECT id FROM portal_legacy_bootstrap_workspaces)
AND EXISTS(SELECT 1 FROM portal_v2_workspace_memberships m WHERE m.workspace_id=portal_v2_entitlements.workspace_id
 AND m.identity_id=portal_v2_entitlements.identity_id AND m.source_type='legacy' AND m.status='revoked');
