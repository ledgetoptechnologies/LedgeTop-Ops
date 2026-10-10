PRAGMA foreign_keys = ON;

-- API-v2 inventory is retained as immutable evidence before any native Ops
-- record, canonical mapping, portal workspace, Delivery row, or public link is
-- allowed to change.  These tables deliberately do not project customer data.
CREATE TABLE project_alpha_api_v2_inventory_receipts (
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,1,14)='project-alpha:'
    AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  inventory_kind TEXT NOT NULL CHECK(inventory_kind IN ('directory','project')),
  request_id TEXT NOT NULL CHECK(length(request_id)=36),
  authorization_generation TEXT NOT NULL CHECK(
    authorization_generation GLOB '[0-9]*'
    AND authorization_generation NOT GLOB '*[^0-9]*'
    AND (authorization_generation='0' OR substr(authorization_generation,1,1)<>'0')
    AND length(authorization_generation)<=19
    AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775807')),
  requested_cursor TEXT,
  next_cursor TEXT,
  page_sha256 TEXT NOT NULL CHECK(length(page_sha256)=64
    AND page_sha256=lower(page_sha256) AND page_sha256 NOT GLOB '*[^0-9a-f]*'),
  item_count INTEGER NOT NULL CHECK(typeof(item_count)='integer' AND item_count BETWEEN 0 AND 200),
  observed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  PRIMARY KEY(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id)
);

CREATE TABLE project_alpha_api_v2_directory_observations (
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  inventory_kind TEXT NOT NULL DEFAULT 'directory' CHECK(inventory_kind='directory'),
  request_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32
    AND project_alpha_public_id=lower(project_alpha_public_id)
    AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  resource_revision TEXT NOT NULL CHECK(resource_revision GLOB '[1-9]*'
    AND resource_revision NOT GLOB '*[^0-9]*' AND length(resource_revision)<=19
    AND (length(resource_revision)<19 OR resource_revision<='9223372036854775807')),
  present INTEGER NOT NULL CHECK(present IN (0,1)),
  last_action TEXT NOT NULL CHECK(last_action IN ('upsert','delete')),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64
    AND projection_sha256=lower(projection_sha256) AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  binding_external_id TEXT,
  binding_status TEXT CHECK(binding_status IS NULL OR binding_status IN ('active','tombstoned')),
  binding_resource_revision TEXT CHECK(binding_resource_revision IS NULL OR (
    binding_resource_revision GLOB '[1-9]*' AND binding_resource_revision NOT GLOB '*[^0-9]*'
    AND length(binding_resource_revision)<=19
    AND (length(binding_resource_revision)<19 OR binding_resource_revision<='9223372036854775807'))),
  PRIMARY KEY(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,project_alpha_public_id),
  FOREIGN KEY(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id)
    REFERENCES project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id)
    ON DELETE RESTRICT,
  CHECK((present=1 AND last_action='upsert') OR (present=0 AND last_action='delete')),
  CHECK((binding_external_id IS NULL AND binding_status IS NULL AND binding_resource_revision IS NULL)
    OR (binding_external_id IS NOT NULL AND length(binding_external_id) BETWEEN 1 AND 764
      AND binding_status IS NOT NULL AND binding_resource_revision IS NOT NULL))
);

CREATE TABLE project_alpha_api_v2_project_observations (
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  inventory_kind TEXT NOT NULL DEFAULT 'project' CHECK(inventory_kind='project'),
  request_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL CHECK(length(external_project_id) BETWEEN 1 AND 764),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32
    AND project_alpha_public_id=lower(project_alpha_public_id)
    AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  resource_revision TEXT NOT NULL CHECK(resource_revision GLOB '[0-9]*'
    AND resource_revision NOT GLOB '*[^0-9]*'
    AND (resource_revision='0' OR substr(resource_revision,1,1)<>'0')
    AND length(resource_revision)<=19
    AND (length(resource_revision)<19 OR resource_revision<='9223372036854775807')),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64
    AND projection_sha256=lower(projection_sha256) AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('not_started','active','completed','cancelled')),
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  PRIMARY KEY(source_id,source_instance_id,application_id,history_epoch_id,request_id,project_alpha_public_id),
  FOREIGN KEY(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id)
    REFERENCES project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id)
    ON DELETE RESTRICT
);

