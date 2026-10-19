PRAGMA foreign_keys=ON;

-- Exact current local/durable organization heads used by the execution fence.
-- A reviewed plan is evidence, never a substitute for current mapping/ACK state.
CREATE VIEW client_onboarding_shared_company_parent_heads AS
WITH mapping AS MATERIALIZED (
 SELECT active.*,record.current_version local_version,json_extract(destination.value,'$.origin') origin FROM project_alpha_active_directory_mappings active
 JOIN operations_directory_records record ON record.record_id=active.record_id AND record.record_kind='organization'
 JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
 JOIN json_each(enrollment.destinations_json) destination
  ON json_extract(destination.value,'$.sourceId')=active.source_id
  AND json_extract(destination.value,'$.sourceInstanceUUID')=active.source_instance_id
  AND json_extract(destination.value,'$.applicationUUID')=active.application_id
  AND json_extract(destination.value,'$.historyEpoch')=active.history_epoch_id
 WHERE active.resource_type='organization'
  AND EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution
   JOIN client_onboarding_shared_company_plan_children child ON child.plan_id=execution.plan_id
   JOIN json_each(child.destinations_json) selected ON json_extract(selected.value,'$.sourceId')=active.source_id
   WHERE child.parent_record_id=active.record_id)
), delivered AS MATERIALIZED (
 SELECT mapping.record_id,mapping.local_version,mapping.source_id,mapping.source_instance_id,mapping.application_id,mapping.history_epoch_id,
  intent.destination_origin origin,mapping.external_id,mapping.project_alpha_public_id public_id,evidence.revision,0 priority,'' received_at,'' receipt_id
 FROM mapping JOIN project_alpha_directory_validated_materialized_acknowledgements evidence
  ON evidence.record_id=mapping.record_id AND evidence.record_version=mapping.local_version AND evidence.record_kind='organization'
  AND evidence.source_id=mapping.source_id AND evidence.source_instance_id=mapping.source_instance_id
  AND evidence.application_id=mapping.application_id AND evidence.history_epoch_id=mapping.history_epoch_id
  AND evidence.public_id=mapping.project_alpha_public_id AND evidence.identity_valid=1
 JOIN operations_directory_intents intent ON intent.intent_id=evidence.intent_id AND intent.state='acknowledged'
  AND intent.external_canonical_id=mapping.external_id AND intent.destination_origin=evidence.destination_origin
), refreshed AS MATERIALIZED (
 SELECT mapping.record_id,mapping.local_version,mapping.source_id,mapping.source_instance_id,mapping.application_id,mapping.history_epoch_id,
  mapping.origin,mapping.external_id,mapping.project_alpha_public_id public_id,refresh.live_revision revision,1 priority,refresh.received_at,refresh.receipt_id
 FROM mapping JOIN project_alpha_existing_directory_binding_revision_refresh_receipts refresh
  ON refresh.record_id=mapping.record_id AND refresh.local_record_version=mapping.local_version AND refresh.resource_type='organization'
  AND refresh.source_id=mapping.source_id AND refresh.source_instance_id=mapping.source_instance_id
  AND refresh.application_id=mapping.application_id AND refresh.history_epoch_id=mapping.history_epoch_id
  AND refresh.external_id=mapping.external_id AND refresh.project_alpha_public_id=mapping.project_alpha_public_id
 WHERE mapping.mapping_kind='acquired'
), activated AS MATERIALIZED (
 SELECT mapping.record_id,mapping.local_version,mapping.source_id,mapping.source_instance_id,mapping.application_id,mapping.history_epoch_id,
  mapping.origin,mapping.external_id,mapping.project_alpha_public_id public_id,activation.project_alpha_revision revision,2 priority,'' received_at,'' receipt_id
 FROM mapping JOIN project_alpha_existing_directory_binding_activation_receipts activation
  ON activation.activation_id=mapping.provenance_id AND activation.record_id=mapping.record_id
  AND activation.local_record_version=mapping.local_version AND activation.resource_type='organization'
  AND activation.source_id=mapping.source_id AND activation.source_instance_id=mapping.source_instance_id
  AND activation.application_id=mapping.application_id AND activation.history_epoch_id=mapping.history_epoch_id
  AND activation.external_id=mapping.external_id AND activation.project_alpha_public_id=mapping.project_alpha_public_id
 WHERE mapping.mapping_kind='acquired'
), candidates AS MATERIALIZED (SELECT * FROM delivered UNION ALL SELECT * FROM refreshed UNION ALL SELECT * FROM activated),
ranked AS MATERIALIZED (
 SELECT candidates.*,row_number() OVER(PARTITION BY record_id,source_id ORDER BY priority,received_at DESC,receipt_id DESC,length(revision) DESC,revision DESC) selection_rank
 FROM candidates
)
SELECT record_id,local_version,source_id,source_instance_id,application_id,history_epoch_id,origin,external_id,public_id,revision
FROM ranked candidate WHERE selection_rank=1
 AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_unsettled_commands pending WHERE pending.source_id=candidate.source_id
  AND pending.expected_source_instance_id=candidate.source_instance_id AND pending.application_id=candidate.application_id
  AND pending.expected_history_epoch_id=candidate.history_epoch_id AND pending.resource_type='organization'
  AND pending.external_id=candidate.external_id AND pending.state<>'acknowledged');

