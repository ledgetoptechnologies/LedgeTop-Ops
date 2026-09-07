PRAGMA foreign_keys = ON;

-- Private Operations notes attached to one source-qualified business project.
-- These records are deliberately separate from client-root notes and never
-- project back to Project Alpha or grant external access.
CREATE TABLE project_internal_notes (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK(length(body)<=12000),
  created_by TEXT NOT NULL REFERENCES staff_users(id),
  updated_by TEXT NOT NULL REFERENCES staff_users(id),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX project_internal_notes_scope ON project_internal_notes(source_id,root_kind,root_id,project_id,deleted_at,updated_at DESC,id);

CREATE TABLE project_internal_note_revisions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES project_internal_notes(id),
  source_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  action TEXT NOT NULL CHECK(action IN ('created','updated','deleted')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK(length(body)<=12000),
  actor_id TEXT NOT NULL REFERENCES staff_users(id),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(note_id,version)
);
CREATE INDEX project_internal_note_revision_scope ON project_internal_note_revisions(source_id,root_kind,root_id,project_id,note_id,version DESC);

CREATE TABLE project_internal_note_mutations (
  actor_id TEXT NOT NULL REFERENCES staff_users(id),
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('create','update','delete')),
  request_fingerprint TEXT NOT NULL,
  source_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES project_internal_notes(id),
  result_version INTEGER NOT NULL CHECK(result_version>0),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key)
);

-- Every write begins by recording the source/root/project snapshot that was
-- just proven by the Worker.  The first INSERT has a CHECK-backed live guard;
-- the protected note, revision, and receipt writes then consume it in order.
-- This closes the read-before-write window if a sync reassigns or deactivates
-- the root/project after request validation but before the D1 batch commits.
CREATE TABLE project_internal_note_write_fences (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('create','update','delete')),
  project_client_id TEXT,
  project_organization_id TEXT,
  project_status TEXT,
  project_last_sync_id TEXT NOT NULL,
  root_last_sync_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  note_writes INTEGER NOT NULL CHECK(note_writes BETWEEN 0 AND 1),
  revision_writes INTEGER NOT NULL CHECK(revision_writes BETWEEN 0 AND 1),
  mutation_writes INTEGER NOT NULL CHECK(mutation_writes BETWEEN 0 AND 1),
  write_guard INTEGER NOT NULL CONSTRAINT project_internal_note_current_context CHECK(write_guard=1),
  PRIMARY KEY(actor_id,idempotency_key)
);

CREATE VIEW project_internal_note_live_write_fences AS
SELECT fence.* FROM project_internal_note_write_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id AND actor.status='active'
JOIN pa_projects project ON project.id=fence.project_id AND project.projection_source_id=fence.source_id
  AND project.active=1 AND project.client_id IS fence.project_client_id
  AND project.organization_id IS fence.project_organization_id AND project.status IS fence.project_status
  AND project.last_sync_id=fence.project_last_sync_id
LEFT JOIN pa_clients owner ON owner.id=project.client_id AND owner.projection_source_id=project.projection_source_id AND owner.active=1
LEFT JOIN pa_organizations organization_root ON fence.root_kind='organization'
  AND organization_root.id=fence.root_id AND organization_root.projection_source_id=fence.source_id
  AND organization_root.active=1 AND organization_root.last_sync_id=fence.root_last_sync_id
LEFT JOIN pa_clients client_root ON fence.root_kind='standalone_client'
  AND client_root.id=fence.root_id AND client_root.projection_source_id=fence.source_id
  AND client_root.active=1 AND client_root.organization_id IS NULL AND client_root.last_sync_id=fence.root_last_sync_id
