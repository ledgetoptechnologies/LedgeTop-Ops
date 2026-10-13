PRAGMA foreign_keys = ON;

-- Operations-owned recipient consent and home authority.  This lineage is
-- deliberately independent of the legacy PA workspace selection, principal,
-- membership and entitlement tables.
CREATE TABLE operations_portal_native_recipient_intents (
  intent_id TEXT PRIMARY KEY CHECK(length(intent_id)=36 AND intent_id=lower(intent_id)
    AND substr(intent_id,9,1)='-' AND substr(intent_id,14,1)='-' AND substr(intent_id,15,1)='4'
    AND substr(intent_id,19,1)='-' AND substr(intent_id,20,1) IN ('8','9','a','b') AND substr(intent_id,24,1)='-'
    AND replace(intent_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  target_id TEXT NOT NULL REFERENCES operations_portal_workspace_reservation_heads(target_id) ON DELETE RESTRICT,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  target_relationship_version INTEGER NOT NULL CHECK(target_relationship_version>=1),
  token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('issued','pending','confirming','active','revoking','revoked','cancelled')),
  revision INTEGER NOT NULL CHECK(revision>=1),
  access_issuer TEXT CHECK(access_issuer IS NULL OR (length(trim(access_issuer)) BETWEEN 1 AND 512 AND instr(access_issuer,char(0))=0)),
  access_subject TEXT CHECK(access_subject IS NULL OR (length(trim(access_subject)) BETWEEN 1 AND 512 AND instr(access_subject,char(0))=0)),
  recipient_verified_until TEXT CHECK(recipient_verified_until IS NULL OR (length(recipient_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',recipient_verified_until) IS recipient_verified_until)),
  recipient_binding_id TEXT UNIQUE REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  grant_operation_id TEXT UNIQUE,
  revoke_operation_id TEXT UNIQUE,
  issued_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  issued_access_subject TEXT NOT NULL,
  issued_email TEXT NOT NULL,
  issued_admission_version INTEGER NOT NULL CHECK(issued_admission_version>=1),
  issued_profile_version INTEGER NOT NULL CHECK(issued_profile_version>=1),
  issued_grant_generation INTEGER NOT NULL CHECK(issued_grant_generation>=1),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='issued' AND revision=1 AND access_issuer IS NULL AND access_subject IS NULL
      AND recipient_verified_until IS NULL AND recipient_binding_id IS NULL AND grant_operation_id IS NULL AND revoke_operation_id IS NULL)
    OR (state='pending' AND access_issuer IS NOT NULL AND access_subject IS NOT NULL AND recipient_verified_until IS NOT NULL
      AND recipient_binding_id IS NULL AND grant_operation_id IS NULL AND revoke_operation_id IS NULL)
    OR (state IN ('confirming','active') AND access_issuer IS NOT NULL AND access_subject IS NOT NULL
      AND recipient_verified_until IS NOT NULL AND recipient_binding_id IS NOT NULL AND grant_operation_id IS NOT NULL
      AND revoke_operation_id IS NULL)
    OR (state IN ('revoking','revoked') AND access_issuer IS NOT NULL AND access_subject IS NOT NULL
      AND recipient_verified_until IS NOT NULL AND recipient_binding_id IS NOT NULL AND grant_operation_id IS NOT NULL
      AND revoke_operation_id IS NOT NULL)
    OR (state='cancelled' AND recipient_binding_id IS NULL AND grant_operation_id IS NULL AND revoke_operation_id IS NULL))
);
CREATE INDEX operations_portal_native_recipient_intent_queue
  ON operations_portal_native_recipient_intents(target_id,state,created_at,intent_id);

CREATE TABLE operations_portal_native_recipient_operations (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,15,1)='4'
    AND substr(operation_id,19,1)='-' AND substr(operation_id,20,1) IN ('8','9','a','b') AND substr(operation_id,24,1)='-'
    AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  intent_id TEXT NOT NULL REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('issue','redeem','cancel','confirm','revoke')),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('issued','pending','confirming','revoking','cancelled')),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json)
    AND json_type(canonical_request_json)='object' AND length(CAST(canonical_request_json AS BLOB))<=32768),
  actor_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT,
  actor_email TEXT,
  actor_admission_version INTEGER,
  actor_profile_version INTEGER,
  actor_grant_generation INTEGER,
  actor_verified_until TEXT CHECK(actor_verified_until IS NULL OR (length(actor_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until) IS actor_verified_until)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((action='redeem' AND actor_staff_id IS NULL AND actor_access_subject IS NULL AND actor_email IS NULL
      AND actor_admission_version IS NULL AND actor_profile_version IS NULL AND actor_grant_generation IS NULL
      AND actor_verified_until IS NULL)
    OR (action<>'redeem' AND actor_staff_id IS NOT NULL AND actor_access_subject IS NOT NULL AND actor_email IS NOT NULL
      AND actor_admission_version>=1 AND actor_profile_version>=1 AND actor_grant_generation>=1
      AND actor_verified_until IS NOT NULL)),
  CHECK((action='issue' AND expected_revision=0 AND resulting_revision=1 AND resulting_state='issued')
    OR (action='redeem' AND expected_revision=1 AND resulting_revision=2 AND resulting_state='pending')
    OR (action='confirm' AND resulting_state='confirming') OR (action='revoke' AND resulting_state='revoking')
    OR (action='cancel' AND resulting_state='cancelled'))
);
CREATE UNIQUE INDEX operations_portal_native_recipient_operation_revision
  ON operations_portal_native_recipient_operations(intent_id,resulting_revision);

