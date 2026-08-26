PRAGMA foreign_keys = ON;

-- Source-qualified coordination and immutable local record handles. This does
-- not register or enable a second producer. Primary handles remain byte-for-byte
-- identical; payload_json, local grants, job briefs and folder paths are untouched.
-- Calendar/airspace source_id already identifies an entity, NOT its producer.
CREATE TABLE pa_projection_record_ids (
  projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('user','business_unit','client','organization','project','project_assignment','service_location','application_entitlement','operation','task','calendar_event','contract','invoice')),
  external_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (projection_source_id,record_kind,external_id),
  UNIQUE (record_kind,local_id),
  UNIQUE (projection_source_id,record_kind,local_id),
  CHECK (projection_source_id<>'project-alpha:primary' OR local_id=external_id)
);

ALTER TABLE pa_users ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_users_projection_source ON pa_users(projection_source_id);

ALTER TABLE pa_business_units ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_business_units_projection_source ON pa_business_units(projection_source_id);

ALTER TABLE pa_worker_business_units ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_worker_business_units_projection_source ON pa_worker_business_units(projection_source_id);

ALTER TABLE pa_clients ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_clients_projection_source ON pa_clients(projection_source_id);

ALTER TABLE pa_organizations ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_organizations_projection_source ON pa_organizations(projection_source_id);

ALTER TABLE pa_projects ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_projects_projection_source ON pa_projects(projection_source_id);

ALTER TABLE pa_project_assignments ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_project_assignments_projection_source ON pa_project_assignments(projection_source_id);

ALTER TABLE pa_service_locations ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_service_locations_projection_source ON pa_service_locations(projection_source_id);

ALTER TABLE pa_application_entitlements ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_application_entitlements_projection_source ON pa_application_entitlements(projection_source_id);

ALTER TABLE pa_operations ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_operations_projection_source ON pa_operations(projection_source_id);

ALTER TABLE pa_operation_assignments ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_operation_assignments_projection_source ON pa_operation_assignments(projection_source_id);

ALTER TABLE pa_tasks ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_tasks_projection_source ON pa_tasks(projection_source_id);

ALTER TABLE pa_task_assignments ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_task_assignments_projection_source ON pa_task_assignments(projection_source_id);

ALTER TABLE pa_calendar_events ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_calendar_events_projection_source ON pa_calendar_events(projection_source_id);

ALTER TABLE pa_operation_airspace_matches ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
CREATE INDEX idx_pa_operation_airspace_matches_projection_source ON pa_operation_airspace_matches(projection_source_id);

