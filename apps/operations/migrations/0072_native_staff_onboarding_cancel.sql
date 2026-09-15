-- Opens only version-1 staff.onboarding.cancel on the generic 0071 ledger.
-- Existing live-staff guards are recreated with an explicit target discriminator.
PRAGMA foreign_keys = ON;
DROP TRIGGER native_staff_management_fences_insert_guard;
DROP TRIGGER native_staff_management_fences_update_guard;
DROP TRIGGER native_staff_management_commands_valid;
DROP TRIGGER native_staff_management_fences_target_closed;
DROP TRIGGER native_staff_management_commands_target_closed;

CREATE TRIGGER native_staff_management_fences_insert_guard BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='live_staff' AND (NEW.mutation_writes<>1
  OR EXISTS(SELECT 1 FROM native_staff_management_fences fence WHERE fence.command_id=NEW.command_id)
  OR EXISTS(SELECT 1 FROM native_staff_management_commands receipt WHERE receipt.command_id=NEW.command_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions actor JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
    WHERE actor.staff_id=NEW.actor_staff_id AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions target JOIN native_staff_profiles profile ON profile.staff_id=target.staff_id WHERE target.staff_id=NEW.target_staff_id)
  OR NOT ((NEW.capability='staff.profile.edit' AND NEW.display_name IS NOT NULL AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=NEW.target_staff_id AND version=NEW.expected_version))
    OR (NEW.capability='staff.admission.disable' AND NEW.display_name IS NULL AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.target_staff_id AND active=1 AND version=NEW.expected_version))
    OR (NEW.capability='staff.admission.enable' AND NEW.display_name IS NULL AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.target_staff_id AND active=0 AND version=NEW.expected_version)))
)
BEGIN SELECT RAISE(ABORT,'native staff management fence prestate is invalid'); END;

CREATE TRIGGER native_staff_management_fences_update_guard BEFORE UPDATE ON native_staff_management_fences
WHEN NEW.target_kind='live_staff' AND (NEW.command_id IS NOT OLD.command_id OR NEW.request_sha256 IS NOT OLD.request_sha256
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
)
BEGIN SELECT RAISE(ABORT,'native staff management fence transition is invalid'); END;

