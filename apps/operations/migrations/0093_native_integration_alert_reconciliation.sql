-- Unmounted native operator settlement of an already-attempted outage alert.
-- The fence, two state changes, existing alert event, and receipt are one D1 batch.
CREATE TABLE native_integration_alert_reconciliation_fences (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id),
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  actor_email TEXT NOT NULL,
  verified_until TEXT NOT NULL,
  allow_grant_id TEXT NOT NULL REFERENCES native_integration_control_grants(id),
  allow_grant_version INTEGER NOT NULL CHECK(allow_grant_version>=1),
  source_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  expected_source_instance_id TEXT NOT NULL,
  expected_history_epoch TEXT NOT NULL,
  incident_sequence INTEGER NOT NULL,
  claim_sequence INTEGER NOT NULL,
  old_head_revision INTEGER NOT NULL,
  old_state_json TEXT NOT NULL,
  old_alert_revision INTEGER NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('sent','failed')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  reconciled_at INTEGER NOT NULL CHECK(reconciled_at>=0),
  new_state_json TEXT NOT NULL,
  new_next_attempt_at INTEGER NOT NULL,
  FOREIGN KEY(source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch)
    REFERENCES project_alpha_api_v2_incident_heads
      (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch)
);
CREATE TRIGGER native_integration_alert_reconciliation_fence_guard
BEFORE INSERT ON native_integration_alert_reconciliation_fences
WHEN NEW.verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions a
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id
    WHERE a.staff_id=NEW.actor_staff_id AND a.active=1
      AND a.bound_access_subject=NEW.actor_access_subject
      AND a.version=NEW.actor_admission_version AND p.version=NEW.actor_profile_version
      AND p.login_email=NEW.actor_email)
  OR NOT EXISTS(SELECT 1 FROM native_integration_control_grants g
    WHERE g.id=NEW.allow_grant_id AND g.version=NEW.allow_grant_version
      AND g.actor_staff_id=NEW.actor_staff_id AND g.capability='integrations.alerts.reconcile'
      AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
  OR EXISTS(SELECT 1 FROM native_integration_control_grants g
    WHERE g.actor_staff_id=NEW.actor_staff_id AND g.capability='integrations.alerts.reconcile'
      AND g.effect='deny' AND g.scope_kind='global' AND g.active=1)
  OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_incident_heads h
    WHERE h.source_id=NEW.source_id AND h.application_id=NEW.application_id
      AND h.base_url=NEW.base_url AND h.expected_source_instance_id=NEW.expected_source_instance_id
      AND h.expected_history_epoch=NEW.expected_history_epoch
      AND h.revision=NEW.old_head_revision AND h.state_json=NEW.old_state_json
      AND json_extract(h.state_json,'$.incidentSequence')=NEW.incident_sequence
      AND json_extract(h.state_json,'$.alertClaimSequence')=NEW.claim_sequence
      AND json_extract(h.state_json,'$.unhealthySince') IS NOT NULL
      AND json_extract(h.state_json,'$.alertClaimedAt') IS NOT NULL
      AND json_extract(h.state_json,'$.alertAttemptedAt') IS NOT NULL
      AND json_extract(h.state_json,'$.alertSentAt') IS NULL
      AND json_extract(h.state_json,'$.category') NOT IN ('verified','disabled'))
  OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_incident_alerts a
    WHERE a.source_id=NEW.source_id AND a.application_id=NEW.application_id
      AND a.base_url=NEW.base_url AND a.expected_source_instance_id=NEW.expected_source_instance_id
      AND a.expected_history_epoch=NEW.expected_history_epoch
      AND a.incident_sequence=NEW.incident_sequence AND a.claim_sequence=NEW.claim_sequence
      AND a.revision=NEW.old_alert_revision AND a.status='leased'
      AND a.lease_token=NEW.lease_token AND a.lease_expires_at=NEW.lease_expires_at
      AND a.lease_expires_at<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
      AND a.attempt_count=NEW.attempt_count AND a.attempt_count>=1
      AND a.next_attempt_at=NEW.next_attempt_at AND a.sent_at IS NULL)
BEGIN SELECT RAISE(ABORT,'native alert reconciliation fence denied'); END;
CREATE TRIGGER native_integration_alert_reconciliation_fence_no_update
BEFORE UPDATE ON native_integration_alert_reconciliation_fences
BEGIN SELECT RAISE(ABORT,'native alert reconciliation fence immutable'); END;
CREATE TRIGGER native_integration_alert_reconciliation_fence_no_delete
BEFORE DELETE ON native_integration_alert_reconciliation_fences
BEGIN SELECT RAISE(ABORT,'native alert reconciliation fence immutable'); END;

