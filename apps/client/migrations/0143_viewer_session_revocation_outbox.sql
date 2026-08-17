PRAGMA foreign_keys = ON;

-- Association version changes must revoke every Viewer grant/session issued
-- from the superseded authorization. Delivery D1 owns this durable outbox so
-- the association mutation, its idempotency receipt, and the revocation intent
-- can commit in one database batch. Operations delivers the intent over the
-- signed Viewer service contract and retries it until acknowledged.
CREATE TABLE IF NOT EXISTS viewer_session_revocation_outbox (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  association_version INTEGER NOT NULL CHECK (association_version >= 1),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  UNIQUE (association_id,association_version),
  FOREIGN KEY (association_id) REFERENCES viewer_model_associations(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_viewer_session_revocation_pending
  ON viewer_session_revocation_outbox(state,next_attempt_at,created_at);
