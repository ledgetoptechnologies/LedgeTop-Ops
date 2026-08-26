PRAGMA foreign_keys = ON;

-- Notification staging is not a grant or an audience expansion. Every item
-- points back to the immutable, explicitly addressed delivery-intent outbox.
CREATE TABLE portal_delivery_notification_batches (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL CHECK(owner_scope_type IN ('organization','department','client','project')),
  owner_public_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','cancelled','suppressed','failed')),
  eligible_at TEXT NOT NULL DEFAULT(datetime('now','+5 minutes')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  sealed_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  dispatch_fingerprint TEXT CHECK(dispatch_fingerprint IS NULL OR (length(dispatch_fingerprint)=64 AND dispatch_fingerprint NOT GLOB '*[^a-f0-9]*')),
  published_recipient_email TEXT CHECK(published_recipient_email IS NULL OR length(published_recipient_email) BETWEEN 3 AND 254),
  published_at TEXT,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(workspace_id,source_id) REFERENCES pa_portal_workspace_sources(workspace_id,projection_source_id),
  FOREIGN KEY(folder_binding_id,workspace_id) REFERENCES portal_v2_folder_bindings(id,workspace_id)
);
CREATE UNIQUE INDEX idx_portal_delivery_notification_open ON portal_delivery_notification_batches
  (source_id,workspace_id,folder_binding_id,binding_source_version,principal_public_id,principal_source_version)
  WHERE status='pending' AND sealed_at IS NULL;
CREATE INDEX idx_portal_delivery_notification_history ON portal_delivery_notification_batches(created_at DESC,id DESC);
CREATE INDEX idx_portal_delivery_notification_pending ON portal_delivery_notification_batches(created_at DESC,id DESC)
  WHERE status IN ('pending','processing');
CREATE INDEX idx_portal_delivery_notification_ready ON portal_delivery_notification_batches(status,eligible_at,lease_expires_at,id);
CREATE INDEX idx_portal_delivery_notification_direct_history
  ON project_alpha_delivery_portal_notification_outbox(created_at DESC,id DESC);
CREATE INDEX idx_portal_delivery_notification_direct_pending
  ON project_alpha_delivery_portal_notification_outbox(created_at DESC,id DESC) WHERE status IN ('pending','processing');

CREATE TABLE portal_delivery_notification_items (
  outbox_id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK(grant_version>=1),
  staging_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(outbox_id) REFERENCES project_alpha_delivery_portal_notification_outbox(id),
  FOREIGN KEY(batch_id) REFERENCES portal_delivery_notification_batches(id)
);
CREATE INDEX idx_portal_delivery_notification_items_batch ON portal_delivery_notification_items(batch_id,outbox_id);
CREATE INDEX idx_portal_delivery_notification_items_token ON portal_delivery_notification_items(staging_token,batch_id);

CREATE TRIGGER portal_delivery_notification_batch_identity_update BEFORE UPDATE ON portal_delivery_notification_batches
WHEN NEW.id IS NOT OLD.id OR NEW.source_id IS NOT OLD.source_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.folder_binding_id IS NOT OLD.folder_binding_id OR NEW.binding_source_version IS NOT OLD.binding_source_version
  OR NEW.principal_public_id IS NOT OLD.principal_public_id OR NEW.principal_source_version IS NOT OLD.principal_source_version
  OR NEW.owner_scope_type IS NOT OLD.owner_scope_type OR NEW.owner_public_id IS NOT OLD.owner_public_id
  OR NEW.r2_prefix IS NOT OLD.r2_prefix OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS NOT OLD.sealed_at)
  OR (OLD.dispatch_fingerprint IS NOT NULL AND NEW.dispatch_fingerprint IS NOT OLD.dispatch_fingerprint)
  OR (OLD.published_recipient_email IS NOT NULL AND NEW.published_recipient_email IS NOT OLD.published_recipient_email)
  OR (OLD.published_at IS NOT NULL AND NEW.published_at IS NOT OLD.published_at)
