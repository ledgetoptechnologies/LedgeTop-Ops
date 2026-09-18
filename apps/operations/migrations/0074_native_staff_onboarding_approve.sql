-- Claimed invitation approval is one atomic generic management command.
PRAGMA foreign_keys = ON;

DROP TRIGGER native_staff_management_fences_target_closed;
DROP TRIGGER native_staff_management_commands_target_closed;
CREATE TRIGGER native_staff_management_fences_target_closed BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability NOT IN
  ('staff.onboarding.cancel','staff.onboarding.create','staff.onboarding.approve')
BEGIN SELECT RAISE(ABORT,'onboarding administrator command is not enabled'); END;
CREATE TRIGGER native_staff_management_commands_target_closed BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability NOT IN
  ('staff.onboarding.cancel','staff.onboarding.create','staff.onboarding.approve')
BEGIN SELECT RAISE(ABORT,'onboarding administrator command is not enabled'); END;

DROP TRIGGER native_staff_pending_onboarding_approval_guard;
CREATE TRIGGER native_staff_pending_onboarding_approval_guard BEFORE UPDATE ON native_staff_pending_onboarding
WHEN NEW.state='approved' AND NOT EXISTS(
  SELECT 1 FROM native_staff_management_commands command
  JOIN staff_users bridge ON bridge.id=NEW.proposed_staff_id AND lower(bridge.email)=NEW.login_email
    AND bridge.access_subject=NEW.claimed_access_subject AND bridge.status='active'
    AND bridge.display_name=NEW.display_name AND bridge.provisioning_source='local'
    AND bridge.sync_protected=1 AND bridge.project_alpha_user_id IS NULL
  JOIN native_staff_admissions admission ON admission.staff_id=bridge.id AND admission.active=1
    AND admission.bound_access_subject=NEW.claimed_access_subject
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    AND profile.login_email=NEW.login_email AND profile.display_name=NEW.display_name
  WHERE command.command_id=NEW.approval_command_id AND command.contract_version=1
    AND command.capability='staff.onboarding.approve' AND command.target_kind='onboarding'
    AND command.target_onboarding_id=NEW.onboarding_id
    AND command.target_proposed_staff_id=NEW.proposed_staff_id
    AND command.target_staff_id IS NULL AND command.actor_staff_id=NEW.terminal_by_staff_id
    AND command.expected_version=2 AND command.result_version=3
    AND json_extract(command.result_json,'$.proposalSha256')=NEW.proposal_sha256
    AND json_extract(command.result_json,'$.claimEvidenceSha256')=NEW.claim_evidence_sha256
)
BEGIN SELECT RAISE(ABORT,'native staff pending onboarding approval is unavailable'); END;

CREATE VIEW native_staff_onboarding_approve_records AS
SELECT command_id,actor_staff_id,actor_access_subject,target_kind,capability,target_proposed_staff_id,result_json
FROM native_staff_management_fences WHERE capability='staff.onboarding.approve'
UNION ALL
SELECT command_id,actor_staff_id,actor_access_subject,target_kind,capability,target_proposed_staff_id,result_json
FROM native_staff_management_commands WHERE capability='staff.onboarding.approve';

CREATE VIEW native_staff_onboarding_approve_proposed_grants AS
SELECT f.command_id, f.actor_staff_id, f.target_proposed_staff_id,
  'directory' AS authority_domain, 'staff.directory_grant.manage' AS management_capability,
  json_extract(g.value,'$.permission') AS capability, json_extract(g.value,'$.effect') AS grant_effect,
  json_extract(g.value,'$.scopeKind') AS scope_kind,
  json_extract(g.value,'$.businessAreaId') AS business_area_id,
  json_extract(g.value,'$.divisionId') AS division_id,
  json_extract(g.value,'$.resourceId') AS resource_id,
  NULL AS target_staff_id
