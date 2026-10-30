'use strict';

const {DatabaseSync}=require('node:sqlite');

// Only the newly allocated migration identities are checked here. Earlier
// ledger history retains its established compatibility behavior.
const protectedMigrations=[
  {version:41,name:'gcp_odm_crs_confirmations',objects:['gcp_odm_crs_confirmations']},
  {version:42,name:'viewer_workspace_hierarchy',objects:['viewer_organizations','viewer_project_groups','viewer_project_hierarchy','viewer_project_groups_org_idx','viewer_project_hierarchy_org_idx']},
  {version:45,name:'processing_archive_capture_intents',objects:['processing_archive_capture_intents']},
  {version:46,name:'processing_staged_byte_ack_outbox',objects:['processing_staged_commitments','processing_staged_byte_ack_outbox']},
  {version:47,name:'processing_staged_ack_delivery',objects:['processing_staged_receipt_bindings','processing_staged_ack_delivery']},
  {version:48,name:'viewer_cooperative_capacity_ledger',objects:['viewer_capacity_control','viewer_capacity_control_no_replace','viewer_capacity_reservations','viewer_capacity_reservations_domain_idx','viewer_capacity_materialized_monotonic','viewer_capacity_no_replacement','viewer_capacity_identity_immutable','viewer_capacity_no_delete','viewer_capacity_state_transition']},
  {version:49,name:'viewer_source_custody_dormant',objects:['viewer_custody_intents','viewer_custody_pins','viewer_custody_intents_immutable','viewer_custody_intents_no_replace','viewer_custody_pins_no_late_insert','viewer_custody_intents_no_delete','viewer_custody_pins_immutable','viewer_custody_pins_no_delete']},
  {version:50,name:'viewer_reference_attempt_journal',objects:['viewer_reference_attempt_journal','viewer_reference_attempt_identity_immutable','viewer_reference_attempt_no_insert_replace','viewer_reference_attempt_no_update_replace','viewer_reference_attempt_no_delete','viewer_reference_attempt_admission_unavailable','viewer_reference_projection_admission','viewer_reference_catalog_exclusion_insert','viewer_reference_catalog_exclusion_update','viewer_reference_catalog_exclusion_delete','viewer_reference_catalog_replace_insert','viewer_reference_catalog_replace_update','viewer_reference_catalog_operation_idx','reference_catalog_projection','reference_catalog_payload_attempt_idx','reference_catalog_column_attempt_idx','reference_catalog_unresolved_idx','reference_catalog_invalid_operation_id_idx','reference_catalog_projection_state','reference_catalog_state_no_replace','reference_catalog_state_no_delete','reference_catalog_complete_requires_coverage','reference_catalog_projection_validate_insert','reference_catalog_projection_validate_update','reference_catalog_projection_no_missing','reference_catalog_invalid_id_insert','reference_catalog_invalid_id_update','reference_catalog_projection_insert','reference_catalog_projection_update','reference_catalog_projection_delete']},
  {version:51,name:'viewer_reference_protocol_identity',objects:['viewer_gcp_snapshot_no_replace','viewer_reference_providers','viewer_reference_attempt_genesis','viewer_reference_attempt_protocols','viewer_reference_gcp_artifacts','viewer_reference_gcp_artifact_validate','viewer_reference_gcp_artifact_immutable','viewer_reference_gcp_artifact_no_delete','viewer_reference_provider_unavailable','viewer_reference_provider_immutable','viewer_reference_provider_no_delete','viewer_reference_provider_no_replace','viewer_reference_genesis_unavailable','viewer_reference_genesis_no_existing','viewer_reference_genesis_immutable','viewer_reference_genesis_no_delete','viewer_reference_genesis_attempt_insert','viewer_reference_genesis_attempt_update','viewer_reference_genesis_attempt_replace_insert','viewer_reference_genesis_attempt_replace_update','viewer_reference_protocol_unavailable','viewer_reference_protocol_requires_genesis','viewer_reference_protocol_immutable','viewer_reference_protocol_no_delete','viewer_reference_protocol_no_replace']},
  {version:52,name:'viewer_gcp_raw_source_journal',objects:['viewer_gcp_raw_sources','viewer_gcp_raw_sources_dataset_idx','viewer_gcp_raw_sources_no_replace','viewer_gcp_raw_sources_immutable','viewer_gcp_raw_sources_no_delete']},
  {version:53,name:'viewer_source_binding_draft',objects:['viewer_source_bindings','viewer_source_bindings_dataset_idx','viewer_source_effect_claims','viewer_source_effect_one_inflight','viewer_source_effect_block_bound','viewer_source_effect_no_replace','viewer_source_effect_no_delete','viewer_source_effect_immutable','viewer_source_import_effect_guard_update','viewer_source_import_effect_guard_insert','viewer_source_import_effect_guard_update_replace','viewer_source_import_effect_guard_delete','viewer_source_binding_objects','viewer_source_binding_unavailable','viewer_source_binding_no_replace','viewer_source_binding_no_update','viewer_source_binding_no_delete','viewer_source_binding_object_insert','viewer_source_binding_object_no_update','viewer_source_binding_object_no_delete','viewer_source_binding_dataset_guard_update','viewer_source_binding_dataset_guard_delete','viewer_source_binding_dataset_guard_insert','viewer_source_binding_file_guard_insert','viewer_source_binding_file_guard_update','viewer_source_binding_file_guard_delete','viewer_source_binding_attempt_guard_update','viewer_source_binding_attempt_guard_delete','viewer_source_binding_attempt_guard_insert','viewer_source_binding_task_guard_update','viewer_source_binding_task_guard_delete','viewer_source_binding_task_guard_insert']},

];
// Strict comparison intentionally rejects harmless formatting differences as
// well; normalizing whitespace could alter quoted SQL literals.
const normalize=sql=>String(sql||'').trim().replace(/;\s*$/,'');
function incompatible(reason){return Object.assign(new Error(`Protected migration identity or schema is incompatible: ${reason}`),{code:'migration_identity_conflict'});}

