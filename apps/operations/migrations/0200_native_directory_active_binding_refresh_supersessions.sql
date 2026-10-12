PRAGMA foreign_keys=ON;

-- A reconciled terminal conflict does not acknowledge or rewrite the frozen
-- command.  This child ledger admits exactly one non-recursive successor while
-- retaining the predecessor's uncertain dispatch and original authority.
CREATE TABLE native_directory_active_binding_refresh_supersessions (
  successor_command_id TEXT PRIMARY KEY CHECK(length(successor_command_id)=36),
  superseded_command_id TEXT NOT NULL UNIQUE REFERENCES native_directory_active_binding_refresh_commands(command_id),
  captured_attempts INTEGER NOT NULL CHECK(captured_attempts>0),
  reason TEXT NOT NULL CHECK(reason='remote_receipt_absent_generation_advanced'),
  reconciliation_request_id TEXT NOT NULL CHECK(length(reconciliation_request_id)=36),
  reconciliation_response_json TEXT NOT NULL CHECK(json_valid(reconciliation_response_json)),
  reconciliation_response_sha256 TEXT NOT NULL CHECK(length(reconciliation_response_sha256)=64),
  observed_resource_revision TEXT NOT NULL CHECK(observed_resource_revision NOT GLOB '*[^0-9]*' AND substr(observed_resource_revision,1,1) BETWEEN '1' AND '9'
    AND length(observed_resource_revision) BETWEEN 1 AND 19 AND (length(observed_resource_revision)<19 OR observed_resource_revision<='9223372036854775807')),
  observed_resource_projection_sha256 TEXT NOT NULL CHECK(length(observed_resource_projection_sha256)=64),
  observed_binding_revision TEXT NOT NULL CHECK(observed_binding_revision NOT GLOB '*[^0-9]*' AND substr(observed_binding_revision,1,1) BETWEEN '1' AND '9'
    AND length(observed_binding_revision) BETWEEN 1 AND 19 AND (length(observed_binding_revision)<19 OR observed_binding_revision<='9223372036854775807')),
  observed_binding_projection_sha256 TEXT NOT NULL CHECK(length(observed_binding_projection_sha256)=64),
  observed_authorization_generation TEXT NOT NULL CHECK(observed_authorization_generation NOT GLOB '*[^0-9]*'
    AND (observed_authorization_generation='0' OR substr(observed_authorization_generation,1,1) BETWEEN '1' AND '9')
    AND length(observed_authorization_generation) BETWEEN 1 AND 19 AND (length(observed_authorization_generation)<19 OR observed_authorization_generation<='9223372036854775806')),
  actor_id TEXT NOT NULL REFERENCES staff_users(id),
  access_subject TEXT NOT NULL,
  actor_login_email TEXT NOT NULL,
  admission_version INTEGER NOT NULL CHECK(admission_version>0),
  profile_version INTEGER NOT NULL CHECK(profile_version>0),
  grant_generation INTEGER NOT NULL CHECK(grant_generation>0),
  command_json TEXT NOT NULL CHECK(json_valid(command_json)),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(json_extract(command_json,'$.commandId')=successor_command_id
    AND json_extract(command_json,'$.expectedAuthorizationGeneration')=observed_authorization_generation
    AND json_remove(command_json,'$.commandId','$.externalId','$.expectedPriorRevision','$.expectedLiveRevision','$.expectedAuthorizationGeneration')='{}'),
  CHECK(json_remove(reconciliation_response_json,'$.sourceInstanceId','$.applicationId','$.historyEpoch','$.requestId','$.status','$.command','$.observation','$.acknowledgement')='{}'
    AND json_remove(json_extract(reconciliation_response_json,'$.command'),'$.commandId','$.requestSha256')='{}'
    AND json_remove(json_extract(reconciliation_response_json,'$.observation'),'$.resource','$.binding','$.authorizationGeneration')='{}'
    AND json_remove(json_extract(reconciliation_response_json,'$.observation.resource'),'$.type','$.id','$.revision','$.projectionSha256')='{}'
    AND json_remove(json_extract(reconciliation_response_json,'$.observation.binding'),'$.publicId','$.revision','$.projectionSha256')='{}')
);
CREATE TRIGGER native_directory_active_binding_refresh_supersessions_exact BEFORE INSERT ON native_directory_active_binding_refresh_supersessions
WHEN NOT EXISTS(
  SELECT 1 FROM native_directory_active_binding_refresh_commands c
  JOIN native_directory_active_binding_refresh_dispatch d ON d.command_id=c.command_id
  WHERE c.command_id=NEW.superseded_command_id AND d.state='uncertain' AND d.attempts=NEW.captured_attempts
    AND d.lease_token IS NULL AND d.lease_until IS NULL
    AND NOT EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_receipts r WHERE r.command_id=c.command_id)
    AND NEW.actor_id=c.actor_id AND NEW.access_subject=c.access_subject AND NEW.actor_login_email=c.actor_login_email
    AND NEW.observed_resource_revision=c.live_revision AND NEW.observed_resource_projection_sha256=c.projection_sha256
    AND NEW.observed_binding_revision=c.prior_revision
    AND CAST(NEW.observed_authorization_generation AS INTEGER)>CAST(c.authorization_generation AS INTEGER)
    AND json_extract(NEW.command_json,'$.externalId')=c.external_id
    AND json_extract(NEW.command_json,'$.expectedPriorRevision')=c.prior_revision
    AND json_extract(NEW.command_json,'$.expectedLiveRevision')=c.live_revision
    AND json_extract(NEW.reconciliation_response_json,'$.requestId')=NEW.reconciliation_request_id
    AND json_extract(NEW.reconciliation_response_json,'$.status')='terminal_conflict'
    AND json_type(NEW.reconciliation_response_json,'$.acknowledgement')='null'
    AND json_extract(NEW.reconciliation_response_json,'$.sourceInstanceId')=c.source_instance_id
    AND json_extract(NEW.reconciliation_response_json,'$.applicationId')=c.application_id
    AND json_extract(NEW.reconciliation_response_json,'$.historyEpoch')=c.history_epoch_id
    AND json_extract(NEW.reconciliation_response_json,'$.command.commandId')=c.command_id
    AND json_extract(NEW.reconciliation_response_json,'$.command.requestSha256')=c.request_sha256
    AND json_extract(NEW.reconciliation_response_json,'$.observation.resource.type')=c.resource_type
    AND json_extract(NEW.reconciliation_response_json,'$.observation.resource.id')=c.external_id
    AND json_extract(NEW.reconciliation_response_json,'$.observation.resource.revision')=NEW.observed_resource_revision
    AND json_extract(NEW.reconciliation_response_json,'$.observation.resource.projectionSha256')=NEW.observed_resource_projection_sha256
    AND json_extract(NEW.reconciliation_response_json,'$.observation.binding.publicId')=c.public_id
    AND json_extract(NEW.reconciliation_response_json,'$.observation.binding.revision')=NEW.observed_binding_revision
    AND json_extract(NEW.reconciliation_response_json,'$.observation.binding.projectionSha256')=NEW.observed_binding_projection_sha256
    AND json_extract(NEW.reconciliation_response_json,'$.observation.authorizationGeneration')=NEW.observed_authorization_generation
)
BEGIN SELECT RAISE(ABORT,'active binding refresh supersession is not exact'); END;
CREATE TRIGGER native_directory_active_binding_refresh_supersessions_no_update BEFORE UPDATE ON native_directory_active_binding_refresh_supersessions
BEGIN SELECT RAISE(ABORT,'active binding refresh supersession immutable'); END;
CREATE TRIGGER native_directory_active_binding_refresh_supersessions_no_delete BEFORE DELETE ON native_directory_active_binding_refresh_supersessions
BEGIN SELECT RAISE(ABORT,'active binding refresh supersession durable'); END;

