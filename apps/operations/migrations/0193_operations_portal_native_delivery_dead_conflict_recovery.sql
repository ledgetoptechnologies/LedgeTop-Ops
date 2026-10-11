PRAGMA foreign_keys=ON;

-- A terminal Client conflict may be retried only by the explicit audited
-- recovery path. Ordinary dispatch never selects dead rows.
DROP TRIGGER operations_portal_native_delivery_recovery_command_guard;
CREATE TRIGGER operations_portal_native_delivery_recovery_command_guard BEFORE INSERT
ON operations_portal_native_delivery_recovery_invocations
WHEN NEW.state<>'authorized' OR NEW.claim_token IS NOT NULL OR NEW.claimed_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_commands command
   JOIN operations_portal_native_delivery_authorizations original ON original.operation_id=command.operation_id
   JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
   JOIN operations_portal_native_delivery_authority_heads head ON head.authority_id=command.authority_id
   WHERE command.operation_id=NEW.operation_id AND command.command_sha256=NEW.command_sha256
     AND command.operation_fingerprint=NEW.operation_fingerprint AND command.action=NEW.command_action
     AND command.authority_id=NEW.authority_id AND command.expected_revision=NEW.expected_revision
     AND command.resulting_revision=NEW.resulting_revision AND command.target_id=NEW.target_id
     AND command.root_record_id=NEW.root_record_id AND command.ops_division_id=NEW.ops_division_id
     AND outbox.request_fingerprint=command.command_sha256 AND outbox.canonical_wire_json=command.canonical_command_json
     AND (outbox.state IN ('pending','retry') OR (outbox.state='dispatching'
       AND outbox.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       OR (command.action='delivery.grant' AND outbox.state='dead' AND outbox.last_error_code='conflict'
         AND outbox.claim_token IS NULL AND outbox.claim_until IS NULL AND outbox.acknowledged_claim_token IS NULL
         AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_receipts receipt
           WHERE receipt.operation_id=outbox.operation_id)))
     AND head.latest_operation_id=command.operation_id AND head.revision=command.resulting_revision
     AND head.state=CASE command.action WHEN 'delivery.grant' THEN 'active' ELSE 'revoked' END)
BEGIN SELECT RAISE(ABORT,'native delivery recovery command denied'); END;
