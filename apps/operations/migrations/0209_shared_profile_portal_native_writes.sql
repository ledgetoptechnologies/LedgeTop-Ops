PRAGMA foreign_keys=ON;
-- Keep the historical staff branch intact. Portal writes use separate scoped
-- authority and never create a staff admission or staff permission grant.
CREATE TABLE operations_directory_portal_write_fences(
 mutation_id TEXT PRIMARY KEY NOT NULL,operation_kind TEXT NOT NULL CHECK(operation_kind='update'),
 actor_id TEXT NOT NULL,bound_access_subject TEXT NOT NULL,permission TEXT NOT NULL CHECK(permission='directory.profile.edit'),
 record_id TEXT NOT NULL UNIQUE REFERENCES operations_directory_records(record_id),record_kind TEXT NOT NULL CHECK(record_kind IN('organization','client')),
 expected_version INTEGER NOT NULL CHECK(expected_version>=1),create_admission_id TEXT CHECK(create_admission_id IS NULL),
 selected_grant_id TEXT NOT NULL REFERENCES shared_profile_portal_grants(id),scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_array_length(scopes_json)=0),
 profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),command_json TEXT NOT NULL CHECK(json_valid(command_json)),
 destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_array_length(destinations_json) BETWEEN 1 AND 16),
 record_writes INTEGER NOT NULL DEFAULT 1 CHECK(record_writes IN(0,1)),revision_writes INTEGER NOT NULL DEFAULT 1 CHECK(revision_writes IN(0,1)),
 audit_writes INTEGER NOT NULL DEFAULT 1 CHECK(audit_writes IN(0,1)),intent_writes INTEGER NOT NULL CHECK(intent_writes BETWEEN 0 AND 16),
 write_guard INTEGER NOT NULL DEFAULT 1 CHECK(write_guard=1),actor_admission_version INTEGER NOT NULL DEFAULT 0 CHECK(actor_admission_version=0)
);
DROP VIEW operations_directory_live_write_fences;
CREATE VIEW operations_directory_live_staff_write_fences AS
SELECT fence.* FROM operations_directory_write_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id
JOIN native_staff_admissions staff_admission ON staff_admission.staff_id=fence.actor_id
  AND staff_admission.active=1 AND staff_admission.bound_access_subject=fence.bound_access_subject
  AND staff_admission.version=fence.actor_admission_version
LEFT JOIN operations_directory_records record ON record.record_id=fence.record_id
LEFT JOIN native_directory_create_admissions create_admission ON create_admission.id=fence.create_admission_id
LEFT JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=fence.record_id
LEFT JOIN native_directory_grants selected_grant ON selected_grant.id=fence.selected_grant_id
  AND selected_grant.staff_id=fence.actor_id AND selected_grant.permission=fence.permission
  AND selected_grant.effect='allow' AND selected_grant.active=1
WHERE fence.write_guard=1
  AND ((fence.operation_kind='create'
      AND create_admission.staff_id=fence.actor_id AND create_admission.bound_access_subject=fence.bound_access_subject
      AND create_admission.record_id=fence.record_id AND create_admission.record_kind=fence.record_kind
      AND json(create_admission.scopes_json)=json(fence.scopes_json)
      AND json(create_admission.profile_json)=json(fence.profile_json)
      AND json(create_admission.destinations_json)=json(fence.destinations_json)
      AND fence.intent_writes BETWEEN 0 AND json_array_length(fence.destinations_json)
      AND NOT EXISTS(SELECT 1 FROM json_each(fence.scopes_json) proposed
        LEFT JOIN native_business_areas area ON area.id=json_extract(proposed.value,'$.businessAreaId') AND area.active=1
        LEFT JOIN native_business_divisions division ON division.id=json_extract(proposed.value,'$.divisionId')
          AND division.business_area_id=json_extract(proposed.value,'$.businessAreaId') AND division.active=1
        WHERE area.id IS NULL OR (json_type(proposed.value,'$.divisionId')='text' AND division.id IS NULL))
      AND ((fence.record_writes=1 AND record.record_id IS NULL AND create_admission.active=1
          AND create_admission.consumed_mutation_id IS NULL)
        OR (fence.record_writes=0 AND record.record_id=fence.record_id AND record.record_kind=fence.record_kind
          AND record.current_version=1 AND create_admission.active=0
          AND create_admission.consumed_mutation_id=fence.mutation_id))
      AND (selected_grant.scope_kind='global'
        OR (selected_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
          WHERE json_extract(scope.value,'$.businessAreaId')=selected_grant.business_area_id))
        OR (selected_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
          WHERE json_extract(scope.value,'$.divisionId')=selected_grant.division_id))))
    OR (fence.operation_kind='update' AND record.record_id IS NOT NULL AND record.record_kind=fence.record_kind
      AND ((fence.record_writes=1 AND record.current_version=fence.expected_version)
        OR (fence.record_writes=0 AND record.current_version=fence.expected_version+1))
      AND enrollment.record_id IS NOT NULL AND json(enrollment.destinations_json)=json(fence.destinations_json)
      AND fence.intent_writes BETWEEN 0 AND json_array_length(fence.destinations_json)
      AND NOT EXISTS(SELECT 1 FROM native_directory_resource_scopes current_scope
        JOIN native_business_areas area ON area.id=current_scope.business_area_id
        LEFT JOIN native_business_divisions division ON division.id=current_scope.division_id
        WHERE current_scope.record_id=fence.record_id AND current_scope.active=1
          AND (area.active<>1 OR (current_scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
      AND (selected_grant.scope_kind='global'
        OR (selected_grant.scope_kind='resource' AND selected_grant.resource_id=fence.record_id)
        OR (selected_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_id AND assignment.active=1))
        OR (selected_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=selected_grant.business_area_id))
        OR (selected_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=selected_grant.division_id)))))
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny
    WHERE deny.staff_id=fence.actor_id AND deny.permission=fence.permission AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=fence.record_id)
        OR (deny.scope_kind='assigned' AND fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_id AND assignment.active=1))
        OR (deny.scope_kind='business_area' AND ((fence.operation_kind='create' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
            WHERE json_extract(scope.value,'$.businessAreaId')=deny.business_area_id))
          OR (fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))))
        OR (deny.scope_kind='division' AND ((fence.operation_kind='create' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
            WHERE json_extract(scope.value,'$.divisionId')=deny.division_id))
          OR (fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))));