CREATE TABLE operations_portal_native_recipient_operation_commits (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_recipient_operations(operation_id) ON DELETE RESTRICT,
  intent_id TEXT NOT NULL REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  committed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_authority_commands (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_recipient_operations(operation_id) ON DELETE RESTRICT,
  authorization_fingerprint TEXT NOT NULL CHECK(length(authorization_fingerprint)=64
    AND authorization_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_authorization_json TEXT NOT NULL CHECK(json_valid(canonical_authorization_json)
    AND json_type(canonical_authorization_json)='object' AND length(CAST(canonical_authorization_json AS BLOB))<=65536),
  action TEXT NOT NULL CHECK(action IN ('recipient.grant','recipient.revoke','workspace.revoke')),
  target_id TEXT NOT NULL REFERENCES operations_portal_workspace_reservation_heads(target_id) ON DELETE RESTRICT,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  recipient_binding_id TEXT REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  enrollment_intent_id TEXT REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  target_client_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  issuer TEXT,
  subject TEXT,
  expected_ownership_epoch INTEGER NOT NULL CHECK(expected_ownership_epoch>=0),
  resulting_ownership_epoch INTEGER NOT NULL CHECK(resulting_ownership_epoch>=1),
  expected_grant_revision INTEGER,
  resulting_grant_revision INTEGER,
  permission_schema_version INTEGER NOT NULL CHECK(permission_schema_version=3),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json) AND json_type(permissions_json)='array'),
  expires_at TEXT CHECK(expires_at IS NULL OR (length(expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at)),
  authorized_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL,
  authorized_admission_version INTEGER NOT NULL CHECK(authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(authorized_grant_generation>=1),
  authorized_verified_until TEXT NOT NULL CHECK(length(authorized_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',authorized_verified_until) IS authorized_verified_until),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((action IN ('recipient.grant','recipient.revoke') AND recipient_binding_id IS NOT NULL
      AND enrollment_intent_id IS NOT NULL AND target_client_record_id IS NOT NULL AND issuer IS NOT NULL AND subject IS NOT NULL
      AND expected_grant_revision IS NOT NULL AND resulting_grant_revision=expected_grant_revision+1)
    OR (action='workspace.revoke' AND recipient_binding_id IS NULL AND enrollment_intent_id IS NULL
      AND target_client_record_id IS NULL AND issuer IS NULL AND subject IS NULL
      AND expected_grant_revision IS NULL AND resulting_grant_revision IS NULL)),
  CHECK((action='recipient.grant' AND permissions_json='["operations.service_home.read"]')
    OR (action IN ('recipient.revoke','workspace.revoke') AND permissions_json='[]')),
  CHECK((action='recipient.grant' AND ((expected_ownership_epoch=0 AND resulting_ownership_epoch=1)
      OR (expected_ownership_epoch>=1 AND resulting_ownership_epoch=expected_ownership_epoch)))
    OR (action='recipient.revoke' AND expected_ownership_epoch>=1
      AND resulting_ownership_epoch=expected_ownership_epoch)
    OR (action='workspace.revoke' AND expected_ownership_epoch>=1
      AND resulting_ownership_epoch=expected_ownership_epoch+1))
);

CREATE TABLE operations_portal_native_workspace_authority_heads (
  target_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_reservation_heads(target_id) ON DELETE RESTRICT,
  target_revision INTEGER NOT NULL,
  client_authority_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL UNIQUE,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch>=1),
  state TEXT NOT NULL CHECK(state IN ('provisioning','active','revoking','revoked')),
  creation_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  created_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_access_subject TEXT NOT NULL,
  created_admission_version INTEGER NOT NULL,
  created_profile_version INTEGER NOT NULL,
  created_grant_generation INTEGER NOT NULL,
  revoked_by_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  revoked_operation_id TEXT UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state IN ('provisioning','active') AND revoked_by_staff_id IS NULL AND revoked_operation_id IS NULL)
    OR (state IN ('revoking','revoked') AND revoked_by_staff_id IS NOT NULL AND revoked_operation_id IS NOT NULL))
);

