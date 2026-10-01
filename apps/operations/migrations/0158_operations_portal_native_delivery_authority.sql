PRAGMA foreign_keys = ON;

-- Staging-only, default-off authority for one exact native recipient and one
-- exact 0152 folder reservation. It creates no PA identity, membership,
-- entitlement, viewer authority, public link, route, or storage object.
CREATE TABLE operations_portal_native_delivery_authority_commands (
  operation_id TEXT PRIMARY KEY,
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256)=64 AND command_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation_fingerprint TEXT NOT NULL CHECK(length(operation_fingerprint)=64 AND operation_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json)
    AND json_type(canonical_command_json)='object' AND length(CAST(canonical_command_json AS BLOB))<=65536),
  action TEXT NOT NULL CHECK(action IN ('delivery.grant','delivery.revoke')),
  authority_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  target_id TEXT NOT NULL REFERENCES operations_portal_workspace_reservation_heads(target_id) ON DELETE RESTRICT,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  recipient_binding_id TEXT NOT NULL REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  enrollment_intent_id TEXT NOT NULL REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  home_ownership_epoch INTEGER NOT NULL CHECK(home_ownership_epoch>=1),
  home_grant_revision INTEGER NOT NULL CHECK(home_grant_revision>=1),
  home_grant_operation_id TEXT NOT NULL REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  home_request_fingerprint TEXT NOT NULL CHECK(length(home_request_fingerprint)=64 AND home_request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  publication_operation_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_receipts(operation_id) ON DELETE RESTRICT,
  publication_id TEXT NOT NULL,
  publication_revision INTEGER NOT NULL CHECK(publication_revision>=1),
  publication_source_sequence INTEGER NOT NULL CHECK(publication_source_sequence>=1),
  publication_snapshot_id TEXT NOT NULL,
  publication_snapshot_sha256 TEXT NOT NULL CHECK(length(publication_snapshot_sha256)=64
    AND publication_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  folder_reservation_id TEXT NOT NULL REFERENCES operations_portal_folder_reservation_heads(reservation_id) ON DELETE RESTRICT,
  folder_reservation_revision INTEGER NOT NULL CHECK(folder_reservation_revision>=1),
  client_folder_binding_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  project_version INTEGER NOT NULL CHECK(project_version>=1),
  ops_folder_project_id TEXT NOT NULL,
  ops_division_id TEXT NOT NULL REFERENCES divisions(id) ON DELETE RESTRICT,
  selected_r2_prefix TEXT NOT NULL,
  base_r2_prefix TEXT NOT NULL,
  base_match_method TEXT NOT NULL,
  base_confirmed_by TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  base_confirmed_at TEXT NOT NULL,
  features_json TEXT NOT NULL CHECK(json_valid(features_json) AND json_type(features_json)='array'),
  expires_at TEXT CHECK(expires_at IS NULL OR (length(expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at)),
  reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) BETWEEN 1 AND 200 AND instr(reason_code,char(0))=0),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(authority_id,resulting_revision),
  CHECK((action='delivery.grant' AND expires_at IS NOT NULL AND expires_at>observed_at
      AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',observed_at,'+30 days') AND features_json<>'[]')
    OR (action='delivery.revoke' AND expected_revision>=1 AND expires_at IS NULL AND features_json='[]')),
  CHECK(json_extract(canonical_command_json,'$.protocol')='operations-portal-native-delivery-authority'
    AND json_extract(canonical_command_json,'$.protocolVersion')=1
    AND json_extract(canonical_command_json,'$.permissionSchemaVersion')=3
    AND json_extract(canonical_command_json,'$.action')=action
    AND json_extract(canonical_command_json,'$.operationId')=operation_id
    AND json_extract(canonical_command_json,'$.authority.authorityId')=authority_id
    AND CAST(json_extract(canonical_command_json,'$.authority.expectedRevision') AS INTEGER)=expected_revision
    AND CAST(json_extract(canonical_command_json,'$.authority.resultingRevision') AS INTEGER)=resulting_revision)
);

-- Current invoker proof is deliberately not part of the immutable wire or its
-- fingerprint. Replays compare the original actor identity here, then perform
-- a fresh current-manager authorization using the caller's current proof.
CREATE TABLE operations_portal_native_delivery_authorizations (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  authorized_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL,
  authorized_email TEXT NOT NULL,
  authorized_admission_version INTEGER NOT NULL CHECK(authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(authorized_grant_generation>=1),
  authorized_verified_until TEXT NOT NULL CHECK(length(authorized_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',authorized_verified_until) IS authorized_verified_until),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_delivery_authority_heads (
  authority_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL, target_revision INTEGER NOT NULL, client_authority_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL, root_record_id TEXT NOT NULL,
  recipient_binding_id TEXT NOT NULL, enrollment_intent_id TEXT NOT NULL, target_client_record_id TEXT NOT NULL,
  issuer TEXT NOT NULL, subject TEXT NOT NULL,
  home_ownership_epoch INTEGER NOT NULL, home_grant_revision INTEGER NOT NULL, home_grant_operation_id TEXT NOT NULL,
  home_request_fingerprint TEXT NOT NULL,
  publication_operation_id TEXT NOT NULL, publication_id TEXT NOT NULL, publication_revision INTEGER NOT NULL,
  publication_source_sequence INTEGER NOT NULL, publication_snapshot_id TEXT NOT NULL, publication_snapshot_sha256 TEXT NOT NULL,
  folder_reservation_id TEXT NOT NULL, folder_reservation_revision INTEGER NOT NULL, client_folder_binding_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL, project_version INTEGER NOT NULL, ops_folder_project_id TEXT NOT NULL,
  ops_division_id TEXT NOT NULL, selected_r2_prefix TEXT NOT NULL, base_r2_prefix TEXT NOT NULL,
  base_match_method TEXT NOT NULL, base_confirmed_by TEXT NOT NULL, base_confirmed_at TEXT NOT NULL,
  features_json TEXT NOT NULL CHECK(json_valid(features_json)), expires_at TEXT, reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX operations_portal_native_delivery_one_recipient_folder
  ON operations_portal_native_delivery_authority_heads(recipient_binding_id,folder_reservation_id) WHERE state='active';
CREATE INDEX operations_portal_native_delivery_heads_target
  ON operations_portal_native_delivery_authority_heads(target_id,state,authority_id);

CREATE TABLE operations_portal_native_delivery_authority_tombstones (
  authority_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_authority_heads(authority_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=2), recipient_binding_id TEXT NOT NULL, folder_reservation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE operations_portal_native_delivery_authority_commits (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  authority_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  committed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE operations_portal_native_delivery_authority_outbox (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_authority_commits(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL, canonical_wire_json TEXT NOT NULL CHECK(json_valid(canonical_wire_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retry','dispatching','acknowledged','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error_code TEXT, claim_token TEXT, claim_until TEXT, acknowledged_claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX operations_portal_native_delivery_outbox_due
  ON operations_portal_native_delivery_authority_outbox(state,next_attempt_at,created_at,operation_id);
CREATE TABLE operations_portal_native_delivery_authority_audit (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('native.folder.grant.enqueued','native.folder.revoke.enqueued')),
  operation_fingerprint TEXT NOT NULL, authorized_by_staff_id TEXT NOT NULL, authorized_grant_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE operations_portal_native_delivery_authority_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_authority_outbox(operation_id) ON DELETE RESTRICT,
  receipt_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), acknowledged_claim_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_native_delivery_authorization_guard BEFORE INSERT
ON operations_portal_native_delivery_authorizations
WHEN NEW.authorized_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_commands command
   JOIN native_staff_admissions admission ON admission.staff_id=NEW.authorized_by_staff_id AND admission.active=1
     AND admission.bound_access_subject=NEW.authorized_access_subject AND admission.version=NEW.authorized_admission_version
   JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=NEW.authorized_email
     AND profile.version=NEW.authorized_profile_version
   JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
     AND generation.generation=NEW.authorized_grant_generation
   WHERE command.operation_id=NEW.operation_id
     AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
       AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global') OR
         (role.role_id='role-division-manager' AND role.scope='division' AND role.division_id=command.ops_division_id)))
     AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
       WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=command.root_record_id)
     AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
       WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=command.root_record_id)
     AND (SELECT count(DISTINCT permission.permission_key) FROM operations_portal_workspace_effective_permissions permission
       WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
         AND permission.permission_key IN ('projects.view','delivery.browse',
           CASE command.action WHEN 'delivery.grant' THEN 'delivery.share.create' ELSE 'delivery.share.revoke' END)
         AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))=3
     AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
       WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
         AND permission.permission_key IN ('projects.view','delivery.browse',
           CASE command.action WHEN 'delivery.grant' THEN 'delivery.share.create' ELSE 'delivery.share.revoke' END)
         AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id))))
BEGIN SELECT RAISE(ABORT,'operations portal native delivery current manager denied'); END;

-- Keep each current-resource proof below SQLite's expression-depth ceiling.
-- A grant insert must satisfy the current home, current publication snapshot,
-- and current physical folder/project proof in the same transaction.

CREATE TRIGGER operations_portal_native_delivery_grant_home_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_commands WHEN NEW.action='delivery.grant' AND NOT EXISTS(
 SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace
 JOIN operations_portal_native_recipient_authority_heads recipient
   ON recipient.target_id=workspace.target_id AND recipient.recipient_binding_id=NEW.recipient_binding_id
 JOIN operations_portal_native_authority_outbox home_outbox
   ON home_outbox.operation_id=recipient.latest_operation_id AND home_outbox.state='acknowledged'
 JOIN operations_portal_native_authority_receipts home_receipt
   ON home_receipt.operation_id=home_outbox.operation_id AND home_receipt.resulting_state='active'
   AND home_receipt.target_id=workspace.target_id AND home_receipt.client_authority_id=workspace.client_authority_id
   AND home_receipt.workspace_id=workspace.workspace_id AND home_receipt.recipient_binding_id=recipient.recipient_binding_id
   AND home_receipt.enrollment_intent_id=recipient.enrollment_intent_id AND home_receipt.issuer=recipient.issuer
   AND home_receipt.subject=recipient.subject AND home_receipt.ownership_epoch=recipient.ownership_epoch
   AND home_receipt.grant_revision=recipient.grant_revision
   AND home_receipt.permissions_json='["operations.service_home.read"]'
 WHERE workspace.target_id=NEW.target_id AND workspace.target_revision=NEW.target_revision AND workspace.state='active'
   AND workspace.ownership_epoch=NEW.home_ownership_epoch
   AND workspace.client_authority_id=NEW.client_authority_id AND workspace.workspace_id=NEW.workspace_id
   AND workspace.root_kind=NEW.root_kind AND workspace.root_record_id=NEW.root_record_id
   AND recipient.state='active' AND recipient.enrollment_intent_id=NEW.enrollment_intent_id
   AND recipient.target_client_record_id=NEW.target_client_record_id AND recipient.issuer=NEW.issuer
   AND recipient.subject=NEW.subject AND recipient.ownership_epoch=NEW.home_ownership_epoch
   AND recipient.grant_revision=NEW.home_grant_revision AND recipient.latest_operation_id=NEW.home_grant_operation_id
   AND home_outbox.request_fingerprint=NEW.home_request_fingerprint
   AND (recipient.expires_at IS NULL OR recipient.expires_at>=NEW.expires_at))
BEGIN SELECT RAISE(ABORT,'operations portal native delivery current home denied'); END;

CREATE TRIGGER operations_portal_native_delivery_grant_publication_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_commands WHEN NEW.action='delivery.grant' AND NOT EXISTS(
 SELECT 1 FROM operations_portal_workspace_publication_heads publication
 JOIN operations_portal_workspace_publication_receipts publication_receipt
   ON publication_receipt.operation_id=publication.latest_operation_id
 JOIN operations_portal_workspace_publication_commands publication_command
   ON publication_command.operation_id=publication_receipt.operation_id
 JOIN operations_portal_workspace_publication_current_checkpoints current_checkpoint
   ON current_checkpoint.checkpoint_id=publication.checkpoint_id
 JOIN operations_portal_workspace_publication_folder_sources published_folder
   ON published_folder.checkpoint_id=publication.checkpoint_id
   AND published_folder.reservation_id=NEW.folder_reservation_id
 JOIN operations_portal_workspace_publication_project_sources published_project
   ON published_project.checkpoint_id=publication.checkpoint_id
   AND published_project.external_project_id=published_folder.external_project_id
 JOIN operations_shared_projects published_live_project
   ON published_live_project.external_project_id=published_project.external_project_id
 WHERE publication.target_id=NEW.target_id AND publication.latest_operation_id=NEW.publication_operation_id
   AND publication.target_revision=NEW.target_revision
   AND publication.client_authority_id=NEW.client_authority_id AND publication.workspace_id=NEW.workspace_id
   AND publication.root_kind=NEW.root_kind AND publication.root_record_id=NEW.root_record_id
   AND publication.publication_revision=NEW.publication_revision
   AND publication.source_sequence=NEW.publication_source_sequence
   AND publication.snapshot_id=NEW.publication_snapshot_id
   AND publication.snapshot_sha256=NEW.publication_snapshot_sha256
   AND publication_receipt.target_id=publication.target_id
   AND publication_receipt.resulting_revision=publication.publication_revision
   AND publication_receipt.source_sequence=publication.source_sequence
   AND publication_receipt.snapshot_id=publication.snapshot_id
   AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
   AND publication_receipt.publication_id=NEW.publication_id AND publication_command.publication_id=NEW.publication_id
   AND publication_command.target_id=publication.target_id
   AND publication_command.target_revision=publication.target_revision
   AND publication_command.client_authority_id=publication.client_authority_id
   AND publication_command.workspace_id=publication.workspace_id
   AND publication_command.root_kind=publication.root_kind
   AND publication_command.root_record_id=publication.root_record_id
   AND publication_command.checkpoint_id=publication.checkpoint_id
   AND publication_command.source_sequence=publication.source_sequence
   AND publication_command.snapshot_id=publication.snapshot_id
   AND publication_command.snapshot_sha256=publication.snapshot_sha256
   AND published_folder.binding_version=NEW.folder_reservation_revision
   AND published_folder.external_project_id=NEW.external_project_id
   AND published_folder.ops_folder_project_id=NEW.ops_folder_project_id
   AND published_folder.division_id=NEW.ops_division_id
   AND published_folder.client_folder_binding_id=NEW.client_folder_binding_id
   AND published_folder.r2_prefix=NEW.selected_r2_prefix
   AND published_folder.base_r2_prefix=NEW.base_r2_prefix
   AND published_folder.base_match_method=NEW.base_match_method
   AND published_folder.base_confirmed_by=NEW.base_confirmed_by
   AND published_folder.base_confirmed_at=NEW.base_confirmed_at
   AND published_project.project_version=NEW.project_version
   AND published_project.organization_record_id IS published_live_project.organization_record_id
   AND published_project.client_record_id IS published_live_project.client_record_id
   AND ((published_live_project.client_record_id IS NOT NULL
       AND published_live_project.client_record_id=NEW.target_client_record_id)
     OR (published_live_project.client_record_id IS NULL AND NEW.root_kind='organization'
       AND published_live_project.organization_record_id=NEW.root_record_id)))
BEGIN SELECT RAISE(ABORT,'operations portal native delivery current publication denied'); END;

CREATE TRIGGER operations_portal_native_delivery_grant_folder_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_commands WHEN NEW.action='delivery.grant' AND NOT EXISTS(
 SELECT 1 FROM operations_portal_folder_reservation_heads folder
 JOIN operations_shared_projects project ON project.external_project_id=folder.external_project_id
 JOIN operations_shared_project_revisions project_revision
   ON project_revision.external_project_id=project.external_project_id AND project_revision.version=project.current_version
 JOIN project_folders physical ON physical.project_id=folder.ops_folder_project_id
 WHERE folder.reservation_id=NEW.folder_reservation_id AND folder.target_id=NEW.target_id
   AND folder.state='active' AND folder.revision=NEW.folder_reservation_revision
   AND ((project.client_record_id IS NOT NULL AND project.client_record_id=NEW.target_client_record_id)
     OR (project.client_record_id IS NULL AND NEW.root_kind='organization'
       AND project.organization_record_id=NEW.root_record_id))
   AND folder.client_folder_binding_id=NEW.client_folder_binding_id
   AND folder.external_project_id=NEW.external_project_id AND folder.project_version=NEW.project_version
   AND folder.ops_folder_project_id=NEW.ops_folder_project_id AND folder.ops_division_id=NEW.ops_division_id
   AND folder.selected_r2_prefix=NEW.selected_r2_prefix AND folder.base_r2_prefix=NEW.base_r2_prefix
   AND folder.base_match_method=NEW.base_match_method AND folder.base_confirmed_by=NEW.base_confirmed_by
   AND folder.base_confirmed_at=NEW.base_confirmed_at AND project.current_version=NEW.project_version
   AND physical.division_id=NEW.ops_division_id AND physical.r2_prefix=NEW.base_r2_prefix
   AND physical.match_method=NEW.base_match_method AND physical.confirmed_by=NEW.base_confirmed_by
   AND physical.confirmed_at=NEW.base_confirmed_at
   AND NEW.selected_r2_prefix LIKE replace(replace(replace(NEW.base_r2_prefix,'\','\\'),'%','\%'),'_','\_') || '%' ESCAPE '\')
BEGIN SELECT RAISE(ABORT,'operations portal native delivery current folder denied'); END;

CREATE TRIGGER operations_portal_native_delivery_command_cas_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_commands
WHEN NOT ((NEW.expected_revision=0 AND NEW.action='delivery.grant'
    AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_heads head WHERE head.authority_id=NEW.authority_id)
    AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_heads head
      WHERE head.recipient_binding_id=NEW.recipient_binding_id AND head.folder_reservation_id=NEW.folder_reservation_id
        AND head.state='active'))
  OR EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_heads head
    WHERE head.authority_id=NEW.authority_id AND head.revision=NEW.expected_revision AND head.state='active'
      AND head.recipient_binding_id=NEW.recipient_binding_id AND head.folder_reservation_id=NEW.folder_reservation_id
      AND head.target_id=NEW.target_id AND head.target_revision=NEW.target_revision
      AND head.client_authority_id=NEW.client_authority_id AND head.workspace_id=NEW.workspace_id
      AND head.root_kind=NEW.root_kind AND head.root_record_id=NEW.root_record_id
      AND head.enrollment_intent_id=NEW.enrollment_intent_id
      AND head.target_client_record_id=NEW.target_client_record_id
      AND head.issuer=NEW.issuer AND head.subject=NEW.subject
      AND head.folder_reservation_revision=NEW.folder_reservation_revision
      AND head.client_folder_binding_id=NEW.client_folder_binding_id
      AND head.external_project_id=NEW.external_project_id AND head.project_version=NEW.project_version
      AND head.ops_folder_project_id=NEW.ops_folder_project_id AND head.ops_division_id=NEW.ops_division_id
      AND head.selected_r2_prefix=NEW.selected_r2_prefix AND head.base_r2_prefix=NEW.base_r2_prefix
      AND head.base_match_method=NEW.base_match_method AND head.base_confirmed_by=NEW.base_confirmed_by
      AND head.base_confirmed_at=NEW.base_confirmed_at
      AND (NEW.action='delivery.grant' OR (NEW.action='delivery.revoke'
        AND head.home_ownership_epoch=NEW.home_ownership_epoch
        AND head.home_grant_revision=NEW.home_grant_revision
        AND head.home_grant_operation_id=NEW.home_grant_operation_id
        AND head.home_request_fingerprint=NEW.home_request_fingerprint
        AND head.publication_operation_id=NEW.publication_operation_id
        AND head.publication_id=NEW.publication_id
        AND head.publication_revision=NEW.publication_revision
        AND head.publication_source_sequence=NEW.publication_source_sequence
        AND head.publication_snapshot_id=NEW.publication_snapshot_id
        AND head.publication_snapshot_sha256=NEW.publication_snapshot_sha256))))
BEGIN SELECT RAISE(ABORT,'operations portal native delivery revision denied'); END;

CREATE TRIGGER operations_portal_native_delivery_head_insert_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_heads
WHEN NEW.revision<>1 OR NEW.state<>'active' OR NOT EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_commands command
 JOIN operations_portal_native_delivery_authorizations authorization ON authorization.operation_id=command.operation_id
 WHERE command.operation_id=NEW.latest_operation_id AND command.authority_id=NEW.authority_id
   AND command.action='delivery.grant' AND command.expected_revision=0 AND command.resulting_revision=NEW.revision
   AND command.target_id=NEW.target_id AND command.target_revision=NEW.target_revision
   AND command.client_authority_id=NEW.client_authority_id AND command.workspace_id=NEW.workspace_id
   AND command.root_kind=NEW.root_kind AND command.root_record_id=NEW.root_record_id
   AND command.recipient_binding_id=NEW.recipient_binding_id AND command.enrollment_intent_id=NEW.enrollment_intent_id
   AND command.target_client_record_id=NEW.target_client_record_id AND command.issuer=NEW.issuer AND command.subject=NEW.subject
   AND command.home_ownership_epoch=NEW.home_ownership_epoch AND command.home_grant_revision=NEW.home_grant_revision
   AND command.home_grant_operation_id=NEW.home_grant_operation_id AND command.home_request_fingerprint=NEW.home_request_fingerprint
   AND command.publication_operation_id=NEW.publication_operation_id AND command.publication_id=NEW.publication_id
   AND command.publication_revision=NEW.publication_revision AND command.publication_source_sequence=NEW.publication_source_sequence
   AND command.publication_snapshot_id=NEW.publication_snapshot_id
   AND command.publication_snapshot_sha256=NEW.publication_snapshot_sha256
   AND command.folder_reservation_id=NEW.folder_reservation_id
   AND command.folder_reservation_revision=NEW.folder_reservation_revision
   AND command.client_folder_binding_id=NEW.client_folder_binding_id AND command.external_project_id=NEW.external_project_id
   AND command.project_version=NEW.project_version AND command.ops_folder_project_id=NEW.ops_folder_project_id
   AND command.ops_division_id=NEW.ops_division_id AND command.selected_r2_prefix=NEW.selected_r2_prefix
   AND command.base_r2_prefix=NEW.base_r2_prefix AND command.base_match_method=NEW.base_match_method
   AND command.base_confirmed_by=NEW.base_confirmed_by AND command.base_confirmed_at=NEW.base_confirmed_at
   AND command.features_json=NEW.features_json AND command.expires_at IS NEW.expires_at
   AND command.reason_code=NEW.reason_code)
BEGIN SELECT RAISE(ABORT,'operations portal native delivery initial head denied'); END;

CREATE TRIGGER operations_portal_native_delivery_head_update_guard BEFORE UPDATE
ON operations_portal_native_delivery_authority_heads
WHEN OLD.state<>'active' OR NEW.authority_id IS NOT OLD.authority_id OR NEW.revision<>OLD.revision+1
 OR NEW.recipient_binding_id IS NOT OLD.recipient_binding_id OR NEW.folder_reservation_id IS NOT OLD.folder_reservation_id
 OR NEW.target_id IS NOT OLD.target_id OR NEW.target_revision IS NOT OLD.target_revision
 OR NEW.client_authority_id IS NOT OLD.client_authority_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.root_kind IS NOT OLD.root_kind OR NEW.root_record_id IS NOT OLD.root_record_id
 OR NEW.enrollment_intent_id IS NOT OLD.enrollment_intent_id
 OR NEW.target_client_record_id IS NOT OLD.target_client_record_id
 OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject
 OR NEW.folder_reservation_revision IS NOT OLD.folder_reservation_revision
 OR NEW.client_folder_binding_id IS NOT OLD.client_folder_binding_id
 OR NEW.external_project_id IS NOT OLD.external_project_id OR NEW.project_version IS NOT OLD.project_version
 OR NEW.ops_folder_project_id IS NOT OLD.ops_folder_project_id OR NEW.ops_division_id IS NOT OLD.ops_division_id
 OR NEW.selected_r2_prefix IS NOT OLD.selected_r2_prefix OR NEW.base_r2_prefix IS NOT OLD.base_r2_prefix
 OR NEW.base_match_method IS NOT OLD.base_match_method OR NEW.base_confirmed_by IS NOT OLD.base_confirmed_by
 OR NEW.base_confirmed_at IS NOT OLD.base_confirmed_at
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_commands command
   JOIN operations_portal_native_delivery_authorizations authorization ON authorization.operation_id=command.operation_id
   WHERE command.operation_id=NEW.latest_operation_id AND command.authority_id=OLD.authority_id
     AND command.expected_revision=OLD.revision AND command.resulting_revision=NEW.revision
     AND ((command.action='delivery.grant' AND NEW.state='active') OR
       (command.action='delivery.revoke' AND NEW.state='revoked'))
     AND command.target_id=NEW.target_id AND command.target_revision=NEW.target_revision
     AND command.client_authority_id=NEW.client_authority_id AND command.workspace_id=NEW.workspace_id
     AND command.root_kind=NEW.root_kind AND command.root_record_id=NEW.root_record_id
     AND command.recipient_binding_id=NEW.recipient_binding_id AND command.enrollment_intent_id=NEW.enrollment_intent_id
     AND command.target_client_record_id=NEW.target_client_record_id AND command.issuer=NEW.issuer AND command.subject=NEW.subject
     AND command.home_ownership_epoch=NEW.home_ownership_epoch AND command.home_grant_revision=NEW.home_grant_revision
     AND command.home_grant_operation_id=NEW.home_grant_operation_id AND command.home_request_fingerprint=NEW.home_request_fingerprint
     AND command.publication_operation_id=NEW.publication_operation_id AND command.publication_id=NEW.publication_id
     AND command.publication_revision=NEW.publication_revision AND command.publication_source_sequence=NEW.publication_source_sequence
     AND command.publication_snapshot_id=NEW.publication_snapshot_id
     AND command.publication_snapshot_sha256=NEW.publication_snapshot_sha256
     AND command.folder_reservation_id=NEW.folder_reservation_id
     AND command.folder_reservation_revision=NEW.folder_reservation_revision
     AND command.client_folder_binding_id=NEW.client_folder_binding_id AND command.external_project_id=NEW.external_project_id
     AND command.project_version=NEW.project_version AND command.ops_folder_project_id=NEW.ops_folder_project_id
     AND command.ops_division_id=NEW.ops_division_id AND command.selected_r2_prefix=NEW.selected_r2_prefix
     AND command.base_r2_prefix=NEW.base_r2_prefix AND command.base_match_method=NEW.base_match_method
     AND command.base_confirmed_by=NEW.base_confirmed_by AND command.base_confirmed_at=NEW.base_confirmed_at
     AND command.features_json=NEW.features_json AND command.expires_at IS NEW.expires_at
     AND command.reason_code=NEW.reason_code)
