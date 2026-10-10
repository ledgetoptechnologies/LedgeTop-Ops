PRAGMA foreign_keys = ON;

-- 0170 separated the Operations Directory record ID from Project Alpha's
-- external ID for activated, acquired bindings. Replace the remaining
-- current-state consumers that still treated those two identities as equal.
-- Every PA-side comparison remains on external_id; every Operations FK and
-- relationship comparison uses record_id.

DROP TRIGGER project_alpha_project_adoption_review_evidence_current;
DROP TRIGGER project_alpha_project_adoption_review_reservations_exact;

CREATE TRIGGER project_alpha_project_adoption_review_evidence_current
BEFORE INSERT ON project_alpha_project_adoption_review_evidence
WHEN NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_destinations destination
   WHERE destination.external_project_id=NEW.external_project_id AND destination.source_id=NEW.source_id
     AND destination.application_id=NEW.application_id AND destination.expected_source_instance_id=NEW.source_instance_id
     AND destination.expected_history_epoch_id=NEW.history_epoch_id)
 OR EXISTS (SELECT 1 FROM operations_shared_projects project WHERE project.external_project_id=NEW.external_project_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
   WHERE mapping.external_project_id=NEW.external_project_id
      OR (mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
        AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
        AND mapping.project_alpha_public_id=NEW.project_alpha_public_id))
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox
   WHERE outbox.external_project_id=NEW.external_project_id AND outbox.state IN ('pending','leased'))
 OR NOT EXISTS (SELECT 1 FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
   JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
   WHERE admission.staff_id=NEW.reviewer_staff_id AND admission.active=1 AND admission.bound_access_subject=NEW.reviewer_access_subject
     AND admission.version=NEW.reviewer_admission_version AND profile.version=NEW.reviewer_profile_version AND generation.generation=NEW.project_grant_generation)
 OR NOT EXISTS (SELECT 1 FROM staff_role_assignments owner_assignment
   WHERE owner_assignment.staff_id=NEW.reviewer_staff_id AND owner_assignment.role_id=NEW.reviewer_owner_role_id AND owner_assignment.scope='global')
 OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
   WHERE json_type(scope.value)<>'object' OR (SELECT count(*) FROM json_each(scope.value))<>3
     OR EXISTS (SELECT 1 FROM json_each(scope.value) field WHERE field.key NOT IN ('scopeKind','businessAreaId','divisionId'))
     OR json_extract(scope.value,'$.scopeKind') NOT IN ('business_area','division')
     OR json_type(scope.value,'$.businessAreaId')<>'text'
     OR (json_extract(scope.value,'$.scopeKind')='business_area' AND json_type(scope.value,'$.divisionId')<>'null')
     OR (json_extract(scope.value,'$.scopeKind')='division' AND json_type(scope.value,'$.divisionId')<>'text'))
 OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
   WHERE NOT EXISTS (SELECT 1 FROM native_business_areas area
     LEFT JOIN native_business_divisions division
       ON division.id=json_extract(scope.value,'$.divisionId') AND division.business_area_id=area.id AND division.active=1
     WHERE area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
       AND (json_extract(scope.value,'$.scopeKind')='business_area'
         OR (json_extract(scope.value,'$.scopeKind')='division' AND division.id IS NOT NULL))))
 OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
   WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
     WHERE grant_row.staff_id=NEW.reviewer_staff_id AND grant_row.capability='project.shared.sync' AND grant_row.effect='allow' AND grant_row.active=1
       AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=NEW.external_project_id)
         OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
         OR (grant_row.scope_kind='division' AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
 OR (json_array_length(NEW.normalized_scopes_json)=0 AND NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
   WHERE grant_row.staff_id=NEW.reviewer_staff_id AND grant_row.capability='project.shared.sync' AND grant_row.effect='allow' AND grant_row.active=1
     AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=NEW.external_project_id))))
 OR EXISTS (SELECT 1 FROM native_project_grants deny WHERE deny.staff_id=NEW.reviewer_staff_id AND deny.capability='project.shared.sync' AND deny.effect='deny' AND deny.active=1
   AND (deny.scope_kind='global' OR (deny.scope_kind='exact_project' AND deny.external_project_id=NEW.external_project_id)
     OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope WHERE (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId')) OR (deny.scope_kind='division' AND deny.division_id=json_extract(scope.value,'$.divisionId')))))
 OR (NEW.organization_record_id IS NOT NULL AND (SELECT count(*) FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind='organization'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
     AND mapping.resource_type='organization' AND mapping.record_id=NEW.organization_record_id AND mapping.project_alpha_public_id=NEW.organization_project_alpha_public_id)<>1)
 OR (NEW.client_record_id IS NOT NULL AND (SELECT count(*) FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind='client'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
     AND mapping.resource_type='client' AND mapping.record_id=NEW.client_record_id AND mapping.project_alpha_public_id=NEW.client_project_alpha_public_id)<>1)
 OR (NEW.organization_record_id IS NOT NULL AND NEW.client_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
   WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
BEGIN SELECT RAISE(ABORT,'project adoption review requires current authority and directory mappings'); END;

CREATE TRIGGER project_alpha_project_adoption_review_reservations_exact
BEFORE INSERT ON project_alpha_project_adoption_review_reservations
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_evidence review
  WHERE review.review_item_id=NEW.review_item_id AND review.request_sha256=NEW.request_sha256
    AND review.source_id=NEW.source_id AND review.source_instance_id=NEW.source_instance_id AND review.application_id=NEW.application_id AND review.history_epoch_id=NEW.history_epoch_id
    AND review.external_project_id=NEW.external_project_id AND review.project_alpha_public_id=NEW.project_alpha_public_id AND review.project_alpha_revision=NEW.project_alpha_revision
    AND review.projection_sha256=NEW.projection_sha256 AND review.authorization_generation=NEW.authorization_generation AND review.canonical_detail_read_sha256=NEW.canonical_detail_read_sha256
    AND review.organization_record_id IS NEW.organization_record_id AND review.organization_project_alpha_public_id IS NEW.organization_project_alpha_public_id
    AND review.client_record_id IS NEW.client_record_id AND review.client_project_alpha_public_id IS NEW.client_project_alpha_public_id
    AND review.reviewer_staff_id=NEW.reviewer_staff_id AND review.reviewer_access_subject=NEW.reviewer_access_subject
    AND review.reviewer_admission_version=NEW.reviewer_admission_version AND review.reviewer_profile_version=NEW.reviewer_profile_version
    AND review.reviewer_owner_role_id=NEW.reviewer_owner_role_id AND review.independent_evidence_sha256=NEW.independent_evidence_sha256
    AND review.project_grant_generation=NEW.project_grant_generation AND json(review.normalized_scopes_json)=json(NEW.normalized_scopes_json)
    AND review.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_destinations destination
   WHERE destination.external_project_id=NEW.external_project_id AND destination.source_id=NEW.source_id
     AND destination.application_id=NEW.application_id AND destination.expected_source_instance_id=NEW.source_instance_id
     AND destination.expected_history_epoch_id=NEW.history_epoch_id)
 OR EXISTS (SELECT 1 FROM operations_shared_projects project WHERE project.external_project_id=NEW.external_project_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
   WHERE mapping.external_project_id=NEW.external_project_id
      OR (mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
        AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
        AND mapping.project_alpha_public_id=NEW.project_alpha_public_id))
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox
   WHERE outbox.external_project_id=NEW.external_project_id AND outbox.state IN ('pending','leased'))
 OR NOT EXISTS (SELECT 1 FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
   WHERE admission.staff_id=NEW.reviewer_staff_id AND admission.active=1 AND admission.bound_access_subject=NEW.reviewer_access_subject AND admission.version=NEW.reviewer_admission_version
     AND profile.version=NEW.reviewer_profile_version AND generation.generation=NEW.project_grant_generation)
 OR NOT EXISTS (SELECT 1 FROM staff_role_assignments owner_assignment
   WHERE owner_assignment.staff_id=NEW.reviewer_staff_id AND owner_assignment.role_id=NEW.reviewer_owner_role_id AND owner_assignment.scope='global')
 OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
   WHERE NOT EXISTS (SELECT 1 FROM native_business_areas area
     LEFT JOIN native_business_divisions division
       ON division.id=json_extract(scope.value,'$.divisionId') AND division.business_area_id=area.id AND division.active=1
     WHERE area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
       AND (json_extract(scope.value,'$.scopeKind')='business_area'
         OR (json_extract(scope.value,'$.scopeKind')='division' AND division.id IS NOT NULL))))
 OR (NEW.organization_record_id IS NOT NULL AND (SELECT count(*) FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind='organization'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.resource_type='organization'
     AND mapping.record_id=NEW.organization_record_id AND mapping.project_alpha_public_id=NEW.organization_project_alpha_public_id)<>1)
 OR (NEW.client_record_id IS NOT NULL AND (SELECT count(*) FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind='client'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.resource_type='client'
     AND mapping.record_id=NEW.client_record_id AND mapping.project_alpha_public_id=NEW.client_project_alpha_public_id)<>1)
 OR (NEW.organization_record_id IS NOT NULL AND NEW.client_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
   WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
BEGIN SELECT RAISE(ABORT,'project adoption review reservation is not current and exact'); END;

DROP TRIGGER project_alpha_project_adoption_bind_receipts_directory_exact;
CREATE TRIGGER project_alpha_project_adoption_bind_receipts_directory_exact
BEFORE INSERT ON project_alpha_project_adoption_bind_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_reservations reservation
  WHERE reservation.reservation_id=NEW.reservation_id AND (
    EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=reservation.external_project_id
        OR (mapping.source_id=reservation.source_id AND mapping.source_instance_id=reservation.source_instance_id
          AND mapping.application_id=reservation.application_id AND mapping.history_epoch_id=reservation.history_epoch_id
          AND mapping.project_alpha_public_id=reservation.project_alpha_public_id))
    OR (reservation.organization_record_id IS NOT NULL AND (SELECT count(*)
      FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind='organization'
      WHERE mapping.source_id=reservation.source_id AND mapping.source_instance_id=reservation.source_instance_id
        AND mapping.application_id=reservation.application_id AND mapping.history_epoch_id=reservation.history_epoch_id
        AND mapping.resource_type='organization' AND mapping.record_id=reservation.organization_record_id
        AND mapping.project_alpha_public_id=reservation.organization_project_alpha_public_id)<>1)
    OR (reservation.client_record_id IS NOT NULL AND (SELECT count(*)
      FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind='client'
      WHERE mapping.source_id=reservation.source_id AND mapping.source_instance_id=reservation.source_instance_id
        AND mapping.application_id=reservation.application_id AND mapping.history_epoch_id=reservation.history_epoch_id
        AND mapping.resource_type='client' AND mapping.record_id=reservation.client_record_id
        AND mapping.project_alpha_public_id=reservation.client_project_alpha_public_id)<>1)
    OR (reservation.organization_record_id IS NOT NULL AND reservation.client_record_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=reservation.client_record_id
          AND relationship.organization_record_id=reservation.organization_record_id))
  ))
