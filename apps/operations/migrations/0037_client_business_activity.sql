-- Source-record activity only, never page views, sync clocks, access grants,
-- tasks, deliveries or financial audit. Existing known source dates are
-- observations, not reconstructed human actions. No source payload/actor stored.
CREATE TABLE client_business_activity_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO client_business_activity_state(singleton) VALUES(1);

CREATE TABLE client_business_activity(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 projection_source_id TEXT NOT NULL CHECK(substr(projection_source_id,1,14)='project-alpha:'
  AND length(projection_source_id) BETWEEN 15 AND 78 AND substr(projection_source_id,15,1) GLOB '[a-z0-9]'
  AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*' AND instr(projection_source_id,char(0))=0),
 event_key TEXT NOT NULL CHECK(length(event_key) BETWEEN 1 AND 8192 AND instr(event_key,char(0))=0),
 origin TEXT NOT NULL CHECK(origin IN ('projection_event','source_observation')),
 record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client','project')),
 record_id TEXT NOT NULL,
 root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
 root_id TEXT NOT NULL,
 root_record_kind TEXT NOT NULL CHECK(root_record_kind=CASE root_kind WHEN 'organization' THEN 'organization' ELSE 'client' END),
 action TEXT NOT NULL CHECK(action IN ('upsert','revoke','source_record_updated')),
 occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
  AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)
  AND strftime('%Y-%m-%d',substr(occurred_at,1,10),'+0 days')=substr(occurred_at,1,10)
  AND substr(occurred_at,12,2) BETWEEN '00' AND '23' AND substr(occurred_at,15,2) BETWEEN '00' AND '59'
  AND substr(occurred_at,18,2) BETWEEN '00' AND '59'),
 source_updated_at TEXT NOT NULL CHECK(length(source_updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',source_updated_at) IS NOT NULL
  AND source_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',source_updated_at)
  AND strftime('%Y-%m-%d',substr(source_updated_at,1,10),'+0 days')=substr(source_updated_at,1,10)
  AND substr(source_updated_at,12,2) BETWEEN '00' AND '23' AND substr(source_updated_at,15,2) BETWEEN '00' AND '59'
  AND substr(source_updated_at,18,2) BETWEEN '00' AND '59'),
 observed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((origin='source_observation' AND action='source_record_updated') OR
       (origin='projection_event' AND action IN ('upsert','revoke'))),
 UNIQUE(projection_source_id,event_key),
 FOREIGN KEY(projection_source_id,record_kind,record_id)
  REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id),
 FOREIGN KEY(projection_source_id,root_record_kind,root_id)
  REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id)
);
CREATE INDEX idx_client_business_activity_root ON client_business_activity(projection_source_id,root_kind,root_id,occurred_at DESC,sequence DESC);
CREATE INDEX idx_client_business_activity_record ON client_business_activity(projection_source_id,record_kind,record_id,occurred_at DESC,sequence DESC);
CREATE INDEX idx_client_business_activity_version ON client_business_activity(projection_source_id,record_kind,record_id,source_updated_at,origin);
CREATE TRIGGER client_business_activity_no_update BEFORE UPDATE ON client_business_activity
BEGIN SELECT RAISE(ABORT,'business activity is immutable'); END;
CREATE TRIGGER client_business_activity_no_delete BEFORE DELETE ON client_business_activity
BEGIN SELECT RAISE(ABORT,'business activity is immutable'); END;
CREATE TRIGGER client_business_activity_no_replace BEFORE INSERT ON client_business_activity
WHEN EXISTS(SELECT 1 FROM client_business_activity existing WHERE existing.sequence=NEW.sequence
 OR (existing.projection_source_id=NEW.projection_source_id AND existing.event_key=NEW.event_key))
BEGIN SELECT RAISE(ABORT,'business activity identity is immutable'); END;
CREATE TRIGGER client_business_activity_revision AFTER INSERT ON client_business_activity
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE VIEW client_business_activity_records AS
SELECT o.projection_source_id,'organization' record_kind,o.id record_id,o.name record_name,
 'organization' root_kind,o.id root_id,'organization' root_record_kind,o.active readable,
 o.payload_json,o.last_sync_id
