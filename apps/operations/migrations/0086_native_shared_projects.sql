PRAGMA foreign_keys = ON;

-- Project authority is deliberately separate from directory resource grants:
-- directory resource IDs are client/organization IDs, never project IDs.
CREATE TABLE native_project_grant_generations (
  staff_id TEXT NOT NULL PRIMARY KEY REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE native_project_grants (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK(capability='project.shared.sync'),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','business_area','division','exact_project')),
  business_area_id TEXT REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  external_project_id TEXT REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((scope_kind='global' AND business_area_id IS NULL AND division_id IS NULL AND external_project_id IS NULL)
    OR (scope_kind='business_area' AND business_area_id IS NOT NULL AND division_id IS NULL AND external_project_id IS NULL)
    OR (scope_kind='division' AND business_area_id IS NOT NULL AND division_id IS NOT NULL AND external_project_id IS NULL)
    OR (scope_kind='exact_project' AND business_area_id IS NULL AND division_id IS NULL AND external_project_id IS NOT NULL)),
  FOREIGN KEY(business_area_id,division_id) REFERENCES native_business_divisions(business_area_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX native_project_grant_identity ON native_project_grants(
  staff_id,capability,effect,scope_kind,ifnull(business_area_id,''),ifnull(division_id,''),ifnull(external_project_id,''));
CREATE INDEX native_project_grants_actor ON native_project_grants(staff_id,capability,active);
CREATE TRIGGER native_project_grants_insert_generation AFTER INSERT ON native_project_grants
BEGIN
  INSERT INTO native_project_grant_generations(staff_id,generation) VALUES(NEW.staff_id,1)
    ON CONFLICT(staff_id) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER native_project_grants_update_guard BEFORE UPDATE ON native_project_grants
WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.capability IS NOT OLD.capability
 OR NEW.effect IS NOT OLD.effect OR NEW.scope_kind IS NOT OLD.scope_kind
 OR NEW.business_area_id IS NOT OLD.business_area_id OR NEW.division_id IS NOT OLD.division_id
 OR NEW.external_project_id IS NOT OLD.external_project_id OR NEW.granted_by IS NOT OLD.granted_by
 OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native project grant identity is immutable'); END;
CREATE TRIGGER native_project_grants_update_generation AFTER UPDATE ON native_project_grants
BEGIN UPDATE native_project_grant_generations SET generation=generation+1 WHERE staff_id=NEW.staff_id; END;
CREATE TRIGGER native_project_grants_no_delete BEFORE DELETE ON native_project_grants
BEGIN SELECT RAISE(ABORT,'native project grants are durable'); END;

-- This proof must be inserted before the outbox row in the same D1 batch.
-- Historical 0062-0064 commands have no proof and cannot become refreshed
-- merely because a staff ID happens to exist today.
CREATE TABLE native_project_command_proofs (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id)=36),
  external_project_id TEXT NOT NULL REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 764),
  actor_admission_version INTEGER NOT NULL CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(typeof(actor_profile_version)='integer' AND actor_profile_version>=1),
  actor_email TEXT NOT NULL CHECK(length(actor_email) BETWEEN 3 AND 254),
  verified_until TEXT NOT NULL CHECK(length(verified_until)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_until) IS verified_until),
  grant_generation INTEGER NOT NULL CHECK(typeof(grant_generation)='integer' AND grant_generation>=1),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json)='array' AND json_array_length(scopes_json)<=128),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_project_command_proofs_no_update BEFORE UPDATE ON native_project_command_proofs
BEGIN SELECT RAISE(ABORT,'native project command proof is immutable'); END;
CREATE TRIGGER native_project_command_proofs_no_delete BEFORE DELETE ON native_project_command_proofs
BEGIN SELECT RAISE(ABORT,'native project command proof is durable'); END;

CREATE VIEW native_project_live_command_proofs AS
SELECT proof.* FROM native_project_command_proofs proof
JOIN native_staff_admissions admission ON admission.staff_id=proof.actor_staff_id
  AND admission.active=1 AND admission.bound_access_subject=proof.actor_access_subject
  AND admission.version=proof.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=proof.actor_staff_id
  AND profile.login_email=proof.actor_email AND profile.version=proof.actor_profile_version
JOIN native_project_grant_generations generation ON generation.staff_id=proof.actor_staff_id
  AND generation.generation=proof.grant_generation
