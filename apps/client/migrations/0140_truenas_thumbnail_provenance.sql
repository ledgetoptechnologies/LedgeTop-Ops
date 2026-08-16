PRAGMA foreign_keys = ON;

-- The private renderer API is exclusively served by the TrueNAS worker, but
-- older completions were incorrectly labeled as Cloudflare Container output.
-- Cloudflare's queue consumer does not render video, so exact ready video rows
-- can be repaired without changing image/PDF provenance or source versions.
UPDATE image_thumbnail_jobs
SET thumbnail_provider = 'ltds-truenas'
WHERE status = 'ready'
  AND thumbnail_provider = 'cloudflare-container'
  AND EXISTS (
    SELECT 1
    FROM file_index AS source
    WHERE source.r2_key = image_thumbnail_jobs.source_key
      AND source.media_kind = 'video'
      AND trim(source.etag, '"') = image_thumbnail_jobs.source_etag
      AND source.size = image_thumbnail_jobs.source_size
  );
