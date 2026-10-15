-- Additive source restrictions beneath existing 0191 entity authority. History is permanent:
-- an entity with any source-context history must never return to implicit single-source mode.
CREATE TABLE operations_portal_native_billing_source_commands (
 operation_id TEXT PRIMARY KEY,
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json) AND length(CAST(canonical_command_json AS BLOB))<=32768),
 grant_id TEXT NOT NULL,
 parent_grant_id TEXT NOT NULL REFERENCES operations_portal_native_billing_authority_heads(grant_id) ON DELETE RESTRICT,
 parent_revision INTEGER NOT NULL CHECK(parent_revision>=1),
 parent_finalization_id TEXT NOT NULL REFERENCES operations_portal_native_billing_grant_finalizations(finalization_id) ON DELETE RESTRICT,
 source_id TEXT NOT NULL CHECK(source_id GLOB 'project-alpha:*' AND length(source_id)<=78),
 action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
 context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object'
  AND length(CAST(context_json AS BLOB))<=8192 AND json_extract(context_json,'$.sourceId')=source_id),
 actor_staff_id TEXT NOT NULL,
 actor_access_subject TEXT NOT NULL,
 actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
 actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
 actor_grant_generation INTEGER NOT NULL CHECK(actor_grant_generation>=1),
 actor_verified_until TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 UNIQUE(grant_id,resulting_revision)
);
CREATE TABLE operations_portal_native_billing_source_heads (
 grant_id TEXT PRIMARY KEY,
 parent_grant_id TEXT NOT NULL REFERENCES operations_portal_native_billing_authority_heads(grant_id) ON DELETE RESTRICT,
 source_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1),
 state TEXT NOT NULL CHECK(state IN ('active','revoked')),
 creation_operation_id TEXT NOT NULL REFERENCES operations_portal_native_billing_source_commands(operation_id) ON DELETE RESTRICT,
 latest_operation_id TEXT NOT NULL REFERENCES operations_portal_native_billing_source_commands(operation_id) ON DELETE RESTRICT,
 UNIQUE(parent_grant_id,source_id)
);
CREATE TRIGGER operations_native_billing_source_command_no_update BEFORE UPDATE ON operations_portal_native_billing_source_commands
BEGIN SELECT RAISE(ABORT,'billing source command immutable'); END;
CREATE TRIGGER operations_native_billing_source_command_no_delete BEFORE DELETE ON operations_portal_native_billing_source_commands
BEGIN SELECT RAISE(ABORT,'billing source history required'); END;
CREATE TRIGGER operations_native_billing_source_head_no_delete BEFORE DELETE ON operations_portal_native_billing_source_heads
BEGIN SELECT RAISE(ABORT,'billing source history required'); END;
CREATE TRIGGER operations_native_billing_source_command_json_guard BEFORE INSERT ON operations_portal_native_billing_source_commands
WHEN NEW.canonical_command_json<>json_object('protocol','operations-native-billing-source-authority','protocolVersion',1,
 'operationId',NEW.operation_id,'grantId',NEW.grant_id,'parentGrantId',NEW.parent_grant_id,
 'parentRevision',NEW.parent_revision,'parentFinalizationId',NEW.parent_finalization_id,'sourceId',NEW.source_id,
 'action',NEW.action,'expectedRevision',NEW.expected_revision,'resultingRevision',NEW.resulting_revision,
 'context',json(NEW.context_json),'actor',json_object('staffId',NEW.actor_staff_id,'accessSubject',NEW.actor_access_subject,
 'admissionVersion',NEW.actor_admission_version,'profileVersion',NEW.actor_profile_version,
 'grantGeneration',NEW.actor_grant_generation,'verifiedUntil',NEW.actor_verified_until),'observedAt',NEW.observed_at)
BEGIN SELECT RAISE(ABORT,'billing source command noncanonical'); END;
CREATE TRIGGER operations_native_billing_source_command_actor_guard BEFORE INSERT ON operations_portal_native_billing_source_commands
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_heads parent
 JOIN operations_portal_native_billing_authority_commands parent_command ON parent_command.operation_id=parent.latest_operation_id
 JOIN native_staff_admissions admission ON admission.staff_id=NEW.actor_staff_id
 JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
 JOIN staff_users staff ON staff.id=admission.staff_id
 JOIN operations_portal_native_billing_permission_generations generation ON generation.staff_id=admission.staff_id
 WHERE parent.grant_id=NEW.parent_grant_id AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject
  AND admission.version=NEW.actor_admission_version AND profile.version=NEW.actor_profile_version
  AND staff.status='active' AND staff.access_subject=NEW.actor_access_subject AND generation.generation=NEW.actor_grant_generation
  AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions p
   WHERE p.staff_id=admission.staff_id AND p.record_id=parent_command.root_record_id AND p.effect='allow')
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions p
   WHERE p.staff_id=admission.staff_id AND p.record_id=parent_command.root_record_id AND p.effect='deny'))
