PRAGMA foreign_keys = ON;

-- Explicit admission of imported records into Ops management. Acquisition and
-- activation remain evidence only; neither can create an enrollment row.
CREATE TABLE reviewed_import_enrollment_admissions (
  admission_id TEXT NOT NULL PRIMARY KEY,
  mutation_id TEXT NOT NULL UNIQUE,
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  enrollment_version INTEGER NOT NULL CHECK(typeof(enrollment_version)='integer' AND enrollment_version>=1),
  expected_record_version INTEGER NOT NULL CHECK(typeof(expected_record_version)='integer' AND expected_record_version>=1),
  expected_enrollment_version INTEGER NOT NULL CHECK(typeof(expected_enrollment_version)='integer' AND expected_enrollment_version>=0),
  destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_type(destinations_json)='array'
    AND json_array_length(destinations_json) BETWEEN 1 AND 16),
  actor_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_email TEXT NOT NULL,
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  selected_profile_grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  selected_enrollment_grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  actor_verified_until TEXT NOT NULL CHECK(length(actor_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until) IS actor_verified_until),
  reviewed_at TEXT NOT NULL CHECK(length(reviewed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at) IS reviewed_at)
);

CREATE TABLE reviewed_import_enrollment_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY,
  admission_id TEXT NOT NULL UNIQUE REFERENCES reviewed_import_enrollment_admissions(admission_id) ON DELETE RESTRICT,
  mutation_id TEXT NOT NULL UNIQUE,
  record_id TEXT NOT NULL,
  enrollment_version INTEGER NOT NULL CHECK(enrollment_version>=1),
  destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_type(destinations_json)='array'),
  admitted_by_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  admitted_at TEXT NOT NULL CHECK(length(admitted_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',admitted_at) IS admitted_at),
  UNIQUE(record_id,enrollment_version)
);

CREATE VIEW reviewed_import_enrollment_live_admissions AS
SELECT admission.*
FROM reviewed_import_enrollment_admissions admission
JOIN operations_directory_records record ON record.record_id=admission.record_id
JOIN staff_users actor ON actor.id=admission.actor_staff_id
JOIN native_staff_admissions staff_admission ON staff_admission.staff_id=admission.actor_staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.actor_staff_id
WHERE record.record_kind=admission.record_kind AND record.current_version=admission.expected_record_version
  AND actor.status='active' AND actor.access_subject=admission.actor_access_subject
  AND staff_admission.active=1 AND staff_admission.bound_access_subject=admission.actor_access_subject
  AND staff_admission.version=admission.actor_admission_version
  AND profile.login_email=admission.actor_email AND profile.version=admission.actor_profile_version
  AND admission.actor_verified_until>=admission.reviewed_at
  AND admission.actor_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ',admission.reviewed_at,'+15 minutes')
  AND admission.reviewed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND admission.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_state lifecycle
    WHERE lifecycle.record_id=admission.record_id AND lifecycle.status<>'active')
  AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_fences lifecycle
    WHERE lifecycle.record_id=admission.record_id)
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_lifecycle_outbox lifecycle
    WHERE lifecycle.record_id=admission.record_id AND lifecycle.state NOT IN ('acknowledged','terminal'))
  AND NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
    LEFT JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
    LEFT JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
    WHERE intent.record_id=admission.record_id
      AND (intent.state<>'acknowledged' OR materialization.intent_id IS NULL OR outbox.state IS NOT 'acknowledged'))
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
    JOIN project_alpha_directory_relationship_outbox outbox ON outbox.command_id=resource.command_id
    WHERE resource.record_id=admission.record_id AND outbox.state<>'acknowledged')
  AND admission.expected_enrollment_version=coalesce((SELECT max(receipt.enrollment_version)
    FROM reviewed_import_enrollment_receipts receipt WHERE receipt.record_id=admission.record_id),0)
  AND admission.enrollment_version=admission.expected_enrollment_version+1
  AND EXISTS(SELECT 1 FROM native_directory_grants grant
    WHERE grant.id=admission.selected_profile_grant_id AND grant.staff_id=admission.actor_staff_id
      AND grant.permission='directory.profile.edit' AND grant.effect='allow' AND grant.active=1
      AND (grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=admission.record_id)
        OR (grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=admission.record_id AND assignment.staff_id=admission.actor_staff_id AND assignment.active=1))
        OR (grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.business_area_id=grant.business_area_id))
        OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.division_id=grant.division_id))))
  AND EXISTS(SELECT 1 FROM native_directory_grants grant
    WHERE grant.id=admission.selected_enrollment_grant_id AND grant.staff_id=admission.actor_staff_id
      AND grant.permission='directory.enrollment.manage' AND grant.effect='allow' AND grant.active=1
      AND (grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=admission.record_id)
        OR (grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=admission.record_id AND assignment.staff_id=admission.actor_staff_id AND assignment.active=1))
        OR (grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.business_area_id=grant.business_area_id))
        OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.division_id=grant.division_id))))
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny
    WHERE deny.staff_id=admission.actor_staff_id AND deny.permission IN ('directory.profile.edit','directory.enrollment.manage')
      AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=admission.record_id)
        OR (deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=admission.record_id AND assignment.staff_id=admission.actor_staff_id AND assignment.active=1))
        OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
        OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.division_id=deny.division_id))));

