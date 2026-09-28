PRAGMA foreign_keys = ON;

-- One immutable server-side selection may produce one 0124 review item. The
-- browser never writes this table: its idempotency key and selection are
-- accepted only by the dormant producer after fresh PA and native checks.
CREATE TABLE project_alpha_project_adoption_review_producer_receipts (
  producer_receipt_id TEXT NOT NULL PRIMARY KEY CHECK(length(producer_receipt_id)=36
    AND producer_receipt_id=lower(producer_receipt_id) AND producer_receipt_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(producer_receipt_id,9,1)='-' AND substr(producer_receipt_id,14,1)='-'
    AND substr(producer_receipt_id,15,1)='4' AND substr(producer_receipt_id,19,1)='-'
    AND substr(producer_receipt_id,20,1) IN ('8','9','a','b') AND substr(producer_receipt_id,24,1)='-'
    AND length(replace(producer_receipt_id,'-',''))=32),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36
    AND idempotency_key=lower(idempotency_key) AND idempotency_key NOT GLOB '*[^0-9a-f-]*'
    AND substr(idempotency_key,9,1)='-' AND substr(idempotency_key,14,1)='-'
    AND substr(idempotency_key,15,1)='4' AND substr(idempotency_key,19,1)='-'
    AND substr(idempotency_key,20,1) IN ('8','9','a','b') AND substr(idempotency_key,24,1)='-'
    AND length(replace(idempotency_key,'-',''))=32),
  request_sha256 TEXT NOT NULL UNIQUE CHECK(length(request_sha256)=64
    AND request_sha256=lower(request_sha256) AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  canonical_request_json TEXT NOT NULL CHECK(length(CAST(canonical_request_json AS BLOB)) BETWEEN 2 AND 16384
    AND json_valid(canonical_request_json) AND json(canonical_request_json)=canonical_request_json),
  review_item_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_adoption_review_evidence(review_item_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL,
  reviewer_staff_id TEXT NOT NULL,
  reviewer_access_subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(json_extract(canonical_request_json,'$.version')=1
    AND json_extract(canonical_request_json,'$.idempotencyKey')=idempotency_key
    AND json_extract(canonical_request_json,'$.sourceId')=source_id
    AND json_extract(canonical_request_json,'$.externalProjectId')=external_project_id
    AND json_extract(canonical_request_json,'$.projectAlphaPublicId')=project_alpha_public_id
    AND json_type(canonical_request_json,'$.reviewer')='object'
    AND json_extract(canonical_request_json,'$.reviewer.staffId')=reviewer_staff_id
    AND json_extract(canonical_request_json,'$.reviewer.accessSubject')=reviewer_access_subject)
);

CREATE TRIGGER project_alpha_project_adoption_review_producer_receipts_exact
BEFORE INSERT ON project_alpha_project_adoption_review_producer_receipts
WHEN (SELECT count(*) FROM json_each(NEW.canonical_request_json))<>6
 OR EXISTS (SELECT 1 FROM json_each(NEW.canonical_request_json) member
   WHERE member.key NOT IN ('version','idempotencyKey','sourceId','externalProjectId','projectAlphaPublicId','reviewer'))
 OR EXISTS (SELECT 1 FROM json_each(NEW.canonical_request_json) member
   GROUP BY member.key HAVING count(*)<>1)
 OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.reviewer'))<>2
 OR EXISTS (SELECT 1 FROM json_each(NEW.canonical_request_json,'$.reviewer') member
   WHERE member.key NOT IN ('staffId','accessSubject'))
 OR EXISTS (SELECT 1 FROM json_each(NEW.canonical_request_json,'$.reviewer') member
   GROUP BY member.key HAVING count(*)<>1)
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_evidence review
  WHERE review.review_item_id=NEW.review_item_id AND review.request_sha256=NEW.request_sha256
    AND review.source_id=NEW.source_id AND review.external_project_id=NEW.external_project_id
    AND review.project_alpha_public_id=NEW.project_alpha_public_id
    AND review.reviewer_staff_id=NEW.reviewer_staff_id
    AND review.reviewer_access_subject=NEW.reviewer_access_subject)
 OR EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_evidence review,
      json_each(review.normalized_scopes_json) scope
    WHERE review.review_item_id=NEW.review_item_id AND NOT EXISTS (
      SELECT 1 FROM native_directory_resource_scopes live
      WHERE live.active=1 AND live.record_id IN (review.organization_record_id,review.client_record_id)
        AND live.scope_kind=json_extract(scope.value,'$.scopeKind')
        AND live.business_area_id=json_extract(scope.value,'$.businessAreaId')
        AND live.division_id IS json_extract(scope.value,'$.divisionId')))
 OR EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_evidence review
    JOIN native_directory_resource_scopes live
      ON live.active=1 AND live.record_id IN (review.organization_record_id,review.client_record_id)
    WHERE review.review_item_id=NEW.review_item_id AND NOT EXISTS (
      SELECT 1 FROM json_each(review.normalized_scopes_json) scope
      WHERE json_extract(scope.value,'$.scopeKind')=live.scope_kind
        AND json_extract(scope.value,'$.businessAreaId')=live.business_area_id
        AND json_extract(scope.value,'$.divisionId') IS live.division_id))
 OR EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_evidence review
    JOIN native_directory_resource_scopes live
      ON live.active=1 AND live.record_id IN (review.organization_record_id,review.client_record_id)
    LEFT JOIN native_business_areas area ON area.id=live.business_area_id
    LEFT JOIN native_business_divisions division
      ON division.id=live.division_id AND division.business_area_id=live.business_area_id
    WHERE review.review_item_id=NEW.review_item_id AND (area.active IS NOT 1
      OR (live.scope_kind='division' AND division.active IS NOT 1)))
 OR EXISTS (SELECT 1 FROM project_alpha_project_adoption_review_evidence review,
      json_each(review.normalized_scopes_json) scope
    WHERE review.review_item_id=NEW.review_item_id
    GROUP BY json_extract(scope.value,'$.scopeKind'),json_extract(scope.value,'$.businessAreaId'),
      json_extract(scope.value,'$.divisionId') HAVING count(*)<>1)
BEGIN SELECT RAISE(ABORT,'project adoption review producer receipt is not exact'); END;

CREATE TRIGGER project_alpha_project_adoption_review_producer_receipts_no_update
BEFORE UPDATE ON project_alpha_project_adoption_review_producer_receipts
BEGIN SELECT RAISE(ABORT,'project adoption review producer receipt is immutable'); END;

CREATE TRIGGER project_alpha_project_adoption_review_producer_receipts_no_delete
BEFORE DELETE ON project_alpha_project_adoption_review_producer_receipts
BEGIN SELECT RAISE(ABORT,'project adoption review producer receipt is durable'); END;
