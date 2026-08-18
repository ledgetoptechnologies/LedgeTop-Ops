PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS project_alpha_delivery_intent_rate_limits (
  scope TEXT NOT NULL CHECK(scope IN ('preflight','intent')),
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count>=1),
  PRIMARY KEY(scope,window_start)
);
CREATE INDEX IF NOT EXISTS idx_project_alpha_delivery_intent_rate_window
  ON project_alpha_delivery_intent_rate_limits(window_start);
