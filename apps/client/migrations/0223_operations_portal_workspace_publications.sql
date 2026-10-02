PRAGMA foreign_keys=ON;

CREATE TABLE operations_portal_workspace_publication_commands (
  operation_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64),
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  snapshot_id TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  canonical_publication_json TEXT NOT NULL CHECK(json_valid(canonical_publication_json))
    CHECK(length(CAST(canonical_publication_json AS BLOB))<=1900000),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_workspace_publication_command_json_guard
BEFORE INSERT ON operations_portal_workspace_publication_commands
WHEN json_type(NEW.canonical_publication_json) IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json))<>11
  OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json) WHERE key NOT IN
    ('protocol','protocolVersion','action','publicationId','operationId','expectedRevision','resultingRevision',
      'target','snapshot','actorProof','observedAt'))
  OR json_extract(NEW.canonical_publication_json,'$.protocol') IS NOT 'operations-portal-workspace-publication'
  OR json_type(NEW.canonical_publication_json,'$.protocolVersion') IS NOT 'integer'
  OR json_extract(NEW.canonical_publication_json,'$.protocolVersion') IS NOT 1
  OR json_extract(NEW.canonical_publication_json,'$.action') IS NOT 'publish'
  OR json_extract(NEW.canonical_publication_json,'$.publicationId') IS NOT NEW.publication_id
  OR json_extract(NEW.canonical_publication_json,'$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.canonical_publication_json,'$.expectedRevision') IS NOT CAST(NEW.expected_revision AS TEXT)
  OR json_extract(NEW.canonical_publication_json,'$.resultingRevision') IS NOT CAST(NEW.resulting_revision AS TEXT)
  OR json_extract(NEW.canonical_publication_json,'$.observedAt') IS NOT NEW.observed_at
  OR strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.canonical_publication_json,'$.observedAt')) IS NOT NEW.observed_at
  OR json_type(NEW.canonical_publication_json,'$.target') IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.target'))<>6
  OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.target') WHERE key NOT IN
    ('targetId','targetRevision','clientAuthorityId','workspaceId','rootKind','rootRecordId'))
  OR json_extract(NEW.canonical_publication_json,'$.target.targetId') IS NOT NEW.target_id
  OR json_extract(NEW.canonical_publication_json,'$.target.targetRevision') IS NOT CAST(NEW.target_revision AS TEXT)
  OR json_extract(NEW.canonical_publication_json,'$.target.clientAuthorityId') IS NOT NEW.client_authority_id
  OR json_extract(NEW.canonical_publication_json,'$.target.workspaceId') IS NOT NEW.workspace_id
  OR json_extract(NEW.canonical_publication_json,'$.target.rootKind') IS NOT NEW.root_kind
  OR json_extract(NEW.canonical_publication_json,'$.target.rootRecordId') IS NOT NEW.root_record_id
  OR json_type(NEW.canonical_publication_json,'$.snapshot') IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.snapshot'))<>11
  OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot') WHERE key NOT IN
    ('snapshotId','checkpointId','sourceSequence','complete','counts','snapshotSha256','directoryRecords','projects',
      'folderReservations','recipientAuthorityHeads','deliveryAuthorityHeads'))
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.snapshotId') IS NOT NEW.snapshot_id
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.checkpointId') IS NOT NEW.checkpoint_id
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.sourceSequence') IS NOT CAST(NEW.source_sequence AS TEXT)
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.snapshotSha256') IS NOT NEW.snapshot_sha256
  OR json_type(NEW.canonical_publication_json,'$.snapshot.complete') IS NOT 'true'
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.complete') IS NOT 1
  OR json_type(NEW.canonical_publication_json,'$.snapshot.counts') IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.snapshot.counts'))<>5
  OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.counts') WHERE key NOT IN
    ('directoryRecords','projects','folderReservations','recipientAuthorityHeads','deliveryAuthorityHeads'))
  OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.counts') WHERE type IS NOT 'integer' OR value<0)
  OR json_type(NEW.canonical_publication_json,'$.snapshot.directoryRecords') IS NOT 'array'
  OR json_type(NEW.canonical_publication_json,'$.snapshot.projects') IS NOT 'array'
  OR json_type(NEW.canonical_publication_json,'$.snapshot.folderReservations') IS NOT 'array'
  OR json_type(NEW.canonical_publication_json,'$.snapshot.recipientAuthorityHeads') IS NOT 'array'
  OR json_type(NEW.canonical_publication_json,'$.snapshot.deliveryAuthorityHeads') IS NOT 'array'
  OR json_array_length(NEW.canonical_publication_json,'$.snapshot.directoryRecords')<1
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.directoryRecords') IS NOT
    json_array_length(NEW.canonical_publication_json,'$.snapshot.directoryRecords')
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.projects') IS NOT
    json_array_length(NEW.canonical_publication_json,'$.snapshot.projects')
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.folderReservations') IS NOT
    json_array_length(NEW.canonical_publication_json,'$.snapshot.folderReservations')
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.recipientAuthorityHeads') IS NOT
    json_array_length(NEW.canonical_publication_json,'$.snapshot.recipientAuthorityHeads')
  OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.deliveryAuthorityHeads') IS NOT
    json_array_length(NEW.canonical_publication_json,'$.snapshot.deliveryAuthorityHeads')
  OR json_type(NEW.canonical_publication_json,'$.actorProof') IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.actorProof'))<>6
  OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.actorProof') WHERE key NOT IN
    ('staffId','verifiedAccessSubject','admissionVersion','profileVersion','grantGeneration','verifiedUntil'))
  OR json_type(NEW.canonical_publication_json,'$.actorProof.staffId') IS NOT 'text'
  OR length(json_extract(NEW.canonical_publication_json,'$.actorProof.staffId'))<1
  OR json_type(NEW.canonical_publication_json,'$.actorProof.verifiedAccessSubject') IS NOT 'text'
  OR length(json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedAccessSubject'))<1
  OR json_type(NEW.canonical_publication_json,'$.actorProof.admissionVersion') IS NOT 'text'
  OR json_extract(NEW.canonical_publication_json,'$.actorProof.admissionVersion') NOT GLOB '[1-9]*'
  OR json_extract(NEW.canonical_publication_json,'$.actorProof.admissionVersion') GLOB '*[^0-9]*'
  OR json_type(NEW.canonical_publication_json,'$.actorProof.profileVersion') IS NOT 'text'
  OR json_extract(NEW.canonical_publication_json,'$.actorProof.profileVersion') NOT GLOB '[1-9]*'
  OR json_extract(NEW.canonical_publication_json,'$.actorProof.profileVersion') GLOB '*[^0-9]*'
  OR json_type(NEW.canonical_publication_json,'$.actorProof.grantGeneration') IS NOT 'text'
  OR json_extract(NEW.canonical_publication_json,'$.actorProof.grantGeneration') NOT GLOB '[1-9]*'
  OR json_extract(NEW.canonical_publication_json,'$.actorProof.grantGeneration') GLOB '*[^0-9]*'
  OR json_type(NEW.canonical_publication_json,'$.actorProof.verifiedUntil') IS NOT 'text'
  OR strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedUntil')) IS NOT
    json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedUntil')
  OR julianday(json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedUntil'))<=julianday(NEW.observed_at)
BEGIN SELECT RAISE(ABORT,'publication command canonical JSON does not match its exact row'); END;

CREATE TABLE operations_portal_workspace_publication_heads (
  target_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>=1),
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL UNIQUE,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  snapshot_id TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_receipts(operation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(target_id,revision)
);

CREATE TABLE operations_portal_workspace_publication_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  checkpoint_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)) CHECK(length(CAST(snapshot_json AS BLOB))<=1900000),
  directory_record_count INTEGER NOT NULL CHECK(directory_record_count>=1),
  project_count INTEGER NOT NULL CHECK(project_count>=0),
  folder_reservation_count INTEGER NOT NULL CHECK(folder_reservation_count>=0),
  recipient_authority_head_count INTEGER NOT NULL CHECK(recipient_authority_head_count>=0),
  delivery_authority_head_count INTEGER NOT NULL CHECK(delivery_authority_head_count>=0),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_commands(operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(target_id,source_sequence),
  CHECK(revision>=1)
);

