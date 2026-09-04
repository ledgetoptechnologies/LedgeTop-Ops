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

ALTER TABLE bulk_download_jobs ADD COLUMN archive_fingerprint TEXT
  CHECK (archive_fingerprint IS NULL OR length(archive_fingerprint) = 64);
CREATE INDEX idx_bulk_download_jobs_archive_fingerprint
  ON bulk_download_jobs(share_id,share_version,archive_fingerprint,status,expires_at);