-- Conflicts are immutable review evidence.  No trigger below creates a native
-- mapping or selects a winner; review/activation remains a separate workflow.
CREATE TABLE project_alpha_api_v2_inventory_conflicts (
  conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  inventory_kind TEXT NOT NULL CHECK(inventory_kind IN ('directory','project')),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('source','organization','client','project')),
  project_alpha_public_id TEXT,
  external_id TEXT,
  request_id TEXT NOT NULL,
  prior_reference TEXT NOT NULL,
  conflict_kind TEXT NOT NULL CHECK(conflict_kind IN (
    'request_reuse_mismatch','source_identity_changed','authorization_generation_regressed',
    'revision_regressed','revision_reuse_mismatch','external_id_collision',
    'public_id_binding_changed','binding_disappeared','ops_mapping_mismatch','binding_stale')),
  observed_revision TEXT,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)
);
CREATE UNIQUE INDEX project_alpha_api_v2_inventory_conflicts_once
  ON project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,
    resource_type,coalesce(project_alpha_public_id,''),coalesce(external_id,''),
    request_id,prior_reference,conflict_kind);
CREATE INDEX project_alpha_api_v2_inventory_conflicts_review
  ON project_alpha_api_v2_inventory_conflicts(source_id,inventory_kind,conflict_kind,created_at,conflict_id);

CREATE TRIGGER project_alpha_api_v2_inventory_receipts_no_update
BEFORE UPDATE ON project_alpha_api_v2_inventory_receipts
BEGIN SELECT RAISE(ABORT,'api-v2 inventory receipt is immutable'); END;
CREATE TRIGGER project_alpha_api_v2_inventory_receipts_no_delete
BEFORE DELETE ON project_alpha_api_v2_inventory_receipts
BEGIN SELECT RAISE(ABORT,'api-v2 inventory receipt is durable'); END;
CREATE TRIGGER project_alpha_api_v2_directory_observations_no_update
BEFORE UPDATE ON project_alpha_api_v2_directory_observations
BEGIN SELECT RAISE(ABORT,'api-v2 directory observation is immutable'); END;
CREATE TRIGGER project_alpha_api_v2_directory_observations_no_delete
BEFORE DELETE ON project_alpha_api_v2_directory_observations
BEGIN SELECT RAISE(ABORT,'api-v2 directory observation is durable'); END;
CREATE TRIGGER project_alpha_api_v2_project_observations_no_update
BEFORE UPDATE ON project_alpha_api_v2_project_observations
BEGIN SELECT RAISE(ABORT,'api-v2 project observation is immutable'); END;
CREATE TRIGGER project_alpha_api_v2_project_observations_no_delete
BEFORE DELETE ON project_alpha_api_v2_project_observations
BEGIN SELECT RAISE(ABORT,'api-v2 project observation is durable'); END;
CREATE TRIGGER project_alpha_api_v2_inventory_conflicts_no_update
BEFORE UPDATE ON project_alpha_api_v2_inventory_conflicts
BEGIN SELECT RAISE(ABORT,'api-v2 inventory conflict evidence is immutable'); END;
CREATE TRIGGER project_alpha_api_v2_inventory_conflicts_no_delete
BEFORE DELETE ON project_alpha_api_v2_inventory_conflicts
BEGIN SELECT RAISE(ABORT,'api-v2 inventory conflict evidence is durable'); END;

