PRAGMA foreign_keys = ON;

-- Native, staging-inert reservation state.  These rows reserve an Ops-owned
-- Directory root and exact selected R2 prefixes; they create no recipient,
-- portal grant, public link, outbox message, or Project Alpha identity.
CREATE VIEW operations_portal_workspace_effective_permissions AS
SELECT assignment.staff_id,permission.permission_key,'allow' effect,assignment.scope,assignment.division_id
FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
UNION ALL
SELECT assignment.staff_id,permission.permission_key,'allow',assignment.scope,assignment.division_id
FROM local_staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
UNION ALL
SELECT override.staff_id,override.permission_key,override.effect,override.scope,override.division_id
FROM staff_permission_overrides override;

CREATE TABLE operations_portal_workspace_reservation_commands (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,15,1)='4'
    AND substr(operation_id,19,1)='-' AND substr(operation_id,20,1) IN ('8','9','a','b') AND substr(operation_id,24,1)='-'
    AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  operation_fingerprint TEXT NOT NULL CHECK(length(operation_fingerprint)=64 AND operation_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json) AND length(CAST(canonical_command_json AS BLOB))<=32768),
  action TEXT NOT NULL CHECK(action IN ('workspace.reserve','workspace.revoke','folder.reserve','folder.revoke')),
  target_id TEXT NOT NULL CHECK(length(target_id)=36 AND target_id=lower(target_id)
    AND substr(target_id,9,1)='-' AND substr(target_id,14,1)='-' AND substr(target_id,15,1)='4'
    AND substr(target_id,19,1)='-' AND substr(target_id,20,1) IN ('8','9','a','b') AND substr(target_id,24,1)='-'
    AND replace(target_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  client_authority_id TEXT NOT NULL CHECK(length(client_authority_id)=36 AND client_authority_id=lower(client_authority_id)
    AND substr(client_authority_id,9,1)='-' AND substr(client_authority_id,14,1)='-' AND substr(client_authority_id,15,1)='4'
    AND substr(client_authority_id,19,1)='-' AND substr(client_authority_id,20,1) IN ('8','9','a','b') AND substr(client_authority_id,24,1)='-'
    AND replace(client_authority_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 200 AND length(CAST(workspace_id AS BLOB))<=800 AND instr(workspace_id,char(0))=0),
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  root_record_version INTEGER NOT NULL CHECK(root_record_version>=1),
  relationship_version INTEGER CHECK(relationship_version IS NULL OR relationship_version>=1),
  reservation_id TEXT CHECK(reservation_id IS NULL OR (length(reservation_id)=36 AND reservation_id=lower(reservation_id)
    AND substr(reservation_id,9,1)='-' AND substr(reservation_id,14,1)='-' AND substr(reservation_id,15,1)='4'
    AND substr(reservation_id,19,1)='-' AND substr(reservation_id,20,1) IN ('8','9','a','b') AND substr(reservation_id,24,1)='-'
    AND replace(reservation_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  workspace_revision INTEGER CHECK(workspace_revision IS NULL OR workspace_revision>=1),
  external_project_id TEXT REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  project_version INTEGER CHECK(project_version IS NULL OR project_version>=1),
  ops_folder_project_id TEXT,
  ops_division_id TEXT REFERENCES divisions(id) ON DELETE RESTRICT,
  base_r2_prefix TEXT,
  base_match_method TEXT,
  base_confirmed_by TEXT REFERENCES staff_users(id) ON DELETE RESTRICT,
  base_confirmed_at TEXT,
  client_folder_binding_id TEXT,
  selected_r2_prefix TEXT,
  authorized_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL CHECK(length(authorized_access_subject) BETWEEN 1 AND 191),
  authorized_email TEXT NOT NULL CHECK(length(authorized_email) BETWEEN 3 AND 254),
  authorized_admission_version INTEGER NOT NULL CHECK(authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(authorized_grant_generation>=1),
  authorized_verified_until TEXT NOT NULL CHECK(length(authorized_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',authorized_verified_until) IS authorized_verified_until),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500 AND instr(reason,char(0))=0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((action LIKE 'workspace.%' AND reservation_id IS NULL AND workspace_revision IS NULL
      AND external_project_id IS NULL AND project_version IS NULL AND ops_folder_project_id IS NULL
      AND ops_division_id IS NULL AND base_r2_prefix IS NULL AND base_match_method IS NULL
      AND base_confirmed_by IS NULL AND base_confirmed_at IS NULL AND client_folder_binding_id IS NULL
      AND selected_r2_prefix IS NULL)
    OR (action LIKE 'folder.%' AND reservation_id IS NOT NULL AND workspace_revision IS NOT NULL
      AND external_project_id IS NOT NULL AND project_version IS NOT NULL AND ops_folder_project_id IS NOT NULL
      AND ops_division_id IS NOT NULL AND base_r2_prefix IS NOT NULL AND base_match_method IS NOT NULL
      AND base_confirmed_by IS NOT NULL AND base_confirmed_at IS NOT NULL AND client_folder_binding_id IS NOT NULL
      AND selected_r2_prefix IS NOT NULL)),
  CHECK((root_kind='organization' AND relationship_version IS NULL)
    OR (root_kind='standalone_client' AND relationship_version IS NOT NULL)),
  CHECK((action IN ('workspace.reserve','folder.reserve') AND expected_revision=0)
    OR (action IN ('workspace.revoke','folder.revoke') AND expected_revision>=1))
);
CREATE UNIQUE INDEX operations_portal_workspace_command_target_revision
  ON operations_portal_workspace_reservation_commands(action,target_id,ifnull(reservation_id,''),resulting_revision);

-- The immutable audit document must describe the exact relational command.
-- The SHA-256 is produced by the runtime; these guards prevent contradictory,
-- missing, NULL-bearing or extra audit fields from being persisted by raw SQL.
CREATE TRIGGER operations_portal_workspace_command_json_guard
BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN json_type(NEW.canonical_command_json) IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json))<>3
  OR json_type(NEW.canonical_command_json,'$.action') IS NOT 'text'
  OR json_extract(NEW.canonical_command_json,'$.action') IS NOT NEW.action
  OR json_type(NEW.canonical_command_json,'$.actor') IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.actor'))<>7
  OR json_type(NEW.canonical_command_json,'$.actor.staffId') IS NOT 'text'
  OR json_extract(NEW.canonical_command_json,'$.actor.staffId') IS NOT NEW.authorized_by_staff_id
  OR json_type(NEW.canonical_command_json,'$.actor.accessSubject') IS NOT 'text'
  OR json_extract(NEW.canonical_command_json,'$.actor.accessSubject') IS NOT NEW.authorized_access_subject
  OR json_type(NEW.canonical_command_json,'$.actor.email') IS NOT 'text'
  OR json_extract(NEW.canonical_command_json,'$.actor.email') IS NOT NEW.authorized_email
  OR json_type(NEW.canonical_command_json,'$.actor.admissionVersion') IS NOT 'integer'
  OR json_extract(NEW.canonical_command_json,'$.actor.admissionVersion') IS NOT NEW.authorized_admission_version
  OR json_type(NEW.canonical_command_json,'$.actor.profileVersion') IS NOT 'integer'
  OR json_extract(NEW.canonical_command_json,'$.actor.profileVersion') IS NOT NEW.authorized_profile_version
  OR json_type(NEW.canonical_command_json,'$.actor.grantGeneration') IS NOT 'integer'
  OR json_extract(NEW.canonical_command_json,'$.actor.grantGeneration') IS NOT NEW.authorized_grant_generation
  OR json_type(NEW.canonical_command_json,'$.actor.verifiedUntil') IS NOT 'text'
  OR json_extract(NEW.canonical_command_json,'$.actor.verifiedUntil') IS NOT NEW.authorized_verified_until
  OR json_type(NEW.canonical_command_json,'$.request') IS NOT 'object'
BEGIN SELECT RAISE(ABORT,'operations portal workspace command audit is invalid'); END;

CREATE TRIGGER operations_portal_workspace_reserve_json_guard
BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='workspace.reserve' AND (
    (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.request'))<>10
    OR json_type(NEW.canonical_command_json,'$.request.operationId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.operationId') IS NOT NEW.operation_id
    OR json_type(NEW.canonical_command_json,'$.request.targetId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.targetId') IS NOT NEW.target_id
    OR json_type(NEW.canonical_command_json,'$.request.clientAuthorityId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.clientAuthorityId') IS NOT NEW.client_authority_id
    OR json_type(NEW.canonical_command_json,'$.request.workspaceId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.workspaceId') IS NOT NEW.workspace_id
    OR json_type(NEW.canonical_command_json,'$.request.rootKind') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.rootKind') IS NOT NEW.root_kind
    OR json_type(NEW.canonical_command_json,'$.request.rootRecordId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.rootRecordId') IS NOT NEW.root_record_id
    OR json_type(NEW.canonical_command_json,'$.request.rootRecordVersion') IS NOT 'integer'
    OR json_extract(NEW.canonical_command_json,'$.request.rootRecordVersion') IS NOT NEW.root_record_version
    OR ((NEW.relationship_version IS NULL AND json_type(NEW.canonical_command_json,'$.request.relationshipVersion') IS NOT 'null')
      OR (NEW.relationship_version IS NOT NULL AND (json_type(NEW.canonical_command_json,'$.request.relationshipVersion') IS NOT 'integer'
        OR json_extract(NEW.canonical_command_json,'$.request.relationshipVersion') IS NOT NEW.relationship_version)))
    OR json_type(NEW.canonical_command_json,'$.request.expectedRevision') IS NOT 'integer'
    OR json_extract(NEW.canonical_command_json,'$.request.expectedRevision') IS NOT NEW.expected_revision
    OR json_type(NEW.canonical_command_json,'$.request.reason') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.reason') IS NOT NEW.reason)
BEGIN SELECT RAISE(ABORT,'operations portal workspace reserve audit is invalid'); END;

CREATE TRIGGER operations_portal_workspace_revoke_json_guard
BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='workspace.revoke' AND (
    (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.request'))<>4
    OR json_type(NEW.canonical_command_json,'$.request.operationId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.operationId') IS NOT NEW.operation_id
    OR json_type(NEW.canonical_command_json,'$.request.targetId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.targetId') IS NOT NEW.target_id
    OR json_type(NEW.canonical_command_json,'$.request.expectedRevision') IS NOT 'integer'
    OR json_extract(NEW.canonical_command_json,'$.request.expectedRevision') IS NOT NEW.expected_revision
    OR json_type(NEW.canonical_command_json,'$.request.reason') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.reason') IS NOT NEW.reason)
BEGIN SELECT RAISE(ABORT,'operations portal workspace revoke audit is invalid'); END;

CREATE TRIGGER operations_portal_folder_reserve_json_guard
BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.reserve' AND (
    (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.request'))<>16
    OR json_type(NEW.canonical_command_json,'$.request.operationId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.operationId') IS NOT NEW.operation_id
    OR json_type(NEW.canonical_command_json,'$.request.targetId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.targetId') IS NOT NEW.target_id
    OR json_type(NEW.canonical_command_json,'$.request.reservationId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.reservationId') IS NOT NEW.reservation_id
    OR json_type(NEW.canonical_command_json,'$.request.expectedRevision') IS NOT 'integer'
    OR json_extract(NEW.canonical_command_json,'$.request.expectedRevision') IS NOT NEW.expected_revision
    OR json_type(NEW.canonical_command_json,'$.request.expectedWorkspaceRevision') IS NOT 'integer'
    OR json_extract(NEW.canonical_command_json,'$.request.expectedWorkspaceRevision') IS NOT NEW.workspace_revision
    OR json_type(NEW.canonical_command_json,'$.request.externalProjectId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.externalProjectId') IS NOT NEW.external_project_id
    OR json_type(NEW.canonical_command_json,'$.request.projectVersion') IS NOT 'integer'
    OR json_extract(NEW.canonical_command_json,'$.request.projectVersion') IS NOT NEW.project_version
    OR json_type(NEW.canonical_command_json,'$.request.opsFolderProjectId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.opsFolderProjectId') IS NOT NEW.ops_folder_project_id
    OR json_type(NEW.canonical_command_json,'$.request.opsDivisionId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.opsDivisionId') IS NOT NEW.ops_division_id
)
BEGIN SELECT RAISE(ABORT,'operations portal folder reserve identity audit is invalid'); END;

CREATE TRIGGER operations_portal_folder_reserve_resource_json_guard
BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.reserve' AND (
    json_type(NEW.canonical_command_json,'$.request.baseR2Prefix') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.baseR2Prefix') IS NOT NEW.base_r2_prefix
    OR json_type(NEW.canonical_command_json,'$.request.baseMatchMethod') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.baseMatchMethod') IS NOT NEW.base_match_method
    OR json_type(NEW.canonical_command_json,'$.request.baseConfirmedBy') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.baseConfirmedBy') IS NOT NEW.base_confirmed_by
    OR json_type(NEW.canonical_command_json,'$.request.baseConfirmedAt') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.baseConfirmedAt') IS NOT NEW.base_confirmed_at
    OR json_type(NEW.canonical_command_json,'$.request.clientFolderBindingId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.clientFolderBindingId') IS NOT NEW.client_folder_binding_id
    OR json_type(NEW.canonical_command_json,'$.request.selectedR2Prefix') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.selectedR2Prefix') IS NOT NEW.selected_r2_prefix
    OR json_type(NEW.canonical_command_json,'$.request.reason') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.reason') IS NOT NEW.reason)
BEGIN SELECT RAISE(ABORT,'operations portal folder reserve audit is invalid'); END;

CREATE TRIGGER operations_portal_folder_revoke_json_guard
BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.revoke' AND (
    (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.request'))<>5
    OR json_type(NEW.canonical_command_json,'$.request.operationId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.operationId') IS NOT NEW.operation_id
    OR json_type(NEW.canonical_command_json,'$.request.targetId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.targetId') IS NOT NEW.target_id
    OR json_type(NEW.canonical_command_json,'$.request.reservationId') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.reservationId') IS NOT NEW.reservation_id
    OR json_type(NEW.canonical_command_json,'$.request.expectedRevision') IS NOT 'integer'
    OR json_extract(NEW.canonical_command_json,'$.request.expectedRevision') IS NOT NEW.expected_revision
    OR json_type(NEW.canonical_command_json,'$.request.reason') IS NOT 'text'
    OR json_extract(NEW.canonical_command_json,'$.request.reason') IS NOT NEW.reason)
BEGIN SELECT RAISE(ABORT,'operations portal folder revoke audit is invalid'); END;

CREATE TABLE operations_portal_workspace_reservation_heads (
  target_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_reservation_commands(operation_id) ON DELETE RESTRICT,
  client_authority_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL UNIQUE,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  root_record_version INTEGER NOT NULL,
  relationship_version INTEGER,
  creation_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_reservation_commands(operation_id) ON DELETE RESTRICT,
  created_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_access_subject TEXT NOT NULL,
  created_admission_version INTEGER NOT NULL,
  created_profile_version INTEGER NOT NULL,
  created_grant_generation INTEGER NOT NULL,
  revoked_by_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  revoked_operation_id TEXT UNIQUE REFERENCES operations_portal_workspace_reservation_commands(operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='active' AND revoked_by_staff_id IS NULL AND revoked_operation_id IS NULL)
    OR (state='revoked' AND revoked_by_staff_id IS NOT NULL AND revoked_operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX operations_portal_workspace_one_active_root
  ON operations_portal_workspace_reservation_heads(root_kind,root_record_id) WHERE state='active';
CREATE UNIQUE INDEX operations_portal_workspace_one_active_identity
  ON operations_portal_workspace_reservation_heads(client_authority_id,workspace_id) WHERE state='active';

CREATE TABLE operations_portal_folder_reservation_heads (
  reservation_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES operations_portal_workspace_reservation_heads(target_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_reservation_commands(operation_id) ON DELETE RESTRICT,
  pinned_workspace_revision INTEGER NOT NULL,
  external_project_id TEXT NOT NULL REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  project_version INTEGER NOT NULL,
  ops_folder_project_id TEXT NOT NULL,
  ops_division_id TEXT NOT NULL REFERENCES divisions(id) ON DELETE RESTRICT,
  base_r2_prefix TEXT NOT NULL,
  base_match_method TEXT NOT NULL,
  base_confirmed_by TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  base_confirmed_at TEXT NOT NULL,
  client_folder_binding_id TEXT NOT NULL,
  selected_r2_prefix TEXT NOT NULL,
  creation_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_reservation_commands(operation_id) ON DELETE RESTRICT,
  created_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_access_subject TEXT NOT NULL,
  created_admission_version INTEGER NOT NULL,
  created_profile_version INTEGER NOT NULL,
  created_grant_generation INTEGER NOT NULL,
  revoked_by_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  revoked_operation_id TEXT UNIQUE REFERENCES operations_portal_workspace_reservation_commands(operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='active' AND revoked_by_staff_id IS NULL AND revoked_operation_id IS NULL)
    OR (state='revoked' AND revoked_by_staff_id IS NOT NULL AND revoked_operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX operations_portal_folder_one_active_binding
  ON operations_portal_folder_reservation_heads(target_id,client_folder_binding_id) WHERE state='active';
CREATE UNIQUE INDEX operations_portal_folder_permanent_binding
  ON operations_portal_folder_reservation_heads(client_folder_binding_id);
CREATE UNIQUE INDEX operations_portal_folder_one_active_prefix
  ON operations_portal_folder_reservation_heads(target_id,selected_r2_prefix) WHERE state='active';

CREATE VIEW operations_portal_workspace_effective_portal_permissions AS
SELECT grant_row.staff_id,grant_row.effect,record.record_id
FROM native_directory_grants grant_row JOIN operations_directory_records record
WHERE grant_row.permission='directory.portal_access.manage' AND grant_row.active=1 AND grant_row.scope_kind='global'
UNION ALL
SELECT grant_row.staff_id,grant_row.effect,grant_row.resource_id
FROM native_directory_grants grant_row
WHERE grant_row.permission='directory.portal_access.manage' AND grant_row.active=1 AND grant_row.scope_kind='resource'
UNION ALL
SELECT grant_row.staff_id,grant_row.effect,assignment.record_id
FROM native_directory_grants grant_row JOIN native_directory_assignments assignment
  ON assignment.staff_id=grant_row.staff_id AND assignment.active=1
WHERE grant_row.permission='directory.portal_access.manage' AND grant_row.active=1 AND grant_row.scope_kind='assigned'
UNION ALL
SELECT grant_row.staff_id,grant_row.effect,scope.record_id
FROM native_directory_grants grant_row JOIN native_directory_resource_scopes scope
  ON scope.business_area_id=grant_row.business_area_id AND scope.active=1
JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
WHERE grant_row.permission='directory.portal_access.manage' AND grant_row.active=1 AND grant_row.scope_kind='business_area'
UNION ALL
SELECT grant_row.staff_id,grant_row.effect,scope.record_id
FROM native_directory_grants grant_row JOIN native_directory_resource_scopes scope
  ON scope.division_id=grant_row.division_id AND scope.active=1
JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
JOIN native_business_divisions division ON division.id=scope.division_id
  AND division.business_area_id=scope.business_area_id AND division.active=1
WHERE grant_row.permission='directory.portal_access.manage' AND grant_row.active=1 AND grant_row.scope_kind='division';

-- This view is deliberately a live proof, not an owner label.  It binds the
-- Access subject, admission/profile versions, grant generation and expiry,
-- then applies every applicable portal-management deny.
CREATE VIEW operations_portal_workspace_live_command_authority AS
SELECT command.operation_id FROM operations_portal_workspace_reservation_commands command
JOIN native_staff_admissions admission ON admission.staff_id=command.authorized_by_staff_id
  AND admission.active=1 AND admission.bound_access_subject=command.authorized_access_subject
  AND admission.version=command.authorized_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  AND profile.login_email=command.authorized_email AND profile.version=command.authorized_profile_version
JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  AND generation.generation=command.authorized_grant_generation
WHERE command.authorized_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS(SELECT 1 FROM staff_role_assignments trusted
    WHERE trusted.staff_id=command.authorized_by_staff_id AND trusted.role_id='role-owner' AND trusted.scope='global')
  AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=command.authorized_by_staff_id AND permission.effect='allow'
      AND permission.record_id=command.root_record_id)
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=command.authorized_by_staff_id AND permission.effect='deny'
      AND permission.record_id=command.root_record_id)
  AND (command.action LIKE 'workspace.%' OR (
    (SELECT count(DISTINCT permission.permission_key) FROM operations_portal_workspace_effective_permissions permission
      WHERE permission.staff_id=command.authorized_by_staff_id AND permission.effect='allow'
        AND (permission.permission_key IN ('projects.view','delivery.browse')
          OR (command.action='folder.reserve' AND permission.permission_key='delivery.share.create')
          OR (command.action='folder.revoke' AND permission.permission_key='delivery.share.revoke'))
        AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))=3
    AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
      WHERE permission.staff_id=command.authorized_by_staff_id AND permission.effect='deny'
        AND (permission.permission_key IN ('projects.view','delivery.browse')
          OR (command.action='folder.reserve' AND permission.permission_key='delivery.share.create')
          OR (command.action='folder.revoke' AND permission.permission_key='delivery.share.revoke'))
        AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))));

CREATE TRIGGER operations_portal_workspace_command_authority_guard AFTER INSERT ON operations_portal_workspace_reservation_commands
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_live_command_authority live WHERE live.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operations portal workspace authority denied'); END;

CREATE TRIGGER operations_portal_workspace_reserve_root_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='workspace.reserve' AND NOT EXISTS(SELECT 1 FROM operations_directory_records record
  JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
  WHERE record.record_id=NEW.root_record_id AND record.current_version=NEW.root_record_version
    AND ((NEW.root_kind='organization' AND record.record_kind='organization' AND NEW.relationship_version IS NULL)
      OR (NEW.root_kind='standalone_client' AND record.record_kind='client' AND EXISTS(
        SELECT 1 FROM operations_directory_client_organizations relationship
        JOIN operations_directory_client_organization_history history
          ON history.client_record_id=relationship.client_record_id AND history.relationship_version=relationship.relationship_version
        WHERE relationship.client_record_id=record.record_id AND relationship.organization_record_id IS NULL
          AND relationship.relationship_version=NEW.relationship_version AND history.organization_record_id IS NULL
          AND history.client_record_version=record.current_version))))
BEGIN SELECT RAISE(ABORT,'operations portal workspace root is stale or invalid'); END;

CREATE TRIGGER operations_portal_folder_reserve_root_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.reserve' AND NOT EXISTS(SELECT 1 FROM operations_directory_records record
  WHERE record.record_id=NEW.root_record_id AND ((NEW.root_kind='organization' AND record.record_kind='organization')
    OR (NEW.root_kind='standalone_client' AND record.record_kind='client' AND EXISTS(
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=record.record_id AND relationship.organization_record_id IS NULL))))
BEGIN SELECT RAISE(ABORT,'operations portal folder root is stale or invalid'); END;

CREATE TRIGGER operations_portal_revoke_root_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action IN ('workspace.revoke','folder.revoke') AND NOT EXISTS(SELECT 1 FROM operations_directory_records record
  WHERE record.record_id=NEW.root_record_id AND ((NEW.root_kind='organization' AND record.record_kind='organization')
    OR (NEW.root_kind='standalone_client' AND record.record_kind='client')))
BEGIN SELECT RAISE(ABORT,'operations portal revoke root is invalid'); END;

CREATE TRIGGER operations_portal_workspace_reserve_revision_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='workspace.reserve' AND EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_heads head WHERE head.target_id=NEW.target_id)
BEGIN SELECT RAISE(ABORT,'operations portal workspace reservation conflict'); END;

CREATE TRIGGER operations_portal_workspace_revoke_revision_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='workspace.revoke' AND (NOT EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_heads head
  WHERE head.target_id=NEW.target_id AND head.state='active' AND head.revision=NEW.expected_revision
    AND head.client_authority_id=NEW.client_authority_id AND head.workspace_id=NEW.workspace_id
    AND head.root_kind=NEW.root_kind AND head.root_record_id=NEW.root_record_id
    AND head.root_record_version=NEW.root_record_version AND head.relationship_version IS NEW.relationship_version)
  OR EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads folder
    WHERE folder.target_id=NEW.target_id AND folder.state='active'))
BEGIN SELECT RAISE(ABORT,'operations portal workspace revoke conflict'); END;

CREATE TRIGGER operations_portal_folder_reserve_revision_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.reserve' AND (NOT EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_heads head
  WHERE head.target_id=NEW.target_id AND head.state='active' AND head.revision=NEW.workspace_revision
    AND head.client_authority_id=NEW.client_authority_id AND head.workspace_id=NEW.workspace_id
    AND head.root_kind=NEW.root_kind AND head.root_record_id=NEW.root_record_id
    AND head.root_record_version=NEW.root_record_version AND head.relationship_version IS NEW.relationship_version)
  OR EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads folder WHERE folder.reservation_id=NEW.reservation_id))
BEGIN SELECT RAISE(ABORT,'operations portal folder reserve conflict'); END;

CREATE TRIGGER operations_portal_folder_revoke_revision_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.revoke' AND NOT EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads folder
  JOIN operations_portal_workspace_reservation_heads head ON head.target_id=folder.target_id
  WHERE folder.reservation_id=NEW.reservation_id AND folder.target_id=NEW.target_id AND folder.state='active'
    AND folder.revision=NEW.expected_revision AND head.state='active' AND head.revision=NEW.workspace_revision
    AND head.client_authority_id=NEW.client_authority_id AND head.workspace_id=NEW.workspace_id
    AND head.root_kind=NEW.root_kind AND head.root_record_id=NEW.root_record_id
    AND head.root_record_version=NEW.root_record_version AND head.relationship_version IS NEW.relationship_version
    AND folder.external_project_id=NEW.external_project_id AND folder.project_version=NEW.project_version
    AND folder.ops_folder_project_id=NEW.ops_folder_project_id AND folder.ops_division_id=NEW.ops_division_id
    AND folder.base_r2_prefix=NEW.base_r2_prefix AND folder.base_match_method=NEW.base_match_method
    AND folder.base_confirmed_by=NEW.base_confirmed_by AND folder.base_confirmed_at=NEW.base_confirmed_at
    AND folder.client_folder_binding_id=NEW.client_folder_binding_id AND folder.selected_r2_prefix=NEW.selected_r2_prefix)
