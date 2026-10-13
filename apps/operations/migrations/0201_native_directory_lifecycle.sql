PRAGMA foreign_keys = ON;

-- Existing records deliberately receive no row. Their active/archived state
-- predates this authority and must be reviewed from an authoritative source.
-- Only a consumed, reviewed native create admission enrolls a new record as
-- active. A newly materialized/imported record does not acquire lifecycle
-- state merely because it was inserted locally.
CREATE TABLE operations_directory_lifecycle_state (
  record_id TEXT NOT NULL PRIMARY KEY REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  lifecycle_version INTEGER NOT NULL CHECK(typeof(lifecycle_version)='integer' AND lifecycle_version BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('active','archive_pending','archived','restore_pending','restored_unbound','conflicted')),
  last_mutation_id TEXT,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((lifecycle_version=0 AND status='active' AND last_mutation_id IS NULL)
    OR (lifecycle_version>0 AND last_mutation_id IS NOT NULL))
);
CREATE TRIGGER operations_directory_lifecycle_native_create AFTER INSERT ON operations_directory_revisions
WHEN NEW.version=1
  AND EXISTS(SELECT 1 FROM native_directory_create_admissions admission
    WHERE admission.record_id=NEW.record_id AND admission.active=0 AND admission.consumed_mutation_id=NEW.mutation_id)
  AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state WHERE state.record_id=NEW.record_id)
BEGIN
  INSERT INTO operations_directory_lifecycle_state(record_id,lifecycle_version,status)
  VALUES(NEW.record_id,0,'active');
END;

