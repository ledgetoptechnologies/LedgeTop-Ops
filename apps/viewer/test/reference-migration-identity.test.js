'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {MIGRATIONS,applyMigrations,openDatabase}=require('../server/database');
const {ReferenceCatalogProjection}=require('../server/referenceCatalogProjection');

test('application database startup registers the catalog parser and leaves readiness disabled',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reference-startup-')),file=path.join(dir,'viewer.sqlite');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let db=openDatabase(file);
 db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES(?,'catalog_map','test',?,'queued','t','t','t')").run('one','{"ids":{"attemptId":"a"}}');assert.equal(db.prepare("SELECT payload_attempt_id FROM reference_catalog_projection WHERE operation_id='one'").get().payload_attempt_id,'a');db.close();
 db=openDatabase(file);try{const p=new ReferenceCatalogProjection(db);p.begin();p.backfill();assert.equal(p.state().authority_ready,0);db.prepare("UPDATE dataset_operations SET payload_json=? WHERE id='one'").run('{"ids":{"attemptId":"b"}}');assert.equal(db.prepare("SELECT payload_attempt_id FROM reference_catalog_projection WHERE operation_id='one'").get().payload_attempt_id,'b');}finally{db.close();}
});
test('coverage scan uses the operation type index and does not run in journal admission',t=>{const db=new DatabaseSync(':memory:');t.after(()=>db.close());applyMigrations(db);const plan=db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM dataset_operations o LEFT JOIN reference_catalog_projection p ON p.operation_id=o.id WHERE o.operation_type='catalog_map' AND p.operation_id IS NULL").all().map(x=>x.detail).join(' ');assert.match(plan,/viewer_reference_catalog_operation_idx/);const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='viewer_reference_projection_admission'").get().sql;assert.doesNotMatch(sql,/JOIN\s+dataset_operations/i);assert.doesNotMatch(sql,/FROM\s+dataset_operations/i);});

test('populated version 15, 41, 42, 44, 48, 49 and 53 databases upgrade without losing their task and attempt',t=>{
 for(const version of [15,41,42,44,48,49,53]){
  const db=new DatabaseSync(':memory:');try{
   db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
   for(const m of MIGRATIONS.filter(m=>m.version<=version)){db.exec(m.sql);m.after?.(db);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version,m.name,'t');}
   db.exec("INSERT INTO projects(id,display_name,status,created_at,updated_at) VALUES('p','Project','active','t','t'); INSERT INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,created_at,updated_at) VALUES('d','p','Data','managed','datasets','d','finalized','t','t'); INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('t','p','d','Task','draft','t','t'); INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES('a','t','d',1,'{}','failed','t','t')");
   if(version>=48)db.exec("INSERT INTO viewer_capacity_reservations(id,domain_id,domain_revision,writer_kind,writer_id,writer_namespace,owner_id,fence_token,owner_generation,peak_bytes,remaining_bytes,peak_inodes,remaining_inodes,state,created_at,updated_at) VALUES('r','d','rev','test','w','ns','o','f',1,100,100,1,1,'held','t','t')");
   if(version>=49)db.exec("INSERT INTO viewer_custody_intents VALUES('i','j',1,'staging','h','{}','building','t'); INSERT INTO viewer_custody_pins VALUES('i','csv',1,'h','source',1)");
   const before=db.prepare('SELECT id,task_id,dataset_id,attempt_number,status FROM processing_attempts').get();assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
   applyMigrations(db);if(version>=48)assert.equal(db.prepare("SELECT remaining_bytes FROM viewer_capacity_reservations WHERE id='r'").get().remaining_bytes,100);if(version>=49)assert.equal(db.prepare("SELECT permanent_csv FROM viewer_custody_pins WHERE intent_id='i'").get().permanent_csv,1);assert.deepEqual(db.prepare('SELECT id,task_id,dataset_id,attempt_number,status FROM processing_attempts').get(),before);assert.equal(db.prepare("SELECT display_name FROM processing_tasks WHERE id='t'").get().display_name,'Task');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=50').get().name,'viewer_reference_attempt_journal');
  }finally{db.close();}
 }
});

