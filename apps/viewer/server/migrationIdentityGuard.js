'use strict';

const {DatabaseSync}=require('node:sqlite');

// Only the newly allocated migration identities are checked here. Earlier
// ledger history retains its established compatibility behavior.
const protectedMigrations=[
  {version:41,name:'gcp_odm_crs_confirmations',objects:['gcp_odm_crs_confirmations']},
  {version:42,name:'viewer_workspace_hierarchy',objects:['viewer_organizations','viewer_project_groups','viewer_project_hierarchy','viewer_project_groups_org_idx','viewer_project_hierarchy_org_idx']},
  // Reserved by independent owners; this branch cannot safely interpret them.
  {version:43,name:'viewer_cooperative_capacity_ledger',objects:['viewer_capacity_control','viewer_capacity_reservations','viewer_capacity_reservations_domain_idx','viewer_capacity_materialized_monotonic','viewer_capacity_no_replacement','viewer_capacity_identity_immutable','viewer_capacity_no_delete','viewer_capacity_state_transition']},
  {version:44,name:'viewer_source_custody_dormant',objects:['viewer_custody_intents','viewer_custody_pins','viewer_custody_intents_immutable','viewer_custody_intents_no_replace','viewer_custody_pins_no_late_insert','viewer_custody_intents_no_delete','viewer_custody_pins_immutable','viewer_custody_pins_no_delete']},
  {version:45,name:'viewer_reference_attempt_journal',objects:['viewer_reference_attempt_journal','viewer_reference_attempt_identity_immutable','viewer_reference_attempt_no_insert_replace','viewer_reference_attempt_no_update_replace','viewer_reference_attempt_no_delete','viewer_reference_attempt_admission_unavailable','viewer_reference_projection_admission','viewer_reference_catalog_exclusion_insert','viewer_reference_catalog_exclusion_update','viewer_reference_catalog_exclusion_delete','viewer_reference_catalog_replace_insert','viewer_reference_catalog_replace_update','viewer_reference_catalog_operation_idx','reference_catalog_projection','reference_catalog_payload_attempt_idx','reference_catalog_column_attempt_idx','reference_catalog_unresolved_idx','reference_catalog_invalid_operation_id_idx','reference_catalog_projection_state','reference_catalog_invalid_id_insert','reference_catalog_invalid_id_update','reference_catalog_projection_insert','reference_catalog_projection_update','reference_catalog_projection_delete']},

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
