PRAGMA foreign_keys = ON;

-- Assign-only, depth-one recovery.  These tables deliberately do not share the
-- normal relationship outbox's mutation/history identity.
CREATE TABLE project_alpha_directory_relationship_generation_recovery_reviews (
  review_id TEXT NOT NULL PRIMARY KEY,
  client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL, destination_origin TEXT NOT NULL,
  predecessor_command_id TEXT NOT NULL REFERENCES project_alpha_directory_relationship_outbox(command_id) ON DELETE RESTRICT,
  root_command_id TEXT NOT NULL REFERENCES project_alpha_directory_relationship_outbox(command_id) ON DELETE RESTRICT,
  relationship_version INTEGER NOT NULL CHECK(typeof(relationship_version)='integer' AND relationship_version>=2),
  action TEXT NOT NULL CHECK(action='assign'),
  local_previous_organization_record_id TEXT CHECK(local_previous_organization_record_id IS NULL),
  intended_organization_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  client_record_version INTEGER NOT NULL CHECK(client_record_version>=1),
  organization_record_version INTEGER NOT NULL CHECK(organization_record_version>=1),
  client_external_id TEXT NOT NULL, client_public_id TEXT NOT NULL,
  organization_external_id TEXT NOT NULL, organization_public_id TEXT NOT NULL,
  expected_client_revision TEXT NOT NULL, expected_organization_revision TEXT NOT NULL,
  remote_client_revision TEXT NOT NULL, remote_parent_public_id TEXT CHECK(remote_parent_public_id IS NULL),
  target_binding_active INTEGER NOT NULL CHECK(target_binding_active=1),
  target_binding_revision TEXT NOT NULL,
  observed_authorization_generation TEXT NOT NULL CHECK(
    CAST(CAST(observed_authorization_generation AS INTEGER) AS TEXT)=observed_authorization_generation
    AND CAST(observed_authorization_generation AS INTEGER)>=0
    AND CAST(observed_authorization_generation AS INTEGER)<9223372036854775807),
  client_inventory_request_id TEXT NOT NULL, organization_inventory_request_id TEXT NOT NULL,
  replay_request_path TEXT NOT NULL CHECK(replay_request_path LIKE '/api/v2/%'),
  replay_conflict_json TEXT NOT NULL CHECK(json_valid(replay_conflict_json) AND json_type(replay_conflict_json)='object'),
  replay_request_sha256 TEXT NOT NULL CHECK(length(replay_request_sha256)=64 AND replay_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  replay_conflict_sha256 TEXT NOT NULL CHECK(length(replay_conflict_sha256)=64 AND replay_conflict_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  reviewer_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  reviewer_access_subject TEXT NOT NULL, reviewer_email TEXT NOT NULL,
  reviewer_admission_version INTEGER NOT NULL CHECK(reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(reviewer_profile_version>=1),
  selected_grants_json TEXT NOT NULL CHECK(json_valid(selected_grants_json) AND json_type(selected_grants_json)='array'
    AND json_array_length(selected_grants_json)=8),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','authorized','expired','invalidated')),
  UNIQUE(review_id,state),
  CHECK(expires_at>created_at),
  CHECK(remote_client_revision=expected_client_revision),
  CHECK(target_binding_revision=expected_organization_revision)
);
CREATE INDEX project_alpha_directory_relationship_generation_recovery_reviews_expiry
 ON project_alpha_directory_relationship_generation_recovery_reviews(state,expires_at);
CREATE INDEX project_alpha_directory_relationship_generation_recovery_reviews_predecessor
 ON project_alpha_directory_relationship_generation_recovery_reviews(predecessor_command_id,created_at);

CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_review_exact BEFORE INSERT
ON project_alpha_directory_relationship_generation_recovery_reviews
WHEN NEW.replay_request_path<>'/api/v2/directory/clients/'||NEW.client_public_id||'/organization/assign/commands'
 OR (SELECT count(*) FROM json_each(NEW.replay_conflict_json))<>6
 OR json_extract(NEW.replay_conflict_json,'$.apiVersion')<>'2'
 OR json_extract(NEW.replay_conflict_json,'$.sourceInstanceId')<>NEW.source_instance_id
 OR json_extract(NEW.replay_conflict_json,'$.applicationId')<>NEW.application_id
 OR json_extract(NEW.replay_conflict_json,'$.historyEpoch')<>NEW.history_epoch_id
 OR json_type(NEW.replay_conflict_json,'$.requestId')<>'text'
 OR length(json_extract(NEW.replay_conflict_json,'$.requestId'))<>36
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),9,1)<>'-'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),14,1)<>'-'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),15,1)<>'4'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),19,1)<>'-'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),20,1) NOT GLOB '[89ab]'
 OR substr(json_extract(NEW.replay_conflict_json,'$.requestId'),24,1)<>'-'
 OR length(replace(json_extract(NEW.replay_conflict_json,'$.requestId'),'-',''))<>32
 OR replace(json_extract(NEW.replay_conflict_json,'$.requestId'),'-','') GLOB '*[^0-9a-f]*'
 OR json_type(NEW.replay_conflict_json,'$.error')<>'object'
 OR (SELECT count(*) FROM json_each(NEW.replay_conflict_json,'$.error'))<>1
 OR json_extract(NEW.replay_conflict_json,'$.error.code')<>'authorization_generation_conflict'
 OR NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox predecessor
  JOIN operations_directory_client_organizations relation ON relation.client_record_id=NEW.client_record_id
  JOIN operations_directory_client_organization_history history ON history.client_record_id=NEW.client_record_id
    AND history.relationship_version=NEW.relationship_version
  JOIN operations_directory_records client ON client.record_id=NEW.client_record_id
  JOIN operations_directory_records organization ON organization.record_id=NEW.intended_organization_record_id
  WHERE predecessor.command_id=NEW.predecessor_command_id AND NEW.root_command_id=NEW.predecessor_command_id
    AND predecessor.state='terminal' AND json_extract(predecessor.outcome_json,'$.httpStatus')=409
    AND predecessor.action='assign' AND predecessor.client_record_id=NEW.client_record_id
    AND predecessor.relationship_version=NEW.relationship_version
    AND predecessor.source_id=NEW.source_id AND predecessor.source_instance_id=NEW.source_instance_id
    AND predecessor.application_id=NEW.application_id AND predecessor.history_epoch_id=NEW.history_epoch_id
    AND predecessor.destination_origin=NEW.destination_origin
    AND predecessor.expected_current_organization_record_id IS NULL
    AND predecessor.organization_record_id=NEW.intended_organization_record_id
    AND predecessor.client_public_id=NEW.client_public_id
    AND predecessor.expected_client_revision=NEW.expected_client_revision
    AND predecessor.organization_public_id=NEW.organization_public_id
    AND predecessor.expected_organization_revision=NEW.expected_organization_revision
    AND relation.relationship_version=NEW.relationship_version
    AND relation.organization_record_id=NEW.intended_organization_record_id
    AND history.mutation_id=predecessor.mutation_id AND history.previous_organization_record_id IS NULL
    AND history.organization_record_id=NEW.intended_organization_record_id
    AND history.client_record_version=NEW.client_record_version
    AND history.organization_record_version=NEW.organization_record_version
    AND client.record_kind='client' AND client.current_version=NEW.client_record_version
    AND organization.record_kind='organization' AND organization.current_version=NEW.organization_record_version
    AND NEW.remote_parent_public_id IS NULL AND NEW.remote_client_revision=NEW.expected_client_revision
    AND NEW.target_binding_active=1 AND NEW.target_binding_revision=NEW.expected_organization_revision
    AND (length(NEW.observed_authorization_generation)>length(predecessor.expected_authorization_generation)
      OR length(NEW.observed_authorization_generation)=length(predecessor.expected_authorization_generation)
        AND NEW.observed_authorization_generation>predecessor.expected_authorization_generation)
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox later
      WHERE later.client_record_id=NEW.client_record_id AND later.source_id=NEW.source_id
       AND later.source_instance_id=NEW.source_instance_id AND later.application_id=NEW.application_id
       AND later.history_epoch_id=NEW.history_epoch_id AND later.created_at>predecessor.created_at))
 OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts receipt
    WHERE receipt.source_id=NEW.source_id AND receipt.source_instance_id=NEW.source_instance_id
      AND receipt.application_id=NEW.application_id AND receipt.history_epoch_id=NEW.history_epoch_id
      AND receipt.inventory_kind='directory' AND receipt.request_id=NEW.client_inventory_request_id
      AND receipt.authorization_generation=NEW.observed_authorization_generation)
 OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts receipt
    WHERE receipt.source_id=NEW.source_id AND receipt.source_instance_id=NEW.source_instance_id
      AND receipt.application_id=NEW.application_id AND receipt.history_epoch_id=NEW.history_epoch_id
      AND receipt.inventory_kind='directory' AND receipt.request_id=NEW.organization_inventory_request_id
      AND receipt.authorization_generation=NEW.observed_authorization_generation)
 OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations observation
    WHERE observation.source_id=NEW.source_id AND observation.source_instance_id=NEW.source_instance_id
      AND observation.application_id=NEW.application_id AND observation.history_epoch_id=NEW.history_epoch_id
      AND observation.request_id=NEW.client_inventory_request_id AND observation.resource_type='client'
      AND observation.project_alpha_public_id=NEW.client_public_id AND observation.resource_revision=NEW.remote_client_revision
      AND observation.present=1 AND observation.binding_external_id=NEW.client_external_id AND observation.binding_status='active')
 OR NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations observation
    WHERE observation.source_id=NEW.source_id AND observation.source_instance_id=NEW.source_instance_id
      AND observation.application_id=NEW.application_id AND observation.history_epoch_id=NEW.history_epoch_id
      AND observation.request_id=NEW.organization_inventory_request_id AND observation.resource_type='organization'
      AND observation.project_alpha_public_id=NEW.organization_public_id AND observation.resource_revision=NEW.expected_organization_revision
      AND observation.present=1 AND observation.binding_external_id=NEW.organization_external_id
      AND observation.binding_status='active' AND observation.binding_resource_revision=NEW.target_binding_revision)
 OR EXISTS(SELECT 1 FROM (SELECT NEW.client_record_id record_id UNION ALL SELECT NEW.intended_organization_record_id) resource
    WHERE NOT EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
      WHERE enrollment.record_id=resource.record_id AND json_extract(destination.value,'$.sourceId')=NEW.source_id
        AND json_extract(destination.value,'$.sourceInstanceUUID')=NEW.source_instance_id
        AND json_extract(destination.value,'$.applicationUUID')=NEW.application_id
        AND json_extract(destination.value,'$.historyEpoch')=NEW.history_epoch_id
        AND json_extract(destination.value,'$.origin')=NEW.destination_origin
        AND json_extract(destination.value,'$.externalCanonicalId')=CASE
          WHEN resource.record_id=NEW.client_record_id THEN NEW.client_external_id ELSE NEW.organization_external_id END))
 OR NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
    WHERE mapping.record_id=NEW.client_record_id AND mapping.resource_type='client'
      AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
      AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
      AND mapping.external_id=NEW.client_external_id AND mapping.project_alpha_public_id=NEW.client_public_id)
 OR NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
    WHERE mapping.record_id=NEW.intended_organization_record_id AND mapping.resource_type='organization'
      AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
      AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
      AND mapping.external_id=NEW.organization_external_id AND mapping.project_alpha_public_id=NEW.organization_public_id)
