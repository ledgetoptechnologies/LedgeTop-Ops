-- Fleet & flight logs (logs.ledgetop.app). Viewing is open to roles that are granted it; importing
-- OpenDroneLog backups is an owner/admin task. Flight logs are staff-only and never shown to clients.
INSERT OR IGNORE INTO permissions(key,description)
VALUES('flight_logs.view','View fleet and flight logs');
INSERT OR IGNORE INTO permissions(key,description)
VALUES('flight_logs.import','Import flight logs from OpenDroneLog backups');
INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT id,'flight_logs.view' FROM roles WHERE id IN('role-owner','role-admin');
INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT id,'flight_logs.import' FROM roles WHERE id IN('role-owner','role-admin');
