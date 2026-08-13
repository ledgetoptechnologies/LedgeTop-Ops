-- Keep negative Operations share lookups bounded to the exact delivery folder.
-- 0113 is intentionally reserved because it already exists in the production
-- migration ledger under a release migration that is not present in this tree.
CREATE INDEX IF NOT EXISTS idx_projects_r2_prefix_active_created
  ON projects(r2_prefix, active, created_at DESC);
