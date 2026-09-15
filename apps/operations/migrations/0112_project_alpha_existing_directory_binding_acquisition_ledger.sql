PRAGMA foreign_keys = ON;

-- A command reservation is not a directory binding. It pins the operator's
-- already-reviewed selection so a later explicit PA acquisition attempt has a
-- stable idempotency key and cannot silently retarget an identity.
CREATE TABLE project_alpha_existing_directory_binding_acquisition_commands (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id)=36 AND length(replace(command_id,'-',''))=32
    AND command_id=lower(command_id) AND command_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(command_id,9,1)='-' AND substr(command_id,14,1)='-' AND substr(command_id,15,1)='4'
    AND substr(command_id,19,1)='-' AND substr(command_id,20,1) IN ('8','9','a','b') AND substr(command_id,24,1)='-'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_id TEXT NOT NULL CHECK(length(record_id) BETWEEN 1 AND 191 AND instr(record_id,char(0))=0),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128 AND instr(source_id,char(0))=0),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 191 AND length(CAST(external_id AS BLOB))<=764 AND instr(external_id,char(0))=0),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(length(project_alpha_revision) BETWEEN 1 AND 19 AND project_alpha_revision NOT GLOB '*[^0-9]*' AND project_alpha_revision<>'0' AND (length(project_alpha_revision)<19 OR project_alpha_revision<='9223372036854775807')),
  review_receipt_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_existing_directory_binding_review_evidence(receipt_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX project_alpha_existing_directory_binding_acquisition_commands_pair_lookup
  ON project_alpha_existing_directory_binding_acquisition_commands(source_id,source_instance_id,application_id,history_epoch_id,resource_type,record_id,external_id,project_alpha_public_id);
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_commands_review_match
BEFORE INSERT ON project_alpha_existing_directory_binding_acquisition_commands
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_review_evidence review
  WHERE review.receipt_id=NEW.review_receipt_id AND review.record_id=NEW.record_id
    AND review.source_id=NEW.source_id AND review.source_instance_id=NEW.source_instance_id
    AND review.application_id=NEW.application_id AND review.history_epoch_id=NEW.history_epoch_id
    AND review.resource_type=NEW.resource_type AND review.external_id=NEW.external_id
    AND review.project_alpha_public_id=NEW.project_alpha_public_id AND review.project_alpha_revision=NEW.project_alpha_revision)
BEGIN SELECT RAISE(ABORT,'existing directory binding acquisition review receipt does not match command'); END;
-- Within one PA namespace, all three identity directions must move together:
-- an exact local/external/PA-public pair may be re-reviewed at a newer
-- revision, and an entirely distinct triple may coexist. Any partial overlap
-- is a retarget and is rejected. PA instances are deliberately not global.
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_commands_pair_pinned
BEFORE INSERT ON project_alpha_existing_directory_binding_acquisition_commands
WHEN EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_commands existing
  WHERE existing.source_id=NEW.source_id AND existing.source_instance_id=NEW.source_instance_id
    AND existing.application_id=NEW.application_id AND existing.history_epoch_id=NEW.history_epoch_id
    AND existing.resource_type=NEW.resource_type
    AND (existing.record_id IS NEW.record_id OR existing.external_id IS NEW.external_id
      OR existing.project_alpha_public_id IS NEW.project_alpha_public_id)
    AND NOT (existing.record_id IS NEW.record_id AND existing.external_id IS NEW.external_id
      AND existing.project_alpha_public_id IS NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'existing directory binding acquisition identity conflict'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_commands_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_acquisition_commands
BEGIN SELECT RAISE(ABORT,'existing directory binding acquisition command is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_commands_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_acquisition_commands
BEGIN SELECT RAISE(ABORT,'existing directory binding acquisition command is durable'); END;

-- State is an append-only, per-command fenced event stream. There is no
-- mutable "current binding" row and acknowledgement authorizes nothing. A
-- later PA workflow must reconcile earlier pending/uncertain commands before
-- it attempts another acquisition; this ledger alone cannot establish that.
CREATE TABLE project_alpha_existing_directory_binding_acquisition_events (
  command_id TEXT NOT NULL REFERENCES project_alpha_existing_directory_binding_acquisition_commands(command_id) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK(typeof(state_version)='integer' AND state_version>=1),
  transition_id TEXT NOT NULL UNIQUE CHECK(length(transition_id)=36 AND length(replace(transition_id,'-',''))=32
    AND transition_id=lower(transition_id) AND transition_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(transition_id,9,1)='-' AND substr(transition_id,14,1)='-' AND substr(transition_id,15,1)='4'
    AND substr(transition_id,19,1)='-' AND substr(transition_id,20,1) IN ('8','9','a','b') AND substr(transition_id,24,1)='-'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','uncertain','acknowledged')),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(command_id,state_version)
);
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_events_fence
BEFORE INSERT ON project_alpha_existing_directory_binding_acquisition_events
WHEN (NEW.state_version=1 AND NEW.state<>'pending')
  OR (NEW.state_version>1 AND NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_events prior WHERE prior.command_id=NEW.command_id AND prior.state_version=NEW.state_version-1 AND ((prior.state='pending' AND NEW.state IN ('uncertain','acknowledged')) OR (prior.state='uncertain' AND NEW.state='acknowledged'))))
BEGIN SELECT RAISE(ABORT,'existing directory binding acquisition transition is invalid'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_events_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_acquisition_events
BEGIN SELECT RAISE(ABORT,'existing directory binding acquisition event is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_events_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_acquisition_events
BEGIN SELECT RAISE(ABORT,'existing directory binding acquisition event is durable'); END;
