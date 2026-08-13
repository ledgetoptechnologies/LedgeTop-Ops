PRAGMA foreign_keys = ON;

-- The Project Alpha service catalog projection is additive and default-off in
-- Worker configuration. Pages are staged by generation; client catalog reads
-- continue to use pa_service_catalog_items until a complete generation is
-- activated in one D1 batch.
ALTER TABLE pa_service_catalog_items ADD COLUMN source_generation TEXT;
ALTER TABLE pa_service_catalog_items ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pa_service_catalog_generations (
  id TEXT PRIMARY KEY,
  source_generation TEXT NOT NULL UNIQUE CHECK (length(source_generation) BETWEEN 1 AND 128),
  source_sequence INTEGER NOT NULL UNIQUE CHECK (source_sequence >= 1),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash)=64),
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 100),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 500),
  status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','active','superseded','rejected')),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT
);

CREATE TABLE IF NOT EXISTS pa_service_catalog_generation_pages (
  generation_id TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number BETWEEN 1 AND 100),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 50),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (generation_id,page_number),
  FOREIGN KEY (generation_id) REFERENCES pa_service_catalog_generations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pa_service_catalog_generation_items (
  generation_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  public_id TEXT NOT NULL CHECK (length(public_id) BETWEEN 1 AND 128),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  summary TEXT CHECK (summary IS NULL OR length(trim(summary)) BETWEEN 1 AND 1000),
  question_schema_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(question_schema_json)),
  PRIMARY KEY (generation_id,public_id),
  FOREIGN KEY (generation_id,page_number)
    REFERENCES pa_service_catalog_generation_pages(generation_id,page_number) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pa_catalog_generation_items_page
  ON pa_service_catalog_generation_items(generation_id,page_number,public_id);

CREATE TABLE IF NOT EXISTS pa_service_catalog_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  active_generation_id TEXT,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (active_generation_id) REFERENCES pa_service_catalog_generations(id)
);

INSERT OR IGNORE INTO pa_service_catalog_checkpoint
  (singleton,active_generation_id,source_generation,source_sequence)
VALUES (1,NULL,'legacy',0);

CREATE TABLE IF NOT EXISTS pa_service_catalog_entity_state (
  public_id TEXT PRIMARY KEY,
  source_version TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO pa_service_catalog_entity_state
  (public_id,source_version,source_sequence,active)
SELECT public_id,source_version,0,active FROM pa_service_catalog_items;

CREATE TABLE IF NOT EXISTS pa_service_catalog_projection_receipts (
  delivery_id TEXT PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 128),
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('snapshot_page','snapshot_activate','event')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
  status TEXT NOT NULL CHECK (status IN ('completed','ignored')),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pa_service_catalog_projection_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('snapshot_page_staged','snapshot_activated','event_upserted','event_tombstoned','delivery_replayed')),
  delivery_id TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pa_catalog_projection_audit_created
  ON pa_service_catalog_projection_audit(created_at DESC,id DESC);
