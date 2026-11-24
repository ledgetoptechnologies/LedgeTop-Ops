'use strict';
// Populated upgrade, rollback-copy and ledger-order rehearsals for schema 46 on
// databases that already carry folders (48) and the later main versions. Every
// row, name and CSV here is invented.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const test=require('node:test');
const {MIGRATIONS,applyMigrations,openDatabase}=require('../server/database');
const {GcpSourceOriginals,MAX_GCP_SOURCE_BYTES}=require('../server/gcpSourceOriginals');

const V46=MIGRATIONS.find(migration=>migration.version===46);
const LATEST=MIGRATIONS.at(-1).version;
const BOM=String.fromCharCode(0xfeff);
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const at='2026-01-02T03:04:05.000Z';
const header='point_id,label,latitude,longitude,elevation_m';
// Legacy rows as main stores them: CRLF, BOM plus non-ASCII, LF without a final
// newline, and one whose UTF-8 form exceeds the archive limit.
const SOURCES={
  crlf:`${header}\r\nA,A,10.5,20.5,30\r\n`,
  bom:`${BOM}${header}\nB,Bé–β,11.5,21.5,31\n`,
  bare:`${header}\nC,C,12.5,22.5,32`,
};

function fixtureRoot(t,label){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`viewer-gcp-rehearsal-${label}-`));
  const open=new Set();
  t.after(()=>{for(const database of open)if(database.isOpen)database.close();fs.rmSync(root,{recursive:true,force:true});});
  const track=database=>{open.add(database);return database;};
  return {root,track,file:path.join(root,'viewer.sqlite')};
}

// Apply exactly `list` with the unchanged migration SQL/hooks. The exported
// list is only swapped in for the duration of the call.
function applyExactly(database,list){
  const composed=[...MIGRATIONS];
  MIGRATIONS.splice(0,MIGRATIONS.length,...list);
  try{applyMigrations(database);}finally{MIGRATIONS.splice(0,MIGRATIONS.length,...composed);}
}
const without46=through=>MIGRATIONS.filter(value=>value.version!==46&&value.version<=through);

function openRaw(file){
  const database=new DatabaseSync(file);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  return database;
}

function populate(database,through){
  const run=(sql,...values)=>database.prepare(sql).run(...values);
  for(const id of ['project-a','project-b'])
    run("INSERT INTO projects(id,display_name,status,created_at,updated_at) VALUES (?,?,'active',?,?)",id,`Invented ${id}`,at,at);
  run("INSERT INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,manifest_sha256,created_at,updated_at,finalized_at) VALUES ('dataset-a','project-a','Invented flight','managed','datasets','invented-a','finalized',?,?,?,?)",'a'.repeat(64),at,at,at);
  run("INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,created_at) VALUES ('photo-a','dataset-a','photo.jpg',1,?,?)",'b'.repeat(64),at);
  run("INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,created_at) VALUES ('csv-a','dataset-a','control/points.csv',?,?,?)",
    Buffer.byteLength(SOURCES.crlf),sha256(Buffer.from(SOURCES.crlf)),at);
  run("INSERT INTO project_folders(id,project_id,parent_id,display_name,created_at,updated_at) VALUES ('folder-a','project-a',NULL,'Invented folder',?,?)",at,at);
  run("INSERT INTO project_folders(id,project_id,parent_id,display_name,created_at,updated_at) VALUES ('folder-a-child','project-a','folder-a','Invented child',?,?)",at,at);
  run("INSERT INTO project_folders(id,project_id,parent_id,display_name,created_at,updated_at) VALUES ('folder-b','project-b',NULL,'Invented folder',?,?)",at,at);
  for(const [id,folder] of [['task-root',null],['task-folder','folder-a-child']])
    run("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,metadata_json,folder_id,created_at,updated_at) VALUES (?,'project-a','dataset-a',?,'draft','{}',?,?,?)",id,`Invented ${id}`,folder,at,at);
  for(const [id,source] of Object.entries(SOURCES))
    run(`INSERT INTO gcp_sets(id,dataset_id,display_name,source_format,source_file_id,source_filename,source_sha256,source_content,source_byte_size,crs,elevation_units,created_by,created_at,updated_at)
      VALUES (?,'dataset-a','Invented control','generic-csv-v1',?,?,?,?,?,'EPSG:4326','m','staff-a',?,?)`,
      `set-${id}`,id==='crlf'?'csv-a':null,`${id}.csv`,sha256(Buffer.from(source)),source,Buffer.byteLength(source),at,at);
  run("INSERT INTO gcp_points(id,set_id,external_id,label,latitude,longitude,elevation_m,created_at,updated_at) VALUES ('point-a','set-crlf','A','A',10.5,20.5,30,?,?)",at,at);
  run("INSERT INTO gcp_image_correspondences(id,task_id,gcp_point_id,dataset_file_id,pixel_x,pixel_y,created_by,created_at,updated_at) VALUES ('mark-a','task-folder','point-a','photo-a',12.5,34.5,'staff-a',?,?)",at,at);
  run("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_by,created_at) VALUES ('trash-a','task','task-root','trash','invented-trash',5,?,'staff-a',?)",'2027-01-01T00:00:00.000Z',at);
  if(through>=86)run("UPDATE storage_trash SET purge_started_at=? WHERE id='trash-a'",at);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(),[]);
}