BEGIN SELECT RAISE(ABORT,'operations portal folder revoke conflict'); END;

CREATE TRIGGER operations_portal_folder_command_resource_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.reserve' AND NOT EXISTS(SELECT 1 FROM operations_shared_projects project
  JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
    AND revision.version=project.current_version
  JOIN project_folders folder ON folder.project_id=NEW.ops_folder_project_id
  JOIN operations_portal_workspace_reservation_heads workspace ON workspace.target_id=NEW.target_id
  WHERE project.external_project_id=NEW.external_project_id AND project.current_version=NEW.project_version
    AND folder.division_id=NEW.ops_division_id AND folder.r2_prefix=NEW.base_r2_prefix
    AND folder.match_method=NEW.base_match_method AND folder.confirmed_by=NEW.base_confirmed_by
    AND folder.confirmed_at=NEW.base_confirmed_at
    AND ((workspace.root_kind='organization' AND (project.organization_record_id IS NOT NULL OR project.client_record_id IS NOT NULL)
      AND (project.organization_record_id IS NULL OR project.organization_record_id=workspace.root_record_id)
      AND (project.client_record_id IS NULL OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=project.client_record_id AND relationship.organization_record_id=workspace.root_record_id)))
      OR (workspace.root_kind='standalone_client' AND project.organization_record_id IS NULL
        AND project.client_record_id=workspace.root_record_id)))
