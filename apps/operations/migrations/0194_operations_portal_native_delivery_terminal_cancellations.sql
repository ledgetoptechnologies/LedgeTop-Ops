PRAGMA foreign_keys=ON;

CREATE TABLE operations_portal_native_delivery_cancellation_intents (
 operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
 authority_id TEXT NOT NULL UNIQUE,request_fingerprint TEXT NOT NULL UNIQUE,canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json)),
 actor_staff_id TEXT NOT NULL,actor_access_subject TEXT NOT NULL,actor_email TEXT NOT NULL,actor_admission_version INTEGER NOT NULL,
 actor_profile_version INTEGER NOT NULL,actor_grant_generation INTEGER NOT NULL,actor_verified_until TEXT NOT NULL
  CHECK(length(actor_verified_until)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until)=actor_verified_until),
 state TEXT NOT NULL CHECK(state IN ('pending','completed','committed')),created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE operations_portal_native_delivery_cancellation_receipts (
 operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_cancellation_intents(operation_id) ON DELETE RESTRICT,
 authority_id TEXT NOT NULL UNIQUE,request_fingerprint TEXT NOT NULL UNIQUE,cancellation_json TEXT NOT NULL CHECK(json_valid(cancellation_json)),
 cancelled_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));

CREATE TRIGGER operations_portal_native_delivery_cancellation_intent_insert BEFORE INSERT ON operations_portal_native_delivery_cancellation_intents
WHEN NEW.state<>'pending' OR NEW.actor_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_commands command
 JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
 JOIN operations_portal_native_delivery_authority_heads head ON head.latest_operation_id=command.operation_id
 WHERE command.operation_id=NEW.operation_id AND command.authority_id=NEW.authority_id AND command.action='delivery.grant'
  AND command.expected_revision=0 AND command.resulting_revision=1 AND command.command_sha256=NEW.request_fingerprint
  AND command.canonical_command_json=json_extract(NEW.canonical_request_json,'$.command')
  AND json_extract(NEW.canonical_request_json,'$.requestFingerprint')=NEW.request_fingerprint
  AND command.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND head.state='active' AND head.revision=1
  AND outbox.state='dead' AND outbox.last_error_code='conflict' AND outbox.claim_token IS NULL AND outbox.claim_until IS NULL
  AND outbox.acknowledged_claim_token IS NULL
  AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_receipts receipt WHERE receipt.operation_id=command.operation_id)
  AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_recovery_invocations recovery
    WHERE recovery.operation_id=command.operation_id AND recovery.state='claimed'))
BEGIN SELECT RAISE(ABORT,'native delivery cancellation intent denied'); END;
CREATE TRIGGER operations_portal_native_delivery_cancellation_intent_update BEFORE UPDATE ON operations_portal_native_delivery_cancellation_intents
WHEN OLD.state<>'pending' OR NEW.state NOT IN ('completed','committed') OR NEW.operation_id IS NOT OLD.operation_id OR NEW.authority_id IS NOT OLD.authority_id
 OR NEW.request_fingerprint IS NOT OLD.request_fingerprint OR NEW.canonical_request_json IS NOT OLD.canonical_request_json
 OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject
 OR NEW.actor_email IS NOT OLD.actor_email
 OR NEW.actor_admission_version IS NOT OLD.actor_admission_version OR NEW.actor_profile_version IS NOT OLD.actor_profile_version
 OR NEW.actor_grant_generation IS NOT OLD.actor_grant_generation OR NEW.actor_verified_until IS NOT OLD.actor_verified_until
 OR (NEW.state='completed' AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_receipts WHERE operation_id=OLD.operation_id))
 OR (NEW.state='committed' AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_receipts WHERE operation_id=OLD.operation_id))
BEGIN SELECT RAISE(ABORT,'native delivery cancellation intent transition denied'); END;
CREATE TRIGGER operations_portal_native_delivery_cancellation_intent_delete BEFORE DELETE ON operations_portal_native_delivery_cancellation_intents BEGIN SELECT RAISE(ABORT,'native delivery cancellation intent durable'); END;