WHERE fence.write_guard=1
  AND ((fence.source_id='project-alpha:primary' AND NOT EXISTS(
    SELECT 1 FROM pa_connectors primary_connector WHERE primary_connector.source_id='project-alpha:primary'))
    OR EXISTS(SELECT 1 FROM pa_connectors visible_connector
      WHERE visible_connector.source_id=fence.source_id AND visible_connector.read_visible=1))
  AND ((fence.root_kind='organization' AND organization_root.id IS NOT NULL
      AND (project.organization_id=fence.root_id OR (project.organization_id IS NULL AND owner.organization_id=fence.root_id)))
    OR (fence.root_kind='standalone_client' AND client_root.id IS NOT NULL AND project.client_id=fence.root_id
      AND project.organization_id IS NULL AND owner.id IS NOT NULL AND owner.organization_id IS NULL))
  AND NOT EXISTS(SELECT 1 FROM (SELECT 'team.view' permission_key UNION ALL SELECT 'projects.view' UNION ALL SELECT 'client.notes.manage') required
    WHERE NOT EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key=required.permission_key)
      AND NOT EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key=required.permission_key)
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id AND permission.scope='global'
        AND permission.permission_key=required.permission_key AND permission.effect='allow')
      OR EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id AND permission.scope='global'
        AND permission.permission_key=required.permission_key AND permission.effect='deny'))
  AND ((fence.operation_kind='create' AND (NOT EXISTS(SELECT 1 FROM project_internal_notes note WHERE note.id=fence.note_id)
      OR EXISTS(SELECT 1 FROM project_internal_notes note WHERE note.id=fence.note_id AND note.source_id=fence.source_id
        AND note.root_kind=fence.root_kind AND note.root_id=fence.root_id AND note.project_id=fence.project_id AND note.version=1 AND note.deleted_at IS NULL)))
    OR (fence.operation_kind='update' AND EXISTS(SELECT 1 FROM project_internal_notes note WHERE note.id=fence.note_id
      AND note.source_id=fence.source_id AND note.root_kind=fence.root_kind AND note.root_id=fence.root_id AND note.project_id=fence.project_id
      AND note.deleted_at IS NULL AND note.version IN (fence.expected_version,fence.expected_version+1)))
    OR (fence.operation_kind='delete' AND EXISTS(SELECT 1 FROM project_internal_notes note WHERE note.id=fence.note_id
      AND note.source_id=fence.source_id AND note.root_kind=fence.root_kind AND note.root_id=fence.root_id AND note.project_id=fence.project_id
      AND ((note.deleted_at IS NULL AND note.version=fence.expected_version) OR (note.deleted_at IS NOT NULL AND note.version=fence.expected_version+1)))));

CREATE TRIGGER project_internal_notes_write_guard_insert BEFORE INSERT ON project_internal_notes
WHEN NOT EXISTS(SELECT 1 FROM project_internal_note_live_write_fences fence WHERE fence.source_id=NEW.source_id
  AND fence.root_kind=NEW.root_kind AND fence.root_id=NEW.root_id AND fence.project_id=NEW.project_id AND fence.note_id=NEW.id
  AND fence.operation_kind='create' AND fence.note_writes=1 AND fence.actor_id=NEW.created_by AND fence.actor_id=NEW.updated_by)
BEGIN SELECT RAISE(ABORT,'project note write requires current context'); END;
CREATE TRIGGER project_internal_notes_write_guard_insert_consume AFTER INSERT ON project_internal_notes
BEGIN UPDATE project_internal_note_write_fences SET note_writes=note_writes-1
  WHERE actor_id=NEW.created_by AND note_id=NEW.id AND note_writes>0; END;
CREATE TRIGGER project_internal_notes_identity BEFORE UPDATE ON project_internal_notes
WHEN NEW.id IS NOT OLD.id OR NEW.source_id IS NOT OLD.source_id OR NEW.root_kind IS NOT OLD.root_kind OR NEW.root_id IS NOT OLD.root_id
  OR NEW.project_id IS NOT OLD.project_id OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'project note identity or version is immutable'); END;
CREATE TRIGGER project_internal_notes_write_guard_update BEFORE UPDATE ON project_internal_notes
WHEN NOT EXISTS(SELECT 1 FROM project_internal_note_live_write_fences fence WHERE fence.source_id=OLD.source_id
  AND fence.root_kind=OLD.root_kind AND fence.root_id=OLD.root_id AND fence.project_id=OLD.project_id AND fence.note_id=OLD.id
  AND fence.note_writes=1 AND fence.actor_id=NEW.updated_by AND ((fence.operation_kind='update' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NULL)
    OR (fence.operation_kind='delete' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)))
