PRAGMA foreign_keys=ON;

-- Separate recipient-folder authority. Neither topology nor service-home grants files.
CREATE TABLE operations_portal_native_delivery_commands (
  operation_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64),
  action TEXT NOT NULL CHECK(action IN ('delivery.grant','delivery.revoke')),
  authority_id TEXT NOT NULL, recipient_binding_id TEXT NOT NULL, folder_reservation_id TEXT NOT NULL,
  target_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json))
    CHECK(length(CAST(canonical_command_json AS BLOB))<=65536),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE operations_portal_native_delivery_heads (
  authority_id TEXT PRIMARY KEY, recipient_binding_id TEXT NOT NULL, folder_reservation_id TEXT NOT NULL,
  target_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_delivery_receipts(operation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(recipient_binding_id,folder_reservation_id)
);
CREATE TABLE operations_portal_native_delivery_history (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_commands(operation_id) ON DELETE RESTRICT,
  authority_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  request_fingerprint TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE operations_portal_native_delivery_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_history(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL UNIQUE, action TEXT NOT NULL, authority_id TEXT NOT NULL,
  recipient_binding_id TEXT NOT NULL, folder_reservation_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_native_delivery_command_shape BEFORE INSERT ON operations_portal_native_delivery_commands
WHEN json_type(NEW.canonical_command_json) IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json))<>14
  OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_command_json) WHERE key NOT IN
    ('protocol','protocolVersion','permissionSchemaVersion','action','operationId','authority','target','recipient','publication','resource','features','expiresAt','reasonCode','observedAt'))
  OR json_extract(NEW.canonical_command_json,'$.protocol') IS NOT 'operations-portal-native-delivery-authority'
  OR json_extract(NEW.canonical_command_json,'$.protocolVersion') IS NOT 1
  OR json_extract(NEW.canonical_command_json,'$.permissionSchemaVersion') IS NOT 3
  OR json_extract(NEW.canonical_command_json,'$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.canonical_command_json,'$.action') IS NOT NEW.action
  OR json_extract(NEW.canonical_command_json,'$.authority.authorityId') IS NOT NEW.authority_id
  OR json_extract(NEW.canonical_command_json,'$.authority.expectedRevision') IS NOT CAST(NEW.expected_revision AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.authority.resultingRevision') IS NOT CAST(NEW.resulting_revision AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.target.targetId') IS NOT NEW.target_id
  OR json_extract(NEW.canonical_command_json,'$.recipient.recipientBindingId') IS NOT NEW.recipient_binding_id
  OR json_extract(NEW.canonical_command_json,'$.resource.folderReservationId') IS NOT NEW.folder_reservation_id
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.authority'))<>3
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.target'))<>6
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.recipient'))<>9
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.publication'))<>6
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.resource'))<>12
  OR json_type(NEW.canonical_command_json,'$.features') IS NOT 'array'
  OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_command_json,'$.features') WHERE type IS NOT 'text'
    OR value NOT IN ('folder.list','file.metadata','file.preview','file.download'))
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.features'))<>
    (SELECT count(DISTINCT value) FROM json_each(NEW.canonical_command_json,'$.features'))
  OR (NEW.action='delivery.revoke' AND (json_type(NEW.canonical_command_json,'$.expiresAt') IS NOT 'null'
    OR json_array_length(NEW.canonical_command_json,'$.features')<>0))
  OR (NEW.action='delivery.grant' AND (json_array_length(NEW.canonical_command_json,'$.features')<1
    OR json_type(NEW.canonical_command_json,'$.expiresAt') IS NOT 'text'
    OR julianday(json_extract(NEW.canonical_command_json,'$.expiresAt')) IS NULL
    OR julianday(json_extract(NEW.canonical_command_json,'$.expiresAt'))<=julianday('now')
    OR julianday(json_extract(NEW.canonical_command_json,'$.expiresAt'))>julianday('now')+30))
BEGIN SELECT RAISE(ABORT,'native delivery command shape mismatch'); END;

CREATE TRIGGER operations_native_delivery_command_cas BEFORE INSERT ON operations_portal_native_delivery_commands
WHEN (NEW.expected_revision=0 AND (NEW.action<>'delivery.grant' OR EXISTS(
    SELECT 1 FROM operations_portal_native_delivery_heads WHERE authority_id=NEW.authority_id
      OR (recipient_binding_id=NEW.recipient_binding_id AND folder_reservation_id=NEW.folder_reservation_id))))
  OR (NEW.expected_revision>0 AND NOT EXISTS(
    SELECT 1 FROM operations_portal_native_delivery_heads head
    JOIN operations_portal_native_delivery_commands prior ON prior.operation_id=head.latest_operation_id
    WHERE head.authority_id=NEW.authority_id AND head.recipient_binding_id=NEW.recipient_binding_id
      AND head.folder_reservation_id=NEW.folder_reservation_id AND head.target_id=NEW.target_id
      AND head.revision=NEW.expected_revision AND head.state='active'
      AND json_extract(prior.canonical_command_json,'$.target')=json_extract(NEW.canonical_command_json,'$.target')
      AND json_extract(prior.canonical_command_json,'$.recipient')=json_extract(NEW.canonical_command_json,'$.recipient')
      AND (NEW.action='delivery.grant' OR (
        json_extract(prior.canonical_command_json,'$.publication')=json_extract(NEW.canonical_command_json,'$.publication')
        AND json_extract(prior.canonical_command_json,'$.resource')=json_extract(NEW.canonical_command_json,'$.resource')))))
