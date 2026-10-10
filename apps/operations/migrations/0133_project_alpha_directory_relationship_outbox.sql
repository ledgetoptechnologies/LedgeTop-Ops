PRAGMA foreign_keys = ON;

-- A relationship mutation is authoritative in Ops.  PA propagation is one
-- durable command per enrolled destination and is deliberately separate from
-- profile materializations.  No mapping, delivery, or public-link row is
-- rewritten by this ledger.
CREATE TABLE project_alpha_directory_relationship_outbox (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id)=36 AND command_id=lower(command_id)
    AND command_id NOT GLOB '*[^0-9a-f-]*' AND substr(command_id,9,1)='-'
    AND substr(command_id,14,1)='-' AND substr(command_id,15,1)='4'
    AND substr(command_id,19,1)='-' AND substr(command_id,20,1) IN ('8','9','a','b')
    AND substr(command_id,24,1)='-' AND length(replace(command_id,'-',''))=32),
  mutation_id TEXT NOT NULL,
  client_record_id TEXT NOT NULL,
  relationship_version INTEGER NOT NULL CHECK(typeof(relationship_version)='integer' AND relationship_version>=2),
  action TEXT NOT NULL CHECK(action IN ('assign','remove','move')),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:'),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  destination_origin TEXT NOT NULL CHECK(substr(destination_origin,1,8)='https://' AND length(destination_origin)<=2048),
  client_public_id TEXT NOT NULL CHECK(length(client_public_id)=32 AND client_public_id NOT GLOB '*[^0-9a-f]*'),
  expected_client_revision TEXT NOT NULL CHECK(length(expected_client_revision) BETWEEN 1 AND 19
    AND expected_client_revision NOT GLOB '*[^0-9]*' AND substr(expected_client_revision,1,1)<>'0'
    AND (length(expected_client_revision)<19 OR expected_client_revision<='9223372036854775807')),
  expected_authorization_generation TEXT NOT NULL CHECK(length(expected_authorization_generation) BETWEEN 1 AND 19
    AND expected_authorization_generation NOT GLOB '*[^0-9]*'
    AND (expected_authorization_generation='0' OR substr(expected_authorization_generation,1,1)<>'0')
    AND (length(expected_authorization_generation)<19 OR expected_authorization_generation<='9223372036854775806')),
  expected_current_organization_record_id TEXT,
  expected_current_organization_public_id TEXT CHECK(expected_current_organization_public_id IS NULL
    OR (length(expected_current_organization_public_id)=32 AND expected_current_organization_public_id NOT GLOB '*[^0-9a-f]*')),
  organization_record_id TEXT,
  organization_public_id TEXT CHECK(organization_public_id IS NULL
    OR (length(organization_public_id)=32 AND organization_public_id NOT GLOB '*[^0-9a-f]*')),
  expected_organization_revision TEXT CHECK(expected_organization_revision IS NULL OR
    (length(expected_organization_revision) BETWEEN 1 AND 19 AND expected_organization_revision NOT GLOB '*[^0-9]*'
      AND substr(expected_organization_revision,1,1)<>'0'
      AND (length(expected_organization_revision)<19 OR expected_organization_revision<='9223372036854775807'))),
  supersedes_terminal_command_id TEXT REFERENCES project_alpha_directory_relationship_outbox(command_id) ON DELETE RESTRICT,
  command_json TEXT NOT NULL CHECK(json_valid(command_json) AND json_type(command_json)='object'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','acknowledged','terminal')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts>=0),
  next_attempt_at INTEGER NOT NULL CHECK(typeof(next_attempt_at)='integer' AND next_attempt_at>=0),
  lease_token TEXT,
  lease_expires_at INTEGER,
  outcome_json TEXT CHECK(outcome_json IS NULL OR (json_valid(outcome_json) AND json_type(outcome_json)='object')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(client_record_id,relationship_version)
    REFERENCES operations_directory_client_organization_history(client_record_id,relationship_version) ON DELETE RESTRICT,
  UNIQUE(mutation_id,source_id,source_instance_id,application_id,history_epoch_id),
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((state IN ('acknowledged','terminal'))=(outcome_json IS NOT NULL)),
  CHECK((expected_current_organization_record_id IS NULL)=(expected_current_organization_public_id IS NULL)),
  CHECK((organization_record_id IS NULL)=(organization_public_id IS NULL)),
  CHECK((organization_record_id IS NULL)=(expected_organization_revision IS NULL)),
  CHECK((action='assign' AND expected_current_organization_record_id IS NULL AND organization_record_id IS NOT NULL)
    OR (action='remove' AND expected_current_organization_record_id IS NOT NULL AND organization_record_id IS NULL)
    OR (action='move' AND expected_current_organization_record_id IS NOT NULL AND organization_record_id IS NOT NULL
      AND expected_current_organization_record_id<>organization_record_id))
);
CREATE INDEX project_alpha_directory_relationship_outbox_ready
  ON project_alpha_directory_relationship_outbox(state,next_attempt_at,lease_expires_at,created_at);

CREATE VIEW project_alpha_directory_relationship_command_resources AS
SELECT command.command_id,command.client_record_id AS record_id,'client' AS record_kind,
  history.client_record_version AS record_version,command.client_public_id AS public_id,
  command.expected_client_revision AS expected_revision
FROM project_alpha_directory_relationship_outbox command
JOIN operations_directory_client_organization_history history
  ON history.client_record_id=command.client_record_id AND history.relationship_version=command.relationship_version
UNION ALL
SELECT command.command_id,command.expected_current_organization_record_id,'organization',
  history.previous_organization_record_version,command.expected_current_organization_public_id,NULL
FROM project_alpha_directory_relationship_outbox command
JOIN operations_directory_client_organization_history history
  ON history.client_record_id=command.client_record_id AND history.relationship_version=command.relationship_version
WHERE command.expected_current_organization_record_id IS NOT NULL
UNION ALL
SELECT command.command_id,command.organization_record_id,'organization',
  history.organization_record_version,command.organization_public_id,command.expected_organization_revision
FROM project_alpha_directory_relationship_outbox command
JOIN operations_directory_client_organization_history history
  ON history.client_record_id=command.client_record_id AND history.relationship_version=command.relationship_version
WHERE command.organization_record_id IS NOT NULL;

-- Every remote revision fact is normalized to one exact destination/local
-- record identity.  The live-command view below requires coherent response
-- identity and compares canonical decimal strings without lossy SQL casts.
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
JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
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

-- Current revision evidence may be a profile acknowledgement, a reviewed
-- acquired-binding refresh/activation, or an earlier acknowledged relationship
-- command.  The generation check additionally rejects any locally-known newer
-- destination generation, including one produced by an unrelated resource.
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
      AND json_extract(command.command_json,'$.organization.externalId')=command.organization_record_id
      AND json_extract(command.command_json,'$.organization.publicId')=command.organization_public_id
      AND json_extract(command.command_json,'$.organization.expectedRevision')=command.expected_organization_revision))
  AND NOT EXISTS (
    SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
    LEFT JOIN operations_directory_records record ON record.record_id=resource.record_id
    WHERE resource.command_id=command.command_id AND (
      record.record_id IS NULL OR record.record_kind<>resource.record_kind OR record.current_version<>resource.record_version
      OR NOT EXISTS(SELECT 1 FROM operations_directory_revisions revision
        WHERE revision.record_id=resource.record_id AND revision.version=resource.record_version)
      OR NOT EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
        WHERE enrollment.record_id=resource.record_id
          AND json_extract(destination.value,'$.sourceId')=command.source_id
          AND json_extract(destination.value,'$.sourceInstanceUUID')=command.source_instance_id
          AND json_extract(destination.value,'$.applicationUUID')=command.application_id
          AND json_extract(destination.value,'$.historyEpoch')=command.history_epoch_id
          AND json_extract(destination.value,'$.origin')=command.destination_origin
          AND json_extract(destination.value,'$.externalCanonicalId')=resource.record_id)
      OR NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
        WHERE mapping.source_id=command.source_id AND mapping.source_instance_id=command.source_instance_id
          AND mapping.application_id=command.application_id AND mapping.history_epoch_id=command.history_epoch_id
          AND mapping.resource_type=resource.record_kind AND mapping.external_id=resource.record_id
          AND mapping.project_alpha_public_id=resource.public_id)
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
    WHERE pending.source_id=command.source_id AND pending.expected_source_instance_id=command.source_instance_id
      AND pending.application_id=command.application_id AND pending.expected_history_epoch_id=command.history_epoch_id
      AND pending.resource_type=resource.record_kind AND pending.external_id=resource.record_id
      AND pending.state<>'acknowledged')
  -- Only the immediately preceding command at this destination orders the
  -- next reconciliation. A terminal predecessor is never silently skipped:
  -- the new independently-authorized command must name it explicitly.
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
  -- For every resource carrying an expected revision, the exact expected fact
  -- must exist and every exact identity/public-ID fact must be a coherent,
  -- bounded nonzero decimal no newer than that expectation.
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

