PRAGMA foreign_keys = ON;

-- Read-only reconciliation ledger. These tables may record observations and
-- review workflow only; they have no trigger, foreign key, or view that can
-- mutate canonical Directory, mapping, Delivery, public-link, or PA state.
CREATE TABLE project_alpha_directory_reconciliation_runs (
  run_id TEXT NOT NULL PRIMARY KEY,
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:'),
  status TEXT NOT NULL CHECK(status IN ('running','complete','uncertain')),
  source_instance_id TEXT,
  application_id TEXT,
  history_epoch_id TEXT,
  authorization_generation TEXT,
  previous_complete_run_id TEXT REFERENCES project_alpha_directory_reconciliation_runs(run_id) ON DELETE RESTRICT,
  cursor TEXT,
  pages_observed INTEGER NOT NULL DEFAULT 0 CHECK(pages_observed>=0),
  items_observed INTEGER NOT NULL DEFAULT 0 CHECK(items_observed>=0),
  local_items_observed INTEGER NOT NULL DEFAULT 0 CHECK(local_items_observed>=0),
  failure_reason TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((status='running')=(completed_at IS NULL)),
  CHECK(status<>'complete' OR (source_instance_id IS NOT NULL AND application_id IS NOT NULL
    AND history_epoch_id IS NOT NULL AND authorization_generation IS NOT NULL AND cursor IS NULL
    AND failure_reason IS NULL))
);
CREATE INDEX project_alpha_directory_reconciliation_runs_source
  ON project_alpha_directory_reconciliation_runs(source_id,started_at DESC,run_id DESC);

-- Exactly one durable progress record per source. complete_run_id is the sole
-- stable-snapshot pointer and is deliberately retained when a later run is
-- uncertain or interrupted.
CREATE TABLE project_alpha_directory_reconciliation_checkpoints (
  source_id TEXT NOT NULL PRIMARY KEY CHECK(substr(source_id,1,14)='project-alpha:'),
  active_run_id TEXT REFERENCES project_alpha_directory_reconciliation_runs(run_id) ON DELETE RESTRICT,
  complete_run_id TEXT REFERENCES project_alpha_directory_reconciliation_runs(run_id) ON DELETE RESTRICT,
  cursor TEXT,
  pages_observed INTEGER NOT NULL DEFAULT 0 CHECK(pages_observed>=0),
  items_observed INTEGER NOT NULL DEFAULT 0 CHECK(items_observed>=0),
  source_instance_id TEXT,
  application_id TEXT,
  history_epoch_id TEXT,
  authorization_generation TEXT,
  updated_at TEXT NOT NULL,
  CHECK(active_run_id IS NOT NULL OR cursor IS NULL)
);

