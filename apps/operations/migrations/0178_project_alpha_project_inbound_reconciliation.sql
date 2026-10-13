PRAGMA foreign_keys = ON;

-- A PA-origin edit is evidence until an authenticated reviewer resolves it.
-- Proposals and resolutions never issue a PA command, replace a mapping, or
-- touch Delivery/public-link/financial tables.
CREATE TABLE project_alpha_project_inbound_proposals (
  proposal_id TEXT NOT NULL PRIMARY KEY CHECK(length(proposal_id)=36),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
  request_sha256 TEXT NOT NULL UNIQUE CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32),
  expected_local_version INTEGER NOT NULL CHECK(expected_local_version>=1),
  expected_local_projection_sha256 TEXT NOT NULL CHECK(length(expected_local_projection_sha256)=64),
  observed_request_id TEXT NOT NULL CHECK(length(observed_request_id)=36),
  observed_authorization_generation TEXT NOT NULL,
  observed_remote_revision TEXT NOT NULL,
  observed_remote_projection_sha256 TEXT NOT NULL CHECK(length(observed_remote_projection_sha256)=64),
  local_snapshot_json TEXT NOT NULL CHECK(json_valid(local_snapshot_json) AND json(local_snapshot_json)=local_snapshot_json),
  remote_snapshot_json TEXT NOT NULL CHECK(json_valid(remote_snapshot_json)),
  remote_snapshot_sha256 TEXT NOT NULL CHECK(length(remote_snapshot_sha256)=64),
  target_organization_record_id TEXT,
  target_client_record_id TEXT,
  reviewer_staff_id TEXT NOT NULL,
  reviewer_access_subject TEXT NOT NULL,
  reviewer_admission_version INTEGER NOT NULL CHECK(reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(reviewer_profile_version>=1),
  project_grant_generation INTEGER NOT NULL CHECK(project_grant_generation>=1),
  normalized_scopes_json TEXT NOT NULL CHECK(json_valid(normalized_scopes_json) AND json_type(normalized_scopes_json)='array'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24)
);
CREATE TRIGGER project_alpha_project_inbound_proposals_scope_shape
BEFORE INSERT ON project_alpha_project_inbound_proposals
WHEN json_type(NEW.normalized_scopes_json) IS NOT 'array'
  OR json_array_length(NEW.normalized_scopes_json)>128
  OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
    WHERE json_type(scope.value) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(scope.value))<>3
      OR EXISTS (SELECT 1 FROM json_each(scope.value) member
        WHERE member.key NOT IN ('scopeKind','businessAreaId','divisionId'))
      OR json_type(scope.value,'$.scopeKind') IS NOT 'text'
      OR json_extract(scope.value,'$.scopeKind') NOT IN ('business_area','division')
      OR json_type(scope.value,'$.businessAreaId') IS NOT 'text'
      OR length(trim(json_extract(scope.value,'$.businessAreaId'))) NOT BETWEEN 1 AND 191
      OR (json_extract(scope.value,'$.scopeKind')='business_area'
        AND json_type(scope.value,'$.divisionId') IS NOT 'null')
      OR (json_extract(scope.value,'$.scopeKind')='division'
        AND (json_type(scope.value,'$.divisionId') IS NOT 'text'
          OR length(trim(json_extract(scope.value,'$.divisionId'))) NOT BETWEEN 1 AND 191)))
  OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) first_scope
    JOIN json_each(NEW.normalized_scopes_json) second_scope ON CAST(second_scope.key AS INTEGER)>CAST(first_scope.key AS INTEGER)
    WHERE json_extract(first_scope.value,'$.scopeKind')=json_extract(second_scope.value,'$.scopeKind')
      AND json_extract(first_scope.value,'$.businessAreaId')=json_extract(second_scope.value,'$.businessAreaId')
      AND json_extract(first_scope.value,'$.divisionId') IS json_extract(second_scope.value,'$.divisionId'))
