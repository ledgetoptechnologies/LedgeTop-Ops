PRAGMA foreign_keys=ON;
-- Explicit administrator-reviewed correspondence. No rows or source aliases are seeded.
CREATE TABLE portal_directory_correspondence_revisions(
 id TEXT PRIMARY KEY, directory_source_id TEXT NOT NULL CHECK(directory_source_id LIKE 'project-alpha:%' AND directory_source_id<>'project-alpha:primary'),
 portal_source_id TEXT NOT NULL CHECK(portal_source_id='project-alpha:primary'),
 source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
 proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),proof_sha256 TEXT NOT NULL CHECK(length(proof_sha256)=64),
 operation_id TEXT NOT NULL UNIQUE,actor_staff_id TEXT NOT NULL REFERENCES staff_users(id),created_at TEXT NOT NULL DEFAULT(datetime('now')),
 UNIQUE(id,directory_source_id,portal_source_id)
);
CREATE TABLE portal_directory_correspondence_receipts(
 operation_id TEXT PRIMARY KEY,directory_source_id TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES portal_directory_correspondence_revisions(id),
 action TEXT NOT NULL CHECK(action IN('approve','revoke')),expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 resulting_version INTEGER NOT NULL CHECK(resulting_version=expected_version+1),request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 actor_staff_id TEXT NOT NULL REFERENCES staff_users(id),actor_access_subject TEXT NOT NULL,
 admission_version INTEGER NOT NULL,profile_version INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE portal_directory_correspondence_heads(
 directory_source_id TEXT PRIMARY KEY,portal_source_id TEXT NOT NULL CHECK(portal_source_id='project-alpha:primary'),
 revision_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),state TEXT NOT NULL CHECK(state IN('active','revoked')),
 operation_id TEXT NOT NULL UNIQUE REFERENCES portal_directory_correspondence_receipts(operation_id),
 FOREIGN KEY(revision_id,directory_source_id,portal_source_id) REFERENCES portal_directory_correspondence_revisions(id,directory_source_id,portal_source_id)
);
CREATE UNIQUE INDEX portal_directory_correspondence_one_primary ON portal_directory_correspondence_heads(portal_source_id) WHERE state='active';
CREATE TRIGGER portal_directory_correspondence_revision_proof BEFORE INSERT ON portal_directory_correspondence_revisions
WHEN json_type(NEW.proof_json)<>'object' OR (SELECT count(*) FROM json_each(NEW.proof_json))<>12
 OR EXISTS(SELECT 1 FROM json_each(NEW.proof_json) field WHERE field.key NOT IN('directorySourceId','portalSourceId','sourceInstanceId','applicationId','historyEpochId','baseUrl','producerBindingId','applicationKey','connectorRevision','connectorVersion','currentKeyFingerprint','primaryAuthorityVersion'))
 OR json_type(NEW.proof_json,'$.primaryAuthorityVersion') IS NOT 'integer' OR json_extract(NEW.proof_json,'$.primaryAuthorityVersion')<1
 OR json_type(NEW.proof_json,'$.connectorRevision') IS NOT 'integer' OR json_type(NEW.proof_json,'$.connectorVersion') IS NOT 'integer'
 OR json_extract(NEW.proof_json,'$.directorySourceId') IS NOT NEW.directory_source_id
 OR json_extract(NEW.proof_json,'$.portalSourceId') IS NOT NEW.portal_source_id
 OR json_extract(NEW.proof_json,'$.sourceInstanceId') IS NOT NEW.source_instance_id
 OR json_extract(NEW.proof_json,'$.applicationId') IS NOT NEW.application_id
 OR json_extract(NEW.proof_json,'$.historyEpochId') IS NOT NEW.history_epoch_id
 OR EXISTS(SELECT 1 FROM pa_connectors other WHERE other.source_id=NEW.directory_source_id)
 OR NOT EXISTS(SELECT 1 FROM pa_connectors connector JOIN pa_connector_revisions signing
   ON signing.source_id=connector.source_id AND signing.revision=connector.active_revision
   WHERE connector.source_id=NEW.portal_source_id AND connector.profile='primary_legacy' AND connector.state='active' AND connector.read_visible=1
   AND connector.producer_binding_id=json_extract(NEW.proof_json,'$.producerBindingId')
   AND connector.snapshot_origin=json_extract(NEW.proof_json,'$.baseUrl') AND connector.application_key=json_extract(NEW.proof_json,'$.applicationKey')
   AND connector.active_revision=json_extract(NEW.proof_json,'$.connectorRevision') AND connector.version=json_extract(NEW.proof_json,'$.connectorVersion')
   AND signing.current_key_fingerprint=json_extract(NEW.proof_json,'$.currentKeyFingerprint'))
