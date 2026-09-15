PRAGMA foreign_keys = ON;

-- A native owner epoch is an independent native UUID, never a PA history epoch.
-- Claims are append-only audit candidates, not proof that a PA reviewer or a
-- native owner service authorized activation. A privileged D1 writer can still
-- invent attestations, so no public reader may infer authority from this table.
CREATE TABLE project_alpha_acquired_native_owner_claims (
  claim_id TEXT NOT NULL PRIMARY KEY CHECK(length(claim_id)=36 AND claim_id=lower(claim_id)
    AND claim_id NOT GLOB '*[^0-9a-f-]*' AND substr(claim_id,9,1)='-'
    AND substr(claim_id,14,1)='-' AND substr(claim_id,15,1)='4'
    AND substr(claim_id,19,1)='-' AND substr(claim_id,20,1) IN ('8','9','a','b')
    AND substr(claim_id,24,1)='-' AND length(replace(claim_id,'-',''))=32),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_acquired_canonical_mappings(receipt_id) ON DELETE RESTRICT,
  native_owner_epoch_id TEXT NOT NULL CHECK(length(native_owner_epoch_id)=36 AND native_owner_epoch_id=lower(native_owner_epoch_id)
    AND native_owner_epoch_id NOT GLOB '*[^0-9a-f-]*' AND substr(native_owner_epoch_id,9,1)='-'
    AND substr(native_owner_epoch_id,14,1)='-' AND substr(native_owner_epoch_id,15,1)='4'
    AND substr(native_owner_epoch_id,19,1)='-' AND substr(native_owner_epoch_id,20,1) IN ('8','9','a','b')
    AND substr(native_owner_epoch_id,24,1)='-' AND length(replace(native_owner_epoch_id,'-',''))=32),
  record_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL,
  expected_local_record_version INTEGER NOT NULL CHECK(typeof(expected_local_record_version)='integer' AND expected_local_record_version>=1),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) BETWEEN 1 AND 191),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(native_owner_epoch_id<>history_epoch_id),
  UNIQUE(native_owner_epoch_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,record_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,external_id),
  UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id)
);
CREATE TRIGGER project_alpha_acquired_native_owner_claims_exact BEFORE INSERT ON project_alpha_acquired_native_owner_claims
WHEN NOT EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
  JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts receipt ON receipt.receipt_id=mapping.receipt_id
  JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.command_id=receipt.command_id
  JOIN project_alpha_existing_directory_binding_review_evidence review ON review.receipt_id=command.review_receipt_id
  JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=command.command_id
  JOIN operations_directory_records record ON record.record_id=mapping.record_id
  WHERE mapping.receipt_id=NEW.receipt_id AND mapping.record_id=NEW.record_id AND mapping.source_id=NEW.source_id
    AND mapping.source_instance_id=NEW.source_instance_id AND mapping.application_id=NEW.application_id
    AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.resource_type=NEW.resource_type
    AND mapping.external_id=NEW.external_id AND mapping.project_alpha_public_id=NEW.project_alpha_public_id
    AND mapping.activation_state='inactive' AND mapping.native_owner_epoch_id IS NULL
    AND review.reviewed_local_record_version=NEW.expected_local_record_version
    AND record.record_kind=NEW.resource_type AND record.current_version=NEW.expected_local_record_version
    AND receipt.record_id=NEW.record_id AND receipt.source_id=NEW.source_id
    AND receipt.source_instance_id=NEW.source_instance_id AND receipt.application_id=NEW.application_id
    AND receipt.history_epoch_id=NEW.history_epoch_id AND receipt.resource_type=NEW.resource_type
    AND receipt.external_id=NEW.external_id AND receipt.project_alpha_public_id=NEW.project_alpha_public_id
    AND command.record_id=NEW.record_id AND command.source_id=NEW.source_id
    AND command.source_instance_id=NEW.source_instance_id AND command.application_id=NEW.application_id
    AND command.history_epoch_id=NEW.history_epoch_id AND command.resource_type=NEW.resource_type
    AND command.external_id=NEW.external_id AND command.project_alpha_public_id=NEW.project_alpha_public_id
    AND response.source_instance_id=NEW.source_instance_id AND response.application_id=NEW.application_id
    AND response.history_epoch_id=NEW.history_epoch_id AND response.resource_type=NEW.resource_type
    AND response.external_id=NEW.external_id AND response.project_alpha_public_id=NEW.project_alpha_public_id
    AND response.project_alpha_revision=receipt.project_alpha_revision
    AND EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_events event
      WHERE event.command_id=command.command_id AND event.state='acknowledged'))
