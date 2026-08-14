PRAGMA foreign_keys = ON;

-- Browser-safe presentation data is kept separate from the server-only target
-- row so neither list API ever needs to serialize relative R2 prefixes.
CREATE TABLE IF NOT EXISTS client_share_folder_target_labels (
  target_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (target_id, workspace_id),
  FOREIGN KEY (target_id, workspace_id)
    REFERENCES client_share_folder_targets(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_share_target_labels_workspace
  ON client_share_folder_target_labels(workspace_id, display_name COLLATE NOCASE, target_id);

-- Location disclosure is a staff-owned delegation policy. Keeping it in a
-- separate row makes upgrades fail closed: delegations created before this
-- migration have no row and therefore cannot expose mapped locations.
CREATE TABLE IF NOT EXISTS client_share_delegation_policies (
  delegation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  image_location_map_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (image_location_map_enabled IN (0,1)),
  created_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (delegation_id, workspace_id),
  FOREIGN KEY (delegation_id, workspace_id)
    REFERENCES client_share_delegations(id, workspace_id) ON DELETE CASCADE
);

-- Staff mutations use this append-only receipt table for safe retries. The
-- request fingerprint prevents one key from being reused for a different
-- target/delegation mutation.
CREATE TABLE IF NOT EXISTS client_delegated_share_staff_mutations (
  idempotency_key TEXT PRIMARY KEY
    CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  workspace_id TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'target.create','target.revoke','delegation.create',
    'delegation.transfer','delegation.revoke'
  )),
  entity_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=43),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_delegated_staff_mutations_scope
  ON client_delegated_share_staff_mutations(workspace_id, created_at DESC);