BEGIN SELECT RAISE(ABORT,'native-notification-identity-immutable'); END;
CREATE TRIGGER portal_delivery_notification_batch_replace BEFORE INSERT ON portal_delivery_notification_batches
WHEN EXISTS(SELECT 1 FROM portal_delivery_notification_batches WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'native-notification-replace-forbidden'); END;
CREATE TRIGGER portal_delivery_notification_batch_delete BEFORE DELETE ON portal_delivery_notification_batches
BEGIN SELECT RAISE(ABORT,'native-notification-history-immutable'); END;
CREATE TRIGGER portal_delivery_notification_item_guard BEFORE INSERT ON portal_delivery_notification_items
WHEN EXISTS(SELECT 1 FROM portal_delivery_notification_items WHERE outbox_id=NEW.outbox_id)
  OR NOT EXISTS(SELECT 1 FROM portal_delivery_notification_batches batch
    JOIN project_alpha_delivery_portal_notification_outbox outbox ON outbox.id=NEW.outbox_id
    JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=outbox.receipt_id
      AND receipt.access_mode='portal' AND receipt.resource_id=outbox.grant_id
    JOIN project_alpha_delivery_portal_grants grant_row ON grant_row.id=outbox.grant_id
    JOIN portal_v2_folder_bindings binding ON binding.id=grant_row.folder_binding_id AND binding.workspace_id=grant_row.workspace_id
    WHERE batch.id=NEW.batch_id AND batch.status='pending' AND batch.sealed_at IS NULL
      AND receipt.project_alpha_source_id=batch.source_id AND grant_row.workspace_id=batch.workspace_id
      AND grant_row.folder_binding_id=batch.folder_binding_id AND grant_row.binding_source_version=batch.binding_source_version
      AND grant_row.audience_type='principal' AND grant_row.audience_public_id=batch.principal_public_id
      AND grant_row.audience_source_version=batch.principal_source_version
      AND grant_row.grant_version=NEW.grant_version
      AND outbox.principal_public_id=batch.principal_public_id AND outbox.principal_source_version=batch.principal_source_version
      AND binding.owner_scope_type=batch.owner_scope_type AND binding.owner_public_id=batch.owner_public_id AND binding.r2_prefix=batch.r2_prefix
      AND outbox.event_type='granted' AND outbox.status='pending' AND outbox.attempt_count=0 AND outbox.lease_expires_at IS NULL
      AND (SELECT count(*) FROM portal_delivery_notification_items item WHERE item.batch_id=batch.id)<50)
BEGIN SELECT RAISE(ABORT,'native-notification-item-authority-conflict'); END;
CREATE TRIGGER portal_delivery_notification_item_update BEFORE UPDATE ON portal_delivery_notification_items
BEGIN SELECT RAISE(ABORT,'native-notification-item-immutable'); END;
CREATE TRIGGER portal_delivery_notification_item_delete BEFORE DELETE ON portal_delivery_notification_items
BEGIN SELECT RAISE(ABORT,'native-notification-item-immutable'); END;

CREATE TABLE portal_delivery_notification_controls (
  actor_id TEXT NOT NULL,
  mutation_key TEXT NOT NULL CHECK(length(mutation_key) BETWEEN 16 AND 128),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  batch_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('send-now','cancel')),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=1),
  result_revision INTEGER NOT NULL CHECK(result_revision=expected_revision+1),
  result_status TEXT NOT NULL CHECK(result_status IN ('pending','cancelled')),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(actor_id,mutation_key),
  FOREIGN KEY(batch_id) REFERENCES portal_delivery_notification_batches(id)
);
CREATE INDEX idx_portal_delivery_notification_controls_batch ON portal_delivery_notification_controls(batch_id,created_at);
CREATE TRIGGER portal_delivery_notification_control_result BEFORE INSERT ON portal_delivery_notification_controls
WHEN EXISTS(SELECT 1 FROM portal_delivery_notification_controls WHERE actor_id=NEW.actor_id AND mutation_key=NEW.mutation_key)
  OR NOT EXISTS(SELECT 1 FROM portal_delivery_notification_batches batch WHERE batch.id=NEW.batch_id
    AND batch.revision=NEW.result_revision AND batch.status=NEW.result_status
    AND ((NEW.action='cancel' AND NEW.result_status='cancelled') OR (NEW.action='send-now' AND NEW.result_status='pending')))
BEGIN SELECT RAISE(ABORT,'native-notification-control-result-conflict'); END;
CREATE TRIGGER portal_delivery_notification_control_update BEFORE UPDATE ON portal_delivery_notification_controls
BEGIN SELECT RAISE(ABORT,'native-notification-control-immutable'); END;
CREATE TRIGGER portal_delivery_notification_control_delete BEFORE DELETE ON portal_delivery_notification_controls
BEGIN SELECT RAISE(ABORT,'native-notification-control-immutable'); END;
