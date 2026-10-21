'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {inputInventory}=require('../server/processingProvenance');
const {processSubmit}=require('../server/processingWorker');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'transfer-proof-')),db=openDatabase(path.join(root,'db.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'P'}),dataset=processing.createDataset({projectId:project.id,displayName:'D',rootKey:'datasets',relativePath:'data'});
  fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data','a.jpg'),'jpeg');
  const files=[{relativePath:'a.jpg',byteSize:4,sha256:sha('jpeg'),processingRole:'image'}];
  processing.finalizeDataset(dataset.id,files,sha(JSON.stringify(files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:'http://127.0.0.1:3000',enabled:true}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'T'});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id}),job=processing.claimJob('owner');
  const storage={resolve:(_key,relative)=>path.join(root,relative),requireProcessingHeadroom:()=>{}};
  return{db,processing,dataset,attempt,job,storage,root};
}
function archive(f){
  f.processing.recordAttemptProviderResult(f.job.id,'owner',{uuid:f.attempt.providerTaskId,status:'completed'});
  f.processing.setSubmissionStateForJob(f.job.id,'owner','committed',1);
  f.db.prepare("UPDATE processing_jobs SET job_type='ingest' WHERE id=?").run(f.job.id);
  const archiveFiles=[{relativePath:'odm_dem/dsm.tif',byteSize:4,sha256:sha('tiff')}];
  return{archiveSha256:sha('zip'),archiveFiles,archiveManifestSha256:sha(JSON.stringify(archiveFiles))};
}
test('inventory freezes source roles and exact ordered upload including generated GCP replacement',()=>{
  const make=(relativePath,processingRole='auto')=>({relativePath,processingRole,byteSize:4,sha256:sha(relativePath)});
  const files=[make('geo.txt','provider_input'),make('b.jpg','image'),make('notes.txt','administrative'),make('gcp_list.txt','provider_input'),make('a.jpg'),make('marks.csv','gcp_source')];
  const content='generated gcp',snapshot={content,sha256:sha(content)},value=inputInventory(files,snapshot);
  assert.deepEqual(value.inputFiles.map(file=>file.relativePath),['b.jpg','a.jpg','geo.txt','gcp_list.txt']);
  assert.equal(value.inputFiles.at(-1).byteSize,Buffer.byteLength(content));assert.equal(value.inputFiles.at(-1).sha256,snapshot.sha256);
  assert.equal(value.inputManifestSha256,sha(JSON.stringify(value.inputFiles)));
  const changed=structuredClone(files);changed[2].processingRole='provider_input';assert.notEqual(inputInventory(changed,snapshot).sourceFilesSha256,value.sourceFilesSha256);
});
test('new attempts validate immutable roles and upload order; historical attempts do not gain proof',t=>{
  const f=fixture(t),snapshot=f.processing.getAttemptProvenance(f.attempt.id).submission,files=f.processing.getDataset(f.dataset.id,true).files;
  assert.ok(snapshot.inputFiles);assert.equal(f.processing.validateAttemptInputInventory(f.job.id,'owner',files,snapshot.inputFiles),true);
  assert.equal(f.processing.validateAttemptInputInventory(f.job.id,'wrong',files,snapshot.inputFiles),false);
  assert.throws(()=>f.processing.validateAttemptInputInventory(f.job.id,'owner',files.map(file=>({...file,processingRole:'administrative'})),snapshot.inputFiles),{code:'dataset_source_changed'});
  assert.throws(()=>f.processing.validateAttemptInputInventory(f.job.id,'owner',files,[]),{code:'dataset_source_changed'});
  delete snapshot.inputFiles;f.db.prepare('UPDATE processing_attempt_provenance SET submission_json=? WHERE attempt_id=?').run(JSON.stringify(snapshot),f.attempt.id);
  assert.equal(f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true}).historical,true);
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id),null);
});
test('fresh initialization acknowledgement and completed UUID bind immutable archive receipt',t=>{
  const f=fixture(t),init=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true});assert.equal(init.ambiguous,false);
  assert.equal(f.processing.acknowledgeAttemptInitialization(f.job.id,'wrong',init.generation,f.attempt.providerTaskId),false);
  assert.equal(f.processing.acknowledgeAttemptInitialization(f.job.id,'owner',init.generation,'other'),false);
  assert.equal(f.processing.acknowledgeAttemptInitialization(f.job.id,'owner',init.generation,f.attempt.providerTaskId),true);
  const input=archive(f);assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'wrong',input),null);
  const receipt=f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input);assert.equal(receipt.providerTaskId,f.attempt.providerTaskId);
  const producer=f.processing.getVerifiedAttemptProducerReceipt(f.attempt.id);assert.equal(producer.receipt.operation,'create');assert.equal(producer.receipt.completedTaskId,f.attempt.providerTaskId);assert.equal(producer.inputFiles.length,1);
  assert.deepEqual(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),receipt);
  assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',{...input,archiveSha256:sha('different')}),null);
  assert.deepEqual(f.processing.getAttemptTransferProvenance(f.attempt.id).archive,receipt);
});
test('ack loss, repeated initialization, observed existing task, mismatched completion and cancelled lease stay unknown',t=>{
  for(const mode of ['ack-loss','repeat','existing','wrong-completion','cancelled']){
    const f=fixture(t),init=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:mode!=='existing'});
    if(mode!=='ack-loss')f.processing.acknowledgeAttemptInitialization(f.job.id,'owner',init.generation,f.attempt.providerTaskId);
    if(mode==='repeat'){const next=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true});assert.equal(next.ambiguous,true);f.processing.acknowledgeAttemptInitialization(f.job.id,'owner',next.generation,f.attempt.providerTaskId);}
    const input=archive(f);
    if(mode==='wrong-completion')f.db.prepare("UPDATE processing_attempt_provenance SET provider_result_json='{}' WHERE attempt_id=?").run(f.attempt.id);
    if(mode==='cancelled')f.db.prepare("UPDATE processing_attempts SET status='cancelled' WHERE id=?").run(f.attempt.id);
    if(mode==='cancelled')assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),null,mode);
    else assert.ok(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),mode);
    assert.equal(f.processing.getVerifiedAttemptProducerReceipt(f.attempt.id),null,mode);
  }
});
test('worker records fresh create receipt but recovery of lost acknowledgement is ambiguous',async t=>{
  for(const lost of [false,true]){
    const f=fixture(t);let exists=false;
    const adapter={status:async()=>{if(!exists)throw Object.assign(new Error('missing'),{code:'provider_task_not_found'});return{status:'queued',imagesCount:0};},
      initialize:async()=>{exists=true;if(lost)throw new Error('ack lost');return{uuid:f.attempt.providerTaskId};},upload:async()=>{},commit:async()=>{}};
    const deps={processing:f.processing,storage:f.storage,config:{},providerCredentials:{},adapterFactory:()=>adapter};
    if(lost){await assert.rejects(processSubmit(f.job,deps),/ack lost/);await processSubmit(f.job,deps);}
    else await processSubmit(f.job,deps);
    const proof=f.processing.getAttemptTransferProvenance(f.attempt.id).initialization;
    assert.equal(proof.ambiguous,lost);assert.equal(proof.state,lost?'intent':'acknowledged');
  }
});

test('historical archive receipts support integrity retry without inventing producer evidence',t=>{
  const f=fixture(t);f.db.prepare('DELETE FROM processing_attempt_provenance WHERE attempt_id=?').run(f.attempt.id);
  const input=archive(f),receipt=f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input);
  assert.ok(receipt);assert.deepEqual(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),receipt);
  assert.equal(f.processing.getVerifiedAttemptProducerReceipt(f.attempt.id),null);
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id).initialization.state,'unknown');
});

test('archive receipts reject malformed inventory, duplicate paths, unbound digest and expired lease',t=>{
  const f=fixture(t),input=archive(f);
  for(const change of [{archiveSha256:'bad'},{archiveByteSize:-1},{archiveManifestSha256:sha('wrong')},
    {archiveFiles:[...input.archiveFiles,{...input.archiveFiles[0],relativePath:'ODM_DEM/DSM.TIF'}]},
    {archiveFiles:[{...input.archiveFiles[0],relativePath:'../escape'}]}])assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',{...input,...change}),null);
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id),null);
  f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.job.id);
  assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),null);
});
