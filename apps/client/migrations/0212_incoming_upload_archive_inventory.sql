PRAGMA foreign_keys = ON;

-- Inventory metadata is deliberately separate from the scanned-object proof.
-- A failed inventory never changes verification_state or pickup eligibility.
CREATE TABLE IF NOT EXISTS file_request_upload_archive_inventory (
  upload_id TEXT PRIMARY KEY REFERENCES file_request_uploads(id) ON DELETE CASCADE,
  inventory_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','unavailable')),
  receipt_token TEXT NOT NULL,
  proof_sha256 TEXT NOT NULL,
  proof_etag TEXT NOT NULL,
  proof_bytes INTEGER NOT NULL CHECK (proof_bytes > 0),
  proof_version TEXT,
  next_page INTEGER NOT NULL DEFAULT 0 CHECK (next_page >= 0),
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  metadata_bytes INTEGER NOT NULL DEFAULT 0 CHECK (metadata_bytes >= 0),
  unavailable_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(upload_id, inventory_id)
);
CREATE TABLE IF NOT EXISTS file_request_upload_archive_inventory_pages (
  upload_id TEXT NOT NULL REFERENCES file_request_uploads(id) ON DELETE CASCADE,
  inventory_id TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page >= 0),
  content_hash TEXT NOT NULL,
  PRIMARY KEY(upload_id, inventory_id, page)
);
CREATE TABLE IF NOT EXISTS file_request_upload_archive_inventory_entries (
  upload_id TEXT NOT NULL REFERENCES file_request_uploads(id) ON DELETE CASCADE,
  inventory_id TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  name TEXT NOT NULL,
  name_folded TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folder','file')),
  size INTEGER CHECK (size IS NULL OR size >= 0),
  PRIMARY KEY(upload_id, inventory_id, path)
);
CREATE INDEX IF NOT EXISTS idx_incoming_archive_inventory_children
  ON file_request_upload_archive_inventory_entries(upload_id, inventory_id, parent_path, path);
CREATE INDEX IF NOT EXISTS idx_incoming_archive_inventory_search
  ON file_request_upload_archive_inventory_entries(upload_id, inventory_id, parent_path, name_folded, path);
