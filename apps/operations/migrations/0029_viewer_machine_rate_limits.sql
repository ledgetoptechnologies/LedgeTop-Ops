CREATE TABLE IF NOT EXISTS viewer_machine_rate_limits (
  scope TEXT NOT NULL CHECK (scope IN ('event','source-introspection')),
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  PRIMARY KEY (scope,window_start)
);

CREATE INDEX IF NOT EXISTS idx_viewer_machine_rate_limit_window
  ON viewer_machine_rate_limits(window_start);
