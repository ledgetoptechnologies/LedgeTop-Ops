PRAGMA foreign_keys = ON;

-- A checksum is reusable only for the exact immutable R2 identity. Keeping one
-- row per immutable identity prevents a concurrent overwrite of the same key
-- from displacing the checksum needed by an in-flight snapshot.
CREATE TABLE bulk_download_object_checksums (
  r2_key TEXT NOT NULL,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  crc32 INTEGER NOT NULL CHECK (crc32 BETWEEN 0 AND 4294967295),
  calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (r2_key,etag,size)
);
CREATE INDEX idx_bulk_download_object_checksums_last_used
  ON bulk_download_object_checksums(last_used_at);

-- The selection fingerprint includes the share/version boundary, archive entry
-- names, object keys, ETags, and sizes. The artifact key is generation-specific
-- so concurrent first-time builds cannot replace a file being resumed.
CREATE TABLE bulk_download_archive_cache (
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL,
  selection_fingerprint TEXT NOT NULL CHECK (length(selection_fingerprint) = 64),
  archive_key TEXT NOT NULL UNIQUE,
  archive_etag TEXT NOT NULL,
  archive_size INTEGER NOT NULL CHECK (archive_size > 0),
  file_count INTEGER NOT NULL CHECK (file_count > 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (share_id,share_version,selection_fingerprint),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);
CREATE INDEX idx_bulk_download_archive_cache_expiry
  ON bulk_download_archive_cache(expires_at);

-- Every completed generation has a durable lifecycle row. Reuse accepts only
-- active generations; cleanup must atomically move one to deleting before R2.
CREATE TABLE bulk_download_archive_generations (
  archive_key TEXT PRIMARY KEY,
  archive_etag TEXT NOT NULL,
  archive_size INTEGER NOT NULL CHECK (archive_size > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleting')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deletion_started_at TEXT
);
INSERT INTO bulk_download_archive_generations(archive_key,archive_etag,archive_size)
  SELECT archive_key,archive_etag,archive_size FROM bulk_download_archive_cache;
CREATE INDEX idx_bulk_download_archive_generations_state
  ON bulk_download_archive_generations(state,deletion_started_at);

ALTER TABLE bulk_download_jobs ADD COLUMN archive_fingerprint TEXT
  CHECK (archive_fingerprint IS NULL OR length(archive_fingerprint) = 64);
CREATE INDEX idx_bulk_download_jobs_archive_fingerprint
  ON bulk_download_jobs(share_id,share_version,archive_fingerprint,status,expires_at);
CREATE INDEX idx_bulk_download_jobs_archive_key_live
  ON bulk_download_jobs(archive_key,status,expires_at);

-- Cleanup rotates through each candidate space instead of repeatedly starting
-- from the first protected or transiently failing generation.
CREATE TABLE bulk_download_cleanup_cursors (
  scope TEXT PRIMARY KEY CHECK (scope IN ('deleting','expired-cache','orphan-r2')),
  cursor TEXT NOT NULL DEFAULT ''
);