-- Reserve every historical reference, including dangling/inactive records.
-- A reservation is not an active record and confers no access.
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',id,id FROM pa_users
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','business_unit',id,id FROM pa_business_units
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',user_id,user_id FROM pa_worker_business_units
WHERE user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','business_unit',business_unit_id,business_unit_id FROM pa_worker_business_units
WHERE business_unit_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','client',id,id FROM pa_clients
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','organization',organization_id,organization_id FROM pa_clients
WHERE organization_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','organization',id,id FROM pa_organizations
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','project',id,id FROM pa_projects
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','client',client_id,client_id FROM pa_projects
WHERE client_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','organization',organization_id,organization_id FROM pa_projects
WHERE organization_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','business_unit',business_unit_id,business_unit_id FROM pa_projects
WHERE business_unit_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',manager_user_id,manager_user_id FROM pa_projects
WHERE manager_user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','project_assignment',id,id FROM pa_project_assignments
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','project',project_id,project_id FROM pa_project_assignments
WHERE project_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',user_id,user_id FROM pa_project_assignments
WHERE user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','service_location',id,id FROM pa_service_locations
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','project',project_id,project_id FROM pa_service_locations
WHERE project_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','client',client_id,client_id FROM pa_service_locations
WHERE client_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','organization',organization_id,organization_id FROM pa_service_locations
WHERE organization_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','application_entitlement',id,id FROM pa_application_entitlements
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',user_id,user_id FROM pa_application_entitlements
WHERE user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','operation',id,id FROM pa_operations
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','project',project_id,project_id FROM pa_operations
WHERE project_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','business_unit',business_unit_id,business_unit_id FROM pa_operations
WHERE business_unit_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',created_by_user_id,created_by_user_id FROM pa_operations
WHERE created_by_user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','operation',operation_id,operation_id FROM pa_operation_assignments
WHERE operation_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',user_id,user_id FROM pa_operation_assignments
WHERE user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',assigned_by_user_id,assigned_by_user_id FROM pa_operation_assignments
WHERE assigned_by_user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','task',id,id FROM pa_tasks
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','operation',operation_id,operation_id FROM pa_tasks
WHERE operation_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','project',project_id,project_id FROM pa_tasks
WHERE project_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','business_unit',business_unit_id,business_unit_id FROM pa_tasks
WHERE business_unit_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',assignee_user_id,assignee_user_id FROM pa_tasks
WHERE assignee_user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',created_by_user_id,created_by_user_id FROM pa_tasks
WHERE created_by_user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','task',task_id,task_id FROM pa_task_assignments
WHERE task_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',user_id,user_id FROM pa_task_assignments
WHERE user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',assigned_by_user_id,assigned_by_user_id FROM pa_task_assignments
WHERE assigned_by_user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','calendar_event',id,id FROM pa_calendar_events
WHERE id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','project',project_id,project_id FROM pa_calendar_events
WHERE project_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','business_unit',business_unit_id,business_unit_id FROM pa_calendar_events
WHERE business_unit_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary',source_type,source_id,source_id FROM pa_calendar_events
WHERE source_id IS NOT NULL AND source_type IN ('operation','task','contract','invoice');
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','operation',operation_id,operation_id FROM pa_operation_airspace_matches
WHERE operation_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','user',project_alpha_user_id,project_alpha_user_id FROM staff_users
WHERE project_alpha_user_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','business_unit',project_alpha_business_unit_id,project_alpha_business_unit_id FROM divisions
WHERE project_alpha_business_unit_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','project',project_id,project_id FROM project_folders
WHERE project_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary','operation',operation_id,operation_id FROM operational_job_briefs
WHERE operation_id IS NOT NULL;
INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
SELECT 'project-alpha:primary',context_kind,context_id,context_id FROM work_context_sop_link_sets
WHERE context_id IS NOT NULL AND context_kind IN ('project','task');

-- REPLACE deletes do not reliably fire DELETE triggers with recursive_triggers
-- disabled. Guard conflicting inserts too; equivalent existing tuples are safe.
CREATE TRIGGER pa_projection_record_ids_no_replacement
BEFORE INSERT ON pa_projection_record_ids
WHEN EXISTS (
  SELECT 1 FROM pa_projection_record_ids existing
  WHERE existing.projection_source_id=NEW.projection_source_id
    AND existing.record_kind=NEW.record_kind AND existing.external_id=NEW.external_id
    AND existing.local_id IS NOT NEW.local_id
) OR EXISTS (
  SELECT 1 FROM pa_projection_record_ids existing
  WHERE existing.record_kind=NEW.record_kind AND existing.local_id=NEW.local_id
    AND (existing.projection_source_id IS NOT NEW.projection_source_id OR existing.external_id IS NOT NEW.external_id)
)
BEGIN
  SELECT RAISE(ABORT,'projection record identity is immutable');
END;
CREATE TRIGGER pa_projection_record_ids_no_reassignment
BEFORE UPDATE ON pa_projection_record_ids
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.record_kind IS NOT OLD.record_kind
  OR NEW.external_id IS NOT OLD.external_id OR NEW.local_id IS NOT OLD.local_id
BEGIN
  SELECT RAISE(ABORT,'projection record identity is immutable');
END;
CREATE TRIGGER pa_projection_record_ids_no_delete
BEFORE DELETE ON pa_projection_record_ids
BEGIN
  SELECT RAISE(ABORT,'projection record reservations cannot be deleted');
END;

-- Primary defaults are compatible with old inserts: register only exact primary
-- IDs, then validate the typed source relation. A known foreign local handle
-- can never be adopted by primary. Secondary writers must preallocate mappings.
CREATE TRIGGER pa_users_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_users
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_users_source_guard_insert
BEFORE INSERT ON pa_users
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.id
  );
