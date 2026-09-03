PRAGMA foreign_keys = ON;

-- An authoritative Project Alpha reassignment must not silently expose an old
-- client's operational overlay to the new root. Recovery is an explicit,
-- administrator-only operation. Contacts are always cleared because their
-- identities belong to the old root. Transfer may retain structured memory;
-- reset starts a new visible memory history. Attachments are never transferred.
CREATE TABLE project_operational_recovery_receipts (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  preview_fingerprint TEXT NOT NULL CHECK(length(preview_fingerprint)=64 AND preview_fingerprint NOT GLOB '*[^0-9a-f]*'),
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  recovery_sequence INTEGER NOT NULL CHECK(recovery_sequence>0),
  action TEXT NOT NULL CHECK(action IN ('reset','transfer')),
  old_root_kind TEXT NOT NULL CHECK(old_root_kind IN ('organization','client')),
  old_root_id TEXT NOT NULL,
  new_root_kind TEXT NOT NULL CHECK(new_root_kind IN ('organization','client')),
  new_root_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000 AND instr(reason,char(0))=0),
  contacts_version_before INTEGER NOT NULL CHECK(contacts_version_before>=0),
  contacts_version_after INTEGER NOT NULL CHECK(contacts_version_after>=contacts_version_before),
  memory_version_before INTEGER NOT NULL CHECK(memory_version_before>=0),
  memory_version_after INTEGER NOT NULL CHECK(memory_version_after>=memory_version_before),
  contacts_visible_from_version INTEGER NOT NULL CHECK(contacts_visible_from_version>=1),
  memory_visible_from_version INTEGER NOT NULL CHECK(memory_visible_from_version>=1),
  cleared_contact_count INTEGER NOT NULL CHECK(cleared_contact_count BETWEEN 0 AND 100),
  excluded_attachment_count INTEGER NOT NULL CHECK(excluded_attachment_count>=0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=2048),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key),
  UNIQUE(projection_source_id,project_id,recovery_sequence),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id) REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,old_root_kind,old_root_id) REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,new_root_kind,new_root_id) REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id)
);
CREATE INDEX idx_project_operational_recovery_project ON project_operational_recovery_receipts
  (projection_source_id,project_id,recovery_sequence DESC);

-- Reset history is retained for audit/recovery but physically removed from the
-- active revision table. This makes a Worker rollback safe: readers deployed
-- before 0052 cannot accidentally reveal pre-reset snapshots.
CREATE TABLE project_operational_memory_revision_archive (
  projection_source_id TEXT NOT NULL, project_id TEXT NOT NULL, version INTEGER NOT NULL,
  change_kind TEXT NOT NULL, snapshot_json TEXT NOT NULL, amendment_reason TEXT,
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, recovery_actor_id TEXT NOT NULL,
  recovery_idempotency_key TEXT NOT NULL, archived_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(projection_source_id,project_id,version)
);

