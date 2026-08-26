-- Explicit secondary staff delegations. A pending grant is never readable:
-- native readers intersect the existing grant with the publication gate.
CREATE TABLE portal_native_staff_bindings (
  binding_id TEXT PRIMARY KEY REFERENCES portal_v2_folder_bindings(id),
  source_id TEXT NOT NULL REFERENCES pa_portal_source_authorities(source_id),
  workspace_id TEXT NOT NULL REFERENCES portal_v2_workspaces(id),
  project_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  division_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(workspace_id,r2_prefix)
);
CREATE TABLE portal_native_staff_grants (
  grant_id TEXT PRIMARY KEY REFERENCES portal_v2_authenticated_delivery_grants(id),
  binding_id TEXT NOT NULL REFERENCES portal_native_staff_bindings(binding_id),
  source_id TEXT NOT NULL REFERENCES pa_portal_source_authorities(source_id),
  authorization_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','active','suspended','revoked')),
  publication_deadline TEXT NOT NULL CHECK(datetime(publication_deadline) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX idx_portal_native_staff_grants_binding ON portal_native_staff_grants(binding_id,created_at DESC,grant_id DESC);
CREATE INDEX idx_portal_native_active_binding_seek ON portal_v2_folder_bindings(workspace_id,id)
  WHERE status='active' AND revoked_at IS NULL;
CREATE TABLE portal_native_staff_grant_events (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES portal_native_staff_grants(grant_id),
  authorization_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('staged','published','suspended','revoked')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(authorization_id,action)
);
CREATE TABLE portal_native_staff_write_fences (
  id TEXT PRIMARY KEY,
  write_guard INTEGER NOT NULL CONSTRAINT portal_native_staff_write_guard CHECK(write_guard=1)
);
CREATE TRIGGER portal_native_staff_binding_insert BEFORE INSERT ON portal_native_staff_bindings
WHEN EXISTS(SELECT 1 FROM portal_native_staff_bindings WHERE binding_id=NEW.binding_id OR (workspace_id=NEW.workspace_id AND r2_prefix=NEW.r2_prefix))
 OR NOT EXISTS(SELECT 1 FROM portal_v2_folder_bindings b JOIN portal_v2_workspaces w ON w.id=b.workspace_id
   JOIN pa_portal_workspace_sources m ON m.workspace_id=w.id AND m.projection_source_id=w.project_alpha_source_id
   WHERE b.id=NEW.binding_id AND b.workspace_id=NEW.workspace_id AND b.r2_prefix=NEW.r2_prefix
     AND b.owner_scope_type='project' AND b.owner_public_id=NEW.project_public_id
     AND w.project_alpha_source_id=NEW.source_id AND w.legacy_account_id IS NULL)
BEGIN SELECT RAISE(ABORT,'native-staff-binding-owner'); END;
CREATE TRIGGER portal_native_staff_binding_update BEFORE UPDATE ON portal_native_staff_bindings
BEGIN SELECT RAISE(ABORT,'native-staff-binding-immutable'); END;
CREATE TRIGGER portal_native_staff_binding_delete BEFORE DELETE ON portal_native_staff_bindings
BEGIN SELECT RAISE(ABORT,'native-staff-binding-immutable'); END;
CREATE TRIGGER portal_native_staff_folder_identity BEFORE UPDATE ON portal_v2_folder_bindings
WHEN EXISTS(SELECT 1 FROM portal_native_staff_bindings n WHERE n.binding_id=OLD.id)
 AND (OLD.id<>NEW.id OR OLD.workspace_id<>NEW.workspace_id OR OLD.owner_scope_type<>NEW.owner_scope_type
   OR OLD.owner_public_id<>NEW.owner_public_id OR OLD.r2_prefix<>NEW.r2_prefix OR OLD.source_type<>NEW.source_type)
BEGIN SELECT RAISE(ABORT,'native-staff-binding-immutable'); END;
CREATE TRIGGER portal_native_staff_folder_replace BEFORE INSERT ON portal_v2_folder_bindings
WHEN EXISTS(SELECT 1 FROM portal_native_staff_bindings n WHERE n.binding_id=NEW.id OR (n.workspace_id=NEW.workspace_id AND n.r2_prefix=NEW.r2_prefix))
BEGIN SELECT RAISE(ABORT,'native-staff-binding-immutable'); END;
CREATE TRIGGER portal_native_staff_grant_insert BEFORE INSERT ON portal_native_staff_grants
WHEN NEW.state<>'pending' OR EXISTS(SELECT 1 FROM portal_native_staff_grants WHERE grant_id=NEW.grant_id OR authorization_id=NEW.authorization_id
   OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key))
 OR NOT EXISTS(SELECT 1 FROM portal_native_staff_bindings b JOIN portal_v2_authenticated_delivery_grants g ON g.folder_binding_id=b.binding_id
   WHERE b.binding_id=NEW.binding_id AND b.source_id=NEW.source_id AND g.id=NEW.grant_id AND g.workspace_id=b.workspace_id
     AND g.audience_type='principal' AND g.created_by_staff_id=NEW.actor_id)
BEGIN SELECT RAISE(ABORT,'native-staff-grant-owner'); END;
CREATE TRIGGER portal_native_staff_grant_update BEFORE UPDATE ON portal_native_staff_grants
WHEN OLD.grant_id<>NEW.grant_id OR OLD.binding_id<>NEW.binding_id OR OLD.source_id<>NEW.source_id
 OR OLD.authorization_id<>NEW.authorization_id OR OLD.actor_id<>NEW.actor_id OR OLD.idempotency_key<>NEW.idempotency_key
 OR OLD.fingerprint<>NEW.fingerprint OR OLD.publication_deadline<>NEW.publication_deadline OR OLD.created_at<>NEW.created_at
 OR OLD.state IN ('suspended','revoked') OR (OLD.state='active' AND NEW.state NOT IN ('suspended','revoked'))
 OR (OLD.state='pending' AND NEW.state NOT IN ('active','suspended','revoked'))
BEGIN SELECT RAISE(ABORT,'native-staff-grant-immutable'); END;
CREATE TRIGGER portal_native_staff_grant_delete BEFORE DELETE ON portal_native_staff_grants
BEGIN SELECT RAISE(ABORT,'native-staff-grant-immutable'); END;
CREATE TRIGGER portal_native_staff_existing_grant_replace BEFORE INSERT ON portal_v2_authenticated_delivery_grants
WHEN EXISTS(SELECT 1 FROM portal_native_staff_grants n JOIN portal_v2_authenticated_delivery_grants g ON g.id=n.grant_id
 WHERE g.id=NEW.id OR (g.logical_grant_id=NEW.logical_grant_id AND g.grant_version=NEW.grant_version))
BEGIN SELECT RAISE(ABORT,'native-staff-grant-immutable'); END;
CREATE TRIGGER portal_native_staff_existing_grant_id BEFORE UPDATE ON portal_v2_authenticated_delivery_grants
WHEN OLD.id<>NEW.id AND EXISTS(SELECT 1 FROM portal_native_staff_grants WHERE grant_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'native-staff-grant-immutable'); END;
CREATE TRIGGER portal_native_staff_recipient_replace BEFORE INSERT ON portal_v2_authenticated_delivery_grant_recipients
WHEN EXISTS(SELECT 1 FROM portal_native_staff_grants WHERE grant_id=NEW.grant_id)
BEGIN SELECT RAISE(ABORT,'native-staff-recipient-immutable'); END;
CREATE TRIGGER portal_native_staff_event_update BEFORE UPDATE ON portal_native_staff_grant_events
BEGIN SELECT RAISE(ABORT,'native-staff-event-immutable'); END;
CREATE TRIGGER portal_native_staff_event_delete BEFORE DELETE ON portal_native_staff_grant_events
BEGIN SELECT RAISE(ABORT,'native-staff-event-immutable'); END;
CREATE TRIGGER portal_native_staff_event_replace BEFORE INSERT ON portal_native_staff_grant_events
WHEN EXISTS(SELECT 1 FROM portal_native_staff_grant_events WHERE id=NEW.id OR (authorization_id=NEW.authorization_id AND action=NEW.action))
BEGIN SELECT RAISE(ABORT,'native-staff-event-immutable'); END;
