-- QA fixture for #698 (not for merge). Disposable seed for the OPS_DB
-- (ltds-ops) database, applied AFTER every migration in apps/operations/migrations.
-- Staff names and addresses are invented; mail domains are example.test.
-- Every identifier is the UUID registered for its entity in contract.json
-- "entities"; a staff member's id is also its bound Access subject.
--
-- Authorization model (see README "Authorization model"):
--   reads  GET /api/viewer/direct-client-grants  need global viewer.view + viewer.manage (no deny);
--   writes POST/DELETE                            additionally pass the ordinary Ops administrator
--                                                 mutation gate (role-admin or role-owner, global) and CSRF.
-- staffAdmin                 role-admin, global                                       -> reads and writes allowed
-- staffViewerManager         Viewer-manager role, global (not an administrator)       -> reads allowed, writes 403 (administrator gate)
-- staffAdminViewerDenied     role-admin, global + deny override on viewer.manage      -> reads 403, writes 403 (Viewer permission)
-- staffDivision              Viewer-manager role at division scope only               -> reads 403 (no global authority)
-- Staff admission: migrations leave native_staff_access_reconciliation disabled
-- (enabled=0), so Access sign-in admits these active staff rows by email + subject.

INSERT INTO divisions(id,name,code,active) VALUES ('56c156c7-efc0-4a37-a0f6-9880a7e86708','North (QA)','QA698N',1);

INSERT INTO staff_users(id,email,display_name,access_subject,status)
VALUES ('416a153c-fe04-4f2b-af52-a44974d7989d','admin.qa698@example.test','Avery Admin (QA)','416a153c-fe04-4f2b-af52-a44974d7989d','active'),
       ('ab68633b-6b70-4d65-a349-372d734039cf','viewer.qa698@example.test','Morgan Viewer (QA)','ab68633b-6b70-4d65-a349-372d734039cf','active'),
       ('30e7a8de-7c83-4035-82af-d23e6c242e51','denied.qa698@example.test','Dana Denied (QA)','30e7a8de-7c83-4035-82af-d23e6c242e51','active'),
       ('686a1c08-ca89-4758-ab4b-884a54c27fb7','division.qa698@example.test','Devon Division (QA)','686a1c08-ca89-4758-ab4b-884a54c27fb7','active');

INSERT INTO roles(id,name,description,immutable)
VALUES ('cf102265-982a-495a-87ae-ff0427cbfbce','QA698 Viewer manager','QA fixture: Viewer view and manage, not an administrator',0);
INSERT INTO role_permissions(role_id,permission_key)
VALUES ('cf102265-982a-495a-87ae-ff0427cbfbce','viewer.view'),('cf102265-982a-495a-87ae-ff0427cbfbce','viewer.manage');

INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
VALUES ('f0ed2851-b38a-4a21-bf2c-5c5683c2c80d','416a153c-fe04-4f2b-af52-a44974d7989d','role-admin','global',NULL,'global',NULL),
       ('878637f5-483f-4cbb-8d75-68cccb6dc95d','ab68633b-6b70-4d65-a349-372d734039cf','cf102265-982a-495a-87ae-ff0427cbfbce','global',NULL,'global',NULL),
       ('ce588097-cdda-43ce-b2e3-acfacbe1e1bb','30e7a8de-7c83-4035-82af-d23e6c242e51','role-admin','global',NULL,'global',NULL),
       ('fd4e3784-8eda-4be0-8508-3572ce8be0ea','686a1c08-ca89-4758-ab4b-884a54c27fb7','cf102265-982a-495a-87ae-ff0427cbfbce','division','56c156c7-efc0-4a37-a0f6-9880a7e86708','56c156c7-efc0-4a37-a0f6-9880a7e86708',NULL);

INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
VALUES ('3a7d4f6a-1647-415b-94f8-289207cfbda8','30e7a8de-7c83-4035-82af-d23e6c242e51','viewer.manage','deny','global',NULL,'global','416a153c-fe04-4f2b-af52-a44974d7989d');
