-- Native-only global integration controls. No role, owner, PA principal, or
-- migration seed receives either capability. Grant administration is separate.
CREATE TABLE native_integration_control_grants (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK(capability IN ('integrations.monitor.manage','integrations.alerts.reconcile')),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind='global'),
  active INTEGER NOT NULL CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(actor_staff_id,capability,effect)
);
CREATE TABLE native_integration_control_grant_history (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  actor_staff_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  effect TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  active INTEGER NOT NULL,
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id,version),
  FOREIGN KEY(id) REFERENCES native_integration_control_grants(id) ON DELETE RESTRICT
);
CREATE INDEX native_integration_control_grants_actor
  ON native_integration_control_grants(actor_staff_id,capability,active);
CREATE TRIGGER native_integration_control_grants_insert_guard
BEFORE INSERT ON native_integration_control_grants
WHEN NEW.version<>1
  OR EXISTS(SELECT 1 FROM native_integration_control_grants old WHERE old.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'native integration grant insert denied'); END;
CREATE TRIGGER native_integration_control_grants_update_guard
BEFORE UPDATE ON native_integration_control_grants
WHEN NEW.id IS NOT OLD.id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id
  OR NEW.capability IS NOT OLD.capability OR NEW.effect IS NOT OLD.effect
  OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
  OR NEW.version>9007199254740991 OR NEW.active IS OLD.active
BEGIN SELECT RAISE(ABORT,'native integration grant update denied'); END;
CREATE TRIGGER native_integration_control_grants_no_delete
BEFORE DELETE ON native_integration_control_grants
BEGIN SELECT RAISE(ABORT,'native integration grant deletion denied'); END;
CREATE TRIGGER native_integration_control_grants_insert_history
AFTER INSERT ON native_integration_control_grants
BEGIN INSERT INTO native_integration_control_grant_history
  (id,version,actor_staff_id,capability,effect,scope_kind,active,granted_by,created_at,updated_at)
  VALUES(NEW.id,NEW.version,NEW.actor_staff_id,NEW.capability,NEW.effect,NEW.scope_kind,
    NEW.active,NEW.granted_by,NEW.created_at,NEW.updated_at); END;
CREATE TRIGGER native_integration_control_grants_update_history
AFTER UPDATE ON native_integration_control_grants
BEGIN INSERT INTO native_integration_control_grant_history
  (id,version,actor_staff_id,capability,effect,scope_kind,active,granted_by,created_at,updated_at)
  VALUES(NEW.id,NEW.version,NEW.actor_staff_id,NEW.capability,NEW.effect,NEW.scope_kind,
    NEW.active,NEW.granted_by,NEW.created_at,NEW.updated_at); END;
CREATE TRIGGER native_integration_control_grant_history_insert_guard
BEFORE INSERT ON native_integration_control_grant_history
WHEN NOT EXISTS(SELECT 1 FROM native_integration_control_grants g WHERE g.id=NEW.id
  AND g.version=NEW.version AND g.actor_staff_id=NEW.actor_staff_id
  AND g.capability=NEW.capability AND g.effect=NEW.effect AND g.scope_kind=NEW.scope_kind
  AND g.active=NEW.active AND g.granted_by=NEW.granted_by
  AND g.created_at=NEW.created_at AND g.updated_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'native integration grant history denied'); END;
CREATE TRIGGER native_integration_control_grant_history_no_update
BEFORE UPDATE ON native_integration_control_grant_history
BEGIN SELECT RAISE(ABORT,'native integration grant history update denied'); END;
CREATE TRIGGER native_integration_control_grant_history_no_delete
BEFORE DELETE ON native_integration_control_grant_history
BEGIN SELECT RAISE(ABORT,'native integration grant history deletion denied'); END;

-- A fresh command ID on each attributed transition gives the audit insertion
-- an exact same-batch CAS witness. Legacy internal writes remain unattributed
-- only until the first authorized takeover; no route may invoke that helper.
ALTER TABLE project_alpha_api_v2_monitor_lifecycle_heads
  ADD COLUMN operator_command_id TEXT
    REFERENCES project_alpha_api_v2_monitor_operator_audit(command_id) DEFERRABLE INITIALLY DEFERRED
    CHECK(operator_command_id IS NULL OR length(operator_command_id)=36);
CREATE UNIQUE INDEX project_alpha_api_v2_monitor_operator_command_id
  ON project_alpha_api_v2_monitor_lifecycle_heads(operator_command_id);
