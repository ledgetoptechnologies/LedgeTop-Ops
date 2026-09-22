PRAGMA foreign_keys = ON;

-- Server-owned, short-lived review evidence for a browser-selected existing
-- PA Project. This is deliberately not a PA transport, route, feature flag,
-- mapping, shared-project, delivery, or public-link writer. A later browser
-- action may name only review_item_id plus an idempotency key; all authority
-- and PA details are retained and rechecked here.
CREATE TABLE project_alpha_project_adoption_review_evidence (
  review_item_id TEXT NOT NULL PRIMARY KEY CHECK(length(review_item_id)=36 AND review_item_id=lower(review_item_id)
    AND review_item_id NOT GLOB '*[^0-9a-f-]*' AND substr(review_item_id,9,1)='-'
    AND substr(review_item_id,14,1)='-' AND substr(review_item_id,15,1)='4'
    AND substr(review_item_id,19,1)='-' AND substr(review_item_id,20,1) IN ('8','9','a','b')
    AND substr(review_item_id,24,1)='-' AND length(replace(review_item_id,'-',''))=32),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256) AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128 AND instr(source_id,char(0))=0),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  external_project_id TEXT NOT NULL REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT
    CHECK(length(external_project_id) BETWEEN 1 AND 191 AND instr(external_project_id,char(0))=0),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id=lower(project_alpha_public_id) AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(length(project_alpha_revision) BETWEEN 1 AND 19 AND project_alpha_revision NOT GLOB '*[^0-9]*'
    AND substr(project_alpha_revision,1,1)<>'0' AND (length(project_alpha_revision)<19 OR project_alpha_revision<='9223372036854775807')),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256=lower(projection_sha256) AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  authorization_generation TEXT NOT NULL CHECK(length(authorization_generation) BETWEEN 1 AND 19 AND authorization_generation NOT GLOB '*[^0-9]*'
    AND (authorization_generation='0' OR substr(authorization_generation,1,1)<>'0') AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775807')),
  canonical_detail_read_json TEXT NOT NULL CHECK(length(CAST(canonical_detail_read_json AS BLOB)) BETWEEN 2 AND 65536 AND json_valid(canonical_detail_read_json)),
  canonical_detail_read_sha256 TEXT NOT NULL CHECK(length(canonical_detail_read_sha256)=64 AND canonical_detail_read_sha256=lower(canonical_detail_read_sha256) AND canonical_detail_read_sha256 NOT GLOB '*[^0-9a-f]*'),
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  organization_project_alpha_public_id TEXT,
  client_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  client_project_alpha_public_id TEXT,
  reviewer_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT CHECK(length(trim(reviewer_staff_id)) BETWEEN 1 AND 191 AND instr(reviewer_staff_id,char(0))=0),
  reviewer_access_subject TEXT NOT NULL CHECK(length(trim(reviewer_access_subject)) BETWEEN 1 AND 764 AND instr(reviewer_access_subject,char(0))=0),
  reviewer_admission_version INTEGER NOT NULL CHECK(typeof(reviewer_admission_version)='integer' AND reviewer_admission_version>=1),
  reviewer_profile_version INTEGER NOT NULL CHECK(typeof(reviewer_profile_version)='integer' AND reviewer_profile_version>=1),
  reviewer_owner_role_id TEXT NOT NULL CHECK(reviewer_owner_role_id='role-owner'),
  independent_evidence_sha256 TEXT NOT NULL CHECK(length(independent_evidence_sha256)=64 AND independent_evidence_sha256=lower(independent_evidence_sha256) AND independent_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_grant_generation INTEGER NOT NULL CHECK(typeof(project_grant_generation)='integer' AND project_grant_generation>=1),
  normalized_scopes_json TEXT NOT NULL CHECK(json_valid(normalized_scopes_json) AND json_type(normalized_scopes_json)='array'
    AND json_array_length(normalized_scopes_json)<=128 AND json(normalized_scopes_json)=normalized_scopes_json),
  reviewed_at TEXT NOT NULL CHECK(length(reviewed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at) IS reviewed_at),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at
    AND expires_at>reviewed_at AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at,'+4 hours')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((organization_record_id IS NULL)=(organization_project_alpha_public_id IS NULL)),
  CHECK((client_record_id IS NULL)=(client_project_alpha_public_id IS NULL)),
  CHECK(independent_evidence_sha256<>request_sha256 AND independent_evidence_sha256<>canonical_detail_read_sha256 AND independent_evidence_sha256<>projection_sha256),
  CHECK(organization_project_alpha_public_id IS NULL OR (length(organization_project_alpha_public_id)=32 AND organization_project_alpha_public_id=lower(organization_project_alpha_public_id) AND organization_project_alpha_public_id NOT GLOB '*[^0-9a-f]*')),
  CHECK(client_project_alpha_public_id IS NULL OR (length(client_project_alpha_public_id)=32 AND client_project_alpha_public_id=lower(client_project_alpha_public_id) AND client_project_alpha_public_id NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX project_alpha_project_adoption_review_evidence_expiry
  ON project_alpha_project_adoption_review_evidence(expires_at,review_item_id);

-- A PA identity may be re-reviewed at a later revision, but no source epoch can
-- silently associate either half of the identity with a different local ID.
CREATE TRIGGER project_alpha_project_adoption_review_evidence_identity_pinned
BEFORE INSERT ON project_alpha_project_adoption_review_evidence
WHEN EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_evidence existing
  WHERE existing.source_id=NEW.source_id AND existing.source_instance_id=NEW.source_instance_id
    AND existing.application_id=NEW.application_id AND existing.history_epoch_id=NEW.history_epoch_id
    AND (existing.external_project_id=NEW.external_project_id OR existing.project_alpha_public_id=NEW.project_alpha_public_id)
    AND NOT (existing.external_project_id=NEW.external_project_id AND existing.project_alpha_public_id=NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'project adoption review identity collision'); END;

-- The persisted detail response is the exact Project read envelope validated
-- by the private server before persistence. SQLite has no SHA-256 primitive,
-- so the immutable byte hash is retained for the transport validator while D1
-- enforces every identity, revision, hash, status and related-directory field.
CREATE TRIGGER project_alpha_project_adoption_review_evidence_detail_exact
BEFORE INSERT ON project_alpha_project_adoption_review_evidence
WHEN (SELECT count(*) FROM json_each(NEW.canonical_detail_read_json))<>9
 OR EXISTS (SELECT 1 FROM json_each(NEW.canonical_detail_read_json) member
   WHERE member.key NOT IN ('apiVersion','sourceInstanceId','applicationId','historyEpoch','requestId','replayed','accepted','resource','data'))
 OR json_extract(NEW.canonical_detail_read_json,'$.apiVersion')<>'2'
 OR json_extract(NEW.canonical_detail_read_json,'$.sourceInstanceId')<>NEW.source_instance_id
 OR json_extract(NEW.canonical_detail_read_json,'$.applicationId')<>NEW.application_id
 OR json_extract(NEW.canonical_detail_read_json,'$.historyEpoch')<>NEW.history_epoch_id
 OR json_type(NEW.canonical_detail_read_json,'$.resource')<>'object'
 OR json_extract(NEW.canonical_detail_read_json,'$.resource.type')<>'project'
 OR json_extract(NEW.canonical_detail_read_json,'$.resource.id')<>NEW.project_alpha_public_id
 OR json_extract(NEW.canonical_detail_read_json,'$.resource.revision')<>NEW.project_alpha_revision
 OR json_extract(NEW.canonical_detail_read_json,'$.resource.projectionSha256')<>NEW.projection_sha256
 OR json_type(NEW.canonical_detail_read_json,'$.data')<>'object'
 OR json_type(NEW.canonical_detail_read_json,'$.data.name')<>'text'
 OR json_extract(NEW.canonical_detail_read_json,'$.data.status') NOT IN ('not_started','active','completed','cancelled')
 OR json_type(NEW.canonical_detail_read_json,'$.data.archived') NOT IN ('true','false')
 OR (NEW.organization_project_alpha_public_id IS NULL AND json_type(NEW.canonical_detail_read_json,'$.data.organizationPublicId')<>'null')
 OR (NEW.organization_project_alpha_public_id IS NOT NULL AND json_extract(NEW.canonical_detail_read_json,'$.data.organizationPublicId')<>NEW.organization_project_alpha_public_id)
 OR (NEW.client_project_alpha_public_id IS NULL AND json_type(NEW.canonical_detail_read_json,'$.data.clientPublicId')<>'null')
 OR (NEW.client_project_alpha_public_id IS NOT NULL AND json_extract(NEW.canonical_detail_read_json,'$.data.clientPublicId')<>NEW.client_project_alpha_public_id)
BEGIN SELECT RAISE(ABORT,'project adoption review detail is not exact'); END;

-- Current authority, exact destination identity, and current directory mappings
-- are all mandatory when a server stores review evidence and again when the
-- one-time reservation is consumed. Adoption starts only from an unbound,
-- local-version-zero Project: existing heads, mappings, and in-flight work are
-- refused. A stale review remains durable evidence but cannot be used.
CREATE TRIGGER project_alpha_project_adoption_review_evidence_current
BEFORE INSERT ON project_alpha_project_adoption_review_evidence
WHEN NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_destinations destination
   WHERE destination.external_project_id=NEW.external_project_id AND destination.source_id=NEW.source_id
     AND destination.application_id=NEW.application_id AND destination.expected_source_instance_id=NEW.source_instance_id
     AND destination.expected_history_epoch_id=NEW.history_epoch_id)
 OR EXISTS (SELECT 1 FROM operations_shared_projects project WHERE project.external_project_id=NEW.external_project_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
   WHERE mapping.external_project_id=NEW.external_project_id
      OR (mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
        AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
        AND mapping.project_alpha_public_id=NEW.project_alpha_public_id))
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox
   WHERE outbox.external_project_id=NEW.external_project_id AND outbox.state IN ('pending','leased'))
 OR NOT EXISTS (SELECT 1 FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
   JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
   WHERE admission.staff_id=NEW.reviewer_staff_id AND admission.active=1 AND admission.bound_access_subject=NEW.reviewer_access_subject
     AND admission.version=NEW.reviewer_admission_version AND profile.version=NEW.reviewer_profile_version AND generation.generation=NEW.project_grant_generation)
 OR NOT EXISTS (SELECT 1 FROM staff_role_assignments owner_assignment
   WHERE owner_assignment.staff_id=NEW.reviewer_staff_id AND owner_assignment.role_id=NEW.reviewer_owner_role_id AND owner_assignment.scope='global')
 OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
   WHERE json_type(scope.value)<>'object' OR (SELECT count(*) FROM json_each(scope.value))<>3
     OR EXISTS (SELECT 1 FROM json_each(scope.value) field WHERE field.key NOT IN ('scopeKind','businessAreaId','divisionId'))
     OR json_extract(scope.value,'$.scopeKind') NOT IN ('business_area','division')
     OR json_type(scope.value,'$.businessAreaId')<>'text'
     OR (json_extract(scope.value,'$.scopeKind')='business_area' AND json_type(scope.value,'$.divisionId')<>'null')
     OR (json_extract(scope.value,'$.scopeKind')='division' AND json_type(scope.value,'$.divisionId')<>'text'))
 OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope
   WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
     WHERE grant_row.staff_id=NEW.reviewer_staff_id AND grant_row.capability='project.shared.sync' AND grant_row.effect='allow' AND grant_row.active=1
       AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=NEW.external_project_id)
         OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
         OR (grant_row.scope_kind='division' AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
 OR (json_array_length(NEW.normalized_scopes_json)=0 AND NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
   WHERE grant_row.staff_id=NEW.reviewer_staff_id AND grant_row.capability='project.shared.sync' AND grant_row.effect='allow' AND grant_row.active=1
     AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=NEW.external_project_id))))
 OR EXISTS (SELECT 1 FROM native_project_grants deny WHERE deny.staff_id=NEW.reviewer_staff_id AND deny.capability='project.shared.sync' AND deny.effect='deny' AND deny.active=1
   AND (deny.scope_kind='global' OR (deny.scope_kind='exact_project' AND deny.external_project_id=NEW.external_project_id)
     OR EXISTS (SELECT 1 FROM json_each(NEW.normalized_scopes_json) scope WHERE (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId')) OR (deny.scope_kind='division' AND deny.division_id=json_extract(scope.value,'$.divisionId')))))
 OR (NEW.organization_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_alpha_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='organization'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
     AND mapping.resource_type='organization' AND mapping.external_id=NEW.organization_record_id AND mapping.project_alpha_public_id=NEW.organization_project_alpha_public_id))
 OR (NEW.client_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_alpha_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='client'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
     AND mapping.resource_type='client' AND mapping.external_id=NEW.client_record_id AND mapping.project_alpha_public_id=NEW.client_project_alpha_public_id))
 OR (NEW.organization_record_id IS NOT NULL AND NEW.client_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
   WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
BEGIN SELECT RAISE(ABORT,'project adoption review requires current authority and directory mappings'); END;
CREATE TRIGGER project_alpha_project_adoption_review_evidence_no_update BEFORE UPDATE ON project_alpha_project_adoption_review_evidence
BEGIN SELECT RAISE(ABORT,'project adoption review evidence is immutable'); END;
CREATE TRIGGER project_alpha_project_adoption_review_evidence_no_delete BEFORE DELETE ON project_alpha_project_adoption_review_evidence
BEGIN SELECT RAISE(ABORT,'project adoption review evidence is durable'); END;

CREATE TABLE project_alpha_project_adoption_review_reservations (
  reservation_id TEXT NOT NULL PRIMARY KEY CHECK(length(reservation_id)=36 AND reservation_id=lower(reservation_id)
    AND reservation_id NOT GLOB '*[^0-9a-f-]*' AND substr(reservation_id,9,1)='-' AND substr(reservation_id,14,1)='-'
    AND substr(reservation_id,15,1)='4' AND substr(reservation_id,19,1)='-' AND substr(reservation_id,20,1) IN ('8','9','a','b')
    AND substr(reservation_id,24,1)='-' AND length(replace(reservation_id,'-',''))=32),
  review_item_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_adoption_review_evidence(review_item_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36 AND idempotency_key=lower(idempotency_key) AND idempotency_key NOT GLOB '*[^0-9a-f-]*'
    AND substr(idempotency_key,9,1)='-' AND substr(idempotency_key,14,1)='-' AND substr(idempotency_key,15,1)='4' AND substr(idempotency_key,19,1)='-'
    AND substr(idempotency_key,20,1) IN ('8','9','a','b') AND substr(idempotency_key,24,1)='-' AND length(replace(idempotency_key,'-',''))=32),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256) AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, application_id TEXT NOT NULL, history_epoch_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL, project_alpha_public_id TEXT NOT NULL, project_alpha_revision TEXT NOT NULL,
  projection_sha256 TEXT NOT NULL, authorization_generation TEXT NOT NULL, canonical_detail_read_sha256 TEXT NOT NULL,
  organization_record_id TEXT, organization_project_alpha_public_id TEXT, client_record_id TEXT, client_project_alpha_public_id TEXT,
  reviewer_staff_id TEXT NOT NULL, reviewer_access_subject TEXT NOT NULL, reviewer_admission_version INTEGER NOT NULL,
  reviewer_profile_version INTEGER NOT NULL, reviewer_owner_role_id TEXT NOT NULL, independent_evidence_sha256 TEXT NOT NULL,
  project_grant_generation INTEGER NOT NULL, normalized_scopes_json TEXT NOT NULL,
  reserved_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(reserved_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',reserved_at) IS reserved_at)
);
CREATE TRIGGER project_alpha_project_adoption_review_reservations_exact
BEFORE INSERT ON project_alpha_project_adoption_review_reservations
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_evidence review
  WHERE review.review_item_id=NEW.review_item_id AND review.request_sha256=NEW.request_sha256
    AND review.source_id=NEW.source_id AND review.source_instance_id=NEW.source_instance_id AND review.application_id=NEW.application_id AND review.history_epoch_id=NEW.history_epoch_id
    AND review.external_project_id=NEW.external_project_id AND review.project_alpha_public_id=NEW.project_alpha_public_id AND review.project_alpha_revision=NEW.project_alpha_revision
    AND review.projection_sha256=NEW.projection_sha256 AND review.authorization_generation=NEW.authorization_generation AND review.canonical_detail_read_sha256=NEW.canonical_detail_read_sha256
    AND review.organization_record_id IS NEW.organization_record_id AND review.organization_project_alpha_public_id IS NEW.organization_project_alpha_public_id
    AND review.client_record_id IS NEW.client_record_id AND review.client_project_alpha_public_id IS NEW.client_project_alpha_public_id
    AND review.reviewer_staff_id=NEW.reviewer_staff_id AND review.reviewer_access_subject=NEW.reviewer_access_subject
    AND review.reviewer_admission_version=NEW.reviewer_admission_version AND review.reviewer_profile_version=NEW.reviewer_profile_version
    AND review.reviewer_owner_role_id=NEW.reviewer_owner_role_id AND review.independent_evidence_sha256=NEW.independent_evidence_sha256
    AND review.project_grant_generation=NEW.project_grant_generation AND json(review.normalized_scopes_json)=json(NEW.normalized_scopes_json)
    AND review.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_destinations destination
   WHERE destination.external_project_id=NEW.external_project_id AND destination.source_id=NEW.source_id
     AND destination.application_id=NEW.application_id AND destination.expected_source_instance_id=NEW.source_instance_id
     AND destination.expected_history_epoch_id=NEW.history_epoch_id)
 OR EXISTS (SELECT 1 FROM operations_shared_projects project WHERE project.external_project_id=NEW.external_project_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
   WHERE mapping.external_project_id=NEW.external_project_id
      OR (mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
        AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
        AND mapping.project_alpha_public_id=NEW.project_alpha_public_id))
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox
   WHERE outbox.external_project_id=NEW.external_project_id AND outbox.state IN ('pending','leased'))
 OR NOT EXISTS (SELECT 1 FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
   WHERE admission.staff_id=NEW.reviewer_staff_id AND admission.active=1 AND admission.bound_access_subject=NEW.reviewer_access_subject AND admission.version=NEW.reviewer_admission_version
     AND profile.version=NEW.reviewer_profile_version AND generation.generation=NEW.project_grant_generation)
 OR NOT EXISTS (SELECT 1 FROM staff_role_assignments owner_assignment
   WHERE owner_assignment.staff_id=NEW.reviewer_staff_id AND owner_assignment.role_id=NEW.reviewer_owner_role_id AND owner_assignment.scope='global')
 OR (NEW.organization_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_alpha_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='organization'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.resource_type='organization'
     AND mapping.external_id=NEW.organization_record_id AND mapping.project_alpha_public_id=NEW.organization_project_alpha_public_id))
 OR (NEW.client_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_alpha_directory_mappings mapping JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='client'
   WHERE mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.resource_type='client'
     AND mapping.external_id=NEW.client_record_id AND mapping.project_alpha_public_id=NEW.client_project_alpha_public_id))
 OR (NEW.organization_record_id IS NOT NULL AND NEW.client_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
BEGIN SELECT RAISE(ABORT,'project adoption review reservation is not current and exact'); END;
CREATE TRIGGER project_alpha_project_adoption_review_reservations_no_update BEFORE UPDATE ON project_alpha_project_adoption_review_reservations
BEGIN SELECT RAISE(ABORT,'project adoption review reservations are immutable'); END;
CREATE TRIGGER project_alpha_project_adoption_review_reservations_no_delete BEFORE DELETE ON project_alpha_project_adoption_review_reservations
BEGIN SELECT RAISE(ABORT,'project adoption review reservations are durable'); END;
