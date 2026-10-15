PRAGMA foreign_keys=ON;
-- Existing PA entities are imported locally, never sent to the PA create outbox.
-- Every normal native guard remains installed. This admission adds provenance
-- and constrains its own local write to zero transport intents.
CREATE VIEW native_directory_existing_import_classic AS
SELECT classic.projection_source_id source_id,classic.id record_id,'client' record_kind,
 classic.name,classic.payload_json,classic.organization_id parent_record_id,
 CASE WHEN json_valid(classic.payload_json) THEN json_extract(classic.payload_json,'$.public_id') END public_id,
 CASE WHEN json_valid(classic.payload_json) THEN json_object('name',trim(classic.name),'email',lower(trim(coalesce(json_extract(classic.payload_json,'$.email'),''))),'phone',trim(coalesce(json_extract(classic.payload_json,'$.phone'),'')),'clientType',CASE WHEN json_extract(classic.payload_json,'$.client_type') IN ('business','consumer') THEN json_extract(classic.payload_json,'$.client_type') ELSE 'unknown' END,'addressLine1',trim(coalesce(json_extract(classic.payload_json,'$.address_line1'),'')),'addressLine2',trim(coalesce(json_extract(classic.payload_json,'$.address_line2'),'')),'city',trim(coalesce(json_extract(classic.payload_json,'$.city'),'')),'state',trim(coalesce(json_extract(classic.payload_json,'$.state'),'')),'postalCode',trim(coalesce(json_extract(classic.payload_json,'$.postal_code'),'')),'country',trim(coalesce(json_extract(classic.payload_json,'$.country'),''))) END profile_json
FROM pa_clients classic WHERE classic.active=1
UNION ALL SELECT classic.projection_source_id,classic.id,'organization',classic.name,classic.payload_json,NULL,
 CASE WHEN json_valid(classic.payload_json) THEN json_extract(classic.payload_json,'$.public_id') END,
 CASE WHEN json_valid(classic.payload_json) THEN json_object('name',trim(classic.name),'generalEmail',lower(trim(coalesce(json_extract(classic.payload_json,'$.email'),''))),'generalPhone',trim(coalesce(json_extract(classic.payload_json,'$.phone'),'')),'addressLine1',trim(coalesce(json_extract(classic.payload_json,'$.address_line1'),'')),'addressLine2',trim(coalesce(json_extract(classic.payload_json,'$.address_line2'),'')),'city',trim(coalesce(json_extract(classic.payload_json,'$.city'),'')),'state',trim(coalesce(json_extract(classic.payload_json,'$.state'),'')),'postalCode',trim(coalesce(json_extract(classic.payload_json,'$.postal_code'),'')),'country',trim(coalesce(json_extract(classic.payload_json,'$.country'),''))) END
FROM pa_organizations classic WHERE classic.active=1;

