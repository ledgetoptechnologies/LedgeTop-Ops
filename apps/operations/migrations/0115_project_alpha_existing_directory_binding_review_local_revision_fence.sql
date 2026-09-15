PRAGMA foreign_keys = ON;

-- 0111 review receipts predate the local-record-version fence.  Keep their
-- history untouched and fail closed: NULL is deliberately not a usable local
-- revision snapshot.  The normal application path supplies a non-NULL value
-- only through the fenced review writer; privileged D1 writers are outside
-- this authenticity boundary.
ALTER TABLE project_alpha_existing_directory_binding_review_evidence
  ADD COLUMN reviewed_local_record_version INTEGER
  CHECK(reviewed_local_record_version IS NULL OR
    (typeof(reviewed_local_record_version)='integer' AND reviewed_local_record_version>=1));

-- This is a consistency fence, not a writer-authenticity boundary: a D1
-- writer is privileged.  The application writer still uses one conditional
-- INSERT ... SELECT so the checked current version and persisted version are
-- from the same statement.  Later consumers must independently read the
-- current version; this column is only the historical review snapshot.
CREATE TRIGGER project_alpha_existing_directory_binding_review_evidence_local_record_version_current
BEFORE INSERT ON project_alpha_existing_directory_binding_review_evidence
WHEN NEW.reviewed_local_record_version IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM operations_directory_records record
    WHERE record.record_id=NEW.record_id AND record.record_kind=NEW.resource_type
      AND record.current_version=NEW.reviewed_local_record_version)
BEGIN SELECT RAISE(ABORT,'existing directory binding review local record version is stale'); END;

-- The final immutable 0113 provenance receipt must close the gap between an
-- adapter's independent current-version read and its INSERT.  Old 0113 rows
-- are historical and untouched; new ones require a post-0115 fenced review
-- whose recorded local version is still current at this write boundary.
CREATE TRIGGER project_alpha_existing_directory_binding_acquired_mapping_receipts_review_local_revision_current
BEFORE INSERT ON project_alpha_existing_directory_binding_acquired_mapping_receipts
WHEN NOT EXISTS(SELECT 1
  FROM project_alpha_existing_directory_binding_acquisition_commands command
  JOIN project_alpha_existing_directory_binding_review_evidence review
    ON review.receipt_id=command.review_receipt_id
  JOIN operations_directory_records record ON record.record_id=command.record_id
  WHERE command.command_id=NEW.command_id AND command.record_id=NEW.record_id
    AND command.resource_type=NEW.resource_type AND review.record_id=command.record_id
    AND review.resource_type=command.resource_type
    AND review.reviewed_local_record_version IS NOT NULL
    AND record.record_kind=command.resource_type
    AND record.current_version=review.reviewed_local_record_version)
BEGIN SELECT RAISE(ABORT,'existing directory acquired mapping receipt requires current fenced review local revision'); END;