CREATE TRIGGER reviewed_import_enrollment_admissions_shape BEFORE INSERT ON reviewed_import_enrollment_admissions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) destination
    WHERE json_type(destination.value)<>'object' OR (SELECT count(*) FROM json_each(destination.value))<>6
      OR json_type(destination.value,'$.sourceId') IS NOT 'text'
      OR json_type(destination.value,'$.sourceInstanceUUID') IS NOT 'text'
      OR json_type(destination.value,'$.applicationUUID') IS NOT 'text'
      OR json_type(destination.value,'$.historyEpoch') IS NOT 'text'
      OR json_type(destination.value,'$.origin') IS NOT 'text'
      OR json_type(destination.value,'$.externalCanonicalId') IS NOT 'text'
      OR length(json_extract(destination.value,'$.sourceId')) NOT BETWEEN 15 AND 78
      OR substr(json_extract(destination.value,'$.sourceId'),1,14)<>'project-alpha:'
      OR substr(json_extract(destination.value,'$.sourceId'),15,1) NOT GLOB '[a-z0-9]'
      OR substr(json_extract(destination.value,'$.sourceId'),15) GLOB '*[^a-z0-9_-]*'
      OR length(json_extract(destination.value,'$.sourceInstanceUUID'))<>36
      OR lower(json_extract(destination.value,'$.sourceInstanceUUID'))<>json_extract(destination.value,'$.sourceInstanceUUID')
      OR json_extract(destination.value,'$.sourceInstanceUUID') GLOB '*[^0-9a-f-]*'
      OR length(replace(json_extract(destination.value,'$.sourceInstanceUUID'),'-',''))<>32
      OR substr(json_extract(destination.value,'$.sourceInstanceUUID'),9,1)<>'-'
      OR substr(json_extract(destination.value,'$.sourceInstanceUUID'),14,2)<>'-4'
      OR substr(json_extract(destination.value,'$.sourceInstanceUUID'),19,2) NOT GLOB '-[89ab]'
      OR substr(json_extract(destination.value,'$.sourceInstanceUUID'),24,1)<>'-'
      OR length(json_extract(destination.value,'$.applicationUUID'))<>36
      OR lower(json_extract(destination.value,'$.applicationUUID'))<>json_extract(destination.value,'$.applicationUUID')
      OR json_extract(destination.value,'$.applicationUUID') GLOB '*[^0-9a-f-]*'
      OR length(replace(json_extract(destination.value,'$.applicationUUID'),'-',''))<>32
      OR substr(json_extract(destination.value,'$.applicationUUID'),9,1)<>'-'
      OR substr(json_extract(destination.value,'$.applicationUUID'),14,2)<>'-4'
      OR substr(json_extract(destination.value,'$.applicationUUID'),19,2) NOT GLOB '-[89ab]'
      OR substr(json_extract(destination.value,'$.applicationUUID'),24,1)<>'-'
      OR length(json_extract(destination.value,'$.historyEpoch'))<>36
      OR lower(json_extract(destination.value,'$.historyEpoch'))<>json_extract(destination.value,'$.historyEpoch')
      OR json_extract(destination.value,'$.historyEpoch') GLOB '*[^0-9a-f-]*'
      OR length(replace(json_extract(destination.value,'$.historyEpoch'),'-',''))<>32
      OR substr(json_extract(destination.value,'$.historyEpoch'),9,1)<>'-'
      OR substr(json_extract(destination.value,'$.historyEpoch'),14,2)<>'-4'
      OR substr(json_extract(destination.value,'$.historyEpoch'),19,2) NOT GLOB '-[89ab]'
      OR substr(json_extract(destination.value,'$.historyEpoch'),24,1)<>'-'
      OR substr(json_extract(destination.value,'$.origin'),1,8)<>'https://'
      OR length(json_extract(destination.value,'$.origin'))>2048
      OR length(json_extract(destination.value,'$.externalCanonicalId')) NOT BETWEEN 1 AND 764
      OR EXISTS(SELECT 1 FROM json_each(destination.value) field
        WHERE field.key NOT IN ('sourceId','sourceInstanceUUID','applicationUUID','historyEpoch','origin','externalCanonicalId')))
  OR (SELECT count(*) FROM json_each(NEW.destinations_json))<>(SELECT count(*) FROM (
    SELECT json_extract(value,'$.sourceId'),json_extract(value,'$.sourceInstanceUUID'),json_extract(value,'$.applicationUUID'),
      json_extract(value,'$.historyEpoch'),json_extract(value,'$.origin'),json_extract(value,'$.externalCanonicalId')
    FROM json_each(NEW.destinations_json) GROUP BY 1,2,3,4,5,6))
  OR (SELECT count(*) FROM json_each(NEW.destinations_json))<>(SELECT count(*) FROM (
    SELECT json_extract(value,'$.sourceId') FROM json_each(NEW.destinations_json) GROUP BY 1))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment destination set is invalid'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN NOT EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission
    JOIN operations_directory_records record ON record.record_id=admission.record_id
    JOIN staff_users actor ON actor.id=admission.actor_staff_id
    JOIN native_staff_admissions staff_admission ON staff_admission.staff_id=admission.actor_staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=admission.actor_staff_id
    WHERE admission.admission_id=NEW.admission_id AND admission.mutation_id=NEW.mutation_id
      AND admission.record_id=NEW.record_id AND admission.enrollment_version=NEW.enrollment_version
      AND json(admission.destinations_json)=json(NEW.destinations_json)
      AND admission.actor_staff_id=NEW.admitted_by_staff_id AND NEW.admitted_at=admission.reviewed_at
      AND record.record_kind=admission.record_kind AND record.current_version=admission.expected_record_version
      AND actor.status='active' AND actor.access_subject=admission.actor_access_subject
      AND staff_admission.active=1 AND staff_admission.bound_access_subject=admission.actor_access_subject
      AND staff_admission.version=admission.actor_admission_version
      AND profile.login_email=admission.actor_email AND profile.version=admission.actor_profile_version
      AND admission.expected_enrollment_version=coalesce((SELECT max(prior.enrollment_version)
        FROM reviewed_import_enrollment_receipts prior WHERE prior.record_id=admission.record_id),0)
      AND admission.enrollment_version=admission.expected_enrollment_version+1
      AND admission.reviewed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND admission.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND admission.actor_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ',admission.reviewed_at,'+15 minutes')
      AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state
        WHERE state.record_id=admission.record_id AND state.status<>'active')
      AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_fences fence WHERE fence.record_id=admission.record_id))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires exact current authority'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_pending_directory_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission
    JOIN operations_directory_intents intent ON intent.record_id=admission.record_id
    LEFT JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
    LEFT JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
    WHERE admission.admission_id=NEW.admission_id
      AND (intent.state<>'acknowledged' OR materialization.intent_id IS NULL OR outbox.state IS NOT 'acknowledged'))
  OR EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission
    JOIN project_alpha_directory_relationship_command_resources resource ON resource.record_id=admission.record_id
    JOIN project_alpha_directory_relationship_outbox outbox ON outbox.command_id=resource.command_id
    WHERE admission.admission_id=NEW.admission_id AND outbox.state<>'acknowledged')
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires completed directory work'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_pending_lifecycle_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission
    JOIN project_alpha_directory_lifecycle_outbox outbox ON outbox.record_id=admission.record_id
    WHERE admission.admission_id=NEW.admission_id AND outbox.state NOT IN ('acknowledged','terminal'))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires completed lifecycle work'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_pending_acquisition_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission
    JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.record_id=admission.record_id
    WHERE admission.admission_id=NEW.admission_id AND NOT EXISTS(
      SELECT 1 FROM project_alpha_existing_directory_binding_acquired_mapping_receipts acquired
      JOIN project_alpha_existing_directory_binding_activation_receipts activation
        ON activation.acquired_receipt_id=acquired.receipt_id AND activation.record_id=command.record_id
      WHERE acquired.command_id=command.command_id))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires completed acquisition work'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_pending_refresh_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission
    JOIN native_directory_active_binding_refresh_commands command ON command.record_id=admission.record_id
    JOIN native_directory_active_binding_refresh_dispatch dispatch ON dispatch.command_id=command.command_id
    WHERE admission.admission_id=NEW.admission_id AND dispatch.state IN ('pending','uncertain','leased'))
  OR EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission
    JOIN native_directory_active_binding_refresh_commands command ON command.record_id=admission.record_id
    JOIN native_directory_active_binding_refresh_supersessions supersession ON supersession.superseded_command_id=command.command_id
    JOIN native_directory_active_binding_refresh_successor_dispatch dispatch ON dispatch.command_id=supersession.successor_command_id
    WHERE admission.admission_id=NEW.admission_id AND dispatch.state IN ('pending','uncertain','leased'))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires completed refresh work'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_pending_profile_binding_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission
    JOIN native_directory_profile_binding_jobs job ON job.record_id=admission.record_id
    JOIN native_directory_profile_binding_dispatch dispatch ON dispatch.command_id=job.command_id
    WHERE admission.admission_id=NEW.admission_id AND dispatch.state IN ('pending','leased','uncertain','conflict'))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires completed profile binding work'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_permission_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM reviewed_import_enrollment_admissions admission WHERE admission.admission_id=NEW.admission_id
  AND (NOT EXISTS(SELECT 1 FROM native_directory_grants grant WHERE grant.id=admission.selected_profile_grant_id
      AND grant.staff_id=admission.actor_staff_id AND grant.permission='directory.profile.edit' AND grant.effect='allow' AND grant.active=1
      AND (grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=admission.record_id)
        OR (grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=admission.record_id AND assignment.staff_id=admission.actor_staff_id AND assignment.active=1))
        OR (grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.business_area_id=grant.business_area_id))
        OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.division_id=grant.division_id))))
    OR NOT EXISTS(SELECT 1 FROM native_directory_grants grant WHERE grant.id=admission.selected_enrollment_grant_id
      AND grant.staff_id=admission.actor_staff_id AND grant.permission='directory.enrollment.manage' AND grant.effect='allow' AND grant.active=1
      AND (grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=admission.record_id)
        OR (grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=admission.record_id AND assignment.staff_id=admission.actor_staff_id AND assignment.active=1))
        OR (grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.business_area_id=grant.business_area_id))
        OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.division_id=grant.division_id))))
    OR EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=admission.actor_staff_id
      AND deny.permission IN ('directory.profile.edit','directory.enrollment.manage') AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=admission.record_id)
        OR (deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=admission.record_id AND assignment.staff_id=admission.actor_staff_id AND assignment.active=1))
        OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
        OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=admission.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires current scoped permissions'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_evidence_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM native_directory_enrollments native,json_each(native.destinations_json) prior
    WHERE native.record_id=NEW.record_id
      AND (SELECT expected_enrollment_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)=0
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) proposed
        WHERE json_extract(proposed.value,'$.sourceId')=json_extract(prior.value,'$.sourceId')
          AND json_extract(proposed.value,'$.sourceInstanceUUID')=json_extract(prior.value,'$.sourceInstanceUUID')
          AND json_extract(proposed.value,'$.applicationUUID')=json_extract(prior.value,'$.applicationUUID')
          AND json_extract(proposed.value,'$.origin')=json_extract(prior.value,'$.origin')
          AND json_extract(proposed.value,'$.externalCanonicalId')=json_extract(prior.value,'$.externalCanonicalId')
          AND (json_type(prior.value,'$.historyEpoch') IS NULL
            OR json_extract(proposed.value,'$.historyEpoch')=json_extract(prior.value,'$.historyEpoch'))))
  OR EXISTS(SELECT 1 FROM reviewed_import_enrollment_receipts prior_receipt,json_each(prior_receipt.destinations_json) prior
    WHERE prior_receipt.record_id=NEW.record_id
      AND prior_receipt.enrollment_version=(SELECT expected_enrollment_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) proposed
        WHERE json(proposed.value)=json(prior.value)))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment cannot remove a destination'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_activation_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) destination
    WHERE NOT EXISTS(SELECT 1 FROM native_directory_enrollments native,json_each(native.destinations_json) prior
        WHERE native.record_id=NEW.record_id AND (SELECT expected_enrollment_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)=0
          AND json_extract(prior.value,'$.sourceId')=json_extract(destination.value,'$.sourceId')
          AND json_extract(prior.value,'$.sourceInstanceUUID')=json_extract(destination.value,'$.sourceInstanceUUID')
          AND json_extract(prior.value,'$.applicationUUID')=json_extract(destination.value,'$.applicationUUID')
          AND json_extract(prior.value,'$.externalCanonicalId')=json_extract(destination.value,'$.externalCanonicalId')
          AND json_extract(prior.value,'$.origin')=json_extract(destination.value,'$.origin')
          AND (json_type(prior.value,'$.historyEpoch') IS NULL OR json_extract(prior.value,'$.historyEpoch')=json_extract(destination.value,'$.historyEpoch')))
      AND NOT EXISTS(SELECT 1 FROM reviewed_import_enrollment_receipts prior_receipt,json_each(prior_receipt.destinations_json) prior
        WHERE prior_receipt.record_id=NEW.record_id AND prior_receipt.enrollment_version=(SELECT expected_enrollment_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)
          AND json_extract(prior.value,'$.sourceId')=json_extract(destination.value,'$.sourceId')
          AND json_extract(prior.value,'$.sourceInstanceUUID')=json_extract(destination.value,'$.sourceInstanceUUID')
          AND json_extract(prior.value,'$.applicationUUID')=json_extract(destination.value,'$.applicationUUID')
          AND json_extract(prior.value,'$.externalCanonicalId')=json_extract(destination.value,'$.externalCanonicalId')
          AND json_extract(prior.value,'$.origin')=json_extract(destination.value,'$.origin')
          AND json_extract(prior.value,'$.historyEpoch')=json_extract(destination.value,'$.historyEpoch'))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_activation_receipts activation
      JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=activation.acquired_receipt_id
      JOIN project_alpha_active_directory_mappings mapping ON mapping.provenance_id=activation.activation_id
        AND mapping.mapping_kind='acquired' AND mapping.record_id=activation.record_id
        AND mapping.source_id=activation.source_id AND mapping.source_instance_id=activation.source_instance_id
        AND mapping.application_id=activation.application_id AND mapping.history_epoch_id=activation.history_epoch_id
        AND mapping.resource_type=activation.resource_type AND mapping.external_id=activation.external_id
        AND mapping.project_alpha_public_id=activation.project_alpha_public_id
      JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
      JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.command_id=response.command_id
      JOIN project_alpha_existing_directory_binding_review_evidence review ON review.receipt_id=activation.review_receipt_id
      WHERE activation.record_id=NEW.record_id AND activation.local_record_version=(SELECT expected_record_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)
        AND activation.source_id=json_extract(destination.value,'$.sourceId')
        AND activation.source_instance_id=json_extract(destination.value,'$.sourceInstanceUUID')
        AND activation.application_id=json_extract(destination.value,'$.applicationUUID')
        AND activation.history_epoch_id=json_extract(destination.value,'$.historyEpoch')
        AND activation.external_id=json_extract(destination.value,'$.externalCanonicalId')
        AND response.destination_origin=json_extract(destination.value,'$.origin')
        AND command.review_receipt_id=review.receipt_id AND acquired.command_id=command.command_id))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires exact activated acquisition'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_inventory_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) destination
    WHERE NOT EXISTS(SELECT 1 FROM native_directory_enrollments native,json_each(native.destinations_json) prior
        WHERE native.record_id=NEW.record_id AND (SELECT expected_enrollment_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)=0
          AND json_extract(prior.value,'$.sourceId')=json_extract(destination.value,'$.sourceId')
          AND json_extract(prior.value,'$.sourceInstanceUUID')=json_extract(destination.value,'$.sourceInstanceUUID')
          AND json_extract(prior.value,'$.applicationUUID')=json_extract(destination.value,'$.applicationUUID')
          AND json_extract(prior.value,'$.externalCanonicalId')=json_extract(destination.value,'$.externalCanonicalId')
          AND json_extract(prior.value,'$.origin')=json_extract(destination.value,'$.origin')
          AND (json_type(prior.value,'$.historyEpoch') IS NULL OR json_extract(prior.value,'$.historyEpoch')=json_extract(destination.value,'$.historyEpoch')))
      AND NOT EXISTS(SELECT 1 FROM reviewed_import_enrollment_receipts prior_receipt,json_each(prior_receipt.destinations_json) prior
        WHERE prior_receipt.record_id=NEW.record_id AND prior_receipt.enrollment_version=(SELECT expected_enrollment_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)
          AND json_extract(prior.value,'$.sourceId')=json_extract(destination.value,'$.sourceId')
          AND json_extract(prior.value,'$.sourceInstanceUUID')=json_extract(destination.value,'$.sourceInstanceUUID')
          AND json_extract(prior.value,'$.applicationUUID')=json_extract(destination.value,'$.applicationUUID')
          AND json_extract(prior.value,'$.externalCanonicalId')=json_extract(destination.value,'$.externalCanonicalId')
          AND json_extract(prior.value,'$.origin')=json_extract(destination.value,'$.origin')
          AND json_extract(prior.value,'$.historyEpoch')=json_extract(destination.value,'$.historyEpoch'))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_activation_receipts activation
      JOIN project_alpha_api_v2_directory_observations observation
        ON observation.source_id=activation.source_id AND observation.source_instance_id=activation.source_instance_id
        AND observation.application_id=activation.application_id AND observation.history_epoch_id=activation.history_epoch_id
        AND observation.resource_type=activation.resource_type AND observation.project_alpha_public_id=activation.project_alpha_public_id
      JOIN project_alpha_api_v2_inventory_receipts inventory
        ON inventory.source_id=observation.source_id AND inventory.source_instance_id=observation.source_instance_id
        AND inventory.application_id=observation.application_id AND inventory.history_epoch_id=observation.history_epoch_id
        AND inventory.inventory_kind='directory' AND inventory.request_id=observation.request_id
      WHERE activation.record_id=NEW.record_id AND activation.local_record_version=(SELECT expected_record_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)
        AND activation.source_id=json_extract(destination.value,'$.sourceId')
        AND activation.source_instance_id=json_extract(destination.value,'$.sourceInstanceUUID')
        AND activation.application_id=json_extract(destination.value,'$.applicationUUID')
        AND activation.history_epoch_id=json_extract(destination.value,'$.historyEpoch')
        AND activation.external_id=json_extract(destination.value,'$.externalCanonicalId')
        AND observation.binding_external_id=activation.external_id AND observation.binding_status='active'
        AND observation.binding_resource_revision=observation.resource_revision
        AND observation.present=1 AND observation.last_action='upsert'
        AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
          WHERE conflict.source_id=observation.source_id AND conflict.source_instance_id=observation.source_instance_id
            AND conflict.application_id=observation.application_id AND conflict.history_epoch_id=observation.history_epoch_id
            AND conflict.inventory_kind='directory' AND conflict.resource_type=observation.resource_type
            AND conflict.project_alpha_public_id=observation.project_alpha_public_id)
        AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations newer
          JOIN project_alpha_api_v2_inventory_receipts newer_receipt ON newer_receipt.source_id=newer.source_id
            AND newer_receipt.source_instance_id=newer.source_instance_id AND newer_receipt.application_id=newer.application_id
            AND newer_receipt.history_epoch_id=newer.history_epoch_id AND newer_receipt.inventory_kind='directory'
            AND newer_receipt.request_id=newer.request_id
          WHERE newer.source_id=observation.source_id AND newer.source_instance_id=observation.source_instance_id
            AND newer.application_id=observation.application_id AND newer.history_epoch_id=observation.history_epoch_id
            AND newer.resource_type=observation.resource_type AND newer.project_alpha_public_id=observation.project_alpha_public_id
            AND (length(newer.resource_revision)>length(observation.resource_revision)
              OR (length(newer.resource_revision)=length(observation.resource_revision) AND newer.resource_revision>observation.resource_revision)
              OR (newer.resource_revision=observation.resource_revision AND (newer_receipt.observed_at>inventory.observed_at
                OR (newer_receipt.observed_at=inventory.observed_at AND newer.request_id>observation.request_id)))))
        AND inventory.requested_cursor IS NULL AND inventory.next_cursor IS NULL
        AND inventory.observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')
        AND inventory.observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires fresh complete inventory evidence'); END;