CREATE TABLE native_directory_existing_import_reviews(
 import_id TEXT PRIMARY KEY NOT NULL CHECK(length(import_id)=36),
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 review_json TEXT NOT NULL CHECK(json_valid(review_json)),
 source_id TEXT GENERATED ALWAYS AS(json_extract(review_json,'$.sourceId')) VIRTUAL,
 record_id TEXT GENERATED ALWAYS AS(json_extract(review_json,'$.recordId')) VIRTUAL,
 record_kind TEXT GENERATED ALWAYS AS(json_extract(review_json,'$.kind')) VIRTUAL,
 batch_id TEXT GENERATED ALWAYS AS(json_extract(review_json,'$.batchId')) VIRTUAL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX native_directory_existing_import_review_source ON native_directory_existing_import_reviews(source_id,batch_id,record_id);
CREATE TABLE native_directory_existing_import_source_cursors(
 batch_id TEXT NOT NULL,source_id TEXT NOT NULL,source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
 generation TEXT NOT NULL,last_import_id TEXT REFERENCES native_directory_existing_import_reviews(import_id),
 PRIMARY KEY(batch_id,source_id)
);
CREATE TABLE native_directory_existing_import_execution_admissions(
 execution_id TEXT NOT NULL PRIMARY KEY,import_id TEXT NOT NULL REFERENCES native_directory_existing_import_reviews(import_id),
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),created_at TEXT NOT NULL,verified_until TEXT NOT NULL
);
CREATE TABLE native_directory_existing_import_local_receipts(
 import_id TEXT NOT NULL PRIMARY KEY REFERENCES native_directory_existing_import_reviews(import_id),
 record_id TEXT NOT NULL UNIQUE REFERENCES operations_directory_records(record_id),
 execution_id TEXT NOT NULL UNIQUE REFERENCES native_directory_existing_import_execution_admissions(execution_id),
 mutation_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL
);
CREATE TABLE native_directory_existing_import_identity_translations(
 import_id TEXT NOT NULL PRIMARY KEY REFERENCES native_directory_existing_import_local_receipts(import_id),
 source_id TEXT NOT NULL,record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
 classic_record_id TEXT NOT NULL,native_record_id TEXT NOT NULL UNIQUE REFERENCES operations_directory_records(record_id),
 public_id TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(source_id,record_kind,classic_record_id),UNIQUE(source_id,record_kind,public_id)
);
CREATE TABLE native_directory_existing_import_events(
 event_id INTEGER PRIMARY KEY AUTOINCREMENT,import_id TEXT NOT NULL REFERENCES native_directory_existing_import_reviews(import_id),
 state TEXT NOT NULL CHECK(state IN ('local_imported','binding_uncertain','acquired','activated','blocked')),
 detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE native_directory_existing_import_binding_intents(
 import_id TEXT NOT NULL PRIMARY KEY REFERENCES native_directory_existing_import_local_receipts(import_id),
 command_id TEXT NOT NULL UNIQUE,review_receipt_id TEXT NOT NULL UNIQUE,
 command_json TEXT NOT NULL CHECK(json_valid(command_json)),request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 profile_evidence_json TEXT NOT NULL CHECK(json_valid(profile_evidence_json)),actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
 created_at TEXT NOT NULL
);
CREATE TABLE native_directory_existing_import_renewals(
 renewal_id TEXT NOT NULL PRIMARY KEY,import_id TEXT NOT NULL REFERENCES native_directory_existing_import_reviews(import_id),
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX native_directory_existing_import_activated ON native_directory_existing_import_events(import_id) WHERE state='activated';
CREATE UNIQUE INDEX native_directory_existing_import_acquired ON native_directory_existing_import_events(import_id) WHERE state='acquired';

CREATE VIEW native_directory_existing_import_live_reviews AS
-- Materialized conjunctions preserve exact provenance while bounding D1 expression depth.
WITH import_classic_rows AS MATERIALIZED(SELECT * FROM native_directory_existing_import_classic),
import_current_observations AS MATERIALIZED(SELECT * FROM project_alpha_api_v2_directory_observations_current),
import_active_mappings AS MATERIALIZED(SELECT * FROM project_alpha_active_directory_mappings),
import_generation_receipts AS MATERIALIZED(
 SELECT review.import_id,receipt.request_id FROM native_directory_existing_import_reviews review
 JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=review.source_id
 AND receipt.source_instance_id=json_extract(review.review_json,'$.sourceInstanceId')
 AND receipt.application_id=json_extract(review.review_json,'$.applicationId')
 AND receipt.history_epoch_id=json_extract(review.review_json,'$.historyEpoch') AND receipt.inventory_kind='directory'
 WHERE receipt.authorization_generation=json_extract(review.review_json,'$.observation.authorizationGeneration') OR EXISTS(
 SELECT 1 FROM native_directory_existing_import_source_cursors own_cursor
 WHERE own_cursor.batch_id=review.batch_id AND own_cursor.source_id=review.source_id
 AND own_cursor.source_instance_id=receipt.source_instance_id AND own_cursor.application_id=receipt.application_id
 AND own_cursor.history_epoch_id=receipt.history_epoch_id AND own_cursor.generation=receipt.authorization_generation)
),
-- Existing presentation groups require explicit future reconciliation, not silent rekeying.
import_unlinked_memberships AS MATERIALIZED(SELECT review.import_id FROM native_directory_existing_import_reviews review
 WHERE NOT EXISTS(SELECT 1 FROM business_party_links link
 WHERE link.source_id=review.source_id AND link.record_kind=review.record_kind AND link.unlinked_at IS NULL
 AND link.record_id IN(review.record_id,json_extract(review.review_json,'$.nativeRecordId')))),
import_proof_0 AS MATERIALIZED (SELECT review.import_id
FROM native_directory_existing_import_reviews review
JOIN import_classic_rows classic ON classic.source_id=review.source_id AND classic.record_id=review.record_id AND classic.record_kind=review.record_kind
JOIN native_staff_admissions admission ON admission.staff_id=json_extract(review.review_json,'$.actor.staffId')
JOIN staff_users staff ON staff.id=admission.staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN native_directory_grant_generations grants ON grants.staff_id=admission.staff_id
JOIN native_business_areas area ON area.id=json_extract(review.review_json,'$.businessAreaId') AND area.active=1 WHERE ((((review.import_id=json_extract(review.review_json,'$.importId')) AND (review.idempotency_key=json_extract(review.review_json,'$.idempotencyKey'))) AND ((json_extract(review.review_json,'$.nativeRecordId')='pa-import:'||review.source_id||':'||review.record_kind||':'||review.record_id) AND (length(CAST(json_extract(review.review_json,'$.nativeRecordId') AS BLOB)) BETWEEN 1 AND 191))) AND ((((json_extract(review.review_json,'$.parentRecordId') IS NULL AND json_extract(review.review_json,'$.parentNativeRecordId') IS NULL
  OR json_extract(review.review_json,'$.parentNativeRecordId')='pa-import:'||review.source_id||':organization:'||json_extract(review.review_json,'$.parentRecordId'))) AND (length(review.batch_id)=36)) AND ((review.created_at=json_extract(review.review_json,'$.reviewedAt')) AND (review.expires_at=json_extract(review.review_json,'$.expiresAt')))))
),
import_proof_1 AS MATERIALIZED (SELECT review.import_id
FROM native_directory_existing_import_reviews review
JOIN import_classic_rows classic ON classic.source_id=review.source_id AND classic.record_id=review.record_id AND classic.record_kind=review.record_kind
JOIN native_staff_admissions admission ON admission.staff_id=json_extract(review.review_json,'$.actor.staffId')
JOIN staff_users staff ON staff.id=admission.staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN native_directory_grant_generations grants ON grants.staff_id=admission.staff_id
JOIN native_business_areas area ON area.id=json_extract(review.review_json,'$.businessAreaId') AND area.active=1 WHERE ((((review.created_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND ((review.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR EXISTS(SELECT 1 FROM native_directory_existing_import_renewals renewal WHERE renewal.import_id=review.import_id AND renewal.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))))) AND ((review.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',review.created_at,'+4 hours')) AND (staff.status='active'))) AND (((staff.access_subject=json_extract(review.review_json,'$.actor.accessSubject')) AND (admission.active=1)) AND ((admission.bound_access_subject=staff.access_subject) AND (admission.version=json_extract(review.review_json,'$.actor.admissionVersion')))))
),
import_proof_2 AS MATERIALIZED (SELECT review.import_id
FROM native_directory_existing_import_reviews review
JOIN import_classic_rows classic ON classic.source_id=review.source_id AND classic.record_id=review.record_id AND classic.record_kind=review.record_kind
JOIN native_staff_admissions admission ON admission.staff_id=json_extract(review.review_json,'$.actor.staffId')
JOIN staff_users staff ON staff.id=admission.staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN native_directory_grant_generations grants ON grants.staff_id=admission.staff_id
JOIN native_business_areas area ON area.id=json_extract(review.review_json,'$.businessAreaId') AND area.active=1 WHERE ((((profile.version=json_extract(review.review_json,'$.actor.profileVersion')) AND (profile.login_email=json_extract(review.review_json,'$.actor.loginEmail'))) AND ((grants.generation=json_extract(review.review_json,'$.actor.grantGeneration')) AND (EXISTS(SELECT 1 FROM staff_role_assignments owner WHERE owner.staff_id=staff.id AND owner.role_id='role-owner' AND owner.scope='global')))) AND (((json_array_length(json_extract(review.review_json,'$.selectedGrants'))=4) AND (NOT EXISTS(SELECT 1 FROM json_each('["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage"]') permission
   WHERE NOT EXISTS(SELECT 1 FROM json_each(review.review_json,'$.selectedGrants') selected JOIN native_directory_grants allow_row
     ON allow_row.id=json_extract(selected.value,'$.id') AND allow_row.permission=permission.value
     WHERE json_extract(selected.value,'$.permission')=permission.value AND allow_row.staff_id=staff.id AND allow_row.effect='allow' AND allow_row.active=1
       AND (allow_row.scope_kind='global' OR allow_row.scope_kind='business_area' AND allow_row.business_area_id=area.id))))) AND ((NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=staff.id AND deny.effect='deny' AND deny.active=1
   AND deny.permission IN ('directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage')
   AND (deny.scope_kind='global' OR deny.scope_kind='resource' AND deny.resource_id IN (review.record_id,json_extract(review.review_json,'$.nativeRecordId')) OR deny.scope_kind='business_area' AND deny.business_area_id=area.id))) AND (classic.payload_json=json_extract(review.review_json,'$.classicPayload')))))
),
import_proof_3 AS MATERIALIZED (SELECT review.import_id
FROM native_directory_existing_import_reviews review
JOIN import_classic_rows classic ON classic.source_id=review.source_id AND classic.record_id=review.record_id AND classic.record_kind=review.record_kind
JOIN native_staff_admissions admission ON admission.staff_id=json_extract(review.review_json,'$.actor.staffId')
JOIN staff_users staff ON staff.id=admission.staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN native_directory_grant_generations grants ON grants.staff_id=admission.staff_id
JOIN native_business_areas area ON area.id=json_extract(review.review_json,'$.businessAreaId') AND area.active=1 WHERE ((((classic.name=json_extract(review.review_json,'$.classicName')) AND (classic.parent_record_id IS json_extract(review.review_json,'$.parentRecordId'))) AND ((classic.public_id=json_extract(review.review_json,'$.publicId')) AND (length(classic.public_id)=32))) AND (((classic.public_id NOT GLOB '*[^0-9a-f]*') AND (CASE classic.record_kind WHEN 'organization' THEN
 json(json_remove(classic.profile_json,'$.generalEmail','$.generalPhone'))=json(json_remove(json_extract(review.review_json,'$.profile'),'$.generalEmail','$.generalPhone'))
 AND json_extract(review.review_json,'$.profile.generalEmail')=lower(trim(coalesce(json_extract(review.review_json,'$.observation.profile.email'),'')))
 AND json_extract(review.review_json,'$.profile.generalPhone')=trim(coalesce(json_extract(review.review_json,'$.observation.profile.phone'),''))
 ELSE json(classic.profile_json)=json(json_extract(review.review_json,'$.profile')) END)) AND ((json_extract(review.review_json,'$.observation.authoritative')=0) AND (json_extract(review.review_json,'$.observation.sourceId')=review.source_id))))
),
import_proof_4 AS MATERIALIZED (SELECT review.import_id
FROM native_directory_existing_import_reviews review
JOIN import_classic_rows classic ON classic.source_id=review.source_id AND classic.record_id=review.record_id AND classic.record_kind=review.record_kind
JOIN native_staff_admissions admission ON admission.staff_id=json_extract(review.review_json,'$.actor.staffId')
JOIN staff_users staff ON staff.id=admission.staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN native_directory_grant_generations grants ON grants.staff_id=admission.staff_id
JOIN native_business_areas area ON area.id=json_extract(review.review_json,'$.businessAreaId') AND area.active=1 WHERE ((((json_extract(review.review_json,'$.observation.sourceInstanceId')=json_extract(review.review_json,'$.sourceInstanceId')) AND (json_extract(review.review_json,'$.observation.applicationId')=json_extract(review.review_json,'$.applicationId'))) AND ((json_extract(review.review_json,'$.observation.historyEpoch')=json_extract(review.review_json,'$.historyEpoch')) AND (json_extract(review.review_json,'$.observation.resource.type')=review.record_kind))) AND (((json_extract(review.review_json,'$.observation.resource.id')=classic.public_id) AND ((CASE classic.record_kind WHEN 'client' THEN (SELECT count(*) FROM pa_clients duplicate WHERE duplicate.projection_source_id=classic.source_id
  AND CASE WHEN json_valid(duplicate.payload_json) THEN json_extract(duplicate.payload_json,'$.public_id') END=classic.public_id)
 ELSE (SELECT count(*) FROM pa_organizations duplicate WHERE duplicate.projection_source_id=classic.source_id
  AND CASE WHEN json_valid(duplicate.payload_json) THEN json_extract(duplicate.payload_json,'$.public_id') END=classic.public_id) END)=1)) AND (((classic.parent_record_id IS NULL AND json_extract(review.review_json,'$.parentPublicId') IS NULL OR EXISTS(
   SELECT 1 FROM import_classic_rows parent WHERE parent.source_id=classic.source_id AND parent.record_id=classic.parent_record_id
    AND parent.record_kind='organization' AND parent.public_id=json_extract(review.review_json,'$.parentPublicId')
    AND (SELECT count(*) FROM import_classic_rows duplicate WHERE duplicate.source_id=parent.source_id AND duplicate.record_kind='organization' AND duplicate.public_id=parent.public_id)=1))) AND (EXISTS(SELECT 1 FROM import_current_observations observation JOIN pa_connectors connector ON connector.source_id=observation.source_id
   JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
    AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
    AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
 JOIN import_generation_receipts generation_receipt ON generation_receipt.import_id=review.import_id AND generation_receipt.request_id=receipt.request_id
   WHERE (((((observation.source_id=review.source_id) AND (observation.resource_type=review.record_kind)) AND ((observation.project_alpha_public_id=classic.public_id) AND (observation.source_instance_id=json_extract(review.review_json,'$.sourceInstanceId')))) AND (((observation.application_id=json_extract(review.review_json,'$.applicationId')) AND (observation.history_epoch_id=json_extract(review.review_json,'$.historyEpoch'))) AND ((observation.resource_revision=json_extract(review.review_json,'$.observation.resource.revision')) AND (1=1)))) AND ((((observation.present=1) AND (observation.last_action='upsert')) AND ((observation.has_conflict=0) AND (observation.binding_external_id IS NULL))) AND (((observation.binding_status IS NULL) AND (connector.read_visible=1)) AND ((connector.state<>'retired') AND (connector.snapshot_origin=json_extract(review.review_json,'$.origin')))))))))))
),
import_proof_5 AS MATERIALIZED (SELECT review.import_id
FROM native_directory_existing_import_reviews review
JOIN import_classic_rows classic ON classic.source_id=review.source_id AND classic.record_id=review.record_id AND classic.record_kind=review.record_kind
JOIN native_staff_admissions admission ON admission.staff_id=json_extract(review.review_json,'$.actor.staffId')
JOIN staff_users staff ON staff.id=admission.staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN native_directory_grant_generations grants ON grants.staff_id=admission.staff_id
JOIN native_business_areas area ON area.id=json_extract(review.review_json,'$.businessAreaId') AND area.active=1 WHERE (((NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict WHERE conflict.source_id=review.source_id AND conflict.inventory_kind='directory' AND conflict.resource_type='source')) AND (NOT EXISTS(SELECT 1 FROM import_active_mappings mapping WHERE mapping.source_id=review.source_id AND mapping.resource_type=review.record_kind
   AND (mapping.project_alpha_public_id=classic.public_id OR mapping.record_id=classic.record_id OR mapping.external_id=classic.record_id)))) AND ((NOT EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping WHERE mapping.source_id=review.source_id AND mapping.resource_type=review.record_kind
   AND (mapping.project_alpha_public_id=classic.public_id OR mapping.record_id=classic.record_id OR mapping.external_id=classic.record_id))) AND ((NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquired_mapping_receipts mapping WHERE mapping.source_id=review.source_id AND mapping.resource_type=review.record_kind
   AND (mapping.project_alpha_public_id=classic.public_id OR mapping.external_id=classic.record_id))) AND (NOT EXISTS(SELECT 1 FROM operations_directory_records native WHERE native.record_id=json_extract(review.review_json,'$.nativeRecordId') AND NOT EXISTS(
   SELECT 1 FROM native_directory_create_admissions own WHERE own.record_id=native.record_id AND own.id='existing-import:'||review.import_id AND own.consumed_mutation_id=review.import_id))))))
)
SELECT review.*,json_extract(review.review_json,'$.profile') profile_json
FROM native_directory_existing_import_reviews review
JOIN import_proof_0 proof_0 ON proof_0.import_id=review.import_id
JOIN import_proof_1 proof_1 ON proof_1.import_id=review.import_id
JOIN import_proof_2 proof_2 ON proof_2.import_id=review.import_id
JOIN import_proof_3 proof_3 ON proof_3.import_id=review.import_id
JOIN import_proof_4 proof_4 ON proof_4.import_id=review.import_id
JOIN import_unlinked_memberships unlinked ON unlinked.import_id=review.import_id
JOIN import_proof_5 proof_5 ON proof_5.import_id=review.import_id;

CREATE TRIGGER native_directory_existing_import_review_guard AFTER INSERT ON native_directory_existing_import_reviews
WHEN NOT EXISTS(SELECT 1 FROM native_directory_existing_import_live_reviews live WHERE live.import_id=NEW.import_id)
 OR EXISTS(SELECT 1 FROM native_directory_existing_import_source_cursors cursor
 WHERE cursor.batch_id=NEW.batch_id AND cursor.source_id=NEW.source_id
 AND (cursor.source_instance_id IS NOT json_extract(NEW.review_json,'$.sourceInstanceId')
 OR cursor.application_id IS NOT json_extract(NEW.review_json,'$.applicationId')
 OR cursor.history_epoch_id IS NOT json_extract(NEW.review_json,'$.historyEpoch')
 OR cursor.generation IS NOT json_extract(NEW.review_json,'$.observation.authorizationGeneration')))
 OR json_type(NEW.review_json,'$.actor.verifiedUntil') IS NOT 'text'
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at) IS NOT NEW.expires_at
 OR strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.review_json,'$.actor.verifiedUntil')) IS NOT json_extract(NEW.review_json,'$.actor.verifiedUntil')
 OR json_extract(NEW.review_json,'$.actor.verifiedUntil')<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
