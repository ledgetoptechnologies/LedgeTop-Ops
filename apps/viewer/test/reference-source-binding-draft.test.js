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

test('in-flight import effect survives lease expiry and blocks reclaim and binding',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 f.db.exec("INSERT INTO retained_imports(id,source_kind,staging_root_key,staging_relative_path,state,cleanup_jobs_inserted,created_at,updated_at) VALUES('ri','nodeodm_result','cache','stage','ready',1,'t','t'); INSERT INTO import_cleanup_jobs(id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at) VALUES('cleanup','ri','staging_tree','cache','stage','pending','2000-01-01T00:00:00.000Z','t','t')");
 const job=f.p.claimImportCleanup('worker');assert.ok(job);
 const applied=f.p.mutateImportCleanupFilesystem('cleanup','worker',job.lease_token,job.lease_generation,()=>{
  assert.throws(()=>f.db.exec("UPDATE import_cleanup_jobs SET relative_path='changed' WHERE id='cleanup'"),/source import effect in flight/);
  assert.throws(()=>f.db.exec("DELETE FROM import_cleanup_jobs WHERE id='cleanup'"),/source import effect in flight/);
  assert.throws(()=>f.db.exec("INSERT OR REPLACE INTO import_cleanup_jobs(id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at) VALUES('replacement','ri','staging_tree','cache','changed','pending','t','t','t')"),/source import effect in flight/);
  f.db.exec("UPDATE import_cleanup_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='cleanup'");
  assert.equal(f.p.claimImportCleanup('late-worker'),null);
  assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
 });
 assert.equal(applied,true);assert.equal(f.p.mutateImportCleanupFilesystem('cleanup','worker',job.lease_token,job.lease_generation,()=>{}),false);const claim=f.db.prepare("SELECT * FROM viewer_source_effect_claims WHERE effect_type='import_cleanup'").get();
 assert.equal(claim.state,'in_flight');assert.equal(claim.root_key,'cache');assert.equal(claim.relative_path,'stage');assert.equal(claim.lease_generation,job.lease_generation);
 assert.equal(f.p.claimImportCleanup('late-worker'),null);
});

test('successful import effect releases only its claim without a DB lock across callback',t=>{
 const f=fixture(t);f.db.exec("INSERT INTO retained_imports(id,source_kind,staging_root_key,staging_relative_path,state,cleanup_jobs_inserted,created_at,updated_at) VALUES('ri','nodeodm_result','cache','stage','ready',1,'t','t'); INSERT INTO import_cleanup_jobs(id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at) VALUES('cleanup','ri','staging_tree','cache','stage','pending','2000-01-01T00:00:00.000Z','t','t')");
 const job=f.p.claimImportCleanup('worker');assert.ok(job);
 for(let i=0;i<10000;i++)assert.equal(f.p.mutateImportCleanupFilesystem('cleanup','worker',job.lease_token,job.lease_generation,()=>{if(i===0)assert.equal(f.p.transaction(()=>true),true);}),true);
 assert.equal(f.db.prepare("SELECT count(*) n FROM viewer_source_effect_claims WHERE effect_type='import_cleanup'").get().n,1);
 assert.ok(f.p.persistImportCleanupQuarantineIntent('cleanup','worker',job.lease_token,job.lease_generation));
 assert.equal(f.p.markImportCleanupQuarantined('cleanup','worker',job.lease_token,job.lease_generation),true);
 assert.equal(f.p.completeImportCleanup('cleanup','worker',job.lease_token,job.lease_generation),true);
 assert.equal(f.p.settleImportCleanupEffect('cleanup',job.source_effect_claim_id,'worker',job.lease_token,job.lease_generation),true);
 assert.equal(f.db.prepare("SELECT state FROM viewer_source_effect_claims WHERE effect_type='import_cleanup'").get().state,'completed');
});

