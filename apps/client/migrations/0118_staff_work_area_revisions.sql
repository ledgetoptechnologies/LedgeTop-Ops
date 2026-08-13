PRAGMA defer_foreign_keys = ON;

-- Staff work-area corrections are immutable overlays. The request's original
-- client geometry remains on the request row and in its submitted revision.
CREATE TABLE client_service_request_area_revisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  base_request_updated_at TEXT NOT NULL,
  area_geojson TEXT CHECK (area_geojson IS NULL OR json_valid(area_geojson)),
  poi_points_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(poi_points_json)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 2000),
  change_summary TEXT NOT NULL CHECK (length(trim(change_summary)) BETWEEN 1 AND 500),
  created_by TEXT NOT NULL,
  mutation_key TEXT NOT NULL CHECK (length(trim(mutation_key)) BETWEEN 16 AND 128),
  mutation_fingerprint TEXT NOT NULL CHECK (length(mutation_fingerprint)=64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id,revision_number),
  UNIQUE (request_id,mutation_key),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);
CREATE INDEX idx_client_request_area_revisions_current
  ON client_service_request_area_revisions(request_id,revision_number DESC);

CREATE TRIGGER client_request_area_revisions_no_update
BEFORE UPDATE ON client_service_request_area_revisions
BEGIN
  SELECT RAISE(ABORT, 'staff work-area revisions are immutable');
END;

CREATE TRIGGER client_request_area_revisions_no_delete
BEFORE DELETE ON client_service_request_area_revisions
BEGIN
  SELECT RAISE(ABORT, 'staff work-area revisions are immutable');
END;

-- A linked Project Alpha artifact is retained for audit, but is no longer a
-- current scope association after the effective work area changes.
ALTER TABLE request_pa_artifacts ADD COLUMN scope_stale_at TEXT;
ALTER TABLE request_pa_artifacts ADD COLUMN scope_stale_area_revision_id TEXT;
CREATE INDEX idx_request_pa_artifacts_scope_stale
  ON request_pa_artifacts(request_id,artifact_type,scope_stale_at)
  WHERE superseded_at IS NULL;

-- Extend the durable email ledger with the staff work-area event while
-- preserving pending/retry/delivery state from every existing notification.
CREATE TABLE client_portal_notification_outbox_next (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('request_submitted','request_status_changed','request_confirmation_requested','request_client_response','request_work_area_changed')),
  status_value TEXT CHECK (status_value IN ('submitted','under_review','accepted_pending_pa_linkage','accepted_linked','declined','cancelled','completed')),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('staff_triage','client_requester')),
  dedupe_key TEXT NOT NULL CHECK (length(trim(dedupe_key)) BETWEEN 1 AND 300),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id,dedupe_key),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);
INSERT INTO client_portal_notification_outbox_next
  (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json,status,
   attempt_count,next_attempt_at,lease_expires_at,last_error,delivered_at,created_at,updated_at)
SELECT id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json,status,
  attempt_count,next_attempt_at,lease_expires_at,last_error,delivered_at,created_at,updated_at
FROM client_portal_notification_outbox;
DROP TABLE client_portal_notification_outbox;
ALTER TABLE client_portal_notification_outbox_next RENAME TO client_portal_notification_outbox;
CREATE INDEX idx_client_portal_notification_outbox_ready
  ON client_portal_notification_outbox(status,next_attempt_at,lease_expires_at,created_at);

-- Give the portal bell a semantic event without changing its request-scoped
-- authorization or exposing geometry coordinates in notification rows.
CREATE TABLE client_portal_notifications_next (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('files_added','files_removed','request_status','request_reply','estimate_ready','request_completed','work_area_changed')),
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
INSERT INTO client_portal_notifications_next
  (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path,read_at,dismissed_at,created_at)
SELECT id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path,read_at,dismissed_at,created_at
FROM client_portal_notifications;
DROP TABLE client_portal_notifications;
ALTER TABLE client_portal_notifications_next RENAME TO client_portal_notifications;
CREATE INDEX idx_client_portal_notifications_inbox
  ON client_portal_notifications(account_id,recipient_identity_id,dismissed_at,created_at DESC,id DESC);

PRAGMA foreign_keys = ON;