CREATE TABLE operations_portal_native_recipient_authority_heads (
  recipient_binding_id TEXT PRIMARY KEY REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  enrollment_intent_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL REFERENCES operations_portal_native_workspace_authority_heads(target_id) ON DELETE RESTRICT,
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch>=1),
  grant_revision INTEGER NOT NULL CHECK(grant_revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  permission_schema_version INTEGER NOT NULL CHECK(permission_schema_version=3),
  permissions_json TEXT NOT NULL CHECK((state='active' AND permissions_json='["operations.service_home.read"]')
    OR (state='revoked' AND permissions_json='[]')),
  expires_at TEXT CHECK(expires_at IS NULL OR (length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at)),
  creation_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  created_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_access_subject TEXT NOT NULL,
  created_admission_version INTEGER NOT NULL,
  created_profile_version INTEGER NOT NULL,
  created_grant_generation INTEGER NOT NULL,
  revoked_by_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  revoked_operation_id TEXT UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='active' AND revoked_by_staff_id IS NULL AND revoked_operation_id IS NULL)
    OR (state='revoked' AND revoked_by_staff_id IS NOT NULL AND revoked_operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX operations_portal_native_recipient_one_current_principal
  ON operations_portal_native_recipient_authority_heads(target_id,issuer,subject) WHERE state='active';

-- The materialized wire row is separate from the owner-authorized command: a
-- grant cannot freeze publication pins until an exact publication receipt exists.
CREATE TABLE operations_portal_native_authority_outbox (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_wire_json TEXT NOT NULL CHECK(json_valid(canonical_wire_json) AND json_type(canonical_wire_json)='object'
    AND length(CAST(canonical_wire_json AS BLOB))<=131072),
  publication_operation_id TEXT,
  publication_id TEXT,
  publication_revision INTEGER,
  publication_source_sequence INTEGER,
  publication_snapshot_id TEXT,
  publication_snapshot_sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','acknowledged')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at INTEGER NOT NULL DEFAULT(unixepoch()*1000),
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((lease_token IS NULL AND lease_expires_at IS NULL) OR (state='claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((publication_operation_id IS NULL AND publication_id IS NULL AND publication_revision IS NULL
      AND publication_source_sequence IS NULL AND publication_snapshot_id IS NULL AND publication_snapshot_sha256 IS NULL)
    OR (publication_operation_id IS NOT NULL AND publication_id IS NOT NULL AND publication_revision>=1
      AND publication_source_sequence>=1 AND publication_snapshot_id IS NOT NULL
      AND length(publication_snapshot_sha256)=64 AND publication_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'))
);

CREATE TABLE operations_portal_native_authority_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_authority_outbox(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL,
  target_id TEXT NOT NULL,
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  recipient_binding_id TEXT,
  enrollment_intent_id TEXT,
  issuer TEXT,
  subject TEXT,
  ownership_epoch INTEGER NOT NULL,
  grant_revision INTEGER,
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  permission_schema_version INTEGER NOT NULL CHECK(permission_schema_version=3),
  permissions_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_authority_finalizations (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_authority_receipts(operation_id) ON DELETE RESTRICT,
  intent_id TEXT NOT NULL REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  prior_state TEXT NOT NULL CHECK(prior_state IN ('confirming','revoking')),
  prior_revision INTEGER NOT NULL,
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=prior_revision+1),
  finalized_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((prior_state='confirming' AND resulting_state='active') OR (prior_state='revoking' AND resulting_state='revoked'))
);

CREATE VIEW operations_portal_native_recipient_live_owner_authority AS
SELECT operation.operation_id
FROM operations_portal_native_recipient_operations operation
JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=operation.intent_id
JOIN operations_portal_workspace_reservation_heads target ON target.target_id=intent.target_id AND target.state='active'
JOIN native_staff_admissions admission ON admission.staff_id=operation.actor_staff_id AND admission.active=1
  AND admission.bound_access_subject=operation.actor_access_subject AND admission.version=operation.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=operation.actor_email
  AND profile.version=operation.actor_profile_version
JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  AND generation.generation=operation.actor_grant_generation
WHERE operation.action<>'redeem' AND operation.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
    AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
      OR (role.role_id='role-division-manager' AND role.scope='division'
        AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=target.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
  AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=target.root_record_id)
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=target.root_record_id);

-- Every intent is pinned to one active 0152 target and one exact current client
-- relationship. Profile edits do not affect this relationship revision.
CREATE TRIGGER operations_portal_native_recipient_intent_insert_guard
BEFORE INSERT ON operations_portal_native_recipient_intents
WHEN NEW.state<>'issued' OR NEW.revision<>1 OR NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NOT EXISTS(
  SELECT 1 FROM operations_portal_workspace_reservation_heads target
  JOIN operations_directory_records client ON client.record_id=NEW.target_client_record_id AND client.record_kind='client'
  JOIN operations_directory_client_organizations relation ON relation.client_record_id=client.record_id
    AND relation.relationship_version=NEW.target_relationship_version
  JOIN native_staff_admissions admission ON admission.staff_id=NEW.issued_by_staff_id AND admission.active=1
    AND admission.bound_access_subject=NEW.issued_access_subject AND admission.version=NEW.issued_admission_version
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=NEW.issued_email
    AND profile.version=NEW.issued_profile_version
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    AND generation.generation=NEW.issued_grant_generation
  WHERE target.target_id=NEW.target_id AND target.revision=NEW.target_revision AND target.state='active'
    AND ((target.root_kind='organization' AND relation.organization_record_id=target.root_record_id)
      OR (target.root_kind='standalone_client' AND client.record_id=target.root_record_id AND relation.organization_record_id IS NULL))
    AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
      AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
        OR (role.role_id='role-division-manager' AND role.scope='division'
          AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=target.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
    AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
      WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=target.root_record_id)
    AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
      WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=target.root_record_id))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient issue denied'); END;

CREATE TRIGGER operations_portal_native_recipient_operation_json_guard
BEFORE INSERT ON operations_portal_native_recipient_operations
WHEN (SELECT count(*) FROM json_each(NEW.canonical_request_json))<>5
  OR json_extract(NEW.canonical_request_json,'$.action') IS NOT NEW.action
  OR json_extract(NEW.canonical_request_json,'$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.canonical_request_json,'$.intentId') IS NOT NEW.intent_id
  OR json_type(NEW.canonical_request_json,'$.request') IS NOT 'object'
  OR ((NEW.action='redeem' AND json_type(NEW.canonical_request_json,'$.actor') IS NOT 'null')
    OR (NEW.action<>'redeem' AND (json_type(NEW.canonical_request_json,'$.actor') IS NOT 'object'
      OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.actor'))<>7
      OR json_extract(NEW.canonical_request_json,'$.actor.staffId') IS NOT NEW.actor_staff_id
      OR json_extract(NEW.canonical_request_json,'$.actor.accessSubject') IS NOT NEW.actor_access_subject
      OR json_extract(NEW.canonical_request_json,'$.actor.email') IS NOT NEW.actor_email
      OR json_extract(NEW.canonical_request_json,'$.actor.admissionVersion') IS NOT NEW.actor_admission_version
      OR json_extract(NEW.canonical_request_json,'$.actor.profileVersion') IS NOT NEW.actor_profile_version
      OR json_extract(NEW.canonical_request_json,'$.actor.grantGeneration') IS NOT NEW.actor_grant_generation
      OR json_extract(NEW.canonical_request_json,'$.actor.verifiedUntil') IS NOT NEW.actor_verified_until)))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient operation audit is invalid'); END;

CREATE TRIGGER operations_portal_native_recipient_operation_request_guard
BEFORE INSERT ON operations_portal_native_recipient_operations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_intents intent
  WHERE intent.intent_id=NEW.intent_id
    AND json_extract(NEW.canonical_request_json,'$.request.expectedRevision') IS NEW.expected_revision
    AND ((NEW.action='issue' AND intent.state='issued' AND intent.revision=1 AND NEW.expected_revision=0
        AND (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=6
        AND json_extract(NEW.canonical_request_json,'$.request.targetId')=intent.target_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRevision')=intent.target_revision
        AND json_extract(NEW.canonical_request_json,'$.request.targetClientRecordId')=intent.target_client_record_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRelationshipVersion')=intent.target_relationship_version
        AND json_extract(NEW.canonical_request_json,'$.request.expiresAt')=intent.expires_at)
      OR (NEW.action='redeem' AND intent.state='issued' AND intent.revision=1
        AND (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=9
        AND json_extract(NEW.canonical_request_json,'$.request.targetId')=intent.target_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetClientRecordId')=intent.target_client_record_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRelationshipVersion')=intent.target_relationship_version
        AND json_extract(NEW.canonical_request_json,'$.request.tokenSha256')=intent.token_sha256)
      OR (NEW.action IN ('cancel','confirm','revoke') AND intent.revision=NEW.expected_revision
        AND (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=1))
  AND (NEW.action='redeem' OR EXISTS(
    SELECT 1 FROM operations_portal_workspace_reservation_heads target
    JOIN native_staff_admissions admission ON admission.staff_id=NEW.actor_staff_id
      AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject
      AND admission.version=NEW.actor_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      AND profile.login_email=NEW.actor_email AND profile.version=NEW.actor_profile_version
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      AND generation.generation=NEW.actor_grant_generation
    WHERE target.target_id=intent.target_id AND target.state='active'
      AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
          OR (role.role_id='role-division-manager' AND role.scope='division'
            AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=target.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.record_id=target.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.record_id=target.root_record_id))))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient operation denied'); END;

CREATE TRIGGER operations_portal_native_recipient_operation_commit_guard
BEFORE INSERT ON operations_portal_native_recipient_operation_commits
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_operations operation
  JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=operation.intent_id
  WHERE operation.operation_id=NEW.operation_id AND operation.intent_id=NEW.intent_id
    AND intent.revision=operation.resulting_revision AND intent.state=operation.resulting_state)
BEGIN SELECT RAISE(ABORT,'operations portal native recipient operation did not commit'); END;

CREATE TRIGGER operations_portal_native_authority_command_guard
BEFORE INSERT ON operations_portal_native_authority_commands
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_operations operation
  JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=operation.intent_id
  JOIN operations_portal_workspace_reservation_heads target ON target.target_id=intent.target_id AND target.state='active'
  JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=NEW.recipient_binding_id
    AND binding.target_client_record_id=intent.target_client_record_id AND binding.access_issuer=intent.access_issuer
    AND binding.access_subject=intent.access_subject AND binding.status='active'
  JOIN operations_directory_client_organizations relation ON relation.client_record_id=intent.target_client_record_id
    AND relation.relationship_version=intent.target_relationship_version
  WHERE operation.operation_id=NEW.operation_id AND operation.intent_id=intent.intent_id
    AND NEW.enrollment_intent_id=intent.intent_id AND NEW.target_id=target.target_id AND NEW.target_revision=target.revision
    AND NEW.client_authority_id=target.client_authority_id AND NEW.workspace_id=target.workspace_id
    AND NEW.root_kind=target.root_kind AND NEW.root_record_id=target.root_record_id
    AND NEW.target_client_record_id=intent.target_client_record_id AND NEW.issuer=intent.access_issuer AND NEW.subject=intent.access_subject
    AND NEW.authorized_by_staff_id=operation.actor_staff_id AND NEW.authorized_access_subject=operation.actor_access_subject
    AND NEW.authorized_admission_version=operation.actor_admission_version
    AND NEW.authorized_profile_version=operation.actor_profile_version
    AND NEW.authorized_grant_generation=operation.actor_grant_generation
    AND NEW.authorized_verified_until=operation.actor_verified_until
    AND ((target.root_kind='organization' AND relation.organization_record_id=target.root_record_id)
      OR (target.root_kind='standalone_client' AND intent.target_client_record_id=target.root_record_id
        AND relation.organization_record_id IS NULL))
    AND ((NEW.action='recipient.grant' AND operation.action='confirm' AND intent.state='pending'
        AND NEW.expected_grant_revision=0 AND NEW.resulting_grant_revision=1
        AND ((NEW.expected_ownership_epoch=0 AND NEW.resulting_ownership_epoch=1
            AND NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace WHERE workspace.target_id=target.target_id))
          OR (NEW.expected_ownership_epoch>=1 AND NEW.resulting_ownership_epoch=NEW.expected_ownership_epoch
            AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace
              WHERE workspace.target_id=target.target_id AND workspace.state='active'
                AND workspace.ownership_epoch=NEW.expected_ownership_epoch)))
        AND NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_authority_heads existing
          WHERE existing.target_id=target.target_id AND existing.issuer=intent.access_issuer
            AND existing.subject=intent.access_subject AND existing.state='active'))
      OR (NEW.action='recipient.revoke' AND operation.action='revoke' AND intent.state='active'
        AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace
          JOIN operations_portal_native_recipient_authority_heads head ON head.target_id=workspace.target_id
          WHERE workspace.target_id=target.target_id AND workspace.state='active'
            AND workspace.ownership_epoch=NEW.expected_ownership_epoch
            AND head.recipient_binding_id=NEW.recipient_binding_id AND head.state='active'
            AND head.ownership_epoch=NEW.expected_ownership_epoch AND head.grant_revision=NEW.expected_grant_revision))))
