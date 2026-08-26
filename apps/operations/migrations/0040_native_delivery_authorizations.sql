-- A durable staff delegation, not a long-lived cache of the actor's role.
-- Delivery publication is a separate database transaction and is not claimed
-- to be atomic with this authorization decision.
CREATE TABLE native_delivery_authorizations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES staff_users(id),
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','revoke')),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  source_id TEXT NOT NULL REFERENCES pa_connectors(source_id),
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  operation_json TEXT NOT NULL CHECK(json_valid(operation_json) AND length(CAST(operation_json AS BLOB))<=8192),
  ops_proof_json TEXT NOT NULL CHECK(json_valid(ops_proof_json) AND length(CAST(ops_proof_json AS BLOB))<=16384),
  delivery_proof_json TEXT NOT NULL CHECK(json_valid(delivery_proof_json) AND length(CAST(delivery_proof_json AS BLOB))<=16384),
  publication_deadline TEXT NOT NULL CHECK(datetime(publication_deadline) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  write_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT native_delivery_authorization_guard CHECK(write_guard=1),
  UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX idx_native_delivery_authorizations_grant ON native_delivery_authorizations(grant_id,created_at,id);
CREATE TRIGGER native_delivery_authorization_no_update BEFORE UPDATE ON native_delivery_authorizations
BEGIN SELECT RAISE(ABORT,'native-delivery-authorization-immutable'); END;
CREATE TRIGGER native_delivery_authorization_no_delete BEFORE DELETE ON native_delivery_authorizations
BEGIN SELECT RAISE(ABORT,'native-delivery-authorization-immutable'); END;
CREATE TRIGGER native_delivery_authorization_no_replace BEFORE INSERT ON native_delivery_authorizations
WHEN EXISTS(SELECT 1 FROM native_delivery_authorizations WHERE id=NEW.id OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'native-delivery-authorization-immutable'); END;