CREATE VIEW operations_directory_live_portal_write_fences AS
SELECT fence.* FROM operations_directory_portal_write_fences fence
JOIN native_directory_shared_profile_commands command ON command.mutation_id=json_extract(fence.command_json,'$.actor.sharedMutationId') AND command.actor_kind='portal'
JOIN shared_profile_portal_write_fences proof ON proof.mutation_id=command.mutation_id AND proof.group_id=command.group_id
JOIN shared_profile_portal_grants grant_row ON grant_row.id=proof.grant_id AND grant_row.id=fence.selected_grant_id
JOIN shared_profile_portal_authority_heads head ON head.workspace_id=grant_row.workspace_id AND head.source_id=grant_row.source_id
JOIN native_directory_shared_profiles profile ON profile.id=command.group_id
JOIN native_directory_shared_profile_members member ON member.group_id=profile.id AND member.record_id=fence.record_id
JOIN operations_directory_records record ON record.record_id=fence.record_id AND record.record_kind=fence.record_kind
JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=fence.record_id
JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=grant_row.record_id AND mapping.source_id=grant_row.source_id
WHERE (WITH policy_predicates(authorized) AS (VALUES
 (fence.write_guard=1 AND fence.operation_kind='update' AND fence.permission='directory.profile.edit'),
 (fence.actor_admission_version=0 AND fence.create_admission_id IS NULL AND json_array_length(fence.scopes_json)=0),
 (grant_row.state='active' AND grant_row.revision=proof.grant_revision AND grant_row.issuer=proof.issuer AND grant_row.subject=proof.subject),
 (head.state='active' AND head.revision=proof.authority_revision),
 (julianday(proof.verified_until)>julianday('now') AND julianday(proof.verified_until)<=julianday('now','+60 seconds')),
 (fence.actor_id='portal:'||grant_row.id AND command.actor_id=fence.actor_id AND fence.bound_access_subject=proof.subject),
 (command.expected_version=proof.expected_group_version AND command.request_sha256=proof.request_sha256),
 (profile.version=proof.expected_group_version+1 AND profile.kind=fence.record_kind AND json(profile.profile_json)=json(command.profile_json)),
 (json(profile.membership_json)=json(grant_row.group_membership_json) AND json(fence.profile_json)=json(command.profile_json)),
 (mapping.project_alpha_public_id=grant_row.target_public_id AND mapping.resource_type=grant_row.target_type),
 (mapping.source_instance_id=grant_row.source_instance_id AND mapping.application_id=grant_row.application_id AND mapping.history_epoch_id=grant_row.history_epoch_id),
 (EXISTS(SELECT 1 FROM native_directory_shared_profile_members own_member WHERE own_member.record_id=grant_row.record_id AND own_member.group_id=profile.id)),
 (EXISTS(SELECT 1 FROM json_each(command.members_json) m WHERE json_extract(m.value,'$.recordId')=fence.record_id
   AND json_extract(m.value,'$.version')=fence.expected_version AND json_extract(m.value,'$.mutationId')=fence.mutation_id)),
 (((fence.record_writes=1 AND record.current_version=fence.expected_version) OR (fence.record_writes=0 AND record.current_version=fence.expected_version+1))),
 (json(enrollment.destinations_json)=json(fence.destinations_json) AND fence.intent_writes BETWEEN 0 AND json_array_length(fence.destinations_json)),
 (NOT EXISTS(SELECT 1 FROM native_directory_resource_scopes scope LEFT JOIN native_business_areas area ON area.id=scope.business_area_id
   LEFT JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id
   WHERE scope.record_id=fence.record_id AND scope.active=1 AND (coalesce(area.active,0)<>1 OR (scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))),
 (json_extract(fence.command_json,'$.actor.kind')='portal' AND json_extract(fence.command_json,'$.actor.actorId')=fence.actor_id),
 (json_extract(fence.command_json,'$.actor.issuer')=proof.issuer AND json_extract(fence.command_json,'$.actor.subject')=proof.subject),
 (json_extract(fence.command_json,'$.actor.grantId')=grant_row.id AND json_extract(fence.command_json,'$.actor.grantRevision')=proof.grant_revision),
 (json_extract(fence.command_json,'$.actor.workspaceId')=grant_row.workspace_id AND json_extract(fence.command_json,'$.actor.sourceId')=grant_row.source_id),
 (json_extract(fence.command_json,'$.actor.groupId')=profile.id AND json_extract(fence.command_json,'$.actor.groupVersion')=proof.expected_group_version),
 (json_extract(fence.command_json,'$.actor.authorityRevision')=proof.authority_revision AND json_extract(fence.command_json,'$.actor.contextVersion')=proof.context_version),
 (json_extract(fence.command_json,'$.actor.verifiedUntil')=proof.verified_until),
 (json_extract(fence.command_json,'$.operation')='update' AND json_extract(fence.command_json,'$.mutationId')=fence.mutation_id),
 (json_extract(fence.command_json,'$.recordId')=fence.record_id AND json_extract(fence.command_json,'$.resourceType')=fence.record_kind AND json_extract(fence.command_json,'$.expectedLocalVersion')=fence.expected_version),
 (json_extract(fence.command_json,'$.fields')=json(fence.profile_json) AND json_type(fence.command_json,'$.scopes')='null' AND json_type(fence.command_json,'$.createAdmissionId')='null'),
 (fence.record_kind<>'client' OR (command.identity_safe_contact_profile=1 AND json_extract(fence.command_json,'$.sharedContactProfile.groupId')=profile.id AND json_extract(fence.command_json,'$.sharedContactProfile.mutationId')=command.mutation_id)),
 (fence.record_kind<>'client' OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship WHERE relationship.client_record_id=fence.record_id
   AND relationship.organization_record_id IS json_extract(fence.command_json,'$.relationship.organizationRecordId') AND relationship.relationship_version=json_extract(fence.command_json,'$.relationship.expectedRelationshipVersion')))
 ) SELECT MIN(coalesce(authorized,0)) FROM policy_predicates)=1;
CREATE VIEW operations_directory_live_write_fences AS
SELECT * FROM operations_directory_live_staff_write_fences UNION ALL SELECT * FROM operations_directory_live_portal_write_fences;

CREATE TRIGGER operations_directory_portal_write_shape BEFORE INSERT ON operations_directory_portal_write_fences
WHEN NEW.record_writes<>1 OR NEW.revision_writes<>1 OR NEW.audit_writes<>1 OR NEW.intent_writes<>json_array_length(NEW.destinations_json)
 OR EXISTS(SELECT 1 FROM operations_directory_write_fences other WHERE other.record_id=NEW.record_id OR other.mutation_id=NEW.mutation_id)
 OR json_type(NEW.profile_json)<>'object' OR (SELECT count(*) FROM json_each(NEW.profile_json))<>9
 OR EXISTS(SELECT 1 FROM json_each(NEW.profile_json) field WHERE field.type<>'text' OR field.key NOT IN('name','addressLine1','addressLine2','city','state','postalCode','country',
   CASE NEW.record_kind WHEN 'client' THEN 'email' ELSE 'generalEmail' END,CASE NEW.record_kind WHEN 'client' THEN 'phone' ELSE 'generalPhone' END))
BEGIN SELECT RAISE(ABORT,'portal directory write shape is invalid'); END;
CREATE TRIGGER operations_directory_portal_write_authority AFTER INSERT ON operations_directory_portal_write_fences
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_portal_write_fences current WHERE current.mutation_id=NEW.mutation_id)
BEGIN SELECT RAISE(ABORT,'portal directory write requires current scoped authority'); END;
CREATE TRIGGER operations_directory_staff_portal_exclusion BEFORE INSERT ON operations_directory_write_fences
WHEN EXISTS(SELECT 1 FROM operations_directory_portal_write_fences other WHERE other.record_id=NEW.record_id OR other.mutation_id=NEW.mutation_id)
BEGIN SELECT RAISE(ABORT,'directory write authority lanes conflict'); END;

CREATE TRIGGER operations_directory_portal_record_consume AFTER UPDATE ON operations_directory_records
BEGIN UPDATE operations_directory_portal_write_fences SET record_writes=record_writes-1
 WHERE record_id=NEW.record_id AND expected_version=OLD.current_version AND record_writes=1; END;
CREATE TRIGGER operations_directory_portal_revision_consume AFTER INSERT ON operations_directory_revisions
BEGIN UPDATE operations_directory_portal_write_fences SET revision_writes=revision_writes-1 WHERE mutation_id=NEW.mutation_id AND revision_writes=1; END;
CREATE TRIGGER operations_directory_portal_audit_consume AFTER INSERT ON operations_directory_audit
BEGIN UPDATE operations_directory_portal_write_fences SET audit_writes=audit_writes-1 WHERE mutation_id=NEW.mutation_id AND audit_writes=1; END;
CREATE TRIGGER operations_directory_portal_intent_consume AFTER INSERT ON operations_directory_intents
BEGIN UPDATE operations_directory_portal_write_fences SET intent_writes=intent_writes-1 WHERE mutation_id=NEW.mutation_id AND intent_writes>0; END;

