PRAGMA foreign_keys = ON;

-- Forward-only, read-proven adoption evidence for an already-bound PA
-- Directory record.  This is deliberately separate from 0112--0117: those
-- tables prove a PA mutation response, while this path proves only fresh GET
-- observations.  Neither table below is consulted by mapping, portal,
-- Delivery, or public-link readers.
CREATE TABLE project_alpha_directory_read_adoption_reviews (
  review_id TEXT NOT NULL PRIMARY KEY CHECK(length(review_id)=36 AND review_id=lower(review_id)
    AND review_id NOT GLOB '*[^0-9a-f-]*' AND substr(review_id,9,1)='-' AND substr(review_id,14,1)='-'
    AND substr(review_id,15,1)='4' AND substr(review_id,19,1)='-' AND substr(review_id,20,1) IN ('8','9','a','b')
    AND substr(review_id,24,1)='-' AND length(replace(review_id,'-',''))=32),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36 AND idempotency_key=lower(idempotency_key)
    AND idempotency_key NOT GLOB '*[^0-9a-f-]*' AND substr(idempotency_key,9,1)='-' AND substr(idempotency_key,14,1)='-'
    AND substr(idempotency_key,15,1)='4' AND substr(idempotency_key,19,1)='-' AND substr(idempotency_key,20,1) IN ('8','9','a','b')
    AND substr(idempotency_key,24,1)='-' AND length(replace(idempotency_key,'-',''))=32),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  expected_local_record_version INTEGER NOT NULL CHECK(typeof(expected_local_record_version)='integer' AND expected_local_record_version>=1),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=78),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 191 AND length(CAST(external_id AS BLOB))<=764
    AND instr(external_id,char(0))=0),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32
    AND project_alpha_public_id=lower(project_alpha_public_id) AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(project_alpha_revision GLOB '[1-9]*'
    AND project_alpha_revision NOT GLOB '*[^0-9]*' AND length(project_alpha_revision)<=19
    AND (length(project_alpha_revision)<19 OR project_alpha_revision<='9223372036854775807')),
  authorization_generation TEXT NOT NULL CHECK(authorization_generation GLOB '[0-9]*'
    AND authorization_generation NOT GLOB '*[^0-9]*'
    AND (authorization_generation='0' OR substr(authorization_generation,1,1)<>'0')
    AND length(authorization_generation)<=19
    AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775807')),
  inventory_request_id TEXT NOT NULL CHECK(length(inventory_request_id)=36),
  inventory_page_sha256 TEXT NOT NULL CHECK(length(inventory_page_sha256)=64
    AND inventory_page_sha256=lower(inventory_page_sha256) AND inventory_page_sha256 NOT GLOB '*[^0-9a-f]*'),
  profile_request_id TEXT NOT NULL CHECK(length(profile_request_id)=36),
  profile_evidence_sha256 TEXT NOT NULL CHECK(length(profile_evidence_sha256)=64
    AND profile_evidence_sha256=lower(profile_evidence_sha256) AND profile_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  binding_request_id TEXT NOT NULL CHECK(length(binding_request_id)=36),
  binding_evidence_sha256 TEXT NOT NULL CHECK(length(binding_evidence_sha256)=64
    AND binding_evidence_sha256=lower(binding_evidence_sha256) AND binding_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  reviewer_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  reviewer_access_subject TEXT NOT NULL CHECK(length(trim(reviewer_access_subject)) BETWEEN 1 AND 191),
  reviewer_admission_version INTEGER NOT NULL CHECK(typeof(reviewer_admission_version)='integer' AND reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(typeof(reviewer_profile_version)='integer' AND reviewer_profile_version>=1),
  reviewed_at TEXT NOT NULL CHECK(length(reviewed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at)=reviewed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,record_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,external_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id)
);

-- Recheck the exact selected local record, current immutable inventory
-- observation, current actor identity, and deny-aware native identity-link
-- authority at the write boundary.  An old or conflicting observation cannot
-- become a claim merely because a browser repeats its identifiers.
CREATE TRIGGER project_alpha_directory_read_adoption_reviews_current
BEFORE INSERT ON project_alpha_directory_read_adoption_reviews
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_records record
    WHERE record.record_id=NEW.record_id AND record.record_kind=NEW.resource_type
      AND record.current_version=NEW.expected_local_record_version)
 OR NOT EXISTS(SELECT 1
    FROM project_alpha_api_v2_directory_observations_current observation
    JOIN project_alpha_api_v2_inventory_receipts receipt
      ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
     AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
     AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
    WHERE observation.source_id=NEW.source_id AND observation.source_instance_id=NEW.source_instance_id
      AND observation.application_id=NEW.application_id AND observation.history_epoch_id=NEW.history_epoch_id
      AND observation.resource_type=NEW.resource_type
      AND observation.project_alpha_public_id=NEW.project_alpha_public_id
      AND observation.resource_revision=NEW.project_alpha_revision
      AND observation.present=1 AND observation.last_action='upsert'
      AND observation.binding_external_id=NEW.external_id AND observation.binding_status='active'
      AND observation.binding_resource_revision=NEW.project_alpha_revision
      AND observation.has_conflict=0 AND observation.request_id=NEW.inventory_request_id
      AND receipt.authorization_generation=NEW.authorization_generation
      AND receipt.page_sha256=NEW.inventory_page_sha256)
 OR NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    WHERE admission.staff_id=NEW.reviewer_staff_id AND admission.active=1
      AND admission.bound_access_subject=NEW.reviewer_access_subject
      AND admission.version=NEW.reviewer_admission_version
      AND profile.version=NEW.reviewer_profile_version)
 OR NOT EXISTS(SELECT 1 FROM native_directory_grants allow_row
    WHERE allow_row.staff_id=NEW.reviewer_staff_id AND allow_row.permission='directory.identity.link'
      AND allow_row.effect='allow' AND allow_row.active=1
      AND (allow_row.scope_kind='global'
        OR (allow_row.scope_kind='resource' AND allow_row.resource_id=NEW.record_id)
        OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=NEW.record_id AND assignment.staff_id=NEW.reviewer_staff_id AND assignment.active=1))
        OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
        OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
 OR EXISTS(SELECT 1 FROM native_directory_grants deny_row
    WHERE deny_row.staff_id=NEW.reviewer_staff_id AND deny_row.permission='directory.identity.link'
      AND deny_row.effect='deny' AND deny_row.active=1
      AND (deny_row.scope_kind='global'
        OR (deny_row.scope_kind='resource' AND deny_row.resource_id=NEW.record_id)
        OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=NEW.record_id AND assignment.staff_id=NEW.reviewer_staff_id AND assignment.active=1))
        OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=deny_row.business_area_id))
        OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=deny_row.division_id))))
 OR EXISTS(SELECT 1 FROM project_alpha_directory_mappings mapping
    WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
      AND mapping.application_id=NEW.application_id AND mapping.resource_type=NEW.resource_type
      AND (mapping.external_id=NEW.record_id OR mapping.external_id=NEW.external_id
        OR mapping.project_alpha_public_id=NEW.project_alpha_public_id))
 OR EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
    WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
      AND mapping.application_id=NEW.application_id AND mapping.resource_type=NEW.resource_type
      AND (mapping.record_id=NEW.record_id OR mapping.external_id=NEW.external_id
        OR mapping.project_alpha_public_id=NEW.project_alpha_public_id))
 OR EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
    WHERE conflict.source_id=NEW.source_id AND conflict.inventory_kind='directory'
      AND conflict.resource_type='source')
 OR EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
    WHERE conflict.source_id=NEW.source_id AND conflict.source_instance_id=NEW.source_instance_id
      AND conflict.application_id=NEW.application_id AND conflict.history_epoch_id=NEW.history_epoch_id
      AND conflict.inventory_kind='directory' AND conflict.resource_type=NEW.resource_type
      AND (conflict.project_alpha_public_id=NEW.project_alpha_public_id
        OR conflict.external_id=NEW.external_id))
