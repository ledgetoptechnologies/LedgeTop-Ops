ALTER TABLE pa_projects ADD COLUMN manager_user_id TEXT;
CREATE INDEX idx_pa_projects_manager ON pa_projects(manager_user_id,active);