END;
CREATE TRIGGER pa_users_source_guard_update
BEFORE UPDATE ON pa_users
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.id
  );
END;
CREATE TRIGGER pa_business_units_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_business_units
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_business_units_source_guard_insert
BEFORE INSERT ON pa_business_units
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.id
  );
END;
CREATE TRIGGER pa_business_units_source_guard_update
BEFORE UPDATE ON pa_business_units
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.id
  );
END;
CREATE TRIGGER pa_worker_business_units_source_immutable
BEFORE UPDATE OF projection_source_id ON pa_worker_business_units
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_worker_business_units_source_guard_insert
BEFORE INSERT ON pa_worker_business_units
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
END;
CREATE TRIGGER pa_worker_business_units_source_guard_update
BEFORE UPDATE ON pa_worker_business_units
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
END;
CREATE TRIGGER pa_clients_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_clients
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_clients_source_guard_insert
BEFORE INSERT ON pa_clients
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','client',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='client'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='client' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','organization',NEW.organization_id,NEW.organization_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.organization_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='organization'
        AND existing.external_id=NEW.organization_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='organization' AND local_id=NEW.organization_id
  );
END;
CREATE TRIGGER pa_clients_source_guard_update
BEFORE UPDATE ON pa_clients
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','client',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='client'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='client' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','organization',NEW.organization_id,NEW.organization_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.organization_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='organization'
        AND existing.external_id=NEW.organization_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='organization' AND local_id=NEW.organization_id
  );
END;
CREATE TRIGGER pa_organizations_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_organizations
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_organizations_source_guard_insert
BEFORE INSERT ON pa_organizations
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','organization',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='organization'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='organization' AND local_id=NEW.id
  );
END;
CREATE TRIGGER pa_organizations_source_guard_update
BEFORE UPDATE ON pa_organizations
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','organization',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='organization'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='organization' AND local_id=NEW.id
  );
END;
CREATE TRIGGER pa_projects_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_projects
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_projects_source_guard_insert
BEFORE INSERT ON pa_projects
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','client',NEW.client_id,NEW.client_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='client'
        AND existing.external_id=NEW.client_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='client' AND local_id=NEW.client_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','organization',NEW.organization_id,NEW.organization_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.organization_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='organization'
        AND existing.external_id=NEW.organization_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='organization' AND local_id=NEW.organization_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.manager_user_id,NEW.manager_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.manager_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.manager_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.manager_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.manager_user_id
  );
END;
CREATE TRIGGER pa_projects_source_guard_update
BEFORE UPDATE ON pa_projects
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','client',NEW.client_id,NEW.client_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='client'
        AND existing.external_id=NEW.client_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='client' AND local_id=NEW.client_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','organization',NEW.organization_id,NEW.organization_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.organization_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='organization'
        AND existing.external_id=NEW.organization_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='organization' AND local_id=NEW.organization_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.manager_user_id,NEW.manager_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.manager_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.manager_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.manager_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.manager_user_id
  );
END;
CREATE TRIGGER pa_project_assignments_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_project_assignments
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_project_assignments_source_guard_insert
BEFORE INSERT ON pa_project_assignments
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project_assignment',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project_assignment'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project_assignment' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
END;
CREATE TRIGGER pa_project_assignments_source_guard_update
BEFORE UPDATE ON pa_project_assignments
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project_assignment',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project_assignment'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project_assignment' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
END;
CREATE TRIGGER pa_service_locations_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_service_locations
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_service_locations_source_guard_insert
BEFORE INSERT ON pa_service_locations
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','service_location',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='service_location'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='service_location' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','client',NEW.client_id,NEW.client_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='client'
        AND existing.external_id=NEW.client_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='client' AND local_id=NEW.client_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','organization',NEW.organization_id,NEW.organization_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.organization_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='organization'
        AND existing.external_id=NEW.organization_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='organization' AND local_id=NEW.organization_id
  );
END;
CREATE TRIGGER pa_service_locations_source_guard_update
BEFORE UPDATE ON pa_service_locations
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','service_location',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='service_location'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='service_location' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','client',NEW.client_id,NEW.client_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='client'
        AND existing.external_id=NEW.client_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='client' AND local_id=NEW.client_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','organization',NEW.organization_id,NEW.organization_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.organization_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='organization'
        AND existing.external_id=NEW.organization_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='organization' AND local_id=NEW.organization_id
  );