BEGIN SELECT RAISE(ABORT,'billing source actor not current'); END;
CREATE TRIGGER operations_native_billing_source_command_parent_guard BEFORE INSERT ON operations_portal_native_billing_source_commands
WHEN NEW.action='grant' AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_live_authority live
 JOIN operations_portal_native_billing_authority_heads parent ON parent.grant_id=live.grant_id
 WHERE parent.grant_id=NEW.parent_grant_id AND parent.revision=NEW.parent_revision
  AND parent.latest_grant_finalization_id=NEW.parent_finalization_id)
BEGIN SELECT RAISE(ABORT,'billing source parent not current'); END;
CREATE TRIGGER operations_native_billing_source_command_context_guard BEFORE INSERT ON operations_portal_native_billing_source_commands
WHEN (SELECT count(*) FROM json_each(NEW.context_json))<>14
 OR (SELECT count(DISTINCT key) FROM json_each(NEW.context_json))<>14
 OR EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE type<>'text' OR key NOT IN
  ('sourceId','sourceInstanceId','applicationId','historyEpochId','origin','kind','externalId','publicId',
   'mappingKind','mappingProvenanceId','revision','projectionSha256','authorizationGeneration','conflictRevision'))
 OR json_extract(NEW.context_json,'$.sourceId') IS NOT NEW.source_id
 OR coalesce(json_extract(NEW.context_json,'$.kind'),'') NOT IN ('organization','client','project')
 OR length(coalesce(json_extract(NEW.context_json,'$.publicId'),''))<>32
 OR json_extract(NEW.context_json,'$.publicId') GLOB '*[^0-9a-f]*'
 OR length(coalesce(json_extract(NEW.context_json,'$.projectionSha256'),''))<>64
 OR json_extract(NEW.context_json,'$.projectionSha256') GLOB '*[^0-9a-f]*'
BEGIN SELECT RAISE(ABORT,'billing source context malformed'); END;
CREATE TRIGGER operations_native_billing_source_command_conflict_frontier_guard BEFORE INSERT ON operations_portal_native_billing_source_commands
WHEN NEW.action='grant' AND json_extract(NEW.context_json,'$.conflictRevision') IS NOT
 (SELECT CAST(coalesce(max(conflict_id),0) AS TEXT) FROM project_alpha_api_v2_inventory_conflicts
  WHERE source_id=NEW.source_id AND source_instance_id=json_extract(NEW.context_json,'$.sourceInstanceId')
   AND application_id=json_extract(NEW.context_json,'$.applicationId') AND history_epoch_id=json_extract(NEW.context_json,'$.historyEpochId'))
