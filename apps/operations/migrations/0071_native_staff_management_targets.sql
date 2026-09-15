-- Paired, transactional target-shape upgrade. Apply the entire migration in one D1 batch.
-- No onboarding administrator commands are enabled by this storage foundation.
-- Existing receipts and pending histories are copied before the old tables are removed.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE native_staff_management_commands_next (
  target_kind TEXT NOT NULL DEFAULT 'live_staff' CHECK(target_kind IN ('live_staff','onboarding')),
  target_onboarding_id TEXT,
  target_proposed_staff_id TEXT CHECK(length(target_proposed_staff_id) BETWEEN 1 AND 191 AND instr(target_proposed_staff_id,char(0))=0),
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 191 AND instr(command_id,char(0))=0),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  contract_version INTEGER NOT NULL CHECK(typeof(contract_version)='integer' AND contract_version=1),
  authority_domain TEXT NOT NULL DEFAULT 'staff_admin' CHECK(authority_domain='staff_admin'),
  capability TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  target_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 0 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK(typeof(result_version)='integer' AND result_version=expected_version+1),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason) AND instr(reason,char(0))=0),
  display_name TEXT CHECK(length(display_name) BETWEEN 1 AND 160 AND display_name=trim(display_name) AND instr(display_name,char(0))=0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
  result_sha256 TEXT NOT NULL CHECK(length(result_sha256)=64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'),
  executed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(contract_version,authority_domain,capability)
    REFERENCES native_staff_authority_capabilities(contract_version,authority_domain,capability) ON DELETE RESTRICT,
  CHECK((target_kind='live_staff' AND target_staff_id IS NOT NULL AND target_onboarding_id IS NULL AND target_proposed_staff_id IS NULL AND expected_version>=1)
    OR (target_kind='onboarding' AND target_staff_id IS NULL AND target_onboarding_id IS NOT NULL AND target_proposed_staff_id IS NOT NULL)),
  FOREIGN KEY(target_onboarding_id,target_proposed_staff_id)
    REFERENCES native_staff_pending_onboarding_next(onboarding_id,proposed_staff_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE native_staff_pending_onboarding_next (
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
  approval_command_id TEXT REFERENCES native_staff_management_commands_next(command_id) ON DELETE RESTRICT,
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
  ),
  UNIQUE(onboarding_id,proposed_staff_id)
);

CREATE TABLE native_staff_management_fences_next (
  target_kind TEXT NOT NULL DEFAULT 'live_staff' CHECK(target_kind IN ('live_staff','onboarding')),
  target_onboarding_id TEXT,
  target_proposed_staff_id TEXT CHECK(length(target_proposed_staff_id) BETWEEN 1 AND 191 AND instr(target_proposed_staff_id,char(0))=0),
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 191 AND instr(command_id,char(0))=0),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  contract_version INTEGER NOT NULL CHECK(typeof(contract_version)='integer' AND contract_version=1),
  capability TEXT NOT NULL CHECK(length(capability) BETWEEN 1 AND 191),
  actor_staff_id TEXT NOT NULL,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  target_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 0 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK(typeof(result_version)='integer' AND result_version=expected_version+1),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason) AND instr(reason,char(0))=0),
  display_name TEXT CHECK(length(display_name) BETWEEN 1 AND 160 AND display_name=trim(display_name) AND instr(display_name,char(0))=0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
  result_sha256 TEXT NOT NULL CHECK(length(result_sha256)=64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'),
  mutation_writes INTEGER NOT NULL DEFAULT 1 CHECK(typeof(mutation_writes)='integer' AND mutation_writes IN (0,1)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((target_kind='live_staff' AND target_staff_id IS NOT NULL AND target_onboarding_id IS NULL AND target_proposed_staff_id IS NULL AND expected_version>=1)
    OR (target_kind='onboarding' AND target_staff_id IS NULL AND target_onboarding_id IS NOT NULL AND target_proposed_staff_id IS NOT NULL)),
  FOREIGN KEY(target_onboarding_id,target_proposed_staff_id)
    REFERENCES native_staff_pending_onboarding_next(onboarding_id,proposed_staff_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO native_staff_management_commands_next (command_id,request_sha256,contract_version,authority_domain,capability,actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256,executed_at) SELECT command_id,request_sha256,contract_version,authority_domain,capability,actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256,executed_at FROM native_staff_management_commands;

INSERT INTO native_staff_management_fences_next (command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256,mutation_writes,created_at) SELECT command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256,mutation_writes,created_at FROM native_staff_management_fences;

INSERT INTO native_staff_pending_onboarding_next (onboarding_id,contract_version,proposed_staff_id,login_email,display_name,invitation_secret_sha256,expires_at,state,version,proposal_json,proposal_sha256,created_by_staff_id,created_by_subject,reason,claimed_access_subject,claimed_at,claim_evidence_sha256,terminal_by_staff_id,terminal_at,approval_command_id,created_at) SELECT onboarding_id,contract_version,proposed_staff_id,login_email,display_name,invitation_secret_sha256,expires_at,state,version,proposal_json,proposal_sha256,created_by_staff_id,created_by_subject,reason,claimed_access_subject,claimed_at,claim_evidence_sha256,terminal_by_staff_id,terminal_at,approval_command_id,created_at FROM native_staff_pending_onboarding;

DROP TRIGGER native_staff_management_fences_insert_guard;
DROP TRIGGER native_staff_management_fences_update_guard;
DROP TRIGGER native_staff_management_commands_insert_guard;
DROP TRIGGER native_staff_management_commands_no_update;
DROP TRIGGER native_staff_management_commands_no_delete;
DROP TRIGGER native_staff_management_admission_disable_consume;
DROP TRIGGER native_staff_management_admission_enable_consume;
DROP TRIGGER native_staff_management_profile_edit_consume;
DROP TRIGGER native_staff_management_commands_valid;
DROP TRIGGER native_staff_management_commands_surviving_candidate;
DROP TRIGGER native_staff_management_commands_consume;
DROP TRIGGER native_staff_pending_onboarding_insert_guard;
DROP TRIGGER native_staff_pending_onboarding_update_guard;
DROP TRIGGER native_staff_pending_onboarding_claim_guard;
DROP TRIGGER native_staff_pending_onboarding_approval_guard;
DROP TRIGGER native_staff_pending_onboarding_no_delete;

DROP TABLE native_staff_pending_onboarding;
DROP TABLE native_staff_management_fences;
DROP TABLE native_staff_management_commands;
ALTER TABLE native_staff_management_commands_next RENAME TO native_staff_management_commands;
ALTER TABLE native_staff_pending_onboarding_next RENAME TO native_staff_pending_onboarding;
ALTER TABLE native_staff_management_fences_next RENAME TO native_staff_management_fences;

CREATE UNIQUE INDEX native_staff_management_fences_one_pending_mutation
  ON native_staff_management_fences(capability,target_staff_id,expected_version,result_version);

CREATE UNIQUE INDEX native_staff_pending_onboarding_open_staff
  ON native_staff_pending_onboarding(proposed_staff_id) WHERE state IN ('pending','claimed');

CREATE UNIQUE INDEX native_staff_pending_onboarding_open_email
  ON native_staff_pending_onboarding(login_email) WHERE state IN ('pending','claimed');

CREATE UNIQUE INDEX native_staff_pending_onboarding_open_subject
  ON native_staff_pending_onboarding(claimed_access_subject) WHERE state='claimed';

-- Existing lifecycle and pending-state guards are intentionally restored unchanged.
CREATE TRIGGER native_staff_management_fences_insert_guard BEFORE INSERT ON native_staff_management_fences
WHEN NEW.mutation_writes<>1
  OR EXISTS(SELECT 1 FROM native_staff_management_fences fence WHERE fence.command_id=NEW.command_id)
  OR EXISTS(SELECT 1 FROM native_staff_management_commands receipt WHERE receipt.command_id=NEW.command_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions actor JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
    WHERE actor.staff_id=NEW.actor_staff_id AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions target JOIN native_staff_profiles profile ON profile.staff_id=target.staff_id WHERE target.staff_id=NEW.target_staff_id)
  OR NOT ((NEW.capability='staff.profile.edit' AND NEW.display_name IS NOT NULL AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=NEW.target_staff_id AND version=NEW.expected_version))
    OR (NEW.capability='staff.admission.disable' AND NEW.display_name IS NULL AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.target_staff_id AND active=1 AND version=NEW.expected_version))
    OR (NEW.capability='staff.admission.enable' AND NEW.display_name IS NULL AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.target_staff_id AND active=0 AND version=NEW.expected_version)))
BEGIN SELECT RAISE(ABORT,'native staff management fence prestate is invalid'); END;

CREATE TRIGGER native_staff_management_fences_update_guard BEFORE UPDATE ON native_staff_management_fences
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.contract_version IS NOT OLD.contract_version OR NEW.capability IS NOT OLD.capability
  OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject
  OR NEW.target_staff_id IS NOT OLD.target_staff_id OR NEW.expected_version IS NOT OLD.expected_version
  OR NEW.result_version IS NOT OLD.result_version OR NEW.reason IS NOT OLD.reason
  OR NEW.display_name IS NOT OLD.display_name
  OR NEW.result_json IS NOT OLD.result_json OR NEW.result_sha256 IS NOT OLD.result_sha256
  OR NEW.created_at IS NOT OLD.created_at OR OLD.mutation_writes<>1 OR NEW.mutation_writes<>0
  OR NOT ((NEW.capability='staff.profile.edit' AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=NEW.target_staff_id AND version=NEW.result_version AND display_name=NEW.display_name))
    OR (NEW.capability='staff.admission.disable' AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.target_staff_id AND active=0 AND version=NEW.result_version))
    OR (NEW.capability='staff.admission.enable' AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.target_staff_id AND active=1 AND version=NEW.result_version)))
