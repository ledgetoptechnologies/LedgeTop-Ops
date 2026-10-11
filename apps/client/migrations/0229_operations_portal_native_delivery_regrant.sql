PRAGMA foreign_keys=ON;

DROP TRIGGER operations_native_delivery_command_cas;
DROP TRIGGER operations_native_delivery_head_insert;
DROP TRIGGER operations_native_delivery_head_update;
DROP TRIGGER operations_native_delivery_history_insert;
DROP TRIGGER operations_native_delivery_receipt_insert;
DROP TRIGGER operations_native_delivery_head_delete;
DROP TRIGGER operations_portal_native_content_start_insert_guard;
DROP VIEW operations_portal_native_delivery_live_heads;
DROP VIEW operations_portal_native_delivery_locally_authorized_commands;

-- Retain every authority lineage while allowing only one active authority per pair.
CREATE TABLE operations_portal_native_delivery_heads_next (
 authority_id TEXT PRIMARY KEY,recipient_binding_id TEXT NOT NULL,folder_reservation_id TEXT NOT NULL,
 target_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),state TEXT NOT NULL CHECK(state IN ('active','revoked')),
 latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_delivery_receipts(operation_id)
   ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
INSERT INTO operations_portal_native_delivery_heads_next SELECT * FROM operations_portal_native_delivery_heads;
DROP TABLE operations_portal_native_delivery_heads;
ALTER TABLE operations_portal_native_delivery_heads_next RENAME TO operations_portal_native_delivery_heads;
CREATE UNIQUE INDEX operations_native_delivery_one_active_pair
 ON operations_portal_native_delivery_heads(recipient_binding_id,folder_reservation_id) WHERE state='active';

CREATE VIEW operations_portal_native_delivery_locally_authorized_commands AS
SELECT command.operation_id FROM operations_portal_native_delivery_commands command
JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.recipient_binding_id=command.recipient_binding_id AND recipient.target_id=command.target_id
JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
JOIN operations_portal_native_authority_receipts home_receipt ON home_receipt.operation_id=recipient.latest_operation_id
JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=command.target_id
JOIN operations_portal_workspace_publication_receipts publication_receipt ON publication_receipt.operation_id=publication.latest_operation_id
JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.operation_id=publication.latest_operation_id
WHERE command.action='delivery.grant' AND recipient.state='active' AND workspace.state='active'
 AND recipient.permissions_json='["operations.service_home.read"]' AND recipient.ownership_epoch=workspace.ownership_epoch
 AND home_receipt.state='active' AND home_receipt.action='recipient.grant' AND home_receipt.target_id=recipient.target_id
 AND home_receipt.recipient_binding_id=recipient.recipient_binding_id AND home_receipt.ownership_epoch=recipient.ownership_epoch
 AND home_receipt.grant_revision=recipient.grant_revision
 AND recipient.enrollment_intent_id=json_extract(command.canonical_command_json,'$.recipient.enrollmentIntentId')
 AND recipient.target_client_record_id=json_extract(command.canonical_command_json,'$.recipient.targetClientRecordId')
 AND recipient.issuer=json_extract(command.canonical_command_json,'$.recipient.issuer') AND recipient.subject=json_extract(command.canonical_command_json,'$.recipient.subject')
 AND CAST(recipient.ownership_epoch AS TEXT)=json_extract(command.canonical_command_json,'$.recipient.homeOwnershipEpoch')
 AND CAST(recipient.grant_revision AS TEXT)=json_extract(command.canonical_command_json,'$.recipient.homeGrantRevision')
 AND recipient.latest_operation_id=json_extract(command.canonical_command_json,'$.recipient.homeGrantOperationId')
 AND home_receipt.request_fingerprint=json_extract(command.canonical_command_json,'$.recipient.homeRequestFingerprint')
 AND workspace.client_authority_id=json_extract(command.canonical_command_json,'$.target.clientAuthorityId')
 AND workspace.workspace_id=json_extract(command.canonical_command_json,'$.target.workspaceId')
 AND workspace.root_kind=json_extract(command.canonical_command_json,'$.target.rootKind') AND workspace.root_record_id=json_extract(command.canonical_command_json,'$.target.rootRecordId')
 AND CAST(workspace.target_revision AS TEXT)=json_extract(command.canonical_command_json,'$.target.targetRevision')
 AND publication.target_revision=workspace.target_revision AND publication.client_authority_id=workspace.client_authority_id
 AND publication.workspace_id=workspace.workspace_id AND publication.root_kind=workspace.root_kind AND publication.root_record_id=workspace.root_record_id
 AND publication.latest_operation_id=json_extract(command.canonical_command_json,'$.publication.operationId')
 AND publication_receipt.publication_id=json_extract(command.canonical_command_json,'$.publication.publicationId')
 AND CAST(publication.revision AS TEXT)=json_extract(command.canonical_command_json,'$.publication.revision')
 AND CAST(publication.source_sequence AS TEXT)=json_extract(command.canonical_command_json,'$.publication.sourceSequence')
 AND publication.snapshot_id=json_extract(command.canonical_command_json,'$.publication.snapshotId') AND publication.snapshot_sha256=json_extract(command.canonical_command_json,'$.publication.snapshotSha256')
 AND publication_receipt.target_id=publication.target_id AND publication_receipt.resulting_revision=publication.revision
 AND publication_receipt.source_sequence=publication.source_sequence AND publication_receipt.snapshot_id=publication.snapshot_id
 AND publication_receipt.snapshot_sha256=publication.snapshot_sha256 AND snapshot.target_id=publication.target_id AND snapshot.snapshot_sha256=publication.snapshot_sha256
 AND julianday(json_extract(command.canonical_command_json,'$.expiresAt'))>julianday('now')
 AND (recipient.expires_at IS NULL OR json_extract(command.canonical_command_json,'$.expiresAt')<=recipient.expires_at)
 AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot_json,'$.folderReservations') folder
  WHERE json_extract(folder.value,'$.reservationId')=command.folder_reservation_id AND json_extract(folder.value,'$.state')='active'
   AND json_extract(folder.value,'$.bindingVersion')=json_extract(command.canonical_command_json,'$.resource.folderReservationRevision')
   AND json_extract(folder.value,'$.clientFolderBindingId')=json_extract(command.canonical_command_json,'$.resource.clientFolderBindingId')
   AND json_extract(folder.value,'$.externalProjectId')=json_extract(command.canonical_command_json,'$.resource.externalProjectId')
   AND json_extract(folder.value,'$.opsFolderProjectId')=json_extract(command.canonical_command_json,'$.resource.opsFolderProjectId')
   AND json_extract(folder.value,'$.divisionId')=json_extract(command.canonical_command_json,'$.resource.opsDivisionId')
   AND json_extract(folder.value,'$.r2Prefix')=json_extract(command.canonical_command_json,'$.resource.selectedR2Prefix'))
 AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot_json,'$.projects') project
  WHERE json_extract(project.value,'$.externalProjectId')=json_extract(command.canonical_command_json,'$.resource.externalProjectId')
   AND json_extract(project.value,'$.version')=json_extract(command.canonical_command_json,'$.resource.projectVersion') AND json_extract(project.value,'$.published')=1);

