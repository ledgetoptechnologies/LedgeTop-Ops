PRAGMA foreign_keys = ON;

-- Source-qualified Project Alpha service facts. Applying this migration is
-- non-authorizing: the receiver also requires its default-off runtime flag and
-- an explicit active receiver grant. No grant rows are created here.
CREATE TABLE pa_service_assignment_receiver_grants (
  source_id TEXT PRIMARY KEY CHECK(length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  capability TEXT NOT NULL CHECK(capability='portal.service-assignments.publish'),
  contract_version INTEGER NOT NULL CHECK(contract_version=1),
  state TEXT NOT NULL CHECK(state IN ('active','suspended')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

-- Exact local workspaces independently approved for this receiver purpose.
-- The producer's own profile filter is not sufficient admission evidence.
CREATE TABLE pa_service_assignment_receiver_workspaces (
  source_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','suspended')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(source_id,workspace_id),
  FOREIGN KEY(source_id) REFERENCES pa_service_assignment_receiver_grants(source_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,source_id)
    REFERENCES pa_portal_workspace_sources(workspace_id,projection_source_id) ON DELETE RESTRICT
);

-- Observed producer support is diagnostic state only and is never consulted as
-- receiver authorization.
CREATE TABLE pa_service_assignment_source_capabilities (
  source_id TEXT PRIMARY KEY CHECK(length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  contract_version INTEGER NOT NULL CHECK(contract_version=1),
  state TEXT NOT NULL CHECK(state='supported'),
  first_seen_at TEXT NOT NULL DEFAULT(datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE pa_service_assignment_generations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_generation TEXT NOT NULL CHECK(length(source_generation) BETWEEN 1 AND 128),
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64 AND snapshot_hash NOT GLOB '*[^a-f0-9]*'),
  page_count INTEGER NOT NULL CHECK(page_count BETWEEN 1 AND 100),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 5000),
  status TEXT NOT NULL CHECK(status IN ('staging','active','superseded','rejected')),
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  activated_at TEXT,
  UNIQUE(id,source_id),
  UNIQUE(source_id,source_generation),
  UNIQUE(source_id,source_sequence)
);
CREATE TRIGGER pa_service_assignment_staging_capacity BEFORE INSERT ON pa_service_assignment_generations
WHEN (SELECT count(*) FROM pa_service_assignment_generations
  WHERE source_id=NEW.source_id AND status='staging')>=8
BEGIN SELECT RAISE(ABORT,'service-assignment-staging-capacity'); END;

CREATE TABLE pa_service_assignment_generation_pages (
  source_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK(page_number BETWEEN 1 AND 100),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 100),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  received_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(source_id,generation_id,page_number),
  FOREIGN KEY(generation_id,source_id) REFERENCES pa_service_assignment_generations(id,source_id) ON DELETE CASCADE
);

CREATE TABLE pa_service_assignment_generation_items (
  source_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  assignment_public_id TEXT NOT NULL CHECK(length(assignment_public_id) BETWEEN 1 AND 128),
  source_version TEXT NOT NULL CHECK(length(source_version) BETWEEN 1 AND 128),
  subject_type TEXT NOT NULL CHECK(subject_type IN ('organization','standalone_client','department','client','project')),
  subject_public_id TEXT NOT NULL CHECK(length(subject_public_id) BETWEEN 1 AND 128),
  service_public_id TEXT NOT NULL CHECK(length(service_public_id) BETWEEN 1 AND 128),
  service_source_version TEXT NOT NULL CHECK(length(service_source_version) BETWEEN 1 AND 128),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  effective_from TEXT,
  effective_until TEXT,
  source_updated_at TEXT NOT NULL,
  PRIMARY KEY(source_id,generation_id,assignment_public_id),
  FOREIGN KEY(source_id,generation_id,page_number)
    REFERENCES pa_service_assignment_generation_pages(source_id,generation_id,page_number) ON DELETE CASCADE,
  CHECK(effective_from IS NULL OR effective_until IS NULL OR datetime(effective_until)>datetime(effective_from))
);
CREATE INDEX idx_pa_service_assignment_generation_page
  ON pa_service_assignment_generation_items(source_id,generation_id,page_number,assignment_public_id);

CREATE TABLE pa_service_assignments (
  source_id TEXT NOT NULL,
  assignment_public_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('organization','standalone_client','department','client','project')),
  subject_public_id TEXT NOT NULL,
  service_public_id TEXT NOT NULL,
  service_source_version TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  effective_from TEXT,
  effective_until TEXT,
  source_updated_at TEXT NOT NULL,
  mirrored_at TEXT NOT NULL DEFAULT(datetime('now')),
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  PRIMARY KEY(source_id,assignment_public_id,source_version),
  CHECK(effective_from IS NULL OR effective_until IS NULL OR datetime(effective_until)>datetime(effective_from))
);
CREATE UNIQUE INDEX idx_pa_service_assignment_current
  ON pa_service_assignments(source_id,assignment_public_id) WHERE active=1;
CREATE INDEX idx_pa_service_assignment_subject
  ON pa_service_assignments(source_id,subject_type,subject_public_id,active,effective_from,effective_until,assignment_public_id);

CREATE TABLE pa_service_assignment_checkpoints (
  source_id TEXT PRIMARY KEY,
  active_generation_id TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(active_generation_id,source_id) REFERENCES pa_service_assignment_generations(id,source_id)
);

CREATE TABLE pa_service_assignment_entity_state (
  source_id TEXT NOT NULL,
  assignment_public_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(source_id,assignment_public_id)
);

CREATE TABLE pa_service_assignment_projection_receipts (
  source_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 128),
  delivery_kind TEXT NOT NULL CHECK(delivery_kind IN ('snapshot_page','snapshot_activate','event')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  source_sequence INTEGER NOT NULL CONSTRAINT service_assignment_delivery_write_guard CHECK(source_sequence>=1),
  status TEXT NOT NULL CHECK(status IN ('completed','ignored')),
  received_at TEXT NOT NULL DEFAULT(datetime('now')),
  processed_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(source_id,delivery_id)
);

CREATE TABLE pa_service_assignment_projection_audit (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('snapshot_page_staged','snapshot_activated','event_upserted','event_tombstoned')),
  delivery_id TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT('{}') CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX idx_pa_service_assignment_audit
  ON pa_service_assignment_projection_audit(source_id,created_at DESC,id DESC);

CREATE TABLE pa_service_assignment_write_fences (
  source_id TEXT PRIMARY KEY,
  write_guard INTEGER NOT NULL CONSTRAINT pa_service_assignment_write_guard CHECK(write_guard=1),
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TRIGGER pa_service_assignment_grant_identity_guard BEFORE UPDATE ON pa_service_assignment_receiver_grants
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.capability IS NOT OLD.capability
  OR NEW.contract_version<>OLD.contract_version OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'service-assignment-grant-identity-immutable'); END;
CREATE TRIGGER pa_service_assignment_grant_no_delete BEFORE DELETE ON pa_service_assignment_receiver_grants
BEGIN SELECT RAISE(ABORT,'service-assignment-grant-persistent'); END;
CREATE TRIGGER pa_service_assignment_receiver_workspace_identity_guard BEFORE UPDATE ON pa_service_assignment_receiver_workspaces
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'service-assignment-workspace-allowlist-identity-immutable'); END;
CREATE TRIGGER pa_service_assignment_receiver_workspace_no_delete BEFORE DELETE ON pa_service_assignment_receiver_workspaces
BEGIN SELECT RAISE(ABORT,'service-assignment-workspace-allowlist-persistent'); END;
CREATE TRIGGER pa_service_assignment_capability_identity_guard BEFORE UPDATE ON pa_service_assignment_source_capabilities
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.contract_version<>OLD.contract_version
  OR NEW.state<>OLD.state OR NEW.first_seen_at<>OLD.first_seen_at
