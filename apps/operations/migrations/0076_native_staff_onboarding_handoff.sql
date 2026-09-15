-- Encrypted, recoverable handoff for server-issued invitations. Apply as one D1 batch.
-- No raw secret is stored; this migration does not grant authority or enable a route.
CREATE TABLE native_staff_onboarding_handoffs (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES native_staff_management_commands(command_id) ON DELETE RESTRICT,
  onboarding_id TEXT NOT NULL,
  proposed_staff_id TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  secret_sha256 TEXT NOT NULL CHECK(length(secret_sha256)=64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 64 AND key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  nonce_hex TEXT NOT NULL CHECK(length(nonce_hex)=24 AND nonce_hex NOT GLOB '*[^0-9a-f]*'),
  ciphertext_hex TEXT NOT NULL CHECK(length(ciphertext_hex)=160 AND ciphertext_hex NOT GLOB '*[^0-9a-f]*'),
  aad_sha256 TEXT NOT NULL CHECK(length(aad_sha256)=64 AND aad_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  UNIQUE(onboarding_id),
  FOREIGN KEY(onboarding_id,proposed_staff_id)
    REFERENCES native_staff_pending_onboarding(onboarding_id,proposed_staff_id) ON DELETE RESTRICT
);

CREATE TRIGGER native_staff_onboarding_handoffs_insert_guard
BEFORE INSERT ON native_staff_onboarding_handoffs
WHEN EXISTS(SELECT 1 FROM native_staff_onboarding_handoffs WHERE command_id=NEW.command_id OR onboarding_id=NEW.onboarding_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_management_commands receipt
    JOIN native_staff_pending_onboarding pending ON pending.onboarding_id=NEW.onboarding_id
      AND pending.proposed_staff_id=NEW.proposed_staff_id
    WHERE receipt.command_id=NEW.command_id AND receipt.capability='staff.onboarding.create'
      AND receipt.target_kind='onboarding' AND receipt.target_onboarding_id=NEW.onboarding_id
      AND receipt.target_proposed_staff_id=NEW.proposed_staff_id
      AND receipt.actor_staff_id=NEW.actor_staff_id AND receipt.actor_access_subject=NEW.actor_access_subject
      AND receipt.request_sha256=NEW.request_sha256
      AND json_extract(receipt.result_json,'$.invitationSecretSha256')=NEW.secret_sha256
      AND json_extract(receipt.result_json,'$.expiresAt')=NEW.expires_at
      AND receipt.executed_at<=NEW.created_at
      AND pending.invitation_secret_sha256=NEW.secret_sha256
      AND pending.expires_at=NEW.expires_at AND pending.state='pending' AND pending.version=1)
BEGIN SELECT RAISE(ABORT,'invalid onboarding handoff'); END;

CREATE TRIGGER native_staff_onboarding_handoffs_no_update BEFORE UPDATE ON native_staff_onboarding_handoffs
BEGIN SELECT RAISE(ABORT,'onboarding handoff is immutable'); END;
CREATE TRIGGER native_staff_onboarding_handoffs_no_delete BEFORE DELETE ON native_staff_onboarding_handoffs
BEGIN SELECT RAISE(ABORT,'onboarding handoff is permanent'); END;

CREATE TABLE native_staff_onboarding_reveal_audit (
  reveal_id TEXT NOT NULL PRIMARY KEY CHECK(length(reveal_id) BETWEEN 1 AND 191 AND instr(reveal_id,char(0))=0),
  command_id TEXT NOT NULL REFERENCES native_staff_onboarding_handoffs(command_id) ON DELETE RESTRICT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  revealed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(revealed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',revealed_at) IS revealed_at)
);

CREATE TRIGGER native_staff_onboarding_reveal_audit_insert_guard
BEFORE INSERT ON native_staff_onboarding_reveal_audit
WHEN EXISTS(SELECT 1 FROM native_staff_onboarding_reveal_audit WHERE reveal_id=NEW.reveal_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_onboarding_handoffs handoff
    JOIN native_staff_pending_onboarding pending ON pending.onboarding_id=handoff.onboarding_id
      AND pending.proposed_staff_id=handoff.proposed_staff_id
    JOIN native_staff_management_commands receipt ON receipt.command_id=handoff.command_id
    JOIN native_staff_onboarding_create_authority authority ON authority.command_id=receipt.command_id
    JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id AND actor.active=1
      AND actor.bound_access_subject=NEW.actor_access_subject
    JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
    WHERE handoff.command_id=NEW.command_id AND handoff.actor_staff_id=NEW.actor_staff_id
      AND handoff.actor_access_subject=NEW.actor_access_subject
      AND receipt.actor_staff_id=NEW.actor_staff_id AND receipt.actor_access_subject=NEW.actor_access_subject
      AND pending.state='pending' AND pending.version=1
      AND pending.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND pending.invitation_secret_sha256=handoff.secret_sha256)
BEGIN SELECT RAISE(ABORT,'onboarding reveal denied'); END;
CREATE TRIGGER native_staff_onboarding_reveal_audit_no_update BEFORE UPDATE ON native_staff_onboarding_reveal_audit
BEGIN SELECT RAISE(ABORT,'onboarding reveal audit is immutable'); END;
CREATE TRIGGER native_staff_onboarding_reveal_audit_no_delete BEFORE DELETE ON native_staff_onboarding_reveal_audit
BEGIN SELECT RAISE(ABORT,'onboarding reveal audit is permanent'); END;
