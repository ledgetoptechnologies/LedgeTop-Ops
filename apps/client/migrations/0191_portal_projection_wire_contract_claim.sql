PRAGMA foreign_keys = ON;

-- A schema-v4 snapshot uses the schema-v3 directory tables plus a separate
-- contact-assignment extension marker. The two-marker representation remains
-- useful to compatibility readers, but it cannot itself atomically distinguish
-- an absent v3 extension from a v4 claim that another request is still making.
-- Keep one authoritative wire-version claim on the staging generation.
ALTER TABLE pa_portal_projection_generations
  ADD COLUMN wire_schema_version INTEGER CHECK (wire_schema_version IN (2,3,4));

-- Preserve every already-claimed generation. The base contract stores 3 for a
-- v4 generation; the extension marker upgrades only that generation to v4.
UPDATE pa_portal_projection_generations
SET wire_schema_version = (
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM pa_portal_projection_contact_assignment_contracts extension
    WHERE extension.generation_id=pa_portal_projection_generations.id
      AND extension.schema_version=4
  ) THEN 4 ELSE base.schema_version END
  FROM pa_portal_projection_generation_contracts base
  WHERE base.generation_id=pa_portal_projection_generations.id
)
WHERE wire_schema_version IS NULL
  AND EXISTS (
    SELECT 1 FROM pa_portal_projection_generation_contracts base
    WHERE base.generation_id=pa_portal_projection_generations.id
  );

-- From 0129 until this migration, a schema-v2 page could be staged while
-- relation projection was disabled without writing a compatibility marker.
-- A generation that already has page data but no marker can only be that
-- legacy v2 path. Claim it before a later feature-flag change can mix v3 data
-- into the same generation. Leave empty staging reservations unclaimed so a
-- legitimate retry can still select its actual wire schema.
UPDATE pa_portal_projection_generations
SET wire_schema_version=2
WHERE wire_schema_version IS NULL
  AND EXISTS (
    SELECT 1 FROM pa_portal_projection_pages page
    WHERE page.generation_id=pa_portal_projection_generations.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM pa_portal_projection_generation_contracts base
    WHERE base.generation_id=pa_portal_projection_generations.id
  );

INSERT INTO pa_portal_projection_generation_contracts(generation_id,schema_version)
SELECT generation.id,2
FROM pa_portal_projection_generations generation
WHERE generation.wire_schema_version=2
  AND NOT EXISTS (
    SELECT 1 FROM pa_portal_projection_generation_contracts base
    WHERE base.generation_id=generation.id
  );

-- Once claimed, a generation can be retried only with the exact same wire
-- schema. Snapshot deletion/re-creation is the recovery path for a bad claim.
CREATE TRIGGER pa_portal_projection_wire_contract_immutable
BEFORE UPDATE OF wire_schema_version ON pa_portal_projection_generations
WHEN OLD.wire_schema_version IS NOT NULL
  AND NEW.wire_schema_version IS NOT OLD.wire_schema_version
BEGIN SELECT RAISE(ABORT,'portal projection wire contract is immutable'); END;

-- Compatibility markers must agree with the authoritative claim even if a
-- future writer bypasses the application-level checks.
CREATE TRIGGER pa_portal_projection_base_contract_matches_wire
BEFORE INSERT ON pa_portal_projection_generation_contracts
WHEN NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_generations generation
  WHERE generation.id=NEW.generation_id
    AND generation.wire_schema_version IS NOT NULL
    AND NEW.schema_version=CASE generation.wire_schema_version WHEN 4 THEN 3 ELSE generation.wire_schema_version END
)
BEGIN SELECT RAISE(ABORT,'portal projection base contract does not match wire contract'); END;

CREATE TRIGGER pa_portal_projection_contact_contract_matches_wire
BEFORE INSERT ON pa_portal_projection_contact_assignment_contracts
WHEN NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_generations generation
  WHERE generation.id=NEW.generation_id AND generation.wire_schema_version=4
)
BEGIN SELECT RAISE(ABORT,'portal projection contact contract does not match wire contract'); END;

-- Marker rows are a compatibility projection of the authoritative claim, not
-- a second mutable source of truth. Block direct mutation after creation. A
-- parent-generation delete remains the sole cleanup path; during its foreign
-- key cascade the parent row has already left the table, so the DELETE guards
-- deliberately do not fire.
CREATE TRIGGER pa_portal_projection_base_contract_immutable
BEFORE UPDATE ON pa_portal_projection_generation_contracts
BEGIN SELECT RAISE(ABORT,'portal projection base contract is immutable'); END;

CREATE TRIGGER pa_portal_projection_base_contract_delete_with_generation
BEFORE DELETE ON pa_portal_projection_generation_contracts
WHEN EXISTS (
  SELECT 1 FROM pa_portal_projection_generations generation
  WHERE generation.id=OLD.generation_id
)
BEGIN SELECT RAISE(ABORT,'portal projection base contract is immutable'); END;

CREATE TRIGGER pa_portal_projection_contact_contract_immutable
BEFORE UPDATE ON pa_portal_projection_contact_assignment_contracts
BEGIN SELECT RAISE(ABORT,'portal projection contact contract is immutable'); END;

CREATE TRIGGER pa_portal_projection_contact_contract_delete_with_generation
BEFORE DELETE ON pa_portal_projection_contact_assignment_contracts
WHEN EXISTS (
  SELECT 1 FROM pa_portal_projection_generations generation
  WHERE generation.id=OLD.generation_id
)
BEGIN SELECT RAISE(ABORT,'portal projection contact contract is immutable'); END;

-- No page can be staged from only one half of the compatibility contract.
-- This keeps the invariant database-enforced across Worker versions.
CREATE TRIGGER pa_portal_projection_page_requires_wire_contract
BEFORE INSERT ON pa_portal_projection_pages
WHEN EXISTS (
  SELECT 1 FROM pa_portal_projection_generations generation
  WHERE generation.id=NEW.generation_id AND generation.wire_schema_version IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1
  FROM pa_portal_projection_generations generation
  JOIN pa_portal_projection_generation_contracts base
    ON base.generation_id=generation.id
  WHERE generation.id=NEW.generation_id
    AND generation.wire_schema_version IS NOT NULL
    AND base.schema_version=CASE generation.wire_schema_version WHEN 4 THEN 3 ELSE generation.wire_schema_version END
    AND (
      (generation.wire_schema_version=4 AND EXISTS (
        SELECT 1 FROM pa_portal_projection_contact_assignment_contracts extension
        WHERE extension.generation_id=generation.id AND extension.schema_version=4
      ))
      OR
      (generation.wire_schema_version IN (2,3) AND NOT EXISTS (
        SELECT 1 FROM pa_portal_projection_contact_assignment_contracts extension
        WHERE extension.generation_id=generation.id
      ))
    )
)
BEGIN SELECT RAISE(ABORT,'portal projection page requires exact wire contract'); END;
