'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const express=require('express');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database');
const {createProcessingApi}=require('../server/processingApi');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {processReconcile}=require('../server/processingWorker');
const {NodeOdmProvider}=require('../server/nodeOdmProvider');

// A running task shows how long the processing node has been working on it, live, never the
// time since upload. The start is kept from the first running observation of each provider task.
test('a running attempt reports live elapsed time from when the node started it',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
  const project=processing.createProject({displayName:'Engine start'});
  const data=processing.createDataset({projectId:project.id,displayName:'Synthetic photos',storageMode:'managed',rootKey:'datasets',relativePath:'fixture-photos'});
  processing.finalizeDataset(data.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
  const task=processing.createTask({projectId:project.id,datasetId:data.id,displayName:'Live task'});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:'http://127.0.0.1:3000',enabled:true});
  let info;
  const adapter=new NodeOdmProvider({endpoint:provider.endpoint,fetchImpl:async url=>Response.json(new URL(url).pathname.endsWith('/info')?info:[])});
  const start=()=>{
    const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id});
    db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
    // Upload began long ago: the runtime must not count from it.
    db.prepare("UPDATE processing_attempts SET status='queued_upstream',started_at='2025-01-01T00:00:00Z' WHERE id=?").run(attempt.id);
    processing.enqueueJob(attempt.id,'reconcile');
    return processing.getAttempt(attempt.id);
  };
  const poll=async(attempt,code,processingTime)=>{
    info={uuid:attempt.providerTaskId,status:{code},processingTime,imagesCount:1,progress:7};
    db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='reconcile' AND status='pending'").run(attempt.id);
    await processReconcile(processing.claimJob('engine-start-fixture'),{processing,config:{},adapterFactory:()=>adapter});
  };

  const token='engine-start-test-token-000000000000000000';
  processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:fixture',permissions:['viewer.processing.read'],
    displayUnits:'imperial',expiresAt:new Date(Date.now()+60_000).toISOString()});
  const app=express();app.use(createProcessingApi({repository,processing,storage:{roots:{}}}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const get=async path=>(await fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{authorization:`Bearer ${token}`}})).json();
  const metrics=async()=>[(await get('/api/v1/tasks')).tasks.find(item=>item.id===task.id).metrics,(await get(`/api/v1/tasks/${task.id}`)).task.metrics];

  // A node that does not report its own elapsed time: counted from the first running observation.
  let attempt=start();
  await poll(attempt,10,undefined);
  for(const value of await metrics())assert.equal(value.processingElapsedMs,null,'queued on the node is not running yet');
  const before=Date.now();
  await poll(attempt,20,undefined);
  for(const value of await metrics()){
    assert.equal(value.processingElapsedAttemptId,attempt.id);
    assert.ok(value.processingElapsedMs>=0&&value.processingElapsedMs<=Date.now()-before+50,`elapsed ${value.processingElapsedMs}`);
  }
  // A later observation never moves the start for the same provider task.
  const startedAt=processing.engineStartTimes([attempt.id]).get(attempt.id);
  await poll(attempt,20,undefined);
  assert.equal(processing.engineStartTimes([attempt.id]).get(attempt.id),startedAt);
  // Finished: the frozen node duration takes over and the live value is gone.
  await poll(attempt,40,90_000);
  for(const value of await metrics()){assert.equal(value.processingElapsedMs,null);assert.equal(value.processingDurationMs,90_000);}
  db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
  processing.transitionAttempt(attempt.id,'failed');

  // A node that reports its own elapsed time: the start is backdated by it.
  attempt=start();
  await poll(attempt,20,600_000);
  for(const value of await metrics()){
    assert.equal(value.processingElapsedAttemptId,attempt.id);
    assert.ok(value.processingElapsedMs>=600_000&&value.processingElapsedMs<610_000,`elapsed ${value.processingElapsedMs}`);
  }
});

// The node's own clock wins on every poll. A start first recorded without the node's elapsed time
// (or from an older Viewer) moves to the node's value, a node that restarts the task moves it
// later, and steady polls of the same run add nothing.
test('the live runtime follows the node\'s own processing time on each poll',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const processing=new ProcessingRepository(db);
  const project=processing.createProject({displayName:'Node clock'});
  const data=processing.createDataset({projectId:project.id,displayName:'Synthetic photos',storageMode:'managed',rootKey:'datasets',relativePath:'fixture-photos'});
  processing.finalizeDataset(data.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
  const task=processing.createTask({projectId:project.id,datasetId:data.id,displayName:'Long task'});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:'http://127.0.0.1:3000',enabled:true});
  let info;
  const adapter=new NodeOdmProvider({endpoint:provider.endpoint,fetchImpl:async url=>Response.json(new URL(url).pathname.endsWith('/info')?info:[])});
  let attempt=processing.createAttempt({taskId:task.id,providerId:provider.id});
  db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
  db.prepare("UPDATE processing_attempts SET status='queued_upstream' WHERE id=?").run(attempt.id);
  processing.enqueueJob(attempt.id,'reconcile');
  attempt=processing.getAttempt(attempt.id);
  const poll=async processingTime=>{
    info={uuid:attempt.providerTaskId,status:{code:20},processingTime,imagesCount:1,progress:40};
    db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='reconcile' AND status='pending'").run(attempt.id);
    await processReconcile(processing.claimJob('node-clock-fixture'),{processing,config:{},adapterFactory:()=>adapter});
  };
  const elapsed=()=>Date.now()-processing.engineStartTimes([attempt.id]).get(attempt.id);
  const events=()=>db.prepare("SELECT COUNT(*) AS n FROM processing_events WHERE attempt_id=? AND event_type='processing_attempt.engine_started'").get(attempt.id).n;

  await poll(undefined);
  assert.ok(elapsed()<5_000,'without the node\'s time the first observation is the best start');
  const hours=3*3_600_000;
  await poll(hours);
  assert.ok(elapsed()>=hours&&elapsed()<hours+5_000,`after a Viewer restart the node's ${hours} ms wins, got ${elapsed()}`);
  await poll(undefined);
  assert.ok(elapsed()>=hours,"a poll without the node's time keeps the node's start");
  const settled=events();
  await poll(hours+15_000);await poll(hours+30_000);
  assert.equal(events(),settled,'steady polls of the same run record nothing new');
  assert.ok(elapsed()>=hours&&elapsed()<hours+5_000);
  await poll(60_000);
  assert.ok(elapsed()>=60_000&&elapsed()<65_000,`a node that restarts the task counts from its new start, got ${elapsed()}`);
});
