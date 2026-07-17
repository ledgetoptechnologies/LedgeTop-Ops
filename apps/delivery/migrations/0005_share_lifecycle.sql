PRAGMA foreign_keys = ON;

-- The fragment secret remains encrypted at rest so authorized staff can copy an
-- existing link without creating another share. token_hash remains the only
-- value used by the public Delivery Worker to authenticate a link.
ALTER TABLE shares ADD COLUMN secret_ciphertext TEXT;
ALTER TABLE shares ADD COLUMN secret_iv TEXT;
ALTER TABLE shares ADD COLUMN r2_prefix TEXT;
ALTER TABLE shares ADD COLUMN division_id TEXT;
ALTER TABLE shares ADD COLUMN password_algorithm TEXT;
ALTER TABLE shares ADD COLUMN revoked_reason TEXT;
ALTER TABLE shares ADD COLUMN unavailable_since TEXT;

UPDATE shares
SET password_algorithm = 'pbkdf2-sha256-v1'
WHERE password_hash IS NOT NULL AND password_algorithm IS NULL;

UPDATE shares
SET r2_prefix = (SELECT projects.r2_prefix FROM projects WHERE projects.id = shares.project_id)
WHERE r2_prefix IS NULL;

UPDATE shares
SET division_id = (SELECT projects.division_id FROM projects WHERE projects.id = shares.project_id)
WHERE division_id IS NULL;

-- Expired and inactive-project rows are historical, not active links. Revoke
-- them before deduplicating or creating the one-active-prefix index.
UPDATE shares
SET revoked_at = datetime('now'),
    revoked_reason = 'expired'
WHERE revoked_at IS NULL
  AND expires_at IS NOT NULL
  AND datetime(expires_at) <= datetime('now');

UPDATE shares
SET revoked_at = datetime('now'),
    revoked_reason = 'project_inactive'
WHERE revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = shares.project_id AND projects.active = 0
  );

-- Older builds could create more than one active share for the same folder.
-- Keep the newest row active and retain older rows as revoked audit history.
UPDATE shares AS older
SET revoked_at = COALESCE(older.revoked_at, datetime('now')),
    revoked_reason = COALESCE(older.revoked_reason, 'superseded')
WHERE older.revoked_at IS NULL
  AND older.r2_prefix IS NOT NULL
  AND (older.expires_at IS NULL OR datetime(older.expires_at) > datetime('now'))
  AND EXISTS (
    SELECT 1
    FROM shares AS newer
    WHERE newer.revoked_at IS NULL
      AND newer.r2_prefix = older.r2_prefix
      AND (newer.expires_at IS NULL OR datetime(newer.expires_at) > datetime('now'))
      AND (
        newer.created_at > older.created_at
        OR (newer.created_at = older.created_at AND newer.rowid > older.rowid)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_one_active_prefix
  ON shares(r2_prefix)
  WHERE revoked_at IS NULL AND r2_prefix IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shares_prefix_history
  ON shares(r2_prefix, created_at DESC);
