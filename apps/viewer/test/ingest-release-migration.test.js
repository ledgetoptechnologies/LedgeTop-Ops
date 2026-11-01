'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');

test('migration 41 preserves existing pending and leased work in a populated database',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
    // Reconstruct the schema immediately before migration 41, without touching disk.
    db.exec('DROP TABLE ingest_publication_intents; DELETE FROM schema_migrations WHERE version=41');
    const repo=new ProcessingRepository(db),project=repo.createProject({displayName:'Synthetic'});
    const dataset=repo.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
    repo.finalizeDataset(dataset.id,[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
    const provider=repo.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:9',enabled:true,authEnvKey:require('../server/providerAuth').NO_AUTH_MARKER});
    for(let i=0;i<2;i++){const task=repo.createTask({projectId:project.id,datasetId:dataset.id,displayName:`Task ${i}`});repo.createAttempt({taskId:task.id,providerId:provider.id,options:{}});}
    const pending=db.prepare("SELECT id FROM processing_jobs WHERE status='pending' ORDER BY id").all();assert.equal(pending.length,2);
    const leased=repo.claimJob('synthetic-worker');assert.ok(leased);
    const before=db.prepare('SELECT * FROM processing_jobs ORDER BY id').all();
    applyMigrations(db);assert.deepEqual(db.prepare('SELECT * FROM processing_jobs ORDER BY id').all(),before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_publication_intents').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM processing_tasks').get().n,2);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{db.close();}
});

test('stale same-owner ingest cannot renew, defer, fail, or override cancellation',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
    const r=new ProcessingRepository(db),project=r.createProject({displayName:'Synthetic'}),dataset=r.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:'source'});
    r.finalizeDataset(dataset.id,[{id:'p',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
    const provider=r.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:9',enabled:true,authEnvKey:require('../server/providerAuth').NO_AUTH_MARKER}),task=r.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),attempt=r.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
    db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);r.transitionAttempt(attempt.id,'ingesting');r.enqueueJob(attempt.id,'ingest');
    const old=r.claimJob('same-owner');assert.ok(old);db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id=?").run(old.id);
    const current=r.claimJob('same-owner');assert.equal(current.id,old.id);assert.ok(current.attempt_count>old.attempt_count);
    assert.equal(r.heartbeatJob(old.id,'same-owner',60,old.attempt_count),false);
    assert.equal(r.failIngestDownloadJob(old.id,'same-owner',new Date().toISOString(),old.attempt_count),false);
    assert.equal(r.failJob(old.id,'same-owner','test','test',new Date().toISOString(),old.attempt_count),false);
    assert.equal(r.failJobTerminal(old.id,'same-owner','test','test',{eventId:'synthetic'},{ingestGeneration:old.attempt_count}),null);
    assert.equal(r.completeOutputForReview(attempt.id,{jobId:old.id,owner:'same-owner',event:{eventId:'synthetic'},ingestGeneration:old.attempt_count}),null);
    assert.equal(r.completeIngestAndEnqueueDerivatives(old.id,'same-owner',attempt.id,[{type:'ept'}],{ingestGeneration:old.attempt_count}),null);
    assert.equal(r.setAttemptResultForJob(old.id,'same-owner','model','version',old.attempt_count),null);
    const viewer=new ViewerRepository(db),fence={jobId:old.id,owner:'same-owner',generation:old.attempt_count,attemptId:attempt.id};
    assert.throws(()=>viewer.upsertModelVersion({provider:'test',providerModelId:'model',providerVersionId:'version',displayName:'Test',assets:[]},{ingestFence:fence}),{code:'lease_lost'});
    assert.throws(()=>r.registerModelOutput({versionId:'version',modelId:'model',taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:'synthetic',byteSize:1,assetCount:1,ingestFence:fence}),{code:'lease_lost'});
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM models WHERE provider='test'").get().n,0);
    const valid={...fence,generation:current.attempt_count};
    const model=viewer.upsertModelVersion({provider:'test',providerModelId:'model',providerVersionId:'version',displayName:'Test',assets:[],status:'importing',makeActive:false},{ingestFence:valid});
    const version=db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id);
    assert.ok(r.setAttemptResultForJob(current.id,'same-owner',model.id,version.id,current.attempt_count));
    assert.ok(r.registerModelOutput({versionId:version.id,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:'synthetic',byteSize:1,assetCount:0,status:'staged',ingestFence:valid}));
    assert.equal(db.prepare('SELECT status FROM processing_jobs WHERE id=?').get(old.id).status,'leased');
    r.cancelAttempt(attempt.id);assert.equal(r.failIngestDownloadJob(current.id,'same-owner',new Date().toISOString(),current.attempt_count),false);
    assert.throws(()=>viewer.upsertModelVersion({provider:'test',providerModelId:'after-cancel',providerVersionId:'version',displayName:'Test',assets:[]},{ingestFence:valid}),{code:'lease_lost'});
    assert.equal(r.setAttemptResultForJob(current.id,'same-owner',model.id,version.id,current.attempt_count),null);
    assert.equal(db.prepare('SELECT status FROM processing_jobs WHERE id=?').get(old.id).status,'cancelled');
  }finally{db.close();}
});