test('fresh migrations install the dormant 50 journal and protect its identity',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());applyMigrations(db);
 assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=50').get().name,'viewer_reference_attempt_journal');
 assert.equal(db.prepare('SELECT authority_ready FROM reference_catalog_projection_state WHERE id=1').get().authority_ready,0);
 db.exec('UPDATE reference_catalog_projection_state SET scan_complete=1 WHERE id=1');
 assert.throws(()=>db.exec("INSERT INTO viewer_reference_attempt_journal(attempt_id,submission_id,environment,request_json,request_sha256,input_manifest_sha256) VALUES('a','s','staging','{}','h','m')"),/reference admission unavailable/);
 applyMigrations(db);
 db.exec('DROP TRIGGER viewer_reference_attempt_no_delete');
 assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});
});

test('recorded 50 with altered or unexpected objects fails before WAL or disk mutation',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reference-schema-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cases=[['missing','DROP TRIGGER viewer_reference_attempt_no_delete'],['altered',"DROP TRIGGER viewer_reference_attempt_no_delete; CREATE TRIGGER viewer_reference_attempt_no_delete BEFORE DELETE ON viewer_reference_attempt_journal BEGIN SELECT 1; END"],['case','DROP TRIGGER viewer_reference_attempt_no_delete; CREATE TRIGGER VIEWER_REFERENCE_ATTEMPT_NO_DELETE BEFORE DELETE ON viewer_reference_attempt_journal BEGIN SELECT 1; END'],['extra-trigger',"CREATE TRIGGER unexpected_reference BEFORE DELETE ON viewer_reference_attempt_journal BEGIN SELECT 1; END"],['extra-index','CREATE INDEX unexpected_reference_index ON viewer_reference_attempt_journal(environment)']];
 for(const [name,sql] of cases){const file=path.join(dir,`${name}.sqlite`),db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=DELETE');applyMigrations(db);db.exec(sql);db.close();
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=hash();assert.throws(()=>openDatabase(file),{code:'migration_identity_conflict'},name);assert.equal(hash(),before,name);assert.equal(fs.existsSync(`${file}-wal`),false,name);
  const check=new DatabaseSync(file,{readOnly:true});try{assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'delete',name);}finally{check.close();}
 }
});

test('initialization snapshot migration rejects tampering before WAL or disk mutation',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'init-snapshot-schema-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const [name,sql] of [['missing','DROP TRIGGER processing_initialization_snapshot_no_delete'],['extra','CREATE INDEX unexpected_init_snapshot ON processing_initialization_snapshots(created_at)'],['foreign',"UPDATE schema_migrations SET name='foreign' WHERE version=54"]]){
  const file=path.join(dir,`${name}.sqlite`),db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=DELETE');applyMigrations(db);db.exec(sql);db.close();
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=hash();assert.throws(()=>openDatabase(file),{code:'migration_identity_conflict'},name);assert.equal(hash(),before,name);assert.equal(fs.existsSync(`${file}-wal`),false,name);
 }
});

test('foreign reserved ledgers and case-variant objects fail before WAL or disk mutation',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reference-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cases=[['v43-ledger',"INSERT INTO schema_migrations VALUES(43,'viewer_cooperative_capacity_ledger','t')"],['v44-ledger',"INSERT INTO schema_migrations VALUES(44,'viewer_source_custody_dormant','t')"],['v45-ledger',"INSERT INTO schema_migrations VALUES(45,'foreign','t')"],['v45-object','CREATE TABLE VIEWER_REFERENCE_ATTEMPT_JOURNAL(id TEXT)']];
 for(const [name,sql] of cases){
  const file=path.join(dir,`${name}.sqlite`),db=new DatabaseSync(file);db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");db.exec(sql);db.close();
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=hash();
  assert.throws(()=>openDatabase(file),{code:'migration_identity_conflict'},name);assert.equal(hash(),before,name);assert.equal(fs.existsSync(`${file}-wal`),false,name);
  const check=new DatabaseSync(file,{readOnly:true});try{assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'delete',name);}finally{check.close();}
 }
});