CREATE TABLE operations_directory_lifecycle_fences (
  mutation_id TEXT NOT NULL PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  action TEXT NOT NULL CHECK(action IN ('archive','restore')),
  expected_lifecycle_version INTEGER NOT NULL CHECK(typeof(expected_lifecycle_version)='integer' AND expected_lifecycle_version>=0),
  expected_record_version INTEGER NOT NULL CHECK(typeof(expected_record_version)='integer' AND expected_record_version>=1),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL,
  actor_email TEXT NOT NULL,
  actor_profile_version INTEGER NOT NULL,
  selected_profile_grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  selected_enrollment_grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_type(destinations_json)='array'),
  observations_json TEXT NOT NULL CHECK(json_valid(observations_json) AND json_type(observations_json)='array'),
  verified_until TEXT NOT NULL CHECK(verified_until=strftime('%Y-%m-%dT%H:%M:%fZ',verified_until)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_directory_lifecycle_observation_sets (
  mutation_id TEXT NOT NULL PRIMARY KEY,
  record_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  action TEXT NOT NULL CHECK(action IN ('archive','restore')),
  observations_json TEXT NOT NULL CHECK(json_valid(observations_json) AND json_type(observations_json)='array'),
  verified_until TEXT NOT NULL CHECK(verified_until=strftime('%Y-%m-%dT%H:%M:%fZ',verified_until)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER operations_directory_lifecycle_observation_sets_insert_guard BEFORE INSERT
ON operations_directory_lifecycle_observation_sets
WHEN NEW.action='archive' AND EXISTS(SELECT 1 FROM json_each(NEW.observations_json) proof
  WHERE NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations observation
    JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id
      AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id
      AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='directory'
      AND receipt.request_id=observation.request_id
    WHERE observation.source_id=json_extract(proof.value,'$.sourceId')
      AND observation.source_instance_id=json_extract(proof.value,'$.sourceInstanceUUID')
      AND observation.application_id=json_extract(proof.value,'$.applicationUUID')
      AND observation.history_epoch_id=json_extract(proof.value,'$.historyEpoch')
      AND observation.resource_type=NEW.record_kind
      AND observation.project_alpha_public_id=json_extract(proof.value,'$.publicId')
      AND observation.resource_revision=json_extract(proof.value,'$.revision')
      AND observation.present=1 AND observation.last_action='upsert'
      AND observation.binding_external_id=json_extract(proof.value,'$.externalCanonicalId')
      AND observation.binding_status='active' AND observation.binding_resource_revision=observation.resource_revision
      AND receipt.authorization_generation=json_extract(proof.value,'$.authorizationGeneration')
      AND receipt.request_id=json_extract(proof.value,'$.requestId')
      AND receipt.observed_at=json_extract(proof.value,'$.observedAt')
      AND receipt.observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')
      AND receipt.observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
        WHERE conflict.source_id=observation.source_id AND conflict.source_instance_id=observation.source_instance_id
          AND conflict.application_id=observation.application_id AND conflict.history_epoch_id=observation.history_epoch_id
          AND conflict.inventory_kind='directory' AND conflict.resource_type=observation.resource_type
          AND conflict.project_alpha_public_id=observation.project_alpha_public_id)))
BEGIN SELECT RAISE(ABORT,'directory lifecycle observations are not fresh exact authority'); END;
CREATE TRIGGER operations_directory_lifecycle_observation_sets_no_update BEFORE UPDATE ON operations_directory_lifecycle_observation_sets
BEGIN SELECT RAISE(ABORT,'directory lifecycle observation sets are immutable'); END;
CREATE TRIGGER operations_directory_lifecycle_observation_sets_no_delete BEFORE DELETE ON operations_directory_lifecycle_observation_sets
BEGIN SELECT RAISE(ABORT,'directory lifecycle observation sets are durable'); END;

CREATE VIEW operations_directory_live_lifecycle_fences AS
SELECT fence.* FROM operations_directory_lifecycle_fences fence
JOIN operations_directory_lifecycle_observation_sets proof ON proof.mutation_id=fence.mutation_id
  AND proof.record_id=fence.record_id AND proof.record_kind=fence.record_kind AND proof.action=fence.action
  AND json(proof.observations_json)=json(fence.observations_json) AND proof.verified_until=fence.verified_until
JOIN operations_directory_records record ON record.record_id=fence.record_id
  AND record.record_kind=fence.record_kind AND record.current_version=fence.expected_record_version
LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=fence.record_id
JOIN native_directory_enrollments enrollment ON enrollment.record_id=fence.record_id
  AND json(enrollment.destinations_json)=json(fence.destinations_json)
JOIN native_staff_admissions admission ON admission.staff_id=fence.actor_staff_id AND admission.active=1
  AND admission.bound_access_subject=fence.actor_access_subject AND admission.version=fence.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=fence.actor_staff_id
  AND profile.login_email=fence.actor_email AND profile.version=fence.actor_profile_version
JOIN staff_users staff ON staff.id=fence.actor_staff_id AND staff.status='active'
  AND staff.access_subject=fence.actor_access_subject
WHERE fence.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
    JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
    WHERE intent.record_id=fence.record_id AND (intent.state<>'acknowledged' OR outbox.state<>'acknowledged'))
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
    JOIN project_alpha_directory_relationship_outbox outbox ON outbox.command_id=resource.command_id
    WHERE resource.record_id=fence.record_id AND outbox.state<>'acknowledged')
  AND NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_commands command
    WHERE command.record_id=fence.record_id AND NOT EXISTS(
      SELECT 1 FROM project_alpha_existing_directory_binding_acquired_mapping_receipts acquired
      JOIN project_alpha_existing_directory_binding_activation_receipts activation
        ON activation.acquired_receipt_id=acquired.receipt_id
      WHERE acquired.command_id=command.command_id AND activation.record_id=command.record_id))
  AND ((lifecycle.lifecycle_version=fence.expected_lifecycle_version
      AND ((fence.action='archive' AND lifecycle.status='active') OR (fence.action='restore' AND lifecycle.status='archived')))
    OR (lifecycle.record_id IS NULL AND fence.action='archive' AND fence.expected_lifecycle_version=0))
  AND NOT EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
    LEFT JOIN native_business_areas area ON area.id=scope.business_area_id
    LEFT JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id
    WHERE scope.record_id=fence.record_id AND scope.active=1
      AND (coalesce(area.active,0)<>1 OR (scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
  AND EXISTS(SELECT 1 FROM native_directory_grants allow_row
        WHERE allow_row.id=fence.selected_profile_grant_id AND allow_row.staff_id=fence.actor_staff_id
          AND allow_row.permission='directory.profile.edit' AND allow_row.effect='allow' AND allow_row.active=1
          AND (allow_row.scope_kind='global'
            OR (allow_row.scope_kind='resource' AND allow_row.resource_id=fence.record_id)
            OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_staff_id AND assignment.active=1))
            OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
            OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
        WHERE deny_row.staff_id=fence.actor_staff_id AND deny_row.permission='directory.profile.edit'
          AND deny_row.effect='deny' AND deny_row.active=1
          AND (deny_row.scope_kind='global'
            OR (deny_row.scope_kind='resource' AND deny_row.resource_id=fence.record_id)
            OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_staff_id AND assignment.active=1))
            OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=deny_row.business_area_id))
            OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=deny_row.division_id))))
  AND EXISTS(SELECT 1 FROM native_directory_grants allow_row
        WHERE allow_row.id=fence.selected_enrollment_grant_id AND allow_row.staff_id=fence.actor_staff_id
          AND allow_row.permission='directory.enrollment.manage' AND allow_row.effect='allow' AND allow_row.active=1
          AND (allow_row.scope_kind='global'
            OR (allow_row.scope_kind='resource' AND allow_row.resource_id=fence.record_id)
            OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_staff_id AND assignment.active=1))
            OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
            OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
        WHERE deny_row.staff_id=fence.actor_staff_id AND deny_row.permission='directory.enrollment.manage'
          AND deny_row.effect='deny' AND deny_row.active=1
          AND (deny_row.scope_kind='global'
            OR (deny_row.scope_kind='resource' AND deny_row.resource_id=fence.record_id)
            OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_staff_id AND assignment.active=1))
            OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=deny_row.business_area_id))
            OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=deny_row.division_id))));