BEGIN SELECT RAISE(ABORT,'project inbound scopes are malformed'); END;
CREATE TRIGGER project_alpha_project_inbound_proposals_no_update BEFORE UPDATE ON project_alpha_project_inbound_proposals
BEGIN SELECT RAISE(ABORT,'project inbound proposal is immutable'); END;
CREATE TRIGGER project_alpha_project_inbound_proposals_no_delete BEFORE DELETE ON project_alpha_project_inbound_proposals
BEGIN SELECT RAISE(ABORT,'project inbound proposal is durable'); END;

-- This short-lived authorization is inserted in the same D1 batch as the
-- optional canonical update and immutable resolution receipt. A failed guard
-- therefore rolls the authorization back as well.
CREATE TABLE project_alpha_project_inbound_resolution_authorizations (
  resolution_id TEXT NOT NULL PRIMARY KEY CHECK(length(resolution_id)=36),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_inbound_proposals(proposal_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
  request_sha256 TEXT NOT NULL UNIQUE CHECK(length(request_sha256)=64),
  decision TEXT NOT NULL CHECK(decision IN ('accept_project_alpha','keep_operations','requires_follow_up')),
  final_remote_snapshot_json TEXT NOT NULL CHECK(json_valid(final_remote_snapshot_json)),
  final_remote_snapshot_sha256 TEXT NOT NULL CHECK(length(final_remote_snapshot_sha256)=64),
  final_remote_revision TEXT NOT NULL,
  final_remote_projection_sha256 TEXT NOT NULL CHECK(length(final_remote_projection_sha256)=64),
  final_authorization_generation TEXT NOT NULL,
  target_organization_record_id TEXT,
  target_client_record_id TEXT,
  reviewer_staff_id TEXT NOT NULL,
  reviewer_access_subject TEXT NOT NULL,
  reviewer_admission_version INTEGER NOT NULL CHECK(reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(reviewer_profile_version>=1),
  project_grant_generation INTEGER NOT NULL CHECK(project_grant_generation>=1),
  normalized_scopes_json TEXT NOT NULL CHECK(json_valid(normalized_scopes_json) AND json_type(normalized_scopes_json)='array'),
  authorized_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_scope_shape
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN json_type(NEW.normalized_scopes_json) IS NOT 'array'
  OR json_array_length(NEW.normalized_scopes_json)>128
  OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
    WHERE json_type(scope.value) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(scope.value))<>3
      OR EXISTS (SELECT 1 FROM json_each(scope.value) member
        WHERE member.key NOT IN ('scopeKind','businessAreaId','divisionId'))
      OR json_type(scope.value,'$.scopeKind') IS NOT 'text'
      OR json_extract(scope.value,'$.scopeKind') NOT IN ('business_area','division')
      OR json_type(scope.value,'$.businessAreaId') IS NOT 'text'
      OR length(trim(json_extract(scope.value,'$.businessAreaId'))) NOT BETWEEN 1 AND 191
      OR (json_extract(scope.value,'$.scopeKind')='business_area'
        AND json_type(scope.value,'$.divisionId') IS NOT 'null')
      OR (json_extract(scope.value,'$.scopeKind')='division'
        AND (json_type(scope.value,'$.divisionId') IS NOT 'text'
          OR length(trim(json_extract(scope.value,'$.divisionId'))) NOT BETWEEN 1 AND 191)))
  OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) first_scope
    JOIN json_each(NEW.normalized_scopes_json) second_scope ON CAST(second_scope.key AS INTEGER)>CAST(first_scope.key AS INTEGER)
    WHERE json_extract(first_scope.value,'$.scopeKind')=json_extract(second_scope.value,'$.scopeKind')
      AND json_extract(first_scope.value,'$.businessAreaId')=json_extract(second_scope.value,'$.businessAreaId')
      AND json_extract(first_scope.value,'$.divisionId') IS json_extract(second_scope.value,'$.divisionId'))
