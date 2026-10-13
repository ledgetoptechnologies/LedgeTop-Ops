PRAGMA foreign_keys = ON;

-- A project binding revision refresh advances only Project Alpha's binding
-- evidence.  It never writes Operations project content, mappings, delivery
-- records, or public-link state.
CREATE TABLE project_alpha_project_binding_revision_refresh_commands (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id)=36 AND command_id=lower(command_id)
    AND command_id NOT GLOB '*[^0-9a-f-]*' AND substr(command_id,9,1)='-'
    AND substr(command_id,14,1)='-' AND substr(command_id,15,1)='4'
    AND substr(command_id,19,1)='-' AND substr(command_id,20,1) IN ('8','9','a','b')
    AND substr(command_id,24,1)='-' AND length(replace(command_id,'-',''))=32),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  external_project_id TEXT NOT NULL CHECK(length(external_project_id) BETWEEN 1 AND 191),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  expected_prior_revision TEXT NOT NULL CHECK(expected_prior_revision GLOB '[1-9]*' AND expected_prior_revision NOT GLOB '*[^0-9]*' AND length(expected_prior_revision)<=19),
  expected_live_revision TEXT NOT NULL CHECK(expected_live_revision GLOB '[1-9]*' AND expected_live_revision NOT GLOB '*[^0-9]*' AND length(expected_live_revision)<=19),
  expected_projection_sha256 TEXT NOT NULL CHECK(length(expected_projection_sha256)=64 AND expected_projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_authorization_generation TEXT NOT NULL CHECK(expected_authorization_generation GLOB '[0-9]*' AND expected_authorization_generation NOT GLOB '*[^0-9]*' AND length(expected_authorization_generation)<=19),
  destination_base_url TEXT NOT NULL CHECK(length(destination_base_url) BETWEEN 1 AND 2048),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_id,application_id,external_project_id,expected_prior_revision,expected_live_revision,expected_projection_sha256,expected_authorization_generation)
);

-- The selected project must already be mapped to this exact PA identity.  No
-- command can manufacture a mapping or use a legacy connector accidentally.
CREATE TRIGGER project_alpha_project_binding_revision_refresh_commands_exact_mapping
BEFORE INSERT ON project_alpha_project_binding_revision_refresh_commands
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_mappings mapping
  JOIN project_alpha_project_destinations destination ON destination.external_project_id=mapping.external_project_id
  WHERE mapping.external_project_id=NEW.external_project_id
    AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.project_alpha_public_id=NEW.project_alpha_public_id
    AND destination.source_id=NEW.source_id AND destination.application_id=NEW.application_id
    AND destination.destination_base_url=NEW.destination_base_url
    AND destination.expected_source_instance_id=NEW.source_instance_id)
BEGIN SELECT RAISE(ABORT,'project binding revision refresh requires exact existing mapping'); END;
CREATE TRIGGER project_alpha_project_binding_revision_refresh_commands_monotonic
BEFORE INSERT ON project_alpha_project_binding_revision_refresh_commands
WHEN (length(NEW.expected_live_revision)<length(NEW.expected_prior_revision)
  OR (length(NEW.expected_live_revision)=length(NEW.expected_prior_revision)
    AND NEW.expected_live_revision<=NEW.expected_prior_revision))
BEGIN SELECT RAISE(ABORT,'project binding revision refresh must advance the PA revision'); END;
CREATE TRIGGER project_alpha_project_binding_revision_refresh_commands_no_update
BEFORE UPDATE ON project_alpha_project_binding_revision_refresh_commands
BEGIN SELECT RAISE(ABORT,'project binding revision refresh command is immutable'); END;
CREATE TRIGGER project_alpha_project_binding_revision_refresh_commands_no_delete
BEFORE DELETE ON project_alpha_project_binding_revision_refresh_commands
BEGIN SELECT RAISE(ABORT,'project binding revision refresh command is durable'); END;

