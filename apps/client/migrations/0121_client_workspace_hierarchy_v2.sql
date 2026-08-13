PRAGMA foreign_keys = ON;

-- Additive client workspace hierarchy. The Worker does not read these tables
-- unless CLIENT_PORTAL_HIERARCHY_V2_ENABLED is explicitly true. Applying the
-- migration therefore grants no new runtime access.
CREATE TABLE IF NOT EXISTS portal_v2_identities (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL CHECK (length(trim(issuer)) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 512),
  verified_email TEXT COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_identities_email
  ON portal_v2_identities(verified_email, status);

-- A workspace has exactly one Project Alpha root. Accounts that do not yet
-- have exactly one stable PA public ID intentionally remain on the legacy path.
CREATE TABLE IF NOT EXISTS portal_v2_workspaces (
  id TEXT PRIMARY KEY,
  root_type TEXT NOT NULL CHECK (root_type IN ('organization','standalone_client')),
  pa_organization_public_id TEXT,
  pa_client_public_id TEXT,
  legacy_account_id TEXT UNIQUE,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('disabled','active','suspended','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (root_type='organization' AND pa_organization_public_id IS NOT NULL AND pa_client_public_id IS NULL)
    OR
    (root_type='standalone_client' AND pa_client_public_id IS NOT NULL AND pa_organization_public_id IS NULL)
  ),
  FOREIGN KEY (legacy_account_id) REFERENCES client_accounts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_v2_workspace_org_root
  ON portal_v2_workspaces(pa_organization_public_id)
  WHERE pa_organization_public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_v2_workspace_client_root
  ON portal_v2_workspaces(pa_client_public_id)
  WHERE pa_client_public_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS portal_v2_workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('project_alpha','operations','client_invitation','legacy')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  source_version TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, identity_id),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id) REFERENCES portal_v2_identities(id)
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_memberships_identity
  ON portal_v2_workspace_memberships(identity_id, status, expires_at, workspace_id);