BEGIN SELECT RAISE(ABORT,'native staff management fence transition is invalid'); END;

CREATE TRIGGER native_staff_management_commands_insert_guard BEFORE INSERT ON native_staff_management_commands
WHEN EXISTS(SELECT 1 FROM native_staff_management_commands receipt WHERE receipt.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'native staff management command already exists'); END;

CREATE TRIGGER native_staff_management_commands_no_update BEFORE UPDATE ON native_staff_management_commands
BEGIN SELECT RAISE(ABORT,'native staff management command is immutable'); END;

CREATE TRIGGER native_staff_management_commands_no_delete BEFORE DELETE ON native_staff_management_commands
BEGIN SELECT RAISE(ABORT,'native staff management command is durable'); END;

CREATE TRIGGER native_staff_management_admission_disable_consume AFTER UPDATE ON native_staff_admissions
WHEN OLD.active=1 AND NEW.active=0 AND NEW.version=OLD.version+1
  AND NEW.bound_access_subject IS OLD.bound_access_subject AND NEW.admitted_by IS OLD.admitted_by
BEGIN
  UPDATE native_staff_management_fences SET mutation_writes=0
  WHERE capability='staff.admission.disable' AND target_staff_id=NEW.staff_id
    AND expected_version=OLD.version AND result_version=NEW.version AND mutation_writes=1;
