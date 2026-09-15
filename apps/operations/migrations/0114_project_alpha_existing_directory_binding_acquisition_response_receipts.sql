PRAGMA foreign_keys = ON;

-- Historical, strictly transport-validated PA POST response provenance. This is not a
-- binding or an authorization grant. No route or mapping consumer reads it.
CREATE TABLE project_alpha_existing_directory_binding_acquisition_response_receipts (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_existing_directory_binding_acquisition_commands(command_id) ON DELETE RESTRICT,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('client','organization')),
  external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL,
  project_alpha_revision TEXT NOT NULL,
  destination_origin TEXT NOT NULL CHECK(substr(destination_origin,1,8)='https://' AND length(destination_origin)<=2048),
  pa_request_id TEXT NOT NULL CHECK(length(pa_request_id)=36),
  pa_replayed INTEGER NOT NULL CHECK(pa_replayed IN (0,1)),
  response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64 AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_response_receipts_exact_command
BEFORE INSERT ON project_alpha_existing_directory_binding_acquisition_response_receipts
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_commands command
  WHERE command.command_id=NEW.command_id AND command.source_instance_id=NEW.source_instance_id
    AND command.application_id=NEW.application_id AND command.history_epoch_id=NEW.history_epoch_id
    AND command.resource_type=NEW.resource_type AND command.external_id=NEW.external_id
    AND command.project_alpha_public_id=NEW.project_alpha_public_id AND command.project_alpha_revision=NEW.project_alpha_revision)
BEGIN SELECT RAISE(ABORT,'acquisition response does not match reserved command'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_response_receipts_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_acquisition_response_receipts
BEGIN SELECT RAISE(ABORT,'acquisition response receipt is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_response_receipts_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_acquisition_response_receipts
BEGIN SELECT RAISE(ABORT,'acquisition response receipt is durable'); END;

-- Older 0113 store callers can still supply JSON-shaped identity fields. The
-- additive database gate makes that insufficient after 0114 is applied.
CREATE TRIGGER project_alpha_existing_directory_binding_acquired_mapping_receipts_response_required
BEFORE INSERT ON project_alpha_existing_directory_binding_acquired_mapping_receipts
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_response_receipts response
  WHERE response.command_id=NEW.command_id AND response.source_instance_id=NEW.source_instance_id
    AND response.application_id=NEW.application_id AND response.history_epoch_id=NEW.history_epoch_id
    AND response.resource_type=NEW.resource_type AND response.external_id=NEW.external_id
    AND response.project_alpha_public_id=NEW.project_alpha_public_id AND response.project_alpha_revision=NEW.project_alpha_revision)
BEGIN SELECT RAISE(ABORT,'acquired mapping receipt requires PA acquisition response receipt'); END;
