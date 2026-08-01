PRAGMA foreign_keys = ON;

-- A portal grant records the exact share_version approved by staff, but it
-- must not make that mutable parent column a foreign-key target. The delivery
-- service increments share_version to invalidate sessions whenever a link is
-- rotated, revoked, or its source changes. Keeping the version in the FK would
-- block those existing fail-closed updates as soon as any portal grant exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_portal_parent_key
  ON shares(id, project_id);

CREATE TABLE client_delivery_grants_next (
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL CHECK (share_version >= 1),
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (account_id, share_id),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id) REFERENCES client_project_grants(account_id, project_id),
  FOREIGN KEY (share_id, project_id) REFERENCES shares(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES staff_users(id)
);

INSERT INTO client_delivery_grants_next
  (account_id,project_id,share_id,share_version,granted_by,granted_at,expires_at,revoked_at)
SELECT account_id,project_id,share_id,share_version,granted_by,granted_at,expires_at,revoked_at
FROM client_delivery_grants;

DROP TABLE client_delivery_grants;
ALTER TABLE client_delivery_grants_next RENAME TO client_delivery_grants;

CREATE INDEX idx_client_delivery_grants_project
  ON client_delivery_grants(account_id, project_id, revoked_at, expires_at);

CREATE INDEX idx_client_delivery_grants_share
  ON client_delivery_grants(share_id, share_version, revoked_at);
