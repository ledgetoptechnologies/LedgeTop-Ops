PRAGMA foreign_keys = ON;

-- Consumer-first support for explicit Project Alpha deletion events. This
-- table is evidence, not a directory snapshot: absence and active=0 remain
-- reversible source state and never create a tombstone.
CREATE TABLE pa_projection_tombstones (
  projection_source_id TEXT NOT NULL CHECK (
    length(projection_source_id) BETWEEN 15 AND 78
    AND substr(projection_source_id,1,14)='project-alpha:'
    AND substr(projection_source_id,15,1) GLOB '[a-z0-9]'
    AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'
  ),
  event_id TEXT NOT NULL CHECK (
    length(event_id)=36 AND event_id NOT GLOB '*[^0-9a-f-]*'
  ),
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'client','organization','project','project_assignment','business_unit',
    'operation','operation_assignment','task','task_assignment'
  )),
  entity_id TEXT NOT NULL CHECK (
    length(entity_id) BETWEEN 1 AND 128
    AND instr(entity_id,char(0))=0
  ),
  source_updated_at TEXT NOT NULL CHECK (
    length(source_updated_at) BETWEEN 20 AND 35
    AND instr(source_updated_at,char(0))=0
  ),
  occurred_at TEXT NOT NULL CHECK (
    length(occurred_at) BETWEEN 20 AND 35
    AND instr(occurred_at,char(0))=0
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(projection_source_id,event_id),
  UNIQUE(projection_source_id,entity_type,entity_id,source_updated_at)
);
CREATE INDEX idx_pa_projection_tombstones_entity
  ON pa_projection_tombstones(projection_source_id,entity_type,entity_id,source_updated_at DESC);

-- Tombstone evidence is append-only. It intentionally contains no source
-- payload, display name, email, phone, address, or other PII.
CREATE TRIGGER pa_projection_tombstone_no_update
BEFORE UPDATE ON pa_projection_tombstones
BEGIN SELECT RAISE(ABORT,'project alpha tombstone evidence is immutable'); END;

CREATE TRIGGER pa_projection_tombstone_no_delete
BEFORE DELETE ON pa_projection_tombstones
BEGIN SELECT RAISE(ABORT,'project alpha tombstone evidence is persistent'); END;