CREATE VIEW operations_portal_native_delivery_cancellation_current_home AS
SELECT command.operation_id FROM operations_portal_native_delivery_authority_commands command
JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.target_id=workspace.target_id AND recipient.recipient_binding_id=command.recipient_binding_id
JOIN operations_portal_native_authority_outbox home_outbox ON home_outbox.operation_id=recipient.latest_operation_id AND home_outbox.state='acknowledged'
JOIN operations_portal_native_authority_receipts home_receipt ON home_receipt.operation_id=home_outbox.operation_id AND home_receipt.resulting_state='active'
WHERE workspace.state='active' AND workspace.target_revision=command.target_revision
 AND workspace.ownership_epoch=recipient.ownership_epoch
 AND workspace.client_authority_id=command.client_authority_id AND workspace.workspace_id=command.workspace_id
 AND workspace.root_kind=command.root_kind AND workspace.root_record_id=command.root_record_id
 AND recipient.state='active' AND recipient.enrollment_intent_id=command.enrollment_intent_id
 AND recipient.target_client_record_id=command.target_client_record_id AND recipient.issuer=command.issuer AND recipient.subject=command.subject
 AND recipient.ownership_epoch=command.home_ownership_epoch AND recipient.grant_revision=command.home_grant_revision
 AND recipient.latest_operation_id=command.home_grant_operation_id AND home_outbox.request_fingerprint=command.home_request_fingerprint
 AND (recipient.expires_at IS NULL OR recipient.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND home_receipt.target_id=workspace.target_id AND home_receipt.client_authority_id=workspace.client_authority_id
 AND home_receipt.workspace_id=workspace.workspace_id AND home_receipt.recipient_binding_id=recipient.recipient_binding_id
 AND home_receipt.enrollment_intent_id=recipient.enrollment_intent_id AND home_receipt.issuer=recipient.issuer AND home_receipt.subject=recipient.subject
 AND home_receipt.ownership_epoch=recipient.ownership_epoch AND home_receipt.grant_revision=recipient.grant_revision
 AND home_receipt.permissions_json='["operations.service_home.read"]';

CREATE VIEW operations_portal_native_delivery_cancellation_current_publication AS
SELECT command.operation_id FROM operations_portal_native_delivery_authority_commands command
JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=command.target_id
JOIN operations_portal_workspace_publication_receipts publication_receipt ON publication_receipt.operation_id=publication.latest_operation_id
JOIN operations_portal_workspace_publication_commands publication_command ON publication_command.operation_id=publication_receipt.operation_id
JOIN operations_portal_workspace_publication_current_checkpoints checkpoint ON checkpoint.checkpoint_id=publication.checkpoint_id
JOIN operations_portal_workspace_publication_directory_sources published_client ON published_client.checkpoint_id=publication.checkpoint_id
  AND published_client.record_id=command.target_client_record_id AND published_client.record_kind='client'
WHERE publication.target_id=command.target_id
 AND publication.target_revision=command.target_revision AND publication.client_authority_id=command.client_authority_id
 AND publication.workspace_id=command.workspace_id AND publication.root_kind=command.root_kind AND publication.root_record_id=command.root_record_id
 AND publication.latest_operation_id=command.publication_operation_id AND publication.publication_revision=command.publication_revision
 AND publication.source_sequence=command.publication_source_sequence AND publication.snapshot_id=command.publication_snapshot_id
 AND publication.snapshot_sha256=command.publication_snapshot_sha256
 AND publication_receipt.publication_id=command.publication_id AND publication_receipt.target_id=command.target_id
 AND publication_receipt.resulting_revision=command.publication_revision AND publication_receipt.source_sequence=command.publication_source_sequence
 AND publication_receipt.snapshot_id=command.publication_snapshot_id AND publication_receipt.snapshot_sha256=command.publication_snapshot_sha256
 AND publication_command.publication_id=command.publication_id AND publication_command.target_id=command.target_id
 AND publication_command.target_revision=command.target_revision AND publication_command.client_authority_id=command.client_authority_id
 AND publication_command.workspace_id=command.workspace_id AND publication_command.root_kind=command.root_kind
 AND publication_command.root_record_id=command.root_record_id AND publication_command.checkpoint_id=publication.checkpoint_id
 AND publication_command.source_sequence=command.publication_source_sequence AND publication_command.snapshot_id=command.publication_snapshot_id
 AND publication_command.snapshot_sha256=command.publication_snapshot_sha256;

CREATE VIEW operations_portal_native_delivery_cancellation_current_folder AS
SELECT command.operation_id FROM operations_portal_native_delivery_authority_commands command
JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=command.target_id
 AND publication.latest_operation_id=command.publication_operation_id AND publication.snapshot_id=command.publication_snapshot_id
JOIN operations_portal_workspace_publication_folder_sources published_folder ON published_folder.checkpoint_id=publication.checkpoint_id
 AND published_folder.reservation_id=command.folder_reservation_id
JOIN operations_portal_workspace_publication_project_sources published_project ON published_project.checkpoint_id=publication.checkpoint_id
 AND published_project.external_project_id=published_folder.external_project_id
JOIN operations_portal_folder_reservation_heads folder ON folder.reservation_id=published_folder.reservation_id
JOIN operations_shared_projects project ON project.external_project_id=folder.external_project_id
JOIN operations_shared_project_revisions project_revision ON project_revision.external_project_id=project.external_project_id AND project_revision.version=project.current_version
JOIN project_folders physical ON physical.project_id=folder.ops_folder_project_id
WHERE folder.state='active' AND folder.target_id=command.target_id AND folder.revision=command.folder_reservation_revision
 AND folder.pinned_workspace_revision=command.target_revision AND folder.client_folder_binding_id=command.client_folder_binding_id
 AND folder.external_project_id=command.external_project_id AND folder.project_version=command.project_version
 AND folder.ops_folder_project_id=command.ops_folder_project_id AND folder.ops_division_id=command.ops_division_id
 AND folder.selected_r2_prefix=command.selected_r2_prefix AND folder.base_r2_prefix=command.base_r2_prefix
 AND substr(folder.selected_r2_prefix,1,length(folder.base_r2_prefix))=folder.base_r2_prefix COLLATE BINARY
 AND folder.base_match_method=command.base_match_method AND folder.base_confirmed_by=command.base_confirmed_by
 AND folder.base_confirmed_at=command.base_confirmed_at
 AND published_folder.binding_version=folder.revision AND published_folder.external_project_id=folder.external_project_id
 AND published_folder.ops_folder_project_id=folder.ops_folder_project_id AND published_folder.division_id=folder.ops_division_id
 AND published_folder.client_folder_binding_id=folder.client_folder_binding_id AND published_folder.r2_prefix=folder.selected_r2_prefix
 AND published_folder.base_r2_prefix=folder.base_r2_prefix AND published_folder.base_match_method=folder.base_match_method
 AND published_folder.base_confirmed_by=folder.base_confirmed_by AND published_folder.base_confirmed_at=folder.base_confirmed_at
 AND published_project.project_version=command.project_version AND published_project.organization_record_id IS project.organization_record_id
 AND published_project.client_record_id IS project.client_record_id
 AND folder.project_version=project.current_version
 AND ((project.client_record_id IS NOT NULL AND project.client_record_id=command.target_client_record_id)
   OR (project.client_record_id IS NULL AND command.root_kind='organization' AND project.organization_record_id=command.root_record_id))
 AND physical.division_id=command.ops_division_id AND physical.r2_prefix=command.base_r2_prefix
 AND physical.match_method=command.base_match_method AND physical.confirmed_by=command.base_confirmed_by AND physical.confirmed_at=command.base_confirmed_at;

CREATE TRIGGER operations_portal_native_delivery_cancellation_receipt_json_guard BEFORE INSERT ON operations_portal_native_delivery_cancellation_receipts
WHEN json_type(NEW.cancellation_json) IS NOT 'object' OR (SELECT count(*) FROM json_each(NEW.cancellation_json))<>13
 OR json_extract(NEW.cancellation_json,'$.protocol') IS NOT 'operations-portal-native-delivery-authority'
 OR json_extract(NEW.cancellation_json,'$.protocolVersion') IS NOT 1 OR json_extract(NEW.cancellation_json,'$.status') IS NOT 'cancelled'
 OR json_extract(NEW.cancellation_json,'$.operationId') IS NOT NEW.operation_id
 OR json_extract(NEW.cancellation_json,'$.requestFingerprint') IS NOT NEW.request_fingerprint
 OR json_extract(NEW.cancellation_json,'$.authorityId') IS NOT NEW.authority_id
 OR json_extract(NEW.cancellation_json,'$.expectedRevision') IS NOT '0' OR json_extract(NEW.cancellation_json,'$.resultingRevision') IS NOT '1'
 OR json_extract(NEW.cancellation_json,'$.cancelledAt') IS NOT NEW.cancelled_at
 OR json_type(NEW.cancellation_json,'$.operationId') IS NOT 'text' OR json_type(NEW.cancellation_json,'$.requestFingerprint') IS NOT 'text'
 OR json_type(NEW.cancellation_json,'$.authorityId') IS NOT 'text' OR json_type(NEW.cancellation_json,'$.targetId') IS NOT 'text'
 OR json_type(NEW.cancellation_json,'$.recipientBindingId') IS NOT 'text' OR json_type(NEW.cancellation_json,'$.folderReservationId') IS NOT 'text'
 OR json_type(NEW.cancellation_json,'$.cancelledAt') IS NOT 'text' OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.cancelled_at) IS NOT NEW.cancelled_at
 OR NEW.cancelled_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR json_type(NEW.cancellation_json,'$.replayed') NOT IN ('true','false')
 OR NEW.cancellation_json IS NOT json_object(
   'protocol','operations-portal-native-delivery-authority','protocolVersion',1,'status','cancelled',
   'operationId',NEW.operation_id,'requestFingerprint',NEW.request_fingerprint,'authorityId',NEW.authority_id,
   'targetId',json_extract(NEW.cancellation_json,'$.targetId'),
   'recipientBindingId',json_extract(NEW.cancellation_json,'$.recipientBindingId'),
   'folderReservationId',json_extract(NEW.cancellation_json,'$.folderReservationId'),
   'expectedRevision','0','resultingRevision','1','cancelledAt',NEW.cancelled_at,
   'replayed',json(CASE json_type(NEW.cancellation_json,'$.replayed') WHEN 'true' THEN 'true' ELSE 'false' END))
