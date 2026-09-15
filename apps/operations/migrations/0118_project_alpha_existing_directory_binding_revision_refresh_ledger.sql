PRAGMA foreign_keys = ON;

-- Dormant, append-only evidence for a future PA binding-revision refresh.
-- Nothing reads these tables for routing, materialization, authorization, or
-- public-link resolution.  In particular, 0054/0065 legacy mappings and the
-- immutable 0111--0117 acquisition/canonical receipts remain untouched.
CREATE TABLE project_alpha_existing_directory_binding_revision_refresh_commands (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id)=36 AND command_id=lower(command_id) AND command_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(command_id,9,1)='-' AND substr(command_id,14,1)='-' AND substr(command_id,15,1)='4'
    AND substr(command_id,19,1)='-' AND substr(command_id,20,1) IN ('8','9','a','b') AND substr(command_id,24,1)='-' AND length(replace(command_id,'-',''))=32),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  predecessor_kind TEXT NOT NULL CHECK(predecessor_kind IN ('acquired_mapping','revision_refresh')),
  predecessor_acquired_receipt_id TEXT UNIQUE REFERENCES project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id) ON DELETE RESTRICT,
  predecessor_refresh_receipt_id TEXT UNIQUE REFERENCES project_alpha_existing_directory_binding_revision_refresh_receipts(receipt_id) ON DELETE RESTRICT,
  native_owner_claim_id TEXT NOT NULL REFERENCES project_alpha_acquired_native_owner_claims(claim_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL CHECK(length(record_id) BETWEEN 1 AND 191 AND instr(record_id,char(0))=0),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128 AND instr(source_id,char(0))=0),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 191 AND length(CAST(external_id AS BLOB))<=764 AND instr(external_id,char(0))=0),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  expected_prior_revision TEXT NOT NULL CHECK(length(expected_prior_revision) BETWEEN 1 AND 19 AND expected_prior_revision NOT GLOB '*[^0-9]*' AND substr(expected_prior_revision,1,1)<>'0' AND (length(expected_prior_revision)<19 OR expected_prior_revision<='9223372036854775807')),
  expected_live_revision TEXT NOT NULL CHECK(length(expected_live_revision) BETWEEN 1 AND 19 AND expected_live_revision NOT GLOB '*[^0-9]*' AND substr(expected_live_revision,1,1)<>'0' AND (length(expected_live_revision)<19 OR expected_live_revision<='9223372036854775807') AND CAST(expected_live_revision AS INTEGER)>CAST(expected_prior_revision AS INTEGER)),
  expected_authorization_generation TEXT NOT NULL CHECK(length(expected_authorization_generation) BETWEEN 1 AND 19 AND expected_authorization_generation NOT GLOB '*[^0-9]*' AND substr(expected_authorization_generation,1,1)<>'0' AND (length(expected_authorization_generation)<19 OR expected_authorization_generation<='9223372036854775806')),
  expected_local_record_version INTEGER NOT NULL CHECK(typeof(expected_local_record_version)='integer' AND expected_local_record_version>=1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((predecessor_kind='acquired_mapping' AND predecessor_acquired_receipt_id IS NOT NULL AND predecessor_refresh_receipt_id IS NULL)
     OR (predecessor_kind='revision_refresh' AND predecessor_acquired_receipt_id IS NULL AND predecessor_refresh_receipt_id IS NOT NULL))
);

CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_commands_acquired_predecessor
BEFORE INSERT ON project_alpha_existing_directory_binding_revision_refresh_commands
WHEN NEW.predecessor_kind='acquired_mapping' AND NOT EXISTS(
  SELECT 1 FROM project_alpha_acquired_native_owner_claims claim
  JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=claim.receipt_id
  JOIN operations_directory_records record ON record.record_id=claim.record_id
  WHERE claim.claim_id=NEW.native_owner_claim_id AND claim.record_id=NEW.record_id
    AND claim.source_id=NEW.source_id AND claim.source_instance_id=NEW.source_instance_id
    AND claim.application_id=NEW.application_id AND claim.history_epoch_id=NEW.history_epoch_id
    AND claim.resource_type=NEW.resource_type AND claim.external_id=NEW.external_id
    AND claim.project_alpha_public_id=NEW.project_alpha_public_id
    AND claim.expected_local_record_version=NEW.expected_local_record_version
    AND record.record_kind=NEW.resource_type AND record.current_version=NEW.expected_local_record_version
    AND mapping.activation_state='inactive'
    AND EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquired_mapping_receipts predecessor
      WHERE predecessor.receipt_id=NEW.predecessor_acquired_receipt_id AND predecessor.receipt_id=claim.receipt_id
        AND predecessor.project_alpha_revision=NEW.expected_prior_revision)
)
BEGIN SELECT RAISE(ABORT,'binding revision refresh command requires current exact predecessor chain'); END;

CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_commands_refresh_predecessor
BEFORE INSERT ON project_alpha_existing_directory_binding_revision_refresh_commands
WHEN NEW.predecessor_kind='revision_refresh' AND NOT EXISTS(
  SELECT 1 FROM project_alpha_acquired_native_owner_claims claim
  JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=claim.receipt_id
  JOIN operations_directory_records record ON record.record_id=claim.record_id
  JOIN project_alpha_existing_directory_binding_revision_refresh_receipts predecessor
    ON predecessor.receipt_id=NEW.predecessor_refresh_receipt_id
  WHERE claim.claim_id=NEW.native_owner_claim_id AND claim.record_id=NEW.record_id
    AND claim.source_id=NEW.source_id AND claim.source_instance_id=NEW.source_instance_id
    AND claim.application_id=NEW.application_id AND claim.history_epoch_id=NEW.history_epoch_id
    AND claim.resource_type=NEW.resource_type AND claim.external_id=NEW.external_id
    AND claim.project_alpha_public_id=NEW.project_alpha_public_id
    AND claim.expected_local_record_version=NEW.expected_local_record_version
    AND record.record_kind=NEW.resource_type AND record.current_version=NEW.expected_local_record_version
    AND mapping.activation_state='inactive' AND predecessor.native_owner_claim_id=claim.claim_id
    AND predecessor.record_id=NEW.record_id AND predecessor.source_id=NEW.source_id
    AND predecessor.source_instance_id=NEW.source_instance_id AND predecessor.application_id=NEW.application_id
    AND predecessor.history_epoch_id=NEW.history_epoch_id AND predecessor.resource_type=NEW.resource_type
    AND predecessor.external_id=NEW.external_id AND predecessor.project_alpha_public_id=NEW.project_alpha_public_id
    AND predecessor.live_revision=NEW.expected_prior_revision
    AND predecessor.local_record_version=NEW.expected_local_record_version
)
BEGIN SELECT RAISE(ABORT,'binding revision refresh command requires current exact predecessor chain'); END;

-- Legacy mappings remain collision evidence and cannot be retrofitted into
-- this refresh path, even when their identity appears to match.
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_commands_legacy_collision
BEFORE INSERT ON project_alpha_existing_directory_binding_revision_refresh_commands
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_mappings legacy
  WHERE legacy.source_id=NEW.source_id AND legacy.source_instance_id=NEW.source_instance_id
    AND legacy.application_id=NEW.application_id AND legacy.resource_type=NEW.resource_type
    AND (legacy.external_id=NEW.external_id OR legacy.project_alpha_public_id=NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'binding revision refresh conflicts with legacy mapping'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_commands_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_revision_refresh_commands
BEGIN SELECT RAISE(ABORT,'binding revision refresh command is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_commands_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_revision_refresh_commands
BEGIN SELECT RAISE(ABORT,'binding revision refresh command is durable'); END;

CREATE TABLE project_alpha_existing_directory_binding_revision_refresh_events (
  command_id TEXT NOT NULL REFERENCES project_alpha_existing_directory_binding_revision_refresh_commands(command_id) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK(typeof(state_version)='integer' AND state_version>=1),
  transition_id TEXT NOT NULL UNIQUE CHECK(length(transition_id)=36 AND transition_id=lower(transition_id) AND transition_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(transition_id,9,1)='-' AND substr(transition_id,14,1)='-' AND substr(transition_id,15,1)='4'
    AND substr(transition_id,19,1)='-' AND substr(transition_id,20,1) IN ('8','9','a','b') AND substr(transition_id,24,1)='-' AND length(replace(transition_id,'-',''))=32),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','uncertain','acknowledged')),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(command_id,state_version)
);
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_events_fence
BEFORE INSERT ON project_alpha_existing_directory_binding_revision_refresh_events
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_revision_refresh_commands command
    WHERE command.command_id=NEW.command_id AND command.request_sha256=NEW.request_sha256)
  OR (NEW.state_version=1 AND NEW.state<>'pending')
  OR (NEW.state_version>1 AND NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_revision_refresh_events prior
    WHERE prior.command_id=NEW.command_id AND prior.state_version=NEW.state_version-1
      AND ((prior.state='pending' AND NEW.state IN ('uncertain','acknowledged')) OR (prior.state='uncertain' AND NEW.state='acknowledged'))))