-- Reassigned attachments remain in R2 for recovery, but their metadata must
-- leave the active table as well. Otherwise a rollback to a pre-0052 Worker
-- can enumerate an earlier owner's filenames, media types, and sizes. The
-- original append-only row is retained here together with the recovery actor;
-- no application route reads this table.
CREATE TABLE project_memory_attachment_archive (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind='staff_upload'),
  display_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
  object_key TEXT NOT NULL UNIQUE,
  object_etag TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  version_added INTEGER NOT NULL CHECK(version_added>0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  recovery_actor_id TEXT NOT NULL,
  recovery_idempotency_key TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_project_memory_attachment_archive_project ON project_memory_attachment_archive
  (projection_source_id,project_id,archived_at DESC,id DESC);
CREATE TABLE project_memory_attachment_event_archive (
  id TEXT PRIMARY KEY, projection_source_id TEXT NOT NULL, project_record_kind TEXT NOT NULL,
  project_id TEXT NOT NULL, attachment_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  event_kind TEXT NOT NULL, result_version INTEGER NOT NULL, details_json TEXT NOT NULL,
  created_at TEXT NOT NULL, recovery_actor_id TEXT NOT NULL, recovery_idempotency_key TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE project_memory_attachment_mutation_archive (
  actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation_kind TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL, projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL, project_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
  result_version INTEGER NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  recovery_actor_id TEXT NOT NULL, recovery_idempotency_key TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key)
);

CREATE TABLE project_operational_recovery_fences (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_last_sync_id TEXT NOT NULL,
  old_root_kind TEXT NOT NULL CHECK(old_root_kind IN ('organization','client')),
  old_root_id TEXT NOT NULL,
  new_root_kind TEXT NOT NULL CHECK(new_root_kind IN ('organization','client')),
  new_root_id TEXT NOT NULL,
  new_root_last_sync_id TEXT NOT NULL,
  contacts_version INTEGER NOT NULL CHECK(contacts_version>=0),
  memory_version INTEGER NOT NULL CHECK(memory_version>=0),
  contact_set_writes INTEGER NOT NULL CHECK(contact_set_writes BETWEEN 0 AND 1),
  assignment_deletes INTEGER NOT NULL CHECK(assignment_deletes BETWEEN 0 AND 100),
  contact_revision_writes INTEGER NOT NULL CHECK(contact_revision_writes BETWEEN 0 AND 1),
  memory_writes INTEGER NOT NULL CHECK(memory_writes BETWEEN 0 AND 1),
  memory_revision_writes INTEGER NOT NULL CHECK(memory_revision_writes BETWEEN 0 AND 1),
  memory_revision_archives INTEGER NOT NULL CHECK(memory_revision_archives>=0),
  memory_revision_deletes INTEGER NOT NULL CHECK(memory_revision_deletes>=0),
  attachment_archives INTEGER NOT NULL CHECK(attachment_archives>=0),
  attachment_event_archives INTEGER NOT NULL CHECK(attachment_event_archives>=0),
  attachment_event_deletes INTEGER NOT NULL CHECK(attachment_event_deletes>=0),
  attachment_mutation_archives INTEGER NOT NULL CHECK(attachment_mutation_archives>=0),
  attachment_mutation_deletes INTEGER NOT NULL CHECK(attachment_mutation_deletes>=0),
  attachment_deletes INTEGER NOT NULL CHECK(attachment_deletes>=0),
  receipt_writes INTEGER NOT NULL CHECK(receipt_writes BETWEEN 0 AND 1),
  write_guard INTEGER NOT NULL CONSTRAINT project_operational_recovery_current_context CHECK(write_guard=1),
  PRIMARY KEY(actor_id,idempotency_key)
);

CREATE VIEW project_operational_live_recovery_fences AS
SELECT fence.* FROM project_operational_recovery_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id AND actor.status='active'
JOIN pa_projects project ON project.id=fence.project_id AND project.projection_source_id=fence.projection_source_id
  AND project.active=1 AND project.last_sync_id=fence.project_last_sync_id
LEFT JOIN pa_clients owner ON owner.id=project.client_id AND owner.projection_source_id=project.projection_source_id AND owner.active=1
LEFT JOIN pa_organizations organization_root ON fence.new_root_kind='organization'
  AND organization_root.id=fence.new_root_id AND organization_root.projection_source_id=fence.projection_source_id
  AND organization_root.active=1 AND organization_root.last_sync_id=fence.new_root_last_sync_id
LEFT JOIN pa_clients client_root ON fence.new_root_kind='client'
  AND client_root.id=fence.new_root_id AND client_root.projection_source_id=fence.projection_source_id
  AND client_root.active=1 AND client_root.organization_id IS NULL AND client_root.last_sync_id=fence.new_root_last_sync_id
WHERE fence.write_guard=1
  -- Administrator identity is deliberately narrower than permission grants:
  -- local roles and overrides may grant capabilities, but cannot manufacture
  -- administrator status. Every capability is nevertheless evaluated through
  -- the deny-aware global permission contract used by guarded project writes.
  AND EXISTS(SELECT 1 FROM staff_role_assignments administrator WHERE administrator.staff_id=actor.id
    AND administrator.role_id IN ('role-owner','role-admin') AND administrator.scope='global')
  AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides denied WHERE denied.staff_id=actor.id
    AND denied.scope='global' AND denied.effect='deny'
    AND denied.permission_key IN ('team.view','projects.view','project.contacts.manage','project.memory.manage'))
  AND NOT EXISTS(SELECT 1 FROM (SELECT 'team.view' permission_key UNION ALL SELECT 'projects.view'
      UNION ALL SELECT 'project.contacts.manage' UNION ALL SELECT 'project.memory.manage') required
    WHERE NOT EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key=required.permission_key)
      AND NOT EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
        WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key=required.permission_key)
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides allowed WHERE allowed.staff_id=actor.id
        AND allowed.scope='global' AND allowed.effect='allow' AND allowed.permission_key=required.permission_key))
  AND ((fence.projection_source_id='project-alpha:primary' AND NOT EXISTS(
      SELECT 1 FROM pa_connectors primary_connector WHERE primary_connector.source_id='project-alpha:primary'))
    OR EXISTS(SELECT 1 FROM pa_connectors visible_connector WHERE visible_connector.source_id=fence.projection_source_id AND visible_connector.read_visible=1))
  AND ((fence.new_root_kind='organization' AND organization_root.id IS NOT NULL
      AND (project.organization_id=fence.new_root_id OR (project.organization_id IS NULL AND owner.organization_id=fence.new_root_id)))
    OR (fence.new_root_kind='client' AND client_root.id IS NOT NULL AND project.client_id=fence.new_root_id
      AND project.organization_id IS NULL AND owner.id IS NOT NULL AND owner.organization_id IS NULL))
  AND (fence.contacts_version=0 OR EXISTS(SELECT 1 FROM project_operational_contact_sets current
      WHERE current.projection_source_id=fence.projection_source_id AND current.project_id=fence.project_id
        AND current.version=fence.contacts_version+(1-fence.contact_set_writes)
        AND current.root_record_kind IN (fence.old_root_kind,fence.new_root_kind)
        AND current.root_id IN (fence.old_root_id,fence.new_root_id)))
  AND (fence.memory_version=0 OR EXISTS(SELECT 1 FROM project_operational_memory current
      WHERE current.projection_source_id=fence.projection_source_id AND current.project_id=fence.project_id
        AND current.version=fence.memory_version+(1-fence.memory_writes)
        AND current.root_record_kind IN (fence.old_root_kind,fence.new_root_kind)
        AND current.root_id IN (fence.old_root_id,fence.new_root_id)));

