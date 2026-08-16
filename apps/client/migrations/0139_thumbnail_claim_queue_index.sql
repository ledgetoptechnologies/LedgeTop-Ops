PRAGMA foreign_keys = ON;

-- Keep the legacy/general renderer claim ordered without sorting every pending
-- row. The TrueNAS video-only claim is driven from file_index.media_kind and
-- joins image_thumbnail_jobs by its primary key; this partial index covers the
-- remaining pending-queue traversal.
CREATE INDEX IF NOT EXISTS idx_image_thumbnail_jobs_pending_queue
  ON image_thumbnail_jobs(queue_published_at, source_key)
  WHERE status = 'pending';