FROM native_staff_onboarding_approve_records f, json_each(f.result_json,'$.proposal.directoryGrants') g
WHERE f.capability='staff.onboarding.approve' AND f.target_kind='onboarding'
UNION ALL
SELECT f.command_id, f.actor_staff_id, f.target_proposed_staff_id,
  'staff_admin', 'staff.admin_delegation.manage',
  json_extract(g.value,'$.capability'), json_extract(g.value,'$.effect'),
  json_extract(g.value,'$.scopeKind'), json_extract(g.value,'$.businessAreaId'),
  json_extract(g.value,'$.divisionId'), NULL, json_extract(g.value,'$.targetStaffId')
FROM native_staff_onboarding_approve_records f, json_each(f.result_json,'$.proposal.managementGrants') g
WHERE f.capability='staff.onboarding.approve' AND f.target_kind='onboarding';

-- A manager of a proposed grant must have target-management authority over every
-- proposed membership; the empty target requires an explicit global allow.
CREATE VIEW native_staff_onboarding_approve_grant_target_failures AS
SELECT g.command_id FROM native_staff_onboarding_approve_proposed_grants g
JOIN native_staff_onboarding_approve_records f ON f.command_id=g.command_id
WHERE (json_array_length(f.result_json,'$.proposal.memberships')=0
  AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d
    WHERE d.actor_staff_id=g.actor_staff_id AND d.active=1 AND d.effect='allow'
      AND d.capability=g.management_capability AND d.scope_kind='global'))
  OR EXISTS(SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
    WHERE NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d
      WHERE d.actor_staff_id=g.actor_staff_id AND d.active=1 AND d.effect='allow'
        AND d.capability=g.management_capability AND
        (d.scope_kind='global'
          OR (d.scope_kind='business_area' AND d.business_area_id=json_extract(member.value,'$.businessAreaId'))
          OR (d.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
            AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
            AND d.division_id=json_extract(member.value,'$.divisionId')))))
  OR EXISTS(SELECT 1 FROM native_staff_management_delegations d
    WHERE d.actor_staff_id=g.actor_staff_id AND d.active=1 AND d.effect='deny'
      AND d.capability=g.management_capability AND
      (d.scope_kind='global' OR EXISTS(SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
        WHERE (d.scope_kind='business_area' AND d.business_area_id=json_extract(member.value,'$.businessAreaId'))
          OR (d.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
            AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
            AND d.division_id=json_extract(member.value,'$.divisionId')))));