CREATE TRIGGER operations_directory_portal_fence_immutable BEFORE UPDATE ON operations_directory_portal_write_fences
WHEN NEW.mutation_id IS NOT OLD.mutation_id OR NEW.operation_kind IS NOT OLD.operation_kind OR NEW.actor_id IS NOT OLD.actor_id
 OR NEW.bound_access_subject IS NOT OLD.bound_access_subject OR NEW.actor_admission_version IS NOT OLD.actor_admission_version
 OR NEW.permission IS NOT OLD.permission OR NEW.record_id IS NOT OLD.record_id OR NEW.record_kind IS NOT OLD.record_kind
 OR NEW.expected_version IS NOT OLD.expected_version OR NEW.create_admission_id IS NOT OLD.create_admission_id
 OR NEW.selected_grant_id IS NOT OLD.selected_grant_id OR NEW.scopes_json IS NOT OLD.scopes_json OR NEW.profile_json IS NOT OLD.profile_json
 OR NEW.command_json IS NOT OLD.command_json OR NEW.destinations_json IS NOT OLD.destinations_json OR NEW.write_guard IS NOT OLD.write_guard
 OR NEW.record_writes>OLD.record_writes OR NEW.revision_writes>OLD.revision_writes OR NEW.audit_writes>OLD.audit_writes OR NEW.intent_writes>OLD.intent_writes
 OR (OLD.record_writes-NEW.record_writes)+(OLD.revision_writes-NEW.revision_writes)+(OLD.audit_writes-NEW.audit_writes)+(OLD.intent_writes-NEW.intent_writes)<>1
 OR (NEW.record_writes<OLD.record_writes AND NOT EXISTS(SELECT 1 FROM operations_directory_records r WHERE r.record_id=OLD.record_id AND r.current_version=OLD.expected_version+1))
 OR (NEW.revision_writes<OLD.revision_writes AND NOT EXISTS(SELECT 1 FROM operations_directory_revisions r WHERE r.record_id=OLD.record_id AND r.version=OLD.expected_version+1 AND r.mutation_id=OLD.mutation_id AND json(r.profile_json)=json(OLD.profile_json)))
 OR (NEW.audit_writes<OLD.audit_writes AND NOT EXISTS(SELECT 1 FROM operations_directory_audit a WHERE a.record_id=OLD.record_id AND a.record_version=OLD.expected_version+1 AND a.mutation_id=OLD.mutation_id AND a.actor_type='system' AND a.actor_id=OLD.actor_id AND a.original_verified_access_subject=OLD.bound_access_subject AND json(a.command_json)=json(OLD.command_json)))
 OR (NEW.intent_writes<OLD.intent_writes AND (SELECT count(*) FROM operations_directory_intents i WHERE i.mutation_id=OLD.mutation_id AND i.record_id=OLD.record_id AND i.record_version=OLD.expected_version+1)<>json_array_length(OLD.destinations_json)-NEW.intent_writes)
BEGIN SELECT RAISE(ABORT,'portal directory write fence context is immutable'); END;
CREATE TRIGGER operations_directory_portal_fence_exhausted BEFORE DELETE ON operations_directory_portal_write_fences
WHEN OLD.record_writes<>0 OR OLD.revision_writes<>0 OR OLD.audit_writes<>0 OR OLD.intent_writes<>0
 OR (OLD.record_kind='client' AND EXISTS(SELECT 1 FROM operations_directory_intents intent WHERE intent.mutation_id=OLD.mutation_id AND NOT EXISTS(
  SELECT 1 FROM operations_directory_intent_relationship_dependencies dependency WHERE dependency.intent_id=intent.intent_id AND dependency.client_record_id=intent.record_id AND dependency.client_record_version=intent.record_version)))
BEGIN SELECT RAISE(ABORT,'portal directory write fence is not exhausted'); END;

DROP TRIGGER operations_directory_audit_write_guard;
-- Ordinary system audits still cannot assert an Access subject. Only the
-- separately fenced portal provenance may retain its actual verified subject.
DROP TRIGGER operations_directory_audit_system_subject_null;
CREATE TRIGGER operations_directory_audit_system_subject_null BEFORE INSERT ON operations_directory_audit
WHEN NEW.actor_type='system' AND NEW.original_verified_access_subject IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM operations_directory_live_portal_write_fences fence WHERE fence.mutation_id=NEW.mutation_id
  AND fence.record_id=NEW.record_id AND NEW.record_version=fence.expected_version+1 AND NEW.actor_id=fence.actor_id
  AND NEW.original_verified_access_subject=fence.bound_access_subject AND json(NEW.command_json)=json(fence.command_json)
  AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=1)
BEGIN SELECT RAISE(ABORT,'system directory audit cannot claim an Access subject'); END;
CREATE TRIGGER operations_directory_audit_write_guard BEFORE INSERT ON operations_directory_audit
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_staff_write_fences fence WHERE fence.mutation_id=NEW.mutation_id
 AND fence.record_id=NEW.record_id AND NEW.record_version=fence.expected_version+1 AND NEW.actor_type='staff'
 AND NEW.actor_id=fence.actor_id AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=1 AND json(NEW.command_json)=json(fence.command_json))
AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_local_profile_fences fence WHERE fence.mutation_id=NEW.mutation_id
 AND fence.record_id=NEW.record_id AND NEW.record_version=fence.expected_record_version+1 AND NEW.actor_type='staff'
 AND NEW.actor_id=fence.actor_staff_id AND NEW.original_verified_access_subject=fence.actor_access_subject
 AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=1 AND NEW.command_json=fence.audit_command_json)
AND NOT EXISTS(SELECT 1 FROM operations_directory_live_portal_write_fences fence WHERE fence.mutation_id=NEW.mutation_id
 AND fence.record_id=NEW.record_id AND NEW.record_version=fence.expected_version+1 AND NEW.actor_type='system'
 AND NEW.actor_id=fence.actor_id AND NEW.original_verified_access_subject=fence.bound_access_subject
 AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=1 AND json(NEW.command_json)=json(fence.command_json))
BEGIN SELECT RAISE(ABORT,'directory audit requires current native authority'); END;

DROP TRIGGER operations_directory_materializations_original_subject_required;
CREATE TRIGGER operations_directory_materializations_original_subject_required BEFORE INSERT ON operations_directory_materializations
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
 JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id AND audit.record_id=intent.record_id AND audit.record_version=intent.record_version
 WHERE intent.intent_id=NEW.intent_id AND audit.actor_type='staff' AND audit.original_verified_access_subject IS NOT NULL
  AND length(audit.original_verified_access_subject) BETWEEN 1 AND 191)
AND NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
 JOIN operations_directory_live_portal_write_fences fence ON fence.mutation_id=intent.mutation_id AND fence.record_id=intent.record_id
 JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id AND audit.record_id=intent.record_id AND audit.record_version=intent.record_version
 WHERE intent.intent_id=NEW.intent_id AND audit.actor_type='system' AND audit.actor_id=fence.actor_id
  AND audit.original_verified_access_subject=fence.bound_access_subject AND json(audit.command_json)=json(fence.command_json)
  AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=0 AND fence.intent_writes=0
  AND json_extract(NEW.origin_snapshot_json,'$.actorId')=fence.actor_id
  AND json_extract(NEW.origin_snapshot_json,'$.actorSubject')=fence.bound_access_subject
  AND json_extract(NEW.origin_snapshot_json,'$.authorityRevision')=CAST(intent.record_version AS TEXT))
BEGIN SELECT RAISE(ABORT,'directory materialization requires original actor identity'); END;

