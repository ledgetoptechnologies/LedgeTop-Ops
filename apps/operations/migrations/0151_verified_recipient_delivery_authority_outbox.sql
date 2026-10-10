PRAGMA foreign_keys = ON;

-- Staging-only, default-off storage for one explicitly reviewed verified
-- recipient folder authority.  This migration creates no route, service
-- binding, flag, membership, entitlement, PA principal, or public link.
CREATE VIEW verified_recipient_delivery_effective_permissions AS
SELECT a.staff_id,rp.permission_key,'allow' effect,a.scope,a.division_id
FROM staff_role_assignments a JOIN role_permissions rp ON rp.role_id=a.role_id
UNION ALL
SELECT a.staff_id,rp.permission_key,'allow',a.scope,a.division_id
FROM local_staff_role_assignments a JOIN role_permissions rp ON rp.role_id=a.role_id
UNION ALL
SELECT o.staff_id,o.permission_key,o.effect,o.scope,o.division_id
FROM staff_permission_overrides o;

CREATE TABLE verified_recipient_delivery_authority_commands (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,15,1)='4'
    AND substr(operation_id,19,1)='-' AND substr(operation_id,20,1) IN ('8','9','a','b') AND substr(operation_id,24,1)='-'
    AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN ('upsert','revoke')),
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256)=64 AND command_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation_fingerprint TEXT NOT NULL CHECK(length(operation_fingerprint)=64 AND operation_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json)
    AND length(CAST(canonical_command_json AS BLOB))<=32768),
  authority_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  recipient_binding_id TEXT NOT NULL REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  enrollment_intent_id TEXT NOT NULL REFERENCES client_portal_recipient_enrollment_intents(intent_id) ON DELETE RESTRICT,
  enrollment_revision INTEGER NOT NULL CHECK(enrollment_revision>=1),
  issuer TEXT NOT NULL CHECK(length(trim(issuer)) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK(length(trim(subject)) BETWEEN 1 AND 512),
  selection_id TEXT NOT NULL REFERENCES client_portal_workspace_binding_selections(selection_id) ON DELETE RESTRICT,
  client_authority_id TEXT NOT NULL,
  client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL,
  home_ownership_epoch INTEGER NOT NULL CHECK(home_ownership_epoch>=1),
  home_grant_revision INTEGER NOT NULL CHECK(home_grant_revision>=1),
  home_grant_operation_id TEXT NOT NULL REFERENCES client_portal_authority_v2_outbox_receipts(operation_id) ON DELETE RESTRICT,
  folder_binding_id TEXT NOT NULL,
  folder_binding_source_version TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  project_source_version TEXT NOT NULL,
  current_generation_id TEXT NOT NULL,
  ops_project_id TEXT NOT NULL,
  ops_division_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  resource_proof_sha256 TEXT NOT NULL CHECK(length(resource_proof_sha256)=64 AND resource_proof_sha256 NOT GLOB '*[^0-9a-f]*'),
  resource_proof_json TEXT NOT NULL CHECK(json_valid(resource_proof_json)
    AND length(CAST(resource_proof_json AS BLOB))<=16384),
  reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) BETWEEN 1 AND 80),
  expires_at TEXT CHECK(expires_at IS NULL OR (length(expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at)),
  access_terms_id TEXT NOT NULL,
  access_kind TEXT NOT NULL CHECK(access_kind IN ('customer','collaborator')),
  access_mode TEXT NOT NULL CHECK(access_mode IN ('specific_date','project_end','until_revoked')),
  reviewed_expires_at TEXT CHECK(reviewed_expires_at IS NULL OR (length(reviewed_expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_expires_at)=reviewed_expires_at)),
  effective_expires_at TEXT CHECK(effective_expires_at IS NULL OR (length(effective_expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',effective_expires_at)=effective_expires_at)),
  authorized_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL,
  authorized_admission_version INTEGER NOT NULL CHECK(authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(authorized_grant_generation>=1),
  authorized_verified_until TEXT NOT NULL CHECK(length(authorized_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',authorized_verified_until)=authorized_verified_until),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(authority_id,resulting_revision),
  CHECK((action='upsert' AND expected_revision>=0) OR (action='revoke' AND expected_revision>=1)),
  CHECK(effective_expires_at IS expires_at)
);
CREATE INDEX verified_recipient_delivery_commands_recipient
  ON verified_recipient_delivery_authority_commands(recipient_binding_id,created_at,operation_id);

CREATE TABLE verified_recipient_delivery_authority_heads (
  authority_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES verified_recipient_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  recipient_binding_id TEXT NOT NULL REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  enrollment_intent_id TEXT NOT NULL REFERENCES client_portal_recipient_enrollment_intents(intent_id) ON DELETE RESTRICT,
  enrollment_revision INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  selection_id TEXT NOT NULL,
  client_authority_id TEXT NOT NULL,
  client_record_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  home_ownership_epoch INTEGER NOT NULL,
  home_grant_revision INTEGER NOT NULL,
  home_grant_operation_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  folder_binding_source_version TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  project_source_version TEXT NOT NULL,
  current_generation_id TEXT NOT NULL,
  ops_project_id TEXT NOT NULL,
  ops_division_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  resource_proof_sha256 TEXT NOT NULL,
  resource_proof_json TEXT NOT NULL CHECK(json_valid(resource_proof_json)),
  reason_code TEXT NOT NULL,
  expires_at TEXT,
  access_terms_id TEXT NOT NULL,
  access_kind TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  reviewed_expires_at TEXT,
  effective_expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX verified_recipient_delivery_heads_recipient
  ON verified_recipient_delivery_authority_heads(recipient_binding_id,state,authority_id);
CREATE UNIQUE INDEX verified_recipient_delivery_one_active_folder
  ON verified_recipient_delivery_authority_heads(recipient_binding_id,folder_binding_id)
  WHERE state='active';

CREATE TABLE verified_recipient_delivery_authority_tombstones (
  authority_id TEXT PRIMARY KEY REFERENCES verified_recipient_delivery_authority_heads(authority_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES verified_recipient_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=2),
  recipient_binding_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE verified_recipient_delivery_authority_commits (
  operation_id TEXT PRIMARY KEY REFERENCES verified_recipient_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  authority_id TEXT NOT NULL,
  resulting_revision INTEGER NOT NULL,
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  committed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE verified_recipient_delivery_authority_outbox (
  operation_id TEXT PRIMARY KEY REFERENCES verified_recipient_delivery_authority_commits(operation_id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retry','dispatching','acknowledged','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error_code TEXT,
  claim_token TEXT,
  claim_until TEXT,
  acknowledged_claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX verified_recipient_delivery_authority_outbox_due
  ON verified_recipient_delivery_authority_outbox(state,next_attempt_at,created_at,operation_id);

CREATE TABLE verified_recipient_delivery_authority_audit (
  operation_id TEXT PRIMARY KEY REFERENCES verified_recipient_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('resource.intent.enqueued','resource.revoke.enqueued')),
  operation_fingerprint TEXT NOT NULL,
  authorized_by_staff_id TEXT NOT NULL,
  authorized_grant_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE verified_recipient_delivery_authority_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES verified_recipient_delivery_authority_outbox(operation_id) ON DELETE RESTRICT,
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=65536),
  acknowledged_claim_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Current native owner proof. Directory portal authority does not imply native
-- delivery authority: the distinct browse/project/create-or-revoke grants are
-- evaluated with global-deny and matching-division deny precedence.
CREATE TRIGGER verified_recipient_delivery_command_owner_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN NEW.authorized_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id
   JOIN native_directory_grant_generations g ON g.staff_id=a.staff_id
   WHERE a.staff_id=NEW.authorized_by_staff_id AND a.active=1
     AND a.bound_access_subject=NEW.authorized_access_subject AND a.version=NEW.authorized_admission_version
     AND p.version=NEW.authorized_profile_version AND g.generation=NEW.authorized_grant_generation)
 OR NOT EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=NEW.authorized_by_staff_id
   AND r.role_id='role-owner' AND r.scope='global')
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority owner identity denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_portal_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=NEW.authorized_by_staff_id
   AND grant_row.permission='directory.portal_access.manage' AND grant_row.effect='allow' AND grant_row.active=1
   AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='resource' AND grant_row.resource_id=(
     SELECT selection.record_id FROM client_portal_workspace_binding_selections selection
     WHERE selection.selection_id=NEW.selection_id))))
 OR EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=NEW.authorized_by_staff_id
   AND deny.permission='directory.portal_access.manage' AND deny.effect='deny' AND deny.active=1
   AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=(
       SELECT selection.record_id FROM client_portal_workspace_binding_selections selection
       WHERE selection.selection_id=NEW.selection_id))
     OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
       JOIN client_portal_workspace_binding_selections selection ON selection.record_id=scope.record_id
       WHERE selection.selection_id=NEW.selection_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
     OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
       JOIN client_portal_workspace_binding_selections selection ON selection.record_id=scope.record_id
       WHERE selection.selection_id=NEW.selection_id AND scope.active=1 AND scope.division_id=deny.division_id))))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority portal denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_delivery_allow_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN (SELECT count(DISTINCT permission.permission_key) FROM verified_recipient_delivery_effective_permissions permission
   WHERE permission.staff_id=NEW.authorized_by_staff_id AND permission.effect='allow'
     AND (permission.permission_key IN ('projects.view','delivery.browse')
       OR (NEW.action='upsert' AND permission.permission_key='delivery.share.create')
       OR (NEW.action='revoke' AND permission.permission_key='delivery.share.revoke'))
     AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=NEW.ops_division_id)))<>3
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority delivery allow denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_delivery_deny_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN EXISTS(SELECT 1 FROM verified_recipient_delivery_effective_permissions permission
   WHERE permission.staff_id=NEW.authorized_by_staff_id AND permission.effect='deny'
     AND (permission.permission_key IN ('projects.view','delivery.browse')
       OR (NEW.action='upsert' AND permission.permission_key='delivery.share.create')
       OR (NEW.action='revoke' AND permission.permission_key='delivery.share.revoke'))
      AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=NEW.ops_division_id)))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority delivery deny denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_selection_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN NEW.action='upsert' AND NOT EXISTS(
 SELECT 1 FROM client_portal_workspace_binding_selections selection
 JOIN client_portal_workspace_binding_outbox binding ON binding.operation_id=selection.selection_id AND binding.state='acknowledged'
 JOIN client_portal_workspace_binding_outbox_receipts receipt ON receipt.operation_id=binding.operation_id
 WHERE selection.selection_id=NEW.selection_id AND selection.client_authority_id=NEW.client_authority_id
   AND selection.workspace_id=NEW.workspace_id AND selection.source_id=NEW.source_id
   AND receipt.client_authority_id=NEW.client_authority_id AND receipt.workspace_id=NEW.workspace_id
   AND receipt.state='inactive' AND receipt.revision=1
   AND (selection.record_id=NEW.client_record_id OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
     WHERE relation.client_record_id=NEW.client_record_id AND relation.organization_record_id=selection.record_id)))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority selection denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_recipient_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN NEW.action='upsert' AND NOT EXISTS(
 SELECT 1 FROM client_portal_recipient_enrollment_intents intent
 JOIN client_onboarding_recipient_identity_bindings recipient ON recipient.binding_id=intent.binding_id
 WHERE intent.intent_id=NEW.enrollment_intent_id AND intent.selection_id=NEW.selection_id
   AND intent.revision=NEW.enrollment_revision AND intent.state='active'
   AND intent.target_client_record_id=NEW.client_record_id AND intent.binding_id=NEW.recipient_binding_id
   AND intent.access_issuer=NEW.issuer AND intent.access_subject=NEW.subject
   AND intent.grant_operation_id=NEW.home_grant_operation_id
   AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations cancellation
     WHERE cancellation.intent_id=intent.intent_id)
   AND recipient.status='active' AND (recipient.expires_at IS NULL OR recipient.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   AND recipient.target_client_record_id=NEW.client_record_id
   AND recipient.access_issuer=NEW.issuer AND recipient.access_subject=NEW.subject)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority recipient denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_home_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN NEW.action='upsert' AND NOT EXISTS(
 SELECT 1 FROM client_portal_authority_v2_outbox home
 JOIN client_portal_authority_v2_outbox_receipts receipt ON receipt.operation_id=home.operation_id
 WHERE home.operation_id=NEW.home_grant_operation_id AND home.state='acknowledged' AND home.protocol_version=3
   AND home.binding_operation_id=NEW.selection_id AND home.client_authority_id=NEW.client_authority_id
   AND home.workspace_id=NEW.workspace_id AND home.recipient_binding_id=NEW.recipient_binding_id
   AND home.issuer=NEW.issuer AND home.subject=NEW.subject AND home.desired_state='active'
   AND home.permissions_json='["operations.service_home.read"]'
   AND receipt.client_authority_id=NEW.client_authority_id AND receipt.workspace_id=NEW.workspace_id
   AND receipt.issuer=NEW.issuer AND receipt.subject=NEW.subject
   AND receipt.ownership_epoch=NEW.home_ownership_epoch AND receipt.grant_revision=NEW.home_grant_revision
   AND receipt.resulting_state='active' AND receipt.protocol_version=3
   AND receipt.permissions_json='["operations.service_home.read"]')
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority home denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_resource_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN NEW.action='upsert' AND (NOT EXISTS(
 SELECT 1 FROM operations_directory_records client
 JOIN pa_projects project ON project.id=NEW.ops_project_id AND project.projection_source_id=NEW.source_id AND project.active=1
 JOIN project_folders folder ON folder.project_id=project.id AND folder.division_id=NEW.ops_division_id
   AND rtrim(folder.r2_prefix,'/')||'/'=NEW.r2_prefix
 WHERE client.record_id=NEW.client_record_id AND client.record_kind='client'
   AND json_valid(project.payload_json) AND json_extract(project.payload_json,'$.public_id')=NEW.project_public_id
   AND (SELECT count(*) FROM pa_projects candidate WHERE candidate.projection_source_id=project.projection_source_id
     AND json_valid(candidate.payload_json) AND json_extract(candidate.payload_json,'$.public_id')=NEW.project_public_id)=1)
 OR (NEW.expires_at IS NOT NULL AND NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority resource denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_revision_guard
BEFORE INSERT ON verified_recipient_delivery_authority_commands
WHEN NOT ((NEW.expected_revision=0 AND NEW.action='upsert' AND NOT EXISTS(
      SELECT 1 FROM verified_recipient_delivery_authority_heads head WHERE head.authority_id=NEW.authority_id))
   OR (NEW.expected_revision>=1 AND EXISTS(
      SELECT 1 FROM verified_recipient_delivery_authority_heads head WHERE head.authority_id=NEW.authority_id
       AND head.state='active' AND head.revision=NEW.expected_revision
       AND head.recipient_binding_id=NEW.recipient_binding_id AND head.enrollment_intent_id=NEW.enrollment_intent_id
       AND head.enrollment_revision=NEW.enrollment_revision AND head.issuer=NEW.issuer AND head.subject=NEW.subject
       AND head.selection_id=NEW.selection_id AND head.client_authority_id=NEW.client_authority_id
       AND head.client_record_id=NEW.client_record_id AND head.workspace_id=NEW.workspace_id
       AND head.folder_binding_id=NEW.folder_binding_id AND head.source_id=NEW.source_id
       AND head.project_public_id=NEW.project_public_id AND head.ops_project_id=NEW.ops_project_id
       AND head.ops_division_id=NEW.ops_division_id AND head.r2_prefix=NEW.r2_prefix
       AND (NEW.action='upsert' OR (head.home_ownership_epoch=NEW.home_ownership_epoch
         AND head.home_grant_revision=NEW.home_grant_revision AND head.home_grant_operation_id=NEW.home_grant_operation_id
         AND head.folder_binding_source_version=NEW.folder_binding_source_version
         AND head.project_source_version=NEW.project_source_version AND head.current_generation_id=NEW.current_generation_id
         AND head.resource_proof_sha256=NEW.resource_proof_sha256 AND head.resource_proof_json=NEW.resource_proof_json
         AND head.reason_code=NEW.reason_code AND head.expires_at IS NEW.expires_at
         AND head.access_terms_id=NEW.access_terms_id AND head.access_kind=NEW.access_kind
         AND head.access_mode=NEW.access_mode AND head.reviewed_expires_at IS NEW.reviewed_expires_at
         AND head.effective_expires_at IS NEW.effective_expires_at)))))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority revision denied'); END;

CREATE TRIGGER verified_recipient_delivery_command_no_update BEFORE UPDATE ON verified_recipient_delivery_authority_commands
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority command is immutable'); END;
CREATE TRIGGER verified_recipient_delivery_command_no_delete BEFORE DELETE ON verified_recipient_delivery_authority_commands
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority command is durable'); END;

CREATE TRIGGER verified_recipient_delivery_head_insert_identity_guard BEFORE INSERT ON verified_recipient_delivery_authority_heads
WHEN NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_commands command
 WHERE command.operation_id=NEW.latest_operation_id AND command.authority_id=NEW.authority_id
   AND command.action='upsert' AND command.expected_revision=0 AND command.resulting_revision=NEW.revision
   AND NEW.state='active' AND command.recipient_binding_id=NEW.recipient_binding_id
   AND command.enrollment_intent_id=NEW.enrollment_intent_id AND command.enrollment_revision=NEW.enrollment_revision
   AND command.issuer=NEW.issuer AND command.subject=NEW.subject AND command.selection_id=NEW.selection_id
   AND command.client_authority_id=NEW.client_authority_id AND command.client_record_id=NEW.client_record_id
   AND command.workspace_id=NEW.workspace_id AND command.home_ownership_epoch=NEW.home_ownership_epoch
   AND command.home_grant_revision=NEW.home_grant_revision AND command.home_grant_operation_id=NEW.home_grant_operation_id)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority head requires initial command identity'); END;

CREATE TRIGGER verified_recipient_delivery_head_insert_resource_guard BEFORE INSERT ON verified_recipient_delivery_authority_heads
WHEN NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_commands command
 WHERE command.operation_id=NEW.latest_operation_id AND command.authority_id=NEW.authority_id
   AND command.action='upsert' AND command.expected_revision=0 AND command.resulting_revision=NEW.revision
   AND command.folder_binding_id=NEW.folder_binding_id AND command.folder_binding_source_version=NEW.folder_binding_source_version
   AND command.source_id=NEW.source_id AND command.project_public_id=NEW.project_public_id
   AND command.project_source_version=NEW.project_source_version AND command.current_generation_id=NEW.current_generation_id
   AND command.ops_project_id=NEW.ops_project_id AND command.ops_division_id=NEW.ops_division_id
   AND command.r2_prefix=NEW.r2_prefix AND command.resource_proof_sha256=NEW.resource_proof_sha256
   AND command.resource_proof_json=NEW.resource_proof_json AND command.reason_code=NEW.reason_code
   AND command.expires_at IS NEW.expires_at AND command.access_terms_id=NEW.access_terms_id
   AND command.access_kind=NEW.access_kind AND command.access_mode=NEW.access_mode
   AND command.reviewed_expires_at IS NEW.reviewed_expires_at AND command.effective_expires_at IS NEW.effective_expires_at)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority head requires initial command resource'); END;

