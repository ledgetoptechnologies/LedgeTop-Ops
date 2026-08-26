-- One immutable staff decision receipt. Delivery publication is a separate
-- transaction; this is not a cross-database transaction or a reusable grant.
CREATE TABLE invitation_review_authorizations (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES staff_users(id),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  action TEXT NOT NULL CHECK(action IN ('approve','reject','policy')),
  source_id TEXT NOT NULL CHECK(source_id GLOB 'project-alpha:*'),
  workspace_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  operation_json TEXT NOT NULL CHECK(json_valid(operation_json) AND length(CAST(operation_json AS BLOB))<=8192),
  ops_proof_json TEXT NOT NULL CHECK(json_valid(ops_proof_json) AND length(CAST(ops_proof_json AS BLOB))<=32768),
  delivery_context TEXT NOT NULL CHECK(length(delivery_context)=64 AND delivery_context NOT GLOB '*[^a-f0-9]*'),
  publication_deadline TEXT NOT NULL CHECK(datetime(publication_deadline) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  write_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT invitation_review_authorization_guard CHECK(write_guard=1),
  UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX idx_invitation_review_subject ON invitation_review_authorizations(source_id,workspace_id,subject_id,created_at,id);
CREATE TRIGGER invitation_review_receipt_no_update BEFORE UPDATE ON invitation_review_authorizations
BEGIN SELECT RAISE(ABORT,'invitation-review-authorization-immutable'); END;
CREATE TRIGGER invitation_review_receipt_no_delete BEFORE DELETE ON invitation_review_authorizations
BEGIN SELECT RAISE(ABORT,'invitation-review-authorization-immutable'); END;
CREATE TRIGGER invitation_review_receipt_no_replace BEFORE INSERT ON invitation_review_authorizations
WHEN EXISTS(SELECT 1 FROM invitation_review_authorizations WHERE id=NEW.id OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'invitation-review-authorization-immutable'); END;