BEGIN SELECT RAISE(ABORT,'billing source reviewed conflicts changed'); END;
-- This guard runs INSIDE the command/head batch transaction, after review and hashing.
-- No stale retirement, rebind, resource revision, projection or authorization generation
-- may be issued merely because it was current in the preceding asynchronous review.
CREATE TRIGGER operations_native_billing_source_command_mapping_guard BEFORE INSERT ON operations_portal_native_billing_source_commands
WHEN NEW.action='grant' AND NOT (
 EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_heads parent
  JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=parent.native_entity_id
   AND mapping.resource_type=parent.entity_kind
  JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type
  JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
  JOIN project_alpha_api_v2_directory_observations_current observation ON observation.source_id=mapping.source_id
   AND observation.source_instance_id=mapping.source_instance_id AND observation.application_id=mapping.application_id
   AND observation.history_epoch_id=mapping.history_epoch_id AND observation.resource_type=mapping.resource_type
   AND observation.project_alpha_public_id=mapping.project_alpha_public_id
  JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id
   AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id
   AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='directory'
   AND receipt.request_id=observation.request_id
  WHERE parent.grant_id=NEW.parent_grant_id AND parent.entity_kind IN ('organization','client')
   AND mapping.source_id=NEW.source_id AND mapping.resource_type=json_extract(NEW.context_json,'$.kind')
   AND mapping.source_instance_id=json_extract(NEW.context_json,'$.sourceInstanceId')
   AND mapping.application_id=json_extract(NEW.context_json,'$.applicationId')
   AND mapping.history_epoch_id=json_extract(NEW.context_json,'$.historyEpochId')
   AND mapping.external_id=json_extract(NEW.context_json,'$.externalId')
   AND mapping.project_alpha_public_id=json_extract(NEW.context_json,'$.publicId')
   AND mapping.mapping_kind=json_extract(NEW.context_json,'$.mappingKind')
   AND mapping.provenance_id=json_extract(NEW.context_json,'$.mappingProvenanceId')
   AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0
   AND observation.binding_status='active' AND observation.binding_external_id=mapping.external_id
   AND observation.binding_resource_revision=observation.resource_revision
   AND observation.resource_revision=json_extract(NEW.context_json,'$.revision')
   AND observation.projection_sha256=json_extract(NEW.context_json,'$.projectionSha256')
   AND json_valid(revision.profile_json)
   AND (SELECT count(*) FROM project_alpha_active_directory_mappings candidate
    WHERE candidate.source_id=mapping.source_id AND candidate.source_instance_id=mapping.source_instance_id
     AND candidate.application_id=mapping.application_id AND candidate.history_epoch_id=mapping.history_epoch_id
     AND candidate.resource_type=mapping.resource_type AND (candidate.record_id=mapping.record_id
      OR candidate.external_id=mapping.external_id OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))=1
   AND json_extract(NEW.context_json,'$.authorizationGeneration')=(SELECT generation.authorization_generation
    FROM project_alpha_api_v2_inventory_receipts generation WHERE generation.source_id=mapping.source_id
     AND generation.source_instance_id=mapping.source_instance_id AND generation.application_id=mapping.application_id
     AND generation.history_epoch_id=mapping.history_epoch_id AND generation.inventory_kind='directory'
    ORDER BY length(generation.authorization_generation) DESC,generation.authorization_generation DESC LIMIT 1))
 OR EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_heads parent
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=parent.native_entity_id
  JOIN operations_shared_projects project ON project.external_project_id=mapping.external_project_id
   AND project.source_id=mapping.source_id AND project.source_instance_id=mapping.source_instance_id
   AND project.application_id=mapping.application_id AND project.history_epoch_id=mapping.history_epoch_id
   AND project.project_alpha_public_id=mapping.project_alpha_public_id
  JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
   AND revision.version=project.current_version
  JOIN project_alpha_api_v2_project_observations_current observation ON observation.source_id=mapping.source_id
   AND observation.source_instance_id=mapping.source_instance_id AND observation.application_id=mapping.application_id
   AND observation.history_epoch_id=mapping.history_epoch_id AND observation.external_project_id=mapping.external_project_id
   AND observation.project_alpha_public_id=mapping.project_alpha_public_id
  JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id
   AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id
   AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='project'
   AND receipt.request_id=observation.request_id
  WHERE parent.grant_id=NEW.parent_grant_id AND parent.entity_kind='project'
   AND mapping.source_id=NEW.source_id AND json_extract(NEW.context_json,'$.kind')='project'
   AND mapping.source_instance_id=json_extract(NEW.context_json,'$.sourceInstanceId')
   AND mapping.application_id=json_extract(NEW.context_json,'$.applicationId')
   AND mapping.history_epoch_id=json_extract(NEW.context_json,'$.historyEpochId')
   AND mapping.external_project_id=json_extract(NEW.context_json,'$.externalId')
   AND mapping.project_alpha_public_id=json_extract(NEW.context_json,'$.publicId')
   AND mapping.establishment_kind=json_extract(NEW.context_json,'$.mappingKind')
   AND mapping.establishment_command_id=json_extract(NEW.context_json,'$.mappingProvenanceId')
   AND project.pa_revision=json_extract(NEW.context_json,'$.revision')
   AND project.canonical_projection_sha256=json_extract(NEW.context_json,'$.projectionSha256')
   AND observation.resource_revision=project.pa_revision AND observation.projection_sha256=project.canonical_projection_sha256
   AND observation.archived=project.archived AND observation.has_conflict=0
   AND json_valid(revision.read_json)
   AND json_extract(revision.read_json,'$.resource.id')=mapping.project_alpha_public_id
   AND json_extract(revision.read_json,'$.resource.revision')=project.pa_revision
   AND json_extract(revision.read_json,'$.resource.projectionSha256')=project.canonical_projection_sha256
   AND json_extract(NEW.context_json,'$.authorizationGeneration')=(SELECT generation.authorization_generation
    FROM project_alpha_api_v2_inventory_receipts generation WHERE generation.source_id=mapping.source_id
     AND generation.source_instance_id=mapping.source_instance_id AND generation.application_id=mapping.application_id
     AND generation.history_epoch_id=mapping.history_epoch_id AND generation.inventory_kind='project'
    ORDER BY length(generation.authorization_generation) DESC,generation.authorization_generation DESC LIMIT 1))
)
BEGIN SELECT RAISE(ABORT,'billing source reviewed mapping not current'); END;
CREATE TRIGGER operations_native_billing_source_command_revision_guard BEFORE INSERT ON operations_portal_native_billing_source_commands
WHEN (NEW.expected_revision=0 AND (NEW.action<>'grant' OR EXISTS(
 SELECT 1 FROM operations_portal_native_billing_source_heads h WHERE h.grant_id=NEW.grant_id
  OR (h.parent_grant_id=NEW.parent_grant_id AND h.source_id=NEW.source_id))))
 OR (NEW.expected_revision>0 AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_source_heads h
 WHERE h.grant_id=NEW.grant_id AND h.parent_grant_id=NEW.parent_grant_id AND h.source_id=NEW.source_id
  AND h.revision=NEW.expected_revision))
