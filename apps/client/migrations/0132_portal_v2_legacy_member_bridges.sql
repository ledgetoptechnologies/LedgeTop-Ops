PRAGMA foreign_keys = ON;

-- Invitation-only portal identities are global and may belong to more than one
-- workspace, while the legacy repository still requires one account-local
-- identity row. This explicit bridge is created only after a token-bound v2
-- invitation is accepted. Synthetic issuer/subject values are internal keys;
-- they are never accepted as an external authentication principal.
CREATE TABLE IF NOT EXISTS portal_v2_legacy_member_bridges (
  workspace_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  legacy_account_id TEXT NOT NULL,
  legacy_identity_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id,identity_id),
  UNIQUE (legacy_identity_id),
  FOREIGN KEY (workspace_id,identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id) ON DELETE CASCADE,
  FOREIGN KEY (legacy_identity_id,legacy_account_id)
    REFERENCES client_identity_links(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY (invitation_id,workspace_id)
    REFERENCES portal_v2_invitations(id,workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_legacy_bridges_account
  ON portal_v2_legacy_member_bridges(legacy_account_id,status,workspace_id);

-- A compatibility bridge is owned only by an accepted client invitation. A
-- Project Alpha-owned membership must never acquire local invitation grants:
-- PA suspension/reprojection owns that membership's lifecycle and could later
-- reactivate otherwise-stale local access.
CREATE TRIGGER IF NOT EXISTS portal_v2_legacy_bridge_invitation_source_insert
BEFORE INSERT ON portal_v2_legacy_member_bridges
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_workspace_memberships membership
  WHERE membership.workspace_id=NEW.workspace_id
    AND membership.identity_id=NEW.identity_id
    AND membership.source_type='client_invitation'
)
BEGIN
  SELECT RAISE(ABORT,'legacy bridge requires client invitation membership');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_legacy_bridge_invitation_source_update
BEFORE UPDATE OF workspace_id,identity_id ON portal_v2_legacy_member_bridges
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_workspace_memberships membership
  WHERE membership.workspace_id=NEW.workspace_id
    AND membership.identity_id=NEW.identity_id
    AND membership.source_type='client_invitation'
)
BEGIN
  SELECT RAISE(ABORT,'legacy bridge requires client invitation membership');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_legacy_bridge_suspend_membership
AFTER UPDATE OF status,revoked_at ON portal_v2_workspace_memberships
WHEN OLD.source_type='client_invitation'
  AND (NEW.status<>'active' OR NEW.revoked_at IS NOT NULL)
BEGIN
  UPDATE portal_v2_legacy_member_bridges
    SET status='revoked',revoked_at=datetime('now'),updated_at=datetime('now')
    WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id
      AND status='active' AND NEW.status='revoked';
  UPDATE portal_v2_legacy_member_bridges
    SET status='suspended',revoked_at=datetime('now'),updated_at=datetime('now')
    WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id
      AND status='active' AND NEW.status<>'revoked';
  UPDATE client_member_project_grants SET revoked_at=datetime('now')
    WHERE identity_id IN (
      SELECT legacy_identity_id FROM portal_v2_legacy_member_bridges
      WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id
    ) AND revoked_at IS NULL;
  UPDATE client_account_members SET revoked_at=datetime('now'),updated_at=datetime('now')
    WHERE identity_id IN (
      SELECT legacy_identity_id FROM portal_v2_legacy_member_bridges
      WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id
    ) AND revoked_at IS NULL;
  UPDATE client_identity_links SET revoked_at=datetime('now')
    WHERE id IN (
      SELECT legacy_identity_id FROM portal_v2_legacy_member_bridges
      WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id
    ) AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_legacy_bridge_reactivate_membership
AFTER UPDATE OF status,revoked_at ON portal_v2_workspace_memberships
WHEN NEW.source_type='client_invitation' AND NEW.status='active' AND NEW.revoked_at IS NULL
BEGIN
  UPDATE portal_v2_legacy_member_bridges
    SET status='active',revoked_at=NULL,updated_at=datetime('now')
    WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id
      AND status='suspended';
  UPDATE client_identity_links SET revoked_at=NULL,last_seen_at=datetime('now')
    WHERE id IN (
      SELECT legacy_identity_id FROM portal_v2_legacy_member_bridges
      WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id AND status='active'
    );
  UPDATE client_account_members SET revoked_at=NULL,updated_at=datetime('now')
    WHERE identity_id IN (
      SELECT legacy_identity_id FROM portal_v2_legacy_member_bridges
      WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id AND status='active'
    );
  UPDATE client_member_project_grants SET revoked_at=NULL
    WHERE identity_id IN (
      SELECT legacy_identity_id FROM portal_v2_legacy_member_bridges
      WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id AND status='active'
    ) AND project_id IN (
      SELECT project_id FROM client_project_grants
      WHERE account_id=(SELECT legacy_account_id FROM portal_v2_legacy_member_bridges
        WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id)
        AND revoked_at IS NULL
    );
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_legacy_bridge_new_project_grant
AFTER INSERT ON client_project_grants
WHEN NEW.revoked_at IS NULL
BEGIN
  INSERT OR IGNORE INTO client_member_project_grants
    (account_id,identity_id,project_id,granted_by_identity_id)
  SELECT bridge.legacy_account_id,bridge.legacy_identity_id,NEW.project_id,
    bridge.legacy_identity_id
  FROM portal_v2_legacy_member_bridges bridge
  WHERE bridge.legacy_account_id=NEW.account_id AND bridge.status='active'
    AND bridge.revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_legacy_bridge_project_grant_lifecycle
