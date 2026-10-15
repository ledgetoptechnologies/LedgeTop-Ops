PRAGMA foreign_keys = ON;

-- A sealed human comparison of the current local profile and a fresh PA GET.
-- This is evidence only: no mapping, membership, Delivery or public-link reader
-- consumes these rows, and the inactive 0126 claim remains unchanged.
CREATE TABLE project_alpha_directory_read_adoption_field_review_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY CHECK(length(receipt_id)=36 AND receipt_id=lower(receipt_id)
    AND receipt_id NOT GLOB '*[^0-9a-f-]*' AND substr(receipt_id,9,1)='-' AND substr(receipt_id,14,1)='-'
    AND substr(receipt_id,15,1)='4' AND substr(receipt_id,19,1)='-' AND substr(receipt_id,20,1) IN ('8','9','a','b')
    AND substr(receipt_id,24,1)='-' AND length(replace(receipt_id,'-',''))=32),
  review_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_reviews(review_id) ON DELETE RESTRICT,
  claim_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_claims(claim_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL,
  source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL, history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  record_id TEXT NOT NULL, external_id TEXT NOT NULL, project_alpha_public_id TEXT NOT NULL,
  project_alpha_revision TEXT NOT NULL, authorization_generation TEXT NOT NULL,
  local_record_version INTEGER NOT NULL CHECK(typeof(local_record_version)='integer' AND local_record_version>=1),
  local_profile_sha256 TEXT NOT NULL CHECK(length(local_profile_sha256)=64 AND local_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_alpha_profile_sha256 TEXT NOT NULL CHECK(length(project_alpha_profile_sha256)=64 AND project_alpha_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_alpha_profile_request_id TEXT NOT NULL CHECK(length(project_alpha_profile_request_id)=36),
  reviewer_staff_id TEXT NOT NULL, reviewer_access_subject TEXT NOT NULL,
  reviewer_admission_version INTEGER NOT NULL CHECK(reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(reviewer_profile_version>=1),
  decision_count INTEGER NOT NULL CHECK(decision_count IN (9,11)),
  reviewed_at TEXT NOT NULL CHECK(length(reviewed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at)=reviewed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK((resource_type='organization' AND decision_count=9) OR (resource_type='client' AND decision_count=11))
);

CREATE TRIGGER project_alpha_directory_read_adoption_field_review_receipts_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_field_review_receipts
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_reviews review
  JOIN project_alpha_directory_read_adoption_claims claim ON claim.review_id=review.review_id
  JOIN operations_directory_records record ON record.record_id=review.record_id
  JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
  JOIN native_staff_admissions admission ON admission.staff_id=review.reviewer_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  WHERE review.review_id=NEW.review_id AND claim.claim_id=NEW.claim_id AND claim.state='inactive'
    AND review.source_id=NEW.source_id AND review.source_instance_id=NEW.source_instance_id
    AND review.application_id=NEW.application_id AND review.history_epoch_id=NEW.history_epoch_id
    AND review.resource_type=NEW.resource_type AND review.record_id=NEW.record_id
    AND review.external_id=NEW.external_id AND review.project_alpha_public_id=NEW.project_alpha_public_id
    AND review.project_alpha_revision=NEW.project_alpha_revision
    AND review.authorization_generation=NEW.authorization_generation
    AND review.expected_local_record_version=NEW.local_record_version
    AND record.record_kind=NEW.resource_type AND record.current_version=NEW.local_record_version
    AND review.reviewer_staff_id=NEW.reviewer_staff_id
    AND review.reviewer_access_subject=NEW.reviewer_access_subject
    AND review.reviewer_admission_version=NEW.reviewer_admission_version
    AND review.reviewer_profile_version=NEW.reviewer_profile_version
    AND admission.active=1 AND admission.bound_access_subject=NEW.reviewer_access_subject
    AND admission.version=NEW.reviewer_admission_version AND profile.version=NEW.reviewer_profile_version)
BEGIN SELECT RAISE(ABORT,'directory adoption field review requires current exact inactive claim'); END;

CREATE TABLE project_alpha_directory_read_adoption_field_decisions (
  receipt_id TEXT NOT NULL REFERENCES project_alpha_directory_read_adoption_field_review_receipts(receipt_id) ON DELETE RESTRICT,
  field_name TEXT NOT NULL CHECK(field_name IN ('name','email','phone','address_line1','address_line2','city','state','postal_code','country','client_type','organization_public_id')),
  decision TEXT NOT NULL CHECK(decision IN ('unchanged','retain_local','adopt_project_alpha','requires_follow_up')),
  PRIMARY KEY(receipt_id,field_name)
);

-- The audit row is the seal: it can only be appended after the exact complete
-- field set exists. Decisions contain enums only; compared values never enter
-- this ledger.
CREATE TABLE project_alpha_directory_read_adoption_field_review_audit (
  audit_id TEXT NOT NULL PRIMARY KEY CHECK(length(audit_id)=36),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_field_review_receipts(receipt_id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event='field_review_sealed'),
  actor_staff_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_directory_read_adoption_field_review_audit_complete
BEFORE INSERT ON project_alpha_directory_read_adoption_field_review_audit
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_review_receipts receipt
  WHERE receipt.receipt_id=NEW.receipt_id AND receipt.reviewer_staff_id=NEW.actor_staff_id
    AND (SELECT count(*) FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id)=receipt.decision_count
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='name')
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='email')
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='phone')
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='address_line1')
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='address_line2')
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='city')
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='state')
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='postal_code')
    AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='country')
    AND (receipt.resource_type='organization' OR (receipt.resource_type='client'
      AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='client_type')
      AND EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=receipt.receipt_id AND field_name='organization_public_id'))))
BEGIN SELECT RAISE(ABORT,'directory adoption field review decisions are incomplete'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_field_decisions_kind
BEFORE INSERT ON project_alpha_directory_read_adoption_field_decisions
WHEN NEW.field_name IN ('client_type','organization_public_id') AND NOT EXISTS(
  SELECT 1 FROM project_alpha_directory_read_adoption_field_review_receipts receipt
  WHERE receipt.receipt_id=NEW.receipt_id AND receipt.resource_type='client')
BEGIN SELECT RAISE(ABORT,'directory adoption field is not applicable'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_field_review_receipts_no_update BEFORE UPDATE ON project_alpha_directory_read_adoption_field_review_receipts BEGIN SELECT RAISE(ABORT,'directory adoption field review receipt is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_field_review_receipts_no_delete BEFORE DELETE ON project_alpha_directory_read_adoption_field_review_receipts BEGIN SELECT RAISE(ABORT,'directory adoption field review receipt is durable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_field_decisions_no_update BEFORE UPDATE ON project_alpha_directory_read_adoption_field_decisions BEGIN SELECT RAISE(ABORT,'directory adoption field decision is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_field_decisions_no_delete BEFORE DELETE ON project_alpha_directory_read_adoption_field_decisions BEGIN SELECT RAISE(ABORT,'directory adoption field decision is durable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_field_review_audit_no_update BEFORE UPDATE ON project_alpha_directory_read_adoption_field_review_audit BEGIN SELECT RAISE(ABORT,'directory adoption field review audit is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_field_review_audit_no_delete BEFORE DELETE ON project_alpha_directory_read_adoption_field_review_audit BEGIN SELECT RAISE(ABORT,'directory adoption field review audit is durable'); END;