-- Complete PA generations are staged independently. Authorization reads only
-- the generation selected by the checkpoint, so interrupted sync cannot expose
-- a partial hierarchy.
CREATE TABLE IF NOT EXISTS portal_v2_directory_generations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
  status TEXT NOT NULL CHECK (status IN ('staging','active','superseded','rejected')),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  UNIQUE (workspace_id, source_generation),
  UNIQUE (workspace_id, source_sequence),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS portal_v2_directory_entities (
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('organization','standalone_client','department','client','project','contact')),
  public_id TEXT NOT NULL,
  parent_public_id TEXT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 240),
  source_version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  primary_contact INTEGER NOT NULL DEFAULT 0 CHECK (primary_contact IN (0,1)),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_metadata_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, generation_id, entity_type, public_id),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id, workspace_id) REFERENCES portal_v2_directory_generations(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_directory_parent
  ON portal_v2_directory_entities(workspace_id, generation_id, parent_public_id, entity_type, active);
CREATE INDEX IF NOT EXISTS idx_portal_v2_directory_search
  ON portal_v2_directory_entities(workspace_id, generation_id, entity_type, active, display_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS portal_v2_directory_checkpoints (
  workspace_id TEXT PRIMARY KEY,
  active_generation_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (active_generation_id, workspace_id) REFERENCES portal_v2_directory_generations(id, workspace_id)
);

CREATE TRIGGER IF NOT EXISTS portal_v2_checkpoint_requires_complete_generation_insert
BEFORE INSERT ON portal_v2_directory_checkpoints
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_generations generation
  WHERE generation.id=NEW.active_generation_id
    AND generation.workspace_id=NEW.workspace_id
    AND generation.source_sequence=NEW.source_sequence
    AND generation.status='active' AND generation.complete=1
)
BEGIN
  SELECT RAISE(ABORT, 'portal v2 checkpoint requires a complete active generation');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_checkpoint_requires_complete_generation_update
BEFORE UPDATE ON portal_v2_directory_checkpoints
WHEN NOT EXISTS (
  SELECT 1 FROM portal_v2_directory_generations generation
  WHERE generation.id=NEW.active_generation_id
    AND generation.workspace_id=NEW.workspace_id
    AND generation.source_sequence=NEW.source_sequence
    AND generation.status='active' AND generation.complete=1
)
BEGIN
  SELECT RAISE(ABORT, 'portal v2 checkpoint requires a complete active generation');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_checkpoint_prevents_out_of_order_update
BEFORE UPDATE ON portal_v2_directory_checkpoints
WHEN NEW.source_sequence < OLD.source_sequence
  OR (NEW.source_sequence=OLD.source_sequence AND NEW.active_generation_id<>OLD.active_generation_id)
BEGIN
  SELECT RAISE(ABORT, 'portal v2 directory generation is stale or conflicting');
END;

CREATE TABLE IF NOT EXISTS portal_v2_entitlements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN (
    'workspace.view','directory.read','delivery.view','request.create',
    'member.manage','delegated_share.create'
  )),
  effect TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace','organization','department','client','project','folder')),
  scope_public_id TEXT NOT NULL,
  entitlement_version INTEGER NOT NULL DEFAULT 1 CHECK (entitlement_version >= 1),
  source_type TEXT NOT NULL CHECK (source_type IN ('project_alpha','operations','client_invitation','legacy')),
  source_version TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked_at TEXT,
  replaced_by_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, workspace_id, identity_id),
  UNIQUE (workspace_id, identity_id, capability, effect, scope_type, scope_public_id, entitlement_version),
  FOREIGN KEY (workspace_id, identity_id) REFERENCES portal_v2_workspace_memberships(workspace_id, identity_id),
  FOREIGN KEY (replaced_by_id) REFERENCES portal_v2_entitlements(id)
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_entitlements_effective
  ON portal_v2_entitlements(workspace_id, identity_id, capability, status, effect, expires_at);

-- Invitation secrets are stored only as SHA-256 base64url hashes. Email is a
-- delivery/UX constraint, never an authorization lookup key.
CREATE TABLE IF NOT EXISTS portal_v2_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash)=43),
  invited_email TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(invited_email)) BETWEEN 3 AND 320),
  invited_by_identity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_at TEXT,
  accepted_by_identity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_identity_id) REFERENCES portal_v2_identities(id),
  FOREIGN KEY (accepted_by_identity_id) REFERENCES portal_v2_identities(id)
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_invitations_pending
  ON portal_v2_invitations(workspace_id, status, expires_at);

CREATE TABLE IF NOT EXISTS portal_v2_invitation_entitlements (
  invitation_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('workspace.view','directory.read','delivery.view','request.create')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace','organization','department','client','project','folder')),
  scope_public_id TEXT NOT NULL,
  PRIMARY KEY (invitation_id, capability, scope_type, scope_public_id),
  FOREIGN KEY (invitation_id) REFERENCES portal_v2_invitations(id) ON DELETE CASCADE
);

-- The prefix never leaves staff/server APIs. Clients use the opaque binding ID.
CREATE TABLE IF NOT EXISTS portal_v2_folder_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL CHECK (owner_scope_type IN ('organization','department','client','project')),
  owner_public_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL CHECK (length(trim(r2_prefix)) BETWEEN 2 AND 1000 AND substr(r2_prefix,-1)='/'),
  source_type TEXT NOT NULL CHECK (source_type IN ('project_alpha','operations','legacy')),
  source_version TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, r2_prefix),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_folder_owner
  ON portal_v2_folder_bindings(workspace_id, owner_scope_type, owner_public_id, status);

-- Safe legacy projection. Only accounts already carrying exactly one stable PA
-- public ID are eligible. Nothing is inferred from a name, contact, or email.
INSERT OR IGNORE INTO portal_v2_identities
  (id, issuer, subject, verified_email, status, revoked_at, created_at, updated_at)
