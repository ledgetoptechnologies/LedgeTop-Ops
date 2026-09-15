PRAGMA foreign_keys = ON;

ALTER TABLE native_staff_admissions ADD COLUMN version INTEGER NOT NULL DEFAULT 1
  CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991);

DROP TRIGGER native_staff_admissions_identity;
CREATE TRIGGER native_staff_admissions_identity BEFORE UPDATE ON native_staff_admissions
WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native admission update is invalid'); END;

CREATE TABLE native_staff_target_memberships (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('business_area','division')),
  business_area_id TEXT NOT NULL REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  created_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((scope_kind='business_area' AND division_id IS NULL) OR (scope_kind='division' AND division_id IS NOT NULL)),
  FOREIGN KEY(business_area_id,division_id) REFERENCES native_business_divisions(business_area_id,id) ON DELETE RESTRICT,
  UNIQUE(staff_id,scope_kind,business_area_id,division_id)
);
CREATE UNIQUE INDEX native_staff_target_membership_identity ON native_staff_target_memberships
  (staff_id,scope_kind,business_area_id,ifnull(division_id,''));
CREATE TRIGGER native_staff_target_memberships_update_guard BEFORE UPDATE ON native_staff_target_memberships
WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.scope_kind IS NOT OLD.scope_kind
  OR NEW.business_area_id IS NOT OLD.business_area_id OR NEW.division_id IS NOT OLD.division_id
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native staff target membership update is invalid'); END;

CREATE TABLE native_staff_admin_delegations (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('staff.profile.edit','staff.admission.disable')),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','business_area','division','exact_staff')),
  business_area_id TEXT REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  target_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((scope_kind='global' AND business_area_id IS NULL AND division_id IS NULL AND target_staff_id IS NULL)
    OR (scope_kind='business_area' AND business_area_id IS NOT NULL AND division_id IS NULL AND target_staff_id IS NULL)
    OR (scope_kind='division' AND business_area_id IS NOT NULL AND division_id IS NOT NULL AND target_staff_id IS NULL)
    OR (scope_kind='exact_staff' AND business_area_id IS NULL AND division_id IS NULL AND target_staff_id IS NOT NULL)),
  FOREIGN KEY(business_area_id,division_id) REFERENCES native_business_divisions(business_area_id,id) ON DELETE RESTRICT
);
CREATE INDEX native_staff_admin_delegations_actor_action ON native_staff_admin_delegations(actor_staff_id,action,active);
CREATE TRIGGER native_staff_admin_delegations_update_guard BEFORE UPDATE ON native_staff_admin_delegations
WHEN NEW.id IS NOT OLD.id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.action IS NOT OLD.action
  OR NEW.effect IS NOT OLD.effect OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.business_area_id IS NOT OLD.business_area_id
  OR NEW.division_id IS NOT OLD.division_id OR NEW.target_staff_id IS NOT OLD.target_staff_id
  OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native staff admin delegation update is invalid'); END;

