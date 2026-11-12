-- A short, explicit username per staff member (for example "bkoltz"). Pilots type it on a controller to
-- sign in; Ledge Top Logs resolves it to the stable staff id once, when the sign-in code is issued.
-- Usernames are set by an administrator, are never derived from email addresses, and are optional:
-- staff without one can't sign in on a controller.
ALTER TABLE staff_users ADD COLUMN username TEXT
  CHECK (username IS NULL OR (username = lower(username) AND length(username) BETWEEN 2 AND 32
    AND username NOT GLOB '*[^a-z0-9._-]*' AND substr(username, 1, 1) GLOB '[a-z0-9]'));
CREATE UNIQUE INDEX staff_users_username ON staff_users(username) WHERE username IS NOT NULL;
