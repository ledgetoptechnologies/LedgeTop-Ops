-- Company financial aggregates are a separate global privilege. Dashboard
-- access and ordinary business-directory access never imply financial access.
INSERT OR IGNORE INTO permissions(key,description)
VALUES('finance.summary.view','View company-wide Project Alpha financial aggregates');
INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT id,'finance.summary.view' FROM roles WHERE id IN('role-owner','role-admin');
