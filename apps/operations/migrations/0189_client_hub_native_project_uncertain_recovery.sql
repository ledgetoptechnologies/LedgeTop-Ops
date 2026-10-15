PRAGMA foreign_keys = ON;

-- Normal Client Hub recovery is deliberately separate from the 0180
-- integrations.manage administrator recovery contract.  It can reopen and
-- dispatch only one already-reserved 0188 command after genuine uncertainty.
CREATE TABLE client_hub_native_project_recovery_authorizations (
  authorization_id TEXT NOT NULL PRIMARY KEY CHECK(length(authorization_id)=36),
  command_id TEXT NOT NULL REFERENCES client_hub_native_project_preparations(command_id) ON DELETE RESTRICT,
  uncertain_event_version INTEGER NOT NULL CHECK(typeof(uncertain_event_version)='integer' AND uncertain_event_version>=1),
  original_attempts INTEGER NOT NULL CHECK(typeof(original_attempts)='integer' AND original_attempts>=1),
  original_outcome_json TEXT NOT NULL CHECK(json_valid(original_outcome_json) AND json_type(original_outcome_json)='object'),
  preparation_request_json TEXT NOT NULL,
  preparation_request_sha256 TEXT NOT NULL CHECK(length(preparation_request_sha256)=43 AND preparation_request_sha256 NOT GLOB '*[^A-Za-z0-9_-]*'),
  command_request_sha256 TEXT NOT NULL CHECK(length(command_request_sha256)=64 AND command_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  external_project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  destination_origin TEXT NOT NULL,
  context_root_namespace TEXT NOT NULL,
  context_root_kind TEXT NOT NULL,
  context_root_public_id TEXT NOT NULL,
  context_version TEXT NOT NULL,
  original_actor_staff_id TEXT NOT NULL,
  original_actor_access_subject TEXT NOT NULL,
  original_actor_email TEXT NOT NULL,
  original_actor_admission_version INTEGER NOT NULL,
  original_actor_profile_version INTEGER NOT NULL,
  original_authority_generation INTEGER NOT NULL,
  current_authority_generation INTEGER NOT NULL,
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json)='array'),
  expected_local_version INTEGER NOT NULL,
  expected_local_projection_sha256 TEXT,
  expected_mapping_state TEXT NOT NULL CHECK(expected_mapping_state IN ('absent','exact')),
  expected_project_alpha_public_id TEXT,
  authorization_reason TEXT NOT NULL DEFAULT 'terminal_uncertain'
    CHECK(authorization_reason IN ('terminal_uncertain','expired_lease','expired_unsent')),
  prior_authorization_id TEXT REFERENCES client_hub_native_project_recovery_authorizations(authorization_id) ON DELETE RESTRICT,
  expected_outbox_state TEXT CHECK(expected_outbox_state IN ('leased','pending')),
  expected_lease_token TEXT,
  expected_lease_expires_at INTEGER,
  expected_event_state_version INTEGER CHECK(expected_event_state_version IS NULL OR expected_event_state_version>=1),
  authorized_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  CHECK(authorization_reason<>'terminal_uncertain' OR prior_authorization_id IS NULL),
  CHECK(authorization_reason<>'expired_unsent' OR prior_authorization_id IS NOT NULL),
  CHECK((authorization_reason='terminal_uncertain')=(expected_outbox_state IS NULL)),
  CHECK(authorization_reason<>'expired_lease' OR (expected_outbox_state='leased'
    AND expected_lease_token IS NOT NULL AND expected_lease_expires_at IS NOT NULL AND expected_event_state_version IS NOT NULL)),
  CHECK(authorization_reason<>'expired_unsent' OR (expected_outbox_state='pending'
    AND expected_lease_token IS NULL AND expected_lease_expires_at IS NULL AND expected_event_state_version IS NOT NULL)),
  CHECK(expires_at>authorized_at AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',authorized_at,'+15 minutes'))
);
CREATE UNIQUE INDEX client_hub_native_project_recovery_initial_identity
ON client_hub_native_project_recovery_authorizations(command_id,uncertain_event_version,current_authority_generation)
WHERE authorization_reason='terminal_uncertain';
CREATE UNIQUE INDEX client_hub_native_project_recovery_renewal_identity
ON client_hub_native_project_recovery_authorizations(command_id,expected_event_state_version,current_authority_generation,authorization_reason,ifnull(prior_authorization_id,''))
WHERE authorization_reason<>'terminal_uncertain';