BEGIN SELECT RAISE(ABORT,'existing import requires current exact source, projection and native authority'); END;
CREATE TRIGGER native_directory_existing_import_cursor_insert_guard BEFORE INSERT ON native_directory_existing_import_source_cursors
WHEN NEW.last_import_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM native_directory_existing_import_live_reviews review
 WHERE review.batch_id=NEW.batch_id AND review.source_id=NEW.source_id
 AND json_extract(review.review_json,'$.sourceInstanceId')=NEW.source_instance_id
 AND json_extract(review.review_json,'$.applicationId')=NEW.application_id AND json_extract(review.review_json,'$.historyEpoch')=NEW.history_epoch_id
 AND json_extract(review.review_json,'$.observation.authorizationGeneration')=NEW.generation)
BEGIN SELECT RAISE(ABORT,'existing import cursor requires reviewed source generation'); END;
CREATE TRIGGER native_directory_existing_import_cursor_update_guard BEFORE UPDATE ON native_directory_existing_import_source_cursors
WHEN NEW.batch_id<>OLD.batch_id OR NEW.source_id<>OLD.source_id OR NEW.source_instance_id<>OLD.source_instance_id
 OR NEW.application_id<>OLD.application_id OR NEW.history_epoch_id<>OLD.history_epoch_id
 OR CAST(NEW.generation AS INTEGER)<>CAST(OLD.generation AS INTEGER)+1
 OR NOT EXISTS(SELECT 1 FROM native_directory_existing_import_events event
 JOIN native_directory_existing_import_reviews review ON review.import_id=event.import_id
 JOIN native_directory_existing_import_binding_intents intent ON intent.import_id=review.import_id AND intent.command_id=json_extract(event.detail_json,'$.commandId')
 JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response
   ON response.command_id=intent.command_id
 WHERE event.import_id=NEW.last_import_id AND event.state='acquired' AND review.batch_id=NEW.batch_id AND review.source_id=NEW.source_id
 AND response.expected_authorization_generation=OLD.generation AND json_extract(event.detail_json,'$.expectedGeneration')=OLD.generation
 AND json_extract(event.detail_json,'$.nextGeneration')=NEW.generation AND response.result_authorization_generation=NEW.generation
 AND response.source_instance_id=NEW.source_instance_id AND response.application_id=NEW.application_id AND response.history_epoch_id=NEW.history_epoch_id
 AND response.resource_type=review.record_kind AND response.external_id=json_extract(review.review_json,'$.nativeRecordId')
 AND response.project_alpha_public_id=json_extract(review.review_json,'$.publicId'))