BEGIN SELECT RAISE(ABORT,'operations portal native delivery head transition denied'); END;

CREATE TRIGGER operations_portal_native_delivery_tombstone_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_tombstones WHEN NOT EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_commands command
 JOIN operations_portal_native_delivery_authority_heads head ON head.authority_id=command.authority_id
 WHERE command.operation_id=NEW.operation_id AND command.action='delivery.revoke'
   AND head.latest_operation_id=command.operation_id AND head.state='revoked' AND head.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'operations portal native delivery tombstone denied'); END;

CREATE TRIGGER operations_portal_native_delivery_commit_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_commits WHEN NOT EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_commands command
 JOIN operations_portal_native_delivery_authority_heads head ON head.authority_id=command.authority_id
 WHERE command.operation_id=NEW.operation_id AND head.latest_operation_id=command.operation_id
   AND head.revision=NEW.resulting_revision AND head.state=NEW.resulting_state
   AND (command.action='delivery.grant' OR EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_tombstones tombstone
     WHERE tombstone.operation_id=command.operation_id)))
BEGIN SELECT RAISE(ABORT,'operations portal native delivery commit denied'); END;

CREATE TRIGGER operations_portal_native_delivery_outbox_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_outbox WHEN NOT EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_commits committed
 JOIN operations_portal_native_delivery_authority_commands command ON command.operation_id=committed.operation_id
 WHERE committed.operation_id=NEW.operation_id AND command.command_sha256=NEW.request_fingerprint
   AND command.canonical_command_json=NEW.canonical_wire_json)
