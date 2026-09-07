-- Additive capture groundwork. No historical notification receipts are made.
ALTER TABLE file_index ADD COLUMN provider_version TEXT
  CHECK(provider_version IS NULL OR (length(provider_version) BETWEEN 1 AND 512 AND trim(provider_version)=provider_version));
ALTER TABLE file_index ADD COLUMN notification_observation_version TEXT
  CHECK(notification_observation_version IS NULL OR (length(notification_observation_version) BETWEEN 1 AND 512 AND trim(notification_observation_version)=notification_observation_version));

-- Revisions outlive deleted index rows, fencing absent -> present -> absent
-- races as well as replacement by identical bytes. These are storage/index
-- revisions, not client events; administrative repairs do not notify anyone.
CREATE TABLE delivery_file_index_revisions (
  r2_key TEXT NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision > 0)
);
INSERT INTO delivery_file_index_revisions(r2_key,revision)
  SELECT r2_key,1 FROM file_index;

CREATE TRIGGER delivery_file_index_revision_insert AFTER INSERT ON file_index
BEGIN
  INSERT INTO delivery_file_index_revisions(r2_key,revision) VALUES(NEW.r2_key,1)
    ON CONFLICT(r2_key) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER delivery_file_index_revision_update AFTER UPDATE ON file_index
BEGIN
  INSERT INTO delivery_file_index_revisions(r2_key,revision) VALUES(NEW.r2_key,1)
    ON CONFLICT(r2_key) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER delivery_file_index_revision_delete AFTER DELETE ON file_index
BEGIN
  INSERT INTO delivery_file_index_revisions(r2_key,revision) VALUES(OLD.r2_key,1)
    ON CONFLICT(r2_key) DO UPDATE SET revision=revision+1;
END;

-- Old writers cannot carry a known provider identity onto changed source
-- metadata. Updated writers must supply the new provider upload identifier.
CREATE TRIGGER delivery_file_index_legacy_identity_update AFTER UPDATE ON file_index
WHEN NEW.provider_version IS NOT NULL AND NEW.provider_version IS OLD.provider_version
  AND (NEW.etag IS NOT OLD.etag OR NEW.size IS NOT OLD.size OR NEW.uploaded_at IS NOT OLD.uploaded_at)
BEGIN
  UPDATE file_index SET provider_version=NULL WHERE r2_key=NEW.r2_key;
END;
CREATE TRIGGER delivery_file_index_key_immutable BEFORE UPDATE OF r2_key ON file_index
WHEN NEW.r2_key IS NOT OLD.r2_key
BEGIN SELECT RAISE(ABORT,'file index keys must be moved explicitly'); END;
CREATE TRIGGER delivery_file_index_revision_no_delete BEFORE DELETE ON delivery_file_index_revisions
BEGIN SELECT RAISE(ABORT,'file index revision tombstones must be retained'); END;
CREATE TRIGGER delivery_file_index_revision_monotonic BEFORE UPDATE ON delivery_file_index_revisions
WHEN NEW.r2_key IS NOT OLD.r2_key OR NEW.revision<=OLD.revision
BEGIN SELECT RAISE(ABORT,'file index revision must advance'); END;