BEGIN SELECT RAISE(ABORT,'existing import generation advances only from exact binding acknowledgment'); END;
CREATE TRIGGER native_directory_existing_import_cursor_no_delete BEFORE DELETE ON native_directory_existing_import_source_cursors
BEGIN SELECT RAISE(ABORT,'existing import source cursor is durable'); END;
CREATE TRIGGER native_directory_existing_import_execution_guard AFTER INSERT ON native_directory_existing_import_execution_admissions
WHEN NOT EXISTS(SELECT 1 FROM native_directory_existing_import_live_reviews review WHERE review.import_id=NEW.import_id
 AND (json_extract(NEW.actor_json,'$.staffId'),json_extract(NEW.actor_json,'$.accessSubject'),json_extract(NEW.actor_json,'$.loginEmail'),json_extract(NEW.actor_json,'$.admissionVersion'),json_extract(NEW.actor_json,'$.profileVersion'),json_extract(NEW.actor_json,'$.grantGeneration'))=(json_extract(review.review_json,'$.actor.staffId'),json_extract(review.review_json,'$.actor.accessSubject'),json_extract(review.review_json,'$.actor.loginEmail'),json_extract(review.review_json,'$.actor.admissionVersion'),json_extract(review.review_json,'$.actor.profileVersion'),json_extract(review.review_json,'$.actor.grantGeneration')))
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.verified_until) IS NOT NEW.verified_until
 OR strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.actor_json,'$.verifiedUntil')) IS NOT json_extract(NEW.actor_json,'$.verifiedUntil')
 OR NEW.verified_until>json_extract(NEW.actor_json,'$.verifiedUntil')
 OR json_extract(NEW.actor_json,'$.verifiedUntil') IS NULL
 OR NEW.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NEW.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+15 minutes')
BEGIN SELECT RAISE(ABORT,'existing import execution requires current admitted actor'); END;
CREATE TRIGGER native_directory_existing_import_create_guard BEFORE INSERT ON native_directory_create_admissions
WHEN substr(NEW.id,1,16)='existing-import:' AND NOT EXISTS(
 SELECT 1 FROM native_directory_existing_import_execution_admissions execution
 JOIN native_directory_existing_import_live_reviews review ON review.import_id=execution.import_id
 WHERE NEW.id='existing-import:'||review.import_id AND NEW.staff_id=json_extract(review.review_json,'$.actor.staffId')
 AND NEW.bound_access_subject=json_extract(review.review_json,'$.actor.accessSubject') AND NEW.record_id=json_extract(review.review_json,'$.nativeRecordId') AND NEW.record_kind=review.record_kind
 AND json(NEW.profile_json)=json(review.profile_json)
 AND json(NEW.scopes_json)=json(json_array(json_object('businessAreaId',json_extract(review.review_json,'$.businessAreaId'),'divisionId',NULL)))
 AND json(NEW.destinations_json)=json(json_array(json_object('sourceId',review.source_id,
   'sourceInstanceUUID',json_extract(review.review_json,'$.sourceInstanceId'),'applicationUUID',json_extract(review.review_json,'$.applicationId'),
   'historyEpoch',json_extract(review.review_json,'$.historyEpoch'),'origin',json_extract(review.review_json,'$.origin'),'externalCanonicalId',json_extract(review.review_json,'$.nativeRecordId'))))
 AND execution.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'existing import create admission requires immutable reviewed execution'); END;