CREATE VIEW operations_portal_native_delivery_live_heads AS
SELECT head.authority_id,head.recipient_binding_id,head.folder_reservation_id,head.target_id,head.revision,head.latest_operation_id,command.request_fingerprint,command.canonical_command_json
FROM operations_portal_native_delivery_heads head
JOIN operations_portal_native_delivery_commands command ON command.operation_id=head.latest_operation_id
JOIN operations_portal_native_delivery_locally_authorized_commands authorized ON authorized.operation_id=command.operation_id
JOIN operations_portal_native_delivery_receipts receipt ON receipt.operation_id=command.operation_id
JOIN operations_portal_native_delivery_history history ON history.operation_id=command.operation_id
WHERE head.state='active' AND command.action='delivery.grant' AND head.authority_id=command.authority_id
 AND head.recipient_binding_id=command.recipient_binding_id AND head.folder_reservation_id=command.folder_reservation_id
 AND head.target_id=command.target_id AND head.revision=command.resulting_revision
 AND receipt.authority_id=head.authority_id AND receipt.recipient_binding_id=head.recipient_binding_id
 AND receipt.folder_reservation_id=head.folder_reservation_id AND receipt.action='delivery.grant'
 AND receipt.resulting_revision=head.revision AND receipt.resulting_state='active'
 AND receipt.request_fingerprint=command.request_fingerprint AND history.authority_id=head.authority_id
 AND history.revision=head.revision AND history.state='active' AND history.request_fingerprint=command.request_fingerprint;

