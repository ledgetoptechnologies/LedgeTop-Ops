PRAGMA foreign_keys = ON;

-- One editable grace window per exact legacy grant/recipient. Once sealed,
-- retries retain the same content and newly arriving changes use a successor.
CREATE TABLE client_folder_notification_batches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  logical_grant_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  association_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','cancelled','suppressed','failed')),
  eligible_at TEXT NOT NULL DEFAULT (datetime('now','+5 minutes')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sealed_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  added_count INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  removed_count INTEGER NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  dispatch_fingerprint TEXT CHECK (dispatch_fingerprint IS NULL OR length(dispatch_fingerprint)=64),
  published_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_identity_id,account_id) REFERENCES client_identity_links(id,account_id) ON DELETE CASCADE,
  FOREIGN KEY (association_id) REFERENCES client_folder_associations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_client_folder_notification_batches_open
  ON client_folder_notification_batches(account_id,logical_grant_id,recipient_identity_id)
  WHERE status='pending' AND sealed_at IS NULL;
CREATE INDEX idx_client_folder_notification_batches_ready
  ON client_folder_notification_batches(status,eligible_at,lease_expires_at,id);
CREATE INDEX idx_client_folder_notification_batches_history
  ON client_folder_notification_batches(created_at DESC,id DESC);
CREATE INDEX idx_client_folder_notification_batches_account
  ON client_folder_notification_batches(account_id,created_at DESC,id DESC);

CREATE TABLE client_folder_notification_batch_items (
  batch_id TEXT NOT NULL,
  object_fingerprint TEXT NOT NULL CHECK (length(object_fingerprint)=64),
  r2_key TEXT NOT NULL,
  baseline_present INTEGER NOT NULL CHECK (baseline_present IN (0,1)),
  current_present INTEGER NOT NULL CHECK (current_present IN (0,1)),
  event_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (batch_id,object_fingerprint),
  FOREIGN KEY (batch_id) REFERENCES client_folder_notification_batches(id) ON DELETE CASCADE
);

-- Last observed state is independent of delivery status: a retried R2 event
-- must not resurrect a cancelled/sent batch or reset its grace window.
CREATE TABLE client_folder_notification_object_state (
  account_id TEXT NOT NULL,
  logical_grant_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  object_fingerprint TEXT NOT NULL CHECK (length(object_fingerprint)=64),
  current_present INTEGER NOT NULL CHECK (current_present IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id,logical_grant_id,recipient_identity_id,object_fingerprint),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_identity_id,account_id) REFERENCES client_identity_links(id,account_id) ON DELETE CASCADE
);
CREATE INDEX idx_client_folder_notification_batch_items_event
  ON client_folder_notification_batch_items(event_token,batch_id);
CREATE INDEX idx_client_folder_change_notifications_object_history
  ON client_folder_change_notifications(account_id,logical_grant_id,recipient_identity_id,object_fingerprint,updated_at DESC,id DESC);
