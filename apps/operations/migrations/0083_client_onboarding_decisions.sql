PRAGMA foreign_keys = ON;

-- A decision is distinct from the immutable recipient submission and from
-- invitation bearer revocation. The fence exists only inside its D1 batch.
CREATE TABLE client_onboarding_decision_fences (
  decision_id TEXT NOT NULL PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_submissions(submission_id) ON DELETE RESTRICT,
  fields_sha256 TEXT NOT NULL,
  expected_invitation_version INTEGER NOT NULL CHECK(expected_invitation_version=2),
  request_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('approved','rejected')),
  reviewer_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  reviewer_subject TEXT NOT NULL,
  reviewer_email TEXT NOT NULL,
  reviewer_admission_version INTEGER NOT NULL,
  reviewer_profile_version INTEGER NOT NULL,
  verified_until TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1024),
  reviewed_fields_json TEXT,
  scopes_json TEXT,
  client_target_kind TEXT CHECK(client_target_kind IN ('new','existing')),
  client_record_id TEXT,
  client_expected_version INTEGER,
  client_mutation_id TEXT,
  client_audit_id TEXT,
  client_create_admission_id TEXT,
  client_profile_json TEXT,
  client_destinations_json TEXT,
  organization_target_kind TEXT CHECK(organization_target_kind IN ('new','existing')),
  organization_record_id TEXT,
  organization_expected_version INTEGER,
  organization_mutation_id TEXT,
  organization_audit_id TEXT,
  organization_create_admission_id TEXT,
  organization_profile_json TEXT,
  organization_destinations_json TEXT,
  relationship_mutation_id TEXT,
  relationship_mode TEXT CHECK(relationship_mode IN ('change','preserve')),
  relationship_expected_version INTEGER,
  relationship_previous_organization_record_id TEXT,
  relationship_previous_organization_record_version INTEGER,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(length(decision_id)=36 AND length(replace(decision_id,'-',''))=32
    AND substr(decision_id,9,1)='-' AND substr(decision_id,14,1)='-'
    AND substr(decision_id,19,1)='-' AND substr(decision_id,24,1)='-'
    AND substr(decision_id,15,1)='4' AND substr(decision_id,20,1) GLOB '[89ab]'
    AND decision_id NOT GLOB '*[^0-9a-f-]*'),
  CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(fields_sha256)=64 AND fields_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(typeof(reviewer_admission_version)='integer' AND reviewer_admission_version>=1),
  CHECK(typeof(reviewer_profile_version)='integer' AND reviewer_profile_version>=1),
  CHECK(length(verified_until)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_until) IS verified_until),
  CHECK((outcome='rejected' AND reviewed_fields_json IS NULL AND scopes_json IS NULL
      AND client_target_kind IS NULL AND client_record_id IS NULL AND client_expected_version IS NULL
      AND client_mutation_id IS NULL AND client_audit_id IS NULL AND client_create_admission_id IS NULL
      AND client_profile_json IS NULL AND client_destinations_json IS NULL
      AND organization_target_kind IS NULL AND organization_record_id IS NULL AND organization_expected_version IS NULL
      AND organization_mutation_id IS NULL AND organization_audit_id IS NULL
      AND organization_create_admission_id IS NULL AND organization_profile_json IS NULL
      AND organization_destinations_json IS NULL AND relationship_mutation_id IS NULL
      AND relationship_mode IS NULL AND relationship_expected_version IS NULL
      AND relationship_previous_organization_record_id IS NULL
      AND relationship_previous_organization_record_version IS NULL)
    OR (outcome='approved' AND json_valid(reviewed_fields_json) AND json_valid(scopes_json)
      AND json_valid(client_profile_json) AND json_valid(client_destinations_json)
      AND client_target_kind IS NOT NULL AND client_record_id IS NOT NULL AND client_expected_version>=0
      AND client_mutation_id IS NOT NULL AND client_audit_id IS NOT NULL
      AND relationship_mutation_id IS NOT NULL AND relationship_mode IS NOT NULL
      AND relationship_expected_version>=0
      AND (relationship_mode='change' OR relationship_expected_version>=1)
      AND (relationship_mode='change' OR
        (organization_target_kind IS NULL AND relationship_previous_organization_record_id IS NULL
          AND relationship_previous_organization_record_version IS NULL)
        OR (organization_target_kind='existing'
          AND relationship_previous_organization_record_id=organization_record_id
          AND relationship_previous_organization_record_version=organization_expected_version))
      AND ((client_target_kind='new' AND client_expected_version=0
          AND client_create_admission_id='client-onboarding:'||decision_id||':client')
        OR (client_target_kind='existing' AND client_expected_version>=1 AND client_create_admission_id IS NULL))
      AND ((organization_target_kind IS NULL AND organization_record_id IS NULL AND organization_expected_version IS NULL
          AND organization_mutation_id IS NULL AND organization_audit_id IS NULL
          AND organization_create_admission_id IS NULL AND organization_profile_json IS NULL
          AND organization_destinations_json IS NULL)
        OR (organization_target_kind IS NOT NULL AND organization_record_id IS NOT NULL
          AND organization_expected_version>=0 AND organization_mutation_id IS NOT NULL
          AND organization_audit_id IS NOT NULL AND json_valid(organization_profile_json)
          AND json_valid(organization_destinations_json)
          AND ((organization_target_kind='new' AND organization_expected_version=0
              AND organization_create_admission_id='client-onboarding:'||decision_id||':organization')
            OR (organization_target_kind='existing' AND organization_expected_version>=1 AND organization_create_admission_id IS NULL))))))
);

