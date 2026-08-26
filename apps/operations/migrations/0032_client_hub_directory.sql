PRAGMA foreign_keys = ON;

-- Each organization page counts its contacts. Bound the rows visited as well
-- as the result page, including when a source has many unrelated clients.
CREATE INDEX idx_pa_clients_client_hub_organization ON pa_clients(organization_id,active,id);

-- Explicit mapping lookup must not rescan all source JSON for every card.
-- Malformed legacy JSON remains unmapped; this never edits source payloads.
CREATE INDEX idx_pa_organizations_client_hub_public_id ON pa_organizations(
  CASE WHEN json_valid(payload_json) THEN
    CASE WHEN json_type(payload_json,'$.public_id')='text'
      THEN json_extract(payload_json,'$.public_id') END END
);
CREATE INDEX idx_pa_clients_client_hub_public_id ON pa_clients(
  CASE WHEN json_valid(payload_json) THEN
    CASE WHEN json_type(payload_json,'$.public_id')='text'
      THEN json_extract(payload_json,'$.public_id') END END
);

-- A staff-only, rebuildable business directory. These rows are not identities,
-- memberships, or grants. The legacy integrations still accept one Alpha only.
CREATE TABLE client_hub_roots (
  source_id TEXT NOT NULL CHECK (source_id IN ('project-alpha:primary','delivery:local')),
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
  account_count INTEGER NOT NULL DEFAULT 0 CHECK (account_count >= 0),
  project_count INTEGER NOT NULL DEFAULT 0 CHECK (project_count >= 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  contact_count INTEGER NOT NULL DEFAULT 0 CHECK (contact_count >= 0),
  meaningful_activity_at TEXT,
  source_version TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  scan_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id,root_namespace,kind,public_id),
  CHECK ((source_id='project-alpha:primary' AND root_namespace IN ('business','portal'))
    OR (source_id='delivery:local' AND root_namespace='account'))
);

CREATE INDEX idx_client_hub_roots_name
  ON client_hub_roots(sort_name,source_id,root_namespace,kind,public_id);
CREATE INDEX idx_client_hub_roots_kind_name
  ON client_hub_roots(kind,sort_name,source_id,root_namespace,public_id);
CREATE INDEX idx_client_hub_roots_workspace
  ON client_hub_roots(source_id,workspace_id,scan_generation,status,root_namespace);

CREATE TABLE client_hub_search_values (
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
    REFERENCES client_hub_roots(source_id,root_namespace,kind,public_id) ON DELETE CASCADE,
  CHECK (field <> 'project' OR project_id IS NOT NULL)
);

CREATE INDEX idx_client_hub_search_root
  ON client_hub_search_values(source_id,root_namespace,kind,root_public_id,field,normalized_value);

-- Effective changes advance revision in the same transaction as directory
-- writes. A cursor from an older revision must restart, not silently skip rows.
CREATE TABLE client_hub_directory_state (
  id TEXT PRIMARY KEY CHECK (id='directory'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0,1)),
  backfill_phase TEXT,
  backfill_cursor TEXT,
  last_success_at TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  lease_token TEXT,
  lease_until TEXT,
  next_run_at TEXT
);
INSERT INTO client_hub_directory_state(id) VALUES('directory');

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