BEGIN SELECT RAISE(ABORT,'project inbound scopes are malformed'); END;
-- Keep each invariant group in its own trigger. D1/SQLite evaluates a single
-- trigger WHEN clause as one expression tree; combining every authorization,
-- snapshot, mapping, and directory predicate exceeds D1's depth limit. Every
-- trigger is fail-closed and the authorization insert must pass all of them.
CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_proposal_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_proposals proposal
  WHERE proposal.proposal_id=NEW.proposal_id AND proposal.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND proposal.reviewer_staff_id=NEW.reviewer_staff_id
    AND proposal.reviewer_access_subject=NEW.reviewer_access_subject
    AND proposal.reviewer_admission_version=NEW.reviewer_admission_version
    AND proposal.reviewer_profile_version=NEW.reviewer_profile_version
    AND proposal.project_grant_generation=NEW.project_grant_generation
    AND json(proposal.normalized_scopes_json)=json(NEW.normalized_scopes_json)
    AND NEW.final_remote_revision=proposal.observed_remote_revision
    AND NEW.final_remote_projection_sha256=proposal.observed_remote_projection_sha256
    AND NEW.final_authorization_generation=proposal.observed_authorization_generation
    AND NEW.final_remote_snapshot_sha256=proposal.remote_snapshot_sha256
    AND json(NEW.final_remote_snapshot_json)=json(proposal.remote_snapshot_json)
    AND NEW.target_organization_record_id IS proposal.target_organization_record_id
    AND NEW.target_client_record_id IS proposal.target_client_record_id
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution evidence is stale'); END;

CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_authority_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_proposals proposal
  JOIN native_staff_admissions admission ON admission.staff_id=proposal.reviewer_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE proposal.proposal_id=NEW.proposal_id
    AND admission.active=1 AND admission.bound_access_subject=NEW.reviewer_access_subject
    AND admission.version=NEW.reviewer_admission_version AND profile.version=NEW.reviewer_profile_version
    AND generation.generation=NEW.project_grant_generation
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution evidence is stale'); END;

CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_remote_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_proposals proposal
  JOIN project_alpha_api_v2_project_observations_current observation
    ON observation.source_id=proposal.source_id AND observation.source_instance_id=proposal.source_instance_id
    AND observation.application_id=proposal.application_id AND observation.history_epoch_id=proposal.history_epoch_id
    AND observation.external_project_id=proposal.external_project_id
    AND observation.project_alpha_public_id=proposal.project_alpha_public_id
  JOIN project_alpha_api_v2_inventory_receipts inventory
    ON inventory.source_id=observation.source_id AND inventory.source_instance_id=observation.source_instance_id
    AND inventory.application_id=observation.application_id AND inventory.history_epoch_id=observation.history_epoch_id
    AND inventory.inventory_kind='project' AND inventory.request_id=observation.request_id
  WHERE proposal.proposal_id=NEW.proposal_id
    AND observation.has_conflict=0 AND observation.request_id=proposal.observed_request_id
    AND observation.resource_revision=proposal.observed_remote_revision
    AND observation.projection_sha256=proposal.observed_remote_projection_sha256
    AND inventory.authorization_generation=proposal.observed_authorization_generation
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution evidence is stale'); END;

CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_project_mapping_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_proposals proposal
  JOIN operations_shared_projects project ON project.external_project_id=proposal.external_project_id
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=proposal.external_project_id
  WHERE proposal.proposal_id=NEW.proposal_id
    AND project.current_version=proposal.expected_local_version
    AND project.canonical_projection_sha256=proposal.expected_local_projection_sha256
    AND project.source_id=proposal.source_id AND project.source_instance_id=proposal.source_instance_id
    AND project.application_id=proposal.application_id AND project.history_epoch_id=proposal.history_epoch_id
    AND project.project_alpha_public_id=proposal.project_alpha_public_id
    AND mapping.source_id=proposal.source_id AND mapping.source_instance_id=proposal.source_instance_id
    AND mapping.application_id=proposal.application_id AND mapping.history_epoch_id=proposal.history_epoch_id
    AND mapping.project_alpha_public_id=proposal.project_alpha_public_id
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution evidence is stale'); END;

CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_directory_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_proposals proposal
  WHERE proposal.proposal_id=NEW.proposal_id
    AND ((NEW.target_organization_record_id IS NULL
        AND json_type(NEW.final_remote_snapshot_json,'$.data.organizationPublicId')='null') OR EXISTS (
      SELECT 1 FROM project_alpha_active_directory_mappings directory
      JOIN operations_directory_records record ON record.record_id=directory.record_id AND record.record_kind='organization'
      WHERE directory.source_id=proposal.source_id AND directory.source_instance_id=proposal.source_instance_id
        AND directory.application_id=proposal.application_id AND directory.history_epoch_id=proposal.history_epoch_id
        AND directory.resource_type='organization' AND directory.record_id=NEW.target_organization_record_id
        AND directory.project_alpha_public_id=json_extract(NEW.final_remote_snapshot_json,'$.data.organizationPublicId')))
    AND ((NEW.target_client_record_id IS NULL
        AND json_type(NEW.final_remote_snapshot_json,'$.data.clientPublicId')='null') OR EXISTS (
      SELECT 1 FROM project_alpha_active_directory_mappings directory
      JOIN operations_directory_records record ON record.record_id=directory.record_id AND record.record_kind='client'
      WHERE directory.source_id=proposal.source_id AND directory.source_instance_id=proposal.source_instance_id
        AND directory.application_id=proposal.application_id AND directory.history_epoch_id=proposal.history_epoch_id
        AND directory.resource_type='client' AND directory.record_id=NEW.target_client_record_id
        AND directory.project_alpha_public_id=json_extract(NEW.final_remote_snapshot_json,'$.data.clientPublicId')))
    AND (NEW.target_organization_record_id IS NULL OR NEW.target_client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.organization_record_id=NEW.target_organization_record_id
        AND relationship.client_record_id=NEW.target_client_record_id))
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution evidence is stale'); END;

CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_allow_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_proposals proposal
  WHERE proposal.proposal_id=NEW.proposal_id
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
      WHERE NOT EXISTS (SELECT 1 FROM native_project_grants allowed
        WHERE allowed.staff_id=NEW.reviewer_staff_id AND allowed.capability='project.shared.sync'
          AND allowed.effect='allow' AND allowed.active=1
          AND (allowed.scope_kind='global'
            OR allowed.scope_kind='exact_project' AND allowed.external_project_id=proposal.external_project_id
            OR allowed.scope_kind='business_area' AND allowed.business_area_id=json_extract(scope.value,'$.businessAreaId')
            OR allowed.scope_kind='division' AND allowed.business_area_id=json_extract(scope.value,'$.businessAreaId')
              AND allowed.division_id=json_extract(scope.value,'$.divisionId'))))
    AND (json_array_length(NEW.normalized_scopes_json)>0 OR EXISTS (
      SELECT 1 FROM native_project_grants allowed
      WHERE allowed.staff_id=NEW.reviewer_staff_id AND allowed.capability='project.shared.sync'
        AND allowed.effect='allow' AND allowed.active=1
        AND (allowed.scope_kind='global'
          OR allowed.scope_kind='exact_project' AND allowed.external_project_id=proposal.external_project_id)))
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution evidence is stale'); END;

CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_deny_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_proposals proposal
  WHERE proposal.proposal_id=NEW.proposal_id
    AND NOT EXISTS (SELECT 1 FROM native_project_grants denied
      WHERE denied.staff_id=NEW.reviewer_staff_id AND denied.capability='project.shared.sync'
        AND denied.effect='deny' AND denied.active=1
        AND (denied.scope_kind='global'
          OR denied.scope_kind='exact_project' AND denied.external_project_id=proposal.external_project_id
          OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
            WHERE denied.scope_kind='business_area' AND denied.business_area_id=json_extract(scope.value,'$.businessAreaId')
              OR denied.scope_kind='division' AND denied.business_area_id=json_extract(scope.value,'$.businessAreaId')
                AND denied.division_id=json_extract(scope.value,'$.divisionId'))))
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution evidence is stale'); END;
CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_no_update BEFORE UPDATE ON project_alpha_project_inbound_resolution_authorizations
BEGIN SELECT RAISE(ABORT,'project inbound resolution authorization is immutable'); END;
CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_no_delete BEFORE DELETE ON project_alpha_project_inbound_resolution_authorizations
BEGIN SELECT RAISE(ABORT,'project inbound resolution authorization is durable'); END;

