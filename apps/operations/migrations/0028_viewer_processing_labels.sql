PRAGMA foreign_keys = ON;

-- Friendly catalog labels are optional for backward compatibility with Viewer
-- events emitted before this migration. IDs remain authoritative.
ALTER TABLE viewer_processing_events ADD COLUMN project_display_name TEXT
  CHECK(project_display_name IS NULL OR length(trim(project_display_name)) BETWEEN 1 AND 160);
ALTER TABLE viewer_processing_events ADD COLUMN task_display_name TEXT
  CHECK(task_display_name IS NULL OR length(trim(task_display_name)) BETWEEN 1 AND 160);