DROP TRIGGER project_operational_contact_sets_write_guard_update;
CREATE TRIGGER project_operational_contact_sets_write_guard_update BEFORE UPDATE ON project_operational_contact_sets
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
  AND fence.record_kind='contacts' AND fence.expected_version=OLD.version AND fence.current_writes=1 AND fence.actor_id=NEW.updated_by
  AND fence.root_record_kind=OLD.root_record_kind AND fence.root_id=OLD.root_id)
AND NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence WHERE fence.projection_source_id=OLD.projection_source_id
  AND fence.project_id=OLD.project_id AND fence.contacts_version=OLD.version AND fence.contact_set_writes=1
  AND fence.actor_id=NEW.updated_by AND OLD.root_record_kind=fence.old_root_kind AND OLD.root_id=fence.old_root_id
  AND NEW.root_record_kind=fence.new_root_kind AND NEW.root_id=fence.new_root_id AND NEW.version=OLD.version+1)
BEGIN SELECT RAISE(ABORT,'project contact set write requires current context'); END;
DROP TRIGGER project_operational_contact_sets_consume_update;
CREATE TRIGGER project_operational_contact_sets_consume_update AFTER UPDATE ON project_operational_contact_sets
BEGIN
  UPDATE project_operational_write_fences SET current_writes=current_writes-1 WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id AND current_writes>0;
  UPDATE project_operational_recovery_fences SET contact_set_writes=contact_set_writes-1 WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id AND contact_set_writes>0;
END;
DROP TRIGGER project_operational_contact_set_identity;
CREATE TRIGGER project_operational_contact_set_identity BEFORE UPDATE ON project_operational_contact_sets
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.project_record_kind IS NOT OLD.project_record_kind
  OR NEW.project_id IS NOT OLD.project_id OR NEW.version<>OLD.version+1 OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR ((NEW.root_record_kind IS NOT OLD.root_record_kind OR NEW.root_id IS NOT OLD.root_id) AND NOT EXISTS(
    SELECT 1 FROM project_operational_live_recovery_fences fence WHERE fence.projection_source_id=OLD.projection_source_id
      AND fence.project_id=OLD.project_id AND fence.old_root_kind=OLD.root_record_kind AND fence.old_root_id=OLD.root_id
      AND fence.new_root_kind=NEW.root_record_kind AND fence.new_root_id=NEW.root_id))
BEGIN SELECT RAISE(ABORT,'project contact set identity or version is immutable'); END;

