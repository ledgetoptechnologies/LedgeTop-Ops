PRAGMA foreign_keys = ON;

-- Local address-book records are descriptive convenience data. They never
-- create a portal identity, membership, entitlement, invitation or Alpha row.
CREATE TABLE portal_workspace_address_book_states (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(workspace_id,source_id),
  FOREIGN KEY(workspace_id,source_id) REFERENCES pa_portal_workspace_sources(workspace_id,projection_source_id)
);
INSERT INTO portal_workspace_address_book_states(workspace_id,source_id)
SELECT workspace.id,workspace.project_alpha_source_id
FROM portal_v2_workspaces workspace
JOIN pa_portal_workspace_sources source
  ON source.workspace_id=workspace.id
 AND source.projection_source_id=workspace.project_alpha_source_id
WHERE workspace.root_type='organization';

CREATE TABLE portal_workspace_address_contacts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  display_name TEXT,
  sort_name TEXT,
  email TEXT COLLATE NOCASE,
  email_key TEXT,
  phone TEXT,
  company TEXT,
  company_key TEXT,
  role_or_trade TEXT,
  role_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by_identity_id TEXT NOT NULL,
  updated_by_identity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  UNIQUE(id,workspace_id),
  UNIQUE(id,workspace_id,source_id),
  FOREIGN KEY(workspace_id,source_id) REFERENCES portal_workspace_address_book_states(workspace_id,source_id),
  FOREIGN KEY(created_by_identity_id) REFERENCES portal_v2_identities(id),
  FOREIGN KEY(updated_by_identity_id) REFERENCES portal_v2_identities(id),
  CHECK((status='active' AND display_name IS NOT NULL AND sort_name IS NOT NULL
    AND email IS NOT NULL AND email_key IS NOT NULL AND deleted_at IS NULL)
    OR (status='deleted' AND display_name IS NULL AND sort_name IS NULL AND email IS NULL AND email_key IS NULL
      AND phone IS NULL AND company IS NULL AND company_key IS NULL AND role_or_trade IS NULL AND role_key IS NULL
      AND deleted_at IS NOT NULL)),
  CHECK(display_name IS NULL OR length(display_name) BETWEEN 1 AND 160),
  CHECK(sort_name IS NULL OR length(sort_name) BETWEEN 1 AND 160),
  CHECK(email IS NULL OR length(email) BETWEEN 3 AND 320),
  CHECK(email_key IS NULL OR length(email_key) BETWEEN 3 AND 320),
  CHECK(phone IS NULL OR length(phone) BETWEEN 3 AND 64),
  CHECK(company IS NULL OR length(company) BETWEEN 1 AND 160),
  CHECK(company_key IS NULL OR length(company_key) BETWEEN 1 AND 160),
  CHECK(role_or_trade IS NULL OR length(role_or_trade) BETWEEN 1 AND 160),
  CHECK(role_key IS NULL OR length(role_key) BETWEEN 1 AND 160)
);
CREATE INDEX idx_portal_address_contact_email
  ON portal_workspace_address_contacts(workspace_id,email_key,id)
  WHERE status='active';
CREATE INDEX idx_portal_address_contact_seek
  ON portal_workspace_address_contacts(workspace_id,sort_name,id)
  WHERE status='active';
CREATE INDEX idx_portal_invitation_address_email
  ON portal_v2_invitations(workspace_id,invited_email COLLATE NOCASE,created_at DESC,id DESC);

CREATE TABLE portal_workspace_address_contact_commands (
  workspace_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  contact_id TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK(result_version>=1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(workspace_id,actor_identity_id,idempotency_key),
  FOREIGN KEY(contact_id,workspace_id) REFERENCES portal_workspace_address_contacts(id,workspace_id),
  FOREIGN KEY(actor_identity_id) REFERENCES portal_v2_identities(id)
);
CREATE TABLE portal_workspace_address_contact_audit (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  contact_version INTEGER NOT NULL CHECK(contact_version>=1),
  actor_identity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('contact.created','contact.updated','contact.deleted')),
  changed_fields_json TEXT NOT NULL CHECK(json_valid(changed_fields_json) AND length(changed_fields_json)<=512),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(contact_id,workspace_id,source_id) REFERENCES portal_workspace_address_contacts(id,workspace_id,source_id),
  FOREIGN KEY(actor_identity_id) REFERENCES portal_v2_identities(id)
);
CREATE INDEX idx_portal_address_contact_audit
  ON portal_workspace_address_contact_audit(workspace_id,created_at DESC,id DESC);