BEGIN SELECT RAISE(ABORT,'project note write requires current context'); END;
CREATE TRIGGER project_internal_notes_write_guard_update_consume AFTER UPDATE ON project_internal_notes
BEGIN UPDATE project_internal_note_write_fences SET note_writes=note_writes-1
  WHERE actor_id=NEW.updated_by AND note_id=NEW.id AND note_writes>0; END;
CREATE TRIGGER project_internal_note_revisions_write_guard BEFORE INSERT ON project_internal_note_revisions
WHEN NOT EXISTS(SELECT 1 FROM project_internal_note_live_write_fences fence WHERE fence.source_id=NEW.source_id
  AND fence.root_kind=NEW.root_kind AND fence.root_id=NEW.root_id AND fence.project_id=NEW.project_id AND fence.note_id=NEW.note_id
  AND fence.revision_writes=1 AND fence.note_writes=0 AND fence.actor_id=NEW.actor_id AND NEW.version=fence.expected_version+1
  AND NEW.action=CASE fence.operation_kind WHEN 'create' THEN 'created' WHEN 'update' THEN 'updated' ELSE 'deleted' END)
BEGIN SELECT RAISE(ABORT,'project note revision requires current context'); END;
CREATE TRIGGER project_internal_note_revisions_write_guard_consume AFTER INSERT ON project_internal_note_revisions
BEGIN UPDATE project_internal_note_write_fences SET revision_writes=revision_writes-1
  WHERE actor_id=NEW.actor_id AND note_id=NEW.note_id AND revision_writes>0; END;
CREATE TRIGGER project_internal_note_mutations_write_guard BEFORE INSERT ON project_internal_note_mutations
WHEN NOT EXISTS(SELECT 1 FROM project_internal_note_live_write_fences fence WHERE fence.actor_id=NEW.actor_id
  AND fence.idempotency_key=NEW.idempotency_key AND fence.source_id=NEW.source_id AND fence.root_kind=NEW.root_kind
  AND fence.root_id=NEW.root_id AND fence.project_id=NEW.project_id AND fence.note_id=NEW.note_id
  AND fence.mutation_writes=1 AND fence.note_writes=0 AND fence.revision_writes=0 AND NEW.result_version=fence.expected_version+1
  AND NEW.operation_kind=fence.operation_kind)
BEGIN SELECT RAISE(ABORT,'project note mutation receipt requires current context'); END;
CREATE TRIGGER project_internal_note_mutations_write_guard_consume AFTER INSERT ON project_internal_note_mutations
BEGIN UPDATE project_internal_note_write_fences SET mutation_writes=mutation_writes-1
  WHERE actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key AND mutation_writes>0; END;

CREATE TRIGGER project_internal_note_revisions_immutable_update BEFORE UPDATE ON project_internal_note_revisions BEGIN
  SELECT RAISE(ABORT,'project note revisions are immutable');
END;
CREATE TRIGGER project_internal_note_revisions_immutable_delete BEFORE DELETE ON project_internal_note_revisions BEGIN
  SELECT RAISE(ABORT,'project note revisions are immutable');
END;
CREATE TRIGGER project_internal_note_mutations_immutable_update BEFORE UPDATE ON project_internal_note_mutations BEGIN
  SELECT RAISE(ABORT,'project note mutation receipts are immutable');
END;
CREATE TRIGGER project_internal_note_mutations_immutable_delete BEFORE DELETE ON project_internal_note_mutations BEGIN
  SELECT RAISE(ABORT,'project note mutation receipts are immutable');
END;
CREATE TRIGGER project_internal_notes_no_hard_delete BEFORE DELETE ON project_internal_notes BEGIN
  SELECT RAISE(ABORT,'project notes use audited soft deletion');
END;