CREATE TRIGGER native_directory_existing_import_fence_guard BEFORE INSERT ON operations_directory_write_fences
WHEN substr(NEW.create_admission_id,1,16)='existing-import:' AND (
 NEW.intent_writes<>0 OR NEW.operation_kind<>'create' OR NEW.mutation_id<>substr(NEW.create_admission_id,17)
 OR NOT EXISTS(SELECT 1 FROM native_directory_existing_import_execution_admissions execution
   WHERE execution.import_id=NEW.mutation_id AND execution.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'existing import cannot create PA transport intents'); END;
-- Retain the normal admission-version and intent-count policy. The sole new
-- exception is a reviewed import execution: one exact enrollment, zero PA
-- create intents, and current native authority. No staging exception is reused.
DROP TRIGGER operations_directory_write_fences_insert_shape;
CREATE TRIGGER operations_directory_write_fences_insert_shape BEFORE INSERT ON operations_directory_write_fences
WHEN (NEW.intent_writes<>json_array_length(NEW.destinations_json) AND NOT (
 NEW.intent_writes=0 AND json_array_length(NEW.destinations_json)=1 AND NEW.operation_kind='create'
 AND NEW.create_admission_id='existing-import:'||NEW.mutation_id
 AND EXISTS(SELECT 1 FROM native_directory_existing_import_execution_admissions execution
 JOIN native_directory_existing_import_live_reviews review ON review.import_id=execution.import_id
 WHERE execution.import_id=NEW.mutation_id AND json_extract(review.review_json,'$.nativeRecordId')=NEW.record_id AND review.record_kind=NEW.record_kind
 AND execution.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))))
 OR NEW.actor_admission_version IS NULL OR typeof(NEW.actor_admission_version)<>'integer' OR NEW.actor_admission_version<1
