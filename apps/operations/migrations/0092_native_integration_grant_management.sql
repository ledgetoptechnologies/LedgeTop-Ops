-- Dedicated native integration-grant administrators. No authority is seeded.
CREATE TABLE native_integration_management_grants (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK(capability='integrations.grants.manage'),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind='global'),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(actor_staff_id,capability,effect)
);
CREATE TABLE native_integration_management_grant_history (
  id TEXT NOT NULL, version INTEGER NOT NULL,
  actor_staff_id TEXT NOT NULL, capability TEXT NOT NULL, effect TEXT NOT NULL,
  scope_kind TEXT NOT NULL, active INTEGER NOT NULL, granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(id,version),
  FOREIGN KEY(id) REFERENCES native_integration_management_grants(id) ON DELETE RESTRICT
);
CREATE TRIGGER native_integration_management_grants_insert_history
AFTER INSERT ON native_integration_management_grants
BEGIN INSERT INTO native_integration_management_grant_history
  (id,version,actor_staff_id,capability,effect,scope_kind,active,granted_by,created_at,updated_at)
  VALUES(NEW.id,NEW.version,NEW.actor_staff_id,NEW.capability,NEW.effect,NEW.scope_kind,
    NEW.active,NEW.granted_by,NEW.created_at,NEW.updated_at); END;
CREATE TRIGGER native_integration_management_grants_update_guard
BEFORE UPDATE ON native_integration_management_grants
WHEN NEW.id IS NOT OLD.id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id
  OR NEW.capability IS NOT OLD.capability OR NEW.effect IS NOT OLD.effect
  OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
  OR NEW.active IS OLD.active
BEGIN SELECT RAISE(ABORT,'integration management grant update denied'); END;
CREATE TRIGGER native_integration_management_grants_update_history
AFTER UPDATE ON native_integration_management_grants
BEGIN INSERT INTO native_integration_management_grant_history
  (id,version,actor_staff_id,capability,effect,scope_kind,active,granted_by,created_at,updated_at)
  VALUES(NEW.id,NEW.version,NEW.actor_staff_id,NEW.capability,NEW.effect,NEW.scope_kind,
    NEW.active,NEW.granted_by,NEW.created_at,NEW.updated_at); END;
CREATE TRIGGER native_integration_management_grants_no_delete
BEFORE DELETE ON native_integration_management_grants
BEGIN SELECT RAISE(ABORT,'integration management grant deletion denied'); END;
CREATE TRIGGER native_integration_management_grant_history_insert_guard
BEFORE INSERT ON native_integration_management_grant_history
WHEN NOT EXISTS(SELECT 1 FROM native_integration_management_grants g
  WHERE g.id=NEW.id AND g.version=NEW.version AND g.actor_staff_id=NEW.actor_staff_id
    AND g.capability=NEW.capability AND g.effect=NEW.effect AND g.scope_kind=NEW.scope_kind
    AND g.active=NEW.active AND g.granted_by=NEW.granted_by
    AND g.created_at=NEW.created_at AND g.updated_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'integration management grant history denied'); END;
CREATE TRIGGER native_integration_management_grant_history_no_update
BEFORE UPDATE ON native_integration_management_grant_history
BEGIN SELECT RAISE(ABORT,'integration management grant history update denied'); END;
CREATE TRIGGER native_integration_management_grant_history_no_delete
BEFORE DELETE ON native_integration_management_grant_history
BEGIN SELECT RAISE(ABORT,'integration management grant history deletion denied'); END;

-- A fence is inserted immediately before the target grant mutation in one
-- D1 batch. The immutable receipt proves the exact committed result.
CREATE TABLE native_integration_grant_command_fences (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  actor_staff_id TEXT NOT NULL, actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL, actor_profile_version INTEGER NOT NULL,
  actor_email TEXT NOT NULL, verified_until TEXT NOT NULL,
  manager_allow_id TEXT NOT NULL, manager_allow_version INTEGER NOT NULL,
  target_staff_id TEXT NOT NULL, target_access_subject TEXT NOT NULL,
  target_admission_version INTEGER NOT NULL,
  grant_id TEXT NOT NULL, capability TEXT NOT NULL, effect TEXT NOT NULL,
  expected_version INTEGER NOT NULL, result_version INTEGER NOT NULL,
  active INTEGER NOT NULL, reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_integration_grant_command_fence_guard
BEFORE INSERT ON native_integration_grant_command_fences
WHEN NEW.result_version<>NEW.expected_version+1
  OR NEW.verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions actor
    JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
    WHERE actor.staff_id=NEW.actor_staff_id AND actor.active=1
      AND actor.bound_access_subject=NEW.actor_access_subject
      AND actor.version=NEW.actor_admission_version
      AND profile.version=NEW.actor_profile_version AND profile.login_email=NEW.actor_email)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions target
    WHERE target.staff_id=NEW.target_staff_id AND target.version=NEW.target_admission_version
      AND target.bound_access_subject=NEW.target_access_subject
      AND (NEW.active=0 OR target.active=1))
  OR NOT EXISTS(SELECT 1 FROM native_integration_management_grants allow_row
    WHERE allow_row.id=NEW.manager_allow_id AND allow_row.version=NEW.manager_allow_version
      AND allow_row.actor_staff_id=NEW.actor_staff_id
      AND allow_row.capability='integrations.grants.manage'
      AND allow_row.effect='allow' AND allow_row.scope_kind='global' AND allow_row.active=1)
  OR EXISTS(SELECT 1 FROM native_integration_management_grants deny_row
    WHERE deny_row.actor_staff_id=NEW.actor_staff_id
      AND deny_row.capability='integrations.grants.manage'
      AND deny_row.effect='deny' AND deny_row.scope_kind='global' AND deny_row.active=1)
  OR (NEW.expected_version=0 AND (NEW.active<>1 OR EXISTS(
    SELECT 1 FROM native_integration_control_grants existing
    WHERE existing.actor_staff_id=NEW.target_staff_id
      AND existing.capability=NEW.capability AND existing.effect=NEW.effect)))
  OR (NEW.expected_version>0 AND NOT EXISTS(
    SELECT 1 FROM native_integration_control_grants existing
    WHERE existing.id=NEW.grant_id AND existing.actor_staff_id=NEW.target_staff_id
      AND existing.capability=NEW.capability AND existing.effect=NEW.effect
      AND existing.scope_kind='global' AND existing.version=NEW.expected_version
      AND existing.active<>NEW.active))