END;

CREATE TRIGGER native_staff_management_admission_enable_consume AFTER UPDATE ON native_staff_admissions
WHEN OLD.active=0 AND NEW.active=1 AND NEW.version=OLD.version+1
  AND NEW.bound_access_subject IS OLD.bound_access_subject AND NEW.admitted_by IS OLD.admitted_by
BEGIN UPDATE native_staff_management_fences SET mutation_writes=0 WHERE capability='staff.admission.enable' AND target_staff_id=NEW.staff_id AND expected_version=OLD.version AND result_version=NEW.version AND mutation_writes=1; END;

CREATE TRIGGER native_staff_management_profile_edit_consume AFTER UPDATE ON native_staff_profiles
WHEN NEW.version=OLD.version+1
  AND NEW.login_email IS OLD.login_email
BEGIN UPDATE native_staff_management_fences SET mutation_writes=0 WHERE capability='staff.profile.edit' AND target_staff_id=NEW.staff_id AND expected_version=OLD.version AND result_version=NEW.version AND display_name=NEW.display_name AND mutation_writes=1; END;

CREATE TRIGGER native_staff_management_commands_valid BEFORE INSERT ON native_staff_management_commands
WHEN NOT EXISTS (
  SELECT 1 FROM native_staff_management_fences fence
  WHERE fence.command_id=NEW.command_id AND fence.request_sha256=NEW.request_sha256
    AND fence.contract_version=NEW.contract_version AND fence.capability=NEW.capability
    AND fence.actor_staff_id=NEW.actor_staff_id AND fence.actor_access_subject=NEW.actor_access_subject
    AND fence.target_staff_id=NEW.target_staff_id AND fence.expected_version=NEW.expected_version
    AND fence.result_version=NEW.result_version AND fence.reason=NEW.reason
    AND fence.display_name IS NEW.display_name
    AND fence.result_json=NEW.result_json AND fence.result_sha256=NEW.result_sha256 AND fence.mutation_writes=0
    AND (SELECT count(*) FROM json_each(NEW.result_json))=CASE NEW.capability WHEN 'staff.profile.edit' THEN 5 ELSE 4 END
    AND json_type(NEW.result_json,'$.contractVersion')='integer' AND json_extract(NEW.result_json,'$.contractVersion')=1
    AND json_type(NEW.result_json,'$.capability')='text' AND json_extract(NEW.result_json,'$.capability')=NEW.capability
    AND json_type(NEW.result_json,'$.targetStaffId')='text' AND json_extract(NEW.result_json,'$.targetStaffId')=NEW.target_staff_id
    AND json_type(NEW.result_json,'$.resultVersion')='integer' AND json_extract(NEW.result_json,'$.resultVersion')=NEW.result_version
    AND ((NEW.capability='staff.profile.edit' AND json_type(NEW.result_json,'$.displayName')='text' AND json_extract(NEW.result_json,'$.displayName')=NEW.display_name)
      OR (NEW.capability IN ('staff.admission.enable','staff.admission.disable') AND NEW.display_name IS NULL AND json_type(NEW.result_json,'$.displayName') IS NULL))
    AND EXISTS(SELECT 1 FROM native_staff_admissions actor JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
      WHERE actor.staff_id=NEW.actor_staff_id AND actor.bound_access_subject=NEW.actor_access_subject
        AND (actor.active=1 OR (NEW.capability='staff.admission.disable' AND actor.staff_id=NEW.target_staff_id AND actor.active=0 AND actor.version=NEW.result_version)))
    AND EXISTS(SELECT 1 FROM native_staff_admissions target JOIN native_staff_profiles profile ON profile.staff_id=target.staff_id
      WHERE target.staff_id=NEW.target_staff_id AND ((NEW.capability='staff.profile.edit' AND EXISTS(SELECT 1 FROM native_staff_profiles p2 WHERE p2.staff_id=target.staff_id AND p2.version=NEW.result_version AND p2.display_name=NEW.display_name))
        OR (NEW.capability='staff.admission.disable' AND target.active=0 AND target.version=NEW.result_version)
        OR (NEW.capability='staff.admission.enable' AND target.active=1 AND target.version=NEW.result_version)))
    AND EXISTS(
      SELECT 1 FROM native_staff_management_delegations allow_row
      WHERE allow_row.actor_staff_id=NEW.actor_staff_id AND allow_row.contract_version=1
        AND allow_row.capability=NEW.capability AND allow_row.effect='allow' AND allow_row.active=1
        AND (allow_row.scope_kind='global'
          OR (allow_row.scope_kind='exact_staff' AND allow_row.target_staff_id=NEW.target_staff_id)
          OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=allow_row.business_area_id))
          OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=allow_row.business_area_id AND membership.division_id=allow_row.division_id)))
      UNION ALL
      SELECT 1 FROM native_staff_admin_delegations allow_row
      WHERE allow_row.actor_staff_id=NEW.actor_staff_id AND allow_row.action=NEW.capability
        AND allow_row.effect='allow' AND allow_row.active=1
        AND (allow_row.scope_kind='global'
          OR (allow_row.scope_kind='exact_staff' AND allow_row.target_staff_id=NEW.target_staff_id)
          OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=allow_row.business_area_id))
          OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=allow_row.business_area_id AND membership.division_id=allow_row.division_id)))
    )
    AND NOT EXISTS(
      SELECT 1 FROM native_staff_management_delegations deny_row
      WHERE deny_row.actor_staff_id=NEW.actor_staff_id AND deny_row.contract_version=1
        AND deny_row.capability=NEW.capability AND deny_row.effect='deny' AND deny_row.active=1
        AND (deny_row.scope_kind='global'
          OR (deny_row.scope_kind='exact_staff' AND deny_row.target_staff_id=NEW.target_staff_id)
          OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=deny_row.business_area_id))
          OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=deny_row.business_area_id AND membership.division_id=deny_row.division_id)))
      UNION ALL
      SELECT 1 FROM native_staff_admin_delegations deny_row
      WHERE deny_row.actor_staff_id=NEW.actor_staff_id AND deny_row.action=NEW.capability
        AND deny_row.effect='deny' AND deny_row.active=1
        AND (deny_row.scope_kind='global'
          OR (deny_row.scope_kind='exact_staff' AND deny_row.target_staff_id=NEW.target_staff_id)
          OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=deny_row.business_area_id))
          OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_staff_target_memberships membership
            WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1 AND membership.business_area_id=deny_row.business_area_id AND membership.division_id=deny_row.division_id)))
    )
    AND NOT EXISTS(SELECT 1 FROM native_staff_target_memberships membership
      LEFT JOIN native_business_areas area ON area.id=membership.business_area_id
      LEFT JOIN native_business_divisions division ON division.id=membership.division_id AND division.business_area_id=membership.business_area_id
      WHERE membership.staff_id=NEW.target_staff_id AND membership.active=1
        AND (coalesce(area.active,0)<>1 OR (membership.scope_kind='business_area' AND membership.division_id IS NOT NULL)
          OR (membership.scope_kind='division' AND (membership.division_id IS NULL OR coalesce(division.active,0)<>1))))
)
BEGIN SELECT RAISE(ABORT,'native staff management authorization changed'); END;

