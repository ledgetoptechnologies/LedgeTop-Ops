PRAGMA foreign_keys = ON;

-- Append-only activation of one fully acquired existing Directory binding.
-- The 0111--0117 rows remain immutable and inactive; this receipt is the only
-- fact that makes an acquired mapping visible to later, explicitly composed
-- server-side consumers. It neither rewrites legacy mappings nor touches any
-- Delivery/public-link state.
CREATE TABLE project_alpha_existing_directory_binding_activation_receipts (
  activation_id TEXT NOT NULL PRIMARY KEY CHECK(length(activation_id)=36 AND activation_id=lower(activation_id)
    AND activation_id NOT GLOB '*[^0-9a-f-]*' AND substr(activation_id,9,1)='-'
    AND substr(activation_id,14,1)='-' AND substr(activation_id,15,1)='4'
    AND substr(activation_id,19,1)='-' AND substr(activation_id,20,1) IN ('8','9','a','b')
    AND substr(activation_id,24,1)='-' AND length(replace(activation_id,'-',''))=32),
  review_receipt_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_existing_directory_binding_review_evidence(receipt_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36 AND idempotency_key=lower(idempotency_key)
    AND idempotency_key NOT GLOB '*[^0-9a-f-]*' AND substr(idempotency_key,9,1)='-'
    AND substr(idempotency_key,14,1)='-' AND substr(idempotency_key,15,1)='4'
    AND substr(idempotency_key,19,1)='-' AND substr(idempotency_key,20,1) IN ('8','9','a','b')
    AND substr(idempotency_key,24,1)='-' AND length(replace(idempotency_key,'-',''))=32),
  acquired_receipt_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id) ON DELETE RESTRICT,
  native_owner_claim_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_acquired_native_owner_claims(claim_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL,
  project_alpha_revision TEXT NOT NULL,
  local_record_version INTEGER NOT NULL CHECK(typeof(local_record_version)='integer' AND local_record_version>=1),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256) AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  acquisition_evidence_sha256 TEXT NOT NULL CHECK(length(acquisition_evidence_sha256)=64 AND acquisition_evidence_sha256=lower(acquisition_evidence_sha256) AND acquisition_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  profile_evidence_sha256 TEXT NOT NULL CHECK(length(profile_evidence_sha256)=64 AND profile_evidence_sha256=lower(profile_evidence_sha256) AND profile_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  binding_status_evidence_sha256 TEXT NOT NULL CHECK(length(binding_status_evidence_sha256)=64 AND binding_status_evidence_sha256=lower(binding_status_evidence_sha256) AND binding_status_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  activated_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  directory_grant_generation INTEGER NOT NULL CHECK(typeof(directory_grant_generation)='integer' AND directory_grant_generation>=1),
  activated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(activated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',activated_at) IS activated_at),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,record_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,external_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id)
);

-- One statement must still see the exact, current chain. The reviewed binding
-- status digest is the acquired status digest and the acquisition response is
-- the acquired transport digest; independently observed profile evidence stays
-- distinct. Reviews are intentionally short-lived without mutating 0111 rows.
CREATE TRIGGER project_alpha_existing_directory_binding_activation_exact
BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM project_alpha_existing_directory_binding_review_evidence review
  JOIN project_alpha_existing_directory_binding_acquisition_commands command
    ON command.review_receipt_id=review.receipt_id
  JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response
    ON response.command_id=command.command_id
  JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired
    ON acquired.command_id=command.command_id
  JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=acquired.receipt_id
  JOIN project_alpha_acquired_native_owner_claims claim ON claim.receipt_id=mapping.receipt_id
  JOIN project_alpha_acquired_mapping_activation dormant ON dormant.receipt_id=mapping.receipt_id AND dormant.state='inactive'
  JOIN operations_directory_records record ON record.record_id=review.record_id
  WHERE (review.receipt_id,acquired.receipt_id,claim.claim_id)=
      (NEW.review_receipt_id,NEW.acquired_receipt_id,NEW.native_owner_claim_id)
    AND (NEW.record_id,NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,
      NEW.resource_type,NEW.external_id,NEW.project_alpha_public_id,NEW.project_alpha_revision,
      NEW.local_record_version,NEW.request_sha256)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,review.history_epoch_id,
      review.resource_type,review.external_id,review.project_alpha_public_id,review.project_alpha_revision,
      review.reviewed_local_record_version,review.request_sha256)
    AND (NEW.acquisition_evidence_sha256,NEW.profile_evidence_sha256,NEW.binding_status_evidence_sha256)=
      (acquired.acquisition_evidence_sha256,acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
    AND review.reviewed_binding_evidence_sha256=acquired.binding_status_evidence_sha256
    AND response.response_sha256=acquired.acquisition_evidence_sha256
    AND (command.request_sha256,acquired.request_sha256,claim.request_sha256)=
      (review.request_sha256,review.request_sha256,review.request_sha256)
    AND claim.actor_id=review.reviewer_staff_id
    AND (response.source_instance_id,response.application_id,response.history_epoch_id,response.resource_type,
      response.external_id,response.project_alpha_public_id,response.project_alpha_revision)=
      (review.source_instance_id,review.application_id,review.history_epoch_id,review.resource_type,
      review.external_id,review.project_alpha_public_id,review.project_alpha_revision)
    AND (mapping.record_id,mapping.source_id,mapping.source_instance_id,mapping.application_id,
      mapping.history_epoch_id,mapping.resource_type,mapping.external_id,mapping.project_alpha_public_id)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,
      review.history_epoch_id,review.resource_type,review.external_id,review.project_alpha_public_id)
    AND mapping.activation_state='inactive' AND mapping.native_owner_epoch_id IS NULL
    AND (claim.record_id,claim.source_id,claim.source_instance_id,claim.application_id,claim.history_epoch_id,
      claim.resource_type,claim.external_id,claim.project_alpha_public_id)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,review.history_epoch_id,
      review.resource_type,review.external_id,review.project_alpha_public_id)
    AND claim.expected_local_record_version=review.reviewed_local_record_version
    AND record.record_kind=review.resource_type AND record.current_version=review.reviewed_local_record_version
    AND review.reviewed_local_record_version IS NOT NULL
    AND review.reviewed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND review.reviewed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours')
    AND NEW.activated_by_staff_id=review.reviewer_staff_id
    AND EXISTS (SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_events event
      WHERE event.command_id=command.command_id AND event.state='acknowledged'
        AND event.request_sha256=review.request_sha256)
)
BEGIN SELECT RAISE(ABORT,'existing directory binding activation requires current exact authority and evidence'); END;

