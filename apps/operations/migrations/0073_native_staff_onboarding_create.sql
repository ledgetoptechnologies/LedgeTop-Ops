-- A create command reserves one pending invitation, never a live staff identity.
PRAGMA foreign_keys = ON;

DROP TRIGGER native_staff_management_fences_target_closed;
DROP TRIGGER native_staff_management_commands_target_closed;

CREATE TRIGGER native_staff_management_fences_target_closed BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability NOT IN ('staff.onboarding.cancel','staff.onboarding.create')
BEGIN SELECT RAISE(ABORT,'onboarding administrator command is not enabled'); END;
CREATE TRIGGER native_staff_management_commands_target_closed BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability NOT IN ('staff.onboarding.cancel','staff.onboarding.create')
BEGIN SELECT RAISE(ABORT,'onboarding administrator command is not enabled'); END;

CREATE TRIGGER native_staff_onboarding_create_fence_shape BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create' AND (
  NEW.expected_version<>0 OR NEW.result_version<>1 OR NEW.mutation_writes<>1
  OR NEW.target_staff_id IS NOT NULL OR NEW.display_name IS NOT NULL
  OR json_type(NEW.result_json,'$.contractVersion') IS NOT 'integer'
  OR json_extract(NEW.result_json,'$.contractVersion') IS NOT 1
  OR json_type(NEW.result_json,'$.capability') IS NOT 'text'
  OR json_extract(NEW.result_json,'$.capability') IS NOT 'staff.onboarding.create'
  OR json_type(NEW.result_json,'$.onboardingId') IS NOT 'text'
  OR json_extract(NEW.result_json,'$.onboardingId') IS NOT NEW.target_onboarding_id
  OR json_type(NEW.result_json,'$.proposedStaffId') IS NOT 'text'
  OR json_extract(NEW.result_json,'$.proposedStaffId') IS NOT NEW.target_proposed_staff_id
  OR json_type(NEW.result_json,'$.loginEmail') IS NOT 'text'
  OR json_type(NEW.result_json,'$.displayName') IS NOT 'text'
  OR json_type(NEW.result_json,'$.expiresAt') IS NOT 'text'
  OR json_type(NEW.result_json,'$.proposal') IS NOT 'object'
  OR json_type(NEW.result_json,'$.proposal.memberships') IS NOT 'array'
  OR json_type(NEW.result_json,'$.proposal.directoryGrants') IS NOT 'array'
  OR json_type(NEW.result_json,'$.proposal.managementGrants') IS NOT 'array'
  OR json_type(NEW.result_json,'$.proposalSha256') IS NOT 'text'
  OR json_type(NEW.result_json,'$.invitationSecretSha256') IS NOT 'text'
  OR json_type(NEW.result_json,'$.resultVersion') IS NOT 'integer'
  OR json_extract(NEW.result_json,'$.resultVersion') IS NOT 1
  OR (SELECT count(*) FROM json_each(NEW.result_json))<>11
  OR (SELECT count(DISTINCT key) FROM json_each(NEW.result_json))<>11
  OR EXISTS(SELECT 1 FROM native_staff_management_fences f WHERE f.command_id=NEW.command_id)
  OR EXISTS(SELECT 1 FROM native_staff_management_commands c WHERE c.command_id=NEW.command_id)
)
BEGIN SELECT RAISE(ABORT,'onboarding creation fence shape is invalid'); END;

CREATE TRIGGER native_staff_onboarding_create_actor BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create' AND NOT EXISTS (
  SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id
  WHERE a.staff_id=NEW.actor_staff_id AND a.active=1 AND a.bound_access_subject=NEW.actor_access_subject
)
BEGIN SELECT RAISE(ABORT,'onboarding creation actor is unavailable'); END;

