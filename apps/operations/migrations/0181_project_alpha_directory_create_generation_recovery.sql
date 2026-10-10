-- Staging-only, default-off audited recovery for an exact PA create
-- authorization-generation conflict. Promotion does not enable the route.
PRAGMA foreign_keys = ON;

-- Append-only authority for retrying a create that PA deterministically rejected
-- at its authorization-generation fence.  The predecessor remains terminal;
-- recovery reserves a distinct command with otherwise identical create bytes.
CREATE TABLE project_alpha_directory_create_generation_recoveries (
  authorization_id TEXT NOT NULL PRIMARY KEY,
  root_command_id TEXT NOT NULL REFERENCES project_alpha_directory_outbox(command_id) ON DELETE RESTRICT,
  predecessor_command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_outbox(command_id) ON DELETE RESTRICT,
  successor_command_id TEXT NOT NULL UNIQUE,
  recovery_depth INTEGER NOT NULL CHECK(recovery_depth BETWEEN 1 AND 3),
  intent_id TEXT NOT NULL REFERENCES operations_directory_intents(intent_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  destination_origin TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL,
  predecessor_command_json TEXT NOT NULL CHECK(json_valid(predecessor_command_json)),
  successor_command_json TEXT NOT NULL CHECK(json_valid(successor_command_json)),
  generation_conflict_request_id TEXT NOT NULL CHECK(length(generation_conflict_request_id)=36
    AND length(replace(generation_conflict_request_id,'-',''))=32),
  generation_conflict_code TEXT NOT NULL CHECK(generation_conflict_code='authorization_generation_conflict'),
  observed_inventory_request_id TEXT NOT NULL,
  observed_authorization_generation TEXT NOT NULL CHECK(
    CAST(CAST(observed_authorization_generation AS INTEGER) AS TEXT)=observed_authorization_generation
    AND CAST(observed_authorization_generation AS INTEGER)>=0
    AND CAST(observed_authorization_generation AS INTEGER)<9223372036854775807),
  actor_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  original_profile_grant_id TEXT NOT NULL,
  original_identity_grant_id TEXT NOT NULL,
  profile_grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  identity_grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  enrollment_grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER project_alpha_directory_create_generation_recoveries_exact AFTER INSERT
ON project_alpha_directory_create_generation_recoveries
WHEN NOT EXISTS (
  SELECT 1
  FROM project_alpha_directory_outbox predecessor
  JOIN operations_directory_materializations materialization ON materialization.command_id=NEW.root_command_id
  JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
  JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id
    AND audit.record_id=intent.record_id AND audit.record_version=intent.record_version
  JOIN operations_directory_records record ON record.record_id=intent.record_id
  JOIN staff_users staff ON staff.id=NEW.actor_staff_id AND staff.status='active'
    AND staff.access_subject=NEW.actor_access_subject
  JOIN native_staff_admissions admission ON admission.staff_id=NEW.actor_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=NEW.actor_staff_id
  WHERE predecessor.command_id=NEW.predecessor_command_id
    AND predecessor.state='terminal'
    AND json_extract(predecessor.outcome_json,'$.httpStatus')=409
    AND json_extract(predecessor.command_json,'$.operation')='create'
    AND predecessor.command_json=NEW.predecessor_command_json
    AND materialization.intent_id=NEW.intent_id
    AND (NEW.recovery_depth=1 AND NEW.predecessor_command_id=NEW.root_command_id
      OR NEW.recovery_depth>1 AND EXISTS(SELECT 1 FROM project_alpha_directory_create_generation_recoveries prior
        WHERE prior.successor_command_id=NEW.predecessor_command_id AND prior.root_command_id=NEW.root_command_id
          AND prior.intent_id=NEW.intent_id AND prior.recovery_depth=NEW.recovery_depth-1))
    AND intent.state='materialized'
    AND intent.record_id=NEW.record_id AND intent.external_canonical_id=NEW.external_id
    AND predecessor.source_id=NEW.source_id
    AND predecessor.expected_source_instance_id=NEW.source_instance_id
    AND predecessor.application_id=NEW.application_id
    AND predecessor.expected_history_epoch_id=NEW.history_epoch_id
    AND predecessor.destination_base_url=NEW.destination_origin
    AND predecessor.resource_type=NEW.resource_type
    AND predecessor.external_id=NEW.external_id
    AND record.record_kind=NEW.resource_type AND record.current_version=intent.record_version
    AND audit.actor_type='staff' AND audit.actor_id=NEW.actor_staff_id
    AND audit.original_verified_access_subject=NEW.actor_access_subject
    AND json_extract(audit.command_json,'$.actor.selectedGrantId')=NEW.original_profile_grant_id
    AND json_extract(audit.command_json,'$.actor.selectedIdentityGrantId')=NEW.original_identity_grant_id
    AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject
    AND admission.version=NEW.actor_admission_version
    AND profile.login_email=NEW.actor_email AND profile.version=NEW.actor_profile_version
    AND json_extract(NEW.successor_command_json,'$.commandId')=NEW.successor_command_id
    AND json_extract(NEW.successor_command_json,'$.operation')='create'
    AND json_extract(NEW.successor_command_json,'$.resourceType')=NEW.resource_type
    AND json_extract(NEW.successor_command_json,'$.externalId')=NEW.external_id
    AND json_extract(NEW.successor_command_json,'$.expectedRevision')='0'
    AND json_extract(NEW.successor_command_json,'$.expectedAuthorizationGeneration')=NEW.observed_authorization_generation
    AND json_remove(NEW.successor_command_json,'$.commandId','$.expectedAuthorizationGeneration')=
      json_remove(predecessor.command_json,'$.commandId','$.expectedAuthorizationGeneration')
    AND NOT EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings mapping
      WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
        AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
        AND mapping.resource_type=NEW.resource_type AND mapping.external_id=NEW.external_id)
)
BEGIN SELECT RAISE(ABORT,'directory create generation recovery is not current and exact'); END;

-- Keep each current-authority proof in a separate trigger. Besides making the
-- three independently auditable, this avoids SQLite's expression-depth limit
-- when this proposal is layered over the existing materialization guards.
CREATE TRIGGER project_alpha_directory_create_generation_recovery_profile_grant BEFORE INSERT
ON project_alpha_directory_create_generation_recoveries
WHEN NOT EXISTS(SELECT 1 FROM native_directory_grants grant_record
  WHERE grant_record.id=NEW.profile_grant_id AND grant_record.staff_id=NEW.actor_staff_id
    AND grant_record.permission='directory.profile.edit' AND grant_record.effect='allow' AND grant_record.active=1
    AND (grant_record.scope_kind='global'
      OR grant_record.scope_kind='resource' AND grant_record.resource_id=NEW.record_id
      OR grant_record.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=NEW.record_id AND assignment.staff_id=NEW.actor_staff_id AND assignment.active=1)
      OR grant_record.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=grant_record.business_area_id)
      OR grant_record.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=grant_record.division_id))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=NEW.actor_staff_id AND deny.permission='directory.profile.edit' AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR deny.scope_kind='resource' AND deny.resource_id=NEW.record_id
        OR deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=NEW.record_id AND assignment.staff_id=NEW.actor_staff_id AND assignment.active=1)
        OR deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id)
        OR deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