-- Legacy native-create enrollment JSON predates historyEpoch. Adding that
-- field is not grandfathered: pin it to the acknowledged legacy mapping and
-- its exact destination origin, then independently require current inventory.
CREATE TRIGGER reviewed_import_enrollment_receipts_native_history_mapping_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM native_directory_enrollments native,json_each(native.destinations_json) prior
    JOIN json_each(NEW.destinations_json) proposed
      ON json_extract(proposed.value,'$.sourceId')=json_extract(prior.value,'$.sourceId')
      AND json_extract(proposed.value,'$.sourceInstanceUUID')=json_extract(prior.value,'$.sourceInstanceUUID')
      AND json_extract(proposed.value,'$.applicationUUID')=json_extract(prior.value,'$.applicationUUID')
      AND json_extract(proposed.value,'$.origin')=json_extract(prior.value,'$.origin')
      AND json_extract(proposed.value,'$.externalCanonicalId')=json_extract(prior.value,'$.externalCanonicalId')
    WHERE native.record_id=NEW.record_id AND json_type(prior.value,'$.historyEpoch') IS NULL
      AND (SELECT expected_enrollment_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)=0
      AND NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
        JOIN project_alpha_directory_outbox outbox ON outbox.command_id=mapping.provenance_id
          AND outbox.state='acknowledged' AND outbox.source_id=mapping.source_id
          AND outbox.expected_source_instance_id=mapping.source_instance_id
          AND outbox.application_id=mapping.application_id AND outbox.resource_type=mapping.resource_type
          AND outbox.external_id=mapping.external_id AND outbox.destination_base_url=json_extract(proposed.value,'$.origin')
        JOIN operations_directory_records record ON record.record_id=native.record_id AND record.record_kind=mapping.resource_type
        WHERE mapping.mapping_kind='legacy' AND mapping.record_id=native.record_id
          AND mapping.source_id=json_extract(proposed.value,'$.sourceId')
          AND mapping.source_instance_id=json_extract(proposed.value,'$.sourceInstanceUUID')
          AND mapping.application_id=json_extract(proposed.value,'$.applicationUUID')
          AND mapping.history_epoch_id=json_extract(proposed.value,'$.historyEpoch')
          AND mapping.external_id=json_extract(proposed.value,'$.externalCanonicalId')))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment history epoch requires exact native mapping'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_native_history_inventory_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM native_directory_enrollments native,json_each(native.destinations_json) prior
    JOIN json_each(NEW.destinations_json) proposed
      ON json_extract(proposed.value,'$.sourceId')=json_extract(prior.value,'$.sourceId')
      AND json_extract(proposed.value,'$.sourceInstanceUUID')=json_extract(prior.value,'$.sourceInstanceUUID')
      AND json_extract(proposed.value,'$.applicationUUID')=json_extract(prior.value,'$.applicationUUID')
      AND json_extract(proposed.value,'$.origin')=json_extract(prior.value,'$.origin')
      AND json_extract(proposed.value,'$.externalCanonicalId')=json_extract(prior.value,'$.externalCanonicalId')
    WHERE native.record_id=NEW.record_id AND json_type(prior.value,'$.historyEpoch') IS NULL
      AND (SELECT expected_enrollment_version FROM reviewed_import_enrollment_admissions WHERE admission_id=NEW.admission_id)=0
      AND NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
        JOIN project_alpha_api_v2_directory_observations observation
          ON observation.source_id=mapping.source_id AND observation.source_instance_id=mapping.source_instance_id
          AND observation.application_id=mapping.application_id AND observation.history_epoch_id=mapping.history_epoch_id
          AND observation.resource_type=mapping.resource_type AND observation.project_alpha_public_id=mapping.project_alpha_public_id
        JOIN project_alpha_api_v2_inventory_receipts inventory
          ON inventory.source_id=observation.source_id AND inventory.source_instance_id=observation.source_instance_id
          AND inventory.application_id=observation.application_id AND inventory.history_epoch_id=observation.history_epoch_id
          AND inventory.inventory_kind='directory' AND inventory.request_id=observation.request_id
        WHERE mapping.mapping_kind='legacy' AND mapping.record_id=native.record_id
          AND mapping.source_id=json_extract(proposed.value,'$.sourceId')
          AND mapping.source_instance_id=json_extract(proposed.value,'$.sourceInstanceUUID')
          AND mapping.application_id=json_extract(proposed.value,'$.applicationUUID')
          AND mapping.history_epoch_id=json_extract(proposed.value,'$.historyEpoch')
          AND mapping.external_id=json_extract(proposed.value,'$.externalCanonicalId')
          AND observation.binding_external_id=mapping.external_id AND observation.binding_status='active'
          AND observation.binding_resource_revision=observation.resource_revision
          AND observation.present=1 AND observation.last_action='upsert'
          AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
            WHERE conflict.source_id=observation.source_id AND conflict.source_instance_id=observation.source_instance_id
              AND conflict.application_id=observation.application_id AND conflict.history_epoch_id=observation.history_epoch_id
              AND conflict.inventory_kind='directory' AND conflict.resource_type=observation.resource_type
              AND conflict.project_alpha_public_id=observation.project_alpha_public_id)
          AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations newer
            JOIN project_alpha_api_v2_inventory_receipts newer_receipt ON newer_receipt.source_id=newer.source_id
              AND newer_receipt.source_instance_id=newer.source_instance_id AND newer_receipt.application_id=newer.application_id
              AND newer_receipt.history_epoch_id=newer.history_epoch_id AND newer_receipt.inventory_kind='directory'
              AND newer_receipt.request_id=newer.request_id
            WHERE newer.source_id=observation.source_id AND newer.source_instance_id=observation.source_instance_id
              AND newer.application_id=observation.application_id AND newer.history_epoch_id=observation.history_epoch_id
              AND newer.resource_type=observation.resource_type AND newer.project_alpha_public_id=observation.project_alpha_public_id
              AND (length(newer.resource_revision)>length(observation.resource_revision)
                OR (length(newer.resource_revision)=length(observation.resource_revision) AND newer.resource_revision>observation.resource_revision)
                OR (newer.resource_revision=observation.resource_revision AND (newer_receipt.observed_at>inventory.observed_at
                  OR (newer_receipt.observed_at=inventory.observed_at AND newer.request_id>observation.request_id)))))
          AND inventory.requested_cursor IS NULL AND inventory.next_cursor IS NULL
          AND inventory.observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')
          AND inventory.observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment history epoch requires fresh native inventory'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_native_collision_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) proposed
    JOIN native_directory_enrollments native,json_each(native.destinations_json) existing
      ON native.record_id<>NEW.record_id
    WHERE json_extract(existing.value,'$.sourceId')=json_extract(proposed.value,'$.sourceId')
      AND json_extract(existing.value,'$.sourceInstanceUUID')=json_extract(proposed.value,'$.sourceInstanceUUID')
      AND json_extract(existing.value,'$.applicationUUID')=json_extract(proposed.value,'$.applicationUUID')
      AND json_extract(existing.value,'$.externalCanonicalId')=json_extract(proposed.value,'$.externalCanonicalId'))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment destination collides with native enrollment'); END;

