PRAGMA foreign_keys = ON;

-- Shadow-only Operations authority. Nothing in the portal authorization path
-- reads these tables. In particular, this migration does not create or alter
-- identities, workspaces, memberships, entitlements, or PA projections.
CREATE TABLE operations_portal_access_authorities (
  client_authority_id TEXT NOT NULL,
  issuer TEXT NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  last_operation_id TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(client_authority_id,issuer,subject),
  CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);

CREATE TABLE operations_portal_access_authority_receipts (
  idempotency_key TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  client_authority_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  result_revision INTEGER NOT NULL CHECK(result_revision >= 1),
  result_state TEXT NOT NULL CHECK(result_state IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(client_authority_id,issuer,subject)
    REFERENCES operations_portal_access_authorities(client_authority_id,issuer,subject) ON DELETE RESTRICT
);

CREATE TABLE operations_portal_access_authority_audit (
  operation_id TEXT PRIMARY KEY,
  client_authority_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('binding.activated','binding.revoked')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(client_authority_id,issuer,subject)
    REFERENCES operations_portal_access_authorities(client_authority_id,issuer,subject) ON DELETE RESTRICT
);

CREATE TRIGGER operations_portal_access_authority_no_delete
BEFORE DELETE ON operations_portal_access_authorities
BEGIN SELECT RAISE(ABORT,'operations portal authority tombstones cannot be deleted'); END;
CREATE TRIGGER operations_portal_access_authority_audit_no_update
BEFORE UPDATE ON operations_portal_access_authority_audit
BEGIN SELECT RAISE(ABORT,'operations portal authority audit is immutable'); END;
CREATE TRIGGER operations_portal_access_authority_audit_no_delete
BEFORE DELETE ON operations_portal_access_authority_audit
BEGIN SELECT RAISE(ABORT,'operations portal authority audit is immutable'); END;
CREATE TRIGGER operations_portal_access_authority_receipt_no_update
BEFORE UPDATE ON operations_portal_access_authority_receipts
BEGIN SELECT RAISE(ABORT,'operations portal authority receipt is immutable'); END;
CREATE TRIGGER operations_portal_access_authority_receipt_no_delete
BEFORE DELETE ON operations_portal_access_authority_receipts
BEGIN SELECT RAISE(ABORT,'operations portal authority receipt is immutable'); END;