CREATE TABLE operations_portal_workspace_publication_history (
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  snapshot_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_snapshots(snapshot_id) ON DELETE RESTRICT,
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_commands(operation_id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(target_id,revision),
  UNIQUE(target_id,source_sequence)
);

CREATE TRIGGER operations_portal_workspace_publication_history_head_guard
BEFORE INSERT ON operations_portal_workspace_publication_history
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_heads head
  WHERE head.target_id=NEW.target_id AND head.revision=NEW.revision
    AND head.source_sequence=NEW.source_sequence AND head.snapshot_id=NEW.snapshot_id
    AND head.snapshot_sha256=NEW.snapshot_sha256 AND head.latest_operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'publication history requires the exact committed head'); END;

CREATE TABLE operations_portal_workspace_publication_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_publication_commands(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64),
  publication_id TEXT NOT NULL UNIQUE,
  target_id TEXT NOT NULL,
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision>=1),
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  snapshot_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_workspace_publication_snapshots(snapshot_id) ON DELETE RESTRICT,
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(target_id,resulting_revision) REFERENCES operations_portal_workspace_publication_history(target_id,revision) ON DELETE RESTRICT
);

CREATE TRIGGER operations_portal_workspace_publication_head_insert_guard
BEFORE INSERT ON operations_portal_workspace_publication_heads
WHEN NEW.revision<>1
BEGIN SELECT RAISE(ABORT,'initial publication head revision must be one'); END;

