PRAGMA foreign_keys = ON;

-- Minimal, version-bound GPS extraction state for delivery images. Raw EXIF,
-- camera direction, device details, and source metadata are never retained.
-- Terminal absent/invalid rows prevent repeated parsing of the same version.
CREATE TABLE IF NOT EXISTS image_asset_locations (
  source_key TEXT PRIMARY KEY,
  source_etag TEXT NOT NULL,
  folder_prefix TEXT NOT NULL
    CHECK (length(folder_prefix) BETWEEN 1 AND 1000 AND substr(folder_prefix,-1)='/'),
  latitude REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','ready','absent','invalid','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  lease_until TEXT,
  last_enqueued_at TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status='ready' AND latitude IS NOT NULL AND longitude IS NOT NULL) OR
    (status<>'ready' AND latitude IS NULL AND longitude IS NULL)
  ),
  FOREIGN KEY (source_key) REFERENCES file_index(r2_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_image_asset_locations_folder
  ON image_asset_locations(folder_prefix,status,source_etag);

CREATE INDEX IF NOT EXISTS idx_image_asset_locations_backfill
  ON image_asset_locations(status,last_enqueued_at,lease_until);