CREATE TABLE operations_directory_lifecycle_events (
  mutation_id TEXT NOT NULL PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  lifecycle_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('archive','restore')),
  expected_lifecycle_version INTEGER NOT NULL,
  expected_record_version INTEGER NOT NULL,
  actor_staff_id TEXT NOT NULL,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL,
  actor_email TEXT NOT NULL,
  actor_profile_version INTEGER NOT NULL,
  selected_profile_grant_id TEXT NOT NULL,
  selected_enrollment_grant_id TEXT NOT NULL,
  destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_type(destinations_json)='array'),
  observations_json TEXT NOT NULL CHECK(json_valid(observations_json) AND json_type(observations_json)='array'),
  actor_verified_until TEXT NOT NULL CHECK(actor_verified_until=strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(record_id,lifecycle_version),
  CHECK(lifecycle_version=expected_lifecycle_version+1)
);

CREATE TABLE project_alpha_directory_lifecycle_outbox (
  command_id TEXT NOT NULL PRIMARY KEY,
  mutation_id TEXT NOT NULL REFERENCES operations_directory_lifecycle_events(mutation_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL,
  lifecycle_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('archive','restore')),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:'),
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  destination_origin TEXT NOT NULL CHECK(substr(destination_origin,1,8)='https://'),
  external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  expected_revision TEXT NOT NULL,
  expected_authorization_generation TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK(json_valid(command_json) AND json_type(command_json)='object'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','acknowledged','terminal')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  lease_token TEXT,
  lease_expires_at INTEGER,
  outcome_json TEXT CHECK(outcome_json IS NULL OR (json_valid(outcome_json) AND json_type(outcome_json)='object')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(record_id,lifecycle_version) REFERENCES operations_directory_lifecycle_events(record_id,lifecycle_version) ON DELETE RESTRICT,
  UNIQUE(mutation_id,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,external_id),
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((state IN ('acknowledged','terminal'))=(outcome_json IS NOT NULL))
);
CREATE INDEX project_alpha_directory_lifecycle_outbox_ready
  ON project_alpha_directory_lifecycle_outbox(state,next_attempt_at,lease_expires_at,created_at);

CREATE TRIGGER operations_directory_lifecycle_fences_no_update BEFORE UPDATE ON operations_directory_lifecycle_fences
BEGIN SELECT RAISE(ABORT,'directory lifecycle fence is immutable'); END;
CREATE TRIGGER operations_directory_lifecycle_fences_complete BEFORE DELETE ON operations_directory_lifecycle_fences
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_events event WHERE event.mutation_id=OLD.mutation_id)
  OR NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state WHERE state.record_id=OLD.record_id
    AND state.lifecycle_version=OLD.expected_lifecycle_version+1 AND state.last_mutation_id=OLD.mutation_id
    AND state.status=CASE OLD.action WHEN 'archive' THEN 'archive_pending' ELSE 'restore_pending' END)
  OR (SELECT count(*) FROM project_alpha_directory_lifecycle_outbox WHERE mutation_id=OLD.mutation_id)<>
    (SELECT count(*) FROM json_each(OLD.destinations_json))