BEGIN SELECT RAISE(ABORT,'directory write fence context is invalid'); END;
CREATE TRIGGER native_directory_existing_import_local_guard AFTER INSERT ON native_directory_existing_import_local_receipts
WHEN NOT EXISTS(SELECT 1 FROM native_directory_existing_import_reviews review
 JOIN operations_directory_records record ON record.record_id=json_extract(review.review_json,'$.nativeRecordId') AND record.record_kind=review.record_kind AND record.current_version=1
 JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=1 AND revision.mutation_id=review.import_id
 JOIN operations_directory_audit audit ON audit.record_id=record.record_id AND audit.mutation_id=review.import_id
 JOIN native_directory_existing_import_execution_admissions execution ON execution.import_id=review.import_id AND execution.execution_id=NEW.execution_id
 WHERE review.import_id=NEW.import_id AND NEW.record_id=json_extract(review.review_json,'$.nativeRecordId') AND NEW.mutation_id=review.import_id
 AND json(revision.profile_json)=json(json_extract(review.review_json,'$.profile'))
 AND execution.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR EXISTS(SELECT 1 FROM operations_directory_intents intent WHERE intent.record_id=NEW.record_id)
BEGIN SELECT RAISE(ABORT,'existing import local receipt requires exact native write and zero intents'); END;
CREATE TRIGGER native_directory_existing_import_binding_intent_guard AFTER INSERT ON native_directory_existing_import_binding_intents
WHEN NOT EXISTS(SELECT 1 FROM native_directory_existing_import_live_reviews review
 JOIN native_directory_existing_import_source_cursors cursor ON cursor.batch_id=review.batch_id AND cursor.source_id=review.source_id
 WHERE (((((review.import_id=NEW.import_id AND json_extract(NEW.command_json,'$.commandId')=NEW.command_id) AND (json_extract(NEW.command_json,'$.externalId')=json_extract(review.review_json,'$.nativeRecordId'))) AND ((json_extract(NEW.command_json,'$.expectedPublicId')=json_extract(review.review_json,'$.publicId')) AND (json_extract(NEW.command_json,'$.expectedRevision')=json_extract(review.review_json,'$.observation.resource.revision')))) AND (((json_extract(NEW.command_json,'$.expectedAuthorizationGeneration')=cursor.generation) AND (json_extract(NEW.profile_evidence_json,'$.sourceId')=review.source_id)) AND ((json_extract(NEW.profile_evidence_json,'$.sourceInstanceId')=cursor.source_instance_id) AND ((json_extract(NEW.profile_evidence_json,'$.applicationId')=cursor.application_id) AND (json_extract(NEW.profile_evidence_json,'$.historyEpoch')=cursor.history_epoch_id))))) AND ((((json_extract(NEW.profile_evidence_json,'$.authorizationGeneration')=cursor.generation) AND (json_extract(NEW.profile_evidence_json,'$.resource.id')=json_extract(review.review_json,'$.publicId'))) AND ((json_extract(NEW.profile_evidence_json,'$.resource.revision')=json_extract(NEW.command_json,'$.expectedRevision')) AND (json_extract(NEW.actor_json,'$.staffId')=json_extract(review.review_json,'$.actor.staffId')))) AND (((json_extract(NEW.actor_json,'$.accessSubject')=json_extract(review.review_json,'$.actor.accessSubject')) AND (json_extract(NEW.actor_json,'$.admissionVersion')=json_extract(review.review_json,'$.actor.admissionVersion'))) AND ((json_extract(NEW.actor_json,'$.profileVersion')=json_extract(review.review_json,'$.actor.profileVersion')) AND ((json_extract(NEW.actor_json,'$.grantGeneration')=json_extract(review.review_json,'$.actor.grantGeneration')) AND (json_extract(NEW.actor_json,'$.verifiedUntil')>strftime('%Y-%m-%dT%H:%M:%fZ','now'))))))))
BEGIN SELECT RAISE(ABORT,'existing import binding intent requires exact unbound review and current source generation'); END;
CREATE TRIGGER native_directory_existing_import_binding_reservation_guard BEFORE INSERT ON project_alpha_existing_directory_binding_review_evidence
WHEN EXISTS(SELECT 1 FROM native_directory_existing_import_reviews import WHERE import.import_id=NEW.review_id)
 AND NOT EXISTS(SELECT 1 FROM native_directory_existing_import_binding_intents intent
 JOIN native_directory_existing_import_reviews review ON review.import_id=intent.import_id
 WHERE intent.import_id=NEW.review_id AND intent.review_receipt_id=NEW.receipt_id AND intent.request_sha256=NEW.request_sha256
 AND NEW.record_id=json_extract(review.review_json,'$.nativeRecordId') AND NEW.resource_type=review.record_kind AND NEW.source_id=review.source_id
 AND NEW.external_id=json_extract(review.review_json,'$.nativeRecordId') AND NEW.project_alpha_public_id=json_extract(review.review_json,'$.publicId')
 AND NEW.source_instance_id=json_extract(review.review_json,'$.sourceInstanceId') AND NEW.application_id=json_extract(review.review_json,'$.applicationId')
 AND NEW.history_epoch_id=json_extract(review.review_json,'$.historyEpoch') AND NEW.reviewed_local_record_version=1
 AND NEW.project_alpha_revision=json_extract(intent.command_json,'$.expectedRevision')
 AND NEW.reviewer_staff_id=json_extract(review.review_json,'$.actor.staffId')
 AND NEW.reviewer_access_subject=json_extract(review.review_json,'$.actor.accessSubject'))
BEGIN SELECT RAISE(ABORT,'unbound existing import reservation requires immutable exact import command'); END;
CREATE TRIGGER native_directory_existing_import_translation_guard AFTER INSERT ON native_directory_existing_import_identity_translations
WHEN NOT EXISTS(SELECT 1 FROM native_directory_existing_import_reviews review
 JOIN native_directory_existing_import_local_receipts receipt ON receipt.import_id=review.import_id
 WHERE review.import_id=NEW.import_id AND review.source_id=NEW.source_id AND review.record_kind=NEW.record_kind
 AND review.record_id=NEW.classic_record_id AND receipt.record_id=NEW.native_record_id
 AND json_extract(review.review_json,'$.nativeRecordId')=NEW.native_record_id AND json_extract(review.review_json,'$.publicId')=NEW.public_id)
BEGIN SELECT RAISE(ABORT,'existing import translation requires exact immutable local receipt'); END;
CREATE TRIGGER native_directory_existing_import_translation_no_update BEFORE UPDATE ON native_directory_existing_import_identity_translations
BEGIN SELECT RAISE(ABORT,'existing import identity translation is immutable'); END;
CREATE TRIGGER native_directory_existing_import_translation_no_delete BEFORE DELETE ON native_directory_existing_import_identity_translations
BEGIN SELECT RAISE(ABORT,'existing import identity translation is durable'); END;
CREATE TRIGGER native_directory_existing_import_binding_intents_no_update BEFORE UPDATE ON native_directory_existing_import_binding_intents
BEGIN SELECT RAISE(ABORT,'existing import binding command is immutable'); END;
CREATE TRIGGER native_directory_existing_import_binding_intents_no_delete BEFORE DELETE ON native_directory_existing_import_binding_intents
BEGIN SELECT RAISE(ABORT,'existing import binding command is durable'); END;

CREATE TRIGGER native_directory_existing_import_reviews_no_update BEFORE UPDATE ON native_directory_existing_import_reviews BEGIN SELECT RAISE(ABORT,'existing import evidence is immutable'); END;

CREATE TRIGGER native_directory_existing_import_reviews_no_delete BEFORE DELETE ON native_directory_existing_import_reviews BEGIN SELECT RAISE(ABORT,'existing import evidence is immutable'); END;

CREATE TRIGGER native_directory_existing_import_execution_admissions_no_update BEFORE UPDATE ON native_directory_existing_import_execution_admissions BEGIN SELECT RAISE(ABORT,'existing import evidence is immutable'); END;

CREATE TRIGGER native_directory_existing_import_execution_admissions_no_delete BEFORE DELETE ON native_directory_existing_import_execution_admissions BEGIN SELECT RAISE(ABORT,'existing import evidence is immutable'); END;

CREATE TRIGGER native_directory_existing_import_local_receipts_no_update BEFORE UPDATE ON native_directory_existing_import_local_receipts BEGIN SELECT RAISE(ABORT,'existing import evidence is immutable'); END;

CREATE TRIGGER native_directory_existing_import_local_receipts_no_delete BEFORE DELETE ON native_directory_existing_import_local_receipts BEGIN SELECT RAISE(ABORT,'existing import evidence is immutable'); END;

CREATE TRIGGER native_directory_existing_import_events_no_update BEFORE UPDATE ON native_directory_existing_import_events BEGIN SELECT RAISE(ABORT,'existing import evidence is immutable'); END;

CREATE TRIGGER native_directory_existing_import_events_no_delete BEFORE DELETE ON native_directory_existing_import_events BEGIN SELECT RAISE(ABORT,'existing import evidence is immutable'); END;


-- Renewal extends only the same reviewed command; authority versions are never refreshed.
CREATE TRIGGER native_directory_existing_import_renewal_guard BEFORE INSERT ON native_directory_existing_import_renewals
WHEN strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.actor_json,'$.verifiedUntil')) IS NOT json_extract(NEW.actor_json,'$.verifiedUntil')
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at) IS NOT NEW.expires_at
 OR NEW.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NEW.created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')
 OR NEW.expires_at<=NEW.created_at OR NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+4 hours')
 OR NOT EXISTS(SELECT 1 FROM native_directory_existing_import_reviews review
 JOIN native_staff_admissions admission ON admission.staff_id=json_extract(review.review_json,'$.actor.staffId')
 JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
 JOIN staff_users staff ON staff.id=admission.staff_id
 JOIN native_directory_grant_generations generation ON generation.staff_id=staff.id
 WHERE review.import_id=NEW.import_id AND admission.active=1 AND staff.status='active'
 AND staff.access_subject=admission.bound_access_subject
 AND admission.bound_access_subject=json_extract(NEW.actor_json,'$.accessSubject')
 AND admission.version=json_extract(NEW.actor_json,'$.admissionVersion')
 AND profile.version=json_extract(NEW.actor_json,'$.profileVersion') AND profile.login_email=json_extract(NEW.actor_json,'$.loginEmail')
 AND generation.generation=json_extract(NEW.actor_json,'$.grantGeneration')
 AND json_extract(NEW.actor_json,'$.verifiedUntil')>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND NOT EXISTS(SELECT 1 FROM json_each('["staffId","accessSubject","loginEmail","admissionVersion","profileVersion","grantGeneration"]') field
 WHERE json_extract(NEW.actor_json,'$.'||field.value) IS NOT json_extract(review.review_json,'$.actor.'||field.value)))
