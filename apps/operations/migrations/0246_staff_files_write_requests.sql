-- Staff Files write requests (slice 2b, contract revision 3; provisional number). Append-only Ops records that must exist
-- BEFORE Ops signs anything for the NAS:
--   intents  : one immutable canonical intent per operationId (R3.4), bound to the exact grant and generation (R3.5);
--   chunks   : one immutable SHA-256 per (upload operation, chunk index);
--   requests : one audit row per signed attempt, with full parity with ops_employee_content_start_current (0223)
--              plus rights='read-write', an exclusive root and no active deny. If the insert fails, nothing is signed.

CREATE TABLE ops_employee_files_write_intents (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)),
  kind TEXT NOT NULL CHECK(kind IN ('mkdir','move','delete','trash.restore','upload.begin')),
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256)=64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  staff_id TEXT NOT NULL,access_subject TEXT NOT NULL,admission_version INTEGER NOT NULL,
  gateway_id TEXT NOT NULL,root_id TEXT NOT NULL,root_generation INTEGER NOT NULL,root_fingerprint TEXT NOT NULL,
  grant_id TEXT NOT NULL,grant_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER ops_employee_files_write_intent_no_update BEFORE UPDATE ON ops_employee_files_write_intents
BEGIN SELECT RAISE(ABORT,'employee write intent immutable'); END;
CREATE TRIGGER ops_employee_files_write_intent_no_delete BEFORE DELETE ON ops_employee_files_write_intents
BEGIN SELECT RAISE(ABORT,'employee write intent durable'); END;
CREATE TRIGGER ops_employee_files_write_intent_current BEFORE INSERT ON ops_employee_files_write_intents
WHEN NOT EXISTS(SELECT 1 FROM ops_employee_read_roots r JOIN ops_employee_read_grants g ON g.root_id=r.root_id
  WHERE r.root_id=NEW.root_id AND r.gateway_id=NEW.gateway_id AND r.status='active' AND r.exclusive=1
    AND r.root_generation=NEW.root_generation AND r.root_fingerprint=NEW.root_fingerprint
    AND g.grant_id=NEW.grant_id AND g.grant_generation=NEW.grant_generation AND g.root_generation=r.root_generation AND g.root_fingerprint=r.root_fingerprint
    AND g.staff_id=NEW.staff_id AND g.access_subject=NEW.access_subject AND g.admission_version=NEW.admission_version
    AND g.active=1 AND g.effect='allow' AND g.rights='read-write' AND g.expires_at>unixepoch())
BEGIN SELECT RAISE(ABORT,'employee write authorization changed'); END;