DROP TRIGGER native_directory_shared_command_guard;
CREATE TRIGGER native_directory_shared_command_guard BEFORE INSERT ON native_directory_shared_profile_commands
WHEN NOT EXISTS(SELECT 1 FROM native_directory_shared_profiles g WHERE g.id=NEW.group_id AND g.version=NEW.expected_version
 AND (g.kind<>'client' OR NEW.identity_safe_contact_profile=1 OR json_extract(g.profile_json,'$.email') IS json_extract(NEW.profile_json,'$.email'))
 AND (SELECT count(*) FROM native_directory_shared_profile_members m WHERE m.group_id=g.id)=json_array_length(g.membership_json)
 AND json_array_length(NEW.members_json)=json_array_length(g.membership_json)
 AND NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_members m JOIN operations_directory_records r ON r.record_id=m.record_id
 WHERE m.group_id=g.id AND NOT EXISTS(SELECT 1 FROM json_each(NEW.members_json) v WHERE json_extract(v.value,'$.recordId')=m.record_id
 AND json_extract(v.value,'$.version')=r.current_version AND length(json_extract(v.value,'$.mutationId'))=36)))
BEGIN SELECT RAISE(ABORT,'shared_profile_command_guard'); END;
CREATE TRIGGER native_directory_shared_staff_command_authority BEFORE INSERT ON native_directory_shared_profile_commands
WHEN NEW.actor_kind='staff' AND NOT EXISTS(SELECT 1 FROM staff_users actor JOIN native_staff_admissions admission ON admission.staff_id=actor.id
 WHERE actor.id=NEW.actor_id AND actor.status='active' AND admission.active=1 AND actor.access_subject=admission.bound_access_subject)
BEGIN SELECT RAISE(ABORT,'shared_profile_command_staff_authority'); END;
CREATE TRIGGER native_directory_shared_portal_command_authority BEFORE INSERT ON native_directory_shared_profile_commands
WHEN NEW.actor_kind='portal' AND NOT EXISTS(SELECT 1 FROM shared_profile_portal_write_fences proof
 JOIN shared_profile_portal_grants g ON g.id=proof.grant_id JOIN shared_profile_portal_authority_heads h ON h.workspace_id=g.workspace_id AND h.source_id=g.source_id
 JOIN native_directory_shared_profiles p ON p.id=proof.group_id
 JOIN project_alpha_active_directory_mappings m ON m.record_id=g.record_id AND m.source_id=g.source_id
 WHERE proof.mutation_id=NEW.mutation_id AND proof.group_id=NEW.group_id AND proof.expected_group_version=NEW.expected_version
 AND proof.request_sha256=NEW.request_sha256 AND NEW.actor_id='portal:'||g.id
 AND g.state='active' AND g.revision=proof.grant_revision AND g.issuer=proof.issuer AND g.subject=proof.subject
 AND h.state='active' AND h.revision=proof.authority_revision AND julianday(proof.verified_until)>julianday('now')
 AND p.version=NEW.expected_version AND json(p.membership_json)=json(g.group_membership_json)
 AND m.resource_type=g.target_type AND m.project_alpha_public_id=g.target_public_id
 AND m.source_instance_id=g.source_instance_id AND m.application_id=g.application_id AND m.history_epoch_id=g.history_epoch_id
 AND (p.kind<>'client' OR NEW.identity_safe_contact_profile=1))
BEGIN SELECT RAISE(ABORT,'shared_profile_command_portal_authority'); END;
CREATE TRIGGER native_directory_shared_portal_command_shape BEFORE INSERT ON native_directory_shared_profile_commands
WHEN NEW.actor_kind='portal' AND (json_type(NEW.profile_json)<>'object' OR (SELECT count(*) FROM json_each(NEW.profile_json))<>9
 OR EXISTS(SELECT 1 FROM json_each(NEW.profile_json) field JOIN native_directory_shared_profiles p ON p.id=NEW.group_id
  WHERE field.type<>'text' OR field.key NOT IN('name','addressLine1','addressLine2','city','state','postalCode','country',
   CASE p.kind WHEN 'client' THEN 'email' ELSE 'generalEmail' END,CASE p.kind WHEN 'client' THEN 'phone' ELSE 'generalPhone' END)))
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_command_shape'); END;

-- An ACK may repair only the exact already-accepted profile mapping. This
-- immutable witness remains usable after subsequent grant revocation; later
-- binding completion still requires the original canonical inventory/CAS proof.
CREATE TRIGGER shared_profile_portal_delivery_authority_guard BEFORE INSERT ON shared_profile_portal_audit
WHEN NEW.action='profile.delivery_authority' AND NOT EXISTS(
 SELECT 1 FROM shared_profile_portal_grants grant_row
 JOIN shared_profile_portal_authority_heads head ON head.workspace_id=grant_row.workspace_id AND head.source_id=grant_row.source_id
 JOIN native_directory_shared_profile_commands command ON command.mutation_id=json_extract(NEW.detail_json,'$.sharedMutationId') AND command.group_id=grant_row.group_id AND command.actor_kind='portal'
 JOIN shared_profile_portal_write_fences original ON original.mutation_id=command.mutation_id AND original.grant_id=grant_row.id
 JOIN native_directory_shared_profiles profile ON profile.id=command.group_id
 JOIN project_alpha_directory_outbox outbox ON outbox.command_id=json_extract(NEW.detail_json,'$.commandId')
 JOIN operations_directory_effective_materializations materialization ON materialization.command_id=outbox.command_id AND materialization.command_json=outbox.command_json
 JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
 JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id AND audit.record_id=intent.record_id AND audit.record_version=intent.record_version
 WHERE (WITH predicates(allowed) AS (VALUES
  (NEW.actor_kind='system' AND NEW.actor_id='portal:'||grant_row.id AND NEW.workspace_id=grant_row.workspace_id),
  (grant_row.id=NEW.grant_id AND grant_row.state='active' AND grant_row.revision=original.grant_revision),
  (json_extract(NEW.detail_json,'$.grantRevision')=grant_row.revision AND head.state='active' AND json_extract(NEW.detail_json,'$.authorityRevision')=head.revision),
  (julianday(json_extract(NEW.detail_json,'$.verifiedUntil'))>julianday('now') AND julianday(json_extract(NEW.detail_json,'$.verifiedUntil'))<=julianday('now','+60 seconds')),
  (length(json_extract(NEW.detail_json,'$.contextVersion'))=64 AND json_extract(NEW.detail_json,'$.contextVersion') NOT GLOB '*[^0-9a-f]*'),
  (original.issuer=grant_row.issuer AND original.subject=grant_row.subject AND command.actor_id=NEW.actor_id),
  (json_extract(NEW.detail_json,'$.groupId')=command.group_id AND json_extract(NEW.detail_json,'$.requestSha256')=command.request_sha256 AND command.request_sha256=original.request_sha256),
  (profile.version=command.expected_version+1 AND json(profile.profile_json)=json(command.profile_json) AND json(profile.membership_json)=json(grant_row.group_membership_json)),
  (outbox.state='leased' AND outbox.lease_expires_at>CAST(unixepoch('now') AS INTEGER)*1000 AND intent.state='materialized'),
  (json_extract(NEW.detail_json,'$.commandJson')=outbox.command_json AND json_valid(json_extract(NEW.detail_json,'$.outcomeJson'))),
  (json_extract(NEW.detail_json,'$.recordId')=intent.record_id AND json_extract(NEW.detail_json,'$.localVersion')=intent.record_version),
  (json_extract(NEW.detail_json,'$.sourceId')=outbox.source_id AND json_extract(NEW.detail_json,'$.sourceInstanceId')=outbox.expected_source_instance_id),
  (json_extract(NEW.detail_json,'$.applicationId')=outbox.application_id AND json_extract(NEW.detail_json,'$.historyEpoch')=outbox.expected_history_epoch_id AND json_extract(NEW.detail_json,'$.destinationOrigin')=outbox.destination_base_url),
  (audit.actor_type='system' AND audit.actor_id=NEW.actor_id AND audit.original_verified_access_subject=original.subject AND json_extract(audit.command_json,'$.actor.kind')='portal'),
  (json_extract(audit.command_json,'$.actor.sharedMutationId')=command.mutation_id AND json_extract(audit.command_json,'$.actor.grantId')=grant_row.id),
  (EXISTS(SELECT 1 FROM json_each(command.members_json) member WHERE json_extract(member.value,'$.recordId')=intent.record_id AND json_extract(member.value,'$.mutationId')=intent.mutation_id AND json_extract(member.value,'$.version')=intent.record_version-1)),
  (json_extract(json_extract(NEW.detail_json,'$.outcomeJson'),'$.status')='acknowledged'),
  (json_extract(json_extract(NEW.detail_json,'$.outcomeJson'),'$.response.sourceInstanceId')=outbox.expected_source_instance_id AND json_extract(json_extract(NEW.detail_json,'$.outcomeJson'),'$.response.applicationId')=outbox.application_id AND json_extract(json_extract(NEW.detail_json,'$.outcomeJson'),'$.response.historyEpoch')=outbox.expected_history_epoch_id)
 ) SELECT MIN(coalesce(allowed,0)) FROM predicates)=1)