CREATE TRIGGER operations_portal_native_content_start_insert_guard BEFORE INSERT ON operations_portal_native_content_start_events
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_live_heads live
 WHERE live.authority_id=NEW.authority_id AND live.revision=NEW.authority_revision
  AND live.latest_operation_id=NEW.delivery_operation_id AND live.request_fingerprint=NEW.delivery_request_fingerprint
  AND live.recipient_binding_id=NEW.recipient_binding_id AND live.target_id=NEW.target_id
  AND live.folder_reservation_id=NEW.folder_reservation_id AND json_extract(live.canonical_command_json,'$.action')='delivery.grant'
  AND json_extract(live.canonical_command_json,'$.target.workspaceId')=NEW.workspace_id
  AND CAST(json_extract(live.canonical_command_json,'$.recipient.homeOwnershipEpoch') AS INTEGER)=NEW.home_ownership_epoch
  AND CAST(json_extract(live.canonical_command_json,'$.recipient.homeGrantRevision') AS INTEGER)=NEW.home_grant_revision
  AND json_extract(live.canonical_command_json,'$.recipient.homeGrantOperationId')=NEW.home_grant_operation_id
  AND json_extract(live.canonical_command_json,'$.recipient.homeRequestFingerprint')=NEW.home_request_fingerprint
  AND json_extract(live.canonical_command_json,'$.publication.operationId')=NEW.publication_operation_id
  AND json_extract(live.canonical_command_json,'$.publication.publicationId')=NEW.publication_id
  AND CAST(json_extract(live.canonical_command_json,'$.publication.revision') AS INTEGER)=NEW.publication_revision
  AND json_extract(live.canonical_command_json,'$.publication.snapshotId')=NEW.publication_snapshot_id
  AND json_extract(live.canonical_command_json,'$.publication.snapshotSha256')=NEW.publication_snapshot_sha256
  AND CAST(json_extract(live.canonical_command_json,'$.resource.folderReservationRevision') AS INTEGER)=NEW.folder_reservation_revision
  AND json_extract(live.canonical_command_json,'$.resource.clientFolderBindingId')=NEW.client_folder_binding_id
  AND json_extract(live.canonical_command_json,'$.resource.externalProjectId')=NEW.external_project_id
  AND CAST(json_extract(live.canonical_command_json,'$.resource.projectVersion') AS INTEGER)=NEW.project_version
  AND EXISTS(SELECT 1 FROM json_each(live.canonical_command_json,'$.features') WHERE value=NEW.feature)
  AND julianday(json_extract(live.canonical_command_json,'$.expiresAt'))>julianday('now'))
BEGIN SELECT RAISE(ABORT,'native content start requires exact current delivery authority'); END;

CREATE TABLE operations_portal_native_delivery_replacements (
 new_authority_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_heads(authority_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 grant_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_delivery_receipts(operation_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 prior_authority_id TEXT NOT NULL UNIQUE,prior_revoke_operation_id TEXT NOT NULL UNIQUE
   REFERENCES operations_portal_native_delivery_receipts(operation_id) ON DELETE RESTRICT,
 recipient_binding_id TEXT NOT NULL,folder_reservation_id TEXT NOT NULL,target_id TEXT NOT NULL,
 prior_revoke_fingerprint TEXT NOT NULL CHECK(length(prior_revoke_fingerprint)=64
   AND prior_revoke_fingerprint NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));

CREATE TRIGGER operations_native_delivery_command_cas BEFORE INSERT ON operations_portal_native_delivery_commands
WHEN (NEW.expected_revision=0 AND (NEW.action<>'delivery.grant' OR EXISTS(SELECT 1
  FROM operations_portal_native_delivery_heads head WHERE head.authority_id=NEW.authority_id
    OR (head.recipient_binding_id=NEW.recipient_binding_id AND head.folder_reservation_id=NEW.folder_reservation_id AND head.state='active'))))
 OR (NEW.expected_revision>0 AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_heads head
  JOIN operations_portal_native_delivery_commands prior ON prior.operation_id=head.latest_operation_id
  WHERE head.authority_id=NEW.authority_id AND head.recipient_binding_id=NEW.recipient_binding_id
   AND head.folder_reservation_id=NEW.folder_reservation_id AND head.target_id=NEW.target_id
   AND head.revision=NEW.expected_revision AND head.state='active'
   AND json_extract(prior.canonical_command_json,'$.target')=json_extract(NEW.canonical_command_json,'$.target')
   AND json_extract(prior.canonical_command_json,'$.recipient')=json_extract(NEW.canonical_command_json,'$.recipient')
   AND (NEW.action='delivery.grant' OR (json_extract(prior.canonical_command_json,'$.publication')=json_extract(NEW.canonical_command_json,'$.publication')
    AND json_extract(prior.canonical_command_json,'$.resource')=json_extract(NEW.canonical_command_json,'$.resource')))))
BEGIN SELECT RAISE(ABORT,'native delivery CAS or immutable identity mismatch'); END;

CREATE TRIGGER operations_native_delivery_head_insert BEFORE INSERT ON operations_portal_native_delivery_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_commands command
 JOIN operations_portal_native_delivery_locally_authorized_commands authorized ON authorized.operation_id=command.operation_id
 WHERE command.operation_id=NEW.latest_operation_id AND command.authority_id=NEW.authority_id
  AND command.recipient_binding_id=NEW.recipient_binding_id AND command.folder_reservation_id=NEW.folder_reservation_id
  AND command.target_id=NEW.target_id AND command.expected_revision=0 AND command.resulting_revision=1
  AND NEW.revision=1 AND NEW.state='active')
 OR (EXISTS(SELECT 1 FROM operations_portal_native_delivery_heads prior
   WHERE prior.recipient_binding_id=NEW.recipient_binding_id AND prior.folder_reservation_id=NEW.folder_reservation_id)
  AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_replacements replacement
   WHERE replacement.new_authority_id=NEW.authority_id AND replacement.grant_operation_id=NEW.latest_operation_id
    AND replacement.recipient_binding_id=NEW.recipient_binding_id
    AND replacement.folder_reservation_id=NEW.folder_reservation_id AND replacement.target_id=NEW.target_id))
