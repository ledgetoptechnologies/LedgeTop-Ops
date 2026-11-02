PRAGMA foreign_keys=ON;

-- Direct Ops folder grants are separate from PA/project delivery grants.
-- Authority is evaluated from the current Ops workspace publication, the
-- current folder binding, and current workspace membership on every read.
CREATE TABLE operations_portal_direct_folder_grants (
  grant_id TEXT PRIMARY KEY,
  grant_version INTEGER NOT NULL CHECK(grant_version>=1),
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  client_authority_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  publication_revision INTEGER NOT NULL CHECK(publication_revision>=1),
  publication_snapshot_id TEXT NOT NULL,
  publication_snapshot_sha256 TEXT NOT NULL CHECK(length(publication_snapshot_sha256)=64),
  source_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  binding_receipt_version INTEGER NOT NULL CHECK(binding_receipt_version>=1),
  owner_scope_type TEXT NOT NULL CHECK(owner_scope_type IN('organization','client')),
  owner_record_id TEXT NOT NULL,
  recipient_record_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all_members' CHECK(audience='all_members'),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked','expired')),
  expires_at TEXT,
  created_by_operation_id TEXT NOT NULL,
  revoked_by_operation_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(grant_id,workspace_id),
  FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY(folder_binding_id,workspace_id) REFERENCES portal_v2_folder_bindings(id,workspace_id) ON DELETE RESTRICT,
  CHECK(expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL),
  CHECK((status='active' AND revoked_at IS NULL AND revoked_by_operation_id IS NULL)
    OR (status='revoked' AND revoked_at IS NOT NULL AND revoked_by_operation_id IS NOT NULL)
    OR status='expired')
);

CREATE UNIQUE INDEX operations_portal_direct_folder_one_active
  ON operations_portal_direct_folder_grants(workspace_id,folder_binding_id)
  WHERE status='active' AND revoked_at IS NULL;
CREATE INDEX operations_portal_direct_folder_read
  ON operations_portal_direct_folder_grants(workspace_id,status,expires_at,folder_binding_id);

CREATE TABLE operations_portal_direct_folder_grant_mutations (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  action TEXT NOT NULL CHECK(action IN('grant.create','grant.revoke')),
  grant_id TEXT NOT NULL,
  resulting_version INTEGER NOT NULL CHECK(resulting_version>=1),
  resulting_state TEXT NOT NULL CHECK(resulting_state IN('active','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(grant_id) REFERENCES operations_portal_direct_folder_grants(grant_id) ON DELETE RESTRICT
);

CREATE TABLE operations_portal_direct_folder_grant_audit (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_direct_folder_grant_mutations(operation_id) ON DELETE RESTRICT,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN('grant.created','grant.revoked')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(grant_id,workspace_id) REFERENCES operations_portal_direct_folder_grants(grant_id,workspace_id) ON DELETE RESTRICT
);

-- A mutation receipt can only describe the grant transition that actually
-- committed. This makes a concurrent stale CAS abort its entire D1 batch,
-- rather than writing a false success receipt after a zero-row UPDATE.
CREATE TRIGGER operations_portal_direct_folder_mutation_matches_grant
BEFORE INSERT ON operations_portal_direct_folder_grant_mutations
WHEN NOT EXISTS(
  SELECT 1 FROM operations_portal_direct_folder_grants grant_record
  WHERE grant_record.grant_id=NEW.grant_id AND grant_record.grant_version=NEW.resulting_version
    AND ((NEW.action='grant.create' AND NEW.resulting_state='active' AND grant_record.status='active'
      AND grant_record.created_by_operation_id=NEW.operation_id)
      OR (NEW.action='grant.revoke' AND NEW.resulting_state='revoked' AND grant_record.status='revoked'
        AND grant_record.revoked_by_operation_id=NEW.operation_id))
)
BEGIN SELECT RAISE(ABORT,'direct folder mutation did not commit'); END;

CREATE TRIGGER operations_portal_direct_folder_grant_authority_immutable
BEFORE UPDATE ON operations_portal_direct_folder_grants
WHEN OLD.grant_id IS NOT NEW.grant_id OR OLD.workspace_id IS NOT NEW.workspace_id
  OR OLD.target_id IS NOT NEW.target_id OR OLD.client_authority_id IS NOT NEW.client_authority_id
  OR OLD.target_revision IS NOT NEW.target_revision OR OLD.publication_revision IS NOT NEW.publication_revision
  OR OLD.publication_snapshot_id IS NOT NEW.publication_snapshot_id
  OR OLD.publication_snapshot_sha256 IS NOT NEW.publication_snapshot_sha256
  OR OLD.source_id IS NOT NEW.source_id OR OLD.folder_binding_id IS NOT NEW.folder_binding_id
  OR OLD.binding_source_version IS NOT NEW.binding_source_version
  OR OLD.binding_receipt_version IS NOT NEW.binding_receipt_version
  OR OLD.owner_scope_type IS NOT NEW.owner_scope_type OR OLD.owner_record_id IS NOT NEW.owner_record_id
  OR OLD.recipient_record_id IS NOT NEW.recipient_record_id OR OLD.audience IS NOT NEW.audience
  OR OLD.expires_at IS NOT NEW.expires_at OR OLD.created_by_operation_id IS NOT NEW.created_by_operation_id
  OR OLD.created_at IS NOT NEW.created_at OR NEW.grant_version<>OLD.grant_version+1
  OR OLD.status<>'active' OR NEW.status<>'revoked' OR NEW.revoked_at IS NULL OR NEW.revoked_by_operation_id IS NULL
BEGIN SELECT RAISE(ABORT,'direct folder grant authority is immutable'); END;

CREATE TRIGGER operations_portal_direct_folder_grant_no_delete
BEFORE DELETE ON operations_portal_direct_folder_grants
BEGIN SELECT RAISE(ABORT,'direct folder grant history is immutable'); END;
CREATE TRIGGER operations_portal_direct_folder_mutation_no_update
BEFORE UPDATE ON operations_portal_direct_folder_grant_mutations
BEGIN SELECT RAISE(ABORT,'direct folder mutation receipt is immutable'); END;
CREATE TRIGGER operations_portal_direct_folder_mutation_no_delete
BEFORE DELETE ON operations_portal_direct_folder_grant_mutations
BEGIN SELECT RAISE(ABORT,'direct folder mutation receipt is immutable'); END;
CREATE TRIGGER operations_portal_direct_folder_audit_no_update
BEFORE UPDATE ON operations_portal_direct_folder_grant_audit
BEGIN SELECT RAISE(ABORT,'direct folder grant audit is immutable'); END;
CREATE TRIGGER operations_portal_direct_folder_audit_no_delete
BEFORE DELETE ON operations_portal_direct_folder_grant_audit
BEGIN SELECT RAISE(ABORT,'direct folder grant audit is immutable'); END;