CREATE TABLE client_onboarding_shared_company_execution_fences(
 plan_id TEXT PRIMARY KEY REFERENCES client_onboarding_shared_company_plan_seals(plan_id),decision_id TEXT NOT NULL UNIQUE,
 request_sha256 TEXT NOT NULL,verified_until TEXT NOT NULL,
 configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
 parent_proofs_json TEXT NOT NULL CHECK(json_valid(parent_proofs_json)),
 generation_receipts_json TEXT NOT NULL CHECK(json_valid(generation_receipts_json)),
 remaining_children INTEGER NOT NULL CHECK(remaining_children BETWEEN 0 AND 2)
);
CREATE VIEW client_onboarding_live_shared_company_execution_fences AS
SELECT fence.*,plan.submission_id,plan.invitation_id,plan.fields_sha256,plan.reviewer_staff_id,plan.reviewer_subject,
 plan.reviewer_email,plan.reviewer_admission_version,plan.reviewer_profile_version,plan.client_profile_json,plan.scopes_json
FROM client_onboarding_shared_company_execution_fences fence
JOIN client_onboarding_shared_company_plans plan ON plan.plan_id=fence.plan_id
JOIN client_onboarding_shared_company_plan_seals seal ON seal.plan_id=plan.plan_id
WHERE fence.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child
  LEFT JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=child.parent_record_id
  WHERE child.plan_id=plan.plan_id AND(enrollment.record_id IS NULL OR json(enrollment.destinations_json)<>json(child.parent_enrollment_json)))
 AND json_array_length(fence.parent_proofs_json)=json_array_length(plan.source_ids_json)
 AND json_array_length(fence.configuration_json)=json_array_length(plan.source_ids_json)
 AND json_array_length(fence.generation_receipts_json)=json_array_length(plan.source_ids_json)
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child JOIN json_each(child.destinations_json) destination
  WHERE child.plan_id=plan.plan_id AND NOT EXISTS(
   SELECT 1 FROM json_each(fence.parent_proofs_json) fresh
   JOIN json_each(child.parent_bindings_json) reviewed ON json_extract(reviewed.value,'$.sourceId')=json_extract(fresh.value,'$.sourceId')
   JOIN client_onboarding_shared_company_parent_heads head ON head.record_id=child.parent_record_id AND head.local_version=child.parent_record_version
    AND head.source_id=json_extract(destination.value,'$.sourceId') AND head.source_instance_id=json_extract(destination.value,'$.sourceInstanceUUID')
    AND head.application_id=json_extract(destination.value,'$.applicationUUID') AND head.history_epoch_id=json_extract(destination.value,'$.historyEpoch')
    AND head.origin=json_extract(destination.value,'$.origin')
   WHERE json_extract(fresh.value,'$.sourceId')=head.source_id
    AND json_extract(fresh.value,'$.sourceInstanceId')=head.source_instance_id
    AND json_extract(fresh.value,'$.applicationId')=head.application_id AND json_extract(fresh.value,'$.historyEpoch')=head.history_epoch_id
    AND json_extract(fresh.value,'$.binding.type')='organization' AND json_extract(fresh.value,'$.binding.externalId')=head.external_id
    AND json_extract(fresh.value,'$.binding.publicId')=head.public_id AND json_extract(fresh.value,'$.resource.revision')=head.revision
    AND json_extract(fresh.value,'$.resource.present')=1
    AND json_extract(fresh.value,'$.authorizationGeneration')=json_extract(destination.value,'$.expectedAuthorizationGeneration')
    AND json_extract(fresh.value,'$.binding')=json_extract(reviewed.value,'$.binding')
    AND json_extract(fresh.value,'$.resource')=json_extract(reviewed.value,'$.resource')
    AND json_extract(fresh.value,'$.authorizationGeneration')=json_extract(reviewed.value,'$.authorizationGeneration')
    AND EXISTS(SELECT 1 FROM json_each(fence.configuration_json) configuration
      WHERE json_extract(configuration.value,'$.sourceId')=head.source_id
       AND json_extract(configuration.value,'$.sourceInstanceUUID')=head.source_instance_id
       AND json_extract(configuration.value,'$.applicationUUID')=head.application_id
       AND json_extract(configuration.value,'$.historyEpoch')=head.history_epoch_id
       AND json_extract(configuration.value,'$.origin')=head.origin)
    AND EXISTS(SELECT 1 FROM json_each(fence.generation_receipts_json) selected
      JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.request_id=json_extract(selected.value,'$.requestId')
       AND receipt.source_id=head.source_id AND receipt.source_instance_id=head.source_instance_id
       AND receipt.application_id=head.application_id AND receipt.history_epoch_id=head.history_epoch_id AND receipt.inventory_kind='directory'
       AND receipt.authorization_generation=json_extract(fresh.value,'$.authorizationGeneration')
       AND receipt.observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')
       AND receipt.observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE json_extract(selected.value,'$.sourceId')=head.source_id)))
 AND NOT EXISTS(SELECT 1 FROM json_each(plan.source_ids_json) selected WHERE
   (SELECT count(*) FROM json_each(fence.parent_proofs_json) p WHERE json_extract(p.value,'$.sourceId')=selected.value)<>1);
