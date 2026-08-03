PRAGMA foreign_keys = ON;

-- Direct client-workspace grants are immutable versions. Existing project and
-- client associations remain valid and have NULL logical_grant_id values.
ALTER TABLE client_folder_associations ADD COLUMN logical_grant_id TEXT;
ALTER TABLE client_folder_associations ADD COLUMN grant_version INTEGER NOT NULL DEFAULT 1 CHECK (grant_version >= 1);
ALTER TABLE client_folder_associations ADD COLUMN division_id TEXT;
ALTER TABLE client_folder_associations ADD COLUMN superseded_by_id TEXT;

CREATE UNIQUE INDEX idx_client_folder_associations_active_logical_grant
  ON client_folder_associations(logical_grant_id)
  WHERE logical_grant_id IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX idx_client_folder_associations_logical_version
  ON client_folder_associations(logical_grant_id,grant_version)
  WHERE logical_grant_id IS NOT NULL;

-- A separate mutation ledger makes exact retries deterministic even when the
-- requested prefix was already active and no new association row was needed.
CREATE TABLE client_folder_grant_mutations (
  account_id TEXT NOT NULL,
  mutation_key TEXT NOT NULL CHECK (length(trim(mutation_key)) BETWEEN 16 AND 128),
  mutation_fingerprint TEXT NOT NULL CHECK (length(mutation_fingerprint)=64),
  logical_grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK (grant_version >= 1),
  association_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id,mutation_key),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (association_id) REFERENCES client_folder_associations(id) ON DELETE CASCADE
);

-- Internal-grant mail is deliberately separate from public-share mail. Each
-- row identifies one exact immutable grant version and one authenticated
-- recipient identity; no public link or address snapshot is stored.
CREATE TABLE client_folder_grant_notifications (
  id TEXT PRIMARY KEY,
  logical_grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK (grant_version >= 1),
  association_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  prior_coverage_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(prior_coverage_json) AND json_type(prior_coverage_json)='array'),
  event_type TEXT NOT NULL DEFAULT 'access_granted' CHECK (event_type='access_granted'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now','+5 minutes')),
  lease_expires_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (association_id,recipient_identity_id,event_type)
);

CREATE INDEX idx_client_folder_grant_notifications_ready
  ON client_folder_grant_notifications(status,next_attempt_at,lease_expires_at,created_at);