END;
CREATE TRIGGER pa_application_entitlements_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_application_entitlements
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_application_entitlements_source_guard_insert
BEFORE INSERT ON pa_application_entitlements
BEGIN
  SELECT RAISE(ABORT,'secondary source has no staff authority') WHERE NEW.projection_source_id<>'project-alpha:primary';
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','application_entitlement',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='application_entitlement'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='application_entitlement' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
END;
CREATE TRIGGER pa_application_entitlements_source_guard_update
BEFORE UPDATE ON pa_application_entitlements
BEGIN
  SELECT RAISE(ABORT,'secondary source has no staff authority') WHERE NEW.projection_source_id<>'project-alpha:primary';
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','application_entitlement',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='application_entitlement'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='application_entitlement' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
END;
CREATE TRIGGER pa_operations_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_operations
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_operations_source_guard_insert
BEFORE INSERT ON pa_operations
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','operation',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='operation'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='operation' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.created_by_user_id,NEW.created_by_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.created_by_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.created_by_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.created_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.created_by_user_id
  );
END;
CREATE TRIGGER pa_operations_source_guard_update
BEFORE UPDATE ON pa_operations
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','operation',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='operation'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='operation' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.created_by_user_id,NEW.created_by_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.created_by_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.created_by_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.created_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.created_by_user_id
  );
END;
CREATE TRIGGER pa_operation_assignments_source_immutable
BEFORE UPDATE OF projection_source_id ON pa_operation_assignments
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_operation_assignments_source_guard_insert
BEFORE INSERT ON pa_operation_assignments
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','operation',NEW.operation_id,NEW.operation_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.operation_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='operation'
        AND existing.external_id=NEW.operation_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='operation' AND local_id=NEW.operation_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.assigned_by_user_id,NEW.assigned_by_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.assigned_by_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.assigned_by_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.assigned_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.assigned_by_user_id
  );
END;
CREATE TRIGGER pa_operation_assignments_source_guard_update
BEFORE UPDATE ON pa_operation_assignments
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','operation',NEW.operation_id,NEW.operation_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.operation_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='operation'
        AND existing.external_id=NEW.operation_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='operation' AND local_id=NEW.operation_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.assigned_by_user_id,NEW.assigned_by_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.assigned_by_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.assigned_by_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.assigned_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.assigned_by_user_id
  );
END;
CREATE TRIGGER pa_tasks_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_tasks
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_tasks_source_guard_insert
BEFORE INSERT ON pa_tasks
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','task',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='task'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='task' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','operation',NEW.operation_id,NEW.operation_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.operation_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='operation'
        AND existing.external_id=NEW.operation_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='operation' AND local_id=NEW.operation_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.assignee_user_id,NEW.assignee_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.assignee_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.assignee_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.assignee_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.assignee_user_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.created_by_user_id,NEW.created_by_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.created_by_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.created_by_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.created_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.created_by_user_id
  );
END;
CREATE TRIGGER pa_tasks_source_guard_update
BEFORE UPDATE ON pa_tasks
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','task',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='task'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='task' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','operation',NEW.operation_id,NEW.operation_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.operation_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='operation'
        AND existing.external_id=NEW.operation_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='operation' AND local_id=NEW.operation_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.assignee_user_id,NEW.assignee_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.assignee_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.assignee_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.assignee_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.assignee_user_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.created_by_user_id,NEW.created_by_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.created_by_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.created_by_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.created_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.created_by_user_id
  );
END;
CREATE TRIGGER pa_task_assignments_source_immutable
BEFORE UPDATE OF projection_source_id ON pa_task_assignments
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_task_assignments_source_guard_insert
BEFORE INSERT ON pa_task_assignments
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','task',NEW.task_id,NEW.task_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.task_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='task'
        AND existing.external_id=NEW.task_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='task' AND local_id=NEW.task_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.assigned_by_user_id,NEW.assigned_by_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.assigned_by_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.assigned_by_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.assigned_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.assigned_by_user_id
  );
