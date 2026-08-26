PRAGMA foreign_keys = ON;

-- Adopt the existing catalog as the primary source without changing any IDs,
-- timestamps, receipts or saved service snapshots. Public ingress remains
-- primary-only. Source provenance is not staff, workspace or service authority.
CREATE TABLE pa_service_catalog_items_source (
  source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
    CHECK (length(source_id) BETWEEN 15 AND 78 AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]' AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  public_id TEXT NOT NULL CHECK (length(public_id) BETWEEN 1 AND 128),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  summary TEXT CHECK (summary IS NULL OR length(trim(summary)) BETWEEN 1 AND 1000),
  question_schema_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(question_schema_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  source_updated_at TEXT NOT NULL,
  mirrored_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_generation TEXT,
  source_sequence INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Uncategorized' CHECK (length(trim(category)) BETWEEN 1 AND 100),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 1000000),
  geometry_requirement TEXT NOT NULL DEFAULT 'optional' CHECK (geometry_requirement IN ('none','optional','required')),
  PRIMARY KEY (source_id,public_id,source_version)
);
INSERT INTO pa_service_catalog_items_source
  (public_id,source_version,name,summary,question_schema_json,active,source_updated_at,mirrored_at,source_generation,source_sequence,category,display_order,geometry_requirement)
SELECT public_id,source_version,name,summary,question_schema_json,active,source_updated_at,mirrored_at,source_generation,source_sequence,category,display_order,geometry_requirement
FROM pa_service_catalog_items;

CREATE TABLE pa_service_catalog_generations_source (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
    CHECK (length(source_id) BETWEEN 15 AND 78 AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]' AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  source_generation TEXT NOT NULL CHECK (length(source_generation) BETWEEN 1 AND 128),
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash)=64),
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 100),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 500),
  status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','active','superseded','rejected')),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  UNIQUE (id,source_id),
  UNIQUE (source_id,source_generation),
  UNIQUE (source_id,source_sequence)
);
INSERT INTO pa_service_catalog_generations_source
  (id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete,created_at,activated_at)
SELECT id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete,created_at,activated_at
FROM pa_service_catalog_generations;

CREATE TABLE pa_service_catalog_generation_pages_source (
  generation_id TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT 'project-alpha:primary',
  page_number INTEGER NOT NULL CHECK (page_number BETWEEN 1 AND 100),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 50),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (generation_id,source_id,page_number),
  FOREIGN KEY (generation_id,source_id) REFERENCES pa_service_catalog_generations_source(id,source_id) ON DELETE CASCADE
);
INSERT INTO pa_service_catalog_generation_pages_source
  (generation_id,page_number,item_count,payload_hash,received_at)
SELECT generation_id,page_number,item_count,payload_hash,received_at FROM pa_service_catalog_generation_pages;

CREATE TABLE pa_service_catalog_generation_items_source (
  generation_id TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT 'project-alpha:primary',
  page_number INTEGER NOT NULL,
  public_id TEXT NOT NULL CHECK (length(public_id) BETWEEN 1 AND 128),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  summary TEXT CHECK (summary IS NULL OR length(trim(summary)) BETWEEN 1 AND 1000),
  question_schema_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(question_schema_json)),
  category TEXT NOT NULL DEFAULT 'Uncategorized' CHECK (length(trim(category)) BETWEEN 1 AND 100),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 1000000),
  geometry_requirement TEXT NOT NULL DEFAULT 'optional' CHECK (geometry_requirement IN ('none','optional','required')),
  PRIMARY KEY (generation_id,source_id,public_id),
  FOREIGN KEY (generation_id,source_id,page_number)
    REFERENCES pa_service_catalog_generation_pages_source(generation_id,source_id,page_number) ON DELETE CASCADE
);
INSERT INTO pa_service_catalog_generation_items_source
  (generation_id,page_number,public_id,source_version,name,summary,question_schema_json,category,display_order,geometry_requirement)
SELECT generation_id,page_number,public_id,source_version,name,summary,question_schema_json,category,display_order,geometry_requirement
FROM pa_service_catalog_generation_items;

CREATE TABLE pa_service_catalog_checkpoint_source (
  source_id TEXT PRIMARY KEY NOT NULL DEFAULT 'project-alpha:primary'
    CHECK (length(source_id) BETWEEN 15 AND 78 AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]' AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  active_generation_id TEXT,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (active_generation_id,source_id) REFERENCES pa_service_catalog_generations_source(id,source_id)
);
INSERT INTO pa_service_catalog_checkpoint_source
  (active_generation_id,source_generation,source_sequence,updated_at)
SELECT active_generation_id,source_generation,source_sequence,updated_at FROM pa_service_catalog_checkpoint;

CREATE TABLE pa_service_catalog_entity_state_source (
  source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
    CHECK (length(source_id) BETWEEN 15 AND 78 AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]' AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  public_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id,public_id)
);
INSERT INTO pa_service_catalog_entity_state_source (public_id,source_version,source_sequence,active,updated_at)
SELECT public_id,source_version,source_sequence,active,updated_at FROM pa_service_catalog_entity_state;

CREATE TABLE pa_service_catalog_projection_receipts_source (
  source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
    CHECK (length(source_id) BETWEEN 15 AND 78 AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]' AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 128),
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('snapshot_page','snapshot_activate','event')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
  source_sequence INTEGER NOT NULL CONSTRAINT catalog_delivery_write_guard CHECK (source_sequence >= 1),
  status TEXT NOT NULL CHECK (status IN ('completed','ignored')),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id,delivery_id)
);
INSERT INTO pa_service_catalog_projection_receipts_source
  (delivery_id,delivery_kind,payload_hash,source_sequence,status,received_at,processed_at)
