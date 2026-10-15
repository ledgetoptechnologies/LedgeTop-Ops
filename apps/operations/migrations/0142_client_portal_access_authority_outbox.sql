PRAGMA foreign_keys = ON;

-- Durable Ops-owned intent. Payload contains only stable Ops authority IDs and
-- exact Access issuer/subject pairs; it contains no PA ID, email, or credential.
CREATE TABLE client_portal_access_authority_outbox (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  client_authority_id TEXT NOT NULL,
  issuer TEXT NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
  desired_state TEXT NOT NULL CHECK(desired_state IN ('active','revoked')),
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  authorized_by_staff_id TEXT NOT NULL,
  authorization_version INTEGER NOT NULL CHECK(authorization_version >= 1),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retry','dispatching','acknowledged','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error_code TEXT,
  claim_token TEXT,
  claim_until TEXT,
  acknowledged_claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX client_portal_access_authority_outbox_due
  ON client_portal_access_authority_outbox(state,next_attempt_at,created_at);

CREATE TABLE client_portal_access_authority_receipts (
  operation_id TEXT PRIMARY KEY,
  client_receipt_json TEXT NOT NULL CHECK(json_valid(client_receipt_json)),
  acknowledged_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(operation_id) REFERENCES client_portal_access_authority_outbox(operation_id) ON DELETE RESTRICT
);

CREATE TABLE client_portal_access_authority_outbox_audit (
  operation_id TEXT PRIMARY KEY,
  authorized_by_staff_id TEXT NOT NULL,
  authorization_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action='shadow.intent.enqueued'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(operation_id) REFERENCES client_portal_access_authority_outbox(operation_id) ON DELETE RESTRICT
);

CREATE TRIGGER client_portal_access_authority_outbox_command_immutable
BEFORE UPDATE ON client_portal_access_authority_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.client_authority_id IS NOT OLD.client_authority_id OR NEW.issuer IS NOT OLD.issuer
  OR NEW.subject IS NOT OLD.subject OR NEW.desired_state IS NOT OLD.desired_state
  OR NEW.expected_revision IS NOT OLD.expected_revision OR NEW.authorized_by_staff_id IS NOT OLD.authorized_by_staff_id
  OR NEW.authorization_version IS NOT OLD.authorization_version
BEGIN SELECT RAISE(ABORT,'client portal authority command is immutable'); END;
CREATE TRIGGER client_portal_access_authority_outbox_audit_no_update
BEFORE UPDATE ON client_portal_access_authority_outbox_audit
BEGIN SELECT RAISE(ABORT,'client portal authority outbox audit is immutable'); END;
CREATE TRIGGER client_portal_access_authority_outbox_audit_no_delete
BEFORE DELETE ON client_portal_access_authority_outbox_audit
BEGIN SELECT RAISE(ABORT,'client portal authority outbox audit is immutable'); END;