BEGIN SELECT RAISE(ABORT,'operations portal native authority command denied'); END;

CREATE TRIGGER operations_portal_native_authority_command_json_guard
BEFORE INSERT ON operations_portal_native_authority_commands
WHEN (SELECT count(*) FROM json_each(NEW.canonical_authorization_json))<>11
  OR json_extract(NEW.canonical_authorization_json,'$.action') IS NOT NEW.action
  OR json_extract(NEW.canonical_authorization_json,'$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.canonical_authorization_json,'$.target.targetId') IS NOT NEW.target_id
  OR json_extract(NEW.canonical_authorization_json,'$.target.targetRevision') IS NOT NEW.target_revision
  OR json_extract(NEW.canonical_authorization_json,'$.target.clientAuthorityId') IS NOT NEW.client_authority_id
  OR json_extract(NEW.canonical_authorization_json,'$.target.workspaceId') IS NOT NEW.workspace_id
  OR json_extract(NEW.canonical_authorization_json,'$.target.rootKind') IS NOT NEW.root_kind
  OR json_extract(NEW.canonical_authorization_json,'$.target.rootRecordId') IS NOT NEW.root_record_id
  OR json_extract(NEW.canonical_authorization_json,'$.recipient.recipientBindingId') IS NOT NEW.recipient_binding_id
  OR json_extract(NEW.canonical_authorization_json,'$.recipient.enrollmentIntentId') IS NOT NEW.enrollment_intent_id
  OR json_extract(NEW.canonical_authorization_json,'$.recipient.targetClientRecordId') IS NOT NEW.target_client_record_id
  OR json_extract(NEW.canonical_authorization_json,'$.recipient.issuer') IS NOT NEW.issuer
  OR json_extract(NEW.canonical_authorization_json,'$.recipient.subject') IS NOT NEW.subject
  OR json_extract(NEW.canonical_authorization_json,'$.expected.ownershipEpoch') IS NOT NEW.expected_ownership_epoch
  OR json_extract(NEW.canonical_authorization_json,'$.expected.grantRevision') IS NOT NEW.expected_grant_revision
  OR json_extract(NEW.canonical_authorization_json,'$.resulting.ownershipEpoch') IS NOT NEW.resulting_ownership_epoch
  OR json_extract(NEW.canonical_authorization_json,'$.resulting.grantRevision') IS NOT NEW.resulting_grant_revision
  OR json_extract(NEW.canonical_authorization_json,'$.permissionSchemaVersion') IS NOT NEW.permission_schema_version
  OR json_extract(NEW.canonical_authorization_json,'$.permissions') IS NOT NEW.permissions_json
  OR json_extract(NEW.canonical_authorization_json,'$.expiresAt') IS NOT NEW.expires_at
  OR json_extract(NEW.canonical_authorization_json,'$.actorProof.staffId') IS NOT NEW.authorized_by_staff_id
  OR json_extract(NEW.canonical_authorization_json,'$.actorProof.verifiedAccessSubject') IS NOT NEW.authorized_access_subject
  OR json_extract(NEW.canonical_authorization_json,'$.actorProof.admissionVersion') IS NOT NEW.authorized_admission_version
  OR json_extract(NEW.canonical_authorization_json,'$.actorProof.profileVersion') IS NOT NEW.authorized_profile_version
  OR json_extract(NEW.canonical_authorization_json,'$.actorProof.grantGeneration') IS NOT NEW.authorized_grant_generation
  OR json_extract(NEW.canonical_authorization_json,'$.actorProof.verifiedUntil') IS NOT NEW.authorized_verified_until
  OR json_extract(NEW.canonical_authorization_json,'$.observedAt') IS NOT NEW.observed_at
BEGIN SELECT RAISE(ABORT,'operations portal native authority command audit is invalid'); END;

CREATE TRIGGER operations_portal_native_workspace_head_insert_guard
BEFORE INSERT ON operations_portal_native_workspace_authority_heads
WHEN NEW.state<>'provisioning' OR NEW.ownership_epoch<>1 OR NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  WHERE command.operation_id=NEW.creation_operation_id AND command.operation_id=NEW.latest_operation_id
    AND command.action='recipient.grant' AND command.target_id=NEW.target_id AND command.target_revision=NEW.target_revision
    AND command.client_authority_id=NEW.client_authority_id AND command.workspace_id=NEW.workspace_id
    AND command.root_kind=NEW.root_kind AND command.root_record_id=NEW.root_record_id
    AND command.expected_ownership_epoch=0 AND command.resulting_ownership_epoch=NEW.ownership_epoch
    AND command.authorized_by_staff_id=NEW.created_by_staff_id
    AND command.authorized_access_subject=NEW.created_access_subject
    AND command.authorized_admission_version=NEW.created_admission_version
    AND command.authorized_profile_version=NEW.created_profile_version
    AND command.authorized_grant_generation=NEW.created_grant_generation)