FROM pa_organizations o
UNION ALL
SELECT c.projection_source_id,'client',c.id,c.name,
 CASE WHEN c.organization_id IS NULL THEN 'standalone_client' ELSE 'organization' END,
 COALESCE(c.organization_id,c.id),CASE WHEN c.organization_id IS NULL THEN 'client' ELSE 'organization' END,
 CASE WHEN c.active=1 AND (c.organization_id IS NULL OR o.active=1) THEN 1 ELSE 0 END,
 c.payload_json,c.last_sync_id
FROM pa_clients c LEFT JOIN pa_organizations o ON o.id=c.organization_id AND o.projection_source_id=c.projection_source_id
UNION ALL
SELECT p.projection_source_id,'project',p.id,p.name,
 CASE WHEN COALESCE(p.organization_id,c.organization_id) IS NOT NULL THEN 'organization' ELSE 'standalone_client' END,
 COALESCE(p.organization_id,c.organization_id,c.id),
 CASE WHEN COALESCE(p.organization_id,c.organization_id) IS NOT NULL THEN 'organization' ELSE 'client' END,
 CASE WHEN p.active=1 AND (o.active=1 OR (p.organization_id IS NULL AND c.organization_id IS NULL AND c.active=1)) THEN 1 ELSE 0 END,
 p.payload_json,p.last_sync_id
FROM pa_projects p LEFT JOIN pa_clients c ON c.id=p.client_id AND c.projection_source_id=p.projection_source_id AND c.active=1
 LEFT JOIN pa_organizations o ON o.id=COALESCE(p.organization_id,c.organization_id) AND o.projection_source_id=p.projection_source_id;

