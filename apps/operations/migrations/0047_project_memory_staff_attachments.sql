PRAGMA foreign_keys = ON;

-- Project-memory attachments are an Operations-only, append-only evidence
-- surface.  This migration deliberately does not widen project_file or client
-- delivery authority and does not rebuild any 0043 table.
CREATE TABLE project_memory_attachments (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind='staff_upload'),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 255 AND instr(display_name,char(0))=0),
  content_type TEXT NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp','image/gif','image/tiff','application/pdf')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
  object_key TEXT NOT NULL UNIQUE CHECK(object_key GLOB '_ltds/ProjectMemory/*/*' AND instr(object_key,char(0))=0),
  object_etag TEXT NOT NULL CHECK(length(object_etag) BETWEEN 1 AND 256 AND instr(object_etag,char(0))=0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  version_added INTEGER NOT NULL CHECK(version_added>0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(projection_source_id,project_id,version_added),
  UNIQUE(id,projection_source_id,project_id),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,root_record_kind,root_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,project_id)
    REFERENCES project_operational_memory(projection_source_id,project_id),
  FOREIGN KEY(created_by) REFERENCES staff_users(id)
);
CREATE INDEX idx_project_memory_attachments_project
ON project_memory_attachments(projection_source_id,project_id,created_at DESC,id DESC);

-- Attachment audit and mutation receipts are separate from the general 0043
-- tables so their schema cannot accidentally admit attachment events or object
-- provenance into an older consumer.
CREATE TABLE project_memory_attachment_events (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind='attachment_added'),
  result_version INTEGER NOT NULL CHECK(result_version>0),
  details_json TEXT NOT NULL CHECK(json_valid(details_json) AND length(details_json)<=500
    AND json_type(details_json)='object' AND json_extract(details_json,'$.schemaVersion')=1
    AND json_extract(details_json,'$.sourceKind')='staff_upload'
    AND json_type(details_json,'$.size')='integer' AND json_extract(details_json,'$.size') BETWEEN 1 AND 26214400
    AND json_remove(details_json,'$.schemaVersion','$.sourceKind','$.size')='{}'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(attachment_id,projection_source_id,project_id)
    REFERENCES project_memory_attachments(id,projection_source_id,project_id),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id)
);
CREATE INDEX idx_project_memory_attachment_events_project
ON project_memory_attachment_events(projection_source_id,project_id,created_at DESC,id DESC);

CREATE TABLE project_memory_attachment_mutations (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind='attachment_upload'),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK(result_version>0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=100
    AND json_type(result_json)='object' AND json_extract(result_json,'$.schemaVersion')=1
    AND json_remove(result_json,'$.schemaVersion')='{}'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id),
  FOREIGN KEY(attachment_id,projection_source_id,project_id)
    REFERENCES project_memory_attachments(id,projection_source_id,project_id),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id)
);

-- A durable intent exists before the first R2 write.  It owns the random key
-- and cleanup lease, allowing every ambiguous failure to be recovered without
-- deleting a possibly committed attachment.
CREATE TABLE project_memory_attachment_upload_intents (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE CHECK(object_key GLOB '_ltds/ProjectMemory/*/*' AND instr(object_key,char(0))=0),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 255 AND instr(display_name,char(0))=0),
  content_type TEXT NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp','image/gif','image/tiff','application/pdf')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  object_etag TEXT CHECK(object_etag IS NULL OR (length(object_etag) BETWEEN 1 AND 256 AND instr(object_etag,char(0))=0)),
  expected_context_version TEXT NOT NULL CHECK(length(expected_context_version)=43),
  expected_memory_version INTEGER NOT NULL CHECK(expected_memory_version>=0),
  amendment_reason TEXT CHECK(amendment_reason IS NULL OR (length(amendment_reason) BETWEEN 1 AND 1000 AND instr(amendment_reason,char(0))=0)),
  status TEXT NOT NULL CHECK(status IN ('prepared','object_written','completed','cleanup_pending','cleanup_complete','cleanup_failed')),
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_attempts BETWEEN 0 AND 8),
  cleanup_next_attempt_at TEXT,
  cleanup_claimed_at TEXT,
  cleanup_error_code TEXT CHECK(cleanup_error_code IS NULL OR length(cleanup_error_code)<=80),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  PRIMARY KEY(actor_id,idempotency_key),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,root_record_kind,root_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id)
);
CREATE INDEX idx_project_memory_attachment_cleanup
ON project_memory_attachment_upload_intents(status,cleanup_next_attempt_at,cleanup_claimed_at);

