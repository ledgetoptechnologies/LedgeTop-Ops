PRAGMA foreign_keys = ON;

-- A private, default-off bridge to Client's protocol-2 inert authority ledger.
-- The binding receipt is the only admissible workspace handle: this table must
-- never infer a workspace from a customer, email, or Operations record.
CREATE TABLE client_portal_authority_v2_outbox (
  operation_id TEXT PRIMARY KEY,
  binding_operation_id TEXT NOT NULL REFERENCES client_portal_workspace_binding_outbox_receipts(operation_id) ON DELETE RESTRICT,
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  recipient_binding_id TEXT NOT NULL REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL CHECK(length(trim(issuer)) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK(length(trim(subject)) BETWEEN 1 AND 512),
  desired_state TEXT NOT NULL CHECK(desired_state IN ('active','revoked')),
  expected_ownership_epoch INTEGER NOT NULL CHECK(expected_ownership_epoch>=0),
  expected_grant_revision INTEGER NOT NULL CHECK(expected_grant_revision>=0),
  authorized_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL,
  authorized_admission_version INTEGER NOT NULL CHECK(authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(authorized_grant_generation>=1),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retry','dispatching','acknowledged','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error_code TEXT,
  claim_token TEXT,
  claim_until TEXT,
  acknowledged_claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(binding_operation_id,issuer,subject,expected_ownership_epoch,expected_grant_revision,desired_state),
  CHECK((expected_grant_revision=0 AND desired_state='active')
    OR (expected_ownership_epoch>=1 AND expected_grant_revision>=1))
);
CREATE INDEX client_portal_authority_v2_outbox_due ON client_portal_authority_v2_outbox(state,next_attempt_at,created_at);
CREATE UNIQUE INDEX client_portal_authority_v2_outbox_one_pending_principal
  ON client_portal_authority_v2_outbox(workspace_id,issuer,subject)
  WHERE state IN ('pending','retry','dispatching');

CREATE TRIGGER client_portal_authority_v2_outbox_insert_guard
BEFORE INSERT ON client_portal_authority_v2_outbox
WHEN NEW.state<>'pending' OR NEW.attempt_count<>0 OR NEW.claim_token IS NOT NULL OR NEW.claim_until IS NOT NULL
 OR NEW.acknowledged_claim_token IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM client_portal_workspace_binding_outbox_receipts receipt
  JOIN client_portal_workspace_binding_outbox binding ON binding.operation_id=receipt.operation_id
  JOIN client_portal_workspace_binding_selections selection ON selection.selection_id=binding.operation_id
  JOIN native_staff_admissions admission ON admission.staff_id=NEW.authorized_by_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE receipt.operation_id=NEW.binding_operation_id AND binding.state='acknowledged'
    AND receipt.client_authority_id=NEW.client_authority_id AND receipt.workspace_id=NEW.workspace_id
    AND receipt.state='inactive' AND receipt.revision=1
    AND selection.client_authority_id=NEW.client_authority_id AND selection.workspace_id=NEW.workspace_id
    AND EXISTS(SELECT 1 FROM client_onboarding_recipient_identity_bindings recipient
      WHERE recipient.binding_id=NEW.recipient_binding_id
        AND recipient.access_issuer=NEW.issuer AND recipient.access_subject=NEW.subject
        AND (recipient.target_client_record_id=selection.record_id
          OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
            WHERE relation.client_record_id=recipient.target_client_record_id
              AND relation.organization_record_id=selection.record_id))
        AND (NEW.desired_state='revoked' OR (recipient.status='active'
          AND (recipient.expires_at IS NULL OR recipient.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))))
    AND admission.active=1 AND admission.bound_access_subject=NEW.authorized_access_subject
    AND admission.version=NEW.authorized_admission_version AND profile.version=NEW.authorized_profile_version
    AND generation.generation=NEW.authorized_grant_generation
    AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=admission.staff_id AND r.role_id='role-owner' AND r.scope='global')
    AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=admission.staff_id
      AND g.permission='directory.portal_access.manage' AND g.effect='allow' AND g.active=1
      AND (g.scope_kind='global' OR (g.scope_kind='resource' AND g.resource_id=selection.record_id)))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants d WHERE d.staff_id=admission.staff_id
      AND d.permission='directory.portal_access.manage' AND d.effect='deny' AND d.active=1
      AND (d.scope_kind='global' OR (d.scope_kind='resource' AND d.resource_id=selection.record_id)
        OR (d.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=selection.record_id AND scope.active=1 AND scope.business_area_id=d.business_area_id))
        OR (d.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=selection.record_id AND scope.active=1 AND scope.division_id=d.division_id))))
 ) OR (NEW.expected_ownership_epoch>=1 AND NEW.expected_grant_revision=0 AND NOT EXISTS(
   SELECT 1 FROM client_portal_authority_v2_outbox_receipts receipt
   JOIN client_portal_authority_v2_outbox prior ON prior.operation_id=receipt.operation_id
   WHERE prior.binding_operation_id=NEW.binding_operation_id AND prior.state='acknowledged'
     AND receipt.client_authority_id=NEW.client_authority_id AND receipt.workspace_id=NEW.workspace_id
     AND receipt.ownership_epoch=NEW.expected_ownership_epoch
 )) OR (NEW.expected_grant_revision>=1 AND NOT EXISTS(
   SELECT 1 FROM client_portal_authority_v2_outbox_receipts receipt
   JOIN client_portal_authority_v2_outbox prior ON prior.operation_id=receipt.operation_id
   WHERE prior.binding_operation_id=NEW.binding_operation_id AND receipt.client_authority_id=NEW.client_authority_id
     AND receipt.workspace_id=NEW.workspace_id AND receipt.issuer=NEW.issuer AND receipt.subject=NEW.subject
     AND receipt.ownership_epoch=NEW.expected_ownership_epoch
     AND receipt.grant_revision=NEW.expected_grant_revision AND prior.state='acknowledged'
     AND prior.recipient_binding_id=NEW.recipient_binding_id
 ))