BEGIN SELECT RAISE(ABORT,'directory lifecycle fence is not complete'); END;

CREATE TRIGGER operations_directory_lifecycle_events_insert_guard BEFORE INSERT ON operations_directory_lifecycle_events
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_lifecycle_fences fence
  WHERE fence.mutation_id=NEW.mutation_id AND fence.record_id=NEW.record_id AND fence.record_kind=NEW.record_kind AND fence.action=NEW.action
    AND fence.expected_lifecycle_version=NEW.expected_lifecycle_version
    AND fence.expected_record_version=NEW.expected_record_version
    AND NEW.lifecycle_version=fence.expected_lifecycle_version+1
    AND NEW.actor_staff_id=fence.actor_staff_id AND NEW.actor_access_subject=fence.actor_access_subject
    AND NEW.actor_admission_version=fence.actor_admission_version AND NEW.actor_email=fence.actor_email
    AND NEW.actor_profile_version=fence.actor_profile_version
    AND NEW.selected_profile_grant_id=fence.selected_profile_grant_id
    AND NEW.selected_enrollment_grant_id=fence.selected_enrollment_grant_id
    AND NEW.actor_verified_until>=fence.verified_until
    AND json(NEW.destinations_json)=json(fence.destinations_json)
    AND json(NEW.observations_json)=json(fence.observations_json))
BEGIN SELECT RAISE(ABORT,'directory lifecycle event requires current native authority'); END;
CREATE TRIGGER operations_directory_lifecycle_events_no_update BEFORE UPDATE ON operations_directory_lifecycle_events
BEGIN SELECT RAISE(ABORT,'directory lifecycle events are immutable'); END;
CREATE TRIGGER operations_directory_lifecycle_events_no_delete BEFORE DELETE ON operations_directory_lifecycle_events
BEGIN SELECT RAISE(ABORT,'directory lifecycle events are durable'); END;

CREATE TRIGGER operations_directory_lifecycle_state_insert_guard BEFORE INSERT ON operations_directory_lifecycle_state
WHEN NOT (NEW.lifecycle_version=0 AND NEW.status='active' AND NEW.last_mutation_id IS NULL
    AND EXISTS(SELECT 1 FROM native_directory_create_admissions admission
      JOIN operations_directory_revisions revision ON revision.record_id=admission.record_id
        AND revision.version=1 AND revision.mutation_id=admission.consumed_mutation_id
      WHERE admission.record_id=NEW.record_id AND admission.active=0 AND admission.consumed_mutation_id IS NOT NULL))
  AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_fences fence
    JOIN operations_directory_lifecycle_events event ON event.mutation_id=fence.mutation_id
      AND event.record_id=fence.record_id AND event.action='archive' AND event.expected_lifecycle_version=0
    WHERE fence.record_id=NEW.record_id AND NEW.lifecycle_version=0 AND NEW.status='active'
      AND NEW.last_mutation_id IS NULL)
BEGIN SELECT RAISE(ABORT,'directory lifecycle baseline requires reviewed current authority'); END;

