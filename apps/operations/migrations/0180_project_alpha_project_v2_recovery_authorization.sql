PRAGMA foreign_keys = ON;

-- Durable, default-inert authority for replaying one exact Project API v2
-- request after its original native command proof is no longer suitable for a
-- new transport attempt.  This migration mounts no route and performs no
-- dispatch.  The short lifetime contains replay; it is not evidence of a
-- recent authentication ceremony.
CREATE TABLE project_alpha_project_v2_recovery_authorizations (
  authorization_id TEXT NOT NULL PRIMARY KEY
    CHECK(length(authorization_id)=36 AND authorization_id=lower(authorization_id)
      AND authorization_id NOT GLOB '*[^0-9a-f-]*' AND substr(authorization_id,9,1)='-'
      AND substr(authorization_id,14,1)='-' AND substr(authorization_id,15,1)='4'
      AND substr(authorization_id,19,1)='-' AND substr(authorization_id,20,1) IN ('8','9','a','b')
      AND substr(authorization_id,24,1)='-' AND length(replace(authorization_id,'-',''))=32),
  command_id TEXT NOT NULL REFERENCES project_alpha_project_v2_request_fingerprints(command_id) ON DELETE RESTRICT,
  original_event_state_version INTEGER NOT NULL
    CHECK(typeof(original_event_state_version)='integer' AND original_event_state_version>=1),
  eligibility_state TEXT NOT NULL CHECK(eligibility_state IN ('terminal_uncertain','expired_lease_lost_ack')),
  original_outbox_state TEXT NOT NULL CHECK(original_outbox_state IN ('leased','terminal')),
  original_attempts INTEGER NOT NULL CHECK(typeof(original_attempts)='integer' AND original_attempts>=1),
  original_lease_token TEXT,
  original_lease_expires_at INTEGER,
  original_outcome_json TEXT CHECK(original_outcome_json IS NULL OR (json_valid(original_outcome_json)
    AND json_type(original_outcome_json)='object' AND length(CAST(original_outcome_json AS BLOB))<=65536)),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation TEXT NOT NULL CHECK(operation IN ('create','update','bind')),
  external_project_id TEXT NOT NULL REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  destination_origin TEXT NOT NULL CHECK(substr(destination_origin,1,8)='https://'
    AND length(destination_origin)<=2048 AND substr(destination_origin,-1)<>'/'),
  expected_local_version INTEGER NOT NULL
    CHECK(typeof(expected_local_version)='integer' AND expected_local_version BETWEEN 0 AND 9007199254740991),
  expected_local_projection_sha256 TEXT
    CHECK(expected_local_projection_sha256 IS NULL OR (length(expected_local_projection_sha256)=64
      AND expected_local_projection_sha256=lower(expected_local_projection_sha256)
      AND expected_local_projection_sha256 NOT GLOB '*[^0-9a-f]*')),
  expected_mapping_state TEXT NOT NULL CHECK(expected_mapping_state IN ('absent','exact')),
  expected_project_alpha_public_id TEXT
    CHECK(expected_project_alpha_public_id IS NULL OR (length(expected_project_alpha_public_id)=32
      AND expected_project_alpha_public_id=lower(expected_project_alpha_public_id)
      AND expected_project_alpha_public_id NOT GLOB '*[^0-9a-f]*')),
  original_actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  original_actor_access_subject TEXT NOT NULL CHECK(length(original_actor_access_subject) BETWEEN 1 AND 191),
  original_actor_email TEXT NOT NULL CHECK(length(original_actor_email) BETWEEN 3 AND 254),
  original_actor_admission_version INTEGER NOT NULL
    CHECK(typeof(original_actor_admission_version)='integer' AND original_actor_admission_version>=1),
  original_actor_profile_version INTEGER NOT NULL
    CHECK(typeof(original_actor_profile_version)='integer' AND original_actor_profile_version>=1),
  original_actor_project_grant_generation INTEGER NOT NULL
    CHECK(typeof(original_actor_project_grant_generation)='integer'
      AND original_actor_project_grant_generation>=1),
  original_actor_scopes_json TEXT NOT NULL
    CHECK(json_valid(original_actor_scopes_json) AND json_type(original_actor_scopes_json)='array'
      AND json_array_length(original_actor_scopes_json)<=128),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191),
  actor_email TEXT NOT NULL CHECK(length(actor_email) BETWEEN 3 AND 254),
  actor_admission_version INTEGER NOT NULL
    CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL
    CHECK(typeof(actor_profile_version)='integer' AND actor_profile_version>=1),
  actor_project_grant_generation INTEGER NOT NULL
    CHECK(typeof(actor_project_grant_generation)='integer' AND actor_project_grant_generation>=1),
  actor_scopes_json TEXT NOT NULL
    CHECK(json_valid(actor_scopes_json) AND json_type(actor_scopes_json)='array'
      AND json_array_length(actor_scopes_json)<=128),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND length(trim(reason)) BETWEEN 1 AND 500
    AND instr(reason,char(0))=0),
  authorized_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(authorized_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',authorized_at) IS authorized_at),
  expires_at TEXT NOT NULL
    CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  CHECK((expected_local_version=0 AND expected_local_projection_sha256 IS NULL)
    OR (expected_local_version>=1 AND expected_local_projection_sha256 IS NOT NULL)),
  CHECK((expected_mapping_state='absent' AND expected_project_alpha_public_id IS NULL)
    OR (expected_mapping_state='exact' AND expected_project_alpha_public_id IS NOT NULL)),
  CHECK((eligibility_state='terminal_uncertain' AND original_outbox_state='terminal'
      AND original_lease_token IS NULL AND original_lease_expires_at IS NULL
      AND original_outcome_json IS NOT NULL)
    OR (eligibility_state='expired_lease_lost_ack' AND original_outbox_state='leased'
      AND original_lease_token IS NOT NULL AND original_lease_expires_at IS NOT NULL
      AND original_outcome_json IS NULL))
);
CREATE INDEX project_alpha_project_v2_recovery_authorizations_command
  ON project_alpha_project_v2_recovery_authorizations(command_id,expires_at);

-- A row remains live only while the command still has precisely the uncertain
-- state, immutable body/destination/local fences, and deny-aware authority that
-- were checked at issuance.  Recovery is intentionally limited to the exact
-- original command actor: the post-ack settlement ledger is actor-bound, so a
-- different manager must fail before any external dispatch until a separately
-- reviewed manager-through-receipt design exists.
CREATE VIEW project_alpha_project_v2_live_recovery_authorizations AS
SELECT authorization.*
FROM project_alpha_project_v2_recovery_authorizations authorization
JOIN project_alpha_project_v2_request_fingerprints fingerprint
  ON fingerprint.command_id=authorization.command_id
 AND fingerprint.request_sha256=authorization.request_sha256
JOIN project_alpha_project_outbox outbox
  ON outbox.command_id=authorization.command_id
 AND outbox.operation=authorization.operation
 AND outbox.external_project_id=authorization.external_project_id
 AND outbox.source_id=authorization.source_id
 AND outbox.expected_source_instance_id=authorization.source_instance_id
 AND outbox.application_id=authorization.application_id
 AND outbox.expected_history_epoch_id=authorization.history_epoch_id
 AND rtrim(outbox.destination_base_url,'/')=authorization.destination_origin