BEGIN SELECT RAISE(ABORT,'relationship generation recovery review evidence is not current and exact'); END;

CREATE TABLE project_alpha_directory_relationship_generation_recoveries (
  authorization_id TEXT NOT NULL PRIMARY KEY,
  successor_command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_relationship_recovery_outbox(command_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  predecessor_command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_relationship_outbox(command_id) ON DELETE RESTRICT,
  root_command_id TEXT NOT NULL REFERENCES project_alpha_directory_relationship_outbox(command_id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_relationship_generation_recovery_reviews(review_id) ON DELETE RESTRICT,
  review_state TEXT NOT NULL DEFAULT 'authorized' CHECK(review_state='authorized'),
  recovery_depth INTEGER NOT NULL CHECK(recovery_depth=1),
  client_record_id TEXT NOT NULL, relationship_version INTEGER NOT NULL,
  source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL, destination_origin TEXT NOT NULL,
  observed_authorization_generation TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  predecessor_command_json TEXT NOT NULL CHECK(json_valid(predecessor_command_json) AND json_type(predecessor_command_json)='object'),
  predecessor_outcome_sha256 TEXT NOT NULL CHECK(length(predecessor_outcome_sha256)=64),
  successor_command_json TEXT NOT NULL CHECK(json_valid(successor_command_json) AND json_type(successor_command_json)='object'),
  successor_request_json TEXT NOT NULL CHECK(json_valid(successor_request_json) AND json_type(successor_request_json)='object'),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  actor_staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL, actor_email TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL, actor_profile_version INTEGER NOT NULL,
  selected_grants_json TEXT NOT NULL CHECK(json_valid(selected_grants_json) AND json_type(selected_grants_json)='array'
    AND json_array_length(selected_grants_json)=8),
  authorized_at TEXT NOT NULL, expires_at TEXT NOT NULL
  ,CHECK(expires_at>authorized_at),
  FOREIGN KEY(review_id,review_state)
    REFERENCES project_alpha_directory_relationship_generation_recovery_reviews(review_id,state)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE project_alpha_directory_relationship_recovery_outbox (
  command_id TEXT NOT NULL PRIMARY KEY,
  authorization_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_relationship_generation_recoveries(authorization_id) ON DELETE RESTRICT,
  predecessor_command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_relationship_outbox(command_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL, destination_origin TEXT NOT NULL,
  client_record_id TEXT NOT NULL, relationship_version INTEGER NOT NULL,
  client_public_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action='assign'),
  expected_client_revision TEXT NOT NULL, expected_authorization_generation TEXT NOT NULL,
  expected_current_organization_public_id TEXT CHECK(expected_current_organization_public_id IS NULL),
  organization_record_id TEXT NOT NULL, organization_public_id TEXT NOT NULL,
  expected_organization_revision TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK(json_valid(command_json) AND json_type(command_json)='object'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','acknowledged','terminal')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  lease_token TEXT, lease_expires_at INTEGER,
  outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((state IN ('acknowledged','terminal'))=(outcome_json IS NOT NULL))
);
CREATE INDEX project_alpha_directory_relationship_recovery_outbox_ready
 ON project_alpha_directory_relationship_recovery_outbox(state,next_attempt_at,lease_expires_at,created_at);

-- Sealing is immutable; the sole state transition is coupled to the exact ledger.
CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_reviews_update
BEFORE UPDATE ON project_alpha_directory_relationship_generation_recovery_reviews
WHEN NEW.state<>'authorized' OR OLD.state<>'open'
  OR NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recoveries r
    WHERE r.review_id=OLD.review_id AND r.predecessor_command_id=OLD.predecessor_command_id
      AND r.client_record_id=OLD.client_record_id AND r.evidence_sha256=OLD.evidence_sha256)
  OR NEW.review_id<>OLD.review_id OR NEW.client_record_id<>OLD.client_record_id
  OR NEW.predecessor_command_id<>OLD.predecessor_command_id OR NEW.evidence_sha256<>OLD.evidence_sha256
  OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
  OR NEW.selected_grants_json<>OLD.selected_grants_json OR NEW.replay_request_path<>OLD.replay_request_path
  OR NEW.replay_conflict_json<>OLD.replay_conflict_json
BEGIN SELECT RAISE(ABORT,'relationship generation recovery review is sealed'); END;
CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_reviews_no_delete BEFORE DELETE
ON project_alpha_directory_relationship_generation_recovery_reviews BEGIN SELECT RAISE(ABORT,'relationship generation recovery review is durable'); END;
CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_reviews_fields_immutable
BEFORE UPDATE OF review_id,client_record_id,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,
 predecessor_command_id,root_command_id,relationship_version,action,local_previous_organization_record_id,
 intended_organization_record_id,client_record_version,organization_record_version,client_external_id,client_public_id,
 organization_external_id,organization_public_id,expected_client_revision,expected_organization_revision,
 remote_client_revision,remote_parent_public_id,target_binding_active,target_binding_revision,observed_authorization_generation,
 client_inventory_request_id,organization_inventory_request_id,replay_request_path,replay_conflict_json,replay_request_sha256,
 replay_conflict_sha256,evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_email,reviewer_admission_version,
 reviewer_profile_version,selected_grants_json,created_at,expires_at
ON project_alpha_directory_relationship_generation_recovery_reviews
BEGIN SELECT RAISE(ABORT,'relationship generation recovery review evidence is immutable'); END;
CREATE TRIGGER project_alpha_directory_relationship_generation_recoveries_no_update BEFORE UPDATE
ON project_alpha_directory_relationship_generation_recoveries BEGIN SELECT RAISE(ABORT,'relationship generation recovery authorization is immutable'); END;
CREATE TRIGGER project_alpha_directory_relationship_generation_recoveries_no_delete BEFORE DELETE
ON project_alpha_directory_relationship_generation_recoveries BEGIN SELECT RAISE(ABORT,'relationship generation recovery authorization is durable'); END;

CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_exact BEFORE INSERT
ON project_alpha_directory_relationship_generation_recoveries
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recovery_reviews review
  JOIN project_alpha_directory_relationship_outbox predecessor ON predecessor.command_id=review.predecessor_command_id
  JOIN operations_directory_client_organizations relation ON relation.client_record_id=review.client_record_id
  JOIN operations_directory_client_organization_history history ON history.client_record_id=review.client_record_id
    AND history.relationship_version=review.relationship_version
  WHERE review.review_id=NEW.review_id AND review.state='open' AND review.expires_at>NEW.authorized_at
    AND NEW.authorized_at>=review.created_at AND NEW.authorized_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.expires_at=review.expires_at
    AND review.action='assign' AND review.predecessor_command_id=NEW.predecessor_command_id
    AND review.root_command_id=NEW.root_command_id AND NEW.recovery_depth=1
    AND review.client_record_id=NEW.client_record_id AND review.relationship_version=NEW.relationship_version
    AND review.source_id=NEW.source_id AND review.source_instance_id=NEW.source_instance_id
    AND review.application_id=NEW.application_id AND review.history_epoch_id=NEW.history_epoch_id
    AND review.destination_origin=NEW.destination_origin AND review.evidence_sha256=NEW.evidence_sha256
    AND review.observed_authorization_generation=NEW.observed_authorization_generation
    AND NEW.predecessor_outcome_sha256=review.replay_conflict_sha256
    AND NEW.actor_staff_id=review.reviewer_staff_id
    AND NEW.actor_access_subject=review.reviewer_access_subject
    AND NEW.actor_email=review.reviewer_email
    AND NEW.actor_admission_version=review.reviewer_admission_version
    AND NEW.actor_profile_version=review.reviewer_profile_version
    AND predecessor.state='terminal' AND json_extract(predecessor.outcome_json,'$.httpStatus')=409
    AND predecessor.action='assign' AND predecessor.command_json=NEW.predecessor_command_json
    AND predecessor.request_json=NEW.successor_request_json
    AND predecessor.client_record_id=review.client_record_id AND predecessor.relationship_version=review.relationship_version
    AND predecessor.source_id=review.source_id AND predecessor.source_instance_id=review.source_instance_id
    AND predecessor.application_id=review.application_id AND predecessor.history_epoch_id=review.history_epoch_id
    AND predecessor.destination_origin=review.destination_origin
    AND relation.relationship_version=review.relationship_version
    AND relation.organization_record_id=review.intended_organization_record_id
    AND history.mutation_id=predecessor.mutation_id AND history.previous_organization_record_id IS NULL
    AND history.organization_record_id=review.intended_organization_record_id
    AND json_extract(NEW.successor_command_json,'$.commandId')=NEW.successor_command_id
    AND json_extract(NEW.successor_command_json,'$.expectedAuthorizationGeneration')=NEW.observed_authorization_generation
    AND json_remove(NEW.successor_command_json,'$.commandId','$.expectedAuthorizationGeneration')=
      json_remove(predecessor.command_json,'$.commandId','$.expectedAuthorizationGeneration')
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox later
      WHERE later.client_record_id=review.client_record_id AND later.source_id=review.source_id
        AND later.source_instance_id=review.source_instance_id AND later.application_id=review.application_id
        AND later.history_epoch_id=review.history_epoch_id AND later.created_at>predecessor.created_at))
BEGIN SELECT RAISE(ABORT,'relationship generation recovery is not current and exact'); END;

-- Actor and all four exact grants are rechecked at authorization time.  A deny
-- at any applicable global/resource scope wins.  The same predicate is reused
-- for both client and target organization through the resources CTE.
CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_actor BEFORE INSERT
ON project_alpha_directory_relationship_generation_recoveries
WHEN NOT EXISTS(SELECT 1 FROM staff_users staff
 JOIN native_staff_admissions admission ON admission.staff_id=staff.id
 JOIN native_staff_profiles profile ON profile.staff_id=staff.id
 WHERE staff.id=NEW.actor_staff_id AND staff.status='active' AND staff.access_subject=NEW.actor_access_subject
   AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject
   AND admission.version=NEW.actor_admission_version AND profile.login_email=NEW.actor_email
   AND profile.version=NEW.actor_profile_version
   AND EXISTS(SELECT 1 FROM staff_role_assignments administrator WHERE administrator.staff_id=staff.id
     AND administrator.role_id IN ('role-owner','role-admin') AND administrator.scope='global'))
BEGIN SELECT RAISE(ABORT,'relationship generation recovery actor is not current'); END;

-- Review evidence is immutable, but authorization is a later authority
-- boundary. Re-evaluate every mutable local/resource fact instead of treating
-- the sealed review as current authority.
CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_resources BEFORE INSERT
ON project_alpha_directory_relationship_generation_recoveries
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recovery_reviews review
  JOIN operations_directory_records client ON client.record_id=review.client_record_id
    AND client.record_kind='client' AND client.current_version=review.client_record_version
  JOIN operations_directory_records organization ON organization.record_id=review.intended_organization_record_id
    AND organization.record_kind='organization' AND organization.current_version=review.organization_record_version
  WHERE review.review_id=NEW.review_id)
 OR EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recovery_reviews review
    WHERE review.review_id=NEW.review_id AND (
      NOT EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
      WHERE enrollment.record_id=review.client_record_id
        AND json_extract(destination.value,'$.sourceId')=review.source_id
        AND json_extract(destination.value,'$.sourceInstanceUUID')=review.source_instance_id
        AND json_extract(destination.value,'$.applicationUUID')=review.application_id
        AND json_extract(destination.value,'$.historyEpoch')=review.history_epoch_id
        AND json_extract(destination.value,'$.origin')=review.destination_origin
        AND json_extract(destination.value,'$.externalCanonicalId')=review.client_external_id)
      OR NOT EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
      WHERE enrollment.record_id=review.intended_organization_record_id
        AND json_extract(destination.value,'$.sourceId')=review.source_id
        AND json_extract(destination.value,'$.sourceInstanceUUID')=review.source_instance_id
        AND json_extract(destination.value,'$.applicationUUID')=review.application_id
        AND json_extract(destination.value,'$.historyEpoch')=review.history_epoch_id
        AND json_extract(destination.value,'$.origin')=review.destination_origin
        AND json_extract(destination.value,'$.externalCanonicalId')=review.organization_external_id)))
 OR NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recovery_reviews review
    JOIN project_alpha_active_directory_mappings client_mapping ON client_mapping.record_id=review.client_record_id
      AND client_mapping.resource_type='client' AND client_mapping.source_id=review.source_id
      AND client_mapping.source_instance_id=review.source_instance_id AND client_mapping.application_id=review.application_id
      AND client_mapping.history_epoch_id=review.history_epoch_id AND client_mapping.external_id=review.client_external_id
      AND client_mapping.project_alpha_public_id=review.client_public_id
    JOIN project_alpha_active_directory_mappings organization_mapping ON organization_mapping.record_id=review.intended_organization_record_id
      AND organization_mapping.resource_type='organization' AND organization_mapping.source_id=review.source_id
      AND organization_mapping.source_instance_id=review.source_instance_id AND organization_mapping.application_id=review.application_id
      AND organization_mapping.history_epoch_id=review.history_epoch_id AND organization_mapping.external_id=review.organization_external_id
      AND organization_mapping.project_alpha_public_id=review.organization_public_id
    WHERE review.review_id=NEW.review_id)
 OR EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recovery_reviews review
    JOIN project_alpha_api_v2_inventory_receipts newer ON newer.source_id=review.source_id
      AND newer.source_instance_id=review.source_instance_id AND newer.application_id=review.application_id
      AND newer.history_epoch_id=review.history_epoch_id AND newer.inventory_kind='directory'
    WHERE review.review_id=NEW.review_id
      AND (length(newer.authorization_generation)>length(review.observed_authorization_generation)
        OR length(newer.authorization_generation)=length(review.observed_authorization_generation)
          AND newer.authorization_generation>review.observed_authorization_generation))
