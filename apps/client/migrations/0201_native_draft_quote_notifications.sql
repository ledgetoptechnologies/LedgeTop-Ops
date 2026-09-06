PRAGMA defer_foreign_keys = ON;

-- Native Project Alpha draft notices are in-app only. Preserve every legacy
-- outbox/inbox row while allowing the source-bound native recipient intent.
-- Preserve rowid too: notification-history cursors pin a rowid high-water mark.
-- Compacting surviving rows would admit newer rows into an older snapshot.
CREATE TABLE client_portal_notification_outbox_next (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('request_submitted','request_status_changed','request_confirmation_requested','request_client_response','request_work_area_changed','pa_draft_quote_created')),
  status_value TEXT CHECK (status_value IN ('submitted','under_review','accepted_pending_pa_linkage','accepted_linked','declined','cancelled','completed')),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('staff_triage','client_requester','native_request_owner')),
  dedupe_key TEXT NOT NULL CHECK (length(trim(dedupe_key)) BETWEEN 1 AND 300),payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','suppressed','failed')),attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),next_attempt_at TEXT NOT NULL DEFAULT(datetime('now')),lease_expires_at TEXT,last_error TEXT,delivered_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(request_id,dedupe_key),FOREIGN KEY(request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE);
INSERT INTO client_portal_notification_outbox_next (
  rowid,id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json,
  status,attempt_count,next_attempt_at,lease_expires_at,last_error,delivered_at,
  created_at,updated_at
) SELECT
  rowid,id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json,
  status,attempt_count,next_attempt_at,lease_expires_at,last_error,delivered_at,
  created_at,updated_at
FROM client_portal_notification_outbox;
DROP TABLE client_portal_notification_outbox; ALTER TABLE client_portal_notification_outbox_next RENAME TO client_portal_notification_outbox;
CREATE INDEX idx_client_portal_notification_outbox_ready ON client_portal_notification_outbox(status,next_attempt_at,lease_expires_at,created_at);

CREATE TABLE client_portal_notifications_next (
  id TEXT PRIMARY KEY,account_id TEXT NOT NULL,recipient_identity_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('files_added','files_removed','request_status','request_reply','estimate_ready','request_completed','work_area_changed','pa_draft_quote_created')),
  source_type TEXT NOT NULL CHECK (source_type IN ('folder_grant','service_request')),source_id TEXT NOT NULL,dedupe_key TEXT NOT NULL,title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),action_path TEXT CHECK(action_path IS NULL OR(length(action_path) BETWEEN 1 AND 500 AND substr(action_path,1,1)='/')),read_at TEXT,dismissed_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(recipient_identity_id,dedupe_key),FOREIGN KEY(account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,FOREIGN KEY(recipient_identity_id,account_id) REFERENCES client_identity_links(id,account_id) ON DELETE CASCADE);
INSERT INTO client_portal_notifications_next (
  rowid,id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,
  title,body,action_path,read_at,dismissed_at,created_at
) SELECT
  rowid,id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,
  title,body,action_path,read_at,dismissed_at,created_at
FROM client_portal_notifications;
DROP TABLE client_portal_notifications; ALTER TABLE client_portal_notifications_next RENAME TO client_portal_notifications;
CREATE INDEX idx_client_portal_notifications_inbox ON client_portal_notifications(account_id,recipient_identity_id,dismissed_at,created_at DESC,id DESC);
PRAGMA foreign_keys = ON;