CREATE TRIGGER verified_recipient_delivery_head_update_guard BEFORE UPDATE ON verified_recipient_delivery_authority_heads
WHEN OLD.state<>'active' OR NEW.authority_id IS NOT OLD.authority_id OR NEW.revision<>OLD.revision+1
 OR NEW.recipient_binding_id IS NOT OLD.recipient_binding_id OR NEW.enrollment_intent_id IS NOT OLD.enrollment_intent_id
 OR NEW.enrollment_revision IS NOT OLD.enrollment_revision OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject
 OR NEW.selection_id IS NOT OLD.selection_id OR NEW.client_authority_id IS NOT OLD.client_authority_id
 OR NEW.client_record_id IS NOT OLD.client_record_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.folder_binding_id IS NOT OLD.folder_binding_id OR NEW.source_id IS NOT OLD.source_id
 OR NEW.project_public_id IS NOT OLD.project_public_id OR NEW.ops_project_id IS NOT OLD.ops_project_id
 OR NEW.ops_division_id IS NOT OLD.ops_division_id OR NEW.r2_prefix IS NOT OLD.r2_prefix
 OR NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_commands command
   WHERE command.operation_id=NEW.latest_operation_id AND command.authority_id=OLD.authority_id
     AND command.expected_revision=OLD.revision AND command.resulting_revision=NEW.revision
     AND ((command.action='upsert' AND NEW.state='active') OR (command.action='revoke' AND NEW.state='revoked'))
     AND command.recipient_binding_id=NEW.recipient_binding_id AND command.enrollment_intent_id=NEW.enrollment_intent_id
     AND command.enrollment_revision=NEW.enrollment_revision AND command.issuer=NEW.issuer AND command.subject=NEW.subject
     AND command.selection_id=NEW.selection_id AND command.client_authority_id=NEW.client_authority_id
     AND command.client_record_id=NEW.client_record_id AND command.workspace_id=NEW.workspace_id
     AND command.home_ownership_epoch=NEW.home_ownership_epoch AND command.home_grant_revision=NEW.home_grant_revision
     AND command.home_grant_operation_id=NEW.home_grant_operation_id AND command.folder_binding_id=NEW.folder_binding_id
     AND command.folder_binding_source_version=NEW.folder_binding_source_version AND command.source_id=NEW.source_id
     AND command.project_public_id=NEW.project_public_id AND command.project_source_version=NEW.project_source_version
     AND command.current_generation_id=NEW.current_generation_id AND command.ops_project_id=NEW.ops_project_id
     AND command.ops_division_id=NEW.ops_division_id AND command.r2_prefix=NEW.r2_prefix
     AND command.resource_proof_sha256=NEW.resource_proof_sha256 AND command.resource_proof_json=NEW.resource_proof_json
     AND command.reason_code=NEW.reason_code AND command.expires_at IS NEW.expires_at
     AND command.access_terms_id=NEW.access_terms_id AND command.access_kind=NEW.access_kind
     AND command.access_mode=NEW.access_mode AND command.reviewed_expires_at IS NEW.reviewed_expires_at
     AND command.effective_expires_at IS NEW.effective_expires_at
     AND (command.action<>'revoke' OR (NEW.resource_proof_sha256=OLD.resource_proof_sha256
       AND NEW.resource_proof_json=OLD.resource_proof_json AND NEW.reason_code=OLD.reason_code
       AND NEW.expires_at IS OLD.expires_at AND NEW.access_terms_id=OLD.access_terms_id
       AND NEW.access_kind=OLD.access_kind AND NEW.access_mode=OLD.access_mode
       AND NEW.reviewed_expires_at IS OLD.reviewed_expires_at AND NEW.effective_expires_at IS OLD.effective_expires_at)))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority head transition denied'); END;
