CREATE TABLE pa_projection_entity_leases (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  owner_event_id TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type,entity_id)
);

CREATE INDEX idx_pa_projection_entity_leases_expiry
  ON pa_projection_entity_leases(lease_until);