-- Exact capability/effect/operation and stable scope containment, independently
-- from the recipient-target scope of the parent management delegation.
CREATE VIEW native_staff_onboarding_approve_grant_ceiling_failures AS
SELECT g.command_id FROM native_staff_onboarding_approve_proposed_grants g
JOIN native_staff_onboarding_approve_records f ON f.command_id=g.command_id
LEFT JOIN native_business_divisions division ON division.id=g.division_id
LEFT JOIN native_business_areas area ON area.id=coalesce(g.business_area_id,division.business_area_id)
LEFT JOIN operations_directory_records resource ON resource.record_id=g.resource_id
LEFT JOIN native_staff_admissions target ON target.staff_id=g.target_staff_id
WHERE (g.scope_kind='business_area' AND coalesce(area.active,0)<>1)
  OR (g.scope_kind='division' AND
    (coalesce(area.active,0)<>1 OR coalesce(division.active,0)<>1 OR
      (g.business_area_id IS NOT NULL AND division.business_area_id<>g.business_area_id)))
  OR (g.scope_kind='resource' AND resource.record_id IS NULL)
  OR (g.scope_kind='exact_staff' AND g.target_staff_id<>g.target_proposed_staff_id AND target.staff_id IS NULL)
  OR NOT EXISTS(SELECT 1 FROM native_staff_delegation_ceilings c
    JOIN native_staff_management_delegations parent ON parent.id=c.parent_delegation_id
    WHERE parent.actor_staff_id=g.actor_staff_id AND parent.active=1 AND parent.effect='allow'
      AND parent.capability=g.management_capability AND c.active=1 AND c.effect='allow'
      AND c.authority_domain=g.authority_domain AND c.capability=g.capability
      AND c.operation_create=1
      AND (parent.scope_kind='global' OR
        (json_array_length(f.result_json,'$.proposal.memberships')>0 AND EXISTS(
          SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
          WHERE ((parent.scope_kind='business_area'
              AND parent.business_area_id=json_extract(member.value,'$.businessAreaId'))
            OR (parent.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
              AND parent.business_area_id=json_extract(member.value,'$.businessAreaId')
              AND parent.division_id=json_extract(member.value,'$.divisionId'))))))
      AND ((g.grant_effect='allow' AND c.grant_allow=1) OR (g.grant_effect='deny' AND c.grant_deny=1))
      AND (c.scope_kind='global'
        OR (c.scope_kind=g.scope_kind AND c.business_area_id IS coalesce(g.business_area_id,division.business_area_id)
          AND c.division_id IS g.division_id AND c.resource_id IS g.resource_id
          AND c.target_staff_id IS g.target_staff_id)
        OR (c.scope_kind='business_area' AND g.scope_kind='division'
          AND c.business_area_id=coalesce(g.business_area_id,division.business_area_id))))
  OR EXISTS(SELECT 1 FROM native_staff_delegation_ceilings c
    JOIN native_staff_management_delegations parent ON parent.id=c.parent_delegation_id
    WHERE parent.actor_staff_id=g.actor_staff_id AND parent.active=1 AND parent.effect='allow'
      AND parent.capability=g.management_capability AND c.active=1 AND c.effect='deny'
      AND c.authority_domain=g.authority_domain AND c.capability=g.capability
      AND c.operation_create=1
      AND (parent.scope_kind='global' OR
        (json_array_length(f.result_json,'$.proposal.memberships')>0 AND EXISTS(
          SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
          WHERE ((parent.scope_kind='business_area'
              AND parent.business_area_id=json_extract(member.value,'$.businessAreaId'))
            OR (parent.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
              AND parent.business_area_id=json_extract(member.value,'$.businessAreaId')
              AND parent.division_id=json_extract(member.value,'$.divisionId'))))))
      AND ((g.grant_effect='allow' AND c.grant_allow=1) OR (g.grant_effect='deny' AND c.grant_deny=1))
      AND (c.scope_kind='global' OR g.scope_kind='global'
        OR (c.scope_kind=g.scope_kind AND
          (c.scope_kind='assigned' OR
            (c.scope_kind='business_area' AND c.business_area_id=g.business_area_id) OR
            (c.scope_kind='division' AND c.division_id=g.division_id) OR
            (c.scope_kind='resource' AND c.resource_id=g.resource_id) OR
            (c.scope_kind='exact_staff' AND c.target_staff_id=g.target_staff_id)))
        OR (c.scope_kind='business_area' AND g.scope_kind='division'
          AND c.business_area_id=coalesce(g.business_area_id,division.business_area_id))
        OR (c.scope_kind='division' AND g.scope_kind='business_area'
          AND c.business_area_id=g.business_area_id)
        OR ((c.scope_kind IN ('assigned','resource','exact_staff') OR g.scope_kind IN ('assigned','resource','exact_staff'))
          AND c.scope_kind<>g.scope_kind)));