CREATE TRIGGER verified_recipient_delivery_head_no_delete BEFORE DELETE ON verified_recipient_delivery_authority_heads
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority head is durable'); END;

CREATE TRIGGER verified_recipient_delivery_tombstone_guard BEFORE INSERT ON verified_recipient_delivery_authority_tombstones
WHEN NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_commands command
 JOIN verified_recipient_delivery_authority_heads head ON head.authority_id=command.authority_id
 WHERE command.operation_id=NEW.operation_id AND command.action='revoke' AND command.authority_id=NEW.authority_id
   AND command.resulting_revision=NEW.revision AND command.recipient_binding_id=NEW.recipient_binding_id
   AND command.folder_binding_id=NEW.folder_binding_id AND head.state='revoked' AND head.revision=NEW.revision
   AND head.latest_operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority tombstone requires revoke head'); END;
CREATE TRIGGER verified_recipient_delivery_tombstone_no_update BEFORE UPDATE ON verified_recipient_delivery_authority_tombstones
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority tombstone is immutable'); END;
CREATE TRIGGER verified_recipient_delivery_tombstone_no_delete BEFORE DELETE ON verified_recipient_delivery_authority_tombstones
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority tombstone is durable'); END;

CREATE TRIGGER verified_recipient_delivery_commit_guard BEFORE INSERT ON verified_recipient_delivery_authority_commits
WHEN NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_commands command
 JOIN verified_recipient_delivery_authority_heads head ON head.authority_id=command.authority_id
 WHERE command.operation_id=NEW.operation_id AND command.authority_id=NEW.authority_id
   AND command.resulting_revision=NEW.resulting_revision AND head.revision=NEW.resulting_revision
   AND head.latest_operation_id=NEW.operation_id
   AND NEW.resulting_state=CASE command.action WHEN 'upsert' THEN 'active' ELSE 'revoked' END
   AND head.state=NEW.resulting_state
   AND (command.action<>'revoke' OR EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_tombstones tombstone
     WHERE tombstone.operation_id=command.operation_id AND tombstone.authority_id=command.authority_id)))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority commit requires exact head'); END;