JOIN native_project_command_reservations reservation
  ON reservation.command_id=authorization.command_id
JOIN native_project_command_proofs original_proof
  ON original_proof.command_id=authorization.command_id
 AND original_proof.external_project_id=authorization.external_project_id
 AND original_proof.actor_staff_id=authorization.original_actor_staff_id
 AND original_proof.actor_access_subject=authorization.original_actor_access_subject
 AND original_proof.actor_admission_version=authorization.original_actor_admission_version
 AND original_proof.actor_profile_version=authorization.original_actor_profile_version
 AND original_proof.actor_email=authorization.original_actor_email
 AND original_proof.grant_generation=authorization.original_actor_project_grant_generation
 AND json(original_proof.scopes_json)=json(authorization.original_actor_scopes_json)
JOIN project_alpha_project_v2_canonical_intents intent
  ON intent.command_id=authorization.command_id
 AND intent.request_sha256=authorization.request_sha256
 AND intent.operation=authorization.operation
 AND intent.external_project_id=authorization.external_project_id
 AND intent.source_id=authorization.source_id
 AND intent.source_instance_id=authorization.source_instance_id
 AND intent.application_id=authorization.application_id
 AND intent.history_epoch_id=authorization.history_epoch_id
 AND intent.expected_local_version=authorization.expected_local_version
 AND intent.expected_local_projection_sha256 IS authorization.expected_local_projection_sha256
 AND intent.expected_mapping_state=authorization.expected_mapping_state
 AND intent.expected_project_alpha_public_id IS authorization.expected_project_alpha_public_id
 AND intent.expected_grant_generation=authorization.original_actor_project_grant_generation
JOIN project_alpha_project_v2_events original_event
  ON original_event.command_id=authorization.command_id
 AND original_event.state_version=authorization.original_event_state_version
 AND original_event.request_sha256=authorization.request_sha256
JOIN native_staff_admissions admission
  ON admission.staff_id=authorization.actor_staff_id AND admission.active=1
 AND admission.bound_access_subject=authorization.actor_access_subject
 AND admission.version=authorization.actor_admission_version
JOIN native_staff_profiles profile
  ON profile.staff_id=authorization.actor_staff_id
 AND profile.login_email=authorization.actor_email
 AND profile.version=authorization.actor_profile_version
JOIN native_project_grant_generations generation
  ON generation.staff_id=authorization.actor_staff_id
 AND generation.generation=authorization.actor_project_grant_generation
JOIN native_staff_admissions original_admission
  ON original_admission.staff_id=authorization.original_actor_staff_id AND original_admission.active=1
 AND original_admission.bound_access_subject=authorization.original_actor_access_subject
 AND original_admission.version=authorization.original_actor_admission_version
JOIN native_staff_profiles original_profile
  ON original_profile.staff_id=authorization.original_actor_staff_id
 AND original_profile.login_email=authorization.original_actor_email
 AND original_profile.version=authorization.original_actor_profile_version
JOIN native_project_grant_generations original_generation
  ON original_generation.staff_id=authorization.original_actor_staff_id
 AND original_generation.generation=authorization.original_actor_project_grant_generation