BEGIN SELECT RAISE(ABORT,'directory create generation recovery profile grant is not current and exact'); END;

CREATE TRIGGER project_alpha_directory_create_generation_recovery_identity_grant BEFORE INSERT
ON project_alpha_directory_create_generation_recoveries
WHEN NOT EXISTS(SELECT 1 FROM native_directory_grants grant_record
  WHERE grant_record.id=NEW.identity_grant_id AND grant_record.staff_id=NEW.actor_staff_id
    AND grant_record.permission='directory.identity.link' AND grant_record.effect='allow' AND grant_record.active=1
    AND (grant_record.scope_kind='global'
      OR grant_record.scope_kind='resource' AND grant_record.resource_id=NEW.record_id
      OR grant_record.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=NEW.record_id AND assignment.staff_id=NEW.actor_staff_id AND assignment.active=1)
      OR grant_record.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=grant_record.business_area_id)
      OR grant_record.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=grant_record.division_id))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=NEW.actor_staff_id AND deny.permission='directory.identity.link' AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR deny.scope_kind='resource' AND deny.resource_id=NEW.record_id
        OR deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=NEW.record_id AND assignment.staff_id=NEW.actor_staff_id AND assignment.active=1)
        OR deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id)
        OR deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
BEGIN SELECT RAISE(ABORT,'directory create generation recovery identity grant is not current and exact'); END;

CREATE TRIGGER project_alpha_directory_create_generation_recovery_enrollment_grant BEFORE INSERT
ON project_alpha_directory_create_generation_recoveries
WHEN NOT EXISTS(SELECT 1 FROM native_directory_grants grant_record
  WHERE grant_record.id=NEW.enrollment_grant_id AND grant_record.staff_id=NEW.actor_staff_id
    AND grant_record.permission='directory.enrollment.manage' AND grant_record.effect='allow' AND grant_record.active=1
    AND (grant_record.scope_kind='global'
      OR grant_record.scope_kind='resource' AND grant_record.resource_id=NEW.record_id
      OR grant_record.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=NEW.record_id AND assignment.staff_id=NEW.actor_staff_id AND assignment.active=1)
      OR grant_record.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=grant_record.business_area_id)
      OR grant_record.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=grant_record.division_id))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=NEW.actor_staff_id AND deny.permission='directory.enrollment.manage' AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR deny.scope_kind='resource' AND deny.resource_id=NEW.record_id
        OR deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=NEW.record_id AND assignment.staff_id=NEW.actor_staff_id AND assignment.active=1)
        OR deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id)
        OR deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
BEGIN SELECT RAISE(ABORT,'directory create generation recovery enrollment grant is not current and exact'); END;

CREATE TRIGGER project_alpha_directory_create_generation_recoveries_immutable BEFORE UPDATE
ON project_alpha_directory_create_generation_recoveries
BEGIN SELECT RAISE(ABORT,'directory create generation recovery is immutable'); END;
CREATE TRIGGER project_alpha_directory_create_generation_recoveries_no_delete BEFORE DELETE
ON project_alpha_directory_create_generation_recoveries
BEGIN SELECT RAISE(ABORT,'directory create generation recovery is durable'); END;