DROP TRIGGER project_operational_contact_assignments_write_guard_delete;
CREATE TRIGGER project_operational_contact_assignments_write_guard_delete BEFORE DELETE ON project_operational_contact_assignments
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=OLD.projection_source_id
  AND fence.project_id=OLD.project_id AND fence.record_kind='contacts' AND fence.current_writes=0 AND fence.assignment_deletes>0
  AND EXISTS(SELECT 1 FROM project_operational_contact_sets current WHERE current.projection_source_id=fence.projection_source_id AND current.project_id=fence.project_id AND current.version=fence.expected_version+1))
AND NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence WHERE fence.projection_source_id=OLD.projection_source_id
  AND fence.project_id=OLD.project_id AND fence.contact_set_writes=0 AND fence.assignment_deletes>0)
BEGIN SELECT RAISE(ABORT,'project contact assignment delete requires current context'); END;
DROP TRIGGER project_operational_contact_assignments_consume_delete;
CREATE TRIGGER project_operational_contact_assignments_consume_delete AFTER DELETE ON project_operational_contact_assignments
BEGIN
  UPDATE project_operational_write_fences SET assignment_deletes=assignment_deletes-1 WHERE projection_source_id=OLD.projection_source_id AND project_id=OLD.project_id AND assignment_deletes>0;
  UPDATE project_operational_recovery_fences SET assignment_deletes=assignment_deletes-1 WHERE projection_source_id=OLD.projection_source_id AND project_id=OLD.project_id AND assignment_deletes>0;
END;
DROP TRIGGER project_operational_contact_revisions_write_guard;
CREATE TRIGGER project_operational_contact_revisions_write_guard BEFORE INSERT ON project_operational_contact_revisions
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id
  AND fence.project_id=NEW.project_id AND fence.record_kind='contacts' AND fence.current_writes=0 AND fence.assignment_deletes=0
  AND fence.assignment_inserts=0 AND fence.revision_writes=1 AND fence.actor_id=NEW.actor_id AND NEW.version=fence.expected_version+1)
AND NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence WHERE fence.projection_source_id=NEW.projection_source_id
  AND fence.project_id=NEW.project_id AND fence.contact_set_writes=0 AND fence.assignment_deletes=0
  AND fence.contact_revision_writes=1 AND fence.actor_id=NEW.actor_id AND NEW.version=fence.contacts_version+1)
BEGIN SELECT RAISE(ABORT,'project contact revision write requires current context'); END;
DROP TRIGGER project_operational_contact_revisions_consume;
CREATE TRIGGER project_operational_contact_revisions_consume AFTER INSERT ON project_operational_contact_revisions
BEGIN
  UPDATE project_operational_write_fences SET revision_writes=revision_writes-1 WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id AND revision_writes>0;
  UPDATE project_operational_recovery_fences SET contact_revision_writes=contact_revision_writes-1 WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id AND contact_revision_writes>0;
END;

DROP TRIGGER project_operational_memory_write_guard_update;
CREATE TRIGGER project_operational_memory_write_guard_update BEFORE UPDATE ON project_operational_memory
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
  AND fence.record_kind='memory' AND fence.expected_version=OLD.version AND fence.current_writes=1 AND fence.actor_id=NEW.updated_by
  AND fence.root_record_kind=OLD.root_record_kind AND fence.root_id=OLD.root_id)
AND NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence WHERE fence.projection_source_id=OLD.projection_source_id
  AND fence.project_id=OLD.project_id AND fence.memory_version=OLD.version AND fence.memory_writes=1
  AND fence.actor_id=NEW.updated_by AND OLD.root_record_kind=fence.old_root_kind AND OLD.root_id=fence.old_root_id
  AND NEW.root_record_kind=fence.new_root_kind AND NEW.root_id=fence.new_root_id AND NEW.version=OLD.version+1)
BEGIN SELECT RAISE(ABORT,'project memory write requires current context'); END;
DROP TRIGGER project_operational_memory_consume_update;
CREATE TRIGGER project_operational_memory_consume_update AFTER UPDATE ON project_operational_memory
BEGIN
  UPDATE project_operational_write_fences SET current_writes=current_writes-1 WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id AND current_writes>0;
  UPDATE project_operational_recovery_fences SET memory_writes=memory_writes-1 WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id AND memory_writes>0;
