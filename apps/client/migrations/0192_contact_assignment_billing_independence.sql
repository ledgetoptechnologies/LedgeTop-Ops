PRAGMA foreign_keys = ON;

-- Migration 0190 originally encoded primary_billing => send_project_invoices,
-- but Project Alpha models those as independent project-scoped responsibilities.
-- Rebuild both leaf tables so already-migrated databases receive the corrected
-- domain rule while preserving every row and all schema/endpoint fences.

CREATE TABLE pa_portal_projection_contact_assignments_v2 (
  generation_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  contact_public_id TEXT NOT NULL,
  client_public_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization','standalone_client','department','client','project')),
  scope_public_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    length(role) BETWEEN 1 AND 50 AND role=lower(role)
    AND substr(role,1,1) GLOB '[a-z]' AND role NOT GLOB '*[^a-z0-9_.:-]*'
  ),
  primary_contact INTEGER NOT NULL CHECK (primary_contact IN (0,1)),
  primary_billing INTEGER NOT NULL CHECK (primary_billing IN (0,1)),
  send_project_invoices INTEGER NOT NULL CHECK (send_project_invoices IN (0,1)),
  can_view_invoice_links INTEGER NOT NULL CHECK (can_view_invoice_links IN (0,1)),
  source_version TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  PRIMARY KEY (generation_id,public_id),
  UNIQUE (generation_id,scope_type,scope_public_id,contact_public_id),
  CHECK (scope_type<>'project' OR primary_contact=0),
  CHECK (scope_type='project' OR (primary_billing=0 AND send_project_invoices=0 AND can_view_invoice_links=0)),
  FOREIGN KEY (generation_id) REFERENCES pa_portal_projection_generations(id) ON DELETE CASCADE
);

INSERT INTO pa_portal_projection_contact_assignments_v2
  (generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
   primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active)
SELECT generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
  primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active
FROM pa_portal_projection_contact_assignments;

DROP TABLE pa_portal_projection_contact_assignments;
ALTER TABLE pa_portal_projection_contact_assignments_v2 RENAME TO pa_portal_projection_contact_assignments;

CREATE TRIGGER pa_portal_projection_contact_assignment_contract_insert
BEFORE INSERT ON pa_portal_projection_contact_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_generation_contracts base
  JOIN pa_portal_projection_contact_assignment_contracts extension
    ON extension.generation_id=base.generation_id AND extension.schema_version=4
  WHERE base.generation_id=NEW.generation_id AND base.schema_version=3
)
BEGIN SELECT RAISE(ABORT,'portal v4 staged contact assignment requires schema v4'); END;

CREATE TRIGGER pa_portal_projection_contact_assignment_contract_update
BEFORE UPDATE ON pa_portal_projection_contact_assignments
WHEN NEW.generation_id IS NOT OLD.generation_id OR NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_generation_contracts base
  JOIN pa_portal_projection_contact_assignment_contracts extension
    ON extension.generation_id=base.generation_id AND extension.schema_version=4
  WHERE base.generation_id=NEW.generation_id AND base.schema_version=3
)
BEGIN SELECT RAISE(ABORT,'portal v4 staged contact assignment requires schema v4'); END;

CREATE TABLE portal_v2_contact_assignments_v2 (
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  contact_public_id TEXT NOT NULL,
  client_public_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization','standalone_client','department','client','project')),
  scope_public_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    length(role) BETWEEN 1 AND 50 AND role=lower(role)
    AND substr(role,1,1) GLOB '[a-z]' AND role NOT GLOB '*[^a-z0-9_.:-]*'
  ),
  primary_contact INTEGER NOT NULL CHECK (primary_contact IN (0,1)),
  primary_billing INTEGER NOT NULL CHECK (primary_billing IN (0,1)),
  send_project_invoices INTEGER NOT NULL CHECK (send_project_invoices IN (0,1)),
  can_view_invoice_links INTEGER NOT NULL CHECK (can_view_invoice_links IN (0,1)),
  source_version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id,generation_id,public_id),
  UNIQUE (workspace_id,generation_id,scope_type,scope_public_id,contact_public_id),
  CHECK (scope_type<>'project' OR primary_contact=0),
  CHECK (scope_type='project' OR (primary_billing=0 AND send_project_invoices=0 AND can_view_invoice_links=0)),
  FOREIGN KEY (generation_id,workspace_id)
    REFERENCES portal_v2_directory_generations(id,workspace_id) ON DELETE CASCADE
);

