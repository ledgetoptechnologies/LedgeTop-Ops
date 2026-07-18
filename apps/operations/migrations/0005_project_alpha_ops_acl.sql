PRAGMA foreign_keys = OFF;

ALTER TABLE pa_application_entitlements RENAME TO pa_application_entitlements_legacy;

CREATE TABLE pa_application_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  application_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  role_key TEXT NOT NULL CHECK (role_key IN ('role-admin','role-operator','role-delivery-coordinator','role-division-manager')),
  business_unit_ids_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  last_event_at TEXT,
  last_sync_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO pa_application_entitlements (
  id,user_id,application_key,enabled,role_key,business_unit_ids_json,payload_json,
  last_event_at,last_sync_id,active,updated_at
)
SELECT
  id,user_id,application_key,enabled,role_key,business_unit_ids_json,payload_json,
  last_event_at,last_sync_id,active,updated_at
FROM pa_application_entitlements_legacy;

DROP TABLE pa_application_entitlements_legacy;

CREATE INDEX idx_pa_entitlements_enabled
ON pa_application_entitlements(enabled,active,user_id);

INSERT INTO roles (id,name,description,immutable)
VALUES ('role-admin','Administrator','Project Alpha administrator with global Operations access',1)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  description=excluded.description,
  immutable=1,
  updated_at=datetime('now');

INSERT OR IGNORE INTO role_permissions (role_id,permission_key)
SELECT 'role-admin',key FROM permissions;

DELETE FROM role_permissions
WHERE role_id IN ('role-operator','role-division-manager','role-delivery-coordinator')
  AND permission_key IN (
    'operations.manage',
    'tasks.create',
    'tasks.update',
    'delivery.browse',
    'delivery.share.create',
    'delivery.share.revoke',
    'delivery.share.audit',
    'team.view',
    'team.manage',
    'roles.manage',
    'integrations.manage',
    'audit.view'
  );

PRAGMA foreign_keys = ON;