END;
DROP TRIGGER project_operational_memory_identity;
CREATE TRIGGER project_operational_memory_identity BEFORE UPDATE ON project_operational_memory
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.project_record_kind IS NOT OLD.project_record_kind
  OR NEW.project_id IS NOT OLD.project_id OR NEW.version<>OLD.version+1 OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR ((NEW.root_record_kind IS NOT OLD.root_record_kind OR NEW.root_id IS NOT OLD.root_id) AND NOT EXISTS(
    SELECT 1 FROM project_operational_live_recovery_fences fence WHERE fence.projection_source_id=OLD.projection_source_id
      AND fence.project_id=OLD.project_id AND fence.old_root_kind=OLD.root_record_kind AND fence.old_root_id=OLD.root_id
      AND fence.new_root_kind=NEW.root_record_kind AND fence.new_root_id=NEW.root_id))
BEGIN SELECT RAISE(ABORT,'project memory identity or version is immutable'); END;
DROP TRIGGER project_operational_memory_revisions_write_guard;
CREATE TRIGGER project_operational_memory_revisions_write_guard BEFORE INSERT ON project_operational_memory_revisions
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id
  AND fence.project_id=NEW.project_id AND fence.record_kind='memory' AND fence.current_writes=0 AND fence.revision_writes=1
  AND fence.actor_id=NEW.actor_id AND NEW.version=fence.expected_version+1)
AND NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence WHERE fence.projection_source_id=NEW.projection_source_id
  AND fence.project_id=NEW.project_id AND fence.memory_writes=0 AND fence.memory_revision_writes=1
  AND fence.actor_id=NEW.actor_id AND NEW.version=fence.memory_version+1)
BEGIN SELECT RAISE(ABORT,'project memory revision write requires current context'); END;
DROP TRIGGER project_operational_memory_revisions_consume;
CREATE TRIGGER project_operational_memory_revisions_consume AFTER INSERT ON project_operational_memory_revisions
BEGIN
  UPDATE project_operational_write_fences SET revision_writes=revision_writes-1 WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id AND revision_writes>0;
  UPDATE project_operational_recovery_fences SET memory_revision_writes=memory_revision_writes-1 WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id AND memory_revision_writes>0;
END;

CREATE TRIGGER project_operational_memory_revision_archive_guard BEFORE INSERT ON project_operational_memory_revision_archive
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  WHERE fence.actor_id=NEW.recovery_actor_id AND fence.idempotency_key=NEW.recovery_idempotency_key
    AND fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.memory_revision_archives>0 AND NEW.version<=fence.memory_version)
BEGIN SELECT RAISE(ABORT,'project memory archive requires current context'); END;
CREATE TRIGGER project_operational_memory_revision_archive_consume AFTER INSERT ON project_operational_memory_revision_archive
BEGIN UPDATE project_operational_recovery_fences SET memory_revision_archives=memory_revision_archives-1
  WHERE actor_id=NEW.recovery_actor_id AND idempotency_key=NEW.recovery_idempotency_key; END;
DROP TRIGGER project_operational_memory_revisions_no_delete;
CREATE TRIGGER project_operational_memory_revisions_no_delete BEFORE DELETE ON project_operational_memory_revisions
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
    AND fence.memory_revision_archives=0 AND fence.memory_revision_deletes>0
    AND EXISTS(SELECT 1 FROM project_operational_memory_revision_archive archive
      WHERE archive.projection_source_id=OLD.projection_source_id AND archive.project_id=OLD.project_id
        AND archive.version=OLD.version AND archive.snapshot_json=OLD.snapshot_json))
BEGIN SELECT RAISE(ABORT,'project memory revisions are immutable'); END;
CREATE TRIGGER project_operational_memory_revision_delete_guard BEFORE DELETE ON project_operational_memory_revisions
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
    AND fence.memory_revision_archives=0 AND fence.memory_revision_deletes>0
    AND EXISTS(SELECT 1 FROM project_operational_memory_revision_archive archive
      WHERE archive.projection_source_id=OLD.projection_source_id AND archive.project_id=OLD.project_id
        AND archive.version=OLD.version AND archive.snapshot_json=OLD.snapshot_json))
BEGIN SELECT RAISE(ABORT,'project memory revision delete requires current context'); END;
CREATE TRIGGER project_operational_memory_revision_delete_consume AFTER DELETE ON project_operational_memory_revisions
BEGIN UPDATE project_operational_recovery_fences SET memory_revision_deletes=memory_revision_deletes-1
  WHERE projection_source_id=OLD.projection_source_id AND project_id=OLD.project_id; END;
