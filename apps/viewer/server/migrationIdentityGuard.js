'use strict';

const {DatabaseSync}=require('node:sqlite');

// Only the newly allocated migration identities are checked here. Earlier
// ledger history retains its established compatibility behavior.
const protectedMigrations=[
  {version:41,name:'gcp_odm_crs_confirmations',objects:['gcp_odm_crs_confirmations']},
  {version:42,name:'viewer_workspace_hierarchy',objects:['viewer_organizations','viewer_project_groups','viewer_project_hierarchy','viewer_project_groups_org_idx','viewer_project_hierarchy_org_idx']},
  {version:43,name:'viewer_cooperative_capacity_ledger',objects:['viewer_capacity_control','viewer_capacity_control_no_replace','viewer_capacity_reservations','viewer_capacity_reservations_domain_idx','viewer_capacity_materialized_monotonic','viewer_capacity_no_replacement','viewer_capacity_identity_immutable','viewer_capacity_no_delete','viewer_capacity_state_transition']},
  {version:44,name:'viewer_source_custody_dormant',objects:['viewer_custody_intents','viewer_custody_pins','viewer_custody_intents_immutable','viewer_custody_intents_no_replace','viewer_custody_pins_no_late_insert','viewer_custody_intents_no_delete','viewer_custody_pins_immutable','viewer_custody_pins_no_delete']},
  {version:45,name:'viewer_reference_attempt_journal',objects:['viewer_reference_attempt_journal','viewer_reference_attempt_identity_immutable','viewer_reference_attempt_no_insert_replace','viewer_reference_attempt_no_update_replace','viewer_reference_attempt_no_delete','viewer_reference_attempt_admission_unavailable','viewer_reference_projection_admission','viewer_reference_catalog_exclusion_insert','viewer_reference_catalog_exclusion_update','viewer_reference_catalog_exclusion_delete','viewer_reference_catalog_replace_insert','viewer_reference_catalog_replace_update','viewer_reference_catalog_operation_idx','reference_catalog_projection','reference_catalog_payload_attempt_idx','reference_catalog_column_attempt_idx','reference_catalog_unresolved_idx','reference_catalog_invalid_operation_id_idx','reference_catalog_projection_state','reference_catalog_state_no_replace','reference_catalog_state_no_delete','reference_catalog_complete_requires_coverage','reference_catalog_projection_validate_insert','reference_catalog_projection_validate_update','reference_catalog_projection_no_missing','reference_catalog_invalid_id_insert','reference_catalog_invalid_id_update','reference_catalog_projection_insert','reference_catalog_projection_update','reference_catalog_projection_delete']},
  {version:46,name:'viewer_reference_protocol_identity',objects:['viewer_gcp_snapshot_no_replace','viewer_reference_providers','viewer_reference_attempt_genesis','viewer_reference_attempt_protocols','viewer_reference_gcp_artifacts','viewer_reference_gcp_artifact_validate','viewer_reference_gcp_artifact_immutable','viewer_reference_gcp_artifact_no_delete','viewer_reference_provider_unavailable','viewer_reference_provider_immutable','viewer_reference_provider_no_delete','viewer_reference_provider_no_replace','viewer_reference_genesis_unavailable','viewer_reference_genesis_no_existing','viewer_reference_genesis_immutable','viewer_reference_genesis_no_delete','viewer_reference_genesis_attempt_insert','viewer_reference_genesis_attempt_update','viewer_reference_genesis_attempt_replace_insert','viewer_reference_genesis_attempt_replace_update','viewer_reference_protocol_unavailable','viewer_reference_protocol_requires_genesis','viewer_reference_protocol_immutable','viewer_reference_protocol_no_delete','viewer_reference_protocol_no_replace']},
  {version:47,name:'viewer_gcp_raw_source_journal',objects:['viewer_gcp_raw_sources','viewer_gcp_raw_sources_dataset_idx','viewer_gcp_raw_sources_no_replace','viewer_gcp_raw_sources_immutable','viewer_gcp_raw_sources_no_delete']},
  {version:49,name:'viewer_source_binding_draft',objects:['viewer_source_bindings','viewer_source_bindings_dataset_idx','viewer_source_binding_objects','viewer_source_binding_unavailable','viewer_source_binding_no_replace','viewer_source_binding_no_update','viewer_source_binding_no_delete','viewer_source_binding_object_insert','viewer_source_binding_object_no_update','viewer_source_binding_object_no_delete','viewer_source_binding_dataset_guard_update','viewer_source_binding_dataset_guard_delete','viewer_source_binding_dataset_guard_insert','viewer_source_binding_file_guard_insert','viewer_source_binding_file_guard_update','viewer_source_binding_file_guard_delete','viewer_source_binding_attempt_guard_update','viewer_source_binding_attempt_guard_delete','viewer_source_binding_attempt_guard_insert','viewer_source_binding_task_guard_update','viewer_source_binding_task_guard_delete','viewer_source_binding_task_guard_insert']},

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
  // This draft intentionally does not allocate version 48. Do not silently
  // apply 49 to a database carrying another branch's 48 (or future schema).
  if(ledger) for(const row of database.prepare('SELECT version,name FROM schema_migrations WHERE version>=41').all()) {
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
      if(spec.version===45)expected.exec('CREATE TABLE dataset_operations(id TEXT PRIMARY KEY,operation_type TEXT,payload_json TEXT,processing_attempt_id TEXT,status TEXT,upload_id TEXT,import_preview_id TEXT)');
      if(spec.version===46)expected.exec('CREATE TABLE processing_attempts(id TEXT PRIMARY KEY,provider_id TEXT,provider_task_id TEXT); CREATE TABLE processing_attempt_gcp_snapshots(attempt_id TEXT PRIMARY KEY)');
      if(spec.version===49)expected.exec('CREATE TABLE datasets(id TEXT PRIMARY KEY,root_key TEXT,relative_path TEXT); CREATE TABLE dataset_files(id TEXT PRIMARY KEY,dataset_id TEXT,relative_path TEXT,byte_size INTEGER,sha256 TEXT); CREATE TABLE processing_attempts(id TEXT PRIMARY KEY,dataset_id TEXT,task_id TEXT,attempt_number INTEGER,provider_id TEXT,provider_task_id TEXT); CREATE TABLE processing_tasks(id TEXT PRIMARY KEY,project_id TEXT,dataset_id TEXT)');
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