BEGIN SELECT RAISE(ABORT,'existing import renewal requires original current admitted actor'); END;
CREATE TRIGGER native_directory_existing_import_renewals_no_update BEFORE UPDATE ON native_directory_existing_import_renewals
BEGIN SELECT RAISE(ABORT,'existing import renewal is immutable'); END;
CREATE TRIGGER native_directory_existing_import_renewals_no_delete BEFORE DELETE ON native_directory_existing_import_renewals
BEGIN SELECT RAISE(ABORT,'existing import renewal is durable'); END;
CREATE TRIGGER native_directory_existing_import_event_local_guard BEFORE INSERT ON native_directory_existing_import_events
WHEN NEW.state='local_imported' AND NOT EXISTS(SELECT 1 FROM native_directory_existing_import_local_receipts receipt
 JOIN native_directory_existing_import_reviews review ON review.import_id=receipt.import_id
 WHERE receipt.import_id=NEW.import_id AND receipt.record_id=json_extract(NEW.detail_json,'$.recordId')
 AND review.record_id=json_extract(NEW.detail_json,'$.classicRecordId'))
BEGIN SELECT RAISE(ABORT,'existing import local event requires own immutable receipt'); END;
CREATE TRIGGER native_directory_existing_import_event_acquired_guard BEFORE INSERT ON native_directory_existing_import_events
WHEN NEW.state='acquired' AND NOT EXISTS(SELECT 1 FROM native_directory_existing_import_reviews review
 JOIN native_directory_existing_import_binding_intents intent ON intent.import_id=review.import_id
 JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.command_id=intent.command_id AND command.request_sha256=intent.request_sha256
 JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=command.command_id
 JOIN native_directory_existing_import_source_cursors cursor ON cursor.batch_id=review.batch_id AND cursor.source_id=review.source_id
 WHERE review.import_id=NEW.import_id AND intent.command_id=json_extract(NEW.detail_json,'$.commandId')
 AND response.expected_authorization_generation=cursor.generation AND response.expected_authorization_generation=json_extract(NEW.detail_json,'$.expectedGeneration')
 AND response.result_authorization_generation=json_extract(NEW.detail_json,'$.nextGeneration')
 AND CAST(response.result_authorization_generation AS INTEGER)=CAST(cursor.generation AS INTEGER)+1
 AND response.source_instance_id=cursor.source_instance_id AND response.application_id=cursor.application_id AND response.history_epoch_id=cursor.history_epoch_id
 AND response.resource_type=review.record_kind AND response.external_id=json_extract(review.review_json,'$.nativeRecordId')
 AND response.project_alpha_public_id=json_extract(review.review_json,'$.publicId')
 AND response.project_alpha_revision=json_extract(intent.command_json,'$.expectedRevision')
 AND response.expected_authorization_generation=json_extract(intent.command_json,'$.expectedAuthorizationGeneration')
 AND response.destination_origin=json_extract(review.review_json,'$.origin'))
BEGIN SELECT RAISE(ABORT,'existing import acquired event requires own exact acknowledgment and current cursor'); END;
CREATE TRIGGER native_directory_existing_import_event_activated_guard BEFORE INSERT ON native_directory_existing_import_events
WHEN NEW.state='activated' AND NOT EXISTS(SELECT 1 FROM native_directory_existing_import_reviews review
 JOIN native_directory_existing_import_binding_intents intent ON intent.import_id=review.import_id
 JOIN project_alpha_existing_directory_binding_activation_receipts activation ON activation.review_receipt_id=intent.review_receipt_id
 WHERE review.import_id=NEW.import_id AND activation.activation_id=json_extract(NEW.detail_json,'$.activationId')
 AND activation.record_id=json_extract(review.review_json,'$.nativeRecordId') AND activation.source_id=review.source_id
 AND activation.source_instance_id=json_extract(review.review_json,'$.sourceInstanceId')
 AND activation.application_id=json_extract(review.review_json,'$.applicationId') AND activation.history_epoch_id=json_extract(review.review_json,'$.historyEpoch')
 AND activation.resource_type=review.record_kind AND activation.external_id=json_extract(review.review_json,'$.nativeRecordId')
 AND activation.project_alpha_public_id=json_extract(review.review_json,'$.publicId'))
BEGIN SELECT RAISE(ABORT,'existing import activated event requires own exact activation receipt'); END;

-- Forward-only renewal of the exact existing import command, retaining every activation predicate.
DROP TRIGGER project_alpha_existing_directory_binding_activation_exact;

