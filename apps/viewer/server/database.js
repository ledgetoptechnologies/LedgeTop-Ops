'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {TEST_SCHEMA:REFERENCE_CATALOG_PROJECTION_SCHEMA,installFunction:installReferenceCatalogIdentity}=require('./referenceCatalogProjection');

const MIGRATIONS = [
  {
    version: 1,
    name: 'viewer_registry',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed','unregistered')),
        active_version_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        unregistered_at TEXT,
        UNIQUE(provider, provider_model_id)
      );

      CREATE TABLE model_versions (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        provider_version_id TEXT NOT NULL,
        source_locator_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        georef_json TEXT NOT NULL DEFAULT '{}',
        point_count INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(model_id, provider_version_id)
      );

      CREATE INDEX model_versions_model_idx ON model_versions(model_id, created_at DESC);

      CREATE TABLE model_assets (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        format TEXT,
        content_type TEXT,
        byte_size INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(version_id, kind)
      );

      CREATE TABLE model_aliases (
        alias_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE import_jobs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        identifier TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        result_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        result_model_version_id TEXT REFERENCES model_versions(id) ON DELETE SET NULL,
        model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX import_jobs_status_idx ON import_jobs(status, created_at);

      CREATE TABLE public_shares (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        version_policy TEXT NOT NULL CHECK (version_policy IN ('latest','pinned')),
        model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
        public_id_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        permissions_json TEXT NOT NULL,
        label TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        revoked_by TEXT,
        revoke_reason TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT
      );

      CREATE INDEX public_shares_model_idx ON public_shares(model_id, created_at DESC);

      CREATE TABLE session_grants (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        subject TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('ops','client')),
        permissions_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX session_grants_expiry_idx ON session_grants(expires_at);

      CREATE TABLE service_nonces (
        key_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(key_id, nonce)
      );

      CREATE INDEX service_nonces_created_idx ON service_nonces(created_at);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);
      CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'application_state',
    sql: `
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'viewer_sessions',
    sql: `
      CREATE TABLE viewer_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
        subject TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('ops','client')),
        permissions_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX viewer_sessions_expiry_idx ON viewer_sessions(expires_at);
      CREATE INDEX viewer_sessions_model_idx ON viewer_sessions(model_id, expires_at);
    `,
  },
  {
    version: 4,
    name: 'service_idempotency',
    sql: `
      CREATE TABLE service_idempotency (
        key_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER,
        response_ciphertext TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(key_id, idempotency_key)
      );
      CREATE INDEX service_idempotency_expiry_idx ON service_idempotency(expires_at);
    `,
  },
  {
    version: 5,
    name: 'processing_platform',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        default_units TEXT NOT NULL DEFAULT 'imperial' CHECK(default_units IN ('imperial','metric')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX projects_page_idx ON projects(created_at DESC,id DESC);

      CREATE TABLE datasets (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        display_name TEXT NOT NULL,
        description TEXT,
        source_type TEXT NOT NULL DEFAULT 'upload',
        storage_mode TEXT NOT NULL CHECK(storage_mode IN ('managed','adopted','external_reference')),
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','finalizing','finalized','archived','trashed')),
        manifest_sha256 TEXT,
        file_count INTEGER NOT NULL DEFAULT 0,
        byte_size INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finalized_at TEXT,
        archived_at TEXT,
        trashed_at TEXT,
        UNIQUE(root_key, relative_path)
      );
      CREATE INDEX datasets_project_idx ON datasets(project_id, status, created_at DESC);
      CREATE INDEX datasets_page_idx ON datasets(created_at DESC,id DESC);
      CREATE INDEX datasets_project_page_idx ON datasets(project_id,created_at DESC,id DESC);

      CREATE TABLE dataset_files (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        content_type TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(dataset_id, relative_path)
      );
      CREATE INDEX dataset_files_dataset_idx ON dataset_files(dataset_id, relative_path);

      CREATE TABLE upload_sessions (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        expected_manifest_json TEXT NOT NULL,
        chunk_size INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','finalizing','complete','expired','cancelled')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX upload_sessions_expiry_idx ON upload_sessions(status, expires_at);

      CREATE TABLE upload_chunks (
        upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(upload_id, file_id, chunk_index)
      );

      CREATE TABLE processing_providers (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL CHECK(provider_type IN ('nodeodm','clusterodm')),
        display_name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        auth_env_key TEXT,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        admission_limit INTEGER NOT NULL DEFAULT 1 CHECK(admission_limit > 0),
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        capability_fingerprint TEXT,
        last_health TEXT,
        last_health_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX processing_providers_page_idx ON processing_providers(created_at DESC,id DESC);

      CREATE TABLE processing_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        options_json TEXT NOT NULL,
        provider_type TEXT,
        capability_fingerprint TEXT,
        built_in INTEGER NOT NULL DEFAULT 0 CHECK(built_in IN (0,1)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE processing_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        display_name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK(status IN ('draft','queued','processing','ready_for_review','published','failed','cancelled','archived')),
        active_attempt_id TEXT,
        published_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX processing_tasks_project_idx ON processing_tasks(project_id, status, created_at DESC);
      CREATE INDEX processing_tasks_page_idx ON processing_tasks(created_at DESC,id DESC);
      CREATE INDEX processing_tasks_project_page_idx ON processing_tasks(project_id,created_at DESC,id DESC);

      CREATE TABLE processing_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_number INTEGER NOT NULL,
        provider_id TEXT REFERENCES processing_providers(id) ON DELETE SET NULL,
        provider_task_id TEXT,
        preset_id TEXT REFERENCES processing_presets(id) ON DELETE SET NULL,
        options_json TEXT NOT NULL,
        capability_fingerprint TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting','derivatives','ready_for_review','published','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        provider_output_cursor INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        upstream_completed_at TEXT,
        ingested_at TEXT,
        completed_at TEXT,
        UNIQUE(task_id, attempt_number),
        UNIQUE(provider_id, provider_task_id)
      );
      CREATE INDEX processing_attempts_queue_idx ON processing_attempts(status, created_at);

      CREATE TABLE processing_jobs (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE CASCADE,
        job_type TEXT NOT NULL CHECK(job_type IN ('submit','reconcile','ingest')),
        status TEXT NOT NULL CHECK(status IN ('pending','leased','complete','failed','cancelled')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX processing_jobs_claim_idx ON processing_jobs(status, available_at, lease_expires_at);

      CREATE TABLE processing_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX processing_logs_attempt_idx ON processing_logs(attempt_id, created_at);

      CREATE TABLE derivative_jobs (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE CASCADE,
        derivative_type TEXT NOT NULL CHECK(derivative_type IN ('ept','mesh_tiles','lod_audit')),
        status TEXT NOT NULL CHECK(status IN ('pending','leased','complete','failed','cancelled')),
        request_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE admin_grants (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric')),
        expires_at TEXT NOT NULL,
        authorization_expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX admin_grants_expiry_idx ON admin_grants(expires_at);

      CREATE TABLE admin_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric')),
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);

      CREATE TABLE abuse_windows (
        bucket_key TEXT PRIMARY KEY,
        window_started_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL,
        blocked_until TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE admin_idempotency (
        session_id TEXT NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER,
        response_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(session_id, idempotency_key)
      );
      CREATE INDEX admin_idempotency_expiry_idx ON admin_idempotency(expires_at);

      CREATE TABLE dataset_import_previews (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_id TEXT,
        consumed_at TEXT,
        created_by TEXT,
        created_session_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE event_outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','leased','delivered','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX event_outbox_claim_idx ON event_outbox(status, available_at, lease_expires_at);

      CREATE TABLE storage_trash (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        purge_after TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        permanently_deleted_at TEXT
      );
      CREATE INDEX storage_trash_page_idx ON storage_trash(permanently_deleted_at,created_at DESC,id DESC);
      CREATE INDEX storage_trash_purge_idx ON storage_trash(purge_after, permanently_deleted_at);

      ALTER TABLE public_shares ADD COLUMN display_units TEXT CHECK(display_units IN ('imperial','metric'));
      ALTER TABLE session_grants ADD COLUMN display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric'));
      ALTER TABLE viewer_sessions ADD COLUMN display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric'));
      ALTER TABLE model_assets ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'external_reference'
        CHECK(storage_mode IN ('managed','adopted','external_reference'));
      ALTER TABLE model_assets ADD COLUMN published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0,1));
      ALTER TABLE model_assets ADD COLUMN source_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE SET NULL;
    `,
  },
  {
    version: 6,
    name: 'durable_dataset_operations',
    sql: `
      CREATE TABLE dataset_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('upload_finalize','import_adopt')),
        subject TEXT NOT NULL,
        session_id TEXT,
        dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        upload_id TEXT REFERENCES upload_sessions(id) ON DELETE SET NULL,
        import_preview_id TEXT REFERENCES dataset_import_previews(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX dataset_operations_claim_idx
        ON dataset_operations(status,available_at,lease_expires_at,created_at);
      CREATE INDEX dataset_operations_subject_idx
        ON dataset_operations(subject,created_at DESC,id DESC);
      CREATE UNIQUE INDEX dataset_operations_active_upload_idx
        ON dataset_operations(upload_id)
        WHERE upload_id IS NOT NULL AND status IN ('queued','leased','succeeded');
      CREATE UNIQUE INDEX dataset_operations_active_preview_idx
        ON dataset_operations(import_preview_id)
        WHERE import_preview_id IS NOT NULL AND status IN ('queued','leased','succeeded');
    `,
  },
  {
    version: 7,
    name: 'immutable_model_asset_manifests',
    sql: `
      ALTER TABLE model_assets ADD COLUMN sha256 TEXT;
      ALTER TABLE model_assets ADD COLUMN manifest_sha256 TEXT;
      CREATE TABLE model_asset_files (
        asset_id TEXT NOT NULL REFERENCES model_assets(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        PRIMARY KEY(asset_id,relative_path)
      );
      CREATE INDEX model_asset_files_asset_idx ON model_asset_files(asset_id,relative_path);
    `,
  },
  {
    version: 8,
    name: 'idempotent_derivative_jobs',
    sql: `
      DELETE FROM derivative_jobs
      WHERE rowid NOT IN (SELECT MIN(rowid) FROM derivative_jobs GROUP BY attempt_id,derivative_type);
      CREATE UNIQUE INDEX derivative_jobs_attempt_type_idx ON derivative_jobs(attempt_id,derivative_type);
    `,
  },
  {
    version: 9,
    name: 'storage_lifecycle_journal',
    sql: `
      CREATE TABLE storage_mutations (
        id TEXT PRIMARY KEY,
        mutation_type TEXT NOT NULL CHECK(mutation_type IN ('trash','restore','purge')),
        entity_type TEXT NOT NULL CHECK(entity_type='dataset'),
        entity_id TEXT NOT NULL,
        trash_id TEXT NOT NULL,
        source_root_key TEXT,
        source_relative_path TEXT,
        destination_root_key TEXT,
        destination_relative_path TEXT,
        allow_absent_source INTEGER NOT NULL DEFAULT 0 CHECK(allow_absent_source IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('intent','fs_applied','complete','failed')),
        actor TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE UNIQUE INDEX storage_mutations_active_entity_idx
        ON storage_mutations(entity_type,entity_id)
        WHERE status IN ('intent','fs_applied');
      CREATE INDEX storage_mutations_reconcile_idx ON storage_mutations(status,created_at);
      CREATE INDEX storage_mutations_trash_idx ON storage_mutations(trash_id,status);
      UPDATE storage_trash SET permanently_deleted_at=created_at
        WHERE permanently_deleted_at IS NULL AND rowid NOT IN (
          SELECT MAX(rowid) FROM storage_trash WHERE permanently_deleted_at IS NULL GROUP BY entity_type,entity_id
        );
      CREATE UNIQUE INDEX storage_trash_active_entity_idx
        ON storage_trash(entity_type,entity_id) WHERE permanently_deleted_at IS NULL;
    `,
  },
  {
    version: 10,
    name: 'processing_resume_tags_and_output_lifecycle',
    sql: `
      ALTER TABLE projects ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE datasets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE processing_attempts ADD COLUMN submission_phase TEXT NOT NULL DEFAULT 'new'
        CHECK(submission_phase IN ('new','initializing','initialized','uploading','uploading_auxiliary','uploaded','committing','committed'));
      ALTER TABLE processing_attempts ADD COLUMN uploaded_file_count INTEGER NOT NULL DEFAULT 0
        CHECK(uploaded_file_count >= 0);
      ALTER TABLE processing_attempts ADD COLUMN result_model_id TEXT REFERENCES models(id) ON DELETE SET NULL;
      ALTER TABLE processing_attempts ADD COLUMN result_model_version_id TEXT REFERENCES model_versions(id) ON DELETE SET NULL;

      CREATE TABLE model_outputs (
        id TEXT PRIMARY KEY REFERENCES model_versions(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        root_key TEXT NOT NULL DEFAULT 'models' CHECK(root_key='models'),
        relative_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ready','published','archived','trashed')),
        byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
        asset_count INTEGER NOT NULL DEFAULT 0 CHECK(asset_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        trashed_at TEXT,
        UNIQUE(root_key,relative_path)
      );
      CREATE INDEX model_outputs_page_idx ON model_outputs(created_at DESC,id DESC);
      CREATE INDEX model_outputs_project_page_idx ON model_outputs(project_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_task_page_idx ON model_outputs(task_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_status_page_idx ON model_outputs(status,created_at DESC,id DESC);
      INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,status,byte_size,asset_count,created_at,updated_at)
      SELECT v.id,v.model_id,a.task_id,a.id,t.project_id,'models',t.id||'/'||a.id,
        CASE WHEN a.status='published' THEN 'published' ELSE 'ready' END,
        COALESCE((SELECT SUM(COALESCE(ma.byte_size,0)) FROM model_assets ma WHERE ma.version_id=v.id),0),
        (SELECT COUNT(*) FROM model_assets ma WHERE ma.version_id=v.id),v.created_at,v.updated_at
      FROM model_versions v
      JOIN processing_attempts a ON a.result_model_version_id=v.id
      JOIN processing_tasks t ON t.id=a.task_id;

      DROP INDEX storage_mutations_active_entity_idx;
      DROP INDEX storage_mutations_reconcile_idx;
      DROP INDEX storage_mutations_trash_idx;
      ALTER TABLE storage_mutations RENAME TO storage_mutations_v9;
      CREATE TABLE storage_mutations (
        id TEXT PRIMARY KEY,
        mutation_type TEXT NOT NULL CHECK(mutation_type IN ('trash','restore','purge')),
        entity_type TEXT NOT NULL CHECK(entity_type IN ('dataset','output')),
        entity_id TEXT NOT NULL,
        trash_id TEXT NOT NULL,
        source_root_key TEXT,
        source_relative_path TEXT,
        destination_root_key TEXT,
        destination_relative_path TEXT,
        allow_absent_source INTEGER NOT NULL DEFAULT 0 CHECK(allow_absent_source IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('intent','fs_applied','complete','failed')),
        actor TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO storage_mutations SELECT * FROM storage_mutations_v9;
      DROP TABLE storage_mutations_v9;
      CREATE UNIQUE INDEX storage_mutations_active_entity_idx
        ON storage_mutations(entity_type,entity_id) WHERE status IN ('intent','fs_applied');
      CREATE INDEX storage_mutations_reconcile_idx ON storage_mutations(status,created_at);
      CREATE INDEX storage_mutations_trash_idx ON storage_mutations(trash_id,status);
    `,
  },
  {
    version: 11,
    name: 'gcp_workflow_and_dataset_image_index',
    sql: `
      ALTER TABLE dataset_files ADD COLUMN mime_type TEXT;
      ALTER TABLE dataset_files ADD COLUMN captured_at TEXT;
      ALTER TABLE dataset_files ADD COLUMN latitude REAL CHECK(latitude IS NULL OR (latitude >= -90 AND latitude <= 90));
      ALTER TABLE dataset_files ADD COLUMN longitude REAL CHECK(longitude IS NULL OR (longitude >= -180 AND longitude <= 180));
      ALTER TABLE dataset_files ADD COLUMN altitude_m REAL;
      ALTER TABLE dataset_files ADD COLUMN width INTEGER CHECK(width IS NULL OR width > 0);
      ALTER TABLE dataset_files ADD COLUMN height INTEGER CHECK(height IS NULL OR height > 0);
      UPDATE dataset_files SET
        mime_type=content_type,
        captured_at=CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.capturedAt') END,
        latitude=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.gps.latitude') IN ('integer','real')
          AND json_extract(metadata_json,'$.gps.latitude') BETWEEN -90 AND 90 THEN json_extract(metadata_json,'$.gps.latitude') END,
        longitude=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.gps.longitude') IN ('integer','real')
          AND json_extract(metadata_json,'$.gps.longitude') BETWEEN -180 AND 180 THEN json_extract(metadata_json,'$.gps.longitude') END,
        altitude_m=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.gps.altitudeM') IN ('integer','real') THEN json_extract(metadata_json,'$.gps.altitudeM') END,
        width=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.width')='integer'
          AND json_extract(metadata_json,'$.width') > 0 THEN json_extract(metadata_json,'$.width') END,
        height=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.height')='integer'
          AND json_extract(metadata_json,'$.height') > 0 THEN json_extract(metadata_json,'$.height') END;
      CREATE INDEX dataset_files_gps_idx ON dataset_files(dataset_id,latitude,longitude)
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

      CREATE TABLE gcp_sets (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        display_name TEXT NOT NULL,
        source_format TEXT NOT NULL CHECK(source_format IN ('generic-csv-v1','generic-geojson-v1')),
        source_file_id TEXT REFERENCES dataset_files(id) ON DELETE RESTRICT,
        source_filename TEXT,
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
        source_content TEXT NOT NULL,
        source_byte_size INTEGER NOT NULL CHECK(source_byte_size >= 0 AND source_byte_size <= 2097152),
        crs TEXT NOT NULL CHECK(crs='EPSG:4326'),
        elevation_units TEXT NOT NULL CHECK(elevation_units='m'),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX gcp_sets_dataset_idx ON gcp_sets(dataset_id,created_at DESC,id DESC);
      CREATE TRIGGER gcp_set_source_dataset_insert BEFORE INSERT ON gcp_sets
      WHEN NEW.source_file_id IS NOT NULL AND COALESCE((SELECT dataset_id FROM dataset_files WHERE id=NEW.source_file_id),'') <> NEW.dataset_id
      BEGIN SELECT RAISE(ABORT,'gcp_source_dataset_mismatch'); END;
      CREATE TRIGGER gcp_set_source_dataset_update BEFORE UPDATE OF dataset_id,source_file_id ON gcp_sets
      WHEN NEW.source_file_id IS NOT NULL AND COALESCE((SELECT dataset_id FROM dataset_files WHERE id=NEW.source_file_id),'') <> NEW.dataset_id
      BEGIN SELECT RAISE(ABORT,'gcp_source_dataset_mismatch'); END;

      CREATE TABLE gcp_points (
        id TEXT PRIMARY KEY,
        set_id TEXT NOT NULL REFERENCES gcp_sets(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        label TEXT NOT NULL,
        latitude REAL NOT NULL CHECK(latitude >= -90 AND latitude <= 90),
        longitude REAL NOT NULL CHECK(longitude >= -180 AND longitude <= 180),
        elevation_m REAL NOT NULL CHECK(elevation_m >= -12000 AND elevation_m <= 100000),
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(set_id,external_id)
      );
      CREATE INDEX gcp_points_set_idx ON gcp_points(set_id,external_id,id);

      CREATE TABLE gcp_image_correspondences (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        gcp_point_id TEXT NOT NULL REFERENCES gcp_points(id) ON DELETE CASCADE,
        dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id) ON DELETE RESTRICT,
        pixel_x REAL NOT NULL CHECK(pixel_x >= 0),
        pixel_y REAL NOT NULL CHECK(pixel_y >= 0),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id,gcp_point_id,dataset_file_id)
      );
      CREATE INDEX gcp_correspondences_task_idx ON gcp_image_correspondences(task_id,created_at,id);

      CREATE TRIGGER gcp_correspondence_dataset_insert
      BEFORE INSERT ON gcp_image_correspondences
      WHEN COALESCE((SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id),'') = ''
        OR COALESCE((SELECT sets.dataset_id FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id WHERE points.id=NEW.gcp_point_id),'') = ''
        OR COALESCE((SELECT dataset_id FROM dataset_files WHERE id=NEW.dataset_file_id),'') = ''
        OR (SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id) <>
          (SELECT sets.dataset_id FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id WHERE points.id=NEW.gcp_point_id)
        OR (SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id) <>
          (SELECT dataset_id FROM dataset_files WHERE id=NEW.dataset_file_id)
      BEGIN SELECT RAISE(ABORT,'gcp_dataset_mismatch'); END;

      CREATE TRIGGER gcp_correspondence_dataset_update
      BEFORE UPDATE OF task_id,gcp_point_id,dataset_file_id ON gcp_image_correspondences
      WHEN COALESCE((SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id),'') = ''
        OR COALESCE((SELECT sets.dataset_id FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id WHERE points.id=NEW.gcp_point_id),'') = ''
        OR COALESCE((SELECT dataset_id FROM dataset_files WHERE id=NEW.dataset_file_id),'') = ''
        OR (SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id) <>
          (SELECT sets.dataset_id FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id WHERE points.id=NEW.gcp_point_id)
        OR (SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id) <>
          (SELECT dataset_id FROM dataset_files WHERE id=NEW.dataset_file_id)
      BEGIN SELECT RAISE(ABORT,'gcp_dataset_mismatch'); END;

      CREATE TRIGGER gcp_correspondence_pixels_insert
      BEFORE INSERT ON gcp_image_correspondences
      WHEN ((SELECT width FROM dataset_files WHERE id=NEW.dataset_file_id) IS NOT NULL
          AND NEW.pixel_x >= (SELECT width FROM dataset_files WHERE id=NEW.dataset_file_id))
        OR ((SELECT height FROM dataset_files WHERE id=NEW.dataset_file_id) IS NOT NULL
          AND NEW.pixel_y >= (SELECT height FROM dataset_files WHERE id=NEW.dataset_file_id))
      BEGIN SELECT RAISE(ABORT,'gcp_pixel_out_of_bounds'); END;

      CREATE TRIGGER gcp_correspondence_pixels_update
      BEFORE UPDATE OF dataset_file_id,pixel_x,pixel_y ON gcp_image_correspondences
      WHEN ((SELECT width FROM dataset_files WHERE id=NEW.dataset_file_id) IS NOT NULL
          AND NEW.pixel_x >= (SELECT width FROM dataset_files WHERE id=NEW.dataset_file_id))
        OR ((SELECT height FROM dataset_files WHERE id=NEW.dataset_file_id) IS NOT NULL
          AND NEW.pixel_y >= (SELECT height FROM dataset_files WHERE id=NEW.dataset_file_id))
      BEGIN SELECT RAISE(ABORT,'gcp_pixel_out_of_bounds'); END;

      CREATE TABLE processing_attempt_gcp_snapshots (
        attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        content_text TEXT NOT NULL,
        correspondence_count INTEGER NOT NULL CHECK(correspondence_count > 0),
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 12,
    name: 'encrypted_processing_provider_credentials',
    sql: `
      ALTER TABLE processing_providers ADD COLUMN credential_ciphertext TEXT;
      ALTER TABLE processing_providers ADD COLUMN credential_key_id TEXT;
      ALTER TABLE processing_providers ADD COLUMN credential_updated_at TEXT;
      ALTER TABLE processing_providers ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0
        CHECK(credential_revision >= 0);
      ALTER TABLE processing_providers ADD COLUMN credential_cleared INTEGER NOT NULL DEFAULT 0
        CHECK(credential_cleared IN (0,1));
      ALTER TABLE processing_providers ADD COLUMN last_probe_credential_revision INTEGER;
    `,
  },
  {
    version: 13,
    name: 'durable_import_preview_operations',
    sql: `
      DROP INDEX dataset_operations_claim_idx;
      DROP INDEX dataset_operations_subject_idx;
      DROP INDEX dataset_operations_active_upload_idx;
      DROP INDEX dataset_operations_active_preview_idx;
      ALTER TABLE dataset_operations RENAME TO dataset_operations_v12;
      CREATE TABLE dataset_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('upload_finalize','import_preview','import_adopt')),
        subject TEXT NOT NULL,
        session_id TEXT,
        dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        upload_id TEXT REFERENCES upload_sessions(id) ON DELETE SET NULL,
        import_preview_id TEXT REFERENCES dataset_import_previews(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO dataset_operations SELECT * FROM dataset_operations_v12;
      DROP TABLE dataset_operations_v12;
      CREATE INDEX dataset_operations_claim_idx
        ON dataset_operations(status,available_at,lease_expires_at,created_at);
      CREATE INDEX dataset_operations_subject_idx
        ON dataset_operations(subject,created_at DESC,id DESC);
      CREATE UNIQUE INDEX dataset_operations_active_upload_idx
        ON dataset_operations(upload_id)
        WHERE upload_id IS NOT NULL AND status IN ('queued','leased','succeeded');
      CREATE UNIQUE INDEX dataset_operations_active_preview_idx
        ON dataset_operations(import_preview_id)
        WHERE import_preview_id IS NOT NULL AND status IN ('queued','leased','succeeded');
    `,
  },
  {
    version: 14,
    name: 'catalog_imports_presets_and_authorization',
    sql: `
      ALTER TABLE processing_presets ADD COLUMN description TEXT;
      UPDATE processing_presets SET options_json='{"orthophoto-resolution":2}' WHERE id='orthophoto';

      -- A task points at its current dataset, while every attempt retains the
      -- exact immutable dataset snapshot it processed. This is required when
      -- an externally referenced catalog source is rescanned into a new model
      -- version without changing the stable LTDS task identity.
      ALTER TABLE processing_attempts ADD COLUMN dataset_id TEXT REFERENCES datasets(id) ON DELETE RESTRICT;
      UPDATE processing_attempts
        SET dataset_id=(SELECT dataset_id FROM processing_tasks WHERE processing_tasks.id=processing_attempts.task_id)
        WHERE dataset_id IS NULL;
      CREATE INDEX processing_attempts_dataset_idx ON processing_attempts(dataset_id,created_at DESC);

      ALTER TABLE processing_providers ADD COLUMN runtime_health TEXT CHECK(runtime_health IN ('healthy','unhealthy'));
      ALTER TABLE processing_providers ADD COLUMN runtime_health_at TEXT;
      ALTER TABLE processing_providers ADD COLUMN runtime_health_error TEXT;
      ALTER TABLE processing_providers ADD COLUMN runtime_health_owner TEXT;
      ALTER TABLE processing_providers ADD COLUMN runtime_health_lease_expires_at TEXT;

      CREATE TABLE catalog_import_scans (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('webodm','terra')),
        generation INTEGER NOT NULL CHECK(generation > 0),
        candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
        created_by TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(provider,generation)
      );

      CREATE TABLE catalog_import_candidates (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('webodm','terra')),
        external_project_id TEXT NOT NULL,
        external_task_id TEXT NOT NULL,
        source_root_key TEXT NOT NULL CHECK(source_root_key IN ('webodm','terra_import')),
        source_relative_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        suggested_project_name TEXT NOT NULL,
        suggested_task_name TEXT NOT NULL,
        assets_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'unmapped' CHECK(state IN ('unmapped','mapped','stale')),
        stale_reason TEXT CHECK(stale_reason IN ('source_changed','not_seen')),
        scan_generation INTEGER NOT NULL CHECK(scan_generation > 0),
        last_seen_at TEXT NOT NULL,
        mapped_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        mapped_task_id TEXT REFERENCES processing_tasks(id) ON DELETE SET NULL,
        mapped_dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        mapped_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE SET NULL,
        mapped_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        mapped_model_version_id TEXT REFERENCES model_versions(id) ON DELETE SET NULL,
        mapped_source_fingerprint TEXT,
        mapped_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider,external_project_id,external_task_id,source_relative_path)
      );
      CREATE INDEX catalog_import_candidates_page_idx
        ON catalog_import_candidates(provider,state,updated_at DESC,id DESC);

      DROP INDEX model_outputs_page_idx;
      DROP INDEX model_outputs_project_page_idx;
      DROP INDEX model_outputs_task_page_idx;
      DROP INDEX model_outputs_status_page_idx;
      ALTER TABLE model_outputs RENAME TO model_outputs_v13;
      CREATE TABLE model_outputs (
        id TEXT PRIMARY KEY REFERENCES model_versions(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        storage_mode TEXT NOT NULL DEFAULT 'managed'
          CHECK(storage_mode IN ('managed','adopted','external_reference')),
        status TEXT NOT NULL CHECK(status IN ('ready','published','archived','trashed')),
        byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
        asset_count INTEGER NOT NULL DEFAULT 0 CHECK(asset_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        trashed_at TEXT,
        UNIQUE(root_key,relative_path)
      );
      INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at,archived_at,trashed_at)
        SELECT id,model_id,task_id,attempt_id,project_id,root_key,relative_path,'managed',status,byte_size,asset_count,created_at,updated_at,archived_at,trashed_at
        FROM model_outputs_v13;
      DROP TABLE model_outputs_v13;
      CREATE INDEX model_outputs_page_idx ON model_outputs(created_at DESC,id DESC);
      CREATE INDEX model_outputs_project_page_idx ON model_outputs(project_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_task_page_idx ON model_outputs(task_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_status_page_idx ON model_outputs(status,created_at DESC,id DESC);

      DROP INDEX dataset_operations_claim_idx;
      DROP INDEX dataset_operations_subject_idx;
      DROP INDEX dataset_operations_active_upload_idx;
      DROP INDEX dataset_operations_active_preview_idx;
      ALTER TABLE dataset_operations RENAME TO dataset_operations_v13;
      CREATE TABLE dataset_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('upload_finalize','import_preview','import_adopt','catalog_scan','catalog_map')),
        subject TEXT NOT NULL,
        session_id TEXT,
        dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        upload_id TEXT REFERENCES upload_sessions(id) ON DELETE SET NULL,
        import_preview_id TEXT REFERENCES dataset_import_previews(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO dataset_operations SELECT * FROM dataset_operations_v13;
      DROP TABLE dataset_operations_v13;
      CREATE INDEX dataset_operations_claim_idx
        ON dataset_operations(status,available_at,lease_expires_at,created_at);
      CREATE INDEX dataset_operations_subject_idx
        ON dataset_operations(subject,created_at DESC,id DESC);
      CREATE UNIQUE INDEX dataset_operations_active_upload_idx
        ON dataset_operations(upload_id)
        WHERE upload_id IS NOT NULL AND status IN ('queued','leased','succeeded');
      CREATE UNIQUE INDEX dataset_operations_active_preview_idx
        ON dataset_operations(import_preview_id)
        WHERE import_preview_id IS NOT NULL AND status IN ('queued','leased','succeeded');

      ALTER TABLE public_shares ADD COLUMN source_authorization_id TEXT;
      ALTER TABLE public_shares ADD COLUMN source_authorization_version TEXT;
      ALTER TABLE public_shares ADD COLUMN source_authorization_subject TEXT;
      ALTER TABLE public_shares ADD COLUMN source_authorization_expires_at TEXT;
      ALTER TABLE public_shares ADD COLUMN source_authorization_revoked_at TEXT;
      ALTER TABLE public_shares ADD COLUMN share_class TEXT NOT NULL DEFAULT 'staff' CHECK(share_class IN ('staff','client'));
      CREATE INDEX public_shares_source_authorization_idx
        ON public_shares(source_authorization_id,source_authorization_version);

      CREATE TABLE model_asset_chunks (
        asset_id TEXT NOT NULL REFERENCES model_assets(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
        byte_size INTEGER NOT NULL CHECK(byte_size > 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        PRIMARY KEY(asset_id,relative_path,chunk_index)
      );
      CREATE INDEX model_asset_chunks_lookup_idx ON model_asset_chunks(asset_id,relative_path,byte_offset);

      CREATE TABLE task_submissions (
        subject TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        task_id TEXT NOT NULL UNIQUE REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(subject,submission_id)
      );

      CREATE TABLE subject_operation_receipts (
        subject TEXT NOT NULL,
        client_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        response_status INTEGER,
        response_json TEXT,
        operation_id TEXT REFERENCES dataset_operations(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(subject,client_key)
      );
      CREATE INDEX subject_operation_receipts_operation_idx ON subject_operation_receipts(operation_id);
    `,
  },
  {
    version: 15,
    name: 'unpublished_review_sessions',
    sql: `
      ALTER TABLE session_grants ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'published'
        CHECK(session_mode IN ('published','review'));
      ALTER TABLE session_grants ADD COLUMN model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT;
      ALTER TABLE session_grants ADD COLUMN review_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE CASCADE;
      CREATE INDEX session_grants_review_attempt_idx
        ON session_grants(review_attempt_id,subject,expires_at);

      ALTER TABLE viewer_sessions ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'published'
        CHECK(session_mode IN ('published','review'));
      ALTER TABLE viewer_sessions ADD COLUMN review_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE CASCADE;
      CREATE INDEX viewer_sessions_review_attempt_idx
        ON viewer_sessions(review_attempt_id,subject,expires_at);
    `,
  },
  {
    version: 16,
    name: 'processing_roles_and_staged_outputs',
    sql: `
      ALTER TABLE dataset_files ADD COLUMN processing_role TEXT NOT NULL DEFAULT 'auto'
        CHECK(processing_role IN ('auto','image','gcp_source','provider_input','administrative'));
      UPDATE dataset_files SET processing_role=CASE
        WHEN lower(relative_path) GLOB '*.csv' THEN 'gcp_source'
        WHEN lower(relative_path) GLOB '*.jpg' OR lower(relative_path) GLOB '*.jpeg'
          OR lower(relative_path) GLOB '*.png' OR lower(relative_path) GLOB '*.tif'
          OR lower(relative_path) GLOB '*.tiff' OR lower(relative_path) GLOB '*.dng'
          OR lower(relative_path) GLOB '*.raw' OR lower(relative_path) GLOB '*.heic'
          THEN 'image'
        ELSE 'auto'
      END;

      DROP INDEX model_outputs_page_idx;
      DROP INDEX model_outputs_project_page_idx;
      DROP INDEX model_outputs_task_page_idx;
      DROP INDEX model_outputs_status_page_idx;
      ALTER TABLE model_outputs RENAME TO model_outputs_v15;
      CREATE TABLE model_outputs (
        id TEXT PRIMARY KEY REFERENCES model_versions(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        storage_mode TEXT NOT NULL DEFAULT 'managed'
          CHECK(storage_mode IN ('managed','adopted','external_reference')),
        status TEXT NOT NULL CHECK(status IN ('staged','ready','published','failed','archived','trashed')),
        byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
        asset_count INTEGER NOT NULL DEFAULT 0 CHECK(asset_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        trashed_at TEXT,
        UNIQUE(root_key,relative_path)
      );
      INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at,archived_at,trashed_at)
        SELECT id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at,archived_at,trashed_at
        FROM model_outputs_v15;
      UPDATE model_outputs SET status='failed'
        WHERE status='ready'
          AND attempt_id IN (SELECT id FROM processing_attempts WHERE status IN ('failed','cancelled'))
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_outputs.model_id AND models.active_version_id=model_outputs.id);
      UPDATE model_versions SET status='failed'
        WHERE id IN (SELECT id FROM model_outputs WHERE status='failed')
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_versions.model_id AND models.active_version_id=model_versions.id);
      UPDATE model_outputs SET status='staged'
        WHERE status='ready'
          AND attempt_id IN (SELECT id FROM processing_attempts WHERE status IN ('ingesting','derivatives'))
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_outputs.model_id AND models.active_version_id=model_outputs.id);
      UPDATE model_versions SET status='importing'
        WHERE id IN (SELECT id FROM model_outputs WHERE status='staged')
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_versions.model_id AND models.active_version_id=model_versions.id);
      DROP TABLE model_outputs_v15;
      CREATE INDEX model_outputs_page_idx ON model_outputs(created_at DESC,id DESC);
      CREATE INDEX model_outputs_project_page_idx ON model_outputs(project_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_task_page_idx ON model_outputs(task_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_status_page_idx ON model_outputs(status,created_at DESC,id DESC);
      CREATE TABLE task_draft_requests (
        subject TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(subject,submission_id)
      );
      CREATE TRIGGER processing_attempt_output_failed
      AFTER UPDATE OF status ON processing_attempts
      WHEN NEW.status IN ('failed','cancelled') AND NEW.result_model_version_id IS NOT NULL
      BEGIN
        UPDATE model_outputs SET status='failed',updated_at=NEW.updated_at
          WHERE id=NEW.result_model_version_id AND attempt_id=NEW.id AND status IN ('staged','ready');
        UPDATE model_versions SET status='failed',updated_at=NEW.updated_at
          WHERE id=NEW.result_model_version_id AND model_id=NEW.result_model_id
            AND EXISTS (SELECT 1 FROM model_outputs WHERE id=NEW.result_model_version_id AND status='failed')
            AND NOT EXISTS (SELECT 1 FROM models WHERE id=NEW.result_model_id AND active_version_id=NEW.result_model_version_id);
        UPDATE models SET status='failed',updated_at=NEW.updated_at
          WHERE id=NEW.result_model_id AND active_version_id IS NULL
            AND EXISTS (SELECT 1 FROM model_outputs WHERE id=NEW.result_model_version_id AND status='failed');
      END;
      CREATE TRIGGER storage_mutation_audit_complete
      AFTER UPDATE OF status ON storage_mutations
      WHEN OLD.status<>'complete' AND NEW.status='complete'
      BEGIN
        INSERT INTO audit_events(id,actor_type,actor_id,action,entity_type,entity_id,details_json,created_at)
        VALUES (lower(hex(randomblob(16))),'admin',NEW.actor,
          NEW.entity_type||'.'||CASE NEW.mutation_type WHEN 'trash' THEN 'trashed' WHEN 'restore' THEN 'restored' ELSE 'purged' END,
          NEW.entity_type,NEW.entity_id,
          json_object('mutationId',NEW.id,'trashId',NEW.trash_id),NEW.updated_at);
      END;
    `,
  },
  {
    version: 17,
    name: 'published_session_source_authorizations',
    sql: `
      ALTER TABLE session_grants ADD COLUMN source_authorization_type TEXT
        CHECK(source_authorization_type IS NULL OR source_authorization_type='model_association');
      ALTER TABLE session_grants ADD COLUMN source_authorization_id TEXT;
      ALTER TABLE session_grants ADD COLUMN source_authorization_version INTEGER
        CHECK(source_authorization_version IS NULL OR source_authorization_version >= 1);
      CREATE INDEX session_grants_source_authorization_idx
        ON session_grants(source_authorization_type,source_authorization_id,source_authorization_version,session_mode,redeemed_at)
        WHERE source_authorization_id IS NOT NULL;

      ALTER TABLE viewer_sessions ADD COLUMN source_authorization_type TEXT
        CHECK(source_authorization_type IS NULL OR source_authorization_type='model_association');
      ALTER TABLE viewer_sessions ADD COLUMN source_authorization_id TEXT;
      ALTER TABLE viewer_sessions ADD COLUMN source_authorization_version INTEGER
        CHECK(source_authorization_version IS NULL OR source_authorization_version >= 1);
      CREATE INDEX viewer_sessions_source_authorization_idx
        ON viewer_sessions(source_authorization_type,source_authorization_id,source_authorization_version,session_mode,revoked_at,expires_at)
        WHERE source_authorization_id IS NOT NULL;
      CREATE TABLE revoked_published_session_authorizations (
        source_authorization_type TEXT NOT NULL CHECK(source_authorization_type='model_association'),
        source_authorization_id TEXT NOT NULL,
        source_authorization_version INTEGER NOT NULL CHECK(source_authorization_version >= 1),
        revoked_at TEXT NOT NULL,
        revoked_by TEXT,
        PRIMARY KEY(source_authorization_type,source_authorization_id,source_authorization_version)
      );
      CREATE TRIGGER session_grants_source_authorization_complete_insert
      BEFORE INSERT ON session_grants
      WHEN (NEW.source_authorization_type IS NULL) + (NEW.source_authorization_id IS NULL)
        + (NEW.source_authorization_version IS NULL) NOT IN (0,3)
      BEGIN SELECT RAISE(ABORT,'source_authorization_incomplete'); END;
      CREATE TRIGGER session_grants_source_authorization_immutable
      BEFORE UPDATE OF source_authorization_type,source_authorization_id,source_authorization_version ON session_grants
      WHEN NEW.source_authorization_type IS NOT OLD.source_authorization_type
        OR NEW.source_authorization_id IS NOT OLD.source_authorization_id
        OR NEW.source_authorization_version IS NOT OLD.source_authorization_version
      BEGIN SELECT RAISE(ABORT,'source_authorization_immutable'); END;
      CREATE TRIGGER viewer_sessions_source_authorization_complete_insert
      BEFORE INSERT ON viewer_sessions
      WHEN (NEW.source_authorization_type IS NULL) + (NEW.source_authorization_id IS NULL)
        + (NEW.source_authorization_version IS NULL) NOT IN (0,3)
      BEGIN SELECT RAISE(ABORT,'source_authorization_incomplete'); END;
      CREATE TRIGGER viewer_sessions_source_authorization_immutable
      BEFORE UPDATE OF source_authorization_type,source_authorization_id,source_authorization_version ON viewer_sessions
      WHEN NEW.source_authorization_type IS NOT OLD.source_authorization_type
        OR NEW.source_authorization_id IS NOT OLD.source_authorization_id
        OR NEW.source_authorization_version IS NOT OLD.source_authorization_version
      BEGIN SELECT RAISE(ABORT,'source_authorization_immutable'); END;

      -- Existing grants/sessions cannot be safely attributed to a model
      -- association. Fail closed instead of inventing an authorization source.
      DELETE FROM session_grants
        WHERE session_mode='published' AND redeemed_at IS NULL
          AND source_authorization_id IS NULL;
      UPDATE viewer_sessions SET revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
        WHERE session_mode='published' AND revoked_at IS NULL
          AND datetime(expires_at)>datetime('now') AND source_authorization_id IS NULL;
    `,
  },
  {
    version: 18,
    name: 'durable_webodm_task_migrations',
    sql: `
      CREATE TABLE webodm_task_imports (
        id TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL UNIQUE CHECK(length(source_fingerprint)=64),
        source_relative_path TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
        asset_kinds_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX webodm_task_imports_project_idx ON webodm_task_imports(project_id,created_at DESC);
    `,
  },
  {
    version: 19,
    name: 'gcp_provenance_ranking_and_snapshot_integrity',
    sql: `
      CREATE TABLE gcp_import_provenance (
        set_id TEXT PRIMARY KEY REFERENCES gcp_sets(id) ON DELETE CASCADE,
        adapter TEXT NOT NULL,
        coordinate_system TEXT NOT NULL,
        vertical_datum TEXT NOT NULL,
        linear_unit TEXT NOT NULL CHECK(linear_unit IN ('m','ftUS')),
        elevation_source TEXT,
        geographic_cross_check TEXT,
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
        confirmed_by TEXT,
        confirmed_at TEXT NOT NULL
      );
      ALTER TABLE gcp_points ADD COLUMN easting REAL;
      ALTER TABLE gcp_points ADD COLUMN northing REAL;
      ALTER TABLE gcp_points ADD COLUMN ellipsoidal_height_m REAL;
      CREATE TABLE gcp_image_ranking_metadata (
        dataset_file_id TEXT PRIMARY KEY REFERENCES dataset_files(id) ON DELETE CASCADE,
        horizontal_accuracy_m REAL CHECK(horizontal_accuracy_m IS NULL OR horizontal_accuracy_m >= 0),
        heading_deg REAL CHECK(heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
        field_of_view_deg REAL CHECK(field_of_view_deg IS NULL OR (field_of_view_deg > 0 AND field_of_view_deg < 180)),
        footprint_radius_m REAL CHECK(footprint_radius_m IS NULL OR footprint_radius_m > 0),
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER processing_attempt_gcp_snapshot_no_update
      BEFORE UPDATE ON processing_attempt_gcp_snapshots
      BEGIN SELECT RAISE(ABORT,'gcp_snapshot_immutable'); END;
      CREATE TRIGGER processing_attempt_gcp_snapshot_no_delete
      BEFORE DELETE ON processing_attempt_gcp_snapshots
      WHEN EXISTS (SELECT 1 FROM processing_attempts WHERE id=OLD.attempt_id)
      BEGIN SELECT RAISE(ABORT,'gcp_snapshot_immutable'); END;
    `,
  },
  {
    version: 20,
    name: 'public_project_shares',
    sql: `
      CREATE TABLE public_project_shares (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        public_id_hash TEXT NOT NULL UNIQUE CHECK(length(public_id_hash)=64),
        password_hash TEXT,
        permissions_json TEXT NOT NULL,
        label TEXT,
        version_policy TEXT NOT NULL DEFAULT 'active'
          CHECK(version_policy='active'),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        display_units TEXT NOT NULL DEFAULT 'imperial'
          CHECK(display_units IN ('imperial','metric')),
        revoked_at TEXT,
        revoked_by TEXT,
        revoke_reason TEXT,
        access_count INTEGER NOT NULL DEFAULT 0 CHECK(access_count >= 0),
        last_accessed_at TEXT
      );
      CREATE INDEX public_project_shares_project_idx
        ON public_project_shares(project_id,created_at DESC);
      CREATE INDEX public_project_shares_live_idx
        ON public_project_shares(project_id,revoked_at,expires_at);
    `,
  },
  {
    version: 21,
    name: 'camera_photo_links',
    sql: `
      CREATE TABLE model_camera_photos (
        version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_type TEXT NOT NULL CHECK(content_type='image/jpeg'),
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        created_at TEXT NOT NULL,
        PRIMARY KEY(version_id,filename)
      );
      CREATE INDEX model_camera_photos_version_idx
        ON model_camera_photos(version_id,filename);
    `,
  },
  {
    version: 22,
    name: 'container_trash_members',
    sql: `
      CREATE TABLE container_trash_members (
        container_trash_id TEXT NOT NULL REFERENCES storage_trash(id) ON DELETE RESTRICT,
        member_trash_id TEXT NOT NULL REFERENCES storage_trash(id) ON DELETE RESTRICT,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('project','task','dataset','output')),
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(container_trash_id,member_trash_id),
        UNIQUE(container_trash_id,entity_type,entity_id)
      );
      CREATE INDEX container_trash_members_member_idx ON container_trash_members(member_trash_id);
    `,
  },
  {
    version: 23,
    name: 'lod_derivative_recovery_revision',
    sql: `
      ALTER TABLE derivative_jobs ADD COLUMN recovery_revision INTEGER NOT NULL DEFAULT 0
        CHECK(recovery_revision >= 0);
      ALTER TABLE derivative_jobs ADD COLUMN recovery_requeued_at TEXT;
      CREATE INDEX derivative_jobs_lod_recovery_idx
        ON derivative_jobs(recovery_revision,updated_at,id)
        WHERE derivative_type IN ('mesh_tiles','lod_audit')
          AND status IN ('failed','complete');
    `,
  },
  {
    version: 24,
    name: 'recoverable_container_delete_state',
    sql: `
      ALTER TABLE storage_trash ADD COLUMN original_status TEXT;
      ALTER TABLE storage_mutations ADD COLUMN original_status TEXT;
      ALTER TABLE projects ADD COLUMN purged_at TEXT;
      ALTER TABLE processing_tasks ADD COLUMN purged_at TEXT;
      UPDATE storage_trash
        SET original_status=CASE
          WHEN entity_type='project' THEN 'active'
          WHEN entity_type='task' THEN NULLIF(relative_path,'')
          WHEN entity_type IN ('dataset','output') THEN 'archived'
          ELSE NULL
        END
        WHERE original_status IS NULL;
      CREATE INDEX projects_active_page_idx
        ON projects(purged_at,status,created_at DESC,id DESC);
      CREATE INDEX processing_tasks_active_page_idx
        ON processing_tasks(purged_at,status,created_at DESC,id DESC);
    `,
  },
  {
    version: 25,
    name: 'allow_duplicate_webodm_import_fingerprints',
    sql: `
      DROP INDEX webodm_task_imports_project_idx;
      ALTER TABLE webodm_task_imports RENAME TO webodm_task_imports_v18;
      CREATE TABLE webodm_task_imports (
        id TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64),
        source_relative_path TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
        asset_kinds_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO webodm_task_imports(
        id,source_fingerprint,source_relative_path,project_id,task_id,dataset_id,
        attempt_id,model_id,model_version_id,asset_kinds_json,created_by,created_at
      ) SELECT
        id,source_fingerprint,source_relative_path,project_id,task_id,dataset_id,
        attempt_id,model_id,model_version_id,asset_kinds_json,created_by,created_at
      FROM webodm_task_imports_v18;
      DROP TABLE webodm_task_imports_v18;
      CREATE INDEX webodm_task_imports_project_idx
        ON webodm_task_imports(project_id,created_at DESC);
      CREATE INDEX webodm_task_imports_fingerprint_idx
        ON webodm_task_imports(source_fingerprint,created_at DESC,id DESC);
    `,
  },
  {
    version: 26,
    name: 'bound_camera_photo_reconciliation',
    sql: `
      CREATE TABLE camera_photo_reconciliation_state (
        version_id TEXT PRIMARY KEY REFERENCES model_versions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('terminal','retry')),
        reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 80),
        attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count BETWEEN 1 AND 1000000),
        next_attempt_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK((status='terminal' AND next_attempt_at IS NULL) OR (status='retry' AND next_attempt_at IS NOT NULL))
      );
      CREATE INDEX camera_photo_reconciliation_retry_idx
        ON camera_photo_reconciliation_state(status,next_attempt_at,version_id);
    `,
  },
  {
    version: 27,
    name: 'fenced_lod_conversion_singleton',
    sql: `
      ALTER TABLE derivative_jobs ADD COLUMN lease_token TEXT;
      ALTER TABLE derivative_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK(attempt_count >= 0);
      ALTER TABLE derivative_jobs ADD COLUMN first_started_at TEXT;
      ALTER TABLE derivative_jobs ADD COLUMN deadline_at TEXT;

      -- A rolling upgrade can expose more than one lease created by the old
      -- worker. Keep the longest-lived lease and fence every other old claim
      -- before installing the database-level singleton invariant.
      UPDATE derivative_jobs SET
        status='pending',lease_owner=NULL,lease_token=NULL,
        lease_expires_at=NULL,heartbeat_at=NULL
      WHERE id IN (
        SELECT id FROM derivative_jobs
        WHERE derivative_type IN ('mesh_tiles','lod_audit') AND status='leased'
        ORDER BY lease_expires_at DESC,updated_at,id
        LIMIT -1 OFFSET 1
      );
      CREATE UNIQUE INDEX derivative_jobs_single_lod_lease
        ON derivative_jobs(status)
        WHERE derivative_type IN ('mesh_tiles','lod_audit') AND status='leased';
      CREATE INDEX derivative_jobs_deadline_idx
        ON derivative_jobs(status,deadline_at,lease_expires_at,created_at)
        WHERE derivative_type IN ('mesh_tiles','lod_audit');

      CREATE TABLE lod_conversion_lock (
        id INTEGER PRIMARY KEY CHECK(id=1),
        job_id TEXT,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        CHECK(
          (job_id IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
          OR
          (job_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        )
      );
      INSERT INTO lod_conversion_lock(id) VALUES (1);
      CREATE TRIGGER lod_conversion_lock_no_delete
        BEFORE DELETE ON lod_conversion_lock
        BEGIN SELECT RAISE(ABORT,'lod_conversion_lock_immutable'); END;
    `,
  },
  {
    version: 28,
    name: 'retained_import_workflow',
    sql: `
      CREATE TEMP TABLE migration_v28_guard(value INTEGER PRIMARY KEY);
      INSERT INTO migration_v28_guard(value) VALUES (1);
      INSERT INTO migration_v28_guard(value)
        SELECT 1 FROM sqlite_master
        WHERE type='table' AND name IN (
          'retained_imports','retained_import_files','import_cleanup_jobs',
          'model_output_storage_components','derivative_storage_journal'
        ) LIMIT 1;
      DROP TABLE migration_v28_guard;

      DROP INDEX derivative_jobs_single_lod_lease;
      DROP INDEX derivative_jobs_deadline_idx;
      CREATE TEMP TABLE migration_v28_heavy_winner(id TEXT PRIMARY KEY);
      CREATE TEMP TABLE migration_v28_expired_required(attempt_id TEXT PRIMARY KEY,error_code TEXT NOT NULL,error_message TEXT NOT NULL);
      INSERT INTO migration_v28_expired_required(attempt_id,error_code,error_message)
        SELECT DISTINCT attempt_id,'derivative_timeout','derivative wall-clock deadline expired' FROM derivative_jobs
        WHERE derivative_type IN ('ept','mesh_tiles','lod_audit') AND status='leased'
          AND deadline_at IS NOT NULL AND deadline_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND COALESCE(json_extract(request_json,'$.optional'),0)<>1;
      INSERT INTO migration_v28_heavy_winner(id)
        SELECT id FROM derivative_jobs
        WHERE derivative_type IN ('ept','mesh_tiles','lod_audit')
          AND status='leased'
          AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND (deadline_at IS NULL OR deadline_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ORDER BY lease_expires_at DESC,updated_at DESC,id DESC LIMIT 1;
      INSERT OR IGNORE INTO migration_v28_expired_required(attempt_id,error_code,error_message)
        SELECT DISTINCT attempt_id,'derivative_retry_exhausted','derivative retry budget exhausted during migration' FROM derivative_jobs
        WHERE derivative_type IN ('ept','mesh_tiles','lod_audit') AND status='leased'
          AND id NOT IN (SELECT id FROM migration_v28_heavy_winner) AND attempt_count>=3
          AND COALESCE(json_extract(request_json,'$.optional'),0)<>1;
      UPDATE derivative_jobs SET
        status='failed',result_json=json_object('error','derivative wall-clock deadline expired','code','derivative_timeout'),
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
        completed_at=COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE derivative_type IN ('ept','mesh_tiles','lod_audit') AND status='leased'
          AND deadline_at IS NOT NULL AND deadline_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');
      UPDATE derivative_jobs SET
        status='failed',result_json=json_object('error','derivative retry budget exhausted during migration','code','derivative_retry_exhausted'),
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
        completed_at=COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE derivative_type IN ('ept','mesh_tiles','lod_audit') AND status='leased'
          AND id NOT IN (SELECT id FROM migration_v28_heavy_winner) AND attempt_count>=3;
      UPDATE derivative_jobs SET
        status='pending',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE derivative_type IN ('ept','mesh_tiles','lod_audit') AND status='leased'
          AND id NOT IN (SELECT id FROM migration_v28_heavy_winner);
      UPDATE lod_conversion_lock SET
        job_id=(SELECT id FROM derivative_jobs WHERE id=(SELECT id FROM migration_v28_heavy_winner)),
        lease_owner=(SELECT lease_owner FROM derivative_jobs WHERE id=(SELECT id FROM migration_v28_heavy_winner)),
        lease_token=(SELECT lease_token FROM derivative_jobs WHERE id=(SELECT id FROM migration_v28_heavy_winner)),
        lease_expires_at=(SELECT lease_expires_at FROM derivative_jobs WHERE id=(SELECT id FROM migration_v28_heavy_winner)),
        heartbeat_at=(SELECT heartbeat_at FROM derivative_jobs WHERE id=(SELECT id FROM migration_v28_heavy_winner))
        WHERE id=1;
      DROP TABLE migration_v28_heavy_winner;
      CREATE UNIQUE INDEX derivative_jobs_single_heavy_lease
        ON derivative_jobs((1))
        WHERE derivative_type IN ('ept','mesh_tiles','lod_audit') AND status='leased';
      CREATE INDEX derivative_jobs_deadline_idx
        ON derivative_jobs(status,deadline_at,lease_expires_at,created_at)
        WHERE derivative_type IN ('ept','mesh_tiles','lod_audit');

      DROP INDEX dataset_operations_claim_idx;
      DROP INDEX dataset_operations_subject_idx;
      DROP INDEX dataset_operations_active_upload_idx;
      DROP INDEX dataset_operations_active_preview_idx;
      DROP INDEX subject_operation_receipts_operation_idx;
      ALTER TABLE subject_operation_receipts RENAME TO subject_operation_receipts_v27;
      ALTER TABLE dataset_operations RENAME TO dataset_operations_v27;

      CREATE TABLE dataset_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('upload_finalize','import_preview','import_adopt','catalog_scan','catalog_map')),
        subject TEXT NOT NULL,
        session_id TEXT,
        dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        upload_id TEXT REFERENCES upload_sessions(id) ON DELETE SET NULL,
        import_preview_id TEXT REFERENCES dataset_import_previews(id) ON DELETE SET NULL,
        processing_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('queued','leased','awaiting_derivatives','succeeded','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK(processing_attempt_id IS NULL OR operation_type='catalog_map'),
        CHECK(status<>'awaiting_derivatives' OR (
          processing_attempt_id IS NOT NULL AND lease_owner IS NULL
          AND lease_expires_at IS NULL AND completed_at IS NULL
        ))
      );
      INSERT INTO dataset_operations(
        id,operation_type,subject,session_id,dataset_id,upload_id,import_preview_id,
        payload_json,status,progress,result_json,error_code,error_message,lease_owner,
        lease_expires_at,heartbeat_at,attempt_count,available_at,created_at,updated_at,completed_at
      ) SELECT
        id,operation_type,subject,session_id,dataset_id,upload_id,import_preview_id,
        payload_json,status,progress,result_json,error_code,error_message,lease_owner,
        lease_expires_at,heartbeat_at,attempt_count,available_at,created_at,updated_at,completed_at
      FROM dataset_operations_v27;

      CREATE TABLE subject_operation_receipts (
        subject TEXT NOT NULL,
        client_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        response_status INTEGER,
        response_json TEXT,
        operation_id TEXT REFERENCES dataset_operations(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(subject,client_key)
      );
      INSERT INTO subject_operation_receipts
        SELECT * FROM subject_operation_receipts_v27;
      DROP TABLE subject_operation_receipts_v27;
      DROP TABLE dataset_operations_v27;

      CREATE INDEX dataset_operations_claim_idx
        ON dataset_operations(status,available_at,lease_expires_at,created_at);
      CREATE INDEX dataset_operations_subject_idx
        ON dataset_operations(subject,created_at DESC,id DESC);
      CREATE UNIQUE INDEX dataset_operations_active_upload_idx
        ON dataset_operations(upload_id)
        WHERE upload_id IS NOT NULL AND status IN ('queued','leased','awaiting_derivatives','succeeded');
      CREATE UNIQUE INDEX dataset_operations_active_preview_idx
        ON dataset_operations(import_preview_id)
        WHERE import_preview_id IS NOT NULL AND status IN ('queued','leased','awaiting_derivatives','succeeded');
      CREATE UNIQUE INDEX dataset_operations_waiting_attempt_idx
        ON dataset_operations(processing_attempt_id)
        WHERE processing_attempt_id IS NOT NULL AND status='awaiting_derivatives';
      CREATE INDEX subject_operation_receipts_operation_idx
        ON subject_operation_receipts(operation_id);

      UPDATE model_outputs SET status='failed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE attempt_id IN (SELECT attempt_id FROM migration_v28_expired_required)
          AND status IN ('staged','ready');
      UPDATE model_versions SET status='failed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id IN (SELECT result_model_version_id FROM processing_attempts WHERE id IN (SELECT attempt_id FROM migration_v28_expired_required))
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_versions.model_id AND models.active_version_id=model_versions.id);
      UPDATE models SET status=CASE WHEN active_version_id IS NULL THEN 'failed' ELSE 'ready' END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id IN (SELECT result_model_id FROM processing_attempts WHERE id IN (SELECT attempt_id FROM migration_v28_expired_required));
      UPDATE processing_attempts SET status='failed',
        error_code=(SELECT x.error_code FROM migration_v28_expired_required x WHERE x.attempt_id=processing_attempts.id),
        error_message=(SELECT x.error_message FROM migration_v28_expired_required x WHERE x.attempt_id=processing_attempts.id),completed_at=COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id IN (SELECT attempt_id FROM migration_v28_expired_required)
          AND status NOT IN ('cancelled','published','failed');
      UPDATE processing_tasks SET status='failed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE active_attempt_id IN (SELECT attempt_id FROM migration_v28_expired_required);
      INSERT OR IGNORE INTO event_outbox(id,event_type,payload_json,status,attempt_count,available_at,created_at,updated_at)
        SELECT 'processing-failed-'||a.id,'processing.failed',json_object(
          'eventId','processing-failed-'||a.id,'schemaVersion',1,'type','processing.failed',
          'occurredAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'projectId',p.id,'projectDisplayName',p.display_name,
          'taskId',t.id,'taskDisplayName',t.display_name,'attemptId',a.id,'requestedBySubject',a.created_by,
          'status','failed','error',json_object('code',x.error_code,'message',x.error_message)
        ),'pending',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM migration_v28_expired_required x
        JOIN processing_attempts a ON a.id=x.attempt_id
        JOIN processing_tasks t ON t.id=a.task_id
        JOIN projects p ON p.id=t.project_id;
      INSERT INTO audit_events(id,actor_type,actor_id,action,entity_type,entity_id,details_json,created_at)
        SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
          'system',NULL,'derivative.migration_terminalized','processing_attempt',a.id,
          json_object('errorCode',x.error_code,'migrationVersion',28),strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM migration_v28_expired_required x JOIN processing_attempts a ON a.id=x.attempt_id;
      DROP TABLE migration_v28_expired_required;

      CREATE TABLE retained_imports (
        id TEXT PRIMARY KEY,
        operation_id TEXT UNIQUE REFERENCES dataset_operations(id) ON DELETE CASCADE,
        attempt_id TEXT UNIQUE,
        dataset_id TEXT,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('backup_zip','server_folder','nodeodm_result')),
        source_root_key TEXT,
        source_relative_path TEXT,
        source_byte_size INTEGER CHECK(source_byte_size IS NULL OR source_byte_size >= 0),
        source_sha256 TEXT CHECK(source_sha256 IS NULL OR length(source_sha256)=64),
        source_dev TEXT,
        source_ino TEXT,
        source_ctime_ns TEXT,
        source_mtime_ns TEXT,
        extracted_tree_sha256 TEXT CHECK(extracted_tree_sha256 IS NULL OR length(extracted_tree_sha256)=64),
        staging_root_key TEXT NOT NULL,
        staging_relative_path TEXT NOT NULL,
        manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256)=64),
        retained_file_count INTEGER NOT NULL DEFAULT 0 CHECK(retained_file_count >= 0),
        retained_byte_size INTEGER NOT NULL DEFAULT 0 CHECK(retained_byte_size >= 0),
        cleanup_jobs_inserted INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_jobs_inserted IN (0,1)),
        active_slot INTEGER NOT NULL DEFAULT 1 CHECK(active_slot=1),
        slot_lease_owner TEXT,
        slot_lease_token TEXT,
        slot_lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(slot_lease_generation >= 0),
        slot_lease_expires_at TEXT,
        reserved_byte_size INTEGER NOT NULL DEFAULT 0 CHECK(reserved_byte_size >= 0),
        state TEXT NOT NULL CHECK(state IN (
          'queued','source_snapshotted','extracted','manifest_persisted','materialized',
          'registering','awaiting_derivatives','ready','failed'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(state <> 'ready' OR cleanup_jobs_inserted = 1),
        CHECK(state IN ('queued','awaiting_derivatives','ready','failed') OR (
          slot_lease_owner IS NOT NULL AND slot_lease_token IS NOT NULL AND slot_lease_expires_at IS NOT NULL
        )),
        CHECK(
          (source_kind='backup_zip' AND source_root_key IS NOT NULL AND source_relative_path IS NOT NULL
            AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
            AND source_dev IS NOT NULL AND source_ino IS NOT NULL
            AND source_ctime_ns IS NOT NULL AND source_mtime_ns IS NOT NULL)
          OR (source_kind='server_folder' AND source_root_key IS NOT NULL AND source_relative_path IS NOT NULL)
          OR (source_kind='nodeodm_result' AND source_root_key IS NULL AND source_relative_path IS NULL)
        )
      );
      CREATE UNIQUE INDEX retained_imports_single_active
        ON retained_imports(active_slot)
        WHERE state IN ('source_snapshotted','extracted','manifest_persisted','materialized','registering','awaiting_derivatives');

      CREATE TABLE retained_import_files (
        retained_import_id TEXT NOT NULL REFERENCES retained_imports(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        source_relative_path TEXT NOT NULL,
        role TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        PRIMARY KEY(retained_import_id,relative_path)
      );

      CREATE TABLE import_cleanup_jobs (
        id TEXT PRIMARY KEY,
        retained_import_id TEXT NOT NULL REFERENCES retained_imports(id) ON DELETE CASCADE,
        cleanup_type TEXT NOT NULL CHECK(cleanup_type IN ('staging_tree','source_zip')),
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        expected_byte_size INTEGER CHECK(expected_byte_size IS NULL OR expected_byte_size >= 0),
        expected_sha256 TEXT CHECK(expected_sha256 IS NULL OR length(expected_sha256)=64),
        expected_dev TEXT,
        expected_ino TEXT,
        expected_ctime_ns TEXT,
        expected_mtime_ns TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','leased','quarantined','complete','source_changed','cleanup_skipped_cross_mount','cleanup_skipped_read_only','cleanup_skipped_hardlink','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
        lease_expires_at TEXT,
        quarantine_relative_path TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(retained_import_id,cleanup_type),
        CHECK((status='leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR status<>'leased')
      );

      CREATE TABLE model_output_storage_components (
        output_id TEXT NOT NULL REFERENCES model_outputs(id) ON DELETE CASCADE,
        component_key TEXT NOT NULL,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256)=64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(output_id,component_key)
      );
      INSERT INTO model_output_storage_components(output_id,component_key,root_key,relative_path,byte_size,manifest_sha256,created_at,updated_at)
        SELECT id,'base',root_key,relative_path,byte_size,NULL,created_at,updated_at FROM model_outputs;

      CREATE TABLE derivative_storage_journal (
        job_id TEXT PRIMARY KEY REFERENCES derivative_jobs(id) ON DELETE CASCADE,
        output_id TEXT NOT NULL REFERENCES model_outputs(id) ON DELETE CASCADE,
        lease_token TEXT,
        root_key TEXT NOT NULL CHECK(root_key='models'),
        incomplete_relative_path TEXT,
        complete_relative_path TEXT,
        final_relative_path TEXT,
        state TEXT NOT NULL CHECK(state IN ('reserved','building','verified','promoted','registered','terminal')),
        reserved_byte_size INTEGER NOT NULL CHECK(reserved_byte_size >= 0),
        actual_byte_size INTEGER CHECK(actual_byte_size IS NULL OR actual_byte_size >= 0),
        accounted_byte_size INTEGER NOT NULL CHECK(accounted_byte_size >= COALESCE(actual_byte_size,0)),
        manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256)=64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(state='reserved' OR (
          lease_token IS NOT NULL AND incomplete_relative_path IS NOT NULL
          AND complete_relative_path IS NOT NULL AND final_relative_path IS NOT NULL
        ))
      );
    `,
  },
  {
    version: 29,
    name: 'import_cleanup_executor',
    sql: `
      CREATE TABLE import_cleanup_jobs_v29 (
        id TEXT PRIMARY KEY,
        retained_import_id TEXT NOT NULL REFERENCES retained_imports(id) ON DELETE CASCADE,
        cleanup_type TEXT NOT NULL CHECK(cleanup_type IN ('staging_tree','source_zip')),
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        expected_byte_size INTEGER CHECK(expected_byte_size IS NULL OR expected_byte_size >= 0),
        expected_sha256 TEXT CHECK(expected_sha256 IS NULL OR length(expected_sha256)=64),
        expected_dev TEXT,
        expected_ino TEXT,
        expected_ctime_ns TEXT,
        expected_mtime_ns TEXT,
        status TEXT NOT NULL CHECK(status IN (
          'pending','leased','quarantined','complete','source_changed','cleanup_skipped_cross_mount',
          'cleanup_skipped_read_only','cleanup_skipped_hardlink','cleanup_quarantine_conflict','failed'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
        lease_expires_at TEXT,
        quarantine_relative_path TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(retained_import_id,cleanup_type),
        CHECK(
          (status IN ('leased','quarantined') AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR (status NOT IN ('leased','quarantined') AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
        )
      );

      INSERT INTO import_cleanup_jobs_v29(
        id,retained_import_id,cleanup_type,root_key,relative_path,expected_byte_size,expected_sha256,
        expected_dev,expected_ino,expected_ctime_ns,expected_mtime_ns,status,attempt_count,available_at,
        lease_owner,lease_token,lease_generation,lease_expires_at,quarantine_relative_path,last_error,
        created_at,updated_at,completed_at
      )
      SELECT
        id,retained_import_id,cleanup_type,root_key,relative_path,expected_byte_size,expected_sha256,
        expected_dev,expected_ino,expected_ctime_ns,expected_mtime_ns,
        CASE
          WHEN status IN ('leased','quarantined')
            AND (lease_owner IS NULL OR lease_token IS NULL OR lease_expires_at IS NULL) THEN 'pending'
          ELSE status
        END,
        attempt_count,available_at,
        CASE WHEN status IN ('leased','quarantined')
          AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
          THEN lease_owner ELSE NULL END,
        CASE WHEN status IN ('leased','quarantined')
          AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
          THEN lease_token ELSE NULL END,
        lease_generation,
        CASE WHEN status IN ('leased','quarantined')
          AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
          THEN lease_expires_at ELSE NULL END,
        quarantine_relative_path,last_error,created_at,updated_at,completed_at
      FROM import_cleanup_jobs;

      DROP TABLE import_cleanup_jobs;
      ALTER TABLE import_cleanup_jobs_v29 RENAME TO import_cleanup_jobs;
      CREATE INDEX import_cleanup_jobs_claim_idx
        ON import_cleanup_jobs(status,available_at,lease_expires_at,created_at,id);
      CREATE INDEX import_cleanup_jobs_retained_idx
        ON import_cleanup_jobs(retained_import_id,status);
    `,
  },
  {
    version: 30,
    name: 'append_only_processing_diagnostics',
    sql: `
      CREATE TABLE processing_events (
        id TEXT PRIMARY KEY,
        attempt_id TEXT,
        operation_id TEXT,
        derivative_job_id TEXT,
        event_type TEXT NOT NULL,
        phase TEXT,
        severity TEXT NOT NULL CHECK(severity IN ('info','warning','error')),
        error_code TEXT,
        message TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX processing_events_attempt_idx ON processing_events(attempt_id,created_at,id);
      CREATE INDEX processing_events_operation_idx ON processing_events(operation_id,created_at,id);
      CREATE INDEX processing_events_created_idx ON processing_events(created_at DESC,id DESC);
      CREATE TRIGGER processing_events_no_update
        BEFORE UPDATE ON processing_events BEGIN SELECT RAISE(ABORT,'processing_events are append-only'); END;
      CREATE TRIGGER processing_events_no_delete
        BEFORE DELETE ON processing_events BEGIN SELECT RAISE(ABORT,'processing_events are append-only'); END;
    `,
  },
  {
    version: 31,
    name: 'immutable_derivative_input_snapshots',
    sql: `
      CREATE TABLE derivative_input_snapshots (
        job_id TEXT PRIMARY KEY REFERENCES derivative_jobs(id) ON DELETE CASCADE,
        derivative_type TEXT NOT NULL CHECK(derivative_type IN ('ept','mesh_tiles','lod_audit')),
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
        manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
        file_count INTEGER NOT NULL CHECK(file_count>0 AND file_count<=10000),
        total_byte_size INTEGER NOT NULL CHECK(total_byte_size>=0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE derivative_input_files (
        job_id TEXT NOT NULL REFERENCES derivative_input_snapshots(job_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal>=0),
        role TEXT NOT NULL CHECK(role IN ('mesh_obj','mesh_mtl','mesh_texture','mesh_glb','point_cloud_source')),
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        PRIMARY KEY(job_id,ordinal),
        UNIQUE(job_id,root_key,relative_path)
      );
      CREATE INDEX derivative_input_files_job_role_idx ON derivative_input_files(job_id,role,ordinal);

      CREATE TRIGGER derivative_input_snapshots_no_update
        BEFORE UPDATE ON derivative_input_snapshots BEGIN SELECT RAISE(ABORT,'derivative input snapshots are immutable'); END;
      CREATE TRIGGER derivative_input_files_no_update
        BEFORE UPDATE ON derivative_input_files BEGIN SELECT RAISE(ABORT,'derivative input files are immutable'); END;
      CREATE TRIGGER processing_jobs_submit_requires_provider_insert
        BEFORE INSERT ON processing_jobs
        WHEN NEW.job_type='submit' AND NOT EXISTS (
          SELECT 1 FROM processing_attempts WHERE id=NEW.attempt_id AND provider_id IS NOT NULL
        ) BEGIN SELECT RAISE(ABORT,'submit jobs require a provider-backed attempt'); END;
      CREATE TRIGGER processing_jobs_submit_requires_provider_update
        BEFORE UPDATE OF attempt_id,job_type,status ON processing_jobs
        WHEN NEW.job_type='submit' AND NEW.status IN ('pending','leased') AND NOT EXISTS (
          SELECT 1 FROM processing_attempts WHERE id=NEW.attempt_id AND provider_id IS NOT NULL
        ) BEGIN SELECT RAISE(ABORT,'submit jobs require a provider-backed attempt'); END;
      CREATE UNIQUE INDEX processing_jobs_one_active_type_idx
        ON processing_jobs(attempt_id,job_type) WHERE status IN ('pending','leased');
    `,
  },
  {
    version: 32,
    name: 'private_measurements_and_calculation_jobs',
    sql: `
      CREATE TABLE private_measurements (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
        owner_audience TEXT NOT NULL CHECK(owner_audience IN ('ops','client')),
        owner_subject TEXT NOT NULL,
        collection TEXT NOT NULL CHECK(collection IN ('spatial3d','map')),
        document_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        creation_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX private_measurements_owner_version_idx
        ON private_measurements(model_version_id,owner_audience,owner_subject,collection,deleted_at);
      CREATE TABLE measurement_calculation_jobs (
        id TEXT PRIMARY KEY,
        measurement_id TEXT NOT NULL REFERENCES private_measurements(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','complete','failed','cancelled')),
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        result_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX measurement_calculation_jobs_status_idx ON measurement_calculation_jobs(status,created_at);
    `,
  },
  {
    version: 33,
    name: 'ephemeral_raster_measurements',
    sql: `
      CREATE TABLE ephemeral_measurement_jobs (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, page_hash TEXT NOT NULL,
        measurement_id TEXT NOT NULL, geometry_hash TEXT NOT NULL,
        request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','complete','failed','cancelled')),
        lease_owner TEXT, lease_token TEXT, lease_expires_at TEXT,
        result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE INDEX ephemeral_measurement_jobs_scope_idx ON ephemeral_measurement_jobs(scope_key,page_hash,created_at);
      CREATE INDEX ephemeral_measurement_jobs_status_idx ON ephemeral_measurement_jobs(status,created_at);
    `,
  },
  {version:34,name:'manageable_public_share_links',sql:`
    ALTER TABLE public_shares ADD COLUMN token_ciphertext TEXT;
    ALTER TABLE public_shares ADD COLUMN authorization_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE public_shares ADD COLUMN allowed_views_json TEXT;
  `},
  {version:35,name:'dataset_source_unit_evidence',sql:`
    CREATE TABLE measurement_source_unit_evidence (
      id TEXT PRIMARY KEY, model_id TEXT NOT NULL, model_version_id TEXT NOT NULL,
      asset_id TEXT NOT NULL, source_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL DEFAULT '', byte_size INTEGER NOT NULL,
      evidence_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(model_id,model_version_id,asset_id,source_sha256,manifest_sha256)
    );
  `},
  {version:36,name:'immutable_processing_attempt_provenance',sql:`
    CREATE TABLE processing_attempt_provenance (
      attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id) ON DELETE CASCADE,
      submission_json TEXT NOT NULL, provider_result_json TEXT,
      created_at TEXT NOT NULL
    );
  `},
  {version:37,name:'processing_transfer_provenance',sql:`
    CREATE TABLE processing_attempt_transfer_provenance (
      attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id) ON DELETE CASCADE,
      initialization_json TEXT NOT NULL, archive_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `},
  {version:38,name:'immutable_ept_conversion_receipts',sql:`
    CREATE TABLE derivative_ept_conversion_receipts (
      job_id TEXT PRIMARY KEY REFERENCES derivative_jobs(id) ON DELETE CASCADE,
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
      receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64),
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER derivative_ept_conversion_receipts_no_update
      BEFORE UPDATE ON derivative_ept_conversion_receipts
      BEGIN SELECT RAISE(ABORT,'EPT conversion receipts are immutable'); END;
    CREATE TRIGGER derivative_ept_conversion_receipts_no_delete
      BEFORE DELETE ON derivative_ept_conversion_receipts
      WHEN EXISTS(SELECT 1 FROM derivative_jobs WHERE id=OLD.job_id)
      BEGIN SELECT RAISE(ABORT,'EPT conversion receipts are immutable'); END;
  `},
  {version:39,name:'pinned_workspace_controller_origins',sql:`
    ALTER TABLE admin_grants ADD COLUMN controller_origin TEXT;
    ALTER TABLE admin_grants ADD COLUMN target_session_id TEXT;
    ALTER TABLE admin_sessions ADD COLUMN controller_origin TEXT;
  `,after(database){
    // Keep OPS_BASE_URL unchanged for this first upgrade: it is the authority
    // existing envelopes actually advertised, never an incoming request value.
    const {config}=require('./config');
    const {controllerOriginAllowed}=require('./controllerOrigins');
    const legacyOrigin=config.opsBaseUrl;
    if(!controllerOriginAllowed(legacyOrigin,config.opsControllerOrigins,!config.production))throw new Error('Legacy workspace controller must be an exact configured trusted Ops origin');
    database.prepare('UPDATE admin_grants SET controller_origin=? WHERE controller_origin IS NULL').run(legacyOrigin);
    database.prepare('UPDATE admin_sessions SET controller_origin=? WHERE controller_origin IS NULL').run(legacyOrigin);
    database.prepare("INSERT INTO app_state(key,value,updated_at) VALUES ('workspace_legacy_controller_origin',?,?)").run(legacyOrigin,new Date().toISOString());
    database.exec(`CREATE TRIGGER admin_session_controller_immutable BEFORE UPDATE OF controller_origin ON admin_sessions
      WHEN NEW.controller_origin IS NOT OLD.controller_origin
      BEGIN SELECT RAISE(ABORT,'workspace controller origin is immutable'); END;`);
  }},
  {version:40,name:'direct_client_session_source_authorizations',sql:'SELECT 1;',
    after(database){require('./directClientSourceMigration').migrateDirectClientSources(database);}},
  {version:41,name:'gcp_odm_crs_confirmations',sql:`CREATE TABLE gcp_odm_crs_confirmations (set_id TEXT PRIMARY KEY REFERENCES gcp_sets(id) ON DELETE CASCADE, source_sha256 TEXT NOT NULL, epsg_code INTEGER NOT NULL, horizontal_unit TEXT NOT NULL, vertical_datum TEXT NOT NULL, validation_sha256 TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL);`},
  {version:42,name:'viewer_workspace_hierarchy',sql:`
    CREATE TABLE viewer_organizations (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1)
    );
    CREATE TABLE viewer_project_groups (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES viewer_organizations(id) ON DELETE RESTRICT,
      display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), UNIQUE(id,organization_id)
    );
    CREATE TABLE viewer_project_hierarchy (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      organization_id TEXT REFERENCES viewer_organizations(id) ON DELETE RESTRICT,
      group_id TEXT REFERENCES viewer_project_groups(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision>=1),
      CHECK(group_id IS NULL OR organization_id IS NOT NULL),
      FOREIGN KEY(group_id,organization_id) REFERENCES viewer_project_groups(id,organization_id) ON DELETE RESTRICT
    );
    CREATE INDEX viewer_project_groups_org_idx ON viewer_project_groups(organization_id);
    CREATE INDEX viewer_project_hierarchy_org_idx ON viewer_project_hierarchy(organization_id,group_id);
  `},
  {version:44,name:'processing_attempt_reservation_capabilities',sql:`
    ALTER TABLE processing_attempts ADD COLUMN reservation_required INTEGER NOT NULL DEFAULT 0 CHECK (reservation_required IN (0,1));
    ALTER TABLE processing_providers ADD COLUMN reservation_required INTEGER NOT NULL DEFAULT 0 CHECK (reservation_required IN (0,1));
    CREATE TABLE processing_attempt_reservations (
      attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id),
      provider_id TEXT NOT NULL REFERENCES processing_providers(id),
      provider_task_id TEXT NOT NULL,
      capability_ciphertext TEXT NOT NULL,
      capability_key_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `},
  {version:45,name:'processing_archive_capture_intents',sql:`
    CREATE TABLE processing_archive_capture_intents (
      attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id),
      provider_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `},
  {version:46,name:'processing_staged_byte_ack_outbox',sql:`
    CREATE TABLE processing_staged_commitments (
      attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id),
      commitment_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE processing_staged_byte_ack_outbox (
      attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id),
      provider_id TEXT NOT NULL REFERENCES processing_providers(id),
      staging_commit_id TEXT NOT NULL UNIQUE,
      assertion_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'disabled' CHECK(state='disabled'),
      created_at TEXT NOT NULL
    );
  `},
  {version:47,name:'processing_staged_ack_delivery',sql:`
    CREATE TABLE processing_staged_receipt_bindings (
      attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id),
      binding_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE processing_staged_ack_delivery (
      attempt_id TEXT PRIMARY KEY REFERENCES processing_staged_byte_ack_outbox(attempt_id),
      state TEXT NOT NULL CHECK(state IN ('pending','uncertain','accepted','held')),
      assertion_sha256 TEXT NOT NULL,
      binding_version INTEGER NOT NULL DEFAULT 1 CHECK(binding_version=1),
      expected_origin TEXT,
      credential_ref TEXT,
      capability_sha256 TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      error_code TEXT,
      updated_at INTEGER NOT NULL
    );
  `},
  {version:48,name:'viewer_cooperative_capacity_ledger',sql:`
    CREATE TABLE viewer_capacity_control (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      mode TEXT NOT NULL CHECK(mode IN ('disabled','cooperative')),
      legacy_state TEXT NOT NULL CHECK(legacy_state IN ('unassessed','reconciling','verified'))
    );
    INSERT INTO viewer_capacity_control(singleton,mode,legacy_state)
      VALUES(1,'disabled','unassessed');
    CREATE TRIGGER viewer_capacity_control_no_replace BEFORE INSERT ON viewer_capacity_control WHEN EXISTS(SELECT 1 FROM viewer_capacity_control WHERE singleton=NEW.singleton OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'capacity control replacement is forbidden'); END;
    CREATE TABLE viewer_capacity_reservations (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
      domain_id TEXT NOT NULL CHECK(length(domain_id) BETWEEN 1 AND 128),
      domain_revision TEXT NOT NULL CHECK(length(domain_revision) BETWEEN 1 AND 128),
      writer_kind TEXT NOT NULL CHECK(length(writer_kind) BETWEEN 1 AND 64),
      writer_id TEXT NOT NULL CHECK(length(writer_id) BETWEEN 1 AND 128),
      writer_namespace TEXT NOT NULL CHECK(length(writer_namespace) BETWEEN 1 AND 256),
      owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
      fence_token TEXT NOT NULL CHECK(length(fence_token) BETWEEN 1 AND 128),
      owner_generation INTEGER NOT NULL CHECK(typeof(owner_generation)='integer' AND owner_generation BETWEEN 1 AND 9007199254740991),
      peak_bytes INTEGER NOT NULL CHECK(typeof(peak_bytes)='integer' AND peak_bytes BETWEEN 0 AND 9007199254740991),
      materialized_bytes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(materialized_bytes)='integer' AND materialized_bytes BETWEEN 0 AND peak_bytes),
      remaining_bytes INTEGER NOT NULL CHECK(typeof(remaining_bytes)='integer' AND remaining_bytes=peak_bytes-materialized_bytes),
      peak_inodes INTEGER NOT NULL CHECK(typeof(peak_inodes)='integer' AND peak_inodes BETWEEN 0 AND 9007199254740991),
      materialized_inodes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(materialized_inodes)='integer' AND materialized_inodes BETWEEN 0 AND peak_inodes),
      remaining_inodes INTEGER NOT NULL CHECK(typeof(remaining_inodes)='integer' AND remaining_inodes=peak_inodes-materialized_inodes),
      state TEXT NOT NULL CHECK(state IN ('requested','held','writing','quiescing','retained','complete','cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(domain_id,writer_kind,writer_id)
    );
    CREATE INDEX viewer_capacity_reservations_domain_idx ON viewer_capacity_reservations(domain_id,state);
    CREATE TRIGGER viewer_capacity_state_transition
      BEFORE UPDATE OF state ON viewer_capacity_reservations
      WHEN NEW.state <> OLD.state AND NOT (
        (OLD.state IN ('held','writing') AND NEW.state='quiescing') OR
        (OLD.state='quiescing' AND NEW.state='retained')
      )
      BEGIN SELECT RAISE(ABORT,'capacity state transition forbidden'); END;
    CREATE TRIGGER viewer_capacity_no_delete
      BEFORE DELETE ON viewer_capacity_reservations
      BEGIN SELECT RAISE(ABORT,'capacity reservation deletion is forbidden'); END;
    CREATE TRIGGER viewer_capacity_identity_immutable
      BEFORE UPDATE ON viewer_capacity_reservations
      WHEN NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.domain_id IS NOT OLD.domain_id OR NEW.writer_kind IS NOT OLD.writer_kind OR NEW.writer_id IS NOT OLD.writer_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.fence_token IS NOT OLD.fence_token OR NEW.owner_generation IS NOT OLD.owner_generation
      BEGIN SELECT RAISE(ABORT,'capacity reservation identity is immutable'); END;
    CREATE TRIGGER viewer_capacity_no_replacement
      BEFORE INSERT ON viewer_capacity_reservations
      WHEN EXISTS (SELECT 1 FROM viewer_capacity_reservations
        WHERE rowid=NEW.rowid OR id=NEW.id OR (domain_id=NEW.domain_id AND writer_kind=NEW.writer_kind AND writer_id=NEW.writer_id))
      BEGIN SELECT RAISE(ABORT,'capacity reservation replacement is forbidden'); END;
    CREATE TRIGGER viewer_capacity_materialized_monotonic
      BEFORE UPDATE OF materialized_bytes,materialized_inodes ON viewer_capacity_reservations
      WHEN NEW.materialized_bytes < OLD.materialized_bytes OR NEW.materialized_inodes < OLD.materialized_inodes
      BEGIN SELECT RAISE(ABORT,'capacity materialization cannot decrease'); END;
  `},


  {version:49,name:'viewer_source_custody_dormant',sql:`
    CREATE TABLE viewer_custody_intents (
      id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL, generation INTEGER NOT NULL, environment TEXT NOT NULL, binding_sha256 TEXT NOT NULL,
      canonical_binding TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('building','prepared')),
      created_at TEXT NOT NULL, UNIQUE(job_id,generation,environment)
    );
    CREATE TABLE viewer_custody_pins (
      intent_id TEXT NOT NULL REFERENCES viewer_custody_intents(id) ON DELETE RESTRICT,
      object_id TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>=0),
      sha256 TEXT NOT NULL, kind TEXT NOT NULL,
      permanent_csv INTEGER NOT NULL CHECK(permanent_csv IN (0,1)),
      PRIMARY KEY(intent_id,object_id)
    );
    CREATE TRIGGER viewer_custody_intents_immutable BEFORE UPDATE ON viewer_custody_intents WHEN NOT (OLD.state='building' AND NEW.state='prepared' AND NEW.rowid=OLD.rowid AND NEW.id=OLD.id AND NEW.job_id=OLD.job_id AND NEW.generation=OLD.generation AND NEW.environment=OLD.environment AND NEW.binding_sha256=OLD.binding_sha256 AND NEW.canonical_binding=OLD.canonical_binding AND NEW.created_at=OLD.created_at) BEGIN SELECT RAISE(ABORT,'custody intent immutable'); END;
    CREATE TRIGGER viewer_custody_intents_no_replace BEFORE INSERT ON viewer_custody_intents WHEN EXISTS (SELECT 1 FROM viewer_custody_intents WHERE rowid=NEW.rowid OR id=NEW.id OR (job_id=NEW.job_id AND generation=NEW.generation AND environment=NEW.environment)) BEGIN SELECT RAISE(ABORT,'custody intent replacement'); END;
    CREATE TRIGGER viewer_custody_pins_no_late_insert BEFORE INSERT ON viewer_custody_pins WHEN COALESCE((SELECT state FROM viewer_custody_intents WHERE id=NEW.intent_id),'')<>'building' OR EXISTS (SELECT 1 FROM viewer_custody_pins WHERE rowid=NEW.rowid OR (intent_id=NEW.intent_id AND object_id=NEW.object_id)) BEGIN SELECT RAISE(ABORT,'custody pin insertion forbidden'); END;
    CREATE TRIGGER viewer_custody_intents_no_delete BEFORE DELETE ON viewer_custody_intents BEGIN SELECT RAISE(ABORT,'custody intent retention'); END;
    CREATE TRIGGER viewer_custody_pins_immutable BEFORE UPDATE ON viewer_custody_pins BEGIN SELECT RAISE(ABORT,'custody pin immutable'); END;
    CREATE TRIGGER viewer_custody_pins_no_delete BEFORE DELETE ON viewer_custody_pins BEGIN SELECT RAISE(ABORT,'custody pin retention'); END;
  `},

  // Reserved source-only reference journal. No provider route, scheduler or
  // custody authority is enabled by this schema; old writers still require a
  // separate owner-verified drain/fence before any real submission.
  {version:50,name:'viewer_reference_attempt_journal',sql:`
    CREATE TABLE viewer_reference_attempt_journal (
      attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES processing_attempts(id) ON DELETE RESTRICT,
      submission_id TEXT NOT NULL UNIQUE,
      environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
      request_json TEXT NOT NULL, request_sha256 TEXT NOT NULL,
      input_manifest_sha256 TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lease_generation)='integer' AND lease_generation>=0 AND lease_generation<=9007199254740991),
      lease_owner TEXT, lease_expires_ms INTEGER CHECK(lease_expires_ms IS NULL OR (typeof(lease_expires_ms)='integer' AND lease_expires_ms>=0 AND lease_expires_ms<=9007199254740991)),
      job_id TEXT UNIQUE, job_json TEXT, job_sha256 TEXT,
      CHECK((lease_owner IS NULL)=(lease_expires_ms IS NULL)),
      CHECK((job_id IS NULL)=(job_json IS NULL)), CHECK((job_json IS NULL)=(job_sha256 IS NULL))
    );
    CREATE TRIGGER viewer_reference_attempt_identity_immutable BEFORE UPDATE ON viewer_reference_attempt_journal WHEN NEW.rowid IS NOT OLD.rowid OR NEW.lease_generation<OLD.lease_generation OR NEW.attempt_id<>OLD.attempt_id OR NEW.submission_id<>OLD.submission_id OR NEW.environment<>OLD.environment OR NEW.request_json<>OLD.request_json OR NEW.request_sha256<>OLD.request_sha256 OR NEW.input_manifest_sha256<>OLD.input_manifest_sha256 OR (OLD.job_json IS NOT NULL AND (NEW.job_id IS NOT OLD.job_id OR NEW.job_json IS NOT OLD.job_json OR NEW.job_sha256 IS NOT OLD.job_sha256)) BEGIN SELECT RAISE(ABORT,'reference attempt immutable'); END;
    CREATE TRIGGER viewer_reference_attempt_no_insert_replace BEFORE INSERT ON viewer_reference_attempt_journal WHEN EXISTS(SELECT 1 FROM viewer_reference_attempt_journal WHERE rowid=NEW.rowid OR attempt_id=NEW.attempt_id OR submission_id=NEW.submission_id OR (NEW.job_id IS NOT NULL AND job_id=NEW.job_id)) BEGIN SELECT RAISE(ABORT,'reference attempt replacement'); END;
    CREATE TRIGGER viewer_reference_attempt_no_update_replace BEFORE UPDATE OF job_id ON viewer_reference_attempt_journal WHEN NEW.job_id IS NOT NULL AND EXISTS(SELECT 1 FROM viewer_reference_attempt_journal WHERE job_id=NEW.job_id AND attempt_id<>OLD.attempt_id) BEGIN SELECT RAISE(ABORT,'reference job replacement'); END;
    CREATE TRIGGER viewer_reference_attempt_no_delete BEFORE DELETE ON viewer_reference_attempt_journal BEGIN SELECT RAISE(ABORT,'reference attempt retention'); END;
    ${REFERENCE_CATALOG_PROJECTION_SCHEMA}
    CREATE INDEX viewer_reference_catalog_operation_idx ON dataset_operations(operation_type,id);
    CREATE TRIGGER viewer_reference_attempt_admission_unavailable BEFORE INSERT ON viewer_reference_attempt_journal WHEN COALESCE((SELECT authority_ready FROM reference_catalog_projection_state WHERE id=1),0)<>1 BEGIN SELECT RAISE(ABORT,'reference admission unavailable'); END;
    -- Additional identity exclusion only; disabled admission above remains
    -- mandatory until storage authority and old-writer quiescence exist.
    CREATE TRIGGER viewer_reference_projection_admission BEFORE INSERT ON viewer_reference_attempt_journal WHEN COALESCE((SELECT scan_complete FROM reference_catalog_projection_state WHERE id=1),0)<>1 OR EXISTS(SELECT 1 FROM reference_catalog_projection WHERE status='unresolved') OR EXISTS(SELECT 1 FROM reference_catalog_projection WHERE payload_attempt_id=NEW.attempt_id OR column_attempt_id=NEW.attempt_id) BEGIN SELECT RAISE(ABORT,'reference catalog identity conflict'); END;
    CREATE TRIGGER viewer_reference_catalog_exclusion_insert BEFORE INSERT ON dataset_operations WHEN EXISTS(SELECT 1 FROM viewer_reference_attempt_journal) AND (EXISTS(SELECT 1 FROM dataset_operations WHERE id=NEW.id AND operation_type='catalog_map') OR (NEW.operation_type='catalog_map' AND (json_extract(ltds_catalog_identity(NEW.payload_json,NEW.processing_attempt_id),'$.status')<>'resolved' OR EXISTS(SELECT 1 FROM viewer_reference_attempt_journal WHERE attempt_id=json_extract(ltds_catalog_identity(NEW.payload_json,NEW.processing_attempt_id),'$.payloadAttemptId') OR attempt_id=NEW.processing_attempt_id)))) BEGIN SELECT RAISE(ABORT,'reference catalog identity conflict'); END;
    CREATE TRIGGER viewer_reference_catalog_exclusion_update BEFORE UPDATE OF id,operation_type,payload_json,processing_attempt_id ON dataset_operations WHEN EXISTS(SELECT 1 FROM viewer_reference_attempt_journal) AND ((OLD.operation_type='catalog_map' AND (NOT EXISTS(SELECT 1 FROM reference_catalog_projection WHERE operation_id=OLD.id AND status='resolved') OR EXISTS(SELECT 1 FROM reference_catalog_projection p JOIN viewer_reference_attempt_journal j ON j.attempt_id=p.payload_attempt_id OR j.attempt_id=p.column_attempt_id WHERE p.operation_id=OLD.id))) OR (NEW.operation_type='catalog_map' AND (json_extract(ltds_catalog_identity(NEW.payload_json,NEW.processing_attempt_id),'$.status')<>'resolved' OR EXISTS(SELECT 1 FROM viewer_reference_attempt_journal WHERE attempt_id=json_extract(ltds_catalog_identity(NEW.payload_json,NEW.processing_attempt_id),'$.payloadAttemptId') OR attempt_id=NEW.processing_attempt_id)))) BEGIN SELECT RAISE(ABORT,'reference catalog identity conflict'); END;
    CREATE TRIGGER viewer_reference_catalog_exclusion_delete BEFORE DELETE ON dataset_operations WHEN OLD.operation_type='catalog_map' AND EXISTS(SELECT 1 FROM viewer_reference_attempt_journal) AND (NOT EXISTS(SELECT 1 FROM reference_catalog_projection WHERE operation_id=OLD.id AND status='resolved') OR EXISTS(SELECT 1 FROM reference_catalog_projection p JOIN viewer_reference_attempt_journal j ON j.attempt_id=p.payload_attempt_id OR j.attempt_id=p.column_attempt_id WHERE p.operation_id=OLD.id)) BEGIN SELECT RAISE(ABORT,'reference catalog identity conflict'); END;
    -- OR REPLACE may silently delete another row through a secondary unique
    -- key with recursive_triggers disabled; protect catalog rows for all keys.
    CREATE TRIGGER viewer_reference_catalog_replace_insert BEFORE INSERT ON dataset_operations WHEN EXISTS(SELECT 1 FROM viewer_reference_attempt_journal) AND EXISTS(SELECT 1 FROM dataset_operations o WHERE o.operation_type='catalog_map' AND (o.id=NEW.id OR o.rowid=NEW.rowid OR (NEW.upload_id IS NOT NULL AND o.upload_id=NEW.upload_id AND NEW.status IN ('queued','leased','awaiting_derivatives','succeeded') AND o.status IN ('queued','leased','awaiting_derivatives','succeeded')) OR (NEW.import_preview_id IS NOT NULL AND o.import_preview_id=NEW.import_preview_id AND NEW.status IN ('queued','leased','awaiting_derivatives','succeeded') AND o.status IN ('queued','leased','awaiting_derivatives','succeeded')) OR (NEW.processing_attempt_id IS NOT NULL AND o.processing_attempt_id=NEW.processing_attempt_id AND NEW.status='awaiting_derivatives' AND o.status='awaiting_derivatives'))) BEGIN SELECT RAISE(ABORT,'reference catalog replacement conflict'); END;
    CREATE TRIGGER viewer_reference_catalog_replace_update BEFORE UPDATE ON dataset_operations WHEN EXISTS(SELECT 1 FROM viewer_reference_attempt_journal) AND EXISTS(SELECT 1 FROM dataset_operations o WHERE o.operation_type='catalog_map' AND o.id IS NOT OLD.id AND (o.id=NEW.id OR o.rowid=NEW.rowid OR (NEW.upload_id IS NOT NULL AND o.upload_id=NEW.upload_id AND NEW.status IN ('queued','leased','awaiting_derivatives','succeeded') AND o.status IN ('queued','leased','awaiting_derivatives','succeeded')) OR (NEW.import_preview_id IS NOT NULL AND o.import_preview_id=NEW.import_preview_id AND NEW.status IN ('queued','leased','awaiting_derivatives','succeeded') AND o.status IN ('queued','leased','awaiting_derivatives','succeeded')) OR (NEW.processing_attempt_id IS NOT NULL AND o.processing_attempt_id=NEW.processing_attempt_id AND NEW.status='awaiting_derivatives' AND o.status='awaiting_derivatives'))) BEGIN SELECT RAISE(ABORT,'reference catalog replacement conflict'); END;
  `},

  // Source-stage identity only. No API, scheduler or custody authority is
  // enabled. Admission cannot be enabled by updating configuration or rows.
  {version:51,name:'viewer_reference_protocol_identity',sql:`
    CREATE TRIGGER viewer_gcp_snapshot_no_replace BEFORE INSERT ON processing_attempt_gcp_snapshots WHEN typeof(NEW.attempt_id)<>'text' OR length(NEW.attempt_id)=0 OR EXISTS(SELECT 1 FROM processing_attempt_gcp_snapshots WHERE attempt_id=NEW.attempt_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'gcp snapshot replacement'); END;
    CREATE TABLE viewer_reference_providers(id TEXT PRIMARY KEY NOT NULL,display_name TEXT NOT NULL,origin TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled=0));
    CREATE TABLE viewer_reference_attempt_genesis(attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES processing_attempts(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,reference_provider_id TEXT NOT NULL REFERENCES viewer_reference_providers(id) ON DELETE RESTRICT,FOREIGN KEY(attempt_id) REFERENCES viewer_reference_attempt_protocols(attempt_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(attempt_id) REFERENCES viewer_reference_attempt_journal(attempt_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE viewer_reference_attempt_protocols(attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES processing_attempts(id) ON DELETE RESTRICT,reference_provider_id TEXT NOT NULL REFERENCES viewer_reference_providers(id) ON DELETE RESTRICT,protocol TEXT NOT NULL CHECK(protocol='reference-v1'));
    CREATE TABLE viewer_reference_gcp_artifacts(attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES processing_attempt_gcp_snapshots(attempt_id) ON DELETE RESTRICT,object_id TEXT NOT NULL UNIQUE,relative_path TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL CHECK(length(sha256)=64),byte_size INTEGER NOT NULL CHECK(typeof(byte_size)='integer' AND byte_size>0));
    CREATE TRIGGER viewer_reference_gcp_artifact_validate BEFORE INSERT ON viewer_reference_gcp_artifacts WHEN NOT EXISTS(SELECT 1 FROM viewer_reference_attempt_protocols WHERE attempt_id=NEW.attempt_id) OR NOT EXISTS(SELECT 1 FROM processing_attempt_gcp_snapshots s WHERE s.attempt_id=NEW.attempt_id AND s.sha256=NEW.sha256 AND length(CAST(s.content_text AS BLOB))=NEW.byte_size) OR EXISTS(SELECT 1 FROM viewer_reference_gcp_artifacts WHERE attempt_id=NEW.attempt_id OR object_id=NEW.object_id OR relative_path=NEW.relative_path OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'reference GCP artifact conflict'); END;
    CREATE TRIGGER viewer_reference_gcp_artifact_immutable BEFORE UPDATE ON viewer_reference_gcp_artifacts BEGIN SELECT RAISE(ABORT,'reference GCP artifact immutable'); END;
    CREATE TRIGGER viewer_reference_gcp_artifact_no_delete BEFORE DELETE ON viewer_reference_gcp_artifacts BEGIN SELECT RAISE(ABORT,'reference GCP artifact retained'); END;
    CREATE TRIGGER viewer_reference_provider_unavailable BEFORE INSERT ON viewer_reference_providers BEGIN SELECT RAISE(ABORT,'reference provider unavailable'); END;
    CREATE TRIGGER viewer_reference_provider_immutable BEFORE UPDATE ON viewer_reference_providers BEGIN SELECT RAISE(ABORT,'reference provider immutable'); END;
    CREATE TRIGGER viewer_reference_provider_no_delete BEFORE DELETE ON viewer_reference_providers BEGIN SELECT RAISE(ABORT,'reference provider retained'); END;
    CREATE TRIGGER viewer_reference_provider_no_replace BEFORE INSERT ON viewer_reference_providers WHEN EXISTS(SELECT 1 FROM viewer_reference_providers WHERE id=NEW.id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'reference provider replacement'); END;
    CREATE TRIGGER viewer_reference_genesis_unavailable BEFORE INSERT ON viewer_reference_attempt_genesis BEGIN SELECT RAISE(ABORT,'reference genesis unavailable'); END;
    CREATE TRIGGER viewer_reference_genesis_no_existing BEFORE INSERT ON viewer_reference_attempt_genesis WHEN EXISTS(SELECT 1 FROM processing_attempts WHERE id=NEW.attempt_id) OR EXISTS(SELECT 1 FROM viewer_reference_attempt_genesis WHERE attempt_id=NEW.attempt_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'reference genesis conflict'); END;
    CREATE TRIGGER viewer_reference_genesis_immutable BEFORE UPDATE ON viewer_reference_attempt_genesis BEGIN SELECT RAISE(ABORT,'reference genesis immutable'); END;
    CREATE TRIGGER viewer_reference_genesis_no_delete BEFORE DELETE ON viewer_reference_attempt_genesis BEGIN SELECT RAISE(ABORT,'reference genesis retained'); END;
    CREATE TRIGGER viewer_reference_genesis_attempt_insert BEFORE INSERT ON processing_attempts WHEN EXISTS(SELECT 1 FROM viewer_reference_attempt_genesis WHERE attempt_id=NEW.id) AND (NEW.provider_id IS NOT NULL OR NEW.provider_task_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'reference attempt provider conflict'); END;
    CREATE TRIGGER viewer_reference_genesis_attempt_update BEFORE UPDATE ON processing_attempts WHEN EXISTS(SELECT 1 FROM viewer_reference_attempt_genesis WHERE attempt_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid OR NEW.task_id IS NOT OLD.task_id OR NEW.dataset_id IS NOT OLD.dataset_id OR NEW.attempt_number IS NOT OLD.attempt_number OR NEW.provider_id IS NOT OLD.provider_id OR NEW.provider_task_id IS NOT OLD.provider_task_id OR NEW.options_json IS NOT OLD.options_json OR NEW.capability_fingerprint IS NOT OLD.capability_fingerprint OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at) BEGIN SELECT RAISE(ABORT,'reference attempt identity immutable'); END;
    CREATE TRIGGER viewer_reference_genesis_attempt_replace_insert BEFORE INSERT ON processing_attempts WHEN EXISTS(SELECT 1 FROM processing_attempts a JOIN viewer_reference_attempt_genesis g ON g.attempt_id=a.id WHERE a.id=NEW.id OR a.rowid=NEW.rowid OR (a.task_id=NEW.task_id AND a.attempt_number=NEW.attempt_number) OR (NEW.provider_id IS NOT NULL AND NEW.provider_task_id IS NOT NULL AND a.provider_id=NEW.provider_id AND a.provider_task_id=NEW.provider_task_id)) BEGIN SELECT RAISE(ABORT,'reference attempt replacement'); END;
    CREATE TRIGGER viewer_reference_genesis_attempt_replace_update BEFORE UPDATE ON processing_attempts WHEN EXISTS(SELECT 1 FROM processing_attempts a JOIN viewer_reference_attempt_genesis g ON g.attempt_id=a.id WHERE a.id IS NOT OLD.id AND (a.id=NEW.id OR a.rowid=NEW.rowid OR (a.task_id=NEW.task_id AND a.attempt_number=NEW.attempt_number) OR (NEW.provider_id IS NOT NULL AND NEW.provider_task_id IS NOT NULL AND a.provider_id=NEW.provider_id AND a.provider_task_id=NEW.provider_task_id))) BEGIN SELECT RAISE(ABORT,'reference attempt replacement'); END;
    CREATE TRIGGER viewer_reference_protocol_unavailable BEFORE INSERT ON viewer_reference_attempt_protocols BEGIN SELECT RAISE(ABORT,'reference protocol unavailable'); END;
    CREATE TRIGGER viewer_reference_protocol_requires_genesis BEFORE INSERT ON viewer_reference_attempt_protocols WHEN NOT EXISTS(SELECT 1 FROM viewer_reference_attempt_genesis g JOIN processing_attempts a ON a.id=g.attempt_id WHERE g.attempt_id=NEW.attempt_id AND g.reference_provider_id=NEW.reference_provider_id AND a.provider_id IS NULL AND a.provider_task_id IS NULL) BEGIN SELECT RAISE(ABORT,'reference protocol genesis required'); END;
    CREATE TRIGGER viewer_reference_protocol_immutable BEFORE UPDATE ON viewer_reference_attempt_protocols BEGIN SELECT RAISE(ABORT,'reference protocol immutable'); END;
    CREATE TRIGGER viewer_reference_protocol_no_delete BEFORE DELETE ON viewer_reference_attempt_protocols BEGIN SELECT RAISE(ABORT,'reference protocol retained'); END;
    CREATE TRIGGER viewer_reference_protocol_no_replace BEFORE INSERT ON viewer_reference_attempt_protocols WHEN EXISTS(SELECT 1 FROM viewer_reference_attempt_protocols WHERE attempt_id=NEW.attempt_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'reference protocol replacement'); END;
  `},
  // Provisional reference integration allocation. Never apply
  // to an existing deployment until its actual migration ledger is verified.
  {version:52,name:'viewer_gcp_raw_source_journal',sql:`
    CREATE TABLE viewer_gcp_raw_sources (
      id TEXT PRIMARY KEY NOT NULL,
      dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
      source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
      source_bytes BLOB NOT NULL CHECK(typeof(source_bytes)='blob' AND length(source_bytes)>0 AND length(source_bytes)<=2097152),
      source_filename TEXT NOT NULL CHECK(length(source_filename) BETWEEN 1 AND 240),
      source_format TEXT NOT NULL CHECK(source_format IN ('generic-csv-v1','emlid-all-columns-v1')),
      display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
      declarations_json TEXT NOT NULL CHECK(json_valid(declarations_json)),
      confirmation_token TEXT NOT NULL CHECK(length(confirmation_token)=64),
      created_by TEXT NOT NULL,
      request_key TEXT NOT NULL,
      archive_relative_path TEXT NOT NULL,
      set_id TEXT UNIQUE REFERENCES gcp_sets(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('pending','ready')),
      created_at TEXT NOT NULL,
      ready_at TEXT,
      UNIQUE(created_by,request_key),
      CHECK((status='pending' AND ready_at IS NULL AND set_id IS NULL) OR (status='ready' AND ready_at IS NOT NULL AND set_id IS NOT NULL))
    );
    CREATE INDEX viewer_gcp_raw_sources_dataset_idx ON viewer_gcp_raw_sources(dataset_id,status,source_sha256);
    CREATE TRIGGER viewer_gcp_raw_sources_no_replace BEFORE INSERT ON viewer_gcp_raw_sources
      WHEN NEW.status!='pending' OR EXISTS(SELECT 1 FROM viewer_gcp_raw_sources WHERE id=NEW.id OR rowid=NEW.rowid OR (created_by=NEW.created_by AND request_key=NEW.request_key) OR (NEW.set_id IS NOT NULL AND set_id=NEW.set_id))
      BEGIN SELECT RAISE(ABORT,'raw GCP source replacement prohibited'); END;
    CREATE TRIGGER viewer_gcp_raw_sources_immutable BEFORE UPDATE ON viewer_gcp_raw_sources
      WHEN NEW.id IS NOT OLD.id OR NEW.dataset_id IS NOT OLD.dataset_id OR NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.source_bytes IS NOT OLD.source_bytes OR NEW.source_filename IS NOT OLD.source_filename OR NEW.source_format IS NOT OLD.source_format OR NEW.display_name IS NOT OLD.display_name OR NEW.declarations_json IS NOT OLD.declarations_json OR NEW.confirmation_token IS NOT OLD.confirmation_token OR NEW.created_by IS NOT OLD.created_by OR NEW.request_key IS NOT OLD.request_key OR NEW.archive_relative_path IS NOT OLD.archive_relative_path OR NEW.created_at IS NOT OLD.created_at OR OLD.status!='pending' OR NEW.status!='ready' OR NEW.set_id!=OLD.id OR NOT EXISTS(SELECT 1 FROM gcp_sets WHERE id=NEW.set_id AND dataset_id=NEW.dataset_id AND source_sha256=NEW.source_sha256)
      BEGIN SELECT RAISE(ABORT,'raw GCP source immutable'); END;
    CREATE TRIGGER viewer_gcp_raw_sources_no_delete BEFORE DELETE ON viewer_gcp_raw_sources
      BEGIN SELECT RAISE(ABORT,'raw GCP source retained'); END;
  `},

  // Isolated prototype only. Admission is unconditionally disabled. This is
  // an indexed-data binding, not filesystem custody or a retention receipt.
  {version:53,name:'viewer_source_binding_draft',sql:`
    CREATE TABLE viewer_source_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
      dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      root_key TEXT NOT NULL, relative_path TEXT NOT NULL,
      dataset_manifest_sha256 TEXT NOT NULL CHECK(length(dataset_manifest_sha256)=64 AND dataset_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
      object_count INTEGER NOT NULL CHECK(object_count>0),
      state TEXT NOT NULL CHECK(state IN ('building','prepared')), created_at TEXT NOT NULL
    );
    CREATE INDEX viewer_source_bindings_dataset_idx ON viewer_source_bindings(dataset_id);
    CREATE TABLE viewer_source_effect_claims (
      id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL,
      effect_type TEXT NOT NULL CHECK(effect_type IN ('catalog_adoption_recovery','import_cleanup')),
      root_key TEXT NOT NULL, relative_path TEXT NOT NULL, dataset_relative TEXT NOT NULL,
      lease_owner TEXT, lease_token TEXT, lease_generation INTEGER,
      state TEXT NOT NULL CHECK(state IN ('in_flight','completed')),
      created_at TEXT NOT NULL, completed_at TEXT,
      CHECK((state='in_flight' AND completed_at IS NULL) OR (state='completed' AND completed_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX viewer_source_effect_one_inflight ON viewer_source_effect_claims(operation_id) WHERE state='in_flight';
    CREATE TRIGGER viewer_source_effect_block_bound BEFORE INSERT ON viewer_source_effect_claims WHEN EXISTS(SELECT 1 FROM viewer_source_bindings) BEGIN SELECT RAISE(ABORT,'source binding retained'); END;
    CREATE TRIGGER viewer_source_effect_no_replace BEFORE INSERT ON viewer_source_effect_claims WHEN EXISTS(SELECT 1 FROM viewer_source_effect_claims WHERE id=NEW.id OR rowid=NEW.rowid OR (operation_id=NEW.operation_id AND state='in_flight' AND NEW.state='in_flight')) BEGIN SELECT RAISE(ABORT,'source effect claim retained'); END;
    CREATE TRIGGER viewer_source_effect_no_delete BEFORE DELETE ON viewer_source_effect_claims BEGIN SELECT RAISE(ABORT,'source effect claim retained'); END;
    CREATE TRIGGER viewer_source_effect_immutable BEFORE UPDATE ON viewer_source_effect_claims WHEN NOT (OLD.state='in_flight' AND NEW.state='completed' AND NEW.id IS OLD.id AND NEW.rowid IS OLD.rowid AND NEW.operation_id IS OLD.operation_id AND NEW.effect_type IS OLD.effect_type AND NEW.root_key IS OLD.root_key AND NEW.relative_path IS OLD.relative_path AND NEW.dataset_relative IS OLD.dataset_relative AND NEW.lease_owner IS OLD.lease_owner AND NEW.lease_token IS OLD.lease_token AND NEW.lease_generation IS OLD.lease_generation AND NEW.created_at IS OLD.created_at AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'source effect claim immutable'); END;
    CREATE TRIGGER viewer_source_import_effect_guard_update BEFORE UPDATE ON import_cleanup_jobs WHEN EXISTS(SELECT 1 FROM viewer_source_effect_claims c WHERE c.effect_type='import_cleanup' AND c.operation_id=OLD.id AND c.state='in_flight') AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid OR NEW.root_key IS NOT OLD.root_key OR NEW.relative_path IS NOT OLD.relative_path OR NEW.cleanup_type IS NOT OLD.cleanup_type OR NEW.retained_import_id IS NOT OLD.retained_import_id OR ((NEW.lease_owner IS NOT OLD.lease_owner OR NEW.lease_token IS NOT OLD.lease_token) AND NOT (NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.status NOT IN ('leased','quarantined'))) OR NEW.lease_generation IS NOT OLD.lease_generation OR NEW.expected_byte_size IS NOT OLD.expected_byte_size OR NEW.expected_sha256 IS NOT OLD.expected_sha256 OR NEW.expected_dev IS NOT OLD.expected_dev OR NEW.expected_ino IS NOT OLD.expected_ino OR NEW.expected_ctime_ns IS NOT OLD.expected_ctime_ns OR NEW.expected_mtime_ns IS NOT OLD.expected_mtime_ns OR (OLD.quarantine_relative_path IS NOT NULL AND NEW.quarantine_relative_path IS NOT OLD.quarantine_relative_path)) BEGIN SELECT RAISE(ABORT,'source import effect in flight'); END;
    CREATE TRIGGER viewer_source_import_effect_guard_insert BEFORE INSERT ON import_cleanup_jobs WHEN EXISTS(SELECT 1 FROM import_cleanup_jobs j JOIN viewer_source_effect_claims c ON c.operation_id=j.id AND c.effect_type='import_cleanup' AND c.state='in_flight' WHERE j.id=NEW.id OR j.rowid=NEW.rowid OR (j.retained_import_id=NEW.retained_import_id AND j.cleanup_type=NEW.cleanup_type)) BEGIN SELECT RAISE(ABORT,'source import effect in flight'); END;
    CREATE TRIGGER viewer_source_import_effect_guard_update_replace BEFORE UPDATE ON import_cleanup_jobs WHEN EXISTS(SELECT 1 FROM import_cleanup_jobs j JOIN viewer_source_effect_claims c ON c.operation_id=j.id AND c.effect_type='import_cleanup' AND c.state='in_flight' WHERE j.id<>OLD.id AND (j.id=NEW.id OR j.rowid=NEW.rowid OR (j.retained_import_id=NEW.retained_import_id AND j.cleanup_type=NEW.cleanup_type))) BEGIN SELECT RAISE(ABORT,'source import effect in flight'); END;
    CREATE TRIGGER viewer_source_import_effect_guard_delete BEFORE DELETE ON import_cleanup_jobs WHEN EXISTS(SELECT 1 FROM viewer_source_effect_claims c WHERE c.effect_type='import_cleanup' AND c.operation_id=OLD.id AND c.state='in_flight') BEGIN SELECT RAISE(ABORT,'source import effect in flight'); END;
    CREATE TABLE viewer_source_binding_objects (
      binding_id TEXT NOT NULL REFERENCES viewer_source_bindings(id) ON DELETE RESTRICT,
      file_id TEXT NOT NULL REFERENCES dataset_files(id) ON DELETE RESTRICT,
      relative_path TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>=0),
      sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      PRIMARY KEY(binding_id,file_id)
    );
    CREATE TRIGGER viewer_source_binding_unavailable BEFORE INSERT ON viewer_source_bindings BEGIN SELECT RAISE(ABORT,'source binding admission unavailable'); END;
    CREATE TRIGGER viewer_source_binding_no_replace BEFORE INSERT ON viewer_source_bindings WHEN EXISTS(SELECT 1 FROM viewer_source_bindings WHERE id=NEW.id OR rowid=NEW.rowid OR attempt_id=NEW.attempt_id) BEGIN SELECT RAISE(ABORT,'source binding replacement'); END;
    CREATE TRIGGER viewer_source_binding_no_update BEFORE UPDATE ON viewer_source_bindings WHEN NOT (OLD.state='building' AND NEW.state='prepared' AND NEW.id IS OLD.id AND NEW.rowid IS OLD.rowid AND NEW.attempt_id IS OLD.attempt_id AND NEW.dataset_id IS OLD.dataset_id AND NEW.project_id IS OLD.project_id AND NEW.root_key IS OLD.root_key AND NEW.relative_path IS OLD.relative_path AND NEW.dataset_manifest_sha256 IS OLD.dataset_manifest_sha256 AND NEW.object_count IS OLD.object_count AND NEW.created_at IS OLD.created_at AND (SELECT count(*) FROM viewer_source_binding_objects WHERE binding_id=OLD.id)=OLD.object_count) BEGIN SELECT RAISE(ABORT,'source binding immutable'); END;
    CREATE TRIGGER viewer_source_binding_no_delete BEFORE DELETE ON viewer_source_bindings BEGIN SELECT RAISE(ABORT,'source binding retained'); END;
    CREATE TRIGGER viewer_source_binding_object_insert BEFORE INSERT ON viewer_source_binding_objects WHEN COALESCE((SELECT state FROM viewer_source_bindings WHERE id=NEW.binding_id),'')<>'building' OR NOT EXISTS(SELECT 1 FROM viewer_source_bindings b JOIN dataset_files f ON f.id=NEW.file_id AND f.dataset_id=b.dataset_id WHERE b.id=NEW.binding_id AND f.relative_path=NEW.relative_path AND f.byte_size=NEW.byte_size AND f.sha256=NEW.sha256) OR EXISTS(SELECT 1 FROM viewer_source_binding_objects WHERE rowid=NEW.rowid OR (binding_id=NEW.binding_id AND file_id=NEW.file_id)) BEGIN SELECT RAISE(ABORT,'source binding object conflict'); END;
    CREATE TRIGGER viewer_source_binding_object_no_update BEFORE UPDATE ON viewer_source_binding_objects BEGIN SELECT RAISE(ABORT,'source binding object immutable'); END;
    CREATE TRIGGER viewer_source_binding_object_no_delete BEFORE DELETE ON viewer_source_binding_objects BEGIN SELECT RAISE(ABORT,'source binding object retained'); END;
    CREATE TRIGGER viewer_source_binding_dataset_guard_update BEFORE UPDATE ON datasets WHEN EXISTS(SELECT 1 FROM viewer_source_bindings WHERE dataset_id=OLD.id) BEGIN SELECT RAISE(ABORT,'source binding dataset retained'); END;
    CREATE TRIGGER viewer_source_binding_dataset_guard_delete BEFORE DELETE ON datasets WHEN EXISTS(SELECT 1 FROM viewer_source_bindings WHERE dataset_id=OLD.id) BEGIN SELECT RAISE(ABORT,'source binding dataset retained'); END;
    CREATE TRIGGER viewer_source_binding_dataset_guard_insert BEFORE INSERT ON datasets WHEN EXISTS(SELECT 1 FROM datasets d JOIN viewer_source_bindings b ON b.dataset_id=d.id WHERE d.id=NEW.id OR d.rowid=NEW.rowid OR (d.root_key=NEW.root_key AND d.relative_path=NEW.relative_path)) BEGIN SELECT RAISE(ABORT,'source binding dataset retained'); END;
    CREATE TRIGGER viewer_source_binding_file_guard_insert BEFORE INSERT ON dataset_files WHEN EXISTS(SELECT 1 FROM viewer_source_bindings WHERE dataset_id=NEW.dataset_id) OR EXISTS(SELECT 1 FROM dataset_files f JOIN viewer_source_binding_objects b ON b.file_id=f.id WHERE f.id=NEW.id OR f.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'source binding dataset files retained'); END;
    CREATE TRIGGER viewer_source_binding_file_guard_update BEFORE UPDATE ON dataset_files WHEN EXISTS(SELECT 1 FROM viewer_source_bindings WHERE dataset_id=OLD.dataset_id OR dataset_id=NEW.dataset_id) BEGIN SELECT RAISE(ABORT,'source binding dataset files retained'); END;
    CREATE TRIGGER viewer_source_binding_file_guard_delete BEFORE DELETE ON dataset_files WHEN EXISTS(SELECT 1 FROM viewer_source_bindings WHERE dataset_id=OLD.dataset_id) BEGIN SELECT RAISE(ABORT,'source binding dataset files retained'); END;
    CREATE TRIGGER viewer_source_binding_attempt_guard_update BEFORE UPDATE ON processing_attempts WHEN EXISTS(SELECT 1 FROM viewer_source_bindings WHERE attempt_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid OR NEW.dataset_id IS NOT OLD.dataset_id OR NEW.task_id IS NOT OLD.task_id OR NEW.attempt_number IS NOT OLD.attempt_number OR NEW.provider_id IS NOT OLD.provider_id OR NEW.provider_task_id IS NOT OLD.provider_task_id) BEGIN SELECT RAISE(ABORT,'source binding attempt identity retained'); END;
    CREATE TRIGGER viewer_source_binding_attempt_guard_delete BEFORE DELETE ON processing_attempts WHEN EXISTS(SELECT 1 FROM viewer_source_bindings WHERE attempt_id=OLD.id) BEGIN SELECT RAISE(ABORT,'source binding attempt identity retained'); END;
    CREATE TRIGGER viewer_source_binding_attempt_guard_insert BEFORE INSERT ON processing_attempts WHEN EXISTS(SELECT 1 FROM processing_attempts a JOIN viewer_source_bindings b ON b.attempt_id=a.id WHERE a.id=NEW.id OR a.rowid=NEW.rowid OR (a.task_id=NEW.task_id AND a.attempt_number=NEW.attempt_number) OR (NEW.provider_id IS NOT NULL AND NEW.provider_task_id IS NOT NULL AND a.provider_id=NEW.provider_id AND a.provider_task_id=NEW.provider_task_id)) BEGIN SELECT RAISE(ABORT,'source binding attempt identity retained'); END;
    CREATE TRIGGER viewer_source_binding_task_guard_update BEFORE UPDATE ON processing_tasks WHEN EXISTS(SELECT 1 FROM viewer_source_bindings b JOIN processing_attempts a ON a.id=b.attempt_id WHERE a.task_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid OR NEW.dataset_id IS NOT OLD.dataset_id OR NEW.project_id IS NOT OLD.project_id) BEGIN SELECT RAISE(ABORT,'source binding task identity retained'); END;
    CREATE TRIGGER viewer_source_binding_task_guard_delete BEFORE DELETE ON processing_tasks WHEN EXISTS(SELECT 1 FROM viewer_source_bindings b JOIN processing_attempts a ON a.id=b.attempt_id WHERE a.task_id=OLD.id) BEGIN SELECT RAISE(ABORT,'source binding task identity retained'); END;
    CREATE TRIGGER viewer_source_binding_task_guard_insert BEFORE INSERT ON processing_tasks WHEN EXISTS(SELECT 1 FROM processing_tasks t JOIN processing_attempts a ON a.task_id=t.id JOIN viewer_source_bindings b ON b.attempt_id=a.id WHERE t.id=NEW.id OR t.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'source binding task identity retained'); END;
  `},
];

function applyMigrations(database) {
  installReferenceCatalogIdentity(database);
  const {assertProtectedMigrationIdentity}=require('./migrationIdentityGuard');
  database.exec('BEGIN IMMEDIATE');
  try {
    assertProtectedMigrationIdentity(database,MIGRATIONS);
    database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
    `);
    database.exec('COMMIT');
  } catch(error) { database.exec('ROLLBACK'); throw error; }
  for (const migration of MIGRATIONS) {
    database.exec('BEGIN IMMEDIATE');
    try {
      assertProtectedMigrationIdentity(database,MIGRATIONS);
      // Re-check only after holding SQLite's write reservation. The API and
      // worker can start against the same fresh/upgraded volume concurrently;
      // a pre-lock snapshot would let the waiter apply an already-committed
      // ALTER TABLE a second time.
      const applied = database.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version);
      if (applied) {
        database.exec('COMMIT');
        continue;
      }
      database.exec(migration.sql);
      migration.after?.(database);
      database.prepare(
        'INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)',
      ).run(migration.version, migration.name, new Date().toISOString());
      assertProtectedMigrationIdentity(database,MIGRATIONS);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function withBusyRetry(operation, timeoutMs = 5000) {
  const startedAt = Date.now();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return operation(); }
    catch (error) {
      const busy = error?.errcode === 5 || error?.code === 'SQLITE_BUSY' || /database is locked/i.test(error?.message ?? '');
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (!busy || remaining <= 0) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(25, remaining));
    }
  }
}

function openDatabase(databasePath) {
  if (!databasePath) throw new Error('databasePath is required');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  // Set the lock wait before journal-mode initialization so two first-boot
  // processes do not fail while one establishes the WAL files.
  database.exec('PRAGMA busy_timeout=5000');
  database.exec('PRAGMA foreign_keys=ON');
  // SQLite's journal-mode transition may return SQLITE_BUSY without invoking
  // the configured busy handler during simultaneous first boot. Retry only
  // that bounded initialization transition; migration locking remains native.
  try {
    // Detect known collisions before changing the existing database's journal
    // mode or applying any migration. Recheck under every migration lock.
    database.exec('BEGIN IMMEDIATE');
    try {require('./migrationIdentityGuard').assertProtectedMigrationIdentity(database,MIGRATIONS);database.exec('ROLLBACK');}
    catch(error){database.exec('ROLLBACK');throw error;}
    withBusyRetry(() => database.exec('PRAGMA journal_mode=WAL'));
    database.exec('PRAGMA synchronous=NORMAL');
    applyMigrations(database);
  }
  catch (error) { database.close(); throw error; }
  return database;
}

module.exports = { MIGRATIONS, applyMigrations, openDatabase };