END;
CREATE TRIGGER pa_task_assignments_source_guard_update
BEFORE UPDATE ON pa_task_assignments
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','task',NEW.task_id,NEW.task_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.task_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='task'
        AND existing.external_id=NEW.task_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='task' AND local_id=NEW.task_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.user_id,NEW.user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.user_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','user',NEW.assigned_by_user_id,NEW.assigned_by_user_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.assigned_by_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='user'
        AND existing.external_id=NEW.assigned_by_user_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.assigned_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='user' AND local_id=NEW.assigned_by_user_id
  );
END;
CREATE TRIGGER pa_calendar_events_source_immutable
BEFORE UPDATE OF projection_source_id,id ON pa_calendar_events
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_calendar_events_source_guard_insert
BEFORE INSERT ON pa_calendar_events
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','calendar_event',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='calendar_event'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='calendar_event' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary',NEW.source_type,NEW.source_id,NEW.source_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.source_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind=NEW.source_type
        AND existing.external_id=NEW.source_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind=NEW.source_type AND local_id=NEW.source_id
  );
END;
CREATE TRIGGER pa_calendar_events_source_guard_update
BEFORE UPDATE ON pa_calendar_events
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','calendar_event',NEW.id,NEW.id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='calendar_event'
        AND existing.external_id=NEW.id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='calendar_event' AND local_id=NEW.id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','project',NEW.project_id,NEW.project_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='project'
        AND existing.external_id=NEW.project_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='project' AND local_id=NEW.project_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','business_unit',NEW.business_unit_id,NEW.business_unit_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.business_unit_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='business_unit'
        AND existing.external_id=NEW.business_unit_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='business_unit' AND local_id=NEW.business_unit_id
  );
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary',NEW.source_type,NEW.source_id,NEW.source_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.source_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind=NEW.source_type
        AND existing.external_id=NEW.source_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind=NEW.source_type AND local_id=NEW.source_id
  );
END;
CREATE TRIGGER pa_operation_airspace_matches_source_immutable
BEFORE UPDATE OF projection_source_id ON pa_operation_airspace_matches
WHEN NEW.projection_source_id IS NOT OLD.projection_source_id
BEGIN
  SELECT RAISE(ABORT,'projection row provenance is immutable');
END;
CREATE TRIGGER pa_operation_airspace_matches_source_guard_insert
BEFORE INSERT ON pa_operation_airspace_matches
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','operation',NEW.operation_id,NEW.operation_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.operation_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='operation'
        AND existing.external_id=NEW.operation_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='operation' AND local_id=NEW.operation_id
  );
END;
CREATE TRIGGER pa_operation_airspace_matches_source_guard_update
BEFORE UPDATE ON pa_operation_airspace_matches
BEGIN
  INSERT OR IGNORE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
  SELECT 'project-alpha:primary','operation',NEW.operation_id,NEW.operation_id
  WHERE NEW.projection_source_id='project-alpha:primary' AND NEW.operation_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pa_projection_record_ids existing
      WHERE existing.projection_source_id='project-alpha:primary' AND existing.record_kind='operation'
        AND existing.external_id=NEW.operation_id);
  SELECT RAISE(ABORT,'projection relationship source mismatch')
  WHERE NEW.operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=NEW.projection_source_id
      AND record_kind='operation' AND local_id=NEW.operation_id
  );
END;