CREATE TRIGGER client_onboarding_shared_company_execution_insert AFTER INSERT ON client_onboarding_shared_company_execution_fences
WHEN NEW.remaining_children<>(SELECT child_count FROM client_onboarding_shared_company_plan_seals WHERE plan_id=NEW.plan_id)
 OR NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_company_execution_fences live WHERE live.plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company execution evidence changed'); END;

CREATE TABLE client_onboarding_shared_company_child_receipts(
 decision_id TEXT NOT NULL,plan_id TEXT NOT NULL,client_record_id TEXT NOT NULL,
 PRIMARY KEY(decision_id,client_record_id),UNIQUE(plan_id,client_record_id),
 FOREIGN KEY(plan_id,client_record_id) REFERENCES client_onboarding_shared_company_plan_children(plan_id,client_record_id)
);
CREATE TRIGGER client_onboarding_shared_company_child_receipt_insert BEFORE INSERT ON client_onboarding_shared_company_child_receipts
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution
 JOIN client_onboarding_shared_company_plans plan ON plan.plan_id=execution.plan_id
 JOIN client_onboarding_shared_company_plan_children child ON child.plan_id=execution.plan_id AND child.client_record_id=NEW.client_record_id
 JOIN operations_directory_records record ON record.record_id=child.client_record_id AND record.record_kind='client' AND record.current_version=1
 JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=1 AND revision.mutation_id=child.mutation_id
 JOIN operations_directory_audit audit ON audit.record_id=record.record_id AND audit.record_version=1 AND audit.mutation_id=child.mutation_id
  AND audit.actor_type='staff' AND audit.actor_id=plan.reviewer_staff_id AND audit.original_verified_access_subject=plan.reviewer_subject
 JOIN native_directory_create_admissions admission ON admission.id=child.create_admission_id AND admission.record_id=record.record_id
  AND admission.record_kind='client' AND admission.staff_id=plan.reviewer_staff_id AND admission.bound_access_subject=plan.reviewer_subject
  AND admission.active=0 AND admission.consumed_mutation_id=child.mutation_id
 JOIN operations_directory_client_organizations relation ON relation.client_record_id=record.record_id AND relation.relationship_version=1
  AND relation.organization_record_id=child.parent_record_id
 JOIN operations_directory_client_organization_history history ON history.client_record_id=record.record_id AND history.relationship_version=1
  AND history.mutation_id=child.relationship_mutation_id AND history.organization_record_id=child.parent_record_id AND history.client_record_version=1
 WHERE execution.plan_id=NEW.plan_id AND execution.decision_id=NEW.decision_id AND execution.remaining_children>0
  AND json(revision.profile_json)=json(plan.client_profile_json)
  AND json(admission.profile_json)=json(plan.client_profile_json) AND json(admission.scopes_json)=json(plan.scopes_json)
  AND json(admission.destinations_json)=json((SELECT json_group_array(json_remove(value,'$.expectedAuthorizationGeneration')) FROM json_each(child.destinations_json)))
)
BEGIN SELECT RAISE(ABORT,'onboarding shared company child artifacts incomplete'); END;
CREATE TRIGGER client_onboarding_shared_company_child_delivery_guard BEFORE INSERT ON client_onboarding_shared_company_child_receipts
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution
 JOIN client_onboarding_shared_company_plan_children child ON child.plan_id=execution.plan_id AND child.client_record_id=NEW.client_record_id
 WHERE execution.plan_id=NEW.plan_id AND execution.decision_id=NEW.decision_id
  AND (SELECT count(*) FROM operations_directory_intents intent WHERE intent.mutation_id=child.mutation_id)=json_array_length(child.destinations_json)
  AND NOT EXISTS(SELECT 1 FROM json_each(child.destinations_json) destination WHERE NOT EXISTS(
   SELECT 1 FROM operations_directory_intents intent
   JOIN operations_directory_intent_relationship_dependencies dependency ON dependency.intent_id=intent.intent_id
   JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
   JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id AND outbox.state='pending'
   WHERE (intent.record_id=child.client_record_id AND intent.record_version=1 AND intent.mutation_id=child.mutation_id AND intent.state='materialized')
    AND (intent.source_id=json_extract(destination.value,'$.sourceId') AND intent.source_instance_uuid=json_extract(destination.value,'$.sourceInstanceUUID')
     AND intent.application_uuid=json_extract(destination.value,'$.applicationUUID') AND intent.expected_history_epoch_id=json_extract(destination.value,'$.historyEpoch'))
    AND (intent.destination_origin=json_extract(destination.value,'$.origin') AND intent.external_canonical_id=child.client_record_id)
    AND (dependency.organization_record_id=child.parent_record_id AND dependency.organization_record_version=child.parent_record_version
     AND dependency.client_record_id=child.client_record_id AND dependency.relationship_mutation_id=child.relationship_mutation_id)
    AND (json_extract(outbox.command_json,'$.operation')='create' AND json_extract(outbox.command_json,'$.externalId')=child.client_record_id
     AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')=json_extract(destination.value,'$.expectedAuthorizationGeneration'))
    AND EXISTS(SELECT 1 FROM json_each(child.parent_bindings_json) proof
     WHERE json_extract(proof.value,'$.sourceId')=intent.source_id
      AND json_extract(proof.value,'$.binding.publicId')=json_extract(outbox.command_json,'$.fields.organizationPublicId')))))
