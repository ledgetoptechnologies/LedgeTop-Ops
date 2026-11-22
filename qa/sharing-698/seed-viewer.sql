-- QA fixture for #698 (not for merge). Disposable seed for the Viewer SQLite
-- database, applied AFTER every Viewer migration (schema 83,
-- provider_engine_processing_elapsed) with PRAGMA foreign_keys=ON.
-- Every identifier is the UUID registered for its entity in contract.json "entities".
--
-- One active project with one published task. The task's published model is a
-- Viewer-processed ('ltds-processing') model with one ready version:
--   - the published output is model_outputs.id = the version id, in the managed v2
--     layout <task>/<attempt>.v2 under the 'models' storage root;
--   - it has one published, hash-pinned GLB asset, whose bytes are the file listed in
--     viewer-manifest.json under viewer-storage/models/.
-- These rows are what the catalog (GET /api/v1/client-delivery-catalog and
-- /client-delivery-projects) and the published-session routes
-- (POST /api/v1/models/:id/sessions, DELETE /api/v1/published-sessions/source-authorization) read.
-- The provider is disabled and points at an example.test endpoint; nothing is processed.
--
-- Part 1 is the state the Viewer's processing ingest leaves for review. Part 2 applies
-- exactly the writes of ProcessingRepository.publishAttemptInTransaction(attempt, ['glb'])
-- in its order; viewer-readback.mjs checks Part 1 + the real function gives the same rows.

-- Part 1: ready for review.
INSERT INTO projects(id,display_name,description,metadata_json,default_units,status,created_by,created_at,updated_at,tags_json)
VALUES ('d0bb7e0a-f09c-48a4-8098-373b90b754df','Boundary survey (QA)',NULL,'{}','imperial','active','ops:qa698-fixture',
  '2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','[]');

INSERT INTO processing_providers(id,provider_type,display_name,endpoint,enabled,admission_limit,capabilities_json,created_at,updated_at)
VALUES ('67413c5d-3f8c-403a-a665-e4eba38544a5','nodeodm','QA698 provider (disabled)','https://nodeodm.example.test',0,1,'{}',
  '2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');

INSERT INTO datasets(id,project_id,display_name,source_type,storage_mode,root_key,relative_path,status,manifest_sha256,file_count,byte_size,
  metadata_json,created_by,created_at,updated_at,finalized_at,tags_json)
VALUES ('14729053-58d0-45fa-ab51-b8469b0b3559','d0bb7e0a-f09c-48a4-8098-373b90b754df','Boundary survey images (QA)','upload','managed','datasets','14729053-58d0-45fa-ab51-b8469b0b3559','finalized',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',0,0,'{}','ops:qa698-fixture',
  '2026-11-01T00:00:00.000Z','2026-11-01T00:01:00.000Z','2026-11-01T00:01:00.000Z','[]');

INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,description,status,active_attempt_id,published_model_id,metadata_json,created_by,created_at,updated_at)
VALUES ('54a404cf-93ba-4bfa-88d3-1a53d11647e0','d0bb7e0a-f09c-48a4-8098-373b90b754df','14729053-58d0-45fa-ab51-b8469b0b3559','Boundary survey model (QA)',NULL,'ready_for_review','b2ab737d-540b-45de-9ff8-b887af68ca07',NULL,'{}',
  'ops:qa698-fixture','2026-11-01T00:02:00.000Z','2026-11-01T00:11:00.000Z');

INSERT INTO models(id,provider,provider_model_id,display_name,status,active_version_id,metadata_json,created_at,updated_at)
VALUES ('c46ec866-c9ac-40e9-bdfd-fe884cf2f525','ltds-processing','54a404cf-93ba-4bfa-88d3-1a53d11647e0','Boundary survey model (QA)','importing',NULL,
  '{"projectId":"d0bb7e0a-f09c-48a4-8098-373b90b754df","projectName":"Boundary survey (QA)"}','2026-11-01T00:10:00.000Z','2026-11-01T00:10:00.000Z');

INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,metadata_json,georef_json,point_count,created_at,updated_at)
VALUES ('fe118cb6-5aec-4674-8e83-458c21d872db','c46ec866-c9ac-40e9-bdfd-fe884cf2f525','b2ab737d-540b-45de-9ff8-b887af68ca07','{"taskId":"54a404cf-93ba-4bfa-88d3-1a53d11647e0","attemptId":"b2ab737d-540b-45de-9ff8-b887af68ca07"}','importing',
  '{"sourceDatasetId":"14729053-58d0-45fa-ab51-b8469b0b3559"}','{}',NULL,'2026-11-01T00:10:00.000Z','2026-11-01T00:10:00.000Z');

