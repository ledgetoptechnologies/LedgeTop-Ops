PRAGMA foreign_keys = ON;

CREATE TABLE operations_directory_records (
  record_id TEXT NOT NULL PRIMARY KEY,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  current_version INTEGER NOT NULL CHECK(current_version >= 1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_directory_revisions (
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version >= 1),
  mutation_id TEXT NOT NULL UNIQUE,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(record_id,version),
  UNIQUE(record_id,version,mutation_id)
);

CREATE TABLE operations_directory_audit (
  audit_id TEXT NOT NULL PRIMARY KEY,
  mutation_id TEXT NOT NULL UNIQUE,
  record_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('staff','system')),
  actor_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK(json_valid(command_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(record_id,record_version,mutation_id) REFERENCES operations_directory_revisions(record_id,version,mutation_id) ON DELETE RESTRICT
);

CREATE TABLE operations_directory_intents (
  intent_id TEXT NOT NULL PRIMARY KEY,
  mutation_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  source_instance_uuid TEXT NOT NULL,
  application_uuid TEXT NOT NULL,
  destination_origin TEXT NOT NULL,
  external_canonical_id TEXT NOT NULL,
  desired_payload_json TEXT NOT NULL CHECK(json_valid(desired_payload_json)),
  predecessor_intent_id TEXT REFERENCES operations_directory_intents(intent_id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','ready','materialized','acknowledged','terminal')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(record_id,record_version,mutation_id) REFERENCES operations_directory_revisions(record_id,version,mutation_id) ON DELETE RESTRICT,
  UNIQUE(mutation_id,source_id,source_instance_uuid,application_uuid,destination_origin,external_canonical_id)
);
CREATE INDEX operations_directory_intents_destination_order ON operations_directory_intents(
  source_id,source_instance_uuid,application_uuid,destination_origin,external_canonical_id,record_id,record_version
);

-- One remote customer per canonical record and selected PA application. Origin
-- and external ID are pinned attributes, not a way to bypass causal ordering.
-- Transfer/reconciliation must be an explicit workflow, not a profile edit.
CREATE TRIGGER operations_directory_intents_destination_pinned BEFORE INSERT ON operations_directory_intents
WHEN EXISTS(SELECT 1 FROM operations_directory_intents previous
  WHERE previous.record_id=NEW.record_id AND previous.source_id=NEW.source_id
    AND previous.source_instance_uuid=NEW.source_instance_uuid AND previous.application_uuid=NEW.application_uuid
    AND (previous.destination_origin IS NOT NEW.destination_origin OR previous.external_canonical_id IS NOT NEW.external_canonical_id))
BEGIN SELECT RAISE(ABORT,'directory destination requires explicit reconciliation'); END;

CREATE TRIGGER operations_directory_records_identity_immutable BEFORE UPDATE ON operations_directory_records
WHEN NEW.record_id IS NOT OLD.record_id OR NEW.record_kind IS NOT OLD.record_kind OR NEW.created_at IS NOT OLD.created_at
 OR NEW.current_version <> OLD.current_version + 1
BEGIN SELECT RAISE(ABORT,'directory record identity/history is immutable'); END;
CREATE TRIGGER operations_directory_records_no_delete BEFORE DELETE ON operations_directory_records
BEGIN SELECT RAISE(ABORT,'directory records are durable'); END;
CREATE TRIGGER operations_directory_revisions_no_update BEFORE UPDATE ON operations_directory_revisions
BEGIN SELECT RAISE(ABORT,'directory revisions are immutable'); END;
CREATE TRIGGER operations_directory_revisions_no_delete BEFORE DELETE ON operations_directory_revisions
BEGIN SELECT RAISE(ABORT,'directory revisions are durable'); END;
CREATE TRIGGER operations_directory_audit_no_update BEFORE UPDATE ON operations_directory_audit
BEGIN SELECT RAISE(ABORT,'directory audit is immutable'); END;
CREATE TRIGGER operations_directory_audit_no_delete BEFORE DELETE ON operations_directory_audit
BEGIN SELECT RAISE(ABORT,'directory audit is durable'); END;
CREATE TRIGGER operations_directory_intents_identity_immutable BEFORE UPDATE ON operations_directory_intents
WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.mutation_id IS NOT OLD.mutation_id OR NEW.record_id IS NOT OLD.record_id
 OR NEW.record_version IS NOT OLD.record_version OR NEW.source_id IS NOT OLD.source_id
 OR NEW.source_instance_uuid IS NOT OLD.source_instance_uuid OR NEW.application_uuid IS NOT OLD.application_uuid
 OR NEW.destination_origin IS NOT OLD.destination_origin OR NEW.external_canonical_id IS NOT OLD.external_canonical_id
 OR NEW.desired_payload_json IS NOT OLD.desired_payload_json OR NEW.predecessor_intent_id IS NOT OLD.predecessor_intent_id
 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'directory intent identity is immutable'); END;
CREATE TRIGGER operations_directory_intents_no_delete BEFORE DELETE ON operations_directory_intents
BEGIN SELECT RAISE(ABORT,'directory intents are durable'); END;