-- Attachment operations use their own one-shot counters.  The existing 0043
-- fence is still written for its memory-current and revision triggers, but no
-- column or CHECK on the 0043 table is widened or rebuilt.
CREATE TABLE project_memory_attachment_write_fences (
  projection_source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  expected_memory_version INTEGER NOT NULL CHECK(expected_memory_version>=0),
  incoming_size_bytes INTEGER NOT NULL CHECK(incoming_size_bytes BETWEEN 1 AND 26214400),
  memory_writes INTEGER NOT NULL CHECK(memory_writes BETWEEN 0 AND 1),
  revision_writes INTEGER NOT NULL CHECK(revision_writes BETWEEN 0 AND 1),
  attachment_writes INTEGER NOT NULL CHECK(attachment_writes BETWEEN 0 AND 1),
  event_writes INTEGER NOT NULL CHECK(event_writes BETWEEN 0 AND 1),
  mutation_writes INTEGER NOT NULL CHECK(mutation_writes BETWEEN 0 AND 1),
  intent_writes INTEGER NOT NULL CHECK(intent_writes BETWEEN 0 AND 1),
  write_guard INTEGER NOT NULL CONSTRAINT project_memory_attachment_current_context CHECK(write_guard=1),
  PRIMARY KEY(projection_source_id,project_id)
);

CREATE VIEW project_memory_attachment_live_write_fences AS
SELECT attachment_fence.* FROM project_memory_attachment_write_fences attachment_fence
JOIN project_operational_live_write_fences memory_fence
  ON memory_fence.projection_source_id=attachment_fence.projection_source_id
  AND memory_fence.project_id=attachment_fence.project_id
  AND memory_fence.actor_id=attachment_fence.actor_id
  AND memory_fence.permission_key='project.memory.manage'
  AND memory_fence.record_kind='memory'
  AND memory_fence.expected_version=attachment_fence.expected_memory_version
JOIN project_memory_attachment_upload_intents intent
  ON intent.actor_id=attachment_fence.actor_id
  AND intent.idempotency_key=attachment_fence.idempotency_key
  AND intent.projection_source_id=attachment_fence.projection_source_id
  AND intent.project_id=attachment_fence.project_id
  AND intent.attachment_id=attachment_fence.attachment_id
WHERE attachment_fence.write_guard=1
  AND intent.status='object_written'
  AND intent.cleanup_claimed_at IS NULL
  AND intent.size_bytes=attachment_fence.incoming_size_bytes
  AND intent.root_record_kind=attachment_fence.root_record_kind
  AND intent.root_id=attachment_fence.root_id
  AND (SELECT count(*) FROM project_memory_attachments item
       WHERE item.projection_source_id=attachment_fence.projection_source_id
         AND item.project_id=attachment_fence.project_id)
      + CASE WHEN EXISTS(SELECT 1 FROM project_memory_attachments item WHERE item.id=attachment_fence.attachment_id) THEN 0 ELSE 1 END <=100
  AND COALESCE((SELECT sum(item.size_bytes) FROM project_memory_attachments item
       WHERE item.projection_source_id=attachment_fence.projection_source_id
         AND item.project_id=attachment_fence.project_id),0)
      + CASE WHEN EXISTS(SELECT 1 FROM project_memory_attachments item WHERE item.id=attachment_fence.attachment_id)
        THEN 0 ELSE attachment_fence.incoming_size_bytes END <=536870912;

CREATE TRIGGER project_memory_attachment_fence_shape BEFORE INSERT ON project_memory_attachment_write_fences
WHEN NEW.memory_writes<>1 OR NEW.revision_writes<>1 OR NEW.attachment_writes<>1 OR NEW.event_writes<>1
  OR NEW.mutation_writes<>1 OR NEW.intent_writes<>1
  OR NOT EXISTS(SELECT 1 FROM project_operational_write_fences companion
    WHERE companion.projection_source_id=NEW.projection_source_id AND companion.project_id=NEW.project_id
      AND companion.actor_id=NEW.actor_id AND companion.permission_key='project.memory.manage' AND companion.record_kind='memory'
      AND companion.expected_version=NEW.expected_memory_version AND companion.current_writes=1
      AND companion.assignment_deletes=0 AND companion.assignment_inserts=0 AND companion.revision_writes=1
      AND companion.event_writes=0 AND companion.mutation_writes=0 AND companion.write_guard=1
      AND companion.root_record_kind=NEW.root_record_kind AND companion.root_id=NEW.root_id)