test('replacement attempts cannot erase another journal row even without recursive triggers',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA recursive_triggers=OFF');
 db.exec("CREATE TABLE processing_attempts(id TEXT PRIMARY KEY); INSERT INTO processing_attempts VALUES('a'),('b'),('c'); CREATE TABLE dataset_operations(id TEXT PRIMARY KEY,operation_type TEXT,payload_json TEXT,processing_attempt_id TEXT,status TEXT,upload_id TEXT,import_preview_id TEXT)");db.exec(MIGRATIONS.find(m=>m.version===50).sql);db.exec('DROP TRIGGER viewer_reference_attempt_admission_unavailable; UPDATE reference_catalog_projection_state SET scan_complete=1 WHERE id=1');
 const insert=db.prepare('INSERT INTO viewer_reference_attempt_journal(attempt_id,submission_id,environment,request_json,request_sha256,input_manifest_sha256,job_id,job_json,job_sha256) VALUES(?,?,?,?,?,?,?,?,?)');
 insert.run('a','s1','staging','{}','h','m','j1','{}','j');insert.run('b','s2','staging','{}','h','m',null,null,null);
 assert.throws(()=>db.exec("INSERT OR REPLACE INTO viewer_reference_attempt_journal(attempt_id,submission_id,environment,request_json,request_sha256,input_manifest_sha256,job_id,job_json,job_sha256) VALUES('c','s3','staging','{}','h','m','j1','{}','j')"));
 assert.throws(()=>db.exec("UPDATE OR REPLACE viewer_reference_attempt_journal SET job_id='j1',job_json='{}',job_sha256='j' WHERE attempt_id='b'"));
 const rowid=db.prepare("SELECT rowid AS n FROM viewer_reference_attempt_journal WHERE attempt_id='a'").get().n;
 for(const key of ['rowid','_rowid_','oid']){assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO viewer_reference_attempt_journal(${key},attempt_id,submission_id,environment,request_json,request_sha256,input_manifest_sha256) VALUES(?,'c','s3','staging','{}','h','m')`).run(rowid));assert.throws(()=>db.prepare(`UPDATE OR REPLACE viewer_reference_attempt_journal SET ${key}=? WHERE attempt_id='b'`).run(rowid));}
 assert.deepEqual(db.prepare('SELECT attempt_id FROM viewer_reference_attempt_journal ORDER BY attempt_id').all().map(x=>x.attempt_id),['a','b']);
});

test('a journaled attempt cannot be deleted and a surrounding cleanup rolls back',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON; CREATE TABLE processing_attempts(id TEXT PRIMARY KEY); CREATE TABLE provisional_outputs(attempt_id TEXT); CREATE TABLE dataset_operations(id TEXT PRIMARY KEY,operation_type TEXT,payload_json TEXT,processing_attempt_id TEXT,status TEXT,upload_id TEXT,import_preview_id TEXT); INSERT INTO processing_attempts VALUES(\'a\'); INSERT INTO provisional_outputs VALUES(\'a\')');db.exec(MIGRATIONS.find(m=>m.version===50).sql);db.exec('DROP TRIGGER viewer_reference_attempt_admission_unavailable; UPDATE reference_catalog_projection_state SET scan_complete=1 WHERE id=1');
 db.exec("INSERT INTO viewer_reference_attempt_journal(attempt_id,submission_id,environment,request_json,request_sha256,input_manifest_sha256) VALUES('a','s','staging','{}','h','m'); BEGIN IMMEDIATE; DELETE FROM provisional_outputs WHERE attempt_id='a'");
 assert.throws(()=>db.exec("DELETE FROM processing_attempts WHERE id='a'"));db.exec('ROLLBACK');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM processing_attempts').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provisional_outputs').get().n,1);
});
