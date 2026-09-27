PRAGMA foreign_keys = ON;

-- A reviewed selection becomes one frozen, private command. A response may be
-- lost after Client commits, so transport errors never free this workspace for
-- a different command. Only a definitive non-commit rejection may do that.
CREATE TABLE client_portal_workspace_binding_outbox (
  operation_id TEXT PRIMARY KEY REFERENCES client_portal_workspace_binding_selections(selection_id) ON DELETE RESTRICT,
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  root_type TEXT NOT NULL CHECK(root_type IN ('organization','standalone_client')),
  root_public_id TEXT NOT NULL,
  checkpoint_source_generation TEXT NOT NULL,
  checkpoint_source_sequence INTEGER NOT NULL CHECK(checkpoint_source_sequence>=1),
  checkpoint_snapshot_generation_id TEXT NOT NULL,
  reviewed_by_staff_id TEXT NOT NULL,
  reviewed_access_subject TEXT NOT NULL,
  reviewed_admission_version INTEGER NOT NULL,
  reviewed_profile_version INTEGER NOT NULL,
  reviewed_grant_generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retry','dispatching','acknowledged','rejected')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claim_token TEXT,
  claim_until TEXT,
  acknowledged_claim_token TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='dispatching' AND claim_token IS NOT NULL AND claim_until IS NOT NULL)
    OR (state<>'dispatching' AND claim_token IS NULL AND claim_until IS NULL)),
  CHECK((state='acknowledged' AND acknowledged_claim_token IS NOT NULL)
    OR (state<>'acknowledged' AND acknowledged_claim_token IS NULL))
);
CREATE UNIQUE INDEX client_portal_workspace_binding_outbox_workspace_occupied
  ON client_portal_workspace_binding_outbox(workspace_id)
  WHERE state IN ('pending','retry','dispatching','acknowledged');
CREATE INDEX client_portal_workspace_binding_outbox_due
  ON client_portal_workspace_binding_outbox(state,next_attempt_at,created_at);

CREATE TRIGGER client_portal_workspace_binding_outbox_insert_guard
BEFORE INSERT ON client_portal_workspace_binding_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM client_portal_workspace_binding_selections selection
  JOIN project_alpha_existing_directory_binding_activation_receipts activation
    ON activation.activation_id=selection.activation_id
  JOIN operations_directory_records record ON record.record_id=selection.record_id
  JOIN native_staff_admissions admission ON admission.staff_id=selection.reviewed_by_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE selection.selection_id=NEW.operation_id
    AND selection.client_authority_id=NEW.client_authority_id
    AND selection.workspace_id=NEW.workspace_id
    AND selection.source_id=NEW.projection_source_id
    AND selection.source_workspace_id=NEW.source_workspace_id
    AND selection.root_type=NEW.root_type AND selection.root_public_id=NEW.root_public_id
    AND selection.checkpoint_source_generation=NEW.checkpoint_source_generation
    AND selection.checkpoint_source_sequence=NEW.checkpoint_source_sequence
    AND selection.checkpoint_snapshot_generation_id=NEW.checkpoint_snapshot_generation_id
    AND selection.reviewed_by_staff_id=NEW.reviewed_by_staff_id
    AND selection.reviewed_access_subject=NEW.reviewed_access_subject
    AND selection.reviewed_admission_version=NEW.reviewed_admission_version
    AND selection.reviewed_profile_version=NEW.reviewed_profile_version
    AND selection.reviewed_grant_generation=NEW.reviewed_grant_generation
    AND selection.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND activation.record_id=selection.record_id
    AND activation.source_id=selection.source_id
    AND activation.source_instance_id=selection.source_instance_id
    AND activation.application_id=selection.application_id
    AND activation.history_epoch_id=selection.history_epoch_id
    AND activation.project_alpha_public_id=selection.root_public_id
    AND ((activation.resource_type='organization' AND selection.root_type='organization')
      OR (activation.resource_type='client' AND selection.root_type='standalone_client'))
    AND record.current_version=selection.record_version
    AND record.current_version=activation.local_record_version
    AND record.record_kind=activation.resource_type
    AND admission.active=1 AND admission.bound_access_subject=selection.reviewed_access_subject
    AND admission.version=selection.reviewed_admission_version
    AND profile.version=selection.reviewed_profile_version
    AND generation.generation=selection.reviewed_grant_generation
    AND EXISTS(SELECT 1 FROM staff_role_assignments role
      WHERE role.staff_id=admission.staff_id AND role.role_id='role-owner' AND role.scope='global')
    AND EXISTS(SELECT 1 FROM native_directory_grants grant
      WHERE grant.staff_id=admission.staff_id AND grant.permission='directory.portal_access.manage'
        AND grant.effect='allow' AND grant.active=1
        AND (grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=record.record_id)))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny
      WHERE deny.staff_id=admission.staff_id AND deny.permission='directory.portal_access.manage'
        AND deny.effect='deny' AND deny.active=1
        AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=record.record_id)
          OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
          OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
) OR NEW.state<>'pending' OR NEW.attempt_count<>0 OR NEW.claim_token IS NOT NULL
  OR NEW.claim_until IS NOT NULL OR NEW.acknowledged_claim_token IS NOT NULL