SELECT id, issuer, subject, email,
  CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END,
  revoked_at, created_at, COALESCE(last_seen_at, created_at)
FROM client_identity_links;

INSERT OR IGNORE INTO portal_v2_workspaces
  (id, root_type, pa_organization_public_id, pa_client_public_id, legacy_account_id, display_name, status, created_at, updated_at)
SELECT 'workspace-' || id,
  CASE WHEN project_alpha_organization_id IS NOT NULL THEN 'organization' ELSE 'standalone_client' END,
  project_alpha_organization_id, project_alpha_client_id, id, display_name, status, created_at, updated_at
FROM client_accounts
WHERE (project_alpha_organization_id IS NOT NULL) != (project_alpha_client_id IS NOT NULL);

INSERT OR IGNORE INTO portal_v2_workspace_memberships
  (id, workspace_id, identity_id, source_type, status, revoked_at, created_at, updated_at)
SELECT 'legacy-membership-' || m.account_id || '-' || m.identity_id,
  'workspace-' || m.account_id, m.identity_id, 'legacy',
  CASE WHEN m.revoked_at IS NULL AND i.revoked_at IS NULL THEN 'active' ELSE 'revoked' END,
  COALESCE(m.revoked_at, i.revoked_at), m.created_at, m.updated_at
FROM client_account_members m
JOIN client_identity_links i ON i.id=m.identity_id AND i.account_id=m.account_id
JOIN portal_v2_workspaces w ON w.legacy_account_id=m.account_id;

INSERT OR IGNORE INTO portal_v2_directory_generations
  (id, workspace_id, source_generation, source_sequence, status, complete, activated_at)
SELECT 'legacy-generation-' || legacy_account_id, id, 'legacy-backfill', 0, 'active', 1, datetime('now')
FROM portal_v2_workspaces WHERE legacy_account_id IS NOT NULL;

INSERT OR IGNORE INTO portal_v2_directory_entities
  (workspace_id, generation_id, entity_type, public_id, parent_public_id, display_name, source_version, active)
SELECT id, 'legacy-generation-' || legacy_account_id, root_type,
  COALESCE(pa_organization_public_id, pa_client_public_id), NULL, display_name, 'legacy-backfill',
  CASE WHEN status='active' THEN 1 ELSE 0 END
FROM portal_v2_workspaces WHERE legacy_account_id IS NOT NULL;

INSERT OR IGNORE INTO portal_v2_directory_entities
  (workspace_id, generation_id, entity_type, public_id, parent_public_id, display_name, source_version, active)
SELECT w.id, 'legacy-generation-' || w.legacy_account_id, 'project', p.project_alpha_project_id,
  COALESCE(w.pa_organization_public_id, w.pa_client_public_id), p.project_name, 'legacy-backfill', p.active
FROM portal_v2_workspaces w
JOIN client_project_grants g ON g.account_id=w.legacy_account_id AND g.revoked_at IS NULL
JOIN projects p ON p.id=g.project_id
WHERE p.project_alpha_project_id IS NOT NULL;

INSERT OR IGNORE INTO portal_v2_directory_checkpoints
  (workspace_id, active_generation_id, source_sequence)
SELECT id, 'legacy-generation-' || legacy_account_id, 0
FROM portal_v2_workspaces WHERE legacy_account_id IS NOT NULL;

INSERT OR IGNORE INTO portal_v2_entitlements
  (id, workspace_id, identity_id, capability, effect, scope_type, scope_public_id, source_type, status)
SELECT 'legacy-entitlement-' || w.legacy_account_id || '-' || m.identity_id || '-workspace-view',
  w.id, m.identity_id, 'workspace.view', 'allow', 'workspace',
  w.id, 'legacy', m.status
FROM portal_v2_workspace_memberships m
JOIN portal_v2_workspaces w ON w.id=m.workspace_id;