BEGIN SELECT RAISE(ABORT,'operations portal native workspace head insert denied'); END;

CREATE TRIGGER operations_portal_native_recipient_head_insert_guard
BEFORE INSERT ON operations_portal_native_recipient_authority_heads
WHEN NEW.state<>'active' OR NEW.grant_revision<>1 OR NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
  WHERE command.operation_id=NEW.creation_operation_id AND command.operation_id=NEW.latest_operation_id
    AND command.action='recipient.grant' AND command.recipient_binding_id=NEW.recipient_binding_id
    AND command.enrollment_intent_id=NEW.enrollment_intent_id AND command.target_id=NEW.target_id
    AND command.target_client_record_id=NEW.target_client_record_id AND command.issuer=NEW.issuer AND command.subject=NEW.subject
    AND command.resulting_ownership_epoch=NEW.ownership_epoch AND command.resulting_grant_revision=NEW.grant_revision
    AND command.permission_schema_version=NEW.permission_schema_version AND command.permissions_json=NEW.permissions_json
    AND command.expires_at IS NEW.expires_at AND workspace.ownership_epoch=NEW.ownership_epoch
    AND workspace.state IN ('provisioning','active') AND command.authorized_by_staff_id=NEW.created_by_staff_id
    AND command.authorized_access_subject=NEW.created_access_subject
    AND command.authorized_admission_version=NEW.created_admission_version
    AND command.authorized_profile_version=NEW.created_profile_version
    AND command.authorized_grant_generation=NEW.created_grant_generation)
