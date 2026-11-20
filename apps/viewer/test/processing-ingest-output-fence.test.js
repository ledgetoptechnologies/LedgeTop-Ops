'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {captureIngestOutputFence,registerIngestModelOutput}=require('../server/processingIngestOutputFence');
function fixture(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());const processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
 const project=processing.createProject({displayName:'Synthetic fence'}),dataset=processing.createDataset({projectId:project.id,displayName:'Photos',rootKey:'datasets',relativePath:crypto.randomUUID()});
 processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
 const provider=processing.upsertProvider({type:'nodeodm',displayName:'Synthetic ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic task'});
 const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),submit=processing.claimJob('submit');
 processing.completeJob(submit.id,'submit');processing.transitionAttempt(attempt.id,'ingesting');processing.enqueueJob(attempt.id,'ingest');
 const job=processing.claimJob('ingest-worker');
 const input={provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:'Synthetic imported model',
  sourceLocator:{taskId:task.id,attemptId:attempt.id},status:'importing',makeActive:false,
  assets:[{kind:'glb',rootKey:'models',relativePath:`${task.id}/${attempt.id}/model.glb`,format:'glb',contentType:'model/gltf-binary',byteSize:1,sha256:'c'.repeat(64),published:false}]};
 const run=beforeCommit=>repository.upsertModelVersion(input);
 const counts=()=>['models','model_versions','model_assets'].map(name=>db.prepare(`SELECT count(*) n FROM ${name}`).get().n);
 return{db,processing,repository,task,attempt,job,input,run,counts};
}
function registration(f,{duringScan=()=>{},fence=captureIngestOutputFence(f.job)}={}){
 const model=f.run(),version=f.db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id);
 assert.equal(f.processing.setAttemptResultForJob(f.job.id,f.job.lease_owner,model.id,version.id)?.id,f.attempt.id);
 const output={versionId:version.id,modelId:model.id,taskId:f.task.id,attemptId:f.attempt.id,
  projectId:f.processing.getTask(f.task.id).projectId,relativePath:'synthetic/output',status:'staged',assetCount:1};
 return()=>registerIngestModelOutput({processing:f.processing,storage:{scanAbsolute(){duringScan();return{byteSize:7};}},
  destination:'synthetic-only-no-filesystem-access',output,fence});
}
test('output registration uses original claim with accounting from the completed scan',t=>{
 const f=fixture(t),run=registration(f),result=run();
 assert.equal(result.status,'staged');assert.equal(result.byteSize,7);assert.equal(result.assetCount,1);
 assert.deepEqual(f.counts(),[1,1,1]);
});
test('lease expiry, owner replacement and reclaimed generation during scan cannot register output',t=>{
 for(const kind of ['expiry','owner','generation']){
  const f=fixture(t),run=registration(f,{duringScan(){
   if(kind==='expiry')f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.job.id);
   else if(kind==='owner')f.db.prepare("UPDATE processing_jobs SET lease_owner='replacement' WHERE id=?").run(f.job.id);
   else f.db.prepare('UPDATE processing_jobs SET attempt_count=attempt_count+1 WHERE id=?').run(f.job.id);
  }});
  assert.throws(run,{code:'lease_lost'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM model_outputs').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM model_output_storage_components').get().n,0);
  assert.deepEqual(f.counts(),[1,1,1],'retain already imported assets for review/recovery');
 }
});
test('captured registration generation cannot follow mutations of the caller job object',t=>{
 const f=fixture(t),fence=captureIngestOutputFence(f.job);
 assert.ok(Object.isFrozen(fence));
 const run=registration(f,{fence,duringScan(){
  f.db.prepare('UPDATE processing_jobs SET attempt_count=attempt_count+1 WHERE id=?').run(f.job.id);f.job.attempt_count++;
 }});
 assert.throws(run,{code:'lease_lost'});assert.equal(f.db.prepare('SELECT COUNT(*) n FROM model_outputs').get().n,0);
});
test('invalid registration claim cannot fall back to unfenced legacy registration',()=>{
 for(const job of [null,{}, {id:'j',lease_owner:'w',attempt_count:'1'}, {id:'j',lease_owner:'w',attempt_count:0}])
  assert.throws(()=>captureIngestOutputFence(job),{code:'invalid_ingest_output_claim'});
 assert.throws(()=>registerIngestModelOutput({processing:{registerModelOutput(){assert.fail();}},
  storage:{scanAbsolute(){assert.fail();}},fence:{jobId:'j'}}),{code:'invalid_ingest_output_claim'});
});
