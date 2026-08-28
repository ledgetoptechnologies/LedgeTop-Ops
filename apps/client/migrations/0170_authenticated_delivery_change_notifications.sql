PRAGMA foreign_keys=ON;

-- Explicit, exact-recipient preferences only. Applying this migration creates
-- no rows and enables nothing. A policy snapshots the immutable grant,
-- workspace, source, principal and identity versions that staff reviewed.
CREATE TABLE portal_authenticated_delivery_notification_policies (
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK(grant_version>=1),
  logical_grant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  access_notice_enabled INTEGER NOT NULL DEFAULT 0 CHECK(access_notice_enabled IN (0,1)),
  change_mode TEXT NOT NULL DEFAULT 'off' CHECK(change_mode IN ('off','added','removed','both')),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version>=1),
  updated_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(grant_id,identity_id),
  UNIQUE(grant_id,identity_id,policy_version),
  FOREIGN KEY(grant_id) REFERENCES portal_v2_authenticated_delivery_grants(id),
  FOREIGN KEY(grant_id,identity_id) REFERENCES portal_v2_authenticated_delivery_grant_recipients(grant_id,identity_id),
  FOREIGN KEY(workspace_id,identity_id) REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id),
  CHECK(access_notice_enabled=1 OR change_mode='off')
);
CREATE INDEX idx_authenticated_delivery_notification_policy_scope
  ON portal_authenticated_delivery_notification_policies(workspace_id,identity_id,change_mode);

CREATE TABLE portal_authenticated_delivery_notification_policy_mutations (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'),
  grant_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  expected_policy_version INTEGER,
  result_policy_version INTEGER NOT NULL CHECK(result_policy_version>=1),
  result_access_notice_enabled INTEGER NOT NULL CHECK(result_access_notice_enabled IN (0,1)),
  result_change_mode TEXT NOT NULL CHECK(result_change_mode IN ('off','added','removed','both')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_staff_id,idempotency_key),
  FOREIGN KEY(grant_id,identity_id) REFERENCES portal_authenticated_delivery_notification_policies(grant_id,identity_id)
);

CREATE TABLE portal_authenticated_delivery_notification_policy_audit (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version>=1),
  access_notice_enabled INTEGER NOT NULL CHECK(access_notice_enabled IN (0,1)),
  change_mode TEXT NOT NULL CHECK(change_mode IN ('off','added','removed','both')),
  action TEXT NOT NULL CHECK(action IN ('policy.created','policy.updated')),
  actor_staff_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_authenticated_delivery_notification_policy_audit
  ON portal_authenticated_delivery_notification_policy_audit(workspace_id,created_at DESC,id DESC);

-- A batch is owned by one exact immutable grant version and recipient. New
-- events never enter a sealed/claimed batch and the open batch is capped at 50.
CREATE TABLE portal_authenticated_delivery_change_batches (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK(grant_version>=1),
  logical_grant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL CHECK(owner_scope_type IN ('organization','department','client','project')),
  owner_public_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version>=1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','cancelled','suppressed','failed')),
  eligible_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')),
  added_count INTEGER NOT NULL DEFAULT 0 CHECK(added_count>=0),
  removed_count INTEGER NOT NULL DEFAULT 0 CHECK(removed_count>=0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  sealed_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  dispatch_fingerprint TEXT CHECK(dispatch_fingerprint IS NULL OR (length(dispatch_fingerprint)=64 AND dispatch_fingerprint NOT GLOB '*[^a-f0-9]*')),
  published_recipient_email TEXT,
  published_at TEXT,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(grant_id,identity_id) REFERENCES portal_authenticated_delivery_notification_policies(grant_id,identity_id),
  FOREIGN KEY(folder_binding_id,workspace_id) REFERENCES portal_v2_folder_bindings(id,workspace_id)
);
CREATE UNIQUE INDEX idx_authenticated_delivery_change_batch_open
  ON portal_authenticated_delivery_change_batches(grant_id,grant_version,identity_id,policy_version)
  WHERE status='pending' AND sealed_at IS NULL;
CREATE INDEX idx_authenticated_delivery_change_batch_ready
  ON portal_authenticated_delivery_change_batches(status,eligible_at,lease_expires_at,id);

CREATE TABLE portal_authenticated_delivery_change_batch_items (
  batch_id TEXT NOT NULL,
  object_fingerprint TEXT NOT NULL CHECK(length(object_fingerprint)=64),
  r2_key TEXT NOT NULL,
  baseline_present INTEGER NOT NULL CHECK(baseline_present IN (0,1)),
  current_present INTEGER NOT NULL CHECK(current_present IN (0,1)),
  baseline_object_version TEXT,
  current_object_version TEXT,
  event_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(batch_id,object_fingerprint),
  FOREIGN KEY(batch_id) REFERENCES portal_authenticated_delivery_change_batches(id)
);
CREATE INDEX idx_authenticated_delivery_change_items_token
  ON portal_authenticated_delivery_change_batch_items(event_token,batch_id);

-- Last accepted object version per exact recipient/grant. This is independent
-- of mail state, so queue replay cannot reopen a sent/cancelled window.
CREATE TABLE portal_authenticated_delivery_change_object_versions (
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK(grant_version>=1),
  identity_id TEXT NOT NULL,
  object_fingerprint TEXT NOT NULL CHECK(length(object_fingerprint)=64),
  r2_key TEXT NOT NULL,
  current_present INTEGER NOT NULL CHECK(current_present IN (0,1)),
  current_object_version TEXT,
  observed_event_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(grant_id,grant_version,identity_id,object_fingerprint),
  FOREIGN KEY(grant_id,identity_id) REFERENCES portal_authenticated_delivery_notification_policies(grant_id,identity_id)
);

CREATE TABLE portal_authenticated_delivery_change_controls (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
  batch_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('send-now','cancel')),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=1),
  result_revision INTEGER NOT NULL CHECK(result_revision=expected_revision+1),
  result_status TEXT NOT NULL CHECK(result_status IN ('pending','cancelled')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(actor_staff_id,idempotency_key),
  FOREIGN KEY(batch_id) REFERENCES portal_authenticated_delivery_change_batches(id)
);

