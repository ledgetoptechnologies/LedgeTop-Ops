-- Public delivery links may target one exact object while retaining the
-- parent prefix for staff authorization, project metadata, and audit context.
-- NULL preserves the established folder-share behavior.
ALTER TABLE shares ADD COLUMN r2_object_key TEXT;

DROP INDEX IF EXISTS idx_shares_one_active_prefix;

CREATE UNIQUE INDEX idx_shares_one_active_prefix
  ON shares(r2_prefix)
  WHERE revoked_at IS NULL AND r2_prefix IS NOT NULL AND r2_object_key IS NULL;

CREATE UNIQUE INDEX idx_shares_one_active_object
  ON shares(r2_object_key)
  WHERE revoked_at IS NULL AND r2_object_key IS NOT NULL;

CREATE INDEX idx_shares_object_history
  ON shares(r2_object_key, created_at DESC);
