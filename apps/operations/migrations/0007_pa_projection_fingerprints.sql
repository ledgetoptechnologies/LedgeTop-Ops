CREATE TABLE pa_projection_fingerprints (
  collection TEXT PRIMARY KEY CHECK (collection IN (
    'users','business_units','worker_business_units','clients','organizations',
    'projects','project_assignments','service_locations','application_entitlements',
    'operations','operation_assignments','tasks','calendar_events'
  )),
  fingerprint TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