BEGIN SELECT RAISE(ABORT,'operations portal native recipient head insert denied'); END;

CREATE TRIGGER operations_portal_native_recipient_head_update_guard
BEFORE UPDATE ON operations_portal_native_recipient_authority_heads
WHEN NEW.recipient_binding_id IS NOT OLD.recipient_binding_id OR NEW.enrollment_intent_id IS NOT OLD.enrollment_intent_id
  OR NEW.target_id IS NOT OLD.target_id OR NEW.target_client_record_id IS NOT OLD.target_client_record_id
  OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.ownership_epoch<>OLD.ownership_epoch
  OR OLD.state<>'active' OR NEW.state<>'revoked' OR NEW.grant_revision<>OLD.grant_revision+1
  OR NEW.permission_schema_version<>3 OR NEW.permissions_json<>'[]' OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.creation_operation_id IS NOT OLD.creation_operation_id OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id
  OR NEW.created_access_subject IS NOT OLD.created_access_subject
  OR NEW.created_admission_version<>OLD.created_admission_version OR NEW.created_profile_version<>OLD.created_profile_version
  OR NEW.created_grant_generation<>OLD.created_grant_generation OR NEW.revoked_by_staff_id IS NULL
  OR NEW.revoked_operation_id IS NULL OR NEW.latest_operation_id IS NOT NEW.revoked_operation_id
  OR NOT EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
    WHERE command.operation_id=NEW.revoked_operation_id AND command.action='recipient.revoke'
      AND command.recipient_binding_id=OLD.recipient_binding_id AND command.enrollment_intent_id=OLD.enrollment_intent_id
      AND command.expected_ownership_epoch=OLD.ownership_epoch AND command.resulting_ownership_epoch=NEW.ownership_epoch
      AND command.expected_grant_revision=OLD.grant_revision AND command.resulting_grant_revision=NEW.grant_revision
      AND command.authorized_by_staff_id=NEW.revoked_by_staff_id)
BEGIN SELECT RAISE(ABORT,'operations portal native recipient head update denied'); END;

CREATE TRIGGER operations_portal_native_recipient_transition_guard
BEFORE UPDATE ON operations_portal_native_recipient_intents
WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.target_id IS NOT OLD.target_id OR NEW.target_revision<>OLD.target_revision
  OR NEW.target_client_record_id IS NOT OLD.target_client_record_id
  OR NEW.target_relationship_version<>OLD.target_relationship_version OR NEW.token_sha256 IS NOT OLD.token_sha256
  OR NEW.issued_by_staff_id IS NOT OLD.issued_by_staff_id OR NEW.issued_access_subject IS NOT OLD.issued_access_subject
  OR NEW.issued_email IS NOT OLD.issued_email OR NEW.issued_admission_version<>OLD.issued_admission_version
  OR NEW.issued_profile_version<>OLD.issued_profile_version OR NEW.issued_grant_generation<>OLD.issued_grant_generation
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<>OLD.revision+1
  OR NOT ((OLD.state='issued' AND NEW.state='pending' AND NEW.access_issuer IS NOT NULL AND NEW.access_subject IS NOT NULL
      AND NEW.recipient_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.recipient_binding_id IS NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_recipient_operations operation WHERE operation.intent_id=OLD.intent_id
        AND operation.action='redeem' AND operation.resulting_revision=NEW.revision))
    OR (OLD.state IN ('issued','pending') AND NEW.state='cancelled' AND NEW.recipient_binding_id IS NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_recipient_operations operation WHERE operation.intent_id=OLD.intent_id
        AND operation.action='cancel' AND operation.resulting_revision=NEW.revision))
    OR (OLD.state='pending' AND NEW.state='confirming' AND NEW.access_issuer IS OLD.access_issuer
      AND NEW.access_subject IS OLD.access_subject AND NEW.recipient_verified_until IS OLD.recipient_verified_until
      AND NEW.recipient_binding_id IS NOT NULL AND NEW.grant_operation_id IS NOT NULL AND NEW.revoke_operation_id IS NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
        WHERE command.operation_id=NEW.grant_operation_id AND command.enrollment_intent_id=OLD.intent_id
          AND command.action='recipient.grant'))
    OR (OLD.state='confirming' AND NEW.state='active' AND NEW.recipient_binding_id IS OLD.recipient_binding_id
      AND NEW.grant_operation_id IS OLD.grant_operation_id AND EXISTS(
        SELECT 1 FROM operations_portal_native_authority_finalizations finalization
        WHERE finalization.operation_id=OLD.grant_operation_id AND finalization.intent_id=OLD.intent_id
          AND finalization.prior_revision=OLD.revision AND finalization.resulting_revision=NEW.revision
          AND finalization.resulting_state='active'))
    OR (OLD.state='active' AND NEW.state='revoking' AND NEW.recipient_binding_id IS OLD.recipient_binding_id
      AND NEW.grant_operation_id IS OLD.grant_operation_id AND NEW.revoke_operation_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
        WHERE command.operation_id=NEW.revoke_operation_id AND command.enrollment_intent_id=OLD.intent_id
          AND command.action='recipient.revoke'))
    OR (OLD.state='revoking' AND NEW.state='revoked' AND NEW.recipient_binding_id IS OLD.recipient_binding_id
      AND NEW.grant_operation_id IS OLD.grant_operation_id AND NEW.revoke_operation_id IS OLD.revoke_operation_id
      AND EXISTS(SELECT 1 FROM operations_portal_native_authority_finalizations finalization
        WHERE finalization.operation_id=OLD.revoke_operation_id AND finalization.intent_id=OLD.intent_id
          AND finalization.prior_revision=OLD.revision AND finalization.resulting_revision=NEW.revision
          AND finalization.resulting_state='revoked')))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient transition denied'); END;