-- Coordination IDs stay ORIGINAL EXTERNAL IDs, now scoped by producer.
-- No record payload/receipt hash is rewritten during primary adoption.
CREATE TABLE pa_projection_fingerprints_sources (
  projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  collection TEXT NOT NULL CHECK (collection IN ('users','business_units','worker_business_units','clients','organizations','projects','project_assignments','service_locations','application_entitlements','operations','operation_assignments','tasks','task_assignments','calendar_events')),
  fingerprint TEXT NOT NULL,last_sync_id TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (projection_source_id,collection)
);
INSERT INTO pa_projection_fingerprints_sources(collection,fingerprint,last_sync_id,updated_at) SELECT collection,fingerprint,last_sync_id,updated_at FROM pa_projection_fingerprints;
DROP TABLE pa_projection_fingerprints;
ALTER TABLE pa_projection_fingerprints_sources RENAME TO pa_projection_fingerprints;
CREATE TABLE pa_projection_entity_versions_sources (
  projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,source_updated_at TEXT NOT NULL,event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(projection_source_id,entity_type,entity_id)
);
INSERT INTO pa_projection_entity_versions_sources(entity_type,entity_id,source_updated_at,event_id,updated_at) SELECT entity_type,entity_id,source_updated_at,event_id,updated_at FROM pa_projection_entity_versions;
DROP TABLE pa_projection_entity_versions;
ALTER TABLE pa_projection_entity_versions_sources RENAME TO pa_projection_entity_versions;
CREATE TABLE pa_projection_entity_leases_sources (
  projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,owner_event_id TEXT NOT NULL,lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(projection_source_id,entity_type,entity_id)
);
INSERT INTO pa_projection_entity_leases_sources(entity_type,entity_id,owner_event_id,lease_until,updated_at) SELECT entity_type,entity_id,owner_event_id,lease_until,updated_at FROM pa_projection_entity_leases;
DROP TABLE pa_projection_entity_leases;
ALTER TABLE pa_projection_entity_leases_sources RENAME TO pa_projection_entity_leases;
CREATE TABLE integration_event_receipts_sources (
  projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  event_id TEXT NOT NULL,integration TEXT NOT NULL,event_type TEXT NOT NULL,user_id TEXT NOT NULL,occurred_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','completed','ignored')),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),processed_at TEXT,last_error TEXT,
  PRIMARY KEY(projection_source_id,event_id)
);
INSERT INTO integration_event_receipts_sources(event_id,integration,event_type,user_id,occurred_at,payload_hash,status,received_at,processed_at,last_error) SELECT event_id,integration,event_type,user_id,occurred_at,payload_hash,status,received_at,processed_at,last_error FROM integration_event_receipts;
DROP TABLE integration_event_receipts;
ALTER TABLE integration_event_receipts_sources RENAME TO integration_event_receipts;
CREATE TABLE integration_reconciliation_sources (
  projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  integration TEXT NOT NULL,last_event_at TEXT,last_access_attempt_at TEXT,last_access_success_at TEXT,last_access_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),access_consecutive_failures INTEGER NOT NULL DEFAULT 0,access_circuit_open_until TEXT,
  PRIMARY KEY(projection_source_id,integration)
);
INSERT INTO integration_reconciliation_sources(integration,last_event_at,last_access_attempt_at,last_access_success_at,last_access_error,updated_at,access_consecutive_failures,access_circuit_open_until) SELECT integration,last_event_at,last_access_attempt_at,last_access_success_at,last_access_error,updated_at,access_consecutive_failures,access_circuit_open_until FROM integration_reconciliation;
DROP TABLE integration_reconciliation;
ALTER TABLE integration_reconciliation_sources RENAME TO integration_reconciliation;
CREATE TABLE integration_health_sources (
  projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  integration TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('healthy','stale','error','disabled','unknown')),
  last_attempt_at TEXT,last_success_at TEXT,last_error_code TEXT,details_json TEXT,updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,circuit_open_until TEXT,PRIMARY KEY(projection_source_id,integration)
);
INSERT INTO integration_health_sources(integration,status,last_attempt_at,last_success_at,last_error_code,details_json,updated_at,consecutive_failures,circuit_open_until) SELECT integration,status,last_attempt_at,last_success_at,last_error_code,details_json,updated_at,consecutive_failures,circuit_open_until FROM integration_health;
DROP TABLE integration_health;
ALTER TABLE integration_health_sources RENAME TO integration_health;

CREATE INDEX idx_pa_projection_entity_leases_expiry ON pa_projection_entity_leases(projection_source_id,lease_until);
CREATE INDEX idx_integration_event_user_time ON integration_event_receipts(projection_source_id,integration,user_id,occurred_at DESC);
ALTER TABLE sync_runs ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary' CHECK (length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,1,14)='project-alpha:' AND substr(projection_source_id,15,1) GLOB '[a-z0-9]' AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*');
DROP INDEX idx_sync_runs_integration;
CREATE INDEX idx_sync_runs_integration ON sync_runs(projection_source_id,integration,started_at DESC);
