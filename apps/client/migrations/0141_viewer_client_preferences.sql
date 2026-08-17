PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS viewer_client_preferences (
  identity_id TEXT PRIMARY KEY,
  display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(identity_id) REFERENCES portal_v2_identities(id) ON DELETE CASCADE
);
