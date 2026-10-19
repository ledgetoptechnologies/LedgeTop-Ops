-- Local division intent is independent of retired PA internal divisions.
-- Seed only the exact primary relationships already used by the old consumer.
-- A capabilities-verified runtime identity, not a resource observation or label.
-- Empty until a successful source preflight; legacy rows require reviewed stamping.
CREATE TABLE pa_local_division_source_heads (
  projection_source_id TEXT PRIMARY KEY,
  identity_key TEXT CHECK(identity_key IS NULL OR json_valid(identity_key)),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  verified_at TEXT
);
CREATE TABLE pa_local_division_mappings (
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('project','operation','task')),
  resource_id TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  identity_key TEXT CHECK(identity_key IS NULL OR json_valid(identity_key)),
  division_id TEXT REFERENCES divisions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version>=1),
  assignment_kind TEXT NOT NULL CHECK(assignment_kind IN ('legacy_exact','staff_reviewed')),
  assigned_by TEXT REFERENCES staff_users(id) ON DELETE RESTRICT,
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(resource_kind,resource_id,projection_source_id)
);
CREATE INDEX idx_pa_local_division_mappings_division ON pa_local_division_mappings(division_id,resource_kind);
INSERT INTO pa_local_division_mappings(resource_kind,resource_id,projection_source_id,division_id,version,assignment_kind)
  SELECT 'project',p.id,p.projection_source_id,d.id,1,'legacy_exact'
  FROM pa_projects p JOIN divisions d ON d.project_alpha_business_unit_id=p.business_unit_id
  WHERE p.projection_source_id='project-alpha:primary';
-- Preserve orphan/mismatched work scopes; otherwise work inherits its project.
INSERT INTO pa_local_division_mappings(resource_kind,resource_id,projection_source_id,division_id,version,assignment_kind)
  SELECT 'operation',o.id,o.projection_source_id,d.id,1,'legacy_exact'
  FROM pa_operations o LEFT JOIN divisions d ON d.project_alpha_business_unit_id=o.business_unit_id
  LEFT JOIN pa_local_division_mappings p ON p.resource_kind='project' AND p.resource_id=o.project_id AND p.projection_source_id=o.projection_source_id
  WHERE o.projection_source_id='project-alpha:primary' AND ((p.resource_id IS NULL AND d.id IS NOT NULL) OR (p.resource_id IS NOT NULL AND p.division_id IS NOT d.id));
INSERT INTO pa_local_division_mappings(resource_kind,resource_id,projection_source_id,division_id,version,assignment_kind)
  SELECT 'task',t.id,t.projection_source_id,d.id,1,'legacy_exact'
  FROM pa_tasks t LEFT JOIN divisions d ON d.project_alpha_business_unit_id=t.business_unit_id
  LEFT JOIN pa_local_division_mappings p ON p.resource_kind='project' AND p.resource_id=t.project_id AND p.projection_source_id=t.projection_source_id
  WHERE t.projection_source_id='project-alpha:primary' AND ((p.resource_id IS NULL AND d.id IS NOT NULL) OR (p.resource_id IS NOT NULL AND p.division_id IS NOT d.id));
CREATE TABLE pa_local_division_changes (
  operation_id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  identity_key TEXT NOT NULL CHECK(json_valid(identity_key)),
  previous_division_id TEXT,
  division_id TEXT,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE pa_local_division_mutation_guards (
  operation_id TEXT PRIMARY KEY,
  write_guard INTEGER NOT NULL CHECK(write_guard=1)
);