CREATE TRIGGER project_alpha_api_v2_monitor_attribution_update_guard
BEFORE UPDATE ON project_alpha_api_v2_monitor_lifecycle_heads
WHEN (OLD.operator_command_id IS NOT NULL
    AND (NEW.operator_command_id IS NULL OR NEW.operator_command_id IS OLD.operator_command_id))
  OR (NEW.operator_command_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM project_alpha_api_v2_monitor_operator_audit audit
      WHERE audit.command_id=NEW.operator_command_id))
BEGIN SELECT RAISE(ABORT,'attributed monitor lifecycle requires a new operator command'); END;

CREATE TABLE project_alpha_api_v2_monitor_operator_audit (
  lifecycle_id INTEGER NOT NULL DEFAULT 1 CHECK(lifecycle_id=1),
  lifecycle_revision INTEGER NOT NULL CHECK(typeof(lifecycle_revision)='integer' AND lifecycle_revision>=1),
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id)=36),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191),
  actor_admission_version INTEGER NOT NULL CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(typeof(actor_profile_version)='integer' AND actor_profile_version>=1),
  actor_email TEXT NOT NULL CHECK(length(actor_email) BETWEEN 3 AND 254),
  verified_until TEXT NOT NULL CHECK(length(verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_until) IS verified_until),
  capability TEXT NOT NULL CHECK(capability='integrations.monitor.manage'),
  allow_grant_id TEXT NOT NULL REFERENCES native_integration_control_grants(id) ON DELETE RESTRICT,
  allow_grant_version INTEGER NOT NULL CHECK(typeof(allow_grant_version)='integer' AND allow_grant_version>=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  identities_json TEXT NOT NULL CHECK(json_valid(identities_json) AND json_type(identities_json)='array'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(lifecycle_id,lifecycle_revision),
  FOREIGN KEY(lifecycle_id,lifecycle_revision)
    REFERENCES project_alpha_api_v2_monitor_lifecycle_history(lifecycle_id,revision) ON DELETE RESTRICT
);
CREATE TRIGGER project_alpha_api_v2_monitor_operator_audit_insert_guard
BEFORE INSERT ON project_alpha_api_v2_monitor_operator_audit
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_monitor_lifecycle_heads head
  JOIN project_alpha_api_v2_monitor_lifecycle_history history
    ON history.lifecycle_id=head.lifecycle_id AND history.revision=head.revision
  WHERE head.lifecycle_id=NEW.lifecycle_id AND head.revision=NEW.lifecycle_revision
    AND head.operator_command_id=NEW.command_id AND head.enabled=NEW.enabled
    AND head.identities_json=NEW.identities_json AND history.enabled=NEW.enabled
    AND history.identities_json=NEW.identities_json)
  OR NEW.verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1
      AND admission.bound_access_subject=NEW.actor_access_subject
      AND admission.version=NEW.actor_admission_version
      AND profile.version=NEW.actor_profile_version AND profile.login_email=NEW.actor_email)
  OR NOT EXISTS(SELECT 1 FROM native_integration_control_grants allow_row
    WHERE allow_row.id=NEW.allow_grant_id AND allow_row.version=NEW.allow_grant_version
      AND allow_row.actor_staff_id=NEW.actor_staff_id AND allow_row.capability=NEW.capability
      AND allow_row.effect='allow' AND allow_row.scope_kind='global' AND allow_row.active=1)
  OR EXISTS(SELECT 1 FROM native_integration_control_grants deny_row
    WHERE deny_row.actor_staff_id=NEW.actor_staff_id AND deny_row.capability=NEW.capability
      AND deny_row.effect='deny' AND deny_row.scope_kind='global' AND deny_row.active=1)
  OR EXISTS(SELECT 1 FROM project_alpha_api_v2_monitor_operator_audit existing
    WHERE existing.lifecycle_id=NEW.lifecycle_id AND existing.lifecycle_revision=NEW.lifecycle_revision)
BEGIN SELECT RAISE(ABORT,'monitor operator audit denied'); END;
CREATE TRIGGER project_alpha_api_v2_monitor_operator_audit_no_update
BEFORE UPDATE ON project_alpha_api_v2_monitor_operator_audit
BEGIN SELECT RAISE(ABORT,'monitor operator audit update denied'); END;
CREATE TRIGGER project_alpha_api_v2_monitor_operator_audit_no_delete
BEFORE DELETE ON project_alpha_api_v2_monitor_operator_audit
BEGIN SELECT RAISE(ABORT,'monitor operator audit deletion denied'); END;