WHERE NOT EXISTS (SELECT 1 FROM json_each(proof.scopes_json) scope
  LEFT JOIN native_business_areas area ON area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
  LEFT JOIN native_business_divisions division ON division.id=json_extract(scope.value,'$.divisionId')
    AND division.business_area_id=area.id AND division.active=1
  WHERE json_type(scope.value) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(scope.value))<>3
    OR EXISTS (SELECT 1 FROM json_each(scope.value) member
      WHERE member.key NOT IN ('scopeKind','businessAreaId','divisionId'))
    OR json_type(scope.value,'$.scopeKind') IS NOT 'text'
    OR json_extract(scope.value,'$.scopeKind') NOT IN ('business_area','division')
    OR json_type(scope.value,'$.businessAreaId') IS NOT 'text' OR area.id IS NULL
    OR (json_extract(scope.value,'$.scopeKind')='business_area'
      AND (json_type(scope.value,'$.divisionId') IS NOT 'null' OR json_extract(scope.value,'$.divisionId') IS NOT NULL))
    OR (json_extract(scope.value,'$.scopeKind')='division'
      AND (json_type(scope.value,'$.divisionId') IS NOT 'text' OR division.id IS NULL)))
  AND NOT EXISTS (SELECT 1 FROM json_each(proof.scopes_json) scope
    WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
      WHERE grant_row.staff_id=proof.actor_staff_id AND grant_row.capability='project.shared.sync'
        AND grant_row.effect='allow' AND grant_row.active=1
        AND (grant_row.scope_kind='global'
          OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=proof.external_project_id)
          OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
          OR (grant_row.scope_kind='division' AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
  AND (json_array_length(proof.scopes_json)>0 OR EXISTS (SELECT 1 FROM native_project_grants grant_row
    WHERE grant_row.staff_id=proof.actor_staff_id AND grant_row.capability='project.shared.sync'
      AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='exact_project'
        AND grant_row.external_project_id=proof.external_project_id))))
  AND NOT EXISTS (SELECT 1 FROM native_project_grants deny
    WHERE deny.staff_id=proof.actor_staff_id AND deny.capability='project.shared.sync'
      AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global'
        OR (deny.scope_kind='exact_project' AND deny.external_project_id=proof.external_project_id)
        OR EXISTS (SELECT 1 FROM json_each(proof.scopes_json) scope
          WHERE (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId'))
            OR (deny.scope_kind='division' AND deny.division_id=json_extract(scope.value,'$.divisionId')))));

CREATE TRIGGER native_project_command_proofs_insert_guard AFTER INSERT ON native_project_command_proofs
WHEN NEW.verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM native_project_live_command_proofs WHERE command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'native project command authority is invalid'); END;
CREATE TRIGGER project_alpha_project_outbox_native_proof BEFORE INSERT ON project_alpha_project_outbox
WHEN NOT EXISTS (SELECT 1 FROM native_project_live_command_proofs proof
  WHERE proof.command_id=NEW.command_id AND proof.external_project_id=NEW.external_project_id
    AND proof.actor_staff_id=json_extract(NEW.origin_snapshot_json,'$.actorId'))
BEGIN SELECT RAISE(ABORT,'project command requires native proof'); END;

