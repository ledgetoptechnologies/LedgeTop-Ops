-- A preparation is itself a durable, immutable claim.  Fence its insert in
-- the same D1 statement against current actor authority and exact owner state.
-- Isolate the 0186 historical false-positive exemption from the already-deep
-- current-observation view so preparation triggers can reuse the exact rule.
CREATE VIEW client_hub_native_project_effective_directory_conflicts AS
SELECT conflict.* FROM project_alpha_api_v2_inventory_conflicts conflict
WHERE NOT (conflict.conflict_kind='revision_reuse_mismatch' AND EXISTS (
 SELECT 1 FROM project_alpha_api_v2_directory_observations conflicted
 JOIN project_alpha_api_v2_directory_observations prior
  ON prior.source_id=conflicted.source_id AND prior.source_instance_id=conflicted.source_instance_id
  AND prior.application_id=conflicted.application_id AND prior.history_epoch_id=conflicted.history_epoch_id
  AND prior.resource_type=conflicted.resource_type AND prior.project_alpha_public_id=conflicted.project_alpha_public_id
  AND prior.request_id=conflict.prior_reference
 JOIN project_alpha_api_v2_inventory_receipts conflicted_receipt
  ON conflicted_receipt.source_id=conflicted.source_id AND conflicted_receipt.source_instance_id=conflicted.source_instance_id
  AND conflicted_receipt.application_id=conflicted.application_id AND conflicted_receipt.history_epoch_id=conflicted.history_epoch_id
  AND conflicted_receipt.inventory_kind='directory' AND conflicted_receipt.request_id=conflicted.request_id
 JOIN project_alpha_api_v2_inventory_receipts prior_receipt
  ON prior_receipt.source_id=prior.source_id AND prior_receipt.source_instance_id=prior.source_instance_id
  AND prior_receipt.application_id=prior.application_id AND prior_receipt.history_epoch_id=prior.history_epoch_id
  AND prior_receipt.inventory_kind='directory' AND prior_receipt.request_id=prior.request_id
 WHERE conflicted.source_id=conflict.source_id AND conflicted.source_instance_id=conflict.source_instance_id
  AND conflicted.application_id=conflict.application_id AND conflicted.history_epoch_id=conflict.history_epoch_id
  AND conflicted.resource_type=conflict.resource_type AND conflicted.project_alpha_public_id=conflict.project_alpha_public_id
  AND conflicted.request_id=conflict.request_id AND conflict.observed_revision=conflicted.resource_revision
  AND conflict.external_id IS conflicted.binding_external_id
  AND conflict.details_json=json_object('observedProjectionSha256',conflicted.projection_sha256,
    'priorProjectionSha256',prior.projection_sha256)
  AND conflicted.resource_revision=prior.resource_revision AND conflicted.present=prior.present
  AND conflicted.last_action=prior.last_action AND conflicted.projection_sha256=prior.projection_sha256
  AND (conflicted.binding_external_id IS NOT prior.binding_external_id
    OR conflicted.binding_status IS NOT prior.binding_status
    OR conflicted.binding_resource_revision IS NOT prior.binding_resource_revision)
  AND (length(conflicted_receipt.authorization_generation)>length(prior_receipt.authorization_generation)
    OR length(conflicted_receipt.authorization_generation)=length(prior_receipt.authorization_generation)
      AND conflicted_receipt.authorization_generation>prior_receipt.authorization_generation)));