CREATE TABLE native_integration_alert_reconciliation_commands (
  command_id TEXT PRIMARY KEY REFERENCES native_integration_alert_reconciliation_fences(command_id),
  request_sha256 TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL,
  actor_access_subject TEXT NOT NULL,
  source_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  expected_source_instance_id TEXT NOT NULL,
  expected_history_epoch TEXT NOT NULL,
  incident_sequence INTEGER NOT NULL,
  claim_sequence INTEGER NOT NULL,
  old_head_revision INTEGER NOT NULL,
  new_head_revision INTEGER NOT NULL,
  old_alert_revision INTEGER NOT NULL,
  new_alert_revision INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('sent','failed')),
  reason TEXT NOT NULL,
  reconciled_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_integration_alert_reconciliation_receipt_guard
BEFORE INSERT ON native_integration_alert_reconciliation_commands
WHEN NOT EXISTS(SELECT 1 FROM native_integration_alert_reconciliation_fences f
  JOIN project_alpha_api_v2_incident_heads h ON h.source_id=f.source_id
    AND h.application_id=f.application_id AND h.base_url=f.base_url
    AND h.expected_source_instance_id=f.expected_source_instance_id
    AND h.expected_history_epoch=f.expected_history_epoch
  JOIN project_alpha_api_v2_incident_alerts a ON a.source_id=f.source_id
    AND a.application_id=f.application_id AND a.base_url=f.base_url
    AND a.expected_source_instance_id=f.expected_source_instance_id
    AND a.expected_history_epoch=f.expected_history_epoch AND a.incident_sequence=f.incident_sequence
  JOIN project_alpha_api_v2_incident_alert_events e ON e.source_id=f.source_id
    AND e.application_id=f.application_id AND e.base_url=f.base_url
    AND e.expected_source_instance_id=f.expected_source_instance_id
    AND e.expected_history_epoch=f.expected_history_epoch AND e.incident_sequence=f.incident_sequence
    AND e.alert_revision=f.old_alert_revision+1
  WHERE f.command_id=NEW.command_id AND f.request_sha256=NEW.request_sha256
    AND f.actor_staff_id=NEW.actor_staff_id AND f.actor_access_subject=NEW.actor_access_subject
    AND f.source_id=NEW.source_id AND f.application_id=NEW.application_id
    AND f.base_url=NEW.base_url AND f.expected_source_instance_id=NEW.expected_source_instance_id
    AND f.expected_history_epoch=NEW.expected_history_epoch
    AND f.incident_sequence=NEW.incident_sequence AND f.claim_sequence=NEW.claim_sequence
    AND f.old_head_revision=NEW.old_head_revision AND f.old_alert_revision=NEW.old_alert_revision
    AND NEW.new_head_revision=f.old_head_revision+1 AND NEW.new_alert_revision=f.old_alert_revision+1
    AND f.outcome=NEW.outcome AND f.reason=NEW.reason AND f.reconciled_at=NEW.reconciled_at
    AND h.revision=NEW.new_head_revision AND h.state_json=f.new_state_json
    AND a.revision=NEW.new_alert_revision AND a.claim_sequence=f.claim_sequence
    AND a.status=CASE f.outcome WHEN 'sent' THEN 'sent' ELSE 'retry' END
    AND a.lease_token IS NULL AND a.lease_expires_at IS NULL
    AND a.next_attempt_at=f.new_next_attempt_at AND a.attempt_count=f.attempt_count
    AND a.sent_at IS CASE f.outcome WHEN 'sent' THEN f.reconciled_at ELSE NULL END
    AND e.head_revision=NEW.new_head_revision AND e.claim_sequence=f.claim_sequence
    AND e.action=f.outcome AND e.occurred_at=f.reconciled_at)
BEGIN SELECT RAISE(ABORT,'native alert reconciliation receipt denied'); END;
CREATE TRIGGER native_integration_alert_reconciliation_receipt_no_update
BEFORE UPDATE ON native_integration_alert_reconciliation_commands
BEGIN SELECT RAISE(ABORT,'native alert reconciliation receipt immutable'); END;
CREATE TRIGGER native_integration_alert_reconciliation_receipt_no_delete
BEFORE DELETE ON native_integration_alert_reconciliation_commands
BEGIN SELECT RAISE(ABORT,'native alert reconciliation receipt immutable'); END;
