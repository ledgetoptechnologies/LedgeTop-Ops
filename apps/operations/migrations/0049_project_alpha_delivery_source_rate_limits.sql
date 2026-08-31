PRAGMA foreign_keys = ON;

-- Keep the legacy primary-instance limiter byte-for-byte compatible so the
-- migration can precede code deployment and old code remains rollback-safe.
CREATE TABLE project_alpha_delivery_intent_source_rate_limits (
  source_id TEXT NOT NULL CHECK(
    length(source_id) BETWEEN 15 AND 78
    AND instr(source_id,char(0))=0
    AND substr(source_id,1,14)='project-alpha:'
    AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'
  ),
  scope TEXT NOT NULL CHECK(scope IN ('attempt_preflight','attempt_intent','preflight','intent')),
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count>=1),
  PRIMARY KEY(source_id,scope,window_start)
);

CREATE INDEX idx_project_alpha_delivery_intent_source_rate_window
  ON project_alpha_delivery_intent_source_rate_limits(window_start);
