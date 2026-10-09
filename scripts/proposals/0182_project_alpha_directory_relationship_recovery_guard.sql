-- Local proposal only. Promote through the reviewed migration process after
-- the canonical 0181 migration and authority pins are intentionally advanced.
-- This is the 0172 view definition verbatim except that pending profile
-- commands are read through the recovery-aware 0181 unsettled-command view.

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

-- The 0181 recovery-aware revision view retained the pre-profile-transport
-- create-only resource.id check. Keep every UNION arm and coordinate join,
-- but authenticate create and update acknowledgements by their exact wire
-- contracts before exposing revision evidence to the 0133 insert guard.
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
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND (SELECT count(*) FROM json_each(outbox.outcome_json))=2
      AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response'))=6
      AND json_type(outbox.outcome_json,'$.response.requestId')='text'
      AND length(json_extract(outbox.outcome_json,'$.response.requestId'))=36
      AND substr(json_extract(outbox.outcome_json,'$.response.requestId'),9,1)='-'
      AND substr(json_extract(outbox.outcome_json,'$.response.requestId'),14,1)='-'
      AND substr(json_extract(outbox.outcome_json,'$.response.requestId'),15,1)='4'
      AND substr(json_extract(outbox.outcome_json,'$.response.requestId'),19,1)='-'
      AND substr(json_extract(outbox.outcome_json,'$.response.requestId'),20,1) GLOB '[89ab]'
      AND substr(json_extract(outbox.outcome_json,'$.response.requestId'),24,1)='-'
      AND length(replace(json_extract(outbox.outcome_json,'$.response.requestId'),'-',''))=32
      AND replace(json_extract(outbox.outcome_json,'$.response.requestId'),'-','') NOT GLOB '*[^0-9a-f]*'
      AND json_type(outbox.outcome_json,'$.response.replayed') IN ('true','false')
      AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=3
      AND json_type(outbox.outcome_json,'$.response.result.data')='object'
      AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.data'))=1
      AND json_type(outbox.outcome_json,'$.response.result.authorizationGeneration')='text'
      AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') GLOB '[0-9]*'
      AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') NOT GLOB '*[^0-9]*'
      AND (json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')='0'
        OR substr(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'),1,1)<>'0')
      AND length(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'))<=19
      AND (length(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'))<19
        OR json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')<='9223372036854775807')
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')=outbox.resource_type
      AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=
        json_extract(outbox.outcome_json,'$.response.result.resource.publicId')
      AND materialization.command_json=outbox.command_json
      AND EXISTS(SELECT 1 FROM operations_directory_records current_record
        WHERE current_record.record_id=intent.record_id AND current_record.record_kind=outbox.resource_type
          AND current_record.current_version=intent.record_version)
      AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
        WHERE mapping.record_id=intent.record_id AND mapping.resource_type=outbox.resource_type
          AND mapping.source_id=intent.source_id AND mapping.source_instance_id=intent.source_instance_uuid
          AND mapping.application_id=intent.application_uuid AND mapping.history_epoch_id=intent.expected_history_epoch_id
          AND mapping.external_id=outbox.external_id
          AND mapping.project_alpha_public_id=json_extract(outbox.outcome_json,'$.response.result.resource.publicId'))
      AND CASE json_extract(materialization.command_json,'$.operation')
        WHEN 'create' THEN
          (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.resource'))=4
          AND json_extract(materialization.command_json,'$.expectedRevision')='0'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=outbox.external_id
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')='1'
          AND json_type(materialization.command_json,'$.expectedAuthorizationGeneration')='text'
          AND json_extract(materialization.command_json,'$.expectedAuthorizationGeneration') GLOB '[0-9]*'
          AND json_extract(materialization.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '*[^0-9]*'
          AND (json_extract(materialization.command_json,'$.expectedAuthorizationGeneration')='0'
            OR substr(json_extract(materialization.command_json,'$.expectedAuthorizationGeneration'),1,1)<>'0')
          AND length(json_extract(materialization.command_json,'$.expectedAuthorizationGeneration'))<=19
          AND (length(json_extract(materialization.command_json,'$.expectedAuthorizationGeneration'))<19
            OR json_extract(materialization.command_json,'$.expectedAuthorizationGeneration')<='9223372036854775807')
          AND json_extract(materialization.command_json,'$.expectedAuthorizationGeneration')<>'9223372036854775807'
          AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')=
            CAST(CAST(json_extract(materialization.command_json,'$.expectedAuthorizationGeneration') AS INTEGER)+1 AS TEXT)
        WHEN 'update' THEN
          (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.resource'))=3
          AND json_extract(materialization.command_json,'$.expectedProjectAlphaPublicId')=
            json_extract(outbox.outcome_json,'$.response.result.resource.publicId')
          AND json_type(materialization.command_json,'$.expectedAuthorizationGeneration')='text'
          AND json_extract(materialization.command_json,'$.expectedAuthorizationGeneration') GLOB '[0-9]*'
          AND json_extract(materialization.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '*[^0-9]*'
          AND (json_extract(materialization.command_json,'$.expectedAuthorizationGeneration')='0'
            OR substr(json_extract(materialization.command_json,'$.expectedAuthorizationGeneration'),1,1)<>'0')
          AND length(json_extract(materialization.command_json,'$.expectedAuthorizationGeneration'))<=19
          AND (length(json_extract(materialization.command_json,'$.expectedAuthorizationGeneration'))<19
            OR json_extract(materialization.command_json,'$.expectedAuthorizationGeneration')<='9223372036854775807')
          AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')=
            json_extract(materialization.command_json,'$.expectedAuthorizationGeneration')
          AND json_type(materialization.command_json,'$.expectedRevision')='text'
          AND json_extract(materialization.command_json,'$.expectedRevision') GLOB '[1-9]*'
          AND json_extract(materialization.command_json,'$.expectedRevision') NOT GLOB '*[^0-9]*'
          AND length(json_extract(materialization.command_json,'$.expectedRevision'))<=19
          AND (length(json_extract(materialization.command_json,'$.expectedRevision'))<19
            OR json_extract(materialization.command_json,'$.expectedRevision')<='9223372036854775807')
          AND json_type(outbox.outcome_json,'$.response.result.resource.revision')='text'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision') GLOB '[1-9]*'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision') NOT GLOB '*[^0-9]*'
          AND length(json_extract(outbox.outcome_json,'$.response.result.resource.revision'))<=19
          AND (length(json_extract(outbox.outcome_json,'$.response.result.resource.revision'))<19
            OR json_extract(outbox.outcome_json,'$.response.result.resource.revision')<='9223372036854775807')
          AND (length(json_extract(outbox.outcome_json,'$.response.result.resource.revision'))>
              length(json_extract(materialization.command_json,'$.expectedRevision'))
            OR (length(json_extract(outbox.outcome_json,'$.response.result.resource.revision'))=
                length(json_extract(materialization.command_json,'$.expectedRevision'))
              AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')>=
                json_extract(materialization.command_json,'$.expectedRevision')))
        ELSE 0 END
    THEN 1 ELSE 0 END AS identity_valid
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