BEGIN SELECT RAISE(ABORT,'native delivery cancellation receipt denied'); END;

CREATE TRIGGER operations_portal_native_delivery_cancellation_receipt_state_guard BEFORE INSERT ON operations_portal_native_delivery_cancellation_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_intents intent
  JOIN operations_portal_native_delivery_authority_commands command ON command.operation_id=intent.operation_id
  JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
  JOIN operations_portal_native_delivery_authority_heads head ON head.latest_operation_id=command.operation_id
  WHERE intent.operation_id=NEW.operation_id AND intent.authority_id=NEW.authority_id AND intent.request_fingerprint=NEW.request_fingerprint
   AND intent.state='pending' AND command.action='delivery.grant' AND command.expected_revision=0 AND command.resulting_revision=1
   AND command.target_id=json_extract(NEW.cancellation_json,'$.targetId')
   AND command.recipient_binding_id=json_extract(NEW.cancellation_json,'$.recipientBindingId')
   AND command.folder_reservation_id=json_extract(NEW.cancellation_json,'$.folderReservationId')
   AND command.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND head.authority_id=NEW.authority_id AND head.state='active' AND head.revision=1
   AND outbox.state='dead' AND outbox.last_error_code='conflict' AND outbox.claim_token IS NULL AND outbox.claim_until IS NULL
   AND outbox.acknowledged_claim_token IS NULL AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_receipts r WHERE r.operation_id=command.operation_id))