BEGIN SELECT RAISE(ABORT,'operations portal native delivery outbox denied'); END;

CREATE TRIGGER operations_portal_native_delivery_audit_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_audit WHEN NOT EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_commands command
 JOIN operations_portal_native_delivery_authorizations authorization ON authorization.operation_id=command.operation_id
 WHERE command.operation_id=NEW.operation_id AND command.operation_fingerprint=NEW.operation_fingerprint
   AND authorization.authorized_by_staff_id=NEW.authorized_by_staff_id
   AND authorization.authorized_grant_generation=NEW.authorized_grant_generation
   AND NEW.action=CASE command.action WHEN 'delivery.grant' THEN 'native.folder.grant.enqueued'
     ELSE 'native.folder.revoke.enqueued' END)
BEGIN SELECT RAISE(ABORT,'operations portal native delivery audit denied'); END;

CREATE TRIGGER operations_portal_native_delivery_receipt_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_receipts WHEN NOT EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_outbox outbox
 JOIN operations_portal_native_delivery_authority_commands command ON command.operation_id=outbox.operation_id
 WHERE outbox.operation_id=NEW.operation_id AND outbox.state='dispatching'
   AND outbox.claim_token=NEW.acknowledged_claim_token
   AND outbox.claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND json_extract(NEW.receipt_json,'$.protocol')='operations-portal-native-delivery-authority'
   AND json_extract(NEW.receipt_json,'$.protocolVersion')=1
   AND json_extract(NEW.receipt_json,'$.operationId')=command.operation_id
   AND json_extract(NEW.receipt_json,'$.requestFingerprint')=outbox.request_fingerprint
   AND json_extract(NEW.receipt_json,'$.action')=command.action
   AND json_extract(NEW.receipt_json,'$.authorityId')=command.authority_id
   AND json_extract(NEW.receipt_json,'$.recipientBindingId')=command.recipient_binding_id
   AND json_extract(NEW.receipt_json,'$.folderReservationId')=command.folder_reservation_id
   AND CAST(json_extract(NEW.receipt_json,'$.resultingRevision') AS INTEGER)=command.resulting_revision
   AND json_extract(NEW.receipt_json,'$.resultingState')=CASE command.action
     WHEN 'delivery.grant' THEN 'active' ELSE 'revoked' END)
