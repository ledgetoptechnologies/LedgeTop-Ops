PRAGMA foreign_keys = ON;

-- These rows are issued out of band. No Worker route is permitted to create them.
CREATE TABLE native_staff_bootstrap_approvals (
  approval_id TEXT NOT NULL PRIMARY KEY CHECK(length(approval_id) BETWEEN 1 AND 191),
  canonical_plan_json TEXT NOT NULL CHECK(json_valid(canonical_plan_json) AND length(CAST(canonical_plan_json AS BLOB)) BETWEEN 1 AND 262144),
  canonical_plan_sha256 TEXT NOT NULL CHECK(length(canonical_plan_sha256)=64 AND canonical_plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  approved_operator_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  approved_operator_access_subject TEXT NOT NULL CHECK(length(approved_operator_access_subject) BETWEEN 1 AND 191),
  independent_binding_verification_json TEXT NOT NULL CHECK(json_valid(independent_binding_verification_json) AND length(CAST(independent_binding_verification_json AS BLOB)) BETWEEN 1 AND 262144),
  independent_binding_verification_sha256 TEXT NOT NULL CHECK(length(independent_binding_verification_sha256)=64 AND independent_binding_verification_sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_by_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  issued_by_access_subject TEXT NOT NULL CHECK(length(issued_by_access_subject) BETWEEN 1 AND 191),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK(julianday(issued_at) IS NOT NULL AND julianday(expires_at) IS NOT NULL AND julianday(expires_at)>julianday(issued_at)),
  CHECK(revoked_at IS NULL OR (julianday(revoked_at) IS NOT NULL AND julianday(revoked_at)>=julianday(issued_at)))
);

CREATE TABLE native_staff_bootstrap_receipts (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 191),
  approval_id TEXT NOT NULL UNIQUE REFERENCES native_staff_bootstrap_approvals(approval_id) ON DELETE RESTRICT,
  operator_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  operator_access_subject TEXT NOT NULL CHECK(length(operator_access_subject) BETWEEN 1 AND 191),
  canonical_plan_json TEXT NOT NULL CHECK(json_valid(canonical_plan_json)),
  canonical_plan_sha256 TEXT NOT NULL CHECK(length(canonical_plan_sha256)=64 AND canonical_plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  independent_binding_verification_json TEXT NOT NULL CHECK(json_valid(independent_binding_verification_json)),
  independent_binding_verification_sha256 TEXT NOT NULL CHECK(length(independent_binding_verification_sha256)=64 AND independent_binding_verification_sha256 NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  result_sha256 TEXT NOT NULL CHECK(length(result_sha256)=64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'),
  executed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER native_staff_bootstrap_approvals_update_guard BEFORE UPDATE ON native_staff_bootstrap_approvals
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
  OR NEW.approval_id IS NOT OLD.approval_id OR NEW.canonical_plan_json IS NOT OLD.canonical_plan_json
  OR NEW.canonical_plan_sha256 IS NOT OLD.canonical_plan_sha256
  OR NEW.approved_operator_staff_id IS NOT OLD.approved_operator_staff_id
  OR NEW.approved_operator_access_subject IS NOT OLD.approved_operator_access_subject
  OR NEW.independent_binding_verification_json IS NOT OLD.independent_binding_verification_json
  OR NEW.independent_binding_verification_sha256 IS NOT OLD.independent_binding_verification_sha256
  OR NEW.issued_by_staff_id IS NOT OLD.issued_by_staff_id OR NEW.issued_by_access_subject IS NOT OLD.issued_by_access_subject
  OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'native staff bootstrap approval update is invalid'); END;
CREATE TRIGGER native_staff_bootstrap_approvals_no_delete BEFORE DELETE ON native_staff_bootstrap_approvals
BEGIN SELECT RAISE(ABORT,'native staff bootstrap approval is durable'); END;
CREATE TRIGGER native_staff_bootstrap_receipts_no_update BEFORE UPDATE ON native_staff_bootstrap_receipts
BEGIN SELECT RAISE(ABORT,'native staff bootstrap receipt is immutable'); END;
CREATE TRIGGER native_staff_bootstrap_receipts_no_delete BEFORE DELETE ON native_staff_bootstrap_receipts
BEGIN SELECT RAISE(ABORT,'native staff bootstrap receipt is durable'); END;