CREATE TRIGGER project_alpha_directory_relationship_outbox_insert_guard
AFTER INSERT ON project_alpha_directory_relationship_outbox
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_live_relationship_commands live WHERE live.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'directory relationship command requires current exact authority and evidence'); END;

CREATE TRIGGER project_alpha_directory_relationship_outbox_identity_immutable
BEFORE UPDATE ON project_alpha_directory_relationship_outbox
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.mutation_id IS NOT OLD.mutation_id
  OR NEW.client_record_id IS NOT OLD.client_record_id OR NEW.relationship_version IS NOT OLD.relationship_version
  OR NEW.action IS NOT OLD.action OR NEW.source_id IS NOT OLD.source_id
  OR NEW.source_instance_id IS NOT OLD.source_instance_id OR NEW.application_id IS NOT OLD.application_id
  OR NEW.history_epoch_id IS NOT OLD.history_epoch_id OR NEW.destination_origin IS NOT OLD.destination_origin
  OR NEW.client_public_id IS NOT OLD.client_public_id OR NEW.expected_client_revision IS NOT OLD.expected_client_revision
  OR NEW.expected_authorization_generation IS NOT OLD.expected_authorization_generation
  OR NEW.expected_current_organization_record_id IS NOT OLD.expected_current_organization_record_id
  OR NEW.expected_current_organization_public_id IS NOT OLD.expected_current_organization_public_id
  OR NEW.organization_record_id IS NOT OLD.organization_record_id OR NEW.organization_public_id IS NOT OLD.organization_public_id
  OR NEW.expected_organization_revision IS NOT OLD.expected_organization_revision
  OR NEW.supersedes_terminal_command_id IS NOT OLD.supersedes_terminal_command_id
  OR NEW.command_json IS NOT OLD.command_json OR NEW.request_json IS NOT OLD.request_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'directory relationship command reservation is immutable'); END;

CREATE TRIGGER project_alpha_directory_relationship_outbox_transition_guard
BEFORE UPDATE ON project_alpha_directory_relationship_outbox
WHEN OLD.state IN ('acknowledged','terminal') OR NOT ((OLD.state='pending' AND NEW.state IN ('pending','leased'))
  OR (OLD.state='leased' AND NEW.state IN ('pending','leased','acknowledged','terminal'))
  )
BEGIN SELECT RAISE(ABORT,'directory relationship command transition is invalid'); END;

CREATE TRIGGER project_alpha_directory_relationship_outbox_no_delete
BEFORE DELETE ON project_alpha_directory_relationship_outbox
BEGIN SELECT RAISE(ABORT,'directory relationship commands are durable'); END;
