'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {prepareSourceBindingDraft}=require('../server/referenceSourceBindingDraft');
const {applyStorageMutation}=require('../server/storageLifecycle');

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
 const p=new ProcessingRepository(db),project=p.createProject({id:'p',displayName:'Synthetic'}),dataset=p.createDataset({id:'d',projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 p.finalizeDataset(dataset.id,[{id:'file1',relativePath:'one.jpg',byteSize:3,sha256:'a'.repeat(64)},{id:'file2',relativePath:'source.csv',byteSize:4,sha256:'b'.repeat(64)}],'c'.repeat(64));
 db.exec("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('t','p','d','T','draft','t','t'); INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES('a','t','d',1,'{}','pending','t','t'); UPDATE processing_tasks SET active_attempt_id='a' WHERE id='t'");
 return {db,p};
}
const admit=({p})=>prepareSourceBindingDraft(p,{id:'binding',attemptId:'a'});
function enableOnlyForSyntheticFixture(db){db.exec('DROP TRIGGER viewer_source_binding_unavailable');}

test('hard disabled source binding never issues a pin or mutates metadata',t=>{
 const f=fixture(t);assert.throws(()=>admit(f),/source binding admission unavailable/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_source_bindings').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_source_binding_objects').get().n,0);
});

test('synthetic binding records exact indexed files and blocks lifecycle and replacement',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);const result=admit(f);assert.equal(result.objectCount,2);
 f.db.prepare("UPDATE processing_attempts SET status='failed' WHERE id='a'").run();
 const rows=f.db.prepare('SELECT file_id,relative_path,byte_size,sha256 FROM viewer_source_binding_objects ORDER BY file_id').all().map(x=>({...x}));
 assert.deepEqual(rows,[{file_id:'file1',relative_path:'one.jpg',byte_size:3,sha256:'a'.repeat(64)},{file_id:'file2',relative_path:'source.csv',byte_size:4,sha256:'b'.repeat(64)}]);
 assert.equal(f.p.hasSourceBinding('d'),true);assert.equal(f.p.datasetHasRetainedCsv('d'),true);
 assert.equal(f.p.archiveDataset('d'),null);assert.equal(f.p.archiveTask('t'),null);assert.equal(f.p.beginTrashMutation('d','test'),null);assert.equal(f.p.trashTask('t','test'),null);assert.equal(f.p.trashProject('p','test'),null);
 assert.equal(f.p.auditedMutation({action:'test',entityType:'dataset'},()=>f.p.archiveDataset('d')),null);
 assert.equal(f.p.auditedMutation({action:'test',entityType:'task'},()=>f.p.archiveTask('t')),null);
 assert.throws(()=>f.db.prepare("UPDATE dataset_files SET sha256=? WHERE id='file1'").run('d'.repeat(64)),/source binding dataset files retained/);
 assert.throws(()=>f.db.prepare("DELETE FROM dataset_files WHERE id='file1'").run(),/source binding dataset files retained/);
 assert.throws(()=>f.db.exec("INSERT OR REPLACE INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,created_at,updated_at) VALUES('d','p','Replacement','managed','datasets','other','draft','t','t')"),/source binding dataset retained/);
 f.p.createDataset({id:'other',projectId:'p',displayName:'Other',storageMode:'managed',rootKey:'datasets',relativePath:'other'});
 assert.throws(()=>f.db.prepare("INSERT OR REPLACE INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,created_at) VALUES('file1','other','other.jpg',3,?,'t')").run('a'.repeat(64)),/source binding dataset files retained/);
 assert.throws(()=>f.db.exec("UPDATE processing_tasks SET dataset_id='other' WHERE id='t'"),/source binding task identity retained/);
 assert.throws(()=>f.db.exec("UPDATE processing_attempts SET dataset_id='other' WHERE id='a'"),/source binding attempt identity retained/);
 assert.throws(()=>f.db.prepare("INSERT INTO viewer_source_binding_objects(binding_id,file_id,relative_path,byte_size,sha256) VALUES('binding','file1','one.jpg',3,?)").run('a'.repeat(64)),/source binding object conflict/);
 assert.throws(()=>f.db.prepare("DELETE FROM viewer_source_bindings WHERE id='binding'").run(),/source binding retained/);
});

test('same-root ancestor and descendant are conservatively held without prefix collisions',t=>{
 const f=fixture(t);f.db.exec("UPDATE datasets SET relative_path='Parent/Child' WHERE id='d'");enableOnlyForSyntheticFixture(f.db);admit(f);
 const make=(id,relative)=>{const d=f.p.createDataset({id,projectId:'p',displayName:id,storageMode:'managed',rootKey:'datasets',relativePath:relative});f.p.finalizeDataset(d.id,[{id:id+'f',relativePath:'x.jpg',byteSize:1,sha256:'e'.repeat(64)}],'f'.repeat(64));return d;};
 make('ancestor','parent');make('descendant','parent/child/nested');make('sibling','parent/children');make('unknown','parent/odd name');
 for(const id of ['ancestor','descendant','unknown']){assert.equal(f.p.hasSourceBinding(id),true,id);assert.equal(f.p.beginTrashMutation(id,'test'),null,id);assert.equal(f.p.datasetHasRetainedCsv(id),true,id);}
 assert.equal(f.p.hasSourceBinding('sibling'),false);assert.ok(f.p.archiveDataset('sibling'));
});

