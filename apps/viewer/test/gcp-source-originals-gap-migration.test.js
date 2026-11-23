'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const test=require('node:test');
const {MIGRATIONS,applyMigrations,openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {GcpSourceOriginals,gcpSourceOriginalsV46Present}=require('../server/gcpSourceOriginals');

const V46=MIGRATIONS.find(migration=>migration.version===46);
const conflict={code:'viewer_migration_history_conflict'};

// Build the schema a deployed main Viewer has (every version up to `through`
// except 46) from the unchanged migration SQL/hooks and its real ledger. The
// exported migration list is never mutated.
const LATEST=MIGRATIONS.at(-1).version;
function databaseWithoutV46(t,through=LATEST){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-v46-gap-'));
  const file=path.join(root,'viewer.sqlite');
  const state={database:new DatabaseSync(file),file};
  t.after(()=>{state.database?.close();fs.rmSync(root,{recursive:true,force:true});});
  state.database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  state.database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const migration of MIGRATIONS.filter(value=>value.version!==46&&value.version<=through)){
    state.database.exec('BEGIN IMMEDIATE');
    try{
      state.database.exec(migration.sql);migration.after?.(state.database);
      state.database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
        .run(migration.version,migration.name,new Date().toISOString());
      state.database.exec('COMMIT');
    }catch(error){state.database.exec('ROLLBACK');throw error;}
  }
  return state;
}

function populate(database){
  const processing=new ProcessingRepository(database);
  const project=processing.createProject({displayName:'Synthetic gap-upgrade project'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',
    rootKey:'datasets',relativePath:crypto.randomUUID()});
  processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Existing task'});
  const source='point_id,label,latitude,longitude,elevation_m\r\nA,A,44.5,-88.1,250\r\n';
  const sha=crypto.createHash('sha256').update(source).digest('hex'),now=new Date().toISOString();
  database.prepare(`INSERT INTO gcp_sets(id,dataset_id,display_name,source_format,source_filename,source_sha256,
    source_content,source_byte_size,crs,elevation_units,created_at,updated_at)
    VALUES ('legacy',?,'Control','generic-csv-v1','control.csv',?,?,?,'EPSG:4326','m',?,?)`)
    .run(dataset.id,sha,source,Buffer.byteLength(source),now,now);
  return {project,dataset,task,source};
}

for(const through of [83,85,86])test(`a populated schema ${through} database receives 46 as a verified gap and reopens unchanged`,t=>{
  const state=databaseWithoutV46(t,through);
  assert.equal(state.database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,through);
  assert.equal(state.database.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=46').get().n,0);
  const fixture=populate(state.database);
  state.database.close();state.database=null;

  state.database=openDatabase(state.file);
  const db=state.database;
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=46').get().name,V46.name);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,LATEST);
  assert.equal(gcpSourceOriginalsV46Present(db),true);
  assert.equal(V46.verify(db),true);
  const linked=db.prepare("SELECT source_original_id FROM gcp_sets WHERE id='legacy'").get().source_original_id;
  const original=new GcpSourceOriginals(db).get(linked);
  assert.equal(original.fidelity,'legacy_utf8_snapshot');
  assert.equal(original.originProjectId,fixture.project.id);
  assert.deepEqual(original.bytes,Buffer.from(fixture.source));
  assert.equal(new ProcessingRepository(db).getTask(fixture.task.id).folderId,null);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');

  // Running the ledger again, or reopening the migrated file, is a no-op.
  applyMigrations(db);
  state.database.close();state.database=null;
  state.database=openDatabase(state.file);
  assert.equal(state.database.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=46').get().n,1);
  assert.equal(state.database.prepare('SELECT COUNT(*) AS n FROM viewer_gcp_source_originals').get().n,1);
  assert.equal(state.database.prepare("SELECT source_original_id FROM gcp_sets WHERE id='legacy'").get().source_original_id,linked);
});

test('a fresh database records 46 between 42 and 48 and verifies it',t=>{
  const db=openDatabase(':memory:');
  t.after(()=>db.close());
  const versions=db.prepare('SELECT version FROM schema_migrations WHERE version>=41 ORDER BY version').all().map(row=>row.version);
  assert.deepEqual(versions,MIGRATIONS.filter(value=>value.version>=41).map(value=>value.version));
  assert.deepEqual(versions.slice(versions.indexOf(42),versions.indexOf(48)+1),[42,46,48]);
  assert.equal(V46.verify(db),true);
  applyMigrations(db);
});

test('a schema 46 stamp recorded under another name is refused without creating the archive',t=>{
  const state=databaseWithoutV46(t),db=state.database;
  db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (46,?,?)')
    .run('durable_viewer_source_snapshot_holds','2026-11-20T00:00:00Z');
  assert.throws(()=>applyMigrations(db),conflict);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='viewer_gcp_source_originals'").get().n,0);
});

test('a schema 46 stamp without its objects is refused',t=>{
  const state=databaseWithoutV46(t),db=state.database;
  db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (46,?,?)').run(V46.name,'2026-11-20T00:00:00Z');
  assert.equal(V46.verify(db),false);
  assert.throws(()=>applyMigrations(db),conflict);
});

for(const [label,mutate] of [
  ['no dataset index',db=>db.exec('DROP INDEX viewer_gcp_original_dataset')],
  ['no update guard',db=>db.exec('DROP TRIGGER viewer_gcp_original_no_update')],
  ['no delete guard',db=>db.exec('DROP TRIGGER viewer_gcp_original_no_delete')],
  ['no replacement guard',db=>db.exec('DROP TRIGGER viewer_gcp_original_no_replace')],
  ['no archive table',db=>{db.exec('PRAGMA foreign_keys=OFF');db.exec('DROP TABLE viewer_gcp_source_originals');}],
  ['an altered guard',db=>{db.exec('DROP TRIGGER viewer_gcp_original_no_delete');
    db.exec("CREATE TRIGGER viewer_gcp_original_no_delete BEFORE DELETE ON viewer_gcp_source_originals WHEN 0 BEGIN SELECT RAISE(ABORT,'x'); END");}],
  ['an unreviewed extra trigger',db=>db.exec("CREATE TRIGGER viewer_gcp_original_extra AFTER INSERT ON viewer_gcp_source_originals BEGIN SELECT 1; END")],
]){
  test(`a schema 46 stamp with ${label} is refused`,t=>{
    const db=openDatabase(':memory:');
    t.after(()=>db.close());
    assert.equal(V46.verify(db),true);
    mutate(db);
    assert.equal(V46.verify(db),false);
    assert.throws(()=>applyMigrations(db),conflict);
  });
}