CREATE TRIGGER reviewed_import_enrollment_receipts_reviewed_collision_guard BEFORE INSERT ON reviewed_import_enrollment_receipts
WHEN EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) proposed
    JOIN reviewed_import_enrollment_receipts other,json_each(other.destinations_json) existing ON other.record_id<>NEW.record_id
    WHERE other.enrollment_version=(SELECT max(latest.enrollment_version) FROM reviewed_import_enrollment_receipts latest WHERE latest.record_id=other.record_id)
      AND json_extract(existing.value,'$.sourceId')=json_extract(proposed.value,'$.sourceId')
      AND json_extract(existing.value,'$.sourceInstanceUUID')=json_extract(proposed.value,'$.sourceInstanceUUID')
      AND json_extract(existing.value,'$.applicationUUID')=json_extract(proposed.value,'$.applicationUUID')
      AND json_extract(existing.value,'$.externalCanonicalId')=json_extract(proposed.value,'$.externalCanonicalId'))
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment requires exact current authority and evidence'); END;

CREATE TRIGGER reviewed_import_enrollment_admissions_no_update BEFORE UPDATE ON reviewed_import_enrollment_admissions
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment admission is immutable'); END;
CREATE TRIGGER reviewed_import_enrollment_admissions_no_delete BEFORE DELETE ON reviewed_import_enrollment_admissions
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment admission is durable'); END;
CREATE TRIGGER reviewed_import_enrollment_receipts_no_update BEFORE UPDATE ON reviewed_import_enrollment_receipts
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment receipt is immutable'); END;
CREATE TRIGGER reviewed_import_enrollment_receipts_no_delete BEFORE DELETE ON reviewed_import_enrollment_receipts
BEGIN SELECT RAISE(ABORT,'reviewed import enrollment receipt is durable'); END;