CREATE TABLE client_onboarding_decisions (
  decision_id TEXT NOT NULL PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES client_onboarding_invitations(invitation_id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_submissions(submission_id) ON DELETE RESTRICT,
  fields_sha256 TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('approved','rejected')),
  reviewer_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  reviewer_subject TEXT NOT NULL,
  reviewer_email TEXT NOT NULL,
  original_admission_version INTEGER NOT NULL,
  original_profile_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reviewed_fields_json TEXT,
  client_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  client_record_version INTEGER,
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  organization_record_version INTEGER,
  relationship_version INTEGER,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  decided_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((outcome='rejected' AND reviewed_fields_json IS NULL AND client_record_id IS NULL
      AND client_record_version IS NULL AND organization_record_id IS NULL
      AND organization_record_version IS NULL AND relationship_version IS NULL)
    OR (outcome='approved' AND json_valid(reviewed_fields_json) AND client_record_id IS NOT NULL
      AND client_record_version>=1 AND relationship_version>=1
      AND (organization_record_id IS NULL)=(organization_record_version IS NULL)))
);

CREATE TRIGGER client_onboarding_decision_fence_insert_guard BEFORE INSERT ON client_onboarding_decision_fences
WHEN EXISTS(SELECT 1 FROM client_onboarding_decision_fences WHERE decision_id=NEW.decision_id OR submission_id=NEW.submission_id)
  OR EXISTS(SELECT 1 FROM client_onboarding_decisions WHERE decision_id=NEW.decision_id OR submission_id=NEW.submission_id)
  OR (NEW.outcome='approved' AND NEW.relationship_mode='preserve' AND NOT EXISTS(
    SELECT 1 FROM operations_directory_client_organizations relation
    LEFT JOIN operations_directory_records parent ON parent.record_id=relation.organization_record_id
    WHERE relation.client_record_id=NEW.client_record_id
      AND relation.relationship_version=NEW.relationship_expected_version
      AND relation.organization_record_id IS NEW.relationship_previous_organization_record_id
      AND (NEW.organization_record_id IS NULL OR
        (parent.current_version=NEW.relationship_previous_organization_record_version
          AND parent.current_version=NEW.organization_expected_version))))
  OR NOT EXISTS(SELECT 1 FROM client_onboarding_submissions submission
    JOIN client_onboarding_invitations invitation ON invitation.invitation_id=submission.invitation_id
    JOIN native_staff_admissions admission ON admission.staff_id=NEW.reviewer_staff_id
      AND admission.active=1 AND admission.bound_access_subject=NEW.reviewer_subject
      AND admission.version=NEW.reviewer_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=NEW.reviewer_staff_id
      AND profile.version=NEW.reviewer_profile_version AND profile.login_email=NEW.reviewer_email
    WHERE submission.submission_id=NEW.submission_id AND submission.invitation_id=NEW.invitation_id
      AND submission.fields_sha256=NEW.fields_sha256 AND invitation.state='submitted'
      AND invitation.version=NEW.expected_invitation_version
      AND NEW.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (NEW.outcome='rejected' OR (
        (invitation.target_client_record_id IS NULL AND NEW.client_target_kind='new'
          AND NEW.scopes_json IS (SELECT scopes_json FROM client_onboarding_issuance_commands
            WHERE invitation_id=NEW.invitation_id))
        OR (invitation.target_client_record_id=NEW.client_record_id AND NEW.client_target_kind='existing'
          AND NEW.scopes_json IS (SELECT json_group_array(json_object('businessAreaId',business_area_id,
              'divisionId',division_id)) FROM (SELECT business_area_id,division_id
              FROM native_directory_resource_scopes WHERE record_id=NEW.client_record_id AND active=1
              ORDER BY business_area_id,division_id))))))
