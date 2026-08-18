PRAGMA foreign_keys = ON;

-- Authoritative mutation audit is colocated with Viewer client grants so the
-- grant, idempotency receipt, and audit record commit in one D1 batch. The
-- Operations audit_events projection is supplementary and may be retried.
CREATE TABLE IF NOT EXISTS viewer_client_grant_audit (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant.created','grant.revoked')),
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (actor_staff_id,idempotency_key),
  FOREIGN KEY (grant_id) REFERENCES viewer_client_grants(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_viewer_client_grant_audit_grant
  ON viewer_client_grant_audit(grant_id,created_at);
