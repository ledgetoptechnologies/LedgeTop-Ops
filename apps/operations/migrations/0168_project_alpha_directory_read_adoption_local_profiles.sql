PRAGMA foreign_keys = ON;

-- Local-only application of the scalar dispositions sealed by 0163 and
-- prepared by 0167.  These receipts are deliberately unrelated to Directory
-- intents/materializations and therefore cannot enqueue a Project Alpha write.
CREATE TABLE project_alpha_directory_read_adoption_local_profile_receipts (
  adoption_id TEXT NOT NULL PRIMARY KEY CHECK(length(adoption_id)=36),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  finalization_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_finalizations(finalization_id) ON DELETE RESTRICT,
  field_review_receipt_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_field_review_receipts(receipt_id) ON DELETE RESTRICT,
  mutation_id TEXT NOT NULL UNIQUE,
  record_id TEXT NOT NULL, resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  expected_record_version INTEGER NOT NULL CHECK(expected_record_version>=1),
  expected_local_profile_sha256 TEXT NOT NULL CHECK(length(expected_local_profile_sha256)=64 AND expected_local_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_alpha_profile_sha256 TEXT NOT NULL CHECK(length(project_alpha_profile_sha256)=64 AND project_alpha_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  result_record_version INTEGER NOT NULL,
  result_profile_sha256 TEXT NOT NULL CHECK(length(result_profile_sha256)=64 AND result_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  adopted_fields_json TEXT NOT NULL CHECK(json_valid(adopted_fields_json) AND json_type(adopted_fields_json)='array'),
  actor_staff_id TEXT NOT NULL, actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  actor_grant_generation INTEGER NOT NULL CHECK(actor_grant_generation>=1),
  selected_profile_grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state='applied'),
  applied_at TEXT NOT NULL CHECK(length(applied_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',applied_at)=applied_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(result_record_version=expected_record_version+1),
  UNIQUE(record_id,expected_record_version)
);

CREATE TABLE project_alpha_directory_read_adoption_local_profile_events (
  adoption_id TEXT NOT NULL REFERENCES project_alpha_directory_read_adoption_local_profile_receipts(adoption_id) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK(state_version=1),
  event_id TEXT NOT NULL UNIQUE CHECK(length(event_id)=36),
  state TEXT NOT NULL CHECK(state='applied'),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
  PRIMARY KEY(adoption_id,state_version)
);

-- This fence exists only during one D1 batch.  Its JSON values are the CAS
-- material; the durable receipt stores hashes and field names, not a second
-- copy of the compared PA profile.
CREATE TABLE project_alpha_directory_read_adoption_local_profile_fences (
  mutation_id TEXT NOT NULL PRIMARY KEY,
  adoption_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE, request_sha256 TEXT NOT NULL,
  finalization_id TEXT NOT NULL UNIQUE, field_review_receipt_id TEXT NOT NULL UNIQUE,
  record_id TEXT NOT NULL UNIQUE, resource_type TEXT NOT NULL,
  expected_record_version INTEGER NOT NULL, expected_local_profile_sha256 TEXT NOT NULL,
  expected_profile_json TEXT NOT NULL CHECK(json_valid(expected_profile_json) AND json_type(expected_profile_json)='object'),
  project_alpha_profile_sha256 TEXT NOT NULL,
  project_alpha_profile_json TEXT NOT NULL CHECK(json_valid(project_alpha_profile_json) AND json_type(project_alpha_profile_json)='object'),
  result_profile_sha256 TEXT NOT NULL,
  result_profile_json TEXT NOT NULL CHECK(json_valid(result_profile_json) AND json_type(result_profile_json)='object'),
  adopted_fields_json TEXT NOT NULL CHECK(json_valid(adopted_fields_json) AND json_type(adopted_fields_json)='array'),
  actor_staff_id TEXT NOT NULL, actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL, actor_profile_version INTEGER NOT NULL, actor_grant_generation INTEGER NOT NULL,
  selected_profile_grant_id TEXT NOT NULL, audit_command_json TEXT NOT NULL CHECK(json_valid(audit_command_json)),
  applied_at TEXT NOT NULL,
  record_writes INTEGER NOT NULL DEFAULT 1 CHECK(record_writes BETWEEN 0 AND 1),
  revision_writes INTEGER NOT NULL DEFAULT 1 CHECK(revision_writes BETWEEN 0 AND 1),
  audit_writes INTEGER NOT NULL DEFAULT 1 CHECK(audit_writes BETWEEN 0 AND 1),
  receipt_writes INTEGER NOT NULL DEFAULT 1 CHECK(receipt_writes BETWEEN 0 AND 1),
  event_writes INTEGER NOT NULL DEFAULT 1 CHECK(event_writes BETWEEN 0 AND 1)
);

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_fences_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_local_profile_fences
WHEN NOT EXISTS(
  SELECT 1 FROM project_alpha_directory_read_adoption_finalizations finalization
  JOIN project_alpha_directory_read_adoption_field_review_receipts receipt
    ON receipt.receipt_id=finalization.field_review_receipt_id
  JOIN project_alpha_directory_read_adoption_field_review_audit review_audit ON review_audit.receipt_id=receipt.receipt_id
  JOIN operations_directory_records record ON record.record_id=receipt.record_id AND record.record_kind=receipt.resource_type
  JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
  JOIN native_staff_admissions admission ON admission.staff_id=receipt.reviewer_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE finalization.finalization_id=NEW.finalization_id AND finalization.state='prepared'
    AND finalization.field_review_receipt_id=NEW.field_review_receipt_id
    AND finalization.record_id=NEW.record_id AND finalization.resource_type=NEW.resource_type
    AND finalization.local_record_version=NEW.expected_record_version
    AND finalization.local_profile_sha256=NEW.expected_local_profile_sha256
    AND finalization.project_alpha_profile_sha256=NEW.project_alpha_profile_sha256
    AND receipt.record_id=NEW.record_id AND receipt.resource_type=NEW.resource_type
    AND receipt.local_record_version=NEW.expected_record_version
    AND receipt.local_profile_sha256=NEW.expected_local_profile_sha256
    AND receipt.project_alpha_profile_sha256=NEW.project_alpha_profile_sha256
    AND record.current_version=NEW.expected_record_version AND revision.profile_json=NEW.expected_profile_json
    AND review_audit.actor_staff_id=receipt.reviewer_staff_id
    AND receipt.reviewer_staff_id=NEW.actor_staff_id AND receipt.reviewer_access_subject=NEW.actor_access_subject
    AND receipt.reviewer_admission_version=NEW.actor_admission_version
    AND receipt.reviewer_profile_version=NEW.actor_profile_version
    AND finalization.reviewer_grant_generation=NEW.actor_grant_generation
    AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject
    AND admission.version=NEW.actor_admission_version AND profile.version=NEW.actor_profile_version
    AND generation.generation=NEW.actor_grant_generation
)
BEGIN SELECT RAISE(ABORT,'local profile adoption requires exact prepared review and current local CAS'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_fences_authority
BEFORE INSERT ON project_alpha_directory_read_adoption_local_profile_fences
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_records record
  JOIN native_directory_grants selected_grant ON selected_grant.id=NEW.selected_profile_grant_id
  WHERE record.record_id=NEW.record_id AND record.record_kind=NEW.resource_type AND record.current_version=NEW.expected_record_version
    AND selected_grant.staff_id=NEW.actor_staff_id AND selected_grant.permission='directory.profile.edit'
    AND selected_grant.effect='allow' AND selected_grant.active=1
    AND (selected_grant.scope_kind='global'
      OR (selected_grant.scope_kind='resource' AND selected_grant.resource_id=record.record_id)
      OR (selected_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
        WHERE assignment.record_id=record.record_id AND assignment.staff_id=NEW.actor_staff_id AND assignment.active=1))
      OR (selected_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=selected_grant.business_area_id))
      OR (selected_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=selected_grant.division_id)))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_grant
      WHERE deny_grant.staff_id=NEW.actor_staff_id AND deny_grant.permission='directory.profile.edit'
        AND deny_grant.effect='deny' AND deny_grant.active=1 AND (
          deny_grant.scope_kind='global' OR (deny_grant.scope_kind='resource' AND deny_grant.resource_id=record.record_id)
          OR (deny_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=record.record_id AND assignment.staff_id=NEW.actor_staff_id AND assignment.active=1))
          OR (deny_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=deny_grant.business_area_id))
          OR (deny_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=deny_grant.division_id))))
)
BEGIN SELECT RAISE(ABORT,'local profile adoption requires current explicit profile-edit authority'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_fences_decisions
BEFORE INSERT ON project_alpha_directory_read_adoption_local_profile_fences
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_finalizations finalization
  JOIN project_alpha_directory_read_adoption_field_review_receipts receipt ON receipt.receipt_id=finalization.field_review_receipt_id
  WHERE finalization.finalization_id=NEW.finalization_id AND receipt.receipt_id=NEW.field_review_receipt_id
    AND (SELECT count(*) FROM project_alpha_directory_read_adoption_field_decisions decision WHERE decision.receipt_id=receipt.receipt_id)=receipt.decision_count
    AND receipt.decision_count=CASE WHEN receipt.resource_type='client' THEN 11 ELSE 9 END
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND (decision.field_name NOT IN
        ('name','email','phone','address_line1','address_line2','city','state','postal_code','country','client_type','organization_public_id')
        OR (receipt.resource_type='organization' AND decision.field_name IN ('client_type','organization_public_id'))))
    AND finalization.adopted_field_count=(SELECT count(*) FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND decision.decision='adopt_project_alpha')
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND decision.decision='requires_follow_up')
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND decision.decision='adopt_project_alpha'
        AND decision.field_name IN ('client_type','organization_public_id'))
    AND (SELECT count(*) FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND decision.decision='adopt_project_alpha')>0
    AND json_array_length(NEW.adopted_fields_json)=(SELECT count(*) FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND decision.decision='adopt_project_alpha')
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) adopted
      WHERE adopted.type<>'text' OR adopted.value NOT IN ('name','email','phone','address_line1','address_line2','city','state','postal_code','country')
        OR NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions decision
          WHERE decision.receipt_id=receipt.receipt_id AND decision.field_name=adopted.value AND decision.decision='adopt_project_alpha'))
    AND (SELECT count(DISTINCT adopted.value) FROM json_each(NEW.adopted_fields_json) adopted)=json_array_length(NEW.adopted_fields_json)
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND decision.decision='adopt_project_alpha'
        AND NOT EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) adopted WHERE adopted.value=decision.field_name))
)
BEGIN SELECT RAISE(ABORT,'local profile adoption requires complete exact supported scalar decisions'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_fences_source_current
BEFORE INSERT ON project_alpha_directory_read_adoption_local_profile_fences
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_finalizations finalization
  JOIN project_alpha_api_v2_directory_observations_current observation
    ON observation.source_id=finalization.source_id AND observation.source_instance_id=finalization.source_instance_id
   AND observation.application_id=finalization.application_id AND observation.history_epoch_id=finalization.history_epoch_id
   AND observation.resource_type=finalization.resource_type AND observation.project_alpha_public_id=finalization.project_alpha_public_id
  JOIN project_alpha_api_v2_inventory_receipts inventory
    ON inventory.source_id=observation.source_id AND inventory.source_instance_id=observation.source_instance_id
   AND inventory.application_id=observation.application_id AND inventory.history_epoch_id=observation.history_epoch_id
   AND inventory.inventory_kind='directory' AND inventory.request_id=observation.request_id
  WHERE finalization.finalization_id=NEW.finalization_id
    AND observation.resource_revision=finalization.project_alpha_revision
    AND observation.binding_external_id=finalization.reviewed_external_id AND observation.binding_status='active'
    AND observation.binding_resource_revision=finalization.project_alpha_revision
    AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0
    AND inventory.authorization_generation=finalization.authorization_generation
    AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
      WHERE conflict.source_id=finalization.source_id AND conflict.inventory_kind='directory'
        AND (conflict.resource_type='source' OR (conflict.source_instance_id=finalization.source_instance_id
          AND conflict.application_id=finalization.application_id AND conflict.history_epoch_id=finalization.history_epoch_id
          AND conflict.resource_type=finalization.resource_type
          AND (conflict.project_alpha_public_id=finalization.project_alpha_public_id
            OR conflict.external_id=finalization.reviewed_external_id))))
)
BEGIN SELECT RAISE(ABORT,'local profile adoption requires current conflict-free Project Alpha evidence'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_fences_projection
BEFORE INSERT ON project_alpha_directory_read_adoption_local_profile_fences
WHEN (SELECT count(*) FROM json_each(NEW.result_profile_json))<>(SELECT count(*) FROM json_each(NEW.expected_profile_json))
  OR EXISTS(SELECT 1 FROM json_each(NEW.expected_profile_json) expected
    LEFT JOIN json_each(NEW.result_profile_json) result ON result.key=expected.key
    WHERE result.key IS NULL)
  OR json_type(NEW.result_profile_json,'$.name')<>'text'
  OR json_type(NEW.result_profile_json,'$.generalEmail')<>'text'
  OR json_type(NEW.result_profile_json,'$.generalPhone')<>'text'
  OR json_type(NEW.result_profile_json,'$.addressLine1')<>'text'
  OR json_type(NEW.result_profile_json,'$.addressLine2')<>'text'
  OR json_type(NEW.result_profile_json,'$.city')<>'text'
  OR json_type(NEW.result_profile_json,'$.state')<>'text'
  OR json_type(NEW.result_profile_json,'$.postalCode')<>'text'
  OR json_type(NEW.result_profile_json,'$.country')<>'text'
  OR json_extract(NEW.result_profile_json,'$.name')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='name') THEN json_extract(NEW.project_alpha_profile_json,'$.name') ELSE json_extract(NEW.expected_profile_json,'$.name') END
  OR json_extract(NEW.result_profile_json,'$.generalEmail')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='email') THEN coalesce(json_extract(NEW.project_alpha_profile_json,'$.email'),'') ELSE json_extract(NEW.expected_profile_json,'$.generalEmail') END
  OR json_extract(NEW.result_profile_json,'$.generalPhone')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='phone') THEN coalesce(json_extract(NEW.project_alpha_profile_json,'$.phone'),'') ELSE json_extract(NEW.expected_profile_json,'$.generalPhone') END
  OR json_extract(NEW.result_profile_json,'$.addressLine1')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='address_line1') THEN coalesce(json_extract(NEW.project_alpha_profile_json,'$.address.line1'),'') ELSE json_extract(NEW.expected_profile_json,'$.addressLine1') END
  OR json_extract(NEW.result_profile_json,'$.addressLine2')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='address_line2') THEN coalesce(json_extract(NEW.project_alpha_profile_json,'$.address.line2'),'') ELSE json_extract(NEW.expected_profile_json,'$.addressLine2') END
  OR json_extract(NEW.result_profile_json,'$.city')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='city') THEN coalesce(json_extract(NEW.project_alpha_profile_json,'$.address.city'),'') ELSE json_extract(NEW.expected_profile_json,'$.city') END
  OR json_extract(NEW.result_profile_json,'$.state')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='state') THEN coalesce(json_extract(NEW.project_alpha_profile_json,'$.address.state'),'') ELSE json_extract(NEW.expected_profile_json,'$.state') END
  OR json_extract(NEW.result_profile_json,'$.postalCode')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='postal_code') THEN coalesce(json_extract(NEW.project_alpha_profile_json,'$.address.postalCode'),'') ELSE json_extract(NEW.expected_profile_json,'$.postalCode') END
  OR json_extract(NEW.result_profile_json,'$.country')<>CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.adopted_fields_json) WHERE value='country') THEN coalesce(json_extract(NEW.project_alpha_profile_json,'$.address.country'),'') ELSE json_extract(NEW.expected_profile_json,'$.country') END
  OR EXISTS(SELECT 1 FROM json_each(NEW.expected_profile_json) expected
    JOIN json_each(NEW.result_profile_json) result ON result.key=expected.key
    WHERE expected.key NOT IN ('name','generalEmail','generalPhone','addressLine1','addressLine2','city','state','postalCode','country')
      AND (result.type<>expected.type OR result.value IS NOT expected.value))
