PRAGMA foreign_keys=ON;

-- Client bell history is an immutable summary of an already accepted exact
-- recipient batch.  It intentionally does not extend the PA grant receipt
-- ledger: file-change policy and current delivery authority are separate.
ALTER TABLE portal_authenticated_delivery_change_batches
  ADD COLUMN bell_published_at TEXT;
ALTER TABLE portal_authenticated_delivery_change_batches
  ADD COLUMN bell_retry_after TEXT;
ALTER TABLE portal_authenticated_delivery_change_batches
  ADD COLUMN email_suppressed_at TEXT;
ALTER TABLE portal_authenticated_delivery_change_batches
  ADD COLUMN email_suppressed_by_staff_id TEXT;

-- An unavailable source must not monopolize each bounded publication pass.
-- Retry ordering is independent of the content's original quiet-period time.
CREATE INDEX idx_authenticated_delivery_change_bell_schedule
  ON portal_authenticated_delivery_change_batches(COALESCE(bell_retry_after,eligible_at),id)
  WHERE status='pending' AND bell_published_at IS NULL AND added_count+removed_count>0;

CREATE TABLE authenticated_delivery_recipient_events (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK(grant_version>=1),
  logical_grant_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL CHECK(owner_scope_type IN ('organization','department','client','project')),
  owner_public_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version>=1),
  added_count INTEGER NOT NULL CHECK(added_count>=0),
  removed_count INTEGER NOT NULL CHECK(removed_count>=0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(added_count+removed_count>0),
  FOREIGN KEY(batch_id) REFERENCES portal_authenticated_delivery_change_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY(folder_binding_id,workspace_id) REFERENCES portal_v2_folder_bindings(id,workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY(identity_id) REFERENCES portal_v2_identities(id) ON DELETE RESTRICT
);
CREATE INDEX idx_authenticated_delivery_recipient_events_history
  ON authenticated_delivery_recipient_events(source_id,workspace_id,identity_id,created_at DESC,id DESC);

-- Read/dismiss state belongs to the current identity, never an email or a
-- principal.  The trigger prevents a future identity binding from acquiring
-- the original recipient's history state.
CREATE TABLE authenticated_delivery_recipient_event_state (
  event_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(event_id,recipient_identity_id),
  FOREIGN KEY(event_id) REFERENCES authenticated_delivery_recipient_events(id) ON DELETE RESTRICT,
  FOREIGN KEY(recipient_identity_id) REFERENCES portal_v2_identities(id) ON DELETE RESTRICT,
  CHECK(read_at IS NULL OR julianday(read_at) IS NOT NULL),
  CHECK(dismissed_at IS NULL OR julianday(dismissed_at) IS NOT NULL)
);
CREATE INDEX idx_authenticated_delivery_recipient_event_state_identity
  ON authenticated_delivery_recipient_event_state(recipient_identity_id,event_id);

-- A separate post-publication email control avoids relabelling cancellation:
-- a client-visible immutable bell event can never be cancelled or deleted.
CREATE TABLE authenticated_delivery_recipient_event_email_controls (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'),
  batch_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=1),
  result_revision INTEGER NOT NULL CHECK(result_revision=expected_revision+1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_staff_id,idempotency_key),
  FOREIGN KEY(batch_id) REFERENCES portal_authenticated_delivery_change_batches(id) ON DELETE RESTRICT
);

CREATE TRIGGER authenticated_delivery_recipient_event_insert_guard
BEFORE INSERT ON authenticated_delivery_recipient_events
WHEN NOT EXISTS(SELECT 1 FROM portal_authenticated_delivery_change_batches batch
  WHERE batch.id=NEW.batch_id AND batch.bell_published_at IS NOT NULL
    AND batch.grant_id=NEW.grant_id AND batch.grant_version=NEW.grant_version
    AND batch.logical_grant_id=NEW.logical_grant_id AND batch.source_id=NEW.source_id
    AND batch.workspace_id=NEW.workspace_id AND batch.folder_binding_id=NEW.folder_binding_id
    AND batch.binding_source_version=NEW.binding_source_version AND batch.owner_scope_type=NEW.owner_scope_type
    AND batch.owner_public_id=NEW.owner_public_id AND batch.r2_prefix=NEW.r2_prefix
    AND batch.identity_id=NEW.identity_id AND batch.principal_public_id=NEW.principal_public_id
    AND batch.principal_source_version=NEW.principal_source_version AND batch.policy_version=NEW.policy_version
    AND batch.added_count=NEW.added_count AND batch.removed_count=NEW.removed_count)