CREATE VIEW native_staff_onboarding_approve_membership_failures AS
SELECT f.command_id FROM native_staff_onboarding_approve_records f
WHERE f.target_kind='onboarding' AND f.capability='staff.onboarding.approve' AND (
  (json_array_length(f.result_json,'$.proposal.memberships')=0 AND NOT EXISTS(
    SELECT 1 FROM native_staff_management_delegations d
    WHERE d.actor_staff_id=f.actor_staff_id AND d.active=1 AND d.effect='allow'
      AND d.capability='staff.onboarding.approve' AND d.scope_kind='global'))
  OR EXISTS(SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
    WHERE EXISTS(SELECT 1 FROM (SELECT 'staff.onboarding.approve' capability UNION ALL SELECT 'staff.membership.manage') required
      WHERE NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d
        WHERE d.actor_staff_id=f.actor_staff_id AND d.active=1 AND d.effect='allow'
          AND d.capability=required.capability AND (d.scope_kind='global'
            OR (d.scope_kind='business_area' AND d.business_area_id=json_extract(member.value,'$.businessAreaId'))
            OR (d.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
              AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
              AND d.division_id=json_extract(member.value,'$.divisionId'))))))
  OR EXISTS(SELECT 1 FROM native_staff_management_delegations d
    WHERE d.actor_staff_id=f.actor_staff_id AND d.active=1 AND d.effect='deny'
      AND d.capability IN ('staff.onboarding.approve','staff.membership.manage')
      AND (d.scope_kind='global' OR EXISTS(SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
        WHERE (d.scope_kind='business_area' AND d.business_area_id=json_extract(member.value,'$.businessAreaId'))
          OR (d.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
            AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
            AND d.division_id=json_extract(member.value,'$.divisionId')))))
);

-- A+B recipients cannot borrow A's ceiling while relying on a ceiling-less
-- management delegation for B. Each prospective membership needs a matching
-- effective ceiling-backed parent for each proposed grant.
CREATE VIEW native_staff_onboarding_approve_uncovered_grant_memberships AS
SELECT g.command_id FROM native_staff_onboarding_approve_proposed_grants g
JOIN native_staff_onboarding_approve_records f ON f.command_id=g.command_id
LEFT JOIN native_business_divisions grant_division ON grant_division.id=g.division_id
JOIN json_each(f.result_json,'$.proposal.memberships') member
WHERE NOT EXISTS (
  SELECT 1 FROM native_staff_delegation_ceilings c
  JOIN native_staff_management_delegations parent ON parent.id=c.parent_delegation_id
  WHERE parent.actor_staff_id=g.actor_staff_id AND parent.active=1 AND parent.effect='allow'
    AND parent.capability=g.management_capability AND c.active=1 AND c.effect='allow'
    AND c.authority_domain=g.authority_domain AND c.capability=g.capability
    AND c.operation_create=1
    AND ((g.grant_effect='allow' AND c.grant_allow=1) OR (g.grant_effect='deny' AND c.grant_deny=1))
    AND (parent.scope_kind='global'
      OR (parent.scope_kind='business_area'
        AND parent.business_area_id=json_extract(member.value,'$.businessAreaId'))
      OR (parent.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
        AND parent.business_area_id=json_extract(member.value,'$.businessAreaId')
        AND parent.division_id=json_extract(member.value,'$.divisionId')))
    AND (c.scope_kind='global'
      OR (c.scope_kind=g.scope_kind AND c.business_area_id IS coalesce(g.business_area_id,grant_division.business_area_id)
        AND c.division_id IS g.division_id AND c.resource_id IS g.resource_id
        AND c.target_staff_id IS g.target_staff_id)
      OR (c.scope_kind='business_area' AND g.scope_kind='division'
        AND c.business_area_id=coalesce(g.business_area_id,grant_division.business_area_id)))
);

CREATE VIEW native_staff_onboarding_approve_authority AS
SELECT f.command_id FROM native_staff_onboarding_approve_records f
JOIN native_staff_admissions a ON a.staff_id=f.actor_staff_id
JOIN native_staff_profiles profile ON profile.staff_id=a.staff_id
WHERE f.target_kind='onboarding' AND f.capability='staff.onboarding.approve'
  AND a.active=1 AND a.bound_access_subject=f.actor_access_subject
  AND f.actor_access_subject IS NOT json_extract(f.result_json,'$.claimedAccessSubject')
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_membership_failures fail
    WHERE fail.command_id=f.command_id)
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_grant_target_failures fail
    WHERE fail.command_id=f.command_id)
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_grant_ceiling_failures fail
    WHERE fail.command_id=f.command_id)
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_uncovered_grant_memberships fail
    WHERE fail.command_id=f.command_id)
  AND NOT EXISTS(SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
    LEFT JOIN native_business_areas area ON area.id=json_extract(member.value,'$.businessAreaId')
    LEFT JOIN native_business_divisions division ON division.id=json_extract(member.value,'$.divisionId')
      AND division.business_area_id=json_extract(member.value,'$.businessAreaId')
    WHERE coalesce(area.active,0)<>1 OR
      (json_extract(member.value,'$.scopeKind')='division' AND coalesce(division.active,0)<>1));

