PRAGMA foreign_keys = ON;

INSERT INTO divisions (id,name,code) VALUES ('division-chippewa-falls','Chippewa Falls','chippewa-falls');

INSERT INTO staff_users (id,email,display_name) VALUES ('staff-beau-koltz','beaukoltz@ledgetopdroneservices.com','Beau Koltz');
INSERT INTO staff_users (id,email,display_name) VALUES ('staff-kollins-stirn','kstirn@ledgetopdroneservices.com','Kollins Stirn');
INSERT INTO staff_divisions (staff_id,division_id,is_primary) VALUES ('staff-kollins-stirn','division-chippewa-falls',1);

INSERT INTO permissions (key,description) VALUES
 ('dashboard.view','View the operations dashboard'),('operations.view','View operations'),('operations.manage','Create and update operations'),
 ('projects.view','View projected projects'),('tasks.view','View tasks'),('tasks.create','Create tasks'),('tasks.update','Update tasks'),
 ('airspace.view','View TFR and special-use airspace awareness'),('delivery.browse','Browse client delivery files'),
 ('delivery.share.create','Create client delivery links'),('delivery.share.revoke','Revoke client delivery links'),('delivery.share.audit','View delivery access history'),
 ('team.view','View staff and divisions'),('team.manage','Manage staff and assignments'),('roles.manage','Manage roles and permissions'),
 ('integrations.manage','Manage integrations and synchronization'),('audit.view','View privileged audit history');

INSERT INTO roles (id,name,description,immutable) VALUES
 ('role-owner','Owner','Global business owner access',1),
 ('role-division-manager','Division Manager','Manage operations and delivery in assigned divisions',1),
 ('role-operator','Operator','Work assigned operations and tasks',1),
 ('role-delivery-coordinator','Delivery Coordinator','Manage delivery within assigned divisions',1);

INSERT INTO role_permissions (role_id,permission_key) SELECT 'role-owner',key FROM permissions;
INSERT INTO role_permissions (role_id,permission_key) VALUES
 ('role-division-manager','dashboard.view'),('role-division-manager','operations.view'),('role-division-manager','operations.manage'),
 ('role-division-manager','projects.view'),('role-division-manager','tasks.view'),('role-division-manager','tasks.create'),('role-division-manager','tasks.update'),
 ('role-division-manager','airspace.view'),('role-division-manager','delivery.browse'),('role-division-manager','delivery.share.create'),
 ('role-division-manager','delivery.share.revoke'),('role-division-manager','delivery.share.audit'),('role-division-manager','team.view');
INSERT INTO role_permissions (role_id,permission_key) VALUES
 ('role-operator','dashboard.view'),('role-operator','operations.view'),('role-operator','projects.view'),('role-operator','tasks.view'),
 ('role-operator','tasks.create'),('role-operator','tasks.update'),('role-operator','airspace.view');
INSERT INTO role_permissions (role_id,permission_key) VALUES
 ('role-delivery-coordinator','dashboard.view'),('role-delivery-coordinator','projects.view'),('role-delivery-coordinator','delivery.browse'),
 ('role-delivery-coordinator','delivery.share.create'),('role-delivery-coordinator','delivery.share.revoke'),('role-delivery-coordinator','delivery.share.audit');

INSERT INTO staff_role_assignments (id,staff_id,role_id,scope,division_id,scope_key) VALUES
 ('assignment-beau-owner','staff-beau-koltz','role-owner','global',NULL,'global'),
 ('assignment-kollins-manager','staff-kollins-stirn','role-division-manager','division','division-chippewa-falls','division-chippewa-falls');

INSERT INTO folder_rules (id,name,pattern,priority) VALUES
 ('rule-recurring','Recurring client folders','jobs/recurring/{client}/**',10),
 ('rule-year-client','One-off client folders','jobs/{year}/{client}/**',20);

INSERT INTO integration_health (integration,status) VALUES ('project-alpha','disabled'),('truenas','unknown'),('faa-tfr','unknown'),('faa-sua','unknown');
