PRAGMA foreign_keys=ON;

-- Explicit active-record refresh. This does not reinterpret the acquired-only
-- 0118 ledger or mutate mappings, profiles, links, or inventory history.
CREATE TABLE native_directory_active_binding_refresh_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id),
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN('client','organization')),
  external_id TEXT NOT NULL,
  public_id TEXT NOT NULL CHECK(length(public_id)=32),
  mapping_kind TEXT NOT NULL CHECK(mapping_kind IN('legacy','acquired')),
  mapping_provenance_id TEXT NOT NULL,
  local_version INTEGER NOT NULL CHECK(local_version>0),
  acknowledged_command_id TEXT NOT NULL REFERENCES project_alpha_directory_outbox(command_id),
  acknowledged_command_json TEXT NOT NULL CHECK(json_valid(acknowledged_command_json)),
  acknowledged_outcome_json TEXT NOT NULL CHECK(json_valid(acknowledged_outcome_json)),
  destination_origin TEXT NOT NULL,
  prior_revision TEXT NOT NULL CHECK(prior_revision NOT GLOB '*[^0-9]*' AND substr(prior_revision,1,1) BETWEEN '1' AND '9'
    AND length(prior_revision) BETWEEN 1 AND 19 AND (length(prior_revision)<19 OR prior_revision<='9223372036854775807')),
  live_revision TEXT NOT NULL CHECK(live_revision NOT GLOB '*[^0-9]*' AND substr(live_revision,1,1) BETWEEN '1' AND '9'
    AND length(live_revision) BETWEEN 1 AND 19 AND (length(live_revision)<19 OR live_revision<='9223372036854775807')
    AND (length(live_revision)>length(prior_revision) OR length(live_revision)=length(prior_revision) AND live_revision>prior_revision)),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64),
  authorization_generation TEXT NOT NULL CHECK(authorization_generation NOT GLOB '*[^0-9]*'
    AND (authorization_generation='0' OR substr(authorization_generation,1,1) BETWEEN '1' AND '9')
    AND length(authorization_generation) BETWEEN 1 AND 19 AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775806')),
  actor_id TEXT NOT NULL REFERENCES staff_users(id),
  access_subject TEXT NOT NULL,
  actor_login_email TEXT NOT NULL,
  admission_version INTEGER NOT NULL CHECK(admission_version>0),
  profile_version INTEGER NOT NULL CHECK(profile_version>0),
  grant_generation INTEGER NOT NULL CHECK(grant_generation>0),
  command_json TEXT NOT NULL CHECK(json_valid(command_json)),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(record_id,source_id,source_instance_id,application_id,history_epoch_id,local_version,prior_revision),
  CHECK(json_extract(command_json,'$.commandId')=command_id
    AND json_extract(command_json,'$.externalId')=external_id
    AND json_extract(command_json,'$.expectedPriorRevision')=prior_revision
    AND json_extract(command_json,'$.expectedLiveRevision')=live_revision
    AND json_extract(command_json,'$.expectedAuthorizationGeneration')=authorization_generation
    AND json_remove(command_json,'$.commandId','$.externalId','$.expectedPriorRevision','$.expectedLiveRevision','$.expectedAuthorizationGeneration')='{}')
);
CREATE TRIGGER native_directory_active_binding_refresh_commands_no_update BEFORE UPDATE ON native_directory_active_binding_refresh_commands
BEGIN SELECT RAISE(ABORT,'active binding refresh command immutable'); END;
CREATE TRIGGER native_directory_active_binding_refresh_commands_no_delete BEFORE DELETE ON native_directory_active_binding_refresh_commands
BEGIN SELECT RAISE(ABORT,'active binding refresh command durable'); END;

