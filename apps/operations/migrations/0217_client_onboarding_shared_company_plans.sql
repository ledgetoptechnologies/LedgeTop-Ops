PRAGMA foreign_keys=ON;

-- Review evidence only. These rows do not approve a submission, create clients,
-- issue admissions, grant portal access or mutate company memberships/profiles.
CREATE TABLE client_onboarding_shared_company_plans(
 plan_id TEXT PRIMARY KEY CHECK(length(plan_id)=36),
 submission_id TEXT NOT NULL REFERENCES client_onboarding_submissions(submission_id),
 invitation_id TEXT NOT NULL REFERENCES client_onboarding_invitations(invitation_id),
 fields_sha256 TEXT NOT NULL CHECK(length(fields_sha256)=64 AND fields_sha256 NOT GLOB '*[^0-9a-f]*'),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 company_group_id TEXT NOT NULL REFERENCES native_directory_shared_profiles(id),
 company_group_version INTEGER NOT NULL CHECK(typeof(company_group_version)='integer' AND company_group_version>=1),
 company_members_json TEXT NOT NULL CHECK(json_valid(company_members_json) AND json_array_length(company_members_json) BETWEEN 1 AND 2),
 source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json) AND json_array_length(source_ids_json) BETWEEN 1 AND 2),
 scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_array_length(scopes_json)>0),
 client_profile_json TEXT NOT NULL CHECK(json_valid(client_profile_json) AND json_type(client_profile_json)='object'),
 reviewer_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id),reviewer_subject TEXT NOT NULL,
 reviewer_email TEXT NOT NULL,reviewer_admission_version INTEGER NOT NULL,reviewer_profile_version INTEGER NOT NULL,
 verified_until TEXT NOT NULL CHECK(verified_until=strftime('%Y-%m-%dT%H:%M:%fZ',verified_until)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX client_onboarding_shared_company_plan_submission ON client_onboarding_shared_company_plans(submission_id,created_at);

CREATE VIEW client_onboarding_live_shared_company_plans AS
SELECT plan.* FROM client_onboarding_shared_company_plans plan
JOIN client_onboarding_submissions submission ON submission.submission_id=plan.submission_id
 AND submission.invitation_id=plan.invitation_id AND submission.fields_sha256=plan.fields_sha256
JOIN client_onboarding_invitations invitation ON invitation.invitation_id=plan.invitation_id
 AND invitation.state='submitted' AND invitation.version=2 AND invitation.target_client_record_id IS NULL
JOIN client_onboarding_issuance_commands issuance ON issuance.invitation_id=plan.invitation_id
JOIN native_directory_shared_profiles company ON company.id=plan.company_group_id
 AND company.kind='organization' AND company.version=plan.company_group_version
JOIN native_staff_admissions admission ON admission.staff_id=plan.reviewer_staff_id AND admission.active=1
 AND admission.version=plan.reviewer_admission_version AND admission.bound_access_subject=plan.reviewer_subject
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
 AND profile.version=plan.reviewer_profile_version AND profile.login_email=plan.reviewer_email
JOIN staff_users staff ON staff.id=admission.staff_id AND staff.status='active'
 AND staff.access_subject=admission.bound_access_subject AND staff.email=profile.login_email
WHERE plan.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND json_extract(submission.fields_json,'$.clientType')='business'
 AND (SELECT count(*) FROM json_each(plan.client_profile_json))=10
 AND json_extract(plan.client_profile_json,'$.clientType')='business'
 AND NOT EXISTS(SELECT 1 FROM json_each(plan.client_profile_json) field
   WHERE field.key NOT IN('clientType','name','email','phone','addressLine1','addressLine2','city','state','postalCode','country')
     OR field.type<>'text' OR field.value IS NOT json_extract(submission.fields_json,'$.'||field.key))
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_decisions decision WHERE decision.submission_id=plan.submission_id)
 AND json(plan.scopes_json)=json((SELECT json_group_array(json_object('businessAreaId',business_area_id,'divisionId',division_id))
   FROM (SELECT json_extract(scope.value,'$.businessAreaId') business_area_id,json_extract(scope.value,'$.divisionId') division_id
     FROM json_each(issuance.scopes_json) scope ORDER BY business_area_id,division_id)))
 AND NOT EXISTS(SELECT 1 FROM json_each(plan.scopes_json) scope
   LEFT JOIN native_business_areas area ON area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
   LEFT JOIN native_business_divisions division ON division.id=json_extract(scope.value,'$.divisionId')
     AND division.business_area_id=area.id AND division.active=1
   WHERE area.id IS NULL OR (json_type(scope.value,'$.divisionId')='text' AND division.id IS NULL))
 AND json_array_length(plan.company_members_json)=json_array_length(company.membership_json)
 AND (SELECT count(*) FROM native_directory_shared_profile_members member WHERE member.group_id=company.id)=json_array_length(company.membership_json)
 AND NOT EXISTS(SELECT 1 FROM json_each(plan.company_members_json) chosen
   WHERE (SELECT count(*) FROM json_each(chosen.value))<>2
     OR json_type(chosen.value,'$.recordId')<>'text' OR json_type(chosen.value,'$.expectedVersion')<>'integer'
     OR NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_members member
       JOIN operations_directory_records record ON record.record_id=member.record_id AND record.record_kind='organization'
       JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
       JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
       LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=record.record_id
       WHERE member.group_id=company.id AND member.record_id=json_extract(chosen.value,'$.recordId')
         AND record.current_version=json_extract(chosen.value,'$.expectedVersion')
         AND (lifecycle.record_id IS NULL OR lifecycle.status='active')
         AND EXISTS(SELECT 1 FROM json_each(company.membership_json) id WHERE id.value=member.record_id)))
 AND (SELECT count(DISTINCT json_extract(value,'$.recordId')) FROM json_each(plan.company_members_json))=json_array_length(plan.company_members_json)
 AND (SELECT count(DISTINCT value) FROM json_each(plan.source_ids_json))=json_array_length(plan.source_ids_json)
 AND NOT EXISTS(SELECT 1 FROM json_each(plan.source_ids_json) selected
   WHERE (SELECT count(*) FROM native_directory_shared_profile_members member
     JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=member.record_id
     JOIN json_each(enrollment.destinations_json) destination
     WHERE member.group_id=company.id AND json_extract(destination.value,'$.sourceId')=selected.value)<>1)
 AND NOT EXISTS(SELECT 1 FROM json_each('["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage"]') required
   WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants allowed WHERE allowed.staff_id=admission.staff_id
     AND allowed.permission=required.value AND allowed.active=1 AND allowed.effect='allow' AND allowed.scope_kind='global'))
 AND NOT EXISTS(SELECT 1 FROM native_directory_grants denied WHERE denied.staff_id=admission.staff_id
   AND denied.permission IN('directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage')
   AND denied.effect='deny' AND denied.active=1);