CREATE TRIGGER client_hub_native_project_preparations_insert_identity
AFTER INSERT ON client_hub_native_project_preparations
WHEN NOT EXISTS (
  SELECT 1 FROM native_staff_admissions admission
  JOIN staff_users staff ON staff.id=admission.staff_id
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
  WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1 AND staff.status='active'
    AND staff.access_subject=NEW.actor_access_subject AND staff.email=NEW.actor_email
    AND admission.bound_access_subject=NEW.actor_access_subject AND admission.version=NEW.actor_admission_version
    AND profile.login_email=NEW.actor_email AND profile.version=NEW.actor_profile_version
    AND generation.generation=NEW.authority_generation)
 OR NOT json_valid(NEW.request_json) OR COALESCE(json_type(NEW.request_json),'')<>'object'
 OR COALESCE(json_type(NEW.request_json,'$.scopes'),'')<>'array'
 OR json_array_length(json_extract(NEW.request_json,'$.scopes'))>128
 OR COALESCE(json_extract(NEW.request_json,'$.operation'),'') NOT IN ('create','update')
 OR NEW.context_root_namespace<>'business' OR NEW.context_root_kind NOT IN ('organization','standalone_client')
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_scope_allow
AFTER INSERT ON client_hub_native_project_preparations
WHEN EXISTS (SELECT 1 FROM json_each(NEW.request_json,'$.scopes') scope
   WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
     WHERE grant_row.staff_id=NEW.actor_staff_id AND grant_row.capability='project.shared.sync'
       AND grant_row.effect='allow' AND grant_row.active=1
       AND (grant_row.scope_kind='global'
        OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=NEW.external_project_id)
        OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
        OR (grant_row.scope_kind='division' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId')
          AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
 OR (json_array_length(json_extract(NEW.request_json,'$.scopes'))=0 AND NOT EXISTS (
   SELECT 1 FROM native_project_grants grant_row WHERE grant_row.staff_id=NEW.actor_staff_id
    AND grant_row.capability='project.shared.sync' AND grant_row.effect='allow' AND grant_row.active=1
    AND (grant_row.scope_kind='global' OR grant_row.scope_kind='exact_project'
      AND grant_row.external_project_id=NEW.external_project_id)))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_scope_deny
AFTER INSERT ON client_hub_native_project_preparations
WHEN EXISTS (SELECT 1 FROM native_project_grants deny WHERE deny.staff_id=NEW.actor_staff_id
   AND deny.capability='project.shared.sync' AND deny.effect='deny' AND deny.active=1
   AND (deny.scope_kind='global' OR deny.scope_kind='exact_project' AND deny.external_project_id=NEW.external_project_id
    OR EXISTS (SELECT 1 FROM json_each(NEW.request_json,'$.scopes') scope WHERE
      deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId')
      OR deny.scope_kind='division' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId')
       AND deny.division_id=json_extract(scope.value,'$.divisionId'))))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_create_owner_shape
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='create' AND NOT (
   (NEW.context_root_kind='organization'
     AND json_extract(NEW.request_json,'$.directory.organizationRecordId')=NEW.context_root_public_id
     AND json_extract(NEW.request_json,'$.directory.clientRecordId') IS NULL)
   OR (NEW.context_root_kind='standalone_client'
     AND json_extract(NEW.request_json,'$.directory.organizationRecordId') IS NULL
     AND json_extract(NEW.request_json,'$.directory.clientRecordId')=NEW.context_root_public_id))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_create_mapping
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='create' AND NOT EXISTS (
 SELECT 1 FROM project_alpha_active_directory_mappings mapping
 WHERE mapping.record_id=NEW.context_root_public_id
  AND mapping.resource_type=CASE NEW.context_root_kind WHEN 'organization' THEN 'organization' ELSE 'client' END
  AND mapping.source_id=NEW.context_source_id AND mapping.source_instance_id=NEW.source_instance_id
  AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
  AND mapping.external_id=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.externalId' ELSE '$.command.client.externalId' END)
  AND mapping.project_alpha_public_id=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedPublicId' ELSE '$.command.client.expectedPublicId' END))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_create_relationship
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='create' AND NEW.context_root_kind='standalone_client'
 AND NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations ownership
   WHERE ownership.client_record_id=NEW.context_root_public_id AND ownership.organization_record_id IS NULL)
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

-- Keep each raw-observation predicate in its own trigger. Expanding the
-- recovery-aware current-observation view inside a trigger exceeds D1's
-- expression-depth limit even though the equivalent top-level SELECT works.
CREATE TRIGGER client_hub_native_project_preparations_insert_create_observation_exact
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='create' AND NOT EXISTS (
 SELECT 1 FROM project_alpha_api_v2_directory_observations observation
 JOIN project_alpha_api_v2_inventory_receipts receipt
  ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
  AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
  AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
 WHERE observation.source_id=NEW.context_source_id AND observation.source_instance_id=NEW.source_instance_id
  AND observation.application_id=NEW.application_id AND observation.history_epoch_id=NEW.history_epoch_id
  AND observation.resource_type=CASE NEW.context_root_kind WHEN 'organization' THEN 'organization' ELSE 'client' END
  AND observation.project_alpha_public_id=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedPublicId' ELSE '$.command.client.expectedPublicId' END)
  AND observation.resource_revision=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedRevision' ELSE '$.command.client.expectedRevision' END)
  AND observation.projection_sha256=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedProjectionSha256' ELSE '$.command.client.expectedProjectionSha256' END)
  AND observation.present=1 AND observation.binding_status='active'
  AND observation.binding_external_id=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.externalId' ELSE '$.command.client.externalId' END)
  AND observation.binding_resource_revision=observation.resource_revision)
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_create_observation_latest
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='create' AND EXISTS (
 SELECT 1 FROM project_alpha_api_v2_directory_observations selected
 JOIN project_alpha_api_v2_inventory_receipts selected_receipt
  ON selected_receipt.source_id=selected.source_id AND selected_receipt.source_instance_id=selected.source_instance_id
  AND selected_receipt.application_id=selected.application_id AND selected_receipt.history_epoch_id=selected.history_epoch_id
  AND selected_receipt.inventory_kind='directory' AND selected_receipt.request_id=selected.request_id
 JOIN project_alpha_api_v2_directory_observations newer
  ON newer.source_id=selected.source_id AND newer.source_instance_id=selected.source_instance_id
  AND newer.application_id=selected.application_id AND newer.history_epoch_id=selected.history_epoch_id
  AND newer.resource_type=selected.resource_type AND newer.project_alpha_public_id=selected.project_alpha_public_id
 JOIN project_alpha_api_v2_inventory_receipts newer_receipt
  ON newer_receipt.source_id=newer.source_id AND newer_receipt.source_instance_id=newer.source_instance_id
  AND newer_receipt.application_id=newer.application_id AND newer_receipt.history_epoch_id=newer.history_epoch_id
  AND newer_receipt.inventory_kind='directory' AND newer_receipt.request_id=newer.request_id
 WHERE selected.source_id=NEW.context_source_id AND selected.source_instance_id=NEW.source_instance_id
  AND selected.application_id=NEW.application_id AND selected.history_epoch_id=NEW.history_epoch_id
  AND selected.resource_type=CASE NEW.context_root_kind WHEN 'organization' THEN 'organization' ELSE 'client' END
  AND selected.project_alpha_public_id=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedPublicId' ELSE '$.command.client.expectedPublicId' END)
  AND selected.resource_revision=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedRevision' ELSE '$.command.client.expectedRevision' END)
  AND (length(newer.resource_revision)>length(selected.resource_revision)
    OR length(newer.resource_revision)=length(selected.resource_revision) AND newer.resource_revision>selected.resource_revision
    OR newer.resource_revision=selected.resource_revision AND (newer_receipt.observed_at>selected_receipt.observed_at
      OR newer_receipt.observed_at=selected_receipt.observed_at AND newer.request_id>selected.request_id)))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_create_observation_conflict
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='create' AND EXISTS (
 SELECT 1 FROM client_hub_native_project_effective_directory_conflicts conflict
 WHERE conflict.source_id=NEW.context_source_id AND conflict.source_instance_id=NEW.source_instance_id
  AND conflict.application_id=NEW.application_id AND conflict.history_epoch_id=NEW.history_epoch_id
  AND conflict.inventory_kind='directory'
  AND conflict.resource_type=CASE NEW.context_root_kind WHEN 'organization' THEN 'organization' ELSE 'client' END
  AND conflict.project_alpha_public_id=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedPublicId' ELSE '$.command.client.expectedPublicId' END))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_update_head
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='update' AND NOT EXISTS (
   SELECT 1 FROM operations_shared_projects project
   JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=project.external_project_id
   WHERE project.external_project_id=NEW.external_project_id
    AND project.current_version=json_extract(NEW.request_json,'$.local.expectedLocalVersion')
    AND project.canonical_projection_sha256=json_extract(NEW.request_json,'$.local.expectedLocalProjectionSha256')
    AND mapping.source_id=NEW.context_source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND ((NEW.context_root_kind='organization' AND project.organization_record_id=NEW.context_root_public_id)
      OR (NEW.context_root_kind='standalone_client' AND project.organization_record_id IS NULL
        AND project.client_record_id=NEW.context_root_public_id
        AND EXISTS (SELECT 1 FROM operations_directory_client_organizations ownership
          WHERE ownership.client_record_id=NEW.context_root_public_id AND ownership.organization_record_id IS NULL))))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_update_organization
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='update' AND EXISTS (
 SELECT 1 FROM operations_shared_projects project WHERE project.external_project_id=NEW.external_project_id
  AND project.organization_record_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM project_alpha_active_directory_mappings mapping
   JOIN project_alpha_api_v2_directory_observations observation
    ON observation.source_id=mapping.source_id AND observation.source_instance_id=mapping.source_instance_id
    AND observation.application_id=mapping.application_id AND observation.history_epoch_id=mapping.history_epoch_id
    AND observation.resource_type=mapping.resource_type AND observation.project_alpha_public_id=mapping.project_alpha_public_id
   JOIN project_alpha_api_v2_inventory_receipts receipt
    ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
    AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
    AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
   WHERE mapping.record_id=project.organization_record_id AND mapping.resource_type='organization'
    AND mapping.source_id=NEW.context_source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND observation.present=1 AND observation.binding_status='active'
    AND observation.binding_external_id=mapping.external_id
    AND observation.binding_resource_revision=observation.resource_revision
    AND NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_directory_observations newer
      JOIN project_alpha_api_v2_inventory_receipts newer_receipt
       ON newer_receipt.source_id=newer.source_id AND newer_receipt.source_instance_id=newer.source_instance_id
       AND newer_receipt.application_id=newer.application_id AND newer_receipt.history_epoch_id=newer.history_epoch_id
       AND newer_receipt.inventory_kind='directory' AND newer_receipt.request_id=newer.request_id
      WHERE newer.source_id=observation.source_id AND newer.source_instance_id=observation.source_instance_id
       AND newer.application_id=observation.application_id AND newer.history_epoch_id=observation.history_epoch_id
       AND newer.resource_type=observation.resource_type AND newer.project_alpha_public_id=observation.project_alpha_public_id
       AND (length(newer.resource_revision)>length(observation.resource_revision)
        OR length(newer.resource_revision)=length(observation.resource_revision) AND newer.resource_revision>observation.resource_revision
        OR newer.resource_revision=observation.resource_revision AND (newer_receipt.observed_at>receipt.observed_at
         OR newer_receipt.observed_at=receipt.observed_at AND newer.request_id>observation.request_id)))))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_update_client
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='update' AND EXISTS (
 SELECT 1 FROM operations_shared_projects project WHERE project.external_project_id=NEW.external_project_id
  AND project.client_record_id IS NOT NULL AND (NOT EXISTS (
   SELECT 1 FROM project_alpha_active_directory_mappings mapping
   JOIN project_alpha_api_v2_directory_observations observation
    ON observation.source_id=mapping.source_id AND observation.source_instance_id=mapping.source_instance_id
    AND observation.application_id=mapping.application_id AND observation.history_epoch_id=mapping.history_epoch_id
    AND observation.resource_type=mapping.resource_type AND observation.project_alpha_public_id=mapping.project_alpha_public_id
   JOIN project_alpha_api_v2_inventory_receipts receipt
    ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
    AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
    AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
   WHERE mapping.record_id=project.client_record_id AND mapping.resource_type='client'
    AND mapping.source_id=NEW.context_source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND observation.present=1 AND observation.binding_status='active'
    AND observation.binding_external_id=mapping.external_id
    AND observation.binding_resource_revision=observation.resource_revision
    AND NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_directory_observations newer
      JOIN project_alpha_api_v2_inventory_receipts newer_receipt
       ON newer_receipt.source_id=newer.source_id AND newer_receipt.source_instance_id=newer.source_instance_id
       AND newer_receipt.application_id=newer.application_id AND newer_receipt.history_epoch_id=newer.history_epoch_id
       AND newer_receipt.inventory_kind='directory' AND newer_receipt.request_id=newer.request_id
      WHERE newer.source_id=observation.source_id AND newer.source_instance_id=observation.source_instance_id
       AND newer.application_id=observation.application_id AND newer.history_epoch_id=observation.history_epoch_id
       AND newer.resource_type=observation.resource_type AND newer.project_alpha_public_id=observation.project_alpha_public_id
       AND (length(newer.resource_revision)>length(observation.resource_revision)
        OR length(newer.resource_revision)=length(observation.resource_revision) AND newer.resource_revision>observation.resource_revision
        OR newer.resource_revision=observation.resource_revision AND (newer_receipt.observed_at>receipt.observed_at
         OR newer_receipt.observed_at=receipt.observed_at AND newer.request_id>observation.request_id))))
   OR NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
     WHERE relationship.client_record_id=project.client_record_id
      AND relationship.organization_record_id IS project.organization_record_id)))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

