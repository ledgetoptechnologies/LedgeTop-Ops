PRAGMA foreign_keys = ON;

-- Producer provenance only. Existing Project Alpha scalar references contain a
-- mixture of internal IDs and portal public IDs; preserve their exact bytes.
-- No account, project, grant, history or native workspace is recreated here.
ALTER TABLE client_accounts ADD COLUMN project_alpha_source_id TEXT
  CHECK (project_alpha_source_id IS NULL OR (
    length(project_alpha_source_id) BETWEEN 15 AND 78
    AND instr(project_alpha_source_id,char(0))=0
    AND substr(project_alpha_source_id,1,14)='project-alpha:'
    AND substr(project_alpha_source_id,15,1) GLOB '[a-z0-9]'
    AND substr(project_alpha_source_id,15) NOT GLOB '*[^a-z0-9_-]*'));
ALTER TABLE projects ADD COLUMN project_alpha_source_id TEXT
  CHECK (project_alpha_source_id IS NULL OR (
    length(project_alpha_source_id) BETWEEN 15 AND 78
    AND instr(project_alpha_source_id,char(0))=0
    AND substr(project_alpha_source_id,1,14)='project-alpha:'
    AND substr(project_alpha_source_id,15,1) GLOB '[a-z0-9]'
    AND substr(project_alpha_source_id,15) NOT GLOB '*[^a-z0-9_-]*'));

UPDATE client_accounts SET project_alpha_source_id='project-alpha:primary'
  WHERE project_alpha_client_id IS NOT NULL OR project_alpha_organization_id IS NOT NULL;
UPDATE projects SET project_alpha_source_id='project-alpha:primary'
  WHERE project_alpha_project_id IS NOT NULL;

DROP INDEX idx_client_accounts_pa_client;
DROP INDEX idx_client_accounts_pa_organization;
DROP INDEX idx_projects_pa_project;
CREATE UNIQUE INDEX idx_client_accounts_pa_client
  ON client_accounts(project_alpha_source_id,project_alpha_client_id)
  WHERE project_alpha_client_id IS NOT NULL;
CREATE UNIQUE INDEX idx_client_accounts_pa_organization
  ON client_accounts(project_alpha_source_id,project_alpha_organization_id)
  WHERE project_alpha_organization_id IS NOT NULL;
CREATE UNIQUE INDEX idx_projects_pa_project
  ON projects(project_alpha_source_id,project_alpha_project_id)
  WHERE project_alpha_project_id IS NOT NULL;