-- A source label never silently changes PA instance/application/epoch.  A new
-- identity may be observed, but it is held for explicit review.
CREATE TRIGGER project_alpha_api_v2_inventory_receipts_source_identity_conflict
AFTER INSERT ON project_alpha_api_v2_inventory_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_receipts prior
  WHERE prior.source_id=NEW.source_id
    AND (prior.source_instance_id<>NEW.source_instance_id OR prior.application_id<>NEW.application_id
      OR prior.history_epoch_id<>NEW.history_epoch_id))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    request_id,prior_reference,conflict_kind,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,
    NEW.inventory_kind,'source',NEW.request_id,
    prior.source_instance_id||':'||prior.application_id||':'||prior.history_epoch_id,
    'source_identity_changed',json_object('observedSourceInstanceId',NEW.source_instance_id,
      'observedApplicationId',NEW.application_id,'observedHistoryEpochId',NEW.history_epoch_id,
      'priorSourceInstanceId',prior.source_instance_id,'priorApplicationId',prior.application_id,
      'priorHistoryEpochId',prior.history_epoch_id)
  FROM project_alpha_api_v2_inventory_receipts prior
  WHERE prior.source_id=NEW.source_id
    AND (prior.source_instance_id<>NEW.source_instance_id OR prior.application_id<>NEW.application_id
      OR prior.history_epoch_id<>NEW.history_epoch_id)
  ORDER BY prior.observed_at DESC,prior.request_id DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_inventory_receipts_generation_conflict
AFTER INSERT ON project_alpha_api_v2_inventory_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_receipts prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND (length(prior.authorization_generation)>length(NEW.authorization_generation)
      OR (length(prior.authorization_generation)=length(NEW.authorization_generation)
        AND prior.authorization_generation>NEW.authorization_generation)))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,
    NEW.inventory_kind,'source',NEW.request_id,prior.request_id,
    'authorization_generation_regressed',NEW.authorization_generation,
    json_object('observedAuthorizationGeneration',NEW.authorization_generation,
      'priorAuthorizationGeneration',prior.authorization_generation)
  FROM project_alpha_api_v2_inventory_receipts prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND (length(prior.authorization_generation)>length(NEW.authorization_generation)
      OR (length(prior.authorization_generation)=length(NEW.authorization_generation)
        AND prior.authorization_generation>NEW.authorization_generation))
  ORDER BY length(prior.authorization_generation) DESC,prior.authorization_generation DESC,
    prior.observed_at DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_directory_revision_regressed
AFTER INSERT ON project_alpha_api_v2_directory_observations
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND (length(prior.resource_revision)>length(NEW.resource_revision)
      OR (length(prior.resource_revision)=length(NEW.resource_revision)
        AND prior.resource_revision>NEW.resource_revision)))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'directory',
    NEW.resource_type,NEW.project_alpha_public_id,NEW.binding_external_id,NEW.request_id,prior.request_id,
    'revision_regressed',NEW.resource_revision,
    json_object('observedRevision',NEW.resource_revision,'priorRevision',prior.resource_revision)
  FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND (length(prior.resource_revision)>length(NEW.resource_revision)
      OR (length(prior.resource_revision)=length(NEW.resource_revision)
        AND prior.resource_revision>NEW.resource_revision))
  ORDER BY length(prior.resource_revision) DESC,prior.resource_revision DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_directory_revision_reuse
AFTER INSERT ON project_alpha_api_v2_directory_observations
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.resource_revision=NEW.resource_revision
    AND (prior.present<>NEW.present OR prior.last_action<>NEW.last_action
      OR prior.projection_sha256<>NEW.projection_sha256
      OR prior.binding_external_id IS NOT NEW.binding_external_id
      OR prior.binding_status IS NOT NEW.binding_status
      OR prior.binding_resource_revision IS NOT NEW.binding_resource_revision))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'directory',
    NEW.resource_type,NEW.project_alpha_public_id,NEW.binding_external_id,NEW.request_id,prior.request_id,
    'revision_reuse_mismatch',NEW.resource_revision,
    json_object('observedProjectionSha256',NEW.projection_sha256,
      'priorProjectionSha256',prior.projection_sha256)
  FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.resource_revision=NEW.resource_revision
    AND (prior.present<>NEW.present OR prior.last_action<>NEW.last_action
      OR prior.projection_sha256<>NEW.projection_sha256
      OR prior.binding_external_id IS NOT NEW.binding_external_id
      OR prior.binding_status IS NOT NEW.binding_status
      OR prior.binding_resource_revision IS NOT NEW.binding_resource_revision)
  ORDER BY prior.request_id DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_directory_external_collision
