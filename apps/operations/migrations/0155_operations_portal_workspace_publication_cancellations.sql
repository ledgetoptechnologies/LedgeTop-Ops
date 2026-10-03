PRAGMA foreign_keys=ON;

-- Data-only evidence that the exact Client publication was durably cancelled.
-- This creates no principal, enrollment, grant, entitlement, membership, route,
-- or folder authority. It depends only on the 0153 publication outbox.
CREATE TABLE operations_portal_workspace_publication_cancellation_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_publication_outbox(operation_id) ON DELETE RESTRICT,
  publication_id TEXT NOT NULL UNIQUE,
  operation_fingerprint TEXT NOT NULL UNIQUE CHECK(length(operation_fingerprint)=64
    AND operation_fingerprint NOT GLOB '*[^0-9a-f]*'),
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  source_sequence INTEGER NOT NULL CHECK(source_sequence=resulting_revision),
  snapshot_id TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT NOT NULL UNIQUE,
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64
    AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  client_cancelled_at TEXT NOT NULL CHECK(length(client_cancelled_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',client_cancelled_at) IS client_cancelled_at),
  client_replayed INTEGER NOT NULL CHECK(client_replayed IN (0,1)),
  cancelled_claim_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_workspace_publication_cancellation_audit (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_publication_cancellation_receipts(operation_id)
    ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action='workspace.snapshot.cancelled'),
  operation_fingerprint TEXT NOT NULL UNIQUE,
  cancelled_claim_token TEXT NOT NULL,
  client_cancelled_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_workspace_publication_cancellation_receipt_guard
BEFORE INSERT ON operations_portal_workspace_publication_cancellation_receipts
WHEN EXISTS(SELECT 1 FROM operations_portal_workspace_publication_receipts receipt
      WHERE receipt.operation_id=NEW.operation_id OR receipt.publication_id=NEW.publication_id
        OR receipt.operation_fingerprint=NEW.operation_fingerprint OR receipt.snapshot_id=NEW.snapshot_id)
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_outbox outbox
    JOIN operations_portal_workspace_publication_commands command ON command.operation_id=outbox.operation_id
    WHERE outbox.operation_id=NEW.operation_id AND outbox.state='dispatching' AND outbox.remote_attempted=1
      AND outbox.claim_token IS NOT NULL AND outbox.claim_token=NEW.cancelled_claim_token
      AND command.publication_id=NEW.publication_id
      AND command.operation_fingerprint=NEW.operation_fingerprint
      AND command.target_id=NEW.target_id AND command.target_revision=NEW.target_revision
      AND command.client_authority_id=NEW.client_authority_id AND command.workspace_id=NEW.workspace_id
      AND command.root_kind=NEW.root_kind AND command.root_record_id=NEW.root_record_id
      AND command.expected_revision=NEW.expected_revision AND command.resulting_revision=NEW.resulting_revision
      AND command.source_sequence=NEW.source_sequence AND command.snapshot_id=NEW.snapshot_id
      AND command.checkpoint_id=NEW.checkpoint_id AND command.snapshot_sha256=NEW.snapshot_sha256)
BEGIN SELECT RAISE(ABORT,'publication cancellation receipt is not exact'); END;

CREATE TRIGGER operations_portal_workspace_publication_cancellation_audit_guard
BEFORE INSERT ON operations_portal_workspace_publication_cancellation_audit
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_cancellation_receipts receipt
    JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=receipt.operation_id
    WHERE receipt.operation_id=NEW.operation_id AND NEW.action='workspace.snapshot.cancelled'
      AND receipt.operation_fingerprint=NEW.operation_fingerprint
      AND receipt.cancelled_claim_token=NEW.cancelled_claim_token
      AND receipt.client_cancelled_at=NEW.client_cancelled_at
      AND outbox.state='dispatching' AND outbox.remote_attempted=1
      AND outbox.claim_token=NEW.cancelled_claim_token)
BEGIN SELECT RAISE(ABORT,'publication cancellation audit is not exact'); END;

