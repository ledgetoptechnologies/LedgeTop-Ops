PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project_alpha_delivery_intent_receipts (
  receipt_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('portal','guest')),
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status='accepted'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Integration grants are intentionally separate from staff-authored grant
-- history. Portal authorization readers union this table after applying the
-- same live binding, directory, entitlement and denial checks.
CREATE TABLE IF NOT EXISTS project_alpha_delivery_portal_grants (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  audience_type TEXT NOT NULL CHECK (audience_type='principal'),
  audience_public_id TEXT NOT NULL,
  audience_source_version TEXT NOT NULL,
  grant_version INTEGER NOT NULL DEFAULT 1 CHECK(grant_version>=1),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  expires_at TEXT,
  label TEXT,
  actor_kind TEXT NOT NULL DEFAULT 'project_alpha_delivery' CHECK (actor_kind='project_alpha_delivery'),
  actor_id TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id,workspace_id),
  FOREIGN KEY (receipt_id) REFERENCES project_alpha_delivery_intent_receipts(receipt_id),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id),
  FOREIGN KEY (folder_binding_id,workspace_id) REFERENCES portal_v2_folder_bindings(id,workspace_id),
  CHECK (expires_at IS NULL OR datetime(expires_at) IS NOT NULL),
  CHECK((status='active' AND revoked_at IS NULL AND revoke_reason_code IS NULL) OR
    (status='revoked' AND revoked_at IS NOT NULL AND revoke_reason_code='project_alpha_delivery_revoked') OR
    (status='expired' AND revoked_at IS NULL AND revoke_reason_code IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_project_alpha_delivery_portal_grants_scope
  ON project_alpha_delivery_portal_grants(workspace_id,folder_binding_id,expires_at);
CREATE TABLE IF NOT EXISTS project_alpha_delivery_intent_audit (
  id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('portal.accepted','guest.accepted','portal.expired','portal.revoked','guest.revoked')),
  actor_kind TEXT NOT NULL DEFAULT 'project_alpha_delivery' CHECK(actor_kind='project_alpha_delivery'), actor_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)), created_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(receipt_id) REFERENCES project_alpha_delivery_intent_receipts(receipt_id)
);
CREATE TRIGGER IF NOT EXISTS project_alpha_delivery_portal_grants_immutable
BEFORE UPDATE ON project_alpha_delivery_portal_grants
WHEN NEW.id<>OLD.id OR NEW.receipt_id<>OLD.receipt_id OR NEW.workspace_id<>OLD.workspace_id OR
  NEW.folder_binding_id<>OLD.folder_binding_id OR NEW.binding_source_version<>OLD.binding_source_version OR
  NEW.audience_type<>OLD.audience_type OR NEW.audience_public_id<>OLD.audience_public_id OR
  NEW.audience_source_version<>OLD.audience_source_version OR NEW.expires_at IS NOT OLD.expires_at OR
  NEW.label IS NOT OLD.label OR NEW.actor_kind<>OLD.actor_kind OR NEW.actor_id<>OLD.actor_id OR
  NEW.created_at<>OLD.created_at OR OLD.status<>'active' OR NEW.grant_version<>OLD.grant_version+1 OR
  NOT((NEW.status='revoked' AND NEW.revoked_at IS NOT NULL AND NEW.revoke_reason_code='project_alpha_delivery_revoked') OR
      (NEW.status='expired' AND NEW.revoked_at IS NULL AND NEW.revoke_reason_code IS NULL))
BEGIN SELECT RAISE(ABORT,'Project Alpha delivery grants are immutable'); END;
CREATE TRIGGER IF NOT EXISTS project_alpha_delivery_portal_grants_prevent_delete
BEFORE DELETE ON project_alpha_delivery_portal_grants
BEGIN SELECT RAISE(ABORT,'Project Alpha delivery grants cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS project_alpha_delivery_intent_revocation_receipts (
  receipt_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE, original_receipt_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64), created_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(original_receipt_id) REFERENCES project_alpha_delivery_intent_receipts(receipt_id)
);

CREATE TABLE IF NOT EXISTS project_alpha_delivery_portal_notification_outbox (
  id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, grant_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL, principal_source_version TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('granted','revoked')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT(datetime('now')),
  lease_expires_at TEXT, last_error TEXT, delivered_at TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')), UNIQUE(receipt_id,event_type),
  FOREIGN KEY(receipt_id) REFERENCES project_alpha_delivery_intent_receipts(receipt_id),
  FOREIGN KEY(grant_id) REFERENCES project_alpha_delivery_portal_grants(id)
);
CREATE INDEX IF NOT EXISTS idx_project_alpha_delivery_portal_notification_ready
  ON project_alpha_delivery_portal_notification_outbox(status,next_attempt_at,lease_expires_at,created_at);

-- Authoritative context for integration-owned guest shares. Notification
-- delivery and exact-compatible reuse must revalidate this live source state;
-- the audience snapshot alone intentionally does not carry PA source versions.
CREATE TABLE IF NOT EXISTS project_alpha_delivery_guest_authority (
  share_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  directory_generation_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(share_id) REFERENCES shares(id),
  FOREIGN KEY(folder_binding_id,workspace_id) REFERENCES portal_v2_folder_bindings(id,workspace_id),
  CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_project_alpha_delivery_guest_authority_principal
  ON project_alpha_delivery_guest_authority(workspace_id,principal_public_id,status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_alpha_delivery_portal_grant_active_exact
  ON project_alpha_delivery_portal_grants(folder_binding_id,binding_source_version,audience_public_id,audience_source_version)
  WHERE status='active';