AFTER INSERT ON project_alpha_api_v2_directory_observations
WHEN NEW.binding_external_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.binding_external_id=NEW.binding_external_id
    AND prior.project_alpha_public_id<>NEW.project_alpha_public_id)
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'directory',
    NEW.resource_type,NEW.project_alpha_public_id,NEW.binding_external_id,NEW.request_id,prior.request_id,
    'external_id_collision',NEW.resource_revision,
    json_object('observedPublicId',NEW.project_alpha_public_id,'priorPublicId',prior.project_alpha_public_id)
  FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.binding_external_id=NEW.binding_external_id
    AND prior.project_alpha_public_id<>NEW.project_alpha_public_id
  ORDER BY prior.request_id DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_directory_public_binding_change
AFTER INSERT ON project_alpha_api_v2_directory_observations
WHEN NEW.binding_external_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.binding_external_id IS NOT NULL AND prior.binding_external_id<>NEW.binding_external_id)
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'directory',
    NEW.resource_type,NEW.project_alpha_public_id,NEW.binding_external_id,NEW.request_id,prior.request_id,
    'public_id_binding_changed',NEW.resource_revision,
    json_object('observedExternalId',NEW.binding_external_id,'priorExternalId',prior.binding_external_id)
  FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.binding_external_id IS NOT NULL AND prior.binding_external_id<>NEW.binding_external_id
  ORDER BY prior.request_id DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_directory_binding_disappeared
AFTER INSERT ON project_alpha_api_v2_directory_observations
WHEN NEW.binding_external_id IS NULL AND EXISTS (
  SELECT 1 FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.binding_external_id IS NOT NULL AND prior.binding_status='active')
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'directory',
    NEW.resource_type,NEW.project_alpha_public_id,NEW.request_id,prior.request_id,
    'binding_disappeared',NEW.resource_revision,
    json_object('priorExternalId',prior.binding_external_id,'priorBindingStatus',prior.binding_status)
  FROM project_alpha_api_v2_directory_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.resource_type=NEW.resource_type AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.binding_external_id IS NOT NULL AND prior.binding_status='active'
  ORDER BY prior.request_id DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_directory_mapping_mismatch
AFTER INSERT ON project_alpha_api_v2_directory_observations
WHEN EXISTS (SELECT 1 FROM project_alpha_directory_mappings mapping
  WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND mapping.resource_type=NEW.resource_type
    AND (mapping.project_alpha_public_id=NEW.project_alpha_public_id
      OR mapping.external_id=NEW.binding_external_id)
    AND (mapping.project_alpha_public_id<>NEW.project_alpha_public_id
      OR NEW.binding_external_id IS NULL OR mapping.external_id<>NEW.binding_external_id))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'directory',
    NEW.resource_type,NEW.project_alpha_public_id,NEW.binding_external_id,NEW.request_id,
    'ops-mapping:'||mapping.external_id||':'||mapping.project_alpha_public_id,
    'ops_mapping_mismatch',NEW.resource_revision,
    json_object('mappingExternalId',mapping.external_id,
      'mappingPublicId',mapping.project_alpha_public_id)
  FROM project_alpha_directory_mappings mapping
  WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND mapping.resource_type=NEW.resource_type
    AND (mapping.project_alpha_public_id=NEW.project_alpha_public_id
      OR mapping.external_id=NEW.binding_external_id)
    AND (mapping.project_alpha_public_id<>NEW.project_alpha_public_id
      OR NEW.binding_external_id IS NULL OR mapping.external_id<>NEW.binding_external_id)
  LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_project_revision_regressed