CREATE TABLE project_alpha_directory_reconciliation_observations (
  run_id TEXT NOT NULL REFERENCES project_alpha_directory_reconciliation_runs(run_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  public_id TEXT NOT NULL CHECK(length(public_id)=32 AND public_id=lower(public_id)
    AND public_id NOT GLOB '*[^0-9a-f]*'),
  revision TEXT NOT NULL,
  present INTEGER NOT NULL CHECK(present IN (0,1)),
  last_action TEXT NOT NULL CHECK(last_action IN ('upsert','delete')),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256=lower(projection_sha256)
    AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  binding_external_id TEXT,
  binding_status TEXT CHECK(binding_status IS NULL OR binding_status IN ('active','tombstoned')),
  binding_resource_revision TEXT,
  profile_json TEXT CHECK(profile_json IS NULL OR json_valid(profile_json)),
  profile_revision TEXT,
  profile_authorization_generation TEXT,
  binding_status_json TEXT CHECK(binding_status_json IS NULL OR json_valid(binding_status_json)),
  binding_authorization_generation TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(run_id,resource_type,public_id),
  UNIQUE(run_id,ordinal),
  CHECK((binding_external_id IS NULL)=(binding_status IS NULL)),
  CHECK((binding_external_id IS NULL)=(binding_resource_revision IS NULL))
);
CREATE INDEX project_alpha_directory_reconciliation_observations_binding
  ON project_alpha_directory_reconciliation_observations(run_id,resource_type,binding_external_id);

CREATE TABLE project_alpha_directory_reconciliation_findings (
  finding_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES project_alpha_directory_reconciliation_runs(run_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN (
    'missing_remote','extra_remote','public_id_mismatch','external_id_mismatch','revision_mismatch',
    'projection_mismatch','presence_mismatch','binding_mismatch','relationship_mismatch')),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  local_external_id TEXT,
  local_public_id TEXT,
  remote_public_id TEXT,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  review_state TEXT NOT NULL DEFAULT 'open' CHECK(review_state IN ('open','acknowledged','dismissed','resolved')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT,
  UNIQUE(run_id,classification,resource_type,local_external_id,local_public_id,remote_public_id),
  CHECK((review_state='open' AND reviewed_at IS NULL AND reviewed_by IS NULL AND review_note IS NULL)
    OR (review_state<>'open' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE INDEX project_alpha_directory_reconciliation_findings_review
  ON project_alpha_directory_reconciliation_findings(source_id,review_state,created_at DESC);

CREATE TRIGGER project_alpha_directory_reconciliation_runs_update_guard
BEFORE UPDATE ON project_alpha_directory_reconciliation_runs
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.source_id IS NOT OLD.source_id
 OR NEW.previous_complete_run_id IS NOT OLD.previous_complete_run_id OR NEW.started_at IS NOT OLD.started_at
 OR OLD.status<>'running' OR NEW.status NOT IN ('running','complete','uncertain')
 OR (OLD.source_instance_id IS NOT NULL AND NEW.source_instance_id IS NOT OLD.source_instance_id)
 OR (OLD.application_id IS NOT NULL AND NEW.application_id IS NOT OLD.application_id)
 OR (OLD.history_epoch_id IS NOT NULL AND NEW.history_epoch_id IS NOT OLD.history_epoch_id)
 OR (OLD.authorization_generation IS NOT NULL AND NEW.authorization_generation IS NOT OLD.authorization_generation)
BEGIN SELECT RAISE(ABORT,'directory reconciliation run update is invalid'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_runs_no_delete
BEFORE DELETE ON project_alpha_directory_reconciliation_runs
BEGIN SELECT RAISE(ABORT,'directory reconciliation runs are durable'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_observations_update_guard
BEFORE UPDATE ON project_alpha_directory_reconciliation_observations
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.ordinal IS NOT OLD.ordinal
 OR NEW.resource_type IS NOT OLD.resource_type OR NEW.public_id IS NOT OLD.public_id
 OR NEW.revision IS NOT OLD.revision OR NEW.present IS NOT OLD.present
 OR NEW.last_action IS NOT OLD.last_action OR NEW.projection_sha256 IS NOT OLD.projection_sha256
 OR NEW.binding_external_id IS NOT OLD.binding_external_id OR NEW.binding_status IS NOT OLD.binding_status
 OR NEW.binding_resource_revision IS NOT OLD.binding_resource_revision OR NEW.observed_at IS NOT OLD.observed_at
 OR OLD.profile_json IS NOT NULL OR OLD.profile_revision IS NOT NULL
 OR OLD.profile_authorization_generation IS NOT NULL OR OLD.binding_status_json IS NOT NULL
 OR OLD.binding_authorization_generation IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM project_alpha_directory_reconciliation_runs run
      WHERE run.run_id=OLD.run_id AND run.status='running')
BEGIN SELECT RAISE(ABORT,'directory reconciliation observation update is invalid'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_observations_no_delete
BEFORE DELETE ON project_alpha_directory_reconciliation_observations
BEGIN SELECT RAISE(ABORT,'directory reconciliation observations are durable'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_findings_identity_immutable
BEFORE UPDATE ON project_alpha_directory_reconciliation_findings
WHEN NEW.finding_id IS NOT OLD.finding_id OR NEW.run_id IS NOT OLD.run_id OR NEW.source_id IS NOT OLD.source_id
 OR NEW.classification IS NOT OLD.classification OR NEW.resource_type IS NOT OLD.resource_type
 OR NEW.local_external_id IS NOT OLD.local_external_id OR NEW.local_public_id IS NOT OLD.local_public_id
 OR NEW.remote_public_id IS NOT OLD.remote_public_id OR NEW.details_json IS NOT OLD.details_json
 OR NEW.created_at IS NOT OLD.created_at OR OLD.review_state<>'open'
BEGIN SELECT RAISE(ABORT,'directory reconciliation finding identity/review is immutable'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_findings_no_delete
BEFORE DELETE ON project_alpha_directory_reconciliation_findings
BEGIN SELECT RAISE(ABORT,'directory reconciliation findings are durable'); END;