BEGIN SELECT RAISE(ABORT,'portal profile ACK witness requires exact fresh authority'); END;
CREATE VIEW shared_profile_portal_ack_witnesses AS
SELECT event.operation_id,event.grant_id,event.actor_id,original.subject,
 outbox.command_id,audit.mutation_id,audit.record_id,audit.record_version,
 json_extract(event.detail_json,'$.grantRevision') grant_revision,json_extract(event.detail_json,'$.authorityRevision') authority_revision,
 json_extract(event.detail_json,'$.verifiedUntil') verified_until
FROM shared_profile_portal_audit event
JOIN native_directory_shared_profile_commands command ON command.mutation_id=json_extract(event.detail_json,'$.sharedMutationId') AND command.actor_kind='portal'
JOIN shared_profile_portal_write_fences original ON original.mutation_id=command.mutation_id AND original.grant_id=event.grant_id
JOIN project_alpha_directory_outbox outbox ON outbox.command_id=json_extract(event.detail_json,'$.commandId') AND outbox.state='acknowledged'
JOIN operations_directory_audit audit ON audit.record_id=json_extract(event.detail_json,'$.recordId') AND audit.record_version=json_extract(event.detail_json,'$.localVersion')
WHERE event.action='profile.delivery_authority' AND event.actor_kind='system' AND event.actor_id='portal:'||event.grant_id
 AND command.actor_id=event.actor_id AND json_extract(event.detail_json,'$.groupId')=command.group_id
 AND json_extract(event.detail_json,'$.requestSha256')=command.request_sha256 AND command.request_sha256=original.request_sha256
 AND json_extract(event.detail_json,'$.grantRevision')=original.grant_revision
 AND json_extract(event.detail_json,'$.commandJson')=outbox.command_json AND json_extract(event.detail_json,'$.outcomeJson')=outbox.outcome_json
 AND json_extract(event.detail_json,'$.sourceId')=outbox.source_id AND json_extract(event.detail_json,'$.sourceInstanceId')=outbox.expected_source_instance_id
 AND json_extract(event.detail_json,'$.applicationId')=outbox.application_id AND json_extract(event.detail_json,'$.historyEpoch')=outbox.expected_history_epoch_id
 AND json_extract(event.detail_json,'$.destinationOrigin')=outbox.destination_base_url
 AND audit.actor_type='system' AND audit.actor_id=event.actor_id AND audit.original_verified_access_subject=original.subject
 AND json_extract(audit.command_json,'$.actor.kind')='portal' AND json_extract(audit.command_json,'$.actor.issuer')=original.issuer
 AND json_extract(audit.command_json,'$.actor.subject')=original.subject AND json_extract(audit.command_json,'$.actor.sharedMutationId')=command.mutation_id
 AND json_extract(audit.command_json,'$.actor.grantId')=event.grant_id AND json_extract(audit.command_json,'$.actor.grantRevision')=original.grant_revision
 AND EXISTS(SELECT 1 FROM json_each(command.members_json) member WHERE json_extract(member.value,'$.recordId')=audit.record_id
  AND json_extract(member.value,'$.mutationId')=audit.mutation_id AND json_extract(member.value,'$.version')=audit.record_version-1);
