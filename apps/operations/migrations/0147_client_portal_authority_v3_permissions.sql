PRAGMA foreign_keys = ON;

-- Protocol 3 is deliberately an evolution of the one principal-revision
-- stream from 0145.  Historical v2 commands stay empty and cannot acquire a
-- permission by migration or replay.
ALTER TABLE client_portal_authority_v2_outbox ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 2;
ALTER TABLE client_portal_authority_v2_outbox ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE client_portal_authority_v2_outbox_receipts ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 2;
ALTER TABLE client_portal_authority_v2_outbox_receipts ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';

CREATE TRIGGER client_portal_authority_v2_outbox_v3_insert_guard
BEFORE INSERT ON client_portal_authority_v2_outbox
WHEN NEW.protocol_version NOT IN (2,3)
 OR NEW.permissions_json NOT IN ('[]','["operations.service_home.read"]')
 OR (NEW.protocol_version=2 AND NEW.permissions_json<>'[]')
 OR (NEW.desired_state='revoked' AND NEW.permissions_json<>'[]')
BEGIN SELECT RAISE(ABORT,'portal authority protocol permissions denied'); END;

CREATE TRIGGER client_portal_authority_v2_outbox_v3_immutable
BEFORE UPDATE ON client_portal_authority_v2_outbox
WHEN NEW.protocol_version IS NOT OLD.protocol_version OR NEW.permissions_json IS NOT OLD.permissions_json
BEGIN SELECT RAISE(ABORT,'portal authority protocol intent is immutable'); END;

CREATE TRIGGER client_portal_authority_v2_outbox_receipt_v3_guard
BEFORE INSERT ON client_portal_authority_v2_outbox_receipts
WHEN NEW.protocol_version NOT IN (2,3)
 OR NEW.permissions_json NOT IN ('[]','["operations.service_home.read"]')
 OR (NEW.protocol_version=2 AND NEW.permissions_json<>'[]')
 OR (NEW.resulting_state='revoked' AND NEW.permissions_json<>'[]')
 OR NOT EXISTS(SELECT 1 FROM client_portal_authority_v2_outbox outbox
   WHERE outbox.operation_id=NEW.operation_id
     AND outbox.protocol_version=NEW.protocol_version AND outbox.permissions_json=NEW.permissions_json
     AND outbox.client_authority_id=NEW.client_authority_id AND outbox.workspace_id=NEW.workspace_id
     AND outbox.issuer=NEW.issuer AND outbox.subject=NEW.subject
     AND outbox.desired_state=NEW.resulting_state)
BEGIN SELECT RAISE(ABORT,'portal authority receipt protocol intent denied'); END;
