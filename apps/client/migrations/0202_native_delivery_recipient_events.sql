PRAGMA foreign_keys = ON;

-- Recipient-facing native delivery history is intentionally separate from
-- mail batches/outboxes.  It records the exact principal and authorization
-- coordinates accepted by the Project Alpha intent transaction; a later
-- reader supplies live identity authorization and per-identity read state.
CREATE TABLE native_delivery_recipient_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK(grant_version >= 1),
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL CHECK(owner_scope_type IN ('organization','department','client','project')),
  owner_public_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  -- Adding a new event kind requires a migration that rebuilds this CHECK and
  -- adds a corresponding insert-authority trigger; do not widen it in a
  -- producer-only change.
  event_type TEXT NOT NULL CHECK(event_type='grant_accepted'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_id,receipt_id,event_type),
  FOREIGN KEY(receipt_id) REFERENCES project_alpha_delivery_intent_receipts(receipt_id),
  FOREIGN KEY(grant_id) REFERENCES project_alpha_delivery_portal_grants(id),
  FOREIGN KEY(folder_binding_id,workspace_id) REFERENCES portal_v2_folder_bindings(id,workspace_id)
);

CREATE INDEX idx_native_delivery_recipient_events_principal_history
  ON native_delivery_recipient_events(source_id,workspace_id,principal_public_id,principal_source_version,created_at DESC,id DESC);
CREATE INDEX idx_native_delivery_recipient_events_principal_chronological
  ON native_delivery_recipient_events(source_id,workspace_id,principal_public_id,created_at DESC,id DESC);

-- State is deliberately per current portal identity, never per principal or
-- email address. Thus a later identity binding/rebinding cannot acquire a
-- former identity's read or dismiss state. The Client mutation route must
-- supply the live authorization fence when creating or updating this row.
CREATE TABLE native_delivery_recipient_event_state (
  event_id TEXT NOT NULL,
  recipient_identity_id TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(event_id,recipient_identity_id),
  FOREIGN KEY(event_id) REFERENCES native_delivery_recipient_events(id) ON DELETE RESTRICT,
  FOREIGN KEY(recipient_identity_id) REFERENCES portal_v2_identities(id) ON DELETE RESTRICT,
  CHECK(read_at IS NULL OR julianday(read_at) IS NOT NULL),
  CHECK(dismissed_at IS NULL OR julianday(dismissed_at) IS NOT NULL)
);
CREATE INDEX idx_native_delivery_recipient_event_state_identity
  ON native_delivery_recipient_event_state(recipient_identity_id,event_id);

-- A producer event may be replayed, but it may never be redirected to a
-- different principal, binding, grant, or source.  Do not constrain future
-- event_type values here without a schema migration: each new producer kind
-- must extend the CHECK and add its own authority validation before it can
-- write this ledger.
CREATE TRIGGER native_delivery_recipient_event_insert_guard
BEFORE INSERT ON native_delivery_recipient_events
WHEN NOT EXISTS(
  SELECT 1 FROM project_alpha_delivery_intent_receipts receipt
  JOIN project_alpha_delivery_portal_grants grant_record ON grant_record.id=NEW.grant_id
  JOIN portal_v2_workspaces workspace ON workspace.id=NEW.workspace_id
    AND workspace.project_alpha_source_id=NEW.source_id
  JOIN portal_v2_folder_bindings binding ON binding.id=NEW.folder_binding_id
    AND binding.workspace_id=NEW.workspace_id
  WHERE receipt.receipt_id=NEW.receipt_id AND receipt.project_alpha_source_id=NEW.source_id
    AND receipt.access_mode='portal' AND receipt.resource_id=NEW.grant_id
    AND grant_record.workspace_id=NEW.workspace_id AND grant_record.folder_binding_id=NEW.folder_binding_id
    AND grant_record.binding_source_version=NEW.binding_source_version AND grant_record.grant_version=NEW.grant_version
    AND grant_record.audience_type='principal' AND grant_record.audience_public_id=NEW.principal_public_id
    AND grant_record.audience_source_version=NEW.principal_source_version
    AND binding.source_version=NEW.binding_source_version AND binding.owner_scope_type=NEW.owner_scope_type
    AND binding.owner_public_id=NEW.owner_public_id AND binding.r2_prefix=NEW.r2_prefix
)
BEGIN SELECT RAISE(ABORT,'native delivery recipient event requires exact accepted authority'); END;

CREATE TRIGGER native_delivery_recipient_event_replay_guard
BEFORE INSERT ON native_delivery_recipient_events
WHEN EXISTS(SELECT 1 FROM native_delivery_recipient_events old
  WHERE old.source_id=NEW.source_id AND old.receipt_id=NEW.receipt_id AND old.event_type=NEW.event_type
    AND (old.id<>NEW.id OR old.workspace_id<>NEW.workspace_id OR old.grant_id<>NEW.grant_id
      OR old.grant_version<>NEW.grant_version OR old.folder_binding_id<>NEW.folder_binding_id
      OR old.binding_source_version<>NEW.binding_source_version OR old.owner_scope_type<>NEW.owner_scope_type
      OR old.owner_public_id<>NEW.owner_public_id OR old.r2_prefix<>NEW.r2_prefix
      OR old.principal_public_id<>NEW.principal_public_id OR old.principal_source_version<>NEW.principal_source_version
      OR old.created_at<>NEW.created_at))
BEGIN SELECT RAISE(ABORT,'native delivery recipient event replay conflicts'); END;

CREATE TRIGGER native_delivery_recipient_event_no_update
BEFORE UPDATE ON native_delivery_recipient_events
BEGIN SELECT RAISE(ABORT,'native delivery recipient event is immutable'); END;
CREATE TRIGGER native_delivery_recipient_event_no_delete
BEFORE DELETE ON native_delivery_recipient_events
BEGIN SELECT RAISE(ABORT,'native delivery recipient event cannot be deleted'); END;
CREATE TRIGGER native_delivery_recipient_event_no_replace
BEFORE INSERT ON native_delivery_recipient_events
WHEN EXISTS(SELECT 1 FROM native_delivery_recipient_events WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'native delivery recipient event cannot be replaced'); END;