DROP TRIGGER native_directory_profile_binding_continuation_ack;
CREATE TRIGGER native_directory_profile_binding_continuation_ack AFTER UPDATE OF state ON project_alpha_directory_outbox
WHEN NEW.state='acknowledged' AND OLD.state<>'acknowledged' AND json_extract(NEW.command_json,'$.operation')='update'
BEGIN
  INSERT INTO native_directory_profile_binding_jobs(
    command_id,intent_id,record_id,local_version,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,
    resource_type,external_id,public_id,mapping_kind,mapping_provenance_id,actor_id,access_subject,actor_json,
    acknowledged_command_json,acknowledged_outcome_json,authorization_generation,live_revision)
  SELECT NEW.command_id,i.intent_id,i.record_id,i.record_version,NEW.source_id,NEW.expected_source_instance_id,NEW.application_id,
    NEW.expected_history_epoch_id,NEW.destination_base_url,NEW.resource_type,NEW.external_id,m.project_alpha_public_id,m.mapping_kind,m.provenance_id,
    a.actor_id,a.original_verified_access_subject,json_extract(a.command_json,'$.actor'),NEW.command_json,NEW.outcome_json,
    json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration'),json_extract(NEW.outcome_json,'$.response.result.resource.revision')
  FROM operations_directory_effective_materializations x
  JOIN operations_directory_intents i ON i.intent_id=x.intent_id AND i.state='materialized'
  JOIN operations_directory_audit a ON a.mutation_id=i.mutation_id AND a.record_id=i.record_id AND a.record_version=i.record_version
  JOIN operations_directory_records r ON r.record_id=i.record_id AND r.record_kind=NEW.resource_type AND r.current_version=i.record_version
  JOIN operations_directory_revisions v ON v.record_id=i.record_id AND v.version=i.record_version AND v.mutation_id=i.mutation_id
  JOIN project_alpha_active_directory_mappings m ON m.record_id=i.record_id AND m.source_id=NEW.source_id
    AND m.source_instance_id=NEW.expected_source_instance_id AND m.application_id=NEW.application_id
    AND m.history_epoch_id=NEW.expected_history_epoch_id AND m.resource_type=NEW.resource_type AND m.external_id=NEW.external_id
  WHERE x.command_id=NEW.command_id AND x.command_json=NEW.command_json AND x.history_epoch_id=NEW.expected_history_epoch_id
    AND i.source_id=NEW.source_id AND i.source_instance_uuid=NEW.expected_source_instance_id AND i.application_uuid=NEW.application_id
    AND i.expected_history_epoch_id=NEW.expected_history_epoch_id AND i.destination_origin=NEW.destination_base_url AND i.external_canonical_id=NEW.external_id
    AND json_extract(x.origin_snapshot_json,'$.actorId')=a.actor_id
    AND json_extract(x.origin_snapshot_json,'$.actorSubject')=a.original_verified_access_subject
    AND json_extract(x.origin_snapshot_json,'$.authorityRevision')=CAST(i.record_version AS TEXT)
    AND ((a.actor_type='staff' AND json_extract(a.command_json,'$.actor.staffId')=a.actor_id AND json_extract(a.command_json,'$.actor.accessSubject')=a.original_verified_access_subject)
     OR (a.actor_type='system' AND EXISTS(SELECT 1 FROM shared_profile_portal_ack_witnesses witness
       JOIN shared_profile_portal_grants accepted_grant ON accepted_grant.id=witness.grant_id AND accepted_grant.state='active' AND accepted_grant.revision=witness.grant_revision
       JOIN shared_profile_portal_authority_heads accepted_head ON accepted_head.workspace_id=accepted_grant.workspace_id AND accepted_head.source_id=accepted_grant.source_id
       WHERE witness.command_id=NEW.command_id AND witness.mutation_id=i.mutation_id AND witness.record_id=i.record_id AND witness.record_version=i.record_version
         AND witness.actor_id=a.actor_id AND witness.subject=a.original_verified_access_subject
         AND accepted_head.state='active' AND accepted_head.revision=witness.authority_revision
         AND julianday(witness.verified_until)>julianday('now'))))
    AND json_extract(a.command_json,'$.mutationId')=i.mutation_id AND json_extract(a.command_json,'$.recordId')=i.record_id
    AND json_extract(a.command_json,'$.resourceType')=NEW.resource_type AND json_extract(a.command_json,'$.expectedLocalVersion')=i.record_version-1
    AND json_extract(a.command_json,'$.fields')=v.profile_json
    AND json_extract(NEW.command_json,'$.expectedProjectAlphaPublicId')=m.project_alpha_public_id
    AND json_extract(NEW.outcome_json,'$.status')='acknowledged'
    AND json_extract(NEW.outcome_json,'$.response.sourceInstanceId')=NEW.expected_source_instance_id
    AND json_extract(NEW.outcome_json,'$.response.applicationId')=NEW.application_id
    AND json_extract(NEW.outcome_json,'$.response.historyEpoch')=NEW.expected_history_epoch_id
    AND json_extract(NEW.outcome_json,'$.response.result.resource.type')=NEW.resource_type
    AND json_extract(NEW.outcome_json,'$.response.result.resource.publicId')=m.project_alpha_public_id
    AND json_extract(NEW.outcome_json,'$.response.result.authorizationGeneration')=json_extract(NEW.command_json,'$.expectedAuthorizationGeneration')
    -- PA may acknowledge a no-op profile command at the same canonical revision.
    -- ACK evidence must not regress; a frozen binding refresh still strictly advances its prior revision.
    AND (length(json_extract(NEW.outcome_json,'$.response.result.resource.revision'))>length(json_extract(NEW.command_json,'$.expectedRevision'))
      OR length(json_extract(NEW.outcome_json,'$.response.result.resource.revision'))=length(json_extract(NEW.command_json,'$.expectedRevision'))
      AND json_extract(NEW.outcome_json,'$.response.result.resource.revision')>=json_extract(NEW.command_json,'$.expectedRevision'));
  INSERT INTO native_directory_profile_binding_guards(guard_id,ok)
    VALUES(NEW.command_id,CASE WHEN EXISTS(SELECT 1 FROM native_directory_profile_binding_jobs WHERE command_id=NEW.command_id) THEN 1 ELSE 0 END);
  INSERT INTO native_directory_profile_binding_dispatch(command_id,state) VALUES(NEW.command_id,'pending');
  DELETE FROM native_directory_profile_binding_guards WHERE guard_id=NEW.command_id;
END;

