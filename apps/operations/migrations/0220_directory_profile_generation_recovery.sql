PRAGMA foreign_keys=ON;
-- A profile recovery never edits its original command, expected PA revision,
-- profile, endpoint policy or original actor. Only a new command UUID and a
-- freshly proven application generation differ. The caller must still pass the
-- normal current staff/own-profile reservation and atomic authority row fences.
CREATE TABLE project_alpha_directory_profile_generation_recoveries(
 authorization_id TEXT PRIMARY KEY NOT NULL,
 root_command_id TEXT NOT NULL REFERENCES project_alpha_directory_outbox(command_id),
 predecessor_command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_outbox(command_id),
 successor_command_id TEXT NOT NULL UNIQUE,
 recovery_depth INTEGER NOT NULL CHECK(recovery_depth BETWEEN 1 AND 3),
 intent_id TEXT NOT NULL REFERENCES operations_directory_intents(intent_id),
 source_id TEXT NOT NULL,source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
 destination_origin TEXT NOT NULL,resource_type TEXT NOT NULL CHECK(resource_type IN('client','organization')),
 record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id),external_id TEXT NOT NULL,
 predecessor_command_json TEXT NOT NULL CHECK(json_valid(predecessor_command_json)),
 successor_command_json TEXT NOT NULL CHECK(json_valid(successor_command_json)),
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
 endpoint_policy TEXT NOT NULL CHECK(endpoint_policy IN('regular','contact')),
 identity_policy TEXT NOT NULL CHECK(identity_policy IN('staff','reviewed_manual','automatic_own')),
 generation_conflict_request_id TEXT NOT NULL CHECK(length(generation_conflict_request_id)=36),
 generation_conflict_code TEXT NOT NULL CHECK(generation_conflict_code='authorization_generation_conflict'),
 observed_authorization_generation TEXT NOT NULL CHECK(
  CAST(CAST(observed_authorization_generation AS INTEGER) AS TEXT)=observed_authorization_generation
  AND CAST(observed_authorization_generation AS INTEGER)>=0 AND CAST(observed_authorization_generation AS INTEGER)<9223372036854775807),
 observed_binding_json TEXT NOT NULL CHECK(json_valid(observed_binding_json)),
 observed_profile_json TEXT NOT NULL CHECK(json_valid(observed_profile_json)),
 observed_identity_json TEXT CHECK(observed_identity_json IS NULL OR json_valid(observed_identity_json)),
 authority_snapshot_json TEXT NOT NULL CHECK(json_valid(authority_snapshot_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE project_alpha_directory_profile_recovery_guards(id TEXT PRIMARY KEY NOT NULL,ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE project_alpha_directory_profile_recovery_checks(command_id TEXT PRIMARY KEY NOT NULL REFERENCES project_alpha_directory_outbox(command_id),
 source_id TEXT NOT NULL,next_attempt_at INTEGER NOT NULL,checked_at INTEGER NOT NULL,reason TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('pending','review_required')));
CREATE TRIGGER directory_profile_recovery_exact BEFORE INSERT ON project_alpha_directory_profile_generation_recoveries
WHEN NOT EXISTS(
 SELECT 1 FROM project_alpha_directory_outbox old
 JOIN operations_directory_materializations m ON m.command_id=NEW.root_command_id
 JOIN operations_directory_intents i ON i.intent_id=m.intent_id
 JOIN operations_directory_records r ON r.record_id=i.record_id AND r.current_version=i.record_version
 JOIN operations_directory_audit a ON a.mutation_id=i.mutation_id AND a.record_id=i.record_id AND a.record_version=i.record_version
 WHERE old.command_id=NEW.predecessor_command_id AND old.state='terminal' AND json_extract(old.outcome_json,'$.httpStatus')=409
 AND i.state='materialized' AND i.intent_id=NEW.intent_id AND i.record_id=NEW.record_id AND i.external_canonical_id=NEW.external_id
 AND old.command_json=NEW.predecessor_command_json AND json_extract(old.command_json,'$.operation')='update'
 AND old.source_id=NEW.source_id AND old.expected_source_instance_id=NEW.source_instance_id AND old.application_id=NEW.application_id
 AND old.expected_history_epoch_id=NEW.history_epoch_id AND old.destination_base_url=NEW.destination_origin
 AND old.resource_type=NEW.resource_type AND old.external_id=NEW.external_id
 AND json_extract(a.command_json,'$.actor')=json(NEW.actor_json)
 AND ((a.actor_type='staff' AND NEW.identity_policy='staff') OR (a.actor_type='system' AND json_extract(NEW.actor_json,'$.kind')='portal'
  AND ((NEW.identity_policy='automatic_own' AND NEW.observed_identity_json IS NOT NULL AND EXISTS(SELECT 1 FROM client_onboarding_portal_activation_proofs p WHERE p.grant_id=json_extract(NEW.actor_json,'$.grantId')))
   OR (NEW.identity_policy='reviewed_manual' AND NEW.observed_identity_json IS NULL AND NOT EXISTS(SELECT 1 FROM client_onboarding_portal_activation_proofs p WHERE p.grant_id=json_extract(NEW.actor_json,'$.grantId'))))))
 AND ((NEW.endpoint_policy='contact' AND NEW.resource_type='client' AND json_type(a.command_json,'$.sharedContactProfile')='object')
   OR (NEW.endpoint_policy='regular' AND json_type(a.command_json,'$.sharedContactProfile') IS NULL))
 AND (NEW.recovery_depth=1 AND NEW.predecessor_command_id=NEW.root_command_id
   OR EXISTS(SELECT 1 FROM project_alpha_directory_profile_generation_recoveries prior
    WHERE prior.successor_command_id=NEW.predecessor_command_id AND prior.root_command_id=NEW.root_command_id
      AND prior.intent_id=NEW.intent_id AND prior.recovery_depth=NEW.recovery_depth-1
      AND prior.actor_json=NEW.actor_json AND prior.endpoint_policy=NEW.endpoint_policy))
 AND json_extract(NEW.successor_command_json,'$.commandId')=NEW.successor_command_id
 AND json_extract(NEW.successor_command_json,'$.expectedAuthorizationGeneration')=NEW.observed_authorization_generation
 AND CAST(NEW.observed_authorization_generation AS INTEGER)>CAST(json_extract(old.command_json,'$.expectedAuthorizationGeneration') AS INTEGER)
 AND json_remove(NEW.successor_command_json,'$.commandId','$.expectedAuthorizationGeneration')=
     json_remove(old.command_json,'$.commandId','$.expectedAuthorizationGeneration')
 AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
  WHERE mapping.record_id=NEW.record_id AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
   AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
   AND mapping.resource_type=NEW.resource_type AND mapping.external_id=NEW.external_id
   AND mapping.project_alpha_public_id=json_extract(old.command_json,'$.expectedProjectAlphaPublicId'))
)
BEGIN SELECT RAISE(ABORT,'profile recovery is not the exact current immutable update'); END;
CREATE TRIGGER directory_profile_recovery_immutable BEFORE UPDATE ON project_alpha_directory_profile_generation_recoveries
BEGIN SELECT RAISE(ABORT,'profile recovery is immutable'); END;
CREATE TRIGGER directory_profile_recovery_durable BEFORE DELETE ON project_alpha_directory_profile_generation_recoveries
BEGIN SELECT RAISE(ABORT,'profile recovery is durable'); END;
CREATE TRIGGER directory_profile_recovery_successor AFTER INSERT ON project_alpha_directory_outbox
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_profile_generation_recoveries x WHERE x.successor_command_id=NEW.command_id)
AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_profile_generation_recoveries x WHERE x.successor_command_id=NEW.command_id
 AND NEW.command_json=x.successor_command_json AND NEW.source_id=x.source_id AND NEW.expected_source_instance_id=x.source_instance_id
 AND NEW.application_id=x.application_id AND NEW.expected_history_epoch_id=x.history_epoch_id
 AND NEW.destination_base_url=x.destination_origin AND NEW.resource_type=x.resource_type AND NEW.external_id=x.external_id
 AND NEW.state='pending' AND NEW.attempts=0 AND NEW.outcome_json IS NULL)
