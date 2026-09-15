-- Operational counters only: no invitation, identity or staff authority records.
-- One row per keyed digest is reused; no history or client data is removed.
CREATE TABLE native_staff_onboarding_rate_limits (
  rate_key TEXT PRIMARY KEY NOT NULL,
  window_bucket INTEGER NOT NULL CHECK(window_bucket >= 0),
  request_count INTEGER NOT NULL CHECK(request_count >= 1),
  request_limit INTEGER NOT NULL CHECK(request_limit BETWEEN 1 AND 120),
  CHECK(request_count <= request_limit)
) STRICT;
CREATE INDEX native_staff_onboarding_rate_limits_window
  ON native_staff_onboarding_rate_limits(window_bucket);
