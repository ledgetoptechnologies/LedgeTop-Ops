PRAGMA foreign_keys = ON;

-- Expiry reconciliation is a bounded maintenance scan. These partial indexes
-- keep elapsed live rows at the front without adding write cost to unrelated
-- delegated-share history.
CREATE INDEX IF NOT EXISTS idx_client_delegated_shares_expiry_pending
  ON client_delegated_shares(expires_at, id)
  WHERE status IN ('pending_signer','active') AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_client_share_delegations_expiry_pending
  ON client_share_delegations(expires_at, id)
  WHERE status IN ('active','suspended') AND revoked_at IS NULL;

-- One deterministic event is retained for each materialized expiry. The event
-- ledger is already update-immutable; these indexes additionally make an
-- accidentally retried expiry insert harmless at the database boundary.
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_delegated_share_expired_event
  ON client_delegated_share_events(share_id, event_type)
  WHERE share_id IS NOT NULL AND event_type='client_share.expired';

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_share_delegation_expired_event
  ON client_delegated_share_events(delegation_id, event_type)
  WHERE delegation_id IS NOT NULL AND share_id IS NULL
    AND event_type='delegation.expired';