BEGIN SELECT RAISE(ABORT,'portal_correspondence_producer_changed'); END;
CREATE TRIGGER portal_directory_correspondence_receipt_revision BEFORE INSERT ON portal_directory_correspondence_receipts
WHEN NOT EXISTS(SELECT 1 FROM portal_directory_correspondence_revisions revision WHERE revision.id=NEW.revision_id
 AND revision.directory_source_id=NEW.directory_source_id
 AND (NEW.action='revoke' OR (revision.operation_id=NEW.operation_id AND revision.actor_staff_id=NEW.actor_staff_id)))
BEGIN SELECT RAISE(ABORT,'portal_correspondence_receipt_revision_changed'); END;
CREATE TRIGGER portal_directory_correspondence_revision_immutable BEFORE UPDATE ON portal_directory_correspondence_revisions
BEGIN SELECT RAISE(ABORT,'portal_correspondence_revision_immutable'); END;
CREATE TRIGGER portal_directory_correspondence_revision_no_delete BEFORE DELETE ON portal_directory_correspondence_revisions
BEGIN SELECT RAISE(ABORT,'portal_correspondence_revision_immutable'); END;
CREATE TRIGGER portal_directory_correspondence_receipt_immutable BEFORE UPDATE ON portal_directory_correspondence_receipts
BEGIN SELECT RAISE(ABORT,'portal_correspondence_receipt_immutable'); END;
CREATE TRIGGER portal_directory_correspondence_receipt_no_delete BEFORE DELETE ON portal_directory_correspondence_receipts
BEGIN SELECT RAISE(ABORT,'portal_correspondence_receipt_immutable'); END;
CREATE TRIGGER portal_directory_correspondence_head_no_delete BEFORE DELETE ON portal_directory_correspondence_heads
BEGIN SELECT RAISE(ABORT,'portal_correspondence_head_immutable'); END;
CREATE TRIGGER portal_directory_correspondence_receipt_actor BEFORE INSERT ON portal_directory_correspondence_receipts
WHEN NOT EXISTS(SELECT 1 FROM staff_users staff
 JOIN native_staff_admissions admission ON admission.staff_id=staff.id
 JOIN native_staff_profiles profile ON profile.staff_id=staff.id
 WHERE staff.id=NEW.actor_staff_id AND staff.access_subject=NEW.actor_access_subject AND staff.status='active'
 AND admission.active=1 AND admission.bound_access_subject=staff.access_subject AND admission.version=NEW.admission_version
 AND profile.version=NEW.profile_version AND lower(profile.login_email)=lower(staff.email)
 AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=staff.id AND role.role_id IN('role-owner','role-admin') AND role.scope='global')
 AND (EXISTS(SELECT 1 FROM staff_role_assignments role JOIN role_permissions p ON p.role_id=role.role_id WHERE role.staff_id=staff.id AND role.scope='global' AND p.permission_key='integrations.manage')
 OR EXISTS(SELECT 1 FROM local_staff_role_assignments role JOIN role_permissions p ON p.role_id=role.role_id WHERE role.staff_id=staff.id AND role.scope='global' AND p.permission_key='integrations.manage')
 OR EXISTS(SELECT 1 FROM staff_permission_overrides p WHERE p.staff_id=staff.id AND p.permission_key='integrations.manage' AND p.scope='global' AND p.effect='allow'))
 AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides p WHERE p.staff_id=staff.id AND p.permission_key='integrations.manage' AND p.scope='global' AND p.effect='deny'))
