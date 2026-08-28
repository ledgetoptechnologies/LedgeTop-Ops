PRAGMA foreign_keys = ON;

-- Copy-forward is an Operations-only convenience for already projected
-- projects. It never creates Alpha projects or changes billing, access,
-- invitations, lifecycle, notifications, attachments, or Delivery data.
CREATE TABLE project_operational_copy_receipts (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  preview_fingerprint TEXT NOT NULL CHECK(length(preview_fingerprint)=64 AND preview_fingerprint NOT GLOB '*[^0-9a-f]*'),
  projection_source_id TEXT NOT NULL,
  source_project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(source_project_record_kind='project'),
  source_project_id TEXT NOT NULL,
  destination_project_record_kind TEXT NOT NULL DEFAULT 'project' CHECK(destination_project_record_kind='project'),
  destination_project_id TEXT NOT NULL,
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  contact_roles_json TEXT NOT NULL CHECK(json_valid(contact_roles_json) AND length(contact_roles_json)<=100),
  memory_sections_json TEXT NOT NULL CHECK(json_valid(memory_sections_json) AND length(memory_sections_json)<=300),
  conflict_policy TEXT NOT NULL CHECK(conflict_policy IN ('keep_destination','replace_source')),
  source_contacts_version INTEGER NOT NULL CHECK(source_contacts_version>=0),
  destination_contacts_before INTEGER NOT NULL CHECK(destination_contacts_before>=0),
  destination_contacts_after INTEGER NOT NULL CHECK(destination_contacts_after>=0),
  source_memory_version INTEGER NOT NULL CHECK(source_memory_version>=0),
  destination_memory_before INTEGER NOT NULL CHECK(destination_memory_before>=0),
  destination_memory_after INTEGER NOT NULL CHECK(destination_memory_after>=0),
  copied_contact_count INTEGER NOT NULL CHECK(copied_contact_count BETWEEN 0 AND 100),
  copied_memory_section_count INTEGER NOT NULL CHECK(copied_memory_section_count BETWEEN 0 AND 8),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=4096),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id),
  FOREIGN KEY(projection_source_id,source_project_record_kind,source_project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,destination_project_record_kind,destination_project_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  FOREIGN KEY(projection_source_id,root_record_kind,root_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
  CHECK(source_project_id<>destination_project_id)
);
CREATE INDEX idx_project_operational_copy_receipts_destination
ON project_operational_copy_receipts(projection_source_id,destination_project_id,created_at DESC);

-- A short-lived fence is inserted and consumed inside the same D1 batch as
-- both destination overlays and the receipt. The view repeats live authority,
-- source/root/project, lifecycle, revision, and selected-contact checks. This
-- is sequencing defense in depth for the trusted service, not protection from
-- arbitrary D1 access.
CREATE TABLE project_operational_copy_fences (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  source_project_id TEXT NOT NULL,
  destination_project_id TEXT NOT NULL,
  root_record_kind TEXT NOT NULL CHECK(root_record_kind IN ('organization','client')),
  root_id TEXT NOT NULL,
  root_last_sync_id TEXT NOT NULL,
  source_project_last_sync_id TEXT NOT NULL,
  destination_project_last_sync_id TEXT NOT NULL,
  source_contacts_version INTEGER NOT NULL CHECK(source_contacts_version>=0),
  destination_contacts_version INTEGER NOT NULL CHECK(destination_contacts_version>=0),
  source_memory_version INTEGER NOT NULL CHECK(source_memory_version>=0),
  destination_memory_version INTEGER NOT NULL CHECK(destination_memory_version>=0),
  contacts_changes INTEGER NOT NULL CHECK(contacts_changes IN (0,1)),
  memory_changes INTEGER NOT NULL CHECK(memory_changes IN (0,1)),
  requires_contacts INTEGER NOT NULL CHECK(requires_contacts IN (0,1)),
  requires_memory INTEGER NOT NULL CHECK(requires_memory IN (0,1)),
  source_contact_ids_json TEXT NOT NULL CHECK(json_valid(source_contact_ids_json) AND length(source_contact_ids_json)<=65536),
  receipt_writes INTEGER NOT NULL DEFAULT 1 CHECK(receipt_writes BETWEEN 0 AND 1),
  write_guard INTEGER NOT NULL CONSTRAINT project_operational_copy_current_context CHECK(write_guard=1),
  PRIMARY KEY(actor_id,idempotency_key)
);

CREATE VIEW project_operational_live_copy_fences AS
SELECT fence.* FROM project_operational_copy_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id AND actor.status='active'
JOIN pa_projects source_project ON source_project.id=fence.source_project_id
  AND source_project.projection_source_id=fence.projection_source_id AND source_project.active=1
  AND source_project.last_sync_id=fence.source_project_last_sync_id
JOIN pa_projects destination_project ON destination_project.id=fence.destination_project_id
  AND destination_project.projection_source_id=fence.projection_source_id AND destination_project.active=1
  AND destination_project.status IN ('not_started','active','overdue')
  AND destination_project.last_sync_id=fence.destination_project_last_sync_id
LEFT JOIN pa_clients source_owner ON source_owner.id=source_project.client_id
  AND source_owner.projection_source_id=source_project.projection_source_id AND source_owner.active=1
LEFT JOIN pa_clients destination_owner ON destination_owner.id=destination_project.client_id
  AND destination_owner.projection_source_id=destination_project.projection_source_id AND destination_owner.active=1
LEFT JOIN pa_organizations organization_root ON fence.root_record_kind='organization'
  AND organization_root.id=fence.root_id AND organization_root.projection_source_id=fence.projection_source_id
  AND organization_root.active=1 AND organization_root.last_sync_id=fence.root_last_sync_id
LEFT JOIN pa_clients client_root ON fence.root_record_kind='client'
  AND client_root.id=fence.root_id AND client_root.projection_source_id=fence.projection_source_id
  AND client_root.active=1 AND client_root.organization_id IS NULL AND client_root.last_sync_id=fence.root_last_sync_id
WHERE fence.write_guard=1 AND fence.source_project_id<>fence.destination_project_id
  AND ((fence.projection_source_id='project-alpha:primary' AND NOT EXISTS(
      SELECT 1 FROM pa_connectors primary_connector WHERE primary_connector.source_id='project-alpha:primary'))
    OR EXISTS(SELECT 1 FROM pa_connectors visible_connector
      WHERE visible_connector.source_id=fence.projection_source_id AND visible_connector.read_visible=1))
  AND ((fence.root_record_kind='organization' AND organization_root.id IS NOT NULL
      AND (source_project.organization_id=fence.root_id OR (source_project.organization_id IS NULL AND source_owner.organization_id=fence.root_id))
      AND (destination_project.organization_id=fence.root_id OR (destination_project.organization_id IS NULL AND destination_owner.organization_id=fence.root_id)))
    OR (fence.root_record_kind='client' AND client_root.id IS NOT NULL
      AND source_project.client_id=fence.root_id AND source_project.organization_id IS NULL
      AND source_owner.id IS NOT NULL AND source_owner.organization_id IS NULL
      AND destination_project.client_id=fence.root_id AND destination_project.organization_id IS NULL
      AND destination_owner.id IS NOT NULL AND destination_owner.organization_id IS NULL))
  AND NOT EXISTS(SELECT 1 FROM json_each(fence.source_contact_ids_json) selected
    WHERE NOT EXISTS(SELECT 1 FROM pa_clients contact WHERE contact.id=selected.value
      AND contact.projection_source_id=fence.projection_source_id AND contact.active=1
      AND ((fence.root_record_kind='organization' AND contact.organization_id=fence.root_id)
        OR (fence.root_record_kind='client' AND contact.id=fence.root_id AND contact.organization_id IS NULL))))
  AND ((fence.source_contacts_version=0 AND NOT EXISTS(SELECT 1 FROM project_operational_contact_sets item
      WHERE item.projection_source_id=fence.projection_source_id AND item.project_id=fence.source_project_id))
    OR EXISTS(SELECT 1 FROM project_operational_contact_sets item WHERE item.projection_source_id=fence.projection_source_id
      AND item.project_id=fence.source_project_id AND item.version=fence.source_contacts_version))
  AND COALESCE((SELECT item.version FROM project_operational_contact_sets item
      WHERE item.projection_source_id=fence.projection_source_id AND item.project_id=fence.destination_project_id),0)
    BETWEEN fence.destination_contacts_version AND fence.destination_contacts_version+fence.contacts_changes
  AND ((fence.source_memory_version=0 AND NOT EXISTS(SELECT 1 FROM project_operational_memory item
      WHERE item.projection_source_id=fence.projection_source_id AND item.project_id=fence.source_project_id))
    OR EXISTS(SELECT 1 FROM project_operational_memory item WHERE item.projection_source_id=fence.projection_source_id
      AND item.project_id=fence.source_project_id AND item.version=fence.source_memory_version))
  AND COALESCE((SELECT item.version FROM project_operational_memory item
      WHERE item.projection_source_id=fence.projection_source_id AND item.project_id=fence.destination_project_id),0)
    BETWEEN fence.destination_memory_version AND fence.destination_memory_version+fence.memory_changes
  AND (SELECT count(*) FROM permissions required
    WHERE required.key IN ('team.view','projects.view')
      AND (EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
              WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
              WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM staff_permission_overrides grant_row WHERE grant_row.staff_id=actor.id
              AND grant_row.permission_key=required.key AND grant_row.scope='global' AND grant_row.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny_row WHERE deny_row.staff_id=actor.id
              AND deny_row.permission_key=required.key AND deny_row.scope='global' AND deny_row.effect='deny'))=2
  AND (fence.requires_contacts=0 OR EXISTS(SELECT 1 FROM permissions required WHERE required.key='project.contacts.manage'
      AND (EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
            WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
            WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM staff_permission_overrides grant_row WHERE grant_row.staff_id=actor.id
            AND grant_row.permission_key=required.key AND grant_row.scope='global' AND grant_row.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny_row WHERE deny_row.staff_id=actor.id
            AND deny_row.permission_key=required.key AND deny_row.scope='global' AND deny_row.effect='deny')))
  AND (fence.requires_memory=0 OR EXISTS(SELECT 1 FROM permissions required WHERE required.key='project.memory.manage'
      AND (EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
            WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions grant_row ON grant_row.role_id=assignment.role_id
            WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND grant_row.permission_key=required.key)
        OR EXISTS(SELECT 1 FROM staff_permission_overrides grant_row WHERE grant_row.staff_id=actor.id
            AND grant_row.permission_key=required.key AND grant_row.scope='global' AND grant_row.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny_row WHERE deny_row.staff_id=actor.id
            AND deny_row.permission_key=required.key AND deny_row.scope='global' AND deny_row.effect='deny')));

CREATE TRIGGER project_operational_copy_receipt_guard BEFORE INSERT ON project_operational_copy_receipts
WHEN NOT EXISTS(SELECT 1 FROM project_operational_live_copy_fences fence
  WHERE fence.actor_id=NEW.actor_id AND fence.idempotency_key=NEW.idempotency_key
    AND fence.projection_source_id=NEW.projection_source_id
    AND fence.source_project_id=NEW.source_project_id AND fence.destination_project_id=NEW.destination_project_id
    AND fence.root_record_kind=NEW.root_record_kind AND fence.root_id=NEW.root_id
    AND fence.receipt_writes=1)
BEGIN SELECT RAISE(ABORT,'project copy requires current context'); END;
CREATE TRIGGER project_operational_copy_receipt_consume AFTER INSERT ON project_operational_copy_receipts
BEGIN UPDATE project_operational_copy_fences SET receipt_writes=receipt_writes-1
  WHERE actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key; END;
CREATE TRIGGER project_operational_copy_receipts_no_update BEFORE UPDATE ON project_operational_copy_receipts
BEGIN SELECT RAISE(ABORT,'project copy provenance is immutable'); END;
CREATE TRIGGER project_operational_copy_receipts_no_delete BEFORE DELETE ON project_operational_copy_receipts
BEGIN SELECT RAISE(ABORT,'project copy provenance is immutable'); END;

PRAGMA foreign_keys = ON;