WHERE authorization.authorized_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND authorization.actor_staff_id=authorization.original_actor_staff_id
  AND authorization.actor_access_subject=authorization.original_actor_access_subject
  AND authorization.actor_email=authorization.original_actor_email
  AND authorization.actor_admission_version=authorization.original_actor_admission_version
  AND authorization.actor_profile_version=authorization.original_actor_profile_version
  AND authorization.actor_project_grant_generation=authorization.original_actor_project_grant_generation
  AND json(authorization.actor_scopes_json)=json(authorization.original_actor_scopes_json)
  AND authorization.expires_at>authorization.authorized_at
  AND authorization.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',authorization.authorized_at,'+15 minutes')
  AND authorization.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND json_type(outbox.command_json,'$.commandId')='text'
  AND json_extract(outbox.command_json,'$.commandId')=authorization.command_id
  AND json_type(outbox.command_json,'$.externalId')='text'
  AND json_extract(outbox.command_json,'$.externalId')=authorization.external_project_id
  AND original_event.state='uncertain'
  AND outbox.state IN ('terminal','pending','leased','acknowledged')
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events later
    WHERE later.command_id=authorization.command_id
      AND (later.state_version>authorization.original_event_state_version+2
        OR (later.state_version=authorization.original_event_state_version+1 AND later.state<>'pending')
        OR (later.state_version=authorization.original_event_state_version+2 AND later.state<>'acknowledged')))
  AND ((authorization.expected_local_version=0 AND NOT EXISTS (
      SELECT 1 FROM operations_shared_projects project
      WHERE project.external_project_id=authorization.external_project_id))
    OR (authorization.expected_local_version>=1 AND EXISTS (
      SELECT 1 FROM operations_shared_projects project
      WHERE project.external_project_id=authorization.external_project_id
        AND project.current_version=authorization.expected_local_version
        AND project.canonical_projection_sha256=authorization.expected_local_projection_sha256)))
  AND ((authorization.expected_mapping_state='absent' AND NOT EXISTS (
      SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=authorization.external_project_id))
    OR (authorization.expected_mapping_state='exact' AND EXISTS (
      SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=authorization.external_project_id
        AND mapping.source_id=authorization.source_id
        AND mapping.source_instance_id=authorization.source_instance_id
        AND mapping.application_id=authorization.application_id
        AND mapping.history_epoch_id=authorization.history_epoch_id
        AND mapping.project_alpha_public_id=authorization.expected_project_alpha_public_id)))
  AND EXISTS (SELECT 1 FROM operations_portal_workspace_effective_permissions permission
    WHERE permission.staff_id=authorization.actor_staff_id
      AND permission.permission_key='integrations.manage'
      AND permission.effect='allow' AND permission.scope='global')
  AND NOT EXISTS (SELECT 1 FROM operations_portal_workspace_effective_permissions permission
    WHERE permission.staff_id=authorization.actor_staff_id
      AND permission.permission_key='integrations.manage'
      AND permission.effect='deny' AND permission.scope='global')
  AND NOT EXISTS (SELECT 1 FROM json_each(authorization.actor_scopes_json) scope
    LEFT JOIN native_business_areas area
      ON area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
    LEFT JOIN native_business_divisions division
      ON division.id=json_extract(scope.value,'$.divisionId')
     AND division.business_area_id=area.id AND division.active=1
    WHERE json_type(scope.value) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(scope.value))<>3
      OR EXISTS (SELECT 1 FROM json_each(scope.value) member
        WHERE member.key NOT IN ('scopeKind','businessAreaId','divisionId'))
      OR json_type(scope.value,'$.scopeKind') IS NOT 'text'
      OR json_extract(scope.value,'$.scopeKind') NOT IN ('business_area','division')
      OR json_type(scope.value,'$.businessAreaId') IS NOT 'text' OR area.id IS NULL
      OR (json_extract(scope.value,'$.scopeKind')='business_area'
        AND (json_type(scope.value,'$.divisionId') IS NOT 'null'
          OR json_extract(scope.value,'$.divisionId') IS NOT NULL))
      OR (json_extract(scope.value,'$.scopeKind')='division'
        AND (json_type(scope.value,'$.divisionId') IS NOT 'text' OR division.id IS NULL)))
  AND NOT EXISTS (SELECT 1 FROM json_each(authorization.actor_scopes_json) scope
    WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
      WHERE grant_row.staff_id=authorization.actor_staff_id
        AND grant_row.capability='project.shared.sync'
        AND grant_row.effect='allow' AND grant_row.active=1
        AND (grant_row.scope_kind='global'
          OR (grant_row.scope_kind='exact_project'
            AND grant_row.external_project_id=authorization.external_project_id)
          OR (grant_row.scope_kind='business_area'
            AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
          OR (grant_row.scope_kind='division'
            AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
  AND (json_array_length(authorization.actor_scopes_json)>0 OR EXISTS (
    SELECT 1 FROM native_project_grants grant_row
    WHERE grant_row.staff_id=authorization.actor_staff_id
      AND grant_row.capability='project.shared.sync'
      AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global'
        OR (grant_row.scope_kind='exact_project'
          AND grant_row.external_project_id=authorization.external_project_id))))
  AND NOT EXISTS (SELECT 1 FROM native_project_grants deny
    WHERE deny.staff_id=authorization.actor_staff_id
      AND deny.capability='project.shared.sync'
      AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global'
        OR (deny.scope_kind='exact_project'
          AND deny.external_project_id=authorization.external_project_id)
        OR EXISTS (SELECT 1 FROM json_each(authorization.actor_scopes_json) scope
          WHERE (deny.scope_kind='business_area'
              AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId'))
            OR (deny.scope_kind='division'
              AND deny.division_id=json_extract(scope.value,'$.divisionId')))))
  AND NOT EXISTS (SELECT 1 FROM json_each(authorization.original_actor_scopes_json) scope
    WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
      WHERE grant_row.staff_id=authorization.original_actor_staff_id
        AND grant_row.capability='project.shared.sync'
        AND grant_row.effect='allow' AND grant_row.active=1
        AND (grant_row.scope_kind='global'
          OR (grant_row.scope_kind='exact_project'
            AND grant_row.external_project_id=authorization.external_project_id)
          OR (grant_row.scope_kind='business_area'
            AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
          OR (grant_row.scope_kind='division'
            AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
  AND (json_array_length(authorization.original_actor_scopes_json)>0 OR EXISTS (
    SELECT 1 FROM native_project_grants grant_row
    WHERE grant_row.staff_id=authorization.original_actor_staff_id
      AND grant_row.capability='project.shared.sync'
      AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global'
        OR (grant_row.scope_kind='exact_project'
          AND grant_row.external_project_id=authorization.external_project_id))))
  AND NOT EXISTS (SELECT 1 FROM native_project_grants deny
    WHERE deny.staff_id=authorization.original_actor_staff_id
      AND deny.capability='project.shared.sync'
      AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global'
        OR (deny.scope_kind='exact_project'
          AND deny.external_project_id=authorization.external_project_id)
        OR EXISTS (SELECT 1 FROM json_each(authorization.original_actor_scopes_json) scope
          WHERE (deny.scope_kind='business_area'
              AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId'))
            OR (deny.scope_kind='division'
              AND deny.division_id=json_extract(scope.value,'$.divisionId')))));

-- Preserve the established proof contract for every existing consumer while
-- adding only still-live, fully fenced recovery authority in the identical
-- column shape.  The recovery branch disappears on expiry or any authority,
-- command, local-head, mapping, or allowed-transition drift.
DROP VIEW native_project_live_command_proofs;
CREATE VIEW native_project_live_command_proofs AS
SELECT proof.* FROM native_project_command_proofs proof
JOIN native_staff_admissions admission ON admission.staff_id=proof.actor_staff_id
  AND admission.active=1 AND admission.bound_access_subject=proof.actor_access_subject
  AND admission.version=proof.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=proof.actor_staff_id
  AND profile.login_email=proof.actor_email AND profile.version=proof.actor_profile_version
JOIN native_project_grant_generations generation ON generation.staff_id=proof.actor_staff_id
  AND generation.generation=proof.grant_generation
WHERE NOT EXISTS (SELECT 1 FROM json_each(proof.scopes_json) scope
  LEFT JOIN native_business_areas area ON area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
  LEFT JOIN native_business_divisions division ON division.id=json_extract(scope.value,'$.divisionId')
    AND division.business_area_id=area.id AND division.active=1
  WHERE json_type(scope.value) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(scope.value))<>3
    OR EXISTS (SELECT 1 FROM json_each(scope.value) member
      WHERE member.key NOT IN ('scopeKind','businessAreaId','divisionId'))
    OR json_type(scope.value,'$.scopeKind') IS NOT 'text'
    OR json_extract(scope.value,'$.scopeKind') NOT IN ('business_area','division')
    OR json_type(scope.value,'$.businessAreaId') IS NOT 'text' OR area.id IS NULL
    OR (json_extract(scope.value,'$.scopeKind')='business_area'
      AND (json_type(scope.value,'$.divisionId') IS NOT 'null' OR json_extract(scope.value,'$.divisionId') IS NOT NULL))
    OR (json_extract(scope.value,'$.scopeKind')='division'
      AND (json_type(scope.value,'$.divisionId') IS NOT 'text' OR division.id IS NULL)))
  AND NOT EXISTS (SELECT 1 FROM json_each(proof.scopes_json) scope
    WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
      WHERE grant_row.staff_id=proof.actor_staff_id AND grant_row.capability='project.shared.sync'
        AND grant_row.effect='allow' AND grant_row.active=1
        AND (grant_row.scope_kind='global'
          OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=proof.external_project_id)
          OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
          OR (grant_row.scope_kind='division' AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
  AND (json_array_length(proof.scopes_json)>0 OR EXISTS (SELECT 1 FROM native_project_grants grant_row
    WHERE grant_row.staff_id=proof.actor_staff_id AND grant_row.capability='project.shared.sync'
      AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='exact_project'
        AND grant_row.external_project_id=proof.external_project_id))))
  AND NOT EXISTS (SELECT 1 FROM native_project_grants deny
    WHERE deny.staff_id=proof.actor_staff_id AND deny.capability='project.shared.sync'
      AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global'
        OR (deny.scope_kind='exact_project' AND deny.external_project_id=proof.external_project_id)
        OR EXISTS (SELECT 1 FROM json_each(proof.scopes_json) scope
          WHERE (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId'))
            OR (deny.scope_kind='division' AND deny.division_id=json_extract(scope.value,'$.divisionId')))))
UNION ALL
SELECT recovery.command_id,recovery.external_project_id,recovery.actor_staff_id,
  recovery.actor_access_subject,recovery.actor_admission_version,recovery.actor_profile_version,
  recovery.actor_email,recovery.expires_at,recovery.actor_project_grant_generation,
  recovery.actor_scopes_json,recovery.authorized_at
FROM project_alpha_project_v2_live_recovery_authorizations recovery;

CREATE TRIGGER project_alpha_project_v2_recovery_authorizations_insert_guard
AFTER INSERT ON project_alpha_project_v2_recovery_authorizations
WHEN NEW.authorized_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_live_recovery_authorizations live
  WHERE live.authorization_id=NEW.authorization_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox
   WHERE outbox.command_id=NEW.command_id AND (outbox.state<>NEW.original_outbox_state
     OR outbox.attempts<>NEW.original_attempts
     OR outbox.lease_token IS NOT NEW.original_lease_token
     OR outbox.lease_expires_at IS NOT NEW.original_lease_expires_at
     OR outbox.outcome_json IS NOT NEW.original_outcome_json))
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events original_event
   WHERE original_event.command_id=NEW.command_id
     AND original_event.state_version=NEW.original_event_state_version
     AND original_event.request_sha256=NEW.request_sha256
     AND original_event.state='uncertain')
 OR (NEW.eligibility_state='expired_lease_lost_ack' AND NOT EXISTS (
   SELECT 1 FROM project_alpha_project_v2_events prior
   WHERE prior.command_id=NEW.command_id
     AND prior.state_version=NEW.original_event_state_version-1
     AND prior.request_sha256=NEW.request_sha256 AND prior.state='pending'))
 OR EXISTS (SELECT 1 FROM project_alpha_project_v2_events later
   WHERE later.command_id=NEW.command_id AND later.state_version>NEW.original_event_state_version)
 OR EXISTS (SELECT 1 FROM project_alpha_project_v2_success_receipts receipt
   WHERE receipt.command_id=NEW.command_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_v2_recovery_authorizations prior
   WHERE prior.command_id=NEW.command_id
     AND prior.original_event_state_version=NEW.original_event_state_version
     AND prior.authorization_id<>NEW.authorization_id
     AND prior.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR (NEW.eligibility_state='expired_lease_lost_ack'
   AND NEW.original_lease_expires_at>unixepoch('now'))
BEGIN SELECT RAISE(ABORT,'project v2 recovery authorization is not current and exact'); END;

-- Reopening is a two-step atomic-batch protocol: first append the one pending
-- successor to the authorized uncertain event, then move the exact frozen
-- terminal/expired-lease row to pending.  Neither write is sufficient alone.
CREATE TRIGGER project_alpha_project_v2_recovery_pending_event_guard
BEFORE INSERT ON project_alpha_project_v2_events
WHEN NEW.state='pending' AND EXISTS (
  SELECT 1 FROM project_alpha_project_v2_events prior
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=prior.command_id
  WHERE prior.command_id=NEW.command_id AND prior.state_version=NEW.state_version-1
    AND prior.state='uncertain'
    AND (outbox.state='terminal'
      OR (outbox.state='leased' AND outbox.lease_expires_at<=unixepoch('now'))))
 AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_live_recovery_authorizations authorization
  WHERE authorization.command_id=NEW.command_id
    AND authorization.original_event_state_version=NEW.state_version-1
    AND authorization.request_sha256=NEW.request_sha256)
BEGIN SELECT RAISE(ABORT,'project v2 uncertain reopen requires exact recovery authority'); END;

CREATE TRIGGER project_alpha_project_v2_recovery_outbox_reopen_guard
BEFORE UPDATE OF state ON project_alpha_project_outbox
WHEN NEW.state='pending'
 AND (OLD.state='terminal' OR (OLD.state='leased' AND OLD.lease_expires_at<=unixepoch('now')))
 AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_live_recovery_authorizations authorization
  JOIN project_alpha_project_v2_events pending_event
    ON pending_event.command_id=authorization.command_id
   AND pending_event.state_version=authorization.original_event_state_version+1
   AND pending_event.request_sha256=authorization.request_sha256
   AND pending_event.state='pending'
  WHERE authorization.command_id=OLD.command_id
    AND authorization.original_outbox_state=OLD.state
    AND authorization.original_attempts=OLD.attempts
    AND authorization.original_lease_token IS OLD.lease_token
    AND authorization.original_lease_expires_at IS OLD.lease_expires_at
    AND authorization.original_outcome_json IS OLD.outcome_json
    AND NEW.attempts=OLD.attempts
    AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
    AND NEW.outcome_json IS NULL
    AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events later
      WHERE later.command_id=authorization.command_id
        AND later.state_version>pending_event.state_version))
BEGIN SELECT RAISE(ABORT,'project v2 outbox reopen requires exact recovery transition'); END;

CREATE TRIGGER project_alpha_project_v2_recovery_terminal_transition_guard
BEFORE UPDATE OF state ON project_alpha_project_outbox
WHEN OLD.state='terminal' AND NEW.state<>OLD.state AND NEW.state<>'pending'
BEGIN SELECT RAISE(ABORT,'project v2 terminal recovery must reopen to pending'); END;

CREATE TRIGGER project_alpha_project_v2_recovery_authorizations_no_update
BEFORE UPDATE ON project_alpha_project_v2_recovery_authorizations
BEGIN SELECT RAISE(ABORT,'project v2 recovery authorizations are immutable'); END;

CREATE TRIGGER project_alpha_project_v2_recovery_authorizations_no_delete
BEFORE DELETE ON project_alpha_project_v2_recovery_authorizations
BEGIN SELECT RAISE(ABORT,'project v2 recovery authorizations are durable'); END;

-- A transport acknowledgement is durable independently of the short-lived
-- proof that authorized its POST.  If the subsequent private GET settlement
-- or local activation is interrupted, the same authenticated original actor may issue a second,
-- receipt-bound authorization.  This authority is intentionally absent from
-- native_project_live_command_proofs: it can settle and activate the exact
-- acknowledged command, but it can never lease, dispatch, or reopen it.
CREATE TABLE project_alpha_project_v2_post_ack_authorizations (
  authorization_id TEXT NOT NULL PRIMARY KEY
    CHECK(length(authorization_id)=36 AND authorization_id=lower(authorization_id)
      AND authorization_id NOT GLOB '*[^0-9a-f-]*' AND substr(authorization_id,9,1)='-'
      AND substr(authorization_id,14,1)='-' AND substr(authorization_id,15,1)='4'
      AND substr(authorization_id,19,1)='-' AND substr(authorization_id,20,1) IN ('8','9','a','b')
      AND substr(authorization_id,24,1)='-' AND length(replace(authorization_id,'-',''))=32),
  success_receipt_id TEXT NOT NULL REFERENCES project_alpha_project_v2_success_receipts(receipt_id) ON DELETE RESTRICT,
  acknowledgement_id TEXT NOT NULL REFERENCES project_alpha_project_v2_validated_acknowledgements(acknowledgement_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL REFERENCES project_alpha_project_v2_request_fingerprints(command_id) ON DELETE RESTRICT,
  acknowledged_state_version INTEGER NOT NULL
    CHECK(typeof(acknowledged_state_version)='integer' AND acknowledged_state_version>=1),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64 AND response_sha256=lower(response_sha256)
    AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation TEXT NOT NULL CHECK(operation IN ('create','update','bind')),
  external_project_id TEXT NOT NULL REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  destination_origin TEXT NOT NULL CHECK(substr(destination_origin,1,8)='https://'
    AND length(destination_origin)<=2048 AND substr(destination_origin,-1)<>'/'),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32
    AND project_alpha_public_id=lower(project_alpha_public_id)
    AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(length(project_alpha_revision) BETWEEN 1 AND 19
    AND project_alpha_revision NOT GLOB '*[^0-9]*' AND substr(project_alpha_revision,1,1)<>'0'),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64
    AND projection_sha256=lower(projection_sha256) AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_local_version INTEGER NOT NULL
    CHECK(typeof(expected_local_version)='integer' AND expected_local_version BETWEEN 0 AND 9007199254740991),
  expected_local_projection_sha256 TEXT
    CHECK(expected_local_projection_sha256 IS NULL OR (length(expected_local_projection_sha256)=64
      AND expected_local_projection_sha256=lower(expected_local_projection_sha256)
      AND expected_local_projection_sha256 NOT GLOB '*[^0-9a-f]*')),
  expected_mapping_state TEXT NOT NULL CHECK(expected_mapping_state IN ('absent','exact')),
  expected_project_alpha_public_id TEXT
    CHECK(expected_project_alpha_public_id IS NULL OR (length(expected_project_alpha_public_id)=32
      AND expected_project_alpha_public_id=lower(expected_project_alpha_public_id)
      AND expected_project_alpha_public_id NOT GLOB '*[^0-9a-f]*')),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191),
  actor_email TEXT NOT NULL CHECK(length(actor_email) BETWEEN 3 AND 254),
  actor_admission_version INTEGER NOT NULL CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(typeof(actor_profile_version)='integer' AND actor_profile_version>=1),
  actor_project_grant_generation INTEGER NOT NULL
    CHECK(typeof(actor_project_grant_generation)='integer' AND actor_project_grant_generation>=1),
  actor_scopes_json TEXT NOT NULL CHECK(json_valid(actor_scopes_json) AND json_type(actor_scopes_json)='array'
    AND json_array_length(actor_scopes_json)<=128),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND length(trim(reason)) BETWEEN 1 AND 500
    AND instr(reason,char(0))=0),
  authorized_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(authorized_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',authorized_at) IS authorized_at),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  CHECK((expected_local_version=0 AND expected_local_projection_sha256 IS NULL)
    OR (expected_local_version>=1 AND expected_local_projection_sha256 IS NOT NULL)),
  CHECK((expected_mapping_state='absent' AND expected_project_alpha_public_id IS NULL)
    OR (expected_mapping_state='exact' AND expected_project_alpha_public_id IS NOT NULL)),
  FOREIGN KEY(command_id,acknowledged_state_version)
    REFERENCES project_alpha_project_v2_events(command_id,state_version) ON DELETE RESTRICT
);
CREATE INDEX project_alpha_project_v2_post_ack_authorizations_receipt
  ON project_alpha_project_v2_post_ack_authorizations(success_receipt_id,expires_at);