BEGIN SELECT RAISE(ABORT,'project memory attachment fence shape is invalid'); END;

CREATE TRIGGER project_memory_attachment_fence_transition BEFORE UPDATE ON project_memory_attachment_write_fences
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.actor_id IS NOT OLD.actor_id OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.attachment_id IS NOT OLD.attachment_id OR NEW.root_record_kind IS NOT OLD.root_record_kind
  OR NEW.root_id IS NOT OLD.root_id OR NEW.expected_memory_version IS NOT OLD.expected_memory_version
  OR NEW.incoming_size_bytes IS NOT OLD.incoming_size_bytes OR NEW.write_guard IS NOT OLD.write_guard
  OR NOT (
    (OLD.memory_writes=1 AND NEW.memory_writes=0 AND OLD.revision_writes=NEW.revision_writes
      AND OLD.attachment_writes=NEW.attachment_writes AND OLD.event_writes=NEW.event_writes
      AND OLD.mutation_writes=NEW.mutation_writes AND OLD.intent_writes=NEW.intent_writes
      AND EXISTS(SELECT 1 FROM project_operational_memory current WHERE current.projection_source_id=OLD.projection_source_id
        AND current.project_id=OLD.project_id AND current.version=OLD.expected_memory_version+1))
 OR (OLD.memory_writes=0 AND OLD.revision_writes=1 AND NEW.revision_writes=0
      AND NEW.memory_writes=0 AND OLD.attachment_writes=NEW.attachment_writes AND OLD.event_writes=NEW.event_writes
      AND OLD.mutation_writes=NEW.mutation_writes AND OLD.intent_writes=NEW.intent_writes
      AND EXISTS(SELECT 1 FROM project_operational_memory_revisions revision
        WHERE revision.projection_source_id=OLD.projection_source_id AND revision.project_id=OLD.project_id
          AND revision.version=OLD.expected_memory_version+1 AND revision.actor_id=OLD.actor_id))
 OR (OLD.memory_writes=0 AND OLD.revision_writes=0 AND OLD.attachment_writes=1 AND NEW.attachment_writes=0
      AND NEW.memory_writes=0 AND NEW.revision_writes=0 AND OLD.event_writes=NEW.event_writes
      AND OLD.mutation_writes=NEW.mutation_writes AND OLD.intent_writes=NEW.intent_writes
      AND EXISTS(SELECT 1 FROM project_memory_attachments attachment WHERE attachment.id=OLD.attachment_id
        AND attachment.projection_source_id=OLD.projection_source_id AND attachment.project_id=OLD.project_id
        AND attachment.version_added=OLD.expected_memory_version+1 AND attachment.created_by=OLD.actor_id))
 OR (OLD.memory_writes=0 AND OLD.revision_writes=0 AND OLD.attachment_writes=0 AND OLD.event_writes=1
      AND NEW.event_writes=0 AND NEW.memory_writes=0 AND NEW.revision_writes=0 AND NEW.attachment_writes=0
      AND OLD.mutation_writes=NEW.mutation_writes AND OLD.intent_writes=NEW.intent_writes
      AND EXISTS(SELECT 1 FROM project_memory_attachment_events event WHERE event.attachment_id=OLD.attachment_id
        AND event.projection_source_id=OLD.projection_source_id AND event.project_id=OLD.project_id
        AND event.result_version=OLD.expected_memory_version+1 AND event.actor_id=OLD.actor_id))
 OR (OLD.memory_writes=0 AND OLD.revision_writes=0 AND OLD.attachment_writes=0 AND OLD.event_writes=0
      AND OLD.mutation_writes=1 AND NEW.mutation_writes=0 AND NEW.memory_writes=0 AND NEW.revision_writes=0
      AND NEW.attachment_writes=0 AND NEW.event_writes=0 AND OLD.intent_writes=NEW.intent_writes
      AND EXISTS(SELECT 1 FROM project_memory_attachment_mutations mutation WHERE mutation.attachment_id=OLD.attachment_id
        AND mutation.projection_source_id=OLD.projection_source_id AND mutation.project_id=OLD.project_id
        AND mutation.result_version=OLD.expected_memory_version+1 AND mutation.actor_id=OLD.actor_id
        AND mutation.idempotency_key=OLD.idempotency_key))
 OR (OLD.memory_writes=0 AND OLD.revision_writes=0 AND OLD.attachment_writes=0 AND OLD.event_writes=0
      AND OLD.mutation_writes=0 AND OLD.intent_writes=1 AND NEW.intent_writes=0 AND NEW.memory_writes=0
      AND NEW.revision_writes=0 AND NEW.attachment_writes=0 AND NEW.event_writes=0 AND NEW.mutation_writes=0
      AND EXISTS(SELECT 1 FROM project_memory_attachment_upload_intents intent WHERE intent.actor_id=OLD.actor_id
        AND intent.idempotency_key=OLD.idempotency_key AND intent.attachment_id=OLD.attachment_id AND intent.status='completed')))