BEGIN SELECT RAISE(ABORT,'relationship generation recovery resources are not current and exact'); END;

CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_grants_shape BEFORE INSERT
ON project_alpha_directory_relationship_generation_recoveries
WHEN NEW.selected_grants_json<>(SELECT selected_grants_json FROM project_alpha_directory_relationship_generation_recovery_reviews WHERE review_id=NEW.review_id)
 OR (SELECT count(*) FROM json_each(NEW.selected_grants_json))<>8
 OR (SELECT count(DISTINCT json_extract(value,'$.recordId')||':'||json_extract(value,'$.permission')) FROM json_each(NEW.selected_grants_json))<>8
 OR EXISTS(SELECT 1 FROM json_each(NEW.selected_grants_json) selected
   WHERE (SELECT count(*) FROM json_each(selected.value))<>3
     OR json_type(selected.value,'$.recordId')<>'text' OR json_type(selected.value,'$.permission')<>'text'
     OR json_type(selected.value,'$.grantId')<>'text')
 OR EXISTS(SELECT 1 FROM (SELECT r.client_record_id record_id FROM project_alpha_directory_relationship_generation_recovery_reviews r WHERE r.review_id=NEW.review_id
      UNION ALL SELECT r.intended_organization_record_id FROM project_alpha_directory_relationship_generation_recovery_reviews r WHERE r.review_id=NEW.review_id) resource
    CROSS JOIN (SELECT 'directory.profile.view' permission UNION ALL SELECT 'directory.profile.edit'
      UNION ALL SELECT 'directory.identity.link' UNION ALL SELECT 'directory.enrollment.manage') needed
    WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.selected_grants_json) selected
      WHERE json_extract(selected.value,'$.recordId')=resource.record_id AND json_extract(selected.value,'$.permission')=needed.permission))