CREATE TRIGGER client_hub_native_project_preparations_insert_update_owner_conflict
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='update' AND EXISTS (
 SELECT 1 FROM operations_shared_projects project
 JOIN project_alpha_active_directory_mappings mapping
  ON mapping.record_id=project.organization_record_id AND mapping.resource_type='organization'
   OR mapping.record_id=project.client_record_id AND mapping.resource_type='client'
 JOIN client_hub_native_project_effective_directory_conflicts conflict
  ON conflict.source_id=mapping.source_id AND conflict.source_instance_id=mapping.source_instance_id
  AND conflict.application_id=mapping.application_id AND conflict.history_epoch_id=mapping.history_epoch_id
  AND conflict.inventory_kind='directory' AND conflict.resource_type=mapping.resource_type
  AND conflict.project_alpha_public_id=mapping.project_alpha_public_id
 WHERE project.external_project_id=NEW.external_project_id
  AND mapping.source_id=NEW.context_source_id AND mapping.source_instance_id=NEW.source_instance_id
  AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id)
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;

-- SQLite expands the recovery-aware settlement proof view inside triggers.
-- Materialize one immutable, fully checked update fence first so the actual
-- project UPDATE guard stays below D1's expression-depth limit.
CREATE TABLE project_alpha_project_v2_update_activation_fences (
  settlement_id TEXT PRIMARY KEY REFERENCES project_alpha_project_v2_canonical_settlement_receipts(settlement_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL UNIQUE,
  external_project_id TEXT NOT NULL,
  prior_version INTEGER NOT NULL,
  prior_projection_sha256 TEXT NOT NULL,
  resulting_version INTEGER NOT NULL,
  source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL, history_epoch_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL, project_alpha_revision TEXT NOT NULL, projection_sha256 TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT, lifecycle TEXT NOT NULL, planned_start TEXT, planned_end TEXT,
  organization_record_id TEXT, client_record_id TEXT, scopes_json TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL, actor_access_subject TEXT NOT NULL, actor_admission_version INTEGER NOT NULL,
  actor_profile_version INTEGER NOT NULL, actor_email TEXT NOT NULL, grant_generation INTEGER NOT NULL,
  verified_until TEXT NOT NULL,
  completed_at TEXT, archived INTEGER NOT NULL, archived_at TEXT, overdue_warning INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(resulting_version=prior_version+1 AND prior_version>=1),
  CHECK(json_valid(scopes_json) AND json_type(scopes_json)='array'),
  CHECK(archived IN (0,1) AND overdue_warning IN (0,1))
);
CREATE TRIGGER project_alpha_project_v2_update_activation_fences_no_update BEFORE UPDATE ON project_alpha_project_v2_update_activation_fences
BEGIN SELECT RAISE(ABORT,'project v2 update activation fence is immutable'); END;
CREATE TRIGGER project_alpha_project_v2_update_activation_fences_no_delete BEFORE DELETE ON project_alpha_project_v2_update_activation_fences
BEGIN SELECT RAISE(ABORT,'project v2 update activation fence is durable'); END;
CREATE TRIGGER project_alpha_project_v2_update_activation_fences_authority AFTER INSERT ON project_alpha_project_v2_update_activation_fences
WHEN NOT EXISTS (
 SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
 JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  AND intent.operation IN ('update','bind')
 JOIN project_alpha_project_v2_live_settlement_proofs proof ON proof.command_id=intent.command_id
  AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
 WHERE settlement.settlement_id=NEW.settlement_id AND settlement.command_id=NEW.command_id
  AND settlement.external_project_id=NEW.external_project_id AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND json(proof.scopes_json)=json(NEW.scopes_json) AND proof.actor_staff_id=NEW.actor_staff_id
  AND proof.actor_access_subject=NEW.actor_access_subject AND proof.actor_admission_version=NEW.actor_admission_version
  AND proof.actor_profile_version=NEW.actor_profile_version AND proof.actor_email=NEW.actor_email
  AND proof.grant_generation=NEW.grant_generation AND proof.verified_until=NEW.verified_until
  AND (NOT EXISTS (SELECT 1 FROM client_hub_native_project_preparations candidate WHERE candidate.command_id=NEW.command_id)
    OR EXISTS (SELECT 1 FROM client_hub_native_project_preparations preparation
      WHERE preparation.command_id=NEW.command_id AND preparation.external_project_id=NEW.external_project_id
       AND preparation.context_source_id=intent.source_id AND preparation.source_instance_id=intent.source_instance_id
       AND preparation.application_id=intent.application_id AND preparation.history_epoch_id=intent.history_epoch_id
       AND preparation.actor_staff_id=proof.actor_staff_id AND preparation.actor_access_subject=proof.actor_access_subject
       AND preparation.actor_admission_version=proof.actor_admission_version
       AND preparation.actor_profile_version=proof.actor_profile_version AND preparation.actor_email=proof.actor_email
       AND preparation.authority_generation=proof.grant_generation
       AND json_extract(preparation.request_json,'$.operation')='update'
       AND json_extract(preparation.request_json,'$.local.expectedLocalVersion')=intent.expected_local_version
       AND json_extract(preparation.request_json,'$.local.expectedLocalProjectionSha256')=intent.expected_local_projection_sha256)))
BEGIN SELECT RAISE(ABORT,'project v2 update activation fence lacks current authority'); END;
CREATE TRIGGER project_alpha_project_v2_update_activation_fences_state AFTER INSERT ON project_alpha_project_v2_update_activation_fences
WHEN NOT EXISTS (
 SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
 JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
 JOIN operations_shared_projects project ON project.external_project_id=intent.external_project_id
 JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=intent.external_project_id
 WHERE settlement.settlement_id=NEW.settlement_id AND intent.operation IN ('update','bind')
  AND project.current_version=NEW.prior_version AND project.canonical_projection_sha256=NEW.prior_projection_sha256
  AND intent.expected_local_version=NEW.prior_version AND intent.expected_local_projection_sha256=NEW.prior_projection_sha256
  AND mapping.source_id=intent.source_id AND mapping.source_instance_id=intent.source_instance_id
  AND mapping.application_id=intent.application_id AND mapping.history_epoch_id=intent.history_epoch_id
  AND ((intent.operation='update' AND intent.expected_mapping_state='exact'
      AND mapping.project_alpha_public_id=intent.expected_project_alpha_public_id)
    OR (intent.operation='bind' AND intent.expected_mapping_state='absent'
      AND intent.expected_project_alpha_public_id IS NULL
      AND mapping.project_alpha_public_id=settlement.project_alpha_public_id
      AND mapping.establishment_kind='bind' AND mapping.establishment_command_id=intent.command_id
      AND mapping.create_command_id IS NULL)))
BEGIN SELECT RAISE(ABORT,'project v2 update activation fence state is stale'); END;
CREATE TRIGGER project_alpha_project_v2_update_activation_fences_target AFTER INSERT ON project_alpha_project_v2_update_activation_fences
WHEN NOT EXISTS (
 SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
 WHERE settlement.settlement_id=NEW.settlement_id AND settlement.command_id=NEW.command_id
  AND settlement.external_project_id=NEW.external_project_id AND NEW.resulting_version=settlement.prior_local_version+1
  AND NEW.source_id=settlement.source_id AND NEW.source_instance_id=settlement.source_instance_id
  AND NEW.application_id=settlement.application_id AND NEW.history_epoch_id=settlement.history_epoch_id
  AND NEW.project_alpha_public_id=settlement.project_alpha_public_id AND NEW.project_alpha_revision=settlement.project_alpha_revision
  AND NEW.projection_sha256=settlement.projection_sha256 AND NEW.name=json_extract(settlement.read_json,'$.data.name')
  AND NEW.description IS json_extract(settlement.read_json,'$.data.description')
  AND NEW.lifecycle=json_extract(settlement.read_json,'$.data.status')
  AND NEW.planned_start IS json_extract(settlement.read_json,'$.data.estimatedStart')
  AND NEW.planned_end IS json_extract(settlement.read_json,'$.data.estimatedEnd')
  AND NEW.completed_at IS json_extract(settlement.read_json,'$.data.completedAt')
  AND NEW.archived=(json_extract(settlement.read_json,'$.data.archived') IS 1)
  AND NEW.archived_at IS json_extract(settlement.read_json,'$.data.archivedAt')
  AND NEW.overdue_warning=(json_extract(settlement.read_json,'$.data.overdueWarning') IS 1)
  AND ((json_type(settlement.read_json,'$.data.organizationPublicId')='null' AND NEW.organization_record_id IS NULL)
    OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings mapping
      WHERE mapping.source_id=settlement.source_id AND mapping.source_instance_id=settlement.source_instance_id
       AND mapping.application_id=settlement.application_id AND mapping.history_epoch_id=settlement.history_epoch_id
       AND mapping.resource_type='organization' AND mapping.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
       AND mapping.record_id=NEW.organization_record_id))
  AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
    OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings mapping
      WHERE mapping.source_id=settlement.source_id AND mapping.source_instance_id=settlement.source_instance_id
       AND mapping.application_id=settlement.application_id AND mapping.history_epoch_id=settlement.history_epoch_id
       AND mapping.resource_type='client' AND mapping.project_alpha_public_id=json_extract(settlement.read_json,'$.data.clientPublicId')
       AND mapping.record_id=NEW.client_record_id))
  AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
    SELECT 1 FROM operations_directory_client_organizations relationship
    WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id)))
