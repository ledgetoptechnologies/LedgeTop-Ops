PRAGMA foreign_keys = ON;

-- Minimal provenance retained for the hybrid renderer. Exact source and
-- thumbnail identities already live in source_etag and thumbnail_etag; no
-- remote renderer lease or source-download credential is persisted.
ALTER TABLE image_thumbnail_jobs ADD COLUMN thumbnail_provider TEXT
  CHECK (thumbnail_provider IS NULL OR thumbnail_provider IN ('ltds-truenas','cloudflare-container'));
ALTER TABLE image_thumbnail_jobs ADD COLUMN thumbnail_profile TEXT;
ALTER TABLE image_thumbnail_jobs ADD COLUMN thumbnail_manifest_key TEXT;
ALTER TABLE image_thumbnail_jobs ADD COLUMN thumbnail_manifest_etag TEXT;
ALTER TABLE image_thumbnail_cleanup_jobs ADD COLUMN artifact_etag TEXT;

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_jobs_provider
  ON image_thumbnail_jobs(thumbnail_provider,status,updated_at);

DROP TRIGGER IF EXISTS trg_image_thumbnail_retire_update;
DROP TRIGGER IF EXISTS trg_image_thumbnail_retire_delete;

CREATE TRIGGER trg_image_thumbnail_retire_update
BEFORE UPDATE OF thumbnail_key ON image_thumbnail_jobs
WHEN OLD.thumbnail_key <> NEW.thumbnail_key
BEGIN
  INSERT INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,artifact_etag,reason)
  VALUES(OLD.thumbnail_key,OLD.source_key,OLD.source_etag,OLD.thumbnail_etag,'source_replaced')
  ON CONFLICT(thumbnail_key) DO UPDATE SET
    source_key=excluded.source_key,source_etag=excluded.source_etag,
    artifact_etag=excluded.artifact_etag,reason=excluded.reason,status='pending',
    attempt_count=0,next_attempt_at=datetime('now'),lease_until=NULL,
    error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now');
END;

CREATE TRIGGER trg_image_thumbnail_retire_manifest_update
BEFORE UPDATE OF thumbnail_manifest_key ON image_thumbnail_jobs
WHEN OLD.thumbnail_manifest_key IS NOT NULL AND OLD.thumbnail_manifest_key <> COALESCE(NEW.thumbnail_manifest_key,'')
BEGIN
  INSERT INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,artifact_etag,reason)
  VALUES(OLD.thumbnail_manifest_key,OLD.source_key,OLD.source_etag,OLD.thumbnail_manifest_etag,'manifest_replaced')
  ON CONFLICT(thumbnail_key) DO UPDATE SET
    source_key=excluded.source_key,source_etag=excluded.source_etag,
    artifact_etag=excluded.artifact_etag,reason=excluded.reason,status='pending',
    attempt_count=0,next_attempt_at=datetime('now'),lease_until=NULL,
    error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now');
END;

CREATE TRIGGER trg_image_thumbnail_retire_delete
BEFORE DELETE ON image_thumbnail_jobs
BEGIN
  INSERT INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,artifact_etag,reason)
  VALUES(OLD.thumbnail_key,OLD.source_key,OLD.source_etag,OLD.thumbnail_etag,'source_removed')
  ON CONFLICT(thumbnail_key) DO UPDATE SET
    source_key=excluded.source_key,source_etag=excluded.source_etag,
    artifact_etag=excluded.artifact_etag,reason=excluded.reason,status='pending',
    attempt_count=0,next_attempt_at=datetime('now'),lease_until=NULL,
    error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now');
  INSERT INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,artifact_etag,reason)
  SELECT OLD.thumbnail_manifest_key,OLD.source_key,OLD.source_etag,OLD.thumbnail_manifest_etag,'source_removed'
  WHERE OLD.thumbnail_manifest_key IS NOT NULL
  ON CONFLICT(thumbnail_key) DO UPDATE SET
    source_key=excluded.source_key,source_etag=excluded.source_etag,
    artifact_etag=excluded.artifact_etag,reason=excluded.reason,status='pending',
    attempt_count=0,next_attempt_at=datetime('now'),lease_until=NULL,
    error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now');
END;

CREATE TABLE IF NOT EXISTS image_thumbnail_registration_reconciliation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  cleaned_count INTEGER NOT NULL DEFAULT 0 CHECK (cleaned_count >= 0),
  completed_cycles INTEGER NOT NULL DEFAULT 0 CHECK (completed_cycles >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO image_thumbnail_registration_reconciliation(singleton) VALUES(1);

CREATE TABLE IF NOT EXISTS image_thumbnail_managed_orphan_reconciliation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  cleaned_count INTEGER NOT NULL DEFAULT 0 CHECK (cleaned_count >= 0),
  completed_cycles INTEGER NOT NULL DEFAULT 0 CHECK (completed_cycles >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO image_thumbnail_managed_orphan_reconciliation(singleton) VALUES(1);