BEGIN SELECT RAISE(ABORT,'project memory attachment fence transition is invalid'); END;

CREATE TRIGGER project_memory_attachment_memory_insert_guard BEFORE INSERT ON project_operational_memory
WHEN EXISTS(SELECT 1 FROM project_memory_attachment_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id)
AND NOT EXISTS(SELECT 1 FROM project_memory_attachment_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.expected_memory_version=0 AND fence.memory_writes=1 AND fence.actor_id=NEW.created_by AND fence.actor_id=NEW.updated_by)
BEGIN SELECT RAISE(ABORT,'project memory attachment requires current context'); END;
CREATE TRIGGER project_memory_attachment_memory_insert_consume AFTER INSERT ON project_operational_memory
WHEN EXISTS(SELECT 1 FROM project_memory_attachment_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id)
BEGIN UPDATE project_memory_attachment_write_fences SET memory_writes=memory_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;

CREATE TRIGGER project_memory_attachment_memory_update_guard BEFORE UPDATE ON project_operational_memory
WHEN EXISTS(SELECT 1 FROM project_memory_attachment_write_fences fence WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id)
AND NOT EXISTS(SELECT 1 FROM project_memory_attachment_live_write_fences fence
  WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
    AND fence.expected_memory_version=OLD.version AND fence.memory_writes=1 AND fence.actor_id=NEW.updated_by)
BEGIN SELECT RAISE(ABORT,'project memory attachment requires current context'); END;
CREATE TRIGGER project_memory_attachment_memory_update_consume AFTER UPDATE ON project_operational_memory
WHEN EXISTS(SELECT 1 FROM project_memory_attachment_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id)
BEGIN UPDATE project_memory_attachment_write_fences SET memory_writes=memory_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;

CREATE TRIGGER project_memory_attachment_revision_guard BEFORE INSERT ON project_operational_memory_revisions
WHEN EXISTS(SELECT 1 FROM project_memory_attachment_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id)
AND NOT EXISTS(SELECT 1 FROM project_memory_attachment_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.memory_writes=0 AND fence.revision_writes=1 AND fence.actor_id=NEW.actor_id
    AND NEW.version=fence.expected_memory_version+1)
BEGIN SELECT RAISE(ABORT,'project memory attachment requires current context'); END;
CREATE TRIGGER project_memory_attachment_revision_consume AFTER INSERT ON project_operational_memory_revisions
WHEN EXISTS(SELECT 1 FROM project_memory_attachment_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id)
BEGIN UPDATE project_memory_attachment_write_fences SET revision_writes=revision_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;

CREATE TRIGGER project_memory_attachment_insert_guard BEFORE INSERT ON project_memory_attachments
WHEN NOT EXISTS(SELECT 1 FROM project_memory_attachment_live_write_fences fence
  JOIN project_memory_attachment_upload_intents intent
    ON intent.actor_id=fence.actor_id AND intent.idempotency_key=fence.idempotency_key
    AND intent.attachment_id=fence.attachment_id
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.memory_writes=0 AND fence.revision_writes=0 AND fence.attachment_writes=1
    AND fence.attachment_id=NEW.id AND fence.actor_id=NEW.created_by
    AND fence.root_record_kind=NEW.root_record_kind AND fence.root_id=NEW.root_id
    AND intent.projection_source_id=NEW.projection_source_id AND intent.project_id=NEW.project_id
    AND intent.root_record_kind=NEW.root_record_kind AND intent.root_id=NEW.root_id
    AND intent.status='object_written' AND intent.cleanup_claimed_at IS NULL
    AND intent.display_name=NEW.display_name AND intent.content_type=NEW.content_type
    AND intent.size_bytes=NEW.size_bytes AND intent.object_key=NEW.object_key
    AND intent.object_etag=NEW.object_etag AND intent.sha256=NEW.sha256 AND NEW.source_kind='staff_upload'
    AND NEW.version_added=fence.expected_memory_version+1
    AND EXISTS(SELECT 1 FROM project_operational_memory current WHERE current.projection_source_id=fence.projection_source_id
      AND current.project_id=fence.project_id AND current.version=NEW.version_added))
