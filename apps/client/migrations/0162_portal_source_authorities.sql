-- Explicit portal-purpose authority for an existing Operations connector.
-- No entry is enrolled by this migration; primary keeps its scalar protocol.
CREATE TABLE pa_portal_source_authorities (
  source_id TEXT PRIMARY KEY CHECK(source_id<>'project-alpha:primary'
    AND length(source_id) BETWEEN 15 AND 78 AND instr(source_id,char(0))=0
    AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  producer_binding_id TEXT NOT NULL UNIQUE,
  snapshot_origin TEXT NOT NULL,
  snapshot_base_path TEXT NOT NULL,
  application_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','suspended','retired')),
  active_revision INTEGER NOT NULL CHECK(active_revision>0),
  version INTEGER NOT NULL CHECK(version>0),
  connector_revision INTEGER NOT NULL CHECK(connector_revision>0),
  connector_version INTEGER NOT NULL CHECK(connector_version>0),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE pa_portal_source_authority_revisions (
  source_id TEXT NOT NULL REFERENCES pa_portal_source_authorities(source_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0),
  credential_ref TEXT NOT NULL,
  access_issuer TEXT NOT NULL,
  access_audience TEXT NOT NULL,
  access_subject TEXT NOT NULL,
  current_key_id TEXT NOT NULL,
  current_key_fingerprint TEXT NOT NULL CHECK(length(current_key_fingerprint)=64 AND current_key_fingerprint NOT GLOB '*[^a-f0-9]*'),
  previous_key_id TEXT,
  previous_key_fingerprint TEXT CHECK(previous_key_fingerprint IS NULL OR
    (length(previous_key_fingerprint)=64 AND previous_key_fingerprint NOT GLOB '*[^a-f0-9]*')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(source_id,revision),
  CHECK((previous_key_id IS NULL)=(previous_key_fingerprint IS NULL)),
  CHECK(previous_key_id IS NULL OR previous_key_id<>current_key_id)
);
-- These reservations include trusted primary scalar keys and survive rotation.
CREATE TABLE pa_portal_source_signing_keys (
  fingerprint TEXT PRIMARY KEY CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE pa_portal_source_authority_audit (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES pa_portal_source_authorities(source_id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('provision','active','suspended','retired')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(source_id,version)
);
CREATE TABLE pa_portal_source_write_fences (
  source_id TEXT PRIMARY KEY,
  write_guard INTEGER NOT NULL CONSTRAINT pa_portal_source_write_guard CHECK(write_guard=1)
);
CREATE TRIGGER pa_portal_authority_insert_guard BEFORE INSERT ON pa_portal_source_authorities
WHEN EXISTS(SELECT 1 FROM pa_portal_source_authorities WHERE source_id=NEW.source_id OR producer_binding_id=NEW.producer_binding_id)
  OR (SELECT count(*) FROM pa_portal_source_authorities)>=31
BEGIN SELECT RAISE(ABORT,'portal-authority-conflict'); END;
CREATE TRIGGER pa_portal_authority_update_guard BEFORE UPDATE ON pa_portal_source_authorities
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.producer_binding_id IS NOT OLD.producer_binding_id
  OR NEW.snapshot_origin IS NOT OLD.snapshot_origin OR NEW.snapshot_base_path IS NOT OLD.snapshot_base_path
  OR NEW.application_key IS NOT OLD.application_key OR NEW.created_at IS NOT OLD.created_at
  OR OLD.state='retired' OR NEW.version<>OLD.version+1
  OR NEW.active_revision<OLD.active_revision OR NEW.active_revision>OLD.active_revision+1
  OR NEW.connector_revision<OLD.connector_revision OR NEW.connector_version<OLD.connector_version
  OR (NEW.state='active' AND NOT EXISTS(SELECT 1 FROM pa_portal_source_authority_revisions
    WHERE source_id=NEW.source_id AND revision=NEW.active_revision))
BEGIN SELECT RAISE(ABORT,'portal-authority-conflict'); END;
CREATE TRIGGER pa_portal_authority_no_delete BEFORE DELETE ON pa_portal_source_authorities
BEGIN SELECT RAISE(ABORT,'portal-authority-immutable'); END;
CREATE TRIGGER pa_portal_authority_revision_no_replace BEFORE INSERT ON pa_portal_source_authority_revisions
WHEN EXISTS(SELECT 1 FROM pa_portal_source_authority_revisions WHERE source_id=NEW.source_id AND revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'portal-authority-revision-immutable'); END;
CREATE TRIGGER pa_portal_authority_revision_no_update BEFORE UPDATE ON pa_portal_source_authority_revisions
BEGIN SELECT RAISE(ABORT,'portal-authority-revision-immutable'); END;
CREATE TRIGGER pa_portal_authority_revision_no_delete BEFORE DELETE ON pa_portal_source_authority_revisions
BEGIN SELECT RAISE(ABORT,'portal-authority-revision-immutable'); END;
CREATE TRIGGER pa_portal_authority_key_no_replace BEFORE INSERT ON pa_portal_source_signing_keys
WHEN EXISTS(SELECT 1 FROM pa_portal_source_signing_keys WHERE fingerprint=NEW.fingerprint)
BEGIN SELECT RAISE(ABORT,'portal-signing-key-conflict'); END;
CREATE TRIGGER pa_portal_authority_key_no_update BEFORE UPDATE ON pa_portal_source_signing_keys
BEGIN SELECT RAISE(ABORT,'portal-signing-key-immutable'); END;
CREATE TRIGGER pa_portal_authority_key_no_delete BEFORE DELETE ON pa_portal_source_signing_keys
BEGIN SELECT RAISE(ABORT,'portal-signing-key-immutable'); END;
CREATE TRIGGER pa_portal_authority_audit_no_replace BEFORE INSERT ON pa_portal_source_authority_audit
WHEN EXISTS(SELECT 1 FROM pa_portal_source_authority_audit WHERE id=NEW.id OR (source_id=NEW.source_id AND version=NEW.version))
BEGIN SELECT RAISE(ABORT,'portal-authority-audit-immutable'); END;
CREATE TRIGGER pa_portal_authority_audit_no_update BEFORE UPDATE ON pa_portal_source_authority_audit
BEGIN SELECT RAISE(ABORT,'portal-authority-audit-immutable'); END;
CREATE TRIGGER pa_portal_authority_audit_no_delete BEFORE DELETE ON pa_portal_source_authority_audit
BEGIN SELECT RAISE(ABORT,'portal-authority-audit-immutable'); END;