function assertProtectedMigrationIdentity(database,migrations) {
  // SQLite object identifiers are case-insensitive even though sqlite_master
  // name comparisons default to binary collation. Discover collisions with the
  // same semantics SQLite uses, then require the canonical spelling and type.
  const ledgers=database.prepare("SELECT type,name FROM sqlite_master WHERE name=? COLLATE NOCASE").all('schema_migrations');
  if(ledgers.length>1||ledgers.some(row=>row.type!=='table'||row.name!=='schema_migrations'))throw incompatible('noncanonical migration ledger');
  const ledger=ledgers[0];
  const reservationEntry=ledger?database.prepare('SELECT name FROM schema_migrations WHERE version=44').get():null;
  const reservationObjects=database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name=? COLLATE NOCASE").all('processing_attempt_reservations');
  const reservationColumns=['processing_attempts','processing_providers'].map(table=>database.prepare(`PRAGMA table_info(${table})`).all().filter(column=>String(column.name).toLowerCase()==='reservation_required'));
  if(!reservationEntry){
    if(reservationObjects.length||reservationColumns.some(columns=>columns.length))throw incompatible('unrecorded objects for 44');
  }else{
    if(reservationEntry.name!=='processing_attempt_reservation_capabilities')throw incompatible('version 44 has a different name');
    const migration=migrations.find(item=>item.version===44&&item.name===reservationEntry.name);
    if(!migration)throw incompatible('version 44 is not supported by this build');
    const expected=new DatabaseSync(':memory:');
    try{
      expected.exec('CREATE TABLE processing_attempts(id TEXT PRIMARY KEY); CREATE TABLE processing_providers(id TEXT PRIMARY KEY);');
      expected.exec(migration.sql);
      const reference=expected.prepare("SELECT type,name,sql FROM sqlite_master WHERE name='processing_attempt_reservations'").get(),actual=reservationObjects[0];
      if(reservationObjects.length!==1||!actual||actual.name!==reference.name||actual.type!==reference.type||normalize(actual.sql)!==normalize(reference.sql))throw incompatible('schema mismatch for processing_attempt_reservations');
      const extras=database.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL AND tbl_name=? COLLATE NOCASE").all('processing_attempt_reservations');
      if(extras.length)throw incompatible('unexpected reservation index or trigger');
      for(let i=0;i<reservationColumns.length;i++){
        const table=['processing_attempts','processing_providers'][i],column=reservationColumns[i][0],referenceColumn=expected.prepare(`PRAGMA table_info(${table})`).all().find(item=>item.name==='reservation_required');
        if(reservationColumns[i].length!==1||!column||column.name!==referenceColumn.name||column.type!==referenceColumn.type||column.notnull!==referenceColumn.notnull||column.dflt_value!==referenceColumn.dflt_value||column.pk!==referenceColumn.pk)throw incompatible('reservation column mismatch');
        const tableSql=database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql||'';
        if(!tableSql.includes('reservation_required INTEGER NOT NULL DEFAULT 0 CHECK (reservation_required IN (0,1))'))throw incompatible('reservation column constraint mismatch');
      }
    }finally{expected.close();}
  }
  if(ledger) for(const row of database.prepare('SELECT version,name FROM schema_migrations WHERE version>=41').all()) {
    if(row.version===44 && row.name==='processing_attempt_reservation_capabilities')continue;
    if(!protectedMigrations.some(spec=>spec.version===row.version && spec.name===row.name))throw incompatible(`unsupported version ${row.version}`);
  }
  for(const spec of protectedMigrations) {
    const entry=ledger?database.prepare('SELECT name FROM schema_migrations WHERE version=?').get(spec.version):null;
    const found=spec.objects.map(name=>database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=? COLLATE NOCASE").all(name));
    if(!entry){if(found.some(rows=>rows.length))throw incompatible(`unrecorded objects for ${spec.version}`);continue;}
    if(entry.name!==spec.name)throw incompatible(`version ${spec.version} has a different name`);
    const expectedMigration=migrations.find(item=>item.version===spec.version&&item.name===spec.name);
    if(!expectedMigration)throw incompatible(`version ${spec.version} is not supported by this build`);
    const expected=new DatabaseSync(':memory:');
    try {
      if(spec.version===50)expected.exec('CREATE TABLE dataset_operations(id TEXT PRIMARY KEY,operation_type TEXT,payload_json TEXT,processing_attempt_id TEXT,status TEXT,upload_id TEXT,import_preview_id TEXT)');
      if(spec.version===51)expected.exec('CREATE TABLE processing_attempts(id TEXT PRIMARY KEY,provider_id TEXT,provider_task_id TEXT); CREATE TABLE processing_attempt_gcp_snapshots(attempt_id TEXT PRIMARY KEY)');
      if(spec.version===53)expected.exec('CREATE TABLE import_cleanup_jobs(id TEXT PRIMARY KEY,retained_import_id TEXT,cleanup_type TEXT,root_key TEXT,relative_path TEXT,status TEXT,lease_owner TEXT,lease_token TEXT,lease_generation INTEGER,expected_byte_size INTEGER,expected_sha256 TEXT,expected_dev TEXT,expected_ino TEXT,expected_ctime_ns TEXT,expected_mtime_ns TEXT,quarantine_relative_path TEXT); CREATE TABLE datasets(id TEXT PRIMARY KEY,root_key TEXT,relative_path TEXT); CREATE TABLE dataset_files(id TEXT PRIMARY KEY,dataset_id TEXT,relative_path TEXT,byte_size INTEGER,sha256 TEXT); CREATE TABLE processing_attempts(id TEXT PRIMARY KEY,dataset_id TEXT,task_id TEXT,attempt_number INTEGER,provider_id TEXT,provider_task_id TEXT); CREATE TABLE processing_tasks(id TEXT PRIMARY KEY,project_id TEXT,dataset_id TEXT)');
      expected.exec(expectedMigration.sql);
      for(let i=0;i<spec.objects.length;i++) {
        const object=spec.objects[i],matches=found[i],actual=matches[0],reference=expected.prepare('SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?').get(object);
        if(matches.length!==1||!reference||actual.name!==object||reference.type!==actual.type||reference.tbl_name!==actual.tbl_name||normalize(reference.sql)!==normalize(actual.sql))throw incompatible(`schema mismatch for ${object}`);
      }
      const tables=spec.objects.filter((_,i)=>found[i][0]?.type==='table');
      const extras=database.prepare(`SELECT type,name,tbl_name FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL AND tbl_name COLLATE NOCASE IN (${tables.map(()=>'?').join(',')})`).all(...tables);
      if(extras.some(row=>!expected.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=? AND tbl_name=?').get(row.type,row.name,row.tbl_name)))throw incompatible(`unexpected index or trigger for version ${spec.version}`);
    } finally {expected.close();}
  }
}

module.exports={assertProtectedMigrationIdentity};
