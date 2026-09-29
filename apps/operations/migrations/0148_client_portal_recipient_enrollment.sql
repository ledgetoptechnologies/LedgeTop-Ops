PRAGMA foreign_keys = ON;

-- Default-off, staging-only enrollment ledger. The opaque handoff token is
-- stored only as a digest; an Access principal is added only by the private
-- Client -> Operations bridge after JWT verification.
CREATE TABLE client_portal_recipient_enrollment_intents (
  intent_id TEXT PRIMARY KEY CHECK(length(intent_id)=36 AND intent_id=lower(intent_id)
    AND substr(intent_id,9,1)='-' AND substr(intent_id,14,1)='-' AND substr(intent_id,15,1)='4'
    AND substr(intent_id,19,1)='-' AND substr(intent_id,20,1) IN ('8','9','a','b') AND substr(intent_id,24,1)='-'
    AND replace(intent_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  selection_id TEXT NOT NULL REFERENCES client_portal_workspace_binding_selections(selection_id) ON DELETE RESTRICT,
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('issued','pending','active','revoking','revoked')),
  revision INTEGER NOT NULL CHECK(revision>=1),
  access_issuer TEXT CHECK(access_issuer IS NULL OR length(trim(access_issuer)) BETWEEN 1 AND 512),
  access_subject TEXT CHECK(access_subject IS NULL OR length(trim(access_subject)) BETWEEN 1 AND 512),
  recipient_verified_until TEXT CHECK(recipient_verified_until IS NULL OR (length(recipient_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',recipient_verified_until)=recipient_verified_until)),
  binding_id TEXT UNIQUE REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  grant_operation_id TEXT UNIQUE REFERENCES client_portal_authority_v2_outbox(operation_id) ON DELETE RESTRICT,
  revoke_operation_id TEXT UNIQUE REFERENCES client_portal_authority_v2_outbox(operation_id) ON DELETE RESTRICT,
  issued_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  issued_access_subject TEXT NOT NULL,
  issued_admission_version INTEGER NOT NULL CHECK(issued_admission_version>=1),
  issued_profile_version INTEGER NOT NULL CHECK(issued_profile_version>=1),
  issued_grant_generation INTEGER NOT NULL CHECK(issued_grant_generation>=1),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='issued' AND access_issuer IS NULL AND access_subject IS NULL AND recipient_verified_until IS NULL
      AND binding_id IS NULL AND grant_operation_id IS NULL AND revoke_operation_id IS NULL)
    OR (state='pending' AND access_issuer IS NOT NULL AND access_subject IS NOT NULL
      AND recipient_verified_until IS NOT NULL AND binding_id IS NULL AND grant_operation_id IS NULL AND revoke_operation_id IS NULL)
    OR (state='active' AND access_issuer IS NOT NULL AND access_subject IS NOT NULL AND recipient_verified_until IS NOT NULL
      AND binding_id IS NOT NULL AND grant_operation_id IS NOT NULL AND revoke_operation_id IS NULL)
    OR (state='revoking' AND access_issuer IS NOT NULL AND access_subject IS NOT NULL AND recipient_verified_until IS NOT NULL
      AND binding_id IS NOT NULL AND grant_operation_id IS NOT NULL AND revoke_operation_id IS NOT NULL)
    OR (state='revoked' AND access_issuer IS NOT NULL AND access_subject IS NOT NULL AND recipient_verified_until IS NOT NULL
      AND binding_id IS NOT NULL AND grant_operation_id IS NOT NULL AND revoke_operation_id IS NOT NULL))
);
CREATE INDEX client_portal_recipient_enrollment_owner_queue
  ON client_portal_recipient_enrollment_intents(state,selection_id,created_at,intent_id);
CREATE TRIGGER client_portal_recipient_enrollment_insert_guard BEFORE INSERT
  ON client_portal_recipient_enrollment_intents
WHEN NEW.state<>'issued' OR NEW.revision<>1 OR NEW.access_issuer IS NOT NULL OR NEW.access_subject IS NOT NULL
  OR NEW.recipient_verified_until IS NOT NULL OR NEW.binding_id IS NOT NULL OR NEW.grant_operation_id IS NOT NULL
  OR NEW.revoke_operation_id IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM client_portal_workspace_binding_selections s
    JOIN client_portal_workspace_binding_outbox_receipts r ON r.operation_id=s.selection_id AND r.state='inactive' AND r.revision=1
    JOIN client_portal_workspace_binding_outbox b ON b.operation_id=r.operation_id AND b.state='acknowledged'
    JOIN operations_directory_records target ON target.record_id=NEW.target_client_record_id AND target.record_kind='client'
    JOIN native_staff_admissions a ON a.staff_id=NEW.issued_by_staff_id AND a.active=1
      AND a.bound_access_subject=NEW.issued_access_subject AND a.version=NEW.issued_admission_version
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.version=NEW.issued_profile_version
    JOIN native_directory_grant_generations generation ON generation.staff_id=a.staff_id
      AND generation.generation=NEW.issued_grant_generation
    WHERE s.selection_id=NEW.selection_id AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (s.record_id=target.record_id OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
        WHERE relation.client_record_id=target.record_id AND relation.organization_record_id=s.record_id))
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=a.staff_id
        AND role.role_id='role-owner' AND role.scope='global')
      AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=a.staff_id
        AND grant_row.permission='directory.portal_access.manage' AND grant_row.effect='allow' AND grant_row.active=1
        AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='resource' AND grant_row.resource_id=s.record_id)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=a.staff_id
        AND deny.permission='directory.portal_access.manage' AND deny.effect='deny' AND deny.active=1
        AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=s.record_id)
          OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=s.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
          OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=s.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
  )