BEGIN SELECT RAISE(ABORT,'client onboarding decision is unavailable'); END;
CREATE TRIGGER client_onboarding_decision_fence_no_update BEFORE UPDATE ON client_onboarding_decision_fences
BEGIN SELECT RAISE(ABORT,'client onboarding decision fence is immutable'); END;

-- For new targets the immutable issuance scope list is the full proposed
-- context. Existing targets use every current active native resource scope.
CREATE VIEW client_onboarding_decision_scope_targets AS
SELECT fence.decision_id,fence.client_record_id AS record_id,fence.client_target_kind AS target_kind,
  json_extract(scope.value,'$.businessAreaId') AS business_area_id,
  json_extract(scope.value,'$.divisionId') AS division_id
FROM client_onboarding_decision_fences fence,json_each(fence.scopes_json) scope
WHERE fence.outcome='approved' AND fence.client_target_kind='new'
UNION ALL
SELECT fence.decision_id,fence.client_record_id,'existing',scope.business_area_id,scope.division_id
FROM client_onboarding_decision_fences fence JOIN native_directory_resource_scopes scope
  ON scope.record_id=fence.client_record_id AND scope.active=1
WHERE fence.outcome='approved' AND fence.client_target_kind='existing'
UNION ALL
SELECT fence.decision_id,fence.organization_record_id,'new',
  json_extract(scope.value,'$.businessAreaId'),json_extract(scope.value,'$.divisionId')
FROM client_onboarding_decision_fences fence,json_each(fence.scopes_json) scope
WHERE fence.outcome='approved' AND fence.organization_target_kind='new'
UNION ALL
SELECT fence.decision_id,fence.organization_record_id,'existing',scope.business_area_id,scope.division_id
FROM client_onboarding_decision_fences fence JOIN native_directory_resource_scopes scope
  ON scope.record_id=fence.organization_record_id AND scope.active=1
WHERE fence.outcome='approved' AND fence.organization_target_kind='existing';

-- A rejection still requires authority over the submitted contact's whole
-- context; it does not use the recipient bearer or issuer's old permission.
CREATE VIEW client_onboarding_decision_rejection_scopes AS
SELECT fence.decision_id,invitation.target_client_record_id AS record_id,
  CASE WHEN invitation.target_client_record_id IS NULL THEN 'new' ELSE 'existing' END AS target_kind,
  json_extract(scope.value,'$.businessAreaId') AS business_area_id,
  json_extract(scope.value,'$.divisionId') AS division_id
FROM client_onboarding_decision_fences fence
JOIN client_onboarding_invitations invitation ON invitation.invitation_id=fence.invitation_id
JOIN client_onboarding_issuance_commands issuance ON issuance.invitation_id=fence.invitation_id,
  json_each(issuance.scopes_json) scope
WHERE fence.outcome='rejected' AND invitation.target_client_record_id IS NULL
UNION ALL
SELECT fence.decision_id,invitation.target_client_record_id,'existing',scope.business_area_id,scope.division_id
FROM client_onboarding_decision_fences fence
JOIN client_onboarding_invitations invitation ON invitation.invitation_id=fence.invitation_id
JOIN native_directory_resource_scopes scope ON scope.record_id=invitation.target_client_record_id AND scope.active=1
WHERE fence.outcome='rejected' AND invitation.target_client_record_id IS NOT NULL;

