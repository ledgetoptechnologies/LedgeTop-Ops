PRAGMA foreign_keys=ON;

-- A published batch must retain the exact accepted receipt identity for each
-- item. The object-version ledger is deliberately not a publication source:
-- it may already describe a newer same-ETag upload at this key.
ALTER TABLE portal_authenticated_delivery_change_batch_items
  ADD COLUMN accepted_sequence INTEGER CHECK(accepted_sequence>=1);
ALTER TABLE portal_authenticated_delivery_change_batch_items
  ADD COLUMN provider_object_version TEXT
    CHECK(provider_object_version IS NULL OR (length(provider_object_version) BETWEEN 1 AND 512 AND trim(provider_object_version)=provider_object_version));

CREATE TRIGGER authenticated_delivery_change_batch_item_sequence_pair_insert
BEFORE INSERT ON portal_authenticated_delivery_change_batch_items
WHEN (NEW.accepted_sequence IS NULL)<>(NEW.provider_object_version IS NULL)
BEGIN SELECT RAISE(ABORT,'batch item sequence and provider identity must be paired'); END;
CREATE TRIGGER authenticated_delivery_change_batch_item_sequence_pair_update
BEFORE UPDATE ON portal_authenticated_delivery_change_batch_items
WHEN (NEW.accepted_sequence IS NULL)<>(NEW.provider_object_version IS NULL)
BEGIN SELECT RAISE(ABORT,'batch item sequence and provider identity must be paired'); END;