CREATE TRIGGER project_alpha_directory_create_generation_recovery_successor_exact AFTER INSERT
ON project_alpha_directory_outbox
WHEN EXISTS (SELECT 1 FROM project_alpha_directory_create_generation_recoveries recovery
  WHERE recovery.successor_command_id=NEW.command_id)
  AND NOT EXISTS (SELECT 1 FROM project_alpha_directory_create_generation_recoveries recovery
    WHERE recovery.successor_command_id=NEW.command_id
      AND NEW.source_id=recovery.source_id AND NEW.application_id=recovery.application_id
      AND NEW.resource_type=recovery.resource_type AND NEW.external_id=recovery.external_id
      AND NEW.command_json=recovery.successor_command_json
      AND NEW.destination_base_url=recovery.destination_origin
      AND NEW.expected_source_instance_id=recovery.source_instance_id
      AND NEW.expected_history_epoch_id=recovery.history_epoch_id
      AND NEW.state='pending' AND NEW.attempts=0 AND NEW.outcome_json IS NULL)
BEGIN SELECT RAISE(ABORT,'directory create generation recovery successor is not exact'); END;

-- Dispatcher/settlement integration must join this view instead of relaxing
-- the normal materialization join. It identifies the immutable root intent for
-- a successor and nothing else.
CREATE VIEW project_alpha_directory_create_generation_recovery_successors AS
SELECT recovery.successor_command_id command_id,recovery.root_command_id,recovery.predecessor_command_id,
  recovery.recovery_depth,recovery.intent_id,recovery.successor_command_json,recovery.actor_staff_id,
  recovery.actor_access_subject,recovery.observed_authorization_generation
FROM project_alpha_directory_create_generation_recoveries recovery
JOIN project_alpha_directory_outbox predecessor ON predecessor.command_id=recovery.predecessor_command_id
WHERE predecessor.state='terminal' AND json_extract(predecessor.outcome_json,'$.httpStatus')=409;

CREATE VIEW operations_directory_effective_materializations AS
SELECT materialization.intent_id,
  COALESCE(recovery.successor_command_id,materialization.command_id) command_id,
  COALESCE(recovery.successor_command_json,materialization.command_json) command_json,
  materialization.origin_snapshot_json,materialization.disposition_json,materialization.next_attempt_at,
  materialization.created_at,materialization.history_epoch_id,materialization.command_id root_command_id,
  materialization.command_json root_command_json,
  recovery.authorization_id recovery_authorization_id,COALESCE(recovery.recovery_depth,0) recovery_depth
FROM operations_directory_materializations materialization
LEFT JOIN project_alpha_directory_create_generation_recoveries recovery
  ON recovery.root_command_id=materialization.command_id
 AND recovery.recovery_depth=(SELECT max(latest.recovery_depth)
   FROM project_alpha_directory_create_generation_recoveries latest
   WHERE latest.root_command_id=materialization.command_id)
 AND EXISTS(SELECT 1 FROM project_alpha_directory_outbox predecessor
   WHERE predecessor.command_id=recovery.predecessor_command_id AND predecessor.state='terminal'
     AND json_extract(predecessor.outcome_json,'$.httpStatus')=409);

-- Pending/conflict checks use this view so a terminal predecessor remains
-- unsettled until its exact latest successor is acknowledged. Unrelated
-- terminal commands are never hidden.
CREATE VIEW project_alpha_directory_unsettled_commands AS
SELECT outbox.* FROM project_alpha_directory_outbox outbox
WHERE outbox.state<>'acknowledged' AND NOT EXISTS(
  SELECT 1 FROM project_alpha_directory_create_generation_recoveries latest
  JOIN project_alpha_directory_outbox successor ON successor.command_id=latest.successor_command_id
  WHERE successor.state='acknowledged'
    AND latest.recovery_depth=(SELECT max(candidate.recovery_depth)
      FROM project_alpha_directory_create_generation_recoveries candidate
      WHERE candidate.root_command_id=latest.root_command_id)
    AND (outbox.command_id=latest.root_command_id OR EXISTS(
      SELECT 1 FROM project_alpha_directory_create_generation_recoveries ancestor
      WHERE ancestor.root_command_id=latest.root_command_id
        AND ancestor.recovery_depth<=latest.recovery_depth
        AND ancestor.predecessor_command_id=outbox.command_id)));

-- Forward replacements: read effective recovery successors while retaining
-- original trigger targets and materialization insert destinations.
DROP VIEW operations_directory_intent_relationship_resolved;
CREATE VIEW operations_directory_intent_relationship_resolved AS
SELECT dependency.*,NULL AS resolved_parent_public_id
  FROM operations_directory_intent_relationship_dependencies dependency
  WHERE dependency.evidence_kind='unlinked'
