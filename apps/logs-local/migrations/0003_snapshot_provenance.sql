-- Local-host-only: where imported history came from. A snapshot is identified by the SHA-256 of its manifest.
-- Rows are only added; a completed snapshot is never re-applied differently (the importer compares every row).
CREATE TABLE snapshot_imports (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),  -- sha256 of manifest.json
  label TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('cloudflare-d1')),
  device_tokens TEXT NOT NULL CHECK (device_tokens IN ('preserve', 'revoke')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  receipt TEXT                                   -- aggregate counts only (JSON); never row contents
);
-- Imported DJI keychains are kept as the exact sealed ciphertext from the source. They were sealed with the source's
-- key, which this host does not have: a new local key cannot open them, and nothing here re-seals or drops them.
CREATE TABLE keychain_provenance (
  file_hash TEXT PRIMARY KEY REFERENCES keychains(file_hash),
  snapshot_id TEXT NOT NULL REFERENCES snapshot_imports(id),
  sealed_by TEXT NOT NULL CHECK (sealed_by IN ('source-key')),
  source_key_version INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);