BEGIN SELECT RAISE(ABORT,'recipient enrollment intent requires current owner and exact target'); END;

CREATE TABLE client_portal_recipient_enrollment_operations (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,15,1)='4'
    AND substr(operation_id,19,1)='-' AND substr(operation_id,20,1) IN ('8','9','a','b') AND substr(operation_id,24,1)='-'
    AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  intent_id TEXT NOT NULL REFERENCES client_portal_recipient_enrollment_intents(intent_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('issue','redeem','confirm','revoke','finalize_revoke')),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision>=1),
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('issued','pending','active','revoking','revoked')),
  actor_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT,
  actor_admission_version INTEGER,
  actor_profile_version INTEGER,
  actor_grant_generation INTEGER,
  actor_verified_until TEXT CHECK(actor_verified_until IS NULL OR (length(actor_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until)=actor_verified_until)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((action='redeem' AND actor_staff_id IS NULL AND actor_access_subject IS NULL
      AND actor_admission_version IS NULL AND actor_profile_version IS NULL AND actor_grant_generation IS NULL
      AND actor_verified_until IS NULL)
    OR (action<>'redeem' AND actor_staff_id IS NOT NULL AND actor_access_subject IS NOT NULL
      AND actor_admission_version>=1 AND actor_profile_version>=1 AND actor_grant_generation>=1
      AND actor_verified_until IS NOT NULL))
);
CREATE UNIQUE INDEX client_portal_recipient_enrollment_one_action_revision
  ON client_portal_recipient_enrollment_operations(intent_id,action,resulting_revision);
CREATE TRIGGER client_portal_recipient_enrollment_operation_insert_guard BEFORE INSERT
  ON client_portal_recipient_enrollment_operations
WHEN NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_intents i WHERE i.intent_id=NEW.intent_id
  AND (NEW.action='redeem' OR NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND ((NEW.action='issue' AND i.state='issued' AND i.revision=1 AND NEW.resulting_revision=1 AND NEW.resulting_state='issued')
    OR (NEW.action='redeem' AND i.state='issued' AND i.revision=1 AND NEW.resulting_revision=2 AND NEW.resulting_state='pending')
    OR (NEW.action='confirm' AND i.state='pending' AND NEW.resulting_revision=i.revision+1 AND NEW.resulting_state='active')
    OR (NEW.action='revoke' AND i.state='active' AND NEW.resulting_revision=i.revision+1 AND NEW.resulting_state='revoking')
    OR (NEW.action='finalize_revoke' AND i.state='revoking' AND NEW.resulting_revision=i.revision+1 AND NEW.resulting_state='revoked')))
BEGIN SELECT RAISE(ABORT,'recipient enrollment operation does not match current intent'); END;
CREATE TRIGGER client_portal_recipient_enrollment_operation_no_update BEFORE UPDATE
  ON client_portal_recipient_enrollment_operations BEGIN
  SELECT RAISE(ABORT,'recipient enrollment operation is immutable'); END;
CREATE TRIGGER client_portal_recipient_enrollment_operation_no_delete BEFORE DELETE
  ON client_portal_recipient_enrollment_operations BEGIN
  SELECT RAISE(ABORT,'recipient enrollment operation is durable'); END;
CREATE TABLE client_portal_recipient_enrollment_operation_commits (
  operation_id TEXT PRIMARY KEY REFERENCES client_portal_recipient_enrollment_operations(operation_id) ON DELETE RESTRICT,
  intent_id TEXT NOT NULL REFERENCES client_portal_recipient_enrollment_intents(intent_id) ON DELETE RESTRICT,
  committed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER client_portal_recipient_enrollment_operation_commit_guard BEFORE INSERT
  ON client_portal_recipient_enrollment_operation_commits
WHEN NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_operations o
  JOIN client_portal_recipient_enrollment_intents i ON i.intent_id=o.intent_id
  WHERE o.operation_id=NEW.operation_id AND o.intent_id=NEW.intent_id
    AND i.revision=o.resulting_revision AND i.state=o.resulting_state)
