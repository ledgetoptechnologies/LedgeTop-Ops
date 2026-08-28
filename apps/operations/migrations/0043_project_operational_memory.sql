PRAGMA foreign_keys = ON;

-- Operational contact roles and project memory are LTDS Operations records.
-- Project Alpha remains authoritative for projects, people, billing, access,
-- notifications and lifecycle. These permissions are deliberately global and
-- are granted only to the two immutable administrator roles by default.
INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('project.contacts.manage','Manage operational contacts on visible projects'),
  ('project.memory.manage','Manage operational project memory');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT role.id,permission.key FROM roles role CROSS JOIN permissions permission
WHERE role.id IN ('role-owner','role-admin')
  AND permission.key IN ('project.contacts.manage','project.memory.manage');

CREATE TABLE project_operational_contact_sets (
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(projection_source_id,project_id),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,root_record_kind,root_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(created_by) REFERENCES staff_users(id),
  FOREIGN KEY(updated_by) REFERENCES staff_users(id)
);

CREATE TABLE project_operational_contact_assignments (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  contact_record_kind TEXT NOT NULL DEFAULT 'client' CHECK(contact_record_kind='client'),
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('project_contact','site_contact')),
  preferred_contact_method TEXT CHECK(preferred_contact_method IS NULL OR preferred_contact_method IN ('email','phone','text')),
  instructions TEXT NOT NULL DEFAULT '' CHECK(length(instructions)<=4000 AND instr(instructions,char(0))=0),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 99),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(projection_source_id,project_id,contact_id,role),
  UNIQUE(projection_source_id,project_id,sort_order),
  FOREIGN KEY(projection_source_id,project_id)
    REFERENCES project_operational_contact_sets(projection_source_id,project_id) ON DELETE CASCADE,
  FOREIGN KEY(projection_source_id,contact_record_kind,contact_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(created_by) REFERENCES staff_users(id)
);
CREATE INDEX idx_project_operational_contacts_contact
ON project_operational_contact_assignments(projection_source_id,contact_id,project_id);

CREATE TABLE project_operational_contact_revisions (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(snapshot_json)<=524288),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(projection_source_id,project_id,version),
  FOREIGN KEY(projection_source_id,project_id)
    REFERENCES project_operational_contact_sets(projection_source_id,project_id),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id)
);

CREATE TABLE project_operational_memory (
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(snapshot_json)<=131072),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(projection_source_id,project_id),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,root_record_kind,root_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(created_by) REFERENCES staff_users(id),
  FOREIGN KEY(updated_by) REFERENCES staff_users(id)
);

CREATE TABLE project_operational_memory_revisions (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  change_kind TEXT NOT NULL CHECK(change_kind IN ('saved','post_completion_amendment')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(snapshot_json)<=131072),
  amendment_reason TEXT CHECK(amendment_reason IS NULL OR (length(amendment_reason) BETWEEN 1 AND 1000 AND instr(amendment_reason,char(0))=0)),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(projection_source_id,project_id,version),
  CHECK((change_kind='post_completion_amendment')=(amendment_reason IS NOT NULL)),
  FOREIGN KEY(projection_source_id,project_id)
    REFERENCES project_operational_memory(projection_source_id,project_id),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id)
);

-- Business/security audit contains only opaque IDs, event kind, versions and
-- bounded non-PII counters/status. Contact channels, instructions, memory text
-- and amendment reasons live only in the protected current/revision records.
CREATE TABLE project_operational_events (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('contacts_saved','memory_saved','memory_amended')),
  result_version INTEGER NOT NULL CHECK(result_version>0),
  details_json TEXT NOT NULL CHECK(json_valid(details_json) AND length(details_json)<=1000),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id)
);
CREATE INDEX idx_project_operational_events_project
ON project_operational_events(projection_source_id,project_id,created_at DESC,id DESC);

