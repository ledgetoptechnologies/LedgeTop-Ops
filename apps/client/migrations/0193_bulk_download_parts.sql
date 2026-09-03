PRAGMA foreign_keys = ON;

ALTER TABLE bulk_download_jobs ADD COLUMN parent_job_id TEXT;
ALTER TABLE bulk_download_jobs ADD COLUMN part_index INTEGER CHECK (part_index IS NULL OR part_index >= 1);
ALTER TABLE bulk_download_jobs ADD COLUMN part_count INTEGER NOT NULL DEFAULT 1 CHECK (part_count >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bulk_download_jobs_parent_part
  ON bulk_download_jobs(parent_job_id,part_index)
  WHERE parent_job_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_bulk_download_part_parent_insert
BEFORE INSERT ON bulk_download_jobs
WHEN NEW.parent_job_id IS NOT NULL OR NEW.part_index IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.parent_job_id IS NULL OR NEW.part_index IS NULL OR NEW.id = NEW.parent_job_id
      THEN RAISE(ABORT, 'bulk_download_part_identity_invalid')
    WHEN NEW.part_count <= 1 OR NEW.part_index > NEW.part_count
      THEN RAISE(ABORT, 'bulk_download_part_count_invalid')
    WHEN NOT EXISTS (
      SELECT 1 FROM bulk_download_jobs parent
      WHERE parent.id = NEW.parent_job_id
        AND parent.parent_job_id IS NULL
        AND parent.share_id = NEW.share_id
        AND parent.share_version = NEW.share_version
    ) THEN RAISE(ABORT, 'bulk_download_part_parent_invalid')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_bulk_download_part_parent_update
BEFORE UPDATE OF parent_job_id,part_index,part_count,share_id,share_version ON bulk_download_jobs
WHEN NEW.parent_job_id IS NOT NULL OR NEW.part_index IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.parent_job_id IS NULL OR NEW.part_index IS NULL OR NEW.id = NEW.parent_job_id
      THEN RAISE(ABORT, 'bulk_download_part_identity_invalid')
    WHEN NEW.part_count <= 1 OR NEW.part_index > NEW.part_count
      THEN RAISE(ABORT, 'bulk_download_part_count_invalid')
    WHEN NOT EXISTS (
      SELECT 1 FROM bulk_download_jobs parent
      WHERE parent.id = NEW.parent_job_id
        AND parent.parent_job_id IS NULL
        AND parent.share_id = NEW.share_id
        AND parent.share_version = NEW.share_version
    ) THEN RAISE(ABORT, 'bulk_download_part_parent_invalid')
  END;
END;
