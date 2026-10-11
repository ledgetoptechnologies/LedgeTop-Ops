PRAGMA foreign_keys=ON;

-- One immutable continuation per destination-specific, acknowledged update.
CREATE TABLE native_directory_profile_binding_jobs (
  command_id TEXT PRIMARY KEY REFERENCES project_alpha_directory_outbox(command_id),
  intent_id TEXT NOT NULL REFERENCES operations_directory_intents(intent_id),
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id),
  local_version INTEGER NOT NULL CHECK(local_version>0),
  source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL, destination_origin TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN('client','organization')),
  external_id TEXT NOT NULL, public_id TEXT NOT NULL CHECK(length(public_id)=32),
  mapping_kind TEXT NOT NULL CHECK(mapping_kind IN('legacy','acquired')), mapping_provenance_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, access_subject TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  acknowledged_command_json TEXT NOT NULL CHECK(json_valid(acknowledged_command_json)),
  acknowledged_outcome_json TEXT NOT NULL CHECK(json_valid(acknowledged_outcome_json)),
  authorization_generation TEXT NOT NULL CHECK(length(authorization_generation) BETWEEN 1 AND 19
    AND authorization_generation NOT GLOB '*[^0-9]*' AND (authorization_generation='0' OR substr(authorization_generation,1,1) BETWEEN '1' AND '9')
    AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775807')),
  live_revision TEXT NOT NULL CHECK(length(live_revision) BETWEEN 1 AND 19
    AND live_revision NOT GLOB '*[^0-9]*' AND substr(live_revision,1,1) BETWEEN '1' AND '9'
    AND (length(live_revision)<19 OR live_revision<='9223372036854775807')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE native_directory_profile_binding_dispatch (
  command_id TEXT PRIMARY KEY REFERENCES native_directory_profile_binding_jobs(command_id),
  state TEXT NOT NULL CHECK(state IN('pending','leased','uncertain','conflict','complete')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_token TEXT, lease_expires_at INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  inventory_cursor TEXT,
  inventory_generation TEXT,
  reason TEXT,
  CHECK((inventory_cursor IS NULL)=(inventory_generation IS NULL)),
  CHECK(inventory_cursor IS NULL OR
    (substr(inventory_cursor,1,7)='client:' AND length(inventory_cursor)=39 AND substr(inventory_cursor,8) NOT GLOB '*[^0-9a-f]*')
    OR (substr(inventory_cursor,1,13)='organization:' AND length(inventory_cursor)=45 AND substr(inventory_cursor,14) NOT GLOB '*[^0-9a-f]*')),
  CHECK(inventory_generation IS NULL OR (length(inventory_generation) BETWEEN 1 AND 19
    AND inventory_generation NOT GLOB '*[^0-9]*' AND (inventory_generation='0' OR substr(inventory_generation,1,1) BETWEEN '1' AND '9')
    AND (length(inventory_generation)<19 OR inventory_generation<='9223372036854775807'))),
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE native_directory_profile_binding_commands (
  job_command_id TEXT PRIMARY KEY REFERENCES native_directory_profile_binding_jobs(command_id),
  refresh_command_id TEXT NOT NULL UNIQUE CHECK(length(refresh_command_id)=36),
  command_json TEXT NOT NULL CHECK(json_valid(command_json)),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  prior_revision TEXT NOT NULL CHECK(length(prior_revision) BETWEEN 1 AND 19 AND prior_revision NOT GLOB '*[^0-9]*'
    AND substr(prior_revision,1,1) BETWEEN '1' AND '9' AND (length(prior_revision)<19 OR prior_revision<='9223372036854775807')),
  live_revision TEXT NOT NULL,
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64),
  authorization_generation TEXT NOT NULL CHECK(length(authorization_generation) BETWEEN 1 AND 19
    AND authorization_generation NOT GLOB '*[^0-9]*'
    AND (authorization_generation='0' OR substr(authorization_generation,1,1) BETWEEN '1' AND '9')
    AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775806')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(length(live_revision) BETWEEN 1 AND 19 AND live_revision NOT GLOB '*[^0-9]*'
    AND substr(live_revision,1,1) BETWEEN '1' AND '9' AND (length(live_revision)<19 OR live_revision<='9223372036854775807')
    AND (length(live_revision)>length(prior_revision) OR length(live_revision)=length(prior_revision) AND live_revision>prior_revision)),
  CHECK(json_type(command_json,'$.commandId')='text' AND json_extract(command_json,'$.commandId')=refresh_command_id
    AND json_type(command_json,'$.externalId')='text'
    AND json_type(command_json,'$.expectedPriorRevision')='text' AND json_extract(command_json,'$.expectedPriorRevision')=prior_revision
    AND json_type(command_json,'$.expectedLiveRevision')='text' AND json_extract(command_json,'$.expectedLiveRevision')=live_revision
    AND json_type(command_json,'$.expectedAuthorizationGeneration')='text'
    AND json_extract(command_json,'$.expectedAuthorizationGeneration')=authorization_generation
    AND json_remove(command_json,'$.commandId','$.externalId','$.expectedPriorRevision','$.expectedLiveRevision','$.expectedAuthorizationGeneration')='{}')
);
CREATE TABLE native_directory_profile_binding_receipts (
  job_command_id TEXT PRIMARY KEY REFERENCES native_directory_profile_binding_commands(job_command_id),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
  pa_request_id TEXT NOT NULL CHECK(length(pa_request_id)=36),
  authorization_generation TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE native_directory_profile_binding_guards (
  guard_id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1)
);
CREATE INDEX native_directory_profile_binding_dispatch_eligible ON native_directory_profile_binding_dispatch(state,next_attempt_at,lease_expires_at);

CREATE TRIGGER native_directory_profile_binding_dispatch_complete BEFORE UPDATE OF state ON native_directory_profile_binding_dispatch
WHEN NEW.state='complete' AND NOT EXISTS(
  SELECT 1 FROM native_directory_profile_binding_jobs c
  JOIN operations_directory_records record ON record.record_id=c.record_id AND record.record_kind=c.resource_type AND record.current_version=c.local_version
  JOIN project_alpha_active_directory_mappings m ON m.record_id=c.record_id AND m.source_id=c.source_id
    AND m.source_instance_id=c.source_instance_id AND m.application_id=c.application_id AND m.history_epoch_id=c.history_epoch_id
    AND m.resource_type=c.resource_type AND m.external_id=c.external_id AND m.project_alpha_public_id=c.public_id
    AND m.mapping_kind=c.mapping_kind AND m.provenance_id=c.mapping_provenance_id
  JOIN project_alpha_api_v2_directory_observations_current o ON o.source_id=c.source_id AND o.source_instance_id=c.source_instance_id
    AND o.application_id=c.application_id AND o.history_epoch_id=c.history_epoch_id AND o.resource_type=c.resource_type
    AND o.project_alpha_public_id=c.public_id AND o.resource_revision=c.live_revision
    AND o.present=1 AND o.last_action='upsert' AND o.has_conflict=0 AND o.binding_status='active'
    AND o.binding_external_id=c.external_id AND o.binding_resource_revision=c.live_revision
  JOIN project_alpha_api_v2_inventory_receipts r ON r.source_id=o.source_id AND r.source_instance_id=o.source_instance_id
    AND r.application_id=o.application_id AND r.history_epoch_id=o.history_epoch_id AND r.inventory_kind='directory' AND r.request_id=o.request_id
  WHERE c.command_id=NEW.command_id
    AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts newer
      WHERE newer.source_id=r.source_id AND newer.source_instance_id=r.source_instance_id
        AND newer.application_id=r.application_id AND newer.history_epoch_id=r.history_epoch_id AND newer.inventory_kind='directory'
        AND (length(newer.authorization_generation)>length(r.authorization_generation)
          OR length(newer.authorization_generation)=length(r.authorization_generation) AND newer.authorization_generation>r.authorization_generation))
    AND (SELECT count(*) FROM project_alpha_active_directory_mappings other WHERE other.source_id=c.source_id
      AND other.source_instance_id=c.source_instance_id AND other.application_id=c.application_id AND other.history_epoch_id=c.history_epoch_id
      AND other.resource_type=c.resource_type AND (other.record_id=c.record_id OR other.external_id=c.external_id OR other.project_alpha_public_id=c.public_id))=1
    AND ((NOT EXISTS(SELECT 1 FROM native_directory_profile_binding_commands f WHERE f.job_command_id=c.command_id)
        AND (length(r.authorization_generation)>length(c.authorization_generation)
          OR length(r.authorization_generation)=length(c.authorization_generation) AND r.authorization_generation>=c.authorization_generation))
      OR EXISTS(SELECT 1 FROM native_directory_profile_binding_commands f
        JOIN native_directory_profile_binding_receipts receipt ON receipt.job_command_id=f.job_command_id
        WHERE f.job_command_id=c.command_id AND o.projection_sha256=f.projection_sha256
          AND r.authorization_generation=CAST(CAST(f.authorization_generation AS INTEGER)+1 AS TEXT)
          AND receipt.authorization_generation=r.authorization_generation)))
BEGIN SELECT RAISE(ABORT,'profile binding completion requires canonical aligned inventory'); END;

CREATE TRIGGER native_directory_profile_binding_jobs_no_update BEFORE UPDATE ON native_directory_profile_binding_jobs
BEGIN SELECT RAISE(ABORT,'profile binding continuation immutable'); END;
CREATE TRIGGER native_directory_profile_binding_jobs_no_delete BEFORE DELETE ON native_directory_profile_binding_jobs
BEGIN SELECT RAISE(ABORT,'profile binding continuation durable'); END;
CREATE TRIGGER native_directory_profile_binding_jobs_exact BEFORE INSERT ON native_directory_profile_binding_jobs
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox o
  JOIN operations_directory_effective_materializations x ON x.command_id=o.command_id AND x.command_json=o.command_json
  JOIN operations_directory_intents i ON i.intent_id=x.intent_id AND i.record_id=NEW.record_id AND i.record_version=NEW.local_version
  JOIN operations_directory_audit a ON a.mutation_id=i.mutation_id AND a.record_id=i.record_id AND a.record_version=i.record_version
  JOIN project_alpha_active_directory_mappings m ON m.record_id=NEW.record_id AND m.source_id=NEW.source_id
    AND m.source_instance_id=NEW.source_instance_id AND m.application_id=NEW.application_id AND m.history_epoch_id=NEW.history_epoch_id
    AND m.resource_type=NEW.resource_type AND m.external_id=NEW.external_id AND m.project_alpha_public_id=NEW.public_id
    AND m.mapping_kind=NEW.mapping_kind AND m.provenance_id=NEW.mapping_provenance_id
  WHERE o.command_id=NEW.command_id AND o.state='acknowledged' AND i.intent_id=NEW.intent_id
    AND o.command_json=NEW.acknowledged_command_json AND o.outcome_json=NEW.acknowledged_outcome_json
    AND o.source_id=NEW.source_id AND o.expected_source_instance_id=NEW.source_instance_id AND o.application_id=NEW.application_id
    AND o.expected_history_epoch_id=NEW.history_epoch_id AND o.destination_base_url=NEW.destination_origin
    AND o.resource_type=NEW.resource_type AND o.external_id=NEW.external_id
    AND json_extract(o.command_json,'$.operation')='update'
    AND json_type(o.outcome_json,'$.response.result.resource.revision')='text'
    AND json_extract(o.outcome_json,'$.response.result.resource.revision')=NEW.live_revision
    AND json_type(o.outcome_json,'$.response.result.authorizationGeneration')='text'
    AND json_extract(o.outcome_json,'$.response.result.authorizationGeneration')=NEW.authorization_generation
    AND a.actor_id=NEW.actor_id AND a.original_verified_access_subject=NEW.access_subject
    AND json_extract(a.command_json,'$.actor')=NEW.actor_json)
BEGIN SELECT RAISE(ABORT,'profile binding continuation not exact'); END;
CREATE TRIGGER native_directory_profile_binding_commands_no_update BEFORE UPDATE ON native_directory_profile_binding_commands
BEGIN SELECT RAISE(ABORT,'profile binding continuation command immutable'); END;
CREATE TRIGGER native_directory_profile_binding_commands_no_delete BEFORE DELETE ON native_directory_profile_binding_commands
BEGIN SELECT RAISE(ABORT,'profile binding continuation command durable'); END;
CREATE TRIGGER native_directory_profile_binding_receipts_no_update BEFORE UPDATE ON native_directory_profile_binding_receipts
BEGIN SELECT RAISE(ABORT,'profile binding continuation receipt immutable'); END;
CREATE TRIGGER native_directory_profile_binding_receipts_no_delete BEFORE DELETE ON native_directory_profile_binding_receipts
BEGIN SELECT RAISE(ABORT,'profile binding continuation receipt durable'); END;
CREATE TRIGGER native_directory_profile_binding_dispatch_no_delete BEFORE DELETE ON native_directory_profile_binding_dispatch
BEGIN SELECT RAISE(ABORT,'profile binding continuation dispatch durable'); END;
CREATE TRIGGER native_directory_profile_binding_dispatch_transition BEFORE UPDATE ON native_directory_profile_binding_dispatch
WHEN NEW.command_id IS NOT OLD.command_id OR OLD.state IN('complete','conflict') OR NEW.attempts<OLD.attempts
  OR (NEW.state='leased'
    AND NOT (OLD.state='leased' AND NEW.attempts=OLD.attempts AND NEW.lease_token IS OLD.lease_token
      AND NEW.lease_expires_at IS OLD.lease_expires_at AND NEW.next_attempt_at IS OLD.next_attempt_at AND NEW.reason IS OLD.reason
      AND OLD.lease_expires_at>CAST(unixepoch('now') AS INTEGER)*1000
      AND (NEW.inventory_cursor IS NOT OLD.inventory_cursor OR NEW.inventory_generation IS NOT OLD.inventory_generation))
    AND (NEW.attempts<>OLD.attempts+1 OR OLD.state='leased' AND OLD.lease_expires_at>CAST(unixepoch('now') AS INTEGER)*1000))
  OR (NEW.state<>'leased' AND NEW.attempts<>OLD.attempts)
BEGIN SELECT RAISE(ABORT,'profile binding continuation dispatch transition invalid'); END;
CREATE TRIGGER native_directory_profile_binding_dispatch_progress BEFORE UPDATE ON native_directory_profile_binding_dispatch
WHEN (NEW.inventory_cursor IS NOT OLD.inventory_cursor OR NEW.inventory_generation IS NOT OLD.inventory_generation)
  AND NOT (OLD.state='leased' AND NEW.state='leased' AND NEW.lease_token IS OLD.lease_token
    AND NEW.lease_expires_at IS OLD.lease_expires_at AND NEW.attempts=OLD.attempts
    AND NEW.next_attempt_at IS OLD.next_attempt_at AND NEW.reason IS OLD.reason
    AND OLD.lease_expires_at>CAST(unixepoch('now') AS INTEGER)*1000)
BEGIN SELECT RAISE(ABORT,'profile binding inventory progress requires current lease'); END;
CREATE TRIGGER native_directory_profile_binding_dispatch_cursor_type_insert BEFORE INSERT ON native_directory_profile_binding_dispatch
WHEN NEW.inventory_cursor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM native_directory_profile_binding_jobs c
  JOIN project_alpha_api_v2_inventory_receipts r ON r.source_id=c.source_id AND r.source_instance_id=c.source_instance_id
    AND r.application_id=c.application_id AND r.history_epoch_id=c.history_epoch_id AND r.inventory_kind='directory'
    AND r.authorization_generation=NEW.inventory_generation AND r.next_cursor=NEW.inventory_cursor
  WHERE c.command_id=NEW.command_id AND substr(NEW.inventory_cursor,1,length(c.resource_type)+1)=c.resource_type||':')