BEGIN SELECT RAISE(ABORT,'portal_correspondence_actor_changed'); END;
CREATE TRIGGER portal_directory_correspondence_head_insert BEFORE INSERT ON portal_directory_correspondence_heads
WHEN NEW.version<>1 OR NEW.state<>'active' OR NOT EXISTS(SELECT 1 FROM portal_directory_correspondence_receipts receipt
 WHERE receipt.operation_id=NEW.operation_id AND receipt.directory_source_id=NEW.directory_source_id AND receipt.revision_id=NEW.revision_id
 AND receipt.action='approve' AND receipt.expected_version=0 AND receipt.resulting_version=NEW.version)
BEGIN SELECT RAISE(ABORT,'portal_correspondence_head_changed'); END;
CREATE TRIGGER portal_directory_correspondence_head_update BEFORE UPDATE ON portal_directory_correspondence_heads
WHEN NEW.directory_source_id<>OLD.directory_source_id OR NEW.portal_source_id<>OLD.portal_source_id OR NEW.version<>OLD.version+1
 OR NOT EXISTS(SELECT 1 FROM portal_directory_correspondence_receipts receipt WHERE receipt.operation_id=NEW.operation_id
 AND receipt.directory_source_id=NEW.directory_source_id AND receipt.revision_id=NEW.revision_id
 AND receipt.expected_version=OLD.version AND receipt.resulting_version=NEW.version
 AND ((receipt.action='approve' AND NEW.state='active' AND NEW.revision_id<>OLD.revision_id)
 OR(receipt.action='revoke' AND OLD.state='active' AND NEW.state='revoked' AND NEW.revision_id=OLD.revision_id)))
BEGIN SELECT RAISE(ABORT,'portal_correspondence_head_changed'); END;
ALTER TABLE shared_profile_portal_grants ADD COLUMN directory_source_id TEXT;
ALTER TABLE shared_profile_portal_grants ADD COLUMN correspondence_revision_id TEXT REFERENCES portal_directory_correspondence_revisions(id);
CREATE TRIGGER shared_profile_portal_correspondence_pair BEFORE INSERT ON shared_profile_portal_grants
WHEN (NEW.directory_source_id IS NULL)<>(NEW.correspondence_revision_id IS NULL)
 OR(NEW.directory_source_id IS NOT NULL AND (NEW.source_id<>'project-alpha:primary' OR NEW.directory_source_id=NEW.source_id
 OR NOT EXISTS(SELECT 1 FROM portal_directory_correspondence_heads head JOIN portal_directory_correspondence_revisions revision ON revision.id=head.revision_id
 WHERE head.directory_source_id=NEW.directory_source_id AND head.portal_source_id=NEW.source_id AND head.revision_id=NEW.correspondence_revision_id AND head.state='active'
 AND revision.source_instance_id=NEW.source_instance_id AND revision.application_id=NEW.application_id AND revision.history_epoch_id=NEW.history_epoch_id)))
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_correspondence_changed'); END;
CREATE TRIGGER shared_profile_portal_correspondence_identity BEFORE UPDATE ON shared_profile_portal_grants
WHEN NEW.directory_source_id IS NOT OLD.directory_source_id OR NEW.correspondence_revision_id IS NOT OLD.correspondence_revision_id
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_correspondence_immutable'); END;