BEGIN SELECT RAISE(ABORT,'binding revision refresh transition is invalid'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_events_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_revision_refresh_events
BEGIN SELECT RAISE(ABORT,'binding revision refresh event is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_events_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_revision_refresh_events
BEGIN SELECT RAISE(ABORT,'binding revision refresh event is durable'); END;

-- A success receipt records the exact PA result, but deliberately does not
-- mutate any canonical mapping, owner claim, activation row, or public link.
CREATE TABLE project_alpha_existing_directory_binding_revision_refresh_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY CHECK(length(receipt_id)=36 AND receipt_id=lower(receipt_id) AND receipt_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(receipt_id,9,1)='-' AND substr(receipt_id,14,1)='-' AND substr(receipt_id,15,1)='4'
    AND substr(receipt_id,19,1)='-' AND substr(receipt_id,20,1) IN ('8','9','a','b') AND substr(receipt_id,24,1)='-' AND length(replace(receipt_id,'-',''))=32),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_existing_directory_binding_revision_refresh_commands(command_id) ON DELETE RESTRICT,
  native_owner_claim_id TEXT NOT NULL REFERENCES project_alpha_acquired_native_owner_claims(claim_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL, source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL, history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')), external_id TEXT NOT NULL, project_alpha_public_id TEXT NOT NULL,
  prior_revision TEXT NOT NULL, live_revision TEXT NOT NULL,
  authorization_generation TEXT NOT NULL CHECK(length(authorization_generation) BETWEEN 1 AND 19 AND authorization_generation NOT GLOB '*[^0-9]*' AND substr(authorization_generation,1,1)<>'0' AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775807')),
  local_record_version INTEGER NOT NULL CHECK(typeof(local_record_version)='integer' AND local_record_version>=1),
  pa_request_id TEXT NOT NULL CHECK(length(pa_request_id)=36), pa_replayed INTEGER NOT NULL CHECK(pa_replayed IN (0,1)),
  response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64 AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(received_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',received_at)=received_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_receipts_exact_command
BEFORE INSERT ON project_alpha_existing_directory_binding_revision_refresh_receipts
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_revision_refresh_commands command
  JOIN operations_directory_records record ON record.record_id=command.record_id
  WHERE command.command_id=NEW.command_id AND command.request_sha256=NEW.request_sha256
    AND command.native_owner_claim_id=NEW.native_owner_claim_id
    AND command.record_id=NEW.record_id AND command.source_id=NEW.source_id
    AND command.source_instance_id=NEW.source_instance_id AND command.application_id=NEW.application_id
    AND command.history_epoch_id=NEW.history_epoch_id AND command.resource_type=NEW.resource_type
    AND command.external_id=NEW.external_id AND command.project_alpha_public_id=NEW.project_alpha_public_id
    AND command.expected_prior_revision=NEW.prior_revision AND command.expected_live_revision=NEW.live_revision
    AND command.expected_local_record_version=NEW.local_record_version AND record.record_kind=NEW.resource_type
    AND record.current_version=NEW.local_record_version
    AND CAST(NEW.authorization_generation AS INTEGER)=CAST(command.expected_authorization_generation AS INTEGER)+1
    AND EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_revision_refresh_events event
      WHERE event.command_id=command.command_id AND event.state='acknowledged'))
BEGIN SELECT RAISE(ABORT,'binding revision refresh receipt requires current acknowledged exact command'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_receipts_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_revision_refresh_receipts
BEGIN SELECT RAISE(ABORT,'binding revision refresh receipt is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_revision_refresh_receipts_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_revision_refresh_receipts
BEGIN SELECT RAISE(ABORT,'binding revision refresh receipt is durable'); END;
