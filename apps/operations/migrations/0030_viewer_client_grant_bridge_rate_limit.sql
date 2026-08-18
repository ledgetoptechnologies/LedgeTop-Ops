CREATE TABLE IF NOT EXISTS viewer_workspace_client_grant_rate_limits (
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  PRIMARY KEY (window_start)
);