-- Preserve physical portal authority while proving the reviewed logical PA mapping.
DROP TRIGGER shared_profile_portal_write_fence_guard;
CREATE TRIGGER shared_profile_portal_write_fence_guard BEFORE INSERT ON shared_profile_portal_write_fences
WHEN NOT EXISTS(SELECT 1 FROM shared_profile_portal_grants g
 JOIN shared_profile_portal_authority_heads a ON a.workspace_id=g.workspace_id AND a.source_id=g.source_id
 JOIN native_directory_shared_profiles p ON p.id=g.group_id
 JOIN native_directory_shared_profile_members member ON member.group_id=p.id AND member.record_id=g.record_id
 JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=g.record_id AND mapping.source_id=COALESCE(g.directory_source_id,g.source_id)
 WHERE ((g.directory_source_id IS NULL AND g.correspondence_revision_id IS NULL) OR EXISTS(
 SELECT 1 FROM portal_directory_correspondence_heads bridge JOIN portal_directory_correspondence_revisions revision ON revision.id=bridge.revision_id
 JOIN pa_connectors connector ON connector.source_id=bridge.portal_source_id
 JOIN pa_connector_revisions signing ON signing.source_id=connector.source_id AND signing.revision=connector.active_revision
 WHERE (WITH correspondence_predicates(allowed) AS (VALUES
 (bridge.directory_source_id=g.directory_source_id),
 (bridge.portal_source_id=g.source_id),
 (bridge.revision_id=g.correspondence_revision_id),
 (bridge.state='active'),
 (revision.source_instance_id=g.source_instance_id),
 (revision.application_id=g.application_id),
 (revision.history_epoch_id=g.history_epoch_id),
 (connector.profile='primary_legacy'),
 (connector.state='active'),
 (connector.read_visible=1),
 (connector.producer_binding_id=json_extract(revision.proof_json,'$.producerBindingId')),
 (connector.snapshot_origin=json_extract(revision.proof_json,'$.baseUrl')),
 (connector.application_key=json_extract(revision.proof_json,'$.applicationKey')),
 (connector.active_revision=json_extract(revision.proof_json,'$.connectorRevision')),
 (connector.version=json_extract(revision.proof_json,'$.connectorVersion')),
 (signing.current_key_fingerprint=json_extract(revision.proof_json,'$.currentKeyFingerprint'))
 ) SELECT MIN(coalesce(allowed,0)) FROM correspondence_predicates)=1)) AND g.id=NEW.grant_id AND g.state='active' AND g.revision=NEW.grant_revision
 AND g.issuer=NEW.issuer AND g.subject=NEW.subject AND g.group_id=NEW.group_id
 AND g.target_public_id=mapping.project_alpha_public_id AND mapping.resource_type=g.target_type
 AND mapping.source_instance_id=g.source_instance_id AND mapping.application_id=g.application_id AND mapping.history_epoch_id=g.history_epoch_id
 AND a.state='active' AND a.revision=NEW.authority_revision
 AND datetime(NEW.verified_until)>datetime('now') AND datetime(NEW.verified_until)<=datetime('now','+60 seconds')
 AND p.version=NEW.expected_group_version AND json(p.membership_json)=json(g.group_membership_json))
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_authority_changed'); END;

