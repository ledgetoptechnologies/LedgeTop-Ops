PRAGMA foreign_keys = ON;

-- Durable, idempotent deletion ledger for retired thumbnail versions. Triggers
-- make retirement atomic with every source-row replacement or removal, while
-- the Operations scheduler performs the private R2 delete with bounded retry.
CREATE TABLE IF NOT EXISTS image_thumbnail_cleanup_jobs (
  thumbnail_key TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  lease_until TEXT,
  error_code TEXT,
  error_message TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_cleanup_due
  ON image_thumbnail_cleanup_jobs(status, next_attempt_at, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_image_thumbnail_retire_update
BEFORE UPDATE OF thumbnail_key ON image_thumbnail_jobs
WHEN OLD.thumbnail_key <> NEW.thumbnail_key
BEGIN
  INSERT OR IGNORE INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,reason)
  VALUES(OLD.thumbnail_key,OLD.source_key,OLD.source_etag,'source_replaced');
END;

CREATE TRIGGER IF NOT EXISTS trg_image_thumbnail_retire_delete
BEFORE DELETE ON image_thumbnail_jobs
BEGIN
  INSERT OR IGNORE INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,reason)
  VALUES(OLD.thumbnail_key,OLD.source_key,OLD.source_etag,'source_removed');
END;