BEGIN SELECT RAISE(ABORT,'local profile adoption result does not exactly apply sealed scalar decisions'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_fences_immutable
BEFORE UPDATE ON project_alpha_directory_read_adoption_local_profile_fences
WHEN NEW.mutation_id IS NOT OLD.mutation_id OR NEW.adoption_id IS NOT OLD.adoption_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.finalization_id IS NOT OLD.finalization_id OR NEW.field_review_receipt_id IS NOT OLD.field_review_receipt_id
  OR NEW.record_id IS NOT OLD.record_id OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.expected_record_version IS NOT OLD.expected_record_version
  OR NEW.expected_local_profile_sha256 IS NOT OLD.expected_local_profile_sha256
  OR NEW.expected_profile_json IS NOT OLD.expected_profile_json OR NEW.project_alpha_profile_sha256 IS NOT OLD.project_alpha_profile_sha256
  OR NEW.project_alpha_profile_json IS NOT OLD.project_alpha_profile_json OR NEW.result_profile_sha256 IS NOT OLD.result_profile_sha256
  OR NEW.result_profile_json IS NOT OLD.result_profile_json OR NEW.adopted_fields_json IS NOT OLD.adopted_fields_json
  OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject
  OR NEW.actor_admission_version IS NOT OLD.actor_admission_version OR NEW.actor_profile_version IS NOT OLD.actor_profile_version
  OR NEW.actor_grant_generation IS NOT OLD.actor_grant_generation OR NEW.selected_profile_grant_id IS NOT OLD.selected_profile_grant_id
  OR NEW.audit_command_json IS NOT OLD.audit_command_json OR NEW.applied_at IS NOT OLD.applied_at
  OR NEW.record_writes>OLD.record_writes OR NEW.revision_writes>OLD.revision_writes OR NEW.audit_writes>OLD.audit_writes
  OR NEW.receipt_writes>OLD.receipt_writes OR NEW.event_writes>OLD.event_writes
  OR (OLD.record_writes-NEW.record_writes)+(OLD.revision_writes-NEW.revision_writes)+(OLD.audit_writes-NEW.audit_writes)
    +(OLD.receipt_writes-NEW.receipt_writes)+(OLD.event_writes-NEW.event_writes)<>1
BEGIN SELECT RAISE(ABORT,'local profile adoption fence is immutable'); END;

-- Extend only the three existing native ledger entry guards.  The normal
-- write-fence branch is unchanged; the new branch never authorizes intents.
DROP TRIGGER operations_directory_records_write_guard_update;
CREATE TRIGGER operations_directory_records_write_guard_update BEFORE UPDATE ON operations_directory_records
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence WHERE fence.operation_kind='update'
  AND fence.record_id=OLD.record_id AND fence.record_kind=OLD.record_kind AND fence.expected_version=OLD.current_version
  AND fence.record_writes=1 AND NEW.current_version=OLD.current_version+1)
AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_local_profile_fences fence
  WHERE fence.record_id=OLD.record_id AND fence.resource_type=OLD.record_kind AND fence.expected_record_version=OLD.current_version
    AND fence.record_writes=1 AND NEW.current_version=OLD.current_version+1)
BEGIN SELECT RAISE(ABORT,'directory update requires current native authority'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_record_consume AFTER UPDATE ON operations_directory_records
BEGIN UPDATE project_alpha_directory_read_adoption_local_profile_fences SET record_writes=record_writes-1
  WHERE record_id=NEW.record_id AND expected_record_version=OLD.current_version AND record_writes=1; END;

DROP TRIGGER operations_directory_revisions_write_guard;
CREATE TRIGGER operations_directory_revisions_write_guard BEFORE INSERT ON operations_directory_revisions
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence WHERE fence.mutation_id=NEW.mutation_id
  AND fence.record_id=NEW.record_id AND NEW.version=fence.expected_version+1 AND fence.record_writes=0
  AND fence.revision_writes=1 AND json(NEW.profile_json)=json(fence.profile_json))
AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_local_profile_fences fence WHERE fence.mutation_id=NEW.mutation_id
  AND fence.record_id=NEW.record_id AND NEW.version=fence.expected_record_version+1 AND fence.record_writes=0
  AND fence.revision_writes=1 AND NEW.profile_json=fence.result_profile_json)
