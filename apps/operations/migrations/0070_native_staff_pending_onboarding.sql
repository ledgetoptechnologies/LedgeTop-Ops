PRAGMA foreign_keys = ON;

CREATE TABLE native_staff_pending_onboarding (
  onboarding_id TEXT NOT NULL PRIMARY KEY CHECK(length(onboarding_id) BETWEEN 1 AND 191 AND instr(onboarding_id,char(0))=0),
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  proposed_staff_id TEXT NOT NULL CHECK(length(proposed_staff_id) BETWEEN 1 AND 191 AND instr(proposed_staff_id,char(0))=0),
  login_email TEXT NOT NULL CHECK(length(login_email) BETWEEN 3 AND 254 AND login_email=lower(login_email) COLLATE BINARY AND login_email=trim(login_email) AND instr(login_email,'@')>1 AND instr(login_email,char(0))=0),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160 AND display_name=trim(display_name) AND instr(display_name,char(0))=0),
  invitation_secret_sha256 TEXT NOT NULL CHECK(length(invitation_secret_sha256)=64 AND invitation_secret_sha256 NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','approved','cancelled','expired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  proposal_json TEXT NOT NULL CHECK(length(proposal_json) BETWEEN 2 AND 8192 AND json_valid(proposal_json) AND json_type(proposal_json)='object'),
  proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64 AND proposal_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_by_subject TEXT NOT NULL CHECK(length(created_by_subject) BETWEEN 1 AND 191 AND instr(created_by_subject,char(0))=0),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason) AND instr(reason,char(0))=0),
  claimed_access_subject TEXT CHECK(length(claimed_access_subject) BETWEEN 1 AND 191 AND instr(claimed_access_subject,char(0))=0),
  claimed_at TEXT CHECK(claimed_at IS NULL OR (length(claimed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at) IS claimed_at)),
  claim_evidence_sha256 TEXT CHECK(length(claim_evidence_sha256)=64 AND claim_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  terminal_by_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  terminal_at TEXT CHECK(terminal_at IS NULL OR (length(terminal_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',terminal_at) IS terminal_at)),
  approval_command_id TEXT REFERENCES native_staff_management_commands(command_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  CHECK(expires_at>created_at),
  CHECK(claimed_at IS NULL OR (claimed_at>=created_at AND claimed_at<expires_at)),
  CHECK(terminal_at IS NULL OR terminal_at>=coalesce(claimed_at,created_at)),
  CHECK(state<>'expired' OR terminal_at>=expires_at),
  CHECK(state<>'approved' OR terminal_at<expires_at),
  CHECK(
    (state='pending' AND version=1 AND claimed_access_subject IS NULL AND claimed_at IS NULL AND claim_evidence_sha256 IS NULL AND terminal_by_staff_id IS NULL AND terminal_at IS NULL AND approval_command_id IS NULL)
    OR (state='claimed' AND claimed_access_subject IS NOT NULL AND claimed_at IS NOT NULL AND claim_evidence_sha256 IS NOT NULL AND terminal_by_staff_id IS NULL AND terminal_at IS NULL AND approval_command_id IS NULL)
    OR (state='approved' AND claimed_access_subject IS NOT NULL AND claimed_at IS NOT NULL AND claim_evidence_sha256 IS NOT NULL AND terminal_by_staff_id IS NOT NULL AND terminal_at IS NOT NULL AND approval_command_id IS NOT NULL)
    OR (state='cancelled' AND terminal_by_staff_id IS NOT NULL AND terminal_at IS NOT NULL AND approval_command_id IS NULL
      AND ((claimed_access_subject IS NULL AND claimed_at IS NULL AND claim_evidence_sha256 IS NULL) OR (claimed_access_subject IS NOT NULL AND claimed_at IS NOT NULL AND claim_evidence_sha256 IS NOT NULL)))
    OR (state='expired' AND terminal_at IS NOT NULL AND approval_command_id IS NULL
      AND ((claimed_access_subject IS NULL AND claimed_at IS NULL AND claim_evidence_sha256 IS NULL) OR (claimed_access_subject IS NOT NULL AND claimed_at IS NOT NULL AND claim_evidence_sha256 IS NOT NULL)))
  )
);

CREATE UNIQUE INDEX native_staff_pending_onboarding_open_staff
  ON native_staff_pending_onboarding(proposed_staff_id) WHERE state IN ('pending','claimed');
CREATE UNIQUE INDEX native_staff_pending_onboarding_open_email
  ON native_staff_pending_onboarding(login_email) WHERE state IN ('pending','claimed');
CREATE UNIQUE INDEX native_staff_pending_onboarding_open_subject
  ON native_staff_pending_onboarding(claimed_access_subject) WHERE state='claimed';

CREATE TRIGGER native_staff_pending_onboarding_insert_guard BEFORE INSERT ON native_staff_pending_onboarding
WHEN NEW.state<>'pending' OR NEW.version<>1
  OR EXISTS(SELECT 1 FROM native_staff_pending_onboarding row WHERE row.onboarding_id=NEW.onboarding_id)
  OR EXISTS(SELECT 1 FROM native_staff_pending_onboarding row WHERE row.state IN ('pending','claimed') AND (row.proposed_staff_id=NEW.proposed_staff_id OR row.login_email=NEW.login_email))
  OR EXISTS(SELECT 1 FROM staff_users row WHERE row.id=NEW.proposed_staff_id OR lower(row.email)=NEW.login_email)
  OR EXISTS(SELECT 1 FROM native_staff_profiles row WHERE row.staff_id=NEW.proposed_staff_id OR row.login_email=NEW.login_email)
  OR EXISTS(SELECT 1 FROM native_staff_admissions row WHERE row.staff_id=NEW.proposed_staff_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions creator JOIN native_staff_profiles profile ON profile.staff_id=creator.staff_id
    WHERE creator.staff_id=NEW.created_by_staff_id AND creator.active=1 AND creator.bound_access_subject=NEW.created_by_subject)
BEGIN SELECT RAISE(ABORT,'native staff pending onboarding insertion is invalid'); END;

CREATE TRIGGER native_staff_pending_onboarding_update_guard BEFORE UPDATE ON native_staff_pending_onboarding
WHEN NEW.onboarding_id IS NOT OLD.onboarding_id OR NEW.contract_version IS NOT OLD.contract_version
  OR NEW.proposed_staff_id IS NOT OLD.proposed_staff_id OR NEW.login_email IS NOT OLD.login_email
  OR NEW.display_name IS NOT OLD.display_name OR NEW.invitation_secret_sha256 IS NOT OLD.invitation_secret_sha256
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.proposal_json IS NOT OLD.proposal_json
  OR NEW.proposal_sha256 IS NOT OLD.proposal_sha256 OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id
  OR NEW.created_by_subject IS NOT OLD.created_by_subject OR NEW.reason IS NOT OLD.reason
  OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
  OR OLD.state IN ('approved','cancelled','expired')
  OR (OLD.state='pending' AND NEW.state NOT IN ('claimed','cancelled','expired'))
  OR (OLD.state='pending' AND NEW.state<>'claimed' AND (NEW.claimed_access_subject IS NOT NULL OR NEW.claimed_at IS NOT NULL OR NEW.claim_evidence_sha256 IS NOT NULL))
  OR (OLD.state='claimed' AND NEW.state NOT IN ('approved','cancelled','expired'))
  OR (OLD.state='claimed' AND (NEW.claimed_access_subject IS NOT OLD.claimed_access_subject OR NEW.claimed_at IS NOT OLD.claimed_at OR NEW.claim_evidence_sha256 IS NOT OLD.claim_evidence_sha256))
BEGIN SELECT RAISE(ABORT,'native staff pending onboarding transition is invalid'); END;

CREATE TRIGGER native_staff_pending_onboarding_claim_guard BEFORE UPDATE ON native_staff_pending_onboarding
WHEN NEW.state='claimed' AND OLD.state='pending' AND (
  EXISTS(SELECT 1 FROM staff_users row WHERE row.id=NEW.proposed_staff_id OR lower(row.email)=NEW.login_email)
  OR EXISTS(SELECT 1 FROM native_staff_profiles row WHERE row.staff_id=NEW.proposed_staff_id OR row.login_email=NEW.login_email)
  OR EXISTS(SELECT 1 FROM native_staff_admissions row WHERE row.staff_id=NEW.proposed_staff_id OR row.bound_access_subject=NEW.claimed_access_subject)
  OR EXISTS(SELECT 1 FROM native_staff_pending_onboarding row WHERE row.onboarding_id<>NEW.onboarding_id AND row.state='claimed' AND row.claimed_access_subject=NEW.claimed_access_subject)
)
BEGIN SELECT RAISE(ABORT,'native staff pending onboarding claim collides with identity'); END;

CREATE TRIGGER native_staff_pending_onboarding_approval_guard BEFORE UPDATE ON native_staff_pending_onboarding
WHEN NEW.state='approved' AND NOT EXISTS(
  SELECT 1 FROM native_staff_management_commands command
  JOIN staff_users bridge ON bridge.id=NEW.proposed_staff_id AND lower(bridge.email)=NEW.login_email
    AND bridge.provisioning_source='local' AND bridge.sync_protected=1
  JOIN native_staff_admissions admission ON admission.staff_id=bridge.id AND admission.active=1
    AND admission.bound_access_subject=NEW.claimed_access_subject
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    AND profile.login_email=NEW.login_email AND profile.display_name=NEW.display_name
  WHERE command.command_id=NEW.approval_command_id AND command.contract_version=1
    AND command.capability='staff.onboarding.approve' AND command.target_staff_id=NEW.proposed_staff_id
    AND command.actor_staff_id=NEW.terminal_by_staff_id
)
BEGIN SELECT RAISE(ABORT,'native staff pending onboarding approval is unavailable'); END;

CREATE TRIGGER native_staff_pending_onboarding_no_delete BEFORE DELETE ON native_staff_pending_onboarding
BEGIN SELECT RAISE(ABORT,'native staff pending onboarding history is durable'); END;
