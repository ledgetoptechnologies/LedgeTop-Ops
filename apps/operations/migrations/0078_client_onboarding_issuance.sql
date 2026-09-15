PRAGMA foreign_keys = ON;

-- Only 0078-backed invitations can become live. Earlier staging rows remain
-- durable but cannot be submitted after the submission path adopts this view.
CREATE TABLE client_onboarding_issuance_commands (
  invitation_id TEXT NOT NULL PRIMARY KEY REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL UNIQUE CHECK(length(command_id)=36 AND length(replace(command_id,'-',''))=32
    AND command_id=lower(command_id) AND command_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(command_id,9,1)='-' AND substr(command_id,14,1)='-'
    AND substr(command_id,15,1)='4' AND substr(command_id,19,1)='-'
    AND substr(command_id,20,1) IN ('8','9','a','b') AND substr(command_id,24,1)='-'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- NULL means existing target: always reload its complete current D1 scope set.
  scopes_json TEXT CHECK(scopes_json IS NULL OR
    (length(scopes_json) BETWEEN 2 AND 8192 AND json_valid(scopes_json)
      AND json_type(scopes_json)='array' AND json_array_length(scopes_json) BETWEEN 1 AND 128)),
  issuer_admission_version INTEGER NOT NULL CHECK(typeof(issuer_admission_version)='integer' AND issuer_admission_version>=1),
  issuer_profile_version INTEGER NOT NULL CHECK(typeof(issuer_profile_version)='integer' AND issuer_profile_version>=1),
  issuer_email TEXT NOT NULL CHECK(length(issuer_email) BETWEEN 3 AND 254),
  verified_until TEXT NOT NULL CHECK(length(verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_until) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_until)=verified_until),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);

-- Current authority only; the JWT deadline gates issuance, not the lifetime of
-- an already-issued invitation. Admission/profile version pins make a disable /
-- re-enable cycle or profile mutation require a new invitation.
CREATE VIEW client_onboarding_live_issuances AS
SELECT invitation.invitation_id
FROM client_onboarding_invitations invitation
JOIN client_onboarding_issuance_commands command ON command.invitation_id=invitation.invitation_id
JOIN native_staff_admissions admission ON admission.staff_id=invitation.issued_by
  AND admission.active=1 AND admission.bound_access_subject=invitation.bound_access_subject
  AND admission.version=command.issuer_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=invitation.issued_by
  AND profile.version=command.issuer_profile_version AND profile.login_email=command.issuer_email
