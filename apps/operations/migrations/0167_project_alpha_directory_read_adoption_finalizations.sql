PRAGMA foreign_keys = ON;

-- Durable staging handoff from a sealed, enum-only Directory field review to
-- the existing guarded acquisition/rebind pipeline.  A prepared row is not a
-- mapping and is intentionally invisible to Client Hub, portal, Delivery and
-- public-link readers.
CREATE TABLE project_alpha_directory_read_adoption_finalizations (
  finalization_id TEXT NOT NULL PRIMARY KEY CHECK(length(finalization_id)=36),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  field_review_receipt_id TEXT NOT NULL UNIQUE
    REFERENCES project_alpha_directory_read_adoption_field_review_receipts(receipt_id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_reviews(review_id) ON DELETE RESTRICT,
  claim_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_claims(claim_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL, history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  record_id TEXT NOT NULL, reviewed_external_id TEXT NOT NULL, target_external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL, project_alpha_revision TEXT NOT NULL, authorization_generation TEXT NOT NULL,
  local_record_version INTEGER NOT NULL CHECK(typeof(local_record_version)='integer' AND local_record_version>=1),
  local_profile_sha256 TEXT NOT NULL CHECK(length(local_profile_sha256)=64 AND local_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_alpha_profile_sha256 TEXT NOT NULL CHECK(length(project_alpha_profile_sha256)=64 AND project_alpha_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
  reviewer_staff_id TEXT NOT NULL, reviewer_access_subject TEXT NOT NULL,
  reviewer_admission_version INTEGER NOT NULL CHECK(reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(reviewer_profile_version>=1),
  reviewer_grant_generation INTEGER NOT NULL CHECK(reviewer_grant_generation>=1),
  adopted_field_count INTEGER NOT NULL CHECK(adopted_field_count BETWEEN 0 AND 11),
  rebind_required INTEGER NOT NULL CHECK(rebind_required IN (0,1)),
  acquisition_review_id TEXT NOT NULL UNIQUE CHECK(length(acquisition_review_id)=36),
  acquisition_command_id TEXT NOT NULL UNIQUE CHECK(length(acquisition_command_id)=36),
  activation_idempotency_key TEXT NOT NULL UNIQUE CHECK(length(activation_idempotency_key)=36),
  state TEXT NOT NULL CHECK(state='prepared'),
  prepared_at TEXT NOT NULL CHECK(length(prepared_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',prepared_at)=prepared_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(target_external_id=record_id),
  CHECK(rebind_required=(reviewed_external_id<>target_external_id)),
  CHECK(acquisition_review_id<>acquisition_command_id
    AND acquisition_review_id<>activation_idempotency_key
    AND acquisition_command_id<>activation_idempotency_key),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,record_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,reviewed_external_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id)
);

-- Recheck every durable local fence at the write boundary.  Remote profile and
-- binding observations are revalidated by the worker immediately before this
-- insert; only their pinned hashes/identity are persisted here.
CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_receipt_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_finalizations
WHEN NOT EXISTS (
  SELECT 1
  FROM project_alpha_directory_read_adoption_field_review_receipts receipt
  JOIN project_alpha_directory_read_adoption_field_review_audit audit ON audit.receipt_id=receipt.receipt_id
  JOIN project_alpha_directory_read_adoption_claims claim ON claim.claim_id=receipt.claim_id AND claim.state='inactive'
  JOIN operations_directory_records record ON record.record_id=receipt.record_id
    AND record.record_kind=receipt.resource_type AND record.current_version=receipt.local_record_version
  JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
  JOIN native_staff_admissions admission ON admission.staff_id=receipt.reviewer_staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE receipt.receipt_id=NEW.field_review_receipt_id AND receipt.review_id=NEW.review_id AND receipt.claim_id=NEW.claim_id
    AND receipt.source_id=NEW.source_id AND receipt.source_instance_id=NEW.source_instance_id
    AND receipt.application_id=NEW.application_id AND receipt.history_epoch_id=NEW.history_epoch_id
    AND receipt.resource_type=NEW.resource_type AND receipt.record_id=NEW.record_id
    AND receipt.external_id=NEW.reviewed_external_id AND NEW.target_external_id=receipt.record_id
    AND receipt.project_alpha_public_id=NEW.project_alpha_public_id
    AND receipt.project_alpha_revision=NEW.project_alpha_revision
    AND receipt.authorization_generation=NEW.authorization_generation
    AND receipt.local_record_version=NEW.local_record_version
    AND receipt.local_profile_sha256=NEW.local_profile_sha256
    AND receipt.project_alpha_profile_sha256=NEW.project_alpha_profile_sha256
    AND receipt.reviewer_staff_id=NEW.reviewer_staff_id
    AND receipt.reviewer_access_subject=NEW.reviewer_access_subject
    AND receipt.reviewer_admission_version=NEW.reviewer_admission_version
    AND receipt.reviewer_profile_version=NEW.reviewer_profile_version
    AND claim.review_id=receipt.review_id AND claim.record_id=receipt.record_id
    AND claim.source_id=receipt.source_id AND claim.source_instance_id=receipt.source_instance_id
    AND claim.application_id=receipt.application_id AND claim.history_epoch_id=receipt.history_epoch_id
    AND claim.resource_type=receipt.resource_type AND claim.external_id=receipt.external_id
    AND claim.project_alpha_public_id=receipt.project_alpha_public_id
    AND audit.actor_staff_id=receipt.reviewer_staff_id
    AND admission.active=1 AND admission.bound_access_subject=receipt.reviewer_access_subject
    AND admission.version=receipt.reviewer_admission_version AND profile.version=receipt.reviewer_profile_version
    AND generation.generation=NEW.reviewer_grant_generation
)
BEGIN SELECT RAISE(ABORT,'directory adoption finalization requires current exact sealed receipt'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_decisions_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_finalizations
WHEN NOT EXISTS(
  SELECT 1 FROM project_alpha_directory_read_adoption_field_review_receipts receipt
  WHERE receipt.receipt_id=NEW.field_review_receipt_id
    AND (SELECT count(*) FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id)=receipt.decision_count
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND decision.decision='requires_follow_up')
    AND (SELECT count(*) FROM project_alpha_directory_read_adoption_field_decisions decision
      WHERE decision.receipt_id=receipt.receipt_id AND decision.decision='adopt_project_alpha')=NEW.adopted_field_count
)
BEGIN SELECT RAISE(ABORT,'directory adoption finalization requires complete reviewed dispositions'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_no_collision
BEFORE INSERT ON project_alpha_directory_read_adoption_finalizations
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_mappings mapping
  WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.resource_type=NEW.resource_type
    AND (mapping.external_id IN (NEW.record_id,NEW.reviewed_external_id)
      OR mapping.project_alpha_public_id=NEW.project_alpha_public_id))
  OR EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
    WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
      AND mapping.application_id=NEW.application_id AND mapping.resource_type=NEW.resource_type
      AND (mapping.record_id=NEW.record_id OR mapping.external_id IN (NEW.record_id,NEW.reviewed_external_id)
        OR mapping.project_alpha_public_id=NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'directory adoption finalization conflicts with an existing mapping'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_observation_current
BEFORE INSERT ON project_alpha_directory_read_adoption_finalizations
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations_current observation
  WHERE observation.source_id=NEW.source_id AND observation.source_instance_id=NEW.source_instance_id
    AND observation.application_id=NEW.application_id AND observation.history_epoch_id=NEW.history_epoch_id
    AND observation.resource_type=NEW.resource_type AND observation.project_alpha_public_id=NEW.project_alpha_public_id
    AND observation.resource_revision=NEW.project_alpha_revision
    AND observation.binding_external_id=NEW.reviewed_external_id AND observation.binding_status='active'
    AND observation.binding_resource_revision=NEW.project_alpha_revision
    AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0)
BEGIN SELECT RAISE(ABORT,'directory adoption finalization requires current Project Alpha observation'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_no_inventory_conflict
BEFORE INSERT ON project_alpha_directory_read_adoption_finalizations
WHEN EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
  WHERE conflict.source_id=NEW.source_id AND conflict.inventory_kind='directory'
    AND (conflict.resource_type='source' OR (conflict.source_instance_id=NEW.source_instance_id
      AND conflict.application_id=NEW.application_id AND conflict.history_epoch_id=NEW.history_epoch_id
      AND conflict.resource_type=NEW.resource_type
      AND (conflict.project_alpha_public_id=NEW.project_alpha_public_id OR conflict.external_id=NEW.reviewed_external_id))))
BEGIN SELECT RAISE(ABORT,'directory adoption finalization blocked by an inventory conflict'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_identity_authority
BEFORE INSERT ON project_alpha_directory_read_adoption_finalizations
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_field_review_receipts receipt
  JOIN operations_directory_records record ON record.record_id=receipt.record_id AND record.record_kind=receipt.resource_type
  WHERE receipt.receipt_id=NEW.field_review_receipt_id AND receipt.reviewer_staff_id=NEW.reviewer_staff_id
    AND EXISTS(SELECT 1 FROM native_directory_grants allow_row
      WHERE allow_row.staff_id=receipt.reviewer_staff_id AND allow_row.permission='directory.identity.link'
        AND allow_row.effect='allow' AND allow_row.active=1 AND (
          allow_row.scope_kind='global' OR (allow_row.scope_kind='resource' AND allow_row.resource_id=receipt.record_id)
          OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=receipt.record_id AND assignment.staff_id=receipt.reviewer_staff_id AND assignment.active=1))
          OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=receipt.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
          OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=receipt.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
      WHERE deny_row.staff_id=receipt.reviewer_staff_id AND deny_row.permission='directory.identity.link'
        AND deny_row.effect='deny' AND deny_row.active=1 AND (
          deny_row.scope_kind='global' OR (deny_row.scope_kind='resource' AND deny_row.resource_id=receipt.record_id)
          OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=receipt.record_id AND assignment.staff_id=receipt.reviewer_staff_id AND assignment.active=1))
          OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=receipt.record_id AND scope.active=1 AND scope.business_area_id=deny_row.business_area_id))
          OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=receipt.record_id AND scope.active=1 AND scope.division_id=deny_row.division_id)))))