CREATE TABLE project_operational_mutations (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('contacts_save','memory_save')),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  projection_source_id TEXT NOT NULL,
  project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_record_kind='project'),
  project_id TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK(result_version>0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=1000),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id),
  FOREIGN KEY(projection_source_id,project_record_kind,project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id)
);

-- The shipped service writes each operation in one atomic D1 batch bracketed
-- by this defense-in-depth fence. Triggers catch accidental writes by code that
-- does not follow that protocol. D1 write access itself remains trusted.
CREATE TABLE project_operational_write_fences (
  projection_source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  permission_key TEXT NOT NULL CHECK(permission_key IN ('project.contacts.manage','project.memory.manage')),
  record_kind TEXT NOT NULL CHECK(record_kind IN ('contacts','memory')),
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  root_last_sync_id TEXT NOT NULL,
  project_client_id TEXT,
  project_organization_id TEXT,
  project_status TEXT,
  project_last_sync_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  current_writes INTEGER NOT NULL CHECK(current_writes BETWEEN 0 AND 1),
  assignment_deletes INTEGER NOT NULL CHECK(assignment_deletes BETWEEN 0 AND 100),
  assignment_inserts INTEGER NOT NULL CHECK(assignment_inserts BETWEEN 0 AND 100),
  revision_writes INTEGER NOT NULL CHECK(revision_writes BETWEEN 0 AND 1),
  event_writes INTEGER NOT NULL CHECK(event_writes BETWEEN 0 AND 1),
  mutation_writes INTEGER NOT NULL CHECK(mutation_writes BETWEEN 0 AND 1),
  write_guard INTEGER NOT NULL CONSTRAINT project_operational_current_context CHECK(write_guard=1),
  PRIMARY KEY(projection_source_id,project_id)
);

-- For the shipped batch path, repeat ACL/source/ownership/version checks at
-- each protected stage and consume the expected stage counts. This validates
-- service sequencing; it is not a security boundary against arbitrary D1 SQL.
CREATE VIEW project_operational_live_write_fences AS
SELECT fence.* FROM project_operational_write_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id AND actor.status='active'
JOIN pa_projects project ON project.id=fence.project_id AND project.projection_source_id=fence.projection_source_id
  AND project.active=1 AND project.client_id IS fence.project_client_id
  AND project.organization_id IS fence.project_organization_id AND project.status IS fence.project_status
  AND project.last_sync_id=fence.project_last_sync_id
LEFT JOIN pa_clients owner ON owner.id=project.client_id AND owner.projection_source_id=project.projection_source_id AND owner.active=1
LEFT JOIN pa_organizations organization_root ON fence.root_record_kind='organization'
  AND organization_root.id=fence.root_id AND organization_root.projection_source_id=fence.projection_source_id
  AND organization_root.active=1 AND organization_root.last_sync_id=fence.root_last_sync_id
LEFT JOIN pa_clients client_root ON fence.root_record_kind='client'
  AND client_root.id=fence.root_id AND client_root.projection_source_id=fence.projection_source_id
  AND client_root.active=1 AND client_root.organization_id IS NULL AND client_root.last_sync_id=fence.root_last_sync_id