BEGIN SELECT RAISE(ABORT,'onboarding shared company child delivery incomplete'); END;
CREATE TRIGGER client_onboarding_shared_company_child_receipt_consume AFTER INSERT ON client_onboarding_shared_company_child_receipts
BEGIN UPDATE client_onboarding_shared_company_execution_fences SET remaining_children=remaining_children-1 WHERE plan_id=NEW.plan_id; END;
CREATE TRIGGER client_onboarding_shared_company_child_receipt_immutable BEFORE UPDATE ON client_onboarding_shared_company_child_receipts
BEGIN SELECT RAISE(ABORT,'onboarding shared company child receipt immutable'); END;
CREATE TRIGGER client_onboarding_shared_company_child_receipt_durable BEFORE DELETE ON client_onboarding_shared_company_child_receipts
BEGIN SELECT RAISE(ABORT,'onboarding shared company child receipt durable'); END;
CREATE TRIGGER client_onboarding_shared_company_execution_update BEFORE UPDATE ON client_onboarding_shared_company_execution_fences
WHEN NEW.plan_id IS NOT OLD.plan_id OR NEW.decision_id IS NOT OLD.decision_id OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.verified_until IS NOT OLD.verified_until OR NEW.configuration_json IS NOT OLD.configuration_json
 OR NEW.parent_proofs_json IS NOT OLD.parent_proofs_json OR NEW.generation_receipts_json IS NOT OLD.generation_receipts_json
 OR NEW.remaining_children<>OLD.remaining_children-1
 OR NEW.remaining_children<>(SELECT child_count-(SELECT count(*) FROM client_onboarding_shared_company_child_receipts receipt WHERE receipt.plan_id=NEW.plan_id)
   FROM client_onboarding_shared_company_plan_seals seal WHERE seal.plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company execution fence immutable'); END;
CREATE TRIGGER client_onboarding_shared_company_member_admission BEFORE INSERT ON native_directory_create_admissions
WHEN NEW.id LIKE 'client-onboarding-member:%' AND NOT EXISTS(
 SELECT 1 FROM client_onboarding_shared_company_execution_fences execution
 JOIN client_onboarding_shared_company_plans plan ON plan.plan_id=execution.plan_id
 JOIN client_onboarding_shared_company_plan_children child ON child.plan_id=execution.plan_id
 WHERE child.create_admission_id=NEW.id AND child.client_record_id=NEW.record_id AND NEW.record_kind='client'
  AND NEW.staff_id=plan.reviewer_staff_id AND NEW.issued_by=plan.reviewer_staff_id AND NEW.bound_access_subject=plan.reviewer_subject
  AND json(NEW.profile_json)=json(plan.client_profile_json) AND json(NEW.scopes_json)=json(plan.scopes_json)
  AND json(NEW.destinations_json)=json((SELECT json_group_array(json_remove(value,'$.expectedAuthorizationGeneration')) FROM json_each(child.destinations_json))))
BEGIN SELECT RAISE(ABORT,'onboarding member admission requires exact approved execution'); END;

-- The primary decision receipt retains its original nine-field contract.
-- This append-only relation carries the full selected-child approval.
CREATE TABLE client_onboarding_shared_company_approvals(
 decision_id TEXT PRIMARY KEY REFERENCES client_onboarding_decisions(decision_id),
 plan_id TEXT NOT NULL UNIQUE REFERENCES client_onboarding_shared_company_plan_seals(plan_id)
);
CREATE TRIGGER client_onboarding_shared_company_approval_insert BEFORE INSERT ON client_onboarding_shared_company_approvals
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution
 JOIN client_onboarding_decisions decision ON decision.decision_id=execution.decision_id
 WHERE execution.plan_id=NEW.plan_id AND execution.decision_id=NEW.decision_id AND execution.remaining_children=0
  AND decision.request_sha256=execution.request_sha256
  AND (SELECT count(*) FROM client_onboarding_shared_company_child_receipts receipt WHERE receipt.plan_id=execution.plan_id)=
      (SELECT child_count FROM client_onboarding_shared_company_plan_seals seal WHERE seal.plan_id=execution.plan_id))
