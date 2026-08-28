PRAGMA foreign_keys = ON;

-- Organization-level operational contacts are staff-only Operations records.
-- They do not appoint Project Alpha contacts, portal principals, grant
-- recipients, billing contacts, or notification recipients.
INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('organization.contacts.manage','Manage operational contacts for visible organizations');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT role.id,permission.key FROM roles role CROSS JOIN permissions permission
WHERE role.id IN ('role-owner','role-admin')
  AND permission.key='organization.contacts.manage';

CREATE TABLE organization_operational_contact_sets (
  projection_source_id TEXT NOT NULL,
  organization_record_kind TEXT NOT NULL DEFAULT 'organization' CHECK(organization_record_kind='organization'),
  organization_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(projection_source_id,organization_id),
  FOREIGN KEY(projection_source_id,organization_record_kind,organization_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(created_by) REFERENCES staff_users(id),
  FOREIGN KEY(updated_by) REFERENCES staff_users(id)
);

CREATE TABLE organization_operational_contact_assignments (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  contact_record_kind TEXT NOT NULL DEFAULT 'client' CHECK(contact_record_kind='client'),
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('primary_operational','delivery')),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 99),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(projection_source_id,organization_id,contact_id,role),
  UNIQUE(projection_source_id,organization_id,sort_order),
  FOREIGN KEY(projection_source_id,organization_id)
    REFERENCES organization_operational_contact_sets(projection_source_id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY(projection_source_id,contact_record_kind,contact_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(created_by) REFERENCES staff_users(id)
);
CREATE UNIQUE INDEX idx_organization_operational_primary
ON organization_operational_contact_assignments(projection_source_id,organization_id)
WHERE role='primary_operational';
CREATE INDEX idx_organization_operational_contacts_contact
ON organization_operational_contact_assignments(projection_source_id,contact_id,organization_id);

CREATE TABLE organization_operational_contact_revisions (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(snapshot_json)<=131072),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(projection_source_id,organization_id,version),
  FOREIGN KEY(projection_source_id,organization_id)
    REFERENCES organization_operational_contact_sets(projection_source_id,organization_id),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id)
);

-- Timeline-compatible audit rows contain only opaque IDs, versions and a
-- bounded count by role. Contact names, channels and source payloads are never
-- copied into this ledger.
CREATE TABLE organization_operational_events (
  id TEXT PRIMARY KEY,
  projection_source_id TEXT NOT NULL,
  organization_record_kind TEXT NOT NULL DEFAULT 'organization' CHECK(organization_record_kind='organization'),
  organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind='contacts_saved'),
  result_version INTEGER NOT NULL CHECK(result_version>0),
  details_json TEXT NOT NULL CHECK(json_valid(details_json) AND length(details_json)<=1000),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(projection_source_id,organization_record_kind,organization_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id)
);
CREATE INDEX idx_organization_operational_events_root
ON organization_operational_events(projection_source_id,organization_id,created_at DESC,id DESC);

CREATE TABLE organization_operational_mutations (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind='contacts_save'),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  projection_source_id TEXT NOT NULL,
  organization_record_kind TEXT NOT NULL DEFAULT 'organization' CHECK(organization_record_kind='organization'),
  organization_id TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK(result_version>0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=1000),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id),
  FOREIGN KEY(projection_source_id,organization_record_kind,organization_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id)
);

-- D1 write access and the migration runner remain trusted. This short-lived
-- fence prevents product code from accidentally bypassing the service's exact
-- root, permission, version, source-visibility and contact-membership checks.
CREATE TABLE organization_operational_write_fences (
  projection_source_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  organization_last_sync_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  contact_ids_json TEXT NOT NULL CHECK(json_valid(contact_ids_json)),
  current_writes INTEGER NOT NULL CHECK(current_writes BETWEEN 0 AND 1),
  assignment_deletes INTEGER NOT NULL CHECK(assignment_deletes BETWEEN 0 AND 100),
  assignment_inserts INTEGER NOT NULL CHECK(assignment_inserts BETWEEN 0 AND 100),
  revision_writes INTEGER NOT NULL CHECK(revision_writes BETWEEN 0 AND 1),
  event_writes INTEGER NOT NULL CHECK(event_writes BETWEEN 0 AND 1),
  mutation_writes INTEGER NOT NULL CHECK(mutation_writes BETWEEN 0 AND 1),
  write_guard INTEGER NOT NULL CONSTRAINT organization_operational_current_context CHECK(write_guard=1),
  PRIMARY KEY(projection_source_id,organization_id)
);

CREATE VIEW organization_operational_live_write_fences AS
SELECT fence.* FROM organization_operational_write_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id AND actor.status='active'
JOIN pa_organizations organization ON organization.id=fence.organization_id
  AND organization.projection_source_id=fence.projection_source_id
  AND organization.active=1 AND organization.last_sync_id=fence.organization_last_sync_id