test('earlier same-root ancestor lifecycle intent blocks draft binding',t=>{
 const f=fixture(t);f.db.exec("UPDATE datasets SET relative_path='Parent/Child' WHERE id='d'");enableOnlyForSyntheticFixture(f.db);
 const ancestor=f.p.createDataset({id:'ancestor',projectId:'p',displayName:'Ancestor',storageMode:'managed',rootKey:'datasets',relativePath:'parent'});
 f.p.finalizeDataset(ancestor.id,[{id:'ancfile',relativePath:'x.jpg',byteSize:1,sha256:'e'.repeat(64)}],'f'.repeat(64));
 assert.ok(f.p.beginTrashMutation('ancestor','test'));
 assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM viewer_source_bindings').get().n,0);
});

test('unsettled failed, cancelled and derivative-stage dataset operations block draft binding',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 const add=f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,dataset_id,processing_attempt_id,payload_json,status,available_at,created_at,updated_at) VALUES(?, 'catalog_map','synthetic','d','a','{}',?,'t','t','t')");
 for(const status of ['failed','cancelled','awaiting_derivatives']){
  add.run('op-'+status,status);
  assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
  f.db.prepare('DELETE FROM dataset_operations WHERE id=?').run('op-'+status);
 }
 assert.equal(f.db.prepare('SELECT count(*) n FROM viewer_source_bindings').get().n,0);
});

test('payload-linked catalog work is resolved even when dataset_id is null',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('payload-op','catalog_map','synthetic',?,'queued','t','t','t')").run(JSON.stringify({ids:{attemptId:'a',datasetId:'d'}}));
 assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM viewer_source_bindings').get().n,0);
});

test('succeeded catalog source cleanup and pending import cleanup both block admission',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('cleanup-op','catalog_map','synthetic',?,'succeeded','t','t','t')").run(JSON.stringify({ids:{attemptId:'a',datasetId:'d'},sourceCleanup:{rootKey:'dataset_import',relativePath:'source'}}));
 assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
 f.db.exec("DELETE FROM dataset_operations WHERE id='cleanup-op'; INSERT INTO retained_imports(id,source_kind,staging_root_key,staging_relative_path,state,cleanup_jobs_inserted,created_at,updated_at) VALUES('ri','nodeodm_result','cache','stage','ready',1,'t','t'); INSERT INTO import_cleanup_jobs(id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at) VALUES('cleanup','ri','staging_tree','cache','stage','pending','t','t','t')");
 assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
});

test('bound source conservatively blocks new import-cleanup claim and filesystem callback',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);admit(f);
 f.db.exec("INSERT INTO retained_imports(id,source_kind,staging_root_key,staging_relative_path,state,cleanup_jobs_inserted,created_at,updated_at) VALUES('ri','nodeodm_result','cache','stage','ready',1,'t','t'); INSERT INTO import_cleanup_jobs(id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at) VALUES('cleanup','ri','staging_tree','cache','stage','pending','2000-01-01T00:00:00.000Z','t','t')");
 assert.equal(f.p.claimImportCleanup('synthetic'),null);
 const until=new Date(Date.now()+60000).toISOString();
 f.db.prepare("UPDATE import_cleanup_jobs SET status='leased',lease_owner='synthetic',lease_token='token',lease_generation=1,lease_expires_at=? WHERE id='cleanup'").run(until);
 let invoked=false;
 assert.equal(f.p.mutateImportCleanupFilesystem('cleanup','synthetic','token',1,()=>{invoked=true;}),false);
 assert.equal(invoked,false);
});

test('bound source conservatively suppresses newly queued catalog-source cleanup',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);admit(f);
 const payload=JSON.stringify({ids:{attemptId:'a',datasetId:'d'},sourceCleanup:{rootKey:'dataset_import',relativePath:'source'}});
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('cleanup-op','catalog_map','synthetic',?,'succeeded','t','t','t')").run(payload);
 assert.deepEqual(f.p.pendingCatalogSourceCleanups(),[]);
 assert.equal(f.p.clearCatalogSourceCleanup('cleanup-op'),false);
 assert.deepEqual(JSON.parse(f.db.prepare("SELECT payload_json FROM dataset_operations WHERE id='cleanup-op'").get().payload_json),JSON.parse(payload));
});

test('malformed or mismatched catalog identity blocks admission without guessing',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 const add=f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('bad','catalog_map','synthetic',?,'queued','t','t','t')");
 for(const payload of ['not-json',JSON.stringify({ids:{attemptId:'missing',datasetId:'d'}}),JSON.stringify({ids:{attemptId:'a',datasetId:'other'}})]){
  add.run(payload);assert.throws(()=>admit(f),{code:'source_binding_unavailable'});f.db.exec("DELETE FROM dataset_operations WHERE id='bad'");
 }
});