ALTER TABLE operations_shared_project_revisions ADD COLUMN inbound_resolution_id TEXT
  REFERENCES project_alpha_project_inbound_resolution_authorizations(resolution_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX operations_shared_project_revisions_inbound_resolution
  ON operations_shared_project_revisions(inbound_resolution_id) WHERE inbound_resolution_id IS NOT NULL;

-- Preserve the complete outgoing-settlement branch from 0171 and add one
-- disjoint inbound branch. The inbound branch cannot create an outbox row or
-- mutate the immutable one-to-one mapping.
DROP TRIGGER operations_shared_projects_no_update;
CREATE TRIGGER operations_shared_projects_no_update BEFORE UPDATE ON operations_shared_projects
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN native_project_live_command_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=intent.external_project_id
  WHERE OLD.external_project_id=intent.external_project_id AND OLD.current_version=intent.expected_local_version
    AND OLD.canonical_projection_sha256=intent.expected_local_projection_sha256
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND mapping.source_id=intent.source_id AND mapping.source_instance_id=intent.source_instance_id
    AND mapping.application_id=intent.application_id AND mapping.history_epoch_id=intent.history_epoch_id
    AND ((intent.operation='update' AND mapping.project_alpha_public_id=intent.expected_project_alpha_public_id)
      OR intent.operation IN ('create','bind'))
    AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
    AND NEW.source_id=settlement.source_id AND NEW.source_instance_id=settlement.source_instance_id
    AND NEW.application_id=settlement.application_id AND NEW.history_epoch_id=settlement.history_epoch_id
    AND NEW.project_alpha_public_id=settlement.project_alpha_public_id AND NEW.pa_revision=settlement.project_alpha_revision
    AND NEW.current_version=OLD.current_version+1 AND NEW.canonical_projection_sha256=settlement.projection_sha256
    AND NEW.name=json_extract(settlement.read_json,'$.data.name')
    AND NEW.description IS json_extract(settlement.read_json,'$.data.description')
    AND NEW.lifecycle=json_extract(settlement.read_json,'$.data.status')
    AND NEW.archived=(json_extract(settlement.read_json,'$.data.archived') IS 1)
    AND NEW.overdue_warning=(json_extract(settlement.read_json,'$.data.overdueWarning') IS 1)
    AND NEW.completed_at IS json_extract(settlement.read_json,'$.data.completedAt')
    AND NEW.archived_at IS json_extract(settlement.read_json,'$.data.archivedAt')
    AND NEW.planned_start IS json_extract(settlement.read_json,'$.data.estimatedStart')
    AND NEW.planned_end IS json_extract(settlement.read_json,'$.data.estimatedEnd')
    AND json(NEW.scopes_json)=json(proof.scopes_json)
    AND ((json_type(settlement.read_json,'$.data.organizationPublicId')='null' AND NEW.organization_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.record_id AND r.record_kind='organization'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='organization' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
          AND d.record_id=NEW.organization_record_id))
    AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.record_id AND r.record_kind='client'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='client' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.clientPublicId')
          AND d.record_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
) AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_resolution_authorizations authorization
  JOIN project_alpha_project_inbound_proposals proposal ON proposal.proposal_id=authorization.proposal_id
  WHERE authorization.decision='accept_project_alpha' AND proposal.external_project_id=OLD.external_project_id
    AND OLD.current_version=proposal.expected_local_version
    AND OLD.canonical_projection_sha256=proposal.expected_local_projection_sha256
    AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
    AND NEW.source_id IS OLD.source_id AND NEW.source_instance_id IS OLD.source_instance_id
    AND NEW.application_id IS OLD.application_id AND NEW.history_epoch_id IS OLD.history_epoch_id
    AND NEW.project_alpha_public_id IS OLD.project_alpha_public_id
    AND NEW.current_version=OLD.current_version+1
    AND NEW.pa_revision=authorization.final_remote_revision
    AND NEW.canonical_projection_sha256=authorization.final_remote_projection_sha256
    AND NEW.name=json_extract(authorization.final_remote_snapshot_json,'$.data.name')
    AND NEW.description IS json_extract(authorization.final_remote_snapshot_json,'$.data.description')
    AND NEW.lifecycle=json_extract(authorization.final_remote_snapshot_json,'$.data.status')
    AND NEW.archived=(json_extract(authorization.final_remote_snapshot_json,'$.data.archived') IS 1)
    AND NEW.overdue_warning=(json_extract(authorization.final_remote_snapshot_json,'$.data.overdueWarning') IS 1)
    AND NEW.completed_at IS json_extract(authorization.final_remote_snapshot_json,'$.data.completedAt')
    AND NEW.archived_at IS json_extract(authorization.final_remote_snapshot_json,'$.data.archivedAt')
    AND NEW.planned_start IS json_extract(authorization.final_remote_snapshot_json,'$.data.estimatedStart')
    AND NEW.planned_end IS json_extract(authorization.final_remote_snapshot_json,'$.data.estimatedEnd')
    AND NEW.organization_record_id IS authorization.target_organization_record_id
    AND NEW.client_record_id IS authorization.target_client_record_id
    AND json(NEW.scopes_json)=json(authorization.normalized_scopes_json)
)
BEGIN SELECT RAISE(ABORT,'shared project update requires a versioned writer'); END;

