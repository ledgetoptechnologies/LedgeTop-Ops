PRAGMA foreign_keys = ON;

-- A handoff credential is discloseable at most once. This is separate from the
-- append-only audit so older audit history remains valid without assuming it
-- was unique before this policy existed.
CREATE TABLE client_onboarding_reveal_consumptions (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES client_onboarding_handoffs(command_id) ON DELETE RESTRICT,
  reveal_id TEXT NOT NULL UNIQUE CHECK(length(reveal_id)=36 AND length(replace(reveal_id,'-',''))=32
    AND reveal_id=lower(reveal_id) AND reveal_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(reveal_id,9,1)='-' AND substr(reveal_id,14,1)='-'
    AND substr(reveal_id,15,1)='4' AND substr(reveal_id,19,1)='-'
    AND substr(reveal_id,20,1) IN ('8','9','a','b') AND substr(reveal_id,24,1)='-'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191
    AND instr(actor_access_subject,char(0))=0),
  auth_verified_until TEXT NOT NULL CHECK(length(auth_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',auth_verified_until) IS auth_verified_until),
  consumed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(consumed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',consumed_at) IS consumed_at)
);

CREATE TRIGGER client_onboarding_reveal_consumptions_insert_guard BEFORE INSERT ON client_onboarding_reveal_consumptions
WHEN EXISTS(SELECT 1 FROM client_onboarding_reveal_consumptions prior WHERE prior.command_id=NEW.command_id)
  OR NEW.auth_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NOT EXISTS(SELECT 1 FROM client_onboarding_handoffs handoff
    JOIN client_onboarding_issuance_commands command ON command.command_id=handoff.command_id
    JOIN client_onboarding_invitations invitation ON invitation.invitation_id=handoff.invitation_id
    JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
    WHERE handoff.command_id=NEW.command_id AND handoff.actor_staff_id=NEW.actor_staff_id
      AND handoff.actor_access_subject=NEW.actor_access_subject
      AND command.request_sha256=handoff.request_sha256
      AND invitation.issued_by=NEW.actor_staff_id
      AND invitation.bound_access_subject=NEW.actor_access_subject
      AND invitation.secret_sha256=handoff.secret_sha256
      AND invitation.expires_at=handoff.expires_at
      AND invitation.state='pending' AND invitation.version=1
      AND invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'client onboarding reveal denied'); END;
CREATE TRIGGER client_onboarding_reveal_consumptions_no_update BEFORE UPDATE ON client_onboarding_reveal_consumptions
BEGIN SELECT RAISE(ABORT,'client onboarding reveal consumption is immutable'); END;
CREATE TRIGGER client_onboarding_reveal_consumptions_no_delete BEFORE DELETE ON client_onboarding_reveal_consumptions
BEGIN SELECT RAISE(ABORT,'client onboarding reveal consumption is durable'); END;