CREATE TRIGGER operations_directory_lifecycle_state_update_guard BEFORE UPDATE ON operations_directory_lifecycle_state
WHEN NEW.record_id IS NOT OLD.record_id
  OR NOT ((NEW.lifecycle_version=OLD.lifecycle_version+1
      AND NEW.status=CASE WHEN OLD.status='active' THEN 'archive_pending' WHEN OLD.status='archived' THEN 'restore_pending' ELSE '' END
      AND EXISTS(SELECT 1 FROM operations_directory_live_lifecycle_fences fence WHERE fence.record_id=OLD.record_id
        AND fence.expected_lifecycle_version=OLD.lifecycle_version AND fence.action=CASE OLD.status WHEN 'active' THEN 'archive' ELSE 'restore' END
        AND NEW.last_mutation_id=fence.mutation_id))
    OR (NEW.lifecycle_version=OLD.lifecycle_version AND NEW.last_mutation_id=OLD.last_mutation_id
      AND NEW.status=CASE OLD.status WHEN 'archive_pending' THEN 'archived' WHEN 'restore_pending' THEN 'restored_unbound' ELSE '' END
      AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_lifecycle_outbox outbox
        WHERE outbox.mutation_id=OLD.last_mutation_id AND outbox.state<>'acknowledged')))
BEGIN SELECT RAISE(ABORT,'directory lifecycle transition requires current native authority'); END;
CREATE TRIGGER operations_directory_lifecycle_state_no_delete BEFORE DELETE ON operations_directory_lifecycle_state
BEGIN SELECT RAISE(ABORT,'directory lifecycle state is durable'); END;

CREATE TRIGGER project_alpha_directory_lifecycle_outbox_insert_guard BEFORE INSERT ON project_alpha_directory_lifecycle_outbox
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_lifecycle_fences fence,json_each(fence.destinations_json) destination,
  json_each(fence.observations_json) proof
  WHERE fence.mutation_id=NEW.mutation_id AND fence.record_id=NEW.record_id
    AND NEW.lifecycle_version=fence.expected_lifecycle_version+1 AND NEW.action=fence.action
    AND NEW.source_id=json_extract(destination.value,'$.sourceId') AND NEW.source_instance_id=json_extract(destination.value,'$.sourceInstanceUUID')
    AND NEW.application_id=json_extract(destination.value,'$.applicationUUID') AND NEW.history_epoch_id=json_extract(destination.value,'$.historyEpoch')
    AND NEW.destination_origin=json_extract(destination.value,'$.origin') AND NEW.external_id=json_extract(destination.value,'$.externalCanonicalId')
    AND json_extract(proof.value,'$.sourceId')=NEW.source_id AND json_extract(proof.value,'$.sourceInstanceUUID')=NEW.source_instance_id
    AND json_extract(proof.value,'$.applicationUUID')=NEW.application_id AND json_extract(proof.value,'$.historyEpoch')=NEW.history_epoch_id
    AND json_extract(proof.value,'$.externalCanonicalId')=NEW.external_id
    AND json_extract(proof.value,'$.publicId')=NEW.project_alpha_public_id
    AND json_extract(proof.value,'$.revision')=NEW.expected_revision
    AND json_extract(proof.value,'$.authorizationGeneration')=NEW.expected_authorization_generation
    AND ((fence.action='archive' AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
      WHERE mapping.record_id=fence.record_id AND mapping.resource_type=fence.record_kind AND mapping.source_id=NEW.source_id
        AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id
        AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.external_id=NEW.external_id
        AND mapping.project_alpha_public_id=NEW.project_alpha_public_id))
      OR (fence.action='restore' AND EXISTS(SELECT 1 FROM project_alpha_directory_lifecycle_outbox archived
        WHERE archived.record_id=fence.record_id AND archived.action='archive' AND archived.state='acknowledged'
          AND archived.mutation_id=(SELECT state.last_mutation_id FROM operations_directory_lifecycle_state state
            WHERE state.record_id=fence.record_id AND state.status='archived'
              AND state.lifecycle_version=fence.expected_lifecycle_version)
          AND archived.source_id=NEW.source_id AND archived.source_instance_id=NEW.source_instance_id
          AND archived.application_id=NEW.application_id AND archived.history_epoch_id=NEW.history_epoch_id
          AND archived.destination_origin=NEW.destination_origin AND archived.external_id=NEW.external_id
          AND archived.project_alpha_public_id=NEW.project_alpha_public_id
          AND json_extract(archived.outcome_json,'$.response.result.resource.revision')=NEW.expected_revision
          AND json_extract(archived.outcome_json,'$.response.result.authorizationGeneration')=NEW.expected_authorization_generation)))
    AND (SELECT count(*) FROM json_each(NEW.command_json))=3
    AND json_extract(NEW.command_json,'$.commandId')=NEW.command_id
    AND json_extract(NEW.command_json,'$.expectedRevision')=NEW.expected_revision
    AND json_extract(NEW.command_json,'$.expectedAuthorizationGeneration')=NEW.expected_authorization_generation
    AND (SELECT count(*) FROM json_each(NEW.request_json))=6
    AND json_extract(NEW.request_json,'$.resourceType')=fence.record_kind
    AND json_extract(NEW.request_json,'$.publicId')=NEW.project_alpha_public_id
    AND json_extract(NEW.request_json,'$.action')=NEW.action
    AND json_extract(NEW.request_json,'$.commandId')=NEW.command_id
    AND json_extract(NEW.request_json,'$.expectedRevision')=NEW.expected_revision
    AND json_extract(NEW.request_json,'$.expectedAuthorizationGeneration')=NEW.expected_authorization_generation)
