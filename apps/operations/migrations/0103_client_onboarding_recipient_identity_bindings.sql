PRAGMA foreign_keys = ON;

-- Dormant evidence only. A binding is an explicit, non-email assertion that
-- an Access principal is a recipient for one Operations client record. It
-- grants no invitation, profile, portal, or delivery authority by itself.
CREATE TABLE client_onboarding_recipient_identity_bindings (
  binding_id TEXT NOT NULL PRIMARY KEY CHECK(length(binding_id)=36 AND length(replace(binding_id,'-',''))=32
    AND binding_id=lower(binding_id) AND binding_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(binding_id,9,1)='-' AND substr(binding_id,14,1)='-' AND substr(binding_id,15,1)='4'
    AND substr(binding_id,19,1)='-' AND substr(binding_id,20,1) IN ('8','9','a','b') AND substr(binding_id,24,1)='-'),
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  access_issuer TEXT NOT NULL CHECK(length(trim(access_issuer)) BETWEEN 1 AND 512 AND instr(access_issuer,char(0))=0),
  access_subject TEXT NOT NULL CHECK(length(trim(access_subject)) BETWEEN 1 AND 512 AND instr(access_subject,char(0))=0),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  expires_at TEXT CHECK(expires_at IS NULL OR (length(expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at)),
  revoked_at TEXT CHECK(revoked_at IS NULL OR (length(revoked_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at)=revoked_at)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(created_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(updated_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX client_onboarding_recipient_identity_bindings_lookup
  ON client_onboarding_recipient_identity_bindings(target_client_record_id,access_issuer,access_subject,status,expires_at);
CREATE UNIQUE INDEX client_onboarding_recipient_identity_bindings_active_identity
  ON client_onboarding_recipient_identity_bindings(target_client_record_id,access_issuer,access_subject)
  WHERE status='active';

CREATE TRIGGER client_onboarding_recipient_identity_binding_insert_guard BEFORE INSERT ON client_onboarding_recipient_identity_bindings
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_records record
  WHERE record.record_id=NEW.target_client_record_id AND record.record_kind='client')
BEGIN SELECT RAISE(ABORT,'client onboarding recipient identity binding requires a client target'); END;

CREATE TRIGGER client_onboarding_recipient_identity_binding_update_guard BEFORE UPDATE ON client_onboarding_recipient_identity_bindings
WHEN NEW.binding_id IS NOT OLD.binding_id OR NEW.target_client_record_id IS NOT OLD.target_client_record_id
  OR NEW.access_issuer IS NOT OLD.access_issuer OR NEW.access_subject IS NOT OLD.access_subject
  OR NEW.created_at IS NOT OLD.created_at OR NEW.status NOT IN ('active','revoked')
  OR (OLD.status='revoked' AND NEW.status<>'revoked')
  OR (NEW.status='active' AND NEW.revoked_at IS NOT NULL)
  OR (NEW.status='revoked' AND NEW.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'client onboarding recipient identity binding is immutable except expiry or revocation'); END;