CREATE TABLE native_directory_active_binding_refresh_successor_dispatch (
  command_id TEXT PRIMARY KEY REFERENCES native_directory_active_binding_refresh_supersessions(successor_command_id),
  state TEXT NOT NULL CHECK(state IN('pending','uncertain','leased','acknowledged')),
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TRIGGER native_directory_active_binding_refresh_successor_dispatch_identity BEFORE UPDATE ON native_directory_active_binding_refresh_successor_dispatch
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.attempts<OLD.attempts OR OLD.state='acknowledged'
  OR (NEW.state='leased' AND (OLD.state='leased' AND OLD.lease_until>unixepoch('now') OR NEW.attempts<>OLD.attempts+1))
  OR (NEW.state<>'leased' AND NEW.attempts<>OLD.attempts)
BEGIN SELECT RAISE(ABORT,'active binding refresh successor dispatch transition invalid'); END;
CREATE TRIGGER native_directory_active_binding_refresh_successor_dispatch_no_delete BEFORE DELETE ON native_directory_active_binding_refresh_successor_dispatch
BEGIN SELECT RAISE(ABORT,'active binding refresh successor dispatch durable'); END;

CREATE TABLE native_directory_active_binding_refresh_successor_receipts (
  command_id TEXT PRIMARY KEY REFERENCES native_directory_active_binding_refresh_supersessions(successor_command_id),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
  pa_request_id TEXT NOT NULL CHECK(length(pa_request_id)=36),
  authorization_generation TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_directory_active_binding_refresh_successor_receipts_exact BEFORE INSERT ON native_directory_active_binding_refresh_successor_receipts
WHEN NOT EXISTS(
  SELECT 1 FROM native_directory_active_binding_refresh_supersessions s
  JOIN native_directory_active_binding_refresh_commands c ON c.command_id=s.superseded_command_id
  JOIN native_directory_active_binding_refresh_successor_dispatch d ON d.command_id=s.successor_command_id AND d.state='leased'
  JOIN operations_directory_records r ON r.record_id=c.record_id AND r.current_version=c.local_version
  WHERE s.successor_command_id=NEW.command_id
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
    AND NEW.authorization_generation=CAST(CAST(s.observed_authorization_generation AS INTEGER)+1 AS TEXT)
)
BEGIN SELECT RAISE(ABORT,'active binding refresh successor receipt is not exact'); END;
CREATE TRIGGER native_directory_active_binding_refresh_successor_receipts_no_update BEFORE UPDATE ON native_directory_active_binding_refresh_successor_receipts
BEGIN SELECT RAISE(ABORT,'active binding refresh successor receipt immutable'); END;
CREATE TRIGGER native_directory_active_binding_refresh_successor_receipts_no_delete BEFORE DELETE ON native_directory_active_binding_refresh_successor_receipts
BEGIN SELECT RAISE(ABORT,'active binding refresh successor receipt durable'); END;
CREATE TRIGGER native_directory_active_binding_refresh_successor_dispatch_ack_receipt BEFORE UPDATE ON native_directory_active_binding_refresh_successor_dispatch
WHEN NEW.state='acknowledged' AND NOT EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_successor_receipts r WHERE r.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'active binding refresh successor acknowledgement requires receipt'); END;
