PRAGMA foreign_keys = ON;

-- 0125 makes deliberately activated acquired Directory bindings visible
-- without copying them into the legacy mapping table. Replace only the 0124
-- Project review/reservation current-state triggers so both legacy and
-- activated mappings pass the same exact identity and relationship fences.
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
 OR (NEW.organization_record_id IS NOT NULL AND (SELECT count(*) FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='organization'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
     AND mapping.resource_type='organization' AND mapping.external_id=NEW.organization_record_id AND mapping.project_alpha_public_id=NEW.organization_project_alpha_public_id)<>1)
 OR (NEW.client_record_id IS NOT NULL AND (SELECT count(*) FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='client'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
     AND mapping.resource_type='client' AND mapping.external_id=NEW.client_record_id AND mapping.project_alpha_public_id=NEW.client_project_alpha_public_id)<>1)
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
 OR (NEW.organization_record_id IS NOT NULL AND (SELECT count(*) FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='organization'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.resource_type='organization'
     AND mapping.external_id=NEW.organization_record_id AND mapping.project_alpha_public_id=NEW.organization_project_alpha_public_id)<>1)
 OR (NEW.client_record_id IS NOT NULL AND (SELECT count(*) FROM project_alpha_active_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='client'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.resource_type='client'
     AND mapping.external_id=NEW.client_record_id AND mapping.project_alpha_public_id=NEW.client_project_alpha_public_id)<>1)
 OR (NEW.organization_record_id IS NOT NULL AND NEW.client_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
   WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
BEGIN SELECT RAISE(ABORT,'project adoption review reservation is not current and exact'); END;
