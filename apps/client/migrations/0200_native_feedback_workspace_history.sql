PRAGMA foreign_keys = ON;

-- Client Hub reads all currently authorized feedback for one exact native
-- workspace. Project/owner indexes cannot cover a root that contains several
-- departments and projects, so keep this source/workspace traversal bounded.
-- This index grants no access and changes no feedback lifecycle data.
CREATE INDEX IF NOT EXISTS idx_portal_native_feedback_workspace_chronological
  ON portal_native_feedback(source_id, workspace_id, created_at, id);