CREATE TRIGGER operations_portal_workspace_publication_head_insert_command_guard
BEFORE INSERT ON operations_portal_workspace_publication_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_commands command
  WHERE command.operation_id=NEW.latest_operation_id AND command.target_id=NEW.target_id
    AND command.target_revision=NEW.target_revision AND command.client_authority_id=NEW.client_authority_id
    AND command.workspace_id=NEW.workspace_id AND command.root_kind=NEW.root_kind
    AND command.root_record_id=NEW.root_record_id AND command.expected_revision=0
    AND command.resulting_revision=NEW.revision AND command.source_sequence=NEW.source_sequence
    AND command.snapshot_id=NEW.snapshot_id AND command.checkpoint_id=NEW.checkpoint_id
    AND command.snapshot_sha256=NEW.snapshot_sha256)
BEGIN SELECT RAISE(ABORT,'initial publication head must match its exact command'); END;

CREATE TRIGGER operations_portal_workspace_publication_snapshot_command_guard
BEFORE INSERT ON operations_portal_workspace_publication_snapshots
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_commands command
  WHERE command.operation_id=NEW.operation_id AND command.target_id=NEW.target_id
    AND command.resulting_revision=NEW.revision AND command.snapshot_id=NEW.snapshot_id
    AND command.checkpoint_id=NEW.checkpoint_id AND command.source_sequence=NEW.source_sequence
    AND command.snapshot_sha256=NEW.snapshot_sha256
    AND json_extract(command.canonical_publication_json,'$.snapshot.snapshotId')=NEW.snapshot_id
    AND json_extract(command.canonical_publication_json,'$.snapshot.checkpointId')=NEW.checkpoint_id
    AND CAST(json_extract(command.canonical_publication_json,'$.snapshot.sourceSequence') AS INTEGER)=NEW.source_sequence
    AND json_extract(command.canonical_publication_json,'$.snapshot.snapshotSha256')=NEW.snapshot_sha256
    AND NEW.snapshot_json IS json_extract(command.canonical_publication_json,'$.snapshot')
    AND json_extract(NEW.snapshot_json,'$.snapshotId')=NEW.snapshot_id
    AND json_extract(NEW.snapshot_json,'$.checkpointId')=NEW.checkpoint_id
    AND CAST(json_extract(NEW.snapshot_json,'$.sourceSequence') AS INTEGER)=NEW.source_sequence
    AND json_extract(NEW.snapshot_json,'$.snapshotSha256')=NEW.snapshot_sha256
    AND json_extract(NEW.snapshot_json,'$.complete')=1
    AND json_array_length(json_extract(NEW.snapshot_json,'$.directoryRecords'))=NEW.directory_record_count
    AND json_array_length(json_extract(NEW.snapshot_json,'$.projects'))=NEW.project_count
    AND json_array_length(json_extract(NEW.snapshot_json,'$.folderReservations'))=NEW.folder_reservation_count
    AND json_array_length(json_extract(NEW.snapshot_json,'$.recipientAuthorityHeads'))=NEW.recipient_authority_head_count
    AND json_array_length(json_extract(NEW.snapshot_json,'$.deliveryAuthorityHeads'))=NEW.delivery_authority_head_count)
BEGIN SELECT RAISE(ABORT,'publication snapshot does not match its canonical command'); END;