BEGIN SELECT RAISE(ABORT,'relationship generation recovery grants are not current and exact'); END;

CREATE TRIGGER project_alpha_directory_relationship_generation_recovery_grants_live BEFORE INSERT
ON project_alpha_directory_relationship_generation_recoveries
WHEN EXISTS(SELECT 1 FROM json_each(NEW.selected_grants_json) selected
  WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants g
    WHERE g.id=json_extract(selected.value,'$.grantId') AND g.staff_id=NEW.actor_staff_id
      AND g.permission=json_extract(selected.value,'$.permission') AND g.effect='allow' AND g.active=1
      AND (g.scope_kind='global' OR g.scope_kind='resource' AND g.resource_id=json_extract(selected.value,'$.recordId')
        OR g.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=json_extract(selected.value,'$.recordId') AND a.staff_id=NEW.actor_staff_id AND a.active=1)
        OR g.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.business_area_id=g.business_area_id)
        OR g.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.division_id=g.division_id)))
    OR EXISTS(SELECT 1 FROM native_directory_grants d WHERE d.staff_id=NEW.actor_staff_id
      AND d.permission=json_extract(selected.value,'$.permission') AND d.effect='deny' AND d.active=1
      AND (d.scope_kind='global' OR d.scope_kind='resource' AND d.resource_id=json_extract(selected.value,'$.recordId')
        OR d.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=json_extract(selected.value,'$.recordId') AND a.staff_id=NEW.actor_staff_id AND a.active=1)
        OR d.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.business_area_id=d.business_area_id)
        OR d.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.division_id=d.division_id))))