AFTER INSERT ON project_alpha_api_v2_project_observations
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_project_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND (length(prior.resource_revision)>length(NEW.resource_revision)
      OR (length(prior.resource_revision)=length(NEW.resource_revision)
        AND prior.resource_revision>NEW.resource_revision)))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'project','project',
    NEW.project_alpha_public_id,NEW.external_project_id,NEW.request_id,prior.request_id,
    'revision_regressed',NEW.resource_revision,
    json_object('observedRevision',NEW.resource_revision,'priorRevision',prior.resource_revision)
  FROM project_alpha_api_v2_project_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND (length(prior.resource_revision)>length(NEW.resource_revision)
      OR (length(prior.resource_revision)=length(NEW.resource_revision)
        AND prior.resource_revision>NEW.resource_revision))
  ORDER BY length(prior.resource_revision) DESC,prior.resource_revision DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_project_revision_reuse
AFTER INSERT ON project_alpha_api_v2_project_observations
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_project_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.resource_revision=NEW.resource_revision
    AND (prior.external_project_id<>NEW.external_project_id OR prior.projection_sha256<>NEW.projection_sha256
      OR prior.lifecycle_status<>NEW.lifecycle_status OR prior.archived<>NEW.archived))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'project','project',
    NEW.project_alpha_public_id,NEW.external_project_id,NEW.request_id,prior.request_id,
    'revision_reuse_mismatch',NEW.resource_revision,
    json_object('observedProjectionSha256',NEW.projection_sha256,
      'priorProjectionSha256',prior.projection_sha256)
  FROM project_alpha_api_v2_project_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.resource_revision=NEW.resource_revision
    AND (prior.external_project_id<>NEW.external_project_id OR prior.projection_sha256<>NEW.projection_sha256
      OR prior.lifecycle_status<>NEW.lifecycle_status OR prior.archived<>NEW.archived)
  ORDER BY prior.request_id DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_project_external_collision
AFTER INSERT ON project_alpha_api_v2_project_observations
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_project_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.external_project_id=NEW.external_project_id
    AND prior.project_alpha_public_id<>NEW.project_alpha_public_id)
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'project','project',
    NEW.project_alpha_public_id,NEW.external_project_id,NEW.request_id,prior.request_id,
    'external_id_collision',NEW.resource_revision,
    json_object('observedPublicId',NEW.project_alpha_public_id,'priorPublicId',prior.project_alpha_public_id)
  FROM project_alpha_api_v2_project_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.external_project_id=NEW.external_project_id
    AND prior.project_alpha_public_id<>NEW.project_alpha_public_id
  ORDER BY prior.request_id DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_project_public_binding_change
AFTER INSERT ON project_alpha_api_v2_project_observations
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_project_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.external_project_id<>NEW.external_project_id)
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'project','project',
    NEW.project_alpha_public_id,NEW.external_project_id,NEW.request_id,prior.request_id,
    'public_id_binding_changed',NEW.resource_revision,
    json_object('observedExternalId',NEW.external_project_id,'priorExternalId',prior.external_project_id)
  FROM project_alpha_api_v2_project_observations prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.project_alpha_public_id=NEW.project_alpha_public_id
    AND prior.external_project_id<>NEW.external_project_id
  ORDER BY prior.request_id DESC LIMIT 1;
END;

CREATE TRIGGER project_alpha_api_v2_project_mapping_mismatch
AFTER INSERT ON project_alpha_api_v2_project_observations
WHEN EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
  WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND (mapping.project_alpha_public_id=NEW.project_alpha_public_id
      OR mapping.external_project_id=NEW.external_project_id)
    AND (mapping.project_alpha_public_id<>NEW.project_alpha_public_id
      OR mapping.external_project_id<>NEW.external_project_id))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,'project','project',
    NEW.project_alpha_public_id,NEW.external_project_id,NEW.request_id,
    'ops-mapping:'||mapping.external_project_id||':'||mapping.project_alpha_public_id,
    'ops_mapping_mismatch',NEW.resource_revision,
    json_object('mappingExternalId',mapping.external_project_id,
      'mappingPublicId',mapping.project_alpha_public_id)
  FROM project_alpha_project_mappings mapping
  WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND (mapping.project_alpha_public_id=NEW.project_alpha_public_id
      OR mapping.external_project_id=NEW.external_project_id)
    AND (mapping.project_alpha_public_id<>NEW.project_alpha_public_id
      OR mapping.external_project_id<>NEW.external_project_id)
  LIMIT 1;