// Every row of every table, without columns that schema 46 itself introduces.
function rows(database){
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(({name})=>!['schema_migrations','viewer_gcp_source_originals'].includes(name))
    .map(({name})=>[name,database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row=>{
      const copy={...row};if(name==='gcp_sets')delete copy.source_original_id;return copy;})]));
}
const ledger=database=>database.prepare('SELECT version,name,applied_at FROM schema_migrations ORDER BY version').all().map(row=>({...row}));
const schema=database=>database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row=>({...row}));
const archive=database=>database.prepare('SELECT * FROM viewer_gcp_source_originals ORDER BY id').all().map(row=>({...row,content:Buffer.from(row.content).toString('base64')}));

function assertPreserved(database,before){
  const after=rows(database);
  for(const [name,expected] of Object.entries(before)){
    // A later version may append a column; every earlier column keeps its value.
    assert.deepEqual(after[name].map((row,index)=>Object.fromEntries(Object.keys(expected[index]||{}).map(key=>[key,row[key]]))),expected,name);
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
}

function assertFolders(database){
  const tasks=database.prepare('SELECT id,folder_id FROM processing_tasks ORDER BY id').all().map(row=>({...row}));
  assert.deepEqual(tasks,[{id:'task-folder',folder_id:'folder-a-child'},{id:'task-root',folder_id:null}]);
  assert.throws(()=>database.prepare("UPDATE processing_tasks SET folder_id='folder-b' WHERE id='task-root'").run(),/folder_project_mismatch/);
  assert.throws(()=>database.prepare("DELETE FROM project_folders WHERE id='folder-a-child'").run(),/FOREIGN KEY/);
  assert.throws(()=>database.prepare("DELETE FROM project_folders WHERE id='folder-a'").run(),/FOREIGN KEY/);
}

function assertArchived(database){
  const originals=new GcpSourceOriginals(database);
  for(const [id,source] of Object.entries(SOURCES)){
    const row=database.prepare('SELECT source_content,source_original_id FROM gcp_sets WHERE id=?').get(`set-${id}`);
    assert.equal(row.source_content,source,`${id} source text`);
    const saved=originals.get(row.source_original_id,'dataset-a');
    assert.deepEqual(saved.bytes,Buffer.from(source),`${id} retained bytes`);
    assert.equal(saved.sha256,sha256(Buffer.from(source)));
    assert.equal(saved.fidelity,'legacy_utf8_snapshot');
  }
}

for(const through of [83,85,86]){
  test(`populated schema ${through} receives 46 as a gap with rows, folders and CSV bytes intact, and repeats as a no-op`,t=>{
    const fixture=fixtureRoot(t,String(through));
    let database=fixture.track(openRaw(fixture.file));
    applyExactly(database,without46(through));
    assert.equal(database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,through);
    populate(database,through);
    const csv=path.join(fixture.root,'points.csv');fs.writeFileSync(csv,SOURCES.crlf);
    const before=rows(database),priorLedger=ledger(database),csvBefore=fs.readFileSync(csv);
    database.close();

    database=fixture.track(openDatabase(fixture.file));
    assertPreserved(database,before);assertFolders(database);assertArchived(database);
    assert.equal(V46.verify(database),true);
    assert.deepEqual(fs.readFileSync(csv),csvBefore);
    const upgraded=ledger(database);
    for(const entry of priorLedger)assert.deepEqual(upgraded.find(value=>value.version===entry.version),entry,'earlier stamps are never rewritten');
    assert.deepEqual(upgraded.map(value=>value.version),MIGRATIONS.map(value=>value.version));
    assert.equal(upgraded.at(-1).version,LATEST,'the gap does not move the reported schema');

    const settled={rows:rows(database),ledger:upgraded,schema:schema(database),archive:archive(database)};
    applyMigrations(database);applyMigrations(database);database.close();
    database=fixture.track(openDatabase(fixture.file));
    assert.deepEqual({rows:rows(database),ledger:ledger(database),schema:schema(database),archive:archive(database)},settled);
  });
}

test('46 as a gap and 46 in order produce the same schema',t=>{
  const gap=fixtureRoot(t,'gap'),ordered=fixtureRoot(t,'ordered');
  const a=gap.track(openRaw(gap.file));applyExactly(a,without46(LATEST));applyMigrations(a);
  const b=ordered.track(openDatabase(ordered.file));
  const shape=database=>schema(database).map(row=>row.type==='table'?{type:row.type,name:row.name,
    columns:database.prepare(`PRAGMA table_info("${row.name}")`).all().map(({cid,...column})=>JSON.stringify(column)).sort(),
    keys:database.prepare(`PRAGMA foreign_key_list("${row.name}")`).all().map(({id,seq,...key})=>JSON.stringify(key)).sort()}:row);
  assert.deepEqual(shape(a),shape(b));
});

test('a legacy source above the archive limit stays in its own row and does not stop the upgrade',t=>{
  const fixture=fixtureRoot(t,'large');
  let database=fixture.track(openRaw(fixture.file));
  applyExactly(database,without46(LATEST));populate(database,LATEST);
  // Main limits the recorded size, not the UTF-8 length of the stored text.
  const large=`${header}\n${'é'.repeat(MAX_GCP_SOURCE_BYTES/2)}`;
  assert.ok(Buffer.byteLength(large)>MAX_GCP_SOURCE_BYTES);
  database.prepare("UPDATE gcp_sets SET source_content=?,source_sha256=? WHERE id='set-bare'").run(large,sha256(Buffer.from(large)));
  const before=rows(database);database.close();
  database=fixture.track(openDatabase(fixture.file));
  assertPreserved(database,before);
  const row=database.prepare("SELECT source_content,source_original_id FROM gcp_sets WHERE id='set-bare'").get();
  assert.equal(row.source_original_id,null);assert.equal(row.source_content,large);
});

test('a failed 46 backfill leaves the prior database unchanged and a later run succeeds',t=>{
  const fixture=fixtureRoot(t,'rollback');
  const database=fixture.track(openRaw(fixture.file));
  applyExactly(database,without46(LATEST));populate(database,LATEST);
  const before={rows:rows(database),ledger:ledger(database),schema:schema(database)};
  const composed=[...MIGRATIONS],index=composed.indexOf(V46);
  const failing={...V46,after(value){V46.after(value);throw Object.assign(new Error('invented failure after backfill'),{code:'invented'});}};
  MIGRATIONS.splice(index,1,failing);
  try{assert.throws(()=>applyMigrations(database),{code:'invented'});}
  finally{MIGRATIONS.splice(0,MIGRATIONS.length,...composed);}
  assert.deepEqual({rows:rows(database),ledger:ledger(database),schema:schema(database)},before);
  applyMigrations(database);
  assertPreserved(database,before.rows);assertArchived(database);
});

test('a database at the latest schema with 46 already applied keeps its originals through later and gap versions',t=>{
  // 47 is reserved for point roles and is not part of this candidate. These
  // neutral stand-ins only prove the runner: a lower gap and a higher version
  // can both follow 46 without changing it.
  const role={version:47,name:'standin_gap_47',sql:'CREATE TABLE standin_gap_47(point_id TEXT PRIMARY KEY REFERENCES gcp_points(id) ON DELETE CASCADE);',
    verify:value=>Boolean(value.prepare("SELECT 1 FROM sqlite_master WHERE name='standin_gap_47'").get())};
  const next={version:LATEST+1,name:'standin_next',sql:'CREATE TABLE standin_next(id TEXT PRIMARY KEY);'};
  const fixture=fixtureRoot(t,'first');
  let database=fixture.track(openRaw(fixture.file));
  applyExactly(database,without46(LATEST));populate(database,LATEST);database.close();
  database=fixture.track(openDatabase(fixture.file));
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(SOURCES.crlf)]);
  const uploaded=new GcpSourceOriginals(database).retain({datasetId:'dataset-a',projectId:'project-a',fileName:'uploaded.csv',bytes});
  const before={rows:rows(database),archive:archive(database)},stamp=ledger(database).find(value=>value.version===46);
  for(const list of [[...MIGRATIONS,next],[...MIGRATIONS,role,next].sort((a,b)=>a.version-b.version)])
    for(let repeat=0;repeat<2;repeat+=1)applyExactly(database,list);
  assert.deepEqual(archive(database),before.archive);
  for(const [name,expected] of Object.entries(before.rows))assert.deepEqual(rows(database)[name],expected,name);
  assert.deepEqual(ledger(database).find(value=>value.version===46),stamp);
  assert.deepEqual(new GcpSourceOriginals(database).get(uploaded.id).bytes,bytes);
  assert.equal(V46.verify(database),true);
  assertFolders(database);
  assert.equal(ledger(database).at(-1).version,LATEST+1);

  // The other order: the higher version is already installed, then 46 arrives.
  const later=fixtureRoot(t,'later');
  const ahead=later.track(openRaw(later.file));
  applyExactly(ahead,[...without46(LATEST),next]);populate(ahead,LATEST);
  const aheadRows=rows(ahead);
  applyExactly(ahead,[...MIGRATIONS,next]);
  assertPreserved(ahead,aheadRows);assertFolders(ahead);assertArchived(ahead);
  assert.equal(ledger(ahead).at(-1).version,LATEST+1);
});

