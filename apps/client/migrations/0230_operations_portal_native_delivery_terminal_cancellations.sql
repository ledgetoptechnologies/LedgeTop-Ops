PRAGMA foreign_keys=ON;

-- Negative proof for an initial grant that never materialized. This never
-- removes an existing Client command, head, history, receipt, or replacement.
CREATE TABLE operations_portal_native_delivery_cancellations (
 operation_id TEXT PRIMARY KEY,request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
 authority_id TEXT NOT NULL UNIQUE,target_id TEXT NOT NULL,recipient_binding_id TEXT NOT NULL,folder_reservation_id TEXT NOT NULL,
 canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND length(CAST(canonical_request_json AS BLOB))<=65792),
 cancelled_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));

CREATE TRIGGER operations_native_delivery_cancellation_insert BEFORE INSERT ON operations_portal_native_delivery_cancellations
WHEN length(NEW.cancelled_at)<>24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.cancelled_at) IS NOT NEW.cancelled_at
 OR NEW.cancelled_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR json_extract(NEW.canonical_request_json,'$.command.operationId') IS NOT NEW.operation_id
 OR json_extract(NEW.canonical_request_json,'$.requestFingerprint') IS NOT NEW.request_fingerprint
 OR json_extract(NEW.canonical_request_json,'$.command.action') IS NOT 'delivery.grant'
 OR json_extract(NEW.canonical_request_json,'$.command.authority.authorityId') IS NOT NEW.authority_id
 OR json_extract(NEW.canonical_request_json,'$.command.authority.expectedRevision') IS NOT '0'
 OR json_extract(NEW.canonical_request_json,'$.command.authority.resultingRevision') IS NOT '1'
 OR json_extract(NEW.canonical_request_json,'$.command.target.targetId') IS NOT NEW.target_id
 OR json_extract(NEW.canonical_request_json,'$.command.recipient.recipientBindingId') IS NOT NEW.recipient_binding_id
 OR json_extract(NEW.canonical_request_json,'$.command.resource.folderReservationId') IS NOT NEW.folder_reservation_id
 OR json_type(NEW.canonical_request_json,'$.command.expiresAt') IS NOT 'text'
 OR julianday(json_extract(NEW.canonical_request_json,'$.command.expiresAt')) IS NULL
 OR julianday(json_extract(NEW.canonical_request_json,'$.command.expiresAt'))>=julianday('now')
 OR EXISTS(SELECT 1 FROM operations_portal_native_delivery_commands WHERE operation_id=NEW.operation_id OR authority_id=NEW.authority_id)
 OR EXISTS(SELECT 1 FROM operations_portal_native_delivery_heads WHERE authority_id=NEW.authority_id
   OR recipient_binding_id=NEW.recipient_binding_id AND folder_reservation_id=NEW.folder_reservation_id AND state='active')
 OR EXISTS(SELECT 1 FROM operations_portal_native_delivery_history WHERE operation_id=NEW.operation_id OR authority_id=NEW.authority_id)
 OR EXISTS(SELECT 1 FROM operations_portal_native_delivery_receipts WHERE operation_id=NEW.operation_id OR authority_id=NEW.authority_id)
 OR EXISTS(SELECT 1 FROM operations_portal_native_delivery_replacements WHERE new_authority_id=NEW.authority_id OR grant_operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'native delivery cancellation denied'); END;
CREATE TRIGGER operations_native_delivery_cancellation_update BEFORE UPDATE ON operations_portal_native_delivery_cancellations BEGIN SELECT RAISE(ABORT,'native delivery cancellation immutable'); END;
CREATE TRIGGER operations_native_delivery_cancellation_delete BEFORE DELETE ON operations_portal_native_delivery_cancellations BEGIN SELECT RAISE(ABORT,'native delivery cancellation immutable'); END;

CREATE TRIGGER operations_native_delivery_cancelled_command_insert BEFORE INSERT ON operations_portal_native_delivery_commands
WHEN EXISTS(SELECT 1 FROM operations_portal_native_delivery_cancellations cancellation
 WHERE cancellation.operation_id=NEW.operation_id OR cancellation.authority_id=NEW.authority_id)
BEGIN SELECT RAISE(ABORT,'native delivery command cancelled'); END;