-- A final same-batch assertion makes proof/outbox insertion all-or-nothing.
CREATE TABLE native_project_command_reservations (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_project_outbox(command_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_project_command_reservations_valid BEFORE INSERT ON native_project_command_reservations
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox
  JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
  WHERE outbox.command_id=NEW.command_id AND outbox.external_project_id=proof.external_project_id
    AND proof.actor_staff_id=json_extract(outbox.origin_snapshot_json,'$.actorId'))
BEGIN SELECT RAISE(ABORT,'project reservation is incomplete'); END;
CREATE TRIGGER native_project_command_reservations_no_update BEFORE UPDATE ON native_project_command_reservations
BEGIN SELECT RAISE(ABORT,'project reservation is durable'); END;
CREATE TRIGGER native_project_command_reservations_no_delete BEFORE DELETE ON native_project_command_reservations
BEGIN SELECT RAISE(ABORT,'project reservation is durable'); END;

-- Canonical shared fields only. PA's imported pa_projects and operational
-- memory have distinct ownership and are not modified by a refresh.
CREATE TABLE operations_shared_projects (
  external_project_id TEXT NOT NULL PRIMARY KEY CHECK(length(external_project_id) BETWEEN 1 AND 191),
  -- Native projects may exist before PA mapping or during an outage. A refresh
  -- fills this complete external identity only for an explicitly bound project.
  source_id TEXT,
  source_instance_id TEXT,
  application_id TEXT,
  history_epoch_id TEXT,
  project_alpha_public_id TEXT CHECK(project_alpha_public_id IS NULL OR length(project_alpha_public_id)=32),
  pa_revision TEXT,
  current_version INTEGER NOT NULL DEFAULT 1 CHECK(current_version>=1),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('not_started','active','completed','cancelled')),
  planned_start TEXT,
  planned_end TEXT,
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  client_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_instance_id,project_alpha_public_id,history_epoch_id),
  CHECK((source_id IS NULL AND source_instance_id IS NULL AND application_id IS NULL
      AND history_epoch_id IS NULL AND project_alpha_public_id IS NULL AND pa_revision IS NULL)
    OR (source_id IS NOT NULL AND source_instance_id IS NOT NULL AND application_id IS NOT NULL
      AND history_epoch_id IS NOT NULL AND project_alpha_public_id IS NOT NULL AND pa_revision IS NOT NULL))
);
CREATE TABLE operations_shared_project_revisions (
  external_project_id TEXT NOT NULL REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version>=1),
  pa_revision TEXT,
  read_json TEXT NOT NULL CHECK(json_valid(read_json)),
  refresh_command_id TEXT REFERENCES project_alpha_project_outbox(command_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(external_project_id,version),
  CHECK((pa_revision IS NULL)=(refresh_command_id IS NULL))
);
CREATE TRIGGER operations_shared_projects_bound_refresh_guard BEFORE INSERT ON operations_shared_projects
WHEN NEW.pa_revision IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_refresh refresh
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=refresh.external_project_id
    AND mapping.establishment_command_id=refresh.establishment_command_id
  JOIN project_alpha_project_outbox command ON command.command_id=refresh.establishment_command_id
    AND command.operation='bind' AND command.state='acknowledged'
  JOIN native_project_live_command_proofs proof ON proof.command_id=command.command_id
    AND proof.external_project_id=refresh.external_project_id
  WHERE refresh.external_project_id=NEW.external_project_id
    AND refresh.history_epoch_id=NEW.history_epoch_id
    AND mapping.history_epoch_id=NEW.history_epoch_id
    AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id
    AND mapping.project_alpha_public_id=NEW.project_alpha_public_id
    AND json(proof.scopes_json)=json(NEW.scopes_json)
    AND (length(NEW.pa_revision)>length(refresh.minimum_revision)
      OR (length(NEW.pa_revision)=length(refresh.minimum_revision) AND NEW.pa_revision>=refresh.minimum_revision))
    AND (NEW.organization_record_id IS NULL OR EXISTS (
      SELECT 1 FROM project_alpha_directory_mappings customer
      JOIN operations_directory_records record ON record.record_id=customer.external_id AND record.record_kind='organization'
      WHERE customer.source_id=NEW.source_id AND customer.source_instance_id=NEW.source_instance_id
        AND customer.application_id=NEW.application_id AND customer.history_epoch_id=NEW.history_epoch_id
        AND customer.resource_type='organization' AND customer.external_id=NEW.organization_record_id))
    AND (NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM project_alpha_directory_mappings customer
      JOIN operations_directory_records record ON record.record_id=customer.external_id AND record.record_kind='client'
      WHERE customer.source_id=NEW.source_id AND customer.source_instance_id=NEW.source_instance_id
        AND customer.application_id=NEW.application_id AND customer.history_epoch_id=NEW.history_epoch_id
        AND customer.resource_type='client' AND customer.external_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id
        AND relationship.organization_record_id=NEW.organization_record_id))
)
BEGIN SELECT RAISE(ABORT,'bound shared project refresh is not authorized'); END;
CREATE TRIGGER operations_shared_project_revisions_bound_guard BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.refresh_command_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM operations_shared_projects project
  JOIN project_alpha_project_refresh refresh ON refresh.external_project_id=project.external_project_id
    AND refresh.establishment_command_id=NEW.refresh_command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=NEW.refresh_command_id
    AND proof.external_project_id=project.external_project_id
  WHERE project.external_project_id=NEW.external_project_id AND NEW.version=1
    AND project.current_version=1 AND project.pa_revision=NEW.pa_revision
    AND json_type(NEW.read_json,'$.resource.revision')='text'
    AND json_extract(NEW.read_json,'$.resource.revision')=NEW.pa_revision
    AND json_extract(NEW.read_json,'$.resource.id')=project.project_alpha_public_id
    AND json_extract(NEW.read_json,'$.data.publicId')=project.project_alpha_public_id
    AND json_extract(NEW.read_json,'$.sourceInstanceId')=project.source_instance_id
    AND json_extract(NEW.read_json,'$.applicationId')=project.application_id
    AND json_extract(NEW.read_json,'$.historyEpoch')=project.history_epoch_id
    AND json_extract(NEW.read_json,'$.data.name')=project.name
    AND json_extract(NEW.read_json,'$.data.lifecycle')=project.lifecycle
    AND json_extract(NEW.read_json,'$.data.plannedStart') IS project.planned_start
    AND json_extract(NEW.read_json,'$.data.plannedEnd') IS project.planned_end
    AND (project.organization_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.organizationPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='organization' AND customer.external_id=project.organization_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.organizationPublicId')))
    AND (project.client_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='client' AND customer.external_id=project.client_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId')))
)
BEGIN SELECT RAISE(ABORT,'bound shared project revision is not authorized'); END;
CREATE TRIGGER operations_shared_project_revisions_no_update BEFORE UPDATE ON operations_shared_project_revisions
BEGIN SELECT RAISE(ABORT,'shared project revisions are immutable'); END;
CREATE TRIGGER operations_shared_project_revisions_no_delete BEFORE DELETE ON operations_shared_project_revisions
BEGIN SELECT RAISE(ABORT,'shared project revisions are durable'); END;
CREATE TRIGGER operations_shared_projects_no_delete BEFORE DELETE ON operations_shared_projects
BEGIN SELECT RAISE(ABORT,'shared projects are durable'); END;
CREATE TRIGGER operations_shared_projects_no_update BEFORE UPDATE ON operations_shared_projects
BEGIN SELECT RAISE(ABORT,'shared project update requires a versioned writer'); END;

-- Keep the 0063 pending marker immutable. The receipt satisfies it without
-- rewriting or deleting binding history.
CREATE TABLE project_alpha_project_refresh_receipts (
  external_project_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_project_refresh(external_project_id) ON DELETE RESTRICT,
  establishment_command_id TEXT NOT NULL REFERENCES project_alpha_project_outbox(command_id) ON DELETE RESTRICT,
  project_version INTEGER NOT NULL CHECK(project_version=1),
  pa_revision TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(external_project_id,project_version)
    REFERENCES operations_shared_project_revisions(external_project_id,version) ON DELETE RESTRICT
);
CREATE TRIGGER project_alpha_project_refresh_receipts_no_update BEFORE UPDATE ON project_alpha_project_refresh_receipts
BEGIN SELECT RAISE(ABORT,'project refresh receipts are immutable'); END;
CREATE TRIGGER project_alpha_project_refresh_receipts_no_delete BEFORE DELETE ON project_alpha_project_refresh_receipts
BEGIN SELECT RAISE(ABORT,'project refresh receipts are durable'); END;
CREATE TRIGGER project_alpha_project_refresh_receipts_valid BEFORE INSERT ON project_alpha_project_refresh_receipts
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_project_refresh refresh
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=refresh.external_project_id
    AND mapping.establishment_command_id=refresh.establishment_command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=refresh.establishment_command_id
    AND outbox.state='acknowledged' AND outbox.operation='bind'
  JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
    AND proof.external_project_id=refresh.external_project_id
  JOIN operations_shared_projects project ON project.external_project_id=refresh.external_project_id
  JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
    AND revision.version=1 AND revision.refresh_command_id=refresh.establishment_command_id
  WHERE refresh.external_project_id=NEW.external_project_id
    AND refresh.establishment_command_id=NEW.establishment_command_id
    AND refresh.history_epoch_id=NEW.history_epoch_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND project.history_epoch_id=NEW.history_epoch_id AND project.pa_revision=NEW.pa_revision
    AND revision.pa_revision=NEW.pa_revision
    AND (length(NEW.pa_revision)>length(refresh.minimum_revision)
      OR (length(NEW.pa_revision)=length(refresh.minimum_revision) AND NEW.pa_revision>=refresh.minimum_revision)))
BEGIN SELECT RAISE(ABORT,'project refresh settlement is invalid'); END;

CREATE VIEW project_alpha_project_pending_refresh AS
SELECT refresh.* FROM project_alpha_project_refresh refresh
WHERE NOT EXISTS (SELECT 1 FROM project_alpha_project_refresh_receipts receipt
  WHERE receipt.external_project_id=refresh.external_project_id);