BEGIN SELECT RAISE(ABORT,'relationship generation recovery grants are not live'); END;

CREATE TRIGGER project_alpha_directory_relationship_recovery_outbox_exact BEFORE INSERT
ON project_alpha_directory_relationship_recovery_outbox
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recoveries recovery
 JOIN project_alpha_directory_relationship_generation_recovery_reviews review ON review.review_id=recovery.review_id
 WHERE recovery.authorization_id=NEW.authorization_id AND recovery.successor_command_id=NEW.command_id
   AND recovery.predecessor_command_id=NEW.predecessor_command_id AND recovery.client_record_id=NEW.client_record_id
   AND recovery.relationship_version=NEW.relationship_version AND recovery.source_id=NEW.source_id
   AND recovery.source_instance_id=NEW.source_instance_id AND recovery.application_id=NEW.application_id
   AND recovery.history_epoch_id=NEW.history_epoch_id AND recovery.destination_origin=NEW.destination_origin
   AND NEW.action='assign' AND NEW.client_public_id=review.client_public_id
   AND NEW.expected_client_revision=review.expected_client_revision
   AND NEW.expected_authorization_generation=recovery.observed_authorization_generation
   AND NEW.expected_current_organization_public_id IS NULL
   AND NEW.organization_record_id=review.intended_organization_record_id
   AND NEW.organization_public_id=review.organization_public_id
   AND NEW.expected_organization_revision=review.expected_organization_revision
   AND NEW.command_json=recovery.successor_command_json AND NEW.request_json=recovery.successor_request_json
   AND NEW.state='pending' AND NEW.attempts=0 AND NEW.outcome_json IS NULL)
BEGIN SELECT RAISE(ABORT,'relationship generation recovery outbox is not exact'); END;

CREATE TRIGGER project_alpha_directory_relationship_recovery_outbox_authority_immutable BEFORE UPDATE
ON project_alpha_directory_relationship_recovery_outbox
WHEN NEW.command_id<>OLD.command_id OR NEW.authorization_id<>OLD.authorization_id OR NEW.predecessor_command_id<>OLD.predecessor_command_id
 OR NEW.source_id<>OLD.source_id OR NEW.source_instance_id<>OLD.source_instance_id OR NEW.application_id<>OLD.application_id
 OR NEW.history_epoch_id<>OLD.history_epoch_id OR NEW.destination_origin<>OLD.destination_origin
 OR NEW.client_record_id<>OLD.client_record_id OR NEW.relationship_version<>OLD.relationship_version
 OR NEW.client_public_id<>OLD.client_public_id OR NEW.action<>OLD.action OR NEW.command_json<>OLD.command_json OR NEW.request_json<>OLD.request_json
BEGIN SELECT RAISE(ABORT,'relationship generation recovery outbox authority is immutable'); END;
CREATE TRIGGER project_alpha_directory_relationship_recovery_outbox_transition BEFORE UPDATE
ON project_alpha_directory_relationship_recovery_outbox
WHEN NOT (
 (OLD.state='pending' AND NEW.state='leased' AND NEW.attempts=OLD.attempts+1 AND NEW.outcome_json IS NULL)
 OR (OLD.state='leased' AND NEW.state='pending' AND NEW.attempts=OLD.attempts AND NEW.outcome_json IS NULL)
 OR (OLD.state='leased' AND NEW.state IN ('acknowledged','terminal') AND NEW.attempts=OLD.attempts AND NEW.outcome_json IS NOT NULL)
 OR (OLD.state=NEW.state AND OLD.state IN ('acknowledged','terminal') AND NEW.attempts=OLD.attempts AND NEW.outcome_json=OLD.outcome_json))
BEGIN SELECT RAISE(ABORT,'relationship generation recovery outbox transition is invalid'); END;
CREATE TRIGGER project_alpha_directory_relationship_recovery_outbox_no_delete BEFORE DELETE
ON project_alpha_directory_relationship_recovery_outbox BEGIN SELECT RAISE(ABORT,'relationship generation recovery outbox is durable'); END;

CREATE VIEW project_alpha_directory_live_relationship_generation_recoveries AS
SELECT recovery.* FROM project_alpha_directory_relationship_generation_recoveries recovery
JOIN project_alpha_directory_relationship_generation_recovery_reviews review ON review.review_id=recovery.review_id
JOIN staff_users staff ON staff.id=recovery.actor_staff_id AND staff.status='active'
 AND staff.access_subject=recovery.actor_access_subject
JOIN native_staff_admissions admission ON admission.staff_id=recovery.actor_staff_id AND admission.active=1
 AND admission.bound_access_subject=recovery.actor_access_subject AND admission.version=recovery.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=recovery.actor_staff_id
 AND profile.login_email=recovery.actor_email AND profile.version=recovery.actor_profile_version
JOIN staff_role_assignments administrator ON administrator.staff_id=recovery.actor_staff_id
 AND administrator.role_id IN ('role-owner','role-admin') AND administrator.scope='global'
JOIN operations_directory_client_organizations relation ON relation.client_record_id=recovery.client_record_id
 AND relation.relationship_version=recovery.relationship_version AND relation.organization_record_id=review.intended_organization_record_id
WHERE review.state='authorized' AND recovery.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND NOT EXISTS(SELECT 1 FROM json_each(recovery.selected_grants_json) selected
  WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants g
    WHERE g.id=json_extract(selected.value,'$.grantId') AND g.staff_id=recovery.actor_staff_id
      AND g.permission=json_extract(selected.value,'$.permission') AND g.effect='allow' AND g.active=1
      AND (g.scope_kind='global' OR g.scope_kind='resource' AND g.resource_id=json_extract(selected.value,'$.recordId')
       OR g.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=json_extract(selected.value,'$.recordId') AND a.staff_id=recovery.actor_staff_id AND a.active=1)
       OR g.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.business_area_id=g.business_area_id)
       OR g.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.division_id=g.division_id)))
   OR EXISTS(SELECT 1 FROM native_directory_grants d WHERE d.staff_id=recovery.actor_staff_id
      AND d.permission=json_extract(selected.value,'$.permission') AND d.effect='deny' AND d.active=1
      AND (d.scope_kind='global' OR d.scope_kind='resource' AND d.resource_id=json_extract(selected.value,'$.recordId')
       OR d.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=json_extract(selected.value,'$.recordId') AND a.staff_id=recovery.actor_staff_id AND a.active=1)
       OR d.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.business_area_id=d.business_area_id)
       OR d.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=json_extract(selected.value,'$.recordId') AND s.active=1 AND s.division_id=d.division_id))))
 AND NOT EXISTS(SELECT 1 FROM (SELECT review.client_record_id record_id UNION ALL SELECT review.intended_organization_record_id) resource
   WHERE NOT EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
    WHERE enrollment.record_id=resource.record_id AND json_extract(destination.value,'$.sourceId')=review.source_id
      AND json_extract(destination.value,'$.sourceInstanceUUID')=review.source_instance_id
      AND json_extract(destination.value,'$.applicationUUID')=review.application_id
      AND json_extract(destination.value,'$.historyEpoch')=review.history_epoch_id
      AND json_extract(destination.value,'$.origin')=review.destination_origin
      AND json_extract(destination.value,'$.externalCanonicalId')=CASE
        WHEN resource.record_id=review.client_record_id THEN review.client_external_id ELSE review.organization_external_id END));

