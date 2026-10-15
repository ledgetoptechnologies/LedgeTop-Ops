PRAGMA foreign_keys = ON;

-- Existing data created by pre-0179 writers must satisfy the invariant too.
-- D1 runs each migration atomically; a collision makes this CHECK fail and
-- rolls back both this preflight and every trigger replacement below.
CREATE TABLE _project_alpha_acquired_identity_migration_assertion (
  valid INTEGER NOT NULL CHECK(valid = 1)
);
INSERT INTO _project_alpha_acquired_identity_migration_assertion(valid)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM project_alpha_acquired_canonical_mappings acquired
  JOIN project_alpha_directory_mappings legacy
    ON legacy.source_id=acquired.source_id
    AND legacy.source_instance_id=acquired.source_instance_id
    AND legacy.application_id=acquired.application_id
    AND legacy.resource_type=acquired.resource_type
    AND (legacy.external_id IN (acquired.record_id, acquired.external_id, acquired.project_alpha_public_id)
      OR legacy.project_alpha_public_id IN (acquired.record_id, acquired.external_id, acquired.project_alpha_public_id))
)
OR EXISTS (
  SELECT 1 FROM project_alpha_acquired_native_owner_claims claim
  JOIN project_alpha_directory_mappings legacy
    ON legacy.source_id=claim.source_id
    AND legacy.source_instance_id=claim.source_instance_id
    AND legacy.application_id=claim.application_id
    AND legacy.resource_type=claim.resource_type
    AND (legacy.external_id IN (claim.record_id, claim.external_id, claim.project_alpha_public_id)
      OR legacy.project_alpha_public_id IN (claim.record_id, claim.external_id, claim.project_alpha_public_id))
);
-- Cross-column aliases between acquired rows are ambiguous too. Unique indexes
-- are column-specific and history-epoch scoped, so compare all three IDs
-- across canonical rows, owner claims, and their cross-table pairing.
INSERT INTO _project_alpha_acquired_identity_migration_assertion(valid)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM project_alpha_acquired_canonical_mappings left_row
  JOIN project_alpha_acquired_canonical_mappings right_row
    ON right_row.source_id=left_row.source_id AND right_row.source_instance_id=left_row.source_instance_id
    AND right_row.application_id=left_row.application_id AND right_row.resource_type=left_row.resource_type
    AND right_row.receipt_id>left_row.receipt_id
  WHERE left_row.record_id IN (right_row.record_id,right_row.external_id,right_row.project_alpha_public_id)
    OR left_row.external_id IN (right_row.record_id,right_row.external_id,right_row.project_alpha_public_id)
    OR left_row.project_alpha_public_id IN (right_row.record_id,right_row.external_id,right_row.project_alpha_public_id)
)
OR EXISTS (
  SELECT 1 FROM project_alpha_acquired_native_owner_claims left_row
  JOIN project_alpha_acquired_native_owner_claims right_row
    ON right_row.source_id=left_row.source_id AND right_row.source_instance_id=left_row.source_instance_id
    AND right_row.application_id=left_row.application_id AND right_row.resource_type=left_row.resource_type
    AND right_row.receipt_id>left_row.receipt_id
  WHERE left_row.record_id IN (right_row.record_id,right_row.external_id,right_row.project_alpha_public_id)
    OR left_row.external_id IN (right_row.record_id,right_row.external_id,right_row.project_alpha_public_id)
    OR left_row.project_alpha_public_id IN (right_row.record_id,right_row.external_id,right_row.project_alpha_public_id)
)
OR EXISTS (
  SELECT 1 FROM project_alpha_acquired_canonical_mappings acquired
  JOIN project_alpha_acquired_native_owner_claims claim
    ON claim.source_id=acquired.source_id AND claim.source_instance_id=acquired.source_instance_id
    AND claim.application_id=acquired.application_id AND claim.resource_type=acquired.resource_type
    AND claim.receipt_id<>acquired.receipt_id
  WHERE acquired.record_id IN (claim.record_id,claim.external_id,claim.project_alpha_public_id)
    OR acquired.external_id IN (claim.record_id,claim.external_id,claim.project_alpha_public_id)
    OR acquired.project_alpha_public_id IN (claim.record_id,claim.external_id,claim.project_alpha_public_id)
)
OR EXISTS (
  SELECT 1 FROM project_alpha_acquired_canonical_mappings acquired
  JOIN project_alpha_acquired_native_owner_claims claim ON claim.receipt_id=acquired.receipt_id
  WHERE acquired.record_id IS NOT claim.record_id OR acquired.external_id IS NOT claim.external_id
    OR acquired.project_alpha_public_id IS NOT claim.project_alpha_public_id
);
DROP TABLE _project_alpha_acquired_identity_migration_assertion;

