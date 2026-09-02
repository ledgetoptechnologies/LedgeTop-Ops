PRAGMA foreign_keys = ON;

-- Internal Client Hub notes belong only to Operations. They never project to
-- Project Alpha, grant portal access, select notification recipients, or touch
-- delivery storage. Read access follows the existing Client Hub directory
-- authority; mutations require this explicit administrator permission.
INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('client.notes.manage','Manage internal notes for visible Client Hub workspaces');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT role.id,permission.key FROM roles role CROSS JOIN permissions permission
WHERE role.id IN ('role-owner','role-admin') AND permission.key='client.notes.manage';

CREATE TABLE client_internal_notes (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  root_namespace TEXT NOT NULL CHECK(root_namespace IN ('business','portal','account')),
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK(length(body)<=12000),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  FOREIGN KEY(created_by) REFERENCES staff_users(id),
  FOREIGN KEY(updated_by) REFERENCES staff_users(id)
);

CREATE INDEX client_internal_notes_scope
  ON client_internal_notes(source_id,root_namespace,root_kind,root_id,deleted_at,updated_at DESC,id);

CREATE TABLE client_internal_note_revisions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  root_namespace TEXT NOT NULL CHECK(root_namespace IN ('business','portal','account')),
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  action TEXT NOT NULL CHECK(action IN ('created','updated','deleted')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK(length(body)<=12000),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(note_id,version),
  FOREIGN KEY(note_id) REFERENCES client_internal_notes(id),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id)
);

CREATE INDEX client_internal_note_revision_scope
  ON client_internal_note_revisions(source_id,root_namespace,root_kind,root_id,note_id,version DESC);

CREATE TABLE client_internal_note_mutations (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('create','update','delete')),
  request_fingerprint TEXT NOT NULL,
  source_id TEXT NOT NULL,
  root_namespace TEXT NOT NULL,
  root_kind TEXT NOT NULL,
  root_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK(result_version>0),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_id,idempotency_key),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id),
  FOREIGN KEY(note_id) REFERENCES client_internal_notes(id)
);

CREATE TRIGGER client_internal_note_revisions_immutable_update
BEFORE UPDATE ON client_internal_note_revisions BEGIN
  SELECT RAISE(ABORT,'client note revisions are immutable');
END;

CREATE TRIGGER client_internal_note_revisions_immutable_delete
BEFORE DELETE ON client_internal_note_revisions BEGIN
  SELECT RAISE(ABORT,'client note revisions are immutable');
END;

CREATE TRIGGER client_internal_note_mutations_immutable_update
BEFORE UPDATE ON client_internal_note_mutations BEGIN
  SELECT RAISE(ABORT,'client note mutation receipts are immutable');
END;

CREATE TRIGGER client_internal_note_mutations_immutable_delete
BEFORE DELETE ON client_internal_note_mutations BEGIN
  SELECT RAISE(ABORT,'client note mutation receipts are immutable');
END;

CREATE TRIGGER client_internal_notes_no_hard_delete
BEFORE DELETE ON client_internal_notes BEGIN
  SELECT RAISE(ABORT,'client notes use audited soft deletion');
END;
