PRAGMA foreign_keys = ON;

-- Default-off, durable authorization evidence for a future recipient prefill
-- completion.  This is intentionally not a disclosure: it contains neither
-- recipient material nor profile data and grants no bearer access by itself.
CREATE TABLE client_onboarding_prefill_authorization_intents (
  intent_id TEXT NOT NULL PRIMARY KEY CHECK(length(intent_id)=36 AND length(replace(intent_id,'-',''))=32
    AND intent_id=lower(intent_id) AND intent_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(intent_id,9,1)='-' AND substr(intent_id,14,1)='-' AND substr(intent_id,15,1)='4'
    AND substr(intent_id,19,1)='-' AND substr(intent_id,20,1) IN ('8','9','a','b') AND substr(intent_id,24,1)='-'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  invitation_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  target_client_record_version INTEGER NOT NULL CHECK(typeof(target_client_record_version)='integer' AND target_client_record_version>=1),
  include_organization INTEGER NOT NULL CHECK(include_organization IN (0,1)),
  organization_relationship_version INTEGER CHECK(organization_relationship_version IS NULL OR (typeof(organization_relationship_version)='integer' AND organization_relationship_version>=1)),
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  organization_record_version INTEGER CHECK(organization_record_version IS NULL OR (typeof(organization_record_version)='integer' AND organization_record_version>=1)),
  authorized_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL CHECK(length(authorized_access_subject) BETWEEN 1 AND 191 AND authorized_access_subject=trim(authorized_access_subject) AND instr(authorized_access_subject,char(0))=0),
  authorized_admission_version INTEGER NOT NULL CHECK(typeof(authorized_admission_version)='integer' AND authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(typeof(authorized_profile_version)='integer' AND authorized_profile_version>=1),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK((include_organization=0 AND organization_relationship_version IS NULL AND organization_record_id IS NULL AND organization_record_version IS NULL)
    OR (include_organization=1 AND organization_relationship_version IS NOT NULL AND organization_record_id IS NOT NULL AND organization_record_version IS NOT NULL))
);
CREATE INDEX client_onboarding_prefill_authorization_intents_active
  ON client_onboarding_prefill_authorization_intents(invitation_id,expires_at);

CREATE TRIGGER client_onboarding_prefill_authorization_intents_insert_guard
BEFORE INSERT ON client_onboarding_prefill_authorization_intents
WHEN NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')
  OR NOT EXISTS(
    WITH authorized_resources(record_id,record_kind,record_version) AS (
      SELECT NEW.target_client_record_id,'client',NEW.target_client_record_version
      UNION ALL SELECT NEW.organization_record_id,'organization',NEW.organization_record_version WHERE NEW.include_organization=1
    )
    SELECT 1 FROM client_onboarding_invitations invitation
    JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
    JOIN native_staff_admissions admission ON admission.staff_id=NEW.authorized_by_staff_id AND admission.active=1
      AND admission.bound_access_subject=NEW.authorized_access_subject AND admission.version=NEW.authorized_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=NEW.authorized_by_staff_id AND profile.version=NEW.authorized_profile_version
    LEFT JOIN operations_directory_client_organizations relation ON relation.client_record_id=NEW.target_client_record_id
    WHERE invitation.invitation_id=NEW.invitation_id AND invitation.issued_by=NEW.authorized_by_staff_id
      AND invitation.bound_access_subject=NEW.authorized_access_subject AND invitation.target_client_record_id=NEW.target_client_record_id
      AND invitation.state='pending' AND invitation.version=1 AND invitation.expires_at>=NEW.expires_at
      AND ((NEW.include_organization=0) OR (relation.relationship_version=NEW.organization_relationship_version AND relation.organization_record_id=NEW.organization_record_id))
      AND NOT EXISTS(SELECT 1 FROM authorized_resources resource
        LEFT JOIN operations_directory_records record ON record.record_id=resource.record_id
        LEFT JOIN operations_directory_revisions revision ON revision.record_id=resource.record_id AND revision.version=resource.record_version
        WHERE record.record_id IS NULL OR record.record_kind<>resource.record_kind OR record.current_version<>resource.record_version OR revision.record_id IS NULL
          OR EXISTS(SELECT 1 FROM native_directory_resource_scopes scope LEFT JOIN native_business_areas area ON area.id=scope.business_area_id LEFT JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id WHERE scope.record_id=resource.record_id AND scope.active=1 AND (coalesce(area.active,0)<>1 OR (scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
          OR NOT EXISTS(SELECT 1 FROM native_directory_grants allow_row WHERE allow_row.staff_id=NEW.authorized_by_staff_id AND allow_row.permission='directory.profile.view' AND allow_row.effect='allow' AND allow_row.active=1 AND (allow_row.scope_kind='global' OR (allow_row.scope_kind='resource' AND allow_row.resource_id=resource.record_id) OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=resource.record_id AND a.staff_id=NEW.authorized_by_staff_id AND a.active=1)) OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=resource.record_id AND s.active=1 AND s.business_area_id=allow_row.business_area_id)) OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=resource.record_id AND s.active=1 AND s.division_id=allow_row.division_id))))
          OR EXISTS(SELECT 1 FROM native_directory_grants deny_row WHERE deny_row.staff_id=NEW.authorized_by_staff_id AND deny_row.permission='directory.profile.view' AND deny_row.effect='deny' AND deny_row.active=1 AND (deny_row.scope_kind='global' OR (deny_row.scope_kind='resource' AND deny_row.resource_id=resource.record_id) OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=resource.record_id AND a.staff_id=NEW.authorized_by_staff_id AND a.active=1)) OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=resource.record_id AND s.active=1 AND s.business_area_id=deny_row.business_area_id)) OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=resource.record_id AND s.active=1 AND s.division_id=deny_row.division_id))))
      )
  )
BEGIN SELECT RAISE(ABORT,'client onboarding prefill authorization intent requires current explicit authority and pins'); END;
CREATE TRIGGER client_onboarding_prefill_authorization_intents_no_update BEFORE UPDATE ON client_onboarding_prefill_authorization_intents
BEGIN SELECT RAISE(ABORT,'client onboarding prefill authorization intent is immutable'); END;
CREATE TRIGGER client_onboarding_prefill_authorization_intents_no_delete BEFORE DELETE ON client_onboarding_prefill_authorization_intents
BEGIN SELECT RAISE(ABORT,'client onboarding prefill authorization intents are durable'); END;