BEGIN SELECT RAISE(ABORT,'onboarding shared company approval incomplete'); END;
CREATE TRIGGER client_onboarding_shared_company_approval_immutable BEFORE UPDATE ON client_onboarding_shared_company_approvals
BEGIN SELECT RAISE(ABORT,'onboarding shared company approval immutable'); END;
CREATE TRIGGER client_onboarding_shared_company_approval_durable BEFORE DELETE ON client_onboarding_shared_company_approvals
BEGIN SELECT RAISE(ABORT,'onboarding shared company approval durable'); END;
CREATE TRIGGER client_onboarding_shared_company_approval_stage AFTER INSERT ON client_onboarding_shared_company_approvals
BEGIN
 INSERT INTO client_onboarding_portal_activation_intents(decision_id,client_record_id,policy,destinations_json)
 SELECT NEW.decision_id,decision.client_record_id,'own_client_profile_v1',
  (SELECT json_group_array(json_remove(destination.value,'$.expectedAuthorizationGeneration'))
   FROM client_onboarding_shared_company_plan_children child JOIN json_each(child.destinations_json) destination
   WHERE child.plan_id=NEW.plan_id)
 FROM client_onboarding_decisions decision WHERE decision.decision_id=NEW.decision_id;
END;
CREATE TRIGGER client_onboarding_shared_company_execution_complete BEFORE DELETE ON client_onboarding_shared_company_execution_fences
WHEN OLD.remaining_children<>0 OR NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_approvals approval
 WHERE approval.decision_id=OLD.decision_id AND approval.plan_id=OLD.plan_id)
 OR EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child
  JOIN operations_directory_write_fences fence ON fence.mutation_id=child.mutation_id WHERE child.plan_id=OLD.plan_id)
 OR EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child
  JOIN operations_directory_relationship_write_fences fence ON fence.mutation_id=child.relationship_mutation_id WHERE child.plan_id=OLD.plan_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company execution incomplete'); END;

-- Decision-owned contact grouping requires every exact own-client proof first.
-- It never fabricates the interactive pair-merge preview used by other flows.
CREATE TABLE client_onboarding_shared_contact_creation_fences(
 decision_id TEXT PRIMARY KEY REFERENCES client_onboarding_shared_company_approvals(decision_id),
 mutation_id TEXT NOT NULL UNIQUE,actor_id TEXT NOT NULL,
 profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),membership_json TEXT NOT NULL CHECK(json_valid(membership_json))
);
CREATE VIEW client_onboarding_live_shared_contact_creation_fences AS
SELECT fence.* FROM client_onboarding_shared_contact_creation_fences fence
JOIN client_onboarding_shared_company_approvals approval ON approval.decision_id=fence.decision_id
JOIN client_onboarding_shared_company_plans plan ON plan.plan_id=approval.plan_id
JOIN client_onboarding_decisions decision ON decision.decision_id=fence.decision_id AND decision.reviewer_staff_id=fence.actor_id
JOIN client_onboarding_portal_activation_intents intent ON intent.decision_id=decision.decision_id AND intent.state='pending'
JOIN native_staff_admissions admission ON admission.staff_id=decision.reviewer_staff_id AND admission.active=1
 AND admission.version=decision.original_admission_version AND admission.bound_access_subject=decision.reviewer_subject
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=decision.original_profile_version
 AND profile.login_email=decision.reviewer_email
JOIN staff_users staff ON staff.id=admission.staff_id AND staff.status='active' AND staff.access_subject=admission.bound_access_subject
 AND staff.email=profile.login_email