WHERE fence.write_guard=1
  AND ((fence.projection_source_id='project-alpha:primary' AND NOT EXISTS (
      SELECT 1 FROM pa_connectors primary_connector WHERE primary_connector.source_id='project-alpha:primary'))
    OR EXISTS(SELECT 1 FROM pa_connectors visible_connector
      WHERE visible_connector.source_id=fence.projection_source_id AND visible_connector.read_visible=1))
  AND ((fence.root_record_kind='organization' AND organization_root.id IS NOT NULL
      AND (project.organization_id=fence.root_id OR (project.organization_id IS NULL AND owner.organization_id=fence.root_id)))
    OR (fence.root_record_kind='client' AND client_root.id IS NOT NULL AND project.client_id=fence.root_id
      AND project.organization_id IS NULL AND owner.id IS NOT NULL AND owner.organization_id IS NULL))
  AND (SELECT count(*) FROM permissions required
    WHERE required.key IN ('team.view','projects.view',fence.permission_key)
      AND (EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
            WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
            WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM staff_permission_overrides grant_row WHERE grant_row.staff_id=actor.id
            AND grant_row.permission_key=required.key AND grant_row.scope='global' AND grant_row.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny_row WHERE deny_row.staff_id=actor.id
        AND deny_row.permission_key=required.key AND deny_row.scope='global' AND deny_row.effect='deny'))=3
  AND ((fence.record_kind='contacts' AND ((fence.expected_version=0 AND NOT EXISTS(
          SELECT 1 FROM project_operational_contact_sets current WHERE current.projection_source_id=fence.projection_source_id AND current.project_id=fence.project_id))
    OR EXISTS(SELECT 1 FROM project_operational_contact_sets current WHERE current.projection_source_id=fence.projection_source_id
          AND current.project_id=fence.project_id AND current.version IN (fence.expected_version,fence.expected_version+1))))
    OR (fence.record_kind='memory' AND ((fence.expected_version=0 AND NOT EXISTS(
          SELECT 1 FROM project_operational_memory current WHERE current.projection_source_id=fence.projection_source_id AND current.project_id=fence.project_id))
    OR EXISTS(SELECT 1 FROM project_operational_memory current WHERE current.projection_source_id=fence.projection_source_id
          AND current.project_id=fence.project_id AND current.version IN (fence.expected_version,fence.expected_version+1)))));

CREATE TRIGGER project_operational_contact_sets_write_guard_insert BEFORE INSERT ON project_operational_contact_sets
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
  AND fence.record_kind='contacts' AND fence.expected_version=0 AND fence.current_writes=1
  AND fence.actor_id=NEW.created_by AND fence.actor_id=NEW.updated_by
  AND fence.root_record_kind=NEW.root_record_kind AND fence.root_id=NEW.root_id)
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_contact_sets_consume_insert AFTER INSERT ON project_operational_contact_sets
BEGIN UPDATE project_operational_write_fences SET current_writes=current_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;
CREATE TRIGGER project_operational_contact_sets_write_guard_update BEFORE UPDATE ON project_operational_contact_sets
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
  AND fence.record_kind='contacts' AND fence.expected_version=OLD.version AND fence.current_writes=1
  AND fence.actor_id=NEW.updated_by
  AND fence.root_record_kind=OLD.root_record_kind AND fence.root_id=OLD.root_id)
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_contact_sets_consume_update AFTER UPDATE ON project_operational_contact_sets
BEGIN UPDATE project_operational_write_fences SET current_writes=current_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;
CREATE TRIGGER project_operational_contact_assignments_write_guard_insert BEFORE INSERT ON project_operational_contact_assignments
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence JOIN project_operational_contact_sets current
  ON current.projection_source_id=fence.projection_source_id AND current.project_id=fence.project_id
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id AND fence.record_kind='contacts'
    AND fence.current_writes=0 AND fence.assignment_deletes=0 AND fence.assignment_inserts>0
    AND fence.actor_id=NEW.created_by AND current.version=fence.expected_version+1
    AND EXISTS(SELECT 1 FROM pa_clients contact WHERE contact.id=NEW.contact_id AND contact.projection_source_id=NEW.projection_source_id
      AND contact.active=1 AND ((fence.root_record_kind='organization' AND contact.organization_id=fence.root_id)
        OR (fence.root_record_kind='client' AND contact.id=fence.root_id AND contact.organization_id IS NULL))))
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_contact_assignments_consume_insert AFTER INSERT ON project_operational_contact_assignments
BEGIN UPDATE project_operational_write_fences SET assignment_inserts=assignment_inserts-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;
CREATE TRIGGER project_operational_contact_assignments_write_guard_delete BEFORE DELETE ON project_operational_contact_assignments
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=OLD.projection_source_id
  AND fence.project_id=OLD.project_id AND fence.record_kind='contacts'
  AND fence.current_writes=0 AND fence.assignment_deletes>0
  AND EXISTS(SELECT 1 FROM project_operational_contact_sets current WHERE current.projection_source_id=fence.projection_source_id
    AND current.project_id=fence.project_id AND current.version=fence.expected_version+1))
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_contact_assignments_consume_delete AFTER DELETE ON project_operational_contact_assignments
BEGIN UPDATE project_operational_write_fences SET assignment_deletes=assignment_deletes-1
  WHERE projection_source_id=OLD.projection_source_id AND project_id=OLD.project_id; END;
