PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('delivery.rename','Rename delivery files and folders with virtual display names'),
  ('delivery.delete','Permanently delete delivery source objects from R2');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
  SELECT 'role-owner',key FROM permissions WHERE key IN ('delivery.rename','delivery.delete');

CREATE TABLE IF NOT EXISTS delivery_reconciliation_state (
  source TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_visible_count INTEGER NOT NULL DEFAULT 0,
  last_visible_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delivery_reconciliation_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_reconciliation_alerts_created
  ON delivery_reconciliation_alerts(created_at DESC);

CREATE TABLE IF NOT EXISTS audit_retention_policies (
  name TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL CHECK (retention_days >= 1),
  max_rows INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO audit_retention_policies(name, retention_days, max_rows)
VALUES ('audit_events', 365, 500000), ('delivery_audit_log', 365, 500000), ('delivery_share_events', 90, 1000000),
  ('sync_runs', 90, 250000), ('integration_event_receipts', 30, 500000);

CREATE TABLE IF NOT EXISTS audit_cost_budgets (
  name TEXT PRIMARY KEY,
  period TEXT NOT NULL CHECK (period IN ('daily', 'monthly')),
  read_budget INTEGER,
  write_budget INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
