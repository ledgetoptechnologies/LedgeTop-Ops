'use strict';
// Offline fixture only: the intent is not a filesystem lock, source-side pin,
// writer fence, quota reservation or authority. No runtime route uses this.
const crypto=require('node:crypto');
const {createSourceSnapshotAcquirer}=require('./sourceSnapshotAcquisition');
const {prepareSourceBindingDraft}=require('./referenceSourceBindingDraft');
const {createAssociationOutboxFixture}=require('./referenceV2AssociationOutboxFixture');
const managedWriterOwners=new WeakMap();
const fail=()=>{throw Object.assign(new Error('source scan fixture unavailable'),{code:'source_scan_fixture_unavailable'})};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x);
function createSourceScanFixture(processing,scope){
 if(scope!=='isolated-source-scan-fixture'||!processing?.database)fail();
 const db=processing.database;
 db.exec(`CREATE TABLE IF NOT EXISTS reference_source_scan_fixture(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,binding_id TEXT NOT NULL,dataset_id TEXT NOT NULL,project_id TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('scanning','committed')));
 CREATE UNIQUE INDEX IF NOT EXISTS reference_source_scan_fixture_one ON reference_source_scan_fixture(state) WHERE state='scanning';
 CREATE TRIGGER IF NOT EXISTS reference_source_scan_fixture_no_replace BEFORE INSERT ON reference_source_scan_fixture WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE id=NEW.id OR rowid=NEW.rowid OR state='scanning') BEGIN SELECT RAISE(ABORT,'scan intent retained'); END;
 CREATE TRIGGER IF NOT EXISTS reference_source_scan_fixture_no_delete BEFORE DELETE ON reference_source_scan_fixture BEGIN SELECT RAISE(ABORT,'scan intent retained'); END;
 CREATE TRIGGER IF NOT EXISTS reference_source_scan_fixture_no_update BEFORE UPDATE ON reference_source_scan_fixture WHEN NOT(OLD.state='scanning' AND NEW.state='committed' AND NEW.id IS OLD.id AND NEW.attempt_id IS OLD.attempt_id AND NEW.binding_id IS OLD.binding_id AND NEW.dataset_id IS OLD.dataset_id AND NEW.project_id IS OLD.project_id AND NEW.manifest_sha256 IS OLD.manifest_sha256 AND NEW.token IS OLD.token) BEGIN SELECT RAISE(ABORT,'scan intent immutable'); END;`);
 // These disposable-database guards fence indexed rows only. They do not
 // protect file bytes, unregistered writers, aliases or external NAS access.
 db.exec(`CREATE TRIGGER IF NOT EXISTS reference_scan_dataset_update BEFORE UPDATE ON datasets WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning' AND dataset_id=OLD.id) BEGIN SELECT RAISE(ABORT,'scan metadata retained'); END;
 CREATE TRIGGER IF NOT EXISTS reference_scan_dataset_delete BEFORE DELETE ON datasets WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning' AND dataset_id=OLD.id) BEGIN SELECT RAISE(ABORT,'scan metadata retained'); END;
 CREATE TRIGGER IF NOT EXISTS reference_scan_dataset_insert BEFORE INSERT ON datasets WHEN EXISTS(SELECT 1 FROM datasets d JOIN reference_source_scan_fixture s ON s.dataset_id=d.id AND s.state='scanning' WHERE d.id=NEW.id OR d.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'scan metadata retained'); END;
 CREATE TRIGGER IF NOT EXISTS reference_scan_file_insert BEFORE INSERT ON dataset_files WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning' AND dataset_id=NEW.dataset_id) OR EXISTS(SELECT 1 FROM dataset_files f JOIN reference_source_scan_fixture s ON s.dataset_id=f.dataset_id AND s.state='scanning' WHERE f.id=NEW.id OR f.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'scan metadata retained'); END;
 CREATE TRIGGER IF NOT EXISTS reference_scan_file_update BEFORE UPDATE ON dataset_files WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning' AND dataset_id IN (OLD.dataset_id,NEW.dataset_id)) BEGIN SELECT RAISE(ABORT,'scan metadata retained'); END;
 CREATE TRIGGER IF NOT EXISTS reference_scan_file_delete BEFORE DELETE ON dataset_files WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning' AND dataset_id=OLD.dataset_id) BEGIN SELECT RAISE(ABORT,'scan metadata retained'); END;`);
 const guards=['reference_source_scan_fixture_no_replace','reference_source_scan_fixture_no_delete','reference_source_scan_fixture_no_update','reference_scan_dataset_update','reference_scan_dataset_delete','reference_scan_dataset_insert','reference_scan_file_insert','reference_scan_file_update','reference_scan_file_delete'];
 const checkGuards=()=>{const q=db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?");if(guards.some(name=>!q.get(name)))fail();if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_scan_cooperation_marker'").get()){const extra=['reference_scan_effects_before_scan','reference_scan_blocks_source_effect','reference_scan_blocks_lifecycle_effect','reference_scan_blocks_catalog_effect','reference_scan_blocks_adoption_effect','reference_scan_blocks_managed_writer','reference_scan_managed_writer_no_delete','reference_scan_managed_writer_no_replace','reference_scan_managed_writer_update'];if(extra.some(name=>!q.get(name)))fail();require('./referenceLifecycleEffectFence').createOfflineLifecycleFence(processing,'isolated-lifecycle-fence-fixture')}};
 function run({scanId,bindingId,attemptId,managedRoot,association,afterReserve,afterScan,afterOutbox}={}){
  if(!id(scanId)||!id(bindingId)||!id(attemptId)||typeof managedRoot!=='string'||(afterReserve!==undefined&&typeof afterReserve!=='function')||(afterScan!==undefined&&typeof afterScan!=='function')||(afterOutbox!==undefined&&typeof afterOutbox!=='function')||(association!==undefined&&(!association||association.args?.processing!==processing||association.args?.bindingId!==bindingId||!Buffer.isBuffer(association.publicKeyDer))))fail();
  // Install the disposable outbox schema before either transactional phase.
  const outbox=association&&createAssociationOutboxFixture(processing,'isolated-association-outbox-fixture');
  const token=crypto.randomBytes(32).toString('hex');
  const reserved=processing.transaction(()=>{
   checkGuards();
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='viewer_source_binding_unavailable'").get())fail();
   const attempt=processing.getAttempt(attemptId),task=attempt&&processing.getTask(attempt.taskId),dataset=attempt&&processing.getDataset(attempt.datasetId);
   if(!attempt||!task||!dataset||task.activeAttemptId!==attemptId||task.datasetId!==dataset.id||task.projectId!==dataset.projectId||attempt.status!=='pending'||dataset.status!=='finalized'||dataset.storageMode!=='managed'||dataset.rootKey!=='datasets'||!/^[a-f0-9]{64}$/.test(dataset.manifestSha256)||db.prepare("SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning'").get())fail();
   db.prepare("INSERT INTO reference_source_scan_fixture VALUES(?,?,?,?,?,?,?,'scanning')").run(scanId,attemptId,bindingId,dataset.id,dataset.projectId,dataset.manifestSha256,token);
   return {datasetId:dataset.id,projectId:dataset.projectId,manifestSha256:dataset.manifestSha256};
  });
  if(afterReserve)afterReserve();
  const acquirer=createSourceSnapshotAcquirer({database:db,environment:'staging',projectId:reserved.projectId,holderRegistry:[{holderId:'viewer-odm',environment:'staging',projectId:reserved.projectId,registryVersion:'fixture'}],managedRoot});
  const observed=acquirer.acquire({datasetId:reserved.datasetId,holderId:'viewer-odm'});
  if(afterScan)afterScan();
  observed.verifyIdentity();
  return processing.transaction(()=>{
   checkGuards();
   const claim=db.prepare("SELECT * FROM reference_source_scan_fixture WHERE id=? AND token=? AND state='scanning'").get(scanId,token),dataset=processing.getDataset(reserved.datasetId,true);
   if(!claim||!dataset||dataset.manifestSha256!==reserved.manifestSha256||observed.datasetManifestSha256!==reserved.manifestSha256||!Array.isArray(dataset.files)||dataset.files.length!==observed.files.length)fail();
   const normalize=files=>files.map(f=>({id:f.id,relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
   if(JSON.stringify(normalize(dataset.files))!==JSON.stringify(normalize(observed.files)))fail();
   const binding=prepareSourceBindingDraft(processing,{id:bindingId,attemptId});
   const prepared=outbox&&outbox.prepare(association.args,association.publicKeyDer);
   if(afterOutbox)afterOutbox();
   if(db.prepare("UPDATE reference_source_scan_fixture SET state='committed' WHERE id=? AND token=? AND state='scanning'").run(scanId,token).changes!==1)fail();
   return {...binding,observation:'unfenced_source_snapshot',scanId,...(prepared?{association:prepared}:{})};
  });
 }
 return Object.freeze({run});
}
// Explicitly opt a disposable DB into mutual exclusion with the already
// installed cooperative lifecycle/import/catalog/adoption fixture. This is
// global because physical aliases cannot be proven disjoint. It cannot fence
// writers that do not acquire these experimental claims.
function installCooperativeScanFixture(processing,scope){
 if(scope!=='isolated-source-scan-cooperation'||!processing?.database)fail();
 require('./referenceLifecycleEffectFence').createOfflineLifecycleFence(processing,'isolated-lifecycle-fence-fixture');
 const db=processing.database;if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_source_scan_fixture'").get()||db.prepare("SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning'").get())fail();
 processing.transaction(()=>db.exec(`CREATE TABLE reference_scan_cooperation_marker(id INTEGER PRIMARY KEY CHECK(id=1)); INSERT INTO reference_scan_cooperation_marker VALUES(1);
 CREATE TABLE reference_scan_managed_writers(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('in_flight','completed')));
 CREATE TRIGGER reference_scan_effects_before_scan BEFORE INSERT ON reference_source_scan_fixture WHEN EXISTS(SELECT 1 FROM viewer_source_effect_claims WHERE state='in_flight') OR EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight') OR EXISTS(SELECT 1 FROM reference_catalog_cleanup_effects WHERE state='in_flight') OR EXISTS(SELECT 1 FROM reference_adoption_effects WHERE state='in_flight') OR EXISTS(SELECT 1 FROM reference_scan_managed_writers WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'cooperative effect in flight'); END;
 CREATE TRIGGER reference_scan_blocks_source_effect BEFORE INSERT ON viewer_source_effect_claims WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning') BEGIN SELECT RAISE(ABORT,'cooperative scan in flight'); END;
 CREATE TRIGGER reference_scan_blocks_lifecycle_effect BEFORE INSERT ON reference_lifecycle_effects WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning') BEGIN SELECT RAISE(ABORT,'cooperative scan in flight'); END;
 CREATE TRIGGER reference_scan_blocks_catalog_effect BEFORE INSERT ON reference_catalog_cleanup_effects WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning') BEGIN SELECT RAISE(ABORT,'cooperative scan in flight'); END;
 CREATE TRIGGER reference_scan_blocks_adoption_effect BEFORE INSERT ON reference_adoption_effects WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning') BEGIN SELECT RAISE(ABORT,'cooperative scan in flight'); END;
 CREATE TRIGGER reference_scan_blocks_managed_writer BEFORE INSERT ON reference_scan_managed_writers WHEN EXISTS(SELECT 1 FROM reference_source_scan_fixture WHERE state='scanning') OR EXISTS(SELECT 1 FROM viewer_source_bindings) OR EXISTS(SELECT 1 FROM reference_scan_managed_writers WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'cooperative scan or binding retained'); END;
 CREATE TRIGGER reference_scan_managed_writer_no_replace BEFORE INSERT ON reference_scan_managed_writers WHEN EXISTS(SELECT 1 FROM reference_scan_managed_writers WHERE id=NEW.id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'managed writer retained'); END;
 CREATE TRIGGER reference_scan_managed_writer_no_delete BEFORE DELETE ON reference_scan_managed_writers BEGIN SELECT RAISE(ABORT,'managed writer retained'); END;
 CREATE TRIGGER reference_scan_managed_writer_update BEFORE UPDATE ON reference_scan_managed_writers WHEN NOT(OLD.state='in_flight' AND NEW.state='completed' AND NEW.id IS OLD.id AND NEW.rowid IS OLD.rowid AND NEW.kind IS OLD.kind) BEGIN SELECT RAISE(ABORT,'managed writer retained'); END;`));
}
// Fixture adapter, not installed around production writers. On throw, reject
// or process death, retain the in-flight claim; only successful completion
// permits another scan. No transaction is held while the callback runs.
function createManagedWriterFixture(processing,scope){
 if(scope!=='isolated-managed-writer-fixture'||!processing?.database)fail();
 const db=processing.database,required=['reference_scan_blocks_managed_writer','reference_scan_managed_writer_no_replace','reference_scan_managed_writer_no_delete','reference_scan_managed_writer_update','reference_scan_effects_before_scan'];
 function run(kind,callback){
  const q=db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?");if(!['upload_finalize','photo_copy','import_adopt','gcp_raw','gcp_materialize','storage_move'].includes(kind)||typeof callback!=='function'||required.some(name=>!q.get(name)))fail();
  const claim=crypto.randomUUID();processing.transaction(()=>db.prepare("INSERT INTO reference_scan_managed_writers VALUES(?,?,'in_flight')").run(claim,kind));
  const complete=value=>{if(value===false||value===null||value===undefined)fail();processing.transaction(()=>{if(db.prepare("UPDATE reference_scan_managed_writers SET state='completed' WHERE id=? AND state='in_flight'").run(claim).changes!==1)fail()});return value};
  const result=callback();return result&&typeof result.then==='function'?Promise.resolve(result).then(complete):complete(result);
 }
 const result=Object.freeze({run});managedWriterOwners.set(result,processing);return result;
}
function isManagedWriterFixture(value,processing){return Boolean(value&&managedWriterOwners.get(value)===processing)}
module.exports={createSourceScanFixture,installCooperativeScanFixture,createManagedWriterFixture,isManagedWriterFixture};
