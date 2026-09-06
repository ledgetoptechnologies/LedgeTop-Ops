PRAGMA foreign_keys = ON;

-- Rolling per-request/contributor digest generations. Recipient addresses stay
-- in OPS_DB and are resolved only while a generation is being delivered.
CREATE TABLE incoming_upload_notification_digests (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  contributor_id TEXT NOT NULL,
  owner_staff_id TEXT NOT NULL,
  digest_version INTEGER NOT NULL CHECK (digest_version >= 1),
  file_count INTEGER NOT NULL CHECK (file_count >= 1),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','retry','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  quiet_until TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT,
  delivered_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id,contributor_id,digest_version),
  FOREIGN KEY (request_id) REFERENCES file_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (contributor_id) REFERENCES file_request_contributors(id) ON DELETE CASCADE
);

-- One receipt per completed upload makes aggregation idempotent. It stores no
-- filename, contributor email, object key, signed capability, or token.
CREATE TABLE incoming_upload_notification_digest_items (
  upload_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  contributor_id TEXT NOT NULL,
  digest_version INTEGER NOT NULL CHECK (digest_version >= 1),
  file_size INTEGER NOT NULL CHECK (file_size >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (upload_id) REFERENCES file_request_uploads(id) ON DELETE CASCADE,
  FOREIGN KEY (request_id) REFERENCES file_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (contributor_id) REFERENCES file_request_contributors(id) ON DELETE CASCADE
);

CREATE TRIGGER incoming_upload_notification_digest_item_aggregate
AFTER INSERT ON incoming_upload_notification_digest_items
BEGIN
  INSERT INTO incoming_upload_notification_digests(
    id,request_id,contributor_id,owner_staff_id,digest_version,file_count,total_bytes,quiet_until
  )
  SELECT 'incoming-upload-digest:' || NEW.request_id || ':' || NEW.contributor_id || ':v' || NEW.digest_version,
    NEW.request_id,NEW.contributor_id,request.created_by,NEW.digest_version,1,NEW.file_size,datetime('now','+2 minutes')
  FROM file_requests request WHERE request.id=NEW.request_id
  ON CONFLICT(request_id,contributor_id,digest_version) DO UPDATE SET
    owner_staff_id=excluded.owner_staff_id,
    file_count=incoming_upload_notification_digests.file_count+1,
    total_bytes=incoming_upload_notification_digests.total_bytes+excluded.total_bytes,
    quiet_until=datetime('now','+2 minutes'),
    updated_at=datetime('now')
  WHERE incoming_upload_notification_digests.status='pending'
    AND incoming_upload_notification_digests.attempt_count=0;
END;

CREATE INDEX idx_incoming_upload_notification_digests_ready
  ON incoming_upload_notification_digests(status,quiet_until,next_attempt_at,lease_expires_at,created_at);
