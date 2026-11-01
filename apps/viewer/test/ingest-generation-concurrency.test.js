'use strict';
const {isMainThread,parentPort,workerData,Worker}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const {ProcessingRepository}=require('../server/processingRepository');
if(!isMainThread){
  const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=3000');
  const repo=new ProcessingRepository(db);parentPort.postMessage('ready');
  parentPort.on('message',op=>{try{if(op==='go'){parentPort.postMessage('starting');parentPort.postMessage({renewed:repo.heartbeatJob(workerData.id,'same-owner',60,workerData.generation)});}else if(op==='defer'){parentPort.postMessage({deferred:repo.failIngestDownloadJob(workerData.id,'same-owner',new Date().toISOString(),workerData.generation)});}else if(op==='close'){db.close();parentPort.close();}}catch(e){parentPort.postMessage({error:e.message});}});
}else{
  const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {applyMigrations}=require('../server/database');
  test('a waiting old worker cannot renew an expired and reclaimed same-owner lease',{timeout:10000},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-ingest-generation-')),file=path.join(root,'test.sqlite');
    const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
    t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
    const r=new ProcessingRepository(db),project=r.createProject({displayName:'Synthetic'}),dataset=r.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:'source'});
    r.finalizeDataset(dataset.id,[{id:'p',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
    const provider=r.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:9',enabled:true,authEnvKey:require('../server/providerAuth').NO_AUTH_MARKER}),task=r.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),attempt=r.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
    db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);r.transitionAttempt(attempt.id,'ingesting');r.enqueueJob(attempt.id,'ingest');
    const old=r.claimJob('same-owner');assert.ok(old);
    const worker=new Worker(__filename,{workerData:{path:file,id:old.id,generation:old.attempt_count}});t.after(async()=>{await worker.terminate();});
    const ready=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});assert.equal(await ready,'ready');
    db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE processing_jobs SET lease_expires_at=? WHERE id=?').run(new Date(Date.now()+200).toISOString(),old.id);
    const starting=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});worker.postMessage('go');assert.equal(await starting,'starting');
    let settled=false;const result=new Promise((resolve,reject)=>{worker.once('message',value=>{settled=true;resolve(value);});worker.once('error',reject);});
    await new Promise(resolve=>setTimeout(resolve,350));assert.equal(settled,false,'worker must wait for SQLite write reservation');db.exec('COMMIT');
    assert.deepEqual(await result,{renewed:false});
    const current=r.claimJob('same-owner');assert.ok(current.attempt_count>old.attempt_count);
    const deferred=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});worker.postMessage('defer');assert.deepEqual(await deferred,{deferred:false});
    r.cancelAttempt(attempt.id);assert.equal(r.heartbeatJob(current.id,'same-owner',60,current.attempt_count),false);
    const cancelled=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});worker.postMessage('defer');assert.deepEqual(await cancelled,{deferred:false});
    assert.equal(db.prepare('SELECT status FROM processing_jobs WHERE id=?').get(old.id).status,'cancelled');
    worker.postMessage('close');
  });
}
