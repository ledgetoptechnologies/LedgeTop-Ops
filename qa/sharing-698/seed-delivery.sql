-- QA fixture for #698 (not for merge). Disposable seed for the DELIVERY_DB
-- (client-data) database, applied AFTER every migration in apps/client/migrations.
-- Every name, address and identifier is invented; mail domains are example.test.
-- Two client principals in two separate workspaces (plus one colleague who is a
-- member of both, used only for cursor binding checks), both unclaimed native
-- (project-alpha:primary) workspaces read through the private-ingress source pin.

-- Source authority: the private-ingress pin that Ops and Client both read.
INSERT INTO pa_portal_primary_private_authority(source_id,application_key,state,version)
VALUES ('project-alpha:primary','qa698-portal-app','active',1);

-- Workspaces. An AFTER INSERT trigger reserves pa_portal_workspace_sources(workspace_id,'project-alpha:primary',workspace_id).
INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,legacy_account_id,display_name,status,project_alpha_source_id)
VALUES ('qa698-workspace-alpha','standalone_client',NULL,'qa698-client-alpha',NULL,'Alpha Survey Co (QA)','active','project-alpha:primary'),
       ('qa698-workspace-bravo','organization','qa698-org-bravo',NULL,NULL,'Bravo Land Group (QA)','active','project-alpha:primary');

INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
VALUES ('qa698-gen-alpha','qa698-workspace-alpha','qa698-source-gen-1',1,'active',1,'2026-11-01 00:00:00'),
       ('qa698-gen-bravo','qa698-workspace-bravo','qa698-source-gen-1',1,'active',1,'2026-11-01 00:00:00');

INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
VALUES ('qa698-workspace-alpha','qa698-gen-alpha','standalone_client','qa698-client-alpha',NULL,'Alpha Survey Co (QA)','qa698-root-v1',1),
       ('qa698-workspace-alpha','qa698-gen-alpha','project','qa698-project-alpha','qa698-client-alpha','Alpha boundary survey (QA)','qa698-project-v1',1),
       ('qa698-workspace-bravo','qa698-gen-bravo','organization','qa698-org-bravo',NULL,'Bravo Land Group (QA)','qa698-root-v1',1);

INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
VALUES ('qa698-workspace-alpha','qa698-gen-alpha',1),('qa698-workspace-bravo','qa698-gen-bravo',1);

-- Client identities. issuer = CLIENT_ACCESS_TEAM_DOMAIN of the QA run; the
-- run-time minted Access assertion carries the same sub and email.
INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
VALUES ('qa698-identity-alpha','https://clients-access.example.test','qa698-subject-alpha','alpha.client@example.test','active'),
       ('qa698-identity-bravo','https://clients-access.example.test','qa698-subject-bravo','bravo.client@example.test','active'),
       ('qa698-identity-colleague','https://clients-access.example.test','qa698-subject-alpha-colleague','alpha.colleague@example.test','active');

INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
VALUES ('qa698-membership-alpha','qa698-workspace-alpha','qa698-identity-alpha','project_alpha','active','qa698-member-v1'),
       ('qa698-membership-bravo','qa698-workspace-bravo','qa698-identity-bravo','project_alpha','active','qa698-member-v1'),
       ('qa698-membership-colleague-a','qa698-workspace-alpha','qa698-identity-colleague','project_alpha','active','qa698-member-v1'),
       ('qa698-membership-colleague-b','qa698-workspace-bravo','qa698-identity-colleague','project_alpha','active','qa698-member-v1');

INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
VALUES ('qa698-workspace-alpha','qa698-principal-alpha','qa698-identity-alpha','alpha.client@example.test','Alpha Client (QA)','qa698-member-v1','active'),
       ('qa698-workspace-bravo','qa698-principal-bravo','qa698-identity-bravo','bravo.client@example.test','Bravo Client (QA)','qa698-member-v1','active'),
       ('qa698-workspace-alpha','qa698-principal-colleague-a','qa698-identity-colleague','alpha.colleague@example.test','Alpha Colleague (QA)','qa698-member-v1','active'),
       ('qa698-workspace-bravo','qa698-principal-colleague-b','qa698-identity-colleague','alpha.colleague@example.test','Alpha Colleague (QA)','qa698-member-v1','active');

INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,source_version,status,valid_from)
VALUES ('qa698-ent-alpha-workspace','qa698-workspace-alpha','qa698-identity-alpha','workspace.view','allow','workspace','qa698-workspace-alpha',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('qa698-ent-alpha-directory','qa698-workspace-alpha','qa698-identity-alpha','directory.read','allow','workspace','qa698-workspace-alpha',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('qa698-ent-alpha-delivery','qa698-workspace-alpha','qa698-identity-alpha','delivery.view','allow','workspace','qa698-workspace-alpha',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('qa698-ent-alpha-share','qa698-workspace-alpha','qa698-identity-alpha','delegated_share.create','allow','folder','qa698-binding-alpha-0001',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('qa698-ent-bravo-workspace','qa698-workspace-bravo','qa698-identity-bravo','workspace.view','allow','workspace','qa698-workspace-bravo',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('qa698-ent-bravo-directory','qa698-workspace-bravo','qa698-identity-bravo','directory.read','allow','workspace','qa698-workspace-bravo',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('qa698-ent-bravo-delivery','qa698-workspace-bravo','qa698-identity-bravo','delivery.view','allow','workspace','qa698-workspace-bravo',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       -- A colleague who can open both workspaces but holds no delegation: exercises cursor caller and workspace binding.
       ('qa698-ent-colleague-a-workspace','qa698-workspace-alpha','qa698-identity-colleague','workspace.view','allow','workspace','qa698-workspace-alpha',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('qa698-ent-colleague-b-workspace','qa698-workspace-bravo','qa698-identity-colleague','workspace.view','allow','workspace','qa698-workspace-bravo',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00');

-- #648 paging inputs: one delegation over four folder targets and three shares
-- in workspace alpha, so limit=2 produces two pages of each list kind.
INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
VALUES ('qa698-binding-alpha-0001','qa698-workspace-alpha','project','qa698-project-alpha','clients/qa698-alpha/boundary-survey/','project_alpha','qa698-binding-v1','active');

INSERT INTO client_share_folder_targets(id,workspace_id,folder_binding_id,binding_source_version,relative_prefix,staff_exact_root_approved,status,created_by_staff_id)
VALUES ('qa698-target-0000-root','qa698-workspace-alpha','qa698-binding-alpha-0001','qa698-binding-v1','',1,'active','qa698-staff-manager'),
       ('qa698-target-0001-phase','qa698-workspace-alpha','qa698-binding-alpha-0001','qa698-binding-v1','phase-1/',0,'active','qa698-staff-manager'),
       ('qa698-target-0002-phase','qa698-workspace-alpha','qa698-binding-alpha-0001','qa698-binding-v1','phase-2/',0,'active','qa698-staff-manager'),
       ('qa698-target-0003-phase','qa698-workspace-alpha','qa698-binding-alpha-0001','qa698-binding-v1','phase-3/',0,'active','qa698-staff-manager');

INSERT INTO client_share_folder_target_labels(target_id,workspace_id,display_name)
VALUES ('qa698-target-0000-root','qa698-workspace-alpha','Whole survey (QA)'),
       ('qa698-target-0001-phase','qa698-workspace-alpha','Phase 1 (QA)'),
       ('qa698-target-0002-phase','qa698-workspace-alpha','Phase 2 (QA)'),
       ('qa698-target-0003-phase','qa698-workspace-alpha','Phase 3 (QA)');

INSERT INTO client_share_delegations(id,workspace_id,identity_id,entitlement_id,entitlement_version,folder_binding_id,folder_binding_source_version,
  root_target_id,allow_exact_root,maximum_link_lifetime_seconds,require_password,delegation_version,status,expires_at,created_by_staff_id)
VALUES ('qa698-delegation-alpha-01','qa698-workspace-alpha','qa698-identity-alpha','qa698-ent-alpha-share',1,'qa698-binding-alpha-0001','qa698-binding-v1',
  'qa698-target-0000-root',1,604800,0,1,'active','2099-01-01T00:00:00Z','qa698-staff-manager');

INSERT INTO client_delegated_shares(id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,token_hash,share_version,label,
  expires_at,status,idempotency_key,request_fingerprint,created_at)
VALUES ('qa698-share-alpha-0001','qa698publicshare000000001','qa698-workspace-alpha','qa698-delegation-alpha-01','qa698-identity-alpha','qa698-target-0001-phase',
  'qa698tokenhashx0000000000000000000000000001',1,'Phase 1 link (QA)','2099-01-01T00:00:00Z','active','qa698-share-key-0001',
  'qa698fingerprint000000000000000000000000001','2026-11-03 00:00:00'),
       ('qa698-share-alpha-0002','qa698publicshare000000002','qa698-workspace-alpha','qa698-delegation-alpha-01','qa698-identity-alpha','qa698-target-0002-phase',
  'qa698tokenhashx0000000000000000000000000002',1,'Phase 2 link (QA)','2099-01-01T00:00:00Z','active','qa698-share-key-0002',
  'qa698fingerprint000000000000000000000000002','2026-11-02 00:00:00'),
       ('qa698-share-alpha-0003','qa698publicshare000000003','qa698-workspace-alpha','qa698-delegation-alpha-01','qa698-identity-alpha','qa698-target-0003-phase',
  'qa698tokenhashx0000000000000000000000000003',1,'Phase 3 link (QA)','2099-01-01T00:00:00Z','active','qa698-share-key-0003',
  'qa698fingerprint000000000000000000000000003','2026-11-01 00:00:00');