CREATE VIEW native_staff_onboarding_approve_materialized AS
SELECT f.command_id FROM native_staff_onboarding_approve_records f
JOIN native_staff_pending_onboarding p ON p.onboarding_id=json_extract(f.result_json,'$.targetOnboardingId')
  AND p.proposed_staff_id=f.target_proposed_staff_id
JOIN staff_users bridge ON bridge.id=p.proposed_staff_id AND bridge.email=p.login_email
  AND bridge.display_name=p.display_name AND bridge.access_subject=p.claimed_access_subject
  AND bridge.provisioning_source='local' AND bridge.sync_protected=1
  AND bridge.project_alpha_user_id IS NULL AND bridge.status='active'
  JOIN native_staff_admissions admission ON admission.staff_id=bridge.id AND admission.active=1
  AND admission.bound_access_subject=p.claimed_access_subject AND admission.admitted_by=f.actor_staff_id
  AND admission.version=1
  JOIN native_staff_profiles profile ON profile.staff_id=bridge.id
  AND profile.login_email=p.login_email AND profile.display_name=p.display_name AND profile.version=1
WHERE p.state IN ('claimed','approved') AND p.version IN (2,3)
  AND p.proposal_json=json_extract(f.result_json,'$.proposal')
  AND p.proposal_sha256=json_extract(f.result_json,'$.proposalSha256')
  AND p.claim_evidence_sha256=json_extract(f.result_json,'$.claimEvidenceSha256')
  AND p.claimed_access_subject=json_extract(f.result_json,'$.claimedAccessSubject')
  AND (SELECT count(*) FROM native_staff_target_memberships m WHERE m.staff_id=p.proposed_staff_id)
    =json_array_length(p.proposal_json,'$.memberships')
  AND NOT EXISTS(SELECT 1 FROM json_each(p.proposal_json,'$.memberships') wanted
    WHERE NOT EXISTS(SELECT 1 FROM native_staff_target_memberships m
      WHERE m.staff_id=p.proposed_staff_id AND m.active=1 AND m.version=1
        AND m.created_by=f.actor_staff_id
        AND m.scope_kind=json_extract(wanted.value,'$.scopeKind')
        AND m.business_area_id=json_extract(wanted.value,'$.businessAreaId')
        AND m.division_id IS json_extract(wanted.value,'$.divisionId')))
  AND (SELECT count(*) FROM native_directory_grants g WHERE g.staff_id=p.proposed_staff_id)
    =json_array_length(p.proposal_json,'$.directoryGrants')
  AND NOT EXISTS(SELECT 1 FROM json_each(p.proposal_json,'$.directoryGrants') wanted
    WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants g
      WHERE g.staff_id=p.proposed_staff_id AND g.active=1 AND g.granted_by=f.actor_staff_id
        AND g.permission=json_extract(wanted.value,'$.permission')
        AND g.effect=json_extract(wanted.value,'$.effect')
        AND g.scope_kind=json_extract(wanted.value,'$.scopeKind')
        AND g.business_area_id IS json_extract(wanted.value,'$.businessAreaId')
        AND g.division_id IS json_extract(wanted.value,'$.divisionId')
        AND g.resource_id IS json_extract(wanted.value,'$.resourceId')))
  AND (SELECT count(*) FROM native_staff_management_delegations g WHERE g.actor_staff_id=p.proposed_staff_id)
    =json_array_length(p.proposal_json,'$.managementGrants')
  AND NOT EXISTS(SELECT 1 FROM json_each(p.proposal_json,'$.managementGrants') wanted
    WHERE NOT EXISTS(SELECT 1 FROM native_staff_management_delegations g
      WHERE g.actor_staff_id=p.proposed_staff_id AND g.active=1 AND g.version=1
        AND g.granted_by=f.actor_staff_id
        AND g.capability=json_extract(wanted.value,'$.capability')
        AND g.effect=json_extract(wanted.value,'$.effect')
        AND g.scope_kind=json_extract(wanted.value,'$.scopeKind')
        AND g.business_area_id IS json_extract(wanted.value,'$.businessAreaId')
        AND g.division_id IS json_extract(wanted.value,'$.divisionId')
        AND g.target_staff_id IS json_extract(wanted.value,'$.targetStaffId')))
  AND NOT EXISTS(SELECT 1 FROM native_staff_delegation_ceilings ceiling
    JOIN native_staff_management_delegations parent ON parent.id=ceiling.parent_delegation_id
    WHERE parent.actor_staff_id=p.proposed_staff_id);

