PRAGMA foreign_keys=ON;

-- Native Operations content-start audit is intentionally separate from the
-- legacy/PA ledger. It retains immutable authority coordinates and keyed
-- fingerprints, never the raw Access principal, object key, or content ETag.
CREATE TABLE operations_portal_native_content_start_events (
  recorded_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 96),
  dedupe_key TEXT NOT NULL UNIQUE CHECK(length(dedupe_key)=43),
  dedupe_window INTEGER NOT NULL CHECK(dedupe_window>=0),
  action TEXT NOT NULL CHECK(action IN ('file.preview_requested','file.download_requested')),
  feature TEXT NOT NULL CHECK(feature IN ('file.preview','file.download')),
  principal_fingerprint TEXT NOT NULL CHECK(length(principal_fingerprint)=43),
  authority_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK(authority_revision>=1),
  delivery_operation_id TEXT NOT NULL,
  delivery_request_fingerprint TEXT NOT NULL CHECK(length(delivery_request_fingerprint)=64),
  recipient_binding_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  home_ownership_epoch INTEGER NOT NULL CHECK(home_ownership_epoch>=1),
  home_grant_revision INTEGER NOT NULL CHECK(home_grant_revision>=1),
  home_grant_operation_id TEXT NOT NULL,
  home_request_fingerprint TEXT NOT NULL CHECK(length(home_request_fingerprint)=64),
  publication_operation_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  publication_revision INTEGER NOT NULL CHECK(publication_revision>=1),
  publication_snapshot_id TEXT NOT NULL,
  publication_snapshot_sha256 TEXT NOT NULL CHECK(length(publication_snapshot_sha256)=64),
  folder_reservation_id TEXT NOT NULL,
  folder_reservation_revision INTEGER NOT NULL CHECK(folder_reservation_revision>=1),
  client_folder_binding_id TEXT NOT NULL,
  external_project_id TEXT NOT NULL,
  project_version INTEGER NOT NULL CHECK(project_version>=1),
  prefix_fingerprint TEXT NOT NULL CHECK(length(prefix_fingerprint)=43),
  resource_fingerprint TEXT NOT NULL CHECK(length(resource_fingerprint)=43),
  content_version_fingerprint TEXT NOT NULL CHECK(length(content_version_fingerprint)=43),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS occurred_at),
  CHECK((action='file.preview_requested' AND feature='file.preview')
    OR (action='file.download_requested' AND feature='file.download'))
);

CREATE INDEX operations_portal_native_content_start_timeline
  ON operations_portal_native_content_start_events(authority_id,recipient_binding_id,occurred_at DESC,recorded_sequence DESC);

-- Every row must name the exact current acknowledged 0227 head and all
-- immutable delivery/home/publication/folder/project pins. File-index and HMAC
-- proofs are additionally fenced in the producer's INSERT SELECT because raw
-- object coordinates are deliberately not retained here.
CREATE TRIGGER operations_portal_native_content_start_insert_guard
BEFORE INSERT ON operations_portal_native_content_start_events
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_live_heads live
  WHERE live.authority_id=NEW.authority_id AND live.revision=NEW.authority_revision
    AND live.latest_operation_id=NEW.delivery_operation_id
    AND live.request_fingerprint=NEW.delivery_request_fingerprint
    AND live.recipient_binding_id=NEW.recipient_binding_id
    AND live.target_id=NEW.target_id AND live.folder_reservation_id=NEW.folder_reservation_id
    AND json_extract(live.canonical_command_json,'$.action')='delivery.grant'
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

CREATE TRIGGER operations_portal_native_content_start_no_update BEFORE UPDATE
ON operations_portal_native_content_start_events
BEGIN SELECT RAISE(ABORT,'native content start audit is immutable'); END;
CREATE TRIGGER operations_portal_native_content_start_no_delete BEFORE DELETE
ON operations_portal_native_content_start_events
BEGIN SELECT RAISE(ABORT,'native content start audit is durable'); END;
