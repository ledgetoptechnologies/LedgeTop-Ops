-- QA fixture for #698 (not for merge). Disposable seed for the DELIVERY_DB
-- (client-data) database, applied AFTER every migration in apps/client/migrations.
-- Every name, address and identifier is invented; mail domains are example.test.
-- Every identifier is the UUID registered for its entity in contract.json
-- "entities"; the same entity always uses the same UUID (a client's identity id
-- is also its Access subject). Two client principals in two separate workspaces
-- (plus one colleague who is a member of both, used only for cursor binding
-- checks), both unclaimed native (project-alpha:primary) workspaces read through
-- the private-ingress source pin.

-- Source authority: the private-ingress pin that Ops and Client both read.
INSERT INTO pa_portal_primary_private_authority(source_id,application_key,state,version)
VALUES ('project-alpha:primary','qa698-portal-app','active',1);

-- Workspaces. An AFTER INSERT trigger reserves pa_portal_workspace_sources(workspace_id,'project-alpha:primary',workspace_id).
INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,legacy_account_id,display_name,status,project_alpha_source_id)
VALUES ('1e56b7ab-2cbb-4def-87b7-c89b38054887','standalone_client',NULL,'181eac82-1539-4564-8bbe-ac4c31beec97',NULL,'Alpha Survey Co (QA)','active','project-alpha:primary'),
       ('7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','organization','2787b5a5-4549-4913-9c59-8e3c0e23e85e',NULL,NULL,'Bravo Land Group (QA)','active','project-alpha:primary');

INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
VALUES ('69882236-a344-40cd-b7cf-152ae5081d6d','1e56b7ab-2cbb-4def-87b7-c89b38054887','qa698-source-gen-1',1,'active',1,'2026-11-01 00:00:00'),
       ('fa45a2cc-0a72-437e-9c86-3f40102f0d79','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','qa698-source-gen-1',1,'active',1,'2026-11-01 00:00:00');

INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
VALUES ('1e56b7ab-2cbb-4def-87b7-c89b38054887','69882236-a344-40cd-b7cf-152ae5081d6d','standalone_client','181eac82-1539-4564-8bbe-ac4c31beec97',NULL,'Alpha Survey Co (QA)','qa698-root-v1',1),
       ('1e56b7ab-2cbb-4def-87b7-c89b38054887','69882236-a344-40cd-b7cf-152ae5081d6d','project','0a4f3fd5-c6f1-4396-ad08-a2eff7a6fa6c','181eac82-1539-4564-8bbe-ac4c31beec97','Alpha boundary survey (QA)','qa698-project-v1',1),
       ('7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','fa45a2cc-0a72-437e-9c86-3f40102f0d79','organization','2787b5a5-4549-4913-9c59-8e3c0e23e85e',NULL,'Bravo Land Group (QA)','qa698-root-v1',1);

INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
VALUES ('1e56b7ab-2cbb-4def-87b7-c89b38054887','69882236-a344-40cd-b7cf-152ae5081d6d',1),('7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','fa45a2cc-0a72-437e-9c86-3f40102f0d79',1);

-- Client identities. issuer = CLIENT_ACCESS_TEAM_DOMAIN of the QA run; the
-- in-process signer's assertion carries sub = the identity UUID and this email.
INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
VALUES ('8b57a414-a6e8-48a3-bff1-332b5b0f9025','https://clients-access.example.test','8b57a414-a6e8-48a3-bff1-332b5b0f9025','alpha.client@example.test','active'),
       ('656bb776-7bc0-45c5-85a7-509ffa5b58b1','https://clients-access.example.test','656bb776-7bc0-45c5-85a7-509ffa5b58b1','bravo.client@example.test','active'),
       ('e5332fb8-ff6f-43b0-b37a-c1240bd8b67b','https://clients-access.example.test','e5332fb8-ff6f-43b0-b37a-c1240bd8b67b','alpha.colleague@example.test','active');

INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
VALUES ('6b5c3682-9fc8-4431-8f40-b57b21bd38bf','1e56b7ab-2cbb-4def-87b7-c89b38054887','8b57a414-a6e8-48a3-bff1-332b5b0f9025','project_alpha','active','qa698-member-v1'),
       ('52c5b310-6b4b-4b70-bbd8-551b4daaa1ed','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','656bb776-7bc0-45c5-85a7-509ffa5b58b1','project_alpha','active','qa698-member-v1'),
       ('693f695f-c84a-406a-8fd5-36ccc1285d4c','1e56b7ab-2cbb-4def-87b7-c89b38054887','e5332fb8-ff6f-43b0-b37a-c1240bd8b67b','project_alpha','active','qa698-member-v1'),
       ('7c363739-a2fa-48ff-a85f-a3a4bac049f1','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','e5332fb8-ff6f-43b0-b37a-c1240bd8b67b','project_alpha','active','qa698-member-v1');

INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
VALUES ('1e56b7ab-2cbb-4def-87b7-c89b38054887','ab96b296-71b0-402a-ab3c-e46a7d902d8e','8b57a414-a6e8-48a3-bff1-332b5b0f9025','alpha.client@example.test','Alpha Client (QA)','qa698-member-v1','active'),
       ('7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','f4a25e20-24db-4770-bc10-e1c51034cd6a','656bb776-7bc0-45c5-85a7-509ffa5b58b1','bravo.client@example.test','Bravo Client (QA)','qa698-member-v1','active'),
       ('1e56b7ab-2cbb-4def-87b7-c89b38054887','15227954-f69f-4648-9c6b-1230857c2ee7','e5332fb8-ff6f-43b0-b37a-c1240bd8b67b','alpha.colleague@example.test','Alpha Colleague (QA)','qa698-member-v1','active'),
       ('7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','29033974-507f-491e-a3e0-57a14684b53d','e5332fb8-ff6f-43b0-b37a-c1240bd8b67b','alpha.colleague@example.test','Alpha Colleague (QA)','qa698-member-v1','active');

INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,source_version,status,valid_from)
VALUES ('cc04aa29-6cc7-475d-86cf-d396602abf85','1e56b7ab-2cbb-4def-87b7-c89b38054887','8b57a414-a6e8-48a3-bff1-332b5b0f9025','workspace.view','allow','workspace','1e56b7ab-2cbb-4def-87b7-c89b38054887',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('d704cde4-b34f-40f0-8b18-ec0f245e092c','1e56b7ab-2cbb-4def-87b7-c89b38054887','8b57a414-a6e8-48a3-bff1-332b5b0f9025','directory.read','allow','workspace','1e56b7ab-2cbb-4def-87b7-c89b38054887',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('ce7fe48b-f8a0-4fe3-96b7-eefee1047cc5','1e56b7ab-2cbb-4def-87b7-c89b38054887','8b57a414-a6e8-48a3-bff1-332b5b0f9025','delivery.view','allow','workspace','1e56b7ab-2cbb-4def-87b7-c89b38054887',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('392455be-218f-49d8-aa9d-9cb94081ac1d','1e56b7ab-2cbb-4def-87b7-c89b38054887','8b57a414-a6e8-48a3-bff1-332b5b0f9025','delegated_share.create','allow','folder','40d5d4ee-d4a8-4a6a-8575-3b467a5a3820',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('88d83a01-b571-4e71-8006-d6aa6e7d50eb','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','656bb776-7bc0-45c5-85a7-509ffa5b58b1','workspace.view','allow','workspace','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('711d7d2f-0c1f-44ba-a920-770aa0fd46b0','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','656bb776-7bc0-45c5-85a7-509ffa5b58b1','directory.read','allow','workspace','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('664eb32c-6046-4a89-a1a1-f0c476db17d1','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','656bb776-7bc0-45c5-85a7-509ffa5b58b1','delivery.view','allow','workspace','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       -- The colleague can open both workspaces but holds no delegation: exercises cursor caller and workspace binding.
       ('7322fcae-9cbf-4fc2-81a9-04d79c27aff2','1e56b7ab-2cbb-4def-87b7-c89b38054887','e5332fb8-ff6f-43b0-b37a-c1240bd8b67b','workspace.view','allow','workspace','1e56b7ab-2cbb-4def-87b7-c89b38054887',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00'),
       ('8e84c332-62e1-4fb9-b02b-0914da251733','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec','e5332fb8-ff6f-43b0-b37a-c1240bd8b67b','workspace.view','allow','workspace','7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec',1,'project_alpha','qa698-member-v1','active','2026-01-01 00:00:00');

-- #648 paging inputs: one delegation over four folder targets and three shares
-- in workspace alpha, so limit=2 produces two pages of each list kind.
INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
VALUES ('40d5d4ee-d4a8-4a6a-8575-3b467a5a3820','1e56b7ab-2cbb-4def-87b7-c89b38054887','project','0a4f3fd5-c6f1-4396-ad08-a2eff7a6fa6c','clients/1e56b7ab-2cbb-4def-87b7-c89b38054887/boundary-survey/','project_alpha','qa698-binding-v1','active');

-- Target ids sort as root < phase1 < phase2 < phase3 (keyset order); the
-- registry assigns them in that order.
INSERT INTO client_share_folder_targets(id,workspace_id,folder_binding_id,binding_source_version,relative_prefix,staff_exact_root_approved,status,created_by_staff_id)
VALUES ('13861c5e-2dd1-4d8b-9620-4c5ef5b7a25c','1e56b7ab-2cbb-4def-87b7-c89b38054887','40d5d4ee-d4a8-4a6a-8575-3b467a5a3820','qa698-binding-v1','',1,'active','416a153c-fe04-4f2b-af52-a44974d7989d'),
       ('2965452c-810e-4d38-ae77-ce03e7798955','1e56b7ab-2cbb-4def-87b7-c89b38054887','40d5d4ee-d4a8-4a6a-8575-3b467a5a3820','qa698-binding-v1','phase-1/',0,'active','416a153c-fe04-4f2b-af52-a44974d7989d'),
       ('87754c22-0c55-4121-ace6-306bb8eb04e7','1e56b7ab-2cbb-4def-87b7-c89b38054887','40d5d4ee-d4a8-4a6a-8575-3b467a5a3820','qa698-binding-v1','phase-2/',0,'active','416a153c-fe04-4f2b-af52-a44974d7989d'),
       ('cdc31025-8593-41ea-9767-3517dafa82bb','1e56b7ab-2cbb-4def-87b7-c89b38054887','40d5d4ee-d4a8-4a6a-8575-3b467a5a3820','qa698-binding-v1','phase-3/',0,'active','416a153c-fe04-4f2b-af52-a44974d7989d');

INSERT INTO client_share_folder_target_labels(target_id,workspace_id,display_name)
VALUES ('13861c5e-2dd1-4d8b-9620-4c5ef5b7a25c','1e56b7ab-2cbb-4def-87b7-c89b38054887','Whole survey (QA)'),
       ('2965452c-810e-4d38-ae77-ce03e7798955','1e56b7ab-2cbb-4def-87b7-c89b38054887','Phase 1 (QA)'),
       ('87754c22-0c55-4121-ace6-306bb8eb04e7','1e56b7ab-2cbb-4def-87b7-c89b38054887','Phase 2 (QA)'),
       ('cdc31025-8593-41ea-9767-3517dafa82bb','1e56b7ab-2cbb-4def-87b7-c89b38054887','Phase 3 (QA)');

INSERT INTO client_share_delegations(id,workspace_id,identity_id,entitlement_id,entitlement_version,folder_binding_id,folder_binding_source_version,
  root_target_id,allow_exact_root,maximum_link_lifetime_seconds,require_password,delegation_version,status,expires_at,created_by_staff_id)
VALUES ('b3e4d0b2-6730-4174-bd28-d4ce4dce22b3','1e56b7ab-2cbb-4def-87b7-c89b38054887','8b57a414-a6e8-48a3-bff1-332b5b0f9025','392455be-218f-49d8-aa9d-9cb94081ac1d',1,'40d5d4ee-d4a8-4a6a-8575-3b467a5a3820','qa698-binding-v1',
  '13861c5e-2dd1-4d8b-9620-4c5ef5b7a25c',1,604800,0,1,'active','2099-01-01T00:00:00Z','416a153c-fe04-4f2b-af52-a44974d7989d');

-- Shares list newest first: phase1 (Nov 3), phase2 (Nov 2), phase3 (Nov 1).
INSERT INTO client_delegated_shares(id,public_id,workspace_id,delegation_id,created_by_identity_id,folder_target_id,token_hash,share_version,label,
  expires_at,status,idempotency_key,request_fingerprint,created_at)
VALUES ('1f3a8059-3a73-4710-82ef-05bab36dbfda','9f6bd575-13bb-441e-8107-5a1bea676746','1e56b7ab-2cbb-4def-87b7-c89b38054887','b3e4d0b2-6730-4174-bd28-d4ce4dce22b3','8b57a414-a6e8-48a3-bff1-332b5b0f9025','2965452c-810e-4d38-ae77-ce03e7798955',
  'qa698tokenhashx0000000000000000000000000001',1,'Phase 1 link (QA)','2099-01-01T00:00:00Z','active','qa698-share-key-0001',
  'qa698fingerprint000000000000000000000000001','2026-11-03 00:00:00'),
       ('5a4c46af-8bba-4850-ac98-03f4a05bd7ff','611c1dc3-8994-4b82-82f9-a9f74f8c22bb','1e56b7ab-2cbb-4def-87b7-c89b38054887','b3e4d0b2-6730-4174-bd28-d4ce4dce22b3','8b57a414-a6e8-48a3-bff1-332b5b0f9025','87754c22-0c55-4121-ace6-306bb8eb04e7',
  'qa698tokenhashx0000000000000000000000000002',1,'Phase 2 link (QA)','2099-01-01T00:00:00Z','active','qa698-share-key-0002',
  'qa698fingerprint000000000000000000000000002','2026-11-02 00:00:00'),
       ('866a5436-0939-4862-9d9f-802e105c3f39','33af05dc-2fe9-4527-92bf-54d9562a1853','1e56b7ab-2cbb-4def-87b7-c89b38054887','b3e4d0b2-6730-4174-bd28-d4ce4dce22b3','8b57a414-a6e8-48a3-bff1-332b5b0f9025','cdc31025-8593-41ea-9767-3517dafa82bb',
  'qa698tokenhashx0000000000000000000000000003',1,'Phase 3 link (QA)','2099-01-01T00:00:00Z','active','qa698-share-key-0003',
  'qa698fingerprint000000000000000000000000003','2026-11-01 00:00:00');