test('actual cleanup worker leaves failed and no-delete outcomes persistently uncertain',async t=>{
 const {processOneImportCleanup}=require('../server/importCleanup');
 for(const [id,rootPath,errorCode,expected] of [['failed','invalid-path',null,'pending'],['no-delete','webodm-task-imports/no-delete','EROFS','cleanup_skipped_read_only']]){
  const f=fixture(t);f.db.prepare("INSERT INTO retained_imports(id,source_kind,staging_root_key,staging_relative_path,state,cleanup_jobs_inserted,created_at,updated_at) VALUES(?,'nodeodm_result','cache',?,'ready',1,'t','t')").run(id,rootPath);
  f.db.prepare("INSERT INTO import_cleanup_jobs(id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at) VALUES(?,?,'staging_tree','cache',?,'pending','2000-01-01T00:00:00.000Z','t','t')").run(id,id,rootPath);
  const storage={openCleanupRoot(){throw Object.assign(new Error('synthetic read-only'),{code:errorCode});}};
  assert.equal(await processOneImportCleanup({processing:f.p,storage},'worker'),true);
  assert.equal(f.db.prepare('SELECT status FROM import_cleanup_jobs WHERE id=?').get(id).status,expected);
  assert.equal(f.db.prepare('SELECT state FROM viewer_source_effect_claims WHERE operation_id=?').get(id).state,'in_flight');
  assert.equal(f.p.claimImportCleanup('replacement',{at:Date.now()+10000000}),null);
 }
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

test('unresolved adoption intent blocks binding even when its dataset is disjoint',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 const other=f.p.createDataset({id:'other',projectId:'p',displayName:'Other',storageMode:'managed',rootKey:'datasets',relativePath:'disjoint'});
 f.p.finalizeDataset(other.id,[{id:'otherfile',relativePath:'x.jpg',byteSize:1,sha256:'f'.repeat(64)}],'e'.repeat(64));
 f.db.exec("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('other-task','p','other','Other','draft','t','t'); INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES('other-attempt','other-task','other',1,'{}','pending','t','t')");
 const payload={ids:{attemptId:'other-attempt',datasetId:'other'},adoptionIntent:{rootKey:'dataset_import',relativePath:'source',datasetRelative:'synthetic'}};
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('adoption','catalog_map','synthetic',?,'failed','t','t','t')").run(JSON.stringify(payload));
 assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
});

test('binding blocks newly fetched and already fetched adoption recovery effects',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);admit(f);
 const payload={ids:{attemptId:'a',datasetId:'d'},adoptionIntent:{rootKey:'dataset_import',relativePath:'source',datasetRelative:'synthetic'}};
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('adoption','catalog_map','synthetic',?,'failed','t','t','t')").run(JSON.stringify(payload));
 assert.deepEqual(f.p.pendingCatalogAdoptionRecoveries(),[]);
 let called=false;assert.equal(f.p.mutateCatalogAdoptionRecovery('adoption',()=>{called=true;}),false);assert.equal(called,false);
 const {reconcileCatalogAdoptionRecoveries}=require('../server/datasetOperationWorker');
 assert.equal(reconcileCatalogAdoptionRecoveries(f.p,{reconcileAdoptionIntent(){called=true;}}),0);assert.equal(called,false);
 assert.equal(f.p.clearCatalogAdoptionIntent('adoption'),false);
 assert.deepEqual(JSON.parse(f.db.prepare("SELECT payload_json FROM dataset_operations WHERE id='adoption'").get().payload_json),payload);
 f.db.exec("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,lease_owner,available_at,created_at,updated_at) VALUES('new-adoption','catalog_map','synthetic','{}','leased','worker','t','t','t')");
 assert.equal(f.p.setCatalogAdoptionIntent('new-adoption','worker',payload.adoptionIntent),false);
});

test('unbound adoption recovery invokes actual worker and clears its journal',t=>{
 const f=fixture(t),payload={ids:{attemptId:'a',datasetId:'missing'},adoptionIntent:{rootKey:'dataset_import',relativePath:'source',datasetRelative:'destination'}};
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('adoption','catalog_map','synthetic',?,'failed','t','t','t')").run(JSON.stringify(payload));
 const {reconcileCatalogAdoptionRecoveries}=require('../server/datasetOperationWorker');let args;
 assert.equal(reconcileCatalogAdoptionRecoveries(f.p,{reconcileAdoptionIntent(...value){args=value;}}),1);
 assert.deepEqual(args,['dataset_import','source','destination']);
 assert.equal(JSON.parse(f.db.prepare("SELECT payload_json FROM dataset_operations WHERE id='adoption'").get().payload_json).adoptionIntent,undefined);
 assert.equal(f.db.prepare("SELECT state FROM viewer_source_effect_claims WHERE operation_id='adoption'").get().state,'completed');
});