BEGIN SELECT RAISE(ABORT,'project v2 update activation fence target is not exact'); END;

DROP TRIGGER operations_shared_projects_no_update;
CREATE TRIGGER operations_shared_projects_no_update BEFORE UPDATE ON operations_shared_projects
WHEN NOT EXISTS (
 SELECT 1 FROM project_alpha_project_v2_update_activation_fences fence
 WHERE fence.external_project_id=OLD.external_project_id AND fence.prior_version=OLD.current_version
  AND fence.prior_projection_sha256=OLD.canonical_projection_sha256 AND fence.resulting_version=NEW.current_version
  AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
  AND NEW.source_id=fence.source_id AND NEW.source_instance_id=fence.source_instance_id
  AND NEW.application_id=fence.application_id AND NEW.history_epoch_id=fence.history_epoch_id
  AND NEW.project_alpha_public_id=fence.project_alpha_public_id AND NEW.pa_revision=fence.project_alpha_revision
  AND NEW.canonical_projection_sha256=fence.projection_sha256 AND NEW.name=fence.name
  AND NEW.description IS fence.description AND NEW.lifecycle=fence.lifecycle
  AND NEW.planned_start IS fence.planned_start AND NEW.planned_end IS fence.planned_end
  AND NEW.organization_record_id IS fence.organization_record_id AND NEW.client_record_id IS fence.client_record_id
  AND json(NEW.scopes_json)=json(fence.scopes_json) AND NEW.completed_at IS fence.completed_at
  AND NEW.archived=fence.archived AND NEW.archived_at IS fence.archived_at AND NEW.overdue_warning=fence.overdue_warning
  AND fence.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) AND NOT EXISTS (
 SELECT 1 FROM project_alpha_project_inbound_resolution_authorizations authorization
 JOIN project_alpha_project_inbound_proposals proposal ON proposal.proposal_id=authorization.proposal_id
 WHERE authorization.decision='accept_project_alpha' AND proposal.external_project_id=OLD.external_project_id
  AND OLD.current_version=proposal.expected_local_version AND OLD.canonical_projection_sha256=proposal.expected_local_projection_sha256
  AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
  AND NEW.source_id IS OLD.source_id AND NEW.source_instance_id IS OLD.source_instance_id
  AND NEW.application_id IS OLD.application_id AND NEW.history_epoch_id IS OLD.history_epoch_id
  AND NEW.project_alpha_public_id IS OLD.project_alpha_public_id AND NEW.current_version=OLD.current_version+1
  AND NEW.pa_revision=authorization.final_remote_revision AND NEW.canonical_projection_sha256=authorization.final_remote_projection_sha256
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
  AND json(NEW.scopes_json)=json(authorization.normalized_scopes_json))
