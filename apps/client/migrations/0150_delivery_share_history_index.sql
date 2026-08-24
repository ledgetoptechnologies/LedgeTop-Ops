-- Supports stable newest-first keyset pagination for the Operations client-link
-- history without repeatedly sorting the complete share ledger.
CREATE INDEX IF NOT EXISTS idx_shares_created_history
  ON shares(created_at DESC, id DESC);
