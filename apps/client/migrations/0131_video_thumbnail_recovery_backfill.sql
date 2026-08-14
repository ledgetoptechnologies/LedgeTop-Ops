PRAGMA foreign_keys = ON;

-- One bounded, cutoff-pinned repair pass for video rows written while video
-- thumbnail sources were incorrectly classified as unsupported. This is
-- deliberately separate from generic thumbnail backfills: later renderer
-- failures must never become eligible for this historical repair.
CREATE TABLE IF NOT EXISTS legacy_video_thumbnail_recovery (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed')),
  cursor TEXT,
  -- Leave a one-second boundary so a renderer transition in the same SQLite
  -- timestamp tick cannot be mistaken for historical state.
  cutoff_at TEXT NOT NULL DEFAULT (datetime('now','-1 second')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  recovered_count INTEGER NOT NULL DEFAULT 0 CHECK (recovered_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  lease_until TEXT,
  claim_token TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO legacy_video_thumbnail_recovery(singleton) VALUES(1);
