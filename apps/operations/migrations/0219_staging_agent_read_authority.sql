-- Independent machine identities. No credentials, admissions, inherited grants,
-- records or projections are created by installing this schema.
CREATE TABLE ops_agent_principals (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  access_client_id TEXT NOT NULL UNIQUE CHECK(length(access_client_id) BETWEEN 1 AND 256),
  owner_staff_id TEXT NOT NULL REFERENCES native_staff_profiles(staff_id) ON DELETE RESTRICT,
  owner_access_subject TEXT NOT NULL CHECK(length(owner_access_subject) BETWEEN 1 AND 764),
  owner_admission_version INTEGER NOT NULL CHECK(typeof(owner_admission_version)='integer' AND owner_admission_version>=1),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN 1 AND 253402300799),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER ops_agent_principal_update BEFORE UPDATE ON ops_agent_principals
WHEN NEW.id IS NOT OLD.id OR NEW.access_client_id IS NOT OLD.access_client_id
  OR NEW.owner_staff_id IS NOT OLD.owner_staff_id OR NEW.owner_access_subject IS NOT OLD.owner_access_subject
  OR NEW.owner_admission_version IS NOT OLD.owner_admission_version OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version<>OLD.version+1 OR OLD.status='revoked'
BEGIN SELECT RAISE(ABORT,'agent identity immutable or revoked'); END;
CREATE TRIGGER ops_agent_principal_no_delete BEFORE DELETE ON ops_agent_principals
BEGIN SELECT RAISE(ABORT,'agent identity is durable'); END;

CREATE TABLE ops_agent_read_grants (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  agent_id TEXT NOT NULL REFERENCES ops_agent_principals(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  projection_source_id TEXT NOT NULL CHECK(length(projection_source_id) BETWEEN 1 AND 128),
  origin TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('source','resource')),
  record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  CHECK((scope_kind='source' AND record_id IS NULL) OR (scope_kind='resource' AND record_id IS NOT NULL))
);
CREATE INDEX ops_agent_read_grants_agent ON ops_agent_read_grants(agent_id,source_id,active);
CREATE TRIGGER ops_agent_grant_update BEFORE UPDATE ON ops_agent_read_grants
WHEN NEW.id IS NOT OLD.id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.source_id IS NOT OLD.source_id
  OR NEW.projection_source_id IS NOT OLD.projection_source_id OR NEW.origin IS NOT OLD.origin
  OR NEW.source_instance_id IS NOT OLD.source_instance_id OR NEW.application_id IS NOT OLD.application_id
  OR NEW.history_epoch_id IS NOT OLD.history_epoch_id OR NEW.effect IS NOT OLD.effect
  OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.record_id IS NOT OLD.record_id
  OR NEW.version<>OLD.version+1 OR OLD.active=0 OR NEW.active<>0
BEGIN SELECT RAISE(ABORT,'agent grant immutable; revoke then issue a new grant'); END;
CREATE TRIGGER ops_agent_grant_no_delete BEFORE DELETE ON ops_agent_read_grants
BEGIN SELECT RAISE(ABORT,'agent grants are durable'); END;

CREATE TABLE ops_agent_read_audit (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES ops_agent_principals(id) ON DELETE RESTRICT,
  owner_staff_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('connection','clients.lookup','clients.detail')),
  outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied','rate_limited')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ops_agent_read_audit_rate ON ops_agent_read_audit(agent_id,created_at);
CREATE TABLE ops_agent_read_rate_windows (
  agent_id TEXT NOT NULL REFERENCES ops_agent_principals(id) ON DELETE RESTRICT,
  minute INTEGER NOT NULL CHECK(typeof(minute)='integer'),
  requests INTEGER NOT NULL CHECK(typeof(requests)='integer' AND requests BETWEEN 1 AND 60),
  PRIMARY KEY(agent_id,minute)
);
CREATE TRIGGER ops_agent_read_audit_no_update BEFORE UPDATE ON ops_agent_read_audit
BEGIN SELECT RAISE(ABORT,'agent audit is immutable'); END;
CREATE TRIGGER ops_agent_read_audit_no_delete BEFORE DELETE ON ops_agent_read_audit
BEGIN SELECT RAISE(ABORT,'agent audit is durable'); END;
