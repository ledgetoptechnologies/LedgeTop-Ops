PRAGMA foreign_keys=ON;

-- Additive foundation only. No existing object or client is backfilled, and
-- no queue/scheduler path is enabled by applying this migration.
CREATE TABLE portal_authenticated_delivery_change_receipts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE CHECK(length(receipt_key)=64 AND receipt_key NOT GLOB '*[^a-f0-9]*'),
  r2_key TEXT NOT NULL CHECK(length(r2_key)>0),
  object_version TEXT NOT NULL CHECK(length(object_version) BETWEEN 1 AND 512),
  object_etag TEXT,
  current_present INTEGER NOT NULL CHECK(current_present IN (0,1)),
  observed_event_at TEXT NOT NULL CHECK(julianday(observed_event_at) IS NOT NULL),
  index_applied INTEGER NOT NULL CHECK(index_applied=1),
  candidate_count INTEGER NOT NULL CHECK(candidate_count BETWEEN 0 AND 200),
  accepted_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(r2_key,object_version,current_present)
);
CREATE INDEX idx_authenticated_delivery_receipt_key_sequence
  ON portal_authenticated_delivery_change_receipts(r2_key,sequence);

-- These are acceptance-time recipients, not a query to be rerun after retry.
-- Mutable delivery attempts will live separately from these immutable facts.
CREATE TABLE portal_authenticated_delivery_change_receipt_targets (
  receipt_key TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK(grant_version>=1),
  logical_grant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  access_notice_enabled INTEGER NOT NULL CHECK(access_notice_enabled=1),
  change_mode TEXT NOT NULL CHECK(change_mode IN ('added','removed','both')),
  policy_version INTEGER NOT NULL CHECK(policy_version>=1),
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL CHECK(owner_scope_type IN ('organization','department','client','project')),
  owner_public_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL CHECK(length(r2_prefix)>0),
  PRIMARY KEY(receipt_key,grant_id,identity_id),
  FOREIGN KEY(receipt_key) REFERENCES portal_authenticated_delivery_change_receipts(receipt_key),
  FOREIGN KEY(grant_id,identity_id) REFERENCES portal_authenticated_delivery_notification_policies(grant_id,identity_id)
);

-- Seal the whole target set, including an intentionally empty set, in the
-- acceptance transaction. Immutability of individual rows alone would still
-- permit a later INSERT to expand recipients.
CREATE TABLE portal_authenticated_delivery_change_receipt_seals (
  receipt_key TEXT NOT NULL PRIMARY KEY,
  target_count INTEGER NOT NULL CHECK(target_count BETWEEN 0 AND 200),
  FOREIGN KEY(receipt_key) REFERENCES portal_authenticated_delivery_change_receipts(receipt_key)
);
-- A delete retry must recover its original upload identity after the index row
-- is gone. Never reconstruct that identity from a newer object at the same key.
CREATE TABLE portal_authenticated_delivery_change_receipt_deliveries (
  queue_name TEXT NOT NULL CHECK(length(queue_name) BETWEEN 1 AND 256),
  message_id TEXT NOT NULL CHECK(length(message_id) BETWEEN 1 AND 256),
  receipt_key TEXT NOT NULL,
  PRIMARY KEY(queue_name,message_id),
  FOREIGN KEY(receipt_key) REFERENCES portal_authenticated_delivery_change_receipt_seals(receipt_key)
);
CREATE TRIGGER authenticated_delivery_receipt_delivery_update
BEFORE UPDATE ON portal_authenticated_delivery_change_receipt_deliveries
BEGIN SELECT RAISE(ABORT,'accepted delivery message binding is immutable'); END;
CREATE TRIGGER authenticated_delivery_receipt_delivery_delete
BEFORE DELETE ON portal_authenticated_delivery_change_receipt_deliveries
BEGIN SELECT RAISE(ABORT,'accepted delivery message binding is immutable'); END;
CREATE TRIGGER authenticated_delivery_receipt_target_insert_guard
BEFORE INSERT ON portal_authenticated_delivery_change_receipt_targets
WHEN EXISTS(SELECT 1 FROM portal_authenticated_delivery_change_receipt_seals WHERE receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT,'accepted delivery recipient set is sealed'); END;
CREATE TRIGGER authenticated_delivery_receipt_seal_insert_guard
BEFORE INSERT ON portal_authenticated_delivery_change_receipt_seals
WHEN NEW.target_count<>(SELECT count(*) FROM portal_authenticated_delivery_change_receipt_targets WHERE receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT,'accepted delivery recipient count mismatch'); END;
CREATE TRIGGER authenticated_delivery_receipt_seal_update
BEFORE UPDATE ON portal_authenticated_delivery_change_receipt_seals
BEGIN SELECT RAISE(ABORT,'accepted delivery recipient seal is immutable'); END;
CREATE TRIGGER authenticated_delivery_receipt_seal_delete
BEFORE DELETE ON portal_authenticated_delivery_change_receipt_seals
BEGIN SELECT RAISE(ABORT,'accepted delivery recipient seal is immutable'); END;

CREATE TRIGGER authenticated_delivery_receipt_immutable_update
BEFORE UPDATE ON portal_authenticated_delivery_change_receipts
BEGIN SELECT RAISE(ABORT,'accepted delivery change is immutable'); END;
CREATE TRIGGER authenticated_delivery_receipt_immutable_delete
BEFORE DELETE ON portal_authenticated_delivery_change_receipts
BEGIN SELECT RAISE(ABORT,'accepted delivery change is immutable'); END;
CREATE TRIGGER authenticated_delivery_receipt_target_immutable_update
BEFORE UPDATE ON portal_authenticated_delivery_change_receipt_targets
BEGIN SELECT RAISE(ABORT,'accepted delivery recipient is immutable'); END;
CREATE TRIGGER authenticated_delivery_receipt_target_immutable_delete
BEFORE DELETE ON portal_authenticated_delivery_change_receipt_targets
BEGIN SELECT RAISE(ABORT,'accepted delivery recipient is immutable'); END;