CREATE TRIGGER verified_recipient_delivery_commit_no_update BEFORE UPDATE ON verified_recipient_delivery_authority_commits
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority commit is immutable'); END;
CREATE TRIGGER verified_recipient_delivery_commit_no_delete BEFORE DELETE ON verified_recipient_delivery_authority_commits
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority commit is durable'); END;

CREATE TRIGGER verified_recipient_delivery_outbox_insert_guard BEFORE INSERT ON verified_recipient_delivery_authority_outbox
WHEN NEW.state<>'pending' OR NEW.attempt_count<>0 OR NEW.claim_token IS NOT NULL OR NEW.claim_until IS NOT NULL
 OR NEW.acknowledged_claim_token IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_commits commit_record
   JOIN verified_recipient_delivery_authority_heads head ON head.authority_id=commit_record.authority_id
   WHERE commit_record.operation_id=NEW.operation_id AND head.latest_operation_id=NEW.operation_id
     AND head.revision=commit_record.resulting_revision AND head.state=commit_record.resulting_state)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority outbox requires committed head'); END;
CREATE TRIGGER verified_recipient_delivery_outbox_command_immutable BEFORE UPDATE ON verified_recipient_delivery_authority_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority outbox command is immutable'); END;
CREATE TRIGGER verified_recipient_delivery_outbox_transition_guard BEFORE UPDATE OF state ON verified_recipient_delivery_authority_outbox
WHEN NOT ((OLD.state IN ('pending','retry') AND NEW.state='dispatching' AND OLD.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR (OLD.state='dispatching' AND NEW.state='dispatching' AND OLD.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR (OLD.state='dispatching' AND OLD.claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.state IN ('retry','dead','acknowledged')))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority outbox transition denied'); END;
CREATE TRIGGER verified_recipient_delivery_outbox_control_guard BEFORE UPDATE ON verified_recipient_delivery_authority_outbox
WHEN NEW.state=OLD.state AND (NEW.claim_token IS NOT OLD.claim_token OR NEW.claim_until IS NOT OLD.claim_until
 OR NEW.acknowledged_claim_token IS NOT OLD.acknowledged_claim_token OR NEW.attempt_count IS NOT OLD.attempt_count
 OR NEW.last_error_code IS NOT OLD.last_error_code OR NEW.next_attempt_at IS NOT OLD.next_attempt_at)
 AND NOT (OLD.state='dispatching' AND OLD.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND NEW.state='dispatching' AND NEW.claim_token IS NOT NULL AND NEW.claim_token IS NOT OLD.claim_token
   AND NEW.claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.attempt_count=OLD.attempt_count+1
   AND NEW.acknowledged_claim_token IS OLD.acknowledged_claim_token
   AND NEW.last_error_code IS OLD.last_error_code AND NEW.next_attempt_at IS OLD.next_attempt_at)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority outbox control mutation denied'); END;
CREATE TRIGGER verified_recipient_delivery_outbox_no_delete BEFORE DELETE ON verified_recipient_delivery_authority_outbox
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority outbox is durable'); END;

CREATE TRIGGER verified_recipient_delivery_audit_guard BEFORE INSERT ON verified_recipient_delivery_authority_audit
WHEN NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_commands command WHERE command.operation_id=NEW.operation_id
 AND command.operation_fingerprint=NEW.operation_fingerprint AND command.authorized_by_staff_id=NEW.authorized_by_staff_id
 AND command.authorized_grant_generation=NEW.authorized_grant_generation
 AND NEW.action=CASE command.action WHEN 'upsert' THEN 'resource.intent.enqueued' ELSE 'resource.revoke.enqueued' END)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority audit requires exact command'); END;
CREATE TRIGGER verified_recipient_delivery_audit_no_update BEFORE UPDATE ON verified_recipient_delivery_authority_audit
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority audit is immutable'); END;
CREATE TRIGGER verified_recipient_delivery_audit_no_delete BEFORE DELETE ON verified_recipient_delivery_authority_audit
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority audit is durable'); END;

CREATE TRIGGER verified_recipient_delivery_dispatch_audit_guard BEFORE UPDATE OF state ON verified_recipient_delivery_authority_outbox
WHEN NEW.state='dispatching' AND NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_audit audit
 WHERE audit.operation_id=OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority dispatch requires immutable audit'); END;

CREATE TRIGGER verified_recipient_delivery_receipt_command_guard BEFORE INSERT ON verified_recipient_delivery_authority_receipts
WHEN NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_outbox outbox
 JOIN verified_recipient_delivery_authority_commands command ON command.operation_id=outbox.operation_id
 WHERE outbox.operation_id=NEW.operation_id AND outbox.state='dispatching'
   AND outbox.claim_token=NEW.acknowledged_claim_token AND outbox.claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND json_extract(NEW.receipt_json,'$.protocol')='verified-recipient-delivery-authority'
   AND json_extract(NEW.receipt_json,'$.protocolVersion')=1
   AND json_extract(NEW.receipt_json,'$.operationId')=command.operation_id
   AND json_extract(NEW.receipt_json,'$.action')=command.action
   AND json_extract(NEW.receipt_json,'$.expectedRevision')=command.expected_revision
   AND json_extract(NEW.receipt_json,'$.resultingRevision')=command.resulting_revision
   AND json_extract(NEW.receipt_json,'$.resultingState')=CASE command.action WHEN 'upsert' THEN 'active' ELSE 'revoked' END
   AND json(json_extract(NEW.receipt_json,'$.command'))=json(command.canonical_command_json))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority receipt requires exact claimed command'); END;