-- Every prospective membership needs both create and membership-manage authority.
CREATE TRIGGER native_staff_onboarding_create_membership_allow BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create' AND EXISTS (
  SELECT 1 FROM json_each(NEW.result_json,'$.proposal.memberships') member
  WHERE EXISTS (
    SELECT 1 FROM (SELECT 'staff.onboarding.create' capability UNION ALL SELECT 'staff.membership.manage') required
    WHERE NOT EXISTS (
      SELECT 1 FROM native_staff_management_delegations d
      WHERE d.actor_staff_id=NEW.actor_staff_id AND d.active=1 AND d.effect='allow'
        AND d.capability=required.capability AND
        (d.scope_kind='global' OR
          (d.scope_kind='business_area' AND d.business_area_id=json_extract(member.value,'$.businessAreaId')) OR
          (d.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
            AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
            AND d.division_id=json_extract(member.value,'$.divisionId')))
    )
  )
)
BEGIN SELECT RAISE(ABORT,'onboarding creation membership authority is unavailable'); END;

CREATE TRIGGER native_staff_onboarding_create_empty_memberships BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create'
  AND json_array_length(NEW.result_json,'$.proposal.memberships')=0
  AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d
    WHERE d.actor_staff_id=NEW.actor_staff_id AND d.active=1 AND d.effect='allow'
      AND d.capability='staff.onboarding.create' AND d.scope_kind='global')
BEGIN SELECT RAISE(ABORT,'onboarding creation requires global authority'); END;

CREATE TRIGGER native_staff_onboarding_create_membership_deny BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create' AND EXISTS (
  SELECT 1 FROM native_staff_management_delegations d
  WHERE d.actor_staff_id=NEW.actor_staff_id AND d.active=1 AND d.effect='deny'
    AND d.capability IN ('staff.onboarding.create','staff.membership.manage')
    AND (d.scope_kind='global' OR EXISTS (
      SELECT 1 FROM json_each(NEW.result_json,'$.proposal.memberships') member
      WHERE (d.scope_kind='business_area' AND d.business_area_id=json_extract(member.value,'$.businessAreaId'))
        OR (d.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
          AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
          AND d.division_id=json_extract(member.value,'$.divisionId'))))
)
BEGIN SELECT RAISE(ABORT,'onboarding creation is denied'); END;

CREATE TRIGGER native_staff_onboarding_create_parents BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create' AND EXISTS (
  SELECT 1 FROM json_each(NEW.result_json,'$.proposal.memberships') member
  LEFT JOIN native_business_areas a ON a.id=json_extract(member.value,'$.businessAreaId')
  LEFT JOIN native_business_divisions d ON d.id=json_extract(member.value,'$.divisionId')
    AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
  WHERE coalesce(a.active,0)<>1 OR
    (json_extract(member.value,'$.scopeKind')='division' AND coalesce(d.active,0)<>1)
)
BEGIN SELECT RAISE(ABORT,'onboarding creation parent is unavailable'); END;

-- The pending row is meaningful only when paired with the exact, unconsumed fence.
CREATE TRIGGER native_staff_onboarding_create_pending_guard BEFORE INSERT ON native_staff_pending_onboarding
WHEN NOT EXISTS(SELECT 1 FROM native_staff_management_fences f
  WHERE f.capability='staff.onboarding.create' AND f.target_kind='onboarding'
    AND f.target_onboarding_id=NEW.onboarding_id AND f.target_proposed_staff_id=NEW.proposed_staff_id
    AND f.actor_staff_id=NEW.created_by_staff_id AND f.actor_access_subject=NEW.created_by_subject
    AND f.reason=NEW.reason AND f.expected_version=0 AND f.result_version=1 AND f.mutation_writes=1
    AND f.created_at=NEW.created_at
    AND json_extract(f.result_json,'$.proposalSha256')=NEW.proposal_sha256
    AND json_extract(f.result_json,'$.invitationSecretSha256')=NEW.invitation_secret_sha256
    AND json_extract(f.result_json,'$.loginEmail')=NEW.login_email
    AND json_extract(f.result_json,'$.displayName')=NEW.display_name
    AND json_extract(f.result_json,'$.expiresAt')=NEW.expires_at
    AND json_extract(f.result_json,'$.proposal')=NEW.proposal_json)
BEGIN SELECT RAISE(ABORT,'onboarding creation requires an exact command fence'); END;

