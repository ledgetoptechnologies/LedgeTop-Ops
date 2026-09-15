PRAGMA foreign_keys = ON;

-- A destination is selected before the first network attempt. This prevents an
-- uncertain create from being redirected to a second PA installation.
CREATE TABLE project_alpha_project_destinations (
  external_project_id TEXT NOT NULL PRIMARY KEY CHECK(length(external_project_id) BETWEEN 1 AND 191),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:'),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  destination_base_url TEXT NOT NULL CHECK(length(destination_base_url) BETWEEN 1 AND 2048),
  expected_source_instance_id TEXT NOT NULL CHECK(length(expected_source_instance_id)=36),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX project_alpha_project_destination_identity
  ON project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id);
CREATE UNIQUE INDEX project_alpha_project_destination_source_application
  ON project_alpha_project_destinations(external_project_id,source_id,application_id,expected_source_instance_id);
CREATE TRIGGER project_alpha_project_destinations_no_update BEFORE UPDATE ON project_alpha_project_destinations
BEGIN SELECT RAISE(ABORT,'project destination is immutable'); END;
CREATE TRIGGER project_alpha_project_destinations_no_delete BEFORE DELETE ON project_alpha_project_destinations
BEGIN SELECT RAISE(ABORT,'project destination is durable'); END;

CREATE TABLE project_alpha_project_outbox (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id)=36),
  external_project_id TEXT NOT NULL REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('create','update')),
  command_json TEXT NOT NULL CHECK(json_valid(command_json)),
  source_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  destination_base_url TEXT NOT NULL,
  expected_source_instance_id TEXT NOT NULL,
  origin_snapshot_json TEXT NOT NULL CHECK(json_valid(origin_snapshot_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','acknowledged','terminal')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts>=0),
  next_attempt_at INTEGER NOT NULL CHECK(typeof(next_attempt_at)='integer' AND next_attempt_at>=0),
  lease_token TEXT,
  lease_expires_at INTEGER,
  outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK(state<>'acknowledged' OR outcome_json IS NOT NULL),
  FOREIGN KEY(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id)
    REFERENCES project_alpha_project_destinations(external_project_id,source_id,application_id,destination_base_url,expected_source_instance_id)
);
CREATE UNIQUE INDEX project_alpha_project_outbox_unresolved
  ON project_alpha_project_outbox(external_project_id) WHERE state IN ('pending','leased','terminal');
CREATE INDEX project_alpha_project_outbox_ready
  ON project_alpha_project_outbox(source_id,state,next_attempt_at,lease_expires_at,created_at,command_id);
CREATE TRIGGER project_alpha_project_outbox_identity_immutable BEFORE UPDATE ON project_alpha_project_outbox
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.external_project_id IS NOT OLD.external_project_id
 OR NEW.operation IS NOT OLD.operation OR NEW.command_json IS NOT OLD.command_json
 OR NEW.source_id IS NOT OLD.source_id OR NEW.application_id IS NOT OLD.application_id
 OR NEW.destination_base_url IS NOT OLD.destination_base_url
 OR NEW.expected_source_instance_id IS NOT OLD.expected_source_instance_id
 OR NEW.origin_snapshot_json IS NOT OLD.origin_snapshot_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'project outbox reservation is immutable'); END;
CREATE TRIGGER project_alpha_project_outbox_no_delete BEFORE DELETE ON project_alpha_project_outbox
BEGIN SELECT RAISE(ABORT,'project outbox commands are durable'); END;

CREATE TABLE project_alpha_project_mappings (
  external_project_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32),
  create_command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_outbox(command_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(external_project_id,source_id,application_id,source_instance_id)
    REFERENCES project_alpha_project_destinations(external_project_id,source_id,application_id,expected_source_instance_id),
  UNIQUE(source_instance_id,project_alpha_public_id)
);
CREATE TRIGGER project_alpha_project_mapping_command_valid BEFORE INSERT ON project_alpha_project_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_outbox outbox
  WHERE outbox.command_id=NEW.create_command_id AND outbox.external_project_id=NEW.external_project_id
    AND outbox.source_id=NEW.source_id AND outbox.application_id=NEW.application_id
    AND outbox.expected_source_instance_id=NEW.source_instance_id AND outbox.operation='create'
    AND outbox.state='leased'
)
BEGIN SELECT RAISE(ABORT,'project mapping create command is invalid'); END;
CREATE TRIGGER project_alpha_project_mappings_no_update BEFORE UPDATE ON project_alpha_project_mappings
BEGIN SELECT RAISE(ABORT,'project mapping is immutable'); END;
CREATE TRIGGER project_alpha_project_mappings_no_delete BEFORE DELETE ON project_alpha_project_mappings
BEGIN SELECT RAISE(ABORT,'project mapping is durable'); END;