CREATE TRIGGER verified_recipient_delivery_receipt_scope_guard BEFORE INSERT ON verified_recipient_delivery_authority_receipts
WHEN NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_commands command
 WHERE command.operation_id=NEW.operation_id AND ((command.action='upsert'
     AND json_extract(NEW.receipt_json,'$.capabilities')=json_array(
       json_object('capability','workspace.view','scopeType','workspace','scopeId',command.workspace_id),
       json_object('capability','delivery.view','scopeType','folder','scopeId',command.folder_binding_id))
     AND json_extract(NEW.receipt_json,'$.affectedScopes')=json_array())
    OR (command.action='revoke'
     AND json_extract(NEW.receipt_json,'$.capabilities')=json_array()
     AND json_extract(NEW.receipt_json,'$.affectedScopes')=json_array(
       json_object('capability','workspace.view','scopeType','workspace','scopeId',command.workspace_id),
       json_object('capability','delivery.view','scopeType','folder','scopeId',command.folder_binding_id)))))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority receipt requires exact scopes'); END;
CREATE TRIGGER verified_recipient_delivery_receipt_no_update BEFORE UPDATE ON verified_recipient_delivery_authority_receipts
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority receipt is immutable'); END;
CREATE TRIGGER verified_recipient_delivery_receipt_no_delete BEFORE DELETE ON verified_recipient_delivery_authority_receipts
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority receipt is durable'); END;