INSERT INTO portal_v2_contact_assignments_v2
  (workspace_id,generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
   primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active,created_at)
SELECT workspace_id,generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
  primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active,created_at
FROM portal_v2_contact_assignments;

DROP TABLE portal_v2_contact_assignments;
ALTER TABLE portal_v2_contact_assignments_v2 RENAME TO portal_v2_contact_assignments;

CREATE INDEX idx_portal_v2_contact_assignments_scope
  ON portal_v2_contact_assignments(workspace_id,generation_id,scope_type,scope_public_id,active);
CREATE INDEX idx_portal_v2_contact_assignments_contact
  ON portal_v2_contact_assignments(workspace_id,generation_id,contact_public_id,active);

CREATE TRIGGER portal_v2_contact_assignment_contract_insert
BEFORE INSERT ON portal_v2_contact_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_generation_contracts base
  JOIN portal_v2_contact_assignment_contracts extension
    ON extension.workspace_id=base.workspace_id AND extension.generation_id=base.generation_id AND extension.schema_version=4
  WHERE base.generation_id=NEW.generation_id AND base.workspace_id=NEW.workspace_id AND base.schema_version=3
)
BEGIN SELECT RAISE(ABORT,'portal v4 contact assignment requires schema v4'); END;

CREATE TRIGGER portal_v2_contact_assignment_contract_update
BEFORE UPDATE ON portal_v2_contact_assignments
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.generation_id IS NOT OLD.generation_id OR NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_generation_contracts base
  JOIN portal_v2_contact_assignment_contracts extension
    ON extension.workspace_id=base.workspace_id AND extension.generation_id=base.generation_id AND extension.schema_version=4
  WHERE base.generation_id=NEW.generation_id AND base.workspace_id=NEW.workspace_id AND base.schema_version=3
)
BEGIN SELECT RAISE(ABORT,'portal v4 contact assignment requires schema v4'); END;

CREATE TRIGGER portal_v2_contact_assignment_endpoints_insert
BEFORE INSERT ON portal_v2_contact_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities entity WHERE entity.workspace_id=NEW.workspace_id
    AND entity.generation_id=NEW.generation_id AND entity.entity_type='contact'
    AND entity.public_id=NEW.contact_public_id AND (NEW.active=0 OR entity.active=1)
) OR NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities entity WHERE entity.workspace_id=NEW.workspace_id
    AND entity.generation_id=NEW.generation_id AND entity.entity_type IN ('client','standalone_client')
    AND entity.public_id=NEW.client_public_id AND (NEW.active=0 OR entity.active=1)
) OR NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities entity WHERE entity.workspace_id=NEW.workspace_id
    AND entity.generation_id=NEW.generation_id AND entity.entity_type=NEW.scope_type
    AND entity.public_id=NEW.scope_public_id AND (NEW.active=0 OR entity.active=1)
)
BEGIN SELECT RAISE(ABORT,'portal v4 contact assignment endpoints must exist in generation'); END;
CREATE TRIGGER portal_v2_contact_assignment_endpoints_update
BEFORE UPDATE ON portal_v2_contact_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities entity WHERE entity.workspace_id=NEW.workspace_id
    AND entity.generation_id=NEW.generation_id AND entity.entity_type='contact'
    AND entity.public_id=NEW.contact_public_id AND (NEW.active=0 OR entity.active=1)
) OR NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities entity WHERE entity.workspace_id=NEW.workspace_id
    AND entity.generation_id=NEW.generation_id AND entity.entity_type IN ('client','standalone_client')
    AND entity.public_id=NEW.client_public_id AND (NEW.active=0 OR entity.active=1)
) OR NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities entity WHERE entity.workspace_id=NEW.workspace_id
    AND entity.generation_id=NEW.generation_id AND entity.entity_type=NEW.scope_type
    AND entity.public_id=NEW.scope_public_id AND (NEW.active=0 OR entity.active=1)
)
BEGIN SELECT RAISE(ABORT,'portal v4 contact assignment endpoints must exist in generation'); END;