CREATE TRIGGER operations_portal_workspace_publication_receipt_chain_guard
BEFORE INSERT ON operations_portal_workspace_publication_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_commands command
  JOIN operations_portal_workspace_publication_heads head ON head.target_id=command.target_id
    AND head.revision=command.resulting_revision AND head.latest_operation_id=command.operation_id
  JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.operation_id=command.operation_id
    AND snapshot.target_id=command.target_id AND snapshot.revision=command.resulting_revision
  JOIN operations_portal_workspace_publication_history history ON history.operation_id=command.operation_id
    AND history.target_id=command.target_id AND history.revision=command.resulting_revision
  WHERE command.operation_id=NEW.operation_id AND command.request_fingerprint=NEW.request_fingerprint
    AND command.publication_id=NEW.publication_id AND command.target_id=NEW.target_id
    AND command.resulting_revision=NEW.resulting_revision AND command.source_sequence=NEW.source_sequence
    AND command.snapshot_id=NEW.snapshot_id AND command.snapshot_sha256=NEW.snapshot_sha256
    AND head.client_authority_id=command.client_authority_id AND head.workspace_id=command.workspace_id
    AND head.root_kind=command.root_kind AND head.root_record_id=command.root_record_id
    AND head.source_sequence=NEW.source_sequence AND head.snapshot_id=NEW.snapshot_id
    AND head.checkpoint_id=command.checkpoint_id AND head.snapshot_sha256=NEW.snapshot_sha256
    AND snapshot.source_sequence=NEW.source_sequence AND snapshot.snapshot_id=NEW.snapshot_id
    AND snapshot.checkpoint_id=command.checkpoint_id AND snapshot.snapshot_sha256=NEW.snapshot_sha256
    AND history.source_sequence=NEW.source_sequence AND history.snapshot_id=NEW.snapshot_id
    AND history.snapshot_sha256=NEW.snapshot_sha256)
BEGIN SELECT RAISE(ABORT,'publication receipt does not close the exact command snapshot and head'); END;

CREATE TRIGGER operations_portal_workspace_publication_head_update_guard
BEFORE UPDATE ON operations_portal_workspace_publication_heads
WHEN NEW.target_id IS NOT OLD.target_id OR NEW.client_authority_id IS NOT OLD.client_authority_id
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.root_kind IS NOT OLD.root_kind
  OR NEW.root_record_id IS NOT OLD.root_record_id OR NEW.revision<>OLD.revision+1
  OR NEW.target_revision<>OLD.target_revision OR NEW.source_sequence<=OLD.source_sequence
  OR NEW.snapshot_id IS OLD.snapshot_id OR NEW.latest_operation_id IS OLD.latest_operation_id
BEGIN SELECT RAISE(ABORT,'operations portal workspace publication head transition is invalid'); END;

CREATE TRIGGER operations_portal_workspace_publication_head_update_command_guard
BEFORE UPDATE ON operations_portal_workspace_publication_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_commands command
  WHERE command.operation_id=NEW.latest_operation_id AND command.target_id=NEW.target_id
    AND command.target_revision=NEW.target_revision AND command.client_authority_id=NEW.client_authority_id
    AND command.workspace_id=NEW.workspace_id AND command.root_kind=NEW.root_kind
    AND command.root_record_id=NEW.root_record_id AND command.expected_revision=OLD.revision
    AND command.resulting_revision=NEW.revision AND command.source_sequence=NEW.source_sequence
    AND command.snapshot_id=NEW.snapshot_id AND command.checkpoint_id=NEW.checkpoint_id
    AND command.snapshot_sha256=NEW.snapshot_sha256)
BEGIN SELECT RAISE(ABORT,'publication head transition must match its exact command'); END;

CREATE TRIGGER operations_portal_workspace_publication_commands_immutable
BEFORE UPDATE ON operations_portal_workspace_publication_commands BEGIN SELECT RAISE(ABORT,'publication commands are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_commands_no_delete
BEFORE DELETE ON operations_portal_workspace_publication_commands BEGIN SELECT RAISE(ABORT,'publication commands cannot be deleted'); END;
CREATE TRIGGER operations_portal_workspace_publication_heads_no_delete
BEFORE DELETE ON operations_portal_workspace_publication_heads BEGIN SELECT RAISE(ABORT,'publication heads cannot be deleted'); END;
CREATE TRIGGER operations_portal_workspace_publication_snapshots_immutable
BEFORE UPDATE ON operations_portal_workspace_publication_snapshots BEGIN SELECT RAISE(ABORT,'publication snapshots are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_snapshots_no_delete
BEFORE DELETE ON operations_portal_workspace_publication_snapshots BEGIN SELECT RAISE(ABORT,'publication snapshots cannot be deleted'); END;
CREATE TRIGGER operations_portal_workspace_publication_history_immutable
BEFORE UPDATE ON operations_portal_workspace_publication_history BEGIN SELECT RAISE(ABORT,'publication history is immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_history_no_delete
BEFORE DELETE ON operations_portal_workspace_publication_history BEGIN SELECT RAISE(ABORT,'publication history cannot be deleted'); END;
CREATE TRIGGER operations_portal_workspace_publication_receipts_immutable
BEFORE UPDATE ON operations_portal_workspace_publication_receipts BEGIN SELECT RAISE(ABORT,'publication receipts are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_receipts_no_delete
BEFORE DELETE ON operations_portal_workspace_publication_receipts BEGIN SELECT RAISE(ABORT,'publication receipts cannot be deleted'); END;
