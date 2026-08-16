PRAGMA foreign_keys = ON;

-- Processing is a separately gated Viewer subsystem. Model viewing does not
-- imply access to raw datasets, provider controls, publication, or storage.
INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('viewer.datasets.manage','Create, finalize, and import administrative Viewer datasets'),
  ('viewer.processing.manage','Configure providers and manage Viewer processing attempts'),
  ('viewer.publish','Review and publish selected derived Viewer outputs'),
  ('viewer.storage.purge','Permanently purge unreferenced Viewer storage after impact review');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT role.id,permission.key
FROM roles role
CROSS JOIN permissions permission
WHERE role.id IN ('role-owner','role-admin')
  AND permission.key IN ('viewer.datasets.manage','viewer.processing.manage','viewer.publish');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT 'role-owner',key FROM permissions WHERE key='viewer.storage.purge';

CREATE TABLE viewer_staff_preferences (
  staff_id TEXT PRIMARY KEY,
  display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(staff_id) REFERENCES staff_users(id) ON DELETE CASCADE
);

-- A nonce is consumed before a callback is accepted. Event ids provide the
-- durable semantic idempotency boundary independently of nonce replay checks.
CREATE TABLE viewer_event_nonces (
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(key_id,nonce)
);
CREATE INDEX viewer_event_nonces_expiry_idx ON viewer_event_nonces(expires_at);

CREATE TABLE viewer_processing_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('processing.ready_for_review','processing.failed')),
  occurred_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  requested_by_subject TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  review_url TEXT,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(length(payload_json)<=16384),
  acknowledged_at TEXT,
  acknowledged_by_staff_id TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(acknowledged_by_staff_id) REFERENCES staff_users(id)
);
CREATE INDEX viewer_processing_events_inbox_idx
  ON viewer_processing_events(acknowledged_at,received_at DESC);
CREATE INDEX viewer_processing_events_attempt_idx
  ON viewer_processing_events(attempt_id,received_at DESC);

CREATE TABLE viewer_processing_notification_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(event_id) REFERENCES viewer_processing_events(event_id) ON DELETE CASCADE
);
CREATE INDEX viewer_processing_notification_queue_idx
  ON viewer_processing_notification_outbox(status,next_attempt_at,lease_expires_at,created_at);