BEGIN SELECT RAISE(ABORT,'service-assignment-capability-immutable'); END;
CREATE TRIGGER pa_service_assignment_capability_no_delete BEFORE DELETE ON pa_service_assignment_source_capabilities
BEGIN SELECT RAISE(ABORT,'service-assignment-capability-immutable'); END;

CREATE TRIGGER pa_service_assignment_checkpoint_insert_guard BEFORE INSERT ON pa_service_assignment_checkpoints
WHEN NOT EXISTS(SELECT 1 FROM pa_service_assignment_generations generation
  WHERE generation.id=NEW.active_generation_id AND generation.source_id=NEW.source_id
    AND generation.source_generation=NEW.source_generation AND generation.source_sequence=NEW.source_sequence
    AND generation.status='active' AND generation.complete=1)
BEGIN SELECT RAISE(ABORT,'service-assignment-checkpoint-invalid'); END;
CREATE TRIGGER pa_service_assignment_checkpoint_update_guard BEFORE UPDATE ON pa_service_assignment_checkpoints
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.source_sequence<=OLD.source_sequence OR NOT EXISTS(
  SELECT 1 FROM pa_service_assignment_generations generation
  WHERE generation.id=NEW.active_generation_id AND generation.source_id=NEW.source_id
    AND generation.source_generation=NEW.source_generation
    AND generation.status='active' AND generation.complete=1)
BEGIN SELECT RAISE(ABORT,'service-assignment-checkpoint-invalid'); END;
CREATE TRIGGER pa_service_assignment_checkpoint_no_delete BEFORE DELETE ON pa_service_assignment_checkpoints
BEGIN SELECT RAISE(ABORT,'service-assignment-checkpoint-immutable'); END;
CREATE TRIGGER pa_service_assignment_receipt_no_update BEFORE UPDATE ON pa_service_assignment_projection_receipts
BEGIN SELECT RAISE(ABORT,'service-assignment-receipt-immutable'); END;
CREATE TRIGGER pa_service_assignment_receipt_no_delete BEFORE DELETE ON pa_service_assignment_projection_receipts
BEGIN SELECT RAISE(ABORT,'service-assignment-receipt-immutable'); END;
CREATE TRIGGER pa_service_assignment_audit_no_update BEFORE UPDATE ON pa_service_assignment_projection_audit
BEGIN SELECT RAISE(ABORT,'service-assignment-audit-immutable'); END;
CREATE TRIGGER pa_service_assignment_audit_no_delete BEFORE DELETE ON pa_service_assignment_projection_audit
BEGIN SELECT RAISE(ABORT,'service-assignment-audit-immutable'); END;
