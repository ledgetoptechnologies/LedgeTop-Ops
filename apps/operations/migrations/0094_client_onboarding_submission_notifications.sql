PRAGMA foreign_keys = ON;

-- A submission stages exactly one review event. Historical submissions are not
-- backfilled: notification rollout is deliberately independent of approval.
CREATE TABLE client_onboarding_review_notification_events (
  submission_id TEXT PRIMARY KEY REFERENCES client_onboarding_submissions(submission_id) ON DELETE RESTRICT,
  invitation_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  sealed_at TEXT,
  CHECK(sealed_at IS NULL OR sealed_at >= created_at)
);
CREATE TRIGGER client_onboarding_review_notification_stage AFTER INSERT ON client_onboarding_submissions
BEGIN
  INSERT INTO client_onboarding_review_notification_events(submission_id,invitation_id,created_at)
  VALUES(NEW.submission_id,NEW.invitation_id,NEW.created_at);
END;
CREATE TRIGGER client_onboarding_review_notification_event_no_delete BEFORE DELETE ON client_onboarding_review_notification_events
BEGIN SELECT RAISE(ABORT,'notification event is durable'); END;
CREATE TRIGGER client_onboarding_review_notification_event_guard BEFORE UPDATE ON client_onboarding_review_notification_events
WHEN NEW.submission_id IS NOT OLD.submission_id OR NEW.invitation_id IS NOT OLD.invitation_id
  OR NEW.created_at IS NOT OLD.created_at OR OLD.sealed_at IS NOT NULL OR NEW.sealed_at IS NULL
BEGIN SELECT RAISE(ABORT,'notification event is immutable'); END;

CREATE TABLE client_onboarding_review_notification_recipients (
  submission_id TEXT NOT NULL REFERENCES client_onboarding_review_notification_events(submission_id) ON DELETE RESTRICT,
  staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  admission_version INTEGER NOT NULL CHECK(admission_version>0),
  profile_version INTEGER NOT NULL CHECK(profile_version>0),
  recipient_email TEXT NOT NULL CHECK(length(recipient_email) BETWEEN 3 AND 254 AND instr(recipient_email,char(0))=0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','sent','suppressed','reconciliation_required')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  next_attempt_at TEXT,
  lease_token TEXT,
  lease_until TEXT,
  attempted_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(submission_id,staff_id),
  CHECK((state='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state<>'leased' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK(sent_at IS NULL OR state='sent')
);
CREATE INDEX client_onboarding_review_notification_due ON client_onboarding_review_notification_recipients(state,next_attempt_at,submission_id);
CREATE TRIGGER client_onboarding_review_notification_recipient_no_delete BEFORE DELETE ON client_onboarding_review_notification_recipients
BEGIN SELECT RAISE(ABORT,'notification recipient is durable'); END;
CREATE TRIGGER client_onboarding_review_notification_recipient_guard BEFORE UPDATE ON client_onboarding_review_notification_recipients
WHEN NEW.submission_id IS NOT OLD.submission_id OR NEW.staff_id IS NOT OLD.staff_id
  OR NEW.admission_version IS NOT OLD.admission_version OR NEW.profile_version IS NOT OLD.profile_version
  OR NEW.recipient_email IS NOT OLD.recipient_email OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version <> OLD.version+1
BEGIN SELECT RAISE(ABORT,'notification recipient identity is immutable'); END;
