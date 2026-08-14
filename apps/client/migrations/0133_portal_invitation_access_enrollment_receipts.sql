PRAGMA foreign_keys = ON;

-- Existing queued mail remains deliberately ineligible. Only invitations
-- created after this migration carry a recipient hash that can match a
-- server-confirmed Access enrollment receipt.
ALTER TABLE portal_v2_invitation_email_outbox
  ADD COLUMN recipient_email_hash TEXT
  CHECK (recipient_email_hash IS NULL OR length(recipient_email_hash)=43);

CREATE TABLE portal_v2_invitation_access_enrollment_receipts (
  invitation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  invited_email_hash TEXT NOT NULL CHECK (length(invited_email_hash)=43),
  invitation_token_hash TEXT NOT NULL CHECK (length(invitation_token_hash)=43),
  enrollment_version INTEGER NOT NULL CHECK (enrollment_version>=1),
  provider_receipt_hash TEXT NOT NULL CHECK (length(provider_receipt_hash)=43),
  enrolled_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invitation_id,workspace_id)
    REFERENCES portal_v2_invitations(id,workspace_id) ON DELETE CASCADE
);

CREATE INDEX idx_portal_v2_invitation_access_receipt_active
  ON portal_v2_invitation_access_enrollment_receipts(
    invitation_id,workspace_id,invited_email_hash,invitation_token_hash,expires_at
  ) WHERE revoked_at IS NULL;

CREATE TRIGGER portal_v2_invitation_revoke_access_receipt
AFTER UPDATE OF status,revoked_at ON portal_v2_invitations
WHEN NEW.status IN ('accepted','revoked','expired') OR NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE portal_v2_invitation_access_enrollment_receipts
  SET revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
  WHERE invitation_id=NEW.id;
END;
