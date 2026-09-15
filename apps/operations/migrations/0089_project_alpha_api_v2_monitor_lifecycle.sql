-- Explicit deployment lifecycle for API-v2 monitoring. This stores only the
-- exact public connection identities, never credentials or probe responses.
CREATE TABLE project_alpha_api_v2_monitor_lifecycle_heads (
  lifecycle_id INTEGER PRIMARY KEY CHECK (lifecycle_id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  identities_json TEXT NOT NULL CHECK (json_valid(identities_json)
    AND json_type(identities_json) = 'array' AND length(identities_json) BETWEEN 2 AND 131072)
);

CREATE TABLE project_alpha_api_v2_monitor_lifecycle_history (
  lifecycle_id INTEGER NOT NULL CHECK (lifecycle_id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  identities_json TEXT NOT NULL CHECK (json_valid(identities_json)
    AND json_type(identities_json) = 'array' AND length(identities_json) BETWEEN 2 AND 131072),
  PRIMARY KEY (lifecycle_id, revision),
  FOREIGN KEY (lifecycle_id) REFERENCES project_alpha_api_v2_monitor_lifecycle_heads(lifecycle_id)
);

CREATE TRIGGER project_alpha_api_v2_monitor_lifecycle_head_no_replace
BEFORE INSERT ON project_alpha_api_v2_monitor_lifecycle_heads
WHEN NEW.revision <> 1
  OR EXISTS (SELECT 1 FROM project_alpha_api_v2_monitor_lifecycle_heads WHERE lifecycle_id = NEW.lifecycle_id)
BEGIN SELECT RAISE(ABORT, 'monitor lifecycle head already exists'); END;

CREATE TRIGGER project_alpha_api_v2_monitor_lifecycle_head_insert_history
AFTER INSERT ON project_alpha_api_v2_monitor_lifecycle_heads
BEGIN
  INSERT INTO project_alpha_api_v2_monitor_lifecycle_history
    (lifecycle_id, revision, enabled, identities_json)
  VALUES (NEW.lifecycle_id, NEW.revision, NEW.enabled, NEW.identities_json);
END;

CREATE TRIGGER project_alpha_api_v2_monitor_lifecycle_head_update_guard
BEFORE UPDATE ON project_alpha_api_v2_monitor_lifecycle_heads
WHEN NEW.lifecycle_id <> OLD.lifecycle_id
  OR NEW.revision <> OLD.revision + 1
  OR NEW.enabled NOT IN (0, 1)
  OR json_valid(NEW.identities_json) = 0
  OR json_type(NEW.identities_json) <> 'array'
  OR length(NEW.identities_json) NOT BETWEEN 2 AND 131072
BEGIN SELECT RAISE(ABORT, 'monitor lifecycle head update denied'); END;

CREATE TRIGGER project_alpha_api_v2_monitor_lifecycle_head_update_history
AFTER UPDATE ON project_alpha_api_v2_monitor_lifecycle_heads
BEGIN
  INSERT INTO project_alpha_api_v2_monitor_lifecycle_history
    (lifecycle_id, revision, enabled, identities_json)
  VALUES (NEW.lifecycle_id, NEW.revision, NEW.enabled, NEW.identities_json);
END;

CREATE TRIGGER project_alpha_api_v2_monitor_lifecycle_head_no_delete
BEFORE DELETE ON project_alpha_api_v2_monitor_lifecycle_heads
BEGIN SELECT RAISE(ABORT, 'monitor lifecycle head deletion denied'); END;

CREATE TRIGGER project_alpha_api_v2_monitor_lifecycle_history_insert_guard
BEFORE INSERT ON project_alpha_api_v2_monitor_lifecycle_history
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_monitor_lifecycle_heads h
  WHERE h.lifecycle_id = NEW.lifecycle_id AND h.revision = NEW.revision
    AND h.enabled = NEW.enabled AND h.identities_json = NEW.identities_json)
  OR EXISTS (SELECT 1 FROM project_alpha_api_v2_monitor_lifecycle_history old
    WHERE old.lifecycle_id = NEW.lifecycle_id AND old.revision = NEW.revision)
BEGIN SELECT RAISE(ABORT, 'monitor lifecycle history insertion denied'); END;

CREATE TRIGGER project_alpha_api_v2_monitor_lifecycle_history_no_update
BEFORE UPDATE ON project_alpha_api_v2_monitor_lifecycle_history
BEGIN SELECT RAISE(ABORT, 'monitor lifecycle history update denied'); END;

CREATE TRIGGER project_alpha_api_v2_monitor_lifecycle_history_no_delete
BEFORE DELETE ON project_alpha_api_v2_monitor_lifecycle_history
BEGIN SELECT RAISE(ABORT, 'monitor lifecycle history deletion denied'); END;
