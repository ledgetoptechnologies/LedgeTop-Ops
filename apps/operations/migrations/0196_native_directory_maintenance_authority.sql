PRAGMA foreign_keys = ON;

-- A separately trusted maintenance procedure installs approvals. No application
-- route or executor installs them. This is NOT a first-account bootstrap.
CREATE TABLE native_directory_maintenance_authority_approvals (
  approval_id TEXT NOT NULL PRIMARY KEY CHECK(length(approval_id) BETWEEN 1 AND 191),
  canonical_plan_json TEXT NOT NULL CHECK(json_valid(canonical_plan_json) AND length(CAST(canonical_plan_json AS BLOB)) BETWEEN 1 AND 131072),
  canonical_plan_sha256 TEXT NOT NULL CHECK(length(canonical_plan_sha256)=64 AND canonical_plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  approved_operator_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  approved_operator_access_subject TEXT NOT NULL CHECK(length(approved_operator_access_subject) BETWEEN 1 AND 191),
  independent_binding_verification_json TEXT NOT NULL CHECK(json_valid(independent_binding_verification_json)),
  independent_binding_verification_sha256 TEXT NOT NULL CHECK(length(independent_binding_verification_sha256)=64 AND independent_binding_verification_sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_by_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  issued_by_access_subject TEXT NOT NULL CHECK(length(issued_by_access_subject) BETWEEN 1 AND 191),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK(julianday(issued_at) IS NOT NULL AND julianday(expires_at) IS NOT NULL AND julianday(expires_at)>julianday(issued_at) AND julianday(expires_at)-julianday(issued_at)<=1.0/24),
  CHECK(revoked_at IS NULL OR (julianday(revoked_at) IS NOT NULL AND julianday(revoked_at)>=julianday(issued_at))),
  CHECK(length(CAST(independent_binding_verification_json AS BLOB)) BETWEEN 1 AND 4096)
);
CREATE TABLE native_directory_maintenance_authority_receipts (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 191),
  approval_id TEXT NOT NULL UNIQUE REFERENCES native_directory_maintenance_authority_approvals(approval_id) ON DELETE RESTRICT,
  operator_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  operator_access_subject TEXT NOT NULL,
  canonical_plan_json TEXT NOT NULL CHECK(json_valid(canonical_plan_json)),
  canonical_plan_sha256 TEXT NOT NULL CHECK(length(canonical_plan_sha256)=64 AND canonical_plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  independent_binding_verification_json TEXT NOT NULL CHECK(json_valid(independent_binding_verification_json)),
  independent_binding_verification_sha256 TEXT NOT NULL CHECK(length(independent_binding_verification_sha256)=64 AND independent_binding_verification_sha256 NOT GLOB '*[^0-9a-f]*'),
  grant_id TEXT NOT NULL UNIQUE REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  resulting_generation INTEGER NOT NULL CHECK(typeof(resulting_generation)='integer' AND resulting_generation BETWEEN 1 AND 9007199254740991),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  result_sha256 TEXT NOT NULL CHECK(length(result_sha256)=64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'),
  executed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Evaluated writes with CHECK guards cannot be optimized away like unused CTEs.
-- Executor inserts/deletes these within the SAME atomic batch; no durable fence
-- survives a successful execution, and failures roll back all writes.
CREATE TABLE native_directory_maintenance_authority_guards (
  command_id TEXT NOT NULL PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok=1)
);
CREATE TRIGGER native_directory_maintenance_authority_approvals_update_guard BEFORE UPDATE ON native_directory_maintenance_authority_approvals
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
 OR NEW.approval_id IS NOT OLD.approval_id OR NEW.canonical_plan_json IS NOT OLD.canonical_plan_json
 OR NEW.canonical_plan_sha256 IS NOT OLD.canonical_plan_sha256
 OR NEW.approved_operator_staff_id IS NOT OLD.approved_operator_staff_id
 OR NEW.approved_operator_access_subject IS NOT OLD.approved_operator_access_subject
 OR NEW.independent_binding_verification_json IS NOT OLD.independent_binding_verification_json
 OR NEW.independent_binding_verification_sha256 IS NOT OLD.independent_binding_verification_sha256
 OR NEW.issued_by_staff_id IS NOT OLD.issued_by_staff_id OR NEW.issued_by_access_subject IS NOT OLD.issued_by_access_subject
 OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'maintenance approval is immutable except revocation'); END;
CREATE TRIGGER native_directory_maintenance_authority_approvals_no_delete BEFORE DELETE ON native_directory_maintenance_authority_approvals
BEGIN SELECT RAISE(ABORT,'maintenance approval is durable'); END;
CREATE TRIGGER native_directory_maintenance_authority_receipts_no_update BEFORE UPDATE ON native_directory_maintenance_authority_receipts
BEGIN SELECT RAISE(ABORT,'maintenance receipt is immutable'); END;
CREATE TRIGGER native_directory_maintenance_authority_receipts_no_delete BEFORE DELETE ON native_directory_maintenance_authority_receipts
BEGIN SELECT RAISE(ABORT,'maintenance receipt is durable'); END;
