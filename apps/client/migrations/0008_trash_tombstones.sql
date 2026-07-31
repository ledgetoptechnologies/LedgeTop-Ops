PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS delivery_tombstones (
  id TEXT PRIMARY KEY,
  physical_key TEXT NOT NULL,
  tombstone_kind TEXT NOT NULL CHECK (tombstone_kind IN ('exact', 'prefix')),
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  purge_after TEXT NOT NULL,
  purging_at TEXT,
  restored_by TEXT,
  restored_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_tombstones_active_key
  ON delivery_tombstones(restored_at, physical_key);

CREATE INDEX IF NOT EXISTS idx_delivery_tombstones_purge
  ON delivery_tombstones(restored_at, purge_after, purging_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_tombstones_active_unique
  ON delivery_tombstones(physical_key) WHERE restored_at IS NULL;
