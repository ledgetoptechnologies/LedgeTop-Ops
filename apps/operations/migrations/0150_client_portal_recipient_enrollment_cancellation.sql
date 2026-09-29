PRAGMA foreign_keys = ON;

-- Additive reviewed migration. It records a terminal owner cancellation without
-- rewriting 0148/0149's state/action CHECK constraints. The source intent remains
-- immutable history; callers derive state='cancelled' from this marker.
CREATE TABLE client_portal_recipient_enrollment_cancellations (
  intent_id TEXT PRIMARY KEY REFERENCES client_portal_recipient_enrollment_intents(intent_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,15,1)='4'
    AND substr(operation_id,19,1)='-' AND substr(operation_id,20,1) IN ('8','9','a','b') AND substr(operation_id,24,1)='-'
    AND length(replace(operation_id,'-',''))=32
    AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  prior_state TEXT NOT NULL CHECK(prior_state IN ('issued','pending')),
  prior_revision INTEGER NOT NULL CHECK(prior_revision>=1),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=prior_revision+1),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  actor_grant_generation INTEGER NOT NULL CHECK(actor_grant_generation>=1),
  actor_verified_until TEXT NOT NULL CHECK(length(actor_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until)=actor_verified_until),
  cancelled_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(cancelled_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',cancelled_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',cancelled_at)=cancelled_at)
);
CREATE INDEX client_portal_recipient_enrollment_cancellation_audit
  ON client_portal_recipient_enrollment_cancellations(cancelled_at,intent_id);

-- A cancellation operation ID is a separate namespace in the application, but
-- it must still never collide with either durable 0148 operation namespace.
CREATE TRIGGER client_portal_recipient_enrollment_cancellation_operation_id_guard
BEFORE INSERT ON client_portal_recipient_enrollment_cancellations
WHEN EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_operations WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_operation_commits WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'recipient enrollment cancellation operation ID is already used'); END;

-- The marker is the immutable audit record and the CAS fence. It can only be
-- inserted by the same current owner proof required for confirmation/revocation.
CREATE TRIGGER client_portal_recipient_enrollment_cancellation_insert_guard
BEFORE INSERT ON client_portal_recipient_enrollment_cancellations
WHEN NOT EXISTS(
  SELECT 1 FROM client_portal_recipient_enrollment_intents i
  JOIN client_portal_workspace_binding_selections s ON s.selection_id=i.selection_id
  JOIN native_staff_admissions a ON a.staff_id=NEW.actor_staff_id AND a.active=1
    AND a.bound_access_subject=NEW.actor_access_subject AND a.version=NEW.actor_admission_version
  JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.version=NEW.actor_profile_version
  JOIN native_directory_grant_generations generation ON generation.staff_id=a.staff_id
    AND generation.generation=NEW.actor_grant_generation
  WHERE i.intent_id=NEW.intent_id AND i.state=NEW.prior_state AND i.revision=NEW.prior_revision
    AND i.state IN ('issued','pending')
    AND i.binding_id IS NULL AND i.grant_operation_id IS NULL AND i.revoke_operation_id IS NULL
    AND NEW.actor_verified_until IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',NEW.actor_verified_until) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',NEW.actor_verified_until)=NEW.actor_verified_until
    AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
BEGIN SELECT RAISE(ABORT,'recipient enrollment cancellation requires current owner'); END;

CREATE TRIGGER client_portal_recipient_enrollment_cancellation_no_update
BEFORE UPDATE ON client_portal_recipient_enrollment_cancellations BEGIN
  SELECT RAISE(ABORT,'recipient enrollment cancellation is immutable');
END;
CREATE TRIGGER client_portal_recipient_enrollment_cancellation_no_delete
BEFORE DELETE ON client_portal_recipient_enrollment_cancellations BEGIN
  SELECT RAISE(ABORT,'recipient enrollment cancellation is durable');
END;

-- Existing operation IDs and commits cannot be appended after an intent is
-- canceled. This also fences direct SQL attempts, not only the Worker path.
CREATE TRIGGER client_portal_recipient_enrollment_operation_cancel_fence
BEFORE INSERT ON client_portal_recipient_enrollment_operations
WHEN EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=NEW.intent_id)
  OR EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'recipient enrollment operation is canceled'); END;
CREATE TRIGGER client_portal_recipient_enrollment_commit_cancel_fence
BEFORE INSERT ON client_portal_recipient_enrollment_operation_commits
WHEN EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=NEW.intent_id)
  OR EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_operations o
    JOIN client_portal_recipient_enrollment_cancellations c ON c.intent_id=o.intent_id
    WHERE o.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'recipient enrollment commit is canceled'); END;
CREATE TRIGGER client_portal_recipient_enrollment_intent_cancel_fence
BEFORE UPDATE ON client_portal_recipient_enrollment_intents
WHEN EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations c WHERE c.intent_id=OLD.intent_id)
BEGIN SELECT RAISE(ABORT,'recipient enrollment intent is canceled'); END;

-- A canceled issued/pending intent has no binding/outbox by construction. Keep
-- a defensive outbox fence for any future row that could be linked to it.
CREATE TRIGGER client_portal_recipient_enrollment_outbox_cancel_fence
BEFORE INSERT ON client_portal_authority_v2_outbox
WHEN EXISTS(
  SELECT 1 FROM client_portal_recipient_enrollment_intents i
  JOIN client_portal_recipient_enrollment_cancellations c ON c.intent_id=i.intent_id
  WHERE i.binding_id=NEW.recipient_binding_id
)
BEGIN SELECT RAISE(ABORT,'recipient enrollment authority outbox is canceled'); END;
CREATE TRIGGER client_portal_recipient_enrollment_outbox_cancel_update_fence
BEFORE UPDATE ON client_portal_authority_v2_outbox
WHEN EXISTS(
  SELECT 1 FROM client_portal_recipient_enrollment_intents i
  JOIN client_portal_recipient_enrollment_cancellations c ON c.intent_id=i.intent_id
  WHERE i.binding_id=NEW.recipient_binding_id
)
BEGIN SELECT RAISE(ABORT,'recipient enrollment authority outbox is canceled'); END;
