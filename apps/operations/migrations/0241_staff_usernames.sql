-- A short, explicit username per staff member (for example "bkoltz"). Pilots type it on a controller to
-- sign in; Ledge Top Logs resolves it to the stable staff id once, when the sign-in code is issued.
-- Usernames are set by an administrator, are never derived from email addresses, and are optional:
-- staff without one can't sign in on a controller.
-- Kept in its own table so setting one never updates staff_users (whose rows are fenced by the staff
-- lifecycle and login-binding triggers).
CREATE TABLE staff_usernames (
  staff_id TEXT PRIMARY KEY NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE
    CHECK (username = lower(username) AND length(username) BETWEEN 2 AND 32
      AND username NOT GLOB '*[^a-z0-9._-]*' AND substr(username, 1, 1) GLOB '[a-z0-9]'),
  set_by_staff_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
