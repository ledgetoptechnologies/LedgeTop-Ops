PRAGMA foreign_keys = ON;

-- Access enrollment callbacks can arrive out of order. Persist the highest
-- revoked version even when its positive receipt has not arrived yet so a
-- delayed callback cannot recreate authorization that was already removed.
CREATE TABLE IF NOT EXISTS portal_v2_invitation_access_enrollment_revocations (
  invitation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  revoked_through_version INTEGER NOT NULL CHECK (revoked_through_version>=1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invitation_id,workspace_id)
    REFERENCES portal_v2_invitations(id,workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_invitation_access_revocations_workspace
  ON portal_v2_invitation_access_enrollment_revocations(workspace_id,invitation_id);

-- Expired uploads have already been removed from quarantine, but they must
-- remain an explicit unresolved draft state until the client acknowledges the
-- loss by removing the row. Only clean or explicitly removed files may pass.
DROP TRIGGER IF EXISTS trg_client_request_attachment_submit_guard;

CREATE TRIGGER trg_client_request_attachment_submit_guard
BEFORE UPDATE OF state ON client_service_request_drafts
WHEN NEW.state='submitted' AND OLD.state='draft' AND EXISTS (
  SELECT 1 FROM client_service_request_attachments attachment
  WHERE attachment.draft_id=OLD.id AND attachment.status NOT IN ('accepted','aborted')
)
BEGIN
  SELECT RAISE(ABORT,'request attachments must be accepted or removed');
END;
