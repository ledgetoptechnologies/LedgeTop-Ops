PRAGMA foreign_keys = ON;

-- Additive compatibility layer for Project Alpha's non-tree directory. Runtime
-- reads remain disabled unless CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true.
CREATE TABLE IF NOT EXISTS portal_v2_directory_relations (
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('contains','contact_assignment')),
  from_type TEXT NOT NULL CHECK (from_type IN ('organization','standalone_client','department','client','project','contact')),
  from_public_id TEXT NOT NULL,
  to_type TEXT NOT NULL CHECK (to_type IN ('organization','standalone_client','department','client','project','contact')),
  to_public_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id,generation_id,public_id),
  UNIQUE (workspace_id,generation_id,relation_type,from_type,from_public_id,to_type,to_public_id),
  FOREIGN KEY (generation_id,workspace_id)
    REFERENCES portal_v2_directory_generations(id,workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_relations_to
  ON portal_v2_directory_relations(workspace_id,generation_id,to_type,to_public_id,active);
CREATE INDEX IF NOT EXISTS idx_portal_v2_relations_from
  ON portal_v2_directory_relations(workspace_id,generation_id,from_type,from_public_id,active);

CREATE TABLE IF NOT EXISTS portal_v2_directory_generation_contracts (
  generation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (2,3)),
  PRIMARY KEY (generation_id,workspace_id),
  FOREIGN KEY (generation_id,workspace_id)
    REFERENCES portal_v2_directory_generations(id,workspace_id) ON DELETE CASCADE
);

-- Generations created before schema-version contracts existed are schema v2.
-- INSERT OR IGNORE makes the upgrade safe to rerun without overwriting a
-- contract already recorded by the receiver.
INSERT OR IGNORE INTO portal_v2_directory_generation_contracts
  (generation_id,workspace_id,schema_version)
SELECT id,workspace_id,2 FROM portal_v2_directory_generations;

DROP TRIGGER IF EXISTS portal_v2_relation_endpoints_insert;
CREATE TRIGGER portal_v2_relation_endpoints_insert
BEFORE INSERT ON portal_v2_directory_relations
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities e WHERE e.workspace_id=NEW.workspace_id
    AND e.generation_id=NEW.generation_id AND e.entity_type=NEW.from_type
    AND e.public_id=NEW.from_public_id
) OR NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities e WHERE e.workspace_id=NEW.workspace_id
    AND e.generation_id=NEW.generation_id AND e.entity_type=NEW.to_type
    AND e.public_id=NEW.to_public_id
)
BEGIN
  SELECT RAISE(ABORT, 'portal v2 relation endpoints must exist in generation');
END;

DROP TRIGGER IF EXISTS portal_v2_relation_endpoints_update;
CREATE TRIGGER portal_v2_relation_endpoints_update
BEFORE UPDATE ON portal_v2_directory_relations
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities e WHERE e.workspace_id=NEW.workspace_id
    AND e.generation_id=NEW.generation_id AND e.entity_type=NEW.from_type
    AND e.public_id=NEW.from_public_id
) OR NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities e WHERE e.workspace_id=NEW.workspace_id
    AND e.generation_id=NEW.generation_id AND e.entity_type=NEW.to_type
    AND e.public_id=NEW.to_public_id
)
BEGIN
  SELECT RAISE(ABORT, 'portal v2 relation endpoints must exist in generation');
END;

DROP TRIGGER IF EXISTS portal_v2_relation_shape_insert;
CREATE TRIGGER portal_v2_relation_shape_insert
BEFORE INSERT ON portal_v2_directory_relations
WHEN NEW.from_public_id=NEW.to_public_id
OR (NEW.relation_type='contact_assignment' AND NOT (
  NEW.from_type IN ('organization','standalone_client','department','client','project') AND NEW.to_type='contact'
)) OR (NEW.relation_type='contains' AND NOT (
  (NEW.from_type='organization' AND NEW.to_type IN ('department','client','project'))
  OR (NEW.from_type='standalone_client' AND NEW.to_type='project')
  OR (NEW.from_type IN ('department','client') AND NEW.to_type='project')
))
BEGIN
  SELECT RAISE(ABORT, 'portal v2 relation shape is invalid');
END;

DROP TRIGGER IF EXISTS portal_v2_relation_shape_update;
CREATE TRIGGER portal_v2_relation_shape_update
BEFORE UPDATE ON portal_v2_directory_relations
WHEN NEW.from_public_id=NEW.to_public_id
OR (NEW.relation_type='contact_assignment' AND NOT (
  NEW.from_type IN ('organization','standalone_client','department','client','project') AND NEW.to_type='contact'
)) OR (NEW.relation_type='contains' AND NOT (
  (NEW.from_type='organization' AND NEW.to_type IN ('department','client','project'))
  OR (NEW.from_type='standalone_client' AND NEW.to_type='project')
  OR (NEW.from_type IN ('department','client') AND NEW.to_type='project')
))
BEGIN
  SELECT RAISE(ABORT, 'portal v2 relation shape is invalid');
END;