WHERE fence.write_guard=1
  AND ((fence.projection_source_id='project-alpha:primary' AND NOT EXISTS (
      SELECT 1 FROM pa_connectors primary_connector WHERE primary_connector.source_id='project-alpha:primary'))
    OR EXISTS(SELECT 1 FROM pa_connectors visible_connector
      WHERE visible_connector.source_id=fence.projection_source_id AND visible_connector.read_visible=1))
  AND (SELECT count(*) FROM permissions required
    WHERE required.key IN ('team.view','organization.contacts.manage')
      AND (EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
            WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
            WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM staff_permission_overrides grant_row WHERE grant_row.staff_id=actor.id
            AND grant_row.permission_key=required.key AND grant_row.scope='global' AND grant_row.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny_row WHERE deny_row.staff_id=actor.id
        AND deny_row.permission_key=required.key AND deny_row.scope='global' AND deny_row.effect='deny'))=2
  AND NOT EXISTS(SELECT 1 FROM json_each(fence.contact_ids_json) wanted
    WHERE typeof(wanted.value)<>'text' OR NOT EXISTS(SELECT 1 FROM pa_clients contact
      WHERE contact.id=wanted.value AND contact.projection_source_id=fence.projection_source_id
        AND contact.organization_id=fence.organization_id AND contact.active=1))
  AND ((fence.expected_version=0 AND NOT EXISTS(SELECT 1 FROM organization_operational_contact_sets current
        WHERE current.projection_source_id=fence.projection_source_id AND current.organization_id=fence.organization_id))
    OR EXISTS(SELECT 1 FROM organization_operational_contact_sets current
      WHERE current.projection_source_id=fence.projection_source_id AND current.organization_id=fence.organization_id
        AND current.version IN (fence.expected_version,fence.expected_version+1)));

CREATE TRIGGER organization_operational_sets_guard_insert BEFORE INSERT ON organization_operational_contact_sets
WHEN NOT EXISTS(SELECT 1 FROM organization_operational_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.organization_id=NEW.organization_id
    AND fence.expected_version=0 AND fence.current_writes=1
    AND fence.actor_id=NEW.created_by AND fence.actor_id=NEW.updated_by)
BEGIN SELECT RAISE(ABORT,'organization operational write requires current context'); END;
CREATE TRIGGER organization_operational_sets_consume_insert AFTER INSERT ON organization_operational_contact_sets
BEGIN UPDATE organization_operational_write_fences SET current_writes=current_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND organization_id=NEW.organization_id; END;
CREATE TRIGGER organization_operational_sets_guard_update BEFORE UPDATE ON organization_operational_contact_sets
WHEN NOT EXISTS(SELECT 1 FROM organization_operational_live_write_fences fence
  WHERE fence.projection_source_id=OLD.projection_source_id AND fence.organization_id=OLD.organization_id
    AND fence.expected_version=OLD.version AND fence.current_writes=1 AND fence.actor_id=NEW.updated_by)
BEGIN SELECT RAISE(ABORT,'organization operational write requires current context'); END;
CREATE TRIGGER organization_operational_sets_consume_update AFTER UPDATE ON organization_operational_contact_sets
BEGIN UPDATE organization_operational_write_fences SET current_writes=current_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND organization_id=NEW.organization_id; END;

CREATE TRIGGER organization_operational_assignments_guard_insert BEFORE INSERT ON organization_operational_contact_assignments
WHEN NOT EXISTS(SELECT 1 FROM organization_operational_live_write_fences fence
  JOIN organization_operational_contact_sets current ON current.projection_source_id=fence.projection_source_id
    AND current.organization_id=fence.organization_id
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.organization_id=NEW.organization_id
    AND fence.current_writes=0 AND fence.assignment_deletes=0 AND fence.assignment_inserts>0
    AND fence.actor_id=NEW.created_by AND current.version=fence.expected_version+1
    AND EXISTS(SELECT 1 FROM pa_clients contact WHERE contact.id=NEW.contact_id
      AND contact.projection_source_id=NEW.projection_source_id AND contact.organization_id=NEW.organization_id AND contact.active=1))
BEGIN SELECT RAISE(ABORT,'organization operational write requires current context'); END;
CREATE TRIGGER organization_operational_assignments_consume_insert AFTER INSERT ON organization_operational_contact_assignments
BEGIN UPDATE organization_operational_write_fences SET assignment_inserts=assignment_inserts-1
  WHERE projection_source_id=NEW.projection_source_id AND organization_id=NEW.organization_id; END;
CREATE TRIGGER organization_operational_assignments_guard_delete BEFORE DELETE ON organization_operational_contact_assignments
WHEN NOT EXISTS(SELECT 1 FROM organization_operational_live_write_fences fence
  WHERE fence.projection_source_id=OLD.projection_source_id AND fence.organization_id=OLD.organization_id
    AND fence.current_writes=0 AND fence.assignment_deletes>0
    AND EXISTS(SELECT 1 FROM organization_operational_contact_sets current
      WHERE current.projection_source_id=fence.projection_source_id AND current.organization_id=fence.organization_id
        AND current.version=fence.expected_version+1))