WHERE json(fence.profile_json)=json(json_remove(plan.client_profile_json,'$.clientType'))
 AND json(fence.membership_json)=json((SELECT json_group_array(client_record_id) FROM(
  SELECT client_record_id FROM client_onboarding_shared_company_plan_children child WHERE child.plan_id=plan.plan_id ORDER BY client_record_id)))
 AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=staff.id AND role.scope='global' AND role.role_id IN('role-owner','role-admin'))
 AND EXISTS(SELECT 1 FROM native_directory_shared_profiles company WHERE company.id=plan.company_group_id AND company.kind='organization'
  AND json_array_length(company.membership_json)=json_array_length(plan.company_members_json)
  AND NOT EXISTS(SELECT 1 FROM json_each(plan.company_members_json) chosen WHERE NOT EXISTS(
   SELECT 1 FROM native_directory_shared_profile_members member WHERE member.group_id=company.id
    AND member.record_id=json_extract(chosen.value,'$.recordId'))))
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child
  LEFT JOIN operations_directory_lifecycle_state client_state ON client_state.record_id=child.client_record_id
  LEFT JOIN operations_directory_lifecycle_state parent_state ON parent_state.record_id=child.parent_record_id
  WHERE child.plan_id=plan.plan_id AND(coalesce(client_state.status,'active')<>'active' OR coalesce(parent_state.status,'active')<>'active'))
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child
  JOIN operations_directory_records record ON record.record_id=child.client_record_id
  JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
  JOIN operations_directory_client_organizations relation ON relation.client_record_id=record.record_id
  WHERE child.plan_id=plan.plan_id AND(record.current_version<>1 OR json(revision.profile_json)<>json(plan.client_profile_json)
   OR relation.relationship_version<>1 OR relation.organization_record_id<>child.parent_record_id))
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child JOIN json_each(child.destinations_json) destination
  WHERE child.plan_id=plan.plan_id AND NOT EXISTS(SELECT 1 FROM client_onboarding_portal_activation_proofs proof
   WHERE proof.decision_id=fence.decision_id AND proof.record_id=child.client_record_id
    AND proof.source_id=json_extract(destination.value,'$.sourceId')));
CREATE TRIGGER client_onboarding_shared_contact_creation_insert AFTER INSERT ON client_onboarding_shared_contact_creation_fences
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_contact_creation_fences live WHERE live.decision_id=NEW.decision_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared contact grouping outside approval'); END;
CREATE TRIGGER client_onboarding_shared_contact_creation_immutable BEFORE UPDATE ON client_onboarding_shared_contact_creation_fences
BEGIN SELECT RAISE(ABORT,'onboarding shared contact grouping immutable'); END;
CREATE TRIGGER client_onboarding_shared_contact_creation_complete BEFORE DELETE ON client_onboarding_shared_contact_creation_fences
WHEN NOT EXISTS(SELECT 1 FROM native_directory_shared_profiles profile WHERE profile.id=OLD.decision_id
 AND profile.kind='client' AND profile.profile_json=OLD.profile_json AND profile.membership_json=OLD.membership_json
 AND(SELECT count(*) FROM native_directory_shared_profile_members member WHERE member.group_id=profile.id)=json_array_length(profile.membership_json))
BEGIN SELECT RAISE(ABORT,'onboarding shared contact grouping incomplete'); END;

DROP TRIGGER client_onboarding_decisions_insert_guard;
CREATE TRIGGER client_onboarding_decisions_protocol_exclusive BEFORE INSERT ON client_onboarding_decisions
WHEN EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution WHERE execution.decision_id=NEW.decision_id)
 AND EXISTS(SELECT 1 FROM client_onboarding_decision_fences legacy WHERE legacy.decision_id=NEW.decision_id)
BEGIN SELECT RAISE(ABORT,'client onboarding approval protocols cannot be mixed'); END;
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

BEGIN SELECT RAISE(ABORT,'client onboarding decision artifacts are incomplete'); END;

CREATE TRIGGER client_onboarding_decisions_legacy_insert_guard BEFORE INSERT ON client_onboarding_decisions
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution WHERE execution.decision_id=NEW.decision_id)
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_live_decision_fences fence
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