-- Portal ACKs may supply an acquired parent revision to later child writes.
-- Every historical canonical dependency predicate remains in this trigger;
-- only the accepted parent audit lane also recognizes the exact durable witness.
DROP TRIGGER operations_directory_intent_relationship_dependencies_insert_guard;
CREATE TRIGGER operations_directory_intent_relationship_dependencies_insert_guard
BEFORE INSERT ON operations_directory_intent_relationship_dependencies
WHEN EXISTS(SELECT 1 FROM operations_directory_intent_relationship_dependencies WHERE intent_id=NEW.intent_id)
  OR NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
    JOIN operations_directory_records client ON client.record_id=intent.record_id AND client.record_kind='client'
    JOIN operations_directory_client_organization_history history
      ON history.client_record_id=intent.record_id AND history.relationship_version=NEW.relationship_version
    JOIN operations_directory_client_organizations current_relation
      ON current_relation.client_record_id=intent.record_id AND current_relation.relationship_version=NEW.relationship_version
    JOIN operations_directory_live_write_fences fence
      ON fence.mutation_id=intent.mutation_id AND fence.record_id=intent.record_id
      AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=0 AND fence.intent_writes=0
    WHERE intent.intent_id=NEW.intent_id AND intent.record_id=NEW.client_record_id
      AND intent.record_version=NEW.client_record_version
      AND history.mutation_id=NEW.relationship_mutation_id
      AND history.client_record_version<=NEW.client_record_version
      AND history.organization_record_id IS NEW.organization_record_id
      AND current_relation.organization_record_id IS NEW.organization_record_id
      AND intent.source_id=NEW.source_id AND intent.source_instance_uuid=NEW.source_instance_uuid
      AND intent.application_uuid=NEW.application_uuid AND intent.expected_history_epoch_id=NEW.history_epoch_id
      AND intent.destination_origin=NEW.destination_origin
      AND ((NEW.evidence_kind='unlinked' AND NEW.organization_record_id IS NULL)
        OR (NEW.organization_record_id IS NOT NULL AND EXISTS(
          SELECT 1 FROM operations_directory_records parent
          JOIN operations_directory_revisions parent_revision
            ON parent_revision.record_id=parent.record_id AND parent_revision.version=NEW.organization_record_version
          JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=parent.record_id
          WHERE parent.record_id=NEW.organization_record_id AND parent.record_kind='organization'
            AND parent.current_version=NEW.organization_record_version
            AND EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) destination
              WHERE json_extract(destination.value,'$.sourceId')=NEW.source_id
                AND json_extract(destination.value,'$.sourceInstanceUUID')=NEW.source_instance_uuid
                AND json_extract(destination.value,'$.applicationUUID')=NEW.application_uuid
                AND json_extract(destination.value,'$.historyEpoch')=NEW.history_epoch_id
                AND json_extract(destination.value,'$.origin')=NEW.destination_origin
                AND ((NEW.evidence_kind='acquired_mapping'
                    AND json_extract(destination.value,'$.externalCanonicalId')=NEW.organization_record_id)
                  OR (NEW.evidence_kind<>'acquired_mapping'
                    AND json_extract(destination.value,'$.externalCanonicalId')=NEW.parent_external_canonical_id)))
        ))))
  OR (NEW.evidence_kind='parent_intent' AND NOT EXISTS(
    SELECT 1 FROM operations_directory_intents parent
    JOIN operations_directory_records record ON record.record_id=parent.record_id AND record.record_kind='organization'
    WHERE parent.intent_id=NEW.parent_intent_id AND parent.record_id=NEW.organization_record_id
      AND parent.record_version=NEW.organization_record_version
      AND parent.source_id=NEW.source_id AND parent.source_instance_uuid=NEW.source_instance_uuid
      AND parent.application_uuid=NEW.application_uuid AND parent.expected_history_epoch_id=NEW.history_epoch_id
      AND parent.destination_origin=NEW.destination_origin
      AND parent.external_canonical_id=NEW.parent_external_canonical_id))
  OR (NEW.evidence_kind='existing_mapping' AND NOT EXISTS(
    SELECT 1 FROM project_alpha_directory_mappings mapping
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=mapping.command_id
    WHERE mapping.command_id=NEW.parent_mapping_command_id
      AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_uuid
      AND mapping.application_id=NEW.application_uuid AND mapping.history_epoch_id=NEW.history_epoch_id
      AND mapping.resource_type='organization' AND mapping.external_id=NEW.parent_external_canonical_id
      AND mapping.project_alpha_public_id=NEW.parent_public_id
      AND outbox.state='acknowledged' AND outbox.command_json IS NEW.parent_ack_command_json
      AND outbox.outcome_json IS NEW.parent_ack_outcome_json
      AND outbox.source_id=NEW.source_id AND outbox.expected_source_instance_id=NEW.source_instance_uuid
      AND outbox.application_id=NEW.application_uuid AND outbox.expected_history_epoch_id=NEW.history_epoch_id
      AND outbox.destination_base_url=NEW.destination_origin
      AND outbox.resource_type='organization' AND outbox.external_id=NEW.parent_external_canonical_id
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=NEW.history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=NEW.source_instance_uuid
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=NEW.application_uuid
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=NEW.parent_external_canonical_id
      AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')=NEW.parent_ack_revision
      AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=NEW.parent_public_id
      AND (
        ((SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=2
          AND json_type(outbox.outcome_json,'$.response.result.data') IS NULL
          AND json_extract(outbox.command_json,'$.operation')='create'
          AND outbox.resource_type='organization')
        OR ((SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=3
          AND json_type(outbox.outcome_json,'$.response.result.data')='object'
          AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.data'))=1
          AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=
            json_extract(outbox.outcome_json,'$.response.result.resource.publicId'))
        )
      ))
  OR (NEW.evidence_kind='acquired_mapping' AND NOT EXISTS(
    SELECT 1
    FROM project_alpha_existing_directory_binding_activation_receipts activation
    JOIN project_alpha_active_directory_mappings mapping
      ON (WITH predicates(allowed) AS (VALUES
        (mapping.mapping_kind='acquired' AND mapping.provenance_id=activation.activation_id),
        (mapping.record_id=activation.record_id),
        (mapping.source_id=activation.source_id AND mapping.source_instance_id=activation.source_instance_id),
        (mapping.application_id=activation.application_id AND mapping.history_epoch_id=activation.history_epoch_id),
        (mapping.resource_type='organization' AND mapping.external_id=activation.external_id),
        (mapping.project_alpha_public_id=activation.project_alpha_public_id)
      ) SELECT MIN(coalesce(allowed,0)) FROM predicates)=1
    WHERE activation.activation_id=NEW.parent_activation_id
      AND activation.record_id=NEW.organization_record_id
      AND activation.source_id=NEW.source_id AND activation.source_instance_id=NEW.source_instance_uuid
      AND activation.application_id=NEW.application_uuid AND activation.history_epoch_id=NEW.history_epoch_id
      AND activation.resource_type='organization' AND activation.external_id=NEW.parent_external_canonical_id
      AND activation.project_alpha_public_id=NEW.parent_public_id
      AND activation.project_alpha_revision=NEW.parent_ack_revision
      AND (activation.local_record_version=NEW.organization_record_version OR EXISTS(
        SELECT 1 FROM operations_directory_intents updated
        JOIN operations_directory_effective_materializations materialization ON materialization.intent_id=updated.intent_id
          AND materialization.history_epoch_id=updated.expected_history_epoch_id
        JOIN operations_directory_audit audit ON audit.mutation_id=updated.mutation_id
          AND audit.record_id=updated.record_id AND audit.record_version=updated.record_version
          AND (audit.actor_type='staff' OR (audit.actor_type='system' AND EXISTS(
            SELECT 1 FROM shared_profile_portal_ack_witnesses witness
            WHERE witness.command_id=outbox.command_id AND witness.mutation_id=updated.mutation_id
              AND witness.record_id=updated.record_id AND witness.record_version=updated.record_version
              AND witness.actor_id=audit.actor_id AND witness.subject=audit.original_verified_access_subject)))
          AND json_extract(audit.command_json,'$.operation')='update'
        JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
          AND outbox.state='acknowledged' AND outbox.command_json=materialization.command_json
          AND outbox.source_id=updated.source_id
          AND outbox.expected_source_instance_id=updated.source_instance_uuid AND outbox.application_id=updated.application_uuid
          AND outbox.expected_history_epoch_id=updated.expected_history_epoch_id
          AND outbox.destination_base_url=updated.destination_origin AND outbox.resource_type='organization'
          AND outbox.external_id=updated.external_canonical_id
        WHERE (WITH predicates(allowed) AS (VALUES
          (updated.record_id=NEW.organization_record_id AND updated.record_version=NEW.organization_record_version),
          (updated.state='acknowledged' AND updated.source_id=NEW.source_id),
          (updated.source_instance_uuid=NEW.source_instance_uuid AND updated.application_uuid=NEW.application_uuid),
          (updated.expected_history_epoch_id=NEW.history_epoch_id AND updated.destination_origin=NEW.destination_origin),
          (updated.external_canonical_id=NEW.parent_external_canonical_id),
          (json_extract(outbox.command_json,'$.operation')='update'),
          (json_extract(outbox.command_json,'$.resourceType')='organization'),
          (json_extract(outbox.command_json,'$.externalId')=NEW.parent_external_canonical_id),
          (json_extract(outbox.command_json,'$.expectedProjectAlphaPublicId')=NEW.parent_public_id),
          (json_extract(outbox.outcome_json,'$.status')='acknowledged'),
          (json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=NEW.source_instance_uuid),
          (json_extract(outbox.outcome_json,'$.response.applicationId')=NEW.application_uuid),
          (json_extract(outbox.outcome_json,'$.response.historyEpoch')=NEW.history_epoch_id),
          (json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'),
          (json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=NEW.parent_public_id),
          (json_type(outbox.outcome_json,'$.response.result.resource.revision')='text'),
          (length(json_extract(outbox.outcome_json,'$.response.result.resource.revision')) BETWEEN 1 AND 19),
          (json_extract(outbox.outcome_json,'$.response.result.resource.revision') NOT GLOB '*[^0-9]*'),
          (substr(json_extract(outbox.outcome_json,'$.response.result.resource.revision'),1,1)<>'0')
        ) SELECT MIN(coalesce(allowed,0)) FROM predicates)=1
      ))))
BEGIN SELECT RAISE(ABORT,'directory intent relationship dependency requires live canonical evidence'); END;
CREATE TABLE shared_profile_authority_recoveries(
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36),requested_by TEXT NOT NULL REFERENCES staff_users(id),
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),ops_snapshot_json TEXT NOT NULL CHECK(json_valid(ops_snapshot_json)),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','completed')),completion_json TEXT CHECK(completion_json IS NULL OR json_valid(completion_json)),
 created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE UNIQUE INDEX shared_profile_authority_one_recovery ON shared_profile_authority_recoveries(state) WHERE state='pending';
CREATE TABLE shared_profile_authority_recovery_steps(
 operation_id TEXT NOT NULL REFERENCES shared_profile_authority_recoveries(operation_id),workspace_id TEXT NOT NULL,source_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1),step_id TEXT NOT NULL UNIQUE CHECK(length(step_id)=36),actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),PRIMARY KEY(operation_id,workspace_id,revision)
);
CREATE TABLE shared_profile_authority_recovery_audit(
 id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES shared_profile_authority_recoveries(operation_id),actor_id TEXT NOT NULL REFERENCES staff_users(id),
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),action TEXT NOT NULL CHECK(action IN('requested','resumed','completion_authorized','completed')),created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TRIGGER shared_profile_recovery_receipt_immutable BEFORE UPDATE ON shared_profile_authority_recoveries
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.requested_by IS NOT OLD.requested_by OR NEW.actor_json IS NOT OLD.actor_json
 OR NEW.ops_snapshot_json IS NOT OLD.ops_snapshot_json OR NEW.created_at IS NOT OLD.created_at OR OLD.state<>'pending' OR NEW.state<>'completed' OR NEW.completion_json IS NULL
BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-receipt-immutable'); END;
CREATE TRIGGER shared_profile_recovery_receipt_no_delete BEFORE DELETE ON shared_profile_authority_recoveries BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-receipt-immutable'); END;
CREATE TRIGGER shared_profile_recovery_step_no_update BEFORE UPDATE ON shared_profile_authority_recovery_steps BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-step-immutable'); END;
CREATE TRIGGER shared_profile_recovery_step_no_delete BEFORE DELETE ON shared_profile_authority_recovery_steps BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-step-immutable'); END;
CREATE TRIGGER shared_profile_recovery_audit_no_update BEFORE UPDATE ON shared_profile_authority_recovery_audit BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-audit-immutable'); END;
CREATE TRIGGER shared_profile_recovery_audit_no_delete BEFORE DELETE ON shared_profile_authority_recovery_audit BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-audit-immutable'); END;
CREATE TRIGGER shared_profile_recovery_head_insert BEFORE INSERT ON shared_profile_portal_authority_heads
WHEN EXISTS(SELECT 1 FROM shared_profile_authority_recoveries WHERE state='pending') AND NOT EXISTS(
 SELECT 1 FROM shared_profile_authority_recovery_steps step JOIN shared_profile_authority_recoveries receipt ON receipt.operation_id=step.operation_id AND receipt.state='pending'
 WHERE step.workspace_id=NEW.workspace_id AND step.source_id=NEW.source_id AND step.revision=NEW.revision AND step.step_id=NEW.operation_id AND NEW.state='blocked')
BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-maintenance'); END;
CREATE TRIGGER shared_profile_recovery_head_update BEFORE UPDATE ON shared_profile_portal_authority_heads
WHEN EXISTS(SELECT 1 FROM shared_profile_authority_recoveries WHERE state='pending') AND NOT EXISTS(
 SELECT 1 FROM shared_profile_authority_recovery_steps step JOIN shared_profile_authority_recoveries receipt ON receipt.operation_id=step.operation_id AND receipt.state='pending'
 WHERE step.workspace_id=NEW.workspace_id AND step.source_id=NEW.source_id AND step.revision=NEW.revision AND step.step_id=NEW.operation_id AND NEW.state='blocked'
 AND NEW.workspace_id=OLD.workspace_id AND NEW.source_id=OLD.source_id AND NEW.revision=OLD.revision+1)
BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-maintenance'); END;
CREATE TRIGGER shared_profile_recovery_head_delete BEFORE DELETE ON shared_profile_portal_authority_heads
WHEN EXISTS(SELECT 1 FROM shared_profile_authority_recoveries WHERE state='pending') BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-maintenance'); END;
CREATE VIEW shared_profile_authority_recovery_owners AS
SELECT DISTINCT staff.id staff_id,staff.access_subject,profile.login_email,admission.version admission_version,profile.version profile_version,
 edit.id profile_grant_id,link.id identity_grant_id
FROM staff_users staff JOIN native_staff_admissions admission ON admission.staff_id=staff.id AND admission.active=1 AND admission.bound_access_subject=staff.access_subject
JOIN native_staff_profiles profile ON profile.staff_id=staff.id
JOIN staff_role_assignments role ON role.staff_id=staff.id AND role.role_id IN('role-owner','role-admin') AND role.scope='global'
JOIN native_directory_grants edit ON edit.staff_id=staff.id AND edit.permission='directory.profile.edit' AND edit.scope_kind='global' AND edit.effect='allow' AND edit.active=1
JOIN native_directory_grants link ON link.staff_id=staff.id AND link.permission='directory.identity.link' AND link.scope_kind='global' AND link.effect='allow' AND link.active=1
WHERE staff.status='active' AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=staff.id AND deny.permission IN('directory.profile.edit','directory.identity.link') AND deny.effect='deny' AND deny.active=1);
CREATE TRIGGER shared_profile_recovery_request_owner BEFORE INSERT ON shared_profile_authority_recoveries
WHEN NOT EXISTS(SELECT 1 FROM shared_profile_authority_recovery_owners owner WHERE owner.staff_id=NEW.requested_by
 AND owner.staff_id=json_extract(NEW.actor_json,'$.staffId') AND owner.access_subject=json_extract(NEW.actor_json,'$.accessSubject')
 AND owner.login_email=json_extract(NEW.actor_json,'$.email') AND owner.admission_version=json_extract(NEW.actor_json,'$.admissionVersion')
 AND owner.profile_version=json_extract(NEW.actor_json,'$.profileVersion') AND owner.profile_grant_id=json_extract(NEW.actor_json,'$.profileGrantId') AND owner.identity_grant_id=json_extract(NEW.actor_json,'$.identityGrantId'))
BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-owner-required'); END;
CREATE TRIGGER shared_profile_recovery_audit_owner BEFORE INSERT ON shared_profile_authority_recovery_audit
WHEN NOT EXISTS(SELECT 1 FROM shared_profile_authority_recovery_owners owner WHERE owner.staff_id=NEW.actor_id
 AND owner.staff_id=json_extract(NEW.actor_json,'$.staffId') AND owner.access_subject=json_extract(NEW.actor_json,'$.accessSubject')
 AND owner.login_email=json_extract(NEW.actor_json,'$.email') AND owner.admission_version=json_extract(NEW.actor_json,'$.admissionVersion')
 AND owner.profile_version=json_extract(NEW.actor_json,'$.profileVersion') AND owner.profile_grant_id=json_extract(NEW.actor_json,'$.profileGrantId') AND owner.identity_grant_id=json_extract(NEW.actor_json,'$.identityGrantId'))
BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-owner-required'); END;

CREATE TRIGGER shared_profile_recovery_step_owner BEFORE INSERT ON shared_profile_authority_recovery_steps
WHEN NOT EXISTS(SELECT 1 FROM shared_profile_authority_recovery_owners owner WHERE owner.staff_id=json_extract(NEW.actor_json,'$.staffId')
 AND owner.access_subject=json_extract(NEW.actor_json,'$.accessSubject') AND owner.login_email=json_extract(NEW.actor_json,'$.email')
 AND owner.admission_version=json_extract(NEW.actor_json,'$.admissionVersion') AND owner.profile_version=json_extract(NEW.actor_json,'$.profileVersion')
 AND owner.profile_grant_id=json_extract(NEW.actor_json,'$.profileGrantId') AND owner.identity_grant_id=json_extract(NEW.actor_json,'$.identityGrantId'))
BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-owner-required'); END;
CREATE TRIGGER shared_profile_recovery_complete_owner BEFORE UPDATE ON shared_profile_authority_recoveries
WHEN NOT EXISTS(SELECT 1 FROM shared_profile_authority_recovery_owners owner WHERE owner.staff_id=json_extract(NEW.completion_json,'$.actor.staffId')
 AND owner.access_subject=json_extract(NEW.completion_json,'$.actor.accessSubject') AND owner.login_email=json_extract(NEW.completion_json,'$.actor.email')
 AND owner.admission_version=json_extract(NEW.completion_json,'$.actor.admissionVersion') AND owner.profile_version=json_extract(NEW.completion_json,'$.actor.profileVersion')
 AND owner.profile_grant_id=json_extract(NEW.completion_json,'$.actor.profileGrantId') AND owner.identity_grant_id=json_extract(NEW.completion_json,'$.actor.identityGrantId'))
BEGIN SELECT RAISE(ABORT,'shared-profile-recovery-owner-required'); END;
