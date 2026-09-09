PRAGMA foreign_keys = ON;

-- One bounded state row tracks the hourly delegated-share expiry reconciler.
-- It is operational metadata only: it grants no access and changes no expiry
-- decision. active_run_id fences overlapping cron completions.
CREATE TABLE client_delegated_share_expiry_health (
  id TEXT PRIMARY KEY CHECK(id='client-delegated-share-expiry'),
  last_run_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT CHECK(last_error_code IS NULL OR last_error_code IN ('schema-unavailable','reconcile-failed')),
  last_shares_expired INTEGER NOT NULL DEFAULT 0 CHECK(last_shares_expired>=0),
  last_delegations_expired INTEGER NOT NULL DEFAULT 0 CHECK(last_delegations_expired>=0),
  shares_at_limit INTEGER NOT NULL DEFAULT 0 CHECK(shares_at_limit IN (0,1)),
  delegations_at_limit INTEGER NOT NULL DEFAULT 0 CHECK(delegations_at_limit IN (0,1)),
  active_run_id TEXT,
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