CREATE TRIGGER verified_recipient_delivery_ack_guard BEFORE UPDATE OF state ON verified_recipient_delivery_authority_outbox
WHEN NEW.state='acknowledged' AND NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_receipts receipt
 WHERE receipt.operation_id=OLD.operation_id AND receipt.acknowledged_claim_token=OLD.claim_token
   AND NEW.acknowledged_claim_token=OLD.claim_token)
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority acknowledgement requires exact Client receipt'); END;

-- Full enrollment revocation must drain the resource heads first.  This is a
-- coupling fence only; 0151 does not modify the existing enrollment runtime.
CREATE TRIGGER verified_recipient_delivery_binding_revoke_guard
BEFORE UPDATE OF status ON client_onboarding_recipient_identity_bindings
WHEN OLD.status='active' AND NEW.status='revoked' AND EXISTS(
 SELECT 1 FROM verified_recipient_delivery_authority_heads head
 WHERE head.recipient_binding_id=OLD.binding_id
   AND (head.state='active' OR NOT EXISTS(
     SELECT 1 FROM verified_recipient_delivery_authority_outbox outbox
     JOIN verified_recipient_delivery_authority_receipts receipt ON receipt.operation_id=outbox.operation_id
     WHERE outbox.operation_id=head.latest_operation_id AND outbox.state='acknowledged'
       AND EXISTS(SELECT 1 FROM verified_recipient_delivery_authority_tombstones tombstone
         WHERE tombstone.authority_id=head.authority_id AND tombstone.operation_id=outbox.operation_id))))
BEGIN SELECT RAISE(ABORT,'verified recipient delivery authority must be revoked first'); END;
