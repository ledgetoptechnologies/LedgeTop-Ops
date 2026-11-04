'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository');

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
 const processing=new ProcessingRepository(db),project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:'status-fixture'});
 processing.finalizeDataset(dataset.id,[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 return{db,processing,task,attempt};
}

test('submission phases remain queued at task level and retain active-job guards',t=>{
 const {processing,task,attempt}=fixture(t),job=processing.claimJob('status-worker');
 assert.equal(job.job_type,'submit');
 for(const phase of ['admitted','initializing','uploading','committed','queued_upstream']){
  assert.equal(processing.transitionAttemptForJob(job.id,'status-worker',phase).status,phase);
  assert.equal(processing.getTask(task.id).status,'queued',phase);
  assert.equal(processing.trashTask(task.id),null,phase);
  assert.throws(()=>processing.cancelAttempt(attempt.id),/provider termination|unresolved/,phase);
  assert.equal(processing.activeProcessingReservationBytes().length,1,phase);
 }
 processing.transitionAttemptForJob(job.id,'status-worker','running');
 assert.equal(processing.getTask(task.id).status,'processing');
});

test('unleased transition uses the same pre-start task status mapping',t=>{
 const {processing,task}=fixture(t),attempt=processing.latestAttempt(task.id);
 for(const phase of ['admitted','initializing','uploading','committed','queued_upstream']){
  processing.transitionAttempt(attempt.id,phase);
  assert.equal(processing.getTask(task.id).status,'queued',phase);
 }
 processing.transitionAttempt(attempt.id,'running');
 assert.equal(processing.getTask(task.id).status,'processing');
});