UNION ALL
SELECT dependency.*,mapping.project_alpha_public_id
  FROM operations_directory_intent_relationship_dependencies dependency
  JOIN operations_directory_intents parent ON parent.intent_id=dependency.parent_intent_id
    AND parent.record_id=dependency.organization_record_id
    AND parent.record_version=dependency.organization_record_version
    AND parent.source_id=dependency.source_id AND parent.source_instance_uuid=dependency.source_instance_uuid
    AND parent.application_uuid=dependency.application_uuid AND parent.expected_history_epoch_id=dependency.history_epoch_id
    AND parent.destination_origin=dependency.destination_origin
    AND parent.external_canonical_id=dependency.parent_external_canonical_id AND parent.state='acknowledged'
  JOIN operations_directory_effective_materializations materialization ON materialization.intent_id=parent.intent_id
    AND materialization.history_epoch_id=dependency.history_epoch_id
  JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
    AND outbox.state='acknowledged' AND outbox.source_id=dependency.source_id
    AND outbox.expected_source_instance_id=dependency.source_instance_uuid
    AND outbox.application_id=dependency.application_uuid AND outbox.expected_history_epoch_id=dependency.history_epoch_id
    AND outbox.destination_base_url=dependency.destination_origin AND outbox.resource_type='organization'
    AND outbox.external_id=dependency.parent_external_canonical_id
  JOIN project_alpha_directory_mappings mapping ON mapping.source_id=dependency.source_id
    AND mapping.source_instance_id=dependency.source_instance_uuid AND mapping.application_id=dependency.application_uuid
    AND mapping.history_epoch_id=dependency.history_epoch_id AND mapping.resource_type='organization'
    AND mapping.external_id=dependency.parent_external_canonical_id
    AND mapping.project_alpha_public_id=json_extract(outbox.outcome_json,'$.response.result.data.publicId')
  WHERE dependency.evidence_kind='parent_intent'
    AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
    AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=dependency.history_epoch_id
    AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=dependency.source_instance_uuid
    AND json_extract(outbox.outcome_json,'$.response.applicationId')=dependency.application_uuid
    AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
    AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=dependency.parent_external_canonical_id
UNION ALL
SELECT dependency.*,mapping.project_alpha_public_id
  FROM operations_directory_intent_relationship_dependencies dependency
  JOIN project_alpha_directory_mappings mapping ON mapping.source_id=dependency.source_id
    AND mapping.source_instance_id=dependency.source_instance_uuid
    AND mapping.application_id=dependency.application_uuid AND mapping.history_epoch_id=dependency.history_epoch_id
    AND mapping.resource_type='organization' AND mapping.external_id=dependency.parent_external_canonical_id
    AND mapping.project_alpha_public_id=dependency.parent_public_id
  JOIN project_alpha_directory_outbox outbox ON outbox.command_id=dependency.parent_mapping_command_id
    AND outbox.state='acknowledged' AND outbox.command_json IS dependency.parent_ack_command_json
    AND outbox.outcome_json IS dependency.parent_ack_outcome_json
    AND outbox.source_id=dependency.source_id AND outbox.expected_source_instance_id=dependency.source_instance_uuid
    AND outbox.application_id=dependency.application_uuid AND outbox.expected_history_epoch_id=dependency.history_epoch_id
    AND outbox.destination_base_url=dependency.destination_origin AND outbox.resource_type='organization'
    AND outbox.external_id=dependency.parent_external_canonical_id
  WHERE dependency.evidence_kind='existing_mapping'
    AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
    AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=dependency.history_epoch_id
    AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=dependency.source_instance_uuid
    AND json_extract(outbox.outcome_json,'$.response.applicationId')=dependency.application_uuid
    AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
    AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=dependency.parent_external_canonical_id
    AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')=dependency.parent_ack_revision
    AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=dependency.parent_public_id
UNION ALL
SELECT dependency.*,mapping.project_alpha_public_id
  FROM operations_directory_intent_relationship_dependencies dependency
  JOIN project_alpha_active_directory_mappings mapping
    ON mapping.mapping_kind='acquired' AND mapping.provenance_id=dependency.parent_activation_id
    AND mapping.source_id=dependency.source_id AND mapping.source_instance_id=dependency.source_instance_uuid
    AND mapping.application_id=dependency.application_uuid AND mapping.history_epoch_id=dependency.history_epoch_id
    AND mapping.resource_type='organization' AND mapping.external_id=dependency.parent_external_canonical_id
    AND mapping.project_alpha_public_id=dependency.parent_public_id
  JOIN project_alpha_existing_directory_binding_activation_receipts activation
    ON activation.activation_id=dependency.parent_activation_id
    AND activation.source_id=dependency.source_id AND activation.source_instance_id=dependency.source_instance_uuid
    AND activation.application_id=dependency.application_uuid AND activation.history_epoch_id=dependency.history_epoch_id
    AND activation.resource_type='organization' AND activation.external_id=dependency.parent_external_canonical_id
    AND activation.project_alpha_public_id=dependency.parent_public_id
    AND activation.project_alpha_revision=dependency.parent_ack_revision
  WHERE dependency.evidence_kind='acquired_mapping';