BEGIN SELECT RAISE(ABORT,'native delivery head requires exact authorized grant'); END;

CREATE TRIGGER operations_native_delivery_head_update BEFORE UPDATE ON operations_portal_native_delivery_heads
WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.recipient_binding_id IS NOT OLD.recipient_binding_id
 OR NEW.folder_reservation_id IS NOT OLD.folder_reservation_id OR NEW.target_id IS NOT OLD.target_id
 OR OLD.state<>'active' OR NEW.revision<>OLD.revision+1 OR NOT EXISTS(
  SELECT 1 FROM operations_portal_native_delivery_commands command WHERE command.operation_id=NEW.latest_operation_id
   AND command.authority_id=OLD.authority_id AND command.expected_revision=OLD.revision AND command.resulting_revision=NEW.revision
   AND command.recipient_binding_id=OLD.recipient_binding_id AND command.folder_reservation_id=OLD.folder_reservation_id
   AND command.target_id=OLD.target_id AND ((command.action='delivery.revoke' AND NEW.state='revoked')
    OR (command.action='delivery.grant' AND NEW.state='active' AND EXISTS(
     SELECT 1 FROM operations_portal_native_delivery_locally_authorized_commands WHERE operation_id=command.operation_id))))
BEGIN SELECT RAISE(ABORT,'native delivery head transition mismatch'); END;

CREATE TRIGGER operations_native_delivery_history_insert BEFORE INSERT ON operations_portal_native_delivery_history
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_commands command
 JOIN operations_portal_native_delivery_heads head ON head.latest_operation_id=command.operation_id
 WHERE command.operation_id=NEW.operation_id AND command.authority_id=NEW.authority_id
  AND command.request_fingerprint=NEW.request_fingerprint AND head.revision=NEW.revision AND head.state=NEW.state)
BEGIN SELECT RAISE(ABORT,'native delivery history mismatch'); END;
CREATE TRIGGER operations_native_delivery_receipt_insert BEFORE INSERT ON operations_portal_native_delivery_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_commands command
 JOIN operations_portal_native_delivery_heads head ON head.latest_operation_id=command.operation_id
 JOIN operations_portal_native_delivery_history history ON history.operation_id=command.operation_id
 WHERE command.operation_id=NEW.operation_id AND command.request_fingerprint=NEW.request_fingerprint
  AND command.action=NEW.action AND command.authority_id=NEW.authority_id
  AND command.recipient_binding_id=NEW.recipient_binding_id AND command.folder_reservation_id=NEW.folder_reservation_id
  AND head.revision=NEW.resulting_revision AND head.state=NEW.resulting_state
  AND history.authority_id=NEW.authority_id AND history.revision=NEW.resulting_revision
  AND history.state=NEW.resulting_state AND history.request_fingerprint=NEW.request_fingerprint)
BEGIN SELECT RAISE(ABORT,'native delivery receipt mismatch'); END;
CREATE TRIGGER operations_native_delivery_head_delete BEFORE DELETE ON operations_portal_native_delivery_heads BEGIN SELECT RAISE(ABORT,'native delivery head retained'); END;