CREATE TABLE native_staff_admin_command_fences (
  command_id TEXT NOT NULL PRIMARY KEY,
  request_sha256 TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('staff.profile.edit','staff.admission.disable')),
  actor_staff_id TEXT NOT NULL,
  actor_access_subject TEXT NOT NULL,
  target_staff_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  result_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  expected_display_name TEXT,
  mutation_writes INTEGER NOT NULL DEFAULT 1 CHECK(mutation_writes IN (0,1)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE native_staff_admin_commands (
  command_id TEXT NOT NULL PRIMARY KEY,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN ('staff.profile.edit','staff.admission.disable')),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  target_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL,
  result_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  executed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_staff_admin_commands_no_update BEFORE UPDATE ON native_staff_admin_commands
BEGIN SELECT RAISE(ABORT,'native staff admin command is immutable'); END;
CREATE TRIGGER native_staff_admin_commands_no_delete BEFORE DELETE ON native_staff_admin_commands
BEGIN SELECT RAISE(ABORT,'native staff admin command is durable'); END;

CREATE TRIGGER native_staff_admin_commands_valid BEFORE INSERT ON native_staff_admin_commands
WHEN NOT EXISTS (
  SELECT 1 FROM native_staff_admin_command_fences fence
  WHERE fence.command_id=NEW.command_id AND fence.request_sha256=NEW.request_sha256
    AND fence.action=NEW.action AND fence.actor_staff_id=NEW.actor_staff_id
    AND fence.actor_access_subject=NEW.actor_access_subject AND fence.target_staff_id=NEW.target_staff_id
    AND fence.expected_version=NEW.expected_version AND fence.result_version=NEW.result_version
    AND fence.reason=NEW.reason AND fence.mutation_writes=0
    AND ((NEW.action='staff.profile.edit' AND EXISTS(SELECT 1 FROM native_staff_profiles profile
          WHERE profile.staff_id=NEW.target_staff_id AND profile.version=NEW.result_version
            AND profile.display_name=fence.expected_display_name))
      OR (NEW.action='staff.admission.disable' AND EXISTS(SELECT 1 FROM native_staff_admissions target
          WHERE target.staff_id=NEW.target_staff_id AND target.active=0 AND target.version=NEW.result_version)))
    AND EXISTS(SELECT 1 FROM native_staff_admin_delegations allow_row
      WHERE allow_row.actor_staff_id=NEW.actor_staff_id AND allow_row.action=NEW.action
        AND allow_row.effect='allow' AND allow_row.active=1 AND (
          allow_row.scope_kind='global' OR
          (allow_row.scope_kind='exact_staff' AND allow_row.target_staff_id=NEW.target_staff_id) OR
          (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=allow_row.business_area_id)) OR
          (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=allow_row.business_area_id
              AND membership.division_id=allow_row.division_id))))
    AND NOT EXISTS(SELECT 1 FROM native_staff_admin_delegations deny_row
      WHERE deny_row.actor_staff_id=NEW.actor_staff_id AND deny_row.action=NEW.action
        AND deny_row.effect='deny' AND deny_row.active=1 AND (
          deny_row.scope_kind='global' OR
          (deny_row.scope_kind='exact_staff' AND deny_row.target_staff_id=NEW.target_staff_id) OR
          (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=deny_row.business_area_id)) OR
          (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=deny_row.business_area_id
              AND membership.division_id=deny_row.division_id))))
    AND NOT EXISTS(SELECT 1 FROM native_staff_target_memberships membership
      LEFT JOIN native_business_areas area ON area.id=membership.business_area_id
      LEFT JOIN native_business_divisions division ON division.id=membership.division_id AND division.business_area_id=membership.business_area_id
      WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1
        AND (coalesce(area.active,0)<>1 OR (membership.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
)
BEGIN SELECT RAISE(ABORT,'native staff administration authorization changed'); END;

CREATE TRIGGER native_staff_admin_commands_consume AFTER INSERT ON native_staff_admin_commands
BEGIN DELETE FROM native_staff_admin_command_fences WHERE command_id=NEW.command_id; END;

CREATE TRIGGER native_staff_admin_profile_edit_consume AFTER UPDATE ON native_staff_profiles
WHEN NEW.version=OLD.version+1
BEGIN UPDATE native_staff_admin_command_fences SET mutation_writes=0
  WHERE action='staff.profile.edit' AND target_staff_id=NEW.staff_id AND expected_version=OLD.version
    AND result_version=NEW.version AND expected_display_name=NEW.display_name AND mutation_writes=1; END;

CREATE TRIGGER native_staff_admin_admission_disable_consume AFTER UPDATE ON native_staff_admissions
WHEN OLD.active=1 AND NEW.active=0 AND NEW.version=OLD.version+1
BEGIN UPDATE native_staff_admin_command_fences SET mutation_writes=0
  WHERE action='staff.admission.disable' AND target_staff_id=NEW.staff_id AND expected_version=OLD.version
    AND result_version=NEW.version AND mutation_writes=1; END;
