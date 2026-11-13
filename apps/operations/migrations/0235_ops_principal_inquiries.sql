-- Operations-owned client inquiries authorized by an independently verified
-- current request.create companion and the exact v3 service-home parent.
-- The caller is the authenticated Client Worker over a private service binding.
CREATE TABLE operations_native_principal_inquiry_authority_guard (
  guard_id TEXT NOT NULL CHECK(length(guard_id)=36),
  target_id TEXT NOT NULL,
  recipient_binding_id TEXT NOT NULL,
  PRIMARY KEY(guard_id,target_id,recipient_binding_id)
);

CREATE TABLE operations_native_principal_inquiries (
  inquiry_id TEXT PRIMARY KEY CHECK(length(inquiry_id)=36),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  authority_set_json TEXT NOT NULL CHECK(json_valid(authority_set_json) AND json_type(authority_set_json)='array'
    AND json_array_length(authority_set_json) BETWEEN 1 AND 20 AND length(CAST(authority_set_json AS BLOB))<=65536),
  authority_set_sha256 TEXT NOT NULL CHECK(length(authority_set_sha256)=64 AND authority_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK(kind IN ('website','drone','other')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  details TEXT NOT NULL CHECK(length(details) BETWEEN 1 AND 4000),
  location TEXT CHECK(location IS NULL OR length(location)<=300),
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','under_review','declined','closed')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(issuer,subject,idempotency_key)
);
CREATE INDEX operations_native_principal_inquiries_recipient_history
  ON operations_native_principal_inquiries(issuer,subject,created_at DESC,inquiry_id DESC);
CREATE INDEX operations_native_principal_inquiries_staff_queue
  ON operations_native_principal_inquiries(status,created_at,inquiry_id);

CREATE TABLE operations_native_principal_inquiry_outbox (
  outbox_id TEXT PRIMARY KEY CHECK(length(outbox_id)=36),
  inquiry_id TEXT NOT NULL REFERENCES operations_native_principal_inquiries(inquiry_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type='inquiry_submitted'),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object' AND length(CAST(payload_json AS BLOB))<=2048),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at INTEGER NOT NULL DEFAULT(unixepoch()*1000),
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((lease_token IS NULL AND lease_expires_at IS NULL) OR (state='claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

-- These entries live in the Operations ledger, not the Client audit_log
-- schema. Principal identifiers are represented only by the authority-set hash.
CREATE TABLE operations_native_principal_inquiry_audit (
  event_id TEXT PRIMARY KEY CHECK(length(event_id)=36),
  inquiry_id TEXT NOT NULL REFERENCES operations_native_principal_inquiries(inquiry_id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('principal','staff')),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 191),
  action TEXT NOT NULL CHECK(action IN ('submitted','status_changed')),
  details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json)='object' AND length(CAST(details_json AS BLOB))<=2048),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((actor_type='principal' AND action='submitted') OR (actor_type='staff' AND action='status_changed'))
);
CREATE INDEX operations_native_principal_inquiry_audit_history
  ON operations_native_principal_inquiry_audit(inquiry_id,created_at,event_id);

CREATE TRIGGER operations_native_principal_inquiry_audit_insert_guard
BEFORE INSERT ON operations_native_principal_inquiry_audit
WHEN NOT EXISTS(SELECT 1 FROM operations_native_principal_inquiries inquiry
  WHERE inquiry.inquiry_id=NEW.inquiry_id
    AND (NEW.actor_type='principal' AND NEW.actor_id=inquiry.authority_set_sha256
      OR NEW.actor_type='staff' AND EXISTS(SELECT 1 FROM staff_users user
        WHERE user.id=NEW.actor_id AND user.status='active')))
BEGIN SELECT RAISE(ABORT,'Operations principal inquiry audit identity is invalid'); END;
CREATE TRIGGER operations_native_principal_inquiry_audit_no_update
BEFORE UPDATE ON operations_native_principal_inquiry_audit
BEGIN SELECT RAISE(ABORT,'Operations principal inquiry audit is immutable'); END;
CREATE TRIGGER operations_native_principal_inquiry_audit_no_delete
BEFORE DELETE ON operations_native_principal_inquiry_audit
BEGIN SELECT RAISE(ABORT,'Operations principal inquiry audit is durable'); END;

CREATE TRIGGER operations_native_principal_inquiries_immutable_scope
BEFORE UPDATE OF issuer,subject,authority_set_json,authority_set_sha256,idempotency_key,request_fingerprint,kind,title,details,location,created_at
ON operations_native_principal_inquiries
BEGIN SELECT RAISE(ABORT,'Operations principal inquiry scope is immutable'); END;
CREATE TRIGGER operations_native_principal_inquiries_status_transition
BEFORE UPDATE OF status ON operations_native_principal_inquiries
WHEN NOT ((OLD.status='received' AND NEW.status IN ('under_review','declined'))
  OR (OLD.status='under_review' AND NEW.status IN ('declined','closed'))
  OR (OLD.status='declined' AND NEW.status='closed'))
BEGIN SELECT RAISE(ABORT,'Invalid Operations principal inquiry transition'); END;
CREATE TRIGGER operations_native_principal_inquiries_no_delete
BEFORE DELETE ON operations_native_principal_inquiries
BEGIN SELECT RAISE(ABORT,'Operations principal inquiry history is immutable'); END;
