-- A lifecycle transition retires only identities entering or leaving the
-- active set. Existing incident heads are retained with an immutable history
-- revision; historical alert leases remain rows but cannot act on this head.
-- The marker is greater than every prior observation/alert action, so a probe
-- started before retirement cannot reopen the old outage.
CREATE TRIGGER project_alpha_api_v2_monitor_retire_on_insert
AFTER INSERT ON project_alpha_api_v2_monitor_lifecycle_heads
WHEN NEW.enabled = 1
BEGIN
  UPDATE project_alpha_api_v2_incident_heads
  SET revision = CASE WHEN project_alpha_api_v2_incident_heads.revision >= 9007199254740991
      THEN RAISE(ABORT, 'incident retirement revision overflow') ELSE project_alpha_api_v2_incident_heads.revision + 1 END,
    last_probe_started_at = CASE
      WHEN typeof(project_alpha_api_v2_incident_heads.last_probe_started_at) IS NOT 'integer'
        OR project_alpha_api_v2_incident_heads.last_probe_started_at >= 9007199254740991
        OR json_type(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt') NOT IN ('null','integer')
        OR COALESCE(json_extract(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt'),0) >= 9007199254740991
      THEN RAISE(ABORT, 'incident retirement marker overflow')
      ELSE MAX(project_alpha_api_v2_incident_heads.last_probe_started_at, COALESCE(json_extract(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt'),0),0) + 1 END,
    state_json = json_set(project_alpha_api_v2_incident_heads.state_json,
      '$.lastProbeStartedAt', CASE
        WHEN typeof(project_alpha_api_v2_incident_heads.last_probe_started_at) IS NOT 'integer'
          OR project_alpha_api_v2_incident_heads.last_probe_started_at >= 9007199254740991
          OR json_type(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt') NOT IN ('null','integer')
          OR COALESCE(json_extract(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt'),0) >= 9007199254740991
        THEN RAISE(ABORT, 'incident retirement marker overflow')
        ELSE MAX(project_alpha_api_v2_incident_heads.last_probe_started_at, COALESCE(json_extract(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt'),0),0) + 1 END,
      '$.category', 'disabled', '$.reason', NULL, '$.unhealthySince', NULL,
      '$.unavailableSince', NULL, '$.alertClaimedAt', NULL,
      '$.alertAttemptedAt', NULL, '$.alertSentAt', NULL)
  WHERE EXISTS (SELECT 1 FROM json_each(NEW.identities_json) AS selected
    WHERE json_extract(selected.value,'$.sourceId') = project_alpha_api_v2_incident_heads.source_id
      AND json_extract(selected.value,'$.applicationId') = project_alpha_api_v2_incident_heads.application_id
      AND json_extract(selected.value,'$.baseUrl') = project_alpha_api_v2_incident_heads.base_url
      AND json_extract(selected.value,'$.expectedSourceInstanceId') = project_alpha_api_v2_incident_heads.expected_source_instance_id
      AND json_extract(selected.value,'$.expectedHistoryEpoch') = project_alpha_api_v2_incident_heads.expected_history_epoch);
END;

CREATE TRIGGER project_alpha_api_v2_monitor_retire_on_update
AFTER UPDATE ON project_alpha_api_v2_monitor_lifecycle_heads
BEGIN
  UPDATE project_alpha_api_v2_incident_heads
  SET revision = CASE WHEN project_alpha_api_v2_incident_heads.revision >= 9007199254740991
      THEN RAISE(ABORT, 'incident retirement revision overflow') ELSE project_alpha_api_v2_incident_heads.revision + 1 END,
    last_probe_started_at = CASE
      WHEN typeof(project_alpha_api_v2_incident_heads.last_probe_started_at) IS NOT 'integer'
        OR project_alpha_api_v2_incident_heads.last_probe_started_at >= 9007199254740991
        OR json_type(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt') NOT IN ('null','integer')
        OR COALESCE(json_extract(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt'),0) >= 9007199254740991
      THEN RAISE(ABORT, 'incident retirement marker overflow')
      ELSE MAX(project_alpha_api_v2_incident_heads.last_probe_started_at, COALESCE(json_extract(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt'),0),0) + 1 END,
    state_json = json_set(project_alpha_api_v2_incident_heads.state_json,
      '$.lastProbeStartedAt', CASE
        WHEN typeof(project_alpha_api_v2_incident_heads.last_probe_started_at) IS NOT 'integer'
          OR project_alpha_api_v2_incident_heads.last_probe_started_at >= 9007199254740991
          OR json_type(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt') NOT IN ('null','integer')
          OR COALESCE(json_extract(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt'),0) >= 9007199254740991
        THEN RAISE(ABORT, 'incident retirement marker overflow')
        ELSE MAX(project_alpha_api_v2_incident_heads.last_probe_started_at, COALESCE(json_extract(project_alpha_api_v2_incident_heads.state_json, '$.lastAlertActionAt'),0),0) + 1 END,
      '$.category', 'disabled', '$.reason', NULL, '$.unhealthySince', NULL,
      '$.unavailableSince', NULL, '$.alertClaimedAt', NULL,
      '$.alertAttemptedAt', NULL, '$.alertSentAt', NULL)
  WHERE
    (OLD.enabled = 1 AND EXISTS (SELECT 1 FROM json_each(OLD.identities_json) AS previous
      WHERE json_extract(previous.value,'$.sourceId') = project_alpha_api_v2_incident_heads.source_id
        AND json_extract(previous.value,'$.applicationId') = project_alpha_api_v2_incident_heads.application_id
        AND json_extract(previous.value,'$.baseUrl') = project_alpha_api_v2_incident_heads.base_url
        AND json_extract(previous.value,'$.expectedSourceInstanceId') = project_alpha_api_v2_incident_heads.expected_source_instance_id
        AND json_extract(previous.value,'$.expectedHistoryEpoch') = project_alpha_api_v2_incident_heads.expected_history_epoch)
      AND (NEW.enabled = 0 OR NOT EXISTS (SELECT 1 FROM json_each(NEW.identities_json) AS current
        WHERE json_extract(current.value,'$.sourceId') = project_alpha_api_v2_incident_heads.source_id
          AND json_extract(current.value,'$.applicationId') = project_alpha_api_v2_incident_heads.application_id
          AND json_extract(current.value,'$.baseUrl') = project_alpha_api_v2_incident_heads.base_url
          AND json_extract(current.value,'$.expectedSourceInstanceId') = project_alpha_api_v2_incident_heads.expected_source_instance_id
          AND json_extract(current.value,'$.expectedHistoryEpoch') = project_alpha_api_v2_incident_heads.expected_history_epoch)))
    OR
    (NEW.enabled = 1 AND EXISTS (SELECT 1 FROM json_each(NEW.identities_json) AS current
      WHERE json_extract(current.value,'$.sourceId') = project_alpha_api_v2_incident_heads.source_id
        AND json_extract(current.value,'$.applicationId') = project_alpha_api_v2_incident_heads.application_id
        AND json_extract(current.value,'$.baseUrl') = project_alpha_api_v2_incident_heads.base_url
        AND json_extract(current.value,'$.expectedSourceInstanceId') = project_alpha_api_v2_incident_heads.expected_source_instance_id
        AND json_extract(current.value,'$.expectedHistoryEpoch') = project_alpha_api_v2_incident_heads.expected_history_epoch)
      AND (OLD.enabled = 0 OR NOT EXISTS (SELECT 1 FROM json_each(OLD.identities_json) AS previous
        WHERE json_extract(previous.value,'$.sourceId') = project_alpha_api_v2_incident_heads.source_id
          AND json_extract(previous.value,'$.applicationId') = project_alpha_api_v2_incident_heads.application_id
          AND json_extract(previous.value,'$.baseUrl') = project_alpha_api_v2_incident_heads.base_url
          AND json_extract(previous.value,'$.expectedSourceInstanceId') = project_alpha_api_v2_incident_heads.expected_source_instance_id
          AND json_extract(previous.value,'$.expectedHistoryEpoch') = project_alpha_api_v2_incident_heads.expected_history_epoch)));
END;