CREATE TABLE project_alpha_project_binding_revision_refresh_events (
  command_id TEXT NOT NULL REFERENCES project_alpha_project_binding_revision_refresh_commands(command_id) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK(typeof(state_version)='integer' AND state_version>=1),
  transition_id TEXT NOT NULL UNIQUE CHECK(length(transition_id)=36),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','preflight_blocked','uncertain','acknowledged')),
  occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(command_id,state_version)
);
CREATE TRIGGER project_alpha_project_binding_revision_refresh_events_fence
BEFORE INSERT ON project_alpha_project_binding_revision_refresh_events
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_project_binding_revision_refresh_commands command
  WHERE command.command_id=NEW.command_id AND command.request_sha256=NEW.request_sha256)
  OR (NEW.state_version=1 AND NEW.state<>'pending')
  OR (NEW.state_version>1 AND NOT EXISTS(SELECT 1 FROM project_alpha_project_binding_revision_refresh_events prior
    WHERE prior.command_id=NEW.command_id AND prior.state_version=NEW.state_version-1
      AND ((prior.state='pending' AND NEW.state IN ('preflight_blocked','uncertain','acknowledged')) OR (prior.state='preflight_blocked' AND NEW.state='pending') OR (prior.state='uncertain' AND NEW.state='acknowledged'))))
BEGIN SELECT RAISE(ABORT,'project binding revision refresh transition is invalid'); END;
CREATE TRIGGER project_alpha_project_binding_revision_refresh_events_no_update
BEFORE UPDATE ON project_alpha_project_binding_revision_refresh_events
BEGIN SELECT RAISE(ABORT,'project binding revision refresh event is immutable'); END;
CREATE TRIGGER project_alpha_project_binding_revision_refresh_events_no_delete
BEFORE DELETE ON project_alpha_project_binding_revision_refresh_events
BEGIN SELECT RAISE(ABORT,'project binding revision refresh event is durable'); END;

CREATE TABLE project_alpha_project_binding_revision_refresh_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY CHECK(length(receipt_id)=36),
  command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_binding_revision_refresh_commands(command_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL, history_epoch_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL, project_alpha_public_id TEXT NOT NULL,
  prior_revision TEXT NOT NULL, live_revision TEXT NOT NULL, projection_sha256 TEXT NOT NULL,
  authorization_generation TEXT NOT NULL, pa_request_id TEXT NOT NULL CHECK(length(pa_request_id)=36),
  pa_replayed INTEGER NOT NULL CHECK(pa_replayed IN (0,1)), response_sha256 TEXT NOT NULL,
  post_status_confirmed INTEGER NOT NULL CHECK(post_status_confirmed IN (0,1)),
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_project_binding_revision_refresh_receipts_exact
BEFORE INSERT ON project_alpha_project_binding_revision_refresh_receipts
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_project_binding_revision_refresh_commands command
  JOIN project_alpha_project_binding_revision_refresh_events event ON event.command_id=command.command_id AND event.state='acknowledged'
  WHERE command.command_id=NEW.command_id AND command.request_sha256=NEW.request_sha256
    AND command.source_instance_id=NEW.source_instance_id AND command.application_id=NEW.application_id
    AND command.history_epoch_id=NEW.history_epoch_id AND command.external_project_id=NEW.external_project_id
    AND command.project_alpha_public_id=NEW.project_alpha_public_id AND command.expected_prior_revision=NEW.prior_revision
    AND command.expected_live_revision=NEW.live_revision AND command.expected_projection_sha256=NEW.projection_sha256
    AND CAST(NEW.authorization_generation AS INTEGER)=CAST(command.expected_authorization_generation AS INTEGER)+1)
BEGIN SELECT RAISE(ABORT,'project binding revision refresh receipt is not exact'); END;
CREATE TRIGGER project_alpha_project_binding_revision_refresh_receipts_no_update
BEFORE UPDATE ON project_alpha_project_binding_revision_refresh_receipts
BEGIN SELECT RAISE(ABORT,'project binding revision refresh receipt is immutable'); END;
CREATE TRIGGER project_alpha_project_binding_revision_refresh_receipts_no_delete
BEFORE DELETE ON project_alpha_project_binding_revision_refresh_receipts
BEGIN SELECT RAISE(ABORT,'project binding revision refresh receipt is durable'); END;