BEGIN SELECT RAISE(ABORT,'operations portal native delivery receipt denied'); END;

CREATE TRIGGER operations_portal_native_delivery_ack_guard BEFORE UPDATE OF state
ON operations_portal_native_delivery_authority_outbox WHEN NEW.state='acknowledged' AND NOT EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_receipts receipt
 WHERE receipt.operation_id=OLD.operation_id AND receipt.acknowledged_claim_token=OLD.claim_token
   AND NEW.acknowledged_claim_token=OLD.claim_token)
BEGIN SELECT RAISE(ABORT,'operations portal native delivery acknowledgement denied'); END;

-- Active native delivery must be denied locally before its home, folder, or
-- workspace can be cleaned up. Historical project/folder drift is otherwise
-- tolerated so an exact revoke can still be recorded and delivered.
CREATE TRIGGER operations_portal_native_delivery_recipient_cleanup_guard BEFORE UPDATE OF state
ON operations_portal_native_recipient_authority_heads WHEN NEW.state='revoked' AND EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_heads delivery
 WHERE delivery.recipient_binding_id=OLD.recipient_binding_id AND delivery.state='active')
BEGIN SELECT RAISE(ABORT,'native delivery authorities must be revoked first'); END;
CREATE TRIGGER operations_portal_native_delivery_folder_cleanup_guard BEFORE UPDATE OF state
ON operations_portal_folder_reservation_heads WHEN NEW.state='revoked' AND EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_heads delivery
 WHERE delivery.folder_reservation_id=OLD.reservation_id AND delivery.state='active')