CREATE TRIGGER project_operational_memory_revision_archive_no_update BEFORE UPDATE ON project_operational_memory_revision_archive
BEGIN SELECT RAISE(ABORT,'project memory revision archive is immutable'); END;
CREATE TRIGGER project_operational_memory_revision_archive_no_delete BEFORE DELETE ON project_operational_memory_revision_archive
BEGIN SELECT RAISE(ABORT,'project memory revision archive is immutable'); END;

CREATE TRIGGER project_memory_attachment_archive_guard BEFORE INSERT ON project_memory_attachment_archive
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  JOIN project_memory_attachments attachment ON attachment.id=NEW.id
    AND attachment.projection_source_id=NEW.projection_source_id AND attachment.project_id=NEW.project_id
  WHERE fence.actor_id=NEW.recovery_actor_id AND fence.idempotency_key=NEW.recovery_idempotency_key
    AND fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.attachment_archives>0
    AND (attachment.root_record_kind<>fence.new_root_kind OR attachment.root_id<>fence.new_root_id)
    AND attachment.project_record_kind=NEW.project_record_kind AND attachment.root_record_kind=NEW.root_record_kind
    AND attachment.root_id=NEW.root_id AND attachment.source_kind=NEW.source_kind
    AND attachment.display_name=NEW.display_name AND attachment.content_type=NEW.content_type
    AND attachment.size_bytes=NEW.size_bytes AND attachment.object_key=NEW.object_key
    AND attachment.object_etag=NEW.object_etag AND attachment.sha256=NEW.sha256
    AND attachment.version_added=NEW.version_added AND attachment.created_by=NEW.created_by
    AND attachment.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'project memory attachment archive requires current context'); END;
CREATE TRIGGER project_memory_attachment_archive_consume AFTER INSERT ON project_memory_attachment_archive
BEGIN UPDATE project_operational_recovery_fences SET attachment_archives=attachment_archives-1
  WHERE actor_id=NEW.recovery_actor_id AND idempotency_key=NEW.recovery_idempotency_key; END;

CREATE TRIGGER project_memory_attachment_event_archive_guard BEFORE INSERT ON project_memory_attachment_event_archive
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  JOIN project_memory_attachment_events event ON event.id=NEW.id
    AND event.projection_source_id=NEW.projection_source_id AND event.project_id=NEW.project_id
  JOIN project_memory_attachment_archive attachment ON attachment.id=NEW.attachment_id
    AND attachment.projection_source_id=NEW.projection_source_id AND attachment.project_id=NEW.project_id
  WHERE fence.actor_id=NEW.recovery_actor_id AND fence.idempotency_key=NEW.recovery_idempotency_key
    AND fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.attachment_event_archives>0 AND event.project_record_kind=NEW.project_record_kind
    AND event.attachment_id=NEW.attachment_id AND event.actor_id=NEW.actor_id AND event.event_kind=NEW.event_kind
    AND event.result_version=NEW.result_version AND event.details_json=NEW.details_json AND event.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'project memory attachment event archive requires current context'); END;
CREATE TRIGGER project_memory_attachment_event_archive_consume AFTER INSERT ON project_memory_attachment_event_archive
BEGIN UPDATE project_operational_recovery_fences SET attachment_event_archives=attachment_event_archives-1
  WHERE actor_id=NEW.recovery_actor_id AND idempotency_key=NEW.recovery_idempotency_key; END;

CREATE TRIGGER project_memory_attachment_mutation_archive_guard BEFORE INSERT ON project_memory_attachment_mutation_archive
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  JOIN project_memory_attachment_mutations mutation ON mutation.actor_id=NEW.actor_id
    AND mutation.idempotency_key=NEW.idempotency_key AND mutation.projection_source_id=NEW.projection_source_id
    AND mutation.project_id=NEW.project_id
  JOIN project_memory_attachment_archive attachment ON attachment.id=NEW.attachment_id
    AND attachment.projection_source_id=NEW.projection_source_id AND attachment.project_id=NEW.project_id
  WHERE fence.actor_id=NEW.recovery_actor_id AND fence.idempotency_key=NEW.recovery_idempotency_key
    AND fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
    AND fence.attachment_mutation_archives>0 AND mutation.operation_kind=NEW.operation_kind
    AND mutation.request_fingerprint=NEW.request_fingerprint AND mutation.project_record_kind=NEW.project_record_kind
    AND mutation.attachment_id=NEW.attachment_id AND mutation.result_version=NEW.result_version
    AND mutation.result_json=NEW.result_json AND mutation.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'project memory attachment mutation archive requires current context'); END;