CREATE TRIGGER project_operational_contact_assignments_no_update BEFORE UPDATE ON project_operational_contact_assignments
BEGIN SELECT RAISE(ABORT,'project operational contact assignments are replaced, not updated'); END;
CREATE TRIGGER project_operational_contact_revisions_write_guard BEFORE INSERT ON project_operational_contact_revisions
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id
  AND fence.project_id=NEW.project_id AND fence.record_kind='contacts' AND fence.current_writes=0
  AND fence.assignment_deletes=0 AND fence.assignment_inserts=0 AND fence.revision_writes=1
  AND fence.actor_id=NEW.actor_id AND NEW.version=fence.expected_version+1)
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_contact_revisions_consume AFTER INSERT ON project_operational_contact_revisions
BEGIN UPDATE project_operational_write_fences SET revision_writes=revision_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;
CREATE TRIGGER project_operational_memory_write_guard_insert BEFORE INSERT ON project_operational_memory
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
  AND fence.record_kind='memory' AND fence.expected_version=0 AND fence.current_writes=1
  AND fence.actor_id=NEW.created_by AND fence.actor_id=NEW.updated_by
  AND fence.root_record_kind=NEW.root_record_kind AND fence.root_id=NEW.root_id)
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_memory_consume_insert AFTER INSERT ON project_operational_memory
BEGIN UPDATE project_operational_write_fences SET current_writes=current_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;
CREATE TRIGGER project_operational_memory_write_guard_update BEFORE UPDATE ON project_operational_memory
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=OLD.projection_source_id AND fence.project_id=OLD.project_id
  AND fence.record_kind='memory' AND fence.expected_version=OLD.version AND fence.current_writes=1
  AND fence.actor_id=NEW.updated_by
  AND fence.root_record_kind=OLD.root_record_kind AND fence.root_id=OLD.root_id)
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_memory_consume_update AFTER UPDATE ON project_operational_memory
BEGIN UPDATE project_operational_write_fences SET current_writes=current_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;
CREATE TRIGGER project_operational_memory_revisions_write_guard BEFORE INSERT ON project_operational_memory_revisions
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id
  AND fence.project_id=NEW.project_id AND fence.record_kind='memory' AND fence.current_writes=0
  AND fence.revision_writes=1 AND fence.actor_id=NEW.actor_id AND NEW.version=fence.expected_version+1)
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_memory_revisions_consume AFTER INSERT ON project_operational_memory_revisions
BEGIN UPDATE project_operational_write_fences SET revision_writes=revision_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;
CREATE TRIGGER project_operational_events_write_guard BEFORE INSERT ON project_operational_events
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
  AND ((fence.record_kind='contacts' AND NEW.event_kind='contacts_saved')
    OR (fence.record_kind='memory' AND NEW.event_kind IN ('memory_saved','memory_amended')))
  AND fence.current_writes=0 AND fence.assignment_deletes=0 AND fence.assignment_inserts=0
  AND fence.revision_writes=0 AND fence.event_writes=1 AND fence.actor_id=NEW.actor_id
  AND NEW.result_version=fence.expected_version+1)
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_events_consume AFTER INSERT ON project_operational_events
BEGIN UPDATE project_operational_write_fences SET event_writes=event_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;
CREATE TRIGGER project_operational_mutations_write_guard BEFORE INSERT ON project_operational_mutations
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_write_fences fence WHERE fence.projection_source_id=NEW.projection_source_id AND fence.project_id=NEW.project_id
  AND ((fence.record_kind='contacts' AND NEW.operation_kind='contacts_save')
    OR (fence.record_kind='memory' AND NEW.operation_kind='memory_save'))
  AND fence.current_writes=0 AND fence.assignment_deletes=0 AND fence.assignment_inserts=0
  AND fence.revision_writes=0 AND fence.event_writes=0 AND fence.mutation_writes=1 AND fence.actor_id=NEW.actor_id
  AND NEW.result_version=fence.expected_version+1)
