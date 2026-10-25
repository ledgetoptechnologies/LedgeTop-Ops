-- Viewer delivery authority is independent of PA business projects and files.
CREATE TABLE viewer_direct_client_grants (
 id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 viewer_project_id TEXT NOT NULL, task_id TEXT, scope_type TEXT NOT NULL CHECK(scope_type IN ('project','task')),
 include_future_published INTEGER NOT NULL CHECK(include_future_published IN (0,1)),
 can_measure INTEGER NOT NULL CHECK(can_measure IN (0,1)),
 can_view_cameras INTEGER NOT NULL CHECK(can_view_cameras IN (0,1)),
 can_download INTEGER NOT NULL CHECK(can_download IN (0,1)),
 authorization_expires_at TEXT, grant_version INTEGER NOT NULL DEFAULT 1 CHECK(grant_version>=1),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 created_by_staff_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 revoked_at TEXT, revoked_by_staff_id TEXT, revoke_reason TEXT,
 CHECK((scope_type='project' AND task_id IS NULL AND include_future_published=1)
    OR (scope_type='task' AND task_id IS NOT NULL AND include_future_published=0)),
 CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL)),
 FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX viewer_direct_client_grants_live ON viewer_direct_client_grants
 (source_id,workspace_id,viewer_project_id,scope_type,COALESCE(task_id,'')) WHERE status='active';
CREATE INDEX viewer_direct_client_grants_recipient ON viewer_direct_client_grants(source_id,workspace_id,status);
CREATE TRIGGER viewer_direct_client_grant_recipient BEFORE INSERT ON viewer_direct_client_grants BEGIN
 SELECT RAISE(ABORT,'direct-viewer-recipient-invalid') WHERE NOT EXISTS(SELECT 1 FROM portal_v2_workspaces w WHERE w.id=NEW.workspace_id
  AND w.project_alpha_source_id=NEW.source_id AND w.status='active' AND w.legacy_account_id IS NULL);
END;
CREATE TRIGGER viewer_direct_client_grant_immutable BEFORE UPDATE ON viewer_direct_client_grants BEGIN
 SELECT RAISE(ABORT,'direct-viewer-grant-immutable') WHERE OLD.id IS NOT NEW.id OR OLD.source_id<>NEW.source_id OR OLD.workspace_id<>NEW.workspace_id
 OR OLD.viewer_project_id<>NEW.viewer_project_id OR OLD.task_id IS NOT NEW.task_id
 OR OLD.scope_type<>NEW.scope_type OR OLD.include_future_published<>NEW.include_future_published
 OR OLD.grant_version<>NEW.grant_version OR OLD.can_measure<>NEW.can_measure
 OR OLD.can_view_cameras<>NEW.can_view_cameras OR OLD.can_download<>NEW.can_download
 OR OLD.authorization_expires_at IS NOT NEW.authorization_expires_at
 OR OLD.created_by_staff_id<>NEW.created_by_staff_id OR OLD.created_at<>NEW.created_at
 OR OLD.status='revoked';
END;
CREATE TABLE viewer_direct_client_grant_mutation_receipts (
 actor_staff_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, action TEXT NOT NULL,
 request_fingerprint TEXT NOT NULL, grant_id TEXT NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)),
 created_at TEXT NOT NULL, PRIMARY KEY(actor_staff_id,idempotency_key),
 FOREIGN KEY(grant_id) REFERENCES viewer_direct_client_grants(id) ON DELETE RESTRICT
);
CREATE TABLE viewer_direct_client_grant_audit (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, action TEXT NOT NULL, actor_staff_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(grant_id) REFERENCES viewer_direct_client_grants(id) ON DELETE RESTRICT
);
-- A failed remote tombstone remains durable and is retried by repeated revocation.
CREATE TABLE viewer_direct_client_grant_revocations (
 grant_id TEXT NOT NULL, grant_version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
 PRIMARY KEY(grant_id,grant_version), FOREIGN KEY(grant_id) REFERENCES viewer_direct_client_grants(id) ON DELETE RESTRICT
);
