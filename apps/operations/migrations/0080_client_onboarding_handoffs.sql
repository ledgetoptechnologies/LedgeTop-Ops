PRAGMA foreign_keys = ON;

-- Encrypted recovery for server-generated client invitation credentials. The
-- handoff and 0077/0078 issuance must be written in one D1 batch by the wrapper.
CREATE TABLE client_onboarding_handoffs (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES client_onboarding_issuance_commands(command_id) ON DELETE RESTRICT,
  invitation_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191
    AND instr(actor_access_subject,char(0))=0),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  secret_sha256 TEXT NOT NULL CHECK(length(secret_sha256)=64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 64 AND key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  nonce_hex TEXT NOT NULL CHECK(length(nonce_hex)=24 AND nonce_hex NOT GLOB '*[^0-9a-f]*'),
  ciphertext_hex TEXT NOT NULL CHECK(length(ciphertext_hex)=160 AND ciphertext_hex NOT GLOB '*[^0-9a-f]*'),
  aad_sha256 TEXT NOT NULL CHECK(length(aad_sha256)=64 AND aad_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)
);
CREATE TRIGGER client_onboarding_handoffs_insert_guard BEFORE INSERT ON client_onboarding_handoffs
WHEN EXISTS(SELECT 1 FROM client_onboarding_handoffs prior
    WHERE prior.command_id=NEW.command_id OR prior.invitation_id=NEW.invitation_id)
  OR NOT EXISTS(SELECT 1 FROM client_onboarding_issuance_commands command
    JOIN client_onboarding_invitations invitation ON invitation.invitation_id=command.invitation_id
    JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
    WHERE command.command_id=NEW.command_id AND command.invitation_id=NEW.invitation_id
      AND invitation.invitation_id=NEW.invitation_id AND invitation.issued_by=NEW.actor_staff_id
      AND invitation.bound_access_subject=NEW.actor_access_subject
      AND command.request_sha256=NEW.request_sha256 AND invitation.secret_sha256=NEW.secret_sha256
      AND invitation.expires_at=NEW.expires_at AND invitation.state='pending' AND invitation.version=1)
BEGIN SELECT RAISE(ABORT,'client onboarding handoff denied'); END;
CREATE TRIGGER client_onboarding_handoffs_no_update BEFORE UPDATE ON client_onboarding_handoffs
BEGIN SELECT RAISE(ABORT,'client onboarding handoff is immutable'); END;
CREATE TRIGGER client_onboarding_handoffs_no_delete BEFORE DELETE ON client_onboarding_handoffs
BEGIN SELECT RAISE(ABORT,'client onboarding handoff is durable'); END;

CREATE TABLE client_onboarding_reveal_audit (
  reveal_id TEXT NOT NULL PRIMARY KEY CHECK(length(reveal_id)=36 AND length(replace(reveal_id,'-',''))=32
    AND reveal_id=lower(reveal_id) AND reveal_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(reveal_id,9,1)='-' AND substr(reveal_id,14,1)='-'
    AND substr(reveal_id,15,1)='4' AND substr(reveal_id,19,1)='-'
    AND substr(reveal_id,20,1) IN ('8','9','a','b') AND substr(reveal_id,24,1)='-'),
  command_id TEXT NOT NULL REFERENCES client_onboarding_handoffs(command_id) ON DELETE RESTRICT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191
    AND instr(actor_access_subject,char(0))=0),
  auth_verified_until TEXT NOT NULL CHECK(length(auth_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',auth_verified_until) IS auth_verified_until),
  revealed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(revealed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',revealed_at) IS revealed_at)
);
CREATE TRIGGER client_onboarding_reveal_audit_insert_guard BEFORE INSERT ON client_onboarding_reveal_audit
WHEN EXISTS(SELECT 1 FROM client_onboarding_reveal_audit prior WHERE prior.reveal_id=NEW.reveal_id)
  OR NEW.auth_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NOT EXISTS(SELECT 1 FROM client_onboarding_handoffs handoff
    JOIN client_onboarding_issuance_commands command ON command.command_id=handoff.command_id
    JOIN client_onboarding_invitations invitation ON invitation.invitation_id=handoff.invitation_id
    JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
    WHERE handoff.command_id=NEW.command_id AND handoff.actor_staff_id=NEW.actor_staff_id
      AND handoff.actor_access_subject=NEW.actor_access_subject
      AND command.command_id=handoff.command_id AND command.request_sha256=handoff.request_sha256
      AND invitation.issued_by=NEW.actor_staff_id
      AND invitation.bound_access_subject=NEW.actor_access_subject
      AND invitation.secret_sha256=handoff.secret_sha256
      AND invitation.expires_at=handoff.expires_at
      AND invitation.state='pending' AND invitation.version=1
      AND invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'client onboarding reveal denied'); END;
CREATE TRIGGER client_onboarding_reveal_audit_no_update BEFORE UPDATE ON client_onboarding_reveal_audit
BEGIN SELECT RAISE(ABORT,'client onboarding reveal audit is immutable'); END;
CREATE TRIGGER client_onboarding_reveal_audit_no_delete BEFORE DELETE ON client_onboarding_reveal_audit
BEGIN SELECT RAISE(ABORT,'client onboarding reveal audit is durable'); END;
