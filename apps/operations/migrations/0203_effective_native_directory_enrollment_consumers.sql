PRAGMA foreign_keys = ON;

-- Route enrollment-sensitive SQL consumers through the versioned effective
-- enrollment projection. All non-enrollment predicates are retained from the
-- definitions installed through migration 0202.
-- A fence carrying an earlier destinations_json snapshot therefore stops being
-- live as soon as a later reviewed enrollment version becomes effective.
DROP VIEW operations_directory_live_lifecycle_fences;
DROP VIEW project_alpha_directory_live_relationship_generation_recoveries;
DROP TRIGGER project_alpha_directory_relationship_generation_recovery_organization_enrollment;
DROP TRIGGER project_alpha_directory_relationship_generation_recovery_client_enrollment;
DROP TRIGGER project_alpha_directory_relationship_generation_recovery_authorization_review_exact;
DROP VIEW project_alpha_directory_live_relationship_commands;
DROP TRIGGER operations_directory_intent_relationship_dependencies_insert_guard;
DROP VIEW operations_directory_live_relationship_fences;
DROP VIEW operations_directory_live_write_fences;

CREATE VIEW operations_directory_live_write_fences AS
SELECT fence.* FROM operations_directory_write_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id
JOIN native_staff_admissions staff_admission ON staff_admission.staff_id=fence.actor_id
  AND staff_admission.active=1 AND staff_admission.bound_access_subject=fence.bound_access_subject
  AND staff_admission.version=fence.actor_admission_version
LEFT JOIN operations_directory_records record ON record.record_id=fence.record_id
LEFT JOIN native_directory_create_admissions create_admission ON create_admission.id=fence.create_admission_id
LEFT JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=fence.record_id
LEFT JOIN native_directory_grants selected_grant ON selected_grant.id=fence.selected_grant_id
  AND selected_grant.staff_id=fence.actor_id AND selected_grant.permission=fence.permission
  AND selected_grant.effect='allow' AND selected_grant.active=1
WHERE fence.write_guard=1
  AND ((fence.operation_kind='create'
      AND create_admission.staff_id=fence.actor_id AND create_admission.bound_access_subject=fence.bound_access_subject
      AND create_admission.record_id=fence.record_id AND create_admission.record_kind=fence.record_kind
      AND json(create_admission.scopes_json)=json(fence.scopes_json)
      AND json(create_admission.profile_json)=json(fence.profile_json)
      AND json(create_admission.destinations_json)=json(fence.destinations_json)
      AND fence.intent_writes BETWEEN 0 AND json_array_length(fence.destinations_json)
      AND NOT EXISTS(SELECT 1 FROM json_each(fence.scopes_json) proposed
        LEFT JOIN native_business_areas area ON area.id=json_extract(proposed.value,'$.businessAreaId') AND area.active=1
        LEFT JOIN native_business_divisions division ON division.id=json_extract(proposed.value,'$.divisionId')
          AND division.business_area_id=json_extract(proposed.value,'$.businessAreaId') AND division.active=1
        WHERE area.id IS NULL OR (json_type(proposed.value,'$.divisionId')='text' AND division.id IS NULL))
      AND ((fence.record_writes=1 AND record.record_id IS NULL AND create_admission.active=1
          AND create_admission.consumed_mutation_id IS NULL)
        OR (fence.record_writes=0 AND record.record_id=fence.record_id AND record.record_kind=fence.record_kind
          AND record.current_version=1 AND create_admission.active=0
          AND create_admission.consumed_mutation_id=fence.mutation_id))
      AND (selected_grant.scope_kind='global'
        OR (selected_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
          WHERE json_extract(scope.value,'$.businessAreaId')=selected_grant.business_area_id))
        OR (selected_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
          WHERE json_extract(scope.value,'$.divisionId')=selected_grant.division_id))))
    OR (fence.operation_kind='update' AND record.record_id IS NOT NULL AND record.record_kind=fence.record_kind
      AND ((fence.record_writes=1 AND record.current_version=fence.expected_version)
        OR (fence.record_writes=0 AND record.current_version=fence.expected_version+1))
      AND enrollment.record_id IS NOT NULL AND json(enrollment.destinations_json)=json(fence.destinations_json)
      AND fence.intent_writes BETWEEN 0 AND json_array_length(fence.destinations_json)
      AND NOT EXISTS(SELECT 1 FROM native_directory_resource_scopes current_scope
        JOIN native_business_areas area ON area.id=current_scope.business_area_id
        LEFT JOIN native_business_divisions division ON division.id=current_scope.division_id
        WHERE current_scope.record_id=fence.record_id AND current_scope.active=1
          AND (area.active<>1 OR (current_scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
      AND (selected_grant.scope_kind='global'
        OR (selected_grant.scope_kind='resource' AND selected_grant.resource_id=fence.record_id)
        OR (selected_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_id AND assignment.active=1))
        OR (selected_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=selected_grant.business_area_id))
        OR (selected_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=selected_grant.division_id)))))
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny
    WHERE deny.staff_id=fence.actor_id AND deny.permission=fence.permission AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=fence.record_id)
        OR (deny.scope_kind='assigned' AND fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_id AND assignment.active=1))
        OR (deny.scope_kind='business_area' AND ((fence.operation_kind='create' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
            WHERE json_extract(scope.value,'$.businessAreaId')=deny.business_area_id))
          OR (fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))))
        OR (deny.scope_kind='division' AND ((fence.operation_kind='create' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
            WHERE json_extract(scope.value,'$.divisionId')=deny.division_id))
          OR (fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))));