INSERT INTO processing_attempts(id,task_id,attempt_number,provider_id,provider_task_id,preset_id,options_json,status,progress,created_by,
  created_at,updated_at,started_at,upstream_completed_at,ingested_at,completed_at,submission_phase,uploaded_file_count,
  result_model_id,result_model_version_id,dataset_id)
VALUES ('b2ab737d-540b-45de-9ff8-b887af68ca07','54a404cf-93ba-4bfa-88d3-1a53d11647e0',1,'67413c5d-3f8c-403a-a665-e4eba38544a5',NULL,NULL,'{}','ready_for_review',1,'ops:qa698-fixture',
  '2026-11-01T00:03:00.000Z','2026-11-01T00:11:00.000Z','2026-11-01T00:03:00.000Z','2026-11-01T00:09:00.000Z','2026-11-01T00:11:00.000Z',NULL,
  'committed',0,'c46ec866-c9ac-40e9-bdfd-fe884cf2f525','fe118cb6-5aec-4674-8e83-458c21d872db','14729053-58d0-45fa-ab51-b8469b0b3559');

INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,content_type,byte_size,created_at,storage_mode,published,source_attempt_id,sha256,manifest_sha256)
VALUES ('aed6b432-cd90-438b-8104-8a74bc4719d6','fe118cb6-5aec-4674-8e83-458c21d872db','glb','models','54a404cf-93ba-4bfa-88d3-1a53d11647e0/b2ab737d-540b-45de-9ff8-b887af68ca07.v2/source/odm_texturing/odm_textured_model_geo.glb',
  'glb',NULL,136,'2026-11-01T00:10:00.000Z','managed',0,'b2ab737d-540b-45de-9ff8-b887af68ca07','10a5dbf48f247640a5382c3b60d61096073cb8c5d1250f21253d30057583d378',NULL);

INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at)
VALUES ('fe118cb6-5aec-4674-8e83-458c21d872db','c46ec866-c9ac-40e9-bdfd-fe884cf2f525','54a404cf-93ba-4bfa-88d3-1a53d11647e0','b2ab737d-540b-45de-9ff8-b887af68ca07','d0bb7e0a-f09c-48a4-8098-373b90b754df','models',
  '54a404cf-93ba-4bfa-88d3-1a53d11647e0/b2ab737d-540b-45de-9ff8-b887af68ca07.v2','managed','ready',136,1,'2026-11-01T00:10:00.000Z','2026-11-01T00:11:00.000Z');

-- @@publication
-- Part 2: publication, the writes of publishAttemptInTransaction(attempt, ['glb'], {actorId: staff.admin}).
UPDATE model_assets SET published=0 WHERE version_id='fe118cb6-5aec-4674-8e83-458c21d872db';
UPDATE model_assets SET published=1 WHERE version_id='fe118cb6-5aec-4674-8e83-458c21d872db' AND kind IN ('glb');
UPDATE model_versions SET status='ready',updated_at='2026-11-01T00:12:00.000Z' WHERE id='fe118cb6-5aec-4674-8e83-458c21d872db';
UPDATE models SET active_version_id='fe118cb6-5aec-4674-8e83-458c21d872db',status='ready',unregistered_at=NULL,updated_at='2026-11-01T00:12:00.000Z' WHERE id='c46ec866-c9ac-40e9-bdfd-fe884cf2f525';
UPDATE processing_attempts SET status='published',completed_at=COALESCE(completed_at,'2026-11-01T00:12:00.000Z'),updated_at='2026-11-01T00:12:00.000Z'
  WHERE id='b2ab737d-540b-45de-9ff8-b887af68ca07' AND status='ready_for_review';
UPDATE processing_tasks SET status='published',published_model_id='c46ec866-c9ac-40e9-bdfd-fe884cf2f525',updated_at='2026-11-01T00:12:00.000Z'
  WHERE id='54a404cf-93ba-4bfa-88d3-1a53d11647e0' AND active_attempt_id='b2ab737d-540b-45de-9ff8-b887af68ca07';
UPDATE model_outputs SET status='published',updated_at='2026-11-01T00:12:00.000Z' WHERE id='fe118cb6-5aec-4674-8e83-458c21d872db' AND status='ready';
INSERT INTO audit_events(id,actor_type,actor_id,action,entity_type,entity_id,details_json,created_at)
VALUES ('490d4a3c-905e-4072-a3a6-eea5ef457923','admin','416a153c-fe04-4f2b-af52-a44974d7989d','processing_attempt.published','processing_attempt','b2ab737d-540b-45de-9ff8-b887af68ca07',
  '{"taskId":"54a404cf-93ba-4bfa-88d3-1a53d11647e0","modelId":"c46ec866-c9ac-40e9-bdfd-fe884cf2f525","modelVersionId":"fe118cb6-5aec-4674-8e83-458c21d872db","selectedAssetKinds":["glb"]}',
  '2026-11-01T00:12:00.000Z');