CREATE TABLE IF NOT EXISTS portal_v2_project_lifecycle (
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active','completed')),
  completed_at TEXT,
  source_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id,generation_id,project_public_id),
  CHECK (
    (lifecycle_status='active' AND completed_at IS NULL)
    OR (lifecycle_status='completed' AND completed_at IS NOT NULL AND datetime(completed_at) IS NOT NULL)
  ),
  FOREIGN KEY (generation_id,workspace_id)
    REFERENCES portal_v2_directory_generations(id,workspace_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS portal_v2_project_lifecycle_entity_insert
BEFORE INSERT ON portal_v2_project_lifecycle
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_entities e WHERE e.workspace_id=NEW.workspace_id
    AND e.generation_id=NEW.generation_id AND e.entity_type='project'
    AND e.public_id=NEW.project_public_id
)
BEGIN
  SELECT RAISE(ABORT, 'portal v2 lifecycle project must exist in generation');
END;

-- Signed PA snapshot staging. These rows become authoritative only when the
-- containing projection generation is fully validated and activated.
CREATE TABLE IF NOT EXISTS pa_portal_projection_relations (
  generation_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('contains','contact_assignment')),
  from_type TEXT NOT NULL,
  from_public_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_public_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  PRIMARY KEY (generation_id,public_id),
  FOREIGN KEY (generation_id) REFERENCES pa_portal_projection_generations(id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS pa_portal_projection_relation_endpoints_insert;
CREATE TRIGGER pa_portal_projection_relation_endpoints_insert
BEFORE INSERT ON pa_portal_projection_relations
WHEN NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_entities e WHERE e.generation_id=NEW.generation_id
    AND e.entity_type=NEW.from_type AND e.public_id=NEW.from_public_id
) OR NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_entities e WHERE e.generation_id=NEW.generation_id
    AND e.entity_type=NEW.to_type AND e.public_id=NEW.to_public_id
)
BEGIN
  SELECT RAISE(ABORT, 'portal v2 staged relation endpoints must exist in generation');
END;

DROP TRIGGER IF EXISTS pa_portal_projection_relation_endpoints_update;
CREATE TRIGGER pa_portal_projection_relation_endpoints_update
BEFORE UPDATE ON pa_portal_projection_relations
WHEN NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_entities e WHERE e.generation_id=NEW.generation_id
    AND e.entity_type=NEW.from_type AND e.public_id=NEW.from_public_id
) OR NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_entities e WHERE e.generation_id=NEW.generation_id
    AND e.entity_type=NEW.to_type AND e.public_id=NEW.to_public_id
)
BEGIN
  SELECT RAISE(ABORT, 'portal v2 staged relation endpoints must exist in generation');
END;

DROP TRIGGER IF EXISTS pa_portal_projection_relation_shape_insert;
CREATE TRIGGER pa_portal_projection_relation_shape_insert
BEFORE INSERT ON pa_portal_projection_relations
WHEN NEW.from_public_id=NEW.to_public_id
OR (NEW.relation_type='contact_assignment' AND NOT (
  NEW.from_type IN ('organization','standalone_client','department','client','project') AND NEW.to_type='contact'
)) OR (NEW.relation_type='contains' AND NOT (
  (NEW.from_type='organization' AND NEW.to_type IN ('department','client','project'))
  OR (NEW.from_type='standalone_client' AND NEW.to_type='project')
  OR (NEW.from_type IN ('department','client') AND NEW.to_type='project')
))
BEGIN
  SELECT RAISE(ABORT, 'portal v2 staged relation shape is invalid');
END;

DROP TRIGGER IF EXISTS pa_portal_projection_relation_shape_update;
CREATE TRIGGER pa_portal_projection_relation_shape_update
BEFORE UPDATE ON pa_portal_projection_relations
WHEN NEW.from_public_id=NEW.to_public_id
OR (NEW.relation_type='contact_assignment' AND NOT (
  NEW.from_type IN ('organization','standalone_client','department','client','project') AND NEW.to_type='contact'
)) OR (NEW.relation_type='contains' AND NOT (
  (NEW.from_type='organization' AND NEW.to_type IN ('department','client','project'))
  OR (NEW.from_type='standalone_client' AND NEW.to_type='project')
  OR (NEW.from_type IN ('department','client') AND NEW.to_type='project')
))
BEGIN
  SELECT RAISE(ABORT, 'portal v2 staged relation shape is invalid');
END;

CREATE TABLE IF NOT EXISTS pa_portal_projection_generation_contracts (
  generation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (2,3)),
  FOREIGN KEY (generation_id) REFERENCES pa_portal_projection_generations(id) ON DELETE CASCADE
);

-- Existing active and in-progress projection generations predate schema v3.
-- Preserve their ordered v2 stream contract across this additive migration.
INSERT OR IGNORE INTO pa_portal_projection_generation_contracts
  (generation_id,schema_version)
SELECT id,2 FROM pa_portal_projection_generations;

CREATE TABLE IF NOT EXISTS pa_portal_projection_project_lifecycle (
  generation_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active','completed')),
  completed_at TEXT,
  source_version TEXT NOT NULL,
  PRIMARY KEY (generation_id,project_public_id),
  CHECK ((lifecycle_status='active' AND completed_at IS NULL)
    OR (lifecycle_status='completed' AND completed_at IS NOT NULL AND datetime(completed_at) IS NOT NULL)),
  FOREIGN KEY (generation_id) REFERENCES pa_portal_projection_generations(id) ON DELETE CASCADE
);