BEGIN SELECT RAISE(ABORT,'directory revision requires current native authority'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_revision_consume AFTER INSERT ON operations_directory_revisions
BEGIN UPDATE project_alpha_directory_read_adoption_local_profile_fences SET revision_writes=revision_writes-1
  WHERE mutation_id=NEW.mutation_id AND revision_writes=1; END;

DROP TRIGGER operations_directory_audit_write_guard;
CREATE TRIGGER operations_directory_audit_write_guard BEFORE INSERT ON operations_directory_audit
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence WHERE fence.mutation_id=NEW.mutation_id
  AND fence.record_id=NEW.record_id AND NEW.record_version=fence.expected_version+1 AND NEW.actor_type='staff'
  AND NEW.actor_id=fence.actor_id AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=1
  AND json(NEW.command_json)=json(fence.command_json))
AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_local_profile_fences fence WHERE fence.mutation_id=NEW.mutation_id
  AND fence.record_id=NEW.record_id AND NEW.record_version=fence.expected_record_version+1 AND NEW.actor_type='staff'
  AND NEW.actor_id=fence.actor_staff_id AND NEW.original_verified_access_subject=fence.actor_access_subject
  AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=1
  AND NEW.command_json=fence.audit_command_json)
BEGIN SELECT RAISE(ABORT,'directory audit requires current native authority'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_audit_consume AFTER INSERT ON operations_directory_audit
BEGIN UPDATE project_alpha_directory_read_adoption_local_profile_fences SET audit_writes=audit_writes-1
  WHERE mutation_id=NEW.mutation_id AND audit_writes=1; END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_receipts_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_local_profile_receipts
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_local_profile_fences fence
  WHERE fence.adoption_id=NEW.adoption_id AND fence.idempotency_key=NEW.idempotency_key AND fence.request_sha256=NEW.request_sha256
    AND fence.finalization_id=NEW.finalization_id AND fence.field_review_receipt_id=NEW.field_review_receipt_id
    AND fence.mutation_id=NEW.mutation_id AND fence.record_id=NEW.record_id AND fence.resource_type=NEW.resource_type
    AND fence.expected_record_version=NEW.expected_record_version
    AND fence.expected_local_profile_sha256=NEW.expected_local_profile_sha256
    AND fence.project_alpha_profile_sha256=NEW.project_alpha_profile_sha256
    AND NEW.result_record_version=fence.expected_record_version+1 AND fence.result_profile_sha256=NEW.result_profile_sha256
    AND json(fence.adopted_fields_json)=json(NEW.adopted_fields_json)
    AND fence.actor_staff_id=NEW.actor_staff_id AND fence.actor_access_subject=NEW.actor_access_subject
    AND fence.actor_admission_version=NEW.actor_admission_version AND fence.actor_profile_version=NEW.actor_profile_version
    AND fence.actor_grant_generation=NEW.actor_grant_generation AND fence.selected_profile_grant_id=NEW.selected_profile_grant_id
    AND NEW.state='applied' AND fence.applied_at=NEW.applied_at
    AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=0 AND fence.receipt_writes=1)