BEGIN SELECT RAISE(ABORT,'directory lifecycle reservation requires exact current authority'); END;
CREATE TRIGGER project_alpha_directory_lifecycle_outbox_identity_immutable BEFORE UPDATE ON project_alpha_directory_lifecycle_outbox
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.mutation_id IS NOT OLD.mutation_id OR NEW.record_id IS NOT OLD.record_id
 OR NEW.lifecycle_version IS NOT OLD.lifecycle_version OR NEW.action IS NOT OLD.action OR NEW.source_id IS NOT OLD.source_id
 OR NEW.source_instance_id IS NOT OLD.source_instance_id OR NEW.application_id IS NOT OLD.application_id
 OR NEW.history_epoch_id IS NOT OLD.history_epoch_id OR NEW.destination_origin IS NOT OLD.destination_origin
 OR NEW.external_id IS NOT OLD.external_id OR NEW.project_alpha_public_id IS NOT OLD.project_alpha_public_id
 OR NEW.expected_revision IS NOT OLD.expected_revision OR NEW.expected_authorization_generation IS NOT OLD.expected_authorization_generation
 OR NEW.command_json IS NOT OLD.command_json OR NEW.request_json IS NOT OLD.request_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'directory lifecycle reservation is immutable'); END;
CREATE TRIGGER project_alpha_directory_lifecycle_outbox_transition_guard BEFORE UPDATE ON project_alpha_directory_lifecycle_outbox
WHEN NOT (
  (OLD.state='pending' AND NEW.state='leased' AND NEW.attempts=OLD.attempts+1
    AND NEW.next_attempt_at=OLD.next_attempt_at AND OLD.outcome_json IS NULL AND NEW.outcome_json IS NULL)
  OR (OLD.state='leased' AND NEW.state='leased' AND OLD.lease_expires_at<=CAST(unixepoch('now') AS INTEGER)*1000
    AND NEW.attempts=OLD.attempts+1 AND NEW.next_attempt_at=OLD.next_attempt_at
    AND OLD.outcome_json IS NULL AND NEW.outcome_json IS NULL)
  OR (OLD.state='leased' AND NEW.state IN ('acknowledged','terminal') AND NEW.attempts=OLD.attempts
    AND NEW.next_attempt_at=OLD.next_attempt_at AND OLD.outcome_json IS NULL AND NEW.outcome_json IS NOT NULL
    AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL)
)
BEGIN SELECT RAISE(ABORT,'directory lifecycle outbox transition is invalid'); END;
CREATE TRIGGER project_alpha_directory_lifecycle_outbox_ack_guard BEFORE UPDATE ON project_alpha_directory_lifecycle_outbox
WHEN NEW.state='acknowledged' AND OLD.state<>'acknowledged' AND coalesce((
  OLD.state='leased' AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
  AND json_extract(NEW.outcome_json,'$.status')='acknowledged'
  AND (SELECT count(*) FROM json_each(NEW.outcome_json))=2
  AND (SELECT count(*) FROM json_each(NEW.outcome_json,'$.response'))=6
  AND json_extract(NEW.outcome_json,'$.response.sourceInstanceId')=OLD.source_instance_id
  AND json_extract(NEW.outcome_json,'$.response.applicationId')=OLD.application_id
  AND json_extract(NEW.outcome_json,'$.response.historyEpoch')=OLD.history_epoch_id
  AND json_type(NEW.outcome_json,'$.response.requestId')='text'
  AND length(json_extract(NEW.outcome_json,'$.response.requestId'))=36
  AND lower(json_extract(NEW.outcome_json,'$.response.requestId'))=json_extract(NEW.outcome_json,'$.response.requestId')
  AND substr(json_extract(NEW.outcome_json,'$.response.requestId'),9,1)='-'
  AND substr(json_extract(NEW.outcome_json,'$.response.requestId'),14,1)='-'
  AND substr(json_extract(NEW.outcome_json,'$.response.requestId'),15,1)='4'
  AND substr(json_extract(NEW.outcome_json,'$.response.requestId'),19,1)='-'
  AND substr(json_extract(NEW.outcome_json,'$.response.requestId'),20,1) GLOB '[89ab]'
  AND substr(json_extract(NEW.outcome_json,'$.response.requestId'),24,1)='-'
  AND replace(json_extract(NEW.outcome_json,'$.response.requestId'),'-','') NOT GLOB '*[^0-9a-f]*'
  AND json_type(NEW.outcome_json,'$.response.replayed') IN ('true','false')
  AND (SELECT count(*) FROM json_each(NEW.outcome_json,'$.response.result'))=3
  AND json_extract(NEW.outcome_json,'$.response.result.action')=OLD.action
  AND json_type(NEW.outcome_json,'$.response.result.authorizationGeneration')='text'
  AND json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration') GLOB '[0-9]*'
  AND json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration') NOT GLOB '*[^0-9]*'
  AND (json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration')='0'
    OR substr(json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration'),1,1)<>'0')
  AND length(json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration'))<=19
  AND (length(json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration'))<19
    OR json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration')<='9223372036854775807')
  AND (length(json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration'))>length(OLD.expected_authorization_generation)
    OR (length(json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration'))=length(OLD.expected_authorization_generation)
      AND json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration')>=OLD.expected_authorization_generation))
  AND (SELECT count(*) FROM json_each(NEW.outcome_json,'$.response.result.resource'))=4
  AND json_extract(NEW.outcome_json,'$.response.result.resource.type')=(SELECT event.record_kind
    FROM operations_directory_lifecycle_events event WHERE event.mutation_id=OLD.mutation_id)
  AND json_extract(NEW.outcome_json,'$.response.result.resource.publicId')=OLD.project_alpha_public_id
  AND json_type(NEW.outcome_json,'$.response.result.resource.present')=CASE OLD.action WHEN 'restore' THEN 'true' ELSE 'false' END
  AND json_extract(NEW.outcome_json,'$.response.result.resource.present')=CASE OLD.action WHEN 'restore' THEN 1 ELSE 0 END
  AND json_type(NEW.outcome_json,'$.response.result.resource.revision')='text'
  AND json_extract(NEW.outcome_json,'$.response.result.resource.revision') GLOB '[1-9]*'
  AND json_extract(NEW.outcome_json,'$.response.result.resource.revision') NOT GLOB '*[^0-9]*'
  AND length(json_extract(NEW.outcome_json,'$.response.result.resource.revision'))<=19
  AND (length(json_extract(NEW.outcome_json,'$.response.result.resource.revision'))<19
    OR json_extract(NEW.outcome_json,'$.response.result.resource.revision')<='9223372036854775807')
  AND (length(json_extract(NEW.outcome_json,'$.response.result.resource.revision'))>length(OLD.expected_revision)
    OR (length(json_extract(NEW.outcome_json,'$.response.result.resource.revision'))=length(OLD.expected_revision)
      AND json_extract(NEW.outcome_json,'$.response.result.resource.revision')>OLD.expected_revision))
),0)=0
BEGIN SELECT RAISE(ABORT,'directory lifecycle acknowledgement is invalid'); END;
CREATE TRIGGER project_alpha_directory_lifecycle_outbox_no_delete BEFORE DELETE ON project_alpha_directory_lifecycle_outbox
BEGIN SELECT RAISE(ABORT,'directory lifecycle reservations are durable'); END;

-- Cross-writer fences. Pending/conflicted lifecycle changes freeze profile and
-- relationship mutations; archived records remain immutable until restored.
CREATE TRIGGER operations_directory_lifecycle_blocks_profile BEFORE INSERT ON operations_directory_revisions
WHEN EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state WHERE state.record_id=NEW.record_id AND state.status<>'active')
BEGIN SELECT RAISE(ABORT,'directory lifecycle blocks profile mutation'); END;
CREATE TRIGGER operations_directory_lifecycle_blocks_relationship BEFORE INSERT ON operations_directory_relationship_write_fences
WHEN EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state
  WHERE state.record_id=NEW.client_record_id AND state.status<>'active')
 OR EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state
  WHERE state.record_id IN (NEW.previous_organization_record_id,NEW.organization_record_id) AND state.status<>'active')
BEGIN SELECT RAISE(ABORT,'directory lifecycle blocks relationship mutation'); END;
CREATE TRIGGER operations_directory_lifecycle_blocks_enrollment BEFORE INSERT ON native_directory_enrollments
WHEN EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state
  WHERE state.record_id=NEW.record_id AND state.status<>'active')
BEGIN SELECT RAISE(ABORT,'directory lifecycle blocks enrollment mutation'); END;
CREATE TRIGGER operations_directory_lifecycle_blocks_mapping_acquisition BEFORE INSERT ON project_alpha_directory_mappings
WHEN EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state
  JOIN operations_directory_records record ON record.record_id=state.record_id
  WHERE state.status<>'active' AND state.record_id=NEW.external_id AND record.record_kind=NEW.resource_type)
BEGIN SELECT RAISE(ABORT,'directory lifecycle blocks binding acquisition'); END;
CREATE TRIGGER operations_directory_lifecycle_blocks_acquisition_command
BEFORE INSERT ON project_alpha_existing_directory_binding_acquisition_commands
WHEN EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state
  WHERE state.record_id=NEW.record_id AND state.status<>'active')
  OR EXISTS(SELECT 1 FROM operations_directory_lifecycle_fences fence WHERE fence.record_id=NEW.record_id)
BEGIN SELECT RAISE(ABORT,'directory lifecycle blocks binding acquisition command'); END;
CREATE TRIGGER operations_directory_lifecycle_blocks_acquisition_response
BEFORE INSERT ON project_alpha_existing_directory_binding_acquisition_response_receipts
WHEN EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_commands command
  JOIN operations_directory_lifecycle_state state ON state.record_id=command.record_id
  WHERE command.command_id=NEW.command_id AND state.status<>'active')
BEGIN SELECT RAISE(ABORT,'directory lifecycle blocks binding acquisition response'); END;
CREATE TRIGGER operations_directory_lifecycle_blocks_acquired_mapping
BEFORE INSERT ON project_alpha_existing_directory_binding_acquired_mapping_receipts
WHEN EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state
  WHERE state.record_id=NEW.record_id AND state.status<>'active')
BEGIN SELECT RAISE(ABORT,'directory lifecycle blocks acquired mapping'); END;
CREATE TRIGGER operations_directory_lifecycle_blocks_acquired_activation
BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
WHEN EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state
  WHERE state.record_id=NEW.record_id AND state.status<>'active')
BEGIN SELECT RAISE(ABORT,'directory lifecycle blocks acquired binding activation'); END;

PRAGMA foreign_keys = ON;