-- One-to-one identity must cover both IDs carried by an acquired mapping:
-- the immutable Operations record_id and the Project Alpha external_id.
-- Existing guards only compared external_id/public_id and could therefore
-- allow one native record to be claimed under a different external ID.
DROP TRIGGER project_alpha_acquired_canonical_mappings_legacy_collision;
CREATE TRIGGER project_alpha_acquired_canonical_mappings_legacy_collision
BEFORE INSERT ON project_alpha_acquired_canonical_mappings
WHEN EXISTS (SELECT 1 FROM project_alpha_directory_mappings legacy
  WHERE legacy.source_id=NEW.source_id AND legacy.source_instance_id=NEW.source_instance_id
    AND legacy.application_id=NEW.application_id AND legacy.resource_type=NEW.resource_type
    AND (legacy.external_id IN (NEW.record_id, NEW.external_id, NEW.project_alpha_public_id)
      OR legacy.project_alpha_public_id IN (NEW.record_id, NEW.external_id, NEW.project_alpha_public_id)))
BEGIN SELECT RAISE(ABORT,'acquired canonical mapping collides with legacy mapping'); END;

DROP TRIGGER project_alpha_acquired_canonical_mappings_native_identity_collision;
CREATE TRIGGER project_alpha_acquired_canonical_mappings_native_identity_collision
BEFORE INSERT ON project_alpha_acquired_canonical_mappings
WHEN EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings existing
  WHERE existing.source_id=NEW.source_id AND existing.source_instance_id=NEW.source_instance_id
    AND existing.application_id=NEW.application_id AND existing.resource_type=NEW.resource_type
    AND (existing.record_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)
      OR existing.external_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)
      OR existing.project_alpha_public_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)))
  OR EXISTS(SELECT 1 FROM project_alpha_acquired_native_owner_claims existing
    WHERE existing.source_id=NEW.source_id AND existing.source_instance_id=NEW.source_instance_id
      AND existing.application_id=NEW.application_id AND existing.resource_type=NEW.resource_type
      AND (existing.record_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)
        OR existing.external_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)
        OR existing.project_alpha_public_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)))
BEGIN SELECT RAISE(ABORT,'acquired identity collides with an existing native identity'); END;

DROP TRIGGER project_alpha_acquired_native_owner_claims_legacy;
CREATE TRIGGER project_alpha_acquired_native_owner_claims_legacy
BEFORE INSERT ON project_alpha_acquired_native_owner_claims
WHEN EXISTS(SELECT 1 FROM project_alpha_directory_mappings legacy
  WHERE legacy.source_id=NEW.source_id AND legacy.source_instance_id=NEW.source_instance_id
    AND legacy.application_id=NEW.application_id AND legacy.resource_type=NEW.resource_type
    AND (legacy.external_id IN (NEW.record_id, NEW.external_id, NEW.project_alpha_public_id)
      OR legacy.project_alpha_public_id IN (NEW.record_id, NEW.external_id, NEW.project_alpha_public_id)))
BEGIN SELECT RAISE(ABORT,'native owner claim collides with legacy mapping'); END;

DROP TRIGGER IF EXISTS project_alpha_acquired_native_owner_claims_native_identity_collision;
CREATE TRIGGER project_alpha_acquired_native_owner_claims_native_identity_collision
BEFORE INSERT ON project_alpha_acquired_native_owner_claims
WHEN EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings existing
  WHERE existing.receipt_id<>NEW.receipt_id AND existing.source_id=NEW.source_id
    AND existing.source_instance_id=NEW.source_instance_id AND existing.application_id=NEW.application_id
    AND existing.resource_type=NEW.resource_type
    AND (existing.record_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)
      OR existing.external_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)
      OR existing.project_alpha_public_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)))
  OR EXISTS(SELECT 1 FROM project_alpha_acquired_native_owner_claims existing
    WHERE existing.receipt_id<>NEW.receipt_id AND existing.source_id=NEW.source_id
      AND existing.source_instance_id=NEW.source_instance_id AND existing.application_id=NEW.application_id
      AND existing.resource_type=NEW.resource_type
      AND (existing.record_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)
        OR existing.external_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)
        OR existing.project_alpha_public_id IN (NEW.record_id,NEW.external_id,NEW.project_alpha_public_id)))
BEGIN SELECT RAISE(ABORT,'native owner claim collides with an existing native identity'); END;

-- Enforce the same cross-identity check in the reverse insertion direction.
DROP TRIGGER project_alpha_directory_mappings_acquired_collision;
CREATE TRIGGER project_alpha_directory_mappings_acquired_collision
BEFORE INSERT ON project_alpha_directory_mappings
WHEN EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings acquired
  WHERE acquired.source_id=NEW.source_id AND acquired.source_instance_id=NEW.source_instance_id
    AND acquired.application_id=NEW.application_id AND acquired.resource_type=NEW.resource_type
    AND (NEW.external_id IN (acquired.record_id, acquired.external_id, acquired.project_alpha_public_id)
      OR NEW.project_alpha_public_id IN (acquired.record_id, acquired.external_id, acquired.project_alpha_public_id)))
  OR EXISTS(SELECT 1 FROM project_alpha_acquired_native_owner_claims claim
    WHERE claim.source_id=NEW.source_id AND claim.source_instance_id=NEW.source_instance_id
      AND claim.application_id=NEW.application_id AND claim.resource_type=NEW.resource_type
      AND (NEW.external_id IN (claim.record_id, claim.external_id, claim.project_alpha_public_id)
        OR NEW.project_alpha_public_id IN (claim.record_id, claim.external_id, claim.project_alpha_public_id)))
BEGIN SELECT RAISE(ABORT,'legacy mapping collides with acquired reservation'); END;
