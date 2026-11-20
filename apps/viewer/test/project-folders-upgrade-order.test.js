'use strict';
// Shipping-order proof for migration 48 (folders). Recreate the standalone
// folder release and inject stand-ins for 46 and 47 only in these fixtures.
// The composed release's real migrations are covered by the GCP upgrade tests.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {MIGRATIONS,applyMigrations}=require('../server/database');
const {readSchemaVersion}=require('../server/runtimeIdentity');

const STAND_INS=[
  {version:46,name:'standin_gcp_originals',sql:`
    ALTER TABLE processing_tasks ADD COLUMN standin_original_ref TEXT;
    CREATE TABLE standin_gcp_originals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,label TEXT NOT NULL);`,
    after(db){db.exec("UPDATE processing_tasks SET standin_original_ref='original:'||id");}},
  {version:47,name:'standin_point_roles',sql:`
    CREATE TABLE standin_point_roles(task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,role TEXT NOT NULL,PRIMARY KEY(task_id,role));`,
    after(db){db.exec("INSERT INTO standin_point_roles(task_id,role) SELECT id,'control' FROM processing_tasks");}},
];
const composed=[...MIGRATIONS];
const real=composed.filter(item=>item.version<=42||item.version===48);
function useMigrations(t,list){MIGRATIONS.splice(0,MIGRATIONS.length,...list);t.after(()=>MIGRATIONS.splice(0,MIGRATIONS.length,...composed));}
const sorted=list=>[...list].sort((a,b)=>a.version-b.version);
function populatedAt42(t,label){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`viewer-folders-order-${label}-`));
  const db=new DatabaseSync(path.join(root,'db.sqlite'));db.exec('PRAGMA journal_mode=WAL');
  t.after(()=>{if(db.isOpen)db.close();fs.rmSync(root,{recursive:true,force:true});});
  db.exec('PRAGMA foreign_keys=ON');
  useMigrations(t,real.filter(item=>item.version<=42));applyMigrations(db);
  const t0='2026-01-01T00:00:00.000Z';
  db.prepare("INSERT INTO projects(id,display_name,status,created_at,updated_at) VALUES ('project-a','Synthetic project','active',?,?)").run(t0,t0);
  db.prepare("INSERT INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,manifest_sha256,created_at,updated_at,finalized_at) VALUES ('dataset-a','project-a','Synthetic source','managed','datasets','synthetic-a','finalized',?,?,?,?)").run('a'.repeat(64),t0,t0,t0);
  for(const id of ['task-1','task-2'])db.prepare("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,metadata_json,created_at,updated_at) VALUES (?,'project-a','dataset-a',?,'draft','{}',?,?)").run(id,`Synthetic ${id}`,t0,t0);
  return db;
}
function addFolderData(db){
  const t0='2026-01-02T00:00:00.000Z';
  db.prepare("INSERT INTO project_folders(id,project_id,parent_id,display_name,created_at,updated_at) VALUES ('folder-a','project-a',NULL,'Synthetic folder',?,?)").run(t0,t0);
  db.prepare("UPDATE processing_tasks SET folder_id='folder-a' WHERE id='task-1'").run();
}
// Column order can differ (ALTER TABLE appends), so compare column sets.
function snapshot(db){
  const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables=objects.filter(row=>row.type==='table').map(row=>({name:row.name,
    columns:db.prepare(`PRAGMA table_info(${JSON.stringify(row.name)})`).all().map(c=>`${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`).sort(),
    keys:db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(row.name)})`).all().map(k=>`${k.from}->${k.table}.${k.to}:${k.on_delete}`).sort()}));
  const others=objects.filter(row=>row.type!=='table').map(row=>`${row.type}:${row.name}:${row.tbl_name}:${row.sql}`);
  const data={
    tasks:db.prepare('SELECT id,project_id,dataset_id,status,published_model_id,folder_id,standin_original_ref FROM processing_tasks ORDER BY id').all().map(row=>({...row})),
    folders:db.prepare('SELECT id,project_id,parent_id,display_name FROM project_folders ORDER BY id').all().map(row=>({...row})),
    roles:db.prepare('SELECT task_id,role FROM standin_point_roles ORDER BY task_id').all().map(row=>({...row})),
    versions:db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row=>row.version),
  };
  return{tables,others,data};
}

test('populated 42 -> 48 -> (46, 47 later) and 42 -> 46 -> 47 -> 48 converge to the same schema and data',t=>{
  // Order A: folders ship first.
  const a=populatedAt42(t,'folders-first');
  useMigrations(t,real);applyMigrations(a);
  assert.equal(readSchemaVersion(a),48,'reported schema is the maximum stamped version');
  assert.deepEqual(a.prepare('SELECT version FROM schema_migrations WHERE version>42').all().map(row=>row.version),[48]);
  addFolderData(a);
  useMigrations(t,sorted([...real,...STAND_INS]));applyMigrations(a);
  assert.equal(readSchemaVersion(a),48,'46 and 47 arriving later do not change the reported number');
  // Order B: 46, then 47, then folders.
  const b=populatedAt42(t,'folders-last');
  useMigrations(t,sorted([...real.filter(item=>item.version<=42),STAND_INS[0]]));applyMigrations(b);
  useMigrations(t,sorted([...real.filter(item=>item.version<=42),...STAND_INS]));applyMigrations(b);
  assert.equal(readSchemaVersion(b),47);
  useMigrations(t,sorted([...real,...STAND_INS]));applyMigrations(b);addFolderData(b);
  assert.equal(readSchemaVersion(b),48);
  const left=snapshot(a),right=snapshot(b);
  assert.deepEqual(left.tables,right.tables);assert.deepEqual(left.others,right.others);assert.deepEqual(left.data,right.data);
  assert.deepEqual(left.data.versions.filter(v=>v>42),[46,47,48]);
  assert.equal(left.data.roles.length,2,'a later data migration sees tasks that already sit in folders');
  assert.equal(left.data.tasks.find(row=>row.id==='task-1').folder_id,'folder-a');
  for(const db of [a,b]){assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    // Re-running the full list is a no-op for both orders.
    const before=snapshot(db);applyMigrations(db);assert.deepEqual(snapshot(db),before);}
});

test('a database already at 42 upgrades to 48 alone with only the folder migration applied',t=>{
  const db=populatedAt42(t,'only-48');
  useMigrations(t,real);applyMigrations(db);
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations WHERE version>=40 ORDER BY version').all().map(row=>row.version),[40,41,42,48]);
  assert.deepEqual(db.prepare('SELECT id,folder_id FROM processing_tasks ORDER BY id').all().map(row=>({...row})),[{id:'task-1',folder_id:null},{id:'task-2',folder_id:null}]);
});

test('a version 48 stamp recorded under a different migration name, or without its objects, is refused',t=>{
  for(const [label,prepare] of [
    ['other-name',db=>db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES (48,'private_branch_other_feature','2026-01-01')").run()],
    ['same-name-missing-objects',db=>db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES (48,'project_organizational_folders','2026-01-01')").run()],
  ]){
    const db=populatedAt42(t,label);prepare(db);
    useMigrations(t,real);
    assert.throws(()=>applyMigrations(db),{code:'viewer_migration_history_conflict'},label);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_folders'").get(),undefined,'nothing was created');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=48').get().n,1,'history was not rewritten');
  }
});

test('stamps for versions 1-42 keep the historical skip-by-number behaviour',t=>{
  const db=populatedAt42(t,'legacy-names');
  db.prepare("UPDATE schema_migrations SET name='historical_name' WHERE version=40").run();
  useMigrations(t,real);applyMigrations(db);
  assert.equal(readSchemaVersion(db),48);
});

test('a crash inside migration 48 leaves the populated database at its previous state and the next start completes it, in either order',t=>{
  const {spawnSync}=require('node:child_process');
  for(const order of ['folders-first','folders-last']){
    const db=populatedAt42(t,`crash-${order}`),dbPath=db.location();
    if(order==='folders-last'){useMigrations(t,sorted([...real.filter(item=>item.version<=42),...STAND_INS]));applyMigrations(db);}
    db.close();
    // Hard exit after 48's DDL ran but before COMMIT: no rollback handler runs.
    const script=`
      const {DatabaseSync}=require('node:sqlite'),{MIGRATIONS,applyMigrations}=require(${JSON.stringify(require.resolve('../server/database'))});
      const db=new DatabaseSync(${JSON.stringify(dbPath)});db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
      const index=MIGRATIONS.findIndex(item=>item.version===48),real48=MIGRATIONS[index];
      MIGRATIONS.splice(0,MIGRATIONS.length,{...real48,after(database){real48.after(database);process.exit(7);}});
      applyMigrations(db);`;
    const child=spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
    assert.equal(child.status,7,child.stderr);
    const reopened=new DatabaseSync(dbPath);t.after(()=>{if(reopened.isOpen)reopened.close();});
    reopened.exec('PRAGMA foreign_keys=ON');
    assert.equal(reopened.prepare("SELECT 1 FROM sqlite_master WHERE name='project_folders'").get(),undefined,`${order}: interrupted DDL was rolled back`);
    assert.equal(reopened.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=48').get().n,0);
    assert.equal(reopened.prepare('SELECT COUNT(*) n FROM processing_tasks').get().n,2,'existing tasks survive');
    useMigrations(t,sorted([...real,...STAND_INS]));applyMigrations(reopened);
    assert.equal(readSchemaVersion(reopened),48);
    assert.deepEqual(reopened.prepare('SELECT version FROM schema_migrations WHERE version>42 ORDER BY version').all().map(row=>row.version),[46,47,48]);
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.ok(reopened.prepare('PRAGMA foreign_key_list(processing_tasks)').all().some(key=>key.from==='folder_id'&&key.table==='project_folders'));
    reopened.close();
  }
});