CREATE TRIGGER native_staff_management_commands_surviving_candidate BEFORE INSERT ON native_staff_management_commands
WHEN NEW.capability='staff.admission.disable' AND NOT EXISTS(SELECT 1 FROM native_staff_control_plane_candidates)
BEGIN SELECT RAISE(ABORT,'native staff management control plane would be unavailable'); END;

CREATE TRIGGER native_staff_management_commands_consume AFTER INSERT ON native_staff_management_commands
BEGIN DELETE FROM native_staff_management_fences WHERE command_id=NEW.command_id; END;

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


CREATE TRIGGER native_staff_management_fences_target_closed BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind<>'live_staff'
BEGIN SELECT RAISE(ABORT,'onboarding administrator commands are not enabled'); END;

CREATE TRIGGER native_staff_management_commands_target_closed BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind<>'live_staff'
BEGIN SELECT RAISE(ABORT,'onboarding administrator commands are not enabled'); END;

CREATE TRIGGER native_staff_management_fences_target_identity BEFORE UPDATE ON native_staff_management_fences
WHEN NEW.target_kind IS NOT OLD.target_kind OR NEW.target_onboarding_id IS NOT OLD.target_onboarding_id
  OR NEW.target_proposed_staff_id IS NOT OLD.target_proposed_staff_id
BEGIN SELECT RAISE(ABORT,'native staff management target is immutable'); END;

-- NULL live-staff IDs must not defeat uniqueness when onboarding commands are added.
CREATE UNIQUE INDEX native_staff_management_fences_one_onboarding_mutation
  ON native_staff_management_fences(capability,target_onboarding_id,target_proposed_staff_id,expected_version,result_version)
  WHERE target_kind='onboarding';

CREATE TRIGGER native_staff_management_commands_target_identity BEFORE INSERT ON native_staff_management_commands
WHEN NOT EXISTS(SELECT 1 FROM native_staff_management_fences fence
  WHERE fence.command_id=NEW.command_id AND fence.target_kind=NEW.target_kind
    AND fence.target_staff_id IS NEW.target_staff_id
    AND fence.target_onboarding_id IS NEW.target_onboarding_id
    AND fence.target_proposed_staff_id IS NEW.target_proposed_staff_id)
BEGIN SELECT RAISE(ABORT,'native staff management command target does not match'); END;