CREATE TRIGGER native_staff_management_commands_valid BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='live_staff' AND (NOT EXISTS (
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
)
BEGIN SELECT RAISE(ABORT,'native staff management authorization changed'); END;

CREATE TRIGGER native_staff_management_fences_target_closed BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability<>'staff.onboarding.cancel'
BEGIN SELECT RAISE(ABORT,'onboarding administrator command is not enabled'); END;

CREATE TRIGGER native_staff_management_commands_target_closed BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability<>'staff.onboarding.cancel'
BEGIN SELECT RAISE(ABORT,'onboarding administrator command is not enabled'); END;

CREATE TRIGGER native_staff_onboarding_cancel_fence_insert BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND (
  EXISTS(SELECT 1 FROM native_staff_management_fences fence WHERE fence.command_id=NEW.command_id)
  OR EXISTS(SELECT 1 FROM native_staff_management_commands receipt WHERE receipt.command_id=NEW.command_id)
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation command identity already exists'); END;

CREATE TRIGGER native_staff_onboarding_cancel_fence_prestate BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NOT EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding p
  WHERE NEW.capability='staff.onboarding.cancel' AND NEW.target_staff_id IS NULL
    AND NEW.display_name IS NULL AND NEW.mutation_writes=1
    AND p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND p.state IN ('pending','claimed') AND p.version=NEW.expected_version
    AND (SELECT count(*) FROM json_each(NEW.result_json))=7
    AND (SELECT count(DISTINCT key) FROM json_each(NEW.result_json))=7
    AND json_type(NEW.result_json,'$.contractVersion')='integer' AND json_extract(NEW.result_json,'$.contractVersion')=1
    AND json_type(NEW.result_json,'$.capability')='text' AND json_extract(NEW.result_json,'$.capability')='staff.onboarding.cancel'
    AND json_type(NEW.result_json,'$.targetOnboardingId')='text' AND json_extract(NEW.result_json,'$.targetOnboardingId')=p.onboarding_id
    AND json_type(NEW.result_json,'$.targetProposedStaffId')='text' AND json_extract(NEW.result_json,'$.targetProposedStaffId')=p.proposed_staff_id
    AND json_type(NEW.result_json,'$.proposalSha256')='text' AND json_extract(NEW.result_json,'$.proposalSha256')=p.proposal_sha256
    AND ((p.claim_evidence_sha256 IS NULL AND json_type(NEW.result_json,'$.claimEvidenceSha256')='null')
      OR (p.claim_evidence_sha256 IS NOT NULL AND json_type(NEW.result_json,'$.claimEvidenceSha256')='text'
        AND json_extract(NEW.result_json,'$.claimEvidenceSha256')=p.claim_evidence_sha256))
    AND json_type(NEW.result_json,'$.resultVersion')='integer' AND json_extract(NEW.result_json,'$.resultVersion')=NEW.result_version

)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation fence prestate is invalid'); END;

CREATE TRIGGER native_staff_onboarding_cancel_fence_update BEFORE UPDATE ON native_staff_management_fences
WHEN OLD.target_kind='onboarding' AND (
  OLD.capability<>'staff.onboarding.cancel' OR OLD.mutation_writes<>1 OR NEW.mutation_writes<>0
  OR NEW.command_id IS NOT OLD.command_id OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.contract_version IS NOT OLD.contract_version OR NEW.capability IS NOT OLD.capability
  OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject
  OR NEW.target_staff_id IS NOT OLD.target_staff_id OR NEW.expected_version IS NOT OLD.expected_version
  OR NEW.result_version IS NOT OLD.result_version OR NEW.reason IS NOT OLD.reason
  OR NEW.display_name IS NOT OLD.display_name OR NEW.result_json IS NOT OLD.result_json
  OR NEW.result_sha256 IS NOT OLD.result_sha256 OR NEW.created_at IS NOT OLD.created_at
  OR NOT EXISTS(SELECT 1 FROM native_staff_pending_onboarding p
    WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
      AND p.state='cancelled' AND p.version=NEW.result_version
      AND p.terminal_by_staff_id=NEW.actor_staff_id
      AND p.proposal_sha256=json_extract(NEW.result_json,'$.proposalSha256')
      AND p.claim_evidence_sha256 IS json_extract(NEW.result_json,'$.claimEvidenceSha256'))
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation fence transition is invalid'); END;

CREATE TRIGGER native_staff_onboarding_cancel_write_guard BEFORE UPDATE ON native_staff_pending_onboarding
WHEN OLD.state IN ('pending','claimed') AND NEW.state='cancelled' AND NOT EXISTS (
  SELECT 1 FROM native_staff_management_fences fence
  WHERE fence.target_kind='onboarding' AND fence.capability='staff.onboarding.cancel'
    AND fence.target_onboarding_id=OLD.onboarding_id AND fence.target_proposed_staff_id=OLD.proposed_staff_id
    AND fence.expected_version=OLD.version AND fence.result_version=NEW.version
    AND fence.actor_staff_id=NEW.terminal_by_staff_id AND fence.mutation_writes=1
    AND json_extract(fence.result_json,'$.proposalSha256')=OLD.proposal_sha256
    AND json_extract(fence.result_json,'$.claimEvidenceSha256') IS OLD.claim_evidence_sha256
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation requires a current command fence'); END;

CREATE TRIGGER native_staff_onboarding_cancel_consume AFTER UPDATE ON native_staff_pending_onboarding
WHEN OLD.state IN ('pending','claimed') AND NEW.state='cancelled' AND NEW.version=OLD.version+1
  AND NEW.terminal_by_staff_id IS NOT NULL AND NEW.terminal_at IS NOT NULL
BEGIN
  UPDATE native_staff_management_fences SET mutation_writes=0
  WHERE target_kind='onboarding' AND capability='staff.onboarding.cancel'
    AND target_onboarding_id=NEW.onboarding_id AND target_proposed_staff_id=NEW.proposed_staff_id
    AND expected_version=OLD.version AND result_version=NEW.version AND actor_staff_id=NEW.terminal_by_staff_id
    AND mutation_writes=1;
END;

CREATE TRIGGER native_staff_onboarding_cancel_receipt BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NOT EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding p JOIN native_staff_management_fences fence
    ON fence.command_id=NEW.command_id AND fence.target_kind='onboarding'
    AND fence.target_onboarding_id=p.onboarding_id AND fence.target_proposed_staff_id=p.proposed_staff_id
  WHERE NEW.capability='staff.onboarding.cancel' AND NEW.target_staff_id IS NULL AND NEW.display_name IS NULL
    AND NEW.target_onboarding_id=p.onboarding_id AND NEW.target_proposed_staff_id=p.proposed_staff_id
    AND p.state='cancelled' AND p.version=NEW.result_version
    AND p.terminal_by_staff_id=NEW.actor_staff_id AND p.terminal_at IS NOT NULL
    AND NEW.expected_version IN (1,2) AND NEW.result_version=NEW.expected_version+1
    AND fence.mutation_writes=0 AND fence.capability=NEW.capability
    AND fence.request_sha256=NEW.request_sha256 AND fence.contract_version=NEW.contract_version
    AND fence.actor_staff_id=NEW.actor_staff_id AND fence.actor_access_subject=NEW.actor_access_subject
    AND fence.expected_version=NEW.expected_version AND fence.result_version=NEW.result_version
    AND fence.reason=NEW.reason AND fence.display_name IS NEW.display_name
    AND fence.result_json=NEW.result_json AND fence.result_sha256=NEW.result_sha256
    AND (SELECT count(*) FROM json_each(NEW.result_json))=7
    AND (SELECT count(DISTINCT key) FROM json_each(NEW.result_json))=7
    AND json_type(NEW.result_json,'$.contractVersion')='integer' AND json_extract(NEW.result_json,'$.contractVersion')=1
    AND json_type(NEW.result_json,'$.capability')='text' AND json_extract(NEW.result_json,'$.capability')='staff.onboarding.cancel'
    AND json_type(NEW.result_json,'$.targetOnboardingId')='text' AND json_extract(NEW.result_json,'$.targetOnboardingId')=p.onboarding_id
    AND json_type(NEW.result_json,'$.targetProposedStaffId')='text' AND json_extract(NEW.result_json,'$.targetProposedStaffId')=p.proposed_staff_id
    AND json_type(NEW.result_json,'$.proposalSha256')='text' AND json_extract(NEW.result_json,'$.proposalSha256')=p.proposal_sha256
    AND ((p.claim_evidence_sha256 IS NULL AND json_type(NEW.result_json,'$.claimEvidenceSha256')='null')
      OR (p.claim_evidence_sha256 IS NOT NULL AND json_type(NEW.result_json,'$.claimEvidenceSha256')='text'
        AND json_extract(NEW.result_json,'$.claimEvidenceSha256')=p.claim_evidence_sha256))
    AND json_type(NEW.result_json,'$.resultVersion')='integer' AND json_extract(NEW.result_json,'$.resultVersion')=NEW.result_version

)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation receipt is invalid'); END;


CREATE TRIGGER native_staff_onboarding_cancel_fence_actor_allow BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NOT EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding p
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
  WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject
    AND EXISTS(SELECT 1 FROM native_staff_management_delegations d
      WHERE d.actor_staff_id=NEW.actor_staff_id AND d.contract_version=1
        AND d.capability='staff.onboarding.cancel' AND d.effect='allow' AND d.active=1
        AND (d.scope_kind='global'
      OR (d.scope_kind='exact_staff' AND d.target_staff_id=p.proposed_staff_id)
      OR (d.scope_kind='business_area' AND EXISTS (
        SELECT 1 FROM json_each(p.proposal_json,'$.memberships') member
        WHERE json_extract(member.value,'$.businessAreaId')=d.business_area_id))
      OR (d.scope_kind='division' AND EXISTS (
        SELECT 1 FROM json_each(p.proposal_json,'$.memberships') member
        WHERE json_extract(member.value,'$.scopeKind')='division'
          AND json_extract(member.value,'$.businessAreaId')=d.business_area_id
          AND json_extract(member.value,'$.divisionId')=d.division_id))))
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation actor or allow is unavailable'); END;

CREATE TRIGGER native_staff_onboarding_cancel_fence_deny BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding p JOIN native_staff_management_delegations d
    ON d.actor_staff_id=NEW.actor_staff_id AND d.contract_version=1
      AND d.capability='staff.onboarding.cancel' AND d.effect='deny' AND d.active=1
  WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND (d.scope_kind='global'
      OR (d.scope_kind='exact_staff' AND d.target_staff_id=p.proposed_staff_id)
      OR (d.scope_kind='business_area' AND EXISTS (
        SELECT 1 FROM json_each(p.proposal_json,'$.memberships') member
        WHERE json_extract(member.value,'$.businessAreaId')=d.business_area_id))
      OR (d.scope_kind='division' AND EXISTS (
        SELECT 1 FROM json_each(p.proposal_json,'$.memberships') member
        WHERE json_extract(member.value,'$.scopeKind')='division'
          AND json_extract(member.value,'$.businessAreaId')=d.business_area_id
          AND json_extract(member.value,'$.divisionId')=d.division_id)))
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation is denied'); END;

CREATE TRIGGER native_staff_onboarding_cancel_fence_parents BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding p
  JOIN json_each(p.proposal_json,'$.memberships') member
  LEFT JOIN native_business_areas area ON area.id=json_extract(member.value,'$.businessAreaId')
  LEFT JOIN native_business_divisions division ON division.id=json_extract(member.value,'$.divisionId')
    AND division.business_area_id=json_extract(member.value,'$.businessAreaId')
  WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND (coalesce(area.active,0)<>1 OR
      (json_extract(member.value,'$.scopeKind')='division' AND coalesce(division.active,0)<>1))
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation parent is unavailable'); END;


CREATE TRIGGER native_staff_onboarding_cancel_receipt_actor_allow BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NOT EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding p
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
  WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject
    AND EXISTS(SELECT 1 FROM native_staff_management_delegations d
      WHERE d.actor_staff_id=NEW.actor_staff_id AND d.contract_version=1
        AND d.capability='staff.onboarding.cancel' AND d.effect='allow' AND d.active=1
        AND (d.scope_kind='global'
      OR (d.scope_kind='exact_staff' AND d.target_staff_id=p.proposed_staff_id)
      OR (d.scope_kind='business_area' AND EXISTS (
        SELECT 1 FROM json_each(p.proposal_json,'$.memberships') member
        WHERE json_extract(member.value,'$.businessAreaId')=d.business_area_id))
      OR (d.scope_kind='division' AND EXISTS (
        SELECT 1 FROM json_each(p.proposal_json,'$.memberships') member
        WHERE json_extract(member.value,'$.scopeKind')='division'
          AND json_extract(member.value,'$.businessAreaId')=d.business_area_id
          AND json_extract(member.value,'$.divisionId')=d.division_id))))
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation actor or allow is unavailable'); END;

CREATE TRIGGER native_staff_onboarding_cancel_receipt_deny BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding p JOIN native_staff_management_delegations d
    ON d.actor_staff_id=NEW.actor_staff_id AND d.contract_version=1
      AND d.capability='staff.onboarding.cancel' AND d.effect='deny' AND d.active=1
  WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND (d.scope_kind='global'
      OR (d.scope_kind='exact_staff' AND d.target_staff_id=p.proposed_staff_id)
      OR (d.scope_kind='business_area' AND EXISTS (
        SELECT 1 FROM json_each(p.proposal_json,'$.memberships') member
        WHERE json_extract(member.value,'$.businessAreaId')=d.business_area_id))
      OR (d.scope_kind='division' AND EXISTS (
        SELECT 1 FROM json_each(p.proposal_json,'$.memberships') member
        WHERE json_extract(member.value,'$.scopeKind')='division'
          AND json_extract(member.value,'$.businessAreaId')=d.business_area_id
          AND json_extract(member.value,'$.divisionId')=d.division_id)))
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation is denied'); END;

CREATE TRIGGER native_staff_onboarding_cancel_receipt_parents BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND EXISTS (
  SELECT 1 FROM native_staff_pending_onboarding p
  JOIN json_each(p.proposal_json,'$.memberships') member
  LEFT JOIN native_business_areas area ON area.id=json_extract(member.value,'$.businessAreaId')
  LEFT JOIN native_business_divisions division ON division.id=json_extract(member.value,'$.divisionId')
    AND division.business_area_id=json_extract(member.value,'$.businessAreaId')
  WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND (coalesce(area.active,0)<>1 OR
      (json_extract(member.value,'$.scopeKind')='division' AND coalesce(division.active,0)<>1))
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation parent is unavailable'); END;
