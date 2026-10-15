PRAGMA foreign_keys = ON;

-- TrueNAS renderer coordination. Lease identifiers are random capabilities,
-- while the renderer bearer secret remains a Worker secret and is never
-- persisted. Exact source identity remains authoritative in the job row.
ALTER TABLE image_thumbnail_jobs ADD COLUMN renderer_lease_id TEXT;
ALTER TABLE image_thumbnail_jobs ADD COLUMN renderer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_jobs_renderer_lease
  ON image_thumbnail_jobs(renderer_lease_id,status,lease_until);

CREATE TABLE IF NOT EXISTS image_thumbnail_renderer_instances (
  renderer_id TEXT PRIMARY KEY,
  renderer_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  capacity_json TEXT NOT NULL,
  activated_at TEXT,
  last_claim_at TEXT,
  last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_renderer_active
  ON image_thumbnail_renderer_instances(activated_at,last_heartbeat_at);

CREATE TABLE IF NOT EXISTS image_thumbnail_renderer_leases (
  lease_id TEXT PRIMARY KEY,
  renderer_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  source_size INTEGER NOT NULL CHECK (source_size > 0),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image','pdf','video')),
  thumbnail_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','failed','expired','cancelled')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  lease_until TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  failed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_renderer_leases_due
  ON image_thumbnail_renderer_leases(status,lease_until,claimed_at);

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_renderer_leases_source
  ON image_thumbnail_renderer_leases(source_key,source_etag,status);