DROP TRIGGER operations_directory_materializations_reserve;
CREATE TRIGGER operations_directory_materializations_reserve AFTER INSERT ON operations_directory_materializations
BEGIN
  SELECT RAISE(ABORT,'directory materialization history epoch is invalid')
    WHERE NEW.history_epoch_id IS NULL OR length(NEW.history_epoch_id)<>36
    OR substr(NEW.history_epoch_id,9,1)<>'-' OR substr(NEW.history_epoch_id,14,1)<>'-'
    OR substr(NEW.history_epoch_id,15,1)<>'4' OR substr(NEW.history_epoch_id,19,1)<>'-'
    OR substr(NEW.history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.history_epoch_id,24,1)<>'-'
    OR length(replace(NEW.history_epoch_id,'-',''))<>32
    OR replace(NEW.history_epoch_id,'-','') GLOB '*[^0-9a-f]*';
  SELECT RAISE(ABORT,'directory intent is not ready')
    WHERE (SELECT state FROM operations_directory_intents WHERE intent_id=NEW.intent_id) IS NOT 'ready';
  SELECT RAISE(ABORT,'directory predecessor is not acknowledged')
    WHERE EXISTS(SELECT 1 FROM operations_directory_intents i WHERE i.intent_id=NEW.intent_id
      AND i.predecessor_intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations_directory_intents p
        JOIN operations_directory_effective_materializations m ON m.intent_id=p.intent_id
        JOIN project_alpha_directory_outbox o ON o.command_id=m.command_id
        WHERE p.intent_id=i.predecessor_intent_id AND p.state='acknowledged' AND o.state='acknowledged'
          AND p.expected_history_epoch_id=i.expected_history_epoch_id AND m.history_epoch_id=i.expected_history_epoch_id
          AND o.expected_history_epoch_id=i.expected_history_epoch_id
          AND json_extract(o.outcome_json,'$.status')='acknowledged'
          AND json_extract(o.outcome_json,'$.response.historyEpoch')=i.expected_history_epoch_id));
  SELECT RAISE(ABORT,'directory materialization metadata changed')
    WHERE NOT EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    JOIN operations_directory_audit a ON a.mutation_id=i.mutation_id
    WHERE i.intent_id=NEW.intent_id AND i.expected_history_epoch_id=NEW.history_epoch_id
      AND json_extract(NEW.disposition_json,'$.historyEpoch')=i.expected_history_epoch_id
      AND json_extract(NEW.command_json,'$.commandId')=NEW.command_id
      AND json_extract(NEW.command_json,'$.resourceType')=r.record_kind
      AND json_extract(NEW.command_json,'$.externalId')=i.external_canonical_id
      AND json_extract(NEW.disposition_json,'$.sourceId')=i.source_id
      AND json_extract(NEW.disposition_json,'$.sourceInstanceUUID')=i.source_instance_uuid
      AND json_extract(NEW.disposition_json,'$.applicationUUID')=i.application_uuid
      AND json_extract(NEW.disposition_json,'$.origin')=i.destination_origin
      AND json_extract(NEW.disposition_json,'$.externalCanonicalId')=i.external_canonical_id
      AND json_extract(NEW.origin_snapshot_json,'$.actorId')=a.actor_id
      AND json_extract(NEW.origin_snapshot_json,'$.authorityRevision')=CAST(i.record_version AS TEXT)
      AND ((r.record_kind='client' AND json_remove(json_extract(NEW.command_json,'$.fields'),'$.organizationPublicId')=json(i.desired_payload_json))
        OR (r.record_kind<>'client' AND json_extract(NEW.command_json,'$.fields')=json(i.desired_payload_json))));
  SELECT RAISE(ABORT,'directory materialization disposition is invalid')
    WHERE json_extract(NEW.disposition_json,'$.kind') IS NULL
      OR json_extract(NEW.disposition_json,'$.kind') NOT IN ('authorized_create','existing');
  SELECT RAISE(ABORT,'directory create mapping conflict')
    WHERE EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    WHERE i.intent_id=NEW.intent_id AND json_extract(NEW.disposition_json,'$.kind')='authorized_create'
      AND (json_extract(NEW.command_json,'$.operation') IS NOT 'create' OR json_extract(NEW.command_json,'$.expectedRevision') IS NOT '0'
        OR EXISTS(SELECT 1 FROM project_alpha_directory_mappings x WHERE x.source_id=i.source_id AND x.source_instance_id=i.source_instance_uuid
          AND x.application_id=i.application_uuid AND x.resource_type=r.record_kind AND x.external_id=i.external_canonical_id)));
  SELECT RAISE(ABORT,'directory existing mapping conflict')
    WHERE EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    WHERE i.intent_id=NEW.intent_id AND json_extract(NEW.disposition_json,'$.kind')='existing'
      AND (json_extract(NEW.command_json,'$.operation') IS NOT 'update'
        OR json_extract(NEW.command_json,'$.expectedProjectAlphaPublicId') IS NOT json_extract(NEW.disposition_json,'$.projectAlphaPublicId')
        OR json_extract(NEW.command_json,'$.expectedRevision') IS NOT json_extract(NEW.disposition_json,'$.projectAlphaRevision')
        OR EXISTS(SELECT 1 FROM project_alpha_directory_mappings x WHERE x.source_id=i.source_id AND x.source_instance_id=i.source_instance_uuid
          AND x.application_id=i.application_uuid AND x.resource_type=r.record_kind AND x.external_id=i.external_canonical_id
          AND x.project_alpha_public_id IS NOT json_extract(NEW.disposition_json,'$.projectAlphaPublicId'))));
  SELECT RAISE(ABORT,'directory predecessor proof conflict')
    WHERE EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    JOIN operations_directory_intents p ON p.intent_id=i.predecessor_intent_id
    JOIN operations_directory_effective_materializations m ON m.intent_id=p.intent_id
    JOIN project_alpha_directory_outbox o ON o.command_id=m.command_id
    WHERE i.intent_id=NEW.intent_id AND (p.record_id IS NOT i.record_id OR p.source_id IS NOT i.source_id
      OR p.source_instance_uuid IS NOT i.source_instance_uuid OR p.application_uuid IS NOT i.application_uuid
      OR p.destination_origin IS NOT i.destination_origin OR p.external_canonical_id IS NOT i.external_canonical_id
      OR p.expected_history_epoch_id IS NOT i.expected_history_epoch_id
      OR m.history_epoch_id IS NOT i.expected_history_epoch_id OR o.expected_history_epoch_id IS NOT i.expected_history_epoch_id
      OR json_extract(o.outcome_json,'$.response.historyEpoch') IS NOT i.expected_history_epoch_id
      OR json_extract(NEW.disposition_json,'$.kind') IS NOT 'existing'
      OR json_extract(NEW.disposition_json,'$.projectAlphaPublicId') IS NOT json_extract(o.outcome_json,'$.response.result.data.publicId')
      OR json_extract(NEW.disposition_json,'$.projectAlphaRevision') IS NOT json_extract(o.outcome_json,'$.response.result.resource.revision')
      OR json_extract(NEW.command_json,'$.operation') IS NOT 'update'
      OR json_extract(NEW.command_json,'$.expectedProjectAlphaPublicId') IS NOT json_extract(o.outcome_json,'$.response.result.data.publicId')
      OR json_extract(NEW.command_json,'$.expectedRevision') IS NOT json_extract(o.outcome_json,'$.response.result.resource.revision')));
  INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,
    command_json,destination_base_url,expected_source_instance_id,expected_history_epoch_id,origin_snapshot_json,next_attempt_at)
  SELECT NEW.command_id,i.source_id,i.application_uuid,r.record_kind,i.external_canonical_id,
    NEW.command_json,i.destination_origin,i.source_instance_uuid,NEW.history_epoch_id,NEW.origin_snapshot_json,NEW.next_attempt_at
  FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id WHERE i.intent_id=NEW.intent_id;
  UPDATE operations_directory_intents SET state='materialized' WHERE intent_id=NEW.intent_id AND state='ready';
  SELECT RAISE(ABORT,'directory intent materialization race') WHERE changes()<>1;
