PRAGMA foreign_keys = ON;

-- Native feedback is source-owned and has no legacy account bridge. Keep its
-- in-app completion notice on the same exact source/workspace/principal tuple
-- as the immutable submission. This is intentionally not an email outbox.
CREATE TABLE portal_native_feedback_notifications (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES portal_native_feedback(id),
  feedback_revision INTEGER NOT NULL CHECK (feedback_revision BETWEEN 2 AND 3),
  source_id TEXT NOT NULL CHECK (
    length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,1,14)='project-alpha:'
    AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  workspace_id TEXT NOT NULL REFERENCES portal_v2_workspaces(id),
  recipient_identity_id TEXT NOT NULL REFERENCES portal_v2_identities(id),
  principal_issuer TEXT NOT NULL CHECK (length(principal_issuer) BETWEEN 1 AND 512),
  principal_subject TEXT NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 512),
  read_at TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (feedback_id,feedback_revision)
);

CREATE INDEX portal_native_feedback_notification_inbox
  ON portal_native_feedback_notifications(
    source_id,workspace_id,recipient_identity_id,principal_issuer,principal_subject,dismissed_at,created_at DESC,id DESC);

CREATE TRIGGER portal_native_feedback_notification_completion
BEFORE INSERT ON portal_native_feedback_notifications
WHEN NOT EXISTS (
  SELECT 1 FROM portal_native_feedback feedback
  WHERE feedback.id=NEW.feedback_id
    AND feedback.status='done'
    AND feedback.revision=NEW.feedback_revision
    AND feedback.source_id=NEW.source_id
    AND feedback.workspace_id=NEW.workspace_id
    AND feedback.creator_identity_id=NEW.recipient_identity_id
    AND feedback.principal_issuer=NEW.principal_issuer
    AND feedback.principal_subject=NEW.principal_subject)
BEGIN
  SELECT RAISE(ABORT,'native feedback notification requires the exact completed submission');
END;

CREATE TRIGGER portal_native_feedback_notification_identity_immutable
BEFORE UPDATE ON portal_native_feedback_notifications
WHEN NEW.id IS NOT OLD.id
  OR NEW.feedback_id IS NOT OLD.feedback_id
  OR NEW.feedback_revision IS NOT OLD.feedback_revision
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.recipient_identity_id IS NOT OLD.recipient_identity_id
  OR NEW.principal_issuer IS NOT OLD.principal_issuer
  OR NEW.principal_subject IS NOT OLD.principal_subject
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'native feedback notification identity is immutable');
END;
