PRAGMA foreign_keys = ON;

-- Advisory current-state projection for future in-transaction last-control-plane
-- predicates. Callers must still compare their verified Access subject with the
-- returned bound subject in the same authoritative transaction.
CREATE VIEW native_staff_control_plane_candidates AS
WITH required_actions(capability) AS (
  VALUES ('staff.onboarding.create'),
    ('staff.onboarding.approve'),
    ('staff.admission.disable'),
    ('staff.membership.manage'),
    ('staff.directory_grant.manage'),
    ('staff.admin_delegation.manage')
),
required_ceiling_capabilities(authority_domain,capability) AS (
  VALUES ('directory','directory.profile.view'),
    ('directory','directory.profile.edit'),
    ('directory','directory.identity.link'),
    ('directory','directory.enrollment.manage'),
    ('directory','directory.portal_access.manage'),
    ('staff_admin','staff.onboarding.create'),
    ('staff_admin','staff.onboarding.approve'),
    ('staff_admin','staff.admission.disable'),
    ('staff_admin','staff.membership.manage'),
    ('staff_admin','staff.directory_grant.manage'),
    ('staff_admin','staff.admin_delegation.manage')
),
required_effects(effect) AS (VALUES ('allow'), ('deny')),
required_operations(operation) AS (VALUES ('create'), ('revoke')),
required_ceiling_tuples AS (
  SELECT capability.authority_domain,capability.capability,effect.effect,operation.operation
  FROM required_ceiling_capabilities capability
  CROSS JOIN required_effects effect
  CROSS JOIN required_operations operation
)
SELECT admission.staff_id,
  admission.bound_access_subject,
  admission.version admission_version,
  profile.version profile_version
FROM native_staff_admissions admission
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
WHERE admission.active=1
  AND typeof(admission.bound_access_subject)='text'
  AND length(admission.bound_access_subject) BETWEEN 1 AND 191
  AND length(trim(admission.bound_access_subject))>0
  AND instr(admission.bound_access_subject,char(0))=0
  AND length(profile.login_email) BETWEEN 3 AND 254
  AND profile.login_email=lower(profile.login_email) COLLATE BINARY
  AND profile.login_email=trim(profile.login_email)
  AND instr(profile.login_email,char(0))=0
  AND instr(profile.login_email,'@')>1
  AND length(profile.display_name) BETWEEN 1 AND 160
  AND length(trim(profile.display_name)) BETWEEN 1 AND 160
  AND instr(profile.display_name,char(0))=0
  AND NOT EXISTS (
    SELECT 1 FROM native_staff_target_memberships membership
    LEFT JOIN native_business_areas area ON area.id=membership.business_area_id
    LEFT JOIN native_business_divisions division
      ON division.id=membership.division_id AND division.business_area_id=membership.business_area_id
    WHERE membership.staff_id=admission.staff_id AND membership.active=1
      AND (coalesce(area.active,0)<>1
        OR (membership.scope_kind='business_area' AND membership.division_id IS NOT NULL)
        OR (membership.scope_kind='division' AND (membership.division_id IS NULL OR coalesce(division.active,0)<>1)))
  )
  AND NOT EXISTS (
    SELECT 1 FROM required_actions required
    WHERE NOT EXISTS (
      SELECT 1 FROM native_staff_management_delegations delegation
      WHERE delegation.actor_staff_id=admission.staff_id AND delegation.contract_version=1
        AND delegation.capability=required.capability AND delegation.effect='allow'
        AND delegation.scope_kind='global' AND delegation.active=1
    ) AND NOT EXISTS (
      SELECT 1 FROM native_staff_admin_delegations legacy
      WHERE legacy.actor_staff_id=admission.staff_id AND legacy.action=required.capability
        AND legacy.effect='allow' AND legacy.scope_kind='global' AND legacy.active=1
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM required_actions required
    WHERE EXISTS (
      SELECT 1 FROM native_staff_management_delegations delegation
      WHERE delegation.actor_staff_id=admission.staff_id AND delegation.contract_version=1
        AND delegation.capability=required.capability AND delegation.effect='deny' AND delegation.active=1
    ) OR EXISTS (
      SELECT 1 FROM native_staff_admin_delegations legacy
      WHERE legacy.actor_staff_id=admission.staff_id AND legacy.action=required.capability
        AND legacy.effect='deny' AND legacy.active=1
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM required_ceiling_tuples required
    WHERE NOT EXISTS (
      SELECT 1 FROM native_staff_delegation_ceilings ceiling
      JOIN native_staff_management_delegations parent ON parent.id=ceiling.parent_delegation_id
      WHERE parent.actor_staff_id=admission.staff_id AND parent.contract_version=1
        AND parent.capability=CASE required.authority_domain
          WHEN 'directory' THEN 'staff.directory_grant.manage'
          ELSE 'staff.admin_delegation.manage' END
        AND parent.effect='allow' AND parent.scope_kind='global' AND parent.active=1
        AND ceiling.contract_version=1 AND ceiling.authority_domain=required.authority_domain
        AND ceiling.capability=required.capability AND ceiling.effect='allow'
        AND ceiling.scope_kind='global' AND ceiling.active=1
        AND CASE required.effect WHEN 'allow' THEN ceiling.grant_allow ELSE ceiling.grant_deny END=1
        AND CASE required.operation WHEN 'create' THEN ceiling.operation_create ELSE ceiling.operation_revoke END=1
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM native_staff_delegation_ceilings ceiling
    JOIN native_staff_management_delegations parent ON parent.id=ceiling.parent_delegation_id
    JOIN required_ceiling_capabilities required
      ON required.authority_domain=ceiling.authority_domain AND required.capability=ceiling.capability
    WHERE parent.actor_staff_id=admission.staff_id AND parent.contract_version=1
      AND parent.capability=CASE ceiling.authority_domain
        WHEN 'directory' THEN 'staff.directory_grant.manage'
        ELSE 'staff.admin_delegation.manage' END
      AND parent.effect='allow' AND parent.active=1
      AND ceiling.contract_version=1 AND ceiling.effect='deny' AND ceiling.active=1
  );
