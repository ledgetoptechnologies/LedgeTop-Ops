PRAGMA foreign_keys = ON;

-- The binding and disclosure are durable evidence; this separate receipt makes
-- the issuing operation itself exactly-once and auditable.  It deliberately
-- stores no bearer secret, email, or profile payload.
CREATE TABLE client_onboarding_prefill_binding_commands (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id)=36 AND length(replace(command_id,'-',''))=32
    AND command_id=lower(command_id) AND command_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(command_id,9,1)='-' AND substr(command_id,14,1)='-' AND substr(command_id,15,1)='4'
    AND substr(command_id,19,1)='-' AND substr(command_id,20,1) IN ('8','9','a','b') AND substr(command_id,24,1)='-'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  invitation_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  disclosure_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_prefill_disclosures(disclosure_id) ON DELETE RESTRICT,
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  target_client_record_version INTEGER NOT NULL CHECK(typeof(target_client_record_version)='integer' AND target_client_record_version>=1),
  source_id TEXT NOT NULL CHECK(length(trim(source_id)) BETWEEN 1 AND 128 AND instr(source_id,char(0))=0),
  client_public_id TEXT NOT NULL CHECK(length(trim(client_public_id)) BETWEEN 1 AND 512 AND instr(client_public_id,char(0))=0),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(trim(actor_access_subject)) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  actor_admission_version INTEGER NOT NULL CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(typeof(actor_profile_version)='integer' AND actor_profile_version>=1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(created_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE INDEX client_onboarding_prefill_binding_commands_target
  ON client_onboarding_prefill_binding_commands(target_client_record_id,created_at DESC);

CREATE TRIGGER client_onboarding_prefill_binding_commands_insert_guard
BEFORE INSERT ON client_onboarding_prefill_binding_commands
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_prefill_disclosures disclosure
  JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=disclosure.recipient_binding_id
  JOIN client_onboarding_invitations invitation ON invitation.invitation_id=disclosure.invitation_id
  JOIN native_staff_admissions admission ON admission.staff_id=NEW.actor_staff_id
    AND admission.bound_access_subject=NEW.actor_access_subject AND admission.active=1
    AND admission.version=NEW.actor_admission_version
  JOIN native_staff_profiles profile ON profile.staff_id=NEW.actor_staff_id
    AND profile.version=NEW.actor_profile_version
  WHERE disclosure.disclosure_id=NEW.disclosure_id AND disclosure.invitation_id=NEW.invitation_id
    AND disclosure.target_client_record_id=NEW.target_client_record_id
    AND disclosure.target_client_record_version=NEW.target_client_record_version
    AND disclosure.authorized_by_staff_id=NEW.actor_staff_id
    AND disclosure.authorized_access_subject=NEW.actor_access_subject
    AND disclosure.authorized_admission_version=NEW.actor_admission_version
    AND disclosure.authorized_profile_version=NEW.actor_profile_version
    AND binding.binding_id=NEW.binding_id AND binding.target_client_record_id=NEW.target_client_record_id
    AND invitation.target_client_record_id=NEW.target_client_record_id)
BEGIN SELECT RAISE(ABORT,'client onboarding prefill binding command requires exact immutable evidence'); END;

CREATE TRIGGER client_onboarding_prefill_binding_commands_no_update BEFORE UPDATE ON client_onboarding_prefill_binding_commands
BEGIN SELECT RAISE(ABORT,'client onboarding prefill binding command is immutable'); END;
CREATE TRIGGER client_onboarding_prefill_binding_commands_no_delete BEFORE DELETE ON client_onboarding_prefill_binding_commands
BEGIN SELECT RAISE(ABORT,'client onboarding prefill binding command is durable'); END;
