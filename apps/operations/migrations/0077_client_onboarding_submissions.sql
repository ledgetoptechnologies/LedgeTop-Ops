PRAGMA foreign_keys = ON;

-- Trusted issuance staging only. No browser or staff route inserts invitations.
CREATE TABLE client_onboarding_invitations (
  invitation_id TEXT NOT NULL PRIMARY KEY CHECK(length(invitation_id)=36 AND length(replace(invitation_id,'-',''))=32 AND invitation_id=lower(invitation_id)
    AND invitation_id NOT GLOB '*[^0-9a-f-]*' AND substr(invitation_id,9,1)='-'
    AND substr(invitation_id,14,1)='-' AND substr(invitation_id,15,1)='4'
    AND substr(invitation_id,19,1)='-' AND substr(invitation_id,20,1) IN ('8','9','a','b')
    AND substr(invitation_id,24,1)='-'),
  secret_sha256 TEXT NOT NULL CHECK(length(secret_sha256)=64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_by TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  bound_access_subject TEXT NOT NULL CHECK(length(bound_access_subject) BETWEEN 1 AND 191 AND instr(bound_access_subject,char(0))=0),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  target_client_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('pending','submitted','revoked')),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND
    ((state='pending' AND version=1) OR (state='submitted' AND version=2)
      OR (state='revoked' AND version IN (2,3)))),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(expires_at>created_at)
);
CREATE INDEX client_onboarding_invitations_issuer ON client_onboarding_invitations(issued_by,state,expires_at);
CREATE TRIGGER client_onboarding_invitations_insert_guard BEFORE INSERT ON client_onboarding_invitations
WHEN NEW.state<>'pending' OR NEW.version<>1
  OR EXISTS(SELECT 1 FROM client_onboarding_invitations prior WHERE prior.invitation_id=NEW.invitation_id)
  OR (NEW.target_client_record_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM operations_directory_records record WHERE record.record_id=NEW.target_client_record_id
      AND record.record_kind='client'))
BEGIN SELECT RAISE(ABORT,'client onboarding invitation is invalid'); END;
CREATE TRIGGER client_onboarding_invitations_update_guard BEFORE UPDATE ON client_onboarding_invitations
WHEN NEW.invitation_id IS NOT OLD.invitation_id OR NEW.secret_sha256 IS NOT OLD.secret_sha256
  OR NEW.issued_by IS NOT OLD.issued_by OR NEW.bound_access_subject IS NOT OLD.bound_access_subject
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.target_client_record_id IS NOT OLD.target_client_record_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
  OR NOT ((OLD.state='pending' AND NEW.state IN ('submitted','revoked'))
    OR (OLD.state='submitted' AND NEW.state='revoked'))
  OR (NEW.state='submitted' AND NOT EXISTS(
    SELECT 1 FROM client_onboarding_submissions s WHERE s.invitation_id=OLD.invitation_id))
BEGIN SELECT RAISE(ABORT,'client onboarding invitation transition is invalid'); END;
CREATE TRIGGER client_onboarding_invitations_no_delete BEFORE DELETE ON client_onboarding_invitations
BEGIN SELECT RAISE(ABORT,'client onboarding invitation history is durable'); END;

CREATE TABLE client_onboarding_submissions (
  invitation_id TEXT NOT NULL PRIMARY KEY REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL UNIQUE CHECK(length(submission_id)=36 AND length(replace(submission_id,'-',''))=32 AND submission_id=lower(submission_id)
    AND submission_id NOT GLOB '*[^0-9a-f-]*' AND substr(submission_id,9,1)='-'
    AND substr(submission_id,14,1)='-' AND substr(submission_id,15,1)='4'
    AND substr(submission_id,19,1)='-' AND substr(submission_id,20,1) IN ('8','9','a','b')
    AND substr(submission_id,24,1)='-'),
  fields_json TEXT NOT NULL CHECK(length(fields_json) BETWEEN 2 AND 8192
    AND json_valid(fields_json) AND json_type(fields_json)='object'),
  fields_sha256 TEXT NOT NULL CHECK(length(fields_sha256)=64 AND fields_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE TRIGGER client_onboarding_submissions_insert_guard BEFORE INSERT ON client_onboarding_submissions
WHEN EXISTS(SELECT 1 FROM client_onboarding_submissions prior
    WHERE prior.invitation_id=NEW.invitation_id OR prior.submission_id=NEW.submission_id)
  OR NOT EXISTS(SELECT 1 FROM client_onboarding_invitations invitation
  WHERE invitation.invitation_id=NEW.invitation_id AND invitation.state='pending'
    AND invitation.version=1 AND invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'client onboarding submission is unavailable'); END;
CREATE TRIGGER client_onboarding_submissions_insert_transition AFTER INSERT ON client_onboarding_submissions
BEGIN
  UPDATE client_onboarding_invitations SET state='submitted',version=version+1
    WHERE invitation_id=NEW.invitation_id AND state='pending' AND version=1;
END;
CREATE TRIGGER client_onboarding_submissions_no_update BEFORE UPDATE ON client_onboarding_submissions
BEGIN SELECT RAISE(ABORT,'client onboarding submission is immutable'); END;
CREATE TRIGGER client_onboarding_submissions_no_delete BEFORE DELETE ON client_onboarding_submissions
BEGIN SELECT RAISE(ABORT,'client onboarding submission history is durable'); END;