AFTER UPDATE OF revoked_at ON client_project_grants
BEGIN
  UPDATE client_member_project_grants
    SET revoked_at=NULL
    WHERE account_id=NEW.account_id AND project_id=NEW.project_id
      AND NEW.revoked_at IS NULL
      AND identity_id IN (
        SELECT legacy_identity_id FROM portal_v2_legacy_member_bridges
        WHERE legacy_account_id=NEW.account_id AND status='active' AND revoked_at IS NULL
      );
  UPDATE client_member_project_grants
    SET revoked_at=datetime('now')
    WHERE account_id=NEW.account_id AND project_id=NEW.project_id
      AND NEW.revoked_at IS NOT NULL
      AND identity_id IN (
        SELECT legacy_identity_id FROM portal_v2_legacy_member_bridges
        WHERE legacy_account_id=NEW.account_id AND status='active' AND revoked_at IS NULL
      );
END;

-- One-shot compatibility backfill for invitations accepted before this
-- migration. Authorization still requires the active v2 membership and live
-- entitlement intersection on every request.
INSERT OR IGNORE INTO client_identity_links
  (id,account_id,issuer,subject,email,last_seen_at)
SELECT
  'portal-v2-bridge:' || invitation.workspace_id || ':' || invitation.accepted_by_identity_id,
  workspace.legacy_account_id,
  'urn:ltds:portal-v2-bridge:' || invitation.workspace_id,
  invitation.accepted_by_identity_id,
  identity.verified_email,
  datetime('now')
FROM portal_v2_invitations invitation
JOIN portal_v2_workspaces workspace
  ON workspace.id=invitation.workspace_id AND workspace.status='active'
  AND workspace.legacy_account_id IS NOT NULL
JOIN portal_v2_identities identity
  ON identity.id=invitation.accepted_by_identity_id AND identity.status='active'
  AND identity.revoked_at IS NULL
JOIN portal_v2_workspace_memberships membership
  ON membership.workspace_id=invitation.workspace_id
  AND membership.identity_id=invitation.accepted_by_identity_id
  AND membership.source_type='client_invitation'
  AND membership.status='active' AND membership.revoked_at IS NULL
WHERE invitation.status='accepted' AND invitation.accepted_by_identity_id IS NOT NULL;

INSERT OR IGNORE INTO client_account_members
  (account_id,identity_id,role,can_view_billing)
SELECT workspace.legacy_account_id,link.id,'member',0
FROM portal_v2_invitations invitation
JOIN portal_v2_workspaces workspace
  ON workspace.id=invitation.workspace_id AND workspace.status='active'
  AND workspace.legacy_account_id IS NOT NULL
JOIN client_identity_links link
  ON link.account_id=workspace.legacy_account_id
  AND link.issuer='urn:ltds:portal-v2-bridge:' || invitation.workspace_id
  AND link.subject=invitation.accepted_by_identity_id
JOIN portal_v2_workspace_memberships membership
  ON membership.workspace_id=invitation.workspace_id
  AND membership.identity_id=invitation.accepted_by_identity_id
  AND membership.source_type='client_invitation'
  AND membership.status='active' AND membership.revoked_at IS NULL
WHERE invitation.status='accepted' AND invitation.accepted_by_identity_id IS NOT NULL;

INSERT OR IGNORE INTO portal_v2_legacy_member_bridges
  (workspace_id,identity_id,legacy_account_id,legacy_identity_id,invitation_id)
SELECT invitation.workspace_id,invitation.accepted_by_identity_id,
  workspace.legacy_account_id,link.id,invitation.id
FROM portal_v2_invitations invitation
JOIN portal_v2_workspaces workspace
  ON workspace.id=invitation.workspace_id AND workspace.status='active'
  AND workspace.legacy_account_id IS NOT NULL
JOIN client_identity_links link
  ON link.account_id=workspace.legacy_account_id
  AND link.issuer='urn:ltds:portal-v2-bridge:' || invitation.workspace_id
  AND link.subject=invitation.accepted_by_identity_id
JOIN portal_v2_workspace_memberships membership
  ON membership.workspace_id=invitation.workspace_id
  AND membership.identity_id=invitation.accepted_by_identity_id
  AND membership.source_type='client_invitation'
  AND membership.status='active' AND membership.revoked_at IS NULL
WHERE invitation.status='accepted' AND invitation.accepted_by_identity_id IS NOT NULL;

-- The legacy grants are only a repository compatibility ceiling. Effective
-- project authorization remains the intersection with the exact live v2
-- entitlement and hierarchy checks performed by the router.
INSERT OR IGNORE INTO client_member_project_grants
  (account_id,identity_id,project_id,granted_by_identity_id)
SELECT bridge.legacy_account_id,bridge.legacy_identity_id,grant_record.project_id,
  bridge.legacy_identity_id
FROM portal_v2_legacy_member_bridges bridge
JOIN client_project_grants grant_record
  ON grant_record.account_id=bridge.legacy_account_id AND grant_record.revoked_at IS NULL
WHERE bridge.status='active';