CREATE TABLE client_hub_native_project_recovery_renewal_receipts (
  authorization_id TEXT NOT NULL PRIMARY KEY REFERENCES client_hub_native_project_recovery_authorizations(authorization_id) ON DELETE RESTRICT,
  prior_authorization_id TEXT REFERENCES client_hub_native_project_recovery_authorizations(authorization_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL,
  authorization_reason TEXT NOT NULL CHECK(authorization_reason IN ('expired_lease','expired_unsent')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER client_hub_native_project_recovery_renewal_receipts_no_update BEFORE UPDATE ON client_hub_native_project_recovery_renewal_receipts
BEGIN SELECT RAISE(ABORT,'client hub project recovery renewal receipt is immutable'); END;
CREATE TRIGGER client_hub_native_project_recovery_renewal_receipts_no_delete BEFORE DELETE ON client_hub_native_project_recovery_renewal_receipts
BEGIN SELECT RAISE(ABORT,'client hub project recovery renewal receipt is durable'); END;

ALTER TABLE project_alpha_project_outbox ADD COLUMN client_hub_recovery_authorization_id TEXT;

CREATE TRIGGER client_hub_native_project_first_plan_admission
BEFORE INSERT ON project_alpha_project_outbox
WHEN EXISTS (SELECT 1 FROM client_hub_native_project_preparations preparation
  WHERE preparation.command_id=NEW.command_id)
 AND NOT EXISTS (SELECT 1 FROM client_hub_native_project_preparations preparation
  WHERE preparation.command_id=NEW.command_id AND preparation.external_project_id=NEW.external_project_id
    AND preparation.transmission_started_at IS NOT NULL
    AND preparation.expires_at>preparation.transmission_started_at)
BEGIN SELECT RAISE(ABORT,'client hub project planning requires a live admitted preparation'); END;

CREATE TRIGGER project_alpha_project_outbox_client_hub_recovery_binding_guard
BEFORE UPDATE OF client_hub_recovery_authorization_id ON project_alpha_project_outbox
WHEN NEW.client_hub_recovery_authorization_id IS NOT OLD.client_hub_recovery_authorization_id
 AND NOT (OLD.state='terminal' AND NEW.state='pending'
   AND OLD.client_hub_recovery_authorization_id IS NOT NEW.client_hub_recovery_authorization_id
   AND EXISTS (SELECT 1 FROM client_hub_native_project_recovery_authorizations authorization
     WHERE authorization.authorization_id=NEW.client_hub_recovery_authorization_id
       AND authorization.command_id=OLD.command_id
       AND authorization.original_attempts=OLD.attempts
       AND authorization.original_outcome_json=OLD.outcome_json))
 AND NOT EXISTS (SELECT 1 FROM client_hub_native_project_recovery_authorizations authorization
   WHERE authorization.authorization_id=NEW.client_hub_recovery_authorization_id
     AND authorization.command_id=OLD.command_id AND authorization.original_attempts=OLD.attempts
     AND ((authorization.authorization_reason='expired_lease' AND OLD.state='leased' AND NEW.state='pending'
       AND OLD.lease_token=authorization.expected_lease_token
       AND OLD.lease_expires_at=authorization.expected_lease_expires_at
       AND OLD.lease_expires_at<=unixepoch('now')
       AND OLD.client_hub_recovery_authorization_id IS authorization.prior_authorization_id)
      OR (authorization.authorization_reason='expired_unsent' AND OLD.state='pending' AND NEW.state='pending'
       AND OLD.client_hub_recovery_authorization_id=authorization.prior_authorization_id)))
BEGIN SELECT RAISE(ABORT,'client hub project recovery binding is immutable'); END;

CREATE TRIGGER client_hub_native_project_recovery_authorizations_no_update
BEFORE UPDATE ON client_hub_native_project_recovery_authorizations
BEGIN SELECT RAISE(ABORT,'client hub project recovery authority is immutable'); END;
CREATE TRIGGER client_hub_native_project_recovery_authorizations_no_delete
BEFORE DELETE ON client_hub_native_project_recovery_authorizations
BEGIN SELECT RAISE(ABORT,'client hub project recovery authority is durable'); END;

CREATE VIEW client_hub_native_project_live_recovery_authorizations AS
SELECT authorization.*
FROM client_hub_native_project_recovery_authorizations authorization
JOIN client_hub_native_project_preparations preparation
  ON preparation.command_id=authorization.command_id
 AND preparation.external_project_id=authorization.external_project_id
 AND preparation.request_json=authorization.preparation_request_json
 AND preparation.request_sha256=authorization.preparation_request_sha256
 AND preparation.context_source_id=authorization.source_id
 AND preparation.context_root_namespace=authorization.context_root_namespace
 AND preparation.context_root_kind=authorization.context_root_kind
 AND preparation.context_root_public_id=authorization.context_root_public_id
 AND preparation.context_version=authorization.context_version
 AND preparation.actor_staff_id=authorization.original_actor_staff_id
 AND preparation.actor_access_subject=authorization.original_actor_access_subject
 AND preparation.actor_email=authorization.original_actor_email
 AND preparation.actor_admission_version=authorization.original_actor_admission_version
 AND preparation.actor_profile_version=authorization.original_actor_profile_version
 AND preparation.authority_generation=authorization.original_authority_generation
 AND preparation.source_instance_id=authorization.source_instance_id
 AND preparation.application_id=authorization.application_id
 AND preparation.history_epoch_id=authorization.history_epoch_id
 AND preparation.transmission_started_at IS NOT NULL
JOIN native_project_command_reservations reservation ON reservation.command_id=authorization.command_id
JOIN project_alpha_project_v2_request_fingerprints fingerprint
  ON fingerprint.command_id=authorization.command_id AND fingerprint.request_sha256=authorization.command_request_sha256
JOIN project_alpha_project_v2_canonical_intents intent
  ON intent.command_id=authorization.command_id AND intent.request_sha256=authorization.command_request_sha256
 AND intent.external_project_id=authorization.external_project_id AND intent.source_id=authorization.source_id
 AND intent.source_instance_id=authorization.source_instance_id AND intent.application_id=authorization.application_id
 AND intent.history_epoch_id=authorization.history_epoch_id
 AND intent.expected_local_version=authorization.expected_local_version
 AND intent.expected_local_projection_sha256 IS authorization.expected_local_projection_sha256
 AND intent.expected_mapping_state=authorization.expected_mapping_state
 AND intent.expected_project_alpha_public_id IS authorization.expected_project_alpha_public_id
 AND intent.expected_grant_generation=authorization.original_authority_generation
JOIN project_alpha_project_outbox outbox
  ON outbox.command_id=authorization.command_id AND outbox.external_project_id=authorization.external_project_id
 AND outbox.source_id=authorization.source_id AND outbox.expected_source_instance_id=authorization.source_instance_id
 AND outbox.application_id=authorization.application_id AND outbox.expected_history_epoch_id=authorization.history_epoch_id
 AND rtrim(outbox.destination_base_url,'/')=authorization.destination_origin
 AND outbox.state IN ('terminal','pending','leased')
JOIN native_project_command_proofs original_proof
  ON original_proof.command_id=authorization.command_id AND original_proof.external_project_id=authorization.external_project_id
 AND original_proof.actor_staff_id=authorization.original_actor_staff_id
 AND original_proof.actor_access_subject=authorization.original_actor_access_subject
 AND original_proof.actor_email=authorization.original_actor_email
 AND original_proof.actor_admission_version=authorization.original_actor_admission_version
 AND original_proof.actor_profile_version=authorization.original_actor_profile_version
 AND original_proof.grant_generation=authorization.original_authority_generation
 AND json(original_proof.scopes_json)=json(authorization.scopes_json)
JOIN native_staff_admissions admission
  ON admission.staff_id=authorization.original_actor_staff_id AND admission.active=1
 AND admission.bound_access_subject=authorization.original_actor_access_subject
 AND admission.version=authorization.original_actor_admission_version
JOIN native_staff_profiles profile
  ON profile.staff_id=authorization.original_actor_staff_id
 AND profile.login_email=authorization.original_actor_email
 AND profile.version=authorization.original_actor_profile_version
JOIN native_project_grant_generations generation
  ON generation.staff_id=authorization.original_actor_staff_id
 AND generation.generation=authorization.current_authority_generation
JOIN project_alpha_project_v2_events uncertain
  ON uncertain.command_id=authorization.command_id
 AND uncertain.state_version=authorization.uncertain_event_version
 AND uncertain.request_sha256=authorization.command_request_sha256 AND uncertain.state='uncertain'
JOIN project_alpha_active_directory_mappings relationship
  ON relationship.record_id=authorization.context_root_public_id AND relationship.source_id=authorization.source_id
 AND relationship.source_instance_id=authorization.source_instance_id
 AND relationship.application_id=authorization.application_id AND relationship.history_epoch_id=authorization.history_epoch_id
 AND relationship.resource_type=CASE authorization.context_root_kind
   WHEN 'organization' THEN 'organization' WHEN 'standalone_client' THEN 'client' END
 AND relationship.record_id=CASE authorization.context_root_kind
   WHEN 'organization' THEN json_extract(authorization.preparation_request_json,'$.directory.organizationRecordId')
   WHEN 'standalone_client' THEN json_extract(authorization.preparation_request_json,'$.directory.clientRecordId') END
 AND relationship.external_id=CASE authorization.context_root_kind
   WHEN 'organization' THEN json_extract(authorization.preparation_request_json,'$.command.organization.externalId')
   WHEN 'standalone_client' THEN json_extract(authorization.preparation_request_json,'$.command.client.externalId') END
 AND relationship.project_alpha_public_id=CASE authorization.context_root_kind
   WHEN 'organization' THEN json_extract(authorization.preparation_request_json,'$.command.organization.expectedPublicId')
   WHEN 'standalone_client' THEN json_extract(authorization.preparation_request_json,'$.command.client.expectedPublicId') END
JOIN project_alpha_api_v2_directory_observations_current observation
  ON observation.source_id=relationship.source_id AND observation.source_instance_id=relationship.source_instance_id
 AND observation.application_id=relationship.application_id AND observation.history_epoch_id=relationship.history_epoch_id
 AND observation.resource_type=relationship.resource_type AND observation.project_alpha_public_id=relationship.project_alpha_public_id
 AND observation.present=1 AND observation.has_conflict=0 AND observation.binding_external_id=relationship.external_id
 AND observation.binding_status='active' AND observation.binding_resource_revision=observation.resource_revision
 AND observation.resource_revision=CASE authorization.context_root_kind
   WHEN 'organization' THEN json_extract(authorization.preparation_request_json,'$.command.organization.expectedRevision')
   WHEN 'standalone_client' THEN json_extract(authorization.preparation_request_json,'$.command.client.expectedRevision') END
 AND observation.projection_sha256=CASE authorization.context_root_kind
   WHEN 'organization' THEN json_extract(authorization.preparation_request_json,'$.command.organization.expectedProjectionSha256')
   WHEN 'standalone_client' THEN json_extract(authorization.preparation_request_json,'$.command.client.expectedProjectionSha256') END
WHERE authorization.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND (authorization.authorization_reason='terminal_uncertain' OR EXISTS (
    SELECT 1 FROM client_hub_native_project_recovery_renewal_receipts renewal
    WHERE renewal.authorization_id=authorization.authorization_id
      AND renewal.prior_authorization_id IS authorization.prior_authorization_id
      AND renewal.command_id=authorization.command_id
      AND renewal.authorization_reason=authorization.authorization_reason))
  AND authorization.context_root_kind IN ('organization','standalone_client')
  AND (authorization.context_root_kind<>'standalone_client' OR EXISTS (
    SELECT 1 FROM operations_directory_client_organizations ownership
    WHERE ownership.client_record_id=authorization.context_root_public_id
      AND ownership.organization_record_id IS NULL))
  AND ((outbox.state IN ('terminal','pending') AND outbox.attempts=authorization.original_attempts)
    OR (outbox.state='leased' AND outbox.attempts=authorization.original_attempts+1))
  AND (outbox.state='terminal'
    OR (outbox.state IN ('pending','leased') AND outbox.client_hub_recovery_authorization_id=authorization.authorization_id))
  AND (outbox.state<>'terminal' OR outbox.outcome_json=authorization.original_outcome_json)
  AND json_type(outbox.command_json,'$.commandId')='text'
  AND json_extract(outbox.command_json,'$.commandId')=authorization.command_id
  AND json_type(outbox.command_json,'$.externalId')='text'
  AND json_extract(outbox.command_json,'$.externalId')=authorization.external_project_id
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events later
    WHERE later.command_id=authorization.command_id AND later.state_version>authorization.uncertain_event_version+2)
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_success_receipts receipt WHERE receipt.command_id=authorization.command_id)
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement WHERE settlement.command_id=authorization.command_id)
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_activation_receipts activation WHERE activation.command_id=authorization.command_id)
  AND ((authorization.expected_local_version=0 AND NOT EXISTS (SELECT 1 FROM operations_shared_projects project
      WHERE project.external_project_id=authorization.external_project_id))
    OR (authorization.expected_local_version>=1 AND EXISTS (SELECT 1 FROM operations_shared_projects project
      WHERE project.external_project_id=authorization.external_project_id
        AND project.current_version=authorization.expected_local_version
        AND project.canonical_projection_sha256=authorization.expected_local_projection_sha256)))
  AND ((authorization.expected_mapping_state='absent' AND NOT EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=authorization.external_project_id))
    OR (authorization.expected_mapping_state='exact' AND EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=authorization.external_project_id AND mapping.source_id=authorization.source_id
        AND mapping.source_instance_id=authorization.source_instance_id AND mapping.application_id=authorization.application_id
        AND mapping.history_epoch_id=authorization.history_epoch_id
        AND mapping.project_alpha_public_id=authorization.expected_project_alpha_public_id)))
  AND NOT EXISTS (SELECT 1 FROM json_each(authorization.scopes_json) scope
    LEFT JOIN native_business_areas area ON area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
    LEFT JOIN native_business_divisions division ON division.id=json_extract(scope.value,'$.divisionId')
      AND division.business_area_id=area.id AND division.active=1
    WHERE json_type(scope.value) IS NOT 'object' OR area.id IS NULL
      OR (json_extract(scope.value,'$.scopeKind')='division' AND division.id IS NULL))
  AND NOT EXISTS (SELECT 1 FROM json_each(authorization.scopes_json) scope WHERE NOT EXISTS (
    SELECT 1 FROM native_project_grants grant_row
    WHERE grant_row.staff_id=authorization.original_actor_staff_id AND grant_row.capability='project.shared.sync'
      AND grant_row.effect='allow' AND grant_row.active=1 AND (grant_row.scope_kind='global'
        OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=authorization.external_project_id)
        OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
        OR (grant_row.scope_kind='division' AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
  AND (json_array_length(authorization.scopes_json)>0 OR EXISTS (SELECT 1 FROM native_project_grants grant_row
    WHERE grant_row.staff_id=authorization.original_actor_staff_id AND grant_row.capability='project.shared.sync'
      AND grant_row.effect='allow' AND grant_row.active=1 AND grant_row.scope_kind='global'))
  AND NOT EXISTS (SELECT 1 FROM native_project_grants deny
    WHERE deny.staff_id=authorization.original_actor_staff_id AND deny.capability='project.shared.sync'
      AND deny.effect='deny' AND deny.active=1 AND (deny.scope_kind='global'
        OR (deny.scope_kind='exact_project' AND deny.external_project_id=authorization.external_project_id)
        OR EXISTS (SELECT 1 FROM json_each(authorization.scopes_json) scope
          WHERE (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId'))
             OR (deny.scope_kind='division' AND deny.division_id=json_extract(scope.value,'$.divisionId')))));

CREATE TRIGGER client_hub_native_project_recovery_authorizations_insert_guard
AFTER INSERT ON client_hub_native_project_recovery_authorizations
WHEN NEW.authorized_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR (NEW.authorization_reason='terminal_uncertain' AND (
   NOT EXISTS (SELECT 1 FROM client_hub_native_project_live_recovery_authorizations live WHERE live.authorization_id=NEW.authorization_id)
   OR NOT EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox WHERE outbox.command_id=NEW.command_id
     AND outbox.state='terminal' AND outbox.attempts=NEW.original_attempts AND outbox.lease_token IS NULL
     AND outbox.lease_expires_at IS NULL AND outbox.outcome_json=NEW.original_outcome_json)
   OR EXISTS (SELECT 1 FROM project_alpha_project_v2_events later
     WHERE later.command_id=NEW.command_id AND later.state_version>NEW.uncertain_event_version)))
 OR (NEW.authorization_reason='expired_lease' AND NOT EXISTS (
   SELECT 1 FROM client_hub_native_project_preparations preparation
   JOIN project_alpha_project_outbox outbox ON outbox.command_id=preparation.command_id
    AND outbox.state='leased' AND outbox.attempts=NEW.original_attempts
    AND outbox.lease_token=NEW.expected_lease_token
    AND outbox.lease_expires_at=NEW.expected_lease_expires_at
    AND outbox.lease_expires_at<=unixepoch('now')
    AND outbox.client_hub_recovery_authorization_id IS NEW.prior_authorization_id
   JOIN project_alpha_project_v2_events event ON event.command_id=preparation.command_id
    AND event.state_version=NEW.expected_event_state_version AND event.state='pending'
   WHERE preparation.command_id=NEW.command_id AND preparation.transmission_started_at IS NOT NULL
    AND NEW.uncertain_event_version=NEW.expected_event_state_version+1
    AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events later WHERE later.command_id=preparation.command_id
      AND later.state_version>NEW.expected_event_state_version)
    AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_success_receipts receipt WHERE receipt.command_id=preparation.command_id)))
 OR (NEW.authorization_reason='expired_unsent' AND NOT EXISTS (
   SELECT 1 FROM client_hub_native_project_recovery_authorizations prior
   JOIN project_alpha_project_outbox outbox ON outbox.command_id=prior.command_id
    AND outbox.state='pending' AND outbox.attempts=NEW.original_attempts
    AND outbox.client_hub_recovery_authorization_id=prior.authorization_id
   JOIN project_alpha_project_v2_events event ON event.command_id=prior.command_id
    AND event.state_version=NEW.expected_event_state_version AND event.state='pending'
   WHERE prior.authorization_id=NEW.prior_authorization_id AND prior.command_id=NEW.command_id
    AND prior.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.original_attempts=prior.original_attempts+1
    AND NEW.uncertain_event_version=prior.uncertain_event_version
    AND NEW.expected_event_state_version=prior.uncertain_event_version+1
    AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events later WHERE later.command_id=prior.command_id
      AND later.state_version>NEW.expected_event_state_version)
    AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_success_receipts receipt WHERE receipt.command_id=prior.command_id)))