BEGIN SELECT RAISE(ABORT,'profile binding inventory cursor requires canonical receipt'); END;
CREATE TRIGGER native_directory_profile_binding_dispatch_cursor_type_update BEFORE UPDATE ON native_directory_profile_binding_dispatch
WHEN NEW.inventory_cursor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM native_directory_profile_binding_jobs c
  JOIN project_alpha_api_v2_inventory_receipts r ON r.source_id=c.source_id AND r.source_instance_id=c.source_instance_id
    AND r.application_id=c.application_id AND r.history_epoch_id=c.history_epoch_id AND r.inventory_kind='directory'
    AND r.authorization_generation=NEW.inventory_generation AND r.next_cursor=NEW.inventory_cursor
  WHERE c.command_id=NEW.command_id AND substr(NEW.inventory_cursor,1,length(c.resource_type)+1)=c.resource_type||':')
BEGIN SELECT RAISE(ABORT,'profile binding inventory cursor requires canonical receipt'); END;

CREATE TRIGGER native_directory_profile_binding_continuation_command_exact BEFORE INSERT ON native_directory_profile_binding_commands
WHEN NOT EXISTS(SELECT 1 FROM native_directory_profile_binding_jobs c
  JOIN operations_directory_records record ON record.record_id=c.record_id AND record.record_kind=c.resource_type AND record.current_version=c.local_version
  JOIN project_alpha_active_directory_mappings m ON m.record_id=c.record_id AND m.source_id=c.source_id
    AND m.source_instance_id=c.source_instance_id AND m.application_id=c.application_id AND m.history_epoch_id=c.history_epoch_id
    AND m.resource_type=c.resource_type AND m.external_id=c.external_id AND m.project_alpha_public_id=c.public_id
    AND m.mapping_kind=c.mapping_kind AND m.provenance_id=c.mapping_provenance_id
  JOIN project_alpha_api_v2_directory_observations_current o ON o.source_id=c.source_id AND o.source_instance_id=c.source_instance_id
    AND o.application_id=c.application_id AND o.history_epoch_id=c.history_epoch_id AND o.resource_type=c.resource_type
    AND o.project_alpha_public_id=c.public_id AND o.resource_revision=c.live_revision
    AND o.present=1 AND o.last_action='upsert' AND o.has_conflict=0 AND o.binding_status='active'
    AND o.binding_external_id=c.external_id AND o.binding_resource_revision=NEW.prior_revision AND o.projection_sha256=NEW.projection_sha256
  JOIN project_alpha_api_v2_inventory_receipts r ON r.source_id=o.source_id AND r.source_instance_id=o.source_instance_id
    AND r.application_id=o.application_id AND r.history_epoch_id=o.history_epoch_id AND r.inventory_kind='directory' AND r.request_id=o.request_id
  WHERE c.command_id=NEW.job_command_id AND c.live_revision=NEW.live_revision
    AND r.authorization_generation=NEW.authorization_generation
    AND (length(NEW.authorization_generation)>length(c.authorization_generation)
      OR length(NEW.authorization_generation)=length(c.authorization_generation) AND NEW.authorization_generation>=c.authorization_generation)
    AND json_extract(NEW.command_json,'$.externalId')=c.external_id
    AND (SELECT count(*) FROM project_alpha_active_directory_mappings other WHERE other.source_id=c.source_id
      AND other.source_instance_id=c.source_instance_id AND other.application_id=c.application_id AND other.history_epoch_id=c.history_epoch_id
      AND other.resource_type=c.resource_type AND (other.record_id=c.record_id OR other.external_id=c.external_id OR other.project_alpha_public_id=c.public_id))=1
    AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts newer
      WHERE newer.source_id=r.source_id AND newer.source_instance_id=r.source_instance_id
        AND newer.application_id=r.application_id AND newer.history_epoch_id=r.history_epoch_id AND newer.inventory_kind='directory'
        AND (length(newer.authorization_generation)>length(r.authorization_generation)
          OR length(newer.authorization_generation)=length(r.authorization_generation) AND newer.authorization_generation>r.authorization_generation)))