CREATE VIEW project_alpha_project_v2_live_post_ack_authorizations AS
SELECT authorization.*
FROM project_alpha_project_v2_post_ack_authorizations authorization
JOIN project_alpha_project_v2_success_receipts receipt
  ON receipt.receipt_id=authorization.success_receipt_id
 AND receipt.acknowledgement_id=authorization.acknowledgement_id
 AND receipt.command_id=authorization.command_id
 AND receipt.request_sha256=authorization.request_sha256
 AND receipt.response_sha256=authorization.response_sha256
 AND receipt.source_instance_id=authorization.source_instance_id
 AND receipt.application_id=authorization.application_id
 AND receipt.history_epoch_id=authorization.history_epoch_id
 AND receipt.destination_origin=authorization.destination_origin
 AND receipt.project_alpha_public_id=authorization.project_alpha_public_id
 AND receipt.project_alpha_revision=authorization.project_alpha_revision
 AND receipt.projection_sha256=authorization.projection_sha256
JOIN project_alpha_project_v2_validated_acknowledgements acknowledgement
  ON acknowledgement.acknowledgement_id=authorization.acknowledgement_id
 AND acknowledgement.command_id=authorization.command_id
 AND acknowledgement.acknowledged_state_version=authorization.acknowledged_state_version
 AND acknowledgement.request_sha256=authorization.request_sha256
 AND acknowledgement.response_sha256=authorization.response_sha256
 AND acknowledgement.source_instance_id=authorization.source_instance_id
 AND acknowledgement.application_id=authorization.application_id
 AND acknowledgement.history_epoch_id=authorization.history_epoch_id
 AND acknowledgement.destination_origin=authorization.destination_origin
 AND acknowledgement.project_alpha_public_id=authorization.project_alpha_public_id
 AND acknowledgement.project_alpha_revision=authorization.project_alpha_revision
 AND acknowledgement.projection_sha256=authorization.projection_sha256