BEGIN SELECT RAISE(ABORT,'project adoption bind directory identity is not exact'); END;

DROP TRIGGER operations_shared_project_revisions_bound_guard;
CREATE TRIGGER operations_shared_project_revisions_bound_guard BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.refresh_command_id IS NOT NULL AND NEW.v2_settlement_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM operations_shared_projects project
  JOIN project_alpha_project_refresh refresh ON refresh.external_project_id=project.external_project_id
    AND refresh.establishment_command_id=NEW.refresh_command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=NEW.refresh_command_id
    AND proof.external_project_id=project.external_project_id
  WHERE project.external_project_id=NEW.external_project_id AND NEW.version=1
    AND project.current_version=1 AND project.pa_revision=NEW.pa_revision
    AND json_type(NEW.read_json,'$.resource.revision')='text'
    AND json_extract(NEW.read_json,'$.resource.revision')=NEW.pa_revision
    AND json_extract(NEW.read_json,'$.resource.id')=project.project_alpha_public_id
    AND json_extract(NEW.read_json,'$.data.publicId')=project.project_alpha_public_id
    AND json_extract(NEW.read_json,'$.sourceInstanceId')=project.source_instance_id
    AND json_extract(NEW.read_json,'$.applicationId')=project.application_id
    AND json_extract(NEW.read_json,'$.historyEpoch')=project.history_epoch_id
    AND json_extract(NEW.read_json,'$.data.name')=project.name
    AND json_extract(NEW.read_json,'$.data.lifecycle')=project.lifecycle
    AND json_extract(NEW.read_json,'$.data.plannedStart') IS project.planned_start
    AND json_extract(NEW.read_json,'$.data.plannedEnd') IS project.planned_end
    AND (project.organization_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.organizationPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='organization' AND customer.record_id=project.organization_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.organizationPublicId')))
    AND (project.client_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='client' AND customer.record_id=project.client_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId')))
)
BEGIN SELECT RAISE(ABORT,'bound shared project revision is not authorized'); END;

DROP VIEW project_alpha_directory_live_relationship_commands;
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
          AND EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
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
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox pending
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
        OR (predecessor.state='terminal' AND command.supersedes_terminal_command_id IS NOT predecessor.command_id)))
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
      NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_revision_evidence evidence
        WHERE evidence.record_id=resource.record_id AND evidence.record_kind=resource.record_kind
          AND evidence.record_version=resource.record_version AND evidence.source_id=command.source_id
          AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
          AND evidence.history_epoch_id=command.history_epoch_id
          AND evidence.destination_origin=command.destination_origin
          AND evidence.public_id=resource.public_id AND evidence.revision=resource.expected_revision
          AND evidence.identity_valid=1)
      OR EXISTS(SELECT 1 FROM project_alpha_directory_relationship_revision_evidence evidence
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