BEGIN SELECT RAISE(ABORT,'profile binding continuation command not exact'); END;
CREATE TRIGGER native_directory_profile_binding_continuation_receipt_exact BEFORE INSERT ON native_directory_profile_binding_receipts
WHEN NOT EXISTS(SELECT 1 FROM native_directory_profile_binding_jobs c
  JOIN native_directory_profile_binding_commands f ON f.job_command_id=c.command_id
  JOIN native_directory_profile_binding_dispatch d ON d.command_id=c.command_id AND d.state='leased'
  WHERE c.command_id=NEW.job_command_id
    AND json_extract(NEW.response_json,'$.sourceInstanceId')=c.source_instance_id
    AND json_extract(NEW.response_json,'$.applicationId')=c.application_id
    AND json_extract(NEW.response_json,'$.historyEpoch')=c.history_epoch_id
    AND json_extract(NEW.response_json,'$.requestId')=NEW.pa_request_id
    AND json_extract(NEW.response_json,'$.result.resource.type')=c.resource_type
    AND json_extract(NEW.response_json,'$.result.resource.id')=c.external_id
    AND json_extract(NEW.response_json,'$.result.resource.revision')=f.live_revision
    AND json_extract(NEW.response_json,'$.result.binding.publicId')=c.public_id
    AND json_extract(NEW.response_json,'$.result.binding.previousRevision')=f.prior_revision
    AND json_extract(NEW.response_json,'$.result.binding.authorizationGeneration')=NEW.authorization_generation
    AND NEW.authorization_generation=CAST(CAST(f.authorization_generation AS INTEGER)+1 AS TEXT))