test('interrupted adoption effect remains uncertain and blocks binding and retry',t=>{
 const f=fixture(t);enableOnlyForSyntheticFixture(f.db);
 const payload={ids:{attemptId:'a',datasetId:'d'},adoptionIntent:{rootKey:'dataset_import',relativePath:'source',datasetRelative:'synthetic'}};
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('adoption','catalog_map','synthetic',?,'failed','t','t','t')").run(JSON.stringify(payload));
 assert.throws(()=>f.p.mutateCatalogAdoptionRecovery('adoption',()=>{throw Error('interrupted');}),/interrupted/);
 const claim=f.db.prepare('SELECT * FROM viewer_source_effect_claims').get();assert.equal(claim.state,'in_flight');assert.equal(claim.root_key,'dataset_import');assert.equal(claim.dataset_relative,'synthetic');
 assert.throws(()=>f.db.prepare("UPDATE viewer_source_effect_claims SET rowid=rowid+1,state='completed',completed_at='t' WHERE id=?").run(claim.id),/source effect claim immutable/);
 assert.equal(f.p.mutateCatalogAdoptionRecovery('adoption',()=>{throw Error('must not retry');}),false);
 f.db.prepare("UPDATE dataset_operations SET status='succeeded',payload_json=? WHERE id='adoption'").run(JSON.stringify({ids:{attemptId:'a',datasetId:'d'}}));
 assert.throws(()=>admit(f),{code:'source_binding_unavailable'});
 assert.throws(()=>f.db.prepare('DELETE FROM viewer_source_effect_claims WHERE id=?').run(claim.id),/source effect claim retained/);
});

test('false adoption callback leaves the effect uncertain',t=>{
 const f=fixture(t),payload={ids:{attemptId:'a',datasetId:'d'},adoptionIntent:{rootKey:'dataset_import',relativePath:'source',datasetRelative:'synthetic'}};
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('adoption','catalog_map','synthetic',?,'failed','t','t','t')").run(JSON.stringify(payload));
 assert.throws(()=>f.p.mutateCatalogAdoptionRecovery('adoption',()=>false),/did not complete/);
 assert.equal(f.db.prepare('SELECT state FROM viewer_source_effect_claims').get().state,'in_flight');
});