CREATE VIEW project_alpha_directory_effective_relationship_commands AS
SELECT 'normal' command_kind,command_id,NULL authorization_id,NULL predecessor_command_id,source_id,source_instance_id,
 application_id,history_epoch_id,destination_origin,client_record_id,relationship_version,client_public_id,action,
 command_json,request_json,state,attempts,next_attempt_at,lease_token,lease_expires_at,outcome_json,created_at,updated_at
FROM project_alpha_directory_live_relationship_commands
UNION ALL
SELECT 'generation_recovery',outbox.command_id,outbox.authorization_id,outbox.predecessor_command_id,outbox.source_id,
 outbox.source_instance_id,outbox.application_id,outbox.history_epoch_id,outbox.destination_origin,outbox.client_record_id,
 outbox.relationship_version,outbox.client_public_id,outbox.action,outbox.command_json,outbox.request_json,outbox.state,
 outbox.attempts,outbox.next_attempt_at,outbox.lease_token,outbox.lease_expires_at,outbox.outcome_json,outbox.created_at,outbox.updated_at
FROM project_alpha_directory_relationship_recovery_outbox outbox
JOIN project_alpha_directory_live_relationship_generation_recoveries recovery ON recovery.authorization_id=outbox.authorization_id
JOIN project_alpha_directory_relationship_generation_recovery_reviews review ON review.review_id=recovery.review_id
JOIN operations_directory_client_organizations relation ON relation.client_record_id=outbox.client_record_id
 AND relation.relationship_version=outbox.relationship_version AND relation.organization_record_id=outbox.organization_record_id
JOIN project_alpha_directory_relationship_outbox predecessor ON predecessor.command_id=outbox.predecessor_command_id
 AND predecessor.state='terminal' AND json_extract(predecessor.outcome_json,'$.httpStatus')=409;