BEGIN SELECT RAISE(ABORT,'operations portal folder resource is stale or invalid'); END;

CREATE TRIGGER operations_portal_folder_command_base_prefix_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.reserve' AND (length(NEW.base_r2_prefix) NOT BETWEEN 2 AND 1000
  OR NEW.base_r2_prefix IS NOT trim(NEW.base_r2_prefix) OR substr(NEW.base_r2_prefix,1,1)='/'
  OR substr(NEW.base_r2_prefix,-1)<>'/' OR instr(NEW.base_r2_prefix,char(92))<>0 OR instr(NEW.base_r2_prefix,'//')<>0
  OR instr(NEW.base_r2_prefix,'*')<>0 OR instr(NEW.base_r2_prefix,'?')<>0 OR instr(NEW.base_r2_prefix,'[')<>0
  OR instr(NEW.base_r2_prefix,']')<>0 OR instr(NEW.base_r2_prefix,'{')<>0 OR instr(NEW.base_r2_prefix,'}')<>0
  OR instr(NEW.base_r2_prefix,'#')<>0 OR instr(NEW.base_r2_prefix,'%')<>0 OR instr(NEW.base_r2_prefix,char(0))<>0
  OR NEW.base_r2_prefix GLOB ('*['||char(1)||'-'||char(31)||char(127)||']*')
  OR instr('/'||lower(NEW.base_r2_prefix),'/./')<>0 OR instr('/'||lower(NEW.base_r2_prefix),'/../')<>0
  OR instr('/'||lower(NEW.base_r2_prefix),'/dump/')<>0 OR instr('/'||lower(NEW.base_r2_prefix),'/_ltds/')<>0
  OR instr('/'||lower(NEW.base_r2_prefix),'/.previews/')<>0)