test('in-flight adoption intent cannot be cleared and changed identity never settles',t=>{
 const f=fixture(t),payload={ids:{attemptId:'a',datasetId:'d'},adoptionIntent:{rootKey:'dataset_import',relativePath:'source',datasetRelative:'synthetic'}};
 f.db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('adoption','catalog_map','synthetic',?,'failed','t','t','t')").run(JSON.stringify(payload));
 assert.equal(f.p.mutateCatalogAdoptionRecovery('adoption',()=>{
  assert.equal(f.p.clearCatalogAdoptionIntent('adoption'),false);
  f.db.prepare("UPDATE dataset_operations SET payload_json=? WHERE id='adoption'").run(JSON.stringify({...payload,ids:{attemptId:'a',datasetId:'different'}}));
 }),false);
 assert.equal(f.db.prepare('SELECT state FROM viewer_source_effect_claims').get().state,'in_flight');
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

test('separate process death leaves a durable uncertain effect that blocks binding',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-effect-test-')),file=path.join(dir,'test.sqlite');let db;
 try{
  db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);const p=new ProcessingRepository(db);
  p.createProject({id:'p',displayName:'Synthetic'});p.createDataset({id:'d',projectId:'p',displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
  p.finalizeDataset('d',[{id:'file1',relativePath:'one.jpg',byteSize:3,sha256:'a'.repeat(64)}],'c'.repeat(64));
  db.exec("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('t','p','d','T','draft','t','t'); INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES('a','t','d',1,'{}','pending','t','t'); UPDATE processing_tasks SET active_attempt_id='a' WHERE id='t'; DROP TRIGGER viewer_source_binding_unavailable");
  db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('adoption','catalog_map','synthetic',?,'failed','t','t','t')").run(JSON.stringify({ids:{attemptId:'a',datasetId:'d'},adoptionIntent:{rootKey:'dataset_import',relativePath:'source',datasetRelative:'synthetic'}}));
  const script=`const {DatabaseSync}=require('node:sqlite');const {ProcessingRepository}=require(${JSON.stringify(require.resolve('../server/processingRepository'))});const db=new DatabaseSync(${JSON.stringify(file)});db.exec('PRAGMA foreign_keys=ON');new ProcessingRepository(db).mutateCatalogAdoptionRecovery('adoption',()=>process.exit(23));process.exit(24);`;
  const child=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:10000});assert.equal(child.error,undefined);assert.equal(child.status,23,child.stderr);
  assert.equal(db.prepare("SELECT state FROM viewer_source_effect_claims WHERE operation_id='adoption'").get().state,'in_flight');
  db.prepare("UPDATE dataset_operations SET status='succeeded',payload_json=? WHERE id='adoption'").run(JSON.stringify({ids:{attemptId:'a',datasetId:'d'}}));
  assert.throws(()=>prepareSourceBindingDraft(p,{id:'binding',attemptId:'a'}),{code:'source_binding_unavailable'});
 }finally{
  if(db)db.close();for(const suffix of ['','-wal','-shm','-journal']){try{fs.unlinkSync(file+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}}fs.rmdirSync(dir);
 }
});

test('separate import-cleanup process death leaves an unreclaimable uncertain effect',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-import-effect-test-')),file=path.join(dir,'test.sqlite');let db;
 try{
  db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
  db.exec("INSERT INTO retained_imports(id,source_kind,staging_root_key,staging_relative_path,state,cleanup_jobs_inserted,created_at,updated_at) VALUES('ri','nodeodm_result','cache','stage','ready',1,'t','t'); INSERT INTO import_cleanup_jobs(id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at) VALUES('cleanup','ri','staging_tree','cache','stage','pending','2000-01-01T00:00:00.000Z','t','t')");
  const script=`const {DatabaseSync}=require('node:sqlite');const {ProcessingRepository}=require(${JSON.stringify(require.resolve('../server/processingRepository'))});const db=new DatabaseSync(${JSON.stringify(file)});db.exec('PRAGMA foreign_keys=ON');const p=new ProcessingRepository(db),j=p.claimImportCleanup('child');p.mutateImportCleanupFilesystem(j.id,'child',j.lease_token,j.lease_generation,()=>process.exit(23));process.exit(24);`;
  const child=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:10000});assert.equal(child.error,undefined);assert.equal(child.status,23,child.stderr);
  assert.equal(db.prepare("SELECT state FROM viewer_source_effect_claims WHERE effect_type='import_cleanup'").get().state,'in_flight');
  db.exec("UPDATE import_cleanup_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='cleanup'");
  assert.equal(new ProcessingRepository(db).claimImportCleanup('replacement'),null);
 }finally{if(db)db.close();for(const suffix of ['','-wal','-shm','-journal']){try{fs.unlinkSync(file+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}}fs.rmdirSync(dir);}
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
  db1.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,available_at,created_at,updated_at) VALUES('adoption','catalog_map','synthetic',?,'failed','t','t','t')").run(JSON.stringify({ids:{attemptId:'a',datasetId:'d'},adoptionIntent:{rootKey:'dataset_import',relativePath:'source',datasetRelative:'synthetic'}}));
  const script=`const {DatabaseSync}=require('node:sqlite');const {ProcessingRepository}=require(${JSON.stringify(require.resolve('../server/processingRepository'))});const db=new DatabaseSync(${JSON.stringify(file)});db.exec('PRAGMA foreign_keys=ON');const admitted=new ProcessingRepository(db).mutateCatalogAdoptionRecovery('adoption',()=>process.exit(25));db.close();process.exit(admitted?24:0);`;
  const child=require('node:child_process').spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:10000});assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
  assert.equal(db1.prepare('SELECT count(*) n FROM viewer_source_effect_claims').get().n,0);db1.exec("DELETE FROM dataset_operations WHERE id='adoption'");
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