CREATE VIEW project_alpha_directory_validated_recovery_relationship_acknowledgements AS
SELECT outbox.command_id,outbox.authorization_id,outbox.predecessor_command_id,outbox.client_record_id,
 outbox.relationship_version,outbox.source_id,outbox.source_instance_id,outbox.application_id,outbox.history_epoch_id,
 outbox.destination_origin,outbox.client_public_id,outbox.organization_public_id,
 json_extract(outbox.outcome_json,'$.response.result.client.revision') revision,
 CASE WHEN outbox.state='acknowledged' AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
   AND (SELECT count(*) FROM json_each(outbox.outcome_json))=2
   AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response'))=6
   AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=outbox.source_instance_id
   AND json_extract(outbox.outcome_json,'$.response.applicationId')=outbox.application_id
   AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=outbox.history_epoch_id
   AND json_type(outbox.outcome_json,'$.response.replayed') IN ('true','false')
   AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=4
   AND json_extract(outbox.outcome_json,'$.response.result.action')='assign'
   AND json_type(outbox.outcome_json,'$.response.result.client')='object'
   AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.client'))=2
   AND json_extract(outbox.outcome_json,'$.response.result.client.publicId')=outbox.client_public_id
   AND json_type(outbox.outcome_json,'$.response.result.client.revision')='text'
   AND json_extract(outbox.outcome_json,'$.response.result.client.revision') GLOB '[1-9]*'
   AND json_extract(outbox.outcome_json,'$.response.result.client.revision') NOT GLOB '*[^0-9]*'
   AND length(json_extract(outbox.outcome_json,'$.response.result.client.revision'))<=19
   AND (length(json_extract(outbox.outcome_json,'$.response.result.client.revision'))<19
     OR json_extract(outbox.outcome_json,'$.response.result.client.revision')<='9223372036854775807')
   AND (length(json_extract(outbox.outcome_json,'$.response.result.client.revision'))>length(outbox.expected_client_revision)
     OR length(json_extract(outbox.outcome_json,'$.response.result.client.revision'))=length(outbox.expected_client_revision)
       AND json_extract(outbox.outcome_json,'$.response.result.client.revision')>outbox.expected_client_revision)
   AND json_extract(outbox.outcome_json,'$.response.result.organizationPublicId')=outbox.organization_public_id
   AND json_type(outbox.outcome_json,'$.response.result.authorizationGeneration')='text'
   AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') GLOB '[0-9]*'
   AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') NOT GLOB '*[^0-9]*'
   AND (json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')='0'
     OR substr(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'),1,1)<>'0')
   AND length(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'))<=19
   AND (length(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'))<19
     OR json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')<='9223372036854775807')
   AND (length(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'))>length(outbox.expected_authorization_generation)
     OR length(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'))=length(outbox.expected_authorization_generation)
       AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')>outbox.expected_authorization_generation)
   AND json_type(outbox.outcome_json,'$.response.requestId')='text'
   AND length(json_extract(outbox.outcome_json,'$.response.requestId'))=36
   AND substr(json_extract(outbox.outcome_json,'$.response.requestId'),15,1)='4'
   AND substr(json_extract(outbox.outcome_json,'$.response.requestId'),20,1) GLOB '[89ab]'
   AND length(replace(json_extract(outbox.outcome_json,'$.response.requestId'),'-',''))=32
   AND replace(json_extract(outbox.outcome_json,'$.response.requestId'),'-','') NOT GLOB '*[^0-9a-f]*'
 THEN 1 ELSE 0 END identity_valid
FROM project_alpha_directory_relationship_recovery_outbox outbox;

CREATE VIEW project_alpha_directory_effective_relationship_revision_evidence AS
SELECT *,NULL recovery_authorization_id,NULL root_predecessor_command_id
FROM project_alpha_directory_relationship_revision_evidence
UNION ALL
SELECT ack.client_record_id,'client',history.client_record_version,ack.source_id,ack.source_instance_id,
 ack.application_id,ack.history_epoch_id,ack.destination_origin,ack.client_public_id,ack.revision,ack.identity_valid,
 ack.authorization_id,ack.predecessor_command_id
FROM project_alpha_directory_validated_recovery_relationship_acknowledgements ack
JOIN operations_directory_client_organization_history history ON history.client_record_id=ack.client_record_id
 AND history.relationship_version=ack.relationship_version
WHERE ack.identity_valid=1;

DROP VIEW project_alpha_directory_live_relationship_commands;
CREATE VIEW project_alpha_directory_live_relationship_commands AS
SELECT command.* FROM project_alpha_directory_relationship_outbox command
JOIN operations_directory_client_organization_history history
  ON history.mutation_id=command.mutation_id AND history.client_record_id=command.client_record_id
  AND history.relationship_version=command.relationship_version
JOIN operations_directory_client_organizations current_relation
  ON current_relation.client_record_id=history.client_record_id
  AND current_relation.relationship_version=history.relationship_version
  AND current_relation.organization_record_id IS history.organization_record_id
JOIN native_staff_admissions admission ON admission.staff_id=history.actor_staff_id
  AND admission.active=1 AND admission.bound_access_subject=history.actor_access_subject
  AND admission.version=history.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=history.actor_staff_id
  AND profile.login_email=history.actor_email AND profile.version=history.actor_profile_version
WHERE command.expected_current_organization_record_id IS history.previous_organization_record_id
  AND command.organization_record_id IS history.organization_record_id
  AND ((command.action='assign' AND history.previous_organization_record_id IS NULL AND history.organization_record_id IS NOT NULL)
    OR (command.action='remove' AND history.previous_organization_record_id IS NOT NULL AND history.organization_record_id IS NULL)
    OR (command.action='move' AND history.previous_organization_record_id IS NOT NULL
      AND history.organization_record_id IS NOT NULL AND history.previous_organization_record_id<>history.organization_record_id))
  AND json_extract(command.command_json,'$.commandId')=command.command_id
  AND json_extract(command.command_json,'$.expectedClientRevision')=command.expected_client_revision
  AND json_extract(command.command_json,'$.expectedAuthorizationGeneration')=command.expected_authorization_generation
  AND json_extract(command.command_json,'$.expectedCurrentOrganizationPublicId') IS command.expected_current_organization_public_id
  AND (SELECT count(*) FROM json_each(command.command_json))=5
  AND ((command.organization_record_id IS NULL
      AND json_type(command.command_json,'$.organization')='null')
    OR (command.organization_record_id IS NOT NULL
      AND json_type(command.command_json,'$.organization')='object'
      AND (SELECT count(*) FROM json_each(json_extract(command.command_json,'$.organization')))=3
      AND json_extract(command.command_json,'$.organization.publicId')=command.organization_public_id
      AND json_extract(command.command_json,'$.organization.expectedRevision')=command.expected_organization_revision
      AND EXISTS(SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
        JOIN project_alpha_active_directory_mappings mapping
          ON mapping.record_id=resource.record_id AND mapping.resource_type=resource.record_kind
          AND mapping.source_id=command.source_id AND mapping.source_instance_id=command.source_instance_id
          AND mapping.application_id=command.application_id AND mapping.history_epoch_id=command.history_epoch_id
          AND mapping.project_alpha_public_id=resource.public_id
        WHERE resource.command_id=command.command_id AND resource.record_kind='organization'
          AND resource.record_id=command.organization_record_id
          AND mapping.external_id=json_extract(command.command_json,'$.organization.externalId'))))
  AND NOT EXISTS (
    SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
    LEFT JOIN operations_directory_records record ON record.record_id=resource.record_id
    WHERE resource.command_id=command.command_id AND (
      record.record_id IS NULL OR record.record_kind<>resource.record_kind OR record.current_version<>resource.record_version
      OR NOT EXISTS(SELECT 1 FROM operations_directory_revisions revision
        WHERE revision.record_id=resource.record_id AND revision.version=resource.record_version)
      OR NOT EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
        WHERE mapping.source_id=command.source_id AND mapping.source_instance_id=command.source_instance_id
          AND mapping.application_id=command.application_id AND mapping.history_epoch_id=command.history_epoch_id
          AND mapping.resource_type=resource.record_kind AND mapping.record_id=resource.record_id
          AND mapping.project_alpha_public_id=resource.public_id
          AND EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
            WHERE enrollment.record_id=resource.record_id
              AND json_extract(destination.value,'$.sourceId')=command.source_id
              AND json_extract(destination.value,'$.sourceInstanceUUID')=command.source_instance_id
              AND json_extract(destination.value,'$.applicationUUID')=command.application_id
              AND json_extract(destination.value,'$.historyEpoch')=command.history_epoch_id
              AND json_extract(destination.value,'$.origin')=command.destination_origin
              AND json_extract(destination.value,'$.externalCanonicalId')=mapping.external_id))
      OR EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        LEFT JOIN native_business_areas area ON area.id=scope.business_area_id
        LEFT JOIN native_business_divisions division ON division.id=scope.division_id
          AND division.business_area_id=scope.business_area_id
        WHERE scope.record_id=resource.record_id AND scope.active=1
          AND (coalesce(area.active,0)<>1 OR (scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
      OR EXISTS(SELECT 1 FROM (
          SELECT 'directory.identity.link' permission UNION ALL SELECT 'directory.profile.edit'
        ) needed WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants allow_row
          WHERE allow_row.staff_id=history.actor_staff_id AND allow_row.permission=needed.permission
            AND allow_row.effect='allow' AND allow_row.active=1
            AND (allow_row.scope_kind='global'
              OR (allow_row.scope_kind='resource' AND allow_row.resource_id=resource.record_id)
              OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=resource.record_id AND assignment.staff_id=history.actor_staff_id AND assignment.active=1))
              OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
              OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
          OR EXISTS(SELECT 1 FROM native_directory_grants deny
            WHERE deny.staff_id=history.actor_staff_id AND deny.permission=needed.permission
              AND deny.effect='deny' AND deny.active=1
              AND (deny.scope_kind='global'
                OR (deny.scope_kind='resource' AND deny.resource_id=resource.record_id)
                OR (deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                  WHERE assignment.record_id=resource.record_id AND assignment.staff_id=history.actor_staff_id AND assignment.active=1))
                OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                  WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
                OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                  WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
      )
    )
  )
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_unsettled_commands pending
    JOIN project_alpha_directory_relationship_command_resources resource ON resource.command_id=command.command_id
    JOIN project_alpha_active_directory_mappings mapping
      ON mapping.record_id=resource.record_id AND mapping.resource_type=resource.record_kind
      AND mapping.source_id=command.source_id AND mapping.source_instance_id=command.source_instance_id
      AND mapping.application_id=command.application_id AND mapping.history_epoch_id=command.history_epoch_id
      AND mapping.project_alpha_public_id=resource.public_id
    WHERE pending.source_id=command.source_id AND pending.expected_source_instance_id=command.source_instance_id
      AND pending.application_id=command.application_id AND pending.expected_history_epoch_id=command.history_epoch_id
      AND pending.resource_type=resource.record_kind AND pending.external_id=mapping.external_id
      AND pending.state<>'acknowledged')
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox predecessor
    WHERE predecessor.command_id<>command.command_id AND predecessor.client_record_id=command.client_record_id
      AND predecessor.source_id=command.source_id AND predecessor.source_instance_id=command.source_instance_id
      AND predecessor.application_id=command.application_id AND predecessor.history_epoch_id=command.history_epoch_id
      AND predecessor.relationship_version=(SELECT max(candidate.relationship_version)
        FROM project_alpha_directory_relationship_outbox candidate
        WHERE candidate.command_id<>command.command_id AND candidate.client_record_id=command.client_record_id
          AND candidate.source_id=command.source_id AND candidate.source_instance_id=command.source_instance_id
          AND candidate.application_id=command.application_id AND candidate.history_epoch_id=command.history_epoch_id
          AND candidate.relationship_version<command.relationship_version)
      AND (predecessor.state IN ('pending','leased')
        OR (predecessor.state='terminal' AND command.supersedes_terminal_command_id IS NOT predecessor.command_id
          AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_validated_recovery_relationship_acknowledgements recovery
            WHERE recovery.identity_valid=1 AND recovery.predecessor_command_id=predecessor.command_id
              AND recovery.client_record_id=predecessor.client_record_id
              AND recovery.relationship_version=predecessor.relationship_version
              AND recovery.source_id=predecessor.source_id AND recovery.source_instance_id=predecessor.source_instance_id
              AND recovery.application_id=predecessor.application_id AND recovery.history_epoch_id=predecessor.history_epoch_id
              AND recovery.destination_origin=predecessor.destination_origin))))
  AND (command.supersedes_terminal_command_id IS NULL OR EXISTS(
    SELECT 1 FROM project_alpha_directory_relationship_outbox predecessor
    WHERE predecessor.command_id=command.supersedes_terminal_command_id AND predecessor.state='terminal'
      AND predecessor.client_record_id=command.client_record_id AND predecessor.source_id=command.source_id
      AND predecessor.source_instance_id=command.source_instance_id AND predecessor.application_id=command.application_id
      AND predecessor.history_epoch_id=command.history_epoch_id
      AND predecessor.relationship_version=(SELECT max(candidate.relationship_version)
        FROM project_alpha_directory_relationship_outbox candidate
        WHERE candidate.command_id<>command.command_id AND candidate.client_record_id=command.client_record_id
          AND candidate.source_id=command.source_id AND candidate.source_instance_id=command.source_instance_id
          AND candidate.application_id=command.application_id AND candidate.history_epoch_id=command.history_epoch_id
          AND candidate.relationship_version<command.relationship_version)))
  AND (
    EXISTS(SELECT 1 FROM project_alpha_directory_outbox evidence
      WHERE evidence.source_id=command.source_id AND evidence.expected_source_instance_id=command.source_instance_id
        AND evidence.application_id=command.application_id AND evidence.expected_history_epoch_id=command.history_epoch_id
        AND evidence.destination_base_url=command.destination_origin AND evidence.state='acknowledged'
        AND json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')=command.expected_authorization_generation)
    OR EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_revision_refresh_receipts evidence
      JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=evidence.native_owner_claim_id
      JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=claim.receipt_id
      JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
      WHERE evidence.source_id=command.source_id AND evidence.source_instance_id=command.source_instance_id
        AND evidence.application_id=command.application_id AND evidence.history_epoch_id=command.history_epoch_id
        AND response.destination_origin=command.destination_origin
        AND evidence.authorization_generation=command.expected_authorization_generation)
    OR EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox evidence
      WHERE evidence.command_id<>command.command_id AND evidence.source_id=command.source_id
        AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
        AND evidence.history_epoch_id=command.history_epoch_id AND evidence.destination_origin=command.destination_origin
        AND evidence.state='acknowledged'
        AND json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')=command.expected_authorization_generation)
    OR EXISTS(SELECT 1 FROM project_alpha_directory_validated_recovery_relationship_acknowledgements recovery
      JOIN project_alpha_directory_relationship_recovery_outbox evidence ON evidence.command_id=recovery.command_id
      WHERE recovery.identity_valid=1 AND evidence.source_id=command.source_id
        AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
        AND evidence.history_epoch_id=command.history_epoch_id AND evidence.destination_origin=command.destination_origin
        AND json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')=command.expected_authorization_generation)
  )
  AND NOT EXISTS(
    SELECT generation FROM (
      SELECT json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration') generation
      FROM project_alpha_directory_outbox evidence
      WHERE evidence.source_id=command.source_id AND evidence.expected_source_instance_id=command.source_instance_id
        AND evidence.application_id=command.application_id AND evidence.expected_history_epoch_id=command.history_epoch_id
        AND evidence.destination_base_url=command.destination_origin AND evidence.state='acknowledged'
      UNION ALL
      SELECT evidence.authorization_generation FROM project_alpha_existing_directory_binding_revision_refresh_receipts evidence
      JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=evidence.native_owner_claim_id
      JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=claim.receipt_id
      JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
      WHERE evidence.source_id=command.source_id AND evidence.source_instance_id=command.source_instance_id
        AND evidence.application_id=command.application_id AND evidence.history_epoch_id=command.history_epoch_id
        AND response.destination_origin=command.destination_origin
      UNION ALL
      SELECT json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')
      FROM project_alpha_directory_relationship_outbox evidence
      WHERE evidence.command_id<>command.command_id AND evidence.source_id=command.source_id
        AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
        AND evidence.history_epoch_id=command.history_epoch_id AND evidence.destination_origin=command.destination_origin
        AND evidence.state='acknowledged'
      UNION ALL
      SELECT json_extract(evidence.outcome_json,'$.response.result.authorizationGeneration')
      FROM project_alpha_directory_validated_recovery_relationship_acknowledgements recovery
      JOIN project_alpha_directory_relationship_recovery_outbox evidence ON evidence.command_id=recovery.command_id
      WHERE recovery.identity_valid=1 AND evidence.source_id=command.source_id
        AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
        AND evidence.history_epoch_id=command.history_epoch_id AND evidence.destination_origin=command.destination_origin
    ) WHERE generation IS NULL OR length(generation) NOT BETWEEN 1 AND 19
      OR generation GLOB '*[^0-9]*' OR (length(generation)>1 AND substr(generation,1,1)='0')
      OR (length(generation)=19 AND generation>'9223372036854775806')
      OR (length(generation)>length(command.expected_authorization_generation)
        OR (length(generation)=length(command.expected_authorization_generation)
          AND generation>command.expected_authorization_generation))
  )
  AND NOT EXISTS(
    SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
    WHERE resource.command_id=command.command_id AND resource.expected_revision IS NOT NULL AND (
      NOT EXISTS(SELECT 1 FROM project_alpha_directory_effective_relationship_revision_evidence evidence
        WHERE evidence.record_id=resource.record_id AND evidence.record_kind=resource.record_kind
          AND evidence.record_version=resource.record_version AND evidence.source_id=command.source_id
          AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
          AND evidence.history_epoch_id=command.history_epoch_id
          AND evidence.destination_origin=command.destination_origin
          AND evidence.public_id=resource.public_id AND evidence.revision=resource.expected_revision
          AND evidence.identity_valid=1)
      OR EXISTS(SELECT 1 FROM project_alpha_directory_effective_relationship_revision_evidence evidence
        WHERE evidence.record_id=resource.record_id AND evidence.record_kind=resource.record_kind
          AND evidence.record_version=resource.record_version AND evidence.source_id=command.source_id
          AND evidence.source_instance_id=command.source_instance_id AND evidence.application_id=command.application_id
          AND evidence.history_epoch_id=command.history_epoch_id
          AND evidence.destination_origin=command.destination_origin
          AND (evidence.identity_valid<>1 OR evidence.public_id IS NOT resource.public_id
            OR evidence.revision IS NULL OR length(evidence.revision) NOT BETWEEN 1 AND 19
            OR evidence.revision GLOB '*[^0-9]*' OR substr(evidence.revision,1,1)='0'
            OR (length(evidence.revision)=19 AND evidence.revision>'9223372036854775807')
            OR length(evidence.revision)>length(resource.expected_revision)
            OR (length(evidence.revision)=length(resource.expected_revision)
              AND evidence.revision>resource.expected_revision)))
    )
  );