CREATE VIEW operations_directory_live_relationship_fences AS
SELECT fence.* FROM operations_directory_relationship_write_fences fence
JOIN native_staff_admissions admission ON admission.staff_id=fence.actor_staff_id
  AND admission.active=1 AND admission.bound_access_subject=fence.actor_access_subject
  AND admission.version=fence.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=fence.actor_staff_id
  AND profile.version=fence.actor_profile_version AND profile.login_email=fence.actor_email
WHERE fence.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NOT EXISTS (
    SELECT 1 FROM operations_directory_relationship_fence_resources resource
    LEFT JOIN operations_directory_records record ON record.record_id=resource.record_id
    WHERE resource.mutation_id=fence.mutation_id AND (
      record.record_id IS NULL OR record.record_kind<>resource.record_kind
      OR record.current_version<>resource.record_version
      OR NOT EXISTS(SELECT 1 FROM operations_directory_revisions revision
        WHERE revision.record_id=resource.record_id AND revision.version=resource.record_version)
      OR NOT EXISTS(SELECT 1 FROM effective_native_directory_enrollments enrollment
        WHERE enrollment.record_id=resource.record_id)
      OR EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
        LEFT JOIN native_business_areas area ON area.id=scope.business_area_id
        LEFT JOIN native_business_divisions division ON division.id=scope.division_id
          AND division.business_area_id=scope.business_area_id
        WHERE scope.record_id=resource.record_id AND scope.active=1
          AND (coalesce(area.active,0)<>1 OR (scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
      OR EXISTS (SELECT 1 FROM (
        SELECT 'directory.identity.link' AS permission UNION ALL SELECT 'directory.profile.edit'
      ) needed WHERE
        NOT EXISTS (SELECT 1 FROM native_directory_grants allow_row
          WHERE allow_row.staff_id=fence.actor_staff_id AND allow_row.permission=needed.permission
            AND allow_row.effect='allow' AND allow_row.active=1
            AND (allow_row.scope_kind='global'
              OR (allow_row.scope_kind='resource' AND allow_row.resource_id=resource.record_id)
              OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=resource.record_id AND assignment.staff_id=fence.actor_staff_id AND assignment.active=1))
              OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
              OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
        OR EXISTS (SELECT 1 FROM native_directory_grants deny
          WHERE deny.staff_id=fence.actor_staff_id AND deny.permission=needed.permission
            AND deny.effect='deny' AND deny.active=1
            AND (deny.scope_kind='global'
              OR (deny.scope_kind='resource' AND deny.resource_id=resource.record_id)
              OR (deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=resource.record_id AND assignment.staff_id=fence.actor_staff_id AND assignment.active=1))
              OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
              OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
      )
    )
  );

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
          JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=parent.record_id
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
      AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=NEW.parent_public_id
      AND (
        ((SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=2
          AND json_type(outbox.outcome_json,'$.response.result.data') IS NULL
          AND json_extract(outbox.command_json,'$.operation')='create'
          AND outbox.resource_type='organization')
        OR ((SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=3
          AND json_type(outbox.outcome_json,'$.response.result.data')='object'
          AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.data'))=1
          AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=
            json_extract(outbox.outcome_json,'$.response.result.resource.publicId'))
        )
      ))
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

CREATE VIEW project_alpha_directory_live_relationship_commands AS
SELECT command.* FROM project_alpha_directory_relationship_outbox command
JOIN operations_directory_client_organization_history history
  ON history.mutation_id=command.mutation_id AND history.client_record_id=command.client_record_id
  AND history.relationship_version=command.relationship_version
JOIN operations_directory_client_organizations current_relation
  ON current_relation.client_record_id=history.client_record_id
  AND current_relation.relationship_version=history.relationship_version
  AND current_relation.organization_record_id IS history.organization_record_id
JOIN native_staff_admissions admission ON admission.staff_id=history.actor_staff_id
  AND admission.active=1 AND admission.bound_access_subject=history.actor_access_subject
  AND admission.version=history.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=history.actor_staff_id
  AND profile.login_email=history.actor_email AND profile.version=history.actor_profile_version
WHERE command.expected_current_organization_record_id IS history.previous_organization_record_id
  AND command.organization_record_id IS history.organization_record_id
  AND ((command.action='assign' AND history.previous_organization_record_id IS NULL AND history.organization_record_id IS NOT NULL)
    OR (command.action='remove' AND history.previous_organization_record_id IS NOT NULL AND history.organization_record_id IS NULL)
    OR (command.action='move' AND history.previous_organization_record_id IS NOT NULL
      AND history.organization_record_id IS NOT NULL AND history.previous_organization_record_id<>history.organization_record_id))
  AND json_extract(command.command_json,'$.commandId')=command.command_id
  AND json_extract(command.command_json,'$.expectedClientRevision')=command.expected_client_revision
  AND json_extract(command.command_json,'$.expectedAuthorizationGeneration')=command.expected_authorization_generation
  AND json_extract(command.command_json,'$.expectedCurrentOrganizationPublicId') IS command.expected_current_organization_public_id
  AND (SELECT count(*) FROM json_each(command.command_json))=5
  AND ((command.organization_record_id IS NULL
      AND json_type(command.command_json,'$.organization')='null')
    OR (command.organization_record_id IS NOT NULL
      AND json_type(command.command_json,'$.organization')='object'
      AND (SELECT count(*) FROM json_each(json_extract(command.command_json,'$.organization')))=3
      AND json_extract(command.command_json,'$.organization.publicId')=command.organization_public_id
      AND json_extract(command.command_json,'$.organization.expectedRevision')=command.expected_organization_revision
      AND EXISTS(SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
        JOIN project_alpha_active_directory_mappings mapping
          ON mapping.record_id=resource.record_id AND mapping.resource_type=resource.record_kind
          AND mapping.source_id=command.source_id AND mapping.source_instance_id=command.source_instance_id
          AND mapping.application_id=command.application_id AND mapping.history_epoch_id=command.history_epoch_id
          AND mapping.project_alpha_public_id=resource.public_id
        WHERE resource.command_id=command.command_id AND resource.record_kind='organization'
          AND resource.record_id=command.organization_record_id
          AND mapping.external_id=json_extract(command.command_json,'$.organization.externalId'))))
  AND NOT EXISTS (
    SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
    LEFT JOIN operations_directory_records record ON record.record_id=resource.record_id
    WHERE resource.command_id=command.command_id AND (
      record.record_id IS NULL OR record.record_kind<>resource.record_kind OR record.current_version<>resource.record_version
      OR NOT EXISTS(SELECT 1 FROM operations_directory_revisions revision
        WHERE revision.record_id=resource.record_id AND revision.version=resource.record_version)
      OR NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
        WHERE mapping.source_id=command.source_id AND mapping.source_instance_id=command.source_instance_id
          AND mapping.application_id=command.application_id AND mapping.history_epoch_id=command.history_epoch_id
          AND mapping.resource_type=resource.record_kind AND mapping.record_id=resource.record_id
          AND mapping.project_alpha_public_id=resource.public_id
          AND EXISTS(SELECT 1 FROM effective_native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
            WHERE enrollment.record_id=resource.record_id
              AND json_extract(destination.value,'$.sourceId')=command.source_id
              AND json_extract(destination.value,'$.sourceInstanceUUID')=command.source_instance_id
              AND json_extract(destination.value,'$.applicationUUID')=command.application_id
              AND json_extract(destination.value,'$.historyEpoch')=command.history_epoch_id
              AND json_extract(destination.value,'$.origin')=command.destination_origin
              AND json_extract(destination.value,'$.externalCanonicalId')=mapping.external_id))
      OR EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        LEFT JOIN native_business_areas area ON area.id=scope.business_area_id
        LEFT JOIN native_business_divisions division ON division.id=scope.division_id
          AND division.business_area_id=scope.business_area_id
        WHERE scope.record_id=resource.record_id AND scope.active=1
          AND (coalesce(area.active,0)<>1 OR (scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
      OR EXISTS(SELECT 1 FROM (
          SELECT 'directory.identity.link' permission UNION ALL SELECT 'directory.profile.edit'
        ) needed WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants allow_row
          WHERE allow_row.staff_id=history.actor_staff_id AND allow_row.permission=needed.permission
            AND allow_row.effect='allow' AND allow_row.active=1
            AND (allow_row.scope_kind='global'
              OR (allow_row.scope_kind='resource' AND allow_row.resource_id=resource.record_id)
              OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=resource.record_id AND assignment.staff_id=history.actor_staff_id AND assignment.active=1))
              OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
              OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
          OR EXISTS(SELECT 1 FROM native_directory_grants deny
            WHERE deny.staff_id=history.actor_staff_id AND deny.permission=needed.permission
              AND deny.effect='deny' AND deny.active=1
              AND (deny.scope_kind='global'
                OR (deny.scope_kind='resource' AND deny.resource_id=resource.record_id)
                OR (deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                  WHERE assignment.record_id=resource.record_id AND assignment.staff_id=history.actor_staff_id AND assignment.active=1))
                OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                  WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
                OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                  WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
      )
    )
  )
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_unsettled_commands pending
    JOIN project_alpha_directory_relationship_command_resources resource ON resource.command_id=command.command_id
    JOIN project_alpha_active_directory_mappings mapping
      ON mapping.record_id=resource.record_id AND mapping.resource_type=resource.record_kind
      AND mapping.source_id=command.source_id AND mapping.source_instance_id=command.source_instance_id
      AND mapping.application_id=command.application_id AND mapping.history_epoch_id=command.history_epoch_id
      AND mapping.project_alpha_public_id=resource.public_id
    WHERE pending.source_id=command.source_id AND pending.expected_source_instance_id=command.source_instance_id
      AND pending.application_id=command.application_id AND pending.expected_history_epoch_id=command.history_epoch_id
      AND pending.resource_type=resource.record_kind AND pending.external_id=mapping.external_id
      AND pending.state<>'acknowledged')
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox predecessor
    WHERE predecessor.command_id<>command.command_id AND predecessor.client_record_id=command.client_record_id
      AND predecessor.source_id=command.source_id AND predecessor.source_instance_id=command.source_instance_id
      AND predecessor.application_id=command.application_id AND predecessor.history_epoch_id=command.history_epoch_id
      AND predecessor.relationship_version=(SELECT max(candidate.relationship_version)
        FROM project_alpha_directory_relationship_outbox candidate
        WHERE candidate.command_id<>command.command_id AND candidate.client_record_id=command.client_record_id
          AND candidate.source_id=command.source_id AND candidate.source_instance_id=command.source_instance_id
          AND candidate.application_id=command.application_id AND candidate.history_epoch_id=command.history_epoch_id
          AND candidate.relationship_version<command.relationship_version)
      AND (predecessor.state IN ('pending','leased')
        OR (predecessor.state='terminal' AND command.supersedes_terminal_command_id IS NOT predecessor.command_id
          AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_validated_recovery_relationship_acknowledgements recovery
            WHERE recovery.identity_valid=1 AND recovery.predecessor_command_id=predecessor.command_id
              AND recovery.client_record_id=predecessor.client_record_id
              AND recovery.relationship_version=predecessor.relationship_version
              AND recovery.source_id=predecessor.source_id AND recovery.source_instance_id=predecessor.source_instance_id
              AND recovery.application_id=predecessor.application_id AND recovery.history_epoch_id=predecessor.history_epoch_id
              AND recovery.destination_origin=predecessor.destination_origin))))
  AND (command.supersedes_terminal_command_id IS NULL OR EXISTS(
    SELECT 1 FROM project_alpha_directory_relationship_outbox predecessor
    WHERE predecessor.command_id=command.supersedes_terminal_command_id AND predecessor.state='terminal'
      AND predecessor.client_record_id=command.client_record_id AND predecessor.source_id=command.source_id
      AND predecessor.source_instance_id=command.source_instance_id AND predecessor.application_id=command.application_id
      AND predecessor.history_epoch_id=command.history_epoch_id
      AND predecessor.relationship_version=(SELECT max(candidate.relationship_version)
        FROM project_alpha_directory_relationship_outbox candidate
        WHERE candidate.command_id<>command.command_id AND candidate.client_record_id=command.client_record_id
          AND candidate.source_id=command.source_id AND candidate.source_instance_id=command.source_instance_id
          AND candidate.application_id=command.application_id AND candidate.history_epoch_id=command.history_epoch_id
          AND candidate.relationship_version<command.relationship_version)))
  AND (
    EXISTS(SELECT 1 FROM project_alpha_directory_outbox evidence
      WHERE evidence.source_id=command.source_id AND evidence.expected_source_instance_id=command.source_instance_id
        AND evidence.application_id=command.application_id AND evidence.expected_history_epoch_id=command.history_epoch_id
        AND evidence.destination_base_url=command.destination_origin AND evidence.state='acknowledged'
        AND json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')=command.expected_authorization_generation)
    OR EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_revision_refresh_receipts evidence
      JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=evidence.native_owner_claim_id
      JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=claim.receipt_id
      JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
      WHERE evidence.source_id=command.source_id AND evidence.source_instance_id=command.source_instance_id
        AND evidence.application_id=command.application_id AND evidence.history_epoch_id=command.history_epoch_id
        AND response.destination_origin=command.destination_origin
        AND evidence.authorization_generation=command.expected_authorization_generation)
    OR EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox evidence
      WHERE evidence.command_id<>command.command_id AND evidence.source_id=command.source_id
        AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
        AND evidence.history_epoch_id=command.history_epoch_id AND evidence.destination_origin=command.destination_origin
        AND evidence.state='acknowledged'
        AND json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')=command.expected_authorization_generation)
    OR EXISTS(SELECT 1 FROM project_alpha_directory_validated_recovery_relationship_acknowledgements recovery
      JOIN project_alpha_directory_relationship_recovery_outbox evidence ON evidence.command_id=recovery.command_id
      WHERE recovery.identity_valid=1 AND evidence.source_id=command.source_id
        AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
        AND evidence.history_epoch_id=command.history_epoch_id AND evidence.destination_origin=command.destination_origin
        AND json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')=command.expected_authorization_generation)
  )
  AND NOT EXISTS(
    SELECT generation FROM (
      SELECT json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration') generation
      FROM project_alpha_directory_outbox evidence
      WHERE evidence.source_id=command.source_id AND evidence.expected_source_instance_id=command.source_instance_id
        AND evidence.application_id=command.application_id AND evidence.expected_history_epoch_id=command.history_epoch_id
        AND evidence.destination_base_url=command.destination_origin AND evidence.state='acknowledged'
      UNION ALL
      SELECT evidence.authorization_generation FROM project_alpha_existing_directory_binding_revision_refresh_receipts evidence
      JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=evidence.native_owner_claim_id
      JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=claim.receipt_id
      JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
      WHERE evidence.source_id=command.source_id AND evidence.source_instance_id=command.source_instance_id
        AND evidence.application_id=command.application_id AND evidence.history_epoch_id=command.history_epoch_id
        AND response.destination_origin=command.destination_origin
      UNION ALL
      SELECT json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')
      FROM project_alpha_directory_relationship_outbox evidence
      WHERE evidence.command_id<>command.command_id AND evidence.source_id=command.source_id
        AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
        AND evidence.history_epoch_id=command.history_epoch_id AND evidence.destination_origin=command.destination_origin
        AND evidence.state='acknowledged'
      UNION ALL
      SELECT json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')
      FROM project_alpha_directory_validated_recovery_relationship_acknowledgements recovery
      JOIN project_alpha_directory_relationship_recovery_outbox evidence ON evidence.command_id=recovery.command_id
      WHERE recovery.identity_valid=1 AND evidence.source_id=command.source_id
        AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
        AND evidence.history_epoch_id=command.history_epoch_id AND evidence.destination_origin=command.destination_origin
    ) WHERE generation IS NULL OR length(generation) NOT BETWEEN 1 AND 19
      OR generation GLOB '*[^0-9]*' OR (length(generation)>1 AND substr(generation,1,1)='0')
      OR (length(generation)=19 AND generation>'9223372036854775806')
      OR (length(generation)>length(command.expected_authorization_generation)
        OR (length(generation)=length(command.expected_authorization_generation)
          AND generation>command.expected_authorization_generation))
  )
  AND NOT EXISTS(
    SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
    WHERE resource.command_id=command.command_id AND resource.expected_revision IS NOT NULL AND (
      NOT EXISTS(SELECT 1 FROM project_alpha_directory_effective_relationship_revision_evidence evidence
        WHERE evidence.record_id=resource.record_id AND evidence.record_kind=resource.record_kind
          AND evidence.record_version=resource.record_version AND evidence.source_id=command.source_id
          AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
          AND evidence.history_epoch_id=command.history_epoch_id
          AND evidence.destination_origin=command.destination_origin
          AND evidence.public_id=resource.public_id AND evidence.revision=resource.expected_revision
          AND evidence.identity_valid=1)
      OR EXISTS(SELECT 1 FROM project_alpha_directory_effective_relationship_revision_evidence evidence
        WHERE evidence.record_id=resource.record_id AND evidence.record_kind=resource.record_kind
          AND evidence.record_version=resource.record_version AND evidence.source_id=command.source_id
          AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
          AND evidence.history_epoch_id=command.history_epoch_id
          AND evidence.destination_origin=command.destination_origin
          AND (evidence.identity_valid<>1 OR evidence.public_id IS NOT resource.public_id
            OR evidence.revision IS NULL OR length(evidence.revision) NOT BETWEEN 1 AND 19
            OR evidence.revision GLOB '*[^0-9]*' OR substr(evidence.revision,1,1)='0'
            OR (length(evidence.revision)=19 AND evidence.revision>'9223372036854775807')
            OR length(evidence.revision)>length(resource.expected_revision)
            OR (length(evidence.revision)=length(resource.expected_revision)
              AND evidence.revision>resource.expected_revision)))
    )
  );

CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_authorization_review_exact BEFORE INSERT
ON project_alpha_directory_relationship_generation_recovery_reviews
WHEN NEW.replay_request_path<>'/api/v2/directory/clients/'||NEW.client_public_id||'/organization/assign/commands'
 OR (SELECT count(*) FROM json_each(NEW.replay_conflict_json))<>6
 OR json_extract(NEW.replay_conflict_json,'$.apiVersion')<>'2'
 OR json_extract(NEW.replay_conflict_json,'$.sourceInstanceId')<>NEW.source_instance_id
 OR json_extract(NEW.replay_conflict_json,'$.applicationId')<>NEW.application_id
 OR json_extract(NEW.replay_conflict_json,'$.historyEpoch')<>NEW.history_epoch_id
 OR json_type(NEW.replay_conflict_json,'$.requestId')<>'text'
 OR length(json_extract(NEW.replay_conflict_json,'$.requestId'))<>36
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),9,1)<>'-'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),14,1)<>'-'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),15,1)<>'4'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),19,1)<>'-'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),20,1) NOT GLOB '[89ab]'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),24,1)<>'-'
 OR length(replace(json_extract(NEW.replay_conflict_json,'$.requestId'),'-',''))<>32
 OR replace(json_extract(NEW.replay_conflict_json,'$.requestId'),'-','') GLOB '*[^0-9a-f]*'
 OR json_type(NEW.replay_conflict_json,'$.error')<>'object'
 OR (SELECT count(*) FROM json_each(NEW.replay_conflict_json,'$.error'))<>1
 OR json_extract(NEW.replay_conflict_json,'$.error.code')<>'authorization_generation_conflict'
 OR NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox predecessor
  JOIN operations_directory_client_organizations relation ON relation.client_record_id=NEW.client_record_id
  JOIN operations_directory_client_organization_history history ON history.client_record_id=NEW.client_record_id
    AND history.relationship_version=NEW.relationship_version
  JOIN operations_directory_records client ON client.record_id=NEW.client_record_id
  JOIN operations_directory_records organization ON organization.record_id=NEW.intended_organization_record_id
  WHERE predecessor.command_id=NEW.predecessor_command_id AND NEW.root_command_id=NEW.predecessor_command_id
    AND predecessor.state='terminal' AND json_extract(predecessor.outcome_json,'$.httpStatus')=409
    AND predecessor.action='assign' AND predecessor.client_record_id=NEW.client_record_id
    AND predecessor.relationship_version=NEW.relationship_version
    AND predecessor.source_id=NEW.source_id AND predecessor.source_instance_id=NEW.source_instance_id
    AND predecessor.application_id=NEW.application_id AND predecessor.history_epoch_id=NEW.history_epoch_id
    AND predecessor.destination_origin=NEW.destination_origin
    AND predecessor.expected_current_organization_record_id IS NULL
    AND predecessor.organization_record_id=NEW.intended_organization_record_id
    AND predecessor.client_public_id=NEW.client_public_id
    AND predecessor.expected_client_revision=NEW.expected_client_revision
    AND predecessor.organization_public_id=NEW.organization_public_id
    AND predecessor.expected_organization_revision=NEW.expected_organization_revision
    AND relation.relationship_version=NEW.relationship_version
    AND relation.organization_record_id=NEW.intended_organization_record_id
    AND history.mutation_id=predecessor.mutation_id AND history.previous_organization_record_id IS NULL
    AND history.organization_record_id=NEW.intended_organization_record_id
    AND history.client_record_version=NEW.client_record_version
    AND history.organization_record_version=NEW.organization_record_version
    AND client.record_kind='client' AND client.current_version=NEW.client_record_version
    AND organization.record_kind='organization' AND organization.current_version=NEW.organization_record_version
    AND NEW.remote_parent_public_id IS NULL AND NEW.remote_client_revision=NEW.expected_client_revision
    AND NEW.target_binding_active=1 AND NEW.target_binding_revision=NEW.expected_organization_revision
    AND (length(NEW.observed_authorization_generation)>length(predecessor.expected_authorization_generation)
      OR length(NEW.observed_authorization_generation)=length(predecessor.expected_authorization_generation)
        AND NEW.observed_authorization_generation>predecessor.expected_authorization_generation)
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox later
      WHERE later.client_record_id=NEW.client_record_id AND later.source_id=NEW.source_id
       AND later.source_instance_id=NEW.source_instance_id AND later.application_id=NEW.application_id
       AND later.history_epoch_id=NEW.history_epoch_id AND later.created_at>predecessor.created_at))
 OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts receipt
    WHERE receipt.source_id=NEW.source_id AND receipt.source_instance_id=NEW.source_instance_id
      AND receipt.application_id=NEW.application_id AND receipt.history_epoch_id=NEW.history_epoch_id
      AND receipt.inventory_kind='directory' AND receipt.request_id=NEW.client_inventory_request_id
      AND receipt.authorization_generation=NEW.observed_authorization_generation)
 OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts receipt
    WHERE receipt.source_id=NEW.source_id AND receipt.source_instance_id=NEW.source_instance_id
      AND receipt.application_id=NEW.application_id AND receipt.history_epoch_id=NEW.history_epoch_id
      AND receipt.inventory_kind='directory' AND receipt.request_id=NEW.organization_inventory_request_id
      AND receipt.authorization_generation=NEW.observed_authorization_generation)
 OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations observation
    WHERE observation.source_id=NEW.source_id AND observation.source_instance_id=NEW.source_instance_id
      AND observation.application_id=NEW.application_id AND observation.history_epoch_id=NEW.history_epoch_id
      AND observation.request_id=NEW.client_inventory_request_id AND observation.resource_type='client'
      AND observation.project_alpha_public_id=NEW.client_public_id AND observation.resource_revision=NEW.remote_client_revision
      AND observation.present=1 AND observation.binding_external_id=NEW.client_external_id AND observation.binding_status='active')
 OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations observation
    WHERE observation.source_id=NEW.source_id AND observation.source_instance_id=NEW.source_instance_id
      AND observation.application_id=NEW.application_id AND observation.history_epoch_id=NEW.history_epoch_id
      AND observation.request_id=NEW.organization_inventory_request_id AND observation.resource_type='organization'
      AND observation.project_alpha_public_id=NEW.organization_public_id AND observation.resource_revision=NEW.expected_organization_revision
      AND observation.present=1 AND observation.binding_external_id=NEW.organization_external_id
      AND observation.binding_status='active' AND observation.binding_resource_revision=NEW.target_binding_revision)
 OR EXISTS(SELECT 1 FROM (SELECT NEW.client_record_id record_id UNION ALL SELECT NEW.intended_organization_record_id) resource
    WHERE NOT EXISTS(SELECT 1 FROM effective_native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
      WHERE enrollment.record_id=resource.record_id AND json_extract(destination.value,'$.sourceId')=NEW.source_id
        AND json_extract(destination.value,'$.sourceInstanceUUID')=NEW.source_instance_id
        AND json_extract(destination.value,'$.applicationUUID')=NEW.application_id
        AND json_extract(destination.value,'$.historyEpoch')=NEW.history_epoch_id
        AND json_extract(destination.value,'$.origin')=NEW.destination_origin
        AND json_extract(destination.value,'$.externalCanonicalId')=CASE
          WHEN resource.record_id=NEW.client_record_id THEN NEW.client_external_id ELSE NEW.organization_external_id END))
 OR NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
    WHERE mapping.record_id=NEW.client_record_id AND mapping.resource_type='client'
      AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
      AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
      AND mapping.external_id=NEW.client_external_id AND mapping.project_alpha_public_id=NEW.client_public_id)
 OR NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
    WHERE mapping.record_id=NEW.intended_organization_record_id AND mapping.resource_type='organization'
      AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
      AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
      AND mapping.external_id=NEW.organization_external_id AND mapping.project_alpha_public_id=NEW.organization_public_id)