CREATE TABLE portal_authenticated_delivery_change_audit (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('batch.staged','batch.claimed','batch.sent','batch.retry','batch.suppressed','batch.failed','batch.cancelled','batch.send_now')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 3),
  reason_code TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(batch_id) REFERENCES portal_authenticated_delivery_change_batches(id)
);

CREATE TRIGGER portal_authenticated_delivery_notification_policy_mutation_insert_guard BEFORE INSERT ON portal_authenticated_delivery_notification_policy_mutations
WHEN NOT EXISTS(SELECT 1 FROM portal_authenticated_delivery_notification_policies policy
  WHERE policy.grant_id=NEW.grant_id AND policy.identity_id=NEW.identity_id
    AND policy.policy_version=NEW.result_policy_version
    AND policy.access_notice_enabled=NEW.result_access_notice_enabled
    AND policy.change_mode=NEW.result_change_mode)
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy mutation result mismatch'); END;
CREATE TRIGGER portal_authenticated_delivery_change_control_insert_guard BEFORE INSERT ON portal_authenticated_delivery_change_controls
WHEN NOT EXISTS(SELECT 1 FROM portal_authenticated_delivery_change_batches batch
  WHERE batch.id=NEW.batch_id AND batch.revision=NEW.result_revision AND batch.status=NEW.result_status
    AND ((NEW.action='send-now' AND NEW.result_status='pending') OR (NEW.action='cancel' AND NEW.result_status='cancelled')))
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification control result mismatch'); END;

CREATE TRIGGER portal_authenticated_delivery_notification_policy_insert_guard BEFORE INSERT ON portal_authenticated_delivery_notification_policies
WHEN NEW.policy_version<>1 OR NOT EXISTS(
  SELECT 1 FROM portal_v2_authenticated_delivery_grants grant_record
  JOIN portal_v2_authenticated_delivery_grant_recipients recipient
    ON recipient.grant_id=grant_record.id AND recipient.identity_id=NEW.identity_id
  JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id
  WHERE grant_record.id=NEW.grant_id AND grant_record.grant_version=NEW.grant_version
    AND grant_record.logical_grant_id=NEW.logical_grant_id AND grant_record.workspace_id=NEW.workspace_id
    AND workspace.project_alpha_source_id=NEW.source_id AND grant_record.audience_type='principal'
    AND grant_record.audience_public_id=NEW.principal_public_id
    AND grant_record.audience_source_version=NEW.principal_source_version
    AND recipient.workspace_id=NEW.workspace_id AND recipient.principal_public_id=NEW.principal_public_id
    AND recipient.principal_source_version=NEW.principal_source_version)
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy authority mismatch'); END;
CREATE TRIGGER portal_authenticated_delivery_notification_policy_update_guard BEFORE UPDATE ON portal_authenticated_delivery_notification_policies
WHEN NEW.grant_id<>OLD.grant_id OR NEW.grant_version<>OLD.grant_version OR NEW.logical_grant_id<>OLD.logical_grant_id
  OR NEW.workspace_id<>OLD.workspace_id OR NEW.source_id<>OLD.source_id OR NEW.identity_id<>OLD.identity_id
  OR NEW.principal_public_id<>OLD.principal_public_id OR NEW.principal_source_version<>OLD.principal_source_version
  OR NEW.created_at<>OLD.created_at OR NEW.policy_version<>OLD.policy_version+1
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy identity is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_notification_policy_delete BEFORE DELETE ON portal_authenticated_delivery_notification_policies
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy history cannot be deleted'); END;