END;

-- Latest validated observations are convenient for review, but remain
-- evidence only.  A consumer must still inspect conflicts before adoption.
CREATE VIEW project_alpha_api_v2_directory_observations_current AS
SELECT observation.*,
  EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
    WHERE conflict.source_id=observation.source_id
      AND conflict.source_instance_id=observation.source_instance_id
      AND conflict.application_id=observation.application_id
      AND conflict.history_epoch_id=observation.history_epoch_id
      AND conflict.inventory_kind='directory'
      AND conflict.resource_type=observation.resource_type
      AND conflict.project_alpha_public_id=observation.project_alpha_public_id) AS has_conflict
FROM project_alpha_api_v2_directory_observations observation
JOIN project_alpha_api_v2_inventory_receipts receipt
  ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
 AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
 AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
WHERE NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_directory_observations newer
  JOIN project_alpha_api_v2_inventory_receipts newer_receipt
    ON newer_receipt.source_id=newer.source_id AND newer_receipt.source_instance_id=newer.source_instance_id
   AND newer_receipt.application_id=newer.application_id AND newer_receipt.history_epoch_id=newer.history_epoch_id
   AND newer_receipt.inventory_kind='directory' AND newer_receipt.request_id=newer.request_id
  WHERE newer.source_id=observation.source_id AND newer.source_instance_id=observation.source_instance_id
    AND newer.application_id=observation.application_id AND newer.history_epoch_id=observation.history_epoch_id
    AND newer.resource_type=observation.resource_type AND newer.project_alpha_public_id=observation.project_alpha_public_id
    AND (length(newer.resource_revision)>length(observation.resource_revision)
      OR (newer.resource_revision=observation.resource_revision
        AND (newer_receipt.observed_at>receipt.observed_at
          OR (newer_receipt.observed_at=receipt.observed_at AND newer.request_id>observation.request_id)))
      OR (length(newer.resource_revision)=length(observation.resource_revision)
        AND newer.resource_revision>observation.resource_revision)));

CREATE VIEW project_alpha_api_v2_project_observations_current AS
SELECT observation.*,
  EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
    WHERE conflict.source_id=observation.source_id
      AND conflict.source_instance_id=observation.source_instance_id
      AND conflict.application_id=observation.application_id
      AND conflict.history_epoch_id=observation.history_epoch_id
      AND conflict.inventory_kind='project'
      AND conflict.project_alpha_public_id=observation.project_alpha_public_id) AS has_conflict
FROM project_alpha_api_v2_project_observations observation
JOIN project_alpha_api_v2_inventory_receipts receipt
  ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
 AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
 AND receipt.inventory_kind='project' AND receipt.request_id=observation.request_id
WHERE NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_project_observations newer
  JOIN project_alpha_api_v2_inventory_receipts newer_receipt
    ON newer_receipt.source_id=newer.source_id AND newer_receipt.source_instance_id=newer.source_instance_id
   AND newer_receipt.application_id=newer.application_id AND newer_receipt.history_epoch_id=newer.history_epoch_id
   AND newer_receipt.inventory_kind='project' AND newer_receipt.request_id=newer.request_id
  WHERE newer.source_id=observation.source_id AND newer.source_instance_id=observation.source_instance_id
    AND newer.application_id=observation.application_id AND newer.history_epoch_id=observation.history_epoch_id
    AND newer.project_alpha_public_id=observation.project_alpha_public_id
    AND (length(newer.resource_revision)>length(observation.resource_revision)
      OR (newer.resource_revision=observation.resource_revision
        AND (newer_receipt.observed_at>receipt.observed_at
          OR (newer_receipt.observed_at=receipt.observed_at AND newer.request_id>observation.request_id)))
      OR (length(newer.resource_revision)=length(observation.resource_revision)
        AND newer.resource_revision>observation.resource_revision)));
