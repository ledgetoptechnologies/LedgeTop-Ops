'use strict';
// Offline fixture only: the intent is not a filesystem lock, source-side pin,
// writer fence, quota reservation or authority. No runtime route uses this.
const crypto=require('node:crypto');
const {createSourceSnapshotAcquirer}=require('./sourceSnapshotAcquisition');
const {prepareSourceBindingDraft}=require('./referenceSourceBindingDraft');
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
 function run({scanId,bindingId,attemptId,managedRoot,afterReserve,afterScan}={}){
  if(!id(scanId)||!id(bindingId)||!id(attemptId)||typeof managedRoot!=='string'||(afterReserve!==undefined&&typeof afterReserve!=='function')||(afterScan!==undefined&&typeof afterScan!=='function'))fail();
  const token=crypto.randomBytes(32).toString('hex');
  const reserved=processing.transaction(()=>{
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
  return processing.transaction(()=>{
   const claim=db.prepare("SELECT * FROM reference_source_scan_fixture WHERE id=? AND token=? AND state='scanning'").get(scanId,token),dataset=processing.getDataset(reserved.datasetId,true);
   if(!claim||!dataset||dataset.manifestSha256!==reserved.manifestSha256||observed.datasetManifestSha256!==reserved.manifestSha256||!Array.isArray(dataset.files)||dataset.files.length!==observed.files.length)fail();
   const normalize=files=>files.map(f=>({id:f.id,relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
   if(JSON.stringify(normalize(dataset.files))!==JSON.stringify(normalize(observed.files)))fail();
   const binding=prepareSourceBindingDraft(processing,{id:bindingId,attemptId});
   if(db.prepare("UPDATE reference_source_scan_fixture SET state='committed' WHERE id=? AND token=? AND state='scanning'").run(scanId,token).changes!==1)fail();
   return {...binding,observation:'unfenced_source_snapshot',scanId};
  });
 }
 return Object.freeze({run});
}
module.exports={createSourceScanFixture};