CREATE TRIGGER native_staff_onboarding_approve_fence_prestate BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve' AND NOT EXISTS(
  SELECT 1 FROM native_staff_pending_onboarding p
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
  WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND p.state='claimed' AND p.version=2 AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND p.proposal_sha256=json_extract(NEW.result_json,'$.proposalSha256')
    AND p.claim_evidence_sha256=json_extract(NEW.result_json,'$.claimEvidenceSha256')
    AND p.proposal_json=json_extract(NEW.result_json,'$.proposal')
    AND p.claimed_access_subject=json_extract(NEW.result_json,'$.claimedAccessSubject')
    AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject
    AND actor.bound_access_subject<>p.claimed_access_subject
    AND NOT EXISTS(SELECT 1 FROM staff_users bridge WHERE bridge.id=p.proposed_staff_id OR lower(bridge.email)=p.login_email
      OR bridge.access_subject=p.claimed_access_subject)
    AND NOT EXISTS(SELECT 1 FROM native_staff_admissions admission WHERE admission.staff_id=p.proposed_staff_id
      OR admission.bound_access_subject=p.claimed_access_subject)
    AND NOT EXISTS(SELECT 1 FROM native_staff_profiles profile2 WHERE profile2.staff_id=p.proposed_staff_id
      OR profile2.login_email=p.login_email)
    AND NEW.expected_version=2 AND NEW.result_version=3 AND NEW.mutation_writes=1
    AND NEW.target_staff_id IS NULL AND NEW.display_name IS NULL
    AND json_type(NEW.result_json,'$.contractVersion')='integer'
    AND json_extract(NEW.result_json,'$.contractVersion')=1
    AND json_type(NEW.result_json,'$.capability')='text'
    AND json_extract(NEW.result_json,'$.capability')='staff.onboarding.approve'
    AND json_type(NEW.result_json,'$.targetOnboardingId')='text'
    AND json_extract(NEW.result_json,'$.targetOnboardingId')=p.onboarding_id
    AND json_type(NEW.result_json,'$.proposedStaffId')='text'
    AND json_extract(NEW.result_json,'$.proposedStaffId')=p.proposed_staff_id
    AND json_type(NEW.result_json,'$.proposalSha256')='text'
    AND json_type(NEW.result_json,'$.claimEvidenceSha256')='text'
    AND json_type(NEW.result_json,'$.claimedAccessSubject')='text'
    AND json_type(NEW.result_json,'$.proposal')='object'
    AND json_type(NEW.result_json,'$.proposal.memberships')='array'
    AND json_type(NEW.result_json,'$.proposal.directoryGrants')='array'
    AND json_type(NEW.result_json,'$.proposal.managementGrants')='array'
    AND json_type(NEW.result_json,'$.resultVersion')='integer'
    AND json_extract(NEW.result_json,'$.resultVersion')=3
    AND (SELECT count(*) FROM json_each(NEW.result_json))=9
    AND (SELECT count(DISTINCT key) FROM json_each(NEW.result_json))=9
)
BEGIN SELECT RAISE(ABORT,'onboarding approval fence prestate is invalid'); END;