BEGIN SELECT RAISE(ABORT,'shared project update requires a versioned writer'); END;

CREATE TRIGGER operations_shared_projects_update_fence_authority BEFORE UPDATE ON operations_shared_projects
WHEN EXISTS (SELECT 1 FROM project_alpha_project_v2_update_activation_fences fence
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=fence.command_id AND intent.operation='update'
  WHERE fence.external_project_id=OLD.external_project_id AND fence.prior_version=OLD.current_version
    AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
    AND json_array(fence.prior_projection_sha256,fence.resulting_version,fence.source_id,fence.source_instance_id,
      fence.application_id,fence.history_epoch_id,fence.project_alpha_public_id,fence.project_alpha_revision,
      fence.projection_sha256,fence.name,fence.description,fence.lifecycle,fence.planned_start,fence.planned_end,
      fence.organization_record_id,fence.client_record_id,json(fence.scopes_json),fence.completed_at,fence.archived,
      fence.archived_at,fence.overdue_warning)=json_array(OLD.canonical_projection_sha256,NEW.current_version,
      NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,NEW.project_alpha_public_id,
      NEW.pa_revision,NEW.canonical_projection_sha256,NEW.name,NEW.description,NEW.lifecycle,NEW.planned_start,
      NEW.planned_end,NEW.organization_record_id,NEW.client_record_id,json(NEW.scopes_json),NEW.completed_at,
      NEW.archived,NEW.archived_at,NEW.overdue_warning))
AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_update_activation_fences fence
 JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=fence.command_id AND intent.operation='update'
 WHERE fence.external_project_id=OLD.external_project_id AND fence.prior_version=OLD.current_version
  AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
  AND json_array(fence.prior_projection_sha256,fence.resulting_version,fence.source_id,fence.source_instance_id,
    fence.application_id,fence.history_epoch_id,fence.project_alpha_public_id,fence.project_alpha_revision,
    fence.projection_sha256,fence.name,fence.description,fence.lifecycle,fence.planned_start,fence.planned_end,
    fence.organization_record_id,fence.client_record_id,json(fence.scopes_json),fence.completed_at,fence.archived,
    fence.archived_at,fence.overdue_warning)=json_array(OLD.canonical_projection_sha256,NEW.current_version,
    NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,NEW.project_alpha_public_id,
    NEW.pa_revision,NEW.canonical_projection_sha256,NEW.name,NEW.description,NEW.lifecycle,NEW.planned_start,
    NEW.planned_end,NEW.organization_record_id,NEW.client_record_id,json(NEW.scopes_json),NEW.completed_at,
    NEW.archived,NEW.archived_at,NEW.overdue_warning)
  AND fence.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS (SELECT 1 FROM staff_users staff JOIN native_staff_admissions admission ON admission.staff_id=staff.id
    JOIN native_staff_profiles profile ON profile.staff_id=staff.id
    JOIN native_project_grant_generations generation ON generation.staff_id=staff.id
    WHERE staff.id=fence.actor_staff_id AND staff.status='active' AND staff.access_subject=fence.actor_access_subject
     AND staff.email=fence.actor_email AND admission.active=1 AND admission.bound_access_subject=fence.actor_access_subject
     AND admission.version=fence.actor_admission_version AND profile.login_email=fence.actor_email
     AND profile.version=fence.actor_profile_version AND generation.generation=fence.grant_generation)
  AND NOT EXISTS (SELECT 1 FROM json_each(fence.scopes_json) scope WHERE NOT EXISTS (
    SELECT 1 FROM native_project_grants grant_row WHERE grant_row.staff_id=fence.actor_staff_id
     AND grant_row.capability='project.shared.sync' AND grant_row.effect='allow' AND grant_row.active=1
     AND (grant_row.scope_kind='global' OR grant_row.scope_kind='exact_project' AND grant_row.external_project_id=fence.external_project_id
      OR grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId')
      OR grant_row.scope_kind='division' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId')
       AND grant_row.division_id=json_extract(scope.value,'$.divisionId'))))
  AND (json_array_length(fence.scopes_json)>0 OR EXISTS (SELECT 1 FROM native_project_grants grant_row
    WHERE grant_row.staff_id=fence.actor_staff_id AND grant_row.capability='project.shared.sync'
     AND grant_row.effect='allow' AND grant_row.active=1
     AND (grant_row.scope_kind='global' OR grant_row.scope_kind='exact_project' AND grant_row.external_project_id=fence.external_project_id)))
  AND NOT EXISTS (SELECT 1 FROM native_project_grants deny WHERE deny.staff_id=fence.actor_staff_id
    AND deny.capability='project.shared.sync' AND deny.effect='deny' AND deny.active=1
    AND (deny.scope_kind='global' OR deny.scope_kind='exact_project' AND deny.external_project_id=fence.external_project_id
     OR EXISTS (SELECT 1 FROM json_each(fence.scopes_json) scope
      WHERE deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId')
       OR deny.scope_kind='division' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId')
        AND deny.division_id=json_extract(scope.value,'$.divisionId')))))