CREATE TRIGGER portal_authenticated_delivery_notification_policy_mutation_update BEFORE UPDATE ON portal_authenticated_delivery_notification_policy_mutations
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy mutation is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_notification_policy_mutation_delete BEFORE DELETE ON portal_authenticated_delivery_notification_policy_mutations
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy mutation is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_notification_policy_audit_update BEFORE UPDATE ON portal_authenticated_delivery_notification_policy_audit
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy audit is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_notification_policy_audit_delete BEFORE DELETE ON portal_authenticated_delivery_notification_policy_audit
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy audit is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_change_audit_update BEFORE UPDATE ON portal_authenticated_delivery_change_audit
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification audit is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_change_audit_delete BEFORE DELETE ON portal_authenticated_delivery_change_audit
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification audit is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_change_control_update BEFORE UPDATE ON portal_authenticated_delivery_change_controls
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification control is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_change_control_delete BEFORE DELETE ON portal_authenticated_delivery_change_controls
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification control is immutable'); END;

CREATE TRIGGER portal_authenticated_delivery_change_batch_identity_update BEFORE UPDATE ON portal_authenticated_delivery_change_batches
WHEN NEW.id<>OLD.id OR NEW.grant_id<>OLD.grant_id OR NEW.grant_version<>OLD.grant_version
  OR NEW.logical_grant_id<>OLD.logical_grant_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.source_id<>OLD.source_id
  OR NEW.folder_binding_id<>OLD.folder_binding_id OR NEW.binding_source_version<>OLD.binding_source_version
  OR NEW.owner_scope_type<>OLD.owner_scope_type OR NEW.owner_public_id<>OLD.owner_public_id OR NEW.r2_prefix<>OLD.r2_prefix
  OR NEW.identity_id<>OLD.identity_id OR NEW.principal_public_id<>OLD.principal_public_id
  OR NEW.principal_source_version<>OLD.principal_source_version OR NEW.policy_version<>OLD.policy_version
  OR NEW.created_at<>OLD.created_at OR (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS NOT OLD.sealed_at)
  OR (OLD.dispatch_fingerprint IS NOT NULL AND NEW.dispatch_fingerprint IS NOT OLD.dispatch_fingerprint)
  OR (OLD.published_recipient_email IS NOT NULL AND NEW.published_recipient_email IS NOT OLD.published_recipient_email)
  OR (OLD.published_at IS NOT NULL AND NEW.published_at IS NOT OLD.published_at)
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification batch identity is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_change_batch_delete BEFORE DELETE ON portal_authenticated_delivery_change_batches
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification batch history cannot be deleted'); END;
CREATE TRIGGER portal_authenticated_delivery_change_item_identity_update BEFORE UPDATE ON portal_authenticated_delivery_change_batch_items
WHEN NEW.batch_id<>OLD.batch_id OR NEW.object_fingerprint<>OLD.object_fingerprint OR NEW.r2_key<>OLD.r2_key
  OR NEW.baseline_present<>OLD.baseline_present OR NEW.baseline_object_version IS NOT OLD.baseline_object_version
  OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification item identity is immutable'); END;
CREATE TRIGGER portal_authenticated_delivery_change_item_delete BEFORE DELETE ON portal_authenticated_delivery_change_batch_items
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification item history cannot be deleted'); END;
CREATE TRIGGER portal_authenticated_delivery_change_object_version_update BEFORE UPDATE ON portal_authenticated_delivery_change_object_versions
WHEN NEW.grant_id<>OLD.grant_id OR NEW.grant_version<>OLD.grant_version OR NEW.identity_id<>OLD.identity_id
  OR NEW.object_fingerprint<>OLD.object_fingerprint OR NEW.r2_key<>OLD.r2_key
  OR datetime(NEW.observed_event_at)<datetime(OLD.observed_event_at)
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification object version regressed'); END;
CREATE TRIGGER portal_authenticated_delivery_change_object_version_delete BEFORE DELETE ON portal_authenticated_delivery_change_object_versions
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification object version history cannot be deleted'); END;