JOIN project_alpha_project_v2_events acknowledged_event
  ON acknowledged_event.command_id=authorization.command_id
 AND acknowledged_event.state_version=authorization.acknowledged_state_version
 AND acknowledged_event.request_sha256=authorization.request_sha256
 AND acknowledged_event.state='acknowledged'
JOIN project_alpha_project_v2_request_fingerprints fingerprint
  ON fingerprint.command_id=authorization.command_id
 AND fingerprint.request_sha256=authorization.request_sha256
JOIN project_alpha_project_v2_canonical_intents intent
  ON intent.command_id=authorization.command_id
 AND intent.request_sha256=authorization.request_sha256
 AND intent.operation=authorization.operation
 AND intent.external_project_id=authorization.external_project_id
 AND intent.source_id=authorization.source_id
 AND intent.source_instance_id=authorization.source_instance_id
 AND intent.application_id=authorization.application_id
 AND intent.history_epoch_id=authorization.history_epoch_id
 AND intent.expected_local_version=authorization.expected_local_version
 AND intent.expected_local_projection_sha256 IS authorization.expected_local_projection_sha256
 AND intent.expected_mapping_state=authorization.expected_mapping_state
 AND intent.expected_project_alpha_public_id IS authorization.expected_project_alpha_public_id
 AND intent.expected_grant_generation=authorization.actor_project_grant_generation
JOIN project_alpha_project_outbox outbox
  ON outbox.command_id=authorization.command_id
 AND outbox.operation=authorization.operation
 AND outbox.external_project_id=authorization.external_project_id
 AND outbox.source_id=authorization.source_id
 AND outbox.expected_source_instance_id=authorization.source_instance_id
 AND outbox.application_id=authorization.application_id
 AND outbox.expected_history_epoch_id=authorization.history_epoch_id
 AND rtrim(outbox.destination_base_url,'/')=authorization.destination_origin
