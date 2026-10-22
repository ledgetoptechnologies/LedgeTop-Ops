-- Read-only continuity evidence. No grants, route admission or authority changes.
CREATE INDEX operations_portal_publication_target_sequence
  ON operations_portal_workspace_publication_commands(target_id,source_sequence,operation_id);
