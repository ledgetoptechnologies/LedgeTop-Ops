PRAGMA foreign_keys = ON;

-- GPS is sensitive client data. Existing and new shares remain map-disabled
-- until an authorized Operations user explicitly enables coordinates.
ALTER TABLE shares ADD COLUMN image_location_map_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (image_location_map_enabled IN (0, 1));
