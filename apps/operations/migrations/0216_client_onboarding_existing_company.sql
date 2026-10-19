PRAGMA foreign_keys = ON;

-- Only explicit exact-record company reuse is supported. The regular 0083
-- organization writer still owns authority, revision, audit and PA delivery.
-- This additional fence forbids using recipient-supplied company fields or
-- silently acquiring another PA destination during a new-contact approval.
CREATE TRIGGER client_onboarding_existing_company_fence BEFORE INSERT ON client_onboarding_decision_fences
WHEN NEW.outcome='approved' AND NEW.organization_target_kind='existing'
  AND (NEW.client_target_kind<>'new' OR NEW.relationship_mode<>'change'
    OR NOT EXISTS(SELECT 1 FROM operations_directory_records organization
      JOIN operations_directory_revisions revision ON revision.record_id=organization.record_id
        AND revision.version=organization.current_version
      JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=organization.record_id
      LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=organization.record_id
      WHERE organization.record_id=NEW.organization_record_id AND organization.record_kind='organization'
        AND organization.current_version=NEW.organization_expected_version
        AND json(revision.profile_json)=json(NEW.organization_profile_json)
        AND (lifecycle.record_id IS NULL OR lifecycle.status='active')
        AND NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_members member
          WHERE member.record_id=organization.record_id)
        AND json_array_length(enrollment.destinations_json)=json_array_length(NEW.organization_destinations_json)
        AND NOT EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) parent
          WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.organization_destinations_json) chosen
            WHERE json(parent.value)=json(chosen.value))))
    OR EXISTS(SELECT 1 FROM json_each(NEW.client_destinations_json) child
      WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.organization_destinations_json) parent
        WHERE json_extract(parent.value,'$.sourceId')=json_extract(child.value,'$.sourceId')
          AND json_extract(parent.value,'$.sourceInstanceUUID')=json_extract(child.value,'$.sourceInstanceUUID')
          AND json_extract(parent.value,'$.applicationUUID')=json_extract(child.value,'$.applicationUUID')
          AND json_extract(parent.value,'$.historyEpoch')=json_extract(child.value,'$.historyEpoch')
          AND json_extract(parent.value,'$.origin')=json_extract(child.value,'$.origin'))))
BEGIN SELECT RAISE(ABORT,'onboarding existing company requires exact preserved active ungrouped source coverage'); END;
