PRAGMA foreign_keys = ON;

-- Project Alpha portal-v2 projection inbox. Applying this migration does not
-- enable the receiver or the client hierarchy feature.
CREATE TABLE IF NOT EXISTS pa_portal_projection_generations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 100),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 1 AND 2000),
  workspace_root_type TEXT NOT NULL CHECK (workspace_root_type IN ('organization','standalone_client')),
  workspace_root_public_id TEXT NOT NULL,
  workspace_display_name TEXT NOT NULL,
  workspace_source_version TEXT NOT NULL,
  workspace_active INTEGER NOT NULL CHECK (workspace_active IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('staging','active','superseded','rejected')),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, source_generation),
  UNIQUE (workspace_id, source_sequence)
);

CREATE TABLE IF NOT EXISTS pa_portal_projection_pages (
  generation_id TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number BETWEEN 1 AND 100),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 100),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  PRIMARY KEY (generation_id, page_number),
  FOREIGN KEY (generation_id) REFERENCES pa_portal_projection_generations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pa_portal_projection_entities (
  generation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('organization','standalone_client','department','client','project','contact')),
  public_id TEXT NOT NULL,
  parent_public_id TEXT,
  display_name TEXT NOT NULL,
  source_version TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  primary_contact INTEGER NOT NULL DEFAULT 0 CHECK (primary_contact IN (0,1)),
  PRIMARY KEY (generation_id, entity_type, public_id),
  FOREIGN KEY (generation_id) REFERENCES pa_portal_projection_generations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pa_portal_projection_principals (
  generation_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  email_hint TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  source_version TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  PRIMARY KEY (generation_id, public_id),
  UNIQUE (generation_id, email_hint),
  FOREIGN KEY (generation_id) REFERENCES pa_portal_projection_generations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pa_portal_projection_entitlements (
  generation_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN (
    'workspace.view','directory.read','delivery.view','request.create',
    'member.manage','delegated_share.create'
  )),
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace','organization','department','client','project')),
  scope_public_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  valid_from TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (generation_id, public_id),
  FOREIGN KEY (generation_id) REFERENCES pa_portal_projection_generations(id) ON DELETE CASCADE
);

-- PA publishes authorization intent; LTDS owns identity verification and an
-- explicit binding. Email hints and primary-contact flags never grant access.
CREATE TABLE IF NOT EXISTS pa_portal_principals (
  workspace_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  identity_id TEXT,
  email_hint TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','suspended','revoked')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, public_id),
  UNIQUE (workspace_id, identity_id),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id) REFERENCES portal_v2_identities(id)
);

CREATE TABLE IF NOT EXISTS pa_portal_entitlement_intents (
  workspace_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN (
    'workspace.view','directory.read','delivery.view','request.create',
    'member.manage','delegated_share.create'
  )),
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace','organization','department','client','project')),
  scope_public_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','suspended','revoked')),
  valid_from TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, public_id),
  FOREIGN KEY (workspace_id, principal_public_id)
    REFERENCES pa_portal_principals(workspace_id, public_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pa_portal_projection_receipts (
  delivery_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('snapshot_page','snapshot_activate','event')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  source_sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','ignored')),
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pa_portal_projection_checkpoints (
  workspace_id TEXT PRIMARY KEY,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
  snapshot_generation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (snapshot_generation_id,workspace_id)
    REFERENCES pa_portal_projection_generations(id,workspace_id)
);

CREATE TABLE IF NOT EXISTS pa_portal_projection_audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pa_portal_projection_generations
  ON pa_portal_projection_generations(workspace_id, status, source_sequence);
CREATE INDEX IF NOT EXISTS idx_pa_portal_principals_identity
  ON pa_portal_principals(identity_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_pa_portal_intents_principal
  ON pa_portal_entitlement_intents(workspace_id, principal_public_id, status);