BEGIN SELECT RAISE(ABORT,'authenticated delivery recipient event requires sealed batch authority'); END;
CREATE TRIGGER authenticated_delivery_recipient_event_no_update
BEFORE UPDATE ON authenticated_delivery_recipient_events
BEGIN SELECT RAISE(ABORT,'authenticated delivery recipient event is immutable'); END;
CREATE TRIGGER authenticated_delivery_recipient_event_no_delete
BEFORE DELETE ON authenticated_delivery_recipient_events
BEGIN SELECT RAISE(ABORT,'authenticated delivery recipient event cannot be deleted'); END;
CREATE TRIGGER authenticated_delivery_recipient_event_no_replace
BEFORE INSERT ON authenticated_delivery_recipient_events
WHEN EXISTS(SELECT 1 FROM authenticated_delivery_recipient_events WHERE id=NEW.id OR batch_id=NEW.batch_id)
BEGIN SELECT RAISE(ABORT,'authenticated delivery recipient event cannot be replaced'); END;
-- Mail status/leases may continue to change, but the summary represented to a
-- recipient and every object item are frozen as soon as the bell is published.
CREATE TRIGGER authenticated_delivery_change_bell_summary_immutable
BEFORE UPDATE OF added_count,removed_count ON portal_authenticated_delivery_change_batches
WHEN OLD.bell_published_at IS NOT NULL
  AND (NEW.added_count<>OLD.added_count OR NEW.removed_count<>OLD.removed_count)
BEGIN SELECT RAISE(ABORT,'published authenticated delivery bell summary is immutable'); END;
CREATE TRIGGER authenticated_delivery_change_bell_item_immutable
BEFORE UPDATE ON portal_authenticated_delivery_change_batch_items
WHEN EXISTS(SELECT 1 FROM portal_authenticated_delivery_change_batches batch
  WHERE batch.id=OLD.batch_id AND batch.bell_published_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'published authenticated delivery bell items are immutable'); END;
CREATE TRIGGER authenticated_delivery_recipient_event_state_insert_guard
BEFORE INSERT ON authenticated_delivery_recipient_event_state
WHEN NOT EXISTS(SELECT 1 FROM authenticated_delivery_recipient_events event
  WHERE event.id=NEW.event_id AND event.identity_id=NEW.recipient_identity_id)
BEGIN SELECT RAISE(ABORT,'authenticated delivery recipient state requires fixed recipient'); END;
CREATE TRIGGER authenticated_delivery_recipient_event_state_identity_immutable
BEFORE UPDATE ON authenticated_delivery_recipient_event_state
WHEN NEW.event_id<>OLD.event_id OR NEW.recipient_identity_id<>OLD.recipient_identity_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'authenticated delivery recipient state identity is immutable'); END;
CREATE TRIGGER authenticated_delivery_recipient_event_email_control_no_update
BEFORE UPDATE ON authenticated_delivery_recipient_event_email_controls
BEGIN SELECT RAISE(ABORT,'authenticated delivery email control is immutable'); END;
CREATE TRIGGER authenticated_delivery_recipient_event_email_control_no_delete
BEFORE DELETE ON authenticated_delivery_recipient_event_email_controls
BEGIN SELECT RAISE(ABORT,'authenticated delivery email control is immutable'); END;
CREATE TRIGGER authenticated_delivery_recipient_event_email_control_no_replace
BEFORE INSERT ON authenticated_delivery_recipient_event_email_controls
WHEN EXISTS(SELECT 1 FROM authenticated_delivery_recipient_event_email_controls control
  WHERE control.actor_staff_id=NEW.actor_staff_id AND control.idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'authenticated delivery email control cannot be replaced'); END;
