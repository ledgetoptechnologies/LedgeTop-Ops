PRAGMA foreign_keys = ON;

-- Verification is deliberately independent from the existing pickup lifecycle:
-- a clean scan attests to an exact R2 object but does not accept, publish, or
-- delete it.  Existing accepted rows predate this proof and remain server-only.
ALTER TABLE file_request_uploads ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'awaiting_verification'
  CHECK (verification_state IN ('awaiting_verification','scanning','retry','verified','rejected','server_only'));
ALTER TABLE file_request_uploads ADD COLUMN verification_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (verification_attempt_count >= 0);
ALTER TABLE file_request_uploads ADD COLUMN verification_last_attempt_at TEXT;
ALTER TABLE file_request_uploads ADD COLUMN verification_next_attempt_at TEXT;
ALTER TABLE file_request_uploads ADD COLUMN verification_last_error_code TEXT
  CHECK (verification_last_error_code IS NULL OR length(verification_last_error_code) BETWEEN 1 AND 64);
ALTER TABLE file_request_uploads ADD COLUMN verification_claim_token TEXT;
ALTER TABLE file_request_uploads ADD COLUMN verification_lease_expires_at TEXT;
ALTER TABLE file_request_uploads ADD COLUMN verification_receipt_token TEXT;
ALTER TABLE file_request_uploads ADD COLUMN verified_object_etag TEXT;
ALTER TABLE file_request_uploads ADD COLUMN verified_object_bytes INTEGER;
ALTER TABLE file_request_uploads ADD COLUMN verified_object_version TEXT;
ALTER TABLE file_request_uploads ADD COLUMN verified_at TEXT;

UPDATE file_request_uploads
SET verification_state = CASE status
  WHEN 'accepted' THEN 'server_only'
  WHEN 'rejected' THEN 'rejected'
  ELSE 'awaiting_verification'
END;

CREATE INDEX IF NOT EXISTS idx_file_request_uploads_verification_lifecycle
  ON file_request_uploads(status,verification_state,verification_next_attempt_at,verification_lease_expires_at,created_at);