BEGIN SELECT RAISE(ABORT,'profile binding continuation receipt not exact'); END;

-- Canonical-inventory completion (including already aligned bindings) is
-- asserted transactionally by the worker through the CHECK guard table.
CREATE TRIGGER native_directory_profile_binding_continuation_ack AFTER UPDATE OF state ON project_alpha_directory_outbox
WHEN NEW.state='acknowledged' AND OLD.state<>'acknowledged' AND json_extract(NEW.command_json,'$.operation')='update'
BEGIN
  INSERT INTO native_directory_profile_binding_jobs(
    command_id,intent_id,record_id,local_version,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,
    resource_type,external_id,public_id,mapping_kind,mapping_provenance_id,actor_id,access_subject,actor_json,
    acknowledged_command_json,acknowledged_outcome_json,authorization_generation,live_revision)
  SELECT NEW.command_id,i.intent_id,i.record_id,i.record_version,NEW.source_id,NEW.expected_source_instance_id,NEW.application_id,
    NEW.expected_history_epoch_id,NEW.destination_base_url,NEW.resource_type,NEW.external_id,m.project_alpha_public_id,m.mapping_kind,m.provenance_id,
    a.actor_id,a.original_verified_access_subject,json_extract(a.command_json,'$.actor'),NEW.command_json,NEW.outcome_json,
    json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration'),json_extract(NEW.outcome_json,'$.response.result.resource.revision')
  FROM operations_directory_effective_materializations x
  JOIN operations_directory_intents i ON i.intent_id=x.intent_id AND i.state='materialized'
  JOIN operations_directory_audit a ON a.mutation_id=i.mutation_id AND a.record_id=i.record_id AND a.record_version=i.record_version
  JOIN operations_directory_records r ON r.record_id=i.record_id AND r.record_kind=NEW.resource_type AND r.current_version=i.record_version
  JOIN operations_directory_revisions v ON v.record_id=i.record_id AND v.version=i.record_version AND v.mutation_id=i.mutation_id
  JOIN project_alpha_active_directory_mappings m ON m.record_id=i.record_id AND m.source_id=NEW.source_id
    AND m.source_instance_id=NEW.expected_source_instance_id AND m.application_id=NEW.application_id
    AND m.history_epoch_id=NEW.expected_history_epoch_id AND m.resource_type=NEW.resource_type AND m.external_id=NEW.external_id
  WHERE x.command_id=NEW.command_id AND x.command_json=NEW.command_json AND x.history_epoch_id=NEW.expected_history_epoch_id
    AND i.source_id=NEW.source_id AND i.source_instance_uuid=NEW.expected_source_instance_id AND i.application_uuid=NEW.application_id
    AND i.expected_history_epoch_id=NEW.expected_history_epoch_id AND i.destination_origin=NEW.destination_base_url AND i.external_canonical_id=NEW.external_id
    AND json_extract(x.origin_snapshot_json,'$.actorId')=a.actor_id
    AND json_extract(x.origin_snapshot_json,'$.actorSubject')=a.original_verified_access_subject
    AND json_extract(x.origin_snapshot_json,'$.authorityRevision')=CAST(i.record_version AS TEXT)
    AND json_extract(a.command_json,'$.actor.staffId')=a.actor_id AND json_extract(a.command_json,'$.actor.accessSubject')=a.original_verified_access_subject
    AND json_extract(a.command_json,'$.mutationId')=i.mutation_id AND json_extract(a.command_json,'$.recordId')=i.record_id
    AND json_extract(a.command_json,'$.resourceType')=NEW.resource_type AND json_extract(a.command_json,'$.expectedLocalVersion')=i.record_version-1
    AND json_extract(a.command_json,'$.fields')=v.profile_json
    AND json_extract(NEW.command_json,'$.expectedProjectAlphaPublicId')=m.project_alpha_public_id
    AND json_extract(NEW.outcome_json,'$.status')='acknowledged'
    AND json_extract(NEW.outcome_json,'$.response.sourceInstanceId')=NEW.expected_source_instance_id
    AND json_extract(NEW.outcome_json,'$.response.applicationId')=NEW.application_id
    AND json_extract(NEW.outcome_json,'$.response.historyEpoch')=NEW.expected_history_epoch_id
    AND json_extract(NEW.outcome_json,'$.response.result.resource.type')=NEW.resource_type
    AND json_extract(NEW.outcome_json,'$.response.result.resource.publicId')=m.project_alpha_public_id
    AND json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration')=json_extract(NEW.command_json,'$.expectedAuthorizationGeneration')
    AND (length(json_extract(NEW.outcome_json,'$.response.result.resource.revision'))>length(json_extract(NEW.command_json,'$.expectedRevision'))
      OR length(json_extract(NEW.outcome_json,'$.response.result.resource.revision'))=length(json_extract(NEW.command_json,'$.expectedRevision'))
      AND json_extract(NEW.outcome_json,'$.response.result.resource.revision')>json_extract(NEW.command_json,'$.expectedRevision'));
  INSERT INTO native_directory_profile_binding_guards(guard_id,ok)
    VALUES(NEW.command_id,CASE WHEN EXISTS(SELECT 1 FROM native_directory_profile_binding_jobs WHERE command_id=NEW.command_id) THEN 1 ELSE 0 END);
  INSERT INTO native_directory_profile_binding_dispatch(command_id,state) VALUES(NEW.command_id,'pending');
  DELETE FROM native_directory_profile_binding_guards WHERE guard_id=NEW.command_id;
END;