JOIN native_project_command_proofs original_proof
  ON original_proof.command_id=authorization.command_id
 AND original_proof.external_project_id=authorization.external_project_id
 AND original_proof.actor_staff_id=authorization.actor_staff_id
 AND original_proof.actor_access_subject=authorization.actor_access_subject
 AND original_proof.actor_admission_version=authorization.actor_admission_version
 AND original_proof.actor_profile_version=authorization.actor_profile_version
 AND original_proof.actor_email=authorization.actor_email
 AND original_proof.grant_generation=authorization.actor_project_grant_generation
 AND json(original_proof.scopes_json)=json(authorization.actor_scopes_json)
JOIN native_project_live_command_proofs current_authority
  ON current_authority.command_id=original_proof.command_id
 AND current_authority.external_project_id=original_proof.external_project_id
 AND current_authority.actor_staff_id=original_proof.actor_staff_id
 AND current_authority.actor_access_subject=original_proof.actor_access_subject
 AND current_authority.actor_admission_version=original_proof.actor_admission_version
 AND current_authority.actor_profile_version=original_proof.actor_profile_version
 AND current_authority.actor_email=original_proof.actor_email
 AND current_authority.grant_generation=original_proof.grant_generation
 AND current_authority.verified_until=original_proof.verified_until
 AND current_authority.created_at=original_proof.created_at
 AND json(current_authority.scopes_json)=json(original_proof.scopes_json)
WHERE authorization.authorized_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND authorization.expires_at>authorization.authorized_at
  AND authorization.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',authorization.authorized_at,'+15 minutes')
  AND authorization.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND outbox.state IN ('pending','leased','acknowledged')
  AND json_type(outbox.command_json,'$.commandId')='text'
  AND json_extract(outbox.command_json,'$.commandId')=authorization.command_id
  AND json_type(outbox.command_json,'$.externalId')='text'
  AND json_extract(outbox.command_json,'$.externalId')=authorization.external_project_id
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events later
    WHERE later.command_id=authorization.command_id
      AND later.state_version>authorization.acknowledged_state_version)
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_activation_receipts activation
    WHERE activation.command_id=authorization.command_id)
  AND EXISTS (SELECT 1 FROM operations_portal_workspace_effective_permissions permission
    WHERE permission.staff_id=authorization.actor_staff_id
      AND permission.permission_key='integrations.manage'
      AND permission.effect='allow' AND permission.scope='global')
  AND NOT EXISTS (SELECT 1 FROM operations_portal_workspace_effective_permissions permission
    WHERE permission.staff_id=authorization.actor_staff_id
      AND permission.permission_key='integrations.manage'
      AND permission.effect='deny' AND permission.scope='global');

CREATE VIEW project_alpha_project_v2_live_settlement_proofs AS
SELECT * FROM native_project_live_command_proofs
UNION ALL
SELECT authorization.command_id,authorization.external_project_id,authorization.actor_staff_id,
  authorization.actor_access_subject,authorization.actor_admission_version,authorization.actor_profile_version,
  authorization.actor_email,authorization.expires_at,authorization.actor_project_grant_generation,
  authorization.actor_scopes_json,authorization.authorized_at
FROM project_alpha_project_v2_live_post_ack_authorizations authorization;

CREATE TRIGGER project_alpha_project_v2_post_ack_authorizations_insert_guard
AFTER INSERT ON project_alpha_project_v2_post_ack_authorizations
WHEN NEW.authorized_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_live_post_ack_authorizations live
   WHERE live.authorization_id=NEW.authorization_id)
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox
   WHERE outbox.command_id=NEW.command_id AND outbox.state='pending'
     AND outbox.lease_token IS NULL AND outbox.lease_expires_at IS NULL)
 OR EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_activation_receipts activation
   WHERE activation.command_id=NEW.command_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_v2_post_ack_authorizations prior
   WHERE prior.success_receipt_id=NEW.success_receipt_id
     AND prior.authorization_id<>NEW.authorization_id
     AND prior.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR NOT (
   (NEW.expected_local_version=0 AND NOT EXISTS (SELECT 1 FROM operations_shared_projects project
     WHERE project.external_project_id=NEW.external_project_id))
   OR (NEW.expected_local_version>=1 AND EXISTS (SELECT 1 FROM operations_shared_projects project
     WHERE project.external_project_id=NEW.external_project_id
       AND project.current_version=NEW.expected_local_version
       AND project.canonical_projection_sha256=NEW.expected_local_projection_sha256)))
 OR (NEW.expected_mapping_state='absent' AND EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
   WHERE mapping.external_project_id=NEW.external_project_id))
 OR (NEW.expected_mapping_state='exact' AND NOT EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
   WHERE mapping.external_project_id=NEW.external_project_id
     AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
     AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
     AND mapping.project_alpha_public_id=NEW.expected_project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'project v2 post-ack authorization is not current and exact'); END;

CREATE TRIGGER project_alpha_project_v2_post_ack_authorizations_no_update
BEFORE UPDATE ON project_alpha_project_v2_post_ack_authorizations
BEGIN SELECT RAISE(ABORT,'project v2 post-ack authorizations are immutable'); END;

CREATE TRIGGER project_alpha_project_v2_post_ack_authorizations_no_delete
BEFORE DELETE ON project_alpha_project_v2_post_ack_authorizations
BEGIN SELECT RAISE(ABORT,'project v2 post-ack authorizations are durable'); END;

-- Settlement and activation consumers use the narrower proof view above.
-- Command producers and the dispatcher retain native_project_live_command_proofs
-- and therefore cannot consume post-ack authority.
DROP TRIGGER project_alpha_project_v2_canonical_settlement_receipts_exact;
CREATE TRIGGER project_alpha_project_v2_canonical_settlement_receipts_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_settlement_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_intents intent
  JOIN project_alpha_project_v2_success_receipts receipt ON receipt.command_id=intent.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id
  JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=outbox.command_id
    AND proof.external_project_id=outbox.external_project_id
  WHERE intent.command_id=NEW.command_id AND receipt.receipt_id=NEW.success_receipt_id
    AND intent.operation=NEW.operation AND intent.external_project_id=NEW.external_project_id
    AND intent.source_id=NEW.source_id AND intent.source_instance_id=NEW.source_instance_id
    AND intent.application_id=NEW.application_id AND intent.history_epoch_id=NEW.history_epoch_id
    AND intent.expected_local_version=NEW.prior_local_version
    AND proof.grant_generation=intent.expected_grant_generation
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND receipt.source_instance_id=NEW.source_instance_id AND receipt.application_id=NEW.application_id
    AND receipt.history_epoch_id=NEW.history_epoch_id
    AND receipt.project_alpha_public_id=NEW.project_alpha_public_id
    AND receipt.project_alpha_revision=NEW.project_alpha_revision
    AND receipt.projection_sha256=NEW.projection_sha256
    AND ((intent.expected_local_version=0 AND NOT EXISTS (
        SELECT 1 FROM operations_shared_projects project
        WHERE project.external_project_id=intent.external_project_id))
      OR (intent.expected_local_version>=1 AND EXISTS (
        SELECT 1 FROM operations_shared_projects project
        WHERE project.external_project_id=intent.external_project_id
          AND project.current_version=intent.expected_local_version
          AND project.canonical_projection_sha256=intent.expected_local_projection_sha256)))
    AND ((intent.expected_mapping_state='absent' AND NOT EXISTS (
        SELECT 1 FROM project_alpha_project_mappings mapping
        WHERE mapping.external_project_id=intent.external_project_id))
      OR (intent.expected_mapping_state='exact' AND EXISTS (
        SELECT 1 FROM project_alpha_project_mappings mapping
        WHERE mapping.external_project_id=intent.external_project_id
          AND mapping.source_id=intent.source_id
          AND mapping.source_instance_id=intent.source_instance_id
          AND mapping.application_id=intent.application_id
          AND mapping.history_epoch_id=intent.history_epoch_id
          AND mapping.project_alpha_public_id=intent.expected_project_alpha_public_id)))
)
BEGIN SELECT RAISE(ABORT,'project v2 canonical settlement receipt is not exact'); END;