BEGIN SELECT RAISE(ABORT,'project operational write requires current context'); END;
CREATE TRIGGER project_operational_mutations_consume AFTER INSERT ON project_operational_mutations
BEGIN UPDATE project_operational_write_fences SET mutation_writes=mutation_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND project_id=NEW.project_id; END;

CREATE TRIGGER project_operational_contact_set_identity BEFORE UPDATE ON project_operational_contact_sets
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.project_record_kind IS NOT OLD.project_record_kind
  OR NEW.project_id IS NOT OLD.project_id OR NEW.root_record_kind IS NOT OLD.root_record_kind OR NEW.root_id IS NOT OLD.root_id
  OR NEW.version<>OLD.version+1 OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'project contact set identity or version is immutable'); END;
CREATE TRIGGER project_operational_contact_sets_no_delete BEFORE DELETE ON project_operational_contact_sets
BEGIN SELECT RAISE(ABORT,'project contact set history is persistent'); END;
CREATE TRIGGER project_operational_memory_identity BEFORE UPDATE ON project_operational_memory
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.project_record_kind IS NOT OLD.project_record_kind
  OR NEW.project_id IS NOT OLD.project_id OR NEW.root_record_kind IS NOT OLD.root_record_kind OR NEW.root_id IS NOT OLD.root_id
  OR NEW.version<>OLD.version+1 OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'project memory identity or version is immutable'); END;
CREATE TRIGGER project_operational_memory_no_delete BEFORE DELETE ON project_operational_memory
BEGIN SELECT RAISE(ABORT,'project memory history is persistent'); END;

CREATE TRIGGER project_operational_contact_revisions_no_update BEFORE UPDATE ON project_operational_contact_revisions
BEGIN SELECT RAISE(ABORT,'project contact revisions are immutable'); END;
CREATE TRIGGER project_operational_contact_revisions_no_delete BEFORE DELETE ON project_operational_contact_revisions
BEGIN SELECT RAISE(ABORT,'project contact revisions are immutable'); END;
CREATE TRIGGER project_operational_memory_revisions_no_update BEFORE UPDATE ON project_operational_memory_revisions
BEGIN SELECT RAISE(ABORT,'project memory revisions are immutable'); END;
CREATE TRIGGER project_operational_memory_revisions_no_delete BEFORE DELETE ON project_operational_memory_revisions
BEGIN SELECT RAISE(ABORT,'project memory revisions are immutable'); END;
CREATE TRIGGER project_operational_events_no_update BEFORE UPDATE ON project_operational_events
BEGIN SELECT RAISE(ABORT,'project operational audit is immutable'); END;
CREATE TRIGGER project_operational_events_no_delete BEFORE DELETE ON project_operational_events
BEGIN SELECT RAISE(ABORT,'project operational audit is immutable'); END;
CREATE TRIGGER project_operational_mutations_no_update BEFORE UPDATE ON project_operational_mutations
BEGIN SELECT RAISE(ABORT,'project operational mutation receipts are immutable'); END;
CREATE TRIGGER project_operational_mutations_no_delete BEFORE DELETE ON project_operational_mutations
BEGIN SELECT RAISE(ABORT,'project operational mutation receipts are immutable'); END;

PRAGMA foreign_keys = ON;