BEGIN SELECT RAISE(ABORT,'workspace binding command requires current reviewed owner authority'); END;

CREATE TRIGGER client_portal_workspace_binding_outbox_command_immutable
BEFORE UPDATE ON client_portal_workspace_binding_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.client_authority_id IS NOT OLD.client_authority_id
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.projection_source_id IS NOT OLD.projection_source_id
  OR NEW.source_workspace_id IS NOT OLD.source_workspace_id OR NEW.root_type IS NOT OLD.root_type
  OR NEW.root_public_id IS NOT OLD.root_public_id
  OR NEW.checkpoint_source_generation IS NOT OLD.checkpoint_source_generation
  OR NEW.checkpoint_source_sequence IS NOT OLD.checkpoint_source_sequence
  OR NEW.checkpoint_snapshot_generation_id IS NOT OLD.checkpoint_snapshot_generation_id
  OR NEW.reviewed_by_staff_id IS NOT OLD.reviewed_by_staff_id
  OR NEW.reviewed_access_subject IS NOT OLD.reviewed_access_subject
  OR NEW.reviewed_admission_version IS NOT OLD.reviewed_admission_version
  OR NEW.reviewed_profile_version IS NOT OLD.reviewed_profile_version
  OR NEW.reviewed_grant_generation IS NOT OLD.reviewed_grant_generation
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'workspace binding command is immutable'); END;
CREATE TRIGGER client_portal_workspace_binding_outbox_no_delete
BEFORE DELETE ON client_portal_workspace_binding_outbox
BEGIN SELECT RAISE(ABORT,'workspace binding command is durable'); END;

