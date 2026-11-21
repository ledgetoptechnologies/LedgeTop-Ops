-- Add the client onboarding invitation mail outbox and staff reveal fences.
-- Requires 0247_client_onboarding_destination_target_proofs.sql before this migration.
CREATE TABLE client_onboarding_invite_mail_outbox (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES client_onboarding_issuance_commands(command_id) ON DELETE RESTRICT,
  invitation_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  recipient_fingerprint_key_id TEXT NOT NULL CHECK(length(recipient_fingerprint_key_id) BETWEEN 1 AND 64 AND recipient_fingerprint_key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  recipient_fingerprint TEXT NOT NULL CHECK(length(recipient_fingerprint)=64 AND recipient_fingerprint NOT GLOB '*[^0-9a-f]*'),
  key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 64 AND key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  nonce_hex TEXT NOT NULL CHECK(length(nonce_hex)=24 AND nonce_hex NOT GLOB '*[^0-9a-f]*'),
  ciphertext_hex TEXT NOT NULL CHECK(length(ciphertext_hex) BETWEEN 32 AND 2048 AND length(ciphertext_hex)%2=0 AND ciphertext_hex NOT GLOB '*[^0-9a-f]*'),
  aad_sha256 TEXT NOT NULL CHECK(length(aad_sha256)=64 AND aad_sha256 NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','attempted','sent','failed','unknown','suppressed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version>=1),
  lease_token TEXT CHECK(lease_token IS NULL OR (length(lease_token)=36 AND lease_token=lower(lease_token) AND lease_token NOT GLOB '*[^0-9a-f-]*')),
  lease_until TEXT CHECK(lease_until IS NULL OR (length(lease_until)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_until) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_until)=lease_until)),
  attempted_at TEXT CHECK(attempted_at IS NULL OR (length(attempted_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',attempted_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',attempted_at)=attempted_at)),
  attempt_id TEXT UNIQUE CHECK(attempt_id IS NULL OR (length(attempt_id)=36 AND attempt_id=lower(attempt_id) AND attempt_id NOT GLOB '*[^0-9a-f-]*')),
  CHECK((state='claimed' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
        (state<>'claimed' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK((state IN ('pending','claimed','suppressed') AND attempt_id IS NULL AND attempted_at IS NULL) OR
        (state IN ('attempted','sent','failed','unknown') AND attempt_id IS NOT NULL AND attempted_at IS NOT NULL))
);

CREATE TRIGGER client_onboarding_invite_mail_insert_guard
BEFORE INSERT ON client_onboarding_invite_mail_outbox
WHEN NEW.state<>'pending' OR NEW.version<>1 OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
  OR NEW.attempted_at IS NOT NULL OR NEW.attempt_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM client_onboarding_reveal_consumptions consumed WHERE consumed.command_id=NEW.command_id)
  OR EXISTS(SELECT 1 FROM client_onboarding_reveal_audit audit WHERE audit.command_id=NEW.command_id)
  OR NOT EXISTS (
    SELECT 1 FROM client_onboarding_issuance_commands command
    JOIN client_onboarding_invitations invitation ON invitation.invitation_id=command.invitation_id
    JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
    JOIN client_onboarding_handoffs handoff ON handoff.command_id=command.command_id
      AND handoff.invitation_id=invitation.invitation_id AND handoff.request_sha256=command.request_sha256
      AND handoff.actor_staff_id=invitation.issued_by AND handoff.actor_access_subject=invitation.bound_access_subject
    WHERE command.command_id=NEW.command_id AND command.invitation_id=NEW.invitation_id
      AND command.request_sha256=NEW.request_sha256 AND command.target_intent_json IS NULL
      AND invitation.target_client_record_id IS NULL AND invitation.state='pending'
      AND invitation.expires_at=NEW.expires_at
  )
BEGIN SELECT RAISE(ABORT,'invalid onboarding mail intent'); END;

CREATE TRIGGER client_onboarding_invite_mail_immutable
BEFORE UPDATE ON client_onboarding_invite_mail_outbox
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.invitation_id IS NOT OLD.invitation_id
  OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.recipient_fingerprint_key_id IS NOT OLD.recipient_fingerprint_key_id
  OR NEW.recipient_fingerprint IS NOT OLD.recipient_fingerprint
  OR NEW.key_id IS NOT OLD.key_id OR NEW.nonce_hex IS NOT OLD.nonce_hex OR NEW.ciphertext_hex IS NOT OLD.ciphertext_hex
  OR NEW.aad_sha256 IS NOT OLD.aad_sha256 OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id)
  OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS NOT OLD.attempted_at)
BEGIN SELECT RAISE(ABORT,'onboarding mail intent is immutable'); END;

CREATE TRIGGER client_onboarding_invite_mail_transition
BEFORE UPDATE ON client_onboarding_invite_mail_outbox
WHEN NEW.version<>OLD.version+1 OR NOT (
  (OLD.state='pending' AND NEW.state IN ('claimed','suppressed')) OR
  (OLD.state='claimed' AND NEW.state='pending' AND OLD.attempted_at IS NULL
    AND OLD.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) OR
  (OLD.state='claimed' AND NEW.state='suppressed') OR
  (OLD.state='claimed' AND NEW.state='attempted' AND OLD.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND EXISTS (SELECT 1 FROM client_onboarding_invitations invitation
      JOIN client_onboarding_issuance_commands command ON command.invitation_id=invitation.invitation_id
      JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
      JOIN client_onboarding_handoffs handoff ON handoff.command_id=command.command_id
        AND handoff.invitation_id=invitation.invitation_id AND handoff.request_sha256=command.request_sha256
      AND handoff.actor_staff_id=invitation.issued_by AND handoff.actor_access_subject=invitation.bound_access_subject
      WHERE invitation.invitation_id=OLD.invitation_id AND command.command_id=OLD.command_id
        AND command.request_sha256=OLD.request_sha256 AND command.target_intent_json IS NULL
        AND invitation.target_client_record_id IS NULL AND invitation.state='pending'
        AND invitation.expires_at=OLD.expires_at)) OR
  (OLD.state='attempted' AND NEW.state IN ('sent','failed','unknown'))
)
BEGIN SELECT RAISE(ABORT,'invalid onboarding mail transition'); END;

CREATE TRIGGER client_onboarding_invite_mail_no_delete
BEFORE DELETE ON client_onboarding_invite_mail_outbox
BEGIN SELECT RAISE(ABORT,'onboarding mail intent is durable'); END;

-- Protect the existing reveal-consumption write even from an older issuer.
-- A mail intent and the handoff must be inserted atomically in the same batch;
-- absence of this provisional trigger must keep email mode disabled.
CREATE TRIGGER client_onboarding_invite_mail_no_staff_reveal
BEFORE INSERT ON client_onboarding_reveal_consumptions
WHEN EXISTS(SELECT 1 FROM client_onboarding_invite_mail_outbox mail WHERE mail.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'mail-mode invitation cannot be revealed'); END;

CREATE TRIGGER client_onboarding_invite_mail_no_staff_reveal_audit
BEFORE INSERT ON client_onboarding_reveal_audit
WHEN EXISTS(SELECT 1 FROM client_onboarding_invite_mail_outbox mail WHERE mail.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'mail-mode invitation cannot be revealed'); END;
