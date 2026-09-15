PRAGMA foreign_keys = ON;

-- Separate prospective canonical state. No current reader uses this table and
-- every row is inactive; a later migration and explicit release are required
-- before any acquired receipt may participate in mapping resolution.
CREATE TABLE project_alpha_acquired_canonical_mappings (
  receipt_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('organization','client')),
  external_id TEXT NOT NULL,
  project_alpha_public_id TEXT NOT NULL,
  -- No native ownership epoch is established by a PA history epoch. NULL is
  -- mandatory until a later native-owner ledger can supply and fence it.
  native_owner_epoch_id TEXT CHECK(native_owner_epoch_id IS NULL),
  activation_state TEXT NOT NULL DEFAULT 'inactive' CHECK(activation_state='inactive'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_id,source_instance_id,application_id,history_epoch_id,resource_type,record_id),
  UNIQUE(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id),
  UNIQUE(source_id,source_instance_id,application_id,history_epoch_id,resource_type,project_alpha_public_id)
);

CREATE TRIGGER project_alpha_acquired_canonical_mappings_receipt_guard
BEFORE INSERT ON project_alpha_acquired_canonical_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_existing_directory_binding_acquired_mapping_receipts receipt
  JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.command_id=receipt.command_id
  JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=command.command_id
  JOIN project_alpha_existing_directory_binding_review_evidence review ON review.receipt_id=command.review_receipt_id
  JOIN operations_directory_records record ON record.record_id=review.record_id
  WHERE receipt.receipt_id=NEW.receipt_id AND receipt.record_id=NEW.record_id
    AND receipt.source_id=NEW.source_id AND receipt.source_instance_id=NEW.source_instance_id
    AND receipt.application_id=NEW.application_id AND receipt.history_epoch_id=NEW.history_epoch_id
    AND receipt.resource_type=NEW.resource_type AND receipt.external_id=NEW.external_id
    AND receipt.project_alpha_public_id=NEW.project_alpha_public_id
    AND review.reviewed_local_record_version IS NOT NULL
    AND record.record_kind=receipt.resource_type
    AND record.current_version=review.reviewed_local_record_version
    AND response.source_instance_id=receipt.source_instance_id AND response.application_id=receipt.application_id
    AND response.history_epoch_id=receipt.history_epoch_id AND response.resource_type=receipt.resource_type
    AND response.external_id=receipt.external_id AND response.project_alpha_public_id=receipt.project_alpha_public_id
    AND response.project_alpha_revision=receipt.project_alpha_revision
    AND EXISTS (SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_events event
      WHERE event.command_id=command.command_id AND event.state='acknowledged')
)
BEGIN SELECT RAISE(ABORT,'acquired canonical mapping requires current exact receipt chain'); END;

-- 0054's nullable legacy history epoch is not a namespace escape. Any legacy
-- external or public overlap is ambiguous even when the pair matches exactly.
CREATE TRIGGER project_alpha_acquired_canonical_mappings_legacy_collision
BEFORE INSERT ON project_alpha_acquired_canonical_mappings
WHEN EXISTS (SELECT 1 FROM project_alpha_directory_mappings legacy
  WHERE legacy.source_id=NEW.source_id AND legacy.source_instance_id=NEW.source_instance_id
    AND legacy.application_id=NEW.application_id AND legacy.resource_type=NEW.resource_type
    AND (legacy.external_id=NEW.external_id OR legacy.project_alpha_public_id=NEW.project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'acquired canonical mapping collides with legacy mapping'); END;

CREATE TRIGGER project_alpha_acquired_canonical_mappings_no_update
BEFORE UPDATE ON project_alpha_acquired_canonical_mappings
BEGIN SELECT RAISE(ABORT,'acquired canonical mapping is immutable'); END;
CREATE TRIGGER project_alpha_acquired_canonical_mappings_no_delete
BEFORE DELETE ON project_alpha_acquired_canonical_mappings
BEGIN SELECT RAISE(ABORT,'acquired canonical mapping is durable'); END;
