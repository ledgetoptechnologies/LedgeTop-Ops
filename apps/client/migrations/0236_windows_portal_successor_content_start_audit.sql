PRAGMA foreign_keys=ON;

-- Separate successor audit. Never widens the ordinary 0228 audit or delivery
-- live-head view. Chain proof is freshly verified through private Ops RPC by
-- the writer; this guard additionally proves the exact current local candidate.
CREATE TABLE windows_portal_successor_content_start_events (
  recorded_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 96),
  dedupe_key TEXT NOT NULL UNIQUE CHECK(length(dedupe_key)=43),
  dedupe_window INTEGER NOT NULL CHECK(dedupe_window>=0),
  action TEXT NOT NULL CHECK(action='file.download_requested'),
  feature TEXT NOT NULL CHECK(feature='file.download'),
  principal_fingerprint TEXT NOT NULL CHECK(length(principal_fingerprint)=43),
  authority_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK(authority_revision>=1),
  delivery_operation_id TEXT NOT NULL REFERENCES operations_portal_native_delivery_receipts(operation_id) ON DELETE RESTRICT,
  delivery_request_fingerprint TEXT NOT NULL CHECK(length(delivery_request_fingerprint)=64),
  recipient_binding_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  home_ownership_epoch INTEGER NOT NULL CHECK(home_ownership_epoch>=1),
  home_grant_revision INTEGER NOT NULL CHECK(home_grant_revision>=1),
  home_grant_operation_id TEXT NOT NULL,
  home_request_fingerprint TEXT NOT NULL,
  original_publication_operation_id TEXT NOT NULL,
  original_publication_id TEXT NOT NULL,
  original_publication_revision INTEGER NOT NULL CHECK(original_publication_revision>=1),
  original_publication_source_sequence INTEGER NOT NULL CHECK(original_publication_source_sequence>=1),
  original_publication_snapshot_id TEXT NOT NULL,
  original_publication_snapshot_sha256 TEXT NOT NULL,
  folder_reservation_revision INTEGER NOT NULL CHECK(folder_reservation_revision>=1),
  client_folder_binding_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL,
  project_version INTEGER NOT NULL CHECK(project_version>=1),
  folder_reservation_id TEXT NOT NULL,
  effective_publication_operation_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_receipts(operation_id) ON DELETE RESTRICT,
  effective_publication_id TEXT NOT NULL,
  effective_publication_revision INTEGER NOT NULL CHECK(effective_publication_revision>=1),
  effective_publication_source_sequence INTEGER NOT NULL CHECK(effective_publication_source_sequence>=1),
  effective_publication_snapshot_id TEXT NOT NULL,
  effective_publication_snapshot_sha256 TEXT NOT NULL CHECK(length(effective_publication_snapshot_sha256)=64),
  chain_sha256 TEXT NOT NULL CHECK(length(chain_sha256)=64 AND chain_sha256 NOT GLOB '*[^0-9a-f]*'),
  publication_count INTEGER NOT NULL CHECK(publication_count BETWEEN 1 AND 64),
  prefix_fingerprint TEXT NOT NULL CHECK(length(prefix_fingerprint)=43),
  resource_fingerprint TEXT NOT NULL CHECK(length(resource_fingerprint)=43),
  content_version_fingerprint TEXT NOT NULL CHECK(length(content_version_fingerprint)=43),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS occurred_at),
  CHECK(original_publication_revision=original_publication_source_sequence),
  CHECK(effective_publication_revision=effective_publication_source_sequence),
  CHECK(effective_publication_source_sequence>=original_publication_source_sequence
    AND publication_count=effective_publication_source_sequence-original_publication_source_sequence+1)
);
CREATE INDEX windows_portal_successor_content_start_timeline
  ON windows_portal_successor_content_start_events(authority_id,recipient_binding_id,occurred_at DESC,recorded_sequence DESC);

CREATE TRIGGER windows_portal_successor_content_start_insert_guard
BEFORE INSERT ON windows_portal_successor_content_start_events
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_successor_candidates candidate
  WHERE (candidate.authority_id=NEW.authority_id AND candidate.authority_revision=NEW.authority_revision
    AND candidate.delivery_operation_id=NEW.delivery_operation_id AND candidate.request_fingerprint=NEW.delivery_request_fingerprint
    AND candidate.recipient_binding_id=NEW.recipient_binding_id AND candidate.target_id=NEW.target_id
    AND candidate.folder_reservation_id=NEW.folder_reservation_id)
    AND (
      json_extract(candidate.canonical_command_json,'$.target.workspaceId')=NEW.workspace_id
    AND CAST(json_extract(candidate.canonical_command_json,'$.recipient.homeOwnershipEpoch') AS INTEGER)=NEW.home_ownership_epoch
    AND CAST(json_extract(candidate.canonical_command_json,'$.recipient.homeGrantRevision') AS INTEGER)=NEW.home_grant_revision
    AND json_extract(candidate.canonical_command_json,'$.recipient.homeGrantOperationId')=NEW.home_grant_operation_id
    AND json_extract(candidate.canonical_command_json,'$.recipient.homeRequestFingerprint')=NEW.home_request_fingerprint
    AND json_extract(candidate.canonical_command_json,'$.publication.operationId')=NEW.original_publication_operation_id
    AND json_extract(candidate.canonical_command_json,'$.publication.publicationId')=NEW.original_publication_id
    AND CAST(json_extract(candidate.canonical_command_json,'$.publication.revision') AS INTEGER)=NEW.original_publication_revision
    AND CAST(json_extract(candidate.canonical_command_json,'$.publication.sourceSequence') AS INTEGER)=NEW.original_publication_source_sequence
    AND json_extract(candidate.canonical_command_json,'$.publication.snapshotId')=NEW.original_publication_snapshot_id
    AND json_extract(candidate.canonical_command_json,'$.publication.snapshotSha256')=NEW.original_publication_snapshot_sha256
    AND CAST(json_extract(candidate.canonical_command_json,'$.resource.folderReservationRevision') AS INTEGER)=NEW.folder_reservation_revision
    AND json_extract(candidate.canonical_command_json,'$.resource.clientFolderBindingId')=NEW.client_folder_binding_id
    AND json_extract(candidate.canonical_command_json,'$.resource.externalProjectId')=NEW.external_project_id
    AND CAST(json_extract(candidate.canonical_command_json,'$.resource.projectVersion') AS INTEGER)=NEW.project_version)
    AND (candidate.publication_operation_id=NEW.effective_publication_operation_id
      AND candidate.publication_id=NEW.effective_publication_id AND candidate.publication_revision=NEW.effective_publication_revision
      AND candidate.publication_source_sequence=NEW.effective_publication_source_sequence
      AND candidate.snapshot_id=NEW.effective_publication_snapshot_id AND candidate.snapshot_sha256=NEW.effective_publication_snapshot_sha256)
    AND EXISTS(SELECT 1 FROM json_each(candidate.canonical_command_json,'$.features') WHERE value='file.download'))
BEGIN SELECT RAISE(ABORT,'successor content start requires exact current local candidate'); END;
CREATE TRIGGER windows_portal_successor_content_start_no_update BEFORE UPDATE ON windows_portal_successor_content_start_events
BEGIN SELECT RAISE(ABORT,'successor content start audit is immutable'); END;
CREATE TRIGGER windows_portal_successor_content_start_no_delete BEFORE DELETE ON windows_portal_successor_content_start_events
BEGIN SELECT RAISE(ABORT,'successor content start audit is durable'); END;