-- Support exact-parent first-binding checks without scanning all history.
CREATE INDEX idx_client_feedback_project_owner
  ON client_feedback(project_id,account_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_portal_eligibility_bridge_account_source
  ON portal_v2_identity_eligibility_legacy_bridges(legacy_account_id,revoked_at,workspace_id);

-- NULL remains local provenance, not an inferred producer. Compatibility with
-- existing local/primary relationships is expressed only by the guards below.
-- Existing local parents can be explicitly adopted by primary via UPDATE, but
-- never by a secondary source: that would reinterpret earlier identity/history.
-- INSERT/REPLACE cannot change the source of an existing local ID or steal a
-- source-qualified Alpha reference from a different local ID. Same-ID/source
-- UPSERT remains supported; this is not a general ban on same-source REPLACE.

CREATE TRIGGER client_accounts_source_required_insert
BEFORE INSERT ON client_accounts
WHEN NEW.project_alpha_source_id IS NULL AND (NEW.project_alpha_client_id IS NOT NULL OR NEW.project_alpha_organization_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'linked Alpha references require explicit source');
END;
CREATE TRIGGER client_accounts_source_required_update
BEFORE UPDATE OF project_alpha_source_id,project_alpha_client_id,project_alpha_organization_id ON client_accounts
WHEN NEW.project_alpha_source_id IS NULL AND (NEW.project_alpha_client_id IS NOT NULL OR NEW.project_alpha_organization_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'linked Alpha references require explicit source');
END;
CREATE TRIGGER client_accounts_source_identity_update
BEFORE UPDATE OF id,project_alpha_source_id ON client_accounts
WHEN NEW.id IS NOT OLD.id
  OR (OLD.project_alpha_source_id IS NOT NULL AND NEW.project_alpha_source_id IS NOT OLD.project_alpha_source_id)
  OR (OLD.project_alpha_source_id IS NULL AND NEW.project_alpha_source_id IS NOT NULL
      AND NEW.project_alpha_source_id<>'project-alpha:primary')
BEGIN
  SELECT RAISE(ABORT,'delivery source identity is immutable');
END;
CREATE TRIGGER client_accounts_source_identity_insert
BEFORE INSERT ON client_accounts
WHEN EXISTS (
  SELECT 1 FROM client_accounts existing
  WHERE existing.id=NEW.id AND existing.project_alpha_source_id IS NOT NEW.project_alpha_source_id
) OR EXISTS (
  SELECT 1 FROM client_accounts existing
  WHERE existing.id<>NEW.id AND existing.project_alpha_source_id=NEW.project_alpha_source_id
    AND ((NEW.project_alpha_client_id IS NOT NULL AND existing.project_alpha_client_id=NEW.project_alpha_client_id) OR (NEW.project_alpha_organization_id IS NOT NULL AND existing.project_alpha_organization_id=NEW.project_alpha_organization_id))
)
BEGIN
  SELECT RAISE(ABORT,'delivery source identity is immutable');
END;
CREATE TRIGGER client_accounts_source_reference_update
BEFORE UPDATE OF project_alpha_client_id,project_alpha_organization_id ON client_accounts
WHEN EXISTS (
  SELECT 1 FROM client_accounts existing
  WHERE existing.id<>OLD.id AND existing.project_alpha_source_id=NEW.project_alpha_source_id
    AND ((NEW.project_alpha_client_id IS NOT NULL AND existing.project_alpha_client_id=NEW.project_alpha_client_id)
      OR (NEW.project_alpha_organization_id IS NOT NULL AND existing.project_alpha_organization_id=NEW.project_alpha_organization_id))
)
BEGIN
  SELECT RAISE(ABORT,'delivery source identity is immutable');
END;

CREATE TRIGGER projects_source_required_insert
BEFORE INSERT ON projects
WHEN NEW.project_alpha_source_id IS NULL AND (NEW.project_alpha_project_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'linked Alpha references require explicit source');
END;
CREATE TRIGGER projects_source_required_update
BEFORE UPDATE OF project_alpha_source_id,project_alpha_project_id ON projects
WHEN NEW.project_alpha_source_id IS NULL AND (NEW.project_alpha_project_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'linked Alpha references require explicit source');
END;
CREATE TRIGGER projects_source_identity_update
BEFORE UPDATE OF id,project_alpha_source_id ON projects
WHEN NEW.id IS NOT OLD.id
  OR (OLD.project_alpha_source_id IS NOT NULL AND NEW.project_alpha_source_id IS NOT OLD.project_alpha_source_id)
  OR (OLD.project_alpha_source_id IS NULL AND NEW.project_alpha_source_id IS NOT NULL
      AND NEW.project_alpha_source_id<>'project-alpha:primary')
BEGIN
  SELECT RAISE(ABORT,'delivery source identity is immutable');
END;
CREATE TRIGGER projects_source_identity_insert
BEFORE INSERT ON projects
WHEN EXISTS (
  SELECT 1 FROM projects existing
  WHERE existing.id=NEW.id AND existing.project_alpha_source_id IS NOT NEW.project_alpha_source_id
) OR EXISTS (
  SELECT 1 FROM projects existing
  WHERE existing.id<>NEW.id AND existing.project_alpha_source_id=NEW.project_alpha_source_id
    AND ((NEW.project_alpha_project_id IS NOT NULL AND existing.project_alpha_project_id=NEW.project_alpha_project_id))
 ) OR EXISTS (
  -- external_ref remains the original global integration key. Its UNIQUE
  -- conflict must not let REPLACE delete a different local project's history.
  SELECT 1 FROM projects existing
  WHERE existing.id<>NEW.id AND NEW.external_ref IS NOT NULL AND existing.external_ref=NEW.external_ref
)
BEGIN
  SELECT RAISE(ABORT,'delivery source identity is immutable');
END;
CREATE TRIGGER projects_source_reference_update
BEFORE UPDATE OF project_alpha_project_id,external_ref ON projects
WHEN EXISTS (
  SELECT 1 FROM projects existing
  WHERE existing.id<>OLD.id AND (
    (existing.project_alpha_source_id=NEW.project_alpha_source_id
      AND NEW.project_alpha_project_id IS NOT NULL AND existing.project_alpha_project_id=NEW.project_alpha_project_id)
    OR (NEW.external_ref IS NOT NULL AND existing.external_ref=NEW.external_ref))
)
BEGIN
  SELECT RAISE(ABORT,'delivery source identity is immutable');
END;

-- BEFORE validation runs before 0132's AFTER grant auto-provisioning.
CREATE TRIGGER client_project_grants_source_insert
BEFORE INSERT ON client_project_grants
WHEN EXISTS (
  SELECT 1 FROM client_accounts account JOIN projects project ON project.id=NEW.project_id
  WHERE account.id=NEW.account_id AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')
      <>COALESCE(project.project_alpha_source_id,'project-alpha:primary')
)
BEGIN
  SELECT RAISE(ABORT,'account and project sources must agree');
END;
CREATE TRIGGER client_project_grants_source_update
BEFORE UPDATE OF account_id,project_id,revoked_at ON client_project_grants
WHEN (NEW.revoked_at IS NULL OR NEW.account_id IS NOT OLD.account_id OR NEW.project_id IS NOT OLD.project_id)
AND EXISTS (
  SELECT 1 FROM client_accounts account JOIN projects project ON project.id=NEW.project_id
  WHERE account.id=NEW.account_id AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')
      <>COALESCE(project.project_alpha_source_id,'project-alpha:primary')
)
BEGIN
  SELECT RAISE(ABORT,'account and project sources must agree');
END;

-- BEFORE validation runs before 0132's AFTER grant auto-provisioning.
CREATE TRIGGER client_folder_associations_source_insert
BEFORE INSERT ON client_folder_associations
WHEN EXISTS (
  SELECT 1 FROM client_accounts account JOIN projects project ON project.id=NEW.project_id
  WHERE account.id=NEW.account_id AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')
      <>COALESCE(project.project_alpha_source_id,'project-alpha:primary')
)
BEGIN
  SELECT RAISE(ABORT,'account and project sources must agree');
END;
CREATE TRIGGER client_folder_associations_source_update
BEFORE UPDATE OF account_id,project_id,revoked_at ON client_folder_associations
WHEN (NEW.revoked_at IS NULL OR NEW.account_id IS NOT OLD.account_id OR NEW.project_id IS NOT OLD.project_id)
AND EXISTS (
  SELECT 1 FROM client_accounts account JOIN projects project ON project.id=NEW.project_id
  WHERE account.id=NEW.account_id AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')
      <>COALESCE(project.project_alpha_source_id,'project-alpha:primary')
)
BEGIN
  SELECT RAISE(ABORT,'account and project sources must agree');
END;

CREATE TRIGGER client_feedback_source_insert
BEFORE INSERT ON client_feedback
WHEN EXISTS (
  SELECT 1 FROM client_accounts account JOIN projects project ON project.id=NEW.project_id
  WHERE account.id=NEW.account_id AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')
      <>COALESCE(project.project_alpha_source_id,'project-alpha:primary')
)
BEGIN
  SELECT RAISE(ABORT,'account and project sources must agree');
END;

-- All historical associations matter, including revoked grants and removed
-- folders: adopting a parent must not retarget previously saved requests.
CREATE TRIGGER client_accounts_source_first_binding
BEFORE UPDATE OF project_alpha_source_id ON client_accounts
WHEN OLD.project_alpha_source_id IS NULL AND NEW.project_alpha_source_id IS NOT NULL
AND (
  EXISTS (SELECT 1 FROM client_project_grants edge JOIN projects project ON project.id=edge.project_id
    WHERE edge.account_id=OLD.id AND COALESCE(project.project_alpha_source_id,'project-alpha:primary')<>NEW.project_alpha_source_id)
  OR EXISTS (SELECT 1 FROM client_folder_associations edge JOIN projects project ON project.id=edge.project_id
    WHERE edge.account_id=OLD.id AND COALESCE(project.project_alpha_source_id,'project-alpha:primary')<>NEW.project_alpha_source_id)
  OR EXISTS (SELECT 1 FROM client_feedback edge JOIN projects project ON project.id=edge.project_id
    WHERE edge.account_id=OLD.id AND COALESCE(project.project_alpha_source_id,'project-alpha:primary')<>NEW.project_alpha_source_id)
  OR (NEW.project_alpha_source_id<>'project-alpha:primary' AND (
    EXISTS (SELECT 1 FROM portal_v2_workspaces WHERE legacy_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM portal_v2_legacy_member_bridges WHERE legacy_account_id=OLD.id AND revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM portal_v2_identity_eligibility_legacy_bridges WHERE legacy_account_id=OLD.id AND revoked_at IS NULL)
  ))
)
BEGIN
  SELECT RAISE(ABORT,'existing delivery history has a different source');
END;
CREATE TRIGGER projects_source_first_binding
BEFORE UPDATE OF project_alpha_source_id ON projects
WHEN OLD.project_alpha_source_id IS NULL AND NEW.project_alpha_source_id IS NOT NULL
AND (
  EXISTS (SELECT 1 FROM client_project_grants edge JOIN client_accounts account ON account.id=edge.account_id
    WHERE edge.project_id=OLD.id AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')<>NEW.project_alpha_source_id)
  OR EXISTS (SELECT 1 FROM client_folder_associations edge JOIN client_accounts account ON account.id=edge.account_id
    WHERE edge.project_id=OLD.id AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')<>NEW.project_alpha_source_id)
  OR EXISTS (SELECT 1 FROM client_feedback edge JOIN client_accounts account ON account.id=edge.account_id
    WHERE edge.project_id=OLD.id AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')<>NEW.project_alpha_source_id)
)
BEGIN
  SELECT RAISE(ABORT,'existing delivery history has a different source');
END;

-- Native portal roots and bridges are still single-source. Storing secondary
-- business records does not activate a secondary portal or grant authority.
CREATE TRIGGER portal_v2_workspaces_delivery_source_insert
BEFORE INSERT ON portal_v2_workspaces
WHEN EXISTS (SELECT 1 FROM client_accounts WHERE id=NEW.legacy_account_id
  AND project_alpha_source_id IS NOT NULL AND project_alpha_source_id<>'project-alpha:primary')
BEGIN
  SELECT RAISE(ABORT,'native portal requires primary delivery source');
END;
CREATE TRIGGER portal_v2_workspaces_delivery_source_update
BEFORE UPDATE OF legacy_account_id ON portal_v2_workspaces
WHEN EXISTS (SELECT 1 FROM client_accounts WHERE id=NEW.legacy_account_id
  AND project_alpha_source_id IS NOT NULL AND project_alpha_source_id<>'project-alpha:primary')
BEGIN
  SELECT RAISE(ABORT,'native portal requires primary delivery source');
END;

CREATE TRIGGER portal_v2_legacy_member_bridges_source_insert
BEFORE INSERT ON portal_v2_legacy_member_bridges
WHEN EXISTS (SELECT 1 FROM client_accounts WHERE id=NEW.legacy_account_id
  AND project_alpha_source_id IS NOT NULL AND project_alpha_source_id<>'project-alpha:primary')
BEGIN
  SELECT RAISE(ABORT,'native portal requires primary delivery source');
END;
CREATE TRIGGER portal_v2_legacy_member_bridges_source_update
BEFORE UPDATE OF legacy_account_id,workspace_id,identity_id,status,revoked_at ON portal_v2_legacy_member_bridges
WHEN (NEW.revoked_at IS NULL OR NEW.legacy_account_id IS NOT OLD.legacy_account_id
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.identity_id IS NOT OLD.identity_id)
AND EXISTS (SELECT 1 FROM client_accounts WHERE id=NEW.legacy_account_id
  AND project_alpha_source_id IS NOT NULL AND project_alpha_source_id<>'project-alpha:primary')
BEGIN
  SELECT RAISE(ABORT,'native portal requires primary delivery source');
END;

CREATE TRIGGER portal_v2_identity_eligibility_legacy_bridges_source_insert
BEFORE INSERT ON portal_v2_identity_eligibility_legacy_bridges
WHEN EXISTS (SELECT 1 FROM client_accounts WHERE id=NEW.legacy_account_id
  AND project_alpha_source_id IS NOT NULL AND project_alpha_source_id<>'project-alpha:primary')
BEGIN
  SELECT RAISE(ABORT,'native portal requires primary delivery source');
END;
CREATE TRIGGER portal_v2_identity_eligibility_legacy_bridges_source_update
BEFORE UPDATE OF legacy_account_id,workspace_id,identity_id,status,revoked_at ON portal_v2_identity_eligibility_legacy_bridges
WHEN (NEW.revoked_at IS NULL OR NEW.legacy_account_id IS NOT OLD.legacy_account_id
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.identity_id IS NOT OLD.identity_id)
AND EXISTS (SELECT 1 FROM client_accounts WHERE id=NEW.legacy_account_id
  AND project_alpha_source_id IS NOT NULL AND project_alpha_source_id<>'project-alpha:primary')
BEGIN
  SELECT RAISE(ABORT,'native portal requires primary delivery source');
END;