BEGIN SELECT RAISE(ABORT,'operations portal folder base prefix is invalid'); END;

CREATE TRIGGER operations_portal_folder_command_selected_prefix_guard BEFORE INSERT ON operations_portal_workspace_reservation_commands
WHEN NEW.action='folder.reserve' AND (length(NEW.selected_r2_prefix) NOT BETWEEN 2 AND 1000
  OR NEW.selected_r2_prefix IS NOT trim(NEW.selected_r2_prefix) OR substr(NEW.selected_r2_prefix,1,1)='/'
  OR substr(NEW.selected_r2_prefix,-1)<>'/' OR instr(NEW.selected_r2_prefix,char(92))<>0 OR instr(NEW.selected_r2_prefix,'//')<>0
  OR instr(NEW.selected_r2_prefix,'*')<>0 OR instr(NEW.selected_r2_prefix,'?')<>0 OR instr(NEW.selected_r2_prefix,'[')<>0
  OR instr(NEW.selected_r2_prefix,']')<>0 OR instr(NEW.selected_r2_prefix,'{')<>0 OR instr(NEW.selected_r2_prefix,'}')<>0
  OR instr(NEW.selected_r2_prefix,'#')<>0 OR instr(NEW.selected_r2_prefix,'%')<>0 OR instr(NEW.selected_r2_prefix,char(0))<>0
  OR NEW.selected_r2_prefix GLOB ('*['||char(1)||'-'||char(31)||char(127)||']*')
  OR instr('/'||lower(NEW.selected_r2_prefix),'/./')<>0 OR instr('/'||lower(NEW.selected_r2_prefix),'/../')<>0
  OR instr('/'||lower(NEW.selected_r2_prefix),'/dump/')<>0 OR instr('/'||lower(NEW.selected_r2_prefix),'/_ltds/')<>0
  OR instr('/'||lower(NEW.selected_r2_prefix),'/.previews/')<>0
  OR substr(NEW.selected_r2_prefix,1,length(NEW.base_r2_prefix)) IS NOT NEW.base_r2_prefix)