BEGIN SELECT RAISE(ABORT,'project memory attachment requires current context'); END;
CREATE TRIGGER project_memory_attachment_insert_consume AFTER INSERT ON project_memory_attachments
BEGIN UPDATE project_memory_attachment_write_fences SET attachment_writes=attachment_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;

CREATE TRIGGER project_memory_attachment_event_guard BEFORE INSERT ON project_memory_attachment_events
WHEN NOT EXISTS(SELECT 1 FROM project_memory_attachment_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.memory_writes=0 AND fence.revision_writes=0 AND fence.attachment_writes=0 AND fence.event_writes=1
    AND fence.attachment_id=NEW.attachment_id AND fence.actor_id=NEW.actor_id
    AND NEW.result_version=fence.expected_memory_version+1)
BEGIN SELECT RAISE(ABORT,'project memory attachment requires current context'); END;
CREATE TRIGGER project_memory_attachment_event_consume AFTER INSERT ON project_memory_attachment_events
BEGIN UPDATE project_memory_attachment_write_fences SET event_writes=event_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;

CREATE TRIGGER project_memory_attachment_mutation_guard BEFORE INSERT ON project_memory_attachment_mutations
WHEN NOT EXISTS(SELECT 1 FROM project_memory_attachment_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.memory_writes=0 AND fence.revision_writes=0 AND fence.attachment_writes=0 AND fence.event_writes=0
    AND fence.mutation_writes=1 AND fence.attachment_id=NEW.attachment_id AND fence.actor_id=NEW.actor_id
    AND fence.idempotency_key=NEW.idempotency_key AND NEW.result_version=fence.expected_memory_version+1)
BEGIN SELECT RAISE(ABORT,'project memory attachment requires current context'); END;
CREATE TRIGGER project_memory_attachment_mutation_consume AFTER INSERT ON project_memory_attachment_mutations
BEGIN UPDATE project_memory_attachment_write_fences SET mutation_writes=mutation_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;

CREATE TRIGGER project_memory_attachment_intent_complete_guard BEFORE UPDATE OF status ON project_memory_attachment_upload_intents
WHEN NEW.status='completed'
AND NOT EXISTS(SELECT 1 FROM project_memory_attachment_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.memory_writes=0 AND fence.revision_writes=0 AND fence.attachment_writes=0 AND fence.event_writes=0
    AND fence.mutation_writes=0 AND fence.intent_writes=1 AND fence.attachment_id=NEW.attachment_id
    AND fence.actor_id=NEW.actor_id AND fence.idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'project memory attachment requires current context'); END;
CREATE TRIGGER project_memory_attachment_intent_complete_consume AFTER UPDATE OF status ON project_memory_attachment_upload_intents
WHEN NEW.status='completed'
BEGIN UPDATE project_memory_attachment_write_fences SET intent_writes=intent_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;

CREATE TRIGGER project_memory_attachment_fence_exhausted BEFORE DELETE ON project_memory_attachment_write_fences
WHEN OLD.memory_writes<>0 OR OLD.revision_writes<>0 OR OLD.attachment_writes<>0 OR OLD.event_writes<>0
  OR OLD.mutation_writes<>0 OR OLD.intent_writes<>0
BEGIN SELECT RAISE(ABORT,'project memory attachment fence is not exhausted'); END;

-- Enforce exhaustion for every future deletion of an existing 0043 fence.  No
-- old row format or trigger is changed.
CREATE TRIGGER project_operational_fence_exhausted BEFORE DELETE ON project_operational_write_fences
WHEN OLD.current_writes<>0 OR OLD.assignment_deletes<>0 OR OLD.assignment_inserts<>0 OR OLD.revision_writes<>0
  OR OLD.event_writes<>0 OR OLD.mutation_writes<>0