CREATE TABLE native_directory_active_binding_refresh_dispatch (
  command_id TEXT PRIMARY KEY REFERENCES native_directory_active_binding_refresh_commands(command_id),
  state TEXT NOT NULL CHECK(state IN('pending','uncertain','leased','acknowledged')),
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TRIGGER native_directory_active_binding_refresh_dispatch_identity BEFORE UPDATE ON native_directory_active_binding_refresh_dispatch
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.attempts<OLD.attempts
  OR OLD.state='acknowledged'
  OR (NEW.state='leased' AND (OLD.state='leased' AND OLD.lease_until>unixepoch('now') OR NEW.attempts<>OLD.attempts+1))
  OR (NEW.state<>'leased' AND NEW.attempts<>OLD.attempts)
BEGIN SELECT RAISE(ABORT,'active binding refresh dispatch transition invalid'); END;
CREATE TRIGGER native_directory_active_binding_refresh_dispatch_no_delete BEFORE DELETE ON native_directory_active_binding_refresh_dispatch
BEGIN SELECT RAISE(ABORT,'active binding refresh dispatch durable'); END;
CREATE TRIGGER native_directory_active_binding_refresh_commands_pending BEFORE INSERT ON native_directory_active_binding_refresh_commands
WHEN EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_commands c JOIN native_directory_active_binding_refresh_dispatch d
  ON d.command_id=c.command_id AND d.state<>'acknowledged'
  WHERE c.record_id=NEW.record_id AND c.source_id=NEW.source_id AND c.source_instance_id=NEW.source_instance_id
    AND c.application_id=NEW.application_id AND c.history_epoch_id=NEW.history_epoch_id AND c.local_version=NEW.local_version)
BEGIN SELECT RAISE(ABORT,'active binding refresh has frozen pending command'); END;

CREATE TABLE native_directory_active_binding_refresh_receipts (
  command_id TEXT PRIMARY KEY REFERENCES native_directory_active_binding_refresh_commands(command_id),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
  pa_request_id TEXT NOT NULL CHECK(length(pa_request_id)=36),
  authorization_generation TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_directory_active_binding_refresh_receipts_exact BEFORE INSERT ON native_directory_active_binding_refresh_receipts
WHEN NOT EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_commands c
  JOIN native_directory_active_binding_refresh_dispatch d ON d.command_id=c.command_id AND d.state='leased'
  JOIN operations_directory_records r ON r.record_id=c.record_id AND r.current_version=c.local_version
  WHERE c.command_id=NEW.command_id
    AND json_extract(NEW.response_json,'$.sourceInstanceId')=c.source_instance_id
    AND json_extract(NEW.response_json,'$.applicationId')=c.application_id
    AND json_extract(NEW.response_json,'$.historyEpoch')=c.history_epoch_id
    AND json_extract(NEW.response_json,'$.requestId')=NEW.pa_request_id
    AND json_extract(NEW.response_json,'$.result.resource.type')=c.resource_type
    AND json_extract(NEW.response_json,'$.result.resource.id')=c.external_id
    AND json_extract(NEW.response_json,'$.result.resource.revision')=c.live_revision
    AND json_extract(NEW.response_json,'$.result.binding.publicId')=c.public_id
    AND json_extract(NEW.response_json,'$.result.binding.previousRevision')=c.prior_revision
    AND json_extract(NEW.response_json,'$.result.binding.authorizationGeneration')=NEW.authorization_generation
    AND NEW.authorization_generation=CAST(CAST(c.authorization_generation AS INTEGER)+1 AS TEXT))
BEGIN SELECT RAISE(ABORT,'active binding refresh receipt is not exact'); END;
CREATE TRIGGER native_directory_active_binding_refresh_receipts_no_update BEFORE UPDATE ON native_directory_active_binding_refresh_receipts
BEGIN SELECT RAISE(ABORT,'active binding refresh receipt immutable'); END;
CREATE TRIGGER native_directory_active_binding_refresh_receipts_no_delete BEFORE DELETE ON native_directory_active_binding_refresh_receipts
BEGIN SELECT RAISE(ABORT,'active binding refresh receipt durable'); END;
CREATE TRIGGER native_directory_active_binding_refresh_dispatch_ack_receipt BEFORE UPDATE ON native_directory_active_binding_refresh_dispatch
WHEN NEW.state='acknowledged' AND NOT EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_receipts r WHERE r.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'active binding refresh acknowledgement requires receipt'); END;

-- Transaction-local assertions; failure rolls back the entire D1 batch.
CREATE TABLE native_directory_active_binding_refresh_guards (
  guard_id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1)
);