END;

DROP TRIGGER operations_directory_intent_relationship_dependencies_insert_guard;
CREATE TRIGGER operations_directory_intent_relationship_dependencies_insert_guard
BEFORE INSERT ON operations_directory_intent_relationship_dependencies
WHEN EXISTS(SELECT 1 FROM operations_directory_intent_relationship_dependencies WHERE intent_id=NEW.intent_id)
  OR NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
    JOIN operations_directory_records client ON client.record_id=intent.record_id AND client.record_kind='client'
    JOIN operations_directory_client_organization_history history
      ON history.client_record_id=intent.record_id AND history.relationship_version=NEW.relationship_version
    JOIN operations_directory_client_organizations current_relation
      ON current_relation.client_record_id=intent.record_id AND current_relation.relationship_version=NEW.relationship_version
    JOIN operations_directory_live_write_fences fence
      ON fence.mutation_id=intent.mutation_id AND fence.record_id=intent.record_id
      AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=0 AND fence.intent_writes=0
    WHERE intent.intent_id=NEW.intent_id AND intent.record_id=NEW.client_record_id
      AND intent.record_version=NEW.client_record_version
      AND history.mutation_id=NEW.relationship_mutation_id
      AND history.client_record_version<=NEW.client_record_version
      AND history.organization_record_id IS NEW.organization_record_id
      AND current_relation.organization_record_id IS NEW.organization_record_id
      AND intent.source_id=NEW.source_id AND intent.source_instance_uuid=NEW.source_instance_uuid
      AND intent.application_uuid=NEW.application_uuid AND intent.expected_history_epoch_id=NEW.history_epoch_id
      AND intent.destination_origin=NEW.destination_origin
      AND ((NEW.evidence_kind='unlinked' AND NEW.organization_record_id IS NULL)
        OR (NEW.organization_record_id IS NOT NULL AND EXISTS(
          SELECT 1 FROM operations_directory_records parent
          JOIN operations_directory_revisions parent_revision
            ON parent_revision.record_id=parent.record_id AND parent_revision.version=NEW.organization_record_version
          JOIN native_directory_enrollments enrollment ON enrollment.record_id=parent.record_id
          WHERE parent.record_id=NEW.organization_record_id AND parent.record_kind='organization'
            AND parent.current_version=NEW.organization_record_version
            AND EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) destination
              WHERE json_extract(destination.value,'$.sourceId')=NEW.source_id
                AND json_extract(destination.value,'$.sourceInstanceUUID')=NEW.source_instance_uuid
                AND json_extract(destination.value,'$.applicationUUID')=NEW.application_uuid
                AND json_extract(destination.value,'$.historyEpoch')=NEW.history_epoch_id
                AND json_extract(destination.value,'$.origin')=NEW.destination_origin
                AND ((NEW.evidence_kind='acquired_mapping'
                    AND json_extract(destination.value,'$.externalCanonicalId')=NEW.organization_record_id)
                  OR (NEW.evidence_kind<>'acquired_mapping'
                    AND json_extract(destination.value,'$.externalCanonicalId')=NEW.parent_external_canonical_id)))
        ))))
  OR (NEW.evidence_kind='parent_intent' AND NOT EXISTS(
    SELECT 1 FROM operations_directory_intents parent
    JOIN operations_directory_records record ON record.record_id=parent.record_id AND record.record_kind='organization'
    WHERE parent.intent_id=NEW.parent_intent_id AND parent.record_id=NEW.organization_record_id
      AND parent.record_version=NEW.organization_record_version
      AND parent.source_id=NEW.source_id AND parent.source_instance_uuid=NEW.source_instance_uuid
      AND parent.application_uuid=NEW.application_uuid AND parent.expected_history_epoch_id=NEW.history_epoch_id
      AND parent.destination_origin=NEW.destination_origin
      AND parent.external_canonical_id=NEW.parent_external_canonical_id))
  OR (NEW.evidence_kind='existing_mapping' AND NOT EXISTS(
    SELECT 1 FROM project_alpha_directory_mappings mapping
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=mapping.command_id
    WHERE mapping.command_id=NEW.parent_mapping_command_id
      AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_uuid
      AND mapping.application_id=NEW.application_uuid AND mapping.history_epoch_id=NEW.history_epoch_id
      AND mapping.resource_type='organization' AND mapping.external_id=NEW.parent_external_canonical_id
      AND mapping.project_alpha_public_id=NEW.parent_public_id
      AND outbox.state='acknowledged' AND outbox.command_json IS NEW.parent_ack_command_json
      AND outbox.outcome_json IS NEW.parent_ack_outcome_json
      AND outbox.source_id=NEW.source_id AND outbox.expected_source_instance_id=NEW.source_instance_uuid
      AND outbox.application_id=NEW.application_uuid AND outbox.expected_history_epoch_id=NEW.history_epoch_id
      AND outbox.destination_base_url=NEW.destination_origin
      AND outbox.resource_type='organization' AND outbox.external_id=NEW.parent_external_canonical_id
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=NEW.history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=NEW.source_instance_uuid
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=NEW.application_uuid
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=NEW.parent_external_canonical_id
      AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')=NEW.parent_ack_revision
      AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=NEW.parent_public_id))
  OR (NEW.evidence_kind='acquired_mapping' AND NOT EXISTS(
    SELECT 1
    FROM project_alpha_existing_directory_binding_activation_receipts activation
    JOIN project_alpha_active_directory_mappings mapping
      ON mapping.mapping_kind='acquired' AND mapping.provenance_id=activation.activation_id
      AND mapping.record_id=activation.record_id
      AND mapping.source_id=activation.source_id AND mapping.source_instance_id=activation.source_instance_id
      AND mapping.application_id=activation.application_id AND mapping.history_epoch_id=activation.history_epoch_id
      AND mapping.resource_type='organization' AND mapping.external_id=activation.external_id
      AND mapping.project_alpha_public_id=activation.project_alpha_public_id
    WHERE activation.activation_id=NEW.parent_activation_id
      AND activation.record_id=NEW.organization_record_id
      AND activation.source_id=NEW.source_id AND activation.source_instance_id=NEW.source_instance_uuid
      AND activation.application_id=NEW.application_uuid AND activation.history_epoch_id=NEW.history_epoch_id
      AND activation.resource_type='organization' AND activation.external_id=NEW.parent_external_canonical_id
      AND activation.project_alpha_public_id=NEW.parent_public_id
      AND activation.project_alpha_revision=NEW.parent_ack_revision
      AND (activation.local_record_version=NEW.organization_record_version OR EXISTS(
        SELECT 1 FROM operations_directory_intents updated
        JOIN operations_directory_effective_materializations materialization ON materialization.intent_id=updated.intent_id
          AND materialization.history_epoch_id=updated.expected_history_epoch_id
        JOIN operations_directory_audit audit ON audit.mutation_id=updated.mutation_id
          AND audit.record_id=updated.record_id AND audit.record_version=updated.record_version
          AND audit.actor_type='staff' AND json_extract(audit.command_json,'$.operation')='update'
        JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
          AND outbox.state='acknowledged' AND outbox.command_json=materialization.command_json
          AND outbox.source_id=updated.source_id
          AND outbox.expected_source_instance_id=updated.source_instance_uuid AND outbox.application_id=updated.application_uuid
          AND outbox.expected_history_epoch_id=updated.expected_history_epoch_id
          AND outbox.destination_base_url=updated.destination_origin AND outbox.resource_type='organization'
          AND outbox.external_id=updated.external_canonical_id
        WHERE updated.record_id=NEW.organization_record_id AND updated.record_version=NEW.organization_record_version
          AND updated.state='acknowledged' AND updated.source_id=NEW.source_id
          AND updated.source_instance_uuid=NEW.source_instance_uuid AND updated.application_uuid=NEW.application_uuid
          AND updated.expected_history_epoch_id=NEW.history_epoch_id AND updated.destination_origin=NEW.destination_origin
          AND updated.external_canonical_id=NEW.parent_external_canonical_id
          AND json_extract(outbox.command_json,'$.operation')='update'
          AND json_extract(outbox.command_json,'$.resourceType')='organization'
          AND json_extract(outbox.command_json,'$.externalId')=NEW.parent_external_canonical_id
          AND json_extract(outbox.command_json,'$.expectedProjectAlphaPublicId')=NEW.parent_public_id
          AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
          AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=NEW.source_instance_uuid
          AND json_extract(outbox.outcome_json,'$.response.applicationId')=NEW.application_uuid
          AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=NEW.history_epoch_id
          AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=NEW.parent_public_id
          AND json_type(outbox.outcome_json,'$.response.result.resource.revision')='text'
          AND length(json_extract(outbox.outcome_json,'$.response.result.resource.revision')) BETWEEN 1 AND 19
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision') NOT GLOB '*[^0-9]*'
          AND substr(json_extract(outbox.outcome_json,'$.response.result.resource.revision'),1,1)<>'0'
      ))))
