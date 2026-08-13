PRAGMA foreign_keys = ON;

-- Immutable Project Alpha audience evidence for each staff-created public
-- delivery share version. These rows are notification/audit context only and
-- never authorize access to the bearer link. Applying this migration enables
-- nothing; the Operations feature flag remains the runtime gate.
CREATE TABLE IF NOT EXISTS delivery_share_audience_snapshots (
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL CHECK (share_version >= 1),
  workspace_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL CHECK (owner_scope_type IN ('organization','department','client','project')),
  owner_public_id TEXT NOT NULL,
  directory_generation_id TEXT NOT NULL,
  audience_type TEXT NOT NULL CHECK (audience_type IN ('organization','department','client','project','principal')),
  audience_public_id TEXT NOT NULL,
  audience_display_name TEXT NOT NULL CHECK (length(trim(audience_display_name)) BETWEEN 1 AND 240),
  selected_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (share_id, share_version),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delivery_share_recipient_members (
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL,
  recipient_principal_public_id TEXT NOT NULL,
  recipient_display_name TEXT NOT NULL CHECK (length(trim(recipient_display_name)) BETWEEN 1 AND 240),
  recipient_normalized_email TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(recipient_normalized_email)) BETWEEN 3 AND 320),
  PRIMARY KEY (share_id, share_version, recipient_principal_public_id),
  UNIQUE (share_id, share_version, recipient_normalized_email),
  FOREIGN KEY (share_id, share_version)
    REFERENCES delivery_share_audience_snapshots(share_id, share_version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_delivery_share_audience_latest
  ON delivery_share_audience_snapshots(share_id, share_version DESC);

CREATE TRIGGER IF NOT EXISTS trg_delivery_share_audience_snapshots_no_update
BEFORE UPDATE ON delivery_share_audience_snapshots
BEGIN
  SELECT RAISE(ABORT, 'delivery share audience snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_delivery_share_audience_snapshots_no_delete
BEFORE DELETE ON delivery_share_audience_snapshots
BEGIN
  SELECT RAISE(ABORT, 'delivery share audience snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_delivery_share_recipient_members_no_update
BEFORE UPDATE ON delivery_share_recipient_members
BEGIN
  SELECT RAISE(ABORT, 'delivery share recipient members are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_delivery_share_recipient_members_no_delete
BEFORE DELETE ON delivery_share_recipient_members
BEGIN
  SELECT RAISE(ABORT, 'delivery share recipient members are immutable');
END;
