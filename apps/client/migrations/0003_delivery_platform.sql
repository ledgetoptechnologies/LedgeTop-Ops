PRAGMA foreign_keys = ON;

ALTER TABLE shares ADD COLUMN public_id TEXT;
ALTER TABLE shares ADD COLUMN idempotency_key TEXT;
ALTER TABLE shares ADD COLUMN share_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN division_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_public_id ON shares(public_id) WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_idempotency ON shares(created_by_type, created_by_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_division ON projects(division_id, active);

CREATE TABLE IF NOT EXISTS share_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('session.created', 'unlock.failed', 'manifest.viewed', 'preview.viewed', 'download.started')),
  item_ref TEXT,
  client_address_hash TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (share_id) REFERENCES shares(id)
);

CREATE INDEX IF NOT EXISTS idx_share_events_share_created ON share_events(share_id, created_at DESC);

CREATE TABLE IF NOT EXISTS file_index (
  r2_key TEXT PRIMARY KEY,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL,
  content_type TEXT,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video', 'audio', 'pdf', 'text', 'other')),
  stream_uid TEXT,
  stream_status TEXT CHECK (stream_status IS NULL OR stream_status IN ('pending', 'ready', 'error', 'disabled', 'requires_resumable')),
  stream_error TEXT,
  last_seen_reconcile TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_index_kind ON file_index(media_kind, stream_status);

CREATE TABLE IF NOT EXISTS folder_rules (
  id TEXT PRIMARY KEY,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('exclude_segment', 'project_pattern')),
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO folder_rules (id, rule_type, pattern, priority) VALUES ('exclude-dump', 'exclude_segment', 'dump', 1);
INSERT OR IGNORE INTO folder_rules (id, rule_type, pattern, priority) VALUES ('jobs-year', 'project_pattern', 'jobs/{year}/{client}/**', 20);
INSERT OR IGNORE INTO folder_rules (id, rule_type, pattern, priority) VALUES ('jobs-recurring', 'project_pattern', 'jobs/recurring/{client}/**', 10);

CREATE TABLE IF NOT EXISTS delivery_sync_health (
  source TEXT PRIMARY KEY,
  last_attempt_at TEXT,
  last_success_at TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('healthy', 'stale', 'error', 'unknown')),
  object_count INTEGER,
  details_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
