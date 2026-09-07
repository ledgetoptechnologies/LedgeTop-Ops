-- Delivery-side commit fence for the existing primary Project Alpha connector.
-- The legacy scalar connection remains live until an explicitly coordinated
-- registry activation advances this row. Connector transitions update this
-- mirror before OPS_DB so interrupted work always fails closed.
CREATE TABLE pa_primary_delivery_authority (
  source_id TEXT PRIMARY KEY NOT NULL CHECK(source_id='project-alpha:primary'),
  mode TEXT NOT NULL CHECK(mode IN ('legacy_primary','registry')),
  connector_revision INTEGER NOT NULL CHECK(connector_revision>=0),
  connector_version INTEGER NOT NULL CHECK(connector_version>=0),
  state TEXT NOT NULL CHECK(state IN ('active','suspended')),
  authority_version INTEGER NOT NULL DEFAULT 1 CHECK(authority_version>0),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  CHECK((mode='legacy_primary' AND connector_revision=0 AND connector_version=0)
    OR (mode='registry' AND connector_revision>0 AND connector_version>0))
);
INSERT INTO pa_primary_delivery_authority
  (source_id,mode,connector_revision,connector_version,state)
VALUES('project-alpha:primary','legacy_primary',0,0,'active');

CREATE TABLE pa_primary_delivery_authority_write_fences (
  source_id TEXT PRIMARY KEY NOT NULL CHECK(source_id='project-alpha:primary'),
  write_guard INTEGER NOT NULL CONSTRAINT pa_primary_delivery_authority_write_guard CHECK(write_guard=1)
);

CREATE TRIGGER pa_primary_delivery_authority_identity_guard BEFORE UPDATE ON pa_primary_delivery_authority
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.authority_version<>OLD.authority_version+1
BEGIN SELECT RAISE(ABORT,'primary-delivery-authority-changed'); END;
CREATE TRIGGER pa_primary_delivery_authority_no_delete BEFORE DELETE ON pa_primary_delivery_authority
BEGIN SELECT RAISE(ABORT,'primary-delivery-authority-immutable'); END;
