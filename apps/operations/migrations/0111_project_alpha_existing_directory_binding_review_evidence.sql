PRAGMA foreign_keys = ON;

-- Review-only evidence for an operator-identified, already-existing Project
-- Alpha directory record.  This table is deliberately not consulted by the
-- directory materializer or authority policy: a review is not a binding
-- receipt, and cannot authorize create, update, or delivery.
CREATE TABLE project_alpha_existing_directory_binding_review_evidence (
  receipt_id TEXT NOT NULL PRIMARY KEY CHECK(length(receipt_id)=36 AND length(replace(receipt_id,'-',''))=32
    AND receipt_id=lower(receipt_id) AND receipt_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(receipt_id,9,1)='-' AND substr(receipt_id,14,1)='-' AND substr(receipt_id,15,1)='4'
    AND substr(receipt_id,19,1)='-' AND substr(receipt_id,20,1) IN ('8','9','a','b') AND substr(receipt_id,24,1)='-'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_id TEXT NOT NULL CHECK(length(record_id) BETWEEN 1 AND 191 AND instr(record_id,char(0))=0),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128 AND instr(source_id,char(0))=0),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 191 AND length(CAST(external_id AS BLOB))<=764 AND instr(external_id,char(0))=0),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(length(project_alpha_revision) BETWEEN 1 AND 19 AND project_alpha_revision NOT GLOB '*[^0-9]*' AND project_alpha_revision<>'0' AND (length(project_alpha_revision)<19 OR project_alpha_revision<='9223372036854775807')),
  review_id TEXT NOT NULL UNIQUE CHECK(length(review_id)=36),
  reviewed_binding_evidence_sha256 TEXT NOT NULL CHECK(length(reviewed_binding_evidence_sha256)=64 AND reviewed_binding_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  reviewer_staff_id TEXT NOT NULL CHECK(length(trim(reviewer_staff_id)) BETWEEN 1 AND 191 AND instr(reviewer_staff_id,char(0))=0),
  reviewer_access_subject TEXT NOT NULL CHECK(length(trim(reviewer_access_subject)) BETWEEN 1 AND 191 AND instr(reviewer_access_subject,char(0))=0),
  reviewer_admission_version INTEGER NOT NULL CHECK(typeof(reviewer_admission_version)='integer' AND reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(typeof(reviewer_profile_version)='integer' AND reviewer_profile_version>=1),
  reviewed_at TEXT NOT NULL CHECK(length(reviewed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at)=reviewed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX project_alpha_existing_directory_binding_review_evidence_lookup
  ON project_alpha_existing_directory_binding_review_evidence(record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id);
-- Re-reviewing the same local/PA pairing (for example at a newer PA revision)
-- is allowed. Reusing a destination identity for another local record or PA
-- public ID is not an implicit reconciliation.
CREATE TRIGGER project_alpha_existing_directory_binding_review_evidence_destination_pinned
BEFORE INSERT ON project_alpha_existing_directory_binding_review_evidence
WHEN EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_review_evidence existing
  WHERE existing.source_id=NEW.source_id AND existing.source_instance_id=NEW.source_instance_id
    AND existing.application_id=NEW.application_id AND existing.history_epoch_id=NEW.history_epoch_id
    AND existing.resource_type=NEW.resource_type AND existing.external_id=NEW.external_id
    AND (existing.record_id IS NOT NEW.record_id OR existing.project_alpha_public_id IS NOT NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'existing directory binding review destination conflict'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_review_evidence_no_update
BEFORE UPDATE ON project_alpha_existing_directory_binding_review_evidence
BEGIN SELECT RAISE(ABORT,'existing directory binding review evidence is immutable'); END;
CREATE TRIGGER project_alpha_existing_directory_binding_review_evidence_no_delete
BEFORE DELETE ON project_alpha_existing_directory_binding_review_evidence
BEGIN SELECT RAISE(ABORT,'existing directory binding review evidence is durable'); END;
