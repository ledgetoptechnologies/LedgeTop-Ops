PRAGMA foreign_keys = ON;

-- LTDS-local execution instructions. Project Alpha remains authoritative for
-- the operation identity, assignment, schedule, and financial/project state.
CREATE TABLE operational_job_briefs (
  operation_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (operation_id) REFERENCES pa_operations(id),
  FOREIGN KEY (created_by) REFERENCES staff_users(id),
  FOREIGN KEY (updated_by) REFERENCES staff_users(id)
);

CREATE TABLE operational_job_brief_attachments (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  version_added INTEGER NOT NULL CHECK (version_added > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('staff_upload','project_file')),
  source_reference TEXT,
  object_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  etag TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (operation_id) REFERENCES operational_job_briefs(operation_id),
  FOREIGN KEY (created_by) REFERENCES staff_users(id),
  UNIQUE (operation_id,object_key)
);

CREATE INDEX idx_operational_job_brief_attachments_operation
ON operational_job_brief_attachments(operation_id,version_added,id);

CREATE TABLE operational_job_brief_revisions (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('scope_saved','attachment_added')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  author_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (operation_id,version),
  FOREIGN KEY (operation_id) REFERENCES operational_job_briefs(operation_id),
  FOREIGN KEY (author_id) REFERENCES staff_users(id)
);

CREATE INDEX idx_operational_job_brief_revisions_operation
ON operational_job_brief_revisions(operation_id,version DESC);

-- Revisions and attachment records are evidence, not mutable working state.
CREATE TRIGGER operational_job_brief_revisions_no_update
BEFORE UPDATE ON operational_job_brief_revisions
BEGIN
  SELECT RAISE(ABORT, 'job brief revisions are immutable');
END;

CREATE TRIGGER operational_job_brief_revisions_no_delete
BEFORE DELETE ON operational_job_brief_revisions
BEGIN
  SELECT RAISE(ABORT, 'job brief revisions are immutable');
END;

CREATE TRIGGER operational_job_brief_attachments_no_update
BEFORE UPDATE ON operational_job_brief_attachments
BEGIN
  SELECT RAISE(ABORT, 'job brief attachments are immutable');
END;

CREATE TRIGGER operational_job_brief_attachments_no_delete
BEFORE DELETE ON operational_job_brief_attachments
BEGIN
  SELECT RAISE(ABORT, 'job brief attachments are immutable');
END;
