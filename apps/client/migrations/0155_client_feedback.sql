PRAGMA foreign_keys = ON;

-- Feedback references a canonical target and immutable ownership snapshot, not
-- a public share token or a short-lived encrypted browser handle. It survives
-- media removal. No migration grants access, creates mail, or copies binaries.
CREATE TABLE client_feedback (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  workspace_id TEXT,
  creator_identity_id TEXT NOT NULL,
  creator_workspace_identity_id TEXT,
  principal_issuer TEXT NOT NULL CHECK (length(principal_issuer) BETWEEN 1 AND 512),
  principal_subject TEXT NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 512),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('project','folder','file')),
  project_id TEXT,
  target_json TEXT NOT NULL CHECK (json_valid(target_json) AND json_type(target_json)='object'),
  target_fingerprint TEXT NOT NULL CHECK (length(target_fingerprint)=64),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 5000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','done')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 3),
  completion_note TEXT CHECK (completion_note IS NULL OR length(completion_note) BETWEEN 1 AND 2000),
  completed_at TEXT,
  completed_by_staff_id TEXT,
  mutation_key TEXT NOT NULL CHECK (length(mutation_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (scope_key,principal_issuer,principal_subject,mutation_key),
  UNIQUE (id,account_id),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id),
  FOREIGN KEY (creator_identity_id,account_id) REFERENCES client_identity_links(id,account_id),
  CHECK ((workspace_id IS NULL AND creator_workspace_identity_id IS NULL AND scope_key='account:'||account_id)
    OR (workspace_id IS NOT NULL AND creator_workspace_identity_id IS NOT NULL AND scope_key='workspace:'||workspace_id)),
  CHECK ((target_kind='file') OR project_id IS NOT NULL),
  CHECK ((status='done' AND completed_at IS NOT NULL AND completed_by_staff_id IS NOT NULL)
    OR (status<>'done' AND completion_note IS NULL AND completed_at IS NULL AND completed_by_staff_id IS NULL))
);
CREATE INDEX idx_client_feedback_author
  ON client_feedback(scope_key,principal_issuer,principal_subject,created_at DESC,id DESC);
CREATE INDEX idx_client_feedback_status
  ON client_feedback(status,created_at,id);
CREATE INDEX idx_client_feedback_chronological
  ON client_feedback(created_at,id);
CREATE INDEX idx_client_feedback_account_chronological
  ON client_feedback(account_id,created_at,id);
CREATE INDEX idx_client_feedback_account_status
  ON client_feedback(account_id,status,created_at,id);
CREATE INDEX idx_client_feedback_project
  ON client_feedback(account_id,project_id,status,created_at,id);

CREATE TRIGGER client_feedback_immutable_target
BEFORE UPDATE ON client_feedback
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.scope_key IS NOT OLD.scope_key
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.creator_identity_id IS NOT OLD.creator_identity_id
  OR NEW.creator_workspace_identity_id IS NOT OLD.creator_workspace_identity_id
  OR NEW.principal_issuer IS NOT OLD.principal_issuer OR NEW.principal_subject IS NOT OLD.principal_subject
  OR NEW.target_kind IS NOT OLD.target_kind OR NEW.project_id IS NOT OLD.project_id
  OR NEW.target_json IS NOT OLD.target_json OR NEW.target_fingerprint IS NOT OLD.target_fingerprint
  OR NEW.message IS NOT OLD.message OR NEW.mutation_key IS NOT OLD.mutation_key
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'feedback identity and submission are immutable');
END;
CREATE TRIGGER client_feedback_monotonic_lifecycle
BEFORE UPDATE ON client_feedback
WHEN NEW.revision<>OLD.revision+1 OR NOT (
  (OLD.status='new' AND NEW.status IN ('in_progress','done')) OR
  (OLD.status='in_progress' AND NEW.status='done'))
BEGIN
  SELECT RAISE(ABORT,'feedback lifecycle transition is invalid');
END;

CREATE TABLE client_feedback_events (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES client_feedback(id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 3),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('client','staff')),
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new','in_progress','done')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (feedback_id,revision)
);
CREATE TRIGGER client_feedback_event_no_update BEFORE UPDATE ON client_feedback_events
BEGIN
  SELECT RAISE(ABORT,'feedback events are immutable');
END;
CREATE TRIGGER client_feedback_event_no_delete BEFORE DELETE ON client_feedback_events
BEGIN
  SELECT RAISE(ABORT,'feedback events are immutable');
END;

CREATE TABLE client_feedback_mutations (
  actor_staff_id TEXT NOT NULL,
  mutation_key TEXT NOT NULL CHECK (length(mutation_key) BETWEEN 16 AND 128),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64),
  feedback_id TEXT NOT NULL REFERENCES client_feedback(id),
  result_revision INTEGER NOT NULL CHECK (result_revision BETWEEN 2 AND 3),
  result_status TEXT NOT NULL CHECK (result_status IN ('in_progress','done')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (actor_staff_id,mutation_key)
);
CREATE TRIGGER client_feedback_mutation_result BEFORE INSERT ON client_feedback_mutations
WHEN NOT EXISTS (SELECT 1 FROM client_feedback WHERE id=NEW.feedback_id
  AND revision=NEW.result_revision AND status=NEW.result_status)
BEGIN
  SELECT RAISE(ABORT,'feedback mutation requires an applied transition');
END;

-- A creator-specific in-app notice is durable immediately, independently of
-- transport availability. Readers still reauthorize the original workspace and
-- target. Existing notification tables and their CHECK constraints are intact.
CREATE TABLE client_feedback_notifications (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES client_feedback(id),
  feedback_revision INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  workspace_id TEXT,
  workspace_identity_id TEXT,
  read_at TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (feedback_id,feedback_revision),
  FOREIGN KEY (feedback_id,account_id) REFERENCES client_feedback(id,account_id),
  FOREIGN KEY (recipient_identity_id,account_id) REFERENCES client_identity_links(id,account_id)
);
CREATE INDEX idx_client_feedback_notification_inbox
  ON client_feedback_notifications(account_id,recipient_identity_id,dismissed_at,created_at DESC,id DESC);
CREATE TRIGGER client_feedback_notification_completion BEFORE INSERT ON client_feedback_notifications
WHEN NOT EXISTS (SELECT 1 FROM client_feedback feedback WHERE feedback.id=NEW.feedback_id
  AND feedback.status='done' AND feedback.revision=NEW.feedback_revision AND feedback.account_id=NEW.account_id
  AND feedback.creator_identity_id=NEW.recipient_identity_id AND feedback.workspace_id IS NEW.workspace_id
  AND feedback.creator_workspace_identity_id IS NEW.workspace_identity_id)
BEGIN
  SELECT RAISE(ABORT,'feedback notification requires the exact completed submission');
END;

CREATE TABLE client_feedback_notification_outbox (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL UNIQUE REFERENCES client_feedback_notifications(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  lease_token TEXT,
  lease_expires_at TEXT,
  dispatch_fingerprint TEXT CHECK (dispatch_fingerprint IS NULL OR length(dispatch_fingerprint)=64),
  error_code TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'processing' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX idx_client_feedback_outbox_pending
  ON client_feedback_notification_outbox(status,next_attempt_at,lease_expires_at,id);
