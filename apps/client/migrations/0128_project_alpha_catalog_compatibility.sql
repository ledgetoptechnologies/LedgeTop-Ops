PRAGMA foreign_keys = ON;

-- Add the remaining portal-safe Project Alpha catalog contract fields without
-- rewriting or invalidating the last-known-good generation. Legacy rows retain
-- their prior optional-work-area behavior until Project Alpha publishes a new
-- explicitly versioned item.
ALTER TABLE pa_service_catalog_items ADD COLUMN category TEXT NOT NULL DEFAULT 'Uncategorized'
  CHECK (length(trim(category)) BETWEEN 1 AND 100);
ALTER TABLE pa_service_catalog_items ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0
  CHECK (display_order BETWEEN 0 AND 1000000);
ALTER TABLE pa_service_catalog_items ADD COLUMN geometry_requirement TEXT NOT NULL DEFAULT 'optional'
  CHECK (geometry_requirement IN ('none','optional','required'));

ALTER TABLE pa_service_catalog_generation_items ADD COLUMN category TEXT NOT NULL DEFAULT 'Uncategorized'
  CHECK (length(trim(category)) BETWEEN 1 AND 100);
ALTER TABLE pa_service_catalog_generation_items ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0
  CHECK (display_order BETWEEN 0 AND 1000000);
ALTER TABLE pa_service_catalog_generation_items ADD COLUMN geometry_requirement TEXT NOT NULL DEFAULT 'optional'
  CHECK (geometry_requirement IN ('none','optional','required'));

CREATE INDEX IF NOT EXISTS idx_pa_service_catalog_client_order
  ON pa_service_catalog_items(active,category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id);
