PRAGMA foreign_keys = ON;

-- A review-only presentation projection for a PA client that was explicitly
-- compared with one existing native Ops client. This table is neither a
-- canonical mapping nor an access root. Nothing in portal, account, workspace,
-- grant, Delivery, or public-link authority references it.
CREATE TABLE project_alpha_reviewed_standalone_client_displays (
  projection_id TEXT NOT NULL PRIMARY KEY CHECK(length(projection_id)=36),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_field_review_receipts(receipt_id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_directory_read_adoption_reviews(review_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type='client'),
  record_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32),
  project_alpha_revision TEXT NOT NULL,
  authorization_generation TEXT NOT NULL,
  inventory_request_id TEXT NOT NULL,
  inventory_page_sha256 TEXT NOT NULL CHECK(length(inventory_page_sha256)=64),
  profile_request_id TEXT NOT NULL CHECK(length(profile_request_id)=36),
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64),
  binding_request_id TEXT NOT NULL CHECK(length(binding_request_id)=36),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 300),
  email TEXT CHECK(email IS NULL OR length(email)<=320),
  phone TEXT CHECK(phone IS NULL OR length(phone)<=80),
  state TEXT NOT NULL DEFAULT 'display_only' CHECK(state='display_only'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id),
  UNIQUE(source_id,source_instance_id,application_id,history_epoch_id,external_id)
);

-- The audit row is the field-review seal. Materialize only when all three
-- displayed fields explicitly retain the local value (or are equal) and the
-- client was proven standalone on both sides. Adopt-PA/follow-up values are not
-- stored because raw PA profile values deliberately never enter the evidence
-- ledger.
CREATE TRIGGER project_alpha_reviewed_standalone_client_display_after_seal
AFTER INSERT ON project_alpha_directory_read_adoption_field_review_audit
BEGIN
  INSERT INTO project_alpha_reviewed_standalone_client_displays(
    projection_id,receipt_id,review_id,source_id,source_instance_id,application_id,history_epoch_id,
    resource_type,record_id,external_id,project_alpha_public_id,project_alpha_revision,
    authorization_generation,inventory_request_id,inventory_page_sha256,profile_request_id,
    profile_sha256,binding_request_id,binding_sha256,display_name,email,phone)
  SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||
      '-'||substr('89ab',1+(random() & 3),1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
    receipt.receipt_id,review.review_id,review.source_id,review.source_instance_id,review.application_id,
    review.history_epoch_id,review.resource_type,review.record_id,review.external_id,
    review.project_alpha_public_id,review.project_alpha_revision,review.authorization_generation,
    review.inventory_request_id,review.inventory_page_sha256,review.profile_request_id,
    receipt.project_alpha_profile_sha256,review.binding_request_id,review.binding_evidence_sha256,
    trim(json_extract(revision.profile_json,'$.name')),
    nullif(trim(json_extract(revision.profile_json,'$.generalEmail')),''),
    nullif(trim(json_extract(revision.profile_json,'$.generalPhone')),'')
  FROM project_alpha_directory_read_adoption_field_review_receipts receipt
  JOIN project_alpha_directory_read_adoption_reviews review ON review.review_id=receipt.review_id
  JOIN project_alpha_directory_read_adoption_claims claim ON claim.claim_id=receipt.claim_id AND claim.state='inactive'
  JOIN operations_directory_records record ON record.record_id=receipt.record_id
    AND record.record_kind='client' AND record.current_version=receipt.local_record_version
  JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
  JOIN project_alpha_api_v2_directory_observations_current observation
    ON observation.source_id=review.source_id AND observation.source_instance_id=review.source_instance_id
   AND observation.application_id=review.application_id AND observation.history_epoch_id=review.history_epoch_id
   AND observation.resource_type='client' AND observation.project_alpha_public_id=review.project_alpha_public_id
  JOIN project_alpha_api_v2_inventory_receipts inventory
    ON inventory.source_id=observation.source_id AND inventory.source_instance_id=observation.source_instance_id
   AND inventory.application_id=observation.application_id AND inventory.history_epoch_id=observation.history_epoch_id
   AND inventory.inventory_kind='directory' AND inventory.request_id=observation.request_id
  JOIN project_alpha_directory_read_adoption_field_decisions name_decision
    ON name_decision.receipt_id=receipt.receipt_id AND name_decision.field_name='name'
   AND name_decision.decision IN ('unchanged','retain_local')
  JOIN project_alpha_directory_read_adoption_field_decisions email_decision
    ON email_decision.receipt_id=receipt.receipt_id AND email_decision.field_name='email'
   AND email_decision.decision IN ('unchanged','retain_local')
  JOIN project_alpha_directory_read_adoption_field_decisions phone_decision
    ON phone_decision.receipt_id=receipt.receipt_id AND phone_decision.field_name='phone'
   AND phone_decision.decision IN ('unchanged','retain_local')
  JOIN project_alpha_directory_read_adoption_field_decisions organization_decision
    ON organization_decision.receipt_id=receipt.receipt_id AND organization_decision.field_name='organization_public_id'
   AND organization_decision.decision='unchanged'
  WHERE receipt.receipt_id=NEW.receipt_id AND receipt.resource_type='client'
    AND json_type(revision.profile_json,'$.organizationPublicId')='null'
    AND typeof(json_extract(revision.profile_json,'$.name'))='text'
    AND length(trim(json_extract(revision.profile_json,'$.name'))) BETWEEN 1 AND 300
    AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0
    AND observation.resource_revision=review.project_alpha_revision
    AND observation.binding_external_id=review.external_id AND observation.binding_status='active'
    AND observation.binding_resource_revision=observation.resource_revision
    AND inventory.authorization_generation=review.authorization_generation
    AND inventory.request_id=review.inventory_request_id AND inventory.page_sha256=review.inventory_page_sha256
    AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
      WHERE conflict.source_id=review.source_id AND conflict.inventory_kind='directory'
        AND (conflict.resource_type='source' OR (conflict.resource_type='client'
          AND (conflict.project_alpha_public_id=review.project_alpha_public_id OR conflict.external_id=review.external_id))))
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_mappings mapping
      WHERE mapping.source_id=review.source_id AND mapping.source_instance_id=review.source_instance_id
        AND mapping.application_id=review.application_id AND mapping.resource_type='client'
        AND (mapping.external_id=review.external_id OR mapping.project_alpha_public_id=review.project_alpha_public_id))
    AND NOT EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
      WHERE mapping.source_id=review.source_id AND mapping.source_instance_id=review.source_instance_id
        AND mapping.application_id=review.application_id AND mapping.resource_type='client'
        AND (mapping.record_id=review.record_id OR mapping.external_id=review.external_id
          OR mapping.project_alpha_public_id=review.project_alpha_public_id));