CREATE TRIGGER operations_native_delivery_replacement_insert BEFORE INSERT ON operations_portal_native_delivery_replacements
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_commands grant_command
 JOIN operations_portal_native_delivery_heads prior ON prior.authority_id=NEW.prior_authority_id
 JOIN operations_portal_native_delivery_commands revoke_command ON revoke_command.operation_id=prior.latest_operation_id
 JOIN operations_portal_native_delivery_history revoke_history ON revoke_history.operation_id=revoke_command.operation_id
 JOIN operations_portal_native_delivery_receipts revoke_receipt ON revoke_receipt.operation_id=revoke_command.operation_id
 WHERE grant_command.operation_id=NEW.grant_operation_id AND grant_command.authority_id=NEW.new_authority_id
  AND grant_command.action='delivery.grant' AND grant_command.expected_revision=0 AND grant_command.resulting_revision=1
  AND grant_command.recipient_binding_id=NEW.recipient_binding_id AND grant_command.folder_reservation_id=NEW.folder_reservation_id
  AND grant_command.target_id=NEW.target_id AND prior.state='revoked'
  AND prior.recipient_binding_id=NEW.recipient_binding_id AND prior.folder_reservation_id=NEW.folder_reservation_id
  AND prior.target_id=NEW.target_id AND NEW.prior_revoke_operation_id=prior.latest_operation_id
  AND revoke_command.operation_id=NEW.prior_revoke_operation_id AND revoke_command.action='delivery.revoke'
  AND revoke_command.authority_id=prior.authority_id AND revoke_command.resulting_revision=prior.revision
  AND revoke_command.recipient_binding_id=NEW.recipient_binding_id
  AND revoke_command.folder_reservation_id=NEW.folder_reservation_id AND revoke_command.target_id=NEW.target_id
  AND revoke_command.request_fingerprint=NEW.prior_revoke_fingerprint
  AND revoke_history.authority_id=prior.authority_id AND revoke_history.revision=prior.revision AND revoke_history.state='revoked'
  AND revoke_receipt.action='delivery.revoke' AND revoke_receipt.authority_id=prior.authority_id
  AND revoke_receipt.recipient_binding_id=NEW.recipient_binding_id
  AND revoke_receipt.folder_reservation_id=NEW.folder_reservation_id
  AND revoke_receipt.resulting_revision=prior.revision
  AND revoke_receipt.resulting_state='revoked' AND revoke_receipt.request_fingerprint=NEW.prior_revoke_fingerprint
  AND revoke_history.request_fingerprint=NEW.prior_revoke_fingerprint
  AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_replacements used
   WHERE used.prior_authority_id=prior.authority_id OR used.prior_revoke_operation_id=prior.latest_operation_id)
  AND (SELECT count(*) FROM operations_portal_native_delivery_heads tip
   WHERE tip.recipient_binding_id=NEW.recipient_binding_id AND tip.folder_reservation_id=NEW.folder_reservation_id
    AND tip.state='revoked' AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_replacements used
     WHERE used.prior_authority_id=tip.authority_id))=1)
BEGIN SELECT RAISE(ABORT,'native delivery replacement denied'); END;
CREATE TRIGGER operations_native_delivery_replacement_grant_guard BEFORE INSERT ON operations_portal_native_delivery_replacements
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_commands grant_command
 JOIN operations_portal_native_delivery_locally_authorized_commands authorized ON authorized.operation_id=grant_command.operation_id
 WHERE grant_command.operation_id=NEW.grant_operation_id AND grant_command.authority_id=NEW.new_authority_id
  AND grant_command.action='delivery.grant' AND grant_command.expected_revision=0 AND grant_command.resulting_revision=1
  AND grant_command.recipient_binding_id=NEW.recipient_binding_id
  AND grant_command.folder_reservation_id=NEW.folder_reservation_id AND grant_command.target_id=NEW.target_id)
BEGIN SELECT RAISE(ABORT,'native delivery replacement current authority denied'); END;
CREATE TRIGGER operations_native_delivery_replacement_update BEFORE UPDATE ON operations_portal_native_delivery_replacements BEGIN SELECT RAISE(ABORT,'native delivery replacement immutable'); END;
CREATE TRIGGER operations_native_delivery_replacement_delete BEFORE DELETE ON operations_portal_native_delivery_replacements BEGIN SELECT RAISE(ABORT,'native delivery replacement immutable'); END;