BEGIN SELECT RAISE(ABORT,'integration grant command fence denied'); END;
CREATE TRIGGER native_integration_grant_command_fence_no_update
BEFORE UPDATE ON native_integration_grant_command_fences
BEGIN SELECT RAISE(ABORT,'integration grant command fence update denied'); END;
CREATE TRIGGER native_integration_grant_command_fence_no_delete
BEFORE DELETE ON native_integration_grant_command_fences
BEGIN SELECT RAISE(ABORT,'integration grant command fence deletion denied'); END;

CREATE TABLE native_integration_grant_commands (
  command_id TEXT PRIMARY KEY REFERENCES native_integration_grant_command_fences(command_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL, actor_staff_id TEXT NOT NULL,
  actor_access_subject TEXT NOT NULL, actor_admission_version INTEGER NOT NULL,
  actor_profile_version INTEGER NOT NULL, actor_email TEXT NOT NULL,
  target_staff_id TEXT NOT NULL, target_access_subject TEXT NOT NULL,
  target_admission_version INTEGER NOT NULL, manager_allow_id TEXT NOT NULL,
  manager_allow_version INTEGER NOT NULL, grant_id TEXT NOT NULL,
  capability TEXT NOT NULL, effect TEXT NOT NULL,
  expected_version INTEGER NOT NULL, result_version INTEGER NOT NULL,
  active INTEGER NOT NULL, reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_integration_grant_command_receipt_guard
BEFORE INSERT ON native_integration_grant_commands
-- This is the first statement in the trigger. SQLite therefore exposes the
-- row count from the immediately preceding grant INSERT/UPDATE through
-- changes(). A zero-row CAS must abort the whole D1 batch, including its
-- fence, rather than leave an unacknowledgeable command behind.
WHEN changes()<>1 OR NOT EXISTS(SELECT 1 FROM native_integration_grant_command_fences f
  JOIN native_integration_control_grants grant_row ON grant_row.id=f.grant_id
  WHERE f.command_id=NEW.command_id AND f.request_sha256=NEW.request_sha256
    AND f.actor_staff_id=NEW.actor_staff_id AND f.actor_access_subject=NEW.actor_access_subject
    AND f.actor_admission_version=NEW.actor_admission_version
    AND f.actor_profile_version=NEW.actor_profile_version AND f.actor_email=NEW.actor_email
    AND f.target_staff_id=NEW.target_staff_id AND f.target_access_subject=NEW.target_access_subject
    AND f.target_admission_version=NEW.target_admission_version
    AND f.manager_allow_id=NEW.manager_allow_id AND f.manager_allow_version=NEW.manager_allow_version
    AND f.grant_id=NEW.grant_id AND f.capability=NEW.capability AND f.effect=NEW.effect
    AND f.expected_version=NEW.expected_version AND f.result_version=NEW.result_version
    AND f.active=NEW.active AND f.reason=NEW.reason
    AND grant_row.actor_staff_id=NEW.target_staff_id AND grant_row.capability=NEW.capability
    AND grant_row.effect=NEW.effect AND grant_row.scope_kind='global'
    AND grant_row.version=NEW.result_version AND grant_row.active=NEW.active)
BEGIN SELECT RAISE(ABORT,'integration grant command receipt denied'); END;
CREATE TRIGGER native_integration_grant_commands_no_update
BEFORE UPDATE ON native_integration_grant_commands
BEGIN SELECT RAISE(ABORT,'integration grant command receipt update denied'); END;
CREATE TRIGGER native_integration_grant_commands_no_delete
BEFORE DELETE ON native_integration_grant_commands
BEGIN SELECT RAISE(ABORT,'integration grant command receipt deletion denied'); END;