WHERE ((invitation.state='pending' AND invitation.version=1)
    OR (invitation.state='submitted' AND invitation.version=2))
  AND invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND (
    (invitation.target_client_record_id IS NULL AND command.scopes_json IS NOT NULL
      AND json_array_length(command.scopes_json) BETWEEN 1 AND 128
      AND NOT EXISTS(SELECT 1 FROM json_each(command.scopes_json) proposed
        LEFT JOIN native_business_areas area ON area.id=json_extract(proposed.value,'$.businessAreaId') AND area.active=1
        LEFT JOIN native_business_divisions division ON division.id=json_extract(proposed.value,'$.divisionId')
          AND division.business_area_id=json_extract(proposed.value,'$.businessAreaId') AND division.active=1
        WHERE json_type(proposed.value)<>'object'
          OR coalesce(json_type(proposed.value,'$.businessAreaId'),'missing')<>'text'
          OR coalesce(json_type(proposed.value,'$.divisionId'),'missing') NOT IN ('text','null')
          OR (SELECT count(*) FROM json_each(proposed.value))<>2
          OR area.id IS NULL OR (json_type(proposed.value,'$.divisionId')='text' AND division.id IS NULL))
      AND (SELECT count(*) FROM json_each(command.scopes_json))=(SELECT count(*) FROM (
        SELECT json_extract(value,'$.businessAreaId') area_id,json_extract(value,'$.divisionId') division_id
        FROM json_each(command.scopes_json) GROUP BY 1,2))
      -- Unlike the canonical write fence, admission ISSUANCE covers every proposed scope.
      AND NOT EXISTS(SELECT 1 FROM json_each(command.scopes_json) proposed
        WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants allow_grant
          WHERE allow_grant.staff_id=invitation.issued_by AND allow_grant.permission='directory.profile.edit'
            AND allow_grant.effect='allow' AND allow_grant.active=1
            AND (allow_grant.scope_kind='global'
              OR (allow_grant.scope_kind='business_area'
                AND allow_grant.business_area_id=json_extract(proposed.value,'$.businessAreaId'))
              OR (allow_grant.scope_kind='division'
                AND allow_grant.division_id=json_extract(proposed.value,'$.divisionId')))))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_grant
        WHERE deny_grant.staff_id=invitation.issued_by AND deny_grant.permission='directory.profile.edit'
          AND deny_grant.effect='deny' AND deny_grant.active=1
          AND (deny_grant.scope_kind='global'
            OR (deny_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(command.scopes_json) proposed
              WHERE json_extract(proposed.value,'$.businessAreaId')=deny_grant.business_area_id))
            OR (deny_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(command.scopes_json) proposed
              WHERE json_extract(proposed.value,'$.divisionId')=deny_grant.division_id)))))
    OR
    (invitation.target_client_record_id IS NOT NULL AND command.scopes_json IS NULL
      AND EXISTS(SELECT 1 FROM operations_directory_records record
        WHERE record.record_id=invitation.target_client_record_id AND record.record_kind='client')
      AND (SELECT count(*) FROM native_directory_resource_scopes scope
        WHERE scope.record_id=invitation.target_client_record_id AND scope.active=1) BETWEEN 1 AND 128
      AND NOT EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        LEFT JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
        LEFT JOIN native_business_divisions division ON division.id=scope.division_id
          AND division.business_area_id=scope.business_area_id AND division.active=1
        WHERE scope.record_id=invitation.target_client_record_id AND scope.active=1
          AND (area.id IS NULL OR (scope.division_id IS NOT NULL AND division.id IS NULL)))
      AND EXISTS(SELECT 1 FROM native_directory_grants allow_grant
        WHERE allow_grant.staff_id=invitation.issued_by AND allow_grant.permission='directory.profile.edit'
          AND allow_grant.effect='allow' AND allow_grant.active=1
          AND (allow_grant.scope_kind='global'
            OR (allow_grant.scope_kind='resource' AND allow_grant.resource_id=invitation.target_client_record_id)
            OR (allow_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=invitation.target_client_record_id
                AND assignment.staff_id=invitation.issued_by AND assignment.active=1))
            OR (allow_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=invitation.target_client_record_id AND scope.active=1
                AND scope.business_area_id=allow_grant.business_area_id))
            OR (allow_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=invitation.target_client_record_id AND scope.active=1
                AND scope.division_id=allow_grant.division_id))))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_grant
        WHERE deny_grant.staff_id=invitation.issued_by AND deny_grant.permission='directory.profile.edit'
          AND deny_grant.effect='deny' AND deny_grant.active=1
          AND (deny_grant.scope_kind='global'
            OR (deny_grant.scope_kind='resource' AND deny_grant.resource_id=invitation.target_client_record_id)
            OR (deny_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=invitation.target_client_record_id
                AND assignment.staff_id=invitation.issued_by AND assignment.active=1))
            OR (deny_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=invitation.target_client_record_id AND scope.active=1
                AND scope.business_area_id=deny_grant.business_area_id))
            OR (deny_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=invitation.target_client_record_id AND scope.active=1
                AND scope.division_id=deny_grant.division_id)))))
  );

CREATE TRIGGER client_onboarding_issuance_commands_insert_guard
BEFORE INSERT ON client_onboarding_issuance_commands
WHEN EXISTS(SELECT 1 FROM client_onboarding_issuance_commands prior
    WHERE prior.invitation_id=NEW.invitation_id OR prior.command_id=NEW.command_id)
  OR NOT EXISTS(SELECT 1 FROM client_onboarding_invitations invitation
    JOIN native_staff_admissions admission ON admission.staff_id=invitation.issued_by
    JOIN native_staff_profiles profile ON profile.staff_id=invitation.issued_by
    WHERE invitation.invitation_id=NEW.invitation_id AND invitation.state='pending' AND invitation.version=1
      AND invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND admission.active=1 AND admission.bound_access_subject=invitation.bound_access_subject
      AND admission.version=NEW.issuer_admission_version
      AND profile.version=NEW.issuer_profile_version AND profile.login_email=NEW.issuer_email)
  OR NEW.verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
BEGIN SELECT RAISE(ABORT,'client onboarding issuance denied'); END;
CREATE TRIGGER client_onboarding_issuance_commands_authority
AFTER INSERT ON client_onboarding_issuance_commands
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_issuances live
  WHERE live.invitation_id=NEW.invitation_id)
BEGIN SELECT RAISE(ABORT,'client onboarding issuance denied'); END;
CREATE TRIGGER client_onboarding_issuance_commands_no_update BEFORE UPDATE ON client_onboarding_issuance_commands
BEGIN SELECT RAISE(ABORT,'client onboarding issuance history is immutable'); END;
CREATE TRIGGER client_onboarding_issuance_commands_no_delete BEFORE DELETE ON client_onboarding_issuance_commands
BEGIN SELECT RAISE(ABORT,'client onboarding issuance history is durable'); END;

-- The submitted-data path must not be bypassable by direct SQL. 0077's own
-- pending/expiry guard and immutable submission trigger remain in force.
CREATE TRIGGER client_onboarding_submissions_issuance_authority BEFORE INSERT ON client_onboarding_submissions
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_issuances live
  WHERE live.invitation_id=NEW.invitation_id)
BEGIN SELECT RAISE(ABORT,'client onboarding submission requires current issuer authority'); END;
