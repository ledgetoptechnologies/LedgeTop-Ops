-- API-v2 connection observations are independent of legacy daily snapshot health.
-- No access token, request body, response body, or recipient address is stored.
CREATE TABLE project_alpha_api_v2_incident_heads (
  source_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  expected_source_instance_id TEXT NOT NULL,
  expected_history_epoch TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  last_probe_started_at INTEGER NOT NULL CHECK (last_probe_started_at >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object'
    AND length(state_json) BETWEEN 2 AND 8192),
  PRIMARY KEY (source_id, application_id, base_url, expected_source_instance_id, expected_history_epoch),
  CHECK (length(source_id) BETWEEN 15 AND 78 AND substr(source_id, 1, 14) = 'project-alpha:'),
  CHECK (length(application_id) = 36 AND length(expected_source_instance_id) = 36
    AND length(expected_history_epoch) = 36),
  CHECK (length(base_url) BETWEEN 9 AND 2048 AND substr(base_url, 1, 8) = 'https://')
);

CREATE TABLE project_alpha_api_v2_incident_history (
  source_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  expected_source_instance_id TEXT NOT NULL,
  expected_history_epoch TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  last_probe_started_at INTEGER NOT NULL CHECK (last_probe_started_at >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object'
    AND length(state_json) BETWEEN 2 AND 8192),
  PRIMARY KEY (source_id, application_id, base_url, expected_source_instance_id, expected_history_epoch, revision),
  FOREIGN KEY (source_id, application_id, base_url, expected_source_instance_id, expected_history_epoch)
    REFERENCES project_alpha_api_v2_incident_heads
      (source_id, application_id, base_url, expected_source_instance_id, expected_history_epoch)
);

CREATE TRIGGER project_alpha_api_v2_incident_head_no_replace
BEFORE INSERT ON project_alpha_api_v2_incident_heads
WHEN NEW.revision <> 1 OR json_extract(NEW.state_json, '$.identity.sourceId') IS NOT NEW.source_id
  OR json_extract(NEW.state_json, '$.identity.applicationId') IS NOT NEW.application_id
  OR json_extract(NEW.state_json, '$.identity.baseUrl') IS NOT NEW.base_url
  OR json_extract(NEW.state_json, '$.identity.expectedSourceInstanceId') IS NOT NEW.expected_source_instance_id
  OR json_extract(NEW.state_json, '$.identity.expectedHistoryEpoch') IS NOT NEW.expected_history_epoch
  OR json_extract(NEW.state_json, '$.lastProbeStartedAt') IS NOT NEW.last_probe_started_at
  OR EXISTS (SELECT 1 FROM project_alpha_api_v2_incident_heads h
  WHERE h.source_id = NEW.source_id AND h.application_id = NEW.application_id
    AND h.base_url = NEW.base_url AND h.expected_source_instance_id = NEW.expected_source_instance_id
    AND h.expected_history_epoch = NEW.expected_history_epoch)
BEGIN SELECT RAISE(ABORT, 'incident head already exists'); END;

CREATE TRIGGER project_alpha_api_v2_incident_head_insert_history
AFTER INSERT ON project_alpha_api_v2_incident_heads
BEGIN
  INSERT INTO project_alpha_api_v2_incident_history
    (source_id, application_id, base_url, expected_source_instance_id, expected_history_epoch,
     revision, last_probe_started_at, state_json)
  VALUES (NEW.source_id, NEW.application_id, NEW.base_url, NEW.expected_source_instance_id,
    NEW.expected_history_epoch, NEW.revision, NEW.last_probe_started_at, NEW.state_json);
END;

CREATE TRIGGER project_alpha_api_v2_incident_head_update_guard
BEFORE UPDATE ON project_alpha_api_v2_incident_heads
WHEN NEW.source_id <> OLD.source_id OR NEW.application_id <> OLD.application_id
  OR NEW.base_url <> OLD.base_url OR NEW.expected_source_instance_id <> OLD.expected_source_instance_id
  OR NEW.expected_history_epoch <> OLD.expected_history_epoch OR NEW.revision <> OLD.revision + 1
  OR NEW.last_probe_started_at < OLD.last_probe_started_at OR NEW.state_json = OLD.state_json
  OR json_extract(NEW.state_json, '$.identity.sourceId') IS NOT NEW.source_id
  OR json_extract(NEW.state_json, '$.identity.applicationId') IS NOT NEW.application_id
  OR json_extract(NEW.state_json, '$.identity.baseUrl') IS NOT NEW.base_url
  OR json_extract(NEW.state_json, '$.identity.expectedSourceInstanceId') IS NOT NEW.expected_source_instance_id
  OR json_extract(NEW.state_json, '$.identity.expectedHistoryEpoch') IS NOT NEW.expected_history_epoch
  OR json_extract(NEW.state_json, '$.lastProbeStartedAt') IS NOT NEW.last_probe_started_at
BEGIN SELECT RAISE(ABORT, 'incident head update denied'); END;

CREATE TRIGGER project_alpha_api_v2_incident_head_update_history
AFTER UPDATE ON project_alpha_api_v2_incident_heads
BEGIN
  INSERT INTO project_alpha_api_v2_incident_history
    (source_id, application_id, base_url, expected_source_instance_id, expected_history_epoch,
     revision, last_probe_started_at, state_json)
  VALUES (NEW.source_id, NEW.application_id, NEW.base_url, NEW.expected_source_instance_id,
    NEW.expected_history_epoch, NEW.revision, NEW.last_probe_started_at, NEW.state_json);
END;

CREATE TRIGGER project_alpha_api_v2_incident_head_no_delete
BEFORE DELETE ON project_alpha_api_v2_incident_heads
BEGIN SELECT RAISE(ABORT, 'incident head deletion denied'); END;

CREATE TRIGGER project_alpha_api_v2_incident_history_insert_guard
BEFORE INSERT ON project_alpha_api_v2_incident_history
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_incident_heads h
  WHERE h.source_id = NEW.source_id AND h.application_id = NEW.application_id
    AND h.base_url = NEW.base_url AND h.expected_source_instance_id = NEW.expected_source_instance_id
    AND h.expected_history_epoch = NEW.expected_history_epoch AND h.revision = NEW.revision
    AND h.last_probe_started_at = NEW.last_probe_started_at AND h.state_json = NEW.state_json)
  OR EXISTS (SELECT 1 FROM project_alpha_api_v2_incident_history old
    WHERE old.source_id = NEW.source_id AND old.application_id = NEW.application_id
      AND old.base_url = NEW.base_url AND old.expected_source_instance_id = NEW.expected_source_instance_id
      AND old.expected_history_epoch = NEW.expected_history_epoch AND old.revision = NEW.revision)
BEGIN SELECT RAISE(ABORT, 'incident history insertion denied'); END;

CREATE TRIGGER project_alpha_api_v2_incident_history_no_update
BEFORE UPDATE ON project_alpha_api_v2_incident_history
BEGIN SELECT RAISE(ABORT, 'incident history update denied'); END;

CREATE TRIGGER project_alpha_api_v2_incident_history_no_delete
BEFORE DELETE ON project_alpha_api_v2_incident_history
BEGIN SELECT RAISE(ABORT, 'incident history deletion denied'); END;