BEGIN SELECT RAISE(ABORT,'directory adoption finalization requires current identity-link authority'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_profile_authority
BEFORE INSERT ON project_alpha_directory_read_adoption_finalizations
WHEN NEW.adopted_field_count>0 AND NOT EXISTS(
  SELECT 1 FROM project_alpha_directory_read_adoption_field_review_receipts receipt
  JOIN operations_directory_records record ON record.record_id=receipt.record_id AND record.record_kind=receipt.resource_type
  WHERE receipt.receipt_id=NEW.field_review_receipt_id AND receipt.reviewer_staff_id=NEW.reviewer_staff_id
    AND EXISTS(SELECT 1 FROM native_directory_grants allow_row
      WHERE allow_row.staff_id=receipt.reviewer_staff_id AND allow_row.permission='directory.profile.edit'
        AND allow_row.effect='allow' AND allow_row.active=1 AND (
          allow_row.scope_kind='global' OR (allow_row.scope_kind='resource' AND allow_row.resource_id=receipt.record_id)
          OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=receipt.record_id AND assignment.staff_id=receipt.reviewer_staff_id AND assignment.active=1))
          OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=receipt.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
          OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=receipt.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
      WHERE deny_row.staff_id=receipt.reviewer_staff_id AND deny_row.permission='directory.profile.edit'
        AND deny_row.effect='deny' AND deny_row.active=1 AND (
          deny_row.scope_kind='global' OR (deny_row.scope_kind='resource' AND deny_row.resource_id=receipt.record_id)
          OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=receipt.record_id AND assignment.staff_id=receipt.reviewer_staff_id AND assignment.active=1))
          OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=receipt.record_id AND scope.active=1 AND scope.business_area_id=deny_row.business_area_id))
          OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=receipt.record_id AND scope.active=1 AND scope.division_id=deny_row.division_id)))))