test('a separate pre-upgrade backup restores the prior schema and CSV text, and upgrades again identically',async t=>{
  const fixture=fixtureRoot(t,'restore');
  let database=fixture.track(openRaw(fixture.file));
  applyExactly(database,without46(LATEST));populate(database,LATEST);
  const before={rows:rows(database),ledger:ledger(database),schema:schema(database)};
  const saved=path.join(fixture.root,'pre-upgrade.sqlite');
  await backup(database,saved);
  const savedDigest=sha256(fs.readFileSync(saved));
  database.close();

  database=fixture.track(openDatabase(fixture.file));
  assertArchived(database);
  new GcpSourceOriginals(database).retain({datasetId:'dataset-a',projectId:'project-a',fileName:'after.csv',bytes:Buffer.from(SOURCES.bare)});
  const upgradedDigests=archive(database).filter(row=>row.fidelity==='legacy_utf8_snapshot').map(row=>row.sha256).sort();
  database.close();
  assert.equal(sha256(fs.readFileSync(saved)),savedDigest,'upgrading the live file never touches the backup');

  // Restore into a new file: prior schema, ledger, rows and source text.
  const restoredFile=path.join(fixture.root,'restored.sqlite');fs.copyFileSync(saved,restoredFile);
  let restored=fixture.track(openRaw(restoredFile));
  assert.deepEqual({rows:rows(restored),ledger:ledger(restored),schema:schema(restored)},before);
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='viewer_gcp_source_originals'").get().n,0);
  applyExactly(restored,without46(LATEST));
  assert.deepEqual({rows:rows(restored),ledger:ledger(restored),schema:schema(restored)},before,'the prior release reopens the restored file unchanged');
  restored.close();

  // And the restored copy can take the upgrade again.
  restored=fixture.track(openDatabase(restoredFile));
  assertPreserved(restored,before.rows);assertFolders(restored);assertArchived(restored);
  assert.deepEqual(archive(restored).map(row=>row.sha256).sort(),upgradedDigests);
});