DROP TRIGGER project_alpha_project_v2_canonical_activation_receipts_exact;
CREATE TRIGGER project_alpha_project_v2_canonical_activation_receipts_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_activation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id
  JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=intent.external_project_id
  JOIN operations_shared_projects project ON project.external_project_id=intent.external_project_id
  JOIN operations_shared_project_revisions revision ON revision.external_project_id=intent.external_project_id
    AND revision.version=NEW.resulting_local_version
  WHERE settlement.settlement_id=NEW.settlement_id AND settlement.command_id=NEW.command_id
    AND settlement.external_project_id=NEW.external_project_id AND settlement.operation=NEW.operation
    AND settlement.prior_local_version=NEW.prior_local_version
    AND NEW.resulting_local_version=CASE WHEN NEW.prior_local_version=0 THEN 1 ELSE NEW.prior_local_version+1 END
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND outbox.state='acknowledged'
    AND json_extract(outbox.outcome_json,'$.projectV2ActivationId')=NEW.activation_id
    AND json_extract(outbox.outcome_json,'$.settlementId')=NEW.settlement_id
    AND mapping.source_id=settlement.source_id AND mapping.source_instance_id=settlement.source_instance_id
    AND mapping.application_id=settlement.application_id AND mapping.history_epoch_id=settlement.history_epoch_id
    AND mapping.project_alpha_public_id=settlement.project_alpha_public_id
    AND project.current_version=NEW.resulting_local_version
    AND project.project_alpha_public_id=settlement.project_alpha_public_id
    AND project.pa_revision=settlement.project_alpha_revision
    AND project.canonical_projection_sha256=settlement.projection_sha256
    AND project.organization_record_id IS NEW.organization_record_id
    AND project.client_record_id IS NEW.client_record_id
    AND revision.pa_revision IS NULL AND revision.refresh_command_id IS NULL
    AND revision.v2_settlement_id=NEW.settlement_id
    AND json(revision.read_json)=json(settlement.read_json)
)
BEGIN SELECT RAISE(ABORT,'project v2 canonical activation receipt is not exact'); END;

DROP TRIGGER operations_shared_project_revisions_v2_settlement_guard;
CREATE TRIGGER operations_shared_project_revisions_v2_settlement_guard
BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.v2_settlement_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  JOIN operations_shared_projects project ON project.external_project_id=intent.external_project_id
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=intent.external_project_id
  WHERE settlement.settlement_id=NEW.v2_settlement_id AND NEW.external_project_id=intent.external_project_id
    AND NEW.version=project.current_version AND NEW.version=intent.expected_local_version+1
    AND NEW.pa_revision IS NULL AND NEW.refresh_command_id IS NULL
    AND json(NEW.read_json)=json(settlement.read_json)
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND mapping.source_id=settlement.source_id AND mapping.source_instance_id=settlement.source_instance_id
    AND mapping.application_id=settlement.application_id AND mapping.history_epoch_id=settlement.history_epoch_id
    AND mapping.project_alpha_public_id=settlement.project_alpha_public_id
    AND project.source_id=settlement.source_id AND project.source_instance_id=settlement.source_instance_id
    AND project.application_id=settlement.application_id AND project.history_epoch_id=settlement.history_epoch_id
    AND project.project_alpha_public_id=settlement.project_alpha_public_id
    AND project.canonical_projection_sha256=settlement.projection_sha256
)
BEGIN SELECT RAISE(ABORT,'project v2 canonical history settlement is not authorized'); END;

DROP TRIGGER project_alpha_project_mappings_v2_settlement_guard;
CREATE TRIGGER project_alpha_project_mappings_v2_settlement_guard
BEFORE INSERT ON project_alpha_project_mappings
WHEN EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  WHERE settlement.command_id=NEW.establishment_command_id)
 AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  WHERE settlement.command_id=NEW.establishment_command_id AND intent.operation IN ('create','bind')
    AND intent.expected_mapping_state='absent' AND intent.external_project_id=NEW.external_project_id
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.source_id=settlement.source_id AND NEW.source_instance_id=settlement.source_instance_id
    AND NEW.application_id=settlement.application_id AND NEW.history_epoch_id=settlement.history_epoch_id
    AND NEW.project_alpha_public_id=settlement.project_alpha_public_id
    AND NEW.establishment_kind=intent.operation
    AND ((intent.operation='create' AND NEW.create_command_id=intent.command_id)
      OR (intent.operation='bind' AND NEW.create_command_id IS NULL))
)
BEGIN SELECT RAISE(ABORT,'project v2 mapping settlement is not authorized'); END;

