PRAGMA foreign_keys = ON;

-- The private consumer creates the native head, revision, and complete bind
-- plan in one D1 batch. These deliberately shallow final-receipt triggers
-- independently recheck the composition; any failure rolls back the batch.
CREATE TABLE project_alpha_project_adoption_bind_receipts (
  bridge_id TEXT NOT NULL PRIMARY KEY CHECK(length(bridge_id)=36 AND bridge_id=lower(bridge_id)
    AND bridge_id NOT GLOB '*[^0-9a-f-]*' AND substr(bridge_id,9,1)='-'
    AND substr(bridge_id,14,1)='-' AND substr(bridge_id,15,1)='4'
    AND substr(bridge_id,19,1)='-' AND substr(bridge_id,20,1) IN ('8','9','a','b')
    AND substr(bridge_id,24,1)='-' AND length(replace(bridge_id,'-',''))=32),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_adoption_review_reservations(reservation_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_v2_canonical_intents(command_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256) AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  external_project_id TEXT NOT NULL REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  local_version INTEGER NOT NULL CHECK(local_version=1),
  local_projection_sha256 TEXT NOT NULL CHECK(length(local_projection_sha256)=64 AND local_projection_sha256=lower(local_projection_sha256) AND local_projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at)
);

CREATE TRIGGER project_alpha_project_adoption_bind_receipts_reservation_exact
BEFORE INSERT ON project_alpha_project_adoption_bind_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_adoption_review_reservations reservation
  JOIN project_alpha_project_adoption_review_evidence review ON review.review_item_id=reservation.review_item_id
  JOIN project_alpha_project_destinations destination ON destination.external_project_id=reservation.external_project_id
  WHERE reservation.reservation_id=NEW.reservation_id AND NEW.external_project_id=reservation.external_project_id
    AND NEW.local_version=1 AND NEW.local_projection_sha256=reservation.projection_sha256
    AND review.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND review.request_sha256=reservation.request_sha256 AND review.source_id=reservation.source_id
    AND review.source_instance_id=reservation.source_instance_id AND review.application_id=reservation.application_id
    AND review.history_epoch_id=reservation.history_epoch_id AND review.external_project_id=reservation.external_project_id
    AND review.project_alpha_public_id=reservation.project_alpha_public_id
    AND review.project_alpha_revision=reservation.project_alpha_revision
    AND review.projection_sha256=reservation.projection_sha256
    AND review.authorization_generation=reservation.authorization_generation
    AND review.canonical_detail_read_sha256=reservation.canonical_detail_read_sha256
    AND review.organization_record_id IS reservation.organization_record_id
    AND review.organization_project_alpha_public_id IS reservation.organization_project_alpha_public_id
    AND review.client_record_id IS reservation.client_record_id
    AND review.client_project_alpha_public_id IS reservation.client_project_alpha_public_id
    AND review.reviewer_staff_id=reservation.reviewer_staff_id
    AND review.reviewer_access_subject=reservation.reviewer_access_subject
    AND review.reviewer_admission_version=reservation.reviewer_admission_version
    AND review.reviewer_profile_version=reservation.reviewer_profile_version
    AND review.reviewer_owner_role_id=reservation.reviewer_owner_role_id
    AND review.independent_evidence_sha256=reservation.independent_evidence_sha256
    AND review.project_grant_generation=reservation.project_grant_generation
    AND json(review.normalized_scopes_json)=json(reservation.normalized_scopes_json)
    AND destination.source_id=reservation.source_id AND destination.application_id=reservation.application_id
    AND destination.expected_source_instance_id=reservation.source_instance_id
    AND destination.expected_history_epoch_id=reservation.history_epoch_id
)
BEGIN SELECT RAISE(ABORT,'project adoption bind requires one current exact reservation'); END;