CREATE TABLE portal_workspace_address_contact_fences (
  id TEXT PRIMARY KEY NOT NULL,
  write_guard INTEGER NOT NULL CONSTRAINT portal_address_contact_guard CHECK(write_guard=1)
);

CREATE TRIGGER portal_address_book_state_source_update BEFORE UPDATE OF workspace_id,source_id
ON portal_workspace_address_book_states
BEGIN SELECT RAISE(ABORT,'address book source is immutable'); END;
CREATE TRIGGER portal_address_book_state_delete BEFORE DELETE ON portal_workspace_address_book_states
BEGIN SELECT RAISE(ABORT,'address book state cannot be deleted'); END;
CREATE TRIGGER portal_address_book_workspace_insert AFTER INSERT ON portal_v2_workspaces
WHEN NEW.root_type='organization'
 AND EXISTS(SELECT 1 FROM pa_portal_workspace_sources s WHERE s.workspace_id=NEW.id AND s.projection_source_id=NEW.project_alpha_source_id)
BEGIN
  INSERT OR IGNORE INTO portal_workspace_address_book_states(workspace_id,source_id) VALUES(NEW.id,NEW.project_alpha_source_id);
END;
CREATE TRIGGER portal_address_book_source_insert AFTER INSERT ON pa_portal_workspace_sources
WHEN EXISTS(SELECT 1 FROM portal_v2_workspaces w WHERE w.id=NEW.workspace_id AND w.root_type='organization'
 AND w.project_alpha_source_id=NEW.projection_source_id)
BEGIN
  INSERT OR IGNORE INTO portal_workspace_address_book_states(workspace_id,source_id) VALUES(NEW.workspace_id,NEW.projection_source_id);
END;

CREATE TRIGGER portal_address_contact_insert BEFORE INSERT ON portal_workspace_address_contacts
WHEN NEW.status<>'active' OR NEW.version<>1 OR NEW.deleted_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM portal_v2_workspaces w JOIN portal_workspace_address_book_states s
   ON s.workspace_id=w.id AND s.source_id=w.project_alpha_source_id
   WHERE w.id=NEW.workspace_id AND w.project_alpha_source_id=NEW.source_id AND w.status='active')
BEGIN SELECT RAISE(ABORT,'address contact insert is invalid'); END;
CREATE TRIGGER portal_address_contact_update BEFORE UPDATE ON portal_workspace_address_contacts
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.source_id IS NOT OLD.source_id
 OR NEW.created_by_identity_id IS NOT OLD.created_by_identity_id OR NEW.created_at IS NOT OLD.created_at
 OR OLD.status<>'active' OR NEW.version<>OLD.version+1
 OR NEW.status NOT IN ('active','deleted')
BEGIN SELECT RAISE(ABORT,'address contact update is invalid'); END;
CREATE TRIGGER portal_address_contact_delete BEFORE DELETE ON portal_workspace_address_contacts
BEGIN SELECT RAISE(ABORT,'address contacts use scrubbed tombstones'); END;
CREATE TRIGGER portal_address_contact_revision_insert AFTER INSERT ON portal_workspace_address_contacts
BEGIN UPDATE portal_workspace_address_book_states SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=NEW.workspace_id AND source_id=NEW.source_id; END;
CREATE TRIGGER portal_address_contact_revision_update AFTER UPDATE ON portal_workspace_address_contacts
BEGIN UPDATE portal_workspace_address_book_states SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=NEW.workspace_id AND source_id=NEW.source_id; END;

CREATE TRIGGER portal_address_contact_command_update BEFORE UPDATE ON portal_workspace_address_contact_commands
BEGIN SELECT RAISE(ABORT,'address contact commands are immutable'); END;
CREATE TRIGGER portal_address_contact_command_delete BEFORE DELETE ON portal_workspace_address_contact_commands
BEGIN SELECT RAISE(ABORT,'address contact commands are immutable'); END;
CREATE TRIGGER portal_address_contact_audit_insert BEFORE INSERT ON portal_workspace_address_contact_audit
WHEN EXISTS(SELECT 1 FROM json_each(NEW.changed_fields_json) field
  WHERE field.type<>'text' OR field.value NOT IN ('displayName','email','phone','company','roleOrTrade','status'))
BEGIN SELECT RAISE(ABORT,'address contact audit fields are invalid'); END;
CREATE TRIGGER portal_address_contact_audit_update BEFORE UPDATE ON portal_workspace_address_contact_audit
BEGIN SELECT RAISE(ABORT,'address contact audit is immutable'); END;
CREATE TRIGGER portal_address_contact_audit_delete BEFORE DELETE ON portal_workspace_address_contact_audit
BEGIN SELECT RAISE(ABORT,'address contact audit is immutable'); END;