BEGIN SELECT RAISE(ABORT,'shared project update fence lacks current authority'); END;

CREATE TRIGGER operations_shared_projects_bind_fence_authority BEFORE UPDATE ON operations_shared_projects
WHEN EXISTS (SELECT 1 FROM project_alpha_project_v2_update_activation_fences fence
 JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=fence.command_id AND intent.operation='bind'
 WHERE fence.external_project_id=OLD.external_project_id AND fence.prior_version=OLD.current_version
  AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
  AND json_array(fence.prior_projection_sha256,fence.resulting_version,fence.source_id,fence.source_instance_id,
    fence.application_id,fence.history_epoch_id,fence.project_alpha_public_id,fence.project_alpha_revision,
    fence.projection_sha256,fence.name,fence.description,fence.lifecycle,fence.planned_start,fence.planned_end,
    fence.organization_record_id,fence.client_record_id,json(fence.scopes_json),fence.completed_at,fence.archived,
    fence.archived_at,fence.overdue_warning)=json_array(OLD.canonical_projection_sha256,NEW.current_version,
    NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,NEW.project_alpha_public_id,
    NEW.pa_revision,NEW.canonical_projection_sha256,NEW.name,NEW.description,NEW.lifecycle,NEW.planned_start,
    NEW.planned_end,NEW.organization_record_id,NEW.client_record_id,json(NEW.scopes_json),NEW.completed_at,
    NEW.archived,NEW.archived_at,NEW.overdue_warning))
AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_update_activation_fences fence
 JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=fence.command_id AND intent.operation='bind'
 JOIN project_alpha_project_v2_canonical_settlement_receipts settlement
  ON settlement.command_id=intent.command_id AND settlement.settlement_id=fence.settlement_id
 JOIN project_alpha_project_v2_live_settlement_proofs proof
  ON proof.command_id=intent.command_id AND proof.external_project_id=intent.external_project_id
  AND proof.grant_generation=intent.expected_grant_generation
 WHERE fence.external_project_id=OLD.external_project_id AND fence.prior_version=OLD.current_version
  AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
  AND json_array(fence.prior_projection_sha256,fence.resulting_version,fence.source_id,fence.source_instance_id,
    fence.application_id,fence.history_epoch_id,fence.project_alpha_public_id,fence.project_alpha_revision,
    fence.projection_sha256,fence.name,fence.description,fence.lifecycle,fence.planned_start,fence.planned_end,
    fence.organization_record_id,fence.client_record_id,json(fence.scopes_json),fence.completed_at,fence.archived,
    fence.archived_at,fence.overdue_warning)=json_array(OLD.canonical_projection_sha256,NEW.current_version,
    NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,NEW.project_alpha_public_id,
    NEW.pa_revision,NEW.canonical_projection_sha256,NEW.name,NEW.description,NEW.lifecycle,NEW.planned_start,
    NEW.planned_end,NEW.organization_record_id,NEW.client_record_id,json(NEW.scopes_json),NEW.completed_at,
    NEW.archived,NEW.archived_at,NEW.overdue_warning)
  AND intent.expected_mapping_state='absent' AND intent.expected_project_alpha_public_id IS NULL
  AND settlement.external_project_id=fence.external_project_id
  AND proof.actor_staff_id=fence.actor_staff_id AND proof.actor_access_subject=fence.actor_access_subject
  AND proof.actor_admission_version=fence.actor_admission_version
  AND proof.actor_profile_version=fence.actor_profile_version AND proof.actor_email=fence.actor_email
  AND proof.grant_generation=fence.grant_generation AND json(proof.scopes_json)=json(fence.scopes_json)
  AND proof.verified_until=fence.verified_until AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'shared project bind fence lacks current authority'); END;