DROP VIEW operations_directory_live_write_fences;
DROP VIEW operations_directory_live_portal_write_fences;
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
JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=grant_row.record_id AND mapping.source_id=COALESCE(grant_row.directory_source_id,grant_row.source_id)
WHERE (WITH policy_predicates(authorized) AS (VALUES
 (((grant_row.directory_source_id IS NULL AND grant_row.correspondence_revision_id IS NULL) OR EXISTS(
 SELECT 1 FROM portal_directory_correspondence_heads bridge JOIN portal_directory_correspondence_revisions revision ON revision.id=bridge.revision_id
 JOIN pa_connectors connector ON connector.source_id=bridge.portal_source_id
 JOIN pa_connector_revisions signing ON signing.source_id=connector.source_id AND signing.revision=connector.active_revision
 WHERE (WITH correspondence_predicates(allowed) AS (VALUES
 (bridge.directory_source_id=grant_row.directory_source_id),
 (bridge.portal_source_id=grant_row.source_id),
 (bridge.revision_id=grant_row.correspondence_revision_id),
 (bridge.state='active'),
 (revision.source_instance_id=grant_row.source_instance_id),
 (revision.application_id=grant_row.application_id),
 (revision.history_epoch_id=grant_row.history_epoch_id),
 (connector.profile='primary_legacy'),
 (connector.state='active'),
 (connector.read_visible=1),
 (connector.producer_binding_id=json_extract(revision.proof_json,'$.producerBindingId')),
 (connector.snapshot_origin=json_extract(revision.proof_json,'$.baseUrl')),
 (connector.application_key=json_extract(revision.proof_json,'$.applicationKey')),
 (connector.active_revision=json_extract(revision.proof_json,'$.connectorRevision')),
 (connector.version=json_extract(revision.proof_json,'$.connectorVersion')),
 (signing.current_key_fingerprint=json_extract(revision.proof_json,'$.currentKeyFingerprint'))
 ) SELECT MIN(coalesce(allowed,0)) FROM correspondence_predicates)=1))),
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
DROP TRIGGER native_directory_shared_portal_command_authority;
CREATE TRIGGER native_directory_shared_portal_command_authority BEFORE INSERT ON native_directory_shared_profile_commands
WHEN NEW.actor_kind='portal' AND NOT EXISTS(SELECT 1 FROM shared_profile_portal_write_fences proof
 JOIN shared_profile_portal_grants g ON g.id=proof.grant_id JOIN shared_profile_portal_authority_heads h ON h.workspace_id=g.workspace_id AND h.source_id=g.source_id
 JOIN native_directory_shared_profiles p ON p.id=proof.group_id
 JOIN project_alpha_active_directory_mappings m ON m.record_id=g.record_id AND m.source_id=COALESCE(g.directory_source_id,g.source_id)
 WHERE ((g.directory_source_id IS NULL AND g.correspondence_revision_id IS NULL) OR EXISTS(
 SELECT 1 FROM portal_directory_correspondence_heads bridge JOIN portal_directory_correspondence_revisions revision ON revision.id=bridge.revision_id
 JOIN pa_connectors connector ON connector.source_id=bridge.portal_source_id
 JOIN pa_connector_revisions signing ON signing.source_id=connector.source_id AND signing.revision=connector.active_revision
 WHERE (WITH correspondence_predicates(allowed) AS (VALUES
 (bridge.directory_source_id=g.directory_source_id),
 (bridge.portal_source_id=g.source_id),
 (bridge.revision_id=g.correspondence_revision_id),
 (bridge.state='active'),
 (revision.source_instance_id=g.source_instance_id),
 (revision.application_id=g.application_id),
 (revision.history_epoch_id=g.history_epoch_id),
 (connector.profile='primary_legacy'),
 (connector.state='active'),
 (connector.read_visible=1),
 (connector.producer_binding_id=json_extract(revision.proof_json,'$.producerBindingId')),
 (connector.snapshot_origin=json_extract(revision.proof_json,'$.baseUrl')),
 (connector.application_key=json_extract(revision.proof_json,'$.applicationKey')),
 (connector.active_revision=json_extract(revision.proof_json,'$.connectorRevision')),
 (connector.version=json_extract(revision.proof_json,'$.connectorVersion')),
 (signing.current_key_fingerprint=json_extract(revision.proof_json,'$.currentKeyFingerprint'))
 ) SELECT MIN(coalesce(allowed,0)) FROM correspondence_predicates)=1)) AND proof.mutation_id=NEW.mutation_id AND proof.group_id=NEW.group_id AND proof.expected_group_version=NEW.expected_version
 AND proof.request_sha256=NEW.request_sha256 AND NEW.actor_id='portal:'||g.id
 AND g.state='active' AND g.revision=proof.grant_revision AND g.issuer=proof.issuer AND g.subject=proof.subject
 AND h.state='active' AND h.revision=proof.authority_revision AND julianday(proof.verified_until)>julianday('now')
 AND p.version=NEW.expected_version AND json(p.membership_json)=json(g.group_membership_json)
 AND m.resource_type=g.target_type AND m.project_alpha_public_id=g.target_public_id
 AND m.source_instance_id=g.source_instance_id AND m.application_id=g.application_id AND m.history_epoch_id=g.history_epoch_id
 AND (p.kind<>'client' OR NEW.identity_safe_contact_profile=1))
BEGIN SELECT RAISE(ABORT,'shared_profile_command_portal_authority'); END;

-- A previously admitted orphan receipt cannot activate authority after its actor changes.
CREATE TRIGGER portal_directory_correspondence_head_actor_insert BEFORE INSERT ON portal_directory_correspondence_heads
WHEN NOT EXISTS(SELECT 1 FROM portal_directory_correspondence_receipts receipt JOIN staff_users staff ON receipt.operation_id=NEW.operation_id
 JOIN native_staff_admissions admission ON admission.staff_id=staff.id
 JOIN native_staff_profiles profile ON profile.staff_id=staff.id
 WHERE staff.id=receipt.actor_staff_id AND staff.access_subject=receipt.actor_access_subject AND staff.status='active'
 AND admission.active=1 AND admission.bound_access_subject=staff.access_subject AND admission.version=receipt.admission_version
 AND profile.version=receipt.profile_version AND lower(profile.login_email)=lower(staff.email)
 AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=staff.id AND role.role_id IN('role-owner','role-admin') AND role.scope='global')
 AND (EXISTS(SELECT 1 FROM staff_role_assignments role JOIN role_permissions p ON p.role_id=role.role_id WHERE role.staff_id=staff.id AND role.scope='global' AND p.permission_key='integrations.manage')
 OR EXISTS(SELECT 1 FROM local_staff_role_assignments role JOIN role_permissions p ON p.role_id=role.role_id WHERE role.staff_id=staff.id AND role.scope='global' AND p.permission_key='integrations.manage')
 OR EXISTS(SELECT 1 FROM staff_permission_overrides p WHERE p.staff_id=staff.id AND p.permission_key='integrations.manage' AND p.scope='global' AND p.effect='allow'))
 AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides p WHERE p.staff_id=staff.id AND p.permission_key='integrations.manage' AND p.scope='global' AND p.effect='deny'))