BEGIN SELECT RAISE(ABORT,'organization operational write requires current context'); END;
CREATE TRIGGER organization_operational_assignments_consume_delete AFTER DELETE ON organization_operational_contact_assignments
BEGIN UPDATE organization_operational_write_fences SET assignment_deletes=assignment_deletes-1
  WHERE projection_source_id=OLD.projection_source_id AND organization_id=OLD.organization_id; END;
CREATE TRIGGER organization_operational_assignments_no_update BEFORE UPDATE ON organization_operational_contact_assignments
BEGIN SELECT RAISE(ABORT,'organization operational contact assignments are replaced, not updated'); END;

CREATE TRIGGER organization_operational_revisions_guard BEFORE INSERT ON organization_operational_contact_revisions
WHEN NOT EXISTS(SELECT 1 FROM organization_operational_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.organization_id=NEW.organization_id
    AND fence.current_writes=0 AND fence.assignment_deletes=0 AND fence.assignment_inserts=0
    AND fence.revision_writes=1 AND fence.actor_id=NEW.actor_id AND NEW.version=fence.expected_version+1)
BEGIN SELECT RAISE(ABORT,'organization operational write requires current context'); END;
CREATE TRIGGER organization_operational_revisions_consume AFTER INSERT ON organization_operational_contact_revisions
BEGIN UPDATE organization_operational_write_fences SET revision_writes=revision_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND organization_id=NEW.organization_id; END;

CREATE TRIGGER organization_operational_events_guard BEFORE INSERT ON organization_operational_events
WHEN NOT EXISTS(SELECT 1 FROM organization_operational_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.organization_id=NEW.organization_id
    AND NEW.event_kind='contacts_saved' AND fence.current_writes=0 AND fence.assignment_deletes=0
    AND fence.assignment_inserts=0 AND fence.revision_writes=0 AND fence.event_writes=1
    AND fence.actor_id=NEW.actor_id AND NEW.result_version=fence.expected_version+1)
BEGIN SELECT RAISE(ABORT,'organization operational write requires current context'); END;
CREATE TRIGGER organization_operational_events_consume AFTER INSERT ON organization_operational_events
BEGIN UPDATE organization_operational_write_fences SET event_writes=event_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND organization_id=NEW.organization_id; END;

CREATE TRIGGER organization_operational_mutations_guard BEFORE INSERT ON organization_operational_mutations
WHEN NOT EXISTS(SELECT 1 FROM organization_operational_live_write_fences fence
  WHERE fence.projection_source_id=NEW.projection_source_id AND fence.organization_id=NEW.organization_id
    AND NEW.operation_kind='contacts_save' AND fence.current_writes=0 AND fence.assignment_deletes=0
    AND fence.assignment_inserts=0 AND fence.revision_writes=0 AND fence.event_writes=0
    AND fence.mutation_writes=1 AND fence.actor_id=NEW.actor_id AND NEW.result_version=fence.expected_version+1)
BEGIN SELECT RAISE(ABORT,'organization operational write requires current context'); END;
CREATE TRIGGER organization_operational_mutations_consume AFTER INSERT ON organization_operational_mutations
BEGIN UPDATE organization_operational_write_fences SET mutation_writes=mutation_writes-1
  WHERE projection_source_id=NEW.projection_source_id AND organization_id=NEW.organization_id; END;

CREATE TRIGGER organization_operational_set_identity BEFORE UPDATE ON organization_operational_contact_sets
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id
  OR NEW.organization_record_kind IS NOT OLD.organization_record_kind OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.version<>OLD.version+1 OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'organization contact set identity or version is immutable'); END;
CREATE TRIGGER organization_operational_sets_no_delete BEFORE DELETE ON organization_operational_contact_sets
BEGIN SELECT RAISE(ABORT,'organization contact set history is persistent'); END;
CREATE TRIGGER organization_operational_revisions_no_update BEFORE UPDATE ON organization_operational_contact_revisions
BEGIN SELECT RAISE(ABORT,'organization contact revisions are immutable'); END;
CREATE TRIGGER organization_operational_revisions_no_delete BEFORE DELETE ON organization_operational_contact_revisions
BEGIN SELECT RAISE(ABORT,'organization contact revisions are immutable'); END;
CREATE TRIGGER organization_operational_events_no_update BEFORE UPDATE ON organization_operational_events
BEGIN SELECT RAISE(ABORT,'organization operational audit is immutable'); END;
CREATE TRIGGER organization_operational_events_no_delete BEFORE DELETE ON organization_operational_events
BEGIN SELECT RAISE(ABORT,'organization operational audit is immutable'); END;
CREATE TRIGGER organization_operational_mutations_no_update BEFORE UPDATE ON organization_operational_mutations
BEGIN SELECT RAISE(ABORT,'organization operational mutation receipts are immutable'); END;
CREATE TRIGGER organization_operational_mutations_no_delete BEFORE DELETE ON organization_operational_mutations
BEGIN SELECT RAISE(ABORT,'organization operational mutation receipts are immutable'); END;

PRAGMA foreign_keys = ON;