test('resolved unrelated catalog operation does not match a disjoint indexed path',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 const other=f.p.createDataset({id:'other',projectId:'p',displayName:'Other',storageMode:'managed',rootKey:'datasets',relativePath:'disjoint'});
 f.p.finalizeDataset(other.id,[{id:'otherfile',relativePath:'x.jpg',byteSize:1,sha256:'f'.repeat(64)}],'e'.repeat(64));
 f.db.exec("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('other-task','p','other','Other','draft','t','t'); INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES('other-attempt','other-task','other',1,'{}','pending','t','t')");
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('unrelated','catalog_map','synthetic',?,'queued','t','t','t')").run(JSON.stringify({ids:{attemptId:'other-attempt',datasetId:'other'}}));
 assert.equal(admit(f).objectCount,2);
});

test('archive methods still work inside audited repository transaction without a binding',t=>{
 const f=fixture(t);f.db.exec("UPDATE processing_attempts SET status='failed' WHERE id='a'");
 assert.ok(f.p.auditedMutation({action:'test',entityType:'task'},()=>f.p.archiveTask('t')));
 assert.ok(f.p.auditedMutation({action:'test',entityType:'dataset'},()=>f.p.archiveDataset('d')));
});

test('draft refuses to bind if foreign keys are disabled',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);f.db.exec('PRAGMA foreign_keys=OFF');
 assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM viewer_source_bindings').get().n,0);
});

test('mutation first blocks binding; existing mutation cannot resume when binding exists',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 f.db.exec("UPDATE processing_tasks SET status='archived' WHERE id='t'");
 const mutation=f.p.beginTrashMutation('d','test');assert.ok(mutation);
 // Restore task metadata only to isolate the in-flight mutation guard.
 f.db.exec("UPDATE processing_tasks SET status='draft' WHERE id='t'");
 assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
 f.db.exec("DELETE FROM storage_mutations WHERE id='"+mutation.id+"'");
 admit(f);let touched=false;
 assert.throws(()=>applyStorageMutation(f.p,{pathExistsStrict:()=>{touched=true;return true;}},{id:'old',status:'intent',type:'trash',entityType:'dataset',entityId:'d',sourceRootKey:'datasets',sourceRelativePath:'synthetic'}),{code:'source_binding_retained'});
 assert.equal(touched,false);
});

test('unsupported provisional migration identity fails closed',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT); INSERT INTO schema_migrations VALUES(48,'foreign','t')");assert.throws(()=>applyMigrations(db),{code:'migration_identity_conflict'});}finally{db.close();}
});

test('two file-backed connections serialize draft binding against lifecycle admission',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-binding-test-')),file=path.join(dir,'test.sqlite');
 let db1,db2;
 try {
  db1=new DatabaseSync(file);db1.exec('PRAGMA foreign_keys=ON');applyMigrations(db1);
  const p1=new ProcessingRepository(db1),project=p1.createProject({id:'p',displayName:'Synthetic'});
  const d=p1.createDataset({id:'d',projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
  p1.finalizeDataset(d.id,[{id:'file1',relativePath:'one.jpg',byteSize:3,sha256:'a'.repeat(64)}],'c'.repeat(64));
  db1.exec("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('t','p','d','T','draft','t','t'); INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES('a','t','d',1,'{}','pending','t','t'); UPDATE processing_tasks SET active_attempt_id='a' WHERE id='t'; DROP TRIGGER viewer_source_binding_unavailable");
  db2=new DatabaseSync(file);db2.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');const p2=new ProcessingRepository(db2);
  db1.exec('BEGIN IMMEDIATE');
  try{assert.throws(()=>prepareSourceBindingDraft(p2,{id:'binding',attemptId:'a'}),/database is locked/);}finally{db1.exec('ROLLBACK');}
  prepareSourceBindingDraft(p1,{id:'binding',attemptId:'a'});
  assert.equal(p2.beginTrashMutation('d','test'),null);
  const d2=p1.createDataset({id:'d2',projectId:'p',displayName:'Synthetic 2',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic2'});
  p1.finalizeDataset(d2.id,[{id:'file2',relativePath:'two.jpg',byteSize:3,sha256:'b'.repeat(64)}],'d'.repeat(64));
  db1.exec("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('t2','p','d2','T2','archived','t','t'); INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES('a2','t2','d2',1,'{}','pending','t','t'); UPDATE processing_tasks SET active_attempt_id='a2' WHERE id='t2'");
  const mutation=p2.beginTrashMutation('d2','test');assert.ok(mutation);
  db1.exec("UPDATE processing_tasks SET status='draft' WHERE id='t2'");
  assert.throws(()=>prepareSourceBindingDraft(p1,{id:'binding2',attemptId:'a2'}),{code:'source_binding_unavailable'});
  assert.equal(db1.prepare("SELECT count(*) n FROM viewer_source_bindings WHERE id='binding2'").get().n,0);
 } finally {
  if(db2)db2.close();if(db1)db1.close();
  for(const suffix of ['','-wal','-shm','-journal']){try{fs.unlinkSync(file+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}}
  fs.rmdirSync(dir);
 }
});
