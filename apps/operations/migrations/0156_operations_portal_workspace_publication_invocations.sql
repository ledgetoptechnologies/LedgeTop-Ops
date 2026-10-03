PRAGMA foreign_keys = ON;

-- A human authorization is a durable, one-use handoff to a private Worker
-- drain. It never grants portal/file access and cannot change the immutable
-- publication command that it names.
CREATE TABLE operations_portal_workspace_publication_invocations (
  invocation_id TEXT PRIMARY KEY CHECK(length(invocation_id)=36 AND lower(invocation_id)=invocation_id
    AND invocation_id NOT GLOB '*[^0-9a-f-]*' AND substr(invocation_id,9,1)='-'
    AND substr(invocation_id,14,1)='-' AND substr(invocation_id,15,1)='4'
    AND substr(invocation_id,19,1)='-' AND substr(invocation_id,20,1) GLOB '[89ab]'
    AND substr(invocation_id,24,1)='-'),
  operation_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_commands(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('publish','recover','cancel')),
  operation_fingerprint TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  invoked_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  invoked_access_subject TEXT NOT NULL,
  invoked_email TEXT NOT NULL,
  invoked_admission_version INTEGER NOT NULL CHECK(invoked_admission_version>=1),
  invoked_profile_version INTEGER NOT NULL CHECK(invoked_profile_version>=1),
  invoked_grant_generation INTEGER NOT NULL CHECK(invoked_grant_generation>=1),
  invoked_verified_until TEXT NOT NULL CHECK(length(invoked_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',invoked_verified_until) IS invoked_verified_until),
  reason TEXT NOT NULL CHECK(length(reason)<=500 AND length(trim(reason)) BETWEEN 1 AND 500 AND instr(reason,char(0))=0),
  state TEXT NOT NULL DEFAULT 'authorized' CHECK(state IN ('authorized','claimed')),
  claim_token TEXT UNIQUE,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(operation_id,invocation_id),
  CHECK((state='authorized' AND claim_token IS NULL AND claimed_at IS NULL)
    OR (state='claimed' AND length(claim_token)=36 AND lower(claim_token)=claim_token
      AND claim_token NOT GLOB '*[^0-9a-f-]*' AND substr(claim_token,9,1)='-'
      AND substr(claim_token,14,1)='-' AND substr(claim_token,15,1)='4'
      AND substr(claim_token,19,1)='-' AND substr(claim_token,20,1) GLOB '[89ab]'
      AND substr(claim_token,24,1)='-' AND claimed_at IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at) IS claimed_at))
);

CREATE TABLE operations_portal_workspace_publication_invocation_audit (
  invocation_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_publication_invocations(invocation_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL,
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL,
  root_record_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  invoked_by_staff_id TEXT NOT NULL,
  invoked_access_subject TEXT NOT NULL,
  invoked_email TEXT NOT NULL,
  invoked_admission_version INTEGER NOT NULL,
  invoked_profile_version INTEGER NOT NULL,
  invoked_grant_generation INTEGER NOT NULL,
  invoked_verified_until TEXT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_workspace_publication_invocation_insert_guard BEFORE INSERT
ON operations_portal_workspace_publication_invocations
WHEN NEW.state<>'authorized' OR NEW.claim_token IS NOT NULL OR NEW.claimed_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_commands command
    WHERE command.operation_id=NEW.operation_id
      AND command.operation_fingerprint=NEW.operation_fingerprint AND command.target_id=NEW.target_id
      AND command.target_revision=NEW.target_revision AND command.client_authority_id=NEW.client_authority_id
      AND command.workspace_id=NEW.workspace_id AND command.root_kind=NEW.root_kind
      AND command.root_record_id=NEW.root_record_id AND command.snapshot_id=NEW.snapshot_id
      AND command.checkpoint_id=NEW.checkpoint_id AND command.snapshot_sha256=NEW.snapshot_sha256)
 OR NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=NEW.invoked_by_staff_id AND admission.active=1
      AND admission.bound_access_subject=NEW.invoked_access_subject AND admission.version=NEW.invoked_admission_version
      AND profile.login_email=NEW.invoked_email AND profile.version=NEW.invoked_profile_version
      AND generation.generation=NEW.invoked_grant_generation
      AND NEW.invoked_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR NOT EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=NEW.invoked_by_staff_id
      AND role.role_id='role-owner' AND role.scope='global')
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
      WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.record_id=NEW.root_record_id
        AND permission.effect='allow')
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
      WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.record_id=NEW.root_record_id
        AND permission.effect='deny')
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
      WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.permission_key='projects.view'
        AND permission.effect='allow' AND permission.scope='global')
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
      WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.permission_key='projects.view'
        AND permission.effect='deny' AND permission.scope='global')
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_publication_folder_sources folder
      WHERE folder.checkpoint_id=NEW.checkpoint_id AND ((SELECT count(DISTINCT permission.permission_key)
        FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='allow'
          AND permission.permission_key IN ('projects.view','delivery.browse')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=folder.division_id)))<>2
        OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='deny'
            AND permission.permission_key IN ('projects.view','delivery.browse')
            AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=folder.division_id)))))
 OR (NEW.action='publish' AND (NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
      WHERE current.checkpoint_id=NEW.checkpoint_id)
    OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
      WHERE live.operation_id=NEW.operation_id)))
 OR (NEW.action IN ('recover','cancel') AND NOT EXISTS(
      SELECT 1 FROM operations_portal_workspace_publication_outbox outbox
      WHERE outbox.operation_id=NEW.operation_id AND outbox.remote_attempted=1
        AND outbox.state IN ('retry','dispatching')))
