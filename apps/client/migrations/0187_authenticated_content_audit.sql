PRAGMA foreign_keys = ON;

-- Collection begins only after the producer flag and this schema are both
-- available. The singleton is immutable so timeline consumers can distinguish
-- genuine absence from the period before content-read collection existed.
CREATE TABLE IF NOT EXISTS portal_authenticated_content_history_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  collection_started_at TEXT
    CHECK (collection_started_at IS NULL OR (length(collection_started_at) = 24
      AND substr(collection_started_at,11,1) = 'T'
      AND substr(collection_started_at,24,1) = 'Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ',collection_started_at) = collection_started_at))
);

INSERT OR IGNORE INTO portal_authenticated_content_history_state(singleton) VALUES (1);

CREATE TRIGGER IF NOT EXISTS portal_authenticated_content_history_state_immutable_update
BEFORE UPDATE ON portal_authenticated_content_history_state
WHEN OLD.schema_version <> NEW.schema_version
  OR OLD.collection_started_at IS NOT NULL
  OR NEW.collection_started_at IS NULL
  OR length(NEW.collection_started_at) <> 24
  OR substr(NEW.collection_started_at,11,1) <> 'T'
  OR substr(NEW.collection_started_at,24,1) <> 'Z'
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.collection_started_at) <> NEW.collection_started_at
BEGIN
  SELECT RAISE(ABORT, 'authenticated content history state is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_authenticated_content_history_state_immutable_delete
BEFORE DELETE ON portal_authenticated_content_history_state
BEGIN
  SELECT RAISE(ABORT, 'authenticated content history state is immutable');
END;

CREATE TABLE IF NOT EXISTS portal_authenticated_content_events (
  recorded_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) = 43),
  dedupe_window INTEGER NOT NULL CHECK (dedupe_window >= 0),
  authority_mode TEXT NOT NULL CHECK (authority_mode IN ('legacy_delivery','native_delivery')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 180),
  workspace_id TEXT CHECK (workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 180),
  account_id TEXT CHECK (account_id IS NULL OR length(account_id) BETWEEN 1 AND 180),
  identity_id TEXT NOT NULL CHECK (length(identity_id) BETWEEN 1 AND 180),
  project_id TEXT CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 180),
  project_public_id TEXT CHECK (project_public_id IS NULL OR length(project_public_id) BETWEEN 1 AND 180),
  association_id TEXT CHECK (association_id IS NULL OR length(association_id) BETWEEN 1 AND 180),
  folder_binding_id TEXT CHECK (folder_binding_id IS NULL OR length(folder_binding_id) BETWEEN 1 AND 180),
  grant_id TEXT CHECK (grant_id IS NULL OR length(grant_id) BETWEEN 1 AND 180),
  action TEXT NOT NULL CHECK (action IN ('file.preview_requested','file.download_requested')),
  resource_fingerprint TEXT NOT NULL CHECK (length(resource_fingerprint) = 43),
  content_version_fingerprint TEXT NOT NULL CHECK (length(content_version_fingerprint) = 43),
  resource_label TEXT NOT NULL CHECK (length(resource_label) BETWEEN 1 AND 180),
  occurred_at TEXT NOT NULL
    CHECK (length(occurred_at) = 24
      AND substr(occurred_at,11,1) = 'T'
      AND substr(occurred_at,24,1) = 'Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) = occurred_at),
  CHECK (
    (authority_mode = 'legacy_delivery'
      AND account_id IS NOT NULL
      AND association_id IS NOT NULL
      AND folder_binding_id IS NULL
      AND grant_id IS NULL
      AND project_public_id IS NULL)
    OR
    (authority_mode = 'native_delivery'
      AND workspace_id IS NOT NULL
      AND folder_binding_id IS NOT NULL
      AND grant_id IS NOT NULL
      AND account_id IS NULL
      AND project_id IS NULL
      AND association_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_portal_authenticated_content_legacy_timeline
  ON portal_authenticated_content_events(account_id,project_id,occurred_at DESC,recorded_sequence DESC);

CREATE INDEX IF NOT EXISTS idx_portal_authenticated_content_native_timeline
  ON portal_authenticated_content_events(source_id,workspace_id,project_public_id,occurred_at DESC,recorded_sequence DESC);

CREATE TABLE IF NOT EXISTS portal_authenticated_content_retention_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  delete_enabled INTEGER NOT NULL DEFAULT 0 CHECK (delete_enabled IN (0,1)),
  delete_before TEXT
    CHECK (delete_before IS NULL OR (length(delete_before) = 24
      AND substr(delete_before,11,1) = 'T'
      AND substr(delete_before,24,1) = 'Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ',delete_before) = delete_before)),
  CHECK ((delete_enabled = 0 AND delete_before IS NULL)
    OR (delete_enabled = 1 AND delete_before IS NOT NULL))
);

INSERT OR IGNORE INTO portal_authenticated_content_retention_control(singleton,delete_enabled,delete_before)
  VALUES (1,0,NULL);

CREATE TRIGGER IF NOT EXISTS portal_authenticated_content_events_immutable_update
BEFORE UPDATE ON portal_authenticated_content_events
BEGIN
  SELECT RAISE(ABORT, 'authenticated content event is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_authenticated_content_events_retention_delete_guard
BEFORE DELETE ON portal_authenticated_content_events
WHEN COALESCE((SELECT delete_enabled FROM portal_authenticated_content_retention_control WHERE singleton=1),0) <> 1
  OR (SELECT delete_before FROM portal_authenticated_content_retention_control WHERE singleton=1) IS NULL
  OR datetime(OLD.occurred_at) >= datetime((SELECT delete_before
    FROM portal_authenticated_content_retention_control WHERE singleton=1))
BEGIN
  SELECT RAISE(ABORT, 'authenticated content event deletion requires an expired retention cutoff');
END;