-- A normal acknowledgement and a cancellation receipt are mutually exclusive,
-- including raw writes that reuse any immutable publication identity.
CREATE TRIGGER operations_portal_workspace_publication_receipt_cancellation_guard
BEFORE INSERT ON operations_portal_workspace_publication_receipts
WHEN EXISTS(SELECT 1 FROM operations_portal_workspace_publication_cancellation_receipts cancellation
  WHERE cancellation.operation_id=NEW.operation_id OR cancellation.publication_id=NEW.publication_id
    OR cancellation.operation_fingerprint=NEW.operation_fingerprint OR cancellation.snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT,'publication operation has an exact terminal cancellation'); END;

CREATE TRIGGER operations_portal_workspace_publication_cancellation_receipt_no_update
BEFORE UPDATE ON operations_portal_workspace_publication_cancellation_receipts
BEGIN SELECT RAISE(ABORT,'publication cancellation receipts are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_cancellation_receipt_no_delete
BEFORE DELETE ON operations_portal_workspace_publication_cancellation_receipts
BEGIN SELECT RAISE(ABORT,'publication cancellation receipts are durable'); END;
CREATE TRIGGER operations_portal_workspace_publication_cancellation_audit_no_update
BEFORE UPDATE ON operations_portal_workspace_publication_cancellation_audit
BEGIN SELECT RAISE(ABORT,'publication cancellation audit is immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_cancellation_audit_no_delete
BEFORE DELETE ON operations_portal_workspace_publication_cancellation_audit
BEGIN SELECT RAISE(ABORT,'publication cancellation audit is durable'); END;

-- Preserve the frozen 0153 transition policy exactly and add one terminal path:
-- an attempted dispatch may become dead only after the current claim has stored
-- the exact Client cancellation receipt and its immutable audit row.
DROP TRIGGER operations_portal_workspace_publication_outbox_transition_guard;
CREATE TRIGGER operations_portal_workspace_publication_outbox_transition_guard BEFORE UPDATE OF state
ON operations_portal_workspace_publication_outbox
WHEN NOT ((OLD.state IN ('pending','retry') AND NEW.state='dispatching'
      AND OLD.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (OLD.remote_attempted=1 OR (EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
        WHERE current.checkpoint_id=OLD.checkpoint_id)
        AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
          WHERE live.operation_id=OLD.operation_id))))
  OR (OLD.state='dispatching' AND NEW.state='dispatching' AND OLD.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR (OLD.state='dispatching' AND NEW.state IN ('retry','acknowledged'))
  OR (OLD.state='dispatching' AND OLD.remote_attempted=0 AND NEW.state='dead')
  OR (OLD.state='dispatching' AND OLD.remote_attempted=1 AND NEW.state='dead'
      AND NEW.remote_attempted=1 AND NEW.attempt_count=OLD.attempt_count
      AND NEW.last_error_code='client-cancelled' AND OLD.claim_token IS NOT NULL
      AND NEW.claim_token IS NULL AND NEW.claim_until IS NULL
      AND NEW.acknowledged_claim_token IS OLD.acknowledged_claim_token
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_cancellation_receipts cancellation
        JOIN operations_portal_workspace_publication_cancellation_audit audit
          ON audit.operation_id=cancellation.operation_id
        WHERE cancellation.operation_id=OLD.operation_id
          AND cancellation.cancelled_claim_token=OLD.claim_token
          AND audit.cancelled_claim_token=OLD.claim_token
          AND audit.operation_fingerprint=cancellation.operation_fingerprint
          AND audit.client_cancelled_at=cancellation.client_cancelled_at))
  OR (OLD.state='dispatching' AND OLD.remote_attempted=0 AND NEW.state='superseded'
      AND ((NEW.last_error_code='source-drift'
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
            WHERE current.checkpoint_id=OLD.checkpoint_id))
        OR (NEW.last_error_code='authority-not-current'
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
            WHERE live.operation_id=OLD.operation_id))))
  OR (OLD.state IN ('pending','retry') AND OLD.remote_attempted=0 AND NEW.state='superseded'
      AND ((NEW.last_error_code='source-drift'
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_current_checkpoints current
            WHERE current.checkpoint_id=OLD.checkpoint_id))
        OR (NEW.last_error_code='authority-not-current'
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_live_commands live
            WHERE live.operation_id=OLD.operation_id)))))
BEGIN SELECT RAISE(ABORT,'publication outbox transition denied'); END;