BEGIN SELECT RAISE(ABORT,'directory read adoption review is not current and exact'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_reviews_no_update
BEFORE UPDATE ON project_alpha_directory_read_adoption_reviews
BEGIN SELECT RAISE(ABORT,'directory read adoption review is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_reviews_no_delete
BEFORE DELETE ON project_alpha_directory_read_adoption_reviews
BEGIN SELECT RAISE(ABORT,'directory read adoption review is durable'); END;

-- This claim is an inactive ownership reservation only.  No reader may treat
-- it as a Project Alpha mapping or portal authority.
CREATE TABLE project_alpha_directory_read_adoption_claims (
  claim_id TEXT NOT NULL PRIMARY KEY CHECK(length(claim_id)=36 AND claim_id=lower(claim_id)
    AND claim_id NOT GLOB '*[^0-9a-f-]*' AND substr(claim_id,9,1)='-' AND substr(claim_id,14,1)='-'
    AND substr(claim_id,15,1)='4' AND substr(claim_id,19,1)='-' AND substr(claim_id,20,1) IN ('8','9','a','b')
    AND substr(claim_id,24,1)='-' AND length(replace(claim_id,'-',''))=32),
  review_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_reviews(review_id) ON DELETE RESTRICT,
  native_owner_epoch_id TEXT NOT NULL UNIQUE CHECK(length(native_owner_epoch_id)=36 AND native_owner_epoch_id=lower(native_owner_epoch_id)
    AND native_owner_epoch_id NOT GLOB '*[^0-9a-f-]*' AND substr(native_owner_epoch_id,9,1)='-' AND substr(native_owner_epoch_id,14,1)='-'
    AND substr(native_owner_epoch_id,15,1)='4' AND substr(native_owner_epoch_id,19,1)='-' AND substr(native_owner_epoch_id,20,1) IN ('8','9','a','b')
    AND substr(native_owner_epoch_id,24,1)='-' AND length(replace(native_owner_epoch_id,'-',''))=32),
  record_id TEXT NOT NULL,
  expected_local_record_version INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL,
  reviewer_staff_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'inactive' CHECK(state='inactive'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(native_owner_epoch_id<>history_epoch_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,record_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,external_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id)
);

CREATE TRIGGER project_alpha_directory_read_adoption_claims_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_claims
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_reviews review
  JOIN operations_directory_records record ON record.record_id=review.record_id
  WHERE review.review_id=NEW.review_id AND review.record_id=NEW.record_id
    AND review.expected_local_record_version=NEW.expected_local_record_version
    AND review.source_id=NEW.source_id AND review.source_instance_id=NEW.source_instance_id
    AND review.application_id=NEW.application_id AND review.history_epoch_id=NEW.history_epoch_id
    AND review.resource_type=NEW.resource_type AND review.external_id=NEW.external_id
    AND review.project_alpha_public_id=NEW.project_alpha_public_id
    AND review.reviewer_staff_id=NEW.reviewer_staff_id AND review.request_sha256=NEW.request_sha256
    AND record.record_kind=NEW.resource_type AND record.current_version=NEW.expected_local_record_version)
BEGIN SELECT RAISE(ABORT,'directory read adoption claim requires current exact review'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_claims_no_update
BEFORE UPDATE ON project_alpha_directory_read_adoption_claims
BEGIN SELECT RAISE(ABORT,'directory read adoption claim is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_claims_no_delete
BEFORE DELETE ON project_alpha_directory_read_adoption_claims
BEGIN SELECT RAISE(ABORT,'directory read adoption claim is durable'); END;