-- Terminal states never reopen. A lease may only be reclaimed after expiry;
-- the prior claimant cannot settle after expiry, even if no replacement has
-- claimed yet. This protects the occupied-workspace index from stale writes.
CREATE TRIGGER client_portal_workspace_binding_outbox_transition_guard
BEFORE UPDATE OF state ON client_portal_workspace_binding_outbox
WHEN NOT (
  (OLD.state IN ('pending','retry') AND NEW.state='dispatching'
    AND OLD.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR (OLD.state='dispatching' AND NEW.state='dispatching'
    AND OLD.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR (OLD.state='dispatching' AND OLD.claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.state IN ('retry','rejected','acknowledged'))
)
BEGIN SELECT RAISE(ABORT,'workspace binding outbox transition denied'); END;

CREATE TRIGGER client_portal_workspace_binding_outbox_control_guard
BEFORE UPDATE ON client_portal_workspace_binding_outbox
WHEN NEW.state=OLD.state AND (
  NEW.claim_token IS NOT OLD.claim_token OR NEW.claim_until IS NOT OLD.claim_until
  OR NEW.acknowledged_claim_token IS NOT OLD.acknowledged_claim_token
  OR NEW.attempt_count IS NOT OLD.attempt_count OR NEW.last_error_code IS NOT OLD.last_error_code)
BEGIN SELECT RAISE(ABORT,'workspace binding outbox control mutation denied'); END;

CREATE TABLE client_portal_workspace_binding_outbox_audit (
  operation_id TEXT PRIMARY KEY REFERENCES client_portal_workspace_binding_outbox(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action='inactive.binding.enqueued'),
  reviewed_by_staff_id TEXT NOT NULL,
  reviewed_grant_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER client_portal_workspace_binding_outbox_audit_guard
BEFORE INSERT ON client_portal_workspace_binding_outbox_audit
WHEN NOT EXISTS(SELECT 1 FROM client_portal_workspace_binding_outbox outbox
  WHERE outbox.operation_id=NEW.operation_id
    AND outbox.reviewed_by_staff_id=NEW.reviewed_by_staff_id
    AND outbox.reviewed_grant_generation=NEW.reviewed_grant_generation)
BEGIN SELECT RAISE(ABORT,'workspace binding audit requires exact command'); END;
CREATE TRIGGER client_portal_workspace_binding_outbox_audit_no_update
BEFORE UPDATE ON client_portal_workspace_binding_outbox_audit
BEGIN SELECT RAISE(ABORT,'workspace binding audit is immutable'); END;
CREATE TRIGGER client_portal_workspace_binding_outbox_audit_no_delete
BEFORE DELETE ON client_portal_workspace_binding_outbox_audit
BEGIN SELECT RAISE(ABORT,'workspace binding audit is durable'); END;

CREATE TABLE client_portal_workspace_binding_outbox_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES client_portal_workspace_binding_outbox(operation_id) ON DELETE RESTRICT,
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  root_type TEXT NOT NULL,
  root_public_id TEXT NOT NULL,
  checkpoint_source_generation TEXT NOT NULL,
  checkpoint_source_sequence INTEGER NOT NULL,
  checkpoint_snapshot_generation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state='inactive'),
  revision INTEGER NOT NULL CHECK(revision=1),
  replayed INTEGER NOT NULL CHECK(replayed IN (0,1)),
  acknowledged_claim_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER client_portal_workspace_binding_outbox_receipt_guard
BEFORE INSERT ON client_portal_workspace_binding_outbox_receipts
WHEN NOT EXISTS(SELECT 1 FROM client_portal_workspace_binding_outbox outbox
  JOIN client_portal_workspace_binding_outbox_audit audit ON audit.operation_id=outbox.operation_id
  WHERE outbox.operation_id=NEW.operation_id AND outbox.state='dispatching'
    AND outbox.claim_token=NEW.acknowledged_claim_token
    AND outbox.claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND outbox.client_authority_id=NEW.client_authority_id AND outbox.workspace_id=NEW.workspace_id
    AND outbox.projection_source_id=NEW.projection_source_id
    AND outbox.source_workspace_id=NEW.source_workspace_id
    AND outbox.root_type=NEW.root_type AND outbox.root_public_id=NEW.root_public_id
    AND outbox.checkpoint_source_generation=NEW.checkpoint_source_generation
    AND outbox.checkpoint_source_sequence=NEW.checkpoint_source_sequence
    AND outbox.checkpoint_snapshot_generation_id=NEW.checkpoint_snapshot_generation_id)
BEGIN SELECT RAISE(ABORT,'workspace binding receipt requires exact claimed command'); END;
CREATE TRIGGER client_portal_workspace_binding_outbox_receipt_no_update
BEFORE UPDATE ON client_portal_workspace_binding_outbox_receipts
BEGIN SELECT RAISE(ABORT,'workspace binding receipt is immutable'); END;
CREATE TRIGGER client_portal_workspace_binding_outbox_receipt_no_delete
BEFORE DELETE ON client_portal_workspace_binding_outbox_receipts
BEGIN SELECT RAISE(ABORT,'workspace binding receipt is durable'); END;

CREATE TRIGGER client_portal_workspace_binding_outbox_ack_guard
BEFORE UPDATE OF state ON client_portal_workspace_binding_outbox
WHEN NEW.state='acknowledged' AND NOT EXISTS(
  SELECT 1 FROM client_portal_workspace_binding_outbox_receipts receipt
  WHERE receipt.operation_id=OLD.operation_id
    AND receipt.acknowledged_claim_token=OLD.claim_token
    AND NEW.acknowledged_claim_token=OLD.claim_token)
BEGIN SELECT RAISE(ABORT,'workspace binding acknowledgement requires exact Client receipt'); END;