CREATE TRIGGER project_alpha_project_adoption_bind_receipts_authority_exact
BEFORE INSERT ON project_alpha_project_adoption_bind_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_adoption_review_reservations reservation
  JOIN project_alpha_project_adoption_review_evidence review ON review.review_item_id=reservation.review_item_id
  JOIN native_staff_profiles profile ON profile.staff_id=reservation.reviewer_staff_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=NEW.command_id
  WHERE reservation.reservation_id=NEW.reservation_id
    AND profile.version=reservation.reviewer_profile_version
    AND proof.external_project_id=reservation.external_project_id AND proof.actor_staff_id=reservation.reviewer_staff_id
    AND proof.actor_access_subject=reservation.reviewer_access_subject
    AND proof.actor_admission_version=reservation.reviewer_admission_version
    AND proof.actor_profile_version=reservation.reviewer_profile_version AND proof.actor_email=profile.login_email
    AND proof.verified_until=review.expires_at AND proof.grant_generation=reservation.project_grant_generation
    AND json(proof.scopes_json)=json(reservation.normalized_scopes_json)
    AND EXISTS (SELECT 1 FROM staff_role_assignments owner_assignment
      WHERE owner_assignment.staff_id=reservation.reviewer_staff_id
        AND owner_assignment.role_id=reservation.reviewer_owner_role_id AND owner_assignment.scope='global')
)
BEGIN SELECT RAISE(ABORT,'project adoption bind authority is not current and exact'); END;

CREATE TRIGGER project_alpha_project_adoption_bind_receipts_native_exact
BEFORE INSERT ON project_alpha_project_adoption_bind_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_adoption_review_reservations reservation
  JOIN project_alpha_project_adoption_review_evidence review ON review.review_item_id=reservation.review_item_id
  JOIN operations_shared_projects project ON project.external_project_id=reservation.external_project_id
  JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id AND revision.version=1
  WHERE reservation.reservation_id=NEW.reservation_id
    AND project.source_id IS NULL AND project.source_instance_id IS NULL AND project.application_id IS NULL
    AND project.history_epoch_id IS NULL AND project.project_alpha_public_id IS NULL AND project.pa_revision IS NULL
    AND project.current_version=1 AND project.canonical_projection_sha256=reservation.projection_sha256
    AND project.name=json_extract(review.canonical_detail_read_json,'$.data.name')
    AND project.description IS json_extract(review.canonical_detail_read_json,'$.data.description')
    AND project.lifecycle=json_extract(review.canonical_detail_read_json,'$.data.status')
    AND project.archived=(json_extract(review.canonical_detail_read_json,'$.data.archived') IS 1)
    AND project.overdue_warning=(json_extract(review.canonical_detail_read_json,'$.data.overdueWarning') IS 1)
    AND project.completed_at IS json_extract(review.canonical_detail_read_json,'$.data.completedAt')
    AND project.archived_at IS json_extract(review.canonical_detail_read_json,'$.data.archivedAt')
    AND project.planned_start IS json_extract(review.canonical_detail_read_json,'$.data.estimatedStart')
    AND project.planned_end IS json_extract(review.canonical_detail_read_json,'$.data.estimatedEnd')
    AND project.organization_record_id IS reservation.organization_record_id
    AND project.client_record_id IS reservation.client_record_id
    AND json(project.scopes_json)=json(reservation.normalized_scopes_json)
    AND revision.pa_revision IS NULL AND revision.refresh_command_id IS NULL AND revision.v2_settlement_id IS NULL
    AND json(revision.read_json)=json(review.canonical_detail_read_json)
)
BEGIN SELECT RAISE(ABORT,'project adoption bind native head is not exact'); END;

CREATE TRIGGER project_alpha_project_adoption_bind_receipts_command_exact
BEFORE INSERT ON project_alpha_project_adoption_bind_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_adoption_review_reservations reservation
  JOIN project_alpha_project_destinations destination ON destination.external_project_id=reservation.external_project_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=NEW.command_id
  JOIN native_project_command_reservations command_reservation ON command_reservation.command_id=outbox.command_id
  WHERE reservation.reservation_id=NEW.reservation_id
    AND outbox.external_project_id=reservation.external_project_id AND outbox.operation='bind'
    AND outbox.source_id=reservation.source_id AND outbox.application_id=reservation.application_id
    AND outbox.destination_base_url=destination.destination_base_url
    AND outbox.expected_source_instance_id=reservation.source_instance_id
    AND outbox.expected_history_epoch_id=reservation.history_epoch_id
    AND outbox.state='pending' AND outbox.attempts=0 AND outbox.lease_token IS NULL
    AND outbox.lease_expires_at IS NULL AND outbox.outcome_json IS NULL
    AND (SELECT count(*) FROM json_each(outbox.origin_snapshot_json))=1
    AND json_extract(outbox.origin_snapshot_json,'$.actorId')=reservation.reviewer_staff_id
    AND (SELECT count(*) FROM json_each(outbox.command_json))=6
    AND json_extract(outbox.command_json,'$.commandId')=NEW.command_id
    AND json_extract(outbox.command_json,'$.externalId')=reservation.external_project_id
    AND json_extract(outbox.command_json,'$.expectedPublicId')=reservation.project_alpha_public_id
    AND json_extract(outbox.command_json,'$.expectedRevision')=reservation.project_alpha_revision
    AND json_extract(outbox.command_json,'$.expectedProjectionSha256')=reservation.projection_sha256
    AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')=reservation.authorization_generation
)
BEGIN SELECT RAISE(ABORT,'project adoption bind command is not exact'); END;