CREATE TRIGGER native_staff_onboarding_create_consume AFTER INSERT ON native_staff_pending_onboarding
BEGIN
  UPDATE native_staff_management_fences SET mutation_writes=0
  WHERE capability='staff.onboarding.create' AND target_kind='onboarding'
    AND target_onboarding_id=NEW.onboarding_id AND target_proposed_staff_id=NEW.proposed_staff_id
    AND mutation_writes=1;
END;

CREATE TRIGGER native_staff_onboarding_create_fence_update BEFORE UPDATE ON native_staff_management_fences
WHEN OLD.target_kind='onboarding' AND OLD.capability='staff.onboarding.create' AND (
  NEW.command_id IS NOT OLD.command_id OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.contract_version IS NOT OLD.contract_version OR NEW.capability IS NOT OLD.capability
  OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject
  OR NEW.target_kind IS NOT OLD.target_kind OR NEW.target_onboarding_id IS NOT OLD.target_onboarding_id
  OR NEW.target_proposed_staff_id IS NOT OLD.target_proposed_staff_id OR NEW.target_staff_id IS NOT OLD.target_staff_id
  OR NEW.expected_version IS NOT OLD.expected_version OR NEW.result_version IS NOT OLD.result_version
  OR NEW.reason IS NOT OLD.reason OR NEW.display_name IS NOT OLD.display_name
  OR NEW.result_json IS NOT OLD.result_json OR NEW.result_sha256 IS NOT OLD.result_sha256
  OR NEW.created_at IS NOT OLD.created_at OR OLD.mutation_writes<>1 OR NEW.mutation_writes<>0
  OR NOT EXISTS(SELECT 1 FROM native_staff_pending_onboarding p
    WHERE p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
      AND p.state='pending' AND p.version=1 AND p.proposal_sha256=json_extract(NEW.result_json,'$.proposalSha256'))
)
BEGIN SELECT RAISE(ABORT,'onboarding creation fence transition is invalid'); END;

CREATE TRIGGER native_staff_onboarding_create_receipt BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create' AND NOT EXISTS(
  SELECT 1 FROM native_staff_management_fences f JOIN native_staff_pending_onboarding p
    ON p.onboarding_id=f.target_onboarding_id AND p.proposed_staff_id=f.target_proposed_staff_id
  WHERE f.command_id=NEW.command_id AND f.capability=NEW.capability AND f.mutation_writes=0
    AND f.request_sha256=NEW.request_sha256 AND f.contract_version=NEW.contract_version
    AND f.actor_staff_id=NEW.actor_staff_id AND f.actor_access_subject=NEW.actor_access_subject
    AND f.expected_version=NEW.expected_version AND f.result_version=NEW.result_version
    AND f.reason=NEW.reason AND f.display_name IS NEW.display_name
    AND f.result_json=NEW.result_json AND f.result_sha256=NEW.result_sha256
    AND p.onboarding_id=NEW.target_onboarding_id AND p.proposed_staff_id=NEW.target_proposed_staff_id
    AND p.state='pending' AND p.version=1 AND p.created_at=f.created_at
    AND p.proposal_sha256=json_extract(NEW.result_json,'$.proposalSha256')
)
BEGIN SELECT RAISE(ABORT,'onboarding creation receipt is invalid'); END;

-- 0071 consumes the transient fence when it inserts a receipt. Both phases
-- project the same immutable envelope for current-authorization replay.
CREATE VIEW native_staff_onboarding_create_records AS
SELECT command_id,actor_staff_id,actor_access_subject,target_kind,capability,target_proposed_staff_id,result_json
FROM native_staff_management_fences WHERE capability='staff.onboarding.create'
UNION ALL
SELECT command_id,actor_staff_id,actor_access_subject,target_kind,capability,target_proposed_staff_id,result_json
FROM native_staff_management_commands WHERE capability='staff.onboarding.create';

CREATE VIEW native_staff_onboarding_create_proposed_grants AS
SELECT f.command_id, f.actor_staff_id, f.target_proposed_staff_id,
  'directory' AS authority_domain, 'staff.directory_grant.manage' AS management_capability,
  json_extract(g.value,'$.permission') AS capability, json_extract(g.value,'$.effect') AS grant_effect,
  json_extract(g.value,'$.scopeKind') AS scope_kind,
  json_extract(g.value,'$.businessAreaId') AS business_area_id,
  json_extract(g.value,'$.divisionId') AS division_id,
  json_extract(g.value,'$.resourceId') AS resource_id,
  NULL AS target_staff_id