CREATE TRIGGER project_alpha_existing_directory_binding_activation_exact
BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM project_alpha_existing_directory_binding_review_evidence review
  JOIN project_alpha_existing_directory_binding_acquisition_commands command
    ON command.review_receipt_id=review.receipt_id
  JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response
    ON response.command_id=command.command_id
  JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired
    ON acquired.command_id=command.command_id
  JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=acquired.receipt_id
  JOIN project_alpha_acquired_native_owner_claims claim ON claim.receipt_id=mapping.receipt_id
  JOIN project_alpha_acquired_mapping_activation dormant ON dormant.receipt_id=mapping.receipt_id AND dormant.state='inactive'
  JOIN operations_directory_records record ON record.record_id=review.record_id
  WHERE (review.receipt_id,acquired.receipt_id,claim.claim_id)=
      (NEW.review_receipt_id,NEW.acquired_receipt_id,NEW.native_owner_claim_id)
    AND (NEW.record_id,NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,
      NEW.resource_type,NEW.external_id,NEW.project_alpha_public_id,NEW.project_alpha_revision,
      NEW.local_record_version,NEW.request_sha256)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,review.history_epoch_id,
      review.resource_type,review.external_id,review.project_alpha_public_id,review.project_alpha_revision,
      review.reviewed_local_record_version,review.request_sha256)
    AND (NEW.acquisition_evidence_sha256,NEW.profile_evidence_sha256,NEW.binding_status_evidence_sha256)=
      (acquired.acquisition_evidence_sha256,acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
    AND response.response_sha256=acquired.acquisition_evidence_sha256
    AND review.reviewed_binding_evidence_sha256<>acquired.acquisition_evidence_sha256
    AND review.reviewed_binding_evidence_sha256<>acquired.profile_evidence_sha256
    AND review.reviewed_binding_evidence_sha256<>acquired.binding_status_evidence_sha256
    AND acquired.acquisition_evidence_sha256<>acquired.profile_evidence_sha256
    AND acquired.acquisition_evidence_sha256<>acquired.binding_status_evidence_sha256
    AND acquired.profile_evidence_sha256<>acquired.binding_status_evidence_sha256
    AND review.reviewed_at<=response.received_at AND response.received_at<=acquired.acquired_at
    AND NOT EXISTS (
      SELECT 1 FROM project_alpha_existing_directory_binding_review_evidence other_review
      WHERE other_review.receipt_id<>review.receipt_id
        AND other_review.reviewed_binding_evidence_sha256 IN (
          review.reviewed_binding_evidence_sha256,acquired.acquisition_evidence_sha256,
          acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
      UNION ALL
      SELECT 1 FROM project_alpha_existing_directory_binding_acquired_mapping_receipts other_acquired
      WHERE other_acquired.receipt_id<>acquired.receipt_id
        AND (other_acquired.acquisition_evidence_sha256 IN (
              review.reviewed_binding_evidence_sha256,acquired.acquisition_evidence_sha256,
              acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
          OR other_acquired.profile_evidence_sha256 IN (
              review.reviewed_binding_evidence_sha256,acquired.acquisition_evidence_sha256,
              acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
          OR other_acquired.binding_status_evidence_sha256 IN (
              review.reviewed_binding_evidence_sha256,acquired.acquisition_evidence_sha256,
              acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256))
    )
    AND (command.request_sha256,acquired.request_sha256,claim.request_sha256)=
      (review.request_sha256,review.request_sha256,review.request_sha256)
    AND claim.actor_id=review.reviewer_staff_id
    AND (response.source_instance_id,response.application_id,response.history_epoch_id,response.resource_type,
      response.external_id,response.project_alpha_public_id,response.project_alpha_revision)=
      (review.source_instance_id,review.application_id,review.history_epoch_id,review.resource_type,
      review.external_id,review.project_alpha_public_id,review.project_alpha_revision)
    AND (mapping.record_id,mapping.source_id,mapping.source_instance_id,mapping.application_id,
      mapping.history_epoch_id,mapping.resource_type,mapping.external_id,mapping.project_alpha_public_id)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,
      review.history_epoch_id,review.resource_type,review.external_id,review.project_alpha_public_id)
    AND mapping.activation_state='inactive' AND mapping.native_owner_epoch_id IS NULL
    AND (claim.record_id,claim.source_id,claim.source_instance_id,claim.application_id,claim.history_epoch_id,
      claim.resource_type,claim.external_id,claim.project_alpha_public_id)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,review.history_epoch_id,
      review.resource_type,review.external_id,review.project_alpha_public_id)
    AND claim.expected_local_record_version=review.reviewed_local_record_version
    AND record.record_kind=review.resource_type AND record.current_version=review.reviewed_local_record_version
    AND review.reviewed_local_record_version IS NOT NULL
    AND review.reviewed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND (review.reviewed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours') OR EXISTS(
 SELECT 1 FROM native_directory_existing_import_renewals renewal
 JOIN native_directory_existing_import_reviews import ON import.import_id=renewal.import_id
 JOIN native_directory_existing_import_binding_intents intent ON intent.import_id=import.import_id
 WHERE intent.review_receipt_id=review.receipt_id AND intent.command_id=command.command_id
 AND import.source_id=review.source_id AND import.record_kind=review.resource_type
 AND json_extract(import.review_json,'$.nativeRecordId')=review.record_id
 AND json_extract(import.review_json,'$.publicId')=review.project_alpha_public_id
 AND renewal.created_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND renewal.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    AND NEW.activated_by_staff_id=review.reviewer_staff_id
    AND EXISTS (SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_events event
      WHERE event.command_id=command.command_id AND event.state='acknowledged'
        AND event.request_sha256=review.request_sha256
        AND event.occurred_at>=review.reviewed_at AND event.occurred_at<=acquired.acquired_at)
)
BEGIN SELECT RAISE(ABORT,'existing directory binding activation requires current exact authority and evidence'); END;

-- Imported profiles obey the same editor field bounds even under direct SQL.
CREATE TRIGGER native_directory_existing_import_review_profile_guard BEFORE INSERT ON native_directory_existing_import_reviews
WHEN NOT EXISTS(SELECT 1 WHERE json_type(NEW.review_json,'$.profile')='object')
 OR EXISTS(SELECT 1 FROM json_each(CASE json_extract(NEW.review_json,'$.kind') WHEN 'organization' THEN
 '{"name":150,"generalEmail":255,"generalPhone":50,"addressLine1":255,"addressLine2":255,"city":100,"state":100,"postalCode":32,"country":100}'
 ELSE '{"name":150,"email":255,"phone":50,"addressLine1":255,"addressLine2":255,"city":100,"state":2,"postalCode":20,"country":100}' END) field
 WHERE json_type(NEW.review_json,'$.profile.'||field.key) IS NOT 'text'
 OR length(json_extract(NEW.review_json,'$.profile.'||field.key))>field.value
 OR instr(json_extract(NEW.review_json,'$.profile.'||field.key),char(0))>0
 OR json_extract(NEW.review_json,'$.profile.'||field.key) GLOB ('*['||char(1)||'-'||char(31)||char(127)||'-'||char(159)||char(8203)||'-'||char(8207)||char(8234)||'-'||char(8238)||char(8288)||'-'||char(8303)||char(65279)||']*'))
 OR EXISTS(SELECT 1 FROM json_each('["recordId","nativeRecordId"]') field
 WHERE json_type(NEW.review_json,'$.'||field.value) IS NOT 'text'
 OR length(json_extract(NEW.review_json,'$.'||field.value))=0
 OR instr(json_extract(NEW.review_json,'$.'||field.value),char(0))>0
 OR json_extract(NEW.review_json,'$.'||field.value) GLOB ('*['||char(1)||'-'||char(31)||char(127)||'-'||char(159)||char(8203)||'-'||char(8207)||char(8234)||'-'||char(8238)||char(8288)||'-'||char(8303)||char(65279)||']*'))
 OR length(trim(json_extract(NEW.review_json,'$.profile.name')))=0
BEGIN SELECT RAISE(ABORT,'existing import profile exceeds native editor bounds'); END;

CREATE TRIGGER native_directory_existing_import_renewal_authority_guard BEFORE INSERT ON native_directory_existing_import_renewals
WHEN NOT EXISTS(SELECT 1 FROM native_directory_existing_import_reviews review
 JOIN staff_users staff ON staff.id=json_extract(review.review_json,'$.actor.staffId')
 JOIN native_business_areas area ON area.id=json_extract(review.review_json,'$.businessAreaId') AND area.active=1
 WHERE review.import_id=NEW.import_id AND (EXISTS(SELECT 1 FROM staff_role_assignments owner WHERE owner.staff_id=staff.id AND owner.role_id='role-owner' AND owner.scope='global')) AND (json_array_length(json_extract(review.review_json,'$.selectedGrants'))=4) AND (NOT EXISTS(SELECT 1 FROM json_each('["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage"]') permission
   WHERE NOT EXISTS(SELECT 1 FROM json_each(review.review_json,'$.selectedGrants') selected JOIN native_directory_grants allow_row
     ON allow_row.id=json_extract(selected.value,'$.id') AND allow_row.permission=permission.value
     WHERE json_extract(selected.value,'$.permission')=permission.value AND allow_row.staff_id=staff.id AND allow_row.effect='allow' AND allow_row.active=1
       AND (allow_row.scope_kind='global' OR allow_row.scope_kind='business_area' AND allow_row.business_area_id=area.id)))) AND (NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=staff.id AND deny.effect='deny' AND deny.active=1
   AND deny.permission IN ('directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage')
   AND (deny.scope_kind='global' OR deny.scope_kind='resource' AND deny.resource_id IN (review.record_id,json_extract(review.review_json,'$.nativeRecordId')) OR deny.scope_kind='business_area' AND deny.business_area_id=area.id))))
BEGIN SELECT RAISE(ABORT,'existing import renewal requires original selected native authority'); END;
