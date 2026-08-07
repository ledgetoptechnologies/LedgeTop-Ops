PRAGMA foreign_keys = ON;

-- Queue publication is recorded separately from job state so duplicate R2
-- notifications and resumable backfills can repair an interrupted publish
-- without duplicating already-published work.
ALTER TABLE image_thumbnail_jobs ADD COLUMN queue_published_at TEXT;

CREATE TABLE IF NOT EXISTS image_thumbnail_backfill_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run','enqueue')),
  scope_prefix TEXT NOT NULL CHECK (scope_prefix = 'Jobs/Clients/'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed')),
  cursor TEXT,
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  ready_count INTEGER NOT NULL DEFAULT 0 CHECK (ready_count >= 0),
  failed_dlq_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_dlq_count >= 0),
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  lease_until TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_backfill_due
  ON image_thumbnail_backfill_runs(status, lease_until, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_image_thumbnail_backfill_active_scope
  ON image_thumbnail_backfill_runs(scope_prefix)
  WHERE status IN ('queued','running');
