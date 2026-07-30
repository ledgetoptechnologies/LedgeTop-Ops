PRAGMA foreign_keys = ON;

ALTER TABLE delivery_tombstones ADD COLUMN manifested_at TEXT;
ALTER TABLE delivery_tombstones ADD COLUMN purge_blocked_reason TEXT;

CREATE TABLE IF NOT EXISTS delivery_trash_objects (
  tombstone_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  object_size INTEGER NOT NULL CHECK (object_size >= 0),
  relation TEXT NOT NULL CHECK (relation IN ('source', 'derived')),
  purged_at TEXT,
  PRIMARY KEY (tombstone_id, object_key),
  FOREIGN KEY (tombstone_id) REFERENCES delivery_tombstones(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_delivery_trash_objects_pending
  ON delivery_trash_objects(tombstone_id, purged_at);
