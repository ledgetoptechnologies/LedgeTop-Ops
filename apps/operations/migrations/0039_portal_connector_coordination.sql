-- A durable administration barrier, not a lease or permission grant. It orders
-- portal-purpose changes in DELIVERY_DB with source changes in OPS_DB. A crash
-- leaves recovery visible; elapsed time never re-enables client access.
CREATE TABLE pa_connector_portal_coordination (
  id TEXT PRIMARY KEY NOT NULL CHECK(id='portal'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  token TEXT,
  source_id TEXT,
  action TEXT CHECK(action IN ('prepare','activate','suspend','state','revision','recover')),
  actor_id TEXT,
  started_at TEXT,
  CHECK((token IS NULL AND source_id IS NULL AND action IS NULL AND actor_id IS NULL AND started_at IS NULL)
    OR (length(token) BETWEEN 1 AND 128 AND source_id IS NOT NULL AND action IS NOT NULL
      AND actor_id IS NOT NULL AND started_at IS NOT NULL)),
  FOREIGN KEY(source_id) REFERENCES pa_connectors(source_id)
);
INSERT INTO pa_connector_portal_coordination(id) VALUES('portal');

CREATE TABLE pa_connector_portal_coordination_audit (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('prepare','activate','suspend','state','revision','recover')),
  phase TEXT NOT NULL CHECK(phase IN ('started','completed')),
  actor_id TEXT NOT NULL,
  coordination_version INTEGER NOT NULL CHECK(coordination_version>0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(source_id) REFERENCES pa_connectors(source_id)
);

CREATE TABLE pa_connector_portal_coordination_fences (
  id TEXT PRIMARY KEY NOT NULL CHECK(id='portal'),
  write_guard INTEGER NOT NULL CONSTRAINT pa_connector_portal_coordination_guard CHECK(write_guard=1)
);

-- Permanent enrollment marker prevents an older/mixed Operations deployment
-- from bypassing Delivery-first suspension after portal purposes are enabled.
CREATE TABLE pa_connector_portal_sources (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES pa_connectors(source_id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE pa_connector_portal_write_permits (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES pa_connectors(source_id),
  expected_version INTEGER NOT NULL CHECK(expected_version>0),
  token TEXT NOT NULL,
  write_guard INTEGER NOT NULL CONSTRAINT pa_connector_portal_permit_guard CHECK(write_guard=1)
);
CREATE TRIGGER pa_connector_portal_source_change BEFORE UPDATE ON pa_connectors
WHEN (OLD.state IS NOT NEW.state OR OLD.active_revision IS NOT NEW.active_revision)
  AND (EXISTS(SELECT 1 FROM pa_connector_portal_sources WHERE source_id=OLD.source_id)
    OR (OLD.source_id='project-alpha:primary' AND EXISTS(SELECT 1 FROM pa_connector_portal_sources)))
  AND NOT EXISTS(SELECT 1 FROM pa_connector_portal_write_permits permit
    JOIN pa_connector_portal_coordination coordination ON coordination.id='portal'
      AND coordination.token=permit.token AND coordination.source_id=permit.source_id
      AND coordination.action IN ('state','revision')
    WHERE permit.source_id=OLD.source_id AND permit.expected_version=OLD.version AND permit.write_guard=1)
BEGIN SELECT RAISE(ABORT,'portal source changes require coordinated administration'); END;
CREATE TRIGGER pa_connector_portal_source_consume_permit AFTER UPDATE ON pa_connectors
BEGIN DELETE FROM pa_connector_portal_write_permits WHERE source_id=NEW.source_id; END;
CREATE TRIGGER pa_connector_portal_sources_no_update BEFORE UPDATE ON pa_connector_portal_sources
BEGIN SELECT RAISE(ABORT,'portal source enrollment is immutable'); END;
CREATE TRIGGER pa_connector_portal_sources_no_delete BEFORE DELETE ON pa_connector_portal_sources
BEGIN SELECT RAISE(ABORT,'portal source enrollment is persistent'); END;

CREATE TRIGGER pa_connector_portal_coordination_version BEFORE UPDATE ON pa_connector_portal_coordination
WHEN NEW.id IS NOT OLD.id OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'portal coordination version conflicts'); END;
CREATE TRIGGER pa_connector_portal_coordination_no_delete BEFORE DELETE ON pa_connector_portal_coordination
BEGIN SELECT RAISE(ABORT,'portal coordination is persistent'); END;
CREATE TRIGGER pa_connector_portal_coordination_audit_no_update BEFORE UPDATE ON pa_connector_portal_coordination_audit
BEGIN SELECT RAISE(ABORT,'portal coordination audit is immutable'); END;
CREATE TRIGGER pa_connector_portal_coordination_audit_no_delete BEFORE DELETE ON pa_connector_portal_coordination_audit
BEGIN SELECT RAISE(ABORT,'portal coordination audit is persistent'); END;