BEGIN SELECT RAISE(ABORT,'directory adoption finalization requires current profile-edit authority'); END;

CREATE TABLE project_alpha_directory_read_adoption_finalization_events (
  finalization_id TEXT NOT NULL REFERENCES project_alpha_directory_read_adoption_finalizations(finalization_id) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK(state_version>=1),
  event_id TEXT NOT NULL UNIQUE CHECK(length(event_id)=36),
  state TEXT NOT NULL CHECK(state='prepared'),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
  PRIMARY KEY(finalization_id,state_version)
);
CREATE TRIGGER project_alpha_directory_read_adoption_finalization_events_exact
BEFORE INSERT ON project_alpha_directory_read_adoption_finalization_events
WHEN NEW.state_version<>1 OR NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_finalizations finalization
  WHERE finalization.finalization_id=NEW.finalization_id AND finalization.state=NEW.state)
BEGIN SELECT RAISE(ABORT,'directory adoption finalization event requires exact prepared state'); END;

CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_no_update BEFORE UPDATE ON project_alpha_directory_read_adoption_finalizations BEGIN SELECT RAISE(ABORT,'directory adoption finalization is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_finalizations_no_delete BEFORE DELETE ON project_alpha_directory_read_adoption_finalizations BEGIN SELECT RAISE(ABORT,'directory adoption finalization is durable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_finalization_events_no_update BEFORE UPDATE ON project_alpha_directory_read_adoption_finalization_events BEGIN SELECT RAISE(ABORT,'directory adoption finalization event is immutable'); END;
CREATE TRIGGER project_alpha_directory_read_adoption_finalization_events_no_delete BEFORE DELETE ON project_alpha_directory_read_adoption_finalization_events BEGIN SELECT RAISE(ABORT,'directory adoption finalization event is durable'); END;
