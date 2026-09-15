PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = ON;

-- SQLite cannot widen the operation CHECK or change mapping nullability in
-- place. Rename the 0062 tables, copy every durable field, and remove the old
-- tables only after the constrained replacements have accepted all rows.
DROP TRIGGER project_alpha_project_mapping_command_valid;
DROP TRIGGER project_alpha_project_mappings_no_update;
DROP TRIGGER project_alpha_project_mappings_no_delete;
DROP TRIGGER project_alpha_project_outbox_identity_immutable;
DROP TRIGGER project_alpha_project_outbox_no_delete;

ALTER TABLE project_alpha_project_mappings RENAME TO project_alpha_project_mappings_0062;
ALTER TABLE project_alpha_project_outbox RENAME TO project_alpha_project_outbox_0062;
DROP INDEX project_alpha_project_outbox_unresolved;
DROP INDEX project_alpha_project_outbox_ready;

CREATE TABLE project_alpha_project_outbox (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id)=36),
  external_project_id TEXT NOT NULL REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','bind')),
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

INSERT INTO project_alpha_project_outbox(
  command_id,external_project_id,operation,command_json,source_id,application_id,destination_base_url,
  expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,lease_token,
  lease_expires_at,outcome_json,created_at,updated_at
)
SELECT command_id,external_project_id,operation,command_json,source_id,application_id,destination_base_url,
  expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,lease_token,
  lease_expires_at,outcome_json,created_at,updated_at
FROM project_alpha_project_outbox_0062;

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
  establishment_kind TEXT NOT NULL CHECK(establishment_kind IN ('create','bind')),
  establishment_command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_outbox(command_id) ON DELETE RESTRICT,
  create_command_id TEXT UNIQUE REFERENCES project_alpha_project_outbox(command_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((establishment_kind='create' AND create_command_id IS NOT NULL
      AND create_command_id=establishment_command_id)
    OR (establishment_kind='bind' AND create_command_id IS NULL)),
  FOREIGN KEY(external_project_id,source_id,application_id,source_instance_id)
    REFERENCES project_alpha_project_destinations(external_project_id,source_id,application_id,expected_source_instance_id),
  UNIQUE(source_instance_id,project_alpha_public_id),
  UNIQUE(external_project_id,establishment_command_id)
);

-- All 0062 mappings were established by their create command. The insertion
-- trigger is intentionally installed after this history-preserving backfill,
-- because acknowledged historical commands are no longer leased.
INSERT INTO project_alpha_project_mappings(
  external_project_id,source_id,source_instance_id,application_id,project_alpha_public_id,
  establishment_kind,establishment_command_id,create_command_id,created_at
)
SELECT external_project_id,source_id,source_instance_id,application_id,project_alpha_public_id,
  'create',create_command_id,create_command_id,created_at
FROM project_alpha_project_mappings_0062;

CREATE TRIGGER project_alpha_project_mapping_command_valid BEFORE INSERT ON project_alpha_project_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_outbox outbox
  WHERE outbox.command_id=NEW.establishment_command_id
    AND outbox.external_project_id=NEW.external_project_id
    AND outbox.source_id=NEW.source_id
    AND outbox.application_id=NEW.application_id
    AND outbox.expected_source_instance_id=NEW.source_instance_id
    AND outbox.operation=NEW.establishment_kind
    AND outbox.state='leased'
)
BEGIN SELECT RAISE(ABORT,'project mapping establishment command is invalid'); END;
CREATE TRIGGER project_alpha_project_mappings_no_update BEFORE UPDATE ON project_alpha_project_mappings
BEGIN SELECT RAISE(ABORT,'project mapping is immutable'); END;
CREATE TRIGGER project_alpha_project_mappings_no_delete BEFORE DELETE ON project_alpha_project_mappings
BEGIN SELECT RAISE(ABORT,'project mapping is durable'); END;

CREATE TABLE project_alpha_project_refresh (
  external_project_id TEXT NOT NULL PRIMARY KEY,
  establishment_command_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state='pending'),
  minimum_revision TEXT NOT NULL CHECK(
    minimum_revision GLOB '[1-9]*'
    AND minimum_revision NOT GLOB '*[^0-9]*'
    AND length(minimum_revision)<=19
    AND (length(minimum_revision)<19 OR minimum_revision<='9223372036854775807')
  ),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(external_project_id,establishment_command_id)
    REFERENCES project_alpha_project_mappings(external_project_id,establishment_command_id) ON DELETE RESTRICT
);
CREATE TRIGGER project_alpha_project_refresh_binding_valid BEFORE INSERT ON project_alpha_project_refresh
WHEN NOT EXISTS (
  SELECT 1
  FROM project_alpha_project_mappings mapping
  JOIN project_alpha_project_outbox outbox
    ON outbox.command_id=mapping.establishment_command_id
   AND outbox.external_project_id=mapping.external_project_id
  WHERE mapping.external_project_id=NEW.external_project_id
    AND mapping.establishment_command_id=NEW.establishment_command_id
    AND mapping.establishment_kind='bind'
    AND outbox.operation='bind'
    AND outbox.state='leased'
    AND json_type(outbox.command_json,'$.expectedRevision')='text'
    AND json_extract(outbox.command_json,'$.expectedRevision')=NEW.minimum_revision
)
BEGIN SELECT RAISE(ABORT,'project refresh requires its exact leased bind revision'); END;
CREATE TRIGGER project_alpha_project_refresh_identity_immutable BEFORE UPDATE ON project_alpha_project_refresh
WHEN NEW.external_project_id IS NOT OLD.external_project_id
 OR NEW.establishment_command_id IS NOT OLD.establishment_command_id
 OR NEW.minimum_revision IS NOT OLD.minimum_revision
 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'project refresh identity is immutable'); END;
CREATE TRIGGER project_alpha_project_refresh_no_delete BEFORE DELETE ON project_alpha_project_refresh
BEGIN SELECT RAISE(ABORT,'project refresh reservation is durable'); END;

DROP TABLE project_alpha_project_mappings_0062;
DROP TABLE project_alpha_project_outbox_0062;