CREATE TRIGGER project_memory_attachment_mutation_archive_consume AFTER INSERT ON project_memory_attachment_mutation_archive
BEGIN UPDATE project_operational_recovery_fences SET attachment_mutation_archives=attachment_mutation_archives-1
  WHERE actor_id=NEW.recovery_actor_id AND idempotency_key=NEW.recovery_idempotency_key; END;

DROP TRIGGER project_memory_attachment_events_no_delete;
CREATE TRIGGER project_memory_attachment_events_no_delete BEFORE DELETE ON project_memory_attachment_events
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  JOIN project_memory_attachment_event_archive archive ON archive.id=OLD.id
    AND archive.projection_source_id=OLD.projection_source_id AND archive.project_id=OLD.project_id
  WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
    AND fence.attachment_event_archives=0 AND fence.attachment_event_deletes>0
    AND archive.project_record_kind=OLD.project_record_kind AND archive.attachment_id=OLD.attachment_id
    AND archive.actor_id=OLD.actor_id AND archive.event_kind=OLD.event_kind
    AND archive.result_version=OLD.result_version AND archive.details_json=OLD.details_json AND archive.created_at=OLD.created_at)
BEGIN SELECT RAISE(ABORT,'project memory attachment audit is immutable'); END;
CREATE TRIGGER project_memory_attachment_event_delete_consume AFTER DELETE ON project_memory_attachment_events
BEGIN UPDATE project_operational_recovery_fences SET attachment_event_deletes=attachment_event_deletes-1
  WHERE projection_source_id=OLD.projection_source_id AND project_id=OLD.project_id AND attachment_event_deletes>0; END;

DROP TRIGGER project_memory_attachment_mutations_no_delete;
CREATE TRIGGER project_memory_attachment_mutations_no_delete BEFORE DELETE ON project_memory_attachment_mutations
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  JOIN project_memory_attachment_mutation_archive archive ON archive.actor_id=OLD.actor_id
    AND archive.idempotency_key=OLD.idempotency_key
  WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
    AND fence.attachment_mutation_archives=0 AND fence.attachment_mutation_deletes>0
    AND archive.operation_kind=OLD.operation_kind AND archive.request_fingerprint=OLD.request_fingerprint
    AND archive.projection_source_id=OLD.projection_source_id AND archive.project_record_kind=OLD.project_record_kind
    AND archive.project_id=OLD.project_id AND archive.attachment_id=OLD.attachment_id
    AND archive.result_version=OLD.result_version AND archive.result_json=OLD.result_json AND archive.created_at=OLD.created_at)
BEGIN SELECT RAISE(ABORT,'project memory attachment receipts are immutable'); END;
CREATE TRIGGER project_memory_attachment_mutation_delete_consume AFTER DELETE ON project_memory_attachment_mutations
BEGIN UPDATE project_operational_recovery_fences SET attachment_mutation_deletes=attachment_mutation_deletes-1
  WHERE projection_source_id=OLD.projection_source_id AND project_id=OLD.project_id AND attachment_mutation_deletes>0; END;

DROP TRIGGER project_memory_attachments_no_delete;
CREATE TRIGGER project_memory_attachments_no_delete BEFORE DELETE ON project_memory_attachments
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence
  JOIN project_memory_attachment_archive archive ON archive.id=OLD.id
    AND archive.projection_source_id=OLD.projection_source_id AND archive.project_id=OLD.project_id
  WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
    AND fence.attachment_archives=0 AND fence.attachment_event_archives=0 AND fence.attachment_event_deletes=0
    AND fence.attachment_mutation_archives=0 AND fence.attachment_mutation_deletes=0 AND fence.attachment_deletes>0
    AND archive.project_record_kind=OLD.project_record_kind AND archive.root_record_kind=OLD.root_record_kind
    AND archive.root_id=OLD.root_id AND archive.source_kind=OLD.source_kind AND archive.display_name=OLD.display_name
    AND archive.content_type=OLD.content_type AND archive.size_bytes=OLD.size_bytes AND archive.object_key=OLD.object_key
    AND archive.object_etag=OLD.object_etag AND archive.sha256=OLD.sha256 AND archive.version_added=OLD.version_added
    AND archive.created_by=OLD.created_by AND archive.created_at=OLD.created_at)
