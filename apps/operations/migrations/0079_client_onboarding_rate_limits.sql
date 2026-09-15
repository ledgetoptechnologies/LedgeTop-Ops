PRAGMA foreign_keys = ON;

-- Public client-onboarding quota state only. Keys are HMAC digests produced by
-- the HTTP adapter; never store raw IPs, invitation IDs, bearer secrets or PII.
CREATE TABLE client_onboarding_rate_limits (
  rate_key TEXT NOT NULL PRIMARY KEY COLLATE BINARY CHECK(
    (length(rate_key)=85 AND substr(rate_key,1,21)='client-onboarding:ip:'
      AND substr(rate_key,22) NOT GLOB '*[^0-9a-f]*')
    OR (length(rate_key)=93 AND substr(rate_key,1,29)='client-onboarding:invitation:'
      AND substr(rate_key,30) NOT GLOB '*[^0-9a-f]*')),
  window_bucket INTEGER NOT NULL CHECK(window_bucket>=0),
  request_count INTEGER NOT NULL CHECK(request_count>=1 AND request_count<=request_limit),
  request_limit INTEGER NOT NULL CHECK(request_limit BETWEEN 1 AND 120)
) STRICT;
CREATE INDEX client_onboarding_rate_limits_window ON client_onboarding_rate_limits(window_bucket);