FROM native_staff_onboarding_create_records f, json_each(f.result_json,'$.proposal.directoryGrants') g
WHERE f.capability='staff.onboarding.create' AND f.target_kind='onboarding'
UNION ALL
SELECT f.command_id, f.actor_staff_id, f.target_proposed_staff_id,
  'staff_admin', 'staff.admin_delegation.manage',
  json_extract(g.value,'$.capability'), json_extract(g.value,'$.effect'),
  json_extract(g.value,'$.scopeKind'), json_extract(g.value,'$.businessAreaId'),
  json_extract(g.value,'$.divisionId'), NULL, json_extract(g.value,'$.targetStaffId')
FROM native_staff_onboarding_create_records f, json_each(f.result_json,'$.proposal.managementGrants') g
WHERE f.capability='staff.onboarding.create' AND f.target_kind='onboarding';

-- A manager of a proposed grant must have target-management authority over every
-- proposed membership; the empty target requires an explicit global allow.
CREATE VIEW native_staff_onboarding_create_grant_target_failures AS
SELECT g.command_id FROM native_staff_onboarding_create_proposed_grants g
JOIN native_staff_onboarding_create_records f ON f.command_id=g.command_id
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
CREATE VIEW native_staff_onboarding_create_grant_ceiling_failures AS
SELECT g.command_id FROM native_staff_onboarding_create_proposed_grants g
JOIN native_staff_onboarding_create_records f ON f.command_id=g.command_id
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

CREATE VIEW native_staff_onboarding_create_membership_failures AS
SELECT f.command_id FROM native_staff_onboarding_create_records f
WHERE f.target_kind='onboarding' AND f.capability='staff.onboarding.create' AND (
  (json_array_length(f.result_json,'$.proposal.memberships')=0 AND NOT EXISTS(
    SELECT 1 FROM native_staff_management_delegations d
    WHERE d.actor_staff_id=f.actor_staff_id AND d.active=1 AND d.effect='allow'
      AND d.capability='staff.onboarding.create' AND d.scope_kind='global'))
  OR EXISTS(SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
    WHERE EXISTS(SELECT 1 FROM (SELECT 'staff.onboarding.create' capability UNION ALL SELECT 'staff.membership.manage') required
      WHERE NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d
        WHERE d.actor_staff_id=f.actor_staff_id AND d.active=1 AND d.effect='allow'
          AND d.capability=required.capability AND (d.scope_kind='global'
            OR (d.scope_kind='business_area' AND d.business_area_id=json_extract(member.value,'$.businessAreaId'))
            OR (d.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
              AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
              AND d.division_id=json_extract(member.value,'$.divisionId'))))))
  OR EXISTS(SELECT 1 FROM native_staff_management_delegations d
    WHERE d.actor_staff_id=f.actor_staff_id AND d.active=1 AND d.effect='deny'
      AND d.capability IN ('staff.onboarding.create','staff.membership.manage')
      AND (d.scope_kind='global' OR EXISTS(SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
        WHERE (d.scope_kind='business_area' AND d.business_area_id=json_extract(member.value,'$.businessAreaId'))
          OR (d.scope_kind='division' AND json_extract(member.value,'$.scopeKind')='division'
            AND d.business_area_id=json_extract(member.value,'$.businessAreaId')
            AND d.division_id=json_extract(member.value,'$.divisionId')))))
);

-- A+B recipients cannot borrow A's ceiling while relying on a ceiling-less
-- management delegation for B. Each prospective membership needs a matching
-- effective ceiling-backed parent for each proposed grant.
CREATE VIEW native_staff_onboarding_create_uncovered_grant_memberships AS
SELECT g.command_id FROM native_staff_onboarding_create_proposed_grants g
JOIN native_staff_onboarding_create_records f ON f.command_id=g.command_id
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