DROP TRIGGER operations_shared_projects_bound_refresh_guard;
CREATE TRIGGER operations_shared_projects_bound_refresh_guard BEFORE INSERT ON operations_shared_projects
WHEN NEW.pa_revision IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_refresh refresh
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=refresh.external_project_id
    AND mapping.establishment_command_id=refresh.establishment_command_id
  JOIN project_alpha_project_outbox command ON command.command_id=refresh.establishment_command_id
    AND command.operation='bind' AND command.state='acknowledged'
  JOIN native_project_live_command_proofs proof ON proof.command_id=command.command_id
    AND proof.external_project_id=refresh.external_project_id
  WHERE refresh.external_project_id=NEW.external_project_id
    AND refresh.history_epoch_id=NEW.history_epoch_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.project_alpha_public_id=NEW.project_alpha_public_id
    AND json(proof.scopes_json)=json(NEW.scopes_json)
    AND (length(NEW.pa_revision)>length(refresh.minimum_revision)
      OR (length(NEW.pa_revision)=length(refresh.minimum_revision) AND NEW.pa_revision>=refresh.minimum_revision))
    AND (NEW.organization_record_id IS NULL OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings customer
      JOIN operations_directory_records record ON record.record_id=customer.external_id AND record.record_kind='organization'
      WHERE customer.source_id=NEW.source_id AND customer.source_instance_id=NEW.source_instance_id
        AND customer.application_id=NEW.application_id AND customer.history_epoch_id=NEW.history_epoch_id
        AND customer.resource_type='organization' AND customer.external_id=NEW.organization_record_id))
    AND (NEW.client_record_id IS NULL OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings customer
      JOIN operations_directory_records record ON record.record_id=customer.external_id AND record.record_kind='client'
      WHERE customer.source_id=NEW.source_id AND customer.source_instance_id=NEW.source_instance_id
        AND customer.application_id=NEW.application_id AND customer.history_epoch_id=NEW.history_epoch_id
        AND customer.resource_type='client' AND customer.external_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
) AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  WHERE settlement.external_project_id=NEW.external_project_id AND settlement.prior_local_version=0
    AND intent.operation IN ('create','bind') AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.source_id=settlement.source_id AND NEW.source_instance_id=settlement.source_instance_id
    AND NEW.application_id=settlement.application_id AND NEW.history_epoch_id=settlement.history_epoch_id
    AND NEW.project_alpha_public_id=settlement.project_alpha_public_id AND NEW.pa_revision=settlement.project_alpha_revision
    AND NEW.current_version=1 AND NEW.canonical_projection_sha256=settlement.projection_sha256
    AND NEW.name=json_extract(settlement.read_json,'$.data.name')
    AND NEW.description IS json_extract(settlement.read_json,'$.data.description')
    AND NEW.lifecycle=json_extract(settlement.read_json,'$.data.status')
    AND NEW.archived=(json_extract(settlement.read_json,'$.data.archived') IS 1)
    AND NEW.overdue_warning=(json_extract(settlement.read_json,'$.data.overdueWarning') IS 1)
    AND NEW.completed_at IS json_extract(settlement.read_json,'$.data.completedAt')
    AND NEW.archived_at IS json_extract(settlement.read_json,'$.data.archivedAt')
    AND NEW.planned_start IS json_extract(settlement.read_json,'$.data.estimatedStart')
    AND NEW.planned_end IS json_extract(settlement.read_json,'$.data.estimatedEnd')
    AND json(NEW.scopes_json)=json(proof.scopes_json)
    AND ((json_type(settlement.read_json,'$.data.organizationPublicId')='null' AND NEW.organization_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.record_id AND r.record_kind='organization'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='organization' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
          AND d.record_id=NEW.organization_record_id))
    AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.record_id AND r.record_kind='client'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='client' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.clientPublicId')
          AND d.record_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
)
BEGIN SELECT RAISE(ABORT,'bound shared project refresh is not authorized'); END;

DROP TRIGGER operations_shared_projects_no_update;
CREATE TRIGGER operations_shared_projects_no_update BEFORE UPDATE ON operations_shared_projects
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=intent.external_project_id
  WHERE OLD.external_project_id=intent.external_project_id AND OLD.current_version=intent.expected_local_version
    AND OLD.canonical_projection_sha256=intent.expected_local_projection_sha256
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND mapping.source_id=intent.source_id AND mapping.source_instance_id=intent.source_instance_id
    AND mapping.application_id=intent.application_id AND mapping.history_epoch_id=intent.history_epoch_id
    AND ((intent.operation='update' AND mapping.project_alpha_public_id=intent.expected_project_alpha_public_id)
      OR intent.operation IN ('create','bind'))
    AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
    AND NEW.source_id=settlement.source_id AND NEW.source_instance_id=settlement.source_instance_id
    AND NEW.application_id=settlement.application_id AND NEW.history_epoch_id=settlement.history_epoch_id
    AND NEW.project_alpha_public_id=settlement.project_alpha_public_id AND NEW.pa_revision=settlement.project_alpha_revision
    AND NEW.current_version=OLD.current_version+1 AND NEW.canonical_projection_sha256=settlement.projection_sha256
    AND NEW.name=json_extract(settlement.read_json,'$.data.name')
    AND NEW.description IS json_extract(settlement.read_json,'$.data.description')
    AND NEW.lifecycle=json_extract(settlement.read_json,'$.data.status')
    AND NEW.archived=(json_extract(settlement.read_json,'$.data.archived') IS 1)
    AND NEW.overdue_warning=(json_extract(settlement.read_json,'$.data.overdueWarning') IS 1)
    AND NEW.completed_at IS json_extract(settlement.read_json,'$.data.completedAt')
    AND NEW.archived_at IS json_extract(settlement.read_json,'$.data.archivedAt')
    AND NEW.planned_start IS json_extract(settlement.read_json,'$.data.estimatedStart')
    AND NEW.planned_end IS json_extract(settlement.read_json,'$.data.estimatedEnd')
    AND json(NEW.scopes_json)=json(proof.scopes_json)
    AND ((json_type(settlement.read_json,'$.data.organizationPublicId')='null' AND NEW.organization_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.record_id AND r.record_kind='organization'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='organization' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
          AND d.record_id=NEW.organization_record_id))
    AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.record_id AND r.record_kind='client'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='client' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.clientPublicId')
          AND d.record_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
) AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_resolution_authorizations authorization
  JOIN project_alpha_project_inbound_proposals proposal ON proposal.proposal_id=authorization.proposal_id
  WHERE authorization.decision='accept_project_alpha' AND proposal.external_project_id=OLD.external_project_id
    AND OLD.current_version=proposal.expected_local_version
    AND OLD.canonical_projection_sha256=proposal.expected_local_projection_sha256
    AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
    AND NEW.source_id IS OLD.source_id AND NEW.source_instance_id IS OLD.source_instance_id
    AND NEW.application_id IS OLD.application_id AND NEW.history_epoch_id IS OLD.history_epoch_id
    AND NEW.project_alpha_public_id IS OLD.project_alpha_public_id
    AND NEW.current_version=OLD.current_version+1
    AND NEW.pa_revision=authorization.final_remote_revision
    AND NEW.canonical_projection_sha256=authorization.final_remote_projection_sha256
    AND NEW.name=json_extract(authorization.final_remote_snapshot_json,'$.data.name')
    AND NEW.description IS json_extract(authorization.final_remote_snapshot_json,'$.data.description')
    AND NEW.lifecycle=json_extract(authorization.final_remote_snapshot_json,'$.data.status')
    AND NEW.archived=(json_extract(authorization.final_remote_snapshot_json,'$.data.archived') IS 1)
    AND NEW.overdue_warning=(json_extract(authorization.final_remote_snapshot_json,'$.data.overdueWarning') IS 1)
    AND NEW.completed_at IS json_extract(authorization.final_remote_snapshot_json,'$.data.completedAt')
    AND NEW.archived_at IS json_extract(authorization.final_remote_snapshot_json,'$.data.archivedAt')
    AND NEW.planned_start IS json_extract(authorization.final_remote_snapshot_json,'$.data.estimatedStart')
    AND NEW.planned_end IS json_extract(authorization.final_remote_snapshot_json,'$.data.estimatedEnd')
    AND NEW.organization_record_id IS authorization.target_organization_record_id
    AND NEW.client_record_id IS authorization.target_client_record_id
    AND json(NEW.scopes_json)=json(authorization.normalized_scopes_json)
)
BEGIN SELECT RAISE(ABORT,'shared project update requires a versioned writer'); END;