BEGIN SELECT RAISE(ABORT,'profile recovery successor differs'); END;

CREATE VIEW project_alpha_directory_profile_recovery_edges AS
SELECT authorization_id,root_command_id,predecessor_command_id,successor_command_id,recovery_depth,intent_id,successor_command_json
FROM project_alpha_directory_create_generation_recoveries
UNION ALL
SELECT authorization_id,root_command_id,predecessor_command_id,successor_command_id,recovery_depth,intent_id,successor_command_json
FROM project_alpha_directory_profile_generation_recoveries;
DROP VIEW operations_directory_effective_materializations;
CREATE VIEW operations_directory_effective_materializations AS
SELECT m.intent_id,COALESCE(x.successor_command_id,m.command_id) command_id,COALESCE(x.successor_command_json,m.command_json) command_json,
 m.origin_snapshot_json,m.disposition_json,m.next_attempt_at,m.created_at,m.history_epoch_id,
 m.command_id root_command_id,m.command_json root_command_json,x.authorization_id recovery_authorization_id,COALESCE(x.recovery_depth,0) recovery_depth
FROM operations_directory_materializations m LEFT JOIN project_alpha_directory_profile_recovery_edges x
 ON x.root_command_id=m.command_id AND x.recovery_depth=(SELECT max(y.recovery_depth) FROM project_alpha_directory_profile_recovery_edges y WHERE y.root_command_id=m.command_id)
 AND EXISTS(SELECT 1 FROM project_alpha_directory_outbox p WHERE p.command_id=x.predecessor_command_id AND p.state='terminal' AND json_extract(p.outcome_json,'$.httpStatus')=409);
DROP VIEW project_alpha_directory_unsettled_commands;
CREATE VIEW project_alpha_directory_unsettled_commands AS
SELECT o.* FROM project_alpha_directory_outbox o WHERE o.state<>'acknowledged' AND NOT EXISTS(
 SELECT 1 FROM project_alpha_directory_profile_recovery_edges x JOIN project_alpha_directory_outbox successor ON successor.command_id=x.successor_command_id
 WHERE successor.state='acknowledged' AND x.recovery_depth=(SELECT max(y.recovery_depth) FROM project_alpha_directory_profile_recovery_edges y WHERE y.root_command_id=x.root_command_id)
 AND (o.command_id=x.root_command_id OR EXISTS(SELECT 1 FROM project_alpha_directory_profile_recovery_edges ancestor
  WHERE ancestor.root_command_id=x.root_command_id AND ancestor.recovery_depth<=x.recovery_depth AND ancestor.predecessor_command_id=o.command_id)));
