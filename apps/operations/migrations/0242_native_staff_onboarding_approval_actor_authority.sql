-- Approval requires an explicit current native delegation even when a caller
-- writes directly to the generic management fence tables. The current create
-- slice intentionally supports only an empty ACL proposal.
PRAGMA foreign_keys = ON;

CREATE TRIGGER native_staff_onboarding_approve_actor_allow BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve' AND NOT EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding pending
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
  WHERE pending.onboarding_id=NEW.target_onboarding_id
    AND pending.proposed_staff_id=NEW.target_proposed_staff_id
    AND pending.state='claimed' AND pending.version=2
    AND json_array_length(pending.proposal_json,'$.memberships')=0
    AND json_array_length(pending.proposal_json,'$.directoryGrants')=0
    AND json_array_length(pending.proposal_json,'$.managementGrants')=0
    AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject
    AND actor.bound_access_subject<>pending.claimed_access_subject
    AND EXISTS(SELECT 1 FROM native_staff_management_delegations allow_row
      WHERE allow_row.actor_staff_id=NEW.actor_staff_id AND allow_row.contract_version=1
        AND allow_row.capability='staff.onboarding.approve' AND allow_row.effect='allow'
        AND allow_row.scope_kind='global' AND allow_row.active=1)
)
BEGIN SELECT RAISE(ABORT,'onboarding approval requires current global allow authority'); END;

CREATE TRIGGER native_staff_onboarding_approve_actor_deny BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve' AND EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding pending
  JOIN native_staff_management_delegations deny_row ON deny_row.actor_staff_id=NEW.actor_staff_id
    AND deny_row.contract_version=1 AND deny_row.capability='staff.onboarding.approve'
    AND deny_row.effect='deny' AND deny_row.active=1
  WHERE pending.onboarding_id=NEW.target_onboarding_id
    AND pending.proposed_staff_id=NEW.target_proposed_staff_id
    AND (deny_row.scope_kind='global'
      OR (deny_row.scope_kind='exact_staff' AND deny_row.target_staff_id=pending.proposed_staff_id))
)
BEGIN SELECT RAISE(ABORT,'onboarding approval is denied'); END;

CREATE TRIGGER native_staff_onboarding_approve_receipt_actor_allow BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve' AND NOT EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding pending
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
  WHERE pending.onboarding_id=NEW.target_onboarding_id
    AND pending.proposed_staff_id=NEW.target_proposed_staff_id
    AND pending.state='claimed' AND pending.version=2
    AND json_array_length(pending.proposal_json,'$.memberships')=0
    AND json_array_length(pending.proposal_json,'$.directoryGrants')=0
    AND json_array_length(pending.proposal_json,'$.managementGrants')=0
    AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject
    AND actor.bound_access_subject<>pending.claimed_access_subject
    AND EXISTS(SELECT 1 FROM native_staff_management_delegations allow_row
      WHERE allow_row.actor_staff_id=NEW.actor_staff_id AND allow_row.contract_version=1
        AND allow_row.capability='staff.onboarding.approve' AND allow_row.effect='allow'
        AND allow_row.scope_kind='global' AND allow_row.active=1)
)
BEGIN SELECT RAISE(ABORT,'onboarding approval receipt requires current global allow authority'); END;

CREATE TRIGGER native_staff_onboarding_approve_receipt_actor_deny BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve' AND EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding pending
  JOIN native_staff_management_delegations deny_row ON deny_row.actor_staff_id=NEW.actor_staff_id
    AND deny_row.contract_version=1 AND deny_row.capability='staff.onboarding.approve'
    AND deny_row.effect='deny' AND deny_row.active=1
  WHERE pending.onboarding_id=NEW.target_onboarding_id
    AND pending.proposed_staff_id=NEW.target_proposed_staff_id
    AND (deny_row.scope_kind='global'
      OR (deny_row.scope_kind='exact_staff' AND deny_row.target_staff_id=pending.proposed_staff_id))
)
BEGIN SELECT RAISE(ABORT,'onboarding approval receipt is denied'); END;
