PRAGMA foreign_keys = ON;

-- The private pickup server is the authority for transfer and malware scanning,
-- but Operations owns the user-visible lifecycle.  This is intentionally a
-- small status ledger: no scan output, object key, signed URL, or file bytes
-- are stored here.
ALTER TABLE file_request_uploads ADD COLUMN pickup_state TEXT NOT NULL DEFAULT 'awaiting_pickup'
  CHECK (pickup_state IN ('awaiting_pickup','scanning','retry','accepted','rejected'));
ALTER TABLE file_request_uploads ADD COLUMN pickup_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (pickup_attempt_count >= 0);
ALTER TABLE file_request_uploads ADD COLUMN pickup_last_attempt_at TEXT;
ALTER TABLE file_request_uploads ADD COLUMN pickup_next_attempt_at TEXT;
ALTER TABLE file_request_uploads ADD COLUMN pickup_last_error_code TEXT
  CHECK (pickup_last_error_code IS NULL OR length(pickup_last_error_code) BETWEEN 1 AND 64);
-- A private pickup server must claim an object before it can transfer it.  The
-- opaque token fences its retry/accepted receipts from another server that
-- reclaims a stale attempt.  It is never shown to staff or clients.
ALTER TABLE file_request_uploads ADD COLUMN pickup_claim_token TEXT;
ALTER TABLE file_request_uploads ADD COLUMN pickup_lease_expires_at TEXT;

-- Backfill terminal rows so staff never see an accepted/rejected record as
-- merely pending after a rolling deployment.
UPDATE file_request_uploads
SET pickup_state = CASE status
  WHEN 'accepted' THEN 'accepted'
  WHEN 'rejected' THEN 'rejected'
  ELSE 'awaiting_pickup'
END;

CREATE INDEX IF NOT EXISTS idx_file_request_uploads_pickup_lifecycle
  ON file_request_uploads(status,pickup_state,pickup_next_attempt_at,pickup_lease_expires_at,created_at);
