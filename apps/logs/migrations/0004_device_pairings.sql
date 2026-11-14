-- Pairing codes: a pilot signed in to Ops creates a short-lived, single-use code and types it on the controller
-- together with their username. The code, not the username, is the proof, so a pairing sign-in doesn't use the
-- anonymous per-username limits and can't be blocked by someone flooding that username.
-- Only a SHA-256 of the code is stored. A code is bound to the pilot's eligibility revision when it was made.
-- Additive only. (Filename proposed; reservation by Merger pending.)
CREATE TABLE device_pairings (
  id TEXT PRIMARY KEY,
  pilot_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  eligibility_revision INTEGER NOT NULL CHECK (eligibility_revision > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'used', 'closed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  sign_in_id TEXT
);
CREATE INDEX device_pairings_pilot ON device_pairings(pilot_id, status, created_at);
-- Wrong or expired pairing codes, for a global guess limit. Holds a timestamp only.
CREATE TABLE device_pairing_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL
);
CREATE INDEX device_pairing_failures_at ON device_pairing_failures(at);
ALTER TABLE device_sign_ins ADD COLUMN pairing_id TEXT REFERENCES device_pairings(id);