BEGIN SELECT RAISE(ABORT,'operations portal selected folder prefix is invalid'); END;

CREATE VIEW operations_portal_workspace_current_reserve_commands AS
SELECT command.operation_id FROM operations_portal_workspace_reservation_commands command
JOIN operations_directory_records record ON record.record_id=command.root_record_id
JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
WHERE command.action='workspace.reserve' AND record.current_version=command.root_record_version
  AND ((command.root_kind='organization' AND record.record_kind='organization' AND command.relationship_version IS NULL)
    OR (command.root_kind='standalone_client' AND record.record_kind='client' AND EXISTS(
      SELECT 1 FROM operations_directory_client_organizations relationship
      JOIN operations_directory_client_organization_history history
        ON history.client_record_id=relationship.client_record_id AND history.relationship_version=relationship.relationship_version
      WHERE relationship.client_record_id=record.record_id AND relationship.organization_record_id IS NULL
        AND relationship.relationship_version=command.relationship_version AND history.organization_record_id IS NULL
        AND history.client_record_version=record.current_version)));

CREATE VIEW operations_portal_folder_current_reserve_commands AS
SELECT command.operation_id FROM operations_portal_workspace_reservation_commands command
JOIN operations_portal_workspace_reservation_heads workspace ON workspace.target_id=command.target_id
  AND workspace.state='active' AND workspace.revision=command.workspace_revision