CREATE TRIGGER operations_shared_project_revisions_inbound_guard BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.inbound_resolution_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_resolution_authorizations authorization
  JOIN project_alpha_project_inbound_proposals proposal ON proposal.proposal_id=authorization.proposal_id
  JOIN operations_shared_projects project ON project.external_project_id=proposal.external_project_id
  WHERE authorization.resolution_id=NEW.inbound_resolution_id AND authorization.decision='accept_project_alpha'
    AND NEW.external_project_id=proposal.external_project_id
    AND NEW.version=proposal.expected_local_version+1 AND NEW.version=project.current_version
    AND NEW.pa_revision IS NULL AND NEW.refresh_command_id IS NULL AND NEW.v2_settlement_id IS NULL
    AND json(NEW.read_json)=json(authorization.final_remote_snapshot_json)
    AND project.pa_revision=authorization.final_remote_revision
    AND project.canonical_projection_sha256=authorization.final_remote_projection_sha256
)
BEGIN SELECT RAISE(ABORT,'project inbound revision is not authorized'); END;

CREATE TABLE project_alpha_project_inbound_resolution_receipts (
  resolution_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_project_inbound_resolution_authorizations(resolution_id) ON DELETE RESTRICT,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_inbound_proposals(proposal_id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('accept_project_alpha','keep_operations','requires_follow_up')),
  prior_local_version INTEGER NOT NULL,
  resulting_local_version INTEGER NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_project_inbound_resolution_receipts_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_resolution_authorizations authorization
  JOIN project_alpha_project_inbound_proposals proposal ON proposal.proposal_id=authorization.proposal_id
  JOIN operations_shared_projects project ON project.external_project_id=proposal.external_project_id
  WHERE authorization.resolution_id=NEW.resolution_id AND authorization.proposal_id=NEW.proposal_id
    AND authorization.decision=NEW.decision AND NEW.prior_local_version=proposal.expected_local_version
    AND NEW.resulting_local_version=CASE WHEN NEW.decision='accept_project_alpha'
      THEN proposal.expected_local_version+1 ELSE proposal.expected_local_version END
    AND project.current_version=NEW.resulting_local_version
    AND (NEW.decision<>'accept_project_alpha' OR EXISTS (
      SELECT 1 FROM operations_shared_project_revisions revision
      WHERE revision.external_project_id=proposal.external_project_id
        AND revision.version=NEW.resulting_local_version
        AND revision.inbound_resolution_id=NEW.resolution_id))
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution receipt is not exact'); END;
CREATE TRIGGER project_alpha_project_inbound_resolution_receipts_no_update BEFORE UPDATE ON project_alpha_project_inbound_resolution_receipts
BEGIN SELECT RAISE(ABORT,'project inbound resolution receipt is immutable'); END;
CREATE TRIGGER project_alpha_project_inbound_resolution_receipts_no_delete BEFORE DELETE ON project_alpha_project_inbound_resolution_receipts
BEGIN SELECT RAISE(ABORT,'project inbound resolution receipt is durable'); END;
