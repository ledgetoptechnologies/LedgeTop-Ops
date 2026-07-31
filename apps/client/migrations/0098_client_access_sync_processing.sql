PRAGMA foreign_keys = ON;

-- Delivery records desired client Access membership, but a separate internal
-- worker owns the Cloudflare management credential and dispatches this outbox.
-- This migration grants no user access and calls no external service.
ALTER TABLE client_access_sync_outbox ADD COLUMN lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_client_access_sync_outbox_lease
  ON client_access_sync_outbox(status, next_attempt_at, lease_expires_at, created_at);