BEGIN SELECT RAISE(ABORT,'portal_correspondence_head_actor_changed'); END;
CREATE TRIGGER portal_directory_correspondence_head_actor_update BEFORE UPDATE ON portal_directory_correspondence_heads
WHEN NOT EXISTS(SELECT 1 FROM portal_directory_correspondence_receipts receipt JOIN staff_users staff ON receipt.operation_id=NEW.operation_id
 JOIN native_staff_admissions admission ON admission.staff_id=staff.id
 JOIN native_staff_profiles profile ON profile.staff_id=staff.id
 WHERE staff.id=receipt.actor_staff_id AND staff.access_subject=receipt.actor_access_subject AND staff.status='active'
 AND admission.active=1 AND admission.bound_access_subject=staff.access_subject AND admission.version=receipt.admission_version
 AND profile.version=receipt.profile_version AND lower(profile.login_email)=lower(staff.email)
 AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=staff.id AND role.role_id IN('role-owner','role-admin') AND role.scope='global')
 AND (EXISTS(SELECT 1 FROM staff_role_assignments role JOIN role_permissions p ON p.role_id=role.role_id WHERE role.staff_id=staff.id AND role.scope='global' AND p.permission_key='integrations.manage')
 OR EXISTS(SELECT 1 FROM local_staff_role_assignments role JOIN role_permissions p ON p.role_id=role.role_id WHERE role.staff_id=staff.id AND role.scope='global' AND p.permission_key='integrations.manage')
 OR EXISTS(SELECT 1 FROM staff_permission_overrides p WHERE p.staff_id=staff.id AND p.permission_key='integrations.manage' AND p.scope='global' AND p.effect='allow'))
 AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides p WHERE p.staff_id=staff.id AND p.permission_key='integrations.manage' AND p.scope='global' AND p.effect='deny'))
BEGIN SELECT RAISE(ABORT,'portal_correspondence_head_actor_changed'); END;
