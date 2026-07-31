PRAGMA foreign_keys = ON;

-- Exact per-share hourly quota for asynchronous bulk archive job creation. The
-- application updates this row conditionally, so a request either consumes
-- one slot or receives a deterministic quota error.
CREATE TABLE IF NOT EXISTS bulk_download_quota (
  share_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (share_id, window_start),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bulk_download_quota_updated
  ON bulk_download_quota(updated_at);
