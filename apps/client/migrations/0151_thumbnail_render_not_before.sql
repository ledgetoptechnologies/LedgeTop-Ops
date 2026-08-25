PRAGMA foreign_keys = ON;

-- Persist the queue delay that decides when a renderer may claim a source.
-- Existing rows remain NULL and are immediately eligible, so applying this
-- migration cannot strand a live pending backlog. New direct uploads record a
-- 30-second boundary; raw server/rclone events retain their 15-minute prebuilt
-- registration window even though the TrueNAS renderer polls D1 directly.
ALTER TABLE image_thumbnail_jobs ADD COLUMN render_not_before TEXT;

CREATE INDEX IF NOT EXISTS idx_image_thumbnail_jobs_pending_render
  ON image_thumbnail_jobs(render_not_before, queue_published_at, source_key)
  WHERE status = 'pending';