CREATE TRIGGER client_onboarding_shared_company_plan_insert AFTER INSERT ON client_onboarding_shared_company_plans
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_company_plans live WHERE live.plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company review authority or membership changed'); END;
CREATE TRIGGER client_onboarding_shared_company_plan_immutable BEFORE UPDATE ON client_onboarding_shared_company_plans
BEGIN SELECT RAISE(ABORT,'onboarding shared company plan immutable'); END;
CREATE TRIGGER client_onboarding_shared_company_plan_durable BEFORE DELETE ON client_onboarding_shared_company_plans
BEGIN SELECT RAISE(ABORT,'onboarding shared company plan durable'); END;

CREATE TABLE client_onboarding_shared_company_plan_children(
 plan_id TEXT NOT NULL REFERENCES client_onboarding_shared_company_plans(plan_id),
 client_record_id TEXT NOT NULL CHECK(length(client_record_id)=36),mutation_id TEXT NOT NULL CHECK(length(mutation_id)=36),
 relationship_mutation_id TEXT NOT NULL CHECK(length(relationship_mutation_id)=36),create_admission_id TEXT NOT NULL,
 parent_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id),parent_record_version INTEGER NOT NULL CHECK(parent_record_version>=1),
 destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_array_length(destinations_json) BETWEEN 1 AND 2),
 parent_enrollment_json TEXT NOT NULL CHECK(json_valid(parent_enrollment_json)),
 parent_bindings_json TEXT NOT NULL CHECK(json_valid(parent_bindings_json)),
 PRIMARY KEY(plan_id,client_record_id),UNIQUE(plan_id,parent_record_id),UNIQUE(mutation_id),UNIQUE(relationship_mutation_id),UNIQUE(create_admission_id)
);
CREATE TABLE client_onboarding_shared_company_plan_seals(
 plan_id TEXT PRIMARY KEY REFERENCES client_onboarding_shared_company_plans(plan_id),
 child_count INTEGER NOT NULL CHECK(child_count BETWEEN 1 AND 2),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER client_onboarding_shared_company_plan_child_insert BEFORE INSERT ON client_onboarding_shared_company_plan_children
WHEN EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_seals seal WHERE seal.plan_id=NEW.plan_id)
 OR EXISTS(SELECT 1 FROM operations_directory_records record WHERE record.record_id=NEW.client_record_id)
 OR NEW.create_admission_id<>'client-onboarding-member:'||NEW.plan_id||':'||NEW.client_record_id
 OR NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_company_plans plan
   JOIN native_directory_shared_profile_members member ON member.group_id=plan.company_group_id AND member.record_id=NEW.parent_record_id
   JOIN operations_directory_records parent ON parent.record_id=member.record_id AND parent.current_version=NEW.parent_record_version
   JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=parent.record_id
   WHERE plan.plan_id=NEW.plan_id AND json(enrollment.destinations_json)=json(NEW.parent_enrollment_json)
     AND EXISTS(SELECT 1 FROM json_each(plan.company_members_json) chosen WHERE json_extract(chosen.value,'$.recordId')=parent.record_id
       AND json_extract(chosen.value,'$.expectedVersion')=parent.current_version)
     AND json_array_length(NEW.parent_bindings_json)=json_array_length(NEW.destinations_json)
     AND NOT EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) destination
       WHERE NOT EXISTS(SELECT 1 FROM json_each(plan.source_ids_json) selected WHERE selected.value=json_extract(destination.value,'$.sourceId'))
         OR json_extract(destination.value,'$.externalCanonicalId')<>NEW.client_record_id
         OR NOT EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) enrolled
           JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=parent.record_id AND mapping.resource_type='organization'
             AND mapping.source_id=json_extract(enrolled.value,'$.sourceId') AND mapping.source_instance_id=json_extract(enrolled.value,'$.sourceInstanceUUID')
             AND mapping.application_id=json_extract(enrolled.value,'$.applicationUUID') AND mapping.history_epoch_id=json_extract(enrolled.value,'$.historyEpoch')
           WHERE json_extract(enrolled.value,'$.sourceId')=json_extract(destination.value,'$.sourceId')
             AND json_extract(enrolled.value,'$.sourceInstanceUUID')=json_extract(destination.value,'$.sourceInstanceUUID')
             AND json_extract(enrolled.value,'$.applicationUUID')=json_extract(destination.value,'$.applicationUUID')
             AND json_extract(enrolled.value,'$.historyEpoch')=json_extract(destination.value,'$.historyEpoch')
             AND json_extract(enrolled.value,'$.origin')=json_extract(destination.value,'$.origin')
             AND EXISTS(SELECT 1 FROM json_each(NEW.parent_bindings_json) proof
               WHERE json_extract(proof.value,'$.sourceId')=mapping.source_id
                 AND json_extract(proof.value,'$.sourceInstanceId')=mapping.source_instance_id
                 AND json_extract(proof.value,'$.applicationId')=mapping.application_id
                 AND json_extract(proof.value,'$.historyEpoch')=mapping.history_epoch_id
                 AND json_extract(proof.value,'$.binding.externalId')=mapping.external_id
                 AND json_extract(proof.value,'$.binding.publicId')=mapping.project_alpha_public_id
                 AND json_extract(proof.value,'$.authorizationGeneration')=json_extract(destination.value,'$.expectedAuthorizationGeneration')))))