CREATE VIEW client_onboarding_all_decision_scopes AS
SELECT * FROM client_onboarding_decision_scope_targets
UNION ALL SELECT * FROM client_onboarding_decision_rejection_scopes;

CREATE VIEW client_onboarding_live_decision_fences AS
SELECT fence.* FROM client_onboarding_decision_fences fence
JOIN client_onboarding_invitations invitation ON invitation.invitation_id=fence.invitation_id
  AND invitation.state='submitted' AND invitation.version=fence.expected_invitation_version
JOIN client_onboarding_submissions submission ON submission.submission_id=fence.submission_id
  AND submission.invitation_id=fence.invitation_id AND submission.fields_sha256=fence.fields_sha256
JOIN native_staff_admissions admission ON admission.staff_id=fence.reviewer_staff_id
  AND admission.active=1 AND admission.bound_access_subject=fence.reviewer_subject
  AND admission.version=fence.reviewer_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=fence.reviewer_staff_id
  AND profile.version=fence.reviewer_profile_version AND profile.login_email=fence.reviewer_email
WHERE fence.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND (
    -- Every explicitly selected target must have a complete current scope set.
    EXISTS(SELECT 1 FROM client_onboarding_all_decision_scopes scope
      WHERE scope.decision_id=fence.decision_id
        AND (fence.outcome='rejected' OR scope.record_id=fence.client_record_id))
    AND (fence.organization_record_id IS NULL OR EXISTS(
      SELECT 1 FROM client_onboarding_all_decision_scopes scope
      WHERE scope.decision_id=fence.decision_id AND scope.record_id=fence.organization_record_id))
    AND NOT EXISTS(SELECT 1 FROM client_onboarding_all_decision_scopes scope
      LEFT JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
      LEFT JOIN native_business_divisions division ON division.id=scope.division_id
        AND division.business_area_id=scope.business_area_id AND division.active=1
      WHERE scope.decision_id=fence.decision_id
        AND (area.id IS NULL OR (scope.division_id IS NOT NULL AND division.id IS NULL)))
    AND NOT EXISTS(SELECT 1 FROM client_onboarding_all_decision_scopes scope,
      (SELECT 'directory.profile.edit' permission UNION ALL SELECT 'directory.identity.link'
        UNION ALL SELECT 'directory.enrollment.manage') needed
      WHERE scope.decision_id=fence.decision_id
        AND (needed.permission<>'directory.enrollment.manage' OR
          (scope.record_id=fence.client_record_id AND fence.client_target_kind='new'
            AND json_array_length(fence.client_destinations_json)>0)
          OR (scope.record_id=fence.organization_record_id AND fence.organization_target_kind='new'
            AND json_array_length(fence.organization_destinations_json)>0))
        AND NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row
          WHERE grant_row.staff_id=fence.reviewer_staff_id AND grant_row.permission=needed.permission
            AND grant_row.effect='allow' AND grant_row.active=1
            AND (grant_row.scope_kind='global'
              OR (scope.target_kind='existing' AND grant_row.scope_kind='resource' AND grant_row.resource_id=scope.record_id)
              OR (scope.target_kind='existing' AND grant_row.scope_kind='assigned' AND EXISTS(
                SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=scope.record_id AND assignment.staff_id=fence.reviewer_staff_id AND assignment.active=1))
              OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=scope.business_area_id)
              OR (grant_row.scope_kind='division' AND grant_row.division_id=scope.division_id))))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
      WHERE deny_row.staff_id=fence.reviewer_staff_id AND deny_row.effect='deny' AND deny_row.active=1
        AND deny_row.permission IN ('directory.profile.edit','directory.identity.link','directory.enrollment.manage')
        AND (deny_row.permission<>'directory.enrollment.manage' OR
          (fence.client_target_kind='new' AND json_array_length(fence.client_destinations_json)>0)
          OR (fence.organization_target_kind='new' AND json_array_length(fence.organization_destinations_json)>0))
        AND EXISTS(SELECT 1 FROM client_onboarding_all_decision_scopes scope
          WHERE scope.decision_id=fence.decision_id
            AND (deny_row.permission<>'directory.enrollment.manage' OR
              (scope.record_id=fence.client_record_id AND fence.client_target_kind='new'
                AND json_array_length(fence.client_destinations_json)>0)
              OR (scope.record_id=fence.organization_record_id AND fence.organization_target_kind='new'
                AND json_array_length(fence.organization_destinations_json)>0))
            AND (deny_row.scope_kind='global'
              OR (scope.target_kind='existing' AND deny_row.scope_kind='resource' AND deny_row.resource_id=scope.record_id)
              OR (scope.target_kind='existing' AND deny_row.scope_kind='assigned' AND EXISTS(
                SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=scope.record_id
                  AND assignment.staff_id=fence.reviewer_staff_id AND assignment.active=1))
              OR (deny_row.scope_kind='business_area' AND deny_row.business_area_id=scope.business_area_id)
              OR (deny_row.scope_kind='division' AND deny_row.division_id=scope.division_id))))
  );

