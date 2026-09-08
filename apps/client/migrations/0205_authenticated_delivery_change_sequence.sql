PRAGMA foreign_keys=ON;

-- Durable accepted receipts are globally ordered. Keep their provider upload
-- identity separate from the content ETag retained by batch publication.
ALTER TABLE portal_authenticated_delivery_change_object_versions
  ADD COLUMN accepted_sequence INTEGER CHECK(accepted_sequence>=1);
ALTER TABLE portal_authenticated_delivery_change_object_versions
  ADD COLUMN provider_object_version TEXT CHECK(provider_object_version IS NULL OR length(provider_object_version) BETWEEN 1 AND 512);

CREATE TRIGGER authenticated_delivery_change_sequence_pair_insert
BEFORE INSERT ON portal_authenticated_delivery_change_object_versions
WHEN (NEW.accepted_sequence IS NULL)<>(NEW.provider_object_version IS NULL)
BEGIN SELECT RAISE(ABORT,'delivery sequence and provider identity must be paired'); END;
CREATE TRIGGER authenticated_delivery_change_sequence_pair_update
BEFORE UPDATE ON portal_authenticated_delivery_change_object_versions
WHEN (NEW.accepted_sequence IS NULL)<>(NEW.provider_object_version IS NULL)
BEGIN SELECT RAISE(ABORT,'delivery sequence and provider identity must be paired'); END;

-- Migration 0170 only allowed monotonically increasing event timestamps. A
-- newer accepted receipt is authoritative even when its source timestamp is
-- equal or older; the timestamp remains stored for audit/projection context.
DROP TRIGGER portal_authenticated_delivery_change_object_version_update;
CREATE TRIGGER portal_authenticated_delivery_change_object_version_update
BEFORE UPDATE ON portal_authenticated_delivery_change_object_versions
WHEN NEW.grant_id<>OLD.grant_id OR NEW.grant_version<>OLD.grant_version OR NEW.identity_id<>OLD.identity_id
  OR NEW.object_fingerprint<>OLD.object_fingerprint OR NEW.r2_key<>OLD.r2_key
  OR (OLD.accepted_sequence IS NOT NULL AND NEW.accepted_sequence IS NULL)
  OR (OLD.accepted_sequence IS NOT NULL AND NEW.accepted_sequence<OLD.accepted_sequence)
  OR (OLD.accepted_sequence IS NOT NULL AND NEW.accepted_sequence=OLD.accepted_sequence
    AND (NEW.provider_object_version IS NOT OLD.provider_object_version
      OR NEW.current_present<>OLD.current_present OR NEW.current_object_version IS NOT OLD.current_object_version))
  OR (NOT (NEW.accepted_sequence IS NOT NULL
      AND (OLD.accepted_sequence IS NULL OR NEW.accepted_sequence>OLD.accepted_sequence))
    AND datetime(NEW.observed_event_at)<datetime(OLD.observed_event_at))
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification object version regressed'); END;