BEGIN SELECT RAISE(ABORT,'onboarding shared company child requires exact reviewed parent alias'); END;
CREATE TRIGGER client_onboarding_shared_company_plan_child_immutable BEFORE UPDATE ON client_onboarding_shared_company_plan_children
BEGIN SELECT RAISE(ABORT,'onboarding shared company child immutable'); END;
CREATE TRIGGER client_onboarding_shared_company_plan_child_durable BEFORE DELETE ON client_onboarding_shared_company_plan_children
BEGIN SELECT RAISE(ABORT,'onboarding shared company child durable'); END;
CREATE TRIGGER client_onboarding_shared_company_plan_seal_insert BEFORE INSERT ON client_onboarding_shared_company_plan_seals
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_company_plans plan WHERE plan.plan_id=NEW.plan_id
  AND NEW.child_count=(SELECT count(*) FROM client_onboarding_shared_company_plan_children child WHERE child.plan_id=plan.plan_id)
  AND NOT EXISTS(SELECT 1 FROM json_each(plan.source_ids_json) selected
    WHERE (SELECT count(*) FROM client_onboarding_shared_company_plan_children child JOIN json_each(child.destinations_json) destination
      WHERE child.plan_id=plan.plan_id AND json_extract(destination.value,'$.sourceId')=selected.value)<>1)
  AND (SELECT count(*) FROM client_onboarding_shared_company_plan_children child JOIN json_each(child.destinations_json) destination
    WHERE child.plan_id=plan.plan_id)=json_array_length(plan.source_ids_json))
BEGIN SELECT RAISE(ABORT,'onboarding shared company plan is not exhausted'); END;
CREATE TRIGGER client_onboarding_shared_company_plan_seal_immutable BEFORE UPDATE ON client_onboarding_shared_company_plan_seals
BEGIN SELECT RAISE(ABORT,'onboarding shared company seal immutable'); END;
CREATE TRIGGER client_onboarding_shared_company_plan_seal_durable BEFORE DELETE ON client_onboarding_shared_company_plan_seals
BEGIN SELECT RAISE(ABORT,'onboarding shared company seal durable'); END;