CREATE TRIGGER operations_portal_native_authority_outbox_guard
BEFORE INSERT ON operations_portal_native_authority_outbox
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
  WHERE command.operation_id=NEW.operation_id
    AND ((command.action='recipient.grant' AND NEW.publication_operation_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_receipts receipt
        WHERE receipt.operation_id=NEW.publication_operation_id AND receipt.publication_id=NEW.publication_id
          AND receipt.target_id=command.target_id AND receipt.resulting_revision=NEW.publication_revision
          AND receipt.source_sequence=NEW.publication_source_sequence AND receipt.snapshot_id=NEW.publication_snapshot_id
          AND receipt.snapshot_sha256=NEW.publication_snapshot_sha256))
      OR (command.action IN ('recipient.revoke','workspace.revoke')
        AND (NEW.publication_operation_id IS NULL OR EXISTS(
          SELECT 1 FROM operations_portal_workspace_publication_receipts receipt
          WHERE receipt.operation_id=NEW.publication_operation_id AND receipt.publication_id=NEW.publication_id
            AND receipt.target_id=command.target_id AND receipt.resulting_revision=NEW.publication_revision
            AND receipt.source_sequence=NEW.publication_source_sequence AND receipt.snapshot_id=NEW.publication_snapshot_id
            AND receipt.snapshot_sha256=NEW.publication_snapshot_sha256)))))
BEGIN SELECT RAISE(ABORT,'operations portal native authority wire materialization denied'); END;

CREATE TRIGGER operations_portal_native_authority_outbox_wire_immutable
BEFORE UPDATE ON operations_portal_native_authority_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.canonical_wire_json IS NOT OLD.canonical_wire_json
  OR NEW.publication_operation_id IS NOT OLD.publication_operation_id OR NEW.publication_id IS NOT OLD.publication_id
  OR NEW.publication_revision IS NOT OLD.publication_revision
  OR NEW.publication_source_sequence IS NOT OLD.publication_source_sequence
  OR NEW.publication_snapshot_id IS NOT OLD.publication_snapshot_id
  OR NEW.publication_snapshot_sha256 IS NOT OLD.publication_snapshot_sha256
BEGIN SELECT RAISE(ABORT,'operations portal native authority wire is immutable'); END;

CREATE TRIGGER operations_portal_native_authority_receipt_guard
BEFORE INSERT ON operations_portal_native_authority_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_authority_outbox outbox
  JOIN operations_portal_native_authority_commands command ON command.operation_id=outbox.operation_id
  WHERE outbox.operation_id=NEW.operation_id AND outbox.state='acknowledged'
    AND outbox.request_fingerprint=NEW.request_fingerprint AND command.target_id=NEW.target_id
    AND command.client_authority_id=NEW.client_authority_id AND command.workspace_id=NEW.workspace_id
    AND command.recipient_binding_id IS NEW.recipient_binding_id AND command.enrollment_intent_id IS NEW.enrollment_intent_id
    AND command.issuer IS NEW.issuer AND command.subject IS NEW.subject
    AND command.resulting_ownership_epoch=NEW.ownership_epoch
    AND command.resulting_grant_revision IS NEW.grant_revision
    AND NEW.resulting_state=CASE WHEN command.action='recipient.grant' THEN 'active' ELSE 'revoked' END
    AND command.permission_schema_version=NEW.permission_schema_version AND command.permissions_json=NEW.permissions_json)
BEGIN SELECT RAISE(ABORT,'operations portal native authority receipt is inconsistent'); END;

CREATE TRIGGER operations_portal_native_authority_finalization_guard
BEFORE INSERT ON operations_portal_native_authority_finalizations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_authority_receipts receipt
  JOIN operations_portal_native_authority_commands command ON command.operation_id=receipt.operation_id
  JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=NEW.intent_id
  WHERE receipt.operation_id=NEW.operation_id AND command.enrollment_intent_id=intent.intent_id
    AND intent.revision=NEW.prior_revision AND intent.state=NEW.prior_state
    AND NEW.resulting_revision=intent.revision+1
    AND ((command.action='recipient.grant' AND receipt.resulting_state='active'
        AND intent.state='confirming' AND intent.grant_operation_id=command.operation_id AND NEW.resulting_state='active')
      OR (command.action='recipient.revoke' AND receipt.resulting_state='revoked'
        AND intent.state='revoking' AND intent.revoke_operation_id=command.operation_id AND NEW.resulting_state='revoked')))
BEGIN SELECT RAISE(ABORT,'operations portal native authority finalization denied'); END;

