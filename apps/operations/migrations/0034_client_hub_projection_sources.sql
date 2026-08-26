-- The directory is a rebuildable display cache, never a source of grants.
-- Preserve existing root/search keys while allowing source-labeled business
-- roots. Portal namespaces remain strictly primary-source only.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE client_hub_roots_next (
  source_id TEXT NOT NULL,
  root_namespace TEXT NOT NULL DEFAULT 'business' CHECK (root_namespace IN ('business','portal','account')),
  kind TEXT NOT NULL CHECK (kind IN ('organization','standalone_client')),
  public_id TEXT NOT NULL,
  pa_public_id TEXT,
  mapping_status TEXT NOT NULL DEFAULT 'missing' CHECK (mapping_status IN ('mapped','missing','invalid','ambiguous','not_applicable')),
  display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL,
  status TEXT NOT NULL,
  portal_status TEXT NOT NULL DEFAULT 'not_provisioned',
  workspace_id TEXT,
  legacy_account_id TEXT,
  account_count INTEGER NOT NULL DEFAULT 0 CHECK (account_count>=0),
  project_count INTEGER NOT NULL DEFAULT 0 CHECK (project_count>=0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count>=0),
  contact_count INTEGER NOT NULL DEFAULT 0 CHECK (contact_count>=0),
  meaningful_activity_at TEXT,
  source_version TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  scan_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id,root_namespace,kind,public_id),
  CHECK ((root_namespace='business' AND substr(source_id,1,14)='project-alpha:'
      AND length(source_id) BETWEEN 15 AND 78
      AND substr(source_id,15,1) GLOB '[a-z0-9]'
      AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*')
    OR (source_id='project-alpha:primary' AND root_namespace='portal')
    OR (source_id='delivery:local' AND root_namespace='account')),
  CHECK (source_id IN ('project-alpha:primary','delivery:local') OR
    (workspace_id IS NULL AND legacy_account_id IS NULL AND account_count=0 AND project_count=0 AND request_count=0))
);
INSERT INTO client_hub_roots_next SELECT * FROM client_hub_roots;

CREATE TABLE client_hub_search_values_next (
  source_id TEXT NOT NULL,
  root_namespace TEXT NOT NULL DEFAULT 'business' CHECK (root_namespace IN ('business','portal','account')),
  kind TEXT NOT NULL,
  root_public_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('name','contact','email','phone','project')),
  normalized_value TEXT NOT NULL,
  project_id TEXT,
  scan_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id,root_namespace,kind,root_public_id,record_type,record_id,field),
  FOREIGN KEY (source_id,root_namespace,kind,root_public_id)
    REFERENCES client_hub_roots_next(source_id,root_namespace,kind,public_id) ON DELETE CASCADE,
  CHECK (field<>'project' OR project_id IS NOT NULL)
);
INSERT INTO client_hub_search_values_next SELECT * FROM client_hub_search_values;
DROP TABLE client_hub_search_values;
DROP TABLE client_hub_roots;
ALTER TABLE client_hub_roots_next RENAME TO client_hub_roots;
ALTER TABLE client_hub_search_values_next RENAME TO client_hub_search_values;

CREATE INDEX idx_client_hub_roots_name ON client_hub_roots(sort_name,source_id,root_namespace,kind,public_id);
CREATE INDEX idx_client_hub_roots_kind_name ON client_hub_roots(kind,sort_name,source_id,root_namespace,public_id);
CREATE INDEX idx_client_hub_roots_workspace ON client_hub_roots(source_id,workspace_id,scan_generation,status,root_namespace);
CREATE INDEX idx_client_hub_search_root ON client_hub_search_values(source_id,root_namespace,kind,root_public_id,field,normalized_value);

CREATE TRIGGER client_hub_root_insert AFTER INSERT ON client_hub_roots
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_root_delete AFTER DELETE ON client_hub_roots
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_root_change AFTER UPDATE ON client_hub_roots
WHEN OLD.source_id IS NOT NEW.source_id OR OLD.kind IS NOT NEW.kind OR OLD.public_id IS NOT NEW.public_id
  OR OLD.root_namespace IS NOT NEW.root_namespace OR OLD.pa_public_id IS NOT NEW.pa_public_id
  OR OLD.mapping_status IS NOT NEW.mapping_status
  OR OLD.display_name IS NOT NEW.display_name OR OLD.sort_name IS NOT NEW.sort_name
  OR OLD.status IS NOT NEW.status OR OLD.portal_status IS NOT NEW.portal_status
  OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.legacy_account_id IS NOT NEW.legacy_account_id
  OR OLD.account_count IS NOT NEW.account_count OR OLD.project_count IS NOT NEW.project_count
  OR OLD.request_count IS NOT NEW.request_count OR OLD.contact_count IS NOT NEW.contact_count
  OR OLD.meaningful_activity_at IS NOT NEW.meaningful_activity_at
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_search_insert AFTER INSERT ON client_hub_search_values
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_search_delete AFTER DELETE ON client_hub_search_values
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_search_change AFTER UPDATE ON client_hub_search_values
WHEN OLD.source_id IS NOT NEW.source_id OR OLD.kind IS NOT NEW.kind OR OLD.root_public_id IS NOT NEW.root_public_id
  OR OLD.root_namespace IS NOT NEW.root_namespace
  OR OLD.record_type IS NOT NEW.record_type OR OLD.record_id IS NOT NEW.record_id OR OLD.field IS NOT NEW.field
  OR OLD.normalized_value IS NOT NEW.normalized_value OR OLD.project_id IS NOT NEW.project_id
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;

-- Restart the bounded display-cache scan; old primary URLs and rows are kept.
UPDATE client_hub_directory_state SET revision=revision+1,backfill_phase=NULL,
  backfill_cursor=NULL,next_run_at=NULL,lease_token=NULL,lease_until=NULL,
  generation=generation+1 WHERE id='directory';

CREATE INDEX idx_pa_clients_source_organization ON pa_clients(projection_source_id,organization_id,active,id);
CREATE INDEX idx_pa_projects_source_client ON pa_projects(projection_source_id,client_id,active,id);
CREATE INDEX idx_pa_projects_source_organization ON pa_projects(projection_source_id,organization_id,active,id);
CREATE INDEX idx_pa_organizations_source_public_id ON pa_organizations(projection_source_id,
  CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.public_id')='text'
    THEN json_extract(payload_json,'$.public_id') END END);
CREATE INDEX idx_pa_clients_source_public_id ON pa_clients(projection_source_id,
  CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.public_id')='text'
    THEN json_extract(payload_json,'$.public_id') END END);
CREATE INDEX idx_pa_projects_source_public_id ON pa_projects(projection_source_id,
  CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.public_id')='text'
    THEN json_extract(payload_json,'$.public_id') END END);
