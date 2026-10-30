'use strict';

const {DatabaseSync}=require('node:sqlite');

// Only the newly allocated migration identities are checked here. Earlier
// ledger history retains its established compatibility behavior.
const protectedMigrations=[
  {version:41,name:'gcp_odm_crs_confirmations',objects:['gcp_odm_crs_confirmations']},
  {version:42,name:'viewer_workspace_hierarchy',objects:['viewer_organizations','viewer_project_groups','viewer_project_hierarchy','viewer_project_groups_org_idx','viewer_project_hierarchy_org_idx']},
  {version:45,name:'processing_archive_capture_intents',objects:['processing_archive_capture_intents']},
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
  for(const spec of protectedMigrations) {
    const entry=ledger?database.prepare('SELECT name FROM schema_migrations WHERE version=?').get(spec.version):null;
    const found=spec.objects.map(name=>database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=? COLLATE NOCASE").all(name));
    if(!entry){if(found.some(rows=>rows.length))throw incompatible(`unrecorded objects for ${spec.version}`);continue;}
    if(entry.name!==spec.name)throw incompatible(`version ${spec.version} has a different name`);
    const expectedMigration=migrations.find(item=>item.version===spec.version&&item.name===spec.name);
    if(!expectedMigration)throw incompatible(`version ${spec.version} is not supported by this build`);
    const expected=new DatabaseSync(':memory:');
    try {
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