INSERT OR IGNORE INTO portal_v2_entitlements
  (id, workspace_id, identity_id, capability, effect, scope_type, scope_public_id, source_type, status)
SELECT 'legacy-entitlement-' || m.account_id || '-' || m.identity_id || '-' || capability,
  'workspace-' || m.account_id, m.identity_id, capability, 'allow', 'workspace',
  'workspace-' || m.account_id, 'legacy',
  CASE WHEN m.revoked_at IS NULL THEN 'active' ELSE 'revoked' END
FROM client_account_members m
JOIN portal_v2_workspaces w ON w.legacy_account_id=m.account_id
JOIN (SELECT 'directory.read' capability UNION ALL SELECT 'member.manage') capabilities
WHERE m.role='manager';

INSERT OR IGNORE INTO portal_v2_entitlements
  (id, workspace_id, identity_id, capability, effect, scope_type, scope_public_id, source_type, status)
SELECT 'legacy-entitlement-' || m.account_id || '-' || m.identity_id || '-' || p.project_alpha_project_id || '-delivery',
  w.id, m.identity_id, 'delivery.view', 'allow', 'project', p.project_alpha_project_id, 'legacy',
  CASE WHEN m.revoked_at IS NULL AND g.revoked_at IS NULL THEN 'active' ELSE 'revoked' END
FROM client_account_members m
JOIN portal_v2_workspaces w ON w.legacy_account_id=m.account_id
JOIN client_project_grants g ON g.account_id=m.account_id
JOIN projects p ON p.id=g.project_id AND p.project_alpha_project_id IS NOT NULL
LEFT JOIN client_member_project_grants mg
  ON mg.account_id=m.account_id AND mg.identity_id=m.identity_id AND mg.project_id=g.project_id AND mg.revoked_at IS NULL
WHERE m.role='manager' OR mg.project_id IS NOT NULL;

INSERT OR IGNORE INTO portal_v2_entitlements
  (id, workspace_id, identity_id, capability, effect, scope_type, scope_public_id, source_type, status)
SELECT 'legacy-entitlement-' || m.account_id || '-' || m.identity_id || '-' || p.project_alpha_project_id || '-request',
  w.id, m.identity_id, 'request.create', 'allow', 'project', p.project_alpha_project_id, 'legacy',
  CASE WHEN m.revoked_at IS NULL AND g.revoked_at IS NULL AND g.can_request_service=1 THEN 'active' ELSE 'revoked' END
FROM client_account_members m
JOIN portal_v2_workspaces w ON w.legacy_account_id=m.account_id
JOIN client_project_grants g ON g.account_id=m.account_id
JOIN projects p ON p.id=g.project_id AND p.project_alpha_project_id IS NOT NULL
LEFT JOIN client_member_project_grants mg
  ON mg.account_id=m.account_id AND mg.identity_id=m.identity_id AND mg.project_id=g.project_id AND mg.revoked_at IS NULL
WHERE m.role='manager' OR mg.project_id IS NOT NULL;

INSERT OR IGNORE INTO portal_v2_folder_bindings
  (id, workspace_id, owner_scope_type, owner_public_id, r2_prefix, source_type, status, revoked_at, created_at)
SELECT 'legacy-folder-' || f.id, w.id,
  CASE WHEN f.scope_type='project' THEN 'project' ELSE w.root_type END,
  CASE WHEN f.scope_type='project' THEN p.project_alpha_project_id ELSE COALESCE(w.pa_organization_public_id,w.pa_client_public_id) END,
  f.r2_prefix, 'legacy', CASE WHEN f.revoked_at IS NULL THEN 'active' ELSE 'revoked' END,
  f.revoked_at, f.created_at
FROM client_folder_associations f
JOIN portal_v2_workspaces w ON w.legacy_account_id=f.account_id
LEFT JOIN projects p ON p.id=f.project_id
WHERE (f.scope_type='client' OR p.project_alpha_project_id IS NOT NULL);
