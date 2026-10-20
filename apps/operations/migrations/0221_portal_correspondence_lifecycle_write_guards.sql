-- Existing reviewed correspondence remains valid across same-identity lifecycle advances.
-- Recreate only use-time guards; approval-time proof validation stays exact.
-- Producer identity, signing key, active revision/state/visibility, grant and all
-- profile/membership/fence checks remain unchanged. Applied history is immutable.

DROP TRIGGER shared_profile_portal_write_fence_guard;
DROP TRIGGER native_directory_shared_portal_command_authority;
DROP VIEW operations_directory_live_write_fences;
DROP VIEW operations_directory_live_portal_write_fences;

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
 (connector.version>=json_extract(revision.proof_json,'$.connectorVersion')),
 (signing.current_key_fingerprint=json_extract(revision.proof_json,'$.currentKeyFingerprint'))
 ) SELECT MIN(coalesce(allowed,0)) FROM correspondence_predicates)=1)) AND g.id=NEW.grant_id AND g.state='active' AND g.revision=NEW.grant_revision
 AND g.issuer=NEW.issuer AND g.subject=NEW.subject AND g.group_id=NEW.group_id
 AND g.target_public_id=mapping.project_alpha_public_id AND mapping.resource_type=g.target_type
 AND mapping.source_instance_id=g.source_instance_id AND mapping.application_id=g.application_id AND mapping.history_epoch_id=g.history_epoch_id
 AND a.state='active' AND a.revision=NEW.authority_revision
 AND datetime(NEW.verified_until)>datetime('now') AND datetime(NEW.verified_until)<=datetime('now','+60 seconds')
 AND p.version=NEW.expected_group_version AND json(p.membership_json)=json(g.group_membership_json))
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_authority_changed'); END;

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
 (connector.version>=json_extract(revision.proof_json,'$.connectorVersion')),
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
 (connector.version>=json_extract(revision.proof_json,'$.connectorVersion')),
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