BEGIN SELECT RAISE(ABORT,'native delivery CAS or immutable identity mismatch'); END;

-- This view proves local recipient/home/publication authority only. Live Ops
-- physical-folder proof is still mandatory before index/R2 access and handoff.
CREATE VIEW operations_portal_native_delivery_locally_authorized_commands AS
SELECT command.operation_id FROM operations_portal_native_delivery_commands command
JOIN operations_portal_native_recipient_authority_heads recipient
  ON recipient.recipient_binding_id=command.recipient_binding_id AND recipient.target_id=command.target_id
JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
JOIN operations_portal_native_authority_receipts home_receipt ON home_receipt.operation_id=recipient.latest_operation_id
JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=command.target_id
JOIN operations_portal_workspace_publication_receipts publication_receipt ON publication_receipt.operation_id=publication.latest_operation_id
JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.operation_id=publication.latest_operation_id
WHERE command.action='delivery.grant' AND recipient.state='active' AND workspace.state='active'
  AND recipient.permissions_json='["operations.service_home.read"]'
  AND recipient.ownership_epoch=workspace.ownership_epoch
  AND home_receipt.state='active' AND home_receipt.action='recipient.grant'
  AND home_receipt.target_id=recipient.target_id AND home_receipt.recipient_binding_id=recipient.recipient_binding_id
  AND home_receipt.ownership_epoch=recipient.ownership_epoch AND home_receipt.grant_revision=recipient.grant_revision
  AND recipient.enrollment_intent_id=json_extract(command.canonical_command_json,'$.recipient.enrollmentIntentId')
  AND recipient.target_client_record_id=json_extract(command.canonical_command_json,'$.recipient.targetClientRecordId')
  AND recipient.issuer=json_extract(command.canonical_command_json,'$.recipient.issuer')
  AND recipient.subject=json_extract(command.canonical_command_json,'$.recipient.subject')
  AND CAST(recipient.ownership_epoch AS TEXT)=json_extract(command.canonical_command_json,'$.recipient.homeOwnershipEpoch')
  AND CAST(recipient.grant_revision AS TEXT)=json_extract(command.canonical_command_json,'$.recipient.homeGrantRevision')
  AND recipient.latest_operation_id=json_extract(command.canonical_command_json,'$.recipient.homeGrantOperationId')
  AND home_receipt.request_fingerprint=json_extract(command.canonical_command_json,'$.recipient.homeRequestFingerprint')
  AND workspace.client_authority_id=json_extract(command.canonical_command_json,'$.target.clientAuthorityId')
  AND workspace.workspace_id=json_extract(command.canonical_command_json,'$.target.workspaceId')
  AND workspace.root_kind=json_extract(command.canonical_command_json,'$.target.rootKind')
  AND workspace.root_record_id=json_extract(command.canonical_command_json,'$.target.rootRecordId')
  AND CAST(workspace.target_revision AS TEXT)=json_extract(command.canonical_command_json,'$.target.targetRevision')
  AND publication.target_revision=workspace.target_revision AND publication.client_authority_id=workspace.client_authority_id
  AND publication.workspace_id=workspace.workspace_id AND publication.root_kind=workspace.root_kind AND publication.root_record_id=workspace.root_record_id
  AND publication.latest_operation_id=json_extract(command.canonical_command_json,'$.publication.operationId')
  AND publication_receipt.publication_id=json_extract(command.canonical_command_json,'$.publication.publicationId')
  AND CAST(publication.revision AS TEXT)=json_extract(command.canonical_command_json,'$.publication.revision')
  AND CAST(publication.source_sequence AS TEXT)=json_extract(command.canonical_command_json,'$.publication.sourceSequence')
  AND publication.snapshot_id=json_extract(command.canonical_command_json,'$.publication.snapshotId')
  AND publication.snapshot_sha256=json_extract(command.canonical_command_json,'$.publication.snapshotSha256')
  AND publication_receipt.target_id=publication.target_id AND publication_receipt.resulting_revision=publication.revision
  AND publication_receipt.source_sequence=publication.source_sequence AND publication_receipt.snapshot_id=publication.snapshot_id
  AND publication_receipt.snapshot_sha256=publication.snapshot_sha256 AND snapshot.target_id=publication.target_id
  AND snapshot.snapshot_sha256=publication.snapshot_sha256
  AND julianday(json_extract(command.canonical_command_json,'$.expiresAt'))>julianday('now')
  AND (recipient.expires_at IS NULL OR json_extract(command.canonical_command_json,'$.expiresAt')<=recipient.expires_at)
  AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot_json,'$.folderReservations') folder
    WHERE json_extract(folder.value,'$.reservationId')=command.folder_reservation_id
      AND json_extract(folder.value,'$.state')='active'
      AND json_extract(folder.value,'$.bindingVersion')=json_extract(command.canonical_command_json,'$.resource.folderReservationRevision')
      AND json_extract(folder.value,'$.clientFolderBindingId')=json_extract(command.canonical_command_json,'$.resource.clientFolderBindingId')
      AND json_extract(folder.value,'$.externalProjectId')=json_extract(command.canonical_command_json,'$.resource.externalProjectId')
      AND json_extract(folder.value,'$.opsFolderProjectId')=json_extract(command.canonical_command_json,'$.resource.opsFolderProjectId')
      AND json_extract(folder.value,'$.divisionId')=json_extract(command.canonical_command_json,'$.resource.opsDivisionId')
      AND json_extract(folder.value,'$.r2Prefix')=json_extract(command.canonical_command_json,'$.resource.selectedR2Prefix'))
  AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot_json,'$.projects') project
    WHERE json_extract(project.value,'$.externalProjectId')=json_extract(command.canonical_command_json,'$.resource.externalProjectId')
      AND json_extract(project.value,'$.version')=json_extract(command.canonical_command_json,'$.resource.projectVersion')
      AND json_extract(project.value,'$.published')=1);

