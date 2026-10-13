PRAGMA foreign_keys = ON;

-- Ops-side review of one PA-backed portal workspace. This is an inactive
-- selection, not a Client binding receipt or a portal access grant. Multiple
-- rows for one canonical record are allowed across different PA sources.
CREATE TABLE client_portal_workspace_binding_selections (
  selection_id TEXT PRIMARY KEY CHECK(length(selection_id)=36 AND selection_id=lower(selection_id)
    AND substr(selection_id,9,1)='-' AND substr(selection_id,14,1)='-'
    AND substr(selection_id,19,1)='-' AND substr(selection_id,24,1)='-'
    AND replace(selection_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  client_authority_id TEXT NOT NULL UNIQUE CHECK(length(client_authority_id)=36
    AND client_authority_id=lower(client_authority_id)
    AND substr(client_authority_id,9,1)='-' AND substr(client_authority_id,14,1)='-'
    AND substr(client_authority_id,19,1)='-' AND substr(client_authority_id,24,1)='-'
    AND replace(client_authority_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  activation_id TEXT NOT NULL REFERENCES project_alpha_existing_directory_binding_activation_receipts(activation_id) ON DELETE RESTRICT,
  record_version INTEGER NOT NULL CHECK(record_version>=1),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id) BETWEEN 15 AND 78),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id) BETWEEN 1 AND 200),
  application_id TEXT NOT NULL CHECK(length(application_id) BETWEEN 1 AND 200),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id) BETWEEN 1 AND 200),
  root_type TEXT NOT NULL CHECK(root_type IN ('organization','standalone_client')),
  root_public_id TEXT NOT NULL CHECK(length(root_public_id)=32 AND root_public_id NOT GLOB '*[^0-9a-f]*'),
  workspace_id TEXT NOT NULL CHECK(length(trim(workspace_id)) BETWEEN 1 AND 200),
  source_workspace_id TEXT NOT NULL CHECK(length(trim(source_workspace_id)) BETWEEN 1 AND 200),
  checkpoint_source_generation TEXT NOT NULL CHECK(length(trim(checkpoint_source_generation)) BETWEEN 1 AND 200),
  checkpoint_source_sequence INTEGER NOT NULL CHECK(checkpoint_source_sequence>=1),
  checkpoint_snapshot_generation_id TEXT NOT NULL CHECK(length(trim(checkpoint_snapshot_generation_id)) BETWEEN 1 AND 200),
  reviewed_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  reviewed_access_subject TEXT NOT NULL,
  reviewed_admission_version INTEGER NOT NULL CHECK(reviewed_admission_version>=1),
  reviewed_profile_version INTEGER NOT NULL CHECK(reviewed_profile_version>=1),
  reviewed_grant_generation INTEGER NOT NULL CHECK(reviewed_grant_generation>=1),
  verified_until TEXT NOT NULL CHECK(length(verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_until) IS verified_until),
  state TEXT NOT NULL DEFAULT 'inactive' CHECK(state='inactive'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(client_authority_id<>record_id)
);

-- A stale, never-dispatched review may need a fresh checkpoint. Selections are
-- append-only attempts; only a later exact Client receipt can claim a workspace.
CREATE INDEX client_portal_workspace_binding_selections_record_source
  ON client_portal_workspace_binding_selections(record_id,source_id,created_at,selection_id);

CREATE TRIGGER client_portal_workspace_binding_selection_guard
BEFORE INSERT ON client_portal_workspace_binding_selections
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_existing_directory_binding_activation_receipts activation
  JOIN operations_directory_records record ON record.record_id=activation.record_id
  JOIN native_staff_admissions admission ON admission.staff_id=NEW.reviewed_by_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE activation.activation_id=NEW.activation_id
    AND activation.record_id=NEW.record_id AND activation.source_id=NEW.source_id
    AND activation.source_instance_id=NEW.source_instance_id
    AND activation.application_id=NEW.application_id
    AND activation.history_epoch_id=NEW.history_epoch_id
    AND activation.project_alpha_public_id=NEW.root_public_id
    AND ((activation.resource_type='organization' AND NEW.root_type='organization')
      OR (activation.resource_type='client' AND NEW.root_type='standalone_client'))
    AND record.record_kind=activation.resource_type
    AND record.current_version=NEW.record_version
    AND record.current_version=activation.local_record_version
    AND admission.active=1 AND admission.bound_access_subject=NEW.reviewed_access_subject
    AND admission.version=NEW.reviewed_admission_version
    AND profile.version=NEW.reviewed_profile_version
    AND generation.generation=NEW.reviewed_grant_generation
    AND NEW.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND EXISTS (SELECT 1 FROM staff_role_assignments role
      WHERE role.staff_id=NEW.reviewed_by_staff_id AND role.role_id='role-owner' AND role.scope='global')
    AND EXISTS (SELECT 1 FROM native_directory_grants grant
      WHERE grant.staff_id=NEW.reviewed_by_staff_id AND grant.permission='directory.portal_access.manage'
        AND grant.effect='allow' AND grant.active=1
        AND (grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=NEW.record_id)))
    AND NOT EXISTS (SELECT 1 FROM native_directory_grants deny
      WHERE deny.staff_id=NEW.reviewed_by_staff_id AND deny.permission='directory.portal_access.manage'
        AND deny.effect='deny' AND deny.active=1
        AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=NEW.record_id)
          OR (deny.scope_kind='business_area' AND EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
          OR (deny.scope_kind='division' AND EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=NEW.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
)
BEGIN SELECT RAISE(ABORT,'portal workspace binding selection requires exact current mapping and owner authority'); END;

CREATE TRIGGER client_portal_workspace_binding_selection_no_update
BEFORE UPDATE ON client_portal_workspace_binding_selections
BEGIN SELECT RAISE(ABORT,'portal workspace binding selection is immutable'); END;
CREATE TRIGGER client_portal_workspace_binding_selection_no_delete
BEFORE DELETE ON client_portal_workspace_binding_selections
BEGIN SELECT RAISE(ABORT,'portal workspace binding selection is durable'); END;
