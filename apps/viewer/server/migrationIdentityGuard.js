'use strict';

const {DatabaseSync}=require('node:sqlite');

// Only the newly allocated migration identities are checked here. Earlier
// ledger history retains its established compatibility behavior.
const protectedMigrations=[
  {version:41,name:'gcp_odm_crs_confirmations',objects:['gcp_odm_crs_confirmations']},
  {version:42,name:'viewer_workspace_hierarchy',objects:['viewer_organizations','viewer_project_groups','viewer_project_hierarchy','viewer_project_groups_org_idx','viewer_project_hierarchy_org_idx']},
];
// Strict comparison intentionally rejects harmless formatting differences as
// well; normalizing whitespace could alter quoted SQL literals.
const normalize=sql=>String(sql||'').trim().replace(/;\s*$/,'');
function incompatible(reason){return Object.assign(new Error(`Protected migration identity or schema is incompatible: ${reason}`),{code:'migration_identity_conflict'});}

function assertProtectedMigrationIdentity(database,migrations) {
  const ledger=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  for(const spec of protectedMigrations) {
    const entry=ledger?database.prepare('SELECT name FROM schema_migrations WHERE version=?').get(spec.version):null;
    const found=spec.objects.map(name=>database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(name));
    if(!entry){if(found.some(Boolean))throw incompatible(`unrecorded objects for ${spec.version}`);continue;}
    if(entry.name!==spec.name)throw incompatible(`version ${spec.version} has a different name`);
    const expectedMigration=migrations.find(item=>item.version===spec.version&&item.name===spec.name);
    if(!expectedMigration)throw incompatible(`version ${spec.version} is not supported by this build`);
    const expected=new DatabaseSync(':memory:');
    try {
      expected.exec(expectedMigration.sql);
      for(let i=0;i<spec.objects.length;i++) {
        const object=spec.objects[i],actual=found[i],reference=expected.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(object);
        if(!reference||!actual||reference.type!==actual.type||normalize(reference.sql)!==normalize(actual.sql))throw incompatible(`schema mismatch for ${object}`);
      }
    } finally {expected.close();}
  }
}

module.exports={assertProtectedMigrationIdentity};