CREATE VIEW native_staff_onboarding_create_authority AS
SELECT f.command_id FROM native_staff_onboarding_create_records f
JOIN native_staff_admissions a ON a.staff_id=f.actor_staff_id
JOIN native_staff_profiles profile ON profile.staff_id=a.staff_id
WHERE f.target_kind='onboarding' AND f.capability='staff.onboarding.create'
  AND a.active=1 AND a.bound_access_subject=f.actor_access_subject
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_create_membership_failures fail
    WHERE fail.command_id=f.command_id)
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_create_grant_target_failures fail
    WHERE fail.command_id=f.command_id)
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_create_grant_ceiling_failures fail
    WHERE fail.command_id=f.command_id)
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_create_uncovered_grant_memberships fail
    WHERE fail.command_id=f.command_id)
  AND NOT EXISTS(SELECT 1 FROM json_each(f.result_json,'$.proposal.memberships') member
    LEFT JOIN native_business_areas area ON area.id=json_extract(member.value,'$.businessAreaId')
    LEFT JOIN native_business_divisions division ON division.id=json_extract(member.value,'$.divisionId')
      AND division.business_area_id=json_extract(member.value,'$.businessAreaId')
    WHERE coalesce(area.active,0)<>1 OR
      (json_extract(member.value,'$.scopeKind')='division' AND coalesce(division.active,0)<>1));

CREATE TRIGGER native_staff_onboarding_create_fence_authority AFTER INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create'
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_create_authority a WHERE a.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'onboarding creation authority or ceiling is unavailable'); END;

CREATE TRIGGER native_staff_onboarding_create_receipt_authority BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.create'
  AND NOT EXISTS(SELECT 1 FROM native_staff_onboarding_create_authority a WHERE a.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'onboarding creation authority or ceiling changed'); END;

DROP TRIGGER native_staff_onboarding_cancel_fence_update;
CREATE TRIGGER native_staff_onboarding_cancel_fence_update BEFORE UPDATE ON native_staff_management_fences
WHEN OLD.target_kind='onboarding' AND OLD.capability='staff.onboarding.cancel' AND (
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

DROP TRIGGER native_staff_onboarding_cancel_fence_insert;
CREATE TRIGGER native_staff_onboarding_cancel_fence_insert BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND (
  EXISTS(SELECT 1 FROM native_staff_management_fences fence WHERE fence.command_id=NEW.command_id)
  OR EXISTS(SELECT 1 FROM native_staff_management_commands receipt WHERE receipt.command_id=NEW.command_id)
)
BEGIN SELECT RAISE(ABORT,'onboarding cancellation command identity already exists'); END;

DROP TRIGGER native_staff_onboarding_cancel_fence_prestate;
CREATE TRIGGER native_staff_onboarding_cancel_fence_prestate BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND NOT EXISTS (
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

DROP TRIGGER native_staff_onboarding_cancel_receipt;
CREATE TRIGGER native_staff_onboarding_cancel_receipt BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND NOT EXISTS (
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

DROP TRIGGER native_staff_onboarding_cancel_fence_actor_allow;
CREATE TRIGGER native_staff_onboarding_cancel_fence_actor_allow BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND NOT EXISTS (
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

DROP TRIGGER native_staff_onboarding_cancel_fence_deny;
CREATE TRIGGER native_staff_onboarding_cancel_fence_deny BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND EXISTS (
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

DROP TRIGGER native_staff_onboarding_cancel_fence_parents;
CREATE TRIGGER native_staff_onboarding_cancel_fence_parents BEFORE INSERT ON native_staff_management_fences
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND EXISTS (
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

DROP TRIGGER native_staff_onboarding_cancel_receipt_actor_allow;
CREATE TRIGGER native_staff_onboarding_cancel_receipt_actor_allow BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND NOT EXISTS (
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

DROP TRIGGER native_staff_onboarding_cancel_receipt_deny;
CREATE TRIGGER native_staff_onboarding_cancel_receipt_deny BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND EXISTS (
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

DROP TRIGGER native_staff_onboarding_cancel_receipt_parents;
CREATE TRIGGER native_staff_onboarding_cancel_receipt_parents BEFORE INSERT ON native_staff_management_commands
WHEN NEW.target_kind='onboarding' AND NEW.capability='staff.onboarding.cancel' AND EXISTS (
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
