PRAGMA foreign_keys = ON;

-- Dormant registry for the future Operations -> Client service binding.
-- Rows are provisioned explicitly by operators; ingress never enrolls sources.
CREATE TABLE ops_inventory_catalog_staging_sources (
  source_id TEXT PRIMARY KEY NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch TEXT NOT NULL,
  authority_kind TEXT NOT NULL DEFAULT 'operations-worker'
    CHECK(authority_kind='operations-worker'),
  state TEXT NOT NULL DEFAULT 'disabled' CHECK(state IN ('disabled','staging')),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(source_instance_id,application_id,history_epoch)
);

CREATE TABLE ops_inventory_catalog_staging_pages (
  source_id TEXT NOT NULL REFERENCES ops_inventory_catalog_staging_sources(source_id) ON DELETE RESTRICT,
  snapshot_id TEXT NOT NULL,
  page_index INTEGER NOT NULL CHECK(page_index BETWEEN 0 AND 100000),
  request_id TEXT NOT NULL,
  total_count INTEGER NOT NULL CHECK(total_count BETWEEN 0 AND 1000000),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 200),
  next_cursor TEXT,
  receipt_hash TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(source_id,snapshot_id,page_index),
  UNIQUE(source_id,request_id)
);

CREATE TABLE ops_inventory_catalog_staging_items (
  source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  content_version TEXT NOT NULL,
  item_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(source_id,snapshot_id,public_id),
  FOREIGN KEY(source_id,snapshot_id,page_index)
    REFERENCES ops_inventory_catalog_staging_pages(source_id,snapshot_id,page_index) ON DELETE CASCADE
);

CREATE INDEX idx_ops_inventory_catalog_staging_items_page
  ON ops_inventory_catalog_staging_items(source_id,snapshot_id,page_index,public_id);