BEGIN SELECT RAISE(ABORT,'relationship generation recovery review evidence is not current and exact'); END;

CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_client_enrollment BEFORE INSERT
ON project_alpha_directory_relationship_generation_recoveries
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recovery_reviews review
    WHERE review.review_id=NEW.review_id AND NOT EXISTS(
      SELECT 1 FROM effective_native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
      WHERE enrollment.record_id=review.client_record_id
        AND json_extract(destination.value,'$.sourceId')=review.source_id
        AND json_extract(destination.value,'$.sourceInstanceUUID')=review.source_instance_id
        AND json_extract(destination.value,'$.applicationUUID')=review.application_id
        AND json_extract(destination.value,'$.historyEpoch')=review.history_epoch_id
        AND json_extract(destination.value,'$.origin')=review.destination_origin
        AND json_extract(destination.value,'$.externalCanonicalId')=review.client_external_id))
BEGIN SELECT RAISE(ABORT,'relationship generation recovery client enrollment is not current'); END;

CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_organization_enrollment BEFORE INSERT
ON project_alpha_directory_relationship_generation_recoveries
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recovery_reviews review
    WHERE review.review_id=NEW.review_id AND NOT EXISTS(
      SELECT 1 FROM effective_native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
      WHERE enrollment.record_id=review.intended_organization_record_id
        AND json_extract(destination.value,'$.sourceId')=review.source_id
        AND json_extract(destination.value,'$.sourceInstanceUUID')=review.source_instance_id
        AND json_extract(destination.value,'$.applicationUUID')=review.application_id
        AND json_extract(destination.value,'$.historyEpoch')=review.history_epoch_id
        AND json_extract(destination.value,'$.origin')=review.destination_origin
        AND json_extract(destination.value,'$.externalCanonicalId')=review.organization_external_id))
