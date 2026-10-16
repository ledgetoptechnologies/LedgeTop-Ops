PRAGMA foreign_keys=ON;

-- Read-only completion of acknowledged creates. This view is also the live
-- fence: a queued target never substitutes for a current exact ACK/mapping.
CREATE VIEW native_directory_create_observation_targets AS
SELECT o.command_id,i.record_id,o.source_id,o.expected_source_instance_id source_instance_id,
 o.application_id,o.expected_history_epoch_id history_epoch_id,o.destination_base_url destination_origin,
 o.resource_type,o.external_id,m.project_alpha_public_id public_id,m.provenance_id,
 o.command_json acknowledged_command_json,o.outcome_json acknowledged_outcome_json,o.created_at
FROM project_alpha_directory_outbox o
JOIN operations_directory_effective_materializations x ON x.command_id=o.command_id AND x.command_json=o.command_json
JOIN operations_directory_intents i ON i.intent_id=x.intent_id AND i.state='acknowledged'
JOIN operations_directory_records r ON r.record_id=i.record_id AND r.record_kind=o.resource_type
JOIN project_alpha_active_directory_mappings m ON m.record_id=i.record_id AND m.source_id=o.source_id
 AND m.source_instance_id=o.expected_source_instance_id AND m.application_id=o.application_id
 AND m.history_epoch_id=o.expected_history_epoch_id AND m.resource_type=o.resource_type AND m.external_id=o.external_id
WHERE o.state='acknowledged' AND json_extract(o.command_json,'$.operation')='create'
 AND i.source_id=o.source_id AND i.source_instance_uuid=o.expected_source_instance_id AND i.application_uuid=o.application_id
 AND i.expected_history_epoch_id=o.expected_history_epoch_id AND i.destination_origin=o.destination_base_url
 AND i.external_canonical_id=o.external_id AND x.history_epoch_id=o.expected_history_epoch_id
 AND json_extract(o.outcome_json,'$.status')='acknowledged'
 AND json_extract(o.outcome_json,'$.response.sourceInstanceId')=o.expected_source_instance_id
 AND json_extract(o.outcome_json,'$.response.applicationId')=o.application_id
 AND json_extract(o.outcome_json,'$.response.historyEpoch')=o.expected_history_epoch_id
 AND json_extract(o.outcome_json,'$.response.result.resource.type')=o.resource_type
 AND json_extract(o.outcome_json,'$.response.result.resource.publicId')=m.project_alpha_public_id;

CREATE TABLE native_directory_create_observation_jobs (
 command_id TEXT PRIMARY KEY REFERENCES project_alpha_directory_outbox(command_id),
 record_id TEXT NOT NULL,source_id TEXT NOT NULL,source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,
 history_epoch_id TEXT NOT NULL,destination_origin TEXT NOT NULL,resource_type TEXT NOT NULL CHECK(resource_type IN('client','organization')),
 external_id TEXT NOT NULL,public_id TEXT NOT NULL,provenance_id TEXT NOT NULL,
 acknowledged_command_json TEXT NOT NULL,acknowledged_outcome_json TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TRIGGER native_directory_create_observation_job_exact BEFORE INSERT ON native_directory_create_observation_jobs
WHEN NOT EXISTS(SELECT 1 FROM native_directory_create_observation_targets t WHERE t.command_id=NEW.command_id
 AND t.record_id=NEW.record_id AND t.source_id=NEW.source_id AND t.source_instance_id=NEW.source_instance_id
 AND t.application_id=NEW.application_id AND t.history_epoch_id=NEW.history_epoch_id AND t.destination_origin=NEW.destination_origin
 AND t.resource_type=NEW.resource_type AND t.external_id=NEW.external_id AND t.public_id=NEW.public_id AND t.provenance_id=NEW.provenance_id
 AND t.acknowledged_command_json=NEW.acknowledged_command_json AND t.acknowledged_outcome_json=NEW.acknowledged_outcome_json AND t.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'create observation requires current exact acknowledgment'); END;
CREATE TRIGGER native_directory_create_observation_job_no_update BEFORE UPDATE ON native_directory_create_observation_jobs
BEGIN SELECT RAISE(ABORT,'create observation target is immutable'); END;
CREATE TRIGGER native_directory_create_observation_job_no_delete BEFORE DELETE ON native_directory_create_observation_jobs
BEGIN SELECT RAISE(ABORT,'create observation target is durable'); END;
CREATE TABLE native_directory_create_observation_dispatch (
 command_id TEXT PRIMARY KEY REFERENCES native_directory_create_observation_jobs(command_id),
 state TEXT NOT NULL CHECK(state IN('pending','leased','uncertain','conflict','complete')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,lease_expires_at INTEGER,inventory_cursor TEXT,inventory_generation TEXT,reason TEXT,
 CHECK((state='leased')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
 CHECK((inventory_cursor IS NULL)=(inventory_generation IS NULL)),
 CHECK(inventory_cursor IS NULL OR (substr(inventory_cursor,1,7)='client:' AND length(inventory_cursor)=39 AND substr(inventory_cursor,8) NOT GLOB '*[^0-9a-f]*')
  OR (substr(inventory_cursor,1,13)='organization:' AND length(inventory_cursor)=45 AND substr(inventory_cursor,14) NOT GLOB '*[^0-9a-f]*')),
 CHECK(inventory_generation IS NULL OR (length(inventory_generation) BETWEEN 1 AND 19 AND inventory_generation NOT GLOB '*[^0-9]*'
  AND (inventory_generation='0' OR substr(inventory_generation,1,1) BETWEEN '1' AND '9')
  AND (length(inventory_generation)<19 OR inventory_generation<='9223372036854775807')))
);
CREATE TRIGGER native_directory_create_observation_enqueue AFTER INSERT ON native_directory_create_observation_jobs
BEGIN INSERT INTO native_directory_create_observation_dispatch(command_id,state) VALUES(NEW.command_id,'pending'); END;
CREATE TRIGGER native_directory_create_observation_dispatch_initial BEFORE INSERT ON native_directory_create_observation_dispatch
WHEN NEW.state<>'pending' OR NEW.attempts<>0 OR NEW.inventory_cursor IS NOT NULL OR NEW.inventory_generation IS NOT NULL
 OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'create observation dispatch must start pending'); END;
CREATE INDEX native_directory_create_observation_due ON native_directory_create_observation_dispatch(state,next_attempt_at,lease_expires_at);
CREATE TABLE native_directory_create_observation_guards(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));

-- Non-null progress must be a real next cursor from validated inventory for
-- this exact source identity and resource type, never a synthesized target ID.
CREATE TRIGGER native_directory_create_observation_cursor BEFORE UPDATE OF inventory_cursor,inventory_generation ON native_directory_create_observation_dispatch
WHEN NEW.inventory_cursor IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM native_directory_create_observation_jobs j JOIN project_alpha_api_v2_inventory_receipts r
 ON r.source_id=j.source_id AND r.source_instance_id=j.source_instance_id AND r.application_id=j.application_id
 AND r.history_epoch_id=j.history_epoch_id AND r.inventory_kind='directory'
 WHERE j.command_id=NEW.command_id AND r.next_cursor=NEW.inventory_cursor AND r.authorization_generation=NEW.inventory_generation
 AND substr(NEW.inventory_cursor,1,length(j.resource_type)+1)=j.resource_type||':')
BEGIN SELECT RAISE(ABORT,'create observation cursor requires canonical inventory'); END;
