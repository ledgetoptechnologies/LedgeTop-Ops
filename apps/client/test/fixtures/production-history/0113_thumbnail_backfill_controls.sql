PRAGMA foreign_keys = ON;

-- Operator-controlled, resumable inventory runs. A run may target one exact
-- canonical Jobs subtree; pause/cancel are durable and checked between pages.
ALTER TABLE image_thumbnail_backfill_runs RENAME TO image_thumbnail_backfill_runs_legacy_0113;

CREATE TABLE image_thumbnail_backfill_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run','enqueue')),
  scope_prefix TEXT NOT NULL CHECK (
    length(scope_prefix) BETWEEN 5 AND 1024
    AND substr(scope_prefix,1,5)='Jobs/'
    AND substr(scope_prefix,-1)='/'
    AND instr(scope_prefix,'\')=0
    AND instr(scope_prefix,char(0))=0
    AND lower(scope_prefix) NOT LIKE 'jobs/incoming/%'
  ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','paused','cancelled','completed','failed')),
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 10
    CHECK (rate_limit_per_minute BETWEEN 1 AND 60),
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

INSERT INTO image_thumbnail_backfill_runs (
  id,mode,scope_prefix,status,rate_limit_per_minute,cursor,page_count,attempt_count,discovered_count,
  eligible_count,queued_count,skipped_count,ready_count,failed_dlq_count,
  pending_count,lease_until,error_code,error_message,started_at,completed_at,
  created_at,updated_at
)
SELECT
  id,mode,scope_prefix,status,10,cursor,page_count,attempt_count,discovered_count,
  eligible_count,queued_count,skipped_count,ready_count,failed_dlq_count,
  pending_count,lease_until,error_code,error_message,started_at,completed_at,
  created_at,updated_at
FROM image_thumbnail_backfill_runs_legacy_0113;

DROP TABLE image_thumbnail_backfill_runs_legacy_0113;

CREATE INDEX idx_image_thumbnail_backfill_due
  ON image_thumbnail_backfill_runs(status,lease_until,created_at);

CREATE UNIQUE INDEX idx_image_thumbnail_backfill_active_scope
  ON image_thumbnail_backfill_runs(scope_prefix)
  WHERE status IN ('queued','running','paused');