-- Reader-compatible destinations_json plus separate provenance. Native rows
-- retain their original five/six-field JSON; historyEpoch is never injected.
CREATE VIEW effective_native_directory_enrollments AS
SELECT native.record_id,native.destinations_json,0 AS enrollment_version,'native_create' AS enrollment_kind,
  native.create_admission_id AS provenance_id,native.created_at,
  json_object('kind','native_create','createAdmissionId',native.create_admission_id) AS provenance_json
FROM native_directory_enrollments native
WHERE NOT EXISTS(SELECT 1 FROM reviewed_import_enrollment_receipts reviewed WHERE reviewed.record_id=native.record_id)
UNION ALL
SELECT receipt.record_id,receipt.destinations_json,receipt.enrollment_version,'reviewed_import' AS enrollment_kind,
  receipt.receipt_id AS provenance_id,receipt.admitted_at AS created_at,
  json_object('kind','reviewed_import','receiptId',receipt.receipt_id,'admissionId',receipt.admission_id,
    'historyEpochs',json((SELECT json_group_array(json_extract(destination.value,'$.historyEpoch'))
      FROM json_each(receipt.destinations_json) destination))) AS provenance_json
FROM reviewed_import_enrollment_receipts receipt
WHERE receipt.enrollment_version=(SELECT max(latest.enrollment_version)
  FROM reviewed_import_enrollment_receipts latest WHERE latest.record_id=receipt.record_id);

