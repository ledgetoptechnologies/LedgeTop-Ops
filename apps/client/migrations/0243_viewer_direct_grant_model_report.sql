-- Model report download on a direct client share, chosen apart from other downloads.
-- NULL is a share made before this column: it keeps what it allowed, the report with downloads.
ALTER TABLE viewer_direct_client_grants ADD COLUMN can_download_report INTEGER CHECK(can_download_report IN (0,1));

-- The choice is as fixed as every other permission on a share: a change is a new share.
DROP TRIGGER viewer_direct_client_grant_immutable;
CREATE TRIGGER viewer_direct_client_grant_immutable BEFORE UPDATE ON viewer_direct_client_grants BEGIN
 SELECT RAISE(ABORT,'direct-viewer-grant-immutable') WHERE OLD.id IS NOT NEW.id OR OLD.source_id<>NEW.source_id OR OLD.workspace_id<>NEW.workspace_id
 OR OLD.viewer_project_id<>NEW.viewer_project_id OR OLD.task_id IS NOT NEW.task_id
 OR OLD.scope_type<>NEW.scope_type OR OLD.include_future_published<>NEW.include_future_published
 OR OLD.grant_version<>NEW.grant_version OR OLD.can_measure<>NEW.can_measure
 OR OLD.can_view_cameras<>NEW.can_view_cameras OR OLD.can_download<>NEW.can_download
 OR OLD.can_download_report IS NOT NEW.can_download_report
 OR OLD.authorization_expires_at IS NOT NEW.authorization_expires_at
 OR OLD.created_by_staff_id<>NEW.created_by_staff_id OR OLD.created_at<>NEW.created_at
 OR OLD.status='revoked';
END;