CREATE TRIGGER client_onboarding_decisions_shared_insert_guard BEFORE INSERT ON client_onboarding_decisions
WHEN EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution WHERE execution.decision_id=NEW.decision_id)
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution
    JOIN client_onboarding_shared_company_plans plan ON plan.plan_id=execution.plan_id
    JOIN client_onboarding_submissions submission ON submission.submission_id=plan.submission_id
    JOIN client_onboarding_shared_company_plan_children child ON child.plan_id=plan.plan_id
    WHERE execution.decision_id=NEW.decision_id AND execution.remaining_children=0
      AND NEW.outcome='approved' AND NEW.request_sha256=execution.request_sha256
      AND NEW.submission_id=plan.submission_id AND NEW.invitation_id=plan.invitation_id AND NEW.fields_sha256=plan.fields_sha256
      AND NEW.reviewer_staff_id=plan.reviewer_staff_id AND NEW.reviewer_subject=plan.reviewer_subject
      AND NEW.reviewer_email=plan.reviewer_email AND NEW.original_admission_version=plan.reviewer_admission_version
      AND NEW.original_profile_version=plan.reviewer_profile_version AND NEW.reason='Approved reviewed shared company onboarding'
      AND (SELECT count(*) FROM json_each(NEW.reviewed_fields_json))=(SELECT count(*) FROM json_each(submission.fields_json))
      AND NOT EXISTS(SELECT 1 FROM json_each(submission.fields_json) field
       WHERE field.type<>'text' OR json_extract(NEW.reviewed_fields_json,'$.'||field.key) IS NOT field.value)
      AND NEW.client_record_id=child.client_record_id AND NEW.client_record_version=1 AND NEW.relationship_version=1
      AND NEW.organization_record_id=child.parent_record_id AND NEW.organization_record_version=child.parent_record_version
      AND child.client_record_id=(SELECT min(client_record_id) FROM client_onboarding_shared_company_plan_children first WHERE first.plan_id=plan.plan_id)
      AND (SELECT count(*) FROM client_onboarding_shared_company_child_receipts receipt WHERE receipt.plan_id=plan.plan_id)=
          (SELECT child_count FROM client_onboarding_shared_company_plan_seals seal WHERE seal.plan_id=plan.plan_id))
BEGIN SELECT RAISE(ABORT,'client onboarding decision artifacts are incomplete'); END;

DROP TRIGGER native_directory_shared_group_insert;
CREATE TRIGGER native_directory_shared_group_insert BEFORE INSERT ON native_directory_shared_profiles
WHEN (NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_creation_fences fence WHERE fence.group_id=NEW.id
 AND fence.actor_id=NEW.created_by AND fence.kind=NEW.kind AND fence.profile_json=NEW.profile_json AND fence.membership_json=NEW.membership_json)
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_contact_creation_fences fence WHERE fence.decision_id=NEW.id
  AND NEW.kind='client' AND fence.actor_id=NEW.created_by AND fence.profile_json=NEW.profile_json
  AND fence.membership_json=NEW.membership_json))
 OR NOT EXISTS(SELECT 1 FROM staff_users actor JOIN native_staff_admissions admission ON admission.staff_id=actor.id
 WHERE actor.id=NEW.created_by AND actor.status='active' AND admission.active=1 AND actor.access_subject=admission.bound_access_subject
 AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission='directory.profile.edit' AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
 AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission='directory.identity.link' AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
 AND NOT EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission IN('directory.profile.edit','directory.identity.link') AND g.effect='deny' AND g.active=1))
 OR (json_array_length(NEW.membership_json)=2 AND json_extract(NEW.membership_json,'$[0]')>=json_extract(NEW.membership_json,'$[1]'))
 OR EXISTS(SELECT 1 FROM effective_native_directory_enrollments a JOIN effective_native_directory_enrollments b
 ON a.record_id=json_extract(NEW.membership_json,'$[0]') AND b.record_id=json_extract(NEW.membership_json,'$[1]')
 JOIN json_each(a.destinations_json) da JOIN json_each(b.destinations_json) db
 WHERE json_extract(da.value,'$.sourceId')=json_extract(db.value,'$.sourceId'))
BEGIN SELECT RAISE(ABORT,'shared_profile_group_authority'); END;