CREATE TABLE ops_employee_files_write_chunks (
  operation_id TEXT NOT NULL REFERENCES ops_employee_files_write_intents(operation_id),
  chunk_index INTEGER NOT NULL CHECK(typeof(chunk_index)='integer' AND chunk_index BETWEEN 0 AND 1000000),
  chunk_sha256 TEXT NOT NULL CHECK(length(chunk_sha256)=64 AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(operation_id,chunk_index)
);
CREATE TRIGGER ops_employee_files_write_chunk_upload_only BEFORE INSERT ON ops_employee_files_write_chunks
WHEN NOT EXISTS(SELECT 1 FROM ops_employee_files_write_intents i WHERE i.operation_id=NEW.operation_id AND i.kind='upload.begin')
BEGIN SELECT RAISE(ABORT,'employee write chunk needs an upload'); END;
CREATE TRIGGER ops_employee_files_write_chunk_no_update BEFORE UPDATE ON ops_employee_files_write_chunks
BEGIN SELECT RAISE(ABORT,'employee write chunk immutable'); END;
CREATE TRIGGER ops_employee_files_write_chunk_no_delete BEFORE DELETE ON ops_employee_files_write_chunks
BEGIN SELECT RAISE(ABORT,'employee write chunk durable'); END;

CREATE TABLE ops_employee_files_write_requests (
  request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36 AND request_id=lower(request_id)),
  operation_id TEXT NOT NULL REFERENCES ops_employee_files_write_intents(operation_id),
  step TEXT NOT NULL CHECK(step IN ('mkdir','move','delete','trash.restore','upload.begin','upload.chunk','upload.status','upload.commit','op.status')),
  gateway_id TEXT NOT NULL,root_id TEXT NOT NULL,root_generation INTEGER NOT NULL,root_fingerprint TEXT NOT NULL,
  staff_id TEXT NOT NULL,access_subject TEXT NOT NULL,admission_version INTEGER NOT NULL,profile_version INTEGER NOT NULL,
  grant_id TEXT NOT NULL,grant_generation INTEGER NOT NULL,
  args_sha256 TEXT NOT NULL CHECK(length(args_sha256)=64 AND args_sha256 NOT GLOB '*[^0-9a-f]*'),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  chunk_index INTEGER,
  envelope_expires_at INTEGER NOT NULL CHECK(typeof(envelope_expires_at)='integer'),
  verified_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((step='upload.chunk')=(chunk_index IS NOT NULL))
);
CREATE INDEX ops_employee_files_write_requests_operation ON ops_employee_files_write_requests(operation_id,created_at);
CREATE TRIGGER ops_employee_files_write_request_no_update BEFORE UPDATE ON ops_employee_files_write_requests
BEGIN SELECT RAISE(ABORT,'employee write audit immutable'); END;
CREATE TRIGGER ops_employee_files_write_request_no_delete BEFORE DELETE ON ops_employee_files_write_requests
BEGIN SELECT RAISE(ABORT,'employee write audit durable'); END;
-- Parity with ops_employee_content_start_current, plus rights, exclusivity, deny, the operation's own grant and
-- generation (R3.5), an envelope that ends no later than the grant, and a stored chunk hash for chunk steps.
CREATE TRIGGER ops_employee_files_write_request_current BEFORE INSERT ON ops_employee_files_write_requests
WHEN NOT EXISTS(SELECT 1 FROM ops_employee_read_roots r JOIN ops_employee_read_grants g ON g.root_id=r.root_id
  JOIN native_staff_admissions a ON a.staff_id=g.staff_id JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
  JOIN ops_employee_files_write_intents i ON i.operation_id=NEW.operation_id
  WHERE r.root_id=NEW.root_id AND r.gateway_id=NEW.gateway_id AND r.status='active' AND r.exclusive=1
    AND r.root_generation=NEW.root_generation AND r.root_fingerprint=NEW.root_fingerprint
    AND g.grant_id=NEW.grant_id AND g.grant_generation=NEW.grant_generation AND g.root_generation=r.root_generation AND g.root_fingerprint=r.root_fingerprint
    AND g.staff_id=NEW.staff_id AND g.access_subject=NEW.access_subject AND g.admission_version=NEW.admission_version
    AND g.active=1 AND g.effect='allow' AND g.rights='read-write' AND g.expires_at>unixepoch() AND NEW.envelope_expires_at<=g.expires_at
    AND a.active=1 AND a.bound_access_subject=NEW.access_subject AND a.version=NEW.admission_version AND p.version=NEW.profile_version
    AND s.status='active' AND s.access_subject=a.bound_access_subject AND julianday(NEW.verified_until)>julianday('now')
    AND i.staff_id=NEW.staff_id AND i.access_subject=NEW.access_subject AND i.admission_version=NEW.admission_version
    AND i.gateway_id=NEW.gateway_id AND i.root_id=NEW.root_id AND i.root_generation=NEW.root_generation AND i.root_fingerprint=NEW.root_fingerprint
    AND i.grant_id=NEW.grant_id AND i.grant_generation=NEW.grant_generation
    AND (NEW.step=i.kind OR (i.kind='upload.begin' AND NEW.step IN ('upload.chunk','upload.status','upload.commit')) OR NEW.step='op.status')
    AND (NEW.step<>'upload.chunk' OR EXISTS(SELECT 1 FROM ops_employee_files_write_chunks c
      WHERE c.operation_id=NEW.operation_id AND c.chunk_index=NEW.chunk_index AND c.chunk_sha256=NEW.body_sha256))
    AND NOT EXISTS(SELECT 1 FROM ops_employee_read_grants d WHERE d.root_id=r.root_id AND d.root_generation=r.root_generation AND d.root_fingerprint=r.root_fingerprint
      AND d.staff_id=NEW.staff_id AND d.access_subject=NEW.access_subject AND d.admission_version=NEW.admission_version AND d.effect='deny' AND d.active=1 AND d.expires_at>unixepoch()))
BEGIN SELECT RAISE(ABORT,'employee write authorization changed'); END;