BEGIN SELECT RAISE(ABORT,'project operational fence is not exhausted'); END;

CREATE TRIGGER project_memory_attachments_no_update BEFORE UPDATE ON project_memory_attachments
BEGIN SELECT RAISE(ABORT,'project memory attachments are immutable'); END;
CREATE TRIGGER project_memory_attachments_no_delete BEFORE DELETE ON project_memory_attachments
BEGIN SELECT RAISE(ABORT,'project memory attachments are immutable'); END;
CREATE TRIGGER project_memory_attachment_events_no_update BEFORE UPDATE ON project_memory_attachment_events
BEGIN SELECT RAISE(ABORT,'project memory attachment audit is immutable'); END;
CREATE TRIGGER project_memory_attachment_events_no_delete BEFORE DELETE ON project_memory_attachment_events
BEGIN SELECT RAISE(ABORT,'project memory attachment audit is immutable'); END;
CREATE TRIGGER project_memory_attachment_mutations_no_update BEFORE UPDATE ON project_memory_attachment_mutations
BEGIN SELECT RAISE(ABORT,'project memory attachment receipts are immutable'); END;
CREATE TRIGGER project_memory_attachment_mutations_no_delete BEFORE DELETE ON project_memory_attachment_mutations
BEGIN SELECT RAISE(ABORT,'project memory attachment receipts are immutable'); END;

CREATE TRIGGER project_memory_attachment_intent_identity BEFORE UPDATE ON project_memory_attachment_upload_intents
WHEN NEW.actor_id IS NOT OLD.actor_id OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint OR NEW.projection_source_id IS NOT OLD.projection_source_id
  OR NEW.project_record_kind IS NOT OLD.project_record_kind OR NEW.project_id IS NOT OLD.project_id
  OR NEW.root_record_kind IS NOT OLD.root_record_kind OR NEW.root_id IS NOT OLD.root_id
  OR NEW.attachment_id IS NOT OLD.attachment_id OR NEW.object_key IS NOT OLD.object_key
  OR NEW.display_name IS NOT OLD.display_name OR NEW.content_type IS NOT OLD.content_type
  OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.expected_context_version IS NOT OLD.expected_context_version
  OR NEW.expected_memory_version IS NOT OLD.expected_memory_version
  OR NEW.amendment_reason IS NOT OLD.amendment_reason OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'project memory attachment intent identity is immutable'); END;

CREATE TRIGGER project_memory_attachment_intent_insert_shape BEFORE INSERT ON project_memory_attachment_upload_intents
WHEN NEW.status<>'prepared' OR NEW.object_etag IS NOT NULL OR NEW.cleanup_attempts<>0
  OR NEW.cleanup_next_attempt_at IS NOT NULL OR NEW.cleanup_claimed_at IS NOT NULL
  OR NEW.cleanup_error_code IS NOT NULL OR NEW.completed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'project memory attachment intent must start prepared'); END;

CREATE TRIGGER project_memory_attachment_intent_transition BEFORE UPDATE ON project_memory_attachment_upload_intents
WHEN NOT (
    (OLD.status='prepared' AND NEW.status IN ('prepared','object_written','cleanup_pending'))
 OR (OLD.status='object_written' AND NEW.status IN ('object_written','completed','cleanup_pending'))
 OR (OLD.status='cleanup_pending' AND NEW.status IN ('cleanup_pending','object_written','cleanup_complete','cleanup_failed'))
 OR (OLD.status='completed' AND NEW.status='completed')
 OR (OLD.status='cleanup_complete' AND NEW.status='cleanup_complete')
 OR (OLD.status='cleanup_failed' AND NEW.status='cleanup_failed'))
 OR (OLD.object_etag IS NOT NULL AND NEW.object_etag IS NOT OLD.object_etag)
 OR (NEW.status IN ('object_written','completed') AND NEW.object_etag IS NULL)
 OR (NEW.status='completed' AND NEW.completed_at IS NULL)
 OR (NEW.status<>'completed' AND NEW.completed_at IS NOT NULL)
 OR NEW.cleanup_attempts<OLD.cleanup_attempts OR NEW.cleanup_attempts>OLD.cleanup_attempts+1
 OR (NEW.cleanup_claimed_at IS NOT NULL AND NEW.status<>'cleanup_pending')
BEGIN SELECT RAISE(ABORT,'project memory attachment intent transition is invalid'); END;

PRAGMA foreign_keys = ON;
