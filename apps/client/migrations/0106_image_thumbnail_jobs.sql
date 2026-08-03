PRAGMA foreign_keys = ON;

-- Durable, source-identity-scoped state for the Cloudflare thumbnail worker.
-- Originals remain authoritative and untouched; this table only tracks the
-- single disposable thumbnail associated with the current R2 object ETag.
CREATE TABLE IF NOT EXISTS image_thumbnail_jobs (
  source_key TEXT PRIMARY KEY,
  source_etag TEXT NOT NULL,
  source_size INTEGER NOT NULL CHECK (source_size > 0),
  thumbnail_key TEXT NOT NULL UNIQUE,
  thumbnail_etag TEXT,
  thumbnail_size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','ready','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  error_message TEXT,
  lease_until TEXT,
  last_event_at TEXT,
  ready_at TEXT,
  failed_at TEXT,
  dead_lettered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_jobs_status
  ON image_thumbnail_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_jobs_lease
  ON image_thumbnail_jobs(status, lease_until);