BEGIN SELECT RAISE(ABORT,'relationship generation recovery organization enrollment is not current'); END;

CREATE VIEW project_alpha_directory_live_relationship_generation_recoveries AS
SELECT recovery.* FROM project_alpha_directory_relationship_generation_recoveries recovery
JOIN project_alpha_directory_relationship_generation_recovery_reviews review ON review.review_id=recovery.review_id
JOIN staff_users staff ON staff.id=recovery.actor_staff_id AND staff.status='active'
 AND staff.access_subject=recovery.actor_access_subject
JOIN native_staff_admissions admission ON admission.staff_id=recovery.actor_staff_id AND admission.active=1
 AND admission.bound_access_subject=recovery.actor_access_subject AND admission.version=recovery.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=recovery.actor_staff_id
 AND profile.login_email=recovery.actor_email AND profile.version=recovery.actor_profile_version
JOIN staff_role_assignments administrator ON administrator.staff_id=recovery.actor_staff_id
 AND administrator.role_id IN ('role-owner','role-admin') AND administrator.scope='global'
JOIN operations_directory_client_organizations relation ON relation.client_record_id=recovery.client_record_id
 AND relation.relationship_version=recovery.relationship_version AND relation.organization_record_id=review.intended_organization_record_id
WHERE review.state='authorized' AND recovery.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND NOT EXISTS(SELECT 1 FROM json_each(recovery.selected_grants_json) selected
  WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants g
    WHERE g.id=json_extract(selected.value,'$.grantId') AND g.staff_id=recovery.actor_staff_id
      AND g.permission=json_extract(selected.value,'$.permission') AND g.effect='allow' AND g.active=1
      AND (g.scope_kind='global' OR g.scope_kind='resource' AND g.resource_id=json_extract(selected.value,'$.recordId')
       OR g.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=json_extract(selected.value,'$.recordId') AND a.staff_id=recovery.actor_staff_id AND a.active=1)
       OR g.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.business_area_id=g.business_area_id)
       OR g.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.division_id=g.division_id)))
   OR EXISTS(SELECT 1 FROM native_directory_grants d WHERE d.staff_id=recovery.actor_staff_id
      AND d.permission=json_extract(selected.value,'$.permission') AND d.effect='deny' AND d.active=1
      AND (d.scope_kind='global' OR d.scope_kind='resource' AND d.resource_id=json_extract(selected.value,'$.recordId')
       OR d.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=json_extract(selected.value,'$.recordId') AND a.staff_id=recovery.actor_staff_id AND a.active=1)
       OR d.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.business_area_id=d.business_area_id)
       OR d.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.division_id=d.division_id))))
 AND NOT EXISTS(SELECT 1 FROM (SELECT review.client_record_id record_id UNION ALL SELECT review.intended_organization_record_id) resource
   WHERE NOT EXISTS(SELECT 1 FROM effective_native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
    WHERE enrollment.record_id=resource.record_id AND json_extract(destination.value,'$.sourceId')=review.source_id
      AND json_extract(destination.value,'$.sourceInstanceUUID')=review.source_instance_id
      AND json_extract(destination.value,'$.applicationUUID')=review.application_id
      AND json_extract(destination.value,'$.historyEpoch')=review.history_epoch_id
      AND json_extract(destination.value,'$.origin')=review.destination_origin
      AND json_extract(destination.value,'$.externalCanonicalId')=CASE
        WHEN resource.record_id=review.client_record_id THEN review.client_external_id ELSE review.organization_external_id END));

CREATE VIEW operations_directory_live_lifecycle_fences AS
SELECT fence.* FROM operations_directory_lifecycle_fences fence
JOIN operations_directory_lifecycle_observation_sets proof ON proof.mutation_id=fence.mutation_id
  AND proof.record_id=fence.record_id AND proof.record_kind=fence.record_kind AND proof.action=fence.action
  AND json(proof.observations_json)=json(fence.observations_json) AND proof.verified_until=fence.verified_until
JOIN operations_directory_records record ON record.record_id=fence.record_id
  AND record.record_kind=fence.record_kind AND record.current_version=fence.expected_record_version
LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=fence.record_id
JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=fence.record_id
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