BEGIN SELECT RAISE(ABORT,'portal authority v2 requires exact acknowledged binding and current owner authority'); END;

CREATE TRIGGER client_portal_authority_v2_outbox_command_immutable BEFORE UPDATE ON client_portal_authority_v2_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.binding_operation_id IS NOT OLD.binding_operation_id
 OR NEW.client_authority_id IS NOT OLD.client_authority_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.recipient_binding_id IS NOT OLD.recipient_binding_id
 OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.desired_state IS NOT OLD.desired_state
 OR NEW.expected_ownership_epoch IS NOT OLD.expected_ownership_epoch OR NEW.expected_grant_revision IS NOT OLD.expected_grant_revision
 OR NEW.authorized_by_staff_id IS NOT OLD.authorized_by_staff_id OR NEW.authorized_access_subject IS NOT OLD.authorized_access_subject
 OR NEW.authorized_admission_version IS NOT OLD.authorized_admission_version OR NEW.authorized_profile_version IS NOT OLD.authorized_profile_version
 OR NEW.authorized_grant_generation IS NOT OLD.authorized_grant_generation
BEGIN SELECT RAISE(ABORT,'portal authority v2 command is immutable'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_no_delete BEFORE DELETE ON client_portal_authority_v2_outbox
BEGIN SELECT RAISE(ABORT,'portal authority v2 command is durable'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_transition_guard BEFORE UPDATE OF state ON client_portal_authority_v2_outbox
WHEN NOT ((OLD.state IN ('pending','retry') AND NEW.state='dispatching' AND OLD.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR (OLD.state='dispatching' AND NEW.state='dispatching' AND OLD.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR (OLD.state='dispatching' AND OLD.claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.state IN ('retry','dead','acknowledged')))
BEGIN SELECT RAISE(ABORT,'portal authority v2 transition denied'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_control_guard BEFORE UPDATE ON client_portal_authority_v2_outbox
WHEN NEW.state=OLD.state AND (NEW.claim_token IS NOT OLD.claim_token OR NEW.claim_until IS NOT OLD.claim_until
 OR NEW.acknowledged_claim_token IS NOT OLD.acknowledged_claim_token
 OR NEW.attempt_count IS NOT OLD.attempt_count OR NEW.last_error_code IS NOT OLD.last_error_code)
BEGIN SELECT RAISE(ABORT,'portal authority v2 control mutation denied'); END;

CREATE TABLE client_portal_authority_v2_outbox_audit (
 operation_id TEXT PRIMARY KEY REFERENCES client_portal_authority_v2_outbox(operation_id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action='v2.intent.enqueued'), authorized_by_staff_id TEXT NOT NULL,
 authorized_grant_generation INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE client_portal_authority_v2_outbox_receipts (
 operation_id TEXT PRIMARY KEY REFERENCES client_portal_authority_v2_outbox(operation_id) ON DELETE RESTRICT,
 client_authority_id TEXT NOT NULL, workspace_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
 ownership_epoch INTEGER NOT NULL, grant_revision INTEGER NOT NULL, resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
 acknowledged_claim_token TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER client_portal_authority_v2_outbox_audit_guard BEFORE INSERT ON client_portal_authority_v2_outbox_audit
WHEN NOT EXISTS(SELECT 1 FROM client_portal_authority_v2_outbox outbox WHERE outbox.operation_id=NEW.operation_id
  AND outbox.authorized_by_staff_id=NEW.authorized_by_staff_id
  AND outbox.authorized_grant_generation=NEW.authorized_grant_generation)
BEGIN SELECT RAISE(ABORT,'portal authority v2 audit requires exact command'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_dispatch_audit_guard BEFORE UPDATE OF state ON client_portal_authority_v2_outbox
WHEN NEW.state='dispatching' AND NOT EXISTS(SELECT 1 FROM client_portal_authority_v2_outbox_audit audit
  WHERE audit.operation_id=OLD.operation_id AND audit.authorized_by_staff_id=OLD.authorized_by_staff_id
    AND audit.authorized_grant_generation=OLD.authorized_grant_generation)
BEGIN SELECT RAISE(ABORT,'portal authority v2 dispatch requires immutable audit'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_audit_no_update BEFORE UPDATE ON client_portal_authority_v2_outbox_audit
BEGIN SELECT RAISE(ABORT,'portal authority v2 audit is immutable'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_audit_no_delete BEFORE DELETE ON client_portal_authority_v2_outbox_audit
BEGIN SELECT RAISE(ABORT,'portal authority v2 audit is durable'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_receipt_guard BEFORE INSERT ON client_portal_authority_v2_outbox_receipts
WHEN NOT EXISTS(SELECT 1 FROM client_portal_authority_v2_outbox o WHERE o.operation_id=NEW.operation_id
 AND o.state='dispatching' AND o.claim_token=NEW.acknowledged_claim_token AND o.claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND o.client_authority_id=NEW.client_authority_id AND o.workspace_id=NEW.workspace_id AND o.issuer=NEW.issuer AND o.subject=NEW.subject
 AND (CASE WHEN o.expected_ownership_epoch=0 THEN 1 ELSE o.expected_ownership_epoch END)=NEW.ownership_epoch
 AND o.expected_grant_revision+1=NEW.grant_revision AND o.desired_state=NEW.resulting_state)
BEGIN SELECT RAISE(ABORT,'portal authority v2 receipt requires exact claimed command'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_receipt_no_update BEFORE UPDATE ON client_portal_authority_v2_outbox_receipts
BEGIN SELECT RAISE(ABORT,'portal authority v2 receipt is immutable'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_receipt_no_delete BEFORE DELETE ON client_portal_authority_v2_outbox_receipts
BEGIN SELECT RAISE(ABORT,'portal authority v2 receipt is durable'); END;
CREATE TRIGGER client_portal_authority_v2_outbox_ack_guard BEFORE UPDATE OF state ON client_portal_authority_v2_outbox
WHEN NEW.state='acknowledged' AND NOT EXISTS(SELECT 1 FROM client_portal_authority_v2_outbox_receipts r
 WHERE r.operation_id=OLD.operation_id AND r.acknowledged_claim_token=OLD.claim_token AND NEW.acknowledged_claim_token=OLD.claim_token)
BEGIN SELECT RAISE(ABORT,'portal authority v2 acknowledgement requires exact Client receipt'); END;