CREATE TRIGGER client_onboarding_decision_fence_live AFTER INSERT ON client_onboarding_decision_fences
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_decision_fences WHERE decision_id=NEW.decision_id)
BEGIN SELECT RAISE(ABORT,'client onboarding decision requires current native authority'); END;

CREATE TRIGGER client_onboarding_decision_admission_guard BEFORE INSERT ON native_directory_create_admissions
WHEN NEW.id LIKE 'client-onboarding:%' AND NOT EXISTS(
  SELECT 1 FROM client_onboarding_live_decision_fences fence WHERE fence.outcome='approved'
    AND NEW.staff_id=fence.reviewer_staff_id AND NEW.issued_by=fence.reviewer_staff_id
    AND NEW.bound_access_subject=fence.reviewer_subject
    AND ((NEW.id=fence.client_create_admission_id AND NEW.record_id=fence.client_record_id
      AND NEW.record_kind='client' AND json(NEW.scopes_json)=json(fence.scopes_json)
      AND json(NEW.profile_json)=json(fence.client_profile_json)
      AND json(NEW.destinations_json)=json(fence.client_destinations_json))
    OR (NEW.id=fence.organization_create_admission_id AND NEW.record_id=fence.organization_record_id
      AND NEW.record_kind='organization' AND json(NEW.scopes_json)=json(fence.scopes_json)
      AND json(NEW.profile_json)=json(fence.organization_profile_json)
      AND json(NEW.destinations_json)=json(fence.organization_destinations_json))))
BEGIN SELECT RAISE(ABORT,'client onboarding create admission requires decision authority'); END;

