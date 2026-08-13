PRAGMA foreign_keys = ON;

-- Sanitized, client-safe projection of Project Alpha's service library. The
-- source public id and version are preserved so submitted requests never rely
-- on a mutable display name or a database-local Project Alpha identifier.
CREATE TABLE IF NOT EXISTS pa_service_catalog_items (
  public_id TEXT NOT NULL CHECK (length(public_id) BETWEEN 1 AND 128),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  summary TEXT CHECK (summary IS NULL OR length(trim(summary)) BETWEEN 1 AND 1000),
  question_schema_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(question_schema_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  source_updated_at TEXT NOT NULL,
  mirrored_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (public_id,source_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_service_catalog_current
  ON pa_service_catalog_items(public_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_pa_service_catalog_active
  ON pa_service_catalog_items(active,name COLLATE NOCASE,public_id);

-- Drafts are private to the current account/project grant. draft_json contains
-- only the validated request fields; authoritative geometry measurements are
-- stored separately and can never be supplied by the browser.
CREATE TABLE IF NOT EXISTS client_service_request_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT,
  created_by_identity_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  area_geojson TEXT CHECK (area_geojson IS NULL OR json_valid(area_geojson)),
  area_square_meters REAL CHECK (area_square_meters IS NULL OR area_square_meters >= 0),
  area_acres REAL CHECK (area_acres IS NULL OR area_acres >= 0),
  create_idempotency_key TEXT NOT NULL CHECK (length(create_idempotency_key) BETWEEN 16 AND 128),
  create_fingerprint TEXT NOT NULL CHECK (length(create_fingerprint)=43),
  submitted_request_id TEXT,
  submit_idempotency_key TEXT,
  submit_fingerprint TEXT,
  last_mutation_key TEXT NOT NULL CHECK (length(last_mutation_key) BETWEEN 16 AND 128),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  UNIQUE (account_id,create_idempotency_key),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,project_id) REFERENCES client_project_grants(account_id,project_id),
  FOREIGN KEY (created_by_identity_id,account_id) REFERENCES client_identity_links(id,account_id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (submitted_request_id) REFERENCES client_service_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_client_request_drafts_account
  ON client_service_request_drafts(account_id,state,updated_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS client_service_request_draft_services (
  draft_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  service_public_id TEXT NOT NULL,
  service_source_version TEXT NOT NULL,
  service_snapshot_json TEXT NOT NULL CHECK (json_valid(service_snapshot_json)),
  answers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(answers_json)),
  PRIMARY KEY (draft_id,ordinal),
  UNIQUE (draft_id,service_public_id),
  FOREIGN KEY (draft_id) REFERENCES client_service_request_drafts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS client_service_request_draft_mutations (
  draft_id TEXT NOT NULL,
  mutation_key TEXT NOT NULL CHECK (length(mutation_key) BETWEEN 16 AND 128),
  mutation_fingerprint TEXT NOT NULL CHECK (length(mutation_fingerprint)=43),
  resulting_version INTEGER NOT NULL CHECK (resulting_version > 0),
  result_snapshot_json TEXT NOT NULL CHECK (json_valid(result_snapshot_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (draft_id,mutation_key),
  FOREIGN KEY (draft_id) REFERENCES client_service_request_drafts(id) ON DELETE CASCADE
);

-- Immutable service selections copied from the submitted draft. Operations can
-- continue reading the legacy request row while v2-aware consumers use these
-- exact Project Alpha service versions and validated answers.
CREATE TABLE IF NOT EXISTS client_service_request_services (
  request_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  service_public_id TEXT NOT NULL,
  service_source_version TEXT NOT NULL,
  service_snapshot_json TEXT NOT NULL CHECK (json_valid(service_snapshot_json)),
  answers_json TEXT NOT NULL CHECK (json_valid(answers_json)),
  PRIMARY KEY (request_id,ordinal),
  UNIQUE (request_id,service_public_id),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);
