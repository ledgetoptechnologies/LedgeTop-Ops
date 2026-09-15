PRAGMA foreign_keys = ON;

-- Durable Ops-owned commands. Credentials are deliberately absent: a dispatcher
-- receives them only for the duration of an attempt.
CREATE TABLE project_alpha_directory_outbox (
  command_id TEXT NOT NULL PRIMARY KEY,
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:'),
  application_id TEXT NOT NULL CHECK(length(application_id) BETWEEN 1 AND 128),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK(json_valid(command_json)),
  destination_base_url TEXT NOT NULL,
  expected_source_instance_id TEXT NOT NULL,
  origin_snapshot_json TEXT NOT NULL CHECK(json_valid(origin_snapshot_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','acknowledged','terminal')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK(state<>'acknowledged' OR outcome_json IS NOT NULL)
);
CREATE INDEX project_alpha_directory_outbox_ready
  ON project_alpha_directory_outbox(state,next_attempt_at,lease_expires_at,created_at);
CREATE TRIGGER project_alpha_directory_outbox_identity_immutable BEFORE UPDATE ON project_alpha_directory_outbox
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.source_id IS NOT OLD.source_id OR NEW.application_id IS NOT OLD.application_id
 OR NEW.resource_type IS NOT OLD.resource_type OR NEW.external_id IS NOT OLD.external_id OR NEW.command_json IS NOT OLD.command_json
 OR NEW.destination_base_url IS NOT OLD.destination_base_url OR NEW.expected_source_instance_id IS NOT OLD.expected_source_instance_id
 OR NEW.origin_snapshot_json IS NOT OLD.origin_snapshot_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'directory outbox reservation is immutable'); END;
CREATE TRIGGER project_alpha_directory_outbox_no_delete BEFORE DELETE ON project_alpha_directory_outbox
BEGIN SELECT RAISE(ABORT,'directory outbox commands are durable'); END;

-- This is an explicit association owned by Ops; pa_clients/pa_organizations
-- remain imported projections and are never changed by the dispatcher.
CREATE TABLE project_alpha_directory_mappings (
  source_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_outbox(command_id),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(source_id,source_instance_id,application_id,resource_type,external_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id)
);
CREATE TRIGGER project_alpha_directory_mappings_no_update BEFORE UPDATE ON project_alpha_directory_mappings
BEGIN SELECT RAISE(ABORT,'directory mappings are immutable'); END;
CREATE TRIGGER project_alpha_directory_mappings_no_delete BEFORE DELETE ON project_alpha_directory_mappings
BEGIN SELECT RAISE(ABORT,'directory mappings are immutable'); END;