JOIN operations_directory_records record ON record.record_id=command.root_record_id
JOIN operations_shared_projects project ON project.external_project_id=command.external_project_id
  AND project.current_version=command.project_version
JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
  AND revision.version=project.current_version
JOIN project_folders folder ON folder.project_id=command.ops_folder_project_id
  AND folder.division_id=command.ops_division_id AND folder.r2_prefix=command.base_r2_prefix
  AND folder.match_method=command.base_match_method AND folder.confirmed_by=command.base_confirmed_by
  AND folder.confirmed_at=command.base_confirmed_at
WHERE command.action='folder.reserve'
  AND ((workspace.root_kind='organization' AND record.record_kind='organization'
      AND (project.organization_record_id IS NOT NULL OR project.client_record_id IS NOT NULL)
      AND (project.organization_record_id IS NULL OR project.organization_record_id=workspace.root_record_id)
      AND (project.client_record_id IS NULL OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=project.client_record_id AND relationship.organization_record_id=workspace.root_record_id)))
    OR (workspace.root_kind='standalone_client' AND record.record_kind='client'
      AND EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=workspace.root_record_id AND relationship.organization_record_id IS NULL)
      AND project.organization_record_id IS NULL AND project.client_record_id=workspace.root_record_id));

CREATE TRIGGER operations_portal_workspace_heads_insert_guard BEFORE INSERT ON operations_portal_workspace_reservation_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_commands command
  JOIN operations_portal_workspace_live_command_authority live ON live.operation_id=command.operation_id
  JOIN operations_portal_workspace_current_reserve_commands current ON current.operation_id=command.operation_id
  WHERE command.operation_id=NEW.latest_operation_id AND command.operation_id=NEW.creation_operation_id
    AND command.action='workspace.reserve' AND command.target_id=NEW.target_id AND command.resulting_revision=NEW.revision
    AND NEW.revision=1 AND NEW.state='active' AND command.client_authority_id=NEW.client_authority_id
    AND command.workspace_id=NEW.workspace_id AND command.root_kind=NEW.root_kind
    AND command.root_record_id=NEW.root_record_id AND command.root_record_version=NEW.root_record_version
    AND command.relationship_version IS NEW.relationship_version AND command.authorized_by_staff_id=NEW.created_by_staff_id
    AND command.authorized_access_subject=NEW.created_access_subject
    AND command.authorized_admission_version=NEW.created_admission_version
    AND command.authorized_profile_version=NEW.created_profile_version
    AND command.authorized_grant_generation=NEW.created_grant_generation)
