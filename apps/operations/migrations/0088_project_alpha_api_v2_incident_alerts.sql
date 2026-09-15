-- One logical owner alert per exact API-v2 connection identity and incident.
-- A lease is an internal dispatch fence, not an email or delivery receipt.
CREATE TABLE project_alpha_api_v2_incident_alerts (
  source_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  expected_source_instance_id TEXT NOT NULL,
  expected_history_epoch TEXT NOT NULL,
  incident_sequence INTEGER NOT NULL CHECK (incident_sequence >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('leased','retry','sent','cancelled')),
  claim_sequence INTEGER NOT NULL CHECK (claim_sequence >= 1),
  lease_token TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sent_at INTEGER CHECK (sent_at IS NULL OR sent_at >= 0),
  PRIMARY KEY (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch,incident_sequence),
  FOREIGN KEY (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch)
    REFERENCES project_alpha_api_v2_incident_heads
      (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch),
  CHECK ((status='leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND lease_expires_at >= 0 AND sent_at IS NULL)
    OR (status IN ('retry','cancelled') AND lease_token IS NULL AND lease_expires_at IS NULL AND sent_at IS NULL)
    OR (status='sent' AND lease_token IS NULL AND lease_expires_at IS NULL AND sent_at IS NOT NULL))
);

CREATE TRIGGER project_alpha_api_v2_incident_alert_no_replace
BEFORE INSERT ON project_alpha_api_v2_incident_alerts
WHEN NEW.status <> 'leased' OR NEW.revision <> 1 OR NEW.attempt_count <> 0
  OR EXISTS (SELECT 1 FROM project_alpha_api_v2_incident_alerts existing
    WHERE existing.source_id=NEW.source_id AND existing.application_id=NEW.application_id
      AND existing.base_url=NEW.base_url
      AND existing.expected_source_instance_id=NEW.expected_source_instance_id
      AND existing.expected_history_epoch=NEW.expected_history_epoch
      AND existing.incident_sequence=NEW.incident_sequence)
BEGIN SELECT RAISE(ABORT,'incident alert insert denied'); END;

CREATE TRIGGER project_alpha_api_v2_incident_alert_update_guard
BEFORE UPDATE ON project_alpha_api_v2_incident_alerts
WHEN NEW.source_id <> OLD.source_id OR NEW.application_id <> OLD.application_id
  OR NEW.base_url <> OLD.base_url
  OR NEW.expected_source_instance_id <> OLD.expected_source_instance_id
  OR NEW.expected_history_epoch <> OLD.expected_history_epoch
  OR NEW.incident_sequence <> OLD.incident_sequence OR NEW.revision <> OLD.revision+1
  OR OLD.status IN ('sent','cancelled')
  OR (OLD.status='retry' AND NEW.status NOT IN ('leased','cancelled'))
  OR (OLD.status='leased' AND NEW.status NOT IN ('leased','retry','sent','cancelled'))
  OR NEW.claim_sequence < OLD.claim_sequence OR NEW.claim_sequence > OLD.claim_sequence+1
  OR (NEW.status='leased' AND NEW.claim_sequence=OLD.claim_sequence
    AND NEW.lease_token IS NOT OLD.lease_token)
BEGIN SELECT RAISE(ABORT,'incident alert update denied'); END;

CREATE TRIGGER project_alpha_api_v2_incident_alert_no_delete
BEFORE DELETE ON project_alpha_api_v2_incident_alerts
BEGIN SELECT RAISE(ABORT,'incident alert delete denied'); END;

-- The final event is an assertion-bearing commit record. Its NOT NULL field
-- aborts the whole D1 batch if the preceding head/outbox CAS did not both land.
CREATE TABLE project_alpha_api_v2_incident_alert_events (
  source_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  expected_source_instance_id TEXT NOT NULL,
  expected_history_epoch TEXT NOT NULL,
  incident_sequence INTEGER NOT NULL CHECK (incident_sequence >= 1),
  alert_revision INTEGER NOT NULL CHECK (alert_revision >= 1),
  head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
  claim_sequence INTEGER NOT NULL CHECK (claim_sequence >= 1),
  action TEXT NOT NULL CHECK (action IN ('claim','reclaim','attempt','failed','sent')),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  assertion INTEGER NOT NULL CHECK (assertion=1),
  PRIMARY KEY (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch,
    incident_sequence,alert_revision),
  UNIQUE (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch,head_revision),
  FOREIGN KEY (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch,incident_sequence)
    REFERENCES project_alpha_api_v2_incident_alerts
      (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch,incident_sequence)
);

CREATE TRIGGER project_alpha_api_v2_incident_alert_event_guard
BEFORE INSERT ON project_alpha_api_v2_incident_alert_events
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_incident_heads h
  WHERE h.source_id=NEW.source_id AND h.application_id=NEW.application_id
    AND h.base_url=NEW.base_url AND h.expected_source_instance_id=NEW.expected_source_instance_id
    AND h.expected_history_epoch=NEW.expected_history_epoch AND h.revision=NEW.head_revision
    AND json_extract(h.state_json,'$.incidentSequence')=NEW.incident_sequence
    AND json_extract(h.state_json,'$.alertClaimSequence')=NEW.claim_sequence)
  OR NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_incident_alerts a
  WHERE a.source_id=NEW.source_id AND a.application_id=NEW.application_id
    AND a.base_url=NEW.base_url AND a.expected_source_instance_id=NEW.expected_source_instance_id
    AND a.expected_history_epoch=NEW.expected_history_epoch AND a.incident_sequence=NEW.incident_sequence
    AND a.revision=NEW.alert_revision AND a.claim_sequence=NEW.claim_sequence)
BEGIN SELECT RAISE(ABORT,'incident alert event denied'); END;

CREATE TRIGGER project_alpha_api_v2_incident_alert_event_no_update
BEFORE UPDATE ON project_alpha_api_v2_incident_alert_events
BEGIN SELECT RAISE(ABORT,'incident alert event update denied'); END;

CREATE TRIGGER project_alpha_api_v2_incident_alert_event_no_delete
BEFORE DELETE ON project_alpha_api_v2_incident_alert_events
BEGIN SELECT RAISE(ABORT,'incident alert event delete denied'); END;
