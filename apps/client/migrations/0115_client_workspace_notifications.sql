PRAGMA foreign_keys = ON;

-- Notification policy belongs to an authenticated client-workspace grant. It
-- is deliberately unrelated to public shares and never stores a public token.
CREATE TABLE client_folder_notification_preferences (
  logical_grant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','added','removed','both')),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (logical_grant_id,recipient_identity_id),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_identity_id,account_id) REFERENCES client_identity_links(id,account_id) ON DELETE CASCADE
);
CREATE INDEX idx_client_folder_notification_preferences_account
  ON client_folder_notification_preferences(account_id,mode,logical_grant_id);

-- One net-change row is active for an object/grant/recipient during the grace
-- window. baseline/current presence lets an opposite event cancel safely.
CREATE TABLE client_folder_change_notifications (
  id TEXT PRIMARY KEY,
  logical_grant_id TEXT NOT NULL,
  association_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  object_fingerprint TEXT NOT NULL CHECK (length(object_fingerprint)=64),
  r2_key TEXT NOT NULL,
  baseline_present INTEGER NOT NULL CHECK (baseline_present IN (0,1)),
  current_present INTEGER NOT NULL CHECK (current_present IN (0,1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now','+5 minutes')),
  lease_expires_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (association_id) REFERENCES client_folder_associations(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_identity_id,account_id) REFERENCES client_identity_links(id,account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_client_folder_change_notifications_active
  ON client_folder_change_notifications(logical_grant_id,recipient_identity_id,object_fingerprint)
  WHERE status IN ('pending','cancelled','processing');
CREATE INDEX idx_client_folder_change_notifications_ready
  ON client_folder_change_notifications(status,next_attempt_at,lease_expires_at,created_at);

-- Same-origin, per-identity portal notifications. Presentation is bounded and
-- contains no R2 key, absolute path, public share token, or email snapshot.
CREATE TABLE client_portal_notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('files_added','files_removed','request_status','request_reply','estimate_ready','request_completed')),
  source_type TEXT NOT NULL CHECK (source_type IN ('folder_grant','service_request')),
  source_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  action_path TEXT CHECK (action_path IS NULL OR (length(action_path) BETWEEN 1 AND 500 AND substr(action_path,1,1)='/')),
  read_at TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (recipient_identity_id,dedupe_key),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_identity_id,account_id) REFERENCES client_identity_links(id,account_id) ON DELETE CASCADE
);
CREATE INDEX idx_client_portal_notifications_inbox
  ON client_portal_notifications(account_id,recipient_identity_id,dismissed_at,created_at DESC,id DESC);
