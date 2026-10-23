PRAGMA foreign_keys = ON;

-- Disabled until a separately reviewed native staff identity/cohort transfer.
-- No application route can enable this control or install bootstrap authority.
CREATE TABLE native_staff_access_reconciliation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740990),
  applied_generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(applied_generation)='integer' AND applied_generation BETWEEN 0 AND generation),
  lease_id TEXT,
  lease_until TEXT,
  attempt_generation INTEGER CHECK(attempt_generation IS NULL OR (typeof(attempt_generation)='integer' AND attempt_generation BETWEEN 0 AND generation)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts>=0),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT CHECK(last_error IS NULL OR length(last_error)<=500),
  CHECK((lease_id IS NULL AND lease_until IS NULL AND attempt_generation IS NULL)
    OR (length(lease_id) BETWEEN 1 AND 191 AND julianday(lease_until) IS NOT NULL AND attempt_generation IS NOT NULL))
);
INSERT INTO native_staff_access_reconciliation(singleton) VALUES(1);

-- 0068's original control-plane definition predates enable/profile HTTP
-- management. A usable survivor must also be able to read, edit and re-enable
-- staff through the supported lifecycle surface. No delegation is synthesized.
CREATE VIEW native_staff_lifecycle_control_plane_candidates AS
WITH lifecycle_actions(capability) AS (VALUES ('staff.profile.read'),('staff.profile.edit'),('staff.admission.enable'))
SELECT candidate.staff_id,candidate.bound_access_subject,candidate.admission_version,candidate.profile_version
FROM native_staff_control_plane_candidates candidate
JOIN native_staff_profiles p ON p.staff_id=candidate.staff_id
JOIN staff_users s ON s.id=candidate.staff_id
WHERE s.status='active' AND s.access_subject=candidate.bound_access_subject AND s.email=p.login_email COLLATE BINARY
  AND NOT EXISTS(SELECT 1 FROM lifecycle_actions required WHERE NOT EXISTS(
    SELECT 1 FROM native_staff_management_delegations d WHERE d.actor_staff_id=candidate.staff_id
      AND d.contract_version=1 AND d.capability=required.capability AND d.effect='allow' AND d.active=1 AND d.scope_kind='global'))
  AND NOT EXISTS(SELECT 1 FROM lifecycle_actions required JOIN native_staff_management_delegations d
    ON d.actor_staff_id=candidate.staff_id AND d.contract_version=1 AND d.capability=required.capability AND d.effect='deny' AND d.active=1);

-- This is an additional compatibility fence, not a replacement for 0069's
-- current scoped delegation/deny checks or last-control-plane guard.
CREATE TABLE native_staff_lifecycle_fences (
  command_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL CHECK(capability IN ('staff.profile.edit','staff.admission.disable','staff.admission.enable')),
  actor_staff_id TEXT NOT NULL,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(typeof(actor_profile_version)='integer' AND actor_profile_version>=1),
  verified_until_ms INTEGER NOT NULL CHECK(typeof(verified_until_ms)='integer'),
  target_staff_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  bridge_writes INTEGER NOT NULL DEFAULT 1 CHECK(bridge_writes IN (0,1))
);
CREATE UNIQUE INDEX native_staff_lifecycle_one_target ON native_staff_lifecycle_fences(target_staff_id);

CREATE TRIGGER native_staff_lifecycle_fence_insert BEFORE INSERT ON native_staff_lifecycle_fences
WHEN NEW.bridge_writes<>1
  OR NEW.verified_until_ms<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  OR NOT EXISTS(SELECT 1 FROM native_staff_access_reconciliation WHERE singleton=1 AND enabled=1)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id
    JOIN staff_users s ON s.id=a.staff_id WHERE a.staff_id=NEW.actor_staff_id AND a.active=1
      AND a.bound_access_subject=NEW.actor_access_subject AND a.version=NEW.actor_admission_version
      AND p.version=NEW.actor_profile_version AND p.login_email=s.email COLLATE BINARY
      AND s.access_subject=a.bound_access_subject AND s.status='active')
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id
    JOIN staff_users s ON s.id=a.staff_id WHERE a.staff_id=NEW.target_staff_id
      AND p.login_email=s.email COLLATE BINARY AND s.access_subject=a.bound_access_subject
      AND s.status=CASE a.active WHEN 1 THEN 'active' ELSE 'inactive' END
      AND s.sync_protected=0 AND s.id<>'staff-beau-koltz'
      AND NOT EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=s.id AND r.role_id='role-owner' AND r.scope='global')
      AND NOT EXISTS(SELECT 1 FROM local_staff_role_assignments r WHERE r.staff_id=s.id AND r.role_id='role-owner' AND r.scope='global')
      AND ((NEW.capability='staff.profile.edit' AND p.version=NEW.expected_version)
        OR (NEW.capability='staff.admission.disable' AND a.active=1 AND a.version=NEW.expected_version)
        OR (NEW.capability='staff.admission.enable' AND a.active=0 AND a.version=NEW.expected_version)))
BEGIN SELECT RAISE(ABORT,'native staff lifecycle bridge prestate changed'); END;

CREATE TRIGGER native_staff_lifecycle_fence_update BEFORE UPDATE ON native_staff_lifecycle_fences
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.capability IS NOT OLD.capability
  OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject
  OR NEW.actor_admission_version IS NOT OLD.actor_admission_version OR NEW.actor_profile_version IS NOT OLD.actor_profile_version
  OR NEW.verified_until_ms IS NOT OLD.verified_until_ms OR NEW.target_staff_id IS NOT OLD.target_staff_id
  OR NEW.expected_version IS NOT OLD.expected_version OR OLD.bridge_writes<>1 OR NEW.bridge_writes<>0