BEGIN SELECT RAISE(ABORT,'native owner claim requires current exact acquired chain'); END;
CREATE TRIGGER project_alpha_acquired_native_owner_claims_legacy BEFORE INSERT ON project_alpha_acquired_native_owner_claims
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_mappings legacy
  WHERE legacy.source_id=NEW.source_id AND legacy.source_instance_id=NEW.source_instance_id
    AND legacy.application_id=NEW.application_id AND legacy.resource_type=NEW.resource_type
    AND (legacy.external_id=NEW.external_id OR legacy.project_alpha_public_id=NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'native owner claim collides with legacy mapping'); END;
CREATE TRIGGER project_alpha_acquired_native_owner_claims_no_update BEFORE UPDATE ON project_alpha_acquired_native_owner_claims
BEGIN SELECT RAISE(ABORT,'native owner claim is immutable'); END;
CREATE TRIGGER project_alpha_acquired_native_owner_claims_no_delete BEFORE DELETE ON project_alpha_acquired_native_owner_claims
BEGIN SELECT RAISE(ABORT,'native owner claim is durable'); END;

-- Explicit state separate from both immutable mapping and owner claim. There
-- is intentionally no active value or transition until external authority is
-- implemented, audited, and released. A caller must resolve an uncertain
-- INSERT by reading the exact receipt/claim; duplicate INSERTs fail closed.
CREATE TABLE project_alpha_acquired_mapping_activation (
  receipt_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_acquired_native_owner_claims(receipt_id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'inactive' CHECK(state='inactive'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_acquired_mapping_activation_no_update BEFORE UPDATE ON project_alpha_acquired_mapping_activation
BEGIN SELECT RAISE(ABORT,'acquired activation requires future authenticated workflow'); END;
CREATE TRIGGER project_alpha_acquired_mapping_activation_no_delete BEFORE DELETE ON project_alpha_acquired_mapping_activation
BEGIN SELECT RAISE(ABORT,'acquired activation state is durable'); END;

-- 0054/0065 legacy inserts must also see acquired reservations, including
-- populated old rows whose history_epoch_id remains NULL.
CREATE TRIGGER project_alpha_directory_mappings_acquired_collision BEFORE INSERT ON project_alpha_directory_mappings
WHEN EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings acquired
  WHERE acquired.source_id=NEW.source_id AND acquired.source_instance_id=NEW.source_instance_id
    AND acquired.application_id=NEW.application_id AND acquired.resource_type=NEW.resource_type
    AND (acquired.external_id=NEW.external_id OR acquired.project_alpha_public_id=NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'legacy mapping collides with acquired reservation'); END;

-- 0116's uniqueness is history-epoch scoped. A changed PA history is not a
-- license to attach the same native record or PA identity to another owner.
CREATE TRIGGER project_alpha_acquired_canonical_mappings_native_identity_collision
BEFORE INSERT ON project_alpha_acquired_canonical_mappings
WHEN EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings existing
  WHERE existing.source_id=NEW.source_id AND existing.source_instance_id=NEW.source_instance_id
    AND existing.application_id=NEW.application_id AND existing.resource_type=NEW.resource_type
    AND (existing.record_id=NEW.record_id OR existing.external_id=NEW.external_id
      OR existing.project_alpha_public_id=NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'acquired native identity requires explicit epoch reconciliation'); END;