BEGIN SELECT RAISE(ABORT,'billing source revision not current'); END;
CREATE TRIGGER operations_native_billing_source_head_insert_guard BEFORE INSERT ON operations_portal_native_billing_source_heads
WHEN NEW.revision<>1 OR NEW.state<>'active' OR NEW.creation_operation_id<>NEW.latest_operation_id OR NOT EXISTS(
 SELECT 1 FROM operations_portal_native_billing_source_commands c WHERE c.operation_id=NEW.latest_operation_id
  AND c.grant_id=NEW.grant_id AND c.parent_grant_id=NEW.parent_grant_id AND c.source_id=NEW.source_id
  AND c.expected_revision=0 AND c.resulting_revision=NEW.revision AND c.action='grant')
BEGIN SELECT RAISE(ABORT,'billing source activation not acknowledged'); END;
CREATE TRIGGER operations_native_billing_source_head_update_guard BEFORE UPDATE ON operations_portal_native_billing_source_heads
WHEN NEW.grant_id<>OLD.grant_id OR NEW.parent_grant_id<>OLD.parent_grant_id OR NEW.source_id<>OLD.source_id
 OR NEW.creation_operation_id<>OLD.creation_operation_id OR NEW.revision<>OLD.revision+1 OR NOT EXISTS(
 SELECT 1 FROM operations_portal_native_billing_source_commands c WHERE c.operation_id=NEW.latest_operation_id
  AND c.grant_id=OLD.grant_id AND c.parent_grant_id=OLD.parent_grant_id AND c.source_id=OLD.source_id
  AND c.expected_revision=OLD.revision AND c.resulting_revision=NEW.revision
  AND NEW.state=CASE c.action WHEN 'grant' THEN 'active' ELSE 'revoked' END)
BEGIN SELECT RAISE(ABORT,'billing source transition not acknowledged'); END;
CREATE VIEW operations_portal_native_billing_source_live_authority AS
SELECT h.*,c.parent_revision,c.parent_finalization_id,c.context_json
FROM operations_portal_native_billing_source_heads h
JOIN operations_portal_native_billing_source_commands c ON c.operation_id=h.latest_operation_id
JOIN operations_portal_native_billing_live_authority live ON live.grant_id=h.parent_grant_id
JOIN operations_portal_native_billing_authority_heads parent ON parent.grant_id=live.grant_id
JOIN operations_portal_native_billing_authority_commands parent_command ON parent_command.operation_id=parent.latest_operation_id
JOIN native_staff_admissions admission ON admission.staff_id=c.actor_staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN staff_users staff ON staff.id=admission.staff_id
JOIN operations_portal_native_billing_permission_generations generation ON generation.staff_id=admission.staff_id
WHERE h.state='active' AND c.action='grant' AND parent.revision=c.parent_revision
 AND parent.latest_grant_finalization_id=c.parent_finalization_id
 AND admission.active=1 AND admission.bound_access_subject=c.actor_access_subject AND admission.version=c.actor_admission_version
 AND profile.version=c.actor_profile_version AND staff.status='active' AND staff.access_subject=c.actor_access_subject
 AND generation.generation=c.actor_grant_generation
 AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions p
   WHERE p.staff_id=admission.staff_id AND p.record_id=parent_command.root_record_id AND p.effect='allow')
 AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions p
   WHERE p.staff_id=admission.staff_id AND p.record_id=parent_command.root_record_id AND p.effect='deny');