BEGIN SELECT RAISE(ABORT,'operations portal workspace head insert denied'); END;
CREATE TRIGGER operations_portal_workspace_heads_update_guard BEFORE UPDATE ON operations_portal_workspace_reservation_heads
WHEN NEW.target_id IS NOT OLD.target_id OR OLD.state<>'active' OR NEW.state<>'revoked' OR NEW.revision<>OLD.revision+1
  OR NEW.client_authority_id IS NOT OLD.client_authority_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.root_kind IS NOT OLD.root_kind OR NEW.root_record_id IS NOT OLD.root_record_id
  OR NEW.root_record_version IS NOT OLD.root_record_version OR NEW.relationship_version IS NOT OLD.relationship_version
  OR NEW.creation_operation_id IS NOT OLD.creation_operation_id OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id
  OR NEW.created_access_subject IS NOT OLD.created_access_subject OR NEW.created_admission_version IS NOT OLD.created_admission_version
  OR NEW.created_profile_version IS NOT OLD.created_profile_version OR NEW.created_grant_generation IS NOT OLD.created_grant_generation
  OR NEW.created_at IS NOT OLD.created_at OR NEW.revoked_operation_id IS NOT NEW.latest_operation_id
  OR EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads folder
    WHERE folder.target_id=OLD.target_id AND folder.state='active')
  OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_commands command
    JOIN operations_portal_workspace_live_command_authority live ON live.operation_id=command.operation_id
    JOIN operations_directory_records record ON record.record_id=command.root_record_id
      AND ((command.root_kind='organization' AND record.record_kind='organization')
        OR (command.root_kind='standalone_client' AND record.record_kind='client'))
    WHERE command.operation_id=NEW.latest_operation_id AND command.action='workspace.revoke'
      AND command.target_id=OLD.target_id AND command.expected_revision=OLD.revision
      AND command.resulting_revision=NEW.revision AND command.authorized_by_staff_id=NEW.revoked_by_staff_id)
BEGIN SELECT RAISE(ABORT,'operations portal workspace head update denied'); END;
CREATE TRIGGER operations_portal_workspace_heads_no_delete BEFORE DELETE ON operations_portal_workspace_reservation_heads
BEGIN SELECT RAISE(ABORT,'operations portal workspace heads are durable'); END;