BEGIN SELECT RAISE(ABORT,'recipient enrollment operation did not commit exact intent state'); END;
CREATE TRIGGER client_portal_recipient_enrollment_operation_commit_no_update BEFORE UPDATE
  ON client_portal_recipient_enrollment_operation_commits BEGIN
  SELECT RAISE(ABORT,'recipient enrollment operation commit is immutable'); END;
CREATE TRIGGER client_portal_recipient_enrollment_operation_commit_no_delete BEFORE DELETE
  ON client_portal_recipient_enrollment_operation_commits BEGIN
  SELECT RAISE(ABORT,'recipient enrollment operation commit is durable'); END;
CREATE TRIGGER client_portal_recipient_enrollment_no_delete BEFORE DELETE
  ON client_portal_recipient_enrollment_intents BEGIN
  SELECT RAISE(ABORT,'recipient enrollment intent is durable'); END;
CREATE TRIGGER client_portal_recipient_enrollment_transition_guard BEFORE UPDATE
  ON client_portal_recipient_enrollment_intents
WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.selection_id IS NOT OLD.selection_id
  OR NEW.target_client_record_id IS NOT OLD.target_client_record_id OR NEW.token_sha256 IS NOT OLD.token_sha256
  OR NEW.issued_by_staff_id IS NOT OLD.issued_by_staff_id OR NEW.issued_access_subject IS NOT OLD.issued_access_subject
  OR NEW.issued_admission_version IS NOT OLD.issued_admission_version
  OR NEW.issued_profile_version IS NOT OLD.issued_profile_version
  OR NEW.issued_grant_generation IS NOT OLD.issued_grant_generation OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<>OLD.revision+1
  OR NOT ((OLD.state='issued' AND NEW.state='pending' AND OLD.revision=1
      AND OLD.access_issuer IS NULL AND OLD.access_subject IS NULL AND OLD.recipient_verified_until IS NULL
      AND NEW.access_issuer IS NOT NULL AND NEW.access_subject IS NOT NULL AND NEW.recipient_verified_until IS NOT NULL
      AND NEW.recipient_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NEW.binding_id IS NULL AND NEW.grant_operation_id IS NULL AND NEW.revoke_operation_id IS NULL
      AND EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_operations o WHERE o.intent_id=OLD.intent_id
        AND o.action='redeem' AND o.resulting_revision=NEW.revision AND o.resulting_state=NEW.state))
    OR (OLD.state='pending' AND NEW.state='active'
      AND NEW.access_issuer IS OLD.access_issuer AND NEW.access_subject IS OLD.access_subject
      AND NEW.recipient_verified_until IS OLD.recipient_verified_until AND NEW.binding_id IS NOT NULL
      AND NEW.grant_operation_id IS NOT NULL AND NEW.revoke_operation_id IS NULL
      AND EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_operations o WHERE o.intent_id=OLD.intent_id
        AND o.operation_id=NEW.grant_operation_id AND o.action='confirm'
        AND o.resulting_revision=NEW.revision AND o.resulting_state=NEW.state))
    OR (OLD.state='active' AND NEW.state='revoking'
      AND NEW.access_issuer IS OLD.access_issuer AND NEW.access_subject IS OLD.access_subject
      AND NEW.recipient_verified_until IS OLD.recipient_verified_until AND NEW.binding_id IS OLD.binding_id
      AND NEW.grant_operation_id IS OLD.grant_operation_id AND NEW.revoke_operation_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_operations o WHERE o.intent_id=OLD.intent_id
        AND o.operation_id=NEW.revoke_operation_id AND o.action='revoke'
        AND o.resulting_revision=NEW.revision AND o.resulting_state=NEW.state))
    OR (OLD.state='revoking' AND NEW.state='revoked'
      AND NEW.access_issuer IS OLD.access_issuer AND NEW.access_subject IS OLD.access_subject
      AND NEW.recipient_verified_until IS OLD.recipient_verified_until AND NEW.binding_id IS OLD.binding_id
      AND NEW.grant_operation_id IS OLD.grant_operation_id AND NEW.revoke_operation_id IS OLD.revoke_operation_id
      AND EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_operations o WHERE o.intent_id=OLD.intent_id
        AND o.action='finalize_revoke' AND o.resulting_revision=NEW.revision AND o.resulting_state=NEW.state)))
BEGIN SELECT RAISE(ABORT,'recipient enrollment transition denied'); END;
