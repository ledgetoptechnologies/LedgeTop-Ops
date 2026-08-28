PRAGMA foreign_keys = ON;

-- Staff project creation stays authoritative in each Project Alpha source.
-- This registry stores only a reviewed navigation target; it is not a grant,
-- credential, snapshot destination, or local Operations project producer.
CREATE TABLE pa_connector_project_management_routes (
  source_id TEXT PRIMARY KEY NOT NULL,
  active_revision INTEGER NOT NULL DEFAULT 1 CHECK(active_revision>0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(source_id) REFERENCES pa_connectors(source_id),
  FOREIGN KEY(source_id,active_revision)
    REFERENCES pa_connector_project_management_route_revisions(source_id,revision)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE pa_connector_project_management_route_revisions (
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  reviewed_url_template TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(source_id,revision),
  CHECK((enabled=1 AND reviewed_url_template IS NOT NULL)
    OR (enabled=0 AND reviewed_url_template IS NULL)),
  CHECK(reviewed_url_template IS NULL OR length(reviewed_url_template) BETWEEN 9 AND 2048),
  FOREIGN KEY(source_id) REFERENCES pa_connectors(source_id)
);

CREATE TABLE pa_connector_project_management_route_audit (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('configured','disabled')),
  route_version INTEGER NOT NULL CHECK(route_version>0),
  route_revision INTEGER NOT NULL CHECK(route_revision>0),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(source_id,route_revision)
    REFERENCES pa_connector_project_management_route_revisions(source_id,revision)
);
CREATE INDEX idx_pa_connector_project_management_audit
  ON pa_connector_project_management_route_audit(source_id,route_version,id);

-- Operation keys are actor-scoped and globally single-use so accidentally
-- reusing a key for another source cannot silently mutate that source.
CREATE TABLE pa_connector_project_management_route_mutations (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  source_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  result_version INTEGER NOT NULL CHECK(result_version>0),
  result_revision INTEGER NOT NULL CHECK(result_revision>0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key),
  FOREIGN KEY(source_id,result_revision)
    REFERENCES pa_connector_project_management_route_revisions(source_id,revision)
);

-- A failed current-state proof aborts the whole D1 batch via this CHECK.
CREATE TABLE pa_connector_project_management_route_write_fences (
  source_id TEXT PRIMARY KEY NOT NULL,
  write_guard INTEGER NOT NULL CONSTRAINT pa_project_management_route_guard CHECK(write_guard=1)
);

CREATE TRIGGER pa_project_management_route_insert_guard BEFORE INSERT
ON pa_connector_project_management_routes
WHEN NEW.version<>1 OR NEW.active_revision<>1
  OR NOT EXISTS(SELECT 1 FROM pa_connectors connector
    WHERE connector.source_id=NEW.source_id AND connector.state='active' AND connector.read_visible=1)
  OR EXISTS(SELECT 1 FROM pa_connector_project_management_routes route WHERE route.source_id=NEW.source_id)
BEGIN SELECT RAISE(ABORT,'project management route registration conflicts'); END;

CREATE TRIGGER pa_project_management_route_update_guard BEFORE UPDATE
ON pa_connector_project_management_routes
WHEN OLD.source_id IS NOT NEW.source_id OR OLD.created_at IS NOT NEW.created_at
  OR NEW.version<>OLD.version+1 OR NEW.active_revision<>OLD.active_revision+1
  OR NOT EXISTS(SELECT 1 FROM pa_connector_project_management_route_revisions revision
    WHERE revision.source_id=NEW.source_id AND revision.revision=NEW.active_revision)
BEGIN SELECT RAISE(ABORT,'project management route revision conflicts'); END;

CREATE TRIGGER pa_project_management_route_no_delete BEFORE DELETE
ON pa_connector_project_management_routes
BEGIN SELECT RAISE(ABORT,'project management route ownership is persistent'); END;

CREATE TRIGGER pa_project_management_revision_insert_guard BEFORE INSERT
ON pa_connector_project_management_route_revisions
WHEN NEW.revision<>(SELECT COALESCE(max(revision),0)+1
    FROM pa_connector_project_management_route_revisions WHERE source_id=NEW.source_id)
  OR NOT EXISTS(SELECT 1 FROM pa_connectors connector WHERE connector.source_id=NEW.source_id)
BEGIN SELECT RAISE(ABORT,'project management route revision conflicts'); END;

CREATE TRIGGER pa_project_management_revision_no_update BEFORE UPDATE
ON pa_connector_project_management_route_revisions
BEGIN SELECT RAISE(ABORT,'project management route revisions are immutable'); END;
CREATE TRIGGER pa_project_management_revision_no_delete BEFORE DELETE
ON pa_connector_project_management_route_revisions
BEGIN SELECT RAISE(ABORT,'project management route revisions are persistent'); END;

CREATE TRIGGER pa_project_management_audit_no_update BEFORE UPDATE
ON pa_connector_project_management_route_audit
BEGIN SELECT RAISE(ABORT,'project management route audit is immutable'); END;
CREATE TRIGGER pa_project_management_audit_no_delete BEFORE DELETE
ON pa_connector_project_management_route_audit
BEGIN SELECT RAISE(ABORT,'project management route audit is persistent'); END;
CREATE TRIGGER pa_project_management_mutation_no_update BEFORE UPDATE
ON pa_connector_project_management_route_mutations
BEGIN SELECT RAISE(ABORT,'project management route receipts are immutable'); END;
CREATE TRIGGER pa_project_management_mutation_no_delete BEFORE DELETE
ON pa_connector_project_management_route_mutations
BEGIN SELECT RAISE(ABORT,'project management route receipts are persistent'); END;