CREATE TRIGGER operations_portal_folder_heads_insert_guard BEFORE INSERT ON operations_portal_folder_reservation_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_commands command
  JOIN operations_portal_workspace_live_command_authority live ON live.operation_id=command.operation_id
  JOIN operations_portal_folder_current_reserve_commands current ON current.operation_id=command.operation_id
  WHERE command.operation_id=NEW.latest_operation_id AND command.operation_id=NEW.creation_operation_id
    AND command.action='folder.reserve' AND command.reservation_id=NEW.reservation_id AND command.target_id=NEW.target_id
    AND command.resulting_revision=NEW.revision AND NEW.revision=1 AND NEW.state='active'
    AND command.workspace_revision=NEW.pinned_workspace_revision AND command.external_project_id=NEW.external_project_id
    AND command.project_version=NEW.project_version AND command.ops_folder_project_id=NEW.ops_folder_project_id
    AND command.ops_division_id=NEW.ops_division_id AND command.base_r2_prefix=NEW.base_r2_prefix
    AND command.base_match_method=NEW.base_match_method AND command.base_confirmed_by=NEW.base_confirmed_by
    AND command.base_confirmed_at=NEW.base_confirmed_at AND command.client_folder_binding_id=NEW.client_folder_binding_id
    AND command.selected_r2_prefix=NEW.selected_r2_prefix AND command.authorized_by_staff_id=NEW.created_by_staff_id
    AND command.authorized_access_subject=NEW.created_access_subject
    AND command.authorized_admission_version=NEW.created_admission_version
    AND command.authorized_profile_version=NEW.created_profile_version
    AND command.authorized_grant_generation=NEW.created_grant_generation)
BEGIN SELECT RAISE(ABORT,'operations portal folder head insert denied'); END;
CREATE TRIGGER operations_portal_folder_heads_update_guard BEFORE UPDATE ON operations_portal_folder_reservation_heads
WHEN NEW.reservation_id IS NOT OLD.reservation_id OR NEW.target_id IS NOT OLD.target_id OR OLD.state<>'active' OR NEW.state<>'revoked'
  OR NEW.revision<>OLD.revision+1 OR NEW.pinned_workspace_revision IS NOT OLD.pinned_workspace_revision
  OR NEW.external_project_id IS NOT OLD.external_project_id OR NEW.project_version IS NOT OLD.project_version
  OR NEW.ops_folder_project_id IS NOT OLD.ops_folder_project_id OR NEW.ops_division_id IS NOT OLD.ops_division_id
  OR NEW.base_r2_prefix IS NOT OLD.base_r2_prefix OR NEW.base_match_method IS NOT OLD.base_match_method
  OR NEW.base_confirmed_by IS NOT OLD.base_confirmed_by OR NEW.base_confirmed_at IS NOT OLD.base_confirmed_at
  OR NEW.client_folder_binding_id IS NOT OLD.client_folder_binding_id OR NEW.selected_r2_prefix IS NOT OLD.selected_r2_prefix
  OR NEW.creation_operation_id IS NOT OLD.creation_operation_id OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id
  OR NEW.created_access_subject IS NOT OLD.created_access_subject OR NEW.created_admission_version IS NOT OLD.created_admission_version
  OR NEW.created_profile_version IS NOT OLD.created_profile_version OR NEW.created_grant_generation IS NOT OLD.created_grant_generation
  OR NEW.created_at IS NOT OLD.created_at OR NEW.revoked_operation_id IS NOT NEW.latest_operation_id
  OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_commands command
    JOIN operations_portal_workspace_live_command_authority live ON live.operation_id=command.operation_id
    JOIN operations_directory_records record ON record.record_id=command.root_record_id
      AND ((command.root_kind='organization' AND record.record_kind='organization')
        OR (command.root_kind='standalone_client' AND record.record_kind='client'))
    WHERE command.operation_id=NEW.latest_operation_id AND command.action='folder.revoke'
      AND command.reservation_id=OLD.reservation_id AND command.expected_revision=OLD.revision
      AND command.resulting_revision=NEW.revision AND command.authorized_by_staff_id=NEW.revoked_by_staff_id)
BEGIN SELECT RAISE(ABORT,'operations portal folder head update denied'); END;
CREATE TRIGGER operations_portal_folder_heads_no_delete BEFORE DELETE ON operations_portal_folder_reservation_heads
BEGIN SELECT RAISE(ABORT,'operations portal folder heads are durable'); END;

CREATE TRIGGER operations_portal_workspace_commands_no_update BEFORE UPDATE ON operations_portal_workspace_reservation_commands
BEGIN SELECT RAISE(ABORT,'operations portal workspace commands are immutable'); END;
CREATE TRIGGER operations_portal_workspace_commands_no_delete BEFORE DELETE ON operations_portal_workspace_reservation_commands
BEGIN SELECT RAISE(ABORT,'operations portal workspace commands are durable'); END;

-- A physical base cannot move while an active selected-prefix reservation pins
-- it.  Revoke every child first; the historical tuple remains immutable.
CREATE TRIGGER operations_portal_project_folders_active_update_guard BEFORE UPDATE ON project_folders
WHEN EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads reservation
  WHERE reservation.ops_folder_project_id=OLD.project_id AND reservation.state='active')
BEGIN SELECT RAISE(ABORT,'active operations portal folder reservation blocks base change'); END;
CREATE TRIGGER operations_portal_project_folders_active_delete_guard BEFORE DELETE ON project_folders
WHEN EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads reservation
  WHERE reservation.ops_folder_project_id=OLD.project_id AND reservation.state='active')
BEGIN SELECT RAISE(ABORT,'active operations portal folder reservation blocks base delete'); END;