CREATE TRIGGER project_alpha_project_adoption_bind_receipts_ledger_exact
BEFORE INSERT ON project_alpha_project_adoption_bind_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_adoption_review_reservations reservation
  JOIN project_alpha_project_v2_request_fingerprints fingerprint ON fingerprint.command_id=NEW.command_id
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=NEW.command_id
  WHERE reservation.reservation_id=NEW.reservation_id AND fingerprint.request_sha256=NEW.request_sha256
    AND intent.request_sha256=NEW.request_sha256 AND intent.operation='bind'
    AND intent.external_project_id=reservation.external_project_id AND intent.expected_local_version=1
    AND intent.expected_local_projection_sha256=reservation.projection_sha256
    AND intent.expected_grant_generation=reservation.project_grant_generation
    AND intent.expected_mapping_state='absent' AND intent.expected_project_alpha_public_id IS NULL
    AND intent.source_id=reservation.source_id AND intent.source_instance_id=reservation.source_instance_id
    AND intent.application_id=reservation.application_id AND intent.history_epoch_id=reservation.history_epoch_id
    AND (SELECT count(*) FROM project_alpha_project_v2_events event
      WHERE event.command_id=NEW.command_id AND event.state_version=1
        AND event.request_sha256=NEW.request_sha256 AND event.state='pending')=1
    AND (SELECT count(*) FROM project_alpha_project_v2_events event WHERE event.command_id=NEW.command_id)=1
)
BEGIN SELECT RAISE(ABORT,'project adoption bind ledger is not exact'); END;

CREATE TRIGGER project_alpha_project_adoption_bind_receipts_directory_exact
BEFORE INSERT ON project_alpha_project_adoption_bind_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_reservations reservation
  WHERE reservation.reservation_id=NEW.reservation_id AND (
    EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=reservation.external_project_id
        OR (mapping.source_id=reservation.source_id AND mapping.source_instance_id=reservation.source_instance_id
          AND mapping.application_id=reservation.application_id AND mapping.history_epoch_id=reservation.history_epoch_id
          AND mapping.project_alpha_public_id=reservation.project_alpha_public_id))
    OR (reservation.organization_record_id IS NOT NULL AND (SELECT count(*)
      FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='organization'
      WHERE mapping.source_id=reservation.source_id AND mapping.source_instance_id=reservation.source_instance_id
        AND mapping.application_id=reservation.application_id AND mapping.history_epoch_id=reservation.history_epoch_id
        AND mapping.resource_type='organization' AND mapping.external_id=reservation.organization_record_id
        AND mapping.project_alpha_public_id=reservation.organization_project_alpha_public_id)<>1)
    OR (reservation.client_record_id IS NOT NULL AND (SELECT count(*)
      FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='client'
      WHERE mapping.source_id=reservation.source_id AND mapping.source_instance_id=reservation.source_instance_id
        AND mapping.application_id=reservation.application_id AND mapping.history_epoch_id=reservation.history_epoch_id
        AND mapping.resource_type='client' AND mapping.external_id=reservation.client_record_id
        AND mapping.project_alpha_public_id=reservation.client_project_alpha_public_id)<>1)
    OR (reservation.organization_record_id IS NOT NULL AND reservation.client_record_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=reservation.client_record_id
          AND relationship.organization_record_id=reservation.organization_record_id))
  ))
BEGIN SELECT RAISE(ABORT,'project adoption bind directory identity is not exact'); END;

CREATE TRIGGER project_alpha_project_adoption_bind_receipts_no_update BEFORE UPDATE ON project_alpha_project_adoption_bind_receipts
BEGIN SELECT RAISE(ABORT,'project adoption bind receipts are immutable'); END;
CREATE TRIGGER project_alpha_project_adoption_bind_receipts_no_delete BEFORE DELETE ON project_alpha_project_adoption_bind_receipts
BEGIN SELECT RAISE(ABORT,'project adoption bind receipts are durable'); END;
