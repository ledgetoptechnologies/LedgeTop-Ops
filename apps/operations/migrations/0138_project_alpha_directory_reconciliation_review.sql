PRAGMA foreign_keys = ON;

-- Immutable administrator selection. This reserves an acquisition action but
-- does not activate the resulting mapping or authorize client access.
CREATE TABLE project_alpha_directory_reconciliation_actions (
  action_id TEXT NOT NULL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  finding_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_reconciliation_findings(finding_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES project_alpha_directory_reconciliation_runs(run_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  authorization_generation TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('extra_remote','public_id_mismatch','external_id_mismatch','binding_mismatch')),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  remote_public_id TEXT NOT NULL,
  remote_revision TEXT NOT NULL,
  record_id TEXT NOT NULL,
  expected_record_version INTEGER NOT NULL CHECK(expected_record_version>=1),
  review_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL UNIQUE,
  reviewer_staff_id TEXT NOT NULL,
  reviewer_access_subject TEXT NOT NULL,
  reviewer_admission_version INTEGER NOT NULL CHECK(reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(reviewer_profile_version>=1),
  reviewer_grant_generation INTEGER NOT NULL CHECK(reviewer_grant_generation>=1),
  created_at TEXT NOT NULL,
  -- A native record may be independently selected in distinct configured PA
  -- sources, never twice inside one source after identity/epoch rotation.
  UNIQUE(source_id,record_id)
);

CREATE TABLE project_alpha_directory_reconciliation_action_outcomes (
  action_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_directory_reconciliation_actions(action_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status='acquired'),
  acquired_receipt_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TRIGGER project_alpha_directory_reconciliation_actions_insert_guard
BEFORE INSERT ON project_alpha_directory_reconciliation_actions
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_directory_reconciliation_findings finding
  JOIN project_alpha_directory_reconciliation_checkpoints checkpoint
    ON checkpoint.source_id=finding.source_id AND checkpoint.complete_run_id=finding.run_id
  JOIN project_alpha_directory_reconciliation_runs run ON run.run_id=finding.run_id AND run.status='complete'
  JOIN project_alpha_directory_reconciliation_observations observation
    ON observation.run_id=finding.run_id AND observation.resource_type=finding.resource_type
      AND observation.public_id=finding.remote_public_id
  JOIN operations_directory_records record ON record.record_id=NEW.record_id
    AND record.record_kind=finding.resource_type AND record.current_version=NEW.expected_record_version
  WHERE finding.finding_id=NEW.finding_id AND finding.review_state='open'
    AND finding.classification=NEW.classification AND finding.run_id=NEW.run_id
    AND finding.source_id=NEW.source_id AND finding.resource_type=NEW.resource_type
    AND finding.remote_public_id=NEW.remote_public_id AND observation.revision=NEW.remote_revision
    AND run.source_instance_id=NEW.source_instance_id AND run.application_id=NEW.application_id
    AND run.history_epoch_id=NEW.history_epoch_id AND run.authorization_generation=NEW.authorization_generation
)
BEGIN SELECT RAISE(ABORT,'reconciliation action requires one current exact finding and record'); END;

-- Server-generated reviews from this workflow remain tied to the current
-- complete snapshot and the exact selected native record.
CREATE TRIGGER project_alpha_directory_reconciliation_action_review_guard
BEFORE INSERT ON project_alpha_existing_directory_binding_review_evidence
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_reconciliation_actions action WHERE action.review_id=NEW.review_id)
 AND NOT EXISTS (
  SELECT 1 FROM project_alpha_directory_reconciliation_actions action
  JOIN project_alpha_directory_reconciliation_checkpoints checkpoint
    ON checkpoint.source_id=action.source_id AND checkpoint.complete_run_id=action.run_id
  JOIN project_alpha_directory_reconciliation_findings finding
    ON finding.finding_id=action.finding_id AND finding.run_id=action.run_id AND finding.review_state='open'
  JOIN operations_directory_records record ON record.record_id=action.record_id
    AND record.record_kind=action.resource_type AND record.current_version=action.expected_record_version
  WHERE action.review_id=NEW.review_id AND action.record_id=NEW.record_id AND action.source_id=NEW.source_id
    AND action.source_instance_id=NEW.source_instance_id AND action.application_id=NEW.application_id
    AND action.history_epoch_id=NEW.history_epoch_id AND action.resource_type=NEW.resource_type
    AND action.record_id=NEW.external_id AND action.remote_public_id=NEW.project_alpha_public_id
    AND action.remote_revision=NEW.project_alpha_revision AND action.reviewer_staff_id=NEW.reviewer_staff_id
    AND action.reviewer_access_subject=NEW.reviewer_access_subject
    AND action.reviewer_admission_version=NEW.reviewer_admission_version
    AND action.reviewer_profile_version=NEW.reviewer_profile_version
    AND action.expected_record_version=NEW.reviewed_local_record_version
 )
BEGIN SELECT RAISE(ABORT,'reconciliation review evidence lost current exact reservation'); END;

CREATE TRIGGER project_alpha_directory_reconciliation_action_receipt_guard
BEFORE INSERT ON project_alpha_existing_directory_binding_acquired_mapping_receipts
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_reconciliation_actions action WHERE action.command_id=NEW.command_id)
 AND NOT EXISTS (
  SELECT 1 FROM project_alpha_directory_reconciliation_actions action
  JOIN project_alpha_directory_reconciliation_checkpoints checkpoint
    ON checkpoint.source_id=action.source_id AND checkpoint.complete_run_id=action.run_id
  JOIN project_alpha_directory_reconciliation_findings finding
    ON finding.finding_id=action.finding_id AND finding.run_id=action.run_id AND finding.review_state='open'
  JOIN operations_directory_records record ON record.record_id=action.record_id
    AND record.record_kind=action.resource_type AND record.current_version=action.expected_record_version
  WHERE action.command_id=NEW.command_id AND action.record_id=NEW.record_id AND action.source_id=NEW.source_id
    AND action.source_instance_id=NEW.source_instance_id AND action.application_id=NEW.application_id
    AND action.history_epoch_id=NEW.history_epoch_id AND action.resource_type=NEW.resource_type
    AND action.record_id=NEW.external_id AND action.remote_public_id=NEW.project_alpha_public_id
    AND action.remote_revision=NEW.project_alpha_revision
 )
BEGIN SELECT RAISE(ABORT,'reconciliation acquired receipt lost current exact reservation'); END;

CREATE TRIGGER project_alpha_directory_reconciliation_actions_no_update
BEFORE UPDATE ON project_alpha_directory_reconciliation_actions
BEGIN SELECT RAISE(ABORT,'reconciliation actions are immutable'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_actions_no_delete
BEFORE DELETE ON project_alpha_directory_reconciliation_actions
BEGIN SELECT RAISE(ABORT,'reconciliation actions are durable'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_action_outcomes_no_update
BEFORE UPDATE ON project_alpha_directory_reconciliation_action_outcomes
BEGIN SELECT RAISE(ABORT,'reconciliation action outcomes are immutable'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_action_outcomes_no_delete
BEFORE DELETE ON project_alpha_directory_reconciliation_action_outcomes
BEGIN SELECT RAISE(ABORT,'reconciliation action outcomes are durable'); END;
