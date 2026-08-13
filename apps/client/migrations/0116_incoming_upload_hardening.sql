PRAGMA foreign_keys = ON;

-- The browser hashes bounded samples plus stable file metadata before reusing
-- an upload identity. This is deliberately distinct from declared_sha256,
-- which represents an optional full-file digest supplied by an integration.
ALTER TABLE file_request_uploads ADD COLUMN resume_fingerprint TEXT
  CHECK (resume_fingerprint IS NULL OR length(resume_fingerprint) = 64);

-- This marker makes the quota trigger safe during a rolling migration. Older
-- Workers update quota_released_at and then decrement counters themselves;
-- only the new Worker sets quota_release_managed=1 and relies on the trigger.
ALTER TABLE file_request_uploads ADD COLUMN quota_release_managed INTEGER NOT NULL DEFAULT 0
  CHECK (quota_release_managed IN (0,1));

CREATE TRIGGER file_request_upload_quota_release
AFTER UPDATE OF quota_released_at,quota_release_managed ON file_request_uploads
WHEN OLD.quota_released_at IS NULL
  AND NEW.quota_released_at IS NOT NULL
  AND NEW.quota_release_managed = 1
BEGIN
  UPDATE file_requests
  SET reserved_files = MAX(0,reserved_files-1),
      reserved_bytes = MAX(0,reserved_bytes-NEW.declared_size),
      updated_at = datetime('now')
  WHERE id = NEW.request_id;
END;