CREATE VIEW client_business_activity_observations AS
WITH raw AS (
 SELECT *,CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.updated_at')='text'
   THEN json_extract(payload_json,'$.updated_at') END END source_time
 FROM client_business_activity_records
), zoned AS (
 SELECT *,CASE WHEN substr(source_time,-1)='Z' THEN 'Z'
  WHEN substr(source_time,-6,1) IN ('+','-') THEN substr(source_time,-6) ELSE '' END zone
 FROM raw
), fractional AS (
 SELECT *,substr(source_time,20,length(source_time)-19-length(zone)) fraction FROM zoned
), dated AS (
 SELECT *,CASE WHEN length(source_time) BETWEEN 19 AND 35
  AND instr(source_time,char(0))=0 AND source_time NOT GLOB '*[^0-9T Z:+.-]*'
  AND substr(source_time,1,10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND substr(source_time,11,1) IN ('T',' ') AND substr(source_time,14,1)=':' AND substr(source_time,17,1)=':'
  AND substr(source_time,12,2) GLOB '[0-9][0-9]' AND substr(source_time,12,2) BETWEEN '00' AND '23'
  AND substr(source_time,15,2) GLOB '[0-9][0-9]' AND substr(source_time,15,2) BETWEEN '00' AND '59'
  AND substr(source_time,18,2) GLOB '[0-9][0-9]' AND substr(source_time,18,2) BETWEEN '00' AND '59'
  AND (fraction='' OR (length(fraction) BETWEEN 2 AND 10 AND substr(fraction,1,1)='.'
    AND substr(fraction,2) NOT GLOB '*[^0-9]*'))
  AND (zone IN ('','Z') OR (length(zone)=6 AND substr(zone,1,1) IN ('+','-')
    AND substr(zone,2,2) GLOB '[0-9][0-9]' AND substr(zone,2,2) BETWEEN '00' AND '23'
    AND substr(zone,4,1)=':' AND substr(zone,5,2) GLOB '[0-9][0-9]' AND substr(zone,5,2) BETWEEN '00' AND '59'))
  AND strftime('%Y-%m-%d',substr(source_time,1,10),'+0 days')=substr(source_time,1,10)
  THEN strftime('%Y-%m-%dT%H:%M:%fZ',substr(source_time,1,19) ||
    CASE WHEN fraction='' THEN '' ELSE '.'||substr(substr(fraction,2)||'000',1,3) END || zone) END occurred_at
 FROM fractional
)
SELECT projection_source_id,record_kind,record_id,root_kind,root_id,root_record_kind,occurred_at,
 'observation:'||json_array(record_kind,record_id,occurred_at) event_key
FROM dated WHERE occurred_at IS NOT NULL AND root_id IS NOT NULL
 AND readable=1 AND COALESCE(last_sync_id,'') NOT LIKE 'event:%';

-- Preserve all previous source records, IDs and timestamps. This backfill only
-- records explicitly supplied, valid source timestamps with resolvable owners.
INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
SELECT projection_source_id,event_key,'source_observation',record_kind,record_id,root_kind,root_id,root_record_kind,'source_record_updated',occurred_at,occurred_at
FROM client_business_activity_observations;

CREATE TRIGGER pa_organizations_business_activity_insert AFTER INSERT ON pa_organizations
BEGIN
 INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
 SELECT observation.projection_source_id,observation.event_key,'source_observation',observation.record_kind,observation.record_id,
  observation.root_kind,observation.root_id,observation.root_record_kind,'source_record_updated',observation.occurred_at,observation.occurred_at
 FROM client_business_activity_observations observation
 WHERE observation.projection_source_id=NEW.projection_source_id AND observation.record_kind='organization' AND observation.record_id=NEW.id
  AND NOT EXISTS(SELECT 1 FROM client_business_activity existing WHERE existing.projection_source_id=observation.projection_source_id
    AND existing.event_key=observation.event_key);
END;

CREATE TRIGGER pa_organizations_business_activity_update AFTER UPDATE OF payload_json,last_sync_id ON pa_organizations
BEGIN
 INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
 SELECT observation.projection_source_id,observation.event_key,'source_observation',observation.record_kind,observation.record_id,
  observation.root_kind,observation.root_id,observation.root_record_kind,'source_record_updated',observation.occurred_at,observation.occurred_at
 FROM client_business_activity_observations observation
 WHERE observation.projection_source_id=NEW.projection_source_id AND observation.record_kind='organization' AND observation.record_id=NEW.id
  AND NOT EXISTS(SELECT 1 FROM client_business_activity existing WHERE existing.projection_source_id=observation.projection_source_id
    AND existing.event_key=observation.event_key);
END;

CREATE TRIGGER pa_clients_business_activity_insert AFTER INSERT ON pa_clients
BEGIN
 INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
 SELECT observation.projection_source_id,observation.event_key,'source_observation',observation.record_kind,observation.record_id,
  observation.root_kind,observation.root_id,observation.root_record_kind,'source_record_updated',observation.occurred_at,observation.occurred_at
 FROM client_business_activity_observations observation
 WHERE observation.projection_source_id=NEW.projection_source_id AND observation.record_kind='client' AND observation.record_id=NEW.id
  AND NOT EXISTS(SELECT 1 FROM client_business_activity existing WHERE existing.projection_source_id=observation.projection_source_id
    AND existing.event_key=observation.event_key);
END;

CREATE TRIGGER pa_clients_business_activity_update AFTER UPDATE OF payload_json,last_sync_id ON pa_clients
BEGIN
 INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
 SELECT observation.projection_source_id,observation.event_key,'source_observation',observation.record_kind,observation.record_id,
  observation.root_kind,observation.root_id,observation.root_record_kind,'source_record_updated',observation.occurred_at,observation.occurred_at
 FROM client_business_activity_observations observation
 WHERE observation.projection_source_id=NEW.projection_source_id AND observation.record_kind='client' AND observation.record_id=NEW.id
  AND NOT EXISTS(SELECT 1 FROM client_business_activity existing WHERE existing.projection_source_id=observation.projection_source_id
    AND existing.event_key=observation.event_key);
END;

CREATE TRIGGER pa_projects_business_activity_insert AFTER INSERT ON pa_projects
BEGIN
 INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
 SELECT observation.projection_source_id,observation.event_key,'source_observation',observation.record_kind,observation.record_id,
  observation.root_kind,observation.root_id,observation.root_record_kind,'source_record_updated',observation.occurred_at,observation.occurred_at
 FROM client_business_activity_observations observation
 WHERE observation.projection_source_id=NEW.projection_source_id AND observation.record_kind='project' AND observation.record_id=NEW.id
  AND NOT EXISTS(SELECT 1 FROM client_business_activity existing WHERE existing.projection_source_id=observation.projection_source_id
    AND existing.event_key=observation.event_key);
END;

CREATE TRIGGER pa_projects_business_activity_update AFTER UPDATE OF payload_json,last_sync_id ON pa_projects
BEGIN
 INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
 SELECT observation.projection_source_id,observation.event_key,'source_observation',observation.record_kind,observation.record_id,
  observation.root_kind,observation.root_id,observation.root_record_kind,'source_record_updated',observation.occurred_at,observation.occurred_at
 FROM client_business_activity_observations observation
 WHERE observation.projection_source_id=NEW.projection_source_id AND observation.record_kind='project' AND observation.record_id=NEW.id
  AND NOT EXISTS(SELECT 1 FROM client_business_activity existing WHERE existing.projection_source_id=observation.projection_source_id
    AND existing.event_key=observation.event_key);
END;

CREATE TRIGGER pa_organizations_activity_scope_insert AFTER INSERT ON pa_organizations

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_organizations_activity_scope_delete AFTER DELETE ON pa_organizations

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_organizations_activity_scope_update AFTER UPDATE OF active,name ON pa_organizations
WHEN OLD.active IS NOT NEW.active OR OLD.name IS NOT NEW.name
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_clients_activity_scope_insert AFTER INSERT ON pa_clients

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_clients_activity_scope_delete AFTER DELETE ON pa_clients

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_clients_activity_scope_update AFTER UPDATE OF active,organization_id,name ON pa_clients
WHEN OLD.active IS NOT NEW.active OR OLD.organization_id IS NOT NEW.organization_id OR OLD.name IS NOT NEW.name
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_projects_activity_scope_insert AFTER INSERT ON pa_projects

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_projects_activity_scope_delete AFTER DELETE ON pa_projects

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_projects_activity_scope_update AFTER UPDATE OF active,client_id,organization_id,manager_user_id,business_unit_id,name ON pa_projects
WHEN OLD.active IS NOT NEW.active OR OLD.client_id IS NOT NEW.client_id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.manager_user_id IS NOT NEW.manager_user_id OR OLD.business_unit_id IS NOT NEW.business_unit_id OR OLD.name IS NOT NEW.name
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_project_assignments_activity_scope_insert AFTER INSERT ON pa_project_assignments

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_project_assignments_activity_scope_delete AFTER DELETE ON pa_project_assignments

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_project_assignments_activity_scope_update AFTER UPDATE OF project_id,user_id,active ON pa_project_assignments
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.user_id IS NOT NEW.user_id OR OLD.active IS NOT NEW.active
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_operations_activity_scope_insert AFTER INSERT ON pa_operations

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_operations_activity_scope_delete AFTER DELETE ON pa_operations

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_operations_activity_scope_update AFTER UPDATE OF project_id,active ON pa_operations
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.active IS NOT NEW.active
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_operation_assignments_activity_scope_insert AFTER INSERT ON pa_operation_assignments

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_operation_assignments_activity_scope_delete AFTER DELETE ON pa_operation_assignments

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_operation_assignments_activity_scope_update AFTER UPDATE OF operation_id,user_id,active ON pa_operation_assignments
WHEN OLD.operation_id IS NOT NEW.operation_id OR OLD.user_id IS NOT NEW.user_id OR OLD.active IS NOT NEW.active
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_tasks_activity_scope_insert AFTER INSERT ON pa_tasks

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_tasks_activity_scope_delete AFTER DELETE ON pa_tasks

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_tasks_activity_scope_update AFTER UPDATE OF project_id,active ON pa_tasks
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.active IS NOT NEW.active
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_task_assignments_activity_scope_insert AFTER INSERT ON pa_task_assignments

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_task_assignments_activity_scope_delete AFTER DELETE ON pa_task_assignments

BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER pa_task_assignments_activity_scope_update AFTER UPDATE OF task_id,user_id,active ON pa_task_assignments
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.user_id IS NOT NEW.user_id OR OLD.active IS NOT NEW.active
BEGIN UPDATE client_business_activity_state SET revision=revision+1 WHERE singleton=1; END;
