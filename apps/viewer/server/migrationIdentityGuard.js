'use strict';

const {DatabaseSync}=require('node:sqlite');

// Only the newly allocated migration identities are checked here. Earlier
// ledger history retains its established compatibility behavior.
const protectedMigrations=[
  {version:41,name:'gcp_odm_crs_confirmations',objects:['gcp_odm_crs_confirmations']},
  {version:42,name:'viewer_workspace_hierarchy',objects:['viewer_organizations','viewer_project_groups','viewer_project_hierarchy','viewer_project_groups_org_idx','viewer_project_hierarchy_org_idx']},
  {version:44,name:'viewer_source_custody_dormant',objects:['viewer_custody_intents','viewer_custody_pins','viewer_custody_intents_immutable','viewer_custody_intents_no_replace','viewer_custody_pins_no_late_insert','viewer_custody_intents_no_delete','viewer_custody_pins_immutable','viewer_custody_pins_no_delete']},
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
  // Capacity migration 43 is under separate review; refuse every existing 43 until integrated.
  if(ledger&&database.prepare('SELECT 1 FROM schema_migrations WHERE version=43').get())throw incompatible('version 43 not yet integrated');
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