END;

CREATE TRIGGER project_alpha_reviewed_standalone_client_displays_no_update
BEFORE UPDATE ON project_alpha_reviewed_standalone_client_displays
BEGIN SELECT RAISE(ABORT,'reviewed standalone client display is immutable'); END;
CREATE TRIGGER project_alpha_reviewed_standalone_client_displays_no_delete
BEFORE DELETE ON project_alpha_reviewed_standalone_client_displays
BEGIN SELECT RAISE(ABORT,'reviewed standalone client display is durable'); END;

-- Add an explicit review-only index namespace. It is intentionally distinct
-- from business, portal and account roots so existing authority readers cannot
-- interpret it as a customer, workspace or Delivery account.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE client_hub_roots_next (
  source_id TEXT NOT NULL,
  root_namespace TEXT NOT NULL DEFAULT 'business' CHECK (root_namespace IN ('business','portal','account','review')),
  kind TEXT NOT NULL CHECK (kind IN ('organization','standalone_client')),
  public_id TEXT NOT NULL, pa_public_id TEXT,
  mapping_status TEXT NOT NULL DEFAULT 'missing' CHECK (mapping_status IN ('mapped','missing','invalid','ambiguous','not_applicable')),
  display_name TEXT NOT NULL, sort_name TEXT NOT NULL, status TEXT NOT NULL,
  portal_status TEXT NOT NULL DEFAULT 'not_provisioned', workspace_id TEXT, legacy_account_id TEXT,
  account_count INTEGER NOT NULL DEFAULT 0 CHECK (account_count>=0),
  project_count INTEGER NOT NULL DEFAULT 0 CHECK (project_count>=0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count>=0),
  contact_count INTEGER NOT NULL DEFAULT 0 CHECK (contact_count>=0),
  meaningful_activity_at TEXT, source_version TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')), scan_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id,root_namespace,kind,public_id),
  CHECK (((root_namespace IN ('business','review')) AND substr(source_id,1,14)='project-alpha:'
      AND length(source_id) BETWEEN 15 AND 78 AND substr(source_id,15,1) GLOB '[a-z0-9]'
      AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*')
    OR (source_id='project-alpha:primary' AND root_namespace='portal')
    OR (source_id='delivery:local' AND root_namespace='account')),
  CHECK (root_namespace<>'review' OR (kind='standalone_client' AND status='reviewed_display_only'
    AND portal_status='review_only' AND workspace_id IS NULL AND legacy_account_id IS NULL
    AND account_count=0 AND project_count=0 AND request_count=0)),
  CHECK (source_id IN ('project-alpha:primary','delivery:local') OR
    (legacy_account_id IS NULL AND account_count=0 AND project_count=0 AND request_count=0))
);
INSERT INTO client_hub_roots_next SELECT * FROM client_hub_roots;
CREATE TABLE client_hub_search_values_next (
  source_id TEXT NOT NULL,
  root_namespace TEXT NOT NULL DEFAULT 'business' CHECK (root_namespace IN ('business','portal','account','review')),
  kind TEXT NOT NULL, root_public_id TEXT NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('name','contact','email','phone','project')),
  normalized_value TEXT NOT NULL, project_id TEXT, scan_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id,root_namespace,kind,root_public_id,record_type,record_id,field),
  FOREIGN KEY (source_id,root_namespace,kind,root_public_id)
    REFERENCES client_hub_roots_next(source_id,root_namespace,kind,public_id) ON DELETE CASCADE,
  CHECK (field<>'project' OR project_id IS NOT NULL)
);
INSERT INTO client_hub_search_values_next SELECT * FROM client_hub_search_values;
DROP TABLE client_hub_search_values;
DROP TABLE client_hub_roots;
ALTER TABLE client_hub_roots_next RENAME TO client_hub_roots;
ALTER TABLE client_hub_search_values_next RENAME TO client_hub_search_values;
CREATE INDEX idx_client_hub_roots_name ON client_hub_roots(sort_name,source_id,root_namespace,kind,public_id);
CREATE INDEX idx_client_hub_roots_kind_name ON client_hub_roots(kind,sort_name,source_id,root_namespace,public_id);
CREATE INDEX idx_client_hub_roots_workspace ON client_hub_roots(source_id,workspace_id,scan_generation,status,root_namespace);
CREATE INDEX idx_client_hub_search_root ON client_hub_search_values(source_id,root_namespace,kind,root_public_id,field,normalized_value);
CREATE TRIGGER client_hub_root_insert AFTER INSERT ON client_hub_roots BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_root_delete AFTER DELETE ON client_hub_roots BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_root_change AFTER UPDATE ON client_hub_roots
WHEN OLD.source_id IS NOT NEW.source_id OR OLD.kind IS NOT NEW.kind OR OLD.public_id IS NOT NEW.public_id
  OR OLD.root_namespace IS NOT NEW.root_namespace OR OLD.pa_public_id IS NOT NEW.pa_public_id
  OR OLD.mapping_status IS NOT NEW.mapping_status OR OLD.display_name IS NOT NEW.display_name
  OR OLD.sort_name IS NOT NEW.sort_name OR OLD.status IS NOT NEW.status OR OLD.portal_status IS NOT NEW.portal_status
  OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.legacy_account_id IS NOT NEW.legacy_account_id
  OR OLD.account_count IS NOT NEW.account_count OR OLD.project_count IS NOT NEW.project_count
  OR OLD.request_count IS NOT NEW.request_count OR OLD.contact_count IS NOT NEW.contact_count
  OR OLD.meaningful_activity_at IS NOT NEW.meaningful_activity_at
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_search_insert AFTER INSERT ON client_hub_search_values BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_search_delete AFTER DELETE ON client_hub_search_values BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER client_hub_search_change AFTER UPDATE ON client_hub_search_values
WHEN OLD.source_id IS NOT NEW.source_id OR OLD.kind IS NOT NEW.kind OR OLD.root_public_id IS NOT NEW.root_public_id
  OR OLD.root_namespace IS NOT NEW.root_namespace OR OLD.record_type IS NOT NEW.record_type
  OR OLD.record_id IS NOT NEW.record_id OR OLD.field IS NOT NEW.field
  OR OLD.normalized_value IS NOT NEW.normalized_value OR OLD.project_id IS NOT NEW.project_id
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
UPDATE client_hub_directory_state SET revision=revision+1,backfill_phase=NULL,backfill_cursor=NULL,
  next_run_at=NULL,lease_token=NULL,lease_until=NULL,generation=generation+1 WHERE id='directory';
