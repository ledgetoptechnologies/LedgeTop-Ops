PRAGMA foreign_keys = ON;

-- Do not strand a previously prepared acquisition or an unfinished
-- reconciliation action with a NULL preserved external identity. The release
-- preflight also checks this state, but the migration must enforce the same
-- stop condition at the D1 write boundary.
CREATE TABLE _project_alpha_directory_preserved_identity_migration_assertion (
  valid INTEGER NOT NULL CHECK(valid = 1)
);
INSERT INTO _project_alpha_directory_preserved_identity_migration_assertion(valid)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM project_alpha_directory_read_adoption_finalizations
)
OR EXISTS (
  SELECT 1 FROM project_alpha_directory_reconciliation_actions action
  LEFT JOIN project_alpha_directory_reconciliation_action_outcomes outcome
    ON outcome.action_id=action.action_id
  WHERE outcome.action_id IS NULL
);
DROP TABLE _project_alpha_directory_preserved_identity_migration_assertion;

-- Version the acquisition identity separately from the immutable 0167 rebind
-- intent. Newly reviewed work must explicitly preserve the sealed PA external
-- ID; legacy prepared rows are rejected by the preflight above.
ALTER TABLE project_alpha_directory_read_adoption_finalizations
  ADD COLUMN acquisition_external_id TEXT;
ALTER TABLE project_alpha_directory_read_adoption_finalizations
  ADD COLUMN acquisition_identity_mode TEXT
    CHECK(acquisition_identity_mode IS NULL OR acquisition_identity_mode='preserve_reviewed');

CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_preserved_external_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_finalizations
WHEN NEW.acquisition_identity_mode IS NOT 'preserve_reviewed'
  OR NEW.acquisition_external_id IS NOT NEW.reviewed_external_id
BEGIN SELECT RAISE(ABORT,'directory adoption acquisition requires preserved reviewed external identity'); END;

ALTER TABLE project_alpha_directory_reconciliation_actions
  ADD COLUMN external_id TEXT;

CREATE TRIGGER project_alpha_directory_reconciliation_actions_preserved_external_exact
BEFORE INSERT ON project_alpha_directory_reconciliation_actions
WHEN NEW.external_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM project_alpha_directory_reconciliation_findings finding
  JOIN project_alpha_directory_reconciliation_observations observation
    ON observation.run_id=finding.run_id AND observation.resource_type=finding.resource_type
      AND observation.public_id=finding.remote_public_id
  WHERE finding.finding_id=NEW.finding_id AND observation.binding_external_id=NEW.external_id
    AND observation.binding_status='active' AND observation.present=1
    AND observation.binding_resource_revision=NEW.remote_revision)
BEGIN SELECT RAISE(ABORT,'reconciliation acquisition requires current observed external identity'); END;