BEGIN SELECT RAISE(ABORT,'directory intent relationship dependency requires live canonical evidence'); END;

DROP VIEW project_alpha_directory_relationship_revision_evidence;
CREATE VIEW project_alpha_directory_relationship_revision_evidence AS
SELECT intent.record_id,outbox.resource_type AS record_kind,intent.record_version,
  intent.source_id,intent.source_instance_uuid AS source_instance_id,intent.application_uuid AS application_id,
  intent.expected_history_epoch_id AS history_epoch_id,intent.destination_origin,
  json_extract(outbox.outcome_json,'$.response.result.resource.publicId') AS public_id,
  json_extract(outbox.outcome_json,'$.response.result.resource.revision') AS revision,
  CASE WHEN json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')=outbox.resource_type
      AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=outbox.external_id
      AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=
        json_extract(outbox.outcome_json,'$.response.result.resource.publicId') THEN 1 ELSE 0 END AS identity_valid
FROM operations_directory_intents intent
JOIN operations_directory_effective_materializations materialization ON materialization.intent_id=intent.intent_id
JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
WHERE intent.state='acknowledged' AND outbox.state='acknowledged'
  AND outbox.source_id=intent.source_id AND outbox.expected_source_instance_id=intent.source_instance_uuid
  AND outbox.application_id=intent.application_uuid AND outbox.expected_history_epoch_id=intent.expected_history_epoch_id
  AND outbox.destination_base_url=intent.destination_origin AND outbox.external_id=intent.external_canonical_id