BEGIN SELECT RAISE(ABORT,'client hub project recovery authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_recovery_renewal_receipts_insert_guard
AFTER INSERT ON client_hub_native_project_recovery_renewal_receipts
WHEN NOT EXISTS (SELECT 1 FROM client_hub_native_project_live_recovery_authorizations live
  WHERE live.authorization_id=NEW.authorization_id
    AND live.prior_authorization_id IS NEW.prior_authorization_id
    AND live.command_id=NEW.command_id AND live.authorization_reason=NEW.authorization_reason)
BEGIN SELECT RAISE(ABORT,'client hub project recovery renewal is not live and exact'); END;

-- A successful recovered POST mints this continuation in the same D1 batch as
-- its ACK and receipt.  It is deliberately absent from every dispatch view.
CREATE TABLE client_hub_native_project_post_ack_continuations (
  continuation_id TEXT NOT NULL PRIMARY KEY CHECK(length(continuation_id)=36),
  command_id TEXT NOT NULL REFERENCES client_hub_native_project_preparations(command_id) ON DELETE RESTRICT,
  authorization_id TEXT NOT NULL REFERENCES client_hub_native_project_recovery_authorizations(authorization_id) ON DELETE RESTRICT,
  success_receipt_id TEXT NOT NULL REFERENCES project_alpha_project_v2_success_receipts(receipt_id) ON DELETE RESTRICT,
  acknowledgement_id TEXT NOT NULL REFERENCES project_alpha_project_v2_validated_acknowledgements(acknowledgement_id) ON DELETE RESTRICT,
  acknowledged_state_version INTEGER NOT NULL,
  request_sha256 TEXT NOT NULL,
  external_project_id TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL,
  actor_profile_version INTEGER NOT NULL,
  actor_email TEXT NOT NULL,
  grant_generation INTEGER NOT NULL,
  current_grant_generation INTEGER NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(command_id,current_grant_generation)
);
CREATE TRIGGER client_hub_native_project_post_ack_continuations_no_update BEFORE UPDATE ON client_hub_native_project_post_ack_continuations
BEGIN SELECT RAISE(ABORT,'client hub project post-ack continuation is immutable'); END;
CREATE TRIGGER client_hub_native_project_post_ack_continuations_no_delete BEFORE DELETE ON client_hub_native_project_post_ack_continuations
BEGIN SELECT RAISE(ABORT,'client hub project post-ack continuation is durable'); END;
CREATE TRIGGER client_hub_native_project_post_ack_continuations_insert_guard
AFTER INSERT ON client_hub_native_project_post_ack_continuations
WHEN NOT EXISTS (
 SELECT 1 FROM client_hub_native_project_recovery_authorizations recovery
 JOIN project_alpha_project_v2_success_receipts receipt
   ON receipt.receipt_id=NEW.success_receipt_id AND receipt.command_id=NEW.command_id
   AND receipt.request_sha256=NEW.request_sha256
 JOIN project_alpha_project_v2_validated_acknowledgements acknowledgement
   ON acknowledgement.acknowledgement_id=NEW.acknowledgement_id
   AND acknowledgement.command_id=NEW.command_id
   AND acknowledgement.acknowledged_state_version=NEW.acknowledged_state_version
   AND acknowledgement.request_sha256=NEW.request_sha256
 JOIN project_alpha_project_v2_events event ON event.command_id=NEW.command_id
   AND event.state_version=NEW.acknowledged_state_version AND event.state='acknowledged'
 JOIN native_staff_admissions admission ON admission.staff_id=NEW.actor_staff_id AND admission.active=1
  AND admission.bound_access_subject=NEW.actor_access_subject AND admission.version=NEW.actor_admission_version
 JOIN native_staff_profiles profile ON profile.staff_id=NEW.actor_staff_id AND profile.login_email=NEW.actor_email
  AND profile.version=NEW.actor_profile_version
 JOIN native_project_grant_generations generation ON generation.staff_id=NEW.actor_staff_id
  AND generation.generation=NEW.current_grant_generation
 WHERE recovery.authorization_id=NEW.authorization_id AND recovery.command_id=NEW.command_id
   AND recovery.command_request_sha256=NEW.request_sha256
   AND recovery.external_project_id=NEW.external_project_id
   AND recovery.original_actor_staff_id=NEW.actor_staff_id
   AND recovery.original_actor_access_subject=NEW.actor_access_subject
   AND recovery.original_actor_admission_version=NEW.actor_admission_version
   AND recovery.original_actor_profile_version=NEW.actor_profile_version
   AND recovery.original_actor_email=NEW.actor_email
   AND recovery.original_authority_generation=NEW.grant_generation
   AND json(recovery.scopes_json)=json(NEW.scopes_json)
   AND NEW.expires_at>NEW.created_at AND NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+15 minutes')
   AND NOT EXISTS (SELECT 1 FROM json_each(NEW.scopes_json) scope WHERE NOT EXISTS (
     SELECT 1 FROM native_project_grants grant_row WHERE grant_row.staff_id=NEW.actor_staff_id
      AND grant_row.capability='project.shared.sync' AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global'
       OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=NEW.external_project_id)
       OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
       OR (grant_row.scope_kind='division' AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
   AND (json_array_length(NEW.scopes_json)>0 OR EXISTS (SELECT 1 FROM native_project_grants grant_row
     WHERE grant_row.staff_id=NEW.actor_staff_id AND grant_row.capability='project.shared.sync'
      AND grant_row.effect='allow' AND grant_row.active=1 AND grant_row.scope_kind='global'))
   AND NOT EXISTS (SELECT 1 FROM native_project_grants deny WHERE deny.staff_id=NEW.actor_staff_id
     AND deny.capability='project.shared.sync' AND deny.effect='deny' AND deny.active=1
     AND (deny.scope_kind='global' OR (deny.scope_kind='exact_project' AND deny.external_project_id=NEW.external_project_id)
      OR EXISTS (SELECT 1 FROM json_each(NEW.scopes_json) scope
       WHERE (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId'))
        OR (deny.scope_kind='division' AND deny.division_id=json_extract(scope.value,'$.divisionId'))))))
BEGIN SELECT RAISE(ABORT,'client hub project post-ack continuation is not exact'); END;

DROP VIEW project_alpha_project_v2_live_settlement_proofs;
CREATE VIEW project_alpha_project_v2_live_settlement_proofs AS
SELECT * FROM native_project_live_command_proofs
UNION ALL
SELECT authorization.command_id,authorization.external_project_id,authorization.actor_staff_id,
 authorization.actor_access_subject,authorization.actor_admission_version,authorization.actor_profile_version,
 authorization.actor_email,authorization.expires_at,authorization.actor_project_grant_generation,
 authorization.actor_scopes_json,authorization.authorized_at
FROM project_alpha_project_v2_live_post_ack_authorizations authorization
UNION ALL
SELECT continuation.command_id,continuation.external_project_id,continuation.actor_staff_id,
 continuation.actor_access_subject,continuation.actor_admission_version,continuation.actor_profile_version,
 continuation.actor_email,continuation.expires_at,continuation.grant_generation,
 continuation.scopes_json,continuation.created_at
FROM client_hub_native_project_post_ack_continuations continuation
JOIN client_hub_native_project_preparations preparation ON preparation.command_id=continuation.command_id
JOIN project_alpha_active_directory_mappings owner_mapping
 ON owner_mapping.record_id=preparation.context_root_public_id AND owner_mapping.source_id=preparation.context_source_id
 AND owner_mapping.source_instance_id=(SELECT source_instance_id FROM client_hub_native_project_recovery_authorizations WHERE authorization_id=continuation.authorization_id)
 AND owner_mapping.application_id=(SELECT application_id FROM client_hub_native_project_recovery_authorizations WHERE authorization_id=continuation.authorization_id)
 AND owner_mapping.history_epoch_id=(SELECT history_epoch_id FROM client_hub_native_project_recovery_authorizations WHERE authorization_id=continuation.authorization_id)
 AND owner_mapping.resource_type=CASE preparation.context_root_kind WHEN 'organization' THEN 'organization' WHEN 'standalone_client' THEN 'client' END
JOIN project_alpha_api_v2_directory_observations_current owner_observation
 ON owner_observation.source_id=owner_mapping.source_id AND owner_observation.source_instance_id=owner_mapping.source_instance_id
 AND owner_observation.application_id=owner_mapping.application_id AND owner_observation.history_epoch_id=owner_mapping.history_epoch_id
 AND owner_observation.resource_type=owner_mapping.resource_type AND owner_observation.project_alpha_public_id=owner_mapping.project_alpha_public_id
 AND owner_observation.present=1 AND owner_observation.has_conflict=0
 AND owner_observation.binding_external_id=owner_mapping.external_id AND owner_observation.binding_status='active'
 AND owner_observation.binding_resource_revision=owner_observation.resource_revision
JOIN native_staff_admissions admission ON admission.staff_id=continuation.actor_staff_id AND admission.active=1
 AND admission.bound_access_subject=continuation.actor_access_subject AND admission.version=continuation.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=continuation.actor_staff_id
 AND profile.login_email=continuation.actor_email AND profile.version=continuation.actor_profile_version
JOIN native_project_grant_generations generation ON generation.staff_id=continuation.actor_staff_id
 AND generation.generation=continuation.current_grant_generation
JOIN project_alpha_project_v2_success_receipts receipt
 ON receipt.receipt_id=continuation.success_receipt_id AND receipt.command_id=continuation.command_id
JOIN project_alpha_project_v2_validated_acknowledgements acknowledgement
 ON acknowledgement.acknowledgement_id=continuation.acknowledgement_id
 AND acknowledgement.command_id=continuation.command_id
 AND acknowledgement.acknowledged_state_version=continuation.acknowledged_state_version
 AND acknowledgement.request_sha256=continuation.request_sha256
WHERE continuation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND (preparation.context_root_kind<>'standalone_client' OR EXISTS (SELECT 1 FROM operations_directory_client_organizations ownership
   WHERE ownership.client_record_id=preparation.context_root_public_id AND ownership.organization_record_id IS NULL))
 AND NOT EXISTS (SELECT 1 FROM json_each(continuation.scopes_json) scope WHERE NOT EXISTS (
   SELECT 1 FROM native_project_grants grant_row WHERE grant_row.staff_id=continuation.actor_staff_id
    AND grant_row.capability='project.shared.sync' AND grant_row.effect='allow' AND grant_row.active=1
    AND (grant_row.scope_kind='global'
     OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=continuation.external_project_id)
     OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
     OR (grant_row.scope_kind='division' AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
 AND (json_array_length(continuation.scopes_json)>0 OR EXISTS (SELECT 1 FROM native_project_grants grant_row
   WHERE grant_row.staff_id=continuation.actor_staff_id AND grant_row.capability='project.shared.sync'
    AND grant_row.effect='allow' AND grant_row.active=1 AND grant_row.scope_kind='global'))
 AND NOT EXISTS (SELECT 1 FROM native_project_grants deny WHERE deny.staff_id=continuation.actor_staff_id
   AND deny.capability='project.shared.sync' AND deny.effect='deny' AND deny.active=1
   AND (deny.scope_kind='global' OR (deny.scope_kind='exact_project' AND deny.external_project_id=continuation.external_project_id)
    OR EXISTS (SELECT 1 FROM json_each(continuation.scopes_json) scope
      WHERE (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId'))
       OR (deny.scope_kind='division' AND deny.division_id=json_extract(scope.value,'$.divisionId')))));

-- Extend only the ACK event fence. A PA response received after the request
-- crossed the network is a durable remote fact, so recording its ACK is tied
-- to the exact bound recovery attempt rather than to still-live authority.
-- This raw authorization is deliberately absent from every dispatch view.
-- Producer/reservation fences stay on live proofs, and settlement/activation
-- require a fresh live proof (or the separately guarded post-ACK continuation).
DROP TRIGGER project_alpha_project_v2_events_acknowledgement_authority;
CREATE TRIGGER project_alpha_project_v2_events_acknowledgement_authority
BEFORE INSERT ON project_alpha_project_v2_events
WHEN NEW.state='acknowledged' AND NOT EXISTS (
 SELECT 1 FROM project_alpha_project_outbox outbox
 JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id
 WHERE outbox.command_id=NEW.command_id AND outbox.operation IN ('create','update','bind')
   AND (EXISTS (SELECT 1 FROM native_project_live_command_proofs proof
      WHERE proof.command_id=outbox.command_id AND proof.external_project_id=outbox.external_project_id)
    OR EXISTS (SELECT 1 FROM client_hub_native_project_recovery_authorizations proof
      WHERE proof.command_id=outbox.command_id AND proof.external_project_id=outbox.external_project_id
        AND proof.authorization_id=outbox.client_hub_recovery_authorization_id)))
BEGIN SELECT RAISE(ABORT,'project v2 acknowledgement requires current native authority'); END;

DROP TRIGGER project_alpha_project_v2_validated_acknowledgements_exact;
CREATE TRIGGER project_alpha_project_v2_validated_acknowledgements_exact
BEFORE INSERT ON project_alpha_project_v2_validated_acknowledgements
WHEN NEW.request_sha256 IS NOT (SELECT request_sha256 FROM project_alpha_project_v2_request_fingerprints WHERE command_id=NEW.command_id)
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events event WHERE event.command_id=NEW.command_id AND event.state_version=NEW.acknowledged_state_version AND event.state='acknowledged')
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id WHERE outbox.command_id=NEW.command_id AND outbox.operation IN ('create','update','bind') AND outbox.expected_source_instance_id=NEW.source_instance_id AND outbox.application_id=NEW.application_id AND outbox.expected_history_epoch_id=NEW.history_epoch_id AND rtrim(outbox.destination_base_url,'/')=NEW.destination_origin AND (EXISTS (SELECT 1 FROM native_project_live_command_proofs proof WHERE proof.command_id=outbox.command_id AND proof.external_project_id=outbox.external_project_id) OR EXISTS (SELECT 1 FROM client_hub_native_project_recovery_authorizations proof WHERE proof.command_id=outbox.command_id AND proof.external_project_id=outbox.external_project_id AND proof.authorization_id=outbox.client_hub_recovery_authorization_id)))
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox WHERE outbox.command_id=NEW.command_id AND json_type(outbox.command_json,'$.externalId')='text' AND json_extract(outbox.command_json,'$.externalId')=outbox.external_project_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping JOIN project_alpha_project_outbox outbox ON outbox.command_id=NEW.command_id WHERE mapping.source_instance_id=NEW.source_instance_id AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.project_alpha_public_id=NEW.project_alpha_public_id AND mapping.external_project_id<>outbox.external_project_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox WHERE outbox.command_id=NEW.command_id AND outbox.operation='create' AND (json_type(outbox.command_json,'$.expectedAuthorizationGeneration') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '[0-9]*' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') GLOB '*[^0-9]*' OR (json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<>'0' AND substr(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'),1,1)='0') OR length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))>19 OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')='9223372036854775807' OR CAST(NEW.authorization_generation AS INTEGER)<>CAST(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') AS INTEGER)+1))
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox WHERE outbox.command_id=NEW.command_id AND outbox.operation='bind' AND (json_type(outbox.command_json,'$.expectedPublicId') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedPublicId')<>NEW.project_alpha_public_id OR json_type(outbox.command_json,'$.expectedRevision') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedRevision')<>NEW.project_alpha_revision OR json_type(outbox.command_json,'$.expectedProjectionSha256') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedProjectionSha256')<>NEW.projection_sha256 OR json_type(outbox.command_json,'$.expectedAuthorizationGeneration') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '[0-9]*' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') GLOB '*[^0-9]*' OR (json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<>'0' AND substr(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'),1,1)='0') OR length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))>19 OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')='9223372036854775807' OR CAST(NEW.authorization_generation AS INTEGER)<>CAST(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') AS INTEGER)+1))
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox LEFT JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=outbox.external_project_id WHERE outbox.command_id=NEW.command_id AND outbox.operation='update' AND (mapping.external_project_id IS NULL OR mapping.source_instance_id<>NEW.source_instance_id OR mapping.history_epoch_id<>NEW.history_epoch_id OR mapping.project_alpha_public_id<>NEW.project_alpha_public_id OR json_type(outbox.command_json,'$.expectedRevision') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedRevision') NOT GLOB '[1-9]*' OR json_extract(outbox.command_json,'$.expectedRevision') GLOB '*[^0-9]*' OR length(json_extract(outbox.command_json,'$.expectedRevision'))>19 OR json_type(outbox.command_json,'$.expectedProjectionSha256') IS NOT 'text' OR length(json_extract(outbox.command_json,'$.expectedProjectionSha256'))<>64 OR json_extract(outbox.command_json,'$.expectedProjectionSha256')<>lower(json_extract(outbox.command_json,'$.expectedProjectionSha256')) OR json_extract(outbox.command_json,'$.expectedProjectionSha256') GLOB '*[^0-9a-f]*' OR json_type(outbox.command_json,'$.expectedAuthorizationGeneration') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<>NEW.authorization_generation OR (length(NEW.project_alpha_revision)<length(json_extract(outbox.command_json,'$.expectedRevision')) OR (length(NEW.project_alpha_revision)=length(json_extract(outbox.command_json,'$.expectedRevision')) AND NEW.project_alpha_revision<json_extract(outbox.command_json,'$.expectedRevision')))))
BEGIN SELECT RAISE(ABORT,'project v2 validated acknowledgement is not exact'); END;

-- Replace 0180 reopen guards with the same administrative alternative plus
-- the narrowly scoped Client Hub proof. The event alternative preserves the
-- immutable recovery history; the outbox transition below independently
-- requires an unexpired exact authorization, so a raw/expired row cannot
-- authorize another transmission.
DROP TRIGGER project_alpha_project_v2_recovery_pending_event_guard;
CREATE TRIGGER project_alpha_project_v2_recovery_pending_event_guard
BEFORE INSERT ON project_alpha_project_v2_events
WHEN NEW.state='pending' AND EXISTS (SELECT 1 FROM project_alpha_project_v2_events prior
 JOIN project_alpha_project_outbox outbox ON outbox.command_id=prior.command_id
 WHERE prior.command_id=NEW.command_id AND prior.state_version=NEW.state_version-1 AND prior.state='uncertain'
   AND (outbox.state='terminal' OR (outbox.state='leased' AND outbox.lease_expires_at<=unixepoch('now'))))
 AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_live_recovery_authorizations a
   WHERE a.command_id=NEW.command_id AND a.original_event_state_version=NEW.state_version-1 AND a.request_sha256=NEW.request_sha256)
 AND NOT EXISTS (SELECT 1 FROM client_hub_native_project_recovery_authorizations a
   WHERE a.command_id=NEW.command_id AND a.uncertain_event_version=NEW.state_version-1 AND a.command_request_sha256=NEW.request_sha256)
BEGIN SELECT RAISE(ABORT,'project v2 uncertain reopen requires exact recovery authority'); END;

DROP TRIGGER project_alpha_project_v2_recovery_outbox_reopen_guard;
CREATE TRIGGER project_alpha_project_v2_recovery_outbox_reopen_guard
BEFORE UPDATE OF state ON project_alpha_project_outbox
WHEN NEW.state='pending' AND OLD.state='terminal'
 AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_live_recovery_authorizations a
   JOIN project_alpha_project_v2_events event ON event.command_id=a.command_id AND event.state_version=a.original_event_state_version+1 AND event.state='pending'
   WHERE a.command_id=OLD.command_id)
 AND NOT EXISTS (SELECT 1 FROM client_hub_native_project_recovery_authorizations a
   JOIN project_alpha_project_v2_events event ON event.command_id=a.command_id AND event.state_version=a.uncertain_event_version+1 AND event.state='pending'
   WHERE a.command_id=OLD.command_id AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
     AND a.original_attempts=OLD.attempts AND OLD.outcome_json=a.original_outcome_json
     AND NEW.attempts=OLD.attempts AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL AND NEW.outcome_json IS NULL
     AND NEW.client_hub_recovery_authorization_id=a.authorization_id)
BEGIN SELECT RAISE(ABORT,'project v2 outbox reopen requires exact recovery transition'); END;