BEGIN SELECT RAISE(ABORT,'project memory attachments are immutable'); END;
CREATE TRIGGER project_memory_attachment_delete_consume AFTER DELETE ON project_memory_attachments
BEGIN UPDATE project_operational_recovery_fences SET attachment_deletes=attachment_deletes-1
  WHERE projection_source_id=OLD.projection_source_id AND project_id=OLD.project_id AND attachment_deletes>0; END;

CREATE TRIGGER project_memory_attachment_archive_no_update BEFORE UPDATE ON project_memory_attachment_archive
BEGIN SELECT RAISE(ABORT,'project memory attachment archive is immutable'); END;
CREATE TRIGGER project_memory_attachment_archive_no_delete BEFORE DELETE ON project_memory_attachment_archive
BEGIN SELECT RAISE(ABORT,'project memory attachment archive is immutable'); END;
CREATE TRIGGER project_memory_attachment_event_archive_no_update BEFORE UPDATE ON project_memory_attachment_event_archive
BEGIN SELECT RAISE(ABORT,'project memory attachment event archive is immutable'); END;
CREATE TRIGGER project_memory_attachment_event_archive_no_delete BEFORE DELETE ON project_memory_attachment_event_archive
BEGIN SELECT RAISE(ABORT,'project memory attachment event archive is immutable'); END;
CREATE TRIGGER project_memory_attachment_mutation_archive_no_update BEFORE UPDATE ON project_memory_attachment_mutation_archive
BEGIN SELECT RAISE(ABORT,'project memory attachment mutation archive is immutable'); END;
CREATE TRIGGER project_memory_attachment_mutation_archive_no_delete BEFORE DELETE ON project_memory_attachment_mutation_archive
BEGIN SELECT RAISE(ABORT,'project memory attachment mutation archive is immutable'); END;

CREATE TRIGGER project_operational_recovery_receipt_guard BEFORE INSERT ON project_operational_recovery_receipts
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_recovery_fences fence WHERE fence.actor_id=NEW.actor_id
  AND fence.idempotency_key=NEW.idempotency_key AND fence.projection_source_id=NEW.projection_source_id
  AND fence.project_id=NEW.project_id AND fence.contact_set_writes=0 AND fence.assignment_deletes=0
  AND fence.contact_revision_writes=0 AND fence.memory_writes=0 AND fence.memory_revision_writes=0
  AND fence.memory_revision_archives=0 AND fence.memory_revision_deletes=0
  AND fence.attachment_archives=0 AND fence.attachment_event_archives=0 AND fence.attachment_event_deletes=0
  AND fence.attachment_mutation_archives=0 AND fence.attachment_mutation_deletes=0 AND fence.attachment_deletes=0
  AND fence.receipt_writes=1)
BEGIN SELECT RAISE(ABORT,'project recovery requires current context'); END;
CREATE TRIGGER project_operational_recovery_receipt_consume AFTER INSERT ON project_operational_recovery_receipts
BEGIN UPDATE project_operational_recovery_fences SET receipt_writes=receipt_writes-1
  WHERE actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key; END;
CREATE TRIGGER project_operational_recovery_fence_exhausted BEFORE DELETE ON project_operational_recovery_fences
WHEN OLD.contact_set_writes<>0 OR OLD.assignment_deletes<>0 OR OLD.contact_revision_writes<>0
  OR OLD.memory_writes<>0 OR OLD.memory_revision_writes<>0 OR OLD.memory_revision_archives<>0
  OR OLD.memory_revision_deletes<>0 OR OLD.attachment_archives<>0 OR OLD.attachment_event_archives<>0
  OR OLD.attachment_event_deletes<>0 OR OLD.attachment_mutation_archives<>0
  OR OLD.attachment_mutation_deletes<>0 OR OLD.attachment_deletes<>0 OR OLD.receipt_writes<>0
BEGIN SELECT RAISE(ABORT,'project recovery fence is not exhausted'); END;
CREATE TRIGGER project_operational_recovery_receipts_no_update BEFORE UPDATE ON project_operational_recovery_receipts
BEGIN SELECT RAISE(ABORT,'project recovery receipts are immutable'); END;
CREATE TRIGGER project_operational_recovery_receipts_no_delete BEFORE DELETE ON project_operational_recovery_receipts
BEGIN SELECT RAISE(ABORT,'project recovery receipts are immutable'); END;

PRAGMA foreign_keys = ON;