BEGIN SELECT RAISE(ABORT,'local profile adoption receipt requires exhausted exact fence'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_receipt_consume
AFTER INSERT ON project_alpha_directory_read_adoption_local_profile_receipts
BEGIN UPDATE project_alpha_directory_read_adoption_local_profile_fences SET receipt_writes=receipt_writes-1
  WHERE adoption_id=NEW.adoption_id AND receipt_writes=1; END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_events_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_local_profile_events
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_local_profile_receipts receipt
  JOIN project_alpha_directory_read_adoption_local_profile_fences fence ON fence.adoption_id=receipt.adoption_id
  WHERE receipt.adoption_id=NEW.adoption_id AND receipt.state=NEW.state AND NEW.state_version=1
    AND NEW.occurred_at=receipt.applied_at AND fence.receipt_writes=0 AND fence.event_writes=1)
BEGIN SELECT RAISE(ABORT,'local profile adoption event requires exact applied receipt'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_event_consume
AFTER INSERT ON project_alpha_directory_read_adoption_local_profile_events
BEGIN UPDATE project_alpha_directory_read_adoption_local_profile_fences SET event_writes=event_writes-1
  WHERE adoption_id=NEW.adoption_id AND event_writes=1; END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_fences_exhausted
BEFORE DELETE ON project_alpha_directory_read_adoption_local_profile_fences
WHEN OLD.record_writes<>0 OR OLD.revision_writes<>0 OR OLD.audit_writes<>0 OR OLD.receipt_writes<>0 OR OLD.event_writes<>0
BEGIN SELECT RAISE(ABORT,'local profile adoption fence is not exhausted'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_receipts_no_update BEFORE UPDATE ON project_alpha_directory_read_adoption_local_profile_receipts BEGIN SELECT RAISE(ABORT,'local profile adoption receipt is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_receipts_no_delete BEFORE DELETE ON project_alpha_directory_read_adoption_local_profile_receipts BEGIN SELECT RAISE(ABORT,'local profile adoption receipt is durable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_events_no_update BEFORE UPDATE ON project_alpha_directory_read_adoption_local_profile_events BEGIN SELECT RAISE(ABORT,'local profile adoption event is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_local_profile_events_no_delete BEFORE DELETE ON project_alpha_directory_read_adoption_local_profile_events BEGIN SELECT RAISE(ABORT,'local profile adoption event is durable'); END;