UNION ALL
SELECT relationship.client_record_id,'client',history.client_record_version,
  relationship.source_id,relationship.source_instance_id,relationship.application_id,relationship.history_epoch_id,
  relationship.destination_origin,json_extract(relationship.outcome_json,'$.response.result.client.publicId'),
  json_extract(relationship.outcome_json,'$.response.result.client.revision'),
  CASE WHEN json_extract(relationship.outcome_json,'$.response.sourceInstanceId')=relationship.source_instance_id
      AND json_extract(relationship.outcome_json,'$.response.applicationId')=relationship.application_id
      AND json_extract(relationship.outcome_json,'$.response.historyEpoch')=relationship.history_epoch_id
      AND json_extract(relationship.outcome_json,'$.response.result.action')=relationship.action
      AND json_extract(relationship.outcome_json,'$.response.result.client.publicId')=relationship.client_public_id
      AND json_extract(relationship.outcome_json,'$.response.result.organizationPublicId') IS relationship.organization_public_id
    THEN 1 ELSE 0 END
FROM project_alpha_directory_relationship_outbox relationship
JOIN operations_directory_client_organization_history history
  ON history.client_record_id=relationship.client_record_id AND history.relationship_version=relationship.relationship_version
WHERE relationship.state='acknowledged'
UNION ALL
SELECT refresh.record_id,refresh.resource_type,refresh.local_record_version,refresh.source_id,refresh.source_instance_id,
  refresh.application_id,refresh.history_epoch_id,
  response.destination_origin,refresh.project_alpha_public_id,refresh.live_revision,1
FROM project_alpha_existing_directory_binding_revision_refresh_receipts refresh
JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=refresh.native_owner_claim_id
JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=claim.receipt_id
JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
UNION ALL
SELECT activation.record_id,activation.resource_type,activation.local_record_version,activation.source_id,activation.source_instance_id,
  activation.application_id,activation.history_epoch_id,response.destination_origin,activation.project_alpha_public_id,
  activation.project_alpha_revision,1
FROM project_alpha_existing_directory_binding_activation_receipts activation
JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=activation.acquired_receipt_id
JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id;