CREATE TRIGGER project_alpha_existing_directory_binding_activation_authority
BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_existing_directory_binding_review_evidence review
  JOIN native_staff_admissions admission ON admission.staff_id=review.reviewer_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE review.receipt_id=NEW.review_receipt_id AND NEW.activated_by_staff_id=review.reviewer_staff_id
    AND NEW.directory_grant_generation=generation.generation
    AND admission.active=1 AND admission.bound_access_subject=review.reviewer_access_subject
    AND admission.version=review.reviewer_admission_version AND profile.version=review.reviewer_profile_version
    AND EXISTS (SELECT 1 FROM staff_role_assignments owner_assignment
      WHERE owner_assignment.staff_id=review.reviewer_staff_id AND owner_assignment.role_id='role-owner'
        AND owner_assignment.scope='global')
    AND EXISTS (SELECT 1 FROM native_directory_grants allow_row
      WHERE allow_row.staff_id=review.reviewer_staff_id AND allow_row.permission='directory.identity.link'
        AND allow_row.effect='allow' AND allow_row.active=1
        AND (allow_row.scope_kind='global' OR (allow_row.scope_kind='resource' AND allow_row.resource_id=review.record_id)
          OR (allow_row.scope_kind='assigned' AND EXISTS (SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=review.record_id AND assignment.staff_id=review.reviewer_staff_id AND assignment.active=1))
          OR (allow_row.scope_kind='business_area' AND EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=review.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
          OR (allow_row.scope_kind='division' AND EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=review.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
    AND NOT EXISTS (SELECT 1 FROM native_directory_grants deny
      WHERE deny.staff_id=review.reviewer_staff_id AND deny.permission='directory.identity.link'
        AND deny.effect='deny' AND deny.active=1
        AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=review.record_id)
          OR (deny.scope_kind='assigned' AND EXISTS (SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=review.record_id AND assignment.staff_id=review.reviewer_staff_id AND assignment.active=1))
          OR (deny.scope_kind='business_area' AND EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=review.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
          OR (deny.scope_kind='division' AND EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=review.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
)
BEGIN SELECT RAISE(ABORT,'existing directory binding activation requires current native authority'); END;

CREATE TRIGGER project_alpha_existing_directory_binding_activation_relationship
BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_existing_directory_binding_review_evidence review
  WHERE review.receipt_id=NEW.review_receipt_id AND (
    EXISTS (SELECT 1 FROM project_alpha_directory_mappings legacy
      WHERE legacy.source_id=review.source_id AND legacy.source_instance_id=review.source_instance_id
        AND legacy.application_id=review.application_id AND legacy.resource_type=review.resource_type
        AND (legacy.external_id=review.external_id OR legacy.project_alpha_public_id=review.project_alpha_public_id))
    OR (review.resource_type='client' AND NOT EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=review.record_id
        AND (relationship.organization_record_id IS NULL OR EXISTS (
          SELECT 1 FROM project_alpha_directory_mappings parent
          JOIN operations_directory_records parent_record ON parent_record.record_id=parent.external_id AND parent_record.record_kind='organization'
          WHERE parent.source_id=review.source_id AND parent.source_instance_id=review.source_instance_id
            AND parent.application_id=review.application_id AND parent.history_epoch_id=review.history_epoch_id
            AND parent.resource_type='organization' AND parent.external_id=relationship.organization_record_id)
        OR EXISTS (SELECT 1 FROM project_alpha_existing_directory_binding_activation_receipts parent
          WHERE parent.source_id=review.source_id AND parent.source_instance_id=review.source_instance_id
            AND parent.application_id=review.application_id AND parent.history_epoch_id=review.history_epoch_id
            AND parent.resource_type='organization' AND parent.record_id=relationship.organization_record_id))))
  ))
BEGIN SELECT RAISE(ABORT,'existing directory binding activation conflicts with mapping or relationship'); END;

CREATE TRIGGER project_alpha_existing_directory_binding_activation_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_activation_receipts
BEGIN SELECT RAISE(ABORT,'existing directory binding activation receipt is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_activation_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_activation_receipts
BEGIN SELECT RAISE(ABORT,'existing directory binding activation receipt is durable'); END;

-- Legacy rows retain their bytes and behavior. Consumers that are explicitly
-- migrated to this view can additionally see only fully activated acquisitions.
CREATE VIEW project_alpha_active_directory_mappings AS
SELECT source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,
  history_epoch_id,command_id AS provenance_id,'legacy' AS mapping_kind,created_at
FROM project_alpha_directory_mappings
UNION ALL
SELECT source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,
  history_epoch_id,activation_id AS provenance_id,'acquired' AS mapping_kind,activated_at AS created_at
FROM project_alpha_existing_directory_binding_activation_receipts;