BEGIN SELECT RAISE(ABORT,'native staff lifecycle bridge fence is immutable'); END;

CREATE TRIGGER native_staff_lifecycle_bridge_consume AFTER UPDATE ON staff_users
WHEN EXISTS(SELECT 1 FROM native_staff_lifecycle_fences f JOIN native_staff_admissions a ON a.staff_id=f.target_staff_id
  JOIN native_staff_profiles p ON p.staff_id=a.staff_id WHERE f.target_staff_id=NEW.id AND f.bridge_writes=1
    AND NEW.id IS OLD.id AND NEW.email IS OLD.email AND NEW.access_subject IS OLD.access_subject
    AND NEW.project_alpha_user_id IS OLD.project_alpha_user_id AND NEW.sync_protected IS OLD.sync_protected
    AND NEW.provisioning_source IS OLD.provisioning_source AND NEW.created_at IS OLD.created_at
    AND NEW.last_seen_at IS OLD.last_seen_at AND NEW.email=p.login_email COLLATE BINARY
    AND NEW.access_subject=a.bound_access_subject
    AND ((f.capability='staff.profile.edit' AND p.version=f.expected_version+1 AND NEW.display_name=p.display_name AND NEW.status IS OLD.status)
      OR (f.capability='staff.admission.disable' AND a.version=f.expected_version+1 AND a.active=0 AND OLD.status='active' AND NEW.status='inactive' AND NEW.display_name IS OLD.display_name)
      OR (f.capability='staff.admission.enable' AND a.version=f.expected_version+1 AND a.active=1 AND OLD.status='inactive' AND NEW.status='active' AND NEW.display_name IS OLD.display_name)))
BEGIN UPDATE native_staff_lifecycle_fences SET bridge_writes=0 WHERE target_staff_id=NEW.id AND bridge_writes=1; END;

CREATE TABLE native_staff_access_reconciliation_events (
  command_id TEXT PRIMARY KEY REFERENCES native_staff_management_commands(command_id) ON DELETE RESTRICT,
  staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  admission_version INTEGER NOT NULL CHECK(typeof(admission_version)='integer' AND admission_version>=1),
  desired_active INTEGER NOT NULL CHECK(desired_active IN (0,1)),
  generation INTEGER NOT NULL UNIQUE CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740990),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_staff_access_reconciliation_event_insert BEFORE INSERT ON native_staff_access_reconciliation_events
WHEN NOT EXISTS(SELECT 1 FROM native_staff_access_reconciliation state
    JOIN native_staff_lifecycle_fences f ON f.command_id=NEW.command_id AND f.bridge_writes=0
    JOIN native_staff_management_commands c ON c.command_id=f.command_id AND c.target_staff_id=NEW.staff_id
    JOIN native_staff_admissions a ON a.staff_id=c.target_staff_id
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
    WHERE state.singleton=1 AND state.enabled=1 AND NEW.generation=state.generation+1
      AND a.version=NEW.admission_version AND a.active=NEW.desired_active
      AND c.result_version=a.version AND c.capability=CASE a.active WHEN 1 THEN 'staff.admission.enable' ELSE 'staff.admission.disable' END
      AND s.email=p.login_email COLLATE BINARY AND s.access_subject=a.bound_access_subject
      AND s.status=CASE a.active WHEN 1 THEN 'active' ELSE 'inactive' END)
BEGIN SELECT RAISE(ABORT,'native staff reconciliation event is invalid'); END;
CREATE TRIGGER native_staff_access_reconciliation_event_generation AFTER INSERT ON native_staff_access_reconciliation_events
BEGIN UPDATE native_staff_access_reconciliation SET generation=NEW.generation WHERE singleton=1; END;
CREATE TRIGGER native_staff_access_reconciliation_event_no_update BEFORE UPDATE ON native_staff_access_reconciliation_events
BEGIN SELECT RAISE(ABORT,'native staff reconciliation event is immutable'); END;
CREATE TRIGGER native_staff_access_reconciliation_event_no_delete BEFORE DELETE ON native_staff_access_reconciliation_events
BEGIN SELECT RAISE(ABORT,'native staff reconciliation event is durable'); END;

CREATE TRIGGER native_staff_lifecycle_fence_close BEFORE DELETE ON native_staff_lifecycle_fences
WHEN OLD.bridge_writes<>0
  OR OLD.verified_until_ms<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  OR NOT EXISTS(SELECT 1 FROM native_staff_management_commands c WHERE c.command_id=OLD.command_id
    AND c.target_staff_id=OLD.target_staff_id AND c.actor_staff_id=OLD.actor_staff_id
    AND c.capability=OLD.capability AND c.result_version=OLD.expected_version+1)
  OR (OLD.capability<>'staff.profile.edit' AND NOT EXISTS(SELECT 1 FROM native_staff_access_reconciliation_events e
    WHERE e.command_id=OLD.command_id AND e.staff_id=OLD.target_staff_id AND e.admission_version=OLD.expected_version+1))
  OR (OLD.capability='staff.admission.disable' AND NOT EXISTS(SELECT 1 FROM native_staff_lifecycle_control_plane_candidates))
BEGIN SELECT RAISE(ABORT,'native staff lifecycle bridge did not finish'); END;
