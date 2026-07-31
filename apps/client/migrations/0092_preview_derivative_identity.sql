ALTER TABLE preview_artifacts
  ADD COLUMN derivative_etags_json TEXT NOT NULL DEFAULT '{}';