BEGIN SELECT RAISE(ABORT,'native delivery cancellation receipt denied'); END;

CREATE TRIGGER operations_portal_native_delivery_cancellation_receipt_actor_guard BEFORE INSERT ON operations_portal_native_delivery_cancellation_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_intents intent
  JOIN operations_portal_native_delivery_authority_commands command ON command.operation_id=intent.operation_id
  JOIN native_staff_admissions admission ON admission.staff_id=intent.actor_staff_id
  JOIN staff_users staff ON staff.id=admission.staff_id AND staff.status='active'
   AND staff.email=intent.actor_email AND staff.access_subject=intent.actor_access_subject
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE intent.operation_id=NEW.operation_id AND intent.authority_id=NEW.authority_id AND intent.request_fingerprint=NEW.request_fingerprint
   AND admission.active=1 AND admission.bound_access_subject=intent.actor_access_subject AND admission.version=intent.actor_admission_version
   AND profile.login_email=intent.actor_email AND profile.version=intent.actor_profile_version
   AND generation.generation=intent.actor_grant_generation AND intent.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
    AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global') OR (role.role_id='role-division-manager' AND role.scope='division' AND role.division_id=command.ops_division_id)))
   AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions p WHERE p.staff_id=admission.staff_id AND p.effect='allow' AND p.record_id=command.root_record_id)
   AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions p WHERE p.staff_id=admission.staff_id AND p.effect='deny' AND p.record_id=command.root_record_id)
   AND (SELECT count(DISTINCT p.permission_key) FROM operations_portal_workspace_effective_permissions p WHERE p.staff_id=admission.staff_id
    AND p.effect='allow' AND p.permission_key IN ('projects.view','delivery.browse','delivery.share.revoke')
    AND (p.scope='global' OR p.scope='division' AND p.division_id=command.ops_division_id))=3
   AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions p WHERE p.staff_id=admission.staff_id AND p.effect='deny'
    AND p.permission_key IN ('projects.view','delivery.browse','delivery.share.revoke')
    AND (p.scope='global' OR p.scope='division' AND p.division_id=command.ops_division_id)))
BEGIN SELECT RAISE(ABORT,'native delivery cancellation receipt denied'); END;

