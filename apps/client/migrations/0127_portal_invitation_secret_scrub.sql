PRAGMA foreign_keys = ON;

-- The email outbox temporarily carries the one-time invitation token because
-- the authorization table stores only its hash. Terminal invitation state is
-- authoritative: scrub the plaintext in the same D1 transaction and revoke
-- any pending/leased delivery. A message already acknowledged as sent keeps
-- its delivery status, but its payload is still redacted.
UPDATE portal_v2_invitation_email_outbox
SET payload_json='{"redacted":true}',
    status=CASE WHEN status='sent' THEN 'sent' ELSE 'cancelled' END,
    lease_expires_at=NULL,
    last_error_code=NULL,
    updated_at=datetime('now')
WHERE EXISTS (
  SELECT 1 FROM portal_v2_invitations invitation
  WHERE invitation.id=invitation_id
    AND (invitation.status IN ('accepted','revoked','expired') OR invitation.revoked_at IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS portal_v2_invitation_scrub_terminal
AFTER UPDATE OF status,revoked_at ON portal_v2_invitations
WHEN NEW.status IN ('accepted','revoked','expired') OR NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE portal_v2_invitation_email_outbox
  SET payload_json='{"redacted":true}',
      status=CASE WHEN status='sent' THEN 'sent' ELSE 'cancelled' END,
      lease_expires_at=NULL,
      last_error_code=NULL,
      updated_at=datetime('now')
  WHERE invitation_id=NEW.id;
END;