-- Only this current-head view is eligible for the reader's additional live
-- Ops authorization proof; an old command or an isolated insert is not access.
CREATE VIEW operations_portal_native_delivery_live_heads AS
SELECT head.authority_id,head.recipient_binding_id,head.folder_reservation_id,head.target_id,
  head.revision,head.latest_operation_id,command.request_fingerprint,command.canonical_command_json
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

CREATE TRIGGER operations_native_delivery_head_insert BEFORE INSERT ON operations_portal_native_delivery_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_commands command
  JOIN operations_portal_native_delivery_locally_authorized_commands authorized ON authorized.operation_id=command.operation_id
  WHERE command.operation_id=NEW.latest_operation_id AND command.authority_id=NEW.authority_id
    AND command.recipient_binding_id=NEW.recipient_binding_id AND command.folder_reservation_id=NEW.folder_reservation_id
    AND command.target_id=NEW.target_id AND command.expected_revision=0 AND command.resulting_revision=NEW.revision
    AND NEW.revision=1 AND NEW.state='active')
BEGIN SELECT RAISE(ABORT,'native delivery head requires exact authorized grant'); END;
CREATE TRIGGER operations_native_delivery_head_update BEFORE UPDATE ON operations_portal_native_delivery_heads
WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.recipient_binding_id IS NOT OLD.recipient_binding_id
  OR NEW.folder_reservation_id IS NOT OLD.folder_reservation_id OR NEW.target_id IS NOT OLD.target_id
  OR OLD.state<>'active' OR NEW.revision<>OLD.revision+1 OR NOT EXISTS(
    SELECT 1 FROM operations_portal_native_delivery_commands command WHERE command.operation_id=NEW.latest_operation_id
      AND command.authority_id=OLD.authority_id AND command.expected_revision=OLD.revision AND command.resulting_revision=NEW.revision
      AND command.recipient_binding_id=OLD.recipient_binding_id AND command.folder_reservation_id=OLD.folder_reservation_id
      AND command.target_id=OLD.target_id
      AND ((command.action='delivery.revoke' AND NEW.state='revoked') OR (command.action='delivery.grant' AND NEW.state='active'
        AND EXISTS(SELECT 1 FROM operations_portal_native_delivery_locally_authorized_commands WHERE operation_id=command.operation_id))))
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

CREATE TRIGGER operations_native_delivery_command_update BEFORE UPDATE ON operations_portal_native_delivery_commands BEGIN SELECT RAISE(ABORT,'native delivery command immutable'); END;
CREATE TRIGGER operations_native_delivery_command_delete BEFORE DELETE ON operations_portal_native_delivery_commands BEGIN SELECT RAISE(ABORT,'native delivery command immutable'); END;
CREATE TRIGGER operations_native_delivery_head_delete BEFORE DELETE ON operations_portal_native_delivery_heads BEGIN SELECT RAISE(ABORT,'native delivery head retained'); END;
CREATE TRIGGER operations_native_delivery_history_update BEFORE UPDATE ON operations_portal_native_delivery_history BEGIN SELECT RAISE(ABORT,'native delivery history immutable'); END;
CREATE TRIGGER operations_native_delivery_history_delete BEFORE DELETE ON operations_portal_native_delivery_history BEGIN SELECT RAISE(ABORT,'native delivery history immutable'); END;
CREATE TRIGGER operations_native_delivery_receipt_update BEFORE UPDATE ON operations_portal_native_delivery_receipts BEGIN SELECT RAISE(ABORT,'native delivery receipt immutable'); END;
CREATE TRIGGER operations_native_delivery_receipt_delete BEFORE DELETE ON operations_portal_native_delivery_receipts BEGIN SELECT RAISE(ABORT,'native delivery receipt immutable'); END;