CREATE TRIGGER operations_portal_native_delivery_cancellation_receipt_context_guard BEFORE INSERT ON operations_portal_native_delivery_cancellation_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_current_home current WHERE current.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'native delivery cancellation receipt denied'); END;
CREATE TRIGGER operations_portal_native_delivery_cancellation_receipt_publication_guard BEFORE INSERT ON operations_portal_native_delivery_cancellation_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_current_publication current WHERE current.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'native delivery cancellation receipt denied'); END;
CREATE TRIGGER operations_portal_native_delivery_cancellation_receipt_folder_guard BEFORE INSERT ON operations_portal_native_delivery_cancellation_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_current_folder current WHERE current.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'native delivery cancellation receipt denied'); END;
CREATE TRIGGER operations_portal_native_delivery_cancellation_receipt_update BEFORE UPDATE ON operations_portal_native_delivery_cancellation_receipts BEGIN SELECT RAISE(ABORT,'native delivery cancellation receipt immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_cancellation_receipt_delete BEFORE DELETE ON operations_portal_native_delivery_cancellation_receipts BEGIN SELECT RAISE(ABORT,'native delivery cancellation receipt immutable'); END;

DROP TRIGGER operations_portal_native_delivery_heads_no_delete;
CREATE TRIGGER operations_portal_native_delivery_heads_no_delete BEFORE DELETE ON operations_portal_native_delivery_authority_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_receipts receipt
 JOIN operations_portal_native_delivery_cancellation_intents intent ON intent.operation_id=receipt.operation_id
 WHERE receipt.operation_id=OLD.latest_operation_id AND receipt.authority_id=OLD.authority_id
  AND receipt.request_fingerprint=(SELECT command_sha256 FROM operations_portal_native_delivery_authority_commands WHERE operation_id=OLD.latest_operation_id)
  AND intent.state='pending' AND OLD.state='active' AND OLD.revision=1
  AND EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_outbox outbox WHERE outbox.operation_id=OLD.latest_operation_id
   AND outbox.state='dead' AND outbox.last_error_code='conflict' AND outbox.claim_token IS NULL AND outbox.claim_until IS NULL
   AND outbox.acknowledged_claim_token IS NULL)
  AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_receipts committed WHERE committed.operation_id=OLD.latest_operation_id))
BEGIN SELECT RAISE(ABORT,'native delivery head is durable'); END;

-- Once cancellation begins, no recovery claim can race it.
DROP TRIGGER operations_portal_native_delivery_recovery_command_guard;
CREATE TRIGGER operations_portal_native_delivery_recovery_command_guard BEFORE INSERT ON operations_portal_native_delivery_recovery_invocations
WHEN EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_intents WHERE operation_id=NEW.operation_id)
 OR NEW.state<>'authorized' OR NEW.claim_token IS NOT NULL OR NEW.claimed_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_commands command
   JOIN operations_portal_native_delivery_authorizations original ON original.operation_id=command.operation_id
   JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
   JOIN operations_portal_native_delivery_authority_heads head ON head.authority_id=command.authority_id
   WHERE command.operation_id=NEW.operation_id AND command.command_sha256=NEW.command_sha256
    AND command.operation_fingerprint=NEW.operation_fingerprint AND command.action=NEW.command_action
    AND command.authority_id=NEW.authority_id AND command.expected_revision=NEW.expected_revision
    AND command.resulting_revision=NEW.resulting_revision AND command.target_id=NEW.target_id
    AND command.root_record_id=NEW.root_record_id AND command.ops_division_id=NEW.ops_division_id
    AND outbox.request_fingerprint=command.command_sha256 AND outbox.canonical_wire_json=command.canonical_command_json
    AND (outbox.state IN ('pending','retry') OR (outbox.state='dispatching' AND outbox.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR (command.action='delivery.grant' AND outbox.state='dead' AND outbox.last_error_code='conflict' AND outbox.claim_token IS NULL
       AND outbox.claim_until IS NULL AND outbox.acknowledged_claim_token IS NULL AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_receipts receipt WHERE receipt.operation_id=outbox.operation_id)))
    AND head.latest_operation_id=command.operation_id AND head.revision=command.resulting_revision
    AND head.state=CASE command.action WHEN 'delivery.grant' THEN 'active' ELSE 'revoked' END)
BEGIN SELECT RAISE(ABORT,'native delivery recovery command denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_cancellation_claim_guard BEFORE UPDATE
ON operations_portal_native_delivery_recovery_invocations
WHEN NEW.state='claimed' AND EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellation_intents intent
 WHERE intent.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'native delivery recovery claim denied'); END;