CREATE TRIGGER operations_portal_native_workspace_finalize_guard
BEFORE UPDATE ON operations_portal_native_workspace_authority_heads
WHEN NEW.target_id IS NOT OLD.target_id OR NEW.target_revision<>OLD.target_revision
  OR NEW.client_authority_id IS NOT OLD.client_authority_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.root_kind IS NOT OLD.root_kind OR NEW.root_record_id IS NOT OLD.root_record_id
  OR NEW.ownership_epoch<>OLD.ownership_epoch OR NEW.creation_operation_id IS NOT OLD.creation_operation_id
  OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id OR NEW.created_access_subject IS NOT OLD.created_access_subject
  OR NEW.created_admission_version<>OLD.created_admission_version OR NEW.created_profile_version<>OLD.created_profile_version
  OR NEW.created_grant_generation<>OLD.created_grant_generation OR OLD.state<>'provisioning' OR NEW.state<>'active'
  OR NEW.latest_operation_id IS NOT OLD.latest_operation_id OR NEW.revoked_by_staff_id IS NOT OLD.revoked_by_staff_id
  OR NEW.revoked_operation_id IS NOT OLD.revoked_operation_id OR NOT EXISTS(
    SELECT 1 FROM operations_portal_native_authority_finalizations finalization
    WHERE finalization.operation_id=OLD.creation_operation_id AND finalization.resulting_state='active')
BEGIN SELECT RAISE(ABORT,'operations portal native workspace finalization denied'); END;

CREATE TRIGGER operations_portal_native_binding_revoke_guard
BEFORE UPDATE OF status ON client_onboarding_recipient_identity_bindings
WHEN EXISTS(SELECT 1 FROM operations_portal_native_recipient_authority_heads head
    WHERE head.recipient_binding_id=OLD.binding_id)
  AND (OLD.status<>'active' OR NEW.status<>'revoked' OR NOT EXISTS(
    SELECT 1 FROM operations_portal_native_recipient_authority_heads head
    JOIN operations_portal_native_authority_finalizations finalization ON finalization.intent_id=head.enrollment_intent_id
    WHERE head.recipient_binding_id=OLD.binding_id AND head.state='revoked' AND finalization.resulting_state='revoked'))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient binding revoke denied'); END;

CREATE TRIGGER operations_portal_workspace_revoke_native_authority_guard
BEFORE UPDATE OF state ON operations_portal_workspace_reservation_heads
WHEN NEW.state='revoked' AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads authority
  WHERE authority.target_id=OLD.target_id AND authority.state<>'revoked')
BEGIN SELECT RAISE(ABORT,'active native portal authority blocks workspace revoke'); END;

CREATE TRIGGER operations_portal_native_operations_no_update BEFORE UPDATE ON operations_portal_native_recipient_operations
BEGIN SELECT RAISE(ABORT,'operations portal native recipient operations are immutable'); END;
CREATE TRIGGER operations_portal_native_operations_no_delete BEFORE DELETE ON operations_portal_native_recipient_operations
BEGIN SELECT RAISE(ABORT,'operations portal native recipient operations are durable'); END;
CREATE TRIGGER operations_portal_native_operation_commits_no_update BEFORE UPDATE ON operations_portal_native_recipient_operation_commits
BEGIN SELECT RAISE(ABORT,'operations portal native recipient commits are immutable'); END;
CREATE TRIGGER operations_portal_native_operation_commits_no_delete BEFORE DELETE ON operations_portal_native_recipient_operation_commits
BEGIN SELECT RAISE(ABORT,'operations portal native recipient commits are durable'); END;
CREATE TRIGGER operations_portal_native_commands_no_update BEFORE UPDATE ON operations_portal_native_authority_commands
BEGIN SELECT RAISE(ABORT,'operations portal native authority commands are immutable'); END;
CREATE TRIGGER operations_portal_native_commands_no_delete BEFORE DELETE ON operations_portal_native_authority_commands
BEGIN SELECT RAISE(ABORT,'operations portal native authority commands are durable'); END;
CREATE TRIGGER operations_portal_native_intents_no_delete BEFORE DELETE ON operations_portal_native_recipient_intents
BEGIN SELECT RAISE(ABORT,'operations portal native recipient intents are durable'); END;
CREATE TRIGGER operations_portal_native_workspace_heads_no_delete BEFORE DELETE ON operations_portal_native_workspace_authority_heads
BEGIN SELECT RAISE(ABORT,'operations portal native workspace heads are durable'); END;
CREATE TRIGGER operations_portal_native_recipient_heads_no_delete BEFORE DELETE ON operations_portal_native_recipient_authority_heads
BEGIN SELECT RAISE(ABORT,'operations portal native recipient heads are durable'); END;
CREATE TRIGGER operations_portal_native_outbox_no_delete BEFORE DELETE ON operations_portal_native_authority_outbox
BEGIN SELECT RAISE(ABORT,'operations portal native authority outbox is durable'); END;
CREATE TRIGGER operations_portal_native_receipts_no_update BEFORE UPDATE ON operations_portal_native_authority_receipts
BEGIN SELECT RAISE(ABORT,'operations portal native authority receipts are immutable'); END;
CREATE TRIGGER operations_portal_native_receipts_no_delete BEFORE DELETE ON operations_portal_native_authority_receipts
BEGIN SELECT RAISE(ABORT,'operations portal native authority receipts are durable'); END;
CREATE TRIGGER operations_portal_native_finalizations_no_update BEFORE UPDATE ON operations_portal_native_authority_finalizations
BEGIN SELECT RAISE(ABORT,'operations portal native authority finalizations are immutable'); END;
CREATE TRIGGER operations_portal_native_finalizations_no_delete BEFORE DELETE ON operations_portal_native_authority_finalizations
BEGIN SELECT RAISE(ABORT,'operations portal native authority finalizations are durable'); END;