CREATE TRIGGER client_onboarding_decisions_insert_guard BEFORE INSERT ON client_onboarding_decisions
WHEN EXISTS(SELECT 1 FROM client_onboarding_decisions WHERE decision_id=NEW.decision_id OR submission_id=NEW.submission_id)
  OR COALESCE(json_valid(NEW.receipt_json),0)<>1
  OR (SELECT count(*) FROM json_each(NEW.receipt_json))<>9
  OR (SELECT count(DISTINCT key) FROM json_each(NEW.receipt_json))<>9
  OR (SELECT count(*) FROM json_each(NEW.receipt_json) WHERE key NOT IN
      ('decisionId','outcome','invitationId','submissionId','clientRecordId','clientRecordVersion',
       'organizationRecordId','organizationRecordVersion','relationshipVersion'))<>0
  OR json_type(NEW.receipt_json,'$.decisionId') IS NOT 'text'
  OR json_extract(NEW.receipt_json,'$.decisionId') IS NOT NEW.decision_id
  OR json_type(NEW.receipt_json,'$.outcome') IS NOT 'text'
  OR json_extract(NEW.receipt_json,'$.outcome') IS NOT NEW.outcome
  OR json_type(NEW.receipt_json,'$.invitationId') IS NOT 'text'
  OR json_extract(NEW.receipt_json,'$.invitationId') IS NOT NEW.invitation_id
  OR json_type(NEW.receipt_json,'$.submissionId') IS NOT 'text'
  OR json_extract(NEW.receipt_json,'$.submissionId') IS NOT NEW.submission_id
  OR json_extract(NEW.receipt_json,'$.clientRecordId') IS NOT NEW.client_record_id
  OR json_extract(NEW.receipt_json,'$.clientRecordVersion') IS NOT NEW.client_record_version
  OR json_extract(NEW.receipt_json,'$.organizationRecordId') IS NOT NEW.organization_record_id
  OR json_extract(NEW.receipt_json,'$.organizationRecordVersion') IS NOT NEW.organization_record_version
  OR json_extract(NEW.receipt_json,'$.relationshipVersion') IS NOT NEW.relationship_version
  OR (NEW.outcome='rejected' AND (
    json_type(NEW.receipt_json,'$.clientRecordId') IS NOT 'null'
    OR json_type(NEW.receipt_json,'$.clientRecordVersion') IS NOT 'null'
    OR json_type(NEW.receipt_json,'$.organizationRecordId') IS NOT 'null'
    OR json_type(NEW.receipt_json,'$.organizationRecordVersion') IS NOT 'null'
    OR json_type(NEW.receipt_json,'$.relationshipVersion') IS NOT 'null'))
  OR (NEW.outcome='approved' AND (
    json_type(NEW.receipt_json,'$.clientRecordId') IS NOT 'text'
    OR json_type(NEW.receipt_json,'$.clientRecordVersion') IS NOT 'integer'
    OR json_type(NEW.receipt_json,'$.relationshipVersion') IS NOT 'integer'
    OR (NEW.organization_record_id IS NULL AND (
      json_type(NEW.receipt_json,'$.organizationRecordId') IS NOT 'null'
      OR json_type(NEW.receipt_json,'$.organizationRecordVersion') IS NOT 'null'))
    OR (NEW.organization_record_id IS NOT NULL AND (
      json_type(NEW.receipt_json,'$.organizationRecordId') IS NOT 'text'
      OR json_type(NEW.receipt_json,'$.organizationRecordVersion') IS NOT 'integer'))))
  OR NOT EXISTS(SELECT 1 FROM client_onboarding_live_decision_fences fence
    WHERE fence.decision_id=NEW.decision_id AND fence.invitation_id=NEW.invitation_id
      AND fence.submission_id=NEW.submission_id AND fence.fields_sha256=NEW.fields_sha256
      AND fence.request_sha256=NEW.request_sha256 AND fence.outcome=NEW.outcome
      AND fence.reviewer_staff_id=NEW.reviewer_staff_id AND fence.reviewer_subject=NEW.reviewer_subject
      AND fence.reviewer_email=NEW.reviewer_email
      AND fence.reviewer_admission_version=NEW.original_admission_version
      AND fence.reviewer_profile_version=NEW.original_profile_version
      AND fence.reason=NEW.reason AND fence.reviewed_fields_json IS NEW.reviewed_fields_json
      AND (fence.outcome='rejected' OR (
        NEW.client_record_id=fence.client_record_id
        AND NEW.client_record_version=fence.client_expected_version+1
        AND NEW.organization_record_id IS fence.organization_record_id
        AND NEW.organization_record_version IS CASE WHEN fence.organization_record_id IS NULL THEN NULL
          ELSE fence.organization_expected_version+1 END
        AND NEW.relationship_version=fence.relationship_expected_version+
          CASE WHEN fence.relationship_mode='change' THEN 1 ELSE 0 END
        AND EXISTS(SELECT 1 FROM operations_directory_revisions revision
          WHERE revision.record_id=NEW.client_record_id AND revision.version=NEW.client_record_version
            AND revision.mutation_id=fence.client_mutation_id
            AND json(revision.profile_json)=json(fence.client_profile_json))
        AND (fence.organization_record_id IS NULL OR EXISTS(
          SELECT 1 FROM operations_directory_revisions revision
          WHERE revision.record_id=NEW.organization_record_id AND revision.version=NEW.organization_record_version
            AND revision.mutation_id=fence.organization_mutation_id
            AND json(revision.profile_json)=json(fence.organization_profile_json)))
        AND EXISTS(SELECT 1 FROM operations_directory_client_organization_history history
          WHERE history.client_record_id=NEW.client_record_id AND history.relationship_version=NEW.relationship_version
            AND history.mutation_id=fence.relationship_mutation_id
            AND history.organization_record_id IS NEW.organization_record_id
            AND (fence.relationship_mode='preserve' OR history.client_record_version=NEW.client_record_version))
        AND EXISTS(SELECT 1 FROM operations_directory_client_organizations current_relation
          WHERE current_relation.client_record_id=NEW.client_record_id
            AND current_relation.relationship_version=NEW.relationship_version
            AND current_relation.organization_record_id IS NEW.organization_record_id)
        AND (fence.relationship_mode='change' OR EXISTS(
          SELECT 1 FROM operations_directory_client_organization_history old_history
          WHERE old_history.client_record_id=NEW.client_record_id
            AND old_history.relationship_version=fence.relationship_expected_version
            AND old_history.mutation_id=fence.relationship_mutation_id
            AND old_history.organization_record_id IS fence.relationship_previous_organization_record_id
            AND (fence.organization_record_id IS NULL OR
              fence.relationship_previous_organization_record_version=fence.organization_expected_version)
            AND old_history.client_record_version<=NEW.client_record_version))
        AND (fence.client_target_kind<>'new' OR EXISTS(SELECT 1 FROM native_directory_create_admissions admission
          WHERE admission.id=fence.client_create_admission_id AND admission.record_id=NEW.client_record_id
            AND admission.staff_id=fence.reviewer_staff_id AND admission.bound_access_subject=fence.reviewer_subject
            AND admission.active=0 AND admission.consumed_mutation_id=fence.client_mutation_id
            AND json(admission.scopes_json)=json(fence.scopes_json)
            AND json(admission.profile_json)=json(fence.client_profile_json)
            AND json(admission.destinations_json)=json(fence.client_destinations_json)))
        AND (fence.organization_target_kind IS NOT 'new' OR EXISTS(SELECT 1 FROM native_directory_create_admissions admission
          WHERE admission.id=fence.organization_create_admission_id AND admission.record_id=NEW.organization_record_id
            AND admission.staff_id=fence.reviewer_staff_id AND admission.bound_access_subject=fence.reviewer_subject
            AND admission.active=0 AND admission.consumed_mutation_id=fence.organization_mutation_id
            AND json(admission.scopes_json)=json(fence.scopes_json)
            AND json(admission.profile_json)=json(fence.organization_profile_json)
            AND json(admission.destinations_json)=json(fence.organization_destinations_json)))
        AND NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
          WHERE intent.mutation_id=fence.client_mutation_id AND NOT EXISTS(
            SELECT 1 FROM operations_directory_intent_relationship_dependencies dependency
            WHERE dependency.intent_id=intent.intent_id))
      )))
BEGIN SELECT RAISE(ABORT,'client onboarding decision artifacts are incomplete'); END;
CREATE TRIGGER client_onboarding_decisions_no_update BEFORE UPDATE ON client_onboarding_decisions
BEGIN SELECT RAISE(ABORT,'client onboarding decision is immutable'); END;
CREATE TRIGGER client_onboarding_decisions_no_delete BEFORE DELETE ON client_onboarding_decisions
BEGIN SELECT RAISE(ABORT,'client onboarding decision is durable'); END;
CREATE TRIGGER client_onboarding_decision_fence_complete BEFORE DELETE ON client_onboarding_decision_fences
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_decisions decision
    WHERE decision.decision_id=OLD.decision_id AND decision.submission_id=OLD.submission_id
      AND decision.request_sha256=OLD.request_sha256)
  OR EXISTS(SELECT 1 FROM operations_directory_write_fences fence
    WHERE fence.mutation_id IN (OLD.client_mutation_id,OLD.organization_mutation_id))
  OR EXISTS(SELECT 1 FROM operations_directory_relationship_write_fences fence
    WHERE fence.mutation_id=OLD.relationship_mutation_id)
BEGIN SELECT RAISE(ABORT,'client onboarding decision is incomplete'); END;
