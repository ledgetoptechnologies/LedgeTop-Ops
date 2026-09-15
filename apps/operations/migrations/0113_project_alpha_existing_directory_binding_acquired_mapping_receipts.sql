PRAGMA foreign_keys = ON;

-- An acknowledged acquisition command is historical transport evidence, not a
-- usable local mapping. This receipt is the separate, immutable provenance
-- record for an exact canonical mapping. Nothing in routing, materialization,
-- or authorization reads this table until a later explicitly gated consumer is
-- introduced.
CREATE TABLE project_alpha_existing_directory_binding_acquired_mapping_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY CHECK(length(receipt_id)=36 AND length(replace(receipt_id,'-',''))=32
    AND receipt_id=lower(receipt_id) AND receipt_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(receipt_id,9,1)='-' AND substr(receipt_id,14,1)='-' AND substr(receipt_id,15,1)='4'
    AND substr(receipt_id,19,1)='-' AND substr(receipt_id,20,1) IN ('8','9','a','b') AND substr(receipt_id,24,1)='-'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_existing_directory_binding_acquisition_commands(command_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL CHECK(length(record_id) BETWEEN 1 AND 191 AND instr(record_id,char(0))=0),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128 AND instr(source_id,char(0))=0),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 191 AND length(CAST(external_id AS BLOB))<=764 AND instr(external_id,char(0))=0),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(length(project_alpha_revision) BETWEEN 1 AND 19 AND project_alpha_revision NOT GLOB '*[^0-9]*' AND project_alpha_revision<>'0' AND (length(project_alpha_revision)<19 OR project_alpha_revision<='9223372036854775807')),
  -- These hashes preserve the exact caller-supplied PA response attestations
  -- after their identity fields are matched to the stored command. D1 cannot
  -- authenticate a remote response; the 0112 acknowledgement alone is also
  -- deliberately insufficient evidence.
  acquisition_evidence_sha256 TEXT NOT NULL CHECK(length(acquisition_evidence_sha256)=64 AND acquisition_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  profile_evidence_sha256 TEXT NOT NULL CHECK(length(profile_evidence_sha256)=64 AND profile_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  binding_status_evidence_sha256 TEXT NOT NULL CHECK(length(binding_status_evidence_sha256)=64 AND binding_status_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  acquired_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(acquired_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',acquired_at)=acquired_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_id,source_instance_id,application_id,history_epoch_id,resource_type,record_id),
  UNIQUE(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id),
  UNIQUE(source_id,source_instance_id,application_id,history_epoch_id,resource_type,project_alpha_public_id)
);
CREATE INDEX project_alpha_existing_directory_binding_acquired_mapping_receipts_lookup
  ON project_alpha_existing_directory_binding_acquired_mapping_receipts(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id);

-- Copying the command identity is intentional: readers can prove the full
-- canonical pair without treating a mutable command/event lookup as mapping
-- state. The receipt can only be recorded from the terminal acknowledgement.
CREATE TRIGGER project_alpha_existing_directory_binding_acquired_mapping_receipts_command_match
BEFORE INSERT ON project_alpha_existing_directory_binding_acquired_mapping_receipts
WHEN NOT EXISTS(
  SELECT 1
  FROM project_alpha_existing_directory_binding_acquisition_commands command
  JOIN project_alpha_existing_directory_binding_acquisition_events event
    ON event.command_id=command.command_id AND event.state='acknowledged'
  WHERE command.command_id=NEW.command_id
    AND command.record_id=NEW.record_id AND command.source_id=NEW.source_id
    AND command.source_instance_id=NEW.source_instance_id AND command.application_id=NEW.application_id
    AND command.history_epoch_id=NEW.history_epoch_id AND command.resource_type=NEW.resource_type
    AND command.external_id=NEW.external_id AND command.project_alpha_public_id=NEW.project_alpha_public_id
    AND command.project_alpha_revision=NEW.project_alpha_revision
)
BEGIN SELECT RAISE(ABORT,'existing directory acquired mapping receipt requires acknowledged exact command'); END;
-- Older 0054 mappings may have a NULL history epoch. They remain collision
-- evidence: a later receipt cannot silently pair either side with a new ID.
CREATE TRIGGER project_alpha_existing_directory_binding_acquired_mapping_receipts_legacy_collision
BEFORE INSERT ON project_alpha_existing_directory_binding_acquired_mapping_receipts
WHEN EXISTS(
  SELECT 1 FROM project_alpha_directory_mappings legacy
  WHERE legacy.source_id=NEW.source_id AND legacy.source_instance_id=NEW.source_instance_id
    AND legacy.application_id=NEW.application_id AND legacy.resource_type=NEW.resource_type
    AND (legacy.external_id=NEW.external_id OR legacy.project_alpha_public_id=NEW.project_alpha_public_id)
    AND NOT (legacy.external_id=NEW.external_id AND legacy.project_alpha_public_id=NEW.project_alpha_public_id)
)
BEGIN SELECT RAISE(ABORT,'existing directory acquired mapping receipt conflicts with legacy mapping'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_acquired_mapping_receipts_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_acquired_mapping_receipts
BEGIN SELECT RAISE(ABORT,'existing directory acquired mapping receipt is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_acquired_mapping_receipts_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_acquired_mapping_receipts
BEGIN SELECT RAISE(ABORT,'existing directory acquired mapping receipt is durable'); END;