BEGIN SELECT RAISE(ABORT,'native delivery authorities must be revoked first'); END;

CREATE TRIGGER operations_portal_native_delivery_commands_no_update BEFORE UPDATE ON operations_portal_native_delivery_authority_commands BEGIN SELECT RAISE(ABORT,'native delivery command is immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_commands_no_delete BEFORE DELETE ON operations_portal_native_delivery_authority_commands BEGIN SELECT RAISE(ABORT,'native delivery command is durable'); END;
CREATE TRIGGER operations_portal_native_delivery_authorizations_no_update BEFORE UPDATE ON operations_portal_native_delivery_authorizations BEGIN SELECT RAISE(ABORT,'native delivery authorization is immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_authorizations_no_delete BEFORE DELETE ON operations_portal_native_delivery_authorizations BEGIN SELECT RAISE(ABORT,'native delivery authorization is durable'); END;
CREATE TRIGGER operations_portal_native_delivery_heads_no_delete BEFORE DELETE ON operations_portal_native_delivery_authority_heads BEGIN SELECT RAISE(ABORT,'native delivery head is durable'); END;
CREATE TRIGGER operations_portal_native_delivery_tombstones_no_update BEFORE UPDATE ON operations_portal_native_delivery_authority_tombstones BEGIN SELECT RAISE(ABORT,'native delivery tombstone is immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_tombstones_no_delete BEFORE DELETE ON operations_portal_native_delivery_authority_tombstones BEGIN SELECT RAISE(ABORT,'native delivery tombstone is durable'); END;
CREATE TRIGGER operations_portal_native_delivery_commits_no_update BEFORE UPDATE ON operations_portal_native_delivery_authority_commits BEGIN SELECT RAISE(ABORT,'native delivery commit is immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_commits_no_delete BEFORE DELETE ON operations_portal_native_delivery_authority_commits BEGIN SELECT RAISE(ABORT,'native delivery commit is durable'); END;
CREATE TRIGGER operations_portal_native_delivery_outbox_wire_immutable BEFORE UPDATE ON operations_portal_native_delivery_authority_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
 OR NEW.canonical_wire_json IS NOT OLD.canonical_wire_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'native delivery outbox wire is immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_outbox_no_delete BEFORE DELETE ON operations_portal_native_delivery_authority_outbox BEGIN SELECT RAISE(ABORT,'native delivery outbox is durable'); END;
CREATE TRIGGER operations_portal_native_delivery_audit_no_update BEFORE UPDATE ON operations_portal_native_delivery_authority_audit BEGIN SELECT RAISE(ABORT,'native delivery audit is immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_audit_no_delete BEFORE DELETE ON operations_portal_native_delivery_authority_audit BEGIN SELECT RAISE(ABORT,'native delivery audit is durable'); END;
CREATE TRIGGER operations_portal_native_delivery_receipts_no_update BEFORE UPDATE ON operations_portal_native_delivery_authority_receipts BEGIN SELECT RAISE(ABORT,'native delivery receipt is immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_receipts_no_delete BEFORE DELETE ON operations_portal_native_delivery_authority_receipts BEGIN SELECT RAISE(ABORT,'native delivery receipt is durable'); END;
