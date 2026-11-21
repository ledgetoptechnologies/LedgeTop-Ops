-- QA fixture for #698 (not for merge). Disposable seed for the OPS_DB
-- (ltds-ops) database, applied AFTER every migration in apps/operations/migrations.
-- Staff names and addresses are invented; mail domains are example.test.
-- Staff sign-in admission and login bindings are owned by the QA launcher;
-- this seed provides only the staff rows and their Viewer ACL.

INSERT INTO divisions(id,name,code,active) VALUES ('qa698-division-north','North (QA)','QA698N',1);

INSERT INTO staff_users(id,email,display_name,access_subject,status)
VALUES ('qa698-staff-manager','manager.qa698@example.test','Morgan Manager (QA)','qa698-staff-subject-manager','active'),
       ('qa698-staff-denied','denied.qa698@example.test','Dana Denied (QA)','qa698-staff-subject-denied','active'),
       ('qa698-staff-division','division.qa698@example.test','Devon Division (QA)','qa698-staff-subject-division','active');

INSERT INTO roles(id,name,description,immutable)
VALUES ('qa698-role-viewer-manager','QA698 Viewer manager','QA fixture: Viewer view and manage',0);
INSERT INTO role_permissions(role_id,permission_key)
VALUES ('qa698-role-viewer-manager','viewer.view'),('qa698-role-viewer-manager','viewer.manage');

-- Allowed: global Viewer view + manage.
-- Denied: the same global role, overridden by a global deny on viewer.manage.
-- Division-only: the role at division scope, which is not global authority.
INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
VALUES ('qa698-assign-manager','qa698-staff-manager','qa698-role-viewer-manager','global',NULL,'global',NULL),
       ('qa698-assign-denied','qa698-staff-denied','qa698-role-viewer-manager','global',NULL,'global',NULL),
       ('qa698-assign-division','qa698-staff-division','qa698-role-viewer-manager','division','qa698-division-north','qa698-division-north',NULL);

INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
VALUES ('qa698-override-denied','qa698-staff-denied','viewer.manage','deny','global',NULL,'global','qa698-staff-manager');