DROP TRIGGER client_onboarding_portal_activation_proof_insert;
CREATE TRIGGER client_onboarding_portal_activation_proof_insert BEFORE INSERT ON client_onboarding_portal_activation_proofs
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_portal_activation_intents intent
 WHERE intent.decision_id=NEW.decision_id AND intent.state='pending'
 AND json_extract(NEW.binding_observation_json,'$.sourceId')=NEW.source_id
 AND json_extract(NEW.binding_observation_json,'$.clientPortalIdentity.state')='eligible'
 AND json_extract(NEW.binding_observation_json,'$.clientPortalIdentity.principalPublicId')=NEW.principal_public_id
 AND json_extract(NEW.binding_observation_json,'$.clientPortalIdentity.associationVersion')=NEW.association_version
 AND ((intent.client_record_id=NEW.record_id
  AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_approvals shared WHERE shared.decision_id=intent.decision_id)
  AND EXISTS(SELECT 1 FROM json_each(intent.destinations_json) destination WHERE json_extract(destination.value,'$.sourceId')=NEW.source_id))
 OR EXISTS(SELECT 1 FROM client_onboarding_shared_company_approvals approval
  JOIN client_onboarding_shared_company_plan_children child ON child.plan_id=approval.plan_id AND child.client_record_id=NEW.record_id
  JOIN json_each(child.destinations_json) destination ON json_extract(destination.value,'$.sourceId')=NEW.source_id
  JOIN operations_directory_records record ON record.record_id=child.client_record_id AND record.current_version=1
  JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=record.record_id AND mapping.resource_type='client'
   AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=json_extract(destination.value,'$.sourceInstanceUUID')
   AND mapping.application_id=json_extract(destination.value,'$.applicationUUID') AND mapping.history_epoch_id=json_extract(destination.value,'$.historyEpoch')
   AND mapping.external_id=child.client_record_id
  JOIN project_alpha_directory_validated_materialized_acknowledgements evidence ON evidence.record_id=record.record_id
   AND evidence.record_kind='client' AND evidence.record_version=1 AND evidence.identity_valid=1
   AND evidence.source_id=mapping.source_id AND evidence.source_instance_id=mapping.source_instance_id
   AND evidence.application_id=mapping.application_id AND evidence.history_epoch_id=mapping.history_epoch_id
   AND evidence.public_id=mapping.project_alpha_public_id AND evidence.destination_origin=json_extract(destination.value,'$.origin')
  WHERE approval.decision_id=intent.decision_id
   AND json_extract(NEW.binding_observation_json,'$.sourceInstanceId')=mapping.source_instance_id
   AND json_extract(NEW.binding_observation_json,'$.applicationId')=mapping.application_id
   AND json_extract(NEW.binding_observation_json,'$.historyEpoch')=mapping.history_epoch_id
   AND json_extract(NEW.binding_observation_json,'$.binding.type')='client'
   AND json_extract(NEW.binding_observation_json,'$.binding.externalId')=mapping.external_id
   AND json_extract(NEW.binding_observation_json,'$.binding.publicId')=mapping.project_alpha_public_id
   AND json_extract(NEW.binding_observation_json,'$.resource.present')=1
   AND json_extract(NEW.binding_observation_json,'$.resource.revision')=evidence.revision)))
BEGIN SELECT RAISE(ABORT,'onboarding_activation_proof_outside_approval'); END;

-- Authority and remote-evidence checks are separate mandatory guards. Combining
-- their expanded views exceeds D1's expression-depth limit; neither is optional.
CREATE TRIGGER client_onboarding_shared_execution_live_plan BEFORE INSERT ON client_onboarding_shared_company_execution_fences
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_company_plans plan WHERE plan.plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company live plan changed'); END;
CREATE TRIGGER client_onboarding_shared_child_live_plan BEFORE INSERT ON client_onboarding_shared_company_child_receipts
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_company_plans plan WHERE plan.plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company live plan changed'); END;
CREATE TRIGGER client_onboarding_shared_child_live_evidence BEFORE INSERT ON client_onboarding_shared_company_child_receipts
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_company_execution_fences execution WHERE execution.plan_id=NEW.plan_id AND execution.decision_id=NEW.decision_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company remote evidence changed'); END;
CREATE TRIGGER client_onboarding_shared_decision_live_plan BEFORE INSERT ON client_onboarding_decisions
WHEN EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution WHERE execution.decision_id=NEW.decision_id)
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution
 JOIN client_onboarding_live_shared_company_plans plan ON plan.plan_id=execution.plan_id WHERE execution.decision_id=NEW.decision_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company live plan changed'); END;
CREATE TRIGGER client_onboarding_shared_decision_live_evidence BEFORE INSERT ON client_onboarding_decisions
WHEN EXISTS(SELECT 1 FROM client_onboarding_shared_company_execution_fences execution WHERE execution.decision_id=NEW.decision_id)
 AND NOT EXISTS(SELECT 1 FROM client_onboarding_live_shared_company_execution_fences execution WHERE execution.decision_id=NEW.decision_id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company remote evidence changed'); END;

CREATE TRIGGER client_onboarding_shared_admission_live_plan BEFORE INSERT ON native_directory_create_admissions
WHEN NEW.id LIKE 'client-onboarding-member:%' AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child
 JOIN client_onboarding_live_shared_company_plans plan ON plan.plan_id=child.plan_id WHERE child.create_admission_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company live plan changed'); END;
CREATE TRIGGER client_onboarding_shared_admission_live_evidence BEFORE INSERT ON native_directory_create_admissions
WHEN NEW.id LIKE 'client-onboarding-member:%' AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child
 JOIN client_onboarding_live_shared_company_execution_fences execution ON execution.plan_id=child.plan_id WHERE child.create_admission_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'onboarding shared company remote evidence changed'); END;
