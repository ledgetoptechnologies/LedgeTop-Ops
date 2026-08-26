-- Registry enrollment is deliberate. Do not infer an old producer's origin or
-- credentials from projection rows, or activate a connection during migration.
CREATE TABLE pa_connectors (
  source_id TEXT PRIMARY KEY NOT NULL CHECK (substr(source_id,1,14)='project-alpha:'
    AND length(source_id) BETWEEN 15 AND 78 AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*' AND instr(source_id,char(0))=0),
  producer_binding_id TEXT NOT NULL UNIQUE CHECK (length(producer_binding_id) BETWEEN 1 AND 128
    AND producer_binding_id NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(producer_binding_id,char(0))=0),
  snapshot_origin TEXT NOT NULL CHECK (length(snapshot_origin) BETWEEN 9 AND 2048
    AND snapshot_origin GLOB 'https://*' AND instr(snapshot_origin,char(0))=0
    AND instr(snapshot_origin,char(9))=0 AND instr(snapshot_origin,char(10))=0 AND instr(snapshot_origin,char(13))=0),
  application_key TEXT NOT NULL CHECK (length(application_key) BETWEEN 2 AND 64
    AND substr(application_key,1,1) GLOB '[a-z0-9]' AND application_key NOT GLOB '*[^a-z0-9_-]*'
    AND instr(application_key,char(0))=0),
  snapshot_base_path TEXT NOT NULL CHECK (length(snapshot_base_path) BETWEEN 1 AND 1024
    AND substr(snapshot_base_path,1,1)='/' AND instr(snapshot_base_path,char(0))=0),
  profile TEXT NOT NULL CHECK ((source_id='project-alpha:primary' AND profile='primary_legacy')
    OR (source_id<>'project-alpha:primary' AND profile='business_data')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','suspended','retired')),
  read_visible INTEGER NOT NULL DEFAULT 0 CHECK (read_visible IN (0,1)),
  active_revision INTEGER NOT NULL DEFAULT 1 CHECK (active_revision>0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(source_id<>'project-alpha:primary' OR read_visible=1),
  UNIQUE(snapshot_origin,snapshot_base_path,application_key),
  FOREIGN KEY(source_id,active_revision) REFERENCES pa_connector_revisions(source_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_pa_connectors_schedule ON pa_connectors(state,source_id);

-- Key reservations outlive rotations and retirement. A primary scalar key may
-- be reserved before explicit primary enrollment, so this table has no root FK.
CREATE TABLE pa_connector_signing_keys (
  fingerprint TEXT PRIMARY KEY NOT NULL CHECK (length(fingerprint)=64
    AND fingerprint NOT GLOB '*[^0-9a-f]*' AND instr(fingerprint,char(0))=0),
  source_id TEXT NOT NULL CHECK (substr(source_id,1,14)='project-alpha:'
    AND length(source_id) BETWEEN 15 AND 78 AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*' AND instr(source_id,char(0))=0),
  algorithm TEXT NOT NULL CHECK (algorithm IN ('ed25519','hmac-sha256')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fingerprint,source_id)
);

CREATE TABLE pa_connector_revisions (
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision>0),
  credential_ref TEXT NOT NULL CHECK (length(credential_ref) BETWEEN 1 AND 64
    AND credential_ref NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(credential_ref,char(0))=0),
  snapshot_base_path TEXT NOT NULL CHECK (length(snapshot_base_path) BETWEEN 1 AND 1024
    AND substr(snapshot_base_path,1,1)='/' AND instr(snapshot_base_path,char(0))=0),
  access_issuer TEXT NOT NULL CHECK (access_issuer GLOB 'https://*' AND length(access_issuer)<=2048
    AND instr(access_issuer,char(0))=0),
  access_audience TEXT NOT NULL CHECK (length(access_audience) BETWEEN 1 AND 512 AND instr(access_audience,char(0))=0),
  access_subject TEXT NOT NULL CHECK (length(access_subject) BETWEEN 1 AND 512 AND instr(access_subject,char(0))=0),
  current_key_id TEXT NOT NULL CHECK (length(current_key_id) BETWEEN 1 AND 128),
  current_key_fingerprint TEXT NOT NULL,
  previous_key_id TEXT,
  previous_key_fingerprint TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(source_id,revision),
  CHECK ((previous_key_id IS NULL)=(previous_key_fingerprint IS NULL)),
  CHECK (previous_key_id IS NULL OR previous_key_id<>current_key_id),
  CHECK (previous_key_fingerprint IS NULL OR previous_key_fingerprint<>current_key_fingerprint),
  FOREIGN KEY(source_id) REFERENCES pa_connectors(source_id),
  FOREIGN KEY(current_key_fingerprint,source_id) REFERENCES pa_connector_signing_keys(fingerprint,source_id),
  FOREIGN KEY(previous_key_fingerprint,source_id) REFERENCES pa_connector_signing_keys(fingerprint,source_id)
);
CREATE TABLE pa_connector_audit (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('registered','revised','state_changed')),
  version INTEGER NOT NULL CHECK(version>0),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(source_id) REFERENCES pa_connectors(source_id)
);
CREATE INDEX idx_pa_connector_audit_source ON pa_connector_audit(source_id,version,id);

-- A first statement in each write transaction throws on a stale proof. The
-- row is not a credential or grant; one row/source avoids an unbounded ledger.
CREATE TABLE pa_connector_write_fences (
  source_id TEXT PRIMARY KEY NOT NULL,
  write_guard INTEGER NOT NULL CONSTRAINT pa_connector_active_revision_guard CHECK(write_guard=1)
);
CREATE TABLE pa_connector_directory_state (
  id TEXT PRIMARY KEY CHECK(id='directory'),
  read_revision INTEGER NOT NULL DEFAULT 1 CHECK(read_revision>0)
);
INSERT INTO pa_connector_directory_state(id) VALUES('directory');

CREATE TRIGGER pa_connector_insert_identity BEFORE INSERT ON pa_connectors
WHEN NEW.state<>'pending' OR NEW.read_visible<>(CASE WHEN NEW.source_id='project-alpha:primary' THEN 1 ELSE 0 END)
  OR NEW.version<>1 OR NEW.active_revision<>1
  OR EXISTS(SELECT 1 FROM pa_connectors existing WHERE existing.source_id=NEW.source_id
    OR existing.producer_binding_id=NEW.producer_binding_id
    OR (existing.snapshot_origin=NEW.snapshot_origin AND existing.snapshot_base_path=NEW.snapshot_base_path AND existing.application_key=NEW.application_key))
  OR (SELECT count(*) FROM pa_connectors)>=32
BEGIN SELECT RAISE(ABORT,'connector registration conflicts or is not pending'); END;
CREATE TRIGGER pa_connector_update_identity BEFORE UPDATE ON pa_connectors
WHEN OLD.source_id IS NOT NEW.source_id OR OLD.producer_binding_id IS NOT NEW.producer_binding_id
  OR OLD.snapshot_origin IS NOT NEW.snapshot_origin OR OLD.application_key IS NOT NEW.application_key
  OR OLD.snapshot_base_path IS NOT NEW.snapshot_base_path
  OR OLD.profile IS NOT NEW.profile OR OLD.created_by IS NOT NEW.created_by OR OLD.created_at IS NOT NEW.created_at
  OR NEW.version<>OLD.version+1 OR NEW.active_revision NOT IN (OLD.active_revision,OLD.active_revision+1)
  OR (OLD.state='retired' AND (NEW.state<>'retired' OR NEW.active_revision<>OLD.active_revision))
  OR (OLD.state<>'pending' AND NEW.state='pending')
  OR NOT EXISTS(SELECT 1 FROM pa_connector_revisions revision WHERE revision.source_id=NEW.source_id AND revision.revision=NEW.active_revision)
  OR (NEW.source_id<>'project-alpha:primary' AND NEW.state='active' AND NOT EXISTS
    (SELECT 1 FROM pa_connectors primary_source WHERE primary_source.source_id='project-alpha:primary' AND primary_source.state='active'))
BEGIN SELECT RAISE(ABORT,'connector ownership or state transition conflicts'); END;
CREATE TRIGGER pa_connector_no_delete BEFORE DELETE ON pa_connectors
BEGIN SELECT RAISE(ABORT,'connector ownership is persistent'); END;

CREATE TRIGGER pa_connector_revision_insert BEFORE INSERT ON pa_connector_revisions
WHEN NEW.revision<>(SELECT COALESCE(max(revision),0)+1 FROM pa_connector_revisions WHERE source_id=NEW.source_id)
  OR EXISTS(SELECT 1 FROM pa_connector_revisions WHERE source_id=NEW.source_id AND revision=NEW.revision)
  OR NOT EXISTS(SELECT 1 FROM pa_connectors WHERE source_id=NEW.source_id AND snapshot_base_path=NEW.snapshot_base_path)
  OR (NEW.source_id<>'project-alpha:primary' AND EXISTS(SELECT 1 FROM pa_connector_signing_keys
    WHERE fingerprint IN (NEW.current_key_fingerprint,NEW.previous_key_fingerprint) AND algorithm<>'ed25519'))
BEGIN SELECT RAISE(ABORT,'connector revision conflicts'); END;
CREATE TRIGGER pa_connector_revision_no_update BEFORE UPDATE ON pa_connector_revisions
BEGIN SELECT RAISE(ABORT,'connector revisions are immutable'); END;
CREATE TRIGGER pa_connector_revision_no_delete BEFORE DELETE ON pa_connector_revisions
BEGIN SELECT RAISE(ABORT,'connector revisions are persistent'); END;
CREATE TRIGGER pa_connector_key_insert BEFORE INSERT ON pa_connector_signing_keys
WHEN EXISTS(SELECT 1 FROM pa_connector_signing_keys WHERE fingerprint=NEW.fingerprint)
BEGIN SELECT RAISE(ABORT,'connector signing key already reserved'); END;
CREATE TRIGGER pa_connector_key_no_update BEFORE UPDATE ON pa_connector_signing_keys
BEGIN SELECT RAISE(ABORT,'connector signing key ownership is immutable'); END;
CREATE TRIGGER pa_connector_key_no_delete BEFORE DELETE ON pa_connector_signing_keys
BEGIN SELECT RAISE(ABORT,'connector signing key ownership is persistent'); END;
CREATE TRIGGER pa_connector_audit_insert BEFORE INSERT ON pa_connector_audit
WHEN EXISTS(SELECT 1 FROM pa_connector_audit WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'connector audit is immutable'); END;
CREATE TRIGGER pa_connector_audit_no_update BEFORE UPDATE ON pa_connector_audit
BEGIN SELECT RAISE(ABORT,'connector audit is immutable'); END;
CREATE TRIGGER pa_connector_audit_no_delete BEFORE DELETE ON pa_connector_audit
BEGIN SELECT RAISE(ABORT,'connector audit is persistent'); END;
CREATE TRIGGER pa_connector_directory_insert AFTER INSERT ON pa_connectors
BEGIN UPDATE pa_connector_directory_state SET read_revision=read_revision+1 WHERE id='directory'; END;
CREATE TRIGGER pa_connector_directory_update AFTER UPDATE ON pa_connectors
WHEN OLD.display_name IS NOT NEW.display_name OR OLD.read_visible IS NOT NEW.read_visible
  OR OLD.state IS NOT NEW.state OR OLD.active_revision IS NOT NEW.active_revision OR OLD.version IS NOT NEW.version
BEGIN UPDATE pa_connector_directory_state SET read_revision=read_revision+1 WHERE id='directory'; END;