CREATE TRIGGER native_staff_onboarding_approve_fence_authority AFTER INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve'
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_authority a WHERE a.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'onboarding approval authority or ceiling is unavailable'); END;

-- The service explicitly consumes this fence only after every proposed live row
-- exists. The receipt is still required before the pending terminal transition.
CREATE TRIGGER native_staff_onboarding_approve_fence_consume BEFORE UPDATE ON native_staff_management_fences
WHEN OLD.target_kind='onboarding' AND OLD.capability='staff.onboarding.approve' AND (
  OLD.mutation_writes<>1 OR NEW.mutation_writes<>0
  OR NEW.command_id IS NOT OLD.command_id OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.contract_version IS NOT OLD.contract_version OR NEW.capability IS NOT OLD.capability
  OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject
  OR NEW.target_kind IS NOT OLD.target_kind OR NEW.target_onboarding_id IS NOT OLD.target_onboarding_id
  OR NEW.target_proposed_staff_id IS NOT OLD.target_proposed_staff_id OR NEW.target_staff_id IS NOT OLD.target_staff_id
  OR NEW.expected_version IS NOT OLD.expected_version OR NEW.result_version IS NOT OLD.result_version
  OR NEW.reason IS NOT OLD.reason OR NEW.display_name IS NOT OLD.display_name
  OR NEW.result_json IS NOT OLD.result_json OR NEW.result_sha256 IS NOT OLD.result_sha256
  OR NEW.created_at IS NOT OLD.created_at
  OR NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_authority a WHERE a.command_id=OLD.command_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_materialized m WHERE m.command_id=OLD.command_id)
)
BEGIN SELECT RAISE(ABORT,'onboarding approval materialization is incomplete'); END;

CREATE TRIGGER native_staff_onboarding_approve_receipt BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve' AND NOT EXISTS(
  SELECT 1 FROM native_staff_management_fences f
  JOIN native_staff_pending_onboarding p ON p.onboarding_id=f.target_onboarding_id
    AND p.proposed_staff_id=f.target_proposed_staff_id
  WHERE f.command_id=NEW.command_id AND f.capability=NEW.capability AND f.mutation_writes=0
    AND f.request_sha256=NEW.request_sha256 AND f.contract_version=NEW.contract_version
    AND f.actor_staff_id=NEW.actor_staff_id AND f.actor_access_subject=NEW.actor_access_subject
    AND f.target_kind=NEW.target_kind AND f.target_onboarding_id=NEW.target_onboarding_id
    AND f.target_proposed_staff_id=NEW.target_proposed_staff_id AND f.target_staff_id IS NEW.target_staff_id
    AND f.expected_version=NEW.expected_version AND f.result_version=NEW.result_version
    AND f.reason=NEW.reason AND f.display_name IS NEW.display_name
    AND f.result_json=NEW.result_json AND f.result_sha256=NEW.result_sha256
    AND p.state='claimed' AND p.version=2 AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
BEGIN SELECT RAISE(ABORT,'onboarding approval receipt is invalid'); END;

CREATE TRIGGER native_staff_onboarding_approve_receipt_authority BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve'
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_authority a WHERE a.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'onboarding approval authority is unavailable'); END;

CREATE TRIGGER native_staff_onboarding_approve_receipt_materialized BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve'
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_approve_materialized m WHERE m.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'onboarding approval materialization is incomplete'); END;

CREATE TRIGGER native_staff_onboarding_approve_finish AFTER INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.approve'
BEGIN
  UPDATE native_staff_pending_onboarding SET state='approved',version=3,
    terminal_by_staff_id=NEW.actor_staff_id,
    terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),approval_command_id=NEW.command_id
  WHERE onboarding_id=NEW.target_onboarding_id AND proposed_staff_id=NEW.target_proposed_staff_id
    AND state='claimed' AND version=2 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now');
  SELECT RAISE(ABORT,'onboarding approval terminal transition failed') WHERE changes()<>1;
END;