SELECT delivery_id,delivery_kind,payload_hash,source_sequence,status,received_at,processed_at FROM pa_service_catalog_projection_receipts;

-- Drop children before their old parent. New children refer to the copied
-- parent; SQLite updates those references when it is renamed below.
DROP TABLE pa_service_catalog_generation_items;
DROP TABLE pa_service_catalog_generation_pages;
DROP TABLE pa_service_catalog_checkpoint;
DROP TABLE pa_service_catalog_generations;
DROP TABLE pa_service_catalog_items;
DROP TABLE pa_service_catalog_entity_state;
DROP TABLE pa_service_catalog_projection_receipts;
ALTER TABLE pa_service_catalog_generations_source RENAME TO pa_service_catalog_generations;
ALTER TABLE pa_service_catalog_generation_pages_source RENAME TO pa_service_catalog_generation_pages;
ALTER TABLE pa_service_catalog_generation_items_source RENAME TO pa_service_catalog_generation_items;
ALTER TABLE pa_service_catalog_checkpoint_source RENAME TO pa_service_catalog_checkpoint;
ALTER TABLE pa_service_catalog_items_source RENAME TO pa_service_catalog_items;
ALTER TABLE pa_service_catalog_entity_state_source RENAME TO pa_service_catalog_entity_state;
ALTER TABLE pa_service_catalog_projection_receipts_source RENAME TO pa_service_catalog_projection_receipts;
ALTER TABLE pa_service_catalog_projection_audit ADD COLUMN source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
  CHECK (length(source_id) BETWEEN 15 AND 78 AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]' AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*');

CREATE UNIQUE INDEX idx_pa_service_catalog_current ON pa_service_catalog_items(source_id,public_id) WHERE active=1;
CREATE INDEX idx_pa_service_catalog_active ON pa_service_catalog_items(source_id,active,name COLLATE NOCASE,public_id);
CREATE INDEX idx_pa_service_catalog_client_order ON pa_service_catalog_items(source_id,active,category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id);
CREATE INDEX idx_pa_catalog_generation_items_page ON pa_service_catalog_generation_items(source_id,generation_id,page_number,public_id);
DROP INDEX idx_pa_catalog_projection_audit_created;
CREATE INDEX idx_pa_catalog_projection_audit_created ON pa_service_catalog_projection_audit(source_id,created_at DESC,id DESC);

-- Existing request parents keep their local IDs and all grant/identity FKs.
-- The composite child FK prevents mixing catalog sources within one parent.
ALTER TABLE client_service_request_drafts ADD COLUMN catalog_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
  CHECK (length(catalog_source_id) BETWEEN 15 AND 78 AND substr(catalog_source_id,1,14)='project-alpha:' AND substr(catalog_source_id,15,1) GLOB '[a-z0-9]' AND substr(catalog_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
ALTER TABLE client_service_requests ADD COLUMN catalog_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
  CHECK (length(catalog_source_id) BETWEEN 15 AND 78 AND substr(catalog_source_id,1,14)='project-alpha:' AND substr(catalog_source_id,15,1) GLOB '[a-z0-9]' AND substr(catalog_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE UNIQUE INDEX idx_client_request_drafts_catalog_source ON client_service_request_drafts(id,catalog_source_id);
CREATE UNIQUE INDEX idx_client_requests_catalog_source ON client_service_requests(id,catalog_source_id);

CREATE TABLE client_service_request_draft_services_source (
  draft_id TEXT NOT NULL,
  service_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary',
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  service_public_id TEXT NOT NULL,
  service_source_version TEXT NOT NULL,
  service_snapshot_json TEXT NOT NULL CHECK (json_valid(service_snapshot_json)),
  answers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(answers_json)),
  PRIMARY KEY (draft_id,ordinal),
  UNIQUE (draft_id,service_public_id),
  FOREIGN KEY (draft_id,service_source_id) REFERENCES client_service_request_drafts(id,catalog_source_id) ON DELETE CASCADE
);
INSERT INTO client_service_request_draft_services_source
  (draft_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json)
SELECT draft_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json FROM client_service_request_draft_services;
DROP TABLE client_service_request_draft_services;
ALTER TABLE client_service_request_draft_services_source RENAME TO client_service_request_draft_services;

CREATE TABLE client_service_request_services_source (
  request_id TEXT NOT NULL,
  service_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary',
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  service_public_id TEXT NOT NULL,
  service_source_version TEXT NOT NULL,
  service_snapshot_json TEXT NOT NULL CHECK (json_valid(service_snapshot_json)),
  answers_json TEXT NOT NULL CHECK (json_valid(answers_json)),
  PRIMARY KEY (request_id,ordinal),
  UNIQUE (request_id,service_public_id),
  FOREIGN KEY (request_id,service_source_id) REFERENCES client_service_requests(id,catalog_source_id) ON DELETE CASCADE
);
INSERT INTO client_service_request_services_source
  (request_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json)
SELECT request_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json FROM client_service_request_services;
DROP TABLE client_service_request_services;
ALTER TABLE client_service_request_services_source RENAME TO client_service_request_services;

CREATE TRIGGER client_request_draft_catalog_source_immutable
BEFORE UPDATE OF catalog_source_id ON client_service_request_drafts
WHEN NEW.catalog_source_id IS NOT OLD.catalog_source_id
BEGIN
  SELECT RAISE(ABORT,'catalog source provenance is immutable');
END;
CREATE TRIGGER client_request_catalog_source_immutable
BEFORE UPDATE OF catalog_source_id ON client_service_requests
WHEN NEW.catalog_source_id IS NOT OLD.catalog_source_id
BEGIN
  SELECT RAISE(ABORT,'catalog source provenance is immutable');
END;