BEGIN SELECT RAISE(ABORT,'publication invocation identity is not current'); END;

CREATE TRIGGER operations_portal_workspace_publication_invocation_claim_guard BEFORE UPDATE
ON operations_portal_workspace_publication_invocations
WHEN OLD.state<>'authorized' OR NEW.state<>'claimed' OR OLD.operation_id<>NEW.operation_id OR OLD.action<>NEW.action
 OR OLD.operation_fingerprint<>NEW.operation_fingerprint OR OLD.target_id<>NEW.target_id
 OR OLD.target_revision<>NEW.target_revision OR OLD.client_authority_id<>NEW.client_authority_id
 OR OLD.workspace_id<>NEW.workspace_id OR OLD.root_kind<>NEW.root_kind OR OLD.root_record_id<>NEW.root_record_id
 OR OLD.snapshot_id<>NEW.snapshot_id OR OLD.checkpoint_id<>NEW.checkpoint_id OR OLD.snapshot_sha256<>NEW.snapshot_sha256
 OR OLD.invoked_by_staff_id<>NEW.invoked_by_staff_id OR OLD.invoked_access_subject<>NEW.invoked_access_subject
 OR OLD.invoked_email<>NEW.invoked_email OR OLD.invoked_admission_version<>NEW.invoked_admission_version
 OR OLD.invoked_profile_version<>NEW.invoked_profile_version OR OLD.invoked_grant_generation<>NEW.invoked_grant_generation
 OR OLD.invoked_verified_until<>NEW.invoked_verified_until OR OLD.reason<>NEW.reason OR OLD.created_at<>NEW.created_at
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_outbox outbox
      WHERE outbox.operation_id=NEW.operation_id AND outbox.state='dispatching' AND outbox.claim_token=NEW.claim_token)
 OR NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=NEW.invoked_by_staff_id AND admission.active=1
      AND admission.bound_access_subject=NEW.invoked_access_subject AND admission.version=NEW.invoked_admission_version
      AND profile.login_email=NEW.invoked_email AND profile.version=NEW.invoked_profile_version
      AND generation.generation=NEW.invoked_grant_generation
      AND NEW.invoked_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR NOT EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=NEW.invoked_by_staff_id
      AND role.role_id='role-owner' AND role.scope='global')
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
      WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.record_id=NEW.root_record_id
        AND permission.effect='allow')
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
      WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.record_id=NEW.root_record_id
        AND permission.effect='deny')
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
      WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.permission_key='projects.view'
        AND permission.effect='allow' AND permission.scope='global')
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
      WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.permission_key='projects.view'
        AND permission.effect='deny' AND permission.scope='global')
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_publication_folder_sources folder
      WHERE folder.checkpoint_id=NEW.checkpoint_id AND ((SELECT count(DISTINCT permission.permission_key)
        FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='allow'
          AND permission.permission_key IN ('projects.view','delivery.browse')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=folder.division_id)))<>2
        OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='deny'
            AND permission.permission_key IN ('projects.view','delivery.browse')
            AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=folder.division_id)))))
 OR (NEW.action='publish' AND (NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
      WHERE current.checkpoint_id=NEW.checkpoint_id)
    OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
      WHERE live.operation_id=NEW.operation_id)))
BEGIN SELECT RAISE(ABORT,'publication invocation claim denied'); END;

CREATE TRIGGER operations_portal_workspace_publication_invocation_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_invocations
BEGIN SELECT RAISE(ABORT,'publication invocations are durable'); END;

CREATE TRIGGER operations_portal_workspace_publication_invocation_audit_guard BEFORE INSERT
ON operations_portal_workspace_publication_invocation_audit
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_invocations invocation
    JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=invocation.operation_id
    WHERE invocation.invocation_id=NEW.invocation_id AND invocation.state='claimed'
      AND invocation.operation_id=NEW.operation_id AND invocation.action=NEW.action
      AND invocation.operation_fingerprint=NEW.operation_fingerprint AND invocation.target_id=NEW.target_id
      AND invocation.target_revision=NEW.target_revision AND invocation.client_authority_id=NEW.client_authority_id
      AND invocation.workspace_id=NEW.workspace_id AND invocation.root_kind=NEW.root_kind
      AND invocation.root_record_id=NEW.root_record_id AND invocation.snapshot_id=NEW.snapshot_id
      AND invocation.checkpoint_id=NEW.checkpoint_id AND invocation.snapshot_sha256=NEW.snapshot_sha256
      AND invocation.invoked_by_staff_id=NEW.invoked_by_staff_id
      AND invocation.invoked_access_subject=NEW.invoked_access_subject AND invocation.invoked_email=NEW.invoked_email
      AND invocation.invoked_admission_version=NEW.invoked_admission_version
      AND invocation.invoked_profile_version=NEW.invoked_profile_version
      AND invocation.invoked_grant_generation=NEW.invoked_grant_generation
      AND invocation.invoked_verified_until=NEW.invoked_verified_until
      AND invocation.claim_token=NEW.claim_token AND invocation.claimed_at=NEW.claimed_at
      AND outbox.state='dispatching' AND outbox.claim_token=NEW.claim_token)
BEGIN SELECT RAISE(ABORT,'publication invocation audit is not exact'); END;

CREATE TRIGGER operations_portal_workspace_publication_invocation_audit_no_update BEFORE UPDATE
ON operations_portal_workspace_publication_invocation_audit
BEGIN SELECT RAISE(ABORT,'publication invocation audit is immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_invocation_audit_no_delete BEFORE DELETE
ON operations_portal_workspace_publication_invocation_audit
BEGIN SELECT RAISE(ABORT,'publication invocation audit is durable'); END;
